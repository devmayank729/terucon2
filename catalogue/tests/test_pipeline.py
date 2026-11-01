"""run_compute end to end with fakes (no model, no Google service, no network): the tables it fills, the numbers it reports, the progress it
emits, cancellation in every stage, idempotence, resume from a restored snapshot, and the single-file bundle.
"""
import contextlib
import json
import shutil
import sqlite3
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import pdf_factory as factory  # noqa: E402
from fakes_compute import FakeEncoders, FakeManager, FakeResponse, make_cfg  # noqa: E402

from terucon_catalogue import __version__  # noqa: E402
from terucon_catalogue import pipeline  # noqa: E402
from terucon_catalogue.config import compute_caption_version, compute_feature_versions  # noqa: E402
from terucon_catalogue.pipeline import STAGES, Cancelled, ComputeResult, prepare_resume, run_compute  # noqa: E402
from terucon_catalogue.state import StateStore  # noqa: E402
from terucon_catalogue.util import sha256_file  # noqa: E402

PILLAR_DIMS = {"dino": 3072, "siglip": 1152, "color": 396, "vertex_mm": 1408, "text": 768}


def read(database, sql, parameters=()):
    with contextlib.closing(sqlite3.connect(str(database))) as connection:
        connection.row_factory = sqlite3.Row
        return [dict(row) for row in connection.execute(sql, parameters)]


def digest(database):
    """Every table's content without the timestamps: two equal digests = the run changed nothing."""
    out = {}
    for table in ("pdfs", "pages", "items", "orphan_ids", "embeddings", "feature_errors", "captions"):
        rows = read(database, f"SELECT * FROM {table}")
        out[table] = sorted(json.dumps({k: (v.hex() if isinstance(v, bytes) else v) for k, v in row.items() if k not in ("updated_at", "created_at")},
                                       sort_keys=True) for row in rows)
    return out


@pytest.fixture()
def grid(tmp_path):
    return factory.grid_with_labels(tmp_path / "grid.pdf")        # 2 pages, 9 items, every item has a product id, one orphan id


def compute(tmp_path, grid, work="w", encoders=None, manager=None, **kwargs):
    kwargs.setdefault("pdfs", [grid["path"]])
    return run_compute(make_cfg(), work_dir=tmp_path / work, encoders=encoders if encoders is not None else FakeEncoders(),
                       manager=manager if manager is not None else FakeManager(), **kwargs)


# ---------------------------------------------------------------------------------------------------------------------
def test_a_full_run_fills_every_table_and_reports_the_counts(tmp_path, grid):
    encoders, manager = FakeEncoders(), FakeManager()
    config = make_cfg()
    result = run_compute(config, pdfs=[grid["path"]], work_dir=tmp_path / "w", encoders=encoders, manager=manager)
    database = tmp_path / "w" / "state.sqlite"

    assert isinstance(result, ComputeResult) and result.work_dir == tmp_path / "w"
    assert (result.n_items, result.n_pages, result.unmatched, result.failed_pages, result.warnings) == (9, 2, 0, [], [])
    assert [(p["name"], p["pages"], p["status"], p["kind"], p["segmented"]) for p in result.pdfs] == [("grid.pdf", 2, "done", "pdf", False)]
    assert result.pdfs[0]["sha256"] == sha256_file(grid["path"])
    assert {name: info["status"] for name, info in result.stages.items()} == {name: "done" for name in STAGES}
    assert [result.stages[s]["processed"] for s in ("extract", "features", "vertex_mm", "captions", "text_vectors")] == [2, 9, 9, 9, 9]   # pages, then items
    assert config.work_dir == Path("work")                      # the caller's cfg is not modified: work_dir is an argument

    # the notebook's tables, populated consistently
    counts = {t: read(database, f"SELECT COUNT(*) AS n FROM {t}")[0]["n"] for t in ("pdfs", "pages", "items", "captions", "embeddings", "feature_errors",
                                                                                       "orphan_ids", "renders")}
    assert counts == {"pdfs": 1, "pages": 2, "items": 9, "captions": 9, "embeddings": 45, "feature_errors": 0, "orphan_ids": 1, "renders": 0}
    versions = compute_feature_versions(config)
    for pillar, dim in PILLAR_DIMS.items():
        rows = read(database, "SELECT item_id, feature_version, dim, dtype FROM embeddings WHERE pillar = ?", (pillar,))
        assert len(rows) == 9 and {(r["feature_version"], r["dim"], r["dtype"]) for r in rows} == {(versions[pillar], dim, "float16")}
    # vectors are unit length (stored as float16) and the colour rows carry their metadata
    import numpy as np
    for row in read(database, "SELECT pillar, vector FROM embeddings"):
        vector = np.frombuffer(row["vector"], dtype=np.float16).astype(np.float32)
        assert abs(float(np.linalg.norm(vector)) - 1.0) < 5e-3, row["pillar"]
    color = read(database, "SELECT extra_json FROM embeddings WHERE pillar = 'color'")
    assert all(0 < len(json.loads(r["extra_json"])["dominant_hex"]) <= 3 for r in color)
    # captions: all ok, with the current caption version; what is embedded as text IS the stored search_text
    captions = read(database, "SELECT * FROM captions")
    assert {c["status"] for c in captions} == {"ok"} and {c["caption_version"] for c in captions} == {compute_caption_version(config)}
    assert sorted(t for t, _ in manager.embedded_texts) == sorted(c["search_text"] for c in captions)
    assert {task for _, task in manager.embedded_texts} == {"RETRIEVAL_DOCUMENT"}
    # every fake was used exactly once per item
    assert (encoders.calls["dino_images"], encoders.calls["siglip_images"]) == (9, 9)
    assert dict(manager.calls) == {"multimodal_embed": 9, "caption": 9, "embed_text": 9}


def test_the_bundle_is_complete_in_state_sqlite_alone_and_bundle_json_describes_it(tmp_path, grid):
    config = make_cfg()
    result = run_compute(config, pdfs=[grid["path"]], work_dir=tmp_path / "w", encoders=FakeEncoders(), manager=FakeManager())
    work = tmp_path / "w"
    # the WAL is folded into the one file: copy ONLY state.sqlite (as the publisher does) and every row is there
    wal = work / "state.sqlite-wal"
    assert not wal.exists() or wal.stat().st_size == 0
    lone = tmp_path / "lone" / "state.sqlite"
    lone.parent.mkdir()
    shutil.copy(work / "state.sqlite", lone)
    assert read(lone, "SELECT COUNT(*) AS n FROM items")[0]["n"] == 9 and read(lone, "SELECT COUNT(*) AS n FROM embeddings")[0]["n"] == 45
    assert read(lone, "PRAGMA integrity_check") == [{"integrity_check": "ok"}]
    # crops/ is next to it, relative paths resolve
    for row in read(lone, "SELECT crop_filepath, sha256_hash FROM items"):
        assert sha256_file(work / row["crop_filepath"]) == row["sha256_hash"]
    bundle = json.loads((work / "bundle.json").read_text())
    assert bundle["schema"] == 1 and bundle["package"] == {"name": "terucon_catalogue", "version": __version__}
    assert isinstance(bundle["createdAt"], int) and bundle["createdAt"] > 1_700_000_000_000          # epoch milliseconds
    assert bundle["featureVersions"] == compute_feature_versions(config)
    assert bundle["pdfs"] == [{"name": "grid.pdf", "sha256": result.pdfs[0]["sha256"], "pages": 2, "status": "done"}]
    assert set(bundle["stages"]) == set(STAGES) and bundle["stages"]["captions"]["status"] == "done"


def test_a_second_run_makes_no_model_call_and_no_api_call_and_changes_nothing(tmp_path, grid, monkeypatch):
    encoders, manager = FakeEncoders(), FakeManager()
    first = run_compute(make_cfg(), pdfs=[grid["path"]], work_dir=tmp_path / "w", encoders=encoders, manager=manager)
    database = tmp_path / "w" / "state.sqlite"
    before, calls = digest(database), (dict(encoders.calls), dict(manager.calls))
    # no encoders given and the real ones must not even be built (they would load two models) when nothing is pending
    monkeypatch.setattr(pipeline, "_default_encoders", lambda cfg: pytest.fail("the models were loaded although nothing was pending"))
    second = run_compute(make_cfg(), pdfs=[grid["path"]], work_dir=tmp_path / "w", encoders=None, manager=manager)
    assert (dict(encoders.calls), dict(manager.calls)) == calls
    assert digest(database) == before
    assert (second.n_items, second.n_pages, second.unmatched, second.failed_pages, second.warnings) == (first.n_items, first.n_pages, first.unmatched, [], [])
    assert second.pdfs[0]["sha256"] == first.pdfs[0]["sha256"]
    assert all(second.stages[s]["processed"] == 0 for s in STAGES) and second.stages["extract"]["pending"] == 2
    assert {p["attempts"] for p in read(database, "SELECT attempts FROM pages")} == {1}


def test_progress_events_come_in_stage_order_at_every_batch_and_end_complete(tmp_path, grid):
    events = []
    run_compute(make_cfg(), pdfs=[grid["path"]], work_dir=tmp_path / "w", encoders=FakeEncoders(), manager=FakeManager(),
                progress=lambda stage, done, total, message: events.append((stage, done, total, message)))
    assert all(isinstance(e[1], int) and isinstance(e[2], int) and isinstance(e[3], str) for e in events)
    order = [stage for i, (stage, *_rest) in enumerate(events) if i == 0 or events[i - 1][0] != stage]
    assert order == list(STAGES)                                               # each stage once, contiguous, in the notebook's order
    for stage in STAGES:
        mine = [e for e in events if e[0] == stage]
        assert mine[0][1] == 0 and mine[-1][3] == "done" and mine[-1][1] == mine[-1][2] > 0     # starts at 0, ends complete
        dones = [e[1] for e in mine]
        assert dones == sorted(dones)
    # a progress event before every batch: batches of 2 items over 9 items
    for stage in ("features", "vertex_mm", "captions", "text_vectors"):
        assert {0, 2, 4, 6, 8, 9} <= {e[1] for e in events if e[0] == stage}
    extract = [e for e in events if e[0] == "extract"]
    assert {1, 2} <= {e[1] for e in extract} and all(e[2] == 2 for e in extract if e[2]) and any("grid.pdf" in e[3] for e in extract)


@pytest.mark.parametrize("stage", STAGES)
def test_cancelling_in_any_stage_leaves_consistent_work_that_the_next_run_continues(tmp_path, grid, stage):
    encoders, manager = FakeEncoders(), FakeManager()
    seen = {"batches": 0}

    def progress(name, done, total, message):
        if name == stage and done > 0:
            seen["batches"] += 1

    with pytest.raises(Cancelled):
        run_compute(make_cfg(), pdfs=[grid["path"]], work_dir=tmp_path / "w", encoders=encoders, manager=manager, progress=progress,
                    should_cancel=lambda: seen["batches"] >= 1)             # after the first batch of this stage has been committed
    database = tmp_path / "w" / "state.sqlite"
    assert read(database, "PRAGMA integrity_check") == [{"integrity_check": "ok"}]
    if stage == "extract":
        assert read(database, "SELECT status FROM pages") == [{"status": "done"}] and read(database, "SELECT status FROM pdfs") == [{"status": "in_progress"}]
    else:
        # exactly one whole batch of 2 items was committed, never a half batch
        expected = {"features": ("pillar IN ('dino','siglip','color')", 6), "vertex_mm": ("pillar = 'vertex_mm'", 2),
                    "captions": ("pillar = 'text' OR 0", 0), "text_vectors": ("pillar = 'text'", 2)}[stage]
        if stage == "captions":
            assert read(database, "SELECT COUNT(*) AS n FROM captions")[0]["n"] == 2
        else:
            assert read(database, f"SELECT COUNT(*) AS n FROM embeddings WHERE {expected[0]}")[0]["n"] == expected[1]
    # carry on: the finished work is not repeated, the rest is done, every item has all five pillars
    result = run_compute(make_cfg(), pdfs=[grid["path"]], work_dir=tmp_path / "w", encoders=encoders, manager=manager)
    assert (result.n_items, result.warnings) == (9, [])
    assert read(database, "SELECT COUNT(*) AS n FROM embeddings")[0]["n"] == 45
    assert (encoders.calls["dino_images"], encoders.calls["siglip_images"]) == (9, 9)
    assert dict(manager.calls) == {"multimodal_embed": 9, "caption": 9, "embed_text": 9}
    assert {p["attempts"] for p in read(database, "SELECT attempts FROM pages")} == {1}


def test_cancelling_before_anything_starts_writes_no_items(tmp_path, grid):
    with pytest.raises(Cancelled):
        run_compute(make_cfg(), pdfs=[grid["path"]], work_dir=tmp_path / "w", encoders=FakeEncoders(), manager=FakeManager(), should_cancel=lambda: True)
    assert read(tmp_path / "w" / "state.sqlite", "SELECT COUNT(*) AS n FROM items")[0]["n"] == 0
    assert not (tmp_path / "w" / "bundle.json").exists()                       # only a finished run writes bundle.json


def test_resume_from_a_restored_snapshot_with_the_crops_gone_repeats_no_paid_work(tmp_path, grid):
    first_encoders, first_manager = FakeEncoders(), FakeManager()
    first = run_compute(make_cfg(), pdfs=[grid["path"]], work_dir=tmp_path / "w1", encoders=first_encoders, manager=first_manager)
    original = read(tmp_path / "w1" / "state.sqlite", "SELECT item_id, sha256_hash, crop_filepath FROM items ORDER BY item_id")
    original_crops = {row["item_id"]: (tmp_path / "w1" / row["crop_filepath"]).read_bytes() for row in original}
    original_embeddings = read(tmp_path / "w1" / "state.sqlite", "SELECT item_id, pillar, hex(vector) AS v FROM embeddings ORDER BY item_id, pillar")
    shutil.rmtree(tmp_path / "w1" / "crops")

    # what a failed job leaves in GCS: the snapshot. Restore it into an empty work_dir, mark the pages pending, run again
    store = StateStore(tmp_path / "w1" / "state.sqlite")
    store.snapshot_to(tmp_path / "snapshot" / "state.sqlite")
    store.close()
    (tmp_path / "w2").mkdir()
    shutil.copy(tmp_path / "snapshot" / "state.sqlite", tmp_path / "w2" / "state.sqlite")
    assert prepare_resume(tmp_path / "w2") == {"pagesCleared": 2, "pdfsReset": 1}
    assert read(tmp_path / "w2" / "state.sqlite", "SELECT COUNT(*) AS n FROM pages")[0]["n"] == 0
    assert read(tmp_path / "w2" / "state.sqlite", "SELECT status FROM pdfs") == [{"status": "in_progress"}]

    encoders, manager = FakeEncoders(), FakeManager()      # fresh counters: they must stay at zero
    resumed = run_compute(make_cfg(), pdfs=[grid["path"]], work_dir=tmp_path / "w2", encoders=encoders, manager=manager)
    assert encoders.total_calls == 0 and manager.total_calls == 0
    assert read(tmp_path / "w2" / "state.sqlite", "SELECT item_id, sha256_hash, crop_filepath FROM items ORDER BY item_id") == original
    for item_id, data in original_crops.items():                 # the crops came back bit-identically
        assert (tmp_path / "w2" / next(r["crop_filepath"] for r in original if r["item_id"] == item_id)).read_bytes() == data
    assert read(tmp_path / "w2" / "state.sqlite", "SELECT item_id, pillar, hex(vector) AS v FROM embeddings ORDER BY item_id, pillar") == original_embeddings
    assert (resumed.n_items, resumed.warnings) == (first.n_items, [])


def test_a_restored_snapshot_without_prepare_resume_is_reported_not_silently_accepted(tmp_path, grid):
    run_compute(make_cfg(), pdfs=[grid["path"]], work_dir=tmp_path / "w1", encoders=FakeEncoders(), manager=FakeManager())
    (tmp_path / "w2").mkdir()
    shutil.copy(tmp_path / "w1" / "state.sqlite", tmp_path / "w2" / "state.sqlite")     # state without crops/, pages still 'done'
    result = run_compute(make_cfg(), pdfs=[grid["path"]], work_dir=tmp_path / "w2", encoders=FakeEncoders(), manager=FakeManager())
    assert any("9 crop file(s)" in w and "prepare_resume" in w for w in result.warnings)
    assert prepare_resume(tmp_path / "nowhere") == {"pagesCleared": 0, "pdfsReset": 0}      # nothing to prepare, nothing created
    assert not (tmp_path / "nowhere").exists()


def test_without_a_manager_the_vertex_stages_are_skipped_with_a_warning(tmp_path, grid):
    encoders = FakeEncoders()
    result = run_compute(make_cfg(), pdfs=[grid["path"]], work_dir=tmp_path / "w", encoders=encoders, manager=None)
    database = tmp_path / "w" / "state.sqlite"
    assert [result.stages[s]["status"] for s in STAGES] == ["done", "done", "skipped", "skipped", "skipped"]
    assert len(result.warnings) == 1 and "No Vertex AI manager" in result.warnings[0]
    assert read(database, "SELECT COUNT(*) AS n FROM embeddings")[0]["n"] == 27 and read(database, "SELECT COUNT(*) AS n FROM captions")[0]["n"] == 0
    assert result.n_items == 9


def test_stages_can_be_chosen_and_always_run_in_the_notebooks_order(tmp_path, grid):
    encoders, manager = FakeEncoders(), FakeManager()
    only_extract = run_compute(make_cfg(), pdfs=[grid["path"]], work_dir=tmp_path / "w", encoders=encoders, manager=manager, stages=("extract",))
    assert only_extract.n_items == 9 and encoders.total_calls == 0 and manager.total_calls == 0
    assert [only_extract.stages[s]["status"] for s in STAGES] == ["done"] + ["not-requested"] * 4
    # no inputs given: the stages work on what the work_dir already holds; the order asked for does not matter
    events = []
    later = run_compute(make_cfg(), pdfs=[], work_dir=tmp_path / "w", encoders=encoders, manager=manager, stages=("text_vectors", "captions", "features"),
                        progress=lambda stage, *rest: events.append(stage))
    assert [s for i, s in enumerate(events) if i == 0 or events[i - 1] != s] == ["features", "captions", "text_vectors"]
    assert later.n_items == 9 and [p["name"] for p in later.pdfs] == ["grid.pdf"] and encoders.calls["dino_images"] == 9
    assert manager.calls["multimodal_embed"] == 0                                   # vertex_mm was not asked for
    with pytest.raises(ValueError, match="Unknown stage"):
        run_compute(make_cfg(), pdfs=[], work_dir=tmp_path / "w", stages=("extract", "index"))


def test_a_failed_caption_is_reported_and_retried_on_the_next_run_only(tmp_path, grid):
    failing = {"digest": None}

    def behaviour(call_index, digest_):
        if failing["digest"] is None:
            failing["digest"] = digest_
        return FakeResponse(text=None, finish_reason="SAFETY") if digest_ == failing["digest"] else None

    manager = FakeManager(caption_behaviour=behaviour)
    encoders = FakeEncoders()
    result = run_compute(make_cfg(), pdfs=[grid["path"]], work_dir=tmp_path / "w", encoders=encoders, manager=manager)
    database = tmp_path / "w" / "state.sqlite"
    assert result.stages["captions"]["failed"] == 1 and any("1 caption(s) failed" in w for w in result.warnings)
    assert sorted(r["status"] for r in read(database, "SELECT status FROM captions")) == ["error"] + ["ok"] * 8
    assert "finish_reason=SAFETY" in read(database, "SELECT error FROM captions WHERE status = 'error'")[0]["error"]
    assert read(database, "SELECT COUNT(*) AS n FROM embeddings WHERE pillar = 'text'")[0]["n"] == 8
    before = dict(manager.calls)
    run_compute(make_cfg(), pdfs=[grid["path"]], work_dir=tmp_path / "w", encoders=encoders, manager=manager)
    assert manager.calls["caption"] == before["caption"] + 1 and manager.calls["multimodal_embed"] == before["multimodal_embed"]    # one item retried


def test_a_broken_progress_sink_or_cancel_poll_does_not_stop_the_run_but_a_cancelled_raised_from_progress_does(tmp_path, grid):
    def broken_progress(*args):
        raise RuntimeError("database blip")

    def broken_cancel():
        raise RuntimeError("database blip")

    result = run_compute(make_cfg(), pdfs=[grid["path"]], work_dir=tmp_path / "w", encoders=FakeEncoders(), manager=FakeManager(),
                         progress=broken_progress, should_cancel=broken_cancel)
    assert result.n_items == 9 and result.stages["captions"]["status"] == "done"

    def cancelling_progress(stage, done, total, message):
        if stage == "captions" and done > 0:
            raise Cancelled("stop")

    with pytest.raises(Cancelled):
        run_compute(make_cfg(), pdfs=[grid["path"]], work_dir=tmp_path / "w2", encoders=FakeEncoders(), manager=FakeManager(), progress=cancelling_progress)


def test_inputs_are_checked_and_duplicates_are_processed_once(tmp_path, grid):
    with pytest.raises(FileNotFoundError):
        run_compute(make_cfg(), pdfs=[tmp_path / "missing.pdf"], work_dir=tmp_path / "w", encoders=FakeEncoders(), manager=None)
    copy = tmp_path / "copy of grid.pdf"
    shutil.copy(grid["path"], copy)
    result = run_compute(make_cfg(), pdfs=[grid["path"], copy], work_dir=tmp_path / "w2", encoders=FakeEncoders(), manager=None, stages=("extract",))
    assert [p["name"] for p in result.pdfs] == ["grid.pdf"] and any("same content" in w for w in result.warnings)
    folder = tmp_path / "folder"
    folder.mkdir()
    shutil.copy(grid["path"], folder / "x.pdf")
    by_folder = run_compute(make_cfg(), pdfs=[folder], work_dir=tmp_path / "w3", encoders=FakeEncoders(), manager=None, stages=("extract",))
    assert [p["name"] for p in by_folder.pdfs] == ["x.pdf"] and by_folder.n_items == 9
    empty = tmp_path / "empty"
    empty.mkdir()
    nothing = run_compute(make_cfg(), pdfs=[empty], work_dir=tmp_path / "w4", encoders=FakeEncoders(), manager=None, stages=("extract",))
    assert nothing.n_items == 0 and nothing.pdfs == [] and any("no PDF files" in w for w in nothing.warnings)
