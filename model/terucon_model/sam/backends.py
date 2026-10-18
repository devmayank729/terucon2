"""SAM backends. Nothing here is imported unless SAM_ENABLED=true.

    HfSamBackend    SAM 2 / 2.1 or SAM 1 through Hugging Face transformers. Boxes and points, no text.
                    Runs on CPU (about 3 s to embed a photo, then ~0.1 s per prompt) or a GPU.
    Sam3Backend     Meta's official `sam3` package: text prompts ("wall", "floor") plus boxes.
                    Needs CUDA and the gated facebook/sam3 checkpoint. Mirrors the calls used in the
                    earlier Kaggle SAM 3 benchmark scripts. NOT exercised by the test-suite (no GPU here).
    RemoteBackend   Another server that speaks the same /health, /segment, /refine contract.
"""
from __future__ import annotations

import base64
import io
import os
import re
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np
import requests
from PIL import Image


@dataclass
class Candidate:
    mask: np.ndarray  # bool, H x W
    score: float


@dataclass
class ImageHandle:
    height: int
    width: int
    payload: Any = None  # backend-specific (embeddings, state, remote id, ...)
    created: float = field(default_factory=time.time)


class SamUnavailable(RuntimeError):
    """The backend cannot start (missing package, gated model, no GPU, ...). The message is user-facing."""


def pick_device(requested: str) -> str:
    import torch

    r = (requested or "auto").lower()
    if r != "auto":
        if r == "cuda" and not torch.cuda.is_available():
            raise SamUnavailable("SAM_DEVICE=cuda but no CUDA GPU is available on this machine.")
        return r
    if torch.cuda.is_available():
        return "cuda"
    if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        return "mps"
    return "cpu"


# =============================================================================== transformers
class HfSamBackend:
    interactive = True
    text_prompts = False

    def __init__(self, model_id: str, device: str = "auto", token: str = ""):
        self.model_id = model_id
        self.device_pref = device
        self.token = token or None
        self.device = "cpu"
        self.kind = "sam2" if "sam2" in model_id.lower() or "sam-2" in model_id.lower() else "sam"
        self._model: Any = None
        self._processor: Any = None
        self._torch: Any = None

    @property
    def name(self) -> str:
        """'SAM 2.1 small' from 'facebook/sam2.1-hiera-small'; the raw id for anything unfamiliar."""
        tail = self.model_id.split("/")[-1].lower()
        m = re.match(r"sam(2\.1|2)-hiera-(tiny|small|base-plus|large)$", tail)
        if m:
            return f"SAM {m.group(1)} {m.group(2).replace('-plus', '+').replace('base', 'base')}"
        m = re.match(r"sam-vit-(base|large|huge)$", tail)
        if m:
            return f"SAM ViT-{m.group(1)[0].upper()}"
        return self.model_id.split("/")[-1]

    def load(self) -> None:
        try:
            import torch
            import transformers
        except ImportError as exc:
            raise SamUnavailable("SAM needs PyTorch and transformers. Run: pip install -r requirements-sam.txt") from exc
        self._torch = torch
        self.device = pick_device(self.device_pref)
        if self.device == "cpu":
            torch.set_num_threads(max(1, os.cpu_count() or 4))
        try:
            if self.kind == "sam2":
                if not hasattr(transformers, "Sam2Model"):
                    raise SamUnavailable("This transformers version has no SAM 2. Run: pip install -U transformers")
                self._processor = transformers.Sam2Processor.from_pretrained(self.model_id, token=self.token)
                self._model = transformers.Sam2Model.from_pretrained(self.model_id, token=self.token)
            else:
                self._processor = transformers.SamProcessor.from_pretrained(self.model_id, token=self.token)
                self._model = transformers.SamModel.from_pretrained(self.model_id, token=self.token)
        except SamUnavailable:
            raise
        except Exception as exc:  # noqa: BLE001 - download/auth problems all end up here
            msg = str(exc)
            if "401" in msg or "gated" in msg.lower() or "access" in msg.lower() and "restricted" in msg.lower():
                raise SamUnavailable(f"{self.model_id} needs access: accept its licence on Hugging Face and set HF_TOKEN in .env.") from exc
            raise SamUnavailable(f"Could not load {self.model_id}: {msg[:200]}") from exc
        self._model.to(self.device).eval()

    def embed(self, rgb: np.ndarray) -> ImageHandle:
        torch = self._torch
        h, w = rgb.shape[:2]
        inputs = self._processor(images=Image.fromarray(rgb), return_tensors="pt")
        with torch.inference_mode():
            emb = self._model.get_image_embeddings(inputs["pixel_values"].to(self.device))
        return ImageHandle(h, w, payload=emb)

    def predict(self, handle: ImageHandle, box=None, points=None, labels=None, multimask: bool = True) -> list[Candidate]:
        torch = self._torch
        kw: dict[str, Any] = {"original_sizes": [[handle.height, handle.width]], "return_tensors": "pt"}
        if box is not None:
            kw["input_boxes"] = [[[float(v) for v in box]]]
        if points:
            kw["input_points"] = [[[[float(x), float(y)] for x, y in points]]]
            kw["input_labels"] = [[[int(v) for v in (labels or [1] * len(points))]]]
        enc = self._processor(**kw)
        call: dict[str, Any] = {"image_embeddings": handle.payload, "multimask_output": bool(multimask)}
        for key in ("input_boxes", "input_points", "input_labels"):
            if key in enc and enc[key] is not None:
                call[key] = enc[key].to(self.device)
        with torch.inference_mode():
            out = self._model(**call)
        masks = self._processor.post_process_masks(out.pred_masks.cpu(), enc["original_sizes"])[0]
        scores = out.iou_scores.cpu().numpy().reshape(-1)
        m = masks.reshape(-1, masks.shape[-2], masks.shape[-1]).numpy().astype(bool)
        return [Candidate(m[i], float(scores[i])) for i in range(min(len(m), len(scores)))]


# =============================================================================== official SAM 3
class Sam3Backend:
    interactive = False  # image-level concept segmentation; click refinement uses the tracker model
    text_prompts = True

    def __init__(self, checkpoint: str, repo_dir: str = "", device: str = "auto", resolution: int = 1008):
        self.checkpoint = checkpoint
        self.repo_dir = repo_dir
        self.device_pref = device
        self.resolution = resolution
        self.model_id = "facebook/sam3"
        self.kind = "sam3"
        self.device = "cuda"
        self._processor: Any = None
        self._torch: Any = None

    @property
    def name(self) -> str:
        return "SAM 3"

    def load(self) -> None:
        try:
            import torch
        except ImportError as exc:
            raise SamUnavailable("SAM 3 needs PyTorch with CUDA.") from exc
        self._torch = torch
        if not torch.cuda.is_available():
            raise SamUnavailable("SAM 3 needs a CUDA GPU. Use SAM_BACKEND=sam2 on this machine, or SAM_BACKEND=remote to use a GPU server.")
        if self.repo_dir and self.repo_dir not in sys.path:
            sys.path.insert(0, self.repo_dir)
        try:
            from sam3.model.sam3_image_processor import Sam3Processor
            from sam3.model_builder import build_sam3_image_model
        except ImportError as exc:
            raise SamUnavailable("The sam3 package was not found. Clone https://github.com/facebookresearch/sam3, `pip install -e .`, "
                                 "and set SAM_REPO_DIR in .env to the clone.") from exc
        if not (self.checkpoint and Path(self.checkpoint).is_file()):
            raise SamUnavailable("SAM_CHECKPOINT must point at sam3.pt (download facebook/sam3 from Hugging Face with an approved HF_TOKEN).")
        model = build_sam3_image_model(
            checkpoint_path=self.checkpoint, load_from_HF=False, device="cuda", eval_mode=True,
            enable_segmentation=True, enable_inst_interactivity=False, compile=False,
        )
        self._processor = Sam3Processor(model, device="cuda", resolution=self.resolution, confidence_threshold=0.2)

    def embed(self, rgb: np.ndarray) -> ImageHandle:
        torch = self._torch
        with torch.inference_mode(), torch.autocast(device_type="cuda", dtype=torch.float16):
            state = self._processor.set_image(Image.fromarray(rgb))
        return ImageHandle(rgb.shape[0], rgb.shape[1], payload=state)

    def segment_text(self, handle: ImageHandle, prompts: list[str], threshold: float, max_per_prompt: int) -> list[dict[str, Any]]:
        import cv2

        torch = self._torch
        found: list[dict[str, Any]] = []
        for prompt in prompts:
            with torch.inference_mode(), torch.autocast(device_type="cuda", dtype=torch.float16):
                out = self._processor.set_text_prompt(prompt=prompt, state=handle.payload)
            masks = _to_numpy(out.get("masks", []))
            scores = _to_numpy(out.get("scores", [])).reshape(-1)
            if masks.size == 0:
                continue
            while masks.ndim > 3 and masks.shape[1] == 1:
                masks = masks[:, 0]
            if masks.ndim == 2:
                masks = masks[None]
            order = np.argsort(-scores)[:max_per_prompt]
            for i in order:
                if i >= len(scores) or scores[i] < threshold:
                    continue
                m = masks[i]
                if m.shape != (handle.height, handle.width):
                    m = cv2.resize(m.astype("float32"), (handle.width, handle.height), interpolation=cv2.INTER_LINEAR)
                found.append({"prompt": prompt, "mask": m > 0.5, "score": float(scores[i])})
        return found


def _to_numpy(x: Any) -> np.ndarray:
    if hasattr(x, "detach"):
        x = x.detach().float().cpu().numpy()
    return np.asarray(x)


# =============================================================================== remote (same contract)
class RemoteBackend:
    interactive = True
    text_prompts = True
    kind = "remote"

    def __init__(self, url: str, key: str = "", auth_header: str = "bearer", timeout: float = 120.0):
        self.url = url.rstrip("/")
        self.key = key
        self.auth_header = auth_header
        self.timeout = timeout
        self.model_id = url
        self._health: dict[str, Any] = {}

    @property
    def name(self) -> str:
        return self._health.get("model") or "remote SAM"

    def _headers(self) -> dict[str, str]:
        h = {"Content-Type": "application/json"}
        if self.key:
            if self.auth_header == "x-api-key":
                h["x-api-key"] = self.key
            else:
                h["Authorization"] = "Bearer " + self.key
        return h

    def _call(self, method: str, path: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
        try:
            r = requests.request(method, self.url + path, json=body, headers=self._headers(), timeout=(10, self.timeout))
        except requests.RequestException as exc:
            raise SamUnavailable(f"Could not reach the remote SAM server at {self.url}.") from exc
        try:
            data = r.json()
        except ValueError:
            data = {}
        if r.status_code in (401, 403):
            raise SamUnavailable(f"The remote SAM server rejected the key ({r.status_code}). Check SAM_REMOTE_KEY.")
        if not r.ok:
            detail = data.get("detail") or data.get("error") or data.get("message") or ""
            raise SamUnavailable(f"Remote SAM error {r.status_code}: {str(detail)[:200]}")
        return data

    def load(self) -> None:
        self._health = self._call("GET", "/health")
        self.interactive = self._health.get("interactive", True) is not False
        self.text_prompts = bool(self._health.get("text_prompts", True))

    def embed(self, rgb: np.ndarray) -> ImageHandle:
        buf = io.BytesIO()
        Image.fromarray(rgb).save(buf, "JPEG", quality=92)
        return ImageHandle(rgb.shape[0], rgb.shape[1], payload={"image": base64.b64encode(buf.getvalue()).decode(), "image_id": None})

    def predict(self, handle: ImageHandle, box=None, points=None, labels=None, multimask: bool = True) -> list[Candidate]:
        body: dict[str, Any] = {"points": [list(p) for p in (points or [])], "labels": list(labels or [1] * len(points or []))}
        if box is not None:
            body["box"] = [float(v) for v in box]
        if handle.payload.get("image_id"):
            body["image_id"] = handle.payload["image_id"]
        else:
            body["image"] = handle.payload["image"]
        data = self._call("POST", "/refine", body)
        handle.payload["image_id"] = data.get("image_id") or handle.payload.get("image_id")
        m = decode_png_mask(data["mask"], handle.height, handle.width)
        return [Candidate(m, float(data.get("score", 1.0)))]

    def segment_text(self, handle: ImageHandle, prompts: list[str], threshold: float, max_per_prompt: int) -> list[dict[str, Any]]:
        data = self._call("POST", "/segment", {"image": handle.payload["image"], "prompts": prompts, "confidence_threshold": threshold, "max_per_prompt": max_per_prompt})
        handle.payload["image_id"] = data.get("image_id") or handle.payload.get("image_id")
        out = []
        for d in data.get("detections", []):
            if d.get("mask"):
                out.append({"prompt": d.get("prompt", ""), "mask": decode_png_mask(d["mask"], handle.height, handle.width), "score": float(d.get("score", 1.0))})
        return out


# =============================================================================== helpers
def decode_png_mask(b64_png: str, height: int, width: int) -> np.ndarray:
    raw = b64_png.split(",", 1)[1] if b64_png.startswith("data:") else b64_png
    img = Image.open(io.BytesIO(base64.b64decode(raw)))
    arr = np.array(img.convert("RGBA"))
    m = (arr[..., 0] > 127) & (arr[..., 3] > 0)
    if m.shape != (height, width):
        m = np.array(Image.fromarray(m.astype(np.uint8) * 255).resize((width, height), Image.BILINEAR)) > 127
    return m


def encode_png_mask(mask: np.ndarray) -> str:
    buf = io.BytesIO()
    Image.fromarray((mask.astype(np.uint8)) * 255, "L").save(buf, "PNG", optimize=True)
    return base64.b64encode(buf.getvalue()).decode("ascii")
