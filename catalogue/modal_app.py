"""
modal_app.py - the Terucon catalogue engine on Modal: a GPU search service, a cheap CPU ingest endpoint and the long GPU ingest job.

Conventions copied from swatchroom/modalBlueprint.py (the owner's own deployed Modal code): app.cls + @modal.enter + @modal.asgi_app(label=...),
@modal.concurrent, an ordered GPU fallback list, weights baked into the image with Image.run_function and loaded with HF_HUB_OFFLINE=1, a bearer-key
secret compared in constant time, one GPU slot per container (GpuGate) answering 503 + Retry-After when the queue is full.
Every decorator argument below was checked against the installed SDK (modal 1.6.3) by tests/test_modal_app.py; nothing here has been deployed.

DEPLOY (run from this folder, `catalogue/`; needs your Modal login and the three secrets)
    modal secret create terucon-catalogue-keys  API_KEYS="$(openssl rand -hex 32),$(openssl rand -hex 32)"   # two keys = rotate one at a time
    modal secret create terucon-catalogue-gcp   GCP_SERVICE_ACCOUNT_JSON="$(cat service-account.json)" CATALOGUE_GCS_BUCKET=<bucket> CATALOGUE_GCS_PREFIX=catalogue/
    modal secret create terucon-catalogue-mongo MONGODB_URI='mongodb+srv://USER:PASSWORD@CLUSTER/?retryWrites=true&w=majority' MONGODB_DB=<the database named in swatchroom/.env>
        # MONGODB_DB MUST be the SAME database the website uses: the website reads the catalogue through the studio's MongoDB connection, i.e. the
        # database in swatchroom/.env MONGODB_URI (its default is "swatchroom"). MONGODB_DB here WINS over a database named inside the URI. If the two differ,
        # an import succeeds and the site never sees the items.
    modal run    modal_app.py::selftest     # one GPU container: loads DINOv2 + SigLIP, encodes a generated image, checks the vector sizes
                                            # (dino 3072, siglip 1152, colour 396) and unit norms, prints PASS or FAIL (a few GPU minutes)
    modal deploy modal_app.py               # prints the two URLs: put them in the website .env as CATALOGUE_MODAL_SEARCH_URL / CATALOGUE_MODAL_INGEST_URL,
                                            # and one of the API_KEYS as CATALOGUE_MODAL_KEY

    CATALOGUE_GPU_TIER=fast       modal deploy modal_app.py   # L40S first, instead of the default "economy" (L4 first)
    CATALOGUE_MIN_CONTAINERS=1    modal deploy modal_app.py   # one search container always warm: no cold start, an idle GPU is billed
    CATALOGUE_REQUIRE_PROXY_AUTH=1 modal deploy modal_app.py  # Modal rejects calls without Modal-Key / Modal-Secret before a GPU container starts
                                                              # (then also send CATALOGUE_MODAL_PROXY_KEY / _SECRET from the website)

SERVICES
    terucon-catalogue-search   (GPU, class Search)   GET /healthz   POST /v1/search   POST /v1/search-text        ARCHITECTURE.md section 6
    terucon-catalogue-ingest   (CPU, class Ingest)   GET /healthz   POST /v1/ingest   POST /v1/ingest/cancel
    ingest_job_fn              (GPU function, max_containers=1)  spawned by POST /v1/ingest; reads the job from MongoDB, fetch -> compute -> publish, then
                               puts the new release on the volume
    import_bundle_fn           (CPU function)  the notebook's output folder, uploaded to the bucket by YOU (nothing is fetched from Kaggle): copies it
                               next to the bucket, publishes it, puts the release on the volume.   modal run modal_app.py::import_bundle --help
    prime_fn                   (CPU function)  copies releases that are already in the bucket onto the volume.   modal run modal_app.py::prime --help
    Volume terucon-catalogue-cache at /cache: a read-through cache of RELEASES (vectors + item list; never the only copy; GCS holds them). It is filled
    by import_bundle_fn, by ingest_job_fn and by prime_fn ahead of time, and by the first search that needs a release it lacks. A search container
    reloads it before looking, so a release put there while the container ran is found. The pictures are NOT on the volume (the browser loads them from
    GCS with signed URLs) and neither are the model weights (they are baked into the image layers, which is already "nothing downloaded at run time").

BRINGING IN YOUR OWN FILES (the notebook's output folder: state.sqlite + crops/), already uploaded by you
    gcloud storage cp -r "<output folder>/*" "gs://<bucket>/<CATALOGUE_GCS_PREFIX, default catalogue/>imports/<catalogue>/<name>/"
    modal run modal_app.py::import_bundle --catalogue <catalogue> --key imports/<catalogue>/<name> --activate [--create "<name people see>"]

MONGODB ATLAS NETWORK ACCESS (not verified from here)
    Atlas only accepts connections from addresses on its Network Access list, and Modal containers do not have fixed outbound addresses. Only the Ingest
    class and ingest_job_fn talk to MongoDB (the search service never does). Either allow 0.0.0.0/0 in Atlas (then the database user's password and TLS are
    the only protection: use a dedicated user limited to the terucon_* collections), or give those two a static outbound IP with a Modal Proxy
    (modal.Proxy; the SDK documents it as "a static outbound IP address ... for example a database"; `proxy=` is accepted by app.function / app.cls)
    and put that one IP on the Atlas list.
"""
import os
import sys

import modal

# =====================================================================================
# 1. CONFIG
# =====================================================================================
APP_NAME = "terucon-catalogue"
KEYS_SECRET = "terucon-catalogue-keys"          # API_KEYS="key1,key2"  (each >= 16 characters)
GCP_SECRET = "terucon-catalogue-gcp"            # GCP_SERVICE_ACCOUNT_JSON, CATALOGUE_GCS_BUCKET, CATALOGUE_GCS_PREFIX
MONGO_SECRET = "terucon-catalogue-mongo"        # MONGODB_URI, MONGODB_DB
CACHE_VOLUME = "terucon-catalogue-cache"
CACHE_DIR = "/cache"
SEARCH_LABEL = "terucon-catalogue-search"
INGEST_LABEL = "terucon-catalogue-ingest"


def _env_int(name: str, default: int) -> int:
    try:
        return max(0, int(os.environ.get(name, default)))
    except ValueError:
        return default


def _env_flag(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in ("1", "true", "yes", "on")


# GPU fallback lists, best first (the blueprint's reasoning: Modal moves to the next entry when it cannot get the current one, and the first
# fallback is at least as fast as the first choice). DINOv2-large + SigLIP so400m in fp16 need about 3 GB, so an L4 (24 GB) is plenty.
GPU_TIERS = {
    "economy": ["L4", "L40S", "A10"],
    "fast": ["L40S", "A100-80GB", "L4"],
}
GPU_TIER = os.environ.get("CATALOGUE_GPU_TIER", "economy")
if GPU_TIER not in GPU_TIERS:
    raise ValueError(f"CATALOGUE_GPU_TIER must be one of {sorted(GPU_TIERS)}, got {GPU_TIER!r}")

MIN_CONTAINERS = _env_int("CATALOGUE_MIN_CONTAINERS", 0)     # 1+ = always warm (no cold start; an idle GPU is billed)
MAX_CONTAINERS = 3                                            # the cost ceiling of the search pool
SCALEDOWN_S = min(1200, max(2, _env_int("CATALOGUE_SCALEDOWN_S", 300)))
REQUIRE_PROXY_AUTH = _env_flag("CATALOGUE_REQUIRE_PROXY_AUTH")
CPU_CORES = 4.0
MEMORY_MIB = 16384
REQUEST_TIMEOUT_S = 300
STARTUP_TIMEOUT_S = 900
INGEST_TIMEOUT_S = max(1, min(24, _env_int("CATALOGUE_INGEST_TIMEOUT_H", 6))) * 3600
MAX_INPUTS, TARGET_INPUTS = 8, 4

TORCH_INDEX = "https://download.pytorch.org/whl/cu128"
HF_HOME = "/models/hf"
MODEL_REPOS = ("facebook/dinov2-large", "google/siglip-so400m-patch14-384")       # the notebook's models (config.PipelineConfig)

# =====================================================================================
# 2. IMAGES (weights baked at build time, nothing downloaded at run time)
# =====================================================================================
app = modal.App(APP_NAME)
keys_secret = modal.Secret.from_name(KEYS_SECRET, required_keys=["API_KEYS"])
gcp_secret = modal.Secret.from_name(GCP_SECRET, required_keys=["GCP_SERVICE_ACCOUNT_JSON", "CATALOGUE_GCS_BUCKET"])
mongo_secret = modal.Secret.from_name(MONGO_SECRET, required_keys=["MONGODB_URI"])
cache_volume = modal.Volume.from_name(CACHE_VOLUME, create_if_missing=True)


def _bake_models():
    """Build time: download both models' weights (safetensors + configs + tokenizer/preprocessor files) into HF_HOME. No torch needed."""
    from huggingface_hub import snapshot_download

    for repo in MODEL_REPOS:
        path = snapshot_download(repo, allow_patterns=["*.json", "*.safetensors", "*.txt", "*.model"])
        files = sorted(name for name in os.listdir(path))
        if not any(name.endswith(".safetensors") for name in files) or "config.json" not in files:
            raise RuntimeError(f"{repo}: the download is missing its weights or config ({files})")
        print(f"[bake] {repo}: {files}")
    # Fail the image BUILD, not the first request, if the SigLIP tokenizer cannot be made (it needs the sentencepiece library and the baked spiece.model).
    from transformers import AutoTokenizer

    tokenizer = AutoTokenizer.from_pretrained(MODEL_REPOS[1])
    if not tokenizer("polished black marble")["input_ids"]:
        raise RuntimeError(f"{MODEL_REPOS[1]}: the tokenizer loaded but produced no tokens")
    print(f"[bake] {MODEL_REPOS[1]}: tokenizer ok")


# CUDA userspace comes with the torch wheel; Modal's hosts provide the driver. Versions are the ones the notebook ran with (ARCHITECTURE.md 1).
_base = (
    modal.Image.debian_slim(python_version="3.12")
    .uv_pip_install("torch==2.11.0", "torchvision==0.26.0", index_url=TORCH_INDEX)
    .uv_pip_install(
        "transformers==5.16.1", "pymupdf==2.0", "opencv-python-headless==4.14.0.94", "google-genai==2.12.1",
        "google-cloud-storage", "pymongo", "fastapi", "numpy", "scipy", "pillow", "pydantic", "tenacity", "google-auth",
        "huggingface_hub", "safetensors", "requests",
        "sentencepiece",     # the SigLIP tokenizer is a sentencepiece model; without it transformers refuses to build it (found 2026-11-01 by running the real EncoderBank)
    )
)

# The terucon_catalogue package is mounted when a container starts (copy=False), so editing it does not rebuild the image; it must be the last step.
search_image = (
    _base
    .env({"HF_HOME": HF_HOME, "TOKENIZERS_PARALLELISM": "false", "OMP_NUM_THREADS": "4"})
    .run_function(_bake_models)
    .env({"HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1"})
    .add_local_python_source("terucon_catalogue")
)

# The ingest web endpoint only validates a job and spawns the GPU function: no torch, no models.
ingest_web_image = (
    modal.Image.debian_slim(python_version="3.12")
    .uv_pip_install("fastapi", "pymongo", "pydantic", "numpy", "pillow", "opencv-python-headless==4.14.0.94")
    .add_local_python_source("terucon_catalogue")
)


# =====================================================================================
# 3. BUILDING THE OBJECTS (everything heavy is imported here, inside the containers)
# =====================================================================================
def _configure_logging():
    import logging
    if not logging.getLogger().handlers:
        logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")


def build_search_service():
    """The SearchService of one search container: both models on the GPU, the Vertex manager (optional), the object store, the release cache."""
    _configure_logging()
    import logging

    from terucon_catalogue.captions import GeminiMaterialSynthesizer
    from terucon_catalogue.config import DEFAULT_SEARCH_PROFILE, SEARCH_PROFILES, load_config
    from terucon_catalogue.credentials import load_service_account_info
    from terucon_catalogue.encoders import EncoderBank
    from terucon_catalogue.objectstore import object_store_from_env
    from terucon_catalogue.service import SearchService
    from terucon_catalogue.vertex import VertexGenAIManager

    log = logging.getLogger("catalogue.modal")
    cfg = load_config()
    store = object_store_from_env()
    encoders = EncoderBank(cfg)
    manager = synthesizer = None
    try:
        manager = VertexGenAIManager(cfg, load_service_account_info())
        synthesizer = GeminiMaterialSynthesizer(cfg, None, manager, None)       # only .describe_image is used at query time
    except Exception as exc:                                                      # photo search with the fast profile does not need it
        log.warning("Vertex AI is not available (%s): text search will use SigLIP only and the balanced / full profiles are limited", type(exc).__name__)
    profile = os.environ.get("CATALOGUE_SEARCH_PROFILE", DEFAULT_SEARCH_PROFILE)
    service = SearchService(cfg, store=store, cache_dir=os.environ.get("CATALOGUE_CACHE_DIR", CACHE_DIR), encoders=encoders, manager=manager,
                            synthesizer=synthesizer, default_profile=profile if profile in SEARCH_PROFILES else DEFAULT_SEARCH_PROFILE,
                            commit_cache=cache_volume.commit, reload_cache=cache_volume.reload)
    service.warm()
    log.info("search service ready on %s", service.healthz()["device"])
    return service


class ModalIngestSpawner:
    """IngestRunner's `spawn`: starts the GPU function and returns the call id."""

    def __call__(self, job_id: str) -> str:
        return ingest_job_fn.spawn(job_id).object_id


# =====================================================================================
# 4. THE SEARCH SERVICE (GPU)
# =====================================================================================
@app.cls(
    image=search_image, gpu=GPU_TIERS[GPU_TIER], secrets=[keys_secret, gcp_secret], volumes={CACHE_DIR: cache_volume},
    cpu=CPU_CORES, memory=MEMORY_MIB, timeout=REQUEST_TIMEOUT_S, startup_timeout=STARTUP_TIMEOUT_S,
    scaledown_window=SCALEDOWN_S, min_containers=MIN_CONTAINERS, max_containers=MAX_CONTAINERS,
)
@modal.concurrent(max_inputs=MAX_INPUTS, target_inputs=TARGET_INPUTS)
class Search:
    @modal.enter()
    def load(self):
        self.service = build_search_service()

    @modal.asgi_app(label=SEARCH_LABEL, requires_proxy_auth=REQUIRE_PROXY_AUTH)
    def api(self):
        from terucon_catalogue.http_app import create_search_app
        # proxy_auth_required stays off: Modal's edge enforces requires_proxy_auth, and whether it forwards the headers has not been verified
        return create_search_app(self.service, os.environ["API_KEYS"], proxy_auth_required=False)

    @modal.exit()
    def close(self):
        self.service.close()


# =====================================================================================
# 5. THE INGEST ENDPOINT (CPU) AND THE INGEST JOB (GPU, one at a time)
# =====================================================================================
@app.cls(
    image=ingest_web_image, secrets=[keys_secret, mongo_secret], cpu=1.0, memory=1024, timeout=60,
    scaledown_window=60, min_containers=0, max_containers=2,
)
@modal.concurrent(max_inputs=10)
class Ingest:
    @modal.enter()
    def connect(self):
        _configure_logging()
        from terucon_catalogue.ingest_job import IngestRunner
        from terucon_catalogue.mongo import MongoCatalogueDb
        self.runner = IngestRunner(MongoCatalogueDb(os.environ["MONGODB_URI"], os.environ.get("MONGODB_DB") or None), ModalIngestSpawner())

    @modal.asgi_app(label=INGEST_LABEL, requires_proxy_auth=REQUIRE_PROXY_AUTH)
    def api(self):
        from terucon_catalogue.http_app import create_ingest_app
        return create_ingest_app(self.runner, os.environ["API_KEYS"], proxy_auth_required=False)


@app.function(
    image=search_image, gpu=GPU_TIERS[GPU_TIER], secrets=[gcp_secret, mongo_secret], volumes={CACHE_DIR: cache_volume},
    cpu=CPU_CORES, memory=MEMORY_MIB, timeout=INGEST_TIMEOUT_S, startup_timeout=STARTUP_TIMEOUT_S, max_containers=1,
)
def ingest_job_fn(job_id: str) -> dict:
    """fetch -> compute -> publish for one job document, then put the new release on the volume. The logic is terucon_catalogue.ingest_job.run_ingest_job and
    bucket_import.seed_after_ingest (both tested with fakes); a failure to seed the volume never changes the job's result."""
    _configure_logging()
    import tempfile
    from pathlib import Path

    from terucon_catalogue.bucket_import import seed_after_ingest
    from terucon_catalogue.config import load_config
    from terucon_catalogue.credentials import load_service_account_info
    from terucon_catalogue.encoders import EncoderBank
    from terucon_catalogue.ingest_job import run_ingest_job
    from terucon_catalogue.mongo import MongoCatalogueDb
    from terucon_catalogue.objectstore import object_store_from_env
    from terucon_catalogue.pipeline import run_compute
    from terucon_catalogue.publish import publish_bundle
    from terucon_catalogue.vertex import VertexGenAIManager

    cfg = load_config()
    db = MongoCatalogueDb(os.environ["MONGODB_URI"], os.environ.get("MONGODB_DB") or None)
    store = object_store_from_env()
    with tempfile.TemporaryDirectory(prefix="ingest-") as work:
        outcome = run_ingest_job(
            job_id, db=db, store=store, cfg=cfg, compute=run_compute, publish=publish_bundle,
            manager_factory=lambda: VertexGenAIManager(cfg, load_service_account_info()),
            encoders_factory=lambda: EncoderBank(cfg), workdir=Path(work))
    seeded = seed_after_ingest(outcome, db=db, store=store, cfg=cfg, cache_dir=CACHE_DIR, commit_cache=cache_volume.commit, reload_cache=cache_volume.reload)
    if seeded is not None:
        outcome["seeded"] = seeded
    return outcome


# =====================================================================================
# 5b. THE OWNER'S OWN FILES: IMPORT A BUNDLE THAT SITS IN THE BUCKET, AND PUT RELEASES ON THE VOLUME (CPU, no GPU, no models)
# =====================================================================================
IMPORT_TIMEOUT_S = max(1, min(6, _env_int("CATALOGUE_IMPORT_TIMEOUT_H", 2))) * 3600


@app.function(
    image=search_image, secrets=[gcp_secret, mongo_secret], volumes={CACHE_DIR: cache_volume},
    cpu=2.0, memory=4096, timeout=IMPORT_TIMEOUT_S, max_containers=1,
)
def import_bundle_fn(catalogue: str, key: str, activate: bool = False, create_name: str = "", include_pdfs: bool = False) -> dict:
    """The notebook's output folder, already uploaded to the bucket under `key` (imports/<catalogue>/<name>): copy it next door, publish it (the same
    publish_bundle every path uses), put the release on the volume. All the logic is terucon_catalogue.bucket_import.run_bucket_import (tested with fakes)."""
    _configure_logging()
    import tempfile
    from pathlib import Path

    from terucon_catalogue.bucket_import import run_bucket_import
    from terucon_catalogue.config import load_config
    from terucon_catalogue.mongo import MongoCatalogueDb
    from terucon_catalogue.objectstore import object_store_from_env

    def show(stage, done, total, message):
        print(f"[{stage}] {message}", flush=True)

    with tempfile.TemporaryDirectory(prefix="import-") as work:
        outcome = run_bucket_import(
            db=MongoCatalogueDb(os.environ["MONGODB_URI"], os.environ.get("MONGODB_DB") or None), store=object_store_from_env(), cfg=load_config(),
            catalogue=catalogue, prefix=key, workdir=Path(work), activate=activate, create_name=create_name or None, include_pdfs=include_pdfs,
            cache_dir=CACHE_DIR, commit_cache=cache_volume.commit, reload_cache=cache_volume.reload, progress=show)
    return outcome.as_dict()


@app.function(
    image=search_image, secrets=[gcp_secret, mongo_secret], volumes={CACHE_DIR: cache_volume},
    cpu=2.0, memory=4096, timeout=1800, max_containers=1,
)
def prime_fn(catalogue: str, release: str = "") -> list:
    """Copy releases that are already in the bucket onto the volume: the live one and the one before it, or just `release`. For after a publish from the
    command line (the volume is only filled by an import or an admin upload through Modal). terucon_catalogue.bucket_import.prime_volume."""
    _configure_logging()
    from terucon_catalogue.bucket_import import prime_volume
    from terucon_catalogue.config import load_config
    from terucon_catalogue.mongo import MongoCatalogueDb
    from terucon_catalogue.objectstore import object_store_from_env

    seeded = prime_volume(db=MongoCatalogueDb(os.environ["MONGODB_URI"], os.environ.get("MONGODB_DB") or None), store=object_store_from_env(), cfg=load_config(),
                          catalogue=catalogue, cache_dir=CACHE_DIR, release=release or None, commit_cache=cache_volume.commit, reload_cache=cache_volume.reload)
    return [item.as_dict() for item in seeded]


# =====================================================================================
# 6. SELF-TEST (the owner runs it once: `modal run modal_app.py::selftest`)
# =====================================================================================
@app.function(image=search_image, gpu=GPU_TIERS[GPU_TIER], cpu=CPU_CORES, memory=MEMORY_MIB, timeout=1800, startup_timeout=STARTUP_TIMEOUT_S)
def selftest_fn() -> dict:
    """On a GPU container: load both models from the baked weights, encode a generated image and a sentence, check sizes and unit norms."""
    import time

    import numpy as np
    import torch

    from terucon_catalogue.config import load_config
    from terucon_catalogue.encoders import EncoderBank
    from terucon_catalogue.features import ColorParams, compute_lab_color_descriptor

    cfg = load_config()
    started = time.perf_counter()
    bank = EncoderBank(cfg)
    load_s = time.perf_counter() - started
    y, x = np.mgrid[0:480, 0:640]
    rgb = np.stack([x * 255 // 640, y * 255 // 480, ((x // 40 + y // 40) % 2) * 200 + 30], axis=-1).astype(np.uint8)
    t = time.perf_counter()
    dino, siglip = bank.encode_rgb_images([rgb], tta_hflip=cfg.query_tta_hflip)
    encode_ms = (time.perf_counter() - t) * 1000.0
    text = bank.encode_siglip_text(["polished black marble"])
    again, _ = bank.encode_rgb_images([rgb], tta_hflip=cfg.query_tta_hflip)
    colour = compute_lab_color_descriptor(rgb, ColorParams.from_config(cfg)).vector
    norm = lambda a: [round(float(n), 5) for n in np.linalg.norm(np.atleast_2d(a), axis=1)]            # noqa: E731
    checks = {
        "dino is 3072 numbers": tuple(dino.shape) == (1, 3072),
        "siglip is 1152 numbers": tuple(siglip.shape) == (1, 1152),
        "siglip text is 1152 numbers": tuple(text.shape) == (1, 1152),
        "colour is 396 numbers": tuple(colour.shape) == (396,),
        "dino has unit norm": all(abs(n - 1) < 1e-3 for n in norm(dino)),
        "siglip has unit norm": all(abs(n - 1) < 1e-3 for n in norm(siglip)),
        "siglip text has unit norm": all(abs(n - 1) < 1e-3 for n in norm(text)),
        "colour has unit norm": all(abs(n - 1) < 1e-3 for n in norm(colour)),
        "everything is finite": bool(np.isfinite(dino).all() and np.isfinite(siglip).all() and np.isfinite(text).all() and np.isfinite(colour).all()),
        "the same image encodes the same twice": float(np.abs(dino - again).max()) < 5e-3,
        "the models ran on a GPU": str(getattr(bank, "device", "")).startswith("cuda"),
    }
    return {"ok": all(checks.values()), "checks": checks, "device": str(getattr(bank, "device", "?")),
            "gpu": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None, "loadModelsS": round(load_s, 1),
            "encodeMs": round(encode_ms, 1), "torch": torch.__version__,
            "shapes": {"dino": list(dino.shape), "siglip": list(siglip.shape), "siglipText": list(text.shape), "colour": list(colour.shape)}}


@app.local_entrypoint()
def selftest():
    report = selftest_fn.remote()
    for name, passed in report["checks"].items():
        print(f"  {'PASS' if passed else 'FAIL'}  {name}")
    print(f"device {report['device']} ({report['gpu']}), torch {report['torch']}, models loaded in {report['loadModelsS']} s, "
          f"one photo encoded in {report['encodeMs']} ms, shapes {report['shapes']}")
    print("PASS" if report["ok"] else "FAIL")
    if not report["ok"]:
        sys.exit(1)


@app.local_entrypoint()
def import_bundle(catalogue: str, key: str, activate: bool = False, create: str = "", with_pdf: bool = False):
    """modal run modal_app.py::import_bundle --catalogue superbond-colour --key imports/superbond-colour/run1 [--activate] [--create "Superbond colours"] [--with-pdf]"""
    report = import_bundle_fn.remote(catalogue, key, activate, create, with_pdf)
    seeded = report.get("seeded")
    print(f"catalogue {report['catalogue']}: release {report['releaseId']} with {report['items']} items"
          + (" (created the catalogue)" if report.get("createdCatalogue") else "") + (", now live" if report["activated"] else ", stored but NOT live yet"))
    print(f"copied from the bucket: {report['fetched'].get('images')} pictures, {report['fetched'].get('bytes', 0) / 1e6:.1f} MB")
    if seeded:
        print(f"on the Modal volume: yes ({seeded['source']})")
    else:
        print(f"on the Modal volume: NO ({report.get('seedError')}); the release works from the bucket, run `modal run modal_app.py::prime --catalogue {catalogue}` to retry")
    for warning in report.get("warnings", [])[:10]:
        print(f"  note: {warning}")
    if not report["activated"] and report.get("releaseId"):
        print(f"to make it live: python -m terucon_catalogue activate --catalogue {catalogue} --release {report['releaseId']}   (or the admin screen)")


@app.local_entrypoint()
def prime(catalogue: str, release: str = ""):
    """modal run modal_app.py::prime --catalogue superbond-colour [--release rel-...]   (default: the live release and the one before it)"""
    for item in prime_fn.remote(catalogue, release):
        print(f"on the Modal volume: {item['catalogue']} {item['releaseId']} ({item['items']} items, {item['source']})")


if __name__ == "__main__":
    print(__doc__)
