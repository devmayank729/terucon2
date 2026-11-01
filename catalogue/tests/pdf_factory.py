"""Synthetic catalogue PDFs (built with PyMuPDF) for the extractor, photo and pipeline tests.

Every picture is a real embedded raster (so it has an xref, like the pictures in a real catalogue); the swatches are distinct noisy gradients so no
two of them share image bytes. Each builder writes one PDF and returns a dict of the facts the tests assert on (what is on the page, where, and
what the extractor should make of it), so the expectations do not come from running the extractor.

    grid_with_labels      a text-layer grid of swatches with an ID under each, one shared ID (two views, one code) and one orphan ID
    real_catalogue_like   what the owner's real 69-page PDF looks like: ONE picture covering ~95 % of the page, NO text layer, label as pixels
    flattened_scan        one page-size raster of a 2x2 grid of swatches + two or more ID texts
    logo_on_every_page    the same logo image (same xref) on every page
    overlay_text          an ID drawn over a photo
    touching_strips       one picture sliced into strips that touch (or nearly)
    vector_swatches       coloured rectangles drawn as vector graphics, no embedded pictures at all
    swatches_photo        (an array, not a PDF) a photo of 2x2 swatches on a plain background
"""
from __future__ import annotations

import io
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw
import pymupdf as fitz

PAGE_W, PAGE_H = 595.0, 842.0   # A4 in points, the size of the owner's catalogue pages


def png_bytes(array):
    buffer = io.BytesIO()
    Image.fromarray(np.asarray(array, dtype=np.uint8)).save(buffer, format="PNG")
    return buffer.getvalue()


def swatch_array(seed, width=240, height=240):
    """A saturated, textured, non-white swatch that is different for every seed (a gradient plus noise)."""
    rng = np.random.default_rng(seed)
    hue = (seed * 37 + 11) % 180
    base = cv2.cvtColor(np.uint8([[[hue, 200, 150]]]), cv2.COLOR_HSV2RGB)[0, 0].astype(np.float32)
    y, x = np.mgrid[0:height, 0:width].astype(np.float32)
    shade = 35.0 * (x / max(width - 1, 1) - 0.5) + 25.0 * (y / max(height - 1, 1) - 0.5)
    noise = rng.integers(-14, 15, (height, width, 3)).astype(np.float32)
    return np.clip(base[None, None, :] + shade[:, :, None] + noise, 0, 255).astype(np.uint8)


def _label(page, text, center_x, baseline_y, size=10.0):
    width = fitz.get_text_length(text, fontname="helv", fontsize=size)
    page.insert_text((center_x - width / 2.0, baseline_y), text, fontsize=size, fontname="helv", color=(0, 0, 0))


def _save(doc, path):
    doc.save(str(path), garbage=3, deflate=True, no_new_id=True)
    doc.close()
    return Path(path)


def grid_with_labels(path, rotation=0):
    """(i) Two pages with a text layer.
    Page 1: a 3x2 grid of pictures with a printed code under each, plus a seventh code alone at the bottom of the page that belongs to no picture
    (more codes than pictures, so the extractor must leave one code over: an orphan).
    Page 2: one picture with its code, and two VIEWS of one product: two pictures, ONE code centred under both, nearer the first
    (more pictures than codes, so the second view reuses the code: match type 'shared')."""
    doc = fitz.open()
    seed = 1
    page = doc.new_page(width=PAGE_W, height=PAGE_H)
    page_one = []
    for row_y, codes in ((80.0, ("SB101", "SB102", "SB103")), (300.0, ("SB104", "SB105", "SB106"))):
        for column_x, code in zip((60.0, 240.0, 420.0), codes):
            rect = fitz.Rect(column_x, row_y, column_x + 120, row_y + 120)
            page.insert_image(rect, stream=png_bytes(swatch_array(seed, 160, 160)))
            _label(page, code, rect.x0 + 60, rect.y1 + 18)
            page_one.append({"code": code, "rect": rect, "match": "hungarian"})
            seed += 1
    _label(page, "SB999", 90.0, 800)   # nothing is near it: an orphan
    if rotation:
        page.set_rotation(rotation)

    page = doc.new_page(width=PAGE_W, height=PAGE_H)
    single = fitz.Rect(60, 100, 180, 220)
    page.insert_image(single, stream=png_bytes(swatch_array(seed, 160, 160)))
    seed += 1
    _label(page, "SB107", 120.0, 238)
    view_a, view_b = fitz.Rect(240, 100, 340, 200), fitz.Rect(350, 100, 450, 200)
    for view in (view_a, view_b):
        page.insert_image(view, stream=png_bytes(swatch_array(seed, 130, 130)))
        seed += 1
    _label(page, "SB108", 328.0, 218)
    page_two = [{"code": "SB107", "rect": single, "match": "hungarian"},
                {"code": "SB108", "rect": view_a, "match": "hungarian"},
                {"code": "SB108", "rect": view_b, "match": "shared"}]
    if rotation:
        page.set_rotation(rotation)
    out = _save(doc, path)
    return {"path": out, "pages": 2, "page_items": {1: page_one, 2: page_two}, "orphans": {1: ["SB999"], 2: []}, "rotation": rotation}


def real_catalogue_like(path, pages=5, label_prefix="SB8"):
    """(ii) The owner's real catalogue: every page is ONE picture covering ~95 % of the page (the box [26.833, 15, 568.166, 827] in the real
    file), the code and name are PRINTED INTO THE PICTURE, and there is no text layer at all. Expect: one item per page, no product id."""
    doc = fitz.open()
    box = fitz.Rect(26.833, 15.0, 568.166, 827.0)
    for number in range(pages):
        page = doc.new_page(width=PAGE_W, height=PAGE_H)
        picture = Image.fromarray(swatch_array(100 + number, 360, 540))
        draw = ImageDraw.Draw(picture)
        draw.rectangle([0, 500, 359, 539], fill=(255, 255, 255))
        draw.text((10, 508), f"{label_prefix}{number:02d} EMPEROR DARK", fill=(0, 0, 0))
        buffer = io.BytesIO()
        picture.save(buffer, format="PNG")
        page.insert_image(box, stream=buffer.getvalue())
    out = _save(doc, path)
    return {"path": out, "pages": pages, "box": [26.833, 15.0, 568.166, 827.0]}


def flattened_scan(path):
    """(iii) a scanned page: one raster as big as the page holding a 2x2 grid of swatches on white paper, and the codes as text."""
    scale = 2   # raster pixels per point
    raster = np.full((int(PAGE_H * scale), int(PAGE_W * scale), 3), 255, dtype=np.uint8)
    rects = [fitz.Rect(80, 100, 260, 280), fitz.Rect(335, 100, 515, 280), fitz.Rect(80, 400, 260, 580), fitz.Rect(335, 400, 515, 580)]
    for number, rect in enumerate(rects):
        block = swatch_array(200 + number, int(rect.width * scale), int(rect.height * scale))
        raster[int(rect.y0 * scale):int(rect.y1 * scale), int(rect.x0 * scale):int(rect.x1 * scale)] = block
    doc = fitz.open()
    page = doc.new_page(width=PAGE_W, height=PAGE_H)
    page.insert_image(page.rect, stream=png_bytes(raster))
    codes = ["SB201", "SB202", "SB203", "SB204"]
    for rect, code in zip(rects, codes):
        _label(page, code, (rect.x0 + rect.x1) / 2.0, rect.y1 + 18)
    out = _save(doc, path)
    return {"path": out, "pages": 1, "rects": rects, "codes": codes}


def logo_on_every_page(path, pages=5):
    """(v) the same logo (one xref) in the corner of every page, next to one swatch with its code. With >= 4 pages the logo is dropped."""
    doc = fitz.open()
    logo = np.zeros((60, 90, 3), dtype=np.uint8)
    logo[:] = (20, 40, 160)
    logo[10:50, 10:80] = (240, 200, 30)
    logo_xref = 0
    swatch_xrefs = []
    for number in range(pages):
        page = doc.new_page(width=PAGE_W, height=PAGE_H)
        if logo_xref:
            page.insert_image(fitz.Rect(480, 20, 570, 80), xref=logo_xref)
        else:
            logo_xref = page.insert_image(fitz.Rect(480, 20, 570, 80), stream=png_bytes(logo))
        rect = fitz.Rect(150, 200, 400, 450)
        swatch_xrefs.append(page.insert_image(rect, stream=png_bytes(swatch_array(300 + number, 200, 200))))
        _label(page, f"SB3{number:02d}", 275.0, 470)
    out = _save(doc, path)
    return {"path": out, "pages": pages, "logo_xref": logo_xref, "swatch_xrefs": swatch_xrefs}


def overlay_text(path):
    """(vi) one big photo with its code printed OVER it (inside the picture), small enough to be inpainted."""
    doc = fitz.open()
    page = doc.new_page(width=PAGE_W, height=PAGE_H)
    rect = fitz.Rect(100, 150, 500, 600)
    page.insert_image(rect, stream=png_bytes(swatch_array(400, 400, 450)))
    page.insert_text((130, 560), "SB400", fontsize=14, fontname="helv", color=(1, 1, 1))
    out = _save(doc, path)
    return {"path": out, "pages": 1, "rect": rect, "code": "SB400"}


def touching_strips(path):
    """(vii) a picture sliced into horizontal strips (a PDF generator's habit): one set touches exactly, another is 1 pt apart (inside the 1.5 pt
    tolerance); a third picture is 10 pt away from its neighbour and must stay separate."""
    doc = fitz.open()
    page = doc.new_page(width=PAGE_W, height=PAGE_H)
    seed = 500
    rects = []
    for top in (100.0, 220.0, 340.0):   # touching: 3 strips of 120 pt
        rect = fitz.Rect(60, top, 200, top + 120)
        rects.append(rect)
        page.insert_image(rect, stream=png_bytes(swatch_array(seed, 140, 120)))
        seed += 1
    near = []
    for top in (100.0, 221.0):          # 1 pt gap
        rect = fitz.Rect(300, top, 440, top + 120)
        near.append(rect)
        page.insert_image(rect, stream=png_bytes(swatch_array(seed, 140, 120)))
        seed += 1
    far = []
    for top in (500.0, 630.0):          # 10 pt gap: two separate pictures
        rect = fitz.Rect(300, top, 440, top + 120)
        far.append(rect)
        page.insert_image(rect, stream=png_bytes(swatch_array(seed, 140, 120)))
        seed += 1
    _label(page, "SB500", 130.0, 480)
    out = _save(doc, path)
    return {"path": out, "pages": 1, "touching": rects, "near": near, "far": far}


def vector_swatches(path):
    """(viii) no embedded pictures: flat colour rectangles drawn as vector graphics with a code under each. The extractor has to render the
    page and find them (method raster_segmentation)."""
    doc = fitz.open()
    page = doc.new_page(width=PAGE_W, height=PAGE_H)
    rects = [fitz.Rect(70, 100, 230, 260), fitz.Rect(330, 100, 490, 260)]
    colours = [(0.8, 0.2, 0.2), (0.1, 0.4, 0.8)]
    codes = ["SB601", "SB602"]
    for rect, colour, code in zip(rects, colours, codes):
        page.draw_rect(rect, color=None, fill=colour)
        _label(page, code, (rect.x0 + rect.x1) / 2.0, rect.y1 + 18)
    out = _save(doc, path)
    return {"path": out, "pages": 1, "rects": rects, "codes": codes}


def swatches_photo(width=1200, height=900, seed=0):
    """A 'photo' of four swatches on a plain light background (2x2). Returns (array, [(x0, y0, x1, y1) in pixels])."""
    background = (236, 232, 224)
    photo = np.empty((height, width, 3), dtype=np.uint8)
    photo[:] = background
    boxes = []
    for number, (x0, y0) in enumerate(((90, 90), (690, 90), (90, 490), (690, 490))):
        x1, y1 = x0 + 420, y0 + 320
        photo[y0:y1, x0:x1] = swatch_array(seed + 10 * number + 3, x1 - x0, y1 - y0)
        boxes.append((x0, y0, x1, y1))
    return photo, boxes
