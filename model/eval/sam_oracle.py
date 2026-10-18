#!/usr/bin/env python3
"""How good is SAM on walls, floors and the like, and how often does it disagree with a rough outline?

Two measurements on the photo set built by ade_subset.py:

  1. Oracle prompts: SAM is prompted (box and points) from the TRUE mask of each surface, so it cannot be misled by a bad
     outline. Whatever it scores here is the ceiling of "SAM corrects the outline"; it is below a very good outline,
     which is why the server blends SAM's answer into the outline's own neighbourhood instead of trusting it.
  2. Refusals: for outlines of growing error, how many does the agreement check refuse (SAM's best mask overlaps the
     outline by less than 0.45 IoU)? Those surfaces get snapped from their outline alone.

    python model/eval/sam_oracle.py --data /path/to/ade_eval [--sam-model facebook/sam2.1-hiera-small] [--limit 20]
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np

MODEL_DIR = Path(__file__).resolve().parent.parent  # the model/ folder, which holds the terucon_model package
sys.path.insert(0, str(MODEL_DIR))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import refine_eval as E  # noqa: E402
from terucon_model.segment import sam_refine  # noqa: E402
from terucon_model.segment.geometry import iou  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    ap.add_argument("--sam-model", default="facebook/sam2.1-hiera-small")
    ap.add_argument("--sigmas", default="0.005,0.012,0.025,0.04", help="outline errors (share of the diagonal) for the refusal count")
    ap.add_argument("--limit", type=int, default=0)
    args = ap.parse_args()

    from terucon_model.sam.backends import HfSamBackend

    backend = HfSamBackend(args.sam_model)
    backend.load()
    cases = sorted(p for p in Path(args.data).iterdir() if p.is_dir())
    if args.limit:
        cases = cases[:: max(1, len(cases) // args.limit)][: args.limit]
    sigmas = [float(s) for s in args.sigmas.split(",")]

    oracle: dict[str, list[tuple[float, float]]] = {}
    refused = {s: [0, 0] for s in sigmas}
    for ci, d in enumerate(cases):
        img, kinds = E.load_case(d)
        inst = E.gt_instances(kinds)
        if not inst:
            continue
        handle = backend.embed(img)
        tol = max(2.0, 0.004 * float(np.hypot(*kinds.shape)))
        truths = [i["mask"] for i in inst]
        for idx, g in enumerate(truths):
            res = sam_refine.refine_one(backend, handle, g, [t.astype(bool) for j, t in enumerate(truths) if j != idx])
            if res.mask is not None:
                pred, truth = E.crop_margin(res.mask), E.crop_margin(g)  # the frame margin is not scored, as in refine_eval.py
                a, b = iou(pred, truth), E.boundary_f1(pred, truth, tol)
            else:
                a, b = 0.0, 0.0  # refused counts as a miss
            oracle.setdefault(inst[idx]["kind"], []).append((a, b))
        for s in sigmas:
            rng = np.random.default_rng(7 + ci * 101 + int(s * 1e5))
            props = [E.simulate_proposal(g, s, rng) for g in truths]
            for idx, p in enumerate(props):
                res = sam_refine.refine_one(backend, handle, p, [q.astype(bool) for j, q in enumerate(props) if j != idx])
                refused[s][0] += res.mask is None
                refused[s][1] += 1
        print(f"  [{ci + 1}/{len(cases)}] {d.name}", file=sys.stderr, flush=True)

    allv = np.array([v for vs in oracle.values() for v in vs])
    print(f"\nSAM prompted from the true masks ({len(allv)} surfaces): mean IoU {allv[:, 0].mean():.3f}, boundary F1 {allv[:, 1].mean():.3f}")
    for k, vs in sorted(oracle.items()):
        v = np.array(vs)
        print(f"  {k:<8} IoU {v[:, 0].mean():.3f}   boundary F1 {v[:, 1].mean():.3f}   (n={len(v)})")
    print("\noutlines refused by the agreement check")
    for s, (r, n) in refused.items():
        print(f"  outline error {s * 100:>4.1f}%   {r:>3} of {n}  ({100 * r / max(1, n):.0f}%)")


if __name__ == "__main__":
    main()
