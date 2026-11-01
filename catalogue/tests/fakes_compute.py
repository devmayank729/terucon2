"""Fakes for the compute tests: nothing here talks to a real model, a real Google service, or the network.

    FakeEncoders       an EncoderBank-like object with the REAL output shapes (dino 3072, siglip 1152): deterministic vectors from the image content
    FakeManager        a VertexGenAIManager-like object: canned captions (valid MaterialProfile JSON), 768-d text vectors, 1408-d image vectors,
                       counters on every call, and hooks to make single items fail
    seed_items         items + crop files straight into a StateStore (no PDF), for tests of one stage
    service_account_info / FakeGenaiClient / FakeSession   for the tests of the Vertex manager itself
"""
from __future__ import annotations

import functools
import hashlib
import json
import types
from pathlib import Path

import numpy as np
from PIL import Image

from terucon_catalogue.config import PipelineConfig
from terucon_catalogue.extract import PageResult
from terucon_catalogue.util import atomic_write_bytes, encode_rgb, sha256_bytes


def make_cfg(work_dir=None, **overrides):
    """Small batches (so that every stage has several), no worker processes, small concurrency."""
    values = dict(num_workers=0, feature_batch_size=2, checkpoint_every=2, caption_concurrency=2, text_embedding_concurrency=2,
                  vertex_mm_concurrency=2, retry_initial_wait_s=0.01, retry_max_wait_s=0.05, rate_limit_cooldown_s=0.05, request_timeout_s=5.0)
    values.update(overrides)
    return PipelineConfig(work_dir=Path(work_dir) if work_dir is not None else Path("work"), **values)


def unit_vector(seed_text, dim):
    """A deterministic unit vector derived from `seed_text` (bytes or str)."""
    if isinstance(seed_text, str):
        seed_text = seed_text.encode("utf-8")
    seed = int.from_bytes(hashlib.sha256(seed_text).digest()[:8], "little")
    vector = np.random.default_rng(seed).standard_normal(dim).astype(np.float32)
    return vector / np.linalg.norm(vector)


# ---------------------------------------------------------------------------------------------------------------------
class _Thumbnail:
    """PIL image -> float tensor (3, size, size). A top-level class (not a lambda) so that it also pickles for DataLoader workers."""

    def __init__(self, size):
        self.size = size

    def __call__(self, image):
        import torch
        small = np.asarray(image.convert("RGB").resize((self.size, self.size), Image.BILINEAR), dtype=np.float32) / 255.0
        return torch.from_numpy(small.transpose(2, 0, 1).copy())


class FakeEncoders:
    """The interface LocalFeatureExtractor needs from an EncoderBank, with deterministic content-derived vectors of the real sizes."""

    def __init__(self, dino_dim=3072, siglip_dim=1152, size=8, seed=0):
        import torch
        self.device = torch.device("cpu")
        self.dino_transform = _Thumbnail(size)
        self.siglip_transform = _Thumbnail(size)
        rng = np.random.default_rng(seed)
        self._dino = rng.standard_normal((3 * size * size, dino_dim)).astype(np.float32)
        self._siglip = rng.standard_normal((3 * size * size, siglip_dim)).astype(np.float32)
        self.calls = {"encode_dino": 0, "encode_siglip_images": 0, "dino_images": 0, "siglip_images": 0}

    @staticmethod
    def _project(batch, matrix):
        flat = batch.reshape(batch.shape[0], -1).numpy().astype(np.float32)
        out = flat @ matrix
        return out / np.linalg.norm(out, axis=1, keepdims=True)

    def encode_dino(self, pixel_values):
        self.calls["encode_dino"] += 1
        self.calls["dino_images"] += int(pixel_values.shape[0])
        return self._project(pixel_values, self._dino)

    def encode_siglip_images(self, pixel_values):
        self.calls["encode_siglip_images"] += 1
        self.calls["siglip_images"] += int(pixel_values.shape[0])
        return self._project(pixel_values, self._siglip)

    @property
    def total_calls(self):
        return sum(self.calls.values())


# ---------------------------------------------------------------------------------------------------------------------
class FakeResponse:
    """What google-genai returns for generate_content, as far as parse_structured_response looks at it."""

    def __init__(self, text=None, parsed=None, finish_reason="STOP"):
        self.text = text
        self.parsed = parsed
        self.candidates = [types.SimpleNamespace(finish_reason=types.SimpleNamespace(name=finish_reason))]


def canned_profile(digest):
    return {"material_category": "stone", "material_subtype": f"synthetic swatch {digest[:8]}", "surface_finish": "matte",
            "secondary_finishes": ["honed"], "grain_or_pattern_description": f"pattern {digest[8:12]}", "pattern_scale": "10 mm",
            "color_palette_description": f"#{digest[:6]} base with small variation", "specular_behavior": "low sheen",
            "micro_surface_feel": "smooth", "search_keywords": [f"keyword{i}" for i in range(8)],
            "nano_banana_render_prompt": f"A matte synthetic swatch {digest[12:20]}.", "confidence": 0.9}


class FakeManager:
    """The interface of VertexGenAIManager that the stage classes use. Every call is counted; vectors/captions derive from the content.

    caption_behaviour(call_index, digest) may return None (normal), an Exception (raised), or a FakeResponse (returned instead of the normal one).
    multimodal_behaviour(call_index, digest) may return None or an Exception (raised).
    """

    def __init__(self, caption_behaviour=None, multimodal_behaviour=None, embed_behaviour=None):
        self.disabled_features = set()
        self.calls = {"multimodal_embed": 0, "caption": 0, "embed_text": 0}
        self.embedded_texts = []
        self.caption_requests = []
        self.caption_behaviour = caption_behaviour
        self.multimodal_behaviour = multimodal_behaviour
        self.embed_behaviour = embed_behaviour

    async def multimodal_embed(self, image_bytes=None, text=None):
        self.calls["multimodal_embed"] += 1
        digest = sha256_bytes(image_bytes or (text or "").encode("utf-8"))
        if self.multimodal_behaviour is not None:
            outcome = self.multimodal_behaviour(self.calls["multimodal_embed"], digest)
            if isinstance(outcome, BaseException):
                raise outcome
        result = {}
        if image_bytes is not None:
            result["image"] = unit_vector(image_bytes, 1408)
        if text:
            result["text"] = unit_vector("mm-text:" + text, 1408)
        return result

    async def generate_content_with_fallback(self, role, candidates, contents, config_factory):
        from google.genai import types as genai_types
        self.calls["caption"] += 1
        model_name = candidates[0]
        config = config_factory(model_name)      # builds the real google-genai config: the installed SDK must accept the schema and settings
        assert isinstance(config, genai_types.GenerateContentConfig) and config.response_mime_type == "application/json"
        image = contents[0].inline_data.data
        digest = sha256_bytes(image)
        self.caption_requests.append({"role": role, "candidates": list(candidates), "mime": contents[0].inline_data.mime_type, "prompt": contents[1],
                                      "digest": digest, "system_instruction": config.system_instruction, "schema": config.response_schema})
        if self.caption_behaviour is not None:
            outcome = self.caption_behaviour(self.calls["caption"], digest)
            if isinstance(outcome, BaseException):
                raise outcome
            if outcome is not None:
                return model_name, outcome
        return model_name, FakeResponse(text=json.dumps(canned_profile(digest)))

    async def embed_text(self, text, task_type):
        self.calls["embed_text"] += 1
        self.embedded_texts.append((text, task_type))
        if self.embed_behaviour is not None:
            outcome = self.embed_behaviour(self.calls["embed_text"], text)
            if isinstance(outcome, BaseException):
                raise outcome
        return unit_vector("text:" + text, 768)

    @property
    def total_calls(self):
        return sum(self.calls.values())


# ---------------------------------------------------------------------------------------------------------------------
def seed_items(store, cfg, count, product_ids=None, size=96):
    """Items + crop files straight into the store (no PDF): returns the item ids. Each crop is a different noisy colour."""
    ids = []
    cfg.ensure_dirs()
    sha = "a" * 64
    for index in range(count):
        rng = np.random.default_rng(1000 + index)
        base = rng.integers(40, 215, 3)
        rgb = np.clip(base[None, None, :] + rng.integers(-20, 21, (size, size, 3)), 0, 255).astype(np.uint8)
        encoded = encode_rgb(rgb, "png")
        item_id = f"{sha[:12]}-p{index + 1:04d}-i00"
        path = cfg.crops_dir / f"seed_{sha[:8]}" / f"{item_id}.png"
        atomic_write_bytes(path, encoded)
        product_id = product_ids[index] if product_ids else None
        item = {"item_id": item_id, "product_id": product_id, "product_id_raw": product_id, "source_pdf": "seed.pdf", "pdf_sha256": sha,
                "page_number": index + 1, "item_index": 0, "image_bbox": [0.0, 0.0, 10.0, 10.0], "id_bbox": None, "page_width": 595.0,
                "page_height": 842.0, "original_rotation": 0, "crop_filepath": path.relative_to(cfg.work_dir).as_posix(), "crop_width": size,
                "crop_height": size, "render_zoom": 1.0, "sha256_hash": sha256_bytes(encoded), "match_type": "none", "match_relation": None,
                "match_cost": None, "extraction_method": "embedded_image", "image_xrefs": [], "inpainted_overlay": False}
        store.commit_page_result(PageResult(pdf_sha256=sha, source_pdf="seed.pdf", page_number=index + 1, original_rotation=0, page_width=595.0,
                                            page_height=842.0, extraction_method="embedded_image", n_image_regions=1, n_id_candidates=0,
                                            items=[item], orphans=[], debug={}))
        ids.append(item_id)
    return ids


# ---------------------------------------------------------------------------------------------------------------------
@functools.lru_cache(maxsize=1)
def _throwaway_private_key():
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    return key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()).decode()


def service_account_info(project="test-project-123"):
    """A service-account dict with a THROWAWAY key generated now (never a real credential) and an address that is not a real account."""
    return {"type": "service_account", "project_id": project, "private_key_id": "test-key", "private_key": _throwaway_private_key(),
            "client_email": f"fake@{project}.iam.gserviceaccount.com", "client_id": "1", "token_uri": "https://oauth2.googleapis.com/token"}


# ---------------------------------------------------------------------------------------------------------------------
# tiny RANDOM-weight models for the encoder tests (built from configs; no download, no Hugging Face)
# ---------------------------------------------------------------------------------------------------------------------
TINY_WORDS = ["a", "close-up", "photo", "of", "material", "texture", "brushed", "brass", "polished", "stone", "matte", "woven", "fabric", "oak",
              "veneer", "marble", "black", "red", "blue", "green", "grey", "linen", "leather", "tile"]


def tiny_tokenizer():
    """A real fast tokenizer (word-level, split on spaces) with a [PAD]; padding='max_length' behaves exactly as for SigLIP's."""
    from tokenizers import Tokenizer, models, pre_tokenizers
    from transformers import PreTrainedTokenizerFast
    vocab = {"[PAD]": 0, "[UNK]": 1}
    for word in TINY_WORDS:
        vocab[word] = len(vocab)
    tokenizer = Tokenizer(models.WordLevel(vocab=vocab, unk_token="[UNK]"))
    tokenizer.pre_tokenizer = pre_tokenizers.WhitespaceSplit()
    return PreTrainedTokenizerFast(tokenizer_object=tokenizer, pad_token="[PAD]", unk_token="[UNK]")


def tiny_models(seed=0, text_length=16):
    """(dino_backbone, siglip_model, tokenizer, preprocessing) with hidden size 32, 2 layers: DINO input 56 px (4x4 patches), SigLIP image 28 px."""
    import torch
    from transformers import Dinov2Config, Dinov2Model, SiglipConfig, SiglipModel
    torch.manual_seed(seed)
    dino = Dinov2Model(Dinov2Config(hidden_size=32, num_hidden_layers=2, num_attention_heads=2, intermediate_size=64, image_size=56, patch_size=14))
    siglip = SiglipModel(SiglipConfig(
        text_config=dict(vocab_size=64, hidden_size=32, intermediate_size=64, num_hidden_layers=2, num_attention_heads=2,
                         max_position_embeddings=text_length, bos_token_id=1, eos_token_id=2, pad_token_id=0),
        vision_config=dict(hidden_size=32, intermediate_size=64, num_hidden_layers=2, num_attention_heads=2, image_size=28, patch_size=14)))
    preprocessing = {"dino_mean": (0.485, 0.456, 0.406), "dino_std": (0.229, 0.224, 0.225), "siglip_mean": (0.5, 0.5, 0.5),
                     "siglip_std": (0.5, 0.5, 0.5), "siglip_height": 28, "siglip_width": 28}
    return dino, siglip, tiny_tokenizer(), preprocessing


def tiny_cfg(work_dir=None, **overrides):
    """The settings that go with tiny_models(): DINO resizes to 64 and crops 56 (a multiple of 14), on the CPU."""
    values = dict(device="cpu", dino_input_size=56, dino_resize_short_side=64)
    values.update(overrides)
    return make_cfg(work_dir, **values)


class RecordingTokenizer:
    """Delegates to a real tokenizer and remembers how it was called."""

    def __init__(self, inner):
        self.inner = inner
        self.calls = []

    def __call__(self, *args, **kwargs):
        self.calls.append((args, kwargs))
        return self.inner(*args, **kwargs)
