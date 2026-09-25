#!/usr/bin/env python3
"""Run and evaluate Meta SAM 3 on interior/site images.

Examples
--------
Single image, visual/proxy evaluation only:

    python 02_run_evaluate_sam3.py \
      --images /kaggle/input/site-photos/reception.jpg \
      --gpus 0 \
      --output /kaggle/working/sam3_results

Image folder, both Kaggle T4s in parallel:

    python 02_run_evaluate_sam3.py \
      --images /kaggle/input/site-photos/images \
      --gpus 0,1 \
      --prompts floor wall ceiling "false ceiling" facade window door furniture person plant \
      --output /kaggle/working/sam3_results

True evaluation with binary ground-truth masks:

    python 02_run_evaluate_sam3.py \
      --images /kaggle/input/terucon-golden/images \
      --gt-dir /kaggle/input/terucon-golden/masks \
      --gpus 0,1 --output /kaggle/working/sam3_results

Ground-truth naming convention:
    masks/<image_stem>__<prompt_slug>.png

For example:
    images/room_01.jpg
    masks/room_01__floor.png
    masks/room_01__wall.png
    masks/room_01__ceiling.png

White/non-zero pixels are foreground. Without ground truth, the script reports
model confidence and diagnostic proxy scores; those are NOT accuracy metrics.
"""

from __future__ import annotations

import argparse
import csv
import html
import json
import math
import multiprocessing as mp
import os
from pathlib import Path
import re
import statistics
import sys
import time
import traceback
from typing import Any, Iterable


DEFAULT_RUNTIME = Path("/kaggle/working/sam3_runtime")
DEFAULT_PROMPTS = [
    "floor",
    "wall",
    "ceiling",
    "false ceiling",
    "facade",
    "window",
    "door",
    "furniture",
    "person",
    "plant",
]
SURFACE_PROMPTS = {"floor", "wall", "ceiling", "false ceiling", "facade"}
SUPPORTED_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff"}
PALETTE = [
    (0, 205, 255),
    (255, 99, 71),
    (147, 112, 219),
    (60, 179, 113),
    (255, 193, 7),
    (33, 150, 243),
    (233, 30, 99),
    (121, 85, 72),
    (205, 220, 57),
    (0, 188, 212),
    (255, 87, 34),
    (103, 58, 183),
]


def slugify(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", text.lower()).strip("_")


def discover_images(path: Path) -> list[Path]:
    if path.is_file():
        if path.suffix.lower() not in SUPPORTED_EXTENSIONS:
            raise ValueError(f"Unsupported image extension: {path.suffix}")
        return [path.resolve()]
    if not path.is_dir():
        raise FileNotFoundError(f"Image path not found: {path}")
    images = sorted(
        candidate.resolve()
        for candidate in path.rglob("*")
        if candidate.is_file() and candidate.suffix.lower() in SUPPORTED_EXTENSIONS
    )
    if not images:
        raise FileNotFoundError(f"No supported images found under {path}")
    return images


def binary_metrics(prediction: Any, target: Any, boundary_tolerance: int) -> dict[str, float]:
    import cv2
    import numpy as np

    pred = prediction.astype(bool)
    gt = target.astype(bool)
    intersection = int(np.logical_and(pred, gt).sum())
    union = int(np.logical_or(pred, gt).sum())
    pred_count = int(pred.sum())
    gt_count = int(gt.sum())
    iou = intersection / union if union else 1.0
    dice = (2.0 * intersection) / (pred_count + gt_count) if pred_count + gt_count else 1.0
    precision = intersection / pred_count if pred_count else (1.0 if not gt_count else 0.0)
    recall = intersection / gt_count if gt_count else (1.0 if not pred_count else 0.0)

    kernel = np.ones((3, 3), np.uint8)
    pred_boundary = cv2.morphologyEx(pred.astype(np.uint8), cv2.MORPH_GRADIENT, kernel) > 0
    gt_boundary = cv2.morphologyEx(gt.astype(np.uint8), cv2.MORPH_GRADIENT, kernel) > 0
    tolerance_kernel = cv2.getStructuringElement(
        cv2.MORPH_ELLIPSE,
        (2 * boundary_tolerance + 1, 2 * boundary_tolerance + 1),
    )
    pred_dilated = cv2.dilate(pred_boundary.astype(np.uint8), tolerance_kernel) > 0
    gt_dilated = cv2.dilate(gt_boundary.astype(np.uint8), tolerance_kernel) > 0
    pred_boundary_count = int(pred_boundary.sum())
    gt_boundary_count = int(gt_boundary.sum())
    boundary_precision = (
        np.logical_and(pred_boundary, gt_dilated).sum() / pred_boundary_count
        if pred_boundary_count
        else (1.0 if not gt_boundary_count else 0.0)
    )
    boundary_recall = (
        np.logical_and(gt_boundary, pred_dilated).sum() / gt_boundary_count
        if gt_boundary_count
        else (1.0 if not pred_boundary_count else 0.0)
    )
    boundary_f1 = (
        2 * boundary_precision * boundary_recall / (boundary_precision + boundary_recall)
        if boundary_precision + boundary_recall
        else 0.0
    )
    return {
        "iou": float(iou),
        "dice": float(dice),
        "pixel_precision": float(precision),
        "pixel_recall": float(recall),
        "boundary_precision": float(boundary_precision),
        "boundary_recall": float(boundary_recall),
        "boundary_f1": float(boundary_f1),
    }


def diagnostic_metrics(mask: Any, image_rgb: Any, confidences: list[float]) -> dict[str, float | int]:
    """Return transparent, weak diagnostics; never call these accuracy."""
    import cv2
    import numpy as np

    binary = mask.astype(np.uint8)
    height, width = binary.shape
    area_ratio = float(binary.mean())
    components, _ = cv2.connectedComponents(binary)
    component_count = max(0, int(components - 1))

    boundary = cv2.morphologyEx(binary, cv2.MORPH_GRADIENT, np.ones((3, 3), np.uint8)) > 0
    gray = cv2.cvtColor(image_rgb, cv2.COLOR_RGB2GRAY)
    edges = cv2.Canny(gray, 60, 160) > 0
    tolerance = max(1, int(round(math.hypot(height, width) * 0.002)))
    edge_dilated = cv2.dilate(
        edges.astype(np.uint8),
        cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * tolerance + 1, 2 * tolerance + 1)),
    ) > 0
    edge_alignment = (
        float((boundary & edge_dilated).sum() / boundary.sum()) if boundary.any() else 0.0
    )
    mean_confidence = float(statistics.fmean(confidences)) if confidences else 0.0
    max_confidence = float(max(confidences)) if confidences else 0.0
    # A deliberately conservative inspection aid. Confidence dominates; edge
    # alignment and fragmentation only flag obviously unstable masks.
    fragmentation_factor = 1.0 / (1.0 + max(0, component_count - 1) * 0.12)
    nondegenerate_factor = 1.0 if 0.003 <= area_ratio <= 0.97 else 0.35
    proxy = 100.0 * (
        0.70 * max_confidence
        + 0.20 * edge_alignment
        + 0.10 * fragmentation_factor
    ) * nondegenerate_factor
    return {
        "instance_count": len(confidences),
        "component_count": component_count,
        "area_ratio": area_ratio,
        "mean_model_confidence": mean_confidence,
        "max_model_confidence": max_confidence,
        "boundary_edge_alignment": edge_alignment,
        "diagnostic_proxy_0_100": float(max(0.0, min(100.0, proxy))),
    }


def tensor_to_numpy(value: Any) -> Any:
    if hasattr(value, "detach"):
        return value.detach().float().cpu().numpy()
    return value


def normalize_masks(masks: Any, height: int, width: int) -> Any:
    import cv2
    import numpy as np

    masks_np = np.asarray(tensor_to_numpy(masks))
    if masks_np.size == 0:
        return np.zeros((0, height, width), dtype=bool)
    while masks_np.ndim > 3 and masks_np.shape[1] == 1:
        masks_np = masks_np[:, 0]
    if masks_np.ndim == 2:
        masks_np = masks_np[None, ...]
    normalized = []
    for mask in masks_np:
        if mask.shape != (height, width):
            mask = cv2.resize(mask.astype("float32"), (width, height), interpolation=cv2.INTER_LINEAR)
        normalized.append(mask > 0.5)
    return np.stack(normalized, axis=0) if normalized else np.zeros((0, height, width), dtype=bool)


def load_gt_mask(gt_dir: Path | None, image_stem: str, prompt: str, shape: tuple[int, int]) -> Any | None:
    if gt_dir is None:
        return None
    import cv2

    candidates = [
        gt_dir / f"{image_stem}__{slugify(prompt)}.png",
        gt_dir / image_stem / f"{slugify(prompt)}.png",
    ]
    for candidate in candidates:
        if candidate.is_file():
            gt = cv2.imread(str(candidate), cv2.IMREAD_GRAYSCALE)
            if gt is None:
                raise RuntimeError(f"Could not read ground-truth mask: {candidate}")
            if gt.shape != shape:
                gt = cv2.resize(gt, (shape[1], shape[0]), interpolation=cv2.INTER_NEAREST)
            return gt > 0
    return None


def draw_overlay(image_rgb: Any, masks_by_prompt: dict[str, Any], alpha: float = 0.46) -> Any:
    import cv2
    import numpy as np

    overlay = image_rgb.astype(np.float32).copy()
    for index, (prompt, mask) in enumerate(masks_by_prompt.items()):
        color = np.array(PALETTE[index % len(PALETTE)], dtype=np.float32)
        overlay[mask] = (1 - alpha) * overlay[mask] + alpha * color
        contours, _ = cv2.findContours(mask.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        cv2.drawContours(overlay, contours, -1, tuple(int(x) for x in color), 2)
    return np.clip(overlay, 0, 255).astype(np.uint8)


def save_prompt_overlay(image_rgb: Any, mask: Any, color: tuple[int, int, int], label: str, path: Path) -> None:
    import cv2
    import numpy as np

    visual = image_rgb.astype(np.float32).copy()
    color_np = np.array(color, dtype=np.float32)
    visual[mask] = 0.50 * visual[mask] + 0.50 * color_np
    contours, _ = cv2.findContours(mask.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    cv2.drawContours(visual, contours, -1, tuple(int(x) for x in color), 2)
    cv2.putText(
        visual,
        label,
        (16, 34),
        cv2.FONT_HERSHEY_SIMPLEX,
        0.8,
        (255, 255, 255),
        4,
        cv2.LINE_AA,
    )
    cv2.putText(
        visual,
        label,
        (16, 34),
        cv2.FONT_HERSHEY_SIMPLEX,
        0.8,
        tuple(int(x) for x in color),
        2,
        cv2.LINE_AA,
    )
    cv2.imwrite(str(path), cv2.cvtColor(np.clip(visual, 0, 255).astype(np.uint8), cv2.COLOR_RGB2BGR))


def cross_prompt_overlap(masks_by_prompt: dict[str, Any]) -> dict[str, float]:
    import numpy as np

    surfaces = [(name, mask) for name, mask in masks_by_prompt.items() if name.lower() in SURFACE_PROMPTS]
    overlaps: dict[str, float] = {}
    for i, (left_name, left) in enumerate(surfaces):
        for right_name, right in surfaces[i + 1 :]:
            union = np.logical_or(left, right).sum()
            value = float(np.logical_and(left, right).sum() / union) if union else 0.0
            overlaps[f"{slugify(left_name)}__{slugify(right_name)}"] = value
    return overlaps


def worker_main(config: dict[str, Any], gpu_id: int, image_paths: list[str], queue: Any) -> None:
    # CUDA visibility must be set before importing torch in a spawned worker.
    os.environ["CUDA_VISIBLE_DEVICES"] = str(gpu_id)
    os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")
    try:
        import cv2
        import numpy as np
        from PIL import Image
        import torch

        repo_dir = Path(config["repo_dir"])
        if str(repo_dir) not in sys.path:
            sys.path.insert(0, str(repo_dir))
        from sam3.model_builder import build_sam3_image_model
        from sam3.model.sam3_image_processor import Sam3Processor

        if not torch.cuda.is_available():
            raise RuntimeError(f"CUDA is unavailable inside worker for requested GPU {gpu_id}")

        device_name = torch.cuda.get_device_name(0)
        checkpoint = Path(config["checkpoint"])
        model_start = time.perf_counter()
        model = build_sam3_image_model(
            checkpoint_path=str(checkpoint),
            load_from_HF=False,
            device="cuda",
            eval_mode=True,
            enable_segmentation=True,
            enable_inst_interactivity=False,
            compile=False,
        )
        processor = Sam3Processor(
            model,
            device="cuda",
            resolution=config["resolution"],
            confidence_threshold=config["threshold"],
        )
        model_load_seconds = time.perf_counter() - model_start

        records: list[dict[str, Any]] = []
        output_root = Path(config["output"])
        for image_path_text in image_paths:
            image_path = Path(image_path_text)
            image = Image.open(image_path).convert("RGB")
            image_rgb = np.asarray(image)
            height, width = image_rgb.shape[:2]
            image_dir = output_root / "images" / image_path.stem
            mask_dir = image_dir / "masks"
            prompt_dir = image_dir / "prompt_overlays"
            mask_dir.mkdir(parents=True, exist_ok=True)
            prompt_dir.mkdir(parents=True, exist_ok=True)

            torch.cuda.reset_peak_memory_stats()
            start = time.perf_counter()
            # T4 supports native FP16, not native BF16. Autocast avoids the
            # much larger FP32 activation footprint.
            with torch.inference_mode(), torch.autocast(
                device_type="cuda", dtype=torch.float16, enabled=True
            ):
                state = processor.set_image(image)
            encode_seconds = time.perf_counter() - start

            masks_by_prompt: dict[str, Any] = {}
            image_record: dict[str, Any] = {
                "image": str(image_path),
                "width": width,
                "height": height,
                "gpu_requested": gpu_id,
                "gpu_name": device_name,
                "model_load_seconds": model_load_seconds,
                "encode_seconds": encode_seconds,
                "prompts": {},
            }
            for prompt_index, prompt in enumerate(config["prompts"]):
                prompt_start = time.perf_counter()
                with torch.inference_mode(), torch.autocast(
                    device_type="cuda", dtype=torch.float16, enabled=True
                ):
                    output = processor.set_text_prompt(prompt=prompt, state=state)
                prompt_seconds = time.perf_counter() - prompt_start
                masks = normalize_masks(output.get("masks", []), height, width)
                scores_np = np.asarray(tensor_to_numpy(output.get("scores", []))).reshape(-1)
                scores = [float(score) for score in scores_np[: len(masks)]]
                union_mask = masks.any(axis=0) if len(masks) else np.zeros((height, width), dtype=bool)
                masks_by_prompt[prompt] = union_mask

                cv2.imwrite(str(mask_dir / f"{slugify(prompt)}.png"), union_mask.astype(np.uint8) * 255)
                diag = diagnostic_metrics(union_mask, image_rgb, scores)
                boundary_tolerance = max(1, int(round(math.hypot(height, width) * 0.002)))
                gt = load_gt_mask(
                    Path(config["gt_dir"]) if config.get("gt_dir") else None,
                    image_path.stem,
                    prompt,
                    (height, width),
                )
                gt_metrics = binary_metrics(union_mask, gt, boundary_tolerance) if gt is not None else None
                if gt is not None:
                    cv2.imwrite(
                        str(mask_dir / f"{slugify(prompt)}__gt.png"),
                        gt.astype(np.uint8) * 255,
                    )
                prompt_record: dict[str, Any] = {
                    "prompt": prompt,
                    "threshold": config["threshold"],
                    "inference_seconds": prompt_seconds,
                    "scores": scores,
                    "diagnostics_not_accuracy": diag,
                    "ground_truth_metrics": gt_metrics,
                    "ground_truth_found": gt is not None,
                }
                image_record["prompts"][prompt] = prompt_record
                label = f"{prompt} | max conf {diag['max_model_confidence']:.3f}"
                save_prompt_overlay(
                    image_rgb,
                    union_mask,
                    PALETTE[prompt_index % len(PALETTE)],
                    label,
                    prompt_dir / f"{slugify(prompt)}.jpg",
                )

            image_record["cross_surface_iou_diagnostic"] = cross_prompt_overlap(masks_by_prompt)
            image_record["peak_gpu_memory_gib"] = round(torch.cuda.max_memory_allocated() / 1024**3, 3)
            combined = draw_overlay(image_rgb, masks_by_prompt)
            cv2.imwrite(str(image_dir / "combined_overlay.jpg"), cv2.cvtColor(combined, cv2.COLOR_RGB2BGR))
            cv2.imwrite(str(image_dir / "original.jpg"), cv2.cvtColor(image_rgb, cv2.COLOR_RGB2BGR))
            (image_dir / "result.json").write_text(json.dumps(image_record, indent=2), encoding="utf-8")
            records.append(image_record)

            del state
            torch.cuda.empty_cache()

        queue.put({"gpu": gpu_id, "records": records, "error": None})
    except Exception:
        queue.put({"gpu": gpu_id, "records": [], "error": traceback.format_exc()})


def flatten_records(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for record in records:
        for prompt, details in record["prompts"].items():
            diag = details["diagnostics_not_accuracy"]
            gt = details.get("ground_truth_metrics") or {}
            rows.append(
                {
                    "image": record["image"],
                    "prompt": prompt,
                    "width": record["width"],
                    "height": record["height"],
                    "gpu": record["gpu_requested"],
                    "gpu_name": record["gpu_name"],
                    "encode_seconds": record["encode_seconds"],
                    "prompt_seconds": details["inference_seconds"],
                    "peak_gpu_memory_gib": record["peak_gpu_memory_gib"],
                    **diag,
                    "gt_found": details["ground_truth_found"],
                    "iou": gt.get("iou"),
                    "dice": gt.get("dice"),
                    "boundary_f1": gt.get("boundary_f1"),
                    "pixel_precision": gt.get("pixel_precision"),
                    "pixel_recall": gt.get("pixel_recall"),
                }
            )
    return rows


def build_summary(records: list[dict[str, Any]], rows: list[dict[str, Any]], config: dict[str, Any]) -> dict[str, Any]:
    gt_rows = [row for row in rows if row["gt_found"]]
    per_class: dict[str, dict[str, float | int]] = {}
    for prompt in config["prompts"]:
        class_rows = [row for row in gt_rows if row["prompt"] == prompt]
        if class_rows:
            per_class[prompt] = {
                "count": len(class_rows),
                "mean_iou": statistics.fmean(row["iou"] for row in class_rows),
                "mean_dice": statistics.fmean(row["dice"] for row in class_rows),
                "mean_boundary_f1": statistics.fmean(row["boundary_f1"] for row in class_rows),
            }
    diagnostic_values = [row["diagnostic_proxy_0_100"] for row in rows]
    overlaps = [
        value
        for record in records
        for value in record.get("cross_surface_iou_diagnostic", {}).values()
    ]
    summary: dict[str, Any] = {
        "model": "facebook/sam3 (official sam3.pt image checkpoint)",
        "checkpoint": config["checkpoint"],
        "image_count": len(records),
        "prompt_count": len(config["prompts"]),
        "threshold": config["threshold"],
        "resolution": config["resolution"],
        "gpus": config["gpus"],
        "ground_truth_masks_found": len(gt_rows),
        "diagnostic_proxy_mean_not_accuracy": (
            statistics.fmean(diagnostic_values) if diagnostic_values else None
        ),
        "mean_cross_surface_iou_diagnostic": statistics.fmean(overlaps) if overlaps else None,
        "mean_encode_seconds": statistics.fmean(record["encode_seconds"] for record in records),
        "mean_prompt_seconds": statistics.fmean(row["prompt_seconds"] for row in rows),
        "max_peak_gpu_memory_gib": max(record["peak_gpu_memory_gib"] for record in records),
        "per_class_ground_truth": per_class,
    }
    if gt_rows:
        mean_iou = statistics.fmean(row["iou"] for row in gt_rows)
        mean_boundary_f1 = statistics.fmean(row["boundary_f1"] for row in gt_rows)
        summary["ground_truth_overall"] = {
            "mean_iou": mean_iou,
            "mean_dice": statistics.fmean(row["dice"] for row in gt_rows),
            "mean_boundary_f1": mean_boundary_f1,
            "terucon_quality_score_0_100": 100.0 * (0.5 * mean_iou + 0.5 * mean_boundary_f1),
            "target_boundary_f1": 0.85,
            "passes_pdf_starting_target": mean_boundary_f1 >= 0.85,
        }
    else:
        summary["ground_truth_overall"] = None
        summary["warning"] = (
            "No ground-truth masks were found. Confidence/proxy scores help inspect failures but do not measure accuracy."
        )
    return summary


def write_csv(rows: list[dict[str, Any]], path: Path) -> None:
    if not rows:
        return
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)


def write_html_report(records: list[dict[str, Any]], summary: dict[str, Any], output: Path) -> None:
    cards: list[str] = []
    for record in records:
        image_stem = Path(record["image"]).stem
        prompt_chips = []
        for prompt, details in record["prompts"].items():
            diag = details["diagnostics_not_accuracy"]
            gt = details.get("ground_truth_metrics")
            metric_text = (
                f"IoU {gt['iou']:.3f} | BF1 {gt['boundary_f1']:.3f}"
                if gt
                else f"conf {diag['max_model_confidence']:.3f} | proxy {diag['diagnostic_proxy_0_100']:.1f}"
            )
            prompt_chips.append(f"<span><b>{html.escape(prompt)}</b>: {metric_text}</span>")
        cards.append(
            f"""
            <article>
              <h2>{html.escape(image_stem)}</h2>
              <div class="pair">
                <figure><img src="images/{html.escape(image_stem)}/original.jpg"><figcaption>Original</figcaption></figure>
                <figure><img src="images/{html.escape(image_stem)}/combined_overlay.jpg"><figcaption>SAM 3 overlay</figcaption></figure>
              </div>
              <div class="chips">{''.join(prompt_chips)}</div>
            </article>
            """
        )
    report = f"""<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SAM 3 Terucon Evaluation</title>
<style>
body{{font:15px system-ui;background:#0d1525;color:#edf3ff;margin:0;padding:28px}}main{{max-width:1200px;margin:auto}}
h1{{margin:0 0 8px}}.note{{color:#a9bad4}}article{{background:#162238;border:1px solid #2c3d59;border-radius:16px;padding:18px;margin:20px 0}}
.pair{{display:grid;grid-template-columns:1fr 1fr;gap:12px}}figure{{margin:0}}img{{width:100%;max-height:560px;object-fit:contain;background:#07101f;border-radius:10px}}
figcaption{{padding:7px 0;color:#b9c8dd}}.chips{{display:flex;flex-wrap:wrap;gap:8px}}.chips span{{background:#243651;padding:7px 10px;border-radius:999px}}
pre{{white-space:pre-wrap;background:#07101f;padding:14px;border-radius:10px;overflow:auto}}@media(max-width:760px){{.pair{{grid-template-columns:1fr}}body{{padding:14px}}}}
</style></head><body><main>
<h1>SAM 3 - Terucon segmentation evaluation</h1>
<p class="note">Proxy scores are diagnostics, not accuracy. IoU/BF1 appear only where a ground-truth mask exists.</p>
<pre>{html.escape(json.dumps(summary, indent=2))}</pre>
{''.join(cards)}
</main></body></html>"""
    (output / "report.html").write_text(report, encoding="utf-8")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--images", type=Path, required=True, help="An image or a directory of images.")
    parser.add_argument("--gt-dir", type=Path, default=None, help="Optional directory of binary ground-truth masks.")
    parser.add_argument("--runtime", type=Path, default=DEFAULT_RUNTIME, help="Directory produced by script 01.")
    parser.add_argument("--checkpoint", type=Path, default=None, help="Override sam3.pt path.")
    parser.add_argument("--output", type=Path, default=Path("/kaggle/working/sam3_results"))
    parser.add_argument("--prompts", nargs="+", default=DEFAULT_PROMPTS)
    parser.add_argument("--threshold", type=float, default=0.35, help="SAM 3 detection threshold (default 0.35).")
    parser.add_argument("--resolution", type=int, default=1008, help="Official image resolution (default 1008).")
    parser.add_argument("--gpus", default="0", help="Comma-separated physical GPU IDs, e.g. 0,1.")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if not 0.0 <= args.threshold <= 1.0:
        raise ValueError("--threshold must be between 0 and 1")
    gpus = [int(item.strip()) for item in args.gpus.split(",") if item.strip()]
    if not gpus:
        raise ValueError("At least one GPU ID is required")
    images = discover_images(args.images)
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    runtime = args.runtime.resolve()
    checkpoint = (args.checkpoint or runtime / "models" / "sam3.pt").resolve()
    repo_dir = (runtime / "sam3").resolve()
    if not checkpoint.is_file():
        raise FileNotFoundError(f"Checkpoint not found: {checkpoint}. Run script 01 first.")
    if not (repo_dir / "sam3").is_dir():
        raise FileNotFoundError(f"SAM 3 source package not found: {repo_dir}. Run script 01 first.")
    if args.gt_dir and not args.gt_dir.is_dir():
        raise FileNotFoundError(f"Ground-truth directory not found: {args.gt_dir}")

    config = {
        "repo_dir": str(repo_dir),
        "checkpoint": str(checkpoint),
        "output": str(output),
        "gt_dir": str(args.gt_dir.resolve()) if args.gt_dir else None,
        "prompts": list(dict.fromkeys(args.prompts)),
        "threshold": args.threshold,
        "resolution": args.resolution,
        "gpus": gpus,
    }
    (output / "run_config.json").write_text(json.dumps(config, indent=2), encoding="utf-8")

    # Two T4s increase throughput for folders by running one full model copy on
    # each GPU. They do not pool memory; a single image still uses one T4.
    active_gpus = gpus[: min(len(gpus), len(images))]
    shards = [images[index:: len(active_gpus)] for index in range(len(active_gpus))]
    context = mp.get_context("spawn")
    queue = context.Queue()
    processes = []
    for gpu, shard in zip(active_gpus, shards):
        process = context.Process(
            target=worker_main,
            args=(config, gpu, [str(path) for path in shard], queue),
        )
        process.start()
        processes.append(process)

    payloads = [queue.get() for _ in processes]
    for process in processes:
        process.join()
    errors = [payload for payload in payloads if payload["error"]]
    if errors:
        for error in errors:
            print(f"\nGPU worker {error['gpu']} failed:\n{error['error']}", file=sys.stderr)
        raise RuntimeError(f"{len(errors)} GPU worker(s) failed; see tracebacks above.")

    records = [record for payload in payloads for record in payload["records"]]
    records.sort(key=lambda item: item["image"])
    rows = flatten_records(records)
    summary = build_summary(records, rows, config)
    (output / "results.json").write_text(json.dumps(records, indent=2), encoding="utf-8")
    (output / "summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    write_csv(rows, output / "metrics.csv")
    write_html_report(records, summary, output)

    print(json.dumps(summary, indent=2))
    print(f"\nVisual report: {output / 'report.html'}")
    print(f"Metrics CSV:   {output / 'metrics.csv'}")
    print(f"Raw results:  {output / 'results.json'}")


if __name__ == "__main__":
    main()
