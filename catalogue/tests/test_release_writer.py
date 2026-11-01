"""release_writer: the files of ARCHITECTURE.md 4.2/4.3, the merge rule, and reading a release back with every hash checked."""
import hashlib
import io
import json

import numpy as np
import pytest

from factories import RecordingStore
from terucon_catalogue import __version__
from terucon_catalogue.objectstore import LocalObjectStore
from terucon_catalogue.release_writer import (ReleaseReadError, ReleaseWriteError, build_release, canonical_json, content_fingerprint, is_release_id, item_entry,
                                              merge_content, npy_bytes, read_release, release_prefix, write_release)

CAT = "cat-one"
V = {"dino": "dino-v1", "siglip": "siglip-v1", "color": "color-v1"}


def rng_rows(seed, ids, dim):
    rng = np.random.default_rng(seed)
    matrix = rng.normal(size=(len(ids), dim)).astype(np.float32)
    matrix /= np.linalg.norm(matrix, axis=1, keepdims=True)
    return {item_id: matrix[i].astype(np.float16) for i, item_id in enumerate(ids)}


def entries(ids, **extra):
    return {i: item_entry(i, product_id=extra.get("product_id"), page=n + 1, pdf_sha256="a" * 64, category="stone", finish="polished", dominant_hex=["#000000"], proportions=[1.0])
            for n, i in enumerate(ids)}


def build(parent=None, ids=("c-p0003", "a-p0001", "b-p0002"), release_id="rel-20261101000000-aaaaaa", pillars=("dino", "siglip"), seed=1, versions=V):
    vectors = {name: rng_rows(seed + n, ids, 4 + n) for n, name in enumerate(pillars)}
    return build_release(catalogue=CAT, release_id=release_id, created_at=1_793_000_000_000, parent=parent, job_id="job-1", bundle_items=entries(ids),
                         bundle_vectors=vectors, bundle_versions=versions, package_version=__version__), vectors


def test_canonical_json_is_one_byte_exact_form():
    assert canonical_json({"b": 1, "a": [1, 2]}) == canonical_json({"a": [1, 2], "b": 1}) == b'{"a":[1,2],"b":1}'
    assert canonical_json(["é"]) == b'["\\u00e9"]'
    with pytest.raises(ValueError):
        canonical_json({"x": float("nan")})


def test_npy_bytes_is_float16_c_order_and_deterministic():
    fortran = np.asfortranarray(np.arange(12, dtype=np.float32).reshape(3, 4))
    first, second = npy_bytes(fortran), npy_bytes(np.ascontiguousarray(fortran))
    assert first == second
    loaded = np.load(io.BytesIO(first), allow_pickle=False)
    assert loaded.dtype == np.float16 and loaded.shape == (3, 4) and loaded.flags["C_CONTIGUOUS"] and np.array_equal(loaded, fortran.astype(np.float16))


def test_the_release_has_the_files_and_manifest_of_4_3():
    built, vectors = build()
    assert sorted(built.files) == ["items.json", "pillars/dino.ids.json", "pillars/dino.npy", "pillars/siglip.ids.json", "pillars/siglip.npy"]
    manifest = built.manifest
    assert set(manifest) == {"schema", "releaseId", "catalogue", "createdAt", "parent", "jobId", "nItems", "featureVersions", "pillars", "itemsFile", "itemsSha256", "package"}
    assert manifest["schema"] == 1 and manifest["releaseId"] == "rel-20261101000000-aaaaaa" and manifest["catalogue"] == CAT and manifest["parent"] is None
    assert manifest["createdAt"] == 1_793_000_000_000 and manifest["jobId"] == "job-1" and manifest["nItems"] == 3
    assert manifest["featureVersions"] == {"dino": "dino-v1", "siglip": "siglip-v1"} and manifest["itemsFile"] == "items.json"
    assert manifest["package"] == {"name": "terucon_catalogue", "version": __version__}
    assert manifest["itemsSha256"] == hashlib.sha256(built.files["items.json"]).hexdigest()
    for name, entry in manifest["pillars"].items():
        assert set(entry) == {"count", "dim", "dtype", "file", "idsFile", "sha256", "idsSha256"} and entry["dtype"] == "float16"
        assert entry["file"] == f"pillars/{name}.npy" and entry["idsFile"] == f"pillars/{name}.ids.json" and entry["count"] == 3
        assert entry["sha256"] == hashlib.sha256(built.files[entry["file"]]).hexdigest() and entry["idsSha256"] == hashlib.sha256(built.files[entry["idsFile"]]).hexdigest()
    assert manifest["pillars"]["dino"]["dim"] == 4 and manifest["pillars"]["siglip"]["dim"] == 5
    assert json.loads(built.manifest_bytes) == manifest and built.manifest_sha256 == hashlib.sha256(built.manifest_bytes).hexdigest()


def test_items_and_rows_are_sorted_by_item_id_and_the_rows_are_the_bundles_float16_bytes():
    built, vectors = build()
    items = json.loads(built.files["items.json"])
    assert [i["itemId"] for i in items] == ["a-p0001", "b-p0002", "c-p0003"]
    assert set(items[0]) == {"itemId", "productId", "page", "pdfSha256", "category", "finish", "dominantHex", "proportions"}
    for name in ("dino", "siglip"):
        ids = json.loads(built.files[f"pillars/{name}.ids.json"])
        matrix = np.load(io.BytesIO(built.files[f"pillars/{name}.npy"]), allow_pickle=False)
        assert ids == ["a-p0001", "b-p0002", "c-p0003"]
        for position, item_id in enumerate(ids):
            assert matrix[position].tobytes() == vectors[name][item_id].tobytes(), "not a single bit changed on the way"
    assert built.files["pillars/dino.ids.json"] == b'["a-p0001","b-p0002","c-p0003"]'


def test_same_content_gives_the_same_hashes_whatever_the_input_order_and_different_content_does_not():
    ids = ["a-p0001", "b-p0002", "c-p0003"]
    items, vectors = entries(ids), {"dino": rng_rows(1, ids, 4)}

    def reordered(mapping):
        return {key: mapping[key] for key in reversed(list(mapping))}

    first = build_release(catalogue=CAT, release_id="rel-20261101000000-aaaaaa", created_at=1, parent=None, job_id=None, bundle_items=items, bundle_vectors=vectors,
                          bundle_versions=V, package_version="x")
    second = build_release(catalogue=CAT, release_id="rel-20271231235959-ffffff", created_at=2, parent=None, job_id="job-9", bundle_items=reordered(items),
                           bundle_vectors={"dino": reordered(vectors["dino"])}, bundle_versions=V, package_version="x")
    assert first.content_fingerprint() == second.content_fingerprint() and first.manifest_bytes != second.manifest_bytes
    assert first.files == second.files
    third, _ = build(seed=99)
    assert first.content_fingerprint() != third.content_fingerprint()
    assert content_fingerprint(first.manifest) == first.content_fingerprint()


def test_merge_an_item_in_the_bundle_replaces_the_parents_item_and_all_its_vectors(tmp_path):
    store = LocalObjectStore(tmp_path / "s")
    parent_built, parent_vectors = build(ids=("a-p0001", "b-p0002", "c-p0003"), pillars=("dino", "siglip", "color"), versions={**V, "color": "color-v1"})
    write_release(store, parent_built)
    parent = read_release(store, CAT, parent_built.release_id)
    new_dino = rng_rows(50, ["b-p0002", "d-p0004"], 4)                                  # b is re-extracted (new dino only), d is new
    child = build_release(catalogue=CAT, release_id="rel-20261102000000-bbbbbb", created_at=2, parent=parent, job_id=None, bundle_items=entries(["b-p0002", "d-p0004"], product_id="X"),
                          bundle_vectors={"dino": new_dino}, bundle_versions={"dino": "dino-v1"}, package_version=__version__)
    assert child.parent == parent_built.release_id and child.manifest["nItems"] == 4
    items = {i["itemId"]: i for i in json.loads(child.files["items.json"])}
    assert items["b-p0002"]["productId"] == "X" and items["a-p0001"]["productId"] is None and sorted(items) == ["a-p0001", "b-p0002", "c-p0003", "d-p0004"]
    rows = {name: dict(zip(json.loads(child.files[f"pillars/{name}.ids.json"]), np.load(io.BytesIO(child.files[f"pillars/{name}.npy"]), allow_pickle=False)))
            for name in child.manifest["pillars"]}
    assert rows["dino"]["b-p0002"].tobytes() == new_dino["b-p0002"].tobytes() and sorted(rows["dino"]) == sorted(items)
    assert rows["dino"]["a-p0001"].tobytes() == parent_vectors["dino"]["a-p0001"].tobytes()           # untouched parent rows are byte-identical
    assert sorted(rows["siglip"]) == ["a-p0001", "c-p0003"], "b's old siglip vector was made from the old crop and must not survive"
    assert sorted(rows["color"]) == ["a-p0001", "c-p0003"]
    assert child.lost == {"siglip": ["b-p0002"], "color": ["b-p0002"]}
    assert child.manifest["pillars"]["siglip"]["count"] == 2 and child.manifest["featureVersions"] == {"dino": "dino-v1", "siglip": "siglip-v1", "color": "color-v1"}


def test_a_pillar_that_loses_all_its_vectors_disappears_from_the_manifest(tmp_path):
    store = LocalObjectStore(tmp_path / "s")
    parent_built, _ = build(ids=("a-p0001",), pillars=("dino", "siglip"))
    write_release(store, parent_built)
    child = build_release(catalogue=CAT, release_id="rel-20261102000000-bbbbbb", created_at=2, parent=read_release(store, CAT, parent_built.release_id), job_id=None,
                          bundle_items=entries(["a-p0001"]), bundle_vectors={"dino": rng_rows(3, ["a-p0001"], 4)}, bundle_versions={"dino": "dino-v1"}, package_version="x")
    assert sorted(child.manifest["pillars"]) == ["dino"] and sorted(child.manifest["featureVersions"]) == ["dino"]
    assert sorted(child.files) == ["items.json", "pillars/dino.ids.json", "pillars/dino.npy"]


def test_merge_without_a_parent_is_the_bundle():
    items, pillars, versions, lost = merge_content(None, entries(["x-1", "x-2"]), {"dino": rng_rows(1, ["x-1", "x-2"], 3), "text": {}}, {"dino": "v", "text": "t"})
    assert sorted(items) == ["x-1", "x-2"] and sorted(pillars) == ["dino"] and versions == {"dino": "v"} and lost == {}


# ------------------------------------------------------------------------------------------------------------------------ write and read
def test_the_manifest_is_written_last_and_a_release_is_never_overwritten(tmp_path):
    store = RecordingStore(LocalObjectStore(tmp_path / "s", prefix="catalogue/"))
    built, _ = build()
    write_release(store, built)
    keys = store.written_keys()
    assert keys[-1] == release_prefix(CAT, built.release_id) + "manifest.json" and len(keys) == 6 and len(set(keys)) == 6
    assert all(key.startswith(f"releases/{CAT}/rel-20261101000000-aaaaaa/") for key in keys)
    with pytest.raises(ReleaseWriteError, match="never overwritten"):
        write_release(store, built)


def test_read_release_round_trips_and_checks_every_hash(tmp_path):
    store = LocalObjectStore(tmp_path / "s")
    built, vectors = build(pillars=("dino", "siglip", "color"), versions={**V})
    write_release(store, built)
    data = read_release(store, CAT, built.release_id)
    assert data.release_id == built.release_id and sorted(data.items) == ["a-p0001", "b-p0002", "c-p0003"] and data.feature_versions == built.feature_versions
    ids, matrix = data.pillars["dino"]
    assert ids == ["a-p0001", "b-p0002", "c-p0003"] and matrix.dtype == np.float16 and matrix[0].tobytes() == vectors["dino"]["a-p0001"].tobytes()


@pytest.mark.parametrize("damage, message", [
    ("flip-npy", "does not match the sha256"), ("flip-items", "does not match the sha256"), ("flip-ids", "does not match the sha256"),
    ("delete-npy", "is missing"), ("delete-items", "is missing"), ("delete-manifest", "no manifest.json"), ("garbage-manifest", "not valid JSON"),
    ("other-release-manifest", "not a schema-1 manifest")])
def test_read_release_names_the_damage(tmp_path, damage, message):
    store = LocalObjectStore(tmp_path / "s")
    built, _ = build()
    write_release(store, built)
    prefix = release_prefix(CAT, built.release_id)

    def flip(relative):
        data = bytearray(store.get_bytes(prefix + relative))
        data[-3] ^= 0x01
        store.put_bytes(prefix + relative, bytes(data))

    if damage == "flip-npy":
        flip("pillars/dino.npy")
    elif damage == "flip-items":
        flip("items.json")
    elif damage == "flip-ids":
        flip("pillars/siglip.ids.json")
    elif damage == "delete-npy":
        store.delete(prefix + "pillars/dino.npy")
    elif damage == "delete-items":
        store.delete(prefix + "items.json")
    elif damage == "delete-manifest":
        store.delete(prefix + "manifest.json")
    elif damage == "garbage-manifest":
        store.put_bytes(prefix + "manifest.json", b"{ nope")
    elif damage == "other-release-manifest":
        store.put_bytes(prefix + "manifest.json", json.dumps({**built.manifest, "releaseId": "rel-20990101000000-ffffff"}).encode())
    with pytest.raises(ReleaseReadError, match=message):
        read_release(store, CAT, built.release_id)


def test_read_release_catches_a_count_that_disagrees_with_the_manifest(tmp_path):
    store = LocalObjectStore(tmp_path / "s")
    built, _ = build()
    write_release(store, built)
    prefix = release_prefix(CAT, built.release_id)
    manifest = json.loads(store.get_bytes(prefix + "manifest.json"))
    manifest["nItems"] = 99
    store.put_bytes(prefix + "manifest.json", json.dumps(manifest).encode())
    with pytest.raises(ReleaseReadError, match="99 items"):
        read_release(store, CAT, built.release_id)


def test_the_search_services_own_reader_accepts_what_this_writes(tmp_path):
    release_reader = pytest.importorskip("terucon_catalogue.release_reader")
    from terucon_catalogue.config import PipelineConfig, compute_feature_versions

    real = compute_feature_versions(PipelineConfig())          # the reader insists on the labels the encoder would write
    versions = {name: real[name] for name in ("dino", "siglip", "color")}
    store = LocalObjectStore(tmp_path / "s", prefix="catalogue/")
    built, vectors = build(pillars=("dino", "siglip", "color"), versions=versions)
    write_release(store, built)
    loaded = release_reader.load_release(store, CAT, built.release_id, tmp_path / "cache", versions, PipelineConfig())
    assert loaded.n_items == 3 and sorted(loaded.pillars) == ["color", "dino", "siglip"] and loaded.pillars["dino"].ids == ["a-p0001", "b-p0002", "c-p0003"]


def test_release_id_shape():
    assert is_release_id("rel-20261101123456-abcdef") and not is_release_id("rel-2026-abcdef") and not is_release_id("job-20261101123456-abcdef") and not is_release_id(None)
