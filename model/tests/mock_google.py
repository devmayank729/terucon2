"""A local stand-in for Google's OAuth token endpoint and Vertex AI generateContent.

Used by the model service's tests and, as its own process, by mock_google_server.py (which the website's
end-to-end tests start) so the whole Design Studio can be exercised without real credentials. The token endpoint
really verifies the RS256 signature of the JWT it is given, so a pass here means our signing is correct.
Responses for generateContent come from a queue you script per model, or from `default_handler`; an entry is
(status, body) or (status, body, headers), for example to send a Retry-After.
"""
from __future__ import annotations

import base64
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa


def b64url_decode(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def make_service_account(token_uri: str, project_id: str = "terucon-test-project", email: str | None = None) -> tuple[dict[str, Any], Any]:
    """A throw-away service-account key (and its public key) for tests."""
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    pem = key.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
    ).decode()
    info = {
        "type": "service_account",
        "project_id": project_id,
        "private_key_id": "testkeyid0123456789",
        "private_key": pem,
        "client_email": email or f"swatchroom@{project_id}.iam.gserviceaccount.com",
        "client_id": "1234567890",
        "token_uri": token_uri,
    }
    return info, key.public_key()


class MockGoogle:
    def __init__(self, public_key: Any = None):
        self.public_key = public_key
        self.token_calls: list[dict[str, Any]] = []
        self.generate_calls: list[dict[str, Any]] = []
        self.script: dict[str, list[tuple[Any, ...]]] = {}
        self.default_handler: Callable[[str, dict[str, Any], dict[str, str]], tuple[Any, ...]] | None = None
        self.token_fail: tuple[int, dict[str, Any]] | None = None
        self.expect_api_key: str | None = None
        self._server: ThreadingHTTPServer | None = None
        self._thread: threading.Thread | None = None
        self._tokens = 0

    # ---- lifecycle ---------------------------------------------------------
    def start(self, port: int = 0) -> str:
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *a, **k):  # silence
                return

            def _send(self, status: int, data: Any, headers: dict[str, str] | None = None):
                raw = json.dumps(data).encode()
                try:
                    self.send_response(status)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(raw)))
                    for k, v in (headers or {}).items():
                        self.send_header(k, v)
                    self.end_headers()
                    self.wfile.write(raw)
                except (BrokenPipeError, ConnectionResetError):  # the client gave up (a timeout test) before the answer
                    pass

            def do_GET(self):  # noqa: N802
                if self.path == "/__calls":
                    return self._send(200, {"generate": [{"model": c["model"], "path": c["path"], "summary": c.get("summary", "")} for c in outer.generate_calls], "tokens": len(outer.token_calls)})
                self._send(404, {"error": "not found"})

            def do_POST(self):  # noqa: N802
                length = int(self.headers.get("Content-Length") or 0)
                body = self.rfile.read(length)
                if self.path == "/token":
                    return outer._token(self, body)
                return outer._generate(self, body)

        self._server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
        self._thread = threading.Thread(target=lambda: self._server.serve_forever(poll_interval=0.05), daemon=True)  # short poll: stop() returns quickly
        self._thread.start()
        return self.base

    @property
    def base(self) -> str:
        assert self._server is not None
        return f"http://127.0.0.1:{self._server.server_address[1]}"

    @property
    def token_url(self) -> str:
        return self.base + "/token"

    def stop(self) -> None:
        if self._server:
            self._server.shutdown()
            self._server.server_close()

    # ---- endpoints ---------------------------------------------------------
    def _token(self, h: BaseHTTPRequestHandler, raw: bytes) -> None:
        from urllib.parse import parse_qs

        form = {k: v[0] for k, v in parse_qs(raw.decode()).items()}
        record: dict[str, Any] = {"grant_type": form.get("grant_type")}
        if self.token_fail:
            status, data = self.token_fail
            return h._send(status, data)  # type: ignore[attr-defined]
        assertion = form.get("assertion", "")
        try:
            head_b64, payload_b64, sig_b64 = assertion.split(".")
            header = json.loads(b64url_decode(head_b64))
            payload = json.loads(b64url_decode(payload_b64))
            record.update(header=header, payload=payload)
            if self.public_key is not None:
                self.public_key.verify(b64url_decode(sig_b64), f"{head_b64}.{payload_b64}".encode(), padding.PKCS1v15(), hashes.SHA256())
            record["signature_ok"] = True
        except Exception as exc:  # noqa: BLE001
            record["signature_ok"] = False
            self.token_calls.append(record)
            return h._send(400, {"error": "invalid_grant", "error_description": f"Invalid JWT Signature. ({exc})"})  # type: ignore[attr-defined]
        self.token_calls.append(record)
        self._tokens += 1
        h._send(200, {"access_token": f"mock-token-{self._tokens}", "expires_in": 3600, "token_type": "Bearer"})  # type: ignore[attr-defined]

    def _generate(self, h: BaseHTTPRequestHandler, raw: bytes) -> None:
        path = h.path
        model = path.split("/models/")[-1].split(":")[0] if "/models/" in path else ""
        try:
            body = json.loads(raw or b"{}")
        except ValueError:
            body = {}
        headers = {k.lower(): v for k, v in h.headers.items()}
        self.generate_calls.append({"path": path, "model": model, "headers": headers, "body": body})
        if self.expect_api_key is not None:
            if headers.get("x-goog-api-key") != self.expect_api_key:
                return h._send(403, {"error": {"code": 403, "status": "PERMISSION_DENIED", "message": "API key not valid."}})  # type: ignore[attr-defined]
        elif not headers.get("authorization", "").startswith("Bearer mock-token-"):
            return h._send(401, {"error": {"code": 401, "status": "UNAUTHENTICATED", "message": "Missing or invalid token."}})  # type: ignore[attr-defined]
        queue = self.script.get(model)
        if queue:
            status, data, *extra = queue.pop(0)
            return h._send(status, data, extra[0] if extra else None)  # type: ignore[attr-defined]
        if self.default_handler:
            status, data, *extra = self.default_handler(model, body, headers)
            return h._send(status, data, extra[0] if extra else None)  # type: ignore[attr-defined]
        h._send(200, text_response("ok"))  # type: ignore[attr-defined]


def text_response(text: str) -> dict[str, Any]:
    return {"candidates": [{"content": {"role": "model", "parts": [{"text": text}]}, "finishReason": "STOP"}]}


def image_response(png_bytes: bytes, text: str = "") -> dict[str, Any]:
    parts: list[dict[str, Any]] = []
    if text:
        parts.append({"text": text})
    parts.append({"inlineData": {"mimeType": "image/png", "data": base64.b64encode(png_bytes).decode()}})
    return {"candidates": [{"content": {"role": "model", "parts": parts}, "finishReason": "STOP"}]}
