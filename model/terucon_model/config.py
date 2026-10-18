"""Settings of the model service, read from the project's .env (and the real environment, which wins).

The website (Express) reads the same file with its own parser; tests/fixtures/env-cases.json is the shared
fixture that keeps the two from drifting. Variable names match .env.example, so credentials are pasted once:
GCP_SERVICE_ACCOUNT_JSON, GOOGLE_APPLICATION_CREDENTIALS, GOOGLE_CLOUD_PROJECT, GOOGLE_CLOUD_LOCATION,
GEMINI_API_KEY, GOOGLE_GENAI_USE_VERTEXAI. What is specific to this service is MODEL_HOST, MODEL_PORT,
MODEL_SERVICE_KEY and MODEL_PARENT_PID, and TERUCON_ENV_FILE says which file to read.

Nothing in here ever logs or returns a secret.
"""
from __future__ import annotations

import base64
import json
import os
import re
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .envfile import load_env_file, merged_environment

MODEL_DIR = Path(__file__).resolve().parent.parent  # .../model
ROOT = MODEL_DIR.parent  # the project root: where .env lives and what relative paths in it are relative to

# Model names the Design Studio ships with. Each can be overridden in .env; when one is left
# blank the studio's own default (or the choice saved in its Settings dialog) applies.
DEFAULT_MODELS = {
    "image": "gemini-nano-banana-2.1",
    "detect": "gemini-3.8-flash",
    "mask": "gemini-2.5-flash",
    "insight": "gemini-3.8-flash",
}
MODEL_ENV = {
    "image": "SWATCHROOM_IMAGE_MODEL",
    "detect": "SWATCHROOM_DETECT_MODEL",
    "mask": "SWATCHROOM_MASK_MODEL",
    "insight": "SWATCHROOM_INSIGHT_MODEL",
}

_GOOGLE_HOST = re.compile(r"^https://([a-z0-9-]+\.)*googleapis\.com(:\d+)?(/|$)")
_PROJECT_ID = re.compile(r"^[a-z][a-z0-9\-]{4,28}[a-z0-9]$")
_LOCATION = re.compile(r"^[a-z0-9\-]{2,40}$")
_TRUE = {"1", "true", "yes", "on", "y"}
_FALSE = {"0", "false", "no", "off", "n"}


def _flag(value: str | None, default: bool | None) -> bool | None:
    if value is None or value.strip() == "":
        return default
    v = value.strip().lower()
    if v in _TRUE:
        return True
    if v in _FALSE:
        return False
    return default


def _int(value: str | None, default: int, lo: int, hi: int) -> int:
    try:
        return max(lo, min(hi, int(float(str(value).strip()))))
    except (TypeError, ValueError):
        return default


@dataclass
class GoogleConfig:
    mode: str = "none"  # "vertex" (service account / ADC) | "api-key" (AI Studio) | "none"
    project_id: str = ""
    location: str = "global"
    service_account: dict[str, Any] | None = None
    service_account_source: str = ""
    adc: bool = False  # Application Default Credentials (GCE / Cloud Run / gcloud login)
    api_key: str = ""
    error: str = ""

    @property
    def configured(self) -> bool:
        return self.mode != "none" and not self.error

    @property
    def client_email(self) -> str:
        return (self.service_account or {}).get("client_email", "")


@dataclass
class SamConfig:
    enabled: bool = False
    backend: str = "auto"  # auto | sam2 | sam | sam3 | remote
    model_id: str = "facebook/sam2.1-hiera-small"
    device: str = "auto"  # auto | cpu | cuda | mps
    hf_token: str = ""
    checkpoint: str = ""
    repo_dir: str = ""
    remote_url: str = ""
    remote_key: str = ""
    remote_auth_header: str = "bearer"
    server_key: str = ""  # when set, /sam/* also accepts it (x-api-key or Bearer), so SAM_REMOTE_URL can point at this service on a GPU box
    max_side: int = 1024
    preload: bool = False


@dataclass
class Settings:
    env_path: Path
    model_host: str = "127.0.0.1"  # where this service listens (MODEL_HOST)
    model_port: int = 8081  # MODEL_PORT; 0 = any free port (the website always starts it that way)
    service_key: str = ""  # MODEL_SERVICE_KEY: when set, every request must carry it in X-Terucon-Model-Key
    parent_pid: int = 0  # MODEL_PARENT_PID: exit when this process is gone; 0 = not supervised
    allowed_hosts: tuple[str, ...] = ()
    google: GoogleConfig = field(default_factory=GoogleConfig)
    models: dict[str, str] = field(default_factory=dict)  # only the ones set explicitly
    segmentation_engine: str = "auto"
    edge_refine: bool = True
    edge_method: str = "contour"  # contour | watershed (the method contour snapping replaced, kept as a fallback)
    analysis_max_side: int = 1536
    sam: SamConfig = field(default_factory=SamConfig)
    allow_custom_google_endpoints: bool = False
    vertex_api_base: str = ""  # tests only: point Vertex calls at a local mock
    warnings: list[str] = field(default_factory=list)
    env_file_found: bool = False

    def describe(self) -> list[str]:
        """Human-readable startup lines. Contains no secrets."""
        g = self.google
        lines = []
        if g.mode == "vertex":
            who = g.client_email or ("application default credentials" if g.adc else "service account")
            lines.append(f"Google: Vertex AI as {who}  (project {g.project_id or '?'}, location {g.location})")
        elif g.mode == "api-key":
            lines.append("Google: Gemini API key (AI Studio)")
        else:
            lines.append("Google: not configured - fill in .env (see .env.example)" if not g.error else f"Google: {g.error}")
        s = self.sam
        if s.enabled:
            lines.append(f"SAM: enabled, backend={s.backend}, model={s.model_id if s.backend != 'remote' else s.remote_url}")
        else:
            lines.append("SAM: off (optional; set SAM_ENABLED=true to use it)")
        lines.append(f"Segmentation: engine={self.segmentation_engine}, edge refinement={('on, ' + self.edge_method) if self.edge_refine else 'off'}")
        return lines


# ---- parsing -------------------------------------------------------------------


def _decode_json_blob(text: str) -> dict[str, Any] | None:
    """Accept raw JSON, JSON wrapped in stray quotes, or base64 of the JSON file."""
    t = text.strip()
    if len(t) >= 2 and t[0] == t[-1] and t[0] in ("'", '"'):
        t = t[1:-1].strip()
    if not t:
        return None
    for candidate in (t, _maybe_b64(t)):
        if not candidate:
            continue
        try:
            data = json.loads(candidate, strict=False)  # strict=False tolerates raw newlines in the key
        except (ValueError, TypeError):
            continue
        if isinstance(data, dict):
            return data
    return None


def _maybe_b64(text: str) -> str:
    if text.startswith("{") or len(text) < 40 or re.search(r"[^A-Za-z0-9+/=_\-\s]", text):
        return ""
    try:
        return base64.b64decode(text + "=" * (-len(text) % 4)).decode("utf-8")
    except Exception:  # noqa: BLE001 - any decode failure just means "not base64"
        return ""


def _check_service_account(info: dict[str, Any], allow_custom: bool) -> str:
    if info.get("type") != "service_account":
        return 'the JSON is not a service-account key (its "type" must be "service_account")'
    missing = [k for k in ("client_email", "private_key") if not info.get(k)]
    if missing:
        return "the service-account key is missing: " + ", ".join(missing)
    if "BEGIN PRIVATE KEY" not in str(info["private_key"]):
        return "private_key is not a PKCS#8 PEM key; create a new JSON key for the service account"
    token_uri = info.get("token_uri")
    if token_uri and not allow_custom and not _GOOGLE_HOST.match(str(token_uri)):
        return "token_uri in the key does not point at googleapis.com, so it was refused"
    return ""


def resolve_env_path(env_path: str | Path | None = None, environ: dict[str, str] | None = None) -> Path:
    """Which file to read: an explicit argument, else TERUCON_ENV_FILE (relative paths are relative to the project
    root), else ROOT/.env. TERUCON_ENV_FILE comes from `environ` when one is given (tests), else the real environment;
    it cannot come from the file it names."""
    if env_path:
        return Path(env_path)
    value = ((environ if environ is not None else os.environ).get("TERUCON_ENV_FILE") or "").strip()
    if value:
        p = Path(os.path.expanduser(value))
        return p if p.is_absolute() else ROOT / p
    return ROOT / ".env"


# Where a key file is looked for when no variable names one: the project folder, then Render's secret-file folder.
_DEFAULT_KEY_FILES = ("service-account.json", "credentials/service-account.json", "/etc/secrets/service-account.json")


def _default_key_file() -> str:
    for name in _DEFAULT_KEY_FILES:
        candidate = ROOT / name
        if candidate.is_file():
            return str(candidate)
    return ""


def load_settings(env_path: str | Path | None = None, environ: dict[str, str] | None = None) -> Settings:
    path = resolve_env_path(env_path, environ)
    # `environ` (tests) replaces the process environment but the file is still read.
    env = {**load_env_file(path), **environ} if environ is not None else merged_environment(path)
    s = Settings(env_path=path, env_file_found=path.exists())
    w = s.warnings
    get = lambda k, d="": (env.get(k) if env.get(k) is not None else d).strip()  # noqa: E731

    # --- this service
    s.model_host = get("MODEL_HOST", "127.0.0.1") or "127.0.0.1"
    s.model_port = _int(get("MODEL_PORT"), 8081, 0, 65535)
    s.service_key = get("MODEL_SERVICE_KEY")
    s.parent_pid = _int(get("MODEL_PARENT_PID"), 0, 0, 2**31 - 1)
    extra = tuple(h.strip().lower() for h in get("ALLOWED_HOSTS").split(",") if h.strip())
    s.allowed_hosts = extra
    s.allow_custom_google_endpoints = _flag(get("TERUCON_ALLOW_CUSTOM_GOOGLE_ENDPOINTS"), False) or False
    s.vertex_api_base = get("TERUCON_VERTEX_API_BASE").rstrip("/") if s.allow_custom_google_endpoints else ""

    # --- Google credentials
    g = s.google
    project_env = get("GOOGLE_CLOUD_PROJECT")
    location = get("GOOGLE_CLOUD_LOCATION", "global") or "global"
    if _LOCATION.match(location):
        g.location = location
    else:
        w.append(f"GOOGLE_CLOUD_LOCATION is not a valid location name; using 'global'.")

    sa_text = get("GCP_SERVICE_ACCOUNT_JSON") or get("GOOGLE_SERVICE_ACCOUNT_JSON")
    sa_source = "GCP_SERVICE_ACCOUNT_JSON" if sa_text else ""
    info: dict[str, Any] | None = None
    if sa_text:
        info = _decode_json_blob(sa_text)
        if info is None:
            g.error = "GCP_SERVICE_ACCOUNT_JSON is set but is not valid JSON. Paste the whole key file on ONE line inside single quotes."
    if info is None and not g.error:
        file_path = get("GOOGLE_APPLICATION_CREDENTIALS") or get("GCP_SERVICE_ACCOUNT_FILE") or _default_key_file()
        if file_path:
            fp = Path(os.path.expanduser(file_path))
            if not fp.is_absolute():
                fp = ROOT / fp
            try:
                info = _decode_json_blob(fp.read_text(encoding="utf-8"))
                sa_source = f"file {fp.name}"
                if info is None:
                    g.error = f"{fp.name} is not valid JSON."
            except OSError:
                g.error = f"The credentials file {fp} could not be read."
    if info is None and not g.error and project_env and (project_env.lstrip().startswith("{") or "PRIVATE KEY" in project_env):
        # A known mix-up: the whole key pasted into GOOGLE_CLOUD_PROJECT. Use it, but say so.
        info = _decode_json_blob(project_env)
        if info is not None:
            sa_source = "GOOGLE_CLOUD_PROJECT (misplaced)"
            w.append("A service-account key was found in GOOGLE_CLOUD_PROJECT. It works, but please move it to "
                     "GCP_SERVICE_ACCOUNT_JSON and put only the project id (for example my-project-123) in GOOGLE_CLOUD_PROJECT. "
                     "Consider rotating the key, since it sat in a general-purpose variable.")
            project_env = ""
    if info is not None and not g.error:
        problem = _check_service_account(info, s.allow_custom_google_endpoints)
        if problem:
            g.error = problem
            info = None
    if info is not None:
        g.service_account = info
        g.service_account_source = sa_source

    if project_env and not _PROJECT_ID.match(project_env):
        w.append("GOOGLE_CLOUD_PROJECT does not look like a project id (6-30 lowercase letters, digits, hyphens); ignoring it.")
        project_env = ""
    g.project_id = project_env or (info or {}).get("project_id", "") or get("GCLOUD_PROJECT") or get("GCP_PROJECT")

    api_key = get("GEMINI_API_KEY") or get("GOOGLE_API_KEY")
    g.api_key = api_key
    use_vertex = _flag(get("GOOGLE_GENAI_USE_VERTEXAI"), None)

    if not g.error:
        if use_vertex is False:
            g.mode = "api-key" if api_key else "none"
            if not api_key:
                g.error = "GOOGLE_GENAI_USE_VERTEXAI=false needs GEMINI_API_KEY to be set."
        elif g.service_account is not None:
            g.mode = "vertex"
        elif use_vertex is True and _adc_available():
            g.mode, g.adc = "vertex", True
        elif api_key:
            g.mode = "api-key"
            if use_vertex is True:
                w.append("GOOGLE_GENAI_USE_VERTEXAI=true but no service account was found; using GEMINI_API_KEY instead.")
        elif use_vertex is True:
            g.error = "Vertex AI needs a service account: set GCP_SERVICE_ACCOUNT_JSON (or GOOGLE_APPLICATION_CREDENTIALS)."
    if g.mode == "vertex" and not g.project_id:
        g.error = "Could not work out the Google Cloud project id. Set GOOGLE_CLOUD_PROJECT (for example my-project-123)."
        g.mode = "none"

    # --- model overrides (only when explicitly set)
    for role, var in MODEL_ENV.items():
        value = get(var)
        if value and re.fullmatch(r"[A-Za-z0-9._\-]{3,80}", value):
            s.models[role] = value
        elif value:
            w.append(f"{var} has an invalid model name and was ignored.")

    # --- segmentation
    engine = get("SEGMENTATION_ENGINE", "auto").lower() or "auto"
    if engine not in {"auto", "terucon", "sam", "scene", "gemini"}:
        w.append(f"SEGMENTATION_ENGINE={engine!r} is not one of auto, terucon, sam, scene, gemini; using auto.")
        engine = "auto"
    s.segmentation_engine = engine
    s.edge_refine = _flag(get("EDGE_REFINE"), True) is not False
    method = get("EDGE_METHOD", "contour").lower() or "contour"
    if method not in {"contour", "watershed"}:
        w.append(f"EDGE_METHOD={method!r} is not one of contour, watershed; using contour.")
        method = "contour"
    s.edge_method = method
    s.analysis_max_side = _int(get("ANALYSIS_MAX_SIDE"), 1536, 512, 3072)

    # --- SAM (optional)
    m = s.sam
    m.enabled = bool(_flag(get("SAM_ENABLED"), False))
    backend = get("SAM_BACKEND", "auto").lower() or "auto"
    if backend not in {"auto", "sam2", "sam", "sam3", "remote"}:
        w.append(f"SAM_BACKEND={backend!r} is not one of auto, sam2, sam, sam3, remote; using auto.")
        backend = "auto"
    m.backend = backend
    m.model_id = get("SAM_MODEL_ID", "facebook/sam2.1-hiera-small") or "facebook/sam2.1-hiera-small"
    m.device = (get("SAM_DEVICE", "auto") or "auto").lower()
    m.hf_token = get("HF_TOKEN") or get("HUGGING_FACE_HUB_TOKEN")
    m.checkpoint = get("SAM_CHECKPOINT")
    m.repo_dir = get("SAM_REPO_DIR")
    m.remote_url = get("SAM_REMOTE_URL").rstrip("/")
    m.remote_key = get("SAM_REMOTE_KEY")
    m.remote_auth_header = "x-api-key" if get("SAM_REMOTE_AUTH_HEADER").lower() in {"x-api-key", "x_api_key"} else "bearer"
    m.server_key = get("SAM_SERVER_KEY")
    m.max_side = _int(get("SAM_MAX_SIDE"), 1024, 256, 2048)
    m.preload = bool(_flag(get("SAM_PRELOAD"), True))
    if m.remote_url and backend == "auto":
        m.backend = "remote"
    if m.enabled and m.backend == "remote" and not m.remote_url:
        w.append("SAM_BACKEND=remote needs SAM_REMOTE_URL.")
        m.enabled = False
    return s


def _adc_available() -> bool:
    try:
        import google.auth  # noqa: WPS433

        google.auth.default()
        return True
    except Exception:  # noqa: BLE001 - no ADC on this machine
        return False


class SettingsManager:
    """Re-reads .env when the file changes, so pasting a key and reloading the page is enough."""

    def __init__(self, env_path: str | Path | None = None, environ: dict[str, str] | None = None):
        self._path = resolve_env_path(env_path, environ)
        self._environ = environ
        self._lock = threading.Lock()
        self._stamp: tuple[float, int] | None = None
        self._settings = load_settings(self._path, environ)
        self._stamp = self._stat()
        self.version = 1

    def _stat(self) -> tuple[float, int] | None:
        try:
            st = self._path.stat()
            return (st.st_mtime, st.st_size)
        except OSError:
            return None

    def get(self) -> Settings:
        with self._lock:
            stamp = self._stat()
            if stamp != self._stamp:
                self._settings = load_settings(self._path, self._environ)
                self._stamp = stamp
                self.version += 1
            return self._settings
