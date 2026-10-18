"""The model service as an HTTP API: guards, error shapes, /health, /segment without Google, SAM keys, hot reload.

Everything here goes through Flask's test client on a temp env file with an explicit environment (see support.py), except the
two tests that need a real socket (a remote SAM client talking to the service) and the in-process serve() test.
"""
from __future__ import annotations

import contextlib
import io
import json
import sys
import threading
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest import mock

import numpy as np
from PIL import Image

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

import support  # noqa: E402
import synthetic as syn  # noqa: E402
from fakes import make_sam_manager  # noqa: E402
from mock_google import make_service_account  # noqa: E402
from support import JSON, LOCAL, jpeg_b64  # noqa: E402
from terucon_model import __version__  # noqa: E402
from terucon_model import app as app_module  # noqa: E402
from terucon_model.__main__ import serve  # noqa: E402
from terucon_model.config import SamConfig  # noqa: E402
from terucon_model.sam.backends import RemoteBackend, SamUnavailable  # noqa: E402
from terucon_model.sam.manager import SamManager  # noqa: E402

MODEL_KEY = "X-Terucon-Model-Key"
HEALTH_KEYS = ["ok", "service", "version", "google", "sam", "segmentation"]


class ServiceCase(unittest.TestCase):
    def setUp(self):
        self.tmp = support.tempdir()
        self.addCleanup(self.tmp.cleanup)

    def app(self, environ=None, env_text="", sam=None):
        return support.make_app(self.tmp.name, environ, env_text, sam)

    def client(self, environ=None, env_text="", sam=None):
        return self.app(environ, env_text, sam).test_client()

    def listen(self, app):
        import logging

        from werkzeug.serving import make_server

        access_log = logging.getLogger("werkzeug")
        old_level = access_log.level
        access_log.setLevel(logging.ERROR)  # the access log of these throw-away servers is only noise
        self.addCleanup(lambda: access_log.setLevel(old_level))
        server = make_server("127.0.0.1", 0, app, threaded=True)
        thread = threading.Thread(target=lambda: server.serve_forever(poll_interval=0.05), daemon=True)
        thread.start()
        self.addCleanup(lambda: (server.shutdown(), server.server_close()))
        return f"http://127.0.0.1:{server.server_address[1]}"

    def assertError(self, resp, status, api_status=None, contains=None):
        self.assertEqual(resp.status_code, status)
        self.assertEqual(resp.mimetype, "application/json")
        body = resp.get_json()
        self.assertEqual(list(body), ["error"])
        self.assertEqual(sorted(body["error"]), ["code", "message", "status"])
        self.assertEqual(body["error"]["code"], status)
        self.assertRegex(body["error"]["status"], r"^[A-Z_]+$")
        self.assertTrue(body["error"]["message"])
        if api_status:
            self.assertEqual(body["error"]["status"], api_status)
        if contains:
            self.assertIn(contains, body["error"]["message"])
        return body["error"]


class HostGuardTests(ServiceCase):
    def test_this_machine_under_any_of_its_names_is_accepted(self):
        c = self.client()
        for host in ("localhost", "localhost:8081", "LOCALHOST:8081", "127.0.0.1", "127.0.0.1:54321", "[::1]", "[::1]:8081"):
            self.assertEqual(c.get("/health", headers={"Host": host}).status_code, 200, host)

    def test_any_other_host_is_421_in_the_standard_error_shape(self):
        c = self.client()
        for host in ("evil.example.com", "evil.example.com:8081", "localhost.evil.com", "127.0.0.1.evil.com", "10.0.0.5:8081", "[2001:db8::1]:8081"):
            self.assertError(c.get("/health", headers={"Host": host}), 421, contains="Host", )

    def test_the_host_is_checked_on_every_route_and_before_anything_else(self):
        c = self.client({"MODEL_SERVICE_KEY": "k"})
        evil = {"Host": "evil.example.com", "Content-Type": "text/plain"}
        for method, path in (("GET", "/health"), ("POST", "/segment"), ("GET", "/sam/health"), ("POST", "/sam/refine"), ("GET", "/nowhere"), ("DELETE", "/health")):
            self.assertError(c.open(path, method=method, headers=evil), 421)  # not 401 (no key), not 415, not 404

    def test_allowed_hosts_adds_names(self):
        c = self.client({"ALLOWED_HOSTS": "gpu.example.com, 10.0.0.5:8081"})
        for host in ("gpu.example.com", "GPU.example.com:9000", "10.0.0.5:8081"):
            self.assertEqual(c.get("/health", headers={"Host": host}).status_code, 200, host)
        self.assertEqual(c.get("/health", headers={"Host": "10.0.0.5:9999"}).status_code, 421)  # that entry names a port
        self.assertEqual(c.get("/health", headers={"Host": "other.example.com"}).status_code, 421)

    def test_a_service_listening_on_all_interfaces_cannot_know_its_names_so_the_key_is_what_protects_it(self):
        # same rule as the old server: the Host check is for a service bound to this machine only
        c = self.client({"MODEL_HOST": "0.0.0.0", "MODEL_SERVICE_KEY": "k"})
        self.assertEqual(c.get("/health", headers={"Host": "gpu-box.internal:8081", MODEL_KEY: "k"}).status_code, 200)
        self.assertEqual(c.get("/health", headers={"Host": "gpu-box.internal:8081"}).status_code, 401)

    def test_a_host_added_to_the_env_file_counts_without_a_restart(self):
        env = support.write_env(self.tmp.name, "")
        c = support.make_app(self.tmp.name, {}).test_client()
        self.assertEqual(c.get("/health", headers={"Host": "late.example.com"}).status_code, 421)
        env.write_text("ALLOWED_HOSTS=late.example.com\n", encoding="utf-8")
        self.assertEqual(c.get("/health", headers={"Host": "late.example.com"}).status_code, 200)


class ModelKeyTests(ServiceCase):
    def test_without_a_configured_key_nothing_is_demanded_and_a_sent_key_is_ignored(self):
        c = self.client()
        self.assertEqual(c.get("/health", headers=LOCAL).status_code, 200)
        self.assertEqual(c.get("/health", headers={**LOCAL, MODEL_KEY: "whatever"}).status_code, 200)

    def test_with_a_key_the_right_one_passes_and_everything_else_is_401(self):
        c = self.client({"MODEL_SERVICE_KEY": "s3cret-key"})
        self.assertEqual(c.get("/health", headers={**LOCAL, MODEL_KEY: "s3cret-key"}).status_code, 200)
        for headers in ({}, {MODEL_KEY: ""}, {MODEL_KEY: "s3cret-ke"}, {MODEL_KEY: "s3cret-keyy"}, {MODEL_KEY: "S3CRET-KEY"}, {MODEL_KEY: "kéy"},
                        {"x-api-key": "s3cret-key"}, {"Authorization": "Bearer s3cret-key"}):
            err = self.assertError(c.get("/health", headers={**LOCAL, **headers}), 401, "UNAUTHENTICATED")
            self.assertNotIn("s3cret-key", err["message"])

    def test_every_route_wants_the_key_even_the_ones_that_do_not_exist(self):
        c = self.client({"MODEL_SERVICE_KEY": "k"})
        for method, path in (("GET", "/health"), ("POST", "/segment"), ("GET", "/sam/health"), ("POST", "/sam/refine"), ("POST", "/sam/segment"), ("GET", "/nowhere"), ("POST", "/health"), ("GET", "/")):
            self.assertError(c.open(path, method=method, headers=JSON), 401, "UNAUTHENTICATED")  # a stranger learns nothing about the routes
        ok = {**JSON, MODEL_KEY: "k"}
        self.assertError(c.get("/nowhere", headers=ok), 404)
        self.assertError(c.post("/health", data="{}", headers=ok), 405)

    def test_the_key_is_checked_before_the_content_type(self):
        c = self.client({"MODEL_SERVICE_KEY": "k"})
        self.assertError(c.post("/segment", data="x", headers={**LOCAL, "Content-Type": "text/plain"}), 401)
        self.assertError(c.post("/segment", data="x", headers={**LOCAL, "Content-Type": "text/plain", MODEL_KEY: "k"}), 415)

    def test_the_comparison_is_constant_time(self):
        c = self.client({"MODEL_SERVICE_KEY": "k"})
        with mock.patch.object(app_module.hmac, "compare_digest", wraps=app_module.hmac.compare_digest) as compare:
            c.get("/health", headers={**LOCAL, MODEL_KEY: "kéy-with-non-ascii"})
        self.assertTrue(compare.called)
        for call in compare.call_args_list:
            self.assertTrue(all(isinstance(a, bytes) for a in call.args))  # bytes in: a non-ASCII header cannot raise TypeError

    def test_a_key_in_the_env_file_counts_and_changes_apply_without_a_restart(self):
        env = support.write_env(self.tmp.name, "")
        c = support.make_app(self.tmp.name, {}).test_client()
        self.assertEqual(c.get("/health", headers=LOCAL).status_code, 200)
        env.write_text("MODEL_SERVICE_KEY=from-file\n", encoding="utf-8")
        self.assertEqual(c.get("/health", headers=LOCAL).status_code, 401)
        self.assertEqual(c.get("/health", headers={**LOCAL, MODEL_KEY: "from-file"}).status_code, 200)


class SamKeyTests(ServiceCase):
    """/sam/* also takes SAM_SERVER_KEY, so that SAM_REMOTE_URL=http://gpu-box:8081/sam works against this service when it runs alone.
    The old suite's SamServerKeyTests (the key gates only the SAM routes) is this, plus the model key beside it."""

    SAM_ROUTES = (("GET", "/sam/health"), ("POST", "/sam/refine"), ("POST", "/sam/segment"))

    def sam_client(self, **environ):
        return self.client(environ, sam=make_sam_manager({"x": np.ones((8, 8), np.uint8)}))

    def test_with_only_a_sam_key_the_sam_routes_take_it_as_x_api_key_or_as_a_bearer_token(self):
        c = self.sam_client(SAM_SERVER_KEY="s3cret")
        self.assertError(c.get("/sam/health", headers=LOCAL), 401, "UNAUTHENTICATED")
        self.assertEqual(c.get("/sam/health", headers={**LOCAL, "x-api-key": "s3cret"}).status_code, 200)
        self.assertEqual(c.get("/sam/health", headers={**LOCAL, "Authorization": "Bearer s3cret"}).status_code, 200)
        for headers in ({"x-api-key": "nope"}, {"Authorization": "Bearer nope"}, {MODEL_KEY: "s3cret"}, {MODEL_KEY: ""}):
            self.assertError(c.get("/sam/health", headers={**LOCAL, **headers}), 401, "UNAUTHENTICATED")

    def test_the_rest_of_the_service_is_not_gated_by_the_sam_key(self):
        c = self.sam_client(SAM_SERVER_KEY="s3cret")
        self.assertEqual(c.get("/health", headers=LOCAL).status_code, 200)  # the old "only /api/sam/* is gated"
        self.assertError(c.post("/segment", data=json_text({}), headers=JSON), 503, "FAILED_PRECONDITION")  # got past the guards

    def test_all_three_sam_routes_are_gated(self):
        c = self.sam_client(SAM_SERVER_KEY="s3cret")
        for method, path in self.SAM_ROUTES:
            self.assertError(c.open(path, method=method, headers=JSON), 401, "UNAUTHENTICATED")
            ok = c.open(path, method=method, data=json_text({}), headers={**JSON, "x-api-key": "s3cret"})
            self.assertNotEqual(ok.status_code, 401, path)  # past the guard (it then complains about the empty request)

    def test_with_both_keys_the_sam_routes_take_either_and_the_rest_takes_only_the_model_key(self):
        c = self.sam_client(SAM_SERVER_KEY="sam-key", MODEL_SERVICE_KEY="model-key")
        # /sam/*: the model key in its own header ...
        self.assertEqual(c.get("/sam/health", headers={**LOCAL, MODEL_KEY: "model-key"}).status_code, 200)
        # ... or the SAM key, either way of sending it
        self.assertEqual(c.get("/sam/health", headers={**LOCAL, "x-api-key": "sam-key"}).status_code, 200)
        self.assertEqual(c.get("/sam/health", headers={**LOCAL, "Authorization": "Bearer sam-key"}).status_code, 200)
        # neither, or the keys in each other's place
        self.assertError(c.get("/sam/health", headers=LOCAL), 401)
        self.assertError(c.get("/sam/health", headers={**LOCAL, MODEL_KEY: "sam-key"}), 401)
        self.assertError(c.get("/sam/health", headers={**LOCAL, "x-api-key": "model-key"}), 401)
        self.assertError(c.get("/sam/health", headers={**LOCAL, "Authorization": "Bearer model-key"}), 401)
        # /health and /segment keep wanting the model key alone
        for path, method in (("/health", "GET"), ("/segment", "POST")):
            self.assertError(c.open(path, method=method, headers={**JSON, "x-api-key": "sam-key"}), 401)
            self.assertError(c.open(path, method=method, headers={**JSON, "Authorization": "Bearer sam-key"}), 401)
        self.assertEqual(c.get("/health", headers={**LOCAL, MODEL_KEY: "model-key"}).status_code, 200)
        self.assertError(c.post("/segment", data=json_text({}), headers={**JSON, MODEL_KEY: "model-key"}), 503, "FAILED_PRECONDITION")

    def test_a_bad_x_api_key_does_not_fall_back_to_the_bearer_header_and_a_good_model_key_wins_over_a_bad_sam_key(self):
        c = self.sam_client(SAM_SERVER_KEY="sam-key", MODEL_SERVICE_KEY="model-key")
        self.assertEqual(c.get("/sam/health", headers={**LOCAL, MODEL_KEY: "model-key", "x-api-key": "wrong"}).status_code, 200)
        self.assertError(c.get("/sam/health", headers={**LOCAL, "x-api-key": "wrong", "Authorization": "Bearer sam-key"}), 401)

    def test_with_only_a_model_key_the_sam_routes_want_that_key_and_the_sam_headers_do_not_work(self):
        c = self.sam_client(MODEL_SERVICE_KEY="model-key")
        self.assertEqual(c.get("/sam/health", headers={**LOCAL, MODEL_KEY: "model-key"}).status_code, 200)
        self.assertError(c.get("/sam/health", headers={**LOCAL, "x-api-key": "model-key"}), 401)  # no SAM_SERVER_KEY, so no second way in
        self.assertError(c.get("/sam/health", headers={**LOCAL, "Authorization": "Bearer model-key"}), 401)

    def test_the_sam_comparison_is_constant_time_too(self):
        c = self.sam_client(SAM_SERVER_KEY="sam-key", MODEL_SERVICE_KEY="model-key")
        with mock.patch.object(app_module.hmac, "compare_digest", wraps=app_module.hmac.compare_digest) as compare:
            c.get("/sam/health", headers={**LOCAL, "x-api-key": "sam-kéy"})
        self.assertGreaterEqual(compare.call_count, 2)  # both keys were compared, not just until one matched

    def test_the_sam_key_opens_only_the_sam_routes(self):
        c = self.sam_client(SAM_SERVER_KEY="sam-key", MODEL_SERVICE_KEY="model-key")
        for path in ("/samurai", "/health", "/segment", "/nowhere"):
            self.assertError(c.get(path, headers={**LOCAL, "x-api-key": "sam-key"}), 401)
        self.assertError(c.get("/sam/nothing", headers={**LOCAL, "x-api-key": "sam-key"}), 404)  # under /sam/ it is past the guard: a plain 404


class RemoteSamClientTests(ServiceCase):
    """The service as the GPU box: the real RemoteBackend of sam/backends.py, over a real socket, with SAM_REMOTE_KEY."""

    def gpu_box(self, **environ):
        img, gt, labels = syn.build()
        truth = {n: (gt == i + 1).astype(np.uint8) for i, n in enumerate(labels)}
        return img, self.listen(self.app(environ, sam=make_sam_manager(truth)))

    def test_a_remote_backend_with_the_sam_key_as_bearer_or_x_api_key_gets_masks_from_the_bare_service(self):
        img, base = self.gpu_box(SAM_SERVER_KEY="gpu-key")
        for header in ("bearer", "x-api-key"):
            with self.subTest(header):
                remote = RemoteBackend(base + "/sam", "gpu-key", header)
                remote.load()
                self.assertEqual(remote.name, "Fake SAM")  # what /sam/health said
                self.assertTrue(remote.interactive)
                handle = remote.embed(img)
                candidates = remote.predict(handle, points=[(480, 400)], labels=[1])
                self.assertEqual(candidates[0].mask.shape, img.shape[:2])
                self.assertTrue(candidates[0].mask.any())
                self.assertTrue(handle.payload["image_id"])  # the second call can reuse the cached embedding
                again = remote.predict(handle, points=[(480, 400)], labels=[1])
                self.assertTrue(again[0].mask.any())

    def test_a_remote_backend_with_the_wrong_or_no_key_is_told_so(self):
        _img, base = self.gpu_box(SAM_SERVER_KEY="gpu-key")
        for key in ("wrong", ""):
            with self.assertRaises(SamUnavailable) as caught:
                RemoteBackend(base + "/sam", key).load()
            self.assertIn("rejected the key", str(caught.exception))

    def test_the_remote_backend_also_works_with_the_model_key_set_the_way_the_website_sends_it(self):
        _img, base = self.gpu_box(MODEL_SERVICE_KEY="model-key")
        req = urllib.request.Request(base + "/sam/health", headers={MODEL_KEY: "model-key"})
        with urllib.request.urlopen(req, timeout=10) as r:
            self.assertEqual(json.load(r)["status"], "ok")

    def test_a_second_service_can_use_the_first_as_its_remote_sam(self):
        img, base = self.gpu_box(SAM_SERVER_KEY="gpu-key")
        local = self.app({"SAM_ENABLED": "true", "SAM_REMOTE_URL": base + "/sam", "SAM_REMOTE_KEY": "gpu-key"}).test_client()
        status = None
        for _ in range(100):
            status = local.get("/health", headers=LOCAL).get_json()["sam"]
            if status["status"] not in ("idle", "loading"):
                break
            time.sleep(0.05)
        self.assertEqual((status["status"], status["backend"], status["model"]), ("ready", "remote", "Fake SAM"), status)
        r = local.post("/sam/refine", data=json_text({"image": jpeg_b64(img), "points": [[480, 400]], "labels": [1]}), headers=JSON)
        self.assertEqual(r.status_code, 200, r.get_data(as_text=True))
        self.assertTrue(r.get_json()["mask"])


def json_text(obj) -> str:
    return json.dumps(obj)


class ErrorShapeTests(ServiceCase):
    def test_unknown_routes_are_a_json_404(self):
        c = self.client()
        for path in ("/", "/nowhere", "/index.html", "/.env", "/static/app.js", "/health/", "/segment/extra", "/api/segment", "/api/health"):
            self.assertError(c.get(path, headers=LOCAL), 404, "NOT_FOUND")

    def test_the_wrong_method_is_a_json_405_that_names_the_methods_allowed(self):
        c = self.client()
        r = c.get("/segment", headers=LOCAL)
        self.assertError(r, 405, "METHOD_NOT_ALLOWED")
        self.assertIn("POST", r.headers["Allow"])
        r = c.post("/health", data="{}", headers=JSON)
        self.assertError(r, 405)
        self.assertIn("GET", r.headers["Allow"])
        for method in ("PUT", "PATCH", "DELETE"):
            self.assertError(c.open("/sam/refine", method=method, data="{}", headers=JSON), 405)
        self.assertError(c.get("/sam/refine", headers=LOCAL), 405)
        self.assertError(c.post("/sam/health", data="{}", headers=JSON), 405)

    def test_a_post_that_is_not_json_is_a_415_before_the_body_is_looked_at(self):
        c = self.client()
        for ctype in ("text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", "application/jsonx", None):
            headers = dict(LOCAL)
            if ctype:
                headers["Content-Type"] = ctype
            for method, path in (("POST", "/segment"), ("POST", "/sam/refine"), ("POST", "/sam/segment"), ("POST", "/nowhere"), ("PUT", "/health"), ("DELETE", "/health")):
                self.assertError(c.open(path, method=method, data="{not json", headers=headers), 415, "UNSUPPORTED_MEDIA_TYPE", "application/json")

    def test_json_with_a_charset_or_odd_case_is_accepted(self):
        c = self.client()
        for ctype in ("application/json; charset=utf-8", "Application/JSON"):
            r = c.post("/segment", data=json_text({}), headers={**LOCAL, "Content-Type": ctype})
            self.assertError(r, 503, "FAILED_PRECONDITION")  # past the guard; Google is not configured here

    def test_a_get_needs_no_content_type(self):
        self.assertEqual(self.client().get("/health", headers=LOCAL).status_code, 200)

    def test_the_body_limit_is_80_mb_and_a_larger_one_is_a_json_413(self):
        app = self.app()
        self.assertEqual(app.config["MAX_CONTENT_LENGTH"], 80 * 1024 * 1024)
        c = app.test_client()
        too_big = {"CONTENT_LENGTH": str(80 * 1024 * 1024 + 1)}
        for path in ("/segment", "/sam/refine", "/sam/segment"):  # SAM is off, yet the answer is 413 and not 503: the size is checked first
            r = c.post(path, data=b"{}", headers=JSON, environ_overrides=too_big)
            self.assertError(r, 413, "PAYLOAD_TOO_LARGE", "80 MB")
            self.assertEqual(r.headers["Connection"], "close")

    def test_the_limit_is_read_from_the_app_so_a_real_body_over_it_is_refused_too(self):
        app = self.app()
        app.config["MAX_CONTENT_LENGTH"] = 1000
        r = app.test_client().post("/segment", data=b" " * 5000, headers=JSON)
        self.assertError(r, 413, "PAYLOAD_TOO_LARGE")

    def test_a_chunked_body_over_the_limit_is_refused_while_it_is_read(self):
        # no Content-Length to look at up front (the website streams request bodies): Flask counts the bytes as they arrive
        import requests

        app = self.app({"GEMINI_API_KEY": "abc"})
        app.config["MAX_CONTENT_LENGTH"] = 1000
        base = self.listen(app)
        r = requests.post(base + "/segment", data=(chunk for chunk in [b" " * 600, b" " * 600, b" " * 600]), headers={"Content-Type": "application/json"}, timeout=20)
        self.assertEqual(r.status_code, 413)
        self.assertEqual(r.json()["error"]["status"], "PAYLOAD_TOO_LARGE")
        small = requests.post(base + "/segment", data=(chunk for chunk in [b'{"ima', b'ge": 5}']), headers={"Content-Type": "application/json"}, timeout=20)
        self.assertEqual(small.status_code, 400)  # the same route with a body under the limit gets to the image check

    def test_http_exceptions_raised_inside_a_route_use_the_same_shape(self):
        from werkzeug.exceptions import RequestEntityTooLarge

        app = self.app()
        app.add_url_rule("/_big", view_func=lambda: (_ for _ in ()).throw(RequestEntityTooLarge()))
        self.assertError(app.test_client().get("/_big", headers=LOCAL), 413, "PAYLOAD_TOO_LARGE")

    def test_an_unexpected_failure_is_a_json_500_that_leaks_nothing(self):
        app = self.app()
        app.add_url_rule("/_boom", view_func=lambda: {}["secret-internal-detail"])
        with self.assertLogs("terucon", level="ERROR"):
            r = app.test_client().get("/_boom", headers=LOCAL)
        err = self.assertError(r, 500, "INTERNAL")
        self.assertNotIn("secret-internal-detail", err["message"])
        self.assertNotIn("Traceback", r.get_data(as_text=True))

    def test_json_responses_are_not_cacheable_and_not_sniffable(self):
        r = self.client().get("/health", headers=LOCAL)
        self.assertEqual(r.headers["Cache-Control"], "no-store")
        self.assertEqual(r.headers["X-Content-Type-Options"], "nosniff")
        self.assertEqual(self.client().get("/nowhere", headers=LOCAL).headers["X-Content-Type-Options"], "nosniff")

    def test_no_cors_headers_and_no_pages(self):
        c = self.client()
        for r in (c.get("/health", headers={**LOCAL, "Origin": "https://evil.example.com"}),
                  c.options("/segment", headers={**LOCAL, "Origin": "https://evil.example.com", "Access-Control-Request-Method": "POST"}),
                  c.get("/", headers=LOCAL)):
            self.assertFalse([h for h in r.headers.keys() if h.lower().startswith("access-control-")], r.headers)
        self.assertNotIn("html", c.get("/", headers=LOCAL).mimetype)


class HealthTests(ServiceCase):
    def test_the_body_of_a_service_with_nothing_configured(self):
        r = self.client().get("/health", headers=LOCAL)
        self.assertEqual(r.status_code, 200)
        h = r.get_json()
        self.assertEqual(list(h), HEALTH_KEYS)
        self.assertEqual((h["ok"], h["service"], h["version"]), (True, "terucon-model", __version__))
        self.assertEqual(h["google"], {"configured": False, "mode": "none", "error": ""})
        self.assertEqual(h["segmentation"], {"engine": "auto", "edgeRefine": True, "edgeMethod": "contour", "analysisMaxSide": 1536})
        # SamManager.status(), key for key
        self.assertEqual(sorted(h["sam"]), sorted(SamManager(SamConfig()).status()))
        self.assertEqual((h["sam"]["status"], h["sam"]["enabled"]), ("off", False))

    def test_google_modes(self):
        info, _ = make_service_account("https://oauth2.googleapis.com/token", "my-project-123")
        vertex = self.client({"GCP_SERVICE_ACCOUNT_JSON": json_text(info)}).get("/health", headers=LOCAL).get_json()
        self.assertEqual(vertex["google"], {"configured": True, "mode": "vertex", "error": ""})
        key = self.client({"GEMINI_API_KEY": "abc"}).get("/health", headers=LOCAL).get_json()
        self.assertEqual(key["google"], {"configured": True, "mode": "api-key", "error": ""})
        bad = self.client({"GCP_SERVICE_ACCOUNT_JSON": "{not json"}).get("/health", headers=LOCAL).get_json()
        self.assertFalse(bad["google"]["configured"])
        self.assertIn("not valid JSON", bad["google"]["error"])

    def test_the_segmentation_settings_are_reported(self):
        h = self.client({"SEGMENTATION_ENGINE": "sam", "EDGE_REFINE": "off", "EDGE_METHOD": "watershed", "ANALYSIS_MAX_SIDE": "9999"}).get("/health", headers=LOCAL).get_json()
        self.assertEqual(h["segmentation"], {"engine": "sam", "edgeRefine": False, "edgeMethod": "watershed", "analysisMaxSide": 3072})

    def test_no_secret_ever_appears(self):
        info, _ = make_service_account("https://oauth2.googleapis.com/token", "my-project-123")
        secrets = ["SECRETKEY999", "SAMSERVER777", "SAMREMOTE555", "HFTOKEN333", "MODELKEY111", info["private_key_id"], info["client_email"], "BEGIN PRIVATE KEY"]
        env = {"GCP_SERVICE_ACCOUNT_JSON": json_text(info), "GEMINI_API_KEY": secrets[0], "SAM_SERVER_KEY": secrets[1], "SAM_REMOTE_KEY": secrets[2],
               "HF_TOKEN": secrets[3], "MODEL_SERVICE_KEY": secrets[4], "SAM_ENABLED": "true", "SAM_REMOTE_URL": "http://127.0.0.1:9/sam"}
        raw = self.client(env).get("/health", headers={**LOCAL, MODEL_KEY: secrets[4]}).get_data(as_text=True)
        for secret in secrets:
            self.assertNotIn(secret, raw)

    def test_the_sam_block_is_the_managers_own_status(self):
        sam = make_sam_manager({"x": np.ones((4, 4), np.uint8)})
        h = self.client(sam=sam).get("/health", headers=LOCAL).get_json()
        self.assertEqual(h["sam"], sam.status())
        self.assertEqual((h["sam"]["status"], h["sam"]["interactive"], h["sam"]["textPrompts"]), ("ready", True, False))

    def test_health_survives_a_sam_manager_that_cannot_report(self):
        sam = mock.Mock()
        sam.status.side_effect = RuntimeError("torch exploded " + "x" * 500)
        h = self.client(sam=sam).get("/health", headers=LOCAL).get_json()
        self.assertEqual(h["ok"], True)
        self.assertEqual(h["sam"]["status"], "error")
        self.assertLessEqual(len(h["sam"]["error"]), 200)

    def test_editing_the_env_file_is_picked_up_without_a_restart(self):
        env = support.write_env(self.tmp.name, "")
        c = support.make_app(self.tmp.name, {}).test_client()
        self.assertFalse(c.get("/health", headers=LOCAL).get_json()["google"]["configured"])
        env.write_text("GEMINI_API_KEY=abc\n", encoding="utf-8")
        self.assertTrue(c.get("/health", headers=LOCAL).get_json()["google"]["configured"])
        env.write_text("GEMINI_API_KEY=abc\nEDGE_METHOD=watershed\nSEGMENTATION_ENGINE=sam\n", encoding="utf-8")
        h = c.get("/health", headers=LOCAL).get_json()
        self.assertEqual((h["segmentation"]["edgeMethod"], h["segmentation"]["engine"]), ("watershed", "sam"))

    def test_the_real_environment_beats_the_file_on_reload_as_well(self):
        env = support.write_env(self.tmp.name, "EDGE_METHOD=contour\n")
        c = support.make_app(self.tmp.name, {"EDGE_METHOD": "watershed"}).test_client()
        env.write_text("EDGE_METHOD=contour\n# touched\n", encoding="utf-8")
        self.assertEqual(c.get("/health", headers=LOCAL).get_json()["segmentation"]["edgeMethod"], "watershed")

    def test_a_service_account_added_later_is_used_by_the_next_scan(self):
        # the Google client is rebuilt when the settings change, not kept from the first request
        app = self.app()
        ext = app.extensions["terucon"]
        first = ext["auth"](ext["settings"]())
        self.assertIs(first, ext["auth"](ext["settings"]()))
        (Path(self.tmp.name) / ".env").write_text("GEMINI_API_KEY=abc\n", encoding="utf-8")
        self.assertIsNot(first, ext["auth"](ext["settings"]()))


class SegmentWithoutGoogleTests(ServiceCase):
    def test_not_configured_is_a_503_that_says_what_to_do_and_touches_nothing(self):
        sam = mock.Mock()
        c = self.client(sam=sam)
        r = c.post("/segment", data=json_text({"image": jpeg_b64(syn.build()[0])}), headers=JSON)
        self.assertError(r, 503, "FAILED_PRECONDITION", "not configured")
        self.assertEqual(sam.method_calls, [])

    def test_the_message_is_googles_own_complaint_when_there_is_one(self):
        c = self.client({"GCP_SERVICE_ACCOUNT_JSON": "{not json"})
        self.assertError(c.post("/segment", data=json_text({}), headers=JSON), 503, "FAILED_PRECONDITION", "not valid JSON")

    def test_it_is_checked_before_the_image_is_looked_at(self):
        r = self.client().post("/segment", data="this is not json at all", headers=JSON)
        self.assertError(r, 503, "FAILED_PRECONDITION")

    def test_once_google_is_added_to_the_file_the_same_service_gets_to_the_image(self):
        env = support.write_env(self.tmp.name, "")
        c = support.make_app(self.tmp.name, {}).test_client()
        self.assertEqual(c.post("/segment", data=json_text({}), headers=JSON).status_code, 503)
        env.write_text("GEMINI_API_KEY=abc\n", encoding="utf-8")
        self.assertError(c.post("/segment", data=json_text({}), headers=JSON), 400, "INVALID_ARGUMENT", "base64")


class BadRequestsTests(ServiceCase):
    """What a confused client sends. All of it must be a 4xx in the standard shape, never a 500."""

    def configured(self, **kw):
        return self.client({"GEMINI_API_KEY": "abc"}, **kw)

    def test_segment(self):
        c = self.configured()
        huge = io_png(4097, 1)
        for body, contains in (
            ("[]", "base64"), ('"text"', "base64"), ("null", "base64"), ("{not json", "base64"), ('{"image": 5}', "base64"), ('{"image": ""}', "base64"),
            ('{"image": "!!!notbase64"}', "could not be decoded"), (json_text({"image": "data:image/png;base64,AAAA"}), "could not be decoded"),
            (json_text({"image": huge}), "4096px"),
        ):
            self.assertError(c.post("/segment", data=body, headers=JSON), 400, "INVALID_ARGUMENT", contains)

    def test_sam_refine_and_segment_on_a_ready_manager(self):
        sam = make_sam_manager({"x": np.ones((8, 8), np.uint8)})
        c = self.client(sam=sam)
        img = jpeg_b64(syn.build()[0])
        refine = lambda body: c.post("/sam/refine", data=json_text(body), headers=JSON)  # noqa: E731
        self.assertError(refine({}), 409, "FAILED_PRECONDITION", "Send the image again")
        self.assertError(refine({"image_id": "gone"}), 409, "FAILED_PRECONDITION")
        self.assertError(refine({"image": "nope", "points": [[1, 1]]}), 400, "INVALID_ARGUMENT")
        self.assertError(refine({"image": img}), 400, "INVALID_ARGUMENT", "point or a box")
        for bad in ({"points": 5}, {"points": [["a", "b"]]}, {"points": [[1, 1]], "labels": ["x"]}, {"points": None}, {"box": ["a", 1, 2, 3]}):
            self.assertError(refine({"image": img, **bad}), 400, "INVALID_ARGUMENT")
        segment = lambda body: c.post("/sam/segment", data=json_text(body), headers=JSON)  # noqa: E731
        self.assertError(segment({"image": img, "prompts": ["wall"]}), 501, "UNIMPLEMENTED", "boxes and points")  # this fake SAM takes no text

    def test_sam_segment_arguments_on_a_text_backend(self):
        from fakes import FakeTextSam

        by_kind = {"wall": [np.ones((720, 960), np.uint8)]}
        sam = SamManager(SamConfig(enabled=True, preload=False, backend="sam3"), backend_factory=lambda c: FakeTextSam(by_kind, (720, 960)))
        sam._load()
        c = self.client(sam=sam)
        img = jpeg_b64(syn.build()[0])
        post = lambda body: c.post("/sam/segment", data=json_text(body), headers=JSON)  # noqa: E731
        self.assertError(post({"prompts": ["wall"]}), 400, "INVALID_ARGUMENT", "base64")
        self.assertError(post({"image": img}), 400, "INVALID_ARGUMENT", "list of prompts")
        self.assertError(post({"image": img, "prompts": ["", "  "]}), 400, "INVALID_ARGUMENT", "list of prompts")
        self.assertError(post({"image": img, "prompts": 5}), 400, "INVALID_ARGUMENT")
        self.assertError(post({"image": img, "prompts": ["wall"], "confidence_threshold": "high"}), 400, "INVALID_ARGUMENT")
        ok = post({"image": img, "prompts": ["wall"], "max_per_prompt": "3"})
        self.assertEqual(ok.status_code, 200, ok.get_data(as_text=True))
        body = ok.get_json()
        self.assertEqual(sorted(body), ["detections", "image_id", "model"])
        self.assertEqual({d["prompt"] for d in body["detections"]}, {"wall"})

    def test_sam_routes_when_sam_is_off_or_broken(self):
        c = self.client()
        self.assertError(c.post("/sam/refine", data=json_text({"points": [[1, 1]]}), headers=JSON), 503, "FAILED_PRECONDITION", "switched off")
        self.assertError(c.post("/sam/segment", data=json_text({}), headers=JSON), 503, "FAILED_PRECONDITION", "switched off")
        h = c.get("/sam/health", headers=LOCAL).get_json()
        self.assertEqual(h, {"status": "off", "model": "facebook/sam2.1-hiera-small", "backend": "auto", "device": "", "interactive": False, "text_prompts": False, "error": ""})

        broken = SamManager(SamConfig(enabled=True, preload=False, backend="sam2"), backend_factory=lambda c: (_ for _ in ()).throw(RuntimeError("no torch")))
        broken._load()
        c = self.client(sam=broken)
        self.assertError(c.post("/sam/refine", data=json_text({"points": [[1, 1]]}), headers=JSON), 503, "FAILED_PRECONDITION", "no torch")
        self.assertEqual(c.get("/sam/health", headers=LOCAL).get_json()["status"], "error")

        loading = SamManager(SamConfig(enabled=True, preload=False))
        loading._status = "loading"
        self.assertError(self.client(sam=loading).post("/sam/refine", data=json_text({}), headers=JSON), 503, "UNAVAILABLE", "still loading")


def io_png(w: int, h: int) -> str:
    import base64

    buf = io.BytesIO()
    Image.new("RGB", (w, h), (10, 20, 30)).save(buf, "PNG")
    return base64.b64encode(buf.getvalue()).decode()


class ServeHelperTests(ServiceCase):
    """serve() in-process: bind first, one READY line, port 0, stop on request. The real process is test_process.py."""

    def run_serve(self, environ):
        out, err = io.StringIO(), io.StringIO()
        stop = threading.Event()
        result = {}
        env_path = support.write_env(self.tmp.name, "")

        def target():
            with contextlib.redirect_stderr(err):
                result["code"] = serve(env_path=env_path, environ={"HOME": self.tmp.name, "MODEL_PORT": "0", **environ}, stop=stop, out=out, install_signals=False)

        t = threading.Thread(target=target, daemon=True)
        t.start()
        for _ in range(200):
            if out.getvalue().strip() or not t.is_alive():
                break
            time.sleep(0.05)
        self.addCleanup(lambda: (stop.set(), t.join(10)))
        return out, err, stop, t, result

    def test_port_zero_binds_a_free_port_and_the_one_line_says_which(self):
        out, err, stop, t, result = self.run_serve({})
        lines = out.getvalue().splitlines()
        self.assertEqual(len(lines), 1, lines)
        self.assertRegex(lines[0], r"^TERUCON_MODEL_READY http://127\.0\.0\.1:[1-9][0-9]+$")
        with urllib.request.urlopen(lines[0].split()[1] + "/health", timeout=10) as r:
            self.assertEqual(json.load(r)["service"], "terucon-model")
        self.assertNotIn("TERUCON_MODEL_READY", err.getvalue())  # the human text is on stderr, the machine line only on stdout
        self.assertIn("Terucon model service", err.getvalue())
        stop.set()
        t.join(10)
        self.assertFalse(t.is_alive())
        self.assertEqual(result["code"], 0)

    def test_the_ready_url_names_a_reachable_address_even_when_listening_on_all_interfaces(self):
        out, _err, stop, t, _result = self.run_serve({"MODEL_HOST": "0.0.0.0", "MODEL_SERVICE_KEY": "k"})
        url = out.getvalue().split()[1]
        self.assertTrue(url.startswith("http://127.0.0.1:"), url)
        with self.assertRaises(urllib.error.HTTPError) as caught:
            urllib.request.urlopen(url + "/health", timeout=10)
        self.assertEqual(caught.exception.code, 401)
        stop.set()

    def test_a_busy_port_is_reported_and_the_exit_code_is_1(self):
        import socket

        with socket.socket() as busy:
            busy.bind(("127.0.0.1", 0))
            busy.listen()
            out, err, _stop, t, result = self.run_serve({"MODEL_PORT": str(busy.getsockname()[1])})
            t.join(20)
        self.assertEqual(result.get("code"), 1)
        self.assertEqual(out.getvalue(), "")  # no READY line for a service that is not listening
        self.assertIn("Could not start", err.getvalue())

    def test_the_banner_warns_about_an_open_network_listener_without_a_key(self):
        _out, err, stop, t, _result = self.run_serve({"MODEL_HOST": "0.0.0.0"})
        stop.set()
        t.join(10)
        self.assertIn("MODEL_SERVICE_KEY is not set", err.getvalue())

    def test_the_banner_never_prints_a_secret(self):
        _out, err, stop, t, _result = self.run_serve({"MODEL_SERVICE_KEY": "MODELKEY111", "SAM_SERVER_KEY": "SAMKEY222", "GEMINI_API_KEY": "APIKEY333"})
        stop.set()
        t.join(10)
        for secret in ("MODELKEY111", "SAMKEY222", "APIKEY333"):
            self.assertNotIn(secret, err.getvalue())


if __name__ == "__main__":
    unittest.main()
