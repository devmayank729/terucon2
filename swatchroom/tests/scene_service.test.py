"""Checks the local scene service without any model download: model-name resolution (b5-quant must be SegFormer-B5, not
silently B4), the INT8 decision, buffer reuse, and POST /scene/segment?model=... with a tiny randomly initialised
SegFormer. Run from anywhere with a Python that has torch, transformers, fastapi, httpx, python-multipart, pillow:

    python tests/scene_service.test.py
"""
import io
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "python"))
os.environ.setdefault("SCENE_PRELOAD", "off")
os.environ["MODEL_DEVICE"] = "cpu"

try:
    import numpy as np
    import torch
    from fastapi.testclient import TestClient
    from PIL import Image
    from transformers import SegformerConfig, SegformerForSemanticSegmentation

    import app as service  # noqa: E402
    import scene  # noqa: E402
except (ImportError, RuntimeError) as error:
    print("SKIP scene_service.test.py: " + str(error))
    sys.exit(0)

failures = []


def check(name, condition, detail=""):
    print(("PASS " if condition else "FAIL ") + name + (f"  [{detail}]" if detail and not condition else ""))
    if not condition:
        failures.append(name)


B5, B4, B2 = scene.SCENE_MODELS["b5"], scene.SCENE_MODELS["b4"], scene.SCENE_MODELS["b2"]
parser = scene.SceneParser(torch.device("cpu"))

# ---- name resolution: the bug the advisor flagged was "b5-quant" falling through to B4
for name, expected in (
    ("b5-quant", (B5, True)), ("B5-QUANT", (B5, True)), ("b5", (B5, False)), ("b5_quant", (B5, True)),
    ("b4", (B4, False)), ("b4-quant", (B4, True)), ("b2", (B2, False)),
    ("nvidia/segformer-b5-finetuned-ade-640-640", (B5, False)),
    ("Xenova/segformer-b2-finetuned-ade-512-512", (B2, False)),
    ("garbage", (B4, False)), (None, (B4, False)), ("", (B4, False)),
):
    check(f"resolve({name!r}) -> {expected[0].split('/')[-1][:24]}, quantize={expected[1]}", parser.resolve(name) == expected,
          str(parser.resolve(name)))
check("the default model is B5 with INT8 weights where possible", scene.DEFAULT_MODEL == "b5-quant")

# ---- INT8 is only ever picked where it is fast
engine = scene.quantized_engine()
check("qnnpack (ARM) is never chosen: it is slower than fp32 for this model", engine in (None, "fbgemm", "x86", "onednn"), str(engine))

# ---- a tiny SegFormer stands in for B5
torch.manual_seed(0)
config = SegformerConfig(depths=[1, 1, 1, 1], hidden_sizes=[8, 16, 32, 64], num_attention_heads=[1, 1, 2, 2],
                         decoder_hidden_size=32, num_labels=150)
config.id2label = {i: f"class{i}" for i in range(150)}
tiny = SegformerForSemanticSegmentation(config).eval()


class FakeProcessor:
    size = {"height": 64, "width": 64}
    image_mean = [0.5, 0.5, 0.5]
    image_std = [0.25, 0.25, 0.25]


def inject(name):
    model_id, quantize = parser.resolve(name)
    key = model_id + ("#quant" if quantize and parser.quantize_allowed else "")
    parser.models[key] = (FakeProcessor(), tiny, "fp32")


inject("b5-quant")
photo = Image.fromarray(np.random.default_rng(1).integers(0, 255, (90, 140, 3), dtype=np.uint8))
class_map, labels, info = parser.segment(photo, "b5-quant")
check("segment returns a class map the photo's size", class_map.shape == (90, 140) and class_map.dtype == np.uint8)
check("labels are the compact 1-based list the browser expects", class_map.max() <= len(labels) and len(labels) >= 1)
check("info says which model and precision ran", info["model"] == B5 and info["precision"] in ("fp32", "int8", "fp16"), str(info))

pointer = parser.pool.buffers[next(k for k in parser.pool.buffers if k[0] == "scores")].data_ptr()
tiles_pointer = parser.pool.buffers[next(k for k in parser.pool.buffers if k[0] == "tiles")].data_ptr()
class_map2, _, _ = parser.segment(photo, "b5-quant")
pointer2 = parser.pool.buffers[next(k for k in parser.pool.buffers if k[0] == "scores")].data_ptr()
tiles_pointer2 = parser.pool.buffers[next(k for k in parser.pool.buffers if k[0] == "tiles")].data_ptr()
check("the score grid and the tile buffer are allocated once and reused for the next photo of the same size",
      pointer == pointer2 and tiles_pointer == tiles_pointer2)
check("reusing the buffers does not change the answer (they are zeroed each time)", np.array_equal(class_map, class_map2))
other = Image.fromarray(np.zeros((120, 200, 3), np.uint8))
parser.segment(other, "b5-quant")
check("a photo of a new size replaces the old buffers instead of hoarding both",
      len([k for k in parser.pool.buffers if k[0] == "scores"]) == 1)

# ---- B5 that cannot be loaded (weights not downloadable, disk full) must not leave the scan without a segmentation
fallback_parser = scene.SceneParser(torch.device("cpu"))
attempts = []
real_load = fallback_parser.load


def flaky_load(name):
    model_id, _ = fallback_parser.resolve(name)
    attempts.append(model_id)
    if model_id == B5:
        raise OSError("403 Forbidden while downloading the weights")
    return real_load(name)


fallback_parser.load = flaky_load
b4_model_id, _ = fallback_parser.resolve("b4-quant")
fallback_parser.models[b4_model_id + ("#quant" if fallback_parser.quantize_allowed else "")] = (FakeProcessor(), tiny, "fp32")
_, _, fell_info = fallback_parser.segment(photo, "b5-quant")
check("a B5 that cannot be loaded is answered by B4, and the answer says so",
      fell_info["model"] == B4 and fell_info.get("fellBackFrom") == B5, str(fell_info))
before = attempts.count(B5)
fallback_parser.segment(photo, "b5-quant")
check("the failed load is not retried on every scan (a minute-long download failure would stall each one)",
      attempts.count(B5) == before, str(attempts))
fallback_parser.load_failures[B5] -= scene.LOAD_RETRY_S + 1
fallback_parser.segment(photo, "b5-quant")
check("it is retried after the pause", attempts.count(B5) == before + 1, str(attempts))
_, _, direct_info = fallback_parser.segment(photo, "b4-quant")
check("a request for B4 itself carries no fallback note", "fellBackFrom" not in direct_info)
# a service whose memory limit is below what B5 needs does not try B5 at all (an out-of-memory kill has no exception to catch)
small = scene.SceneParser(torch.device("cpu"))
small_attempts = []
small_load = small.load
small.load = lambda name: (small_attempts.append(small.resolve(name)[0]) or small_load(name))
small.models[b4_model_id + ("#quant" if small.quantize_allowed else "")] = (FakeProcessor(), tiny, "fp32")
real_limit = scene.memory_limit_bytes
scene.memory_limit_bytes = lambda: 2 * 1024 ** 3
_, _, small_info = small.segment(photo, "b5-quant")
check("with a 2 GB limit B5 is never loaded, B4 answers and says so",
      B5 not in small_attempts and small_info["model"] == B4 and small_info.get("fellBackFrom") == B5, str(small_attempts))
scene.memory_limit_bytes = lambda: 8 * 1024 ** 3
roomy = scene.SceneParser(torch.device("cpu"))
roomy_attempts = []
roomy.load = lambda name: (roomy_attempts.append(roomy.resolve(name)[0]) or (_ for _ in ()).throw(OSError("stub: no download in tests")))
try:
    roomy.load_or_fallback("b5-quant")
except OSError:
    pass
check("with 8 GB the same request does try B5 first (stubbed here: nothing is downloaded)", roomy_attempts[:1] == [B5], str(roomy_attempts))
scene.memory_limit_bytes = real_limit
check("memory_limit_bytes returns a positive number or None", (scene.memory_limit_bytes() or 1) > 0)

broken = scene.SceneParser(torch.device("cpu"))
broken.load = lambda name: (_ for _ in ()).throw(OSError("disk full"))
try:
    broken.segment(photo, "b5-quant")
    check("if the fallback cannot load either, the error is raised (HTTP 500 with the reason)", False)
except OSError:
    check("if the fallback cannot load either, the error is raised (HTTP 500 with the reason)", True)

# ---- the HTTP route: model from the query string, the form, or the default
seen = []
service.scene_parser.segment = lambda image, name: (seen.append(name) or (np.ones((10, 12), np.uint8), ["wall"],
                                                       {"model": B5, "device": "cpu", "precision": "fp32", "tiles": 1,
                                                        "ms": 1, "loadMs": 0, "inferMs": 1}))
client = TestClient(service.app)
buffer = io.BytesIO()
Image.fromarray(np.zeros((20, 24, 3), np.uint8)).save(buffer, "JPEG")
jpeg = buffer.getvalue()
r = client.post("/scene/segment?model=b5-quant", files={"image": ("p.jpg", jpeg, "image/jpeg")})
check("POST /scene/segment?model=b5-quant works and passes the name on", r.status_code == 200 and seen[-1] == "b5-quant", r.text[:200])
body = r.json()
check("the response keeps the schema scene.worker.js reads (width, height, classMap, classLabels) and adds precision",
      body["width"] == 12 and body["height"] == 10 and body["classLabels"] == ["wall"] and "classMap" in body
      and body["precision"] == "fp32")
r = client.post("/scene/segment", files={"image": ("p.jpg", jpeg, "image/jpeg")}, data={"model": "b2"})
check("the form field still works (older clients)", seen[-1] == "b2")
r = client.post("/scene/segment", files={"image": ("p.jpg", jpeg, "image/jpeg")})
check("no model given -> the default (B5, INT8 where fast)", seen[-1] == "b5-quant")

print()
if failures:
    print(f"{len(failures)} check(s) FAILED: {failures}")
    sys.exit(1)
print("all scene service checks passed")
