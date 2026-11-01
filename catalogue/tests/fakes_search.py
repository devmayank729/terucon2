"""Fakes for the search side (PY-B): an in-memory object store, a release writer that follows ARCHITECTURE.md 4.2/4.3 exactly, fake encoders /
Vertex manager / Gemini synthesizer, and a fake jobs database. Nothing here touches the network, a GPU or a real service."""
from __future__ import annotations

import hashlib
import io
import json
import threading
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Dict, List, Optional

import numpy as np

from terucon_catalogue.config import PipelineConfig, compute_feature_versions

CATALOGUE = "superbond-colour"
RELEASE = "rel-20261101120000-abc123"
# real vector sizes are 3072/1152/396/1408/768; tests use small ones unless they say otherwise
SMALL_DIMS = {"dino": 24, "siglip": 16, "color": 12, "vertex_mm": 20, "text": 10}
REAL_DIMS = {"dino": 3072, "siglip": 1152, "color": 396, "vertex_mm": 1408, "text": 768}


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class MemoryStore:
    """ObjectStore protocol (ARCHITECTURE.md 9) over a dict. `reads` records every get_bytes / get_file key."""

    def __init__(self):
        self.objects: Dict[str, bytes] = {}
        self.reads: List[str] = []
        self.lock = threading.Lock()

    def put_bytes(self, key, data, content_type=None, *, if_absent=False):
        with self.lock:
            if if_absent and key in self.objects:
                return False
            self.objects[key] = bytes(data)
            return True

    def put_file(self, key, path, content_type=None, *, if_absent=False):
        return self.put_bytes(key, Path(path).read_bytes(), content_type, if_absent=if_absent)

    def get_bytes(self, key):
        with self.lock:
            self.reads.append(key)
            if key not in self.objects:
                raise FileNotFoundError(key)
            return self.objects[key]

    def get_file(self, key, dest):
        data = self.get_bytes(key)
        dest = Path(dest)
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(data)
        return dest

    def exists(self, key):
        return key in self.objects

    def size(self, key):
        return len(self.objects[key]) if key in self.objects else None

    def delete(self, key):
        self.objects.pop(key, None)

    def list(self, prefix):
        return sorted(k for k in self.objects if k.startswith(prefix))

    def signed_get_url(self, key, *, expires_s=3600):
        return f"memory://{key}"


def unit_rows(rng, n, dim):
    matrix = rng.normal(size=(n, dim)).astype(np.float32)
    return matrix / np.linalg.norm(matrix, axis=1, keepdims=True)


def make_items(n, *, rng=None, product_ids=None, categories=("stone", "metal", "laminate"), finishes=("polished", "matte")):
    """items.json entries, sorted by itemId (the contract)."""
    rng = rng or np.random.default_rng(0)
    items = []
    for index in range(n):
        items.append({
            "itemId": f"{'a' * 12}-p{index + 1:04d}-i00",
            "productId": product_ids[index] if product_ids else None,
            "page": index + 1, "pdfSha256": "a" * 64,
            "category": categories[index % len(categories)] if categories else None,
            "finish": finishes[(index // 2) % len(finishes)] if finishes else None,
            "dominantHex": ["#112233"], "proportions": [1.0],
        })
    return sorted(items, key=lambda item: item["itemId"])


def npy_bytes(array: np.ndarray) -> bytes:
    buffer = io.BytesIO()
    np.save(buffer, array)
    return buffer.getvalue()


def write_release(store, items, pillar_rows, *, catalogue=CATALOGUE, release=RELEASE, cfg=None, feature_versions=None, extra_manifest=None):
    """Write a release in the contract's exact layout and return its manifest.

    pillar_rows: {pillar: (ids, float32 matrix)}; the matrix is stored as float16 exactly as given (callers normalise it first, like publish does).
    """
    cfg = cfg or PipelineConfig()
    all_versions = compute_feature_versions(cfg)
    prefix = f"releases/{catalogue}/{release}/"
    items_bytes = json.dumps(items).encode("utf-8")
    store.put_bytes(prefix + "items.json", items_bytes)
    manifest = {"schema": 1, "releaseId": release, "catalogue": catalogue, "createdAt": 1793000000000, "parent": None, "jobId": None,
                "nItems": len(items), "featureVersions": {}, "pillars": {}, "itemsFile": "items.json", "itemsSha256": sha256(items_bytes),
                "package": {"name": "terucon_catalogue", "version": "0.1.0"}}
    for pillar, (ids, matrix) in pillar_rows.items():
        npy = npy_bytes(np.ascontiguousarray(matrix, dtype=np.float16))
        ids_bytes = json.dumps(list(ids)).encode("utf-8")
        store.put_bytes(prefix + f"pillars/{pillar}.npy", npy)
        store.put_bytes(prefix + f"pillars/{pillar}.ids.json", ids_bytes)
        manifest["pillars"][pillar] = {"count": len(ids), "dim": int(matrix.shape[1]), "dtype": "float16", "file": f"pillars/{pillar}.npy",
                                       "idsFile": f"pillars/{pillar}.ids.json", "sha256": sha256(npy), "idsSha256": sha256(ids_bytes)}
        manifest["featureVersions"][pillar] = (feature_versions or all_versions)[pillar]
    manifest.update(extra_manifest or {})
    store.put_bytes(prefix + "manifest.json", json.dumps(manifest).encode("utf-8"))
    return manifest


def random_release(store, n=12, *, seed=0, dims=None, missing=None, pillars=("dino", "siglip", "color", "vertex_mm", "text"), **kwargs):
    """A release of `n` random items. missing: {pillar: set(of item indexes) that have NO vector in that pillar}."""
    rng = np.random.default_rng(seed)
    dims = dims or SMALL_DIMS
    items = kwargs.pop("items", None) or make_items(n, rng=rng)
    rows = {}
    for pillar in pillars:
        skip = (missing or {}).get(pillar, set())
        ids = [item["itemId"] for index, item in enumerate(items) if index not in skip]
        rows[pillar] = (ids, unit_rows(rng, len(ids), dims[pillar]))
    manifest = write_release(store, items, rows, **kwargs)
    return items, rows, manifest


# ------------------------------------------------------------------------------------------------------------------------
# encoders, Vertex manager, Gemini synthesizer
# ------------------------------------------------------------------------------------------------------------------------
def _vector_from(array: np.ndarray, dim: int, salt: int) -> np.ndarray:
    """A deterministic unit vector that depends on the image content (and a salt), so identical photos give identical signals."""
    seed = int(np.asarray(array, dtype=np.uint8).astype(np.uint64).sum() % (2 ** 31)) + salt
    vector = np.random.default_rng(seed).normal(size=dim).astype(np.float32)
    return vector / np.linalg.norm(vector)


class FakeEncoderBank:
    device = "fake-gpu"

    def __init__(self, dims=None, block: Optional[threading.Event] = None, entered: Optional[threading.Event] = None, fail: Optional[Exception] = None):
        self.dims = dims or SMALL_DIMS
        self.block, self.entered, self.fail = block, entered, fail
        self.image_calls: List[Any] = []
        self.text_calls: List[List[str]] = []
        self.threads: List[str] = []

    def encode_rgb_images(self, rgb_images, tta_hflip=False):
        self.threads.append(threading.current_thread().name)
        if self.entered is not None:
            self.entered.set()
        if self.block is not None:
            assert self.block.wait(10), "the test never released the encoder"
        if self.fail is not None:
            raise self.fail
        self.image_calls.append((len(rgb_images), tta_hflip, [image.shape for image in rgb_images]))
        dino = np.stack([_vector_from(image, self.dims["dino"], 1) for image in rgb_images])
        siglip = np.stack([_vector_from(image, self.dims["siglip"], 2) for image in rgb_images])
        return dino, siglip

    def encode_siglip_text(self, texts):
        self.text_calls.append(list(texts))
        return np.stack([_vector_from(np.frombuffer(text.encode("utf-8"), dtype=np.uint8), self.dims["siglip"], 3) for text in texts])


class FakeManager:
    """VertexGenAIManager stand-in: async embed_text / multimodal_embed. fail: names of calls that raise."""

    def __init__(self, dims=None, fail=(), disabled=()):
        self.dims = dims or SMALL_DIMS
        self.fail = set(fail)
        self.disabled_features = set(disabled)
        self.calls: List[tuple] = []

    async def embed_text(self, text, task_type):
        self.calls.append(("embed_text", task_type, len(text)))
        if "embed_text" in self.fail:
            raise RuntimeError("429 RESOURCE_EXHAUSTED quota")
        return _vector_from(np.frombuffer(text.encode("utf-8"), dtype=np.uint8), self.dims["text"], 4)

    async def multimodal_embed(self, image_bytes=None, text=None):
        self.calls.append(("multimodal_embed", image_bytes is not None, text is not None))
        if "multimodal_embed" in self.fail:
            raise RuntimeError("model unavailable")
        out = {}
        if image_bytes is not None:
            out["image"] = _vector_from(np.frombuffer(image_bytes, dtype=np.uint8), self.dims["vertex_mm"], 5)
        if text is not None:
            out["text"] = _vector_from(np.frombuffer(text.encode("utf-8"), dtype=np.uint8), self.dims["vertex_mm"], 6)
        return out


class FakeSynthesizer:
    def __init__(self, fail=False):
        self.fail = fail
        self.calls = 0

    async def describe_image(self, image_bytes, product_id, color_meta):
        self.calls += 1
        if self.fail:
            raise RuntimeError("safety block")
        from terucon_catalogue.schema import MaterialProfile
        profile = MaterialProfile(material_category="stone", material_subtype="polished marble", surface_finish="polished", secondary_finishes=[],
                                  grain_or_pattern_description="veined", pattern_scale="30 mm", color_palette_description="#202020",
                                  specular_behavior="sharp", micro_surface_feel="smooth", search_keywords=["marble"],
                                  nano_banana_render_prompt="a prompt", confidence=0.9)
        return profile, "fake-gemini"


# ------------------------------------------------------------------------------------------------------------------------
# a jobs database with the MemoryCatalogueDb job methods (get_job / update_job / append_job_log)
# ------------------------------------------------------------------------------------------------------------------------
class FakeJobsDb:
    def __init__(self):
        self.jobs: Dict[str, dict] = {}
        self.history: List[tuple] = []
        self.lock = threading.Lock()
        self.fail_update_with: Optional[Exception] = None

    def add_job(self, job):
        self.jobs[job["_id"]] = job

    def get_job(self, job_id):
        with self.lock:
            job = self.jobs.get(job_id)
            return json.loads(json.dumps(job)) if job is not None else None

    def update_job(self, job_id, fields):
        with self.lock:
            if self.fail_update_with is not None:
                raise self.fail_update_with
            self.jobs[job_id].update(json.loads(json.dumps(fields)))
            self.history.append((job_id, dict(fields)))

    def append_job_log(self, job_id, level, msg):
        with self.lock:
            log = self.jobs[job_id].setdefault("log", [])
            log.append({"t": 0, "level": level, "msg": msg})
            del log[:-200]


def small_cfg(**overrides):
    cfg = PipelineConfig()
    for name, value in overrides.items():
        setattr(cfg, name, value)
    return cfg


def namespace(**kwargs):
    return SimpleNamespace(**kwargs)
