"""Mock Google OAuth + Vertex AI generateContent for Swatchroom tests.

Run:  python3 mock_google.py [port]
The Swatchroom server is pointed here with GOOGLE_TOKEN_URL and VERTEX_BASE_URL (see .env.test).

Behaviour is chosen from the request body:
  - image models (model id contains "image" or "banana"): returns Image 1 recoloured inside the
    white area of Image 2, at the same size (or slightly rescaled when MOCK_SHIFT=1 to exercise alignment)
  - outline requests ("polygon" in the prompt): returns canned polygons from polys.json when present, else []
  - measuring requests ("take-off" in the prompt): returns an area estimate
  - anything else: returns "OK"
Env:
  MOCK_DELAY   seconds to wait on renders (default 1.2)
  MOCK_FAIL    "render" makes renders fail with 429 once, "outline" makes outlines 500
"""
import base64
import io
import json
import os
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
STATE = {"render_fail_used": False, "calls": []}


def b64_to_image(data):
    return Image.open(io.BytesIO(base64.b64decode(data)))


def image_to_b64(image, fmt="PNG"):
    buf = io.BytesIO()
    image.save(buf, format=fmt, quality=90)
    return base64.b64encode(buf.getvalue()).decode()


def fake_render(parts, prompt_text):
    images = [p["inlineData"] for p in parts if "inlineData" in p]
    room = b64_to_image(images[0]["data"]).convert("RGB")
    mask = b64_to_image(images[1]["data"]).convert("L").resize(room.size)
    room_np = np.asarray(room).astype(np.float32)
    mask_np = (np.asarray(mask) > 127)[..., None]
    lum = room_np.mean(axis=2, keepdims=True)
    tint = np.array([120, 150, 120], dtype=np.float32)
    if "terrazzo" in prompt_text.lower() or "oak" in prompt_text.lower():
        tint = np.array([190, 140, 90], dtype=np.float32)
    if "indigo" in prompt_text.lower():
        tint = np.array([60, 80, 140], dtype=np.float32)
    recoloured = np.clip(tint * (lum / 160.0), 0, 255)
    out = np.where(mask_np, recoloured, room_np).astype(np.uint8)
    result = Image.fromarray(out)
    # model output sizes are snapped; emulate a 2K-ish output with the same aspect
    long_side = 2048
    w, h = result.size
    scale = long_side / max(w, h)
    result = result.resize((round(w * scale), round(h * scale)))
    if os.environ.get("MOCK_SHIFT") == "1":
        # crop 1.5% and rescale to emulate slight reframing by the model
        w, h = result.size
        dx, dy = int(w * 0.015), int(h * 0.015)
        result = result.crop((dx, dy, w - dx, h - dy)).resize((w, h))
    return result


def outline_response():
    path = os.path.join(HERE, "polys.json")
    if os.path.exists(path):
        return json.load(open(path))
    return []


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def _send(self, code, payload):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.end_headers()

    def do_GET(self):
        if self.path.startswith("/calls"):
            return self._send(200, STATE["calls"])
        if self.path.startswith("/reset"):
            STATE["calls"] = []
            STATE["render_fail_used"] = False
            return self._send(200, {"ok": True})
        self._send(404, {"error": {"message": "not found"}})

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        if "/token" in self.path:
            return self._send(200, {"access_token": "ya29.fake-token", "expires_in": 3600, "token_type": "Bearer"})
        try:
            body = json.loads(raw or b"{}")
        except Exception:
            return self._send(400, {"error": {"message": "bad json", "status": "INVALID_ARGUMENT"}})
        model = self.path.split("/models/")[-1].split(":")[0]
        contents = body.get("contents") or [{}]
        parts = contents[0].get("parts", [])
        texts = " ".join(p.get("text", "") for p in parts)
        system = " ".join(p.get("text", "") for p in (body.get("systemInstruction") or {}).get("parts", []))
        gen = body.get("generationConfig") or {}
        STATE["calls"].append({"model": model, "kind": "?", "keys": list(gen.keys()),
                               "images": sum(1 for p in parts if "inlineData" in p),
                               "temperature": gen.get("temperature"),
                               "thinking": gen.get("thinkingConfig"), "imageConfig": gen.get("imageConfig")})
        call = STATE["calls"][-1]

        if "temperature" in gen and model.startswith("gemini-3.8"):
            call["kind"] = "rejected-temperature"
            return self._send(400, {"error": {"code": 400, "status": "INVALID_ARGUMENT",
                                              "message": "temperature is not supported for this model"}})

        if "Reply with the single word OK" in texts:
            call["kind"] = "probe"
            return self._send(200, {"candidates": [{"content": {"parts": [{"text": "OK"}]}, "finishReason": "STOP"}]})

        if "image" in model or "banana" in model:
            call["kind"] = "render"
            if os.environ.get("MOCK_FAIL") == "render" and not STATE["render_fail_used"]:
                STATE["render_fail_used"] = True
                return self._send(429, {"error": {"code": 429, "status": "RESOURCE_EXHAUSTED", "message": "Quota exceeded"}})
            time.sleep(float(os.environ.get("MOCK_DELAY", "1.2")))
            image = fake_render(parts, texts + " " + system)
            return self._send(200, {
                "candidates": [{"content": {"parts": [
                    {"text": "Here is the edited room."},
                    {"inlineData": {"mimeType": "image/png", "data": image_to_b64(image)}}]},
                    "finishReason": "STOP"}],
                "usageMetadata": {"promptTokenCount": 1800, "candidatesTokenCount": 1290, "totalTokenCount": 3090}})

        if "take-off" in texts:
            call["kind"] = "measure"
            time.sleep(0.4)
            answer = {"area_m2": 18.6, "visible_area_m2": 12.2, "width_m": 4.8, "height_m": 2.9, "depth_m": 4.1,
                      "confidence": "medium", "basis": "Scaled from the 2.1 m door frame on the left.",
                      "rendered_description": "A soft sage matte finish with even coverage and crisp edges."}
            return self._send(200, {"candidates": [{"content": {"parts": [{"text": json.dumps(answer)}]}, "finishReason": "STOP"}]})

        if "polygon" in texts.lower() or "segment" in texts.lower():
            call["kind"] = "outline"
            if os.environ.get("MOCK_FAIL") == "outline":
                return self._send(500, {"error": {"code": 500, "message": "internal"}})
            time.sleep(0.6)
            return self._send(200, {"candidates": [{"content": {"parts": [{"text": json.dumps(outline_response())}]}, "finishReason": "STOP"}]})

        call["kind"] = "text"
        return self._send(200, {"candidates": [{"content": {"parts": [{"text": "OK"}]}, "finishReason": "STOP"}]})


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8790
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
