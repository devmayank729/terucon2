"""How the mock Google answers like Gemini would for the synthetic room photo (synthetic.py): outlines for detection
(jittered by `jitter`), a tinted copy of the photo for a Nano Banana render, JSON for a quantity estimate.

Copied from the old tests/dev_stack.py so that this folder does not depend on anything outside model/. A test rig, not a
product feature. To use it, give MockGoogle `default_handler = make_handler()`, and point the client at the mock with
TERUCON_ALLOW_CUSTOM_GOOGLE_ENDPOINTS=1 and TERUCON_VERTEX_API_BASE=<mock base>, or the key's token_uri is refused.
"""
from __future__ import annotations

import base64
import io
import json

import numpy as np
from PIL import Image

import synthetic as syn
from mock_google import image_response, text_response

TINT = (178, 98, 70)  # terracotta


def _parts(body: dict) -> list[dict]:
    try:
        return body["contents"][0]["parts"]
    except (KeyError, IndexError, TypeError):
        return []


def _decode(part: dict) -> np.ndarray:
    return np.array(Image.open(io.BytesIO(base64.b64decode(part["inlineData"]["data"]))).convert("RGB"))


def make_handler(jitter: float = 14.0):
    outlines = syn.gemini_json(jitter=jitter, seed=11)

    def handler(model: str, body: dict, headers: dict):
        parts = _parts(body)
        text = " ".join(p.get("text", "") for p in parts if isinstance(p, dict))
        gen = body.get("generationConfig", {})
        modalities = gen.get("responseModalities") or []
        schema = json.dumps(gen.get("responseSchema", {}))
        images = [p for p in parts if isinstance(p, dict) and "inlineData" in p]
        if "IMAGE" in modalities and not images:  # a reachability probe with no photo
            buf = io.BytesIO()
            Image.new("RGB", (8, 8), TINT).save(buf, "PNG")
            return 200, image_response(buf.getvalue(), "probe")
        if "IMAGE" in modalities:  # a render: tint the masked area of the first photo
            base = _decode(images[0])
            mask = _decode(images[1])[..., 0] > 127 if len(images) > 1 else np.ones(base.shape[:2], bool)
            if mask.shape != base.shape[:2]:
                mask = np.array(Image.fromarray(mask.astype(np.uint8) * 255).resize((base.shape[1], base.shape[0]))) > 127
            out = base.copy().astype(np.float32)
            out[mask] = 0.2 * out[mask] + 0.8 * np.array(TINT, np.float32)
            buf = io.BytesIO()
            Image.fromarray(out.astype(np.uint8)).save(buf, "PNG")
            return 200, image_response(buf.getvalue(), "Rendered by the mock.")
        if "area_m2" in schema or "material take-off" in text:
            return 200, text_response(json.dumps({"area_m2": 18.4, "visible_area_m2": 12.1, "width_m": 4.2, "height_m": 2.8, "depth_m": 0, "confidence": "medium", "basis": "Standard internal door height of 2.1 m.", "rendered_description": "Warm terracotta finish with a fine, even texture."}))
        if "annotating a photograph" in text:  # the server's own detection prompt
            return 200, text_response(json.dumps(outlines))
        if "segmenting a room photograph" in text or "segmentation masks" in text:  # the studio's older helper prompts
            return 200, text_response(json.dumps(outlines["surfaces"]))
        return 200, text_response("ok")

    return handler
