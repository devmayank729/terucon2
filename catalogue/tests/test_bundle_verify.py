"""Bundle.verify(): every way a bundle can be wrong, each on a bundle that is otherwise clean (both path styles), and a few that are wrong together."""
import json
import sqlite3

import numpy as np
import pytest

from factories import (delete_crop, drop_vector, flip_crop_byte, make_bundle, replace_vector, set_caption_status, set_feature_version, set_item_status,
                       truncate_vector, _sql)
from terucon_catalogue.bundle import Bundle, BundleError, errors_of, warnings_of
from terucon_catalogue.config import PipelineConfig, check_feature_versions

CFG = PipelineConfig()


@pytest.fixture(params=[False, True], ids=["relative-paths", "kaggle-absolute-paths"])
def info(request, tmp_path):
    return make_bundle(tmp_path / "bundle", 6, legacy_kaggle_paths=request.param)


def verify(info, cfg=CFG):
    with Bundle(info.path) as bundle:
        return bundle.verify(cfg)


def codes(problems, level=None):
    return sorted(problem.code for problem in problems if level is None or problem.level == level)


def only(problems, code):
    (problem,) = [p for p in problems if p.code == code]
    return problem


def test_a_clean_bundle_has_no_problems_at_all(info):
    assert verify(info) == []
    with Bundle(info.path) as bundle:
        assert bundle.verify() == []                         # also without a config


# ------------------------------------------------------------------------------------------------------------------------------- errors
def test_a_flipped_crop_byte_is_caught_by_the_recorded_checksum(info):
    flip_crop_byte(info, info.item_ids[2])
    problems = verify(info)
    problem = only(problems, "crop-sha256")
    assert problem.level == "error" and info.item_ids[2] in problem.message and "checksum" in problem.message
    assert codes(problems, "error") == ["crop-sha256"]


def test_a_missing_crop_file(info):
    delete_crop(info, info.item_ids[1])
    problem = only(verify(info), "crop-missing")
    assert problem.level == "error" and info.item_ids[1] in problem.message
    assert info.crop_dir in problem.message or "crops" in problem.message        # the message shows what the database says


def test_a_truncated_vector(info):
    truncate_vector(info, info.item_ids[0], "siglip", 1000)
    problem = only(verify(info), "vector-length")
    assert problem.level == "error" and "'siglip'" in problem.message and info.item_ids[0] in problem.message and "truncated" in problem.message


@pytest.mark.parametrize("bad", [np.nan, np.inf, -np.inf])
def test_a_vector_with_nan_or_infinity(info, bad):
    values = info.vectors["color"][info.item_ids[3]].astype(np.float32).copy()
    values[5] = bad
    replace_vector(info, info.item_ids[3], "color", values)
    problem = only(verify(info), "non-finite")
    assert problem.level == "error" and "'color'" in problem.message and info.item_ids[3] in problem.message


@pytest.mark.parametrize("scale, bad", [(1.1, True), (0.9, True), (0.0, True), (1.015, False), (0.985, False), (1.0, False)])
def test_the_row_norm_must_be_one_within_0_02(info, scale, bad):
    values = info.vectors["dino"][info.item_ids[4]].astype(np.float32) * scale
    replace_vector(info, info.item_ids[4], "dino", values)
    problems = verify(info)
    if bad:
        problem = only(problems, "norm")
        assert problem.level == "error" and "'dino'" in problem.message and info.item_ids[4] in problem.message and "not unit length" in problem.message
    else:
        assert "norm" not in codes(problems)


def test_two_feature_versions_in_one_pillar(info):
    set_feature_version(info, info.item_ids[0], "dino", "facebook/dinov2-large|448|r512|w0.5,0.25,0.25|clahe1.5x8|v0-old")
    problems = verify(info)
    problem = only(problems, "feature-version")
    assert problem.level == "error" and "'dino'" in problem.message and "cannot mix" in problem.message
    with Bundle(info.path) as bundle:
        with pytest.raises(BundleError, match="cannot mix feature versions"):
            bundle.feature_versions()


def test_vectors_of_different_sizes_in_one_pillar(info):
    replace_vector(info, info.item_ids[5], "text", np.ones(100, dtype=np.float32) / 10.0)
    problems = verify(info)
    problem = only(problems, "dims")
    assert problem.level == "error" and "'text'" in problem.message and "100" in problem.message and "768" in problem.message
    assert "dims-expected" in codes(problems)                      # and 100 is not what the version label means


def test_every_item_having_the_wrong_size_is_caught_by_the_version_label(tmp_path):
    info = make_bundle(tmp_path / "b", 3, dims={"dino": 1024})        # consistent among themselves, but not what dinov2-large|3 blocks makes
    problems = verify(info)
    assert "dims" not in codes(problems)
    problem = only(problems, "dims-expected")
    assert "'dino'" in problem.message and "3072" in problem.message and "1024" in problem.message
    with Bundle(info.path) as bundle:
        assert "dims-expected" not in codes(bundle.verify())       # needs the config to know what a label means


def test_a_vector_stored_in_another_dtype(info):
    values = np.ones(396, dtype=np.float32) / np.sqrt(396)
    _sql(info, "UPDATE embeddings SET vector = ?, dtype = 'float32' WHERE item_id = ? AND pillar = 'color'", (values.tobytes(), info.item_ids[0]))
    assert only(verify(info), "dtype").level == "error"


def test_items_that_are_not_ok(info):
    set_item_status(info, info.item_ids[0], "error")
    set_item_status(info, info.item_ids[1], "error")
    set_item_status(info, info.item_ids[2], "pending")
    problems = [p for p in verify(info) if p.code == "item-status"]
    assert len(problems) == 2 and all(p.level == "error" for p in problems)
    assert any("'error'" in p.message and info.item_ids[0] in p.message and "2 items" in p.message for p in problems)
    assert any("'pending'" in p.message for p in problems)


def test_an_item_id_that_cannot_be_a_storage_name(info):
    _sql(info, "UPDATE items SET item_id = 'bad/id|x' WHERE item_id = ?", (info.item_ids[0],))
    assert only(verify(info), "item-id").level == "error"


def test_a_bundle_without_items(tmp_path):
    info = make_bundle(tmp_path / "b", 0)
    (problem,) = verify(info)
    assert problem.level == "error" and problem.code == "no-items"


def test_a_crop_that_is_not_an_image_but_matches_its_checksum(info):
    import hashlib

    path = info.crop_paths[info.item_ids[0]]
    path.write_bytes(b"this is not a png")
    _sql(info, "UPDATE items SET sha256_hash = ? WHERE item_id = ?", (hashlib.sha256(b"this is not a png").hexdigest(), info.item_ids[0]))
    assert only(verify(info), "crop-unreadable").level == "error"


def test_crop_dimensions_that_disagree_with_the_database(info):
    _sql(info, "UPDATE items SET crop_width = 999 WHERE item_id = ?", (info.item_ids[0],))
    assert only(verify(info), "crop-size").level == "error"


# ----------------------------------------------------------------------------------------------------------------------------- warnings
def test_a_feature_error_row_is_a_warning_that_names_the_pillar(info):
    for item_id in info.item_ids[:3]:
        drop_vector(info, item_id, "vertex_mm", record_error="ClientError: 429 RESOURCE_EXHAUSTED")
    problems = verify(info)
    problem = only(problems, "feature-errors")
    assert problem.level == "warning" and "'vertex_mm'" in problem.message and "3 items" in problem.message and info.item_ids[0] in problem.message
    assert codes(problems, "error") == [], "a missing optional signal must not block a publish"


def test_captions_that_are_not_ok_are_a_warning(info):
    set_caption_status(info, info.item_ids[0], "error")
    set_caption_status(info, info.item_ids[1], "ok", profile_json="{ this is not json")
    _sql(info, "DELETE FROM captions WHERE item_id = ?", (info.item_ids[2],))
    problems = verify(info)
    problem = only(problems, "captions")
    assert problem.level == "warning" and "3 items" in problem.message and "category, finish or text vector" in problem.message
    assert codes(problems, "error") == []


def test_an_item_with_no_core_vector_is_flagged_as_not_searchable(info):
    for pillar in ("dino", "siglip", "color"):
        drop_vector(info, info.item_ids[0], pillar)
    problems = verify(info)
    problem = only(problems, "not-searchable")
    assert problem.level == "warning" and info.item_ids[0] in problem.message and "left out" in problem.message
    assert codes(problems, "error") == []


def test_an_item_with_only_one_core_vector_is_still_searchable(info):
    drop_vector(info, info.item_ids[0], "dino")
    drop_vector(info, info.item_ids[0], "color")
    assert "not-searchable" not in codes(verify(info))


def test_unfinished_pages_and_pdfs_and_orphan_vectors_are_warnings(info):
    _sql(info, "UPDATE pages SET status = 'error' WHERE page_number = 2")
    _sql(info, "UPDATE pdfs SET status = 'partial'")
    _sql(info, "UPDATE embeddings SET item_id = 'ghost-p0001-i00' WHERE item_id = ? AND pillar = 'text'", (info.item_ids[0],))
    problems = verify(info)
    assert {"pages", "pdfs", "orphan-vectors"} <= set(codes(problems, "warning")) and codes(problems, "error") == []


def test_a_pillar_this_code_does_not_know_is_a_warning(info):
    _sql(info, "INSERT INTO embeddings (item_id, pillar, feature_version, dim, dtype, vector, extra_json, updated_at) VALUES (?, 'newthing', 'v9', 2, 'float16', ?, NULL, 'x')",
         (info.item_ids[0], np.array([0.6, 0.8], dtype=np.float16).tobytes()))
    problem = only(verify(info), "unknown-pillar")
    assert problem.level == "warning" and "newthing" in problem.message


# ------------------------------------------------------------------------------------------------------------------------- several at once
def test_all_the_problems_are_reported_together_not_only_the_first(info):
    flip_crop_byte(info, info.item_ids[0])
    delete_crop(info, info.item_ids[1])
    truncate_vector(info, info.item_ids[2], "dino", 10)
    values = info.vectors["siglip"][info.item_ids[3]].astype(np.float32) * 2
    replace_vector(info, info.item_ids[3], "siglip", values)
    set_feature_version(info, info.item_ids[4], "text", "gemini-embedding-001|d768|capdeadbeefcafe|v0")
    set_item_status(info, info.item_ids[5], "error")
    problems = verify(info)
    assert {"crop-sha256", "crop-missing", "vector-length", "norm", "feature-version", "item-status"} <= set(codes(problems, "error"))
    assert all(isinstance(str(problem), str) and str(problem).endswith((".", ")")) for problem in problems)


def test_many_affected_items_are_summarised_not_listed(tmp_path):
    info = make_bundle(tmp_path / "b", 30)
    for item_id in info.item_ids:
        flip_crop_byte(info, item_id)
    problem = only(verify(info), "crop-sha256")
    assert "30 crop files" in problem.message and "and 27 more" in problem.message and len(problem.message) < 600


def test_the_text_pillar_caption_fingerprint_is_only_a_version_warning(info):
    """check_feature_versions is what the publisher uses on the bundle's labels; a different caption fingerprint must not be an error."""
    versions = dict(info.versions)
    versions["text"] = versions["text"].split("|cap")[0] + "|cap0123456789ab|v1"
    problems = check_feature_versions(versions, CFG)
    assert [p.level for p in problems] == ["warning"] and problems[0].pillar == "text"
    versions["dino"] = "facebook/dinov2-base|224|v1"
    assert [p.pillar for p in check_feature_versions(versions, CFG) if p.level == "error"] == ["dino"]


def test_errors_and_warnings_helpers(info):
    drop_vector(info, info.item_ids[0], "text", record_error="boom")
    flip_crop_byte(info, info.item_ids[1])
    problems = verify(info)
    assert [p.code for p in errors_of(problems)] == ["crop-sha256"] and [p.code for p in warnings_of(problems)] == ["feature-errors"]
