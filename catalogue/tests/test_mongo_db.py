"""The MongoDB layer. The same behaviour suite runs on MemoryCatalogueDb (the test double) and on the real MongoCatalogueDb class over mongomock,
and a differential test checks the two agree. Real MongoDB semantics (index conflicts, $set/$setOnInsert path rules, the bulk write) are checked by
tests/test_live_contract.py, which needs a server the owner provides."""
import random
import subprocess
import sys
from pathlib import Path

import pytest

from factories import apply_mongomock_shims, catalogue_db_contract, make_item_doc, make_mongo_db
from terucon_catalogue import mongo
from terucon_catalogue.mongo import (ALL_ITEM_FIELDS, INSERT_ONLY, PRODUCT_FIELDS, PUBLISHER_OWNED, CatalogueDbError, DbConfigError, MemoryCatalogueDb,
                                     MongoCatalogueDb, check_no_path_conflict, db_from_env, item_write_plan, paths_conflict, publisher_view,
                                     redact_uri, uri_database_name)

ROOT = Path(__file__).resolve().parent.parent


@pytest.fixture(params=["memory", "mongo"])
def db(request, monkeypatch):
    if request.param == "memory":
        return MemoryCatalogueDb()
    return make_mongo_db(monkeypatch)


def test_behaviour_suite(db):
    catalogue_db_contract(db)


# ---------------------------------------------------------------------------------------------------------------------- the bulk write
def test_upsert_items_is_one_ordered_bulk_write_of_updates_that_cannot_clobber_admin_fields(monkeypatch):
    import mongomock.collection as mongomock_collection

    db = make_mongo_db(monkeypatch)
    calls = []
    original = mongomock_collection.Collection.bulk_write

    def spy(self, requests, ordered=True, **kwargs):
        calls.append((self.name, list(requests), ordered))
        return original(self, requests, ordered=ordered, **kwargs)

    monkeypatch.setattr(mongomock_collection.Collection, "bulk_write", spy)
    db.upsert_catalogue("cat-one", name="One")
    docs = [make_item_doc("cat-one", f"aaaaaaaaaaaa-p{page:04d}-i00", pdf_product_id="SB1") for page in range(1, 6)]
    db.upsert_items("cat-one", docs)
    assert len(calls) == 1, "one bulk_write for the whole batch"
    name, operations, ordered = calls[0]
    assert name == mongo.ITEMS and ordered is True and len(operations) == 10
    upsert_op, product_op = operations[0], operations[1]
    assert type(upsert_op).__name__ == "UpdateOne" and upsert_op._upsert is True and upsert_op._filter == {"_id": "cat-one|aaaaaaaaaaaa-p0001-i00"}
    assert set(upsert_op._doc) == {"$set", "$setOnInsert"}
    assert set(upsert_op._doc["$set"]) == set(PUBLISHER_OWNED)
    assert set(upsert_op._doc["$setOnInsert"]) == set(INSERT_ONLY) | set(PRODUCT_FIELDS)
    assert not paths_conflict(upsert_op._doc["$set"], upsert_op._doc["$setOnInsert"])
    for forbidden in ("label", "status", "attributes"):          # admin-owned fields are only ever written at insert
        assert forbidden not in upsert_op._doc["$set"]
    assert type(product_op).__name__ == "UpdateOne" and not product_op._upsert
    assert product_op._filter == {"_id": "cat-one|aaaaaaaaaaaa-p0001-i00", "productIdSource": {"$ne": "admin"}}
    assert product_op._doc == {"$set": {"productId": "SB1", "productIdSource": "pdf-text"}}


def test_the_update_paths_are_disjoint_and_prefix_free_for_real_documents():
    doc = make_item_doc("cat-one", "aaaaaaaaaaaa-p0001-i00", pdf_product_id="X")
    doc_id, set_fields, set_on_insert, product = item_write_plan("cat-one", doc)
    assert doc_id == "cat-one|aaaaaaaaaaaa-p0001-i00" and set(doc) == set(ALL_ITEM_FIELDS)
    assert paths_conflict(set_fields, set_on_insert) == []
    assert product == {"productId": "X", "productIdSource": "pdf-text"}
    assert set(PUBLISHER_OWNED).isdisjoint(INSERT_ONLY) and set(PRODUCT_FIELDS).isdisjoint(PUBLISHER_OWNED) and set(PRODUCT_FIELDS).isdisjoint(INSERT_ONLY)
    assert set(PUBLISHER_OWNED) | set(INSERT_ONLY) | set(PRODUCT_FIELDS) | {"_id"} == set(ALL_ITEM_FIELDS)


def test_the_conflict_checker_catches_what_a_real_mongodb_would_reject():
    assert paths_conflict(["a"], ["a"]) == [("a", "a")]
    assert paths_conflict(["a"], ["a.b"]) == [("a", "a.b")]
    assert paths_conflict(["a.b.c"], ["a.b"]) == [("a.b.c", "a.b")]
    assert paths_conflict(["ab"], ["a"]) == [] and paths_conflict(["a.b"], ["a.c"]) == []
    with pytest.raises(CatalogueDbError, match="same path"):
        check_no_path_conflict({"images": 1}, {"images.crop": 2})


def test_a_document_that_is_not_the_contract_is_refused_before_anything_is_written():
    good = make_item_doc("cat-one", "aaaaaaaaaaaa-p0001-i00")
    for mutate, message in ((lambda d: d.pop("source"), "missing fields"), (lambda d: d.update(title="x"), "not in the contract"),
                            (lambda d: d.update(_id="wrong|id"), "not '<catalogue>|<itemId>'"), (lambda d: d.update(productIdSource="guess"), "productIdSource")):
        broken = dict(good)
        mutate(broken)
        with pytest.raises(CatalogueDbError, match=message):
            item_write_plan("cat-one", broken)
    with pytest.raises(CatalogueDbError, match="belongs to catalogue"):
        item_write_plan("other-cat", good)


def test_publisher_view_ignores_updated_at_and_an_admin_product_id():
    first = make_item_doc("cat-one", "aaaaaaaaaaaa-p0001-i00", pdf_product_id="A", now=1)
    later = make_item_doc("cat-one", "aaaaaaaaaaaa-p0001-i00", pdf_product_id="A", now=999)
    assert publisher_view(first) == publisher_view(later)
    admin = dict(later, productId="Z", productIdSource="admin")
    assert "productId" not in publisher_view(admin) and publisher_view(first)["productId"] == "A"


# ------------------------------------------------------------------------------------------------------------ memory and mongomock agree
def test_memory_and_mongo_agree_on_a_random_sequence_of_publishes_and_admin_edits(monkeypatch):
    memory, real = MemoryCatalogueDb(), make_mongo_db(monkeypatch)
    rng = random.Random(7)
    ids = [f"aaaaaaaaaaaa-p{page:04d}-i00" for page in range(1, 9)]
    for database in (memory, real):
        database.upsert_catalogue("cat-one", name="One")
    for step in range(60):
        action = rng.choice(["publish", "publish", "admin", "admin"])
        if action == "publish":
            chosen = rng.sample(ids, rng.randint(1, len(ids)))
            docs = [make_item_doc("cat-one", item_id, now=step, release_id=f"rel-{step}", category=rng.choice(["stone", "metal", None]),
                                  pdf_product_id=rng.choice([None, "SB1", "SB2"]), subtype=f"s{step}") for item_id in chosen]
            assert memory.upsert_items("cat-one", docs) == real.upsert_items("cat-one", docs)
        else:
            item_id = rng.choice(ids)
            fields = rng.choice([{"label": f"L{step}"}, {"status": rng.choice(["ok", "hidden"])}, {"productId": rng.choice([None, "ADM"])}, {"attributes": {"k": step}}])
            assert memory.patch_item("cat-one", item_id, fields) == real.patch_item("cat-one", item_id, fields)
        assert memory.get_items("cat-one") == real.get_items("cat-one")
        assert memory.count_items("cat-one", "hidden") == real.count_items("cat-one", "hidden")


# ----------------------------------------------------------------------------------------------------------------------- indexes
def test_indexes_are_created_once_and_a_conflict_with_the_websites_index_is_a_warning_not_a_failure(monkeypatch):
    import mongomock
    from pymongo.errors import OperationFailure

    apply_mongomock_shims(monkeypatch)
    created = []
    client = mongomock.MongoClient()
    original = mongomock.collection.Collection.create_index

    def create_index(self, keys, **kwargs):
        created.append((self.name, kwargs.get("name")))
        if kwargs.get("name") == "catalogue_1_productId_1":
            raise OperationFailure("Index already exists with different options", code=85)
        return original(self, keys, **kwargs)

    monkeypatch.setattr(mongomock.collection.Collection, "create_index", create_index)
    database = MongoCatalogueDb("mongodb://localhost/terucon_test", client=client)
    database.upsert_catalogue("cat-one", name="One")
    database.upsert_catalogue("cat-one", name="Two")
    assert sorted(created) == sorted([(mongo.ITEMS, "catalogue_1_status_1"), (mongo.ITEMS, "catalogue_1_productId_1"), (mongo.JOBS, "status_1_createdAt_1"),
                                      (mongo.RELEASES, "catalogue_1_createdAt_1")]), "each index asked for once per object"
    assert len(database.index_warnings) == 1 and "catalogue_1_productId_1" in database.index_warnings[0] and "85" in database.index_warnings[0]

    monkeypatch.setattr(mongomock.collection.Collection, "create_index",
                        lambda self, keys, **kw: (_ for _ in ()).throw(OperationFailure("not authorized", code=13)))
    other = MongoCatalogueDb("mongodb://localhost/terucon_test", client=mongomock.MongoClient())
    with pytest.raises(OperationFailure):
        other.get_catalogue("x")


def test_the_partial_index_only_covers_string_product_ids(monkeypatch):
    database = make_mongo_db(monkeypatch)
    database.ensure_indexes()
    info = database.database[mongo.ITEMS].index_information()
    assert info["catalogue_1_productId_1"]["partialFilterExpression"] == {"productId": {"$type": "string"}}
    assert info["catalogue_1_status_1"]["key"] == [("catalogue", 1), ("status", 1)]


# --------------------------------------------------------------------------------------------------------------------- uri and env
@pytest.mark.parametrize("uri", [
    "mongodb+srv://alice:s3cr3t%40pw@cluster0.abc.mongodb.net/terucon?retryWrites=true&w=majority",
    "mongodb://alice:pa@ss:word@host1:27017,host2:27017/terucon",
    "mongodb://bob:topsecret@localhost/db?authSource=admin&tlsCertificateKeyFilePassword=hunter2",
    "mongodb://carol:x@host/?authMechanism=MONGODB-AWS&authMechanismProperties=AWS_SESSION_TOKEN:abcdef",
])
def test_redact_uri_hides_every_secret(uri):
    shown = redact_uri(uri)
    for secret in ("s3cr3t", "pw", "ss:word", "topsecret", "hunter2", "abcdef", "alice:", "bob:", "carol:", "pa@ss"):
        assert secret not in shown, (secret, shown)
    assert "***" in shown


def test_redact_uri_keeps_the_harmless_parts_and_handles_empty():
    assert redact_uri("mongodb://localhost:27017/terucon") == "mongodb://localhost:27017/terucon"
    assert redact_uri("mongodb+srv://u:p@c.example.net/terucon?retryWrites=true") == "mongodb+srv://***@c.example.net/terucon?retryWrites=true"
    assert redact_uri(None) == "" and redact_uri("") == ""


def test_uri_database_name():
    assert uri_database_name("mongodb://u:p@h1:1,h2:2/terucon?x=1") == "terucon"
    assert uri_database_name("mongodb+srv://c.example.net/terucon") == "terucon"
    assert uri_database_name("mongodb://localhost:27017") is None and uri_database_name("mongodb://localhost/") is None


def test_db_from_env(monkeypatch):
    database = db_from_env({"MONGODB_URI": "mongodb+srv://u:secretpw@c.example.net/terucon"})
    assert isinstance(database, MongoCatalogueDb) and database.db_name == "terucon" and database._client is None
    assert "secretpw" not in repr(database) and "secretpw" not in database.describe()
    assert db_from_env({"MONGODB_URI": "mongodb://localhost:27017", "MONGODB_DB": "other"}).db_name == "other"
    assert db_from_env({"MONGODB_URI": "mongodb://localhost/inuri", "MONGODB_DB": "explicit"}).db_name == "explicit"


def test_db_from_env_explains_what_is_missing_without_printing_the_uri():
    with pytest.raises(DbConfigError, match="MONGODB_URI"):
        db_from_env({})
    with pytest.raises(DbConfigError, match="MONGODB_DB"):
        db_from_env({"MONGODB_URI": "mongodb://user:secretpw@localhost:27017"})
    with pytest.raises(DbConfigError) as caught:
        db_from_env({"MONGODB_URI": "postgres://user:secretpw@host/db"})
    assert "secretpw" not in str(caught.value)


def test_importing_the_module_and_building_a_db_object_imports_no_pymongo():
    code = ("import sys\n"
            "from terucon_catalogue.mongo import MongoCatalogueDb, MemoryCatalogueDb, db_from_env\n"
            "db = db_from_env({'MONGODB_URI': 'mongodb://localhost/x'})\n"
            "print('LOADED', [m for m in sys.modules if m.startswith(('pymongo', 'bson'))])\n")
    result = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, cwd=ROOT)
    assert result.returncode == 0, result.stderr
    assert "LOADED []" in result.stdout, result.stdout


def test_the_lazily_created_client_is_a_pymongo_client_with_the_uri_and_timeout(monkeypatch):
    import mongomock

    seen = {}

    class RecordingClient(mongomock.MongoClient):
        def __init__(self, uri, **kwargs):
            seen.update(uri=uri, **kwargs)
            super().__init__()

    apply_mongomock_shims(monkeypatch)
    import pymongo

    monkeypatch.setattr(pymongo, "MongoClient", RecordingClient)
    database = MongoCatalogueDb("mongodb://localhost:27017/terucon_test")
    assert seen == {}, "nothing is connected at construction"
    assert database.get_catalogue("nobody") is None
    assert seen["uri"] == "mongodb://localhost:27017/terucon_test" and seen["serverSelectionTimeoutMS"] == 15000 and seen["appname"] == "terucon-catalogue"


def test_constructor_needs_a_database_name_and_a_uri_or_client():
    with pytest.raises(DbConfigError, match="no database"):
        MongoCatalogueDb("mongodb://localhost:27017")
    with pytest.raises(DbConfigError, match="MONGODB_URI"):
        MongoCatalogueDb(None, "terucon")
    assert MongoCatalogueDb("mongodb://localhost:27017", "terucon").db_name == "terucon"


def test_memory_db_counts_writes_so_a_dry_run_can_be_proved_to_write_nothing():
    database = MemoryCatalogueDb()
    assert database.writes == 0
    database.upsert_catalogue("cat-one", name="One")
    database.upsert_items("cat-one", [make_item_doc("cat-one", "aaaaaaaaaaaa-p0001-i00")])
    assert database.writes == 2
    before = database.snapshot()
    database.get_catalogue("cat-one")
    database.get_items("cat-one")
    database.list_releases("cat-one")
    database.count_items("cat-one")
    assert database.snapshot() == before and database.writes == 2


def test_memory_db_hands_out_copies():
    database = MemoryCatalogueDb()
    database.upsert_catalogue("cat-one", name="One")
    database.get_catalogue("cat-one")["name"] = "tampered"
    assert database.get_catalogue("cat-one")["name"] == "One"
