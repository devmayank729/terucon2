"""The service's own Google client (vertex.py + google_auth.py), called directly against a mock Google.

This is the Vertex suite of the old server (VertexProxyTests, ApiKeyModeTests) minus the Flask route around it, which now
belongs to the website (/api/vertex/generate, tested in JavaScript). Back-off sleeps and the clock are injected, so nothing
here waits.
"""
from __future__ import annotations

import json
import sys
import time
import unittest
from pathlib import Path
from unittest import mock

import requests

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

import support  # noqa: E402
from mock_google import MockGoogle, make_service_account, text_response  # noqa: E402
from terucon_model import vertex  # noqa: E402
from terucon_model.config import load_settings  # noqa: E402
from terucon_model.google_auth import GoogleAuth, GoogleAuthError  # noqa: E402

MODEL = "gemini-x-1"
BODY = {"contents": [{"role": "user", "parts": [{"text": "hi"}]}]}
BUSY = {"error": {"code": 503, "status": "UNAVAILABLE", "message": "overloaded"}}
QUOTA = {"error": {"code": 429, "status": "RESOURCE_EXHAUSTED", "message": "q"}}


class ClientCase(unittest.TestCase):
    """A MockGoogle, a service-account key whose token_uri points at it, and settings + auth built from them."""

    def setUp(self):
        self.info, self.pub = make_service_account("placeholder")
        self.mock = MockGoogle(self.pub)
        self.mock.start()
        self.addCleanup(self.mock.stop)
        self.info["token_uri"] = self.mock.token_url
        self.tmp = support.tempdir()
        self.addCleanup(self.tmp.cleanup)
        self.settings = self.load(support.google_environ(self.info, self.mock.base))
        self.auth = GoogleAuth(self.settings.google)
        self.sleeps: list[float] = []

    def load(self, environ):
        return load_settings(support.write_env(self.tmp.name), environ={"HOME": self.tmp.name, **environ})

    def call(self, model=MODEL, body=None, location=None, **kw):
        kw.setdefault("sleep", self.sleeps.append)
        return vertex.generate_content(self.settings, self.auth, model, BODY if body is None else body, location, **kw)


class SigningAndForwardingTests(ClientCase):
    def test_happy_path_signs_a_valid_jwt_and_forwards_the_body(self):
        status, data, info = self.call()
        self.assertEqual(status, 200)
        self.assertEqual(data["candidates"][0]["content"]["parts"][0]["text"], "ok")
        self.assertEqual(info, {"attempts": 1, "model": MODEL})
        tok = self.mock.token_calls[0]
        self.assertTrue(tok["signature_ok"])
        self.assertEqual(tok["header"]["alg"], "RS256")
        self.assertEqual(tok["payload"]["iss"], self.info["client_email"])
        self.assertEqual(tok["payload"]["aud"], self.mock.token_url)
        self.assertIn("cloud-platform", tok["payload"]["scope"])
        call = self.mock.generate_calls[0]
        self.assertIn(f"/v1/projects/terucon-test-project/locations/global/publishers/google/models/{MODEL}:generateContent", call["path"])
        self.assertEqual(call["body"]["contents"][0]["parts"][0]["text"], "hi")
        self.assertTrue(call["headers"]["authorization"].startswith("Bearer mock-token-"))
        self.assertEqual(call["headers"]["content-type"], "application/json")
        self.assertEqual(self.sleeps, [])

    def test_token_is_cached_across_requests(self):
        self.call()
        self.call()
        self.assertEqual(len(self.mock.token_calls), 1)
        self.assertEqual(len(self.mock.generate_calls), 2)

    def test_a_token_close_to_expiry_is_fetched_again(self):
        self.call()
        self.auth._expires_at = time.time() + 30  # inside the 120 s refresh margin
        self.call()
        self.assertEqual(len(self.mock.token_calls), 2)

    def test_location_is_used_in_the_path_and_the_host(self):
        self.call(location="asia-south1")
        self.assertIn("/locations/asia-south1/", self.mock.generate_calls[0]["path"])

    def test_the_real_endpoints_when_custom_ones_are_not_allowed(self):
        s = self.load({"GCP_SERVICE_ACCOUNT_JSON": json.dumps({**self.info, "token_uri": "https://oauth2.googleapis.com/token"}), "TERUCON_VERTEX_API_BASE": self.mock.base})
        self.assertEqual(vertex.endpoint(s, MODEL, None), (f"https://aiplatform.googleapis.com/v1/projects/terucon-test-project/locations/global/publishers/google/models/{MODEL}:generateContent", "bearer"))
        self.assertEqual(vertex.endpoint(s, MODEL, "asia-south1")[0], f"https://asia-south1-aiplatform.googleapis.com/v1/projects/terucon-test-project/locations/asia-south1/publishers/google/models/{MODEL}:generateContent")

    def test_bad_model_name_and_location_are_rejected_before_any_network_call(self):
        for bad in ("../../etc/passwd", "a", "x" * 81, "gemini x", ""):
            status, data, info = self.call(model=bad)
            self.assertEqual((status, data["error"]["status"], info["attempts"]), (400, "INVALID_ARGUMENT", 0), bad)
        status, data, _ = self.call(location="Not A Location!")
        self.assertEqual(status, 400)
        self.assertIn("Invalid location", data["error"]["message"])
        self.assertEqual(self.mock.generate_calls, [])
        self.assertEqual(self.mock.token_calls, [])

    def test_not_configured_is_a_503_precondition_failure_without_a_call(self):
        s = self.load({})
        status, data, _ = vertex.generate_content(s, GoogleAuth(s.google), MODEL, BODY, sleep=self.sleeps.append)
        self.assertEqual((status, data["error"]["status"]), (503, "FAILED_PRECONDITION"))
        self.assertEqual(self.mock.generate_calls, [])


class UpstreamErrorTests(ClientCase):
    def test_googles_error_status_and_body_pass_through_unchanged(self):
        err = {"error": {"code": 404, "status": "NOT_FOUND", "message": "Publisher Model `projects/x/models/gemini-x-1` was not found."}}
        self.mock.script[MODEL] = [(404, err)]
        status, data, info = self.call()
        self.assertEqual((status, data), (404, err))
        self.assertEqual(len(self.mock.generate_calls), 1)  # a 404 is final: no retry
        self.assertEqual(info["attempts"], 1)

    def test_400_is_not_retried(self):
        err = {"error": {"code": 400, "status": "INVALID_ARGUMENT", "message": "bad"}}
        self.mock.script[MODEL] = [(400, err)]
        self.assertEqual(self.call()[0], 400)
        self.assertEqual(len(self.mock.generate_calls), 1)
        self.assertEqual(self.sleeps, [])

    def test_a_reply_that_is_not_json_comes_back_as_an_error_object(self):
        class Html:  # what a proxy in front of Google sends when it gives up
            status_code, headers, text = 502, {}, "<html>Bad gateway</html>" + "x" * 400

            def json(self):
                raise ValueError("not json")

        self.auth.token()  # fetched now: requests.post is patched below, and the token request uses it too
        with mock.patch.object(vertex.requests, "post", return_value=Html()):
            status, data, info = self.call()
        self.assertEqual((status, info["attempts"]), (502, 4))  # a 502 is retried like any other transient failure
        self.assertEqual(data["error"]["code"], 502)
        self.assertEqual(data["error"]["status"], "UNKNOWN")
        self.assertTrue(data["error"]["message"].startswith("<html>Bad gateway</html>"))
        self.assertEqual(len(data["error"]["message"]), 300)

    def test_transient_errors_are_retried_then_succeed(self):
        self.mock.script[MODEL] = [(503, BUSY), (429, QUOTA)]
        status, _data, info = self.call()
        self.assertEqual((status, info["attempts"]), (200, 3))
        self.assertEqual(len(self.sleeps), 2)

    def test_every_retryable_status_is_retried(self):
        for code in (429, 500, 502, 503, 504):
            with self.subTest(code):
                self.mock.generate_calls.clear()
                self.mock.script[MODEL] = [(code, {"error": {"code": code, "status": "X", "message": "m"}})]
                status, _data, info = self.call()
                self.assertEqual((status, info["attempts"]), (200, 2))

    def test_gives_up_after_the_attempt_limit_and_returns_the_last_error(self):
        self.mock.script[MODEL] = [(503, BUSY)] * 10
        status, data, info = self.call()
        self.assertEqual((status, data, info["attempts"]), (503, BUSY, 4))
        self.assertEqual(len(self.mock.generate_calls), 4)
        self.assertEqual(len(self.sleeps), 3)  # no sleeping after the last attempt

    def test_back_off_doubles_with_a_little_jitter(self):
        self.mock.script[MODEL] = [(503, BUSY)] * 10
        self.call()
        for waited, base in zip(self.sleeps, (1, 2, 4)):
            self.assertGreaterEqual(waited, base * 0.8 - 1e-9)
            self.assertLessEqual(waited, base * 1.2 + 1e-9)

    def test_retry_after_is_honoured(self):
        self.mock.script[MODEL] = [(429, QUOTA, {"Retry-After": "7"}), (503, BUSY, {"Retry-After": "0"})]
        status, _data, _info = self.call()
        self.assertEqual(status, 200)
        self.assertEqual(self.sleeps, [7.0, 0.0])

    def test_retry_after_is_capped_at_20_seconds(self):
        self.mock.script[MODEL] = [(429, QUOTA, {"Retry-After": "600"})]
        self.call()
        self.assertEqual(self.sleeps, [20.0])

    def test_an_unreadable_retry_after_falls_back_to_the_back_off(self):
        self.mock.script[MODEL] = [(503, BUSY, {"Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT"})]  # the date form is not parsed
        self.call()
        self.assertEqual(len(self.sleeps), 1)
        self.assertTrue(0.8 <= self.sleeps[0] <= 1.2, self.sleeps)

    def test_a_dropped_connection_is_retried_and_finally_reported_as_unreachable(self):
        self.auth.token()
        with mock.patch.object(vertex.requests, "post", side_effect=requests.ConnectionError("refused")) as post:
            status, data, info = self.call()
        self.assertEqual((status, data["error"]["status"], info["attempts"]), (503, "UNAVAILABLE", 4))
        self.assertIn("internet connection", data["error"]["message"])
        self.assertEqual(post.call_count, 4)
        self.assertEqual(len(self.sleeps), 3)

    def test_a_connect_timeout_is_worth_another_try(self):
        self.auth.token()
        real_post = requests.post
        calls = {"n": 0}

        def flaky(*a, **k):
            calls["n"] += 1
            if calls["n"] == 1:
                raise requests.ConnectTimeout("slow to connect")
            return real_post(*a, **k)

        with mock.patch.object(vertex.requests, "post", side_effect=flaky):
            status, _data, info = self.call()
        self.assertEqual((status, info["attempts"]), (200, 2))

    def test_the_connect_and_read_timeouts_requests_is_given(self):
        self.auth.token()
        seen = {}
        real_post = requests.post

        def spy(*a, **k):
            seen.update(k)
            return real_post(*a, **k)

        with mock.patch.object(vertex.requests, "post", side_effect=spy):
            self.call()
        self.assertEqual(seen["timeout"], (10, 240))

    def test_a_call_google_never_answers_is_not_retried_and_reports_a_timeout(self):
        def hang(model, body, headers):
            time.sleep(1.5)
            return 200, text_response("too late")

        self.mock.default_handler = hang
        with mock.patch.object(vertex, "READ_TIMEOUT", 0.4):
            t0 = time.monotonic()
            status, data, info = self.call()
            took = time.monotonic() - t0
        self.assertEqual((status, data["error"]["status"], info["attempts"]), (504, "DEADLINE_EXCEEDED", 1))
        self.assertIn("did not answer", data["error"]["message"])
        self.assertLess(took, 1.4, "it waited for more than one attempt")
        self.assertEqual(len(self.mock.generate_calls), 1)
        self.assertEqual(self.sleeps, [])

    def test_the_total_wait_is_capped_even_when_every_attempt_fails_slowly(self):
        self.mock.script[MODEL] = [(503, BUSY)] * 10
        now = {"t": 0.0}
        waited = []

        def fake_sleep(sec):
            waited.append(sec)
            now["t"] += 200.0  # each back-off "takes" 200 s

        status, _data, info = vertex.generate_content(self.settings, self.auth, MODEL, {"contents": []}, sleep=fake_sleep, clock=lambda: now["t"])
        self.assertEqual(status, 503)
        self.assertLessEqual(info["attempts"], 2)  # the 330 s cap stopped it long before 4 attempts
        self.assertLessEqual(len(self.mock.generate_calls), 2)
        self.assertEqual(vertex.MAX_TOTAL_SECONDS, 330)


class TokenTests(ClientCase):
    def test_a_401_refreshes_the_token_once_and_the_retry_does_not_count_as_an_attempt(self):
        self.mock.script[MODEL] = [(401, {"error": {"code": 401, "status": "UNAUTHENTICATED", "message": "expired"}})]
        status, _data, info = self.call()
        self.assertEqual(status, 200)
        self.assertEqual(info["attempts"], 1)
        self.assertEqual(len(self.mock.token_calls), 2)  # the first token was thrown away
        self.assertEqual(len(self.mock.generate_calls), 2)
        tokens = [c["headers"]["authorization"] for c in self.mock.generate_calls]
        self.assertNotEqual(tokens[0], tokens[1])
        self.assertEqual(self.sleeps, [])

    def test_a_second_401_is_passed_on_instead_of_looping(self):
        err = {"error": {"code": 401, "status": "UNAUTHENTICATED", "message": "still no"}}
        self.mock.script[MODEL] = [(401, err), (401, err)]
        status, data, _info = self.call()
        self.assertEqual((status, data), (401, err))
        self.assertEqual((len(self.mock.token_calls), len(self.mock.generate_calls)), (2, 2))

    def test_rejected_key_gives_a_readable_401(self):
        self.mock.token_fail = (400, {"error": "invalid_grant", "error_description": "Invalid JWT Signature."})
        status, data, info = self.call()
        self.assertEqual((status, data["error"]["status"], info["attempts"]), (401, "UNAUTHENTICATED", 1))
        self.assertIn("deleted or disabled", data["error"]["message"])
        self.assertEqual(self.mock.generate_calls, [])

    def test_clock_skew_is_explained(self):
        self.mock.token_fail = (400, {"error": "invalid_grant", "error_description": "Invalid JWT: Token must be a short-lived token (60 minutes) and in a reasonable timeframe."})
        status, data, _info = self.call()
        self.assertEqual(status, 401)
        self.assertIn("clock", data["error"]["message"])

    def test_other_oauth_errors_are_turned_into_advice_too(self):
        cases = [
            ({"error": "invalid_grant", "error_description": "account not found"}, "still exists and is enabled"),
            ({"error": "invalid_scope", "error_description": "x"}, "permission scope"),
            ({"error": "server_error"}, "Token request failed: server_error"),
        ]
        for fail, expected in cases:
            with self.subTest(fail["error"]):
                self.auth.invalidate()
                self.mock.token_fail = (400, fail)
                status, data, _ = self.call()
                self.assertEqual(status, 401)
                self.assertIn(expected, data["error"]["message"])

    def test_a_token_endpoint_that_is_down_is_a_503_not_a_crash(self):
        self.mock.stop()
        status, data, _info = self.call()
        self.assertEqual((status, data["error"]["status"]), (503, "UNAVAILABLE"))
        self.assertIn("Could not reach Google to sign in", data["error"]["message"])

    def test_an_unusable_private_key_is_reported(self):
        s = self.load({"GCP_SERVICE_ACCOUNT_JSON": json.dumps({**self.info, "private_key": "-----BEGIN PRIVATE KEY-----\nTESTKEYNOTREAL\n-----END PRIVATE KEY-----\n"}), "TERUCON_ALLOW_CUSTOM_GOOGLE_ENDPOINTS": "1", "TERUCON_VERTEX_API_BASE": self.mock.base})
        with self.assertRaises(GoogleAuthError) as caught:
            GoogleAuth(s.google).token()
        self.assertIn("private key", str(caught.exception))
        status, data, _ = vertex.generate_content(s, GoogleAuth(s.google), MODEL, BODY, sleep=self.sleeps.append)
        self.assertEqual(status, 500)  # the auth error carries its own status: 500, the key itself is broken
        self.assertIn("private key", data["error"]["message"])


class ApiKeyModeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = support.tempdir()
        self.addCleanup(self.tmp.cleanup)
        self.settings = load_settings(support.write_env(self.tmp.name), environ={"HOME": self.tmp.name, "GEMINI_API_KEY": "KEY-123"})
        self.mock = MockGoogle()
        self.mock.start()
        self.addCleanup(self.mock.stop)

    def test_api_key_goes_in_a_header_to_the_gemini_api_not_in_the_url(self):
        url, kind = vertex.endpoint(self.settings, MODEL, None)
        self.assertEqual(kind, "api-key")
        self.assertEqual(url, f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent")
        self.assertNotIn("KEY-123", url)

    def test_the_key_is_sent_as_x_goog_api_key_and_no_token_is_fetched(self):
        self.mock.expect_api_key = "KEY-123"
        mock_url = f"{self.mock.base}/v1beta/models/{MODEL}:generateContent"
        with mock.patch.object(vertex, "endpoint", return_value=(mock_url, "api-key")):  # the Gemini API host is hard-coded: aim it at the mock
            status, data, info = vertex.generate_content(self.settings, GoogleAuth(self.settings.google), MODEL, BODY, sleep=lambda s: None)
        self.assertEqual((status, info["attempts"]), (200, 1))
        self.assertEqual(data["candidates"][0]["content"]["parts"][0]["text"], "ok")
        headers = self.mock.generate_calls[0]["headers"]
        self.assertEqual(headers["x-goog-api-key"], "KEY-123")
        self.assertNotIn("authorization", headers)
        self.assertNotIn("KEY-123", self.mock.generate_calls[0]["path"])
        self.assertEqual(self.mock.token_calls, [])

    def test_a_rejected_api_key_is_googles_403_unchanged(self):
        self.mock.expect_api_key = "SOMETHING-ELSE"
        mock_url = f"{self.mock.base}/v1beta/models/{MODEL}:generateContent"
        with mock.patch.object(vertex, "endpoint", return_value=(mock_url, "api-key")):
            status, data, _ = vertex.generate_content(self.settings, GoogleAuth(self.settings.google), MODEL, BODY, sleep=lambda s: None)
        self.assertEqual((status, data["error"]["status"]), (403, "PERMISSION_DENIED"))

    def test_a_401_in_api_key_mode_is_final_there_is_no_token_to_refresh(self):
        mock_url = f"{self.mock.base}/v1beta/models/{MODEL}:generateContent"
        with mock.patch.object(vertex, "endpoint", return_value=(mock_url, "api-key")):
            # no expect_api_key is set, so the mock wants a Bearer token, finds none and answers 401 by itself
            status, _data, info = vertex.generate_content(self.settings, GoogleAuth(self.settings.google), MODEL, BODY, sleep=lambda s: None)
        self.assertEqual((status, info["attempts"]), (401, 1))
        self.assertEqual(len(self.mock.generate_calls), 1)
        self.assertEqual(self.mock.token_calls, [])


if __name__ == "__main__":
    unittest.main()
