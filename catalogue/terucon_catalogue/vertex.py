"""Vertex AI access: the service-account clients, retry/back-off with a shared cool-down, model fallback, the multimodal-embedding REST call, and the
Vertex multimodal image-embedding stage.

# Ported from terucon-cat-1.ipynb (cell 2 (error policy, VertexGenAIManager) and cell 4 (VertexMultimodalImageEmbedder)). Definitions are copied verbatim except where marked "PORT:".
No import-time side effects: google.genai, google.auth, requests and tenacity are imported when a manager is built or a call is made.
"""
from __future__ import annotations

import asyncio
import base64
import contextlib
import os
import threading
import time

import numpy as np

from .config import vertex_mm_version
from .credentials import load_service_account_info
from .features import resolve_crop_path
from .state import EmbeddingRow
from .util import LOGGER, chunked, encode_rgb, l2_normalize_rows, load_rgb, resize_max_side


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


class EmptyModelResponse(Exception):
    def __init__(self, message, retryable=True):
        super().__init__(message)
        self.retryable = retryable


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


def is_retryable_error(exc):
    import requests  # PORT: imported here, not at import time (google-auth pulls it in anyway when a manager exists)

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


def is_model_unavailable_error(exc):
    code = error_status_code(exc)
    text = str(exc).lower()
    if code == 404:
        return True
    if code in (400, 403) and any(marker in text for marker in MODEL_UNAVAILABLE_MARKERS):
        return True
    return False


class VertexGenAIManager:
    """Service-account auth + google-genai clients + retry/backoff + model fallback."""

    SCOPES = ("https://www.googleapis.com/auth/cloud-platform",)

    # PORT: the key comes from credentials.load_service_account_info() (environment) instead of a Kaggle secret; the dict can be passed in.
    def __init__(self, cfg, service_account_info=None):
        from google import genai  # PORT: heavy libraries are imported when a manager is built, not at import time
        from google.oauth2 import service_account
        from google.genai import types as genai_types

        self.cfg = cfg
        if service_account_info is None:
            service_account_info = load_service_account_info()  # PORT: from the environment, not a Kaggle secret
        account_info = service_account_info  # PORT: (cfg.service_account_secret and self.secret_name no longer exist; nothing read them)
        self.project_id = account_info["project_id"]
        self.client_email = account_info.get("client_email", "<unknown>")
        self.credentials = service_account.Credentials.from_service_account_info(
            account_info, scopes=list(self.SCOPES))
        os.environ["GOOGLE_CLOUD_PROJECT"] = self.project_id

        http_options = genai_types.HttpOptions(timeout=int(cfg.request_timeout_s * 1000))
        # vertexai=True works on every google-genai release; enterprise=True is the 2.20+ spelling.
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
        LOGGER.info("Vertex AI auth OK | project=%s | service account=%s", self.project_id, self.client_email)

    # ---------------------------------------------------------------- plumbing
    def _authorized_session(self):
        from google.auth.transport.requests import AuthorizedSession  # PORT: lazy import

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
        from tenacity import AsyncRetrying, retry_if_exception, stop_after_attempt, wait_exponential_jitter  # PORT: lazy import

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
        from google.genai import types as genai_types  # PORT: lazy import

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


class VertexMultimodalImageEmbedder:
    """Optional 4th image pillar: Vertex multimodalembedding@001 (shares a space with its text embeddings)."""

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
        # PORT: crop_filepath is relative to work_dir (an absolute legacy value is left alone)
        pending = [(item_id, str(resolve_crop_path(self.cfg.work_dir, crop_path))) for item_id, crop_path in pending]
        completed = 0
        attempted = 0  # PORT: for the progress hook
        for batch in chunked(pending, self.cfg.checkpoint_every):
            self._batch_hook(attempted, len(pending))  # PORT
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
            attempted += len(batch)  # PORT
            LOGGER.info("Vertex multimodal %d/%d", completed, len(pending))
            if unavailable == len(batch):
                LOGGER.warning("multimodalembedding unavailable for this project; disabling the pillar this session.")
                self.manager.disabled_features.add("vertex_mm")
                break
        self._batch_hook(attempted, len(pending))  # PORT
        return completed

    async def _embed_batch(self, batch):
        semaphore = asyncio.Semaphore(self.cfg.vertex_mm_concurrency)

        async def embed_one(item_id, crop_path):
            async with semaphore:
                try:
                    image_bytes = await asyncio.to_thread(
                        lambda: encode_rgb(resize_max_side(load_rgb(crop_path), 1024), "jpeg", 92))
                    result = await self.manager.multimodal_embed(image_bytes=image_bytes)
                    return item_id, result["image"], None
                except Exception as exc:
                    return item_id, None, exc

        tasks = [embed_one(item_id, crop_path) for item_id, crop_path in batch]
        return await asyncio.gather(*tasks)
