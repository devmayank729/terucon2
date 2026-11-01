"""run_ingest_job (the testable body of the Modal ingest function) and IngestRunner, with fake compute / publish / store / database."""
import json
import sqlite3
import sys
import threading
import time
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fakes_search import FakeJobsDb, MemoryStore, sha256  # noqa: E402

from terucon_catalogue.config import PipelineConfig  # noqa: E402
from terucon_catalogue.ingest_job import (IngestRunner, JobNotFoundError, JobNotStartableError, IngestError, run_ingest_job, safe_name,  # noqa: E402
                                          scrub)
from terucon_catalogue.state import StateStore  # noqa: E402
from terucon_catalogue.util import encode_rgb  # noqa: E402

JOB = "job-20261101120000-a1b2c3"
CATALOGUE = "superbond-colour"
PDF = b"%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n"
RELEASE = "rel-20261101130000-fedcba"
CKPT = f"bundles/{CATALOGUE}/{JOB}/state.sqlite"
RESULT_KEYS = {"items", "pages", "failedPages", "unmatchedIds", "newItems", "releaseId", "warnings"}


class Cancelled(Exception):
    pass


def jpeg(seed=0, size=(60, 80)):
    return encode_rgb(np.random.default_rng(seed).integers(0, 255, (*size, 3), dtype=np.uint8), "jpeg", 90)


class Env:
    def __init__(self, tmp_path, kind="pdf", files=None, options=None, status="queued", extra_job=None):
        self.tmp_path = tmp_path
        self.db, self.store = FakeJobsDb(), MemoryStore()
        files = files if files is not None else ([("Catalogue.pdf", PDF)] if kind == "pdf" else [("a.jpg", jpeg(1)), ("b.jpg", jpeg(2))])
        sources = []
        for name, data in files:
            key = f"uploads/{JOB}/{name}"
            self.store.put_bytes(key, data)
            sources.append({"key": key, "name": name, "bytes": len(data), "sha256": None, "kind": "pdf" if kind == "pdf" else "image"})
        job = {"_id": JOB, "catalogue": CATALOGUE, "kind": kind, "status": status, "stage": "waiting", "sources": sources,
               "options": options if options is not None else {"segmentPhotos": False, "captions": True, "activate": True},
               "progress": {"done": 0, "total": 0, "message": ""}, "createdAt": 1, "startedAt": None, "heartbeatAt": None, "finishedAt": None,
               "error": None, "cancelRequested": False, "modalCallId": None, "log": [], "result": None}
        job.update(extra_job or {})
        self.db.add_job(job)
        self.calls = SimpleNamespace(compute=[], publish=[], wrap=[], resume=[], manager=0, encoders=0)
        self.compute_hook = None
        self.publish_hook = None
        self.manager = SimpleNamespace(closed=False, close=lambda: setattr(self.manager, "closed", True))

    # ---- the injected pieces
    def compute(self, cfg, *, pdfs, work_dir, encoders, manager, progress, should_cancel, stages, segment_photos):
        self.calls.compute.append(dict(pdfs=list(pdfs), work_dir=work_dir, encoders=encoders, manager=manager, stages=stages,
                                       segment_photos=list(segment_photos), state_existed=(Path(work_dir) / "state.sqlite").is_file()))
        store = StateStore(Path(work_dir) / "state.sqlite")
        try:
            store.upsert_pdf("a" * 64, "Catalogue.pdf", 10, 3, "done")
            for stage in stages:
                progress(stage, 0, 3, f"{stage} starting")
                for done in range(1, 4):
                    if should_cancel():
                        raise Cancelled(f"cancelled during {stage}")
                    if self.compute_hook:
                        self.compute_hook(stage, done)
                    progress(stage, done, 3, f"{done}/3")
        finally:
            store.close()
        return SimpleNamespace(work_dir=work_dir, pdfs=[], n_items=3, n_pages=3, failed_pages=[{"pdf": "x.pdf", "page": 2, "error": "boom password=hunter22"}],
                               unmatched=3, stages={}, warnings=["compute warning"])

    def publish(self, bundle_dir, **kwargs):
        self.calls.publish.append(dict(bundle_dir=bundle_dir, **kwargs))
        if self.publish_hook:
            self.publish_hook()
        kwargs["progress"]("publish", 1, 2, "validating")
        kwargs["progress"]("release", 2, 2, "writing the release")
        return SimpleNamespace(release_id=RELEASE, n_items=3, n_new=2, activated=kwargs["activate"], warnings=["publish warning"], dry_run=False)

    def wrap(self, image_path, out_pdf):
        self.calls.wrap.append(Path(image_path).name)
        Path(out_pdf).write_bytes(PDF)
        return out_pdf

    def prepare_resume(self, work_dir):
        self.calls.resume.append(Path(work_dir))
        return {"pagesCleared": 3, "pdfsReset": 1}

    def manager_factory(self):
        self.calls.manager += 1
        return self.manager

    def encoders_factory(self):
        self.calls.encoders += 1
        return object()

    def run(self, **overrides):
        arguments = dict(db=self.db, store=self.store, cfg=PipelineConfig(), compute=self.compute, publish=self.publish,
                         manager_factory=self.manager_factory, encoders_factory=self.encoders_factory, workdir=self.tmp_path / "work",
                         now=lambda: int(time.time() * 1000), wrap_photo=self.wrap, prepare_resume=self.prepare_resume, cancelled_exc=Cancelled,
                         heartbeat_s=0.05, progress_interval_s=0.0, cancel_poll_s=0.0)
        arguments.update(overrides)
        return run_ingest_job(JOB, **arguments)

    @property
    def job(self):
        return self.db.jobs[JOB]

    def log_text(self):
        return "\n".join(entry["msg"] for entry in self.job["log"])


@pytest.fixture
def env(tmp_path):
    return Env(tmp_path)


# ------------------------------------------------------------------------------------------------------------------------
def test_success_for_a_pdf(env):
    outcome = env.run()
    job = env.job
    assert outcome == {"ok": True, "status": "succeeded", "jobId": JOB, "releaseId": RELEASE, "error": None}
    assert (job["status"], job["stage"], job["error"]) == ("succeeded", "done", None)
    assert job["startedAt"] and job["finishedAt"] and job["heartbeatAt"] and not [k for k in job["result"] if k not in RESULT_KEYS]
    assert set(job["result"]) == RESULT_KEYS
    assert job["result"] == {"items": 3, "pages": 3, "failedPages": [{"page": 2, "error": "boom password=[removed]"}], "unmatchedIds": 3,
                             "newItems": 2, "releaseId": RELEASE, "warnings": ["compute warning", "publish warning"]}
    compute, publish = env.calls.compute[0], env.calls.publish[0]
    assert compute["stages"] == ("extract", "features", "vertex_mm", "captions", "text_vectors") and compute["segment_photos"] == []
    assert [p.name for p in compute["pdfs"]] == ["Catalogue.pdf"] and compute["pdfs"][0].read_bytes() == PDF
    assert compute["manager"] is env.manager and compute["encoders"] is not None and env.manager.closed
    assert (publish["catalogue"], publish["job_id"], publish["activate"], publish["dry_run"], publish["created_by"]) == (CATALOGUE, JOB, True, False, "ingest")
    assert publish["store"] is env.store and publish["db"] is env.db and callable(publish["progress"])
    assert set(publish["source_files"]) == {"Catalogue.pdf"}
    digest = sha256(PDF)
    assert env.store.objects[f"sources/{digest}/Catalogue.pdf"] == PDF                  # the original is kept
    assert job["sources"][0]["sha256"] == digest
    assert env.store.list("uploads/") == []                                              # the uploads are deleted on success
    snapshot = env.tmp_path / "snapshot.sqlite"
    snapshot.write_bytes(env.store.objects[CKPT])
    with sqlite3.connect(snapshot) as db:
        assert db.execute("SELECT COUNT(*) FROM pdfs").fetchone()[0] == 1                # the checkpoint is a real, openable state.sqlite
    stages_seen = [fields["stage"] for _, fields in env.db.history if "stage" in fields]
    for stage in ("fetch", "extract", "features", "vertex_mm", "captions", "text_vectors", "publish", "release", "done"):
        assert stage in stages_seen
    assert stages_seen.index("extract") < stages_seen.index("features") < stages_seen.index("text_vectors") < stages_seen.index("publish")
    assert "job succeeded" in env.log_text() and "checkpoint saved (after the extract stage)" in env.log_text()


def test_success_for_photos_wraps_them_and_segments_when_asked(tmp_path):
    env = Env(tmp_path, "photos", options={"segmentPhotos": True, "captions": False, "activate": False})
    assert env.run()["ok"]
    compute, publish = env.calls.compute[0], env.calls.publish[0]
    assert env.calls.wrap == ["a.jpg", "b.jpg"] and [p.name for p in compute["pdfs"]] == ["a.pdf", "b.pdf"]
    assert compute["segment_photos"] == compute["pdfs"] and compute["stages"] == ("extract", "features", "vertex_mm")
    assert publish["activate"] is False and set(publish["source_files"]) == {"a.pdf", "b.pdf"}
    for name, data in (("a.jpg", jpeg(1)), ("b.jpg", jpeg(2))):
        assert env.store.objects[f"sources/{sha256(data)}/{name}"] == data


def test_photos_without_segmenting_pass_no_segment_list(tmp_path):
    env = Env(tmp_path, "photos", options={})
    env.run()
    assert env.calls.compute[0]["segment_photos"] == [] and env.calls.publish[0]["activate"] is False
    assert env.calls.compute[0]["stages"] == ("extract", "features", "vertex_mm", "captions", "text_vectors")


def test_progress_is_throttled_but_stage_changes_and_the_end_are_written(env):
    env.compute_hook = None

    def noisy(cfg, *, progress, stages, **kwargs):
        for done in range(2000):
            progress("extract", done, 1999, "page")
        progress("features", 0, 5, "start")
        return SimpleNamespace(n_items=1, n_pages=1, failed_pages=[], unmatched=0, stages={}, warnings=[])

    env.run(compute=noisy, progress_interval_s=3600.0)
    writes = [fields for _, fields in env.db.history if "progress" in fields and fields.get("stage") in ("extract", "features")]
    assert 2 <= len(writes) <= 6                                                         # not 2000
    assert any(w.get("stage") == "features" for w in writes) and any(w["progress"]["done"] == 1999 for w in writes)


def test_heartbeat_is_written_while_the_compute_is_busy(env):
    def slow(cfg, *, progress, **kwargs):
        progress("extract", 0, 1, "one long batch")
        time.sleep(0.5)
        return SimpleNamespace(n_items=1, n_pages=1, failed_pages=[], unmatched=0, stages={}, warnings=[])

    env.run(compute=slow, heartbeat_s=0.05, progress_interval_s=3600.0)
    beats = [f["heartbeatAt"] for _, f in env.db.history if set(f) == {"heartbeatAt"}]
    assert len(beats) >= 6 and beats == sorted(beats)
    assert max(b - a for a, b in zip(beats, beats[1:])) < 400                            # milliseconds between beats; the limit is 10 000


# ------------------------------------------------------------------------------------------------------------------------
# cancel
# ------------------------------------------------------------------------------------------------------------------------
def test_cancel_during_compute_ends_cancelled_with_the_checkpoint(env):
    def hook(stage, done):
        if stage == "features" and done == 2:
            env.db.jobs[JOB]["cancelRequested"] = True                                   # what POST /v1/ingest/cancel does

    env.compute_hook = hook
    outcome = env.run()
    assert outcome["status"] == "cancelled" and env.job["status"] == "cancelled" and env.job["error"] is None and env.job["finishedAt"]
    assert not env.calls.publish and CKPT in env.store.objects and env.store.list("uploads/")   # nothing published, uploads and checkpoint kept
    assert "job cancelled" in env.log_text() and env.manager.closed


def test_cancel_requested_before_the_start_does_no_work(tmp_path):
    env = Env(tmp_path, extra_job={"cancelRequested": True})
    assert env.run()["status"] == "cancelled"
    assert not env.calls.compute and env.job["status"] == "cancelled" and env.store.list("uploads/")


def test_cancel_is_noticed_by_the_heartbeat_when_compute_does_not_poll(env):
    def deaf(cfg, *, progress, should_cancel, **kwargs):
        progress("extract", 0, 1, "start")
        env.db.jobs[JOB]["cancelRequested"] = True
        deadline = time.time() + 5
        while not should_cancel() and time.time() < deadline:
            time.sleep(0.02)
        raise Cancelled("stopped")

    assert env.run(compute=deaf, cancel_poll_s=3600.0, heartbeat_s=0.05)["status"] == "cancelled"


def test_no_cancel_after_the_compute_means_publish_is_skipped(env):
    env.compute_hook = lambda stage, done: (stage == "text_vectors" and done == 3) and env.db.jobs[JOB].update(cancelRequested=True)
    outcome = env.run()
    assert outcome["status"] == "cancelled" and not env.calls.publish


# ------------------------------------------------------------------------------------------------------------------------
# failures: every one ends "failed", with a short scrubbed error, the traceback in the log, the checkpoint kept, never "running"
# ------------------------------------------------------------------------------------------------------------------------
SECRET_TEXT = "mongodb+srv://admin:Sup3rS3cret@cluster0.example.net/db Bearer abcdefghijklmnop12345 api_key=ZZZZZZZZ1234"


def assert_failed(env, outcome, *, checkpoint):
    job = env.job
    assert outcome["ok"] is False and outcome["status"] == "failed" and job["status"] == "failed" and job["status"] != "running"
    assert job["error"] and len(job["error"]) <= 300 and job["finishedAt"] and job["stage"] != "done" and job["result"] is None
    everything = json.dumps(job)
    for secret in ("Sup3rS3cret", "abcdefghijklmnop12345", "ZZZZZZZZ1234"):
        assert secret not in everything
    assert (CKPT in env.store.objects) is checkpoint
    assert env.store.list("uploads/")                                                    # uploads are kept for a resume
    assert not env.calls.publish or job["error"]
    assert all(len(entry["msg"]) <= 2000 for entry in job["log"])


@pytest.mark.parametrize("stage", ["extract", "features", "vertex_mm", "captions", "text_vectors"])
def test_failure_in_each_compute_stage(env, stage):
    def hook(current, done):
        if current == stage and done == 2:
            raise RuntimeError("stage blew up " + SECRET_TEXT)

    env.compute_hook = hook
    outcome = env.run()
    assert_failed(env, outcome, checkpoint=True)
    assert f"RuntimeError: stage blew up" in env.job["error"] and any("traceback" in e["msg"] for e in env.job["log"])
    assert env.manager.closed and not env.calls.publish


def test_failure_in_publish(env):
    def hook():
        raise ValueError("publish refused " + SECRET_TEXT)

    env.publish_hook = hook
    assert_failed(env, env.run(), checkpoint=True)
    assert env.job["error"].startswith("ValueError: publish refused")


@pytest.mark.parametrize("factory", ["manager_factory", "encoders_factory"])
def test_failure_creating_the_models(env, factory):
    def broken():
        raise RuntimeError("no GPU " + SECRET_TEXT)

    assert_failed(env, env.run(**{factory: broken}), checkpoint=False)
    assert not env.calls.compute


@pytest.mark.parametrize("name, data, text", [
    ("Bad.pdf", b"<html>not a pdf</html>", "Bad.pdf: this is not a PDF"),
    ("Empty.pdf", b"", "Empty.pdf: the file is empty"),
    ("Big.pdf", PDF + b"0" * 5000, "Big.pdf: "),
])
def test_bad_pdf_uploads_name_the_file(tmp_path, name, data, text):
    env = Env(tmp_path, files=[("Good.pdf", PDF), (name, data)])
    outcome = env.run(max_pdf_bytes=len(PDF) + 100)
    assert_failed(env, outcome, checkpoint=False)
    assert env.job["error"].startswith(text) and not env.calls.compute and not [k for k in env.store.objects if k.startswith("sources/")]


@pytest.mark.parametrize("data, text", [(b"this is not an image", "not a readable image"), (b"", "the file is empty"), (jpeg(1, (6, 6)), "too small")])
def test_bad_photo_uploads_name_the_file(tmp_path, data, text):
    env = Env(tmp_path, "photos", files=[("fine.jpg", jpeg(1)), ("broken.jpg", data)])
    assert_failed(env, env.run(), checkpoint=False)
    assert env.job["error"].startswith("broken.jpg: ") and text in env.job["error"] and not env.calls.wrap


def test_a_pdf_in_a_photos_job_is_named(tmp_path):
    env = Env(tmp_path, "photos", files=[("catalogue.pdf", PDF)])
    assert_failed(env, env.run(), checkpoint=False)
    assert env.job["error"].startswith("catalogue.pdf: this is not a readable image")


def test_a_photo_that_cannot_be_wrapped_is_named(tmp_path):
    env = Env(tmp_path, "photos")

    def wrap(image, out):
        if Path(image).name == "b.jpg":
            raise ValueError("the photo is only 20 x 20 px")
        Path(out).write_bytes(PDF)

    outcome = env.run(wrap_photo=wrap)
    assert env.job["error"] == "b.jpg: the photo is only 20 x 20 px" and outcome["status"] == "failed"


def test_missing_upload_wrong_checksum_wrong_key_and_too_many_files(tmp_path):
    env = Env(tmp_path)
    del env.store.objects[f"uploads/{JOB}/Catalogue.pdf"]
    env.run()
    assert env.job["error"].startswith("Catalogue.pdf: the upload is missing")
    env = Env(tmp_path / "2", extra_job={})
    env.job["sources"][0]["sha256"] = "0" * 64
    env.run()
    assert env.job["error"] == "Catalogue.pdf: the uploaded file does not match its recorded sha256."
    env = Env(tmp_path / "3")
    env.job["sources"][0]["key"] = "uploads/job-20200101000000-ffffff/Catalogue.pdf"
    env.run()
    assert "not under this job's uploads" in env.job["error"]
    env = Env(tmp_path / "4", files=[(f"{i}.pdf", PDF) for i in range(4)])
    env.run(max_pdfs=3)
    assert env.job["error"] == "The job has 4 files; at most 3 are allowed."
    env = Env(tmp_path / "5", files=[])
    env.run()
    assert env.job["error"] == "The job lists no files."


def test_baseexception_marks_the_job_failed_and_propagates(env):
    def interrupted(cfg, **kwargs):
        raise KeyboardInterrupt()

    with pytest.raises(KeyboardInterrupt):
        env.run(compute=interrupted)
    assert env.job["status"] == "failed" and env.job["error"].startswith("KeyboardInterrupt")


def test_a_failing_database_does_not_crash_a_running_job(env):
    original = env.db.update_job
    calls = {"n": 0}

    def flaky(job_id, fields):
        calls["n"] += 1
        if calls["n"] % 2 == 0:
            raise ConnectionError("mongo blip")
        return original(job_id, fields)

    env.db.update_job = flaky
    assert env.run()["ok"] is True


def test_the_job_never_stays_running_when_even_the_first_steps_fail(tmp_path):
    env = Env(tmp_path)
    env.store.get_file = lambda key, dest: (_ for _ in ()).throw(ConnectionError("gcs down " + SECRET_TEXT))
    assert_failed(env, env.run(), checkpoint=False)


# ------------------------------------------------------------------------------------------------------------------------
# resume
# ------------------------------------------------------------------------------------------------------------------------
def test_a_failed_job_resumes_from_its_checkpoint(env):
    def hook(stage, done):
        if stage == "captions" and done == 2:
            raise RuntimeError("429 RESOURCE_EXHAUSTED")

    env.compute_hook = hook
    assert env.run()["status"] == "failed" and CKPT in env.store.objects
    first_calls = len(env.calls.compute)
    assert env.calls.resume == [] and env.calls.compute[0]["state_existed"] is False
    env.compute_hook = None
    env.job["status"] = "queued"                                  # the website sets it back when the admin starts the job again
    outcome = env.run(workdir=env.tmp_path / "work2")
    assert outcome["ok"] and len(env.calls.compute) == first_calls + 1
    assert env.calls.compute[1]["state_existed"] is True and env.calls.resume == [env.tmp_path / "work2"]      # restored BEFORE the compute
    assert "resuming from the checkpoint" in env.log_text() and env.job["status"] == "succeeded" and env.job["error"] is None


# ------------------------------------------------------------------------------------------------------------------------
# who may start
# ------------------------------------------------------------------------------------------------------------------------
@pytest.mark.parametrize("status", ["draft", "succeeded", "cancelled"])
def test_only_startable_states_run(tmp_path, status):
    env = Env(tmp_path, status=status)
    with pytest.raises(JobNotStartableError):
        env.run()
    assert env.job["status"] == status and not env.calls.compute


def test_running_jobs_start_only_when_the_heartbeat_is_dead(tmp_path):
    now = int(time.time() * 1000)
    env = Env(tmp_path, status="running", extra_job={"heartbeatAt": now - 1000})
    with pytest.raises(JobNotStartableError, match="already running"):
        env.run()
    env = Env(tmp_path / "b", status="running", extra_job={"heartbeatAt": now - 11 * 60 * 1000})
    assert env.run()["ok"]


def test_unknown_job(tmp_path):
    env = Env(tmp_path)
    with pytest.raises(JobNotFoundError):
        run_ingest_job("job-20200101000000-ffffff", db=env.db, store=env.store, cfg=None, compute=env.compute, publish=env.publish, workdir=tmp_path)


# ------------------------------------------------------------------------------------------------------------------------
# the runner behind POST /v1/ingest and /v1/ingest/cancel
# ------------------------------------------------------------------------------------------------------------------------
def test_runner_start_and_cancel(tmp_path):
    env = Env(tmp_path)
    spawned = []
    runner = IngestRunner(env.db, lambda job_id: spawned.append(job_id) or "fc-123", now=lambda: 10 ** 13, version="1.2.3")
    assert runner.version == "1.2.3" and runner.start(JOB) == "fc-123" and spawned == [JOB] and env.job["modalCallId"] == "fc-123"
    runner.cancel(JOB)
    assert env.job["cancelRequested"] is True
    env.job["status"] = "running"
    env.job["heartbeatAt"] = 10 ** 13 - 1000
    with pytest.raises(JobNotStartableError):
        runner.start(JOB)
    for status in ("succeeded", "failed", "cancelled"):
        env.job["status"] = status
        with pytest.raises(JobNotStartableError) as caught:
            runner.cancel(JOB)
        assert caught.value.reason == "job-finished" and caught.value.status == 409
    with pytest.raises(JobNotFoundError) as caught:
        runner.start("job-20200101000000-ffffff")
    assert (caught.value.status, caught.value.reason) == (404, "job-not-found")
    with pytest.raises(IngestError) as caught:
        runner.start("job-1")
    assert caught.value.status == 400 and spawned == [JOB]


# ------------------------------------------------------------------------------------------------------------------------
def test_scrub_removes_credentials():
    text = scrub("connect mongodb+srv://admin:Sup3rS3cret@c0.example.net failed; Authorization: Bearer abcdefghijklmnop; password=hunter22 "
                 "AIzaSyA1234567890abcdefghijklmnopqrstuvw ya29.a0AfH6SMBxxxxxxxxxxxxxxxxxxxxxxxx "
                 "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkq\n-----END PRIVATE KEY----- done")
    for secret in ("Sup3rS3cret", "abcdefghijklmnop", "hunter22", "AIzaSyA1234567890", "ya29.a0AfH6", "MIIEvQ"):
        assert secret not in text
    assert text.startswith("connect mongodb+srv://[credentials removed]@c0.example.net failed") and text.endswith("done")


@pytest.mark.parametrize("name, expected", [("../../etc/passwd", "passwd"), ("C:\\x\\y\\Cat 1.pdf", "Cat 1.pdf"), ("a/b/c.PDF", "c.PDF"), ("", "file"),
                                            ("..", "file"), ("na\x00me.pdf", "na_me.pdf"), ("é.pdf", "_.pdf"), ("x" * 300 + ".pdf", "x" * 120)])
def test_safe_name(name, expected):
    assert safe_name(name) == expected
