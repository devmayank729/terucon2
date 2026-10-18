"""A synthetic room with exact ground truth, for testing the segmentation pipeline.

Coordinates are normalised 0-1000 (x, y) with the origin top-left. Each surface has a distinct
colour, a gentle gradient and a little noise so that edges are findable but not trivial.
"""
from __future__ import annotations

import cv2
import numpy as np

W, H = 960, 720

# (label, kind, polygon as (x, y) in 0-1000, base colour RGB)
SURFACES = [
    ("Ceiling", "ceiling", [(0, 0), (1000, 0), (800, 200), (200, 200)], (226, 224, 218)),
    ("Back wall", "wall", [(200, 200), (800, 200), (800, 700), (200, 700)], (196, 168, 140)),
    ("Left wall", "wall", [(0, 0), (200, 200), (200, 700), (0, 1000)], (150, 160, 178)),
    ("Right wall", "wall", [(1000, 0), (800, 200), (800, 700), (1000, 1000)], (176, 150, 150)),
    ("Floor", "floor", [(0, 1000), (200, 700), (800, 700), (1000, 1000)], (120, 98, 76)),
    ("Window", "window", [(380, 300), (620, 300), (620, 520), (380, 520)], (170, 205, 232)),
    ("Door", "door", [(850, 330), (930, 300), (930, 860), (850, 800)], (90, 64, 48)),
    ("Sofa", "furniture", [(320, 560), (680, 560), (700, 760), (300, 760)], (86, 112, 96)),
]
# bottom-to-top painting order
ORDER = ["Ceiling", "Back wall", "Left wall", "Right wall", "Floor", "Window", "Door", "Sofa"]


def _poly_px(poly):
    return np.array([[x / 1000 * W, y / 1000 * H] for x, y in poly], np.float32)


def mask_of(label: str) -> np.ndarray:
    for lab, _k, poly, _c in SURFACES:
        if lab == label:
            m = np.zeros((H, W), np.uint8)
            cv2.fillPoly(m, [np.round(_poly_px(poly)).astype(np.int32)], 1)
            return m
    raise KeyError(label)


def build(seed: int = 3):
    """Returns (rgb image, visible-label map 1..N in SURFACES order, list of labels)."""
    rng = np.random.default_rng(seed)
    img = np.zeros((H, W, 3), np.float32)
    labels = np.zeros((H, W), np.int32)
    by_label = {s[0]: (i + 1, s) for i, s in enumerate(SURFACES)}
    yy, xx = np.mgrid[0:H, 0:W]
    for name in ORDER:
        idx, (_lab, _kind, poly, color) = by_label[name]
        m = mask_of(name).astype(bool)
        grad = 0.9 + 0.2 * (xx / W) * 0.5 + 0.1 * (yy / H)
        for c in range(3):
            plane = color[c] * grad
            img[..., c][m] = plane[m]
        labels[m] = idx
    img += rng.normal(0, 3.0, img.shape)
    img = np.clip(img, 0, 255).astype(np.uint8)
    img = cv2.GaussianBlur(img, (0, 0), 0.8)
    return img, labels, [s[0] for s in SURFACES]


def gemini_outline(label: str, jitter: float, rng: np.random.Generator) -> list[list[int]]:
    """The surface's outline as Gemini would return it: [y, x] ints in 0-1000, drifted by `jitter`."""
    poly = next(p for lab, _k, p, _c in SURFACES if lab == label)
    drift = rng.normal(0, jitter, 2)
    out = []
    for x, y in poly:
        # add a few intermediate points per edge so the jitter bends the outline like a real one
        out.append([y + drift[1] + rng.normal(0, jitter * 0.35), x + drift[0] + rng.normal(0, jitter * 0.35)])
    out = [[int(min(1000, max(0, round(v)))) for v in p] for p in out]
    return out


def gemini_json(jitter: float = 12.0, seed: int = 5, scene: str = "interior") -> dict:
    rng = np.random.default_rng(seed)
    surfaces = []
    for lab, kind, _poly, _c in SURFACES:
        surfaces.append({"label": lab if kind != "wall" else f"{lab}", "kind": kind, "polygon": gemini_outline(lab, jitter, rng)})
    return {"scene": scene, "surfaces": surfaces}


def iou(a: np.ndarray, b: np.ndarray) -> float:
    a, b = a.astype(bool), b.astype(bool)
    u = np.logical_or(a, b).sum()
    return float(np.logical_and(a, b).sum() / u) if u else 0.0


if __name__ == "__main__":  # python model/tests/synthetic.py  -> writes model/tests/fixtures/room.jpg
    from pathlib import Path

    from PIL import Image

    out = Path(__file__).parent / "fixtures"
    out.mkdir(exist_ok=True)
    img, _labels, _names = build()
    Image.fromarray(img).save(out / "room.jpg", quality=95)
    print("wrote", out / "room.jpg")
