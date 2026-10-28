"""Checks modalBlueprint.py's HTTP layer without a GPU, a network or a Modal account: the real FastAPI apps are built
with fake engines and driven with Starlette's TestClient.

    python tests/modal_blueprint.test.py        (needs the `modal`, `fastapi`, `httpx`, `python-multipart`,
                                                 `numpy`, `pillow` and `opencv-python-headless` packages)

It never deploys or calls anything on Modal; importing the blueprint only builds image *descriptions*.
"""
import importlib.util
import io
import json
import os
import subprocess
import sys
import zipfile

KEY = "k" * 32
os.environ["API_KEYS"] = KEY
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BLUEPRINT = os.path.join(REPO, "modalBlueprint.py")

try:
    import modal  # noqa: F401  (the blueprint imports it)
    import multipart  # noqa: F401  (FastAPI forms)
    import numpy as np
    from fastapi.testclient import TestClient
    from PIL import Image
except (ImportError, RuntimeError) as error:   # the npm test chain runs this file only when the Python extras exist
    print("SKIP modal_blueprint.test.py: " + str(error))
    sys.exit(0)


def load_blueprint(layout=None):
    if layout:
        os.environ["VISION_LAYOUT"] = layout
    else:
        os.environ.pop("VISION_LAYOUT", None)
    spec = importlib.util.spec_from_file_location("modalBlueprint", BLUEPRINT)
    module = importlib.util.module_from_spec(spec)
    sys.modules["modalBlueprint"] = module
    spec.loader.exec_module(module)
    return module


bp = load_blueprint()
failures = []


def check(name, condition, detail=""):
    print(("PASS " if condition else "FAIL ") + name + (f"  [{detail}]" if detail and not condition else ""))
    if not condition:
        failures.append(name)


# ---------------------------------------------------------------- layouts
check("default layout deploys the combined pool next to the four dedicated ones", bp.VISION_LAYOUT == "both"
      and bp.WANT_SPLIT and bp.WANT_COMBINED and "vision" in bp.DEPLOYED_SERVICES and "moge2" in bp.DEPLOYED_SERVICES)
check("prime / warm window act on the combined pool only when it exists", bp.PRIMED_SERVICES == ["vision"],
      str(bp.PRIMED_SERVICES))
for layout, expect_split, expect_combined in (("combined", False, True), ("split", True, False)):
    code = (
        "import importlib.util, os, sys\n"
        f"os.environ['API_KEYS']='{KEY}'; os.environ['VISION_LAYOUT']='{layout}'\n"
        f"spec = importlib.util.spec_from_file_location('m', r'{BLUEPRINT}')\n"
        "m = importlib.util.module_from_spec(spec); sys.modules['m'] = m; spec.loader.exec_module(m)\n"
        "print(json.dumps({'split': hasattr(m, 'MoGe2'), 'combined': hasattr(m, 'VisionAll'), "
        "'primed': m.PRIMED_SERVICES}))\n"
    ).replace("print(json", "import json; print(json")
    out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True)
    try:
        got = json.loads(out.stdout.strip().splitlines()[-1])
    except Exception:
        got = {"error": out.stderr[-300:]}
    check(f"layout {layout}: dedicated classes {expect_split}, VisionAll {expect_combined}",
          got.get("split") == expect_split and got.get("combined") == expect_combined, str(got))
bad = subprocess.run([sys.executable, "-c", "import os;os.environ['VISION_LAYOUT']='nope';os.environ['API_KEYS']='" + KEY
                      + "';import importlib.util as u;s=u.spec_from_file_location('m',r'" + BLUEPRINT
                      + "');m=u.module_from_spec(s);s.loader.exec_module(m)"], capture_output=True, text=True)
check("an unknown layout is refused", bad.returncode != 0 and "VISION_LAYOUT" in bad.stderr)

check("VisionAll has a GPU list and room for a designer's scan and analysis side by side",
      bp.SERVICES["vision"]["gpu"][0] in ("L40S", "L4") and bp.SERVICES["vision"]["target_inputs"] >= 4)
check("gpu_rank understands the combined pool", bp.gpu_rank("vision", "NVIDIA L40S") == 0
      and bp.gpu_rank("vision", "NVIDIA L4") == 2)


# ---------------------------------------------------------------- fake engines
H, W = 48, 64


class FakeMoge:
    def info(self):
        return {"model": "fake-moge", "gpu": "NVIDIA L40S"}

    def infer(self, rgb, resolution_level, fov_x, apply_mask):
        h, w = rgb.shape[:2]
        return {"points": np.zeros((h, w, 3), np.float32), "depth": np.full((h, w), 3.0, np.float32),
                "mask": np.ones((h, w), bool),
                "intrinsics": np.array([[0.9, 0, 0.5], [0, 1.2, 0.5], [0, 0, 1]], np.float32),
                "normal": np.zeros((h, w, 3), np.float32)}


class FakePipe:
    default_denoising_steps = 4
    target_properties = {"target_names": ["albedo", "shading", "residual"]}


class FakeMarigold:
    def __init__(self, keys=("lighting",)):
        self.pipes = {key: FakePipe() for key in keys}

    def info(self):
        return {"models": {"lighting": {}}, "gpu": "NVIDIA L40S"}

    def infer(self, key, rgb, steps, ensemble, resolution, seed):
        h, w = rgb.shape[:2]
        return np.full((3, h, w, 3), 0.5, np.float32)

    def render(self, key, prediction):
        h, w = prediction.shape[1:3]
        return {"albedo": np.full((h, w, 3), 90, np.uint8), "shading": np.full((h, w, 3), 200, np.uint8),
                "residual": np.full((h, w, 3), 10, np.uint8)}


class FakeSam3:
    def info(self):
        return {"model": "fake-sam3", "gpu": "NVIDIA L40S"}

    def infer(self, rgb, prompts, boxes, threshold, max_instances, want_masks):
        h, w = rgb.shape[:2]
        out = []
        for prompt in prompts:
            mask = np.zeros((1, h, w), bool)
            mask[0, : h // 2, :] = True
            out.append({"prompt": prompt, "scores": np.array([0.9], np.float32),
                        "boxes": np.array([[0, 0, w, h // 2]], np.float32), "masks": mask})
        return out


class FakeOneFormer:
    meta = {"shortest_edge": 640}
    NAMES = ["wall", "building, edifice", "sky", "floor, flooring"]

    def info(self):
        return {"model": "fake-oneformer", "gpu": "NVIDIA L40S"}

    def short_name(self, class_id):
        return self.NAMES[class_id % len(self.NAMES)].split(",")[0]

    def class_table(self):
        return [{"id": i, "label": self.short_name(i), "name": n, "isthing": False} for i, n in enumerate(self.NAMES)]

    def infer(self, rgb, tasks, resolution, threshold, overlap, max_instances, want_masks, tta):
        h, w = rgb.shape[:2]
        labels = np.zeros((h, w), np.uint8)
        labels[h // 2:, :] = 3
        counts = np.zeros(150, np.int64)
        counts[0], counts[3] = (h // 2) * w, (h - h // 2) * w
        res = {"processed_size": [w, h]}
        if "semantic" in tasks:
            res["semantic"] = {"label_map": labels, "counts": counts}
        if "panoptic" in tasks:
            res["panoptic"] = {"segment_map": (labels > 0).astype(np.uint8) + 1,
                               "segments": [{"id": 1, "label_id": 0, "isthing": False, "score": 0.9,
                                             "area": (h // 2) * w, "box": [0, 0, w, h // 2]},
                                            {"id": 2, "label_id": 3, "isthing": False, "score": 0.9,
                                             "area": (h - h // 2) * w, "box": [0, h // 2, w, h]}]}
        if "instance" in tasks:
            res["instance"] = {"scores": np.zeros(0), "labels": np.zeros(0, int), "areas": np.zeros(0, int),
                               "boxes": np.zeros((0, 4)), "masks": None}
        return res


def jpeg(w=W, h=H):
    buf = io.BytesIO()
    Image.fromarray(np.random.default_rng(0).integers(0, 255, (h, w, 3), dtype=np.uint8)).save(buf, "JPEG")
    return buf.getvalue()


bp._gpu_name = lambda: "NVIDIA L40S"   # no CUDA here
auth = {"Authorization": f"Bearer {KEY}"}
engines = {"moge2": FakeMoge(), "marigold": FakeMarigold(), "sam3": FakeSam3(), "oneformer": FakeOneFormer()}
client = TestClient(bp.build_vision_api(engines))

r = client.get("/healthz")
check("healthz needs the key", r.status_code == 401)
r = client.get("/healthz", headers=auth)
body = r.json()
check("healthz answers ready without running a model", r.status_code == 200 and body.get("ready") is True
      and body.get("status") == "ok" and body.get("service") == "vision", r.text)
check("healthz carries the telemetry headers the cold-start dot reads", r.headers.get("x-gpu") == "NVIDIA L40S"
      and r.headers.get("x-container-requests") == "1", str(dict(r.headers)))

# ---- /v1/analyze: everything for one photo in one request
r = client.post("/v1/analyze", headers=auth, files={"image": ("p.jpg", jpeg(), "image/jpeg")}, data={"max_side": "1024"})
check("analyze answers 200 with a zip", r.status_code == 200 and r.headers["content-type"] == "application/zip", r.text[:200])
z = zipfile.ZipFile(io.BytesIO(r.content))
names = sorted(z.namelist())
check("analyze zip holds meta, geometry, shading, residual and sam3", names == [
    "geometry.npz", "meta.json", "residual.png", "sam3.json", "shading.png"], str(names))
meta = json.loads(z.read("meta.json"))
check("meta.json states the image size and what ran", meta["image"]["width"] == W and meta["image"]["height"] == H
      and meta["services"] == ["moge2", "marigold", "sam3"], str(meta)[:200])
npz = np.load(io.BytesIO(z.read("geometry.npz")))
check("geometry.npz is the /v1/geometry body (depth, mask, intrinsics, sizes)", set(["depth", "mask", "intrinsics", "size_hw"])
      <= set(npz.files) and npz["depth"].shape == (H, W), str(npz.files))
shade = np.asarray(Image.open(io.BytesIO(z.read("shading.png"))))
check("shading.png decodes at the photo size", shade.shape[:2] == (H, W) and int(shade.mean()) == 200)
sam = json.loads(z.read("sam3.json"))
check("sam3.json carries one result group per default prompt, masks as PNG", [g["prompt"] for g in sam["results"]]
      == list(bp.ANALYZE_PROMPTS) and sam["results"][0]["instances"][0]["mask"]["format"] == "png_base64")
check("analyze reports per-model GPU time", "moge2" in meta["timing_ms"] and "marigold" in meta["timing_ms"]
      and "sam3" in meta["timing_ms"] and "Server-Timing" in {k.title(): v for k, v in r.headers.items()}
      or "server-timing" in r.headers)

r = client.post("/v1/analyze", headers=auth, files={"image": ("p.jpg", jpeg(), "image/jpeg")},
                data={"lighting": "false", "segments": "false"})
z = zipfile.ZipFile(io.BytesIO(r.content))
check("analyze can be limited to geometry", sorted(z.namelist()) == ["geometry.npz", "meta.json"], str(z.namelist()))

r = client.post("/v1/analyze", headers=auth, files={"image": ("p.jpg", jpeg(), "image/jpeg")},
                data={"geometry": "false", "lighting": "false", "segments": "false"})
check("analyze with nothing requested is a clean 422", r.status_code == 422 and r.json()["error"] == "nothing_requested")

r = client.post("/v1/analyze", headers=auth, files={"image": ("p.jpg", jpeg(), "image/jpeg")},
                data={"prompt": ["a"] * 13})
check("analyze refuses more than 12 prompts", r.status_code == 422)
r = client.post("/v1/analyze", headers=auth, files={"image": ("p.jpg", jpeg(), "image/jpeg")},
                data={"prompt": list(bp.ANALYZE_PROMPTS), "lighting": "false", "geometry": "false"})
check("analyze takes all ten scene prompts in one call", r.status_code == 200
      and len(json.loads(zipfile.ZipFile(io.BytesIO(r.content)).read("sam3.json"))["results"]) == 10, r.text[:200])

# ---- the dedicated routes still work on the combined pool, so the old env URLs can point at it
r = client.post("/v1/geometry", headers=auth, files={"image": ("p.jpg", jpeg(), "image/jpeg")},
                data={"include": "depth,mask,intrinsics"})
check("/v1/geometry works on the combined pool", r.status_code == 200 and "depth" in np.load(io.BytesIO(r.content)).files)
r = client.post("/v1/decompose", headers=auth, files={"image": ("p.jpg", jpeg(), "image/jpeg")}, data={"model": "lighting"})
check("/v1/decompose (lighting) works on the combined pool", r.status_code == 200
      and "shading.png" in zipfile.ZipFile(io.BytesIO(r.content)).namelist(), r.text[:200])
r = client.post("/v1/decompose", headers=auth, files={"image": ("p.jpg", jpeg(), "image/jpeg")}, data={"model": "appearance"})
check("an unloaded Marigold checkpoint is a clean 422, not a 500", r.status_code == 422
      and r.json()["error"] == "model_not_loaded", r.text[:200])
r = client.post("/v1/segment", headers=auth, files={"image": ("p.jpg", jpeg(), "image/jpeg")}, data={"prompt": "wall"})
check("/v1/segment works on the combined pool", r.status_code == 200 and json.loads(r.content)["results"][0]["prompt"] == "wall")

# ---- OneFormer: /v1/oneformer is /v1/parse under the name the server asks for
a = client.post("/v1/parse", headers=auth, files={"image": ("p.jpg", jpeg(), "image/jpeg")},
                data={"task": ["semantic", "panoptic"]})
b = client.post("/v1/oneformer", headers=auth, files={"image": ("p.jpg", jpeg(), "image/jpeg")},
                data={"task": ["semantic", "panoptic"]})
ja, jb = json.loads(a.content), json.loads(b.content)
check("/v1/oneformer and /v1/parse answer the same", a.status_code == 200 and b.status_code == 200
      and ja["results"].keys() == jb["results"].keys() and ja["image"] == jb["image"])
check("OneFormer returns a semantic map and panoptic segments", "label_map" in ja["results"]["semantic"]
      and ja["results"]["panoptic"]["count"] == 2)
r = client.get("/v1/classes", headers=auth)
check("/v1/classes lists the class table", r.status_code == 200 and len(r.json()["classes"]) == 4)

# ---- a pool without Sam3 refuses to pretend
partial = TestClient(bp.build_vision_api({"moge2": FakeMoge(), "marigold": FakeMarigold()}))
r = partial.post("/v1/analyze", headers=auth, files={"image": ("p.jpg", jpeg(), "image/jpeg")})
check("analyze asks for an engine the pool lacks -> 422 engine_not_loaded", r.status_code == 422
      and r.json()["error"] == "engine_not_loaded", r.text[:200])

# ---- the dedicated builders are unchanged for the old classes
single = TestClient(bp.build_oneformer_api(FakeOneFormer()))
r = single.post("/v1/oneformer", headers=auth, files={"image": ("p.jpg", jpeg(), "image/jpeg")})
check("the dedicated OneFormer app serves /v1/oneformer too", r.status_code == 200)
single = TestClient(bp.build_sam3_api(FakeSam3()))
r = single.post("/v1/segment", headers=auth, files={"image": ("p.jpg", jpeg(), "image/jpeg")}, data={"prompt": "floor"})
check("the dedicated SAM 3 app is unchanged", r.status_code == 200)

print()
if failures:
    print(f"{len(failures)} check(s) FAILED: {failures}")
    sys.exit(1)
print("all blueprint checks passed")
