"""The catalogue's MongoDB documents (ARCHITECTURE.md 4.4): catalogues, items, releases, jobs.

* MongoCatalogueDb(uri, db_name=None, *, client=None)  pymongo. The client is created on first use (importing this module needs no pymongo).
* MemoryCatalogueDb()                                  the same methods in pure Python: the test double (also used by the search/ingest tests).
* db_from_env(environ)                                 MONGODB_URI (+ MONGODB_DB when the URI names no database). The URI is never printed: redact_uri().

Who owns which field of an item document (this is what makes a re-publish safe):
  publisher-owned, overwritten on every publish   source, images, subtype, category, finish, description, dominantHex, proportions,
                                                  captionModel, captionVersion, updatedAt
  written once, when the item is first inserted   catalogue, itemId, createdAt, releaseFirst, jobId  and the defaults  status "ok", label null,
                                                  attributes {}
  admin-owned, NEVER overwritten by a publish     label, status, attributes
  productId / productIdSource                     set from the PDF text layer on insert; overwritten by a later publish ONLY while productIdSource is
                                                  not "admin" (an id typed by an admin stays).
upsert_items does this with UpdateOne($set, $setOnInsert) in one ordered bulk_write, plus one conditional UpdateOne per item for the product id
(ReplaceOne cannot keep fields it does not know about). The paths of $set and $setOnInsert are disjoint, because a real MongoDB rejects an update that
names a path in both (mongomock does not): item_write_plan() builds both from one table and check_no_path_conflict() guards it.
"""
from __future__ import annotations

import copy
import logging
import re
import time
from typing import Any, Callable, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple
from urllib.parse import urlsplit

LOGGER = logging.getLogger("catalogue")

CATALOGUES = "terucon_catalogues"
ITEMS = "terucon_catalogue_items"
RELEASES = "terucon_catalogue_releases"
JOBS = "terucon_catalogue_jobs"

JOB_LOG_LIMIT = 200
CATALOGUE_KINDS = ("materials", "paint", "exterior", "other")
CATALOGUE_ID_PATTERN = re.compile(r"^[a-z0-9][a-z0-9-]{1,38}$")

PUBLISHER_OWNED = ("source", "images", "subtype", "category", "finish", "description", "dominantHex", "proportions", "captionModel", "captionVersion",
                   "updatedAt")
INSERT_ONLY = ("catalogue", "itemId", "status", "label", "attributes", "createdAt", "releaseFirst", "jobId")
PRODUCT_FIELDS = ("productId", "productIdSource")
ADMIN_OWNED = ("label", "status", "attributes")
ALL_ITEM_FIELDS = ("_id",) + PUBLISHER_OWNED + INSERT_ONLY + PRODUCT_FIELDS

# Index specs, named exactly as a driver names them by default, so the website's own createIndex calls (same keys) do not conflict.
INDEX_SPECS: Dict[str, List[dict]] = {
    ITEMS: [
        {"keys": [("catalogue", 1), ("status", 1)], "name": "catalogue_1_status_1"},
        {"keys": [("catalogue", 1), ("productId", 1)], "name": "catalogue_1_productId_1", "partialFilterExpression": {"productId": {"$type": "string"}}},
    ],
    JOBS: [{"keys": [("status", 1), ("createdAt", 1)], "name": "status_1_createdAt_1"}],
    RELEASES: [{"keys": [("catalogue", 1), ("createdAt", 1)], "name": "catalogue_1_createdAt_1"}],
}


class CatalogueDbError(RuntimeError):
    """A problem with the database or with what was asked of it (never contains the connection string)."""


class DbConfigError(CatalogueDbError):
    """MONGODB_URI is missing or does not say which database to use."""


class CatalogueNotFoundError(CatalogueDbError, LookupError):
    pass


class DuplicateKeyError(CatalogueDbError):
    pass


class ConcurrentUpdateError(CatalogueDbError):
    pass


def default_clock() -> int:
    return int(time.time() * 1000)


# ------------------------------------------------------------------------------------------------------------------------ URIs and ids
_USERINFO = re.compile(r"(?P<scheme>[A-Za-z][A-Za-z0-9+.\-]*://)(?P<userinfo>[^/?#]*)@")      # greedy: an unescaped "@" inside a password is covered too
_SECRET_PARAM = re.compile(r"(?i)(^|[?&;,])([^=&;,]*(?:pass|pwd|secret|token|key|credential|authMechanismProperties)[^=&;,]*)=([^&;]*)")


def redact_uri(uri: Optional[str]) -> str:
    """The connection string with the user, the password and any secret-looking option replaced by '***'. Safe to print."""
    if not uri:
        return ""
    text = _USERINFO.sub(lambda m: f"{m.group('scheme')}***@", str(uri))
    return _SECRET_PARAM.sub(lambda m: f"{m.group(1)}{m.group(2)}=***", text)


def uri_database_name(uri: str) -> Optional[str]:
    """The database named in a mongodb:// or mongodb+srv:// URI path, without any lookup (an SRV URI is not resolved here)."""
    try:
        path = urlsplit(uri).path.lstrip("/")
    except ValueError:
        return None
    return path.split("/", 1)[0] or None


def check_catalogue_id(catalogue_id: str) -> str:
    if not isinstance(catalogue_id, str) or not CATALOGUE_ID_PATTERN.match(catalogue_id):
        raise CatalogueDbError(f"{catalogue_id!r} is not a valid catalogue id: use 2 to 39 characters, lower-case letters, digits and '-', starting with a letter or digit.")
    return catalogue_id


def item_doc_id(catalogue_id: str, item_id: str) -> str:
    return f"{catalogue_id}|{item_id}"


# ------------------------------------------------------------------------------------------------------------------- item write planning
def paths_conflict(first: Iterable[str], second: Iterable[str]) -> List[Tuple[str, str]]:
    """Pairs of update paths that MongoDB would reject as a conflict: equal, or one inside the other ("a" and "a.b")."""
    clashes = []
    for a in first:
        for b in second:
            if a == b or a.startswith(b + ".") or b.startswith(a + "."):
                clashes.append((a, b))
    return clashes


def check_no_path_conflict(set_fields: Mapping[str, Any], set_on_insert: Mapping[str, Any]) -> None:
    clashes = paths_conflict(set_fields, set_on_insert)
    if clashes:
        raise CatalogueDbError(f"an update may not name the same path in $set and $setOnInsert: {clashes}")


def item_write_plan(catalogue_id: str, doc: Mapping[str, Any]) -> Tuple[str, Dict[str, Any], Dict[str, Any], Dict[str, Any]]:
    """Split a full item document into (_id, $set fields, $setOnInsert fields, product-id fields). Refuses a document that is not whole."""
    unknown = sorted(set(doc) - set(ALL_ITEM_FIELDS))
    if unknown:
        raise CatalogueDbError(f"item document has fields that are not in the contract: {unknown}")
    missing = sorted(name for name in ALL_ITEM_FIELDS if name not in doc)
    if missing:
        raise CatalogueDbError(f"item document is missing fields: {missing}")
    if doc["catalogue"] != catalogue_id:
        raise CatalogueDbError(f"item {doc.get('itemId')!r} belongs to catalogue {doc['catalogue']!r}, not {catalogue_id!r}.")
    if doc["_id"] != item_doc_id(catalogue_id, doc["itemId"]):
        raise CatalogueDbError(f"item _id {doc['_id']!r} is not '<catalogue>|<itemId>' ({item_doc_id(catalogue_id, doc['itemId'])!r}).")
    if doc["productIdSource"] not in (None, "pdf-text", "admin"):
        raise CatalogueDbError(f"productIdSource must be null, 'pdf-text' or 'admin', got {doc['productIdSource']!r}.")
    set_fields = {name: copy.deepcopy(doc[name]) for name in PUBLISHER_OWNED}
    set_on_insert = {name: copy.deepcopy(doc[name]) for name in INSERT_ONLY}
    product = {name: doc[name] for name in PRODUCT_FIELDS}
    set_on_insert.update(product)
    check_no_path_conflict(set_fields, set_on_insert)
    return doc["_id"], set_fields, set_on_insert, product


def publisher_view(doc: Mapping[str, Any], *, with_product: Optional[bool] = None) -> Dict[str, Any]:
    """The part of an item document a publish would write (updatedAt left out): what two publishes are compared on. The product id counts
    unless an admin owns it; pass with_product to decide that from the OLD document when comparing an old and a new one."""
    view = {name: doc.get(name) for name in PUBLISHER_OWNED if name != "updatedAt"}
    if with_product is None:
        with_product = doc.get("productIdSource") != "admin"
    if with_product:
        view.update({name: doc.get(name) for name in PRODUCT_FIELDS})
    return view


# --------------------------------------------------------------------------------------------------------------------- shared helpers
def _check_catalogue_fields(name: Optional[str], kind: Optional[str], note: Optional[str]) -> None:
    if name is not None and (not isinstance(name, str) or not name.strip() or len(name) > 120):
        raise CatalogueDbError("a catalogue name must be 1 to 120 characters.")
    if kind is not None and kind not in CATALOGUE_KINDS:
        raise CatalogueDbError(f"a catalogue kind must be one of {list(CATALOGUE_KINDS)}, got {kind!r}.")
    if note is not None and (not isinstance(note, str) or len(note) > 1000):
        raise CatalogueDbError("a catalogue note must be text of at most 1000 characters.")


def _new_catalogue_doc(catalogue_id: str, name: Optional[str], kind: Optional[str], note: Optional[str], now: int) -> Dict[str, Any]:
    if not name:
        raise CatalogueDbError(f"catalogue {catalogue_id!r} does not exist; give it a name to create it.")
    return {"_id": catalogue_id, "name": name.strip(), "kind": kind or "materials", "note": note, "createdAt": now, "updatedAt": now,
            "activeRelease": None, "previousRelease": None, "featureVersions": None, "counts": {"items": 0, "hidden": 0}}


_RELEASE_REQUIRED = ("_id", "catalogue", "createdAt", "createdBy", "jobId", "parent", "nItems", "featureVersions", "pillars", "gcsPrefix", "manifestSha256")
_ADMIN_PATCHABLE = ("label", "status", "attributes", "productId")


def _check_release_doc(doc: Mapping[str, Any]) -> None:
    missing = [name for name in _RELEASE_REQUIRED if name not in doc]
    if missing:
        raise CatalogueDbError(f"release document is missing fields: {missing}")
    if doc["createdBy"] not in ("ingest", "cli", "import"):
        raise CatalogueDbError(f"createdBy must be 'ingest', 'cli' or 'import', got {doc['createdBy']!r}.")


def _check_patch(fields: Mapping[str, Any]) -> Dict[str, Any]:
    unknown = sorted(set(fields) - set(_ADMIN_PATCHABLE))
    if unknown:
        raise CatalogueDbError(f"an admin may change {list(_ADMIN_PATCHABLE)}, not {unknown}.")
    if "status" in fields and fields["status"] not in ("ok", "hidden"):
        raise CatalogueDbError("status must be 'ok' or 'hidden'.")
    if "label" in fields and fields["label"] is not None and not isinstance(fields["label"], str):
        raise CatalogueDbError("label must be text or null.")
    if "attributes" in fields and not isinstance(fields["attributes"], dict):
        raise CatalogueDbError("attributes must be an object.")
    update = dict(fields)
    if "productId" in update:
        update["productIdSource"] = "admin" if update["productId"] else None
    return update


# ----------------------------------------------------------------------------------------------------------------------------- MongoDB
class MongoCatalogueDb:
    """The documents in a real MongoDB. Pass client= to supply an already-built (or fake) client; otherwise one is created on first use."""

    def __init__(self, uri: Optional[str], db_name: Optional[str] = None, *, client: Any = None, clock: Callable[[], int] = default_clock,
                 server_selection_timeout_ms: int = 15000):
        self._uri = uri
        self._client = client
        self._clock = clock
        self._timeout_ms = server_selection_timeout_ms
        self.db_name = db_name or (uri_database_name(uri) if uri else None)
        if not self.db_name:
            raise DbConfigError("The MongoDB connection string names no database. Add one to the URI (mongodb://host/<database>) or set MONGODB_DB.")
        if self._client is None and not uri:
            raise DbConfigError("No MongoDB connection string. Set MONGODB_URI.")
        self._indexes_done = False
        self.index_warnings: List[str] = []

    def __repr__(self) -> str:
        return f"MongoCatalogueDb(uri={redact_uri(self._uri)!r}, db={self.db_name!r})"

    def describe(self) -> str:
        return f"the MongoDB database {self.db_name!r}"

    # -- plumbing
    @property
    def client(self):
        if self._client is None:
            from pymongo import MongoClient            # lazy: importing this module needs no pymongo

            self._client = MongoClient(self._uri, serverSelectionTimeoutMS=self._timeout_ms, appname="terucon-catalogue")
        return self._client

    @property
    def database(self):
        return self.client[self.db_name]

    def _collection(self, name: str):
        self.ensure_indexes()
        return self.database[name]

    def ensure_indexes(self) -> None:
        """Create the indexes of ARCHITECTURE.md 4.4 once per object. An index the website already made with other options is reported, not fatal."""
        if self._indexes_done:
            return
        self._indexes_done = True       # set first: _collection() is called from here
        from pymongo.errors import OperationFailure

        for collection_name, specs in INDEX_SPECS.items():
            for spec in specs:
                options = {key: value for key, value in spec.items() if key != "keys"}
                try:
                    self.database[collection_name].create_index(spec["keys"], **options)
                except OperationFailure as error:
                    if getattr(error, "code", None) in (85, 86):      # IndexOptionsConflict / IndexKeySpecsConflict
                        message = (f"The index {spec['name']!r} on {collection_name} already exists with other options (MongoDB code {error.code}); "
                                   "left as it is.")
                        self.index_warnings.append(message)
                        LOGGER.warning(message)
                    else:
                        self._indexes_done = False
                        raise

    def index_names(self, collection_name: str) -> List[str]:
        self.ensure_indexes()
        return sorted(self.database[collection_name].index_information())

    # -- catalogues
    def get_catalogue(self, catalogue_id: str) -> Optional[dict]:
        return self._collection(CATALOGUES).find_one({"_id": catalogue_id})

    def list_catalogues(self) -> List[dict]:
        return list(self._collection(CATALOGUES).find({}).sort("_id", 1))

    def upsert_catalogue(self, catalogue_id: str, *, name: Optional[str] = None, kind: Optional[str] = None, note: Optional[str] = None) -> dict:
        check_catalogue_id(catalogue_id)
        _check_catalogue_fields(name, kind, note)
        collection = self._collection(CATALOGUES)
        now = self._clock()
        existing = collection.find_one({"_id": catalogue_id})
        if existing is None:
            document = _new_catalogue_doc(catalogue_id, name, kind, note, now)
            from pymongo.errors import DuplicateKeyError as _Duplicate

            try:
                collection.insert_one(document)
            except _Duplicate:
                raise DuplicateKeyError(f"catalogue {catalogue_id!r} was created by someone else a moment ago.") from None
            return document
        changes = {key: value for key, value in (("name", name.strip() if name else None), ("kind", kind), ("note", note)) if value is not None}
        if changes:
            changes["updatedAt"] = now
            collection.update_one({"_id": catalogue_id}, {"$set": changes})
        return collection.find_one({"_id": catalogue_id})

    def set_active_release(self, catalogue_id: str, release_id: Optional[str], *, feature_versions: Optional[Mapping[str, str]] = None,
                           counts: Optional[Mapping[str, int]] = None) -> dict:
        """Point the catalogue at a release (None switches it off). The old pointer becomes previousRelease. A compare-and-set on the old pointer
        means two people activating at once cannot lose the 'previous' record."""
        collection = self._collection(CATALOGUES)
        for _attempt in range(5):
            current = collection.find_one({"_id": catalogue_id})
            if current is None:
                raise CatalogueNotFoundError(f"catalogue {catalogue_id!r} does not exist.")
            previous = current.get("activeRelease")
            update: Dict[str, Any] = {"activeRelease": release_id, "updatedAt": self._clock()}
            if previous != release_id:
                update["previousRelease"] = previous
            if feature_versions is not None:
                update["featureVersions"] = dict(feature_versions)
            if counts is not None:
                update["counts"] = dict(counts)
            result = collection.update_one({"_id": catalogue_id, "activeRelease": previous}, {"$set": update})
            if result.matched_count == 1:
                return collection.find_one({"_id": catalogue_id})
        raise ConcurrentUpdateError(f"catalogue {catalogue_id!r} kept changing while it was being activated; try again.")

    # -- items
    def upsert_items(self, catalogue_id: str, items: Sequence[Mapping[str, Any]]) -> Dict[str, int]:
        """Insert new items and refresh the publisher-owned fields of existing ones, in one ordered bulk_write. Admin edits survive."""
        from pymongo import UpdateOne

        operations = []
        for document in items:
            doc_id, set_fields, set_on_insert, product = item_write_plan(catalogue_id, document)
            operations.append(UpdateOne({"_id": doc_id}, {"$set": set_fields, "$setOnInsert": set_on_insert}, upsert=True))
            operations.append(UpdateOne({"_id": doc_id, "productIdSource": {"$ne": "admin"}}, {"$set": dict(product)}))
        if not operations:
            return {"inserted": 0, "updated": 0}
        result = self._collection(ITEMS).bulk_write(operations, ordered=True)
        inserted = int(result.upserted_count)
        return {"inserted": inserted, "updated": len(items) - inserted}

    def get_items(self, catalogue_id: str, item_ids: Optional[Sequence[str]] = None) -> Dict[str, dict]:
        """{itemId: document}. With item_ids only those (in batches); without, every item of the catalogue."""
        collection = self._collection(ITEMS)
        found: Dict[str, dict] = {}
        if item_ids is None:
            for document in collection.find({"catalogue": catalogue_id}):
                found[document["itemId"]] = document
            return found
        ids = list(item_ids)
        for start in range(0, len(ids), 500):
            batch = [item_doc_id(catalogue_id, item_id) for item_id in ids[start:start + 500]]
            for document in collection.find({"_id": {"$in": batch}}):
                found[document["itemId"]] = document
        return found

    def count_items(self, catalogue_id: str, status: Optional[str] = None) -> int:
        query: Dict[str, Any] = {"catalogue": catalogue_id}
        if status is not None:
            query["status"] = status
        return int(self._collection(ITEMS).count_documents(query))

    def patch_item(self, catalogue_id: str, item_id: str, fields: Mapping[str, Any]) -> bool:
        """What the website's admin does (label, status, attributes, productId -> productIdSource 'admin'). Here so tests and the live contract can edit."""
        result = self._collection(ITEMS).update_one({"_id": item_doc_id(catalogue_id, item_id)}, {"$set": _check_patch(fields)})
        return result.matched_count == 1

    # -- releases
    def insert_release(self, document: Mapping[str, Any]) -> None:
        _check_release_doc(document)
        from pymongo.errors import DuplicateKeyError as _Duplicate

        try:
            self._collection(RELEASES).insert_one(copy.deepcopy(dict(document)))
        except _Duplicate:
            raise DuplicateKeyError(f"release {document['_id']!r} already exists.") from None

    def get_release(self, release_id: str) -> Optional[dict]:
        return self._collection(RELEASES).find_one({"_id": release_id})

    def list_releases(self, catalogue_id: str, limit: int = 50) -> List[dict]:
        """Newest first."""
        return list(self._collection(RELEASES).find({"catalogue": catalogue_id}).sort([("createdAt", -1), ("_id", -1)]).limit(int(limit)))

    # -- jobs
    def insert_job(self, document: Mapping[str, Any]) -> None:
        from pymongo.errors import DuplicateKeyError as _Duplicate

        try:
            self._collection(JOBS).insert_one(copy.deepcopy(dict(document)))
        except _Duplicate:
            raise DuplicateKeyError(f"job {document.get('_id')!r} already exists.") from None

    def get_job(self, job_id: str) -> Optional[dict]:
        return self._collection(JOBS).find_one({"_id": job_id})

    def list_jobs(self, limit: int = 20) -> List[dict]:
        return list(self._collection(JOBS).find({}).sort([("createdAt", -1), ("_id", -1)]).limit(int(limit)))

    def update_job(self, job_id: str, fields: Mapping[str, Any]) -> bool:
        """$set the fields (dotted paths such as 'progress.done' work). False if there is no such job."""
        if not fields:
            return self.get_job(job_id) is not None
        result = self._collection(JOBS).update_one({"_id": job_id}, {"$set": dict(fields)})
        return result.matched_count == 1

    def append_job_log(self, job_id: str, level: str, msg: str, *, t: Optional[int] = None) -> bool:
        """Add a log line (newest last). Only the newest 200 are kept."""
        if level not in ("info", "warn", "error"):
            raise CatalogueDbError("log level must be 'info', 'warn' or 'error'.")
        entry = {"t": self._clock() if t is None else int(t), "level": level, "msg": str(msg)[:2000]}
        result = self._collection(JOBS).update_one({"_id": job_id}, {"$push": {"log": {"$each": [entry], "$slice": -JOB_LOG_LIMIT}}})
        return result.matched_count == 1


# ------------------------------------------------------------------------------------------------------------------------------ memory
class MemoryCatalogueDb:
    """Same methods, same rules, no server. Documents are copied in and out, as a real database would."""

    def __init__(self, *, clock: Callable[[], int] = default_clock):
        self._clock = clock
        self.catalogues: Dict[str, dict] = {}
        self.items: Dict[str, dict] = {}
        self.releases: Dict[str, dict] = {}
        self.jobs: Dict[str, dict] = {}
        self.indexes: Dict[str, List[dict]] = {}
        self.index_warnings: List[str] = []
        self.writes = 0            # incremented by every method that changes something: lets a test prove a dry run wrote nothing

    def __repr__(self) -> str:
        return "MemoryCatalogueDb()"

    def describe(self) -> str:
        return "an in-memory database"

    def ensure_indexes(self) -> None:
        if not self.indexes:
            self.indexes = {name: copy.deepcopy(specs) for name, specs in INDEX_SPECS.items()}

    def index_names(self, collection_name: str) -> List[str]:
        self.ensure_indexes()
        return sorted(["_id_"] + [spec["name"] for spec in self.indexes.get(collection_name, [])])

    def snapshot(self) -> dict:
        """Everything, deep-copied: compare two snapshots to see that nothing changed."""
        return copy.deepcopy({"catalogues": self.catalogues, "items": self.items, "releases": self.releases, "jobs": self.jobs})

    # -- catalogues
    def get_catalogue(self, catalogue_id: str) -> Optional[dict]:
        return copy.deepcopy(self.catalogues.get(catalogue_id))

    def list_catalogues(self) -> List[dict]:
        return [copy.deepcopy(self.catalogues[key]) for key in sorted(self.catalogues)]

    def upsert_catalogue(self, catalogue_id: str, *, name: Optional[str] = None, kind: Optional[str] = None, note: Optional[str] = None) -> dict:
        check_catalogue_id(catalogue_id)
        _check_catalogue_fields(name, kind, note)
        now = self._clock()
        existing = self.catalogues.get(catalogue_id)
        if existing is None:
            self.catalogues[catalogue_id] = _new_catalogue_doc(catalogue_id, name, kind, note, now)
            self.writes += 1
        else:
            changes = {key: value for key, value in (("name", name.strip() if name else None), ("kind", kind), ("note", note)) if value is not None}
            if changes:
                existing.update(changes)
                existing["updatedAt"] = now
                self.writes += 1
        return copy.deepcopy(self.catalogues[catalogue_id])

    def set_active_release(self, catalogue_id: str, release_id: Optional[str], *, feature_versions: Optional[Mapping[str, str]] = None,
                           counts: Optional[Mapping[str, int]] = None) -> dict:
        current = self.catalogues.get(catalogue_id)
        if current is None:
            raise CatalogueNotFoundError(f"catalogue {catalogue_id!r} does not exist.")
        previous = current.get("activeRelease")
        current["activeRelease"] = release_id
        if previous != release_id:
            current["previousRelease"] = previous
        if feature_versions is not None:
            current["featureVersions"] = dict(feature_versions)
        if counts is not None:
            current["counts"] = dict(counts)
        current["updatedAt"] = self._clock()
        self.writes += 1
        return copy.deepcopy(current)

    # -- items
    def upsert_items(self, catalogue_id: str, items: Sequence[Mapping[str, Any]]) -> Dict[str, int]:
        plans = [item_write_plan(catalogue_id, document) for document in items]       # all documents are checked before any is written
        inserted = 0
        for doc_id, set_fields, set_on_insert, product in plans:
            existing = self.items.get(doc_id)
            if existing is None:
                self.items[doc_id] = {"_id": doc_id, **copy.deepcopy(set_on_insert), **copy.deepcopy(set_fields)}
                inserted += 1
            else:
                existing.update(copy.deepcopy(set_fields))
                if existing.get("productIdSource") != "admin":
                    existing.update(product)
            self.writes += 1
        return {"inserted": inserted, "updated": len(plans) - inserted}

    def get_items(self, catalogue_id: str, item_ids: Optional[Sequence[str]] = None) -> Dict[str, dict]:
        if item_ids is None:
            return {doc["itemId"]: copy.deepcopy(doc) for doc in self.items.values() if doc["catalogue"] == catalogue_id}
        found = {}
        for item_id in item_ids:
            document = self.items.get(item_doc_id(catalogue_id, item_id))
            if document is not None:
                found[item_id] = copy.deepcopy(document)
        return found

    def count_items(self, catalogue_id: str, status: Optional[str] = None) -> int:
        return sum(1 for doc in self.items.values() if doc["catalogue"] == catalogue_id and (status is None or doc.get("status") == status))

    def patch_item(self, catalogue_id: str, item_id: str, fields: Mapping[str, Any]) -> bool:
        document = self.items.get(item_doc_id(catalogue_id, item_id))
        update = _check_patch(fields)
        if document is None:
            return False
        document.update(copy.deepcopy(update))
        self.writes += 1
        return True

    # -- releases
    def insert_release(self, document: Mapping[str, Any]) -> None:
        _check_release_doc(document)
        if document["_id"] in self.releases:
            raise DuplicateKeyError(f"release {document['_id']!r} already exists.")
        self.releases[document["_id"]] = copy.deepcopy(dict(document))
        self.writes += 1

    def get_release(self, release_id: str) -> Optional[dict]:
        return copy.deepcopy(self.releases.get(release_id))

    def list_releases(self, catalogue_id: str, limit: int = 50) -> List[dict]:
        mine = [doc for doc in self.releases.values() if doc["catalogue"] == catalogue_id]
        mine.sort(key=lambda doc: (doc["createdAt"], doc["_id"]), reverse=True)
        return [copy.deepcopy(doc) for doc in mine[:int(limit)]]

    # -- jobs
    def insert_job(self, document: Mapping[str, Any]) -> None:
        if document.get("_id") in self.jobs:
            raise DuplicateKeyError(f"job {document.get('_id')!r} already exists.")
        self.jobs[document["_id"]] = copy.deepcopy(dict(document))
        self.writes += 1

    def get_job(self, job_id: str) -> Optional[dict]:
        return copy.deepcopy(self.jobs.get(job_id))

    def list_jobs(self, limit: int = 20) -> List[dict]:
        ordered = sorted(self.jobs.values(), key=lambda doc: (doc.get("createdAt", 0), doc["_id"]), reverse=True)
        return [copy.deepcopy(doc) for doc in ordered[:int(limit)]]

    def update_job(self, job_id: str, fields: Mapping[str, Any]) -> bool:
        document = self.jobs.get(job_id)
        if document is None:
            return False
        for path, value in fields.items():
            target = document
            parts = path.split(".")
            for part in parts[:-1]:
                if not isinstance(target.get(part), dict):
                    target[part] = {}
                target = target[part]
            target[parts[-1]] = copy.deepcopy(value)
        if fields:
            self.writes += 1
        return True

    def append_job_log(self, job_id: str, level: str, msg: str, *, t: Optional[int] = None) -> bool:
        if level not in ("info", "warn", "error"):
            raise CatalogueDbError("log level must be 'info', 'warn' or 'error'.")
        document = self.jobs.get(job_id)
        if document is None:
            return False
        log = document.setdefault("log", [])
        log.append({"t": self._clock() if t is None else int(t), "level": level, "msg": str(msg)[:2000]})
        del log[:-JOB_LOG_LIMIT]
        self.writes += 1
        return True


# --------------------------------------------------------------------------------------------------------------------------- from env
def db_from_env(environ: Optional[Mapping[str, str]] = None) -> MongoCatalogueDb:
    """MONGODB_URI, plus MONGODB_DB when the URI does not name a database. Nothing is connected until the first query."""
    import os

    environ = os.environ if environ is None else environ
    uri = (environ.get("MONGODB_URI") or "").strip()
    if not uri:
        raise DbConfigError("No MongoDB connection string. Set MONGODB_URI (for example mongodb+srv://user:password@cluster.example.net/terucon).")
    if not uri.startswith(("mongodb://", "mongodb+srv://")):
        raise DbConfigError(f"MONGODB_URI must start with mongodb:// or mongodb+srv:// (got {redact_uri(uri)[:40]!r}).")
    db_name = (environ.get("MONGODB_DB") or "").strip() or None
    return MongoCatalogueDb(uri, db_name)
