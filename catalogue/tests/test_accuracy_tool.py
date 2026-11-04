"""catalogue/tools/accuracy_eval.py: the named evaluation set re-runs to the numbers the 2026-11-04 investigation reported, and the two other commands work on a
small made-up catalogue. Nothing here touches a service; the raw live answers it reads are the ones saved in catalogue/data/accuracy-eval/."""
import importlib.util
import json
import re
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from terucon_catalogue.config import PipelineConfig
from terucon_catalogue.features import ColorParams, compute_lab_color_descriptor

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("accuracy_eval", ROOT / "tools" / "accuracy_eval.py")
tool = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tool)


def test_the_named_set_gives_the_numbers_that_were_reported(capsys):
    assert tool.main(["table"]) == 0
    out = capsys.readouterr().out
    rows = {m.group(1): tuple(int(x) for x in m.groups()[1:]) for m in re.finditer(r"^(\w+)\s+synthetic 18 queries: hit@1 (\d+)\s+hit@3 (\d+)\s+hit@8 (\d+)", out, re.M)}
    assert rows == {"fast": (11, 17, 18), "balanced": (13, 16, 18), "full": (11, 17, 17)}, out
    assert "NOT an accuracy figure" in out
    # the reporter's pale-floor patch: concrete first under `fast`, a light oak first under `balanced` and `full`
    line_a = next(line for line in out.splitlines() if line.startswith("  A ("))
    assert "fast: strict #2" in line_a and "balanced: strict #1" in line_a and "full: strict #1" in line_a
    assert "top3 STC9092" in line_a.split("balanced")[0] and "top3 SB922" in line_a.split("balanced")[1]
    path_lines = [line for line in out.splitlines() if "through the whole-photo path" in line and line.startswith("  ")]
    assert [re.search(r"#(\d+) as a region, #(\d+) through", line).groups() for line in path_lines] == [("2", "22"), ("9", "24"), ("1", "1")]


def test_the_saved_answers_are_what_the_set_says_they_are():
    base = ROOT / "data" / "accuracy-eval"
    spec = json.loads((base / "set.json").read_text(encoding="utf-8"))
    answers = json.loads((base / "answers.json").read_text(encoding="utf-8"))
    names = list(spec["synthetic"]["answers"]) + [entry["answer"] for entry in spec["real"].values()] + [entry["aloneFast"] for entry in spec["real"].values()]
    assert set(names) <= set(answers)
    assert len(spec["synthetic"]["answers"]) == 18 and len(spec["productOf"]) == 69
    for name in spec["synthetic"]["answers"]:
        assert answers[name]["profile"] == "full" and len(answers[name]["results"]) == 60 and spec["synthetic"]["truth"][name].startswith("TIPL-")
    for entry in spec["real"].values():
        assert (base / entry["patch"]).is_file()
        assert set(entry["strict"]) <= set(spec["productOf"].values())


@pytest.fixture()
def tiny_catalogue(tmp_path):
    """Four designs printed as catalogue pages (white margin, picture, label line), a release folder with their colour vectors, and a crops folder."""
    rng = np.random.default_rng(5)
    release, crops = tmp_path / "release", tmp_path / "crops"
    (release / "pillars").mkdir(parents=True)
    crops.mkdir()
    params = ColorParams.from_config(PipelineConfig())
    items, vectors, ids = [], [], []
    base_colours = [(200, 160, 110), (110, 110, 118), (150, 60, 40), (60, 120, 70)]
    for index, colour in enumerate(base_colours):
        page = np.full((620, 410, 3), 255, np.uint8)
        noise = rng.integers(-35, 35, size=(500, 340, 3))
        page[50:550, 35:375] = np.clip(np.array(colour) + noise, 0, 254)
        page[575:582, 40:120] = (20, 20, 20)
        item_id = f"b0b0b0b0b0b0-p{index + 2:04d}-i00"
        Image.fromarray(page).save(crops / f"{item_id}.png")
        items.append({"itemId": item_id, "productId": f"TIPL-T{index}", "page": index + 2, "category": None, "finish": None, "dominantHex": [], "proportions": []})
        vectors.append(compute_lab_color_descriptor(page, params).vector)
        ids.append(item_id)
    (release / "items.json").write_text(json.dumps(items), encoding="utf-8")
    np.save(release / "pillars" / "color.npy", np.stack(vectors).astype(np.float16))
    (release / "pillars" / "color.ids.json").write_text(json.dumps(ids), encoding="utf-8")
    return release, crops


def test_colour_command_reports_both_indexes(tiny_catalogue, capsys):
    release, crops = tiny_catalogue
    assert tool.main(["colour", "--release", str(release), "--crops", str(crops)]) == 0
    out = capsys.readouterr().out
    assert "4 designs x 3 query kinds" in out
    for variant in ("V1", "V2", "V3"):
        assert f"{variant} index stored" in out and f"{variant} index clean" in out
    pair = re.search(r"stored ([\d.]+), clean ([\d.]+)", out)
    assert float(pair.group(2)) < float(pair.group(1)), "taking the page margin off leaves more room between designs"


def test_queries_command_writes_the_photos_and_the_jobs_file(tiny_catalogue, tmp_path, capsys):
    release, crops = tiny_catalogue
    out = tmp_path / "out"
    assert tool.main(["queries", "--release", str(release), "--crops", str(crops), "--out", str(out), "--designs", "TIPL-T1,TIPL-T3"]) == 0
    jobs = json.loads((out / "jobs.json").read_text(encoding="utf-8"))
    assert [j["name"] for j in jobs] == ["syn_T1_V1", "syn_T1_V2", "syn_T1_V3", "syn_T3_V1", "syn_T3_V2", "syn_T3_V3"]
    assert all(j["query"]["profile"] == "full" and j["query"]["k"] == 60 for j in jobs)
    assert [("box" in j["query"]) for j in jobs[:3]] == [False, True, True], "a whole capture is sent with no region, a patch as the box of the whole picture"
    for job in jobs:
        image = Image.open(out / job["file"])
        assert image.size[0] > 0 and job["truth"] in ("TIPL-T1", "TIPL-T3")
    # the same command twice writes the same photos (the seeds are fixed)
    again = tmp_path / "again"
    tool.main(["queries", "--release", str(release), "--crops", str(crops), "--out", str(again), "--designs", "TIPL-T1"])
    assert (again / "syn_T1_V2.jpg").read_bytes() == (out / "syn_T1_V2.jpg").read_bytes()


def test_pictures_command_writes_each_design_without_its_page(tiny_catalogue, tmp_path, capsys):
    release, crops = tiny_catalogue
    out = tmp_path / "pictures"
    assert tool.main(["pictures", "--release", str(release), "--crops", str(crops), "--out", str(out)]) == 0
    assert sorted(path.name for path in out.iterdir()) == ["TIPL-T0.png", "TIPL-T1.png", "TIPL-T2.png", "TIPL-T3.png"]
    picture = np.asarray(Image.open(out / "TIPL-T0.png"))
    assert picture.shape[0] < 500 and picture.shape[1] < 340, "smaller than the page's picture block: the margin and the label are gone"
    assert (picture < 250).any(axis=2).mean() > 0.99, "and no white page is left in it"
