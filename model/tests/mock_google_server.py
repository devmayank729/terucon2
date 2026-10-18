#!/usr/bin/env python3
"""A fake Google as a standalone process, for trying the whole stack (website + model service) without credentials.

    python model/tests/mock_google_server.py [--port 0] [--jitter 14]

Prints ONE flushed line, then serves until it is killed (SIGTERM / SIGINT clean up the temp key):

    MOCK_GOOGLE_READY base=http://127.0.0.1:<port> sa=<path of a temp file holding a throw-away service-account key>

The key is generated here and its token_uri points at this mock, so the token endpoint really verifies the RS256 signature.
To use it, start the website and the model service with an explicit environment that contains

    GOOGLE_APPLICATION_CREDENTIALS=<sa path>       (or the file's text in GCP_SERVICE_ACCOUNT_JSON)
    TERUCON_ALLOW_CUSTOM_GOOGLE_ENDPOINTS=1        (otherwise the key's token_uri is refused: it is not googleapis.com)
    TERUCON_VERTEX_API_BASE=<base>

It answers like Gemini would for the synthetic room photo (dev_handler.make_handler): outlines for detection, a tinted copy of
the photo for a render, JSON for a quantity estimate. `GET <base>/__calls` lists what it was asked. A test rig, not a product feature.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import signal
import sys
import tempfile
import threading
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from dev_handler import make_handler  # noqa: E402
from mock_google import MockGoogle, make_service_account  # noqa: E402


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="A fake Google (token endpoint + Vertex generateContent) for the Terucon stack.")
    ap.add_argument("--port", type=int, default=0, help="port to listen on, 0 = any free port (default)")
    ap.add_argument("--jitter", type=float, default=14.0, help="how far the fake detection outlines drift from the true ones (0-1000 scale, default 14)")
    args = ap.parse_args(argv)

    info, public_key = make_service_account("placeholder")
    mock = MockGoogle(public_key)
    mock.start(args.port)
    info["token_uri"] = mock.token_url
    mock.default_handler = make_handler(args.jitter)

    tmp = Path(tempfile.mkdtemp(prefix="terucon-mock-google-"))
    sa_path = tmp / "service-account.json"
    sa_path.write_text(json.dumps(info), encoding="utf-8")
    os.chmod(sa_path, 0o600)

    done = threading.Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: done.set())
    print(f"MOCK_GOOGLE_READY base={mock.base} sa={sa_path}", flush=True)
    try:
        while not done.wait(0.5):
            pass
    finally:
        mock.stop()
        shutil.rmtree(tmp, ignore_errors=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
