"""Photo in, labelled surfaces out.

    1. Gemini names the surfaces and outlines them roughly (detect.py).
    2. If SAM is running, each outline is corrected by SAM, but only near the outline's own edge
       (sam_refine.band_blend), so SAM can fix the boundary and cannot wander off.
    3. Every surface's boundaries, outer ones and holes, are then slid onto the photo's real edges by contour
       snapping (snap.py), with SAM's boundary as extra evidence when there is one. Surfaces SAM did not agree
       with get the same snapping from their outline alone, so SAM can be off or partly unsure and nothing is left raw.
    4. Surfaces are layered (structure below, windows and doors above, furniture on top) and cleaned.

EDGE_METHOD=watershed (edge_method="watershed" here) restores the marker watershed that step 3 replaced.
Measured on ADE20K ground truth with model-like outlines (model/eval/refine_eval.py); see README.
"""
from __future__ import annotations

import base64
import hashlib
import logging
import time
import zlib
from dataclasses import dataclass, field
from typing import Any

import numpy as np

from ..config import Settings
from ..google_auth import GoogleAuth
from . import refine, sam_refine, snap
from .detect import Detection, detect_surfaces
from .geometry import polygon_to_mask

log = logging.getLogger("terucon")

TIER = {"ceiling": 0, "floor": 0, "wall": 0, "window": 1, "door": 1, "other": 2, "furniture": 3}
MIN_SOURCE_SHARE = 0.0015  # ignore outlines smaller than this share of the frame
MIN_VISIBLE_SHARE = 0.0025  # drop surfaces that end up with less than this share visible
BAND_FRAC = 0.025  # how far from its own outline SAM may move a boundary (share of the short side)
WATERSHED_CORE = 0.018  # seed erosion of the watershed method (share of the short side)
SNAP_BUDGET = 8.0  # seconds of contour snapping per photo; surfaces it does not reach keep the boundary they have


@dataclass
class SegmentOptions:
    use_sam: bool = True
    edge_refine: bool = True
    edge_method: str = "contour"  # contour | watershed
    model: str | None = None
    location: str | None = None
    hint: str = ""


@dataclass
class SegmentResult:
    labels: np.ndarray  # int32 H x W, 0 = not a surface
    metas: list[dict[str, Any]]
    scene: str
    model: str
    engine: str
    notes: list[str] = field(default_factory=list)  # problems worth showing: a fallback happened, a model was skipped
    hints: list[str] = field(default_factory=list)  # routine facts ("SAM snapped 8 of 8 outlines")
    timings: dict[str, float] = field(default_factory=dict)
    sam_image_id: str = ""
    sam_used: bool = False

    @property
    def height(self) -> int:
        return int(self.labels.shape[0])

    @property
    def width(self) -> int:
        return int(self.labels.shape[1])


@dataclass
class Outline:
    """One surface to sharpen: what it is, and a rough mask of where the detector says it is."""

    label: str
    kind: str
    mask: np.ndarray  # uint8 H x W


@dataclass
class Sharpened:
    labels: np.ndarray  # int32 H x W; outline i (0-based) is label i + 1, 0 = no surface
    by_sam: list[bool]  # per outline: SAM moved its boundary
    snapped: list[bool]  # per outline: its boundary was aligned with the photo's edges
    sam_used: bool
    sam_image: str = ""
    notes: list[str] = field(default_factory=list)
    hints: list[str] = field(default_factory=list)
    timings: dict[str, float] = field(default_factory=dict)


def image_id(rgb: np.ndarray) -> str:
    return hashlib.sha1(rgb.tobytes()).hexdigest()[:20]


def encode_labels(labels: np.ndarray) -> dict[str, Any]:
    """zlib-compressed bytes, one byte per pixel (two when there are more than 255 surfaces)."""
    big = int(labels.max()) > 255
    arr = labels.astype("<u2" if big else "u1")
    return {"encoding": "zlib-u16le" if big else "zlib-u8", "data": base64.b64encode(zlib.compress(arr.tobytes(), 6)).decode("ascii")}


def sharpen(rgb: np.ndarray, outlines: list[Outline], sam: Any = None, use_sam: bool = True, edge_refine: bool = True, edge_method: str = "contour") -> Sharpened:
    """The precision stage: rough outlines in, one clean label map out.

    The server calls this with Gemini's outlines and model/eval/refine_eval.py calls it with simulated ones,
    so the numbers in the README are measured on exactly the code that ships.
    """
    h, w = rgb.shape[:2]
    items = [{"kind": o.kind, "outline": o.mask, "mask": o.mask} for o in outlines]
    timings: dict[str, float] = {}
    notes: list[str] = []
    hints: list[str] = []

    sam_used = False
    sam_image = ""
    ready = bool(use_sam and sam is not None and sam.ready)
    if ready:
        try:
            t = time.perf_counter()
            sam_image, handle = sam.embed_cached(rgb)
            results = sam.run(lambda backend: sam_refine.refine_all(backend, handle, [it["outline"] for it in items], [it["kind"] for it in items]))
            kept = 0
            for it, res in zip(items, results):
                if res.mask is not None:
                    it["mask"] = sam_refine.band_blend(it["outline"], res.mask, BAND_FRAC, (h, w)).astype(np.uint8)
                    it["sam_mask"] = res.mask
                    it["sam"] = True
                    kept += 1
            sam_used = kept > 0
            timings["sam"] = round(time.perf_counter() - t, 2)
            if kept:
                hints.append(f"{sam.label} snapped {kept} of {len(items)} outlines to the photo's edges.")
            else:
                notes.append(f"{sam.label} did not agree with Gemini's outlines, so they were used as drawn.")
        except Exception as exc:  # noqa: BLE001 - SAM must never take the whole scan down
            notes.append(f"SAM could not refine the outlines ({str(exc)[:120]}); edge snapping was used instead.")
            ready = False
            for it in items:  # whatever SAM did before it failed is not trusted
                it.pop("sam", None)
                it.pop("sam_mask", None)
                it["mask"] = it["outline"]
            sam_used = False

    # ---- align every boundary with the photo's edges
    snapped = [False] * len(items)
    legacy = edge_method == "watershed"
    if edge_refine and not legacy:
        t = time.perf_counter()
        skipped = 0
        try:
            evidence: snap.Evidence | None = snap.Evidence(rgb)
        except Exception as exc:  # noqa: BLE001 - snapping must never take the whole scan down
            log.warning("edge snapping could not start: %s", str(exc)[:200])
            evidence = None
        deadline = t + SNAP_BUDGET
        for i, it in enumerate(items):
            if evidence is None or time.perf_counter() > deadline:
                skipped += 1
                continue
            try:
                if it.get("sam"):
                    it["mask"] = snap.snap_mask(evidence, it["mask"], it["sam_mask"], snap.WITH_SAM, deadline)
                else:
                    it["mask"] = snap.snap_mask(evidence, it["mask"], None, snap.OUTLINE_ONLY, deadline)
                snapped[i] = True
            except Exception as exc:  # noqa: BLE001
                log.warning("edge snapping failed for one outline: %s", str(exc)[:200])
                skipped += 1
        timings["edges"] = round(time.perf_counter() - t, 2)
        if skipped:
            notes.append(f"Edge snapping was skipped for {skipped} of {len(items)} outlines (out of time, or an error); they were used as drawn.")
        if any(snapped) and not ready and not (use_sam and sam is not None):
            hints.append("Outlines were snapped to the photo's edges (SAM is off).")

    # ---- layering
    order = sorted(range(len(items)), key=lambda i: (TIER.get(items[i]["kind"], 2), -int(items[i]["mask"].sum())))
    layered = refine.paint([it["mask"] for it in items], order)
    if legacy and edge_refine and not sam_used:
        t = time.perf_counter()
        layered = refine.snap_watershed(rgb, layered, core_frac=WATERSHED_CORE)
        timings["edges"] = round(time.perf_counter() - t, 2)
        snapped = [True] * len(items)
        if not ready and not (use_sam and sam is not None):
            hints.append("Outlines were snapped to the photo's edges (SAM is off).")
    labels = refine.clean_labels(layered)
    return Sharpened(labels, [bool(it.get("sam")) for it in items], snapped, sam_used, sam_image if ready else "", notes, hints, timings)


def segment_image(settings: Settings, auth: GoogleAuth, sam: Any, rgb: np.ndarray, options: SegmentOptions | None = None) -> SegmentResult:
    opts = options or SegmentOptions()
    h, w = rgb.shape[:2]
    notes: list[str] = []

    t = time.perf_counter()
    det: Detection = detect_surfaces(settings, auth, rgb, model=opts.model, location=opts.location, hint=opts.hint)
    gemini_seconds = round(time.perf_counter() - t, 2)
    notes += det.notes

    # outlines -> masks (+ drop specks)
    outlines: list[Outline] = []
    for p in det.proposals:
        mask = polygon_to_mask(p.polygon, h, w)
        if mask.sum() < MIN_SOURCE_SHARE * h * w:
            continue
        outlines.append(Outline(p.label, p.kind, mask))
    if not outlines:
        raise ValueError("Gemini's outlines were too small to use.")

    sharp = sharpen(rgb, outlines, sam, opts.use_sam, opts.edge_refine, opts.edge_method)
    notes += sharp.notes
    labels, sam_used = sharp.labels, sharp.sam_used

    # ---- keep the surfaces that survived, numbered 1..N
    areas = np.bincount(labels.ravel(), minlength=len(outlines) + 1)
    metas: list[dict[str, Any]] = []
    remap = np.zeros(len(outlines) + 1, np.int32)
    for i, o in enumerate(outlines, start=1):
        if areas[i] < MIN_VISIBLE_SHARE * h * w:
            continue
        idx = len(metas) + 1
        remap[i] = idx
        source = "gemini" + ("+sam" if sharp.by_sam[i - 1] else "+edges" if sharp.snapped[i - 1] else "")
        metas.append({"index": idx, "label": o.label, "kind": o.kind, "source": source, "share": round(float(areas[i]) / (h * w), 4)})
    labels = remap[labels]
    if not metas:
        raise ValueError("No surface was large enough to keep.")

    engine_label = f"{det.model} + {sam.label}" if sam_used else (f"{det.model} + edge snapping" if opts.edge_refine else det.model)
    return SegmentResult(labels, metas, det.scene, det.model, engine_label, notes, sharp.hints, {"gemini": gemini_seconds, **sharp.timings}, sharp.sam_image, sam_used)
