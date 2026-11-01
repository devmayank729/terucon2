"""What the extractor makes of the synthetic catalogue pages, judged against the facts the factory built the pages from (not against the notebook:
test_extract_parity.py does that).

Each test is one of the page types the extractor has to handle; the first three are the three situations of the owner's real catalogue work:
a text layer with IDs under pictures, the real 69-page PDF (one picture per page, no text layer: one item, no product id), and a flattened scan.
"""
import shutil
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import pdf_factory as factory  # noqa: E402

from terucon_catalogue.config import PipelineConfig  # noqa: E402
from terucon_catalogue.extract import (CatalogueExtractor, ImageRegion, LineageTracer, merge_overlapping_regions,  # noqa: E402
                                       overlap_length, rect_to_list, safe_name)
from terucon_catalogue.features import crop_path_for_storage, resolve_crop_path  # noqa: E402
from terucon_catalogue.state import StateStore  # noqa: E402
from terucon_catalogue.util import load_rgb, sha256_file  # noqa: E402

import pymupdf as fitz  # noqa: E402


def extract(pdf, work, on_page=None, **overrides):
    cfg = PipelineConfig(work_dir=work, **overrides)
    cfg.ensure_dirs()
    store = StateStore(cfg.state_db_path)
    extractor = CatalogueExtractor(cfg, store, on_page=on_page)
    extractor.run([pdf])
    return cfg, store, extractor


def items(store, page=None):
    sql = "SELECT * FROM items ORDER BY page_number, item_index"
    rows = [dict(row) for row in store.query(sql)]
    return [row for row in rows if page is None or row["page_number"] == page]


def bbox(row):
    import json
    return json.loads(row["image_bbox"])


def assert_box(actual, expected, tolerance=0.01):
    assert actual == pytest.approx(list(expected), abs=tolerance)


def pages(store):
    return {int(r["page_number"]): dict(r) for r in store.query("SELECT * FROM pages")}


# ------------------------------------------------------------------------------------------------------ (i) text layer + IDs
def test_ids_under_pictures_are_assigned_one_to_one_with_a_shared_code_and_an_orphan(tmp_path):
    facts = factory.grid_with_labels(tmp_path / "grid.pdf")
    cfg, store, _ = extract(facts["path"], tmp_path / "w")
    for page_number, expected in facts["page_items"].items():
        rows = items(store, page_number)
        assert [r["product_id"] for r in rows] == [e["code"] for e in expected]
        assert [r["match_type"] for r in rows] == [e["match"] for e in expected]
        for row, want in zip(rows, expected):
            assert_box(bbox(row), [want["rect"].x0, want["rect"].y0, want["rect"].x1, want["rect"].y1])
            assert row["extraction_method"] == "embedded_image" and row["match_relation"] == "below"
            assert row["id_bbox"] is not None and row["product_id_raw"] == row["product_id"]
    # the code that belongs to no picture is kept as an orphan, not forced onto a picture
    assert [(r["page_number"], r["product_id"]) for r in map(dict, store.query("SELECT * FROM orphan_ids"))] == [(1, "SB999")]
    # item ids are the notebook's <pdfsha256[:12]>-p<page:04d>-i<index:02d>
    sha = sha256_file(facts["path"])
    assert [r["item_id"] for r in items(store, 2)] == [f"{sha[:12]}-p0002-i{i:02d}" for i in range(3)]
    shared = items(store, 2)[2]
    assert shared["match_type"] == "shared" and shared["product_id"] == "SB108" and shared["match_cost"] <= cfg.max_match_cost * cfg.shared_id_cost_factor
    store.close()


# ------------------------------------------------------------------------------------------------------ (ii) the real catalogue
def test_a_page_like_the_real_catalogue_is_one_item_with_no_product_id(tmp_path):
    """This is what happened on the owner's 69-page PDF: one picture covering ~95 % of every page and no text layer: 69 pages -> 69 items, all
    'UNMATCHED' (product_id None, id_bbox None)."""
    facts = factory.real_catalogue_like(tmp_path / "real.pdf", pages=6)
    cfg, store, _ = extract(facts["path"], tmp_path / "w")
    rows = items(store)
    assert len(rows) == 6 and [r["page_number"] for r in rows] == list(range(1, 7))
    page_area = factory.PAGE_W * factory.PAGE_H
    for row in rows:
        assert row["product_id"] is None and row["product_id_raw"] is None and row["id_bbox"] is None
        assert row["match_type"] == "none" and row["match_relation"] is None and row["match_cost"] is None
        assert row["extraction_method"] == "embedded_image" and row["inpainted_overlay"] == 0 and row["item_index"] == 0
        assert_box(bbox(row), facts["box"], tolerance=0.01)
        x0, y0, x1, y1 = bbox(row)
        # the real file's box [26.833, 15, 568.166, 827] is 87.7 % of an A4 page: above the extractor's 85 % "page-sized raster" threshold,
        # which only matters when a page ALSO has >= 2 IDs in its text layer (these pages have none)
        assert 0.85 < (x1 - x0) * (y1 - y0) / page_area < 0.90
    assert all(p["n_id_candidates"] == 0 and p["n_items"] == 1 and p["extraction_method"] == "embedded_image" for p in pages(store).values())
    assert store.query("SELECT COUNT(*) AS n FROM orphan_ids")[0]["n"] == 0
    # the crop file is what the row says it is
    for row in rows:
        path = resolve_crop_path(cfg.work_dir, row["crop_filepath"])
        assert sha256_file(path) == row["sha256_hash"]
        rgb = load_rgb(path)
        assert (rgb.shape[1], rgb.shape[0]) == (row["crop_width"], row["crop_height"])
        assert max(rgb.shape[:2]) <= cfg.crop_max_side_px + 1
    store.close()


# ------------------------------------------------------------------------------------------------------ (iii) flattened scan
def test_a_flattened_scan_is_split_into_its_swatches_and_the_codes_follow(tmp_path):
    facts = factory.flattened_scan(tmp_path / "scan.pdf")
    cfg, store, _ = extract(facts["path"], tmp_path / "w")
    rows = items(store)
    assert pages(store)[1]["extraction_method"] == "raster_segmentation_flattened"
    assert [r["product_id"] for r in rows] == facts["codes"] and {r["match_relation"] for r in rows} == {"below"}
    assert {r["extraction_method"] for r in rows} == {"raster_segmentation"} and {r["image_xrefs"] for r in rows} == {"[]"}
    for row, rect in zip(rows, facts["rects"]):
        assert_box(bbox(row), [rect.x0, rect.y0, rect.x1, rect.y1], tolerance=1.0)   # found on a 110 dpi render: ~0.65 pt resolution
    store.close()


def test_the_flattening_rule_needs_at_least_two_ids(tmp_path):
    """The rule is 'one page-sized raster AND >= 2 IDs'. The same scan with one label stays ONE item (no segmentation)."""
    facts = factory.flattened_scan(tmp_path / "scan.pdf")
    document = fitz.open(str(facts["path"]))
    page = document[0]
    for word in page.get_text("words")[1:]:
        page.add_redact_annot(fitz.Rect(word[:4]))
    page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_NONE)
    one_id = tmp_path / "one_id.pdf"
    document.save(str(one_id))
    document.close()
    cfg, store, _ = extract(one_id, tmp_path / "w")
    assert pages(store)[1]["n_id_candidates"] == 1
    assert pages(store)[1]["extraction_method"] == "embedded_image" and len(items(store)) == 1
    store.close()


# ------------------------------------------------------------------------------------------------------ (iv) rotated page
def test_a_rotated_page_is_normalised_to_one_upright_coordinate_system(tmp_path):
    plain = factory.grid_with_labels(tmp_path / "plain.pdf")
    rotated = factory.grid_with_labels(tmp_path / "rotated.pdf", rotation=90)
    cfg, store, _ = extract(rotated["path"], tmp_path / "w")
    height = factory.PAGE_H
    for page_number, expected in plain["page_items"].items():
        rows = items(store, page_number)
        assert {r["original_rotation"] for r in rows} == {90}
        assert pages(store)[page_number]["page_width"] == pytest.approx(factory.PAGE_H) and pages(store)[page_number]["page_height"] == pytest.approx(factory.PAGE_W)
        got = {(r["product_id"], tuple(round(v, 2) for v in bbox(r))) for r in rows}
        # a 90 degree clockwise turn maps the point (x, y) of the printed page to (H - y, x)
        want = {(e["code"], tuple(round(v, 2) for v in (height - e["rect"].y1, e["rect"].x0, height - e["rect"].y0, e["rect"].x1))) for e in expected}
        assert got == want
    assert [(r["page_number"], r["product_id"]) for r in map(dict, store.query("SELECT * FROM orphan_ids"))] == [(1, "SB999")]
    store.close()


# ------------------------------------------------------------------------------------------------------ (v) repeated logo
def test_a_logo_on_every_page_is_rejected_from_four_pages_up(tmp_path):
    facts = factory.logo_on_every_page(tmp_path / "logo.pdf", pages=5)
    cfg, store, _ = extract(facts["path"], tmp_path / "w")
    rows = items(store)
    assert [r["product_id"] for r in rows] == [f"SB3{n:02d}" for n in range(5)] and len(rows) == 5
    assert all(bbox(r) == [150.0, 200.0, 400.0, 450.0] for r in rows) and all(r["match_type"] == "single_image" for r in rows)
    logo = facts["logo_xref"]
    assert all(logo not in __import__("json").loads(r["image_xrefs"]) for r in rows)
    store.close()


def test_the_repeated_image_rule_needs_four_pages(tmp_path):
    """The rule is 'same xref on >= 50 % of the pages' and only 'if the document has >= 4 pages': with 3 pages the logo is an item per page."""
    facts = factory.logo_on_every_page(tmp_path / "logo3.pdf", pages=3)
    cfg, store, _ = extract(facts["path"], tmp_path / "w")
    rows = items(store)
    assert len(rows) == 6 and [r["product_id"] for r in rows] == [None, "SB300", None, "SB301", None, "SB302"]
    assert all(bbox(r) == [480.0, 20.0, 570.0, 80.0] for r in rows[0::2])
    store.close()


# ------------------------------------------------------------------------------------------------------ (vi) overlay text
def test_a_code_printed_over_a_photo_is_inpainted_out_of_the_crop(tmp_path):
    facts = factory.overlay_text(tmp_path / "overlay.pdf")
    cfg, store, _ = extract(facts["path"], tmp_path / "w")
    (row,) = items(store)
    assert row["product_id"] == "SB400" and row["match_relation"] == "inside" and row["match_type"] == "single_image" and row["inpainted_overlay"] == 1
    plain_cfg, plain_store, _ = extract(facts["path"], tmp_path / "w2", inpaint_overlay_text=False)
    (plain,) = items(plain_store)
    assert plain["inpainted_overlay"] == 0 and plain["sha256_hash"] != row["sha256_hash"]
    cleaned = load_rgb(resolve_crop_path(cfg.work_dir, row["crop_filepath"]))
    raw = load_rgb(resolve_crop_path(plain_cfg.work_dir, plain["crop_filepath"]))
    assert cleaned.shape == raw.shape
    changed = (cleaned != raw).any(axis=2)
    assert 0 < changed.mean() <= cfg.inpaint_max_area_fraction     # only the area of the word changed
    ys, xs = np.nonzero(changed)
    # ... and the word sits where it was drawn: x from 130, baseline 560 (PDF points) inside the picture [100, 150, 500, 600]
    zoom = row["render_zoom"]
    slack = 24   # the mask is the word box plus a padding of 15 % of its height, and the inpainting radius is 3 points
    assert (130 - 100) * zoom - slack <= xs.min() and ys.min() >= (545 - 150) * zoom - slack and ys.max() <= (565 - 150) * zoom + slack
    store.close(), plain_store.close()


# ------------------------------------------------------------------------------------------------------ (vii) strips
def test_image_strips_that_touch_or_nearly_touch_are_merged_and_a_10_pt_gap_is_not(tmp_path):
    facts = factory.touching_strips(tmp_path / "strips.pdf")
    cfg, store, _ = extract(facts["path"], tmp_path / "w")
    rows = items(store)
    assert [bbox(r) for r in rows] == [[60.0, 100.0, 200.0, 460.0], [300.0, 100.0, 440.0, 341.0], [300.0, 500.0, 440.0, 620.0], [300.0, 630.0, 440.0, 750.0]]
    import json
    assert [len(json.loads(r["image_xrefs"])) for r in rows] == [3, 2, 1, 1]
    assert rows[0]["product_id"] == "SB500" and all(r["product_id"] is None for r in rows[1:])
    store.close()


# ------------------------------------------------------------------------------------------------------ (viii) no pictures at all
def test_a_page_without_embedded_pictures_falls_back_to_finding_the_swatches_in_the_render(tmp_path):
    facts = factory.vector_swatches(tmp_path / "vector.pdf")
    cfg, store, _ = extract(facts["path"], tmp_path / "w")
    rows = items(store)
    assert pages(store)[1]["extraction_method"] == "raster_segmentation"
    assert [r["product_id"] for r in rows] == facts["codes"] and {r["image_xrefs"] for r in rows} == {"[]"}
    for row, rect in zip(rows, facts["rects"]):
        assert_box(bbox(row), [rect.x0, rect.y0, rect.x1, rect.y1], tolerance=1.0)
    store.close()


def test_the_raster_fallback_can_be_switched_off(tmp_path):
    facts = factory.vector_swatches(tmp_path / "vector.pdf")
    cfg, store, _ = extract(facts["path"], tmp_path / "w", enable_raster_segmentation_fallback=False)
    assert items(store) == [] and pages(store)[1]["n_items"] == 0
    store.close()


# ------------------------------------------------------------------------------------------------------ the bundle
def test_the_bundle_is_portable_paths_are_relative_and_the_pdf_is_found_by_name_or_by_hash(tmp_path):
    facts = factory.grid_with_labels(tmp_path / "catalogue one.pdf")
    cfg, store, extractor = extract(facts["path"], tmp_path / "w")
    sha = sha256_file(facts["path"])
    rows = items(store)
    for row in rows:
        assert row["source_pdf"] == "catalogue one.pdf"                      # the file NAME, not a path
        assert row["crop_filepath"] == f"crops/{safe_name('catalogue one')}_{sha[:8]}/{row['item_id']}.png"
    assert store.get_pdf(sha)["source_pdf"] == "catalogue one.pdf"
    assert crop_path_for_storage(cfg.work_dir, cfg.crops_dir / "a" / "b.png") == "crops/a/b.png"
    with pytest.raises(ValueError):
        crop_path_for_storage(cfg.work_dir, tmp_path / "elsewhere" / "b.png")

    # move the whole bundle (state.sqlite + crops/) and the PDF somewhere else, under another name
    store.close()
    moved = tmp_path / "moved bundle"
    shutil.copytree(cfg.work_dir, moved)
    pdf_dir = tmp_path / "pdfs"
    pdf_dir.mkdir()
    shutil.copy(facts["path"], pdf_dir / "renamed.pdf")
    cfg2 = PipelineConfig(work_dir=moved)
    store2 = StateStore(cfg2.state_db_path)
    tracer = LineageTracer(cfg2, store2, CatalogueExtractor(cfg2, store2), pdf_dirs=[pdf_dir])
    for row in items(store2):
        report = tracer.verify(row["item_id"])
        assert report["pdf_found"] and report["pdf_sha256_matches"] and report["crop_file_present"]
        assert report["crop_file_sha256_matches"] and report["rerendered_sha256_matches"]
    # no directory given: the PDF cannot be found, and the report says so instead of raising
    blind = LineageTracer(cfg2, store2, CatalogueExtractor(cfg2, store2))
    report = blind.verify(rows[0]["item_id"])
    assert report["pdf_found"] is False and report["pdf_sha256_matches"] is False and report["rerendered_sha256_matches"] is False
    assert report["crop_file_sha256_matches"] is True              # the crop itself is still checked
    with pytest.raises(FileNotFoundError):
        blind.draw_provenance(rows[0]["item_id"])
    # a file with the right name but different content is reported as changed (not silently accepted)
    (pdf_dir / "catalogue one.pdf").write_bytes(facts["path"].read_bytes() + b"\n%edited")
    (pdf_dir / "renamed.pdf").unlink()
    changed = LineageTracer(cfg2, store2, CatalogueExtractor(cfg2, store2), pdf_dirs=[pdf_dir]).verify(rows[0]["item_id"])
    assert changed["pdf_found"] is True and changed["pdf_sha256_matches"] is False
    with pytest.raises(KeyError):
        tracer.lineage("no-such-item")
    store2.close()


def test_an_absolute_legacy_crop_path_is_left_alone(tmp_path):
    assert resolve_crop_path(tmp_path, "/kaggle/working/crops/x.png") == Path("/kaggle/working/crops/x.png")
    assert resolve_crop_path(tmp_path, "crops/x.png") == tmp_path / "crops" / "x.png"


def test_crops_render_bit_identically_every_time_even_after_other_documents(tmp_path):
    """reset_mupdf_cache() exists for this: a crop must not depend on what was rendered before it."""
    facts = factory.grid_with_labels(tmp_path / "grid.pdf")
    other = factory.real_catalogue_like(tmp_path / "other.pdf", pages=2)
    _, first, _ = extract(facts["path"], tmp_path / "a")
    _, warm, _ = extract(other["path"], tmp_path / "b")
    _, second, _ = extract(facts["path"], tmp_path / "c")
    assert [r["sha256_hash"] for r in items(first)] == [r["sha256_hash"] for r in items(second)]
    for store in (first, warm, second):
        store.close()


# ------------------------------------------------------------------------------------------------------ driver behaviour
def test_the_page_hook_reports_progress_and_a_stop_raised_there_is_not_a_page_error(tmp_path):
    facts = factory.real_catalogue_like(tmp_path / "five.pdf", pages=5)

    class Stop(Exception):
        pass

    seen = []

    def hook(name, page_number, page_count):
        seen.append((name, page_number, page_count))
        if page_number == 2:
            raise Stop()

    cfg = PipelineConfig(work_dir=tmp_path / "w")
    cfg.ensure_dirs()
    store = StateStore(cfg.state_db_path)
    extractor = CatalogueExtractor(cfg, store, on_page=hook)
    with pytest.raises(Stop):
        extractor.run([facts["path"]])
    assert seen == [("five.pdf", 1, 5), ("five.pdf", 2, 5)]
    # pages 1 and 2 are committed, none is marked as failed, and the pdf is still 'in_progress' (resumable)
    assert {n: p["status"] for n, p in pages(store).items()} == {1: "done", 2: "done"}
    assert store.get_pdf(sha256_file(facts["path"]))["status"] == "in_progress"
    # a new extractor carries on with the remaining pages only
    seen.clear()
    CatalogueExtractor(cfg, store, on_page=lambda name, page_number, count: seen.append(page_number)).run([facts["path"]])
    assert seen == [1, 2, 3, 4, 5]                                      # pages that are done are reported too (progress is monotonic)
    assert {p["attempts"] for p in pages(store).values()} == {1}        # ... but pages 1 and 2 were not extracted again
    assert store.get_pdf(sha256_file(facts["path"]))["status"] == "done" and len(items(store)) == 5
    store.close()


def test_paths_may_be_files_folders_or_missing(tmp_path, caplog):
    folder = tmp_path / "in" / "nested"
    folder.mkdir(parents=True)
    factory.real_catalogue_like(folder / "a.pdf", pages=1, label_prefix="SB8")
    factory.real_catalogue_like(tmp_path / "in" / "b.PDF", pages=2, label_prefix="SB9")
    (tmp_path / "in" / "c.txt").write_text("x")
    cfg = PipelineConfig(work_dir=tmp_path / "w")
    cfg.ensure_dirs()
    store = StateStore(cfg.state_db_path)
    extractor = CatalogueExtractor(cfg, store)
    assert [p.name for p in extractor.discover_pdfs(tmp_path / "in")] == ["b.PDF", "a.pdf"] or {p.name for p in extractor.discover_pdfs(tmp_path / "in")} == {"a.pdf", "b.PDF"}
    assert extractor.discover_pdfs(tmp_path / "does-not-exist") == []
    extractor.run([tmp_path / "in", tmp_path / "does-not-exist"])
    assert len(items(store)) == 3 and {r["source_pdf"] for r in items(store)} == {"a.pdf", "b.PDF"}
    store.close()


# ------------------------------------------------------------------------------------------------------ small pure helpers
def test_merge_overlapping_regions_chains_and_keeps_distant_regions_apart():
    def region(x0, y0, x1, y1, xref, ppp):
        return ImageRegion(rect=fitz.Rect(x0, y0, x1, y1), xrefs=[xref], native_pixels_per_point=ppp, method="embedded_image")

    merged = merge_overlapping_regions([region(0, 0, 10, 10, 1, 2.0), region(30, 30, 40, 40, 4, 1.0), region(10, 0, 20, 10, 2, 5.0), region(20, 0, 30, 10, 3, 3.0)], 1.5)
    assert sorted(m.rect.irect.to_list() if hasattr(m.rect.irect, "to_list") else list(m.rect.irect) for m in merged) == [[0, 0, 30, 10], [30, 30, 40, 40]]
    big = next(m for m in merged if m.rect.width > 20)
    assert sorted(big.xrefs) == [1, 2, 3] and big.native_pixels_per_point == 5.0
    assert merge_overlapping_regions([region(0, 0, 10, 10, 1, 1.0), region(10.5, 0, 20, 10, 2, 1.0)], 0) == [
        region(0, 0, 10, 10, 1, 1.0), region(10.5, 0, 20, 10, 2, 1.0)] or len(merge_overlapping_regions([region(0, 0, 10, 10, 1, 1.0), region(10.5, 0, 20, 10, 2, 1.0)], 0)) == 2


def test_small_geometry_helpers():
    assert rect_to_list(fitz.Rect(1.00049, 2, 3.0006, 4.1)) == [1.0, 2.0, 3.001, 4.1]
    assert overlap_length(0, 10, 5, 20) == 5 and overlap_length(0, 1, 2, 3) == 0.0
    assert safe_name("My catalogue (v2)!.pdf") == "My_catalogue_v2_.pdf" and safe_name("###") == "pdf" and len(safe_name("x" * 100)) == 60
