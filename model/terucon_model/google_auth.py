"""OAuth access tokens for a service account (or Application Default Credentials).

The private key never leaves this process. We sign the JWT with google-auth's RSA signer, post it
to Google's token endpoint with `requests`, and cache the token until shortly before it expires.
"""
from __future__ import annotations

import threading
import time
from datetime import timezone
from typing import Any

import requests

from .config import GoogleConfig

SCOPE = "https://www.googleapis.com/auth/cloud-platform"
DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token"
_REFRESH_MARGIN = 120  # seconds before expiry at which we fetch a new token


class GoogleAuthError(Exception):
    def __init__(self, message: str, status: int = 401):
        super().__init__(message)
        self.status = status


def _explain(error: str, description: str, http_status: int) -> str:
    """Turn Google's OAuth error into advice a person can act on."""
    d = description or ""
    if "Invalid JWT Signature" in d:
        return "Google rejected the key signature. This key was probably deleted or disabled; create a new JSON key for the service account."
    if "reasonable timeframe" in d or "iat" in d:
        return "Google rejected the token time. This computer's clock is off; turn on automatic date and time, then restart."
    if error == "invalid_grant":
        return f"Google rejected this service account ({d or 'invalid_grant'}). Check that the account still exists and is enabled."
    if error == "invalid_scope":
        return "Google rejected the requested permission scope for this service account."
    return f"Token request failed: {error or 'http_' + str(http_status)}" + (f" ({d})" if d else "") + "."


class GoogleAuth:
    """Thread-safe token source. Build one per configuration; it is cheap."""

    def __init__(self, cfg: GoogleConfig, timeout: float = 20.0):
        self.cfg = cfg
        self.timeout = timeout
        self._lock = threading.Lock()
        self._token = ""
        self._expires_at = 0.0
        self._adc_creds: Any = None
        self._signer: Any = None

    # ---- public ------------------------------------------------------------
    @property
    def needs_token(self) -> bool:
        return self.cfg.mode == "vertex"

    def token(self) -> str:
        if self.cfg.mode != "vertex":
            raise GoogleAuthError("This server is not set up for Vertex AI.", 500)
        now = time.time()
        if self._token and now < self._expires_at - _REFRESH_MARGIN:
            return self._token
        with self._lock:
            now = time.time()
            if self._token and now < self._expires_at - _REFRESH_MARGIN:
                return self._token
            if self.cfg.service_account is not None:
                self._token, self._expires_at = self._fetch_with_key(self.cfg.service_account)
            else:
                self._token, self._expires_at = self._fetch_with_adc()
            return self._token

    def invalidate(self) -> None:
        with self._lock:
            self._token, self._expires_at = "", 0.0

    # ---- service-account key -> token --------------------------------------
    def _fetch_with_key(self, info: dict[str, Any]) -> tuple[str, float]:
        try:
            from google.auth import crypt, jwt
        except ImportError as exc:  # pragma: no cover - requirements.txt installs it
            raise GoogleAuthError("The google-auth package is not installed. Run: pip install -r requirements.txt", 500) from exc
        try:
            if self._signer is None:
                self._signer = crypt.RSASigner.from_service_account_info(info)
        except Exception as exc:  # noqa: BLE001
            raise GoogleAuthError("The private key in the service-account JSON could not be read. Create a new JSON key.", 500) from exc
        token_uri = info.get("token_uri") or DEFAULT_TOKEN_URI
        now = int(time.time())
        payload = {"iss": info["client_email"], "scope": SCOPE, "aud": token_uri, "iat": now, "exp": now + 3600}
        assertion = jwt.encode(self._signer, payload, key_id=info.get("private_key_id") or None)
        if isinstance(assertion, bytes):
            assertion = assertion.decode("ascii")
        try:
            r = requests.post(
                token_uri,
                data={"grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer", "assertion": assertion},
                timeout=(10, self.timeout),
            )
        except requests.RequestException as exc:
            raise GoogleAuthError("Could not reach Google to sign in. Check this computer's internet connection.", 503) from exc
        try:
            data = r.json()
        except ValueError:
            data = {}
        if r.status_code != 200 or not data.get("access_token"):
            raise GoogleAuthError(_explain(str(data.get("error", "")), str(data.get("error_description", "")), r.status_code), 401)
        return data["access_token"], time.time() + float(data.get("expires_in", 3600))

    # ---- Application Default Credentials -----------------------------------
    def _fetch_with_adc(self) -> tuple[str, float]:
        try:
            import google.auth
            import google.auth.transport.requests as gtr
        except ImportError as exc:  # pragma: no cover
            raise GoogleAuthError("The google-auth package is not installed. Run: pip install -r requirements.txt", 500) from exc
        try:
            if self._adc_creds is None:
                self._adc_creds, _ = google.auth.default(scopes=[SCOPE])
            self._adc_creds.refresh(gtr.Request())
        except Exception as exc:  # noqa: BLE001
            raise GoogleAuthError(f"Application default credentials failed: {exc}", 401) from exc
        expiry = getattr(self._adc_creds, "expiry", None)  # google-auth gives a naive datetime in UTC
        expires_at = expiry.replace(tzinfo=timezone.utc).timestamp() if expiry is not None else time.time() + 3000
        return self._adc_creds.token, expires_at
