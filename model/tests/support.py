"""Helpers shared by the model tests.

Two rules live here so no test can break them by accident:
  * a test never reads the real project .env (importing this module makes that an error, not a silent leak), and
  * an app or settings object is always built from an explicit temp env file AND an explicit environ dict,
    because `environ=None` would mean "merge in the real process environment", real credentials included.
"""
from __future__ import annotations

import base64
import io
import json
import sys
import tempfile
import zlib
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
MODEL_DIR = HERE.parent
for _p in (str(MODEL_DIR), str(HERE)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import numpy as np  # noqa: E402
from PIL import Image  # noqa: E402

from terucon_model import config  # noqa: E402
from terucon_model.app import create_app  # noqa: E402

ROOT = config.ROOT
REAL_ENV = (ROOT / ".env").resolve()
LOCAL = {"Host": "localhost:8081"}
JSON = {"Host": "localhost:8081", "Content-Type": "application/json"}


def _forbid(original):
    def guarded(path, *args, **kwargs):
        if Path(path).resolve() == REAL_ENV:
            raise AssertionError(f"a test tried to read the real {REAL_ENV}; pass an explicit temp env file")
        return original(path, *args, **kwargs)

    return guarded


# config.py looks these two up in its own namespace at call time, so wrapping them covers every way of reading the file.
config.load_env_file = _forbid(config.load_env_file)
config.merged_environment = _forbid(config.merged_environment)


def write_env(directory: str | Path, text: str = "") -> Path:
    p = Path(directory) / ".env"
    p.write_text(text, encoding="utf-8")
    return p


def make_app(directory: str | Path, environ: dict[str, str] | None = None, env_text: str = "", sam_manager: Any = None):
    """A model-service app on a temp env file with exactly `environ` as the process environment (plus a HOME that holds nothing)."""
    env_path = write_env(directory, env_text)
    return create_app(env_path=env_path, environ={"HOME": str(directory), **(environ or {})}, sam_manager=sam_manager)


def google_environ(info: dict[str, Any], mock_base: str, **extra: str) -> dict[str, str]:
    """The environment that points the service's Google client at a MockGoogle."""
    return {
        "GCP_SERVICE_ACCOUNT_JSON": json.dumps(info),
        "TERUCON_ALLOW_CUSTOM_GOOGLE_ENDPOINTS": "1",
        "TERUCON_VERTEX_API_BASE": mock_base,
        **extra,
    }


def jpeg_b64(rgb: np.ndarray) -> str:
    buf = io.BytesIO()
    Image.fromarray(rgb).save(buf, "JPEG", quality=92)
    return base64.b64encode(buf.getvalue()).decode()


def decode_labels(resp: dict) -> np.ndarray:
    lm = resp["labelMap"]
    dtype = "<u2" if lm["encoding"] == "zlib-u16le" else "u1"
    return np.frombuffer(zlib.decompress(base64.b64decode(lm["data"])), dtype).reshape(resp["height"], resp["width"]).astype(np.int32)


def tempdir() -> tempfile.TemporaryDirectory:
    return tempfile.TemporaryDirectory(prefix="terucon-model-test-")
