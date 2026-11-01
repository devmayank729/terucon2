"""vertex.py with fakes: no Google service is called, no credential is read (the service-account dict has a throwaway key made on the spot).

The error policy is compared with the notebook's own functions; the manager's retry/back-off, shared 429 cool-down, model fallback and the REST call
are driven through fake clients/sessions; the Vertex image-embedding stage runs against a fake manager on real crops.
"""
import asyncio
import base64
import inspect
import json
import socket
import sys
import threading
import time
import types
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import nb_oracle  # noqa: E402
from fakes_compute import FakeManager, make_cfg, seed_items, service_account_info  # noqa: E402

from terucon_catalogue import vertex  # noqa: E402
from terucon_catalogue.config import vertex_mm_version  # noqa: E402
from terucon_catalogue.state import StateStore  # noqa: E402
from terucon_catalogue.util import encode_rgb, load_rgb, resize_max_side, sha256_bytes  # noqa: E402
from terucon_catalogue.vertex import (EmptyModelResponse, VertexGenAIManager, VertexHTTPError, VertexMultimodalImageEmbedder,  # noqa: E402
                                      error_status_code, is_model_unavailable_error, is_retryable_error)


# ------------------------------------------------------------------------------------------------------ fakes
class FakeModels:
    def __init__(self):
        self.generate_calls = []
        self.embed_calls = []
        self.generate_script = {}           # model name -> exception to raise | callable() | list of outcomes
        self.embed_values = [3.0, 4.0]

    async def generate_content(self, model, contents, config):
        self.generate_calls.append(model)
        await asyncio.sleep(0)
        outcome = self.generate_script.get(model, "ok:" + model)
        if isinstance(outcome, list):
            outcome = outcome.pop(0) if len(outcome) > 1 else outcome[0]
        if isinstance(outcome, BaseException):
            raise outcome
        return outcome

    async def embed_content(self, model, contents, config):
        self.embed_calls.append({"model": model, "contents": contents, "config": config})
        return types.SimpleNamespace(embeddings=[types.SimpleNamespace(values=list(self.embed_values))])


class FakeClient:
    instances = []

    def __init__(self, **kwargs):
        self.kwargs = kwargs
        self.aio = types.SimpleNamespace(models=FakeModels())
        self.closed = False
        FakeClient.instances.append(self)

    def close(self):
        self.closed = True


class FakeHttpResponse:
    def __init__(self, status_code=200, payload=None, text=None):
        self.status_code = status_code
        self._payload = payload
        self.text = text if text is not None else json.dumps(payload)

    def json(self):
        return self._payload


class FakeSession:
    def __init__(self, responses):
        self.responses = list(responses)
        self.requests = []

    def post(self, url, json=None, timeout=None):
        self.requests.append({"url": url, "json": json, "timeout": timeout, "thread": threading.current_thread().name})
        outcome = self.responses.pop(0)
        if isinstance(outcome, BaseException):
            raise outcome
        return outcome


@pytest.fixture()
def no_network(monkeypatch):
    def refuse(*args, **kwargs):
        raise AssertionError("a network access was attempted")
    monkeypatch.setattr(socket.socket, "connect", refuse)
    monkeypatch.setattr(socket, "getaddrinfo", refuse)


def cfg_for_retries(**overrides):
    values = dict(retry_max_attempts=4, retry_initial_wait_s=0.01, retry_max_wait_s=0.05, rate_limit_cooldown_s=0.3, request_timeout_s=5.0)
    values.update(overrides)
    return make_cfg(**values)


@pytest.fixture()
def manager(monkeypatch, no_network):
    FakeClient.instances.clear()
    monkeypatch.setattr("google.genai.Client", FakeClient)
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "set-by-the-test-so-it-is-restored")
    return VertexGenAIManager(cfg_for_retries(), service_account_info())


# ------------------------------------------------------------------------------------------------------ error policy = the notebook's
@pytest.fixture(scope="module")
def nb():
    nb_oracle.require_notebook()
    import requests
    return nb_oracle.load([
        (2, ["RETRYABLE_HTTP_CODES", "TRANSIENT_EXCEPTION_NAMES", "MODEL_UNAVAILABLE_MARKERS", "VertexHTTPError", "EmptyModelResponse", "error_status_code",
             "is_retryable_error", "is_model_unavailable_error"]),
    ], extra={"requests": requests})


def exception_zoo():
    import requests

    def named(name, **attributes):
        error = type(name, (Exception,), {})("boom")
        for key, value in attributes.items():
            setattr(error, key, value)
        return error

    zoo = [VertexHTTPError(code, "body " + text) for code in (200, 400, 401, 403, 404, 408, 409, 429, 500, 502, 503, 504)
           for text in ("", "model not supported for this project", "Publisher Model was not found", "does not have access", "is not available in region")]
    zoo += [EmptyModelResponse("empty", retryable=True), EmptyModelResponse("empty", retryable=False), asyncio.TimeoutError(), TimeoutError(), ConnectionError(),
            requests.exceptions.ConnectionError(), requests.exceptions.Timeout(), requests.exceptions.HTTPError(), ValueError("x"), Exception("plain"),
            named("ReadTimeout"), named("ConnectError"), named("TransportError"), named("ServerDisconnectedError"), named("SomethingElse"),
            named("WithStatus", status_code=503), named("WithStatus", status_code=400), named("WithCode", code=429), named("WithResponse", response=types.SimpleNamespace(status_code=500)),
            named("WithStringCode", code="429"), named("Both", code=404, status_code=500)]
    return zoo


def test_error_policy_is_the_notebooks_for_every_kind_of_error(nb):
    assert vertex.RETRYABLE_HTTP_CODES == nb["RETRYABLE_HTTP_CODES"] == frozenset({408, 429, 500, 502, 503, 504})
    assert vertex.TRANSIENT_EXCEPTION_NAMES == nb["TRANSIENT_EXCEPTION_NAMES"] and vertex.MODEL_UNAVAILABLE_MARKERS == nb["MODEL_UNAVAILABLE_MARKERS"]
    for error in exception_zoo():
        assert error_status_code(error) == nb["error_status_code"](error)
        assert is_model_unavailable_error(error) == nb["is_model_unavailable_error"](error)
        # the notebook's classes are not ours, so compare by what they mean: translate the two Vertex exception types
        theirs = error
        if isinstance(error, VertexHTTPError):
            theirs = nb["VertexHTTPError"](error.code, error.body)
        elif isinstance(error, EmptyModelResponse):
            theirs = nb["EmptyModelResponse"](str(error), retryable=error.retryable)
        assert is_retryable_error(error) == nb["is_retryable_error"](theirs), repr(error)
    ours, theirs = VertexHTTPError(503, "x" * 600), nb["VertexHTTPError"](503, "x" * 600)
    assert str(ours) == str(theirs) and (ours.code, ours.body) == (theirs.code, theirs.body)


def test_what_is_retried_and_what_is_not():
    assert all(is_retryable_error(VertexHTTPError(code, "")) for code in (408, 429, 500, 502, 503, 504))
    assert not any(is_retryable_error(VertexHTTPError(code, "")) for code in (400, 401, 403, 404))
    assert is_retryable_error(ConnectionError()) and is_retryable_error(asyncio.TimeoutError())
    assert not is_retryable_error(EmptyModelResponse("blocked", retryable=False)) and is_retryable_error(EmptyModelResponse("hiccup"))
    assert is_model_unavailable_error(VertexHTTPError(404, "")) and is_model_unavailable_error(VertexHTTPError(400, "Model is not supported for X"))
    assert not is_model_unavailable_error(VertexHTTPError(400, "bad request")) and not is_model_unavailable_error(VertexHTTPError(500, "not found"))


# ------------------------------------------------------------------------------------------------------ building the manager
def test_the_clients_are_built_exactly_like_the_notebook_does(manager):
    first, second = FakeClient.instances
    cfg = manager.cfg
    for client, location in ((first, cfg.gemini_location), (second, cfg.embedding_location)):
        assert set(client.kwargs) == {"vertexai", "credentials", "project", "location", "http_options"}
        assert client.kwargs["vertexai"] is True and client.kwargs["project"] == "test-project-123" and client.kwargs["location"] == location
        assert client.kwargs["credentials"] is manager.credentials and client.kwargs["http_options"].timeout == int(cfg.request_timeout_s * 1000)
    assert (cfg.gemini_location, cfg.embedding_location) == ("global", "us-central1")
    assert manager.generation_client is first and manager.embedding_client is second
    assert manager.project_id == "test-project-123" and manager.client_email.startswith("fake@")
    assert manager.credentials.scopes == list(VertexGenAIManager.SCOPES) and manager.disabled_features == set()
    import os
    assert os.environ["GOOGLE_CLOUD_PROJECT"] == "test-project-123"          # as in the notebook
    manager.close()
    assert first.closed and second.closed


def test_the_real_google_genai_accepts_these_clients_arguments_without_touching_the_network(no_network, monkeypatch):
    """Verified against the installed google-genai: the signature has these parameters, and a real client is built from them offline."""
    from google import genai
    from google.genai import types as genai_types
    names = set(inspect.signature(genai.Client.__init__).parameters)
    assert {"vertexai", "credentials", "project", "location", "http_options"} <= names
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "restored-afterwards")
    real = VertexGenAIManager(cfg_for_retries(), service_account_info())
    assert type(real.generation_client).__module__.startswith("google.genai") and real.generation_client._api_client.vertexai is True
    assert real.generation_client._api_client.location == "global" and real.embedding_client._api_client.location == "us-central1"
    assert real.generation_client._api_client.project == "test-project-123"
    assert genai_types.HttpOptions(timeout=180000).timeout == 180000
    genai_types.EmbedContentConfig(task_type="RETRIEVAL_DOCUMENT", output_dimensionality=768)
    genai_types.ThinkingConfig(thinking_budget=0)
    genai_types.Part.from_bytes(data=b"x", mime_type="image/jpeg")
    real.close()


def test_a_session_is_built_once_per_thread_and_is_an_authorized_session(manager):
    from google.auth.transport.requests import AuthorizedSession
    here = manager._authorized_session()
    assert isinstance(here, AuthorizedSession) and manager._authorized_session() is here
    other = []
    thread = threading.Thread(target=lambda: other.append(manager._authorized_session()))
    thread.start()
    thread.join()
    assert other[0] is not here


# ------------------------------------------------------------------------------------------------------ retries
def flaky(failures, result="done"):
    calls = {"n": 0, "at": []}

    async def operation():
        calls["n"] += 1
        calls["at"].append(time.monotonic())
        if calls["n"] <= len(failures):
            raise failures[calls["n"] - 1]
        return result
    return operation, calls


def test_429_and_503_are_retried_until_they_succeed(manager):
    for code in (429, 503, 500):
        operation, calls = flaky([VertexHTTPError(code, "busy"), VertexHTTPError(code, "busy")])
        assert asyncio.run(manager.call_with_retries(operation)) == "done" and calls["n"] == 3


def test_400_and_404_and_a_blocked_response_are_not_retried(manager):
    for error in (VertexHTTPError(400, "bad"), VertexHTTPError(404, "missing"), VertexHTTPError(403, "no"), EmptyModelResponse("blocked", retryable=False), ValueError("bug")):
        operation, calls = flaky([error])
        with pytest.raises(type(error)):
            asyncio.run(manager.call_with_retries(operation))
        assert calls["n"] == 1


def test_it_gives_up_after_retry_max_attempts_and_raises_the_last_error(manager):
    operation, calls = flaky([VertexHTTPError(503, f"try {i}") for i in range(10)])
    with pytest.raises(VertexHTTPError, match="try 3"):
        asyncio.run(manager.call_with_retries(operation))
    assert calls["n"] == manager.cfg.retry_max_attempts == 4


def test_a_429_sets_a_global_cool_down_that_other_requests_wait_for_but_a_503_does_not(manager):
    cooldown = manager.cfg.rate_limit_cooldown_s
    assert manager._cooldown_until == 0.0
    operation, _ = flaky([VertexHTTPError(503, "busy")])
    asyncio.run(manager.call_with_retries(operation))
    assert manager._cooldown_until == 0.0                              # a 503 backs off that request only
    before = time.monotonic()
    operation, _ = flaky([VertexHTTPError(429, "quota")])
    asyncio.run(manager.call_with_retries(operation))
    assert before + cooldown - 0.05 <= manager._cooldown_until <= time.monotonic() + cooldown + 0.05

    async def scenario():
        manager._cooldown_until = 0.0
        first_op, first_calls = flaky([VertexHTTPError(429, "quota")])
        started = {}

        async def other():
            await asyncio.sleep(0.05)                                   # starts after the first request has had its 429
            op, calls = flaky([])
            started["at"] = time.monotonic()
            await manager.call_with_retries(op)
            return calls["at"][0]
        first_task = asyncio.create_task(manager.call_with_retries(first_op))
        other_call_time = await asyncio.create_task(other())
        await first_task
        return first_calls["at"][0], other_call_time

    first_call, other_call = asyncio.run(scenario())
    assert other_call - first_call >= cooldown - 0.05                    # the second request waited out the first one's cool-down


def test_before_sleep_logs_and_sets_the_cool_down_only_for_429(manager):
    def state(code):
        error = VertexHTTPError(code, "x")
        outcome = types.SimpleNamespace(exception=lambda: error)
        return types.SimpleNamespace(outcome=outcome, next_action=types.SimpleNamespace(sleep=1.0), attempt_number=1)
    manager._before_sleep(state(503))
    assert manager._cooldown_until == 0.0
    manager._before_sleep(state(429))
    assert manager._cooldown_until > time.monotonic()
    manager._before_sleep(types.SimpleNamespace(outcome=None, next_action=None, attempt_number=1))     # tolerated


# ------------------------------------------------------------------------------------------------------ model fallback
def run_fallback(manager, role="caption", candidates=("m1", "m2", "m3")):
    seen = []

    def config_factory(model):
        seen.append(model)
        return {"config-for": model}
    return asyncio.run(manager.generate_content_with_fallback(role, list(candidates), ["contents"], config_factory)), seen


def test_the_first_model_that_exists_is_used_and_remembered_per_role(manager):
    models = manager.generation_client.aio.models
    models.generate_script = {"m1": VertexHTTPError(404, "Publisher Model was not found"), "m2": "response-from-m2"}
    (model, response), tried = run_fallback(manager)
    assert (model, response) == ("m2", "response-from-m2") and models.generate_calls == ["m1", "m2"] and tried == ["m1", "m2"]
    assert manager._resolved_models == {"caption": "m2"}
    models.generate_calls.clear()
    (model, _), tried = run_fallback(manager)
    assert model == "m2" and models.generate_calls == ["m2"] and tried == ["m2"]            # straight to the remembered model
    models.generate_calls.clear()
    (model, _), _ = run_fallback(manager, role="render", candidates=("r1", "r2"))               # another role resolves on its own
    assert model == "r1" and models.generate_calls == ["r1"] and manager._resolved_models == {"caption": "m2", "render": "r1"}


def test_a_400_that_says_the_model_is_not_supported_also_falls_back_but_a_plain_400_does_not(manager):
    models = manager.generation_client.aio.models
    models.generate_script = {"m1": VertexHTTPError(400, "Model m1 is not supported for generateContent"), "m2": VertexHTTPError(403, "caller does not have access")}
    (model, _), _ = run_fallback(manager)
    assert model == "m3" and models.generate_calls == ["m1", "m2", "m3"]
    manager._resolved_models.clear()
    models.generate_calls.clear()
    models.generate_script = {"m1": VertexHTTPError(400, "Invalid argument: response_schema")}
    with pytest.raises(VertexHTTPError, match="Invalid argument"):
        run_fallback(manager)
    assert models.generate_calls == ["m1"] and manager._resolved_models == {}


def test_when_every_candidate_is_unavailable_it_says_so_and_chains_the_last_error(manager):
    models = manager.generation_client.aio.models
    models.generate_script = {m: VertexHTTPError(404, f"{m} was not found") for m in ("m1", "m2", "m3")}
    with pytest.raises(RuntimeError, match=r"No candidate model available for 'caption': \['m1', 'm2', 'm3'\]") as raised:
        run_fallback(manager)
    assert isinstance(raised.value.__cause__, VertexHTTPError) and "m3" in str(raised.value.__cause__) and manager._resolved_models == {}


def test_a_transient_error_on_the_first_candidate_is_retried_and_does_not_count_as_unavailable(manager):
    models = manager.generation_client.aio.models
    models.generate_script = {"m1": [VertexHTTPError(503, "busy"), "ok-after-retry"]}
    (model, response), _ = run_fallback(manager)
    assert (model, response) == ("m1", "ok-after-retry") and models.generate_calls == ["m1", "m1"]
    manager._resolved_models.clear()
    models.generate_calls.clear()
    models.generate_script = {"m1": [VertexHTTPError(503, "busy")] * 9}
    with pytest.raises(VertexHTTPError):                                       # retries used up: surfaced, NOT treated as 'try the next model'
        run_fallback(manager)
    assert models.generate_calls == ["m1"] * manager.cfg.retry_max_attempts


def test_concurrent_first_calls_resolve_the_model_once(manager):
    models = manager.generation_client.aio.models
    models.generate_script = {"m1": VertexHTTPError(404, "gone"), "m2": "ok"}

    async def many():
        return await asyncio.gather(*[manager.generate_content_with_fallback("caption", ["m1", "m2"], ["c"], lambda m: m) for _ in range(6)])
    results = asyncio.run(many())
    assert {r[0] for r in results} == {"m2"} and models.generate_calls.count("m1") == 1 and models.generate_calls.count("m2") == 6


# ------------------------------------------------------------------------------------------------------ embeddings
def test_embed_text_sends_the_task_type_and_dimension_and_returns_a_unit_vector(manager):
    models = manager.embedding_client.aio.models
    models.embed_values = [3.0, 4.0] + [0.0] * 766
    vector = asyncio.run(manager.embed_text("brushed brass", "RETRIEVAL_QUERY"))
    (call,) = models.embed_calls
    assert call["model"] == "gemini-embedding-001" and call["contents"] == "brushed brass"
    assert call["config"].task_type == "RETRIEVAL_QUERY" and call["config"].output_dimensionality == 768
    assert vector.dtype == np.float32 and vector.shape == (768,) and abs(float(np.linalg.norm(vector)) - 1.0) < 1e-6
    assert vector[0] == pytest.approx(0.6) and vector[1] == pytest.approx(0.8)


def test_multimodal_embed_posts_the_notebooks_request_and_normalises_the_answer(manager, monkeypatch):
    session = FakeSession([FakeHttpResponse(200, {"predictions": [{"imageEmbedding": [3.0, 4.0], "textEmbedding": [0.0, 2.0]}]})])
    monkeypatch.setattr(manager, "_authorized_session", lambda: session)          # per-thread sessions: patch the accessor, not the main thread's slot
    image = b"\xff\xd8jpeg-bytes"
    result = asyncio.run(manager.multimodal_embed(image_bytes=image, text="x" * 500))
    (request,) = session.requests
    assert request["url"] == ("https://us-central1-aiplatform.googleapis.com/v1/projects/test-project-123/locations/us-central1/publishers/google/"
                              "models/multimodalembedding@001:predict")
    assert request["json"] == {"instances": [{"image": {"bytesBase64Encoded": base64.b64encode(image).decode("ascii")}, "text": "x" * 200}],
                               "parameters": {"dimension": 1408}}
    assert request["timeout"] == manager.cfg.request_timeout_s and request["thread"] != threading.main_thread().name      # it runs in a worker thread
    assert set(result) == {"image", "text"}
    assert np.allclose(result["image"], [0.6, 0.8]) and np.allclose(result["text"], [0.0, 1.0]) and result["image"].dtype == np.float32


def test_multimodal_embed_text_only_and_image_only(manager, monkeypatch):
    session = FakeSession([FakeHttpResponse(200, {"predictions": [{"textEmbedding": [1.0, 0.0]}]}), FakeHttpResponse(200, {"predictions": [{"imageEmbedding": [0.0, 5.0]}]})])
    monkeypatch.setattr(manager, "_authorized_session", lambda: session)
    only_text = asyncio.run(manager.multimodal_embed(text="oak"))
    only_image = asyncio.run(manager.multimodal_embed(image_bytes=b"abc"))
    assert set(only_text) == {"text"} and set(only_image) == {"image"}
    assert session.requests[0]["json"]["instances"] == [{"text": "oak"}] and list(session.requests[1]["json"]["instances"][0]) == ["image"]


def test_multimodal_embed_retries_429_and_503_but_not_400(manager, monkeypatch):
    ok = FakeHttpResponse(200, {"predictions": [{"imageEmbedding": [1.0, 0.0]}]})
    session = FakeSession([FakeHttpResponse(429, text="Resource exhausted"), FakeHttpResponse(503, text="unavailable"), ok])
    monkeypatch.setattr(manager, "_authorized_session", lambda: session)
    assert set(asyncio.run(manager.multimodal_embed(image_bytes=b"abc"))) == {"image"} and len(session.requests) == 3
    assert manager._cooldown_until > 0                                          # the 429 started a cool-down
    session = FakeSession([FakeHttpResponse(400, text="Invalid image")])
    monkeypatch.setattr(manager, "_authorized_session", lambda: session)
    with pytest.raises(VertexHTTPError) as raised:
        asyncio.run(manager.multimodal_embed(image_bytes=b"abc"))
    assert raised.value.code == 400 and "Invalid image" in str(raised.value) and len(session.requests) == 1
    session = FakeSession([ConnectionError("reset"), ok])
    monkeypatch.setattr(manager, "_authorized_session", lambda: session)
    assert asyncio.run(manager.multimodal_embed(image_bytes=b"abc"))["image"].shape == (2,) and len(session.requests) == 2


# ------------------------------------------------------------------------------------------------------ the image-embedding stage
def jpeg_digests(cfg, store):
    """sha256 of the JPEG the stage sends for each item (the same three calls as VertexMultimodalImageEmbedder._embed_batch)."""
    out = {}
    for row in store.query("SELECT item_id, crop_filepath FROM items ORDER BY item_id"):
        out[row["item_id"]] = sha256_bytes(encode_rgb(resize_max_side(load_rgb(cfg.work_dir / row["crop_filepath"]), 1024), "jpeg", 92))
    return out


def stage(tmp_path, count=5, manager=None, **cfg_overrides):
    cfg = make_cfg(tmp_path / "w", **cfg_overrides)
    store = StateStore(cfg.state_db_path)
    ids = seed_items(store, cfg, count)
    from terucon_catalogue.util import get_async_runner
    manager = manager or FakeManager()
    return cfg, store, ids, manager, get_async_runner()


def test_the_stage_embeds_every_crop_as_a_jpeg_and_stores_1408_numbers_per_item(tmp_path):
    seen = []

    def spy(call_index, digest):
        seen.append(digest)
    cfg, store, ids, manager, runner = stage(tmp_path, manager=FakeManager(multimodal_behaviour=spy))
    ticks = []
    done = VertexMultimodalImageEmbedder(cfg, store, manager, runner, on_batch=lambda d, t: ticks.append((d, t))).run()
    assert done == 5 and ticks == [(0, 5), (2, 5), (4, 5), (5, 5)] and manager.calls["multimodal_embed"] == 5
    assert sorted(seen) == sorted(jpeg_digests(cfg, store).values())              # what was sent is the 92 % JPEG of each crop, at most 1024 px
    rows = store.query("SELECT item_id, feature_version, dim, dtype, vector FROM embeddings WHERE pillar = 'vertex_mm' ORDER BY item_id")
    assert [r["item_id"] for r in rows] == sorted(ids) and {(r["feature_version"], r["dim"], r["dtype"]) for r in rows} == {(vertex_mm_version(cfg), 1408, "float16")}
    assert VertexMultimodalImageEmbedder(cfg, store, manager, runner).run() == 0 and manager.calls["multimodal_embed"] == 5      # idempotent
    store.close()


def test_it_does_nothing_without_a_manager_or_when_switched_off_or_after_the_pillar_was_disabled(tmp_path):
    cfg, store, ids, manager, runner = stage(tmp_path)
    assert VertexMultimodalImageEmbedder(cfg, store, None, runner).run() == 0
    off = make_cfg(tmp_path / "w", enable_vertex_multimodal_embedding=False)
    assert VertexMultimodalImageEmbedder(off, store, manager, runner).run() == 0
    manager.disabled_features.add("vertex_mm")
    assert VertexMultimodalImageEmbedder(cfg, store, manager, runner).run() == 0 and manager.total_calls == 0
    store.close()


def test_one_failing_item_is_recorded_and_retried_later_up_to_the_allowed_attempts(tmp_path):
    cfg, store, ids, _, runner = stage(tmp_path, max_feature_attempts=2)
    bad = jpeg_digests(cfg, store)[ids[1]]
    manager = FakeManager(multimodal_behaviour=lambda n, digest: VertexHTTPError(500, "boom") if digest == bad else None)
    done = VertexMultimodalImageEmbedder(cfg, store, manager, runner).run()
    assert done == 4
    assert [(r["item_id"], r["pillar"], r["attempts"]) for r in store.query("SELECT * FROM feature_errors")] == [(ids[1], "vertex_mm", 1)]
    assert "VertexHTTPError: HTTP 500" in store.query("SELECT error FROM feature_errors")[0]["error"]
    assert "vertex_mm" not in manager.disabled_features                          # one failure out of a batch does not disable the pillar
    calls = manager.calls["multimodal_embed"]
    assert VertexMultimodalImageEmbedder(cfg, store, manager, runner).run() == 0                       # tried again, failed again
    assert manager.calls["multimodal_embed"] == calls + 1 and store.query("SELECT attempts FROM feature_errors")[0]["attempts"] == 2
    VertexMultimodalImageEmbedder(cfg, store, manager, runner).run()
    assert manager.calls["multimodal_embed"] == calls + 1                        # attempts used up: not asked again
    store.close()


@pytest.mark.parametrize("error", [VertexHTTPError(404, "Publisher Model `multimodalembedding@001` was not found"), VertexHTTPError(403, "Permission denied"),
                                   VertexHTTPError(400, "this model is not supported in the project")])
def test_the_pillar_is_switched_off_when_every_item_of_a_batch_says_the_model_is_unavailable(tmp_path, error):
    cfg, store, ids, _, runner = stage(tmp_path, count=5)
    manager = FakeManager(multimodal_behaviour=lambda n, digest: error)
    assert VertexMultimodalImageEmbedder(cfg, store, manager, runner).run() == 0
    assert "vertex_mm" in manager.disabled_features
    assert manager.calls["multimodal_embed"] == 2                                  # only the first batch (checkpoint_every=2) was tried, then it stopped
    assert store.query("SELECT COUNT(*) FROM feature_errors WHERE pillar = 'vertex_mm'")[0][0] == 2
    assert VertexMultimodalImageEmbedder(cfg, store, manager, runner).run() == 0 and manager.calls["multimodal_embed"] == 2      # and stays off
    store.close()


def test_a_batch_with_one_success_does_not_switch_the_pillar_off_but_a_whole_unavailable_batch_does(tmp_path):
    """The notebook decides per batch: 'every item of THIS batch says the model is unavailable'."""
    cfg, store, ids, _, runner = stage(tmp_path, count=4)
    digests = jpeg_digests(cfg, store)
    unavailable = VertexHTTPError(404, "was not found")
    works = {digests[ids[0]], digests[ids[2]]}                                     # one success in each batch of two
    manager = FakeManager(multimodal_behaviour=lambda n, digest: None if digest in works else unavailable)
    assert VertexMultimodalImageEmbedder(cfg, store, manager, runner).run() == 2
    assert "vertex_mm" not in manager.disabled_features and manager.calls["multimodal_embed"] == 4
    cfg2 = make_cfg(tmp_path / "w2")
    store2 = StateStore(cfg2.state_db_path)
    ids2 = seed_items(store2, cfg2, 4)
    only_first = {jpeg_digests(cfg2, store2)[ids2[0]]}                              # the second batch is all unavailable
    manager2 = FakeManager(multimodal_behaviour=lambda n, digest: None if digest in only_first else unavailable)
    assert VertexMultimodalImageEmbedder(cfg2, store2, manager2, runner).run() == 1
    assert "vertex_mm" in manager2.disabled_features and manager2.calls["multimodal_embed"] == 4
    store.close(), store2.close()
