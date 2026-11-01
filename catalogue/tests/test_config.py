"""What is new in config.py (nothing here is in the notebook): the operational overrides, the profiles and the version check."""
import pytest

from terucon_catalogue import credentials
from terucon_catalogue.config import (COLOUR_ONLY_WEIGHTS, DEFAULT_SEARCH_PROFILE, SEARCH_PROFILES, PipelineConfig, check_feature_versions,
                                      compute_feature_versions, load_config, version_errors)


def versions():
    return compute_feature_versions(PipelineConfig())


def test_load_config_without_overrides_is_the_notebooks_defaults():
    assert load_config({}) == PipelineConfig()


def test_load_config_overrides_only_operational_settings():
    cfg = load_config({"CATALOGUE_WORK_DIR": "/tmp/w", "CATALOGUE_DEVICE": "cpu", "CATALOGUE_CAPTION_MODELS": "a, b",
                       "CATALOGUE_GEMINI_LOCATION": "us-central1", "CATALOGUE_NUM_WORKERS": "0", "CATALOGUE_CAPTION_CONCURRENCY": "3"})
    assert str(cfg.work_dir) == "/tmp/w" and cfg.device == "cpu" and cfg.caption_model_candidates == ("a", "b")
    assert cfg.gemini_location == "us-central1" and cfg.num_workers == 0 and cfg.caption_concurrency == 3
    # what a vector means cannot be changed from the environment
    untouched = load_config({"DINO_MODEL_NAME": "x", "CATALOGUE_DINO_MODEL": "x", "CATALOGUE_COLOR_BINS": "1,1,1"})
    assert untouched.dino_model_name == PipelineConfig().dino_model_name and untouched.color_bins == PipelineConfig().color_bins


def test_load_config_rejects_a_bad_number_and_blank_values_mean_unset():
    with pytest.raises(ValueError, match="CATALOGUE_NUM_WORKERS"):
        load_config({"CATALOGUE_NUM_WORKERS": "many"})
    assert load_config({"CATALOGUE_DEVICE": "   "}).device == "auto"


def test_the_profiles_are_what_the_contract_says():
    assert DEFAULT_SEARCH_PROFILE == "fast"
    assert SEARCH_PROFILES["fast"] == {"use_vertex_mm": False, "describe": False}  # the one configuration the notebook measured
    assert SEARCH_PROFILES["full"] == {"use_vertex_mm": True, "describe": True}
    assert COLOUR_ONLY_WEIGHTS == {"color": 1.0}


def test_identical_versions_have_no_problems():
    assert check_feature_versions(versions(), PipelineConfig()) == []


def test_a_different_encoder_setting_is_an_error_for_every_pillar_but_text():
    cfg = PipelineConfig()
    for pillar in ("dino", "siglip", "color", "vertex_mm"):
        stored = dict(versions())
        stored[pillar] = stored[pillar] + "-other"
        problems = check_feature_versions(stored, cfg)
        assert [(p.pillar, p.level) for p in problems] == [(pillar, "error")]
        assert version_errors(problems) == problems


def test_the_caption_fingerprint_alone_is_only_a_warning_but_the_rest_of_the_text_label_is_strict():
    cfg = PipelineConfig()
    stored = dict(versions())
    stored["text"] = stored["text"].replace(stored["text"].split("|")[2], "cap000000000000")
    problems = check_feature_versions(stored, cfg)
    assert [(p.pillar, p.level) for p in problems] == [("text", "warning")]
    stored["text"] = "gemini-embedding-002|d768|cap000000000000|v1"
    assert [(p.pillar, p.level) for p in check_feature_versions(stored, cfg)] == [("text", "error")]
    stored["text"] = "gemini-embedding-001|d512|cap5ad77cde2d93|v1"
    assert [(p.pillar, p.level) for p in check_feature_versions(stored, cfg)] == [("text", "error")]


def test_missing_and_unknown_pillars_are_warnings():
    cfg = PipelineConfig()
    only_local = {k: v for k, v in versions().items() if k in ("dino", "siglip", "color")}
    assert {(p.pillar, p.level) for p in check_feature_versions(only_local, cfg)} == {("vertex_mm", "warning"), ("text", "warning")}
    with_extra = dict(versions(), mystery="v9")
    problems = check_feature_versions(with_extra, cfg)
    assert [(p.pillar, p.level) for p in problems] == [("mystery", "warning")]


def test_checking_only_some_pillars():
    cfg = PipelineConfig()
    stored = dict(versions(), dino="facebook/dinov2-small|224|v0")
    assert check_feature_versions(stored, cfg, pillars=["siglip", "color"]) == []
    assert [(p.pillar, p.level) for p in check_feature_versions(stored, cfg, pillars=["dino"])] == [("dino", "error")]


def test_service_account_loading_never_needs_a_kaggle_secret(tmp_path):
    import json

    key = {"type": "service_account", "project_id": "p", "private_key": "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n",
           "client_email": "a@b.iam.gserviceaccount.com", "token_uri": "https://oauth2.googleapis.com/token"}
    assert credentials.load_service_account_info({credentials.SA_ENV: json.dumps(key)})["project_id"] == "p"
    # double-encoded, quoted and escaped-newline forms the notebook already tolerated
    pasted = json.dumps(dict(key, private_key=key["private_key"].replace("\n", "\\n")))
    assert "\n" in credentials.load_service_account_info({credentials.SA_ENV: pasted})["private_key"]
    path = tmp_path / "sa.json"
    path.write_text(json.dumps(key))
    assert credentials.load_service_account_info({credentials.SA_FILE_ENV: str(path)})["client_email"] == key["client_email"]
    with pytest.raises(credentials.SecretUnavailableError):
        credentials.load_service_account_info({})
    with pytest.raises(credentials.SecretUnavailableError):
        credentials.load_service_account_info({credentials.SA_ENV: json.dumps({"type": "authorized_user"})})
    with pytest.raises(credentials.SecretUnavailableError) as info:
        credentials.load_service_account_info({credentials.SA_FILE_ENV: str(tmp_path / "missing.json")})
    assert "missing.json" in str(info.value) and "private_key" not in str(info.value)
