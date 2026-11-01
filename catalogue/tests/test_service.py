"""SearchService: the response contract, the GPU gate, bad input, release handling, degradation, and that a query photo is never logged or kept."""
import asyncio
import base64
import json
import logging
import sys
import threading
import time
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fakes_search import (CATALOGUE, RELEASE, SMALL_DIMS, FakeEncoderBank, FakeManager, FakeSynthesizer, MemoryStore, make_items,  # noqa: E402
                          random_release)

from terucon_catalogue.config import PipelineConfig, compute_feature_versions  # noqa: E402
from terucon_catalogue.release_reader import (BadRequestError, FeatureVersionMismatchError, ReleaseCorruptError, ReleaseMissingError,  # noqa: E402
                                              ServiceError)
from terucon_catalogue.search import resolve_color_function  # noqa: E402
from terucon_catalogue.service import BadImageError, BusyError, SearchService, decode_query_image  # noqa: E402
from terucon_catalogue.util import encode_rgb  # noqa: E402

DIMS = dict(SMALL_DIMS, color=396)
SECOND_RELEASE = "rel-20261102120000-def456"
RESPONSE_KEYS = ["ok", "catalogue", "release", "mode", "profile", "query", "results"]
QUERY_KEYS = ["preprocessing", "dominantHex", "signals", "weights", "timingsMs", "warnings"]
TIMING_KEYS = ["prepare", "encode", "vertex", "describe", "fuse", "total"]
RESULT_KEYS = ["rank", "itemId", "finalScore", "rrfScore", "linearScore", "signals"]


def photo_bytes(seed=0, size=(150, 200), fmt="jpeg"):
    rgb = np.random.default_rng(seed).integers(0, 255, (*size, 3), dtype=np.uint8)
    return encode_rgb(rgb, fmt, 90)


def make_service(tmp_path, n=12, *, encoders=True, manager=True, synthesizer=True, store=None, **kwargs):
    cfg = PipelineConfig()
    store = store or MemoryStore()
    if not store.objects:
        random_release(store, n, seed=1, dims=DIMS)
    service = SearchService(cfg, store=store, cache_dir=tmp_path / "cache", color_fn=resolve_color_function(cfg),
                            encoders=FakeEncoderBank() if encoders is True else (encoders or None),
                            manager=FakeManager() if manager is True else (manager or None),
                            synthesizer=FakeSynthesizer() if synthesizer is True else (synthesizer or None), **kwargs)
    return service, store


def search(service, data=None, **kwargs):
    arguments = dict(catalogue=CATALOGUE, release=RELEASE)
    arguments.update(kwargs)
    return asyncio.run(service.search_photo(photo_bytes() if data is None else data, **arguments))


# ------------------------------------------------------------------------------------------------------------------------
def test_photo_search_response_has_exactly_the_contract_shape(tmp_path):
    service, _ = make_service(tmp_path)
    response = search(service, k=5)
    assert list(response) == RESPONSE_KEYS and response["ok"] is True
    assert (response["catalogue"], response["release"], response["mode"], response["profile"]) == (CATALOGUE, RELEASE, "look", "fast")
    assert list(response["query"]) == QUERY_KEYS and list(response["query"]["timingsMs"]) == TIMING_KEYS
    assert response["query"]["preprocessing"] in ("center_crop", "perspective_rectified")
    assert response["query"]["signals"] == ["dino_image", "siglip_image", "color_image"] and response["query"]["warnings"] == []
    assert sum(response["query"]["weights"].values()) == pytest.approx(1.0)
    assert all(isinstance(h, str) and h.startswith("#") for h in response["query"]["dominantHex"]) and response["query"]["dominantHex"]
    timings = response["query"]["timingsMs"]
    assert all(isinstance(v, float) and v >= 0 for v in timings.values()) and timings["total"] >= timings["fuse"]
    assert len(response["results"]) == 5
    for rank, result in enumerate(response["results"], 1):
        assert list(result) == RESULT_KEYS and result["rank"] == rank
        assert set(result["signals"]) == {"dino_image", "siglip_image", "color_image"}
        assert all(set(s) == {"sim", "rank"} for s in result["signals"].values())
    json.dumps(response, allow_nan=False)                      # plain JSON numbers / strings / None only


def test_text_search_response(tmp_path):
    service, _ = make_service(tmp_path)
    response = asyncio.run(service.search_text("polished stone", catalogue=CATALOGUE, release=RELEASE, k=4))
    assert list(response) == RESPONSE_KEYS and response["mode"] == "text" and response["profile"] is None
    assert response["query"]["preprocessing"] == "text" and response["query"]["dominantHex"] == []
    assert response["query"]["signals"] == ["siglip_text", "text_query", "vertex_mm_text"] and len(response["results"]) == 4
    assert list(response["query"]["timingsMs"]) == TIMING_KEYS


def test_text_search_degrades_to_siglip_only_without_a_vertex_manager(tmp_path):
    service, _ = make_service(tmp_path, manager=False)
    response = asyncio.run(service.search_text("polished stone", catalogue=CATALOGUE, release=RELEASE))
    assert response["query"]["signals"] == ["siglip_text"] and response["query"]["weights"] == {"siglip_text": 1.0}
    assert len(response["query"]["warnings"]) == 1 and "SigLIP text signal only" in response["query"]["warnings"][0]
    assert response["results"]


def test_text_search_survives_vertex_failures(tmp_path):
    service, _ = make_service(tmp_path, manager=FakeManager(fail=("embed_text", "multimodal_embed")))
    response = asyncio.run(service.search_text("matte metal", catalogue=CATALOGUE, release=RELEASE))
    assert response["query"]["signals"] == ["siglip_text"] and len(response["query"]["warnings"]) == 2 and response["results"]


def test_colour_mode_uses_only_the_colour_signal_and_no_gpu(tmp_path):
    service, _ = make_service(tmp_path)
    response = search(service, mode="colour", profile="full")
    assert response["mode"] == "colour" and response["query"]["signals"] == ["color_image"] and response["query"]["weights"] == {"color_image": 1.0}
    assert service.encoders.image_calls == [] and service.manager.calls == [] and service.synthesizer.calls == 0
    assert service.gate.active == 0


@pytest.mark.parametrize("profile, signals", [("fast", 3), ("balanced", 4), ("full", 5)])
def test_profiles(tmp_path, profile, signals):
    service, _ = make_service(tmp_path)
    response = search(service, profile=profile)
    assert len(response["query"]["signals"]) == signals and response["profile"] == profile


def test_full_profile_survives_a_failing_description(tmp_path):
    service, _ = make_service(tmp_path, synthesizer=FakeSynthesizer(fail=True))
    response = search(service, profile="full")
    assert "text_from_photo" not in response["query"]["signals"] and any("text_from_photo unavailable" in w for w in response["query"]["warnings"])
    assert response["results"]


def test_region_query_skips_card_detection_and_centre_crop(tmp_path):
    service, _ = make_service(tmp_path)
    response = search(service, photo_bytes(size=(200, 300)), region={"point": (0.5, 0.5)})
    assert response["query"]["preprocessing"] == "region"
    assert service.encoders.image_calls[0][2] == [(48, 48, 3)]               # half-side 0.12 * the shorter side (200) = 24 px -> 48 x 48
    response = search(service, photo_bytes(size=(200, 300)), region={"box": (0.0, 0.0, 0.5, 1.0)})
    assert service.encoders.image_calls[1][2] == [(200, 150, 3)]
    with pytest.raises(BadRequestError):
        search(service, region={"point": (0.5, 0.5), "box": (0.1, 0.1, 0.2, 0.2)})


def test_filters_restrict_the_results(tmp_path):
    service, store = make_service(tmp_path, n=20)
    items = json.loads(store.objects[f"releases/{CATALOGUE}/{RELEASE}/items.json"])
    response = search(service, k=60, category="stone", finish=["polished"])
    by_id = {item["itemId"]: item for item in items}
    assert response["results"] and all(by_id[r["itemId"]]["category"] == "stone" and by_id[r["itemId"]]["finish"] == "polished"
                                       for r in response["results"])
    assert search(service, category="no-such-category")["results"] == []


@pytest.mark.parametrize("kwargs", [dict(k=0), dict(k=61), dict(k=True), dict(k="5"), dict(k=2.5), dict(mode="sepia"), dict(profile="turbo"),
                                    dict(catalogue="../etc"), dict(release="rel-x"), dict(category="a;b"), dict(finish=["ok", 3]),
                                    dict(category=",".join(f"c{i}" for i in range(30)))])
def test_parameter_validation(tmp_path, kwargs):
    service, _ = make_service(tmp_path)
    with pytest.raises(BadRequestError) as caught:
        search(service, **kwargs)
    assert caught.value.status == 400 and caught.value.reason == "bad-request"


@pytest.mark.parametrize("text", ["", "   ", "x" * 301, "tab\x00inside", 5, None])
def test_text_validation(tmp_path, text):
    service, _ = make_service(tmp_path)
    with pytest.raises(BadRequestError):
        asyncio.run(service.search_text(text, catalogue=CATALOGUE, release=RELEASE))


# ------------------------------------------------------------------------------------------------------------------------
# decoding
# ------------------------------------------------------------------------------------------------------------------------
def png_bytes(size):
    return encode_rgb(np.zeros((*size, 3), np.uint8), "png")


@pytest.mark.parametrize("data", [b"", b"not an image at all", b"GIF89a" + bytes(40), photo_bytes()[:200], png_bytes((8, 8)), b"\x89PNG\r\n\x1a\n" + bytes(50)])
def test_bad_images(tmp_path, data):
    service, _ = make_service(tmp_path)
    with pytest.raises(BadImageError) as caught:
        search(service, data)
    assert (caught.value.status, caught.value.reason) == (400, "bad-image")


def test_unsupported_image_formats_are_refused_even_though_pillow_reads_them(tmp_path):
    import io
    from PIL import Image
    buffer = io.BytesIO()
    Image.new("RGB", (64, 64), (10, 20, 30)).save(buffer, format="BMP")
    with pytest.raises(BadImageError):
        decode_query_image(buffer.getvalue())
    buffer = io.BytesIO()
    Image.new("RGB", (64, 64), (10, 20, 30)).save(buffer, format="WEBP")
    assert decode_query_image(buffer.getvalue()).shape == (64, 64, 3)
    assert decode_query_image(png_bytes((64, 64))).shape == (64, 64, 3)


def test_pixel_cap_stops_decompression_bombs(tmp_path):
    with pytest.raises(BadImageError, match="pixels"):
        decode_query_image(png_bytes((100, 100)), max_pixels=9_999)
    assert decode_query_image(png_bytes((100, 100)), max_pixels=10_000).shape == (100, 100, 3)
    service, _ = make_service(tmp_path, max_pixels=5_000)
    with pytest.raises(BadImageError):
        search(service, png_bytes((100, 100)))


def test_exif_orientation_is_applied(tmp_path):
    import io
    from PIL import Image
    image = Image.fromarray(np.zeros((40, 80, 3), np.uint8))
    exif = Image.Exif()
    exif[0x0112] = 6                                          # rotate 90 degrees clockwise to display
    buffer = io.BytesIO()
    image.save(buffer, format="JPEG", exif=exif)
    assert decode_query_image(buffer.getvalue()).shape[:2] == (80, 40)


# ------------------------------------------------------------------------------------------------------------------------
# releases
# ------------------------------------------------------------------------------------------------------------------------
def test_unknown_release_is_release_missing(tmp_path):
    service, _ = make_service(tmp_path)
    with pytest.raises(ReleaseMissingError) as caught:
        search(service, release="rel-20200101000000-aaaaaa")
    assert (caught.value.status, caught.value.reason) == (409, "release-missing")
    with pytest.raises(ReleaseMissingError):
        asyncio.run(service.search_text("x", catalogue="other-catalogue", release=RELEASE))


def test_corrupt_and_mismatched_releases_are_409(tmp_path):
    service, store = make_service(tmp_path)
    key = f"releases/{CATALOGUE}/{RELEASE}/pillars/dino.npy"
    store.objects[key] = store.objects[key][:-2] + b"zz"
    with pytest.raises(ReleaseCorruptError):
        search(service)
    other = MemoryStore()
    random_release(other, 5, dims=DIMS, feature_versions=dict(compute_feature_versions(PipelineConfig()), dino="facebook/dinov2-large|224|v0"))
    service, _ = make_service(tmp_path / "b", store=other)
    with pytest.raises(FeatureVersionMismatchError) as caught:
        search(service)
    assert caught.value.reason == "feature-version-mismatch"
    assert service.counters["error:feature-version-mismatch"] == 1


def test_release_loaded_once_single_flight_and_last_two_kept(tmp_path):
    store = MemoryStore()
    for release in (RELEASE, SECOND_RELEASE, "rel-20261103120000-0a0a0a"):
        random_release(store, 6, dims=DIMS, release=release)
    calls, gate = [], threading.Event()

    from terucon_catalogue.release_reader import load_release as real

    def slow_loader(*args, **kwargs):
        calls.append(args[2])
        gate.wait(5)
        return real(*args, **kwargs)

    service, _ = make_service(tmp_path, store=store, release_loader=slow_loader)

    async def scenario():
        tasks = [asyncio.create_task(service.search_photo(photo_bytes(i), catalogue=CATALOGUE, release=RELEASE)) for i in range(6)]
        await asyncio.sleep(0.3)
        gate.set()
        return await asyncio.gather(*tasks)

    responses = asyncio.run(scenario())
    assert len(responses) == 6 and calls == [RELEASE] and service.counters["releaseLoads"] == 1       # six requests, one load
    search(service, release=SECOND_RELEASE)
    search(service, release="rel-20261103120000-0a0a0a")
    loaded = [entry["release"] for entry in service.healthz()["loadedReleases"]]
    assert loaded == [SECOND_RELEASE, "rel-20261103120000-0a0a0a"]                                  # the oldest was evicted
    search(service)                                                                                   # reloading it from the disk cache works
    assert service.counters["releaseLoads"] == 4


def test_a_failed_load_is_not_cached(tmp_path):
    service, store = make_service(tmp_path)
    saved = dict(store.objects)
    store.objects.clear()
    with pytest.raises(ReleaseMissingError):
        search(service)
    store.objects.update(saved)
    assert search(service)["ok"] is True


# ------------------------------------------------------------------------------------------------------------------------
# the GPU gate
# ------------------------------------------------------------------------------------------------------------------------
def test_second_request_gets_busy_when_the_gpu_slot_stays_taken(tmp_path):
    block, entered = threading.Event(), threading.Event()
    bank = FakeEncoderBank(block=block, entered=entered)
    service, _ = make_service(tmp_path, encoders=bank, queue_timeout_s=0.3)

    async def scenario():
        first = asyncio.create_task(service.search_photo(photo_bytes(1), catalogue=CATALOGUE, release=RELEASE))
        assert await asyncio.to_thread(entered.wait, 10)
        with pytest.raises(BusyError) as caught:
            await service.search_photo(photo_bytes(2), catalogue=CATALOGUE, release=RELEASE)
        assert (caught.value.status, caught.value.reason) == (503, "busy") and caught.value.retry_after and caught.value.retry_after > 0
        assert service.gate.active == 1 and service.gate.waiting == 0
        block.set()
        return await first

    assert asyncio.run(scenario())["ok"] is True
    assert service.counters["error:busy"] == 1 and service.gate.active == 0


def test_gpu_sections_never_overlap_but_requests_all_finish(tmp_path):
    state = {"now": 0, "peak": 0}
    lock = threading.Lock()

    class Counting(FakeEncoderBank):
        def encode_rgb_images(self, rgb_images, tta_hflip=False):
            with lock:
                state["now"] += 1
                state["peak"] = max(state["peak"], state["now"])
            time.sleep(0.05)
            try:
                return super().encode_rgb_images(rgb_images, tta_hflip)
            finally:
                with lock:
                    state["now"] -= 1

    service, _ = make_service(tmp_path, encoders=Counting())

    async def scenario():
        return await asyncio.gather(*[service.search_photo(photo_bytes(i), catalogue=CATALOGUE, release=RELEASE) for i in range(6)])

    assert len(asyncio.run(scenario())) == 6 and state["peak"] == 1


def test_cuda_out_of_memory_is_a_503_not_a_500(tmp_path):
    service, _ = make_service(tmp_path, encoders=FakeEncoderBank(fail=RuntimeError("CUDA out of memory. Tried to allocate 2.00 GiB")))
    with pytest.raises(BusyError):
        search(service)
    service, _ = make_service(tmp_path / "x", encoders=FakeEncoderBank(fail=ValueError("boom")))
    with pytest.raises(ServiceError) as caught:
        search(service)
    assert (caught.value.status, caught.value.reason) == (500, "internal") and "boom" not in str(caught.value)


# ------------------------------------------------------------------------------------------------------------------------
# privacy: a query photo is never logged and never written down
# ------------------------------------------------------------------------------------------------------------------------
def test_no_photo_bytes_in_any_log_record_or_on_disk(tmp_path, caplog):
    caplog.set_level(logging.DEBUG)
    logging.getLogger("catalogue").setLevel(logging.DEBUG)
    service, _ = make_service(tmp_path, manager=FakeManager(fail=("multimodal_embed",)))
    data = photo_bytes(7, size=(180, 240))
    search(service, data, profile="full")
    with pytest.raises(BadImageError):
        search(service, data[:300])                  # a truncated photo: the error path must not echo it either
    with pytest.raises(BadImageError):
        search(service, b"\xff\xd8\xff" + bytes(range(256)) * 3)
    slices = [data[offset:offset + 24] for offset in (40, 400, 900, len(data) - 60)]
    needles = []
    for piece in slices:
        needles += [repr(piece), piece.hex(), base64.b64encode(piece).decode(), repr(piece[:8])[2:-1]]
    text = "\n".join(f"{record.getMessage()} | {record.args!r} | {record.exc_text or ''}" for record in caplog.records)
    assert caplog.records, "the service logged nothing at all"
    for needle in needles:
        assert needle not in text
    assert "\\xff\\xd8" not in text and "b'" not in text
    for path in tmp_path.rglob("*"):                 # nothing but the release cache was written
        if path.is_file():
            assert not any(piece in path.read_bytes() for piece in slices), path
            assert path.suffix in (".json", ".npy"), path


# ------------------------------------------------------------------------------------------------------------------------
# healthz and warm
# ------------------------------------------------------------------------------------------------------------------------
def test_healthz_shape(tmp_path):
    service, _ = make_service(tmp_path)
    health = service.healthz()
    assert list(health) == ["ok", "ready", "device", "loadedReleases", "expectedFeatureVersions", "containerAgeS"]
    assert (health["ok"], health["ready"], health["device"], health["loadedReleases"]) == (True, True, "fake-gpu", [])
    assert health["expectedFeatureVersions"] == compute_feature_versions(PipelineConfig()) and health["containerAgeS"] >= 0
    search(service)
    assert service.healthz()["loadedReleases"] == [{"catalogue": CATALOGUE, "release": RELEASE, "nItems": 12}]
    assert make_service(tmp_path / "n", encoders=False)[0].healthz()["ready"] is False
    json.dumps(health)


def test_warm_runs_every_local_model_once_and_can_preload_releases(tmp_path):
    service, _ = make_service(tmp_path)
    report = service.warm([(CATALOGUE, RELEASE), (CATALOGUE, "rel-20200101000000-aaaaaa")])
    assert report["ok"] and report["loaded"] == [f"{CATALOGUE}/{RELEASE}"] and report["failed"][0]["reason"] == "release-missing"
    assert len(service.encoders.image_calls) == 1 and service.encoders.text_calls == [["warm up"]] and service.manager.calls == []
    assert service.healthz()["loadedReleases"]


def test_counters(tmp_path):
    service, _ = make_service(tmp_path)
    search(service)
    asyncio.run(service.search_text("a", catalogue=CATALOGUE, release=RELEASE))
    with pytest.raises(BadImageError):
        search(service, b"junk")
    assert (service.counters["requests"], service.counters["photoSearches"], service.counters["textSearches"],
            service.counters["error:bad-image"]) == (3, 2, 1, 1)
