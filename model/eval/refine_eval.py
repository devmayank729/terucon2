#!/usr/bin/env python3
"""How precise are the surface edges after refinement? Measured on ADE20K ground truth.

For each photo in the subset built by ade_subset.py:
  1. take the true visible surfaces (walls, floors, ceilings, windows, doors, facades),
  2. degrade each into a "model-like" outline, in one of two ways (--noise):
       drift  14-40 points, drifted and jittered by a few percent of the frame
       bias   too fat or too thin by a roughly constant amount, coarse and corner-cutting
  3. run each route and compare with the truth: region IoU and boundary F1 (a boundary pixel is right when it is within
     0.4% of the diagonal of a true one).

    python model/eval/refine_eval.py --data /path/to/ade_eval --methods none,old_watershed,edge_snapping
    python model/eval/refine_eval.py --data /path/to/ade_eval --sam --methods none,old_watershed,edge_snapping,sam_old,sam
    python model/eval/refine_eval.py --data /path/to/ade_eval --sam --noise bias --methods none,edge_snapping,sam

The routes are the server's own (pipeline.sharpen). The outlines are a stand-in for Gemini's, which can't be called here, so
read the table as "how much of a rough outline can each route recover", not as Gemini's own accuracy.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

MODEL_DIR = Path(__file__).resolve().parent.parent  # the model/ folder, which holds the terucon_model package
sys.path.insert(0, str(MODEL_DIR))

from terucon_model.segment import refine  # noqa: E402
from terucon_model.segment.geometry import iou  # noqa: E402

KIND_NAMES = {1: "wall", 2: "floor", 3: "ceiling", 4: "window", 5: "door", 6: "facade", 7: "ground"}
MIN_SHARE = {"wall": 0.012, "floor": 0.012, "ceiling": 0.012, "facade": 0.02, "ground": 0.012, "window": 0.0025, "door": 0.0025}


def load_case(d: Path):
    img = np.array(Image.open(d / "image.jpg").convert("RGB"))
    kinds = np.array(Image.open(d / "kinds.png"))
    return img, kinds


FRAME_MARGIN = 0.01  # share of the short side that is not scored around the photo's frame (see crop_margin)


def crop_margin(m: np.ndarray, frac: float = FRAME_MARGIN) -> np.ndarray:
    """Drop a thin margin around the frame before scoring.

    ADE20K's labels are missing along the frame: in nearly every photo the outermost ring of pixels is unlabelled (only about
    20% of it carries a surface label, against about 69% a few pixels further in), so the true boundary of a surface that runs to
    the frame looks like it sits a few pixels inside it. A mask that correctly reaches the frame then loses boundary recall,
    and one that stops a few pixels short is accidentally rewarded. Scoring the interior removes that."""
    if frac <= 0:
        return m
    k = max(6, int(round(frac * min(m.shape[:2]))))
    return m[k:-k, k:-k]


def close_small_unlabeled(kinds: np.ndarray, max_share: float = 0.012) -> np.ndarray:
    """A lamp, a painting or a sign on a wall is not a hole in the wall: hand small unlabeled
    islands that sit inside one surface back to that surface (windows/doors keep their own pixels)."""
    from terucon_model.segment.geometry import fill_small_holes

    h, w = kinds.shape
    out = kinds.copy()
    for kid in (1, 2, 3, 6, 7):
        m = (kinds == kid).astype(np.uint8)
        if not m.any():
            continue
        filled = fill_small_holes(m, int(max_share * h * w)) > 0
        out[filled & (out == 0)] = kid
    return out


def gt_instances(kinds: np.ndarray, max_instances: int = 8) -> list[dict]:
    h, w = kinds.shape
    kinds = close_small_unlabeled(kinds)
    out = []
    for kid, kname in KIND_NAMES.items():
        m = (kinds == kid).astype(np.uint8)
        if not m.any():
            continue
        n, lab, stats, _ = cv2.connectedComponentsWithStats(m, connectivity=4)
        for i in range(1, n):
            share = stats[i, cv2.CC_STAT_AREA] / (h * w)
            if share >= MIN_SHARE[kname]:
                out.append({"kind": kname, "mask": (lab == i).astype(np.uint8), "share": float(share)})
    out.sort(key=lambda d: -d["share"])
    return out[:max_instances]


def simulate_proposal(mask: np.ndarray, sigma_frac: float, rng: np.random.Generator) -> np.ndarray:
    """A rough, model-like outline of `mask`: simplified polygon + smooth drift + vertex jitter."""
    h, w = mask.shape
    diag = float(np.hypot(h, w))
    amp = sigma_frac * diag
    cnts, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    out = np.zeros((h, w), np.uint8)
    if not cnts:
        return out
    biggest = max(cv2.contourArea(c) for c in cnts)
    # a few low-frequency waves give a drift that is smooth along the outline (like a model's bias)
    waves = [(rng.uniform(0.6, 2.5) / diag * 2 * np.pi, rng.uniform(0, 2 * np.pi), rng.uniform(0, 2 * np.pi), rng.normal(size=2)) for _ in range(4)]

    def drift(x: float, y: float) -> np.ndarray:
        v = np.zeros(2)
        for f, a, b, vec in waves:
            v += vec * np.sin(f * (x * np.cos(a) + y * np.sin(a)) + b)
        return v / 2.0 * amp

    for c in cnts:
        if cv2.contourArea(c) < max(25.0, 0.03 * biggest):
            continue
        target = int(rng.integers(14, 41))
        eps = 0.5
        approx = c
        for _ in range(18):
            approx = cv2.approxPolyDP(c, eps, True)
            if len(approx) <= target:
                break
            eps *= 1.35
        pts = approx.reshape(-1, 2).astype(np.float64)
        moved = []
        for x, y in pts:
            d = drift(x, y) + rng.normal(scale=0.3 * amp, size=2)
            moved.append([x + d[0], y + d[1]])
        pts_q = np.array(moved)
        # polygons are quantised to a 0-1000 grid, like the prompt asks the model for
        pts_q[:, 0] = np.round(pts_q[:, 0] / w * 1000) / 1000 * w
        pts_q[:, 1] = np.round(pts_q[:, 1] / h * 1000) / 1000 * h
        cv2.fillPoly(out, [np.round(pts_q).astype(np.int32)], 1)
    return out


# (offset range as a share of the short side, polygon simplification as a share of the diagonal)
BIAS_LEVELS = {1: ((0.003, 0.010), (0.004, 0.008)), 2: ((0.010, 0.020), (0.008, 0.014)), 3: ((0.020, 0.040), (0.012, 0.025))}


def simulate_biased_proposal(mask: np.ndarray, level: int, rng: np.random.Generator) -> np.ndarray:
    """A second kind of rough outline, to check that a gain is not an artefact of simulate_proposal's drift and jitter.

    A language model tends to trace a surface too fat or too thin by a roughly constant amount and with few, coarse
    points that cut its corners. Here: dilate or erode the true surface by 0.3-4% of the short side, then simplify the
    outline hard (0.4-2.5% of the diagonal) and quantise it to the 0-1000 grid. Levels 1 to 3 get rougher."""
    h, w = mask.shape
    (k_lo, k_hi), (e_lo, e_hi) = BIAS_LEVELS[level]
    k = max(1, int(round(rng.uniform(k_lo, k_hi) * min(h, w))))
    ker = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * k + 1, 2 * k + 1))
    m = cv2.dilate(mask, ker) if rng.random() < 0.5 else cv2.erode(mask, ker)
    if m.sum() < 0.3 * mask.sum():
        m = mask
    cnts, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    out = np.zeros_like(mask)
    if cnts:
        biggest = max(cv2.contourArea(c) for c in cnts)
        for c in cnts:
            if cv2.contourArea(c) < max(25.0, 0.03 * biggest):
                continue
            pts = cv2.approxPolyDP(c, rng.uniform(e_lo, e_hi) * float(np.hypot(h, w)), True).reshape(-1, 2).astype(np.float64)
            if len(pts) < 3:
                continue
            pts[:, 0] = np.round(pts[:, 0] / w * 1000) / 1000 * w
            pts[:, 1] = np.round(pts[:, 1] / h * 1000) / 1000 * h
            cv2.fillPoly(out, [np.round(pts).astype(np.int32)], 1)
    return out if out.sum() else mask.copy()


def boundary_f1(pred: np.ndarray, gt: np.ndarray, tol: float) -> float:
    def edge(m):
        m = m.astype(np.uint8)
        return (cv2.dilate(m, np.ones((3, 3), np.uint8)) - cv2.erode(m, np.ones((3, 3), np.uint8))) > 0

    ep, eg = edge(pred), edge(gt)
    if not ep.any() or not eg.any():
        return 0.0
    d_to_gt = cv2.distanceTransform((~eg).astype(np.uint8), cv2.DIST_L2, 3)
    d_to_pred = cv2.distanceTransform((~ep).astype(np.uint8), cv2.DIST_L2, 3)
    precision = float((d_to_gt[ep] <= tol).mean())
    recall = float((d_to_pred[eg] <= tol).mean())
    return 0.0 if precision + recall == 0 else 2 * precision * recall / (precision + recall)


PRODUCTION_KIND = {"facade": "wall", "ground": "floor"}  # the ground-truth kinds the server calls wall / floor


def _legacy(fn):
    """The research snappers in refine.METHODS take (img, layered labels); give them the same signature as the shipped routes."""
    return lambda img, props, kinds: refine.clean_labels(fn(img, refine.paint(props)))


def evaluate(cases: list[Path], methods: list[str], sigmas: list[float], seed: int = 7, verbose: bool = False, extra: dict | None = None, noise: str = "drift", margin: float = FRAME_MARGIN):
    """Every method is called as method(img, outlines, kinds) -> label map where outline i is label i + 1.

    noise="drift": `sigmas` are outline errors as a share of the diagonal (simulate_proposal).
    noise="bias":  `sigmas` are the levels 1-3 of simulate_biased_proposal."""
    results: dict = {}
    methods_fn = {name: _legacy(fn) for name, fn in refine.METHODS.items()}
    if extra:
        methods_fn.update(extra)
    for ci, d in enumerate(cases):
        img, kinds = load_case(d)
        inst = gt_instances(kinds)
        if not inst:
            continue
        h, w = kinds.shape
        tol = max(2.0, 0.004 * float(np.hypot(h, w)))
        pkinds = [PRODUCTION_KIND.get(i["kind"], i["kind"]) for i in inst]
        for sigma in sigmas:
            if noise == "bias":
                rng = np.random.default_rng(1234 + ci * 101 + int(sigma))
                props = [simulate_biased_proposal(i["mask"], int(sigma), rng) for i in inst]
            else:
                rng = np.random.default_rng(seed + ci * 101 + int(sigma * 1e5))
                props = [simulate_proposal(i["mask"], sigma, rng) if sigma > 0 else i["mask"].copy() for i in inst]
            for method in methods:
                t0 = time.time()
                labels = methods_fn[method](img, props, pkinds)
                dt = time.time() - t0
                key = (method, sigma)
                bucket = results.setdefault(key, {"iou": [], "bf1": [], "photo": [], "sec": [], "by_kind": {}})
                for idx, g in enumerate(inst):
                    pred = crop_margin(labels == (idx + 1), margin)
                    truth = crop_margin(g["mask"], margin)
                    v_iou = iou(pred, truth)
                    v_bf = boundary_f1(pred, truth, tol)
                    bucket["iou"].append(v_iou)
                    bucket["bf1"].append(v_bf)
                    bucket["photo"].append(ci)
                    k = bucket["by_kind"].setdefault(g["kind"], {"iou": [], "bf1": []})
                    k["iou"].append(v_iou)
                    k["bf1"].append(v_bf)
                bucket["sec"].append(dt)
        if verbose:
            print(f"  [{ci + 1}/{len(cases)}] {d.name}: {len(inst)} surfaces", flush=True)
    return results


def noise_label(sigma: float, noise: str) -> str:
    return f"bias {int(sigma)}" if noise == "bias" else f"{sigma * 100:.1f}%"


def summarize(results: dict, methods: list[str], sigmas: list[float], noise: str = "drift") -> str:
    lines = [f"{'method':<22}{'noise':>8}{'mean IoU':>10}{'boundary F1':>13}{'sec/img':>9}   n"]
    for sigma in sigmas:
        for m in methods:
            r = results.get((m, sigma))
            if not r:
                continue
            lines.append(f"{m:<22}{noise_label(sigma, noise):>8}{np.mean(r['iou']):>10.3f}{np.mean(r['bf1']):>13.3f}{np.mean(r['sec']):>9.2f}   {len(r['iou'])}")
        lines.append("")
    return "\n".join(lines)


def paired_change(ref: dict, other: dict, boot: int = 1000, seed: int = 0):
    """mean(other - ref) for IoU and boundary F1 over the same surfaces, with a 95% interval from resampling whole photos
    (surfaces of one photo are not independent). Returns ((iou, lo, hi), (bf1, lo, hi))."""
    photos = np.array(ref["photo"])
    out = []
    for key in ("iou", "bf1"):
        d = np.array(other[key]) - np.array(ref[key])
        ids, inv = np.unique(photos, return_inverse=True)
        total = np.bincount(inv, weights=d, minlength=len(ids))
        count = np.bincount(inv, minlength=len(ids)).astype(float)
        rng = np.random.default_rng(seed)
        picks = rng.integers(0, len(ids), size=(boot, len(ids)))
        means = total[picks].sum(1) / count[picks].sum(1)
        lo, hi = np.percentile(means, [2.5, 97.5])
        out.append((float(d.mean()), float(lo), float(hi)))
    return out[0], out[1]


def paired_report(results: dict, methods: list[str], sigmas: list[float], ref: str, noise: str) -> str:
    lines = [f"change against {ref}: mean difference over the same surfaces, [95% interval, resampling photos]"]
    for sigma in sigmas:
        lines.append(f"\noutline error {noise_label(sigma, noise)}{'IoU':>24}{'boundary F1':>26}")
        for m in methods:
            if m == ref or (m, sigma) not in results or (ref, sigma) not in results:
                continue
            (a, alo, ahi), (b, blo, bhi) = paired_change(results[(ref, sigma)], results[(m, sigma)])
            lines.append(f"  {m:<20}{a:+8.3f} [{alo:+.3f}, {ahi:+.3f}]   {b:+8.3f} [{blo:+.3f}, {bhi:+.3f}]")
    return "\n".join(lines)


def production_methods(with_sam: bool, sam_model: str = "facebook/sam2.1-hiera-small") -> dict:
    """The routes the server ships, called through pipeline.sharpen, the very function /segment calls.

    none            the outlines as drawn (layered the way the server layers them)
    edge_snapping   no SAM: every outline's boundary slid onto the photo's edges (contour snapping, the default)
    old_watershed   no SAM: the marker watershed that contour snapping replaced (EDGE_METHOD=watershed)
    sam             SAM on: SAM's correction, then contour snapping (surfaces SAM refuses are snapped from their outline)
    sam_old         SAM on, the earlier version: SAM's correction, then nothing (a watershed only if SAM kept no outline)
    """
    from terucon_model.segment import pipeline

    def outlines(props, kinds):
        return [pipeline.Outline(k, k, p) for p, k in zip(props, kinds)]

    def route(manager, **kw):
        return lambda img, props, kinds: pipeline.sharpen(img, outlines(props, kinds), manager, **kw).labels

    methods = {
        "none": route(None, use_sam=False, edge_refine=False),
        "edge_snapping": route(None, use_sam=False, edge_refine=True),
        "old_watershed": route(None, use_sam=False, edge_refine=True, edge_method="watershed"),
    }
    if with_sam:
        from terucon_model.config import SamConfig
        from terucon_model.sam.backends import HfSamBackend
        from terucon_model.sam.manager import SamManager

        manager = SamManager(SamConfig(enabled=True, preload=False, backend="sam2", model_id=sam_model), backend_factory=lambda c: HfSamBackend(c.model_id))
        manager._load()  # synchronous: the eval wants to fail loudly if SAM cannot start
        if not manager.ready:
            raise SystemExit(f"SAM did not start: {manager.status()['error']}")
        methods["sam"] = route(manager, use_sam=True, edge_refine=True)
        methods["sam_old"] = route(manager, use_sam=True, edge_refine=True, edge_method="watershed")
    return methods


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    ap.add_argument("--methods", default="none,edge_snapping")
    ap.add_argument("--sam", action="store_true", help="also evaluate SAM (needs torch + transformers)")
    ap.add_argument("--sam-model", default="facebook/sam2.1-hiera-small", help="the SAM checkpoint to evaluate")
    ap.add_argument("--noise", choices=["drift", "bias"], default="drift", help="drift: random drift and jitter of the true outline; bias: systematically too fat or too thin, coarse and corner-cutting")
    ap.add_argument("--sigmas", default=None, help="outline errors as a share of the diagonal (drift; default 0,0.005,0.012,0.025,0.04) or levels (bias; default 1,2,3)")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--bucket", choices=["all", "interior", "exterior"], default="all")
    ap.add_argument("--frame-margin", type=float, default=FRAME_MARGIN, help="share of the short side around the frame that is not scored (ADE20K labels are missing there); 0 scores everything")
    ap.add_argument("--json", default="")
    ap.add_argument("--ref", default="", help="also print every method's paired change against this one (e.g. old_watershed) with a 95%% interval")
    ap.add_argument("--per-surface", default="", help="write every surface's IoU and boundary F1 to this JSON file")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args()
    cases = sorted(p for p in Path(args.data).iterdir() if p.is_dir())
    if args.bucket != "all":
        cases = [c for c in cases if c.name.startswith(args.bucket)]
    if args.limit:
        step = max(1, len(cases) // args.limit)
        cases = cases[::step][: args.limit]
    methods = args.methods.split(",")
    sigmas = [float(s) for s in (args.sigmas or ("1,2,3" if args.noise == "bias" else "0,0.005,0.012,0.025,0.04")).split(",")]
    prod = production_methods(args.sam, args.sam_model)
    if args.sam and "sam" not in methods:
        methods.append("sam")
    unknown = [m for m in methods if m not in prod and m not in refine.METHODS]
    if unknown:
        raise SystemExit(f"unknown method(s) {unknown}; try none, edge_snapping, old_watershed, sam, sam_old, watershed, guided, grabcut (sam needs --sam)")
    if args.frame_margin > 0:
        print(f"scoring: {max(6, round(args.frame_margin * 768))} px around the frame are not scored at 768 px short side (ADE20K labels are missing there; --frame-margin 0 scores everything)\n")
    res = evaluate(cases, methods, sigmas, verbose=args.verbose, extra=prod, noise=args.noise, margin=args.frame_margin)
    print(summarize(res, methods, sigmas, args.noise))
    if args.ref:
        if args.ref not in methods:
            raise SystemExit(f"--ref {args.ref} must be one of --methods")
        print("\n" + paired_report(res, methods, sigmas, args.ref, args.noise))
    kinds = sorted({k for r in res.values() for k in r["by_kind"]})
    for sg in sigmas:
        print(f"\nby surface type, outline error {noise_label(sg, args.noise)}  (mean IoU / boundary F1)")
        print(f"{'':<10}" + "".join(f"{m:>20}" for m in methods))
        for k in kinds:
            row = f"{k:<10}"
            for m in methods:
                b = res[(m, sg)]["by_kind"].get(k)
                row += (f"{np.mean(b['iou']):.3f} / {np.mean(b['bf1']):.3f} ({len(b['iou'])})" if b else "-").rjust(20)
            print(row)
    if args.per_surface:
        Path(args.per_surface).write_text(json.dumps({f"{m}|{sg}": {"iou": r["iou"], "bf1": r["bf1"], "photo": r["photo"]} for (m, sg), r in res.items()}))
    if args.json:
        Path(args.json).write_text(json.dumps({f"{m}|{s}": {"iou": float(np.mean(r["iou"])), "bf1": float(np.mean(r["bf1"])), "n": len(r["iou"])} for (m, s), r in res.items()}, indent=1))


if __name__ == "__main__":
    main()
