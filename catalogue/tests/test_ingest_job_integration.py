"""run_ingest_job against the REAL neighbours it will meet: PY-C's MemoryCatalogueDb and LocalObjectStore, PY-A's photos.wrap_photo_as_pdf,
pipeline.prepare_resume and pipeline.Cancelled (resolved through the lazy defaults, not injected). compute and publish stay fakes.
Skipped (not failed) when a neighbour is not there yet."""
import copy
import sqlite3
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_ingest_job import CKPT, JOB, PDF, RELEASE, Env  # noqa: E402

mongo = pytest.importorskip("terucon_catalogue.mongo")
objectstore = pytest.importorskip("terucon_catalogue.objectstore")
pipeline = pytest.importorskip("terucon_catalogue.pipeline")
photos = pytest.importorskip("terucon_catalogue.photos")


def real_neighbours(tmp_path, kind="pdf", **kwargs):
    env = Env(tmp_path, kind, **kwargs)
    db = mongo.MemoryCatalogueDb()
    db.insert_job(copy.deepcopy(env.job))
    store = objectstore.LocalObjectStore(tmp_path / "bucket")
    for key, data in env.store.objects.items():
        store.put_bytes(key, data)
    return env, db, store


def run(env, db, store, **overrides):
    return env.run(db=db, store=store, wrap_photo=None, prepare_resume=None, cancelled_exc=None, **overrides)


def test_pdf_job_succeeds_against_memory_db_and_local_store(tmp_path):
    env, db, store = real_neighbours(tmp_path)
    outcome = run(env, db, store)
    job = db.get_job(JOB)
    assert outcome["ok"] and job["status"] == "succeeded" and job["stage"] == "done" and job["error"] is None
    assert job["result"]["releaseId"] == RELEASE and job["sources"][0]["sha256"] and job["finishedAt"]
    assert [entry["level"] for entry in job["log"]] and all(entry["level"] in ("info", "warn", "error") for entry in job["log"])
    assert store.list("uploads/") == [] and store.exists(CKPT) and store.list("sources/")


def test_photo_job_uses_the_real_wrap_photo_as_pdf(tmp_path):
    env, db, store = real_neighbours(tmp_path, "photos", options={"segmentPhotos": True, "captions": True, "activate": False})
    # the fixtures' 60x80 px photos are below the wrapper's minimum size: use bigger ones
    import numpy as np
    from terucon_catalogue.util import encode_rgb
    for name in ("a.jpg", "b.jpg"):
        data = encode_rgb(np.random.default_rng(len(name)).integers(0, 255, (600, 800, 3), dtype=np.uint8), "jpeg", 90)
        store.put_bytes(f"uploads/{JOB}/{name}", data)
    assert run(env, db, store)["ok"]
    compute = env.calls.compute[0]
    assert [p.name for p in compute["pdfs"]] == ["a.pdf", "b.pdf"] and compute["segment_photos"] == compute["pdfs"]
    assert all(p.read_bytes().startswith(b"%PDF-") for p in compute["pdfs"])


def test_tiny_photo_is_rejected_by_name_with_the_real_wrapper(tmp_path):
    env, db, store = real_neighbours(tmp_path, "photos")
    outcome = run(env, db, store)                                   # the fixtures' photos are 60 x 80 px: smaller than the wrapper accepts
    job = db.get_job(JOB)
    assert outcome["status"] == "failed" and job["status"] == "failed" and job["error"].startswith(("a.jpg:", "b.jpg:"))


def test_resume_uses_the_real_prepare_resume(tmp_path):
    env, db, store = real_neighbours(tmp_path)

    def bomb(stage, done):
        if stage == "captions" and done == 2:
            raise RuntimeError("quota")

    env.compute_hook = bomb
    assert run(env, db, store)["status"] == "failed" and store.exists(CKPT)
    snapshot = tmp_path / "ckpt.sqlite"
    snapshot.write_bytes(store.get_bytes(CKPT))
    with sqlite3.connect(snapshot) as connection:
        connection.execute("INSERT INTO pages (pdf_sha256, page_number, source_pdf, status, attempts, updated_at) VALUES ('a', 1, 'x', 'done', 1, 'now')")
        connection.commit()
    store.put_bytes(CKPT, snapshot.read_bytes())
    env.compute_hook = None
    db.update_job(JOB, {"status": "queued"})
    assert run(env, db, store, workdir=tmp_path / "work2")["ok"]
    restored = env.calls.compute[1]
    assert restored["state_existed"] is True
    with sqlite3.connect(tmp_path / "work2" / "state.sqlite") as connection:             # prepare_resume cleared the pages and reset the PDFs
        assert connection.execute("SELECT COUNT(*) FROM pages").fetchone()[0] == 0
    assert any("resuming from the checkpoint" in entry["msg"] for entry in db.get_job(JOB)["log"])


def test_the_real_cancelled_exception_means_cancelled(tmp_path):
    env, db, store = real_neighbours(tmp_path)

    def stop(cfg, **kwargs):
        raise pipeline.Cancelled("cancelled during the features stage")

    assert run(env, db, store, compute=stop)["status"] == "cancelled"
    assert db.get_job(JOB)["status"] == "cancelled" and db.get_job(JOB)["error"] is None


def test_the_calls_run_ingest_job_makes_fit_the_real_functions(tmp_path):
    """compute and publish are fakes above, so check the REAL signatures accept exactly the arguments the job passes (inspect.Signature.bind)."""
    import inspect

    publish = pytest.importorskip("terucon_catalogue.publish")
    env, db, store = real_neighbours(tmp_path)
    run(env, db, store)
    compute_call, publish_call = env.calls.compute[0], env.calls.publish[0]
    inspect.signature(pipeline.run_compute).bind(
        object(), pdfs=compute_call["pdfs"], work_dir=compute_call["work_dir"], encoders=None, manager=None, progress=print, should_cancel=bool,
        stages=compute_call["stages"], segment_photos=compute_call["segment_photos"])
    inspect.signature(publish.publish_bundle).bind(
        publish_call["bundle_dir"], **{key: value for key, value in publish_call.items() if key != "bundle_dir"})
    assert set(publish_call) == {"bundle_dir", "catalogue", "store", "db", "cfg", "job_id", "source_files", "activate", "dry_run", "progress", "created_by"}
    inspect.signature(photos.wrap_photo_as_pdf).bind(Path("a.jpg"), Path("a.pdf"))
    inspect.signature(pipeline.prepare_resume).bind(Path("work"))
