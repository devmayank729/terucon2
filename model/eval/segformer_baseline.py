#!/usr/bin/env python3
"""The in-browser engine's accuracy on ground truth, and what the old class mapping did to it.

The Design Studio's fallback ("In the browser only") runs SegFormer-B4 trained on ADE20K and then maps its
150 classes onto wall / floor / ceiling / window / door / furniture / other. This script runs the same model
with PyTorch on the same photos used by refine_eval.py and scores it two ways:

  old mapping   building, house, sky, tree, road ... all become "window" (what shipped)
  new mapping   outdoor photos are detected; buildings become Facade (wall), roads and paving become Ground
                (floor), and sky, trees and vehicles are left out

Two numbers come out per photo set: pixel-level IoU per kind (does the mapping put the right pixels in the
right kind?) and per-surface IoU/boundary-F1 against the same ground-truth surfaces refine_eval.py uses, so the
result can be set beside "Gemini outline + edge snapping / SAM".

    python model/eval/segformer_baseline.py --data /path/to/ade_eval

Note: one 512 px pass without the browser's tiling or flips, so the browser engine may be a little better.
The mappings below are ports of the JavaScript that tools/patch_swatchroom.py injected into the Design Studio (now the patches in site/patches/) and of the original export.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

MODEL_DIR = Path(__file__).resolve().parent.parent  # the model/ folder, which holds the terucon_model package
sys.path.insert(0, str(MODEL_DIR))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import refine_eval as E  # noqa: E402

# ---- the original export's mapping (oj in the worker) --------------------------------------------------
WALL = ["wall", "column", "pillar", "partition", "screen"]
FLOOR = ["floor", "flooring", "step", "stage"]
CEILING = ["ceiling"]
WINDOW = ["windowpane", "window", "skylight", "glass"]
OUTDOOR_AS_WINDOW = "sky.tree.building.mountain.grass.sea.field.road.sidewalk.house.skyscraper.hill.palm.water.river.land.earth.sand.rock.fence.car.path.bridge.tower.streetlight.awning".split(".")
CURTAIN = ["curtain", "blind", "shutter", "screen door"]
DOOR = ["door", "double door", "gate"]
FURNITURE = "bed.cabinet.sofa.table.chair.armchair.seat.desk.wardrobe.chest of drawers.counter.countertop.kitchen island.bookcase.shelf.coffee table.ottoman.stool.bench.swivel chair.television receiver.crt screen.monitor.screen.stove.refrigerator.sink.bathtub.toilet.shower.fireplace.buffet.cradle.rug.pool table.piano.case.dishwasher.oven.microwave.hood.washer.bar.booth.stairs.stairway.railing.bannister".split(".")

# ---- additions in the patched worker ---------------------------------------------------------------------
EXT_FACADE = ["building", "house", "skyscraper", "tower", "hovel"]
EXT_GROUND = ["floor", "flooring", "step", "stage", "road", "sidewalk", "path", "earth", "sand", "land", "dirt track", "runway", "pavement", "ground"]
EXT_DROP = ["sky", "tree", "grass", "mountain", "hill", "sea", "water", "river", "lake", "field", "palm", "plant", "flower", "car", "bus", "truck", "van", "boat", "ship", "airplane", "bicycle", "minibike", "person", "animal", "streetlight", "pole", "traffic light", "rock", "waterfall"]
EXT_SEEN = EXT_FACADE + EXT_DROP + ["road", "sidewalk", "path", "earth", "sand", "land", "dirt track", "fence", "car", "bridge"]

K = {"wall": 1, "floor": 2, "ceiling": 3, "window": 4, "door": 5, "other": 6}


def old_kind(name: str) -> str | None:
    n = name.strip().lower()
    if n in WALL:
        return "wall"
    if n in FLOOR:
        return "floor"
    if n in CEILING:
        return "ceiling"
    if n in WINDOW or n in OUTDOOR_AS_WINDOW or n in CURTAIN:
        return "window"
    if n in DOOR:
        return "door"
    return "other"  # furniture and everything else are not scored here


def is_exterior(class_map: np.ndarray, names: list[str]) -> bool:
    total = class_map.size
    counts = np.bincount(class_map.ravel(), minlength=len(names))
    out = ceil = furn = 0
    for i, n in enumerate(names):
        n = n.strip().lower()
        c = int(counts[i])
        if n == "ceiling":
            ceil += c
        elif n in FURNITURE:
            furn += c
        elif n in EXT_SEEN:
            out += c
    return out > total * 0.4 and ceil < total * 0.04 and furn < total * 0.05


def new_kind(name: str, exterior: bool) -> str | None:
    n = name.strip().lower()
    if exterior:
        if n in EXT_FACADE or n == "wall":
            return "wall"
        if n in EXT_GROUND:
            return "floor"
        if n in EXT_DROP:
            return None
    return old_kind(n)


def kind_map(class_map: np.ndarray, names: list[str], mapper) -> np.ndarray:
    lut = np.zeros(len(names), np.uint8)
    for i, n in enumerate(names):
        k = mapper(n)
        lut[i] = K[k] if k else 0
    return lut[class_map]


def gt_merged(kinds: np.ndarray) -> np.ndarray:
    """ADE ground truth in the app's kinds: facade counts as wall, ground as floor."""
    kinds = E.close_small_unlabeled(kinds)
    lut = np.zeros(8, np.uint8)
    lut[1], lut[2], lut[3], lut[4], lut[5], lut[6], lut[7] = K["wall"], K["floor"], K["ceiling"], K["window"], K["door"], K["wall"], K["floor"]
    return lut[kinds]


def segment(img: np.ndarray, model, processor, torch) -> np.ndarray:
    h, w = img.shape[:2]
    s = 512 / min(h, w)
    small = cv2.resize(img, (max(32, round(w * s / 32) * 32), max(32, round(h * s / 32) * 32)), interpolation=cv2.INTER_AREA)
    inputs = processor(images=small, return_tensors="pt", do_resize=False)
    with torch.inference_mode():
        logits = model(**inputs).logits
    up = torch.nn.functional.interpolate(logits, size=(h, w), mode="bilinear", align_corners=False)
    return up.argmax(1)[0].numpy().astype(np.int64)


def match_component(pred_kind: np.ndarray, gt: np.ndarray) -> np.ndarray:
    """The connected piece of the predicted kind that overlaps this ground-truth surface most."""
    n, lab = cv2.connectedComponents(pred_kind.astype(np.uint8), connectivity=4)
    if n <= 1:
        return np.zeros_like(gt, bool)
    ov = np.bincount(lab[gt > 0].ravel(), minlength=n)
    ov[0] = 0
    return lab == int(ov.argmax()) if ov.max() > 0 else np.zeros_like(gt, bool)


def main() -> None:
    import torch
    from transformers import SegformerForSemanticSegmentation, SegformerImageProcessor

    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    ap.add_argument("--model", default="nvidia/segformer-b4-finetuned-ade-512-512")
    args = ap.parse_args()
    cases = sorted(p for p in Path(args.data).iterdir() if p.is_dir())
    processor = SegformerImageProcessor.from_pretrained(args.model)
    model = SegformerForSemanticSegmentation.from_pretrained(args.model).eval()
    torch.set_num_threads(8)
    names = [model.config.id2label[i] for i in range(len(model.config.id2label))]

    acc = {b: {m: {k: [0, 0] for k in K if k != "other"} for m in ("old", "new")} for b in ("interior", "exterior")}
    inst = {b: {m: {"iou": [], "bf1": []} for m in ("old", "new")} for b in ("interior", "exterior")}
    n_ext_detected = {"interior": 0, "exterior": 0}
    n_cases = {"interior": 0, "exterior": 0}
    for ci, d in enumerate(cases):
        bucket = "exterior" if d.name.startswith("exterior") else "interior"
        img, kinds = E.load_case(d)
        cm = segment(img, model, processor, torch)
        ext = is_exterior(cm, names)
        n_cases[bucket] += 1
        n_ext_detected[bucket] += int(ext)
        gt = gt_merged(kinds)
        surfaces = E.gt_instances(kinds)
        h, w = gt.shape
        tol = max(2.0, 0.004 * float(np.hypot(h, w)))
        for which, mapper in (("old", old_kind), ("new", lambda n, e=ext: new_kind(n, e))):
            pk = kind_map(cm, names, mapper)
            pkc, gtc = E.crop_margin(pk), E.crop_margin(gt)  # the frame margin is not scored, as in refine_eval.py
            for k, kid in K.items():
                if k == "other":
                    continue
                inter = int(((pkc == kid) & (gtc == kid)).sum())
                union = int(((pkc == kid) | (gtc == kid)).sum())
                acc[bucket][which][k][0] += inter
                acc[bucket][which][k][1] += union
            for g in surfaces:
                kid = K["wall" if g["kind"] in ("wall", "facade") else "floor" if g["kind"] in ("floor", "ground") else g["kind"]]
                comp = match_component(pk == kid, g["mask"])
                inst[bucket][which]["iou"].append(E.iou(E.crop_margin(comp), E.crop_margin(g["mask"])))
                inst[bucket][which]["bf1"].append(E.boundary_f1(E.crop_margin(comp), E.crop_margin(g["mask"]), tol))
        print(f"[{ci + 1}/{len(cases)}] {d.name}: exterior={ext}", flush=True)

    for bucket in ("exterior", "interior"):
        if not n_cases[bucket]:
            continue
        print(f"\n== {bucket} photos ({n_cases[bucket]}); detected as outdoor: {n_ext_detected[bucket]}")
        print(f"{'pixel IoU per kind':<22}{'old mapping':>14}{'new mapping':>14}")
        for k in ("wall", "floor", "ceiling", "window", "door"):
            o, n = acc[bucket]["old"][k], acc[bucket]["new"][k]
            if o[1] == 0 and n[1] == 0:
                continue
            print(f"{k:<22}{o[0] / max(1, o[1]):>14.3f}{n[0] / max(1, n[1]):>14.3f}")
        for which in ("old", "new"):
            r = inst[bucket][which]
            print(f"per-surface ({which} mapping): mean IoU {np.mean(r['iou']):.3f}, boundary F1 {np.mean(r['bf1']):.3f}  (n={len(r['iou'])})")


if __name__ == "__main__":
    main()
