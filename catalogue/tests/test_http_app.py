"""The two FastAPI apps against ARCHITECTURE.md section 6: authentication, body limits, content types, the parameter matrix, the success shape
(assert keys) and the error shape. Uses fastapi.testclient (httpx); no network."""
import asyncio
import hmac
import json
import math
import sys
import threading
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fakes_search import (CATALOGUE, RELEASE, SMALL_DIMS, FakeEncoderBank, FakeManager, FakeSynthesizer, MemoryStore,  # noqa: E402
                          random_release)

fastapi_testclient = pytest.importorskip("fastapi.testclient")
from fastapi.testclient import TestClient  # noqa: E402

from terucon_catalogue import http_app  # noqa: E402
from terucon_catalogue.config import PipelineConfig  # noqa: E402
from terucon_catalogue.http_app import create_ingest_app, create_search_app  # noqa: E402
from terucon_catalogue.release_reader import (BadRequestError, FeatureVersionMismatchError, ReleaseCorruptError, ReleaseMissingError,  # noqa: E402
                                              ServiceError, StoreUnavailableError)
from terucon_catalogue.search import RegionSpec, resolve_color_function  # noqa: E402
from terucon_catalogue.service import BadImageError, BusyError, RateLimitedError, SearchService  # noqa: E402
from terucon_catalogue.util import encode_rgb  # noqa: E402

KEY = "k" * 32
OTHER_KEY = "o" * 32
AUTH = {"Authorization": f"Bearer {KEY}"}
JPEG = {"Content-Type": "image/jpeg", **AUTH}
Q = f"catalogue={CATALOGUE}&release={RELEASE}"
ERROR_KEYS = {"code", "status", "message", "reason"}


def photo(seed=0, fmt="jpeg"):
    return encode_rgb(np.random.default_rng(seed).integers(0, 255, (120, 160, 3), dtype=np.uint8), fmt, 90)


class RecordingService:
    """Stands in for SearchService so the HTTP layer's parsing and error mapping can be seen on their own."""

    def __init__(self):
        self.calls = []
        self.raise_exc = None

    def _maybe_raise(self):
        if self.raise_exc is not None:
            raise self.raise_exc

    async def search_photo(self, image, **kwargs):
        self.calls.append(("photo", len(image), kwargs))
        self._maybe_raise()
        return {"ok": True, "catalogue": kwargs["catalogue"], "release": kwargs["release"], "results": []}

    async def search_text(self, text, **kwargs):
        self.calls.append(("text", text, kwargs))
        self._maybe_raise()
        return {"ok": True, "results": []}

    def healthz(self):
        return {"ok": True, "ready": True, "device": "fake", "loadedReleases": [], "expectedFeatureVersions": {}, "containerAgeS": 1.0}


@pytest.fixture
def recording():
    return RecordingService()


@pytest.fixture
def client(recording):
    with TestClient(create_search_app(recording, KEY), raise_server_exceptions=False) as test_client:
        yield test_client


def assert_error(response, status, reason):
    assert response.status_code == status, response.text
    body = response.json()
    assert list(body) == ["error"] and set(body["error"]) == ERROR_KEYS
    assert body["error"]["code"] == status and body["error"]["reason"] == reason and isinstance(body["error"]["message"], str)
    assert body["error"]["status"] == http_app.STATUS_NAMES[status]
    return body["error"]


# ------------------------------------------------------------------------------------------------------------------------
# authentication
# ------------------------------------------------------------------------------------------------------------------------
@pytest.mark.parametrize("headers", [{}, {"Authorization": "Bearer wrong-key-wrong-key-wrong-key-xx"}, {"Authorization": "Basic " + KEY},
                                     {"Authorization": KEY}, {"Authorization": "Bearer"}, {"Authorization": "Bearer "},
                                     {"Authorization": "Bearer " + "k" * 5000}, {"X-API-Key": KEY}, {"Authorization": f"Bearer {KEY}x"},
                                     {"Authorization": f"Bearer {KEY[:-1]}"}])
def test_a_401_never_says_why(client, recording, headers):
    first = client.get("/healthz", headers=headers)
    assert_error(first, 401, "unauthorized")
    assert first.headers["www-authenticate"] == "Bearer"
    assert first.json() == client.post("/v1/search?" + Q, content=photo(), headers={**headers, "Content-Type": "image/jpeg"}).json()
    assert recording.calls == []


def test_the_key_in_the_query_string_is_not_a_credential(client):
    assert_error(client.get(f"/healthz?key={KEY}&api_key={KEY}"), 401, "unauthorized")


def test_authentication_comes_before_routing_and_body_reading(client, recording):
    assert_error(client.get("/nope"), 401, "unauthorized")                      # not 404: the route table is not revealed
    huge = client.post("/v1/search?" + Q, content=b"x" * 50, headers={"Content-Length": "999999999999", "Content-Type": "image/jpeg"})
    assert_error(huge, 401, "unauthorized")
    assert recording.calls == []


def test_unknown_path_and_wrong_method_with_a_key(client):
    assert_error(client.get("/nope", headers=AUTH), 404, "not-found")
    assert_error(client.get("/v1/search", headers=AUTH), 405, "method-not-allowed")
    assert_error(client.post("/healthz", headers=AUTH), 405, "method-not-allowed")


def test_comparison_is_constant_time_over_every_key(recording, monkeypatch):
    calls = []
    real = hmac.compare_digest
    monkeypatch.setattr(http_app.hmac, "compare_digest", lambda a, b: calls.append(1) or real(a, b))
    with TestClient(create_search_app(recording, f"{KEY}, {OTHER_KEY}")) as test_client:
        assert test_client.get("/healthz", headers=AUTH).status_code == 200
        assert len(calls) == 2                                                     # the first key matched and the second was still compared
        calls.clear()
        assert test_client.get("/healthz", headers={"Authorization": f"Bearer {OTHER_KEY}"}).status_code == 200
        calls.clear()
        assert test_client.get("/healthz", headers={"Authorization": "Bearer " + "z" * 32}).status_code == 401
        assert len(calls) == 2


@pytest.mark.parametrize("keys", [[], "", " , ", ["short"], "k" * 15, [KEY, "short"]])
def test_an_app_without_decent_keys_refuses_to_start(recording, keys):
    with pytest.raises(ValueError):
        create_search_app(recording, keys)
    with pytest.raises(ValueError):
        create_ingest_app(object(), keys)


def test_proxy_headers_are_required_when_asked(recording):
    with TestClient(create_search_app(recording, KEY, proxy_auth_required=True)) as test_client:
        assert_error(test_client.get("/healthz", headers=AUTH), 401, "unauthorized")
        assert test_client.get("/healthz", headers={**AUTH, "Modal-Key": "wk-1", "Modal-Secret": "ws-2"}).status_code == 200
    with TestClient(create_search_app(recording, KEY)) as test_client:
        assert test_client.get("/healthz", headers=AUTH).status_code == 200


# ------------------------------------------------------------------------------------------------------------------------
# POST /v1/search
# ------------------------------------------------------------------------------------------------------------------------
def test_search_passes_the_parsed_request_to_the_service(client, recording):
    response = client.post("/v1/search?" + Q + "&mode=colour&profile=full&k=60&point=0.3,0.6&radius=0.2&category=stone,metal&finish=matte",
                           content=photo(), headers=JPEG)
    assert response.status_code == 200 and response.headers["cache-control"] == "no-store"
    kind, size, kwargs = recording.calls[0]
    assert kind == "photo" and size == len(photo())
    assert kwargs == {"catalogue": CATALOGUE, "release": RELEASE, "mode": "colour", "profile": "full", "k": 60,
                      "region": RegionSpec(point=(0.3, 0.6), radius=0.2), "category": "stone,metal", "finish": "matte"}
    client.post("/v1/search?" + Q + "&box=0.1,0.2,0.6,0.9", content=photo(), headers=JPEG)
    assert recording.calls[1][2] == {"catalogue": CATALOGUE, "release": RELEASE, "mode": "look", "profile": None, "k": None,
                                     "region": RegionSpec(box=(0.1, 0.2, 0.6, 0.9)), "category": None, "finish": None}


@pytest.mark.parametrize("content_type", ["image/jpeg", "image/png", "image/webp", "IMAGE/JPEG", "image/jpeg; charset=binary"])
def test_accepted_content_types(client, recording, content_type):
    assert client.post("/v1/search?" + Q, content=photo(), headers={**AUTH, "Content-Type": content_type}).status_code == 200


@pytest.mark.parametrize("content_type", ["image/gif", "image/bmp", "image/tiff", "text/plain", "application/json", "application/octet-stream",
                                          "multipart/form-data; boundary=x", "image/jpeg2", ""])
def test_other_content_types_are_415(client, recording, content_type):
    headers = {**AUTH, **({"Content-Type": content_type} if content_type else {})}
    assert_error(client.post("/v1/search?" + Q, content=photo(), headers=headers), 415, "unsupported-media-type")
    assert recording.calls == []


@pytest.mark.parametrize("query", [
    "", f"release={RELEASE}", f"catalogue={CATALOGUE}", f"catalogue=Bad_Id&release={RELEASE}", f"catalogue={CATALOGUE}&release=rel-1",
    f"catalogue=../etc&release={RELEASE}", f"catalogue={CATALOGUE}&release={RELEASE}%0A", f"catalogue={CATALOGUE}%0A&release={RELEASE}",
    Q + "&mode=sepia", Q + "&mode=", Q + "&profile=turbo", Q + "&k=0", Q + "&k=61", Q + "&k=abc", Q + "&k=-1", Q + "&k=1.5", Q + "&k=", Q + "&k=0005x",
    Q + "&k=1&k=2", Q + "&point=0.5", Q + "&point=a,b", Q + "&point=2,0.5", Q + "&point=0.5,-0.1", Q + "&point=nan,0.5", Q + "&point=inf,0.5",
    Q + "&point=0.5,0.5,0.5", Q + "&point=0.5,0.5&box=0.1,0.1,0.2,0.2", Q + "&radius=0.1", Q + "&point=0.5,0.5&radius=0",
    Q + "&point=0.5,0.5&radius=2", Q + "&point=0.5,0.5&radius=x", Q + "&box=0.5,0.5,0.4,0.9", Q + "&box=0.1,0.1,0.1,0.9", Q + "&box=0.1,0.1,0.2",
    Q + "&box=0.1,0.1,0.2,1.5", Q + "&box=0.1,0.1,0.2,0.3&radius=0.1", Q + "&foo=1", Q + "&Mode=look", Q + "&category=a;b",
    Q + "&category=" + ",".join(f"c{i}" for i in range(25)), Q + "&finish=" + "x" * 401, Q + "&category=" + "y" * 41,
])
def test_parameter_validation_matrix(client, recording, query):
    assert_error(client.post("/v1/search?" + query, content=photo(), headers=JPEG), 400, "bad-request")
    assert recording.calls == []


def test_body_limits(recording):
    with TestClient(create_search_app(recording, KEY, max_body_bytes=1000)) as test_client:
        assert_error(test_client.post("/v1/search?" + Q, content=b"x" * 1001, headers=JPEG), 413, "too-large")
        assert recording.calls == []
        assert test_client.post("/v1/search?" + Q, content=b"x" * 1000, headers=JPEG).status_code == 200    # exactly at the cap is fine

        def chunks():                                             # no Content-Length: the cap must hold while streaming
            for _ in range(20):
                yield b"y" * 100

        response = test_client.post("/v1/search?" + Q, content=chunks(), headers=JPEG)
        assert_error(response, 413, "too-large")
        assert len(recording.calls) == 1
        assert_error(test_client.post("/v1/search?" + Q, content=b"", headers=JPEG), 400, "bad-request")
        assert_error(test_client.post("/v1/search?" + Q, content=b"abc", headers={**JPEG, "Content-Length": "oops"}), 400, "bad-request")


def test_default_body_cap_is_eight_mebibytes(recording):
    with TestClient(create_search_app(recording, KEY)) as test_client:
        assert_error(test_client.post("/v1/search?" + Q, content=b"x" * (8 * 1024 * 1024 + 1), headers=JPEG), 413, "too-large")
        assert test_client.post("/v1/search?" + Q, content=b"x" * (8 * 1024 * 1024), headers=JPEG).status_code == 200


@pytest.mark.parametrize("error, status, reason", [
    (BadImageError("bad"), 400, "bad-image"), (BadRequestError("bad"), 400, "bad-request"), (ReleaseMissingError("gone"), 409, "release-missing"),
    (ReleaseCorruptError("hash"), 409, "release-corrupt"), (FeatureVersionMismatchError("old"), 409, "feature-version-mismatch"),
    (BusyError(), 503, "busy"), (RateLimitedError(), 429, "rate-limited"), (StoreUnavailableError("down", retry_after=7), 503, "store-unavailable"),
    (ServiceError("x", status=409, reason="no-usable-signal"), 409, "no-usable-signal"),
])
def test_typed_errors_map_to_status_reason_and_retry_after(client, recording, error, status, reason):
    recording.raise_exc = error
    for response in (client.post("/v1/search?" + Q, content=photo(), headers=JPEG),
                     client.post("/v1/search-text", json={"catalogue": CATALOGUE, "release": RELEASE, "text": "x"}, headers=AUTH)):
        assert_error(response, status, reason)
        if status in (429, 503):
            assert response.headers["retry-after"] == str(max(1, math.ceil(error.retry_after if error.retry_after is not None else 2)))
        else:
            assert "retry-after" not in response.headers


def test_unexpected_failures_are_500_without_details(client, recording):
    recording.raise_exc = RuntimeError("connection string mongodb://user:pass@host leaked")
    error = assert_error(client.post("/v1/search?" + Q, content=photo(), headers=JPEG), 500, "internal")
    assert "mongodb" not in json.dumps(error) and "pass" not in json.dumps(error)


# ------------------------------------------------------------------------------------------------------------------------
# POST /v1/search-text
# ------------------------------------------------------------------------------------------------------------------------
def text_body(**overrides):
    body = {"catalogue": CATALOGUE, "release": RELEASE, "text": "polished black stone", "k": 5}
    body.update(overrides)
    return body


def test_search_text_passes_the_request_on(client, recording):
    assert client.post("/v1/search-text", json=text_body(category="stone", finish=["matte", "polished"]), headers=AUTH).status_code == 200
    assert recording.calls[0] == ("text", "polished black stone", {"catalogue": CATALOGUE, "release": RELEASE, "k": 5, "category": "stone",
                                                                   "finish": ["matte", "polished"]})
    client.post("/v1/search-text", json={"catalogue": CATALOGUE, "release": RELEASE, "text": "x"}, headers=AUTH)
    assert recording.calls[1][2]["k"] is None


@pytest.mark.parametrize("body", [
    text_body(catalogue="Nope"), text_body(release="x"), text_body(text=""), text_body(text="   "), text_body(text=5), text_body(text="x" * 1300),
    text_body(k=0), text_body(k=61), text_body(k="5"), text_body(k=True), text_body(k=2.5), text_body(extra=1), text_body(category=5),
    text_body(category=["a", 5]), text_body(finish="a;b"), [1, 2], "text", 5, None,
])
def test_search_text_validation(client, recording, body):
    assert_error(client.post("/v1/search-text", content=json.dumps(body), headers={**AUTH, "Content-Type": "application/json"}), 400, "bad-request")
    assert recording.calls == []


def test_search_text_other_failures(client, recording):
    assert_error(client.post("/v1/search-text", content=b"{nope", headers={**AUTH, "Content-Type": "application/json"}), 400, "bad-request")
    assert_error(client.post("/v1/search-text", content=b"\xff\xfe", headers={**AUTH, "Content-Type": "application/json"}), 400, "bad-request")
    assert_error(client.post("/v1/search-text", content=json.dumps(text_body()), headers={**AUTH, "Content-Type": "text/plain"}), 415,
                 "unsupported-media-type")
    assert_error(client.post("/v1/search-text", content=json.dumps(text_body(text="x" * 20000)), headers={**AUTH, "Content-Type": "application/json"}),
                 413, "too-large")
    assert recording.calls == []


# ------------------------------------------------------------------------------------------------------------------------
# with the real SearchService behind it
# ------------------------------------------------------------------------------------------------------------------------
@pytest.fixture
def real(tmp_path):
    cfg = PipelineConfig()
    store = MemoryStore()
    random_release(store, 10, seed=2, dims=dict(SMALL_DIMS, color=396))
    service = SearchService(cfg, store=store, cache_dir=tmp_path / "cache", encoders=FakeEncoderBank(), manager=FakeManager(),
                            synthesizer=FakeSynthesizer(), color_fn=resolve_color_function(cfg), queue_timeout_s=0.3)
    with TestClient(create_search_app(service, KEY), raise_server_exceptions=False) as test_client:
        yield test_client, service


def test_end_to_end_success_shapes(real):
    client, service = real
    response = client.post("/v1/search?" + Q + "&k=3&profile=balanced", content=photo(1), headers=JPEG)
    body = response.json()
    assert response.status_code == 200 and list(body) == ["ok", "catalogue", "release", "mode", "profile", "query", "results"]
    assert list(body["query"]) == ["preprocessing", "dominantHex", "signals", "weights", "timingsMs", "warnings"]
    assert body["query"]["signals"] == ["dino_image", "siglip_image", "color_image", "vertex_mm_image"] and len(body["results"]) == 3
    assert list(body["results"][0]) == ["rank", "itemId", "finalScore", "rrfScore", "linearScore", "signals"]
    text = client.post("/v1/search-text", json=text_body(k=2), headers=AUTH).json()
    assert text["ok"] is True and text["query"]["preprocessing"] == "text" and len(text["results"]) == 2
    health = client.get("/healthz", headers=AUTH).json()
    assert list(health) == ["ok", "ready", "device", "loadedReleases", "expectedFeatureVersions", "containerAgeS"]
    assert health["loadedReleases"][0]["release"] == RELEASE


def test_end_to_end_errors(real):
    client, _ = real
    assert_error(client.post("/v1/search?" + Q, content=b"definitely not a jpeg", headers=JPEG), 400, "bad-image")
    assert_error(client.post("/v1/search?" + Q.replace(RELEASE, "rel-20200101000000-aaaaaa"), content=photo(), headers=JPEG), 409, "release-missing")
    assert_error(client.post("/v1/search-text", json=text_body(release="rel-20200101000000-aaaaaa"), headers=AUTH), 409, "release-missing")


def test_end_to_end_busy_is_503_with_retry_after(tmp_path):
    cfg = PipelineConfig()
    store = MemoryStore()
    random_release(store, 6, dims=dict(SMALL_DIMS, color=396))
    block, entered = threading.Event(), threading.Event()
    service = SearchService(cfg, store=store, cache_dir=tmp_path / "c", encoders=FakeEncoderBank(block=block, entered=entered),
                            color_fn=resolve_color_function(cfg), queue_timeout_s=0.2)
    with TestClient(create_search_app(service, KEY), raise_server_exceptions=False) as test_client:
        results = []
        worker = threading.Thread(target=lambda: results.append(test_client.post("/v1/search?" + Q, content=photo(1), headers=JPEG)))
        worker.start()
        assert entered.wait(10)
        busy = test_client.post("/v1/search?" + Q, content=photo(2), headers=JPEG)
        assert_error(busy, 503, "busy")
        assert int(busy.headers["retry-after"]) >= 1
        block.set()
        worker.join(10)
        assert results[0].status_code == 200


# ------------------------------------------------------------------------------------------------------------------------
# the ingest app
# ------------------------------------------------------------------------------------------------------------------------
JOB = "job-20261101120000-a1b2c3"


class Runner:
    version = "9.9.9"

    def __init__(self, sync=True):
        self.started, self.cancelled, self.raise_exc = [], [], None
        if not sync:
            async def start(job_id):
                return self._start(job_id)

            async def cancel(job_id):
                self.cancelled.append(job_id)

            self.start, self.cancel = start, cancel

    def _start(self, job_id):
        if self.raise_exc is not None:
            raise self.raise_exc
        self.started.append(job_id)
        return "fc-0123456789"

    def start(self, job_id):
        return self._start(job_id)

    def cancel(self, job_id):
        if self.raise_exc is not None:
            raise self.raise_exc
        self.cancelled.append(job_id)


@pytest.mark.parametrize("sync", [True, False])
def test_ingest_app(sync):
    runner = Runner(sync)
    with TestClient(create_ingest_app(runner, KEY), raise_server_exceptions=False) as client:
        assert client.get("/healthz", headers=AUTH).json() == {"ok": True, "version": "9.9.9"}
        assert_error(client.get("/healthz"), 401, "unauthorized")
        response = client.post("/v1/ingest", json={"jobId": JOB}, headers=AUTH)
        assert response.status_code == 202 and response.json() == {"ok": True, "callId": "fc-0123456789"}
        assert client.post("/v1/ingest/cancel", json={"jobId": JOB}, headers=AUTH).json() == {"ok": True}
        assert runner.started == [JOB] and runner.cancelled == [JOB]
        for body in ({"jobId": "job-1"}, {}, {"jobId": JOB, "x": 1}, {"jobId": 5}, [JOB], {"jobId": JOB + "\n"}):
            assert_error(client.post("/v1/ingest", content=json.dumps(body), headers={**AUTH, "Content-Type": "application/json"}), 400, "bad-request")
        assert_error(client.post("/v1/ingest", content=json.dumps({"jobId": JOB}), headers={**AUTH, "Content-Type": "text/plain"}), 415,
                     "unsupported-media-type")
        assert_error(client.post("/v1/ingest", content=b"{" + b" " * 20000 + b"}", headers={**AUTH, "Content-Type": "application/json"}), 413, "too-large")
        assert runner.started == [JOB]


def test_ingest_errors_are_mapped():
    runner = Runner()
    with TestClient(create_ingest_app(runner, KEY), raise_server_exceptions=False) as client:
        runner.raise_exc = ServiceError("No such job.", status=404, reason="job-not-found")
        assert_error(client.post("/v1/ingest", json={"jobId": JOB}, headers=AUTH), 404, "job-not-found")
        runner.raise_exc = ServiceError("Not startable.", status=409, reason="job-not-startable")
        assert_error(client.post("/v1/ingest", json={"jobId": JOB}, headers=AUTH), 409, "job-not-startable")
        runner.raise_exc = RuntimeError("mongo password=hunter2")
        error = assert_error(client.post("/v1/ingest/cancel", json={"jobId": JOB}, headers=AUTH), 500, "internal")
        assert "hunter2" not in json.dumps(error)
