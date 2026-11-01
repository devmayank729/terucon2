"""The extractor against the NOTEBOOK's own CatalogueExtractor + StateStore (executed from terucon-cat-1.ipynb by the oracle) on the same PDFs.

For every synthetic PDF the notebook's code and the port run into separate work dirs. The rows must be equal on every column except the ones
that are different on purpose: items.crop_filepath (absolute in the notebook, relative to work_dir here), source_pdf (absolute path vs file name)
and the timestamps. The crop FILES must be byte-identical (same sha256) and so must the lineage reports and the provenance picture.
"""
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import nb_oracle  # noqa: E402
import pdf_factory as factory  # noqa: E402

from terucon_catalogue.config import PipelineConfig as PortConfig  # noqa: E402
from terucon_catalogue.extract import CatalogueExtractor as PortExtractor  # noqa: E402
from terucon_catalogue.extract import LineageTracer as PortTracer  # noqa: E402
from terucon_catalogue.state import StateStore as PortStore  # noqa: E402
from terucon_catalogue.util import sha256_file  # noqa: E402

pytestmark = pytest.mark.usefixtures("need_notebook")


@pytest.fixture(scope="module")
def need_notebook():
    nb_oracle.require_notebook()


@pytest.fixture(scope="module")
def nb():
    return nb_oracle.load([
        (1, ["KAGGLE_INPUT_ROOT", "PDF_PATH", "SA_SECRET_NAME", "REQUIRE_DUAL_GPU", "sha256_bytes", "sha256_file", "atomic_write_bytes",
             "l2_normalize_rows", "load_rgb", "resize_max_side", "encode_rgb", "utc_now_iso"]),
        (2, ["DEFAULT_PHOTO_WEIGHTS", "DEFAULT_TEXT_WEIGHTS", "DEFAULT_DIRECTION_WEIGHTS", "PipelineConfig", "EmbeddingRow", "StateStore"]),
        (3, ["ID_STRIP_CHARACTERS"]),
        (3, "*defs"),
    ])


@pytest.fixture(scope="module")
def pdfs(tmp_path_factory):
    folder = tmp_path_factory.mktemp("synthetic-pdfs")
    built = {
        "grid": factory.grid_with_labels(folder / "grid.pdf"),
        "grid_rotated": factory.grid_with_labels(folder / "grid_rotated.pdf", rotation=90),
        "real_like": factory.real_catalogue_like(folder / "real_like.pdf", pages=5),
        "flattened": factory.flattened_scan(folder / "flattened.pdf"),
        "logo_5_pages": factory.logo_on_every_page(folder / "logo5.pdf", pages=5),
        "logo_3_pages": factory.logo_on_every_page(folder / "logo3.pdf", pages=3),
        "overlay": factory.overlay_text(folder / "overlay.pdf"),
        "strips": factory.touching_strips(folder / "strips.pdf"),
        "vector": factory.vector_swatches(folder / "vector.pdf"),
    }
    return {name: facts["path"] for name, facts in built.items()}


# ---------------------------------------------------------------------------------------------------------------------
def run_notebook(nb, source, work):
    cfg = nb["PipelineConfig"]()
    cfg.work_dir = work
    cfg.pdf_path = Path(source)
    cfg.ensure_dirs()
    store = nb["StateStore"](cfg.state_db_path)
    extractor = nb["CatalogueExtractor"](cfg, store)
    extractor.run()
    return cfg, store, extractor


def run_port(source, work, **config_overrides):
    cfg = PortConfig(work_dir=work, **config_overrides)
    cfg.ensure_dirs()
    store = PortStore(cfg.state_db_path)
    extractor = PortExtractor(cfg, store)
    extractor.run([source])
    return cfg, store, extractor


def table(store, sql):
    return [dict(row) for row in store.query(sql)]


def close_store(store):
    store.connection.close()   # the notebook's StateStore has no close()


def normalised_items(rows, work, notebook):
    out = []
    for row in rows:
        row = dict(row)
        row.pop("created_at")
        if notebook:
            row["crop_filepath"] = Path(row["crop_filepath"]).relative_to(work).as_posix()
            row["source_pdf"] = Path(row["source_pdf"]).name
        out.append(row)
    return out


def assert_same_bundle(nb_side, port_side):
    (nb_cfg, nb_store, _), (port_cfg, port_store, _) = nb_side, port_side
    # items: every column but the timestamps; the path columns compared after normalising
    nb_items = normalised_items(table(nb_store, "SELECT * FROM items ORDER BY item_id"), nb_cfg.work_dir, True)
    port_items = normalised_items(table(port_store, "SELECT * FROM items ORDER BY item_id"), port_cfg.work_dir, False)
    assert nb_items, "the notebook found no items: the scenario is wrong"
    assert port_items == nb_items
    # the stored paths ARE relative and posix in the port
    for row in port_items:
        assert not Path(row["crop_filepath"]).is_absolute() and "\\" not in row["crop_filepath"]
        assert row["crop_filepath"].startswith("crops/")
    # the crop FILES are the same bytes, and are what the rows say
    for nb_row, port_row in zip(table(nb_store, "SELECT * FROM items ORDER BY item_id"), port_items):
        nb_file = Path(nb_row["crop_filepath"])
        port_file = port_cfg.work_dir / port_row["crop_filepath"]
        assert nb_file.read_bytes() == port_file.read_bytes()
        assert sha256_file(port_file) == port_row["sha256_hash"] == nb_row["sha256_hash"]
    # pages (the debug json is compared as data), pdfs, orphans
    for sql in ("SELECT * FROM pages ORDER BY pdf_sha256, page_number", "SELECT * FROM pdfs ORDER BY pdf_sha256"):
        nb_rows, port_rows = table(nb_store, sql), table(port_store, sql)
        assert len(nb_rows) == len(port_rows) and nb_rows
        for a, b in zip(nb_rows, port_rows):
            for key in ("updated_at", "source_pdf"):
                a.pop(key), b.pop(key)
            if "debug_json" in a:
                a["debug_json"], b["debug_json"] = json.loads(a["debug_json"]), json.loads(b["debug_json"])
            assert a == b
    sql = "SELECT * FROM orphan_ids ORDER BY pdf_sha256, page_number, product_id, id_bbox"
    assert table(nb_store, sql) == table(port_store, sql)
    # source_pdf columns: absolute path in the notebook, the file name in the port
    for sql in ("SELECT source_pdf FROM pdfs", "SELECT source_pdf FROM pages", "SELECT source_pdf FROM items"):
        assert [Path(r["source_pdf"]).name for r in table(nb_store, sql)] == [r["source_pdf"] for r in table(port_store, sql)]
        assert all("/" not in r["source_pdf"] for r in table(port_store, sql))


SCENARIOS = ["grid", "grid_rotated", "real_like", "flattened", "logo_5_pages", "logo_3_pages", "overlay", "strips", "vector"]


@pytest.mark.parametrize("scenario", SCENARIOS)
def test_rows_and_crop_bytes_equal_the_notebooks(nb, pdfs, tmp_path, scenario):
    nb_side = run_notebook(nb, pdfs[scenario], tmp_path / "nb")
    port_side = run_port(pdfs[scenario], tmp_path / "port")
    assert_same_bundle(nb_side, port_side)
    for side in (nb_side, port_side):
        close_store(side[1])


@pytest.mark.parametrize("scenario", ["grid", "flattened", "overlay"])
def test_lineage_report_and_provenance_picture_equal_the_notebooks(nb, pdfs, tmp_path, scenario):
    nb_cfg, nb_store, nb_extractor = run_notebook(nb, pdfs[scenario], tmp_path / "nb")
    port_cfg, port_store, port_extractor = run_port(pdfs[scenario], tmp_path / "port")
    nb_tracer = nb["LineageTracer"](nb_cfg, nb_store, nb_extractor)
    port_tracer = PortTracer(port_cfg, port_store, port_extractor, pdf_dirs=[pdfs[scenario].parent])
    for item_id in [row["item_id"] for row in table(nb_store, "SELECT item_id FROM items ORDER BY item_id")]:
        theirs, ours = nb_tracer.verify(item_id), port_tracer.verify(item_id)
        assert theirs["pdf_sha256_matches"] and theirs["crop_file_sha256_matches"] and theirs["rerendered_sha256_matches"]
        assert ours.pop("pdf_found") is True            # the one key the port adds
        for key in ("source_pdf",):
            theirs.pop(key), ours.pop(key)
        assert ours == theirs
        nb_picture = nb_tracer.draw_provenance(item_id)
        port_picture = port_tracer.draw_provenance(item_id)
        assert nb_picture.read_bytes() == port_picture.read_bytes()
        # lineage() is the row with the boxes decoded, in both
        a, b = nb_tracer.lineage(item_id), port_tracer.lineage(item_id)
        assert a["image_bbox"] == b["image_bbox"] and a["id_bbox"] == b["id_bbox"] and a["product_id"] == b["product_id"]


def test_a_folder_of_pdfs_and_a_second_run_equal_the_notebooks(nb, pdfs, tmp_path):
    folder = tmp_path / "folder"
    folder.mkdir()
    for name in ("grid", "real_like", "logo_5_pages"):
        (folder / f"{name}.pdf").write_bytes(pdfs[name].read_bytes())
    (folder / "notes.txt").write_text("not a pdf")
    nb_side = run_notebook(nb, folder, tmp_path / "nb")
    port_side = run_port(folder, tmp_path / "port")
    assert_same_bundle(nb_side, port_side)
    # a second run skips what is done: nothing is re-rendered, nothing changes (both)
    sql = "SELECT item_id, sha256_hash, created_at FROM items ORDER BY item_id"
    before = [table(side[1], sql) for side in (nb_side, port_side)]
    nb_side[2].run()
    port_side[2].run([folder])
    for side, earlier in zip((nb_side, port_side), before):
        assert table(side[1], sql) == earlier
        assert {row["attempts"] for row in table(side[1], "SELECT attempts FROM pages")} == {1}
        close_store(side[1])


def test_an_unreadable_pdf_is_recorded_as_an_error_by_both(nb, tmp_path):
    broken = tmp_path / "broken.pdf"
    broken.write_bytes(b"%PDF-1.4\nthis is not a pdf at all\n")
    nb_side = run_notebook(nb, broken, tmp_path / "nb")
    port_side = run_port(broken, tmp_path / "port")
    for side in (nb_side, port_side):
        rows = table(side[1], "SELECT status, page_count FROM pdfs")
        assert rows == [{"status": "error", "page_count": 0}]
        assert table(side[1], "SELECT COUNT(*) AS n FROM items") == [{"n": 0}]
        close_store(side[1])


def test_negative_control_the_comparison_does_fail_when_the_port_differs(nb, pdfs, tmp_path):
    """A parity check that cannot fail proves nothing: change one setting of the port and the same comparison must catch it."""
    nb_side = run_notebook(nb, pdfs["overlay"], tmp_path / "nb")
    port_side = run_port(pdfs["overlay"], tmp_path / "port", inpaint_overlay_text=False)
    with pytest.raises(AssertionError):
        assert_same_bundle(nb_side, port_side)
    for side in (nb_side, port_side):
        close_store(side[1])
