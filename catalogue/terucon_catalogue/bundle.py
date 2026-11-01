"""Reading a bundle: the notebook's work_dir (state.sqlite + crops/), read-only.

A bundle may come from three places and looks slightly different in each:
* the notebook as it ran on Kaggle: items.crop_filepath is an ABSOLUTE Kaggle path (/kaggle/working/crops/<dir>/<file>.png) and source_pdf is
  /kaggle/input/datasets/<user>/<slug>/<name>.pdf;
* this package's own compute: crop_filepath is RELATIVE to the bundle folder (crops/<dir>/<file>.png) and source_pdf is the PDF's file name;
* a folder somebody downloaded and unzipped: state.sqlite and a crops folder somewhere beneath the folder you point at.
Both path styles resolve to the crop files that are really in the folder you give (never to a file outside it).

The database is never opened in place. The notebook runs SQLite in WAL mode, so a download can hold committed rows in state.sqlite-wal that the main
file does not have; opening the original would also let SQLite checkpoint (modify) the user's file. So state.sqlite (and -wal / -shm when present) are
COPIED to a temporary folder and the copy is opened. close() (or leaving the `with` block) removes the copy.

Nothing is repaired: verify() reports; it does not fix, renormalise or drop anything.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import re
import shutil
import sqlite3
import tempfile
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath
from typing import Any, Dict, Iterator, List, Mapping, Optional, Sequence, Tuple

import numpy as np

KNOWN_PIPELINE_PILLARS = ("dino", "siglip", "color", "vertex_mm", "text")
CORE_PILLARS = ("dino", "siglip", "color")          # an item with none of these cannot be searched by photo
KNOWN_PATH_PREFIXES = ("/kaggle/working/",)         # where the notebook's work_dir was; stripped to find the crop inside the bundle
NORM_TOLERANCE = 0.02                               # vectors are stored float16, normalised before storing: a norm within 1 +/- 0.02 is rounding, not damage
IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp"}
ITEM_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")

_REQUIRED_COLUMNS = {
    "items": {"item_id", "product_id", "source_pdf", "pdf_sha256", "page_number", "item_index", "image_bbox", "id_bbox", "page_width", "page_height",
              "original_rotation", "crop_filepath", "crop_width", "crop_height", "sha256_hash", "match_type", "match_relation", "match_cost",
              "extraction_method", "inpainted_overlay", "status", "created_at"},
    "embeddings": {"item_id", "pillar", "feature_version", "dim", "dtype", "vector", "extra_json"},
    "captions": {"item_id", "caption_version", "model", "status", "attempts", "profile_json", "error"},
    "pages": {"pdf_sha256", "page_number", "source_pdf", "status", "attempts", "error"},
    "pdfs": {"pdf_sha256", "source_pdf", "file_size", "page_count", "status", "error"},
    "feature_errors": {"item_id", "pillar", "attempts", "error"},
}


class BundleError(RuntimeError):
    """The folder is not a readable bundle (no state.sqlite, several of them, not a catalogue database, or a pillar with two versions)."""


@dataclass(frozen=True)
class Problem:
    level: str       # "error": do not publish; "warning": publishable, but say so
    code: str
    message: str

    def __str__(self) -> str:
        return self.message


def errors_of(problems: Sequence[Problem]) -> List[Problem]:
    return [problem for problem in problems if problem.level == "error"]


def warnings_of(problems: Sequence[Problem]) -> List[Problem]:
    return [problem for problem in problems if problem.level == "warning"]


@dataclass
class BundleItem:
    item_id: str
    status: str
    product_id: Optional[str]            # read from the PDF's text layer by the notebook; None = "UNMATCHED"
    product_id_raw: Optional[str]
    source_pdf: str                      # as stored
    source_name: str                     # the file name only
    pdf_sha256: str
    page_number: int
    item_index: int
    image_bbox: Optional[list]
    id_bbox: Optional[list]
    page_width: Optional[float]
    page_height: Optional[float]
    original_rotation: Optional[int]
    crop_filepath: str                   # as stored
    crop_path: Optional[Path]            # where it really is inside the bundle; None if it cannot be found
    crop_width: Optional[int]
    crop_height: Optional[int]
    render_zoom: Optional[float]
    sha256: str                          # items.sha256_hash: the sha256 of the exact crop bytes the notebook wrote
    match_type: Optional[str]
    match_relation: Optional[str]
    match_cost: Optional[float]
    extraction_method: Optional[str]
    inpainted: bool
    created_at: str
    caption: Optional[dict] = None       # {status, model, version, attempts, profile (dict or None), search_text, error}
    color: Optional[dict] = None         # the colour pillar's extra_json: dominant_hex, proportions, dominant_lab
    pillars: frozenset = field(default_factory=frozenset)   # the pillars this item has a vector row for

    @property
    def crop_suffix(self) -> str:
        suffix = Path(self.crop_filepath.replace("\\", "/")).suffix.lower()
        return suffix if suffix in IMAGE_SUFFIXES else ".png"

    @property
    def is_searchable(self) -> bool:
        return any(pillar in self.pillars for pillar in CORE_PILLARS)


def sha256_of_file(path: Path, chunk_size: int = 1 << 20) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        while True:
            chunk = handle.read(chunk_size)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def _json_or_none(text: Optional[str]) -> Any:
    if text is None or text == "":
        return None
    try:
        return json.loads(text)
    except ValueError:
        return None


def _sample(names: Sequence[str], count: int = 3) -> str:
    names = list(names)
    shown = ", ".join(names[:count])
    return shown if len(names) <= count else f"{shown} and {len(names) - count} more"


def _plural(count: int, noun: str, plural: Optional[str] = None) -> str:
    return f"{count} {noun if count == 1 else (plural or noun + 's')}"


def display_name(source_pdf: str) -> str:
    """The PDF's file name from a stored path of either style (/kaggle/input/.../name.pdf, C:\\...\\name.pdf, or just name.pdf)."""
    return PurePosixPath(str(source_pdf).replace("\\", "/")).name or str(source_pdf)


class Bundle:
    def __init__(self, path, *, extra_path_prefixes: Sequence[str] = ()):
        self.given = Path(path).expanduser()
        self.path_prefixes = tuple(sorted({*KNOWN_PATH_PREFIXES, *(p if p.endswith("/") else p + "/" for p in extra_path_prefixes)}, key=len, reverse=True))
        self.state_source = self._locate_state(self.given)
        self.base = self.state_source.parent                 # relative crop paths are relative to the folder holding state.sqlite
        self.root = self.given if self.given.is_dir() else self.base
        self._root_resolved = self.root.resolve()
        self._crop_index_cache: Optional[Tuple[dict, dict]] = None
        self._copy_dir = tempfile.TemporaryDirectory(prefix="terucon-bundle-")
        self._connection: Optional[sqlite3.Connection] = None
        try:
            self._open_copy()
        except BaseException:
            self.close()
            raise

    # ------------------------------------------------------------------------------------------------------------------ opening
    @staticmethod
    def _locate_state(given: Path) -> Path:
        if given.is_file():
            if given.name != "state.sqlite":
                raise BundleError(f"{given} is a file, but a bundle is a folder holding state.sqlite (or state.sqlite itself).")
            return given
        if not given.is_dir():
            raise BundleError(f"{given} does not exist.")
        direct = given / "state.sqlite"
        if direct.is_file():
            return direct
        found = sorted(path for path in given.rglob("state.sqlite") if path.is_file())
        if not found:
            raise BundleError(f"There is no state.sqlite in {given} or beneath it. A bundle is the notebook's output folder: state.sqlite and a crops folder.")
        if len(found) > 1:
            listing = "; ".join(str(path) for path in found[:5])
            raise BundleError(f"There are {len(found)} state.sqlite files beneath {given} ({listing}). Point at the folder of the one you mean.")
        return found[0]

    def _open_copy(self) -> None:
        target = Path(self._copy_dir.name) / "state.sqlite"
        shutil.copyfile(self.state_source, target)
        for suffix in ("-wal", "-shm"):
            sidecar = Path(str(self.state_source) + suffix)
            if sidecar.is_file():
                shutil.copyfile(sidecar, Path(str(target) + suffix))
        try:
            connection = sqlite3.connect(str(target), check_same_thread=False)
            connection.row_factory = sqlite3.Row
            tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        except sqlite3.DatabaseError as exc:
            raise BundleError(f"{self.state_source} is not a readable SQLite database ({exc}).") from None
        self._connection = connection
        for table, wanted in _REQUIRED_COLUMNS.items():
            if table not in tables:
                raise BundleError(f"{self.state_source} is not a catalogue state database: it has no '{table}' table.")
            columns = {row[1] for row in connection.execute(f"PRAGMA table_info({table})")}
            missing = sorted(wanted - columns)
            if missing:
                raise BundleError(f"{self.state_source}: table '{table}' lacks the columns {missing}; it was not made by the catalogue notebook or this package.")
        connection.execute("PRAGMA query_only = ON")

    def close(self) -> None:
        connection, self._connection = getattr(self, "_connection", None), None
        if connection is not None:
            try:
                connection.close()
            except sqlite3.Error:
                pass
        copy_dir = getattr(self, "_copy_dir", None)
        if copy_dir is not None:
            copy_dir.cleanup()

    def __enter__(self) -> "Bundle":
        return self

    def __exit__(self, *exc_info) -> None:
        self.close()

    def __del__(self) -> None:
        try:
            self.close()
        except Exception:
            pass

    def _query(self, sql: str, parameters: Sequence[Any] = ()) -> List[sqlite3.Row]:
        if self._connection is None:
            raise BundleError("this bundle has been closed.")
        return self._connection.execute(sql, tuple(parameters)).fetchall()

    # ------------------------------------------------------------------------------------------------------------------ crop files
    def _crop_index(self) -> Tuple[dict, dict]:
        """Every image file below the bundle folder, indexed once: by (parent folder name, file name) and by file name."""
        if self._crop_index_cache is None:
            by_pair: Dict[Tuple[str, str], List[Path]] = defaultdict(list)
            by_name: Dict[str, List[Path]] = defaultdict(list)
            for current, _directories, files in os.walk(self.root):
                for name in files:
                    if Path(name).suffix.lower() in IMAGE_SUFFIXES:
                        path = Path(current) / name
                        by_pair[(Path(current).name, name)].append(path)
                        by_name[name].append(path)
            self._crop_index_cache = (by_pair, by_name)
        return self._crop_index_cache

    def _inside_root(self, candidate: Path) -> Optional[Path]:
        try:
            resolved = candidate.resolve()
        except OSError:
            return None
        if resolved.is_file() and (resolved == self._root_resolved or self._root_resolved in resolved.parents):
            return resolved
        return None

    def resolve_crop(self, stored: str) -> Optional[Path]:
        """Where the crop named by items.crop_filepath really is, inside the bundle folder. None if it is not there."""
        text = str(stored or "").replace("\\", "/").strip()
        if not text:
            return None
        absolute = text.startswith("/") or re.match(r"^[A-Za-z]:/", text) is not None
        relatives: List[str] = []
        if not absolute:
            relatives.append(text)
        else:
            for prefix in self.path_prefixes:
                if text.startswith(prefix):
                    relatives.append(text[len(prefix):])
                    break
        parts = text.split("/")
        crops_positions = [position for position, part in enumerate(parts[:-1]) if part == "crops"]
        if crops_positions:
            relatives.append("/".join(parts[crops_positions[-1]:]))        # from the LAST "crops" component on: crops/<dir>/<file>.png
        for relative in relatives:
            if ".." in relative.split("/"):
                continue
            for anchor in (self.base, self.root):
                found = self._inside_root(anchor / relative)
                if found is not None:
                    return found
        if absolute:
            found = self._inside_root(Path(text))
            if found is not None:
                return found
        by_pair, by_name = self._crop_index()
        name = parts[-1]
        candidates = by_pair.get((parts[-2] if len(parts) > 1 else "", name)) or []
        if len(candidates) == 1:
            return self._inside_root(candidates[0])
        if not candidates and len(by_name.get(name, [])) == 1:
            return self._inside_root(by_name[name][0])
        return None

    def path_style(self, stored: str) -> str:
        text = str(stored or "").replace("\\", "/")
        if any(text.startswith(prefix) for prefix in self.path_prefixes):
            return "absolute-kaggle"
        if text.startswith("/") or re.match(r"^[A-Za-z]:/", text):
            return "absolute-other"
        return "relative"

    # ----------------------------------------------------------------------------------------------------------------------- rows
    def _captions(self) -> Dict[str, dict]:
        captions = {}
        for row in self._query("SELECT item_id, caption_version, model, status, attempts, profile_json, search_text, error FROM captions"):
            profile = _json_or_none(row["profile_json"])
            captions[row["item_id"]] = {"status": row["status"], "model": row["model"], "version": row["caption_version"], "attempts": row["attempts"],
                                        "profile": profile if isinstance(profile, dict) else None, "search_text": row["search_text"], "error": row["error"]}
        return captions

    def _color_meta(self) -> Dict[str, dict]:
        meta = {}
        for row in self._query("SELECT item_id, extra_json FROM embeddings WHERE pillar = 'color'"):
            parsed = _json_or_none(row["extra_json"])
            if isinstance(parsed, dict):
                meta[row["item_id"]] = parsed
        return meta

    def _pillars_by_item(self) -> Dict[str, frozenset]:
        found: Dict[str, set] = defaultdict(set)
        for row in self._query("SELECT item_id, pillar FROM embeddings"):
            found[row["item_id"]].add(row["pillar"])
        return {item_id: frozenset(names) for item_id, names in found.items()}

    def items(self, *, only_ok: bool = True) -> Iterator[BundleItem]:
        """Typed rows in item-id order, joined with the caption profile and the colour metadata. Crop paths are resolved here."""
        captions, colors, pillars = self._captions(), self._color_meta(), self._pillars_by_item()
        where = "WHERE status = 'ok'" if only_ok else ""
        for row in self._query(f"SELECT * FROM items {where} ORDER BY item_id"):
            stored = row["crop_filepath"]
            bbox, id_bbox = _json_or_none(row["image_bbox"]), _json_or_none(row["id_bbox"])
            yield BundleItem(
                item_id=row["item_id"], status=row["status"], product_id=row["product_id"], product_id_raw=row["product_id_raw"] if "product_id_raw" in row.keys() else None,
                source_pdf=row["source_pdf"], source_name=display_name(row["source_pdf"]), pdf_sha256=row["pdf_sha256"], page_number=int(row["page_number"]),
                item_index=int(row["item_index"]), image_bbox=bbox if isinstance(bbox, list) else None, id_bbox=id_bbox if isinstance(id_bbox, list) else None,
                page_width=row["page_width"], page_height=row["page_height"], original_rotation=row["original_rotation"], crop_filepath=stored,
                crop_path=self.resolve_crop(stored), crop_width=row["crop_width"], crop_height=row["crop_height"],
                render_zoom=row["render_zoom"] if "render_zoom" in row.keys() else None, sha256=row["sha256_hash"], match_type=row["match_type"],
                match_relation=row["match_relation"], match_cost=row["match_cost"], extraction_method=row["extraction_method"],
                inpainted=bool(row["inpainted_overlay"]), created_at=row["created_at"], caption=captions.get(row["item_id"]), color=colors.get(row["item_id"]),
                pillars=pillars.get(row["item_id"], frozenset()))

    def vectors(self, pillar: str) -> Iterator[Tuple[str, np.ndarray]]:
        """(item_id, float32 vector) in item-id order for the items that would be published (status 'ok'). Raises BundleError for a blob that is not
        dim x itemsize bytes: verify() reports that first, and nothing is guessed."""
        cursor = self._connection.execute(
            "SELECT e.item_id, e.dim, e.dtype, e.vector FROM embeddings e JOIN items i ON i.item_id = e.item_id "
            "WHERE e.pillar = ? AND i.status = 'ok' ORDER BY e.item_id", (pillar,))
        for row in cursor:
            yield row["item_id"], self._decode(row["item_id"], pillar, row["dim"], row["dtype"], row["vector"])

    @staticmethod
    def _decode(item_id: str, pillar: str, dim: int, dtype: str, blob: bytes) -> np.ndarray:
        try:
            width = np.dtype(dtype).itemsize
        except TypeError:
            raise BundleError(f"{item_id}: the '{pillar}' vector has an unknown dtype {dtype!r}.") from None
        if blob is None or len(blob) != int(dim) * width:
            raise BundleError(f"{item_id}: the '{pillar}' vector is {0 if blob is None else len(blob)} bytes but dim {dim} x {dtype} needs {int(dim) * width}.")
        return np.frombuffer(blob, dtype=np.dtype(dtype)).astype(np.float32)

    def feature_versions(self) -> Dict[str, str]:
        """{pillar: feature_version} over the items that would be published. Raises BundleError if a pillar has more than one version."""
        seen: Dict[str, Dict[str, int]] = defaultdict(dict)
        for row in self._query("SELECT e.pillar, e.feature_version, COUNT(*) AS n FROM embeddings e JOIN items i ON i.item_id = e.item_id "
                               "WHERE i.status = 'ok' GROUP BY e.pillar, e.feature_version"):
            seen[row["pillar"]][row["feature_version"]] = int(row["n"])
        crowded = {pillar: versions for pillar, versions in seen.items() if len(versions) > 1}
        if crowded:
            detail = "; ".join(f"'{pillar}': " + ", ".join(f"{count} items as {version!r}" for version, count in versions.items()) for pillar, versions in crowded.items())
            raise BundleError(f"A catalogue cannot mix feature versions, but the items in this bundle do ({detail}). Recompute the stale items so one version remains.")
        return {pillar: next(iter(versions)) for pillar, versions in seen.items()}

    def pdfs(self) -> List[dict]:
        return [{"sha256": row["pdf_sha256"], "name": display_name(row["source_pdf"]), "source_pdf": row["source_pdf"], "file_size": row["file_size"],
                 "page_count": row["page_count"], "status": row["status"], "error": row["error"]}
                for row in self._query("SELECT * FROM pdfs ORDER BY pdf_sha256")]

    def pages(self) -> List[dict]:
        return [{"pdf_sha256": row["pdf_sha256"], "page_number": int(row["page_number"]), "status": row["status"], "attempts": row["attempts"],
                 "n_items": row["n_items"] if "n_items" in row.keys() else None, "error": row["error"]}
                for row in self._query("SELECT * FROM pages ORDER BY pdf_sha256, page_number")]

    def unmatched_count(self) -> int:
        """Items whose product id could not be read from the PDF's text layer (product_id NULL): 'UNMATCHED' in the notebook."""
        return int(self._query("SELECT COUNT(*) AS n FROM items WHERE status = 'ok' AND product_id IS NULL")[0]["n"])

    def snapshot_to(self, destination) -> Path:
        """A consistent single-file copy of the database (made from OUR copy with VACUUM INTO, never from the user's file)."""
        destination = Path(destination)
        destination.parent.mkdir(parents=True, exist_ok=True)
        if destination.exists():
            destination.unlink()
        self._connection.execute("PRAGMA query_only = OFF")
        try:
            self._connection.execute("VACUUM INTO ?", (str(destination),))
        finally:
            self._connection.execute("PRAGMA query_only = ON")
        return destination

    # ----------------------------------------------------------------------------------------------------------------------- verify
    def verify(self, cfg: Any = None) -> List[Problem]:
        """Everything wrong or doubtful about this bundle. Errors block a publish; warnings are carried into its result.
        With cfg (a PipelineConfig) the vector sizes are also compared with what the notebook's models produce."""
        problems: List[Problem] = []
        rows = self._query("SELECT item_id, status, sha256_hash, crop_filepath, crop_width, crop_height FROM items ORDER BY item_id")
        if not rows:
            return [Problem("error", "no-items", "The bundle has no items: state.sqlite has an empty 'items' table.")]
        self._verify_items(rows, problems)
        self._verify_crops([row for row in rows if row["status"] == "ok"], problems)
        self._verify_vectors(problems, cfg)
        self._verify_completeness(rows, problems)
        return problems

    def _verify_items(self, rows: Sequence[sqlite3.Row], problems: List[Problem]) -> None:
        by_status: Dict[str, List[str]] = defaultdict(list)
        for row in rows:
            if row["status"] != "ok":
                by_status[str(row["status"])].append(row["item_id"])
        for status, ids in sorted(by_status.items()):
            problems.append(Problem("error", "item-status", f"{_plural(len(ids), 'item')} {'has' if len(ids) == 1 else 'have'} status '{status}' instead of 'ok' "
                                    f"({_sample(ids)}); only finished items can be published."))
        bad_ids = [row["item_id"] for row in rows if not ITEM_ID_PATTERN.match(str(row["item_id"]))]
        if bad_ids:
            problems.append(Problem("error", "item-id", f"{_plural(len(bad_ids), 'item id')} cannot be used as {'a' if len(bad_ids) == 1 else ''} storage name"
                                    f"{'' if len(bad_ids) == 1 else 's'} ({_sample(bad_ids)}); ids may use letters, digits, '.', '_' and '-' only."))

    def _verify_crops(self, rows: Sequence[sqlite3.Row], problems: List[Problem]) -> None:
        from PIL import Image

        missing, mismatched, unreadable, wrong_size = [], [], [], []
        for row in rows:
            path = self.resolve_crop(row["crop_filepath"])
            if path is None:
                missing.append(row["item_id"])
                continue
            try:
                actual = sha256_of_file(path)
            except OSError:
                missing.append(row["item_id"])
                continue
            if actual != row["sha256_hash"]:
                mismatched.append(row["item_id"])
                continue
            try:
                with Image.open(path) as image:
                    size = image.size
            except Exception:
                unreadable.append(row["item_id"])
                continue
            if row["crop_width"] is not None and row["crop_height"] is not None and size != (int(row["crop_width"]), int(row["crop_height"])):
                wrong_size.append(row["item_id"])
        if missing:
            first = next(row for row in rows if row["item_id"] == missing[0])
            problems.append(Problem("error", "crop-missing", f"{_plural(len(missing), 'crop file')} {'is' if len(missing) == 1 else 'are'} missing from the bundle folder "
                                    f"({_sample(missing)}; for the first the database says {first['crop_filepath']!r}). Copy the whole crops folder next to state.sqlite."))
        if mismatched:
            problems.append(Problem("error", "crop-sha256", f"{_plural(len(mismatched), 'crop file')} {'differs' if len(mismatched) == 1 else 'differ'} from the checksum the notebook "
                                    f"recorded when it wrote {'it' if len(mismatched) == 1 else 'them'} ({_sample(mismatched)}): the file changed or was damaged after extraction."))
        if unreadable:
            problems.append(Problem("error", "crop-unreadable", f"{_plural(len(unreadable), 'crop file')} cannot be read as {'an image' if len(unreadable) == 1 else 'images'} ({_sample(unreadable)})."))
        if wrong_size:
            problems.append(Problem("error", "crop-size", f"{_plural(len(wrong_size), 'crop image')} {'has' if len(wrong_size) == 1 else 'have'} a width or height that differs from the "
                                    f"database ({_sample(wrong_size)})."))

    def _verify_vectors(self, problems: List[Problem], cfg: Any) -> None:
        per_pillar_dims: Dict[str, Dict[int, List[str]]] = defaultdict(lambda: defaultdict(list))
        bad_length: Dict[str, List[str]] = defaultdict(list)
        bad_dtype: Dict[str, List[str]] = defaultdict(list)
        non_finite: Dict[str, List[str]] = defaultdict(list)
        bad_norm: Dict[str, List[Tuple[str, float]]] = defaultdict(list)
        versions: Dict[str, Dict[str, int]] = defaultdict(lambda: defaultdict(int))
        cursor = self._connection.execute(
            "SELECT e.item_id, e.pillar, e.feature_version, e.dim, e.dtype, e.vector FROM embeddings e JOIN items i ON i.item_id = e.item_id "
            "WHERE i.status = 'ok' ORDER BY e.pillar, e.item_id")
        for row in cursor:
            pillar, item_id = row["pillar"], row["item_id"]
            versions[pillar][row["feature_version"]] += 1
            per_pillar_dims[pillar][int(row["dim"])].append(item_id)
            if row["dtype"] != "float16":
                bad_dtype[pillar].append(item_id)
                continue
            blob = row["vector"]
            if blob is None or len(blob) != int(row["dim"]) * np.dtype("float16").itemsize:
                bad_length[pillar].append(item_id)
                continue
            vector = np.frombuffer(blob, dtype=np.float16).astype(np.float32)
            if not np.isfinite(vector).all():
                non_finite[pillar].append(item_id)
                continue
            norm = float(np.linalg.norm(vector))
            if abs(norm - 1.0) > NORM_TOLERANCE:
                bad_norm[pillar].append((item_id, norm))
        for pillar in sorted(per_pillar_dims):
            dims = per_pillar_dims[pillar]
            if len(dims) > 1:
                detail = ", ".join(f"{dim} numbers ({_plural(len(ids), 'item')}: {_sample(ids, 2)})" for dim, ids in sorted(dims.items(), key=lambda kv: -len(kv[1])))
                problems.append(Problem("error", "dims", f"The '{pillar}' vectors are not all the same size: {detail}."))
        for pillar, ids in sorted(bad_dtype.items()):
            problems.append(Problem("error", "dtype", f"{_plural(len(ids), 'item')} store the '{pillar}' vector as something other than float16 ({_sample(ids)})."))
        for pillar, ids in sorted(bad_length.items()):
            problems.append(Problem("error", "vector-length", f"{_plural(len(ids), 'item')} {'has' if len(ids) == 1 else 'have'} a '{pillar}' vector whose bytes do not match its "
                                    f"recorded size, so it is truncated or damaged ({_sample(ids)})."))
        for pillar, ids in sorted(non_finite.items()):
            problems.append(Problem("error", "non-finite", f"{_plural(len(ids), 'item')} {'has' if len(ids) == 1 else 'have'} a '{pillar}' vector with NaN or infinite numbers ({_sample(ids)})."))
        for pillar, entries in sorted(bad_norm.items()):
            ids = [item_id for item_id, _ in entries]
            example = f"{entries[0][0]} has length {entries[0][1]:.3f}"
            problems.append(Problem("error", "norm", f"{_plural(len(entries), 'item')} {'has' if len(entries) == 1 else 'have'} a '{pillar}' vector that is not unit length "
                                    f"(within 1 +/- {NORM_TOLERANCE}): {example}; affected: {_sample(ids)}. Vectors are normalised before they are stored, so this is damage, not rounding."))
        for pillar, counts in sorted(versions.items()):
            if len(counts) > 1:
                detail = "; ".join(f"{count} item(s) as {version!r}" for version, count in counts.items())
                problems.append(Problem("error", "feature-version", f"A catalogue cannot mix feature versions, but the '{pillar}' vectors come in {len(counts)}: {detail}."))
        unknown = sorted(pillar for pillar in versions if pillar not in KNOWN_PIPELINE_PILLARS)
        if unknown:
            problems.append(Problem("warning", "unknown-pillar", f"The bundle holds vectors for {unknown}, which this code does not know; they are left out of the release."))
        if cfg is not None:
            problems.extend(self._expected_size_problems(per_pillar_dims, versions, cfg))

    @staticmethod
    def _expected_size_problems(per_pillar_dims: Mapping[str, Mapping[int, Sequence[str]]], versions: Mapping[str, Mapping[str, int]], cfg: Any) -> List[Problem]:
        from . import config as config_module

        current = config_module.compute_feature_versions(cfg)
        expected = {"dino": 3072, "siglip": 1152, "color": int(np.prod(cfg.color_bins)) + 4 * int(cfg.color_kmeans_k),
                    "vertex_mm": int(cfg.vertex_mm_dimension), "text": int(cfg.text_embedding_dim)}
        problems = []
        for pillar, want in expected.items():
            if pillar not in per_pillar_dims or set(versions.get(pillar, {})) != {current[pillar]}:
                continue                                    # only when the version label is exactly the one this code (and the notebook) writes
            wrong = {dim: ids for dim, ids in per_pillar_dims[pillar].items() if dim != want}
            if wrong:
                count = sum(len(ids) for ids in wrong.values())
                problems.append(Problem("error", "dims-expected", f"{_plural(count, 'item')} {'has' if count == 1 else 'have'} a '{pillar}' vector of {sorted(wrong)} numbers, but "
                                        f"the version label ({current[pillar]!r}) means {want} ({_sample([i for ids in wrong.values() for i in ids])})."))
        return problems

    def _verify_completeness(self, rows: Sequence[sqlite3.Row], problems: List[Problem]) -> None:
        ok_ids = [row["item_id"] for row in rows if row["status"] == "ok"]
        ok_set = set(ok_ids)
        pillars = self._pillars_by_item()
        unsearchable = [item_id for item_id in ok_ids if not any(p in pillars.get(item_id, ()) for p in CORE_PILLARS)]
        if unsearchable:
            problems.append(Problem("warning", "not-searchable", f"{_plural(len(unsearchable), 'item')} {'has' if len(unsearchable) == 1 else 'have'} no dino, siglip or colour "
                                    f"vector ({_sample(unsearchable)}); {'it' if len(unsearchable) == 1 else 'they'} cannot be searched and will be left out."))
        orphans = sorted({row["item_id"] for row in self._query("SELECT item_id FROM embeddings")} - {row["item_id"] for row in rows})
        if orphans:
            problems.append(Problem("warning", "orphan-vectors", f"{_plural(len(orphans), 'item')} {'has' if len(orphans) == 1 else 'have'} vectors but no row in the items table "
                                    f"({_sample(orphans)}); they are ignored."))
        failed: Dict[str, List[str]] = defaultdict(list)
        for row in self._query("SELECT item_id, pillar, error FROM feature_errors ORDER BY pillar, item_id"):
            if row["item_id"] in ok_set:
                failed[row["pillar"]].append(row["item_id"])
        for pillar, ids in sorted(failed.items()):
            problems.append(Problem("warning", "feature-errors", f"The '{pillar}' vectors failed for {_plural(len(ids), 'item')} ({_sample(ids)}); "
                                    f"{'it' if len(ids) == 1 else 'they'} will have no '{pillar}' signal in search."))
        captions = self._captions()
        no_caption = [item_id for item_id in ok_ids if captions.get(item_id) is None]
        bad_caption = [item_id for item_id in ok_ids if captions.get(item_id) is not None and (captions[item_id]["status"] != "ok" or captions[item_id]["profile"] is None)]
        if no_caption or bad_caption:
            ids = no_caption + bad_caption
            problems.append(Problem("warning", "captions", f"{_plural(len(ids), 'item')} {'has' if len(ids) == 1 else 'have'} no usable description from the captioning step "
                                    f"({_sample(ids)}); {'it' if len(ids) == 1 else 'they'} will have no category, finish or text vector."))
        caption_versions = {captions[item_id]["version"] for item_id in ok_ids if captions.get(item_id) and captions[item_id]["status"] == "ok"}
        if len(caption_versions) > 1:
            problems.append(Problem("warning", "caption-versions", f"The descriptions were written by {len(caption_versions)} different caption versions ({sorted(map(str, caption_versions))})."))
        pages_not_done = [f"page {row['page_number']}" for row in self._query("SELECT page_number FROM pages WHERE status != 'done' ORDER BY pdf_sha256, page_number")]
        if pages_not_done:
            problems.append(Problem("warning", "pages", f"{_plural(len(pages_not_done), 'page')} did not finish extraction ({_sample(pages_not_done)}); "
                                    "items from those pages are missing."))
        pdfs_not_done = [display_name(row["source_pdf"]) for row in self._query("SELECT source_pdf FROM pdfs WHERE status != 'done'")]
        if pdfs_not_done:
            problems.append(Problem("warning", "pdfs", f"{_plural(len(pdfs_not_done), 'PDF')} not marked finished ({_sample(pdfs_not_done)})."))

    # --------------------------------------------------------------------------------------------------------------------- describe
    def describe(self) -> Dict[str, Any]:
        """What was found, for `import-bundle --explain`."""
        items = list(self.items(only_ok=False))
        styles: Dict[str, int] = defaultdict(int)
        for item in items:
            styles[self.path_style(item.crop_filepath)] += 1
        pillars: Dict[str, Dict[str, Any]] = {}
        for row in self._query("SELECT e.pillar, e.feature_version, e.dim, COUNT(*) AS n FROM embeddings e JOIN items i ON i.item_id = e.item_id "
                               "WHERE i.status = 'ok' GROUP BY e.pillar, e.feature_version, e.dim ORDER BY e.pillar"):
            pillars.setdefault(row["pillar"], {"versions": [], "dims": [], "count": 0})
            entry = pillars[row["pillar"]]
            entry["versions"].append(row["feature_version"])
            entry["dims"].append(int(row["dim"]))
            entry["count"] += int(row["n"])
        return {
            "state_file": str(self.state_source), "folder": str(self.root), "items": len(items), "items_ok": sum(1 for item in items if item.status == "ok"),
            "crop_path_styles": dict(styles), "crops_found": sum(1 for item in items if item.crop_path is not None),
            "pdfs": self.pdfs(), "pages": len(self.pages()), "pages_done": sum(1 for page in self.pages() if page["status"] == "done"),
            "unmatched_product_ids": self.unmatched_count(), "pillars": pillars,
            "captions_ok": sum(1 for item in items if item.caption and item.caption["status"] == "ok"),
            "has_wal_file": Path(str(self.state_source) + "-wal").is_file(),
        }
