"""generateContent proxy: the Design Studio's one path to Gemini and Nano Banana.

The browser sends {model, location, body}; we add credentials and forward to Vertex AI (service
account) or the Gemini API (AI Studio key). Google's status code and JSON error come back
unchanged, because the studio's error messages and its 404 model-fallback chain are built on them.
"""
from __future__ import annotations

import json
import random
import re
import time
from typing import Any

import requests

from .config import Settings
from .google_auth import GoogleAuth, GoogleAuthError

_MODEL = re.compile(r"^[A-Za-z0-9._\-]{3,80}$")
_LOCATION = re.compile(r"^[a-z0-9\-]{2,40}$")
RETRY_STATUS = {429, 500, 502, 503, 504}
MAX_ATTEMPTS = 4
CONNECT_TIMEOUT = 10
READ_TIMEOUT = 240  # image generation can take a while
MAX_TOTAL_SECONDS = 330  # whatever happens, a call never keeps the user waiting longer than this


class VertexRequestError(Exception):
    def __init__(self, status: int, message: str, api_status: str = "INVALID_ARGUMENT"):
        super().__init__(message)
        self.status = status
        self.body = {"error": {"code": status, "status": api_status, "message": message}}


def endpoint(settings: Settings, model: str, location: str | None) -> tuple[str, str]:
    """(url, auth_kind) for generateContent on the configured backend."""
    if not _MODEL.match(model or ""):
        raise VertexRequestError(400, f"Invalid model name: {model!r}")
    g = settings.google
    if g.mode == "api-key":
        return f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent", "api-key"
    if g.mode != "vertex":
        raise VertexRequestError(503, "Google Cloud is not configured on this server. Add credentials to .env.", "FAILED_PRECONDITION")
    loc = (location or g.location or "global").strip()
    if not _LOCATION.match(loc):
        raise VertexRequestError(400, f"Invalid location: {loc!r}")
    base = settings.vertex_api_base or ("https://aiplatform.googleapis.com" if loc == "global" else f"https://{loc}-aiplatform.googleapis.com")
    return f"{base}/v1/projects/{g.project_id}/locations/{loc}/publishers/google/models/{model}:generateContent", "bearer"


def _retry_after(response: requests.Response) -> float | None:
    value = response.headers.get("Retry-After")
    try:
        return min(20.0, float(value)) if value is not None else None
    except ValueError:
        return None


def generate_content(
    settings: Settings,
    auth: GoogleAuth,
    model: str,
    body: dict[str, Any],
    location: str | None = None,
    sleep=None,
    clock=None,
) -> tuple[int, dict[str, Any], dict[str, Any]]:
    """Call generateContent. Returns (http_status, json_body, info) and never raises for upstream errors.

    `info` carries what the caller may want to show: attempts made, and the model used.
    """
    try:
        url, kind = endpoint(settings, model, location)
    except VertexRequestError as exc:
        return exc.status, exc.body, {"attempts": 0, "model": model}

    payload = json.dumps(body, separators=(",", ":")).encode("utf-8")
    sleep = sleep or time.sleep  # looked up now, not at import, so tests (and callers) can swap them
    clock = clock or time.monotonic
    deadline = clock() + MAX_TOTAL_SECONDS
    attempts = 0
    last: tuple[int, dict[str, Any]] = (502, {"error": {"code": 502, "status": "UNAVAILABLE", "message": "No response from Google."}})
    refreshed = False
    while attempts < MAX_ATTEMPTS and (attempts == 0 or clock() < deadline):
        attempts += 1
        headers = {"Content-Type": "application/json"}
        try:
            if kind == "bearer":
                headers["Authorization"] = "Bearer " + auth.token()
            else:
                headers["x-goog-api-key"] = settings.google.api_key
        except GoogleAuthError as exc:
            code = exc.status if exc.status in (401, 403, 429, 500, 503) else 401
            return code, {"error": {"code": code, "status": "UNAUTHENTICATED" if code == 401 else "UNAVAILABLE", "message": str(exc)}}, {"attempts": attempts, "model": model}
        try:
            r = requests.post(url, data=payload, headers=headers, timeout=(CONNECT_TIMEOUT, READ_TIMEOUT))
        except requests.ReadTimeout:
            # Google accepted the request but never answered: asking again would only make the user wait
            # several times as long for the same silence.
            return 504, {"error": {"code": 504, "status": "DEADLINE_EXCEEDED", "message": f"{model} did not answer within {int(READ_TIMEOUT)} seconds."}}, {"attempts": attempts, "model": model}
        except requests.Timeout:  # could not even connect: worth another try
            last = (504, {"error": {"code": 504, "status": "DEADLINE_EXCEEDED", "message": "Could not connect to Google in time."}})
        except requests.RequestException:
            last = (503, {"error": {"code": 503, "status": "UNAVAILABLE", "message": "Could not reach Google. Check this computer's internet connection."}})
        else:
            try:
                data = r.json()
            except ValueError:
                data = {"error": {"code": r.status_code, "status": "UNKNOWN", "message": (r.text or "")[:300]}}
            if r.status_code == 401 and kind == "bearer" and not refreshed:
                auth.invalidate()  # token revoked or expired early: get a fresh one once
                refreshed = True
                attempts -= 1
                continue
            if r.status_code not in RETRY_STATUS:
                return r.status_code, data, {"attempts": attempts, "model": model}
            last = (r.status_code, data)
            wait = _retry_after(r)
            if attempts < MAX_ATTEMPTS:
                sleep(wait if wait is not None else (2 ** (attempts - 1)) * random.uniform(0.8, 1.2))
            continue
        if attempts < MAX_ATTEMPTS:
            sleep((2 ** (attempts - 1)) * random.uniform(0.8, 1.2))
    return last[0], last[1], {"attempts": attempts, "model": model}
