"""Cut the swatch pictures of the catalogue PDF for the shop (one JPEG per product id) and write the shop's data file.

    python -I catalogue/tools/make_shop_images.py "<path to Superbond colour image.pdf>"

Needs PyMuPDF and Pillow (pip install pymupdf pillow); run it with -I so nothing next to it is imported. It reads catalogue/data/superbond-colour-ids.json (the
page -> printed code table), takes the first page of every product, cuts the swatch rectangle (the printed label and the white margin are left out), scales it
to 800 px wide, writes media/materials/tipl-<code>.jpg and catalogue/data/superbond-colour-shop.json (id, code, printed name, pages, picture, mean colour).

The swatch rectangle is the same on every page of this PDF within 2 pt (measured on all 68: about x 71..525, y 59..750 of a 595 x 842 pt page); the crop is
inset 3 pt on every side so no edge of the page shows. The mean colour is the plain average of the swatch's pixels (what the shop calls a finish's 'reference
colour'). Nothing here is read from the Gemini descriptions in the database: those were found unreliable (most designs are called 'laminate').
"""
import io
import json
import sys
from pathlib import Path

import pymupdf
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
TABLE = ROOT / "catalogue" / "data" / "superbond-colour-ids.json"
OUT_DATA = ROOT / "catalogue" / "data" / "superbond-colour-shop.json"
OUT_DIR = ROOT / "media" / "materials"
CLIP = pymupdf.Rect(74, 63, 522, 746)
WIDTH = 800


def main(pdf_path: str) -> None:
    table = json.loads(TABLE.read_text(encoding="utf-8"))
    prefix = table["prefix"]
    pages_of = {}
    for page, entry in sorted(table["pages"].items(), key=lambda kv: int(kv[0])):
        if entry.get("code"):
            pages_of.setdefault(entry["code"], []).append(int(page))
    names = {e["code"]: e["printedName"] for e in table["pages"].values() if e.get("code")}
    doc = pymupdf.open(pdf_path)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    products = []
    for code, pages in sorted(pages_of.items(), key=lambda kv: kv[1][0]):
        page = pages[0]
        pix = doc[page - 1].get_pixmap(dpi=150, clip=CLIP)
        image = Image.open(io.BytesIO(pix.tobytes("png"))).convert("RGB")
        height = round(image.height * WIDTH / image.width)
        image = image.resize((WIDTH, height), Image.LANCZOS)
        small = image.resize((1, 1), Image.BOX).getpixel((0, 0))
        name = f"tipl-{code.lower()}"
        image.save(OUT_DIR / f"{name}.jpg", "JPEG", quality=74, optimize=True, progressive=True)
        products.append({"id": f"{prefix}{code}", "code": code, "printedName": names[code], "pages": pages, "image": f"media/materials/{name}.jpg",
                         "width": WIDTH, "height": height, "meanHex": "#%02x%02x%02x" % small})
    OUT_DATA.write_text(json.dumps({"_comment": "Written by catalogue/tools/make_shop_images.py from the id table and the PDF. Do not edit by hand.", "catalogue": table["catalogue"],
                                    "products": products}, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    print(len(products), "products,", sum(p.stat().st_size for p in OUT_DIR.glob("tipl-*.jpg")) // 1024, "KB of pictures")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    main(sys.argv[1])
