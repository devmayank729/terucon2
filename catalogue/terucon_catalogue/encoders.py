"""The neural encoders: DINOv2 texture, SigLIP image/text, on CPU or one or more CUDA devices, and the stage that runs them over every crop.

# Ported from terucon-cat-1.ipynb (cell 4). Definitions are copied verbatim except where marked "PORT:".

PORT: torch is NOT imported when this module is imported. The three classes that subclass torch classes (DinoTextureEncoder, SiglipImageEncoder,
CropFeatureDataset) are built on first use and reachable as module attributes (PEP 562), so `from terucon_catalogue.encoders import
DinoTextureEncoder` works; everything else is an ordinary module-level object that imports torch / transformers / torchvision inside.
PORT: the notebook's HardwareProfile / verify_dual_t4 (which required exactly two T4 GPUs) are replaced by cfg.device: "auto" (CUDA when there is
one, else CPU) | "cpu" | "cuda" | "cuda:N"; fp16 only on CUDA; DataParallel only with >= 2 CUDA devices and "auto" / "cuda".
"""
from __future__ import annotations

import json
import math
import time
from dataclasses import dataclass
from typing import Any, List, Mapping

import cv2
from PIL import Image

from .features import ColorParams, apply_clahe_rgb, compute_lab_color_descriptor, resolve_crop_path
from .config import local_feature_versions
from .state import EmbeddingRow
from .util import LOGGER, l2_normalize_rows, load_rgb

DINO_DEFAULT_MEAN = (0.485, 0.456, 0.406)


DINO_DEFAULT_STD = (0.229, 0.224, 0.225)


SIGLIP_DEFAULT_MEAN = (0.5, 0.5, 0.5)


SIGLIP_DEFAULT_STD = (0.5, 0.5, 0.5)


LOCAL_PILLARS = ("dino", "siglip", "color")


@dataclass
class HardwareProfile:  # PORT: kept from cell 1 (the field names are the notebook's), without the torch.device annotation
    device: Any
    gpu_count: int
    gpu_names: List[str]
    use_fp16: bool


def resolve_hardware(spec="auto"):
    """PORT: new, replaces verify_dual_t4. spec: "auto" | "cpu" | "cuda" | "cuda:N". Returns a HardwareProfile."""
    import torch

    spec = (spec or "auto").strip().lower()
    if spec == "cpu":
        return HardwareProfile(device=torch.device("cpu"), gpu_count=0, gpu_names=[], use_fp16=False)
    count = torch.cuda.device_count() if torch.cuda.is_available() else 0
    names = []
    for gpu_index in range(count):
        properties = torch.cuda.get_device_properties(gpu_index)
        names.append(f"cuda:{gpu_index} {properties.name} {properties.total_memory / 1024 ** 3:.1f} GiB")
    if spec in ("auto", "cuda"):
        if count == 0:
            if spec == "cuda":
                raise RuntimeError("cfg.device is 'cuda' but torch sees no CUDA device (use 'auto' or 'cpu' to run on the CPU).")
            return HardwareProfile(device=torch.device("cpu"), gpu_count=0, gpu_names=[], use_fp16=False)
        profile = HardwareProfile(device=torch.device("cuda:0"), gpu_count=count, gpu_names=names, use_fp16=True)
    elif spec.startswith("cuda:") and spec[5:].isdigit():
        index = int(spec[5:])
        if index >= count:
            raise RuntimeError(f"cfg.device is {spec!r} but torch sees {count} CUDA device(s).")
        profile = HardwareProfile(device=torch.device(f"cuda:{index}"), gpu_count=1, gpu_names=[names[index]], use_fp16=True)
    else:
        raise ValueError(f"cfg.device must be 'auto', 'cpu', 'cuda' or 'cuda:N', got {spec!r}")
    for name in profile.gpu_names:
        LOGGER.info("GPU %s", name)
    torch.backends.cudnn.benchmark = True  # as verify_dual_t4 did when it found a GPU
    return profile


def _size_value(size, key, default):
    if size is None:
        return default
    value = getattr(size, key, None)
    if value is None and isinstance(size, Mapping):
        value = size.get(key)
    return int(value) if value else default


def load_preprocessing_settings(cfg):
    from transformers import AutoImageProcessor  # PORT: lazy import

    settings = {"dino_mean": DINO_DEFAULT_MEAN, "dino_std": DINO_DEFAULT_STD, "siglip_mean": SIGLIP_DEFAULT_MEAN,
                "siglip_std": SIGLIP_DEFAULT_STD, "siglip_height": 384, "siglip_width": 384}
    try:
        dino_processor = AutoImageProcessor.from_pretrained(cfg.dino_model_name)
        settings["dino_mean"] = tuple(float(value) for value in dino_processor.image_mean)
        settings["dino_std"] = tuple(float(value) for value in dino_processor.image_std)
    except Exception as exc:
        LOGGER.warning("DINOv2 processor config unavailable (%s); using ImageNet statistics.", exc)
    try:
        siglip_processor = AutoImageProcessor.from_pretrained(cfg.siglip_model_name)
        settings["siglip_mean"] = tuple(float(value) for value in siglip_processor.image_mean)
        settings["siglip_std"] = tuple(float(value) for value in siglip_processor.image_std)
        settings["siglip_height"] = _size_value(siglip_processor.size, "height", 384)
        settings["siglip_width"] = _size_value(siglip_processor.size, "width", 384)
    except Exception as exc:
        LOGGER.warning("SigLIP processor config unavailable (%s); using 384px / 0.5 normalisation.", exc)
    return settings


def tensor_from_model_output(output):
    import torch  # PORT: lazy import

    if isinstance(output, torch.Tensor):
        return output
    for attribute in ("text_embeds", "image_embeds", "pooler_output"):
        value = getattr(output, attribute, None)
        if isinstance(value, torch.Tensor):
            return value
    return output[0]


_TORCH_CLASS_NAMES = ("DinoTextureEncoder", "SiglipImageEncoder", "CropFeatureDataset")
_TORCH_CLASSES = None


def _torch_classes():
    """PORT: new. Builds (once) the classes that subclass torch classes. Their bodies are the notebook's, verbatim."""
    global _TORCH_CLASSES
    if _TORCH_CLASSES is None:
        import torch
        import torch.nn as nn
        import torch.nn.functional as F
        from torch.utils.data import Dataset

        class DinoTextureEncoder(nn.Module):
            """[CLS] (global structure) + mean / std over patch tokens (micro-texture statistics)."""

            def __init__(self, backbone, block_weights):
                super().__init__()
                self.backbone = backbone
                self.num_register_tokens = int(getattr(backbone.config, "num_register_tokens", 0) or 0)
                weight_total = float(sum(block_weights))
                self.block_scales = [math.sqrt(float(weight) / weight_total) for weight in block_weights]

            def forward(self, pixel_values):
                # autocast is entered inside forward so each DataParallel replica thread gets it.
                with torch.amp.autocast("cuda", dtype=torch.float16, enabled=pixel_values.is_cuda):
                    outputs = self.backbone(pixel_values=pixel_values)
                hidden = outputs.last_hidden_state.float()
                cls_token = hidden[:, 0]
                patch_tokens = hidden[:, 1 + self.num_register_tokens:]
                patch_mean = patch_tokens.mean(dim=1)
                patch_std = patch_tokens.std(dim=1, unbiased=False)
                blocks = [F.normalize(cls_token, dim=-1) * self.block_scales[0],
                          F.normalize(patch_mean, dim=-1) * self.block_scales[1],
                          F.normalize(patch_std, dim=-1) * self.block_scales[2]]
                return F.normalize(torch.cat(blocks, dim=-1), dim=-1)


        class SiglipImageEncoder(nn.Module):
            """Wraps only the vision tower, so DataParallel does not copy the text tower every step."""

            def __init__(self, vision_model):
                super().__init__()
                self.vision_model = vision_model

            def forward(self, pixel_values):
                with torch.amp.autocast("cuda", dtype=torch.float16, enabled=pixel_values.is_cuda):
                    outputs = self.vision_model(pixel_values=pixel_values)
                return F.normalize(outputs.pooler_output.float(), dim=-1)


        class CropFeatureDataset(Dataset):
            """Decodes each crop once and produces all three local pillars' inputs (runs in DataLoader workers)."""

            def __init__(self, records, dino_transform, siglip_transform, color_params, neural_clip, neural_grid):
                self.records = list(records)
                self.dino_transform = dino_transform
                self.siglip_transform = siglip_transform
                self.color_params = color_params
                self.neural_clip = neural_clip
                self.neural_grid = neural_grid

            def __len__(self):
                return len(self.records)

            def __getitem__(self, index):
                item_id, crop_path = self.records[index]
                try:
                    rgb = load_rgb(crop_path)
                    descriptor = compute_lab_color_descriptor(rgb, self.color_params)
                    neural_rgb = apply_clahe_rgb(rgb, self.neural_clip, self.neural_grid) if self.neural_clip > 0 else rgb
                    pil_image = Image.fromarray(neural_rgb)
                    color_meta = {"dominant_hex": descriptor.dominant_hex, "proportions": descriptor.proportions,
                                  "dominant_lab": descriptor.dominant_lab}
                    return {"ok": True, "item_id": item_id, "dino": self.dino_transform(pil_image),
                            "siglip": self.siglip_transform(pil_image), "color": torch.from_numpy(descriptor.vector),
                            "color_meta": json.dumps(color_meta)}
                except Exception as exc:
                    return {"ok": False, "item_id": item_id, "error": f"{type(exc).__name__}: {exc}"}

        built = {"DinoTextureEncoder": DinoTextureEncoder, "SiglipImageEncoder": SiglipImageEncoder,
                 "CropFeatureDataset": CropFeatureDataset}
        for cls in built.values():  # importable by name, so a DataLoader worker started with "spawn" can unpickle a dataset
            cls.__module__ = __name__
            cls.__qualname__ = cls.__name__
        _TORCH_CLASSES = built
    return _TORCH_CLASSES


def __getattr__(name):  # PEP 562
    if name in _TORCH_CLASS_NAMES:
        return _torch_classes()[name]
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


class EncoderBank:
    # PORT: HardwareProfile / verify_dual_t4 are replaced by cfg.device (see resolve_hardware); a profile can still be passed in.
    def __init__(self, cfg, dino_backbone=None, siglip_model=None, siglip_tokenizer=None, preprocessing=None, hardware=None):
        import torch  # PORT: lazy imports
        import torch.nn as nn
        from torchvision import transforms
        from torchvision.transforms import InterpolationMode
        from transformers import AutoModel, AutoTokenizer

        classes = _torch_classes()
        if hardware is None:
            hardware = resolve_hardware(cfg.device)
        self.cfg = cfg
        self.hardware = hardware
        self.device = hardware.device
        self.dtype = torch.float16 if hardware.use_fp16 else torch.float32
        if preprocessing is None:
            preprocessing = load_preprocessing_settings(cfg)
        self.preprocessing = preprocessing
        if dino_backbone is None:
            LOGGER.info("Loading %s", cfg.dino_model_name)
            dino_backbone = AutoModel.from_pretrained(cfg.dino_model_name)
        if siglip_model is None:
            LOGGER.info("Loading %s", cfg.siglip_model_name)
            siglip_model = AutoModel.from_pretrained(cfg.siglip_model_name)
        if siglip_tokenizer is None:
            siglip_tokenizer = AutoTokenizer.from_pretrained(cfg.siglip_model_name)
        self.siglip_tokenizer = siglip_tokenizer

        dino_backbone = dino_backbone.eval().to(device=self.device, dtype=self.dtype)
        siglip_model = siglip_model.eval().to(device=self.device, dtype=self.dtype)
        dino_backbone.requires_grad_(False)
        siglip_model.requires_grad_(False)
        self.siglip_model = siglip_model
        self.dino_encoder = classes["DinoTextureEncoder"](dino_backbone, cfg.dino_block_weights).eval()  # PORT: built lazily
        self.siglip_image_encoder = classes["SiglipImageEncoder"](siglip_model.vision_model).eval()  # PORT: built lazily
        if hardware.gpu_count >= 2:
            device_ids = list(range(hardware.gpu_count))
            self.dino_runner = nn.DataParallel(self.dino_encoder, device_ids=device_ids, output_device=0)
            self.siglip_runner = nn.DataParallel(self.siglip_image_encoder, device_ids=device_ids, output_device=0)
            LOGGER.info("DINOv2 + SigLIP wrapped in DataParallel over %s (fp16)", device_ids)
        else:
            self.dino_runner = self.dino_encoder
            self.siglip_runner = self.siglip_image_encoder

        self.dino_transform = transforms.Compose([
            transforms.Resize(cfg.dino_resize_short_side, interpolation=InterpolationMode.BICUBIC),
            transforms.CenterCrop(cfg.dino_input_size),
            transforms.ToTensor(),
            transforms.Normalize(preprocessing["dino_mean"], preprocessing["dino_std"]),
        ])
        self.siglip_transform = transforms.Compose([
            transforms.Resize((preprocessing["siglip_height"], preprocessing["siglip_width"]),
                              interpolation=InterpolationMode.BICUBIC),
            transforms.ToTensor(),
            transforms.Normalize(preprocessing["siglip_mean"], preprocessing["siglip_std"]),
        ])
        text_config = getattr(siglip_model.config, "text_config", None)
        self.siglip_text_length = int(getattr(text_config, "max_position_embeddings", 64) or 64)

    def encode_dino(self, pixel_values):
        import torch  # PORT: lazy import; `with` instead of the @torch.inference_mode() decorator (same effect)

        with torch.inference_mode():
            pixel_values = pixel_values.to(self.device, dtype=self.dtype, non_blocking=True)
            return self.dino_runner(pixel_values).float().cpu().numpy()

    def encode_siglip_images(self, pixel_values):
        import torch  # PORT: lazy import; `with` instead of the @torch.inference_mode() decorator (same effect)

        with torch.inference_mode():
            pixel_values = pixel_values.to(self.device, dtype=self.dtype, non_blocking=True)
            return self.siglip_runner(pixel_values).float().cpu().numpy()

    def encode_siglip_text(self, texts):
        import torch  # PORT: lazy imports; `with` instead of the @torch.inference_mode() decorator (same effect)
        import torch.nn.functional as F

        with torch.inference_mode():
            prompts = [self.cfg.siglip_text_template.format(text) for text in texts]
            # SigLIP was trained with max_length padding; other padding silently degrades text embeddings.
            tokens = self.siglip_tokenizer(prompts, padding="max_length", truncation=True,
                                           max_length=self.siglip_text_length, return_tensors="pt")
            input_ids = tokens["input_ids"].to(self.device)
            with torch.amp.autocast("cuda", dtype=torch.float16, enabled=input_ids.is_cuda):
                output = self.siglip_model.get_text_features(input_ids=input_ids)
            return F.normalize(tensor_from_model_output(output).float(), dim=-1).cpu().numpy()

    def neural_input(self, rgb):
        if self.cfg.neural_clahe_clip_limit > 0:
            rgb = apply_clahe_rgb(rgb, self.cfg.neural_clahe_clip_limit, self.cfg.neural_clahe_grid)
        return Image.fromarray(rgb)

    def encode_rgb_images(self, rgb_images, tta_hflip=False):
        import torch  # PORT: lazy import

        prepared = [self.neural_input(rgb) for rgb in rgb_images]
        dino_batch = torch.stack([self.dino_transform(image) for image in prepared])
        siglip_batch = torch.stack([self.siglip_transform(image) for image in prepared])
        dino_vectors = self.encode_dino(dino_batch)
        siglip_vectors = self.encode_siglip_images(siglip_batch)
        if tta_hflip:
            dino_vectors = l2_normalize_rows(dino_vectors + self.encode_dino(torch.flip(dino_batch, dims=[3])))
            siglip_vectors = l2_normalize_rows(siglip_vectors + self.encode_siglip_images(torch.flip(siglip_batch, dims=[3])))
        return dino_vectors, siglip_vectors


def collate_feature_samples(samples):
    import torch  # PORT: lazy import

    good = [sample for sample in samples if sample["ok"]]
    batch = {
        "item_ids": [sample["item_id"] for sample in good],
        "errors": [(sample["item_id"], sample["error"]) for sample in samples if not sample["ok"]],
        "color_meta": [sample["color_meta"] for sample in good],
        "dino": None, "siglip": None, "color": None,
    }
    if good:
        batch["dino"] = torch.stack([sample["dino"] for sample in good])
        batch["siglip"] = torch.stack([sample["siglip"] for sample in good])
        batch["color"] = torch.stack([sample["color"] for sample in good])
    return batch


def _feature_worker_init(worker_id):
    import torch  # PORT: lazy import

    cv2.setNumThreads(0)
    torch.set_num_threads(1)


class LocalFeatureExtractor:
    def __init__(self, cfg, store, encoders, on_batch=None):  # PORT: on_batch(done, total) is new
        self.cfg = cfg
        self.store = store
        self.encoders = encoders
        self.on_batch = on_batch

    # PORT: new. Progress and cancellation: called before every batch (all earlier batches are committed) and once after the last.
    def _batch_hook(self, done, total):
        if self.on_batch is not None:
            self.on_batch(done, total)

    def run(self):
        from torch.utils.data import DataLoader  # PORT: lazy import

        versions = local_feature_versions(self.cfg)
        pending = self.store.items_needing_pillars(versions, self.cfg.max_feature_attempts)
        if not pending:
            LOGGER.info("Local features: nothing to do")
            return 0
        LOGGER.info("Local features: %d item(s) pending", len(pending))
        # PORT: crop_filepath is relative to work_dir (an absolute legacy value is left alone)
        pending = [(item_id, str(resolve_crop_path(self.cfg.work_dir, crop_path))) for item_id, crop_path in pending]
        dataset = _torch_classes()["CropFeatureDataset"](pending, self.encoders.dino_transform, self.encoders.siglip_transform,
                                     ColorParams.from_config(self.cfg), self.cfg.neural_clahe_clip_limit,
                                     self.cfg.neural_clahe_grid)
        use_cuda = self.hardware_has_cuda()
        if self.cfg.num_workers > 0:
            loader = DataLoader(dataset, batch_size=self.cfg.feature_batch_size, shuffle=False,
                                num_workers=self.cfg.num_workers, pin_memory=use_cuda,
                                collate_fn=collate_feature_samples, worker_init_fn=_feature_worker_init,
                                prefetch_factor=2, persistent_workers=False)
        else:
            loader = DataLoader(dataset, batch_size=self.cfg.feature_batch_size, shuffle=False, num_workers=0,
                                pin_memory=use_cuda, collate_fn=collate_feature_samples)
        completed = 0
        failed = 0  # PORT: for the progress hook
        started = time.time()
        for batch_number, batch in enumerate(loader):
            self._batch_hook(completed + failed, len(pending))  # PORT
            if batch["errors"]:
                failed += len(batch["errors"])  # PORT
                self.store.record_feature_errors(batch["errors"], LOCAL_PILLARS)
                LOGGER.warning("%d crop(s) failed to decode, e.g. %s", len(batch["errors"]), batch["errors"][0])
            if not batch["item_ids"]:
                continue
            dino_vectors = self.encoders.encode_dino(batch["dino"])
            siglip_vectors = self.encoders.encode_siglip_images(batch["siglip"])
            color_vectors = batch["color"].numpy()
            rows = []
            for position, item_id in enumerate(batch["item_ids"]):
                rows.append(EmbeddingRow(item_id, "dino", versions["dino"], dino_vectors[position]))
                rows.append(EmbeddingRow(item_id, "siglip", versions["siglip"], siglip_vectors[position]))
                rows.append(EmbeddingRow(item_id, "color", versions["color"], color_vectors[position],
                                         json.loads(batch["color_meta"][position])))
            self.store.upsert_embeddings(rows)  # checkpoint: one transaction per batch
            completed += len(batch["item_ids"])
            if batch_number % 10 == 0 or completed == len(pending):
                rate = completed / max(time.time() - started, 1e-6)
                LOGGER.info("Local features %d/%d (%.1f img/s)", completed, len(pending), rate)
        self._batch_hook(completed + failed, len(pending))  # PORT
        return completed

    def hardware_has_cuda(self):
        return self.encoders.device.type == "cuda"
