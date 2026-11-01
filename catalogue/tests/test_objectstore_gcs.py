"""GcsObjectStore on the REAL google-cloud-storage client, with the HTTP transport replaced by FakeGcsHttp (tests/factories.py).

What this proves: the requests the SDK builds for our calls (ifGenerationMatch=0 for "create only if absent", resumable chunks for big files,
metadata-only lookups for size/md5) and how we map the SDK's errors. What it cannot prove: how Google's servers behave. That is
tests/test_live_contract.py, which the owner runs against a real bucket.
"""
import base64
import datetime
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path
from urllib.parse import parse_qs, quote, urlsplit

import pytest

from factories import (DISABLE_BUCKET_MD_ENV, make_gcs_store, object_store_contract, throwaway_public_key,
                       throwaway_service_account_info)
from terucon_catalogue import objectstore
from terucon_catalogue.objectstore import GcsObjectStore, InvalidKeyError, ObjectNotFoundError, StoreConfigError, object_store_from_env

ROOT = Path(__file__).resolve().parent.parent


@pytest.fixture(autouse=True)
def _no_background_bucket_lookup(monkeypatch):
    """google-cloud-storage 3.17.1 sends a background GET of the bucket's metadata (an observability feature); switch it off so request logs are exact."""
    monkeypatch.setenv(DISABLE_BUCKET_MD_ENV, "1")


@pytest.fixture(scope="module")
def key_pair():
    return throwaway_service_account_info(), throwaway_public_key()


# ----------------------------------------------------------------------------------------------------------------------- behaviour suite
def test_contract_on_the_real_sdk_over_a_fake_transport(tmp_path):
    store, fake = make_gcs_store(list_page_size=3)
    object_store_contract(store, tmp_path)
    assert fake.requests_seen, "the SDK must have used the fake transport"


# ----------------------------------------------------------------------------------------------------------------------- the wire
def _uploads(fake):
    return [r for r in fake.requests_seen if r.path.startswith("/upload/")]


def test_if_absent_sends_if_generation_match_zero_and_a_plain_write_does_not():
    store, fake = make_gcs_store()
    assert store.put_bytes("crops/c/a.png", b"first", "image/png", if_absent=True) is True
    assert store.put_bytes("crops/c/a.png", b"second", "image/png", if_absent=True) is False      # 412 from the (fake) server
    assert store.put_bytes("crops/c/a.png", b"third", "image/png") is True                         # unconditional overwrite
    posts = _uploads(fake)
    assert [r.method for r in posts] == ["POST", "POST", "POST"]
    assert [r.query.get("ifGenerationMatch") for r in posts] == ["0", "0", None]
    assert all(r.path == "/upload/storage/v1/b/test-bucket/o" and r.query["uploadType"] == "multipart" for r in posts)
    assert fake.objects["catalogue/crops/c/a.png"] == b"third"
    assert not [r for r in fake.requests_seen if r.method == "GET" and r.path.endswith("test-bucket")], "no bucket-level request"


def test_the_prefix_is_in_the_object_name_on_the_wire_and_not_in_listings():
    store, fake = make_gcs_store(prefix="catalogue/")
    store.put_bytes("crops/c/a.png", b"x")
    assert list(fake.objects) == ["catalogue/crops/c/a.png"]
    assert store.list("crops/") == ["crops/c/a.png"]
    other, other_fake = make_gcs_store(prefix="")
    other.put_bytes("crops/c/a.png", b"x")
    assert list(other_fake.objects) == ["crops/c/a.png"]


def test_content_type_is_sent_and_defaults_by_extension():
    store, fake = make_gcs_store()
    store.put_bytes("crops/c/a.png", b"x")
    store.put_bytes("releases/c/r/manifest.json", b"{}")
    store.put_bytes("releases/c/r/pillars/dino.npy", b"x")
    store.put_bytes("thumbs/c/a.jpg", b"x", "image/jpeg")
    store.put_bytes("odd", b"x", "text/plain")
    assert fake.content_types["catalogue/crops/c/a.png"] == "image/png"
    assert fake.content_types["catalogue/releases/c/r/manifest.json"] == "application/json"
    assert fake.content_types["catalogue/releases/c/r/pillars/dino.npy"] == "application/octet-stream"
    assert fake.content_types["catalogue/thumbs/c/a.jpg"] == "image/jpeg"
    assert fake.content_types["catalogue/odd"] == "text/plain"


def test_size_exists_and_md5_read_metadata_and_never_download():
    store, fake = make_gcs_store()
    store.put_bytes("crops/c/a.png", b"hello")
    fake.clear_log()
    assert store.size("crops/c/a.png") == 5 and store.exists("crops/c/a.png") and store.md5_hex("crops/c/a.png") == hashlib.md5(b"hello").hexdigest()
    assert store.size("crops/c/none.png") is None and store.md5_hex("crops/c/none.png") is None and not store.exists("crops/c/none.png")
    assert fake.requests_seen and all(r.method == "GET" and r.query.get("alt") != "media" for r in fake.requests_seen)


def test_listing_follows_pages():
    store, fake = make_gcs_store(list_page_size=2)
    for index in range(5):
        store.put_bytes(f"crops/c/{index}.png", b"x")
    store.put_bytes("thumbs/c/0.jpg", b"x")
    fake.clear_log()
    assert store.list("crops/") == [f"crops/c/{index}.png" for index in range(5)]
    pages = [r for r in fake.requests_seen if r.path == "/storage/v1/b/test-bucket/o"]
    assert len(pages) == 3 and all(r.query["maxResults"] == "2" and r.query["prefix"] == "catalogue/crops/" for r in pages)


def test_a_precondition_failure_is_only_swallowed_for_if_absent_and_other_errors_surface():
    from google.api_core import exceptions

    store, fake = make_gcs_store()
    store.put_bytes("a.bin", b"x")
    fake.fail_next.append(("POST", 403))
    with pytest.raises(exceptions.Forbidden):
        store.put_bytes("b.bin", b"x", if_absent=True)             # a permission problem is not "already there"
    fake.fail_next.append(("POST", 412))
    with pytest.raises(exceptions.PreconditionFailed):
        store.put_bytes("a.bin", b"y")                             # without if_absent a 412 is an error, not "skipped"
    assert store.get_bytes("a.bin") == b"x"


def test_download_of_a_missing_object_is_object_not_found_and_leaves_no_partial_file(tmp_path):
    store, _ = make_gcs_store()
    with pytest.raises(ObjectNotFoundError):
        store.get_bytes("nothing")
    with pytest.raises(ObjectNotFoundError):
        store.get_file("nothing", tmp_path / "x" / "out.bin")
    assert [p.name for p in (tmp_path / "x").iterdir()] == []


def test_invalid_keys_are_refused_before_any_request_is_sent():
    store, fake = make_gcs_store()
    for bad in ("../x", "/abs", "a//b", "a/", "", "a\x00b"):
        with pytest.raises(InvalidKeyError):
            store.put_bytes(bad, b"x", if_absent=True)
        with pytest.raises(InvalidKeyError):
            store.exists(bad)
    assert fake.requests_seen == []


def test_big_files_go_in_resumable_chunks_and_the_condition_is_on_the_first_request(tmp_path):
    big = tmp_path / "big.pdf"
    data = os.urandom(20 * 1024 * 1024 + 17)
    big.write_bytes(data)
    store, fake = make_gcs_store()
    assert store.put_file("sources/" + "a" * 64 + "/big.pdf", big, "application/pdf", if_absent=True) is True
    assert fake.objects["catalogue/sources/" + "a" * 64 + "/big.pdf"] == data
    requests_made = _uploads(fake)
    init, chunks = requests_made[0], requests_made[1:]
    assert init.method == "POST" and init.query["uploadType"] == "resumable" and init.query["ifGenerationMatch"] == "0"
    assert [c.method for c in chunks] == ["PUT", "PUT", "PUT"]
    assert [c.headers["content-range"] for c in chunks] == [
        f"bytes 0-8388607/{len(data)}", f"bytes 8388608-16777215/{len(data)}", f"bytes 16777216-{len(data) - 1}/{len(data)}"]
    assert all("ifGenerationMatch" not in c.query for c in chunks)

    fake.clear_log()
    assert store.put_file("sources/" + "a" * 64 + "/big.pdf", big, "application/pdf", if_absent=True) is False
    after = _uploads(fake)
    assert len(after) == 1 and after[0].query["ifGenerationMatch"] == "0", "refused at the start: no chunk of a 20 MB file is sent"

    fake.clear_log()
    assert store.put_file("sources/" + "a" * 64 + "/big.pdf", big, "application/pdf") is True
    assert "ifGenerationMatch" not in _uploads(fake)[0].query


def test_small_files_use_one_multipart_request(tmp_path):
    small = tmp_path / "small.png"
    small.write_bytes(b"\x89PNG" + b"0" * 1000)
    store, fake = make_gcs_store()
    assert store.put_file("crops/c/a.png", small, if_absent=True) is True
    assert [(r.method, r.query["uploadType"]) for r in _uploads(fake)] == [("POST", "multipart")]
    assert fake.content_types["catalogue/crops/c/a.png"] == "image/png"


# -------------------------------------------------------------------------------------------------------------------------- construction
def test_construction_is_lazy_no_google_import_no_network():
    code = ("import sys\n"
            "from terucon_catalogue.objectstore import GcsObjectStore\n"
            "store = GcsObjectStore('a-bucket', 'catalogue/', {'project_id': 'p'})\n"
            "print('LOADED', [m for m in sys.modules if m.startswith(('google.cloud', 'requests', 'urllib3'))])\n")
    result = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, cwd=ROOT)
    assert result.returncode == 0, result.stderr
    assert "LOADED []" in result.stdout, result.stdout


def test_the_client_is_built_from_the_service_account_on_first_use(key_pair):
    info, _ = key_pair
    store = GcsObjectStore("a-bucket", "catalogue/", info)
    assert store._client is None
    client = store.client
    assert client.project == "throwaway-project" and store.client is client
    assert client._credentials.service_account_email == info["client_email"]


def test_bad_construction_is_explained():
    with pytest.raises(StoreConfigError, match="bucket name is empty"):
        GcsObjectStore("", "p/", {"project_id": "x"})
    with pytest.raises(StoreConfigError, match="not a bucket name"):
        GcsObjectStore("gs://bucket/path", "p/", {"project_id": "x"})
    with pytest.raises(StoreConfigError, match="service-account key"):
        GcsObjectStore("bucket", "p/")


def test_from_env_builds_a_gcs_store_with_the_default_prefix_and_no_network(key_pair):
    info, _ = key_pair
    store = object_store_from_env({"CATALOGUE_GCS_BUCKET": " my-bucket ", "GCP_SERVICE_ACCOUNT_JSON": json.dumps(info)})
    assert isinstance(store, GcsObjectStore) and store.bucket_name == "my-bucket" and store.prefix == "catalogue/" and store._client is None
    store = object_store_from_env({"CATALOGUE_GCS_BUCKET": "b", "CATALOGUE_GCS_PREFIX": "other", "GCP_SERVICE_ACCOUNT_JSON": json.dumps(info)})
    assert store.prefix == "other/"


def test_from_env_reads_the_key_file_named_by_google_application_credentials(tmp_path, key_pair):
    info, _ = key_pair
    key_file = tmp_path / "key.json"
    key_file.write_text(json.dumps(info))
    store = object_store_from_env({"CATALOGUE_GCS_BUCKET": "b", "GOOGLE_APPLICATION_CREDENTIALS": str(key_file)})
    assert isinstance(store, GcsObjectStore)
    assert info["private_key"] not in repr(store) and info["private_key"] not in store.describe()


# ------------------------------------------------------------------------------------------------------------------------- signed URLs
def _canonical_query(params):
    return "&".join(f"{quote(k, safe='-_.~')}={quote(v, safe='-_.~')}" for k, v in sorted(params.items()))


def test_v4_signed_url_has_the_documented_structure_and_the_signature_matches_the_key(key_pair):
    """Structure per Google's V4 signing documentation; the RSA signature is checked against the throw-away key's public half over the string
    to sign built from the URL's own parameters. NOT verified here: that Google accepts it (needs a real service account and bucket)."""
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.asymmetric import padding

    info, public_key = key_pair
    store = GcsObjectStore("my-bucket", "catalogue/", info)
    before = datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0)
    url = store.signed_get_url("crops/cat one/a b.png", expires_s=3600)
    after = datetime.datetime.now(datetime.timezone.utc)

    parts = urlsplit(url)
    assert parts.scheme == "https" and parts.netloc == "storage.googleapis.com"
    assert parts.path == "/my-bucket/catalogue/crops/cat%20one/a%20b.png"
    query = {k: v[0] for k, v in parse_qs(parts.query).items()}
    assert set(query) == {"X-Goog-Algorithm", "X-Goog-Credential", "X-Goog-Date", "X-Goog-Expires", "X-Goog-SignedHeaders", "X-Goog-Signature"}
    assert query["X-Goog-Algorithm"] == "GOOG4-RSA-SHA256" and query["X-Goog-Expires"] == "3600" and query["X-Goog-SignedHeaders"] == "host"
    stamp = datetime.datetime.strptime(query["X-Goog-Date"], "%Y%m%dT%H%M%SZ").replace(tzinfo=datetime.timezone.utc)
    assert before - datetime.timedelta(seconds=2) <= stamp <= after + datetime.timedelta(seconds=2)
    scope = f"{query['X-Goog-Date'][:8]}/auto/storage/goog4_request"
    assert query["X-Goog-Credential"] == f"{info['client_email']}/{scope}"
    assert len(query["X-Goog-Signature"]) == 512 and all(c in "0123456789abcdef" for c in query["X-Goog-Signature"])

    unsigned = {k: v for k, v in query.items() if k != "X-Goog-Signature"}
    canonical_request = "\n".join(["GET", parts.path, _canonical_query(unsigned), "host:storage.googleapis.com\n", "host", "UNSIGNED-PAYLOAD"])
    string_to_sign = "\n".join(["GOOG4-RSA-SHA256", query["X-Goog-Date"], scope, hashlib.sha256(canonical_request.encode()).hexdigest()])
    public_key.verify(bytes.fromhex(query["X-Goog-Signature"]), string_to_sign.encode(), padding.PKCS1v15(), hashes.SHA256())   # raises if wrong


def test_signed_url_expiry_is_the_one_asked_for(key_pair):
    info, _ = key_pair
    store = GcsObjectStore("my-bucket", "", info)
    query = parse_qs(urlsplit(store.signed_get_url("a.png", expires_s=60)).query)
    assert query["X-Goog-Expires"] == ["60"]
    query = parse_qs(urlsplit(store.signed_get_url("a.png", expires_s=7 * 24 * 3600)).query)
    assert query["X-Goog-Expires"] == [str(7 * 24 * 3600)]
    assert urlsplit(store.signed_get_url("a.png")).path == "/my-bucket/a.png"


def test_the_private_key_never_appears_in_errors_or_reprs(key_pair):
    info, _ = key_pair
    store = GcsObjectStore("my-bucket", "catalogue/", info)
    assert info["private_key"] not in repr(store) and "BEGIN PRIVATE KEY" not in repr(store) and "BEGIN PRIVATE KEY" not in store.describe()
