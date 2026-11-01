"""
vision_stack.py - MoGe-2, Marigold-IID, SAM 3, OneFormer and the Terucon catalogue engine (DINOv2-large + SigLIP
so400m, CIELAB colour, Gemini / Vertex AI captions, embeddings and Nano Banana renders) as autoscaling Modal services,
with every file the catalogue pipeline produces kept on a Modal Volume.

DEPLOY
    modal secret create vision-api-keys API_KEYS="$(openssl rand -hex 32),$(openssl rand -hex 32)"
    modal secret create huggingface HF_TOKEN=hf_xxx      # account must have access to facebook/sam3
    modal secret create vertex-ai VERTEX_AI_SA_JSON="$(cat service-account.json)"   # role "Vertex AI User"
    modal volume create --version=2 vision-stack-data    # optional: the first deploy creates it (as v2) if missing
    modal run    vision_stack.py                         # GPU self-test of every model
    modal deploy vision_stack.py                         # prints the URLs
    python vision_stack.py prime                         # optional, right after a deploy: create the GPU snapshots
                                                         # now instead of on your users' first requests

    VISION_GPU_TIER=economy modal deploy vision_stack.py # L4-first lists (cheaper, slower). Default tier: "fast"
    VISION_MIN_CONTAINERS=1 modal deploy vision_stack.py # always one warm container per service (no cold start)
    VISION_CATALOG_VERTEX=0 modal deploy vision_stack.py # catalogue without Vertex AI (no captions, text vectors,
                                                         # Vertex image vectors or renders; no vertex-ai secret needed)

CATALOGUE  (python vision_stack.py ...  talks to the deployed app with your local Modal credentials)
    python vision_stack.py ingest "Superbond colour image.pdf" --catalog terucon --wait
                                     uploads the PDF to the Volume, then runs the five notebook stages on Modal:
                                     PDF extraction -> DINOv2 + SigLIP + CIELAB -> Vertex image vectors -> Gemini
                                     material profiles + text vectors -> FAISS. Every stage resumes where it stopped.
    python vision_stack.py job <job_id>          progress / result of an ingest
    python vision_stack.py catalogs              what is on the Volume
    python vision_stack.py evaluate --catalog terucon    recall@1/5 + MRR under simulated phone capture
    modal volume get vision-stack-data /catalogs/terucon ./terucon     # download everything (crops, renders, db...)
    Moving the Kaggle run over: `modal volume put vision-stack-data ./working /catalogs/terucon`, the PDF to
    /catalogs/terucon/pdfs/, then `python vision_stack.py ingest --catalog terucon --wait` (no PDF argument) to publish
    it. Old absolute /kaggle/... paths in state.sqlite are remapped, so finished pages and vectors are reused (captions
    are redone once only if this pydantic version prints the MaterialProfile schema differently).

ENDPOINTS (all require  Authorization: Bearer <key>  or  X-API-Key: <key>)
    GET  /healthz
    POST /v1/geometry   (MoGe-2)    multipart: image, resolution_level, max_side, fov_x, include, dtype, compress
    POST /v1/decompose  (Marigold)  multipart: image, model, steps, ensemble, resolution, seed, raw
    POST /v1/segment    (SAM 3)     multipart: image, prompt (repeatable), boxes, threshold, mask_format
    POST /v1/parse      (OneFormer) multipart: image, task (repeatable: semantic | panoptic | instance), resolution,
                                    threshold, overlap_threshold, max_instances, mask_format, max_side, tta
    POST /v1/oneformer  (OneFormer) the same handler under the name the Swatchroom server asks for
    GET  /v1/classes    (OneFormer) the 150 ADE20K classes: id, label, full name, thing/stuff
    POST /v1/analyze    (VisionAll) multipart: image, max_side, prompt (repeatable) ... -> ONE zip with MoGe-2 depth,
                                    Marigold lighting (shading + residual) and SAM 3 masks for the same photo
    POST /v1/embed      (catalogue) multipart: image, rectify, tta_hflip, include, format -> DINOv2 / SigLIP / CIELAB
                                    vectors with their feature versions (the same vectors the catalogue index stores)
    POST /v1/embed/text (catalogue) multipart: text (repeatable), raw -> SigLIP text vectors
    GET  /v1/catalogs                                   catalogues on the Volume + what each one has published
    POST /v1/catalog/{catalog}/search    multipart: image and/or text, top_k, weights (JSON), filters (JSON),
                                         describe_photo, use_vertex_mm, fusion_mode ("rrf" | "linear" | "hybrid")
    POST /v1/catalog/{catalog}/ingest    multipart: pdf (upload) or pdf_name (already on the Volume), use_vertex -> 202
    GET  /v1/jobs/{job_id}               ingest progress / result
    GET  /v1/catalog/{catalog}                          published summary (counts, feature versions, updated_at)
    GET  /v1/catalog/{catalog}/items                    paged item list, ?material_category=&limit=&offset=
    GET  /v1/catalog/{catalog}/items/{item_id}          lineage (PDF, page, bboxes, sha256) + Gemini material profile
    GET  /v1/catalog/{catalog}/items/{item_id}/crop     the stored crop
    GET  /v1/catalog/{catalog}/items/{item_id}/verify   re-renders the crop from its PDF page and compares sha256
    GET  /v1/catalog/{catalog}/items/{item_id}/provenance   PNG of the page with the image box and ID box drawn
    GET  /v1/catalog/{catalog}/products?product_id=     every item that carries a product code
    POST /v1/catalog/{catalog}/render    multipart: item_id, scene (optional photo), target_description,
                                         extra_instructions, aspect_ratio -> Nano Banana image (stored on the Volume)
    GET  /v1/catalog/{catalog}/renders/{render_id}      a stored render; .../meta for its prompt + lineage JSON
    POST /v1/catalog/{catalog}/evaluate  self-retrieval benchmark under simulated phone capture (recall@1/5, MRR)

ONE POOL OR SEVERAL  (VISION_LAYOUT, default "both")
    Every Modal service is its own container pool, and each pool bills SCALEDOWN_S of idle time after its last call. A
    photo that touches four services therefore wakes four GPUs and pays four idle tails. The "VisionAll" class holds all
    the models in ONE container behind ONE URL (label "vision-all") and serves every route above, so one photo costs
    one cold start and one idle tail. The dedicated classes stay available for the day one model needs its own GPU.
        both      (default)  deploy VisionAll next to the dedicated classes: your existing URLs keep working, and you
                             switch the Swatchroom .env to the vision-all URLs when you are ready
        combined             deploy only VisionAll (the old URLs stop working, nothing idles on them)
        split                the dedicated classes only (MoGe2, MarigoldIID, Sam3, OneFormer, CatalogSearch)
    VisionAll runs the models one after another on one GPU (GpuGate), about 1.5-2 s of GPU time per photo for all of
    them; Marigold's "appearance" checkpoint is not loaded there (nothing in Swatchroom uses it), which saves VRAM and
    snapshot size. Use `modal run` to self-test it, `python vision_stack.py prime` to create its snapshots.
    VISION_ALL_CATALOG=0 keeps the catalogue engine out of VisionAll (it then always gets its own CatalogSearch pool,
    label "vision-catalog"), for when the extra ~2.5 GB of weights in the combined snapshot is not worth it.

STORAGE  (Modal Volume "vision-stack-data", v2, mounted at /data; one folder per catalogue)
    /data/catalogs/<catalog>/
        pdfs/                 the catalogue PDFs (inputs; uploaded by `ingest` or POST .../ingest)
        state.sqlite          source of truth: pages, items, captions, vectors, errors, renders (published snapshot)
        manifest.parquet      lineage export: product_id -> PDF, page, bboxes, crop, sha256, status
        page_audit.parquet    per-page extraction audit
        crops/                one PNG per catalogue item
        index/                FAISS index + ids + fingerprint per pillar
        renders/              Nano Banana renders, their JSON metadata and the scene photo they used
        backtrace/            provenance overlays
        published.json        version, counts and feature versions of the last publish
    Volumes have no file locking and a reload needs zero open files, so one rule keeps this safe: only the CatalogWriter
    (one CPU container, max_containers=1) writes catalogue state. It works on a local copy of state.sqlite, publishes a
    consistent snapshot (SQLite backup API) to the Volume after each stage and at least every CATALOG_PUBLISH_EVERY_S,
    commits, and bumps the version in a modal.Dict. GPU containers read only: on a version change they reload the
    Volume (VolumeGuard waits for open files to close), copy the snapshot locally and rebuild the in-memory index.
    The GPU containers' only writes are uploaded PDFs (their own new files, committed before the writer is called).
    Model weights stay baked into the images (below); the Volume holds data, not weights.

WHY IT IS FAST
    * weights are baked into the image layers at build time (Image.run_function) as .safetensors; nothing is
      downloaded at runtime (HF_HUB_OFFLINE=1). OneFormer also gets its task tokens, class table and preprocessing
      constants baked, so its containers never load a tokenizer or an image processor
    * @modal.enter loads straight to the GPU and runs warm-up passes; with GPU_SNAPSHOT the fully-warm process
      (weights + CUDA state) is snapshotted, so new containers restore in seconds
    * the memory warm-up left behind (CUDA allocator cache, freed host heap) is released before the snapshot is
      taken, so every snapshot is smaller to write and to restore
    * CPU work (decode / encode) runs in threads OUTSIDE the GPU critical section, so request N+1 is being decoded
      while request N is on the GPU; OneFormer resizes and normalises on the GPU and runs its Swin-L backbone once
      for all the tasks a request asks for
    * the GPU section is serialised per container (GpuGate), concurrency comes from @modal.concurrent plus the
      autoscaler: that keeps memory flat and every request's output identical to a solo run

HOW THE GPU FALLBACK LISTS ARE CHOSEN (GPU_TIERS below)
    * Modal tries each service's list in order and moves to the next type when it cannot get the current one, so a
      sold-out pool no longer leaves a request queued ("waiting to be scheduled on a GPU_L4 worker" took 213 s and
      17 min in the audit)
    * memory snapshots belong to one GPU type (and one host CPU type): Modal needs 2-3 snapshots per GPU type and a
      deploy starts them all over. The first containers on a type the deployment has not used yet therefore do a
      full boot plus snapshot creation. A "similar" GPU does not share snapshots, so similarity does not avoid that
      boot; what helps is:
        - three entries per service: at most three snapshot families to build after each deploy
        - fallbacks that are as fast as the first choice or faster (L40S -> A100), with the plentiful L4 last so a
          request never waits minutes for a sold-out pool. L40S and L4 are both Ada (sm_89), so the same kernels run
        - no entry Modal may silently swap for another card (it may serve an A100 request on an 80 GB card and an
          H100 request on an H200, which are separate snapshot families): "A100-80GB" and "H100!" pin the card
        - every entry fits each model, has native bf16/fp16 (Ampere or newer, so no T4) and supports GPU snapshots
        - `python vision_stack.py prime` boots containers right after a deploy so the primary type's snapshots
          exist before real traffic arrives; WARM_WINDOW keeps one container warm during your working hours
    * every authenticated response carries x-gpu / x-gpu-rank / x-container-requests / x-container-age, and /healthz
      reports the same, so the Node server can tell a fallback GPU or a freshly started container (a cold start,
      which is not processing time) from a warm one; see server/lib/coldStart.js
"""
import asyncio
import base64
import contextlib
import hashlib
import hmac
import io
import json
import logging
import os
import sys
import threading
import time
import uuid
import zipfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Literal, Optional, Tuple

import modal

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("vision_stack")

# =====================================================================================
# 1. CONFIG  (everything you are likely to tune lives here)
# =====================================================================================
APP_NAME = "vision-stack"
API_KEYS_SECRET = "vision-api-keys"   # must define API_KEYS="key1,key2" (each >= 16 chars)
HF_SECRET = "huggingface"             # must define HF_TOKEN (needed only to bake SAM 3)

# Edge auth: Modal rejects unauthenticated calls BEFORE a GPU container is started (clients then also
# send Modal-Key / Modal-Secret headers from a Modal "Proxy Auth Token"). Strongly recommended in prod,
# otherwise anybody can wake your GPUs with junk requests (they will still get 401, but you pay for boot).
REQUIRE_PROXY_AUTH = False

# GPU memory snapshots (alpha): restores a fully loaded + warmed model in seconds. Deployed apps only.
# Set False to fall back to a plain @modal.enter load (slower cold start, nothing experimental).
GPU_SNAPSHOT = True


def _env_int(name: str, default: int) -> int:
    try:
        return max(0, int(os.environ.get(name, default)))
    except ValueError:
        return default


# GPU fallback lists, best first (see "HOW THE GPU FALLBACK LISTS ARE CHOSEN" at the top of the file).
#   L4 $0.80/h 24 GB (Ada)   A10 $1.10/h 24 GB (Ampere)   L40S $1.95/h 48 GB (Ada)   A100-80GB $2.50/h (Ampere)
# Spec-sheet dense fp16 throughput: L40S ~3x an L4, A100 ~2.5x an L4 with ~7x its memory bandwidth.
# "fast" puts every model on an L40S first: latency first. Per request it costs about the same as an L4 (the faster
# card finishes sooner); what costs more is idle time, i.e. SCALEDOWN_S after each burst and any warm containers.
GPU_TIERS = {
    "fast": {
        "moge2":     ["L40S", "A100-80GB", "L4"],
        "marigold":  ["L40S", "A100-80GB", "L4"],
        "sam3":      ["L40S", "A100-80GB", "L4"],
        "oneformer": ["L40S", "A100-80GB", "L4"],
        # catalogue search is ~20 ms of GPU next to 1-4 s of Vertex AI calls, so even "fast" starts on the L4
        "catalog":   ["L4", "L40S", "A100-80GB"],
        "vision":    ["L40S", "A100-80GB", "L4"],   # every model at once: about 15 GB of weights + activations
    },
    "economy": {   # cheapest first; the first fallback is faster, so a sold-out L4 pool never makes a request slower
        "moge2":     ["L4", "L40S", "A10"],
        "marigold":  ["L4", "L40S", "A10"],
        "sam3":      ["L4", "L40S", "A10"],
        "oneformer": ["L4", "L40S", "A10"],
        "catalog":   ["L4", "L40S", "A10"],
        "vision":    ["L4", "L40S", "A10"],
    },
}
GPU_TIER = os.environ.get("VISION_GPU_TIER", "fast")   # passed to the containers through a secret, see _cls_kwargs
if GPU_TIER not in GPU_TIERS:
    raise ValueError(f"VISION_GPU_TIER must be one of {sorted(GPU_TIERS)}, got {GPU_TIER!r}")

# Which classes this deployment defines (see "ONE POOL OR FOUR" at the top of the file).
VISION_LAYOUT = os.environ.get("VISION_LAYOUT", "both")
if VISION_LAYOUT not in ("both", "combined", "split"):
    raise ValueError(f"VISION_LAYOUT must be both, combined or split, got {VISION_LAYOUT!r}")
WANT_SPLIT = VISION_LAYOUT in ("both", "split")
WANT_COMBINED = VISION_LAYOUT in ("both", "combined")

_RESOURCES = {
    #             in-flight per container        host RAM
    "moge2":     dict(max_inputs=8, target_inputs=2, memory_mib=16384),
    "marigold":  dict(max_inputs=8, target_inputs=2, memory_mib=16384),
    "sam3":      dict(max_inputs=8, target_inputs=2, memory_mib=24576),
    "oneformer": dict(max_inputs=8, target_inputs=2, memory_mib=16384),
    # target_inputs 4: a catalogue search spends most of its time waiting on Vertex AI, not on the GPU
    "catalog":   dict(max_inputs=8, target_inputs=4, memory_mib=16384),
    # target_inputs 4: one designer's scan (/v1/parse) and room analysis (/v1/analyze) overlap, and a second
    # container would be a second cold start and a second idle tail for what one warm GPU does in a couple of seconds
    "vision":    dict(max_inputs=8, target_inputs=4, memory_mib=32768),
}
SERVICES = {}
for _name, _resources in _RESOURCES.items():
    SERVICES[_name] = dict(gpu=GPU_TIERS[GPU_TIER][_name], **_resources)
# target_inputs: the autoscaler adds containers when in-flight requests per container exceed this
# max_inputs   : hard cap per container (extra requests are routed elsewhere / queue)
# 10 simultaneous calls with target_inputs=2 -> the autoscaler fans out to ~5 containers.

SERVICE_CLASSES = {"moge2": "MoGe2", "marigold": "MarigoldIID", "sam3": "Sam3", "oneformer": "OneFormer",
                   "catalog": "CatalogSearch", "vision": "VisionAll"}

# The catalogue engine (DINOv2 + SigLIP) lives in VisionAll too unless VISION_ALL_CATALOG=0. Without it there, the
# dedicated CatalogSearch pool is deployed in every layout, because the catalogue needs a GPU somewhere.
CATALOG_IN_VISION_ALL = os.environ.get("VISION_ALL_CATALOG", "1") == "1"
WANT_CATALOG_SPLIT = WANT_SPLIT or not CATALOG_IN_VISION_ALL
# The pool the CatalogWriter sends its batch-encoding work to during an ingest.
CATALOG_ENCODER_SERVICE = "vision" if (WANT_COMBINED and CATALOG_IN_VISION_ALL) else "catalog"


def _service_deployed(key: str) -> bool:
    if key == "vision":
        return WANT_COMBINED
    if key == "catalog":
        return WANT_CATALOG_SPLIT
    return WANT_SPLIT


# What exists in this layout, and what `prime` / the warm window act on: the combined pool when there is one (the
# dedicated pools are then only a fallback nobody should be paying to keep warm).
DEPLOYED_SERVICES = [key for key in SERVICE_CLASSES if _service_deployed(key)]
if WANT_COMBINED:
    PRIMED_SERVICES = ["vision"]
    if not CATALOG_IN_VISION_ALL:
        PRIMED_SERVICES.append("catalog")
else:
    PRIMED_SERVICES = [key for key in DEPLOYED_SERVICES if key != "vision"]

# Cost vs. cold start without editing the file:  VISION_MIN_CONTAINERS=1 modal deploy vision_stack.py
MIN_CONTAINERS = _env_int("VISION_MIN_CONTAINERS", 0)   # 1+ = always warm (no cold start, but you pay for an idle GPU)
BUFFER_CONTAINERS = 0    # idle spare containers kept while there is traffic (burst absorber)
MAX_CONTAINERS = 6       # per service; also your hard cost ceiling
SCALEDOWN_S = _env_int("VISION_SCALEDOWN_S", 300)   # idle seconds before a container is stopped
CPU_CORES = 4.0          # decode / resize / PNG / zip work is CPU; Modal's default is only 0.125 core
REQUEST_TIMEOUT_S = 300
STARTUP_TIMEOUT_S = 900
GPU_SLOTS = 1            # simultaneous GPU forward passes per container (1 = flat memory, deterministic)
QUEUE_TIMEOUT_S = 45.0   # a request waiting longer than this for the GPU gets a 503 + Retry-After
MAX_UPLOAD_BYTES = 32 * 1024 * 1024
MAX_PIXELS = 80_000_000  # decompression-bomb guard on the *input* image
PNG_LEVEL = 1            # fast PNG (outputs are already small; level 1 is ~5x faster than 6)

# Warm window (off by default): keep `containers` warm per listed service between `start` and `stop` (cron, local
# time of WARM_TZ). No cold starts during those hours; you pay for those idle GPUs, e.g. one L40S for 12 h is ~$23
# a day per service. Example: dict(start="0 9 * * 1-6", stop="0 21 * * 1-6", containers=1, services=["vision"])
WARM_WINDOW = None
WARM_TZ = "Asia/Kolkata"

# Pins. Everything below was read from upstream source at these revisions.
TORCH_INDEX = "https://download.pytorch.org/whl/cu128"
TRANSFORMERS_PIN = "transformers==5.20.2"
MOGE_COMMIT = "07444410f1e33f402353b99d6ccd26bd31e469e8"   # last MoGe-2 commit (main is MoGe-3 now)
UTILS3D_PIN = ("utils3d @ git+https://github.com/EasternJournalist/utils3d.git"
               "@3fab839f0be9931dac7c8488eb0e1600c236e183")
SAM3_COMMIT = "f1647e8d0c1d280991f4d1b7d974c2704537fe66"
MOGE_REPO = "Ruicheng/moge-2-vitl-normal"   # best quality + normals; "-vitb-normal" is ~2x faster
MARIGOLD_REPOS = {
    "appearance": "prs-eth/marigold-iid-appearance-v1-1",   # albedo, roughness, metallicity
    "lighting": "prs-eth/marigold-iid-lighting-v1-1",       # albedo, diffuse shading, residual
}
# NOTE: the image model of the SAM 3 repo loads the SAM 3 checkpoint. The facebook/sam3.1 checkpoint is the
# "Object Multiplex" *video tracker* and does not load into the image model (different neck/heads).
SAM3_REPO, SAM3_CKPT = "facebook/sam3", "sam3.pt"

# OneFormer Swin-L, ADE20K (150 classes, 250 queries), trained at 640 px short side. The repo ships only a
# pytorch_model.bin (plus a 950 MB detectron2 .pth that is not needed); the bake converts it to safetensors.
ONEFORMER_REPO = "shi-labs/oneformer_ade20k_swin_large"
ONEFORMER_REV = "4a5bac8e64f82681a12db2e151a4c2f4ce6092b2"   # main on 2026-10-26
ONEFORMER_TASKS = ("semantic", "instance", "panoptic")
ONEFORMER_AMP = "fp16"   # autocast dtype: "fp16" (OneFormer was trained with fp16 AMP), "bf16", or "fp32" (slowest)
ONEFORMER_TTA_SCALES = (0.75, 1.0, 1.25)   # tta=true: these scales x horizontal flip, semantic task only
ONEFORMER_IGNORED_MISSING = ("criterion.", "model.pixel_level_module.encoder.swin.layernorm.")

WEIGHTS = "/weights"
MOGE_SRC, SAM3_SRC = "/opt/MoGe", "/opt/sam3"

# ---- Catalogue engine (the Terucon catalogue notebook: tri-modal retrieval + Nano Banana material rendering) ---------
# Model repos are also part of the feature-version strings stored next to every vector: changing one re-embeds.
DINO_REPO = "facebook/dinov2-large"                     # texture pillar: [CLS] + patch mean + patch std, 3072-d
SIGLIP_REPO = "google/siglip-so400m-patch14-384"        # semantic pillar: image AND text in one space, 1152-d
CATALOG_GPU_BATCH = 32         # images per forward pass (and per writer -> GPU call, about 1 MB of uint8 per image)
CATALOG_WEIGHTS = f"{WEIGHTS}/catalog"

VERTEX_SECRET = "vertex-ai"                # Modal secret holding the full service-account JSON ...
VERTEX_SECRET_KEY = "VERTEX_AI_SA_JSON"    # ... under this key (role "Vertex AI User" on the project)
CATALOG_USE_VERTEX = os.environ.get("VISION_CATALOG_VERTEX", "1") == "1"

DATA_VOLUME_NAME = "vision-stack-data"     # Modal Volume (v2) with every catalogue's files, mounted at DATA_ROOT
DATA_ROOT = "/data"
STATE_DICT_NAME = "vision-stack-state"     # modal.Dict: published catalogue versions + ingest job progress
DEFAULT_CATALOG = "terucon"
CATALOG_REFRESH_S = 15         # how often a GPU container asks whether its loaded catalogue is still the latest
CATALOG_PUBLISH_EVERY_S = 60   # the writer publishes state.sqlite at least this often during a long stage
CATALOG_MAX_PDF_BYTES = 1024 * 1024 * 1024     # POST .../ingest upload limit (Modal's own limit is 4 GiB)
CATALOG_JOB_TIMEOUT_S = 6 * 3600               # one ingest call; every stage resumes, so a re-run continues
WRITER_CPU = 4.0
WRITER_MEMORY_MIB = 16384
WRITER_SCALEDOWN_S = 300
WRITER_LOCAL_ROOT = "/tmp/vision-catalog-writer"   # the writer's live SQLite files (local disk, WAL)
READER_LOCAL_ROOT = "/tmp/vision-catalog-cache"    # GPU containers' read-only copies of the published snapshot


# =====================================================================================
# 2. IMAGES  (shared base -> cached once; weights baked as the last layer of each image)
# =====================================================================================
app = modal.App(APP_NAME)
hf_secret = modal.Secret.from_name(HF_SECRET)
api_keys_secret = modal.Secret.from_name(API_KEYS_SECRET)
# Containers re-import this file, so they must see the same switches you deployed with (tier, layout, catalogue).
runtime_secret = modal.Secret.from_dict({
    "VISION_GPU_TIER": GPU_TIER,
    "VISION_LAYOUT": VISION_LAYOUT,
    "VISION_ALL_CATALOG": "1" if CATALOG_IN_VISION_ALL else "0",
    "VISION_CATALOG_VERTEX": "1" if CATALOG_USE_VERTEX else "0",
})
data_volume = modal.Volume.from_name(DATA_VOLUME_NAME, create_if_missing=True, version=2)
state_dict = modal.Dict.from_name(STATE_DICT_NAME, create_if_missing=True)
vertex_secrets = [modal.Secret.from_name(VERTEX_SECRET)] if CATALOG_USE_VERTEX else []

_OFFLINE_ENV = {"HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1", "TOKENIZERS_PARALLELISM": "false",
                "OMP_NUM_THREADS": "4"}
_RUNTIME_ENV = dict(_OFFLINE_ENV)
if not GPU_SNAPSHOT:  # expandable segments (CUDA VMM) and CUDA checkpoint/restore do not mix
    _RUNTIME_ENV["PYTORCH_CUDA_ALLOC_CONF"] = "expandable_segments:True"


def _git_checkout(url: str, sha: str, dest: str) -> str:
    return (f"mkdir -p {dest} && cd {dest} && git init -q && git remote add origin {url} && "
            f"git fetch -q --depth 1 origin {sha} && git checkout -q FETCH_HEAD")


# CUDA userspace comes with the torch wheel; Modal's hosts provide the driver -> no nvidia/cuda base image,
# no nvcc, no xformers pin puzzle. Python 3.12 + torch 2.10/cu128 is what SAM 3 requires; the other models
# are happy with the same stack, so all four share these base layers.
_base = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install("git")
    .uv_pip_install("torch==2.10.0", "torchvision", index_url=TORCH_INDEX)
    .uv_pip_install(
        "numpy<2", "scipy", "pillow", "opencv-python-headless==4.10.0.84", "tqdm",
        "safetensors", "huggingface_hub", "fastapi", "python-multipart",
    )
)


def _bake_moge():
    """Build time: download MoGe-2 weights, convert .pt -> .safetensors, validate on CPU."""
    import shutil

    import torch
    from huggingface_hub import hf_hub_download
    from safetensors.torch import load_file, save_file

    out, tmp = f"{WEIGHTS}/moge2", "/tmp/hf-build"
    os.makedirs(out, exist_ok=True)
    ckpt = torch.load(hf_hub_download(MOGE_REPO, "model.pt", cache_dir=tmp), map_location="cpu", weights_only=True)
    state = {k: v.detach().clone().contiguous() for k, v in ckpt["model"].items()}  # no shared storage
    save_file(state, f"{out}/model.safetensors", metadata={"format": "pt", "source": MOGE_REPO})
    torch.save(ckpt["model_config"], f"{out}/config.pt")

    sys.path.insert(0, MOGE_SRC)
    from moge.model.v2 import MoGeModel

    model = MoGeModel(**torch.load(f"{out}/config.pt", weights_only=True))
    res = model.load_state_dict(load_file(f"{out}/model.safetensors"), strict=False)
    if res.missing_keys:
        raise RuntimeError(f"MoGe safetensors is missing keys: {res.missing_keys[:10]}")
    print(f"[bake] MoGe-2 ok: {sum(p.numel() for p in model.parameters()) / 1e6:.0f}M params")
    shutil.rmtree(tmp, ignore_errors=True)


def _bake_marigold():
    """Build time: snapshot both Marigold IID checkpoints (fp16 safetensors) and smoke-load them."""
    import diffusers
    import torch
    from huggingface_hub import snapshot_download

    def load(path):
        return diffusers.MarigoldIntrinsicsPipeline.from_pretrained(
            path, variant="fp16", dtype=torch.float16, use_safetensors=True, local_files_only=True)

    for key, repo in MARIGOLD_REPOS.items():
        d = f"{WEIGHTS}/marigold/{key}"
        snapshot_download(repo, local_dir=d, allow_patterns=["*.json", "*.txt", "*.fp16.safetensors"])
        try:
            pipe = load(d)
        except Exception as e:  # a component without an fp16 file -> fetch the plain safetensors too
            print(f"[bake] fp16-only snapshot of {repo} incomplete ({e!r}); fetching all safetensors")
            snapshot_download(repo, local_dir=d, allow_patterns=["*.json", "*.txt", "*.safetensors"])
            pipe = load(d)
        print(f"[bake] Marigold {key}: targets={pipe.target_properties['target_names']} "
              f"steps={pipe.default_denoising_steps} res={pipe.default_processing_resolution}")


def _bake_marigold_lighting():
    """Build time, VisionAll only: the "lighting" checkpoint alone (albedo, shading, residual). Swatchroom never asks
    for "appearance" (roughness / metallicity), so the combined image does not carry it. A separate function from
    _bake_marigold on purpose: editing that one would invalidate the cached layers of the dedicated image."""
    import diffusers
    import torch
    from huggingface_hub import snapshot_download

    def load(path):
        return diffusers.MarigoldIntrinsicsPipeline.from_pretrained(
            path, variant="fp16", dtype=torch.float16, use_safetensors=True, local_files_only=True)

    key, repo = "lighting", MARIGOLD_REPOS["lighting"]
    d = f"{WEIGHTS}/marigold/{key}"
    snapshot_download(repo, local_dir=d, allow_patterns=["*.json", "*.txt", "*.fp16.safetensors"])
    try:
        pipe = load(d)
    except Exception as e:   # a component without an fp16 file -> fetch the plain safetensors too
        print(f"[bake] fp16-only snapshot of {repo} incomplete ({e!r}); fetching all safetensors")
        snapshot_download(repo, local_dir=d, allow_patterns=["*.json", "*.txt", "*.safetensors"])
        pipe = load(d)
    print(f"[bake] Marigold {key}: targets={pipe.target_properties['target_names']}")


def _bake_sam3():
    """Build time: download SAM 3 (gated), keep only the image detector weights as safetensors, validate."""
    import shutil

    import torch
    from huggingface_hub import hf_hub_download
    from safetensors.torch import load_file, save_file

    out, tmp = f"{WEIGHTS}/sam3", "/tmp/hf-build"
    os.makedirs(out, exist_ok=True)
    ckpt = torch.load(hf_hub_download(SAM3_REPO, SAM3_CKPT, cache_dir=tmp), map_location="cpu", weights_only=True)
    if "model" in ckpt and isinstance(ckpt["model"], dict):
        ckpt = ckpt["model"]
    # same key filtering as sam3.model_builder._load_checkpoint (image model, no interactive tracker)
    det = {k.replace("detector.", ""): v.detach().clone().contiguous() for k, v in ckpt.items() if "detector" in k}
    if not det:
        raise RuntimeError("no detector.* keys found in the SAM 3 checkpoint")
    save_file(det, f"{out}/sam3_detector.safetensors", metadata={"format": "pt", "source": SAM3_REPO})

    sys.path.insert(0, SAM3_SRC)
    from sam3.model_builder import build_sam3_image_model

    model = build_sam3_image_model(device="cpu", eval_mode=True, load_from_HF=False, checkpoint_path=None)
    res = model.load_state_dict(load_file(f"{out}/sam3_detector.safetensors"), strict=False)
    n, miss = len(model.state_dict()), len(res.missing_keys)
    print(f"[bake] SAM 3: {n - miss}/{n} tensors matched, {len(res.unexpected_keys)} unexpected")
    if miss > 0.02 * n:
        raise RuntimeError(f"SAM 3 checkpoint does not match the model definition (missing {miss}/{n})")
    shutil.rmtree(tmp, ignore_errors=True)


def _bake_oneformer():
    """Build time: OneFormer .bin -> .safetensors (with the key names of the pinned transformers), the three task
    token rows, the class table and the preprocessing constants -> /weights/oneformer. Validates that the runtime
    loading path matches the checkpoint exactly, and cross-checks the GPU preprocessing against the HF processor."""
    import shutil

    import torch
    from huggingface_hub import hf_hub_download, snapshot_download
    from safetensors.torch import load_file, save_file
    from transformers import AutoTokenizer, OneFormerConfig, OneFormerForUniversalSegmentation

    out, tmp = f"{WEIGHTS}/oneformer", "/tmp/hf-build"
    os.makedirs(out, exist_ok=True)
    # configs, tokenizer files and the HF weights; NOT the 950 MB detectron2 .pth that sits in the same repo
    src = snapshot_download(ONEFORMER_REPO, revision=ONEFORMER_REV, cache_dir=tmp,
                            allow_patterns=["*.json", "*.txt", "pytorch_model.bin"])

    # from_pretrained applies whatever key renames the pinned transformers needs for this 2022 checkpoint
    loaded = OneFormerForUniversalSegmentation.from_pretrained(src, dtype=torch.float32, output_loading_info=True)
    if isinstance(loaded, tuple):
        model, info = loaded
    else:
        model, info = loaded, {}
    missing = [k for k in info.get("missing_keys", []) if not k.startswith(ONEFORMER_IGNORED_MISSING)]
    if missing or info.get("mismatched_keys"):
        raise RuntimeError(f"OneFormer checkpoint does not match the model: missing={missing[:10]} "
                           f"mismatched={list(info.get('mismatched_keys') or [])[:10]}")

    config = model.config
    config.output_attentions = False          # the hub config turns all three on; at inference they only hold
    config.output_hidden_states = False       # extra tensors alive (memory) and are never read
    config.output_auxiliary_logits = False
    config.save_pretrained(out)
    state = {}
    for key, value in model.state_dict().items():   # keep every dtype (Swin's position index is int64)
        state[key] = value.detach().clone().contiguous()
    save_file(state, f"{out}/model.safetensors", metadata={"format": "pt", "source": ONEFORMER_REPO})

    # task tokens exactly like OneFormerProcessor._preprocess_text: ids * attention_mask, padded to task_seq_len
    tokenizer = AutoTokenizer.from_pretrained(src)
    texts = [f"the task is {task}" for task in ONEFORMER_TASKS]
    enc = tokenizer(texts, padding="max_length", max_length=config.task_seq_len, truncation=True)
    token_ids = torch.tensor(enc["input_ids"]) * torch.tensor(enc["attention_mask"])
    tokens = {}
    for index, task in enumerate(ONEFORMER_TASKS):
        tokens[task] = token_ids[index:index + 1].to(torch.float32).contiguous()
    save_file(tokens, f"{out}/task_inputs.safetensors")

    with open(os.path.join(src, "preprocessor_config.json"), encoding="utf-8") as f:
        pre = json.load(f)
    size = pre.get("size") or {}
    id2label = {int(k): v for k, v in config.id2label.items()}
    thing_ids = sorted(int(i) for i in (pre.get("metadata") or {}).get("thing_ids", []))
    if not thing_ids:
        raise RuntimeError("preprocessor_config.json has no metadata.thing_ids (needed for panoptic / instance)")
    meta = {
        "repo": ONEFORMER_REPO, "revision": ONEFORMER_REV,
        "class_names": [id2label[i] for i in range(len(id2label))],
        "thing_ids": thing_ids,
        "shortest_edge": int(size.get("shortest_edge", 640)),
        "longest_edge": int(size.get("longest_edge", 2560)),
        "image_mean": [float(v) for v in pre.get("image_mean", [0.485, 0.456, 0.406])],
        "image_std": [float(v) for v in pre.get("image_std", [0.229, 0.224, 0.225])],
        "rescale_factor": float(pre.get("rescale_factor", 1 / 255)),
        "do_rescale": bool(pre.get("do_rescale", True)),
        "num_queries": int(config.num_queries),
    }
    with open(f"{out}/meta.json", "w", encoding="utf-8") as f:
        json.dump(meta, f)

    # the exact runtime loading path (see OneFormerEngine.load), on CPU
    check = OneFormerForUniversalSegmentation(OneFormerConfig.from_pretrained(out))
    res = check.load_state_dict(load_file(f"{out}/model.safetensors"), strict=False)
    missing = [k for k in res.missing_keys if not k.startswith(ONEFORMER_IGNORED_MISSING)]
    if missing or res.unexpected_keys:
        raise RuntimeError(f"OneFormer safetensors round trip failed: missing={missing[:10]} "
                           f"unexpected={res.unexpected_keys[:10]}")
    print(f"[bake] OneFormer ok: {sum(p.numel() for p in check.parameters()) / 1e6:.0f}M params, "
          f"{len(meta['class_names'])} classes ({len(thing_ids)} things), {meta['num_queries']} queries, "
          f"short side {meta['shortest_edge']} / long side {meta['longest_edge']}")

    try:   # best effort: the HF processor fetches its class file from another repo; a failure only skips the check
        from PIL import Image
        from transformers import OneFormerProcessor

        processor = OneFormerProcessor.from_pretrained(src)
        mean, std = oneformer_norm(meta, "cpu")
        for h, w in ((480, 640), (1080, 1920), (900, 600)):
            rgb = synthetic_image(h, w)
            ref = processor(images=Image.fromarray(rgb), task_inputs=["semantic"], return_tensors="pt")
            hw = oneformer_resize_hw(h, w, meta["shortest_edge"], meta["longest_edge"])
            ref_pixels = ref["pixel_values"][0].float()
            same_tokens = bool(torch.equal(ref["task_inputs"][0].long(), tokens["semantic"][0].long()))
            if tuple(ref_pixels.shape[-2:]) == hw:
                mine = oneformer_pixels(torch.from_numpy(rgb), hw, mean, std)[0]
                print(f"[bake] preprocessing {h}x{w} -> {hw}: max |diff| vs HF = "
                      f"{(mine - ref_pixels).abs().max().item():.4f}, task tokens equal: {same_tokens}")
            else:
                print(f"[bake] preprocessing {h}x{w}: HF resizes to {tuple(ref_pixels.shape[-2:])}, this file "
                      f"to {hw} (tiny rounding difference), task tokens equal: {same_tokens}")
    except Exception as e:
        print(f"[bake] HF processor cross-check skipped: {e!r}")

    try:   # a real ADE20K scene for `modal run` (falls back to a synthetic image when missing)
        demo = hf_hub_download("shi-labs/oneformer_demo", "ade20k.jpeg", repo_type="dataset", cache_dir=tmp)
        shutil.copy(demo, f"{out}/demo.jpg")
    except Exception as e:
        print(f"[bake] demo image not baked: {e!r}")
    shutil.rmtree(tmp, ignore_errors=True)


moge_image = (
    _base
    .run_commands(_git_checkout("https://github.com/microsoft/MoGe.git", MOGE_COMMIT, MOGE_SRC))
    .uv_pip_install("pandas", "matplotlib", UTILS3D_PIN)
    .run_function(_bake_moge)
    .env(_RUNTIME_ENV)
)

marigold_image = (
    _base
    .uv_pip_install("diffusers==0.42.0", TRANSFORMERS_PIN, "accelerate", "matplotlib")
    .run_function(_bake_marigold)
    .env(_RUNTIME_ENV)
)

_sam3_base = (
    _base
    .run_commands(_git_checkout("https://github.com/facebookresearch/sam3.git", SAM3_COMMIT, SAM3_SRC))
    .uv_pip_install("timm>=1.0.17", "ftfy==6.1.1", "regex", "iopath>=0.1.10", "typing_extensions",
                    "psutil", "setuptools<81", "einops", "pycocotools", "scikit-image", "scikit-learn", "pandas", "decord"
                    )  # sam3 imports pkg_resources
    .run_function(_bake_sam3, secrets=[hf_secret], gpu="L4")
)

sam3_image = _sam3_base.env(_RUNTIME_ENV)

oneformer_image = (
    _base
    .uv_pip_install(TRANSFORMERS_PIN)          # scipy (needed by the model's loss module) is in the base layer
    .run_function(_bake_oneformer)
    .env(_RUNTIME_ENV)
)

def _bake_catalog():
    """Build time: DINOv2-large and SigLIP so400m (safetensors + tokenizer) -> /weights/catalog, plus the
    preprocessing constants the runtime needs, so containers never load an image processor. Validates both models
    on CPU (the dimensions recorded here are checked again when the GPU loads them)."""
    import shutil

    import torch
    from huggingface_hub import snapshot_download
    from transformers import AutoModel, AutoTokenizer

    out = CATALOG_WEIGHTS
    os.makedirs(out, exist_ok=True)
    dino_dir = snapshot_download(DINO_REPO, local_dir=f"{out}/dinov2", allow_patterns=["*.json", "*.safetensors"])
    siglip_dir = snapshot_download(SIGLIP_REPO, local_dir=f"{out}/siglip",
                                   allow_patterns=["*.json", "*.safetensors", "*.model", "*.txt"])
    shutil.rmtree(f"{out}/dinov2/.cache", ignore_errors=True)
    shutil.rmtree(f"{out}/siglip/.cache", ignore_errors=True)

    with open(os.path.join(dino_dir, "preprocessor_config.json"), encoding="utf-8") as f:
        dino_pre = json.load(f)
    with open(os.path.join(siglip_dir, "preprocessor_config.json"), encoding="utf-8") as f:
        siglip_pre = json.load(f)
    siglip_size = siglip_pre.get("size") or {}
    meta = {
        "dino_repo": DINO_REPO, "siglip_repo": SIGLIP_REPO,
        "dino_mean": [float(v) for v in dino_pre.get("image_mean", [0.485, 0.456, 0.406])],
        "dino_std": [float(v) for v in dino_pre.get("image_std", [0.229, 0.224, 0.225])],
        "siglip_mean": [float(v) for v in siglip_pre.get("image_mean", [0.5, 0.5, 0.5])],
        "siglip_std": [float(v) for v in siglip_pre.get("image_std", [0.5, 0.5, 0.5])],
        "siglip_height": int(siglip_size.get("height", 384)),
        "siglip_width": int(siglip_size.get("width", 384)),
    }

    with torch.inference_mode():
        dino = AutoModel.from_pretrained(dino_dir, dtype=torch.float32).eval()
        meta["num_register_tokens"] = int(getattr(dino.config, "num_register_tokens", 0) or 0)
        hidden = dino(pixel_values=torch.zeros(1, 3, 448, 448)).last_hidden_state
        meta["dino_hidden"] = int(hidden.shape[-1])
        del dino, hidden

        siglip = AutoModel.from_pretrained(siglip_dir, dtype=torch.float32).eval()
        text_config = getattr(siglip.config, "text_config", None)
        meta["siglip_text_length"] = int(getattr(text_config, "max_position_embeddings", 64) or 64)
        pixels = torch.zeros(1, 3, meta["siglip_height"], meta["siglip_width"])
        image_vector = siglip.vision_model(pixel_values=pixels).pooler_output
        tokenizer = AutoTokenizer.from_pretrained(siglip_dir)
        tokens = tokenizer(["a close-up photo of oak veneer material texture"], padding="max_length",
                           truncation=True, max_length=meta["siglip_text_length"], return_tensors="pt")
        text_vector = tensor_from_model_output(siglip.get_text_features(input_ids=tokens["input_ids"]))
        meta["siglip_dim"] = int(image_vector.shape[-1])
        if int(text_vector.shape[-1]) != meta["siglip_dim"]:
            raise RuntimeError(f"SigLIP image ({meta['siglip_dim']}) and text ({text_vector.shape[-1]}) differ")
        del siglip
    with open(f"{out}/meta.json", "w", encoding="utf-8") as f:
        json.dump(meta, f)
    print(f"[bake] catalogue engine ok: DINOv2 hidden {meta['dino_hidden']} -> {3 * meta['dino_hidden']}-d texture, "
          f"SigLIP {meta['siglip_dim']}-d, text length {meta['siglip_text_length']}")


# Python packages of the catalogue pipeline: the GPU side (query encoding, retrieval, Vertex calls) and the CPU writer
# (PDF extraction, colour, parquet exports, Vertex calls). The GPU side repeats numpy<2 so no later layer upgrades the
# torch stack's numpy. The writer has no torch and needs numpy 2 (current pyarrow wheels refuse numpy 1.x); it keeps
# the GPU images' OpenCV pin, so catalogue colour vectors (writer) and query colour vectors (GPU) come from one build.
CATALOG_SEARCH_PACKAGES = (
    "numpy<2", "sentencepiece", "protobuf", "faiss-cpu>=1.8.0", "pandas", "google-genai>=1.52.0,<3.0.0",
    "google-auth>=2.29.0", "tenacity>=8.2.3", "requests>=2.31.0", "pydantic>=2",
)
CATALOG_WRITER_PACKAGES = (
    "numpy>=2,<3", "scipy", "pillow", "opencv-python-headless==4.10.0.84", "pymupdf>=1.24.10", "faiss-cpu>=1.8.0",
    "pandas", "pyarrow>=14.0.0", "google-genai>=1.52.0,<3.0.0", "google-auth>=2.29.0", "tenacity>=8.2.3",
    "requests>=2.31.0", "pydantic>=2",
)

# ONE image for the combined pool, stacked on _sam3_base (before _RUNTIME_ENV sets HF_HUB_OFFLINE=1) so Modal
# reuses its cached layers without blocking Hugging Face downloads during the subsequent bake steps. The catalogue
# layers come after the OneFormer bake, so adding them leaves every earlier cached layer as it was.
_vision_build = (
    _sam3_base
    .run_commands(_git_checkout("https://github.com/microsoft/MoGe.git", MOGE_COMMIT, MOGE_SRC))
    .uv_pip_install("matplotlib", UTILS3D_PIN)             # pandas is already in the SAM 3 layer
    .run_function(_bake_moge)
    .uv_pip_install("diffusers==0.42.0", TRANSFORMERS_PIN, "accelerate")
    .run_function(_bake_marigold_lighting)
    .run_function(_bake_oneformer)
)
if CATALOG_IN_VISION_ALL:
    _vision_build = (
        _vision_build
        .uv_pip_install(*CATALOG_SEARCH_PACKAGES)
        .run_function(_bake_catalog, secrets=[hf_secret], memory=16384)
    )
vision_image = _vision_build.env(_RUNTIME_ENV)

catalog_image = (
    _base
    .uv_pip_install(TRANSFORMERS_PIN, *CATALOG_SEARCH_PACKAGES)
    .run_function(_bake_catalog, secrets=[hf_secret], memory=16384)
    .env(_RUNTIME_ENV)
)

# The writer is CPU only (no torch): PyMuPDF, OpenCV, the SQLite store and the Vertex AI client.
writer_image = (
    modal.Image.debian_slim(python_version="3.12")
    .uv_pip_install(*CATALOG_WRITER_PACKAGES)
    .env({"OMP_NUM_THREADS": "4", "TOKENIZERS_PARALLELISM": "false"})
)


# =====================================================================================
# 3. SHARED RUNTIME: auth, errors, image I/O, GPU gate, timing
# =====================================================================================
class ApiError(Exception):
    def __init__(self, status: int, code: str, detail: str, headers: Optional[dict] = None):
        super().__init__(detail)
        self.status, self.code, self.detail, self.headers = status, code, detail, headers or {}

    def __reduce__(self):   # Modal pickles exceptions raised in another container (the writer) back to the caller
        return (type(self), (self.status, self.code, self.detail, self.headers))


def _load_api_keys() -> list:
    keys = [k.strip() for k in os.environ.get("API_KEYS", "").split(",") if k.strip()]
    if not keys:
        raise RuntimeError(f"Secret '{API_KEYS_SECRET}' must define API_KEYS. Refusing to start unauthenticated.")
    if any(len(k) < 16 for k in keys):
        raise RuntimeError("Every API key must be at least 16 characters.")
    return [hashlib.sha256(k.encode("utf-8")).digest() for k in keys]  # keep only hashes in memory


class SecurityMiddleware:
    """Pure ASGI: authenticates and size-checks BEFORE routing / multipart parsing, so an unauthenticated
    client can never make the server buffer or parse an upload. Supports several keys (rotation)."""

    def __init__(self, app, digests: list, max_body: int, large_bodies: Optional[dict] = None):
        self.app, self.digests, self.max_body = app, digests, max_body
        self.large_bodies = large_bodies or {}   # path suffix -> body limit (catalogue PDF uploads)

    def _limit(self, path: str) -> int:
        for suffix, limit in self.large_bodies.items():
            if path.endswith(suffix):
                return limit
        return self.max_body

    def _authorized(self, headers: dict) -> bool:
        auth, token = headers.get("authorization", ""), None
        if auth[:7].lower() == "bearer ":
            token = auth[7:].strip()
        elif headers.get("x-api-key"):
            token = headers["x-api-key"].strip()
        if not token:
            return False
        digest, ok = hashlib.sha256(token.encode("utf-8")).digest(), False
        for k in self.digests:                       # no early exit: constant time in the number of keys
            ok |= hmac.compare_digest(digest, k)
        return ok

    @staticmethod
    async def _reject(send, status: int, code: str, detail: str, extra: Optional[dict] = None):
        body = json.dumps({"error": code, "detail": detail}).encode()
        headers = [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())]
        headers += [(k.encode(), v.encode()) for k, v in (extra or {}).items()]
        await send({"type": "http.response.start", "status": status, "headers": headers})
        await send({"type": "http.response.body", "body": body})

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope["headers"]}
        if not self._authorized(headers):
            return await self._reject(send, 401, "unauthorized", "Missing or invalid API key.",
                                      {"www-authenticate": "Bearer"})
        cl = headers.get("content-length", "")
        limit = self._limit(scope.get("path", ""))
        if cl.isdigit() and int(cl) > limit:
            shown = MAX_UPLOAD_BYTES if limit == self.max_body else limit
            return await self._reject(send, 413, "payload_too_large", f"Upload exceeds {shown} bytes.")
        await self.app(scope, receive, send)


def gpu_rank(service: str, gpu_name: str) -> int:
    """Position of the GPU this container really got in the service's preference list: 0 = the first choice,
    1+ = Modal fell back (the owner-only dot shows that). -1 when the name matches nothing in the list."""
    import re
    prefs = SERVICES.get({"marigold-iid": "marigold"}.get(service, service), {}).get("gpu", [])
    name = (gpu_name or "").upper()
    for rank, pref in enumerate(prefs):
        # "A100-80GB" -> "A100", "H100!" -> "H100"; "L4" must not match inside "L40S", "A10" not inside "A100"
        token = re.escape(pref.split("-")[0].rstrip("!+").upper())
        if re.search(rf"(?<![A-Z0-9]){token}G?(?![A-Z0-9])", name):
            return rank
    return -1


class ContainerClock:
    """How long this container has been serving and how many requests it has answered, so a caller can tell a
    request that landed on a freshly started container (a cold start) from one that hit a warm container.
    Built inside the asgi_app factory, which Modal calls AFTER the snapshot and the @modal.enter(snap=False) hooks
    (modal/_runtime/user_code_imports.py: function_execution_context builds the web app inside lifecycle_context,
    once the snapshot step is behind it): a timestamp taken at import or in @modal.enter(snap=True) is frozen
    into the snapshot and would report a container that is hours old."""

    def __init__(self, gpu: str, rank: int = -1):
        self.gpu = (gpu or "unknown").encode("latin-1", "replace").decode("latin-1")
        self.rank = rank
        self.started = time.time()
        self.served = 0

    def touch(self) -> int:
        self.served += 1
        return self.served

    def age(self) -> float:
        return round(time.time() - self.started, 1)


class TelemetryMiddleware:
    """Pure ASGI, innermost (added before SecurityMiddleware, so only authenticated callers ever see it):
    stamps each response with the GPU type, which entry of the preference list it is (0 = first choice), the
    number of requests this container has served so far (1 = the first request on a fresh container) and
    the container's age in seconds."""

    def __init__(self, app, clock: ContainerClock):
        self.app, self.clock = app, clock

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        served = self.clock.touch()

        async def send_stamped(message):
            if message["type"] == "http.response.start":
                headers = list(message.get("headers", []))
                headers += [(b"x-gpu", self.clock.gpu.encode("latin-1")),
                            (b"x-gpu-rank", str(self.clock.rank).encode()),
                            (b"x-container-requests", str(served).encode()),
                            (b"x-container-age", str(self.clock.age()).encode())]
                message = {**message, "headers": headers}
            await send(message)

        await self.app(scope, receive, send_stamped)


class Stopwatch:
    def __init__(self):
        self._t0 = self._t = time.perf_counter()
        self.ms = {}

    def lap(self, name: str):
        now = time.perf_counter()
        self.ms[name] = round((now - self._t) * 1000, 1)
        self._t = now

    def reset(self):
        self._t = time.perf_counter()

    def finish(self):
        self.ms["total"] = round((time.perf_counter() - self._t0) * 1000, 1)

    def header(self) -> str:
        return ", ".join(f"{k};dur={v}" for k, v in self.ms.items())


# Container-wide GPU slots shared by the web routes (through GpuGate) and by plain Modal methods such as the
# catalogue writer's batch encoding, which run in worker threads outside the web app's event loop.
_GPU_THREAD_SLOTS = threading.BoundedSemaphore(GPU_SLOTS)


@contextlib.contextmanager
def gpu_exclusive():
    """Blocking (thread) side of the GPU slot: for Modal methods and sync code that run GPU work."""
    _GPU_THREAD_SLOTS.acquire()
    try:
        yield
    finally:
        _GPU_THREAD_SLOTS.release()


class GpuGate:
    """Serialises the GPU critical section inside one container and applies back-pressure."""

    def __init__(self, slots: int = GPU_SLOTS, timeout: float = QUEUE_TIMEOUT_S):
        self._sem, self._timeout = asyncio.Semaphore(slots), timeout
        self.waiting = self.active = 0

    @contextlib.asynccontextmanager
    async def slot(self):
        t0 = time.perf_counter()
        self.waiting += 1
        try:
            await asyncio.wait_for(self._sem.acquire(), self._timeout)
        except asyncio.TimeoutError:
            raise ApiError(503, "busy", "GPU queue wait exceeded; retry shortly.", {"Retry-After": "2"})
        finally:
            self.waiting -= 1
        # The thread-side slot is free unless a Modal method holds it. Poll with a non-blocking acquire instead of a
        # blocking one in a worker thread: a cancelled request can then never leave the slot taken.
        try:
            while not _GPU_THREAD_SLOTS.acquire(blocking=False):
                if time.perf_counter() - t0 > self._timeout:
                    raise ApiError(503, "busy", "GPU queue wait exceeded; retry shortly.", {"Retry-After": "2"})
                await asyncio.sleep(0.005)
        except BaseException:          # timeout or a cancelled request: give the asyncio slot back
            self._sem.release()
            raise
        self.active += 1
        try:
            yield time.perf_counter() - t0
        finally:
            self.active -= 1
            _GPU_THREAD_SLOTS.release()
            self._sem.release()


def release_cached_memory():
    """Called after warm-up, right before the snapshot is taken. Warm-up leaves the CUDA caching allocator holding
    free blocks and glibc holding freed host heap; both would otherwise be part of the snapshot, written once and
    read back on every restore. The first request after a restore re-allocates what it needs (a few ms)."""
    import ctypes
    import gc
    gc.collect()
    try:
        import torch
        if torch.cuda.is_available():
            torch.cuda.synchronize()
            torch.cuda.empty_cache()
    except Exception:
        logger.exception("could not release the CUDA cache")
    try:
        ctypes.CDLL("libc.so.6").malloc_trim(0)
    except Exception:
        pass


def decode_image(data: bytes, max_side: int):
    """bytes -> contiguous RGB uint8 array, EXIF-rotated, alpha-flattened, bomb-guarded, area-downscaled."""
    import cv2
    import numpy as np
    from PIL import Image, ImageOps, UnidentifiedImageError

    try:
        img = Image.open(io.BytesIO(data))
        w0, h0 = img.size
    except (UnidentifiedImageError, OSError, ValueError) as e:
        raise ApiError(400, "invalid_image", "Could not decode image (JPEG, PNG, WebP, BMP, TIFF).") from e
    if w0 * h0 > MAX_PIXELS:
        raise ApiError(413, "image_too_large", f"Image exceeds {MAX_PIXELS} pixels.")
    try:
        if img.getexif().get(0x0112, 1) in (5, 6, 7, 8):   # 90-degree EXIF rotations swap the axes
            w0, h0 = h0, w0
        if img.format == "JPEG" and max(w0, h0) >= 2 * max_side:   # DCT-domain downscale: 2-4x faster decode
            s = max_side / max(w0, h0)
            img.draft("RGB", (max(1, int(img.size[0] * s)), max(1, int(img.size[1] * s))))
        img = ImageOps.exif_transpose(img)
        if img.mode in ("I;16", "I;16L", "I;16B"):
            img = Image.fromarray((np.asarray(img, np.float32) / 257.0).clip(0, 255).astype(np.uint8))
        if img.mode in ("RGBA", "LA", "PA") or (img.mode == "P" and "transparency" in img.info):
            rgba = img.convert("RGBA")
            img = Image.new("RGB", rgba.size, (255, 255, 255))
            img.paste(rgba, mask=rgba.getchannel("A"))
        rgb = np.asarray(img.convert("RGB"))
    except (OSError, ValueError, SyntaxError) as e:
        raise ApiError(400, "invalid_image", "Image is corrupt or truncated.") from e
    h, w = rgb.shape[:2]
    if max(h, w) > max_side:
        s = max_side / max(h, w)
        rgb = cv2.resize(rgb, (max(1, round(w * s)), max(1, round(h * s))), interpolation=cv2.INTER_AREA)
    rgb = np.ascontiguousarray(rgb)
    meta = {"width": rgb.shape[1], "height": rgb.shape[0], "original_width": w0, "original_height": h0,
            "scale": round(rgb.shape[1] / w0, 6)}
    return rgb, meta


def encode_png(arr) -> bytes:
    import cv2
    if arr.ndim == 3 and arr.shape[2] == 3:
        arr = cv2.cvtColor(arr, cv2.COLOR_RGB2BGR)
    ok, buf = cv2.imencode(".png", arr, [cv2.IMWRITE_PNG_COMPRESSION, PNG_LEVEL])
    if not ok:
        raise RuntimeError("PNG encoding failed")
    return buf.tobytes()


def rle_encode(mask) -> dict:
    """COCO-style uncompressed RLE (column-major, starts with a run of zeros)."""
    import numpy as np
    flat = mask.T.reshape(-1).astype(np.int8)
    idx = np.flatnonzero(np.diff(flat)) + 1
    runs = np.diff(np.concatenate(([0], idx, [flat.size])))
    if flat.size and flat[0] == 1:
        runs = np.concatenate(([0], runs))
    return {"size": [int(mask.shape[0]), int(mask.shape[1])], "counts": runs.tolist()}


def synthetic_image(h: int = 480, w: int = 640):
    import numpy as np
    y, x = np.mgrid[0:h, 0:w]
    img = np.stack([x * 255 // w, y * 255 // h, (x + y) * 255 // (w + h)], -1).astype(np.uint8)
    img[h // 4: h // 2, w // 4: w // 2] = (220, 40, 40)
    return np.ascontiguousarray(img)


async def read_upload(file) -> bytes:
    data = await file.read(MAX_UPLOAD_BYTES + 1)
    if len(data) > MAX_UPLOAD_BYTES:
        raise ApiError(413, "payload_too_large", f"Upload exceeds {MAX_UPLOAD_BYTES} bytes.")
    if not data:
        raise ApiError(400, "empty_upload", "The 'image' file is empty.")
    return data


def _is_cuda_oom(exc: BaseException) -> bool:
    return type(exc).__name__ == "OutOfMemoryError" or "CUDA out of memory" in str(exc)


def make_base_app(service: str, gate: GpuGate, info: dict, large_bodies: Optional[dict] = None):
    from fastapi import FastAPI
    from fastapi.responses import JSONResponse

    api = FastAPI(title=f"vision-stack/{service}", docs_url=None, redoc_url=None, openapi_url=None)
    clock = ContainerClock(info.get("gpu", ""), gpu_rank(service, info.get("gpu", "")))
    # the last middleware added is the outermost: auth and the size check run first, telemetry only sees real calls
    api.add_middleware(TelemetryMiddleware, clock=clock)
    api.add_middleware(SecurityMiddleware, digests=_load_api_keys(), max_body=MAX_UPLOAD_BYTES + 1_048_576,
                       large_bodies=large_bodies)

    @api.exception_handler(ApiError)
    async def _api_error(request, exc: ApiError):
        return JSONResponse({"error": exc.code, "detail": exc.detail}, status_code=exc.status, headers=exc.headers)

    @api.exception_handler(Exception)
    async def _unhandled(request, exc: Exception):
        if _is_cuda_oom(exc):
            try:
                import torch
                torch.cuda.empty_cache()
            except Exception:
                pass
            logger.error("CUDA OOM on %s", service)
            return JSONResponse({"error": "gpu_oom", "detail": "GPU out of memory; retry with a smaller image."},
                                status_code=503, headers={"Retry-After": "2"})
        logger.exception("unhandled error in %s", service)
        return JSONResponse({"error": "internal_error", "detail": "Inference failed."}, status_code=500)

    @api.get("/healthz")
    async def healthz():
        """Cheap readiness: answering at all means the container is up AND its models are loaded (the app is only
        built after @modal.enter finished), so nothing here runs a model. Calling it on a scaled-to-zero pool boots
        the pool; the Swatchroom server does not do that on page load (it knows from its own traffic whether a pool
        is warm), only Settings > Check and the owner dashboard do."""
        return {"status": "ok", "ready": True, "service": service, "gpu_waiting": gate.waiting,
                "gpu_active": gate.active, "gpu_rank": clock.rank, "container_requests": clock.served,
                "container_age_s": clock.age(), **info}

    return api


# =====================================================================================
# 4. ENGINES  (pure torch logic, no web code; every method is safe to call from a worker thread)
#    NB: inference_mode / autocast are thread-local, so they are entered INSIDE each engine call.
# =====================================================================================
def _gpu_name() -> str:
    import torch
    return torch.cuda.get_device_name(0)


class MoGeEngine:
    def load(self):
        import torch
        from safetensors.torch import load_file

        sys.path.insert(0, MOGE_SRC)
        from moge.model.v2 import MoGeModel

        torch.backends.cuda.matmul.allow_tf32 = True
        torch.backends.cudnn.allow_tf32 = True
        d = f"{WEIGHTS}/moge2"
        with torch.device("cuda"):                       # allocate + init directly on the GPU
            model = MoGeModel(**torch.load(f"{d}/config.pt", weights_only=True))
        res = model.load_state_dict(load_file(f"{d}/model.safetensors", device="cuda"), strict=False)
        if res.missing_keys:
            raise RuntimeError(f"MoGe weights incomplete: {res.missing_keys[:10]}")
        self.model = model.to("cuda").eval().requires_grad_(False)
        logger.info("MoGe-2 loaded (%s) on %s", MOGE_REPO, _gpu_name())

    def warmup(self):
        import numpy as np
        import torch
        rng = np.random.default_rng(0)
        for h, w in ((480, 640), (720, 1280), (960, 720)):
            self.infer(rng.integers(0, 255, (h, w, 3), dtype=np.uint8), 9, None, True)
        torch.cuda.synchronize()

    def infer(self, rgb, resolution_level: int, fov_x: Optional[float], apply_mask: bool) -> dict:
        import torch
        with torch.inference_mode():
            x = torch.from_numpy(rgb).to("cuda").permute(2, 0, 1).float().div_(255.0)
            out = self.model.infer(x, resolution_level=resolution_level, fov_x=fov_x,
                                   apply_mask=apply_mask, use_fp16=True)   # fp16 autocast, fp32 post-processing
            return {k: v.detach().cpu().numpy() for k, v in out.items()}

    def info(self) -> dict:
        return {"model": MOGE_REPO, "gpu": _gpu_name()}

    def selftest(self) -> dict:
        t = time.perf_counter()
        out = self.infer(synthetic_image(), 9, None, True)
        return {"gpu": _gpu_name(), "ms": round((time.perf_counter() - t) * 1000, 1),
                "keys": {k: list(v.shape) for k, v in out.items()}}


class MarigoldEngine:
    def load(self, keys=None):
        """keys: which checkpoints to load (default: both). VisionAll passes ("lighting",)."""
        import diffusers
        import torch

        self.pipes = {}
        for key in (keys or MARIGOLD_REPOS):
            pipe = diffusers.MarigoldIntrinsicsPipeline.from_pretrained(
                f"{WEIGHTS}/marigold/{key}", variant="fp16", dtype=torch.float16,
                use_safetensors=True, local_files_only=True).to("cuda")
            pipe.unet.to(memory_format=torch.channels_last)   # same maths, faster fp16 convs on Ada/Ampere
            pipe.vae.to(memory_format=torch.channels_last)
            pipe.set_progress_bar_config(disable=True)
            self.pipes[key] = pipe
        logger.info("Marigold IID loaded: %s on %s", list(self.pipes), _gpu_name())

    def warmup(self):
        import numpy as np
        import torch
        rgb = np.random.default_rng(0).integers(0, 255, (384, 512, 3), dtype=np.uint8)
        for key in self.pipes:
            self.infer(key, rgb, None, 1, None, 0)
        torch.cuda.synchronize()

    def infer(self, key: str, rgb, steps: Optional[int], ensemble: int, resolution: Optional[int], seed: int):
        import torch
        from PIL import Image
        gen = torch.Generator(device="cuda").manual_seed(seed)   # per request -> reproducible under any load
        with torch.inference_mode():
            out = self.pipes[key](
                Image.fromarray(rgb), num_inference_steps=steps, ensemble_size=ensemble,
                processing_resolution=resolution, match_input_resolution=True,
                batch_size=min(ensemble, 4), generator=gen, output_type="np")
        return out.prediction                                      # (targets, H, W, 3) float32 in [0, 1]

    def render(self, key: str, prediction) -> dict:
        """CPU: raw prediction -> display-ready 8-bit images per named target (official Marigold visualiser)."""
        import numpy as np
        pipe = self.pipes[key]
        vis = pipe.image_processor.visualize_intrinsics(prediction, pipe.target_properties)[0]
        return {name: np.asarray(img) for name, img in vis.items()}

    def info(self) -> dict:
        return {"models": {k: {"targets": p.target_properties["target_names"], "default_steps": p.default_denoising_steps,
                               "default_resolution": p.default_processing_resolution}
                           for k, p in self.pipes.items()}, "gpu": _gpu_name()}

    def selftest(self) -> dict:
        res = {"gpu": _gpu_name()}
        for key in self.pipes:
            t = time.perf_counter()
            pred = self.infer(key, synthetic_image(384, 512), None, 1, None, 0)
            res[key] = {"ms": round((time.perf_counter() - t) * 1000, 1), "prediction": list(pred.shape),
                        "targets": list(self.render(key, pred))}
        return res


class Sam3Engine:
    def load(self):
        import torch
        from safetensors.torch import load_file

        sys.path.insert(0, SAM3_SRC)
        from sam3.model.sam3_image_processor import Sam3Processor
        from sam3.model_builder import build_sam3_image_model

        model = build_sam3_image_model(device="cuda", eval_mode=True, load_from_HF=False, checkpoint_path=None)
        res = model.load_state_dict(load_file(f"{WEIGHTS}/sam3/sam3_detector.safetensors", device="cuda"),
                                    strict=False)
        n = len(model.state_dict())
        if len(res.missing_keys) > 0.02 * n:
            raise RuntimeError(f"SAM 3 weights incomplete: {len(res.missing_keys)}/{n} missing")
        self.model = model.eval().requires_grad_(False)
        self.processor = Sam3Processor(self.model, device="cuda", confidence_threshold=0.5)
        logger.info("SAM 3 loaded on %s", _gpu_name())

    def warmup(self):
        import numpy as np
        import torch
        self.infer(np.random.default_rng(0).integers(0, 255, (480, 640, 3), dtype=np.uint8),
                   ["object"], None, 0.5, 10, True)
        torch.cuda.synchronize()

    def infer(self, rgb, prompts: list, boxes: Optional[list], threshold: float, max_instances: int,
              want_masks: bool) -> list:
        """One image encoder pass, then one cheap decoder pass per prompt (or one for all box prompts)."""
        import torch
        from PIL import Image
        results = []
        with torch.inference_mode(), torch.autocast("cuda", dtype=torch.bfloat16):   # official SAM 3 recipe
            proc = self.processor
            proc.confidence_threshold = float(threshold)    # shared object, safe: the GPU gate serialises calls
            state = proc.set_image(Image.fromarray(rgb))
            if boxes:
                if prompts:
                    state = proc.set_text_prompt(prompt=prompts[0], state=state)
                for b in boxes:
                    x0, y0, x1, y1 = b["box"]
                    state = proc.add_geometric_prompt(box=[(x0 + x1) / 2, (y0 + y1) / 2, x1 - x0, y1 - y0],
                                                      label=bool(b.get("positive", True)), state=state)
                results.append(self._collect(state, prompts[0] if prompts else "visual", max_instances, want_masks))
            else:
                for p in prompts:
                    state = proc.set_text_prompt(prompt=p, state=state)
                    results.append(self._collect(state, p, max_instances, want_masks))
        return results

    @staticmethod
    def _collect(state: dict, label: str, max_instances: int, want_masks: bool) -> dict:
        import torch
        scores = state["scores"].float()
        order = torch.argsort(scores, descending=True)[:max_instances]
        return {
            "prompt": label,
            "scores": scores[order].cpu().numpy(),
            "boxes": state["boxes"].float()[order].cpu().numpy(),                      # xyxy, pixels
            "masks": state["masks"][order, 0].cpu().numpy() if want_masks else None,   # (N, H, W) bool
        }

    def info(self) -> dict:
        return {"model": SAM3_REPO, "gpu": _gpu_name()}

    def selftest(self) -> dict:
        t = time.perf_counter()
        out = self.infer(synthetic_image(), ["red square"], None, 0.3, 10, True)
        return {"gpu": _gpu_name(), "ms": round((time.perf_counter() - t) * 1000, 1),
                "instances": [len(r["scores"]) for r in out]}


# ---- OneFormer: device-agnostic helpers (pure torch, CPU-testable) -------------------------------------------------
def oneformer_resize_hw(h: int, w: int, short: int, long: Optional[int]) -> tuple:
    """Output (height, width) of OneFormer's resize: short side -> `short`, long side capped at `long`, aspect kept
    (the rule of the HF OneFormer image processor, int-truncated like it)."""
    if w <= h:
        new_w = short
        new_h = int(short * h / w)
        if long and new_h > long:
            new_w = int(long * new_w / new_h)
            new_h = long
    else:
        new_h = short
        new_w = int(short * w / h)
        if long and new_w > long:
            new_h = int(long * new_h / new_w)
            new_w = long
    return max(1, new_h), max(1, new_w)


def oneformer_norm(meta: dict, device: str):
    """ImageNet mean / std on the 0-255 scale, shaped (1, 3, 1, 1): (x / 255 - m) / s == (x - 255 m) / (255 s)."""
    import torch
    scale = 1.0 / float(meta["rescale_factor"]) if meta.get("do_rescale", True) else 1.0
    mean = torch.tensor(meta["image_mean"], dtype=torch.float32, device=device).view(1, 3, 1, 1) * scale
    std = torch.tensor(meta["image_std"], dtype=torch.float32, device=device).view(1, 3, 1, 1) * scale
    return mean, std


def oneformer_pixels(rgb, hw: tuple, mean, std):
    """(H, W, 3) uint8 tensor -> (1, 3, h, w) normalised float32, resized with antialiased bilinear (what the HF
    processor's torchvision resize does)."""
    import torch.nn.functional as F
    x = rgb.permute(2, 0, 1).unsqueeze(0).float()
    if (x.shape[-2], x.shape[-1]) != tuple(hw):
        x = F.interpolate(x, size=tuple(hw), mode="bilinear", align_corners=False, antialias=True)
    return ((x - mean) / std).contiguous()


def _work_dtype(t):
    import torch
    return torch.float16 if t.is_cuda else torch.float32   # big upsampled maps: half the memory and traffic on GPU


def masks_to_input(mask_logits, pad_hw: tuple, proc_hw: tuple):
    """(N, h/4, w/4) query mask logits -> (N, h, w) logits on the resized image, in detectron2's order: upsample to
    the padded network input, then crop the padding off (no sub-pixel shift between masks and pixels)."""
    import torch.nn.functional as F
    x = F.interpolate(mask_logits[None].to(_work_dtype(mask_logits)), size=tuple(pad_hw),
                      mode="bilinear", align_corners=False)[0]
    return x[:, : proc_hw[0], : proc_hw[1]]


def resize_maps(x, out_hw: tuple):
    """(N, H, W) float maps -> (N, out_h, out_w), bilinear; no-op when the size already matches."""
    import torch.nn.functional as F
    if (x.shape[-2], x.shape[-1]) == tuple(out_hw):
        return x
    return F.interpolate(x[None], size=tuple(out_hw), mode="bilinear", align_corners=False)[0]


def semantic_scores(cls_logits, mask_logits, pad_hw: tuple, proc_hw: tuple):
    """OneFormer semantic inference: per-class score maps (C, h, w) = sum over queries of
    class probability (no-object column dropped) x mask probability."""
    import torch
    probs = cls_logits.float().softmax(-1)[:, :-1]
    masks = masks_to_input(mask_logits, pad_hw, proc_hw).sigmoid()
    return torch.einsum("qc,qhw->chw", probs.to(masks.dtype), masks)


def panoptic_inference(cls_logits, mask_logits, pad_hw: tuple, proc_hw: tuple, out_hw: tuple, thing_ids: set,
                       threshold: float, overlap: float):
    """OneFormer / Mask2Former panoptic inference (detectron2 reference), vectorised: two small GPU->CPU copies
    instead of four syncs per query. Returns an (H, W) int64 map of segment ids (0 = void) and the segment list.
    Stuff classes are merged into one segment per class; things keep one segment per query."""
    import numpy as np
    import torch
    num_classes = cls_logits.shape[-1] - 1
    scores, labels = cls_logits.float().softmax(-1).max(-1)
    keep = labels.ne(num_classes) & (scores > threshold)
    if not bool(keep.any()):
        return torch.zeros(tuple(out_hw), dtype=torch.int64, device=cls_logits.device), []
    scores = scores[keep]
    labels = labels[keep]
    probs = resize_maps(masks_to_input(mask_logits[keep], pad_hw, proc_hw), out_hw).sigmoid()
    winner = (scores.to(probs.dtype)[:, None, None] * probs).argmax(0)        # which query owns each pixel
    binary = probs >= 0.5
    count = scores.shape[0]
    covered = torch.gather(binary, 0, winner[None])[0]                         # the owner's own mask covers it
    stats = torch.stack([
        torch.bincount(winner.flatten(), minlength=count),                     # pixels the query won
        binary.flatten(1).sum(1),                                              # pixels of its own mask
        torch.bincount(winner[covered], minlength=count),                      # pixels it keeps
        labels,
    ]).cpu().numpy()
    score_values = scores.cpu().numpy()

    lookup = np.zeros(count, np.int64)
    segments = []
    stuff_segment = {}
    for q in range(count):
        won = int(stats[0, q])
        own = int(stats[1, q])
        kept = int(stats[2, q])
        label = int(stats[3, q])
        if won == 0 or own == 0 or kept == 0 or won / own < overlap:   # mostly hidden behind other masks: drop
            continue
        isthing = label in thing_ids
        if not isthing and label in stuff_segment:
            lookup[q] = stuff_segment[label]
            continue
        segments.append({"id": len(segments) + 1, "label_id": label, "isthing": isthing,
                         "score": round(float(score_values[q]), 5)})
        lookup[q] = len(segments)
        if not isthing:
            stuff_segment[label] = len(segments)
    lookup_t = torch.from_numpy(lookup).to(winner.device)
    segment_map = torch.where(covered, lookup_t[winner], torch.zeros_like(winner))
    return segment_map, segments


def label_boxes(label_map, n: int):
    """Box (x0, y0, x1, y1; pixel edges, end exclusive) and pixel area of every id 1..n of an (H, W) integer map,
    in one pass over the map."""
    import torch
    h, w = label_map.shape
    flat = label_map.reshape(-1).long()
    device = flat.device
    ys = torch.arange(h, device=device).repeat_interleave(w)
    xs = torch.arange(w, device=device).repeat(h)
    big = max(h, w)
    low = torch.full((n + 1,), big, dtype=torch.long, device=device)
    high = torch.full((n + 1,), -1, dtype=torch.long, device=device)
    x0 = low.scatter_reduce(0, flat, xs, reduce="amin")
    y0 = low.scatter_reduce(0, flat, ys, reduce="amin")
    x1 = high.scatter_reduce(0, flat, xs, reduce="amax") + 1
    y1 = high.scatter_reduce(0, flat, ys, reduce="amax") + 1
    boxes = torch.stack([x0, y0, x1, y1], 1)[1:]
    areas = torch.bincount(flat, minlength=n + 1)[1:]
    return boxes.cpu().numpy(), areas.cpu().numpy()


def instance_inference(cls_logits, mask_logits, pad_hw: tuple, proc_hw: tuple, out_hw: tuple, thing,
                       threshold: float, max_instances: int, want_masks: bool, topk: int = 100) -> dict:
    """OneFormer instance inference (detectron2 reference): top-100 (query, class) pairs, thing classes only,
    score = class probability x mean mask probability inside the mask. Masks may overlap."""
    import numpy as np
    import torch
    empty = {"scores": np.zeros(0, np.float32), "labels": np.zeros(0, np.int64), "boxes": np.zeros((0, 4), np.int64),
             "areas": np.zeros(0, np.int64), "masks": None}
    num_classes = cls_logits.shape[-1] - 1
    probs = cls_logits.float().softmax(-1)[:, :-1]
    scores, flat_index = probs.flatten().topk(min(topk, probs.numel()))
    labels = flat_index % num_classes
    queries = torch.div(flat_index, num_classes, rounding_mode="floor")
    keep = thing[labels] & (scores >= threshold)      # the final score never exceeds the class score: cut early
    scores = scores[keep]
    labels = labels[keep]
    queries = queries[keep]
    if scores.numel() == 0:
        return empty
    logits = resize_maps(masks_to_input(mask_logits[queries], pad_hw, proc_hw), out_hw)
    binary = logits > 0
    areas = binary.flatten(1).sum(1)
    mask_score = torch.sum(logits.sigmoid() * binary, dim=(1, 2), dtype=torch.float32) / (areas + 1e-6)
    final = scores * mask_score
    order = torch.argsort(final, descending=True)
    order = order[final[order] >= threshold][:max_instances]
    if order.numel() == 0:
        return empty
    binary = binary[order]
    height, width = binary.shape[-2], binary.shape[-1]
    rows = binary.any(2).float()
    cols = binary.any(1).float()
    boxes = torch.stack([cols.argmax(1), rows.argmax(1),
                         width - cols.flip(1).argmax(1), height - rows.flip(1).argmax(1)], 1)
    return {"scores": final[order].cpu().numpy(), "labels": labels[order].cpu().numpy(),
            "boxes": boxes.cpu().numpy(), "areas": areas[order].cpu().numpy(),
            "masks": binary.cpu().numpy() if want_masks else None}


class OneFormerEngine:
    def load(self):
        import torch
        from safetensors.torch import load_file
        from transformers import OneFormerConfig
        from transformers.models.oneformer.modeling_oneformer import OneFormerForUniversalSegmentation

        torch.backends.cuda.matmul.allow_tf32 = True
        torch.backends.cudnn.allow_tf32 = True
        d = f"{WEIGHTS}/oneformer"
        with open(f"{d}/meta.json", encoding="utf-8") as f:
            self.meta = json.load(f)
        config = OneFormerConfig.from_pretrained(d)
        with torch.device("cuda"):                       # allocate + init directly on the GPU
            model = OneFormerForUniversalSegmentation(config)
        res = model.load_state_dict(load_file(f"{d}/model.safetensors", device="cuda"), strict=False)
        missing = [k for k in res.missing_keys if not k.startswith(ONEFORMER_IGNORED_MISSING)]
        if missing:
            raise RuntimeError(f"OneFormer weights incomplete: {missing[:10]}")
        # .to("cuda") moves any parameter created via legacy torch.Tensor(...) (e.g. decoder.level_embed) to GPU
        self.model = model.to("cuda").eval().requires_grad_(False)
        tokens = load_file(f"{d}/task_inputs.safetensors", device="cuda")
        self.task_inputs = {task: tokens[task] for task in ONEFORMER_TASKS}       # (1, 77) float32 each
        self.class_names = self.meta["class_names"]
        self.num_classes = len(self.class_names)
        self.thing_ids = set(self.meta["thing_ids"])
        self.thing = torch.zeros(self.num_classes, dtype=torch.bool, device="cuda")
        self.thing[self.meta["thing_ids"]] = True
        self.mean, self.std = oneformer_norm(self.meta, "cuda")
        self.amp_dtype = {"fp16": torch.float16, "bf16": torch.bfloat16}.get(ONEFORMER_AMP)   # None = fp32
        self.split = self._check_split()
        logger.info("OneFormer loaded (%s, %s, shared backbone: %s) on %s",
                    ONEFORMER_REPO, ONEFORMER_AMP, self.split, _gpu_name())

    # -- model plumbing ------------------------------------------------------------------------------------------
    def _autocast(self, enabled: bool):
        import torch
        return torch.autocast("cuda", dtype=self.amp_dtype or torch.float16,
                              enabled=enabled and self.amp_dtype is not None)

    def _prepare(self, image, short: int, long: int, views: tuple):
        """GPU: resize + normalise once, stack the requested views (False = as is, True = mirrored), zero-pad to a
        multiple of 32 (detectron2's size divisibility; 0 is the mean colour after normalisation)."""
        import torch
        import torch.nn.functional as F
        hw = oneformer_resize_hw(image.shape[0], image.shape[1], short, long)
        base = oneformer_pixels(image, hw, self.mean, self.std)
        batch = []
        for mirrored in views:
            batch.append(base.flip(-1) if mirrored else base)
        x = torch.cat(batch) if len(batch) > 1 else batch[0]
        pad_hw = (((hw[0] + 31) // 32) * 32, ((hw[1] + 31) // 32) * 32)
        x = F.pad(x, (0, pad_hw[1] - hw[1], 0, pad_hw[0] - hw[0]))
        return x, hw, pad_hw

    def _forward(self, x, tasks: list, use_amp: bool = True):
        """-> class logits (B, Q, C+1) float32, mask logits (B, Q, H/4, W/4). With `split` the Swin-L backbone and
        the pixel decoder (most of the compute) run once and only the task-conditioned decoder runs per task."""
        import torch
        task_inputs = torch.cat([self.task_inputs[task] for task in tasks])
        with torch.inference_mode(), self._autocast(use_amp):
            if self.split:
                core = self.model.model
                pixel = core.pixel_level_module(x)
                features = list(pixel.decoder_features)
                mask_features = pixel.decoder_last_feature
                if x.shape[0] == 1 and len(tasks) > 1:
                    features = [f.expand(len(tasks), -1, -1, -1) for f in features]
                    mask_features = mask_features.expand(len(tasks), -1, -1, -1)
                task_token = core.task_encoder(task_inputs)
                out = core.transformer_module(multi_scale_features=features, mask_features=mask_features,
                                              task_token=task_token, output_attentions=False)
                class_logits = out.prediction_class.float()
                mask_logits = out.prediction_masks
            else:
                class_list, mask_list = [], []
                for index, task in enumerate(tasks):
                    xi = x if x.shape[0] == 1 else x[index:index + 1]
                    out = self.model(pixel_values=xi, task_inputs=self.task_inputs[task])
                    class_list.append(out.class_queries_logits.float())
                    mask_list.append(out.masks_queries_logits)
                class_logits = torch.cat(class_list)
                mask_logits = torch.cat(mask_list)
        if use_amp and self.amp_dtype is not None and not bool(torch.isfinite(class_logits).all()):
            logger.warning("non-finite logits under %s autocast; re-running this request in fp32", ONEFORMER_AMP)
            return self._forward(x, tasks, use_amp=False)
        return class_logits, mask_logits

    def _check_split(self) -> bool:
        """Use the shared-backbone path only if it reproduces the stock forward on this transformers version."""
        import torch
        core = getattr(self.model, "model", None)
        if core is None or not all(hasattr(core, n) for n in ("pixel_level_module", "task_encoder",
                                                              "transformer_module")):
            logger.warning("OneFormer internals not found; running the full forward once per task")
            return False
        x = torch.randn(1, 3, 512, 672, device="cuda", generator=torch.Generator("cuda").manual_seed(0))
        try:
            self.split = True
            split_cls, split_masks = self._forward(x, ["panoptic"])
            self.split = False
            full_cls, full_masks = self._forward(x, ["panoptic"])
        except Exception:
            logger.exception("shared-backbone path failed; running the full forward once per task")
            self.split = False
            return False
        cls_diff = (split_cls - full_cls).abs().max().item()
        mask_diff = (split_masks.float() - full_masks.float()).abs().max().item()
        ok = cls_diff < 0.05 and mask_diff < 0.25
        if not ok:
            logger.warning("shared-backbone path differs (cls %.4f, mask %.4f); using the full forward",
                           cls_diff, mask_diff)
        return ok

    # -- public API ----------------------------------------------------------------------------------------------
    def short_name(self, class_id: int) -> str:
        return self.class_names[class_id].split(",")[0].strip()

    def class_table(self) -> list:
        table = []
        for class_id, name in enumerate(self.class_names):
            table.append({"id": class_id, "label": self.short_name(class_id), "name": name.strip(),
                          "isthing": class_id in self.thing_ids})
        return table

    def infer(self, rgb, tasks: list, resolution: Optional[int], threshold: Optional[float], overlap: float,
              max_instances: int, want_masks: bool, tta: bool) -> dict:
        """rgb (H, W, 3) uint8 -> per task results at the image's own size, as numpy arrays + python lists."""
        import torch
        short = int(resolution or self.meta["shortest_edge"])
        long = int(round(self.meta["longest_edge"] * short / self.meta["shortest_edge"]))
        out_hw = (rgb.shape[0], rgb.shape[1])
        image = torch.from_numpy(rgb).to("cuda")
        x, proc_hw, pad_hw = self._prepare(image, short, long, (False,))
        class_logits, mask_logits = self._forward(x, tasks)
        results = {"processed_size": [proc_hw[1], proc_hw[0]]}
        with torch.inference_mode():
            for index, task in enumerate(tasks):
                if task == "semantic":
                    scores = semantic_scores(class_logits[index], mask_logits[index], pad_hw, proc_hw)
                    if tta:
                        scores = self._semantic_tta(image, short, long, scores, proc_hw)
                    labels = resize_maps(scores, out_hw).argmax(0)
                    results["semantic"] = {
                        "label_map": labels.to(torch.uint8).cpu().numpy(),
                        "counts": torch.bincount(labels.flatten(), minlength=self.num_classes).cpu().numpy(),
                    }
                elif task == "panoptic":
                    cut = 0.8 if threshold is None else threshold      # detectron2's OneFormer test setting
                    segment_map, segments = panoptic_inference(class_logits[index], mask_logits[index], pad_hw,
                                                               proc_hw, out_hw, self.thing_ids, cut, overlap)
                    boxes, areas = label_boxes(segment_map, len(segments))
                    for segment in segments:
                        segment["box"] = [int(v) for v in boxes[segment["id"] - 1]]
                        segment["area"] = int(areas[segment["id"] - 1])
                    results["panoptic"] = {"segment_map": segment_map.to(torch.uint8).cpu().numpy(),  # <= 250 ids
                                           "segments": segments}
                else:
                    cut = 0.5 if threshold is None else threshold
                    results["instance"] = instance_inference(class_logits[index], mask_logits[index], pad_hw,
                                                             proc_hw, out_hw, self.thing, cut, max_instances,
                                                             want_masks)
        return results

    def _semantic_tta(self, image, short: int, long: int, base, proc_hw: tuple):
        """Average the semantic score maps over ONEFORMER_TTA_SCALES x {as is, mirrored}; `base` is scale 1, as is."""
        import torch
        total = base.float()
        count = 1
        for scale in ONEFORMER_TTA_SCALES:
            views = (True,) if scale == 1.0 else (False, True)
            scaled_short = max(64, int(round(short * scale)))
            scaled_long = max(scaled_short + 1, int(round(long * scale)))
            x, hw, pad_hw = self._prepare(image, scaled_short, scaled_long, views)
            class_logits, mask_logits = self._forward(x, ["semantic"] * len(views))
            with torch.inference_mode():
                for index, mirrored in enumerate(views):
                    scores = semantic_scores(class_logits[index], mask_logits[index], pad_hw, hw)
                    if mirrored:
                        scores = scores.flip(-1)
                    total += resize_maps(scores, proc_hw).float()
                    count += 1
        return (total / count).to(base.dtype)

    def warmup(self):
        import numpy as np
        import torch
        rng = np.random.default_rng(0)
        runs = (((480, 640), list(ONEFORMER_TASKS)), ((720, 1280), ["semantic"]), ((1280, 960), ["panoptic"]))
        for (h, w), tasks in runs:
            self.infer(rng.integers(0, 255, (h, w, 3), dtype=np.uint8), tasks, None, None, 0.8, 100, True, False)
        torch.cuda.synchronize()

    def info(self) -> dict:
        return {"model": ONEFORMER_REPO, "revision": ONEFORMER_REV, "gpu": _gpu_name(), "precision": ONEFORMER_AMP,
                "shared_backbone": self.split, "classes": self.num_classes,
                "default_resolution": self.meta["shortest_edge"]}

    def selftest(self) -> dict:
        import numpy as np
        path = f"{WEIGHTS}/oneformer/demo.jpg"
        if os.path.exists(path):
            with open(path, "rb") as f:
                rgb, _ = decode_image(f.read(), 2048)
            source = "ADE20K demo image"
        else:
            rgb, source = synthetic_image(), "synthetic"
        t = time.perf_counter()
        res = self.infer(rgb, list(ONEFORMER_TASKS), None, None, 0.8, 100, False, False)
        ms = round((time.perf_counter() - t) * 1000, 1)
        counts = res["semantic"]["counts"]
        top = [self.short_name(int(i)) for i in np.argsort(counts)[::-1][:5] if counts[i] > 0]
        return {"gpu": _gpu_name(), "ms_all_three_tasks": ms, "image": source, "size": [rgb.shape[1], rgb.shape[0]],
                "top_semantic_classes": top, "panoptic_segments": len(res["panoptic"]["segments"]),
                "instances": int(len(res["instance"]["scores"])), "shared_backbone": self.split}


# =====================================================================================
# 4b. CATALOGUE ENGINE + PIPELINE  (the Terucon catalogue notebook, ported to Modal)
#     Same maths and defaults as the notebook, so vectors and feature versions stay comparable with its Kaggle run.
#     Heavy imports live inside functions: every image imports this file, and so does your laptop at deploy time.
# =====================================================================================
LOGGER = logging.getLogger("vision_stack.catalog")

CATALOG_NAME_PATTERN = r"[a-z0-9][a-z0-9_-]{0,62}"
SAFE_ID_PATTERN = r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}"          # item ids, render ids, job ids in URLs
DEFAULT_PHOTO_WEIGHTS = {"dino": 0.35, "mm": 0.25, "color": 0.25, "text": 0.15}
DEFAULT_TEXT_WEIGHTS = {"text": 0.60, "mm": 0.40}
DEFAULT_DIRECTION_WEIGHTS = {"below": 1.0, "inside": 0.9, "above": 1.15, "side": 1.4}
LOCAL_PILLARS = ("dino", "siglip", "color")
PILLAR_GROUPS = {"dino": "dino", "siglip": "mm", "vertex_mm": "mm", "color": "color", "text": "text"}
WEIGHT_GROUPS = ("dino", "mm", "color", "text")
ID_STRIP_CHARACTERS = " \t\r\n:;,.()[]{}<>\"'|*#•·"
SUPPORTED_ASPECT_RATIOS = ("1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9")
DEFAULT_RENDER_OBJECTS = {
    "textile_fabric": "a modern lounge armchair with tight upholstery and a loose seat cushion",
    "leather": "a mid-century lounge chair upholstered in this leather",
    "carpet_rug": "a large rectangular area rug in a bright living room",
    "wood_veneer": "a run of flat-panel kitchen cabinet doors",
    "solid_wood": "a dining table top with a softly eased edge",
    "laminate": "a run of flat-panel kitchen cabinet doors",
    "stone": "a kitchen island with a waterfall countertop",
    "ceramic_tile": "a bathroom feature wall laid with these tiles",
    "metal": "a wall-mounted range hood and a cabinet pull",
    "glass": "a glass shower partition",
    "wallcovering_paper": "a living-room feature wall",
}
DEFAULT_SCENE_TARGET = ("the most prominent large surface that would plausibly be made of this material "
                        "(for example upholstery, cabinet fronts, a countertop, a wall or the floor)")
# PyMuPDF is not thread-safe; the writer runs several jobs in threads, so every PyMuPDF call holds this lock.
_PYMUPDF_LOCK = threading.RLock()


# ---- small utilities ---------------------------------------------------------------------------------------------
def _fitz():
    try:
        import pymupdf as fitz   # PyMuPDF >= 1.24.3 (the legacy 'fitz' name is deprecated in 2.x)
    except ImportError:
        import fitz
    return fitz


def utc_now_iso() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path, chunk_size: int = 1 << 20) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        while True:
            chunk = handle.read(chunk_size)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def replace_file(source, destination):
    """os.replace, falling back to copy + delete where the filesystem cannot rename."""
    try:
        os.replace(source, destination)
    except OSError:
        import shutil
        shutil.copyfile(source, destination)
        with contextlib.suppress(OSError):
            os.remove(source)


def atomic_write_bytes(path, data: bytes):
    """Write to a temp file then rename, so a crash never leaves a half-written file under the real name."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = path.with_name(path.name + ".tmp")
    with open(temporary_path, "wb") as handle:
        handle.write(data)
        handle.flush()
        os.fsync(handle.fileno())
    replace_file(temporary_path, path)


def copy_into_place(source, destination):
    import shutil
    destination = Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = destination.with_name(destination.name + ".tmp")
    shutil.copyfile(source, temporary_path)
    replace_file(temporary_path, destination)


def file_signature(path) -> Optional[tuple]:
    try:
        stat = os.stat(path)
    except OSError:
        return None
    return (stat.st_size, stat.st_mtime_ns)


def chunked(sequence, size: int):
    for start in range(0, len(sequence), size):
        yield sequence[start:start + size]


def l2_normalize_rows(matrix):
    import numpy as np
    matrix = np.asarray(matrix, dtype=np.float32)
    if matrix.ndim == 1:
        norm = float(np.linalg.norm(matrix))
        return matrix / max(norm, 1e-12)
    norms = np.linalg.norm(matrix, axis=1, keepdims=True)
    return matrix / np.maximum(norms, 1e-12)


def load_rgb(source):
    """A path / bytes / PIL image / ndarray -> an EXIF-corrected uint8 RGB array."""
    import numpy as np
    from PIL import Image, ImageOps
    if isinstance(source, np.ndarray):
        array = source
        if array.ndim == 2:
            array = np.stack([array, array, array], axis=2)
        if array.shape[2] == 4:
            array = array[:, :, :3]
        return np.ascontiguousarray(array.astype(np.uint8))
    if isinstance(source, Image.Image):
        return np.asarray(ImageOps.exif_transpose(source).convert("RGB")).copy()
    if isinstance(source, (bytes, bytearray)):
        with Image.open(io.BytesIO(source)) as image:
            return np.asarray(ImageOps.exif_transpose(image).convert("RGB")).copy()
    with Image.open(source) as image:
        return np.asarray(ImageOps.exif_transpose(image).convert("RGB")).copy()


def resize_max_side(rgb, max_side: int):
    import cv2
    height, width = rgb.shape[:2]
    longest = max(height, width)
    if longest <= max_side:
        return rgb
    scale = max_side / float(longest)
    new_size = (max(1, int(round(width * scale))), max(1, int(round(height * scale))))
    return cv2.resize(rgb, new_size, interpolation=cv2.INTER_AREA)


def encode_rgb(rgb, image_format: str = "png", jpeg_quality: int = 95) -> bytes:
    from PIL import Image
    buffer = io.BytesIO()
    image = Image.fromarray(rgb)
    if image_format.lower() in ("jpg", "jpeg"):
        image.save(buffer, format="JPEG", quality=jpeg_quality, subsampling=0)
    else:
        image.save(buffer, format="PNG", compress_level=6)
    return buffer.getvalue()


def json_safe(value):
    """numpy / pandas values -> plain JSON types (NaN, inf and NA -> None)."""
    import math
    if value is None or isinstance(value, (str, bool)):
        return value
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        if math.isnan(value) or math.isinf(value):
            return None
        return value
    if isinstance(value, dict):
        cleaned = {}
        for key, item in value.items():
            cleaned[str(key)] = json_safe(item)
        return cleaned
    if isinstance(value, (list, tuple, set)):
        return [json_safe(item) for item in value]
    try:
        import numpy as np
        if isinstance(value, np.ndarray):
            return json_safe(value.tolist())
        if isinstance(value, np.generic):
            return json_safe(value.item())
    except ImportError:
        pass
    try:
        import pandas as pd
        if value is pd.NA or value is pd.NaT:
            return None
    except ImportError:
        pass
    return str(value)


def tensor_from_model_output(output):
    """transformers returns a tensor or a ModelOutput depending on the version; take the embedding either way."""
    import torch
    if isinstance(output, torch.Tensor):
        return output
    for attribute in ("text_embeds", "image_embeds", "pooler_output"):
        value = getattr(output, attribute, None)
        if isinstance(value, torch.Tensor):
            return value
    return output[0]


def validate_catalog_name(name) -> str:
    import re
    text = str(name or "").strip().lower()
    if not re.fullmatch(CATALOG_NAME_PATTERN, text):
        raise ApiError(422, "invalid_catalog", "catalog must be 1-63 characters of a-z, 0-9, '-' or '_', "
                                               "starting with a letter or digit.")
    return text


def validate_safe_id(value, what: str) -> str:
    import re
    text = str(value or "").strip()
    if not re.fullmatch(SAFE_ID_PATTERN, text) or ".." in text:
        raise ApiError(422, f"invalid_{what}", f"{what} contains characters that are not allowed.")
    return text


def safe_pdf_filename(name) -> str:
    """A client-supplied file name -> a plain 'name.pdf' inside pdfs/ (no folders, no traversal)."""
    import re
    base = os.path.basename(str(name or "").replace("\\", "/")).strip()
    base = re.sub(r"[^A-Za-z0-9 ._()-]+", "_", base).strip(" ._") or "catalogue"
    if not base.lower().endswith(".pdf"):
        base += ".pdf"
    return base[-180:]


def safe_name(text: str, limit: int = 60) -> str:
    import re
    return re.sub(r"[^A-Za-z0-9._-]+", "_", text)[:limit].strip("_") or "pdf"


# ---- configuration -----------------------------------------------------------------------------------------------
@dataclass
class CatalogConfig:
    """The notebook's PipelineConfig with the same defaults (they are part of the feature versions), and the Kaggle
    paths replaced by one catalogue folder on the Modal Volume."""
    catalog: str = DEFAULT_CATALOG
    data_root: str = DATA_ROOT

    # ---------------- Hardware ----------------
    num_workers: int = 4                      # CPU threads preparing crops in the writer
    feature_batch_size: int = CATALOG_GPU_BATCH

    # ---------------- PDF extraction ----------------
    min_image_side_pt: float = 36.0           # ignore images smaller than 0.5 inch
    min_image_area_fraction: float = 0.004    # ...or smaller than 0.4 % of the page
    repeated_image_page_fraction: float = 0.5  # same xref on >= 50 % of pages -> logo/background
    merge_tolerance_pt: float = 1.5           # stitch image strips that touch; 0 disables
    flattened_page_area_fraction: float = 0.85
    enable_raster_segmentation_fallback: bool = True
    segmentation_dpi: int = 110
    segmentation_background_threshold: int = 28
    min_render_dpi: int = 200
    max_render_dpi: int = 600
    crop_max_side_px: int = 1536
    crop_image_format: str = "png"
    inpaint_overlay_text: bool = True
    inpaint_max_area_fraction: float = 0.12
    product_id_regex: str = r"[A-Za-z0-9][A-Za-z0-9\-_/\.]{2,31}"
    product_id_label_prefix_regex: str = r"^(?:SKU|CODE|DESIGN\s*NO|DESIGN|REF|ART|ITEM|CAT|NO|ID)[\s\.:#\-]+"
    min_numeric_id_length: int = 4
    reject_year_like_ids: bool = True
    uppercase_product_ids: bool = True
    id_stopwords: Tuple[str, ...] = ("PAGE", "WWW", "HTTP", "HTTPS", "TEL", "FAX", "EMAIL")
    direction_weights: Dict[str, float] = field(default_factory=lambda: dict(DEFAULT_DIRECTION_WEIGHTS))
    alignment_penalty: float = 2.0
    max_match_cost: float = 0.35              # normalised by page diagonal
    allow_shared_ids: bool = True             # multi-view products: 2 photos, 1 code
    shared_id_cost_factor: float = 0.6
    page_max_attempts: int = 3

    # ---------------- Pillar 1: DINOv2 ----------------
    dino_model_name: str = DINO_REPO
    dino_input_size: int = 448                # multiple of 14 -> 32x32 patch grid for micro-texture
    dino_resize_short_side: int = 512
    dino_block_weights: Tuple[float, float, float] = (0.5, 0.25, 0.25)  # CLS, patch-mean, patch-std

    # ---------------- Pillar 2: SigLIP + Vertex multimodal + CIELAB ----------------
    siglip_model_name: str = SIGLIP_REPO
    siglip_text_template: str = "a close-up photo of {} material texture"
    neural_clahe_clip_limit: float = 1.5      # same CLAHE on catalogue and query inputs; 0 disables
    neural_clahe_grid: int = 8
    color_bins: Tuple[int, int, int] = (6, 8, 8)   # coarse L* (lighting-sensitive), finer a*/b*
    color_ab_range: float = 80.0
    color_clahe_clip_limit: float = 2.0
    color_clahe_grid: int = 8
    color_hist_sigma: float = 0.6
    color_hist_weight: float = 0.8
    color_max_side_px: int = 384
    color_kmeans_k: int = 3
    enable_vertex_multimodal_embedding: bool = True
    vertex_mm_model: str = "multimodalembedding@001"
    vertex_mm_dimension: int = 1408
    vertex_mm_concurrency: int = 6
    vertex_mm_text_max_chars: int = 200

    # ---------------- Pillar 3: Gemini synthesis ----------------
    gemini_location: str = "global"
    embedding_location: str = "us-central1"
    caption_model_candidates: Tuple[str, ...] = ("gemini-2.5-flash", "gemini-3.5-flash", "gemini-3-flash-preview")
    caption_temperature: float = 0.2
    caption_max_output_tokens: int = 4096
    caption_thinking_budget: Optional[int] = 0  # applied to gemini-2.5-* only
    caption_image_max_side_px: int = 1024
    caption_concurrency: int = 8
    checkpoint_every: int = 25
    max_caption_attempts: int = 4
    max_feature_attempts: int = 3
    text_embedding_model: str = "gemini-embedding-001"
    text_embedding_dim: int = 768
    text_embedding_concurrency: int = 8

    # ---------------- Nano Banana rendering ----------------
    image_model_candidates: Tuple[str, ...] = (
        "gemini-nano-banana-2.1",       # Nano Banana 2.1, GA 2026-10-06
        "gemini-3-pro-image",           # Nano Banana Pro
        "gemini-3-pro-image-preview",
        "gemini-2.5-flash-image",       # original Nano Banana
    )
    render_image_size: str = "2K"
    render_swatch_max_side_px: int = 2048
    render_scene_max_side_px: int = 2048

    # ---------------- Retry / quota ----------------
    request_timeout_s: float = 180.0
    retry_max_attempts: int = 8
    retry_initial_wait_s: float = 2.0
    retry_max_wait_s: float = 90.0
    rate_limit_cooldown_s: float = 20.0

    # ---------------- Retrieval ----------------
    fusion_mode: str = "hybrid"               # "rrf" | "linear" | "hybrid"
    rrf_k: int = 60
    hybrid_lambda: float = 0.5                # weight of RRF inside the hybrid score
    photo_weights: Dict[str, float] = field(default_factory=lambda: dict(DEFAULT_PHOTO_WEIGHTS))
    text_weights: Dict[str, float] = field(default_factory=lambda: dict(DEFAULT_TEXT_WEIGHTS))
    candidate_pool_size: int = 300
    exhaustive_search_max_items: int = 50000  # below this, every item is scored exactly
    faiss_index_type: str = "flat"            # "flat" | "hnsw"
    hnsw_m: int = 32
    top_k: int = 10
    describe_query_photo: bool = True
    query_center_crop_fraction: float = 0.8
    rectify_min_area_fraction: float = 0.2
    query_tta_hflip: bool = True
    dedupe_results_by_product: bool = True

    # ---------------- Paths: one folder per catalogue on the Volume ----------------
    @property
    def work_dir(self) -> Path:
        return Path(self.data_root) / "catalogs" / self.catalog

    @property
    def pdf_dir(self) -> Path:
        return self.work_dir / "pdfs"

    @property
    def crops_dir(self) -> Path:
        return self.work_dir / "crops"

    @property
    def index_dir(self) -> Path:
        return self.work_dir / "index"

    @property
    def renders_dir(self) -> Path:
        return self.work_dir / "renders"

    @property
    def backtrace_dir(self) -> Path:
        return self.work_dir / "backtrace"

    @property
    def state_db_path(self) -> Path:          # the PUBLISHED snapshot; the writer's live database is on local disk
        return self.work_dir / "state.sqlite"

    @property
    def manifest_path(self) -> Path:
        return self.work_dir / "manifest.parquet"

    @property
    def page_audit_path(self) -> Path:
        return self.work_dir / "page_audit.parquet"

    @property
    def published_path(self) -> Path:
        return self.work_dir / "published.json"

    def ensure_dirs(self):
        for directory in (self.work_dir, self.pdf_dir, self.crops_dir, self.index_dir, self.renders_dir,
                          self.backtrace_dir):
            directory.mkdir(parents=True, exist_ok=True)

    def relative(self, path) -> str:
        """A path under the catalogue folder -> the portable relative form stored in state.sqlite."""
        path = Path(path)
        try:
            return path.relative_to(self.work_dir).as_posix()
        except ValueError:
            return str(path)

    def resolve(self, stored) -> Optional[Path]:
        """A path stored in state.sqlite -> a path on this filesystem. Relative paths are relative to the catalogue
        folder. Absolute paths written by another machine (the notebook's /kaggle/working/...) are remapped by their
        crops/ renders/ backtrace/ index/ tail, and PDFs by file name under pdfs/."""
        if stored is None:
            return None
        path = Path(str(stored))
        if not path.is_absolute():
            return self.work_dir / path
        try:
            path.relative_to(self.work_dir)
            return path
        except ValueError:
            pass
        parts = path.parts
        for anchor in ("crops", "renders", "backtrace", "index"):
            if anchor in parts:
                position = len(parts) - 1 - list(reversed(parts)).index(anchor)
                return self.work_dir.joinpath(*parts[position:])
        if path.suffix.lower() == ".pdf":
            return self.pdf_dir / path.name
        return path


# ---- colour pillar (CPU) -----------------------------------------------------------------------------------------
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
    vector: Any
    dominant_hex: List[str]
    proportions: List[float]
    dominant_lab: List[List[float]]


def apply_clahe_rgb(rgb, clip_limit: float, grid_size: int):
    """Equalise local contrast on L* only, so lighting changes but hue/chroma do not."""
    import cv2
    lab = cv2.cvtColor(rgb, cv2.COLOR_RGB2LAB)
    lightness, channel_a, channel_b = cv2.split(lab)
    clahe = cv2.createCLAHE(clipLimit=float(clip_limit), tileGridSize=(int(grid_size), int(grid_size)))
    equalised = cv2.merge([clahe.apply(lightness), channel_a, channel_b])
    return cv2.cvtColor(equalised, cv2.COLOR_LAB2RGB)


def rgb_to_hex(rgb_triplet) -> str:
    red, green, blue = (int(round(float(value))) for value in rgb_triplet)
    return f"#{max(0, min(255, red)):02X}{max(0, min(255, green)):02X}{max(0, min(255, blue)):02X}"


def compute_lab_color_descriptor(rgb, params: ColorParams) -> ColorDescriptor:
    """Illumination-normalised CIELAB 3-D histogram (Hellinger) + top-k dominant colours, L2-normalised.
    Cosine on sqrt-histograms equals the Bhattacharyya coefficient, a proper histogram similarity."""
    import math

    import cv2
    import numpy as np
    from scipy.ndimage import gaussian_filter

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
    cv2.setRNGSeed(12345)   # OpenCV's RNG is per thread, so this is deterministic in the writer's thread pool too
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


# ---- network inputs (CPU) ----------------------------------------------------------------------------------------
def catalog_neural_inputs(rgb, cfg) -> tuple:
    """RGB crop -> (DINOv2 uint8 448x448x3, SigLIP uint8 384x384x3), pixel-identical to the notebook's torchvision
    pipeline: CLAHE on L*, then Resize(short side 512, bicubic) + CenterCrop(448) for DINOv2 and Resize((384, 384),
    bicubic) for SigLIP. Plain PIL so the CPU-only writer can run it; ToTensor / Normalize happen on the GPU."""
    import numpy as np
    from PIL import Image

    if cfg.neural_clahe_clip_limit > 0:
        rgb = apply_clahe_rgb(rgb, cfg.neural_clahe_clip_limit, cfg.neural_clahe_grid)
    image = Image.fromarray(rgb)
    width, height = image.size

    # torchvision Resize(int): the short side becomes `size`, the long side int(size * long / short)
    if width <= height:
        new_width = cfg.dino_resize_short_side
        new_height = int(cfg.dino_resize_short_side * height / width)
    else:
        new_height = cfg.dino_resize_short_side
        new_width = int(cfg.dino_resize_short_side * width / height)
    if (new_width, new_height) != (width, height):
        dino_image = image.resize((new_width, new_height), Image.BICUBIC)
    else:
        dino_image = image
    crop = cfg.dino_input_size
    top = int(round((new_height - crop) / 2.0))     # torchvision CenterCrop rounding
    left = int(round((new_width - crop) / 2.0))
    dino_image = dino_image.crop((left, top, left + crop, top + crop))

    meta = CATALOG_PREPROCESSING
    siglip_size = (int(meta["siglip_width"]), int(meta["siglip_height"]))
    if siglip_size != (width, height):
        siglip_image = image.resize(siglip_size, Image.BICUBIC)
    else:
        siglip_image = image
    return (np.ascontiguousarray(np.asarray(dino_image, dtype=np.uint8)),
            np.ascontiguousarray(np.asarray(siglip_image, dtype=np.uint8)))


# Preprocessing constants of the two checkpoints (the bake records them in /weights/catalog/meta.json too, and the
# engine checks they agree). They are needed by the CPU writer, which has no weights.
CATALOG_PREPROCESSING = {
    "dino_mean": [0.485, 0.456, 0.406], "dino_std": [0.229, 0.224, 0.225],
    "siglip_mean": [0.5, 0.5, 0.5], "siglip_std": [0.5, 0.5, 0.5], "siglip_height": 384, "siglip_width": 384,
}


# ---- the GPU engine ----------------------------------------------------------------------------------------------
class CatalogEngine:
    """DINOv2-large (texture: [CLS] + patch-token mean + std, 3072-d) and SigLIP so400m (semantic image AND text,
    1152-d), both fp16 with fp16 autocast like the notebook's T4 run. Inputs are the uint8 arrays from
    catalog_neural_inputs; ToTensor + Normalize run here, on the GPU."""

    def __init__(self, device: str = "cuda"):
        self.device = device

    def load(self, weights_dir: str = CATALOG_WEIGHTS, cfg: Optional[CatalogConfig] = None):
        import math

        import torch
        from transformers import AutoModel, AutoTokenizer

        cfg = cfg or CatalogConfig()
        self.cfg = cfg
        with open(f"{weights_dir}/meta.json", encoding="utf-8") as f:
            self.meta = json.load(f)
        for key, expected in CATALOG_PREPROCESSING.items():
            if self.meta.get(key) != expected:
                raise RuntimeError(f"checkpoint preprocessing {key}={self.meta.get(key)} differs from "
                                   f"CATALOG_PREPROCESSING ({expected}); update the constant")
        if self.device == "cuda":
            torch.backends.cuda.matmul.allow_tf32 = True
            torch.backends.cudnn.allow_tf32 = True
            self.dtype = torch.float16
        else:
            self.dtype = torch.float32
        dino = AutoModel.from_pretrained(f"{weights_dir}/dinov2", dtype=self.dtype)
        siglip = AutoModel.from_pretrained(f"{weights_dir}/siglip", dtype=self.dtype)
        self.dino = dino.to(self.device).eval().requires_grad_(False)
        self.siglip = siglip.to(self.device).eval().requires_grad_(False)
        self.tokenizer = AutoTokenizer.from_pretrained(f"{weights_dir}/siglip")
        self.text_length = int(self.meta.get("siglip_text_length", 64))
        self.num_register_tokens = int(getattr(self.dino.config, "num_register_tokens", 0) or 0)
        weight_total = float(sum(cfg.dino_block_weights))
        self.block_scales = [math.sqrt(float(weight) / weight_total) for weight in cfg.dino_block_weights]

        def stats(name):
            return torch.tensor(self.meta[name], dtype=torch.float32, device=self.device).view(1, 3, 1, 1)

        self.dino_mean, self.dino_std = stats("dino_mean"), stats("dino_std")
        self.siglip_mean, self.siglip_std = stats("siglip_mean"), stats("siglip_std")
        logger.info("catalogue engine loaded (%s + %s, %s) on %s", DINO_REPO, SIGLIP_REPO, self.dtype,
                    self._device_name())

    def _device_name(self) -> str:
        if self.device == "cuda":
            return _gpu_name()
        return "cpu"

    def _autocast(self):
        import torch
        return torch.autocast("cuda", dtype=torch.float16, enabled=self.device == "cuda")

    def _pixels(self, batch, mean, std):
        import numpy as np
        import torch
        x = torch.from_numpy(np.ascontiguousarray(np.stack(batch))).to(self.device)
        x = x.permute(0, 3, 1, 2).float().div_(255.0)      # ToTensor
        x = (x - mean) / std                                # Normalize (fp32, then cast like the notebook)
        return x.to(self.dtype).contiguous()

    def _dino(self, x):
        import torch
        import torch.nn.functional as F
        with self._autocast():
            outputs = self.dino(pixel_values=x)
        hidden = outputs.last_hidden_state.float()
        cls_token = hidden[:, 0]
        patch_tokens = hidden[:, 1 + self.num_register_tokens:]
        blocks = [F.normalize(cls_token, dim=-1) * self.block_scales[0],
                  F.normalize(patch_tokens.mean(dim=1), dim=-1) * self.block_scales[1],
                  F.normalize(patch_tokens.std(dim=1, unbiased=False), dim=-1) * self.block_scales[2]]
        return F.normalize(torch.cat(blocks, dim=-1), dim=-1)

    def _siglip(self, x):
        import torch.nn.functional as F
        with self._autocast():
            outputs = self.siglip.vision_model(pixel_values=x)
        return F.normalize(outputs.pooler_output.float(), dim=-1)

    def encode_prepared(self, dino_batch, siglip_batch, tta_hflip: bool = False) -> tuple:
        """Lists (or arrays) of uint8 HxWx3 images -> L2-normalised float32 (N, 3072) DINOv2 and (N, 1152) SigLIP
        vectors. tta_hflip adds each image's mirror and re-normalises (the notebook's query-side TTA)."""
        import numpy as np
        import torch
        import torch.nn.functional as F
        if len(dino_batch) != len(siglip_batch):
            raise ValueError("dino_batch and siglip_batch must have the same length")
        dino_parts = []
        siglip_parts = []
        with torch.inference_mode():
            for start in range(0, len(dino_batch), CATALOG_GPU_BATCH):
                dino_x = self._pixels(list(dino_batch[start:start + CATALOG_GPU_BATCH]), self.dino_mean,
                                      self.dino_std)
                siglip_x = self._pixels(list(siglip_batch[start:start + CATALOG_GPU_BATCH]), self.siglip_mean,
                                        self.siglip_std)
                dino_vectors = self._dino(dino_x)
                siglip_vectors = self._siglip(siglip_x)
                if tta_hflip:
                    dino_vectors = F.normalize(dino_vectors + self._dino(torch.flip(dino_x, dims=[3])), dim=-1)
                    siglip_vectors = F.normalize(siglip_vectors + self._siglip(torch.flip(siglip_x, dims=[3])),
                                                 dim=-1)
                dino_parts.append(dino_vectors.float().cpu().numpy())
                siglip_parts.append(siglip_vectors.float().cpu().numpy())
        if not dino_parts:
            return np.zeros((0, 0), np.float32), np.zeros((0, 0), np.float32)
        return np.concatenate(dino_parts), np.concatenate(siglip_parts)

    def encode_text(self, texts: list, template: str = "{}"):
        """SigLIP text vectors (N, 1152). SigLIP was trained with max_length padding; other padding silently
        degrades text embeddings."""
        import torch
        import torch.nn.functional as F
        prompts = [template.format(text) for text in texts]
        tokens = self.tokenizer(prompts, padding="max_length", truncation=True, max_length=self.text_length,
                                return_tensors="pt")
        input_ids = tokens["input_ids"].to(self.device)
        with torch.inference_mode():
            with self._autocast():
                output = self.siglip.get_text_features(input_ids=input_ids)
            return F.normalize(tensor_from_model_output(output).float(), dim=-1).cpu().numpy()

    def warmup(self):
        import numpy as np
        import torch
        cfg = CatalogConfig()
        rng = np.random.default_rng(0)
        for height, width, count, tta in ((480, 640, 1, True), (900, 600, CATALOG_GPU_BATCH, False)):
            prepared = [catalog_neural_inputs(rng.integers(0, 255, (height, width, 3), dtype=np.uint8), cfg)
                        for _ in range(count)]
            self.encode_prepared([p[0] for p in prepared], [p[1] for p in prepared], tta)
        self.encode_text(["oak veneer"], cfg.siglip_text_template)
        if self.device == "cuda":
            torch.cuda.synchronize()

    def info(self) -> dict:
        return {"models": {"dino": DINO_REPO, "siglip": SIGLIP_REPO},
                "dims": {"dino": 3 * int(self.meta.get("dino_hidden", 1024)),
                         "siglip": int(self.meta.get("siglip_dim", 1152))},
                "gpu": self._device_name()}

    def selftest(self) -> dict:
        import numpy as np
        cfg = CatalogConfig()
        rgb = synthetic_image()
        t = time.perf_counter()
        dino_u8, siglip_u8 = catalog_neural_inputs(rgb, cfg)
        dino, siglip = self.encode_prepared([dino_u8], [siglip_u8], tta_hflip=True)
        text = self.encode_text(["red square", "green grass"], cfg.siglip_text_template)
        similarity = [round(float(v), 4) for v in (text @ siglip[0])]
        return {"gpu": self._device_name(), "ms": round((time.perf_counter() - t) * 1000, 1),
                "dino": list(dino.shape), "siglip": list(siglip.shape), "text": list(text.shape),
                "norms": [round(float(np.linalg.norm(dino[0])), 4), round(float(np.linalg.norm(siglip[0])), 4)],
                "text_image_similarity": dict(zip(["red square", "green grass"], similarity))}


# ---- feature versions (stored next to every vector; a change re-embeds only what it affects) ----------------------
def local_feature_versions(cfg) -> dict:
    neural_tag = f"clahe{cfg.neural_clahe_clip_limit:g}x{cfg.neural_clahe_grid}"
    block_tag = ",".join(f"{weight:g}" for weight in cfg.dino_block_weights)
    bins_tag = "x".join(str(value) for value in cfg.color_bins)
    return {
        "dino": f"{cfg.dino_model_name}|{cfg.dino_input_size}|r{cfg.dino_resize_short_side}|w{block_tag}|{neural_tag}|v1",
        "siglip": f"{cfg.siglip_model_name}|{neural_tag}|v1",
        "color": (f"lab{bins_tag}|ab{cfg.color_ab_range:g}|clahe{cfg.color_clahe_clip_limit:g}x{cfg.color_clahe_grid}"
                  f"|s{cfg.color_hist_sigma:g}|hw{cfg.color_hist_weight:g}|k{cfg.color_kmeans_k}"
                  f"|m{cfg.color_max_side_px}|v1"),
    }


def vertex_mm_version(cfg) -> str:
    return f"{cfg.vertex_mm_model}|d{cfg.vertex_mm_dimension}|v1"


CAPTION_SYSTEM_PROMPT = """You are a senior materials scientist and CGI look-development artist cataloguing physical
product swatches (fabrics, veneers, laminates, stone, tiles, metals, leathers, wallcoverings).
You receive ONE cropped catalogue photo and its product code. Describe only what is visible.

Rules:
- Never invent brand names, manufacturers or text. The product code is context only.
- Treat the measured dominant colours as ground truth for hue; express tones with hex codes.
- grain_or_pattern_description: geometry (twill, herringbone, cathedral grain, veining), direction, regularity.
- pattern_scale: estimate the real-world repeat or grain spacing in millimetres.
- nano_banana_render_prompt: 120-220 words, present tense, written as an instruction to an image model that must
  reproduce THIS exact material on another object. Cover weave/grain geometry and direction, repeat scale in mm,
  yarn/fibre or pore structure, relief depth, roughness, specular highlight size and sharpness, anisotropy,
  sheen, translucency, colour variation with hex tones, and edge/seam behaviour. Material only: no scene,
  no object, no lighting setup.
- search_keywords: 8-15 lowercase terms covering material, finish, pattern, colour and style."""

CAPTION_USER_TEMPLATE = """Product code (context only): {product_id}
Measured dominant colours (CIELAB k-means on the illumination-normalised crop, share of pixels): {colors}
Return the JSON material profile."""

_MATERIAL_MODEL = {}


def material_profile_model():
    """The notebook's pydantic MaterialProfile (Gemini structured output), built on first use."""
    if "model" in _MATERIAL_MODEL:
        return _MATERIAL_MODEL["model"]
    from enum import Enum

    from pydantic import BaseModel, Field

    class MaterialCategory(str, Enum):
        TEXTILE_FABRIC = "textile_fabric"
        LEATHER = "leather"
        WOOD_VENEER = "wood_veneer"
        SOLID_WOOD = "solid_wood"
        LAMINATE = "laminate"
        STONE = "stone"
        CERAMIC_TILE = "ceramic_tile"
        METAL = "metal"
        GLASS = "glass"
        PLASTIC_POLYMER = "plastic_polymer"
        WALLCOVERING_PAPER = "wallcovering_paper"
        RUBBER_VINYL = "rubber_vinyl"
        CARPET_RUG = "carpet_rug"
        COMPOSITE = "composite"
        OTHER = "other"

    class SurfaceFinish(str, Enum):
        MATTE = "matte"
        SATIN = "satin"
        SEMI_GLOSS = "semi_gloss"
        HIGH_GLOSS = "high_gloss"
        BRUSHED = "brushed"
        EMBOSSED = "embossed"
        WOVEN = "woven"
        KNITTED = "knitted"
        TEXTURED = "textured"
        POLISHED = "polished"
        HONED = "honed"
        HAMMERED = "hammered"
        PERFORATED = "perforated"
        LACQUERED = "lacquered"
        NATURAL_UNFINISHED = "natural_unfinished"
        OTHER = "other"

    class MaterialProfile(BaseModel):
        material_category: MaterialCategory = Field(description="Primary material family visible in the swatch.")
        material_subtype: str = Field(description="Specific material, e.g. 'boucle wool blend', 'quarter-sawn oak veneer'.")
        surface_finish: SurfaceFinish = Field(description="Dominant surface finish.")
        secondary_finishes: List[SurfaceFinish] = Field(description="Other visible finishes; empty list if none.")
        grain_or_pattern_description: str = Field(description="Weave, grain, vein or print geometry and direction.")
        pattern_scale: str = Field(description="Approximate physical scale of the repeat or grain, in millimetres.")
        color_palette_description: str = Field(description="Base tone, secondary tones and variation, with hex codes.")
        specular_behavior: str = Field(description="Highlight size and sharpness, sheen, anisotropy, roughness.")
        micro_surface_feel: str = Field(description="Tactile micro-relief: fibre fuzz, pores, embossing depth.")
        search_keywords: List[str] = Field(description="8-15 lowercase retrieval keywords.")
        nano_banana_render_prompt: str = Field(description="120-220 word material-only rendering prompt.")
        confidence: float = Field(description="0-1 self-assessed confidence in the material identification.")

    _MATERIAL_MODEL["model"] = MaterialProfile
    return MaterialProfile


def compute_caption_version(cfg) -> str:
    schema_text = json.dumps(material_profile_model().model_json_schema(), sort_keys=True)
    fingerprint = "|".join([cfg.caption_model_candidates[0], CAPTION_SYSTEM_PROMPT, CAPTION_USER_TEMPLATE, schema_text])
    return sha256_bytes(fingerprint.encode("utf-8"))[:12]


def compute_feature_versions(cfg) -> dict:
    versions = dict(local_feature_versions(cfg))
    versions["vertex_mm"] = vertex_mm_version(cfg)
    versions["text"] = f"{cfg.text_embedding_model}|d{cfg.text_embedding_dim}|cap{compute_caption_version(cfg)}|v1"
    return versions


# ---- Vertex AI: service-account auth, retries, model fallback ----------------------------------------------------
class SecretUnavailableError(RuntimeError):
    pass


def parse_service_account_json(raw_text, secret_name):
    """Accept the JSON as pasted (also tolerates surrounding quotes, double-encoding or base64)."""
    text = (raw_text or "").strip()
    if not text:
        raise SecretUnavailableError(f"Secret '{secret_name}' is empty.")
    if len(text) >= 2 and text[0] == text[-1] and text[0] in ("'", '"') and not text.startswith('"{'):
        text = text[1:-1].strip()
    info = None
    try:
        info = json.loads(text)
        if isinstance(info, str):
            info = json.loads(info)  # JSON pasted as a JSON string
    except json.JSONDecodeError:
        try:
            info = json.loads(base64.b64decode(text, validate=True).decode("utf-8"))
        except Exception as exc:
            raise SecretUnavailableError(
                f"Secret '{secret_name}' is not valid service-account JSON. Paste the whole downloaded key file "
                "contents, starting with '{' and ending with '}'.") from exc
    if not isinstance(info, dict) or info.get("type") != "service_account":
        raise SecretUnavailableError(f"Secret '{secret_name}' is JSON but not a service-account key "
                                     "(expected \"type\": \"service_account\").")
    missing = [key for key in ("project_id", "private_key", "client_email", "token_uri") if not info.get(key)]
    if missing:
        raise SecretUnavailableError(f"Secret '{secret_name}' is missing fields: {missing}")
    if "\\n" in info["private_key"]:
        info["private_key"] = info["private_key"].replace("\\n", "\n")  # key pasted with escaped newlines
    if "BEGIN PRIVATE KEY" not in info["private_key"]:
        raise SecretUnavailableError(f"Secret '{secret_name}': private_key is not a PEM key.")
    return info


def load_vertex_service_account() -> dict:
    raw = os.environ.get(VERTEX_SECRET_KEY)
    if raw is None:
        raise SecretUnavailableError(f"Modal secret '{VERTEX_SECRET}' ({VERTEX_SECRET_KEY}) is not attached to this "
                                     "container (deployed with VISION_CATALOG_VERTEX=0?).")
    return parse_service_account_json(raw, VERTEX_SECRET)


RETRYABLE_HTTP_CODES = frozenset({408, 429, 500, 502, 503, 504})
TRANSIENT_EXCEPTION_NAMES = frozenset({
    "ReadTimeout", "ConnectTimeout", "WriteTimeout", "PoolTimeout", "ConnectError", "ReadError",
    "WriteError", "RemoteProtocolError", "ServerDisconnectedError", "ClientConnectorError",
    "ClientOSError", "ClientPayloadError", "TransportError",
})
MODEL_UNAVAILABLE_MARKERS = (
    "not found", "was not found", "is not supported", "not supported for", "does not have access",
    "unknown model", "publisher model", "model_not_found", "is not available", "not available in",
)


class VertexHTTPError(Exception):
    def __init__(self, status_code, body):
        super().__init__(f"HTTP {status_code}: {body[:400]}")
        self.code = status_code
        self.body = body

    def __reduce__(self):
        return (type(self), (self.code, self.body))


class EmptyModelResponse(Exception):
    def __init__(self, message, retryable=True):
        super().__init__(message)
        self.retryable = retryable

    def __reduce__(self):
        return (type(self), (str(self), self.retryable))


def error_status_code(exc):
    code = getattr(exc, "code", None)
    if isinstance(code, int):
        return code
    status_code = getattr(exc, "status_code", None)
    if isinstance(status_code, int):
        return status_code
    response = getattr(exc, "response", None)
    response_status = getattr(response, "status_code", None)
    if isinstance(response_status, int):
        return response_status
    return None


def is_retryable_error(exc) -> bool:
    import requests
    if isinstance(exc, EmptyModelResponse):
        return exc.retryable
    if isinstance(exc, (asyncio.TimeoutError, TimeoutError, ConnectionError)):
        return True
    if isinstance(exc, (requests.exceptions.ConnectionError, requests.exceptions.Timeout)):
        return True
    code = error_status_code(exc)
    if code is not None:
        return code in RETRYABLE_HTTP_CODES
    return type(exc).__name__ in TRANSIENT_EXCEPTION_NAMES


def is_model_unavailable_error(exc) -> bool:
    code = error_status_code(exc)
    text = str(exc).lower()
    if code == 404:
        return True
    if code in (400, 403) and any(marker in text for marker in MODEL_UNAVAILABLE_MARKERS):
        return True
    return False


class VertexGenAIManager:
    """Service-account auth + google-genai clients + retry/backoff + model fallback (as in the notebook)."""

    SCOPES = ("https://www.googleapis.com/auth/cloud-platform",)

    def __init__(self, cfg, service_account_info: dict):
        from google import genai
        from google.genai import types as genai_types
        from google.oauth2 import service_account

        self.cfg = cfg
        self.project_id = service_account_info["project_id"]
        self.client_email = service_account_info.get("client_email", "<unknown>")
        self.credentials = service_account.Credentials.from_service_account_info(
            service_account_info, scopes=list(self.SCOPES))
        os.environ["GOOGLE_CLOUD_PROJECT"] = self.project_id

        http_options = genai_types.HttpOptions(timeout=int(cfg.request_timeout_s * 1000))
        self.generation_client = genai.Client(
            vertexai=True, credentials=self.credentials, project=self.project_id,
            location=cfg.gemini_location, http_options=http_options)
        self.embedding_client = genai.Client(
            vertexai=True, credentials=self.credentials, project=self.project_id,
            location=cfg.embedding_location, http_options=http_options)

        self._thread_local = threading.local()
        self._resolved_models = {}
        self._role_locks = {}
        self._cooldown_until = 0.0
        self.disabled_features = set()
        LOGGER.info("Vertex AI auth configured | project=%s | service account=%s", self.project_id,
                    self.client_email)

    # ---------------------------------------------------------------- plumbing
    def _authorized_session(self):
        from google.auth.transport.requests import AuthorizedSession
        session = getattr(self._thread_local, "session", None)
        if session is None:
            session = AuthorizedSession(self.credentials)
            self._thread_local.session = session
        return session

    async def _respect_cooldown(self):
        while True:
            remaining = self._cooldown_until - time.monotonic()
            if remaining <= 0:
                return
            await asyncio.sleep(min(remaining, 5.0))

    def _before_sleep(self, retry_state):
        exception = retry_state.outcome.exception() if retry_state.outcome else None
        if error_status_code(exception) == 429:
            # Global cool-down: every concurrent task pauses, instead of all hammering the quota.
            self._cooldown_until = max(self._cooldown_until, time.monotonic() + self.cfg.rate_limit_cooldown_s)
        wait_seconds = retry_state.next_action.sleep if retry_state.next_action else 0.0
        LOGGER.warning("Retry %d after %s: %s (sleep %.1fs)", retry_state.attempt_number,
                       type(exception).__name__, str(exception)[:160], wait_seconds)

    async def call_with_retries(self, operation):
        from tenacity import AsyncRetrying, retry_if_exception, stop_after_attempt, wait_exponential_jitter
        retrying = AsyncRetrying(
            stop=stop_after_attempt(self.cfg.retry_max_attempts),
            wait=wait_exponential_jitter(initial=self.cfg.retry_initial_wait_s, max=self.cfg.retry_max_wait_s),
            retry=retry_if_exception(is_retryable_error),
            before_sleep=self._before_sleep,
            reraise=True,
        )
        result = None
        async for attempt in retrying:
            with attempt:
                await self._respect_cooldown()
                result = await asyncio.wait_for(operation(), timeout=self.cfg.request_timeout_s + 30)
        return result

    # ---------------------------------------------------------------- generation
    async def _generate(self, model_name, contents, config):
        async def operation():
            return await self.generation_client.aio.models.generate_content(
                model=model_name, contents=contents, config=config)
        return await self.call_with_retries(operation)

    async def generate_content_with_fallback(self, role, candidates, contents, config_factory):
        """Use the first candidate model that exists for this project/region; cache the choice per role."""
        resolved_model = self._resolved_models.get(role)
        if resolved_model is None:
            role_lock = self._role_locks.get(role)
            if role_lock is None:
                role_lock = asyncio.Lock()
                self._role_locks[role] = role_lock
            async with role_lock:
                resolved_model = self._resolved_models.get(role)
                if resolved_model is None:
                    last_error = None
                    for model_name in candidates:
                        try:
                            response = await self._generate(model_name, contents, config_factory(model_name))
                        except Exception as exc:
                            if is_model_unavailable_error(exc):
                                LOGGER.warning("Model %s unavailable for '%s': %s", model_name, role, str(exc)[:160])
                                last_error = exc
                                continue
                            raise
                        self._resolved_models[role] = model_name
                        LOGGER.info("Resolved '%s' model -> %s", role, model_name)
                        return model_name, response
                    raise RuntimeError(f"No candidate model available for '{role}': {list(candidates)}") from last_error
        response = await self._generate(resolved_model, contents, config_factory(resolved_model))
        return resolved_model, response

    # ---------------------------------------------------------------- embeddings
    async def embed_text(self, text, task_type):
        import numpy as np
        from google.genai import types as genai_types
        config = genai_types.EmbedContentConfig(task_type=task_type,
                                                output_dimensionality=self.cfg.text_embedding_dim)

        async def operation():
            # gemini-embedding-001 on Vertex accepts one input per request.
            return await self.embedding_client.aio.models.embed_content(
                model=self.cfg.text_embedding_model, contents=text, config=config)

        response = await self.call_with_retries(operation)
        values = response.embeddings[0].values
        return l2_normalize_rows(np.asarray(values, dtype=np.float32))

    async def multimodal_embed(self, image_bytes=None, text=None):
        """Vertex multimodalembedding@001 via the REST predict endpoint (image and/or text, shared space)."""
        import numpy as np
        location = self.cfg.embedding_location
        url = (f"https://{location}-aiplatform.googleapis.com/v1/projects/{self.project_id}/locations/"
               f"{location}/publishers/google/models/{self.cfg.vertex_mm_model}:predict")
        instance = {}
        if image_bytes is not None:
            instance["image"] = {"bytesBase64Encoded": base64.b64encode(image_bytes).decode("ascii")}
        if text:
            instance["text"] = text[: self.cfg.vertex_mm_text_max_chars]
        body = {"instances": [instance], "parameters": {"dimension": self.cfg.vertex_mm_dimension}}

        def post_request():
            response = self._authorized_session().post(url, json=body, timeout=self.cfg.request_timeout_s)
            if response.status_code != 200:
                raise VertexHTTPError(response.status_code, response.text)
            return response.json()

        async def operation():
            return await asyncio.to_thread(post_request)

        payload = await self.call_with_retries(operation)
        prediction = payload["predictions"][0]
        result = {}
        if "imageEmbedding" in prediction:
            result["image"] = l2_normalize_rows(np.asarray(prediction["imageEmbedding"], dtype=np.float32))
        if "textEmbedding" in prediction:
            result["text"] = l2_normalize_rows(np.asarray(prediction["textEmbedding"], dtype=np.float32))
        return result

    def close(self):
        for client in (self.generation_client, self.embedding_client):
            close_method = getattr(client, "close", None)
            if callable(close_method):
                with contextlib.suppress(Exception):
                    close_method()


class AsyncRunner:
    """One long-lived event loop on a background thread, so every Gemini / Vertex coroutine (and the SDK's HTTP
    sessions) lives on one loop for the container's lifetime, whichever thread or event loop asked for it."""

    def __init__(self):
        self.loop = asyncio.new_event_loop()
        self._ready = threading.Event()
        self.thread = threading.Thread(target=self._serve, name="genai-event-loop", daemon=True)
        self.thread.start()
        self._ready.wait()

    def _serve(self):
        asyncio.set_event_loop(self.loop)
        self.loop.call_soon(self._ready.set)
        self.loop.run_forever()

    def run(self, coroutine, timeout=None):
        """Blocking: for worker threads (the writer's pipeline stages)."""
        future = asyncio.run_coroutine_threadsafe(coroutine, self.loop)
        try:
            return future.result(timeout)
        except BaseException:
            future.cancel()
            raise

    async def call(self, coroutine):
        """Awaitable from another event loop (the web app's) without blocking it."""
        return await asyncio.wrap_future(asyncio.run_coroutine_threadsafe(coroutine, self.loop))


class VertexProvider:
    """Builds the Vertex AI manager and its event-loop thread lazily, after the container is up: credentials,
    sockets and threads never end up in a memory snapshot. get() returns None when Vertex AI is off or the secret is
    missing / malformed; `error` then says why."""

    def __init__(self, enabled: bool = CATALOG_USE_VERTEX):
        self.enabled = enabled
        self._lock = threading.Lock()
        self._manager = None
        self.runner = None
        self.error = None if enabled else "Vertex AI is disabled (deployed with VISION_CATALOG_VERTEX=0)"

    def get(self):
        if not self.enabled:
            return None
        with self._lock:
            if self._manager is None and self.error is None:
                try:
                    info = load_vertex_service_account()
                    self.runner = AsyncRunner()
                    self._manager = VertexGenAIManager(CatalogConfig(), info)
                except Exception as exc:
                    self.error = f"{type(exc).__name__}: {exc}"
                    LOGGER.warning("Vertex AI unavailable in this container: %s", self.error)
            return self._manager

    async def call(self, coroutine):
        return await self.runner.call(coroutine)


# ---- the lineage store (SQLite) ----------------------------------------------------------------------------------
@dataclass
class EmbeddingRow:
    item_id: str
    pillar: str
    feature_version: str
    vector: Any
    extra: Optional[dict] = None


class StateStore:
    """SQLite is the source of truth for lineage + resume; parquet files are exports of it. The writer opens its
    local live copy read-write (WAL); GPU containers open a copy of the published snapshot read-only."""

    SCHEMA = """
    CREATE TABLE IF NOT EXISTS pdfs (
        pdf_sha256 TEXT PRIMARY KEY, source_pdf TEXT NOT NULL, file_size INTEGER, page_count INTEGER,
        status TEXT NOT NULL, error TEXT, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS pages (
        pdf_sha256 TEXT NOT NULL, page_number INTEGER NOT NULL, source_pdf TEXT NOT NULL,
        status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, original_rotation INTEGER,
        page_width REAL, page_height REAL, extraction_method TEXT, n_image_regions INTEGER,
        n_id_candidates INTEGER, n_items INTEGER, debug_json TEXT, error TEXT, updated_at TEXT NOT NULL,
        PRIMARY KEY (pdf_sha256, page_number));
    CREATE TABLE IF NOT EXISTS items (
        item_id TEXT PRIMARY KEY, product_id TEXT, product_id_raw TEXT, source_pdf TEXT NOT NULL,
        pdf_sha256 TEXT NOT NULL, page_number INTEGER NOT NULL, item_index INTEGER NOT NULL,
        image_bbox TEXT NOT NULL, id_bbox TEXT, page_width REAL, page_height REAL, original_rotation INTEGER,
        crop_filepath TEXT NOT NULL, crop_width INTEGER, crop_height INTEGER, render_zoom REAL,
        sha256_hash TEXT NOT NULL, match_type TEXT, match_relation TEXT, match_cost REAL,
        extraction_method TEXT, image_xrefs TEXT, inpainted_overlay INTEGER, status TEXT NOT NULL,
        created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_items_page ON items(pdf_sha256, page_number);
    CREATE INDEX IF NOT EXISTS idx_items_product ON items(product_id);
    CREATE INDEX IF NOT EXISTS idx_items_sha ON items(sha256_hash);
    CREATE TABLE IF NOT EXISTS orphan_ids (
        pdf_sha256 TEXT NOT NULL, page_number INTEGER NOT NULL, product_id TEXT NOT NULL, id_bbox TEXT NOT NULL,
        PRIMARY KEY (pdf_sha256, page_number, product_id, id_bbox));
    CREATE TABLE IF NOT EXISTS embeddings (
        item_id TEXT NOT NULL, pillar TEXT NOT NULL, feature_version TEXT NOT NULL, dim INTEGER NOT NULL,
        dtype TEXT NOT NULL, vector BLOB NOT NULL, extra_json TEXT, updated_at TEXT NOT NULL,
        PRIMARY KEY (item_id, pillar));
    CREATE TABLE IF NOT EXISTS feature_errors (
        item_id TEXT NOT NULL, pillar TEXT NOT NULL, attempts INTEGER NOT NULL, error TEXT,
        updated_at TEXT NOT NULL, PRIMARY KEY (item_id, pillar));
    CREATE TABLE IF NOT EXISTS captions (
        item_id TEXT PRIMARY KEY, caption_version TEXT, model TEXT, status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0, profile_json TEXT, search_text TEXT, error TEXT,
        updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS renders (
        render_id TEXT PRIMARY KEY, item_id TEXT, product_id TEXT, model TEXT, scene_path TEXT,
        output_path TEXT, metadata_path TEXT, prompt TEXT, created_at TEXT NOT NULL);
    """

    def __init__(self, db_path, read_only: bool = False):
        import sqlite3
        self.db_path = Path(db_path)
        self.read_only = read_only
        self._lock = threading.RLock()
        if read_only:
            uri = f"file:{self.db_path.as_posix()}?mode=ro&immutable=1"
            self.connection = sqlite3.connect(uri, uri=True, check_same_thread=False)
        else:
            self.db_path.parent.mkdir(parents=True, exist_ok=True)
            # isolation_level=None -> explicit BEGIN/COMMIT in transaction(); autocommit otherwise.
            self.connection = sqlite3.connect(str(self.db_path), check_same_thread=False, timeout=60,
                                              isolation_level=None)
        self.connection.row_factory = sqlite3.Row
        if not read_only:
            with self._lock:
                self.connection.execute("PRAGMA journal_mode=WAL")
                self.connection.execute("PRAGMA synchronous=NORMAL")
                self.connection.executescript(self.SCHEMA)

    def close(self):
        with self._lock:
            with contextlib.suppress(Exception):
                self.connection.close()

    def backup_to(self, destination):
        """A consistent single-file snapshot (SQLite backup API, rollback journal) for publishing."""
        import sqlite3
        destination = Path(destination)
        destination.parent.mkdir(parents=True, exist_ok=True)
        temporary_path = destination.with_name(destination.name + ".tmp")
        with contextlib.suppress(FileNotFoundError):
            temporary_path.unlink()
        target = sqlite3.connect(str(temporary_path))
        try:
            with self._lock:
                self.connection.backup(target)
            target.execute("PRAGMA journal_mode=DELETE")
            target.commit()
        finally:
            target.close()
        replace_file(temporary_path, destination)

    @contextlib.contextmanager
    def transaction(self):
        if self.read_only:
            raise RuntimeError("this StateStore is a read-only snapshot")
        with self._lock:
            self.connection.execute("BEGIN IMMEDIATE")
            try:
                yield self.connection
            except BaseException:
                self.connection.execute("ROLLBACK")
                raise
            self.connection.execute("COMMIT")

    def query(self, sql, parameters=()):
        with self._lock:
            return self.connection.execute(sql, parameters).fetchall()

    def query_df(self, sql, parameters=()):
        import pandas as pd
        with self._lock:
            cursor = self.connection.execute(sql, parameters)
            columns = [description[0] for description in cursor.description]
            rows = [tuple(row) for row in cursor.fetchall()]
        return pd.DataFrame.from_records(rows, columns=columns)

    # ------------------------------------------------------------ PDFs / pages
    def get_pdf(self, pdf_sha256):
        rows = self.query("SELECT * FROM pdfs WHERE pdf_sha256 = ?", (pdf_sha256,))
        return rows[0] if rows else None

    def upsert_pdf(self, pdf_sha256, source_pdf, file_size, page_count, status, error=None):
        with self.transaction() as connection:
            connection.execute(
                "INSERT OR REPLACE INTO pdfs (pdf_sha256, source_pdf, file_size, page_count, status, error, updated_at)"
                " VALUES (?, ?, ?, ?, ?, ?, ?)",
                (pdf_sha256, source_pdf, file_size, page_count, status, error, utc_now_iso()))

    def page_states(self, pdf_sha256):
        rows = self.query("SELECT page_number, status, attempts FROM pages WHERE pdf_sha256 = ?", (pdf_sha256,))
        states = {}
        for row in rows:
            states[int(row["page_number"])] = {"status": row["status"], "attempts": int(row["attempts"])}
        return states

    def commit_page_result(self, page_result):
        """Items + orphans + page status in ONE transaction: a page is either fully recorded or not at all."""
        now = utc_now_iso()
        with self.transaction() as connection:
            previous_rows = connection.execute(
                "SELECT item_id, sha256_hash FROM items WHERE pdf_sha256 = ? AND page_number = ?",
                (page_result.pdf_sha256, page_result.page_number)).fetchall()
            new_hashes = {}
            for item in page_result.items:
                new_hashes[item["item_id"]] = item["sha256_hash"]
            for previous in previous_rows:
                previous_id = previous["item_id"]
                connection.execute("DELETE FROM items WHERE item_id = ?", (previous_id,))
                if new_hashes.get(previous_id) != previous["sha256_hash"]:
                    for table_name in ("embeddings", "captions", "feature_errors"):
                        connection.execute(f"DELETE FROM {table_name} WHERE item_id = ?", (previous_id,))
            for item in page_result.items:
                connection.execute(
                    "INSERT INTO items (item_id, product_id, product_id_raw, source_pdf, pdf_sha256, page_number,"
                    " item_index, image_bbox, id_bbox, page_width, page_height, original_rotation, crop_filepath,"
                    " crop_width, crop_height, render_zoom, sha256_hash, match_type, match_relation, match_cost,"
                    " extraction_method, image_xrefs, inpainted_overlay, status, created_at)"
                    " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (item["item_id"], item["product_id"], item["product_id_raw"], item["source_pdf"],
                     item["pdf_sha256"], item["page_number"], item["item_index"], json.dumps(item["image_bbox"]),
                     json.dumps(item["id_bbox"]) if item["id_bbox"] is not None else None,
                     item["page_width"], item["page_height"], item["original_rotation"], item["crop_filepath"],
                     item["crop_width"], item["crop_height"], item["render_zoom"], item["sha256_hash"],
                     item["match_type"], item["match_relation"], item["match_cost"], item["extraction_method"],
                     json.dumps(item["image_xrefs"]), int(item["inpainted_overlay"]), "ok", now))
            connection.execute("DELETE FROM orphan_ids WHERE pdf_sha256 = ? AND page_number = ?",
                               (page_result.pdf_sha256, page_result.page_number))
            for orphan in page_result.orphans:
                connection.execute(
                    "INSERT OR IGNORE INTO orphan_ids (pdf_sha256, page_number, product_id, id_bbox) VALUES (?, ?, ?, ?)",
                    (page_result.pdf_sha256, page_result.page_number, orphan["product_id"],
                     json.dumps(orphan["id_bbox"])))
            connection.execute(
                "INSERT OR REPLACE INTO pages (pdf_sha256, page_number, source_pdf, status, attempts,"
                " original_rotation, page_width, page_height, extraction_method, n_image_regions, n_id_candidates,"
                " n_items, debug_json, error, updated_at) VALUES (?, ?, ?, 'done',"
                " COALESCE((SELECT attempts FROM pages WHERE pdf_sha256 = ? AND page_number = ?), 0) + 1,"
                " ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)",
                (page_result.pdf_sha256, page_result.page_number, page_result.source_pdf,
                 page_result.pdf_sha256, page_result.page_number, page_result.original_rotation,
                 page_result.page_width, page_result.page_height, page_result.extraction_method,
                 page_result.n_image_regions, page_result.n_id_candidates, len(page_result.items),
                 json.dumps(page_result.debug), now))

    def mark_page_error(self, pdf_sha256, page_number, source_pdf, error_text):
        with self.transaction() as connection:
            connection.execute(
                "INSERT OR REPLACE INTO pages (pdf_sha256, page_number, source_pdf, status, attempts, error, updated_at)"
                " VALUES (?, ?, ?, 'error',"
                " COALESCE((SELECT attempts FROM pages WHERE pdf_sha256 = ? AND page_number = ?), 0) + 1, ?, ?)",
                (pdf_sha256, page_number, source_pdf, pdf_sha256, page_number, error_text[:4000], utc_now_iso()))

    def get_item(self, item_id):
        rows = self.query("SELECT * FROM items WHERE item_id = ?", (item_id,))
        return dict(rows[0]) if rows else None

    # ------------------------------------------------------------ embeddings
    def upsert_embeddings(self, rows):
        import numpy as np
        now = utc_now_iso()
        with self.transaction() as connection:
            for row in rows:
                vector = np.asarray(row.vector, dtype=np.float16).ravel()
                connection.execute(
                    "INSERT OR REPLACE INTO embeddings (item_id, pillar, feature_version, dim, dtype, vector,"
                    " extra_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                    (row.item_id, row.pillar, row.feature_version, int(vector.shape[0]), "float16",
                     vector.tobytes(), json.dumps(row.extra) if row.extra is not None else None, now))
                connection.execute("DELETE FROM feature_errors WHERE item_id = ? AND pillar = ?",
                                   (row.item_id, row.pillar))

    def record_feature_errors(self, errors, pillars):
        now = utc_now_iso()
        with self.transaction() as connection:
            for item_id, error_text in errors:
                for pillar in pillars:
                    connection.execute(
                        "INSERT OR REPLACE INTO feature_errors (item_id, pillar, attempts, error, updated_at)"
                        " VALUES (?, ?, COALESCE((SELECT attempts FROM feature_errors WHERE item_id = ?"
                        " AND pillar = ?), 0) + 1, ?, ?)",
                        (item_id, pillar, item_id, pillar, str(error_text)[:2000], now))

    def items_needing_pillars(self, versions, max_attempts):
        """Items whose vector for ANY of the given pillars is missing or from an older feature version."""
        items = self.query("SELECT item_id, crop_filepath FROM items WHERE status = 'ok' ORDER BY item_id")
        pillar_names = list(versions.keys())
        placeholders = ",".join(["?"] * len(pillar_names))
        done = set()
        for row in self.query(f"SELECT item_id, pillar, feature_version FROM embeddings WHERE pillar IN ({placeholders})",
                              tuple(pillar_names)):
            if versions.get(row["pillar"]) == row["feature_version"]:
                done.add((row["item_id"], row["pillar"]))
        error_attempts = {}
        for row in self.query(f"SELECT item_id, pillar, attempts FROM feature_errors WHERE pillar IN ({placeholders})",
                              tuple(pillar_names)):
            error_attempts[(row["item_id"], row["pillar"])] = int(row["attempts"])
        pending = []
        for row in items:
            for pillar in pillar_names:
                key = (row["item_id"], pillar)
                if key not in done and error_attempts.get(key, 0) < max_attempts:
                    pending.append((row["item_id"], row["crop_filepath"]))
                    break
        return pending

    def fetch_embeddings(self, pillar, feature_version):
        import numpy as np
        import pandas as pd
        rows = self.query(
            "SELECT e.item_id, e.dim, e.dtype, e.vector FROM embeddings e JOIN items i ON i.item_id = e.item_id"
            " WHERE e.pillar = ? AND e.feature_version = ? AND i.status = 'ok' ORDER BY e.item_id",
            (pillar, feature_version))
        if not rows:
            return [], np.zeros((0, 0), dtype=np.float32)
        dimensions = pd.Series([int(row["dim"]) for row in rows])
        expected_dim = int(dimensions.mode().iloc[0])
        item_ids = []
        vectors = []
        for row in rows:
            if int(row["dim"]) != expected_dim:
                continue
            item_ids.append(row["item_id"])
            vectors.append(np.frombuffer(row["vector"], dtype=np.dtype(row["dtype"])).astype(np.float32))
        matrix = l2_normalize_rows(np.stack(vectors))
        return item_ids, np.ascontiguousarray(matrix, dtype=np.float32)

    def color_meta_map(self, color_version):
        meta = {}
        for row in self.query("SELECT item_id, extra_json FROM embeddings WHERE pillar = 'color' AND feature_version = ?",
                              (color_version,)):
            if row["extra_json"]:
                meta[row["item_id"]] = json.loads(row["extra_json"])
        return meta

    # ------------------------------------------------------------ captions
    def pending_captions(self, caption_version, max_attempts):
        return self.query(
            "SELECT i.item_id, i.product_id, i.crop_filepath FROM items i LEFT JOIN captions c ON c.item_id = i.item_id"
            " WHERE i.status = 'ok' AND (c.item_id IS NULL OR c.caption_version IS NOT ?"
            " OR (c.status != 'ok' AND c.attempts < ?)) ORDER BY i.item_id",
            (caption_version, max_attempts))

    def save_captions(self, results):
        now = utc_now_iso()
        with self.transaction() as connection:
            for result in results:
                previous = connection.execute("SELECT caption_version, attempts FROM captions WHERE item_id = ?",
                                              (result.item_id,)).fetchone()
                attempts = 1
                if previous is not None and previous["caption_version"] == result.caption_version:
                    attempts = int(previous["attempts"]) + 1
                connection.execute(
                    "INSERT OR REPLACE INTO captions (item_id, caption_version, model, status, attempts, profile_json,"
                    " search_text, error, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (result.item_id, result.caption_version, result.model, result.status, attempts,
                     json.dumps(result.profile) if result.profile is not None else None, result.search_text,
                     result.error, now))

    def pending_text_embeddings(self, text_version, caption_version, max_attempts):
        return self.query(
            "SELECT c.item_id, c.search_text FROM captions c JOIN items i ON i.item_id = c.item_id"
            " LEFT JOIN embeddings e ON e.item_id = c.item_id AND e.pillar = 'text' AND e.feature_version = ?"
            " LEFT JOIN feature_errors fe ON fe.item_id = c.item_id AND fe.pillar = 'text'"
            " WHERE i.status = 'ok' AND c.status = 'ok' AND c.caption_version = ? AND e.item_id IS NULL"
            " AND (fe.attempts IS NULL OR fe.attempts < ?) ORDER BY c.item_id",
            (text_version, caption_version, max_attempts))

    def record_render(self, row):
        with self.transaction() as connection:
            connection.execute(
                "INSERT OR REPLACE INTO renders (render_id, item_id, product_id, model, scene_path, output_path,"
                " metadata_path, prompt, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (row["render_id"], row["item_id"], row["product_id"], row["model"], row["scene_path"],
                 row["output_path"], row["metadata_path"], row["prompt"], utc_now_iso()))

    # ------------------------------------------------------------ catalogue view + exports
    def catalog_frame(self, feature_versions, only_ok=True):
        where_clause = "WHERE status = 'ok'" if only_ok else ""
        items = self.query_df(f"SELECT * FROM items {where_clause} ORDER BY source_pdf, page_number, item_index")
        if items.empty:
            return items
        items["image_bbox"] = items["image_bbox"].map(json.loads)
        items["id_bbox"] = items["id_bbox"].map(lambda value: json.loads(value) if isinstance(value, str) else None)
        items["image_xrefs"] = items["image_xrefs"].map(lambda value: json.loads(value) if isinstance(value, str) else [])

        captions = self.query_df(
            "SELECT item_id, status AS caption_status, model AS caption_model, caption_version, profile_json,"
            " search_text, attempts AS caption_attempts FROM captions")
        items = items.merge(captions, on="item_id", how="left")
        profile_fields = ["material_category", "material_subtype", "surface_finish", "grain_or_pattern_description",
                          "pattern_scale", "color_palette_description", "specular_behavior", "micro_surface_feel",
                          "search_keywords", "nano_banana_render_prompt"]
        parsed_profiles = items["profile_json"].map(lambda value: json.loads(value) if isinstance(value, str) else {})
        for field_name in profile_fields:
            items[field_name] = parsed_profiles.map(lambda profile, name=field_name: profile.get(name))

        color_rows = self.query_df(
            "SELECT item_id, extra_json AS color_extra FROM embeddings WHERE pillar = 'color' AND feature_version = ?",
            (feature_versions.get("color", ""),))
        items = items.merge(color_rows, on="item_id", how="left")
        parsed_colors = items["color_extra"].map(lambda value: json.loads(value) if isinstance(value, str) else {})
        items["dominant_hex"] = parsed_colors.map(lambda extra: extra.get("dominant_hex"))
        items["dominant_proportions"] = parsed_colors.map(lambda extra: extra.get("proportions"))
        items = items.drop(columns=["color_extra"])

        vector_rows = self.query_df("SELECT item_id, pillar, feature_version FROM embeddings")
        for pillar, version in feature_versions.items():
            if vector_rows.empty:
                items[f"vector_{pillar}"] = False
                continue
            matching = vector_rows[(vector_rows["pillar"] == pillar) & (vector_rows["feature_version"] == version)]
            items[f"vector_{pillar}"] = items["item_id"].isin(set(matching["item_id"]))
        items.index = list(items["item_id"])
        return items

    def export_manifest(self, manifest_path, page_audit_path, feature_versions):
        """Parquet exports of the lineage. They are conveniences: without a parquet engine they are skipped with a
        warning instead of failing the ingest (state.sqlite stays the source of truth)."""
        manifest = self.catalog_frame(feature_versions, only_ok=False)
        pages = self.query_df("SELECT * FROM pages ORDER BY source_pdf, page_number")
        try:
            if not manifest.empty:
                manifest = manifest.reset_index(drop=True)
                temporary_path = Path(str(manifest_path) + ".tmp")
                manifest.to_parquet(temporary_path, index=False)
                replace_file(temporary_path, manifest_path)
            if not pages.empty:
                temporary_path = Path(str(page_audit_path) + ".tmp")
                pages.to_parquet(temporary_path, index=False)
                replace_file(temporary_path, page_audit_path)
        except ImportError as exc:
            LOGGER.warning("parquet exports skipped (no usable parquet engine): %s", str(exc).splitlines()[0])
        return len(manifest)

    def summary(self):
        counts = {}
        for table_name in ("pdfs", "pages", "items", "captions", "embeddings", "feature_errors", "orphan_ids", "renders"):
            counts[table_name] = int(self.query(f"SELECT COUNT(*) AS n FROM {table_name}")[0]["n"])
        return counts


# ---- Volume access -----------------------------------------------------------------------------------------------
class VolumeGuard:
    """Any number of threads using files on the Volume, OR one volume.reload(), never both: Modal refuses to
    reload while files are open, and the Volume looks empty to this container while a reload runs. Waiting reloads
    block new file users, so a steady stream of reads cannot starve a reload. volume=None (tests, local runs) makes
    reload/commit no-ops."""

    def __init__(self, volume):
        self.volume = volume
        self._cond = threading.Condition()
        self._users = 0
        self._reloading = False
        self._waiting_reloads = 0

    @contextlib.contextmanager
    def files(self):
        with self._cond:
            while self._reloading or self._waiting_reloads:
                self._cond.wait()
            self._users += 1
        try:
            yield
        finally:
            with self._cond:
                self._users -= 1
                self._cond.notify_all()

    def reload(self):
        if self.volume is None:
            return
        with self._cond:
            self._waiting_reloads += 1
            try:
                while self._reloading or self._users:
                    self._cond.wait()
            finally:
                self._waiting_reloads -= 1
            self._reloading = True
        try:
            self.volume.reload()
        finally:
            with self._cond:
                self._reloading = False
                self._cond.notify_all()

    def commit(self):
        if self.volume is not None:
            self.volume.commit()


# ---- stage 1: deterministic PDF page / crop / ID extraction with spatial backtracking ----------------------------
@dataclass
class IdCandidate:
    text: str
    raw_text: str
    rect: Any


@dataclass
class ImageRegion:
    rect: Any
    xrefs: List[int]
    native_pixels_per_point: float
    method: str


@dataclass
class IdMatch:
    candidate_index: int
    cost: float
    relation: str
    match_type: str


@dataclass
class PageResult:
    pdf_sha256: str
    source_pdf: str
    page_number: int
    original_rotation: int
    page_width: float
    page_height: float
    extraction_method: str
    n_image_regions: int
    n_id_candidates: int
    items: List[dict]
    orphans: List[dict]
    debug: dict


def rect_to_list(rect):
    return [round(float(rect.x0), 3), round(float(rect.y0), 3), round(float(rect.x1), 3), round(float(rect.y1), 3)]


def overlap_length(start_a, end_a, start_b, end_b):
    return max(0.0, min(end_a, end_b) - max(start_a, start_b))


def pixmap_to_rgb(pixmap):
    import numpy as np
    buffer = np.frombuffer(pixmap.samples, dtype=np.uint8)
    rows = buffer.reshape(pixmap.height, pixmap.stride)[:, : pixmap.width * pixmap.n]
    array = rows.reshape(pixmap.height, pixmap.width, pixmap.n)
    if pixmap.n == 1:
        array = np.repeat(array, 3, axis=2)
    elif pixmap.n == 4:
        array = array[:, :, :3]
    return np.ascontiguousarray(array)


def merge_overlapping_regions(regions, tolerance):
    """Union image boxes that overlap or touch (PDF generators often slice one photo into strips)."""
    fitz = _fitz()
    pending = list(regions)
    changed = True
    while changed:
        changed = False
        merged = []
        while pending:
            current = pending.pop(0)
            index = 0
            while index < len(pending):
                other = pending[index]
                expanded = fitz.Rect(current.rect.x0 - tolerance, current.rect.y0 - tolerance,
                                     current.rect.x1 + tolerance, current.rect.y1 + tolerance)
                if expanded.intersects(other.rect):
                    current = ImageRegion(rect=current.rect | other.rect,
                                          xrefs=current.xrefs + other.xrefs,
                                          native_pixels_per_point=max(current.native_pixels_per_point,
                                                                      other.native_pixels_per_point),
                                          method=current.method)
                    pending.pop(index)
                    changed = True
                    index = 0
                else:
                    index += 1
            merged.append(current)
        pending = merged
    return pending


def reset_mupdf_cache():
    """MuPDF caches decoded images; a clip rendered after a full-page render at another zoom can differ by
    one intensity level. Emptying the store makes every crop render independent of history (bit-reproducible)."""
    fitz = _fitz()
    store_shrink = getattr(fitz.TOOLS, "store_shrink", None)
    if callable(store_shrink):
        store_shrink(100)


class CatalogueExtractor:
    """The notebook's extractor. PDFs come from <catalog>/pdfs/ on the Volume and are copied to local disk before
    PyMuPDF opens them; crops are written to <catalog>/crops/; state.sqlite stores paths relative to the catalogue
    folder, so the Volume can be downloaded and used anywhere."""

    def __init__(self, cfg, store, guard, on_page_done=None, local_tmp: str = "/tmp/vision-catalog-pdfs"):
        import re
        self.cfg = cfg
        self.store = store
        self.guard = guard
        self.on_page_done = on_page_done
        self.local_tmp = Path(local_tmp)
        self.id_pattern = re.compile(cfg.product_id_regex)
        self.prefix_pattern = re.compile(cfg.product_id_label_prefix_regex, re.IGNORECASE)
        self.year_pattern = re.compile(r"(?:19|20)\d{2}")
        self.stopwords = set(word.upper() for word in cfg.id_stopwords)

    # ------------------------------------------------------------ driver
    def discover_pdfs(self, names=None):
        with self.guard.files():
            if names:
                found = []
                missing = []
                for name in names:
                    path = self.cfg.pdf_dir / name
                    if path.is_file():
                        found.append(path)
                    else:
                        missing.append(name)
                if missing:
                    raise FileNotFoundError(f"not on the Volume under {self.cfg.pdf_dir}: {missing}")
                return found
            if not self.cfg.pdf_dir.exists():
                return []
            found = []
            for path in sorted(self.cfg.pdf_dir.rglob("*")):
                if path.is_file() and path.suffix.lower() == ".pdf":
                    found.append(path)
            return found

    def run(self, names=None):
        pdf_paths = self.discover_pdfs(names)
        LOGGER.info("Extraction: %d PDF(s) found in %s", len(pdf_paths), self.cfg.pdf_dir)
        processed = []
        for pdf_path in pdf_paths:
            self.process_pdf(pdf_path)
            processed.append(self.cfg.relative(pdf_path))
        return processed

    def _xref_page_frequency(self, document):
        frequency = {}
        for page_index in range(document.page_count):
            page = document.load_page(page_index)
            seen_on_page = set()
            for info in page.get_image_info(xrefs=True):
                xref = int(info.get("xref", 0) or 0)
                if xref:
                    seen_on_page.add(xref)
            for xref in seen_on_page:
                frequency[xref] = frequency.get(xref, 0) + 1
        return frequency

    def process_pdf(self, pdf_path):
        import traceback
        fitz = _fitz()
        pdf_path = Path(pdf_path)
        source = self.cfg.relative(pdf_path)
        with self.guard.files():
            pdf_sha256 = sha256_file(pdf_path)
            file_size = pdf_path.stat().st_size
        existing = self.store.get_pdf(pdf_sha256)
        if existing is not None and existing["status"] == "done":
            LOGGER.info("Skip %s (already extracted, sha=%s)", pdf_path.name, pdf_sha256[:12])
            return
        self.local_tmp.mkdir(parents=True, exist_ok=True)
        local_copy = self.local_tmp / f"{pdf_sha256[:16]}.pdf"
        with self.guard.files():
            copy_into_place(pdf_path, local_copy)   # PyMuPDF seeks a lot; local disk is far faster than the Volume
        try:
            with _PYMUPDF_LOCK:
                document = fitz.open(str(local_copy))
        except Exception as exc:
            self.store.upsert_pdf(pdf_sha256, source, file_size, 0, "error", repr(exc))
            LOGGER.error("Cannot open %s: %s", pdf_path, exc)
            local_copy.unlink(missing_ok=True)
            return
        try:
            if document.needs_pass:
                self.store.upsert_pdf(pdf_sha256, source, file_size, 0, "error", "password protected")
                LOGGER.error("%s is password protected; skipping.", pdf_path.name)
                return
            page_count = document.page_count
            self.store.upsert_pdf(pdf_sha256, source, file_size, page_count, "in_progress")
            page_states = self.store.page_states(pdf_sha256)
            with _PYMUPDF_LOCK:
                xref_frequency = self._xref_page_frequency(document) if page_count >= 4 else {}
            started = time.time()
            processed = 0
            for page_index in range(page_count):
                page_number = page_index + 1
                state = page_states.get(page_number)
                if state is not None and state["status"] == "done":
                    continue
                if state is not None and state["status"] == "error" and state["attempts"] >= self.cfg.page_max_attempts:
                    continue
                try:
                    with _PYMUPDF_LOCK:
                        result = self._process_page(document, page_index, pdf_path, source, pdf_sha256,
                                                    xref_frequency)
                    self.store.commit_page_result(result)
                    processed += 1
                except Exception:
                    error_text = traceback.format_exc()
                    LOGGER.error("Page %d of %s failed:\n%s", page_number, pdf_path.name, error_text[-800:])
                    self.store.mark_page_error(pdf_sha256, page_number, source, error_text)
                if self.on_page_done is not None:
                    self.on_page_done(pdf_path.name, page_number, page_count)
            final_states = self.store.page_states(pdf_sha256)
            finished_pages = sum(1 for state in final_states.values() if state["status"] == "done")
            status = "done" if finished_pages == page_count else "partial"
            self.store.upsert_pdf(pdf_sha256, source, file_size, page_count, status)
            LOGGER.info("%s: %d/%d pages done (%d processed now, %.1fs) -> %s", pdf_path.name, finished_pages,
                        page_count, processed, time.time() - started, status)
        finally:
            with _PYMUPDF_LOCK:
                document.close()
            local_copy.unlink(missing_ok=True)

    # ------------------------------------------------------------ page
    def _process_page(self, document, page_index, pdf_path, source, pdf_sha256, xref_frequency):
        fitz = _fitz()
        page_number = page_index + 1
        page = document.load_page(page_index)
        original_rotation = int(page.rotation)
        if original_rotation:
            page.remove_rotation()  # normalise so every bbox lives in one upright coordinate system
        page_rect = page.rect
        words = page.get_text("words", sort=True)
        candidates = self._find_id_candidates(words)
        regions, method = self._find_image_regions(page, page_rect, words, xref_frequency, document.page_count,
                                                   len(candidates))
        regions = self._sort_reading_order(regions)
        matches = self._assign_ids(regions, candidates, page_rect)

        crop_directory = self.cfg.crops_dir / f"{safe_name(pdf_path.stem)}_{pdf_sha256[:8]}"
        extension = "jpg" if self.cfg.crop_image_format.lower() in ("jpg", "jpeg") else "png"
        items = []
        used_candidates = set()
        reset_mupdf_cache()
        for item_index, region in enumerate(regions):
            # Snap the box to the stored precision first, so re-rendering from the manifest is bit-identical.
            region.rect = fitz.Rect(rect_to_list(region.rect))
            zoom = self._choose_zoom(region)
            rgb = self._render_clip(page, region.rect, zoom)
            inpainted = False
            if self.cfg.inpaint_overlay_text:
                rgb, inpainted = self._inpaint_overlay_text(rgb, region.rect, zoom, words)
            encoded = encode_rgb(rgb, self.cfg.crop_image_format)
            item_id = f"{pdf_sha256[:12]}-p{page_number:04d}-i{item_index:02d}"
            crop_path = crop_directory / f"{item_id}.{extension}"
            with self.guard.files():
                atomic_write_bytes(crop_path, encoded)

            match = matches.get(item_index)
            product_id = None
            product_id_raw = None
            id_bbox = None
            match_type = "none"
            match_relation = None
            match_cost = None
            if match is not None:
                candidate = candidates[match.candidate_index]
                product_id = candidate.text
                product_id_raw = candidate.raw_text
                id_bbox = rect_to_list(candidate.rect)
                match_type = match.match_type
                match_relation = match.relation
                match_cost = round(float(match.cost), 6)
                used_candidates.add(match.candidate_index)
            items.append({
                "item_id": item_id, "product_id": product_id, "product_id_raw": product_id_raw,
                "source_pdf": source, "pdf_sha256": pdf_sha256, "page_number": page_number,
                "item_index": item_index, "image_bbox": rect_to_list(region.rect), "id_bbox": id_bbox,
                "page_width": float(page_rect.width), "page_height": float(page_rect.height),
                "original_rotation": original_rotation, "crop_filepath": self.cfg.relative(crop_path),
                "crop_width": int(rgb.shape[1]), "crop_height": int(rgb.shape[0]), "render_zoom": float(zoom),
                "sha256_hash": sha256_bytes(encoded), "match_type": match_type, "match_relation": match_relation,
                "match_cost": match_cost, "extraction_method": region.method, "image_xrefs": region.xrefs,
                "inpainted_overlay": inpainted,
            })

        orphans = []
        for candidate_index, candidate in enumerate(candidates):
            if candidate_index not in used_candidates:
                orphans.append({"product_id": candidate.text, "id_bbox": rect_to_list(candidate.rect)})
        debug = {
            "candidates": [{"text": candidate.text, "bbox": rect_to_list(candidate.rect)} for candidate in candidates],
            "regions": [{"bbox": rect_to_list(region.rect), "method": region.method, "xrefs": region.xrefs}
                        for region in regions],
        }
        return PageResult(pdf_sha256=pdf_sha256, source_pdf=source, page_number=page_number,
                          original_rotation=original_rotation, page_width=float(page_rect.width),
                          page_height=float(page_rect.height), extraction_method=method,
                          n_image_regions=len(regions), n_id_candidates=len(candidates), items=items,
                          orphans=orphans, debug=debug)

    # ------------------------------------------------------------ product IDs
    def _find_id_candidates(self, words):
        fitz = _fitz()
        candidates = []
        seen = set()
        for word in words:
            raw_text = word[4]
            token = raw_text.strip(ID_STRIP_CHARACTERS)
            token = self.prefix_pattern.sub("", token).strip(ID_STRIP_CHARACTERS)
            if not token or token.upper() in self.stopwords:
                continue
            if not self.id_pattern.fullmatch(token):
                continue
            digit_count = sum(1 for character in token if character.isdigit())
            letter_count = sum(1 for character in token if character.isalpha())
            if digit_count == 0:
                continue
            if letter_count == 0:
                if len(token) < self.cfg.min_numeric_id_length:
                    continue  # page numbers, quantities
                if self.cfg.reject_year_like_ids and self.year_pattern.fullmatch(token):
                    continue
            text = token.upper() if self.cfg.uppercase_product_ids else token
            rect = fitz.Rect(word[0], word[1], word[2], word[3])
            key = (text, round(rect.x0, 1), round(rect.y0, 1))
            if key in seen:
                continue  # some PDFs draw text twice for faux-bold
            seen.add(key)
            candidates.append(IdCandidate(text=text, raw_text=raw_text, rect=rect))
        return candidates

    # ------------------------------------------------------------ image regions
    def _find_image_regions(self, page, page_rect, words, xref_frequency, page_count, candidate_count):
        fitz = _fitz()
        page_area = max(page_rect.width * page_rect.height, 1e-6)
        raw_regions = []
        rejected_rects = []  # logos/decorations: also hidden from the raster fallback below
        for info in page.get_image_info(xrefs=True):
            bbox = fitz.Rect(info["bbox"])
            if bbox.is_empty or bbox.is_infinite:
                continue
            clipped = bbox & page_rect
            if clipped.is_empty:
                continue
            if clipped.width < self.cfg.min_image_side_pt or clipped.height < self.cfg.min_image_side_pt:
                rejected_rects.append(clipped)
                continue
            if clipped.get_area() / page_area < self.cfg.min_image_area_fraction:
                rejected_rects.append(clipped)
                continue
            xref = int(info.get("xref", 0) or 0)
            if xref and page_count >= 4:
                if xref_frequency.get(xref, 0) / float(page_count) >= self.cfg.repeated_image_page_fraction:
                    rejected_rects.append(clipped)
                    continue  # logo / watermark / background repeated on most pages
            pixels_per_point = max(float(info.get("width", 0)) / max(bbox.width, 1e-6),
                                   float(info.get("height", 0)) / max(bbox.height, 1e-6))
            raw_regions.append(ImageRegion(rect=clipped, xrefs=[xref] if xref else [],
                                           native_pixels_per_point=pixels_per_point, method="embedded_image"))
        regions = merge_overlapping_regions(raw_regions, self.cfg.merge_tolerance_pt)

        # A single page-sized raster plus several IDs = a flattened/scanned grid -> split it visually.
        if len(regions) == 1 and candidate_count >= 2:
            if regions[0].rect.get_area() / page_area >= self.cfg.flattened_page_area_fraction:
                segmented = self._segment_regions_from_render(page, page_rect, words,
                                                              regions[0].native_pixels_per_point, rejected_rects)
                if len(segmented) >= 2:
                    return segmented, "raster_segmentation_flattened"
        if not regions and self.cfg.enable_raster_segmentation_fallback:
            segmented = self._segment_regions_from_render(page, page_rect, words, 0.0, rejected_rects)
            return segmented, "raster_segmentation"
        return regions, "embedded_image"

    def _segment_regions_from_render(self, page, page_rect, words, fallback_pixels_per_point, rejected_rects):
        import math

        import cv2
        import numpy as np
        fitz = _fitz()
        zoom = self.cfg.segmentation_dpi / 72.0
        rgb = pixmap_to_rgb(page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), alpha=False, colorspace=fitz.csRGB))
        height, width = rgb.shape[:2]
        border = np.concatenate([rgb[:3].reshape(-1, 3), rgb[-3:].reshape(-1, 3),
                                 rgb[:, :3].reshape(-1, 3), rgb[:, -3:].reshape(-1, 3)])
        background = np.median(border, axis=0).astype(np.int16)
        difference = np.abs(rgb.astype(np.int16) - background).max(axis=2)
        mask = (difference > self.cfg.segmentation_background_threshold).astype(np.uint8) * 255
        hidden_boxes = [(word[0], word[1], word[2], word[3]) for word in words]
        hidden_boxes.extend((rect.x0, rect.y0, rect.x1, rect.y1) for rect in rejected_rects)
        for box in hidden_boxes:
            x0 = max(0, int(box[0] * zoom) - 2)
            y0 = max(0, int(box[1] * zoom) - 2)
            x1 = min(width, int(math.ceil(box[2] * zoom)) + 2)
            y1 = min(height, int(math.ceil(box[3] * zoom)) + 2)
            mask[y0:y1, x0:x1] = 0
        kernel_size = max(3, int(round(min(height, width) * 0.012)))
        kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (kernel_size, kernel_size))
        mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel)
        mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel)
        contour_result = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        contours = contour_result[0] if len(contour_result) == 2 else contour_result[1]
        page_area = max(page_rect.width * page_rect.height, 1e-6)
        regions = []
        for contour in contours:
            x, y, box_width, box_height = cv2.boundingRect(contour)
            fill_ratio = cv2.contourArea(contour) / max(float(box_width * box_height), 1.0)
            if fill_ratio < 0.5:
                continue
            rect = fitz.Rect(x / zoom, y / zoom, (x + box_width) / zoom, (y + box_height) / zoom) & page_rect
            if rect.width < self.cfg.min_image_side_pt or rect.height < self.cfg.min_image_side_pt:
                continue
            if rect.get_area() / page_area < self.cfg.min_image_area_fraction:
                continue
            regions.append(ImageRegion(rect=rect, xrefs=[], native_pixels_per_point=fallback_pixels_per_point,
                                       method="raster_segmentation"))
        return merge_overlapping_regions(regions, self.cfg.merge_tolerance_pt)

    @staticmethod
    def _sort_reading_order(regions):
        import numpy as np
        ordered_by_top = sorted(regions, key=lambda region: (region.rect.y0, region.rect.x0))
        rows = []
        for region in ordered_by_top:
            center_y = (region.rect.y0 + region.rect.y1) / 2.0
            if rows:
                current_row = rows[-1]
                row_center = float(np.mean([(member.rect.y0 + member.rect.y1) / 2.0 for member in current_row]))
                row_height = min(member.rect.height for member in current_row)
                if abs(center_y - row_center) <= 0.5 * min(region.rect.height, row_height):
                    current_row.append(region)
                    continue
            rows.append([region])
        ordered = []
        for row in rows:
            ordered.extend(sorted(row, key=lambda region: region.rect.x0))
        return ordered

    # ------------------------------------------------------------ spatial matching
    def _pair_cost(self, image_rect, id_rect, page_diagonal):
        import math
        dx = max(image_rect.x0 - id_rect.x1, id_rect.x0 - image_rect.x1, 0.0)
        dy = max(image_rect.y0 - id_rect.y1, id_rect.y0 - image_rect.y1, 0.0)
        gap = math.hypot(dx, dy)
        center_x = (id_rect.x0 + id_rect.x1) / 2.0
        center_y = (id_rect.y0 + id_rect.y1) / 2.0
        tolerance = 0.25 * id_rect.height
        base = 0.0
        inside_x = image_rect.x0 <= center_x <= image_rect.x1
        inside_y = image_rect.y0 <= center_y <= image_rect.y1
        if inside_x and inside_y:
            relation = "inside"   # label printed over the photo; usually hugs an edge
            base = 0.25 * min(center_y - image_rect.y0, image_rect.y1 - center_y)
        elif id_rect.y0 >= image_rect.y1 - tolerance:
            relation = "below"
        elif id_rect.y1 <= image_rect.y0 + tolerance:
            relation = "above"
        else:
            relation = "side"
        if relation in ("below", "above"):
            coverage = overlap_length(image_rect.x0, image_rect.x1, id_rect.x0, id_rect.x1) / max(id_rect.width, 1e-6)
            alignment = 1.0 + self.cfg.alignment_penalty * (1.0 - min(coverage, 1.0))
        elif relation == "side":
            coverage = overlap_length(image_rect.y0, image_rect.y1, id_rect.y0, id_rect.y1) / max(id_rect.height, 1e-6)
            alignment = 1.0 + self.cfg.alignment_penalty * (1.0 - min(coverage, 1.0))
        else:
            alignment = 1.0
        cost = (gap + base + 1.0) * self.cfg.direction_weights[relation] * alignment / page_diagonal
        return cost, relation

    def _assign_ids(self, regions, candidates, page_rect):
        """Global 1:1 assignment (Hungarian) of image boxes to ID boxes by directional proximity."""
        import math

        import numpy as np
        from scipy.optimize import linear_sum_assignment
        if not regions or not candidates:
            return {}
        page_diagonal = math.hypot(page_rect.width, page_rect.height)
        cost_matrix = np.zeros((len(regions), len(candidates)), dtype=np.float64)
        relations = [[None] * len(candidates) for _ in regions]
        for region_index, region in enumerate(regions):
            for candidate_index, candidate in enumerate(candidates):
                cost, relation = self._pair_cost(region.rect, candidate.rect, page_diagonal)
                cost_matrix[region_index, candidate_index] = cost
                relations[region_index][candidate_index] = relation
        matches = {}
        if len(regions) == 1:
            # Full-page single product: any ID on the page belongs to it; take the closest.
            best = int(np.argmin(cost_matrix[0]))
            matches[0] = IdMatch(best, float(cost_matrix[0, best]), relations[0][best], "single_image")
            return matches
        row_indices, column_indices = linear_sum_assignment(cost_matrix)
        for region_index, candidate_index in zip(row_indices, column_indices):
            cost = float(cost_matrix[region_index, candidate_index])
            if cost <= self.cfg.max_match_cost:
                matches[int(region_index)] = IdMatch(int(candidate_index), cost,
                                                     relations[region_index][candidate_index], "hungarian")
        if self.cfg.allow_shared_ids:
            for region_index in range(len(regions)):
                if region_index in matches:
                    continue
                best = int(np.argmin(cost_matrix[region_index]))
                cost = float(cost_matrix[region_index, best])
                if cost <= self.cfg.max_match_cost * self.cfg.shared_id_cost_factor:
                    matches[region_index] = IdMatch(best, cost, relations[region_index][best], "shared")
        return matches

    # ------------------------------------------------------------ rendering
    def _choose_zoom(self, region):
        minimum_zoom = self.cfg.min_render_dpi / 72.0
        maximum_zoom = self.cfg.max_render_dpi / 72.0
        target = region.native_pixels_per_point if region.native_pixels_per_point > 0 else minimum_zoom
        zoom = min(max(target, minimum_zoom), maximum_zoom)
        longest_side_pt = max(region.rect.width, region.rect.height)
        if longest_side_pt * zoom > self.cfg.crop_max_side_px:
            zoom = self.cfg.crop_max_side_px / longest_side_pt
        return float(zoom)

    @staticmethod
    def _render_clip(page, rect, zoom):
        fitz = _fitz()
        pixmap = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), clip=rect, alpha=False, colorspace=fitz.csRGB)
        return pixmap_to_rgb(pixmap)

    def _inpaint_overlay_text(self, rgb, region_rect, zoom, words):
        """Remove text drawn over a photo (overlay labels) so it does not pollute the texture features."""
        import math

        import cv2
        import numpy as np
        fitz = _fitz()
        height, width = rgb.shape[:2]
        mask = np.zeros((height, width), dtype=np.uint8)
        for word in words:
            word_rect = fitz.Rect(word[0], word[1], word[2], word[3])
            overlap = word_rect & region_rect
            if overlap.is_empty or overlap.get_area() < 0.5 * max(word_rect.get_area(), 1e-6):
                continue
            padding = max(2, int(round(0.15 * word_rect.height * zoom)))
            x0 = max(0, int(math.floor((word_rect.x0 - region_rect.x0) * zoom)) - padding)
            y0 = max(0, int(math.floor((word_rect.y0 - region_rect.y0) * zoom)) - padding)
            x1 = min(width, int(math.ceil((word_rect.x1 - region_rect.x0) * zoom)) + padding)
            y1 = min(height, int(math.ceil((word_rect.y1 - region_rect.y0) * zoom)) + padding)
            if x1 > x0 and y1 > y0:
                mask[y0:y1, x0:x1] = 255
        covered_fraction = float(mask.mean()) / 255.0
        if covered_fraction == 0.0 or covered_fraction > self.cfg.inpaint_max_area_fraction:
            return rgb, False
        radius = max(3, int(round(3 * zoom)))
        bgr = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
        restored = cv2.inpaint(bgr, mask, radius, cv2.INPAINT_TELEA)
        return cv2.cvtColor(restored, cv2.COLOR_BGR2RGB), True


class LineageTracer:
    """Answer 'where did this result come from?' and prove the crop still matches its PDF page."""

    def __init__(self, cfg, store, extractor, guard):
        self.cfg = cfg
        self.store = store
        self.extractor = extractor
        self.guard = guard

    def lineage(self, item_id):
        row = self.store.get_item(item_id)
        if row is None:
            raise KeyError(item_id)
        row["image_bbox"] = json.loads(row["image_bbox"])
        row["id_bbox"] = json.loads(row["id_bbox"]) if row["id_bbox"] else None
        return row

    @staticmethod
    def _open_page(pdf_path, page_number):
        fitz = _fitz()
        document = fitz.open(str(pdf_path))
        page = document.load_page(int(page_number) - 1)
        if page.rotation:
            page.remove_rotation()
        return document, page

    def verify(self, item_id):
        row = self.lineage(item_id)
        pdf_path = self.cfg.resolve(row["source_pdf"])
        crop_path = self.cfg.resolve(row["crop_filepath"])
        report = {"item_id": item_id, "product_id": row["product_id"], "source_pdf": row["source_pdf"],
                  "page_number": row["page_number"], "stored_sha256": row["sha256_hash"]}
        with self.guard.files(), _PYMUPDF_LOCK:
            report["pdf_present"] = pdf_path.is_file()
            report["pdf_sha256_matches"] = report["pdf_present"] and sha256_file(pdf_path) == row["pdf_sha256"]
            report["crop_file_present"] = crop_path.is_file()
            report["crop_file_sha256_matches"] = (report["crop_file_present"]
                                                  and sha256_file(crop_path) == row["sha256_hash"])
            if not report["pdf_present"]:
                report["rerendered_sha256_matches"] = False
                return report
            document, page = self._open_page(pdf_path, row["page_number"])
            with document:
                reset_mupdf_cache()
                fitz = _fitz()
                rect = fitz.Rect(row["image_bbox"])
                zoom = float(row["render_zoom"])
                rgb = self.extractor._render_clip(page, rect, zoom)
                if row["inpainted_overlay"]:
                    words = page.get_text("words", sort=True)
                    rgb, _ = self.extractor._inpaint_overlay_text(rgb, rect, zoom, words)
                rerendered_sha = sha256_bytes(encode_rgb(rgb, self.cfg.crop_image_format))
        report["rerendered_sha256_matches"] = rerendered_sha == row["sha256_hash"]
        return report

    def draw_provenance(self, item_id, zoom=1.5):
        """PNG of the source page with the image box (green) and its ID box (red) -> (path, png bytes)."""
        fitz = _fitz()
        row = self.lineage(item_id)
        pdf_path = self.cfg.resolve(row["source_pdf"])
        with self.guard.files(), _PYMUPDF_LOCK:
            if not pdf_path.is_file():
                raise FileNotFoundError(f"source PDF {row['source_pdf']} is not on the Volume")
            document, page = self._open_page(pdf_path, row["page_number"])
            with document:
                page.draw_rect(fitz.Rect(row["image_bbox"]), color=(0.0, 0.75, 0.2), width=2.5)
                if row["id_bbox"]:
                    page.draw_rect(fitz.Rect(row["id_bbox"]), color=(0.9, 0.1, 0.1), width=2.0)
                rgb = pixmap_to_rgb(page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), alpha=False,
                                                    colorspace=fitz.csRGB))
            png = encode_rgb(rgb, "png")
            output_path = self.cfg.backtrace_dir / f"{item_id}_provenance.png"
            atomic_write_bytes(output_path, png)
        return output_path, png


# ---- stage 2: DINOv2 + SigLIP (GPU, remote) + CIELAB (here) ------------------------------------------------------
class LocalFeatureExtractor:
    """The writer's half of the notebook's dual-T4 feature stage: crops are read from the Volume and prepared on
    this CPU (colour descriptor + uint8 network inputs), then each batch goes to the GPU pool's encode_catalog
    method. One batch is always in flight on the GPU while the next one is being prepared."""

    def __init__(self, cfg, store, guard, encode_submit, on_batch=None):
        self.cfg = cfg
        self.store = store
        self.guard = guard
        self.encode_submit = encode_submit   # (dino_list, siglip_list) -> handle with .get() -> (dino, siglip)
        self.on_batch = on_batch

    def _prepare(self, record, params):
        item_id, crop_filepath = record
        try:
            with self.guard.files():
                data = Path(self.cfg.resolve(crop_filepath)).read_bytes()
            rgb = load_rgb(data)
            descriptor = compute_lab_color_descriptor(rgb, params)
            dino_input, siglip_input = catalog_neural_inputs(rgb, self.cfg)
            color_meta = {"dominant_hex": descriptor.dominant_hex, "proportions": descriptor.proportions,
                          "dominant_lab": descriptor.dominant_lab}
            return {"ok": True, "item_id": item_id, "dino": dino_input, "siglip": siglip_input,
                    "color": descriptor.vector, "color_meta": color_meta}
        except Exception as exc:
            return {"ok": False, "item_id": item_id, "error": f"{type(exc).__name__}: {exc}"}

    def _store_batch(self, good, handle, versions):
        dino_vectors, siglip_vectors = handle.get()
        rows = []
        for position, sample in enumerate(good):
            item_id = sample["item_id"]
            rows.append(EmbeddingRow(item_id, "dino", versions["dino"], dino_vectors[position]))
            rows.append(EmbeddingRow(item_id, "siglip", versions["siglip"], siglip_vectors[position]))
            rows.append(EmbeddingRow(item_id, "color", versions["color"], sample["color"], sample["color_meta"]))
        self.store.upsert_embeddings(rows)  # checkpoint: one transaction per batch
        return len(good)

    def run(self):
        from concurrent.futures import ThreadPoolExecutor
        versions = local_feature_versions(self.cfg)
        pending = self.store.items_needing_pillars(versions, self.cfg.max_feature_attempts)
        if not pending:
            LOGGER.info("Local features: nothing to do")
            return 0
        LOGGER.info("Local features: %d item(s) pending", len(pending))
        params = ColorParams.from_config(self.cfg)
        batch_size = max(1, min(self.cfg.feature_batch_size, CATALOG_GPU_BATCH))
        completed = 0
        started = time.time()
        in_flight = None
        with ThreadPoolExecutor(max_workers=max(1, self.cfg.num_workers)) as pool:
            for batch in chunked(pending, batch_size):
                prepared = list(pool.map(lambda record: self._prepare(record, params), batch))
                good = [sample for sample in prepared if sample["ok"]]
                errors = [(sample["item_id"], sample["error"]) for sample in prepared if not sample["ok"]]
                if errors:
                    self.store.record_feature_errors(errors, LOCAL_PILLARS)
                    LOGGER.warning("%d crop(s) failed to load, e.g. %s", len(errors), errors[0])
                handle = None
                if good:
                    handle = self.encode_submit([sample["dino"] for sample in good],
                                                [sample["siglip"] for sample in good])
                if in_flight is not None:
                    completed += self._store_batch(*in_flight, versions)
                    self._report(completed, len(pending), started)
                in_flight = (good, handle) if handle is not None else None
            if in_flight is not None:
                completed += self._store_batch(*in_flight, versions)
                self._report(completed, len(pending), started)
        return completed

    def _report(self, completed, total, started):
        rate = completed / max(time.time() - started, 1e-6)
        LOGGER.info("Local features %d/%d (%.1f img/s)", completed, total, rate)
        if self.on_batch is not None:
            self.on_batch(completed, total)


# ---- stages 3-4: Vertex multimodal image vectors, Gemini material profiles, description vectors ------------------
def read_crop_jpeg(cfg, guard, crop_filepath, max_side: int) -> bytes:
    with guard.files():
        data = Path(cfg.resolve(crop_filepath)).read_bytes()
    return encode_rgb(resize_max_side(load_rgb(data), max_side), "jpeg", 92)


class VertexMultimodalImageEmbedder:
    """Optional 4th image pillar: Vertex multimodalembedding@001 (shares a space with its text embeddings)."""

    def __init__(self, cfg, store, manager, runner, guard, on_batch=None):
        self.cfg = cfg
        self.store = store
        self.manager = manager
        self.runner = runner
        self.guard = guard
        self.on_batch = on_batch

    def run(self):
        if self.manager is None or not self.cfg.enable_vertex_multimodal_embedding:
            return 0
        if "vertex_mm" in self.manager.disabled_features:
            return 0
        version = vertex_mm_version(self.cfg)
        pending = self.store.items_needing_pillars({"vertex_mm": version}, self.cfg.max_feature_attempts)
        if not pending:
            LOGGER.info("Vertex multimodal embeddings: nothing to do")
            return 0
        LOGGER.info("Vertex multimodal embeddings: %d item(s) pending", len(pending))
        completed = 0
        for batch in chunked(pending, self.cfg.checkpoint_every):
            results = self.runner.run(self._embed_batch(batch))
            rows = []
            errors = []
            unavailable = 0
            for item_id, vector, error in results:
                if vector is not None:
                    rows.append(EmbeddingRow(item_id, "vertex_mm", version, vector))
                else:
                    errors.append((item_id, f"{type(error).__name__}: {error}"))
                    if is_model_unavailable_error(error) or error_status_code(error) == 403:
                        unavailable += 1
            if rows:
                self.store.upsert_embeddings(rows)
            if errors:
                self.store.record_feature_errors(errors, ("vertex_mm",))
            completed += len(rows)
            LOGGER.info("Vertex multimodal %d/%d", completed, len(pending))
            if self.on_batch is not None:
                self.on_batch(completed, len(pending))
            if unavailable == len(batch):
                LOGGER.warning("multimodalembedding unavailable for this project; disabling the pillar this session.")
                self.manager.disabled_features.add("vertex_mm")
                break
        return completed

    async def _embed_batch(self, batch):
        semaphore = asyncio.Semaphore(self.cfg.vertex_mm_concurrency)

        async def embed_one(item_id, crop_path):
            async with semaphore:
                try:
                    image_bytes = await asyncio.to_thread(read_crop_jpeg, self.cfg, self.guard, crop_path, 1024)
                    result = await self.manager.multimodal_embed(image_bytes=image_bytes)
                    return item_id, result["image"], None
                except Exception as exc:
                    return item_id, None, exc

        tasks = [embed_one(item_id, crop_path) for item_id, crop_path in batch]
        return await asyncio.gather(*tasks)


def format_dominant_colors(color_meta):
    if not color_meta:
        return "not measured"
    parts = []
    for hex_code, proportion in zip(color_meta.get("dominant_hex", []), color_meta.get("proportions", [])):
        parts.append(f"{hex_code} ({proportion * 100:.0f}%)")
    return ", ".join(parts) if parts else "not measured"


def compose_search_document(profile, dominant_hex=None):
    """The text that gets embedded: every field that helps a text query find this swatch."""
    secondary = ", ".join(profile.get("secondary_finishes") or [])
    keywords = ", ".join(profile.get("search_keywords") or [])
    lines = [
        f"Material: {profile.get('material_category')} - {profile.get('material_subtype')}",
        f"Finish: {profile.get('surface_finish')}" + (f" (also {secondary})" if secondary else ""),
        f"Grain / pattern: {profile.get('grain_or_pattern_description')}",
        f"Pattern scale: {profile.get('pattern_scale')}",
        f"Colour: {profile.get('color_palette_description')}",
        f"Specular: {profile.get('specular_behavior')}",
        f"Feel: {profile.get('micro_surface_feel')}",
        f"Keywords: {keywords}",
        f"Render description: {profile.get('nano_banana_render_prompt')}",
    ]
    if dominant_hex:
        lines.insert(5, "Measured colours: " + ", ".join(dominant_hex))
    return "\n".join(lines)


def describe_finish_reason(response):
    try:
        candidate = response.candidates[0]
        reason = getattr(candidate, "finish_reason", None)
        return getattr(reason, "name", str(reason))
    except Exception:
        return "NO_CANDIDATES"


def parse_structured_response(response, schema):
    parsed = getattr(response, "parsed", None)
    if isinstance(parsed, schema):
        return parsed
    if isinstance(parsed, dict):
        return schema.model_validate(parsed)
    text = None
    with contextlib.suppress(Exception):
        text = response.text
    if text:
        cleaned = text.strip()
        if cleaned.startswith("```"):
            cleaned = cleaned.strip("`")
            cleaned = cleaned[cleaned.find("{"):]
        return schema.model_validate_json(cleaned)
    finish_reason = describe_finish_reason(response)
    permanent = {"SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "MAX_TOKENS", "RECITATION", "SPII"}
    raise EmptyModelResponse(f"No structured output (finish_reason={finish_reason})",
                             retryable=finish_reason not in permanent)


def caption_config(cfg, model_name):
    from google.genai import types as genai_types
    thinking_config = None
    if model_name.startswith("gemini-2.5") and cfg.caption_thinking_budget is not None:
        thinking_config = genai_types.ThinkingConfig(thinking_budget=cfg.caption_thinking_budget)
    return genai_types.GenerateContentConfig(
        system_instruction=CAPTION_SYSTEM_PROMPT,
        response_mime_type="application/json",
        response_schema=material_profile_model(),
        temperature=cfg.caption_temperature,
        max_output_tokens=cfg.caption_max_output_tokens,
        thinking_config=thinking_config,
    )


async def describe_material(manager, cfg, image_bytes, product_id, color_meta):
    """Gemini structured material profile of one JPEG -> (MaterialProfile, model name). Shared by the catalogue
    captioning stage and photo queries."""
    from google.genai import types as genai_types
    user_prompt = CAPTION_USER_TEMPLATE.format(product_id=product_id or "unknown",
                                               colors=format_dominant_colors(color_meta))
    contents = [genai_types.Part.from_bytes(data=image_bytes, mime_type="image/jpeg"), user_prompt]
    model_name, response = await manager.generate_content_with_fallback(
        "caption", cfg.caption_model_candidates, contents, lambda name: caption_config(cfg, name))
    return parse_structured_response(response, material_profile_model()), model_name


@dataclass
class CaptionResult:
    item_id: str
    caption_version: str
    status: str
    model: Optional[str]
    profile: Optional[dict]
    search_text: Optional[str]
    error: Optional[str]


class GeminiMaterialSynthesizer:
    def __init__(self, cfg, store, manager, runner, guard, on_checkpoint=None):
        self.cfg = cfg
        self.store = store
        self.manager = manager
        self.runner = runner
        self.guard = guard
        self.on_checkpoint = on_checkpoint
        self.caption_version = compute_caption_version(cfg)

    async def _caption_one(self, record, color_meta, semaphore):
        async with semaphore:
            item_id = record["item_id"]
            try:
                image_bytes = await asyncio.to_thread(read_crop_jpeg, self.cfg, self.guard, record["crop_filepath"],
                                                      self.cfg.caption_image_max_side_px)
                profile, model_name = await describe_material(self.manager, self.cfg, image_bytes,
                                                              record["product_id"], color_meta)
                profile_dict = profile.model_dump(mode="json")
                dominant_hex = color_meta.get("dominant_hex") if color_meta else None
                return CaptionResult(item_id, self.caption_version, "ok", model_name, profile_dict,
                                     compose_search_document(profile_dict, dominant_hex), None)
            except Exception as exc:
                return CaptionResult(item_id, self.caption_version, "error", None, None, None,
                                     f"{type(exc).__name__}: {str(exc)[:900]}")

    async def _caption_batch(self, batch, color_meta_by_item):
        semaphore = asyncio.Semaphore(self.cfg.caption_concurrency)
        tasks = [self._caption_one(record, color_meta_by_item.get(record["item_id"]), semaphore) for record in batch]
        return await asyncio.gather(*tasks)

    def run(self):
        pending = self.store.pending_captions(self.caption_version, self.cfg.max_caption_attempts)
        if not pending:
            LOGGER.info("Gemini captions: nothing to do (version %s)", self.caption_version)
            return 0
        LOGGER.info("Gemini captions: %d item(s) pending, checkpoint every %d", len(pending), self.cfg.checkpoint_every)
        color_meta_by_item = self.store.color_meta_map(local_feature_versions(self.cfg)["color"])
        succeeded = 0
        failed = 0
        for batch in chunked(pending, self.cfg.checkpoint_every):
            results = self.runner.run(self._caption_batch(batch, color_meta_by_item))
            self.store.save_captions(results)  # checkpoint
            for result in results:
                if result.status == "ok":
                    succeeded += 1
                else:
                    failed += 1
                    LOGGER.warning("Caption failed for %s: %s", result.item_id, (result.error or "")[:200])
            if self.on_checkpoint is not None:
                self.on_checkpoint(succeeded + failed, len(pending))
            LOGGER.info("Gemini captions: %d ok, %d failed, %d/%d processed", succeeded, failed,
                        succeeded + failed, len(pending))
        return succeeded


class DescriptionEmbeddingIndexer:
    def __init__(self, cfg, store, manager, runner, on_batch=None):
        self.cfg = cfg
        self.store = store
        self.manager = manager
        self.runner = runner
        self.on_batch = on_batch

    async def _embed_batch(self, batch):
        semaphore = asyncio.Semaphore(self.cfg.text_embedding_concurrency)

        async def embed_one(item_id, text):
            async with semaphore:
                try:
                    return item_id, await self.manager.embed_text(text, "RETRIEVAL_DOCUMENT"), None
                except Exception as exc:
                    return item_id, None, exc

        return await asyncio.gather(*[embed_one(row["item_id"], row["search_text"]) for row in batch])

    def run(self):
        versions = compute_feature_versions(self.cfg)
        pending = self.store.pending_text_embeddings(versions["text"], compute_caption_version(self.cfg),
                                                     self.cfg.max_feature_attempts)
        if not pending:
            LOGGER.info("Description embeddings: nothing to do")
            return 0
        LOGGER.info("Description embeddings: %d item(s) pending", len(pending))
        completed = 0
        for batch in chunked(pending, self.cfg.checkpoint_every):
            results = self.runner.run(self._embed_batch(batch))
            rows = []
            errors = []
            for item_id, vector, error in results:
                if vector is not None:
                    rows.append(EmbeddingRow(item_id, "text", versions["text"], vector))
                else:
                    errors.append((item_id, f"{type(error).__name__}: {error}"))
            if rows:
                self.store.upsert_embeddings(rows)
            if errors:
                self.store.record_feature_errors(errors, ("text",))
            completed += len(rows)
            LOGGER.info("Description embeddings %d/%d", completed, len(pending))
            if self.on_batch is not None:
                self.on_batch(completed, len(pending))
        return completed


# ---- stage 5: hybrid multi-vector retrieval (FAISS + weighted scores + RRF) ---------------------------------------
@dataclass
class PillarIndex:
    pillar: str
    feature_version: str
    item_ids: List[str]
    row_of: Dict[str, int]
    matrix: Any
    faiss_index: Any
    fingerprint: str

    def search(self, query_vector, k):
        import numpy as np
        k = min(int(k), len(self.item_ids))
        if k <= 0:
            return [], np.zeros(0, dtype=np.float32)
        query = np.ascontiguousarray(query_vector.reshape(1, -1), dtype=np.float32)
        similarities, row_ids = self.faiss_index.search(query, k)
        found_ids = []
        found_similarities = []
        for row_id, similarity in zip(row_ids[0], similarities[0]):
            if row_id >= 0:
                found_ids.append(self.item_ids[int(row_id)])
                found_similarities.append(float(similarity))
        return found_ids, np.asarray(found_similarities, dtype=np.float32)

    def similarities_for(self, query_vector, item_ids):
        """Exact cosine for given items (NaN where this pillar has no vector)."""
        import numpy as np
        result = np.full(len(item_ids), np.nan, dtype=np.float32)
        positions = []
        rows = []
        for position, item_id in enumerate(item_ids):
            row = self.row_of.get(item_id)
            if row is not None:
                positions.append(position)
                rows.append(row)
        if rows:
            result[np.asarray(positions)] = self.matrix[np.asarray(rows)] @ query_vector.astype(np.float32)
        return result


class MultiVectorIndex:
    """persist=True (writer): FAISS files are written to <catalog>/index/ on the Volume. persist=False (GPU
    containers): a matching file on the Volume is read, anything else is built in memory and never written."""

    def __init__(self, cfg, store, guard=None, persist: bool = True):
        import pandas as pd
        self.cfg = cfg
        self.store = store
        self.guard = guard if guard is not None else VolumeGuard(None)
        self.persist = persist
        self.pillars = {}
        self.catalog = pd.DataFrame()
        self.feature_versions = {}

    def build_or_load(self, feature_versions):
        self.feature_versions = dict(feature_versions)
        self.catalog = self.store.catalog_frame(self.feature_versions, only_ok=True)
        if self.persist:
            with self.guard.files():
                self.cfg.index_dir.mkdir(parents=True, exist_ok=True)
        self.pillars = {}
        for pillar, version in self.feature_versions.items():
            item_ids, matrix = self.store.fetch_embeddings(pillar, version)
            if not item_ids:
                continue
            self.pillars[pillar] = self._load_or_build(pillar, version, item_ids, matrix)
        summary = ", ".join(f"{name}={len(index.item_ids)}x{index.matrix.shape[1]}" for name, index in self.pillars.items())
        LOGGER.info("Index ready: %d catalogue items | %s", len(self.catalog), summary or "no vectors")
        return self

    def _load_or_build(self, pillar, version, item_ids, matrix):
        import faiss
        import numpy as np
        digest = hashlib.sha256()
        digest.update("\n".join(item_ids).encode("utf-8"))
        digest.update(version.encode("utf-8"))
        digest.update(self.cfg.faiss_index_type.encode("utf-8"))
        digest.update(matrix.tobytes())
        fingerprint = digest.hexdigest()[:20]
        index_path = self.cfg.index_dir / f"{pillar}.faiss"
        meta_path = self.cfg.index_dir / f"{pillar}.meta.json"
        faiss_index = None
        with self.guard.files():
            if index_path.exists() and meta_path.exists():
                with contextlib.suppress(Exception):
                    meta = json.loads(meta_path.read_text())
                    if meta.get("fingerprint") == fingerprint:
                        faiss_index = faiss.read_index(str(index_path))
        if faiss_index is None:
            dimension = int(matrix.shape[1])
            if self.cfg.faiss_index_type == "hnsw":
                base_index = faiss.IndexHNSWFlat(dimension, self.cfg.hnsw_m, faiss.METRIC_INNER_PRODUCT)
                base_index.hnsw.efConstruction = 200
                base_index.hnsw.efSearch = 128
            else:
                base_index = faiss.IndexFlatIP(dimension)
            faiss_index = faiss.IndexIDMap2(base_index)
            faiss_index.add_with_ids(matrix, np.arange(len(item_ids), dtype=np.int64))
            if self.persist:
                with self.guard.files():
                    temporary_index_path = index_path.with_name(index_path.name + ".tmp")
                    faiss.write_index(faiss_index, str(temporary_index_path))
                    replace_file(temporary_index_path, index_path)
                    meta = {"pillar": pillar, "feature_version": version, "fingerprint": fingerprint,
                            "count": len(item_ids), "dimension": dimension, "index_type": self.cfg.faiss_index_type,
                            "built_at": utc_now_iso()}
                    atomic_write_bytes(meta_path, json.dumps(meta, indent=2).encode("utf-8"))
                    atomic_write_bytes(self.cfg.index_dir / f"{pillar}.ids.json", json.dumps(item_ids).encode("utf-8"))
                LOGGER.info("Built FAISS %s index for '%s' (%d vectors)", self.cfg.faiss_index_type, pillar,
                            len(item_ids))
        row_of = {}
        for row, item_id in enumerate(item_ids):
            row_of[item_id] = row
        return PillarIndex(pillar, version, list(item_ids), row_of, matrix, faiss_index, fingerprint)


@dataclass
class PreparedQuery:
    original_rgb: Any
    rectified_rgb: Any
    method: str
    quad: Optional[List[List[float]]]


class QueryPhotoPreprocessor:
    """Phone photo -> rectified swatch: perspective-correct a detected card/sample, else center-crop."""

    def __init__(self, cfg):
        self.cfg = cfg

    @staticmethod
    def _order_corners(points):
        import numpy as np
        sums = points.sum(axis=1)
        differences = np.diff(points, axis=1).ravel()
        top_left = points[np.argmin(sums)]
        bottom_right = points[np.argmax(sums)]
        top_right = points[np.argmin(differences)]
        bottom_left = points[np.argmax(differences)]
        return np.array([top_left, top_right, bottom_right, bottom_left], dtype=np.float32)

    def detect_quad(self, rgb):
        import cv2
        import numpy as np
        height, width = rgb.shape[:2]
        scale = min(1.0, 1024.0 / max(height, width))
        small = cv2.resize(rgb, (int(width * scale), int(height * scale)), interpolation=cv2.INTER_AREA) if scale < 1 else rgb
        gray = cv2.GaussianBlur(cv2.cvtColor(small, cv2.COLOR_RGB2GRAY), (5, 5), 0)
        edges = cv2.dilate(cv2.Canny(gray, 50, 150), np.ones((3, 3), np.uint8), iterations=2)
        contour_result = cv2.findContours(edges, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
        contours = contour_result[0] if len(contour_result) == 2 else contour_result[1]
        image_area = float(small.shape[0] * small.shape[1])
        best_quad = None
        best_area = 0.0
        for contour in sorted(contours, key=cv2.contourArea, reverse=True)[:15]:
            perimeter = cv2.arcLength(contour, True)
            approx = cv2.approxPolyDP(contour, 0.02 * perimeter, True)
            if len(approx) != 4 or not cv2.isContourConvex(approx):
                continue
            area = float(cv2.contourArea(approx))
            if area < self.cfg.rectify_min_area_fraction * image_area or area > 0.97 * image_area:
                continue
            corners = self._order_corners(approx.reshape(4, 2).astype(np.float32))
            side_lengths = [np.linalg.norm(corners[index] - corners[(index + 1) % 4]) for index in range(4)]
            if min(side_lengths) < 0.2 * max(side_lengths):
                continue
            if area > best_area:
                best_area = area
                best_quad = corners / scale
        return best_quad

    @staticmethod
    def warp_quad(rgb, corners):
        import cv2
        import numpy as np
        top_left, top_right, bottom_right, bottom_left = corners
        width = int(round(max(np.linalg.norm(bottom_right - bottom_left), np.linalg.norm(top_right - top_left))))
        height = int(round(max(np.linalg.norm(top_right - bottom_right), np.linalg.norm(top_left - bottom_left))))
        width = max(width, 16)
        height = max(height, 16)
        destination = np.array([[0, 0], [width - 1, 0], [width - 1, height - 1], [0, height - 1]], dtype=np.float32)
        matrix = cv2.getPerspectiveTransform(corners.astype(np.float32), destination)
        warped = cv2.warpPerspective(rgb, matrix, (width, height), flags=cv2.INTER_CUBIC)
        inset_x = int(round(width * 0.03))
        inset_y = int(round(height * 0.03))
        return warped[inset_y: height - inset_y, inset_x: width - inset_x]

    def center_crop(self, rgb):
        height, width = rgb.shape[:2]
        fraction = self.cfg.query_center_crop_fraction
        crop_height = max(16, int(round(height * fraction)))
        crop_width = max(16, int(round(width * fraction)))
        top = (height - crop_height) // 2
        left = (width - crop_width) // 2
        return rgb[top: top + crop_height, left: left + crop_width]

    def prepare(self, source):
        import numpy as np
        rgb = load_rgb(source)
        quad = self.detect_quad(rgb)
        if quad is not None:
            rectified = np.ascontiguousarray(self.warp_quad(rgb, quad))
            return PreparedQuery(rgb, rectified, "perspective_rectified", quad.round(1).tolist())
        return PreparedQuery(rgb, np.ascontiguousarray(self.center_crop(rgb)), "center_crop", None)


@dataclass
class QuerySignal:
    name: str
    pillar: str
    group: str
    vector: Any


def prepare_query_photo(rgb, cfg) -> dict:
    """CPU half of a photo query: rectify, colour descriptor, network inputs, and the JPEG Vertex AI sees."""
    prepared = QueryPhotoPreprocessor(cfg).prepare(rgb)
    rectified = prepared.rectified_rgb
    color = compute_lab_color_descriptor(rectified, ColorParams.from_config(cfg))
    dino_input, siglip_input = catalog_neural_inputs(rectified, cfg)
    jpeg = encode_rgb(resize_max_side(rectified, 1024), "jpeg", 92)
    return {"prepared": prepared, "color": color, "dino": dino_input, "siglip": siglip_input, "jpeg": jpeg}


def local_photo_signals(engine, query: dict, tta_hflip: bool) -> list:
    """GPU half: DINOv2 + SigLIP image vectors, plus the colour vector computed on the CPU."""
    dino_vectors, siglip_vectors = engine.encode_prepared([query["dino"]], [query["siglip"]], tta_hflip=tta_hflip)
    return [QuerySignal("dino_image", "dino", "dino", dino_vectors[0]),
            QuerySignal("siglip_image", "siglip", "mm", siglip_vectors[0]),
            QuerySignal("color_image", "color", "color", query["color"].vector)]


@dataclass
class SearchResult:
    records: List[dict]
    signal_names: List[str]
    signal_weights: Dict[str, float]
    query_info: dict
    pool_item_ids: List[str]
    signal_ranks: Dict[str, Any]
    fused_order: Any


class HybridRetriever:
    """The notebook's fusion (per-signal RRF + min-max linear, group weights split over the signals present). The
    query encoding is done by the caller (GPU, CPU and Vertex AI parts run in different places), so this class
    only ranks: rank(signals, ...)."""

    def __init__(self, cfg, index):
        self.cfg = cfg
        self.index = index

    def _group_weights(self, has_photo, has_text, override):
        if override is not None:
            return dict(override)
        if has_photo and has_text:
            combined = {}
            for weights in (self.cfg.photo_weights, self.cfg.text_weights):
                for group, weight in weights.items():
                    combined[group] = combined.get(group, 0.0) + 0.5 * weight
            return combined
        if has_photo:
            return dict(self.cfg.photo_weights)
        return dict(self.cfg.text_weights)

    @staticmethod
    def _signal_weights(signals, group_weights):
        present_groups = {}
        for signal in signals:
            if group_weights.get(signal.group, 0.0) > 0:
                present_groups[signal.group] = present_groups.get(signal.group, 0) + 1
        total = sum(group_weights[group] for group in present_groups)
        weights = {}
        for signal in signals:
            if signal.group in present_groups and total > 0:
                weights[signal.name] = group_weights[signal.group] / total / present_groups[signal.group]
        return weights

    def _candidate_pool(self, signals, filters):
        catalog = self.index.catalog
        allowed = catalog
        if filters:
            for column, accepted in filters.items():
                if column not in catalog.columns:
                    raise ApiError(422, "invalid_filters", f"unknown filter column {column!r}")
                accepted_values = accepted if isinstance(accepted, (list, tuple, set)) else [accepted]
                allowed = allowed[allowed[column].isin(list(accepted_values))]
        allowed_ids = list(allowed["item_id"])
        if len(allowed_ids) <= self.cfg.exhaustive_search_max_items:
            return sorted(allowed_ids)
        allowed_set = set(allowed_ids)
        pool = set()
        multiplier = 4 if filters else 1
        for signal in signals:
            found_ids, _ = self.index.pillars[signal.pillar].search(signal.vector, self.cfg.candidate_pool_size * multiplier)
            pool.update(item_id for item_id in found_ids if item_id in allowed_set)
        return sorted(pool)

    def rank(self, signals, has_photo, has_text, top_k=None, weights=None, filters=None, fusion_mode=None,
             query_info=None, crop_url_prefix: Optional[str] = None) -> SearchResult:
        import numpy as np
        if self.index.catalog.empty:
            raise ApiError(409, "catalog_empty", "The catalogue index is empty; run an ingest first.")
        top_k = top_k or self.cfg.top_k
        fusion_mode = fusion_mode or self.cfg.fusion_mode
        query_info = query_info if query_info is not None else {}
        signals = [signal for signal in signals if signal.pillar in self.index.pillars]
        group_weights = self._group_weights(has_photo, has_text, weights)
        signal_weights = self._signal_weights(signals, group_weights)
        signals = [signal for signal in signals if signal.name in signal_weights]
        if not signals:
            raise ApiError(422, "no_signal", "No usable query signal: the matching pillars have no indexed vectors.")

        pool = self._candidate_pool(signals, filters)
        if not pool:
            return SearchResult([], [], signal_weights, query_info, [], {}, np.zeros(0, dtype=np.int64))
        pool_size = len(pool)
        rrf_total = np.zeros(pool_size, dtype=np.float64)
        linear_total = np.zeros(pool_size, dtype=np.float64)
        raw_similarities = {}
        signal_ranks = {}
        weight_sum = sum(signal_weights.values())
        for signal in signals:
            similarities = self.index.pillars[signal.pillar].similarities_for(signal.vector, pool)
            valid = ~np.isnan(similarities)
            sortable = np.where(valid, similarities, -np.inf)
            order = np.argsort(-sortable, kind="stable")
            ranks = np.empty(pool_size, dtype=np.int64)
            ranks[order] = np.arange(1, pool_size + 1)
            ranks[~valid] = pool_size + 1
            weight = signal_weights[signal.name]
            rrf_total += np.where(valid, weight / (self.cfg.rrf_k + ranks), 0.0)
            normalised = np.zeros(pool_size, dtype=np.float64)
            if valid.any():
                lowest = float(np.nanmin(similarities))
                highest = float(np.nanmax(similarities))
                if highest - lowest > 1e-9:
                    normalised[valid] = (similarities[valid] - lowest) / (highest - lowest)
                else:
                    normalised[valid] = 1.0
            linear_total += weight * normalised
            raw_similarities[signal.name] = similarities
            signal_ranks[signal.name] = ranks
        rrf_score = rrf_total / (weight_sum / (self.cfg.rrf_k + 1))
        linear_score = linear_total / weight_sum
        if fusion_mode == "rrf":
            final_score = rrf_score
        elif fusion_mode == "linear":
            final_score = linear_score
        else:
            final_score = self.cfg.hybrid_lambda * rrf_score + (1.0 - self.cfg.hybrid_lambda) * linear_score
        fused_order = np.argsort(-final_score, kind="stable")

        records = []
        seen_products = set()
        catalog = self.index.catalog
        for position in fused_order:
            item_id = pool[int(position)]
            row = catalog.loc[item_id]
            product_key = row["product_id"] if isinstance(row["product_id"], str) else item_id
            if self.cfg.dedupe_results_by_product and product_key in seen_products:
                continue
            seen_products.add(product_key)
            record = {
                "rank": len(records) + 1, "final_score": round(float(final_score[position]), 5),
                "rrf_score": round(float(rrf_score[position]), 5), "linear_score": round(float(linear_score[position]), 5),
                "product_id": row["product_id"] if isinstance(row["product_id"], str) else "UNMATCHED",
                "item_id": item_id, "source_pdf": row["source_pdf"], "page_number": int(row["page_number"]),
                "image_bbox": row["image_bbox"], "id_bbox": row["id_bbox"], "match_type": row["match_type"],
                "crop_filepath": row["crop_filepath"], "sha256_hash": row["sha256_hash"],
                "material_category": row.get("material_category"), "surface_finish": row.get("surface_finish"),
                "dominant_hex": row.get("dominant_hex"),
                "nano_banana_render_prompt": row.get("nano_banana_render_prompt"),
            }
            if crop_url_prefix:
                record["crop_url"] = f"{crop_url_prefix}/{item_id}/crop"
            for signal_name, similarities in raw_similarities.items():
                value = similarities[position]
                record[f"sim_{signal_name}"] = None if np.isnan(value) else round(float(value), 4)
                record[f"rank_{signal_name}"] = int(signal_ranks[signal_name][position])
            records.append(record)
            if len(records) >= top_k:
                break
        return SearchResult(records, [signal.name for signal in signals], signal_weights, query_info,
                            pool, signal_ranks, fused_order)

    def lookup_product(self, product_id):
        catalog = self.index.catalog
        if catalog.empty:
            return catalog
        normalised = product_id.strip().upper() if self.cfg.uppercase_product_ids else product_id.strip()
        return catalog[catalog["product_id"] == normalised]


# ---- Nano Banana material rendering ------------------------------------------------------------------------------
def nearest_aspect_ratio(width, height):
    import math
    target = math.log(max(width, 1) / max(height, 1))
    best = "1:1"
    best_distance = float("inf")
    for ratio in SUPPORTED_ASPECT_RATIOS:
        numerator, denominator = ratio.split(":")
        distance = abs(math.log(float(numerator) / float(denominator)) - target)
        if distance < best_distance:
            best = ratio
            best_distance = distance
    return best


def model_supports_image_size(model_name):
    return "2.5-flash-image" not in model_name


def extract_generated_image(response):
    image_bytes = None
    mime_type = None
    texts = []
    for candidate in (response.candidates or []):
        content = getattr(candidate, "content", None)
        if content is None or not content.parts:
            continue
        for part in content.parts:
            if getattr(part, "thought", False):
                continue  # interim "thinking" images from Pro-tier models
            inline = getattr(part, "inline_data", None)
            if inline is not None and inline.data:
                image_bytes = inline.data
                mime_type = inline.mime_type or "image/png"
            elif getattr(part, "text", None):
                texts.append(part.text)
    if image_bytes is None:
        raise EmptyModelResponse(
            f"No image returned (finish_reason={describe_finish_reason(response)}); text={' '.join(texts)[:300]}",
            retryable=False)
    return image_bytes, mime_type, "\n".join(texts)


class NanoBananaRenderer:
    """Swatch (+ optional scene photo) -> photorealistic material render. Output image, its JSON metadata and the
    scene used go to <catalog>/renders/ on the Volume; the renders table records it."""

    def __init__(self, cfg, store, manager, runner, guard):
        self.cfg = cfg
        self.store = store
        self.manager = manager
        self.runner = runner
        self.guard = guard

    def _catalog_row(self, item_id):
        row = self.store.get_item(item_id)
        if row is None:
            raise KeyError(item_id)
        caption = self.store.query("SELECT profile_json FROM captions WHERE item_id = ? AND status = 'ok'", (item_id,))
        row["profile"] = json.loads(caption[0]["profile_json"]) if caption else {}
        color = self.store.query("SELECT extra_json FROM embeddings WHERE item_id = ? AND pillar = 'color'", (item_id,))
        row["color_meta"] = json.loads(color[0]["extra_json"]) if color and color[0]["extra_json"] else {}
        return row

    def build_instruction(self, row, has_scene, target_description, extra_instructions):
        profile = row["profile"]
        product_label = row["product_id"] or row["item_id"]
        hex_text = ", ".join(row["color_meta"].get("dominant_hex", [])) or "as seen in the swatch"
        material_prompt = profile.get("nano_banana_render_prompt") or (
            "Reproduce the swatch's exact weave/grain geometry, relief, roughness and colour variation.")
        scale_text = profile.get("pattern_scale") or "true real-world scale"
        finish_text = profile.get("surface_finish") or "as seen in the swatch"
        specular_text = profile.get("specular_behavior") or "as seen in the swatch"
        if has_scene:
            target = target_description or DEFAULT_SCENE_TARGET
            task = (f"IMAGE 1 is the reference material swatch (catalogue product {product_label}). "
                    f"IMAGE 2 is the target scene photo. Re-surface {target} in IMAGE 2 with the exact material "
                    f"from IMAGE 1, and keep everything else in IMAGE 2 unchanged (geometry, camera, background, "
                    f"other objects, framing).")
            lighting = ("Re-light the material physically under IMAGE 2's existing light: same light direction, "
                        "colour temperature, shadow softness and ambient occlusion.")
        else:
            category = profile.get("material_category") or ""
            target = target_description or DEFAULT_RENDER_OBJECTS.get(category, "a minimalist product surface")
            task = (f"IMAGE 1 is the reference material swatch (catalogue product {product_label}). Create a "
                    f"photorealistic product visualisation of {target}, finished in the exact material from IMAGE 1, "
                    f"in a neutral studio with a soft key light from the upper left and gentle fill.")
            lighting = "Use physically based shading; show the material's specular response at a grazing angle."
        lines = [
            "You are a photorealistic material-transfer renderer.",
            task,
            "Hard constraints:",
            "1. Preserve the swatch's micro-texture exactly: weave/grain geometry and direction, pore or yarn detail, "
            "relief depth. Do not simplify, smooth or invent pattern elements.",
            f"2. Preserve colour tone exactly; match {hex_text}. No stylisation, saturation boost or recolouring.",
            f"3. {lighting} Finish: {finish_text}. Specular behaviour: {specular_text}.",
            f"4. Map the material along the surface's perspective, curvature, folds and seams at physical scale "
            f"({scale_text}); no stretching, mirroring or visible tiling seams.",
            "5. No text, logos, labels or watermarks in the output.",
            f"Material description: {material_prompt}",
        ]
        if extra_instructions:
            lines.append(f"Additional direction: {extra_instructions}")
        lines.append("Return one photorealistic image.")
        return "\n".join(lines)

    def render(self, item_id, scene_jpeg=None, scene_label=None, target_description=None, extra_instructions="",
               aspect_ratio=None):
        """scene_jpeg: the scene already decoded, EXIF-rotated, resized to render_scene_max_side_px and JPEG-encoded
        (the API does that). Returns (metadata dict, image bytes, mime type)."""
        from datetime import datetime, timezone

        from google.genai import types as genai_types
        row = self._catalog_row(item_id)
        with self.guard.files():
            crop_bytes = Path(self.cfg.resolve(row["crop_filepath"])).read_bytes()
        swatch_rgb = resize_max_side(load_rgb(crop_bytes), self.cfg.render_swatch_max_side_px)
        swatch_bytes = encode_rgb(swatch_rgb, "png")
        if scene_jpeg is not None and aspect_ratio is None:
            scene_rgb = load_rgb(scene_jpeg)
            aspect_ratio = nearest_aspect_ratio(scene_rgb.shape[1], scene_rgb.shape[0])
        if aspect_ratio is None:
            aspect_ratio = "4:3"
        instruction = self.build_instruction(row, scene_jpeg is not None, target_description, extra_instructions)
        contents = [instruction, "IMAGE 1 - reference material swatch:",
                    genai_types.Part.from_bytes(data=swatch_bytes, mime_type="image/png")]
        if scene_jpeg is not None:
            contents.append("IMAGE 2 - target scene:")
            contents.append(genai_types.Part.from_bytes(data=scene_jpeg, mime_type="image/jpeg"))

        def render_config(model_name):
            if model_supports_image_size(model_name):
                image_config = genai_types.ImageConfig(aspect_ratio=aspect_ratio, image_size=self.cfg.render_image_size)
            else:
                image_config = genai_types.ImageConfig(aspect_ratio=aspect_ratio)
            return genai_types.GenerateContentConfig(response_modalities=["TEXT", "IMAGE"], image_config=image_config)

        model_name, response = self.runner.run(self.manager.generate_content_with_fallback(
            "render", self.cfg.image_model_candidates, contents, render_config))
        image_bytes, mime_type, model_text = extract_generated_image(response)

        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")
        render_id = f"{stamp}_{item_id}_{uuid.uuid4().hex[:6]}"
        extension = ".jpg" if "jpeg" in (mime_type or "") else ".png"
        output_path = self.cfg.renders_dir / f"{render_id}{extension}"
        metadata_path = self.cfg.renders_dir / f"{render_id}.json"
        scene_path = self.cfg.renders_dir / f"{render_id}_scene.jpg" if scene_jpeg is not None else None
        metadata = {
            "render_id": render_id, "created_at": utc_now_iso(), "model": model_name, "item_id": item_id,
            "product_id": row["product_id"], "source_pdf": row["source_pdf"], "page_number": row["page_number"],
            "image_bbox": json.loads(row["image_bbox"]), "crop_filepath": row["crop_filepath"],
            "crop_sha256": row["sha256_hash"], "scene": scene_label,
            "scene_file": self.cfg.relative(scene_path) if scene_path is not None else None,
            "output_file": self.cfg.relative(output_path), "mime_type": mime_type, "aspect_ratio": aspect_ratio,
            "image_size": self.cfg.render_image_size if model_supports_image_size(model_name) else None,
            "prompt": instruction, "model_text": model_text,
        }
        with self.guard.files():
            atomic_write_bytes(output_path, image_bytes)
            if scene_path is not None:
                atomic_write_bytes(scene_path, scene_jpeg)
            atomic_write_bytes(metadata_path, json.dumps(metadata, indent=2).encode("utf-8"))
        self.store.record_render({"render_id": render_id, "item_id": item_id, "product_id": row["product_id"],
                                  "model": model_name, "scene_path": metadata["scene_file"] or scene_label,
                                  "output_path": metadata["output_file"],
                                  "metadata_path": self.cfg.relative(metadata_path), "prompt": instruction})
        LOGGER.info("Rendered %s with %s -> %s", row["product_id"] or item_id, model_name, output_path)
        return metadata, image_bytes, mime_type


# ---- self-retrieval benchmark under simulated phone capture ------------------------------------------------------
class SyntheticPhoneCapture:
    """Simulate a phone photo of a printed swatch: tabletop, perspective, white-balance cast, uneven light, blur,
    sensor noise, JPEG. Used for the self-retrieval sanity benchmark."""

    def __init__(self, seed=0):
        import numpy as np
        self.random = np.random.default_rng(seed)

    def __call__(self, rgb):
        import cv2
        import numpy as np
        swatch = resize_max_side(rgb, 640)
        height, width = swatch.shape[:2]
        margin = int(0.25 * max(height, width))
        canvas_height = height + 2 * margin
        canvas_width = width + 2 * margin
        table_color = self.random.uniform(70, 170, size=3)
        canvas = np.ones((canvas_height, canvas_width, 3), np.float32) * table_color
        canvas += self.random.normal(0, 6, size=canvas.shape)
        source = np.array([[0, 0], [width - 1, 0], [width - 1, height - 1], [0, height - 1]], np.float32)
        jitter = self.random.uniform(-0.08, 0.08, size=(4, 2)) * np.array([width, height])
        destination = (source + margin + jitter).astype(np.float32)
        matrix = cv2.getPerspectiveTransform(source, destination)
        warped = cv2.warpPerspective(swatch.astype(np.float32), matrix, (canvas_width, canvas_height),
                                     flags=cv2.INTER_LINEAR)
        mask = cv2.warpPerspective(np.ones((height, width), np.float32), matrix, (canvas_width, canvas_height))
        image = canvas * (1 - mask[:, :, None]) + warped * mask[:, :, None]
        gains = self.random.uniform(0.9, 1.12, size=3)
        image = image * gains
        yy, xx = np.mgrid[0:canvas_height, 0:canvas_width].astype(np.float32)
        angle = self.random.uniform(0, 2 * np.pi)
        gradient = (np.cos(angle) * xx / canvas_width + np.sin(angle) * yy / canvas_height)
        image = image * (0.85 + 0.3 * (gradient - gradient.min()) / max(np.ptp(gradient), 1e-6))[:, :, None]
        gamma = self.random.uniform(0.85, 1.2)
        image = 255.0 * np.power(np.clip(image / 255.0, 0, 1), gamma)
        sigma = self.random.uniform(0.0, 1.0)
        if sigma > 0.2:
            image = cv2.GaussianBlur(image, (0, 0), sigma)
        image = image + self.random.normal(0, self.random.uniform(2, 5), size=image.shape)
        image_u8 = np.clip(image, 0, 255).astype(np.uint8)
        quality = int(self.random.uniform(60, 85))
        return load_rgb(encode_rgb(image_u8, "jpeg", quality))


def evaluate_self_retrieval(loaded, engine, guard, sample_size=40, seed=0) -> list:
    """Distort catalogue crops like phone photos and check each comes back as its own top match (local pillars
    only, like the notebook's benchmark). Rows: signal, recall@1, recall@5, mrr, queries."""
    import numpy as np
    catalog = loaded.index.catalog
    if catalog.empty:
        return []
    cfg = loaded.cfg
    sample_size = min(int(sample_size), len(catalog))
    choices = np.random.default_rng(seed).choice(np.asarray(list(catalog["item_id"]), dtype=object),
                                                 size=sample_size, replace=False)
    item_ids = [str(item_id) for item_id in choices]
    simulator = SyntheticPhoneCapture(seed)
    hits = {}
    for item_id in item_ids:
        with guard.files():
            data = Path(cfg.resolve(catalog.loc[item_id, "crop_filepath"])).read_bytes()
        query = prepare_query_photo(simulator(load_rgb(data)), cfg)
        with gpu_exclusive():
            signals = local_photo_signals(engine, query, cfg.query_tta_hflip)
        result = loaded.retriever.rank(signals, has_photo=True, has_text=False, top_k=10)
        truth_position = result.pool_item_ids.index(item_id)
        for signal_name, ranks in result.signal_ranks.items():
            hits.setdefault(signal_name, []).append(int(ranks[truth_position]))
        fused_rank = int(np.where(result.fused_order == truth_position)[0][0]) + 1
        hits.setdefault("FUSED", []).append(fused_rank)
    rows = []
    for signal_name, ranks in hits.items():
        ranks = np.asarray(ranks)
        rows.append({"signal": signal_name, "recall@1": float(np.mean(ranks <= 1)),
                     "recall@5": float(np.mean(ranks <= 5)), "mrr": float(np.mean(1.0 / ranks)),
                     "queries": int(len(ranks))})
    rows.sort(key=lambda row: row["mrr"], reverse=True)
    return rows


# ---- catalogue storage on the Modal Volume: one writer publishes, GPU containers read ----------------------------
class CatalogWorkspace:
    """The writer's view of one catalogue: the live SQLite database on local disk (WAL is not safe on a network
    filesystem), published to the Volume as a consistent snapshot plus the parquet exports and published.json."""

    def __init__(self, catalog, guard, state, data_root=DATA_ROOT, local_root=WRITER_LOCAL_ROOT):
        self.cfg = CatalogConfig(catalog=catalog, data_root=data_root)
        self.guard = guard
        self.state = state
        self.local_db = Path(local_root) / catalog / "state.sqlite"
        self.job_lock = threading.Lock()
        self._open_lock = threading.Lock()
        self.store = None
        self.version = None
        self._signature = None        # sha256 of the Volume's state.sqlite when we last copied / published it
        self._last_publish = 0.0

    def open(self, refresh: bool = False):
        """The live store. refresh=True (start of an ingest, after a Volume reload) re-copies the published snapshot
        when somebody else replaced it on the Volume (e.g. a Kaggle run uploaded with `modal volume put`)."""
        with self._open_lock:
            published = self.cfg.state_db_path
            with self.guard.files():
                signature = sha256_file(published) if published.is_file() else None
                replaced = (refresh and self.store is not None and signature is not None
                            and signature != self._signature)
                if replaced:
                    LOGGER.warning("state.sqlite of %s was replaced on the Volume; reloading it", self.cfg.catalog)
                    self.store.close()
                    self.store = None
                    for suffix in ("", "-wal", "-shm"):
                        with contextlib.suppress(FileNotFoundError):
                            Path(str(self.local_db) + suffix).unlink()
                if self.store is None:
                    self.local_db.parent.mkdir(parents=True, exist_ok=True)
                    if not self.local_db.exists() and signature is not None:
                        copy_into_place(published, self.local_db)
                    self._signature = signature
            if self.store is None:
                self.store = StateStore(self.local_db)
            return self.store

    def publish(self, reason: str, feature_versions: dict, force: bool = True) -> Optional[dict]:
        """Snapshot -> Volume (state.sqlite, manifest.parquet, page_audit.parquet, published.json), commit, then
        bump the version GPU containers watch. force=False only publishes if CATALOG_PUBLISH_EVERY_S has passed."""
        if self.store is None:
            return None
        now = time.time()
        if not force and now - self._last_publish < CATALOG_PUBLISH_EVERY_S:
            return None
        snapshot = self.local_db.with_name("publish.sqlite")
        self.store.backup_to(snapshot)
        summary = self.store.summary()
        version = str(time.time_ns())
        with self.guard.files():
            self.cfg.work_dir.mkdir(parents=True, exist_ok=True)
            copy_into_place(snapshot, self.cfg.state_db_path)
            item_count = self.store.export_manifest(self.cfg.manifest_path, self.cfg.page_audit_path,
                                                    feature_versions)
            info = {"catalog": self.cfg.catalog, "version": version, "updated_at": utc_now_iso(),
                    "reason": reason, "items": item_count, "summary": summary,
                    "feature_versions": feature_versions}
            atomic_write_bytes(self.cfg.published_path, json.dumps(info, indent=2).encode("utf-8"))
        self._signature = sha256_file(snapshot)   # what the Volume's state.sqlite now contains
        self.guard.commit()
        self.version = version
        self._last_publish = now
        try:
            self.state.put(f"catalog:{self.cfg.catalog}", version)
        except Exception:
            LOGGER.warning("could not write the catalogue version to the modal.Dict", exc_info=True)
        LOGGER.info("published %s v%s (%s): %s", self.cfg.catalog, version, reason, summary)
        return info

    def close(self):
        if self.store is not None:
            self.store.close()
            self.store = None


class JobReporter:
    """Ingest progress in the modal.Dict under job:<id> (throttled), read by GET /v1/jobs/{id} and the CLI."""

    def __init__(self, state, job_id, catalog):
        self.state = state
        self.key = f"job:{job_id}" if job_id else None
        self.status = {"job_id": job_id, "catalog": catalog, "state": "queued", "stage": None, "progress": None,
                       "created_at": utc_now_iso()}
        if self.key is not None:
            with contextlib.suppress(Exception):
                existing = state.get(self.key)
                if isinstance(existing, dict):
                    self.status.update(existing)
        self._last_put = 0.0

    def update(self, force: bool = False, **fields):
        self.status.update(fields)
        self.status["updated_at"] = utc_now_iso()
        if self.key is None:
            return
        now = time.time()
        if force or now - self._last_put >= 2.0:
            self._last_put = now
            try:
                self.state.put(self.key, dict(self.status))
            except Exception:
                LOGGER.warning("could not write job status", exc_info=True)

    def progress(self, stage: str, done: int, total: int, detail: Optional[str] = None):
        progress = {"done": int(done), "total": int(total)}
        if detail:
            progress["detail"] = detail
        self.update(stage=stage, progress=progress)


class CatalogWriterCore:
    """Everything the CatalogWriter container does, without Modal (so it runs in tests too): ingest (the notebook's
    five stages), render, verify, provenance. The only code that writes catalogue state to the Volume."""

    def __init__(self, guard, state, encode_submit, vertex, data_root=DATA_ROOT, local_root=WRITER_LOCAL_ROOT):
        self.guard = guard
        self.state = state
        self.encode_submit = encode_submit
        self.vertex = vertex
        self.data_root = data_root
        self.local_root = local_root
        self._workspaces = {}
        self._lock = threading.Lock()
        self._ingest_lock = threading.Lock()   # one ingest at a time per container (and so per deployment)

    def workspace(self, catalog) -> CatalogWorkspace:
        name = validate_catalog_name(catalog)
        with self._lock:
            workspace = self._workspaces.get(name)
            if workspace is None:
                workspace = CatalogWorkspace(name, self.guard, self.state, self.data_root, self.local_root)
                self._workspaces[name] = workspace
            return workspace

    def close(self):
        with self._lock:
            for workspace in self._workspaces.values():
                workspace.close()
        with contextlib.suppress(Exception):
            self.guard.commit()

    # ------------------------------------------------------------ ingest
    def ingest(self, catalog, job_id=None, pdf_names=None, use_vertex=True) -> dict:
        name = validate_catalog_name(catalog)
        job = JobReporter(self.state, job_id, name)
        if self._ingest_lock.locked():
            job.update(state="waiting", stage="queued behind another ingest", force=True)
        with self._ingest_lock:
            started = time.time()
            try:
                result = self._ingest(name, job, pdf_names, use_vertex)
            except Exception as exc:
                job.update(state="failed", error=f"{type(exc).__name__}: {str(exc)[:1500]}", force=True)
                raise
            result["seconds"] = round(time.time() - started, 1)
            job.update(state="done", stage="done", result=json_safe(result), force=True)
            return result

    def _ingest(self, name, job, pdf_names, use_vertex) -> dict:
        workspace = self.workspace(name)
        cfg = workspace.cfg
        job.update(state="running", stage="reloading the Volume", force=True)
        self.guard.commit()
        self.guard.reload()              # see PDFs uploaded (and committed) by other containers or the CLI
        store = workspace.open(refresh=True)
        with self.guard.files():
            cfg.ensure_dirs()
        feature_versions = compute_feature_versions(cfg)
        notes = []
        manager = None
        if use_vertex:
            manager = self.vertex.get()
            if manager is None:
                notes.append(f"Vertex AI skipped: {self.vertex.error}")
        timings = {}

        def checkpoint(reason):
            workspace.publish(reason, feature_versions, force=False)

        # Stage 1 -------------------------------------------------------------------------------------------------
        t0 = time.time()
        job.update(stage="1/5 PDF extraction", progress=None, force=True)

        def on_page(pdf_name, page_number, page_count):
            job.progress("1/5 PDF extraction", page_number, page_count, pdf_name)
            checkpoint("stage 1 checkpoint")

        pdfs = CatalogueExtractor(cfg, store, self.guard, on_page_done=on_page).run(pdf_names)
        workspace.publish("stage 1: PDF extraction", feature_versions)
        timings["extract"] = round(time.time() - t0, 1)

        # Stage 2 -------------------------------------------------------------------------------------------------
        t0 = time.time()
        job.update(stage="2/5 DINOv2 + SigLIP + CIELAB", progress=None, force=True)

        def on_features(done, total):
            job.progress("2/5 DINOv2 + SigLIP + CIELAB", done, total)
            checkpoint("stage 2 checkpoint")

        LocalFeatureExtractor(cfg, store, self.guard, self.encode_submit, on_batch=on_features).run()
        workspace.publish("stage 2: local features", feature_versions)
        timings["local_features"] = round(time.time() - t0, 1)

        # Stages 3-4 ----------------------------------------------------------------------------------------------
        if manager is not None:
            runner = self.vertex.runner
            t0 = time.time()
            job.update(stage="3/5 Vertex multimodal image vectors", progress=None, force=True)

            def on_mm(done, total):
                job.progress("3/5 Vertex multimodal image vectors", done, total)
                checkpoint("stage 3 checkpoint")

            VertexMultimodalImageEmbedder(cfg, store, manager, runner, self.guard, on_batch=on_mm).run()
            timings["vertex_mm"] = round(time.time() - t0, 1)

            t0 = time.time()
            job.update(stage="4/5 Gemini material profiles", progress=None, force=True)

            def on_captions(done, total):
                job.progress("4/5 Gemini material profiles", done, total)
                checkpoint("stage 4 checkpoint")

            GeminiMaterialSynthesizer(cfg, store, manager, runner, self.guard, on_checkpoint=on_captions).run()

            def on_text(done, total):
                job.progress("4/5 description vectors", done, total)
                checkpoint("stage 4 checkpoint")

            DescriptionEmbeddingIndexer(cfg, store, manager, runner, on_batch=on_text).run()
            workspace.publish("stage 4: Vertex AI pillars", feature_versions)
            timings["vertex"] = round(time.time() - t0, 1)

        # Stage 5 -------------------------------------------------------------------------------------------------
        t0 = time.time()
        job.update(stage="5/5 FAISS multi-vector index", progress=None, force=True)
        index = MultiVectorIndex(cfg, store, self.guard, persist=True).build_or_load(feature_versions)
        info = workspace.publish("ingest complete", feature_versions)
        timings["index"] = round(time.time() - t0, 1)
        pillars = {}
        for pillar, pillar_index in index.pillars.items():
            pillars[pillar] = {"count": len(pillar_index.item_ids), "dim": int(pillar_index.matrix.shape[1])}
        return {"catalog": name, "version": info["version"], "pdfs": pdfs, "summary": store.summary(),
                "pillars": pillars, "items": int(len(index.catalog)), "notes": notes, "timing_s": timings}

    # ------------------------------------------------------------ render / verify / provenance
    def render(self, catalog, item_id, scene_jpeg=None, scene_label=None, target_description=None,
               extra_instructions="", aspect_ratio=None) -> dict:
        workspace = self.workspace(catalog)
        store = workspace.open()
        manager = self.vertex.get()
        if manager is None:
            raise RuntimeError(f"Vertex AI unavailable: {self.vertex.error}")
        renderer = NanoBananaRenderer(workspace.cfg, store, manager, self.vertex.runner, self.guard)
        metadata, image_bytes, mime_type = renderer.render(item_id, scene_jpeg, scene_label, target_description,
                                                          extra_instructions, aspect_ratio)
        self.guard.commit()
        workspace.publish("render", compute_feature_versions(workspace.cfg))   # the renders row must not wait
        return {"render_id": metadata["render_id"], "model": metadata["model"], "mime_type": mime_type or "image/png",
                "image": image_bytes, "metadata": metadata}

    def _tracer(self, catalog):
        workspace = self.workspace(catalog)
        store = workspace.open()
        extractor = CatalogueExtractor(workspace.cfg, store, self.guard)
        return LineageTracer(workspace.cfg, store, extractor, self.guard)

    def verify(self, catalog, item_id) -> dict:
        return self._tracer(catalog).verify(item_id)

    def provenance(self, catalog, item_id) -> bytes:
        tracer = self._tracer(catalog)
        _, png = tracer.draw_provenance(item_id)
        self.guard.commit()
        return png


def start_ingest_job(state, writer, catalog, pdf_names=None, use_vertex=True) -> dict:
    """Record a queued job, spawn writer.ingest, remember its FunctionCall id. Used by the API and the CLI."""
    job_id = f"job-{uuid.uuid4().hex[:16]}"
    now = utc_now_iso()
    status = {"job_id": job_id, "catalog": catalog, "state": "queued", "stage": None, "progress": None,
              "pdfs": pdf_names, "use_vertex": bool(use_vertex), "created_at": now, "updated_at": now}
    state.put(f"job:{job_id}", status)
    call = writer.ingest.spawn(catalog, job_id, pdf_names, bool(use_vertex))
    state.put(f"jobcall:{job_id}", call.object_id)
    status["status_url"] = f"/v1/jobs/{job_id}"
    return status


def _poll_function_call(call_id):
    """-> ("running", None) | ("done", result) | ("failed", error text) | ("expired", None)."""
    try:
        return "done", modal.FunctionCall.from_id(call_id).get(timeout=0)
    except TimeoutError:
        return "running", None
    except modal.exception.OutputExpiredError:
        return "expired", None
    except Exception as exc:
        return "failed", f"{type(exc).__name__}: {str(exc)[:1500]}"


def read_job_status(state, job_id, poll_call=_poll_function_call) -> Optional[dict]:
    status = state.get(f"job:{job_id}")
    if status is None:
        return None
    status = dict(status)
    if status.get("state") in ("done", "failed"):
        return status
    call_id = state.get(f"jobcall:{job_id}")
    if not call_id:
        return status
    outcome, value = poll_call(call_id)
    if outcome == "done" and status.get("state") != "done":
        status["state"] = "done"
        status["result"] = json_safe(value)
    elif outcome == "failed":
        status["state"] = "failed"
        status["error"] = status.get("error") or value
    elif outcome == "expired":
        status["state"] = "expired"
    return status


@dataclass
class LoadedCatalog:
    name: str
    version: str
    cfg: Any
    store: Any
    index: Any
    retriever: Any
    published: dict
    local_db: Any
    loaded_at: float


class CatalogLibrary:
    """The GPU containers' read-only view of the Volume: one LoadedCatalog per catalogue (a local copy of the
    published state.sqlite + the in-memory multi-vector index), refreshed when the writer publishes a new version
    (checked at most every CATALOG_REFRESH_S through the modal.Dict, published.json as the fallback)."""

    def __init__(self, guard, state, data_root=DATA_ROOT, local_root=READER_LOCAL_ROOT):
        self.guard = guard
        self.state = state
        self.data_root = data_root
        self.local_root = Path(local_root)
        self._catalogs = {}
        self._checked = {}
        self._locks = {}
        self._meta_lock = threading.Lock()
        self._listed_at = 0.0
        self._miss_reload_at = 0.0

    def _lock_for(self, name):
        with self._meta_lock:
            lock = self._locks.get(name)
            if lock is None:
                lock = threading.Lock()
                self._locks[name] = lock
            return lock

    def _version_hint(self, name):
        try:
            value = self.state.get(f"catalog:{name}")
        except Exception:
            LOGGER.warning("modal.Dict unavailable; falling back to published.json", exc_info=True)
            return None
        return None if value is None else str(value)

    def loaded(self) -> dict:
        info = {}
        for name, catalog in list(self._catalogs.items()):
            info[name] = {"version": catalog.version, "items": int(len(catalog.index.catalog))}
        return info

    def get(self, catalog, refresh: bool = True) -> LoadedCatalog:
        name = validate_catalog_name(catalog)
        with self._lock_for(name):
            loaded = self._catalogs.get(name)
            now = time.time()
            if loaded is not None and (not refresh or now - self._checked.get(name, 0.0) < CATALOG_REFRESH_S):
                return loaded
            self._checked[name] = now
            hint = self._version_hint(name)
            if loaded is not None and hint == loaded.version:
                return loaded
            self.guard.reload()
            cfg = CatalogConfig(catalog=name, data_root=self.data_root)
            with self.guard.files():
                if not cfg.published_path.is_file() or not cfg.state_db_path.is_file():
                    if loaded is not None:
                        return loaded
                    raise ApiError(404, "catalog_not_found",
                                   f"Catalogue '{name}' has not been published yet; run an ingest first.")
                published = json.loads(cfg.published_path.read_text(encoding="utf-8"))
                version = str(published.get("version"))
                if loaded is not None and version == loaded.version:
                    self._repair_hint(name, hint, version)
                    return loaded
                local_db = self.local_root / name / f"{version}.sqlite"
                copy_into_place(cfg.state_db_path, local_db)
            store = StateStore(local_db, read_only=True)
            feature_versions = published.get("feature_versions") or compute_feature_versions(cfg)
            index = MultiVectorIndex(cfg, store, guard=self.guard, persist=False).build_or_load(feature_versions)
            fresh = LoadedCatalog(name=name, version=version, cfg=cfg, store=store, index=index,
                                  retriever=HybridRetriever(cfg, index), published=published, local_db=local_db,
                                  loaded_at=time.time())
            self._catalogs[name] = fresh
            self._repair_hint(name, hint, version)
            if loaded is not None and loaded.local_db != local_db:
                # requests still holding the old catalogue keep their open connection; the file can go now
                with contextlib.suppress(OSError):
                    Path(loaded.local_db).unlink()
            LOGGER.info("catalogue %s v%s loaded: %d items, pillars %s", name, version, len(index.catalog),
                        sorted(index.pillars))
            return fresh

    def _repair_hint(self, name, hint, version):
        if hint != version:   # the Dict entry expired (7 days idle) or lagged: put it back for the other containers
            with contextlib.suppress(Exception):
                self.state.put(f"catalog:{name}", version)

    def list(self) -> list:
        now = time.time()
        if now - self._listed_at >= CATALOG_REFRESH_S:
            self.guard.reload()
            self._listed_at = now
        root = Path(self.data_root) / "catalogs"
        entries = []
        with self.guard.files():
            if not root.is_dir():
                return entries
            for folder in sorted(root.iterdir()):
                if not folder.is_dir():
                    continue
                published = None
                published_path = folder / "published.json"
                if published_path.is_file():
                    with contextlib.suppress(Exception):
                        published = json.loads(published_path.read_text(encoding="utf-8"))
                pdf_dir = folder / "pdfs"
                pdfs = sorted(path.name for path in pdf_dir.glob("*.pdf")) if pdf_dir.is_dir() else []
                entry = {"catalog": folder.name, "pdfs": pdfs, "published": None}
                if published:
                    entry["published"] = {key: published.get(key) for key in
                                          ("version", "updated_at", "reason", "items", "summary")}
                entries.append(entry)
        return entries

    def read_bytes(self, path, reload_on_miss: bool = False) -> bytes:
        """A file from the Volume. reload_on_miss: a file the writer committed after our last reload (a fresh
        render) is found after one reload; misses reload at most every 5 s."""
        try:
            with self.guard.files():
                return Path(path).read_bytes()
        except FileNotFoundError:
            if not reload_on_miss or time.time() - self._miss_reload_at < 5.0:
                raise
            self._miss_reload_at = time.time()
            self.guard.reload()
            with self.guard.files():
                return Path(path).read_bytes()

    def save_pdf(self, catalog, filename, source_file) -> tuple:
        """Stream an uploaded PDF into <catalog>/pdfs/ and commit, so the writer sees it after its reload. The one
        thing a GPU container writes: a new file nobody else is writing."""
        import shutil
        cfg = CatalogConfig(catalog=validate_catalog_name(catalog), data_root=self.data_root)
        target = cfg.pdf_dir / filename
        with self.guard.files():
            cfg.pdf_dir.mkdir(parents=True, exist_ok=True)
            temporary_path = target.with_name(target.name + ".upload")
            with open(temporary_path, "wb") as handle:
                shutil.copyfileobj(source_file, handle, 4 * 1024 * 1024)
            size = temporary_path.stat().st_size
            with open(temporary_path, "rb") as handle:
                head = handle.read(1024)
            if b"%PDF-" not in head:
                temporary_path.unlink(missing_ok=True)
                raise ApiError(422, "invalid_pdf", "The upload is not a PDF (no %PDF header).")
            if size > CATALOG_MAX_PDF_BYTES:
                temporary_path.unlink(missing_ok=True)
                raise ApiError(413, "payload_too_large", f"PDF exceeds {CATALOG_MAX_PDF_BYTES} bytes.")
            replace_file(temporary_path, target)
        self.guard.commit()
        return target, size


class CatalogContext:
    """What the catalogue routes need besides the GPU engine: Volume access, the modal.Dict, Vertex AI and a handle
    on the writer. Built after the container is up, never inside a memory snapshot."""

    def __init__(self, volume, state, writer_factory, vertex=None, data_root=DATA_ROOT,
                 local_root=READER_LOCAL_ROOT, poll_call=_poll_function_call):
        self.guard = VolumeGuard(volume)
        self.state = state
        self.writer_factory = writer_factory
        self.vertex = vertex if vertex is not None else VertexProvider()
        self.data_root = data_root
        self.library = CatalogLibrary(self.guard, state, data_root, local_root)
        self.poll_call = poll_call

    def config(self, catalog) -> CatalogConfig:
        return CatalogConfig(catalog=validate_catalog_name(catalog), data_root=self.data_root)

    def writer(self):
        return self.writer_factory()


# =====================================================================================
# 5. HTTP APIs  (engine-agnostic factories -> unit-testable with a fake engine)
# =====================================================================================
def _parse_include(include: str, allowed: set) -> list:
    wanted = [s.strip() for s in include.split(",") if s.strip()]
    bad = [s for s in wanted if s not in allowed]
    if bad or not wanted:
        raise ApiError(422, "invalid_include", f"'include' must be a comma list of {sorted(allowed)}.")
    return wanted


def pack_npz(res: dict, wanted: list, dtype: str, compress: bool, meta: dict) -> bytes:
    import numpy as np
    arrays = {}
    for k in wanted:
        if k in res:
            a = res[k]
            if dtype == "float16" and a.dtype.kind == "f" and k != "intrinsics":
                a = a.astype(np.float16)
            arrays[k] = a
    intr = res["intrinsics"]    # normalised: fx, fy relative to image width / height, principal point at 0.5
    arrays["fov_deg_xy"] = np.array([np.degrees(2 * np.arctan(0.5 / intr[0, 0])),
                                     np.degrees(2 * np.arctan(0.5 / intr[1, 1]))], np.float32)
    arrays["size_hw"] = np.array([meta["height"], meta["width"]], np.int32)
    arrays["original_size_hw"] = np.array([meta["original_height"], meta["original_width"]], np.int32)
    buf = io.BytesIO()
    (np.savez_compressed if compress else np.savez)(buf, **arrays)   # uncompressed = zero CPU latency
    return buf.getvalue()


def build_moge_api(engine):
    gate = GpuGate()
    api = make_base_app("moge2", gate, engine.info())
    add_moge_routes(api, gate, engine)
    return api


def add_moge_routes(api, gate, engine):
    from fastapi import File, Form, Response, UploadFile

    allowed = {"points", "depth", "mask", "intrinsics", "normal"}

    @api.post("/v1/geometry")
    async def geometry(
        image: UploadFile = File(...),
        resolution_level: int = Form(9, ge=0, le=9),
        max_side: int = Form(1280, ge=256, le=4096),
        fov_x: Optional[float] = Form(None, gt=1.0, lt=179.0),
        include: str = Form("points,depth,mask,intrinsics,normal"),
        dtype: Literal["float32", "float16"] = Form("float32"),
        compress: bool = Form(False),
        apply_mask: bool = Form(True),
    ):
        """Metric 3D geometry. Returns an .npz: points(H,W,3) depth(H,W) mask(H,W) normal(H,W,3)
        intrinsics(3,3, normalised) fov_deg_xy size_hw original_size_hw. Masked pixels are +inf."""
        wanted, sw = _parse_include(include, allowed), Stopwatch()
        data = await read_upload(image)
        rgb, meta = await asyncio.to_thread(decode_image, data, max_side)
        sw.lap("decode")
        async with gate.slot() as waited:
            sw.ms["queue"] = round(waited * 1000, 1)
            sw.reset()
            res = await asyncio.to_thread(engine.infer, rgb, resolution_level, fov_x, apply_mask)
            sw.lap("gpu")
        body = await asyncio.to_thread(pack_npz, res, wanted, dtype, compress, meta)
        sw.lap("encode")
        sw.finish()
        return Response(body, media_type="application/x-npz", headers={
            "Server-Timing": sw.header(), "X-Image-Size": f"{meta['width']}x{meta['height']}"})


def build_marigold_api(engine):
    gate = GpuGate()
    api = make_base_app("marigold-iid", gate, engine.info())
    add_marigold_routes(api, gate, engine)
    return api


def add_marigold_routes(api, gate, engine):
    from fastapi import File, Form, Response, UploadFile

    def pack(key: str, prediction, steps, seed: int, raw: bool, meta: dict) -> bytes:
        import numpy as np
        images = engine.render(key, prediction)
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as z:   # PNGs are already compressed
            for name, arr in images.items():
                z.writestr(f"{name}.png", encode_png(arr))
            if raw:
                b = io.BytesIO()
                np.savez(b, prediction=prediction.astype(np.float16), targets=np.array(list(images)))
                z.writestr("prediction.npz", b.getvalue())
            z.writestr("meta.json", json.dumps({"model": key, "outputs": list(images), "steps": steps,
                                                "seed": seed, **meta}))
        return buf.getvalue()

    @api.post("/v1/decompose")
    async def decompose(
        image: UploadFile = File(...),
        model: Literal["appearance", "lighting"] = Form("appearance"),
        steps: Optional[int] = Form(None, ge=1, le=20),
        ensemble: int = Form(1, ge=1, le=10),
        resolution: Optional[int] = Form(None, ge=256, le=1280),
        seed: int = Form(0, ge=0, le=2**31 - 1),
        max_side: int = Form(2048, ge=256, le=4096),
        raw: bool = Form(False),
    ):
        """Intrinsic decomposition. appearance -> albedo, roughness, metallicity; lighting -> albedo,
        shading, residual. Returns a zip of PNGs + meta.json (+ prediction.npz when raw=true).
        steps / resolution default to the checkpoint's own values; ensemble>=3 trades latency for quality."""
        if model not in engine.pipes:
            raise ApiError(422, "model_not_loaded", f"this pool loaded only {sorted(engine.pipes)}; got {model!r}.")
        if ensemble == 2:
            raise ApiError(422, "invalid_ensemble", "ensemble must be 1 or >= 3 (2 equals no ensembling).")
        if resolution is not None and resolution % 8:
            raise ApiError(422, "invalid_resolution", "resolution must be a multiple of 8.")
        sw = Stopwatch()
        data = await read_upload(image)
        rgb, meta = await asyncio.to_thread(decode_image, data, max_side)
        sw.lap("decode")
        async with gate.slot() as waited:
            sw.ms["queue"] = round(waited * 1000, 1)
            sw.reset()
            pred = await asyncio.to_thread(engine.infer, model, rgb, steps, ensemble, resolution, seed)
            sw.lap("gpu")
        pipe_steps = steps or engine.pipes[model].default_denoising_steps
        body = await asyncio.to_thread(pack, model, pred, pipe_steps, seed, raw, meta)
        sw.lap("encode")
        sw.finish()
        return Response(body, media_type="application/zip", headers={
            "Server-Timing": sw.header(), "X-Image-Size": f"{meta['width']}x{meta['height']}"})


def build_sam3_api(engine):
    gate = GpuGate()
    api = make_base_app("sam3", gate, engine.info())
    add_sam3_routes(api, gate, engine)
    return api


def sam3_parse_boxes(raw: Optional[str]) -> Optional[list]:
    if not raw:
        return None
    try:
        boxes = json.loads(raw)
        assert isinstance(boxes, list) and 0 < len(boxes) <= 20
        for b in boxes:
            x0, y0, x1, y1 = (float(v) for v in b["box"])
            assert 0 <= x0 < x1 <= 1 and 0 <= y0 < y1 <= 1
        return boxes
    except Exception as e:
        raise ApiError(422, "invalid_boxes", 'boxes must be JSON: [{"box":[x0,y0,x1,y1] (0..1, relative '
                       'to the image), "positive":true}, ...] (max 20)') from e


def sam3_pack(results: list, meta: dict, mask_format: str, timing: dict) -> bytes:
    """The JSON body of /v1/segment (also the sam3.json entry of /v1/analyze)."""
    W, H = meta["width"], meta["height"]
    out = []
    for r in results:
        insts = []
        for i in range(len(r["scores"])):
            x0, y0, x1, y1 = (float(v) for v in r["boxes"][i])
            inst = {"score": round(float(r["scores"][i]), 5),
                    "box_xyxy": [round(x0, 2), round(y0, 2), round(x1, 2), round(y1, 2)],
                    "box_xyxy_norm": [round(x0 / W, 5), round(y0 / H, 5), round(x1 / W, 5), round(y1 / H, 5)]}
            if mask_format == "png":      # 8-bit PNG, 0 / 255
                inst["mask"] = {"format": "png_base64",
                                "data": base64.b64encode(encode_png(r["masks"][i].astype("uint8") * 255)).decode()}
            elif mask_format == "rle":
                inst["mask"] = {"format": "coco_rle_uncompressed", **rle_encode(r["masks"][i])}
            insts.append(inst)
        out.append({"prompt": r["prompt"], "count": len(insts), "instances": insts})
    return json.dumps({"image": meta, "mask_format": mask_format, "results": out, "timing_ms": timing}).encode()


def add_sam3_routes(api, gate, engine):
    from fastapi import File, Form, UploadFile
    from fastapi.responses import Response

    parse_boxes = sam3_parse_boxes
    pack = sam3_pack

    @api.post("/v1/segment")
    async def segment(
        image: UploadFile = File(...),
        prompt: Optional[list[str]] = Form(None),
        boxes: Optional[str] = Form(None),
        threshold: float = Form(0.5, ge=0.01, le=0.99),
        max_instances: int = Form(100, ge=1, le=300),
        mask_format: Literal["png", "rle", "none"] = Form("png"),
        max_side: int = Form(2048, ge=256, le=4096),
    ):
        """Open-vocabulary segmentation. Repeat `prompt` for several concepts (one image-encoder pass is shared),
        and/or send `boxes` (normalised exemplar boxes). Coordinates refer to the returned image size."""
        prompts = [p.strip() for p in (prompt or []) if p and p.strip()]
        box_list = parse_boxes(boxes)
        if not prompts and not box_list:
            raise ApiError(422, "missing_prompt", "Provide at least one 'prompt' or 'boxes'.")
        if len(prompts) > 8 or any(len(p) > 200 for p in prompts):
            raise ApiError(422, "invalid_prompt", "At most 8 prompts of up to 200 characters.")
        if box_list and len(prompts) > 1:
            raise ApiError(422, "invalid_prompt", "Box prompts can be combined with at most one text prompt.")
        sw = Stopwatch()
        data = await read_upload(image)
        rgb, meta = await asyncio.to_thread(decode_image, data, max_side)
        sw.lap("decode")
        async with gate.slot() as waited:
            sw.ms["queue"] = round(waited * 1000, 1)
            sw.reset()
            results = await asyncio.to_thread(engine.infer, rgb, prompts, box_list, threshold, max_instances,
                                              mask_format != "none")
            sw.lap("gpu")
        body = await asyncio.to_thread(pack, results, meta, mask_format, dict(sw.ms))
        sw.lap("encode")
        sw.finish()
        return Response(body, media_type="application/json", headers={"Server-Timing": sw.header()})


def parse_oneformer_tasks(raw: Optional[list]) -> list:
    """Repeated `task` fields and/or comma lists -> ordered, de-duplicated task names (default: semantic)."""
    tasks = []
    for item in raw or []:
        for part in str(item).split(","):
            name = part.strip().lower()
            if name and name not in tasks:
                tasks.append(name)
    if not tasks:
        tasks = ["semantic"]
    bad = [t for t in tasks if t not in ONEFORMER_TASKS]
    if bad:
        raise ApiError(422, "invalid_task", f"task must be one or more of {list(ONEFORMER_TASKS)}; got {bad}.")
    return tasks


def build_oneformer_api(engine):
    gate = GpuGate()
    api = make_base_app("oneformer", gate, engine.info())
    add_oneformer_routes(api, gate, engine)
    return api


def add_oneformer_routes(api, gate, engine):
    from fastapi import File, Form, UploadFile
    from fastapi.responses import Response

    def png_payload(arr) -> str:
        return base64.b64encode(encode_png(arr)).decode()

    def box_entry(box, width: int, height: int) -> dict:
        x0, y0, x1, y1 = (int(v) for v in box)
        return {"box_xyxy": [x0, y0, x1, y1],
                "box_xyxy_norm": [round(x0 / width, 5), round(y0 / height, 5), round(x1 / width, 5),
                                  round(y1 / height, 5)]}

    def pack(results: dict, meta: dict, tasks: list, short: int, mask_format: str, timing: dict) -> bytes:
        import numpy as np
        width, height = meta["width"], meta["height"]
        out = {}
        semantic = results.get("semantic")
        if semantic is not None:
            counts = semantic["counts"]
            total = float(counts.sum()) or 1.0
            classes = []
            for class_id in np.argsort(counts)[::-1]:
                if counts[class_id] == 0:
                    break
                classes.append({"id": int(class_id), "label": engine.short_name(int(class_id)),
                                "pixels": int(counts[class_id]), "fraction": round(float(counts[class_id]) / total, 5)})
            out["semantic"] = {"label_map": {"format": "png_base64", "dtype": "uint8", "data":
                                             png_payload(semantic["label_map"])},
                               "classes": classes}
        panoptic = results.get("panoptic")
        if panoptic is not None:
            segments = []
            for segment in panoptic["segments"]:
                entry = {"id": segment["id"], "label_id": segment["label_id"],
                         "label": engine.short_name(segment["label_id"]), "isthing": segment["isthing"],
                         "score": segment["score"], "area": segment["area"]}
                entry.update(box_entry(segment["box"], width, height))
                segments.append(entry)
            out["panoptic"] = {"segment_map": {"format": "png_base64", "dtype": "uint8", "void": 0,
                                               "data": png_payload(panoptic["segment_map"])},
                               "count": len(segments), "segments": segments}
        instance = results.get("instance")
        if instance is not None:
            instances = []
            for i in range(len(instance["scores"])):
                label_id = int(instance["labels"][i])
                entry = {"label_id": label_id, "label": engine.short_name(label_id),
                         "score": round(float(instance["scores"][i]), 5), "area": int(instance["areas"][i])}
                entry.update(box_entry(instance["boxes"][i], width, height))
                if instance["masks"] is not None and mask_format == "png":
                    entry["mask"] = {"format": "png_base64",
                                     "data": png_payload(instance["masks"][i].astype(np.uint8) * 255)}
                elif instance["masks"] is not None and mask_format == "rle":
                    entry["mask"] = {"format": "coco_rle_uncompressed", **rle_encode(instance["masks"][i])}
                instances.append(entry)
            out["instance"] = {"count": len(instances), "mask_format": mask_format, "instances": instances}
        return json.dumps({"image": meta, "model": ONEFORMER_REPO, "tasks": tasks, "resolution": short,
                           "processed_size": results["processed_size"], "results": out,
                           "timing_ms": timing}).encode()

    @api.get("/v1/classes")
    async def classes():
        return {"model": ONEFORMER_REPO, "classes": engine.class_table()}

    @api.post("/v1/oneformer")   # the name the Swatchroom server's ONEFORMER_URL points at; same handler
    @api.post("/v1/parse")
    async def parse(
        image: UploadFile = File(...),
        task: Optional[list[str]] = Form(None),
        resolution: Optional[int] = Form(None, ge=320, le=1280),
        threshold: Optional[float] = Form(None, ge=0.01, le=0.99),
        overlap_threshold: float = Form(0.8, ge=0.0, le=1.0),
        max_instances: int = Form(100, ge=1, le=100),
        mask_format: Literal["png", "rle", "none"] = Form("png"),
        max_side: int = Form(2048, ge=256, le=3072),
        tta: bool = Form(False),
    ):
        """ADE20K scene parsing. task (repeatable or comma list): semantic (uint8 class-id map + class areas),
        panoptic (uint8 segment-id map, 0 = void, + one entry per segment; stuff merged per class) and/or instance
        (things only, overlapping masks). One backbone pass serves every requested task. resolution = short side
        the network sees (default 640, the training size); threshold defaults to 0.8 (panoptic) / 0.5 (instance);
        tta=true averages 3 scales x flip for the semantic map (about 5x the GPU time). Maps and boxes refer to the
        returned image size (image.width x image.height)."""
        tasks = parse_oneformer_tasks(task)
        if tta and "semantic" not in tasks:
            raise ApiError(422, "invalid_tta", "tta applies to the semantic task only.")
        sw = Stopwatch()
        data = await read_upload(image)
        rgb, meta = await asyncio.to_thread(decode_image, data, max_side)
        sw.lap("decode")
        async with gate.slot() as waited:
            sw.ms["queue"] = round(waited * 1000, 1)
            sw.reset()
            results = await asyncio.to_thread(engine.infer, rgb, tasks, resolution, threshold, overlap_threshold,
                                              max_instances, mask_format != "none", tta)
            sw.lap("gpu")
        short = resolution or engine.meta["shortest_edge"]
        body = await asyncio.to_thread(pack, results, meta, tasks, short, mask_format, dict(sw.ms))
        sw.lap("encode")
        sw.finish()
        return Response(body, media_type="application/json", headers={"Server-Timing": sw.header()})


# ---- the combined pool: every route of the four services on one app, plus /v1/analyze ------------------------------
ANALYZE_PROMPTS = ("wall", "floor", "ceiling", "rug", "window", "door", "furniture", "plant", "picture frame",
                   "light fixture")
ANALYZE_MAX_PROMPTS = 12   # one image-encoder pass serves them all; each extra prompt is only a decoder pass


def marigold_lighting_pngs(engine, prediction) -> dict:
    """Marigold "lighting" prediction -> {"shading": PNG bytes, "residual": PNG bytes} (the two layers Swatchroom
    reads: albedo is not used, so it is not encoded or sent)."""
    images = engine.render("lighting", prediction)
    return {name: encode_png(images[name]) for name in ("shading", "residual") if name in images}


def pack_analyze_zip(meta: dict, geometry_npz: Optional[bytes], lighting: Optional[dict], segments_json: Optional[bytes],
                     timing: dict, services: list) -> bytes:
    """ONE zip for one photo: meta.json, geometry.npz (the /v1/geometry body), shading.png + residual.png, sam3.json
    (the /v1/segment body). Entries a caller did not ask for are absent."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as z:    # PNGs and npz are already compressed / dense
        z.writestr("meta.json", json.dumps({"image": meta, "services": services, "timing_ms": timing,
                                            "outputs": sorted((lighting or {}).keys())}))
        if geometry_npz is not None:
            z.writestr("geometry.npz", geometry_npz)
        for name, png in (lighting or {}).items():
            z.writestr(f"{name}.png", png)
        if segments_json is not None:
            z.writestr("sam3.json", segments_json)
    return buf.getvalue()


def add_analyze_routes(api, gate, engines: dict):
    """POST /v1/analyze: MoGe-2 depth + Marigold lighting + SAM 3 masks for ONE photo in ONE request, ONE decode and
    ONE trip through the GPU gate. This is the room-analysis call of the Swatchroom pipeline."""
    from fastapi import File, Form, UploadFile
    from fastapi.responses import Response

    @api.post("/v1/analyze")
    async def analyze(
        image: UploadFile = File(...),
        max_side: int = Form(1280, ge=256, le=4096),
        geometry: bool = Form(True),
        lighting: bool = Form(True),
        segments: bool = Form(True),
        resolution_level: int = Form(9, ge=0, le=9),
        prompt: Optional[list[str]] = Form(None),
        threshold: float = Form(0.4, ge=0.01, le=0.99),
        max_instances: int = Form(6, ge=1, le=100),
        marigold_steps: Optional[int] = Form(None, ge=1, le=20),
        seed: int = Form(0, ge=0, le=2**31 - 1),
    ):
        """geometry -> geometry.npz (depth, mask, intrinsics), lighting -> shading.png + residual.png,
        segments -> sam3.json (instance masks as PNG). Everything refers to the returned image size
        (meta.json: image.width x image.height)."""
        prompts = [p.strip() for p in (prompt or []) if p and p.strip()] or list(ANALYZE_PROMPTS)
        if len(prompts) > ANALYZE_MAX_PROMPTS or any(len(p) > 200 for p in prompts):
            raise ApiError(422, "invalid_prompt", f"At most {ANALYZE_MAX_PROMPTS} prompts of up to 200 characters.")
        if not (geometry or lighting or segments):
            raise ApiError(422, "nothing_requested", "Ask for at least one of geometry, lighting, segments.")
        for needed, flag in (("moge2", geometry), ("marigold", lighting), ("sam3", segments)):
            if flag and needed not in engines:
                raise ApiError(422, "engine_not_loaded", f"{needed} is not loaded in this pool.")
        sw = Stopwatch()
        data = await read_upload(image)
        rgb, meta = await asyncio.to_thread(decode_image, data, max_side)
        sw.lap("decode")
        raw = {}

        def run_all():
            # one engine after another on the one GPU; each lap is the time of that model alone
            if geometry:
                raw["geometry"] = engines["moge2"].infer(rgb, resolution_level, None, True)
                sw.lap("moge2")
            if lighting:
                raw["lighting"] = engines["marigold"].infer("lighting", rgb, marigold_steps, 1, None, seed)
                sw.lap("marigold")
            if segments:
                raw["segments"] = engines["sam3"].infer(rgb, prompts, None, threshold, max_instances, True)
                sw.lap("sam3")

        async with gate.slot() as waited:
            sw.ms["queue"] = round(waited * 1000, 1)
            sw.reset()
            await asyncio.to_thread(run_all)
        gpu_ms = dict(sw.ms)

        def encode():
            npz = pack_npz(raw["geometry"], ["depth", "mask", "intrinsics"], "float32", False, meta) \
                if "geometry" in raw else None
            pngs = marigold_lighting_pngs(engines["marigold"], raw["lighting"]) if "lighting" in raw else None
            sam = sam3_pack(raw["segments"], meta, "png", {}) if "segments" in raw else None
            return npz, pngs, sam

        sw.reset()
        npz, pngs, sam = await asyncio.to_thread(encode)
        sw.lap("encode")
        sw.finish()
        used = [name for name, flag in (("moge2", geometry), ("marigold", lighting), ("sam3", segments)) if flag]
        body = pack_analyze_zip(meta, npz, pngs, sam, dict(sw.ms), used)
        return Response(body, media_type="application/zip", headers={
            "Server-Timing": sw.header(), "X-Image-Size": f"{meta['width']}x{meta['height']}",
            "X-Gpu-Ms": json.dumps(gpu_ms, separators=(",", ":"))})


# ---- the catalogue (Terucon): embeddings, tri-modal search, ingest jobs, lineage, Nano Banana renders --------------
CATALOG_LARGE_BODIES = {"/ingest": CATALOG_MAX_PDF_BYTES + 1_048_576}
CATALOG_ITEM_COLUMNS = ("item_id", "product_id", "source_pdf", "page_number", "item_index", "image_bbox", "id_bbox",
                        "match_type", "crop_width", "crop_height", "sha256_hash", "caption_status",
                        "material_category", "material_subtype", "surface_finish", "dominant_hex")


async def vertex_query_signals(vertex, cfg, query, text, describe_photo, use_vertex_mm, pillars) -> dict:
    """The notebook's Vertex AI query signals, in parallel and outside the GPU section: the Vertex image vector,
    Gemini's description of the photo -> text vector, and for a text query its text and Vertex text vectors.
    Only signals whose pillar is indexed are requested; a failure becomes a warning, not an error."""
    out = {"signals": {}, "warnings": [], "profile": None, "caption_model": None}
    wants_text = "text" in pillars and ((query is not None and describe_photo) or bool(text))
    wants_mm = use_vertex_mm and cfg.enable_vertex_multimodal_embedding and "vertex_mm" in pillars
    if not (wants_text or wants_mm):
        return out
    manager = await asyncio.to_thread(vertex.get)
    if manager is None:
        out["warnings"].append(f"Vertex AI signals skipped: {vertex.error}")
        return out
    wants_mm = wants_mm and "vertex_mm" not in manager.disabled_features
    tasks = {}
    if query is not None and wants_mm:
        tasks["vertex_mm_image"] = vertex.call(manager.multimodal_embed(image_bytes=query["jpeg"]))
    if query is not None and describe_photo and "text" in pillars:
        async def describe_then_embed():
            color = query["color"]
            color_meta = {"dominant_hex": color.dominant_hex, "proportions": color.proportions}
            profile, model_name = await describe_material(manager, cfg, query["jpeg"], "unknown (user photo)",
                                                          color_meta)
            profile_dict = profile.model_dump(mode="json")
            description = compose_search_document(profile_dict, color.dominant_hex)
            vector = await manager.embed_text(description, "RETRIEVAL_QUERY")
            return vector, profile_dict, model_name

        tasks["text_from_photo"] = vertex.call(describe_then_embed())
    if text and "text" in pillars:
        tasks["text_query"] = vertex.call(manager.embed_text(text, "RETRIEVAL_QUERY"))
    if text and wants_mm:
        tasks["vertex_mm_text"] = vertex.call(manager.multimodal_embed(text=text))
    names = list(tasks)
    results = await asyncio.gather(*tasks.values(), return_exceptions=True)
    for name, value in zip(names, results):
        if isinstance(value, BaseException):
            out["warnings"].append(f"{name}: {type(value).__name__}: {str(value)[:200]}")
            continue
        if name == "vertex_mm_image":
            out["signals"][name] = value["image"]
        elif name == "text_from_photo":
            vector, profile, model_name = value
            out["signals"][name] = vector
            out["profile"] = profile
            out["caption_model"] = model_name
        elif name == "text_query":
            out["signals"][name] = value
        elif name == "vertex_mm_text":
            out["signals"][name] = value["text"]
    return out


def catalog_item_summary(row, catalog_name: str) -> dict:
    summary = {}
    for column in CATALOG_ITEM_COLUMNS:
        if column in row:
            summary[column] = row[column]
    summary["crop_url"] = f"/v1/catalog/{catalog_name}/items/{row['item_id']}/crop"
    return summary


def catalog_item_detail(loaded, item_id: str) -> dict:
    store = loaded.store
    row = store.get_item(item_id)
    if row is None:
        raise ApiError(404, "item_not_found", f"No item {item_id!r} in catalogue {loaded.name!r}.")
    for key in ("image_bbox", "id_bbox", "image_xrefs"):
        if isinstance(row.get(key), str):
            row[key] = json.loads(row[key])
    caption = store.query("SELECT caption_version, model, status, profile_json, search_text, updated_at "
                          "FROM captions WHERE item_id = ?", (item_id,))
    row["caption"] = None
    if caption:
        entry = dict(caption[0])
        entry["profile"] = json.loads(entry.pop("profile_json")) if entry.get("profile_json") else None
        row["caption"] = entry
    vectors = []
    for vector_row in store.query("SELECT pillar, feature_version, dim, extra_json, updated_at FROM embeddings "
                                  "WHERE item_id = ? ORDER BY pillar", (item_id,)):
        entry = dict(vector_row)
        extra = entry.pop("extra_json")
        if entry["pillar"] == "color" and extra:
            row["color"] = json.loads(extra)
        entry["current"] = loaded.index.feature_versions.get(entry["pillar"]) == entry["feature_version"]
        vectors.append(entry)
    row["vectors"] = vectors
    renders = store.query("SELECT render_id, model, created_at FROM renders WHERE item_id = ? "
                          "ORDER BY created_at DESC LIMIT 20", (item_id,))
    row["renders"] = [dict(render) for render in renders]
    row["crop_url"] = f"/v1/catalog/{loaded.name}/items/{item_id}/crop"
    return row


def writer_error(exc: BaseException, what: str):
    """Exceptions the writer raises (re-raised here by Modal) -> HTTP errors."""
    if isinstance(exc, ApiError):
        return exc
    if isinstance(exc, KeyError):
        return ApiError(404, "item_not_found", f"{what}: no such item {exc}.")
    if isinstance(exc, FileNotFoundError):
        return ApiError(404, "file_not_found", f"{what}: {exc}")
    if isinstance(exc, RuntimeError) and "Vertex AI unavailable" in str(exc):
        return ApiError(503, "vertex_unavailable", str(exc))
    logger.exception("%s failed in the writer", what)
    return ApiError(502, "writer_failed", f"{what} failed: {type(exc).__name__}: {str(exc)[:300]}")


def add_catalog_routes(api, gate, engine, ctx):
    from fastapi import File, Form, Query, UploadFile
    from fastapi.responses import JSONResponse, Response

    def json_field(raw, name: str):
        if raw is None or not str(raw).strip():
            return None
        try:
            value = json.loads(raw)
        except ValueError as e:
            raise ApiError(422, f"invalid_{name}", f"'{name}' must be a JSON object.") from e
        if not isinstance(value, dict):
            raise ApiError(422, f"invalid_{name}", f"'{name}' must be a JSON object.")
        return value

    def parse_weights(raw):
        weights = json_field(raw, "weights")
        if weights is None:
            return None
        cleaned = {}
        for group, value in weights.items():
            if group not in WEIGHT_GROUPS or not isinstance(value, (int, float)) or value < 0:
                raise ApiError(422, "invalid_weights", f"weights: keys {list(WEIGHT_GROUPS)}, values >= 0.")
            cleaned[group] = float(value)
        if sum(cleaned.values()) <= 0:
            raise ApiError(422, "invalid_weights", "weights must not all be zero.")
        return cleaned

    async def load(catalog):
        return await asyncio.to_thread(ctx.library.get, validate_catalog_name(catalog))

    async def call_writer(method: str, what: str, *args):
        writer = ctx.writer()
        try:
            return await asyncio.to_thread(getattr(writer, method).remote, *args)
        except Exception as exc:
            raise writer_error(exc, what) from exc

    # ------------------------------------------------------------ embeddings
    @api.post("/v1/embed")
    async def embed(
        image: UploadFile = File(...),
        rectify: bool = Form(False),
        tta_hflip: bool = Form(False),
        include: str = Form("dino,siglip,color"),
        format: Literal["json", "npz"] = Form("json"),
        max_side: int = Form(2048, ge=256, le=4096),
    ):
        """DINOv2 (3072-d), SigLIP (1152-d) and CIELAB (396-d) vectors of one image, exactly as the catalogue
        stores them (feature versions included). rectify=true treats it as a phone photo (perspective-correct a
        detected card, else centre-crop) like a search does; tta_hflip=true is what searches use for photos."""
        import numpy as np
        wanted = _parse_include(include, {"dino", "siglip", "color"})
        cfg = CatalogConfig()
        sw = Stopwatch()
        data = await read_upload(image)
        rgb, meta = await asyncio.to_thread(decode_image, data, max_side)
        sw.lap("decode")

        def prepare():
            source = rgb
            method = "as_is"
            quad = None
            if rectify:
                prepared = QueryPhotoPreprocessor(cfg).prepare(rgb)
                source = prepared.rectified_rgb
                method = prepared.method
                quad = prepared.quad
            color = compute_lab_color_descriptor(source, ColorParams.from_config(cfg))
            dino_input, siglip_input = catalog_neural_inputs(source, cfg)
            return method, quad, color, dino_input, siglip_input

        method, quad, color, dino_input, siglip_input = await asyncio.to_thread(prepare)
        sw.lap("prepare")
        vectors = {"color": color.vector}
        if "dino" in wanted or "siglip" in wanted:
            async with gate.slot() as waited:
                sw.ms["queue"] = round(waited * 1000, 1)
                sw.reset()
                dino, siglip = await asyncio.to_thread(engine.encode_prepared, [dino_input], [siglip_input],
                                                       tta_hflip)
                sw.lap("gpu")
            vectors["dino"] = dino[0]
            vectors["siglip"] = siglip[0]
        versions = local_feature_versions(cfg)
        sw.finish()
        headers = {"Server-Timing": sw.header(), "X-Image-Size": f"{meta['width']}x{meta['height']}"}
        if format == "npz":
            buf = io.BytesIO()
            arrays = {}
            for name in wanted:
                arrays[name] = np.asarray(vectors[name], dtype=np.float32)
            np.savez(buf, **arrays)
            headers["X-Feature-Versions"] = json.dumps({name: versions[name] for name in wanted})
            return Response(buf.getvalue(), media_type="application/x-npz", headers=headers)
        body = {"image": meta, "preprocessing": method, "quad": quad, "tta_hflip": tta_hflip,
                "dominant_hex": color.dominant_hex, "proportions": color.proportions,
                "feature_versions": {name: versions[name] for name in wanted},
                "vectors": {name: vectors[name] for name in wanted}, "timing_ms": dict(sw.ms)}
        return JSONResponse(json_safe(body), headers=headers)

    @api.post("/v1/embed/text")
    async def embed_text(text: list[str] = Form(...), raw: bool = Form(False)):
        """SigLIP text vectors (1152-d, same space as the SigLIP image vectors). raw=false wraps each text in the
        catalogue's template ("a close-up photo of {} material texture"), like a text search does."""
        texts = [item.strip() for item in text if item and item.strip()]
        if not texts or len(texts) > 64 or any(len(item) > 500 for item in texts):
            raise ApiError(422, "invalid_text", "Send 1-64 'text' fields of up to 500 characters.")
        cfg = CatalogConfig()
        template = "{}" if raw else cfg.siglip_text_template
        async with gate.slot():
            vectors = await asyncio.to_thread(engine.encode_text, texts, template)
        return JSONResponse(json_safe({"model": SIGLIP_REPO, "template": template,
                                       "feature_version": local_feature_versions(cfg)["siglip"],
                                       "vectors": vectors}))

    # ------------------------------------------------------------ catalogues
    @api.get("/v1/catalogs")
    async def catalogs():
        entries = await asyncio.to_thread(ctx.library.list)
        return JSONResponse(json_safe({"catalogs": entries, "loaded": ctx.library.loaded(),
                                       "vertex": {"enabled": ctx.vertex.enabled, "error": ctx.vertex.error}}))

    @api.get("/v1/catalog/{catalog}")
    async def catalog_summary(catalog: str):
        loaded = await load(catalog)
        pillars = {}
        for name, pillar in loaded.index.pillars.items():
            pillars[name] = {"count": len(pillar.item_ids), "dim": int(pillar.matrix.shape[1]),
                             "feature_version": pillar.feature_version}
        body = {"catalog": loaded.name, "version": loaded.version, "published": loaded.published,
                "items": int(len(loaded.index.catalog)), "pillars": pillars,
                "vertex": {"enabled": ctx.vertex.enabled, "error": ctx.vertex.error}}
        return JSONResponse(json_safe(body))

    @api.post("/v1/catalog/{catalog}/search")
    async def search(
        catalog: str,
        image: Optional[UploadFile] = File(None),
        text: Optional[str] = Form(None),
        top_k: int = Form(10, ge=1, le=100),
        weights: Optional[str] = Form(None),
        filters: Optional[str] = Form(None),
        describe_photo: Optional[bool] = Form(None),
        use_vertex_mm: bool = Form(True),
        fusion_mode: Optional[Literal["rrf", "linear", "hybrid"]] = Form(None),
        max_side: int = Form(2048, ge=256, le=4096),
    ):
        """Tri-modal catalogue search: a phone photo and/or a text query. Photo -> DINOv2 + SigLIP + CIELAB (+ the
        Vertex image vector, + Gemini's description of the photo when describe_photo); text -> SigLIP text +
        Gemini text vector (+ Vertex text vector). weights: {"dino", "mm", "color", "text"} group weights;
        filters: {"material_category": ["stone"], ...}. Every result carries its lineage (PDF, page, bboxes)."""
        text_query = text.strip() if text and text.strip() else None
        if image is None and text_query is None:
            raise ApiError(422, "missing_query", "Provide an image, a text query, or both.")
        if text_query is not None and len(text_query) > 500:
            raise ApiError(422, "invalid_text", "The text query is limited to 500 characters.")
        weight_override = parse_weights(weights)
        filter_map = json_field(filters, "filters")
        sw = Stopwatch()
        loaded = await load(catalog)
        sw.lap("catalog")
        if loaded.index.catalog.empty:
            raise ApiError(409, "catalog_empty", f"Catalogue {loaded.name!r} has no items yet.")
        cfg = loaded.cfg
        describe = cfg.describe_query_photo if describe_photo is None else bool(describe_photo)
        pillars = loaded.index.pillars

        query = None
        meta = None
        if image is not None:
            data = await read_upload(image)
            rgb, meta = await asyncio.to_thread(decode_image, data, max_side)
            query = await asyncio.to_thread(prepare_query_photo, rgb, cfg)
            sw.lap("prepare")

        def run_gpu():
            out = {}
            if query is not None:
                out["photo"] = local_photo_signals(engine, query, cfg.query_tta_hflip)
            if text_query is not None and "siglip" in pillars:
                out["siglip_text"] = engine.encode_text([text_query], cfg.siglip_text_template)[0]
            return out

        async with gate.slot() as waited:
            sw.ms["queue"] = round(waited * 1000, 1)
            sw.reset()
            local = await asyncio.to_thread(run_gpu)
            sw.lap("gpu")
        remote = await vertex_query_signals(ctx.vertex, cfg, query, text_query, describe, use_vertex_mm, pillars)
        sw.lap("vertex")

        # the notebook's signal order: photo (dino, siglip, colour, vertex image, text from photo), then text
        signals = list(local.get("photo", []))
        remote_signals = remote["signals"]
        if "vertex_mm_image" in remote_signals:
            signals.append(QuerySignal("vertex_mm_image", "vertex_mm", "mm", remote_signals["vertex_mm_image"]))
        if "text_from_photo" in remote_signals:
            signals.append(QuerySignal("text_from_photo", "text", "text", remote_signals["text_from_photo"]))
        if "siglip_text" in local:
            signals.append(QuerySignal("siglip_text", "siglip", "mm", local["siglip_text"]))
        if "text_query" in remote_signals:
            signals.append(QuerySignal("text_query", "text", "text", remote_signals["text_query"]))
        if "vertex_mm_text" in remote_signals:
            signals.append(QuerySignal("vertex_mm_text", "vertex_mm", "mm", remote_signals["vertex_mm_text"]))

        query_info = {"image": meta, "text": text_query, "warnings": remote["warnings"]}
        if query is not None:
            prepared = query["prepared"]
            query_info.update({"preprocessing": prepared.method, "quad": prepared.quad,
                               "rectified_size": [int(prepared.rectified_rgb.shape[1]),
                                                  int(prepared.rectified_rgb.shape[0])],
                               "dominant_hex": query["color"].dominant_hex,
                               "profile": remote["profile"], "caption_model": remote["caption_model"]})
        result = await asyncio.to_thread(
            loaded.retriever.rank, signals, query is not None, text_query is not None, top_k, weight_override,
            filter_map, fusion_mode, query_info, f"/v1/catalog/{loaded.name}/items")
        sw.lap("rank")
        sw.finish()
        body = {"catalog": loaded.name, "version": loaded.version, "results": result.records,
                "signals": result.signal_names, "signal_weights": result.signal_weights,
                "fusion_mode": fusion_mode or cfg.fusion_mode, "query": result.query_info,
                "timing_ms": dict(sw.ms)}
        return JSONResponse(json_safe(body), headers={"Server-Timing": sw.header()})

    # ------------------------------------------------------------ ingest jobs
    @api.post("/v1/catalog/{catalog}/ingest")
    async def ingest(
        catalog: str,
        pdf: Optional[UploadFile] = File(None),
        pdf_name: Optional[str] = Form(None),
        use_vertex: bool = Form(True),
    ):
        """Upload a catalogue PDF (or name one already in <catalog>/pdfs/ on the Volume; neither = every PDF there)
        and run the five stages on the writer. Returns 202 with a job id: GET /v1/jobs/{job_id}."""
        name = validate_catalog_name(catalog)
        pdf_names = None
        if pdf is not None:
            filename = safe_pdf_filename(pdf.filename or "catalogue.pdf")
            await asyncio.to_thread(ctx.library.save_pdf, name, filename, pdf.file)
            pdf_names = [filename]
        elif pdf_name:
            pdf_names = [safe_pdf_filename(pdf_name)]
        try:
            job = await asyncio.to_thread(start_ingest_job, ctx.state, ctx.writer(), name, pdf_names, use_vertex)
        except Exception as exc:
            raise writer_error(exc, "ingest") from exc
        return JSONResponse(json_safe(job), status_code=202)

    @api.get("/v1/jobs/{job_id}")
    async def job_status(job_id: str):
        job_id = validate_safe_id(job_id, "job_id")
        status = await asyncio.to_thread(read_job_status, ctx.state, job_id, ctx.poll_call)
        if status is None:
            raise ApiError(404, "job_not_found", f"No job {job_id!r} (job records expire after 7 idle days).")
        return JSONResponse(json_safe(status))

    # ------------------------------------------------------------ items + lineage
    @api.get("/v1/catalog/{catalog}/items")
    async def items(
        catalog: str,
        limit: int = Query(50, ge=1, le=500),
        offset: int = Query(0, ge=0),
        material_category: Optional[str] = Query(None),
    ):
        loaded = await load(catalog)
        frame = loaded.index.catalog
        if not frame.empty and material_category:
            if "material_category" not in frame.columns:
                frame = frame.iloc[0:0]
            else:
                frame = frame[frame["material_category"] == material_category]
        total = int(len(frame))
        page = frame.iloc[offset: offset + limit]
        rows = []
        for _, row in page.iterrows():
            rows.append(catalog_item_summary(row, loaded.name))
        return JSONResponse(json_safe({"catalog": loaded.name, "version": loaded.version, "total": total,
                                       "offset": offset, "limit": limit, "items": rows}))

    @api.get("/v1/catalog/{catalog}/items/{item_id}")
    async def item_detail(catalog: str, item_id: str):
        item_id = validate_safe_id(item_id, "item_id")
        loaded = await load(catalog)
        detail = await asyncio.to_thread(catalog_item_detail, loaded, item_id)
        return JSONResponse(json_safe(detail))

    @api.get("/v1/catalog/{catalog}/items/{item_id}/crop")
    async def item_crop(catalog: str, item_id: str):
        item_id = validate_safe_id(item_id, "item_id")
        loaded = await load(catalog)
        row = await asyncio.to_thread(loaded.store.get_item, item_id)
        if row is None:
            raise ApiError(404, "item_not_found", f"No item {item_id!r} in catalogue {loaded.name!r}.")
        path = loaded.cfg.resolve(row["crop_filepath"])
        try:
            data = await asyncio.to_thread(ctx.library.read_bytes, path, True)
        except FileNotFoundError as e:
            raise ApiError(404, "crop_missing", f"The crop of {item_id} is not on the Volume.") from e
        media_type = "image/jpeg" if str(path).lower().endswith((".jpg", ".jpeg")) else "image/png"
        return Response(data, media_type=media_type, headers={"X-Crop-Sha256": row["sha256_hash"],
                                                              "Cache-Control": "private, max-age=86400"})

    @api.get("/v1/catalog/{catalog}/items/{item_id}/verify")
    async def item_verify(catalog: str, item_id: str):
        name = validate_catalog_name(catalog)
        item_id = validate_safe_id(item_id, "item_id")
        report = await call_writer("verify", "verify", name, item_id)
        return JSONResponse(json_safe(report))

    @api.get("/v1/catalog/{catalog}/items/{item_id}/provenance")
    async def item_provenance(catalog: str, item_id: str):
        name = validate_catalog_name(catalog)
        item_id = validate_safe_id(item_id, "item_id")
        png = await call_writer("provenance", "provenance", name, item_id)
        return Response(png, media_type="image/png")

    @api.get("/v1/catalog/{catalog}/products")
    async def products(catalog: str, product_id: str = Query(..., min_length=1, max_length=64)):
        loaded = await load(catalog)
        frame = await asyncio.to_thread(loaded.retriever.lookup_product, product_id)
        rows = []
        for _, row in frame.iterrows():
            rows.append(catalog_item_summary(row, loaded.name))
        return JSONResponse(json_safe({"catalog": loaded.name, "product_id": product_id, "items": rows}))

    # ------------------------------------------------------------ renders
    @api.post("/v1/catalog/{catalog}/render")
    async def render(
        catalog: str,
        item_id: str = Form(...),
        scene: Optional[UploadFile] = File(None),
        target_description: Optional[str] = Form(None, max_length=500),
        extra_instructions: str = Form("", max_length=1000),
        aspect_ratio: Optional[str] = Form(None),
    ):
        """Nano Banana material render of one catalogue item: on a scene photo (re-surfaces target_description, or
        the most prominent plausible surface) or, without a scene, as a studio product visualisation. Returns the
        image; X-Render-Id names the stored copy (GET .../renders/{id} and .../renders/{id}/meta)."""
        name = validate_catalog_name(catalog)
        item_id = validate_safe_id(item_id, "item_id")
        if aspect_ratio is not None and aspect_ratio not in SUPPORTED_ASPECT_RATIOS:
            raise ApiError(422, "invalid_aspect_ratio", f"aspect_ratio must be one of {list(SUPPORTED_ASPECT_RATIOS)}.")
        cfg = ctx.config(name)
        scene_jpeg = None
        scene_label = None
        if scene is not None:
            data = await read_upload(scene)
            rgb, _ = await asyncio.to_thread(decode_image, data, cfg.render_scene_max_side_px)
            scene_jpeg = await asyncio.to_thread(encode_rgb, rgb, "jpeg", 93)
            scene_label = f"upload:{os.path.basename(scene.filename or 'scene')[:120]}"
        result = await call_writer("render", "render", name, item_id, scene_jpeg, scene_label, target_description,
                                   extra_instructions, aspect_ratio)
        return Response(result["image"], media_type=result["mime_type"],
                        headers={"X-Render-Id": result["render_id"], "X-Render-Model": result["model"]})

    def render_paths(loaded, render_id):
        render_id = validate_safe_id(render_id, "render_id")
        base = loaded.cfg.renders_dir / render_id
        return render_id, [Path(str(base) + ".png"), Path(str(base) + ".jpg")], Path(str(base) + ".json")

    async def read_first(paths):
        """The first of `paths` that exists; a render committed after our last reload is found on the second
        pass, which may reload the Volume once (CatalogLibrary rate-limits those reloads)."""
        for reload_on_miss in (False, True):
            for path in paths:
                try:
                    return path, await asyncio.to_thread(ctx.library.read_bytes, path, reload_on_miss)
                except FileNotFoundError:
                    continue
        return None, None

    @api.get("/v1/catalog/{catalog}/renders/{render_id}")
    async def render_image(catalog: str, render_id: str):
        loaded = await load(catalog)
        render_id, image_paths, _ = render_paths(loaded, render_id)
        path, data = await read_first(image_paths)
        if path is None:
            raise ApiError(404, "render_not_found", f"No render {render_id!r} in catalogue {loaded.name!r}.")
        media_type = "image/jpeg" if path.suffix == ".jpg" else "image/png"
        return Response(data, media_type=media_type)

    @api.get("/v1/catalog/{catalog}/renders/{render_id}/meta")
    async def render_meta(catalog: str, render_id: str):
        loaded = await load(catalog)
        render_id, _, meta_path = render_paths(loaded, render_id)
        path, data = await read_first([meta_path])
        if path is None:
            raise ApiError(404, "render_not_found", f"No render {render_id!r} in catalogue {loaded.name!r}.")
        return Response(data, media_type="application/json")

    # ------------------------------------------------------------ benchmark
    @api.post("/v1/catalog/{catalog}/evaluate")
    async def evaluate(catalog: str, sample_size: int = Form(40, ge=1, le=200), seed: int = Form(0, ge=0)):
        """Self-retrieval under simulated phone capture (the notebook's benchmark: local pillars only). Each query
        takes the GPU slot on its own, so other requests interleave."""
        loaded = await load(catalog)
        started = time.perf_counter()
        rows = await asyncio.to_thread(evaluate_self_retrieval, loaded, engine, ctx.guard, sample_size, seed)
        return JSONResponse(json_safe({"catalog": loaded.name, "version": loaded.version, "rows": rows,
                                       "seconds": round(time.perf_counter() - started, 1)}))


def build_catalog_api(engine, ctx):
    gate = GpuGate()
    info = dict(engine.info())
    info["vertex"] = {"enabled": ctx.vertex.enabled}
    api = make_base_app("catalog", gate, info, large_bodies=CATALOG_LARGE_BODIES)
    add_catalog_routes(api, gate, engine, ctx)
    return api


def build_vision_api(engines: dict, catalog_ctx=None):
    """One FastAPI app, one GpuGate, every route: /v1/geometry /v1/decompose /v1/segment /v1/parse /v1/oneformer
    /v1/classes /v1/analyze /healthz, plus /v1/embed* /v1/catalogs /v1/catalog/* /v1/jobs/* when the catalogue engine
    is loaded here. The dedicated routes work exactly as on the dedicated classes, so MOGE2_URL / MARIGOLD_URL /
    SAM3_URL / ONEFORMER_URL / CATALOG_URL can all point at this one domain."""
    gate = GpuGate()
    info = {"model": "vision-all", "models": {key: engine.info() for key, engine in engines.items()},
            "gpu": _gpu_name()}
    with_catalog = "catalog" in engines and catalog_ctx is not None
    api = make_base_app("vision", gate, info, large_bodies=CATALOG_LARGE_BODIES if with_catalog else None)
    if "moge2" in engines:
        add_moge_routes(api, gate, engines["moge2"])
    if "marigold" in engines:
        add_marigold_routes(api, gate, engines["marigold"])
    if "sam3" in engines:
        add_sam3_routes(api, gate, engines["sam3"])
    if "oneformer" in engines:
        add_oneformer_routes(api, gate, engines["oneformer"])
    if with_catalog:
        add_catalog_routes(api, gate, engines["catalog"], catalog_ctx)
    add_analyze_routes(api, gate, engines)
    return api


# =====================================================================================
# 6. MODAL SERVICES
# =====================================================================================
def _cls_kwargs(name: str, image: modal.Image, volumes: Optional[dict] = None,
                extra_secrets: Optional[list] = None) -> dict:
    cfg = SERVICES[name]
    kw = dict(
        image=image, gpu=cfg["gpu"], secrets=[api_keys_secret, runtime_secret] + list(extra_secrets or []),
        cpu=CPU_CORES, memory=cfg["memory_mib"], timeout=REQUEST_TIMEOUT_S, startup_timeout=STARTUP_TIMEOUT_S,
        scaledown_window=SCALEDOWN_S, min_containers=MIN_CONTAINERS, max_containers=MAX_CONTAINERS,
        buffer_containers=BUFFER_CONTAINERS,
    )
    if volumes:
        kw["volumes"] = volumes   # mounted, but never read in the snapshot phase (catalogues load on first request)
    if GPU_SNAPSHOT:
        kw.update(enable_memory_snapshot=True, experimental_options={"enable_gpu_snapshot": True})
    return kw


_CATALOG_VOLUMES = {DATA_ROOT: data_volume}


def _catalog_writer():
    return CatalogWriter()


def _catalog_encoder():
    """The GPU pool the writer sends batch encoding to (VisionAll or CatalogSearch, see CATALOG_ENCODER_SERVICE)."""
    if CATALOG_ENCODER_SERVICE == "vision":
        return VisionAll()
    return CatalogSearch()


def _submit_catalog_batch(dino_batch, siglip_batch):
    return _catalog_encoder().encode_catalog.spawn(dino_batch, siglip_batch)


_CATALOG_CTX = {}
_CATALOG_CTX_LOCK = threading.Lock()


def _catalog_context() -> "CatalogContext":
    """One catalogue context per GPU container, built on first use (by the web app or a method), i.e. after the
    memory snapshot was restored: Volume reads, the Dict and Vertex AI never touch the snapshot."""
    with _CATALOG_CTX_LOCK:
        ctx = _CATALOG_CTX.get("ctx")
        if ctx is None:
            ctx = CatalogContext(data_volume, state_dict, _catalog_writer)
            _CATALOG_CTX["ctx"] = ctx
        return ctx


def _concurrency(name: str):
    return modal.concurrent(max_inputs=SERVICES[name]["max_inputs"], target_inputs=SERVICES[name]["target_inputs"])


if WANT_SPLIT:
    @app.cls(**_cls_kwargs("moge2", moge_image))
    @_concurrency("moge2")
    class MoGe2:
        @modal.enter(snap=GPU_SNAPSHOT)       # snap=True -> runs once, then the warm process is snapshotted
        def load(self):
            self.engine = MoGeEngine()
            self.engine.load()
            self.engine.warmup()
            release_cached_memory()

        @modal.asgi_app(label="vision-moge2", requires_proxy_auth=REQUIRE_PROXY_AUTH)
        def api(self):
            return build_moge_api(self.engine)

        @modal.method()
        def selftest(self) -> dict:
            return self.engine.selftest()


    @app.cls(**_cls_kwargs("marigold", marigold_image))
    @_concurrency("marigold")
    class MarigoldIID:
        @modal.enter(snap=GPU_SNAPSHOT)
        def load(self):
            self.engine = MarigoldEngine()
            self.engine.load()
            self.engine.warmup()
            release_cached_memory()

        @modal.asgi_app(label="vision-marigold", requires_proxy_auth=REQUIRE_PROXY_AUTH)
        def api(self):
            return build_marigold_api(self.engine)

        @modal.method()
        def selftest(self) -> dict:
            return self.engine.selftest()


    @app.cls(**_cls_kwargs("sam3", sam3_image))
    @_concurrency("sam3")
    class Sam3:
        @modal.enter(snap=GPU_SNAPSHOT)
        def load(self):
            self.engine = Sam3Engine()
            self.engine.load()
            self.engine.warmup()
            release_cached_memory()

        @modal.asgi_app(label="vision-sam3", requires_proxy_auth=REQUIRE_PROXY_AUTH)
        def api(self):
            return build_sam3_api(self.engine)

        @modal.method()
        def selftest(self) -> dict:
            return self.engine.selftest()


    @app.cls(**_cls_kwargs("oneformer", oneformer_image))
    @_concurrency("oneformer")
    class OneFormer:
        @modal.enter(snap=GPU_SNAPSHOT)
        def load(self):
            self.engine = OneFormerEngine()
            self.engine.load()
            self.engine.warmup()
            release_cached_memory()

        @modal.asgi_app(label="vision-oneformer", requires_proxy_auth=REQUIRE_PROXY_AUTH)
        def api(self):
            return build_oneformer_api(self.engine)

        @modal.method()
        def selftest(self) -> dict:
            return self.engine.selftest()


if WANT_CATALOG_SPLIT:
    @app.cls(**_cls_kwargs("catalog", catalog_image, volumes=_CATALOG_VOLUMES, extra_secrets=vertex_secrets))
    @_concurrency("catalog")
    class CatalogSearch:
        """DINOv2 + SigLIP behind the catalogue routes (label "vision-catalog"), and the writer's batch encoder."""

        @modal.enter(snap=GPU_SNAPSHOT)
        def load(self):
            self.engine = CatalogEngine()
            self.engine.load()
            self.engine.warmup()
            release_cached_memory()

        @modal.asgi_app(label="vision-catalog", requires_proxy_auth=REQUIRE_PROXY_AUTH)
        def api(self):
            return build_catalog_api(self.engine, _catalog_context())

        @modal.method()
        def encode_catalog(self, dino_batch, siglip_batch):
            """Batch encoding for the writer's stage 2 (holds the container's GPU slot like a web request)."""
            with gpu_exclusive():
                return self.engine.encode_prepared(dino_batch, siglip_batch)

        @modal.method()
        def evaluate(self, catalog: str = DEFAULT_CATALOG, sample_size: int = 40, seed: int = 0) -> list:
            ctx = _catalog_context()
            return evaluate_self_retrieval(ctx.library.get(catalog), self.engine, ctx.guard, sample_size, seed)

        @modal.method()
        def selftest(self) -> dict:
            return self.engine.selftest()


if WANT_COMBINED:
    _vision_volumes = _CATALOG_VOLUMES if CATALOG_IN_VISION_ALL else None
    _vision_secrets = vertex_secrets if CATALOG_IN_VISION_ALL else None

    @app.cls(**_cls_kwargs("vision", vision_image, volumes=_vision_volumes, extra_secrets=_vision_secrets))
    @_concurrency("vision")
    class VisionAll:
        """Every model in one container behind one URL (see "ONE POOL OR SEVERAL" at the top of the file)."""

        @modal.enter(snap=GPU_SNAPSHOT)
        def load(self):
            self.engines = {"moge2": MoGeEngine(), "marigold": MarigoldEngine(), "sam3": Sam3Engine(),
                            "oneformer": OneFormerEngine()}
            if CATALOG_IN_VISION_ALL:
                self.engines["catalog"] = CatalogEngine()
            for key, engine in self.engines.items():
                if key == "marigold":
                    engine.load(("lighting",))           # "appearance" is not used by Swatchroom
                else:
                    engine.load()
                engine.warmup()
                release_cached_memory()                    # one model's warm-up cache never piles up on the next

        @modal.asgi_app(label="vision-all", requires_proxy_auth=REQUIRE_PROXY_AUTH)
        def api(self):
            ctx = _catalog_context() if "catalog" in self.engines else None
            return build_vision_api(self.engines, ctx)

        @modal.method()
        def encode_catalog(self, dino_batch, siglip_batch):
            if "catalog" not in self.engines:
                raise RuntimeError("this VisionAll was deployed with VISION_ALL_CATALOG=0")
            with gpu_exclusive():
                return self.engines["catalog"].encode_prepared(dino_batch, siglip_batch)

        @modal.method()
        def evaluate(self, catalog: str = DEFAULT_CATALOG, sample_size: int = 40, seed: int = 0) -> list:
            if "catalog" not in self.engines:
                raise RuntimeError("this VisionAll was deployed with VISION_ALL_CATALOG=0")
            ctx = _catalog_context()
            return evaluate_self_retrieval(ctx.library.get(catalog), self.engines["catalog"], ctx.guard,
                                           sample_size, seed)

        @modal.method()
        def selftest(self) -> dict:
            return {key: engine.selftest() for key, engine in self.engines.items()}


@app.cls(image=writer_image, volumes=_CATALOG_VOLUMES, secrets=[runtime_secret] + vertex_secrets, cpu=WRITER_CPU,
         memory=WRITER_MEMORY_MIB, timeout=CATALOG_JOB_TIMEOUT_S, max_containers=1,
         scaledown_window=WRITER_SCALEDOWN_S)
@modal.concurrent(max_inputs=4)
class CatalogWriter:
    """The single writer of catalogue state (max_containers=1): ingests, renders, verifications, provenance
    overlays. CPU only; stage 2 sends its batches to the GPU pool's encode_catalog method."""

    @modal.enter()
    def start(self):
        self.core = CatalogWriterCore(VolumeGuard(data_volume), state_dict, _submit_catalog_batch, VertexProvider())

    @modal.method()
    def ingest(self, catalog: str = DEFAULT_CATALOG, job_id: Optional[str] = None,
               pdf_names: Optional[list] = None, use_vertex: bool = True) -> dict:
        return self.core.ingest(catalog, job_id, pdf_names, use_vertex)

    @modal.method()
    def render(self, catalog: str, item_id: str, scene_jpeg: Optional[bytes] = None, scene_label: Optional[str] = None,
               target_description: Optional[str] = None, extra_instructions: str = "",
               aspect_ratio: Optional[str] = None) -> dict:
        return self.core.render(catalog, item_id, scene_jpeg, scene_label, target_description, extra_instructions,
                                aspect_ratio)

    @modal.method()
    def verify(self, catalog: str, item_id: str) -> dict:
        return self.core.verify(catalog, item_id)

    @modal.method()
    def provenance(self, catalog: str, item_id: str) -> bytes:
        return self.core.provenance(catalog, item_id)

    @modal.exit()
    def stop(self):
        self.core.close()


# =====================================================================================
# 7. OPERATIONS: self-test, snapshot priming, optional warm window
# =====================================================================================
def set_min_containers(count: int, services: Optional[list] = None):
    """Change the deployed services' warm pool without a redeploy (Modal's update_autoscaler). Default: the pool(s)
    `prime` would warm, i.e. VisionAll when it is deployed."""
    for key in (services or PRIMED_SERVICES):
        if key not in DEPLOYED_SERVICES:
            continue
        modal.Cls.from_name(APP_NAME, SERVICE_CLASSES[key])().update_autoscaler(min_containers=count)
        print(f"{key:10s} min_containers={count}")


def prime(containers: int = 2, settle_s: int = 60):
    """Run right after `modal deploy`: boots `containers` containers per service at once, so the snapshot-creating
    boots (a full load + warm-up + snapshot, per GPU type and host type) happen now and not on users' requests,
    then hands the pool back to the autoscaler. Costs a few GPU-minutes per service."""
    handles = {}
    for key in PRIMED_SERVICES:
        handles[key] = modal.Cls.from_name(APP_NAME, SERVICE_CLASSES[key])()
        handles[key].update_autoscaler(min_containers=containers)
    calls = {}
    for key, handle in handles.items():
        calls[key] = handle.selftest.spawn()
    for key, call in calls.items():
        try:
            print(f"{key:10s}", call.get(timeout=STARTUP_TIMEOUT_S))
        except Exception as e:
            print(f"{key:10s} FAILED: {e!r}")
    print(f"letting the remaining containers finish booting ({settle_s} s)...")
    time.sleep(settle_s)
    for handle in handles.values():
        handle.update_autoscaler(min_containers=MIN_CONTAINERS)
    print(f"done; min_containers is back to {MIN_CONTAINERS}")


if WARM_WINDOW:
    _ops_image = modal.Image.debian_slim(python_version="3.12")

    @app.function(image=_ops_image, schedule=modal.Cron(WARM_WINDOW["start"], timezone=WARM_TZ))
    def warm_window_start():
        set_min_containers(int(WARM_WINDOW.get("containers", 1)), WARM_WINDOW.get("services"))

    @app.function(image=_ops_image, schedule=modal.Cron(WARM_WINDOW["stop"], timezone=WARM_TZ))
    def warm_window_stop():
        set_min_containers(0, WARM_WINDOW.get("services"))


@app.local_entrypoint()
def main():
    """`modal run vision_stack.py` -> boots the GPU pool(s) of this layout in parallel and runs a real inference on
    every model. Costs a few GPU-minutes; the Swatchroom server never runs it."""
    calls = {}
    if WANT_SPLIT:
        calls.update({"moge2": MoGe2().selftest.spawn(), "marigold": MarigoldIID().selftest.spawn(),
                      "sam3": Sam3().selftest.spawn(), "oneformer": OneFormer().selftest.spawn()})
    if WANT_CATALOG_SPLIT:
        calls["catalog"] = CatalogSearch().selftest.spawn()
    if WANT_COMBINED:
        calls["vision-all"] = VisionAll().selftest.spawn()
    for name, call in calls.items():
        print(f"{name:10s}", call.get())


# ---- catalogue CLI (talks to the DEPLOYED app with your local Modal credentials) ----------------------------------
def cli_ingest(argv: list) -> int:
    import argparse
    parser = argparse.ArgumentParser(prog="python vision_stack.py ingest",
                                     description="Upload catalogue PDF(s) to the Volume and run the ingest on Modal.")
    parser.add_argument("pdf", nargs="*", help="local PDF file(s); none = re-run on the PDFs already on the Volume")
    parser.add_argument("--catalog", default=DEFAULT_CATALOG)
    parser.add_argument("--no-vertex", action="store_true", help="skip Vertex image vectors, captions, text vectors")
    parser.add_argument("--wait", action="store_true", help="follow the job until it finishes")
    args = parser.parse_args(argv)
    try:
        catalog = validate_catalog_name(args.catalog)
    except ApiError as e:
        print(e.detail)
        return 2
    pdf_names = []
    if args.pdf:
        uploads = []
        for local in args.pdf:
            path = Path(local).expanduser()
            if not path.is_file():
                print(f"not a file: {path}")
                return 2
            with open(path, "rb") as handle:
                if b"%PDF-" not in handle.read(1024):
                    print(f"not a PDF (no %PDF header): {path}")
                    return 2
            uploads.append((path, safe_pdf_filename(path.name)))
        with data_volume.batch_upload(force=True) as batch:
            for path, name in uploads:
                batch.put_file(str(path), f"/catalogs/{catalog}/pdfs/{name}")
                pdf_names.append(name)
                print(f"uploading {path} -> {DATA_VOLUME_NAME}:/catalogs/{catalog}/pdfs/{name}")
    writer = modal.Cls.from_name(APP_NAME, "CatalogWriter")()
    job = start_ingest_job(state_dict, writer, catalog, pdf_names or None, not args.no_vertex)
    print(f"job {job['job_id']} queued (catalogue {catalog}); progress: python vision_stack.py job {job['job_id']}")
    if not args.wait:
        return 0
    return cli_job([job["job_id"], "--wait"])


def cli_job(argv: list) -> int:
    import argparse
    parser = argparse.ArgumentParser(prog="python vision_stack.py job")
    parser.add_argument("job_id")
    parser.add_argument("--wait", action="store_true")
    args = parser.parse_args(argv)
    last_line = None
    while True:
        status = read_job_status(state_dict, args.job_id)
        if status is None:
            print(f"no job {args.job_id}")
            return 1
        progress = status.get("progress") or {}
        line = f"{status.get('state')}: {status.get('stage') or ''}"
        if progress:
            line += f" {progress.get('done')}/{progress.get('total')} {progress.get('detail') or ''}".rstrip()
        if line != last_line:
            print(time.strftime("%H:%M:%S"), line)
            last_line = line
        if status.get("state") in ("done", "failed", "expired") or not args.wait:
            if status.get("state") in ("done", "failed"):
                print(json.dumps(json_safe(status.get("result") or {"error": status.get("error")}), indent=2))
            return 0 if status.get("state") != "failed" else 1
        time.sleep(5)


def cli_catalogs(argv: list) -> int:
    root = "/catalogs"
    try:
        entries = data_volume.listdir(root)
        folders = [entry.path for entry in entries if entry.type == modal.volume.FileEntryType.DIRECTORY]
    except Exception as e:
        print(f"nothing on {DATA_VOLUME_NAME} yet ({type(e).__name__})")
        return 0
    for folder in sorted(folders):
        name = folder.rstrip("/").split("/")[-1]
        try:
            published = json.loads(b"".join(data_volume.read_file(f"{root}/{name}/published.json")))
            summary = published.get("summary", {})
            print(f"{name:20s} v{published.get('version')}  {published.get('updated_at')}  items={published.get('items')}"
                  f"  captions={summary.get('captions')}  vectors={summary.get('embeddings')}  ({published.get('reason')})")
        except Exception:
            print(f"{name:20s} (not published yet)")
    return 0


def cli_evaluate(argv: list) -> int:
    import argparse
    parser = argparse.ArgumentParser(prog="python vision_stack.py evaluate")
    parser.add_argument("--catalog", default=DEFAULT_CATALOG)
    parser.add_argument("--sample-size", type=int, default=40)
    args = parser.parse_args(argv)
    service = CATALOG_ENCODER_SERVICE
    handle = modal.Cls.from_name(APP_NAME, SERVICE_CLASSES[service])()
    rows = handle.evaluate.remote(args.catalog, args.sample_size, 0)
    for row in rows:
        print(f"{row['signal']:14s} recall@1={row['recall@1']:.3f} recall@5={row['recall@5']:.3f} "
              f"mrr={row['mrr']:.3f} (n={row['queries']})")
    return 0


if __name__ == "__main__":
    # python vision_stack.py prime [containers]   (talks to the deployed app; needs your local Modal credentials)
    # python vision_stack.py ingest PDF... [--catalog NAME] [--no-vertex] [--wait]
    # python vision_stack.py job JOB_ID [--wait] | catalogs | evaluate [--catalog NAME] [--sample-size N]
    command = sys.argv[1] if len(sys.argv) > 1 else None
    if command == "prime":
        prime(int(sys.argv[2]) if len(sys.argv) > 2 else 2)
    elif command == "ingest":
        sys.exit(cli_ingest(sys.argv[2:]))
    elif command == "job":
        sys.exit(cli_job(sys.argv[2:]))
    elif command == "catalogs":
        sys.exit(cli_catalogs(sys.argv[2:]))
    elif command == "evaluate":
        sys.exit(cli_evaluate(sys.argv[2:]))
    else:
        print(__doc__)