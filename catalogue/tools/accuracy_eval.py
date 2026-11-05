"""Measure how well the closest-item search works, with numbers anyone can re-run (the "accuracy is very bad" report, 2026-11-04).

    python -I catalogue/tools/accuracy_eval.py table  --set catalogue/data/accuracy-eval/set.json
    python -I catalogue/tools/accuracy_eval.py colour --release <folder with items.json and pillars/> --crops <folder of <itemId>.png>
    python -I catalogue/tools/accuracy_eval.py queries --release <folder> --crops <folder> --out <folder> [--designs TIPL-SB922,TIPL-SB912]
    python -I catalogue/tools/accuracy_eval.py pictures --release <folder> --crops <folder> --out <folder>

(run from the project root; needs numpy, opencv, pillow, scipy: the engine's own requirements. Nothing here calls a service.)

  table    The NAMED SET: 18 synthetic queries (6 designs x 3 kinds, cut from the clean picture, never the page with its margin and label) and the 3 real
           patches from the reporter's photos of a gym floor. It reads the raw answers of the live search that were saved when the set was built
           (catalogue/data/accuracy-eval/answers.json: one call each, profile "full", k = 60, which carries every signal's similarity and rank), re-fuses them as
           the `fast`, `balanced` and `full` profiles would have answered (accuracy.refuse; tests prove it equals the real search code, and 4 saved live answers
           confirmed it, score differences under 1e-4), and prints hit@1/3/8 for the synthetic queries and where the first plausible design lands for the
           real ones. To score a CHANGE, make the live calls again (tools/catalogue-probe.mjs, the jobs file `queries` writes) into the same layout and point --set at it.
  colour   Colour-only retrieval of every design (63 x 3 synthetic queries), against the index as it is (the whole page crop, margin and label included)
           and against an index of the clean pictures. The colour pillar is pure code, so this is exact, with no live call.
  queries  Write the synthetic query photos and the jobs file for tools/catalogue-probe.mjs.
  pictures Write the picture of every design alone (page margin and label cut away), one PNG per design named by its product id: the input of the
           experiment that indexes the pictures instead of the pages (catalogue/ARCHITECTURE.md section 5.1). Writes nothing anywhere else.

What the numbers are NOT: an accuracy figure. They are about queries made from the catalogue's own pictures and one family of photos of one floor, labelled by
the person who built the set. Real phone photos of real physical samples, with an agreed right answer, do not exist yet; until they do, nothing here may be
quoted as "x % accurate" (catalogue/ARCHITECTURE.md section 5.1).
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Dict, List

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from terucon_catalogue import accuracy  # noqa: E402
from terucon_catalogue.config import PipelineConfig  # noqa: E402
from terucon_catalogue.features import ColorParams, compute_lab_color_descriptor  # noqa: E402
from terucon_catalogue.util import load_rgb  # noqa: E402

PROFILES = ("fast", "balanced", "full")


def design_pages(items: List[dict]) -> List[dict]:
    """The first page of every design (a product id printed on two pages is one design), without the cover (no product id), in page order."""
    seen, out = set(), []
    for item in sorted(items, key=lambda i: i["page"]):
        product = item.get("productId")
        if product and product not in seen:
            seen.add(product)
            out.append(item)
    return out


def load_items(release: Path) -> List[dict]:
    return json.loads((release / "items.json").read_text(encoding="utf-8"))


def seed_for(item: dict) -> int:
    return 1000 + int(item["page"]) * 7


# ------------------------------------------------------------------------------------------------------------------------
def cmd_table(args) -> int:
    spec = json.loads(Path(args.set).read_text(encoding="utf-8"))
    base = Path(args.set).parent
    answers = json.loads((base / spec["answers"]).read_text(encoding="utf-8"))
    product_of: Dict[str, str] = {k: v for k, v in spec["productOf"].items()}
    print(f"{spec['name']}\n{spec['caveat']}\n")
    syn_names = {variant: [n for n in spec["synthetic"]["answers"] if n.endswith("_" + variant)] for variant in accuracy.QUERY_VARIANTS}
    truth = {n: spec["synthetic"]["truth"][n] for n in spec["synthetic"]["answers"]}
    for profile in PROFILES:
        ranks = {}
        for variant, names in syn_names.items():
            ranks[variant] = [accuracy.product_rank(order(answers[n], profile), {truth[n]}, product_of) for n in names]
        allr = [r for v in ranks.values() for r in v]
        h = accuracy.hits(allr)
        per = "  ".join(f"{v}: @1 {accuracy.hits(r, (1,))[1]}/{len(r)} @3 {accuracy.hits(r, (3,))[3]}/{len(r)}" for v, r in ranks.items())
        print(f"{profile:9} synthetic {len(allr)} queries: hit@1 {h[1]}  hit@3 {h[3]}  hit@8 {h[8]}   ({per})")
    print("\nthe real patches: place of the first plausible design (strict = wood-grain designs of about the right tone, my own labels; wide adds warm plain beiges)")
    for key, entry in spec["real"].items():
        strict, wide = set(entry["strict"]), set(entry["strict"]) | set(entry["wideAdds"])
        cells = []
        for profile in PROFILES:
            o = order(answers[entry["answer"]], profile)
            cells.append(f"{profile}: strict #{accuracy.product_rank(o, strict, product_of)} wide #{accuracy.product_rank(o, wide, product_of)} top3 " +
                         ",".join(product_of.get(i, i).replace("TIPL-", "") for i in unique(o, product_of)[:3]))
        print(f"  {key} ({entry['what'][:44]}): " + " | ".join(cells))
    print("\nthe same patches under the `fast` profile, sent as a region of their own (what patch=1 does) and sent with no region (the whole-photo path: card search, then the centre 80 %)")
    for key, entry in spec["real"].items():
        if "aloneFast" not in entry:
            continue
        strict = set(entry["strict"])
        as_region = accuracy.product_rank(order(answers[entry["answer"]], "fast"), strict, product_of)
        alone_answer = answers[entry["aloneFast"]]
        alone = accuracy.product_rank(order(alone_answer, "fast"), strict, product_of)
        print(f"  {key}: first plausible design #{as_region} as a region, #{alone} through the whole-photo path ({alone_answer['query']['preprocessing']})")
    return 0


def order(answer: dict, profile: str) -> List[str]:
    table = accuracy.table_from_answer(answer)
    return accuracy.ordered(table, accuracy.refuse(table, accuracy.PROFILE_SIGNALS[profile]))


def unique(order_ids: List[str], product_of: Dict[str, str]) -> List[str]:
    seen, out = set(), []
    for item_id in order_ids:
        product = product_of.get(item_id, item_id)
        if product not in seen:
            seen.add(product)
            out.append(item_id)
    return out


# ------------------------------------------------------------------------------------------------------------------------
def cmd_colour(args) -> int:
    release, crops = Path(args.release), Path(args.crops)
    items = sorted(load_items(release), key=lambda i: i["page"])
    pillar = np.load(release / "pillars" / "color.npy").astype(np.float32)
    ids = json.loads((release / "pillars" / "color.ids.json").read_text(encoding="utf-8"))
    row = {item_id: index for index, item_id in enumerate(ids)}
    params = ColorParams.from_config(PipelineConfig())
    stored = np.stack([pillar[row[i["itemId"]]] for i in items])
    clean = np.stack([compute_lab_color_descriptor(accuracy.trim_page_margins(load_rgb(crops / f"{i['itemId']}.png")), params).vector for i in items])
    product_of = [i.get("productId") or f"page{i['page']}" for i in items]
    designs = design_pages(items)
    print(f"colour only, {len(designs)} designs x 3 query kinds; stored = the index as it is (whole page), clean = the picture alone")
    print(f"pairwise cosine between two designs' colour vectors: stored {mean_offdiag(stored):.2f}, clean {mean_offdiag(clean):.2f} (a lower number leaves more room between designs)")
    for variant in accuracy.QUERY_VARIANTS:
        queries = []
        for item in designs:
            swatch = accuracy.trim_page_margins(load_rgb(crops / f"{item['itemId']}.png"))
            query = accuracy.make_query(swatch, variant, seed_for(item))
            if variant == "V1":                          # the service rectifies a card, else crops the centre 80 %
                from terucon_catalogue.search import QueryPhotoPreprocessor
                query = QueryPhotoPreprocessor(PipelineConfig()).prepare(query).rectified_rgb
            queries.append((item["productId"], compute_lab_color_descriptor(query, params).vector))
        for label, index in (("stored", stored), ("clean ", clean)):
            ranks = []
            for truth, vector in queries:
                scores = index @ vector
                ranks.append(accuracy.product_rank([items[j]["itemId"] for j in np.argsort(-scores, kind="stable")], {truth},
                                                   {i["itemId"]: p for i, p in zip(items, product_of)}))
            h = accuracy.hits(ranks)
            print(f"  {variant} index {label}: hit@1 {h[1]:2}/{len(ranks)}  hit@3 {h[3]:2}  hit@8 {h[8]:2}")
    return 0


def mean_offdiag(matrix: np.ndarray) -> float:
    rows = [i for i in range(len(matrix))]
    sims = matrix @ matrix.T
    return float(sims[np.triu_indices(len(rows), 1)].mean())


# ------------------------------------------------------------------------------------------------------------------------
def cmd_queries(args) -> int:
    from PIL import Image
    release, crops, out = Path(args.release), Path(args.crops), Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    designs = design_pages(load_items(release))
    wanted = set(args.designs.split(",")) if args.designs else None
    jobs = []
    for item in designs:
        if wanted and item["productId"] not in wanted:
            continue
        swatch = accuracy.trim_page_margins(load_rgb(crops / f"{item['itemId']}.png"))
        for variant in accuracy.QUERY_VARIANTS:
            name = f"syn_{item['productId'].replace('TIPL-', '')}_{variant}"
            Image.fromarray(accuracy.make_query(swatch, variant, seed_for(item))).save(out / f"{name}.jpg", quality=88 if variant == "V1" else 95)
            query = {"profile": args.profile, "k": 60} | ({} if variant == "V1" else {"box": [0, 0, 1, 1]})
            jobs.append({"name": name, "file": f"{name}.jpg", "query": query, "truth": item["productId"], "variant": variant})
    (out / "jobs.json").write_text(json.dumps(jobs, indent=1), encoding="utf-8")
    print(f"{len(jobs)} queries written to {out}; send them with: node tools/catalogue-probe.mjs {out / 'jobs.json'}")
    return 0


def cmd_pictures(args) -> int:
    from PIL import Image
    release, crops, out = Path(args.release), Path(args.crops), Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    designs = design_pages(load_items(release))
    for item in designs:
        picture = accuracy.trim_page_margins(load_rgb(crops / f"{item['itemId']}.png"))
        Image.fromarray(picture).save(out / f"{item['productId']}.png")
    print(f"{len(designs)} pictures written to {out}")
    return 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = parser.add_subparsers(dest="command", required=True)
    t = sub.add_parser("table")
    t.add_argument("--set", default=str(Path(__file__).resolve().parents[1] / "data" / "accuracy-eval" / "set.json"))
    t.set_defaults(run=cmd_table)
    c = sub.add_parser("colour")
    c.add_argument("--release", required=True)
    c.add_argument("--crops", required=True)
    c.set_defaults(run=cmd_colour)
    q = sub.add_parser("queries")
    q.add_argument("--release", required=True)
    q.add_argument("--crops", required=True)
    q.add_argument("--out", required=True)
    q.add_argument("--designs", default="")
    q.add_argument("--profile", default="full", choices=PROFILES)
    q.set_defaults(run=cmd_queries)
    p = sub.add_parser("pictures")
    p.add_argument("--release", required=True)
    p.add_argument("--crops", required=True)
    p.add_argument("--out", required=True)
    p.set_defaults(run=cmd_pictures)
    args = parser.parse_args(argv)
    return args.run(args)


if __name__ == "__main__":
    raise SystemExit(main())
