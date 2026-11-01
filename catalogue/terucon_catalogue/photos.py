"""Photos as catalogue pages.

The real catalogue is a PDF whose pages are ONE picture each (no text layer), so a photographed page, or a photo of a single swatch, is the same
thing: this module wraps a photo as a ONE-page PDF whose only content is that picture, and the one extractor (extract.py) does the rest. A photo that
shows SEVERAL swatches is extracted with `force_segmentation` (the notebook's render-segmentation path, forced even though there is no text): see
segment_photo_regions() and pipeline.run_compute(segment_photos=...).

PORT: new in this package (nothing here is in the notebook).

Facts this relies on, each verified against PyMuPDF 2.0 and the notebook's extractor (tests/test_photos.py):
* The photo is treated as 300 dpi, so the page is pixels * 72 / 300 points. The extractor's zoom is the picture's own pixels per point
  (300 / 72 = 4.1667, inside the 200..600 dpi band), so a photo whose long side is at most `cfg.crop_max_side_px` (1536) comes out 1:1, pixel for
  pixel; a bigger photo is scaled down to 1536 px on its long side, which is exactly what the notebook does to a big page. Nothing is upscaled.
* The extractor ignores pictures under `min_image_side_pt` (36 pt = 150 px at 300 dpi): a smaller photo would give NO item, so it is refused here.
* The PDF bytes are reproducible: no /ID, no dates, no producer-time fields (Document.write(no_new_id=True, reproducible=True)), so wrapping the
  same photo twice gives the same file and therefore the same item ids (they hash the PDF). Reproducible within one PyMuPDF/Pillow build; a
  different build may write different bytes (the PDF says which MuPDF wrote it), so keep the wrapped PDF as the source and do not re-wrap it
  later with another build.
* The EXIF orientation is applied (the photo is decoded with util.load_rgb) before it is put on the page, so a phone photo is upright.
* The picture is embedded losslessly (Flate), which makes a big file (a 12 MP photo -> about 30 MB of PDF). Smaller would mean JPEG pass-through,
  which this does not do: its decoder differs from Pillow's and EXIF would have to be handled separately.
No import-time side effects.
"""
from __future__ import annotations

import tempfile
from pathlib import Path

from .util import IMAGE_EXTENSIONS, atomic_write_bytes, encode_rgb, load_rgb

PHOTO_DPI = 300.0
MAX_PAGE_POINTS = 14400.0   # the PDF page size limit (200 inches)


class PhotoTooSmall(ValueError):
    """The photo would be a page the extractor ignores (a side under min_image_side_pt)."""


def wrap_photo_as_pdf(image_path, out_pdf, *, dpi=PHOTO_DPI, min_side_pt=36.0):
    """Write `out_pdf`: one page, exactly the photo's size at `dpi`, whose only content is the photo. Returns the path. Byte-reproducible."""
    try:
        import pymupdf as fitz
    except ImportError:  # pragma: no cover
        import fitz
    rgb = load_rgb(image_path)                         # EXIF orientation applied, RGB, uint8
    height, width = rgb.shape[:2]
    page_width, page_height = width * 72.0 / dpi, height * 72.0 / dpi
    if min(page_width, page_height) < min_side_pt:
        raise PhotoTooSmall(f"The photo is {width} x {height} px, which is a page of {page_width:.1f} x {page_height:.1f} pt at {dpi:g} dpi; the "
                            f"extractor ignores pictures with a side under {min_side_pt:g} pt ({int(round(min_side_pt * dpi / 72.0))} px). "
                            "Use a larger photo.")
    if max(page_width, page_height) > MAX_PAGE_POINTS:
        raise ValueError(f"The photo is {width} x {height} px, more than one PDF page can hold at {dpi:g} dpi ({MAX_PAGE_POINTS:g} pt).")
    png = encode_rgb(rgb, "png")
    document = fitz.open()
    try:
        page = document.new_page(width=page_width, height=page_height)
        page.insert_image(page.rect, stream=png)
        data = document.write(garbage=3, deflate=True, no_new_id=True, reproducible=True)
    finally:
        document.close()
    atomic_write_bytes(out_pdf, data)
    return Path(out_pdf)


def segment_photo_regions(source, cfg=None):
    """What forced segmentation would turn into items, without extracting anything: (regions in reading order, page-level method).

    `source` is a photo (wrapped in a temporary PDF) or a PDF (its first page). The method is "raster_segmentation_forced" when the render was
    segmented, or "embedded_image" when nothing was found and the whole picture stays one item. Each region is an extract.ImageRegion (rect in
    points; native_pixels_per_point is the picture's own density, so the crops keep the photo's resolution).
    """
    try:
        import pymupdf as fitz
    except ImportError:  # pragma: no cover
        import fitz
    from .config import PipelineConfig
    from .extract import CatalogueExtractor

    cfg = cfg if cfg is not None else PipelineConfig()
    source = Path(source)
    with tempfile.TemporaryDirectory(prefix="photo-regions-") as scratch:
        pdf = source
        if source.suffix.lower() in IMAGE_EXTENSIONS:
            pdf = wrap_photo_as_pdf(source, Path(scratch) / "photo.pdf")
        with fitz.open(str(pdf)) as document:
            page = document.load_page(0)
            if page.rotation:
                page.remove_rotation()
            words = page.get_text("words", sort=True)
            extractor = CatalogueExtractor(cfg, None)
            regions, method = extractor._find_image_regions(page, page.rect, words, {}, document.page_count, 0, True)
            return extractor._sort_reading_order(regions), method
