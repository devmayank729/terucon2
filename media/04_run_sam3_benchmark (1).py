#!/usr/bin/env python3
"""Run official SAM 3 over a full manifest using one worker per Kaggle T4.

This runner is resumable and keeps accuracy separate from diagnostics. It runs
the model once at the lowest requested confidence threshold, then evaluates
the retained instances at every threshold without re-encoding the image.

Example::

    python 04_run_sam3_benchmark.py \
      --manifest /kaggle/working/sam3_benchmark_data/manifest.csv \
      --runtime /kaggle/working/sam3_runtime \
      --gpus 0,1 \
      --config benchmark_config.json \
      --gt-dir /kaggle/input/terucon-gold-masks \
      --output /kaggle/working/sam3_benchmark_results

Ground-truth masks are binary PNGs. A present class has white/non-zero pixels;
an explicitly absent class has an all-black PNG. A missing file means unknown,
not absent. Accepted paths are::

    <gt-dir>/<image_id>__<prompt_slug>.png
    <gt-dir>/<image_id>/<prompt_slug>.png
    <gt-dir>/<original_stem>__<prompt_slug>.png

Re-run the same command to resume. Use --overwrite to recompute completed
images. The T4 warning about Flash Attention is expected; T4 is a Turing GPU,
so SAM 3 correctly falls back to standard attention kernels.
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
import shutil
import statistics
import sys
import time
import traceback
from typing import Any


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
SUPPORTED_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff"}
# These are expected to be mostly mutually exclusive. "facade" is deliberately
# excluded because it is a composite concept that can legitimately contain or
# overlap wall, window and door masks.
SURFACE_PROMPTS = {"floor", "wall", "ceiling", "false ceiling"}
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
]


def slugify(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", text.lower()).strip("_")


def threshold_key(value: float) -> str:
    return f"{value:.3f}"


def pipe_list(value: str | None) -> list[str]:
    return [item.strip() for item in (value or "").split("|") if item.strip()]


def safe_image_id(value: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "_", value).strip("._-")
    return cleaned[:160] or "image"


def load_config(path: Path | None) -> dict[str, Any]:
    if path is None:
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


def discover_image_items(images: Path) -> list[dict[str, Any]]:
    if images.is_file():
        paths = [images.resolve()]
    elif images.is_dir():
        paths = sorted(
            candidate.resolve()
            for candidate in images.rglob("*")
            if candidate.is_file() and candidate.suffix.lower() in SUPPORTED_EXTENSIONS
        )
    else:
        raise FileNotFoundError(images)
    if not paths:
        raise FileNotFoundError(f"No images found under {images}")
    items = []
    for index, path in enumerate(paths):
        identifier = safe_image_id(f"image_{index:06d}_{path.stem}")
        items.append(
            {
                "image_id": identifier,
                "local_path": str(path),
                "source": "direct_images",
                "source_page": "",
                "license": "unknown",
                "author": "",
                "title": path.name,
                "query": "",
                "stratum": "unknown",
                "region": "unknown",
                "country": "",
                "split": "audit",
                "candidate_prompts": "",
                "expected_prompts": "",
            }
        )
    return items


def load_manifest_items(path: Path) -> list[dict[str, Any]]:
    base = path.expanduser().resolve().parent
    items: list[dict[str, Any]] = []
    seen: set[str] = set()
    with path.open(newline="", encoding="utf-8") as handle:
        for row_number, row in enumerate(csv.DictReader(handle), start=2):
            raw_path = (row.get("local_path") or "").strip()
            if not raw_path:
                print(f"WARNING: manifest row {row_number} has no local_path; skipped")
                continue
            image_path = Path(raw_path).expanduser()
            if not image_path.is_absolute():
                image_path = base / image_path
            image_path = image_path.resolve()
            if not image_path.is_file():
                print(f"WARNING: manifest image missing: {image_path}; skipped")
                continue
            image_id = safe_image_id((row.get("image_id") or image_path.stem).strip())
            if image_id in seen:
                raise ValueError(f"Duplicate image_id in manifest: {image_id}")
            seen.add(image_id)
            item: dict[str, Any] = dict(row)
            item["image_id"] = image_id
            item["local_path"] = str(image_path)
            items.append(item)
    if not items:
        raise ValueError(f"Manifest contains no usable images: {path}")
    return items


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


def align_scores(scores: Any, mask_count: int) -> list[float]:
    import numpy as np

    values = [float(value) for value in np.asarray(tensor_to_numpy(scores)).reshape(-1)]
    if len(values) < mask_count:
        values.extend([0.0] * (mask_count - len(values)))
    return values[:mask_count]


def load_ground_truth(
    gt_dir: Path | None,
    image_id: str,
    image_stem: str,
    prompt: str,
    shape: tuple[int, int],
) -> Any | None:
    if gt_dir is None:
        return None
    import cv2

    prompt_slug = slugify(prompt)
    candidates = [
        gt_dir / f"{image_id}__{prompt_slug}.png",
        gt_dir / image_id / f"{prompt_slug}.png",
        gt_dir / f"{image_stem}__{prompt_slug}.png",
        gt_dir / image_stem / f"{prompt_slug}.png",
    ]
    for candidate in candidates:
        if candidate.is_file():
            mask = cv2.imread(str(candidate), cv2.IMREAD_GRAYSCALE)
            if mask is None:
                raise RuntimeError(f"Unreadable ground-truth mask: {candidate}")
            if mask.shape != shape:
                mask = cv2.resize(mask, (shape[1], shape[0]), interpolation=cv2.INTER_NEAREST)
            return mask > 0
    return None


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
    dice = (2 * intersection) / (pred_count + gt_count) if pred_count + gt_count else 1.0
    precision = intersection / pred_count if pred_count else (1.0 if not gt_count else 0.0)
    recall = intersection / gt_count if gt_count else (1.0 if not pred_count else 0.0)
    kernel = np.ones((3, 3), dtype=np.uint8)
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
        float(np.logical_and(pred_boundary, gt_dilated).sum() / pred_boundary_count)
        if pred_boundary_count
        else (1.0 if not gt_boundary_count else 0.0)
    )
    boundary_recall = (
        float(np.logical_and(gt_boundary, pred_dilated).sum() / gt_boundary_count)
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
        "boundary_precision": boundary_precision,
        "boundary_recall": boundary_recall,
        "boundary_f1": float(boundary_f1),
    }


def diagnostic_metrics(mask: Any, image_rgb: Any, confidences: list[float]) -> dict[str, Any]:
    """Describe a prediction without pretending to measure accuracy."""
    import cv2
    import numpy as np

    binary = mask.astype(np.uint8)
    height, width = binary.shape
    area_ratio = float(binary.mean())
    connected_labels, _ = cv2.connectedComponents(binary)
    component_count = max(0, int(connected_labels - 1))
    boundary = cv2.morphologyEx(binary, cv2.MORPH_GRADIENT, np.ones((3, 3), np.uint8)) > 0
    gray = cv2.cvtColor(image_rgb, cv2.COLOR_RGB2GRAY)
    edges = cv2.Canny(gray, 60, 160) > 0
    tolerance = max(1, int(round(math.hypot(height, width) * 0.002)))
    edge_dilated = cv2.dilate(
        edges.astype(np.uint8),
        cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * tolerance + 1, 2 * tolerance + 1)),
    ) > 0
    edge_alignment = float((boundary & edge_dilated).sum() / boundary.sum()) if boundary.any() else None
    flags: list[str] = []
    if confidences and area_ratio < 0.002:
        flags.append("tiny_prediction")
    if area_ratio > 0.90:
        flags.append("near_full_frame")
    if component_count > 12:
        flags.append("high_fragmentation")
    if confidences and max(confidences) < 0.50:
        flags.append("low_confidence")
    return {
        "prediction_present": bool(confidences) and bool(binary.any()),
        "instance_count": len(confidences),
        "component_count": component_count,
        "area_ratio": area_ratio,
        "mean_model_confidence": float(statistics.fmean(confidences)) if confidences else None,
        "max_model_confidence": float(max(confidences)) if confidences else None,
        "boundary_edge_alignment": edge_alignment,
        "diagnostic_flags": flags,
    }


def cross_prompt_overlap(masks_by_prompt: dict[str, Any]) -> dict[str, float]:
    import numpy as np

    items = [(name, mask) for name, mask in masks_by_prompt.items() if name.lower() in SURFACE_PROMPTS]
    overlaps: dict[str, float] = {}
    for index, (left_name, left_mask) in enumerate(items):
        for right_name, right_mask in items[index + 1 :]:
            union = int(np.logical_or(left_mask, right_mask).sum())
            overlap = int(np.logical_and(left_mask, right_mask).sum())
            overlaps[f"{slugify(left_name)}__{slugify(right_name)}"] = overlap / union if union else 0.0
    return overlaps


def make_visual_image(image_rgb: Any, max_side: int) -> Any:
    import cv2

    height, width = image_rgb.shape[:2]
    if max(height, width) <= max_side:
        return image_rgb
    scale = max_side / max(height, width)
    return cv2.resize(
        image_rgb,
        (max(1, round(width * scale)), max(1, round(height * scale))),
        interpolation=cv2.INTER_AREA,
    )


def draw_overlay(image_rgb: Any, masks_by_prompt: dict[str, Any], prompts: list[str]) -> Any:
    import cv2
    import numpy as np

    overlay = image_rgb.astype(np.float32).copy()
    for prompt_index, prompt in enumerate(prompts):
        mask = masks_by_prompt[prompt]
        color = np.asarray(PALETTE[prompt_index % len(PALETTE)], dtype=np.float32)
        overlay[mask] = 0.52 * overlay[mask] + 0.48 * color
        contours, _ = cv2.findContours(mask.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        cv2.drawContours(overlay, contours, -1, tuple(int(channel) for channel in color), 2)
    return np.clip(overlay, 0, 255).astype(np.uint8)


def save_jpeg(path: Path, image_rgb: Any, quality: int = 88) -> None:
    import cv2

    cv2.imwrite(
        str(path),
        cv2.cvtColor(image_rgb, cv2.COLOR_RGB2BGR),
        [int(cv2.IMWRITE_JPEG_QUALITY), quality],
    )


def process_one(
    item: dict[str, Any],
    config: dict[str, Any],
    processor: Any,
    gpu_requested: int,
    gpu_name: str,
    model_load_seconds: float,
) -> dict[str, Any]:
    import cv2
    import numpy as np
    from PIL import Image, ImageOps
    import torch

    image_id = item["image_id"]
    image_path = Path(item["local_path"])
    image_dir = Path(config["output"]) / "images" / image_id
    image_dir.mkdir(parents=True, exist_ok=True)
    try:
        with Image.open(image_path) as opened:
            image = ImageOps.exif_transpose(opened).convert("RGB")
        image_rgb = np.asarray(image)
        height, width = image_rgb.shape[:2]
        torch.cuda.reset_peak_memory_stats()
        encode_start = time.perf_counter()
        with torch.inference_mode(), torch.autocast(device_type="cuda", dtype=torch.float16):
            state = processor.set_image(image)
        encode_seconds = time.perf_counter() - encode_start
        expected_prompts = set(pipe_list(item.get("expected_prompts")))
        candidate_prompts = set(pipe_list(item.get("candidate_prompts")))
        record: dict[str, Any] = {
            "status": "ok",
            "image_id": image_id,
            "image": str(image_path),
            "metadata": {
                key: item.get(key, "")
                for key in (
                    "source",
                    "source_page",
                    "download_url",
                    "license",
                    "license_url",
                    "author",
                    "title",
                    "query",
                    "stratum",
                    "region",
                    "country",
                    "split",
                    "candidate_prompts",
                    "expected_prompts",
                )
            },
            "width": width,
            "height": height,
            "gpu_requested": gpu_requested,
            "gpu_name": gpu_name,
            "model_load_seconds": model_load_seconds,
            "encode_seconds": encode_seconds,
            "visual_threshold": config["visual_threshold"],
            "prompts": {},
        }
        visual_masks: dict[str, Any] = {}
        boundary_tolerance = max(1, int(round(math.hypot(height, width) * 0.002)))
        for prompt in config["prompts"]:
            prompt_start = time.perf_counter()
            with torch.inference_mode(), torch.autocast(device_type="cuda", dtype=torch.float16):
                output = processor.set_text_prompt(prompt=prompt, state=state)
            prompt_seconds = time.perf_counter() - prompt_start
            masks = normalize_masks(output.get("masks", []), height, width)
            scores = align_scores(output.get("scores", []), len(masks))
            gt = load_ground_truth(
                Path(config["gt_dir"]) if config.get("gt_dir") else None,
                image_id,
                image_path.stem,
                prompt,
                (height, width),
            )
            prompt_record: dict[str, Any] = {
                "prompt": prompt,
                "inference_seconds": prompt_seconds,
                "candidate_for_scene_heuristic": prompt in candidate_prompts if candidate_prompts else None,
                "expected_by_human": prompt in expected_prompts if expected_prompts else None,
                "ground_truth_found": gt is not None,
                "ground_truth_positive": bool(gt.any()) if gt is not None else None,
                "thresholds": {},
            }
            for threshold in config["thresholds"]:
                selected_indices = [index for index, score in enumerate(scores) if score >= threshold]
                selected_scores = [scores[index] for index in selected_indices]
                if selected_indices:
                    union_mask = masks[selected_indices].any(axis=0)
                else:
                    union_mask = np.zeros((height, width), dtype=bool)
                diagnostics = diagnostic_metrics(union_mask, image_rgb, selected_scores)
                metrics = binary_metrics(union_mask, gt, boundary_tolerance) if gt is not None else None
                prompt_record["thresholds"][threshold_key(threshold)] = {
                    "threshold": threshold,
                    "diagnostics_not_accuracy": diagnostics,
                    "ground_truth_metrics": metrics,
                }
                if math.isclose(threshold, config["visual_threshold"], abs_tol=1e-9):
                    visual_masks[prompt] = union_mask
                    if config["save_masks"]:
                        mask_dir = image_dir / "masks"
                        mask_dir.mkdir(exist_ok=True)
                        cv2.imwrite(
                            str(mask_dir / f"{slugify(prompt)}.png"),
                            union_mask.astype(np.uint8) * 255,
                        )
            record["prompts"][prompt] = prompt_record

        record["cross_surface_iou_diagnostic"] = cross_prompt_overlap(visual_masks)
        record["peak_gpu_memory_gib"] = round(torch.cuda.max_memory_allocated() / 1024**3, 3)
        visual_original = make_visual_image(image_rgb, config["visual_max_side"])
        visual_masks_resized: dict[str, Any] = {}
        for prompt, mask in visual_masks.items():
            if mask.shape != visual_original.shape[:2]:
                visual_masks_resized[prompt] = cv2.resize(
                    mask.astype(np.uint8),
                    (visual_original.shape[1], visual_original.shape[0]),
                    interpolation=cv2.INTER_NEAREST,
                ).astype(bool)
            else:
                visual_masks_resized[prompt] = mask
        overlay = draw_overlay(visual_original, visual_masks_resized, config["prompts"])
        save_jpeg(image_dir / "original.jpg", visual_original)
        save_jpeg(image_dir / "combined_overlay.jpg", overlay)
        del state
        torch.cuda.empty_cache()
    except Exception:
        record = {
            "status": "error",
            "image_id": image_id,
            "image": str(image_path),
            "metadata": dict(item),
            "error": traceback.format_exc(),
            "gpu_requested": gpu_requested,
            "gpu_name": gpu_name,
        }
    (image_dir / "result.json").write_text(json.dumps(record, indent=2), encoding="utf-8")
    return record


def worker_main(config: dict[str, Any], gpu_id: int, items: list[dict[str, Any]], queue: Any) -> None:
    os.environ["CUDA_VISIBLE_DEVICES"] = str(gpu_id)
    os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")
    try:
        import torch

        repo_dir = Path(config["repo_dir"])
        if str(repo_dir) not in sys.path:
            sys.path.insert(0, str(repo_dir))
        from sam3.model_builder import build_sam3_image_model
        from sam3.model.sam3_image_processor import Sam3Processor

        if not torch.cuda.is_available():
            raise RuntimeError(f"CUDA unavailable for requested GPU {gpu_id}")
        gpu_name = torch.cuda.get_device_name(0)
        load_start = time.perf_counter()
        model = build_sam3_image_model(
            checkpoint_path=config["checkpoint"],
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
            confidence_threshold=min(config["thresholds"]),
        )
        model_load_seconds = time.perf_counter() - load_start
        ok_count = 0
        error_count = 0
        for index, item in enumerate(items, start=1):
            record = process_one(item, config, processor, gpu_id, gpu_name, model_load_seconds)
            ok_count += record["status"] == "ok"
            error_count += record["status"] != "ok"
            if index % 10 == 0 or index == len(items):
                print(
                    f"GPU {gpu_id}: {index}/{len(items)} images; ok={ok_count}, errors={error_count}",
                    flush=True,
                )
        queue.put({"gpu": gpu_id, "ok": ok_count, "errors": error_count, "fatal": None})
    except Exception:
        queue.put({"gpu": gpu_id, "ok": 0, "errors": 0, "fatal": traceback.format_exc()})


def collect_records(output: Path) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for result_path in sorted((output / "images").glob("*/result.json")):
        try:
            records.append(json.loads(result_path.read_text(encoding="utf-8")))
        except Exception as exc:
            records.append(
                {
                    "status": "error",
                    "image_id": result_path.parent.name,
                    "image": "",
                    "error": f"Could not read result.json: {exc}",
                }
            )
    records.sort(key=lambda record: record.get("image_id", ""))
    return records


def flatten_records(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for record in records:
        if record.get("status") != "ok":
            continue
        metadata = record.get("metadata", {})
        for prompt, prompt_record in record["prompts"].items():
            for threshold_text, details in prompt_record["thresholds"].items():
                diagnostics = details["diagnostics_not_accuracy"]
                gt = details.get("ground_truth_metrics") or {}
                rows.append(
                    {
                        "image_id": record["image_id"],
                        "image": record["image"],
                        "source": metadata.get("source", ""),
                        "region": metadata.get("region", ""),
                        "stratum": metadata.get("stratum", ""),
                        "split": metadata.get("split", ""),
                        "prompt": prompt,
                        "threshold": float(threshold_text),
                        "candidate_for_scene_heuristic": prompt_record.get("candidate_for_scene_heuristic"),
                        "expected_by_human": prompt_record.get("expected_by_human"),
                        "ground_truth_found": prompt_record["ground_truth_found"],
                        "ground_truth_positive": prompt_record["ground_truth_positive"],
                        **diagnostics,
                        "iou": gt.get("iou"),
                        "dice": gt.get("dice"),
                        "boundary_f1": gt.get("boundary_f1"),
                        "pixel_precision": gt.get("pixel_precision"),
                        "pixel_recall": gt.get("pixel_recall"),
                        "encode_seconds": record["encode_seconds"],
                        "prompt_seconds": prompt_record["inference_seconds"],
                        "peak_gpu_memory_gib": record["peak_gpu_memory_gib"],
                        "gpu": record["gpu_requested"],
                        "gpu_name": record["gpu_name"],
                    }
                )
    return rows


def write_csv(rows: list[dict[str, Any]], path: Path) -> None:
    if not rows:
        return
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)


def parse_float_list(text: str) -> list[float]:
    values = sorted(set(float(item.strip()) for item in text.split(",") if item.strip()))
    if not values or any(value < 0 or value > 1 for value in values):
        raise ValueError("Thresholds must be comma-separated values in [0, 1]")
    return values


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--manifest", type=Path)
    source.add_argument("--images", type=Path)
    parser.add_argument("--config", type=Path, default=None)
    parser.add_argument("--gt-dir", type=Path, default=None)
    parser.add_argument("--runtime", type=Path, default=DEFAULT_RUNTIME)
    parser.add_argument("--checkpoint", type=Path, default=None)
    parser.add_argument("--output", type=Path, default=Path("/kaggle/working/sam3_benchmark_results"))
    parser.add_argument("--gpus", default="0,1")
    parser.add_argument("--prompts", nargs="+", default=None)
    parser.add_argument("--thresholds", default=None, help="Example: 0.2,0.35,0.5,0.65")
    parser.add_argument("--visual-threshold", type=float, default=None)
    parser.add_argument("--resolution", type=int, default=1008)
    parser.add_argument("--visual-max-side", type=int, default=1280)
    parser.add_argument("--save-masks", action="store_true")
    parser.add_argument("--overwrite", action="store_true")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    file_config = load_config(args.config)
    prompts = list(dict.fromkeys(args.prompts or file_config.get("prompts") or DEFAULT_PROMPTS))
    thresholds = (
        parse_float_list(args.thresholds)
        if args.thresholds
        else sorted(set(float(value) for value in file_config.get("thresholds", [0.2, 0.35, 0.5, 0.65])))
    )
    visual_threshold = float(
        args.visual_threshold
        if args.visual_threshold is not None
        else file_config.get("visual_threshold", 0.35)
    )
    if visual_threshold not in thresholds:
        raise ValueError("--visual-threshold must be included in --thresholds")
    gpus = [int(item.strip()) for item in args.gpus.split(",") if item.strip()]
    if not gpus:
        raise ValueError("At least one GPU is required")
    items = load_manifest_items(args.manifest) if args.manifest else discover_image_items(args.images)
    output = args.output.expanduser().resolve()
    output.mkdir(parents=True, exist_ok=True)
    (output / "images").mkdir(exist_ok=True)
    runtime = args.runtime.expanduser().resolve()
    checkpoint = (args.checkpoint or runtime / "models" / "sam3.pt").expanduser().resolve()
    repo_dir = runtime / "sam3"
    if not checkpoint.is_file():
        raise FileNotFoundError(f"Checkpoint not found: {checkpoint}; run script 01 first")
    if not (repo_dir / "sam3").is_dir():
        raise FileNotFoundError(f"SAM 3 source not found: {repo_dir}; run script 01 first")
    if args.gt_dir and not args.gt_dir.is_dir():
        raise FileNotFoundError(args.gt_dir)
    if args.manifest:
        shutil.copy2(args.manifest, output / "input_manifest.csv")

    completed: set[str] = set()
    for result_path in (output / "images").glob("*/result.json"):
        try:
            existing = json.loads(result_path.read_text(encoding="utf-8"))
            if existing.get("status") == "ok":
                completed.add(result_path.parent.name)
        except Exception:
            # Corrupt or partial results are intentionally retried.
            pass
    pending = items if args.overwrite else [item for item in items if item["image_id"] not in completed]
    config = {
        "repo_dir": str(repo_dir.resolve()),
        "checkpoint": str(checkpoint),
        "output": str(output),
        "gt_dir": str(args.gt_dir.resolve()) if args.gt_dir else None,
        "prompts": prompts,
        "thresholds": thresholds,
        "visual_threshold": visual_threshold,
        "resolution": args.resolution,
        "visual_max_side": args.visual_max_side,
        "save_masks": args.save_masks,
        "gpus": gpus,
        "image_count_manifest": len(items),
        "image_count_pending": len(pending),
    }
    (output / "run_config.json").write_text(json.dumps(config, indent=2), encoding="utf-8")
    print(
        f"Manifest images: {len(items)} | completed: {len(items) - len(pending)} | pending: {len(pending)}",
        flush=True,
    )

    payloads: list[dict[str, Any]] = []
    if pending:
        active_gpus = gpus[: min(len(gpus), len(pending))]
        shards = [pending[index:: len(active_gpus)] for index in range(len(active_gpus))]
        context = mp.get_context("spawn")
        queue = context.Queue()
        processes = []
        for gpu, shard in zip(active_gpus, shards):
            process = context.Process(target=worker_main, args=(config, gpu, shard, queue))
            process.start()
            processes.append(process)
        payloads = [queue.get() for _ in processes]
        for process in processes:
            process.join()
        fatal = [payload for payload in payloads if payload["fatal"]]
        if fatal:
            for payload in fatal:
                print(f"\nGPU worker {payload['gpu']} failed:\n{payload['fatal']}", file=sys.stderr)
            raise RuntimeError(f"{len(fatal)} GPU workers failed")

    records = collect_records(output)
    with (output / "results.jsonl").open("w", encoding="utf-8") as handle:
        for record in records:
            handle.write(json.dumps(record, separators=(",", ":")) + "\n")
    rows = flatten_records(records)
    write_csv(rows, output / "metrics_all_thresholds.csv")
    ok_records = [record for record in records if record.get("status") == "ok"]
    errors = [record for record in records if record.get("status") != "ok"]
    summary = {
        "model": "facebook/sam3 official sam3.pt",
        "checkpoint": str(checkpoint),
        "manifest_images": len(items),
        "completed_images": len(ok_records),
        "error_images": len(errors),
        "new_worker_payloads": payloads,
        "prompts": prompts,
        "thresholds": thresholds,
        "visual_threshold": visual_threshold,
        "ground_truth_prompt_masks": sum(row["ground_truth_found"] for row in rows if row["threshold"] == visual_threshold),
        "mean_encode_seconds": statistics.fmean(record["encode_seconds"] for record in ok_records) if ok_records else None,
        "mean_prompt_seconds": statistics.fmean(
            prompt_record["inference_seconds"]
            for record in ok_records
            for prompt_record in record["prompts"].values()
        ) if ok_records else None,
        "max_peak_gpu_memory_gib": max((record["peak_gpu_memory_gib"] for record in ok_records), default=None),
        "next_step": "Run 05_compile_sam3_report.py. Accuracy/fine-tuning conclusions require ground-truth masks.",
    }
    (output / "run_summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
