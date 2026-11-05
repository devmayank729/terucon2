"""The publisher: one bundle in, a catalogue (MongoDB documents + GCS objects + an immutable search release) out.

    publish_bundle(bundle_dir, catalogue=..., store=..., db=..., cfg=...)

Whatever produced the bundle (the admin's upload on Modal, the owner's own Kaggle or laptop run, or the notebook's finished output as it is today)
goes through this one function. The order is fixed, and it is what makes a publish safe:

  1  CHECK       open the bundle read-only, verify() it, compare its feature versions with the code's and with the catalogue's parent release, check
                 the source files. Any problem raises PublishError (with .problems, plain sentences) and NOTHING has been written.
  2  PLAN        in memory: item documents, thumbnails, the new release (items.json, vectors, hashes), and what is already in the store and in
                 MongoDB. If the new release is identical to one that exists, no new release is made. dry_run=True stops here and reports.
  3  WRITE       sources, crops, thumbnails and the state snapshot (GCS) -> item documents (MongoDB; admin edits kept) -> the release's files, its
                 manifest last (GCS) -> the release record (MongoDB) -> and only if activate=True, the catalogue's activeRelease pointer. The pointer
                 flips last, so an exception anywhere leaves the old live release exactly as it was; running the same publish again finishes the job.

Deviation from a literal reading of ARCHITECTURE.md section 9: the release is BUILT (in memory) before the first write, because its content decides
whether a release is created at all and which release id the new item documents record in `releaseFirst`.

Decisions that are this module's own, and documented here because they are visible to other code:
* items.json carries the productId that the PDF's text layer gave (the bundle's product_id), not an admin-typed id: a release is immutable and an admin
  edit is not a content change. The website applies admin ids when it enriches search results.
* An item in the bundle replaces the parent's item and ALL the parent's vectors for it (see release_writer.merge_content).
* A crop already in the store under the same key but with different bytes is REPLACED, and the result says so (a key is per item, not per content).
* Thumbnails are not enlarged: a crop whose longest side is under 480 px gets a same-size JPEG.
* feature_errors rows and captions that failed are warnings (those signals are simply absent for those items); everything that means damage is an error.
"""
from __future__ import annotations

import datetime as _dt
import io
import re
import secrets
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, List, Mapping, Optional, Sequence, Tuple

import numpy as np

from . import __version__
from .bundle import KNOWN_PIPELINE_PILLARS, Bundle, BundleError, BundleItem, errors_of, sha256_of_file, warnings_of
from .mongo import CatalogueDbError, check_catalogue_id, default_clock, publisher_view
from .objectstore import key_to_content_type, md5_hex_of_bytes, md5_hex_of_file
from .release_writer import (BuiltRelease, ReleaseData, ReleaseReadError, build_release, content_fingerprint, is_release_id, item_entry, read_manifest,
                             read_release, release_prefix, write_release)

CLOCK: Callable[[], int] = default_clock            # epoch milliseconds; tests replace it
THUMB_MAX_SIDE = 480
THUMB_QUALITY = 82
CREATED_BY = ("ingest", "cli", "import")
_JOB_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")


class PublishError(Exception):
    """A publish was refused. Nothing had been written. .problems are plain sentences; .warnings are the non-blocking ones found on the way."""

    def __init__(self, problems: Sequence[str], warnings: Sequence[str] = ()):
        self.problems = list(problems)
        self.warnings = list(warnings)
        first = self.problems[0] if self.problems else "unknown problem"
        extra = f" (and {len(self.problems) - 1} more)" if len(self.problems) > 1 else ""
        super().__init__(f"Publish refused, nothing was written: {first}{extra}")


class ActivationError(RuntimeError):
    pass


@dataclass
class PublishResult:
    release_id: Optional[str]            # the release this publish produced or reused; None for a dry run that would create one
    n_items: int                         # items in that release (its nItems)
    n_new: int                           # bundle items that were not in the parent release (0 when nothing changed)
    activated: bool                      # True iff THIS call flipped the catalogue's activeRelease
    warnings: List[str]
    dry_run: bool
    parent_release: Optional[str] = None
    n_changed: int = 0                   # bundle items that were in the parent release with different content
    n_unchanged: int = 0                 # bundle items identical to the parent's
    n_bundle_items: int = 0              # items taken from the bundle (after leaving out the ones that cannot be searched)
    n_dropped: int = 0                   # bundle items left out because they have no dino, siglip or colour vector
    release_reused: bool = False         # an existing release already had exactly this content
    nothing_to_do: bool = False          # everything was already in place; nothing was written
    report: List[str] = field(default_factory=list)       # plain sentences saying what happened (or, for a dry run, what would)
    details: Dict[str, Any] = field(default_factory=dict)


Progress = Callable[[str, int, int, str], None]


# ---------------------------------------------------------------------------------------------------------------------------------- ids
def new_release_id(now_ms: int) -> str:
    stamp = _dt.datetime.fromtimestamp(now_ms / 1000.0, _dt.timezone.utc).strftime("%Y%m%d%H%M%S")
    return f"rel-{stamp}-{secrets.token_hex(3)}"


def manual_job_id(now_ms: int) -> str:
    return "manual-" + _dt.datetime.fromtimestamp(now_ms / 1000.0, _dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def safe_file_name(name: str, limit: int = 100) -> str:
    """A file name safe to use as the last part of an object key (letters, digits, '.', '_', '-'; the extension is kept)."""
    stem, dot, extension = str(name).rpartition(".")
    if not dot:
        stem, extension = str(name), ""
    stem = re.sub(r"[^A-Za-z0-9._-]+", "_", stem)[:limit].strip("._") or "file"
    extension = re.sub(r"[^A-Za-z0-9]+", "", extension)[:10]
    return f"{stem}.{extension}" if extension else stem


def source_key(sha256: str, name: str) -> str:
    return f"sources/{sha256}/{safe_file_name(name)}"


# ------------------------------------------------------------------------------------------------------------------------------ thumbnails
def make_thumbnail(path: Path) -> Tuple[bytes, int, int]:
    """JPEG, longest side 480 px (never enlarged), Lanczos, quality 82, 4:2:0, no metadata of any kind, the same bytes every time for the same input."""
    from PIL import Image

    with Image.open(path) as source:
        source.load()
        if source.mode in ("RGBA", "LA") or (source.mode == "P" and "transparency" in source.info):
            rgba = source.convert("RGBA")
            flat = Image.new("RGB", rgba.size, (255, 255, 255))
            flat.paste(rgba, mask=rgba.getchannel("A"))
            rgb = flat
        else:
            rgb = source.convert("RGB")
    width, height = rgb.size
    scale = THUMB_MAX_SIDE / max(width, height)
    if scale < 1.0:
        rgb = rgb.resize((max(1, round(width * scale)), max(1, round(height * scale))), Image.Resampling.LANCZOS)
    clean = Image.frombytes("RGB", rgb.size, rgb.tobytes())          # a fresh image: nothing from the source's info (EXIF, ICC, comments) can follow
    buffer = io.BytesIO()
    clean.save(buffer, format="JPEG", quality=THUMB_QUALITY, optimize=False, progressive=False, subsampling=2)
    return buffer.getvalue(), clean.size[0], clean.size[1]


def _image_size(path: Path) -> Tuple[int, int]:
    from PIL import Image

    with Image.open(path) as image:
        return image.size


# ---------------------------------------------------------------------------------------------------------------------------- documents
def description_of(profile: Optional[Mapping[str, Any]]) -> Optional[dict]:
    if not profile:
        return None
    return {"grain": profile.get("grain_or_pattern_description"), "patternScale": profile.get("pattern_scale"), "colour": profile.get("color_palette_description"),
            "specular": profile.get("specular_behavior"), "feel": profile.get("micro_surface_feel"), "keywords": list(profile.get("search_keywords") or [])}


def _text(value: Any) -> Optional[str]:
    return None if value is None or value == "" else str(value)


def build_item_doc(catalogue: str, item: BundleItem, *, release_id: str, job_id: Optional[str], now_ms: int, crop: Mapping[str, Any], thumb: Mapping[str, Any]) -> dict:
    """The item document of ARCHITECTURE.md 4.4. Nothing is invented: product identity is whatever the PDF's text layer gave (or null)."""
    caption = item.caption if item.caption and item.caption.get("status") == "ok" and item.caption.get("profile") else None
    profile = caption["profile"] if caption else None
    product_id = _text(item.product_id)
    color = item.color or {}
    return {
        "_id": f"{catalogue}|{item.item_id}", "catalogue": catalogue, "itemId": item.item_id, "status": "ok", "label": None,
        "productId": product_id, "productIdSource": "pdf-text" if product_id else None,
        "subtype": _text(profile.get("material_subtype")) if profile else None, "category": _text(profile.get("material_category")) if profile else None,
        "finish": _text(profile.get("surface_finish")) if profile else None, "description": description_of(profile),
        "dominantHex": list(color.get("dominant_hex") or []), "proportions": [float(x) for x in (color.get("proportions") or [])],
        "captionModel": _text(caption.get("model")) if caption else None, "captionVersion": _text(caption.get("version")) if caption else None,
        "source": {"name": item.source_name, "sha256": item.pdf_sha256, "page": item.page_number, "itemIndex": item.item_index, "bbox": item.image_bbox,
                   "idBbox": item.id_bbox, "pageWidth": item.page_width, "pageHeight": item.page_height, "rotation": item.original_rotation,
                   "method": item.extraction_method, "matchType": item.match_type, "matchRelation": item.match_relation, "matchCost": item.match_cost,
                   "inpainted": bool(item.inpainted), "pdfProductId": product_id},
        "images": {"crop": {"key": crop["key"], "width": crop["width"], "height": crop["height"], "sha256": item.sha256, "bytes": crop["bytes"]},
                   "thumb": {"key": thumb["key"], "width": thumb["width"], "height": thumb["height"], "bytes": thumb["bytes"]}},
        "attributes": {}, "releaseFirst": release_id, "jobId": job_id, "createdAt": now_ms, "updatedAt": now_ms,
    }


def release_item_entry(item: BundleItem) -> dict:
    caption = item.caption if item.caption and item.caption.get("status") == "ok" and item.caption.get("profile") else None
    profile = caption["profile"] if caption else {}
    color = item.color or {}
    return item_entry(item.item_id, product_id=_text(item.product_id), page=item.page_number, pdf_sha256=item.pdf_sha256, category=_text(profile.get("material_category")),
                      finish=_text(profile.get("surface_finish")), dominant_hex=color.get("dominant_hex") or [], proportions=color.get("proportions") or [])


# ------------------------------------------------------------------------------------------------------------------------------- the plan
@dataclass
class _ObjectPlan:
    key: str
    path: Path
    content_type: str
    action: str                 # "upload" | "skip" | "replace"


@dataclass
class _ItemPlan:
    item: BundleItem
    doc: dict
    crop: _ObjectPlan
    thumb_key: str
    thumb_bytes: bytes
    thumb_action: str
    doc_action: str             # "add" | "change" | "same"


def _count(plans: Sequence[Any], action: str) -> int:
    return sum(1 for plan in plans if plan.action == action)


def _plural(count: int, singular: str, plural: Optional[str] = None) -> str:
    return f"{count} {singular if count == 1 else (plural or singular + 's')}"


def _store_matches(store, key: str, *, size: int, md5_hex: str) -> bool:
    """Does the object already in the store hold exactly these bytes? Size first, then the store's own MD5 (no download); without an MD5, a download."""
    stored_size = store.size(key)
    if stored_size is None or stored_size != size:
        return False
    stored_md5 = store.md5_hex(key) if hasattr(store, "md5_hex") else None
    if stored_md5 is not None:
        return stored_md5 == md5_hex
    return md5_hex_of_bytes(store.get_bytes(key)) == md5_hex


def _emit(progress: Optional[Progress], stage: str, done: int, total: int, message: str) -> None:
    if progress is not None:
        progress(stage, done, total, message)


# ------------------------------------------------------------------------------------------------------------------------------- publish
def publish_bundle(bundle_dir, *, catalogue: str, store, db, cfg, job_id: Optional[str] = None, source_files: Optional[Mapping[str, Any]] = None,
                   activate: bool = False, dry_run: bool = False, progress: Optional[Progress] = None, created_by: str = "ingest") -> PublishResult:
    """See the module docstring. Raises PublishError before writing anything if the bundle, the arguments or the catalogue are not in order."""
    from .config import check_feature_versions

    problems: List[str] = []
    warnings: List[str] = []
    now_ms = CLOCK()

    # ------------------------------------------------------------------------------------------------------------------ 1 CHECK
    try:
        check_catalogue_id(catalogue)
    except CatalogueDbError as error:
        problems.append(str(error))
    if created_by not in CREATED_BY:
        problems.append(f"created_by must be one of {list(CREATED_BY)}, got {created_by!r}.")
    if job_id is not None and not _JOB_ID.match(str(job_id)):
        problems.append(f"{job_id!r} cannot be a job id: it becomes part of a storage name, so use letters, digits, '.', '_' and '-' only.")
    if problems:
        raise PublishError(problems)
    catalogue_doc = db.get_catalogue(catalogue)
    if catalogue_doc is None:
        raise PublishError([f"The catalogue {catalogue!r} does not exist. Create it first (for example: catalogues create --id {catalogue} --name \"...\"); "
                            "nothing is created by a publish so that a mistyped id cannot start a new catalogue."])
    _emit(progress, "publish", 0, 1, "Checking the bundle")
    try:
        bundle = Bundle(bundle_dir)
    except BundleError as error:
        raise PublishError([str(error)]) from None
    with bundle:
        found = bundle.verify(cfg)
        problems.extend(problem.message for problem in errors_of(found))
        warnings.extend(problem.message for problem in warnings_of(found))
        try:
            bundle_versions = bundle.feature_versions()
        except BundleError as error:
            bundle_versions = {}
            if not any("cannot mix feature versions" in problem for problem in problems):
                problems.append(str(error))
        bundle_versions = {pillar: version for pillar, version in bundle_versions.items() if pillar in KNOWN_PIPELINE_PILLARS}
        for version_problem in check_feature_versions(bundle_versions, cfg):
            (problems if version_problem.level == "error" else warnings).append(version_problem.message)
        items = list(bundle.items())
        pdf_names = {pdf["sha256"]: pdf["name"] for pdf in bundle.pdfs()}
        for item in items:
            pdf_names.setdefault(item.pdf_sha256, item.source_name)
        source_plan = _check_sources(source_files, {item.pdf_sha256 for item in items}, pdf_names, problems, warnings)
        publishable = [item for item in items if item.is_searchable]
        dropped = [item.item_id for item in items if not item.is_searchable]
        if items and not publishable and not any(p for p in problems):
            problems.append("None of the items has a dino, siglip or colour vector, so nothing in this bundle can be searched.")
        if dropped:
            shown = ", ".join(dropped[:3]) + (f" and {len(dropped) - 3} more" if len(dropped) > 3 else "")
            warnings.append(f"{_plural(len(dropped), 'item')} left out because {'it has' if len(dropped) == 1 else 'they have'} no dino, siglip or colour vector, so "
                            f"{'it' if len(dropped) == 1 else 'they'} cannot be searched ({shown}).")

        # ---------------------------------------------------------------------------------------------------------- parent release
        parent, parent_id = _read_parent(catalogue, catalogue_doc, store, db, problems)
        if parent is not None:
            for pillar, version in sorted(bundle_versions.items()):
                have = parent.feature_versions.get(pillar)
                if have is not None and have != version:
                    problems.append(f"A catalogue never mixes vector versions. The current release ({parent.release_id}) has '{pillar}' vectors made as {have!r}, "
                                    f"this bundle's were made as {version!r}. Publish it as a new catalogue, or recompute the whole catalogue with one version.")
        if problems:
            raise PublishError(problems, warnings)

        # ------------------------------------------------------------------------------------------------------------------ 2 PLAN
        _emit(progress, "publish", 0, 1, "Preparing thumbnails and documents")
        job_label = job_id or manual_job_id(now_ms)
        tentative_id = new_release_id(now_ms)
        bundle_items = {item.item_id: release_item_entry(item) for item in publishable}
        wanted_pillars = [pillar for pillar in KNOWN_PIPELINE_PILLARS if pillar in bundle_versions]
        searchable_ids = {item.item_id for item in publishable}
        bundle_vectors = {pillar: {item_id: np.asarray(vector, dtype=np.float16) for item_id, vector in bundle.vectors(pillar) if item_id in searchable_ids}
                          for pillar in wanted_pillars}
        built = build_release(catalogue=catalogue, release_id=tentative_id, created_at=now_ms, parent=parent, job_id=job_id, bundle_items=bundle_items,
                              bundle_vectors=bundle_vectors, bundle_versions=bundle_versions, package_version=__version__)
        reused_id = _find_identical_release(catalogue, built, parent, parent_id, store, db, warnings)
        release_id = reused_id or tentative_id
        previous_ids = set(parent.items) if parent else set()
        existing_docs = db.get_items(catalogue, [item.item_id for item in publishable])
        present_crops, present_thumbs = set(store.list(f"crops/{catalogue}/")), set(store.list(f"thumbs/{catalogue}/"))
        plans = _plan_items(catalogue, publishable, release_id=release_id, job_id=job_id, now_ms=now_ms, store=store, existing_docs=existing_docs,
                            present_crops=present_crops, present_thumbs=present_thumbs, progress=progress)
        sources = _plan_sources(source_plan, store)
        n_new = sum(1 for item in publishable if item.item_id not in previous_ids)
        n_changed = _count_changed(publishable, bundle_items, bundle_vectors, parent)
        n_unchanged = len(publishable) - n_new - n_changed
        replaced_crops = [plan.item.item_id for plan in plans if plan.crop.action == "replace"]
        if replaced_crops:
            warnings.append(f"{_plural(len(replaced_crops), 'crop image')} already in the store under the same name had different content and "
                            f"{'is' if len(replaced_crops) == 1 else 'are'} replaced ({', '.join(replaced_crops[:3])}{' ...' if len(replaced_crops) > 3 else ''}). "
                            "The live site shows the new picture straight away, while the live release still holds the vectors of the old one until you activate the new release.")
        if built.lost:
            for pillar, ids in sorted(built.lost.items()):
                warnings.append(f"{_plural(len(ids), 'item')} had a '{pillar}' vector in the previous release but the bundle has none for {'it' if len(ids) == 1 else 'them'}: "
                                f"the new release has no '{pillar}' signal for {'it' if len(ids) == 1 else 'them'} ({', '.join(ids[:3])}{' ...' if len(ids) > 3 else ''}).")
        docs_to_write = [plan.doc for plan in plans if plan.doc_action != "same"]
        already_active = catalogue_doc.get("activeRelease") == release_id
        object_writes = (_count([p.crop for p in plans], "upload") + _count([p.crop for p in plans], "replace")
                         + sum(1 for p in plans if p.thumb_action != "skip") + sum(1 for s in sources if s.action != "skip"))
        pointer_change = bool(activate and not already_active)
        needs_snapshot = bool(object_writes or docs_to_write or not reused_id)       # flipping the pointer to an existing release writes no new files
        nothing_to_do = bool(reused_id and not docs_to_write and object_writes == 0 and not pointer_change)

        if reused_id:                      # nothing new is made: this bundle adds nothing to the release that already holds exactly this content
            n_new, n_changed, n_unchanged = 0, 0, len(publishable)
        result = PublishResult(release_id=None if (dry_run and not reused_id) else release_id, n_items=built.n_items, n_new=n_new, activated=False, warnings=warnings,
                               dry_run=dry_run, parent_release=parent_id, n_changed=n_changed, n_unchanged=n_unchanged, n_bundle_items=len(publishable),
                               n_dropped=len(dropped), release_reused=bool(reused_id), nothing_to_do=nothing_to_do)
        result.details = {
            "state_key": f"bundles/{catalogue}/{job_label}/state.sqlite", "dropped_items": dropped, "release_reused_from": reused_id, "bundle_pillars": wanted_pillars,
            "crops_uploaded": _count([p.crop for p in plans], "upload"), "crops_replaced": len(replaced_crops), "crops_present": _count([p.crop for p in plans], "skip"),
            "thumbs_uploaded": sum(1 for p in plans if p.thumb_action == "upload"), "thumbs_replaced": sum(1 for p in plans if p.thumb_action == "replace"),
            "thumbs_present": sum(1 for p in plans if p.thumb_action == "skip"), "sources_uploaded": sum(1 for s in sources if s.action != "skip"),
            "sources_present": sum(1 for s in sources if s.action == "skip"), "docs_added": sum(1 for p in plans if p.doc_action == "add"),
            "docs_changed": sum(1 for p in plans if p.doc_action == "change"), "docs_unchanged": sum(1 for p in plans if p.doc_action == "same"),
            "pillars": built.pillar_summary, "feature_versions": built.feature_versions, "would_create_release": not reused_id,
        }
        result.report = _describe_plan(result, built, parent, dry_run=dry_run)

        # ----------------------------------------------------------------------------------------------------- dry run / nothing to do
        if dry_run:
            return result
        if nothing_to_do:
            result.report.append("Nothing was written: this bundle is already published exactly as it is.")
            return result

        # ------------------------------------------------------------------------------------------------------------------ 3 WRITE
        stage = "publish"
        try:
            steps = object_writes + (1 if needs_snapshot else 0) + (1 if docs_to_write else 0)
            done = 0
            for source in sources:
                if source.action != "skip":
                    store.put_file(source.key, source.path, source.content_type, if_absent=source.action == "upload")
                    done += 1
                    _emit(progress, "publish", done, steps, f"Stored the original file {source.path.name}")
            for index, plan in enumerate(plans, start=1):
                if plan.crop.action != "skip":
                    store.put_file(plan.crop.key, plan.crop.path, plan.crop.content_type, if_absent=plan.crop.action == "upload")
                    done += 1
                if plan.thumb_action != "skip":
                    store.put_bytes(plan.thumb_key, plan.thumb_bytes, "image/jpeg", if_absent=plan.thumb_action == "upload")
                    done += 1
                _verify_stored(store, plan)
                if index % 10 == 0 or index == len(plans):
                    _emit(progress, "publish", done, steps, f"Stored pictures for {index} of {len(plans)} items")
            if needs_snapshot:
                with tempfile.TemporaryDirectory(prefix="terucon-snapshot-") as folder:
                    snapshot = bundle.snapshot_to(Path(folder) / "state.sqlite")
                    store.put_file(result.details["state_key"], snapshot, "application/vnd.sqlite3", if_absent=False)  # a resumable checkpoint: overwritten, not if_absent
                done += 1
                _emit(progress, "publish", done, steps, "Stored a copy of the compute state")
            if docs_to_write:
                db.upsert_items(catalogue, docs_to_write)
                done += 1
                _emit(progress, "publish", done, steps, f"Saved {_plural(len(docs_to_write), 'item document')}")
            stage = "release"
            if not reused_id:
                total = len(built.files) + 3
                _emit(progress, "release", 0, total, f"Writing release {release_id}")
                write_release(store, built, on_file=lambda position, _total, name: _emit(progress, "release", position, total, f"Wrote {name}"))
                db.insert_release(_release_doc(catalogue, built, created_by=created_by, job_id=job_id, now_ms=now_ms, parent_id=parent_id))
                _emit(progress, "release", total - 1, total, "Registered the release")
            if pointer_change:
                stage = "activate"
                counts = {"items": db.count_items(catalogue), "hidden": db.count_items(catalogue, "hidden")}      # items = all of them; the website shows items - hidden
                db.set_active_release(catalogue, release_id, feature_versions=dict(built.feature_versions), counts=counts)
                result.activated = True
            _emit(progress, "release", 1, 1, "Done")
        except BaseException as error:
            if hasattr(error, "add_note"):
                if stage == "activate":
                    error.add_note("The release is stored, but switching the catalogue to it did not complete. Check which release is live with: releases --catalogue "
                                   f"{catalogue}; run the same command again to finish.")
                else:
                    error.add_note(f"The publish stopped during its '{stage}' stage. The live release was not changed; run the same command again to finish.")
            raise
        result.report.extend(_describe_done(result, built, docs_to_write, reused_id))
        return result


# ------------------------------------------------------------------------------------------------------------------------------- helpers
_SHA256 = re.compile(r"^[0-9a-f]{64}$")


def _check_sources(source_files: Optional[Mapping[str, Any]], known: set, names: Mapping[str, str], problems: List[str], warnings: List[str]) -> List[Tuple[str, Path, str]]:
    """The original files to keep. The mapping is sha256 -> path; a key that is not a sha256 (for example the file name, which the ingest job passes) is
    accepted too, and the sha256 is taken from the file itself. Every file is hashed and must be one of the PDFs the bundle was made from."""
    plan: Dict[str, Tuple[str, Path, str]] = {}
    for key, location in dict(source_files or {}).items():
        path = Path(location)
        if not path.is_file():
            problems.append(f"The original file {str(path)!r} was given as a source but it is not a file.")
            continue
        actual = sha256_of_file(path)
        claimed = str(key).lower()
        if _SHA256.match(claimed) and claimed != actual:
            problems.append(f"The file {path.name!r} does not have the sha256 it was given under ({claimed[:12]}...): it changed or the wrong file was passed.")
        elif actual not in known:
            problems.append(f"The file {path.name!r} (sha256 {actual[:12]}...) is not one of the PDFs this bundle was made from "
                            f"({', '.join(sorted(k[:12] + '...' for k in known)) or 'none recorded'}); the bundle's items name a different file.")
        else:
            plan[actual] = (actual, path, names.get(actual, path.name))
    missing = sorted(known - set(plan))
    if missing and not problems:
        label = ", ".join(f"{names.get(sha, sha[:12])}" for sha in missing)
        warnings.append(f"The original PDF is not being stored ({label}); the catalogue works without it, but re-rendering a crop from its source page will not be possible. "
                        "Pass it with --source-pdf to keep it.")
    return list(plan.values())

def _read_parent(catalogue: str, catalogue_doc: Mapping[str, Any], store, db, problems: List[str]) -> Tuple[Optional[ReleaseData], Optional[str]]:
    parent_id = catalogue_doc.get("activeRelease")
    if parent_id is None:
        newest = db.list_releases(catalogue, limit=1)
        parent_id = newest[0]["_id"] if newest else None
    if parent_id is None:
        return None, None
    if not is_release_id(parent_id):
        problems.append(f"The catalogue points at {parent_id!r}, which is not a release id.")
        return None, parent_id
    try:
        return read_release(store, catalogue, parent_id), parent_id
    except ReleaseReadError as error:
        problems.append(f"The catalogue's current release cannot be used as the base of a new one: {error} Nothing was changed; repair or re-activate an older release first.")
        return None, parent_id


def _find_identical_release(catalogue: str, built: BuiltRelease, parent: Optional[ReleaseData], parent_id: Optional[str], store, db, warnings: List[str]) -> Optional[str]:
    """The id of an existing release that already holds exactly this content: the parent, or an earlier attempt that had the same parent."""
    fingerprint = built.content_fingerprint()
    if parent is not None and content_fingerprint(parent.manifest) == fingerprint:
        return parent.release_id
    for record in db.list_releases(catalogue, limit=20):
        if record["_id"] == parent_id or record.get("parent") != parent_id:
            continue
        try:
            manifest, _ = read_manifest(store, catalogue, record["_id"])
        except ReleaseReadError as error:
            warnings.append(f"The release record {record['_id']} was skipped when looking for an earlier attempt: {error}")
            continue
        if content_fingerprint(manifest) == fingerprint:
            return record["_id"]
    return None


def _count_changed(publishable: Sequence[BundleItem], bundle_items: Mapping[str, dict], bundle_vectors: Mapping[str, Mapping[str, np.ndarray]], parent: Optional[ReleaseData]) -> int:
    """Items in both the parent release and the bundle whose entry or vectors differ."""
    if parent is None:
        return 0
    parent_rows = {name: {item_id: matrix[position] for position, item_id in enumerate(ids)} for name, (ids, matrix) in parent.pillars.items()}
    changed = 0
    for item in publishable:
        if item.item_id not in parent.items:
            continue
        if parent.items[item.item_id] != bundle_items[item.item_id]:
            changed += 1
            continue
        names = set(parent_rows) | set(bundle_vectors)
        if any(not _same_row(parent_rows.get(name, {}).get(item.item_id), bundle_vectors.get(name, {}).get(item.item_id)) for name in names):
            changed += 1
    return changed


def _same_row(first: Optional[np.ndarray], second: Optional[np.ndarray]) -> bool:
    if first is None or second is None:
        return first is None and second is None
    return first.shape == second.shape and np.array_equal(first, second)


def _plan_items(catalogue: str, publishable: Sequence[BundleItem], *, release_id: str, job_id: Optional[str], now_ms: int, store, existing_docs: Mapping[str, dict],
                present_crops: set, present_thumbs: set, progress: Optional[Progress]) -> List[_ItemPlan]:
    plans: List[_ItemPlan] = []
    for index, item in enumerate(publishable, start=1):
        crop_path = item.crop_path
        crop_key = f"crops/{catalogue}/{item.item_id}{item.crop_suffix}"
        thumb_key = f"thumbs/{catalogue}/{item.item_id}.jpg"
        crop_size = crop_path.stat().st_size
        width, height = (item.crop_width, item.crop_height) if item.crop_width and item.crop_height else _image_size(crop_path)
        thumb_bytes, thumb_w, thumb_h = make_thumbnail(crop_path)
        if crop_key in present_crops:
            same = _store_matches(store, crop_key, size=crop_size, md5_hex=md5_hex_of_file(crop_path))
            crop_action = "skip" if same else "replace"
        else:
            crop_action = "upload"
        if thumb_key not in present_thumbs:
            thumb_action = "upload"
        elif crop_action == "replace" or store.size(thumb_key) != len(thumb_bytes):
            thumb_action = "replace"
        else:
            thumb_action = "skip"
        doc = build_item_doc(catalogue, item, release_id=release_id, job_id=job_id, now_ms=now_ms,
                             crop={"key": crop_key, "width": int(width), "height": int(height), "bytes": crop_size},
                             thumb={"key": thumb_key, "width": thumb_w, "height": thumb_h, "bytes": len(thumb_bytes)})
        old = existing_docs.get(item.item_id)
        owned_by_publisher = old is None or old.get("productIdSource") != "admin"          # an admin's product id is not ours to compare or overwrite
        doc_action = "add" if old is None else ("same" if publisher_view(old, with_product=owned_by_publisher) == publisher_view(doc, with_product=owned_by_publisher) else "change")
        plans.append(_ItemPlan(item, doc, _ObjectPlan(crop_key, crop_path, key_to_content_type(crop_key), crop_action), thumb_key, thumb_bytes, thumb_action, doc_action))
        if index % 20 == 0:
            _emit(progress, "publish", 0, 1, f"Prepared {index} of {len(publishable)} items")
    return plans


def _plan_sources(source_plan: Sequence[Tuple[str, Path, str]], store) -> List[_ObjectPlan]:
    plans = []
    for sha, path, name in source_plan:
        key = source_key(sha, name)
        stored = store.size(key)
        action = "upload" if stored is None else ("skip" if stored == path.stat().st_size else "replace")
        plans.append(_ObjectPlan(key, path, key_to_content_type(key), action))
    return plans


def _verify_stored(store, plan: _ItemPlan) -> None:
    """After a picture is written: the store must hold what the document is about to claim (the size, and the MD5 of a crop when the store can say)."""
    if plan.crop.action != "skip":
        size = plan.doc["images"]["crop"]["bytes"]
        stored = store.size(plan.crop.key)
        if stored != size:
            raise RuntimeError(f"{plan.crop.key} was written but the store holds {stored} bytes instead of {size}; not continuing.")
        stored_md5 = store.md5_hex(plan.crop.key) if hasattr(store, "md5_hex") else None
        if stored_md5 is not None and stored_md5 != md5_hex_of_file(plan.crop.path):
            raise RuntimeError(f"{plan.crop.key} is in the store but its content differs from the file that was uploaded; not continuing.")
    if plan.thumb_action != "skip":
        stored = store.size(plan.thumb_key)
        if stored != len(plan.thumb_bytes):
            raise RuntimeError(f"{plan.thumb_key} was written but the store holds {stored} bytes instead of {len(plan.thumb_bytes)}; not continuing.")

def _release_doc(catalogue: str, built: BuiltRelease, *, created_by: str, job_id: Optional[str], now_ms: int, parent_id: Optional[str]) -> dict:
    return {"_id": built.release_id, "catalogue": catalogue, "createdAt": now_ms, "createdBy": created_by, "jobId": job_id, "parent": parent_id, "nItems": built.n_items,
            "featureVersions": dict(built.feature_versions), "pillars": {name: dict(summary) for name, summary in built.pillar_summary.items()},
            "gcsPrefix": release_prefix(catalogue, built.release_id), "manifestSha256": built.manifest_sha256}


def _describe_plan(result: PublishResult, built: BuiltRelease, parent: Optional[ReleaseData], *, dry_run: bool) -> List[str]:
    d = result.details
    lines = []
    verb = "would" if dry_run else "will"
    lines.append(f"The bundle holds {_plural(result.n_bundle_items, 'searchable item')}"
                 + (f" ({result.n_dropped} more cannot be searched and {verb} be left out)" if result.n_dropped else "") + ".")
    if parent is None:
        lines.append("The catalogue has no release yet, so this will be its first.")
    else:
        lines.append(f"It is built on the catalogue's current release {parent.release_id} ({_plural(int(parent.manifest['nItems']), 'item')}): "
                     f"{result.n_new} new, {result.n_changed} changed, {result.n_unchanged} unchanged.")
    lines.append(f"Pictures: {d['crops_uploaded']} crops and {d['thumbs_uploaded']} thumbnails {verb} be uploaded, {d['crops_present']} crops are already there"
                 + (f", {d['crops_replaced']} crops with different content {verb} be replaced" if d["crops_replaced"] else "") + ".")
    lines.append(f"Item documents: {d['docs_added']} {verb} be added, {d['docs_changed']} updated (labels and other admin edits are kept), {d['docs_unchanged']} are already right.")
    if result.release_reused:
        lines.append(f"A release with exactly this content already exists ({result.release_id}); no new release {verb} be made.")
    else:
        lines.append(f"A new release {verb} be written: {_plural(built.n_items, 'item')}, vectors for {', '.join(sorted(built.pillar_summary)) or 'no pillar'}.")
    return lines


def _describe_done(result: PublishResult, built: BuiltRelease, docs_written: Sequence[dict], reused_id: Optional[str]) -> List[str]:
    lines = [f"Saved {_plural(len(docs_written), 'item document')}." if docs_written else "No item document needed changing."]
    lines.append(f"Release {result.release_id} {'already existed and is reused' if reused_id else 'was written'} ({_plural(result.n_items, 'item')}).")
    lines.append("It is now the live release." if result.activated else "It is NOT live yet: activate it when you have checked it.")
    return lines


# ------------------------------------------------------------------------------------------------------------------------------ activate
def activate_release(catalogue: str, release_id: str, *, store, db) -> dict:
    """Make a release the one the website searches (also how you roll back: activate the previous one). Returns the catalogue document."""
    record = db.get_release(release_id)
    if record is None:
        raise ActivationError(f"There is no release {release_id!r}. List them with: releases --catalogue {catalogue}")
    if record.get("catalogue") != catalogue:
        raise ActivationError(f"Release {release_id} belongs to the catalogue {record.get('catalogue')!r}, not {catalogue!r}.")
    if not record.get("pillars"):
        raise ActivationError(f"Release {release_id} has no vectors, so it could not answer a search.")
    try:
        manifest, raw = read_manifest(store, catalogue, release_id)
    except ReleaseReadError as error:
        raise ActivationError(str(error)) from None
    from .release_writer import sha256_hex

    if sha256_hex(raw) != record.get("manifestSha256"):
        raise ActivationError(f"Release {release_id}: the manifest in the store is not the one that was registered (sha256 differs). Not activating.")
    counts = {"items": db.count_items(catalogue), "hidden": db.count_items(catalogue, "hidden")}      # items = all of them; the website shows items - hidden
    return db.set_active_release(catalogue, release_id, feature_versions=dict(record["featureVersions"]), counts=counts)
