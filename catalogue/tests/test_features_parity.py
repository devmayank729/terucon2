"""features.py (the torch-free colour pillar) against the notebook's own compute_lab_color_descriptor, apply_clahe_rgb and rgb_to_hex, run from
terucon-cat-1.ipynb by the oracle, on random and on structured images: identical vectors and identical metadata."""
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import nb_oracle  # noqa: E402

from terucon_catalogue import features  # noqa: E402
from terucon_catalogue.config import PipelineConfig  # noqa: E402

pytestmark = pytest.mark.usefixtures("need_notebook")


@pytest.fixture(scope="module")
def need_notebook():
    nb_oracle.require_notebook()


@pytest.fixture(scope="module")
def nb():
    return nb_oracle.load([
        (1, ["l2_normalize_rows", "resize_max_side"]),
        (4, ["ColorParams", "ColorDescriptor", "apply_clahe_rgb", "rgb_to_hex", "compute_lab_color_descriptor"]),
    ])


def images():
    rng = np.random.default_rng(7)
    yy, xx = np.mgrid[0:240, 0:320]
    gradient = np.stack([xx * 255 // 319, yy * 255 // 239, (xx + yy) * 255 // 558], axis=2).astype(np.uint8)
    split = np.zeros((200, 300, 3), dtype=np.uint8)
    split[:, :100] = (200, 30, 30)
    split[:, 100:220] = (30, 160, 60)
    split[:, 220:] = (240, 240, 240)
    stripes = np.zeros((180, 180, 3), dtype=np.uint8)
    stripes[::2] = (255, 255, 255)
    return {
        "noise": rng.integers(0, 256, (300, 200, 3), dtype=np.uint8),
        "noise big (resized to 384)": rng.integers(0, 256, (900, 1100, 3), dtype=np.uint8),
        "gradient": gradient,
        "three flat colours": split,
        "solid red": np.full((120, 160, 3), (255, 0, 0), dtype=np.uint8),
        "solid black": np.zeros((64, 64, 3), dtype=np.uint8),
        "solid white": np.full((64, 64, 3), 255, dtype=np.uint8),
        "stripes": stripes,
        "tiny 3x3": rng.integers(0, 256, (3, 3, 3), dtype=np.uint8),
        "one pixel": np.array([[[10, 200, 99]]], dtype=np.uint8),
        "dark noise": rng.integers(0, 40, (150, 150, 3), dtype=np.uint8),
        "gray": np.repeat(rng.integers(0, 256, (100, 100, 1), dtype=np.uint8), 3, axis=2),
    }


def test_color_descriptor_is_identical_to_the_notebooks_on_random_and_structured_images(nb):
    cfg = PipelineConfig()
    for name, rgb in images().items():
        try:
            theirs = nb["compute_lab_color_descriptor"](rgb, nb["ColorParams"].from_config(cfg))
        except Exception as exc:   # the notebook's own code fails on a one-pixel image (a crop is never that small): the port must fail the same way
            with pytest.raises(type(exc)) as raised:
                features.compute_lab_color_descriptor(rgb, features.ColorParams.from_config(cfg))
            assert str(raised.value) == str(exc) and name == "one pixel"
            continue
        ours = features.compute_lab_color_descriptor(rgb, features.ColorParams.from_config(cfg))
        assert np.array_equal(ours.vector, theirs.vector), name
        assert ours.vector.dtype == theirs.vector.dtype == np.float32
        assert (ours.dominant_hex, ours.proportions, ours.dominant_lab) == (theirs.dominant_hex, theirs.proportions, theirs.dominant_lab), name
        assert ours.vector.shape == (396,) and abs(float(np.linalg.norm(ours.vector)) - 1.0) < 1e-5   # 6*8*8 histogram + 3 colours * 4


def test_color_descriptor_is_identical_with_other_settings_and_repeats_exactly(nb):
    cfg = PipelineConfig(color_bins=(4, 6, 6), color_kmeans_k=5, color_hist_sigma=0.0, color_max_side_px=64, color_hist_weight=0.5, color_clahe_clip_limit=3.0)
    rgb = images()["noise big (resized to 384)"]
    theirs = nb["compute_lab_color_descriptor"](rgb, nb["ColorParams"].from_config(cfg))
    ours = features.compute_lab_color_descriptor(rgb, features.ColorParams.from_config(cfg))
    assert np.array_equal(ours.vector, theirs.vector) and ours.dominant_hex == theirs.dominant_hex and len(ours.dominant_hex) == 5
    again = features.compute_lab_color_descriptor(rgb, features.ColorParams.from_config(cfg))
    assert np.array_equal(again.vector, ours.vector) and again.proportions == ours.proportions        # cv2.setRNGSeed makes the k-means repeatable


def test_color_params_from_config_match(nb):
    for cfg in (PipelineConfig(), PipelineConfig(color_bins=(3, 4, 5), color_ab_range=60.0, color_kmeans_k=2)):
        theirs, ours = nb["ColorParams"].from_config(cfg), features.ColorParams.from_config(cfg)
        assert vars(theirs) == vars(ours) if hasattr(theirs, "__dict__") else theirs.__dict__ == ours.__dict__
        assert (ours.bins, ours.ab_range, ours.clahe_clip, ours.clahe_grid, ours.sigma, ours.hist_weight, ours.max_side, ours.kmeans_k) == (
            theirs.bins, theirs.ab_range, theirs.clahe_clip, theirs.clahe_grid, theirs.sigma, theirs.hist_weight, theirs.max_side, theirs.kmeans_k)


def test_clahe_is_identical_on_random_and_structured_images(nb):
    for name, rgb in images().items():
        if min(rgb.shape[:2]) < 8:
            continue
        for clip, grid in ((1.5, 8), (2.0, 8), (4.0, 4), (1.0, 16)):
            assert np.array_equal(features.apply_clahe_rgb(rgb, clip, grid), nb["apply_clahe_rgb"](rgb, clip, grid)), (name, clip, grid)


def test_clahe_changes_lightness_and_keeps_the_picture_shape():
    rgb = images()["dark noise"]
    out = features.apply_clahe_rgb(rgb, 2.0, 8)
    assert out.shape == rgb.shape and out.dtype == np.uint8 and out.mean() > rgb.mean()


def test_rgb_to_hex_is_identical_including_rounding_clipping_and_numpy_inputs(nb):
    cases = [(0, 0, 0), (255, 255, 255), (1.5, 2.5, 3.5), (0.49, 0.5, 0.51), (-20, 300, 127.5), (10.2, 99.9, 254.6), np.array([12.0, 34.0, 56.0]),
             np.array([255, 128, 0], dtype=np.uint8), (np.float32(17.5), np.float64(18.5), 19), [1, 2, 3]]
    for case in cases:
        assert features.rgb_to_hex(case) == nb["rgb_to_hex"](case)
    assert features.rgb_to_hex((255, 0, 0)) == "#FF0000" and features.rgb_to_hex((-5, 999, 16)) == "#00FF10"


def test_structured_images_give_the_obvious_dominant_colours():
    cfg = PipelineConfig()
    params = features.ColorParams.from_config(cfg)
    red = features.compute_lab_color_descriptor(images()["solid red"], params)
    assert red.dominant_hex[0] == "#FF0000" and red.proportions[0] > 0.99
    three = features.compute_lab_color_descriptor(images()["three flat colours"], params)
    assert sorted(three.dominant_hex) == sorted(["#C81E1E", "#1EA03C", "#F0F0F0"]) and abs(sum(three.proportions) - 1.0) < 1e-3
    assert three.proportions == sorted(three.proportions, reverse=True)           # most common colour first
