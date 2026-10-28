"""The Pick tool: tap a point on the photo and get the outline of the thing under it.

SAM (Segment Anything) works in two steps, a bit like a librarian who first reads the whole
book (the slow "embedding" step, done once per photo) and can then answer any question
about a page instantly (the fast "mask" step, done for every tap).
"""

import threading
import time
from collections import OrderedDict

import numpy as np
import torch
from PIL import ImageOps
from transformers import SamModel, SamProcessor

DEFAULT_PICK_MODEL = "nielsr/slimsam-50-uniform"
FALLBACK_PICK_MODEL = "nielsr/slimsam-77-uniform"
CACHE_SIZE = 4


class PickTool:
    def __init__(self, device, model_id=None):
        self.device = device
        self.model_id = model_id or DEFAULT_PICK_MODEL
        self.model = None
        self.processor = None
        self.cache = OrderedDict()
        self.lock = threading.Lock()

    def load(self):
        with self.lock:
            if self.model is not None:
                return
            tried = [self.model_id]
            if self.model_id != FALLBACK_PICK_MODEL:
                tried.append(FALLBACK_PICK_MODEL)
            last_error = None
            for model_id in tried:
                try:
                    self.processor = SamProcessor.from_pretrained(model_id)
                    model = SamModel.from_pretrained(model_id)
                    model.to(self.device)
                    model.eval()
                    self.model = model
                    self.model_id = model_id
                    return
                except Exception as error:  # try the next model
                    last_error = error
            raise RuntimeError("Could not load the Pick model: " + str(last_error))

    def loaded(self):
        return self.model is not None

    @torch.inference_mode()
    def embed(self, key, image):
        """Read the whole photo once and keep the result under `key`."""
        self.load()
        if key in self.cache:
            self.cache.move_to_end(key)
            return {"cached": True, "ms": 0}
        started = time.time()
        image = ImageOps.exif_transpose(image).convert("RGB")
        inputs = self.processor(images=image, return_tensors="pt")
        embeddings = self.model.get_image_embeddings(inputs["pixel_values"].to(self.device))
        self.cache[key] = {
            "embeddings": embeddings,
            "original_sizes": inputs["original_sizes"],
            "reshaped_input_sizes": inputs["reshaped_input_sizes"],
            "width": image.size[0],
            "height": image.size[1],
        }
        while len(self.cache) > CACHE_SIZE:
            self.cache.popitem(last=False)
        return {"cached": False, "ms": round((time.time() - started) * 1000)}

    def has(self, key):
        return key in self.cache

    @torch.inference_mode()
    def mask(self, key, points, labels, box=None):
        """points: [[x, y], ...] in pixels of the embedded photo; labels: 1 keep, 0 exclude. box: optional
        [x0, y0, x1, y1] in the same pixels - a box prompt SAM combines with the points (the tap-to-calibrate step
        sends the surface's own box so SAM looks for "this surface", not for the smallest thing under the tap)."""
        entry = self.cache.get(key)
        if entry is None:
            raise KeyError("The Pick tool is not ready for this photo yet.")
        if not points:
            raise ValueError("Tap at least one point.")
        scale_y = entry["reshaped_input_sizes"][0][0].item() / entry["original_sizes"][0][0].item()
        scale_x = entry["reshaped_input_sizes"][0][1].item() / entry["original_sizes"][0][1].item()
        # Points go to the model in the resized (1024 px) frame: shape [batch, point_batch, points, 2].
        input_points = torch.tensor(
            [[[[float(point[0]) * scale_x, float(point[1]) * scale_y] for point in points]]],
            dtype=torch.float32,
        )
        input_labels = torch.tensor([[[int(label) for label in labels]]], dtype=torch.int64)
        arguments = {}
        if box is not None:
            if len(box) != 4:
                raise ValueError("A box needs four numbers: x0, y0, x1, y1.")
            x0, y0, x1, y1 = (float(v) for v in box)
            if x1 <= x0 or y1 <= y0:
                raise ValueError("The box is empty.")
            # shape [batch, boxes, 4]
            arguments["input_boxes"] = torch.tensor(
                [[[x0 * scale_x, y0 * scale_y, x1 * scale_x, y1 * scale_y]]], dtype=torch.float32
            ).to(self.device)
        outputs = self.model(
            image_embeddings=entry["embeddings"],
            input_points=input_points.to(self.device),
            input_labels=input_labels.to(self.device),
            multimask_output=True,
            **arguments,
        )
        masks = self.processor.image_processor.post_process_masks(
            outputs.pred_masks.cpu(),
            entry["original_sizes"],
            entry["reshaped_input_sizes"],
        )
        scores = outputs.iou_scores.cpu().numpy().reshape(-1)
        best = int(np.argmax(scores))
        chosen = masks[0].reshape(-1, masks[0].shape[-2], masks[0].shape[-1])[best]
        mask = chosen.numpy().astype(np.uint8)
        return mask, float(scores[best])
