"""Test helpers for the publisher: a synthetic bundle factory (the notebook's exact SQLite schema), fakes for Google Cloud Storage and MongoDB,
a store/db that fails on demand, and the behaviour suites that run against both the fakes and (test_live_contract.py) the real services.

Nothing here talks to a real service. The Google Cloud Storage fake is an HTTP transport that the REAL google-cloud-storage client runs on, so the
requests the SDK builds (ifGenerationMatch=0, resumable chunks, checksums) are the real ones and are asserted on the wire.
"""
from __future__ import annotations

import base64
import hashlib
import io
import json
import os
import re
import shutil
import sqlite3
import struct
import sys
import threading
from dataclasses import dataclass, field
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Dict, List, Optional
from urllib.parse import parse_qs, unquote, urlsplit

import numpy as np
import requests

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))  # so `import terucon_catalogue` works however pytest is started

from terucon_catalogue import config as _config  # noqa: E402
from terucon_catalogue import schema as _schema  # noqa: E402
from terucon_catalogue.state import EmbeddingRow, StateStore  # noqa: E402

# =====================================================================================================================================
# Google Cloud Storage: the real SDK on a fake HTTP transport
# =====================================================================================================================================
DISABLE_BUCKET_MD_ENV = "DISABLE_GCS_PYTHON_CLIENT_OTEL_BUCKET_METADATA"


def _crc32c_b64(data: bytes) -> str:
    import google_crc32c

    return base64.b64encode(google_crc32c.Checksum(data).digest()).decode()


def _md5_b64(data: bytes) -> str:
    return base64.b64encode(hashlib.md5(data).digest()).decode()


@dataclass
class WireRequest:
    method: str
    path: str                 # URL path, still percent-encoded
    query: Dict[str, str]
    headers: Dict[str, str]   # lower-case names
    body_len: int

    def object_name(self) -> Optional[str]:
        match = re.match(r"/(?:download/)?storage/v1/b/[^/]+/o/(.+)$", self.path)
        return unquote(match.group(1)) if match else None


class _FakeRaw(io.BytesIO):
    """What urllib3 gives requests as response.raw, as far as the SDK looks at it."""

    def __init__(self, data: bytes):
        super().__init__(data)
        self.headers: Dict[str, str] = {}

    def read(self, amt=None, decode_content=None):  # noqa: D401
        return super().read(-1 if amt is None else amt)


class FakeGcsHttp(requests.Session):
    """Just enough of the Google Cloud Storage JSON API for the SDK calls GcsObjectStore makes, with the preconditions it relies on:
    multipart and resumable uploads (ifGenerationMatch=0 gives 412 when the object exists), metadata, media download, list (with paging), delete."""

    is_mtls = False  # the SDK asks the transport

    def __init__(self, bucket: str = "test-bucket"):
        super().__init__()
        self.bucket = bucket
        self.objects: Dict[str, bytes] = {}
        self.content_types: Dict[str, str] = {}
        self.generations: Dict[str, int] = {}
        self.requests_seen: List[WireRequest] = []
        self._upload_sessions: Dict[str, dict] = {}
        self._lock = threading.Lock()
        self.fail_next: List[tuple] = []     # (method, status): make the next matching request fail once with this HTTP status

    # -- helpers
    def _response(self, status: int, body: Any = b"", headers: Optional[dict] = None, method: str = "GET", url: str = "https://storage.googleapis.com/x"):
        response = requests.Response()
        response.request = requests.Request(method, url).prepare()
        response.status_code = status
        if isinstance(body, (dict, list)):
            response._content = json.dumps(body).encode()
            response.headers["Content-Type"] = "application/json; charset=UTF-8"
        else:
            response._content = body
        response.headers.update(headers or {})
        response.url = url
        response.raw = _FakeRaw(response._content or b"")      # the SDK streams downloads from .raw
        return response

    def _error(self, status: int, message: str, method: str, url: str):
        return self._response(status, {"error": {"code": status, "message": message}}, method=method, url=url)

    def _resource(self, name: str) -> dict:
        data = self.objects[name]
        return {"kind": "storage#object", "name": name, "bucket": self.bucket, "generation": str(self.generations[name]), "metageneration": "1",
                "size": str(len(data)), "md5Hash": _md5_b64(data), "crc32c": _crc32c_b64(data), "contentType": self.content_types.get(name, "application/octet-stream"),
                "id": f"{self.bucket}/{name}/{self.generations[name]}"}

    def _store(self, name: str, data: bytes, content_type: Optional[str]) -> None:
        self.objects[name] = data
        self.content_types[name] = content_type or "application/octet-stream"
        self.generations[name] = self.generations.get(name, 0) + 1

    # -- the transport entry point
    def request(self, method, url, data=None, headers=None, params=None, timeout=None, **kwargs):  # noqa: D401
        parts = urlsplit(url)
        query = {key: values[0] for key, values in parse_qs(parts.query).items()}
        lowered = {key.lower(): (value.decode() if isinstance(value, bytes) else value) for key, value in (headers or {}).items()}
        if data is None:
            body = b""
        elif isinstance(data, (bytes, bytearray)):
            body = bytes(data)
        elif hasattr(data, "read"):
            body = data.read()
        else:
            body = bytes(data)
        with self._lock:
            self.requests_seen.append(WireRequest(method, parts.path, query, lowered, len(body)))
            for index, (fail_method, status) in enumerate(self.fail_next):
                if fail_method == method:
                    del self.fail_next[index]
                    return self._error(status, "injected failure", method, url)
            return self._handle(method, url, parts.path, query, lowered, body)

    def _handle(self, method, url, path, query, headers, body):
        upload = re.match(r"/upload/storage/v1/b/([^/]+)/o$", path)
        if upload and method == "POST":
            return self._start_upload(method, url, query, headers, body)
        if upload and method == "PUT" and query.get("upload_id"):
            return self._continue_upload(method, url, query, headers, body)
        match = re.match(r"/(?:download/)?storage/v1/b/([^/]+)/o/(.+)$", path)     # media downloads come from /download/storage/v1/...
        if match and method == "GET":
            name = unquote(match.group(2))
            if name not in self.objects:
                return self._error(404, f"No such object: {self.bucket}/{name}", method, url)
            if query.get("alt") == "media":
                data = self.objects[name]
                return self._response(200, data, {"Content-Type": self.content_types.get(name, "application/octet-stream"),
                                                  "x-goog-hash": f"crc32c={_crc32c_b64(data)},md5={_md5_b64(data)}"}, method=method, url=url)
            return self._response(200, self._resource(name), method=method, url=url)
        if match and method == "DELETE":
            name = unquote(match.group(2))
            if name not in self.objects:
                return self._error(404, f"No such object: {self.bucket}/{name}", method, url)
            for table in (self.objects, self.content_types, self.generations):
                table.pop(name, None)
            return self._response(204, b"", method=method, url=url)
        if re.match(r"/storage/v1/b/([^/]+)/o$", path) and method == "GET":
            return self._list(method, url, query)
        if re.match(r"/storage/v1/b/([^/]+)$", path) and method == "GET":     # the SDK's background bucket-metadata lookup (see DISABLE_BUCKET_MD_ENV)
            return self._response(200, {"kind": "storage#bucket", "name": self.bucket, "location": "EUROPE-WEST1", "projectNumber": "1"}, method=method, url=url)
        return self._error(400, f"the fake does not implement {method} {path}", method, url)

    def _list(self, method, url, query):
        prefix = query.get("prefix", "")
        names = sorted(name for name in self.objects if name.startswith(prefix))
        start = int(query["pageToken"]) if query.get("pageToken") else 0
        size = int(query.get("maxResults", 1000))
        page = names[start:start + size]
        body: Dict[str, Any] = {"kind": "storage#objects", "items": [{"name": name, "bucket": self.bucket, "size": str(len(self.objects[name]))} for name in page]}
        if start + size < len(names):
            body["nextPageToken"] = str(start + size)
        return self._response(200, body, method=method, url=url)

    def _precondition_ok(self, query, name) -> bool:
        return not (query.get("ifGenerationMatch") == "0" and name in self.objects)

    def _start_upload(self, method, url, query, headers, body):
        kind = query.get("uploadType")
        if kind == "multipart":
            content_type = headers.get("content-type", "")
            boundary = re.search(r'boundary="?([^";]+)"?', content_type).group(1).encode()
            pieces = body.split(b"--" + boundary)
            metadata = json.loads(pieces[1].split(b"\r\n\r\n", 1)[1].rsplit(b"\r\n", 1)[0])
            media_headers, content = pieces[2].split(b"\r\n\r\n", 1)
            content = content.rsplit(b"\r\n", 1)[0]
            media_type = re.search(rb"(?i)content-type:\s*([^\r\n]+)", media_headers)
            name = metadata["name"]
            if not self._precondition_ok(query, name):
                return self._error(412, "At least one of the pre-conditions you specified did not hold.", method, url)
            self._store(name, content, metadata.get("contentType") or (media_type.group(1).decode().strip() if media_type else None))
            return self._response(200, self._resource(name), method=method, url=url)
        if kind == "resumable":
            metadata = json.loads(body) if body else {}
            name = metadata["name"]
            if not self._precondition_ok(query, name):
                return self._error(412, "At least one of the pre-conditions you specified did not hold.", method, url)
            session_id = f"session-{len(self._upload_sessions)}"
            self._upload_sessions[session_id] = {"name": name, "data": b"", "content_type": metadata.get("contentType") or headers.get("x-upload-content-type")}
            location = f"https://storage.googleapis.com/upload/storage/v1/b/{self.bucket}/o?uploadType=resumable&upload_id={session_id}"
            return self._response(200, b"", {"Location": location}, method=method, url=url)
        return self._error(400, f"unknown uploadType {kind!r}", method, url)

    def _continue_upload(self, method, url, query, headers, body):
        session = self._upload_sessions[query["upload_id"]]
        content_range = headers.get("content-range", "")
        match = re.match(r"bytes (\d+)-(\d+)/(\d+|\*)", content_range)
        if match and int(match.group(1)) != len(session["data"]):
            return self._error(400, f"chunk starts at {match.group(1)} but {len(session['data'])} bytes are stored", method, url)
        session["data"] += body
        total = content_range.rsplit("/", 1)[-1]
        if total != "*" and len(session["data"]) == int(total):
            name = session["name"]
            if name in self.objects and self._upload_precondition_failed(name, session):
                return self._error(412, "pre-condition failed at the end of the upload", method, url)
            self._store(name, session["data"], session["content_type"])
            return self._response(200, self._resource(name), method=method, url=url)
        return self._response(308, b"", {"Range": f"bytes=0-{len(session['data']) - 1}"}, method=method, url=url)

    def _upload_precondition_failed(self, name, session) -> bool:
        return False  # the precondition is decided when the upload is started, which is what Google does too

    # -- convenience for assertions
    def clear_log(self) -> None:
        self.requests_seen.clear()

    def object_requests(self) -> List[WireRequest]:
        """Requests other than the SDK's optional background bucket lookup."""
        return [r for r in self.requests_seen if not re.match(r"/storage/v1/b/[^/]+$", r.path)]


_THROWAWAY_KEY: Dict[str, Any] = {}


def throwaway_service_account_info() -> dict:
    """A service-account key made on the spot with a fresh RSA key. It can sign (so V4 URLs can be built) but it belongs to no real account."""
    if not _THROWAWAY_KEY:
        from cryptography.hazmat.primitives import serialization
        from cryptography.hazmat.primitives.asymmetric import rsa

        private = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        pem = private.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()).decode()
        _THROWAWAY_KEY["info"] = {"type": "service_account", "project_id": "throwaway-project", "private_key_id": "k1", "private_key": pem,
                                  "client_email": "publisher@throwaway-project.iam.gserviceaccount.com", "token_uri": "https://oauth2.googleapis.com/token"}
        _THROWAWAY_KEY["public"] = private.public_key()
    return dict(_THROWAWAY_KEY["info"])


def throwaway_public_key():
    throwaway_service_account_info()
    return _THROWAWAY_KEY["public"]


def make_gcs_store(bucket: str = "test-bucket", prefix: str = "catalogue/", *, list_page_size: Optional[int] = None):
    """A GcsObjectStore whose google-cloud-storage client talks to a FakeGcsHttp. Returns (store, fake)."""
    from google.cloud import storage
    from google.oauth2 import service_account

    from terucon_catalogue.objectstore import GcsObjectStore

    fake = FakeGcsHttp(bucket)
    credentials = service_account.Credentials.from_service_account_info(throwaway_service_account_info())   # signs URLs; never used to call Google
    client = storage.Client(project="test-project", credentials=credentials, _http=fake)
    return GcsObjectStore(bucket, prefix, client=client, list_page_size=list_page_size), fake


# =====================================================================================================================================
# The object-store behaviour suite: the SAME function runs on LocalObjectStore, on GcsObjectStore over the fake transport, and (test_live_contract.py)
# on a real bucket inside a throw-away prefix.
# =====================================================================================================================================
def object_store_contract(store, tmp_path: Path) -> None:
    from terucon_catalogue.objectstore import InvalidKeyError, ObjectNotFoundError

    key = "crops/cat-one/aaaaaaaaaaaa-p0001-i00.png"
    payload = bytes(range(256)) * 40                  # every byte value, 10 KiB

    # create, read back, size, listing
    assert store.exists(key) is False and store.size(key) is None and store.md5_hex(key) is None
    assert store.put_bytes(key, payload, "image/png", if_absent=True) is True
    assert store.exists(key) is True and store.size(key) == len(payload) and store.get_bytes(key) == payload
    assert store.md5_hex(key) == hashlib.md5(payload).hexdigest()
    assert key in store.list("crops/cat-one/")

    # create-only-if-absent: the second writer loses, the first bytes stay
    assert store.put_bytes(key, b"something else", "image/png", if_absent=True) is False
    assert store.get_bytes(key) == payload
    # overwrite
    assert store.put_bytes(key, b"replaced") is True
    assert store.get_bytes(key) == b"replaced" and store.size(key) == len(b"replaced")

    # files, in and out
    source = tmp_path / "upload.bin"
    source.write_bytes(payload)
    file_key = "sources/" + "b" * 64 + "/My catalogue (final) é.pdf"        # spaces and non-ASCII are normal in real source names
    assert store.put_file(file_key, source, "application/pdf", if_absent=True) is True
    assert store.put_file(file_key, source, "application/pdf", if_absent=True) is False
    assert store.size(file_key) == len(payload) and store.md5_hex(file_key) == hashlib.md5(payload).hexdigest()
    destination = tmp_path / "down" / "copy.bin"
    assert store.get_file(file_key, destination) == destination and destination.read_bytes() == payload
    assert file_key in store.list("sources/")

    # empty objects are objects
    assert store.put_bytes("bundles/cat-one/job-x/empty", b"") is True
    assert store.exists("bundles/cat-one/job-x/empty") and store.size("bundles/cat-one/job-x/empty") == 0 and store.get_bytes("bundles/cat-one/job-x/empty") == b""

    # a listing is a TEXT prefix, sorted, relative to the store's prefix
    for name in ("releases/cat-one/rel-1/manifest.json", "releases/cat-one/rel-1/items.json", "releases/cat-one/rel-10/manifest.json", "releases/cat-two/rel-1/manifest.json"):
        store.put_bytes(name, b"{}")
    assert store.list("releases/cat-one/rel-1/") == ["releases/cat-one/rel-1/items.json", "releases/cat-one/rel-1/manifest.json"]
    assert store.list("releases/cat-one/rel-1") == [
        "releases/cat-one/rel-1/items.json", "releases/cat-one/rel-1/manifest.json", "releases/cat-one/rel-10/manifest.json"]
    assert store.list("releases/cat-one/") == sorted(store.list("releases/cat-one/"))
    assert store.list("nothing/here/") == []

    # missing objects
    missing = "crops/cat-one/does-not-exist.png"
    for call in (lambda: store.get_bytes(missing), lambda: store.get_file(missing, tmp_path / "never.bin")):
        try:
            call()
        except ObjectNotFoundError as error:
            assert isinstance(error, FileNotFoundError) and isinstance(error, KeyError)
        else:
            raise AssertionError("a missing object must raise ObjectNotFoundError")
    assert not (tmp_path / "never.bin").exists()

    # delete, and deleting what is not there
    store.delete(key)
    store.delete(key)
    assert store.exists(key) is False and key not in store.list("crops/")

    # keys that could escape or confuse a store are refused by every method, before anything is sent
    for bad in ("../x", "/abs", "a//b", "a/", "", "a/./b", "a/../b", "a\x00b", "a\nb", "a\\b", "x" * 1100, "a/\x7fb"):
        for call in (lambda b=bad: store.put_bytes(b, b"x"), lambda b=bad: store.put_file(b, source), lambda b=bad: store.get_bytes(b),
                     lambda b=bad: store.get_file(b, tmp_path / "bad.bin"), lambda b=bad: store.exists(b), lambda b=bad: store.size(b),
                     lambda b=bad: store.delete(b), lambda b=bad: store.signed_get_url(b)):
            try:
                call()
            except InvalidKeyError:
                pass
            else:
                raise AssertionError(f"key {bad!r} must be refused")
    for bad_prefix in ("../x", "/abs", "a//b"):
        try:
            store.list(bad_prefix)
        except InvalidKeyError:
            pass
        else:
            raise AssertionError(f"prefix {bad_prefix!r} must be refused")

    # signed URLs: text, and a sensible lifetime
    url = store.signed_get_url(file_key, expires_s=600)
    assert isinstance(url, str) and url
    for bad_expiry in (0, -5, 7 * 24 * 3600 + 1, 1.5):
        try:
            store.signed_get_url(file_key, expires_s=bad_expiry)
        except ValueError:
            pass
        else:
            raise AssertionError(f"expires_s={bad_expiry!r} must be refused")


# =====================================================================================================================================
# MongoDB: mongomock (with the compatibility shim it needs) and the behaviour suite that runs on MemoryCatalogueDb, on mongomock and on a real server
# =====================================================================================================================================
def apply_mongomock_shims(monkeypatch) -> None:
    """mongomock 4.3.0 predates pymongo 4.10, whose UpdateOne/ReplaceOne pass sort= to the bulk builder. Accept it (we never use it) so the real
    pymongo operation objects can be used against mongomock. Applied per test through monkeypatch, so nothing leaks."""
    import mongomock.collection as mongomock_collection

    builder = mongomock_collection.BulkOperationBuilder
    original_update, original_replace = builder.add_update, builder.add_replace

    def add_update(self, selector, doc, multi=False, upsert=False, collation=None, array_filters=None, hint=None, sort=None):
        if sort is not None:
            raise NotImplementedError("the mongomock shim does not support sort=")
        return original_update(self, selector, doc, multi, upsert, collation, array_filters, hint)

    def add_replace(self, selector, doc, upsert, collation=None, hint=None, sort=None):
        if sort is not None:
            raise NotImplementedError("the mongomock shim does not support sort=")
        return original_replace(self, selector, doc, upsert, collation, hint)

    monkeypatch.setattr(builder, "add_update", add_update)
    monkeypatch.setattr(builder, "add_replace", add_replace)


def make_mongo_db(monkeypatch, db_name: str = "terucon_test", *, clock=None):
    """A MongoCatalogueDb (the real class) on a mongomock client."""
    import mongomock

    from terucon_catalogue.mongo import MongoCatalogueDb

    apply_mongomock_shims(monkeypatch)
    kwargs = {"clock": clock} if clock is not None else {}
    return MongoCatalogueDb("mongodb://localhost:27017/" + db_name, client=mongomock.MongoClient(), **kwargs)


def make_item_doc(catalogue: str, item_id: str, *, release_id: str = "rel-20261101000000-aaaaaa", job_id: Optional[str] = None, now: int = 1_793_000_000_000,
                  pdf_product_id: Optional[str] = None, category: Optional[str] = "stone", subtype: Optional[str] = "polished black marble", page: int = 1) -> dict:
    """An item document in the exact shape of ARCHITECTURE.md 4.4, as the publisher builds it."""
    return {
        "_id": f"{catalogue}|{item_id}", "catalogue": catalogue, "itemId": item_id, "status": "ok", "label": None,
        "productId": pdf_product_id, "productIdSource": "pdf-text" if pdf_product_id else None,
        "subtype": subtype, "category": category, "finish": "polished",
        "description": {"grain": "veined", "patternScale": "20 mm", "colour": "#271C1C", "specular": "sharp", "feel": "smooth", "keywords": ["stone", "black"]},
        "dominantHex": ["#271C1C", "#F1ECEA", "#624A41"], "proportions": [0.5, 0.3, 0.2],
        "captionModel": "gemini-2.5-flash", "captionVersion": "abc123def456",
        "source": {"name": "Superbond colour image.pdf", "sha256": "a" * 64, "page": page, "itemIndex": 0, "bbox": [26.833, 15.0, 568.166, 827.0], "idBbox": None,
                   "pageWidth": 595.0, "pageHeight": 842.0, "rotation": 0, "method": "embedded_image", "matchType": "none", "matchRelation": None,
                   "matchCost": None, "inpainted": False, "pdfProductId": pdf_product_id},
        "images": {"crop": {"key": f"crops/{catalogue}/{item_id}.png", "width": 160, "height": 224, "sha256": "b" * 64, "bytes": 1234},
                   "thumb": {"key": f"thumbs/{catalogue}/{item_id}.jpg", "width": 160, "height": 224, "bytes": 456}},
        "attributes": {}, "releaseFirst": release_id, "jobId": job_id, "createdAt": now, "updatedAt": now,
    }


def make_release_doc(catalogue: str, release_id: str, created_at: int, *, parent: Optional[str] = None) -> dict:
    return {"_id": release_id, "catalogue": catalogue, "createdAt": created_at, "createdBy": "cli", "jobId": None, "parent": parent, "nItems": 3,
            "featureVersions": {"dino": "v"}, "pillars": {"dino": {"count": 3, "dim": 4}}, "gcsPrefix": f"releases/{catalogue}/{release_id}/",
            "manifestSha256": "c" * 64}


def catalogue_db_contract(db) -> None:
    """Behaviour every CatalogueDb must have. Uses catalogue ids that start with 'contract-' so a real database stays tidy."""
    from terucon_catalogue.mongo import CatalogueDbError, CatalogueNotFoundError, DuplicateKeyError

    cat = "contract-one"
    assert db.get_catalogue(cat) is None
    with pytest_raises(CatalogueDbError):
        db.upsert_catalogue(cat)                                     # creating needs a name
    with pytest_raises(CatalogueDbError):
        db.upsert_catalogue("Bad Id", name="x")
    with pytest_raises(CatalogueDbError):
        db.upsert_catalogue(cat, name="x", kind="furniture")
    created = db.upsert_catalogue(cat, name="Contract one", kind="materials", note="first")
    assert created["_id"] == cat and created["activeRelease"] is None and created["previousRelease"] is None and created["featureVersions"] is None
    assert created["counts"] == {"items": 0, "hidden": 0} and isinstance(created["createdAt"], int) and isinstance(created["updatedAt"], int)
    renamed = db.upsert_catalogue(cat, name="Renamed")
    assert renamed["name"] == "Renamed" and renamed["note"] == "first" and renamed["createdAt"] == created["createdAt"]
    assert [c["_id"] for c in db.list_catalogues() if c["_id"].startswith("contract-")] == [cat]
    with pytest_raises(CatalogueNotFoundError):
        db.set_active_release("contract-missing", "rel-x")

    # items: insert, refresh, and an admin's edits survive
    ids = ["aaaaaaaaaaaa-p0001-i00", "aaaaaaaaaaaa-p0002-i00", "aaaaaaaaaaaa-p0003-i00"]
    first = [make_item_doc(cat, item_id, pdf_product_id="SB100" if index == 0 else None, page=index + 1, now=1000) for index, item_id in enumerate(ids)]
    assert db.upsert_items(cat, first) == {"inserted": 3, "updated": 0}
    assert db.count_items(cat) == 3 and db.count_items(cat, "ok") == 3 and db.count_items(cat, "hidden") == 0
    stored = db.get_items(cat, ids[:2])
    assert sorted(stored) == ids[:2] and stored[ids[0]]["productId"] == "SB100" and stored[ids[0]]["productIdSource"] == "pdf-text"
    assert stored[ids[1]]["label"] is None and stored[ids[1]]["status"] == "ok" and stored[ids[1]]["attributes"] == {}
    assert sorted(db.get_items(cat)) == ids and db.get_items(cat, ["nope"]) == {}

    assert db.patch_item(cat, ids[0], {"label": "Emperor Dark", "status": "hidden", "attributes": {"series": "SB", "n": 3, "ok": True}, "productId": "ADMIN-1"})
    assert db.patch_item(cat, ids[1], {"label": "Second"})
    assert db.patch_item(cat, "no-such-item", {"label": "x"}) is False
    with pytest_raises(CatalogueDbError):
        db.patch_item(cat, ids[0], {"releaseFirst": "rel-evil"})      # not an admin field
    second = [make_item_doc(cat, item_id, release_id="rel-20261102000000-bbbbbb", job_id="job-1", now=2000, category="metal",
                            subtype="brushed steel", pdf_product_id="NEW" + str(index), page=index + 1) for index, item_id in enumerate(ids)]
    assert db.upsert_items(cat, second) == {"inserted": 0, "updated": 3}
    after = db.get_items(cat)
    assert after[ids[0]]["label"] == "Emperor Dark" and after[ids[0]]["status"] == "hidden" and after[ids[0]]["attributes"] == {"series": "SB", "n": 3, "ok": True}
    assert after[ids[0]]["productId"] == "ADMIN-1" and after[ids[0]]["productIdSource"] == "admin"          # the admin's id stays
    assert after[ids[1]]["label"] == "Second" and after[ids[1]]["productId"] == "NEW1" and after[ids[1]]["productIdSource"] == "pdf-text"
    assert after[ids[2]]["productId"] == "NEW2"
    for item_id in ids:                                                                                  # publisher-owned fields were refreshed ...
        assert after[item_id]["category"] == "metal" and after[item_id]["subtype"] == "brushed steel" and after[item_id]["updatedAt"] == 2000
        assert after[item_id]["createdAt"] == 1000 and after[item_id]["releaseFirst"] == "rel-20261101000000-aaaaaa" and after[item_id]["jobId"] is None   # ... insert-only ones were not
    assert db.count_items(cat, "hidden") == 1 and db.count_items(cat, "ok") == 2
    # an admin who clears the id gives it back to the PDF text layer
    assert db.patch_item(cat, ids[0], {"productId": None})
    db.upsert_items(cat, second)
    assert db.get_items(cat, ids[:1])[ids[0]]["productId"] == "NEW0" and db.get_items(cat, ids[:1])[ids[0]]["productIdSource"] == "pdf-text"
    # a document that is not whole, or belongs elsewhere, is refused and nothing is written
    broken = make_item_doc(cat, "aaaaaaaaaaaa-p0004-i00")
    del broken["images"]
    with pytest_raises(CatalogueDbError):
        db.upsert_items(cat, [make_item_doc(cat, "aaaaaaaaaaaa-p0005-i00"), broken])
    with pytest_raises(CatalogueDbError):
        db.upsert_items(cat, [make_item_doc("contract-other", "aaaaaaaaaaaa-p0006-i00")])
    assert db.count_items(cat) == 3

    # the active release pointer
    versions = {"dino": "v-dino", "siglip": "v-siglip"}
    flipped = db.set_active_release(cat, "rel-1", feature_versions=versions, counts={"items": 2, "hidden": 1})
    assert flipped["activeRelease"] == "rel-1" and flipped["previousRelease"] is None and flipped["featureVersions"] == versions and flipped["counts"] == {"items": 2, "hidden": 1}
    assert db.set_active_release(cat, "rel-2")["previousRelease"] == "rel-1"
    again = db.set_active_release(cat, "rel-2", counts={"items": 3, "hidden": 0})
    assert again["activeRelease"] == "rel-2" and again["previousRelease"] == "rel-1" and again["featureVersions"] == versions and again["counts"] == {"items": 3, "hidden": 0}
    rolled_back = db.set_active_release(cat, "rel-1")
    assert rolled_back["activeRelease"] == "rel-1" and rolled_back["previousRelease"] == "rel-2"
    assert db.set_active_release(cat, None)["activeRelease"] is None and db.get_catalogue(cat)["previousRelease"] == "rel-1"

    # releases: newest first
    for index, release_id in enumerate(["rel-20261101000000-aaaaaa", "rel-20261103000000-cccccc", "rel-20261102000000-bbbbbb"]):
        db.insert_release(make_release_doc(cat, release_id, 100 + (0, 2, 1)[index], parent=None if index == 0 else "rel-x"))
    db.insert_release(make_release_doc("contract-other", "rel-20261104000000-dddddd", 500))
    assert [r["_id"] for r in db.list_releases(cat)] == ["rel-20261103000000-cccccc", "rel-20261102000000-bbbbbb", "rel-20261101000000-aaaaaa"]
    assert [r["_id"] for r in db.list_releases(cat, limit=1)] == ["rel-20261103000000-cccccc"]
    assert db.get_release("rel-20261102000000-bbbbbb")["parent"] == "rel-x" and db.get_release("rel-none") is None
    with pytest_raises(DuplicateKeyError):
        db.insert_release(make_release_doc(cat, "rel-20261102000000-bbbbbb", 1))
    with pytest_raises(CatalogueDbError):
        db.insert_release({"_id": "rel-incomplete"})

    # jobs: fields, dotted fields and the 200-line log
    job_id = "job-20261101000000-abcdef"
    db.insert_job({"_id": job_id, "catalogue": cat, "kind": "pdf", "status": "queued", "stage": "waiting", "progress": {"done": 0, "total": 0, "message": ""},
                   "createdAt": 5, "log": [], "result": None, "error": None})
    with pytest_raises(DuplicateKeyError):
        db.insert_job({"_id": job_id})
    assert db.get_job(job_id)["status"] == "queued" and db.get_job("job-none") is None
    assert db.update_job(job_id, {"status": "running", "progress.done": 3, "progress.total": 10, "progress.message": "extracting"})
    job = db.get_job(job_id)
    assert job["status"] == "running" and job["progress"] == {"done": 3, "total": 10, "message": "extracting"}
    assert db.update_job("job-none", {"status": "failed"}) is False
    for index in range(250):
        assert db.append_job_log(job_id, "warn" if index % 2 else "info", f"line {index}", t=index)
    log = db.get_job(job_id)["log"]
    assert len(log) == 200 and log[0]["msg"] == "line 50" and log[-1] == {"t": 249, "level": "info" if 249 % 2 == 0 else "warn", "msg": "line 249"}
    assert db.append_job_log("job-none", "info", "x") is False
    with pytest_raises(CatalogueDbError):
        db.append_job_log(job_id, "loud", "x")
    assert [j["_id"] for j in db.list_jobs() if j["_id"] == job_id] == [job_id]

    # indexes of 4.4 exist
    assert {"catalogue_1_status_1", "catalogue_1_productId_1"} <= set(db.index_names("terucon_catalogue_items"))
    assert "status_1_createdAt_1" in db.index_names("terucon_catalogue_jobs")
    assert "catalogue_1_createdAt_1" in db.index_names("terucon_catalogue_releases")


class pytest_raises:  # noqa: N801  (a tiny stand-in so this module does not need to import pytest at import time)
    def __init__(self, expected):
        self.expected = expected

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        if exc_type is None:
            raise AssertionError(f"expected {self.expected.__name__} to be raised")
        return issubclass(exc_type, self.expected)


# =====================================================================================================================================
# A synthetic bundle: the notebook's exact SQLite schema, written through StateStore's OWN methods (so every row has the real encoding),
# with the real vector sizes, the real feature-version strings and, for the legacy variant, the notebook's absolute Kaggle paths.
# =====================================================================================================================================
REAL_DIMS = {"dino": 3072, "siglip": 1152, "color": 396, "vertex_mm": 1408, "text": 768}      # cell 7's stored output
PDF_NAME = "Superbond colour image.pdf"
KAGGLE_PDF_PATH = "/kaggle/input/datasets/mayankr293/terucon-catalogue-1/" + PDF_NAME
REAL_BBOX = [26.833, 15.0, 568.166, 827.0]                                                    # the same on all 69 real items


def notebook_safe_name(text: str, limit: int = 60) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "_", text)[:limit].strip("_") or "pdf"


@dataclass
class BundleInfo:
    path: Path
    item_ids: List[str]
    pdf_sha256: str
    pdf_path: Path
    pdf_name: str
    crop_dir: str
    crop_paths: Dict[str, Path]
    versions: Dict[str, str]
    vectors: Dict[str, Dict[str, np.ndarray]]
    legacy: bool
    store: Any = None

    @property
    def state_path(self) -> Path:
        return self.path / "state.sqlite"

    def stored_crop_path(self, item_id: str) -> str:
        suffix = f"crops/{self.crop_dir}/{item_id}.png"
        return "/kaggle/working/" + suffix if self.legacy else suffix


def _unit_rows(rng, count: int, dim: int) -> np.ndarray:
    matrix = rng.normal(size=(count, dim)).astype(np.float32)
    return matrix / np.linalg.norm(matrix, axis=1, keepdims=True)


def _crop_rgb(rng, index: int, size) -> np.ndarray:
    width, height = size
    ramp = np.linspace(0, 255, width, dtype=np.float32)[None, :, None] * np.array([1.0, 0.6, 0.3], dtype=np.float32)
    shade = np.linspace(40, 215, height, dtype=np.float32)[:, None, None] * np.array([0.5, 0.7, 1.0], dtype=np.float32)
    noise = rng.normal(0, 6, size=(height, width, 3))
    return np.clip(ramp * 0.5 + shade * 0.5 + noise + index * 3, 0, 255).astype(np.uint8)


def make_bundle(path, n_items: int = 3, *, legacy_kaggle_paths: bool = False, crop_px=(48, 64), pdf_name: str = PDF_NAME, seed: int = 0,
                pdf_bytes: Optional[bytes] = None, pillars=tuple(REAL_DIMS), dims: Optional[Dict[str, int]] = None, product_ids: Optional[Dict[int, str]] = None,
                captions: bool = True, first_page: int = 1, pdf_dir=None, keep_open: bool = False) -> BundleInfo:
    """Write a bundle (state.sqlite + crops/) into `path` and return what is in it.

    legacy_kaggle_paths=True stores what the Kaggle notebook stores: crop_filepath '/kaggle/working/crops/<dir>/<file>.png' and source_pdf
    '/kaggle/input/datasets/<user>/<slug>/<name>.pdf'; the crop files themselves are in <path>/crops/<dir>/ as they would be after a download.
    Otherwise paths are relative ('crops/<dir>/<file>.png') and source_pdf is the file name, which is what this package's own compute writes.
    product_ids maps an item's position (0-based) to a product id 'read from the PDF text layer'; by default every item is UNMATCHED (None) like the real 69.
    """
    from terucon_catalogue.config import PipelineConfig, compute_caption_version, compute_feature_versions
    from terucon_catalogue.schema import MaterialProfile, compose_search_document
    from terucon_catalogue.util import encode_rgb

    path = Path(path)
    rng = np.random.default_rng(seed)
    cfg = PipelineConfig()
    versions_all = compute_feature_versions(cfg)
    versions = {pillar: versions_all[pillar] for pillar in pillars}
    sizes = {**REAL_DIMS, **(dims or {})}
    pdf_bytes = pdf_bytes if pdf_bytes is not None else b"%PDF-1.7\n% a synthetic catalogue for tests: " + pdf_name.encode() + b"\n" + rng.bytes(3000)
    pdf_sha256 = hashlib.sha256(pdf_bytes).hexdigest()
    pdf_dir = Path(pdf_dir) if pdf_dir is not None else path.parent / (path.name + "-pdf-input")
    pdf_dir.mkdir(parents=True, exist_ok=True)
    pdf_path = pdf_dir / pdf_name
    pdf_path.write_bytes(pdf_bytes)

    crop_dir = f"{notebook_safe_name(Path(pdf_name).stem)}_{pdf_sha256[:8]}"
    source_pdf = KAGGLE_PDF_PATH if legacy_kaggle_paths else pdf_name
    path.mkdir(parents=True, exist_ok=True)
    (path / "crops" / crop_dir).mkdir(parents=True, exist_ok=True)
    store = StateStore(path / "state.sqlite")
    store.upsert_pdf(pdf_sha256, source_pdf, len(pdf_bytes), first_page - 1 + n_items, "done")

    item_ids, crop_paths = [], {}
    for index in range(n_items):
        page = first_page + index
        item_id = f"{pdf_sha256[:12]}-p{page:04d}-i00"
        encoded = encode_rgb(_crop_rgb(rng, index, crop_px), "png")
        crop_file = path / "crops" / crop_dir / f"{item_id}.png"
        crop_file.write_bytes(encoded)
        stored = ("/kaggle/working/" if legacy_kaggle_paths else "") + f"crops/{crop_dir}/{item_id}.png"
        product_id = (product_ids or {}).get(index)
        item = {"item_id": item_id, "product_id": product_id, "product_id_raw": product_id, "source_pdf": source_pdf, "pdf_sha256": pdf_sha256, "page_number": page,
                "item_index": 0, "image_bbox": list(REAL_BBOX), "id_bbox": None, "page_width": 595.0, "page_height": 842.0, "original_rotation": 0,
                "crop_filepath": stored, "crop_width": crop_px[0], "crop_height": crop_px[1], "render_zoom": 1.8916, "sha256_hash": hashlib.sha256(encoded).hexdigest(),
                "match_type": "single_image" if product_id else "none", "match_relation": "below" if product_id else None, "match_cost": 0.01 if product_id else None,
                "extraction_method": "embedded_image", "image_xrefs": [100 + index], "inpainted_overlay": False}
        store.commit_page_result(SimpleNamespace(
            pdf_sha256=pdf_sha256, source_pdf=source_pdf, page_number=page, original_rotation=0, page_width=595.0, page_height=842.0, extraction_method="embedded_image",
            n_image_regions=1, n_id_candidates=0 if not product_id else 1, items=[item], orphans=[], debug={"candidates": [], "regions": []}))
        item_ids.append(item_id)
        crop_paths[item_id] = crop_file

    vectors: Dict[str, Dict[str, np.ndarray]] = {}
    for pillar in pillars:
        matrix = _unit_rows(rng, n_items, sizes[pillar])
        rows = []
        for position, item_id in enumerate(item_ids):
            extra = None
            if pillar == "color":
                extra = {"dominant_hex": ["#4C4C4E", "#F2EFEF", "#%02X%02X%02X" % (20 + position % 200, 120, 114)], "proportions": [0.5, 0.3, 0.2],
                         "dominant_lab": [[30.1, 0.5, -1.2], [95.0, 0.3, 0.6], [52.4, 4.0, 3.1]]}
            rows.append(EmbeddingRow(item_id, pillar, versions[pillar], matrix[position], extra))
        store.upsert_embeddings(rows)
        vectors[pillar] = {item_id: np.asarray(matrix[position], dtype=np.float16) for position, item_id in enumerate(item_ids)}

    if captions:
        caption_version = compute_caption_version(cfg)
        results = []
        for position, item_id in enumerate(item_ids):
            profile = MaterialProfile(
                material_category="stone", material_subtype=f"polished black marble {position}", surface_finish="polished", secondary_finishes=["honed"],
                grain_or_pattern_description="fine white veining on a dark ground", pattern_scale="about 20 mm", color_palette_description="#271C1C base, #F1ECEA veins",
                specular_behavior="broad soft highlights", micro_surface_feel="smooth, cool", search_keywords=["marble", "black", "polished", "veined", "stone", "dark", "luxury", "tile"],
                nano_banana_render_prompt="A polished black marble surface. " * 12, confidence=0.9).model_dump(mode="json")
            results.append(SimpleNamespace(item_id=item_id, caption_version=caption_version, status="ok", model="gemini-2.5-flash", profile=profile,
                                           search_text=compose_search_document(profile, ["#4C4C4E", "#F2EFEF"]), error=None))
        store.save_captions(results)

    info = BundleInfo(path=path, item_ids=item_ids, pdf_sha256=pdf_sha256, pdf_path=pdf_path, pdf_name=pdf_name, crop_dir=crop_dir, crop_paths=crop_paths,
                      versions=versions, vectors=vectors, legacy=legacy_kaggle_paths, store=store if keep_open else None)
    if not keep_open:
        store.close()
    return info


# ------------------------------------------------------------------------------------------------------------------ damaging a bundle
def _sql(info_or_path, statement: str, parameters=()) -> None:
    state = info_or_path.state_path if isinstance(info_or_path, BundleInfo) else Path(info_or_path)
    connection = sqlite3.connect(str(state))
    try:
        connection.execute(statement, parameters)
        connection.commit()
    finally:
        connection.close()


def flip_crop_byte(info: BundleInfo, item_id: str) -> None:
    path = info.crop_paths[item_id]
    data = bytearray(path.read_bytes())
    data[len(data) // 2] ^= 0xFF
    path.write_bytes(bytes(data))


def delete_crop(info: BundleInfo, item_id: str) -> None:
    info.crop_paths[item_id].unlink()


def truncate_vector(info: BundleInfo, item_id: str, pillar: str, keep_bytes: int) -> None:
    _sql(info, "UPDATE embeddings SET vector = substr(vector, 1, ?) WHERE item_id = ? AND pillar = ?", (keep_bytes, item_id, pillar))


def replace_vector(info: BundleInfo, item_id: str, pillar: str, values: np.ndarray) -> None:
    values = np.asarray(values, dtype=np.float16)
    _sql(info, "UPDATE embeddings SET vector = ?, dim = ?, dtype = 'float16' WHERE item_id = ? AND pillar = ?", (values.tobytes(), int(values.shape[0]), item_id, pillar))


def set_feature_version(info: BundleInfo, item_id: str, pillar: str, version: str) -> None:
    _sql(info, "UPDATE embeddings SET feature_version = ? WHERE item_id = ? AND pillar = ?", (version, item_id, pillar))


def drop_vector(info: BundleInfo, item_id: str, pillar: str, *, record_error: Optional[str] = None) -> None:
    _sql(info, "DELETE FROM embeddings WHERE item_id = ? AND pillar = ?", (item_id, pillar))
    if record_error is not None:
        _sql(info, "INSERT OR REPLACE INTO feature_errors (item_id, pillar, attempts, error, updated_at) VALUES (?, ?, 3, ?, '2026-11-01T00:00:00+00:00')",
             (item_id, pillar, record_error))


def set_item_status(info: BundleInfo, item_id: str, status: str) -> None:
    _sql(info, "UPDATE items SET status = ? WHERE item_id = ?", (status, item_id))


def set_caption_status(info: BundleInfo, item_id: str, status: str, *, profile_json: Optional[str] = None) -> None:
    _sql(info, "UPDATE captions SET status = ?, profile_json = ? WHERE item_id = ?", (status, profile_json, item_id))


def set_product_id(info: BundleInfo, item_id: str, product_id: Optional[str]) -> None:
    _sql(info, "UPDATE items SET product_id = ?, product_id_raw = ? WHERE item_id = ?", (product_id, product_id, item_id))


# =====================================================================================================================================
# Stores and databases that record or fail on demand
# =====================================================================================================================================
class InjectedFailure(RuntimeError):
    pass


WRITE_METHODS = ("put_bytes", "put_file", "delete")


class RecordingStore:
    """Wraps a store and remembers every call, so a test can say "a dry run only read"."""

    def __init__(self, inner):
        self.inner = inner
        self.calls: List[tuple] = []

    def __getattr__(self, name):
        target = getattr(self.inner, name)
        if not callable(target):
            return target

        def call(*args, **kwargs):
            self.calls.append((name, args[0] if args else None))
            return target(*args, **kwargs)
        return call

    @property
    def writes(self) -> List[tuple]:
        return [call for call in self.calls if call[0] in WRITE_METHODS]

    def written_keys(self) -> List[str]:
        return [call[1] for call in self.writes]


class FlakyStore(RecordingStore):
    """Raises InjectedFailure instead of performing the Nth write (1-based), once. fail_on=None never fails."""

    def __init__(self, inner, fail_on: Optional[int]):
        super().__init__(inner)
        self.fail_on = fail_on
        self.write_count = 0

    def _maybe_fail(self, name, key):
        if name in WRITE_METHODS:
            self.write_count += 1
            if self.fail_on is not None and self.write_count == self.fail_on:
                raise InjectedFailure(f"injected failure on write number {self.write_count} ({name} {key})")

    def __getattr__(self, name):
        target = getattr(self.inner, name)
        if not callable(target):
            return target

        def call(*args, **kwargs):
            self._maybe_fail(name, args[0] if args else None)
            self.calls.append((name, args[0] if args else None))
            return target(*args, **kwargs)
        return call


class FlakyDb:
    """Wraps a database; the named method raises InjectedFailure the first time it is called (before doing anything)."""

    def __init__(self, inner, fail_in: Optional[str]):
        self.inner = inner
        self.fail_in = fail_in
        self.failed = False

    def __getattr__(self, name):
        target = getattr(self.inner, name)
        if not callable(target) or name != self.fail_in or self.failed:
            return target

        def call(*args, **kwargs):
            self.failed = True
            raise InjectedFailure(f"injected failure in {name}")
        return call


def new_environment(tmp_path: Path, catalogue: str = "superbond-colour", *, store_name: str = "store"):
    """(store, db) with the catalogue already created: a LocalObjectStore with the production prefix, and an in-memory database."""
    from terucon_catalogue.mongo import MemoryCatalogueDb
    from terucon_catalogue.objectstore import LocalObjectStore

    store = LocalObjectStore(tmp_path / store_name, prefix="catalogue/")
    db = MemoryCatalogueDb()
    db.upsert_catalogue(catalogue, name="Superbond colour")
    return store, db


def store_listing(store) -> Dict[str, str]:
    """{key: md5} of everything in the store: compare two of these to prove nothing changed."""
    return {key: store.md5_hex(key) for key in store.list("")}
