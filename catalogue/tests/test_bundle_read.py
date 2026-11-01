"""Reading bundles: this package's own (relative paths) and the notebook's as it came off Kaggle (absolute /kaggle/working/... paths), which is the
owner's real situation. Plus: the database is never touched in place, WAL files are honoured, and a crop is never taken from outside the folder."""
import hashlib
import os
import shutil
import sqlite3
import time
from pathlib import Path

import numpy as np
import pytest

from factories import KAGGLE_PDF_PATH, PDF_NAME, REAL_BBOX, REAL_DIMS, make_bundle
from terucon_catalogue.bundle import Bundle, BundleError, display_name
from terucon_catalogue.config import PipelineConfig, compute_feature_versions


def _sha(path: Path) -> str:
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


@pytest.fixture(params=[False, True], ids=["relative-paths", "kaggle-absolute-paths"])
def bundle_info(request, tmp_path):
    return make_bundle(tmp_path / "bundle", 5, legacy_kaggle_paths=request.param, product_ids={1: "SB804"})


def test_items_are_typed_and_joined_with_captions_and_colour(bundle_info):
    with Bundle(bundle_info.path) as bundle:
        items = list(bundle.items())
        assert [item.item_id for item in items] == sorted(bundle_info.item_ids) == bundle_info.item_ids
        first, second = items[0], items[1]
        assert first.status == "ok" and first.product_id is None and first.page_number == 1 and first.item_index == 0
        assert second.product_id == "SB804" and second.match_type == "single_image"
        assert first.image_bbox == REAL_BBOX and first.id_bbox is None
        assert first.pdf_sha256 == bundle_info.pdf_sha256 and first.item_id.startswith(bundle_info.pdf_sha256[:12])
        assert first.source_name == PDF_NAME == display_name(first.source_pdf)
        assert first.sha256 == _sha(bundle_info.crop_paths[first.item_id]) and first.crop_path == bundle_info.crop_paths[first.item_id].resolve()
        assert (first.crop_width, first.crop_height) == (48, 64) and first.crop_suffix == ".png"
        assert first.color["dominant_hex"][:2] == ["#4C4C4E", "#F2EFEF"] and first.color["proportions"] == [0.5, 0.3, 0.2] and len(first.color["dominant_lab"]) == 3
        assert first.caption["status"] == "ok" and first.caption["model"] == "gemini-2.5-flash" and first.caption["profile"]["material_category"] == "stone"
        assert first.caption["profile"]["material_subtype"] == "polished black marble 0" and first.caption["search_text"].startswith("Material: stone")
        assert first.pillars == frozenset(REAL_DIMS) and first.is_searchable
        assert bundle.unmatched_count() == 4


def test_the_two_path_styles_are_what_the_notebook_and_this_package_write(bundle_info):
    with Bundle(bundle_info.path) as bundle:
        item = next(iter(bundle.items()))
        if bundle_info.legacy:
            assert item.crop_filepath == f"/kaggle/working/crops/{bundle_info.crop_dir}/{item.item_id}.png"
            assert item.source_pdf == KAGGLE_PDF_PATH and bundle.path_style(item.crop_filepath) == "absolute-kaggle"
        else:
            assert item.crop_filepath == f"crops/{bundle_info.crop_dir}/{item.item_id}.png" and item.source_pdf == PDF_NAME
            assert bundle.path_style(item.crop_filepath) == "relative"
        assert item.crop_path is not None and item.crop_path.is_file()


def test_vectors_are_the_stored_float16_numbers_as_float32_in_the_real_sizes(bundle_info):
    with Bundle(bundle_info.path) as bundle:
        for pillar, dim in REAL_DIMS.items():
            rows = list(bundle.vectors(pillar))
            assert [item_id for item_id, _ in rows] == bundle_info.item_ids
            for item_id, vector in rows:
                assert vector.dtype == np.float32 and vector.shape == (dim,)
                assert np.array_equal(vector, bundle_info.vectors[pillar][item_id].astype(np.float32))      # exactly what was stored, nothing renormalised
        assert bundle.feature_versions() == compute_feature_versions(PipelineConfig())


def test_pages_pdfs_and_describe(bundle_info):
    with Bundle(bundle_info.path) as bundle:
        assert [page["page_number"] for page in bundle.pages()] == [1, 2, 3, 4, 5] and all(page["status"] == "done" for page in bundle.pages())
        (pdf,) = bundle.pdfs()
        assert pdf["sha256"] == bundle_info.pdf_sha256 and pdf["name"] == PDF_NAME and pdf["status"] == "done" and pdf["page_count"] == 5
        described = bundle.describe()
        assert described["items"] == 5 and described["crops_found"] == 5 and described["captions_ok"] == 5 and described["unmatched_product_ids"] == 4
        assert described["crop_path_styles"] == ({"absolute-kaggle": 5} if bundle_info.legacy else {"relative": 5})
        assert described["pillars"]["vertex_mm"]["dims"] == [1408] and described["pillars"]["text"]["count"] == 5


def test_only_ok_items_by_default(bundle_info):
    from factories import set_item_status

    set_item_status(bundle_info, bundle_info.item_ids[2], "error")
    with Bundle(bundle_info.path) as bundle:
        assert len(list(bundle.items())) == 4 and len(list(bundle.items(only_ok=False))) == 5
        assert bundle_info.item_ids[2] not in [item_id for item_id, _ in bundle.vectors("dino")]


# ---------------------------------------------------------------------------------------------------------- finding state.sqlite and the crops
def test_a_folder_that_holds_the_bundle_one_level_down_is_found(tmp_path):
    info = make_bundle(tmp_path / "download" / "working", 3, legacy_kaggle_paths=True)
    with Bundle(tmp_path / "download") as bundle:
        assert bundle.state_source == info.state_path and len(list(bundle.items())) == 3
        assert all(item.crop_path is not None for item in bundle.items())


def test_the_path_of_state_sqlite_itself_is_accepted(tmp_path):
    info = make_bundle(tmp_path / "b", 2)
    with Bundle(info.state_path) as bundle:
        assert len(list(bundle.items())) == 2


def test_crops_moved_to_another_folder_beneath_the_given_one_are_still_found_from_the_kaggle_paths(tmp_path):
    info = make_bundle(tmp_path / "outer" / "state-here", 3, legacy_kaggle_paths=True)
    moved = tmp_path / "outer" / "images" / "unzipped"
    moved.parent.mkdir(parents=True)
    shutil.move(str(info.path / "crops"), str(moved))
    with Bundle(tmp_path / "outer") as bundle:
        assert all(item.crop_path is not None and moved in item.crop_path.parents for item in bundle.items())
        assert bundle.verify() == []


def test_another_machines_absolute_paths_and_windows_paths_resolve_through_the_crops_folder(tmp_path):
    info = make_bundle(tmp_path / "b", 3)
    item_ids = info.item_ids
    prefixes = ["/home/someone/work/", "C:\\Users\\someone\\work\\", "/content/drive/MyDrive/run-2/"]
    for item_id, prefix in zip(item_ids, prefixes):
        tail = f"crops/{info.crop_dir}/{item_id}.png"
        stored = prefix + (tail.replace("/", "\\") if prefix.startswith("C:") else tail)
        connection = sqlite3.connect(str(info.state_path))
        connection.execute("UPDATE items SET crop_filepath = ? WHERE item_id = ?", (stored, item_id))
        connection.commit()
        connection.close()
    with Bundle(info.path) as bundle:
        items = list(bundle.items())
        assert [bundle.path_style(item.crop_filepath) for item in items] == ["absolute-other"] * 3
        assert all(item.crop_path == info.crop_paths[item.item_id].resolve() for item in items)


def test_extra_path_prefixes_can_be_given(tmp_path):
    info = make_bundle(tmp_path / "b", 1)
    stored = f"/data/run/crops/{info.crop_dir}/{info.item_ids[0]}.png"
    connection = sqlite3.connect(str(info.state_path))
    connection.execute("UPDATE items SET crop_filepath = ?", (stored,))
    connection.commit()
    connection.close()
    with Bundle(info.path, extra_path_prefixes=["/data/run"]) as bundle:
        assert bundle.path_style(stored) == "absolute-kaggle" and next(iter(bundle.items())).crop_path is not None


def test_a_crop_that_is_not_in_the_folder_is_missing_and_a_path_cannot_leave_the_folder(tmp_path):
    info = make_bundle(tmp_path / "b", 3, legacy_kaggle_paths=True)
    secret = tmp_path / "secret.png"
    secret.write_bytes(b"not a crop")
    link_target = tmp_path / "outside-dir"
    link_target.mkdir()
    (link_target / "other.png").write_bytes(b"x")
    os.symlink(link_target, info.path / "crops" / "linked")
    connection = sqlite3.connect(str(info.state_path))
    connection.execute("UPDATE items SET crop_filepath = '../secret.png' WHERE item_id = ?", (info.item_ids[0],))
    connection.execute("UPDATE items SET crop_filepath = ? WHERE item_id = ?", (str(secret), info.item_ids[1]))
    connection.execute("UPDATE items SET crop_filepath = 'crops/linked/other.png' WHERE item_id = ?", (info.item_ids[2],))
    connection.commit()
    connection.close()
    with Bundle(info.path) as bundle:
        assert [item.crop_path for item in bundle.items()] == [None, None, None]


def test_two_crops_with_the_same_file_name_in_different_folders_are_told_apart_by_their_folder(tmp_path):
    info = make_bundle(tmp_path / "b", 1)
    original = info.crop_paths[info.item_ids[0]]
    other_dir = info.path / "crops" / "another_run_deadbeef"
    other_dir.mkdir()
    shutil.copyfile(original, other_dir / original.name)
    connection = sqlite3.connect(str(info.state_path))
    connection.execute("UPDATE items SET crop_filepath = ?", (f"/somewhere/else/{info.crop_dir}/{original.name}",))
    connection.commit()
    connection.close()
    with Bundle(info.path) as bundle:
        assert next(iter(bundle.items())).crop_path == original.resolve()


def test_nothing_to_open_is_explained(tmp_path):
    with pytest.raises(BundleError, match="does not exist"):
        Bundle(tmp_path / "nope")
    (tmp_path / "empty").mkdir()
    with pytest.raises(BundleError, match="no state.sqlite"):
        Bundle(tmp_path / "empty")
    (tmp_path / "file.txt").write_text("x")
    with pytest.raises(BundleError, match="holding state.sqlite"):
        Bundle(tmp_path / "file.txt")
    make_bundle(tmp_path / "two" / "a", 1)
    make_bundle(tmp_path / "two" / "b", 1)
    with pytest.raises(BundleError, match="2 state.sqlite files"):
        Bundle(tmp_path / "two")


def test_a_file_that_is_not_the_notebooks_database_is_explained(tmp_path):
    (tmp_path / "x").mkdir()
    (tmp_path / "x" / "state.sqlite").write_bytes(b"this is not a database at all" * 20)
    with pytest.raises(BundleError, match="not a readable SQLite"):
        Bundle(tmp_path / "x")
    (tmp_path / "y").mkdir()
    connection = sqlite3.connect(str(tmp_path / "y" / "state.sqlite"))
    connection.execute("CREATE TABLE items (item_id TEXT)")
    connection.commit()
    connection.close()
    with pytest.raises(BundleError, match="lacks the columns"):
        Bundle(tmp_path / "y")
    (tmp_path / "z").mkdir()
    sqlite3.connect(str(tmp_path / "z" / "state.sqlite")).close()
    with pytest.raises(BundleError, match="no 'items' table|no 'pdfs' table|no 'embeddings' table|not a catalogue state database"):
        Bundle(tmp_path / "z")


# ---------------------------------------------------------------------------------------------------------- read-only and the WAL
def test_the_users_files_are_never_touched(bundle_info):
    state = bundle_info.state_path
    before = (_sha(state), state.stat().st_mtime_ns, sorted(p.name for p in bundle_info.path.iterdir()))
    time.sleep(0.01)
    with Bundle(bundle_info.path) as bundle:
        list(bundle.items())
        list(bundle.vectors("dino"))
        bundle.verify()
        bundle.snapshot_to(bundle_info.path.parent / "snapshot" / "state.sqlite")
        copy_dir = Path(bundle._copy_dir.name)
        assert copy_dir.is_dir() and copy_dir not in state.parents
    after = (_sha(state), state.stat().st_mtime_ns, sorted(p.name for p in bundle_info.path.iterdir()))
    assert before == after, "state.sqlite changed, or a -wal/-shm/journal file appeared next to it"
    assert not copy_dir.exists(), "the temporary copy is removed on close"


def test_use_after_close_is_an_error_not_a_crash(bundle_info):
    bundle = Bundle(bundle_info.path)
    bundle.close()
    bundle.close()
    with pytest.raises(BundleError, match="closed"):
        list(bundle.items())


def test_committed_rows_that_live_only_in_the_wal_file_are_read(tmp_path):
    """The notebook runs SQLite in WAL mode: rows can sit in state.sqlite-wal until a checkpoint. Copy the files while a writer is still open."""
    info = make_bundle(tmp_path / "live", 4, keep_open=True)
    try:
        live = info.path
        wal = Path(str(live / "state.sqlite") + "-wal")
        assert wal.is_file() and wal.stat().st_size > 0, "the writer has not checkpointed: its rows are in the -wal file"
        (tmp_path / "copy").mkdir()
        shutil.copytree(live / "crops", tmp_path / "copy" / "crops")
        shutil.copyfile(live / "state.sqlite", tmp_path / "copy" / "state.sqlite")
        shutil.copyfile(wal, tmp_path / "copy" / "state.sqlite-wal")
        (tmp_path / "main-only").mkdir()
        shutil.copytree(live / "crops", tmp_path / "main-only" / "crops")
        shutil.copyfile(live / "state.sqlite", tmp_path / "main-only" / "state.sqlite")
    finally:
        info.store.close()
    with Bundle(tmp_path / "copy") as bundle:
        assert len(list(bundle.items())) == 4 and bundle.verify() == [] and bundle.describe()["has_wal_file"] is True
    with pytest.raises(BundleError):          # the main file alone does not hold the data: this is the hazard the copy-with-sidecars rule exists for
        Bundle(tmp_path / "main-only")


def test_a_snapshot_is_a_complete_single_file_copy_made_from_our_copy(bundle_info, tmp_path):
    destination = tmp_path / "out" / "state.sqlite"
    with Bundle(bundle_info.path) as bundle:
        result = bundle.snapshot_to(destination)
    assert result == destination and destination.is_file() and not Path(str(destination) + "-wal").exists()
    connection = sqlite3.connect(str(destination))
    counts = {table: connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] for table in ("items", "embeddings", "captions", "pages", "pdfs")}
    connection.close()
    assert counts == {"items": 5, "embeddings": 25, "captions": 5, "pages": 5, "pdfs": 1}
    with Bundle(destination) as again:                       # and it is itself a readable bundle (without crops, so the crops are "missing")
        assert len(list(again.items())) == 5


def test_a_truncated_vector_is_an_error_when_read_never_garbage(bundle_info):
    from factories import truncate_vector

    truncate_vector(bundle_info, bundle_info.item_ids[0], "dino", 100)
    with Bundle(bundle_info.path) as bundle:
        with pytest.raises(BundleError, match="dino.*needs"):
            list(bundle.vectors("dino"))
        assert len(list(bundle.vectors("siglip"))) == 5


def test_69_items_at_the_real_vector_sizes_open_and_verify_quickly(tmp_path):
    info = make_bundle(tmp_path / "real-size", 69, legacy_kaggle_paths=True)
    started = time.time()
    with Bundle(info.path) as bundle:
        items = list(bundle.items())
        count = sum(1 for pillar in REAL_DIMS for _ in bundle.vectors(pillar))
        problems = bundle.verify(PipelineConfig())
    assert len(items) == 69 and count == 69 * 5 and problems == []
    assert time.time() - started < 10
