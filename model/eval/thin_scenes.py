#!/usr/bin/env python3
"""Thin structures and speed, on synthetic scenes (no photos or downloads needed).

The ADE20K surfaces used by refine_eval.py contain no furniture or railings, so this checks what they cannot:

  accuracy  12 scenes with a wall, floor, window, door, a table and a chair with thin legs and a railing of nine 5 px bars,
            exact ground truth; each route (raw outline, contour snapping, the earlier watershed) is scored per kind.
  speed     one 1536 x 1152 scene with 25 outlines (3 surfaces and 22 furniture-like or thin ones), timed in this process.

    python model/eval/thin_scenes.py [accuracy|speed|both]

Run it on a quiet machine for the timings.
"""
from __future__ import annotations

import sys
import time
from pathlib import Path

import cv2
import numpy as np

MODEL_DIR = Path(__file__).resolve().parent.parent  # the model/ folder, which holds the terucon_model package
sys.path.insert(0, str(MODEL_DIR))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import refine_eval as E  # noqa: E402
from terucon_model.segment import pipeline, refine  # noqa: E402
from terucon_model.segment.geometry import iou  # noqa: E402

KINDS = ("wall", "floor", "window", "door", "furniture", "other")


def rects(h: int, w: int, boxes) -> np.ndarray:
    m = np.zeros((h, w), np.uint8)
    for x0, y0, x1, y1 in boxes:
        m[max(0, y0) : max(0, y1), max(0, x0) : max(0, x1)] = 1
    return m


def scene(seed: int, h: int = 768, w: int = 1024):
    """a wall and floor with a window, a door, a table (4 thin legs), a chair and a railing (9 thin bars): (photo, [(kind, truth mask)])."""
    rng = np.random.default_rng(seed)
    img = np.zeros((h, w, 3), np.float32)
    horizon = int(0.72 * h)
    img[:] = (176, 160, 140)
    img[horizon:] = (110, 92, 72)
    shapes = [("wall", rects(h, w, [(0, 0, w, horizon)])), ("floor", rects(h, w, [(0, horizon, w, h)]))]

    def draw(kind, color, boxes):
        m = rects(h, w, boxes)
        img[m > 0] = color
        shapes.append((kind, m))

    ox, oy = int(rng.integers(-20, 20)), int(rng.integers(-15, 15))
    draw("window", (190, 215, 235), [(420 + ox, 120 + oy, 620 + ox, 300 + oy)])
    draw("door", (110, 80, 50), [(760 + ox, 150 + oy, 880 + ox, horizon + 60)])
    draw("furniture", (60, 70, 90), [(300, 420, 700, 450), (310, 450, 326, 610), (674, 450, 690, 610), (340, 450, 352, 590), (648, 450, 660, 590)])
    draw("furniture", (90, 60, 60), [(100, 380, 180, 400), (100, 300, 112, 520), (168, 300, 180, 520), (100, 400, 112, 540), (168, 400, 180, 540)])
    draw("other", (40, 40, 40), [(760, 520, 1000, 530)] + [(770 + i * 30, 530, 775 + i * 30, 690) for i in range(8)])
    img = np.clip(img + rng.normal(0, 3, img.shape), 0, 255).astype(np.uint8)
    return cv2.GaussianBlur(img, (0, 0), 0.8), shapes


def layered(masks, kinds) -> np.ndarray:
    order = sorted(range(len(masks)), key=lambda i: (pipeline.TIER.get(kinds[i], 2), -int(masks[i].sum())))
    return refine.paint(masks, order)


ROUTES = {
    "raw outline": dict(edge_refine=False),
    "contour snapping": dict(edge_refine=True),
    "earlier watershed": dict(edge_refine=True, edge_method="watershed"),
}


def accuracy(scenes: int = 12) -> None:
    got: dict[tuple[str, str], list[tuple[float, float]]] = {}
    for seed in range(scenes):
        img, shapes = scene(seed)
        rng = np.random.default_rng(100 + seed)
        outlines = [pipeline.Outline(k, k, E.simulate_proposal(t, 0.006, rng)) for k, t in shapes]
        truth = layered([t for _, t in shapes], [k for k, _ in shapes])
        for name, kw in ROUTES.items():
            labels = pipeline.sharpen(img, outlines, None, use_sam=False, **kw).labels
            for i, (kind, _) in enumerate(shapes):
                pred, gt = labels == i + 1, truth == i + 1
                got.setdefault((name, kind), []).append((iou(pred, gt), E.boundary_f1(pred.astype(np.uint8), gt.astype(np.uint8), 4.0)))
    print(f"{'':<12}" + "".join(f"{n:>24}" for n in ROUTES) + f"     (IoU / boundary F1, {scenes} scenes)")
    for kind in KINDS:
        row = f"{kind:<12}"
        for name in ROUTES:
            v = np.array(got[(name, kind)])
            row += f"{v[:, 0].mean():>14.3f} / {v[:, 1].mean():.3f}  "
        print(row)


def speed() -> None:
    h, w = 1152, 1536
    rng = np.random.default_rng(5)
    img, shapes = scene(0, h, w)
    outlines = [pipeline.Outline(k, k, E.simulate_proposal(t, 0.012, rng)) for k, t in shapes[:3]]
    while len(outlines) < 25:  # furniture-like and thin extras: tables with legs, railings, sofas
        k = len(outlines)
        x0, y0 = int(rng.integers(0, w - 300)), int(rng.integers(h // 3, h - 260))
        if k % 3 == 0:
            boxes = [(x0, y0, x0 + 260, y0 + 24)] + [(x0 + 8 + 80 * j, y0 + 24, x0 + 18 + 80 * j, y0 + 200) for j in range(4)]
        elif k % 3 == 1:
            boxes = [(x0, y0, x0 + 280, y0 + 8)] + [(x0 + 10 * j, y0 + 8, x0 + 10 * j + 4, y0 + 150) for j in range(0, 28, 3)]
        else:
            boxes = [(x0, y0, x0 + 240, y0 + 120)]
        kind = "other" if k % 3 == 1 else "furniture"
        outlines.append(pipeline.Outline(kind, kind, E.simulate_proposal(rects(h, w, boxes), 0.006, rng)))
    print(f"{w}x{h} photo, {len(outlines)} outlines (3 surfaces and {len(outlines) - 3} furniture-like or thin ones); median of 3 runs")
    for name, kw in ROUTES.items():
        runs, edges = [], 0.0
        for _ in range(3):
            t = time.perf_counter()
            sharp = pipeline.sharpen(img, outlines, None, use_sam=False, **kw)
            runs.append(time.perf_counter() - t)
            edges = sharp.timings.get("edges", 0.0)
        print(f"  {name:<20}{np.median(runs):>6.2f} s in total, {edges:>5.2f} s of it edge snapping")
    img2, shapes2 = scene(0)
    small = [pipeline.Outline(k, k, E.simulate_proposal(t, 0.012, rng)) for k, t in shapes2]
    print(f"{img2.shape[1]}x{img2.shape[0]} photo, {len(small)} outlines")
    for name, kw in ROUTES.items():
        runs = []
        for _ in range(3):
            t = time.perf_counter()
            pipeline.sharpen(img2, small, None, use_sam=False, **kw)
            runs.append(time.perf_counter() - t)
        print(f"  {name:<20}{np.median(runs):>6.2f} s in total")


if __name__ == "__main__":
    which = sys.argv[1] if len(sys.argv) > 1 else "both"
    if which not in ("accuracy", "speed", "both"):  # -h, --help, or a typo (which used to run nothing, silently)
        print(__doc__)
        sys.exit(0 if which in ("-h", "--help") else 2)
    if which in ("accuracy", "both"):
        accuracy()
    if which in ("speed", "both"):
        if which == "both":
            print()
        speed()
