"""SAM lifecycle: choose a backend, load it without blocking the server, serialise inference, cache embeddings."""
from __future__ import annotations

import hashlib
import threading
import time
from collections import OrderedDict
from typing import Any, Callable

import numpy as np

from ..config import SamConfig


class SamManager:
    def __init__(self, cfg: SamConfig, backend_factory: Callable[[SamConfig], Any] | None = None):
        self.cfg = cfg
        self._factory = backend_factory or self._default_factory
        self._backend: Any = None
        self._status = "off" if not cfg.enabled else "idle"
        self._error = ""
        self._load_seconds = 0.0
        self._lock = threading.Lock()  # one inference at a time (CPU and GPU both)
        self._load_lock = threading.Lock()
        self._handles: OrderedDict[str, Any] = OrderedDict()
        if cfg.enabled and cfg.preload:
            self.start()

    # ---------------------------------------------------------------- loading
    def start(self) -> None:
        """Begin loading in the background (no-op when already loading or loaded)."""
        if not self.cfg.enabled or self._status in ("loading", "ready"):
            return
        with self._load_lock:
            if self._status in ("loading", "ready"):
                return
            self._status = "loading"
            self._error = ""
        threading.Thread(target=self._load, name="sam-loader", daemon=True).start()

    def _load(self) -> None:
        t0 = time.time()
        try:
            backend = self._factory(self.cfg)
            backend.load()
        except Exception as exc:  # noqa: BLE001 - surfaced to the user through status()
            self._error = str(exc)[:300]
            self._status = "error"
            return
        self._backend = backend
        self._load_seconds = round(time.time() - t0, 1)
        self._status = "ready"

    @staticmethod
    def _default_factory(cfg: SamConfig):
        from . import backends

        kind = cfg.backend
        if kind == "auto":
            kind = "remote" if cfg.remote_url else ("sam3" if cfg.checkpoint else "sam2")
        if kind == "remote":
            return backends.RemoteBackend(cfg.remote_url, cfg.remote_key, cfg.remote_auth_header)
        if kind == "sam3":
            return backends.Sam3Backend(cfg.checkpoint, cfg.repo_dir, cfg.device)
        return backends.HfSamBackend(cfg.model_id, cfg.device, cfg.hf_token)

    # ---------------------------------------------------------------- state
    @property
    def ready(self) -> bool:
        return self._status == "ready"

    @property
    def label(self) -> str:
        return getattr(self._backend, "name", "SAM") if self._backend is not None else "SAM"

    def status(self) -> dict[str, Any]:
        if self.cfg.enabled and self._status == "idle":
            self.start()  # first look at the status wakes a lazily-loaded model
        b = self._backend
        return {
            "enabled": bool(self.cfg.enabled),
            "status": self._status if self.cfg.enabled else "off",
            "error": self._error,
            "backend": getattr(b, "kind", self.cfg.backend) if b is not None else self.cfg.backend,
            "model": self.label if b is not None else self.cfg.model_id,
            "device": getattr(b, "device", ""),
            "interactive": bool(self.ready and getattr(b, "interactive", False)),
            "textPrompts": bool(self.ready and getattr(b, "text_prompts", False)),
            "loadSeconds": self._load_seconds,
        }

    # ---------------------------------------------------------------- use
    def run(self, fn: Callable[[Any], Any]) -> Any:
        if not self.ready:
            raise RuntimeError("SAM is not ready")
        with self._lock:
            return fn(self._backend)

    def embed_cached(self, rgb: np.ndarray) -> tuple[str, Any]:
        key = hashlib.sha1(rgb.tobytes()).hexdigest()[:20]
        with self._lock:
            handle = self._handles.get(key)
            if handle is not None:
                self._handles.move_to_end(key)
                return key, handle
            handle = self._backend.embed(rgb)
            self._handles[key] = handle
            while len(self._handles) > 4:
                self._handles.popitem(last=False)
            return key, handle

    def handle_for(self, image_id: str) -> Any | None:
        with self._lock:
            h = self._handles.get(image_id)
            if h is not None:
                self._handles.move_to_end(image_id)
            return h
