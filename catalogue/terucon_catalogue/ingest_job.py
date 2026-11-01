"""The testable body of the Modal ingest job: plain Python, no Modal import, every dependency injected.

`run_ingest_job(job_id, ...)` does, for the job document `terucon_catalogue_jobs/<jobId>` (ARCHITECTURE.md 4.4):

    fetch    download uploads/<jobId>/... from the object store, VERIFY each file (a PDF has a %PDF- header and is under the size cap, a photo
             opens with Pillow; every failure names the file), copy the originals to sources/<sha256>/<name>, wrap photos as one-page PDFs
    resume   if bundles/<catalogue>/<jobId>/state.sqlite exists (an earlier attempt of this job), restore it and call prepare_resume
    compute  the injected `compute` (pipeline.run_compute) with a progress callback that updates the job (throttled), a heartbeat thread that
             writes heartbeatAt at least every 10 s and watches cancelRequested, and a state checkpoint uploaded to bundles/... after each stage
    publish  the injected `publish` (publish.publish_bundle), with `activate` from the job's options
    finish   status succeeded / stage done / result, and the uploads/ objects are deleted

ANY exception ends with status "failed", a short scrubbed `error`, the traceback (truncated, scrubbed) in the job log and the checkpoint kept; a
cancel request ends with "cancelled". The job is never left "running" by this function (if the database itself is down the final write fails and the
heartbeat goes stale, which the website reads as dead after 10 minutes).

Also here: `IngestRunner`, the object behind the ingest web app (`http_app.create_ingest_app`): start (validate the job, spawn the GPU function,
remember the call id) and cancel (set cancelRequested).

Injected (all duck-typed): db (get_job / update_job / append_job_log of MongoCatalogueDb or MemoryCatalogueDb), store (the ObjectStore protocol),
cfg, compute, publish, manager_factory() -> VertexGenAIManager, encoders_factory() -> EncoderBank, wrap_photo (photos.wrap_photo_as_pdf),
prepare_resume (pipeline.prepare_resume), cancelled_exc (pipeline.Cancelled). The last three default to the compute side's own, imported lazily.
"""
from __future__ import annotations

import logging
import os
import re
import threading
import time
import traceback
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

from . import __version__
from .release_reader import ServiceError, is_job_id
from .util import sha256_file

LOGGER = logging.getLogger("catalogue.ingest")

COMPUTE_STAGES = ("extract", "features", "vertex_mm", "captions", "text_vectors")
JOB_STAGES = ("waiting", "fetch") + COMPUTE_STAGES + ("publish", "release", "done")
VERTEX_STAGES = ("vertex_mm", "captions", "text_vectors")
MAX_PDF_BYTES = 300 * 1024 * 1024            # ARCHITECTURE.md section 7
MAX_IMAGE_BYTES = 25 * 1024 * 1024
MAX_PHOTOS = 200
MAX_PDFS = 20
MAX_IMAGE_PIXELS = 80_000_000
IMAGE_FORMATS = ("JPEG", "PNG", "WEBP", "MPO", "BMP", "TIFF")
DEAD_HEARTBEAT_MS = 10 * 60 * 1000
STARTABLE = ("queued", "failed", "running")  # "running" only when its heartbeat is stale


def default_now() -> int:
    return int(time.time() * 1000)


# ------------------------------------------------------------------------------------------------------------------------
# errors
# ------------------------------------------------------------------------------------------------------------------------
class IngestError(ServiceError):
    status = 400
    reason = "ingest-error"


class JobNotFoundError(IngestError):
    status = 404
    reason = "job-not-found"


class JobNotStartableError(IngestError):
    status = 409
    reason = "job-not-startable"


class UploadRejected(Exception):
    """A user's file is not acceptable. The message names the file and is shown to the admin as the job's error."""


# ------------------------------------------------------------------------------------------------------------------------
# small helpers
# ------------------------------------------------------------------------------------------------------------------------
_SAFE_CHARS = re.compile(r"[^A-Za-z0-9._ -]+")
_SECRETS = [
    (re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----.*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)", re.S), "[private key removed]"),
    (re.compile(r"([a-zA-Z][a-zA-Z0-9+.-]*://)[^\s/@:]+:[^\s/@]+@"), r"\1[credentials removed]@"),
    (re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._~+/=-]{8,}"), "Bearer [removed]"),
    (re.compile(r"\bAIza[0-9A-Za-z_-]{30,}"), "[api key removed]"),
    (re.compile(r"\bya29\.[0-9A-Za-z_-]{20,}"), "[access token removed]"),
    (re.compile(r"(?i)((?:api[_-]?key|secret|token|password|passwd|private_key)[\"']?\s*[=:]\s*[\"']?)[^\s\"',}]{4,}"), r"\1[removed]"),
]


def scrub(text: Any) -> str:
    """Remove anything that looks like a credential before text goes to the job document or a log."""
    out = str(text)
    for pattern, replacement in _SECRETS:
        out = pattern.sub(replacement, out)
    return out


def safe_name(name: Any, fallback: str = "file") -> str:
    base = os.path.basename(str(name or "").replace("\\", "/"))
    base = _SAFE_CHARS.sub("_", base).strip(" .")
    base = re.sub(r"_{2,}", "_", base)[:120].strip(" .")
    return base or fallback


def short_error(exc: BaseException, limit: int = 300) -> str:
    if isinstance(exc, UploadRejected):
        return scrub(str(exc))[:limit]
    text = scrub(f"{type(exc).__name__}: {exc}").replace("\n", " ")
    return text[:limit]


def check_startable(job: Optional[dict], now: int) -> None:
    """Raises JobNotFoundError / JobNotStartableError unless the job document says a run may begin."""
    if not job:
        raise JobNotFoundError("There is no such job.")
    status = job.get("status")
    if status not in STARTABLE:
        raise JobNotStartableError(f"The job is {status!r}; only a queued or failed job can be started.")
    if status == "running":
        beat = job.get("heartbeatAt")
        if isinstance(beat, (int, float)) and now - beat < DEAD_HEARTBEAT_MS:
            raise JobNotStartableError("The job is already running.")


# ------------------------------------------------------------------------------------------------------------------------
# the ingest web app's runner
# ------------------------------------------------------------------------------------------------------------------------
class IngestRunner:
    """start(job_id) -> call id; cancel(job_id). `spawn(job_id) -> call id` is Modal's `ingest_job_fn.spawn(...).object_id` (injected)."""

    def __init__(self, db, spawn: Callable[[str], str], *, now: Callable[[], int] = default_now, version: str = __version__):
        self.db, self.spawn, self.now, self.version = db, spawn, now, version

    def start(self, job_id: str) -> str:
        if not is_job_id(job_id):
            raise IngestError("jobId is not a valid job id.", status=400, reason="bad-request")
        check_startable(self.db.get_job(job_id), self.now())
        call_id = str(self.spawn(job_id))
        self.db.update_job(job_id, {"modalCallId": call_id})
        LOGGER.info("ingest job %s spawned (call %s)", job_id, call_id)
        return call_id

    def cancel(self, job_id: str) -> None:
        if not is_job_id(job_id):
            raise IngestError("jobId is not a valid job id.", status=400, reason="bad-request")
        job = self.db.get_job(job_id)
        if not job:
            raise JobNotFoundError("There is no such job.")
        if job.get("status") in ("succeeded", "failed", "cancelled"):
            raise JobNotStartableError(f"The job is already {job.get('status')}.", reason="job-finished")
        self.db.update_job(job_id, {"cancelRequested": True})
        LOGGER.info("ingest job %s: cancel requested", job_id)


# ------------------------------------------------------------------------------------------------------------------------
# verification of uploads
# ------------------------------------------------------------------------------------------------------------------------
def check_pdf(path: Path, name: str, max_bytes: int = MAX_PDF_BYTES) -> None:
    size = path.stat().st_size
    if size == 0:
        raise UploadRejected(f"{name}: the file is empty.")
    if size > max_bytes:
        raise UploadRejected(f"{name}: {size} bytes is more than the {max_bytes} byte limit for a PDF.")
    with open(path, "rb") as handle:
        head = handle.read(1024)
    if b"%PDF-" not in head:
        raise UploadRejected(f"{name}: this is not a PDF (no %PDF- header).")


def check_image(path: Path, name: str, max_bytes: int = MAX_IMAGE_BYTES) -> None:
    from PIL import Image
    size = path.stat().st_size
    if size == 0:
        raise UploadRejected(f"{name}: the file is empty.")
    if size > max_bytes:
        raise UploadRejected(f"{name}: {size} bytes is more than the {max_bytes} byte limit for a photo.")
    try:
        with Image.open(path, formats=list(IMAGE_FORMATS)) as image:
            width, height = image.size
            image.verify()
    except Exception as exc:
        raise UploadRejected(f"{name}: this is not a readable image ({type(exc).__name__}).") from None
    if width * height > MAX_IMAGE_PIXELS:
        raise UploadRejected(f"{name}: {width}x{height} pixels is too large.")
    if min(width, height) < 16:
        raise UploadRejected(f"{name}: {width}x{height} pixels is too small.")


def _unique_path(directory: Path, name: str) -> Path:
    candidate = directory / name
    stem, suffix, counter = Path(name).stem, Path(name).suffix, 1
    while candidate.exists():
        counter += 1
        candidate = directory / f"{stem}-{counter}{suffix}"
    return candidate


# ------------------------------------------------------------------------------------------------------------------------
# one run of one job
# ------------------------------------------------------------------------------------------------------------------------
class _Run:
    def __init__(self, job_id, db, store, workdir, now, heartbeat_s, progress_interval_s, cancel_poll_s):
        self.job_id, self.db, self.store, self.workdir, self.now = job_id, db, store, Path(workdir), now
        self.heartbeat_s, self.progress_interval_s, self.cancel_poll_s = heartbeat_s, progress_interval_s, cancel_poll_s
        self.catalogue: Optional[str] = None
        self.lock = threading.RLock()
        self.cancel_event = threading.Event()
        self.stop_event = threading.Event()
        self.thread: Optional[threading.Thread] = None
        self.stage = "fetch"
        self.last_progress_at = 0.0
        self.last_cancel_poll = 0.0
        self.last_compute_stage: Optional[str] = None
        self.compute_started = False

    @property
    def checkpoint_key(self) -> str:
        return f"bundles/{self.catalogue}/{self.job_id}/state.sqlite"

    # ---- database writes never raise: a database blip must not kill a long compute
    def update(self, **fields) -> bool:
        with self.lock:
            try:
                self.db.update_job(self.job_id, fields)
                return True
            except Exception as exc:
                LOGGER.warning("job %s: could not update the job document (%s)", self.job_id, type(exc).__name__)
                return False

    def log(self, level: str, message: str) -> None:
        with self.lock:
            try:
                self.db.append_job_log(self.job_id, level, scrub(message)[:2000])
            except Exception as exc:
                LOGGER.warning("job %s: could not write a log line (%s)", self.job_id, type(exc).__name__)

    # ---- cancellation and heartbeat
    def poll_cancel(self, force: bool = False) -> bool:
        if self.cancel_event.is_set():
            return True
        clock = time.monotonic()
        if force or clock - self.last_cancel_poll >= self.cancel_poll_s:
            self.last_cancel_poll = clock
            with self.lock:
                try:
                    job = self.db.get_job(self.job_id)
                except Exception:
                    job = None
            if job and job.get("cancelRequested"):
                self.cancel_event.set()
        return self.cancel_event.is_set()

    def start_heartbeat(self) -> None:
        def beat():
            while not self.stop_event.wait(self.heartbeat_s):
                self.update(heartbeatAt=self.now())
                self.poll_cancel(force=True)

        self.thread = threading.Thread(target=beat, name=f"heartbeat-{self.job_id}", daemon=True)
        self.thread.start()

    def stop_heartbeat(self) -> None:
        self.stop_event.set()
        if self.thread is not None:
            self.thread.join(timeout=5)

    # ---- progress
    def on_progress(self, stage: str, done: int, total: int, message: str) -> None:
        """progress(stage, done, total, message) for run_compute and publish_bundle. Throttled; never raises."""
        try:
            changed = stage in JOB_STAGES and stage != self.stage
            if stage in COMPUTE_STAGES and self.last_compute_stage is not None and stage != self.last_compute_stage:
                self.checkpoint(f"after the {self.last_compute_stage} stage")
            if stage in COMPUTE_STAGES:
                self.last_compute_stage = stage
            clock = time.monotonic()
            if not (changed or done >= total or clock - self.last_progress_at >= self.progress_interval_s):
                return
            self.last_progress_at = clock
            fields: Dict[str, Any] = {"progress": {"done": int(done), "total": int(total), "message": scrub(message)[:300]},
                                      "heartbeatAt": self.now()}
            if stage in JOB_STAGES:
                self.stage = stage
                fields["stage"] = stage
            self.update(**fields)
        except Exception as exc:                                    # pragma: no cover - belt and braces
            LOGGER.warning("job %s: progress callback failed (%s)", self.job_id, type(exc).__name__)

    def set_stage(self, stage: str, message: str, done: int = 0, total: int = 0) -> None:
        self.stage = stage
        self.update(stage=stage, progress={"done": done, "total": total, "message": message}, heartbeatAt=self.now())

    # ---- checkpoint: a consistent copy of state.sqlite in the object store, so a failed job can resume
    def checkpoint(self, why: str) -> bool:
        state = self.workdir / "state.sqlite"
        if self.catalogue is None or not state.is_file():
            return False
        try:
            from .state import StateStore
            store = StateStore(state)
            try:
                snapshot = store.snapshot_to(self.workdir / "_checkpoint" / "state.sqlite")
            finally:
                store.close()
            self.store.put_file(self.checkpoint_key, snapshot, "application/vnd.sqlite3")
            self.log("info", f"checkpoint saved ({why})")
            return True
        except Exception as exc:
            LOGGER.warning("job %s: checkpoint failed (%s: %s)", self.job_id, type(exc).__name__, scrub(exc)[:200])
            self.log("warn", f"checkpoint failed ({type(exc).__name__}); the job carries on")
            return False


def _stages_for(options: dict) -> Tuple[str, ...]:
    captions = options.get("captions", True)
    return ("extract", "features", "vertex_mm") + (("captions", "text_vectors") if captions else ())


def _fetch(run: _Run, job: dict, limits: dict) -> List[dict]:
    """Download, verify and keep the originals. Returns [{name, path, sha256, key, bytes}] in the job's order."""
    sources = job.get("sources")
    if not isinstance(sources, list) or not sources:
        raise UploadRejected("The job lists no files.")
    kind = job.get("kind")
    if kind not in ("pdf", "photos"):
        raise UploadRejected(f"The job kind is {kind!r}; expected 'pdf' or 'photos'.")
    cap = limits["max_photos"] if kind == "photos" else limits["max_pdfs"]
    if len(sources) > cap:
        raise UploadRejected(f"The job has {len(sources)} files; at most {cap} are allowed.")
    inputs_dir = run.workdir / "inputs"
    inputs_dir.mkdir(parents=True, exist_ok=True)
    fetched: List[dict] = []
    for index, source in enumerate(sources):
        if not isinstance(source, dict) or not isinstance(source.get("key"), str):
            raise UploadRejected(f"File {index + 1}: the job document has no storage key for it.")
        name = safe_name(source.get("name"), f"file-{index + 1}")
        key = source["key"]
        if not key.startswith(f"uploads/{run.job_id}/"):
            raise UploadRejected(f"{name}: its storage key is not under this job's uploads.")
        limit = limits["max_image_bytes"] if kind == "photos" else limits["max_pdf_bytes"]
        size = run.store.size(key)
        if size is None:
            raise UploadRejected(f"{name}: the upload is missing from storage (was the upload completed?).")
        if size > limit:
            raise UploadRejected(f"{name}: {size} bytes is more than the {limit} byte limit.")
        destination = _unique_path(inputs_dir, name)
        run.store.get_file(key, destination)
        (check_image if kind == "photos" else check_pdf)(destination, name, limit)
        digest = sha256_file(destination)
        if isinstance(source.get("sha256"), str) and source["sha256"] and source["sha256"].lower() != digest:
            raise UploadRejected(f"{name}: the uploaded file does not match its recorded sha256.")
        fetched.append({"name": name, "path": destination, "sha256": digest, "key": key, "bytes": destination.stat().st_size})
        run.set_stage("fetch", f"downloaded {name}", index + 1, len(sources))
    for item in fetched:                                           # originals are kept: the lineage check re-renders from them
        run.store.put_file(f"sources/{item['sha256']}/{item['name']}", item["path"], None, if_absent=True)
    run.update(sources=[dict(source, sha256=item["sha256"], bytes=item["bytes"]) for source, item in zip(sources, fetched)])
    return fetched


def _wrap_photos(run: _Run, fetched: List[dict], wrap_photo: Callable) -> List[Path]:
    wrapped_dir = run.workdir / "wrapped"
    wrapped_dir.mkdir(parents=True, exist_ok=True)
    pdfs: List[Path] = []
    for item in fetched:
        out = _unique_path(wrapped_dir, Path(item["name"]).stem + ".pdf")
        try:
            wrap_photo(item["path"], out)
        except ValueError as exc:
            raise UploadRejected(f"{item['name']}: {exc}") from None
        except Exception as exc:
            raise UploadRejected(f"{item['name']}: could not be turned into a page ({type(exc).__name__}).") from None
        pdfs.append(Path(out))
    return pdfs


def _restore_checkpoint(run: _Run, prepare_resume: Optional[Callable]) -> bool:
    key = run.checkpoint_key
    if not run.store.exists(key):
        return False
    if prepare_resume is None:
        run.log("warn", "an earlier attempt left a checkpoint but resuming is not available; starting from scratch")
        return False
    run.store.get_file(key, run.workdir / "state.sqlite")
    report = prepare_resume(run.workdir)
    run.log("info", f"resuming from the checkpoint of an earlier attempt ({report})")
    return True


def _lazy(name: str, injected: Optional[Callable], module: str) -> Optional[Callable]:
    if injected is not None:
        return injected
    try:
        import importlib
        return getattr(importlib.import_module(module, package=__package__), name)
    except Exception:
        return None


def _failed_pages(result: Any) -> List[dict]:
    pages = []
    for entry in list(getattr(result, "failed_pages", None) or [])[:50]:
        if isinstance(entry, dict):
            pages.append({"page": entry.get("page"), "error": scrub(entry.get("error", ""))[:300]})
    return pages


def run_ingest_job(job_id: str, *, db, store, cfg, compute: Callable, publish: Callable, manager_factory: Optional[Callable] = None,
                   encoders_factory: Optional[Callable] = None, workdir, now: Callable[[], int] = default_now,
                   wrap_photo: Optional[Callable] = None, prepare_resume: Optional[Callable] = None, cancelled_exc: Any = None,
                   heartbeat_s: float = 5.0, progress_interval_s: float = 1.0, cancel_poll_s: float = 2.0,
                   max_pdf_bytes: int = MAX_PDF_BYTES, max_image_bytes: int = MAX_IMAGE_BYTES, max_photos: int = MAX_PHOTOS,
                   max_pdfs: int = MAX_PDFS) -> dict:
    """Run one ingest job to the end. Returns {"ok", "status", "jobId", "releaseId"|None, "error"|None}. Raises only if the job cannot even
    be read (JobNotFoundError / JobNotStartableError): then there is nothing to mark failed."""
    job = db.get_job(job_id)
    check_startable(job, now())
    catalogue = job.get("catalogue")
    options = job.get("options") or {}
    run = _Run(job_id, db, store, workdir, now, heartbeat_s, progress_interval_s, cancel_poll_s)
    run.catalogue = catalogue
    Path(workdir).mkdir(parents=True, exist_ok=True)
    limits = {"max_pdf_bytes": max_pdf_bytes, "max_image_bytes": max_image_bytes, "max_photos": max_photos, "max_pdfs": max_pdfs}
    cancelled_types = _cancelled_types(cancelled_exc)
    manager = encoders = None
    outcome: Dict[str, Any] = {"ok": False, "status": "failed", "jobId": job_id, "releaseId": None, "error": None}
    try:
        started = job.get("startedAt") or now()
        run.update(status="running", stage="fetch", startedAt=started, heartbeatAt=now(), error=None, finishedAt=None,
                   cancelRequested=bool(job.get("cancelRequested")),
                   progress={"done": 0, "total": 0, "message": "starting"})
        run.log("info", f"job started (kind {job.get('kind')}, catalogue {catalogue})")
        run.start_heartbeat()
        if run.poll_cancel(force=True):
            raise _Cancel("cancelled before it started")

        fetched = _fetch(run, job, limits)
        pdfs = [item["path"] for item in fetched]
        segment: List[Path] = []
        if job["kind"] == "photos":
            wrap = _lazy("wrap_photo_as_pdf", wrap_photo, ".photos")
            if wrap is None:
                raise RuntimeError("photos.wrap_photo_as_pdf is not available")
            pdfs = _wrap_photos(run, fetched, wrap)
            if options.get("segmentPhotos"):
                segment = list(pdfs)
        if run.poll_cancel(force=True):
            raise _Cancel("cancelled after the uploads were verified")

        _restore_checkpoint(run, prepare_resume if prepare_resume is not None else _lazy("prepare_resume", None, ".pipeline"))
        stages = _stages_for(options)
        if "features" in stages and encoders_factory is not None:
            encoders = encoders_factory()
        if any(stage in stages for stage in VERTEX_STAGES) and manager_factory is not None:
            manager = manager_factory()
        run.compute_started = True
        result = compute(cfg, pdfs=pdfs, work_dir=Path(workdir), encoders=encoders, manager=manager, progress=run.on_progress,
                         should_cancel=run.poll_cancel, stages=stages, segment_photos=segment)
        run.checkpoint("compute finished")
        if run.poll_cancel(force=True):
            raise _Cancel("cancelled after the compute finished")

        run.set_stage("publish", "publishing", 0, 0)
        published = publish(Path(workdir), catalogue=catalogue, store=store, db=db, cfg=cfg, job_id=job_id,
                            source_files={path.name: path for path in pdfs}, activate=bool(options.get("activate", False)),
                            dry_run=False, progress=run.on_progress, created_by="ingest")
        warnings = [scrub(w)[:300] for w in list(getattr(result, "warnings", None) or []) + list(getattr(published, "warnings", None) or [])][:50]
        summary = {"items": int(getattr(published, "n_items", getattr(result, "n_items", 0)) or 0),
                   "pages": int(getattr(result, "n_pages", 0) or 0), "failedPages": _failed_pages(result),
                   "unmatchedIds": int(getattr(result, "unmatched", 0) or 0), "newItems": int(getattr(published, "n_new", 0) or 0),
                   "releaseId": getattr(published, "release_id", None), "warnings": warnings}
        run.stop_heartbeat()
        run.update(status="succeeded", stage="done", error=None, finishedAt=now(), heartbeatAt=now(), result=summary,
                   progress={"done": summary["items"], "total": summary["items"], "message": "done"})
        run.log("info", f"job succeeded: release {summary['releaseId']}, {summary['items']} items")
        _delete_uploads(run, job)
        outcome.update(ok=True, status="succeeded", releaseId=summary["releaseId"])
    except BaseException as exc:
        run.stop_heartbeat()
        if isinstance(exc, _Cancel) or isinstance(exc, cancelled_types) or (run.cancel_event.is_set() and not isinstance(exc, UploadRejected)):
            run.log("warn", f"job cancelled: {exc}")
            if run.compute_started:
                run.checkpoint("after the cancel")
            run.update(status="cancelled", error=None, finishedAt=now(), heartbeatAt=now())
            outcome.update(status="cancelled")
        else:
            message = short_error(exc)
            run.log("error", message)
            if not isinstance(exc, UploadRejected):
                run.log("error", "traceback (truncated): " + scrub(traceback.format_exc())[-1500:])
            if run.compute_started:
                run.checkpoint("after the failure")
            run.update(status="failed", error=message, finishedAt=now(), heartbeatAt=now())
            outcome.update(status="failed", error=message)
            LOGGER.error("ingest job %s failed: %s", job_id, message)
        if not isinstance(exc, Exception) and not isinstance(exc, _Cancel):
            raise                                                   # KeyboardInterrupt / SystemExit: the job is marked, now let it propagate
    finally:
        run.stop_heartbeat()
        for resource in (manager,):
            close = getattr(resource, "close", None)
            if callable(close):
                try:
                    close()
                except Exception:
                    pass
        del encoders
    return outcome


class _Cancel(Exception):
    pass


def _cancelled_types(injected: Any) -> tuple:
    if injected is None:
        injected = _lazy("Cancelled", None, ".pipeline")
    if injected is None:
        return ()
    return tuple(injected) if isinstance(injected, (tuple, list)) else (injected,)


def _delete_uploads(run: _Run, job: dict) -> None:
    keys = {source.get("key") for source in job.get("sources") or [] if isinstance(source, dict) and isinstance(source.get("key"), str)}
    try:
        keys.update(run.store.list(f"uploads/{run.job_id}/"))
    except Exception as exc:
        LOGGER.warning("job %s: could not list the uploads (%s)", run.job_id, type(exc).__name__)
    for key in sorted(keys):
        if key.startswith(f"uploads/{run.job_id}/"):
            try:
                run.store.delete(key)
            except Exception as exc:
                LOGGER.warning("job %s: could not delete %s (%s)", run.job_id, key, type(exc).__name__)
