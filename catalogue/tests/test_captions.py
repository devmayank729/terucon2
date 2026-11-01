"""captions.py with a fake manager returning canned answers: the structured-response parser (against the notebook's), the caption stage (success,
fenced JSON, blocked/empty answers, the attempt limit, checkpoints and progress hooks) and the text-vector stage (what is embedded is the stored
search document)."""
import json
import sys
import types
from pathlib import Path

import pytest
from pydantic import ValidationError

sys.path.insert(0, str(Path(__file__).resolve().parent))
import nb_oracle  # noqa: E402
from fakes_compute import FakeManager, FakeResponse, canned_profile, make_cfg, seed_items  # noqa: E402

from terucon_catalogue import captions  # noqa: E402
from terucon_catalogue.captions import (CaptionResult, DescriptionEmbeddingIndexer, GeminiMaterialSynthesizer, describe_finish_reason,  # noqa: E402
                                        parse_structured_response)
from terucon_catalogue.config import compute_caption_version, compute_feature_versions, local_feature_versions  # noqa: E402
from terucon_catalogue.schema import (CAPTION_SYSTEM_PROMPT, CAPTION_USER_TEMPLATE, MaterialProfile, compose_search_document,  # noqa: E402
                                      format_dominant_colors)
from terucon_catalogue.state import EmbeddingRow, StateStore  # noqa: E402
from terucon_catalogue.util import get_async_runner  # noqa: E402
from terucon_catalogue.vertex import EmptyModelResponse  # noqa: E402

VALID = canned_profile("0123456789abcdef0123456789abcdef")


def response(**kwargs):
    return FakeResponse(**kwargs)


class TextlessResponse:
    """A response whose .text raises (google-genai does that when there is no candidate)."""
    parsed = None
    candidates = []

    @property
    def text(self):
        raise ValueError("no candidates")


# ------------------------------------------------------------------------------------------------------ the parser
def test_a_parsed_profile_a_dict_plain_json_and_fenced_json_are_all_accepted():
    profile = MaterialProfile.model_validate(VALID)
    assert parse_structured_response(response(parsed=profile), MaterialProfile) is profile
    assert parse_structured_response(response(parsed=VALID), MaterialProfile) == profile
    text = json.dumps(VALID)
    assert parse_structured_response(response(text=text), MaterialProfile) == profile
    assert parse_structured_response(response(text="```json\n" + text + "\n```"), MaterialProfile) == profile
    assert parse_structured_response(response(text="```\n" + text + "\n```"), MaterialProfile) == profile
    assert parse_structured_response(response(text="  \n" + text + "\n  "), MaterialProfile) == profile


def test_text_that_is_not_a_valid_profile_is_a_validation_error_not_an_empty_response():
    for bad in ("not json at all", json.dumps({**VALID, "material_category": "unobtainium"}), json.dumps({k: v for k, v in VALID.items() if k != "confidence"})):
        with pytest.raises(ValidationError):
            parse_structured_response(response(text=bad), MaterialProfile)


@pytest.mark.parametrize("reason,retryable", [("SAFETY", False), ("PROHIBITED_CONTENT", False), ("BLOCKLIST", False), ("MAX_TOKENS", False), ("RECITATION", False),
                                              ("SPII", False), ("STOP", True), ("OTHER", True), ("FINISH_REASON_UNSPECIFIED", True), ("MALFORMED_FUNCTION_CALL", True)])
def test_an_empty_answer_is_permanent_only_for_the_blocking_finish_reasons(reason, retryable):
    with pytest.raises(EmptyModelResponse) as raised:
        parse_structured_response(response(text=None, finish_reason=reason), MaterialProfile)
    assert raised.value.retryable is retryable and f"finish_reason={reason}" in str(raised.value)
    with pytest.raises(EmptyModelResponse) as raised:
        parse_structured_response(response(text="", finish_reason=reason), MaterialProfile)      # an empty string is as empty as None
    assert raised.value.retryable is retryable


def test_a_response_without_candidates_is_an_empty_retryable_one():
    assert describe_finish_reason(TextlessResponse()) == "NO_CANDIDATES" and describe_finish_reason(object()) == "NO_CANDIDATES"
    with pytest.raises(EmptyModelResponse) as raised:
        parse_structured_response(TextlessResponse(), MaterialProfile)
    assert raised.value.retryable is True and "NO_CANDIDATES" in str(raised.value)
    assert describe_finish_reason(types.SimpleNamespace(candidates=[types.SimpleNamespace(finish_reason="STOP")])) == "STOP"       # a plain string works too


def test_the_parser_and_finish_reason_equal_the_notebooks():
    nb_oracle.require_notebook()
    import contextlib
    nb = nb_oracle.load([(2, ["VertexHTTPError", "EmptyModelResponse"]), (5, ["MaterialCategory", "SurfaceFinish", "MaterialProfile", "describe_finish_reason",
                                                                              "parse_structured_response"])], extra={})
    cases = [response(parsed=VALID), response(text=json.dumps(VALID)), response(text="```json\n" + json.dumps(VALID) + "\n```"), response(text=None, finish_reason="SAFETY"),
             response(text=None, finish_reason="STOP"), TextlessResponse(), response(text="garbage")]
    for case in cases:
        theirs_error = ours_error = None
        try:
            theirs = nb["parse_structured_response"](case, nb["MaterialProfile"])
        except Exception as exc:
            theirs, theirs_error = None, exc
        try:
            ours = parse_structured_response(case, MaterialProfile)
        except Exception as exc:
            ours, ours_error = None, exc
        assert type(ours_error).__name__ == type(theirs_error).__name__
        if ours_error is None:
            assert ours.model_dump(mode="json") == theirs.model_dump(mode="json")
        elif isinstance(ours_error, EmptyModelResponse):
            assert (str(ours_error), ours_error.retryable) == (str(theirs_error), theirs_error.retryable)
        assert describe_finish_reason(case) == nb["describe_finish_reason"](case)
    assert contextlib is not None


# ------------------------------------------------------------------------------------------------------ the caption stage
def stage(tmp_path, count=5, manager=None, **cfg_overrides):
    cfg = make_cfg(tmp_path / "w", **cfg_overrides)
    store = StateStore(cfg.state_db_path)
    ids = seed_items(store, cfg, count, product_ids=[f"SB{n:03d}" for n in range(count)])
    return cfg, store, ids, manager or FakeManager(), get_async_runner()


def put_colours(store, cfg, item_id, hexes, proportions):
    version = local_feature_versions(cfg)["color"]
    store.upsert_embeddings([EmbeddingRow(item_id, "color", version, [0.0] * 396, {"dominant_hex": hexes, "proportions": proportions, "dominant_lab": []})])


def test_every_crop_gets_a_caption_with_the_notebooks_prompt_and_the_search_document(tmp_path):
    cfg, store, ids, manager, runner = stage(tmp_path)
    put_colours(store, cfg, ids[0], ["#112233", "#FFFFFF"], [0.7, 0.3])
    checkpoints, ticks = [], []
    synth = GeminiMaterialSynthesizer(cfg, store, manager, runner, on_checkpoint=lambda: checkpoints.append(1), on_batch=lambda d, t: ticks.append((d, t)))
    assert synth.run() == 5
    assert len(checkpoints) == 3 and ticks == [(0, 5), (2, 5), (4, 5), (5, 5)]       # a checkpoint per batch of 2; progress before each batch and at the end
    version = compute_caption_version(cfg)
    assert synth.caption_version == version
    rows = {r["item_id"]: dict(r) for r in store.query("SELECT * FROM captions")}
    assert set(rows) == set(ids) and {r["status"] for r in rows.values()} == {"ok"} and {r["caption_version"] for r in rows.values()} == {version}
    assert {r["model"] for r in rows.values()} == {"gemini-2.5-flash"} and {r["attempts"] for r in rows.values()} == {1} and {r["error"] for r in rows.values()} == {None}
    first = rows[ids[0]]
    profile = json.loads(first["profile_json"])
    assert MaterialProfile.model_validate(profile).model_dump(mode="json") == profile                       # stored as the schema's JSON
    assert first["search_text"] == compose_search_document(profile, ["#112233", "#FFFFFF"])              # with the measured colours of item 0 ...
    assert "Measured colours: #112233, #FFFFFF" in first["search_text"]
    other = rows[ids[1]]
    assert other["search_text"] == compose_search_document(json.loads(other["profile_json"]), None) and "Measured colours" not in other["search_text"]
    # what the model was sent
    by_digest = {r["digest"]: r for r in manager.caption_requests}
    assert len(manager.caption_requests) == 5 and {r["role"] for r in manager.caption_requests} == {"caption"}
    assert {tuple(r["candidates"]) for r in manager.caption_requests} == {cfg.caption_model_candidates} and {r["mime"] for r in manager.caption_requests} == {"image/jpeg"}
    assert {r["system_instruction"] for r in manager.caption_requests} == {CAPTION_SYSTEM_PROMPT} and {r["schema"] for r in manager.caption_requests} == {MaterialProfile}
    prompts = {r["prompt"] for r in by_digest.values()}
    assert CAPTION_USER_TEMPLATE.format(product_id="SB000", colors=format_dominant_colors({"dominant_hex": ["#112233", "#FFFFFF"], "proportions": [0.7, 0.3]})) in prompts
    assert CAPTION_USER_TEMPLATE.format(product_id="SB001", colors="not measured") in prompts
    assert "70%" in "".join(prompts) and "Product code (context only): SB004" in "".join(prompts)
    assert synth.run() == 0 and len(manager.caption_requests) == 5                                         # nothing pending the second time
    store.close()


def test_an_item_without_a_product_id_is_described_as_unknown(tmp_path):
    cfg = make_cfg(tmp_path / "w")
    store = StateStore(cfg.state_db_path)
    seed_items(store, cfg, 1)
    manager = FakeManager()
    GeminiMaterialSynthesizer(cfg, store, manager, get_async_runner()).run()
    assert "Product code (context only): unknown" in manager.caption_requests[0]["prompt"]
    store.close()


def test_fenced_json_answers_are_stored_like_any_other(tmp_path):
    fenced = lambda call, digest: response(text="```json\n" + json.dumps(canned_profile(digest)) + "\n```")      # noqa: E731
    cfg, store, ids, manager, runner = stage(tmp_path, count=2, manager=FakeManager(caption_behaviour=fenced))
    assert GeminiMaterialSynthesizer(cfg, store, manager, runner).run() == 2
    assert {r["status"] for r in store.query("SELECT status FROM captions")} == {"ok"}
    store.close()


def test_blocked_empty_and_failing_answers_are_recorded_as_errors_item_by_item(tmp_path):
    outcomes = {1: response(text=None, finish_reason="SAFETY"), 2: response(text=None, finish_reason="STOP"), 3: RuntimeError("socket closed"), 4: response(text="{not json")}
    cfg, store, ids, manager, runner = stage(tmp_path, count=5, manager=FakeManager(caption_behaviour=lambda call, digest: outcomes.get(call)))
    synth = GeminiMaterialSynthesizer(cfg, store, manager, runner)
    assert synth.run() == 1
    rows = sorted((dict(r) for r in store.query("SELECT * FROM captions")), key=lambda r: r["item_id"])
    assert sorted(r["status"] for r in rows) == ["error"] * 4 + ["ok"]
    errors = [r["error"] for r in rows if r["status"] == "error"]
    assert any("EmptyModelResponse: No structured output (finish_reason=SAFETY)" in e for e in errors) and any("finish_reason=STOP" in e for e in errors)
    assert any(e.startswith("RuntimeError: socket closed") for e in errors) and any(e.startswith("ValidationError") for e in errors)
    assert all(r["profile_json"] is None and r["search_text"] is None and r["model"] is None for r in rows if r["status"] == "error")
    assert {r["attempts"] for r in rows} == {1}
    store.close()


def test_failed_captions_are_retried_on_later_runs_up_to_max_caption_attempts_and_only_those(tmp_path):
    state = {"always_fail": None}

    def behaviour(call, digest):
        if state["always_fail"] is None:
            state["always_fail"] = digest                                  # the first item asked about never gets an answer
        return response(text=None, finish_reason="OTHER") if digest == state["always_fail"] else None
    cfg, store, ids, manager, runner = stage(tmp_path, count=3, manager=FakeManager(caption_behaviour=behaviour), max_caption_attempts=3)
    for attempt in (1, 2, 3):
        GeminiMaterialSynthesizer(cfg, store, manager, runner).run()
        failed = store.query("SELECT item_id, attempts FROM captions WHERE status = 'error'")
        assert [r["attempts"] for r in failed] == [attempt]
    asked = len(manager.caption_requests)
    assert asked == 3 + 1 + 1                                              # 3 on the first run, then only the failing one, twice
    assert GeminiMaterialSynthesizer(cfg, store, manager, runner).run() == 0 and len(manager.caption_requests) == asked      # attempts used up
    assert [r["status"] for r in store.query("SELECT status FROM captions ORDER BY item_id")].count("ok") == 2
    store.close()


def test_a_new_caption_version_captions_everything_again(tmp_path):
    cfg, store, ids, manager, runner = stage(tmp_path, count=2)
    GeminiMaterialSynthesizer(cfg, store, manager, runner).run()
    assert len(manager.caption_requests) == 2
    changed = make_cfg(tmp_path / "w", caption_model_candidates=("gemini-9-flash", "gemini-2.5-flash"))       # the first candidate is part of the fingerprint
    assert compute_caption_version(changed) != compute_caption_version(cfg)
    assert GeminiMaterialSynthesizer(changed, store, manager, runner).run() == 2 and len(manager.caption_requests) == 4
    assert {r["caption_version"] for r in store.query("SELECT caption_version FROM captions")} == {compute_caption_version(changed)}
    assert {r["attempts"] for r in store.query("SELECT attempts FROM captions")} == {1}              # attempts restart with a new version
    store.close()


def test_the_checkpoint_hook_and_the_progress_hook_can_stop_the_stage_between_batches(tmp_path):
    class Stop(Exception):
        pass

    def hook(done, total):
        if done >= 2:
            raise Stop()
    cfg, store, ids, manager, runner = stage(tmp_path, count=5)
    with pytest.raises(Stop):
        GeminiMaterialSynthesizer(cfg, store, manager, runner, on_batch=hook).run()
    assert store.query("SELECT COUNT(*) FROM captions")[0][0] == 2 and len(manager.caption_requests) == 2          # one whole batch saved, none started
    assert GeminiMaterialSynthesizer(cfg, store, manager, runner).run() == 3
    store.close()


def test_the_stage_reads_legacy_absolute_crop_paths_and_a_missing_crop_is_an_error_row(tmp_path):
    cfg, store, ids, manager, runner = stage(tmp_path, count=2)
    absolute = (cfg.work_dir / store.get_item(ids[0])["crop_filepath"]).resolve()
    with store.transaction() as connection:
        connection.execute("UPDATE items SET crop_filepath = ? WHERE item_id = ?", (str(absolute), ids[0]))
    (cfg.work_dir / store.get_item(ids[1])["crop_filepath"]).unlink()
    assert GeminiMaterialSynthesizer(cfg, store, manager, runner).run() == 1
    statuses = {r["item_id"]: (r["status"], r["error"]) for r in store.query("SELECT item_id, status, error FROM captions")}
    assert statuses[ids[0]] == ("ok", None) and statuses[ids[1]][0] == "error" and "FileNotFoundError" in statuses[ids[1]][1]
    store.close()


def test_caption_result_is_a_plain_record():
    result = CaptionResult("i", "v", "ok", "m", {"a": 1}, "text", None)
    assert (result.item_id, result.caption_version, result.status, result.model, result.profile, result.search_text, result.error) == ("i", "v", "ok", "m", {"a": 1}, "text", None)
    assert captions.CaptionResult is CaptionResult


# ------------------------------------------------------------------------------------------------------ the text-vector stage
def captioned(tmp_path, count=5, **kwargs):
    cfg, store, ids, manager, runner = stage(tmp_path, count=count, **kwargs)
    GeminiMaterialSynthesizer(cfg, store, manager, runner).run()
    return cfg, store, ids, manager, runner


def test_the_text_that_is_embedded_is_exactly_the_stored_search_document(tmp_path):
    cfg, store, ids, manager, runner = captioned(tmp_path)
    ticks = []
    indexer = DescriptionEmbeddingIndexer(cfg, store, manager, runner, on_batch=lambda d, t: ticks.append((d, t)))
    assert indexer.run() == 5 and ticks == [(0, 5), (2, 5), (4, 5), (5, 5)]
    stored = {r["item_id"]: r["search_text"] for r in store.query("SELECT item_id, search_text FROM captions")}
    assert sorted(t for t, _ in manager.embedded_texts) == sorted(stored.values()) and {task for _, task in manager.embedded_texts} == {"RETRIEVAL_DOCUMENT"}
    versions = compute_feature_versions(cfg)
    rows = store.query("SELECT item_id, feature_version, dim, dtype FROM embeddings WHERE pillar = 'text'")
    assert len(rows) == 5 and {(r["feature_version"], r["dim"], r["dtype"]) for r in rows} == {(versions["text"], 768, "float16")}
    assert indexer.run() == 0 and len(manager.embedded_texts) == 5                                            # idempotent
    store.close()


def test_only_successful_captions_of_the_current_version_are_embedded(tmp_path):
    bad = {}

    def behaviour(call, digest):
        bad.setdefault("digest", digest)
        return response(text=None, finish_reason="SAFETY") if digest == bad["digest"] else None
    cfg, store, ids, manager, runner = captioned(tmp_path, count=3, manager=FakeManager(caption_behaviour=behaviour))
    assert DescriptionEmbeddingIndexer(cfg, store, manager, runner).run() == 2 and len(manager.embedded_texts) == 2
    assert store.query("SELECT COUNT(*) FROM embeddings WHERE pillar = 'text'")[0][0] == 2
    store.close()


def test_a_failing_embedding_is_recorded_and_given_up_after_max_feature_attempts(tmp_path):
    failing = {"text": None}

    def behaviour(call, text):
        failing["text"] = failing["text"] or text
        return RuntimeError("quota") if text == failing["text"] else None
    cfg, store, ids, manager, runner = captioned(tmp_path, count=3, max_feature_attempts=2, manager=FakeManager(embed_behaviour=behaviour))
    assert DescriptionEmbeddingIndexer(cfg, store, manager, runner).run() == 2
    error = dict(store.query("SELECT * FROM feature_errors")[0])
    assert (error["pillar"], error["attempts"]) == ("text", 1) and error["error"].startswith("RuntimeError: quota")
    calls = len(manager.embedded_texts)
    DescriptionEmbeddingIndexer(cfg, store, manager, runner).run()
    assert len(manager.embedded_texts) == calls + 1 and store.query("SELECT attempts FROM feature_errors")[0]["attempts"] == 2
    DescriptionEmbeddingIndexer(cfg, store, manager, runner).run()
    assert len(manager.embedded_texts) == calls + 1                                                           # attempts used up
    store.close()


def test_the_indexer_hook_can_stop_the_stage_between_batches(tmp_path):
    class Stop(Exception):
        pass

    def hook(done, total):
        if done >= 2:
            raise Stop()
    cfg, store, ids, manager, runner = captioned(tmp_path)
    with pytest.raises(Stop):
        DescriptionEmbeddingIndexer(cfg, store, manager, runner, on_batch=hook).run()
    assert store.query("SELECT COUNT(*) FROM embeddings WHERE pillar = 'text'")[0][0] == 2
    assert DescriptionEmbeddingIndexer(cfg, store, manager, runner).run() == 3
    store.close()
