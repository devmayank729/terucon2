"""The reader (PY-B) against releases made by the real writer (PY-C, release_writer.build_release / write_release): the two halves of
ARCHITECTURE.md 4.3 must agree. Skipped when the writer is not there."""
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fakes_search import MemoryStore, unit_rows  # noqa: E402

release_writer = pytest.importorskip("terucon_catalogue.release_writer")
objectstore = pytest.importorskip("terucon_catalogue.objectstore")

from terucon_catalogue.config import PipelineConfig, compute_feature_versions  # noqa: E402
from terucon_catalogue.release_reader import ReleaseCorruptError, load_release  # noqa: E402

CATALOGUE = "superbond-colour"
CFG = PipelineConfig()
VERSIONS = compute_feature_versions(CFG)
DIMS = {"dino": 24, "siglip": 16, "color": 12, "text": 10}


def entry(index, **overrides):
    fields = dict(product_id=None, page=index, pdf_sha256="b" * 64, category="stone" if index % 2 else "metal", finish="matte",
                  dominant_hex=["#102030"], proportions=[1.0])
    fields.update(overrides)
    return release_writer.item_entry(f"bbbbbbbbbbbb-p{index:04d}-i00", **fields)


def build(parent, release_id, first, last, seed):
    rng = np.random.default_rng(seed)
    ids = [f"bbbbbbbbbbbb-p{i:04d}-i00" for i in range(first, last + 1)]
    items = {item_id: entry(int(item_id.split("-p")[1][:4])) for item_id in ids}
    vectors = {name: {item_id: row for item_id, row in zip(ids, unit_rows(rng, len(ids), dim))} for name, dim in DIMS.items()}
    return release_writer.build_release(catalogue=CATALOGUE, release_id=release_id, created_at=1793000000000, parent=parent, job_id=None,
                                        bundle_items=items, bundle_vectors=vectors, bundle_versions={name: VERSIONS[name] for name in DIMS},
                                        package_version="0.1.0")


@pytest.fixture(params=["memory", "local"])
def store(request, tmp_path):
    return MemoryStore() if request.param == "memory" else objectstore.LocalObjectStore(tmp_path / "bucket", "catalogue/")


def test_reader_reads_what_the_writer_wrote(store, tmp_path):
    built = build(None, "rel-20261101120000-aaaaaa", 1, 9, seed=1)
    release_writer.write_release(store, built)
    loaded = load_release(store, CATALOGUE, built.release_id, tmp_path / "cache", VERSIONS, CFG)
    assert loaded.manifest == built.manifest and loaded.n_items == 9 and set(loaded.pillars) == set(DIMS)
    assert [item["itemId"] for item in loaded.items] == sorted(item["itemId"] for item in loaded.items)
    stored_ids, stored_matrix = release_writer.read_release(store, CATALOGUE, built.release_id).pillars["dino"]
    assert loaded.pillars["dino"].ids == stored_ids
    np.testing.assert_allclose(loaded.pillars["dino"].matrix, stored_matrix.astype(np.float32) / np.linalg.norm(stored_matrix.astype(np.float32), axis=1, keepdims=True),
                               atol=1e-6)
    assert loaded.warnings and all("vertex_mm" in w for w in loaded.warnings)         # the writer's test releases have no vertex_mm pillar


def test_a_child_release_merged_from_a_parent_reads_too(store, tmp_path):
    parent = build(None, "rel-20261101120000-aaaaaa", 1, 6, seed=2)
    release_writer.write_release(store, parent)
    child = build(release_writer.read_release(store, CATALOGUE, parent.release_id), "rel-20261102120000-bbbbbb", 5, 10, seed=3)
    release_writer.write_release(store, child)
    loaded = load_release(store, CATALOGUE, child.release_id, tmp_path / "cache", VERSIONS, CFG)
    assert loaded.n_items == 10 and loaded.manifest["parent"] == parent.release_id
    assert all(len(pillar.ids) == 10 for pillar in loaded.pillars.values())


def test_a_tampered_writer_release_is_refused(store, tmp_path):
    built = build(None, "rel-20261101120000-aaaaaa", 1, 5, seed=4)
    release_writer.write_release(store, built)
    key = built.prefix + "pillars/siglip.npy"
    data = bytearray(store.get_bytes(key))
    data[-4] ^= 0xFF
    if isinstance(store, MemoryStore):
        store.objects[key] = bytes(data)
    else:
        store.put_bytes(key, bytes(data))
    with pytest.raises(ReleaseCorruptError):
        load_release(store, CATALOGUE, built.release_id, tmp_path / "cache", VERSIONS, CFG)
