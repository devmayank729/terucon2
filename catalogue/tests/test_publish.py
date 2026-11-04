"""publish_bundle end to end: a synthetic bundle (both path styles) into LocalObjectStore + MemoryCatalogueDb, and through the real GCS SDK on a fake transport.

Covers: item documents field by field (4.4), the release files (4.2/4.3) with every sha256, validation before any write, the dry run, idempotence,
merging with a parent release, the version refusal, admin edits surviving a re-publish, and an interrupted publish leaving the live release alone."""
import hashlib
import io
import json
import re
import sqlite3
import time

import numpy as np
import pytest

from factories import (DISABLE_BUCKET_MD_ENV, FlakyDb, FlakyStore, InjectedFailure, PDF_NAME, REAL_DIMS, RecordingStore, _sql, delete_crop, drop_vector, flip_crop_byte,
                       make_bundle, make_gcs_store, new_environment, set_feature_version, store_listing)
from terucon_catalogue import __version__, publish as publish_module
from terucon_catalogue.config import PipelineConfig, compute_feature_versions
from terucon_catalogue.publish import (ActivationError, PublishError, PublishResult, activate_release, make_thumbnail, manual_job_id, new_release_id, publish_bundle,
                                       safe_file_name, source_key)
from terucon_catalogue.release_writer import read_release, release_prefix

CAT = "superbond-colour"
CFG = PipelineConfig()
EPOCH = 1_793_000_000_000


@pytest.fixture(autouse=True)
def fake_clock(monkeypatch):
    """Every call to the publisher's clock is one second later than the one before, so release ids and createdAt values are ordered and reproducible."""
    state = {"now": EPOCH}

    def tick():
        state["now"] += 1000
        return state["now"]

    monkeypatch.setattr(publish_module, "CLOCK", tick)
    return state


def publish(info, store, db, **kwargs):
    kwargs.setdefault("catalogue", CAT)
    return publish_bundle(info.path, store=store, db=db, cfg=CFG, **kwargs)


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


@pytest.fixture(params=[False, True], ids=["relative-paths", "kaggle-absolute-paths"])
def legacy(request):
    return request.param


def untouched(store, db, action):
    """Run `action` and require that it changed neither the store nor the database."""
    before_store, before_db = store_listing(store), db.snapshot()
    try:
        action()
    finally:
        assert store_listing(store) == before_store, "the store changed"
        assert db.snapshot() == before_db, "the database changed"


# =============================================================================================================== documents and files
def test_item_documents_match_4_4_field_by_field(tmp_path, legacy):
    info = make_bundle(tmp_path / "b", 3, legacy_kaggle_paths=legacy, product_ids={1: "SB804"}, crop_px=(48, 64))
    store, db = new_environment(tmp_path)
    result = publish(info, store, db, job_id="job-20261101000000-abc123", source_files={info.pdf_sha256: info.pdf_path}, created_by="cli")
    docs = db.get_items(CAT)
    assert sorted(docs) == info.item_ids and result.n_items == 3 and result.n_new == 3
    for position, item_id in enumerate(info.item_ids):
        doc = docs[item_id]
        crop_bytes = info.crop_paths[item_id].read_bytes()
        assert set(doc) == {"_id", "catalogue", "itemId", "status", "label", "productId", "productIdSource", "subtype", "category", "finish", "description", "dominantHex",
                            "proportions", "captionModel", "captionVersion", "source", "images", "attributes", "releaseFirst", "jobId", "createdAt", "updatedAt"}
        assert "title" not in doc
        assert doc["_id"] == f"{CAT}|{item_id}" and doc["catalogue"] == CAT and doc["itemId"] == item_id and doc["status"] == "ok" and doc["label"] is None
        assert doc["attributes"] == {} and doc["jobId"] == "job-20261101000000-abc123" and doc["releaseFirst"] == result.release_id
        assert isinstance(doc["createdAt"], int) and doc["createdAt"] == doc["updatedAt"] > EPOCH
        pdf_id = "SB804" if position == 1 else None
        assert doc["productId"] == pdf_id and doc["productIdSource"] == ("pdf-text" if pdf_id else None) and doc["source"]["pdfProductId"] == pdf_id
        assert doc["subtype"] == f"polished black marble {position}" and doc["category"] == "stone" and doc["finish"] == "polished"
        assert doc["description"] == {"grain": "fine white veining on a dark ground", "patternScale": "about 20 mm", "colour": "#271C1C base, #F1ECEA veins",
                                      "specular": "broad soft highlights", "feel": "smooth, cool", "keywords": ["marble", "black", "polished", "veined", "stone", "dark", "luxury", "tile"]}
        assert doc["dominantHex"][:2] == ["#4C4C4E", "#F2EFEF"] and doc["proportions"] == [0.5, 0.3, 0.2]
        assert doc["captionModel"] == "gemini-2.5-flash" and re.fullmatch(r"[0-9a-f]{12}", doc["captionVersion"])
        assert doc["source"] == {"name": PDF_NAME, "sha256": info.pdf_sha256, "page": position + 1, "itemIndex": 0, "bbox": [26.833, 15.0, 568.166, 827.0], "idBbox": None,
                                 "pageWidth": 595.0, "pageHeight": 842.0, "rotation": 0, "method": "embedded_image", "matchType": "single_image" if pdf_id else "none",
                                 "matchRelation": "below" if pdf_id else None, "matchCost": 0.01 if pdf_id else None, "inpainted": False, "pdfProductId": pdf_id}
        crop = doc["images"]["crop"]
        assert crop == {"key": f"crops/{CAT}/{item_id}.png", "width": 48, "height": 64, "sha256": sha(crop_bytes), "bytes": len(crop_bytes)}
        assert store.get_bytes(crop["key"]) == crop_bytes                                                    # the crop exactly as the extractor wrote it
        thumb = doc["images"]["thumb"]
        assert thumb["key"] == f"thumbs/{CAT}/{item_id}.jpg" and set(thumb) == {"key", "width", "height", "bytes"}
        assert len(store.get_bytes(thumb["key"])) == thumb["bytes"]
    release = db.get_release(result.release_id)
    assert release == {"_id": result.release_id, "catalogue": CAT, "createdAt": release["createdAt"], "createdBy": "cli", "jobId": "job-20261101000000-abc123", "parent": None,
                       "nItems": 3, "featureVersions": release["featureVersions"], "pillars": {name: {"count": 3, "dim": dim} for name, dim in REAL_DIMS.items()},
                       "gcsPrefix": f"releases/{CAT}/{result.release_id}/", "manifestSha256": sha(store.get_bytes(f"releases/{CAT}/{result.release_id}/manifest.json"))}
    assert release["featureVersions"] == info.versions


def test_the_release_files_are_the_4_3_release_and_every_hash_verifies(tmp_path, legacy):
    info = make_bundle(tmp_path / "b", 4, legacy_kaggle_paths=legacy, product_ids={0: "SB100"})
    store, db = new_environment(tmp_path)
    result = publish(info, store, db, activate=True)
    prefix = f"releases/{CAT}/{result.release_id}/"
    assert re.fullmatch(r"rel-\d{14}-[0-9a-f]{6}", result.release_id)
    assert sorted(key[len(prefix):] for key in store.list(prefix)) == sorted(
        ["manifest.json", "items.json"] + [f"pillars/{p}.{ext}" for p in REAL_DIMS for ext in ("npy", "ids.json")])
    manifest = json.loads(store.get_bytes(prefix + "manifest.json"))
    assert manifest["schema"] == 1 and manifest["releaseId"] == result.release_id and manifest["catalogue"] == CAT and manifest["parent"] is None and manifest["nItems"] == 4
    assert manifest["package"] == {"name": "terucon_catalogue", "version": __version__} and manifest["featureVersions"] == info.versions
    items_raw = store.get_bytes(prefix + "items.json")
    assert sha(items_raw) == manifest["itemsSha256"]
    items = json.loads(items_raw)
    assert [i["itemId"] for i in items] == info.item_ids
    assert items[0] == {"itemId": info.item_ids[0], "productId": "SB100", "page": 1, "pdfSha256": info.pdf_sha256, "category": "stone", "finish": "polished",
                        "dominantHex": ["#4C4C4E", "#F2EFEF", "#%02X%02X%02X" % (20, 120, 114)], "proportions": [0.5, 0.3, 0.2]}
    assert items[1]["productId"] is None
    for name, dim in REAL_DIMS.items():
        entry = manifest["pillars"][name]
        assert (entry["count"], entry["dim"], entry["dtype"]) == (4, dim, "float16")
        npy, ids_raw = store.get_bytes(prefix + entry["file"]), store.get_bytes(prefix + entry["idsFile"])
        assert sha(npy) == entry["sha256"] and sha(ids_raw) == entry["idsSha256"] and json.loads(ids_raw) == info.item_ids
        matrix = np.load(io.BytesIO(npy), allow_pickle=False)
        assert matrix.dtype == np.float16 and matrix.shape == (4, dim) and matrix.flags["C_CONTIGUOUS"]
        for row, item_id in enumerate(info.item_ids):
            assert matrix[row].tobytes() == info.vectors[name][item_id].tobytes()
        norms = np.linalg.norm(matrix.astype(np.float32), axis=1)
        assert np.all(np.abs(norms - 1) < 0.02)
    assert db.get_release(result.release_id)["manifestSha256"] == sha(store.get_bytes(prefix + "manifest.json"))


def test_the_search_services_own_reader_loads_the_published_release(tmp_path, legacy):
    release_reader = pytest.importorskip("terucon_catalogue.release_reader")
    info = make_bundle(tmp_path / "b", 5, legacy_kaggle_paths=legacy)
    store, db = new_environment(tmp_path)
    result = publish(info, store, db, activate=True)
    loaded = release_reader.load_release(store, CAT, result.release_id, tmp_path / "cache", info.versions, CFG)
    assert loaded.n_items == 5 and {name: m.matrix.shape for name, m in loaded.pillars.items()} == {name: (5, dim) for name, dim in REAL_DIMS.items()}


def test_source_pdf_snapshot_and_catalogue_pointer(tmp_path):
    info = make_bundle(tmp_path / "b", 3, legacy_kaggle_paths=True)
    store, db = new_environment(tmp_path)
    result = publish(info, store, db, job_id="job-20261101000000-abc123", source_files={info.pdf_sha256: info.pdf_path}, activate=True)
    key = f"sources/{info.pdf_sha256}/Superbond_colour_image.pdf"
    assert source_key(info.pdf_sha256, PDF_NAME) == key and store.get_bytes(key) == info.pdf_path.read_bytes()
    snapshot_key = f"bundles/{CAT}/job-20261101000000-abc123/state.sqlite"
    assert result.details["state_key"] == snapshot_key
    store.get_file(snapshot_key, tmp_path / "snap.sqlite")
    connection = sqlite3.connect(str(tmp_path / "snap.sqlite"))
    assert connection.execute("SELECT COUNT(*) FROM items").fetchone()[0] == 3
    assert connection.execute("SELECT source_pdf FROM pdfs").fetchone()[0].startswith("/kaggle/input/datasets/"), "the audit copy is the bundle as it was"
    connection.close()
    cat = db.get_catalogue(CAT)
    assert cat["activeRelease"] == result.release_id and cat["previousRelease"] is None and cat["featureVersions"] == info.versions and cat["counts"] == {"items": 3, "hidden": 0}
    assert result.activated and result.warnings == []


def test_without_a_job_id_the_snapshot_goes_under_a_manual_name(tmp_path):
    info = make_bundle(tmp_path / "b", 2)
    store, db = new_environment(tmp_path)
    result = publish(info, store, db)
    assert re.fullmatch(rf"bundles/{CAT}/manual-\d{{8}}T\d{{6}}Z/state\.sqlite", result.details["state_key"]) and store.exists(result.details["state_key"])
    assert re.fullmatch(r"manual-\d{8}T\d{6}Z", manual_job_id(EPOCH)) and all(d["jobId"] is None for d in db.get_items(CAT).values())
    assert not result.activated and db.get_catalogue(CAT)["activeRelease"] is None, "publishing does not make anything live by itself"


def test_the_snapshot_checkpoint_is_overwritten_not_kept_from_an_earlier_run(tmp_path):
    info = make_bundle(tmp_path / "b", 2)
    store, db = new_environment(tmp_path)
    key = f"bundles/{CAT}/job-20261101000000-abc123/state.sqlite"
    store.put_bytes(key, b"an older compute checkpoint")
    publish(info, store, db, job_id="job-20261101000000-abc123")
    assert store.get_bytes(key)[:15] == b"SQLite format 3"


def test_ids_and_names():
    assert safe_file_name("Superbond colour image.pdf") == "Superbond_colour_image.pdf"
    assert safe_file_name("a b/c\\d.PDF") == "a_b_c_d.PDF" and safe_file_name("") == "file" and safe_file_name("...") == "file"
    for hostile in ("../../etc/passwd", "/abs/path.pdf", "a\x00b.pdf", "x" * 500 + ".pdf", "..", "con\nfig.pdf"):
        cleaned = safe_file_name(hostile)
        assert re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,120}", cleaned) and ".." not in cleaned, (hostile, cleaned)
    assert len({new_release_id(EPOCH) for _ in range(50)}) == 50 and all(re.fullmatch(r"rel-\d{14}-[0-9a-f]{6}", new_release_id(EPOCH)) for _ in range(5))
    assert new_release_id(EPOCH).startswith("rel-20261026")


# ========================================================================================================================= thumbnails
def test_thumbnails_are_480_px_lanczos_jpegs_without_metadata_and_always_the_same_bytes(tmp_path):
    from PIL import Image

    info = make_bundle(tmp_path / "b", 2, crop_px=(700, 1000))
    first_path = info.crop_paths[info.item_ids[0]]
    data, width, height = make_thumbnail(first_path)
    assert data == make_thumbnail(first_path)[0] and (width, height) == (336, 480)
    image = Image.open(io.BytesIO(data))
    assert image.format == "JPEG" and image.size == (336, 480) and image.mode == "RGB"
    assert b"Exif" not in data and b"ICC_PROFILE" not in data and b"XMP" not in data and b"Photoshop" not in data
    reference = Image.open(first_path).convert("RGB").resize((336, 480), Image.Resampling.LANCZOS)
    assert np.abs(np.asarray(image, dtype=int) - np.asarray(reference, dtype=int)).mean() < 3        # same picture, only JPEG loss
    store, db = new_environment(tmp_path)
    publish(info, store, db)
    doc = db.get_items(CAT)[info.item_ids[0]]["images"]["thumb"]
    assert (doc["width"], doc["height"], doc["bytes"]) == (336, 480, len(data)) and store.get_bytes(doc["key"]) == data


def test_a_metadata_rich_crop_still_gives_a_clean_thumbnail_and_a_small_crop_is_not_enlarged(tmp_path):
    from PIL import Image

    rich = tmp_path / "rich.png"
    image = Image.new("RGB", (900, 600), (120, 60, 30))
    from PIL.PngImagePlugin import PngInfo

    meta = PngInfo()
    meta.add_text("Comment", "secret location 12.3,45.6")
    image.save(rich, pnginfo=meta, dpi=(300, 300), icc_profile=b"x" * 128)
    data, width, height = make_thumbnail(rich)
    assert (width, height) == (480, 320) and b"secret location" not in data and b"ICC_PROFILE" not in data
    small = tmp_path / "small.png"
    Image.new("RGBA", (100, 50), (255, 0, 0, 0)).save(small)
    data, width, height = make_thumbnail(small)
    assert (width, height) == (100, 50)
    assert Image.open(io.BytesIO(data)).getpixel((5, 5))[0] > 240, "transparent pixels are flattened onto white"


# ====================================================================================================== validation before any write
def test_every_validation_failure_raises_publish_error_and_writes_nothing(tmp_path):
    store, db = new_environment(tmp_path)
    cases = {}
    for name, damage in (("crop", lambda i: flip_crop_byte(i, i.item_ids[0])), ("missing", lambda i: delete_crop(i, i.item_ids[1])),
                         ("version", lambda i: set_feature_version(i, i.item_ids[0], "dino", "facebook/dinov2-large|448|v0")),
                         ("foreign-version", lambda i: [set_feature_version(i, x, "dino", "some/other-model|224|v1") for x in i.item_ids])):
        info = make_bundle(tmp_path / name, 3)
        damage(info)
        cases[name] = info
    for name, info in cases.items():
        for dry_run in (False, True):
            def attempt():
                with pytest.raises(PublishError) as caught:
                    publish(info, store, db, dry_run=dry_run, activate=True)
                assert caught.value.problems and all(isinstance(p, str) and p.endswith((".", ")")) for p in caught.value.problems)
            untouched(store, db, attempt)
    with pytest.raises(PublishError) as caught:
        publish(cases["crop"], store, db)
    assert "checksum" in caught.value.problems[0] and "Publish refused, nothing was written" in str(caught.value)
    with pytest.raises(PublishError) as caught:
        publish(cases["foreign-version"], store, db)
    assert any("cannot be compared" in p and "'dino'" in p for p in caught.value.problems)


def test_a_catalogue_that_does_not_exist_is_not_created_by_a_publish(tmp_path):
    info = make_bundle(tmp_path / "b", 2)
    store, db = new_environment(tmp_path)
    with pytest.raises(PublishError, match="does not exist") as caught:
        publish(info, store, db, catalogue="superbond-colur")
    assert "catalogues create" in caught.value.problems[0] and db.get_catalogue("superbond-colur") is None and store.list("") == []


def test_bad_arguments_are_refused_before_the_bundle_is_even_opened(tmp_path):
    info = make_bundle(tmp_path / "b", 2)
    store, db = new_environment(tmp_path)
    for kwargs, text in (({"catalogue": "Bad Id"}, "not a valid catalogue id"), ({"created_by": "somebody"}, "created_by"), ({"job_id": "job/../x"}, "cannot be a job id")):
        with pytest.raises(PublishError, match=text):
            publish(info, store, db, **kwargs)
    with pytest.raises(PublishError, match="does not exist"):
        publish_bundle(tmp_path / "no-such-folder", catalogue=CAT, store=store, db=db, cfg=CFG)
    assert store.list("") == []


def test_source_files_are_checked_before_anything_is_written(tmp_path):
    info = make_bundle(tmp_path / "b", 2)
    other = make_bundle(tmp_path / "other", 2, seed=5)
    store, db = new_environment(tmp_path)

    def attempt(source_files, text):
        with pytest.raises(PublishError, match=text):
            publish(info, store, db, source_files=source_files)

    untouched(store, db, lambda: attempt({other.pdf_sha256: other.pdf_path}, "not one of the PDFs this bundle was made from"))
    untouched(store, db, lambda: attempt({info.pdf_sha256: other.pdf_path}, "does not have the sha256 it was given under"))
    untouched(store, db, lambda: attempt({info.pdf_sha256: tmp_path / "missing.pdf"}, "is not a file"))
    untouched(store, db, lambda: attempt({other.pdf_path.name: other.pdf_path}, "not one of the PDFs this bundle was made from"))


def test_source_files_may_be_keyed_by_file_name_as_the_ingest_job_does(tmp_path):
    info = make_bundle(tmp_path / "b", 2)
    store, db = new_environment(tmp_path)
    result = publish(info, store, db, source_files={info.pdf_path.name: info.pdf_path})
    assert store.get_bytes(f"sources/{info.pdf_sha256}/Superbond_colour_image.pdf") == info.pdf_path.read_bytes() and result.details["sources_uploaded"] == 1
    assert not any("original PDF is not being stored" in w for w in result.warnings)


def test_a_missing_source_pdf_is_only_a_warning(tmp_path):
    info = make_bundle(tmp_path / "b", 2)
    store, db = new_environment(tmp_path)
    result = publish(info, store, db)
    assert any("original PDF is not being stored" in w and "--source-pdf" in w for w in result.warnings)


def test_warnings_from_the_bundle_travel_in_the_result(tmp_path):
    info = make_bundle(tmp_path / "b", 4)
    for item_id in info.item_ids[:2]:
        drop_vector(info, item_id, "vertex_mm", record_error="429")
    store, db = new_environment(tmp_path)
    result = publish(info, store, db, source_files={info.pdf_sha256: info.pdf_path})
    assert any("'vertex_mm' vectors failed for 2 items" in w for w in result.warnings) and result.n_items == 4
    assert db.get_release(result.release_id)["pillars"]["vertex_mm"]["count"] == 2


def test_items_with_no_core_vector_are_left_out_and_listed(tmp_path):
    info = make_bundle(tmp_path / "b", 4)
    for pillar in ("dino", "siglip", "color"):
        drop_vector(info, info.item_ids[3], pillar)
    store, db = new_environment(tmp_path)
    result = publish(info, store, db, source_files={info.pdf_sha256: info.pdf_path})
    assert result.n_items == 3 and result.n_dropped == 1 and result.n_bundle_items == 3 and sorted(db.get_items(CAT)) == info.item_ids[:3]
    assert any("left out" in w and info.item_ids[3] in w for w in result.warnings) and result.details["dropped_items"] == [info.item_ids[3]]
    assert not any(info.item_ids[3] in key for key in store.list("crops/") + store.list("thumbs/"))
    assert info.item_ids[3] not in json.loads(store.get_bytes(f"releases/{CAT}/{result.release_id}/items.json")).__repr__()


def test_a_bundle_where_nothing_is_searchable_is_refused(tmp_path):
    info = make_bundle(tmp_path / "b", 2, pillars=("vertex_mm", "text"))
    store, db = new_environment(tmp_path)
    with pytest.raises(PublishError, match="nothing in this bundle can be searched"):
        publish(info, store, db)


# =================================================================================================================== the dry run
def test_a_dry_run_reads_but_writes_nothing_and_says_what_would_happen(tmp_path, legacy):
    info = make_bundle(tmp_path / "b", 5, legacy_kaggle_paths=legacy)
    store, db = new_environment(tmp_path)
    recording = RecordingStore(store)
    before = db.snapshot()
    result = publish(info, recording, db, dry_run=True, activate=True, source_files={info.pdf_sha256: info.pdf_path})
    assert recording.writes == [] and db.writes == 1 and db.snapshot() == before, "the only write is the catalogue created by new_environment"
    assert not list((tmp_path / "store").rglob("*")), "not a single file or folder was created"
    assert isinstance(result, PublishResult) and result.dry_run and result.release_id is None and not result.activated and result.n_items == 5 and result.n_new == 5
    assert result.details["crops_uploaded"] == 5 and result.details["thumbs_uploaded"] == 5 and result.details["docs_added"] == 5 and result.details["would_create_release"]
    text = "\n".join(result.report)
    assert "5 searchable items" in text and "5 crops and 5 thumbnails would be uploaded" in text and "5 would be added" in text and "this will be its first" in text


def test_a_dry_run_after_a_publish_reports_unchanged_and_still_writes_nothing(tmp_path):
    info = make_bundle(tmp_path / "b", 3)
    store, db = new_environment(tmp_path)
    first = publish(info, store, db, activate=True, source_files={info.pdf_sha256: info.pdf_path})
    recording = RecordingStore(store)
    before_store, before_db = store_listing(store), db.snapshot()
    result = publish(info, recording, db, dry_run=True, activate=True, source_files={info.pdf_sha256: info.pdf_path})
    assert recording.writes == [] and store_listing(store) == before_store and db.snapshot() == before_db
    assert result.release_id == first.release_id and result.release_reused and result.nothing_to_do and result.n_new == 0 and result.n_unchanged == 3


# ============================================================================================================== idempotence
def test_publishing_the_same_bundle_twice_changes_nothing(tmp_path, legacy):
    info = make_bundle(tmp_path / "b", 6, legacy_kaggle_paths=legacy, product_ids={2: "SB2"})
    store, db = new_environment(tmp_path)
    first = publish(info, store, db, activate=True, source_files={info.pdf_sha256: info.pdf_path})
    recording = RecordingStore(store)
    before_store, before_db = store_listing(store), db.snapshot()
    writes_before = db.writes
    second = publish(info, recording, db, activate=True, source_files={info.pdf_sha256: info.pdf_path})
    assert second.release_id == first.release_id and second.n_new == 0 and second.n_changed == 0 and second.n_unchanged == 6
    assert second.nothing_to_do and second.release_reused and not second.activated and second.n_items == 6
    assert recording.writes == [] and db.writes == writes_before and store_listing(store) == before_store and db.snapshot() == before_db
    assert len(db.list_releases(CAT)) == 1 and "already published" in second.report[-1]


def test_publishing_again_with_activate_only_flips_the_pointer(tmp_path):
    info = make_bundle(tmp_path / "b", 3)
    store, db = new_environment(tmp_path)
    first = publish(info, store, db)
    assert db.get_catalogue(CAT)["activeRelease"] is None
    before = store_listing(store)
    second = publish(info, store, db, activate=True)
    assert second.release_id == first.release_id and second.activated and not second.nothing_to_do and store_listing(store) == before
    assert db.get_catalogue(CAT)["activeRelease"] == first.release_id and len(db.list_releases(CAT)) == 1


def _edit_profile(info, item_id, **changes):
    profile = json.loads(sqlite3.connect(str(info.state_path)).execute("SELECT profile_json FROM captions WHERE item_id = ?", (item_id,)).fetchone()[0])
    profile.update(changes)
    _sql(info, "UPDATE captions SET profile_json = ? WHERE item_id = ?", (json.dumps(profile), item_id))


def test_a_changed_bundle_makes_a_new_release_and_rewrites_only_the_changed_documents(tmp_path, fake_clock):
    info = make_bundle(tmp_path / "b", 4)
    store, db = new_environment(tmp_path)
    first = publish(info, store, db, activate=True)
    stamps = {item_id: doc["updatedAt"] for item_id, doc in db.get_items(CAT).items()}
    _edit_profile(info, info.item_ids[1], material_category="metal", material_subtype="re-described basalt")       # category is in items.json: the release changes
    second = publish(info, store, db, activate=True)
    assert second.release_id != first.release_id and second.n_new == 0 and second.n_changed == 1 and second.n_unchanged == 3 and second.n_items == 4
    new_stamps = {item_id: doc["updatedAt"] for item_id, doc in db.get_items(CAT).items()}
    assert new_stamps[info.item_ids[1]] > stamps[info.item_ids[1]] and all(new_stamps[i] == stamps[i] for i in info.item_ids if i != info.item_ids[1])
    assert db.get_items(CAT)[info.item_ids[1]]["subtype"] == "re-described basalt" and db.get_items(CAT)[info.item_ids[1]]["category"] == "metal"
    cat = db.get_catalogue(CAT)
    assert cat["activeRelease"] == second.release_id and cat["previousRelease"] == first.release_id
    assert db.get_release(second.release_id)["parent"] == first.release_id and second.details["docs_changed"] == 1 and second.details["docs_unchanged"] == 3


def test_a_change_that_only_touches_a_document_updates_the_document_and_keeps_the_release(tmp_path):
    info = make_bundle(tmp_path / "b", 3)
    store, db = new_environment(tmp_path)
    first = publish(info, store, db, activate=True)
    _edit_profile(info, info.item_ids[0], material_subtype="a better description")       # subtype is not in a release
    second = publish(info, store, db, activate=True)
    assert second.release_id == first.release_id and second.release_reused and not second.nothing_to_do and not second.activated
    assert second.details["docs_changed"] == 1 and db.get_items(CAT)[info.item_ids[0]]["subtype"] == "a better description" and len(db.list_releases(CAT)) == 1


# ================================================================================================================ merge with parent
def test_a_second_bundle_is_merged_into_the_parent_release(tmp_path):
    first_info = make_bundle(tmp_path / "one", 3, seed=1)
    second_info = make_bundle(tmp_path / "two", 2, seed=2, first_page=10)
    store, db = new_environment(tmp_path)
    first = publish(first_info, store, db, activate=True)
    second = publish(second_info, store, db, activate=True)
    assert second.n_items == 5 and second.n_new == 2 and second.parent_release == first.release_id
    assert sorted(db.get_items(CAT)) == sorted(first_info.item_ids + second_info.item_ids)
    parent = read_release(store, CAT, first.release_id)
    child = read_release(store, CAT, second.release_id)
    assert child.manifest["parent"] == first.release_id and child.manifest["nItems"] == 5 and sorted(child.items) == sorted(first_info.item_ids + second_info.item_ids)
    for name in REAL_DIMS:
        ids, matrix = child.pillars[name]
        assert ids == sorted(ids) and len(ids) == 5
        for position, item_id in enumerate(ids):
            expected = (first_info.vectors if item_id in first_info.item_ids else second_info.vectors)[name][item_id]
            assert matrix[position].tobytes() == expected.tobytes()
        old_ids, old_matrix = parent.pillars[name]
        assert all(old_matrix[old_ids.index(i)].tobytes() == matrix[ids.index(i)].tobytes() for i in old_ids), "the parent's rows are carried over bit for bit"
    assert store.exists(f"releases/{CAT}/{first.release_id}/manifest.json"), "the parent release is untouched"
    assert db.get_catalogue(CAT)["counts"] == {"items": 5, "hidden": 0}


def test_without_an_active_release_the_newest_release_is_the_parent(tmp_path):
    store, db = new_environment(tmp_path)
    first = publish(make_bundle(tmp_path / "one", 2, seed=1), store, db)
    second = publish(make_bundle(tmp_path / "two", 2, seed=2, first_page=10), store, db)
    assert second.parent_release == first.release_id and second.n_items == 4 and db.get_catalogue(CAT)["activeRelease"] is None


def test_a_bundle_item_replaces_the_parents_vectors_and_a_lost_signal_is_reported(tmp_path):
    info = make_bundle(tmp_path / "one", 3)
    store, db = new_environment(tmp_path)
    first = publish(info, store, db, activate=True)
    drop_vector(info, info.item_ids[0], "vertex_mm")
    _sql(info, "UPDATE embeddings SET vector = ? WHERE item_id = ? AND pillar = 'dino'", (np.full(3072, 1 / np.sqrt(3072), dtype=np.float16).tobytes(), info.item_ids[1]))
    second = publish(info, store, db, activate=True)
    child = read_release(store, CAT, second.release_id)
    assert info.item_ids[0] not in child.pillars["vertex_mm"][0] and len(child.pillars["vertex_mm"][0]) == 2
    assert any("had a 'vertex_mm' vector in the previous release" in w and info.item_ids[0] in w for w in second.warnings)
    assert second.n_changed == 2 and second.n_new == 0
    ids, matrix = child.pillars["dino"]
    assert matrix[ids.index(info.item_ids[1])].tobytes() == np.full(3072, 1 / np.sqrt(3072), dtype=np.float16).tobytes()


def test_the_version_refusal_a_catalogue_never_mixes_vector_versions(tmp_path):
    first_info = make_bundle(tmp_path / "one", 2, seed=1)
    second_info = make_bundle(tmp_path / "two", 2, seed=2, first_page=10)
    new_label = compute_feature_versions(CFG)["dino"].replace("|v1", "|v2")
    for item_id in second_info.item_ids:
        set_feature_version(second_info, item_id, "dino", new_label)
    store, db = new_environment(tmp_path)
    publish(first_info, store, db, activate=True)
    with pytest.raises(PublishError) as caught:
        untouched(store, db, lambda: publish(second_info, store, db, activate=True))
    assert any("never mixes vector versions" in p and "'dino'" in p and new_label in p for p in caught.value.problems)
    assert any("cannot be compared" in p for p in caught.value.problems), "the code's own check of the label refuses it too"


def test_a_different_caption_fingerprint_is_fine_for_the_code_but_still_refused_against_the_parent(tmp_path):
    first_info = make_bundle(tmp_path / "one", 2, seed=1)
    second_info = make_bundle(tmp_path / "two", 2, seed=2, first_page=10)
    other = compute_feature_versions(CFG)["text"].split("|cap")[0] + "|cap0123456789ab|v1"
    for item_id in second_info.item_ids:
        set_feature_version(second_info, item_id, "text", other)
    store, db = new_environment(tmp_path)
    publish(first_info, store, db, activate=True)
    with pytest.raises(PublishError) as caught:
        untouched(store, db, lambda: publish(second_info, store, db, activate=True))
    assert [p for p in caught.value.problems if "never mixes" in p] and not [p for p in caught.value.problems if "cannot be compared" in p]
    fresh_store, fresh_db = new_environment(tmp_path, store_name="fresh")
    result = publish(second_info, fresh_store, fresh_db)                                     # on its own the same bundle is fine: only a warning
    assert any("different fingerprint" in w for w in result.warnings)


def test_a_parent_release_that_cannot_be_read_blocks_a_publish_instead_of_dropping_its_items(tmp_path):
    first_info = make_bundle(tmp_path / "one", 2, seed=1)
    store, db = new_environment(tmp_path)
    first = publish(first_info, store, db, activate=True)
    store.delete(f"releases/{CAT}/{first.release_id}/pillars/dino.npy")
    second_info = make_bundle(tmp_path / "two", 2, seed=2, first_page=10)
    with pytest.raises(PublishError, match="current release cannot be used as the base"):
        untouched(store, db, lambda: publish(second_info, store, db))


def test_a_crop_already_stored_with_other_content_is_replaced_and_reported(tmp_path):
    info = make_bundle(tmp_path / "b", 3)
    store, db = new_environment(tmp_path)
    key = f"crops/{CAT}/{info.item_ids[1]}.png"
    store.put_bytes(key, b"an older, different picture")
    store.put_bytes(f"thumbs/{CAT}/{info.item_ids[1]}.jpg", b"old thumb")
    result = publish(info, store, db)
    assert store.get_bytes(key) == info.crop_paths[info.item_ids[1]].read_bytes() and result.details["crops_replaced"] == 1 and result.details["thumbs_replaced"] == 1
    assert any("replaced" in w and info.item_ids[1] in w for w in result.warnings)
    doc = db.get_items(CAT)[info.item_ids[1]]["images"]
    assert doc["crop"]["sha256"] == hashlib.sha256(store.get_bytes(key)).hexdigest() and doc["thumb"]["bytes"] == len(store.get_bytes(doc["thumb"]["key"]))


# ================================================================================================================== admin edits
def test_admin_edits_survive_a_republish(tmp_path):
    info = make_bundle(tmp_path / "b", 3, product_ids={0: "SB-PDF"})
    store, db = new_environment(tmp_path)
    publish(info, store, db, activate=True)
    a, b, c = info.item_ids
    db.patch_item(CAT, a, {"label": "Emperor Dark", "status": "hidden", "attributes": {"series": "SB", "weight": 2.5, "new": True}, "productId": "ADMIN-9"})
    db.patch_item(CAT, b, {"label": "Second"})
    for item_id in info.item_ids:                                                    # the compute changes its mind about every description
        profile = json.loads(sqlite3.connect(str(info.state_path)).execute("SELECT profile_json FROM captions WHERE item_id = ?", (item_id,)).fetchone()[0])
        profile.update(material_subtype=f"redescribed {item_id[-6:]}", material_category="metal", surface_finish="brushed")
        _sql(info, "UPDATE captions SET profile_json = ? WHERE item_id = ?", (json.dumps(profile), item_id))
    _sql(info, "UPDATE items SET product_id = 'SB-NEW' WHERE item_id = ?", (b,))
    again = publish(info, store, db, activate=True)
    docs = db.get_items(CAT)
    assert docs[a]["label"] == "Emperor Dark" and docs[a]["status"] == "hidden" and docs[a]["attributes"] == {"series": "SB", "weight": 2.5, "new": True}
    assert docs[a]["productId"] == "ADMIN-9" and docs[a]["productIdSource"] == "admin" and docs[a]["source"]["pdfProductId"] == "SB-PDF", "the PDF's own id is still recorded beside the admin's"
    assert docs[b]["label"] == "Second" and docs[b]["productId"] == "SB-NEW" and docs[b]["productIdSource"] == "pdf-text"
    assert all(docs[i]["category"] == "metal" and docs[i]["finish"] == "brushed" and docs[i]["subtype"].startswith("redescribed") for i in info.item_ids)
    assert again.n_changed == 3 and db.get_catalogue(CAT)["counts"] == {"items": 3, "hidden": 1}      # items is all of them, hidden is how many of those: the website shows items - hidden
    items = json.loads(store.get_bytes(f"releases/{CAT}/{again.release_id}/items.json"))
    assert {i["itemId"]: i["productId"] for i in items}[a] == "SB-PDF", "a release holds the PDF's id; the website applies admin ids"


def test_an_admin_edit_alone_does_not_make_a_new_release(tmp_path):
    info = make_bundle(tmp_path / "b", 3)
    store, db = new_environment(tmp_path)
    first = publish(info, store, db, activate=True)
    db.patch_item(CAT, info.item_ids[0], {"label": "Renamed", "productId": "ADMIN-1", "status": "hidden"})
    second = publish(info, store, db, activate=True)
    assert second.release_id == first.release_id and second.nothing_to_do and second.n_changed == 0


# ======================================================================================================= interrupted publishes
def _published_base(tmp_path, name):
    store, db = new_environment(tmp_path, store_name=name)
    first_info = make_bundle(tmp_path / f"base-{name}", 3, seed=1)
    first = publish(first_info, store, db, activate=True, source_files={first_info.pdf_sha256: first_info.pdf_path})
    return store, db, first


def test_a_failure_at_any_write_leaves_the_live_release_alone_and_a_retry_finishes(tmp_path):
    second_info = make_bundle(tmp_path / "two", 2, seed=2, first_page=10)
    sources = {second_info.pdf_sha256: second_info.pdf_path}
    clean_store, clean_db, clean_first = _published_base(tmp_path, "clean")
    counter = FlakyStore(clean_store, None)
    clean = publish(second_info, counter, clean_db, activate=True, source_files=sources)
    total_writes = counter.write_count
    assert total_writes >= 15, total_writes
    clean_fingerprint = read_release(clean_store, CAT, clean.release_id).manifest
    for fail_at in range(1, total_writes + 1):
        store, db, first = _published_base(tmp_path, f"w{fail_at}")
        flaky = FlakyStore(store, fail_at)
        with pytest.raises(InjectedFailure) as caught:
            publish(second_info, flaky, db, activate=True, source_files=sources)
        assert any("live release was not changed" in note for note in getattr(caught.value, "__notes__", [])), "the error carries a plain-words note"
        assert db.get_catalogue(CAT)["activeRelease"] == first.release_id, f"the pointer moved although write {fail_at} failed"
        assert len(db.list_releases(CAT)) == 1, "no release was registered"
        old = read_release(store, CAT, first.release_id)
        assert old.manifest["nItems"] == 3, "the live release still loads, whole"
        retry = publish(second_info, FlakyStore(store, None), db, activate=True, source_files=sources)
        assert retry.activated and retry.n_items == 5 and db.get_catalogue(CAT)["activeRelease"] == retry.release_id
        new = read_release(store, CAT, retry.release_id)
        assert new.manifest["itemsSha256"] == clean_fingerprint["itemsSha256"] and {n: e["sha256"] for n, e in new.manifest["pillars"].items()} == {
            n: e["sha256"] for n, e in clean_fingerprint["pillars"].items()}, "the retry produced the same release content as a clean run"
        assert len(db.get_items(CAT)) == 5


@pytest.mark.parametrize("failing_method, releases_after_retry", [("upsert_items", 2), ("insert_release", 2), ("set_active_release", 2)])
def test_a_failure_in_the_database_leaves_the_pointer_and_a_retry_reuses_what_exists(tmp_path, failing_method, releases_after_retry):
    store, db, first = _published_base(tmp_path, "db")
    second_info = make_bundle(tmp_path / "two", 2, seed=2, first_page=10)
    with pytest.raises(InjectedFailure):
        publish(second_info, store, FlakyDb(db, failing_method), activate=True)
    assert db.get_catalogue(CAT)["activeRelease"] == first.release_id
    registered = len(db.list_releases(CAT))
    assert registered == (2 if failing_method == "set_active_release" else 1)
    retry = publish(second_info, store, db, activate=True)
    assert retry.activated and len(db.list_releases(CAT)) == releases_after_retry and db.get_catalogue(CAT)["activeRelease"] == retry.release_id
    assert retry.release_reused == (failing_method == "set_active_release"), "a release that was registered before the failure is reused, not made twice"
    if failing_method == "set_active_release":
        assert retry.n_new == 0 and "reused" in " ".join(retry.report)
    assert read_release(store, CAT, retry.release_id).manifest["nItems"] == 5 and len(db.get_items(CAT)) == 5


def test_two_unactivated_attempts_do_not_pile_up_identical_releases(tmp_path):
    store, db, first = _published_base(tmp_path, "twice")
    second_info = make_bundle(tmp_path / "two", 2, seed=2, first_page=10)
    one = publish(second_info, store, db)
    two = publish(second_info, store, db)
    assert one.release_id == two.release_id and two.nothing_to_do and len(db.list_releases(CAT)) == 2


# ===================================================================================================== progress, size, real SDK
def test_progress_uses_the_job_stage_names_and_finishes(tmp_path):
    info = make_bundle(tmp_path / "b", 25)
    store, db = new_environment(tmp_path)
    events = []
    publish(info, store, db, activate=True, progress=lambda *args: events.append(args))
    assert events and all(len(e) == 4 and isinstance(e[0], str) and isinstance(e[1], int) and isinstance(e[2], int) and isinstance(e[3], str) for e in events)
    assert {e[0] for e in events} == {"publish", "release"} and events[0][0] == "publish" and events[-1] == ("release", 1, 1, "Done")
    stages = [e[0] for e in events]
    assert stages == sorted(stages, key=lambda s: s == "release"), "all publish events come before the release events"


def test_69_items_at_the_real_vector_sizes_publish_in_reasonable_time(tmp_path):
    info = make_bundle(tmp_path / "real", 69, legacy_kaggle_paths=True, crop_px=(120, 168))
    store, db = new_environment(tmp_path)
    started = time.time()
    result = publish(info, store, db, activate=True, source_files={info.pdf_sha256: info.pdf_path})
    first_seconds = time.time() - started
    started = time.time()
    again = publish(info, store, db, activate=True, source_files={info.pdf_sha256: info.pdf_path})
    assert result.n_items == 69 and result.activated and again.nothing_to_do and result.warnings == []
    assert first_seconds < 20 and time.time() - started < 10, (first_seconds, time.time() - started)
    assert read_release(store, CAT, result.release_id).manifest["pillars"]["dino"]["dim"] == 3072


def test_through_the_real_gcs_sdk_the_publish_uses_create_only_if_absent_and_a_republish_uploads_nothing(tmp_path, monkeypatch):
    monkeypatch.setenv(DISABLE_BUCKET_MD_ENV, "1")
    info = make_bundle(tmp_path / "b", 4, legacy_kaggle_paths=True)
    store, fake = make_gcs_store()
    from terucon_catalogue.mongo import MemoryCatalogueDb

    db = MemoryCatalogueDb()
    db.upsert_catalogue(CAT, name="x")
    result = publish(info, store, db, activate=True, source_files={info.pdf_sha256: info.pdf_path})
    uploads = [r for r in fake.requests_seen if r.path.startswith("/upload/")]
    conditional = {r.query.get("ifGenerationMatch") for r in uploads}
    assert conditional == {"0", None}, "release files and crops are create-only; the state snapshot is an overwrite"
    names = sorted(fake.objects)
    assert f"catalogue/crops/{CAT}/{info.item_ids[0]}.png" in names and f"catalogue/releases/{CAT}/{result.release_id}/manifest.json" in names
    assert fake.objects[f"catalogue/crops/{CAT}/{info.item_ids[0]}.png"] == info.crop_paths[info.item_ids[0]].read_bytes()
    assert len(uploads) == len(names) and sum(1 for r in uploads if r.query.get("ifGenerationMatch") is None) == 1       # exactly one overwrite: the checkpoint
    fake.clear_log()
    again = publish(info, store, db, activate=True, source_files={info.pdf_sha256: info.pdf_path})
    assert again.nothing_to_do and not [r for r in fake.requests_seen if r.path.startswith("/upload/") or r.method in ("DELETE",)], "nothing is uploaded the second time"
    assert not [r for r in fake.requests_seen if r.query.get("alt") == "media" and "crops" in r.path], "present crops are compared by the store's MD5, not downloaded"


# ================================================================================================================= activation
def test_activate_rolls_forward_and_back_and_refuses_what_it_should(tmp_path):
    first_info = make_bundle(tmp_path / "one", 2, seed=1)
    second_info = make_bundle(tmp_path / "two", 2, seed=2, first_page=10)
    store, db = new_environment(tmp_path)
    one = publish(first_info, store, db, activate=True)
    two = publish(second_info, store, db)
    assert db.get_catalogue(CAT)["activeRelease"] == one.release_id
    live = activate_release(CAT, two.release_id, store=store, db=db)
    assert live["activeRelease"] == two.release_id and live["previousRelease"] == one.release_id and live["counts"] == {"items": 4, "hidden": 0}
    back = activate_release(CAT, one.release_id, store=store, db=db)
    assert back["activeRelease"] == one.release_id and back["previousRelease"] == two.release_id and back["featureVersions"] == first_info.versions
    with pytest.raises(ActivationError, match="no release"):
        activate_release(CAT, "rel-20990101000000-ffffff", store=store, db=db)
    db.upsert_catalogue("other-cat", name="Other")
    with pytest.raises(ActivationError, match="belongs to the catalogue"):
        activate_release("other-cat", one.release_id, store=store, db=db)
    store.put_bytes(f"releases/{CAT}/{two.release_id}/manifest.json", b'{"schema": 1}')
    with pytest.raises(ActivationError):
        activate_release(CAT, two.release_id, store=store, db=db)
    assert db.get_catalogue(CAT)["activeRelease"] == one.release_id
    store.delete(f"releases/{CAT}/{one.release_id}/manifest.json")
    with pytest.raises(ActivationError, match="no manifest"):
        activate_release(CAT, one.release_id, store=store, db=db)
