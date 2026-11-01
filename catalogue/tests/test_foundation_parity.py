"""The foundation modules (util, schema, config, state) against the notebook's own definitions."""
import dataclasses
import io
import sqlite3
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import nb_oracle  # noqa: E402

from terucon_catalogue import config as port_config  # noqa: E402
from terucon_catalogue import schema as port_schema  # noqa: E402
from terucon_catalogue import state as port_state  # noqa: E402
from terucon_catalogue import util as port_util  # noqa: E402

pytestmark = pytest.mark.usefixtures("need_notebook")


@pytest.fixture(scope="module")
def need_notebook():
    nb_oracle.require_notebook()


@pytest.fixture(scope="module")
def nb():
    return nb_oracle.load([
        (1, ["KAGGLE_INPUT_ROOT", "PDF_PATH", "SA_SECRET_NAME", "REQUIRE_DUAL_GPU", "IMAGE_EXTENSIONS", "sha256_bytes", "sha256_file",
             "atomic_write_bytes", "chunked", "l2_normalize_rows", "load_rgb", "resize_max_side", "encode_rgb", "list_images", "utc_now_iso"]),
        (2, ["DEFAULT_PHOTO_WEIGHTS", "DEFAULT_TEXT_WEIGHTS", "DEFAULT_DIRECTION_WEIGHTS", "PipelineConfig", "EmbeddingRow", "StateStore"]),
        (4, ["local_feature_versions", "vertex_mm_version"]),
        (5, ["MaterialCategory", "SurfaceFinish", "MaterialProfile", "CAPTION_SYSTEM_PROMPT", "CAPTION_USER_TEMPLATE", "compose_search_document",
             "format_dominant_colors", "compute_caption_version", "compute_feature_versions"]),
    ])


def test_feature_versions_are_the_notebooks(nb):
    cfg = port_config.PipelineConfig()
    expected = nb["compute_feature_versions"](nb["PipelineConfig"]())
    assert port_config.compute_feature_versions(cfg) == expected
    assert set(expected) == {"dino", "siglip", "color", "vertex_mm", "text"}


def test_prompts_and_schema_are_verbatim(nb):
    assert port_schema.CAPTION_SYSTEM_PROMPT == nb["CAPTION_SYSTEM_PROMPT"]
    assert port_schema.CAPTION_USER_TEMPLATE == nb["CAPTION_USER_TEMPLATE"]
    assert port_schema.MaterialProfile.model_json_schema() == nb["MaterialProfile"].model_json_schema()
    # the caption fingerprint depends on exactly these
    assert port_config.compute_caption_version(port_config.PipelineConfig()) == nb["compute_caption_version"](nb["PipelineConfig"]())


def test_search_document_is_verbatim(nb):
    profile = {"material_category": "stone", "material_subtype": "polished black marble", "surface_finish": "polished",
               "secondary_finishes": ["honed"], "grain_or_pattern_description": "veined", "pattern_scale": "20 mm",
               "color_palette_description": "#111111", "specular_behavior": "sharp", "micro_surface_feel": "smooth",
               "search_keywords": ["marble", "black"], "nano_banana_render_prompt": "text"}
    assert port_schema.compose_search_document(profile, ["#111111"]) == nb["compose_search_document"](profile, ["#111111"])
    assert port_schema.format_dominant_colors({"dominant_hex": ["#111111"], "proportions": [0.5]}) == nb["format_dominant_colors"](
        {"dominant_hex": ["#111111"], "proportions": [0.5]})


def test_config_defaults_equal_the_notebooks_for_every_shared_field(nb):
    ours = port_config.PipelineConfig()
    theirs = nb["PipelineConfig"]()
    shared = {f.name for f in dataclasses.fields(ours)} & {f.name for f in dataclasses.fields(theirs)}
    assert "dino_model_name" in shared and "color_bins" in shared and "photo_weights" in shared
    for name in sorted(shared):
        if name == "work_dir":
            continue  # a Kaggle path there, a relative one here
        assert getattr(ours, name) == getattr(theirs, name), name
    # what was removed on purpose is exactly what the module says it removed
    removed = {f.name for f in dataclasses.fields(theirs)} - {f.name for f in dataclasses.fields(ours)}
    assert removed == {"input_root", "pdf_path", "service_account_secret", "query_photo_dir", "scene_dir", "require_dual_gpu",
                       "image_model_candidates", "render_image_size", "render_swatch_max_side_px", "render_scene_max_side_px",
                       "candidate_pool_size", "exhaustive_search_max_items", "faiss_index_type", "hnsw_m"}


def test_weights_constants(nb):
    assert port_config.DEFAULT_PHOTO_WEIGHTS == nb["DEFAULT_PHOTO_WEIGHTS"]
    assert port_config.DEFAULT_TEXT_WEIGHTS == nb["DEFAULT_TEXT_WEIGHTS"]
    assert port_config.DEFAULT_DIRECTION_WEIGHTS == nb["DEFAULT_DIRECTION_WEIGHTS"]


def test_util_functions_behave_like_the_notebooks(nb, tmp_path):
    rng = np.random.default_rng(3)
    rgb = rng.integers(0, 255, (300, 200, 3), dtype=np.uint8)
    assert port_util.sha256_bytes(b"abc") == nb["sha256_bytes"](b"abc")
    assert np.array_equal(port_util.resize_max_side(rgb, 100), nb["resize_max_side"](rgb, 100))
    assert port_util.encode_rgb(rgb, "png") == nb["encode_rgb"](rgb, "png")
    assert port_util.encode_rgb(rgb, "jpeg", 80) == nb["encode_rgb"](rgb, "jpeg", 80)
    matrix = rng.normal(size=(5, 7))
    assert np.array_equal(port_util.l2_normalize_rows(matrix), nb["l2_normalize_rows"](matrix))
    assert np.array_equal(port_util.load_rgb(port_util.encode_rgb(rgb, "png")), nb["load_rgb"](nb["encode_rgb"](rgb, "png")))
    assert list(port_util.chunked(list(range(7)), 3)) == list(nb["chunked"](list(range(7)), 3))
    path = tmp_path / "a" / "b.bin"
    port_util.atomic_write_bytes(path, b"x")
    assert path.read_bytes() == b"x" and not (tmp_path / "a" / "b.bin.tmp").exists()
    assert port_util.IMAGE_EXTENSIONS == nb["IMAGE_EXTENSIONS"]


def test_state_schema_is_the_notebooks(nb):
    assert port_state.StateStore.SCHEMA == nb["StateStore"].SCHEMA


def test_state_store_round_trips_and_snapshots(tmp_path):
    store = port_state.StateStore(tmp_path / "state.sqlite")
    store.upsert_pdf("a" * 64, "x.pdf", 10, 1, "done")
    store.upsert_embeddings([port_state.EmbeddingRow("i1", "dino", "v", np.ones(4, dtype=np.float32) / 2),
                             port_state.EmbeddingRow("i2", "dino", "v", np.ones(4, dtype=np.float32) / 2)])
    snapshot = store.snapshot_to(tmp_path / "snap" / "state.sqlite")
    with sqlite3.connect(snapshot) as db:
        assert db.execute("SELECT COUNT(*) FROM embeddings").fetchone()[0] == 2
        assert db.execute("SELECT status FROM pdfs").fetchone()[0] == "done"
    store.close()
