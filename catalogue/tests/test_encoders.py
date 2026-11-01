"""encoders.py with the REAL classes on TINY random-weight DINOv2 / SigLIP models built from configs (no download, no Hugging Face):
shapes, unit norms, the DINO block structure, test-time augmentation, determinism, the CPU path, SigLIP text padding, the stage that runs them over the
crops, DataLoader workers started with "spawn", and a parity check against the notebook's own DinoTextureEncoder / SiglipImageEncoder /
DualGPUEncoderBank on identical weights. Not covered (no GPU here): fp16 and DataParallel.
"""
import copy
import os
import subprocess
import sys
import textwrap
import types
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import nb_oracle  # noqa: E402
from fakes_compute import FakeEncoders, RecordingTokenizer, make_cfg, seed_items, tiny_cfg, tiny_models  # noqa: E402

torch = pytest.importorskip("torch")

from terucon_catalogue import encoders as enc  # noqa: E402
from terucon_catalogue.config import local_feature_versions  # noqa: E402
from terucon_catalogue.state import StateStore  # noqa: E402
from terucon_catalogue.util import l2_normalize_rows  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent


@pytest.fixture(scope="module")
def prototype():
    return tiny_models(seed=0)


def make_bank(prototype, cfg=None, recording=False):
    dino, siglip, tokenizer, preprocessing = copy.deepcopy(prototype)
    tokenizer = RecordingTokenizer(tokenizer) if recording else tokenizer
    cfg = cfg or tiny_cfg()
    return enc.EncoderBank(cfg, dino_backbone=dino, siglip_model=siglip, siglip_tokenizer=tokenizer, preprocessing=preprocessing), tokenizer


def photos(count=3, seed=0):
    rng = np.random.default_rng(seed)
    return [rng.integers(0, 256, (90 + 10 * i, 120 + 7 * i, 3), dtype=np.uint8) for i in range(count)]


# ------------------------------------------------------------------------------------------------------ importing is cheap
def run_python(code):
    env = {**os.environ, "PYTHONPATH": str(ROOT)}
    done = subprocess.run([sys.executable, "-c", textwrap.dedent(code)], capture_output=True, text=True, env=env, cwd=str(ROOT), timeout=180)
    assert done.returncode == 0, done.stderr[-2000:]
    return done.stdout.strip()


def test_importing_the_compute_modules_loads_no_torch_no_transformers_no_google_client():
    out = run_python("""
        import sys
        import terucon_catalogue.features, terucon_catalogue.extract, terucon_catalogue.photos, terucon_catalogue.vertex
        import terucon_catalogue.captions, terucon_catalogue.encoders, terucon_catalogue.pipeline
        heavy = ('torch', 'torchvision', 'transformers', 'google.genai', 'google.auth', 'google.oauth2', 'requests', 'tenacity', 'faiss')
        print(sorted(name for name in heavy if name in sys.modules))
    """)
    assert out == "[]"


def test_the_torch_classes_are_built_on_first_use_and_pickle_by_name():
    out = run_python("""
        import pickle, sys
        import terucon_catalogue.encoders as enc
        assert 'torch' not in sys.modules
        from terucon_catalogue.encoders import DinoTextureEncoder, SiglipImageEncoder, CropFeatureDataset
        import torch
        assert issubclass(DinoTextureEncoder, torch.nn.Module) and issubclass(SiglipImageEncoder, torch.nn.Module)
        assert issubclass(CropFeatureDataset, torch.utils.data.Dataset)
        assert enc.DinoTextureEncoder is DinoTextureEncoder            # the same class every time
        assert (CropFeatureDataset.__module__, CropFeatureDataset.__qualname__) == ('terucon_catalogue.encoders', 'CropFeatureDataset')
        dataset = CropFeatureDataset([('i', 'p.png')], None, None, None, 1.5, 8)
        clone = pickle.loads(pickle.dumps(dataset))                   # what a "spawn" DataLoader worker does
        assert type(clone) is CropFeatureDataset and clone.records == [('i', 'p.png')]
        try:
            enc.NoSuchThing
        except AttributeError:
            print('ok')
    """)
    assert out == "ok"


# ------------------------------------------------------------------------------------------------------ hardware
def test_cpu_and_auto_without_cuda_resolve_to_the_cpu_in_float32():
    cpu = enc.resolve_hardware("cpu")
    assert (cpu.device.type, cpu.gpu_count, cpu.use_fp16, cpu.gpu_names) == ("cpu", 0, False, [])
    if not torch.cuda.is_available():
        auto = enc.resolve_hardware("auto")
        assert (auto.device.type, auto.gpu_count, auto.use_fp16) == ("cpu", 0, False)
        with pytest.raises(RuntimeError, match="no CUDA device"):
            enc.resolve_hardware("cuda")
        with pytest.raises(RuntimeError, match="0 CUDA device"):
            enc.resolve_hardware("cuda:0")
    with pytest.raises(ValueError, match="must be 'auto'"):
        enc.resolve_hardware("tpu")
    with pytest.raises(ValueError):
        enc.resolve_hardware("cuda:x")


def test_device_choice_with_two_pretend_gpus(monkeypatch):
    """The decision logic only (no GPU here): auto/cuda use every device (DataParallel), cuda:N exactly one; fp16 only on CUDA."""
    monkeypatch.setattr(torch.cuda, "is_available", lambda: True)
    monkeypatch.setattr(torch.cuda, "device_count", lambda: 2)
    monkeypatch.setattr(torch.cuda, "get_device_properties", lambda index: types.SimpleNamespace(name="Fake T4", total_memory=16 * 1024 ** 3))
    monkeypatch.setattr(torch.backends.cudnn, "benchmark", False)
    for spec in ("auto", "cuda", "CUDA"):
        profile = enc.resolve_hardware(spec)
        assert (str(profile.device), profile.gpu_count, profile.use_fp16, len(profile.gpu_names)) == ("cuda:0", 2, True, 2)
    one = enc.resolve_hardware("cuda:1")
    assert (str(one.device), one.gpu_count, one.use_fp16) == ("cuda:1", 1, True)
    assert torch.backends.cudnn.benchmark is True            # as verify_dual_t4 did when it found a GPU
    with pytest.raises(RuntimeError, match="2 CUDA device"):
        enc.resolve_hardware("cuda:2")
    assert enc.resolve_hardware("cpu").gpu_count == 0         # explicit cpu wins even with GPUs present


# ------------------------------------------------------------------------------------------------------ the bank
def test_the_bank_runs_on_the_cpu_in_float32_with_frozen_eval_models(prototype):
    bank, _ = make_bank(prototype)
    assert bank.device.type == "cpu" and bank.dtype == torch.float32 and bank.hardware.gpu_count == 0
    assert bank.dino_runner is bank.dino_encoder and bank.siglip_runner is bank.siglip_image_encoder      # no DataParallel
    for module in (bank.dino_encoder, bank.siglip_image_encoder, bank.siglip_model):
        assert not module.training
        assert all(not p.requires_grad and p.dtype == torch.float32 for p in module.parameters())
    assert bank.siglip_text_length == 16


def test_image_encodings_have_the_right_shapes_unit_norm_and_repeat_exactly(prototype):
    bank, _ = make_bank(prototype)
    images = photos(3)
    dino, siglip = bank.encode_rgb_images(images)
    assert (dino.shape, siglip.shape) == ((3, 96), (3, 32)) and dino.dtype == siglip.dtype == np.float32
    assert np.allclose(np.linalg.norm(dino, axis=1), 1.0, atol=1e-5) and np.allclose(np.linalg.norm(siglip, axis=1), 1.0, atol=1e-5)
    again = bank.encode_rgb_images(images)
    assert np.array_equal(again[0], dino) and np.array_equal(again[1], siglip)                    # deterministic
    one = bank.encode_rgb_images(images[1:2])
    assert np.allclose(one[0][0], dino[1], atol=1e-5) and np.allclose(one[1][0], siglip[1], atol=1e-5)   # a batch gives what single images give
    assert not np.allclose(dino[0], dino[1], atol=1e-3)                                               # different pictures, different vectors


def test_the_dino_vector_is_cls_patch_mean_patch_std_scaled_by_the_square_root_of_their_weights(prototype):
    bank, _ = make_bank(prototype)
    x = torch.randn(2, 3, 56, 56, generator=torch.Generator().manual_seed(1))
    vector = bank.encode_dino(x)
    scales = [np.sqrt(w / 1.0) for w in (0.5, 0.25, 0.25)]
    assert np.allclose(bank.dino_encoder.block_scales, scales)
    # each of the three 32-d blocks has the norm of its scale (the whole is therefore unit length)
    assert np.allclose([np.linalg.norm(vector[:, a:b], axis=1) for a, b in ((0, 32), (32, 64), (64, 96))], np.array(scales)[:, None], atol=1e-5)
    # ... and the blocks ARE the normalised CLS token, patch mean and patch std of the backbone's last hidden state
    backbone = bank.dino_encoder.backbone
    with torch.inference_mode():
        hidden = backbone(pixel_values=x).last_hidden_state
    cls_token, patches = hidden[:, 0], hidden[:, 1:]
    expected = torch.cat([torch.nn.functional.normalize(cls_token, dim=-1) * scales[0],
                          torch.nn.functional.normalize(patches.mean(dim=1), dim=-1) * scales[1],
                          torch.nn.functional.normalize(patches.std(dim=1, unbiased=False), dim=-1) * scales[2]], dim=-1)
    assert np.allclose(vector, torch.nn.functional.normalize(expected, dim=-1).numpy(), atol=1e-6)
    custom, _ = make_bank(prototype, tiny_cfg(dino_block_weights=(1.0, 0.0, 1.0)))
    assert np.allclose(custom.dino_encoder.block_scales, [np.sqrt(0.5), 0.0, np.sqrt(0.5)])


def test_flip_test_time_augmentation_is_the_normalised_sum_of_the_image_and_its_mirror(prototype):
    bank, _ = make_bank(prototype)
    images = photos(2, seed=3)
    plain_dino, plain_siglip = bank.encode_rgb_images(images)
    tta_dino, tta_siglip = bank.encode_rgb_images(images, tta_hflip=True)
    prepared = [bank.neural_input(rgb) for rgb in images]
    dino_batch = torch.stack([bank.dino_transform(p) for p in prepared])
    siglip_batch = torch.stack([bank.siglip_transform(p) for p in prepared])
    expected_dino = l2_normalize_rows(bank.encode_dino(dino_batch) + bank.encode_dino(torch.flip(dino_batch, dims=[3])))
    expected_siglip = l2_normalize_rows(bank.encode_siglip_images(siglip_batch) + bank.encode_siglip_images(torch.flip(siglip_batch, dims=[3])))
    assert np.array_equal(tta_dino, expected_dino) and np.array_equal(tta_siglip, expected_siglip)
    assert np.array_equal(plain_dino, bank.encode_dino(dino_batch))
    assert not np.allclose(tta_dino, plain_dino, atol=1e-4)                              # the mirror really contributes
    assert np.allclose(np.linalg.norm(tta_dino, axis=1), 1.0, atol=1e-5)


def test_neural_input_applies_the_same_clahe_as_the_catalogue_and_can_be_switched_off(prototype):
    from terucon_catalogue.features import apply_clahe_rgb
    bank, _ = make_bank(prototype)
    rgb = photos(1)[0]
    assert np.array_equal(np.asarray(bank.neural_input(rgb)), apply_clahe_rgb(rgb, bank.cfg.neural_clahe_clip_limit, bank.cfg.neural_clahe_grid))
    off, _ = make_bank(prototype, tiny_cfg(neural_clahe_clip_limit=0.0))
    assert np.array_equal(np.asarray(off.neural_input(rgb)), rgb)


def test_siglip_text_is_padded_to_max_length_with_the_template_and_is_unit_norm(prototype):
    bank, tokenizer = make_bank(prototype, recording=True)
    vectors = bank.encode_siglip_text(["brushed brass", "polished stone", "oak"])
    assert vectors.shape == (3, 32) and np.allclose(np.linalg.norm(vectors, axis=1), 1.0, atol=1e-5) and vectors.dtype == np.float32
    (args, kwargs), = tokenizer.calls
    assert args[0] == ["a close-up photo of brushed brass material texture", "a close-up photo of polished stone material texture",
                       "a close-up photo of oak material texture"]
    assert kwargs == {"padding": "max_length", "truncation": True, "max_length": 16, "return_tensors": "pt"}
    encoded = tokenizer.inner(args[0], padding="max_length", truncation=True, max_length=16, return_tensors="pt")["input_ids"]
    assert encoded.shape == (3, 16) and (encoded[:, -1] == 0).all()          # every row padded out to the model's text length
    assert np.array_equal(bank.encode_siglip_text(["brushed brass"])[0], vectors[0]) or np.allclose(bank.encode_siglip_text(["brushed brass"])[0], vectors[0], atol=1e-5)
    assert not np.allclose(vectors[0], vectors[1], atol=1e-3)


def test_the_modules_loaded_by_the_bank_come_back_unchanged_when_called_under_inference_mode(prototype):
    bank, _ = make_bank(prototype)
    x = torch.randn(1, 3, 28, 28)
    assert bank.encode_siglip_images(x).shape == (1, 32)
    out = bank.siglip_runner(x)
    assert out.requires_grad is False        # no autograd graph is kept even when called directly: inference_mode in the wrapper methods


# ------------------------------------------------------------------------------------------------------ parity with the notebook's classes
@pytest.fixture(scope="module")
def nb():
    nb_oracle.require_notebook()
    import torch.nn as nn
    import torch.nn.functional as F
    from torch.utils.data import DataLoader, Dataset
    from torchvision import transforms
    from torchvision.transforms import InterpolationMode
    from transformers import AutoImageProcessor, AutoModel, AutoTokenizer
    extra = dict(torch=torch, nn=nn, F=F, Dataset=Dataset, DataLoader=DataLoader, transforms=transforms, InterpolationMode=InterpolationMode,
                 AutoImageProcessor=AutoImageProcessor, AutoModel=AutoModel, AutoTokenizer=AutoTokenizer)
    return nb_oracle.load([
        (1, ["HardwareProfile", "l2_normalize_rows", "load_rgb"]),
        (4, ["DINO_DEFAULT_MEAN", "DINO_DEFAULT_STD", "SIGLIP_DEFAULT_MEAN", "SIGLIP_DEFAULT_STD", "LOCAL_PILLARS", "ColorParams", "ColorDescriptor",
             "apply_clahe_rgb", "rgb_to_hex", "compute_lab_color_descriptor", "_size_value", "load_preprocessing_settings", "tensor_from_model_output",
             "DinoTextureEncoder", "SiglipImageEncoder", "DualGPUEncoderBank", "CropFeatureDataset", "collate_feature_samples"]),
    ], extra=extra)


def test_the_bank_gives_exactly_what_the_notebooks_dual_gpu_bank_gives_on_identical_weights(nb, prototype):
    ours, _ = make_bank(prototype)
    dino, siglip, tokenizer, preprocessing = copy.deepcopy(prototype)
    hardware = nb["HardwareProfile"](device=torch.device("cpu"), gpu_count=0, gpu_names=[], use_fp16=False)
    theirs = nb["DualGPUEncoderBank"](tiny_cfg(), hardware, dino_backbone=dino, siglip_model=siglip, siglip_tokenizer=tokenizer, preprocessing=preprocessing)
    images = photos(3, seed=5)
    for tta in (False, True):
        a, b = ours.encode_rgb_images(images, tta_hflip=tta), theirs.encode_rgb_images(images, tta_hflip=tta)
        assert np.array_equal(a[0], b[0]) and np.array_equal(a[1], b[1])
    assert np.array_equal(ours.encode_siglip_text(["brushed brass", "stone"]), theirs.encode_siglip_text(["brushed brass", "stone"]))
    x = torch.randn(2, 3, 56, 56, generator=torch.Generator().manual_seed(9))
    y = torch.randn(2, 3, 28, 28, generator=torch.Generator().manual_seed(10))
    assert np.array_equal(ours.encode_dino(x), theirs.encode_dino(x)) and np.array_equal(ours.encode_siglip_images(y), theirs.encode_siglip_images(y))
    pil = ours.neural_input(images[0])
    assert torch.equal(ours.dino_transform(pil), theirs.dino_transform(pil)) and torch.equal(ours.siglip_transform(pil), theirs.siglip_transform(pil))
    assert (ours.siglip_text_length, ours.dtype, ours.device) == (theirs.siglip_text_length, theirs.dtype, theirs.device)


def test_the_lazily_built_torch_classes_equal_the_notebooks_classes(nb, prototype):
    dino, siglip, _, _ = copy.deepcopy(prototype)
    ours_d = enc.DinoTextureEncoder(copy.deepcopy(dino), (0.5, 0.25, 0.25)).eval()
    theirs_d = nb["DinoTextureEncoder"](copy.deepcopy(dino), (0.5, 0.25, 0.25)).eval()
    x = torch.randn(2, 3, 56, 56, generator=torch.Generator().manual_seed(2))
    with torch.inference_mode():
        assert torch.equal(ours_d(x), theirs_d(x))
        ours_s = enc.SiglipImageEncoder(copy.deepcopy(siglip).vision_model).eval()
        theirs_s = nb["SiglipImageEncoder"](copy.deepcopy(siglip).vision_model).eval()
        y = torch.randn(2, 3, 28, 28, generator=torch.Generator().manual_seed(3))
        assert torch.equal(ours_s(y), theirs_s(y))


def test_helper_functions_equal_the_notebooks(nb, monkeypatch):
    out = torch.tensor([[1.0, 2.0]])
    for value in (out, types.SimpleNamespace(text_embeds=out), types.SimpleNamespace(image_embeds=out), types.SimpleNamespace(pooler_output=out), (out, 1)):
        assert torch.equal(enc.tensor_from_model_output(value), nb["tensor_from_model_output"](value))
    assert enc.LOCAL_PILLARS == nb["LOCAL_PILLARS"] == ("dino", "siglip", "color")
    for name in ("DINO_DEFAULT_MEAN", "DINO_DEFAULT_STD", "SIGLIP_DEFAULT_MEAN", "SIGLIP_DEFAULT_STD"):
        assert getattr(enc, name) == nb[name]
    assert [enc._size_value(s, "height", 384) for s in (None, {"height": 224}, types.SimpleNamespace(height=256), {"width": 1})] == [
        nb["_size_value"](s, "height", 384) for s in (None, {"height": 224}, types.SimpleNamespace(height=256), {"width": 1})]


def test_preprocessing_settings_fall_back_to_the_defaults_like_the_notebook_and_read_a_processor(nb, monkeypatch):
    import transformers
    cfg = tiny_cfg()

    def broken(*args, **kwargs):
        raise OSError("offline")

    monkeypatch.setattr(transformers.AutoImageProcessor, "from_pretrained", broken)
    assert enc.load_preprocessing_settings(cfg) == nb["load_preprocessing_settings"](cfg)
    assert enc.load_preprocessing_settings(cfg)["siglip_height"] == 384
    processor = types.SimpleNamespace(image_mean=[0.1, 0.2, 0.3], image_std=[0.4, 0.5, 0.6], size={"height": 256, "width": 288})
    monkeypatch.setattr(transformers.AutoImageProcessor, "from_pretrained", lambda *a, **k: processor)
    ours, theirs = enc.load_preprocessing_settings(cfg), nb["load_preprocessing_settings"](cfg)
    assert ours == theirs and ours["siglip_mean"] == (0.1, 0.2, 0.3) and (ours["siglip_height"], ours["siglip_width"]) == (256, 288)


# ------------------------------------------------------------------------------------------------------ the stage over the crops
def corrupt(path):
    path.write_bytes(b"this is not a png")


def test_the_feature_stage_writes_three_pillars_per_crop_with_the_notebooks_versions(tmp_path, prototype):
    cfg = tiny_cfg(tmp_path / "w")
    store = StateStore(cfg.state_db_path)
    ids = seed_items(store, cfg, 5)
    bank, _ = make_bank(prototype, cfg)
    ticks = []
    done = enc.LocalFeatureExtractor(cfg, store, bank, on_batch=lambda d, t: ticks.append((d, t))).run()
    assert done == 5 and ticks == [(0, 5), (2, 5), (4, 5), (5, 5)]            # before every batch (2 items each) and once after the last
    versions = local_feature_versions(cfg)
    rows = store.query("SELECT item_id, pillar, feature_version, dim, extra_json FROM embeddings ORDER BY item_id, pillar")
    assert len(rows) == 15 and {(r["pillar"], r["feature_version"], r["dim"]) for r in rows} == {("dino", versions["dino"], 96), ("siglip", versions["siglip"], 32),
                                                                                                   ("color", versions["color"], 396)}
    assert all(json_has_hex(r["extra_json"]) for r in rows if r["pillar"] == "color") and all(r["extra_json"] is None for r in rows if r["pillar"] != "color")
    assert enc.LocalFeatureExtractor(cfg, store, bank).run() == 0               # nothing pending the second time
    assert store.query("SELECT COUNT(*) FROM feature_errors")[0][0] == 0
    assert sorted({r["item_id"] for r in rows}) == sorted(ids)
    store.close()


def json_has_hex(text):
    import json
    return bool(json.loads(text)["dominant_hex"])


def test_a_crop_that_cannot_be_decoded_is_recorded_per_pillar_and_given_up_after_the_allowed_attempts(tmp_path, prototype):
    cfg = tiny_cfg(tmp_path / "w", max_feature_attempts=2)
    store = StateStore(cfg.state_db_path)
    ids = seed_items(store, cfg, 3)
    bad = store.get_item(ids[1])["crop_filepath"]
    corrupt(cfg.work_dir / bad)
    bank, _ = make_bank(prototype, cfg)
    ticks = []
    assert enc.LocalFeatureExtractor(cfg, store, bank, on_batch=lambda d, t: ticks.append((d, t))).run() == 2
    assert ticks[-1] == (3, 3)                                                  # the failed crop counts as processed for the progress
    errors = [dict(r) for r in store.query("SELECT * FROM feature_errors ORDER BY pillar")]
    assert [(e["item_id"], e["pillar"], e["attempts"]) for e in errors] == [(ids[1], p, 1) for p in ("color", "dino", "siglip")]
    assert "UnidentifiedImageError" in errors[0]["error"]
    enc.LocalFeatureExtractor(cfg, store, bank).run()                           # second attempt
    assert {e[0] for e in store.query("SELECT attempts FROM feature_errors")} == {2}
    calls = []
    original = bank.encode_dino
    bank.encode_dino = lambda *a, **k: calls.append(1) or original(*a, **k)
    assert enc.LocalFeatureExtractor(cfg, store, bank).run() == 0 and calls == []   # attempts used up: not tried again, nothing encoded
    store.close()


def test_the_stage_reads_a_legacy_absolute_crop_path(tmp_path, prototype):
    cfg = tiny_cfg(tmp_path / "w")
    store = StateStore(cfg.state_db_path)
    (item_id,) = seed_items(store, cfg, 1)
    absolute = (cfg.work_dir / store.get_item(item_id)["crop_filepath"]).resolve()
    with store.transaction() as connection:
        connection.execute("UPDATE items SET crop_filepath = ? WHERE item_id = ?", (str(absolute), item_id))
    bank, _ = make_bank(prototype, cfg)
    assert enc.LocalFeatureExtractor(cfg, store, bank).run() == 1
    store.close()


def test_dataloader_workers_started_with_spawn_can_unpickle_the_lazily_built_dataset(tmp_path):
    """macOS uses 'spawn': the dataset (a class built at run time) is pickled to each worker and must find its class again by name."""
    results = {}
    for workers in (0, 2):
        cfg = make_cfg(tmp_path / f"w{workers}", num_workers=workers, feature_batch_size=2)
        store = StateStore(cfg.state_db_path)
        seed_items(store, cfg, 5)
        fake = FakeEncoders()
        assert enc.LocalFeatureExtractor(cfg, store, fake).run() == 5
        results[workers] = [(r["item_id"], r["pillar"], bytes(r["vector"])) for r in store.query("SELECT item_id, pillar, vector FROM embeddings ORDER BY item_id, pillar")]
        store.close()
    assert len(results[0]) == 15 and results[0] == results[2]


def test_the_feature_hook_can_stop_the_stage_between_batches(tmp_path, prototype):
    cfg = tiny_cfg(tmp_path / "w")
    store = StateStore(cfg.state_db_path)
    seed_items(store, cfg, 5)
    bank, _ = make_bank(prototype, cfg)

    class Stop(Exception):
        pass

    def hook(done, total):
        if done >= 2:
            raise Stop()

    with pytest.raises(Stop):
        enc.LocalFeatureExtractor(cfg, store, bank, on_batch=hook).run()
    assert store.query("SELECT COUNT(DISTINCT item_id) FROM embeddings")[0][0] == 2          # one whole batch, then stopped
    assert enc.LocalFeatureExtractor(cfg, store, bank).run() == 3                              # the next run does the other three only
    store.close()
