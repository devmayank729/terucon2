"""
vision_stack.py - MoGe-2, Marigold-IID, SAM 3 and OneFormer as four independent, autoscaling Modal GPU services
(one container pool, one URL and one ordered GPU fallback list per model).

DEPLOY
    modal secret create vision-api-keys API_KEYS="$(openssl rand -hex 32),$(openssl rand -hex 32)"
    modal secret create huggingface HF_TOKEN=hf_xxx      # account must have access to facebook/sam3
    modal run    vision_stack.py                         # GPU self-test of all four models
    modal deploy vision_stack.py                         # prints the four URLs
    python vision_stack.py prime                         # optional, right after a deploy: create the GPU snapshots
                                                         # now instead of on your users' first requests

    VISION_GPU_TIER=economy modal deploy vision_stack.py # L4-first lists (cheaper, slower). Default tier: "fast"
    VISION_MIN_CONTAINERS=1 modal deploy vision_stack.py # always one warm container per service (no cold start)

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

ONE POOL OR FOUR  (VISION_LAYOUT, default "both")
    Every Modal service is its own container pool, and each pool bills SCALEDOWN_S of idle time after its last call. A
    photo that touches four services therefore wakes four GPUs and pays four idle tails. The "VisionAll" class holds all
    four models in ONE container behind ONE URL (label "vision-all") and serves every route above, so one photo costs
    one cold start and one idle tail. The four dedicated classes stay available for the day one model needs its own GPU.
        both      (default)  deploy VisionAll next to the four classes: your existing URLs keep working, and you
                             switch the Swatchroom .env to the vision-all URLs when you are ready
        combined             deploy only VisionAll (the four old URLs stop working, nothing idles on them)
        split                the four dedicated classes only (the layout before this change)
    VisionAll runs the models one after another on one GPU (GpuGate), about 1.5-2 s of GPU time per photo for all of
    them; Marigold's "appearance" checkpoint is not loaded there (nothing in Swatchroom uses it), which saves VRAM and
    snapshot size. Use `modal run` to self-test it, `python vision_stack.py prime` to create its snapshots.

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
import time
import zipfile
from typing import Literal, Optional

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
        "vision":    ["L40S", "A100-80GB", "L4"],   # all four models at once: about 12 GB of weights + activations
    },
    "economy": {   # cheapest first; the first fallback is faster, so a sold-out L4 pool never makes a request slower
        "moge2":     ["L4", "L40S", "A10"],
        "marigold":  ["L4", "L40S", "A10"],
        "sam3":      ["L4", "L40S", "A10"],
        "oneformer": ["L4", "L40S", "A10"],
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
                   "vision": "VisionAll"}
# What exists in this layout, and what `prime` / the warm window act on: the combined pool when there is one (the
# four dedicated pools are then only a fallback nobody should be paying to keep warm).
DEPLOYED_SERVICES = [key for key in SERVICE_CLASSES
                     if (key == "vision" and WANT_COMBINED) or (key != "vision" and WANT_SPLIT)]
PRIMED_SERVICES = ["vision"] if WANT_COMBINED else [key for key in DEPLOYED_SERVICES if key != "vision"]

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

WEIGHTS = "/weights"
MOGE_SRC, SAM3_SRC = "/opt/MoGe", "/opt/sam3"


# =====================================================================================
# 2. IMAGES  (shared base -> cached once; weights baked as the last layer of each image)
# =====================================================================================
app = modal.App(APP_NAME)
hf_secret = modal.Secret.from_name(HF_SECRET)
api_keys_secret = modal.Secret.from_name(API_KEYS_SECRET)
runtime_secret = modal.Secret.from_dict({"VISION_GPU_TIER": GPU_TIER})   # containers see the tier you deployed

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
    missing = [k for k in info.get("missing_keys", []) if not k.startswith("criterion.")]   # loss buffers only
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
    missing = [k for k in res.missing_keys if not k.startswith("criterion.")]
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

sam3_image = (
    _base
    .run_commands(_git_checkout("https://github.com/facebookresearch/sam3.git", SAM3_COMMIT, SAM3_SRC))
    .uv_pip_install("timm>=1.0.17", "ftfy==6.1.1", "regex", "iopath>=0.1.10", "typing_extensions",
                    "psutil", "setuptools<81", "einops", "pycocotools", "scikit-image", "scikit-learn", "pandas", "decord"
                    )  # sam3 imports pkg_resources
    .run_function(_bake_sam3, secrets=[hf_secret], gpu="L4")
    .env(_RUNTIME_ENV)
)

oneformer_image = (
    _base
    .uv_pip_install(TRANSFORMERS_PIN)          # scipy (needed by the model's loss module) is in the base layer
    .run_function(_bake_oneformer)
    .env(_RUNTIME_ENV)
)

# ONE image for the combined pool, stacked on sam3_image so Modal reuses its cached layers (the gated SAM 3 download
# included) instead of baking SAM 3 twice. The pins of the four images above resolve together without conflict
# (checked with `uv pip compile --python-version 3.12`: torch 2.10.0+cu128, transformers 5.20.2, diffusers 0.42.0,
# numpy 1.26.4, timm 1.0.x). If a future bump ever breaks that, deploy with VISION_LAYOUT=split.
vision_image = (
    sam3_image
    .run_commands(_git_checkout("https://github.com/microsoft/MoGe.git", MOGE_COMMIT, MOGE_SRC))
    .uv_pip_install("matplotlib", UTILS3D_PIN)             # pandas is already in the SAM 3 layer
    .run_function(_bake_moge)
    .uv_pip_install("diffusers==0.42.0", TRANSFORMERS_PIN, "accelerate")
    .run_function(_bake_marigold_lighting)
    .run_function(_bake_oneformer)
    .env(_RUNTIME_ENV)
)


# =====================================================================================
# 3. SHARED RUNTIME: auth, errors, image I/O, GPU gate, timing
# =====================================================================================
class ApiError(Exception):
    def __init__(self, status: int, code: str, detail: str, headers: Optional[dict] = None):
        super().__init__(detail)
        self.status, self.code, self.detail, self.headers = status, code, detail, headers or {}


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

    def __init__(self, app, digests: list, max_body: int):
        self.app, self.digests, self.max_body = app, digests, max_body

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
        if cl.isdigit() and int(cl) > self.max_body:
            return await self._reject(send, 413, "payload_too_large", f"Upload exceeds {MAX_UPLOAD_BYTES} bytes.")
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
        self.active += 1
        try:
            yield time.perf_counter() - t0
        finally:
            self.active -= 1
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


def make_base_app(service: str, gate: GpuGate, info: dict):
    from fastapi import FastAPI
    from fastapi.responses import JSONResponse

    api = FastAPI(title=f"vision-stack/{service}", docs_url=None, redoc_url=None, openapi_url=None)
    clock = ContainerClock(info.get("gpu", ""), gpu_rank(service, info.get("gpu", "")))
    # the last middleware added is the outermost: auth and the size check run first, telemetry only sees real calls
    api.add_middleware(TelemetryMiddleware, clock=clock)
    api.add_middleware(SecurityMiddleware, digests=_load_api_keys(), max_body=MAX_UPLOAD_BYTES + 1_048_576)

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
        self.model = model.eval().requires_grad_(False)
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
        missing = [k for k in res.missing_keys if not k.startswith("criterion.")]
        if missing:
            raise RuntimeError(f"OneFormer weights incomplete: {missing[:10]}")
        self.model = model.eval().requires_grad_(False)
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


def build_vision_api(engines: dict):
    """One FastAPI app, one GpuGate, every route: /v1/geometry /v1/decompose /v1/segment /v1/parse /v1/oneformer
    /v1/classes /v1/analyze /healthz. The dedicated routes work exactly as on the four dedicated classes, so
    MOGE2_URL / MARIGOLD_URL / SAM3_URL / ONEFORMER_URL can all point at this one domain."""
    gate = GpuGate()
    info = {"model": "vision-all", "models": {key: engine.info() for key, engine in engines.items()},
            "gpu": _gpu_name()}
    api = make_base_app("vision", gate, info)
    if "moge2" in engines:
        add_moge_routes(api, gate, engines["moge2"])
    if "marigold" in engines:
        add_marigold_routes(api, gate, engines["marigold"])
    if "sam3" in engines:
        add_sam3_routes(api, gate, engines["sam3"])
    if "oneformer" in engines:
        add_oneformer_routes(api, gate, engines["oneformer"])
    add_analyze_routes(api, gate, engines)
    return api


# =====================================================================================
# 6. MODAL SERVICES
# =====================================================================================
def _cls_kwargs(name: str, image: modal.Image) -> dict:
    cfg = SERVICES[name]
    kw = dict(
        image=image, gpu=cfg["gpu"], secrets=[api_keys_secret, runtime_secret], cpu=CPU_CORES,
        memory=cfg["memory_mib"], timeout=REQUEST_TIMEOUT_S, startup_timeout=STARTUP_TIMEOUT_S,
        scaledown_window=SCALEDOWN_S, min_containers=MIN_CONTAINERS, max_containers=MAX_CONTAINERS,
        buffer_containers=BUFFER_CONTAINERS,
    )
    if GPU_SNAPSHOT:
        kw.update(enable_memory_snapshot=True, experimental_options={"enable_gpu_snapshot": True})
    return kw


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


if WANT_COMBINED:
    @app.cls(**_cls_kwargs("vision", vision_image))
    @_concurrency("vision")
    class VisionAll:
        """All four models in one container behind one URL (see "ONE POOL OR FOUR" at the top of the file)."""

        @modal.enter(snap=GPU_SNAPSHOT)
        def load(self):
            self.engines = {"moge2": MoGeEngine(), "marigold": MarigoldEngine(), "sam3": Sam3Engine(),
                            "oneformer": OneFormerEngine()}
            for key, engine in self.engines.items():
                if key == "marigold":
                    engine.load(("lighting",))           # "appearance" is not used by Swatchroom
                else:
                    engine.load()
                engine.warmup()
                release_cached_memory()                    # one model's warm-up cache never piles up on the next

        @modal.asgi_app(label="vision-all", requires_proxy_auth=REQUIRE_PROXY_AUTH)
        def api(self):
            return build_vision_api(self.engines)

        @modal.method()
        def selftest(self) -> dict:
            return {key: engine.selftest() for key, engine in self.engines.items()}


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
    if WANT_COMBINED:
        calls["vision-all"] = VisionAll().selftest.spawn()
    for name, call in calls.items():
        print(f"{name:10s}", call.get())


if __name__ == "__main__":
    # python vision_stack.py prime [containers]   (talks to the deployed app; needs your local Modal credentials)
    if sys.argv[1:2] == ["prime"]:
        prime(int(sys.argv[2]) if len(sys.argv) > 2 else 2)
    else:
        print(__doc__)