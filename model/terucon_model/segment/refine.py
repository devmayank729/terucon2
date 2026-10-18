"""Turn rough surface masks (a Gemini polygon is good to a few percent of the frame) into masks
whose edges sit on the real edges in the photo.

All functions work on numpy arrays at the analysis resolution:
    img     uint8  H x W x 3  (RGB)
    labels  int32  H x W      0 = no surface, 1..N = surfaces (already layered, nothing overlaps)
"""
from __future__ import annotations

import cv2
import numpy as np

from .geometry import fill_small_holes, largest_components

# --------------------------------------------------------------------------- layering


def paint(masks: list[np.ndarray], order: list[int] | None = None) -> np.ndarray:
    """Layer masks into one label map. `order` lists mask indices from bottom to top; later wins.

    Default order is biggest first, so a small thing (a window, a door, a lamp) sits on top of the
    large surface (its wall) it overlaps.
    """
    if not masks:
        return np.zeros((0, 0), np.int32)
    h, w = masks[0].shape
    if order is None:
        order = sorted(range(len(masks)), key=lambda i: -int(masks[i].sum()))
    out = np.zeros((h, w), np.int32)
    for i in order:
        out[masks[i] > 0] = i + 1
    return out


# --------------------------------------------------------------------------- watershed snapping


def smooth_for_edges(img: np.ndarray, strength: float = 1.0) -> np.ndarray:
    """Flatten texture (brick, wood grain, noise) but keep real edges, so only real edges stop a flood."""
    h, w = img.shape[:2]
    k = max(1.0, min(h, w) / 700.0)
    d = int(round(5 * k)) | 1
    out = cv2.bilateralFilter(img, d, 28 * strength, 5 * k)
    return cv2.bilateralFilter(out, d, 28 * strength, 5 * k)


def _markers(labels: np.ndarray, core_px: int, bg_id: int) -> np.ndarray:
    """Eroded cores of every region (including 'no surface') as watershed seeds; 0 = undecided."""
    h, w = labels.shape
    markers = np.zeros((h, w), np.int32)
    r = max(1, int(core_px))
    ker = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * r + 1, 2 * r + 1))
    ids = np.unique(labels)
    for lab in ids:
        region = (labels == lab).astype(np.uint8)
        if lab == 0:
            core = cv2.erode(region, ker, borderType=cv2.BORDER_CONSTANT, borderValue=0)
            marker_id = bg_id
        else:
            core = cv2.erode(region, ker, borderType=cv2.BORDER_REPLICATE)
            marker_id = int(lab)
        if not core.any():
            # a thin or small region: seed it with its deepest pixels so it is not swallowed
            dist = cv2.distanceTransform(region, cv2.DIST_L2, 3)
            if dist.max() <= 0:
                continue
            core = (dist >= max(1.0, 0.6 * dist.max())).astype(np.uint8)
        markers[(core > 0) & (markers == 0)] = marker_id
    return markers


def snap_watershed(img: np.ndarray, labels: np.ndarray, core_frac: float = 0.012, smooth: float = 1.0) -> np.ndarray:
    """Marker-controlled watershed: each surface's eroded core floods outward and the flood stops at
    the strongest edge between neighbours. Result is a consistent partition (no overlaps or gaps).

    This was the edge-snapping method until snap.py's contour snapping replaced it (its seed size was either too small to
    fix a bad outline or large enough to wreck a good one). It is still here for EDGE_METHOD=watershed and for comparison."""
    h, w = labels.shape
    bg_id = int(labels.max()) + 1
    core_px = max(2, int(round(core_frac * min(h, w))))
    markers = _markers(labels, core_px, bg_id)
    flat = smooth_for_edges(img, smooth)
    ws = cv2.watershed(cv2.cvtColor(flat, cv2.COLOR_RGB2BGR), markers.copy())
    # watershed lines come back as -1: give them to a neighbouring region
    lines = ws == -1
    if lines.any():
        filled = ws.copy()
        filled[lines] = 0
        for _ in range(3):
            grown = cv2.dilate(np.where(filled > 0, filled, 0).astype(np.float32), np.ones((3, 3), np.uint8))
            filled = np.where((filled <= 0) & (grown > 0), grown, filled).astype(np.int32)
        ws = np.where(lines, filled, ws)
    ws = np.where(ws < 0, labels, ws)
    ws[ws == bg_id] = 0
    return ws.astype(np.int32)


# --------------------------------------------------------------------------- guided filter snapping


def _guided_filter(guide: np.ndarray, src: np.ndarray, radius: int, eps: float) -> np.ndarray:
    """He et al. guided filter, grey guide, box filters only."""
    ksize = (2 * radius + 1, 2 * radius + 1)
    mean = lambda x: cv2.boxFilter(x, cv2.CV_32F, ksize, normalize=True, borderType=cv2.BORDER_REPLICATE)  # noqa: E731
    mean_g, mean_s = mean(guide), mean(src)
    cov = mean(guide * src) - mean_g * mean_s
    var = mean(guide * guide) - mean_g * mean_g
    a = cov / (var + eps)
    b = mean_s - a * mean_g
    return mean(a) * guide + mean(b)


def snap_guided(img: np.ndarray, labels: np.ndarray, radius_frac: float = 0.012, eps: float = 0.0025) -> np.ndarray:
    """Per-surface soft mask pulled onto the photo's edges by a guided filter; strongest surface wins."""
    h, w = labels.shape
    r = max(3, int(round(radius_frac * min(h, w))))
    gray = cv2.cvtColor(img, cv2.COLOR_RGB2GRAY).astype(np.float32) / 255.0
    n = int(labels.max())
    best = np.full((h, w), -1.0, np.float32)
    out = np.zeros((h, w), np.int32)
    pad = 2 * r + 2
    for lab in range(0, n + 1):
        region = (labels == lab).astype(np.float32)
        if lab != 0 and region.sum() == 0:
            continue
        if lab == 0:
            soft = _guided_filter(gray, cv2.GaussianBlur(region, (0, 0), r / 2.0), r, eps)
        else:
            ys, xs = np.nonzero(region)
            y0, y1 = max(0, ys.min() - pad), min(h, ys.max() + pad + 1)
            x0, x1 = max(0, xs.min() - pad), min(w, xs.max() + pad + 1)
            soft = np.full((h, w), -1.0, np.float32)
            crop = _guided_filter(gray[y0:y1, x0:x1], cv2.GaussianBlur(region[y0:y1, x0:x1], (0, 0), r / 2.0), r, eps)
            soft[y0:y1, x0:x1] = crop
        upd = soft > best
        best[upd] = soft[upd]
        out[upd] = lab
    return out


# --------------------------------------------------------------------------- GrabCut snapping


def snap_grabcut(img: np.ndarray, labels: np.ndarray, band_frac: float = 0.025, iters: int = 3) -> np.ndarray:
    """GrabCut each surface inside a band around its edge (colour models learned from the cores)."""
    h, w = labels.shape
    band = max(3, int(round(band_frac * min(h, w))))
    bgr = cv2.cvtColor(img, cv2.COLOR_RGB2BGR)
    n = int(labels.max())
    score = np.zeros((h, w), np.float32)
    out = labels.copy()
    ker_b = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * band + 1, 2 * band + 1))
    for lab in range(1, n + 1):
        region = (labels == lab).astype(np.uint8)
        if region.sum() < 40:
            continue
        ys, xs = np.nonzero(region)
        pad = band * 2
        y0, y1 = max(0, ys.min() - pad), min(h, ys.max() + pad + 1)
        x0, x1 = max(0, xs.min() - pad), min(w, xs.max() + pad + 1)
        reg = region[y0:y1, x0:x1]
        gc = np.full(reg.shape, cv2.GC_BGD, np.uint8)
        inner = cv2.erode(reg, ker_b)
        outer = cv2.dilate(reg, ker_b)
        gc[outer > 0] = cv2.GC_PR_BGD
        gc[reg > 0] = cv2.GC_PR_FGD
        gc[inner > 0] = cv2.GC_FGD
        if (gc == cv2.GC_FGD).sum() < 10 or (gc == cv2.GC_BGD).sum() < 10:
            continue
        bgd, fgd = np.zeros((1, 65), np.float64), np.zeros((1, 65), np.float64)
        try:
            cv2.grabCut(bgr[y0:y1, x0:x1], gc, None, bgd, fgd, iters, cv2.GC_INIT_WITH_MASK)
        except cv2.error:
            continue
        fg = ((gc == cv2.GC_FGD) | (gc == cv2.GC_PR_FGD)).astype(np.uint8)
        full = np.zeros((h, w), np.uint8)
        full[y0:y1, x0:x1] = fg
        region_out = full > 0
        # a surface only claims pixels that no earlier surface kept; ties go to the smaller surface
        out[(out == lab) & ~region_out] = 0
    # re-layer: grow each surface's new mask (bigger first)
    result = np.zeros((h, w), np.int32)
    areas = {lab: int((out == lab).sum()) for lab in range(1, n + 1)}
    for lab in sorted(areas, key=lambda k: -areas[k]):
        result[out == lab] = lab
    return result


# --------------------------------------------------------------------------- clean-up


def clean_labels(labels: np.ndarray, min_share: float = 0.0006, hole_share: float = 0.0004, smooth_px: int = 0) -> np.ndarray:
    """Remove specks, close pin-holes and (optionally) smooth jaggies, without merging surfaces."""
    h, w = labels.shape
    total = h * w
    out = np.zeros_like(labels)
    ids = [i for i in np.unique(labels) if i != 0]
    ids.sort(key=lambda i: -int((labels == i).sum()))
    for lab in ids:
        m = (labels == lab).astype(np.uint8)
        m = largest_components(m, keep_share=0.04, min_pixels=int(min_share * total))
        m = fill_small_holes(m, int(hole_share * total))
        if smooth_px > 0:
            k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * smooth_px + 1, 2 * smooth_px + 1))
            m = cv2.morphologyEx(m, cv2.MORPH_OPEN, k)
            m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, k)
        out[(m > 0) & (out == 0)] = lab
    return out


METHODS = {
    "none": lambda img, labels, **kw: labels,
    "watershed": snap_watershed,
    "guided": snap_guided,
    "grabcut": snap_grabcut,
}
