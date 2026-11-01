"""Read a published catalogue release through the object store, verify it, and keep a read-through copy on disk.

This is the READ side of ARCHITECTURE.md section 4.3. A release is immutable:

    releases/<catalogue>/<releaseId>/manifest.json
    releases/<catalogue>/<releaseId>/items.json
    releases/<catalogue>/<releaseId>/pillars/<pillar>.npy        float16, shape (n, dim), rows L2-normalised
    releases/<catalogue>/<releaseId>/pillars/<pillar>.ids.json   the itemIds of those rows

`load_release` downloads what it needs into `cache_dir/<catalogue>/<releaseId>/` (a temp directory first, then one atomic rename), verifies
every sha256 against the manifest, checks row counts and dimensions, checks the feature versions against the running encoder
(`config.check_feature_versions`) and returns float32 matrices re-normalised exactly like the notebook's `StateStore.fetch_embeddings`.
A cache directory that is complete and whose files still match the manifest is reused without touching the store.

Typed errors (ServiceError and subclasses) carry `.status` (HTTP), `.reason` (a slug) and `.retry_after`. They live here, the lowest layer
both search.py and service.py import, so that every module in the search side raises the same kind of object; http_app.py turns them into
the JSON error body of ARCHITECTURE.md section 6.

No import-time side effects. The sha256 helper, the row normaliser and the version check are the foundation modules' own.
"""
from __future__ import annotations

import json
import logging
import os
import re
import shutil
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, List, Mapping, Optional

import numpy as np

from .config import check_feature_versions, compute_feature_versions, version_errors
from .util import l2_normalize_rows, sha256_file

LOGGER = logging.getLogger("catalogue.release")

# ------------------------------------------------------------------------------------------------------------------------
# identifiers (ARCHITECTURE.md 4.1). fullmatch + explicit ASCII ranges: no trailing-newline or Unicode-digit surprises, and they are the
# only things that ever become part of a file path or an object key.
# ------------------------------------------------------------------------------------------------------------------------
CATALOGUE_ID_RE = re.compile(r"[a-z0-9][a-z0-9-]{1,38}")
RELEASE_ID_RE = re.compile(r"rel-[0-9]{14}-[0-9a-f]{6}")
JOB_ID_RE = re.compile(r"job-[0-9]{14}-[0-9a-f]{6}")
_PILLAR_NAME_RE = re.compile(r"[a-z][a-z0-9_]{0,30}")
_SHA256_RE = re.compile(r"[0-9a-f]{64}")


def is_catalogue_id(value: Any) -> bool:
    return isinstance(value, str) and CATALOGUE_ID_RE.fullmatch(value) is not None


def is_release_id(value: Any) -> bool:
    return isinstance(value, str) and RELEASE_ID_RE.fullmatch(value) is not None


def is_job_id(value: Any) -> bool:
    return isinstance(value, str) and JOB_ID_RE.fullmatch(value) is not None


# ------------------------------------------------------------------------------------------------------------------------
# typed errors
# ------------------------------------------------------------------------------------------------------------------------
class ServiceError(Exception):
    """Base of every error the search / ingest side raises on purpose: `.status` (HTTP), `.reason` (slug), `.retry_after` (seconds or None)."""

    status = 500
    reason = "internal"

    def __init__(self, message: str = "", *, reason: Optional[str] = None, status: Optional[int] = None,
                 retry_after: Optional[float] = None):
        super().__init__(message)
        self.message = message
        if reason is not None:
            self.reason = reason
        if status is not None:
            self.status = status
        self.retry_after = retry_after


class BadRequestError(ServiceError):
    status = 400
    reason = "bad-request"


class ReleaseError(ServiceError):
    status = 409
    reason = "release-error"


class ReleaseMissingError(ReleaseError):
    """The release (or its manifest) is not in the object store."""
    reason = "release-missing"


class ReleaseCorruptError(ReleaseError):
    """A file is missing, has the wrong sha256 / size / shape, or the manifest is not what section 4.3 says."""
    reason = "release-corrupt"


class FeatureVersionMismatchError(ReleaseError):
    """The release's vectors were made another way than this encoder makes them (config.check_feature_versions found an error)."""
    reason = "feature-version-mismatch"

    def __init__(self, message: str = "", *, problems: Optional[list] = None, **kwargs):
        super().__init__(message, **kwargs)
        self.problems = list(problems or [])


class StoreUnavailableError(ServiceError):
    """The object store could not be read (network, permissions): worth retrying, nothing is wrong with the release."""
    status = 503
    reason = "store-unavailable"


# ------------------------------------------------------------------------------------------------------------------------
# the loaded release
# ------------------------------------------------------------------------------------------------------------------------
@dataclass
class PillarMatrix:
    """One pillar's vectors: `matrix[i]` belongs to item `ids[i]`; float32 and L2-normalised (see load_release)."""
    ids: List[str]
    matrix: np.ndarray
    version: Optional[str] = None
    _row_of: Optional[Dict[str, int]] = field(default=None, repr=False, compare=False)

    @property
    def dim(self) -> int:
        return int(self.matrix.shape[1]) if self.matrix.ndim == 2 else 0

    def __len__(self) -> int:
        return len(self.ids)

    def row_of(self) -> Dict[str, int]:
        if self._row_of is None:
            self._row_of = {item_id: row for row, item_id in enumerate(self.ids)}
        return self._row_of


@dataclass
class LoadedRelease:
    manifest: dict
    items: List[dict]
    pillars: Dict[str, PillarMatrix]
    warnings: List[str] = field(default_factory=list)
    path: Optional[Path] = None
    source: str = "download"          # "download" (read from the object store just now) | "cache" (reused from cache_dir)
    expected_versions: Dict[str, str] = field(default_factory=dict)

    @property
    def release_id(self) -> str:
        return str(self.manifest.get("releaseId"))

    @property
    def catalogue(self) -> str:
        return str(self.manifest.get("catalogue"))

    @property
    def feature_versions(self) -> Dict[str, str]:
        return dict(self.manifest.get("featureVersions") or {})

    @property
    def n_items(self) -> int:
        return len(self.items)


# ------------------------------------------------------------------------------------------------------------------------
# manifest / items / pillar validation
# ------------------------------------------------------------------------------------------------------------------------
_MAX_PILLAR_DIM = 16384
_MAX_PILLAR_ROWS = 10_000_000
_NPY_HEADER_ALLOWANCE = 4096
_MAX_JSON_BYTES = 256 * 1024 * 1024
_MAX_MANIFEST_BYTES = 8 * 1024 * 1024
_ROW_CHUNK = 8192


def _corrupt(message: str) -> ReleaseCorruptError:
    return ReleaseCorruptError(message)


def _int_field(container: Mapping[str, Any], name: str, where: str, minimum: int = 0) -> int:
    value = container.get(name)
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        raise _corrupt(f"{where}: '{name}' must be a whole number >= {minimum}, got {value!r}.")
    return value


def _sha_field(container: Mapping[str, Any], name: str, where: str) -> str:
    value = container.get(name)
    if not isinstance(value, str) or _SHA256_RE.fullmatch(value.lower()) is None:
        raise _corrupt(f"{where}: '{name}' is not a sha256 hex digest.")
    return value.lower()


def parse_manifest(raw: bytes, catalogue: str, release_id: str) -> dict:
    """manifest.json bytes -> the manifest dict, after the structural checks of ARCHITECTURE.md 4.3 (raises ReleaseCorruptError)."""
    try:
        manifest = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as exc:
        raise _corrupt("manifest.json is not valid JSON.") from exc
    if not isinstance(manifest, dict):
        raise _corrupt("manifest.json is not a JSON object.")
    if manifest.get("schema") != 1:
        raise _corrupt(f"manifest.json has schema {manifest.get('schema')!r}; this reader understands schema 1.")
    if manifest.get("releaseId") != release_id:
        raise _corrupt(f"manifest.json belongs to release {manifest.get('releaseId')!r}, not {release_id!r}.")
    if manifest.get("catalogue") != catalogue:
        raise _corrupt(f"manifest.json belongs to catalogue {manifest.get('catalogue')!r}, not {catalogue!r}.")
    _int_field(manifest, "nItems", "manifest")
    versions = manifest.get("featureVersions")
    if not isinstance(versions, dict) or not all(isinstance(k, str) and isinstance(v, str) for k, v in versions.items()):
        raise _corrupt("manifest.json: 'featureVersions' must map pillar names to version strings.")
    if manifest.get("itemsFile") != "items.json":
        raise _corrupt(f"manifest.json: 'itemsFile' must be 'items.json', got {manifest.get('itemsFile')!r}.")
    _sha_field(manifest, "itemsSha256", "manifest")
    pillars = manifest.get("pillars")
    if not isinstance(pillars, dict):
        raise _corrupt("manifest.json: 'pillars' must be an object.")
    for name, entry in pillars.items():
        where = f"manifest pillar '{name}'"
        if not isinstance(name, str) or _PILLAR_NAME_RE.fullmatch(name) is None:
            raise _corrupt(f"manifest.json: {name!r} is not a usable pillar name.")
        if not isinstance(entry, dict):
            raise _corrupt(f"{where} is not an object.")
        count = _int_field(entry, "count", where)
        dim = _int_field(entry, "dim", where, minimum=1)
        if count > _MAX_PILLAR_ROWS or dim > _MAX_PILLAR_DIM:
            raise _corrupt(f"{where}: {count} x {dim} is outside the sizes this reader accepts.")
        if entry.get("dtype") != "float16":
            raise _corrupt(f"{where}: dtype must be float16, got {entry.get('dtype')!r}.")
        if entry.get("file") != f"pillars/{name}.npy" or entry.get("idsFile") != f"pillars/{name}.ids.json":
            raise _corrupt(f"{where}: 'file' / 'idsFile' must be pillars/{name}.npy and pillars/{name}.ids.json.")
        _sha_field(entry, "sha256", where)
        _sha_field(entry, "idsSha256", where)
        if name not in versions:
            raise _corrupt(f"{where} has vectors but no entry in 'featureVersions'.")
    return manifest


def _expected_size(entry: Mapping[str, Any]) -> int:
    return int(entry["count"]) * int(entry["dim"]) * 2


def _files_of(manifest: Mapping[str, Any]) -> List[Dict[str, Any]]:
    """Every file of a release as {rel, sha256, max_bytes}; `manifest.json` itself is the root of trust and has no entry."""
    files = [{"rel": "items.json", "sha256": str(manifest["itemsSha256"]).lower(), "max_bytes": _MAX_JSON_BYTES}]
    for name, entry in (manifest.get("pillars") or {}).items():
        files.append({"rel": entry["file"], "sha256": str(entry["sha256"]).lower(),
                      "max_bytes": _expected_size(entry) + _NPY_HEADER_ALLOWANCE})
        files.append({"rel": entry["idsFile"], "sha256": str(entry["idsSha256"]).lower(), "max_bytes": _MAX_JSON_BYTES})
    return files


def _verify_local_files(directory: Path, manifest: Mapping[str, Any]) -> None:
    """Every file named by the manifest exists in `directory` and has the manifest's sha256 (raises ReleaseCorruptError)."""
    for entry in _files_of(manifest):
        path = directory / entry["rel"]
        if not path.is_file():
            raise _corrupt(f"{entry['rel']} is missing.")
        if sha256_file(path) != entry["sha256"]:
            raise _corrupt(f"{entry['rel']} does not match the sha256 in the manifest.")


def _read_json_list(path: Path, what: str) -> list:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise _corrupt(f"{what} is not valid JSON.") from exc
    if not isinstance(value, list):
        raise _corrupt(f"{what} is not a JSON array.")
    return value


def _load_items(directory: Path, manifest: Mapping[str, Any]) -> List[dict]:
    items = _read_json_list(directory / "items.json", "items.json")
    seen = set()
    for index, item in enumerate(items):
        if not isinstance(item, dict) or not isinstance(item.get("itemId"), str) or not item["itemId"]:
            raise _corrupt(f"items.json entry {index} has no itemId.")
        if item["itemId"] in seen:
            raise _corrupt(f"items.json lists {item['itemId']!r} twice.")
        seen.add(item["itemId"])
    if len(items) != manifest["nItems"]:
        raise _corrupt(f"items.json has {len(items)} items but the manifest says nItems={manifest['nItems']}.")
    return items


def _load_pillar(directory: Path, name: str, entry: Mapping[str, Any], version: str, item_ids: set) -> PillarMatrix:
    where = f"pillar '{name}'"
    ids = _read_json_list(directory / entry["idsFile"], f"{name}.ids.json")
    count, dim = int(entry["count"]), int(entry["dim"])
    if len(ids) != count or not all(isinstance(i, str) for i in ids):
        raise _corrupt(f"{where}: the ids file has {len(ids)} entries, the manifest says count={count}.")
    if len(set(ids)) != len(ids):
        raise _corrupt(f"{where}: the ids file lists an item twice.")
    unknown = [i for i in ids if i not in item_ids]
    if unknown:
        raise _corrupt(f"{where}: {len(unknown)} id(s) are not in items.json, e.g. {unknown[0]!r}.")
    try:
        raw = np.load(directory / entry["file"], allow_pickle=False)   # NOT memory-mapped: an open file would block Volume.reload()
    except (OSError, ValueError, EOFError) as exc:
        raise _corrupt(f"{where}: the .npy file cannot be read ({type(exc).__name__}).") from exc
    if raw.dtype != np.float16:
        raise _corrupt(f"{where}: the .npy dtype is {raw.dtype}, the manifest says float16.")
    if raw.ndim != 2 or raw.shape != (count, dim):
        raise _corrupt(f"{where}: the .npy shape is {tuple(raw.shape)}, the manifest says ({count}, {dim}).")
    # PORT: the notebook's StateStore.fetch_embeddings does `l2_normalize_rows(np.stack(float16 rows -> float32))` once over the whole matrix;
    # here the same function runs over blocks of rows (row norms are independent, tests assert the result is identical) to bound peak memory.
    matrix = np.empty((count, dim), dtype=np.float32)
    for start in range(0, count, _ROW_CHUNK):
        matrix[start:start + _ROW_CHUNK] = l2_normalize_rows(raw[start:start + _ROW_CHUNK].astype(np.float32))
    if count and not np.isfinite(matrix).all():
        raise _corrupt(f"{where}: the vectors contain NaN or infinity.")
    return PillarMatrix(ids=list(ids), matrix=np.ascontiguousarray(matrix, dtype=np.float32), version=version)


def _build(directory: Path, manifest: dict, source: str, expected_versions: Mapping[str, str], warnings: List[str]) -> LoadedRelease:
    items = _load_items(directory, manifest)
    item_ids = {item["itemId"] for item in items}
    versions = manifest["featureVersions"]
    pillars: Dict[str, PillarMatrix] = {}
    for name, entry in manifest["pillars"].items():
        if int(entry["count"]) == 0:
            warnings.append(f"pillar '{name}' lists no vectors; ignored.")
            continue
        pillars[name] = _load_pillar(directory, name, entry, versions[name], item_ids)
    return LoadedRelease(manifest=manifest, items=items, pillars=pillars, warnings=list(warnings), path=directory, source=source,
                         expected_versions=dict(expected_versions or {}))


# ------------------------------------------------------------------------------------------------------------------------
# the object store (duck-typed: the ObjectStore protocol of ARCHITECTURE.md 9)
# ------------------------------------------------------------------------------------------------------------------------
def _store_call(what: str, function: Callable, *args, **kwargs):
    try:
        return function(*args, **kwargs)
    except ServiceError:
        raise
    except (FileNotFoundError, KeyError) as exc:
        raise ReleaseMissingError(f"{what} is not in the object store.") from exc
    except Exception as exc:                                  # network, permission, quota: say what failed, not the details
        LOGGER.warning("object store call failed (%s): %s", what, type(exc).__name__)
        raise StoreUnavailableError(f"The object store could not be read ({type(exc).__name__}).", retry_after=5) from exc


def _slug_guard(catalogue: Any, release_id: Any) -> None:
    if not is_catalogue_id(catalogue):
        raise BadRequestError("catalogue is not a valid catalogue id.")
    if not is_release_id(release_id):
        raise BadRequestError("release is not a valid release id.")


def _version_check(manifest: Mapping[str, Any], cfg: Any, expected_versions: Optional[Mapping[str, str]]) -> List[str]:
    """The expected labels come from `cfg` (config.check_feature_versions). A caller-supplied `expected_versions` must agree with them."""
    ours = compute_feature_versions(cfg)
    for pillar, version in (expected_versions or {}).items():
        if pillar in ours and ours[pillar] != version:
            raise ValueError(f"expected_versions['{pillar}'] disagrees with the labels cfg produces; pass the same cfg the encoder uses.")
    problems = check_feature_versions(manifest["featureVersions"], cfg)
    errors = version_errors(problems)
    if errors:
        raise FeatureVersionMismatchError(
            "This release was made with different feature versions than this encoder: " + "; ".join(p.message for p in errors),
            problems=errors)
    return [f"{p.pillar}: {p.message}" for p in problems]


def _fresh_cache(final_dir: Path, catalogue: str, release_id: str) -> Optional[dict]:
    """The manifest of a complete, verified cache directory, or None (the caller then downloads)."""
    manifest_path = final_dir / "manifest.json"
    if not manifest_path.is_file():
        return None
    try:
        manifest = parse_manifest(manifest_path.read_bytes(), catalogue, release_id)
        _verify_local_files(final_dir, manifest)
    except (ReleaseCorruptError, OSError) as exc:
        LOGGER.warning("cached release %s/%s is not usable (%s); downloading it again", catalogue, release_id, exc)
        return None
    return manifest


def _sweep_stale(cache_root: Path, max_age_s: float = 3600.0) -> None:
    now = time.time()
    try:
        for child in cache_root.iterdir():
            if child.name.startswith(".tmp-") or child.name.startswith(".corrupt-"):
                try:
                    if now - child.stat().st_mtime > max_age_s:
                        shutil.rmtree(child, ignore_errors=True)
                except OSError:
                    pass
    except OSError:
        pass


def _download_into(store: Any, prefix: str, manifest: Mapping[str, Any], temp_dir: Path) -> None:
    for entry in _files_of(manifest):
        key = prefix + entry["rel"]
        size = _store_call(key, store.size, key)
        if size is None:
            raise _corrupt(f"{entry['rel']} is listed in the manifest but is not in the object store.")
        if size > entry["max_bytes"]:
            raise _corrupt(f"{entry['rel']} is {size} bytes, more than the manifest allows ({entry['max_bytes']}).")
        destination = temp_dir / entry["rel"]
        destination.parent.mkdir(parents=True, exist_ok=True)
        _store_call(key, store.get_file, key, destination)
        if not destination.is_file() or sha256_file(destination) != entry["sha256"]:
            raise _corrupt(f"{entry['rel']} does not match the sha256 in the manifest.")


def load_release(store: Any, catalogue: str, release_id: str, cache_dir: Any, expected_versions: Optional[Mapping[str, str]], cfg: Any, *,
                 commit_cache: Optional[Callable[[], Any]] = None, reload_cache: Optional[Callable[[], Any]] = None) -> LoadedRelease:
    """Load `releases/<catalogue>/<release_id>/` into memory, reading through `cache_dir/<catalogue>/<release_id>/`.

    Raises ReleaseMissingError (no manifest in the store), ReleaseCorruptError (a file is missing, tampered with or malformed),
    FeatureVersionMismatchError (an error-level problem from config.check_feature_versions) or StoreUnavailableError (store I/O failed).
    `reload_cache` (Modal: `volume.reload`) is called before the cache is looked at, `commit_cache` (`volume.commit`) after a download; a failure
    in either is logged and ignored, the cache is an optimisation and never the only copy.
    """
    _slug_guard(catalogue, release_id)
    cache_root = Path(cache_dir) / catalogue
    final_dir = cache_root / release_id
    prefix = f"releases/{catalogue}/{release_id}/"

    if reload_cache is not None:
        try:
            reload_cache()
        except Exception as exc:
            LOGGER.warning("cache reload hook failed (%s); continuing", type(exc).__name__)

    manifest = _fresh_cache(final_dir, catalogue, release_id)
    if manifest is not None:
        warnings = _version_check(manifest, cfg, expected_versions)
        return _build(final_dir, manifest, "cache", expected_versions or {}, warnings)

    # ---- not cached (or the cached copy is damaged): read the manifest from the store first, and refuse early on a version mismatch
    manifest_key = prefix + "manifest.json"
    manifest_size = _store_call(manifest_key, store.size, manifest_key)
    if manifest_size is None:
        raise ReleaseMissingError(f"Release {release_id} of catalogue {catalogue} has no manifest in the object store.")
    if manifest_size > _MAX_MANIFEST_BYTES:
        raise _corrupt(f"manifest.json is {manifest_size} bytes, far more than a manifest should be.")
    raw_manifest = _store_call(manifest_key, store.get_bytes, manifest_key)
    manifest = parse_manifest(raw_manifest, catalogue, release_id)
    warnings = _version_check(manifest, cfg, expected_versions)

    cache_root.mkdir(parents=True, exist_ok=True)
    _sweep_stale(cache_root)
    temp_dir = cache_root / f".tmp-{release_id}-{uuid.uuid4().hex[:8]}"
    temp_dir.mkdir(parents=True)
    try:
        (temp_dir / "manifest.json").write_bytes(raw_manifest)
        _download_into(store, prefix, manifest, temp_dir)
        loaded = _build(temp_dir, manifest, "download", expected_versions or {}, warnings)   # validates shapes before anything is cached
        _install(temp_dir, final_dir, catalogue, release_id)
    except BaseException:
        shutil.rmtree(temp_dir, ignore_errors=True)
        raise
    loaded.path = final_dir
    if commit_cache is not None:
        try:
            commit_cache()
        except Exception as exc:
            LOGGER.warning("cache commit hook failed (%s); the release is loaded but not persisted on the volume", type(exc).__name__)
    LOGGER.info("loaded release %s/%s: %d items, pillars %s", catalogue, release_id, loaded.n_items, sorted(loaded.pillars))
    return loaded


def _install(temp_dir: Path, final_dir: Path, catalogue: str, release_id: str) -> None:
    """One atomic rename temp -> final. A directory that is already there (another container won the race, or a damaged copy) is dealt with."""
    try:
        os.replace(temp_dir, final_dir)
        return
    except OSError:
        pass
    if _fresh_cache(final_dir, catalogue, release_id) is not None:      # someone else installed the same immutable release: keep theirs
        shutil.rmtree(temp_dir, ignore_errors=True)
        return
    aside = final_dir.with_name(f".corrupt-{release_id}-{uuid.uuid4().hex[:8]}")
    try:
        os.replace(final_dir, aside)
        os.replace(temp_dir, final_dir)
    except OSError as exc:
        raise StoreUnavailableError(f"The release cache directory could not be written ({type(exc).__name__}).", retry_after=5) from exc
    shutil.rmtree(aside, ignore_errors=True)
