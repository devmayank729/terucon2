"""modal_app.py: it imports with no Modal credentials and no network (the decorators accepting every argument IS the SDK validation: modal 1.6.3 raises
on an unknown one), it defines what the contract says, and nothing heavy is imported until a container runs."""
import ast
import json
import os
import subprocess
import sys
import warnings
from pathlib import Path
from types import SimpleNamespace

import pytest

modal = pytest.importorskip("modal")
CATALOGUE_DIR = Path(__file__).resolve().parent.parent
SOURCE = (CATALOGUE_DIR / "modal_app.py").read_text()
TREE = ast.parse(SOURCE)


@pytest.fixture(scope="module")
def modal_app():
    sys.path.insert(0, str(CATALOGUE_DIR))
    import modal_app as module
    return module


def clean_env(**extra):
    env = {key: value for key, value in os.environ.items() if not key.startswith(("MODAL_", "CATALOGUE_"))}
    env.update(extra)
    return env


def run_python(code, tmp_path, **env):
    """A fresh interpreter with an empty HOME (no ~/.modal.toml) and no MODAL_* variables."""
    result = subprocess.run([sys.executable, "-c", code], cwd=CATALOGUE_DIR, capture_output=True, text=True, timeout=180,
                            env=clean_env(HOME=str(tmp_path), **env))
    return result


# ------------------------------------------------------------------------------------------------------------------------
def test_it_imports_without_credentials_or_network_and_without_heavy_libraries(tmp_path):
    code = ("import sys, modal_app\n"
            "heavy = [m for m in ('torch','transformers','torchvision','google.genai','pymongo','google.cloud.storage','pandas','fitz','pymupdf',"
            "'terucon_catalogue') if m in sys.modules]\n"
            "print('HEAVY', heavy)\n"
            "print('NAME', modal_app.app.name)\n")
    result = run_python(code, tmp_path)
    assert result.returncode == 0, result.stderr[-2000:]
    assert "HEAVY []" in result.stdout and "NAME terucon-catalogue" in result.stdout


def test_the_app_the_classes_and_the_functions(modal_app):
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        app = modal_app.app
        assert app.name == "terucon-catalogue"
        assert sorted(app.registered_classes) == ["Ingest", "Search"]
        assert sorted(app.registered_functions) == ["Ingest.*", "Search.*", "import_bundle_fn", "ingest_job_fn", "prime_fn", "selftest_fn"]
        assert sorted(app.registered_web_endpoints) == ["Ingest.api", "Search.api"]
        assert sorted(app.registered_entrypoints) == ["import_bundle", "prime", "selftest"]


def test_names_labels_and_secrets_match_the_contract(modal_app):
    assert (modal_app.APP_NAME, modal_app.KEYS_SECRET, modal_app.GCP_SECRET, modal_app.MONGO_SECRET) == (
        "terucon-catalogue", "terucon-catalogue-keys", "terucon-catalogue-gcp", "terucon-catalogue-mongo")
    assert (modal_app.CACHE_VOLUME, modal_app.CACHE_DIR) == ("terucon-catalogue-cache", "/cache")
    assert (modal_app.SEARCH_LABEL, modal_app.INGEST_LABEL) == ("terucon-catalogue-search", "terucon-catalogue-ingest")


def calls_named(dotted):
    found = []
    for node in ast.walk(TREE):
        if isinstance(node, ast.Call) and ast.unparse(node.func) == dotted:
            found.append(node)
    return found


def evaluate(node, namespace):
    return eval(compile(ast.Expression(node), "<modal_app>", "eval"), vars(namespace))      # noqa: S307  - our own file, constants only


def decorator_kwargs(name, decorator, namespace):
    for node in ast.walk(TREE):
        if isinstance(node, (ast.ClassDef, ast.FunctionDef)) and node.name == name:
            for dec in node.decorator_list:
                if isinstance(dec, ast.Call) and ast.unparse(dec.func) == decorator:
                    return {kw.arg: evaluate(kw.value, namespace) for kw in dec.keywords if kw.arg not in ("secrets", "volumes", "image")}
    raise AssertionError(f"{name} has no @{decorator}")


def test_secrets_volume_and_image_are_wired(modal_app):
    secret_calls = [ast.unparse(c.args[0]) for c in calls_named("modal.Secret.from_name")]
    assert secret_calls == ["KEYS_SECRET", "GCP_SECRET", "MONGO_SECRET"]
    assert [ast.unparse(c.args[0]) for c in calls_named("modal.Volume.from_name")] == ["CACHE_VOLUME"]
    # which secrets each service gets: keys + gcp for search (no MongoDB), keys + mongo for the ingest endpoint, gcp + mongo for the job
    wanted = {"Search": ("app.cls", ["keys_secret", "gcp_secret"]), "Ingest": ("app.cls", ["keys_secret", "mongo_secret"]),
              "ingest_job_fn": ("app.function", ["gcp_secret", "mongo_secret"]), "import_bundle_fn": ("app.function", ["gcp_secret", "mongo_secret"]),
              "prime_fn": ("app.function", ["gcp_secret", "mongo_secret"])}
    for node in ast.walk(TREE):
        if isinstance(node, (ast.ClassDef, ast.FunctionDef)) and node.name in wanted:
            decorator = next(d for d in node.decorator_list if isinstance(d, ast.Call) and ast.unparse(d.func) == wanted[node.name][0])
            secrets = next(ast.unparse(kw.value) for kw in decorator.keywords if kw.arg == "secrets")
            assert secrets == "[" + ", ".join(wanted[node.name][1]) + "]", node.name
    search = next(d for d in ast.walk(TREE) if isinstance(d, ast.ClassDef) and d.name == "Search")
    cls_call = next(d for d in search.decorator_list if isinstance(d, ast.Call) and ast.unparse(d.func) == "app.cls")
    assert [ast.unparse(kw.value) for kw in cls_call.keywords if kw.arg == "volumes"] == ["{CACHE_DIR: cache_volume}"]
    assert ".run_function(_bake_models)" in SOURCE and ".add_local_python_source(\"terucon_catalogue\")" in SOURCE


def test_search_class_settings(modal_app):
    kwargs = decorator_kwargs("Search", "app.cls", modal_app)
    assert kwargs["gpu"] == ["L4", "L40S", "A10"] and kwargs["min_containers"] == 0 and kwargs["max_containers"] == 3
    assert kwargs["scaledown_window"] == 300 and kwargs["timeout"] == 300 and kwargs["startup_timeout"] == 900
    assert decorator_kwargs("Search", "modal.concurrent", modal_app) == {"max_inputs": 8, "target_inputs": 4}


def test_ingest_endpoint_and_job_settings(modal_app):
    assert "gpu" not in decorator_kwargs("Ingest", "app.cls", modal_app)                       # the endpoint is CPU only
    job = decorator_kwargs("ingest_job_fn", "app.function", modal_app)
    assert job["max_containers"] == 1 and job["timeout"] == 6 * 3600 and job["gpu"] == ["L4", "L40S", "A10"]
    for name, label in (("Search", "SEARCH_LABEL"), ("Ingest", "INGEST_LABEL")):
        cls = next(n for n in ast.walk(TREE) if isinstance(n, ast.ClassDef) and n.name == name)
        api = next(f for f in cls.body if isinstance(f, ast.FunctionDef) and f.name == "api")
        asgi = next(d for d in api.decorator_list if isinstance(d, ast.Call) and ast.unparse(d.func) == "modal.asgi_app")
        assert {kw.arg: ast.unparse(kw.value) for kw in asgi.keywords} == {"label": label, "requires_proxy_auth": "REQUIRE_PROXY_AUTH"}
    selftest = decorator_kwargs("selftest_fn", "app.function", modal_app)
    assert selftest["gpu"] == ["L4", "L40S", "A10"]


def test_the_enter_hook_builds_the_service(modal_app):
    search = next(n for n in ast.walk(TREE) if isinstance(n, ast.ClassDef) and n.name == "Search")
    enter = next(f for f in search.body if isinstance(f, ast.FunctionDef) and f.name == "load")
    assert [ast.unparse(d) for d in enter.decorator_list] == ["modal.enter()"]
    assert "build_search_service()" in ast.unparse(enter)


def test_environment_variables_change_the_deployment_and_bad_values_are_refused(tmp_path):
    code = ("import modal_app as m\n"
            "print(m.GPU_TIER, m.MIN_CONTAINERS, m.REQUIRE_PROXY_AUTH, m.SCALEDOWN_S, m.INGEST_TIMEOUT_S)\n")
    result = run_python(code, tmp_path, CATALOGUE_GPU_TIER="fast", CATALOGUE_MIN_CONTAINERS="1", CATALOGUE_REQUIRE_PROXY_AUTH="1",
                        CATALOGUE_SCALEDOWN_S="120", CATALOGUE_INGEST_TIMEOUT_H="2")
    assert result.returncode == 0, result.stderr[-2000:]
    assert result.stdout.split() == ["fast", "1", "True", "120", "7200"]                       # the decorators accepted these values too
    bad = run_python("import modal_app", tmp_path, CATALOGUE_GPU_TIER="turbo")
    assert bad.returncode != 0 and "CATALOGUE_GPU_TIER must be one of" in bad.stderr
    junk = run_python("import modal_app as m; print(m.MIN_CONTAINERS, m.SCALEDOWN_S)", tmp_path, CATALOGUE_MIN_CONTAINERS="lots", CATALOGUE_SCALEDOWN_S="99999")
    assert junk.stdout.split() == ["0", "1200"]


def test_the_docstring_carries_the_deploy_commands_and_the_atlas_caveat():
    doc = ast.get_docstring(TREE)
    for text in ("modal secret create terucon-catalogue-keys", "modal secret create terucon-catalogue-gcp", "modal secret create terucon-catalogue-mongo",
                 "modal run    modal_app.py::selftest", "modal deploy modal_app.py", "MONGODB ATLAS NETWORK ACCESS", "0.0.0.0/0", "modal.Proxy",
                 "modal run modal_app.py::import_bundle", "modal run modal_app.py::prime", "gcloud storage cp -r", "the SAME database", "WINS over a database"):
        assert text in doc, text


def test_the_ingest_spawner_returns_the_modal_call_id(modal_app, monkeypatch):
    spawned = []
    fake = SimpleNamespace(spawn=lambda job_id: spawned.append(job_id) or SimpleNamespace(object_id="fc-abc"))
    monkeypatch.setattr(modal_app, "ingest_job_fn", fake)
    assert modal_app.ModalIngestSpawner()("job-20261101120000-a1b2c3") == "fc-abc" and spawned == ["job-20261101120000-a1b2c3"]


def test_the_bake_function_asks_for_exactly_the_two_models(modal_app, monkeypatch, tmp_path):
    """Build-time function with a fake huggingface_hub: both repos, weights + config + tokenizer files only, and it fails loudly on an empty download."""
    calls = []
    folder = tmp_path / "snap"
    folder.mkdir()
    (folder / "config.json").write_text("{}")
    (folder / "model.safetensors").write_bytes(b"x")

    def snapshot_download(repo, **kwargs):
        calls.append((repo, kwargs))
        return str(folder)

    tokenized = []
    fake_tokenizer = SimpleNamespace(from_pretrained=lambda repo: tokenized.append(repo) or (lambda text: {"input_ids": [1, 2, 3]}))
    monkeypatch.setitem(sys.modules, "huggingface_hub", SimpleNamespace(snapshot_download=snapshot_download))
    monkeypatch.setitem(sys.modules, "transformers", SimpleNamespace(AutoTokenizer=fake_tokenizer))
    modal_app._bake_models()
    assert [c[0] for c in calls] == ["facebook/dinov2-large", "google/siglip-so400m-patch14-384"]
    assert all(c[1]["allow_patterns"] == ["*.json", "*.safetensors", "*.txt", "*.model"] for c in calls)
    assert tokenized == ["google/siglip-so400m-patch14-384"]                       # the build also proves the SigLIP tokenizer can be made
    (folder / "model.safetensors").unlink()
    with pytest.raises(RuntimeError, match="missing its weights"):
        modal_app._bake_models()


def test_the_image_build_fails_when_the_siglip_tokenizer_cannot_be_made(modal_app, monkeypatch, tmp_path):
    """The 2026-11-01 finding: without the sentencepiece library the real tokenizer cannot be built. That must stop the BUILD, not the first request."""
    folder = tmp_path / "snap"
    folder.mkdir()
    (folder / "config.json").write_text("{}")
    (folder / "model.safetensors").write_bytes(b"x")

    def no_sentencepiece(repo):
        raise ImportError("SiglipTokenizer requires the SentencePiece library but it was not found in your environment.")

    def empty(repo):
        return lambda text: {"input_ids": []}

    monkeypatch.setitem(sys.modules, "huggingface_hub", SimpleNamespace(snapshot_download=lambda repo, **kw: str(folder)))
    monkeypatch.setitem(sys.modules, "transformers", SimpleNamespace(AutoTokenizer=SimpleNamespace(from_pretrained=no_sentencepiece)))
    with pytest.raises(ImportError, match="SentencePiece"):
        modal_app._bake_models()
    monkeypatch.setitem(sys.modules, "transformers", SimpleNamespace(AutoTokenizer=SimpleNamespace(from_pretrained=empty)))
    with pytest.raises(RuntimeError, match="produced no tokens"):
        modal_app._bake_models()


def test_sentencepiece_is_declared_everywhere_the_real_models_run():
    """The tests inject a tiny fake tokenizer, so only this keeps the dependency from silently going missing again."""
    requirements = [line.split("#")[0].strip() for line in (CATALOGUE_DIR / "requirements.txt").read_text().splitlines()]
    assert "sentencepiece" in requirements
    image_packages = [node.value for node in ast.walk(TREE) if isinstance(node, ast.Constant) and isinstance(node.value, str)]
    assert "sentencepiece" in image_packages
    dev = (CATALOGUE_DIR / "requirements-dev.txt").read_text().split()
    assert "pandas" in dev and "-r" in dev                                          # the notebook-parity search tests need it; without it 23 skip silently


# ------------------------------------------------------------------------------------------------------------------------ the owner's files and the volume
def test_the_new_functions_are_cpu_only_one_at_a_time_and_see_the_volume(modal_app):
    for name in ("import_bundle_fn", "prime_fn"):
        kwargs = decorator_kwargs(name, "app.function", modal_app)
        assert "gpu" not in kwargs and kwargs["max_containers"] == 1, name
        node = next(n for n in ast.walk(TREE) if isinstance(n, ast.FunctionDef) and n.name == name)
        decorator = next(d for d in node.decorator_list if isinstance(d, ast.Call) and ast.unparse(d.func) == "app.function")
        assert [ast.unparse(kw.value) for kw in decorator.keywords if kw.arg == "volumes"] == ["{CACHE_DIR: cache_volume}"], name
    assert decorator_kwargs("import_bundle_fn", "app.function", modal_app)["timeout"] == 2 * 3600
    # the GPU ingest job now puts what it publishes on the volume too
    job = next(n for n in ast.walk(TREE) if isinstance(n, ast.FunctionDef) and n.name == "ingest_job_fn")
    decorator = next(d for d in job.decorator_list if isinstance(d, ast.Call) and ast.unparse(d.func) == "app.function")
    assert [ast.unparse(kw.value) for kw in decorator.keywords if kw.arg == "volumes"] == ["{CACHE_DIR: cache_volume}"]


def test_the_entrypoint_arguments_are_what_the_docs_promise(modal_app):
    import inspect

    import_sig = inspect.signature(modal_app.import_bundle.info.raw_f)               # Modal wraps an entrypoint; raw_f is the function `modal run` parses flags from
    assert list(import_sig.parameters) == ["catalogue", "key", "activate", "create", "with_pdf"]
    assert list(inspect.signature(modal_app.prime.info.raw_f).parameters) == ["catalogue", "release"]
    assert import_sig.parameters["activate"].default is False and import_sig.parameters["activate"].annotation is bool


@pytest.fixture
def wired(modal_app, monkeypatch, tmp_path):
    """The Modal functions' own glue, run on this computer: the real publish and loader, a local folder as the bucket, an in-memory database,
    and the volume as a plain folder (its commit/reload cannot run outside a container; the loader ignores a failing hook, as in production)."""
    from factories import make_bundle, new_environment
    import terucon_catalogue.mongo as mongo_module
    import terucon_catalogue.objectstore as objectstore_module

    store, db = new_environment(tmp_path)
    info = make_bundle(tmp_path / "kaggle-output", 3, legacy_kaggle_paths=True)
    for path in sorted(info.path.rglob("*")):
        if path.is_file():
            store.put_file("imports/superbond-colour/run1/" + path.relative_to(info.path).as_posix(), path)
    monkeypatch.setenv("MONGODB_URI", "mongodb://localhost/never-used")
    monkeypatch.delenv("MONGODB_DB", raising=False)
    monkeypatch.setattr(mongo_module, "MongoCatalogueDb", lambda uri, db_name=None, **kw: db)
    monkeypatch.setattr(objectstore_module, "object_store_from_env", lambda environ=None: store)
    monkeypatch.setattr(modal_app, "CACHE_DIR", str(tmp_path / "volume"))
    return SimpleNamespace(store=store, db=db, info=info, volume=tmp_path / "volume")


def test_import_bundle_fn_runs_end_to_end_on_this_computer(modal_app, wired, capsys):
    report = modal_app.import_bundle_fn.local("superbond-colour", "imports/superbond-colour/run1", True, "", False)
    assert report["ok"] and report["items"] == 3 and report["activated"] and report["seeded"]["source"] == "download"
    assert wired.db.get_catalogue("superbond-colour")["activeRelease"] == report["releaseId"]
    assert (wired.volume / "superbond-colour" / report["releaseId"] / "manifest.json").is_file()
    assert "[fetch]" in capsys.readouterr().out                                    # progress reaches the Modal log


def test_prime_fn_copies_the_live_release_to_the_volume(modal_app, wired):
    first = modal_app.import_bundle_fn.local("superbond-colour", "imports/superbond-colour/run1", True, "", False)
    import shutil
    shutil.rmtree(wired.volume)                                                    # an empty volume, as after the volume was recreated
    seeded = modal_app.prime_fn.local("superbond-colour", "")
    assert [(item["releaseId"], item["items"], item["source"]) for item in seeded] == [(first["releaseId"], 3, "download")]


def test_ingest_job_fn_seeds_the_volume_after_a_good_job_and_leaves_a_failed_one_alone(modal_app, wired, monkeypatch):
    pytest.importorskip("torch")                                                   # the function imports the real encoders at call time
    import terucon_catalogue.ingest_job as ingest_module

    published = modal_app.import_bundle_fn.local("superbond-colour", "imports/superbond-colour/run1", False, "", False)
    wired.db.insert_job({"_id": "job-20261101120000-abc123", "catalogue": "superbond-colour", "status": "succeeded"})
    import shutil
    shutil.rmtree(wired.volume)
    monkeypatch.setattr(ingest_module, "run_ingest_job", lambda job_id, **kw: {"ok": True, "status": "succeeded", "jobId": job_id, "releaseId": published["releaseId"], "error": None})
    good = modal_app.ingest_job_fn.local("job-20261101120000-abc123")
    assert good["ok"] and good["seeded"]["releaseId"] == published["releaseId"] and good["seeded"]["source"] == "download"
    shutil.rmtree(wired.volume)
    monkeypatch.setattr(ingest_module, "run_ingest_job", lambda job_id, **kw: {"ok": False, "status": "failed", "jobId": job_id, "releaseId": None, "error": "boom"})
    bad = modal_app.ingest_job_fn.local("job-20261101120000-abc123")
    assert bad["ok"] is False and "seeded" not in bad and not wired.volume.exists()
