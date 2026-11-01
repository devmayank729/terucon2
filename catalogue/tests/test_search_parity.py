"""The search port against the user's notebook (cell 6), executed through tests/nb_oracle.py.

(a) HybridRetriever: identical ranks, finalScore / rrfScore / linearScore to 1e-6 and identical per-signal sim / rank for photo, text, hybrid,
    weights override, filters, de-duplication, items missing a pillar (NaN -> rank pool+1), ties, fusion modes.
(b) QueryPhotoPreprocessor.prepare and SyntheticPhoneCapture, byte for byte.
(c) region window math.  (d) profiles / colour mode choose the signals they should.
"""
import asyncio
import sys
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import nb_oracle  # noqa: E402
from fakes_search import (CATALOGUE, RELEASE, REAL_DIMS, SMALL_DIMS, FakeEncoderBank, FakeManager, FakeSynthesizer, MemoryStore,  # noqa: E402
                          make_items, random_release, unit_rows)

from terucon_catalogue.config import COLOUR_ONLY_WEIGHTS, PipelineConfig, compute_feature_versions  # noqa: E402
from terucon_catalogue.release_reader import BadRequestError, load_release  # noqa: E402
from terucon_catalogue.search import (HybridRetriever, QueryEncoder, QueryPhotoPreprocessor, QuerySignal, RegionSpec,  # noqa: E402
                                      SyntheticPhoneCapture, evaluate_self_retrieval, photo_plan, resolve_color_function)

PHOTO_SIGNALS = [("dino_image", "dino", "dino"), ("siglip_image", "siglip", "mm"), ("color_image", "color", "color"),
                 ("vertex_mm_image", "vertex_mm", "mm"), ("text_from_photo", "text", "text")]
TEXT_SIGNALS = [("siglip_text", "siglip", "mm"), ("text_query", "text", "text"), ("vertex_mm_text", "vertex_mm", "mm")]


@pytest.fixture(scope="module")
def nb():
    nb_oracle.require_notebook()
    pd = pytest.importorskip("pandas")
    namespace = nb_oracle.load([
        (1, ["KAGGLE_INPUT_ROOT", "PDF_PATH", "SA_SECRET_NAME", "REQUIRE_DUAL_GPU", "l2_normalize_rows", "load_rgb", "resize_max_side",
             "encode_rgb"]),
        (2, ["DEFAULT_PHOTO_WEIGHTS", "DEFAULT_TEXT_WEIGHTS", "DEFAULT_DIRECTION_WEIGHTS", "PipelineConfig"]),
        (6, ["PillarIndex", "PreparedQuery", "QueryPhotoPreprocessor", "QuerySignal", "SearchResult", "HybridRetriever", "SyntheticPhoneCapture"]),
    ], extra={"pd": pd})
    namespace["pd"] = pd
    return namespace


class SyncEncoder:
    """The notebook's QueryEncoder interface, returning fixed signals."""

    def __init__(self, signal_class, photo, text):
        self.photo = [signal_class(*spec) for spec in photo]
        self.text = [signal_class(*spec) for spec in text]

    def encode_photo(self, source, describe=True, use_vertex_mm=True):
        return list(self.photo), {"preprocessing": "fixed"}

    def encode_text(self, text, use_vertex_mm=True):
        return list(self.text)


class AsyncEncoder(SyncEncoder):
    async def encode_photo(self, source, describe=True, use_vertex_mm=True, **kwargs):
        return list(self.photo), {"preprocessing": "fixed"}

    async def encode_text(self, text, use_vertex_mm=True):
        return list(self.text), {"preprocessing": "text"}


def query_specs(release, rng, names):
    """(name, pillar, group, vector) for the named signals, with vectors of the right size."""
    specs = []
    for name, pillar, group in names:
        dim = release.pillars[pillar].dim if pillar in release.pillars else 8
        specs.append((name, pillar, group, unit_rows(rng, 1, dim)[0]))
    return specs


def notebook_retriever(nb, release, encoder):
    pd = nb["pd"]
    ids = [item["itemId"] for item in release.items]
    catalog = pd.DataFrame({
        "item_id": ids, "product_id": [item["productId"] for item in release.items], "source_pdf": "x.pdf",
        "page_number": [item["page"] for item in release.items], "image_bbox": [[0, 0, 1, 1]] * len(ids), "id_bbox": [None] * len(ids),
        "match_type": "x", "crop_filepath": "x", "sha256_hash": "x",
        "material_category": [item["category"] for item in release.items], "surface_finish": [item["finish"] for item in release.items],
        "dominant_hex": [item["dominantHex"] for item in release.items],
    }, index=ids)
    pillars = {name: nb["PillarIndex"](name, release.feature_versions[name], list(pm.ids), {i: r for r, i in enumerate(pm.ids)}, pm.matrix, None, "fp")
               for name, pm in release.pillars.items()}
    return nb["HybridRetriever"](nb["PipelineConfig"](), SimpleNamespace(catalog=catalog, pillars=pillars), encoder)


def build(tmp_path, n=14, dims=None, seed=0, missing=None, product_ids=None, pillars=("dino", "siglip", "color", "vertex_mm", "text"), items=None):
    store = MemoryStore()
    cfg = PipelineConfig()
    kwargs = {"items": items or make_items(n, rng=np.random.default_rng(seed), product_ids=product_ids)}
    random_release(store, n, seed=seed, dims=dims, missing=missing, pillars=pillars, **kwargs)
    release = load_release(store, CATALOGUE, RELEASE, tmp_path / "cache", compute_feature_versions(cfg), cfg)
    return cfg, release


def compare(mine, theirs):
    assert mine.signal_names == theirs.signal_names
    assert set(mine.signal_weights) == set(theirs.signal_weights)
    for name, weight in theirs.signal_weights.items():
        assert mine.signal_weights[name] == pytest.approx(weight, abs=1e-12)
    assert mine.pool_item_ids == theirs.pool_item_ids
    assert np.array_equal(mine.fused_order, theirs.fused_order)
    assert set(mine.signal_ranks) == set(theirs.signal_ranks)
    for name, ranks in theirs.signal_ranks.items():
        assert np.array_equal(mine.signal_ranks[name], ranks), name
    frame = theirs.results
    if frame.empty:
        assert mine.results == []
        return
    assert [r["itemId"] for r in mine.results] == list(frame["item_id"])
    assert [r["rank"] for r in mine.results] == list(frame["rank"])
    for mine_key, nb_key in (("finalScore", "final_score"), ("rrfScore", "rrf_score"), ("linearScore", "linear_score")):
        np.testing.assert_allclose([r[mine_key] for r in mine.results], frame[nb_key].to_numpy(dtype=float), atol=1e-6, rtol=0)
    for name in theirs.signal_names:
        for position, record in enumerate(mine.results):
            sim = frame[f"sim_{name}"].iloc[position]
            if record["signals"][name]["sim"] is None:
                assert np.isnan(sim), (name, position)
            else:
                assert record["signals"][name]["sim"] == pytest.approx(float(sim), abs=1e-6)
            assert record["signals"][name]["rank"] == int(frame[f"rank_{name}"].iloc[position])


def run_both(nb, cfg, release, photo=None, text=None, *, photo_names=PHOTO_SIGNALS, text_names=TEXT_SIGNALS, port_filters=None,
             nb_filters=None, seed=1, **kwargs):
    rng = np.random.default_rng(seed)
    photo_specs = query_specs(release, rng, photo_names)
    text_specs = query_specs(release, rng, text_names)
    theirs = notebook_retriever(nb, release, SyncEncoder(nb["QuerySignal"], photo_specs, text_specs)).search(
        photo=photo, text=text, filters=nb_filters, describe_photo=False, use_vertex_mm=False, **kwargs)
    retriever = HybridRetriever(cfg, release, AsyncEncoder(QuerySignal, photo_specs, text_specs))
    mine = asyncio.run(retriever.search(photo=photo, text=text, filters=port_filters, describe_photo=False, use_vertex_mm=False, **kwargs))
    compare(mine, theirs)
    return mine, theirs


# ------------------------------------------------------------------------------------------------------------------------
# (a) retrieval parity
# ------------------------------------------------------------------------------------------------------------------------
def test_photo_five_signals(nb, tmp_path):
    cfg, release = build(tmp_path)
    mine, theirs = run_both(nb, cfg, release, photo="p", top_k=10)
    assert len(mine.results) == 10 and mine.signal_names == ["dino_image", "siglip_image", "color_image", "vertex_mm_image", "text_from_photo"]
    # the signal weights the notebook printed in its own stored output (cell 7: "Signals: {...}") for exactly these five signals
    assert mine.signal_weights == pytest.approx({"dino_image": 0.35, "siglip_image": 0.125, "color_image": 0.25, "vertex_mm_image": 0.125,
                                                 "text_from_photo": 0.15})


def test_photo_three_signals_fast_profile(nb, tmp_path):
    cfg, release = build(tmp_path)
    mine, _ = run_both(nb, cfg, release, photo="p", photo_names=PHOTO_SIGNALS[:3], top_k=7)
    assert mine.signal_weights == pytest.approx({"dino_image": 0.35 / 0.85, "siglip_image": 0.25 / 0.85, "color_image": 0.25 / 0.85})


def test_text_three_signals(nb, tmp_path):
    cfg, release = build(tmp_path)
    mine, _ = run_both(nb, cfg, release, text="polished stone", top_k=6)
    assert mine.signal_weights == pytest.approx({"siglip_text": 0.2, "text_query": 0.6, "vertex_mm_text": 0.2})


def test_hybrid_photo_and_text(nb, tmp_path):
    cfg, release = build(tmp_path)
    run_both(nb, cfg, release, photo="p", text="t", top_k=9)


@pytest.mark.parametrize("weights", [{"color": 1.0}, {"dino": 0.5, "mm": 0.5}, {"dino": 1.0, "color": 3.0, "text": 0.0}])
def test_weights_override(nb, tmp_path, weights):
    cfg, release = build(tmp_path)
    mine, _ = run_both(nb, cfg, release, photo="p", weights=weights, top_k=8)
    if weights == {"color": 1.0}:
        assert mine.signal_names == ["color_image"] and mine.signal_weights == {"color_image": 1.0}


@pytest.mark.parametrize("fusion", ["rrf", "linear", "hybrid"])
def test_fusion_modes(nb, tmp_path, fusion):
    cfg, release = build(tmp_path)
    run_both(nb, cfg, release, photo="p", fusion_mode=fusion, top_k=10)


@pytest.mark.parametrize("category, finish", [(["stone"], None), (None, ["matte"]), (["stone", "metal"], ["polished"]), (["nothing-like-this"], None)])
def test_filters(nb, tmp_path, category, finish):
    cfg, release = build(tmp_path, n=20)
    port, notebook = {}, {}
    if category:
        port["category"], notebook["material_category"] = category, category
    if finish:
        port["finish"], notebook["surface_finish"] = finish, finish
    mine, _ = run_both(nb, cfg, release, photo="p", port_filters=port, nb_filters=notebook, top_k=20)
    if category == ["nothing-like-this"]:
        assert mine.results == []
    else:
        allowed = {item["itemId"] for item in release.items if (not category or item["category"] in category) and (not finish or item["finish"] in finish)}
        assert {r["itemId"] for r in mine.results} == allowed


def test_deduplication_by_product_id(nb, tmp_path):
    ids = ["P1", "P1", "P2", None, None, "P2", "P3", None, "P1", "P4"]
    cfg, release = build(tmp_path, n=10, product_ids=ids)
    mine, _ = run_both(nb, cfg, release, photo="p", top_k=10)
    products = [next(i for i in release.items if i["itemId"] == r["itemId"])["productId"] for r in mine.results]
    assert sorted(p for p in products if p) == ["P1", "P2", "P3", "P4"]            # each product once ...
    assert sum(1 for p in products if p is None) == 3                              # ... items with no productId are never merged


def test_empty_product_id_never_merges_items(tmp_path):
    """PORT: the notebook's ids always matched a 3+ character regex, so '' never occurred; here it is not an id."""
    cfg, release = build(tmp_path, n=6, product_ids=["", "", "", "", "", ""])
    retriever = HybridRetriever(cfg, release, AsyncEncoder(QuerySignal, query_specs(release, np.random.default_rng(1), PHOTO_SIGNALS), []))
    assert len(asyncio.run(retriever.search(photo="p", top_k=6)).results) == 6


def test_items_missing_a_pillar_rank_last_with_null_sim(nb, tmp_path):
    cfg, release = build(tmp_path, n=14, missing={"dino": {0, 3}, "vertex_mm": {1, 2, 5}, "text": {7}, "color": {13}})
    mine, theirs = run_both(nb, cfg, release, photo="p", top_k=14)
    pool = len(mine.pool_item_ids)
    by_id = {r["itemId"]: r for r in mine.results}
    missing_dino = release.items[0]["itemId"]
    assert by_id[missing_dino]["signals"]["dino_image"] == {"sim": None, "rank": pool + 1}
    assert by_id[release.items[13]["itemId"]]["signals"]["color_image"]["rank"] == pool + 1


def test_ties_break_like_the_notebook(nb, tmp_path):
    cfg, release = build(tmp_path, n=8)
    for pillar in release.pillars.values():                      # two items with the very same vector in every pillar
        pillar.matrix[5] = pillar.matrix[2]
    mine, _ = run_both(nb, cfg, release, photo="p", top_k=8)
    assert mine.pool_item_ids == sorted(mine.pool_item_ids)


def test_top_k_larger_than_catalogue_and_one(nb, tmp_path):
    cfg, release = build(tmp_path, n=5)
    assert len(run_both(nb, cfg, release, photo="p", top_k=60)[0].results) == 5
    assert len(run_both(nb, cfg, release, photo="p", top_k=1)[0].results) == 1


def test_release_without_a_pillar_drops_its_signals_and_says_so(nb, tmp_path):
    cfg, release = build(tmp_path, pillars=("dino", "siglip", "color"))
    mine, _ = run_both(nb, cfg, release, photo="p", top_k=5)
    assert mine.signal_names == ["dino_image", "siglip_image", "color_image"]
    assert any("vertex_mm_image skipped" in w for w in mine.query_info["warnings"])
    assert any("text_from_photo skipped" in w for w in mine.query_info["warnings"])


def test_real_vector_sizes_69_items(nb, tmp_path):
    cfg, release = build(tmp_path, n=69, dims=REAL_DIMS)
    assert {n: p.dim for n, p in release.pillars.items()} == REAL_DIMS
    run_both(nb, cfg, release, photo="p", text="t", top_k=10)


def test_no_usable_signal_and_empty_release_are_typed_errors(tmp_path):
    cfg, release = build(tmp_path, pillars=("color",))
    retriever = HybridRetriever(cfg, release, AsyncEncoder(QuerySignal, [], [("siglip_text", "siglip", "mm", np.ones(4, np.float32))]))
    with pytest.raises(Exception) as caught:
        asyncio.run(retriever.search(text="x"))
    assert caught.value.reason == "no-usable-signal" and caught.value.status == 409


def test_wrong_query_dimension_is_a_version_mismatch(tmp_path):
    cfg, release = build(tmp_path)
    retriever = HybridRetriever(cfg, release, AsyncEncoder(QuerySignal, [("dino_image", "dino", "dino", np.ones(7, np.float32))], []))
    with pytest.raises(Exception) as caught:
        asyncio.run(retriever.search(photo="p"))
    assert caught.value.reason == "feature-version-mismatch"


# ------------------------------------------------------------------------------------------------------------------------
# (b) photo preprocessing, byte for byte
# ------------------------------------------------------------------------------------------------------------------------
def swatch_image():
    """A light printed card with a coloured block: bright enough to stand out from the (70..170 grey) table SyntheticPhoneCapture draws."""
    rgb = np.full((300, 400, 3), (236, 232, 224), dtype=np.uint8)
    rgb[90:210, 130:270] = (200, 40, 50)
    return rgb


def test_synthetic_phone_capture_is_the_notebooks(nb):
    swatch = swatch_image()
    for seed in (0, 3):
        assert np.array_equal(nb["SyntheticPhoneCapture"](seed)(swatch), SyntheticPhoneCapture(seed)(swatch))


def test_preprocessor_finds_the_card_exactly_like_the_notebook(nb):
    cfg = PipelineConfig()
    theirs = nb["QueryPhotoPreprocessor"](cfg)
    mine = QueryPhotoPreprocessor(cfg)
    for seed in range(12):
        photo = SyntheticPhoneCapture(seed)(swatch_image())
        expected = theirs.prepare(photo)
        if expected.method == "perspective_rectified":
            break
    else:
        pytest.fail("no synthetic phone photo of a card was recognised as a card in 12 seeds")
    got = mine.prepare(photo)
    assert got.method == "perspective_rectified" and got.quad == expected.quad
    assert np.array_equal(got.rectified_rgb, expected.rectified_rgb) and np.array_equal(got.original_rgb, expected.original_rgb)


def test_preprocessor_centre_crops_when_there_is_no_card_exactly_like_the_notebook(nb):
    cfg = PipelineConfig()
    gradient = np.tile(np.linspace(0, 255, 640, dtype=np.uint8)[None, :, None], (480, 1, 3))
    expected = nb["QueryPhotoPreprocessor"](cfg).prepare(gradient)
    got = QueryPhotoPreprocessor(cfg).prepare(gradient)
    assert expected.method == got.method == "center_crop" and got.quad is None
    assert got.rectified_rgb.shape == (384, 512, 3) and np.array_equal(got.rectified_rgb, expected.rectified_rgb)


# ------------------------------------------------------------------------------------------------------------------------
# (c) region
# ------------------------------------------------------------------------------------------------------------------------
@pytest.mark.parametrize("params, expected", [
    (dict(point=(0.5, 0.5)), (404, 304, 596, 496)),                       # 1000 x 800: half-side 0.12 * 800 = 96 -> a 192 px square = 24 % of the short side
    (dict(point=(0.0, 0.0)), (0, 0, 96, 96)),                              # clipped at the top-left corner, not shifted
    (dict(point=(1.0, 1.0)), (904, 704, 1000, 800)),
    (dict(point=(0.5, 0.5), radius=0.5), (100, 0, 900, 800)),
    (dict(point=(0.5, 0.5), radius=1.0), (0, 0, 1000, 800)),
    (dict(box=(0.25, 0.25, 0.75, 0.75)), (250, 200, 750, 600)),
    (dict(box=(0.0, 0.0, 1.0, 1.0)), (0, 0, 1000, 800)),
    (dict(box=(0.5, 0.5, 0.501, 0.501)), (492, 392, 508, 408)),            # smaller than 16 px: grown around its centre
    (dict(box=(0.999, 0.999, 1.0, 1.0)), (984, 784, 1000, 800)),           # ... and pushed back inside the image at the border
])
def test_region_window(params, expected):
    assert RegionSpec.from_params(**params).window(800, 1000) == expected


def test_prepare_region_crops_without_card_detection_or_centre_crop():
    cfg = PipelineConfig()
    rgb = swatch_image()                                                   # 300 x 400
    prepared = QueryPhotoPreprocessor(cfg).prepare_region(rgb, RegionSpec.from_params(point=(0.5, 0.5)))
    assert prepared.method == "region" and prepared.quad is None
    assert np.array_equal(prepared.rectified_rgb, rgb[114:186, 164:236])   # half-side 0.12 * 300 = 36
    assert np.array_equal(prepared.original_rgb, rgb)


@pytest.mark.parametrize("params", [
    dict(point=(0.5, 0.5), box=(0.1, 0.1, 0.5, 0.5)),                      # point and box together
    dict(radius=0.1), dict(box=(0.1, 0.1, 0.5, 0.5), radius=0.1),
    dict(box=(0.5, 0.1, 0.4, 0.5)), dict(box=(0.1, 0.5, 0.5, 0.4)), dict(box=(0.1, 0.1, 0.1, 0.5)),     # not ordered
    dict(point=(1.1, 0.5)), dict(point=(-0.1, 0.5)), dict(point=(0.5, float("nan"))), dict(point=(0.5, float("inf"))),
    dict(point=(0.5, 0.5), radius=0.0), dict(point=(0.5, 0.5), radius=1.5), dict(point=(0.5, 0.5), radius=-1),
    dict(point=(0.5,)), dict(box=(0.1, 0.2, 0.3)), dict(box=(0.1, 0.2, 0.3, 1.2)), dict(point=(True, 0.5)),
])
def test_region_rejections(params):
    with pytest.raises(BadRequestError):
        RegionSpec.from_params(**params)


def test_no_region_is_none():
    assert RegionSpec.from_params() is None


# ------------------------------------------------------------------------------------------------------------------------
# (d) profiles and colour mode choose the signals
# ------------------------------------------------------------------------------------------------------------------------
def encoder_with(**kwargs):
    cfg = PipelineConfig()
    bank, manager, synth = FakeEncoderBank(), kwargs.get("manager", FakeManager()), kwargs.get("synthesizer", FakeSynthesizer())
    encoder = QueryEncoder(cfg, bank, manager, synth, color_fn=resolve_color_function(cfg))
    return encoder, bank, manager, synth


PHOTO = np.random.default_rng(0).integers(0, 255, (120, 160, 3), dtype=np.uint8)


@pytest.mark.parametrize("profile, names, vertex_calls, describe_calls", [
    ("fast", ["dino_image", "siglip_image", "color_image"], 0, 0),
    ("balanced", ["dino_image", "siglip_image", "color_image", "vertex_mm_image"], 1, 0),
    ("full", ["dino_image", "siglip_image", "color_image", "vertex_mm_image", "text_from_photo"], 1, 1),
])
def test_profiles_select_their_signals(profile, names, vertex_calls, describe_calls):
    encoder, bank, manager, synth = encoder_with()
    plan = photo_plan("look", profile)
    signals, info = asyncio.run(encoder.encode_photo(PHOTO, describe=plan.describe, use_vertex_mm=plan.use_vertex_mm, neural=plan.neural))
    assert [s.name for s in signals] == names and info["warnings"] == []
    assert sum(1 for c in manager.calls if c[0] == "multimodal_embed") == vertex_calls and synth.calls == describe_calls
    assert bank.image_calls[0][1] is True                                  # horizontal-flip TTA is on, as in the notebook
    assert [s.vector.shape[0] for s in signals[:3]] == [24, 16, 396]       # colour descriptor: 6*8*8 histogram + 3*4 dominant colours
    if profile == "full":
        assert info["query_caption_model"] == "fake-gemini" and info["query_profile"]["material_category"] == "stone"
        assert [c for c in manager.calls if c[0] == "embed_text"] == [("embed_text", "RETRIEVAL_QUERY", manager.calls[-1][2])]


def test_colour_mode_computes_only_the_colour_signal_with_weight_one(tmp_path):
    cfg, release = build(tmp_path, dims=dict(SMALL_DIMS, color=396))
    encoder, bank, manager, synth = encoder_with()
    plan = photo_plan("colour", "full")                                    # the profile is irrelevant in colour mode
    assert (plan.neural, plan.use_vertex_mm, plan.describe, plan.weights) == (False, False, False, COLOUR_ONLY_WEIGHTS)
    retriever = HybridRetriever(cfg, release, QueryEncoder(cfg, bank, manager, synth, color_fn=resolve_color_function(cfg)))
    result = asyncio.run(retriever.search(photo=PHOTO, top_k=5, weights=plan.weights, describe_photo=plan.describe, use_vertex_mm=plan.use_vertex_mm,
                                          neural=plan.neural))
    assert result.signal_names == ["color_image"] and result.signal_weights == {"color_image": 1.0}
    assert bank.image_calls == [] and manager.calls == [] and synth.calls == 0
    assert result.query_info["dominant_hex"] and result.query_info["preprocessing"] in ("center_crop", "perspective_rectified")


def test_optional_signals_fail_soft_with_warnings():
    manager = FakeManager(fail=("multimodal_embed", "embed_text"))
    encoder, bank, manager, synth = encoder_with(manager=manager)
    signals, info = asyncio.run(encoder.encode_photo(PHOTO, describe=True, use_vertex_mm=True))
    assert [s.name for s in signals] == ["dino_image", "siglip_image", "color_image"]
    assert len(info["warnings"]) == 2 and all("unavailable" in w for w in info["warnings"])
    encoder, *_ = encoder_with(synthesizer=FakeSynthesizer(fail=True))
    signals, info = asyncio.run(encoder.encode_photo(PHOTO, describe=True, use_vertex_mm=False))
    assert "text_from_photo" not in [s.name for s in signals] and any("text_from_photo unavailable" in w for w in info["warnings"])


def test_without_a_manager_the_wanted_vertex_signals_are_skipped_with_a_warning():
    cfg = PipelineConfig()
    encoder = QueryEncoder(cfg, FakeEncoderBank(), None, None, color_fn=resolve_color_function(cfg))
    signals, info = asyncio.run(encoder.encode_photo(PHOTO, describe=True, use_vertex_mm=True))
    assert [s.name for s in signals] == ["dino_image", "siglip_image", "color_image"] and len(info["warnings"]) == 2
    text_signals, text_info = asyncio.run(encoder.encode_text("polished stone"))
    assert [s.name for s in text_signals] == ["siglip_text"] and "SigLIP text signal only" in text_info["warnings"][0]


def test_text_signals_with_everything_available():
    encoder, bank, manager, _ = encoder_with()
    signals, info = asyncio.run(encoder.encode_text("polished stone"))
    assert [s.name for s in signals] == ["siglip_text", "text_query", "vertex_mm_text"] and info["warnings"] == []
    assert bank.text_calls == [["polished stone"]]


def test_vertex_disabled_by_the_manager_is_respected():
    encoder, *_ = encoder_with(manager=FakeManager(disabled=("vertex_mm",)))
    signals, info = asyncio.run(encoder.encode_photo(PHOTO, describe=False, use_vertex_mm=True))
    assert "vertex_mm_image" not in [s.name for s in signals] and "not available" in info["warnings"][0]


def test_encoder_forward_runs_off_the_event_loop_thread():
    import threading
    encoder, bank, *_ = encoder_with()
    asyncio.run(encoder.encode_photo(PHOTO, describe=False, use_vertex_mm=False))
    assert bank.threads and threading.current_thread().name not in bank.threads


def test_self_retrieval_benchmark_runs_over_a_release(tmp_path):
    """The generalised evaluate_self_retrieval: a loader instead of a pandas catalog. With an encoder whose vectors identify the picture, every
    distorted query must come back as its own top match."""
    cfg = PipelineConfig()
    rng = np.random.default_rng(5)
    items = make_items(8, rng=rng)
    crops = {item["itemId"]: rng.integers(0, 255, (96, 128, 3), dtype=np.uint8) for item in items}

    store = MemoryStore()
    random_release(store, 8, seed=2, items=items, pillars=("color",), dims=dict(SMALL_DIMS, color=396))
    release = load_release(store, CATALOGUE, RELEASE, tmp_path / "c", compute_feature_versions(cfg), cfg)
    retriever = HybridRetriever(cfg, release, QueryEncoder(cfg, None, None, None, color_fn=resolve_color_function(cfg)))
    # give every item the colour vector of its own crop, so the colour signal alone must recover it
    color_fn = resolve_color_function(cfg)
    release.pillars["color"].matrix[:] = [color_fn(crops[i]).vector for i in release.pillars["color"].ids]
    release.pillars["color"].matrix /= np.linalg.norm(release.pillars["color"].matrix, axis=1, keepdims=True)
    rows = asyncio.run(evaluate_self_retrieval(retriever, lambda item_id: crops[item_id], sample_size=8, seed=1))
    assert [r["signal"] for r in rows] == sorted([r["signal"] for r in rows], key=lambda s: -next(r["mrr"] for r in rows if r["signal"] == s))
    assert {r["signal"] for r in rows} == {"color_image", "FUSED"} and all(r["queries"] == 8 for r in rows)
    assert all(0.0 <= r["recall@1"] <= 1.0 and r["recall@5"] >= r["recall@1"] for r in rows)
