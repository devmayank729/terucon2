"""Swatchroom model service: the local models behind the studio.

    POST /scene/segment   photo -> class per pixel (SegFormer, ADE20K); ?model=b5-quant (default), b5, b4, b2
    POST /pick/embed      photo -> prepares the Pick tool for that photo (SAM)
    POST /pick/mask       taps  -> mask of the thing under the taps
    POST /warmup          load models ahead of the first request
    GET  /health          what is loaded and on which device

Only the Express server talks to this service. Run it next to the server:

    uvicorn app:app --host 127.0.0.1 --port 8001
"""

import base64
import gzip
import io
import os
import threading
from contextlib import asynccontextmanager

import numpy as np
import torch
from typing import Optional

from fastapi import FastAPI, File, Form, Header, HTTPException, Request, UploadFile
from fastapi.concurrency import run_in_threadpool
from PIL import Image, UnidentifiedImageError
from pydantic import BaseModel

from pick import PickTool
from scene import DEFAULT_MODEL, SCENE_MODELS, SceneParser

MAX_SIDE = 2048
MAX_UPLOAD_BYTES = 15 * 1024 * 1024


def pick_device():
    wanted = os.environ.get("MODEL_DEVICE", "auto").lower()
    if wanted in ("cpu", "cuda", "mps"):
        return torch.device(wanted)
    if torch.cuda.is_available():
        return torch.device("cuda")
    if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        return torch.device("mps")
    return torch.device("cpu")


DEVICE = pick_device()
if DEVICE.type == "cpu":
    torch.set_num_threads(max(1, int(os.environ.get("MODEL_THREADS", os.cpu_count() or 2))))

SERVICE_KEY = os.environ.get("MODEL_SERVICE_KEY", "")
scene_parser = SceneParser(DEVICE, os.environ.get("SCENE_FLIP", "auto"))
pick_tool = PickTool(DEVICE, os.environ.get("PICK_MODEL") or None)

def preload_scene_model():
    """Starts loading the scene model in the background as the service boots, so the first photo after a
    deploy or restart does not pay for the download and the read from disk (that wait is this service's
    cold start; /scene/segment reports it as loadMs). SCENE_PRELOAD=off turns it off, a model name
    (b2, b4, b5, b5-quant) picks another one."""
    wanted = os.environ.get("SCENE_PRELOAD", DEFAULT_MODEL).strip()
    if wanted.lower() in ("", "off", "none", "0", "false"):
        return

    def work():
        try:
            scene_parser.load_or_fallback(wanted)
        except Exception as error:  # offline, disk full...: the first real request will say so
            print("Scene model preload failed:", error)

    threading.Thread(target=work, name="scene-preload", daemon=True).start()


@asynccontextmanager
async def lifespan(_app):
    preload_scene_model()
    yield


app = FastAPI(title="Swatchroom model service", version="1.0.0", lifespan=lifespan)


def check_key(given):
    if SERVICE_KEY and given != SERVICE_KEY:
        raise HTTPException(status_code=401, detail="Wrong or missing X-Model-Key.")


async def read_photo(upload):
    data = await upload.read()
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="The photo is too large.")
    try:
        image = Image.open(io.BytesIO(data))
        image.load()
    except (UnidentifiedImageError, OSError):
        raise HTTPException(status_code=400, detail="The file is not a readable image.")
    if max(image.size) > MAX_SIDE:
        image.thumbnail((MAX_SIDE, MAX_SIDE))
    return image


def pack(array):
    """uint8 array -> base64 of its gzip-compressed bytes (the browser unpacks it)."""
    return base64.b64encode(gzip.compress(np.ascontiguousarray(array, dtype=np.uint8).tobytes(), 6)).decode("ascii")


@app.get("/health")
def health():
    return {
        "status": "ok",
        "device": DEVICE.type,
        "torch": torch.__version__,
        "sceneModels": SCENE_MODELS,
        # the model asked for when none is named, and what is in memory: a service from before B5 has no defaultModel
        "defaultModel": DEFAULT_MODEL,
        "sceneLoaded": scene_parser.loaded(),
        "pickModel": pick_tool.model_id,
        "pickLoaded": pick_tool.loaded(),
    }


@app.post("/scene/segment")
async def scene_segment(
    request: Request,
    image: UploadFile = File(...),
    model: Optional[str] = Form(None),
    x_model_key: str = Header(default=""),
):
    """The model comes from the form field or, like the browser's /api/vision/segment?model=..., the query string
    (POST /scene/segment?model=b5-quant). Without either: SegFormer-B5 with INT8 weights where the device allows."""
    check_key(x_model_key)
    chosen = (model or request.query_params.get("model") or DEFAULT_MODEL).strip()[:80]
    photo = await read_photo(image)
    try:
        class_map, labels, info = await run_in_threadpool(scene_parser.segment, photo, chosen)
    except Exception as error:
        raise HTTPException(status_code=500, detail="Scene parsing failed: " + str(error))
    return {
        "width": int(class_map.shape[1]),
        "height": int(class_map.shape[0]),
        "classLabels": labels,
        "classMap": pack(class_map),
        "model": info["model"],
        "device": info["device"],
        "precision": info["precision"],
        "tiles": info["tiles"],
        "ms": info["ms"],
        "loadMs": info["loadMs"],
        "inferMs": info["inferMs"],
        **({"fellBackFrom": info["fellBackFrom"]} if info.get("fellBackFrom") else {}),
    }


@app.post("/pick/embed")
async def pick_embed(
    image: UploadFile = File(...),
    key: str = Form(...),
    x_model_key: str = Header(default=""),
):
    check_key(x_model_key)
    if pick_tool.has(key):
        return {"cached": True, "ms": 0, "model": pick_tool.model_id}
    photo = await read_photo(image)
    try:
        result = await run_in_threadpool(pick_tool.embed, key, photo)
    except Exception as error:
        raise HTTPException(status_code=500, detail=str(error))
    result["model"] = pick_tool.model_id
    return result


class PickRequest(BaseModel):
    key: str
    points: list
    labels: list
    # optional box prompt [x0, y0, x1, y1] in photo pixels: the tap-to-calibrate step sends the surface's own box
    box: Optional[list] = None


@app.post("/pick/mask")
async def pick_mask(request: PickRequest, x_model_key: str = Header(default="")):
    check_key(x_model_key)
    try:
        mask, score = await run_in_threadpool(pick_tool.mask, request.key, request.points, request.labels, request.box)
    except KeyError as error:
        raise HTTPException(status_code=409, detail=str(error.args[0]))
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error))
    except Exception as error:
        raise HTTPException(status_code=500, detail=str(error))
    return {
        "width": int(mask.shape[1]),
        "height": int(mask.shape[0]),
        "mask": pack(mask),
        "score": score,
    }


class WarmupRequest(BaseModel):
    what: str = "scene"
    model: str = DEFAULT_MODEL


@app.post("/warmup")
async def warmup(request: WarmupRequest, x_model_key: str = Header(default="")):
    check_key(x_model_key)
    try:
        if request.what == "pick":
            await run_in_threadpool(pick_tool.load)
        else:
            await run_in_threadpool(scene_parser.load, request.model)
    except Exception as error:
        raise HTTPException(status_code=500, detail=str(error))
    return health()
