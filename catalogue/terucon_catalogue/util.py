"""Small helpers shared by every stage (hashing, atomic writes, image decoding, the background asyncio loop).

# Ported from terucon-cat-1.ipynb (cell 1). Definitions are copied verbatim except where marked "PORT:".
No import-time side effects: importing this module installs nothing, configures no logging and touches no GPU.
"""
from __future__ import annotations

import asyncio
import hashlib
import io
import logging
import os
import threading
from datetime import datetime, timezone
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageOps

# PORT: the notebook configures a stdout handler at import; a library must not. The CLI / Modal app configure logging.
LOGGER = logging.getLogger("catalogue")


IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff"}


def utc_now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def sha256_bytes(data):
    return hashlib.sha256(data).hexdigest()


def sha256_file(path, chunk_size=1 << 20):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        while True:
            chunk = handle.read(chunk_size)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def atomic_write_bytes(path, data):
    """Write to a temp file then rename, so a crash never leaves a half-written file."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = path.with_name(path.name + ".tmp")
    with open(temporary_path, "wb") as handle:
        handle.write(data)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary_path, path)


def chunked(sequence, size):
    for start in range(0, len(sequence), size):
        yield sequence[start:start + size]


def l2_normalize_rows(matrix):
    matrix = np.asarray(matrix, dtype=np.float32)
    if matrix.ndim == 1:
        norm = float(np.linalg.norm(matrix))
        return matrix / max(norm, 1e-12)
    norms = np.linalg.norm(matrix, axis=1, keepdims=True)
    return matrix / np.maximum(norms, 1e-12)


def load_rgb(source):
    """Load a path / bytes / PIL image / ndarray as an EXIF-corrected uint8 RGB array."""
    if isinstance(source, np.ndarray):
        array = source
        if array.ndim == 2:
            array = np.stack([array, array, array], axis=2)
        if array.shape[2] == 4:
            array = array[:, :, :3]
        return np.ascontiguousarray(array.astype(np.uint8))
    if isinstance(source, Image.Image):
        image = source
        return np.asarray(ImageOps.exif_transpose(image).convert("RGB")).copy()
    if isinstance(source, (bytes, bytearray)):
        with Image.open(io.BytesIO(source)) as image:
            return np.asarray(ImageOps.exif_transpose(image).convert("RGB")).copy()
    with Image.open(source) as image:
        return np.asarray(ImageOps.exif_transpose(image).convert("RGB")).copy()


def resize_max_side(rgb, max_side):
    height, width = rgb.shape[:2]
    longest = max(height, width)
    if longest <= max_side:
        return rgb
    scale = max_side / float(longest)
    new_size = (max(1, int(round(width * scale))), max(1, int(round(height * scale))))
    return cv2.resize(rgb, new_size, interpolation=cv2.INTER_AREA)


def encode_rgb(rgb, image_format="png", jpeg_quality=95):
    buffer = io.BytesIO()
    image = Image.fromarray(rgb)
    if image_format.lower() in ("jpg", "jpeg"):
        image.save(buffer, format="JPEG", quality=jpeg_quality, subsampling=0)
    else:
        image.save(buffer, format="PNG", compress_level=6)
    return buffer.getvalue()


def list_images(directory):
    directory = Path(directory)
    if not directory.exists():
        return []
    found = []
    for path in sorted(directory.rglob("*")):
        if path.is_file() and path.suffix.lower() in IMAGE_EXTENSIONS:
            found.append(path)
    return found


class AsyncRunner:
    """One long-lived event loop on a background thread.

    Jupyter already runs its own loop, so asyncio.run() fails in a cell. Running every Gemini
    coroutine on this single loop also keeps the SDK's HTTP sessions on one loop for their lifetime.
    """

    def __init__(self):
        self.loop = asyncio.new_event_loop()
        self._ready = threading.Event()
        self.thread = threading.Thread(target=self._serve, name="genai-event-loop", daemon=True)
        self.thread.start()
        self._ready.wait()

    def _serve(self):
        asyncio.set_event_loop(self.loop)
        self.loop.call_soon(self._ready.set)
        self.loop.run_forever()

    def run(self, coroutine, timeout=None):
        future = asyncio.run_coroutine_threadsafe(coroutine, self.loop)
        try:
            return future.result(timeout)
        except BaseException:
            future.cancel()  # Ctrl-C / interrupt in the notebook stops the in-flight batch
            raise


_ASYNC_RUNNER = None


def get_async_runner():
    global _ASYNC_RUNNER
    if _ASYNC_RUNNER is None:
        _ASYNC_RUNNER = AsyncRunner()
    return _ASYNC_RUNNER
