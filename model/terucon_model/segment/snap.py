"""Contour snapping: slide every boundary of a rough mask onto the photo's real edge.

A language model's outline is good to a few percent of the frame, so the true boundary is usually a short slide away
along the outline's normal. For each contour of the mask (outer boundaries and holes) the boundary is resampled and every
sample may move by d along its normal. Moving costs something (a prior to stay put, a price for bending); what pays for it
is evidence from the photo:

    edges    the colour changes sharply across the boundary,
    region   the pixels kept look like the surface's own interior and the pixels dropped look like its surroundings
             (finds boundaries that are not sharp, such as ceiling meeting wall),
    SAM      the boundary sits where SAM put one (only when SAM is on).

Dynamic programming (Viterbi on the closed chain of samples) picks the cheapest set of moves. Evidence has to beat the price of
moving, so a good outline barely changes while a bad one is pulled onto the real edge. That is what the marker watershed this
replaces could not do: its seed size was either too small to fix bad outlines or large enough to wreck good ones.

The frame of the photo counts as a place where a boundary may end (a modest bonus, SnapParams.frame): surfaces such as ceilings
and walls run to the edge of the photo, and an outline that stops a few pixels short of it should not leave a visible strip.
A clear edge in the photo still wins over that pull.

All work happens at a capped working resolution (short side <= WORK_SHORT) and the snapped polygons are scaled back up, so the
pixel constants below mean the same thing on a 600 px photo and a 1536 px one, and the cost does not grow with the photo.
Nothing here needs more than numpy and OpenCV.
"""
from __future__ import annotations

import time
from dataclasses import dataclass

import cv2
import numpy as np
from numpy.lib.stride_tricks import sliding_window_view

from .refine import smooth_for_edges

WORK_SHORT = 768  # working resolution: photos with a longer short side are shrunk to this for the evidence
MAX_CONTOURS = 12  # refine at most this many contours per mask (largest first); the rest are kept as they are
MAX_SAMPLES = 1500  # at most this many samples along one contour
MIN_AREA = 40  # contours smaller than this (working pixels squared) are kept as they are
AREA_RANGE = (0.25, 4.0)  # a snapped mask whose area leaves this range (against the mask it started from) is rejected


@dataclass(frozen=True)
class SnapParams:
    reach: float = 0.05  # how far a boundary may move, share of the short side
    prior: float = 0.8  # price of moving the boundary all the way to the reach; evidence has to beat it
    stiffness: float = 0.08  # price of bending, per pixel of difference between neighbouring samples
    edge: float = 1.0  # weight of colour change across the boundary
    region: float = 1.0  # weight of region appearance
    sam: float = 0.8  # weight of "SAM put a boundary here" (used only when a SAM mask is given)
    edge_scale: float = 12.0  # Lab difference that counts as a full edge
    arm: float = 3.0  # pixels each side of the boundary that the colour change is measured across
    sam_width: float = 3.0  # how close to SAM's boundary still counts, pixels
    frame: float = 0.6  # a boundary may end on the photo's frame: surfaces that reach it do not stop a few pixels short


# an outline on its own: look far, stay put unless the photo insists
OUTLINE_ONLY = SnapParams(reach=0.05, prior=0.7)
# the boundary came from SAM (blended into the outline): it is already close, so only align it with the photo's edges
WITH_SAM = SnapParams(reach=0.03, prior=0.6)


class Evidence:
    """What the photo says about boundaries, computed once per photo and shared by all surfaces."""

    def __init__(self, rgb: np.ndarray):
        self.h, self.w = rgb.shape[:2]
        self.f = min(1.0, WORK_SHORT / float(min(self.h, self.w)))  # working scale
        small = rgb if self.f >= 1.0 else cv2.resize(rgb, (max(8, round(self.w * self.f)), max(8, round(self.h * self.f))), interpolation=cv2.INTER_AREA)
        lab = cv2.cvtColor(smooth_for_edges(small), cv2.COLOR_RGB2LAB).astype(np.float32)
        lab[..., 0] *= 100.0 / 255.0
        lab[..., 1:] -= 128.0
        self.lab = lab  # float32, L 0-100, a/b about -100..100, after edge-preserving smoothing
        self.wh, self.ww = small.shape[:2]

    def to_photo(self, pts: np.ndarray) -> np.ndarray:
        """working-resolution points (x, y) as integer points on the photo itself; the working frame maps onto the photo's frame."""
        full = (pts + 0.5) * (self.w / self.ww, self.h / self.wh) - 0.5
        full[pts[:, 0] <= 0, 0] = 0.0
        full[pts[:, 0] >= self.ww - 1, 0] = self.w - 1.0
        full[pts[:, 1] <= 0, 1] = 0.0
        full[pts[:, 1] >= self.wh - 1, 1] = self.h - 1.0
        return np.round(full).astype(np.int32)

    def down(self, mask: np.ndarray) -> np.ndarray:
        """a full-size mask at working resolution (uint8 0/1)."""
        m = (mask > 0).astype(np.uint8)
        if self.f >= 1.0:
            return m
        return (cv2.resize(m * 255, (self.ww, self.wh), interpolation=cv2.INTER_AREA) > 127).astype(np.uint8)


# --------------------------------------------------------------------------- contour geometry


def _resample(points: np.ndarray, step: float) -> np.ndarray:
    """a closed polyline (N, 2) as points about `step` apart."""
    p = np.vstack([points, points[:1]])
    seg = np.hypot(*np.diff(p, axis=0).T)
    cum = np.concatenate([[0.0], np.cumsum(seg)])
    total = cum[-1]
    n = max(8, int(round(total / step)))
    t = np.linspace(0.0, total, n, endpoint=False)
    return np.stack([np.interp(t, cum, p[:, 0]), np.interp(t, cum, p[:, 1])], axis=1)


def _smooth_closed(x: np.ndarray, sigma: float) -> np.ndarray:
    k = int(max(1, round(3 * sigma)))
    ker = np.exp(-0.5 * (np.arange(-k, k + 1) / sigma) ** 2)
    ker /= ker.sum()
    pad = np.concatenate([x[-k:], x, x[:k]], axis=0)
    return np.stack([np.convolve(pad[:, c], ker, mode="valid") for c in range(x.shape[1])], axis=1)


def _normals(pts: np.ndarray) -> np.ndarray:
    t = np.roll(pts, -1, axis=0) - np.roll(pts, 1, axis=0)
    t /= np.maximum(np.hypot(t[:, 0], t[:, 1])[:, None], 1e-6)
    return np.stack([t[:, 1], -t[:, 0]], axis=1)


def _signed_area(pts: np.ndarray) -> float:
    x, y = pts[:, 0], pts[:, 1]
    return 0.5 * float(np.sum(x * np.roll(y, -1) - np.roll(x, -1) * y))


def _viterbi_closed(cost: np.ndarray, stiffness: float, max_step: int) -> np.ndarray:
    """Cheapest offset index per sample, for cost [K, M]; neighbours may differ by at most max_step indices.

    The chain is closed, so it is solved on the sequence twice round and the second pass is kept."""
    k_n, m_n = cost.shape
    c2 = np.concatenate([cost, cost]).astype(np.float64)
    pen = stiffness * np.abs(np.arange(-max_step, max_step + 1))
    pad = np.full(m_n + 2 * max_step, 1e9)
    win = sliding_window_view(pad, 2 * max_step + 1)  # win[m, s] = pad[m + s]: a view, so refilling pad refills it
    rows = np.arange(m_n)
    acc = np.empty_like(c2)
    back = np.empty(c2.shape, np.int8)
    acc[0] = c2[0]
    back[0] = 0
    for k in range(1, 2 * k_n):
        pad[max_step : max_step + m_n] = acc[k - 1]
        tot = win + pen
        best = tot.argmin(axis=1)
        acc[k] = tot[rows, best] + c2[k]
        back[k] = best - max_step
    m = int(np.argmin(acc[-1]))
    path = np.empty(2 * k_n, np.int64)
    for k in range(2 * k_n - 1, -1, -1):
        path[k] = m
        m += int(back[k][m])
    return path[k_n:]


# --------------------------------------------------------------------------- appearance models


class _Gauss:
    """A colour model in Lab: mean and regularised covariance."""

    def __init__(self, x: np.ndarray, reg: float = 6.0):
        self.mu = x.mean(0)
        c = np.cov(x.T) + reg * np.eye(3)
        self.inv = np.linalg.inv(c)
        self.logdet = float(np.log(np.linalg.det(c)))

    def logp(self, a: np.ndarray) -> np.ndarray:
        d = a - self.mu
        return -0.5 * (np.einsum("...i,ij,...j->...", d, self.inv, d) + self.logdet)


def _region_models(lab: np.ndarray, mask: np.ndarray, short: int, max_samples: int = 6000):
    """Colour of the surface (its eroded core) and of what surrounds it (a ring around it); None when either is too small."""
    inside = cv2.distanceTransform(mask, cv2.DIST_L2, 3)
    outside = cv2.distanceTransform(1 - mask, cv2.DIST_L2, 3)
    core = inside > max(2.0, 0.02 * short)
    if core.sum() < 50:
        core = mask > 0
    ring = (outside > max(2.0, 0.012 * short)) & (outside <= max(6.0, 0.08 * short))
    if core.sum() < 50 or ring.sum() < 50:
        return None
    rng = np.random.default_rng(0)  # fixed seed: the same photo always gives the same answer

    def draw(sel: np.ndarray) -> np.ndarray:
        idx = np.flatnonzero(sel)
        if idx.size > max_samples:
            idx = idx[rng.integers(0, idx.size, max_samples)]
        return lab.reshape(-1, 3)[idx]

    return _Gauss(draw(core)), _Gauss(draw(ring))


# --------------------------------------------------------------------------- the snap


def snap_mask(ev: Evidence, mask: np.ndarray, sam: np.ndarray | None = None, params: SnapParams = OUTLINE_ONLY, deadline: float | None = None) -> np.ndarray:
    """`mask` (uint8 H x W at photo size) with every boundary slid onto the photo's edges; holes are snapped too.

    A contour that cannot be processed, or any contour once `deadline` (time.perf_counter() seconds) has passed, is kept as it is,
    and a result that has collapsed or exploded is thrown away: snapping may sharpen a mask but never loses the surface."""
    base = (mask > 0).astype(np.uint8)
    m8 = ev.down(base)
    if not m8.any():
        return base
    short = min(ev.wh, ev.ww)
    cnts, hier = cv2.findContours(m8, cv2.RETR_TREE, cv2.CHAIN_APPROX_NONE)
    if not cnts:
        return base
    hier = hier[0]
    depth = []
    for i in range(len(cnts)):
        d, p = 0, hier[i][3]
        while p != -1:
            d, p = d + 1, hier[p][3]
        depth.append(d)
    # the biggest contours get refined; anything else is drawn as it is
    order = sorted(range(len(cnts)), key=lambda k: (depth[k], -cv2.contourArea(cnts[k])))
    refine_ids = set(sorted(range(len(cnts)), key=lambda k: -cv2.contourArea(cnts[k]))[:MAX_CONTOURS])

    sam_dist = None
    if sam is not None:
        s8 = ev.down(sam)
        e = cv2.dilate(s8, np.ones((3, 3), np.uint8)) - cv2.erode(s8, np.ones((3, 3), np.uint8))
        sam_dist = cv2.distanceTransform((e == 0).astype(np.uint8), cv2.DIST_L2, 3)
    models = _region_models(ev.lab, m8, short) if params.region > 0 else None

    reach = max(8, int(round(params.reach * short)))
    offs = np.arange(-reach, reach + 1, dtype=np.float32)
    step = max(2.0, short / 250.0)
    out = np.zeros((ev.h, ev.w), np.uint8)
    for i in order:
        c = cnts[i]
        fill = 1 if depth[i] % 2 == 0 else 0
        poly = c.reshape(-1, 2).astype(np.float64)
        if i in refine_ids and cv2.contourArea(c) >= MIN_AREA and len(c) >= 12 and (deadline is None or time.perf_counter() < deadline):
            try:
                poly = _snap_contour(ev, m8, poly, offs, step, params, models, sam_dist)
            except (cv2.error, ValueError, np.linalg.LinAlgError):
                poly = c.reshape(-1, 2).astype(np.float64)
        cv2.fillPoly(out, [ev.to_photo(poly)], fill)

    a0, a1 = float(base.sum()), float(out.sum())
    if a1 < AREA_RANGE[0] * a0 or a1 > AREA_RANGE[1] * a0:
        return base
    return out


def _snap_contour(ev: Evidence, m8: np.ndarray, pts: np.ndarray, offs: np.ndarray, step: float, p: SnapParams, models, sam_dist) -> np.ndarray:
    """one closed contour (x, y at working resolution) -> the same contour slid onto the evidence."""
    h, w = m8.shape
    length = float(np.hypot(*np.diff(np.vstack([pts, pts[:1]]), axis=0).T).sum())
    pts = _smooth_closed(_resample(pts, max(step, length / MAX_SAMPLES)), 1.5)
    n = _normals(pts)
    if _signed_area(pts) > 0:  # make the normals point away from the shape
        n = -n
    probe = np.clip(np.round(pts + 4 * n).astype(int), 0, [w - 1, h - 1])
    if m8[probe[:, 1], probe[:, 0]].mean() > 0.5:  # (a hole's outward side is the mask's own side)
        n = -n

    q = pts[:, None, :] + offs[None, :, None] * n[:, None, :]  # candidate positions [K, M, 2]
    mx, my = q[..., 0].astype(np.float32), q[..., 1].astype(np.float32)
    on_photo = (mx >= 0) & (mx <= w - 1) & (my >= 0) & (my <= h - 1)

    def sample(dx: np.ndarray, dy: np.ndarray, src: np.ndarray) -> np.ndarray:
        return cv2.remap(src, (mx + dx).astype(np.float32), (my + dy).astype(np.float32), cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)

    nx, ny = n[:, None, 0].astype(np.float32), n[:, None, 1].astype(np.float32)
    ahead = sample(p.arm * nx, p.arm * ny, ev.lab)
    behind = sample(-p.arm * nx, -p.arm * ny, ev.lab)
    gain = p.edge * np.minimum(1.0, np.sqrt(((ahead - behind) ** 2).sum(-1)) / p.edge_scale)
    if models is not None:
        here = sample(0.0, 0.0, ev.lab)
        llr = np.clip(models[0].logp(here) - models[1].logp(here), -4.0, 4.0)
        cum = np.cumsum(llr, axis=1)
        # +: the samples kept (up to the boundary) look like the surface, the samples dropped (beyond it) do not
        gain = gain + p.region * (2.0 * cum - cum[:, -1:]) / (4.0 * len(offs))
    if sam_dist is not None:
        gain = gain + p.sam * np.exp(-((sample(0.0, 0.0, sam_dist) / p.sam_width) ** 2))

    cost = -gain + p.prior * np.abs(offs)[None, :] / offs[-1]
    # beyond the frame there is no photo to look at, but a boundary that gets there simply ends on the frame
    cost = np.where(on_photo, cost, cost - p.frame)
    move = offs[_viterbi_closed(cost, p.stiffness, 3)]
    move = _smooth_closed(move[:, None], 1.0)[:, 0]
    out = pts + move[:, None] * n
    out[:, 0] = np.clip(out[:, 0], 0, w - 1)
    out[:, 1] = np.clip(out[:, 1], 0, h - 1)
    return out
