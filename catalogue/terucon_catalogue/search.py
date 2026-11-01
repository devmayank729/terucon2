"""Hybrid multi-vector retrieval over a published release: the notebook's cell 6 without FAISS and without pandas.

Ported from terucon-cat-1.ipynb (cell 6). The retrieval maths is copied verbatim: PILLAR_GROUPS, the photo preprocessing (card detection ->
perspective rectification, else an 80 % centre crop), the signal and group weights, reciprocal-rank fusion + min-max linear fusion + the hybrid
blend, the de-duplication rule, SyntheticPhoneCapture. What changes is marked "PORT:" (needed to run as a service) or "NEW:" (not in the
notebook, and unmeasured unless a docstring says otherwise):

  PORT  the index is a `release_reader.LoadedRelease` (numpy matrices from items.json + pillars/*.npy), not a SQLite store + FAISS.
        The notebook scored every item exactly below 50,000 items and only then used FAISS to pick a candidate pool; this scores every item
        exactly at any size, which is the same ranking (a flat FAISS index is an exact inner product).
  PORT  results are plain dicts (the HTTP shape of ARCHITECTURE.md section 6), not a pandas frame; no matplotlib.
  PORT  the encoder / retriever are async-native: model forward passes run in worker threads (asyncio.to_thread), Vertex / Gemini calls are
        awaited on the caller's loop, and the notebook's AsyncRunner is gone.
  NEW   `RegionSpec` / `QueryPhotoPreprocessor.prepare_region`: "point to find" (ARCHITECTURE.md section 5). Skips card detection and the centre crop.
  NEW   `photo_plan`: the search profiles (config.SEARCH_PROFILES) and the colour-only mode choose which signals are computed. In colour mode the
        neural encoders are not run at all: the notebook's `weights=` override would drop their (zero-weight) signals after computing them.
  NEW   warnings when a signal is skipped (Vertex absent, the release has no vectors for its pillar); failures of optional signals are warnings.

No import-time side effects; nothing here imports torch / transformers / google.* (the encoder bank, the Vertex manager and the Gemini
synthesizer are injected, duck-typed).
"""
from __future__ import annotations

import asyncio
import importlib
import inspect
import logging
import math
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Mapping, Optional, Sequence, Tuple

import cv2
import numpy as np

from .config import COLOUR_ONLY_WEIGHTS, DEFAULT_SEARCH_PROFILE, SEARCH_PROFILES
from .release_reader import BadRequestError, LoadedRelease, ServiceError
from .schema import compose_search_document
from .util import encode_rgb, load_rgb, resize_max_side

LOGGER = logging.getLogger("catalogue.search")

PILLAR_GROUPS = {"dino": "dino", "siglip": "mm", "vertex_mm": "mm", "color": "color", "text": "text"}

DEFAULT_REGION_RADIUS = 0.12     # NEW: half-side as a fraction of the SHORTER image side, i.e. a square of 24 % of it
MIN_REGION_PX = 16               # NEW: same floor the notebook's center_crop uses (max(16, ...))
MAX_TOP_K = 60
MODES = ("look", "colour")


def _ms_since(started: float) -> float:
    return round((time.perf_counter() - started) * 1000.0, 1)


# ------------------------------------------------------------------------------------------------------------------------
# NEW: region ("point to find")
# ------------------------------------------------------------------------------------------------------------------------
def _unit_float(value: Any, name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not 0.0 <= float(value) <= 1.0:
        raise BadRequestError(f"{name} must be a number between 0 and 1.")
    return float(value)


@dataclass(frozen=True)
class RegionSpec:
    """Where in the sent image the thing of interest is, as fractions of its width / height (0..1).

    point + radius: a square centred on the point whose half-side is `radius` x the SHORTER image side (default 0.12, so 24 % of it), clipped
    to the image. box: x0, y0, x1, y1. Either way the window is grown to at least MIN_REGION_PX pixels on a side if it is smaller.
    """
    point: Optional[Tuple[float, float]] = None
    radius: float = DEFAULT_REGION_RADIUS
    box: Optional[Tuple[float, float, float, float]] = None

    @classmethod
    def from_params(cls, point: Optional[Sequence[float]] = None, radius: Optional[float] = None,
                    box: Optional[Sequence[float]] = None) -> Optional["RegionSpec"]:
        """Validate the request's point / radius / box; None when no region was asked for. Raises BadRequestError."""
        if point is None and box is None:
            if radius is not None:
                raise BadRequestError("radius only applies together with point.")
            return None
        if point is not None and box is not None:
            raise BadRequestError("Send either point or box, not both.")
        if box is not None:
            if radius is not None:
                raise BadRequestError("radius applies to point, not to box.")
            if not isinstance(box, (list, tuple)) or len(box) != 4:
                raise BadRequestError("box must be x0,y0,x1,y1.")
            x0, y0, x1, y1 = (_unit_float(v, "box") for v in box)
            if not (x0 < x1 and y0 < y1):
                raise BadRequestError("box must be ordered: x0 < x1 and y0 < y1.")
            return cls(box=(x0, y0, x1, y1))
        if not isinstance(point, (list, tuple)) or len(point) != 2:
            raise BadRequestError("point must be x,y.")
        px, py = (_unit_float(v, "point") for v in point)
        if radius is None:
            radius = DEFAULT_REGION_RADIUS
        if isinstance(radius, bool) or not isinstance(radius, (int, float)) or not math.isfinite(radius) or not 0.0 < float(radius) <= 1.0:
            raise BadRequestError("radius must be a number above 0 and at most 1.")
        return cls(point=(px, py), radius=float(radius))

    def window(self, height: int, width: int) -> Tuple[int, int, int, int]:
        """(left, top, right, bottom) in pixels; right / bottom exclusive. Clipped to the image, then grown to the minimum size."""
        if self.box is not None:
            x0, y0, x1, y1 = self.box
            left, right = int(round(x0 * width)), int(round(x1 * width))
            top, bottom = int(round(y0 * height)), int(round(y1 * height))
        else:
            half = self.radius * min(height, width)
            centre_x, centre_y = self.point[0] * width, self.point[1] * height
            left, right = int(round(centre_x - half)), int(round(centre_x + half))
            top, bottom = int(round(centre_y - half)), int(round(centre_y + half))
        left, right = max(0, left), min(width, right)
        top, bottom = max(0, top), min(height, bottom)
        left, right = _grow(left, right, width, MIN_REGION_PX)
        top, bottom = _grow(top, bottom, height, MIN_REGION_PX)
        return left, top, right, bottom


def _grow(low: int, high: int, limit: int, minimum: int) -> Tuple[int, int]:
    if high - low >= minimum:
        return low, high
    if limit <= minimum:
        return 0, limit
    low = int(round((low + high) / 2.0 - minimum / 2.0))
    high = low + minimum
    if low < 0:
        low, high = 0, minimum
    if high > limit:
        low, high = limit - minimum, limit
    return low, high


# ------------------------------------------------------------------------------------------------------------------------
# the photo preprocessor (verbatim) + the region path
# ------------------------------------------------------------------------------------------------------------------------
@dataclass
class PreparedQuery:
    original_rgb: np.ndarray
    rectified_rgb: np.ndarray
    method: str
    quad: Optional[List[List[float]]]


class QueryPhotoPreprocessor:
    """Phone photo -> rectified swatch: perspective-correct a detected card/sample, else center-crop."""

    def __init__(self, cfg):
        self.cfg = cfg

    @staticmethod
    def _order_corners(points):
        sums = points.sum(axis=1)
        differences = np.diff(points, axis=1).ravel()
        top_left = points[np.argmin(sums)]
        bottom_right = points[np.argmax(sums)]
        top_right = points[np.argmin(differences)]
        bottom_left = points[np.argmax(differences)]
        return np.array([top_left, top_right, bottom_right, bottom_left], dtype=np.float32)

    def detect_quad(self, rgb):
        height, width = rgb.shape[:2]
        scale = min(1.0, 1024.0 / max(height, width))
        small = cv2.resize(rgb, (int(width * scale), int(height * scale)), interpolation=cv2.INTER_AREA) if scale < 1 else rgb
        gray = cv2.GaussianBlur(cv2.cvtColor(small, cv2.COLOR_RGB2GRAY), (5, 5), 0)
        edges = cv2.dilate(cv2.Canny(gray, 50, 150), np.ones((3, 3), np.uint8), iterations=2)
        contour_result = cv2.findContours(edges, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
        contours = contour_result[0] if len(contour_result) == 2 else contour_result[1]
        image_area = float(small.shape[0] * small.shape[1])
        best_quad = None
        best_area = 0.0
        for contour in sorted(contours, key=cv2.contourArea, reverse=True)[:15]:
            perimeter = cv2.arcLength(contour, True)
            approx = cv2.approxPolyDP(contour, 0.02 * perimeter, True)
            if len(approx) != 4 or not cv2.isContourConvex(approx):
                continue
            area = float(cv2.contourArea(approx))
            if area < self.cfg.rectify_min_area_fraction * image_area or area > 0.97 * image_area:
                continue
            corners = self._order_corners(approx.reshape(4, 2).astype(np.float32))
            side_lengths = [np.linalg.norm(corners[index] - corners[(index + 1) % 4]) for index in range(4)]
            if min(side_lengths) < 0.2 * max(side_lengths):
                continue
            if area > best_area:
                best_area = area
                best_quad = corners / scale
        return best_quad

    @staticmethod
    def warp_quad(rgb, corners):
        top_left, top_right, bottom_right, bottom_left = corners
        width = int(round(max(np.linalg.norm(bottom_right - bottom_left), np.linalg.norm(top_right - top_left))))
        height = int(round(max(np.linalg.norm(top_right - bottom_right), np.linalg.norm(top_left - bottom_left))))
        width = max(width, 16)
        height = max(height, 16)
        destination = np.array([[0, 0], [width - 1, 0], [width - 1, height - 1], [0, height - 1]], dtype=np.float32)
        matrix = cv2.getPerspectiveTransform(corners.astype(np.float32), destination)
        warped = cv2.warpPerspective(rgb, matrix, (width, height), flags=cv2.INTER_CUBIC)
        inset_x = int(round(width * 0.03))
        inset_y = int(round(height * 0.03))
        return warped[inset_y: height - inset_y, inset_x: width - inset_x]

    def center_crop(self, rgb):
        height, width = rgb.shape[:2]
        fraction = self.cfg.query_center_crop_fraction
        crop_height = max(16, int(round(height * fraction)))
        crop_width = max(16, int(round(width * fraction)))
        top = (height - crop_height) // 2
        left = (width - crop_width) // 2
        return rgb[top: top + crop_height, left: left + crop_width]

    def prepare(self, source):
        rgb = load_rgb(source)
        quad = self.detect_quad(rgb)
        if quad is not None:
            rectified = np.ascontiguousarray(self.warp_quad(rgb, quad))
            return PreparedQuery(rgb, rectified, "perspective_rectified", quad.round(1).tolist())
        return PreparedQuery(rgb, np.ascontiguousarray(self.center_crop(rgb)), "center_crop", None)

    # NEW: the region path. No card detection, no centre crop: the crop IS the window the user pointed at.
    def prepare_region(self, source, region: RegionSpec) -> PreparedQuery:
        rgb = load_rgb(source)
        left, top, right, bottom = region.window(rgb.shape[0], rgb.shape[1])
        return PreparedQuery(rgb, np.ascontiguousarray(rgb[top:bottom, left:right]), "region", None)


# ------------------------------------------------------------------------------------------------------------------------
# NEW: which signals a photo query computes
# ------------------------------------------------------------------------------------------------------------------------
@dataclass(frozen=True)
class PhotoPlan:
    neural: bool                 # run DINOv2 + SigLIP (the GPU part)
    use_vertex_mm: bool
    describe: bool
    weights: Optional[Dict[str, float]]   # the notebook's `weights=` group override (None = the default photo weights)


def photo_plan(mode: str = "look", profile: Optional[str] = None) -> PhotoPlan:
    """mode "colour": the colour signal only (config.COLOUR_ONLY_WEIGHTS), no neural encoders, no Vertex, no description.
    mode "look": the profile (config.SEARCH_PROFILES): fast = dino + siglip + colour; balanced adds the Vertex image embedding; full adds the
    Gemini description of the photo and its embedding."""
    if mode not in MODES:
        raise BadRequestError(f"mode must be one of {', '.join(MODES)}.")
    if mode == "colour":
        return PhotoPlan(neural=False, use_vertex_mm=False, describe=False, weights=dict(COLOUR_ONLY_WEIGHTS))
    name = profile or DEFAULT_SEARCH_PROFILE
    if name not in SEARCH_PROFILES:
        raise BadRequestError(f"profile must be one of {', '.join(SEARCH_PROFILES)}.")
    chosen = SEARCH_PROFILES[name]
    return PhotoPlan(neural=True, use_vertex_mm=bool(chosen["use_vertex_mm"]), describe=bool(chosen["describe"]), weights=None)


# ------------------------------------------------------------------------------------------------------------------------
# signals and the query encoder
# ------------------------------------------------------------------------------------------------------------------------
@dataclass
class QuerySignal:
    name: str
    pillar: str
    group: str
    vector: np.ndarray


def resolve_color_function(cfg) -> Callable[[np.ndarray], Any]:
    """The notebook's `compute_lab_color_descriptor(rgb, ColorParams.from_config(cfg))` from the compute side (features.py), imported only when
    a QueryEncoder is built without an explicit `color_fn`. The object it returns has .vector, .dominant_hex, .proportions."""
    last_error: Optional[BaseException] = None
    for module_name in (".features", ".encoders"):
        try:
            module = importlib.import_module(module_name, package=__package__)
        except ImportError as exc:
            last_error = exc
            continue
        params_class = getattr(module, "ColorParams", None)
        function = getattr(module, "compute_lab_color_descriptor", None)
        if params_class is not None and function is not None:
            params = params_class.from_config(cfg)
            return lambda rgb: function(rgb, params)
    raise RuntimeError("The colour descriptor (ColorParams / compute_lab_color_descriptor, notebook cell 4) was not found in "
                       "terucon_catalogue.features; pass color_fn= to QueryEncoder.") from last_error


class QueryEncoder:
    """Photo / text -> QuerySignal list. PORT: async; `encoders` is the compute side's EncoderBank, `manager` the VertexGenAIManager and
    `synthesizer` the GeminiMaterialSynthesizer (all duck-typed, any may be None). `gpu_gate`, if given, has `async with gate.slot()` and
    serialises the neural forward passes."""

    def __init__(self, cfg, encoders, manager=None, synthesizer=None, *, gpu_gate=None, color_fn: Optional[Callable] = None):
        self.cfg = cfg
        self.encoders = encoders
        self.manager = manager
        self.synthesizer = synthesizer
        self.gpu_gate = gpu_gate
        self.preprocessor = QueryPhotoPreprocessor(cfg)
        self._color_fn = color_fn

    @property
    def color_fn(self) -> Callable:
        if self._color_fn is None:
            self._color_fn = resolve_color_function(self.cfg)
        return self._color_fn

    def _vertex_mm_enabled(self):
        return (self.manager is not None and self.cfg.enable_vertex_multimodal_embedding
                and "vertex_mm" not in getattr(self.manager, "disabled_features", ()))

    async def _gpu(self, function, *args, **kwargs):
        if self.gpu_gate is None:
            return await asyncio.to_thread(function, *args, **kwargs)
        async with self.gpu_gate.slot():
            return await asyncio.to_thread(function, *args, **kwargs)

    # ---- optional network signals: each returns (signal | None, warning | None, elapsed_ms[, extra])
    async def _vertex_image(self, jpeg_bytes):
        started = time.perf_counter()
        try:
            embedding = await self.manager.multimodal_embed(image_bytes=jpeg_bytes)
            return QuerySignal("vertex_mm_image", "vertex_mm", "mm", embedding["image"]), None, _ms_since(started)
        except Exception as exc:
            LOGGER.warning("Vertex multimodal query embedding failed: %s: %s", type(exc).__name__, str(exc)[:200])
            return None, f"vertex_mm_image unavailable ({type(exc).__name__}).", _ms_since(started)

    async def _describe(self, jpeg_bytes, color):
        started = time.perf_counter()
        try:
            color_meta = {"dominant_hex": color.dominant_hex, "proportions": color.proportions}
            profile, model_name = await self.synthesizer.describe_image(jpeg_bytes, "unknown (user photo)", color_meta)
            profile_dict = profile.model_dump(mode="json")
            description = compose_search_document(profile_dict, color.dominant_hex)
            vector = await self.manager.embed_text(description, "RETRIEVAL_QUERY")
            return (QuerySignal("text_from_photo", "text", "text", vector), None, _ms_since(started),
                    {"query_profile": profile_dict, "query_caption_model": model_name})
        except Exception as exc:
            LOGGER.warning("Query photo description failed: %s: %s", type(exc).__name__, str(exc)[:200])
            return None, f"text_from_photo unavailable ({type(exc).__name__}).", _ms_since(started), {}

    async def encode_photo(self, source, describe=True, use_vertex_mm=True, *, region: Optional[RegionSpec] = None, neural: bool = True):
        """-> (signals, info). `source` is a PreparedQuery, or anything load_rgb takes (then it is preprocessed here, with `region` if given).
        info: preprocessing, quad, rectified_rgb, dominant_hex, query_profile / query_caption_model (full profile only), warnings, timings."""
        timings: Dict[str, float] = {"prepare": 0.0, "encode": 0.0, "vertex": 0.0, "describe": 0.0}
        warnings: List[str] = []
        if isinstance(source, PreparedQuery):
            prepared = source
        else:
            started = time.perf_counter()
            if region is not None:
                prepared = await asyncio.to_thread(self.preprocessor.prepare_region, source, region)
            else:
                prepared = await asyncio.to_thread(self.preprocessor.prepare, source)
            timings["prepare"] = _ms_since(started)
        rgb = prepared.rectified_rgb
        info: Dict[str, Any] = {"preprocessing": prepared.method, "quad": prepared.quad, "rectified_rgb": rgb,
                                "warnings": warnings, "timings": timings}

        encode_started = time.perf_counter()
        color = await asyncio.to_thread(self.color_fn, rgb)          # describe_image needs the measured colours, so this goes first
        info["dominant_hex"] = color.dominant_hex

        vertex_on = bool(use_vertex_mm) and self._vertex_mm_enabled()
        describe_on = bool(describe) and self.synthesizer is not None and self.manager is not None
        if use_vertex_mm and not vertex_on:
            warnings.append("vertex_mm_image skipped: the Vertex multimodal embedding is not available on this service.")
        if describe and not describe_on:
            warnings.append("text_from_photo skipped: the Gemini description is not available on this service.")
        jpeg_bytes = None
        if vertex_on or describe_on:
            jpeg_bytes = await asyncio.to_thread(lambda: encode_rgb(resize_max_side(rgb, 1024), "jpeg", 92))

        tasks = []
        vertex_task = describe_task = None
        if vertex_on:
            vertex_task = asyncio.ensure_future(self._vertex_image(jpeg_bytes))
            tasks.append(vertex_task)
        if describe_on:
            describe_task = asyncio.ensure_future(self._describe(jpeg_bytes, color))
            tasks.append(describe_task)
        try:
            neural_signals: List[QuerySignal] = []
            if neural and self.encoders is not None:
                dino_vectors, siglip_vectors = await self._gpu(self.encoders.encode_rgb_images, [rgb], tta_hflip=self.cfg.query_tta_hflip)
                neural_signals = [QuerySignal("dino_image", "dino", "dino", dino_vectors[0]),
                                  QuerySignal("siglip_image", "siglip", "mm", siglip_vectors[0])]
            timings["encode"] = _ms_since(encode_started)
            if tasks:
                await asyncio.gather(*tasks)
        except BaseException:
            for task in tasks:
                task.cancel()
            if tasks:
                await asyncio.gather(*tasks, return_exceptions=True)
            raise

        signals = list(neural_signals)
        signals.append(QuerySignal("color_image", "color", "color", color.vector))
        if vertex_task is not None:
            signal, warning, elapsed = vertex_task.result()
            timings["vertex"] = elapsed
            if signal is not None:
                signals.append(signal)
            if warning:
                warnings.append(warning)
        if describe_task is not None:
            signal, warning, elapsed, extra = describe_task.result()
            timings["describe"] = elapsed
            if signal is not None:
                signals.append(signal)
                info.update(extra)
            if warning:
                warnings.append(warning)
        return signals, info

    async def encode_text(self, text, use_vertex_mm=True):
        """-> (signals, info). siglip_text (local), text_query and vertex_mm_text (Vertex; warnings when they fail or are absent)."""
        timings: Dict[str, float] = {"prepare": 0.0, "encode": 0.0, "vertex": 0.0, "describe": 0.0}
        warnings: List[str] = []
        info: Dict[str, Any] = {"preprocessing": "text", "quad": None, "dominant_hex": [], "warnings": warnings, "timings": timings}
        started = time.perf_counter()

        async def local():
            vectors = await self._gpu(self.encoders.encode_siglip_text, [text])
            return QuerySignal("siglip_text", "siglip", "mm", vectors[0])

        async def remote_text():
            try:
                return QuerySignal("text_query", "text", "text", await self.manager.embed_text(text, "RETRIEVAL_QUERY")), None
            except Exception as exc:
                LOGGER.warning("Text query embedding failed: %s: %s", type(exc).__name__, str(exc)[:200])
                return None, f"text_query unavailable ({type(exc).__name__})."

        async def remote_mm():
            try:
                embedding = await self.manager.multimodal_embed(text=text)
                return QuerySignal("vertex_mm_text", "vertex_mm", "mm", embedding["text"]), None
            except Exception as exc:
                LOGGER.warning("Vertex multimodal text embedding failed: %s: %s", type(exc).__name__, str(exc)[:200])
                return None, f"vertex_mm_text unavailable ({type(exc).__name__})."

        awaitables = {}
        if self.encoders is not None:
            awaitables["siglip_text"] = local()
        if self.manager is not None:
            awaitables["text_query"] = remote_text()
            if use_vertex_mm:
                if self._vertex_mm_enabled():
                    awaitables["vertex_mm_text"] = remote_mm()
                else:
                    warnings.append("vertex_mm_text skipped: the Vertex multimodal embedding is not available on this service.")
        else:
            warnings.append("text_query and vertex_mm_text skipped: Vertex AI is not configured on this service; "
                            "this search used the SigLIP text signal only.")
        names = list(awaitables)
        outcomes = await asyncio.gather(*awaitables.values())
        signals: List[QuerySignal] = []
        for name, outcome in zip(names, outcomes):
            if name == "siglip_text":
                signals.append(outcome)
                continue
            signal, warning = outcome
            if signal is not None:
                signals.append(signal)
            if warning:
                warnings.append(warning)
        timings["encode"] = _ms_since(started)
        return signals, info


# ------------------------------------------------------------------------------------------------------------------------
# the retriever
# ------------------------------------------------------------------------------------------------------------------------
@dataclass
class SearchResult:
    """PORT: `results` is a list of dicts (ARCHITECTURE.md section 6), the notebook's was a DataFrame. The other fields are the notebook's."""
    results: List[dict]
    signal_names: List[str]
    signal_weights: Dict[str, float]
    query_info: dict
    pool_item_ids: List[str]
    signal_ranks: Dict[str, np.ndarray]
    fused_order: np.ndarray


_SIM_CHUNK = 4096


class HybridRetriever:
    """Photo / text / both -> ranked items of one release. Exact scoring of every allowed item; fusion as in the notebook."""

    FILTER_COLUMNS = ("category", "finish")

    def __init__(self, cfg, release: LoadedRelease, query_encoder=None):
        self.cfg = cfg
        self.release = release
        self.query_encoder = query_encoder
        self._build_index()

    # ---- PORT: the in-memory index (the notebook had a pandas catalog frame + PillarIndex objects)
    def _build_index(self):
        self._items_by_id: Dict[str, dict] = {item["itemId"]: item for item in self.release.items}
        self._sorted_ids: List[str] = sorted(self._items_by_id)           # the notebook's pool order: sorted(allowed_ids)
        position_of = {item_id: position for position, item_id in enumerate(self._sorted_ids)}
        self._rows: Dict[str, np.ndarray] = {}
        for name, pillar in self.release.pillars.items():
            rows = np.full(len(self._sorted_ids), -1, dtype=np.int64)
            for row, item_id in enumerate(pillar.ids):
                rows[position_of[item_id]] = row
            self._rows[name] = rows
        self._columns: Dict[str, List[Any]] = {
            column: [self._items_by_id[item_id].get(column) for item_id in self._sorted_ids] for column in self.FILTER_COLUMNS}

    # ---- verbatim
    def _group_weights(self, has_photo, has_text, override):
        if override is not None:
            return dict(override)
        if has_photo and has_text:
            combined = {}
            for weights in (self.cfg.photo_weights, self.cfg.text_weights):
                for group, weight in weights.items():
                    combined[group] = combined.get(group, 0.0) + 0.5 * weight
            return combined
        if has_photo:
            return dict(self.cfg.photo_weights)
        return dict(self.cfg.text_weights)

    @staticmethod
    def _signal_weights(signals, group_weights):
        present_groups = {}
        for signal in signals:
            if group_weights.get(signal.group, 0.0) > 0:
                present_groups[signal.group] = present_groups.get(signal.group, 0) + 1
        total = sum(group_weights[group] for group in present_groups)
        weights = {}
        for signal in signals:
            if signal.group in present_groups and total > 0:
                weights[signal.name] = group_weights[signal.group] / total / present_groups[signal.group]
        return weights

    # ---- PORT: candidate pool = every allowed item, in the notebook's order (sorted by item id). Returns positions into self._sorted_ids.
    def _allowed_positions(self, filters) -> np.ndarray:
        size = len(self._sorted_ids)
        if not filters:
            return np.arange(size)
        mask = np.ones(size, dtype=bool)
        for column, accepted in filters.items():
            if column not in self._columns:
                raise BadRequestError(f"Cannot filter on '{column}'; use one of {', '.join(self.FILTER_COLUMNS)}.")
            accepted_values = accepted if isinstance(accepted, (list, tuple, set)) else [accepted]
            accepted_set = set(accepted_values)
            values = self._columns[column]
            mask &= np.fromiter((value in accepted_set for value in values), dtype=bool, count=size)
        return np.flatnonzero(mask)

    # ---- PORT: PillarIndex.similarities_for over the numpy matrix (NaN where this pillar has no vector for the item)
    def _similarities(self, signal: QuerySignal, positions: np.ndarray) -> np.ndarray:
        pillar = self.release.pillars[signal.pillar]
        query = np.asarray(signal.vector)
        if query.ndim != 1 or query.shape[0] != pillar.dim:
            raise ServiceError(f"The query vector for '{signal.name}' has shape {tuple(query.shape)} but the release stores "
                               f"{pillar.dim}-dimensional '{signal.pillar}' vectors.", status=409, reason="feature-version-mismatch")
        rows = self._rows[signal.pillar][positions]
        result = np.full(len(positions), np.nan, dtype=np.float32)
        present = np.flatnonzero(rows >= 0)
        if present.size:
            query32 = query.astype(np.float32)
            wanted = rows[present]
            for start in range(0, present.size, _SIM_CHUNK):          # bounded temporary memory; same gather-then-matmul as the notebook
                result[present[start:start + _SIM_CHUNK]] = pillar.matrix[wanted[start:start + _SIM_CHUNK]] @ query32
        return result

    # ---- the notebook's HybridRetriever.search after the signals exist (verbatim maths)
    def rank_signals(self, signals: List[QuerySignal], *, has_photo: bool, has_text: bool, top_k=None, weights=None, filters=None,
                     fusion_mode=None, query_info: Optional[dict] = None) -> SearchResult:
        if not self.release.items:
            raise ServiceError("This release has no items.", status=409, reason="release-empty")
        top_k = top_k or self.cfg.top_k
        fusion_mode = fusion_mode or self.cfg.fusion_mode
        query_info = {} if query_info is None else query_info
        warnings = query_info.setdefault("warnings", [])

        usable = [signal for signal in signals if signal.pillar in self.release.pillars]
        for signal in signals:                                              # NEW: say what was left out and why
            if signal.pillar not in self.release.pillars:
                warnings.append(f"{signal.name} skipped: this release has no '{signal.pillar}' vectors.")
        signals = usable
        group_weights = self._group_weights(has_photo, has_text, weights)
        signal_weights = self._signal_weights(signals, group_weights)
        signals = [signal for signal in signals if signal.name in signal_weights]
        if not signals:
            raise ServiceError("No usable query signal: this release has no vectors for the signals this query produced.",
                               status=409, reason="no-usable-signal")

        positions = self._allowed_positions(filters)
        pool = [self._sorted_ids[int(position)] for position in positions]
        if not pool:
            return SearchResult([], [], signal_weights, query_info, [], {}, np.zeros(0, dtype=np.int64))
        pool_size = len(pool)
        rrf_total = np.zeros(pool_size, dtype=np.float64)
        linear_total = np.zeros(pool_size, dtype=np.float64)
        raw_similarities = {}
        signal_ranks = {}
        weight_sum = sum(signal_weights.values())
        for signal in signals:
            similarities = self._similarities(signal, positions)
            valid = ~np.isnan(similarities)
            sortable = np.where(valid, similarities, -np.inf)
            order = np.argsort(-sortable, kind="stable")
            ranks = np.empty(pool_size, dtype=np.int64)
            ranks[order] = np.arange(1, pool_size + 1)
            ranks[~valid] = pool_size + 1
            weight = signal_weights[signal.name]
            rrf_total += np.where(valid, weight / (self.cfg.rrf_k + ranks), 0.0)
            normalised = np.zeros(pool_size, dtype=np.float64)
            if valid.any():
                lowest = float(np.nanmin(similarities))
                highest = float(np.nanmax(similarities))
                if highest - lowest > 1e-9:
                    normalised[valid] = (similarities[valid] - lowest) / (highest - lowest)
                else:
                    normalised[valid] = 1.0
            linear_total += weight * normalised
            raw_similarities[signal.name] = similarities
            signal_ranks[signal.name] = ranks
        rrf_score = rrf_total / (weight_sum / (self.cfg.rrf_k + 1))
        linear_score = linear_total / weight_sum
        if fusion_mode == "rrf":
            final_score = rrf_score
        elif fusion_mode == "linear":
            final_score = linear_score
        else:
            final_score = self.cfg.hybrid_lambda * rrf_score + (1.0 - self.cfg.hybrid_lambda) * linear_score
        fused_order = np.argsort(-final_score, kind="stable")

        records = []
        seen_products = set()
        for position in fused_order:
            item_id = pool[int(position)]
            product_id = self._items_by_id[item_id].get("productId")
            # PORT: an empty string is not an id (the notebook's ids always matched a regex of 3+ characters), so it never merges items
            product_key = product_id if isinstance(product_id, str) and product_id else item_id
            if self.cfg.dedupe_results_by_product and product_key in seen_products:
                continue
            seen_products.add(product_key)
            record = {
                "rank": len(records) + 1, "itemId": item_id,
                "finalScore": round(float(final_score[position]), 5),
                "rrfScore": round(float(rrf_score[position]), 5), "linearScore": round(float(linear_score[position]), 5),
                "signals": {},
            }
            for signal_name, similarities in raw_similarities.items():
                value = similarities[position]
                record["signals"][signal_name] = {"sim": None if np.isnan(value) else round(float(value), 4),
                                                  "rank": int(signal_ranks[signal_name][position])}
            records.append(record)
            if len(records) >= top_k:
                break
        return SearchResult(records, [signal.name for signal in signals], signal_weights, query_info, pool, signal_ranks, fused_order)

    async def search(self, photo=None, text=None, top_k=None, weights=None, filters=None, describe_photo=None,
                     use_vertex_mm=True, fusion_mode=None, *, region: Optional[RegionSpec] = None, neural: bool = True) -> SearchResult:
        if photo is None and text is None:
            raise ValueError("Provide a photo, a text query, or both.")
        describe_photo = self.cfg.describe_query_photo if describe_photo is None else describe_photo
        if self.query_encoder is None:
            raise RuntimeError("This retriever has no query encoder.")

        signals: List[QuerySignal] = []
        query_info: Dict[str, Any] = {"warnings": []}
        timings: Dict[str, float] = {}
        if photo is not None:
            extra = {}
            if region is not None:
                extra["region"] = region
            if not neural:
                extra["neural"] = False
            photo_signals, photo_info = await self.query_encoder.encode_photo(photo, describe=describe_photo, use_vertex_mm=use_vertex_mm,
                                                                              **extra)
            signals.extend(photo_signals)
            self._merge_info(query_info, photo_info, timings)
        if text is not None:
            outcome = await self.query_encoder.encode_text(text, use_vertex_mm=use_vertex_mm)
            if isinstance(outcome, tuple):
                text_signals, text_info = outcome
            else:                                                          # the notebook's encode_text returned just the list
                text_signals, text_info = outcome, {}
            signals.extend(text_signals)
            self._merge_info(query_info, text_info, timings)
            query_info["text_query"] = text

        started = time.perf_counter()
        result = await asyncio.to_thread(self.rank_signals, signals, has_photo=photo is not None, has_text=text is not None, top_k=top_k,
                                         weights=weights, filters=filters, fusion_mode=fusion_mode, query_info=query_info)
        timings["fuse"] = _ms_since(started)
        result.query_info["timings"] = timings
        return result

    @staticmethod
    def _merge_info(query_info: dict, new_info: dict, timings: Dict[str, float]) -> None:
        new_info = dict(new_info or {})
        for name, value in (new_info.pop("timings", None) or {}).items():
            timings[name] = round(timings.get(name, 0.0) + value, 1)
        query_info["warnings"].extend(new_info.pop("warnings", None) or [])
        query_info.update(new_info)

    def lookup_product(self, product_id):
        """The notebook's exact product-id lookup: items whose productId equals the (upper-cased) id."""
        normalised = product_id.strip().upper() if self.cfg.uppercase_product_ids else product_id.strip()
        return [item for item in self.release.items if item.get("productId") == normalised]


# ------------------------------------------------------------------------------------------------------------------------
# the self-retrieval benchmark (verbatim capture simulator; generalised evaluation)
# ------------------------------------------------------------------------------------------------------------------------
class SyntheticPhoneCapture:
    """Simulate a phone photo of a printed swatch: tabletop, perspective, white-balance cast,
    uneven light, blur, sensor noise, JPEG. Used for the self-retrieval sanity benchmark."""

    def __init__(self, seed=0):
        self.random = np.random.default_rng(seed)

    def __call__(self, rgb):
        swatch = resize_max_side(rgb, 640)
        height, width = swatch.shape[:2]
        margin = int(0.25 * max(height, width))
        canvas_height = height + 2 * margin
        canvas_width = width + 2 * margin
        table_color = self.random.uniform(70, 170, size=3)
        canvas = np.ones((canvas_height, canvas_width, 3), np.float32) * table_color
        canvas += self.random.normal(0, 6, size=canvas.shape)
        source = np.array([[0, 0], [width - 1, 0], [width - 1, height - 1], [0, height - 1]], np.float32)
        jitter = self.random.uniform(-0.08, 0.08, size=(4, 2)) * np.array([width, height])
        destination = (source + margin + jitter).astype(np.float32)
        matrix = cv2.getPerspectiveTransform(source, destination)
        warped = cv2.warpPerspective(swatch.astype(np.float32), matrix, (canvas_width, canvas_height),
                                     flags=cv2.INTER_LINEAR)
        mask = cv2.warpPerspective(np.ones((height, width), np.float32), matrix, (canvas_width, canvas_height))
        image = canvas * (1 - mask[:, :, None]) + warped * mask[:, :, None]
        gains = self.random.uniform(0.9, 1.12, size=3)
        image = image * gains
        yy, xx = np.mgrid[0:canvas_height, 0:canvas_width].astype(np.float32)
        angle = self.random.uniform(0, 2 * np.pi)
        gradient = (np.cos(angle) * xx / canvas_width + np.sin(angle) * yy / canvas_height)
        image = image * (0.85 + 0.3 * (gradient - gradient.min()) / max(np.ptp(gradient), 1e-6))[:, :, None]
        gamma = self.random.uniform(0.85, 1.2)
        image = 255.0 * np.power(np.clip(image / 255.0, 0, 1), gamma)
        sigma = self.random.uniform(0.0, 1.0)
        if sigma > 0.2:
            image = cv2.GaussianBlur(image, (0, 0), sigma)
        image = image + self.random.normal(0, self.random.uniform(2, 5), size=image.shape)
        image_u8 = np.clip(image, 0, 255).astype(np.uint8)
        quality = int(self.random.uniform(60, 85))
        return load_rgb(encode_rgb(image_u8, "jpeg", quality))


async def evaluate_self_retrieval(retriever: HybridRetriever, loader: Callable[[str], Any], sample_size=40, seed=0) -> List[dict]:
    """Distort catalogue crops like phone photos and check each comes back as its own top match.

    PORT: `loader(item_id)` returns the item's crop as an RGB array (it may be a coroutine function); the notebook read it from a pandas catalog's
    crop_filepath. The sample is drawn from the release's items in items.json order (sorted by item id), the notebook's from its catalog order, so
    the same seed does not pick the same items. Returns rows {signal, recall@1, recall@5, mrr, queries}, best mrr first (a list, not a DataFrame).
    """
    ids = [item["itemId"] for item in retriever.release.items]
    if not ids:
        return []
    sample_size = min(sample_size, len(ids))
    item_ids = [str(item_id) for item_id in np.random.default_rng(seed).choice(np.asarray(ids), size=sample_size, replace=False)]
    simulator = SyntheticPhoneCapture(seed)
    hits: Dict[str, List[int]] = {}
    for item_id in item_ids:
        crop = loader(item_id)
        if inspect.isawaitable(crop):
            crop = await crop
        query = simulator(crop)
        result = await retriever.search(photo=query, top_k=10, describe_photo=False, use_vertex_mm=False)
        truth_position = result.pool_item_ids.index(item_id)
        for signal_name, ranks in result.signal_ranks.items():
            hits.setdefault(signal_name, []).append(int(ranks[truth_position]))
        fused_rank = int(np.where(result.fused_order == truth_position)[0][0]) + 1
        hits.setdefault("FUSED", []).append(fused_rank)
    rows = []
    for signal_name, ranks in hits.items():
        ranks_array = np.asarray(ranks)
        rows.append({"signal": signal_name, "recall@1": float(np.mean(ranks_array <= 1)),
                     "recall@5": float(np.mean(ranks_array <= 5)), "mrr": float(np.mean(1.0 / ranks_array)),
                     "queries": len(ranks_array)})
    rows.sort(key=lambda row: -row["mrr"])
    return rows
