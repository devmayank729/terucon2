"""Scene parsing with SegFormer (ADE20K, 150 indoor and outdoor classes).

The photo is scaled so its short side matches the model's tile size (640 px for B5, 512 for B2/B4), then read in
overlapping tiles. Class scores from every tile are averaged on a grid of 4 x 4 pixel cells
(SegFormer predicts at a quarter of the input size), optionally with a mirrored second pass,
and finally upsampled to the photo's size one band of rows at a time, so memory stays small.

Think of it like reading a wide newspaper through a small magnifying glass: you slide the
glass across in overlapping steps and keep notes for every part of the page, then combine
the notes into one clean copy.

The default engine is SegFormer-B5 ("b5-quant"). On an x86 CPU its Linear layers (attention and MLP, most of the maths)
run as dynamic INT8 when a timed pass at load proves that is faster (98-99% of pixels get the same class as fp32 in
tests/scene tests); on ARM (Apple Silicon) the INT8 kernels are slower than fp32 so it stays fp32; on a CUDA GPU it
runs in fp16, on Apple's MPS in fp32. "precision" in every answer says what actually ran. The tile buffers and score grids are allocated once per shape and reused, so a request after
the first one allocates almost nothing.
"""

import os
import threading
import time

import numpy as np
import torch
import torch.nn.functional as F
from PIL import Image, ImageOps
from transformers import AutoImageProcessor, SegformerForSemanticSegmentation

SCENE_MODELS = {
    "b2": "nvidia/segformer-b2-finetuned-ade-512-512",
    "b4": "nvidia/segformer-b4-finetuned-ade-512-512",
    "b5": "nvidia/segformer-b5-finetuned-ade-640-640",
}
# Names the browser and the API may send: "b5-quant" = SegFormer-B5 with INT8 / fp16 weights where the device allows.
QUANT_SUFFIXES = ("-quant", "_quant", "-int8", "-q8", "-quantized")
DEFAULT_MODEL = "b5-quant"
# If a model cannot be loaded (its weights cannot be downloaded, not enough disk), the model that served every scan
# before B5 became the default answers instead, and the response says so ("model", "fellBackFrom").
FALLBACK_FOR = {SCENE_MODELS["b5"]: "b4"}
# B5 needs more memory than B4: B4 in fp32 peaked at 1.6 GB resident in a measurement (torch and transformers account for
# about 350 MB of that), and B5 is bigger (82M parameters, 640 px tiles). The out-of-memory killer ends the process without
# any exception to catch, so B5 is only loaded where the memory limit is known and large enough (SCENE_B5_MIN_GB, 0 = never
# check). B5 has not been measured; this number is a cautious guess.
B5_MIN_MEMORY_GB = float(os.environ.get("SCENE_B5_MIN_GB", "3"))
# After a failed load, the same model is not retried for this long: every scan would otherwise wait for the failure.
LOAD_RETRY_S = 300

CELL = 4


# INT8 kernels worth using: the x86 ones. qnnpack (ARM, including Apple Silicon) is measured SLOWER than fp32 for this
# model (minutes per photo on an M-series Mac in the repo's own check), so it is never picked even though torch offers it.
FAST_INT8_ENGINES = ("fbgemm", "x86", "onednn")
# INT8 is kept only if it is at least this much faster than fp32 on a tile-sized input, measured when the model loads.
MIN_INT8_SPEEDUP = 1.15


def memory_limit_bytes():
    """The memory this process may use: the container limit (cgroup v2 or v1) or else the machine's RAM; None if unknown."""
    limits = []
    for path in ("/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"):
        try:
            with open(path) as handle:
                text = handle.read().strip()
            if text.isdigit():
                limits.append(int(text))
        except OSError:
            pass
    try:
        limits.append(os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES"))
    except (ValueError, OSError, AttributeError):
        pass
    return min(limits) if limits else None


def quantized_engine():
    """The x86 INT8 kernel backend this machine's torch has (fbgemm / x86 / onednn), or None (ARM, or no INT8 at all)."""
    supported = list(getattr(torch.backends.quantized, "supported_engines", []))
    for engine in FAST_INT8_ENGINES:
        if engine in supported:
            return engine
    return None


def quantize_linear_layers(model):
    """Dynamic INT8 on every nn.Linear (weights stored as int8, activations quantized on the fly). Returns a new
    model; the fp32 one is freed once the caller drops it."""
    engine = quantized_engine()
    if engine is None:
        raise RuntimeError("this machine has no fast INT8 kernels (x86 fbgemm / onednn)")
    torch.backends.quantized.engine = engine
    return torch.ao.quantization.quantize_dynamic(model, {torch.nn.Linear}, dtype=torch.qint8)


@torch.inference_mode()
def forward_seconds(model, tile, repeats=2):
    """Best-of-`repeats` time of one forward pass on a (1, 3, tile, tile) input, after one warm-up pass."""
    sample = torch.zeros((1, 3, tile, tile), dtype=torch.float32)
    model(pixel_values=sample)
    best = None
    for _ in range(repeats):
        started = time.perf_counter()
        model(pixel_values=sample)
        elapsed = time.perf_counter() - started
        best = elapsed if best is None else min(best, elapsed)
    return best


class BufferPool:
    """Reusable tensors. A buffer is made once for a (name, shape, dtype) and handed out again for the next request of
    the same size; asking for the same name at a new shape frees the old one, so a service that sees many photo sizes
    does not hoard memory."""

    def __init__(self):
        self.buffers = {}

    def get(self, name, shape, dtype=torch.float32, zero=False):
        key = (name, tuple(shape), dtype)
        buffer = self.buffers.get(key)
        if buffer is None:
            for other in [k for k in self.buffers if k[0] == name]:
                del self.buffers[other]
            buffer = torch.empty(tuple(shape), dtype=dtype)
            self.buffers[key] = buffer
        if zero:
            buffer.zero_()
        return buffer


class SceneParser:
    def __init__(self, device, flip_mode="auto"):
        self.device = device
        self.flip_mode = flip_mode
        self.models = {}
        self.lock = threading.Lock()
        # one photo at a time through the maths: it is CPU-bound, and the reused buffers below are shared
        self.compute_lock = threading.Lock()
        self.pool = BufferPool()
        self.load_failures = {}
        self.memory_noted = set()
        # SCENE_QUANTIZE=off keeps "b5-quant" requests in plain fp32 (if the INT8 answer is ever not good enough)
        self.quantize_allowed = os.environ.get("SCENE_QUANTIZE", "auto").strip().lower() not in ("off", "0", "false", "no")

    def resolve(self, name):
        """name -> (huggingface model id, wants INT8/fp16). Unknown names fall back to B4 as they always did."""
        raw = (name or "b4").strip()
        lowered = raw.lower()
        quantize = False
        for suffix in QUANT_SUFFIXES:
            if lowered.endswith(suffix):
                quantize = True
                lowered = lowered[: -len(suffix)]
                break
        if lowered in SCENE_MODELS:
            return SCENE_MODELS[lowered], quantize
        # Accept full ids too, including the browser names (Xenova/segformer-b2-...).
        for short, full in SCENE_MODELS.items():
            if lowered.endswith(full.split("/")[-1].lower()) or ("segformer-" + short) in lowered:
                return full, quantize
        return SCENE_MODELS["b4"], quantize

    def model_id(self, name):
        return self.resolve(name)[0]

    def prepare(self, model, quantize, tile=512):
        """-> (model on its device, precision). INT8 only exists on the CPU, only the x86 kernels are fast, and it is
        kept only when a timed forward pass proves it is faster than fp32 here; a GPU gets fp16, MPS stays fp32."""
        if quantize and self.quantize_allowed:
            if self.device.type == "cpu":
                try:
                    fast = quantize_linear_layers(model).eval()
                    plain = forward_seconds(model, tile)
                    int8 = forward_seconds(fast, tile)
                    if int8 * MIN_INT8_SPEEDUP <= plain:
                        print(f"INT8 weights: {int8:.2f}s per tile vs {plain:.2f}s fp32, using INT8")
                        return fast, "int8"
                    print(f"INT8 weights: {int8:.2f}s per tile vs {plain:.2f}s fp32, not faster here, using fp32")
                except Exception as error:  # no fast INT8 kernels in this torch: plain fp32 still works
                    print("INT8 quantization unavailable, using fp32:", error)
            elif self.device.type == "cuda":
                return model.half().to(self.device).eval(), "fp16"
        return model.to(self.device).eval(), "fp32"

    def load(self, name):
        model_id, quantize = self.resolve(name)
        key = model_id + ("#quant" if quantize and self.quantize_allowed else "")
        with self.lock:
            if key not in self.models:
                processor = AutoImageProcessor.from_pretrained(model_id)
                model = SegformerForSemanticSegmentation.from_pretrained(model_id)
                model.eval()
                size = processor.size or {}
                tile = int(size.get("height") or size.get("shortest_edge") or size.get("width") or 512)
                model, precision = self.prepare(model, quantize, tile)
                self.models[key] = (processor, model, precision)
        return model_id, self.models[key]

    def load_or_fallback(self, name):
        """-> (model id, (processor, model, precision), the model id it replaced or None). B5 that cannot be loaded
        becomes B4 instead of a scan with no segmentation at all."""
        model_id, quantize = self.resolve(name)
        backup = FALLBACK_FOR.get(model_id)
        if backup is None:
            return (*self.load(name), None)
        limit = memory_limit_bytes()
        too_small = B5_MIN_MEMORY_GB > 0 and limit is not None and limit < B5_MIN_MEMORY_GB * 1024 ** 3
        if too_small:
            if model_id not in self.memory_noted:
                self.memory_noted.add(model_id)
                print(f"Scene model {model_id} needs about {B5_MIN_MEMORY_GB:g} GB and this service may use "
                      f"{limit / 1024 ** 3:.1f} GB; using {backup} (SCENE_B5_MIN_GB=0 tries B5 anyway)")
        elif time.monotonic() - self.load_failures.get(model_id, -LOAD_RETRY_S) >= LOAD_RETRY_S:
            try:
                return (*self.load(name), None)
            except Exception as error:
                self.load_failures[model_id] = time.monotonic()
                print(f"Scene model {model_id} could not be loaded ({error}); using {backup} for the next "
                      f"{LOAD_RETRY_S} s")
        return (*self.load(backup + ("-quant" if quantize else "")), model_id)

    def loaded(self):
        return list(self.models.keys())

    def use_flip(self):
        if self.flip_mode == "on":
            return True
        if self.flip_mode == "off":
            return False
        return self.device.type != "cpu"

    @torch.inference_mode()
    def segment(self, image, name):
        """Returns (class_map uint8 [H, W] with 1-based label numbers, labels, info)."""
        started = time.time()
        model_id, triple, fell_back_from = self.load_or_fallback(name)
        # Time spent getting the model ready (download, read from disk, or waiting for another
        # request that is loading it): this service's cold start, which is not scanning time.
        load_ms = round((time.time() - started) * 1000)
        processor, model, precision = triple
        with self.compute_lock:
            result = self.run(image, model_id, processor, model, precision, started, load_ms)
        if fell_back_from:
            result[2]["fellBackFrom"] = fell_back_from
        return result

    def run(self, image, model_id, processor, model, precision, started, load_ms):
        image = ImageOps.exif_transpose(image).convert("RGB")
        width, height = image.size
        id2label = model.config.id2label
        class_count = len(id2label)

        size = processor.size or {}
        tile = int(size.get("height") or size.get("shortest_edge") or size.get("width") or 512)
        scale = tile / min(width, height)
        scaled_width = max(tile, round(width * scale))
        scaled_height = max(tile, round(height * scale))
        scaled = image.resize((scaled_width, scaled_height), Image.BICUBIC)

        flips = [False, True] if self.use_flip() else [False]
        overlap = 0.66 if self.device.type != "cpu" else 0.9

        def starts(length):
            if length <= tile:
                return [0]
            count = int(np.ceil((length - tile) / (tile * overlap))) + 1
            return [round(index * (length - tile) / (count - 1)) for index in range(count)]

        grid_width = int(np.ceil(scaled_width / CELL))
        grid_height = int(np.ceil(scaled_height / CELL))
        scores = self.pool.get("scores", (class_count, grid_height, grid_width), zero=True)
        hits = self.pool.get("hits", (grid_height, grid_width), zero=True)

        mean = torch.tensor(processor.image_mean, dtype=torch.float32).view(3, 1, 1)
        std = torch.tensor(processor.image_std, dtype=torch.float32).view(3, 1, 1)
        pixels = torch.from_numpy(np.asarray(scaled, dtype=np.float32) / 255.0).permute(2, 0, 1)
        pixels = (pixels - mean) / std

        tiles = []
        for top in starts(scaled_height):
            for left in starts(scaled_width):
                for flip in flips:
                    tiles.append((top, left, flip))

        batch_size = 4 if self.device.type != "cpu" else 2
        input_dtype = torch.float16 if precision == "fp16" else torch.float32
        # the tile batch is filled in place: no torch.stack, no new (batch, 3, tile, tile) tensor per group
        tile_buffer = self.pool.get("tiles", (batch_size, 3, tile, tile))
        for first in range(0, len(tiles), batch_size):
            group = tiles[first:first + batch_size]
            for slot, (top, left, flip) in enumerate(group):
                crop = pixels[:, top:top + tile, left:left + tile]
                if flip:
                    crop = torch.flip(crop, dims=[2])
                tile_buffer[slot].copy_(crop)
            batch = tile_buffer[: len(group)].to(self.device, dtype=input_dtype)
            logits = model(pixel_values=batch).logits.float().cpu()
            for index, (top, left, flip) in enumerate(group):
                values = logits[index]
                if flip:
                    values = torch.flip(values, dims=[2])
                logit_height = values.shape[1]
                logit_width = values.shape[2]
                step_y = tile / logit_height
                step_x = tile / logit_width
                rows = ((top + (torch.arange(logit_height) + 0.5) * step_y) / CELL).long()
                columns = ((left + (torch.arange(logit_width) + 0.5) * step_x) / CELL).long()
                keep_rows = rows < grid_height
                keep_columns = columns < grid_width
                values = values[:, keep_rows][:, :, keep_columns]
                rows = rows[keep_rows]
                columns = columns[keep_columns]
                usable = min(class_count, values.shape[0])
                # Every logit cell maps to exactly one grid cell (both are 4 px apart).
                scores[:usable, rows[:, None], columns[None, :]] += values[:usable]
                hits[rows[:, None], columns[None, :]] += 1

        covered = hits > 0
        averaged = scores.div_(torch.clamp(hits, min=1))   # in place: the buffer is zeroed again for the next photo

        # Upsample to the photo size in bands of rows, then take the best class.
        factor_x = scaled_width / width / CELL
        factor_y = scaled_height / height / CELL
        grid_x = torch.clamp((torch.arange(width, dtype=torch.float32) + 0.5) * factor_x - 0.5, 0, grid_width - 1)
        x0 = grid_x.floor().long()
        x1 = torch.clamp(x0 + 1, max=grid_width - 1)
        weight_x = (grid_x - x0.float()).view(1, 1, -1)
        best = torch.zeros((height, width), dtype=torch.int64)
        band = 48
        for band_top in range(0, height, band):
            band_rows = torch.arange(band_top, min(height, band_top + band), dtype=torch.float32)
            grid_y = torch.clamp((band_rows + 0.5) * factor_y - 0.5, 0, grid_height - 1)
            y0 = grid_y.floor().long()
            y1 = torch.clamp(y0 + 1, max=grid_height - 1)
            weight_y = (grid_y - y0.float()).view(1, -1, 1)
            top_rows = averaged[:, y0]
            bottom_rows = averaged[:, y1]
            rows_mixed = top_rows * (1 - weight_y) + bottom_rows * weight_y
            mixed = rows_mixed[:, :, x0] * (1 - weight_x) + rows_mixed[:, :, x1] * weight_x
            best[band_top:band_top + len(band_rows)] = mixed.argmax(dim=0)

        # Pixels whose grid cells were never covered get no class.
        covered_pixels = covered[
            torch.clamp(((torch.arange(height) + 0.5) * factor_y).long(), max=grid_height - 1)[:, None],
            torch.clamp(((torch.arange(width) + 0.5) * factor_x).long(), max=grid_width - 1)[None, :],
        ]

        best_numpy = best.numpy()
        present = np.unique(best_numpy[covered_pixels.numpy()])
        labels = []
        number_of_class = np.zeros(class_count, dtype=np.uint8)
        for class_index in present:
            labels.append(id2label.get(int(class_index), id2label.get(str(int(class_index)), "class " + str(int(class_index)))))
            number_of_class[class_index] = len(labels)
        class_map = number_of_class[best_numpy]
        class_map[~covered_pixels.numpy()] = 0
        total_ms = round((time.time() - started) * 1000)
        info = {
            "model": model_id,
            "device": self.device.type,
            "precision": precision,
            "tiles": len(tiles),
            "ms": total_ms,
            "loadMs": load_ms,
            "inferMs": max(0, total_ms - load_ms),
        }
        return class_map.astype(np.uint8), labels, info
