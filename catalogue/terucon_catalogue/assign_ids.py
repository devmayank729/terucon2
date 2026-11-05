"""Give every item of a catalogue the product id and the name printed in its PDF, without touching a vector, a picture or an item id.

    plan = plan_assignment(table, catalogue=..., store=..., db=...)       # reads only
    apply_assignment(plan, store=..., db=..., backup_path=...)            # writes: see below
    restore_assignment(backup_path, store=..., db=...)                    # puts the old values and the old live release back

Why this exists. The real catalogue PDF has no text layer, so the importer found no product code for any of its pages (every item had
`productId: null`) although every page prints its code and name under the swatch. A person read those off the pages once (the table is a JSON
file, `catalogue/data/<catalogue>-ids.json`, see `load_id_table`); this module puts them where everything reads them.

What it changes, and what it leaves alone (the reasons are in ARCHITECTURE.md 3 and 4):
* the item's `itemId`, the pictures' keys and the vectors' row ids are NOT touched. They are the join between the pictures, the vectors and the
  database, a release is sha-verified and immutable, and renaming them would rewrite live data for no gain. The product id is the public id;
  `itemId` stays the internal row key.
* MongoDB, per item: `productId` (prefix + printed code, `productIdSource: "admin"` so a later publish never overwrites it), `label` (the printed
  name, in title case), `attributes` (code, printed name, PDF page, the other pages that print the same code), and `status: "hidden"` for a page
  the table says is not a material (the cover).
* A NEW release is written beside the live one: the same vectors byte for byte (checked against the manifest's sha256s) and an `items.json`
  carrying the product ids, because the search service de-duplicates on the release's `productId` (two pages that print the same code are one
  product, and are shown once). It becomes the live release last; the old one stays, so `restore_assignment` (or `activate`) is a pointer flip.
* One printed code on two pages is ONE product id on two items (two photos of one design); no suffix is invented.

Everything is checked before the first write: a page the table does not know, an item without a page, a repeated release id, vectors that would
not come out byte-identical. `dry_run` (the default of the command line) writes nothing.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, List, Mapping, Optional, Sequence

from . import __version__
from . import publish as publish_module
from .mongo import check_catalogue_id
from .release_writer import BuiltRelease, ReleaseData, ReleaseReadError, canonical_json, npy_bytes, read_release, release_prefix, sha256_hex, write_release

_CODE = re.compile(r"^[A-Z]{2,4}\d{2,5}$")
_PREFIX = re.compile(r"^[A-Z]{2,8}-$")
MAX_PRODUCT_ID = 40            # the website shows at most 40 characters of it (server/catalogue/service.js)
BACKUP_VERSION = 1


class AssignError(RuntimeError):
    """Something is wrong with the table or the catalogue; the message says what, and nothing has been written."""

    def __init__(self, message: str, problems: Optional[Sequence[str]] = None):
        super().__init__(message)
        self.problems = list(problems or [])


# ---------------------------------------------------------------------------------------------------------------------------------- table
@dataclass(frozen=True)
class PageEntry:
    page: int
    code: Optional[str]            # the printed code, as printed (None: this page is not a product)
    printed_name: Optional[str]    # the printed name, exactly as printed
    hide: bool = False
    note: Optional[str] = None


@dataclass(frozen=True)
class IdTable:
    catalogue: str
    prefix: str
    pages: Dict[int, PageEntry]
    pdf_sha256: Optional[str] = None

    def product_id(self, page: int) -> Optional[str]:
        entry = self.pages[page]
        return f"{self.prefix}{entry.code}" if entry.code else None

    def pages_of(self, code: str) -> List[int]:
        return sorted(page for page, entry in self.pages.items() if entry.code == code)


def display_name(printed: str) -> str:
    """'EMPERADOR DARK' -> 'Emperador Dark'. Words of one or two letters stay as printed (TX). Spelling is never corrected."""
    return " ".join(word if len(word) <= 2 else word.capitalize() for word in printed.split())


def load_id_table(path) -> IdTable:
    """Read and check the JSON table. Every problem is listed at once."""
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise AssignError(f"The id table {str(path)!r} cannot be read ({type(error).__name__}).") from None
    problems: List[str] = []
    catalogue = data.get("catalogue") if isinstance(data, dict) else None
    prefix = data.get("prefix") if isinstance(data, dict) else None
    try:
        check_catalogue_id(catalogue)
    except Exception:
        problems.append("'catalogue' must be a catalogue id such as superbond-colour.")
    if not isinstance(prefix, str) or not _PREFIX.match(prefix):
        problems.append("'prefix' must be capital letters followed by '-', for example TIPL-.")
    raw_pages = data.get("pages") if isinstance(data, dict) else None
    pages: Dict[int, PageEntry] = {}
    if not isinstance(raw_pages, dict) or not raw_pages:
        problems.append("'pages' must be an object with one entry per PDF page.")
        raw_pages = {}
    for key, entry in raw_pages.items():
        if not re.fullmatch(r"[1-9]\d{0,4}", str(key)) or not isinstance(entry, dict):
            problems.append(f"page {key!r}: the key must be a page number and the value an object.")
            continue
        code, name, hide = entry.get("code"), entry.get("printedName"), bool(entry.get("hide"))
        if code is not None and (not isinstance(code, str) or not _CODE.match(code)):
            problems.append(f"page {key}: the code {code!r} must be capital letters then digits (for example SB804).")
            continue
        if code is not None and (not isinstance(name, str) or not name.strip()):
            problems.append(f"page {key}: a page with a code needs its printed name.")
            continue
        if code is None and not hide:
            problems.append(f"page {key}: a page without a code must say \"hide\": true (it is not a product).")
            continue
        if isinstance(prefix, str) and code is not None and len(prefix) + len(code) > MAX_PRODUCT_ID:
            problems.append(f"page {key}: {prefix}{code} is longer than {MAX_PRODUCT_ID} characters.")
            continue
        pages[int(key)] = PageEntry(int(key), code, " ".join(name.split()) if isinstance(name, str) else None, hide, entry.get("note"))
    names: Dict[str, set] = {}
    for entry in pages.values():
        if entry.code:
            names.setdefault(entry.code, set()).add(entry.printed_name)
    for code, printed in sorted(names.items()):
        if len(printed) > 1:
            problems.append(f"the code {code} is printed with different names on different pages ({sorted(printed)}): that is a mistake in the table or a real conflict in the PDF.")
    if problems:
        raise AssignError(f"The id table {str(path)!r} has {len(problems)} problem(s).", problems)
    return IdTable(catalogue, prefix, pages, (data.get("pdf") or {}).get("sha256"))


# ---------------------------------------------------------------------------------------------------------------------------------- plan
@dataclass
class ItemChange:
    item_id: str
    page: int
    product_id: Optional[str]
    label: Optional[str]
    status: str
    attributes: Dict[str, Any]
    before: Dict[str, Any]          # what to put back: productId, productIdSource, label, status, attributes

    @property
    def patch(self) -> Dict[str, Any]:
        return {"productId": self.product_id, "label": self.label, "status": self.status, "attributes": self.attributes}


@dataclass
class AssignPlan:
    catalogue: str
    table: IdTable
    parent: ReleaseData
    catalogue_doc: Dict[str, Any]
    changes: List[ItemChange]
    unchanged: int
    release_items: Dict[str, dict]          # the items.json entries of the new release (itemId -> entry)
    release_changes: int                    # how many items.json entries differ from the parent's
    warnings: List[str] = field(default_factory=list)

    @property
    def nothing_to_do(self) -> bool:
        return not self.changes and self.release_changes == 0

    def lines(self, *, dry_run: bool) -> List[str]:
        verb = "would" if dry_run else "will"
        pids = {c.product_id for c in self.changes if c.product_id}
        out = [f"Catalogue {self.catalogue!r}: {len(self.changes) + self.unchanged} items, live release {self.parent.release_id}.",
               f"{len(self.changes)} item documents {verb} change ({self.unchanged} already right); {len(pids)} distinct product ids in the changes."]
        hidden = [c.page for c in self.changes if c.status == "hidden"]
        if hidden:
            out.append(f"Hidden from search (not a material): page(s) {', '.join(map(str, hidden))}.")
        repeated = {p: [c.page for c in self.changes if c.product_id == p] for p in sorted(pids)}
        repeated = {p: pages for p, pages in repeated.items() if len(pages) > 1}
        for pid, pages in repeated.items():
            out.append(f"{pid} is printed on pages {pages}: one product, {len(pages)} photos.")
        if self.release_changes:
            out.append(f"A new release {verb} be written: the same vectors byte for byte, {self.release_changes} item entries with a product id. It {verb} then become the live release (the old one stays for a roll back).")
        else:
            out.append("The live release already carries these product ids: no new release is needed.")
        out.extend(self.warnings)
        return out


def _attributes(table: IdTable, entry: PageEntry, previous: Mapping[str, Any]) -> Dict[str, Any]:
    attributes = dict(previous or {})
    for key in ("code", "printedName", "pdfPage", "otherPages"):
        attributes.pop(key, None)
    if entry.code:
        attributes["code"] = entry.code
        attributes["printedName"] = entry.printed_name
        attributes["pdfPage"] = entry.page
        others = [p for p in table.pages_of(entry.code) if p != entry.page]
        if others:
            attributes["otherPages"] = ", ".join(str(p) for p in others)
    return attributes


def plan_assignment(table: IdTable, *, catalogue: str, store, db) -> AssignPlan:
    """Read the live catalogue and say what would change. Writes nothing. Raises AssignError listing every problem."""
    if catalogue != table.catalogue:
        raise AssignError(f"The table is for the catalogue {table.catalogue!r}, not {catalogue!r}.")
    doc = db.get_catalogue(catalogue)
    if doc is None:
        raise AssignError(f"The catalogue {catalogue!r} does not exist.")
    live = doc.get("activeRelease")
    if not live:
        raise AssignError(f"The catalogue {catalogue!r} has no live release to build on.")
    try:
        parent = read_release(store, catalogue, live)
    except ReleaseReadError as error:
        raise AssignError(str(error)) from None
    items = db.get_items(catalogue)
    problems: List[str] = []
    warnings: List[str] = []
    pages_seen: Dict[int, str] = {}
    for item_id, item in sorted(items.items()):
        page = (item.get("source") or {}).get("page")
        if not isinstance(page, int):
            problems.append(f"item {item_id} has no PDF page number, so it cannot be matched to the table.")
        elif page in pages_seen:
            problems.append(f"items {pages_seen[page]} and {item_id} are both on page {page}: the table cannot tell them apart.")
        elif page not in table.pages:
            problems.append(f"item {item_id} is on page {page}, which the table does not list.")
        else:
            pages_seen[page] = item_id
        if (item.get("source") or {}).get("sha256") and table.pdf_sha256 and item["source"]["sha256"] != table.pdf_sha256:
            problems.append(f"item {item_id} comes from a PDF with another sha256 than the one the table was read from.")
    missing = sorted(set(items) - set(parent.items))
    if missing:
        problems.append(f"{len(missing)} item documents are not in the live release (first: {missing[0]}); publish or activate first.")
    unused = sorted(set(table.pages) - set(pages_seen))
    if unused:
        warnings.append(f"The table lists page(s) {unused} that have no item in the catalogue.")
    if problems:
        raise AssignError(f"{len(problems)} problem(s); nothing was changed.", problems)

    changes: List[ItemChange] = []
    unchanged = 0
    release_items: Dict[str, dict] = {}
    release_changes = 0
    for item_id, item in sorted(items.items()):
        page = item["source"]["page"]
        entry = table.pages[page]
        product_id = table.product_id(page)
        label = display_name(entry.printed_name) if entry.printed_name else item.get("label")
        status = "hidden" if entry.hide else item.get("status", "ok")
        attributes = _attributes(table, entry, item.get("attributes") or {})
        wanted = {"productId": product_id, "productIdSource": "admin" if product_id else item.get("productIdSource"), "label": label, "status": status, "attributes": attributes}
        have = {key: item.get(key) for key in wanted}
        if wanted == have:
            unchanged += 1
        else:
            before = {"productId": item.get("productId"), "productIdSource": item.get("productIdSource"), "label": item.get("label"), "status": item.get("status", "ok"),
                      "attributes": dict(item.get("attributes") or {})}
            changes.append(ItemChange(item_id, page, product_id, label, status, attributes, before))
        entry_json = dict(parent.items[item_id])
        if entry_json.get("productId") != product_id:
            release_changes += 1
        entry_json["productId"] = product_id
        release_items[item_id] = entry_json
    return AssignPlan(catalogue, table, parent, doc, changes, unchanged, release_items, release_changes, warnings)


# ---------------------------------------------------------------------------------------------------------------------------------- build
def reissue_release(parent: ReleaseData, release_items: Mapping[str, dict], *, catalogue: str, release_id: str, created_at: int, job_id: Optional[str]) -> BuiltRelease:
    """The parent's vectors, byte for byte, with another items.json. Raises AssignError if a vector file would not come out identical."""
    ordered = [release_items[item_id] for item_id in sorted(release_items)]
    files: Dict[str, bytes] = {"items.json": canonical_json(ordered)}
    entries: Dict[str, dict] = {}
    for name, (ids, matrix) in parent.pillars.items():
        npy, ids_json = npy_bytes(matrix), canonical_json(ids)
        old = parent.manifest["pillars"][name]
        if sha256_hex(npy) != old["sha256"] or sha256_hex(ids_json) != old["idsSha256"]:
            raise AssignError(f"The '{name}' vectors of {parent.release_id} would not be written back byte for byte (the release was made by another version of the code); "
                              "nothing was changed.")
        files[f"pillars/{name}.npy"], files[f"pillars/{name}.ids.json"] = npy, ids_json
        entries[name] = dict(old)
    manifest = {"schema": parent.manifest["schema"], "releaseId": release_id, "catalogue": catalogue, "createdAt": int(created_at), "parent": parent.release_id,
                "jobId": job_id, "nItems": len(ordered), "featureVersions": dict(parent.manifest["featureVersions"]), "pillars": entries, "itemsFile": "items.json",
                "itemsSha256": sha256_hex(files["items.json"]), "package": {"name": "terucon_catalogue", "version": __version__}}
    manifest_bytes = json.dumps(manifest, indent=2, sort_keys=True, ensure_ascii=True, allow_nan=False).encode("ascii") + b"\n"
    return BuiltRelease(catalogue=catalogue, release_id=release_id, created_at=int(created_at), parent=parent.release_id, job_id=job_id, files=files, manifest=manifest,
                        manifest_bytes=manifest_bytes, feature_versions=dict(manifest["featureVersions"]), n_items=len(ordered),
                        pillar_summary={n: {"count": e["count"], "dim": e["dim"]} for n, e in entries.items()})


@dataclass
class AssignResult:
    changed_items: int
    release_id: Optional[str]
    previous_release: str
    activated: bool
    backup_path: Optional[str]
    lines: List[str]


def _write_backup(plan: AssignPlan, path: Path, now_ms: int) -> None:
    doc = plan.catalogue_doc
    body = {"version": BACKUP_VERSION, "writtenAt": now_ms, "catalogue": plan.catalogue,
            "was": {"activeRelease": doc.get("activeRelease"), "previousRelease": doc.get("previousRelease")},
            "items": {change.item_id: change.before for change in plan.changes}}
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(body, indent=1, sort_keys=True, ensure_ascii=True), encoding="utf-8")


def apply_assignment(plan: AssignPlan, *, store, db, backup_path, activate: bool = True, say: Callable[[str], None] = lambda _text: None) -> AssignResult:
    """Write. Order: backup file -> new release files in the store (manifest last) -> its record -> the item documents -> the live pointer, last.

    Any failure before the pointer flips leaves the old live release live; running the command again finishes the job."""
    if plan.nothing_to_do:
        return AssignResult(0, None, plan.parent.release_id, False, None, ["Nothing to do: every item already has its product id."])
    if backup_path is None:
        raise AssignError("A backup file is required before anything is written.")
    now_ms = publish_module.CLOCK()
    backup = Path(backup_path)
    _write_backup(plan, backup, now_ms)
    say(f"Backup of the old values: {backup}")
    release_id: Optional[str] = None
    if plan.release_changes:
        release_id = publish_module.new_release_id(now_ms)
        built = reissue_release(plan.parent, plan.release_items, catalogue=plan.catalogue, release_id=release_id, created_at=now_ms, job_id=f"assign-ids-{now_ms}")
        write_release(store, built)
        say(f"Release {release_id} written ({built.n_items} items, vectors identical to {plan.parent.release_id}).")
        db.insert_release(publish_module._release_doc(plan.catalogue, built, created_by="cli", job_id=built.job_id, now_ms=now_ms, parent_id=plan.parent.release_id))
    for number, change in enumerate(plan.changes, start=1):
        if not db.patch_item(plan.catalogue, change.item_id, change.patch):
            raise AssignError(f"The item document {change.item_id} disappeared while the ids were being written; the old release is still live. Run the command again.")
    say(f"{len(plan.changes)} item documents updated.")
    activated = False
    if activate and release_id:
        publish_module.activate_release(plan.catalogue, release_id, store=store, db=db)
        activated = True
        say(f"{release_id} is now the live release.")
    lines = [f"{len(plan.changes)} items now carry their product id; " + (f"release {release_id} is live." if activated else "the new release is NOT live yet.")]
    return AssignResult(len(plan.changes), release_id, plan.parent.release_id, activated, str(backup), lines)


def restore_assignment(backup_path, *, store, db, say: Callable[[str], None] = lambda _text: None) -> int:
    """Undo apply_assignment: put the old item values back, and make the release that was live then live again. Returns how many items were restored."""
    try:
        body = json.loads(Path(backup_path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raise AssignError(f"The backup {str(backup_path)!r} cannot be read.") from None
    if not isinstance(body, dict) or body.get("version") != BACKUP_VERSION or not isinstance(body.get("items"), dict):
        raise AssignError(f"{str(backup_path)!r} is not a backup this version wrote.")
    catalogue = body["catalogue"]
    was = (body.get("was") or {}).get("activeRelease")
    restored = 0
    for item_id, before in body["items"].items():
        db.patch_item(catalogue, item_id, {"productId": before.get("productId"), "label": before.get("label"), "status": before.get("status") or "ok",
                                           "attributes": before.get("attributes") or {}})
        restored += 1
        if before.get("productIdSource") == "pdf-text" and before.get("productId"):
            say(f"note: {item_id} had a product id read from the PDF's text layer; it is back as an admin id.")
    say(f"{restored} item documents restored.")
    if was:
        publish_module.activate_release(catalogue, was, store=store, db=db)
        say(f"{was} is the live release again.")
    return restored
