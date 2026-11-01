"""run_compute: the notebook's run_pipeline stages 1-4 (extract, local features, Vertex image embeddings, captions + text vectors) without the index
stage, writing the BUNDLE (a work_dir: state.sqlite + crops/ + a small bundle.json) that the publisher turns into a release.

Ported from terucon-cat-1.ipynb (cell 7, run_pipeline). The stage classes are the notebook's (extract.py, encoders.py, vertex.py, captions.py);
what this module adds is the orchestration the notebook did not need on Kaggle:

* progress(stage, done, total, message): at the start and the end of every stage and before every batch (after the previous batch is committed);
* should_cancel(): polled at the same points; True raises Cancelled. Everything committed so far stays, nothing is half-written, a later
  run_compute on the same work_dir carries on where this one stopped;
* idempotent: a second run on the same inputs makes no model call and no API call (the stage queries find nothing pending), and the neural
  models are not even loaded when nothing is pending;
* resume: prepare_resume() on a work_dir that only holds a restored state.sqlite re-extracts every page (the crops regenerate bit-identically)
  and, because StateStore.commit_page_result keeps the embeddings and captions of any item whose crop sha256 did not change, repeats no paid work;
* photos: an image file among the inputs is wrapped as a one-page PDF (photos.py) and goes through the same extractor; `segment_photos` marks the
  photos that show SEVERAL swatches (their render is segmented even without text).

No import-time side effects; torch and the Vertex libraries are only imported when a stage needs them.
"""
from __future__ import annotations

import dataclasses
import json
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Sequence

from . import __version__
from .captions import DescriptionEmbeddingIndexer, GeminiMaterialSynthesizer
from .config import compute_caption_version, compute_feature_versions, local_feature_versions
from .encoders import LocalFeatureExtractor
from .extract import CatalogueExtractor, safe_name
from .features import resolve_crop_path
from .state import StateStore
from .util import IMAGE_EXTENSIONS, LOGGER, atomic_write_bytes, get_async_runner, sha256_file
from .vertex import VertexMultimodalImageEmbedder

STAGES = ("extract", "features", "vertex_mm", "captions", "text_vectors")
VERTEX_STAGES = ("vertex_mm", "captions", "text_vectors")


class Cancelled(Exception):
    """should_cancel() returned True. The state on disk is consistent (every batch is committed whole); run_compute again to carry on."""


@dataclass
class ComputeResult:
    work_dir: Path
    pdfs: list[dict]            # per input: name, sha256, pages (+ status, kind "pdf"|"photo", origin, segmented, path)
    n_items: int                # items of these inputs (status 'ok')
    n_pages: int                # pages of these inputs
    failed_pages: list[dict]    # {"pdf", "page", "error"}: pages the extractor could not process, photos that could not be wrapped
    unmatched: int              # items with no product id (the notebook's "UNMATCHED"): all of them for a catalogue like the owner's
    stages: dict                # per stage: status "done" | "skipped" | "not-requested", processed, pending, elapsedS, message
    warnings: list[str]


# ---------------------------------------------------------------------------------------------------------------------
# progress + cancellation
# ---------------------------------------------------------------------------------------------------------------------
class _Reporter:
    def __init__(self, progress, should_cancel):
        self.progress = progress
        self.should_cancel = should_cancel
        self._complained = set()

    def emit(self, stage, done, total, message):
        if self.progress is None:
            return
        try:
            self.progress(stage, int(done), int(total), str(message))
        except Cancelled:
            raise
        except Exception as exc:  # a broken progress sink (a database blip) must not kill a long compute
            if "progress" not in self._complained:
                self._complained.add("progress")
                LOGGER.warning("The progress callback failed (%s: %s); carrying on without it.", type(exc).__name__, exc)

    def check(self, stage):
        if self.should_cancel is None:
            return
        try:
            cancelled = bool(self.should_cancel())
        except Exception as exc:
            if "cancel" not in self._complained:
                self._complained.add("cancel")
                LOGGER.warning("should_cancel() failed (%s: %s); treating it as 'not cancelled'.", type(exc).__name__, exc)
            return
        if cancelled:
            raise Cancelled(f"cancelled during the {stage} stage")

    def batch_hook(self, stage, last):
        """The `on_batch(done, total)` callback of the stage classes: progress, then the cancel poll. `last` remembers the latest (done, total)."""
        def hook(done, total):
            last[:] = [done, total]
            self.emit(stage, done, total, f"{done}/{total}" if total else "nothing to do")
            self.check(stage)
        return hook


# ---------------------------------------------------------------------------------------------------------------------
# inputs: PDFs, folders of PDFs, photos
# ---------------------------------------------------------------------------------------------------------------------
def _page_count(path):
    try:
        import pymupdf as fitz
    except ImportError:  # pragma: no cover
        import fitz
    try:
        with fitz.open(str(path)) as document:
            return int(document.page_count)
    except Exception:
        return 0


def _prepare_inputs(cfg, pdfs, segment_photos, warnings, failures, report):
    """-> list of {"name", "path", "sha256", "kind", "force", "origin"}; photos are wrapped as PDFs inside work_dir/wrapped/."""
    from .photos import wrap_photo_as_pdf

    forced = {Path(path).resolve() for path in segment_photos}
    matched = set()
    expanded = []
    for given in pdfs:
        path = Path(given)
        if not path.exists():
            raise FileNotFoundError(f"Input not found: {path}")
        if path.is_dir():
            found = [p for p in sorted(path.rglob("*")) if p.is_file() and p.suffix.lower() == ".pdf"]
            if not found:
                warnings.append(f"The folder {path} holds no PDF files.")
            expanded.extend(found)
        else:
            expanded.append(path)
    inputs = []
    seen = set()
    for path in expanded:
        report.check("extract")
        if path.suffix.lower() in IMAGE_EXTENSIONS:
            photo_sha = sha256_file(path)
            wrapped = cfg.work_dir / "wrapped" / f"{safe_name(path.stem)}_{photo_sha[:8]}.pdf"
            try:
                wrap_photo_as_pdf(path, wrapped)
            except Exception as exc:
                failures.append({"pdf": path.name, "page": 1, "error": f"{type(exc).__name__}: {exc}"[:400]})
                warnings.append(f"The photo {path.name} was skipped: {exc}")
                continue
            origin = {"name": path.name, "sha256": photo_sha, "bytes": path.stat().st_size}
            record = {"name": path.name, "path": wrapped, "kind": "photo", "origin": origin,
                      "force": path.resolve() in forced or wrapped.resolve() in forced}
            matched.update({path.resolve(), wrapped.resolve()} & forced)
        else:
            record = {"name": path.name, "path": path, "kind": "pdf", "origin": None, "force": path.resolve() in forced}
            matched.update({path.resolve()} & forced)
        record["sha256"] = sha256_file(record["path"])
        if record["sha256"] in seen:
            warnings.append(f"{path.name} has the same content as an input that was already given; it is processed once.")
            continue
        seen.add(record["sha256"])
        inputs.append(record)
    for path in sorted(forced - matched):
        warnings.append(f"segment_photos names {path}, which is not one of the inputs; ignored.")
    return inputs


# ---------------------------------------------------------------------------------------------------------------------
def _normalise_stages(stages):
    if isinstance(stages, str):
        stages = (stages,)
    unknown = [name for name in stages if name not in STAGES]
    if unknown:
        raise ValueError(f"Unknown stage(s) {unknown}; the stages are {list(STAGES)}")
    return [name for name in STAGES if name in set(stages)]   # always in the notebook's order, whatever order was asked for


def _default_encoders(cfg):
    from .encoders import EncoderBank   # imports torch / transformers and loads the weights: only when there is something to encode
    return EncoderBank(cfg)


def _count(store, sql, parameters=()):
    return int(store.query(sql, parameters)[0][0])


def _in_clause(shas):
    return ",".join(["?"] * len(shas)), tuple(shas)


def _close_store(store):
    """Leave a single self-contained state.sqlite behind: PY-C copies exactly that file, so the WAL must be folded into it."""
    try:
        store.query("PRAGMA wal_checkpoint(TRUNCATE)")
    except Exception as exc:  # pragma: no cover - closing must not hide the real error
        LOGGER.warning("Could not checkpoint the state database: %s", exc)
    store.close()


def prepare_resume(work_dir):
    """Call after a state snapshot (state.sqlite) has been restored into an otherwise EMPTY work_dir (no crops/).

    Deletes the `pages` rows and sets every `pdfs` row back to 'in_progress', so run_compute re-extracts every page. The crops come back
    bit-identically; StateStore.commit_page_result keeps the embeddings and captions of every item whose crop sha256 is unchanged, so the paid
    work is not repeated. Returns {"pagesCleared": n, "pdfsReset": n}.
    """
    database = Path(work_dir) / "state.sqlite"
    if not database.is_file():
        return {"pagesCleared": 0, "pdfsReset": 0}
    store = StateStore(database)
    try:
        with store.transaction() as connection:
            pages = connection.execute("DELETE FROM pages").rowcount
            pdfs = connection.execute("UPDATE pdfs SET status = 'in_progress'").rowcount
    finally:
        _close_store(store)
    return {"pagesCleared": int(pages), "pdfsReset": int(pdfs)}


# ---------------------------------------------------------------------------------------------------------------------
def run_compute(cfg, *, pdfs: Sequence[Path], work_dir: Path, encoders=None, manager=None, progress=None, should_cancel=None,
                stages=("extract", "features", "vertex_mm", "captions", "text_vectors"), segment_photos: Iterable[Path] = ()) -> ComputeResult:
    """Turn PDFs (and photos) into a bundle in `work_dir`.

    pdfs            PDF files, folders of PDFs, and/or image files (wrapped as one-page PDFs). With none, the stages run on what the work_dir already holds.
    encoders        an EncoderBank (or anything with its interface); None builds the real one, but only if there is something to encode.
    manager         a VertexGenAIManager (or anything with its interface); None skips the vertex_mm / captions / text_vectors stages with a warning.
    progress        progress(stage, done, total, message)
    should_cancel   should_cancel() -> bool, polled between batches; True raises Cancelled
    segment_photos  the inputs (the photo, or its wrapped PDF) that show several swatches: their render is segmented even without text
    cfg.work_dir is ignored in favour of `work_dir`; cfg itself is not modified.
    """
    wanted = _normalise_stages(stages)
    cfg = dataclasses.replace(cfg, work_dir=Path(work_dir))
    cfg.ensure_dirs()
    report = _Reporter(progress, should_cancel)
    warnings: list[str] = []
    failures: list[dict] = []
    info: dict[str, dict] = {name: {"status": "not-requested"} for name in STAGES}
    store = StateStore(cfg.state_db_path)
    try:
        report.check("extract")
        inputs: list[dict] = []
        if "extract" in wanted:
            report.emit("extract", 0, 0, "preparing the inputs")
            inputs = _prepare_inputs(cfg, pdfs, segment_photos, warnings, failures, report)
            _run_extract(cfg, store, inputs, report, info, warnings)
        elif pdfs:
            warnings.append("PDFs were given but the extract stage was not requested; they were not read.")
        if "features" in wanted:
            _run_features(cfg, store, encoders, report, info)
        needs_vertex = [name for name in VERTEX_STAGES if name in wanted]
        if needs_vertex and manager is None:
            warnings.append("No Vertex AI manager was given, so the " + ", ".join(needs_vertex) + " stage(s) were skipped "
                            "(the notebook does the same when Vertex AI is not available).")
            for name in needs_vertex:
                info[name] = {"status": "skipped", "message": "no Vertex AI manager"}
        elif needs_vertex:
            runner = get_async_runner()
            if "vertex_mm" in wanted:
                _run_vertex(cfg, store, manager, runner, report, info, warnings)
            if "captions" in wanted:
                _run_captions(cfg, store, manager, runner, report, info, warnings)
            if "text_vectors" in wanted:
                _run_text_vectors(cfg, store, manager, runner, report, info, warnings)
        result = _build_result(cfg, store, inputs, failures, info, warnings)
        _write_bundle_json(cfg, store, info, warnings)
        return result
    finally:
        _close_store(store)


# ---------------------------------------------------------------------------------------------------------------------
# stages
# ---------------------------------------------------------------------------------------------------------------------
def _run_extract(cfg, store, inputs, report, info, warnings):
    started = time.time()
    LOGGER.info("== Stage 1/4: PDF extraction (%d input(s)) ==", len(inputs))
    totals = [_page_count(record["path"]) for record in inputs]
    total_pages = sum(totals)
    progress_state = {"before": 0, "done": 0}

    def on_page(name, page_number, page_count):
        progress_state["done"] = progress_state["before"] + page_number
        report.emit("extract", progress_state["done"], total_pages, f"{name}: page {page_number}/{page_count}")
        report.check("extract")

    def pages_done():
        if not inputs:
            return 0
        marks, parameters = _in_clause([record["sha256"] for record in inputs])
        return _count(store, f"SELECT COUNT(*) FROM pages WHERE status = 'done' AND pdf_sha256 IN ({marks})", parameters)

    extractor = CatalogueExtractor(cfg, store, on_page=on_page)
    done_before = pages_done()
    report.emit("extract", 0, total_pages, f"{len(inputs)} input(s), {total_pages} page(s)")
    for record, pages in zip(inputs, totals):
        report.check("extract")
        extractor.process_pdf(record["path"], force_segmentation=record["force"],
                              display_name=record["name"] if record["kind"] == "photo" else None)
        progress_state["before"] += pages
    missing = []
    for row in store.query("SELECT item_id, crop_filepath FROM items WHERE status = 'ok'"):
        if not resolve_crop_path(cfg.work_dir, row["crop_filepath"]).is_file():
            missing.append(row["item_id"])
    if missing:
        warnings.append(f"{len(missing)} crop file(s) that state.sqlite lists are missing from {cfg.crops_dir} (for example {missing[0]}). If this "
                        "work_dir only holds a restored state.sqlite, call prepare_resume(work_dir) first so the pages are extracted again.")
    # "processed" = pages extracted by THIS run (a page that was already done is not counted), "pending" = all pages of the inputs
    info["extract"] = {"status": "done", "processed": pages_done() - done_before, "pending": total_pages, "inputs": len(inputs),
                       "elapsedS": round(time.time() - started, 3)}
    report.emit("extract", total_pages, total_pages, "done")


def _stage_finish(info, name, started, processed, last, report, **extra):
    done, total = last
    info[name] = {"status": "done", "processed": int(processed), "pending": int(total), "elapsedS": round(time.time() - started, 3), **extra}
    report.emit(name, done, total, "done" if total else "nothing to do")


def _run_features(cfg, store, encoders, report, info):
    started = time.time()
    LOGGER.info("== Stage 2/4: DINOv2 + SigLIP + CIELAB ==")
    report.check("features")
    report.emit("features", 0, 0, "starting")
    pending = store.items_needing_pillars(local_feature_versions(cfg), cfg.max_feature_attempts)
    last = [0, 0]
    processed = 0
    if pending:
        if encoders is None:
            report.emit("features", 0, len(pending), "loading the models")
            encoders = _default_encoders(cfg)
        processed = LocalFeatureExtractor(cfg, store, encoders, on_batch=report.batch_hook("features", last)).run()
    _stage_finish(info, "features", started, processed, last, report)


def _run_vertex(cfg, store, manager, runner, report, info, warnings):
    started = time.time()
    LOGGER.info("== Stage 3/4: Vertex multimodal image embeddings ==")
    report.check("vertex_mm")
    report.emit("vertex_mm", 0, 0, "starting")
    last = [0, 0]
    processed = VertexMultimodalImageEmbedder(cfg, store, manager, runner, on_batch=report.batch_hook("vertex_mm", last)).run()
    if not cfg.enable_vertex_multimodal_embedding:
        info["vertex_mm"] = {"status": "skipped", "message": "cfg.enable_vertex_multimodal_embedding is off"}
        report.emit("vertex_mm", 0, 0, "skipped")
        return
    if "vertex_mm" in getattr(manager, "disabled_features", ()):
        warnings.append("multimodalembedding is not available for this Vertex project; the vertex_mm pillar was left out.")
    _stage_finish(info, "vertex_mm", started, processed, last, report)


def _run_captions(cfg, store, manager, runner, report, info, warnings):
    started = time.time()
    LOGGER.info("== Stage 4/4: Gemini structured material synthesis + description vectors ==")
    report.check("captions")
    report.emit("captions", 0, 0, "starting")
    last = [0, 0]
    processed = GeminiMaterialSynthesizer(cfg, store, manager, runner, on_batch=report.batch_hook("captions", last)).run()
    version = compute_caption_version(cfg)
    counts = {row["status"]: int(row["n"]) for row in store.query(
        "SELECT c.status AS status, COUNT(*) AS n FROM captions c JOIN items i ON i.item_id = c.item_id"
        " WHERE i.status = 'ok' AND c.caption_version = ? GROUP BY c.status", (version,))}
    failed = counts.get("error", 0)
    if failed:
        warnings.append(f"{failed} caption(s) failed (see the captions table; each is retried up to {cfg.max_caption_attempts} times over runs).")
    _stage_finish(info, "captions", started, processed, last, report, failed=failed)


def _run_text_vectors(cfg, store, manager, runner, report, info, warnings):
    started = time.time()
    report.check("text_vectors")
    report.emit("text_vectors", 0, 0, "starting")
    last = [0, 0]
    processed = DescriptionEmbeddingIndexer(cfg, store, manager, runner, on_batch=report.batch_hook("text_vectors", last)).run()
    versions = compute_feature_versions(cfg)
    left = len(store.pending_text_embeddings(versions["text"], compute_caption_version(cfg), cfg.max_feature_attempts))
    if left:
        warnings.append(f"{left} description(s) have no text vector yet (see feature_errors).")
    _stage_finish(info, "text_vectors", started, processed, last, report, failed=left)


# ---------------------------------------------------------------------------------------------------------------------
# result + bundle.json
# ---------------------------------------------------------------------------------------------------------------------
def _last_line(text):
    lines = [line.strip() for line in str(text or "").strip().splitlines() if line.strip()]
    return (lines[-1] if lines else "")[:400]


def _build_result(cfg, store, inputs, failures, info, warnings):
    if inputs:
        shas = [record["sha256"] for record in inputs]
        rows = {sha: store.get_pdf(sha) for sha in shas}
        pdfs = []
        for record in inputs:
            row = rows[record["sha256"]]
            pdfs.append({"name": record["name"], "sha256": record["sha256"], "pages": int(row["page_count"]) if row is not None else 0,
                         "status": row["status"] if row is not None else "missing", "kind": record["kind"], "origin": record["origin"],
                         "segmented": bool(record["force"]), "path": str(record["path"])})
            if row is not None and row["status"] == "error":
                warnings.append(f"{record['name']} could not be read: {row['error']}")
    else:   # nothing given: the result describes the whole work_dir
        pdfs = [{"name": row["source_pdf"], "sha256": row["pdf_sha256"], "pages": int(row["page_count"] or 0), "status": row["status"],
                 "kind": None, "origin": None, "segmented": False, "path": None}
                for row in store.query("SELECT * FROM pdfs ORDER BY source_pdf, pdf_sha256")]
        shas = [entry["sha256"] for entry in pdfs]
    failed_pages = list(failures)
    n_items = unmatched = 0
    if shas:
        marks, parameters = _in_clause(shas)
        names = {entry["sha256"]: entry["name"] for entry in pdfs}
        for row in store.query(f"SELECT pdf_sha256, page_number, error FROM pages WHERE status = 'error' AND pdf_sha256 IN ({marks})"
                               " ORDER BY pdf_sha256, page_number", parameters):
            failed_pages.append({"pdf": names.get(row["pdf_sha256"]), "page": int(row["page_number"]), "error": _last_line(row["error"])})
        n_items = _count(store, f"SELECT COUNT(*) FROM items WHERE status = 'ok' AND pdf_sha256 IN ({marks})", parameters)
        unmatched = _count(store, f"SELECT COUNT(*) FROM items WHERE status = 'ok' AND product_id IS NULL AND pdf_sha256 IN ({marks})", parameters)
    if failed_pages:
        warnings.append(f"{len(failed_pages)} page(s)/photo(s) could not be processed (see failed_pages).")
    return ComputeResult(work_dir=cfg.work_dir, pdfs=pdfs, n_items=n_items, n_pages=sum(entry["pages"] for entry in pdfs),
                         failed_pages=failed_pages, unmatched=unmatched, stages=info, warnings=warnings)


def _feature_versions_in_db(cfg, store, warnings):
    """What is actually stored, per pillar: the version label next to the vectors (a pillar with no vectors is absent)."""
    expected = compute_feature_versions(cfg)
    stored = {}
    for pillar in expected:
        rows = store.query("SELECT feature_version, COUNT(*) AS n FROM embeddings WHERE pillar = ? GROUP BY feature_version ORDER BY n DESC, feature_version",
                           (pillar,))
        if not rows:
            continue
        versions = [row["feature_version"] for row in rows]
        stored[pillar] = expected[pillar] if expected[pillar] in versions else versions[0]
        if len(versions) > 1:
            warnings.append(f"The {pillar} pillar holds vectors of {len(versions)} different versions {versions}; a release needs exactly one.")
    return stored


def _write_bundle_json(cfg, store, info, warnings):
    pdfs = [{"name": row["source_pdf"], "sha256": row["pdf_sha256"], "pages": int(row["page_count"] or 0), "status": row["status"]}
            for row in store.query("SELECT * FROM pdfs ORDER BY source_pdf, pdf_sha256")]
    bundle = {"schema": 1, "createdAt": int(time.time() * 1000), "package": {"name": "terucon_catalogue", "version": __version__},
              "featureVersions": _feature_versions_in_db(cfg, store, warnings), "pdfs": pdfs, "stages": info}
    atomic_write_bytes(cfg.work_dir / "bundle.json", json.dumps(bundle, indent=2, sort_keys=True).encode("utf-8"))
