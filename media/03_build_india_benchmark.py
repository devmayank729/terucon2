#!/usr/bin/env python3
"""Build a provenance-preserving SAM 3 benchmark manifest.

The script indexes one or more local Terucon folders and can download a large,
India-focused audit set from Wikimedia Commons. It does not scrape Google
Images. Every downloaded file has an author, license, source page and URL in
the manifest and attribution ledger.

Examples
--------
Index local images and download up to 2,000 licensed Commons images::

    python 03_build_india_benchmark.py \
      --local-root /kaggle/input/terucon-site-photos \
      --commons-target 2000 \
      --contact you@example.com \
      --output /kaggle/working/sam3_benchmark_data

Only index local images::

    python 03_build_india_benchmark.py \
      --local-root /kaggle/input/terucon-site-photos \
      --commons-target 0 \
      --output /kaggle/working/sam3_benchmark_data

Run the same command again to resume. Existing manifest entries and downloads
are retained and exact/near duplicates are skipped.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import html
import io
import json
import os
from pathlib import Path
import random
import re
import shutil
import tempfile
import time
from typing import Any, Iterable

from PIL import Image, ImageOps

try:
    import requests
except ImportError:  # Local-only indexing can still run without network extras.
    requests = None  # type: ignore[assignment]


COMMONS_API = "https://commons.wikimedia.org/w/api.php"
SUPPORTED_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".tif", ".tiff", ".bmp"}
MANIFEST_FIELDS = [
    "image_id",
    "local_path",
    "source",
    "source_page",
    "download_url",
    "license",
    "license_url",
    "author",
    "title",
    "query",
    "stratum",
    "region",
    "country",
    "split",
    "candidate_prompts",
    "expected_prompts",
    "width",
    "height",
    "sha256",
    "dhash",
    "notes",
]

# The strata intentionally span interiors, exterior facades, active
# construction, building types, climates and large Indian cities. These are
# discovery queries, not labels; the report keeps them separate from ground
# truth.
DEFAULT_QUERIES: list[tuple[str, str, str]] = [
    ("India office interior", "interior", "India"),
    ("India home interior", "interior", "India"),
    ("India apartment interior", "interior", "India"),
    ("India hotel interior", "interior", "India"),
    ("India hospital interior", "interior", "India"),
    ("India classroom interior", "interior", "India"),
    ("India restaurant interior", "interior", "India"),
    ("India shopping mall interior", "interior", "India"),
    ("India railway station interior", "interior", "India"),
    ("India airport terminal interior", "interior", "India"),
    ("India false ceiling", "interior", "India"),
    ("India flooring interior", "interior", "India"),
    ("India building corridor", "interior", "India"),
    ("India building facade", "exterior", "India"),
    ("India modern architecture facade", "exterior", "India"),
    ("India residential building exterior", "exterior", "India"),
    ("India apartment building exterior", "exterior", "India"),
    ("India office building exterior", "exterior", "India"),
    ("India commercial building exterior", "exterior", "India"),
    ("India hospital building exterior", "exterior", "India"),
    ("India school building exterior", "exterior", "India"),
    ("India hotel building exterior", "exterior", "India"),
    ("India shopfront", "exterior", "India"),
    ("India building under construction", "construction", "India"),
    ("India construction site building", "construction", "India"),
    ("India unfinished building interior", "construction", "India"),
    ("India renovation interior", "construction", "India"),
    ("Mumbai building facade", "exterior", "Mumbai"),
    ("Delhi building facade", "exterior", "Delhi"),
    ("Bengaluru building facade", "exterior", "Bengaluru"),
    ("Chennai building facade", "exterior", "Chennai"),
    ("Kolkata building facade", "exterior", "Kolkata"),
    ("Hyderabad building facade", "exterior", "Hyderabad"),
    ("Pune building facade", "exterior", "Pune"),
    ("Ahmedabad building facade", "exterior", "Ahmedabad"),
    ("Jaipur building facade", "exterior", "Jaipur"),
    ("Kochi building facade", "exterior", "Kochi"),
    ("Goa building interior", "interior", "Goa"),
    ("Guwahati building exterior", "exterior", "Guwahati"),
    ("Shimla building exterior", "exterior", "Shimla"),
    ('incategory:"Interiors of buildings in India"', "interior", "India"),
    ('incategory:"Buildings in India"', "exterior", "India"),
    ('incategory:"Construction in India"', "construction", "India"),
]

PROMPTS_BY_STRATUM = {
    "interior": "floor|wall|ceiling|false ceiling|window|door|furniture|person|plant",
    "exterior": "facade|window|door|person|plant",
    "construction": "floor|wall|ceiling|false ceiling|facade|window|door|person",
    "local": "floor|wall|ceiling|false ceiling|facade|window|door|furniture|person|plant",
}


def clean_text(value: Any) -> str:
    if value is None:
        return ""
    text = html.unescape(str(value))
    text = re.sub(r"<[^>]+>", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def sha256_file(path: Path, chunk_size: int = 4 * 1024 * 1024) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(chunk_size):
            digest.update(chunk)
    return digest.hexdigest()


def difference_hash(image: Image.Image) -> str:
    gray = ImageOps.exif_transpose(image).convert("L").resize((9, 8), Image.Resampling.LANCZOS)
    pixels = list(gray.getdata())
    bits = 0
    for row in range(8):
        for column in range(8):
            left = pixels[row * 9 + column]
            right = pixels[row * 9 + column + 1]
            bits = (bits << 1) | int(left > right)
    return f"{bits:016x}"


def hamming_hex(left: str, right: str) -> int:
    return (int(left, 16) ^ int(right, 16)).bit_count()


def inspect_image(path: Path, min_side: int) -> tuple[int, int, str]:
    with Image.open(path) as image:
        image.load()
        width, height = image.size
        if min(width, height) < min_side:
            raise ValueError(f"short side {min(width, height)} < {min_side}")
        return width, height, difference_hash(image)


def split_for(image_id: str) -> str:
    bucket = int(hashlib.sha256(image_id.encode("utf-8")).hexdigest()[:8], 16) % 100
    if bucket < 20:
        return "calibration"
    if bucket < 45:
        return "test"
    return "audit"


def load_manifest(path: Path) -> list[dict[str, str]]:
    if not path.is_file():
        return []
    with path.open(newline="", encoding="utf-8") as handle:
        return list(csv.DictReader(handle))


def write_manifest(rows: list[dict[str, Any]], path: Path) -> None:
    temp = path.with_suffix(".tmp")
    with temp.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=MANIFEST_FIELDS, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)
    os.replace(temp, path)


def is_license_allowed(short_name: str) -> bool:
    normalized = clean_text(short_name).lower().replace("-", " ")
    return (
        normalized.startswith("cc by")
        or normalized.startswith("cc0")
        or normalized.startswith("public domain")
        or normalized.startswith("public-domain")
        or normalized.startswith("pdm")
    )


def extmeta_value(metadata: dict[str, Any], key: str) -> str:
    value = metadata.get(key, {})
    return clean_text(value.get("value", "") if isinstance(value, dict) else value)


def discover_local_images(roots: Iterable[Path]) -> list[Path]:
    found: list[Path] = []
    for root in roots:
        root = root.expanduser().resolve()
        if root.is_file() and root.suffix.lower() in SUPPORTED_EXTENSIONS:
            found.append(root)
        elif root.is_dir():
            found.extend(
                candidate.resolve()
                for candidate in root.rglob("*")
                if candidate.is_file() and candidate.suffix.lower() in SUPPORTED_EXTENSIONS
            )
        else:
            print(f"WARNING: local root not found or unsupported: {root}")
    return sorted(set(found))


def parse_query_file(path: Path | None) -> list[tuple[str, str, str]]:
    if path is None:
        return DEFAULT_QUERIES
    queries: list[tuple[str, str, str]] = []
    with path.open(newline="", encoding="utf-8") as handle:
        reader = csv.DictReader(handle)
        required = {"query", "stratum", "region"}
        if not required.issubset(reader.fieldnames or []):
            raise ValueError(f"Query CSV must contain columns: {sorted(required)}")
        for row in reader:
            if row["query"].strip():
                queries.append((row["query"].strip(), row["stratum"].strip(), row["region"].strip()))
    return queries


class CommonsClient:
    def __init__(self, contact: str, delay_seconds: float) -> None:
        if requests is None:
            raise RuntimeError(
                "The 'requests' package is required for Commons downloads. "
                "Run script 01 again or install requests>=2.31."
            )
        self.session = requests.Session()
        contact_text = contact.strip() or "contact-not-provided"
        self.session.headers.update(
            {
                "User-Agent": (
                    f"TeruconSAM3BenchmarkBot/1.0 ({contact_text}; research benchmark) "
                    f"python-requests/{requests.__version__}"
                )
            }
        )
        self.delay_seconds = max(0.05, delay_seconds)

    def get(self, url: str, *, params: dict[str, Any] | None = None, stream: bool = False) -> requests.Response:
        last_error: Exception | None = None
        for attempt in range(6):
            try:
                response = self.session.get(url, params=params, timeout=(20, 90), stream=stream)
                if response.status_code in {429, 500, 502, 503, 504}:
                    retry_after = float(response.headers.get("Retry-After", 2**attempt))
                    time.sleep(min(60.0, max(1.0, retry_after)))
                    continue
                response.raise_for_status()
                time.sleep(self.delay_seconds)
                return response
            except requests.RequestException as exc:
                last_error = exc
                time.sleep(min(60.0, 2**attempt))
        raise RuntimeError(f"Request failed after retries: {url}: {last_error}")

    def search(self, query: str, thumb_width: int, limit: int) -> Iterable[dict[str, Any]]:
        continuation: dict[str, Any] = {}
        yielded = 0
        while yielded < limit:
            params: dict[str, Any] = {
                "action": "query",
                "generator": "search",
                "gsrsearch": query,
                "gsrnamespace": 6,
                "gsrlimit": min(50, limit - yielded),
                "prop": "imageinfo",
                "iiprop": "url|size|mime|extmetadata",
                "iiurlwidth": thumb_width,
                "format": "json",
                "formatversion": 2,
            }
            params.update(continuation)
            payload = self.get(COMMONS_API, params=params).json()
            pages = payload.get("query", {}).get("pages", [])
            if not pages:
                return
            for page in pages:
                yielded += 1
                yield page
                if yielded >= limit:
                    return
            continuation = payload.get("continue", {})
            if not continuation:
                return


def add_local_rows(
    rows: list[dict[str, Any]],
    roots: list[Path],
    min_side: int,
    known_sha: set[str],
    known_dhash: list[str],
    near_duplicate_distance: int,
) -> int:
    added = 0
    for index, path in enumerate(discover_local_images(roots), start=1):
        try:
            digest = sha256_file(path)
            if digest in known_sha:
                continue
            width, height, dhash = inspect_image(path, min_side)
            if any(hamming_hex(dhash, existing) <= near_duplicate_distance for existing in known_dhash):
                continue
            image_id = f"terucon_{digest[:20]}"
            rows.append(
                {
                    "image_id": image_id,
                    "local_path": str(path),
                    "source": "terucon_local",
                    "source_page": "",
                    "download_url": "",
                    "license": "private_user_supplied",
                    "license_url": "",
                    "author": "Terucon/user supplied",
                    "title": path.name,
                    "query": "local dataset",
                    "stratum": "local",
                    "region": "India_unspecified",
                    "country": "India",
                    "split": split_for(image_id),
                    "candidate_prompts": PROMPTS_BY_STRATUM["local"],
                    "expected_prompts": "",
                    "width": width,
                    "height": height,
                    "sha256": digest,
                    "dhash": dhash,
                    "notes": "Private local image; do not redistribute unless authorized.",
                }
            )
            known_sha.add(digest)
            known_dhash.append(dhash)
            added += 1
            if index % 100 == 0:
                print(f"Indexed {index} local candidates; accepted {added}", flush=True)
        except Exception as exc:
            print(f"SKIP local {path}: {exc}")
    return added


def download_commons_rows(
    rows: list[dict[str, Any]],
    client: CommonsClient,
    output: Path,
    queries: list[tuple[str, str, str]],
    target: int,
    max_per_query: int,
    thumb_width: int,
    min_side: int,
    max_bytes: int,
    known_sha: set[str],
    known_dhash: list[str],
    known_pages: set[str],
    near_duplicate_distance: int,
    seed: int,
) -> int:
    if target <= 0:
        return 0
    image_dir = output / "images" / "commons"
    image_dir.mkdir(parents=True, exist_ok=True)
    query_order = queries[:]
    random.Random(seed).shuffle(query_order)
    added = 0
    for query, stratum, region in query_order:
        if added >= target:
            break
        accepted_this_query = 0
        print(f"Commons query: {query!r} [{stratum}/{region}]", flush=True)
        try:
            candidates = client.search(query, thumb_width, max(max_per_query * 4, 100))
            for page in candidates:
                if added >= target or accepted_this_query >= max_per_query:
                    break
                infos = page.get("imageinfo", [])
                if not infos:
                    continue
                info = infos[0]
                metadata = info.get("extmetadata", {}) or {}
                license_name = extmeta_value(metadata, "LicenseShortName")
                if not is_license_allowed(license_name):
                    continue
                mime = str(info.get("mime", "")).lower()
                if mime not in {"image/jpeg", "image/png", "image/webp", "image/tiff"}:
                    continue
                source_page = str(info.get("descriptionurl", ""))
                if not source_page or source_page in known_pages:
                    continue
                download_url = str(info.get("thumburl") or info.get("url") or "")
                if not download_url:
                    continue
                suffix = {
                    "image/jpeg": ".jpg",
                    "image/png": ".png",
                    "image/webp": ".webp",
                    "image/tiff": ".tif",
                }[mime]
                temp_path: Path | None = None
                try:
                    with tempfile.NamedTemporaryFile(dir=output, suffix=suffix, delete=False) as temp:
                        temp_path = Path(temp.name)
                        response = client.get(download_url, stream=True)
                        downloaded = 0
                        for chunk in response.iter_content(1024 * 1024):
                            if not chunk:
                                continue
                            downloaded += len(chunk)
                            if downloaded > max_bytes:
                                raise ValueError(f"download exceeds {max_bytes} bytes")
                            temp.write(chunk)
                    digest = sha256_file(temp_path)
                    if digest in known_sha:
                        continue
                    width, height, dhash = inspect_image(temp_path, min_side)
                    if any(hamming_hex(dhash, existing) <= near_duplicate_distance for existing in known_dhash):
                        continue
                    page_id = str(page.get("pageid", "unknown"))
                    image_id = f"commons_{page_id}_{digest[:12]}"
                    final_path = image_dir / f"{image_id}{suffix}"
                    shutil.move(str(temp_path), final_path)
                    temp_path = None
                    author = extmeta_value(metadata, "Artist") or extmeta_value(metadata, "Credit")
                    title = clean_text(page.get("title", "")).removeprefix("File:")
                    license_url = extmeta_value(metadata, "LicenseUrl")
                    rows.append(
                        {
                            "image_id": image_id,
                            "local_path": str(final_path.resolve()),
                            "source": "wikimedia_commons",
                            "source_page": source_page,
                            "download_url": download_url,
                            "license": license_name,
                            "license_url": license_url,
                            "author": author,
                            "title": title,
                            "query": query,
                            "stratum": stratum,
                            "region": region,
                            "country": "India",
                            "split": split_for(image_id),
                            "candidate_prompts": PROMPTS_BY_STRATUM.get(stratum, ""),
                            "expected_prompts": "",
                            "width": width,
                            "height": height,
                            "sha256": digest,
                            "dhash": dhash,
                            "notes": "Search/query metadata is not ground truth; visually audit before training.",
                        }
                    )
                    known_sha.add(digest)
                    known_dhash.append(dhash)
                    known_pages.add(source_page)
                    added += 1
                    accepted_this_query += 1
                    print(f"  accepted {added}/{target}: {title}", flush=True)
                    write_manifest(rows, output / "manifest.csv")
                except Exception as exc:
                    print(f"  SKIP {source_page or page.get('title', '')}: {exc}")
                finally:
                    if temp_path is not None:
                        temp_path.unlink(missing_ok=True)
        except Exception as exc:
            print(f"WARNING: query failed {query!r}: {exc}")
    return added


def write_attribution(rows: list[dict[str, Any]], path: Path) -> None:
    fields = ["image_id", "title", "author", "license", "license_url", "source_page", "download_url"]
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        for row in rows:
            if row.get("source") == "wikimedia_commons":
                writer.writerow({field: row.get(field, "") for field in fields})


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--local-root", type=Path, action="append", default=[], help="Repeat for each local image folder.")
    parser.add_argument("--commons-target", type=int, default=2000, help="Licensed Commons images to add (default: 2000).")
    parser.add_argument("--output", type=Path, default=Path("/kaggle/working/sam3_benchmark_data"))
    parser.add_argument("--contact", default="", help="Email/URL included in the Wikimedia API User-Agent.")
    parser.add_argument("--queries-file", type=Path, default=None, help="Optional CSV with query,stratum,region columns.")
    parser.add_argument("--max-per-query", type=int, default=80)
    parser.add_argument("--thumb-width", type=int, default=1600)
    parser.add_argument("--min-side", type=int, default=640)
    parser.add_argument("--max-download-mib", type=int, default=30)
    parser.add_argument("--near-duplicate-distance", type=int, default=3, help="dHash Hamming distance; 0 disables near matching.")
    parser.add_argument("--delay-seconds", type=float, default=0.25)
    parser.add_argument("--seed", type=int, default=729)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if args.commons_target < 0:
        raise ValueError("--commons-target must be >= 0")
    output = args.output.expanduser().resolve()
    output.mkdir(parents=True, exist_ok=True)
    manifest_path = output / "manifest.csv"
    rows: list[dict[str, Any]] = load_manifest(manifest_path)
    known_sha = {row.get("sha256", "") for row in rows if row.get("sha256")}
    known_dhash = [row.get("dhash", "") for row in rows if row.get("dhash")]
    known_pages = {row.get("source_page", "") for row in rows if row.get("source_page")}

    local_added = add_local_rows(
        rows,
        args.local_root,
        args.min_side,
        known_sha,
        known_dhash,
        args.near_duplicate_distance,
    )
    write_manifest(rows, manifest_path)

    commons_existing = sum(row.get("source") == "wikimedia_commons" for row in rows)
    commons_needed = max(0, args.commons_target - commons_existing)
    commons_added = 0
    if commons_needed:
        if not args.contact:
            print(
                "WARNING: pass --contact you@example.com to comply with Wikimedia's preferred "
                "identifiable User-Agent format.",
                flush=True,
            )
        client = CommonsClient(args.contact, args.delay_seconds)
        commons_added = download_commons_rows(
            rows=rows,
            client=client,
            output=output,
            queries=parse_query_file(args.queries_file),
            target=commons_needed,
            max_per_query=args.max_per_query,
            thumb_width=args.thumb_width,
            min_side=args.min_side,
            max_bytes=args.max_download_mib * 1024 * 1024,
            known_sha=known_sha,
            known_dhash=known_dhash,
            known_pages=known_pages,
            near_duplicate_distance=args.near_duplicate_distance,
            seed=args.seed,
        )

    rows.sort(key=lambda row: (row.get("source", ""), row.get("image_id", "")))
    write_manifest(rows, manifest_path)
    write_attribution(rows, output / "ATTRIBUTION.csv")
    summary = {
        "manifest": str(manifest_path),
        "total_images": len(rows),
        "local_images": sum(row.get("source") == "terucon_local" for row in rows),
        "commons_images": sum(row.get("source") == "wikimedia_commons" for row in rows),
        "local_added_this_run": local_added,
        "commons_added_this_run": commons_added,
        "splits": {
            split: sum(row.get("split") == split for row in rows)
            for split in ("calibration", "test", "audit")
        },
        "warning": (
            "Search queries and candidate_prompts are discovery metadata, not labels. "
            "Do not use downloaded images for training until relevance and each image license are reviewed."
        ),
    }
    (output / "dataset_summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
