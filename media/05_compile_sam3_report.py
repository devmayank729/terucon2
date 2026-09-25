#!/usr/bin/env python3
"""Compile a SAM 3 benchmark into a decision-oriented HTML/CSV report.

The compiler selects a confidence threshold using only the calibration split,
then evaluates the selected threshold on held-out test ground truth. Unlabeled
images contribute coverage, operational and anomaly statistics only.

Example::

    python 05_compile_sam3_report.py \
      --results /kaggle/working/sam3_benchmark_results \
      --config benchmark_config.json

Outputs are written inside the results directory:
  compiled_report.html
  compiled/decision.json
  compiled/per_class_metrics.csv
  compiled/threshold_selection.csv
  compiled/annotation_queue.csv
  compiled/source_coverage.csv
"""

from __future__ import annotations

import argparse
from collections import Counter, defaultdict
import csv
import html
import json
import math
import os
from pathlib import Path
import random
import statistics
from typing import Any, Iterable
from urllib.parse import quote


DEFAULT_CORE_CLASSES = ["floor", "wall", "ceiling", "false ceiling", "facade", "window", "door"]


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def load_records(results: Path) -> list[dict[str, Any]]:
    jsonl = results / "results.jsonl"
    records: list[dict[str, Any]] = []
    if jsonl.is_file():
        with jsonl.open(encoding="utf-8") as handle:
            for line_number, line in enumerate(handle, start=1):
                if not line.strip():
                    continue
                try:
                    records.append(json.loads(line))
                except json.JSONDecodeError as exc:
                    raise ValueError(f"Invalid JSONL at line {line_number}: {exc}") from exc
    else:
        for path in sorted((results / "images").glob("*/result.json")):
            records.append(load_json(path))
    if not records:
        raise FileNotFoundError(f"No benchmark records found under {results}")
    return records


def threshold_key(value: float) -> str:
    return f"{value:.3f}"


def mean_or_none(values: Iterable[float | None]) -> float | None:
    clean = [float(value) for value in values if value is not None and math.isfinite(float(value))]
    return statistics.fmean(clean) if clean else None


def median_or_none(values: Iterable[float | None]) -> float | None:
    clean = [float(value) for value in values if value is not None and math.isfinite(float(value))]
    return statistics.median(clean) if clean else None


def percentile(values: Iterable[float], percentile_value: float) -> float | None:
    clean = sorted(float(value) for value in values if math.isfinite(float(value)))
    if not clean:
        return None
    if len(clean) == 1:
        return clean[0]
    position = (len(clean) - 1) * percentile_value
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return clean[lower]
    fraction = position - lower
    return clean[lower] * (1 - fraction) + clean[upper] * fraction


def bootstrap_mean_ci(values: list[float], seed: int, samples: int = 2000) -> tuple[float | None, float | None]:
    if not values:
        return None, None
    if len(values) == 1:
        return values[0], values[0]
    generator = random.Random(seed)
    boot = []
    for _ in range(samples):
        boot.append(statistics.fmean(generator.choice(values) for _ in values))
    return percentile(boot, 0.025), percentile(boot, 0.975)


def prompt_rows(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for record in records:
        if record.get("status") != "ok":
            continue
        metadata = record.get("metadata", {})
        for prompt, prompt_record in record.get("prompts", {}).items():
            for threshold_text, entry in prompt_record.get("thresholds", {}).items():
                diagnostics = entry.get("diagnostics_not_accuracy", {})
                metrics = entry.get("ground_truth_metrics") or {}
                rows.append(
                    {
                        "image_id": record.get("image_id", ""),
                        "image": record.get("image", ""),
                        "source": metadata.get("source", "unknown"),
                        "source_page": metadata.get("source_page", ""),
                        "download_url": metadata.get("download_url", ""),
                        "license": metadata.get("license", ""),
                        "license_url": metadata.get("license_url", ""),
                        "author": metadata.get("author", ""),
                        "title": metadata.get("title", ""),
                        "query": metadata.get("query", ""),
                        "stratum": metadata.get("stratum", "unknown"),
                        "region": metadata.get("region", "unknown"),
                        "country": metadata.get("country", ""),
                        "split": metadata.get("split", "audit") or "audit",
                        "candidate_prompts": metadata.get("candidate_prompts", ""),
                        "expected_prompts": metadata.get("expected_prompts", ""),
                        "prompt": prompt,
                        "threshold": float(entry.get("threshold", threshold_text)),
                        "ground_truth_found": bool(prompt_record.get("ground_truth_found")),
                        "ground_truth_positive": prompt_record.get("ground_truth_positive"),
                        "candidate_for_scene_heuristic": prompt_record.get("candidate_for_scene_heuristic"),
                        "expected_by_human": prompt_record.get("expected_by_human"),
                        **diagnostics,
                        "iou": metrics.get("iou"),
                        "dice": metrics.get("dice"),
                        "boundary_f1": metrics.get("boundary_f1"),
                        "pixel_precision": metrics.get("pixel_precision"),
                        "pixel_recall": metrics.get("pixel_recall"),
                        "encode_seconds": record.get("encode_seconds"),
                        "prompt_seconds": prompt_record.get("inference_seconds"),
                        "peak_gpu_memory_gib": record.get("peak_gpu_memory_gib"),
                    }
                )
    return rows


def choose_threshold(
    rows: list[dict[str, Any]],
    thresholds: list[float],
    core_classes: list[str],
    preferred: float,
) -> tuple[float, list[dict[str, Any]], str]:
    table: list[dict[str, Any]] = []
    for threshold in thresholds:
        relevant = [
            row
            for row in rows
            if math.isclose(row["threshold"], threshold)
            and row["split"] == "calibration"
            and row["ground_truth_found"]
            and row["ground_truth_positive"]
            and row["prompt"] in core_classes
        ]
        # Macro-average class means so common classes such as wall do not
        # dominate threshold selection over rarer classes.
        class_ious = []
        class_bf1s = []
        for prompt in core_classes:
            class_rows = [row for row in relevant if row["prompt"] == prompt]
            prompt_iou = mean_or_none(row["iou"] for row in class_rows)
            prompt_bf1 = mean_or_none(row["boundary_f1"] for row in class_rows)
            if prompt_iou is not None and prompt_bf1 is not None:
                class_ious.append(prompt_iou)
                class_bf1s.append(prompt_bf1)
        mean_iou = mean_or_none(class_ious)
        mean_bf1 = mean_or_none(class_bf1s)
        quality = (0.5 * mean_iou + 0.5 * mean_bf1) if mean_iou is not None and mean_bf1 is not None else None
        table.append(
            {
                "threshold": threshold,
                "calibration_positive_prompt_masks": len(relevant),
                "calibration_core_classes": len(class_ious),
                "mean_iou": mean_iou,
                "mean_boundary_f1": mean_bf1,
                "selection_score": quality,
            }
        )
    viable = [row for row in table if row["selection_score"] is not None]
    if not viable:
        chosen = min(thresholds, key=lambda value: abs(value - preferred))
        return chosen, table, "No positive calibration ground truth; used configured visual threshold."
    chosen_row = max(
        viable,
        key=lambda row: (row["selection_score"], -abs(row["threshold"] - preferred)),
    )
    return float(chosen_row["threshold"]), table, "Selected on positive calibration masks only."


def class_metrics(
    rows: list[dict[str, Any]],
    chosen_threshold: float,
    evaluation_split: str,
    core_classes: list[str],
    target_iou: float,
    target_bf1: float,
    max_fpr: float,
    min_positive: int,
    seed: int,
) -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = []
    classes = sorted(set(core_classes) | {row["prompt"] for row in rows})
    for class_index, prompt in enumerate(classes):
        selected = [
            row
            for row in rows
            if row["prompt"] == prompt
            and row["split"] == evaluation_split
            and row["ground_truth_found"]
            and math.isclose(row["threshold"], chosen_threshold)
        ]
        positives = [row for row in selected if row["ground_truth_positive"]]
        negatives = [row for row in selected if row["ground_truth_positive"] is False]
        ious = [float(row["iou"]) for row in positives if row["iou"] is not None]
        bf1s = [float(row["boundary_f1"]) for row in positives if row["boundary_f1"] is not None]
        iou_low, iou_high = bootstrap_mean_ci(ious, seed + class_index * 11)
        bf1_low, bf1_high = bootstrap_mean_ci(bf1s, seed + class_index * 11 + 1)
        false_positive_rate = (
            sum(bool(row.get("prediction_present")) for row in negatives) / len(negatives)
            if negatives
            else None
        )
        miss_rate = (
            sum(not bool(row.get("prediction_present")) for row in positives) / len(positives)
            if positives
            else None
        )
        enough = len(positives) >= min_positive
        pass_targets = (
            enough
            and iou_low is not None
            and bf1_low is not None
            and iou_low >= target_iou
            and bf1_low >= target_bf1
            and (false_positive_rate is None or false_positive_rate <= max_fpr)
        )
        output.append(
            {
                "prompt": prompt,
                "is_core_class": prompt in core_classes,
                "positive_test_masks": len(positives),
                "negative_test_masks": len(negatives),
                "mean_iou_positive": mean_or_none(ious),
                "iou_ci95_low": iou_low,
                "iou_ci95_high": iou_high,
                "mean_boundary_f1_positive": mean_or_none(bf1s),
                "boundary_f1_ci95_low": bf1_low,
                "boundary_f1_ci95_high": bf1_high,
                "mean_dice_positive": mean_or_none(row["dice"] for row in positives),
                "mean_pixel_precision_positive": mean_or_none(row["pixel_precision"] for row in positives),
                "mean_pixel_recall_positive": mean_or_none(row["pixel_recall"] for row in positives),
                "positive_image_miss_rate": miss_rate,
                "negative_image_false_positive_rate": false_positive_rate,
                "enough_positive_examples": enough,
                "passes_targets_with_ci": pass_targets,
            }
        )
    return output


def audit_metrics(rows: list[dict[str, Any]], chosen_threshold: float) -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = []
    for prompt in sorted({row["prompt"] for row in rows}):
        selected = [
            row
            for row in rows
            if row["prompt"] == prompt and math.isclose(row["threshold"], chosen_threshold)
        ]
        predictions = [row for row in selected if row.get("prediction_present")]
        output.append(
            {
                "prompt": prompt,
                "images": len(selected),
                "prediction_rate_not_accuracy": len(predictions) / len(selected) if selected else None,
                "median_area_ratio_when_predicted": median_or_none(row["area_ratio"] for row in predictions),
                "median_max_confidence_when_predicted": median_or_none(
                    row["max_model_confidence"] for row in predictions
                ),
                "p95_component_count_when_predicted": percentile(
                    [float(row["component_count"]) for row in predictions], 0.95
                ),
                "near_full_frame_rate": (
                    sum((row.get("area_ratio") or 0) > 0.90 for row in selected) / len(selected)
                    if selected
                    else None
                ),
                "high_fragmentation_rate": (
                    sum((row.get("component_count") or 0) > 12 for row in selected) / len(selected)
                    if selected
                    else None
                ),
                "candidate_prompt_miss_rate_heuristic": (
                    sum(
                        row.get("candidate_for_scene_heuristic") is True
                        and not row.get("prediction_present")
                        for row in selected
                    )
                    / sum(row.get("candidate_for_scene_heuristic") is True for row in selected)
                    if any(row.get("candidate_for_scene_heuristic") is True for row in selected)
                    else None
                ),
            }
        )
    return output


def source_coverage(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    groups: dict[tuple[str, str, str, str], set[str]] = defaultdict(set)
    for record in records:
        if record.get("status") != "ok":
            continue
        meta = record.get("metadata", {})
        key = (
            meta.get("source", "unknown"),
            meta.get("region", "unknown"),
            meta.get("stratum", "unknown"),
            meta.get("split", "audit"),
        )
        groups[key].add(record.get("image_id", ""))
    return [
        {
            "source": key[0],
            "region": key[1],
            "stratum": key[2],
            "split": key[3],
            "images": len(image_ids),
        }
        for key, image_ids in sorted(groups.items())
    ]


def annotation_queue(
    records: list[dict[str, Any]],
    rows: list[dict[str, Any]],
    chosen_threshold: float,
    limit: int,
) -> list[dict[str, Any]]:
    selected_rows = [row for row in rows if math.isclose(row["threshold"], chosen_threshold)]
    by_image: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in selected_rows:
        by_image[row["image_id"]].append(row)
    record_by_id = {record.get("image_id", ""): record for record in records}
    scored: list[tuple[float, dict[str, Any]]] = []
    for image_id, image_rows in by_image.items():
        reasons: list[str] = []
        prompts: list[str] = []
        score = 0.0
        for row in image_rows:
            prompt_reasons = list(row.get("diagnostic_flags") or [])
            if prompt_reasons:
                prompts.append(row["prompt"])
                reasons.extend(f"{row['prompt']}:{reason}" for reason in prompt_reasons)
                score += 0.12 * len(prompt_reasons)
            if row.get("candidate_for_scene_heuristic") is True and not row.get("prediction_present"):
                prompts.append(row["prompt"])
                reasons.append(f"{row['prompt']}:candidate_prompt_missing")
                score += 0.08
            if row.get("ground_truth_found") and row.get("ground_truth_positive") and row.get("iou") is not None:
                score += max(0.0, 1.0 - float(row["iou"]))
                if float(row["iou"]) < 0.5:
                    reasons.append(f"{row['prompt']}:iou_below_0.5")
                    prompts.append(row["prompt"])
        record = record_by_id.get(image_id, {})
        overlaps = record.get("cross_surface_iou_diagnostic", {})
        max_overlap = max(overlaps.values(), default=0.0)
        if max_overlap > 0.25:
            score += min(0.5, max_overlap)
            reasons.append(f"surface_prompt_overlap:{max_overlap:.3f}")
        metadata = record.get("metadata", {})
        if metadata.get("source") == "terucon_local":
            score += 0.10
        scored.append(
            (
                score,
                {
                    "priority_score": round(score, 4),
                    "image_id": image_id,
                    "image_path": record.get("image", ""),
                    "source": metadata.get("source", ""),
                    "region": metadata.get("region", ""),
                    "stratum": metadata.get("stratum", ""),
                    "split": metadata.get("split", ""),
                    "license": metadata.get("license", ""),
                    "source_page": metadata.get("source_page", ""),
                    "recommended_prompts_to_label": "|".join(sorted(set(prompts))),
                    "reasons": "|".join(sorted(set(reasons))),
                    "human_scene_type": "",
                    "human_review_notes": "",
                    "label_for_ground_truth": "",
                },
            )
        )
    scored.sort(key=lambda item: (-item[0], item[1]["image_id"]))
    return [row for _, row in scored[:limit]]


def write_csv(rows: list[dict[str, Any]], path: Path) -> None:
    if not rows:
        path.write_text("", encoding="utf-8")
        return
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)


def fmt(value: Any, digits: int = 3) -> str:
    if value is None:
        return "—"
    if isinstance(value, bool):
        return "yes" if value else "no"
    if isinstance(value, float):
        return f"{value:.{digits}f}"
    return html.escape(str(value))


def html_table(rows: list[dict[str, Any]], columns: list[tuple[str, str]]) -> str:
    header = "".join(f"<th>{html.escape(label)}</th>" for _, label in columns)
    body = []
    for row in rows:
        body.append("<tr>" + "".join(f"<td>{fmt(row.get(key))}</td>" for key, _ in columns) + "</tr>")
    return f"<div class='scroll'><table><thead><tr>{header}</tr></thead><tbody>{''.join(body)}</tbody></table></div>"


def write_html(
    path: Path,
    results: Path,
    summary: dict[str, Any],
    class_rows: list[dict[str, Any]],
    audit_rows: list[dict[str, Any]],
    coverage_rows: list[dict[str, Any]],
    queue_rows: list[dict[str, Any]],
    records: list[dict[str, Any]],
    max_cards: int,
) -> None:
    status = summary["decision"]["status"]
    status_class = {
        "NO_FINE_TUNING_REQUIRED": "good",
        "TARGETED_FINE_TUNING_RECOMMENDED": "bad",
        "INSUFFICIENT_GROUND_TRUTH": "warn",
    }.get(status, "warn")
    class_table = html_table(
        class_rows,
        [
            ("prompt", "Class"),
            ("positive_test_masks", "Positive GT"),
            ("negative_test_masks", "Negative GT"),
            ("mean_iou_positive", "Mean IoU"),
            ("iou_ci95_low", "IoU CI low"),
            ("mean_boundary_f1_positive", "Mean BF1"),
            ("boundary_f1_ci95_low", "BF1 CI low"),
            ("positive_image_miss_rate", "Miss rate"),
            ("negative_image_false_positive_rate", "FP image rate"),
            ("passes_targets_with_ci", "Pass"),
        ],
    )
    audit_table = html_table(
        audit_rows,
        [
            ("prompt", "Prompt"),
            ("images", "Images"),
            ("prediction_rate_not_accuracy", "Prediction rate"),
            ("median_area_ratio_when_predicted", "Median area"),
            ("median_max_confidence_when_predicted", "Median confidence"),
            ("p95_component_count_when_predicted", "P95 components"),
            ("near_full_frame_rate", "Full-frame rate"),
            ("high_fragmentation_rate", "Fragmentation rate"),
        ],
    )
    coverage_table = html_table(
        coverage_rows,
        [("source", "Source"), ("region", "Region"), ("stratum", "Stratum"), ("split", "Split"), ("images", "Images")],
    )
    record_by_id = {record.get("image_id", ""): record for record in records}
    cards = []
    for queue_row in queue_rows[:max_cards]:
        image_id = queue_row["image_id"]
        record = record_by_id.get(image_id, {})
        original = results / "images" / image_id / "original.jpg"
        overlay = results / "images" / image_id / "combined_overlay.jpg"
        original_rel = quote(os.path.relpath(original, path.parent).replace(os.sep, "/"), safe="/._-")
        overlay_rel = quote(os.path.relpath(overlay, path.parent).replace(os.sep, "/"), safe="/._-")
        metadata = record.get("metadata", {})
        source_link = metadata.get("source_page", "")
        source_html = (
            f"<a href='{html.escape(source_link)}' rel='noreferrer'>source</a>"
            if source_link
            else "private/local"
        )
        cards.append(
            f"""
            <article>
              <h3>{html.escape(image_id)}</h3>
              <div class="pair">
                <img src="{original_rel}" alt="original">
                <img src="{overlay_rel}" alt="SAM 3 overlay">
              </div>
              <p><b>Priority {queue_row['priority_score']}</b> · {html.escape(queue_row['reasons'] or 'coverage sample')}</p>
              <p class="muted">{html.escape(str(metadata.get('region', '')))} · {html.escape(str(metadata.get('stratum', '')))} · {html.escape(str(metadata.get('license', '')))} · {source_html}</p>
            </article>
            """
        )
    decision_text = html.escape(summary["decision"]["explanation"])
    report = f"""<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Terucon SAM 3 benchmark report</title>
<style>
:root{{--bg:#08111f;--panel:#111f33;--line:#2b405f;--text:#edf5ff;--muted:#9fb2ca;--good:#2bd576;--warn:#ffbd3f;--bad:#ff6470}}
*{{box-sizing:border-box}}body{{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,sans-serif}}main{{max-width:1320px;margin:auto;padding:28px}}
h1,h2,h3{{line-height:1.15}}.hero,.panel,article{{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:20px;margin:18px 0}}
.decision{{font-size:22px;font-weight:800}}.good{{color:var(--good)}}.warn{{color:var(--warn)}}.bad{{color:var(--bad)}}.muted{{color:var(--muted)}}
.stats{{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}}.stat{{background:#0b1729;border-radius:12px;padding:14px}}.stat b{{display:block;font-size:24px}}
.scroll{{overflow:auto}}table{{border-collapse:collapse;width:100%;min-width:760px}}th,td{{padding:9px 10px;text-align:left;border-bottom:1px solid var(--line)}}th{{position:sticky;top:0;background:#152944}}
.pair{{display:grid;grid-template-columns:1fr 1fr;gap:10px}}img{{width:100%;max-height:520px;object-fit:contain;background:#050b14;border-radius:10px}}a{{color:#76b9ff}}
code{{background:#07101c;padding:2px 5px;border-radius:4px}}@media(max-width:760px){{main{{padding:14px}}.pair{{grid-template-columns:1fr}}}}
</style></head><body><main>
<section class="hero">
  <p class="muted">Terucon · official Meta SAM 3 · India-focused benchmark</p>
  <h1>SAM 3 segmentation benchmark</h1>
  <p class="decision {status_class}">{html.escape(status.replace('_', ' '))}</p>
  <p>{decision_text}</p>
  <div class="stats">
    <div class="stat"><span>Completed images</span><b>{summary['dataset']['completed_images']}</b></div>
    <div class="stat"><span>Selected threshold</span><b>{summary['threshold_selection']['chosen_threshold']:.2f}</b></div>
    <div class="stat"><span>Held-out labeled images</span><b>{summary['decision']['held_out_labeled_images']}</b></div>
    <div class="stat"><span>Failed core classes</span><b>{len(summary['decision']['failed_core_classes'])}</b></div>
  </div>
</section>
<section class="panel"><h2>What this conclusion means</h2>
  <p>IoU and boundary F1 come only from explicit binary ground-truth masks. Internet images without masks are used only to find coverage gaps, prompt collisions, fragmented masks and operational failures. Model confidence is never reported as accuracy.</p>
  <p><b>Threshold selection:</b> {html.escape(summary['threshold_selection']['method'])} The held-out evaluation split is <code>{html.escape(summary['decision']['evaluation_split'])}</code>.</p>
</section>
<section class="panel"><h2>Ground-truth results by class</h2>{class_table}</section>
<section class="panel"><h2>Unlabeled/audit diagnostics</h2><p class="muted">These values describe output behavior; they do not prove correctness.</p>{audit_table}</section>
<section class="panel"><h2>Dataset coverage</h2>{coverage_table}</section>
<section class="panel"><h2>Fine-tuning rule</h2>
  <p>Recommend no fine-tuning only when there are at least {summary['targets']['minimum_test_images']} held-out labeled images, each assessed class has at least {summary['targets']['minimum_positive_examples_per_class']} positive masks, and the 95% confidence-interval lower bounds meet IoU ≥ {summary['targets']['mean_iou']:.2f} and boundary F1 ≥ {summary['targets']['mean_boundary_f1']:.2f}, with false-positive image rate ≤ {summary['targets']['maximum_false_positive_image_rate']:.2f}.</p>
  <p>Failed/insufficient core classes: <b>{html.escape(', '.join(summary['decision']['failed_core_classes'] + summary['decision']['insufficient_core_classes']) or 'none')}</b>.</p>
</section>
<h2>Highest-priority annotation/review examples</h2>
{''.join(cards) if cards else '<p>No visual cards were available.</p>'}
</main></body></html>"""
    path.write_text(report, encoding="utf-8")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--results", type=Path, required=True)
    parser.add_argument("--config", type=Path, default=None)
    parser.add_argument("--preferred-threshold", type=float, default=None)
    parser.add_argument("--min-test-images", type=int, default=None)
    parser.add_argument("--min-positive-per-class", type=int, default=None)
    parser.add_argument("--target-iou", type=float, default=None)
    parser.add_argument("--target-boundary-f1", type=float, default=None)
    parser.add_argument("--max-false-positive-rate", type=float, default=None)
    parser.add_argument("--annotation-queue-size", type=int, default=300)
    parser.add_argument("--max-report-cards", type=int, default=60)
    parser.add_argument("--seed", type=int, default=729)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    results = args.results.expanduser().resolve()
    records = load_records(results)
    rows = prompt_rows(records)
    if not rows:
        raise ValueError("No successful prompt results were found")
    run_config = load_json(results / "run_config.json") if (results / "run_config.json").is_file() else {}
    file_config = load_json(args.config) if args.config else {}
    quality = file_config.get("quality_targets", {})
    core_classes = file_config.get("core_classes") or DEFAULT_CORE_CLASSES
    thresholds = sorted({float(row["threshold"]) for row in rows})
    preferred = float(
        args.preferred_threshold
        if args.preferred_threshold is not None
        else file_config.get("visual_threshold", run_config.get("visual_threshold", 0.35))
    )
    target_iou = float(args.target_iou if args.target_iou is not None else quality.get("mean_iou", 0.75))
    target_bf1 = float(
        args.target_boundary_f1
        if args.target_boundary_f1 is not None
        else quality.get("mean_boundary_f1", 0.85)
    )
    max_fpr = float(
        args.max_false_positive_rate
        if args.max_false_positive_rate is not None
        else quality.get("maximum_false_positive_image_rate", 0.10)
    )
    min_test_images = int(
        args.min_test_images
        if args.min_test_images is not None
        else quality.get("minimum_test_images", 150)
    )
    min_positive = int(
        args.min_positive_per_class
        if args.min_positive_per_class is not None
        else quality.get("minimum_positive_examples_per_class", 30)
    )
    chosen_threshold, threshold_table, threshold_method = choose_threshold(
        rows, thresholds, core_classes, preferred
    )
    test_gt = [row for row in rows if row["split"] == "test" and row["ground_truth_found"]]
    evaluation_split = "test"
    exploratory_fallback = False
    if not test_gt:
        evaluation_split = "all_labeled_exploratory"
        exploratory_fallback = True
        for row in rows:
            if row["ground_truth_found"]:
                row["split"] = evaluation_split

    classes = class_metrics(
        rows,
        chosen_threshold,
        evaluation_split,
        core_classes,
        target_iou,
        target_bf1,
        max_fpr,
        min_positive,
        args.seed,
    )
    labeled_image_ids = {
        row["image_id"]
        for row in rows
        if row["split"] == evaluation_split
        and row["ground_truth_found"]
        and math.isclose(row["threshold"], chosen_threshold)
    }
    core_rows = [row for row in classes if row["is_core_class"]]
    insufficient_classes = [
        row["prompt"] for row in core_rows if not row["enough_positive_examples"]
    ]
    failed_classes = [
        row["prompt"]
        for row in core_rows
        if row["enough_positive_examples"] and not row["passes_targets_with_ci"]
    ]
    enough_total = len(labeled_image_ids) >= min_test_images and not exploratory_fallback
    if not enough_total or insufficient_classes:
        decision_status = "INSUFFICIENT_GROUND_TRUTH"
        explanation = (
            "Do not decide on fine-tuning yet. Build the stratified held-out mask set first; "
            "the current unlabeled confidence/overlay audit cannot measure segmentation accuracy."
        )
    elif failed_classes:
        decision_status = "TARGETED_FINE_TUNING_RECOMMENDED"
        explanation = (
            "Held-out ground truth is sufficient and one or more core classes miss the stated IoU, "
            "boundary or false-positive targets. Fine-tune only the failing classes after prompt and threshold calibration."
        )
    else:
        decision_status = "NO_FINE_TUNING_REQUIRED"
        explanation = (
            "All sufficiently represented core classes meet the conservative held-out targets. "
            "Use prompt/threshold calibration and production monitoring before investing in fine-tuning."
        )

    audit = audit_metrics(rows, chosen_threshold)
    coverage = source_coverage(records)
    queue = annotation_queue(records, rows, chosen_threshold, args.annotation_queue_size)
    completed = [record for record in records if record.get("status") == "ok"]
    errors = [record for record in records if record.get("status") != "ok"]
    output = results / "compiled"
    output.mkdir(exist_ok=True)
    write_csv(classes, output / "per_class_metrics.csv")
    write_csv(threshold_table, output / "threshold_selection.csv")
    write_csv(audit, output / "audit_diagnostics.csv")
    write_csv(coverage, output / "source_coverage.csv")
    write_csv(queue, output / "annotation_queue.csv")
    attribution = []
    for record in completed:
        metadata = record.get("metadata", {})
        if metadata.get("source") == "wikimedia_commons":
            attribution.append(
                {
                    "image_id": record.get("image_id", ""),
                    "title": metadata.get("title", ""),
                    "author": metadata.get("author", ""),
                    "license": metadata.get("license", ""),
                    "license_url": metadata.get("license_url", ""),
                    "source_page": metadata.get("source_page", ""),
                    "download_url": metadata.get("download_url", ""),
                }
            )
    write_csv(attribution, output / "ATTRIBUTION.csv")

    summary = {
        "dataset": {
            "records": len(records),
            "completed_images": len(completed),
            "error_images": len(errors),
            "sources": dict(Counter(record.get("metadata", {}).get("source", "unknown") for record in completed)),
            "regions": dict(Counter(record.get("metadata", {}).get("region", "unknown") for record in completed)),
        },
        "performance": {
            "mean_encode_seconds": mean_or_none(record.get("encode_seconds") for record in completed),
            "mean_prompt_seconds": mean_or_none(
                prompt_record.get("inference_seconds")
                for record in completed
                for prompt_record in record.get("prompts", {}).values()
            ),
            "max_peak_gpu_memory_gib": max(
                (record.get("peak_gpu_memory_gib", 0) for record in completed), default=None
            ),
        },
        "threshold_selection": {
            "chosen_threshold": chosen_threshold,
            "method": threshold_method,
            "table": threshold_table,
        },
        "targets": {
            "mean_iou": target_iou,
            "mean_boundary_f1": target_bf1,
            "maximum_false_positive_image_rate": max_fpr,
            "minimum_test_images": min_test_images,
            "minimum_positive_examples_per_class": min_positive,
        },
        "decision": {
            "status": decision_status,
            "explanation": explanation,
            "evaluation_split": evaluation_split,
            "exploratory_fallback": exploratory_fallback,
            "held_out_labeled_images": len(labeled_image_ids),
            "failed_core_classes": failed_classes,
            "insufficient_core_classes": insufficient_classes,
        },
        "per_class": classes,
        "audit_diagnostics_not_accuracy": audit,
        "important_warning": (
            "Model confidence, edge alignment, prediction rate and search-query relevance are not accuracy. "
            "Only ground-truth masks drive the fine-tuning decision."
        ),
    }
    (output / "decision.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    write_html(
        results / "compiled_report.html",
        results,
        summary,
        classes,
        audit,
        coverage,
        queue,
        records,
        args.max_report_cards,
    )
    print(json.dumps(summary["decision"], indent=2))
    print(f"\nCompiled report: {results / 'compiled_report.html'}")
    print(f"Decision JSON:   {output / 'decision.json'}")
    print(f"Annotation queue:{output / 'annotation_queue.csv'}")


if __name__ == "__main__":
    main()
