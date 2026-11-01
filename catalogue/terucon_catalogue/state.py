"""The SQLite state store: the lineage record of an ingest run, and the thing that makes every stage resumable.

# Ported from terucon-cat-1.ipynb (cell 2). Definitions are copied verbatim except where marked "PORT:".
A run's work_dir (state.sqlite + crops/) is the "bundle" that the publisher turns into MongoDB documents, GCS objects and a search
release. The schema is the notebook's, unchanged, so a bundle written on Kaggle opens here and the other way round.
PORT: query_df / catalog_frame / export_manifest (pandas, parquet) are gone; snapshot_to() and close() are new.
"""
from __future__ import annotations

import contextlib
import json
import os
import sqlite3
import threading
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import numpy as np

from .util import utc_now_iso


@dataclass
class EmbeddingRow:
    item_id: str
    pillar: str
    feature_version: str
    vector: np.ndarray
    extra: Optional[dict] = None


class StateStore:
    """SQLite is the source of truth for lineage + resume; parquet files are exports of it."""

    SCHEMA = """
    CREATE TABLE IF NOT EXISTS pdfs (
        pdf_sha256 TEXT PRIMARY KEY, source_pdf TEXT NOT NULL, file_size INTEGER, page_count INTEGER,
        status TEXT NOT NULL, error TEXT, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS pages (
        pdf_sha256 TEXT NOT NULL, page_number INTEGER NOT NULL, source_pdf TEXT NOT NULL,
        status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, original_rotation INTEGER,
        page_width REAL, page_height REAL, extraction_method TEXT, n_image_regions INTEGER,
        n_id_candidates INTEGER, n_items INTEGER, debug_json TEXT, error TEXT, updated_at TEXT NOT NULL,
        PRIMARY KEY (pdf_sha256, page_number));
    CREATE TABLE IF NOT EXISTS items (
        item_id TEXT PRIMARY KEY, product_id TEXT, product_id_raw TEXT, source_pdf TEXT NOT NULL,
        pdf_sha256 TEXT NOT NULL, page_number INTEGER NOT NULL, item_index INTEGER NOT NULL,
        image_bbox TEXT NOT NULL, id_bbox TEXT, page_width REAL, page_height REAL, original_rotation INTEGER,
        crop_filepath TEXT NOT NULL, crop_width INTEGER, crop_height INTEGER, render_zoom REAL,
        sha256_hash TEXT NOT NULL, match_type TEXT, match_relation TEXT, match_cost REAL,
        extraction_method TEXT, image_xrefs TEXT, inpainted_overlay INTEGER, status TEXT NOT NULL,
        created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_items_page ON items(pdf_sha256, page_number);
    CREATE INDEX IF NOT EXISTS idx_items_product ON items(product_id);
    CREATE INDEX IF NOT EXISTS idx_items_sha ON items(sha256_hash);
    CREATE TABLE IF NOT EXISTS orphan_ids (
        pdf_sha256 TEXT NOT NULL, page_number INTEGER NOT NULL, product_id TEXT NOT NULL, id_bbox TEXT NOT NULL,
        PRIMARY KEY (pdf_sha256, page_number, product_id, id_bbox));
    CREATE TABLE IF NOT EXISTS embeddings (
        item_id TEXT NOT NULL, pillar TEXT NOT NULL, feature_version TEXT NOT NULL, dim INTEGER NOT NULL,
        dtype TEXT NOT NULL, vector BLOB NOT NULL, extra_json TEXT, updated_at TEXT NOT NULL,
        PRIMARY KEY (item_id, pillar));
    CREATE TABLE IF NOT EXISTS feature_errors (
        item_id TEXT NOT NULL, pillar TEXT NOT NULL, attempts INTEGER NOT NULL, error TEXT,
        updated_at TEXT NOT NULL, PRIMARY KEY (item_id, pillar));
    CREATE TABLE IF NOT EXISTS captions (
        item_id TEXT PRIMARY KEY, caption_version TEXT, model TEXT, status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0, profile_json TEXT, search_text TEXT, error TEXT,
        updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS renders (
        render_id TEXT PRIMARY KEY, item_id TEXT, product_id TEXT, model TEXT, scene_path TEXT,
        output_path TEXT, metadata_path TEXT, prompt TEXT, created_at TEXT NOT NULL);
    """

    def __init__(self, db_path):
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        # isolation_level=None -> explicit BEGIN/COMMIT in transaction(); autocommit otherwise.
        self.connection = sqlite3.connect(str(self.db_path), check_same_thread=False, timeout=60,
                                          isolation_level=None)
        self.connection.row_factory = sqlite3.Row
        with self._lock:
            self.connection.execute("PRAGMA journal_mode=WAL")
            self.connection.execute("PRAGMA synchronous=NORMAL")
            self.connection.executescript(self.SCHEMA)

    @contextlib.contextmanager
    def transaction(self):
        with self._lock:
            self.connection.execute("BEGIN IMMEDIATE")
            try:
                yield self.connection
            except BaseException:
                self.connection.execute("ROLLBACK")
                raise
            self.connection.execute("COMMIT")

    def query(self, sql, parameters=()):
        with self._lock:
            return self.connection.execute(sql, parameters).fetchall()


    # ------------------------------------------------------------ PDFs / pages
    def get_pdf(self, pdf_sha256):
        rows = self.query("SELECT * FROM pdfs WHERE pdf_sha256 = ?", (pdf_sha256,))
        return rows[0] if rows else None

    def upsert_pdf(self, pdf_sha256, source_pdf, file_size, page_count, status, error=None):
        with self.transaction() as connection:
            connection.execute(
                "INSERT OR REPLACE INTO pdfs (pdf_sha256, source_pdf, file_size, page_count, status, error, updated_at)"
                " VALUES (?, ?, ?, ?, ?, ?, ?)",
                (pdf_sha256, source_pdf, file_size, page_count, status, error, utc_now_iso()))

    def page_states(self, pdf_sha256):
        rows = self.query("SELECT page_number, status, attempts FROM pages WHERE pdf_sha256 = ?", (pdf_sha256,))
        states = {}
        for row in rows:
            states[int(row["page_number"])] = {"status": row["status"], "attempts": int(row["attempts"])}
        return states

    def commit_page_result(self, page_result):
        """Items + orphans + page status in ONE transaction: a page is either fully recorded or not at all."""
        now = utc_now_iso()
        with self.transaction() as connection:
            previous_rows = connection.execute(
                "SELECT item_id, sha256_hash FROM items WHERE pdf_sha256 = ? AND page_number = ?",
                (page_result.pdf_sha256, page_result.page_number)).fetchall()
            new_hashes = {}
            for item in page_result.items:
                new_hashes[item["item_id"]] = item["sha256_hash"]
            for previous in previous_rows:
                previous_id = previous["item_id"]
                connection.execute("DELETE FROM items WHERE item_id = ?", (previous_id,))
                if new_hashes.get(previous_id) != previous["sha256_hash"]:
                    for table_name in ("embeddings", "captions", "feature_errors"):
                        connection.execute(f"DELETE FROM {table_name} WHERE item_id = ?", (previous_id,))
            for item in page_result.items:
                connection.execute(
                    "INSERT INTO items (item_id, product_id, product_id_raw, source_pdf, pdf_sha256, page_number,"
                    " item_index, image_bbox, id_bbox, page_width, page_height, original_rotation, crop_filepath,"
                    " crop_width, crop_height, render_zoom, sha256_hash, match_type, match_relation, match_cost,"
                    " extraction_method, image_xrefs, inpainted_overlay, status, created_at)"
                    " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (item["item_id"], item["product_id"], item["product_id_raw"], item["source_pdf"],
                     item["pdf_sha256"], item["page_number"], item["item_index"], json.dumps(item["image_bbox"]),
                     json.dumps(item["id_bbox"]) if item["id_bbox"] is not None else None,
                     item["page_width"], item["page_height"], item["original_rotation"], item["crop_filepath"],
                     item["crop_width"], item["crop_height"], item["render_zoom"], item["sha256_hash"],
                     item["match_type"], item["match_relation"], item["match_cost"], item["extraction_method"],
                     json.dumps(item["image_xrefs"]), int(item["inpainted_overlay"]), "ok", now))
            connection.execute("DELETE FROM orphan_ids WHERE pdf_sha256 = ? AND page_number = ?",
                               (page_result.pdf_sha256, page_result.page_number))
            for orphan in page_result.orphans:
                connection.execute(
                    "INSERT OR IGNORE INTO orphan_ids (pdf_sha256, page_number, product_id, id_bbox) VALUES (?, ?, ?, ?)",
                    (page_result.pdf_sha256, page_result.page_number, orphan["product_id"],
                     json.dumps(orphan["id_bbox"])))
            connection.execute(
                "INSERT OR REPLACE INTO pages (pdf_sha256, page_number, source_pdf, status, attempts,"
                " original_rotation, page_width, page_height, extraction_method, n_image_regions, n_id_candidates,"
                " n_items, debug_json, error, updated_at) VALUES (?, ?, ?, 'done',"
                " COALESCE((SELECT attempts FROM pages WHERE pdf_sha256 = ? AND page_number = ?), 0) + 1,"
                " ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)",
                (page_result.pdf_sha256, page_result.page_number, page_result.source_pdf,
                 page_result.pdf_sha256, page_result.page_number, page_result.original_rotation,
                 page_result.page_width, page_result.page_height, page_result.extraction_method,
                 page_result.n_image_regions, page_result.n_id_candidates, len(page_result.items),
                 json.dumps(page_result.debug), now))

    def mark_page_error(self, pdf_sha256, page_number, source_pdf, error_text):
        with self.transaction() as connection:
            connection.execute(
                "INSERT OR REPLACE INTO pages (pdf_sha256, page_number, source_pdf, status, attempts, error, updated_at)"
                " VALUES (?, ?, ?, 'error',"
                " COALESCE((SELECT attempts FROM pages WHERE pdf_sha256 = ? AND page_number = ?), 0) + 1, ?, ?)",
                (pdf_sha256, page_number, source_pdf, pdf_sha256, page_number, error_text[:4000], utc_now_iso()))

    def get_item(self, item_id):
        rows = self.query("SELECT * FROM items WHERE item_id = ?", (item_id,))
        return dict(rows[0]) if rows else None

    # ------------------------------------------------------------ embeddings
    def upsert_embeddings(self, rows):
        now = utc_now_iso()
        with self.transaction() as connection:
            for row in rows:
                vector = np.asarray(row.vector, dtype=np.float16).ravel()
                connection.execute(
                    "INSERT OR REPLACE INTO embeddings (item_id, pillar, feature_version, dim, dtype, vector,"
                    " extra_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                    (row.item_id, row.pillar, row.feature_version, int(vector.shape[0]), "float16",
                     vector.tobytes(), json.dumps(row.extra) if row.extra is not None else None, now))
                connection.execute("DELETE FROM feature_errors WHERE item_id = ? AND pillar = ?",
                                   (row.item_id, row.pillar))

    def record_feature_errors(self, errors, pillars):
        now = utc_now_iso()
        with self.transaction() as connection:
            for item_id, error_text in errors:
                for pillar in pillars:
                    connection.execute(
                        "INSERT OR REPLACE INTO feature_errors (item_id, pillar, attempts, error, updated_at)"
                        " VALUES (?, ?, COALESCE((SELECT attempts FROM feature_errors WHERE item_id = ?"
                        " AND pillar = ?), 0) + 1, ?, ?)",
                        (item_id, pillar, item_id, pillar, str(error_text)[:2000], now))

    def items_needing_pillars(self, versions, max_attempts):
        """Items whose vector for ANY of the given pillars is missing or from an older feature version."""
        items = self.query("SELECT item_id, crop_filepath FROM items WHERE status = 'ok' ORDER BY item_id")
        pillar_names = list(versions.keys())
        placeholders = ",".join(["?"] * len(pillar_names))
        done = set()
        for row in self.query(f"SELECT item_id, pillar, feature_version FROM embeddings WHERE pillar IN ({placeholders})",
                              tuple(pillar_names)):
            if versions.get(row["pillar"]) == row["feature_version"]:
                done.add((row["item_id"], row["pillar"]))
        error_attempts = {}
        for row in self.query(f"SELECT item_id, pillar, attempts FROM feature_errors WHERE pillar IN ({placeholders})",
                              tuple(pillar_names)):
            error_attempts[(row["item_id"], row["pillar"])] = int(row["attempts"])
        pending = []
        for row in items:
            for pillar in pillar_names:
                key = (row["item_id"], pillar)
                if key not in done and error_attempts.get(key, 0) < max_attempts:
                    pending.append((row["item_id"], row["crop_filepath"]))
                    break
        return pending

    def fetch_embeddings(self, pillar, feature_version):
        rows = self.query(
            "SELECT e.item_id, e.dim, e.dtype, e.vector FROM embeddings e JOIN items i ON i.item_id = e.item_id"
            " WHERE e.pillar = ? AND e.feature_version = ? AND i.status = 'ok' ORDER BY e.item_id",
            (pillar, feature_version))
        if not rows:
            return [], np.zeros((0, 0), dtype=np.float32)
        # PORT: pandas-free (was pd.Series(...).mode().iloc[0]); ties resolve to the smaller dimension like pandas' sorted mode
        _counts = Counter(int(row["dim"]) for row in rows)
        _best = max(_counts.values())
        expected_dim = min(dim for dim, count in _counts.items() if count == _best)
        item_ids = []
        vectors = []
        for row in rows:
            if int(row["dim"]) != expected_dim:
                continue
            item_ids.append(row["item_id"])
            vectors.append(np.frombuffer(row["vector"], dtype=np.dtype(row["dtype"])).astype(np.float32))
        matrix = l2_normalize_rows(np.stack(vectors))
        return item_ids, np.ascontiguousarray(matrix, dtype=np.float32)

    def color_meta_map(self, color_version):
        meta = {}
        for row in self.query("SELECT item_id, extra_json FROM embeddings WHERE pillar = 'color' AND feature_version = ?",
                              (color_version,)):
            if row["extra_json"]:
                meta[row["item_id"]] = json.loads(row["extra_json"])
        return meta

    # ------------------------------------------------------------ captions
    def pending_captions(self, caption_version, max_attempts):
        return self.query(
            "SELECT i.item_id, i.product_id, i.crop_filepath FROM items i LEFT JOIN captions c ON c.item_id = i.item_id"
            " WHERE i.status = 'ok' AND (c.item_id IS NULL OR c.caption_version IS NOT ?"
            " OR (c.status != 'ok' AND c.attempts < ?)) ORDER BY i.item_id",
            (caption_version, max_attempts))

    def save_captions(self, results):
        now = utc_now_iso()
        with self.transaction() as connection:
            for result in results:
                previous = connection.execute("SELECT caption_version, attempts FROM captions WHERE item_id = ?",
                                              (result.item_id,)).fetchone()
                attempts = 1
                if previous is not None and previous["caption_version"] == result.caption_version:
                    attempts = int(previous["attempts"]) + 1
                connection.execute(
                    "INSERT OR REPLACE INTO captions (item_id, caption_version, model, status, attempts, profile_json,"
                    " search_text, error, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (result.item_id, result.caption_version, result.model, result.status, attempts,
                     json.dumps(result.profile) if result.profile is not None else None, result.search_text,
                     result.error, now))

    def pending_text_embeddings(self, text_version, caption_version, max_attempts):
        return self.query(
            "SELECT c.item_id, c.search_text FROM captions c JOIN items i ON i.item_id = c.item_id"
            " LEFT JOIN embeddings e ON e.item_id = c.item_id AND e.pillar = 'text' AND e.feature_version = ?"
            " LEFT JOIN feature_errors fe ON fe.item_id = c.item_id AND fe.pillar = 'text'"
            " WHERE i.status = 'ok' AND c.status = 'ok' AND c.caption_version = ? AND e.item_id IS NULL"
            " AND (fe.attempts IS NULL OR fe.attempts < ?) ORDER BY c.item_id",
            (text_version, caption_version, max_attempts))

    def record_render(self, row):
        with self.transaction() as connection:
            connection.execute(
                "INSERT OR REPLACE INTO renders (render_id, item_id, product_id, model, scene_path, output_path,"
                " metadata_path, prompt, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (row["render_id"], row["item_id"], row["product_id"], row["model"], row["scene_path"],
                 row["output_path"], row["metadata_path"], row["prompt"], utc_now_iso()))

    # ------------------------------------------------------------ catalogue view + exports


    def summary(self):
        counts = {}
        for table_name in ("pdfs", "pages", "items", "captions", "embeddings", "feature_errors", "orphan_ids", "renders"):
            counts[table_name] = int(self.query(f"SELECT COUNT(*) AS n FROM {table_name}")[0]["n"])
        return counts

    # ------------------------------------------------------------ PORT: new
    def snapshot_to(self, destination):
        """A consistent single-file copy of the database (VACUUM INTO), for checkpoints and for the bundle that is published."""
        destination = Path(destination)
        destination.parent.mkdir(parents=True, exist_ok=True)
        if destination.exists():
            destination.unlink()
        with self._lock:
            self.connection.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            self.connection.execute("VACUUM INTO ?", (str(destination),))
        return destination

    def close(self):
        with self._lock:
            with contextlib.suppress(Exception):
                self.connection.close()
