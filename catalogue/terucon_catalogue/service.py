"""The search service: the one object both the HTTP app (http_app.py) and the tests drive.

It holds the encoder bank, the optional Vertex manager / Gemini synthesizer, a small cache of loaded releases and a one-slot GPU gate, and it
answers `search_photo` / `search_text` with exactly the JSON-able dict ARCHITECTURE.md section 6 specifies for a 200 response. Everything heavy is
injected (duck-typed), so importing this module needs neither torch nor google.*:

  encoders      the compute side's EncoderBank: .encode_rgb_images(list_of_rgb, tta_hflip=bool) -> (dino_vectors, siglip_vectors),
                .encode_siglip_text(list_of_str), optionally .device
  manager       VertexGenAIManager (async embed_text / multimodal_embed, .disabled_features), or None
  synthesizer   GeminiMaterialSynthesizer (async describe_image), or None
  store         the ObjectStore the releases are read from
  cache_dir     where releases are cached on disk (Modal: the Volume mounted at /cache)

What it promises:
  * releases are loaded on first use, verified (release_reader.load_release), the last two are kept, and a release being loaded is loaded once
    however many requests arrive (single flight);
  * the neural forward passes run one at a time (GPU gate, 1 slot); a request that waits more than 45 s for the slot gets BusyError (503 + retry_after);
  * a query photo is decoded in memory, never written to disk and never logged; only counts, ids and timings are logged;
  * it never talks to MongoDB.

Typed errors all derive from release_reader.ServiceError (`.status`, `.reason`, `.retry_after`).
"""
from __future__ import annotations

import asyncio
import collections
import concurrent.futures
import contextlib
import io
import logging
import re
import threading
import time
import warnings
from typing import Any, Callable, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

import numpy as np
from PIL import Image

from .config import DEFAULT_SEARCH_PROFILE, SEARCH_PROFILES, compute_feature_versions
from .release_reader import (BadRequestError, LoadedRelease, ServiceError, is_catalogue_id, is_release_id, load_release)
from .search import (MAX_TOP_K, MODES, HybridRetriever, QueryEncoder, QueryPhotoPreprocessor, RegionSpec, photo_plan)

LOGGER = logging.getLogger("catalogue.service")

MAX_TEXT_CHARS = 300
MAX_PIXELS = 80_000_000          # decompression-bomb guard on the decoded query photo (the same number the user's modalBlueprint.py uses)
MIN_IMAGE_SIDE = 16
ALLOWED_IMAGE_FORMATS = ("JPEG", "PNG", "WEBP", "MPO")   # MPO: what some phones call a JPEG with extra images; Pillow opens it as a JPEG
_FILTER_VALUE_RE = re.compile(r"[A-Za-z0-9 _./+-]{1,40}")
_MAX_FILTER_VALUES = 20


# ------------------------------------------------------------------------------------------------------------------------
# errors
# ------------------------------------------------------------------------------------------------------------------------
class BadImageError(ServiceError):
    status = 400
    reason = "bad-image"


class BusyError(ServiceError):
    """The GPU queue is full: try again shortly."""
    status = 503
    reason = "busy"

    def __init__(self, message: str = "The search service is busy; retry shortly.", *, retry_after: float = 2.0, **kwargs):
        super().__init__(message, retry_after=retry_after, **kwargs)


class UnavailableError(ServiceError):
    """The service cannot answer right now (no encoder, no usable signal because an upstream is down, CUDA out of memory)."""
    status = 503
    reason = "unavailable"

    def __init__(self, message: str = "The search service is unavailable; retry shortly.", *, retry_after: float = 5.0, **kwargs):
        super().__init__(message, retry_after=retry_after, **kwargs)


class RateLimitedError(ServiceError):
    """An upstream (Vertex AI) refused for quota reasons and nothing else could answer."""
    status = 429
    reason = "rate-limited"

    def __init__(self, message: str = "Too many requests; retry shortly.", *, retry_after: float = 5.0, **kwargs):
        super().__init__(message, retry_after=retry_after, **kwargs)


# ------------------------------------------------------------------------------------------------------------------------
# the GPU gate (the blueprint's GpuGate: one slot, a queue timeout, a back-pressure error)
# ------------------------------------------------------------------------------------------------------------------------
class GpuGate:
    """Serialises the GPU critical section inside one container. `async with gate.slot():` waits at most `timeout` seconds."""

    def __init__(self, slots: int = 1, timeout: float = 45.0, retry_after: float = 2.0):
        self.slots = slots
        self.timeout = timeout
        self.retry_after = retry_after
        self.waiting = 0
        self.active = 0
        self._semaphore: Optional[asyncio.Semaphore] = None
        self._loop: Optional[asyncio.AbstractEventLoop] = None

    def _get_semaphore(self) -> asyncio.Semaphore:
        loop = asyncio.get_running_loop()
        if self._semaphore is None or self._loop is not loop:     # one loop per process in production; tests may run one loop after another
            self._semaphore = asyncio.Semaphore(self.slots)
            self._loop = loop
        return self._semaphore

    @contextlib.asynccontextmanager
    async def slot(self):
        semaphore = self._get_semaphore()
        self.waiting += 1
        try:
            await asyncio.wait_for(semaphore.acquire(), self.timeout)
        except asyncio.TimeoutError:
            raise BusyError("The GPU queue wait exceeded the limit; retry shortly.", retry_after=self.retry_after) from None
        finally:
            self.waiting -= 1
        self.active += 1
        try:
            yield
        finally:
            self.active -= 1
            semaphore.release()


# ------------------------------------------------------------------------------------------------------------------------
# request validation
# ------------------------------------------------------------------------------------------------------------------------
def normalise_filter(value: Any, name: str) -> Optional[List[str]]:
    """None | "a,b" | ["a", "b"] -> a de-duplicated list of strings, or None when nothing was asked for."""
    if value is None:
        return None
    if isinstance(value, str):
        parts = value.split(",")
    elif isinstance(value, (list, tuple)):
        parts = list(value)
    else:
        raise BadRequestError(f"{name} must be a comma-separated string or a list of strings.")
    cleaned: List[str] = []
    for part in parts:
        if not isinstance(part, str):
            raise BadRequestError(f"{name} must contain strings only.")
        part = part.strip()
        if not part:
            continue
        if _FILTER_VALUE_RE.fullmatch(part) is None:
            raise BadRequestError(f"{name} contains a value that is not allowed.")
        if part not in cleaned:
            cleaned.append(part)
    if len(cleaned) > _MAX_FILTER_VALUES:
        raise BadRequestError(f"{name} accepts at most {_MAX_FILTER_VALUES} values.")
    return cleaned or None


def normalise_k(value: Any, default: int) -> int:
    if value is None:
        return default
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= MAX_TOP_K:
        raise BadRequestError(f"k must be a whole number from 1 to {MAX_TOP_K}.")
    return value


def normalise_region(region: Any) -> Optional[RegionSpec]:
    if region is None or isinstance(region, RegionSpec):
        return region
    if isinstance(region, Mapping):
        return RegionSpec.from_params(region.get("point"), region.get("radius"), region.get("box"))
    raise BadRequestError("region is not valid.")


def normalise_text(text: Any) -> str:
    if not isinstance(text, str):
        raise BadRequestError("text must be a string.")
    cleaned = " ".join(text.split())
    if not cleaned:
        raise BadRequestError("text must not be empty.")
    if len(cleaned) > MAX_TEXT_CHARS:
        raise BadRequestError(f"text must be at most {MAX_TEXT_CHARS} characters.")
    if any(ord(character) < 32 for character in cleaned):
        raise BadRequestError("text must not contain control characters.")
    return cleaned


def decode_query_image(data: Any, max_pixels: int = MAX_PIXELS) -> np.ndarray:
    """Photo bytes -> contiguous uint8 RGB array (EXIF orientation applied by util.load_rgb). Raises BadImageError for anything that is not a
    readable JPEG / PNG / WebP of a sane size. Nothing is written anywhere."""
    from .util import load_rgb
    if not isinstance(data, (bytes, bytearray)) or not data:
        raise BadImageError("The photo is empty.")
    data = bytes(data)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        try:
            with Image.open(io.BytesIO(data), formats=list(ALLOWED_IMAGE_FORMATS)) as probe:
                width, height = probe.size
        except Exception as exc:                                  # unknown format, bomb error, truncated header: all the same answer
            raise BadImageError("The photo could not be read as a JPEG, PNG or WebP image.") from exc
        if width * height > max_pixels:
            raise BadImageError(f"The photo has more than {max_pixels} pixels.")
        if min(width, height) < MIN_IMAGE_SIDE:
            raise BadImageError(f"The photo is smaller than {MIN_IMAGE_SIDE} pixels on a side.")
        try:
            return load_rgb(data)
        except Exception as exc:
            raise BadImageError("The photo is corrupt or truncated.") from exc


def _is_cuda_oom(exc: BaseException) -> bool:
    return type(exc).__name__ == "OutOfMemoryError" or "CUDA out of memory" in str(exc)


# ------------------------------------------------------------------------------------------------------------------------
# the service
# ------------------------------------------------------------------------------------------------------------------------
class SearchService:
    def __init__(self, cfg, *, store, cache_dir, encoders=None, manager=None, synthesizer=None, color_fn: Optional[Callable] = None,
                 commit_cache: Optional[Callable[[], Any]] = None, reload_cache: Optional[Callable[[], Any]] = None,
                 default_profile: str = DEFAULT_SEARCH_PROFILE, max_loaded_releases: int = 2, gpu_slots: int = 1,
                 queue_timeout_s: float = 45.0, max_pixels: int = MAX_PIXELS,
                 release_loader: Callable[..., LoadedRelease] = load_release):
        if default_profile not in SEARCH_PROFILES:
            raise ValueError(f"default_profile must be one of {', '.join(SEARCH_PROFILES)}")
        self.cfg = cfg
        self.store = store
        self.cache_dir = cache_dir
        self.encoders = encoders
        self.manager = manager
        self.synthesizer = synthesizer
        self.commit_cache = commit_cache
        self.reload_cache = reload_cache
        self.default_profile = default_profile
        self.max_loaded_releases = max(1, int(max_loaded_releases))
        self.max_pixels = max_pixels
        self.release_loader = release_loader
        self.expected_versions: Dict[str, str] = compute_feature_versions(cfg)
        self.gate = GpuGate(slots=gpu_slots, timeout=queue_timeout_s)
        self.query_encoder = QueryEncoder(cfg, encoders, manager, synthesizer, gpu_gate=self.gate, color_fn=color_fn)
        self.preprocessor = QueryPhotoPreprocessor(cfg)
        self.counters: Dict[str, int] = collections.defaultdict(int)
        self._lock = threading.Lock()
        self._releases: "collections.OrderedDict[Tuple[str, str], Tuple[LoadedRelease, HybridRetriever]]" = collections.OrderedDict()
        self._inflight: Dict[Tuple[str, str], concurrent.futures.Future] = {}
        self._loader_pool: Optional[concurrent.futures.ThreadPoolExecutor] = None
        self._started = time.monotonic()

    # ---- bookkeeping
    def _count(self, name: str, amount: int = 1) -> None:
        with self._lock:
            self.counters[name] += amount

    def close(self) -> None:
        with self._lock:
            pool, self._loader_pool = self._loader_pool, None
        if pool is not None:
            pool.shutdown(wait=False)

    # ---- releases: LRU of loaded releases, single flight per release
    def _load_blocking(self, key: Tuple[str, str]) -> Tuple[LoadedRelease, HybridRetriever]:
        catalogue, release = key
        try:
            loaded = self.release_loader(self.store, catalogue, release, self.cache_dir, self.expected_versions, self.cfg,
                                         commit_cache=self.commit_cache, reload_cache=self.reload_cache)
            entry = (loaded, HybridRetriever(self.cfg, loaded, self.query_encoder))
            with self._lock:
                self._releases[key] = entry
                self._releases.move_to_end(key)
                while len(self._releases) > self.max_loaded_releases:
                    evicted, _ = self._releases.popitem(last=False)
                    LOGGER.info("release %s/%s evicted from memory", *evicted)
                self.counters["releaseLoads"] += 1
            for warning in loaded.warnings:
                LOGGER.info("release %s/%s: %s", catalogue, release, warning)
            return entry
        finally:
            with self._lock:
                self._inflight.pop(key, None)

    def _ensure_load(self, key: Tuple[str, str]) -> Tuple[Optional[Tuple[LoadedRelease, HybridRetriever]], Optional[concurrent.futures.Future]]:
        with self._lock:
            entry = self._releases.get(key)
            if entry is not None:
                self._releases.move_to_end(key)
                return entry, None
            future = self._inflight.get(key)
            if future is None:
                if self._loader_pool is None:
                    self._loader_pool = concurrent.futures.ThreadPoolExecutor(max_workers=1, thread_name_prefix="release-loader")
                future = self._loader_pool.submit(self._load_blocking, key)
                self._inflight[key] = future
            return None, future

    async def _release(self, catalogue: str, release: str) -> Tuple[LoadedRelease, HybridRetriever]:
        entry, future = self._ensure_load((catalogue, release))
        if entry is not None:
            return entry
        return await asyncio.shield(asyncio.wrap_future(future))

    def release_sync(self, catalogue: str, release: str) -> LoadedRelease:
        """Blocking variant (warm-up, scripts): the same cache and the same single flight."""
        if not is_catalogue_id(catalogue) or not is_release_id(release):
            raise BadRequestError("catalogue / release are not valid ids.")
        entry, future = self._ensure_load((catalogue, release))
        if entry is None:
            entry = future.result()
        return entry[0]

    # ---- request validation shared by photo and text
    def _check_ids(self, catalogue: Any, release: Any) -> None:
        if not is_catalogue_id(catalogue):
            raise BadRequestError("catalogue is not a valid catalogue id.")
        if not is_release_id(release):
            raise BadRequestError("release is not a valid release id.")

    @staticmethod
    def _filters(category: Any, finish: Any) -> Dict[str, List[str]]:
        filters: Dict[str, List[str]] = {}
        categories = normalise_filter(category, "category")
        finishes = normalise_filter(finish, "finish")
        if categories:
            filters["category"] = categories
        if finishes:
            filters["finish"] = finishes
        return filters

    def _wrap_failure(self, exc: BaseException) -> ServiceError:
        if _is_cuda_oom(exc):
            LOGGER.error("CUDA out of memory while answering a search")
            try:
                import torch  # only if it is already there: this module never needs it
                torch.cuda.empty_cache()
            except Exception:
                pass
            return BusyError("The GPU is out of memory; retry shortly.", retry_after=2.0)
        return ServiceError("The search failed.", status=500, reason="internal")

    # ---- photo
    async def search_photo(self, image_bytes: bytes, *, catalogue: str, release: str, mode: str = "look", profile: Optional[str] = None,
                           k: Optional[int] = None, region: Any = None, category: Any = None, finish: Any = None) -> dict:
        started = time.perf_counter()
        self._count("requests")
        self._count("photoSearches")
        try:
            self._check_ids(catalogue, release)
            if mode not in MODES:
                raise BadRequestError(f"mode must be one of {', '.join(MODES)}.")
            profile = profile or self.default_profile
            if profile not in SEARCH_PROFILES:
                raise BadRequestError(f"profile must be one of {', '.join(SEARCH_PROFILES)}.")
            top_k = normalise_k(k, self.cfg.top_k)
            region_spec = normalise_region(region)
            filters = self._filters(category, finish)
            plan = photo_plan(mode, profile)

            prepare_started = time.perf_counter()
            rgb = await asyncio.to_thread(decode_query_image, image_bytes, self.max_pixels)
            decode_ms = (time.perf_counter() - prepare_started) * 1000.0
            _, retriever = await self._release(catalogue, release)
            preprocess_started = time.perf_counter()
            if region_spec is not None:
                prepared = await asyncio.to_thread(self.preprocessor.prepare_region, rgb, region_spec)
            else:
                prepared = await asyncio.to_thread(self.preprocessor.prepare, rgb)
            prepare_ms = decode_ms + (time.perf_counter() - preprocess_started) * 1000.0
            del rgb

            result = await retriever.search(photo=prepared, top_k=top_k, weights=plan.weights, filters=filters or None,
                                            describe_photo=plan.describe, use_vertex_mm=plan.use_vertex_mm, neural=plan.neural)
            response = self._response(catalogue, release, mode, profile, result, started, prepare_ms)
        except ServiceError as exc:
            self._count(f"error:{exc.reason}")
            raise
        except Exception as exc:
            self._count("error:internal")
            LOGGER.exception("photo search failed (%s)", type(exc).__name__)
            raise self._wrap_failure(exc) from exc
        self._log_done("photo", catalogue, release, mode, profile, response)
        return response

    # ---- text
    async def search_text(self, text: str, *, catalogue: str, release: str, k: Optional[int] = None, category: Any = None,
                          finish: Any = None) -> dict:
        started = time.perf_counter()
        self._count("requests")
        self._count("textSearches")
        try:
            self._check_ids(catalogue, release)
            text = normalise_text(text)
            top_k = normalise_k(k, self.cfg.top_k)
            filters = self._filters(category, finish)
            _, retriever = await self._release(catalogue, release)
            result = await retriever.search(text=text, top_k=top_k, filters=filters or None, use_vertex_mm=True)
            response = self._response(catalogue, release, "text", None, result, started, 0.0)
        except ServiceError as exc:
            self._count(f"error:{exc.reason}")
            raise
        except Exception as exc:
            self._count("error:internal")
            LOGGER.exception("text search failed (%s)", type(exc).__name__)
            raise self._wrap_failure(exc) from exc
        self._log_done("text", catalogue, release, "text", None, response, text_chars=len(text))
        return response

    # ---- response
    @staticmethod
    def _dedupe(messages: Iterable[str]) -> List[str]:
        seen, ordered = set(), []
        for message in messages:
            if message not in seen:
                seen.add(message)
                ordered.append(message)
        return ordered

    def _response(self, catalogue, release, mode, profile, result, started, prepare_ms) -> dict:
        info = result.query_info
        stage = info.get("timings") or {}
        timings = {"prepare": round(prepare_ms + float(stage.get("prepare", 0.0)), 1), "encode": round(float(stage.get("encode", 0.0)), 1),
                   "vertex": round(float(stage.get("vertex", 0.0)), 1), "describe": round(float(stage.get("describe", 0.0)), 1),
                   "fuse": round(float(stage.get("fuse", 0.0)), 1), "total": round((time.perf_counter() - started) * 1000.0, 1)}
        return {
            "ok": True, "catalogue": catalogue, "release": release, "mode": mode, "profile": profile,
            "query": {
                "preprocessing": info.get("preprocessing"),
                "dominantHex": list(info.get("dominant_hex") or []),
                "signals": list(result.signal_weights),
                "weights": {name: round(float(weight), 6) for name, weight in result.signal_weights.items()},
                "timingsMs": timings,
                "warnings": self._dedupe(info.get("warnings") or []),
            },
            "results": result.results,
        }

    def _log_done(self, kind, catalogue, release, mode, profile, response, text_chars=None) -> None:
        query = response["query"]
        LOGGER.info("%s search ok: catalogue=%s release=%s mode=%s profile=%s results=%d signals=%s warnings=%d total_ms=%s%s",
                    kind, catalogue, release, mode, profile, len(response["results"]), ",".join(query["signals"]), len(query["warnings"]),
                    query["timingsMs"]["total"], f" text_chars={text_chars}" if text_chars is not None else "")

    # ---- health and warm-up
    def healthz(self) -> dict:
        with self._lock:
            loaded = [{"catalogue": key[0], "release": key[1], "nItems": entry[0].n_items} for key, entry in self._releases.items()]
        device = getattr(self.encoders, "device", None)
        return {
            "ok": True,
            "ready": self.encoders is not None,
            "device": str(device) if device is not None else "none",
            "loadedReleases": loaded,
            "expectedFeatureVersions": dict(self.expected_versions),
            "containerAgeS": round(time.monotonic() - self._started, 1),
        }

    def warm(self, releases: Iterable[Tuple[str, str]] = ()) -> dict:
        """Blocking warm-up for the container's start: one tiny pass through every local model so the first real request does not pay for lazy
        initialisation (CUDA kernels, cuDNN, OpenCV), and optionally the loading of the given (catalogue, release) pairs. Touches no Vertex /
        Gemini client: those belong to the server's event loop."""
        started = time.perf_counter()
        report: Dict[str, Any] = {"ok": True}
        y, x = np.mgrid[0:448, 0:448]
        rgb = np.stack([x * 255 // 448, y * 255 // 448, (x + y) * 255 // 896], axis=-1).astype(np.uint8)
        if self.encoders is not None:
            t = time.perf_counter()
            self.encoders.encode_rgb_images([rgb], tta_hflip=self.cfg.query_tta_hflip)
            self.encoders.encode_siglip_text(["warm up"])
            report["neuralMs"] = round((time.perf_counter() - t) * 1000.0, 1)
        t = time.perf_counter()
        self.query_encoder.color_fn(rgb)
        report["colourMs"] = round((time.perf_counter() - t) * 1000.0, 1)
        loaded, failed = [], []
        for catalogue, release in releases:
            try:
                self.release_sync(catalogue, release)
                loaded.append(f"{catalogue}/{release}")
            except ServiceError as exc:
                failed.append({"release": f"{catalogue}/{release}", "reason": exc.reason})
        report["loaded"] = loaded
        if failed:
            report["failed"] = failed
        report["ms"] = round((time.perf_counter() - started) * 1000.0, 1)
        return report
