"""Deterministic PDF page / crop / product-ID extraction with spatial backtracking, and the lineage check that proves a crop still matches its page.

# Ported from terucon-cat-1.ipynb (cell 3). Definitions are copied verbatim except where marked "PORT:".
No import-time side effects. The bundle layout this module writes: crops/<pdfstem>_<sha8>/<item_id>.png under cfg.work_dir, and the
crop path stored in items.crop_filepath is RELATIVE to cfg.work_dir (see features.crop_path_for_storage); items.source_pdf is the PDF's file
name. A photo is extracted by wrapping it as a one-page PDF first (photos.py), so there is exactly one extractor.
"""
from __future__ import annotations

import json
import math
import re
import time
import traceback
from dataclasses import dataclass
from pathlib import Path
from typing import List

import cv2
import numpy as np

try:
    import pymupdf as fitz  # PyMuPDF >= 1.24.3 (the legacy 'fitz' name is deprecated in 2.x)
except ImportError:  # pragma: no cover
    import fitz
from scipy.optimize import linear_sum_assignment

from .features import crop_path_for_storage, resolve_crop_path
from .util import LOGGER, atomic_write_bytes, encode_rgb, sha256_bytes, sha256_file


ID_STRIP_CHARACTERS = " \t\r\n:;,.()[]{}<>\"'|*#•·"


@dataclass
class IdCandidate:
    text: str
    raw_text: str
    rect: fitz.Rect


@dataclass
class ImageRegion:
    rect: fitz.Rect
    xrefs: List[int]
    native_pixels_per_point: float
    method: str


@dataclass
class IdMatch:
    candidate_index: int
    cost: float
    relation: str
    match_type: str


@dataclass
class PageResult:
    pdf_sha256: str
    source_pdf: str
    page_number: int
    original_rotation: int
    page_width: float
    page_height: float
    extraction_method: str
    n_image_regions: int
    n_id_candidates: int
    items: List[dict]
    orphans: List[dict]
    debug: dict


def rect_to_list(rect):
    return [round(float(rect.x0), 3), round(float(rect.y0), 3), round(float(rect.x1), 3), round(float(rect.y1), 3)]


def overlap_length(start_a, end_a, start_b, end_b):
    return max(0.0, min(end_a, end_b) - max(start_a, start_b))


def pixmap_to_rgb(pixmap):
    buffer = np.frombuffer(pixmap.samples, dtype=np.uint8)
    rows = buffer.reshape(pixmap.height, pixmap.stride)[:, : pixmap.width * pixmap.n]
    array = rows.reshape(pixmap.height, pixmap.width, pixmap.n)
    if pixmap.n == 1:
        array = np.repeat(array, 3, axis=2)
    elif pixmap.n == 4:
        array = array[:, :, :3]
    return np.ascontiguousarray(array)


def merge_overlapping_regions(regions, tolerance):
    """Union image boxes that overlap or touch (PDF generators often slice one photo into strips)."""
    pending = list(regions)
    changed = True
    while changed:
        changed = False
        merged = []
        while pending:
            current = pending.pop(0)
            index = 0
            while index < len(pending):
                other = pending[index]
                expanded = fitz.Rect(current.rect.x0 - tolerance, current.rect.y0 - tolerance,
                                     current.rect.x1 + tolerance, current.rect.y1 + tolerance)
                if expanded.intersects(other.rect):
                    current = ImageRegion(rect=current.rect | other.rect,
                                          xrefs=current.xrefs + other.xrefs,
                                          native_pixels_per_point=max(current.native_pixels_per_point,
                                                                      other.native_pixels_per_point),
                                          method=current.method)
                    pending.pop(index)
                    changed = True
                    index = 0
                else:
                    index += 1
            merged.append(current)
        pending = merged
    return pending


def reset_mupdf_cache():
    """MuPDF caches decoded images; a clip rendered after a full-page render at another zoom can differ by
    one intensity level. Emptying the store makes every crop render independent of history (bit-reproducible)."""
    store_shrink = getattr(fitz.TOOLS, "store_shrink", None)
    if callable(store_shrink):
        store_shrink(100)


def safe_name(text, limit=60):
    return re.sub(r"[^A-Za-z0-9._-]+", "_", text)[:limit].strip("_") or "pdf"


class CatalogueExtractor:
    def __init__(self, cfg, store, on_pdf_complete=None, on_page=None):  # PORT: on_page is new, see _page_hook
        self.cfg = cfg
        self.store = store
        self.on_pdf_complete = on_pdf_complete
        self.on_page = on_page
        self.id_pattern = re.compile(cfg.product_id_regex)
        self.prefix_pattern = re.compile(cfg.product_id_label_prefix_regex, re.IGNORECASE)
        self.year_pattern = re.compile(r"(?:19|20)\d{2}")
        self.stopwords = set(word.upper() for word in cfg.id_stopwords)

    # ------------------------------------------------------------ driver
    # PORT: cfg.pdf_path is gone (the notebook's Kaggle input); the caller names the PDF, or a folder of PDFs as before.
    def discover_pdfs(self, pdf_source):
        pdf_source = Path(pdf_source)
        if not pdf_source.exists():
            LOGGER.warning("PDF path %s does not exist.", pdf_source)
            return []
        if pdf_source.is_file():
            return [pdf_source]
        found = []
        for path in sorted(pdf_source.rglob("*")):
            if path.is_file() and path.suffix.lower() == ".pdf":
                found.append(path)
        return found

    # PORT: run() takes the paths (file or folder); `force_segmentation` lists the paths that are photos of several swatches.
    def run(self, pdf_paths, force_segmentation=()):
        forced = {Path(path).resolve() for path in force_segmentation}
        found = []
        for source in pdf_paths:
            found.extend(self.discover_pdfs(source))
        pdf_paths = found
        LOGGER.info("Extraction: %d PDF(s) found", len(pdf_paths))
        for pdf_path in pdf_paths:
            self.process_pdf(pdf_path, force_segmentation=Path(pdf_path).resolve() in forced)  # PORT: new argument
            if self.on_pdf_complete is not None:
                self.on_pdf_complete()
        return self.store.summary()

    def _xref_page_frequency(self, document):
        frequency = {}
        for page_index in range(document.page_count):
            page = document.load_page(page_index)
            seen_on_page = set()
            for info in page.get_image_info(xrefs=True):
                xref = int(info.get("xref", 0) or 0)
                if xref:
                    seen_on_page.add(xref)
            for xref in seen_on_page:
                frequency[xref] = frequency.get(xref, 0) + 1
        return frequency

    # PORT: force_segmentation and display_name are new (photos); `source_pdf` is now the file NAME, not an absolute path.
    def process_pdf(self, pdf_path, force_segmentation=False, display_name=None):
        pdf_path = Path(pdf_path)
        source_name = display_name or pdf_path.name
        pdf_sha256 = sha256_file(pdf_path)
        file_size = pdf_path.stat().st_size
        existing = self.store.get_pdf(pdf_sha256)
        if existing is not None and existing["status"] == "done":
            LOGGER.info("Skip %s (already extracted, sha=%s)", pdf_path.name, pdf_sha256[:12])
            return
        try:
            document = fitz.open(str(pdf_path))
        except Exception as exc:
            self.store.upsert_pdf(pdf_sha256, source_name, file_size, 0, "error", repr(exc))  # PORT: file name
            LOGGER.error("Cannot open %s: %s", pdf_path, exc)
            return
        with document:
            if document.needs_pass:
                self.store.upsert_pdf(pdf_sha256, source_name, file_size, 0, "error", "password protected")  # PORT: file name
                LOGGER.error("%s is password protected; skipping.", pdf_path.name)
                return
            page_count = document.page_count
            self.store.upsert_pdf(pdf_sha256, source_name, file_size, page_count, "in_progress")  # PORT: file name
            page_states = self.store.page_states(pdf_sha256)
            xref_frequency = self._xref_page_frequency(document) if page_count >= 4 else {}
            started = time.time()
            processed = 0
            for page_index in range(page_count):
                page_number = page_index + 1
                state = page_states.get(page_number)
                if state is not None and state["status"] == "done":
                    self._page_hook(source_name, page_number, page_count)  # PORT: progress for pages that are already finished
                    continue
                if state is not None and state["status"] == "error" and state["attempts"] >= self.cfg.page_max_attempts:
                    self._page_hook(source_name, page_number, page_count)  # PORT
                    continue
                try:
                    result = self._process_page(document, page_index, pdf_path, pdf_sha256, xref_frequency,
                                                source_name, force_segmentation)  # PORT: two new arguments
                    self.store.commit_page_result(result)
                    processed += 1
                except Exception:
                    error_text = traceback.format_exc()
                    LOGGER.error("Page %d of %s failed:\n%s", page_number, pdf_path.name, error_text[-800:])
                    self.store.mark_page_error(pdf_sha256, page_number, source_name, error_text)
                # PORT: new hook, deliberately OUTSIDE the try above: a Cancelled raised by it must not be recorded as a page error
                self._page_hook(source_name, page_number, page_count)
            final_states = self.store.page_states(pdf_sha256)
            finished_pages = sum(1 for state in final_states.values() if state["status"] == "done")
            status = "done" if finished_pages == page_count else "partial"
            self.store.upsert_pdf(pdf_sha256, source_name, file_size, page_count, status)  # PORT: file name
            LOGGER.info("%s: %d/%d pages done (%d processed now, %.1fs) -> %s", pdf_path.name, finished_pages,
                        page_count, processed, time.time() - started, status)

    # PORT: new. Progress and cancellation: called after every page (committed or failed), never inside the per-page try.
    def _page_hook(self, source_name, page_number, page_count):
        if self.on_page is not None:
            self.on_page(source_name, page_number, page_count)

    # ------------------------------------------------------------ page
    def _process_page(self, document, page_index, pdf_path, pdf_sha256, xref_frequency, source_name=None,
                      force_segmentation=False):  # PORT: source_name / force_segmentation are new
        page_number = page_index + 1
        source_name = source_name or Path(pdf_path).name
        page = document.load_page(page_index)
        original_rotation = int(page.rotation)
        if original_rotation:
            page.remove_rotation()  # normalise so every bbox lives in one upright coordinate system
        page_rect = page.rect
        words = page.get_text("words", sort=True)
        candidates = self._find_id_candidates(words)
        regions, method = self._find_image_regions(page, page_rect, words, xref_frequency, document.page_count,
                                                   len(candidates), force_segmentation)  # PORT: force_segmentation
        regions = self._sort_reading_order(regions)
        matches = self._assign_ids(regions, candidates, page_rect)

        crop_directory = self.cfg.crops_dir / f"{safe_name(pdf_path.stem)}_{pdf_sha256[:8]}"
        extension = "jpg" if self.cfg.crop_image_format.lower() in ("jpg", "jpeg") else "png"
        items = []
        used_candidates = set()
        reset_mupdf_cache()
        for item_index, region in enumerate(regions):
            # Snap the box to the stored precision first, so re-rendering from the manifest is bit-identical.
            region.rect = fitz.Rect(rect_to_list(region.rect))
            zoom = self._choose_zoom(region)
            rgb = self._render_clip(page, region.rect, zoom)
            inpainted = False
            if self.cfg.inpaint_overlay_text:
                rgb, inpainted = self._inpaint_overlay_text(rgb, region.rect, zoom, words)
            encoded = encode_rgb(rgb, self.cfg.crop_image_format)
            item_id = f"{pdf_sha256[:12]}-p{page_number:04d}-i{item_index:02d}"
            crop_path = crop_directory / f"{item_id}.{extension}"
            atomic_write_bytes(crop_path, encoded)

            match = matches.get(item_index)
            product_id = None
            product_id_raw = None
            id_bbox = None
            match_type = "none"
            match_relation = None
            match_cost = None
            if match is not None:
                candidate = candidates[match.candidate_index]
                product_id = candidate.text
                product_id_raw = candidate.raw_text
                id_bbox = rect_to_list(candidate.rect)
                match_type = match.match_type
                match_relation = match.relation
                match_cost = round(float(match.cost), 6)
                used_candidates.add(match.candidate_index)
            items.append({
                "item_id": item_id, "product_id": product_id, "product_id_raw": product_id_raw,
                "source_pdf": source_name, "pdf_sha256": pdf_sha256, "page_number": page_number,
                "item_index": item_index, "image_bbox": rect_to_list(region.rect), "id_bbox": id_bbox,
                "page_width": float(page_rect.width), "page_height": float(page_rect.height),
                "original_rotation": original_rotation,
                "crop_filepath": crop_path_for_storage(self.cfg.work_dir, crop_path),  # PORT: relative to work_dir, posix
                "crop_width": int(rgb.shape[1]), "crop_height": int(rgb.shape[0]), "render_zoom": float(zoom),
                "sha256_hash": sha256_bytes(encoded), "match_type": match_type, "match_relation": match_relation,
                "match_cost": match_cost, "extraction_method": region.method, "image_xrefs": region.xrefs,
                "inpainted_overlay": inpainted,
            })

        orphans = []
        for candidate_index, candidate in enumerate(candidates):
            if candidate_index not in used_candidates:
                orphans.append({"product_id": candidate.text, "id_bbox": rect_to_list(candidate.rect)})
        debug = {
            "candidates": [{"text": candidate.text, "bbox": rect_to_list(candidate.rect)} for candidate in candidates],
            "regions": [{"bbox": rect_to_list(region.rect), "method": region.method, "xrefs": region.xrefs}
                        for region in regions],
        }
        return PageResult(pdf_sha256=pdf_sha256, source_pdf=source_name, page_number=page_number,  # PORT: file name
                          original_rotation=original_rotation, page_width=float(page_rect.width),
                          page_height=float(page_rect.height), extraction_method=method,
                          n_image_regions=len(regions), n_id_candidates=len(candidates), items=items,
                          orphans=orphans, debug=debug)

    # ------------------------------------------------------------ product IDs
    def _find_id_candidates(self, words):
        candidates = []
        seen = set()
        for word in words:
            raw_text = word[4]
            token = raw_text.strip(ID_STRIP_CHARACTERS)
            token = self.prefix_pattern.sub("", token).strip(ID_STRIP_CHARACTERS)
            if not token or token.upper() in self.stopwords:
                continue
            if not self.id_pattern.fullmatch(token):
                continue
            digit_count = sum(1 for character in token if character.isdigit())
            letter_count = sum(1 for character in token if character.isalpha())
            if digit_count == 0:
                continue
            if letter_count == 0:
                if len(token) < self.cfg.min_numeric_id_length:
                    continue  # page numbers, quantities
                if self.cfg.reject_year_like_ids and self.year_pattern.fullmatch(token):
                    continue
            text = token.upper() if self.cfg.uppercase_product_ids else token
            rect = fitz.Rect(word[0], word[1], word[2], word[3])
            key = (text, round(rect.x0, 1), round(rect.y0, 1))
            if key in seen:
                continue  # some PDFs draw text twice for faux-bold
            seen.add(key)
            candidates.append(IdCandidate(text=text, raw_text=raw_text, rect=rect))
        return candidates

    # ------------------------------------------------------------ image regions
    def _find_image_regions(self, page, page_rect, words, xref_frequency, page_count, candidate_count,
                            force_segmentation=False):  # PORT: force_segmentation is new
        page_area = max(page_rect.width * page_rect.height, 1e-6)
        raw_regions = []
        rejected_rects = []  # logos/decorations: also hidden from the raster fallback below
        for info in page.get_image_info(xrefs=True):
            bbox = fitz.Rect(info["bbox"])
            if bbox.is_empty or bbox.is_infinite:
                continue
            clipped = bbox & page_rect
            if clipped.is_empty:
                continue
            if clipped.width < self.cfg.min_image_side_pt or clipped.height < self.cfg.min_image_side_pt:
                rejected_rects.append(clipped)
                continue
            if clipped.get_area() / page_area < self.cfg.min_image_area_fraction:
                rejected_rects.append(clipped)
                continue
            xref = int(info.get("xref", 0) or 0)
            if xref and page_count >= 4:
                if xref_frequency.get(xref, 0) / float(page_count) >= self.cfg.repeated_image_page_fraction:
                    rejected_rects.append(clipped)
                    continue  # logo / watermark / background repeated on most pages
            pixels_per_point = max(float(info.get("width", 0)) / max(bbox.width, 1e-6),
                                   float(info.get("height", 0)) / max(bbox.height, 1e-6))
            raw_regions.append(ImageRegion(rect=clipped, xrefs=[xref] if xref else [],
                                           native_pixels_per_point=pixels_per_point, method="embedded_image"))
        regions = merge_overlapping_regions(raw_regions, self.cfg.merge_tolerance_pt)

        # PORT: new. The caller says this page is a PHOTO of several swatches (there is no text to hint at a grid), so the render is
        # segmented even without ID candidates, with the same function the flattened-scan branch below uses and, like that branch, with the
        # embedded image's own pixels-per-point (0.0 would drop every crop to the 200 dpi floor, about two thirds of a 300 dpi photo's
        # resolution). If nothing is found the normal logic runs and the photo stays one item.
        if force_segmentation and regions:
            native = max(region.native_pixels_per_point for region in regions)
            segmented = self._segment_regions_from_render(page, page_rect, words, native, rejected_rects)
            if segmented:
                return segmented, "raster_segmentation_forced"

        # A single page-sized raster plus several IDs = a flattened/scanned grid -> split it visually.
        if len(regions) == 1 and candidate_count >= 2:
            if regions[0].rect.get_area() / page_area >= self.cfg.flattened_page_area_fraction:
                segmented = self._segment_regions_from_render(page, page_rect, words,
                                                              regions[0].native_pixels_per_point, rejected_rects)
                if len(segmented) >= 2:
                    return segmented, "raster_segmentation_flattened"
        if not regions and self.cfg.enable_raster_segmentation_fallback:
            segmented = self._segment_regions_from_render(page, page_rect, words, 0.0, rejected_rects)
            return segmented, "raster_segmentation"
        return regions, "embedded_image"

    def _segment_regions_from_render(self, page, page_rect, words, fallback_pixels_per_point, rejected_rects):
        zoom = self.cfg.segmentation_dpi / 72.0
        rgb = pixmap_to_rgb(page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), alpha=False, colorspace=fitz.csRGB))
        height, width = rgb.shape[:2]
        border = np.concatenate([rgb[:3].reshape(-1, 3), rgb[-3:].reshape(-1, 3),
                                 rgb[:, :3].reshape(-1, 3), rgb[:, -3:].reshape(-1, 3)])
        background = np.median(border, axis=0).astype(np.int16)
        difference = np.abs(rgb.astype(np.int16) - background).max(axis=2)
        mask = (difference > self.cfg.segmentation_background_threshold).astype(np.uint8) * 255
        hidden_boxes = [(word[0], word[1], word[2], word[3]) for word in words]
        hidden_boxes.extend((rect.x0, rect.y0, rect.x1, rect.y1) for rect in rejected_rects)
        for box in hidden_boxes:
            x0 = max(0, int(box[0] * zoom) - 2)
            y0 = max(0, int(box[1] * zoom) - 2)
            x1 = min(width, int(math.ceil(box[2] * zoom)) + 2)
            y1 = min(height, int(math.ceil(box[3] * zoom)) + 2)
            mask[y0:y1, x0:x1] = 0
        kernel_size = max(3, int(round(min(height, width) * 0.012)))
        kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (kernel_size, kernel_size))
        mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel)
        mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel)
        contour_result = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        contours = contour_result[0] if len(contour_result) == 2 else contour_result[1]
        page_area = max(page_rect.width * page_rect.height, 1e-6)
        regions = []
        for contour in contours:
            x, y, box_width, box_height = cv2.boundingRect(contour)
            fill_ratio = cv2.contourArea(contour) / max(float(box_width * box_height), 1.0)
            if fill_ratio < 0.5:
                continue
            rect = fitz.Rect(x / zoom, y / zoom, (x + box_width) / zoom, (y + box_height) / zoom) & page_rect
            if rect.width < self.cfg.min_image_side_pt or rect.height < self.cfg.min_image_side_pt:
                continue
            if rect.get_area() / page_area < self.cfg.min_image_area_fraction:
                continue
            regions.append(ImageRegion(rect=rect, xrefs=[], native_pixels_per_point=fallback_pixels_per_point,
                                       method="raster_segmentation"))
        return merge_overlapping_regions(regions, self.cfg.merge_tolerance_pt)

    @staticmethod
    def _sort_reading_order(regions):
        ordered_by_top = sorted(regions, key=lambda region: (region.rect.y0, region.rect.x0))
        rows = []
        for region in ordered_by_top:
            center_y = (region.rect.y0 + region.rect.y1) / 2.0
            if rows:
                current_row = rows[-1]
                row_center = float(np.mean([(member.rect.y0 + member.rect.y1) / 2.0 for member in current_row]))
                row_height = min(member.rect.height for member in current_row)
                if abs(center_y - row_center) <= 0.5 * min(region.rect.height, row_height):
                    current_row.append(region)
                    continue
            rows.append([region])
        ordered = []
        for row in rows:
            ordered.extend(sorted(row, key=lambda region: region.rect.x0))
        return ordered

    # ------------------------------------------------------------ spatial matching
    def _pair_cost(self, image_rect, id_rect, page_diagonal):
        dx = max(image_rect.x0 - id_rect.x1, id_rect.x0 - image_rect.x1, 0.0)
        dy = max(image_rect.y0 - id_rect.y1, id_rect.y0 - image_rect.y1, 0.0)
        gap = math.hypot(dx, dy)
        center_x = (id_rect.x0 + id_rect.x1) / 2.0
        center_y = (id_rect.y0 + id_rect.y1) / 2.0
        tolerance = 0.25 * id_rect.height
        base = 0.0
        inside_x = image_rect.x0 <= center_x <= image_rect.x1
        inside_y = image_rect.y0 <= center_y <= image_rect.y1
        if inside_x and inside_y:
            relation = "inside"   # label printed over the photo; usually hugs an edge
            base = 0.25 * min(center_y - image_rect.y0, image_rect.y1 - center_y)
        elif id_rect.y0 >= image_rect.y1 - tolerance:
            relation = "below"
        elif id_rect.y1 <= image_rect.y0 + tolerance:
            relation = "above"
        else:
            relation = "side"
        if relation in ("below", "above"):
            coverage = overlap_length(image_rect.x0, image_rect.x1, id_rect.x0, id_rect.x1) / max(id_rect.width, 1e-6)
            alignment = 1.0 + self.cfg.alignment_penalty * (1.0 - min(coverage, 1.0))
        elif relation == "side":
            coverage = overlap_length(image_rect.y0, image_rect.y1, id_rect.y0, id_rect.y1) / max(id_rect.height, 1e-6)
            alignment = 1.0 + self.cfg.alignment_penalty * (1.0 - min(coverage, 1.0))
        else:
            alignment = 1.0
        cost = (gap + base + 1.0) * self.cfg.direction_weights[relation] * alignment / page_diagonal
        return cost, relation

    def _assign_ids(self, regions, candidates, page_rect):
        """Global 1:1 assignment (Hungarian) of image boxes to ID boxes by directional proximity."""
        if not regions or not candidates:
            return {}
        page_diagonal = math.hypot(page_rect.width, page_rect.height)
        cost_matrix = np.zeros((len(regions), len(candidates)), dtype=np.float64)
        relations = [[None] * len(candidates) for _ in regions]
        for region_index, region in enumerate(regions):
            for candidate_index, candidate in enumerate(candidates):
                cost, relation = self._pair_cost(region.rect, candidate.rect, page_diagonal)
                cost_matrix[region_index, candidate_index] = cost
                relations[region_index][candidate_index] = relation
        matches = {}
        if len(regions) == 1:
            # Full-page single product: any ID on the page belongs to it; take the closest.
            best = int(np.argmin(cost_matrix[0]))
            matches[0] = IdMatch(best, float(cost_matrix[0, best]), relations[0][best], "single_image")
            return matches
        row_indices, column_indices = linear_sum_assignment(cost_matrix)
        for region_index, candidate_index in zip(row_indices, column_indices):
            cost = float(cost_matrix[region_index, candidate_index])
            if cost <= self.cfg.max_match_cost:
                matches[int(region_index)] = IdMatch(int(candidate_index), cost,
                                                     relations[region_index][candidate_index], "hungarian")
        if self.cfg.allow_shared_ids:
            for region_index in range(len(regions)):
                if region_index in matches:
                    continue
                best = int(np.argmin(cost_matrix[region_index]))
                cost = float(cost_matrix[region_index, best])
                if cost <= self.cfg.max_match_cost * self.cfg.shared_id_cost_factor:
                    matches[region_index] = IdMatch(best, cost, relations[region_index][best], "shared")
        return matches

    # ------------------------------------------------------------ rendering
    def _choose_zoom(self, region):
        minimum_zoom = self.cfg.min_render_dpi / 72.0
        maximum_zoom = self.cfg.max_render_dpi / 72.0
        target = region.native_pixels_per_point if region.native_pixels_per_point > 0 else minimum_zoom
        zoom = min(max(target, minimum_zoom), maximum_zoom)
        longest_side_pt = max(region.rect.width, region.rect.height)
        if longest_side_pt * zoom > self.cfg.crop_max_side_px:
            zoom = self.cfg.crop_max_side_px / longest_side_pt
        return float(zoom)

    @staticmethod
    def _render_clip(page, rect, zoom):
        pixmap = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), clip=rect, alpha=False, colorspace=fitz.csRGB)
        return pixmap_to_rgb(pixmap)

    def _inpaint_overlay_text(self, rgb, region_rect, zoom, words):
        """Remove text drawn over a photo (overlay labels) so it does not pollute the texture features."""
        height, width = rgb.shape[:2]
        mask = np.zeros((height, width), dtype=np.uint8)
        for word in words:
            word_rect = fitz.Rect(word[0], word[1], word[2], word[3])
            overlap = word_rect & region_rect
            if overlap.is_empty or overlap.get_area() < 0.5 * max(word_rect.get_area(), 1e-6):
                continue
            padding = max(2, int(round(0.15 * word_rect.height * zoom)))
            x0 = max(0, int(math.floor((word_rect.x0 - region_rect.x0) * zoom)) - padding)
            y0 = max(0, int(math.floor((word_rect.y0 - region_rect.y0) * zoom)) - padding)
            x1 = min(width, int(math.ceil((word_rect.x1 - region_rect.x0) * zoom)) + padding)
            y1 = min(height, int(math.ceil((word_rect.y1 - region_rect.y0) * zoom)) + padding)
            if x1 > x0 and y1 > y0:
                mask[y0:y1, x0:x1] = 255
        covered_fraction = float(mask.mean()) / 255.0
        if covered_fraction == 0.0 or covered_fraction > self.cfg.inpaint_max_area_fraction:
            return rgb, False
        radius = max(3, int(round(3 * zoom)))
        bgr = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
        restored = cv2.inpaint(bgr, mask, radius, cv2.INPAINT_TELEA)
        return cv2.cvtColor(restored, cv2.COLOR_BGR2RGB), True


class LineageTracer:
    """Answer 'where did this result come from?' and prove the crop still matches its PDF page."""

    def __init__(self, cfg, store, extractor, pdf_dirs=()):  # PORT: pdf_dirs is new (the notebook stored absolute PDF paths)
        self.cfg = cfg
        self.store = store
        self.extractor = extractor
        self.pdf_dirs = [Path(directory) for directory in pdf_dirs]

    def lineage(self, item_id):
        row = self.store.get_item(item_id)
        if row is None:
            raise KeyError(item_id)
        row["image_bbox"] = json.loads(row["image_bbox"])
        row["id_bbox"] = json.loads(row["id_bbox"]) if row["id_bbox"] else None
        return row

    # PORT: new. items.source_pdf is a file NAME now, so the PDF is found by name and checked by sha256 in the directories we were given;
    # a legacy absolute path that still exists is tried first. A file with the right name but the wrong content is returned only if no
    # file with the right content exists, so verify() can say "the PDF changed".
    def resolve_pdf(self, row):
        stored = Path(row["source_pdf"])
        named = []
        if stored.is_absolute() and stored.is_file():
            named.append(stored)
        for directory in self.pdf_dirs:
            if (directory / stored.name).is_file():
                named.append(directory / stored.name)
        for path in named:
            if sha256_file(path) == row["pdf_sha256"]:
                return path
        for directory in self.pdf_dirs:
            if directory.is_dir():
                for path in sorted(directory.rglob("*.pdf")):
                    if path.is_file() and path not in named and sha256_file(path) == row["pdf_sha256"]:
                        return path
        return named[0] if named else None

    def _open_page(self, row):
        pdf_path = self.resolve_pdf(row)  # PORT: the PDF is looked up by name / sha256 (see resolve_pdf)
        if pdf_path is None:
            raise FileNotFoundError(f"The PDF {row['source_pdf']!r} (sha256 {row['pdf_sha256'][:12]}) was not found in {[str(d) for d in self.pdf_dirs]}.")
        document = fitz.open(str(pdf_path))
        page = document.load_page(int(row["page_number"]) - 1)
        if page.rotation:
            page.remove_rotation()
        return document, page

    def verify(self, item_id):
        row = self.lineage(item_id)
        report = {"item_id": item_id, "product_id": row["product_id"], "source_pdf": row["source_pdf"],
                  "page_number": row["page_number"], "stored_sha256": row["sha256_hash"]}
        pdf_path = self.resolve_pdf(row)  # PORT: the PDF is looked up (see resolve_pdf); "pdf_found" is a new key
        report["pdf_found"] = pdf_path is not None
        report["pdf_sha256_matches"] = pdf_path is not None and sha256_file(pdf_path) == row["pdf_sha256"]
        crop_path = resolve_crop_path(self.cfg.work_dir, row["crop_filepath"])  # PORT: relative to work_dir
        report["crop_file_present"] = crop_path.exists()
        report["crop_file_sha256_matches"] = crop_path.exists() and sha256_file(crop_path) == row["sha256_hash"]
        if pdf_path is None:  # PORT: nothing to re-render from
            report["rerendered_sha256_matches"] = False
            return report
        document, page = self._open_page(row)
        with document:
            reset_mupdf_cache()
            rect = fitz.Rect(row["image_bbox"])
            zoom = float(row["render_zoom"])
            rgb = self.extractor._render_clip(page, rect, zoom)
            if row["inpainted_overlay"]:
                words = page.get_text("words", sort=True)
                rgb, _ = self.extractor._inpaint_overlay_text(rgb, rect, zoom, words)
            rerendered_sha = sha256_bytes(encode_rgb(rgb, self.cfg.crop_image_format))
        report["rerendered_sha256_matches"] = rerendered_sha == row["sha256_hash"]
        return report

    def draw_provenance(self, item_id, zoom=1.5):
        """PNG of the source page with the image box (green) and its ID box (red)."""
        row = self.lineage(item_id)
        document, page = self._open_page(row)
        with document:
            page.draw_rect(fitz.Rect(row["image_bbox"]), color=(0.0, 0.75, 0.2), width=2.5)
            if row["id_bbox"]:
                page.draw_rect(fitz.Rect(row["id_bbox"]), color=(0.9, 0.1, 0.1), width=2.0)
            rgb = pixmap_to_rgb(page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), alpha=False, colorspace=fitz.csRGB))
        output_path = self.cfg.backtrace_dir / f"{item_id}_provenance.png"
        atomic_write_bytes(output_path, encode_rgb(rgb, "png"))
        return output_path
