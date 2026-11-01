"""Gemini structured material profiles for every crop, and the text vectors of the descriptions.

# Ported from terucon-cat-1.ipynb (cell 5). Definitions are copied verbatim except where marked "PORT:".
The prompts, the schema (schema.py) and the text that is embedded (schema.compose_search_document) are part of the caption version:
editing a word changes it. No import-time side effects: google.genai is imported when a request is built.
"""
from __future__ import annotations

import asyncio
import contextlib
from dataclasses import dataclass
from typing import Optional

from .config import compute_caption_version, compute_feature_versions, local_feature_versions
from .features import resolve_crop_path
from .schema import (CAPTION_SYSTEM_PROMPT, CAPTION_USER_TEMPLATE, MaterialProfile, compose_search_document,
                     format_dominant_colors)
from .state import EmbeddingRow
from .util import LOGGER, chunked, encode_rgb, load_rgb, resize_max_side
from .vertex import EmptyModelResponse


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
    def __init__(self, cfg, store, manager, runner, on_checkpoint=None, on_batch=None):  # PORT: on_batch(done, total) is new
        self.cfg = cfg
        self.store = store
        self.manager = manager
        self.runner = runner
        self.on_checkpoint = on_checkpoint
        self.on_batch = on_batch
        self.caption_version = compute_caption_version(cfg)

    # PORT: new. Progress and cancellation: called before every batch (all earlier batches are saved) and once after the last.
    def _batch_hook(self, done, total):
        if self.on_batch is not None:
            self.on_batch(done, total)

    def _caption_config(self, model_name):
        from google.genai import types as genai_types  # PORT: lazy import

        thinking_config = None
        if model_name.startswith("gemini-2.5") and self.cfg.caption_thinking_budget is not None:
            thinking_config = genai_types.ThinkingConfig(thinking_budget=self.cfg.caption_thinking_budget)
        return genai_types.GenerateContentConfig(
            system_instruction=CAPTION_SYSTEM_PROMPT,
            response_mime_type="application/json",
            response_schema=MaterialProfile,
            temperature=self.cfg.caption_temperature,
            max_output_tokens=self.cfg.caption_max_output_tokens,
            thinking_config=thinking_config,
        )

    async def describe_image(self, image_bytes, product_id, color_meta):
        from google.genai import types as genai_types  # PORT: lazy import

        user_prompt = CAPTION_USER_TEMPLATE.format(product_id=product_id or "unknown",
                                                   colors=format_dominant_colors(color_meta))
        contents = [genai_types.Part.from_bytes(data=image_bytes, mime_type="image/jpeg"), user_prompt]
        model_name, response = await self.manager.generate_content_with_fallback(
            "caption", self.cfg.caption_model_candidates, contents, self._caption_config)
        return parse_structured_response(response, MaterialProfile), model_name

    async def _caption_one(self, record, color_meta, semaphore):
        async with semaphore:
            item_id = record["item_id"]
            try:
                image_bytes = await asyncio.to_thread(
                    lambda: encode_rgb(resize_max_side(load_rgb(record["crop_filepath"]),
                                                       self.cfg.caption_image_max_side_px), "jpeg", 92))
                profile, model_name = await self.describe_image(image_bytes, record["product_id"], color_meta)
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
        # PORT: crop_filepath is relative to work_dir (an absolute legacy value is left alone); the rows become plain dicts
        pending = [dict(row, crop_filepath=str(resolve_crop_path(self.cfg.work_dir, row["crop_filepath"]))) for row in pending]
        succeeded = 0
        failed = 0
        for batch in chunked(pending, self.cfg.checkpoint_every):
            self._batch_hook(succeeded + failed, len(pending))  # PORT
            results = self.runner.run(self._caption_batch(batch, color_meta_by_item))
            self.store.save_captions(results)  # checkpoint
            for result in results:
                if result.status == "ok":
                    succeeded += 1
                else:
                    failed += 1
                    LOGGER.warning("Caption failed for %s: %s", result.item_id, (result.error or "")[:200])
            if self.on_checkpoint is not None:
                self.on_checkpoint()
            LOGGER.info("Gemini captions: %d ok, %d failed, %d/%d processed", succeeded, failed,
                        succeeded + failed, len(pending))
        self._batch_hook(succeeded + failed, len(pending))  # PORT
        return succeeded


class DescriptionEmbeddingIndexer:
    def __init__(self, cfg, store, manager, runner, on_batch=None):  # PORT: on_batch(done, total) is new
        self.cfg = cfg
        self.store = store
        self.manager = manager
        self.runner = runner
        self.on_batch = on_batch

    # PORT: new. Progress and cancellation: called before every batch (all earlier batches are committed) and once after the last.
    def _batch_hook(self, done, total):
        if self.on_batch is not None:
            self.on_batch(done, total)

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
        attempted = 0  # PORT: for the progress hook
        for batch in chunked(pending, self.cfg.checkpoint_every):
            self._batch_hook(attempted, len(pending))  # PORT
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
            attempted += len(batch)  # PORT
            LOGGER.info("Description embeddings %d/%d", completed, len(pending))
        self._batch_hook(attempted, len(pending))  # PORT
        return completed
