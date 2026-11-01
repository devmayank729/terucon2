#!/usr/bin/env python3
"""Writes tests/fixtures/gcs-v4-vectors.json: Google V4 signed URLs made by Google's own SDK, as the oracle for server/catalogue/gcsSigner.js.

Why: the website signs Cloud Storage URLs with Node's crypto and nothing else, and nobody here can ask Google whether a signature is accepted.
What CAN be checked is that the website's output is byte for byte what Google's library produces for the same inputs. RSA PKCS#1 v1.5 with
SHA-256 has no randomness, so with a fixed key and a fixed clock the SDK's URLs are fixed, and tests/js/catalogue-signer.test.js must reproduce
every one of them exactly (including object names with spaces, unicode, slashes and the characters Python's quote() encodes and
JavaScript's encodeURIComponent does not: ! * ' ( ) ).

The key is a THROW-AWAY one that this script makes and keeps in the fixture (as base64 DER, not as a PEM, so that it protects nothing and
looks like nothing a secret scanner wants). Running the script again reuses it, so the file only changes when the vectors do; pass --new-key
for a fresh one. Nothing here talks to the network and nothing reads a real credential.

Run (from the project folder, with the Python that has google-cloud-storage and cryptography):
    <python> tests/fixtures/gen-gcs-v4-vectors.py
    <python> tests/fixtures/gen-gcs-v4-vectors.py --check     # fail if the committed file is not what the SDK makes now
"""
import base64
import datetime
import json
import pathlib
import sys

import google.auth
from cryptography import __version__ as cryptography_version
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from google.cloud import storage
from google.cloud.storage import _signing
from google.oauth2 import service_account

OUT = pathlib.Path(__file__).with_name("gcs-v4-vectors.json")
BUCKET = "terucon-test-bucket"
CLIENT_EMAIL = "catalogue-signer@terucon-test.iam.gserviceaccount.com"
T0 = datetime.datetime(2026, 11, 1, 12, 0, 0)

# (name, method, object name, expiry seconds, when, content type, extra headers). The object names include the prefix, as Google sees them.
VECTORS = [
    ("a thumbnail, one hour", "GET", "catalogue/thumbs/superbond-colour/a1b2c3d4e5f6-p0001-i00.jpg", 3600, T0, None, {}),
    ("a crop, one hour and a quarter (the window the site signs with)", "GET", "catalogue/crops/superbond-colour/a1b2c3d4e5f6-p0001-i00.png", 4500, T0, None, {}),
    ("the shortest life", "GET", "catalogue/thumbs/x/y.jpg", 1, T0, None, {}),
    ("the longest life, seven days", "GET", "catalogue/thumbs/x/y.jpg", 604800, T0, None, {}),
    ("a space and brackets", "GET", "catalogue/uploads/job-20261101120000-abc123/My File (1).pdf", 3600, T0, None, {}),
    ("the signs Python encodes and encodeURIComponent does not", "GET", "catalogue/uploads/j/a!b*c'd(e)f.pdf", 3600, T0, None, {}),
    ("the signs of a query string and a fragment", "GET", "catalogue/uploads/j/a+b&c=d?e#f%g,h;i:j@k$l.pdf", 3600, T0, None, {}),
    ("unicode and an emoji", "GET", "catalogue/uploads/j/Café – naïve 日本語 \U0001f9f1.pdf", 3600, T0, None, {}),
    ("a tilde, dots, dashes and underscores", "GET", "catalogue/uploads/j/~tilde_and-dash.v1.2.pdf", 3600, T0, None, {}),
    ("slashes are kept, even doubled", "GET", "catalogue/uploads/j//double/../x.pdf", 3600, T0, None, {}),
    ("a long name", "GET", "catalogue/uploads/j/" + "x" * 900 + ".pdf", 3600, T0, None, {}),
    ("no prefix at all", "GET", "plain.txt", 3600, T0, None, {}),
    ("a day that rolls over", "GET", "catalogue/thumbs/x/y.jpg", 3600, datetime.datetime(2026, 12, 31, 23, 59, 59), None, {}),
    ("a PDF upload, content type and size range", "PUT", "catalogue/uploads/job-20261101120000-abc123/catalogue.pdf", 7200, T0, "application/pdf", {"x-goog-content-length-range": "0,314572800"}),
    ("a photo upload with a space in its name", "PUT", "catalogue/uploads/job-20261101120000-abc123/living room 2.jpg", 7200, T0, "image/jpeg", {"x-goog-content-length-range": "0,26214400"}),
    ("an upload with a content type only", "PUT", "catalogue/uploads/j/a.webp", 600, T0, "image/webp", {}),
    ("header names in capitals and values with extra spaces", "PUT", "catalogue/uploads/j/b.png", 600, T0, "image/png", {"X-Goog-Meta-Note": "  two   spaces\t here ", "x-goog-content-length-range": "0,100"}),
]


def credentials(der: bytes):
    key = serialization.load_der_private_key(der, password=None)
    pem = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()).decode()
    info = {
        "type": "service_account",
        "project_id": "terucon-test",
        "private_key_id": "throwaway",
        "private_key": pem,
        "client_email": CLIENT_EMAIL,
        "token_uri": "https://oauth2.googleapis.com/token",
    }
    return service_account.Credentials.from_service_account_info(info)


def sdk_url(creds, name, method, object_name, expires, when, content_type, headers):
    """One URL from the SDK's public API (Blob.generate_signed_url, version v4), with the SDK's clock fixed to `when`."""
    client = storage.Client(project="terucon-test", credentials=creds)
    blob = client.bucket(BUCKET).blob(object_name)

    def fixed_now(tz=None):
        return when.replace(tzinfo=tz)

    original = _signing._NOW
    _signing._NOW = fixed_now  # the SDK imported _NOW by name, so this is the one it calls (not storage._helpers._NOW)
    try:
        return blob.generate_signed_url(
            version="v4",
            expiration=datetime.timedelta(seconds=expires),
            method=method,
            content_type=content_type,
            headers=dict(headers) or None,
        )
    finally:
        _signing._NOW = original


def build(der: bytes):
    creds = credentials(der)
    vectors = []
    for name, method, object_name, expires, when, content_type, headers in VECTORS:
        first = sdk_url(creds, name, method, object_name, expires, when, content_type, headers)
        second = sdk_url(creds, name, method, object_name, expires, when, content_type, headers)
        assert first == second, f"the SDK gave two different URLs for {name!r}: the clock patch does not hold"
        assert f"X-Goog-Date={when.strftime('%Y%m%dT%H%M%SZ')}" in first, f"the fixed clock was not used for {name!r}"
        vectors.append(
            {
                "name": name,
                "method": method,
                "objectName": object_name,
                "expiresS": expires,
                "nowMs": int(when.replace(tzinfo=datetime.timezone.utc).timestamp() * 1000),
                "contentType": content_type,
                "headers": headers,
                "url": first,
            }
        )
    return {
        "_comment": "Written by tests/fixtures/gen-gcs-v4-vectors.py from Google's own SDK; do not edit by hand. tests/js/catalogue-signer.test.js must reproduce every url byte for byte. The key is a throw-away one that protects nothing.",
        "generator": "tests/fixtures/gen-gcs-v4-vectors.py",
        "versions": {"google-cloud-storage": storage.__version__, "google-auth": google.auth.__version__, "cryptography": cryptography_version},
        "throwAwayKey": {"pkcs8DerBase64": base64.b64encode(der).decode(), "clientEmail": CLIENT_EMAIL},
        "bucket": BUCKET,
        "vectors": vectors,
    }


def main(argv):
    if OUT.exists() and "--new-key" not in argv:
        der = base64.b64decode(json.loads(OUT.read_text())["throwAwayKey"]["pkcs8DerBase64"])
    else:
        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        der = key.private_bytes(serialization.Encoding.DER, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
    text = json.dumps(build(der), indent=2) + "\n"
    if "--check" in argv:
        if OUT.read_text() != text:
            print(f"{OUT} is not what the SDK makes now: run the script without --check", file=sys.stderr)
            return 1
        print(f"{OUT.name} is what the SDK makes now ({len(VECTORS)} vectors)")
        return 0
    OUT.write_text(text)
    print(f"wrote {OUT} ({len(VECTORS)} vectors, google-cloud-storage {storage.__version__})")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
