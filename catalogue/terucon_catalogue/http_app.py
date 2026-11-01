"""The two FastAPI apps behind the Modal web endpoints: exactly the HTTP contract of ARCHITECTURE.md section 6.

    create_search_app(service, api_keys)   GET /healthz   POST /v1/search (raw image bytes)   POST /v1/search-text (JSON)
    create_ingest_app(runner, api_keys)    GET /healthz   POST /v1/ingest {jobId}             POST /v1/ingest/cancel {jobId}

* Every request, to any path, needs `Authorization: Bearer <key>` (several keys are accepted so one can be rotated). The keys are kept as sha256
  digests and compared with hmac.compare_digest over all of them (no early exit); a 401 never says whether the header was missing, malformed or wrong.
  Authentication happens in a pure-ASGI middleware BEFORE routing, so an unauthenticated client can never make the server buffer an upload.
* The photo body is read with request.stream() under a hard byte cap: 413 as soon as the declared Content-Length or the bytes received exceed it.
* Errors are always {"error": {"code": <http>, "status": "INVALID_ARGUMENT"|..., "message": "...", "reason": "<slug>"}}; 429 / 503 carry Retry-After.
* Validation is strict: unknown or repeated query parameters, unknown JSON keys, bad slugs, out-of-range numbers are 400 `bad-request`.

`proxy_auth_required` (NEW, off in modal_app.py): when True the app also insists that the `Modal-Key` and `Modal-Secret` headers are PRESENT. It cannot
verify them (Modal's edge does, when the web endpoint is declared with requires_proxy_auth=True); whether Modal forwards those headers to the container
has not been verified, so modal_app.py leaves this off.

Importing this module needs fastapi but not torch; nothing runs at import.
"""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import inspect
import json
import logging
import math
import re
from typing import Any, Dict, Iterable, List, Optional

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from . import __version__
from .config import SEARCH_PROFILES
from .release_reader import BadRequestError, ServiceError, is_catalogue_id, is_job_id, is_release_id
from .search import MAX_TOP_K, MODES, RegionSpec
from .service import MAX_TEXT_CHARS, normalise_filter

LOGGER = logging.getLogger("catalogue.http")

DEFAULT_MAX_BODY_BYTES = 8 * 1024 * 1024
MAX_JSON_BYTES = 16 * 1024
ALLOWED_IMAGE_TYPES = ("image/jpeg", "image/png", "image/webp")
STATUS_NAMES = {400: "INVALID_ARGUMENT", 401: "UNAUTHENTICATED", 403: "PERMISSION_DENIED", 404: "NOT_FOUND", 405: "INVALID_ARGUMENT",
                409: "FAILED_PRECONDITION", 413: "INVALID_ARGUMENT", 415: "INVALID_ARGUMENT", 429: "RESOURCE_EXHAUSTED", 500: "INTERNAL",
                503: "UNAVAILABLE"}
_MAX_TOKEN_CHARS = 512
_MAX_QUERY_VALUE = 400
_SEARCH_QUERY = {"catalogue", "release", "mode", "profile", "k", "point", "radius", "box", "category", "finish"}
_TEXT_KEYS = {"catalogue", "release", "text", "k", "category", "finish"}
_DECIMAL = re.compile(r"[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)")
_WHOLE = re.compile(r"[0-9]{1,3}")


class PayloadTooLargeError(ServiceError):
    status = 413
    reason = "too-large"


class UnsupportedMediaTypeError(ServiceError):
    status = 415
    reason = "unsupported-media-type"


class UnauthorizedError(ServiceError):
    status = 401
    reason = "unauthorized"


def error_payload(status: int, reason: str, message: str) -> dict:
    return {"error": {"code": status, "status": STATUS_NAMES.get(status, "UNKNOWN"), "message": message, "reason": reason}}


def error_response(status: int, reason: str, message: str, retry_after: Optional[float] = None) -> JSONResponse:
    headers = {"Cache-Control": "no-store"}
    if retry_after is not None or status in (429, 503):
        headers["Retry-After"] = str(max(1, math.ceil(retry_after if retry_after is not None else 2)))
    if status == 401:
        headers["WWW-Authenticate"] = "Bearer"
    return JSONResponse(error_payload(status, reason, message), status_code=status, headers=headers)


def key_digests(api_keys: Any) -> List[bytes]:
    if isinstance(api_keys, str):
        keys = [key.strip() for key in api_keys.split(",") if key.strip()]
    else:
        keys = [str(key).strip() for key in (api_keys or []) if str(key).strip()]
    if not keys:
        raise ValueError("At least one API key is required; refusing to start unauthenticated.")
    if any(len(key) < 16 for key in keys):
        raise ValueError("Every API key must be at least 16 characters.")
    return [hashlib.sha256(key.encode("utf-8")).digest() for key in keys]


class _GuardMiddleware:
    """Pure ASGI. Bearer authentication for every http request, before routing and before any body is read."""

    def __init__(self, app, digests: List[bytes], proxy_auth_required: bool = False):
        self.app = app
        self.digests = digests
        self.proxy_auth_required = proxy_auth_required

    def _authorized(self, headers: Dict[str, str]) -> bool:
        authorization = headers.get("authorization", "")
        token = authorization[7:].strip() if authorization[:7].lower() == "bearer " else ""
        ok = bool(token) and len(token) <= _MAX_TOKEN_CHARS
        digest = hashlib.sha256(token.encode("utf-8", "replace")).digest()
        matched = False
        for known in self.digests:                       # no early exit: the time taken does not depend on which key (if any) matched
            matched |= hmac.compare_digest(digest, known)
        if self.proxy_auth_required:
            ok = ok and bool(headers.get("modal-key")) and bool(headers.get("modal-secret"))
        return ok and matched

    async def __call__(self, scope, receive, send):
        if scope["type"] == "lifespan":
            return await self.app(scope, receive, send)
        if scope["type"] != "http":
            if scope["type"] == "websocket":
                await send({"type": "websocket.close", "code": 1008})
            return
        headers = {key.decode("latin-1").lower(): value.decode("latin-1") for key, value in scope.get("headers", [])}
        if not self._authorized(headers):
            response = error_response(401, "unauthorized", "Missing or invalid credentials.")
            return await response(scope, receive, send)
        await self.app(scope, receive, send)


# ------------------------------------------------------------------------------------------------------------------------
# request parsing
# ------------------------------------------------------------------------------------------------------------------------
def _decimal(text: str, name: str) -> float:
    text = text.strip()
    if len(text) > 24 or _DECIMAL.fullmatch(text) is None:
        raise BadRequestError(f"{name} must be a plain decimal number.")
    return float(text)


def _numbers(text: str, count: int, name: str) -> List[float]:
    parts = text.split(",")
    if len(parts) != count:
        raise BadRequestError(f"{name} must be {count} comma-separated numbers.")
    return [_decimal(part, name) for part in parts]


def parse_search_query(request: Request) -> dict:
    """Query string of POST /v1/search -> the keyword arguments of SearchService.search_photo. Strict: anything unexpected is a 400."""
    seen: Dict[str, str] = {}
    for key, value in request.query_params.multi_items():
        if key not in _SEARCH_QUERY:
            raise BadRequestError("Unknown query parameter.")
        if key in seen:
            raise BadRequestError(f"Query parameter '{key}' was sent twice.")
        if len(value) > _MAX_QUERY_VALUE:
            raise BadRequestError(f"Query parameter '{key}' is too long.")
        seen[key] = value
    catalogue, release = seen.get("catalogue"), seen.get("release")
    if not is_catalogue_id(catalogue):
        raise BadRequestError("catalogue is missing or not a valid catalogue id.")
    if not is_release_id(release):
        raise BadRequestError("release is missing or not a valid release id.")
    mode = seen.get("mode", "look")
    if mode not in MODES:
        raise BadRequestError(f"mode must be one of {', '.join(MODES)}.")
    profile = seen.get("profile")
    if profile is not None and profile not in SEARCH_PROFILES:
        raise BadRequestError(f"profile must be one of {', '.join(SEARCH_PROFILES)}.")
    k = None
    if "k" in seen:
        if _WHOLE.fullmatch(seen["k"]) is None or not 1 <= int(seen["k"]) <= MAX_TOP_K:
            raise BadRequestError(f"k must be a whole number from 1 to {MAX_TOP_K}.")
        k = int(seen["k"])
    point = _numbers(seen["point"], 2, "point") if "point" in seen else None
    box = _numbers(seen["box"], 4, "box") if "box" in seen else None
    radius = _decimal(seen["radius"], "radius") if "radius" in seen else None
    region = RegionSpec.from_params(point, radius, box)
    category = seen.get("category")
    finish = seen.get("finish")
    normalise_filter(category, "category")                         # 400 now, not after the body has been read
    normalise_filter(finish, "finish")
    return {"catalogue": catalogue, "release": release, "mode": mode, "profile": profile, "k": k, "region": region,
            "category": category, "finish": finish}


def _content_type(request: Request) -> str:
    return request.headers.get("content-type", "").split(";")[0].strip().lower()


async def read_capped_body(request: Request, limit: int) -> bytes:
    """The request body, or 413 the moment it is known to exceed `limit` bytes (Content-Length first, then while streaming)."""
    declared = request.headers.get("content-length")
    if declared is not None:
        if _WHOLE_LONG.fullmatch(declared.strip()) is None:
            raise BadRequestError("Content-Length is not valid.")
        if int(declared) > limit:
            raise PayloadTooLargeError(f"The request body is larger than {limit} bytes.")
    chunks: List[bytes] = []
    total = 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > limit:
            raise PayloadTooLargeError(f"The request body is larger than {limit} bytes.")
        chunks.append(chunk)
    return b"".join(chunks)


_WHOLE_LONG = re.compile(r"[0-9]{1,15}")


async def read_json_object(request: Request, allowed_keys: Iterable[str]) -> dict:
    if _content_type(request) != "application/json":
        raise UnsupportedMediaTypeError("The body must be application/json.")
    raw = await read_capped_body(request, MAX_JSON_BYTES)
    try:
        body = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        raise BadRequestError("The body is not valid JSON.") from None
    if not isinstance(body, dict):
        raise BadRequestError("The body must be a JSON object.")
    unknown = set(body) - set(allowed_keys)
    if unknown:
        raise BadRequestError("The body has keys this endpoint does not accept.")
    return body


def parse_text_body(body: dict) -> dict:
    catalogue, release = body.get("catalogue"), body.get("release")
    if not is_catalogue_id(catalogue):
        raise BadRequestError("catalogue is missing or not a valid catalogue id.")
    if not is_release_id(release):
        raise BadRequestError("release is missing or not a valid release id.")
    text = body.get("text")
    if not isinstance(text, str) or not text.strip():
        raise BadRequestError("text is required.")
    if len(text) > MAX_TEXT_CHARS * 4:                              # the service collapses whitespace and enforces the real limit
        raise BadRequestError(f"text must be at most {MAX_TEXT_CHARS} characters.")
    k = body.get("k")
    if k is not None and (isinstance(k, bool) or not isinstance(k, int) or not 1 <= k <= MAX_TOP_K):
        raise BadRequestError(f"k must be a whole number from 1 to {MAX_TOP_K}.")
    for name in ("category", "finish"):
        normalise_filter(body.get(name), name)
    return {"catalogue": catalogue, "release": release, "text": text, "k": k, "category": body.get("category"), "finish": body.get("finish")}


async def _guarded(awaitable, what: str):
    """Await a service call; anything that is not a deliberate ServiceError becomes a logged 500 with a generic message."""
    try:
        return await awaitable
    except ServiceError:
        raise
    except Exception as exc:
        LOGGER.exception("unhandled error in %s (%s)", what, type(exc).__name__)
        raise ServiceError("The request failed.", status=500, reason="internal") from None


def _install(api: FastAPI) -> None:
    @api.exception_handler(ServiceError)
    async def _service_error(request, exc: ServiceError):
        status = exc.status if isinstance(exc.status, int) and 400 <= exc.status <= 599 else 500
        return error_response(status, exc.reason, exc.message or "The request failed.", exc.retry_after)

    @api.exception_handler(StarletteHTTPException)
    async def _http_error(request, exc: StarletteHTTPException):
        reason = {404: "not-found", 405: "method-not-allowed"}.get(exc.status_code, "bad-request")
        return error_response(exc.status_code, reason, "No such endpoint." if exc.status_code == 404 else "Method not allowed.")

    @api.exception_handler(Exception)
    async def _unhandled(request, exc: Exception):             # last resort; routes already convert their own failures
        LOGGER.exception("unhandled error (%s)", type(exc).__name__)
        return error_response(500, "internal", "The request failed.")


def _new_app(title: str, digests: List[bytes], proxy_auth_required: bool) -> FastAPI:
    api = FastAPI(title=title, docs_url=None, redoc_url=None, openapi_url=None)
    _install(api)
    api.add_middleware(_GuardMiddleware, digests=digests, proxy_auth_required=proxy_auth_required)
    return api


def _ok(payload: dict, status: int = 200) -> JSONResponse:
    return JSONResponse(payload, status_code=status, headers={"Cache-Control": "no-store"})


# ------------------------------------------------------------------------------------------------------------------------
# the search app
# ------------------------------------------------------------------------------------------------------------------------
def create_search_app(service, api_keys, *, max_body_bytes: int = DEFAULT_MAX_BODY_BYTES, proxy_auth_required: bool = False) -> FastAPI:
    api = _new_app("terucon-catalogue-search", key_digests(api_keys), proxy_auth_required)

    @api.get("/healthz")
    async def healthz():
        return _ok(service.healthz())

    @api.post("/v1/search")
    async def search(request: Request):
        params = parse_search_query(request)
        if _content_type(request) not in ALLOWED_IMAGE_TYPES:
            raise UnsupportedMediaTypeError("The body must be an image: image/jpeg, image/png or image/webp.")
        image = await read_capped_body(request, max_body_bytes)
        if not image:
            raise BadRequestError("The body is empty; send the photo bytes.")
        return _ok(await _guarded(service.search_photo(image, **params), "search"))

    @api.post("/v1/search-text")
    async def search_text(request: Request):
        params = parse_text_body(await read_json_object(request, _TEXT_KEYS))
        return _ok(await _guarded(service.search_text(params.pop("text"), **params), "search-text"))

    return api


# ------------------------------------------------------------------------------------------------------------------------
# the ingest app
# ------------------------------------------------------------------------------------------------------------------------
async def _maybe_thread(function, *args):
    if inspect.iscoroutinefunction(function):
        return await function(*args)
    return await asyncio.to_thread(function, *args)


def create_ingest_app(runner, api_keys, *, proxy_auth_required: bool = False) -> FastAPI:
    """`runner` has start(job_id) -> call id and cancel(job_id) (sync or async), and optionally .version."""
    api = _new_app("terucon-catalogue-ingest", key_digests(api_keys), proxy_auth_required)

    async def job_id_of(request: Request) -> str:
        body = await read_json_object(request, {"jobId"})
        if not is_job_id(body.get("jobId")):
            raise BadRequestError("jobId is missing or not a valid job id.")
        return body["jobId"]

    @api.get("/healthz")
    async def healthz():
        return _ok({"ok": True, "version": str(getattr(runner, "version", None) or __version__)})

    @api.post("/v1/ingest")
    async def ingest(request: Request):
        job_id = await job_id_of(request)
        call_id = await _guarded(_maybe_thread(runner.start, job_id), "ingest")
        return _ok({"ok": True, "callId": call_id}, status=202)

    @api.post("/v1/ingest/cancel")
    async def cancel(request: Request):
        job_id = await job_id_of(request)
        await _guarded(_maybe_thread(runner.cancel, job_id), "ingest-cancel")
        return _ok({"ok": True})

    return api
