"""bucket_import: a finished bundle that sits in the bucket (uploaded by the owner, in the notebook's own layout) is published and its release is put on the
Modal volume. The bucket is a LocalObjectStore, the database is in memory, the bundle is the test factory's Kaggle-layout one; nothing touches Modal, Google or MongoDB."""
import threading
from pathlib import Path

import pytest

from factories import RecordingStore, flip_crop_byte, make_bundle, new_environment
from terucon_catalogue import bucket_import, publish as publish_module
from terucon_catalogue.bucket_import import (BucketImportError, check_import_prefix, fetch_bundle, prime_volume, run_bucket_import, seed_after_ingest,
                                             seed_release_cache)
from terucon_catalogue.bundle import Bundle
from terucon_catalogue.config import PipelineConfig
from terucon_catalogue.publish import PublishError
from terucon_catalogue.release_reader import load_release
from terucon_catalogue.config import compute_feature_versions

CAT = "superbond-colour"
CFG = PipelineConfig()
EPOCH = 1_793_000_000_000
PREFIX = "imports/superbond-colour/run 1/"        # a space on purpose: the notebook's own folders have them ("Superbond colour image_ab12cd34")


@pytest.fixture(autouse=True)
def fake_clock(monkeypatch):
    state = {"now": EPOCH}

    def tick():
        state["now"] += 1000
        return state["now"]

    monkeypatch.setattr(publish_module, "CLOCK", tick)
    return state


def upload_folder(store, folder, prefix, extra=()):
    """What `gcloud storage cp -r <folder>/* gs://<bucket>/catalogue/<prefix>` does: every file, same layout."""
    folder = Path(folder)
    for path in sorted(folder.rglob("*")):
        if path.is_file():
            store.put_file(prefix + path.relative_to(folder).as_posix(), path)
    for name, data in extra:
        store.put_bytes(prefix + name, data)


def env_with_bundle(tmp_path, n_items=4, prefix=PREFIX, **bundle_kwargs):
    store, db = new_environment(tmp_path)
    info = make_bundle(tmp_path / "kaggle-output", n_items, legacy_kaggle_paths=True, **bundle_kwargs)
    upload_folder(store, info.path, prefix, extra=[("README.txt", b"notes"), ("figures/plot.txt", b"x")])
    return store, db, info


# ------------------------------------------------------------------------------------------------------------------------ the folder name
def test_prefix_is_checked_and_always_ends_in_a_slash():
    assert check_import_prefix("imports/superbond-colour/run1") == "imports/superbond-colour/run1/"
    assert check_import_prefix("  imports/a/b/  ") == "imports/a/b/"
    assert check_import_prefix("imports/Superbond colour image/run 1") == "imports/Superbond colour image/run 1/"
    for bad in ("", "   ", None, 5, "imports", "imports/", "releases/superbond-colour/rel-1", "crops/x", "/imports/a", "imports//a", "imports/../releases/x",
                "imports/a/./b", "imports/a\\b", "imports/a\nb", "gs://bucket/catalogue/imports/a", "https://storage.googleapis.com/b/imports/a"):
        with pytest.raises(BucketImportError):
            check_import_prefix(bad)


def test_the_gs_address_error_tells_the_owner_what_to_type_instead():
    with pytest.raises(BucketImportError, match="imports/superbond-colour/run1"):
        check_import_prefix("gs://my-bucket/catalogue/imports/superbond-colour/run1")


# ------------------------------------------------------------------------------------------------------------------------ fetching
def test_a_bundle_in_the_bucket_comes_back_byte_for_byte_and_opens_as_a_bundle(tmp_path):
    store, _db, info = env_with_bundle(tmp_path)
    done = []
    result = fetch_bundle(store, PREFIX, tmp_path / "work", progress=lambda stage, n, total, message: done.append((stage, n, total)))
    assert result.images == 4 and result.files == 5 and result.skipped == 2        # README.txt and figures/plot.txt are left alone
    assert (tmp_path / "work" / "state.sqlite").read_bytes() == (info.path / "state.sqlite").read_bytes()
    for item_id, original in info.crop_paths.items():
        assert (tmp_path / "work" / "crops" / info.crop_dir / f"{item_id}.png").read_bytes() == original.read_bytes()
    assert done and done[-1] == ("fetch", 5, 5)
    with Bundle(tmp_path / "work") as bundle:                 # the real reader accepts the downloaded copy, Kaggle-absolute paths and all
        assert bundle.describe()["crops_found"] == 4


def test_a_sibling_folder_with_a_longer_name_is_not_pulled_in(tmp_path):
    store, _db, info = env_with_bundle(tmp_path, prefix="imports/superbond-colour/run1/")
    other = make_bundle(tmp_path / "other", 2, legacy_kaggle_paths=True, seed=9)
    upload_folder(store, other.path, "imports/superbond-colour/run10/")
    result = fetch_bundle(store, "imports/superbond-colour/run1", tmp_path / "work")
    assert result.images == 4
    assert sorted(p.name for p in (tmp_path / "work" / "crops" / info.crop_dir).iterdir()) == sorted(f"{i}.png" for i in info.item_ids)


def test_the_wal_file_is_fetched_when_the_notebook_left_one(tmp_path):
    store, _db, _info = env_with_bundle(tmp_path)
    store.put_bytes(PREFIX + "state.sqlite-wal", b"wal-bytes")
    result = fetch_bundle(store, PREFIX, tmp_path / "work")
    assert result.has_wal and (tmp_path / "work" / "state.sqlite-wal").read_bytes() == b"wal-bytes"


def test_nothing_there_no_database_and_two_databases_are_refused_before_anything_is_copied(tmp_path):
    store, _db = new_environment(tmp_path)
    recording = RecordingStore(store)
    with pytest.raises(BucketImportError, match="Nothing to import"):
        fetch_bundle(recording, "imports/superbond-colour/empty", tmp_path / "w1")
    store.put_bytes("imports/superbond-colour/pics/crops/a.png", b"png")
    with pytest.raises(BucketImportError, match="no state.sqlite"):
        fetch_bundle(recording, "imports/superbond-colour/pics", tmp_path / "w2")
    store.put_bytes("imports/superbond-colour/two/a/state.sqlite", b"x")
    store.put_bytes("imports/superbond-colour/two/b/state.sqlite", b"y")
    with pytest.raises(BucketImportError, match="2 state.sqlite"):
        fetch_bundle(recording, "imports/superbond-colour/two", tmp_path / "w3")
    assert not [call for call in recording.calls if call[0] in ("get_file", "get_bytes")]


def test_too_many_files_and_too_many_bytes_are_refused(tmp_path):
    store, _db, _info = env_with_bundle(tmp_path)
    with pytest.raises(BucketImportError, match="more than the 3"):
        fetch_bundle(store, PREFIX, tmp_path / "w1", max_files=3)
    with pytest.raises(BucketImportError, match="larger than"):
        fetch_bundle(store, PREFIX, tmp_path / "w2", max_bytes=1)


def test_a_listed_name_that_would_leave_the_folder_is_skipped_not_written(tmp_path):
    class HostileList:
        def __init__(self, inner):
            self.inner = inner

        def list(self, prefix):
            return self.inner.list(prefix) + [prefix + "../../escape.png", prefix + "crops/./x.png", prefix + "crops//y.png", prefix + "dir/"]

        def get_file(self, key, dest):
            assert "escape" not in key and "x.png" not in key and "y.png" not in key, f"asked for {key}"
            return self.inner.get_file(key, dest)

    store, _db, _info = env_with_bundle(tmp_path)
    result = fetch_bundle(HostileList(store), PREFIX, tmp_path / "work")
    assert result.images == 4 and result.skipped == 2 + 3
    assert not (tmp_path / "escape.png").exists() and not (tmp_path / "work" / ".." / "escape.png").exists()


def test_downloads_run_in_parallel_without_losing_a_file(tmp_path):
    store, _db, _info = env_with_bundle(tmp_path, n_items=12)
    seen_threads = set()

    class Spy:
        def __init__(self, inner):
            self.inner = inner

        def list(self, prefix):
            return self.inner.list(prefix)

        def get_file(self, key, dest):
            seen_threads.add(threading.get_ident())
            return self.inner.get_file(key, dest)

    result = fetch_bundle(Spy(store), PREFIX, tmp_path / "work", workers=4)
    assert result.images == 12 and result.files == 13
    assert result.bytes == sum(p.stat().st_size for p in (tmp_path / "work").rglob("*") if p.is_file())


# ------------------------------------------------------------------------------------------------------------------------ the whole import
def test_import_publishes_and_puts_the_release_on_the_volume(tmp_path):
    store, db, info = env_with_bundle(tmp_path)
    committed = []
    outcome = run_bucket_import(db=db, store=store, cfg=CFG, catalogue=CAT, prefix=PREFIX, workdir=tmp_path / "work", activate=True,
                                cache_dir=tmp_path / "volume", commit_cache=lambda: committed.append(1))
    assert outcome.ok and outcome.items == 4 and outcome.activated and not outcome.seed_error
    assert db.get_catalogue(CAT)["activeRelease"] == outcome.release_id
    assert outcome.fetched["images"] == 4
    assert outcome.seeded == {"catalogue": CAT, "releaseId": outcome.release_id, "items": 4, "source": "download"}
    assert (tmp_path / "volume" / CAT / outcome.release_id / "manifest.json").is_file() and committed == [1]
    item = db.get_items(CAT)[info.item_ids[0]]
    assert item["images"]["crop"]["key"] == f"crops/{CAT}/{info.item_ids[0]}.png" and store.exists(item["images"]["crop"]["key"])
    assert outcome.as_dict()["releaseId"] == outcome.release_id


def test_after_an_import_a_search_container_reads_the_volume_and_asks_the_bucket_for_nothing(tmp_path):
    """The point of the feature: the release is on the volume, so loading it later downloads nothing."""
    store, db, _info = env_with_bundle(tmp_path)
    outcome = run_bucket_import(db=db, store=store, cfg=CFG, catalogue=CAT, prefix=PREFIX, workdir=tmp_path / "work", cache_dir=tmp_path / "volume")
    watching = RecordingStore(store)
    loaded = load_release(watching, CAT, outcome.release_id, tmp_path / "volume", compute_feature_versions(CFG), CFG)
    assert loaded.source == "cache" and loaded.n_items == 4
    assert watching.calls == []


def test_without_a_volume_the_import_still_publishes(tmp_path):
    store, db, _info = env_with_bundle(tmp_path)
    outcome = run_bucket_import(db=db, store=store, cfg=CFG, catalogue=CAT, prefix=PREFIX, workdir=tmp_path / "work")
    assert outcome.ok and outcome.seeded is None and outcome.seed_error is None and not outcome.activated
    assert db.get_catalogue(CAT)["activeRelease"] is None            # stored, not live: the owner looks first


def test_a_volume_that_cannot_be_written_does_not_undo_a_good_publish(tmp_path):
    store, db, _info = env_with_bundle(tmp_path)
    not_a_folder = tmp_path / "volume"
    not_a_folder.write_text("a file where the cache folder should be")
    outcome = run_bucket_import(db=db, store=store, cfg=CFG, catalogue=CAT, prefix=PREFIX, workdir=tmp_path / "work", activate=True, cache_dir=not_a_folder)
    assert outcome.ok and outcome.activated and outcome.seeded is None and outcome.seed_error
    assert db.get_catalogue(CAT)["activeRelease"] == outcome.release_id


def test_importing_the_same_folder_twice_changes_nothing_and_finds_the_volume_ready(tmp_path):
    store, db, _info = env_with_bundle(tmp_path)
    first = run_bucket_import(db=db, store=store, cfg=CFG, catalogue=CAT, prefix=PREFIX, workdir=tmp_path / "w1", cache_dir=tmp_path / "volume")
    second = run_bucket_import(db=db, store=store, cfg=CFG, catalogue=CAT, prefix=PREFIX, workdir=tmp_path / "w2", cache_dir=tmp_path / "volume")
    assert second.release_id == first.release_id and second.release_reused
    assert second.seeded["source"] == "cache"


def test_the_catalogue_must_exist_unless_the_owner_says_to_create_it(tmp_path):
    store, db, _info = env_with_bundle(tmp_path)
    watching = RecordingStore(store)
    with pytest.raises(BucketImportError, match="does not exist"):
        run_bucket_import(db=db, store=watching, cfg=CFG, catalogue="new-colours", prefix=PREFIX, workdir=tmp_path / "w1")
    assert db.get_catalogue("new-colours") is None and not [c for c in watching.calls if c[0] in ("get_file", "put_bytes", "put_file")]
    store2, db2, _ = env_with_bundle(tmp_path / "again", prefix="imports/new-colours/run1/")
    outcome = run_bucket_import(db=db2, store=store2, cfg=CFG, catalogue="new-colours", prefix="imports/new-colours/run1/", workdir=tmp_path / "w2",
                                create_name="New colours")
    assert outcome.created_catalogue and db2.get_catalogue("new-colours")["name"] == "New colours"


def test_a_damaged_bundle_in_the_bucket_publishes_nothing_and_seeds_nothing(tmp_path):
    store, db = new_environment(tmp_path)
    info = make_bundle(tmp_path / "kaggle-output", 3, legacy_kaggle_paths=True)
    flip_crop_byte(info, info.item_ids[1])
    upload_folder(store, info.path, PREFIX)
    before = sorted(store.list(""))
    with pytest.raises(PublishError):
        run_bucket_import(db=db, store=store, cfg=CFG, catalogue=CAT, prefix=PREFIX, workdir=tmp_path / "work", activate=True, cache_dir=tmp_path / "volume")
    assert sorted(store.list("")) == before and db.get_catalogue(CAT)["activeRelease"] is None
    assert not (tmp_path / "volume").exists()


def test_the_original_pdf_is_kept_in_the_bucket_when_asked(tmp_path):
    store, db, info = env_with_bundle(tmp_path)
    store.put_file(PREFIX + info.pdf_name, info.pdf_path)
    without = run_bucket_import(db=db, store=store, cfg=CFG, catalogue=CAT, prefix=PREFIX, workdir=tmp_path / "w1")
    assert without.fetched["pdfs"] == 0 and not [k for k in store.list("sources/")]
    outcome = run_bucket_import(db=db, store=store, cfg=CFG, catalogue=CAT, prefix=PREFIX, workdir=tmp_path / "w2", include_pdfs=True)
    assert outcome.fetched["pdfs"] == 1 and any(k.startswith(f"sources/{info.pdf_sha256}/") for k in store.list("sources/"))


# ------------------------------------------------------------------------------------------------------------------------ after an admin upload, and priming
def test_seeding_a_release_that_exists_is_idempotent_and_checked(tmp_path):
    store, db, _info = env_with_bundle(tmp_path)
    published = run_bucket_import(db=db, store=store, cfg=CFG, catalogue=CAT, prefix=PREFIX, workdir=tmp_path / "work")
    first = seed_release_cache(store, CAT, published.release_id, tmp_path / "volume", CFG)
    again = seed_release_cache(store, CAT, published.release_id, tmp_path / "volume", CFG)
    assert (first.source, again.source, first.n_items) == ("download", "cache", 4)
    key = f"releases/{CAT}/{published.release_id}/pillars/siglip.npy"
    data = bytearray(store.get_bytes(key))
    data[-4] ^= 0xFF
    store.put_bytes(key, bytes(data))
    with pytest.raises(Exception):                                  # a release that fails its own sha256 never reaches the volume
        seed_release_cache(store, CAT, published.release_id, tmp_path / "volume2", CFG)
    assert not (tmp_path / "volume2" / CAT / published.release_id).exists()


def test_seed_after_ingest_follows_the_job_to_its_catalogue_and_never_raises(tmp_path):
    store, db, _info = env_with_bundle(tmp_path)
    published = run_bucket_import(db=db, store=store, cfg=CFG, catalogue=CAT, prefix=PREFIX, workdir=tmp_path / "work")
    db.insert_job({"_id": "job-20261101120000-abc123", "catalogue": CAT, "status": "succeeded"})
    ok = {"ok": True, "status": "succeeded", "jobId": "job-20261101120000-abc123", "releaseId": published.release_id}
    seeded = seed_after_ingest(ok, db=db, store=store, cfg=CFG, cache_dir=tmp_path / "volume")
    assert seeded == {"catalogue": CAT, "releaseId": published.release_id, "items": 4, "source": "download"}
    assert seed_after_ingest({**ok, "ok": False}, db=db, store=store, cfg=CFG, cache_dir=tmp_path / "volume") is None
    assert seed_after_ingest({**ok, "releaseId": None}, db=db, store=store, cfg=CFG, cache_dir=tmp_path / "volume") is None
    assert seed_after_ingest({**ok, "jobId": "job-20261101120000-ffffff"}, db=db, store=store, cfg=CFG, cache_dir=tmp_path / "volume") is None
    broken = seed_after_ingest({**ok, "releaseId": "rel-20261101120000-000000"}, db=db, store=store, cfg=CFG, cache_dir=tmp_path / "volume")
    assert set(broken) == {"error"}


def test_prime_copies_the_live_release_and_the_one_before_it(tmp_path):
    store, db = new_environment(tmp_path)
    first = make_bundle(tmp_path / "b1", 3, legacy_kaggle_paths=True, seed=1)
    upload_folder(store, first.path, "imports/superbond-colour/one/")
    one = run_bucket_import(db=db, store=store, cfg=CFG, catalogue=CAT, prefix="imports/superbond-colour/one", workdir=tmp_path / "w1", activate=True)
    second = make_bundle(tmp_path / "b2", 2, legacy_kaggle_paths=True, seed=1, first_page=4)
    upload_folder(store, second.path, "imports/superbond-colour/two/")
    two = run_bucket_import(db=db, store=store, cfg=CFG, catalogue=CAT, prefix="imports/superbond-colour/two", workdir=tmp_path / "w2", activate=True)
    assert two.release_id != one.release_id and two.items == 5

    primed = prime_volume(db=db, store=store, cfg=CFG, catalogue=CAT, cache_dir=tmp_path / "volume")
    assert [(p.release_id, p.n_items) for p in primed] == [(two.release_id, 5), (one.release_id, 3)]
    assert [p.release_id for p in prime_volume(db=db, store=store, cfg=CFG, catalogue=CAT, cache_dir=tmp_path / "v2", include_previous=False)] == [two.release_id]
    assert [p.release_id for p in prime_volume(db=db, store=store, cfg=CFG, catalogue=CAT, cache_dir=tmp_path / "v3", release=one.release_id)] == [one.release_id]


def test_prime_says_plainly_what_is_missing(tmp_path):
    store, db = new_environment(tmp_path)
    with pytest.raises(BucketImportError, match="no live release"):
        prime_volume(db=db, store=store, cfg=CFG, catalogue=CAT, cache_dir=tmp_path / "volume")
    with pytest.raises(BucketImportError, match="does not exist"):
        prime_volume(db=db, store=store, cfg=CFG, catalogue="nope-here", cache_dir=tmp_path / "volume")
    with pytest.raises(BucketImportError):
        prime_volume(db=db, store=store, cfg=CFG, catalogue="Not A Slug", cache_dir=tmp_path / "volume")


def test_this_module_needs_no_heavy_library(tmp_path):
    """It runs in a CPU function: importing it must not pull in torch, transformers, the Google SDKs or pymongo (OpenCV comes in through util.py and is fine)."""
    import subprocess
    import sys

    code = ("import sys; sys.path.insert(0, %r)\n"
            "import terucon_catalogue.bucket_import\n"
            "print([m for m in ('torch','transformers','torchvision','google.genai','google.cloud.storage','pymongo','fitz','pymupdf') if m in sys.modules])\n"
            % str(Path(bucket_import.__file__).resolve().parent.parent))
    result = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, timeout=120)
    assert result.returncode == 0, result.stderr[-1500:]
    assert result.stdout.strip() == "[]"
