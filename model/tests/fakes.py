"""Stand-ins for SAM, shaped like the real backends (sam/backends.py), so the routes and the pipeline can be tested without PyTorch."""
from __future__ import annotations

import numpy as np

from terucon_model.config import SamConfig
from terucon_model.sam.backends import Candidate, ImageHandle
from terucon_model.sam.manager import SamManager


class FakeSam:
    """Stands in for SAM 2: returns the true mask plus two decoys (a more confident wrong sub-part, a wrong blob)."""

    kind, name, device = "fake", "Fake SAM", "cpu"
    interactive, text_prompts = True, False

    def __init__(self, truth: dict[str, np.ndarray]):
        self.truth = list(truth.values())
        self.calls = []

    def load(self):
        pass

    def embed(self, rgb):
        return ImageHandle(rgb.shape[0], rgb.shape[1], payload="emb")

    def predict(self, handle, box=None, points=None, labels=None, multimask=True):
        import cv2

        self.calls.append({"box": box, "points": points, "labels": labels})
        x0, y0, x1, y1 = box if box is not None else (0, 0, handle.width, handle.height)
        probe = np.zeros((handle.height, handle.width), bool)
        probe[int(y0) : int(y1), int(x0) : int(x1)] = True
        best = max(self.truth, key=lambda m: (m.astype(bool) & probe).sum() / max(1, (m.astype(bool) | probe).sum()))
        sub = cv2.erode(best.astype(np.uint8), np.ones((61, 61), np.uint8)).astype(bool)
        blob = np.zeros_like(best, bool)
        blob[int(y0) : int(y0 + (y1 - y0) / 3), int(x0) : int(x1)] = True
        return [Candidate(best.astype(bool), 0.88), Candidate(sub, 0.97), Candidate(blob, 0.40)]


def make_sam_manager(truth) -> SamManager:
    cfg = SamConfig(enabled=True, preload=False, backend="sam2")
    m = SamManager(cfg, backend_factory=lambda c: FakeSam(truth))
    m._load()  # synchronous for tests
    return m


class FakeTextSam:
    """Shaped like SAM 3: no boxes or clicks, answers a concept with every instance it finds (plus a decoy)."""

    kind, name, device = "fake3", "Fake SAM 3", "cpu"
    interactive, text_prompts = False, True

    def __init__(self, truth_by_kind: dict[str, list[np.ndarray]], shape):
        self.truth, self.shape, self.asked = truth_by_kind, shape, []

    def load(self):
        pass

    def embed(self, rgb):
        return ImageHandle(rgb.shape[0], rgb.shape[1], payload="emb")

    def segment_text(self, handle, prompts, threshold, max_per_prompt):
        self.asked.append(prompts[0])
        out = [{"prompt": prompts[0], "mask": m.astype(bool), "score": 0.9} for m in self.truth.get(prompts[0], [])]
        decoy = np.zeros(self.shape, bool)
        decoy[:60, :60] = True
        return out + [{"prompt": prompts[0], "mask": decoy, "score": 0.99}]
