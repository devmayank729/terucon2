"""Use SAM to snap a rough surface outline onto the surface's real boundary.

A language model is good at *which* surface and roughly *where*; SAM is good at the exact edge.
For each proposal we prompt SAM with a box around the outline plus a few points that are
certainly inside it (and, where another surface sits inside the box, points that are certainly not),
then keep the candidate mask that agrees best with the proposal. SAM's own confidence is only a
tie-breaker: on a floor it will happily score a half-floor higher than the whole floor.
"""
from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np

from .geometry import bbox, core_points, iou


@dataclass
class SamResult:
    mask: np.ndarray | None  # bool H x W, or None when SAM did not agree with the proposal
    agreement: float  # IoU with the proposal
    sam_score: float


def _expand(box: tuple[int, int, int, int], margin: int, h: int, w: int) -> list[float]:
    x0, y0, x1, y1 = box
    return [max(0, x0 - margin), max(0, y0 - margin), min(w - 1, x1 + margin), min(h - 1, y1 + margin)]


def refine_one(
    backend,
    handle,
    proposal: np.ndarray,
    others: list[np.ndarray] | None = None,
    min_agreement: float = 0.45,
    margin_frac: float = 0.015,
    positive_points: int = 3,
    negative_points: int = 2,
) -> SamResult:
    h, w = proposal.shape
    bb = bbox(proposal)
    if bb is None:
        return SamResult(None, 0.0, 0.0)
    margin = max(2, int(round(margin_frac * max(h, w))))
    box = _expand(bb, margin, h, w)

    eroded = cv2.erode(proposal.astype(np.uint8), cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * margin + 1, 2 * margin + 1)))
    pos = core_points(eroded if eroded.any() else proposal, positive_points)
    neg: list[tuple[float, float]] = []
    for other in others or []:
        # another surface mostly *inside* this one's box and mostly outside this proposal: say "not this"
        inside = other[int(box[1]) : int(box[3]) + 1, int(box[0]) : int(box[2]) + 1]
        if inside.sum() < 0.6 * other.sum():
            continue
        if (other & proposal.astype(bool)).sum() > 0.5 * other.sum():
            continue
        neg += core_points(other, 1)
        if len(neg) >= negative_points:
            break
    pts = [(float(x), float(y)) for x, y in pos] + [(float(x), float(y)) for x, y in neg]
    labels = [1] * len(pos) + [0] * len(neg)

    cands = backend.predict(handle, box=box, points=pts or None, labels=labels or None, multimask=True)
    best, best_val, best_iou, best_score = None, -1.0, 0.0, 0.0
    for c in cands:
        a = iou(c.mask, proposal)
        val = a + 0.15 * c.score
        if val > best_val:
            best, best_val, best_iou, best_score = c, val, a, c.score
    if best is None or best_iou < min_agreement:
        return SamResult(None, best_iou, best_score)
    return SamResult(best.mask.astype(bool), best_iou, best_score)


# What to ask a text-prompted SAM (SAM 3) for, per kind. SAM 3 answers with every instance of the concept.
CONCEPT = {
    "wall": "wall", "floor": "floor", "ceiling": "ceiling", "window": "window", "door": "door",
    "furniture": "furniture", "other": "object",
}


def refine_all_text(backend, handle, proposals: list[np.ndarray], kinds: list[str], min_agreement: float = 0.45, threshold: float = 0.2) -> list[SamResult]:
    """Text-prompted SAM (SAM 3): ask once per kind for every instance, then give each outline the
    instance that agrees with it best. Same safeguard as the box route: no agreement, no change."""
    wanted = sorted({CONCEPT.get(k, "object") for k in kinds})
    found: dict[str, list[dict]] = {}
    for concept in wanted:
        found[concept] = backend.segment_text(handle, [concept], threshold, 12)
    results = []
    for p, kind in zip(proposals, kinds):
        best, best_iou, best_score = None, 0.0, 0.0
        for det in found.get(CONCEPT.get(kind, "object"), []):
            a = iou(det["mask"], p)
            if a > best_iou:
                best, best_iou, best_score = det, a, float(det.get("score", 0.0))
        results.append(SamResult(best["mask"].astype(bool), best_iou, best_score) if best is not None and best_iou >= min_agreement else SamResult(None, best_iou, best_score))
    return results


def refine_all(backend, handle, proposals: list[np.ndarray], kinds: list[str] | None = None, **kw) -> list[SamResult]:
    """Pick the route the backend supports: boxes and points (SAM 2, SAM 1, a remote refine endpoint) or text (SAM 3)."""
    if not getattr(backend, "interactive", True) and getattr(backend, "text_prompts", False) and kinds is not None:
        return refine_all_text(backend, handle, proposals, kinds)
    bool_props = [p.astype(bool) for p in proposals]
    results = []
    for i, p in enumerate(proposals):
        others = [bool_props[j] for j in range(len(proposals)) if j != i]
        results.append(refine_one(backend, handle, p, others, **kw))
    return results


def band_blend(proposal: np.ndarray, sam_mask: np.ndarray, band_frac: float, shape_hw: tuple[int, int]) -> np.ndarray:
    """Trust the proposal away from its edge and SAM near it: SAM may move the boundary, never invent a new region."""
    h, w = shape_hw
    r = max(2, int(round(band_frac * min(h, w))))
    p = proposal.astype(np.uint8)
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * r + 1, 2 * r + 1))
    band = cv2.dilate(p, k) - cv2.erode(p, k) > 0
    return np.where(band, sam_mask, proposal.astype(bool))
