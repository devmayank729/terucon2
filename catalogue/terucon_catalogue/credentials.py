"""Where the service-account key and the other secrets come from: the environment, never a file in the repo.

Ported from terucon-cat-1.ipynb (cell 1). parse_service_account_json is verbatim; it accepts the JSON as pasted (also with surrounding
quotes, double-encoded, or base64). PORT: the notebook read the key from a Kaggle secret; here it comes from an environment variable
(a Modal secret provides one) or from the path in GOOGLE_APPLICATION_CREDENTIALS. The key is never printed or logged.
"""
from __future__ import annotations

import base64
import json
import os
from pathlib import Path
from typing import Mapping, Optional

SA_ENV = "GCP_SERVICE_ACCOUNT_JSON"
SA_FILE_ENV = "GOOGLE_APPLICATION_CREDENTIALS"


class SecretUnavailableError(RuntimeError):
    pass


def parse_service_account_json(raw_text, secret_name):
    """Accept the JSON as pasted (also tolerates surrounding quotes, double-encoding or base64)."""
    text = (raw_text or "").strip()
    if not text:
        raise SecretUnavailableError(f"Kaggle secret '{secret_name}' is empty.")
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
                f"Kaggle secret '{secret_name}' is not valid service-account JSON. Paste the whole downloaded "
                "key file contents, starting with '{' and ending with '}'.") from exc
    if not isinstance(info, dict) or info.get("type") != "service_account":
        raise SecretUnavailableError(f"Kaggle secret '{secret_name}' is JSON but not a service-account key "
                                     "(expected \"type\": \"service_account\").")
    missing = [key for key in ("project_id", "private_key", "client_email", "token_uri") if not info.get(key)]
    if missing:
        raise SecretUnavailableError(f"Kaggle secret '{secret_name}' is missing fields: {missing}")
    if "\\n" in info["private_key"]:
        info["private_key"] = info["private_key"].replace("\\n", "\n")  # key pasted with escaped newlines
    if "BEGIN PRIVATE KEY" not in info["private_key"]:
        raise SecretUnavailableError(f"Kaggle secret '{secret_name}': private_key is not a PEM key.")
    return info


def load_service_account_info(environ: Optional[Mapping[str, str]] = None, secret_name: str = SA_ENV) -> dict:
    """The service-account key as a dict. GCP_SERVICE_ACCOUNT_JSON wins; else the file named by GOOGLE_APPLICATION_CREDENTIALS."""
    environ = os.environ if environ is None else environ
    raw = environ.get(SA_ENV)
    if raw and raw.strip():
        return parse_service_account_json(raw, secret_name)
    path = environ.get(SA_FILE_ENV)
    if path and path.strip():
        try:
            text = Path(path.strip()).read_text()
        except OSError as exc:
            raise SecretUnavailableError(f"{SA_FILE_ENV} points at {path.strip()!r}, which could not be read ({type(exc).__name__}).") from exc
        return parse_service_account_json(text, SA_FILE_ENV)
    raise SecretUnavailableError(f"Set {SA_ENV} (the whole service-account JSON) or {SA_FILE_ENV} (a path to it).")
