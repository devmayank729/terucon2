"""Writing and reading a release: the immutable snapshot a search service loads (ARCHITECTURE.md 4.2 and 4.3).

    releases/<catalogue>/<releaseId>/manifest.json
    releases/<catalogue>/<releaseId>/items.json                      array sorted by itemId
    releases/<catalogue>/<releaseId>/pillars/<pillar>.npy            float16, shape (n, dim), C order, the rows exactly as the bundle stored them
    releases/<catalogue>/<releaseId>/pillars/<pillar>.ids.json       JSON array of itemIds, the row order of the .npy

Rules this module keeps, because the publisher's idempotence depends on them:
* A release is built from its parent plus a bundle: an item in the bundle REPLACES the parent's item and ALL of the parent's vectors for it (a vector
  made from an older crop must not survive next to a newer one); items only the parent has are kept as they are, byte for byte.
* Rows are float16 exactly as stored in the bundle: float16 -> float32 -> float16 is exact, and nothing is renormalised.
* Rows are ordered by itemId, JSON is written in one canonical form (compact, keys sorted, ASCII), so the same content always gives the same bytes and
  the same sha256s; comparing those is how "nothing changed" is decided.
* manifest.json is written LAST: a release without a manifest does not exist as far as any reader is concerned.
"""
from __future__ import annotations

import hashlib
import io
import json
import re
from dataclasses import dataclass, field
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

import numpy as np

SCHEMA = 1
PACKAGE_NAME = "terucon_catalogue"
KNOWN_PILLARS = ("dino", "siglip", "color", "vertex_mm", "text")
_RELEASE_ID = re.compile(r"^rel-\d{14}-[0-9a-f]{6}$")


class ReleaseReadError(RuntimeError):
    """A release in the store is missing a file or does not match its manifest (the message says which)."""


class ReleaseWriteError(RuntimeError):
    pass


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def canonical_json(value: Any) -> bytes:
    """One byte-exact form: compact separators, sorted keys, ASCII only, no NaN."""
    return json.dumps(value, separators=(",", ":"), sort_keys=True, ensure_ascii=True, allow_nan=False).encode("ascii")


def npy_bytes(matrix: np.ndarray) -> bytes:
    buffer = io.BytesIO()
    np.save(buffer, np.ascontiguousarray(matrix, dtype=np.float16), allow_pickle=False)
    return buffer.getvalue()


def release_prefix(catalogue: str, release_id: str) -> str:
    return f"releases/{catalogue}/{release_id}/"


def is_release_id(value: Any) -> bool:
    return isinstance(value, str) and _RELEASE_ID.match(value) is not None


def item_entry(item_id: str, *, product_id: Optional[str], page: int, pdf_sha256: str, category: Optional[str], finish: Optional[str],
               dominant_hex: Sequence[str], proportions: Sequence[float]) -> dict:
    """One element of items.json: the columns the notebook's retrieval filters and de-duplicates on."""
    return {"itemId": item_id, "productId": product_id, "page": int(page), "pdfSha256": pdf_sha256, "category": category, "finish": finish,
            "dominantHex": list(dominant_hex), "proportions": [float(x) for x in proportions]}


# ---------------------------------------------------------------------------------------------------------------------------- reading
@dataclass
class ReleaseData:
    """A release as stored (rows still float16)."""
    manifest: dict
    manifest_bytes: bytes
    items: Dict[str, dict]                                  # itemId -> items.json entry
    pillars: Dict[str, Tuple[List[str], np.ndarray]]        # name -> (ids, float16 matrix (n, dim)), row order as stored

    @property
    def release_id(self) -> str:
        return self.manifest["releaseId"]

    @property
    def feature_versions(self) -> Dict[str, str]:
        return dict(self.manifest["featureVersions"])


def read_manifest(store, catalogue: str, release_id: str) -> Tuple[dict, bytes]:
    key = release_prefix(catalogue, release_id) + "manifest.json"
    try:
        raw = store.get_bytes(key)
    except (FileNotFoundError, KeyError):
        raise ReleaseReadError(f"release {release_id} has no manifest.json in the store ({key}).") from None
    try:
        manifest = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        raise ReleaseReadError(f"release {release_id}: manifest.json is not valid JSON.") from None
    if not isinstance(manifest, dict) or manifest.get("schema") != SCHEMA or manifest.get("releaseId") != release_id or manifest.get("catalogue") != catalogue:
        raise ReleaseReadError(f"release {release_id}: manifest.json is not a schema-{SCHEMA} manifest of {catalogue}/{release_id}.")
    return manifest, raw


def read_release(store, catalogue: str, release_id: str) -> ReleaseData:
    """Load a release and check every sha256, count, dimension and id against its manifest. Raises ReleaseReadError in plain words."""
    manifest, manifest_bytes = read_manifest(store, catalogue, release_id)
    prefix = release_prefix(catalogue, release_id)

    def fetch(relative: str, expected_sha: str, what: str) -> bytes:
        try:
            data = store.get_bytes(prefix + relative)
        except (FileNotFoundError, KeyError):
            raise ReleaseReadError(f"release {release_id}: {what} ({relative}) is missing from the store.") from None
        if sha256_hex(data) != expected_sha:
            raise ReleaseReadError(f"release {release_id}: {what} ({relative}) does not match the sha256 in its manifest.")
        return data

    try:
        items_raw = fetch(manifest["itemsFile"], manifest["itemsSha256"], "the item list")
        entries = json.loads(items_raw.decode("utf-8"))
    except KeyError as missing:
        raise ReleaseReadError(f"release {release_id}: the manifest lacks {missing}.") from None
    if not isinstance(entries, list) or len(entries) != manifest.get("nItems"):
        raise ReleaseReadError(f"release {release_id}: items.json does not hold the {manifest.get('nItems')} items the manifest promises.")
    items = {}
    for entry in entries:
        if not isinstance(entry, dict) or not isinstance(entry.get("itemId"), str) or entry["itemId"] in items:
            raise ReleaseReadError(f"release {release_id}: items.json has an entry without an itemId or a repeated itemId.")
        items[entry["itemId"]] = entry
    pillars: Dict[str, Tuple[List[str], np.ndarray]] = {}
    for name, entry in (manifest.get("pillars") or {}).items():
        try:
            ids = json.loads(fetch(entry["idsFile"], entry["idsSha256"], f"the '{name}' id list").decode("utf-8"))
            matrix = np.load(io.BytesIO(fetch(entry["file"], entry["sha256"], f"the '{name}' vectors")), allow_pickle=False)
        except KeyError as missing:
            raise ReleaseReadError(f"release {release_id}: the manifest entry for '{name}' lacks {missing}.") from None
        except (ValueError, EOFError, OSError):
            raise ReleaseReadError(f"release {release_id}: the '{name}' vectors cannot be read.") from None
        if matrix.dtype != np.float16 or matrix.shape != (entry["count"], entry["dim"]) or not isinstance(ids, list) or len(ids) != entry["count"]:
            raise ReleaseReadError(f"release {release_id}: the '{name}' vectors are {matrix.dtype} {tuple(matrix.shape)} with {len(ids) if isinstance(ids, list) else '?'} ids, "
                                   f"but the manifest says float16 ({entry['count']}, {entry['dim']}).")
        if len(set(ids)) != len(ids) or any(i not in items for i in ids):
            raise ReleaseReadError(f"release {release_id}: the '{name}' ids repeat an item or name an item that is not in items.json.")
        pillars[name] = (list(ids), matrix)
    return ReleaseData(manifest, manifest_bytes, items, pillars)


# ---------------------------------------------------------------------------------------------------------------------------- building
@dataclass
class BuiltRelease:
    """A release assembled in memory (nothing written yet): its files, its manifest and the hashes that identify its content."""
    catalogue: str
    release_id: str
    created_at: int
    parent: Optional[str]
    job_id: Optional[str]
    files: Dict[str, bytes]                    # relative path -> bytes, every file except manifest.json
    manifest: dict
    manifest_bytes: bytes
    feature_versions: Dict[str, str]
    n_items: int
    pillar_summary: Dict[str, Dict[str, int]]  # name -> {count, dim}
    lost: Dict[str, List[str]] = field(default_factory=dict)    # pillar -> item ids that had a parent vector which the bundle's version of the item dropped

    @property
    def prefix(self) -> str:
        return release_prefix(self.catalogue, self.release_id)

    @property
    def manifest_sha256(self) -> str:
        return sha256_hex(self.manifest_bytes)

    def content_fingerprint(self) -> dict:
        return content_fingerprint(self.manifest)


def content_fingerprint(manifest: Mapping[str, Any]) -> dict:
    """What two releases must share to hold the same content (ids, dates and parents do not count)."""
    return {"featureVersions": dict(manifest["featureVersions"]), "itemsSha256": manifest["itemsSha256"],
            "pillars": {name: {key: entry[key] for key in ("count", "dim", "sha256", "idsSha256")} for name, entry in sorted(manifest["pillars"].items())}}


def merge_content(parent: Optional[ReleaseData], bundle_items: Mapping[str, dict], bundle_vectors: Mapping[str, Mapping[str, np.ndarray]],
                  bundle_versions: Mapping[str, str]) -> Tuple[Dict[str, dict], Dict[str, Tuple[List[str], np.ndarray]], Dict[str, str], Dict[str, List[str]]]:
    """parent + bundle -> (items by id, pillars name -> (ids, float16 matrix), feature versions, lost vectors). The bundle's items win outright."""
    items: Dict[str, dict] = {}
    rows: Dict[str, Dict[str, np.ndarray]] = {}
    versions: Dict[str, str] = {}
    lost: Dict[str, List[str]] = {}
    if parent is not None:
        items.update({item_id: entry for item_id, entry in parent.items.items() if item_id not in bundle_items})
        versions.update(parent.feature_versions)
        for name, (ids, matrix) in parent.pillars.items():
            rows[name] = {item_id: matrix[position] for position, item_id in enumerate(ids) if item_id not in bundle_items}
            replaced_without_new = [item_id for item_id in ids if item_id in bundle_items and item_id not in bundle_vectors.get(name, {})]
            if replaced_without_new:
                lost[name] = replaced_without_new
    items.update(bundle_items)
    for name, vectors in bundle_vectors.items():
        if not vectors:
            continue
        rows.setdefault(name, {}).update({item_id: np.asarray(vector, dtype=np.float16) for item_id, vector in vectors.items()})
        versions[name] = bundle_versions[name]
    pillars: Dict[str, Tuple[List[str], np.ndarray]] = {}
    for name in sorted(rows):
        if not rows[name]:
            versions.pop(name, None)           # a pillar with no vectors is simply absent
            continue
        ids = sorted(rows[name])
        pillars[name] = (ids, np.stack([rows[name][item_id] for item_id in ids]).astype(np.float16, copy=False))
    return items, pillars, {name: versions[name] for name in sorted(pillars)}, lost


def build_release(*, catalogue: str, release_id: str, created_at: int, parent: Optional[ReleaseData], job_id: Optional[str],
                  bundle_items: Mapping[str, dict], bundle_vectors: Mapping[str, Mapping[str, np.ndarray]], bundle_versions: Mapping[str, str],
                  package_version: str) -> BuiltRelease:
    items, pillars, versions, lost = merge_content(parent, bundle_items, bundle_vectors, bundle_versions)
    ordered_items = [items[item_id] for item_id in sorted(items)]
    files: Dict[str, bytes] = {"items.json": canonical_json(ordered_items)}
    pillar_entries: Dict[str, dict] = {}
    for name, (ids, matrix) in pillars.items():
        npy, ids_json = npy_bytes(matrix), canonical_json(ids)
        files[f"pillars/{name}.npy"], files[f"pillars/{name}.ids.json"] = npy, ids_json
        pillar_entries[name] = {"count": int(matrix.shape[0]), "dim": int(matrix.shape[1]), "dtype": "float16", "file": f"pillars/{name}.npy",
                                "idsFile": f"pillars/{name}.ids.json", "sha256": sha256_hex(npy), "idsSha256": sha256_hex(ids_json)}
    manifest = {"schema": SCHEMA, "releaseId": release_id, "catalogue": catalogue, "createdAt": int(created_at), "parent": parent.release_id if parent else None,
                "jobId": job_id, "nItems": len(ordered_items), "featureVersions": versions, "pillars": pillar_entries, "itemsFile": "items.json",
                "itemsSha256": sha256_hex(files["items.json"]), "package": {"name": PACKAGE_NAME, "version": package_version}}
    manifest_bytes = json.dumps(manifest, indent=2, sort_keys=True, ensure_ascii=True, allow_nan=False).encode("ascii") + b"\n"
    return BuiltRelease(catalogue=catalogue, release_id=release_id, created_at=int(created_at), parent=manifest["parent"], job_id=job_id, files=files,
                        manifest=manifest, manifest_bytes=manifest_bytes, feature_versions=versions, n_items=len(ordered_items),
                        pillar_summary={name: {"count": entry["count"], "dim": entry["dim"]} for name, entry in pillar_entries.items()}, lost=lost)


# ---------------------------------------------------------------------------------------------------------------------------- writing
def write_release(store, built: BuiltRelease, *, on_file=None) -> None:
    """Write every file of the release, the manifest last. An object that is already there is an error: releases are immutable."""
    names = ["items.json"] + sorted(name for name in built.files if name != "items.json")
    total = len(names) + 1
    for position, relative in enumerate(names, start=1):
        key = built.prefix + relative
        data = built.files[relative]
        if not store.put_bytes(key, data, "application/json" if relative.endswith(".json") else "application/octet-stream", if_absent=True):
            raise ReleaseWriteError(f"{key} already exists; a release is never overwritten.")
        if on_file is not None:
            on_file(position, total, relative)
    key = built.prefix + "manifest.json"
    if not store.put_bytes(key, built.manifest_bytes, "application/json", if_absent=True):
        raise ReleaseWriteError(f"{key} already exists; a release is never overwritten.")
    if on_file is not None:
        on_file(total, total, "manifest.json")
    for relative, data in {**built.files, "manifest.json": built.manifest_bytes}.items():
        size = store.size(built.prefix + relative)
        if size != len(data):
            raise ReleaseWriteError(f"{built.prefix + relative} was written but the store reports {size} bytes instead of {len(data)}.")
