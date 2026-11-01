"""release_reader.load_release against releases written in ARCHITECTURE.md 4.3's exact layout (np.save float16 + ids json + manifest sha256s)."""
import copy
import json
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import nb_oracle  # noqa: E402
from fakes_search import CATALOGUE, RELEASE, MemoryStore, make_items, npy_bytes, random_release, sha256  # noqa: E402

from terucon_catalogue.config import PipelineConfig, compute_feature_versions  # noqa: E402
from terucon_catalogue.release_reader import (BadRequestError, FeatureVersionMismatchError, ReleaseCorruptError,  # noqa: E402
                                              ReleaseMissingError, StoreUnavailableError, load_release)

PREFIX = f"releases/{CATALOGUE}/{RELEASE}/"
CFG = PipelineConfig()
EXPECTED = compute_feature_versions(CFG)


def load(store, cache, **kwargs):
    return load_release(store, CATALOGUE, RELEASE, cache, EXPECTED, CFG, **kwargs)


@pytest.fixture
def written(tmp_path):
    store = MemoryStore()
    items, rows, manifest = random_release(store, 12, seed=3, missing={"text": {4, 9}, "dino": {0}})
    return store, items, rows, manifest, tmp_path / "cache"


def edit_manifest(store, mutate):
    manifest = json.loads(store.objects[PREFIX + "manifest.json"])
    mutate(manifest)
    store.objects[PREFIX + "manifest.json"] = json.dumps(manifest).encode()


def flip_byte(store, key, offset=-3):
    data = bytearray(store.objects[key])
    data[offset] ^= 0xFF
    store.objects[key] = bytes(data)


# ------------------------------------------------------------------------------------------------------------------------
def test_round_trip(written):
    store, items, rows, manifest, cache = written
    loaded = load(store, cache)
    assert loaded.source == "download" and loaded.release_id == RELEASE and loaded.catalogue == CATALOGUE and loaded.n_items == 12
    assert loaded.items == items and loaded.manifest == manifest
    assert set(loaded.pillars) == {"dino", "siglip", "color", "vertex_mm", "text"}
    for name, (ids, matrix) in rows.items():
        pillar = loaded.pillars[name]
        assert pillar.ids == ids and pillar.matrix.dtype == np.float32 and pillar.matrix.shape == matrix.shape and pillar.version == EXPECTED[name]
        assert pillar.matrix.flags["C_CONTIGUOUS"]
        np.testing.assert_allclose(np.linalg.norm(pillar.matrix, axis=1), 1.0, atol=1e-6)
        np.testing.assert_allclose(pillar.matrix, matrix, atol=1e-3)           # float16 storage error only
    assert len(loaded.pillars["text"].ids) == 10 and len(loaded.pillars["dino"].ids) == 11   # an item may lack a pillar
    assert loaded.warnings == []
    assert (cache / CATALOGUE / RELEASE / "manifest.json").is_file()
    assert not [p for p in (cache / CATALOGUE).iterdir() if p.name.startswith(".")]      # no temp directories left behind


def test_rows_are_renormalised_exactly_like_the_notebooks_fetch_embeddings(written):
    """StateStore.fetch_embeddings: np.frombuffer(float16).astype(float32) rows, stacked, then l2_normalize_rows over the whole matrix."""
    nb_oracle.require_notebook()
    nb = nb_oracle.load([(1, ["l2_normalize_rows"])])
    store, _, rows, _, cache = written
    loaded = load(store, cache)
    for name, (ids, matrix) in rows.items():
        stored = np.load(__import__("io").BytesIO(store.objects[PREFIX + f"pillars/{name}.npy"]))
        expected = nb["l2_normalize_rows"](np.stack([np.frombuffer(row.tobytes(), dtype=np.float16).astype(np.float32) for row in stored]))
        assert np.array_equal(loaded.pillars[name].matrix, np.ascontiguousarray(expected, dtype=np.float32)), name


def test_blocked_normalisation_equals_one_shot_for_a_large_pillar(tmp_path):
    store = MemoryStore()
    rng = np.random.default_rng(0)
    items = make_items(9000, rng=rng)                     # more rows than one normalisation block (8192)
    matrix = rng.normal(size=(9000, 6)).astype(np.float32)
    from fakes_search import write_release
    write_release(store, items, {"color": ([i["itemId"] for i in items], matrix / np.linalg.norm(matrix, axis=1, keepdims=True))})
    loaded = load(store, tmp_path / "c")
    from terucon_catalogue.util import l2_normalize_rows
    stored = np.load(__import__("io").BytesIO(store.objects[PREFIX + "pillars/color.npy"])).astype(np.float32)
    assert np.array_equal(loaded.pillars["color"].matrix, l2_normalize_rows(stored))


def test_cache_is_reused_without_touching_the_store(written):
    store, _, _, _, cache = written
    first = load(store, cache)
    reads = len(store.reads)
    assert reads > 0
    second = load(store, cache)
    assert second.source == "cache" and len(store.reads) == reads
    assert np.array_equal(second.pillars["siglip"].matrix, first.pillars["siglip"].matrix)
    store.objects.clear()                                  # the bucket is gone: the verified cache still serves the (immutable) release
    assert load(store, cache).source == "cache"


def test_tampered_cache_is_repaired_from_the_store(written):
    store, _, _, _, cache = written
    load(store, cache)
    cached = cache / CATALOGUE / RELEASE / "pillars" / "dino.npy"
    data = bytearray(cached.read_bytes())
    data[-5] ^= 0x55
    cached.write_bytes(bytes(data))
    reads = len(store.reads)
    again = load(store, cache)
    assert again.source == "download" and len(store.reads) > reads
    assert sha256(cached.read_bytes()) == json.loads(store.objects[PREFIX + "manifest.json"])["pillars"]["dino"]["sha256"]


def test_missing_cache_file_is_repaired_too(written):
    store, _, _, _, cache = written
    load(store, cache)
    (cache / CATALOGUE / RELEASE / "items.json").unlink()
    assert load(store, cache).source == "download"


# ------------------------------------------------------------------------------------------------------------------------
# tamper detection in the store: every one is release-corrupt (409) and leaves nothing in the cache
# ------------------------------------------------------------------------------------------------------------------------
def corrupt_cases():
    def flip(key):
        return lambda store: flip_byte(store, PREFIX + key)

    def manifest(mutate):
        return lambda store: edit_manifest(store, mutate)

    def delete(key):
        return lambda store: store.objects.pop(PREFIX + key)

    def replace(key, data):
        return lambda store: store.objects.__setitem__(PREFIX + key, data)

    return {
        "flipped byte in a pillar": flip("pillars/dino.npy"),
        "flipped byte in items.json": flip("items.json"),
        "flipped byte in an ids file": flip("pillars/siglip.ids.json"),
        "wrong sha256 in the manifest": manifest(lambda m: m["pillars"]["dino"].update(sha256="0" * 64)),
        "wrong items sha256": manifest(lambda m: m.update(itemsSha256="f" * 64)),
        "wrong dim in the manifest": manifest(lambda m: m["pillars"]["siglip"].update(dim=17)),
        "wrong count in the manifest": manifest(lambda m: m["pillars"]["color"].update(count=13)),
        "wrong nItems": manifest(lambda m: m.update(nItems=13)),
        "missing pillar file": delete("pillars/vertex_mm.npy"),
        "missing ids file": delete("pillars/vertex_mm.ids.json"),
        "missing items file": delete("items.json"),
        "manifest is not json": replace("manifest.json", b"{nope"),
        "manifest of another release": manifest(lambda m: m.update(releaseId="rel-20200101000000-ffffff")),
        "manifest of another catalogue": manifest(lambda m: m.update(catalogue="other-cat")),
        "unknown schema": manifest(lambda m: m.update(schema=2)),
        "path traversal in a file name": manifest(lambda m: m["pillars"]["dino"].update(file="../../../etc/passwd")),
        "dtype not float16": manifest(lambda m: m["pillars"]["dino"].update(dtype="float32")),
        "pillar without a feature version": manifest(lambda m: m["featureVersions"].pop("dino")),
        "absurd size": manifest(lambda m: m["pillars"]["dino"].update(count=10 ** 12)),
        "ids file lists an unknown item": lambda s: _rewrite_ids(s, "text", lambda ids: ids[:-1] + ["zzzzzzzzzzzz-p9999-i00"]),
        "ids file lists an item twice": lambda s: _rewrite_ids(s, "text", lambda ids: ids[:-1] + [ids[0]]),
        "npy stored as float32": lambda s: _rewrite_npy(s, "color", lambda a: a.astype(np.float32)),
        "npy has NaN": lambda s: _rewrite_npy(s, "color", lambda a: np.where(np.arange(a.size).reshape(a.shape) == 3, np.nan, a).astype(np.float16)),
        "npy is 1-dimensional": lambda s: _rewrite_npy(s, "color", lambda a: a.reshape(-1)),
        "npy is not an npy": replace("pillars/color.npy", b"not numpy at all"),
    }


def _rewrite_ids(store, pillar, change):
    key = PREFIX + f"pillars/{pillar}.ids.json"
    ids = change(json.loads(store.objects[key]))
    data = json.dumps(ids).encode()
    store.objects[key] = data
    edit_manifest(store, lambda m: m["pillars"][pillar].update(idsSha256=sha256(data)))


def _rewrite_npy(store, pillar, change):
    key = PREFIX + f"pillars/{pillar}.npy"
    array = np.load(__import__("io").BytesIO(store.objects[key]))
    data = npy_bytes(change(array))
    store.objects[key] = data
    edit_manifest(store, lambda m: m["pillars"][pillar].update(sha256=sha256(data)))


@pytest.mark.parametrize("name", list(corrupt_cases()))
def test_corruption_is_detected(written, name):
    store, _, _, _, cache = written
    corrupt_cases()[name](store)
    with pytest.raises(ReleaseCorruptError) as caught:
        load(store, cache)
    assert caught.value.reason == "release-corrupt" and caught.value.status == 409
    assert not (cache / CATALOGUE / RELEASE).exists()
    leftovers = list((cache / CATALOGUE).iterdir()) if (cache / CATALOGUE).exists() else []
    assert leftovers == []                                              # the temp directory is gone too


def test_missing_release_is_release_missing(tmp_path):
    with pytest.raises(ReleaseMissingError) as caught:
        load(MemoryStore(), tmp_path)
    assert (caught.value.reason, caught.value.status) == ("release-missing", 409)


def test_store_failure_is_503_not_missing(written):
    store, _, _, _, cache = written

    def boom(key):
        raise ConnectionError("network down with secret=abc")

    store.size = boom
    with pytest.raises(StoreUnavailableError) as caught:
        load(store, cache)
    assert caught.value.status == 503 and caught.value.retry_after and "secret" not in str(caught.value)


# ------------------------------------------------------------------------------------------------------------------------
# feature versions
# ------------------------------------------------------------------------------------------------------------------------
@pytest.mark.parametrize("pillar", ["dino", "siglip", "color", "vertex_mm", "text"])
def test_version_mismatch_is_refused_before_the_big_files_are_read(written, pillar):
    store, _, _, _, cache = written
    edit_manifest(store, lambda m: m["featureVersions"].update({pillar: m["featureVersions"][pillar].replace("v1", "v2")}))
    store.reads.clear()
    with pytest.raises(FeatureVersionMismatchError) as caught:
        load(store, cache)
    assert caught.value.reason == "feature-version-mismatch" and caught.value.status == 409
    assert [p.pillar for p in caught.value.problems] == [pillar] and pillar in str(caught.value)
    assert store.reads == [PREFIX + "manifest.json"]                  # nothing else was downloaded
    assert not (cache / CATALOGUE / RELEASE).exists()


def test_a_different_caption_fingerprint_is_only_a_warning(written):
    import re
    store, _, _, _, cache = written
    other = re.sub(r"\|cap[0-9a-f]{12}\|", "|cap" + "0" * 12 + "|", EXPECTED["text"])
    assert other != EXPECTED["text"]
    edit_manifest(store, lambda m: m["featureVersions"].update(text=other))
    loaded = load(store, cache)
    assert any(w.startswith("text:") and "fingerprint" in w for w in loaded.warnings)
    assert "text" in loaded.pillars


def test_a_release_without_some_pillars_loads_with_warnings(tmp_path):
    store = MemoryStore()
    random_release(store, 6, pillars=("dino", "siglip", "color"))
    loaded = load(store, tmp_path / "c")
    assert set(loaded.pillars) == {"dino", "siglip", "color"}
    assert any("No 'text' vectors" in w for w in loaded.warnings) and any("No 'vertex_mm' vectors" in w for w in loaded.warnings)


def test_expected_versions_must_agree_with_cfg(written):
    store, _, _, _, cache = written
    with pytest.raises(ValueError):
        load_release(store, CATALOGUE, RELEASE, cache, dict(EXPECTED, dino="other"), CFG)
    assert load_release(store, CATALOGUE, RELEASE, cache, {"dino": EXPECTED["dino"]}, CFG).n_items == 12     # a subset is fine
    assert load_release(store, CATALOGUE, RELEASE, cache, None, CFG).n_items == 12


# ------------------------------------------------------------------------------------------------------------------------
# hooks and identifiers
# ------------------------------------------------------------------------------------------------------------------------
def test_cache_hooks(written):
    store, _, _, _, cache = written
    calls = []
    load(store, cache, commit_cache=lambda: calls.append("commit"), reload_cache=lambda: calls.append("reload"))
    assert calls == ["reload", "commit"]
    calls.clear()
    assert load(store, cache, commit_cache=lambda: calls.append("commit"), reload_cache=lambda: calls.append("reload")).source == "cache"
    assert calls == ["reload"]                                         # a cache hit changes nothing, so nothing is committed


def test_failing_hooks_do_not_fail_the_load(written):
    store, _, _, _, cache = written

    def boom():
        raise RuntimeError("volume busy")

    assert load(store, cache, commit_cache=boom, reload_cache=boom).n_items == 12


@pytest.mark.parametrize("catalogue, release", [("../x", RELEASE), (CATALOGUE, "../../etc"), ("A", RELEASE), (CATALOGUE, RELEASE + "\n"),
                                                (CATALOGUE, "rel-2026110112000-abc123"), ("a" * 40, RELEASE), ("x", RELEASE), ("", RELEASE)])
def test_bad_ids_never_reach_the_filesystem_or_the_store(tmp_path, catalogue, release):
    store = MemoryStore()
    with pytest.raises(BadRequestError):
        load_release(store, catalogue, release, tmp_path / "cache", EXPECTED, CFG)
    assert store.reads == [] and not (tmp_path / "cache").exists()


def test_two_loads_race_for_one_release_and_both_get_it(written):
    import threading
    store, _, _, _, cache = written
    results, errors = [], []

    def worker():
        try:
            results.append(load(store, cache))
        except Exception as exc:                                       # pragma: no cover
            errors.append(exc)

    threads = [threading.Thread(target=worker) for _ in range(4)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert not errors and len(results) == 4
    assert all(np.array_equal(r.pillars["color"].matrix, results[0].pillars["color"].matrix) for r in results)
    assert not [p for p in (cache / CATALOGUE).iterdir() if p.name.startswith(".")]


def test_round_trip_through_the_real_local_object_store(tmp_path):
    objectstore = pytest.importorskip("terucon_catalogue.objectstore")
    store = objectstore.LocalObjectStore(tmp_path / "bucket", "catalogue/")
    memory = MemoryStore()
    items, rows, _ = random_release(memory, 7, seed=4)
    for key, data in memory.objects.items():
        store.put_bytes(key, data)
    loaded = load(store, tmp_path / "cache")
    assert loaded.n_items == 7 and set(loaded.pillars) == set(rows)
    with pytest.raises(ReleaseMissingError):
        load_release(store, CATALOGUE, "rel-20200101000000-aaaaaa", tmp_path / "cache", EXPECTED, CFG)
