"""Contour snapping (terucon_model/segment/snap.py): behaviour on small synthetic photos with exact ground truth.

Run:  python -m unittest discover -s model/tests -t model   (from the project root; see model/README.md)
"""
from __future__ import annotations

import sys
import time
import unittest
from pathlib import Path
from unittest import mock

import cv2
import numpy as np

MODEL_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(MODEL_DIR))

from terucon_model.segment import snap  # noqa: E402
from terucon_model.segment.geometry import iou  # noqa: E402

H, W = 480, 640


def photo(seed: int = 0, noise: float = 3.0, blur: float = 0.8):
    """a warm rectangle on a cool background, with noise; returns (rgb, truth mask)."""
    rng = np.random.default_rng(seed)
    img = np.full((H, W, 3), (70, 90, 120), np.float32)
    truth = np.zeros((H, W), np.uint8)
    truth[120:360, 160:480] = 1
    img[truth > 0] = (200, 170, 120)
    img += rng.normal(0, noise, img.shape)
    img = np.clip(img, 0, 255).astype(np.uint8)
    return cv2.GaussianBlur(img, (0, 0), blur), truth


def rect(x0, y0, x1, y1, h=H, w=W):
    m = np.zeros((h, w), np.uint8)
    m[y0:y1, x0:x1] = 1
    return m


class SnapBehaviour(unittest.TestCase):
    def test_a_drifted_outline_is_pulled_onto_the_real_edges(self):
        img, truth = photo()
        rough = rect(146, 130, 489, 348)  # off by 9-14 px on every side
        out = snap.snap_mask(snap.Evidence(img), rough)
        self.assertLess(iou(rough, truth), 0.9)
        self.assertGreater(iou(out, truth), 0.97, f"snapped IoU {iou(out, truth):.3f}, raw {iou(rough, truth):.3f}")

    def test_an_outline_that_is_already_right_barely_moves(self):
        img, truth = photo()
        out = snap.snap_mask(snap.Evidence(img), truth)
        self.assertGreater(iou(out, truth), 0.98)

    def test_without_evidence_the_outline_is_kept(self):
        rng = np.random.default_rng(1)
        flat = np.clip(np.full((H, W, 3), 128.0) + rng.normal(0, 3, (H, W, 3)), 0, 255).astype(np.uint8)
        rough = rect(160, 120, 480, 360)
        out = snap.snap_mask(snap.Evidence(flat), rough)
        self.assertGreater(iou(out, rough), 0.95, "nothing in the photo justified moving the boundary")

    def test_it_finds_a_boundary_that_is_not_a_sharp_edge(self):
        """two surfaces of similar brightness with a soft transition: the region cue has to do the work."""
        rng = np.random.default_rng(2)
        x = np.linspace(0, 1, W, dtype=np.float32)[None, :, None]
        ramp = 1.0 / (1.0 + np.exp(-(x - 0.5) * 60.0))  # a soft step about 25 px wide at x = 320
        left, right = np.array([150, 150, 150], np.float32), np.array([128, 150, 172], np.float32)
        img = np.clip(left * (1 - ramp) + right * ramp + np.zeros((H, 1, 1), np.float32) + rng.normal(0, 4, (H, W, 3)), 0, 255).astype(np.uint8)
        truth = rect(0, 0, 320, H)
        rough = rect(0, 0, 345, H)  # the boundary is 25 px too far right
        out = snap.snap_mask(snap.Evidence(img), rough)
        self.assertGreater(iou(out, truth), iou(rough, truth) + 0.01, f"raw {iou(rough, truth):.3f}, snapped {iou(out, truth):.3f}")

    def test_holes_are_kept_and_snapped_too(self):
        img, truth = photo()
        cv2.rectangle(img, (260, 200), (360, 280), (40, 140, 60), -1)  # a green panel on the warm surface
        solid = truth.copy()
        solid[200:281, 260:361] = 0  # the surface has a hole where the panel is
        rough = solid.copy()
        rough[190:290, 250:371] = 1
        rough[212:270, 272:349] = 0  # the hole is drawn too small
        out = snap.snap_mask(snap.Evidence(img), rough)
        self.assertEqual(int(out[240, 310]), 0, "the hole must still be a hole")
        self.assertEqual(int(out[150, 200]), 1)
        self.assertGreater(iou(out, solid), iou(rough, solid))

    def test_degenerate_masks_never_raise(self):
        img, _ = photo()
        ev = snap.Evidence(img)
        empty = np.zeros((H, W), np.uint8)
        one = empty.copy()
        one[100, 100] = 1
        thin = rect(100, 200, 500, 202)
        everything = np.ones((H, W), np.uint8)
        border = rect(0, 0, W, 60)
        two = rect(50, 50, 200, 200) | rect(400, 300, 600, 450)
        for name, m in [("empty", empty), ("one pixel", one), ("thin line", thin), ("whole frame", everything), ("touching the border", border), ("two blobs", two)]:
            out = snap.snap_mask(ev, m)
            self.assertEqual(out.shape, (H, W), name)
            self.assertEqual(out.dtype, np.uint8, name)
        self.assertEqual(int(snap.snap_mask(ev, empty).sum()), 0)
        self.assertGreater(int(snap.snap_mask(ev, everything).sum()), 0.9 * H * W)

    def test_the_same_photo_always_gives_the_same_answer(self):
        img, _ = photo()
        rough = rect(146, 130, 489, 348)
        a = snap.snap_mask(snap.Evidence(img), rough)
        b = snap.snap_mask(snap.Evidence(img), rough)
        self.assertTrue(np.array_equal(a, b))

    def test_a_surface_touching_the_frame_keeps_its_frame_edge(self):
        """the photo's own border is not an edge to retreat from."""
        rng = np.random.default_rng(3)
        img = np.full((H, W, 3), (70, 90, 120), np.float32)
        img[:, :400] = (200, 170, 120)
        img = np.clip(img + rng.normal(0, 3, img.shape), 0, 255).astype(np.uint8)
        truth = rect(0, 0, 400, H)
        rough = rect(0, 0, 385, H)
        out = snap.snap_mask(snap.Evidence(img), rough)
        self.assertGreater(iou(out, truth), 0.97)
        self.assertEqual(int(out[H // 2, 0]), 1)
        self.assertEqual(int(out[0, 10]), 1)
        self.assertEqual(int(out[H - 1, 10]), 1)

    def test_an_outline_that_stops_a_few_pixels_short_of_the_frame_is_extended_to_it(self):
        """a surface that runs to the edge of the photo does not end a few pixels before it."""
        rng = np.random.default_rng(5)
        img = np.full((H, W, 3), (70, 90, 120), np.float32)
        img[:300, :] = (200, 170, 120)  # a ceiling-like band across the top of the photo
        img = np.clip(img + rng.normal(0, 3, img.shape), 0, 255).astype(np.uint8)
        truth = rect(0, 0, W, 300)
        rough = rect(7, 6, W - 7, 296)  # stops 6-7 px short of the frame on three sides
        out = snap.snap_mask(snap.Evidence(img), rough)
        self.assertGreater(iou(out, truth), iou(rough, truth) + 0.01)
        self.assertEqual(int(out[150, 0]), 1)
        self.assertEqual(int(out[0, W // 2]), 1)
        self.assertEqual(int(out[150, W - 1]), 1)
        self.assertEqual(int(out[310, W // 2]), 0, "and it must not leak past its real lower edge")

    def test_a_surface_that_really_ends_before_the_frame_is_not_stretched_to_it(self):
        """a clear edge beats the pull of the frame."""
        rng = np.random.default_rng(6)
        img = np.full((H, W, 3), (70, 90, 120), np.float32)
        img[:, : W - 18] = (200, 170, 120)  # the surface ends 18 px before the right frame, at a sharp edge
        img = np.clip(img + rng.normal(0, 3, img.shape), 0, 255).astype(np.uint8)
        truth = rect(0, 0, W - 18, H)
        rough = rect(0, 0, W - 14, H)
        out = snap.snap_mask(snap.Evidence(img), rough)
        self.assertGreater(iou(out, truth), 0.98)
        self.assertEqual(int(out[H // 2, W - 6]), 0)

    def test_a_big_photo_is_snapped_at_working_resolution(self):
        big_h, big_w = 1200, 1600
        img = cv2.resize(photo()[0], (big_w, big_h), interpolation=cv2.INTER_CUBIC)
        truth = cv2.resize(photo()[1], (big_w, big_h), interpolation=cv2.INTER_NEAREST)
        rough = rect(int(146 * 2.5), int(130 * 2.5), int(489 * 2.5), int(348 * 2.5), big_h, big_w)
        ev = snap.Evidence(img)
        self.assertLess(ev.f, 1.0)
        self.assertEqual(min(ev.wh, ev.ww), snap.WORK_SHORT)
        out = snap.snap_mask(ev, rough)
        self.assertEqual(out.shape, (big_h, big_w))
        self.assertGreater(iou(out, truth), 0.96)

    def test_sams_boundary_counts_as_evidence(self):
        """no colour change at all, but SAM knows where the surface ends."""
        rng = np.random.default_rng(4)
        flat = np.clip(np.full((H, W, 3), 128.0) + rng.normal(0, 3, (H, W, 3)), 0, 255).astype(np.uint8)
        truth = rect(160, 120, 480, 360)
        rough = rect(150, 110, 490, 370)  # 10 px too big all round, inside the reach of the SAM preset (3% of the short side)
        ev = snap.Evidence(flat)
        with_sam = snap.snap_mask(ev, rough, truth, snap.WITH_SAM)
        without = snap.snap_mask(ev, rough)
        self.assertGreater(iou(with_sam, truth), iou(without, truth) + 0.03)
        self.assertGreater(iou(with_sam, truth), 0.95)


class SnapSafety(unittest.TestCase):
    def test_a_contour_that_fails_is_kept_as_it_was(self):
        img, truth = photo()
        with mock.patch.object(snap, "_snap_contour", side_effect=ValueError("boom")):
            out = snap.snap_mask(snap.Evidence(img), truth)
        self.assertGreater(iou(out, truth), 0.98)

    def test_a_result_that_collapses_is_thrown_away(self):
        img, truth = photo()
        rough = rect(146, 130, 489, 348)
        tiny = lambda ev, m8, pts, *a, **k: np.mean(pts, axis=0)[None, :] + (pts - np.mean(pts, axis=0)) * 0.05  # noqa: E731
        with mock.patch.object(snap, "_snap_contour", side_effect=tiny):
            out = snap.snap_mask(snap.Evidence(img), rough)
        self.assertTrue(np.array_equal(out, rough), "a collapsed surface must fall back to the mask it started from")

    def test_past_the_deadline_nothing_is_snapped(self):
        img, truth = photo()
        rough = rect(146, 130, 489, 348)
        out = snap.snap_mask(snap.Evidence(img), rough, deadline=time.perf_counter() - 1.0)
        self.assertGreater(iou(out, rough), 0.97)
        self.assertLess(iou(out, truth), 0.9)

    def test_only_the_biggest_contours_are_refined(self):
        img, _ = photo()
        many = np.zeros((H, W), np.uint8)
        for k in range(30):  # thirty separate blobs
            x, y = 20 + (k % 10) * 60, 20 + (k // 10) * 140
            many[y : y + 40, x : x + 40] = 1
        calls = []
        real = snap._snap_contour

        def spy(*a, **k):
            calls.append(1)
            return real(*a, **k)

        with mock.patch.object(snap, "_snap_contour", side_effect=spy):
            out = snap.snap_mask(snap.Evidence(img), many)
        self.assertLessEqual(len(calls), snap.MAX_CONTOURS)
        self.assertEqual(out.shape, (H, W))

    def test_viterbi_closes_the_chain_and_prefers_cheap_paths(self):
        k, m = 40, 21
        cost = np.zeros((k, m))
        cost[:, 14] = -1.0  # one cheap offset everywhere
        path = snap._viterbi_closed(cost, 0.1, 3)
        self.assertTrue(np.all(path == 14))
        # a jump costs: with a stiff chain a single cheap sample does not drag the path away
        cost = np.zeros((k, m))
        cost[:, 10] = -0.5
        cost[7, 18] = -1.0
        path = snap._viterbi_closed(cost, 1.0, 3)
        self.assertTrue(np.all(path == 10))


if __name__ == "__main__":
    unittest.main()
