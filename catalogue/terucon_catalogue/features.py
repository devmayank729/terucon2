"""The torch-free image features: CLAHE on L*, the CIELAB colour descriptor, and where a stored crop lives on disk.

# Ported from terucon-cat-1.ipynb (cell 4). Definitions are copied verbatim except where marked "PORT:".
No import-time side effects and no torch: this module is what the search service and the CLI use for colour.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from pathlib import Path
from typing import List, Tuple

import cv2
import numpy as np
from scipy.ndimage import gaussian_filter

from .util import l2_normalize_rows, resize_max_side


@dataclass(frozen=True)
class ColorParams:
    bins: Tuple[int, int, int]
    ab_range: float
    clahe_clip: float
    clahe_grid: int
    sigma: float
    hist_weight: float
    max_side: int
    kmeans_k: int

    @classmethod
    def from_config(cls, cfg):
        return cls(bins=tuple(int(value) for value in cfg.color_bins), ab_range=float(cfg.color_ab_range),
                   clahe_clip=float(cfg.color_clahe_clip_limit), clahe_grid=int(cfg.color_clahe_grid),
                   sigma=float(cfg.color_hist_sigma), hist_weight=float(cfg.color_hist_weight),
                   max_side=int(cfg.color_max_side_px), kmeans_k=int(cfg.color_kmeans_k))


@dataclass
class ColorDescriptor:
    vector: np.ndarray
    dominant_hex: List[str]
    proportions: List[float]
    dominant_lab: List[List[float]]


def apply_clahe_rgb(rgb, clip_limit, grid_size):
    """Equalise local contrast on L* only, so lighting changes but hue/chroma do not."""
    lab = cv2.cvtColor(rgb, cv2.COLOR_RGB2LAB)
    lightness, channel_a, channel_b = cv2.split(lab)
    clahe = cv2.createCLAHE(clipLimit=float(clip_limit), tileGridSize=(int(grid_size), int(grid_size)))
    equalised = cv2.merge([clahe.apply(lightness), channel_a, channel_b])
    return cv2.cvtColor(equalised, cv2.COLOR_LAB2RGB)


def rgb_to_hex(rgb_triplet):
    red, green, blue = (int(round(float(value))) for value in rgb_triplet)
    return f"#{max(0, min(255, red)):02X}{max(0, min(255, green)):02X}{max(0, min(255, blue)):02X}"


def compute_lab_color_descriptor(rgb, params):
    """Illumination-normalised CIELAB 3-D histogram (Hellinger) + top-k dominant colours, L2-normalised.

    Cosine on sqrt-histograms equals the Bhattacharyya coefficient, a proper histogram similarity.
    """
    image = resize_max_side(rgb, params.max_side)
    lab = cv2.cvtColor(image, cv2.COLOR_RGB2LAB)
    lightness_u8, a_u8, b_u8 = cv2.split(lab)
    clahe = cv2.createCLAHE(clipLimit=params.clahe_clip, tileGridSize=(params.clahe_grid, params.clahe_grid))
    lightness = clahe.apply(lightness_u8).astype(np.float32) * (100.0 / 255.0)
    upper = params.ab_range - 1e-3
    channel_a = np.clip(a_u8.astype(np.float32) - 128.0, -params.ab_range, upper)
    channel_b = np.clip(b_u8.astype(np.float32) - 128.0, -params.ab_range, upper)
    samples = np.stack([lightness.ravel(), channel_a.ravel(), channel_b.ravel()], axis=1)

    histogram, _ = np.histogramdd(samples, bins=params.bins,
                                  range=((0.0, 100.0), (-params.ab_range, params.ab_range),
                                         (-params.ab_range, params.ab_range)))
    if params.sigma > 0:
        histogram = gaussian_filter(histogram, sigma=params.sigma, mode="constant")
    histogram = histogram / max(float(histogram.sum()), 1e-12)
    histogram_unit = l2_normalize_rows(np.sqrt(histogram).ravel().astype(np.float32))

    step = max(1, samples.shape[0] // 20000)
    subset = np.ascontiguousarray(samples[::step], dtype=np.float32)
    original_pixels = image.reshape(-1, 3)[::step]
    cluster_count = max(1, min(params.kmeans_k, subset.shape[0]))
    cv2.setRNGSeed(12345)
    criteria = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 40, 0.25)
    _, labels, centers = cv2.kmeans(subset, cluster_count, None, criteria, 3, cv2.KMEANS_PP_CENTERS)
    labels = labels.ravel()
    counts = np.bincount(labels, minlength=cluster_count).astype(np.float64)
    order = np.argsort(-counts, kind="stable")
    total = max(float(counts.sum()), 1.0)

    dominant_hex = []
    proportions = []
    dominant_lab = []
    dominant_block = []
    for cluster in order:
        proportion = float(counts[cluster]) / total
        members = original_pixels[labels == cluster]
        if len(members) > 0:
            mean_rgb = members.mean(axis=0)  # report the true (un-equalised) colour for humans
        else:
            mean_rgb = original_pixels.mean(axis=0)
        center = centers[cluster]
        dominant_hex.append(rgb_to_hex(mean_rgb))
        proportions.append(round(proportion, 4))
        dominant_lab.append([round(float(value), 2) for value in center])
        dominant_block.extend([center[0] / 100.0, center[1] / params.ab_range, center[2] / params.ab_range,
                               math.sqrt(proportion)])
    while len(dominant_block) < 4 * params.kmeans_k:
        dominant_block.extend(dominant_block[-4:])
    dominant_unit = l2_normalize_rows(np.asarray(dominant_block, dtype=np.float32))
    vector = np.concatenate([math.sqrt(params.hist_weight) * histogram_unit,
                             math.sqrt(1.0 - params.hist_weight) * dominant_unit]).astype(np.float32)
    return ColorDescriptor(vector=l2_normalize_rows(vector), dominant_hex=dominant_hex, proportions=proportions,
                           dominant_lab=dominant_lab)


# =====================================================================================================================
# PORT: new in this package (nothing below is in the notebook)
# =====================================================================================================================
# The notebook stored the ABSOLUTE path of every crop in items.crop_filepath. A bundle has to be movable (Kaggle -> laptop -> Modal ->
# the publisher), so this package stores the path RELATIVE to the bundle's work_dir, with "/" separators:
#     crops/<pdfstem>_<sha8>/<item_id>.png
# A bundle written by the notebook still holds absolute paths: resolve_crop_path() hands those back unchanged.
def crop_path_for_storage(work_dir, path):
    """The value that goes into items.crop_filepath: `path` relative to `work_dir`, posix separators."""
    return Path(path).relative_to(Path(work_dir)).as_posix()


def resolve_crop_path(work_dir, stored):
    """Where the crop named by items.crop_filepath is on disk. An absolute (legacy, notebook-written) value is returned as it is."""
    return Path(work_dir) / str(stored)
