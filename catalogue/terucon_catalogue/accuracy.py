"""Tools to MEASURE how well the closest-item search works, without changing how it works (2026-11-04, the "accuracy is very bad" report).

Nothing here is on the search path: the service never imports this module. It is for people and scripts (catalogue/tools/accuracy_eval.py,
tools/catalogue-probe.mjs) that want numbers they can re-run before and after a change, so every function is pure numpy / OpenCV and has a test.

  swatch_box / trim_page_margins   where the PICTURE is inside a catalogue page crop (the engine indexes the whole page: a white margin all round and the
                                   printed label under the picture; about 29 % of the pixels of every SuperBond crop). Used to cut clean test queries, and
                                   ready for a re-ingest that indexes the picture alone (catalogue/ARCHITECTURE.md section 5.1 has the plan; it is not wired in).
  make_query                       synthetic phone-photo queries cut from a clean swatch (V1 whole capture, V2 patch of 24 % with lighting jitter, V3 a pale,
                                   magnified 12 % patch). They are built from the picture alone, so they are NOT the index entry (a query that carries the
                                   page's margin and label, as the notebook's benchmark did, hides exactly the problem a real photo has).
  table_from_answer / refuse       take the raw per-signal similarities of ONE live answer (k = 60 returns every signal's `sim` and `rank` for 60 designs)
                                   and re-fuse them offline with other signals or weights: the same arithmetic as search.HybridRetriever.rank_signals
                                   (tests/test_accuracy.py proves it against the real class). One live call therefore answers "what would fast, balanced and
                                   full have said?" without three calls.
  product_rank / hits              the metric: where the first right DESIGN (a product id; a design printed on two pages is one design) first appears.

Whatever the numbers say, they are about the named set that was built here (synthetic queries from the catalogue's own pictures plus two photos of one gym
floor), never about real photos of physical samples; no accuracy figure exists until those are collected.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

import numpy as np

# the group of every query signal (the notebook's PILLAR_GROUPS applied to the query-side names) and which signals each profile computes
SIGNAL_GROUPS = {"dino_image": "dino", "siglip_image": "mm", "vertex_mm_image": "mm", "color_image": "color", "text_from_photo": "text",
                 "siglip_text": "mm", "text_query": "text", "vertex_mm_text": "mm"}
PROFILE_SIGNALS = {
    "fast": ("dino_image", "siglip_image", "color_image"),
    "balanced": ("dino_image", "siglip_image", "color_image", "vertex_mm_image"),
    "full": ("dino_image", "siglip_image", "color_image", "vertex_mm_image", "text_from_photo"),
}
PHOTO_GROUP_WEIGHTS = {"dino": 0.35, "mm": 0.25, "color": 0.25, "text": 0.15}   # config.DEFAULT_PHOTO_WEIGHTS


# ------------------------------------------------------------------------------------------------------------------------
# the picture inside a catalogue page
# ------------------------------------------------------------------------------------------------------------------------
def _longest_run(flags: np.ndarray) -> Tuple[int, int]:
    best, start = (0, 0), None
    for index, flag in enumerate(list(flags) + [False]):
        if flag and start is None:
            start = index
        elif not flag and start is not None:
            if index - start > best[1] - best[0]:
                best = (start, index)
            start = None
    return best


def swatch_box(rgb: np.ndarray, *, white: int = 250, min_fraction: float = 0.4) -> Tuple[int, int, int, int]:
    """(left, top, right, bottom) of the picture inside a page crop: the biggest block of rows and then of columns in which more than half the pixels are not
    white (any channel below `white`). The printed label is thin text, so it is never part of the block. Returns the whole image when there is no white
    margin to speak of, when the page is all white, or when the block found is smaller than `min_fraction` of the image (then it cannot be trusted)."""
    height, width = rgb.shape[:2]
    whole = (0, 0, width, height)
    nonwhite = (rgb < white).any(axis=2)
    top, bottom = _longest_run(nonwhite.mean(axis=1) > 0.5)
    if bottom <= top:
        return whole
    left, right = _longest_run(nonwhite[top:bottom].mean(axis=0) > 0.5)
    if right <= left or (right - left) * (bottom - top) < min_fraction * width * height:
        return whole
    return left, top, right, bottom


def trim_page_margins(rgb: np.ndarray, inset: float = 0.01) -> np.ndarray:
    """The picture of a page crop, with `inset` (a fraction of each side) taken off again so no edge pixel of the page shows. A full-bleed image comes back as it is."""
    left, top, right, bottom = swatch_box(rgb)
    if (left, top, right, bottom) == (0, 0, rgb.shape[1], rgb.shape[0]):
        return rgb
    dx, dy = int((right - left) * inset), int((bottom - top) * inset)
    return np.ascontiguousarray(rgb[top + dy:bottom - dy, left + dx:right - dx])


# ------------------------------------------------------------------------------------------------------------------------
# synthetic queries from a clean swatch
# ------------------------------------------------------------------------------------------------------------------------
QUERY_VARIANTS = ("V1", "V2", "V3")


def _jpeg(rgb: np.ndarray, quality: float) -> np.ndarray:
    import io
    from PIL import Image
    buffer = io.BytesIO()
    Image.fromarray(rgb).save(buffer, "JPEG", quality=int(quality))
    buffer.seek(0)
    return np.asarray(Image.open(buffer).convert("RGB"))


def _photometric(rgb: np.ndarray, rng, strong: bool = False) -> np.ndarray:
    import cv2
    image = rgb.astype(np.float32) * rng.uniform(0.9, 1.12, size=3)
    height, width = image.shape[:2]
    yy, xx = np.mgrid[0:height, 0:width].astype(np.float32)
    angle = rng.uniform(0, 2 * np.pi)
    gradient = np.cos(angle) * xx / width + np.sin(angle) * yy / height
    image = image * (0.88 + 0.24 * (gradient - gradient.min()) / max(float(np.ptp(gradient)), 1e-6))[:, :, None]
    image = 255.0 * np.power(np.clip(image / 255.0, 0, 1), rng.uniform(0.85, 1.2))
    sigma = rng.uniform(0.0, 1.2 if strong else 0.7)
    if sigma > 0.2:
        image = cv2.GaussianBlur(image, (0, 0), sigma)
    image = image + rng.normal(0, rng.uniform(2, 5), size=image.shape)
    return np.clip(image, 0, 255).astype(np.uint8)


def _patch(swatch: np.ndarray, rng, fraction: float, side: int) -> np.ndarray:
    import cv2
    height, width = swatch.shape[:2]
    size = max(16, int(round(fraction * min(height, width))))
    top = int(rng.integers(0, max(1, height - size + 1)))
    left = int(rng.integers(0, max(1, width - size + 1)))
    crop = swatch[top:top + size, left:left + size]
    return cv2.resize(crop, (side, side), interpolation=cv2.INTER_AREA if size > side else cv2.INTER_CUBIC)


def make_query(swatch: np.ndarray, variant: str, seed: int) -> np.ndarray:
    """A synthetic query cut from a clean swatch (uint8 RGB). V1: the notebook's SyntheticPhoneCapture of the whole swatch (table, perspective, white-balance
    cast, uneven light, blur, noise, JPEG), at most 1024 px, to be sent with no region. V2: a patch of 24 % of the shorter side at a random place, light
    jitter, 184 px, JPEG: what a reticle search sends. V3: a patch of 12 % magnified to 184 px, 35 % less saturated, brighter, blurred: a pale, flat patch,
    the hardest case, like the pale tan floor in the report."""
    from .search import SyntheticPhoneCapture
    from .util import resize_max_side
    if variant == "V1":
        return np.ascontiguousarray(resize_max_side(SyntheticPhoneCapture(seed)(swatch), 1024))
    rng = np.random.default_rng(seed)
    if variant == "V2":
        return _jpeg(_photometric(_patch(swatch, rng, 0.24, 184), rng), rng.uniform(70, 86))
    if variant == "V3":
        crop = _patch(swatch, rng, 0.12, 184).astype(np.float32)
        grey = crop.mean(axis=2, keepdims=True)
        crop = np.clip((grey + 0.65 * (crop - grey)) * 1.10 + 8, 0, 255).astype(np.uint8)
        return _jpeg(_photometric(crop, rng, strong=True), rng.uniform(68, 82))
    raise ValueError(f"variant must be one of {', '.join(QUERY_VARIANTS)}")


# ------------------------------------------------------------------------------------------------------------------------
# re-fusing the raw signals of one live answer
# ------------------------------------------------------------------------------------------------------------------------
@dataclass
class AnswerTable:
    item_ids: List[str]
    signals: List[str]
    sims: Dict[str, np.ndarray]          # NaN where the design has no vector in that pillar
    ranks: Dict[str, np.ndarray]         # the service's own rank among the WHOLE pool (not only the returned rows)
    final: np.ndarray                    # the service's own finalScore
    weights: Optional[Dict[str, float]]  # the service's own signal weights (query.weights), when the answer carried them


def table_from_answer(answer: Mapping[str, Any]) -> AnswerTable:
    results = answer["results"]
    if not results:
        raise ValueError("The answer has no results.")
    names = list(results[0]["signals"].keys())
    sims = {name: np.array([np.nan if row["signals"][name]["sim"] is None else row["signals"][name]["sim"] for row in results], dtype=float) for name in names}
    ranks = {name: np.array([row["signals"][name]["rank"] for row in results], dtype=float) for name in names}
    weights = (answer.get("query") or {}).get("weights") or None
    return AnswerTable([row["itemId"] for row in results], names, sims, ranks, np.array([row["finalScore"] for row in results], dtype=float),
                       {name: float(value) for name, value in weights.items()} if weights else None)


def signal_weights(names: Iterable[str], group_weights: Optional[Mapping[str, float]] = None) -> Dict[str, float]:
    """search.HybridRetriever._signal_weights: a group's weight is shared by its signals and renormalised over the groups that are present."""
    group_weights = dict(group_weights or PHOTO_GROUP_WEIGHTS)
    names = [name for name in names if SIGNAL_GROUPS.get(name) and group_weights.get(SIGNAL_GROUPS[name], 0.0) > 0]
    counts: Dict[str, int] = {}
    for name in names:
        counts[SIGNAL_GROUPS[name]] = counts.get(SIGNAL_GROUPS[name], 0) + 1
    total = sum(group_weights[group] for group in counts)
    return {name: group_weights[SIGNAL_GROUPS[name]] / total / counts[SIGNAL_GROUPS[name]] for name in names} if total > 0 else {}


def calibrate_pool_ends(table: AnswerTable, rrf_k: int = 60, hybrid_lambda: float = 0.5) -> Dict[str, Tuple[float, float]]:
    """The lowest and highest similarity of each signal over the WHOLE pool, which the linear half of the fusion normalises by. The answer only holds the
    rows the service returned (the lowest-ranked rows and a design's repeated pages are missing, and a cover page is a far outlier), so the low end cannot be
    read off. The high end can, when the row the service ranked first for a signal is in the answer (its similarity is the maximum). The low end follows from the
    service's own scores: each row's linear score is sum_n w_n (sim_ni - lo_n) / (hi_n - lo_n) / sum w, which is linear in the slopes a_n = 1/(hi_n - lo_n) plus a
    constant that is the same for every row, so a least-squares fit over the returned rows gives a_n and then lo_n = hi_n - 1/a_n. If the first row of ONE signal
    was dropped (a repeated page of a design can be that row), the constant, -sum w_n a_n lo_n, pins that signal's ends instead. Two or more signals without their first
    row cannot be resolved: that is an error, not a guess. Needs more rows than signals (k = 60 of a 69-row pool gives plenty)."""
    weights = table.weights or signal_weights(table.signals)
    names = [name for name in table.signals if name in weights]
    total = sum(weights[name] for name in names)
    valid = np.all([~np.isnan(table.sims[name]) for name in names], axis=0)
    rrf = sum(np.where(np.isnan(table.sims[name]), 0.0, weights[name] / (rrf_k + table.ranks[name])) for name in names) / (total / (rrf_k + 1))
    target = (table.final - hybrid_lambda * rrf) / (1.0 - hybrid_lambda) * total          # sum_n w_n norm_n for every row
    first_known = {name: bool((table.ranks[name][~np.isnan(table.sims[name])]).size and (table.ranks[name][~np.isnan(table.sims[name])]).min() == 1) for name in names}
    unknown = [name for name in names if not first_known[name]]
    if len(unknown) > 1:
        raise ValueError(f"The rows ranked first for {', '.join(unknown)} are not in the answer, so their highest similarities are not known: ask for k = 60.")
    if int(valid.sum()) < len(names) + 3:
        raise ValueError("Too few rows to recover the pool's ends: ask for k = 60.")
    design = np.stack([weights[name] * table.sims[name][valid] for name in names] + [np.ones(int(valid.sum()))], axis=1)
    coefficients, *_ = np.linalg.lstsq(design, target[valid], rcond=None)
    slope = {name: float(coefficients[index]) for index, name in enumerate(names)}
    intercept = float(coefficients[-1])
    ends: Dict[str, Tuple[float, float]] = {}
    for name in names:
        if first_known[name]:
            high = float(np.nanmax(table.sims[name]))
            ends[name] = (high - 1.0 / slope[name] if abs(slope[name]) > 1e-9 else float(np.nanmin(table.sims[name])), high)
    if unknown:
        # one signal whose first row was dropped: the constant of the fit, intercept = -sum_n w_n a_n lo_n, pins its low end once all the others are known
        name = unknown[0]
        others = sum(weights[other] * slope[other] * ends[other][0] for other in names if other != name)
        low = -(intercept + others) / (weights[name] * slope[name])
        ends[name] = (float(low), float(low + 1.0 / slope[name]))
    return ends


def refuse(table: AnswerTable, signals: Optional[Sequence[str]] = None, group_weights: Optional[Mapping[str, float]] = None, *, fusion: str = "hybrid",
           rrf_k: int = 60, hybrid_lambda: float = 0.5, ends: Optional[Mapping[str, Tuple[float, float]]] = None) -> np.ndarray:
    """Final scores of the returned rows under another set of signals / group weights / fusion ('hybrid', 'rrf', 'linear'): HybridRetriever.rank_signals'
    arithmetic over the recorded per-signal ranks (exact RRF) and similarities (linear part, with the pool's ends from calibrate_pool_ends)."""
    names = [name for name in table.signals if signals is None or name in signals]
    weights = signal_weights(names, group_weights)
    names = [name for name in names if name in weights]
    if not names:
        raise ValueError("No usable signal.")
    ends = ends or calibrate_pool_ends(table, rrf_k, hybrid_lambda)
    total = sum(weights.values())
    rrf = np.zeros(len(table.item_ids))
    linear = np.zeros(len(table.item_ids))
    for name in names:
        sims = table.sims[name]
        rrf += np.where(np.isnan(sims), 0.0, weights[name] / (rrf_k + table.ranks[name]))      # a design with no vector in a pillar adds nothing there
        low, high = ends[name]
        linear += weights[name] * np.where(np.isnan(sims), 0.0, (sims - low) / (high - low) if high - low > 1e-9 else 1.0)
    rrf_score = rrf / (total / (rrf_k + 1))
    linear_score = linear / total
    if fusion == "rrf":
        return rrf_score
    if fusion == "linear":
        return linear_score
    return hybrid_lambda * rrf_score + (1.0 - hybrid_lambda) * linear_score


def ordered(table: AnswerTable, scores: np.ndarray) -> List[str]:
    """Item ids best first (a stable sort, like the service's)."""
    return [table.item_ids[index] for index in np.argsort(-scores, kind="stable")]


# ------------------------------------------------------------------------------------------------------------------------
# the metric
# ------------------------------------------------------------------------------------------------------------------------
def product_rank(order: Sequence[str], truth: Iterable[str], product_of: Mapping[str, str], *, missing: int = 99) -> int:
    """1-based place of the first DESIGN of `truth` in the list, counting a design once however many pages it is printed on (`product_of`: item id -> product
    id). `missing` when none of them is listed."""
    wanted = set(truth)
    seen: List[str] = []
    for item_id in order:
        product = product_of.get(item_id, item_id)
        if product not in seen:
            seen.append(product)
        if product in wanted:
            return len(seen)
    return missing


def hits(ranks: Iterable[int], ks: Sequence[int] = (1, 3, 8)) -> Dict[int, int]:
    """How many of the ranks are within each k."""
    ranks = list(ranks)
    return {k: sum(1 for rank in ranks if rank <= k) for k in ks}
