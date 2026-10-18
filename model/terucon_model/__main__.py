"""python -m terucon_model   (run it from the model/ folder; the website does that for you)

Binds first, then prints one line to stdout, flushed, so whoever started us knows the real port:

    TERUCON_MODEL_READY http://127.0.0.1:<port>

Everything else (the human banner, the per-call logs) goes to stderr. SIGTERM and SIGINT shut it down cleanly. When
MODEL_PARENT_PID names a process, we exit within a couple of seconds of that process disappearing, so a website that
was killed hard (kill -9) never leaves a model service behind.
"""
from __future__ import annotations

import logging
import os
import signal
import sys
import threading
import time
from pathlib import Path
from typing import Callable, TextIO

from . import __version__
from .app import create_app
from .config import load_settings

PARENT_POLL_SECONDS = 1.0
EXIT_GRACE_SECONDS = 1.5  # after asking for a clean stop, how long before we leave regardless


def pid_alive(pid: int) -> bool:
    """Is there a process with this id? (Not os.kill(pid, 0) on Windows: there any signal number kills the process.)"""
    if pid <= 0:
        return False
    if os.name == "nt":
        import ctypes

        kernel32 = ctypes.windll.kernel32  # type: ignore[attr-defined]
        handle = kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not handle:
            return False
        try:
            code = ctypes.c_ulong()
            return bool(kernel32.GetExitCodeProcess(handle, ctypes.byref(code))) and code.value == 259  # STILL_ACTIVE
        finally:
            kernel32.CloseHandle(handle)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True  # it exists, it is just not ours
    except OSError:
        return True
    return True


def watch_parent(pid: int, on_gone: Callable[[], None], interval: float = PARENT_POLL_SECONDS) -> threading.Thread:
    """Call `on_gone` once, from a daemon thread, when process `pid` no longer exists."""
    started_under = os.getppid() if os.name == "posix" else None

    def loop() -> None:
        while True:
            time.sleep(interval)
            gone = not pid_alive(pid)
            # A parent that died but has not been reaped yet still answers kill(pid, 0). Its children are re-parented the
            # moment it exits, though, so a changed parent id means the same thing.
            if not gone and started_under == pid and os.getppid() != pid:
                gone = True
            if gone:
                on_gone()
                return

    t = threading.Thread(target=loop, name="parent-watchdog", daemon=True)
    t.start()
    return t


def _listen_url(server) -> str:
    host, port = server.server_address[0], server.server_address[1]
    if host in ("0.0.0.0", ""):
        host = "127.0.0.1"
    elif host == "::":
        host = "::1"
    return f"http://[{host}]:{port}" if ":" in host else f"http://{host}:{port}"


def serve(
    env_path: str | Path | None = None,
    environ: dict[str, str] | None = None,
    sam_manager=None,
    stop: threading.Event | None = None,
    out: TextIO | None = None,
    install_signals: bool = True,
) -> int:
    """Run the service until SIGTERM/SIGINT (or `stop` is set, or the parent process disappears). Returns the exit code.

    `env_path`/`environ` are for tests; leave them out and the file is TERUCON_ENV_FILE or ROOT/.env and the real
    environment applies. `out` is where the READY line goes (stdout)."""
    from werkzeug.serving import make_server

    out = out or sys.stdout
    stop = stop or threading.Event()
    settings = load_settings(env_path, environ)
    app = create_app(env_path, environ, sam_manager)

    shown = "localhost" if settings.model_host in ("127.0.0.1", "::1") else settings.model_host
    print(f"\nTerucon model service {__version__}", file=sys.stderr)
    print(f"  Settings file:  {settings.env_path}  ({'found' if settings.env_file_found else 'NOT FOUND - copy .env.example to .env'})", file=sys.stderr)
    for line in settings.describe():
        print("  " + line, file=sys.stderr)
    for warning in settings.warnings:
        print("  ! " + warning, file=sys.stderr)
    where = f"{shown}:{settings.model_port}" if settings.model_port else f"a free port on {shown}"
    print(f"  Listening on:   {where}" + ("  (requests need the service key)" if settings.service_key else ""), file=sys.stderr)
    if settings.model_host not in ("127.0.0.1", "::1", "localhost") and not settings.service_key:
        print("  ! MODEL_HOST makes this service reachable from your network and MODEL_SERVICE_KEY is not set. Anyone who can reach it can use your Google credentials.", file=sys.stderr)

    try:
        server = make_server(settings.model_host, settings.model_port, app, threaded=True)
    except (OSError, SystemExit):  # werkzeug prints its own advice to stderr and then raises SystemExit(1) for a port in use
        print(f"Could not start on {settings.model_host}:{settings.model_port}. Change MODEL_HOST / MODEL_PORT (0 picks a free port) and try again.", file=sys.stderr)
        return 1

    def request_stop(*_args) -> None:
        if stop.is_set():  # a second Ctrl+C / SIGTERM: stop waiting for the clean shutdown
            os._exit(1)
        stop.set()

    if install_signals and threading.current_thread() is threading.main_thread():
        signal.signal(signal.SIGINT, request_stop)
        signal.signal(signal.SIGTERM, request_stop)

    if settings.parent_pid:
        def parent_gone() -> None:
            stop.set()  # first: when the website was killed our stderr pipe is broken, and the message below may not be writable
            try:
                print(f"Process {settings.parent_pid} (MODEL_PARENT_PID) is gone; stopping.", file=sys.stderr, flush=True)
            except OSError:
                pass
            time.sleep(EXIT_GRACE_SECONDS)
            os._exit(0)  # the clean shutdown below did not finish in time

        watch_parent(settings.parent_pid, parent_gone)

    thread = threading.Thread(target=lambda: server.serve_forever(poll_interval=0.2), name="http", daemon=True)
    thread.start()
    print(f"TERUCON_MODEL_READY {_listen_url(server)}", file=out, flush=True)
    print("  Press Ctrl+C to stop.\n", file=sys.stderr, flush=True)
    try:
        while not stop.wait(0.5):  # not a bare wait(): on Windows that cannot be interrupted by Ctrl+C
            pass
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
    return 0


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(message)s", datefmt="%H:%M:%S", stream=sys.stderr)
    logging.getLogger("werkzeug").setLevel(logging.ERROR)  # our own one-line logs say more than the access log
    return serve()


if __name__ == "__main__":
    sys.exit(main())
