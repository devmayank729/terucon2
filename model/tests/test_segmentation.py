"""Segmentation pipeline and SAM routes of the model service (/segment, /sam/*), against a mock Google and (optionally) the real SAM 2 model.

Run:  python -m unittest discover -s model/tests -t model    (from the project root)
Heavy (downloads and runs SAM 2.1 on CPU):  TERUCON_HEAVY_TESTS=1 python -m unittest discover -s model/tests -t model
"""
from __future__ import annotations

import base64
import io
import json
import os
import sys
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import numpy as np
from PIL import Image

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

import support  # noqa: E402
import synthetic as syn  # noqa: E402
from fakes import FakeSam, FakeTextSam, make_sam_manager  # noqa: E402
from mock_google import MockGoogle, make_service_account, text_response  # noqa: E402
from support import JSON, LOCAL, decode_labels, jpeg_b64  # noqa: E402
from terucon_model import vertex  # noqa: E402
from terucon_model.config import SamConfig  # noqa: E402
from terucon_model.sam.backends import Candidate  # noqa: E402
from terucon_model.sam.manager import SamManager  # noqa: E402
from terucon_model.segment import detect, pipeline, snap  # noqa: E402


class PipelineHarness(unittest.TestCase):
    def setUp(self):
        self.img, self.gt, self.labels = syn.build()
        self.info, self.pub = make_service_account("placeholder")
        self.mock = MockGoogle(self.pub)
        self.mock.start()
        self.info["token_uri"] = self.mock.token_url
        self.mock.default_handler = self._gemini
        self.gemini_json = syn.gemini_json(jitter=14.0, seed=11)
        self.tmp = support.tempdir()
        self.environ = support.google_environ(self.info, self.mock.base)
        # no real sleeping in Google's retry back-off: vertex.py gets a clock that does not wait (only its own `time` is replaced)
        patcher = mock.patch.object(vertex, "time", SimpleNamespace(sleep=lambda s: None, monotonic=time.monotonic))
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(self.tmp.cleanup)
        self.addCleanup(self.mock.stop)

    def _gemini(self, model, body, headers):
        return 200, text_response(json.dumps(self.gemini_json))

    def client(self, sam=None, environ=None):
        return support.make_app(self.tmp.name, {**self.environ, **(environ or {})}, sam_manager=sam).test_client()

    def segment(self, client, **opts):
        r = client.post("/segment", data=json.dumps({"image": jpeg_b64(self.img), "options": opts}), headers=JSON)
        return r, (r.get_json() or {})

    def scores(self, resp):
        """IoU of every true surface against the surface the pipeline gave the same name."""
        pred = decode_labels(resp)
        by_name = {m["label"]: m["index"] for m in resp["metas"]}
        out = {}
        for i, name in enumerate(self.labels, start=1):
            truth = self.gt == i
            idx = by_name.get(name)
            out[name] = syn.iou(pred == idx, truth) if idx else 0.0
        return out

    def raw_scores(self):
        """The same outlines with no refinement at all (painted in the same order)."""
        from terucon_model.segment import refine
        from terucon_model.segment.geometry import polygon_to_mask

        h, w = self.gt.shape
        masks = [polygon_to_mask(s["polygon"], h, w) for s in self.gemini_json["surfaces"]]
        tier = {"ceiling": 0, "floor": 0, "wall": 0, "window": 1, "door": 1, "other": 2, "furniture": 3}
        order = sorted(range(len(masks)), key=lambda i: (tier[self.gemini_json["surfaces"][i]["kind"]], -int(masks[i].sum())))
        lab = refine.paint(masks, order)
        return {name: syn.iou(lab == i, self.gt == i) for i, name in enumerate(self.labels, start=1)}


class DetectParsingTests(unittest.TestCase):
    def test_fenced_and_truncated_json_are_recovered(self):
        self.assertEqual(detect.parse_json_loose('```json\n{"a": 1}\n```'), {"a": 1})
        self.assertEqual(detect.parse_json_loose('Here: [{"a": 1}, {"a": 2}] done'), [{"a": 1}, {"a": 2}])
        self.assertEqual(detect.parse_json_loose('[{"a": 1}, {"a": 2}, {"a"'), [{"a": 1}, {"a": 2}])

    def test_an_answer_cut_off_inside_the_surfaces_list_keeps_the_complete_surfaces(self):
        cut = '{"scene": "exterior", "surfaces": [{"label": "Facade", "kind": "wall", "polygon": [[0, 0], [0, 900], [900, 900]]}, {"label": "Ground", "kind": "floor", "polygon": [[500, 0], [500, 1000], [1000, 1000]]}, {"label": "Gate", "kind": "door", "polygon": [[300, 400], [300, 5'
        data = detect.parse_json_loose(cut)
        scene, props = detect.parse_proposals(data)
        self.assertEqual(scene, "exterior")
        self.assertEqual([p.label for p in props], ["Facade", "Ground"])  # the cut-off third item is dropped, not guessed

    def test_request_shapes_get_simpler_and_never_pin_a_temperature(self):
        shapes = detect.GENERATION_SHAPES
        self.assertEqual(len(shapes), 3)
        for gen in shapes:
            self.assertNotIn("temperature", gen)
            self.assertEqual(gen["responseMimeType"], "application/json")
        self.assertIn("responseSchema", shapes[0])
        self.assertNotIn("responseSchema", shapes[2])

    def test_proposals_from_either_shape_with_kind_inference(self):
        data = {"scene": "exterior", "surfaces": [
            {"label": "wall: Front facade", "polygon": [[0, 0], [0, 500], [500, 500]]},
            {"label": "Glass curtain wall", "kind": "nonsense", "polygon": [[10, 10], [10, 90], [90, 90]]},
            {"label": "Bad", "kind": "wall", "polygon": [[0, 0]]},
        ]}
        scene, props = detect.parse_proposals(data)
        self.assertEqual(scene, "exterior")
        self.assertEqual([(p.label, p.kind) for p in props], [("Front facade", "wall"), ("Glass curtain wall", "window")])
        _s, bare = detect.parse_proposals([{"name": "floor", "points": [[0, 0], [0, 9], [9, 9]]}])
        self.assertEqual(bare[0].kind, "floor")


class SegmentEndpointTests(PipelineHarness):
    def test_google_not_configured_is_a_clear_503(self):
        c = support.make_app(self.tmp.name, {}).test_client()
        r = c.post("/segment", data=json.dumps({"image": jpeg_b64(self.img)}), headers=JSON)
        self.assertEqual(r.status_code, 503)
        self.assertIn("not configured", r.get_json()["error"]["message"])

    def test_edge_snapping_route_returns_named_surfaces_and_beats_raw_outlines(self):
        r, data = self.segment(self.client(), useSam=False)
        self.assertEqual(r.status_code, 200, data)
        self.assertEqual(data["scene"], "interior")
        self.assertFalse(data["sam"]["used"])
        self.assertEqual(sorted(m["label"] for m in data["metas"]), sorted(self.labels))
        self.assertEqual({m["label"]: m["kind"] for m in data["metas"]}["Sofa"], "furniture")
        self.assertIn("edges", data["metas"][0]["source"])
        got, raw = self.scores(data), self.raw_scores()
        self.assertGreater(np.mean(list(got.values())), np.mean(list(raw.values())), f"refined {got} vs raw {raw}")
        self.assertGreater(np.mean(list(got.values())), 0.9)

    def test_the_response_has_the_shape_the_website_and_the_studio_expect(self):
        r, data = self.segment(self.client(), useSam=False)
        self.assertEqual(r.status_code, 200, data)
        self.assertEqual(r.mimetype, "application/json")
        self.assertEqual(r.headers["Cache-Control"], "no-store")
        self.assertEqual(list(data), ["ok", "width", "height", "labelMap", "metas", "scene", "engine", "model", "notes", "hints", "timings", "sam"])
        self.assertTrue(data["ok"])
        self.assertEqual((data["width"], data["height"]), (self.img.shape[1], self.img.shape[0]))
        self.assertEqual(sorted(data["labelMap"]), ["data", "encoding"])
        self.assertEqual(data["labelMap"]["encoding"], "zlib-u8")
        self.assertEqual(sorted(data["sam"]), ["imageId", "used"])
        self.assertEqual(decode_labels(data).shape, self.gt.shape)
        self.assertLessEqual({"index", "label", "kind", "source"}, set(data["metas"][0]))
        self.assertEqual(data["model"], "gemini-3.8-flash")

    def test_furniture_sits_on_top_of_the_wall_and_floor_it_overlaps(self):
        r, data = self.segment(self.client(), useSam=False)
        pred = decode_labels(data)
        sofa = next(m["index"] for m in data["metas"] if m["label"] == "Sofa")
        self.assertGreater(syn.iou(pred == sofa, self.gt == self.labels.index("Sofa") + 1), 0.85)

    def test_with_sam_the_edges_are_snapped_and_reported(self):
        truth = {n: syn.mask_of(n) for n in self.labels}
        # SAM sees whole surfaces, so give it the *visible* truth the same way a real model would segment them
        truth = {n: (self.gt == i + 1).astype(np.uint8) for i, n in enumerate(self.labels)}
        sam = make_sam_manager(truth)
        r, data = self.segment(self.client(sam=sam))
        self.assertEqual(r.status_code, 200, data)
        self.assertTrue(data["sam"]["used"])
        self.assertTrue(data["sam"]["imageId"])
        self.assertIn("Fake SAM", data["engine"])
        self.assertTrue(any("snapped 8 of 8" in h for h in data["hints"]))
        self.assertEqual(data["notes"], [])  # nothing went wrong, so nothing is flagged
        got = self.scores(data)
        self.assertGreater(np.mean(list(got.values())), 0.93, got)
        self.assertTrue(all(m["source"].endswith("+sam") for m in data["metas"]))

    def test_sam_may_not_wander_off_the_outline(self):
        """A decoy that disagrees with the outline must be refused, not trusted because SAM scored it high."""
        class Liar(FakeSam):
            def predict(self, handle, box=None, points=None, labels=None, multimask=True):
                m = np.zeros((handle.height, handle.width), bool)
                m[:80, :80] = True
                return [Candidate(m, 0.99)]

        sam = make_sam_manager({"x": np.zeros_like(self.gt)})
        sam._backend = Liar({})
        r, data = self.segment(self.client(sam=sam), edgeRefine=False)
        self.assertEqual(r.status_code, 200)
        self.assertFalse(data["sam"]["used"])
        self.assertTrue(any("did not agree" in n for n in data["notes"]))
        self.assertGreater(np.mean(list(self.scores(data).values())), 0.7)

    def test_sam_failure_degrades_to_edge_snapping(self):
        class Broken(FakeSam):
            def predict(self, *a, **k):
                raise RuntimeError("out of memory")

        sam = make_sam_manager({})
        sam._backend = Broken({})
        r, data = self.segment(self.client(sam=sam))
        self.assertEqual(r.status_code, 200)
        self.assertFalse(data["sam"]["used"])
        self.assertTrue(any("could not refine" in n for n in data["notes"]))

    def test_surfaces_sam_refuses_still_get_their_edges_snapped(self):
        """SAM agreeing with only some outlines must not leave the others raw."""

        class PartialSam(FakeSam):
            """Agrees with every other outline; for the rest it offers a blob that matches nothing."""

            asked = 0

            def predict(self, handle, box=None, points=None, labels=None, multimask=True):
                self.asked += 1
                if self.asked % 2 == 0:
                    m = np.zeros((handle.height, handle.width), bool)
                    m[:40, :40] = True
                    return [Candidate(m, 0.99)]
                return super().predict(handle, box, points, labels, multimask)

        truth = {n: (self.gt == i + 1).astype(np.uint8) for i, n in enumerate(self.labels)}
        sam = make_sam_manager(truth)
        sam._backend = PartialSam(truth)
        r, data = self.segment(self.client(sam=sam))
        self.assertEqual(r.status_code, 200, data)
        sources = {m["label"]: m["source"] for m in data["metas"]}
        refused = [n for n, src in sources.items() if src.endswith("+edges")]
        self.assertTrue(refused, sources)
        self.assertTrue(any(src.endswith("+sam") for src in sources.values()), sources)
        got, raw = self.scores(data), self.raw_scores()
        self.assertGreater(np.mean([got[n] for n in refused]), np.mean([raw[n] for n in refused]), f"refused surfaces: refined {got} vs raw {raw}")

    def test_the_earlier_watershed_method_can_be_switched_back_on(self):
        c = self.client(environ={"EDGE_METHOD": "watershed"})
        self.assertEqual(c.get("/health", headers=LOCAL).get_json()["segmentation"]["edgeMethod"], "watershed")
        r, data = self.segment(c, useSam=False)
        self.assertEqual(r.status_code, 200, data)
        self.assertTrue(all("edges" in m["source"] for m in data["metas"]))
        self.assertGreater(np.mean(list(self.scores(data).values())), 0.9)

    def test_an_unknown_edge_method_is_ignored_with_a_warning(self):
        # /health carries no warnings (the website's /api/config does); they are on the settings object the service runs on
        app = support.make_app(self.tmp.name, {**self.environ, "EDGE_METHOD": "magic"})
        self.assertEqual(app.test_client().get("/health", headers=LOCAL).get_json()["segmentation"]["edgeMethod"], "contour")
        settings = app.extensions["terucon"]["settings"]()
        self.assertEqual(settings.edge_method, "contour")
        self.assertTrue(any("EDGE_METHOD" in w for w in settings.warnings), settings.warnings)

    def test_snapping_that_runs_out_of_time_leaves_the_outlines_as_drawn(self):
        with mock.patch.object(pipeline, "SNAP_BUDGET", 0.0):
            r, data = self.segment(self.client(), useSam=False)
        self.assertEqual(r.status_code, 200, data)
        self.assertTrue(any("Edge snapping was skipped for 8 of 8" in n for n in data["notes"]), data["notes"])
        self.assertTrue(all(m["source"] == "gemini" for m in data["metas"]))

    def test_a_snapping_error_never_takes_the_scan_down(self):
        with mock.patch.object(snap, "snap_mask", side_effect=RuntimeError("boom")):
            r, data = self.segment(self.client(), useSam=False)
        self.assertEqual(r.status_code, 200, data)
        self.assertTrue(any("Edge snapping was skipped" in n for n in data["notes"]), data["notes"])
        self.assertGreater(np.mean(list(self.scores(data).values())), 0.7)  # the outlines as drawn

    def test_gemini_errors_are_reported_with_their_status(self):
        err = {"error": {"code": 403, "status": "PERMISSION_DENIED", "message": "Caller does not have permission"}}
        self.mock.default_handler = lambda m, b, h: (403, err)
        r, data = self.segment(self.client())
        self.assertEqual(r.status_code, 403)
        self.assertIn("Vertex AI User", data["error"]["message"])

    def test_model_chain_skips_models_this_project_cannot_use(self):
        seen = []

        def handler(model, body, headers):
            seen.append(model)
            if model != "gemini-3.7-flash":
                return 404, {"error": {"code": 404, "status": "NOT_FOUND", "message": "model not found"}}
            return 200, text_response(json.dumps(self.gemini_json))

        self.mock.default_handler = handler
        r, data = self.segment(self.client(), useSam=False)
        self.assertEqual(r.status_code, 200, data)
        self.assertEqual(seen, ["gemini-3.8-flash", "gemini-3.7-flash"])
        self.assertEqual(data["model"], "gemini-3.7-flash")

    def test_models_that_reject_structured_output_get_a_simpler_request(self):
        shapes = []

        def handler(model, body, headers):
            gen = body["generationConfig"]
            shapes.append(("schema" if "responseSchema" in gen else "plain"))
            if "responseSchema" in gen:
                return 400, {"error": {"code": 400, "status": "INVALID_ARGUMENT", "message": "response schema not supported"}}
            return 200, text_response("```json\n" + json.dumps(self.gemini_json) + "\n```")

        self.mock.default_handler = handler
        r, data = self.segment(self.client(), useSam=False)
        self.assertEqual(r.status_code, 200, data)
        self.assertEqual(shapes, ["schema", "schema", "plain"])

    def test_empty_answer_is_a_readable_error(self):
        self.mock.default_handler = lambda m, b, h: (200, text_response('{"scene": "interior", "surfaces": []}'))
        r, data = self.segment(self.client())
        self.assertEqual(r.status_code, 422)
        self.assertIn("no surfaces", data["error"]["message"])

    def test_bad_image_is_rejected(self):
        c = self.client()
        r = c.post("/segment", data=json.dumps({"image": "not an image"}), headers=JSON)
        self.assertEqual(r.status_code, 400)

    def test_the_prompt_asks_for_facades_and_forbids_sky_and_trees(self):
        seen = {}
        self.mock.default_handler = lambda m, b, h: (seen.update(prompt=b["contents"][0]["parts"][1]["text"]) or 200, text_response(json.dumps(self.gemini_json)))
        self.segment(self.client(), useSam=False)
        p = seen["prompt"]
        self.assertIn("exterior", p)
        self.assertIn("facade", p)
        self.assertIn("Do NOT outline the sky", p)


class SamRoutesTests(PipelineHarness):
    def test_health_reflects_the_manager_state(self):
        c = self.client()
        self.assertEqual(c.get("/sam/health", headers=LOCAL).get_json()["status"], "off")
        sam = make_sam_manager({"x": self.gt == 1})
        h = self.client(sam=sam).get("/sam/health", headers=LOCAL).get_json()
        self.assertEqual(h["status"], "ok")
        self.assertTrue(h["interactive"])

    def test_refine_when_off_is_a_503_the_studio_understands(self):
        r = self.client().post("/sam/refine", data=json.dumps({"points": [[1, 1]], "labels": [1], "image": jpeg_b64(self.img)}), headers=JSON)
        self.assertEqual(r.status_code, 503)

    def test_refine_caches_the_embedding_by_image_id(self):
        truth = {n: (self.gt == i + 1).astype(np.uint8) for i, n in enumerate(self.labels)}
        sam = make_sam_manager(truth)
        c = self.client(sam=sam)
        r1 = c.post("/sam/refine", data=json.dumps({"image": jpeg_b64(self.img), "points": [[480, 400]], "labels": [1]}), headers=JSON)
        self.assertEqual(r1.status_code, 200, r1.get_data(as_text=True))
        d1 = r1.get_json()
        self.assertTrue(d1["image_id"])
        mask = np.array(Image.open(io.BytesIO(base64.b64decode(d1["mask"]))))
        self.assertEqual(mask.shape, self.gt.shape)
        r2 = c.post("/sam/refine", data=json.dumps({"image_id": d1["image_id"], "points": [[480, 400]], "labels": [1]}), headers=JSON)
        self.assertEqual(r2.status_code, 200)
        r3 = c.post("/sam/refine", data=json.dumps({"image_id": "gone", "points": [[1, 1]], "labels": [1]}), headers=JSON)
        self.assertEqual(r3.status_code, 409)  # the studio then re-sends the image

    def test_text_segment_is_501_for_backends_without_text(self):
        sam = make_sam_manager({"x": self.gt == 1})
        r = self.client(sam=sam).post("/sam/segment", data=json.dumps({"image": jpeg_b64(self.img), "prompts": ["wall"]}), headers=JSON)
        self.assertEqual(r.status_code, 501)
        self.assertIn("boxes and points", r.get_json()["error"]["message"])


class TextPromptedSamTests(PipelineHarness):
    def test_a_text_prompted_sam_refines_outlines_by_concept_and_ignores_decoys(self):
        by_kind: dict[str, list[np.ndarray]] = {}
        for i, (name, kind, _p, _c) in enumerate(syn.SURFACES, start=1):
            concept = {"furniture": "furniture"}.get(kind, kind)
            by_kind.setdefault(concept, []).append((self.gt == i).astype(np.uint8))
        fake = FakeTextSam(by_kind, self.gt.shape)
        cfg = SamConfig(enabled=True, preload=False, backend="sam3")
        sam = SamManager(cfg, backend_factory=lambda c: fake)
        sam._load()
        r, data = self.segment(self.client(sam=sam))
        self.assertEqual(r.status_code, 200, data)
        self.assertTrue(data["sam"]["used"])
        self.assertEqual(sorted(set(fake.asked)), ["ceiling", "door", "floor", "furniture", "wall", "window"])  # once per concept, not once per surface
        self.assertGreater(np.mean(list(self.scores(data).values())), 0.93)


class SettingsReloadTests(PipelineHarness):
    def test_switching_sam_on_in_env_needs_no_restart(self):
        c = support.make_app(self.tmp.name, {}).test_client()
        env = Path(self.tmp.name) / ".env"
        self.assertEqual(c.get("/health", headers=LOCAL).get_json()["sam"]["status"], "off")
        env.write_text("SAM_ENABLED=true\nSAM_BACKEND=remote\nSAM_REMOTE_URL=http://127.0.0.1:9/sam\n", encoding="utf-8")
        status = "off"
        for _ in range(60):  # the loader runs in the background and fails quickly: nothing listens on port 9
            status = c.get("/health", headers=LOCAL).get_json()["sam"]["status"]
            if status not in ("off", "idle", "loading"):
                break
            time.sleep(0.1)
        self.assertEqual(status, "error")


# SamServerKeyTests (SAM_SERVER_KEY gating /api/sam/*) moved to test_service.py: the service now has its own key and also
# takes SAM_SERVER_KEY on /sam/*, and the website keeps the old behaviour on /api/sam/*.


@unittest.skipUnless(os.environ.get("TERUCON_HEAVY_TESTS"), "set TERUCON_HEAVY_TESTS=1 to run the real SAM 2 model (downloads ~180 MB, CPU)")
class RealSamTests(PipelineHarness):
    def test_real_sam2_sharpens_rough_outlines_on_the_synthetic_room(self):
        cfg = SamConfig(enabled=True, preload=False, backend="sam2", model_id="facebook/sam2.1-hiera-small")
        sam = SamManager(cfg)
        sam._load()
        self.assertTrue(sam.ready, sam.status())
        self.gemini_json = syn.gemini_json(jitter=20.0, seed=4)
        r, data = self.segment(self.client(sam=sam))
        self.assertEqual(r.status_code, 200, data)
        self.assertTrue(data["sam"]["used"], data["notes"])
        got, raw = self.scores(data), self.raw_scores()
        print("\n  real SAM 2 mean IoU %.3f vs raw outlines %.3f | per surface: %s" % (np.mean(list(got.values())), np.mean(list(raw.values())), {k: round(v, 2) for k, v in got.items()}))
        self.assertGreater(np.mean(list(got.values())), np.mean(list(raw.values())))


if __name__ == "__main__":
    unittest.main()
