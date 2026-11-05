"""terucon_catalogue.accuracy: the tools that measure the search. They must agree with the real search code, or the numbers mean nothing:

  * the page-margin finder cuts the picture out of a catalogue page crop and leaves a full-bleed image alone;
  * re-fusing one answer's recorded signals reproduces HybridRetriever.rank_signals exactly: for the same signals (every final score), and for a SUBSET of the
    signals (a `fast` answer rebuilt from a `full` answer equals the real `fast` answer), even though the answer only holds some of the pool's rows
    (the pool's lowest / highest similarity are recovered from the service's own scores);
  * the metric counts a design printed on two pages once.
"""
import asyncio
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fakes_search import CATALOGUE, RELEASE, MemoryStore, make_items, random_release, unit_rows  # noqa: E402

from terucon_catalogue import accuracy  # noqa: E402
from terucon_catalogue.config import PipelineConfig, compute_feature_versions  # noqa: E402
from terucon_catalogue.release_reader import load_release  # noqa: E402
from terucon_catalogue.search import HybridRetriever, QuerySignal  # noqa: E402

PHOTO = [("dino_image", "dino", "dino"), ("siglip_image", "siglip", "mm"), ("color_image", "color", "color"), ("vertex_mm_image", "vertex_mm", "mm"),
         ("text_from_photo", "text", "text")]


# ------------------------------------------------------------------------------------------------------------------------
# the picture inside a page
# ------------------------------------------------------------------------------------------------------------------------
def page(width=205, height=307, box=(16, 16, 189, 278), fill=(150, 120, 90), label=True):
    """A catalogue page like the real ones: white all over, one picture, a thin printed label under it."""
    image = np.full((height, width, 3), 255, np.uint8)
    left, top, right, bottom = box
    rng = np.random.default_rng(3)
    image[top:bottom, left:right] = np.clip(np.array(fill) + rng.integers(-25, 25, size=(bottom - top, right - left, 3)), 0, 254)
    if label:                                    # a short dark text line and a red rule, nowhere near half of a row
        image[bottom + 12:bottom + 16, left + 4:left + 40] = (20, 20, 20)
        image[bottom + 18:bottom + 19, left:left + 60] = (220, 30, 30)
    return image


def test_swatch_box_finds_the_picture_and_leaves_the_label_out():
    assert accuracy.swatch_box(page()) == (16, 16, 189, 278)
    assert accuracy.swatch_box(page(box=(24, 30, 180, 250))) == (24, 30, 180, 250)


def test_swatch_box_is_not_fooled_by_a_pale_picture_that_is_still_not_white():
    pale = page(fill=(236, 232, 226))
    assert accuracy.swatch_box(pale) == (16, 16, 189, 278)


def test_trim_page_margins_takes_the_picture_and_a_little_more_off_the_edge():
    trimmed = accuracy.trim_page_margins(page(), inset=0.02)
    assert trimmed.shape == (262 - 2 * int(262 * 0.02), 173 - 2 * int(173 * 0.02), 3)
    assert trimmed.min() < 200 and (trimmed < 250).any(axis=2).all(), "no white page pixel is left in what is returned"
    assert trimmed.flags["C_CONTIGUOUS"]


@pytest.mark.parametrize("image", [
    np.random.default_rng(1).integers(0, 255, size=(120, 90, 3)).astype(np.uint8),          # a full-bleed photo: nothing to trim
    np.full((120, 90, 3), 255, np.uint8),                                                    # an all-white page
    page(box=(90, 140, 120, 170), label=False),                                              # a picture too small to be trusted as "the swatch"
])
def test_trim_page_margins_leaves_what_it_cannot_judge_alone(image):
    assert accuracy.swatch_box(image) == (0, 0, image.shape[1], image.shape[0])
    assert accuracy.trim_page_margins(image) is image


# ------------------------------------------------------------------------------------------------------------------------
# synthetic queries
# ------------------------------------------------------------------------------------------------------------------------
@pytest.mark.parametrize("variant", accuracy.QUERY_VARIANTS)
def test_make_query_is_deterministic_and_shaped_as_documented(variant):
    swatch = accuracy.trim_page_margins(page(width=520, height=780, box=(40, 40, 480, 700)))
    first, second = accuracy.make_query(swatch, variant, 7), accuracy.make_query(swatch, variant, 7)
    other = accuracy.make_query(swatch, variant, 8)
    assert first.dtype == np.uint8 and first.ndim == 3 and first.shape[2] == 3
    assert np.array_equal(first, second) and not np.array_equal(first, other)
    if variant == "V1":
        assert max(first.shape[:2]) <= 1024 and max(first.shape[:2]) > 184, "a whole capture, with its table"
    else:
        assert first.shape == (184, 184, 3)
    with pytest.raises(ValueError):
        accuracy.make_query(swatch, "V9", 1)


def test_the_pale_patch_really_is_paler_than_the_plain_one():
    swatch = np.full((600, 500, 3), (150, 110, 70), np.uint8)
    swatch = np.clip(swatch.astype(int) + np.random.default_rng(0).integers(-30, 30, swatch.shape), 0, 255).astype(np.uint8)
    chroma = lambda image: float(np.mean(image.max(axis=2).astype(float) - image.min(axis=2)))   # noqa: E731
    assert chroma(accuracy.make_query(swatch, "V3", 5)) < 0.8 * chroma(accuracy.make_query(swatch, "V2", 5))


# ------------------------------------------------------------------------------------------------------------------------
# re-fusion == the real retriever
# ------------------------------------------------------------------------------------------------------------------------
@pytest.fixture()
def retriever(tmp_path):
    store = MemoryStore()
    product_ids = [f"TIPL-P{index:03d}" if index % 7 else None for index in range(40)]
    items = make_items(40, product_ids=product_ids)
    random_release(store, items=items, seed=4, missing={"vertex_mm": {3, 9}, "text": {5}})
    cfg = PipelineConfig()
    release = load_release(store, CATALOGUE, RELEASE, tmp_path / "cache", compute_feature_versions(cfg), cfg)
    return HybridRetriever(cfg, release), release


def run_service(retriever, release, names, seed, top_k):
    """what the service would answer for these signals: its own results list and weights, the way _response shapes them."""
    rng = np.random.default_rng(seed)
    signals = [QuerySignal(name, pillar, group, unit_rows(rng, 1, release.pillars[pillar].dim)[0]) for name, pillar, group in PHOTO if name in names]
    result = retriever.rank_signals(signals, has_photo=True, has_text=False, top_k=top_k)
    return {"results": result.results, "query": {"weights": {name: round(float(weight), 6) for name, weight in result.signal_weights.items()}}}


def test_refuse_reproduces_the_services_scores_with_the_same_signals(retriever):
    retriever, release = retriever
    answer = run_service(retriever, release, [name for name, _, _ in PHOTO], seed=1, top_k=34)        # 34 of 40: the lowest rows are not returned
    table = accuracy.table_from_answer(answer)
    scores = accuracy.refuse(table)
    np.testing.assert_allclose(scores, table.final, atol=2e-4)
    assert accuracy.ordered(table, scores)[:10] == [row["itemId"] for row in answer["results"]][:10]


@pytest.mark.parametrize("profile", ["fast", "balanced"])
def test_a_smaller_profile_rebuilt_from_a_full_answer_equals_the_real_one(retriever, profile):
    retriever, release = retriever
    full = run_service(retriever, release, accuracy.PROFILE_SIGNALS["full"], seed=2, top_k=36)
    real = run_service(retriever, release, accuracy.PROFILE_SIGNALS[profile], seed=2, top_k=36)         # the same seed: the same query vectors
    table = accuracy.table_from_answer(full)
    scores = accuracy.refuse(table, accuracy.PROFILE_SIGNALS[profile])
    mine = accuracy.ordered(table, scores)
    theirs = [row["itemId"] for row in real["results"]]
    shared = [item for item in theirs if item in set(table.item_ids)][:12]
    assert [item for item in mine if item in set(shared)][:12] == shared, "the same order for the rows both answers hold"
    theirs_by_id = {row["itemId"]: row["finalScore"] for row in real["results"]}
    for item_id, score in zip(table.item_ids, scores):
        if item_id in theirs_by_id:
            assert score == pytest.approx(theirs_by_id[item_id], abs=3e-4)


def test_refuse_other_fusions_and_weights_are_plain_arithmetic(retriever):
    retriever, release = retriever
    table = accuracy.table_from_answer(run_service(retriever, release, accuracy.PROFILE_SIGNALS["full"], seed=3, top_k=36))
    only_rrf = accuracy.refuse(table, fusion="rrf")
    only_linear = accuracy.refuse(table, fusion="linear")
    both = accuracy.refuse(table)
    np.testing.assert_allclose(both, 0.5 * only_rrf + 0.5 * only_linear, atol=1e-9)
    heavy_colour = accuracy.refuse(table, group_weights={"dino": 0.1, "mm": 0.1, "color": 0.7, "text": 0.1})
    assert not np.allclose(heavy_colour, both)
    with pytest.raises(ValueError):
        accuracy.refuse(table, signals=["nonsense"])


def test_signal_weights_are_the_retrievers():
    assert accuracy.signal_weights(accuracy.PROFILE_SIGNALS["fast"]) == pytest.approx({"dino_image": 0.35 / 0.85, "siglip_image": 0.25 / 0.85, "color_image": 0.25 / 0.85})
    full = accuracy.signal_weights(accuracy.PROFILE_SIGNALS["full"])
    assert full["siglip_image"] == full["vertex_mm_image"] == pytest.approx(0.125) and sum(full.values()) == pytest.approx(1.0)
    assert accuracy.signal_weights(["color_image"], {"color": 1.0}) == {"color_image": 1.0}
    assert accuracy.signal_weights(["color_image"], {"dino": 1.0}) == {}


def test_the_pools_lowest_similarity_is_recovered_from_the_services_own_scores(retriever):
    retriever, release = retriever
    answer = run_service(retriever, release, accuracy.PROFILE_SIGNALS["full"], seed=1, top_k=34)
    ends = accuracy.calibrate_pool_ends(accuracy.table_from_answer(answer))
    rng = np.random.default_rng(1)
    for name, pillar, group in PHOTO:
        signal = QuerySignal(name, pillar, group, unit_rows(rng, 1, release.pillars[pillar].dim)[0])
        sims = retriever._similarities(signal, np.arange(len(release.items)))
        assert ends[name][0] == pytest.approx(float(np.nanmin(sims)), abs=1e-3), name      # the low end, which the answer does not hold
        assert ends[name][1] == pytest.approx(float(np.nanmax(sims)), abs=1e-3), name


def test_one_signals_first_row_being_dropped_is_resolved_and_two_are_refused(retriever):
    retriever, release = retriever
    answer = run_service(retriever, release, accuracy.PROFILE_SIGNALS["full"], seed=9, top_k=34)      # the row that siglip likes best is not among the 34 returned
    table = accuracy.table_from_answer(answer)
    assert table.ranks["siglip_image"][~np.isnan(table.sims["siglip_image"])].min() > 1
    ends = accuracy.calibrate_pool_ends(table)
    rng = np.random.default_rng(9)
    for name, pillar, group in PHOTO:
        sims = retriever._similarities(QuerySignal(name, pillar, group, unit_rows(rng, 1, release.pillars[pillar].dim)[0]), np.arange(len(release.items)))
        assert ends[name] == pytest.approx((float(np.nanmin(sims)), float(np.nanmax(sims))), abs=1e-3), name
    np.testing.assert_allclose(accuracy.refuse(table), table.final, atol=2e-4)
    # two signals without their first row cannot be told apart: an error, not a guess
    broken = accuracy.table_from_answer(answer)
    for name in ("dino_image", "color_image"):
        broken.ranks[name] = broken.ranks[name] + 1
    with pytest.raises(ValueError, match="dino_image.*color_image|color_image.*dino_image"):
        accuracy.calibrate_pool_ends(broken)


def test_too_few_rows_or_a_missing_first_row_is_said_not_guessed(retriever):
    retriever, release = retriever
    table = accuracy.table_from_answer(run_service(retriever, release, accuracy.PROFILE_SIGNALS["full"], seed=1, top_k=6))
    with pytest.raises(ValueError, match="k = 60"):
        accuracy.refuse(table)


# ------------------------------------------------------------------------------------------------------------------------
# the metric
# ------------------------------------------------------------------------------------------------------------------------
def test_product_rank_counts_a_design_once_however_many_pages_it_is_printed_on():
    product_of = {"a1": "P1", "a2": "P1", "b": "P2", "c": "P3", "d": "P4"}
    assert accuracy.product_rank(["a1", "a2", "b", "c"], {"P3"}, product_of) == 3, "the second page of P1 is not a place of its own"
    assert accuracy.product_rank(["b", "a2", "c"], {"P1", "P3"}, product_of) == 2, "the first of several right answers counts"
    assert accuracy.product_rank(["b", "c"], {"P9"}, product_of) == 99
    assert accuracy.product_rank(["b", "unknown"], {"unknown"}, product_of) == 2, "an item with no product is its own design"
    assert accuracy.hits([1, 2, 3, 9, 99], (1, 3, 8)) == {1: 1, 3: 3, 8: 3}
