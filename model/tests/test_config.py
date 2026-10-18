"""EnvFile + Settings of the model service.

The .env cases are not written here: they come from tests/fixtures/env-cases.json, the file the website's JavaScript
settings tests run too, so the two parsers cannot drift apart unnoticed. The rest are the things only this side has:
where the env file is, the MODEL_* variables, and the old tests the fixture does not cover.
"""
from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

import support  # noqa: E402
from mock_google import make_service_account  # noqa: E402
from terucon_model import config  # noqa: E402
from terucon_model.config import SettingsManager, load_settings, resolve_env_path  # noqa: E402
from terucon_model.envfile import parse_env  # noqa: E402

FIXTURE = support.ROOT / "tests" / "fixtures" / "env-cases.json"
CASES = json.loads(FIXTURE.read_text(encoding="utf-8"))


def view(s: config.Settings) -> dict:
    """Settings as the fixture's normalised view (see the fixture's _comment)."""
    g = s.google
    return {
        "google": {"mode": g.mode, "configured": g.configured, "projectId": g.project_id, "location": g.location, "clientEmail": g.client_email, "error": g.error, "hasApiKey": bool(g.api_key)},
        "models": dict(s.models),
        "segmentation": {"engine": s.segmentation_engine, "edgeRefine": s.edge_refine, "edgeMethod": s.edge_method, "analysisMaxSide": s.analysis_max_side},
        "sam": {"enabled": s.sam.enabled, "backend": s.sam.backend, "modelId": s.sam.model_id, "maxSide": s.sam.max_side, "preload": s.sam.preload, "hasServerKey": bool(s.sam.server_key), "remoteUrl": s.sam.remote_url},
        "warnings": list(s.warnings),
    }


def lookup(tree: dict, dotted: str):
    node = tree
    for part in dotted.split("."):
        node = node[part]
    return node


class FixtureTests(unittest.TestCase):
    def test_the_fixture_is_there_and_is_not_empty(self):
        self.assertGreater(len(CASES["parse"]), 4)
        self.assertGreater(len(CASES["settings"]), 25)

    def test_parse_cases(self):
        for case in CASES["parse"]:
            with self.subTest(case["name"]):
                self.assertEqual(parse_env(case["text"]), case["expect"])  # the whole dict: a skipped bad line must not appear

    def test_settings_cases(self):
        for case in CASES["settings"]:
            with self.subTest(case["name"]), support.tempdir() as d:
                env_path = support.write_env(d, case["envFile"])
                s = load_settings(env_path, environ=dict(case.get("environ", {})))
                v = view(s)
                for path, want in case["expect"].items():
                    got = lookup(v, path)
                    if isinstance(want, dict) and "contains" in want:
                        self.assertIn(want["contains"], got, path)
                    elif isinstance(want, dict) and "anyContains" in want:
                        self.assertTrue(any(want["anyContains"] in w for w in got), f"{path}: {got}")
                    else:
                        self.assertEqual(got, want, path)

    def test_every_case_runs_without_the_real_process_environment(self):
        # the fixture's `environ` replaces os.environ completely; a variable in this process must not change any case
        with mock.patch.dict("os.environ", {"GEMINI_API_KEY": "leak", "SAM_ENABLED": "true", "EDGE_METHOD": "watershed", "MODEL_SERVICE_KEY": "leak"}):
            for case in CASES["settings"]:
                with self.subTest(case["name"]), support.tempdir() as d:
                    s = load_settings(support.write_env(d, case["envFile"]), environ=dict(case.get("environ", {})))
                    self.assertNotEqual(s.google.api_key, "leak")
                    self.assertEqual(s.service_key, "")


class EnvFileTests(unittest.TestCase):
    """The two EnvFileTests of the old suite, which the fixture's first two parse cases express as data."""

    def test_forms_people_paste(self):
        r = parse_env("# c\nA=1\nexport B = two words  # note\nC=\"x\\ny\"\nD='{\"k\":\"v\\n\"}'\nE=\nF=a#b\nM='a\nb'\nH=1\nH=2\n")
        self.assertEqual(r["B"], "two words")
        self.assertEqual(r["D"], '{"k":"v\\n"}')  # single quotes are literal
        self.assertEqual(r["F"], "a#b")  # '#' without a space before it is part of the value
        self.assertEqual(r["H"], "2")  # last wins

    def test_crlf_and_bom(self):
        self.assertEqual(parse_env("﻿A=1\r\nB=2\r\n"), {"A": "1", "B": "2"})

    def test_a_missing_file_is_an_empty_environment_not_an_error(self):
        with support.tempdir() as d:
            self.assertEqual(config.load_env_file(Path(d) / "nope.env"), {})


class SettingsTests(unittest.TestCase):
    """The old SettingsTests the fixture covers are not repeated; these are the ones it cannot express."""

    def setUp(self):
        self.info, _ = make_service_account("https://oauth2.googleapis.com/token", "my-project-123")
        self.tmp = support.tempdir()
        self.addCleanup(self.tmp.cleanup)

    def settings(self, text: str, **env):
        return load_settings(support.write_env(self.tmp.name, text), environ={**parse_env(text), **env})

    def test_a_real_generated_key_is_accepted_as_it_is(self):
        s = self.settings(f"GCP_SERVICE_ACCOUNT_JSON='{json.dumps(self.info)}'\n")
        self.assertEqual((s.google.mode, s.google.project_id, s.google.client_email, s.google.error), ("vertex", "my-project-123", self.info["client_email"], ""))

    def test_a_key_file_named_by_GOOGLE_APPLICATION_CREDENTIALS_is_read(self):
        key = Path(self.tmp.name) / "sa.json"
        key.write_text(json.dumps(self.info), encoding="utf-8")
        s = self.settings("", GOOGLE_APPLICATION_CREDENTIALS=str(key))
        self.assertEqual(s.google.mode, "vertex")
        self.assertEqual(s.google.service_account_source, "file sa.json")

    def test_a_relative_key_file_is_relative_to_the_project_root(self):
        with mock.patch.object(config, "ROOT", Path(self.tmp.name)):
            (Path(self.tmp.name) / "keys").mkdir()
            (Path(self.tmp.name) / "keys" / "sa.json").write_text(json.dumps(self.info), encoding="utf-8")
            s = self.settings("", GOOGLE_APPLICATION_CREDENTIALS="keys/sa.json")
        self.assertEqual(s.google.mode, "vertex")

    def test_an_unreadable_key_file_is_a_readable_error(self):
        s = self.settings("", GOOGLE_APPLICATION_CREDENTIALS=str(Path(self.tmp.name) / "missing.json"))
        self.assertFalse(s.google.configured)
        self.assertIn("could not be read", s.google.error)

    def test_nothing_set_is_not_configured_and_says_so_without_a_secret(self):
        s = self.settings("")
        self.assertFalse(s.google.configured)
        self.assertEqual(s.google.mode, "none")
        self.assertTrue(any("not configured" in line for line in s.describe()))

    def test_describe_and_warnings_never_contain_secrets(self):
        s = self.settings(f"GCP_SERVICE_ACCOUNT_JSON='{json.dumps(self.info)}'\nGEMINI_API_KEY=SECRETKEY999\nSAM_SERVER_KEY=SAMSECRET777\nMODEL_SERVICE_KEY=MODELSECRET555\n")
        dumped = "\n".join(s.describe() + s.warnings)
        for secret in ("SECRETKEY999", "SAMSECRET777", "MODELSECRET555", "BEGIN PRIVATE KEY", self.info["private_key_id"]):
            self.assertNotIn(secret, dumped)

    def test_custom_google_endpoints_are_ignored_unless_allowed(self):
        s = self.settings("TERUCON_VERTEX_API_BASE=http://127.0.0.1:9/\n")
        self.assertEqual(s.vertex_api_base, "")
        s = self.settings("TERUCON_ALLOW_CUSTOM_GOOGLE_ENDPOINTS=1\nTERUCON_VERTEX_API_BASE=http://127.0.0.1:9/\n")
        self.assertEqual(s.vertex_api_base, "http://127.0.0.1:9")  # the trailing slash is dropped

    def test_the_old_web_server_settings_are_gone(self):
        s = self.settings("HOST=0.0.0.0\nPORT=9999\n")
        self.assertFalse(hasattr(s, "host") or hasattr(s, "port") or hasattr(s, "public"))
        self.assertEqual((s.model_host, s.model_port), ("127.0.0.1", 8081))  # HOST and PORT are the website's, not ours


class ServiceSettingsTests(unittest.TestCase):
    def settings(self, text: str = "", **env):
        with support.tempdir() as d:
            return load_settings(support.write_env(d, text), environ=env)

    def test_defaults(self):
        s = self.settings()
        self.assertEqual((s.model_host, s.model_port, s.service_key, s.parent_pid, s.allowed_hosts), ("127.0.0.1", 8081, "", 0, ()))

    def test_model_port_zero_means_any_free_port(self):
        self.assertEqual(self.settings(MODEL_PORT="0").model_port, 0)

    def test_model_port_is_clamped_and_garbage_falls_back(self):
        self.assertEqual(self.settings(MODEL_PORT="99999").model_port, 65535)
        self.assertEqual(self.settings(MODEL_PORT="-5").model_port, 0)
        self.assertEqual(self.settings(MODEL_PORT="eight").model_port, 8081)
        self.assertEqual(self.settings(MODEL_PORT="").model_port, 8081)

    def test_model_host_key_parent_and_allowed_hosts(self):
        s = self.settings(MODEL_HOST="0.0.0.0", MODEL_SERVICE_KEY=" k3y ", MODEL_PARENT_PID="4242", ALLOWED_HOSTS="Gpu.example.com, 10.0.0.5:8081 ,")
        self.assertEqual(s.model_host, "0.0.0.0")
        self.assertEqual(s.service_key, "k3y")
        self.assertEqual(s.parent_pid, 4242)
        self.assertEqual(s.allowed_hosts, ("gpu.example.com", "10.0.0.5:8081"))

    def test_an_unusable_parent_pid_means_no_watchdog(self):
        self.assertEqual(self.settings(MODEL_PARENT_PID="not a pid").parent_pid, 0)
        self.assertEqual(self.settings(MODEL_PARENT_PID="-1").parent_pid, 0)

    def test_the_service_settings_can_come_from_the_file_but_the_environment_wins(self):
        s = self.settings("MODEL_PORT=9001\nMODEL_SERVICE_KEY=from-file\n", MODEL_SERVICE_KEY="from-env")
        self.assertEqual((s.model_port, s.service_key), (9001, "from-env"))


class EnvFilePathTests(unittest.TestCase):
    """TERUCON_ENV_FILE: absolute, or relative to the project root; the default is ROOT/.env. Only paths are computed here."""

    def test_the_project_root_is_the_folder_above_model(self):
        self.assertEqual(config.ROOT, config.MODEL_DIR.parent)
        self.assertTrue((config.MODEL_DIR / "terucon_model").is_dir())
        self.assertEqual(config.MODEL_DIR.name, "model")

    def test_default_is_root_dot_env(self):
        self.assertEqual(resolve_env_path(None, {}), config.ROOT / ".env")

    def test_an_explicit_argument_wins_over_the_variable(self):
        self.assertEqual(resolve_env_path("/x/explicit.env", {"TERUCON_ENV_FILE": "/y/other.env"}), Path("/x/explicit.env"))

    def test_an_absolute_variable_is_used_as_it_is(self):
        self.assertEqual(resolve_env_path(None, {"TERUCON_ENV_FILE": "/srv/terucon/prod.env"}), Path("/srv/terucon/prod.env"))

    def test_a_relative_variable_is_relative_to_the_project_root_not_the_working_directory(self):
        self.assertEqual(resolve_env_path(None, {"TERUCON_ENV_FILE": "config/dev.env"}), config.ROOT / "config" / "dev.env")

    def test_a_blank_variable_means_the_default(self):
        self.assertEqual(resolve_env_path(None, {"TERUCON_ENV_FILE": "  "}), config.ROOT / ".env")

    def test_without_an_explicit_environ_the_process_environment_is_consulted(self):
        with mock.patch.dict("os.environ", {"TERUCON_ENV_FILE": "/from/process.env"}):
            self.assertEqual(resolve_env_path(None, None), Path("/from/process.env"))
            self.assertEqual(resolve_env_path(None, {}), config.ROOT / ".env")  # an explicit environ never looks at os.environ

    def test_settings_are_read_from_the_file_the_variable_names(self):
        with support.tempdir() as d:
            env = Path(d) / "elsewhere.env"
            env.write_text("EDGE_METHOD=watershed\n", encoding="utf-8")
            s = load_settings(None, environ={"TERUCON_ENV_FILE": str(env)})
            self.assertEqual(s.env_path, env)
            self.assertTrue(s.env_file_found)
            self.assertEqual(s.edge_method, "watershed")

    def test_the_real_env_file_is_off_limits_to_the_tests(self):
        with self.assertRaises(AssertionError):
            load_settings(None, environ={})  # would read ROOT/.env: support.py turns that into a failure instead


class SettingsManagerTests(unittest.TestCase):
    def test_editing_the_file_is_picked_up_and_bumps_the_version(self):
        with support.tempdir() as d:
            env = support.write_env(d, "")
            m = SettingsManager(env, {"HOME": d})
            self.assertFalse(m.get().google.configured)
            version = m.version
            env.write_text("GEMINI_API_KEY=abc\n", encoding="utf-8")
            self.assertTrue(m.get().google.configured)
            self.assertGreater(m.version, version)
            self.assertEqual(m.get().google.mode, "api-key")

    def test_an_unchanged_file_is_not_parsed_again(self):
        with support.tempdir() as d:
            m = SettingsManager(support.write_env(d, "GEMINI_API_KEY=abc\n"), {"HOME": d})
            first = m.get()
            self.assertIs(m.get(), first)

    def test_a_deleted_file_falls_back_to_the_environment_alone(self):
        with support.tempdir() as d:
            env = support.write_env(d, "GEMINI_API_KEY=abc\n")
            m = SettingsManager(env, {"HOME": d})
            self.assertTrue(m.get().google.configured)
            env.unlink()
            self.assertFalse(m.get().google.configured)

    def test_the_environment_given_at_the_start_keeps_winning_after_a_reload(self):
        with support.tempdir() as d:
            env = support.write_env(d, "EDGE_METHOD=contour\n")
            m = SettingsManager(env, {"HOME": d, "EDGE_METHOD": "watershed"})
            env.write_text("EDGE_METHOD=contour\n# edited\n", encoding="utf-8")
            self.assertEqual(m.get().edge_method, "watershed")


if __name__ == "__main__":
    unittest.main()
