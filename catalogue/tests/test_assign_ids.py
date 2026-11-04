"""assign_ids: the product codes printed in the PDF go onto the items and into a new release, and nothing else moves.

A synthetic catalogue (five pages, the real vector sizes) is published into a LocalObjectStore + MemoryCatalogueDb, as the real one was. Then:
the real table of the real catalogue is checked field by field; a dry run writes nothing; an apply changes the item documents and makes a new live
release whose vectors are byte-identical; a second apply does nothing; an undo puts everything back; a table that does not fit changes nothing."""
import copy
import io
import json
from pathlib import Path

import numpy as np
import pytest

from factories import make_bundle, new_environment, store_listing
from terucon_catalogue import assign_ids, cli, publish as publish_module
from terucon_catalogue.assign_ids import AssignError, apply_assignment, display_name, load_id_table, plan_assignment, restore_assignment
from terucon_catalogue.config import PipelineConfig
from terucon_catalogue.publish import publish_bundle
from terucon_catalogue.release_writer import read_release

CAT = "superbond-colour"
REAL_TABLE = Path(__file__).resolve().parent.parent / "data" / "superbond-colour-ids.json"


@pytest.fixture(autouse=True)
def fake_clock(monkeypatch):
    state = {"now": 1_793_000_000_000}

    def tick():
        state["now"] += 1000
        return state["now"]

    monkeypatch.setattr(publish_module, "CLOCK", tick)
    return state


def write_table(path: Path, pages: dict, **over) -> Path:
    doc = {"catalogue": CAT, "prefix": "TIPL-", "pdf": {"sha256": None}, "pages": pages}
    doc.update(over)
    path.write_text(json.dumps(doc), encoding="utf-8")
    return path


FIVE = {"1": {"code": None, "printedName": None, "hide": True},
        "2": {"code": "SB804", "printedName": "EMPERADOR DARK"},
        "3": {"code": "SB005", "printedName": "NATURAL TEAK TX"},
        "4": {"code": "CMT6001", "printedName": "METAFRAZO TEXTURE"},
        "5": {"code": "SB005", "printedName": "NATURAL TEAK TX"}}


@pytest.fixture
def live(tmp_path):
    """A published, activated five-item catalogue; returns (store, db, info, table_path)."""
    store, db = new_environment(tmp_path)
    info = make_bundle(tmp_path / "bundle", n_items=5)
    publish_bundle(info.path, catalogue=CAT, store=store, db=db, cfg=PipelineConfig(), activate=True)
    return store, db, info, write_table(tmp_path / "ids.json", FIVE)


def test_the_real_table_of_the_real_catalogue():
    table = load_id_table(REAL_TABLE)
    assert table.catalogue == CAT and table.prefix == "TIPL-" and len(table.pages) == 69
    codes = [e.code for e in table.pages.values() if e.code]
    assert len(codes) == 68 and len(set(codes)) == 63
    assert table.pages[1].hide and table.pages[1].code is None
    assert table.product_id(32) == table.product_id(66) == "TIPL-SB804"
    assert table.pages[32].printed_name == "EMPERADOR DARK"
    repeats = {code: table.pages_of(code) for code in set(codes) if len(table.pages_of(code)) > 1}
    assert repeats == {"SB005": [17, 64], "SB804": [32, 66], "SB902": [24, 65], "SB915": [29, 61], "SB923": [23, 67]}
    assert all(len(table.product_id(p)) <= 40 for p in table.pages if table.pages[p].code)


def test_display_name_never_corrects_a_spelling():
    assert display_name("EMPERADOR DARK") == "Emperador Dark"
    assert display_name("NATURAL TEAK TX") == "Natural Teak TX"
    assert display_name("CORTERN BROWN") == "Cortern Brown"
    assert display_name("ZURICH BEIGE SAND") == "Zurich Beige Sand"


@pytest.mark.parametrize("pages, fragment", [
    ({"2": {"code": "sb804", "printedName": "X"}}, "capital letters then digits"),
    ({"2": {"code": "SB804"}}, "needs its printed name"),
    ({"2": {"code": None, "printedName": None}}, "must say"),
    ({"two": {"code": "SB1", "printedName": "X"}}, "page number"),
    ({"2": {"code": "SB804", "printedName": "A"}, "3": {"code": "SB804", "printedName": "B"}}, "different names"),
])
def test_a_bad_table_is_refused_with_every_problem_named(tmp_path, pages, fragment):
    with pytest.raises(AssignError) as caught:
        load_id_table(write_table(tmp_path / "t.json", pages))
    assert any(fragment in problem for problem in caught.value.problems)


def test_a_bad_prefix_and_catalogue_are_refused(tmp_path):
    with pytest.raises(AssignError) as caught:
        load_id_table(write_table(tmp_path / "t.json", FIVE, prefix="tipl", catalogue="Not A Catalogue!"))
    assert len(caught.value.problems) == 2


def test_a_dry_run_changes_nothing(live):
    store, db, info, table_path = live
    before_store, before_db = store_listing(store), copy.deepcopy(db.snapshot())
    plan = plan_assignment(load_id_table(table_path), catalogue=CAT, store=store, db=db)
    assert len(plan.changes) == 5 and plan.unchanged == 0 and plan.release_changes == 4
    text = "\n".join(plan.lines(dry_run=True))
    assert "would" in text and "TIPL-SB005 is printed on pages [3, 5]" in text and "page(s) 1" in text
    assert store_listing(store) == before_store and db.snapshot() == before_db


def test_apply_puts_the_ids_on_the_items_and_in_a_new_live_release(live, tmp_path):
    store, db, info, table_path = live
    old_live = db.get_catalogue(CAT)["activeRelease"]
    old = read_release(store, CAT, old_live)
    plan = plan_assignment(load_id_table(table_path), catalogue=CAT, store=store, db=db)
    result = apply_assignment(plan, store=store, db=db, backup_path=tmp_path / "backup.json")
    assert result.activated and result.release_id != old_live and result.previous_release == old_live

    docs = db.get_items(CAT)
    by_page = {d["source"]["page"]: d for d in docs.values()}
    assert by_page[2]["productId"] == "TIPL-SB804" and by_page[2]["productIdSource"] == "admin" and by_page[2]["label"] == "Emperador Dark"
    assert by_page[2]["attributes"] == {"code": "SB804", "printedName": "EMPERADOR DARK", "pdfPage": 2}
    assert by_page[3]["productId"] == by_page[5]["productId"] == "TIPL-SB005"
    assert by_page[3]["attributes"]["otherPages"] == "5" and by_page[5]["attributes"]["otherPages"] == "3"
    assert by_page[1]["productId"] is None and by_page[1]["status"] == "hidden"
    assert by_page[2]["itemId"] == info.item_ids[1]                       # the internal key did not move

    catalogue = db.get_catalogue(CAT)
    assert catalogue["activeRelease"] == result.release_id and catalogue["previousRelease"] == old_live
    assert catalogue["counts"] == {"items": 5, "hidden": 1}      # items is all of them; the website shows items - hidden

    new = read_release(store, CAT, result.release_id)                     # read_release verifies every sha256
    assert new.manifest["parent"] == old_live and set(new.items) == set(old.items)
    assert {e["productId"] for e in new.items.values() if e["productId"]} == {"TIPL-SB804", "TIPL-SB005", "TIPL-CMT6001"}
    for name, (ids, matrix) in old.pillars.items():                       # not one vector or row id moved
        assert new.pillars[name][0] == ids and np.array_equal(new.pillars[name][1], matrix)
        assert new.manifest["pillars"][name]["sha256"] == old.manifest["pillars"][name]["sha256"]
    for item_id, entry in old.items.items():                              # only productId differs in items.json
        assert {k: v for k, v in new.items[item_id].items() if k != "productId"} == {k: v for k, v in entry.items() if k != "productId"}
    assert read_release(store, CAT, old_live).manifest_bytes == old.manifest_bytes   # the old release is untouched


def test_a_second_apply_does_nothing(live, tmp_path):
    store, db, info, table_path = live
    table = load_id_table(table_path)
    apply_assignment(plan_assignment(table, catalogue=CAT, store=store, db=db), store=store, db=db, backup_path=tmp_path / "b.json")
    before_store, before_db = store_listing(store), copy.deepcopy(db.snapshot())
    again = plan_assignment(table, catalogue=CAT, store=store, db=db)
    assert again.nothing_to_do and again.unchanged == 5
    result = apply_assignment(again, store=store, db=db, backup_path=tmp_path / "never-written.json")
    assert result.changed_items == 0 and not (tmp_path / "never-written.json").exists()
    assert store_listing(store) == before_store and db.snapshot() == before_db


def test_undo_puts_back_the_items_and_the_live_release(live, tmp_path):
    store, db, info, table_path = live
    old_live = db.get_catalogue(CAT)["activeRelease"]
    before_docs = copy.deepcopy(db.get_items(CAT))
    apply_assignment(plan_assignment(load_id_table(table_path), catalogue=CAT, store=store, db=db), store=store, db=db, backup_path=tmp_path / "b.json")
    assert restore_assignment(tmp_path / "b.json", store=store, db=db) == 5
    after = db.get_items(CAT)
    for item_id, doc in before_docs.items():
        for key in ("productId", "productIdSource", "label", "status", "attributes"):
            assert after[item_id].get(key) == doc.get(key), (item_id, key)
    assert db.get_catalogue(CAT)["activeRelease"] == old_live


def test_a_page_the_table_does_not_know_changes_nothing(live, tmp_path):
    store, db, info, table_path = live
    pages = {k: v for k, v in FIVE.items() if k != "4"}
    before_store, before_db = store_listing(store), copy.deepcopy(db.snapshot())
    with pytest.raises(AssignError) as caught:
        plan_assignment(load_id_table(write_table(tmp_path / "short.json", pages)), catalogue=CAT, store=store, db=db)
    assert "page 4" in " ".join(caught.value.problems)
    assert store_listing(store) == before_store and db.snapshot() == before_db


def test_a_page_in_the_table_without_an_item_is_only_a_warning(live, tmp_path):
    store, db, info, table_path = live
    pages = {**FIVE, "6": {"code": "SB1000", "printedName": "EXTRA"}}
    plan = plan_assignment(load_id_table(write_table(tmp_path / "long.json", pages)), catalogue=CAT, store=store, db=db)
    assert any("page(s) [6]" in w for w in plan.warnings) and len(plan.changes) == 5


def test_the_wrong_catalogue_and_the_wrong_pdf_are_refused(live, tmp_path):
    store, db, info, table_path = live
    with pytest.raises(AssignError, match="not 'other-catalogue'"):
        plan_assignment(load_id_table(table_path), catalogue="other-catalogue", store=store, db=db)
    other_pdf = write_table(tmp_path / "pdf.json", FIVE, pdf={"sha256": "0" * 64})
    with pytest.raises(AssignError) as caught:
        plan_assignment(load_id_table(other_pdf), catalogue=CAT, store=store, db=db)
    assert "another sha256" in " ".join(caught.value.problems)


def test_no_backup_no_write(live):
    store, db, info, table_path = live
    plan = plan_assignment(load_id_table(table_path), catalogue=CAT, store=store, db=db)
    before = store_listing(store)
    with pytest.raises(AssignError, match="backup"):
        apply_assignment(plan, store=store, db=db, backup_path=None)
    assert store_listing(store) == before


def test_vectors_that_would_not_round_trip_stop_before_any_write(live, tmp_path, monkeypatch):
    store, db, info, table_path = live
    plan = plan_assignment(load_id_table(table_path), catalogue=CAT, store=store, db=db)
    monkeypatch.setattr(assign_ids, "npy_bytes", lambda matrix: b"different bytes")
    before_store, before_db = store_listing(store), copy.deepcopy(db.snapshot())
    with pytest.raises(AssignError, match="byte for byte"):
        apply_assignment(plan, store=store, db=db, backup_path=tmp_path / "b.json")
    assert store_listing(store) == before_store
    assert db.snapshot() == before_db                                      # not even an item document changed


def test_the_command_line_is_a_dry_run_unless_apply(live, tmp_path):
    store, db, info, table_path = live
    out, err = io.StringIO(), io.StringIO()
    before = copy.deepcopy(db.snapshot())
    assert cli.main(["assign-ids", "--catalogue", CAT, "--table", str(table_path)], store=store, db=db, out=out, err=err, environ={}) == 0
    assert "dry run" in out.getvalue() and db.snapshot() == before
    backup = tmp_path / "backup.json"
    out = io.StringIO()
    assert cli.main(["assign-ids", "--catalogue", CAT, "--table", str(table_path), "--apply", "--backup", str(backup)], store=store, db=db, out=out, err=err, environ={}) == 0
    assert backup.exists() and "To undo" in out.getvalue()
    assert any(d.get("productId") for d in db.get_items(CAT).values())
    assert cli.main(["assign-ids", "--catalogue", CAT, "--undo", str(backup)], store=store, db=db, out=io.StringIO(), err=err, environ={}) == 0
    assert all(d.get("productId") is None for d in db.get_items(CAT).values())
