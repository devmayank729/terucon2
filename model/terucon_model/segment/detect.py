"""Ask Gemini (on Vertex AI, or with an AI Studio key) which surfaces a photo contains and roughly where.

Why polygons: Gemini 3.x models do not return pixel masks, and gemini-2.5-flash, which did, retires on
Vertex AI on 20 Oct 2026. Outlines through structured output are the durable interface. They are
only good to a few percent of the frame, which is exactly what SAM or edge snapping then fixes.
"""
from __future__ import annotations

import base64
import io
import json
import re
from dataclasses import dataclass, field
from typing import Any

import numpy as np
from PIL import Image

from ..config import Settings
from ..google_auth import GoogleAuth
from ..vertex import generate_content

KINDS = ["wall", "floor", "ceiling", "window", "door", "furniture", "other"]

# Tried in order when the configured model is not available to this project (404).
DETECT_FALLBACKS = ["gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.6-flash", "gemini-3.5-flash", "gemini-flash-latest", "gemini-2.5-flash"]

PROMPT = """You are annotating a photograph for an architectural design tool. A designer will pick one surface at a time and re-finish it, so every outline must follow the real visible edge of its surface.

First decide whether the photo is an "interior" (inside a room) or an "exterior" (a building seen from outside).

List every distinct SURFACE you can see. For each give:
- "label": a short descriptive name ("back wall with window", "front facade", "light oak floor", "main gate").
- "kind": one of wall, floor, ceiling, window, door, furniture, other.
- "polygon": the outline as [y, x] points, each value an integer 0-1000 (origin top-left of the image). Use as many points as the shape needs, up to 64: put a point at every corner and wherever the edge changes direction, and follow straight edges with straight segments. Go all the way round, close to the real edge, with no gaps.

What the kinds mean:
- wall: INTERIOR: each wall plane separately (left wall, back wall, right wall; walls meeting at a corner or finished differently are separate items). EXTERIOR: each facade plane, cladding area, parapet, pillar or boundary wall separately.
- floor: INTERIOR: the floor. EXTERIOR: the ground you walk or drive on (paving, road, driveway, steps).
- ceiling: INTERIOR: the ceiling. EXTERIOR: underside of a canopy or overhang.
- window: window glazing, glass walls and curtains.
- door: doors, gates, entrance frames, roller shutters.
- furniture: furniture and built-ins (sofa, bed, wardrobe, cabinets, kitchen counter, TV unit, dining table, rug) - interiors only.
- other: signboards, railings, roofs, fences, sculptures, anything else a designer might re-finish.

Rules:
- Outline a wall, floor or ceiling over its FULL extent, including the part hidden behind furniture or in front of by a door or window: objects in front are listed as their own items and are layered on top.
- Do NOT outline the sky, trees, plants, people, vehicles, or the view seen through a window.
- Do not invent surfaces that are not visible. At most 30 items.

Reply with JSON only: {"scene": "interior" | "exterior", "surfaces": [{"label": ..., "kind": ..., "polygon": [[y, x], ...]}, ...]}"""

SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "scene": {"type": "STRING", "enum": ["interior", "exterior"]},
        "surfaces": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {
                    "label": {"type": "STRING"},
                    "kind": {"type": "STRING", "enum": KINDS},
                    "polygon": {"type": "ARRAY", "items": {"type": "ARRAY", "items": {"type": "INTEGER"}}},
                },
                "required": ["label", "kind", "polygon"],
            },
        },
    },
    "required": ["scene", "surfaces"],
}


# Request shapes, richest first. A model that rejects one (HTTP 400) is retried with the next. No temperature is
# set: Google recommends leaving Gemini 3 models at their default.
GENERATION_SHAPES = [
    {"maxOutputTokens": 16384, "responseMimeType": "application/json", "responseSchema": SCHEMA, "thinkingConfig": {"thinkingLevel": "LOW"}},
    {"maxOutputTokens": 16384, "responseMimeType": "application/json", "responseSchema": SCHEMA},
    {"maxOutputTokens": 16384, "responseMimeType": "application/json"},
]


@dataclass
class Proposal:
    label: str
    kind: str
    polygon: list[list[float]]  # [y, x] 0-1000
    score: float = 1.0


@dataclass
class Detection:
    scene: str
    proposals: list[Proposal]
    model: str
    notes: list[str] = field(default_factory=list)


class DetectError(Exception):
    def __init__(self, message: str, status: int = 502, api_status: str = "UNAVAILABLE"):
        super().__init__(message)
        self.status = status
        self.api_status = api_status


# ---------------------------------------------------------------- parsing (defensive: formats drift between models)
def parse_json_loose(text: str) -> Any:
    t = (text or "").strip()
    t = re.sub(r"^```(?:json)?\s*", "", t, flags=re.I)
    t = re.sub(r"```\s*$", "", t).strip()
    try:
        return json.loads(t)
    except ValueError:
        pass
    start = min([i for i in (t.find("{"), t.find("[")) if i != -1], default=-1)
    end = max(t.rfind("}"), t.rfind("]"))
    if start != -1 and end > start:
        try:
            return json.loads(t[start : end + 1])
        except ValueError:
            pass
    if start != -1:
        # An answer cut off mid-list (a long polygon list can hit the token limit): keep every complete
        # item by closing the structure after the last object that parses.
        cuts = [m.start() for m in re.finditer(r"\}", t) if m.start() > start]
        for cut in reversed(cuts[-80:]):
            for closer in ("]}", "]", "}"):
                try:
                    return json.loads(t[start : cut + 1] + closer)
                except ValueError:
                    continue
    raise ValueError("The model did not return readable JSON.")


def normalize_kind(raw: Any, label: str) -> str:
    k = str(raw or "").lower().strip()
    if k in KINDS:
        return k
    text = f"{k} {label}".lower()
    if re.search(r"\b(window|curtain|blind|drape|glazing|skylight|glass)", text):
        return "window"
    if re.search(r"\b(door|doorway|entrance|gate|shutter)\b", text):
        return "door"
    if re.search(r"\bceiling|soffit\b", text):
        return "ceiling"
    if re.search(r"\b(sofa|couch|chair|table|bed|cabinet|wardrobe|shelf|shelves|counter|desk|tv|television|lamp|rug|stool|bench|dresser|console|ottoman|bookcase|kitchen|island|vanity|mirror)", text):
        return "furniture"
    if re.search(r"\b(floor|flooring|ground|paving|pavement|road|driveway|steps?)\b", text):
        return "floor"
    if re.search(r"\b(wall|facade|façade|partition|backsplash|column|pillar|parapet|cladding)\b", text):
        return "wall"
    return "other"


def clean_label(label: Any, kind: str) -> str:
    s = str(label or "").strip()
    m = re.match(r"^([a-z]+)\s*[:\-]\s*(.*)$", s, re.I)
    if m and m.group(1).lower() in KINDS:
        s = m.group(2).strip()
    if not s:
        s = kind.capitalize()
    return s[:1].upper() + s[1:]


def parse_proposals(data: Any) -> tuple[str, list[Proposal]]:
    scene = ""
    items: Any = data
    if isinstance(data, dict):
        scene = str(data.get("scene", "")).lower()
        for key in ("surfaces", "items", "regions", "segments", "objects", "masks"):
            if isinstance(data.get(key), list):
                items = data[key]
                break
    if not isinstance(items, list):
        return scene, []
    out: list[Proposal] = []
    for it in items:
        if not isinstance(it, dict):
            continue
        poly = it.get("polygon") or it.get("points") or it.get("contour")
        if not isinstance(poly, list) or len(poly) < 3:
            continue
        pts = []
        for p in poly:
            if isinstance(p, (list, tuple)) and len(p) >= 2:
                try:
                    pts.append([float(p[0]), float(p[1])])
                except (TypeError, ValueError):
                    continue
        if len(pts) < 3:
            continue
        label = str(it.get("label") or it.get("name") or "")
        kind = normalize_kind(it.get("kind"), label)
        out.append(Proposal(clean_label(label, kind), kind, pts))
    return scene, out


# ---------------------------------------------------------------- the call
def to_jpeg_b64(rgb: np.ndarray, quality: int = 90) -> str:
    buf = io.BytesIO()
    Image.fromarray(rgb).save(buf, "JPEG", quality=quality)
    return base64.b64encode(buf.getvalue()).decode("ascii")


def detect_surfaces(settings: Settings, auth: GoogleAuth, rgb: np.ndarray, model: str | None = None, location: str | None = None, hint: str = "") -> Detection:
    """Ask for the surfaces. Tries lighter request shapes when a model rejects structured output and
    walks down a list of model names when one is not available to the project."""
    wanted = model or settings.models.get("detect") or "gemini-3.8-flash"
    chain = [wanted] + [m for m in DETECT_FALLBACKS if m != wanted]
    prompt = PROMPT + (f"\n\nContext from the user: {hint.strip()[:300]}" if hint.strip() else "")
    image_part = {"inlineData": {"mimeType": "image/jpeg", "data": to_jpeg_b64(rgb)}}
    contents = [{"role": "user", "parts": [image_part, {"text": prompt}]}]
    shapes = GENERATION_SHAPES
    notes: list[str] = []
    last_error = "No answer from Gemini."
    for name in chain:
        shape_ok = False
        for gen in shapes:
            status, data, _info = generate_content(settings, auth, name, {"contents": contents, "generationConfig": gen}, location)
            if status == 200:
                shape_ok = True
                break
            err = (data.get("error") or {}) if isinstance(data, dict) else {}
            message = str(err.get("message", ""))
            last_error = message or f"HTTP {status}"
            if status == 400:
                continue  # this model rejects that request shape: try a simpler one
            if status == 404:
                break  # this model is not available here: try the next name
            raise DetectError(_explain(status, message, name, settings), status, str(err.get("status", "UNAVAILABLE")))
        if not shape_ok:
            if status == 404:
                notes.append(f"{name} is not available for this project.")
                continue
            if status == 400:
                raise DetectError(f"Gemini rejected the request for {name}: {last_error}", 400, "INVALID_ARGUMENT")
            continue
        text = _first_text(data)
        try:
            scene, proposals = parse_proposals(parse_json_loose(text))
        except ValueError as exc:
            raise DetectError(f"{name} {exc}", 502, "UNAVAILABLE") from exc
        if not proposals:
            notes.append(f"{name} returned no usable outlines.")
            raise DetectError(f"{name} found no surfaces in this photo. Try a clearer photo, or mark surfaces by hand.", 422, "FAILED_PRECONDITION")
        return Detection(scene or "", proposals, name, notes)
    raise DetectError(f"None of the Gemini models ({', '.join(chain[:3])}, ...) is available for this project. Set SWATCHROOM_DETECT_MODEL in .env to one your project can use. Last error: {last_error}", 404, "NOT_FOUND")


def _first_text(data: dict[str, Any]) -> str:
    cands = data.get("candidates") or []
    if not cands:
        block = (data.get("promptFeedback") or {}).get("blockReason")
        raise DetectError(f"Gemini blocked the request ({block})." if block else "Gemini returned no answer.", 422, "FAILED_PRECONDITION")
    parts = ((cands[0].get("content") or {}).get("parts")) or []
    return "\n".join(p["text"] for p in parts if isinstance(p, dict) and isinstance(p.get("text"), str) and not p.get("thought"))


def _explain(status: int, message: str, model: str, settings: Settings) -> str:
    m = message.lower()
    if status == 401:
        return message or "Google did not accept the credentials. Check .env."
    if status == 403:
        if "has not been used" in m or "is disabled" in m:
            return f"The Vertex AI API is turned off for project \"{settings.google.project_id}\". Enable aiplatform.googleapis.com, wait a minute, then retry."
        if "billing" in m:
            return f"Billing is not active on project \"{settings.google.project_id}\"."
        return f"The service account is not allowed to call {model}. Grant it the Vertex AI User role (roles/aiplatform.user)."
    if status == 429:
        return f"Quota reached for {model}. Wait a few seconds and try again."
    return message or f"Gemini returned HTTP {status}."
