"""photos.py: a photo as a one-page PDF that the one extractor handles. Verified here, against PyMuPDF 2.0 and the notebook's extractor code:
the crop is the photo itself, pixel for pixel (never upscaled, scaled down only past the 1536 px crop cap); the PDF bytes are reproducible (item ids hash
them); EXIF orientation is applied; photos the extractor would ignore are refused; and a photo of several swatches is split with the notebook's
segmentation at the photo's own resolution.
"""
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
import pdf_factory as factory  # noqa: E402
from fakes_compute import FakeEncoders, FakeManager, make_cfg  # noqa: E402

import pymupdf as fitz  # noqa: E402
from terucon_catalogue.config import PipelineConfig  # noqa: E402
from terucon_catalogue.extract import CatalogueExtractor, safe_name  # noqa: E402
from terucon_catalogue.photos import PhotoTooSmall, segment_photo_regions, wrap_photo_as_pdf  # noqa: E402
from terucon_catalogue.pipeline import prepare_resume, run_compute  # noqa: E402
from terucon_catalogue.state import StateStore  # noqa: E402
from terucon_catalogue.util import load_rgb, sha256_file  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
POINTS_PER_PIXEL = 72.0 / 300.0


def noise_photo(width, height, seed=0):
    return np.random.default_rng(seed).integers(0, 256, (height, width, 3), dtype=np.uint8)


def save_png(path, array):
    Image.fromarray(array).save(path, format="PNG")
    return Path(path)


def extract(pdf, work, force=False, display_name=None):
    cfg = PipelineConfig(work_dir=work)
    cfg.ensure_dirs()
    store = StateStore(cfg.state_db_path)
    CatalogueExtractor(cfg, store).process_pdf(pdf, force_segmentation=force, display_name=display_name)
    rows = [dict(r) for r in store.query("SELECT * FROM items ORDER BY item_index")]
    return cfg, store, rows


# ------------------------------------------------------------------------------------------------------ resolution
@pytest.mark.parametrize("size", [(1000, 750), (640, 480), (1536, 1152), (1001, 777), (150, 150), (400, 1536), (1536, 1536)])
def test_a_photo_up_to_the_crop_cap_comes_out_pixel_for_pixel(tmp_path, size):
    width, height = size
    photo = noise_photo(width, height)          # noise: any resampling at all would show
    pdf = wrap_photo_as_pdf(save_png(tmp_path / "p.png", photo), tmp_path / "p.pdf")
    with fitz.open(str(pdf)) as document:
        assert document.page_count == 1 and len(document[0].get_images()) == 1
        assert document[0].rect.width == pytest.approx(width * POINTS_PER_PIXEL) and document[0].rect.height == pytest.approx(height * POINTS_PER_PIXEL)
        (info,) = document[0].get_image_info(xrefs=True)
        assert (info["width"], info["height"]) == (width, height) and not document[0].get_text("words")
    cfg, store, rows = extract(pdf, tmp_path / "w")
    (row,) = rows
    assert (row["crop_width"], row["crop_height"]) == (width, height) and row["render_zoom"] == pytest.approx(300 / 72)
    assert np.array_equal(load_rgb(cfg.work_dir / row["crop_filepath"]), photo)
    assert row["product_id"] is None and row["match_type"] == "none" and row["extraction_method"] == "embedded_image" and row["item_id"].endswith("-p0001-i00")
    assert [round(v, 2) for v in __import__("json").loads(row["image_bbox"])] == [0.0, 0.0, round(width * POINTS_PER_PIXEL, 2), round(height * POINTS_PER_PIXEL, 2)]
    store.close()


@pytest.mark.parametrize("size", [(4032, 3024), (3024, 4032), (2000, 1500), (1537, 400)])
def test_a_bigger_photo_is_scaled_down_to_the_crop_cap_and_never_up(tmp_path, size):
    width, height = size
    pdf = wrap_photo_as_pdf(save_png(tmp_path / "p.png", noise_photo(width, height)), tmp_path / "p.pdf")
    cfg, store, (row,) = extract(pdf, tmp_path / "w")
    cap = cfg.crop_max_side_px
    scale = cap / max(width, height)
    assert max(row["crop_width"], row["crop_height"]) in (cap, cap + 1) and row["crop_width"] <= width and row["crop_height"] <= height
    assert row["crop_width"] == pytest.approx(width * scale, abs=1.5) and row["crop_height"] == pytest.approx(height * scale, abs=1.5)
    assert row["render_zoom"] == pytest.approx(cap / (max(width, height) * POINTS_PER_PIXEL))
    store.close()


# ------------------------------------------------------------------------------------------------------ determinism
def test_wrapping_the_same_photo_twice_gives_the_same_bytes_and_the_same_item_ids(tmp_path):
    photo = save_png(tmp_path / "p.png", noise_photo(800, 600, seed=3))
    first = wrap_photo_as_pdf(photo, tmp_path / "one.pdf")
    time.sleep(1.2)                                          # a clock-dependent field (a date, an /ID) would differ now
    second = wrap_photo_as_pdf(photo, tmp_path / "two.pdf")
    assert first.read_bytes() == second.read_bytes() and sha256_file(first) == sha256_file(second)
    data = first.read_bytes()
    for field in (b"/ID", b"/CreationDate", b"/ModDate"):          # nothing that depends on the clock or on chance
        assert field not in data, field
    assert f"/Producer(MuPDF {fitz.VersionFitz})".encode() in data   # ... but the file names the MuPDF that wrote it: another build, other bytes
    other = wrap_photo_as_pdf(save_png(tmp_path / "q.png", noise_photo(800, 600, seed=4)), tmp_path / "other.pdf")
    assert other.read_bytes() != data
    _, store_a, rows_a = extract(first, tmp_path / "wa")
    _, store_b, rows_b = extract(second, tmp_path / "wb")
    assert [r["item_id"] for r in rows_a] == [r["item_id"] for r in rows_b] and [r["sha256_hash"] for r in rows_a] == [r["sha256_hash"] for r in rows_b]
    assert rows_a[0]["item_id"].startswith(sha256_file(first)[:12])
    store_a.close(), store_b.close()


def test_wrapping_in_another_process_gives_the_same_bytes(tmp_path):
    photo = save_png(tmp_path / "p.png", noise_photo(700, 500, seed=8))
    here = sha256_file(wrap_photo_as_pdf(photo, tmp_path / "here.pdf"))
    code = f"from terucon_catalogue.photos import wrap_photo_as_pdf; from terucon_catalogue.util import sha256_file; print(sha256_file(wrap_photo_as_pdf({str(photo)!r}, {str(tmp_path / 'there.pdf')!r})))"
    done = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, cwd=str(ROOT), env={**os.environ, "PYTHONPATH": str(ROOT)}, timeout=120)
    assert done.returncode == 0, done.stderr[-1500:]
    assert done.stdout.strip() == here


def test_the_wrapped_pdf_is_independent_of_the_input_file_format_and_name(tmp_path):
    photo = noise_photo(500, 400, seed=2)
    png = save_png(tmp_path / "a name with spaces.png", photo)
    bmp = tmp_path / "other.bmp"
    Image.fromarray(photo).save(bmp)
    assert wrap_photo_as_pdf(png, tmp_path / "1.pdf").read_bytes() == wrap_photo_as_pdf(bmp, tmp_path / "2.pdf").read_bytes()      # same pixels, same PDF


# ------------------------------------------------------------------------------------------------------ orientation, modes, refusals
def test_the_exif_orientation_is_applied_so_a_phone_photo_is_upright(tmp_path):
    base = noise_photo(600, 400, seed=11)                    # stored sideways: 600 wide, 400 high, with the tag "rotate 90 degrees clockwise to view"
    exif = Image.Exif()
    exif[0x0112] = 6
    path = tmp_path / "phone.jpg"
    Image.fromarray(base).save(path, format="JPEG", quality=95, exif=exif)
    upright = load_rgb(path)
    assert upright.shape == (600, 400, 3)                    # the tag turned it into 400 wide, 600 high
    pdf = wrap_photo_as_pdf(path, tmp_path / "phone.pdf")
    with fitz.open(str(pdf)) as document:
        assert (round(document[0].rect.width, 3), round(document[0].rect.height, 3)) == (round(400 * POINTS_PER_PIXEL, 3), round(600 * POINTS_PER_PIXEL, 3))
    cfg, store, (row,) = extract(pdf, tmp_path / "w")
    assert np.array_equal(load_rgb(cfg.work_dir / row["crop_filepath"]), upright) and (row["crop_width"], row["crop_height"]) == (400, 600)
    store.close()


def test_transparent_grey_and_palette_images_are_wrapped_as_rgb(tmp_path):
    rng = np.random.default_rng(0)
    rgba = Image.fromarray(rng.integers(0, 256, (200, 300, 4), dtype=np.uint8), "RGBA")
    rgba.save(tmp_path / "a.png")
    Image.fromarray(rng.integers(0, 256, (200, 300), dtype=np.uint8), "L").save(tmp_path / "g.jpg")
    Image.fromarray(rng.integers(0, 256, (200, 300, 3), dtype=np.uint8)).convert("P").save(tmp_path / "p.png")
    for name in ("a.png", "g.jpg", "p.png"):
        pdf = wrap_photo_as_pdf(tmp_path / name, tmp_path / f"{name}.pdf")
        cfg, store, (row,) = extract(pdf, tmp_path / f"w-{name}")
        assert np.array_equal(load_rgb(cfg.work_dir / row["crop_filepath"]), load_rgb(tmp_path / name)), name
        store.close()


def test_a_photo_the_extractor_would_ignore_is_refused_not_silently_dropped(tmp_path):
    for size in ((149, 300), (300, 149), (100, 100)):
        small = save_png(tmp_path / "small.png", noise_photo(*size))
        with pytest.raises(PhotoTooSmall, match=r"150 px") as raised:
            wrap_photo_as_pdf(small, tmp_path / "small.pdf")
        assert isinstance(raised.value, ValueError) and f"{size[0]} x {size[1]}" in str(raised.value) and not (tmp_path / "small.pdf").exists()
    ok = wrap_photo_as_pdf(save_png(tmp_path / "edge.png", noise_photo(150, 150)), tmp_path / "edge.pdf")
    assert ok.exists()
    # ... and that is exactly the extractor's rule: the 149 px photo WOULD have produced no item
    forced = wrap_photo_as_pdf(save_png(tmp_path / "x.png", noise_photo(149, 300)), tmp_path / "x.pdf", min_side_pt=1.0)
    _, store, rows = extract(forced, tmp_path / "w")
    assert rows == []
    store.close()
    assert wrap_photo_as_pdf(save_png(tmp_path / "d.png", noise_photo(100, 100)), tmp_path / "d.pdf", dpi=100.0).exists()      # 72 pt at 100 dpi


def test_a_photo_too_big_for_a_pdf_page_or_not_an_image_is_refused(tmp_path):
    huge = save_png(tmp_path / "huge.png", np.zeros((150, 60100, 3), dtype=np.uint8))
    with pytest.raises(ValueError, match="14400"):
        wrap_photo_as_pdf(huge, tmp_path / "huge.pdf")
    (tmp_path / "text.jpg").write_text("this is not an image")
    with pytest.raises(Exception) as raised:
        wrap_photo_as_pdf(tmp_path / "text.jpg", tmp_path / "text.pdf")
    assert type(raised.value).__name__ == "UnidentifiedImageError" and not (tmp_path / "text.pdf").exists()
    with pytest.raises(FileNotFoundError):
        wrap_photo_as_pdf(tmp_path / "missing.png", tmp_path / "missing.pdf")


# ------------------------------------------------------------------------------------------------------ a photo of several swatches
def swatch_photo_file(tmp_path, name="swatches.png"):
    photo, boxes = factory.swatches_photo()
    return save_png(tmp_path / name, photo), photo, boxes


def test_segment_photo_regions_finds_the_four_swatches_and_keeps_the_photos_resolution(tmp_path):
    path, photo, boxes = swatch_photo_file(tmp_path)
    regions, method = segment_photo_regions(path)
    assert method == "raster_segmentation_forced" and len(regions) == 4
    for region, (x0, y0, x1, y1) in zip(regions, boxes):                                 # reading order: top-left, top-right, bottom-left, bottom-right
        # the size is right (420 x 320 px) but the box sits about one 110 dpi pixel (5.5 px at 300 dpi) off: the notebook's morphology kernel is
        # round(0.012 * the short side of the 110 dpi render) = 4 px for a small photo page, and an even kernel shifts the result by one pixel
        assert [region.rect.x0, region.rect.y0, region.rect.x1, region.rect.y1] == pytest.approx([v * POINTS_PER_PIXEL for v in (x0, y0, x1, y1)], abs=2.5)
        assert region.rect.width == pytest.approx((x1 - x0) * POINTS_PER_PIXEL, abs=0.6) and region.rect.height == pytest.approx((y1 - y0) * POINTS_PER_PIXEL, abs=0.8)
        assert region.native_pixels_per_point == pytest.approx(300 / 72) and region.method == "raster_segmentation" and region.xrefs == []
    again, _ = segment_photo_regions(wrap_photo_as_pdf(path, tmp_path / "s.pdf"))        # a PDF works too (its first page)
    assert [r.rect for r in again] == [r.rect for r in regions]


def test_forced_segmentation_turns_n_swatches_into_n_items_at_the_photos_own_resolution(tmp_path):
    path, photo, boxes = swatch_photo_file(tmp_path)
    pdf = wrap_photo_as_pdf(path, tmp_path / "s.pdf")
    cfg, store, rows = extract(pdf, tmp_path / "forced", force=True)
    assert [r["item_index"] for r in rows] == [0, 1, 2, 3] and {r["extraction_method"] for r in rows} == {"raster_segmentation"} and {r["image_xrefs"] for r in rows} == {"[]"}
    assert store.query("SELECT extraction_method FROM pages")[0][0] == "raster_segmentation_forced"
    for row, (x0, y0, x1, y1) in zip(rows, boxes):
        assert (row["crop_width"], row["crop_height"]) == pytest.approx((x1 - x0, y1 - y0), abs=10)       # ~420 x 320, NOT the 67 % a 200 dpi floor would give
        assert row["render_zoom"] == pytest.approx(300 / 72)
        crop = load_rgb(cfg.work_dir / row["crop_filepath"]).astype(float)
        inner = photo[y0 + 20:y1 - 20, x0 + 20:x1 - 20].astype(float)
        assert np.abs(crop[20:-20, 20:-20].mean(axis=(0, 1)) - inner.mean(axis=(0, 1))).max() < 4          # the crop shows that swatch
        assert row["product_id"] is None
    store.close()
    _, plain_store, plain = extract(pdf, tmp_path / "plain")                           # without the flag the whole photo is one item
    assert len(plain) == 1 and (plain[0]["crop_width"], plain[0]["crop_height"]) == (1200, 900) and plain[0]["extraction_method"] == "embedded_image"
    plain_store.close()


def test_forced_segmentation_of_a_photo_with_nothing_to_find_keeps_the_whole_picture(tmp_path):
    flat = save_png(tmp_path / "flat.png", np.full((600, 800, 3), (120, 100, 80), dtype=np.uint8))
    regions, method = segment_photo_regions(flat)
    assert method == "embedded_image" and len(regions) == 1
    pdf = wrap_photo_as_pdf(flat, tmp_path / "flat.pdf")
    _, store, rows = extract(pdf, tmp_path / "w", force=True)
    assert len(rows) == 1 and (rows[0]["crop_width"], rows[0]["crop_height"]) == (800, 600) and store.query("SELECT extraction_method FROM pages")[0][0] == "embedded_image"
    store.close()


def test_the_flag_off_leaves_the_notebooks_behaviour_untouched_for_real_pdfs(tmp_path):
    facts = factory.flattened_scan(tmp_path / "scan.pdf")
    _, store, rows = extract(facts["path"], tmp_path / "w", force=False)
    assert store.query("SELECT extraction_method FROM pages")[0][0] == "raster_segmentation_flattened" and len(rows) == 4
    store.close()


# ------------------------------------------------------------------------------------------------------ photos through run_compute
def run(tmp_path, photos, work="w", **kwargs):
    return run_compute(make_cfg(), pdfs=photos, work_dir=tmp_path / work, encoders=FakeEncoders(), manager=FakeManager(), **kwargs)


def test_photos_go_through_run_compute_next_to_each_other_and_only_the_marked_one_is_split(tmp_path):
    plain = save_png(tmp_path / "IMG_0001.png", noise_photo(900, 600, seed=1))
    swatches, photo, boxes = swatch_photo_file(tmp_path, "IMG_0002.png")
    tiny = save_png(tmp_path / "IMG_0003.png", noise_photo(140, 140))
    jpeg = tmp_path / "IMG_0004.jpg"
    Image.fromarray(noise_photo(500, 500, seed=5)).save(jpeg, quality=90)
    events = []
    result = run(tmp_path, [plain, swatches, tiny, jpeg], segment_photos=[swatches], progress=lambda *e: events.append(e))
    assert result.n_items == 1 + 4 + 1 and result.n_pages == 3 and result.unmatched == 6
    assert [(p["name"], p["kind"], p["pages"], p["segmented"]) for p in result.pdfs] == [("IMG_0001.png", "photo", 1, False), ("IMG_0002.png", "photo", 1, True),
                                                                                         ("IMG_0004.jpg", "photo", 1, False)]
    for entry, source in zip(result.pdfs, (plain, swatches, jpeg)):
        assert entry["origin"] == {"name": source.name, "sha256": sha256_file(source), "bytes": source.stat().st_size}
        wrapped = Path(entry["path"])
        assert wrapped.parent == result.work_dir / "wrapped" and wrapped.name == f"{safe_name(source.stem)}_{sha256_file(source)[:8]}.pdf"
        assert entry["sha256"] == sha256_file(wrapped)
    assert result.failed_pages == [{"pdf": "IMG_0003.png", "page": 1, "error": result.failed_pages[0]["error"]}] and "PhotoTooSmall" in result.failed_pages[0]["error"]
    assert any("IMG_0003.png was skipped" in w for w in result.warnings)
    import sqlite3
    rows = sqlite3.connect(str(result.work_dir / "state.sqlite")).execute("SELECT DISTINCT source_pdf FROM items ORDER BY 1").fetchall()
    assert [r[0] for r in rows] == ["IMG_0001.png", "IMG_0002.png", "IMG_0004.jpg"]                  # the photo's own name, not the wrapped PDF's
    assert any(e[0] == "extract" for e in events) and {e[0] for e in events} >= {"extract", "features", "captions"}


def test_two_photos_with_the_same_name_from_different_folders_do_not_collide(tmp_path):
    (tmp_path / "a").mkdir()
    (tmp_path / "b").mkdir()
    first = save_png(tmp_path / "a" / "IMG_0001.png", noise_photo(400, 300, seed=1))
    second = save_png(tmp_path / "b" / "IMG_0001.png", noise_photo(400, 300, seed=2))
    result = run(tmp_path, [first, second])
    assert result.n_items == 2 and len({p["path"] for p in result.pdfs}) == 2 and len(list((result.work_dir / "wrapped").glob("*.pdf"))) == 2
    assert [p["name"] for p in result.pdfs] == ["IMG_0001.png", "IMG_0001.png"]


def test_segment_photos_accepts_the_wrapped_path_too_and_warns_about_strangers(tmp_path):
    swatches, _, _ = swatch_photo_file(tmp_path, "IMG_0002.png")
    wrapped = tmp_path / "w" / "wrapped" / f"IMG_0002_{sha256_file(swatches)[:8]}.pdf"
    result = run(tmp_path, [swatches], segment_photos=[wrapped, tmp_path / "not-an-input.png"])
    assert result.n_items == 4 and result.pdfs[0]["segmented"] is True
    assert any("not-an-input.png" in w and "not one of the inputs" in w for w in result.warnings)


def test_a_photo_job_resumes_without_repeating_paid_work_because_the_wrapped_pdf_is_reproduced_exactly(tmp_path):
    plain = save_png(tmp_path / "IMG_0001.png", noise_photo(900, 600, seed=1))
    swatches, _, _ = swatch_photo_file(tmp_path, "IMG_0002.png")
    first = run(tmp_path, [plain, swatches], work="w1", segment_photos=[swatches])
    import sqlite3
    ids = sqlite3.connect(str(first.work_dir / "state.sqlite")).execute("SELECT item_id, sha256_hash FROM items ORDER BY item_id").fetchall()
    store = StateStore(first.work_dir / "state.sqlite")
    store.snapshot_to(tmp_path / "snap" / "state.sqlite")
    store.close()
    (tmp_path / "w2").mkdir()
    shutil.copy(tmp_path / "snap" / "state.sqlite", tmp_path / "w2" / "state.sqlite")
    prepare_resume(tmp_path / "w2")
    encoders, manager = FakeEncoders(), FakeManager()
    resumed = run_compute(make_cfg(), pdfs=[plain, swatches], work_dir=tmp_path / "w2", encoders=encoders, manager=manager, segment_photos=[swatches])
    assert encoders.total_calls == 0 and manager.total_calls == 0                                       # nothing paid for twice
    assert sqlite3.connect(str(resumed.work_dir / "state.sqlite")).execute("SELECT item_id, sha256_hash FROM items ORDER BY item_id").fetchall() == ids
    assert [p["sha256"] for p in resumed.pdfs] == [p["sha256"] for p in first.pdfs] and resumed.warnings == []
