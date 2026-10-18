"""The model service: surface detection and optional SAM behind a small JSON API, for the website to call.

    GET  /health        what is configured and how SAM is doing (no secrets)
    POST /segment       photo -> labelled surfaces (Gemini + SAM or edge snapping)   [the website's /api/segment]
    GET  /sam/health    the contract the Design Studio's SAM settings already speak  [/api/sam/health]
    POST /sam/refine    click/box -> mask (the Pick tool)                            [/api/sam/refine]
    POST /sam/segment   text concepts -> masks (only for backends that understand text, e.g. SAM 3)

It serves no pages and sets no CORS headers: the only client is the website's server, on the same machine.
"""
from __future__ import annotations

import base64
import hmac
import io
import json
import logging
import threading
import time
from pathlib import Path
from typing import Any

import numpy as np
from flask import Flask, Response, request
from PIL import Image, ImageOps
from werkzeug.exceptions import HTTPException, RequestEntityTooLarge

from . import __version__
from .config import Settings, SettingsManager
from .google_auth import GoogleAuth
from .segment.detect import DetectError
from .segment.pipeline import SegmentOptions, encode_labels, segment_image

log = logging.getLogger("terucon")

MODEL_KEY_HEADER = "X-Terucon-Model-Key"
MAX_BODY = 80 * 1024 * 1024
MAX_SIDE = 4096
LOCAL_HOSTS = {"localhost", "127.0.0.1", "[::1]", "::1"}
STATUS_NAMES = {
    400: "INVALID_ARGUMENT",
    401: "UNAUTHENTICATED",
    403: "PERMISSION_DENIED",
    404: "NOT_FOUND",
    405: "METHOD_NOT_ALLOWED",
    413: "PAYLOAD_TOO_LARGE",
    415: "UNSUPPORTED_MEDIA_TYPE",
    421: "MISDIRECTED_REQUEST",
}


def error_body(status: int, message: str, api_status: str = "INVALID_ARGUMENT") -> dict[str, Any]:
    return {"error": {"code": status, "status": api_status, "message": message}}


def json_response(data: Any, status: int = 200) -> Response:
    resp = Response(json.dumps(data, separators=(",", ":")), status=status, mimetype="application/json")
    resp.headers["Cache-Control"] = "no-store"
    return resp


def _err(status: int, message: str, api_status: str = "INVALID_ARGUMENT") -> Response:
    return json_response(error_body(status, message, api_status), status)


def _size(n: int) -> str:
    return f"{n // (1024 * 1024)} MB" if n >= 1024 * 1024 else f"{n} bytes"


def _same(sent: str, wanted: str) -> bool:
    """Constant-time comparison; an empty `wanted` (no key configured) never matches."""
    return bool(wanted) and hmac.compare_digest(sent.encode("utf-8"), wanted.encode("utf-8"))


def decode_image(b64: Any) -> np.ndarray:
    if not isinstance(b64, str) or not b64:
        raise ValueError("Send the photo as base64 in the 'image' field.")
    raw = b64.split(",", 1)[1] if b64.startswith("data:") else b64
    try:
        img = Image.open(io.BytesIO(base64.b64decode(raw)))
        img = ImageOps.exif_transpose(img).convert("RGB")
    except Exception as exc:  # noqa: BLE001
        raise ValueError("The image could not be decoded (use JPEG or PNG).") from exc
    if max(img.size) > MAX_SIDE:
        raise ValueError(f"The image is larger than {MAX_SIDE}px on its long side.")
    return np.array(img)


def create_app(
    env_path: str | Path | None = None,
    environ: dict[str, str] | None = None,
    sam_manager: Any = None,
) -> Flask:
    """`environ` (tests) replaces the process environment; the env file is still read. `sam_manager` replaces the real SAM."""
    app = Flask(__name__, static_folder=None)
    app.config["MAX_CONTENT_LENGTH"] = MAX_BODY
    app.json.sort_keys = False  # type: ignore[attr-defined]

    manager = SettingsManager(env_path, environ)
    state: dict[str, Any] = {"auth": None, "auth_version": -1}
    state_lock = threading.Lock()  # two first requests must not each build (and load) their own SAM

    def settings() -> Settings:
        return manager.get()

    def auth_for(s: Settings) -> GoogleAuth:
        with state_lock:
            if state["auth"] is None or state["auth_version"] != manager.version:
                state["auth"] = GoogleAuth(s.google)
                state["auth_version"] = manager.version
            return state["auth"]

    def sam():
        if sam_manager is not None:
            return sam_manager
        from .sam.manager import SamManager  # imported lazily: SAM is optional and heavy

        cfg = settings().sam
        with state_lock:
            if state.get("sam") is None or state.get("sam_cfg") != cfg:  # only rebuilt when the SAM settings change
                state["sam"] = SamManager(cfg)
                state["sam_cfg"] = cfg
            return state["sam"]

    app.extensions["terucon"] = {"settings": settings, "auth": auth_for, "sam": sam, "manager": manager}

    # ------------------------------------------------------------------ guards
    @app.before_request
    def guard():
        # These run before routing, so an unknown route is answered 421/401 first and tells a stranger nothing.
        s = settings()
        host = (request.host or "").lower()
        hostname = host.rsplit(":", 1)[0] if not host.startswith("[") else host.split("]")[0] + "]"
        if s.model_host not in ("0.0.0.0", "::"):  # bound to this machine only: refuse DNS-rebinding style hosts
            if hostname not in LOCAL_HOSTS and hostname not in s.allowed_hosts and host not in s.allowed_hosts:
                return _err(421, "Unexpected Host header.", STATUS_NAMES[421])
        is_sam = request.path == "/sam" or request.path.startswith("/sam/")
        if is_sam and s.sam.server_key:
            # The SAM routes also take SAM_SERVER_KEY (x-api-key or Bearer), because the SAM client in sam/backends.py can send
            # nothing else: that is how SAM_REMOTE_URL=http://gpu-box:8081/sam reaches this service when it runs on its own.
            sent_sam = (request.headers.get("x-api-key") or request.headers.get("Authorization", "").removeprefix("Bearer ")).strip()
            by_model_key = _same(request.headers.get(MODEL_KEY_HEADER, ""), s.service_key)
            by_sam_key = _same(sent_sam, s.sam.server_key)
            if not (by_model_key or by_sam_key):
                return _err(401, "This SAM server needs its key (SAM_SERVER_KEY, or MODEL_SERVICE_KEY in the " + MODEL_KEY_HEADER + " header).", "UNAUTHENTICATED")
        elif s.service_key and not _same(request.headers.get(MODEL_KEY_HEADER, ""), s.service_key):
            return _err(401, "This model service needs its key (MODEL_SERVICE_KEY, header " + MODEL_KEY_HEADER + ").", "UNAUTHENTICATED")
        if request.method in ("POST", "PUT", "PATCH", "DELETE"):
            ctype = (request.headers.get("Content-Type") or "").split(";")[0].strip().lower()
            if ctype != "application/json":
                return _err(415, "Send application/json.", STATUS_NAMES[415])
        limit = app.config.get("MAX_CONTENT_LENGTH")
        if limit and request.content_length is not None and request.content_length > limit:
            # Said up front, so a route that fails early (SAM off) does not answer before the body is looked at.
            resp = _err(413, f"The request body is larger than {_size(limit)}.", STATUS_NAMES[413])
            resp.headers["Connection"] = "close"  # the unread body must not be taken for the next request
            return resp
        return None

    @app.after_request
    def headers(resp: Response):
        resp.headers.setdefault("X-Content-Type-Options", "nosniff")
        return resp

    @app.errorhandler(HTTPException)
    def http_error(exc: HTTPException):
        status = exc.code or 500
        message = {
            404: "No such route.",
            405: "That method is not allowed on this route.",
            413: f"The request body is larger than {_size(app.config['MAX_CONTENT_LENGTH'])}.",
        }.get(status) or exc.description or "Request failed."
        resp = _err(status, message, STATUS_NAMES.get(status, "INVALID_ARGUMENT" if status < 500 else "INTERNAL"))
        if status == 405 and getattr(exc, "valid_methods", None):
            resp.headers["Allow"] = ", ".join(exc.valid_methods)  # type: ignore[attr-defined]
        if status == 413:
            resp.headers["Connection"] = "close"
        return resp

    @app.errorhandler(Exception)
    def unexpected(exc: Exception):
        log.exception("%s %s failed", request.method, request.path)
        return _err(500, "The model service hit an unexpected error. Its terminal has the details.", "INTERNAL")

    # ------------------------------------------------------------------ routes
    def json_body() -> dict[str, Any]:
        raw = request.get_data()  # a Content-Length over the limit is refused here, as 413
        limit = app.config.get("MAX_CONTENT_LENGTH")
        if limit and request.content_length is None and len(raw) >= limit:
            # a chunked body has no length to check up front, and werkzeug stops reading at the limit without a word:
            # a body this long was cut off, and a cut-off photo must not be mistaken for a bad one
            raise RequestEntityTooLarge()
        data = request.get_json(silent=True)
        return data if isinstance(data, dict) else {}

    @app.get("/health")
    def health():
        s = settings()
        try:
            sam_status = sam().status()
        except Exception as exc:  # noqa: BLE001 - /health must never fail because SAM did
            sam_status = {"enabled": True, "status": "error", "error": str(exc)[:200], "backend": "", "model": "", "interactive": False, "textPrompts": False}
        return json_response(
            {
                "ok": True,
                "service": "terucon-model",
                "version": __version__,
                "google": {"configured": s.google.configured, "mode": s.google.mode, "error": s.google.error},
                "sam": sam_status,
                "segmentation": {
                    "engine": s.segmentation_engine,
                    "edgeRefine": s.edge_refine,
                    "edgeMethod": s.edge_method,
                    "analysisMaxSide": s.analysis_max_side,
                },
            }
        )

    @app.post("/segment")
    def segment():
        s = settings()
        body = json_body()
        if not s.google.configured:
            return _err(503, s.google.error or "Google Cloud is not configured on this server. Add credentials to .env.", "FAILED_PRECONDITION")
        try:
            rgb = decode_image(body.get("image"))
        except ValueError as exc:
            return _err(400, str(exc))
        o = body.get("options") if isinstance(body.get("options"), dict) else {}
        opts = SegmentOptions(
            use_sam=o.get("useSam", True) is not False,
            edge_refine=o.get("edgeRefine", s.edge_refine) is not False,
            edge_method=s.edge_method,
            model=o.get("model") if isinstance(o.get("model"), str) else None,
            location=o.get("location") if isinstance(o.get("location"), str) else None,
            hint=str(o.get("hint", ""))[:300],
        )
        t0 = time.perf_counter()
        try:
            result = segment_image(s, auth_for(s), sam(), rgb, opts)
        except DetectError as exc:
            log.warning("segment %dx%d  failed %s: %s", rgb.shape[1], rgb.shape[0], exc.status, str(exc)[:200])
            return _err(exc.status, str(exc), exc.api_status)
        except ValueError as exc:
            log.warning("segment %dx%d  failed 422: %s", rgb.shape[1], rgb.shape[0], str(exc)[:200])
            return _err(422, str(exc), "FAILED_PRECONDITION")
        log.info("segment %dx%d  ok    %.1fs  %s, %d surfaces, %s%s", result.width, result.height, time.perf_counter() - t0, result.engine, len(result.metas), result.scene or "scene unknown", "".join(f"; {n}" for n in result.notes))
        return json_response(
            {
                "ok": True,
                "width": result.width,
                "height": result.height,
                "labelMap": encode_labels(result.labels),
                "metas": result.metas,
                "scene": result.scene,
                "engine": result.engine,
                "model": result.model,
                "notes": result.notes,
                "hints": result.hints,
                "timings": result.timings,
                "sam": {"used": result.sam_used, "imageId": result.sam_image_id},
            }
        )

    # ------------------------------------------------------------ SAM contract
    @app.get("/sam/health")
    def sam_health():
        st = sam().status()
        status = {"ready": "ok"}.get(st["status"], st["status"])
        return json_response(
            {
                "status": status,
                "model": st["model"],
                "backend": st["backend"],
                "device": st["device"],
                "interactive": st["interactive"],
                "text_prompts": st["textPrompts"],
                "error": st["error"],
            }
        )

    def ready_or_error():
        manager_ = sam()
        if manager_.ready:
            return manager_, None
        st = manager_.status()
        if st["status"] == "off":
            return None, _err(503, "SAM is switched off. Set SAM_ENABLED=true in .env and restart.", "FAILED_PRECONDITION")
        if st["status"] == "error":
            return None, _err(503, f"SAM could not start: {st['error']}", "FAILED_PRECONDITION")
        return None, _err(503, "SAM is still loading. Try again in a moment.", "UNAVAILABLE")

    @app.post("/sam/refine")
    def sam_refine_route():
        from .sam.backends import encode_png_mask

        sam_, err = ready_or_error()
        if err is not None:
            return err
        body = json_body()
        handle, image_id = None, str(body.get("image_id") or "")
        if image_id:
            handle = sam_.handle_for(image_id)
        if handle is None:
            if not body.get("image"):
                return _err(409, "That photo is no longer cached. Send the image again.", "FAILED_PRECONDITION")
            try:
                rgb = decode_image(body["image"])
            except ValueError as exc:
                return _err(400, str(exc))
            image_id, handle = sam_.embed_cached(rgb)
        box = body.get("box") if isinstance(body.get("box"), list) and len(body["box"]) == 4 else None
        try:
            points = [(float(p[0]), float(p[1])) for p in body.get("points", []) if isinstance(p, (list, tuple)) and len(p) >= 2]
            labels = [int(v) for v in body.get("labels", [])][: len(points)] or [1] * len(points)
            if box is not None:
                list(map(float, box))  # only checks that the four are numbers; SAM still gets the list as sent
        except (TypeError, ValueError):
            return _err(400, "points must be [[x, y], ...], labels a list of 0 or 1, and box [x0, y0, x1, y1].")
        if not points and box is None:
            return _err(400, "Send at least one point or a box.")
        cands = sam_.run(lambda b: b.predict(handle, box=box, points=points or None, labels=labels or None, multimask=len(points) < 2 and box is None))
        if not cands:
            return _err(422, "SAM found nothing at that point.", "FAILED_PRECONDITION")
        best = max(cands, key=lambda c: c.score)
        return json_response({"mask": encode_png_mask(best.mask), "image_id": image_id, "score": round(best.score, 4), "model": sam_.label})

    @app.post("/sam/segment")
    def sam_segment_route():
        from .sam.backends import encode_png_mask

        sam_, err = ready_or_error()
        if err is not None:
            return err
        if not sam_.status()["textPrompts"]:
            return _err(501, f"{sam_.label} takes boxes and points, not text. Use the Terucon engine (Gemini finds the surfaces, SAM sharpens them) or a text-capable backend such as SAM 3.", "UNIMPLEMENTED")
        body = json_body()
        try:
            rgb = decode_image(body.get("image"))
        except ValueError as exc:
            return _err(400, str(exc))
        try:
            prompts = [str(p).strip() for p in body.get("prompts", []) if str(p).strip()][:40]
            threshold = float(body.get("confidence_threshold") or 0.4)
            per = max(1, min(20, int(body.get("max_per_prompt") or 8)))
        except (TypeError, ValueError):
            return _err(400, "prompts must be a list of strings, confidence_threshold a number and max_per_prompt a whole number.")
        if not prompts:
            return _err(400, "Send a list of prompts.")
        image_id, handle = sam_.embed_cached(rgb)
        found = sam_.run(lambda b: b.segment_text(handle, prompts, threshold, per))
        return json_response(
            {
                "detections": [{"prompt": d["prompt"], "mask": encode_png_mask(d["mask"]), "score": round(d["score"], 4)} for d in found],
                "image_id": image_id,
                "model": sam_.label,
            }
        )

    if sam_manager is None and settings().sam.enabled:
        sam()  # start loading the model now, in the background, so the first scan does not wait for it
    return app
