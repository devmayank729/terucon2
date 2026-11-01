"""run_compute end to end with the REAL EncoderBank class on TINY random-weight DINOv2 / SigLIP models (built from configs, no download); only the
Vertex side is a fake. This is the test that shows the pieces fit together as they will on Modal: crop files -> DataLoader -> real model code ->
float16 rows in state.sqlite."""
import contextlib
import sqlite3
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import pdf_factory as factory  # noqa: E402
from fakes_compute import FakeManager, tiny_cfg, tiny_models  # noqa: E402

from terucon_catalogue.config import compute_feature_versions  # noqa: E402
from terucon_catalogue.encoders import EncoderBank  # noqa: E402
from terucon_catalogue.pipeline import STAGES, run_compute  # noqa: E402
from terucon_catalogue.util import load_rgb  # noqa: E402


def read(database, sql, parameters=()):
    with contextlib.closing(sqlite3.connect(str(database))) as connection:
        connection.row_factory = sqlite3.Row
        return [dict(row) for row in connection.execute(sql, parameters)]


def test_the_whole_pipeline_with_the_real_encoder_bank_on_tiny_models(tmp_path):
    facts = factory.grid_with_labels(tmp_path / "grid.pdf")
    dino, siglip, tokenizer, preprocessing = tiny_models()
    cfg = tiny_cfg(num_workers=0)
    bank = EncoderBank(cfg, dino_backbone=dino, siglip_model=siglip, siglip_tokenizer=tokenizer, preprocessing=preprocessing)
    seen = {"dino": 0, "siglip": 0}
    real_dino, real_siglip = bank.encode_dino, bank.encode_siglip_images
    bank.encode_dino = lambda x: seen.__setitem__("dino", seen["dino"] + len(x)) or real_dino(x)
    bank.encode_siglip_images = lambda x: seen.__setitem__("siglip", seen["siglip"] + len(x)) or real_siglip(x)
    manager = FakeManager()

    result = run_compute(cfg, pdfs=[facts["path"]], work_dir=tmp_path / "w", encoders=bank, manager=manager)
    database = tmp_path / "w" / "state.sqlite"
    assert (result.n_items, result.n_pages, result.warnings, result.failed_pages) == (9, 2, [], [])
    assert {name: info["status"] for name, info in result.stages.items()} == {name: "done" for name in STAGES}
    assert seen == {"dino": 9, "siglip": 9}

    versions = compute_feature_versions(cfg)
    dims = {"dino": 96, "siglip": 32, "color": 396, "vertex_mm": 1408, "text": 768}      # tiny hidden size 32: 3 blocks of 32, and 32
    for pillar, dim in dims.items():
        rows = read(database, "SELECT feature_version, dim, dtype FROM embeddings WHERE pillar = ?", (pillar,))
        assert len(rows) == 9 and {(r["feature_version"], r["dim"], r["dtype"]) for r in rows} == {(versions[pillar], dim, "float16")}, pillar
    assert read(database, "SELECT COUNT(*) AS n FROM feature_errors")[0]["n"] == 0

    # a stored vector IS what the model makes of that crop (float16 rounding aside)
    row = read(database, "SELECT item_id, crop_filepath FROM items ORDER BY item_id LIMIT 1")[0]
    crop = load_rgb(tmp_path / "w" / row["crop_filepath"])
    pil = bank.neural_input(crop)
    expected_dino = real_dino(bank.dino_transform(pil)[None])[0]
    expected_siglip = real_siglip(bank.siglip_transform(pil)[None])[0]
    for pillar, expected in (("dino", expected_dino), ("siglip", expected_siglip)):
        stored = np.frombuffer(read(database, "SELECT vector FROM embeddings WHERE item_id = ? AND pillar = ?", (row["item_id"], pillar))[0]["vector"], dtype=np.float16)
        assert np.allclose(stored.astype(np.float32), expected, atol=2e-3), pillar

    # a second run encodes nothing
    run_compute(cfg, pdfs=[facts["path"]], work_dir=tmp_path / "w", encoders=bank, manager=manager)
    assert seen == {"dino": 9, "siglip": 9}
