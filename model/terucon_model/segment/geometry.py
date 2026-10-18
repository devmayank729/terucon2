"""Small raster helpers shared by the pipeline and the evaluation tools."""
from __future__ import annotations

import cv2
import numpy as np


def polygon_to_mask(points_yx_1000: list[list[float]], height: int, width: int) -> np.ndarray:
    """Fill a polygon given as [y, x] pairs normalised to 0-1000 (the format Gemini is asked for)."""
    pts = []
    for p in points_yx_1000:
        if not isinstance(p, (list, tuple)) or len(p) < 2:
            continue
        y = min(1000.0, max(0.0, float(p[0]))) / 1000.0 * height
        x = min(1000.0, max(0.0, float(p[1]))) / 1000.0 * width
        pts.append([x, y])
    mask = np.zeros((height, width), np.uint8)
    if len(pts) >= 3:
        cv2.fillPoly(mask, [np.round(np.array(pts)).astype(np.int32)], 1, lineType=cv2.LINE_8)
    return mask


def box_to_mask(box_yxyx_1000: list[float], height: int, width: int) -> np.ndarray:
    y0, x0, y1, x1 = [min(1000.0, max(0.0, float(v))) / 1000.0 for v in box_yxyx_1000]
    mask = np.zeros((height, width), np.uint8)
    ya, yb = int(np.floor(min(y0, y1) * height)), int(np.ceil(max(y0, y1) * height))
    xa, xb = int(np.floor(min(x0, x1) * width)), int(np.ceil(max(x0, x1) * width))
    mask[ya:yb, xa:xb] = 1
    return mask


def bbox(mask: np.ndarray) -> tuple[int, int, int, int] | None:
    """(x0, y0, x1, y1) with x1/y1 exclusive, or None when empty."""
    ys, xs = np.nonzero(mask)
    if ys.size == 0:
        return None
    return int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1


def iou(a: np.ndarray, b: np.ndarray) -> float:
    a, b = a.astype(bool), b.astype(bool)
    union = np.logical_or(a, b).sum()
    return float(np.logical_and(a, b).sum() / union) if union else 0.0


def core_points(mask: np.ndarray, count: int = 3, min_gap_frac: float = 0.18) -> list[tuple[float, float]]:
    """Well-inside, well-spread (x, y) points of a mask: prompts that say "this is definitely the surface".

    Picks the deepest point (distance transform), then repeatedly the deepest point that is at
    least `min_gap_frac` of the mask's size away from those already chosen.
    """
    m = (mask > 0).astype(np.uint8)
    if not m.any():
        return []
    dist = cv2.distanceTransform(m, cv2.DIST_L2, 5)
    bb = bbox(m)
    assert bb is not None
    gap = max(6.0, min_gap_frac * max(bb[2] - bb[0], bb[3] - bb[1]))
    chosen: list[tuple[float, float]] = []
    work = dist.copy()
    for _ in range(count):
        idx = int(np.argmax(work))
        y, x = divmod(idx, work.shape[1])
        if work[y, x] <= 1.0:
            break
        chosen.append((float(x), float(y)))
        cv2.circle(work, (x, y), int(gap), 0, thickness=-1)
    return chosen


def largest_components(mask: np.ndarray, keep_share: float = 0.02, min_pixels: int = 0) -> np.ndarray:
    """Keep the biggest connected component plus any other component at least `keep_share` of it."""
    m = (mask > 0).astype(np.uint8)
    n, lab, stats, _ = cv2.connectedComponentsWithStats(m, connectivity=4)
    if n <= 1:
        return m
    areas = stats[1:, cv2.CC_STAT_AREA]
    top = areas.max()
    keep = np.zeros(n, bool)
    for i, a in enumerate(areas, start=1):
        if a >= max(min_pixels, keep_share * top):
            keep[i] = True
    return keep[lab].astype(np.uint8)


def fill_small_holes(mask: np.ndarray, max_area: int) -> np.ndarray:
    m = (mask > 0).astype(np.uint8)
    inv = 1 - m
    n, lab, stats, _ = cv2.connectedComponentsWithStats(inv, connectivity=4)
    out = m.copy()
    for i in range(1, n):
        x, y, w, h, area = stats[i]
        touches_border = x == 0 or y == 0 or x + w == m.shape[1] or y + h == m.shape[0]
        if not touches_border and area <= max_area:
            out[lab == i] = 1
    return out
