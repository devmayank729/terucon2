"""Where the catalogue's files live: a Google Cloud Storage bucket (or, for tests and a dry local run, a folder).

Every key in this module is RELATIVE ("crops/<catalogue>/<itemId>.png"); the store prepends its own prefix (CATALOGUE_GCS_PREFIX, default
"catalogue/"), so documents never contain the prefix.

* ObjectStore       the interface (ARCHITECTURE.md section 9). Both classes below implement it.
* LocalObjectStore  a directory standing in for a bucket. Used by every test and usable for a dry local run. signed_get_url returns a file:// URL.
* GcsObjectStore    google-cloud-storage. The client is created on first use (importing this module needs no google library and no network).
* object_store_from_env(environ)  builds one from CATALOGUE_LOCAL_STORE or CATALOGUE_GCS_BUCKET / CATALOGUE_GCS_PREFIX + the service account.

Behaviour that both stores share, so a test on the folder says something about the bucket:
* put_bytes / put_file with if_absent=True create the object only if there is none, and return False (writing nothing) if there is one.
  Without if_absent they overwrite and return True.
* get_bytes / get_file raise ObjectNotFoundError (a FileNotFoundError and a KeyError) for a missing key. delete() of a missing key is not an error.
* size() is None for a missing key. list(prefix) returns RELATIVE keys, sorted, whose text starts with the prefix (a text prefix, not a directory).
* md5_hex(key) (extra, not in the pinned interface) is the hex MD5 of the stored bytes, or None if the store cannot say cheaply. The publisher uses
  it to tell whether an object that is already there holds the bytes it is about to write, without downloading it.

Keys are validated by validate_key(): no leading "/", no empty, "." or ".." segment, no backslash, no control character, at most 1024 UTF-8 bytes.
"""
from __future__ import annotations

import base64
import datetime as _dt
import hashlib
import os
import shutil
import threading
import unicodedata
import uuid
from pathlib import Path
from typing import Any, Iterable, List, Mapping, Optional, Protocol, runtime_checkable

DEFAULT_GCS_PREFIX = "catalogue/"
MAX_KEY_BYTES = 1024                      # the limit Google Cloud Storage puts on an object name
MAX_SIGNED_URL_SECONDS = 7 * 24 * 3600    # the longest a V4 signed URL may live
GCS_UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024  # resumable uploads (files over 8 MiB) go in chunks of this size; must be a multiple of 256 KiB
GCS_REQUEST_TIMEOUT_S = 300               # per request (the SDK default is 60)


class ObjectStoreError(RuntimeError):
    """Something went wrong talking to the store (the message says what, without credentials)."""


class StoreConfigError(ObjectStoreError):
    """The environment does not say where to store things (or says it badly)."""


class InvalidKeyError(ValueError):
    """The key is not a safe relative object name."""


class ObjectNotFoundError(FileNotFoundError, KeyError):
    """The key is not in the store. A FileNotFoundError and a KeyError, so callers can catch either."""

    def __str__(self) -> str:  # KeyError would show the repr of the message
        return str(self.args[0]) if self.args else "object not found"


# --------------------------------------------------------------------------------------------------------------------------- keys
def _check_text(text: str, what: str) -> None:
    for char in text:
        if unicodedata.category(char) in ("Cc", "Zl", "Zp"):
            raise InvalidKeyError(f"{what} {text!r} contains a control character (U+{ord(char):04X}).")


def validate_key(key: str) -> str:
    """Return the key if it is a safe relative object name, else raise InvalidKeyError."""
    if not isinstance(key, str):
        raise InvalidKeyError(f"a key must be text, got {type(key).__name__}.")
    if not key:
        raise InvalidKeyError("a key cannot be empty.")
    _check_text(key, "key")
    if "\\" in key:
        raise InvalidKeyError(f"key {key!r} contains a backslash; keys use '/' only.")
    if key.startswith("/"):
        raise InvalidKeyError(f"key {key!r} starts with '/'; keys are relative.")
    segments = key.split("/")
    if any(segment == "" for segment in segments):
        raise InvalidKeyError(f"key {key!r} has an empty segment ('//' or a trailing '/').")
    if any(segment in (".", "..") for segment in segments):
        raise InvalidKeyError(f"key {key!r} has a '.' or '..' segment.")
    if len(key.encode("utf-8")) > MAX_KEY_BYTES:
        raise InvalidKeyError(f"key is longer than {MAX_KEY_BYTES} bytes.")
    return key


def validate_list_prefix(prefix: str) -> str:
    """A listing prefix is text that may end in '/' or stop mid-name; it must still be safe."""
    if not isinstance(prefix, str):
        raise InvalidKeyError(f"a prefix must be text, got {type(prefix).__name__}.")
    if prefix == "":
        return prefix
    _check_text(prefix, "prefix")
    if "\\" in prefix or prefix.startswith("/"):
        raise InvalidKeyError(f"prefix {prefix!r} must be relative and use '/' only.")
    if "//" in prefix:
        raise InvalidKeyError(f"prefix {prefix!r} has an empty segment.")
    if any(segment in (".", "..") for segment in prefix.split("/")):
        raise InvalidKeyError(f"prefix {prefix!r} has a '.' or '..' segment.")
    if len(prefix.encode("utf-8")) > MAX_KEY_BYTES:
        raise InvalidKeyError(f"prefix is longer than {MAX_KEY_BYTES} bytes.")
    return prefix


def normalise_store_prefix(prefix: Optional[str]) -> str:
    """'' stays '', 'catalogue' and '/catalogue/' both become 'catalogue/'."""
    if prefix is None:
        return ""
    text = str(prefix).strip().strip("/")
    if not text:
        return ""
    validate_key(text)
    return text + "/"


def key_to_content_type(key: str) -> str:
    """A content type for the few kinds of object this package writes (so a browser shows an image instead of downloading it)."""
    lower = key.lower()
    for suffix, content_type in ((".png", "image/png"), (".jpg", "image/jpeg"), (".jpeg", "image/jpeg"), (".webp", "image/webp"),
                                 (".json", "application/json"), (".npy", "application/octet-stream"), (".pdf", "application/pdf"),
                                 (".sqlite", "application/vnd.sqlite3")):
        if lower.endswith(suffix):
            return content_type
    return "application/octet-stream"


def md5_hex_of_file(path, chunk_size: int = 1 << 20) -> str:
    digest = hashlib.md5(usedforsecurity=False)
    with open(path, "rb") as handle:
        while True:
            chunk = handle.read(chunk_size)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def md5_hex_of_bytes(data: bytes) -> str:
    return hashlib.md5(data, usedforsecurity=False).hexdigest()


# --------------------------------------------------------------------------------------------------------------------- the interface
@runtime_checkable
class ObjectStore(Protocol):
    """Keys are relative; the store adds its prefix."""

    def put_bytes(self, key: str, data: bytes, content_type: Optional[str] = None, *, if_absent: bool = False) -> bool: ...

    def put_file(self, key: str, path: Any, content_type: Optional[str] = None, *, if_absent: bool = False) -> bool: ...

    def get_bytes(self, key: str) -> bytes: ...

    def get_file(self, key: str, dest: Any) -> Path: ...

    def exists(self, key: str) -> bool: ...

    def size(self, key: str) -> Optional[int]: ...

    def delete(self, key: str) -> None: ...

    def list(self, prefix: str) -> List[str]: ...

    def signed_get_url(self, key: str, *, expires_s: int = 3600) -> str: ...


def _check_expires(expires_s: int) -> int:
    if not isinstance(expires_s, int) or isinstance(expires_s, bool) or not (1 <= expires_s <= MAX_SIGNED_URL_SECONDS):
        raise ValueError(f"expires_s must be a whole number of seconds between 1 and {MAX_SIGNED_URL_SECONDS}, got {expires_s!r}.")
    return expires_s


def _check_bytes(data: Any) -> bytes:
    if isinstance(data, (bytearray, memoryview)):
        return bytes(data)
    if not isinstance(data, bytes):
        raise TypeError(f"put_bytes needs bytes, got {type(data).__name__}.")
    return data


# ------------------------------------------------------------------------------------------------------------------- local folder
class LocalObjectStore:
    """A directory standing in for a bucket. Not durable across a power cut (no fsync); meant for tests and dry local runs."""

    _PART = ".part-"  # temp files are written here first; listing skips them

    def __init__(self, root, prefix: str = ""):
        self.root = Path(root)
        self.prefix = normalise_store_prefix(prefix)
        self.root.mkdir(parents=True, exist_ok=True)
        self._base = (self.root / self.prefix).resolve() if self.prefix else self.root.resolve()

    def __repr__(self) -> str:
        return f"LocalObjectStore({str(self.root)!r}, prefix={self.prefix!r})"

    def describe(self) -> str:
        return f"the local folder {self._base}"

    # -- paths
    def _path(self, key: str) -> Path:
        validate_key(key)
        path = self._base / key
        resolved = path.resolve()
        if resolved != self._base and self._base not in resolved.parents:
            raise InvalidKeyError(f"key {key!r} leads outside the store.")
        return path

    def _temp_beside(self, path: Path) -> Path:
        return path.with_name(f"{self._PART}{uuid.uuid4().hex}")

    def _publish_temp(self, temp: Path, path: Path, if_absent: bool) -> bool:
        """Move a finished temp file into place. With if_absent the move is atomic and refuses to replace an existing object."""
        if not if_absent:
            os.replace(temp, path)
            return True
        try:
            os.link(temp, path)         # fails with FileExistsError if there is already an object: atomic "create only if absent"
        except FileExistsError:
            os.unlink(temp)
            return False
        except OSError:
            # a file system without hard links: fall back to an exclusive create (the content is visible while it is copied; fine for a stand-in)
            try:
                with open(path, "xb") as target, open(temp, "rb") as source:
                    shutil.copyfileobj(source, target)
            except FileExistsError:
                os.unlink(temp)
                return False
            os.unlink(temp)
            return True
        os.unlink(temp)
        return True

    def _prepare_parent(self, path: Path) -> None:
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
        except (FileExistsError, NotADirectoryError) as exc:
            raise ObjectStoreError(f"cannot store {path.name!r}: part of its path is already an object in this local store "
                                   "(a bucket would allow that, a folder cannot).") from exc
        if path.is_dir():
            raise ObjectStoreError(f"cannot store an object at {path.name!r}: other objects live below that name in this local store.")

    # -- writes
    def put_bytes(self, key, data, content_type=None, *, if_absent=False) -> bool:
        data = _check_bytes(data)
        path = self._path(key)
        self._prepare_parent(path)
        if if_absent and path.exists():
            return False
        temp = self._temp_beside(path)
        try:
            temp.write_bytes(data)
            return self._publish_temp(temp, path, if_absent)
        finally:
            if temp.exists():
                temp.unlink()

    def put_file(self, key, path, content_type=None, *, if_absent=False) -> bool:
        source = Path(path)
        if not source.is_file():
            raise FileNotFoundError(f"cannot upload {str(source)!r}: it is not a file.")
        target = self._path(key)
        self._prepare_parent(target)
        if if_absent and target.exists():
            return False
        temp = self._temp_beside(target)
        try:
            shutil.copyfile(source, temp)
            return self._publish_temp(temp, target, if_absent)
        finally:
            if temp.exists():
                temp.unlink()

    # -- reads
    def get_bytes(self, key) -> bytes:
        path = self._path(key)
        try:
            return path.read_bytes()
        except (FileNotFoundError, IsADirectoryError, NotADirectoryError):
            raise ObjectNotFoundError(f"no object {key!r} in {self.describe()}") from None

    def get_file(self, key, dest) -> Path:
        source = self._path(key)
        if not source.is_file():
            raise ObjectNotFoundError(f"no object {key!r} in {self.describe()}")
        destination = Path(dest)
        destination.parent.mkdir(parents=True, exist_ok=True)
        temp = destination.with_name(f"{self._PART}{uuid.uuid4().hex}")
        try:
            shutil.copyfile(source, temp)
            os.replace(temp, destination)
        finally:
            if temp.exists():
                temp.unlink()
        return destination

    def exists(self, key) -> bool:
        return self._path(key).is_file()

    def size(self, key) -> Optional[int]:
        path = self._path(key)
        return path.stat().st_size if path.is_file() else None

    def md5_hex(self, key) -> Optional[str]:
        path = self._path(key)
        return md5_hex_of_file(path) if path.is_file() else None

    def delete(self, key) -> None:
        path = self._path(key)
        try:
            path.unlink()
        except (FileNotFoundError, IsADirectoryError, NotADirectoryError):
            return
        parent = path.parent
        while parent != self._base and self._base in parent.parents:   # tidy up folders that became empty
            try:
                parent.rmdir()
            except OSError:
                break
            parent = parent.parent

    def list(self, prefix) -> List[str]:
        validate_list_prefix(prefix)
        directory_part = prefix.rsplit("/", 1)[0] if "/" in prefix else ""
        start = self._base / directory_part if directory_part else self._base
        found: List[str] = []
        if not start.is_dir():
            return found
        for current, _directories, files in os.walk(start):
            for name in files:
                if name.startswith(self._PART):
                    continue
                relative = (Path(current) / name).relative_to(self._base).as_posix()
                if relative.startswith(prefix):
                    found.append(relative)
        return sorted(found)

    def signed_get_url(self, key, *, expires_s: int = 3600) -> str:
        _check_expires(expires_s)
        return self._path(key).resolve().as_uri()


# ------------------------------------------------------------------------------------------------------------------------------ GCS
class GcsObjectStore:
    """Google Cloud Storage through google-cloud-storage. The client is built on the first call that needs it.

    service_account_info is the parsed key (a dict); it is used both to call the API and to sign URLs. Pass client= to supply an already-built
    storage.Client (tests do). Retries are the SDK's own policy (this module sets none of its own).
    """

    def __init__(self, bucket: str, prefix: str = DEFAULT_GCS_PREFIX, service_account_info: Optional[Mapping[str, Any]] = None, *,
                 client: Any = None, list_page_size: Optional[int] = None):
        if not isinstance(bucket, str) or not bucket.strip():
            raise StoreConfigError("the bucket name is empty (set CATALOGUE_GCS_BUCKET).")
        if "/" in bucket or any(ch.isspace() for ch in bucket):
            raise StoreConfigError(f"{bucket!r} is not a bucket name (no '/' or spaces; give the name only, not gs://...).")
        self.bucket_name = bucket.strip()
        self.prefix = normalise_store_prefix(prefix)
        self._info = dict(service_account_info) if service_account_info is not None else None
        self._client = client
        self._list_page_size = list_page_size
        self._lock = threading.Lock()
        if self._client is None and self._info is None:
            raise StoreConfigError("a GcsObjectStore needs the service-account key (service_account_info) or a client.")

    def __repr__(self) -> str:
        return f"GcsObjectStore(bucket={self.bucket_name!r}, prefix={self.prefix!r})"

    def describe(self) -> str:
        return f"the bucket gs://{self.bucket_name}/{self.prefix}"

    # -- plumbing
    @property
    def client(self):
        if self._client is None:
            with self._lock:
                if self._client is None:
                    from google.cloud import storage            # lazy: the publish path with a local store never imports it
                    from google.oauth2 import service_account

                    credentials = service_account.Credentials.from_service_account_info(self._info)
                    self._client = storage.Client(project=self._info.get("project_id"), credentials=credentials)
        return self._client

    def _full(self, key: str) -> str:
        validate_key(key)
        return self.prefix + key

    def _blob(self, key: str):
        return self.client.bucket(self.bucket_name).blob(self._full(key))

    @staticmethod
    def _not_found_types():
        from google.api_core import exceptions
        return exceptions.NotFound

    # -- writes
    def put_bytes(self, key, data, content_type=None, *, if_absent=False) -> bool:
        from google.api_core import exceptions

        data = _check_bytes(data)
        blob = self._blob(key)
        arguments: dict = {"content_type": content_type or key_to_content_type(key), "timeout": GCS_REQUEST_TIMEOUT_S}
        if if_absent:
            arguments["if_generation_match"] = 0     # "only if there is no live object with this name"
        try:
            blob.upload_from_string(data, **arguments)
        except exceptions.PreconditionFailed:
            if if_absent:
                return False
            raise
        return True

    def put_file(self, key, path, content_type=None, *, if_absent=False) -> bool:
        from google.api_core import exceptions

        source = Path(path)
        if not source.is_file():
            raise FileNotFoundError(f"cannot upload {str(source)!r}: it is not a file.")
        blob = self._blob(key)
        blob.chunk_size = GCS_UPLOAD_CHUNK_BYTES      # only used for files over 8 MiB, which the SDK uploads in resumable chunks
        arguments: dict = {"content_type": content_type or key_to_content_type(key), "timeout": GCS_REQUEST_TIMEOUT_S}
        if if_absent:
            arguments["if_generation_match"] = 0
        try:
            blob.upload_from_filename(str(source), **arguments)
        except exceptions.PreconditionFailed:
            if if_absent:
                return False
            raise
        return True

    # -- reads
    def get_bytes(self, key) -> bytes:
        blob = self._blob(key)
        try:
            return blob.download_as_bytes(timeout=GCS_REQUEST_TIMEOUT_S)
        except self._not_found_types():
            raise ObjectNotFoundError(f"no object {key!r} in {self.describe()}") from None

    def get_file(self, key, dest) -> Path:
        blob = self._blob(key)
        destination = Path(dest)
        destination.parent.mkdir(parents=True, exist_ok=True)
        temp = destination.with_name(f".part-{uuid.uuid4().hex}")
        try:
            blob.download_to_filename(str(temp), timeout=GCS_REQUEST_TIMEOUT_S)
            os.replace(temp, destination)
        except self._not_found_types():
            raise ObjectNotFoundError(f"no object {key!r} in {self.describe()}") from None
        finally:
            if temp.exists():
                temp.unlink()
        return destination

    def exists(self, key) -> bool:
        return bool(self._blob(key).exists())

    def _metadata(self, key):
        return self.client.bucket(self.bucket_name).get_blob(self._full(key))

    def size(self, key) -> Optional[int]:
        blob = self._metadata(key)
        return None if blob is None else int(blob.size)

    def md5_hex(self, key) -> Optional[str]:
        blob = self._metadata(key)
        if blob is None or not blob.md5_hash:
            return None                         # missing, or an object GCS has no MD5 for (for example one composed from parts)
        return base64.b64decode(blob.md5_hash).hex()

    def delete(self, key) -> None:
        try:
            self._blob(key).delete()
        except self._not_found_types():
            return

    def list(self, prefix) -> List[str]:
        validate_list_prefix(prefix)
        full_prefix = self.prefix + prefix
        names = []
        extra = {"page_size": self._list_page_size} if self._list_page_size else {}
        for blob in self.client.list_blobs(self.bucket_name, prefix=full_prefix or None, **extra):
            if blob.name.startswith(self.prefix):
                names.append(blob.name[len(self.prefix):])
        return sorted(names)

    def signed_get_url(self, key, *, expires_s: int = 3600) -> str:
        _check_expires(expires_s)
        blob = self._blob(key)
        return blob.generate_signed_url(version="v4", expiration=_dt.timedelta(seconds=expires_s), method="GET")


# --------------------------------------------------------------------------------------------------------------------- from env
def _env_text(environ: Mapping[str, str], name: str) -> Optional[str]:
    value = environ.get(name)
    return value.strip() if isinstance(value, str) and value.strip() else None


def object_store_from_env(environ: Optional[Mapping[str, str]] = None):
    """CATALOGUE_LOCAL_STORE=<dir> gives a LocalObjectStore (a dry local run). Otherwise CATALOGUE_GCS_BUCKET + CATALOGUE_GCS_PREFIX
    (default 'catalogue/') + the service account from GCP_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS."""
    environ = os.environ if environ is None else environ
    local = _env_text(environ, "CATALOGUE_LOCAL_STORE")
    if local:
        return LocalObjectStore(local, prefix=_env_text(environ, "CATALOGUE_GCS_PREFIX") or "")
    bucket = _env_text(environ, "CATALOGUE_GCS_BUCKET")
    if not bucket:
        raise StoreConfigError("No place to store files is configured. Set CATALOGUE_GCS_BUCKET (and the service account in "
                               "GCP_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS), or set CATALOGUE_LOCAL_STORE to a folder for a dry local run.")
    from .credentials import SecretUnavailableError, load_service_account_info

    try:
        info = load_service_account_info(environ)
    except SecretUnavailableError as exc:
        raise StoreConfigError(f"The bucket {bucket!r} is configured but the service account is not: {exc}") from None
    prefix = environ.get("CATALOGUE_GCS_PREFIX")
    prefix = DEFAULT_GCS_PREFIX if prefix is None or not str(prefix).strip() else str(prefix)
    return GcsObjectStore(bucket, prefix, info)


def iter_missing(store: ObjectStore, keys: Iterable[str], present: Optional[set] = None) -> List[str]:
    """Which of these keys are not in the store (one listing per call site is cheaper than one exists() per key: pass `present`)."""
    present = present if present is not None else set()
    return [key for key in keys if key not in present and not store.exists(key)]
