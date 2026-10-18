"""The service as a real process: `python -m terucon_model` with cwd=model/, the way the website starts it.

Every child gets a fully explicit environment built here (never a copy of this process's), a temp TERUCON_ENV_FILE and
MODEL_PORT=0, so none of them can read the real .env or call the real Google. Not for Windows (signals): see the skips.
"""
from __future__ import annotations

import json
import os
import queue
import re
import signal
import socket
import subprocess
import sys
import threading
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

import support  # noqa: E402
from terucon_model.__main__ import pid_alive, watch_parent  # noqa: E402

MODEL_DIR = support.MODEL_DIR
READY = re.compile(r"^TERUCON_MODEL_READY (http://127\.0\.0\.1:[1-9][0-9]*)$")
STARTUP_TIMEOUT = 90  # importing numpy, OpenCV and Flask on a cold disk can take a while
POSIX = os.name == "posix"


def explicit_env(home: str, env_file: Path, **extra: str) -> dict[str, str]:
    """Everything the child gets. PATH (and SYSTEMROOT on Windows) only so the interpreter and its DLLs are found."""
    env = {
        "PATH": os.environ.get("PATH", ""),
        "HOME": home,
        "LANG": "C.UTF-8",
        "PYTHONUNBUFFERED": "1",
        "PYTHONDONTWRITEBYTECODE": "1",
        "TERUCON_ENV_FILE": str(env_file),
        "MODEL_HOST": "127.0.0.1",
        "MODEL_PORT": "0",
    }
    if os.name == "nt":
        env["SYSTEMROOT"] = os.environ.get("SYSTEMROOT", "")
    env.update(extra)
    return env


def http(url: str, key: str | None = None, host: str | None = None, method: str = "GET", body: bytes | None = None, timeout: float = 20):
    """(status, parsed JSON) of a real HTTP request; an HTTP error status is returned, not raised."""
    headers = {}
    if key is not None:
        headers["X-Terucon-Model-Key"] = key
    if host:
        headers["Host"] = host
    if body is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.load(r)
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"null")


class Service:
    """One `python -m terucon_model` child: stdout read by a thread, stderr to a file."""

    def __init__(self, case: unittest.TestCase, env_text: str = "", **env: str):
        self.case = case
        self.tmp = support.tempdir()
        case.addCleanup(self.tmp.cleanup)
        self.env_file = support.write_env(self.tmp.name, env_text)
        self.stderr_path = Path(self.tmp.name) / "stderr.log"
        self.env = explicit_env(self.tmp.name, self.env_file, **env)
        self.lines: list[str] = []
        self._queue: queue.Queue = queue.Queue()
        self.url = ""
        self.proc: subprocess.Popen | None = None
        case.addCleanup(self.kill)

    def start(self) -> "Service":
        self.proc = subprocess.Popen(
            [sys.executable, "-m", "terucon_model"], cwd=MODEL_DIR, env=self.env, stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE if getattr(self, "stderr_pipe", False) else open(self.stderr_path, "w"), text=True,
        )
        self._pump_thread = threading.Thread(target=self._pump, daemon=True)
        self._pump_thread.start()
        return self

    def _pump(self) -> None:
        for line in self.proc.stdout:  # type: ignore[union-attr]
            self.lines.append(line.rstrip("\n"))
            self._queue.put(line.rstrip("\n"))
        self._queue.put(None)

    def stderr(self) -> str:
        return self.stderr_path.read_text(encoding="utf-8", errors="replace") if self.stderr_path.exists() else ""

    def wait_ready(self, timeout: float = STARTUP_TIMEOUT) -> str:
        try:
            line = self._queue.get(timeout=timeout)
        except queue.Empty:
            self.case.fail(f"no READY line within {timeout}s. stderr:\n{self.stderr()[-2000:]}")
        if line is None:
            self.case.fail(f"the service exited (code {self.proc.wait()}) before printing READY. stderr:\n{self.stderr()[-2000:]}")  # type: ignore[union-attr]
        m = READY.match(line)
        self.case.assertIsNotNone(m, f"first stdout line is not the READY line: {line!r}")
        self.url = m.group(1)  # type: ignore[union-attr]
        return self.url

    def get(self, path: str, **kw):
        return http(self.url + path, **kw)

    def wait_exit(self, timeout: float) -> int:
        try:
            return self.proc.wait(timeout)  # type: ignore[union-attr]
        except subprocess.TimeoutExpired:
            self.case.fail(f"still running after {timeout}s. stderr:\n{self.stderr()[-2000:]}")

    def alive(self) -> bool:
        return self.proc is not None and self.proc.poll() is None

    def kill(self) -> None:
        if self.alive():
            self.proc.kill()  # type: ignore[union-attr]
            self.proc.wait(10)  # type: ignore[union-attr]
        if self.proc is not None and self.proc.stdout is not None:
            self._pump_thread.join(5)
            self.proc.stdout.close()


def refused(url: str) -> bool:
    try:
        urllib.request.urlopen(url, timeout=2)
    except urllib.error.HTTPError:
        return False  # it answered
    except (urllib.error.URLError, ConnectionError, socket.timeout, OSError):
        return True
    return False


class StartupTests(unittest.TestCase):
    def test_ready_line_then_health_over_http(self):
        s = Service(self).start()
        url = s.wait_ready()
        self.assertRegex(url, r"^http://127\.0\.0\.1:\d+$")
        status, h = s.get("/health")
        self.assertEqual(status, 200)
        self.assertEqual((h["ok"], h["service"]), (True, "terucon-model"))
        self.assertEqual(h["google"], {"configured": False, "mode": "none", "error": ""})
        self.assertEqual(h["sam"]["status"], "off")
        # other routes, over the wire: JSON errors, and the log noise stays off stdout
        self.assertEqual(s.get("/nowhere")[0], 404)
        self.assertEqual(s.get("/segment")[0], 405)
        self.assertEqual(s.get("/segment", method="POST", body=b"{}")[0], 503)  # Google is not configured in this env file
        self.assertEqual(s.lines, [f"TERUCON_MODEL_READY {url}"])  # exactly one stdout line, however many requests came after it
        self.assertIn("Terucon model service", s.stderr())
        self.assertIn(str(s.env_file), s.stderr())  # the banner says which settings file is in use

    @unittest.skipUnless(POSIX, "signals")
    def test_the_port_is_the_real_bound_port_not_the_requested_one(self):
        s = Service(self).start()
        url = s.wait_ready()
        port = int(url.rsplit(":", 1)[1])
        self.assertNotEqual(port, 0)
        with socket.create_connection(("127.0.0.1", port), timeout=5):
            pass

    def test_the_key_is_demanded_when_configured_and_the_host_is_checked_over_real_http(self):
        s = Service(self, MODEL_SERVICE_KEY="process-key").start()
        s.wait_ready()
        self.assertEqual(s.get("/health")[0], 401)
        self.assertEqual(s.get("/health", key="wrong")[0], 401)
        status, h = s.get("/health", key="process-key")
        self.assertEqual((status, h["service"]), (200, "terucon-model"))
        status, body = s.get("/health", key="process-key", host="evil.example.com")
        self.assertEqual((status, body["error"]["code"]), (421, 421))
        status, body = s.get("/health")
        self.assertEqual((status, body["error"]["status"]), (401, "UNAUTHENTICATED"))
        self.assertNotIn("process-key", json.dumps(body))
        self.assertNotIn("process-key", s.stderr())

    def test_the_env_file_is_the_one_named_by_TERUCON_ENV_FILE_and_it_is_re_read_while_running(self):
        s = Service(self, "GEMINI_API_KEY=abc\nEDGE_METHOD=watershed\n").start()
        s.wait_ready()
        _status, h = s.get("/health")
        self.assertEqual(h["google"], {"configured": True, "mode": "api-key", "error": ""})
        self.assertEqual(h["segmentation"]["edgeMethod"], "watershed")
        s.env_file.write_text("EDGE_METHOD=contour\nSEGMENTATION_ENGINE=sam\n", encoding="utf-8")
        _status, h = s.get("/health")
        self.assertEqual((h["google"]["configured"], h["segmentation"]["edgeMethod"], h["segmentation"]["engine"]), (False, "contour", "sam"))

    def test_nothing_from_the_parents_environment_reaches_the_child(self):
        # hard rule: a test must never be able to pick up real credentials. The parent has a Google key and a service key in
        # its environment; the child is given an explicit environment without either, so it must know of neither.
        with mock.patch.dict(os.environ, {"GEMINI_API_KEY": "leak", "GOOGLE_API_KEY": "leak", "MODEL_SERVICE_KEY": "leak", "SAM_ENABLED": "true", "EDGE_METHOD": "watershed"}):
            s = Service(self).start()
            s.wait_ready()
            status, h = s.get("/health")  # no key sent, none demanded
        self.assertEqual(status, 200, h)
        self.assertEqual(h["google"], {"configured": False, "mode": "none", "error": ""})
        self.assertEqual((h["sam"]["status"], h["segmentation"]["edgeMethod"]), ("off", "contour"))
        self.assertEqual(s.get("/health", key="leak")[0], 200)  # a key it does not have is not demanded, and sending one is harmless

    def test_what_the_test_does_give_the_child_is_used(self):
        s = Service(self, GEMINI_API_KEY="from-environment").start()
        s.wait_ready()
        self.assertEqual(s.get("/health")[1]["google"]["mode"], "api-key")

    def test_sam_loading_goes_on_in_the_background_and_does_not_hold_up_ready(self):
        # a remote SAM nobody listens to: the loader fails fast, the status says why, the service keeps serving
        dead = free_port()
        s = Service(self, SAM_ENABLED="true", SAM_BACKEND="remote", SAM_REMOTE_URL=f"http://127.0.0.1:{dead}/sam").start()
        s.wait_ready()
        status = {}
        for _ in range(100):
            _code, h = s.get("/health")
            status = h["sam"]
            if status["status"] == "error":
                break
            time.sleep(0.1)
        self.assertEqual(status["status"], "error", status)
        self.assertIn("Could not reach the remote SAM server", status["error"])
        self.assertEqual(s.get("/sam/health")[1]["status"], "error")
        self.assertEqual(s.get("/sam/refine", method="POST", body=b"{}")[0], 503)

    def test_a_busy_port_exits_with_1_and_no_ready_line(self):
        with socket.socket() as busy:
            busy.bind(("127.0.0.1", 0))
            busy.listen()
            s = Service(self, MODEL_PORT=str(busy.getsockname()[1])).start()
            code = s.wait_exit(STARTUP_TIMEOUT)
        self.assertEqual(code, 1)
        time.sleep(0.2)  # the pump thread has seen the end of stdout by now
        self.assertEqual(s.lines, [])
        self.assertIn("Could not start", s.stderr())


@unittest.skipUnless(POSIX, "SIGTERM / SIGINT semantics differ on Windows")
class ShutdownTests(unittest.TestCase):
    def test_sigterm_is_a_clean_exit_and_the_port_is_released(self):
        s = Service(self).start()
        url = s.wait_ready()
        s.proc.send_signal(signal.SIGTERM)
        self.assertEqual(s.wait_exit(15), 0, s.stderr()[-1500:])
        self.assertTrue(refused(url + "/health"))
        self.assertEqual(s.lines, [f"TERUCON_MODEL_READY {url}"])
        self.assertNotIn("Traceback", s.stderr())

    def test_sigint_is_a_clean_exit_too(self):
        s = Service(self).start()
        s.wait_ready()
        s.proc.send_signal(signal.SIGINT)
        self.assertEqual(s.wait_exit(15), 0, s.stderr()[-1500:])
        self.assertNotIn("Traceback", s.stderr())

    def test_a_request_in_flight_does_not_stop_it_from_exiting(self):
        s = Service(self).start()
        s.wait_ready()
        host, port = s.url[len("http://"):].split(":")
        with socket.create_connection((host, int(port)), timeout=5) as idle:  # a client that connects and then says nothing
            idle.sendall(b"GET /health HTTP/1.1\r\nHost: localhost\r\n")  # and never finishes its request line block
            time.sleep(0.2)
            s.proc.send_signal(signal.SIGTERM)
            self.assertEqual(s.wait_exit(15), 0, s.stderr()[-1500:])


class WatchdogTests(unittest.TestCase):
    """MODEL_PARENT_PID: the service leaves within a couple of seconds of that process disappearing."""

    EXIT_BUDGET = 6.0  # the aim is ~3 s; the extra is for a slow machine

    def dummy_parent(self) -> subprocess.Popen:
        p = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(600)"], stdin=subprocess.DEVNULL)
        self.addCleanup(lambda: (p.poll() is None and (p.kill(), p.wait())))
        return p

    def test_it_stays_while_the_parent_lives_and_leaves_soon_after_the_parent_is_killed(self):
        parent = self.dummy_parent()
        s = Service(self, MODEL_PARENT_PID=str(parent.pid)).start()
        s.wait_ready()
        time.sleep(2.5)  # more than two polls: a live parent must not trigger anything
        self.assertTrue(s.alive(), s.stderr()[-1500:])
        self.assertEqual(s.get("/health")[0], 200)
        parent.kill()
        parent.wait()  # reaped: the pid is really gone
        t0 = time.monotonic()
        code = s.wait_exit(self.EXIT_BUDGET + 4)
        took = time.monotonic() - t0
        self.assertEqual(code, 0, s.stderr()[-1500:])
        self.assertLess(took, self.EXIT_BUDGET, f"took {took:.1f}s to notice")
        self.assertIn("MODEL_PARENT_PID", s.stderr())
        print(f"\n  watchdog: service exited {took:.1f}s after its parent was killed", file=sys.stderr)

    def test_it_still_leaves_when_the_parent_died_and_took_the_stderr_pipe_with_it(self):
        """The website starts the service with stderr as a pipe. When the website is killed that pipe breaks, and the
        goodbye message must not stop the service from exiting."""
        parent = self.dummy_parent()
        s = Service(self, MODEL_PARENT_PID=str(parent.pid))
        s.stderr_pipe = True
        s.start()
        s.wait_ready()
        s.proc.stderr.close()  # nobody reads the pipe any more: the next write to it fails with EPIPE
        parent.kill()
        parent.wait()
        code = s.wait_exit(self.EXIT_BUDGET + 4)
        self.assertEqual(code, 0, "the service did not exit after its parent was killed")

    def test_a_parent_that_is_already_gone_at_startup_ends_the_service_too(self):
        parent = self.dummy_parent()
        parent.kill()
        parent.wait()
        s = Service(self, MODEL_PARENT_PID=str(parent.pid)).start()
        code = s.wait_exit(STARTUP_TIMEOUT)
        self.assertEqual(code, 0, s.stderr()[-1500:])

    @unittest.skipUnless(POSIX, "needs fork/exec semantics and signals")
    def test_a_parent_killed_with_sigkill_and_not_yet_reaped_still_counts_as_gone(self):
        """The real case: the website dies hard. Its pid stays visible as a zombie until its own parent reaps it, so
        kill(pid, 0) alone would say 'alive'; the service notices that it was re-parented instead."""
        launcher_code = (
            "import json, os, subprocess, sys, time\n"
            "env = dict(json.loads(sys.argv[1]), MODEL_PARENT_PID=str(os.getpid()))\n"
            "p = subprocess.Popen([sys.executable, '-m', 'terucon_model'], cwd=sys.argv[2], env=env, stdout=subprocess.PIPE, stderr=open(sys.argv[3], 'w'), text=True)\n"
            "print(p.stdout.readline().strip(), p.pid, flush=True)\n"
            "time.sleep(600)\n"
        )
        tmp = support.tempdir()
        self.addCleanup(tmp.cleanup)
        env = explicit_env(tmp.name, support.write_env(tmp.name, ""))
        launcher = subprocess.Popen([sys.executable, "-c", launcher_code, json.dumps(env), str(MODEL_DIR), str(Path(tmp.name) / "stderr.log")],
                                    stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, text=True)
        self.addCleanup(lambda: (launcher.poll() is None and launcher.kill(), launcher.wait()))
        line = launcher.stdout.readline().split()  # type: ignore[union-attr]
        self.assertEqual(len(line), 3, line)
        url, service_pid = line[1], int(line[2])
        self.addCleanup(lambda: _kill_quietly(service_pid))
        self.assertEqual(http(url + "/health")[0], 200)
        time.sleep(1.5)
        self.assertEqual(http(url + "/health")[0], 200)  # the launcher is alive: nothing happened
        launcher.kill()  # SIGKILL, and deliberately no wait(): the launcher is now a zombie of THIS process
        t0 = time.monotonic()
        while time.monotonic() - t0 < self.EXIT_BUDGET + 4:
            if refused(url + "/health"):
                break
            time.sleep(0.1)
        took = time.monotonic() - t0
        self.assertTrue(refused(url + "/health"), "the service is still answering after its parent was SIGKILLed")
        self.assertLess(took, self.EXIT_BUDGET, f"took {took:.1f}s")
        print(f"\n  watchdog (zombie parent): port closed {took:.1f}s after SIGKILL", file=sys.stderr)

    def test_pid_alive(self):
        self.assertTrue(pid_alive(os.getpid()))
        self.assertFalse(pid_alive(0))
        self.assertFalse(pid_alive(-5))
        p = self.dummy_parent()
        self.assertTrue(pid_alive(p.pid))
        p.kill()
        p.wait()
        self.assertFalse(pid_alive(p.pid))

    def test_watch_parent_calls_back_once_when_the_process_is_gone(self):
        p = self.dummy_parent()
        called = threading.Event()
        count = []
        watch_parent(p.pid, lambda: (count.append(1), called.set()), interval=0.05)
        self.assertFalse(called.wait(0.4))
        p.kill()
        p.wait()
        self.assertTrue(called.wait(5))
        time.sleep(0.3)
        self.assertEqual(len(count), 1)


def _kill_quietly(pid: int) -> None:
    try:
        os.kill(pid, signal.SIGKILL)
    except OSError:
        pass


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class MockGoogleProcess:
    """mock_google_server.py as a child: the line the website's end-to-end tests parse."""

    LINE = re.compile(r"^MOCK_GOOGLE_READY base=(http://127\.0\.0\.1:\d+) sa=(.+)$")

    def __init__(self, case: unittest.TestCase, *args: str):
        self.proc = subprocess.Popen([sys.executable, str(HERE / "mock_google_server.py"), *args], cwd=HERE, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                     stderr=subprocess.DEVNULL, text=True, env={"PATH": os.environ.get("PATH", ""), "PYTHONDONTWRITEBYTECODE": "1"})
        case.addCleanup(self.stop)
        self.line = self.proc.stdout.readline().rstrip("\n")  # type: ignore[union-attr]
        m = self.LINE.match(self.line)
        case.assertIsNotNone(m, f"unexpected first line from mock_google_server.py: {self.line!r}")
        self.base, self.sa = m.group(1), Path(m.group(2))  # type: ignore[union-attr]

    def stop(self) -> None:
        if self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(10)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait()
        if self.proc.stdout:
            self.proc.stdout.close()


class MockGoogleServerTests(unittest.TestCase):
    def test_ready_line_service_account_file_and_clean_exit(self):
        m = MockGoogleProcess(self)
        self.assertTrue(m.sa.is_file())
        info = json.loads(m.sa.read_text(encoding="utf-8"))
        self.assertEqual(info["type"], "service_account")
        self.assertEqual(info["token_uri"], m.base + "/token")
        self.assertIn("BEGIN PRIVATE KEY", info["private_key"])
        with urllib.request.urlopen(m.base + "/__calls", timeout=10) as r:
            self.assertEqual(json.load(r), {"generate": [], "tokens": 0})
        if POSIX:
            m.proc.send_signal(signal.SIGTERM)
            self.assertEqual(m.proc.wait(10), 0)
            self.assertFalse(m.sa.exists(), "the throw-away key must go with the process")
            self.assertEqual(m.proc.stdout.read(), "")  # type: ignore[union-attr]

    def test_port_and_jitter_options(self):
        port = free_port()
        m = MockGoogleProcess(self, "--port", str(port), "--jitter", "0")
        self.assertEqual(m.base, f"http://127.0.0.1:{port}")
        busy = subprocess.run([sys.executable, str(HERE / "mock_google_server.py"), "--port", str(port)], capture_output=True, text=True, timeout=60,
                              env={"PATH": os.environ.get("PATH", "")})
        self.assertNotEqual(busy.returncode, 0)  # the port is taken, so it says so instead of printing a READY line
        self.assertNotIn("MOCK_GOOGLE_READY", busy.stdout)
        help_ = subprocess.run([sys.executable, str(HERE / "mock_google_server.py"), "--help"], capture_output=True, text=True, timeout=60)
        self.assertIn("--jitter", help_.stdout)
        self.assertIn("--port", help_.stdout)


class EndToEndWithMockGoogleTests(unittest.TestCase):
    """The pair of processes the website's end-to-end tests will start: mock_google_server.py and the model service."""

    def scan(self, jitter: str):
        mock = MockGoogleProcess(self, "--port", "0", "--jitter", jitter)
        s = Service(
            self,
            GOOGLE_APPLICATION_CREDENTIALS=str(mock.sa),
            TERUCON_ALLOW_CUSTOM_GOOGLE_ENDPOINTS="1",
            TERUCON_VERTEX_API_BASE=mock.base,
        ).start()
        s.wait_ready()
        health = s.get("/health")[1]
        self.assertEqual(health["google"], {"configured": True, "mode": "vertex", "error": ""})
        photo = (HERE / "fixtures" / "room.jpg").read_bytes()
        import base64

        body = json.dumps({"image": base64.b64encode(photo).decode(), "options": {"useSam": False}}).encode()
        status, data = s.get("/segment", method="POST", body=body, timeout=120)
        self.assertEqual(status, 200, data)
        with urllib.request.urlopen(mock.base + "/__calls", timeout=10) as r:
            calls = json.load(r)
        return data, calls, s

    def test_a_scan_through_the_real_process_finds_the_eight_surfaces(self):
        data, calls, s = self.scan("14")
        self.assertEqual(sorted(m["label"] for m in data["metas"]), sorted(["Ceiling", "Back wall", "Left wall", "Right wall", "Floor", "Window", "Door", "Sofa"]))
        self.assertEqual((data["scene"], data["sam"]["used"]), ("interior", False))
        self.assertEqual(calls["tokens"], 1)  # one signed token request, then the token is reused
        self.assertEqual(len(calls["generate"]), 1)
        self.assertTrue(all("edges" in m["source"] for m in data["metas"]), data["metas"])
        self.assertEqual(s.lines, [f"TERUCON_MODEL_READY {s.url}"])  # a scan prints nothing to stdout; its log line is on stderr
        self.assertRegex(s.stderr(), r"segment 960x720  ok")

    def test_jitter_zero_gives_the_exact_outlines_and_the_result_is_about_as_good_as_it_gets(self):
        import base64
        import zlib

        import numpy as np
        import synthetic as syn

        data, _calls, _s = self.scan("0")
        _img, gt, labels = syn.build()
        lm = data["labelMap"]
        pred = np.frombuffer(zlib.decompress(base64.b64decode(lm["data"])), np.uint8).reshape(data["height"], data["width"])
        by_name = {m["label"]: m["index"] for m in data["metas"]}
        mean = np.mean([syn.iou(pred == by_name[name], gt == i) for i, name in enumerate(labels, start=1)])
        self.assertGreater(mean, 0.95, mean)


if __name__ == "__main__":
    unittest.main()
