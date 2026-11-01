"""Pipeline settings and the feature-version strings that say which vectors belong together.

Ported from terucon-cat-1.ipynb (cells 2, 4 and 5). Definitions are copied verbatim except where marked "PORT:".

A feature version is the label stored next to every vector. Two vectors may only be compared when their versions match, so the
service refuses to serve (and the publisher refuses to publish) a catalogue whose versions disagree with the encoder it runs:
see check_feature_versions().
"""
from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, Iterable, List, Mapping, Optional, Tuple

from .schema import CAPTION_SYSTEM_PROMPT, CAPTION_USER_TEMPLATE, MaterialProfile
from .util import sha256_bytes

DEFAULT_PHOTO_WEIGHTS = {"dino": 0.35, "mm": 0.25, "color": 0.25, "text": 0.15}
DEFAULT_TEXT_WEIGHTS = {"text": 0.60, "mm": 0.40}
DEFAULT_DIRECTION_WEIGHTS = {"below": 1.0, "inside": 0.9, "above": 1.15, "side": 1.4}


@dataclass
class PipelineConfig:
    # ---------------- Paths ----------------
    # PORT: the Kaggle input paths and the Kaggle secret name are gone; secrets come from the environment (see credentials.py).
    work_dir: Path = Path("work")                   # state.sqlite and crops/ live here: this folder is the "bundle"

    # ---------------- Hardware ----------------
    device: str = "auto"                      # PORT: "auto" (cuda if there is one, else cpu) | "cpu" | "cuda" | "cuda:N"; was require_dual_gpu
    num_workers: int = 4
    feature_batch_size: int = 64  # PORT: one device by default; with several GPUs the encoder bank may use DataParallel (global batch)

    # ---------------- PDF extraction ----------------
    min_image_side_pt: float = 36.0           # ignore images smaller than 0.5 inch
    min_image_area_fraction: float = 0.004    # ...or smaller than 0.4 % of the page
    repeated_image_page_fraction: float = 0.5  # same xref on >= 50 % of pages -> logo/background
    merge_tolerance_pt: float = 1.5           # stitch image strips that touch; 0 disables
    flattened_page_area_fraction: float = 0.85
    enable_raster_segmentation_fallback: bool = True
    segmentation_dpi: int = 110
    segmentation_background_threshold: int = 28
    min_render_dpi: int = 200
    max_render_dpi: int = 600
    crop_max_side_px: int = 1536
    crop_image_format: str = "png"
    inpaint_overlay_text: bool = True
    inpaint_max_area_fraction: float = 0.12
    product_id_regex: str = r"[A-Za-z0-9][A-Za-z0-9\-_/\.]{2,31}"
    product_id_label_prefix_regex: str = r"^(?:SKU|CODE|DESIGN\s*NO|DESIGN|REF|ART|ITEM|CAT|NO|ID)[\s\.:#\-]+"
    min_numeric_id_length: int = 4
    reject_year_like_ids: bool = True
    uppercase_product_ids: bool = True
    id_stopwords: Tuple[str, ...] = ("PAGE", "WWW", "HTTP", "HTTPS", "TEL", "FAX", "EMAIL")
    direction_weights: Dict[str, float] = field(default_factory=lambda: dict(DEFAULT_DIRECTION_WEIGHTS))
    alignment_penalty: float = 2.0
    max_match_cost: float = 0.35              # normalised by page diagonal
    allow_shared_ids: bool = True             # multi-view products: 2 photos, 1 code
    shared_id_cost_factor: float = 0.6
    page_max_attempts: int = 3

    # ---------------- Pillar 1: DINOv2 ----------------
    dino_model_name: str = "facebook/dinov2-large"
    dino_input_size: int = 448                # multiple of 14 -> 32x32 patch grid for micro-texture
    dino_resize_short_side: int = 512
    dino_block_weights: Tuple[float, float, float] = (0.5, 0.25, 0.25)  # CLS, patch-mean, patch-std

    # ---------------- Pillar 2: SigLIP + Vertex multimodal + CIELAB ----------------
    siglip_model_name: str = "google/siglip-so400m-patch14-384"
    siglip_text_template: str = "a close-up photo of {} material texture"
    neural_clahe_clip_limit: float = 1.5      # same CLAHE on catalogue and query inputs; 0 disables
    neural_clahe_grid: int = 8
    color_bins: Tuple[int, int, int] = (6, 8, 8)   # coarse L* (lighting-sensitive), finer a*/b*
    color_ab_range: float = 80.0
    color_clahe_clip_limit: float = 2.0
    color_clahe_grid: int = 8
    color_hist_sigma: float = 0.6
    color_hist_weight: float = 0.8
    color_max_side_px: int = 384
    color_kmeans_k: int = 3
    enable_vertex_multimodal_embedding: bool = True
    vertex_mm_model: str = "multimodalembedding@001"
    vertex_mm_dimension: int = 1408
    vertex_mm_concurrency: int = 6
    vertex_mm_text_max_chars: int = 200

    # ---------------- Pillar 3: Gemini synthesis ----------------
    gemini_location: str = "global"
    embedding_location: str = "us-central1"
    caption_model_candidates: Tuple[str, ...] = ("gemini-2.5-flash", "gemini-3.5-flash", "gemini-3-flash-preview")
    caption_temperature: float = 0.2
    caption_max_output_tokens: int = 4096
    caption_thinking_budget: Optional[int] = 0  # applied to gemini-2.5-* only
    caption_image_max_side_px: int = 1024
    caption_concurrency: int = 8
    checkpoint_every: int = 25
    max_caption_attempts: int = 4
    max_feature_attempts: int = 3
    text_embedding_model: str = "gemini-embedding-001"
    text_embedding_dim: int = 768
    text_embedding_concurrency: int = 8

    # ---------------- Retry / quota ----------------
    request_timeout_s: float = 180.0
    retry_max_attempts: int = 8
    retry_initial_wait_s: float = 2.0
    retry_max_wait_s: float = 90.0
    rate_limit_cooldown_s: float = 20.0

    # ---------------- Retrieval ----------------
    fusion_mode: str = "hybrid"               # "rrf" | "linear" | "hybrid"
    rrf_k: int = 60
    hybrid_lambda: float = 0.5                # weight of RRF inside the hybrid score
    photo_weights: Dict[str, float] = field(default_factory=lambda: dict(DEFAULT_PHOTO_WEIGHTS))
    text_weights: Dict[str, float] = field(default_factory=lambda: dict(DEFAULT_TEXT_WEIGHTS))
    # PORT: candidate_pool_size / exhaustive_search_max_items / faiss_index_type / hnsw_m are gone. The notebook scored EVERY item exactly
    # below 50,000 items and only then used FAISS to pick a candidate pool; this port scores every item exactly at any size
    # (a flat FAISS index is an exact inner product, so the ranking is the same).
    top_k: int = 10
    describe_query_photo: bool = True
    query_center_crop_fraction: float = 0.8
    rectify_min_area_fraction: float = 0.2
    query_tta_hflip: bool = True
    dedupe_results_by_product: bool = True

    @property
    def crops_dir(self):
        return self.work_dir / "crops"

    @property
    def backtrace_dir(self):
        return self.work_dir / "backtrace"

    @property
    def state_db_path(self):
        return self.work_dir / "state.sqlite"

    def ensure_dirs(self):
        for directory in (self.work_dir, self.crops_dir, self.backtrace_dir):
            directory.mkdir(parents=True, exist_ok=True)


def local_feature_versions(cfg):
    neural_tag = f"clahe{cfg.neural_clahe_clip_limit:g}x{cfg.neural_clahe_grid}"
    block_tag = ",".join(f"{weight:g}" for weight in cfg.dino_block_weights)
    bins_tag = "x".join(str(value) for value in cfg.color_bins)
    return {
        "dino": f"{cfg.dino_model_name}|{cfg.dino_input_size}|r{cfg.dino_resize_short_side}|w{block_tag}|{neural_tag}|v1",
        "siglip": f"{cfg.siglip_model_name}|{neural_tag}|v1",
        "color": (f"lab{bins_tag}|ab{cfg.color_ab_range:g}|clahe{cfg.color_clahe_clip_limit:g}x{cfg.color_clahe_grid}"
                  f"|s{cfg.color_hist_sigma:g}|hw{cfg.color_hist_weight:g}|k{cfg.color_kmeans_k}"
                  f"|m{cfg.color_max_side_px}|v1"),
    }


def vertex_mm_version(cfg):
    return f"{cfg.vertex_mm_model}|d{cfg.vertex_mm_dimension}|v1"


def compute_caption_version(cfg):
    schema_text = json.dumps(MaterialProfile.model_json_schema(), sort_keys=True)
    fingerprint = "|".join([cfg.caption_model_candidates[0], CAPTION_SYSTEM_PROMPT, CAPTION_USER_TEMPLATE, schema_text])
    return sha256_bytes(fingerprint.encode("utf-8"))[:12]


def compute_feature_versions(cfg):
    versions = dict(local_feature_versions(cfg))
    versions["vertex_mm"] = vertex_mm_version(cfg)
    versions["text"] = f"{cfg.text_embedding_model}|d{cfg.text_embedding_dim}|cap{compute_caption_version(cfg)}|v1"
    return versions


# =====================================================================================================================
# PORT: new in this package (nothing below is in the notebook)
# =====================================================================================================================

# How a photo query is answered. The notebook's self-retrieval benchmark (cell 7) ran with use_vertex_mm=False and
# describe_photo=False, and there SigLIP alone and the fused score both reached recall@1 0.925 on 40 synthetic queries; "fast" is that
# configuration, the only one with a measurement. "full" is the notebook's default for a photo query: it adds a Gemini description of the
# photo and an embedding call, which costs seconds and money on every query, so it is opt-in.
SEARCH_PROFILES = {
    "fast": {"use_vertex_mm": False, "describe": False},
    "balanced": {"use_vertex_mm": True, "describe": False},
    "full": {"use_vertex_mm": True, "describe": True},
}
DEFAULT_SEARCH_PROFILE = "fast"

# The signals (query-side names, as in the notebook) that the colour-only mode uses: one group, nothing else.
COLOUR_ONLY_WEIGHTS = {"color": 1.0}


def _env_text(environ, name):
    value = environ.get(name)
    return value.strip() if isinstance(value, str) and value.strip() else None


def load_config(environ: Optional[Mapping[str, str]] = None) -> PipelineConfig:
    """The notebook's defaults plus the few operational overrides that cannot change what a vector means.

    The model names, sizes and colour/CLAHE settings are NOT overridable here on purpose: they are what the feature versions are
    made of, and a catalogue's vectors are only comparable with vectors made the same way.
    """
    environ = os.environ if environ is None else environ
    cfg = PipelineConfig()
    work = _env_text(environ, "CATALOGUE_WORK_DIR")
    if work:
        cfg.work_dir = Path(work)
    device = _env_text(environ, "CATALOGUE_DEVICE")
    if device:
        cfg.device = device
    location = _env_text(environ, "CATALOGUE_GEMINI_LOCATION")
    if location:
        cfg.gemini_location = location
    location = _env_text(environ, "CATALOGUE_EMBEDDING_LOCATION")
    if location:
        cfg.embedding_location = location
    models = _env_text(environ, "CATALOGUE_CAPTION_MODELS")
    if models:
        cfg.caption_model_candidates = tuple(m.strip() for m in models.split(",") if m.strip())
    for name, attribute in (("CATALOGUE_NUM_WORKERS", "num_workers"), ("CATALOGUE_CAPTION_CONCURRENCY", "caption_concurrency"),
                            ("CATALOGUE_BATCH_SIZE", "feature_batch_size")):
        raw = _env_text(environ, name)
        if raw:
            try:
                setattr(cfg, attribute, max(0 if attribute == "num_workers" else 1, int(raw)))
            except ValueError:
                raise ValueError(f"{name} must be a whole number, got {raw!r}")
    return cfg


@dataclass(frozen=True)
class VersionProblem:
    pillar: str
    level: str                       # "error": do not publish or serve; "warning": say so and carry on
    stored: Optional[str]
    expected: Optional[str]
    message: str


_CAPTION_TAG = re.compile(r"\|cap[0-9a-f]{12}\|")


def check_feature_versions(stored: Mapping[str, str], cfg: PipelineConfig, pillars: Optional[Iterable[str]] = None) -> List[VersionProblem]:
    """Compare the version labels stored with a catalogue's vectors with the ones the running encoder would write.

    dino, siglip, color and vertex_mm: the label is a pure function of the settings, so it must be identical, or the vectors were made
    another way and must not be mixed with a query encoded by this code (error).
    text: identical except for the caption fingerprint ("cap<12 hex>"), which also depends on the installed pydantic's schema output and
    on the prompts. A different fingerprint only means the captions were written by a different prompt or library: the vectors are
    still comparable, so that is a warning. Everything else in the text label must match (error).
    A pillar that is missing from `stored` is a warning: that signal simply is not used. A pillar in `stored` that this code does not
    know is a warning too.
    """
    expected = compute_feature_versions(cfg)
    wanted = list(pillars) if pillars is not None else list(expected)
    problems: List[VersionProblem] = []
    for pillar in wanted:
        want = expected.get(pillar)
        have = stored.get(pillar)
        if want is None:
            problems.append(VersionProblem(pillar, "warning", have, None, f"'{pillar}' is not a pillar this code knows."))
            continue
        if have is None:
            problems.append(VersionProblem(pillar, "warning", None, want, f"No '{pillar}' vectors are stored; that signal will not be used."))
            continue
        if have == want:
            continue
        if pillar == "text" and _CAPTION_TAG.sub("|cap*|", have) == _CAPTION_TAG.sub("|cap*|", want):
            problems.append(VersionProblem(pillar, "warning", have, want,
                                           "The text vectors came from captions with a different fingerprint (prompt, caption model or library version); "
                                           "they are still comparable."))
            continue
        problems.append(VersionProblem(pillar, "error", have, want,
                                       f"'{pillar}' vectors were made as '{have}' but this encoder makes '{want}'; they cannot be compared."))
    for pillar in stored:
        if pillar not in expected and (pillars is None):
            problems.append(VersionProblem(pillar, "warning", stored[pillar], None, f"'{pillar}' is not a pillar this code knows."))
    return problems


def version_errors(problems: Iterable[VersionProblem]) -> List[VersionProblem]:
    return [problem for problem in problems if problem.level == "error"]
