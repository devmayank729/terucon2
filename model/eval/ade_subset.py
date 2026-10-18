#!/usr/bin/env python3
"""Build a small ground-truth set for the Design Studio's segmentation from ADE20K (validation).

ADE20K is the dataset the SegFormer scene model was trained on, and its validation images have
exact per-pixel labels, so it is a fair yardstick for "does the studio find the right surfaces".

    python model/eval/ade_subset.py --parquet validation-0000.parquet --out /path/to/ade_eval

Get the parquet shard (183 MB, 1000 images) with:
    curl -L -o validation-0000.parquet \
      "https://huggingface.co/datasets/uva-cv-lab/ADE20k-150/resolve/refs%2Fconvert%2Fparquet/default/validation/0000.parquet"

Needs pyarrow (pip install pyarrow). Writes image.jpg + classes.png (+ index.json) per picked photo;
nothing is written inside the repo unless you point --out there.
"""
from __future__ import annotations

import argparse
import io
import json
from pathlib import Path

import numpy as np
from PIL import Image

# --- ground-truth kinds (what a person would call each surface) ------------------------
WALL = {"wall", "column", "pillar", "partition"}
FLOOR = {"floor", "flooring", "step", "stage"}
CEILING = {"ceiling"}
WINDOW = {"windowpane", "window", "skylight"}
DOOR = {"door", "double door", "gate"}
FACADE = {"building", "house", "skyscraper", "tower"}  # a building's outer wall, seen from outside
GROUND = {"road", "sidewalk", "path", "pavement", "earth", "ground"}  # what you walk or drive on, outside
CONTEXT = {"sky", "tree", "grass", "mountain", "hill", "sea", "water", "river", "field", "plant", "car", "person", "palm"}


def first_name(full: str) -> str:
    return full.split(",")[0].strip().lower()


def gt_kind(full_name: str) -> str | None:
    """wall | floor | ceiling | window | door | facade | ground | None (not a surface we evaluate)."""
    n = first_name(full_name)
    if n in WALL:
        return "wall"
    if n in FLOOR:
        return "floor"
    if n in CEILING:
        return "ceiling"
    if n in WINDOW:
        return "window"
    if n in DOOR:
        return "door"
    if n in FACADE:
        return "facade"
    if n in GROUND:
        return "ground"
    return None


KIND_ID = {"wall": 1, "floor": 2, "ceiling": 3, "window": 4, "door": 5, "facade": 6, "ground": 7}


def decode_classes(seg_png: bytes) -> np.ndarray:
    a = np.array(Image.open(io.BytesIO(seg_png)).convert("RGB")).astype(np.int32)
    return (a[..., 0] // 10) * 256 + a[..., 1]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--parquet", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--exterior", type=int, default=30)
    ap.add_argument("--interior", type=int, default=30)
    ap.add_argument("--max-side", type=int, default=1024)
    ap.add_argument("--min-side", type=int, default=480, help="skip thumbnails")
    ap.add_argument("--skip", type=int, default=0, help="skip this many qualifying photos per bucket first (builds a held-out set)")
    args = ap.parse_args()
    import pyarrow.parquet as pq  # after the arguments are parsed, so that --help works without pyarrow installed

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    pf = pq.ParquetFile(args.parquet)
    picked = {"exterior": [], "interior": []}
    seen = {"exterior": 0, "interior": 0}
    want = {"exterior": args.exterior, "interior": args.interior}
    index = []

    for rg in range(pf.num_row_groups):
        if all(len(picked[k]) >= want[k] for k in want):
            break
        tbl = pf.read_row_group(rg, columns=["image", "segmentations", "filename", "scene", "objects"])
        for row in tbl.to_pylist():
            scene = row["scene"] or []
            side = min(Image.open(io.BytesIO(row["image"]["bytes"])).size)
            if side < args.min_side:
                continue
            names = {}
            for o in row["objects"]:
                names[int(o["name_ndx"])] = o["name"]
            cls = decode_classes(row["segmentations"][0]["bytes"])
            kinds = np.zeros(cls.shape, np.uint8)
            for ndx, full in names.items():
                k = gt_kind(full)
                if k:
                    kinds[cls == ndx] = KIND_ID[k]
            share = {k: float((kinds == i).mean()) for k, i in KIND_ID.items()}
            ext_score = share["facade"]
            int_score = share["wall"] + share["floor"] + share["ceiling"]
            if "outdoor" in scene or "outdoor" in " ".join(scene):
                bucket = "exterior" if (share["facade"] >= 0.15 and share["ceiling"] < 0.02) else None
            else:
                bucket = "interior" if (share["wall"] >= 0.15 and (share["floor"] + share["ceiling"]) >= 0.10 and ext_score < 0.05) else None
            if bucket is None or len(picked[bucket]) >= want[bucket]:
                continue
            seen[bucket] += 1
            if seen[bucket] <= args.skip:
                continue
            name = f"{bucket}_{len(picked[bucket]):02d}_{Path(row['filename']).stem}"
            img = Image.open(io.BytesIO(row["image"]["bytes"])).convert("RGB")
            if max(img.size) > args.max_side:
                s = args.max_side / max(img.size)
                new = (round(img.size[0] * s), round(img.size[1] * s))
                img = img.resize(new, Image.LANCZOS)
                kinds_img = Image.fromarray(kinds).resize(new, Image.NEAREST)
                cls_img = Image.fromarray(cls.astype(np.int32)).resize(new, Image.NEAREST)
                kinds, cls = np.array(kinds_img), np.array(cls_img)
            d = out / name
            d.mkdir(exist_ok=True)
            img.save(d / "image.jpg", quality=95)
            Image.fromarray(kinds).save(d / "kinds.png")
            np.save(d / "classes.npy", cls.astype(np.int32))
            (d / "names.json").write_text(json.dumps({str(k): v for k, v in names.items()}), encoding="utf-8")
            picked[bucket].append(name)
            index.append({"name": name, "bucket": bucket, "scene": scene, "size": list(img.size), "share": {k: round(v, 3) for k, v in share.items() if v}})
            print(f"{name}  {img.size}  {scene[:2]}  " + " ".join(f"{k}={v:.2f}" for k, v in share.items() if v > 0.02))
    (out / "index.json").write_text(json.dumps(index, indent=1), encoding="utf-8")
    print(f"\npicked {len(picked['exterior'])} exterior, {len(picked['interior'])} interior -> {out}")


if __name__ == "__main__":
    main()
