"""Bring a finished bundle that already sits in the Google Cloud bucket into the catalogue, and put the resulting release on the Modal volume.

This is the "I host the files in the bucket myself" path (the owner uploads the notebook's output folder, from Kaggle or from a laptop, to the bucket
with `gcloud storage cp -r`; nothing here fetches anything from Kaggle). It runs INSIDE Modal, next to the bucket, so nothing is downloaded to a laptop:

    imports/<catalogue>/<name>/state.sqlite (+ state.sqlite-wal / -shm)      the notebook's work_dir, uploaded as it is
    imports/<catalogue>/<name>/crops/<anything>/<file>.png                   (a folder name may contain spaces: the notebook names it after the PDF)
        |
        |  fetch_bundle()      only state.sqlite and pictures are taken; other files in the folder are counted and left alone
        v
    a temporary folder  --publish_bundle()-->  GCS (crops, thumbs, release) + MongoDB (items, release)       [publish.py, unchanged]
        |
        |  seed_release_cache()   load_release() reads the release through the volume's cache, so the files are on the volume afterwards
        v
    /cache/<catalogue>/<release>/   (Modal volume)   the search container finds the release there and downloads nothing from GCS

The volume is only ever a cache: GCS stays the durable copy and a search container still falls back to GCS if the volume lacks a release. What sits
where, and why the pictures are NOT on the volume: ARCHITECTURE.md section 3. Everything here is tested against fakes (a local folder as the bucket, an
in-memory database); it has never run on a live Modal, bucket or MongoDB.
"""
from __future__ import annotations

import concurrent.futures
import datetime as _dt
import logging
import os
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, List, Mapping, Optional, Sequence, Tuple

from .bundle import IMAGE_SUFFIXES, sha256_of_file
from .config import compute_feature_versions
from .mongo import CatalogueDbError, check_catalogue_id
from .objectstore import InvalidKeyError, validate_key

LOGGER = logging.getLogger("catalogue.bucket_import")

IMPORT_ROOT = "imports/"
STATE_FILES = ("state.sqlite", "state.sqlite-wal", "state.sqlite-shm")
MAX_FILES = 50_000                  # pictures + database files taken from one folder; more than this is almost certainly the wrong folder
MAX_BYTES = 40 * 1024 ** 3
WORKERS = 8

Progress = Callable[[str, int, int, str], None]


class BucketImportError(RuntimeError):
    """The folder in the bucket cannot be imported (wrong path, nothing there, no database, too much). The message is a plain sentence for the operator."""


@dataclass
class FetchResult:
    folder: Path
    prefix: str
    files: int = 0
    bytes: int = 0
    images: int = 0
    pdfs: List[Path] = field(default_factory=list)
    has_wal: bool = False
    skipped: int = 0

    def as_dict(self) -> Dict[str, Any]:
        return {"prefix": self.prefix, "files": self.files, "bytes": self.bytes, "images": self.images, "pdfs": len(self.pdfs), "hasWal": self.has_wal,
                "skipped": self.skipped}


@dataclass
class SeedResult:
    catalogue: str
    release_id: str
    n_items: int
    source: str          # "download": copied onto the volume just now | "cache": it was already there
    path: Optional[str] = None

    def as_dict(self) -> Dict[str, Any]:
        return {"catalogue": self.catalogue, "releaseId": self.release_id, "items": self.n_items, "source": self.source}


def check_import_prefix(prefix: Any) -> str:
    """The folder to import, as a key prefix that ends in '/': it must be inside imports/ (never releases/, crops/ ...) and must name something below it."""
    if not isinstance(prefix, str) or not prefix.strip():
        raise BucketImportError("Give the folder inside the bucket, for example imports/superbond-colour/run1")
    text = prefix.strip()
    if text.startswith(("gs://", "http://", "https://")):
        raise BucketImportError(f"{text!r} is a full address. Give only the folder inside the bucket, after the catalogue prefix (CATALOGUE_GCS_PREFIX, "
                                "default catalogue/): for gs://my-bucket/catalogue/imports/superbond-colour/run1 that is imports/superbond-colour/run1")
    text = text.rstrip("/")
    try:
        validate_key(text)
    except InvalidKeyError as error:
        raise BucketImportError(f"{text!r} is not a usable folder name: {error}") from None
    if not text.startswith(IMPORT_ROOT) or text == IMPORT_ROOT.rstrip("/"):
        raise BucketImportError(f"{text!r} must be a folder inside {IMPORT_ROOT} (for example imports/superbond-colour/run1), so that a typo can never pull in "
                                "releases/ or crops/.")
    return text + "/"           # the trailing slash matters: imports/run1/ must not also match imports/run10/


def _wanted(relative: str, include_pdfs: bool) -> Optional[str]:
    """'state' | 'image' | 'pdf' for a file this import takes, None for anything else."""
    name = relative.rsplit("/", 1)[-1]
    if name in STATE_FILES:
        return "state"
    suffix = os.path.splitext(name.lower())[1]
    if suffix in IMAGE_SUFFIXES:
        return "image"
    if include_pdfs and suffix == ".pdf":
        return "pdf"
    return None


def fetch_bundle(store: Any, prefix: str, dest: Any, *, include_pdfs: bool = False, workers: int = WORKERS, max_files: int = MAX_FILES,
                 max_bytes: int = MAX_BYTES, progress: Optional[Progress] = None) -> FetchResult:
    """Copy state.sqlite and the pictures under `prefix` into `dest`, keeping their folder layout, so that bundle.Bundle can read `dest`.

    Raises BucketImportError before downloading anything when the folder is empty, has no state.sqlite or has more than one, or holds more than `max_files`
    files; while downloading, when the total passes `max_bytes`. A listed name that could point outside `dest` is skipped, never written.
    """
    prefix = check_import_prefix(prefix)
    dest = Path(dest)
    dest.mkdir(parents=True, exist_ok=True)
    root = dest.resolve()
    result = FetchResult(folder=dest, prefix=prefix)
    plan: List[Tuple[str, str, str]] = []
    for key in store.list(prefix):
        relative = key[len(prefix):]
        if not relative or relative.endswith("/"):            # the console's empty "folder" placeholders
            continue
        kind = _wanted(relative, include_pdfs)
        try:
            validate_key(relative)
            target = (root / relative).resolve()
            target.relative_to(root)
        except (InvalidKeyError, ValueError):
            result.skipped += 1
            LOGGER.warning("skipping a name that cannot be placed inside the bundle folder: %r", relative[:120])
            continue
        if kind is None:
            result.skipped += 1
            continue
        plan.append((key, relative, kind))
    if not plan:
        raise BucketImportError(f"Nothing to import under {prefix} in the bucket. Upload the notebook's whole output folder there, for example: "
                                f"gcloud storage cp -r <output folder>/* gs://<bucket>/<prefix>/{prefix}")
    states = [relative for _key, relative, kind in plan if kind == "state" and relative.rsplit("/", 1)[-1] == "state.sqlite"]
    if not states:
        raise BucketImportError(f"{prefix} has pictures but no state.sqlite. The notebook's output folder holds state.sqlite next to its crops/ folder: upload both.")
    if len(states) > 1:
        raise BucketImportError(f"{prefix} has {len(states)} state.sqlite files ({', '.join(sorted(states)[:3])}). Import one run at a time: put each in its own folder.")
    if len(plan) > max_files:
        raise BucketImportError(f"{prefix} holds {len(plan)} files to import, more than the {max_files} this import will take. Is it the right folder?")

    total = len(plan)
    counter = {"done": 0, "bytes": 0}
    stop = {"flag": False}
    lock = threading.Lock()

    def fetch_one(item: Tuple[str, str, str]) -> Tuple[str, Path]:
        key, relative, kind = item
        if stop["flag"]:
            raise BucketImportError("stopped")
        target = root / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        store.get_file(key, target)
        size = target.stat().st_size
        with lock:
            counter["bytes"] += size
            counter["done"] += 1
            done, so_far = counter["done"], counter["bytes"]
        if so_far > max_bytes:
            stop["flag"] = True
            raise BucketImportError(f"{prefix} is larger than the {max_bytes // 1024 ** 3} GiB this import will take. Is it the right folder?")
        if progress is not None:
            progress("fetch", done, total, f"Copying from the bucket ({done}/{total})")
        return kind, target

    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, int(workers))) as pool:
        futures = [pool.submit(fetch_one, item) for item in plan]
        error: Optional[BaseException] = None
        for future in concurrent.futures.as_completed(futures):
            try:
                kind, target = future.result()
            except BaseException as exc:                      # the first real failure wins; the "stopped" ones are just its echo
                stop["flag"] = True
                if error is None or (isinstance(error, BucketImportError) and str(error) == "stopped"):
                    error = exc
                continue
            result.files += 1
            result.bytes += target.stat().st_size
            if kind == "image":
                result.images += 1
            elif kind == "pdf":
                result.pdfs.append(target)
            elif target.name == "state.sqlite-wal":
                result.has_wal = True
        if error is not None:
            raise error
    return result


def seed_release_cache(store: Any, catalogue: str, release_id: str, cache_dir: Any, cfg: Any, *, commit_cache: Optional[Callable[[], Any]] = None,
                       reload_cache: Optional[Callable[[], Any]] = None) -> SeedResult:
    """Make sure `releases/<catalogue>/<release_id>/` is in `cache_dir` (on Modal: the volume mounted at /cache), checked against its manifest's sha256s.

    It is the search service's own read-through loader, called ahead of time, so what lands on the volume is exactly what a search container would have
    downloaded on its first query: same folder, same checks, same atomic install. `commit_cache` (volume.commit) runs after a download. Idempotent.
    """
    from .release_reader import load_release            # numpy only; imported here so importing this module stays light

    loaded = load_release(store, catalogue, release_id, cache_dir, compute_feature_versions(cfg), cfg, commit_cache=commit_cache, reload_cache=reload_cache)
    return SeedResult(catalogue=catalogue, release_id=loaded.release_id, n_items=loaded.n_items, source=loaded.source,
                      path=str(loaded.path) if loaded.path else None)


@dataclass
class ImportOutcome:
    ok: bool
    catalogue: str
    prefix: str
    release_id: Optional[str] = None
    items: int = 0
    activated: bool = False
    release_reused: bool = False
    created_catalogue: bool = False
    fetched: Dict[str, Any] = field(default_factory=dict)
    seeded: Optional[Dict[str, Any]] = None
    seed_error: Optional[str] = None
    warnings: List[str] = field(default_factory=list)

    def as_dict(self) -> Dict[str, Any]:
        return {"ok": self.ok, "catalogue": self.catalogue, "prefix": self.prefix, "releaseId": self.release_id, "items": self.items, "activated": self.activated,
                "releaseReused": self.release_reused, "createdCatalogue": self.created_catalogue, "fetched": self.fetched, "seeded": self.seeded,
                "seedError": self.seed_error, "warnings": list(self.warnings)}


def run_bucket_import(*, db: Any, store: Any, cfg: Any, catalogue: str, prefix: str, workdir: Any, activate: bool = False, create_name: Optional[str] = None,
                      create_kind: str = "materials", include_pdfs: bool = False, cache_dir: Any = None, commit_cache: Optional[Callable[[], Any]] = None,
                      reload_cache: Optional[Callable[[], Any]] = None, progress: Optional[Progress] = None, publish: Optional[Callable] = None,
                      job_id: Optional[str] = None) -> ImportOutcome:
    """fetch the folder -> publish it (the same publish_bundle every path uses) -> put the new release on the volume. Raises BucketImportError or PublishError
    (nothing was published) ; a failure to seed the volume only sets `seed_error`, because the volume is an optimisation and the release is already live in GCS.

    A publish never creates a catalogue by accident: the catalogue must exist, unless `create_name` says to create it now.
    """
    if publish is None:
        from .publish import publish_bundle as publish
    try:
        check_catalogue_id(catalogue)
    except CatalogueDbError as error:
        raise BucketImportError(str(error)) from None
    prefix = check_import_prefix(prefix)
    outcome = ImportOutcome(ok=False, catalogue=catalogue, prefix=prefix)
    if db.get_catalogue(catalogue) is None:
        if not create_name:
            raise BucketImportError(f"The catalogue {catalogue!r} does not exist. Create it first, or say to create it now (modal run ... --create \"<name people see>\"); "
                                    "nothing is created by accident so that a mistyped id cannot start a new catalogue.")
        db.upsert_catalogue(catalogue, name=create_name, kind=create_kind)
        outcome.created_catalogue = True

    fetched = fetch_bundle(store, prefix, Path(workdir) / "bundle", include_pdfs=include_pdfs, progress=progress)
    outcome.fetched = fetched.as_dict()
    sources: Dict[str, Path] = {sha256_of_file(path): path for path in fetched.pdfs}
    stamp = _dt.datetime.now(_dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    published = publish(fetched.folder, catalogue=catalogue, store=store, db=db, cfg=cfg, job_id=job_id or f"import-{stamp}", source_files=sources or None,
                        activate=activate, dry_run=False, progress=progress, created_by="import")
    outcome.release_id = published.release_id
    outcome.items = int(published.n_items)
    outcome.activated = bool(published.activated)
    outcome.release_reused = bool(getattr(published, "release_reused", False))
    outcome.warnings = list(published.warnings)[:50]
    outcome.ok = True
    if published.release_id and cache_dir is not None:
        if progress is not None:
            progress("seed", 0, 1, "Putting the release on the Modal volume")
        try:
            outcome.seeded = seed_release_cache(store, catalogue, published.release_id, cache_dir, cfg, commit_cache=commit_cache, reload_cache=reload_cache).as_dict()
        except Exception as exc:                          # the release is already live from GCS; only the speed-up is missing
            outcome.seed_error = f"{type(exc).__name__}: {str(exc)[:200]}"
            LOGGER.warning("the release %s is published but could not be put on the volume (%s)", published.release_id, type(exc).__name__)
    return outcome


def seed_after_ingest(outcome: Mapping[str, Any], *, db: Any, store: Any, cfg: Any, cache_dir: Any, commit_cache: Optional[Callable[[], Any]] = None,
                      reload_cache: Optional[Callable[[], Any]] = None) -> Optional[Dict[str, Any]]:
    """After an admin-upload job (ingest_job.run_ingest_job) succeeded: put the release it published on the volume too. Never raises, never changes `outcome`'s ok/status.

    Returns what was seeded ({"catalogue", "releaseId", "items", "source"}), {"error": ...} when seeding failed, or None when there was nothing to seed.
    """
    try:
        release_id = outcome.get("releaseId")
        job_id = outcome.get("jobId")
        if not outcome.get("ok") or not release_id or not job_id:
            return None
        job = db.get_job(job_id) or {}
        catalogue = job.get("catalogue")
        if not isinstance(catalogue, str) or not catalogue:
            return None
        return seed_release_cache(store, catalogue, release_id, cache_dir, cfg, commit_cache=commit_cache, reload_cache=reload_cache).as_dict()
    except Exception as exc:
        LOGGER.warning("the job's release is published but could not be put on the volume (%s)", type(exc).__name__)
        return {"error": f"{type(exc).__name__}: {str(exc)[:200]}"}


def prime_volume(*, db: Any, store: Any, cfg: Any, catalogue: str, cache_dir: Any, release: Optional[str] = None, include_previous: bool = True,
                 commit_cache: Optional[Callable[[], Any]] = None, reload_cache: Optional[Callable[[], Any]] = None) -> List[SeedResult]:
    """Put releases that already exist in the bucket on the volume. Without `release`: the live release and, with include_previous, the one it replaced (so a
    rollback is as fast as the live one). Raises BucketImportError when the catalogue is unknown or nothing is live and no release was named."""
    try:
        check_catalogue_id(catalogue)
    except CatalogueDbError as error:
        raise BucketImportError(str(error)) from None
    chosen: Sequence[str]
    if release:
        chosen = [release]
    else:
        document = db.get_catalogue(catalogue)
        if document is None:
            raise BucketImportError(f"The catalogue {catalogue!r} does not exist.")
        chosen = [r for r in (document.get("activeRelease"), document.get("previousRelease") if include_previous else None) if r]
        if not chosen:
            raise BucketImportError(f"The catalogue {catalogue!r} has no live release yet. Import or activate one first, or name the release to copy.")
    return [seed_release_cache(store, catalogue, name, cache_dir, cfg, commit_cache=commit_cache, reload_cache=reload_cache) for name in chosen]
