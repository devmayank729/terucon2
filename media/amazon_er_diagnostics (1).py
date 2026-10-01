"""Paste this entire file into ONE Kaggle cell and run it. No pip or internet needed.

It only reads project files and writes diagnostics under /kaggle/working (or cwd).
Share the generated ZIP after reviewing it for sensitive information.
"""

import ast
import collections
import csv
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys
import traceback
import zipfile

MAX_ROWS_PER_TSV = 100_000  # Full counts by default; detailed checks use at most this many rows.
MAX_SOURCE_CHARS = 80_000
MAX_FILES_PER_TREE = 600
EXPECTED = {
    "train": ["train_source1.tsv", "train_source2.tsv", "train_source3.tsv", "train_ground_truth.tsv"],
    "test": ["test_source1.tsv", "test_source2.tsv", "test_source3.tsv"],
}
PRIVATE_KEY = re.compile(r"(secret|token|password|passwd|private|credential|api[_-]?key|access[_-]?key|authorization|cookie|session|mongo[_-]?uri|database[_-]?url)", re.I)
REDACT_LINE = re.compile(r"(?i)(\b(?:api[_-]?key|secret|token|password|passwd|authorization|cookie|mongodb(?:\+srv)?://|postgres(?:ql)?://)\b|-----BEGIN .*PRIVATE KEY-----)")
REDACT_ASSIGN = re.compile(r"(?i)(\b[A-Za-z_]*(?:token|secret|password|passwd|api_key|access_key|private_key|mongo_uri|database_url)[A-Za-z_]*\b\s*[:=]\s*)([^,\n}]+)")
URI = re.compile(r"\b(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis|https?)://\S+", re.I)


def safe_text(value):
    s = str(value)
    s = URI.sub("[REDACTED_URI]", s)
    return s[:500]


def sanitize(value, key=""):
    if PRIVATE_KEY.search(str(key)):
        return "[REDACTED]"
    if isinstance(value, dict):
        return {str(k): sanitize(v, k) for k, v in value.items()}
    if isinstance(value, list):
        return [sanitize(v, key) for v in value[:100]] + (["[LIST_TRUNCATED]"] if len(value) > 100 else [])
    if isinstance(value, (str, int, float, bool)) or value is None:
        return safe_text(value) if isinstance(value, str) else value
    return safe_text(type(value).__name__)


def source_excerpt(path):
    raw = path.read_text(encoding="utf-8", errors="replace")
    lines = []
    for line in raw[:MAX_SOURCE_CHARS].splitlines():
        line = REDACT_ASSIGN.sub(r"\1'[REDACTED]'", line)
        line = URI.sub("[REDACTED_URI]", line)
        if REDACT_LINE.search(line):
            # Conservative: lose a whole line rather than expose an inline credential.
            lines.append("[POSSIBLY SENSITIVE SOURCE LINE REDACTED]")
        else:
            lines.append(line)
    return {"excerpt": "\n".join(lines), "truncated": len(raw) > MAX_SOURCE_CHARS}


def exception_info(exc):
    return {"type": type(exc).__name__, "message": safe_text(exc)}


def check(label, fn, report):
    try:
        report[label] = fn()
    except Exception as exc:
        report[label] = {"inspection_error": exception_info(exc)}


def discover():
    candidates = [Path.cwd(), Path("/kaggle/working/amazon_er")]
    if Path("/kaggle/working").exists():
        candidates += [p for p in Path("/kaggle/working").iterdir() if p.is_dir() and not p.name.startswith(".")]
    if Path("/kaggle/input").is_dir():
        for dirpath, dirs, files in os.walk("/kaggle/input"):
            parent = Path(dirpath)
            depth = len(parent.relative_to("/kaggle/input").parts)
            dirs[:] = sorted(d for d in dirs if not d.startswith(".")) if depth < 8 else []
            if "dataset" in dirs or "run_config.json" in files or "src" in dirs:
                candidates.append(parent)
    def score(p):
        return sum((p / item).exists() for item in ["src/main.py", "run_config.json", "dataset/train", "dataset/test", "student_resource/dataset/train"])
    # Prefer the current directory if none of the candidates contains project markers.
    root = max(candidates, key=lambda p: (score(p), p == Path.cwd()))
    return root.resolve(), [(str(p), score(p)) for p in candidates], max(score(p) for p in candidates) > 0


def kaggle_locations():
    """Read-only view of visible mounts and likely project archives."""
    result = {}
    for base in [Path("/kaggle/working"), Path("/kaggle/input"), Path("/kaggle/temp")]:
        entries, archives = [], []
        if not base.is_dir():
            result[str(base)] = {"exists": False}
            continue
        for dirpath, dirs, files in os.walk(base):
            depth = len(Path(dirpath).relative_to(base).parts)
            dirs[:] = sorted(d for d in dirs if not d.startswith(".")) if depth < 10 else []
            for name in sorted(files):
                p = Path(dirpath) / name
                suffix = p.suffix.lower()
                if len(entries) < 100 and (depth < 2 or suffix in {".zip", ".tsv", ".py", ".json"}):
                    entries.append(str(p))
                if suffix == ".zip" and len(archives) < 12:
                    item = {"path": str(p)}
                    try:
                        with zipfile.ZipFile(p) as z:
                            names = z.namelist()
                            item["members_count"] = len(names)
                            item["relevant_members"] = [n for n in names if n.endswith((".tsv", "run_config.json", "src/main.py"))][:35]
                    except Exception as exc:
                        item["inspection_error"] = exception_info(exc)
                    archives.append(item)
            if len(entries) >= 100 and len(archives) >= 12:
                break
        result[str(base)] = {"exists": True, "visible_files": entries, "archives": archives,
                             "file_list_capped": len(entries) >= 100}
    return result


def inventory(root):
    out = []
    skip = {".git", "__pycache__", ".ipynb_checkpoints", "node_modules", ".venv", "venv", "site-packages"}
    for dirpath, dirs, files in os.walk(root):
        depth = len(Path(dirpath).relative_to(root).parts)
        dirs[:] = sorted(d for d in dirs if d not in skip and not d.startswith(".")) if depth < 5 else []
        for name in sorted(files):
            if len(out) >= MAX_FILES_PER_TREE:
                return {"entries": out, "truncated": True}
            p = Path(dirpath) / name
            try:
                st = p.stat()
                out.append({"path": str(p.relative_to(root)), "bytes": st.st_size})
            except OSError:
                pass
    return {"entries": out, "truncated": False}


def locate_files(root):
    roots = [root, Path("/kaggle/working"), Path("/kaggle/input")]
    names = set(sum(EXPECTED.values(), []))
    found = {name: [] for name in names}
    for base in roots:
        if not base.is_dir():
            continue
        for dirpath, dirs, files in os.walk(base):
            depth = len(Path(dirpath).relative_to(base).parts)
            dirs[:] = sorted(d for d in dirs if not d.startswith(".") and d not in {"__pycache__", ".git"}) if depth < 10 else []
            for f in files:
                if f in names:
                    path = str((Path(dirpath) / f).resolve())
                    if path not in found[f]:
                        found[f].append(path)
    return found


def tsv_profile(path, kind):
    p = Path(path)
    result = {"path": str(p), "bytes": p.stat().st_size, "encoding": "utf-8-sig", "separator": "TAB"}
    required = (["source1_entity_id", "matched_entity_ids"] if kind == "truth" else
                ["entity_id", "business_name", "business_address", "country"])
    prefix = "S" + re.search(r"source([123])", p.name).group(1) + "-" if kind != "truth" else "S1-"
    with p.open("r", encoding="utf-8-sig", errors="replace", newline="") as f:
        reader = csv.reader(f, delimiter="\t")
        header = next(reader, [])
        result.update({"header": header, "required_missing": sorted(set(required) - set(header)),
                       "duplicate_columns": [x for x, n in collections.Counter(header).items() if n > 1]})
        if not header:
            return result
        bad_width = 0
        missing = collections.Counter()
        countries = collections.Counter()
        bad_prefix = 0
        ids = set()
        duplicate_ids = 0
        singleton = links = invalid_link_prefix = 0
        scanned = 0
        for row in reader:
            if scanned >= MAX_ROWS_PER_TSV:
                break
            scanned += 1
            if len(row) != len(header):
                bad_width += 1
                continue
            record = dict(zip(header, row))
            for col in required:
                if not record.get(col, "").strip():
                    missing[col] += 1
            identity = record.get("entity_id" if kind != "truth" else "source1_entity_id", "")
            if identity in ids:
                duplicate_ids += 1
            else:
                ids.add(identity)
            if identity and not identity.startswith(prefix):
                bad_prefix += 1
            if kind == "truth":
                raw_links = record.get("matched_entity_ids", "").strip()
                if not raw_links:
                    singleton += 1
                else:
                    members = [s.strip() for s in raw_links.split(",") if s.strip()]
                    links += len(members)
                    invalid_link_prefix += sum(not s.startswith(("S2-", "S3-")) for s in members)
            else:
                countries[record.get("country", "").strip()] += 1
        result.update({"sampled_rows": scanned, "sample_hit_limit": scanned >= MAX_ROWS_PER_TSV,
                       "bad_column_count_rows": bad_width, "blank_required_fields": dict(missing),
                       "duplicate_primary_ids_in_sample": duplicate_ids, "bad_source_prefix_in_sample": bad_prefix})
        if kind == "truth":
            result.update({"singletons_in_sample": singleton, "positive_links_in_sample": links,
                           "invalid_match_prefixes_in_sample": invalid_link_prefix})
        else:
            result["country_counts_in_sample"] = dict(countries)
    return result


def configs_and_source(root):
    configs, sources = {}, {}
    paths = inventory(root)["entries"]
    for item in paths:
        rel = item["path"]
        p = root / rel
        if p.name.startswith("amazon_er_diagnostics."):
            continue
        if p.suffix.lower() == ".py" and item["bytes"] < 500_000 and len(sources) < 35:
            entry = {"bytes": item["bytes"], "sha256": hashlib.sha256(p.read_bytes()).hexdigest()}
            try:
                tree = ast.parse(p.read_text(encoding="utf-8", errors="replace"))
                entry["imports"] = sorted({n.names[0].name.split(".")[0] for n in ast.walk(tree) if isinstance(n, ast.Import) and n.names} |
                                          {n.module.split(".")[0] for n in ast.walk(tree) if isinstance(n, ast.ImportFrom) and n.module})
                entry["functions"] = [{"name": n.name, "line": n.lineno} for n in ast.walk(tree)
                                      if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))][:100]
            except Exception as e:
                entry["ast_error"] = exception_info(e)
            entry.update(source_excerpt(p))
            sources[rel] = entry
        elif p.suffix.lower() == ".json" and item["bytes"] < 300_000 and len(configs) < 30:
            if p.name.endswith(".ipynb") or "output" in p.parts or "cache" in p.parts:
                continue
            try:
                configs[rel] = sanitize(json.loads(p.read_text(encoding="utf-8")))
            except Exception as e:
                configs[rel] = {"parse_error": exception_info(e)}
    return {"configs": configs, "source": sources}


def environment(root):
    packages = ["numpy", "pandas", "scipy", "scikit-learn", "rapidfuzz", "catboost", "xgboost",
                "torch", "sentence-transformers", "faiss-cpu", "lightgbm", "joblib", "pyarrow"]
    versions = {}
    for pkg in packages:
        try:
            versions[pkg] = importlib.metadata.version(pkg)
        except importlib.metadata.PackageNotFoundError:
            versions[pkg] = None
    result = {"python": sys.version, "executable": sys.executable, "platform": platform.platform(),
              "cwd": str(Path.cwd()), "root": str(root), "packages": versions,
              "kaggle_input_exists": Path("/kaggle/input").exists(),
              "internet_not_probed": "No network requests performed (challenge forbids external identity lookup)."}
    try:
        import psutil
        result["memory_total_gib"] = round(psutil.virtual_memory().total / 2**30, 2)
        result["memory_available_gib"] = round(psutil.virtual_memory().available / 2**30, 2)
    except ImportError:
        pass
    if shutil.which("nvidia-smi"):
        try:
            proc = subprocess.run(["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader"],
                                  capture_output=True, text=True, timeout=4)
            result["gpu"] = proc.stdout.strip()[:500] if proc.returncode == 0 else "unavailable"
        except Exception:
            result["gpu"] = "unavailable"
    return result


def report_summary(report):
    d = report.get("data_files", {})
    cfg = report.get("project", {}).get("configs", {})
    lines = ["Amazon ML Challenge 2026: diagnostic summary", "Project root: " + report.get("environment", {}).get("root", "unknown"),
             "Configuration files: " + (", ".join(cfg) if cfg else "NONE FOUND"), "Dataset:"]
    if not report.get("project_found"):
        lines.insert(1, "PROJECT NOT FOUND: Current Kaggle session has no visible src/main.py, run_config.json, or dataset folder.")
    elif not report.get("source_found"):
        lines.insert(1, "SOURCE CODE NOT FOUND: Dataset may be mounted, but src/main.py and run_config.json are absent from the selected project root.")
    for section, names in EXPECTED.items():
        for name in names:
            item = d.get(name, {})
            profiles = item.get("profiles", [])
            if not profiles:
                lines.append("  MISSING: " + name)
                continue
            for p in profiles:
                if "inspection_error" in p:
                    lines.append("  ERROR: " + name + ": " + str(p["inspection_error"]))
                else:
                    lines.append("  " + name + " | sampled=" + str(p.get("sampled_rows")) +
                                 ("+" if p.get("sample_hit_limit") else "") +
                                 " | missing columns=" + str(p.get("required_missing")) +
                                 " | country=" + str(p.get("country_counts_in_sample", {})))
    for label, val in report.items():
        if isinstance(val, dict) and "inspection_error" in val:
            lines.append("SECTION ERROR " + label + ": " + str(val["inspection_error"]))
    for config_name, config in cfg.items():
        if not isinstance(config, dict):
            continue
        pending = [("", config)]
        while pending:
            prefix, node = pending.pop()
            for key, val in node.items():
                path = prefix + "." + key if prefix else key
                if isinstance(val, dict):
                    pending.append((path, val))
                elif key == "max_train_pairs":
                    lines.append("  " + config_name + " -> " + path + " = " + str(val))
                    try:
                        if int(val) <= 0:
                            lines.append("  WARNING: max_train_pairs <= 0 leaves no training-pair budget.")
                    except (ValueError, TypeError):
                        lines.append("  WARNING: max_train_pairs is not an integer.")
    gt = d.get("train_ground_truth.tsv", {}).get("profiles", [])
    if gt:
        lines.append("Ground-truth positive links in scanned rows: " + str(gt[0].get("positive_links_in_sample", "unknown")))
        lines.append("Compare training-pair budget with positive links after the inner fit split; source excerpts show the exact calculation.")
    locations = report.get("kaggle_locations", {})
    lines.append("Kaggle mounts and project files:")
    for base, info in locations.items():
        entries = info.get("visible_files", [])
        lines.append("  " + base + ": " + ("not mounted" if not info.get("exists") else str(len(entries)) + " listed file(s)"))
        for name in entries[:20]:
            lines.append("    " + name)
        for archive in info.get("archives", []):
            lines.append("    archive: " + archive["path"] + " (relevant entries: " + str(len(archive.get("relevant_members", []))) + ")")
    if not report.get("project_found"):
        lines.append("Next: restore the notebook setup cell that creates /kaggle/working/amazon_er, or attach the dataset to this Kaggle notebook. Then run this diagnostic again.")
    elif not report.get("source_found"):
        lines.append("Next: rerun the notebook setup cell that writes /kaggle/working/amazon_er/src and run_config.json. Then run this diagnostic again.")
    lines += ["", "Dataset contents and raw environment variables were not included.",
              "Review the JSON and ZIP before sharing; source excerpts may contain sensitive literals."]
    return "\n".join(lines)


def main():
    root, considered, project_found = discover()
    source_found = (root / "src/main.py").is_file() and (root / "run_config.json").is_file()
    report = {"diagnostic_version": "1.2", "considered_roots": considered, "project_found": project_found,
              "source_found": source_found}
    check("kaggle_locations", kaggle_locations, report)
    check("environment", lambda: environment(root), report)
    check("inventory", lambda: inventory(root), report)
    check("project", lambda: configs_and_source(root), report)
    found = {}
    check("found_dataset_paths", lambda: locate_files(root), report)
    paths = report.get("found_dataset_paths", {})
    for group, names in EXPECTED.items():
        for name in names:
            found[name] = {"group": group, "paths": paths.get(name, []), "profiles": []}
            for path in paths.get(name, [])[:3]:
                try:
                    found[name]["profiles"].append(tsv_profile(path, "truth" if name.endswith("ground_truth.tsv") else "source"))
                except Exception as e:
                    found[name]["profiles"].append({"path": path, "inspection_error": exception_info(e)})
    report["data_files"] = found
    output = Path("/kaggle/working") if Path("/kaggle/working").is_dir() else Path.cwd()
    summary = report_summary(report)
    prefix = output / "amazon_er_diagnostics"
    json_path = prefix.with_suffix(".json")
    txt_path = prefix.with_suffix(".txt")
    zip_path = prefix.with_suffix(".zip")
    txt_path.write_text(summary + "\n", encoding="utf-8")
    json_path.write_text(json.dumps(report, ensure_ascii=False, indent=2, default=str), encoding="utf-8")
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.write(json_path, json_path.name)
        archive.write(txt_path, txt_path.name)
    print(summary)
    print("\nDetailed report: " + str(json_path) + " (" + str(json_path.stat().st_size) + " bytes)")
    print("\nSend this ZIP here: " + str(zip_path))


try:
    main()
except Exception as error:
    # A final diagnostic, including a traceback, if the notebook itself cannot write the report.
    print("Diagnostic script failed:", type(error).__name__, safe_text(error))
    print("Traceback (check for sensitive local paths before sharing):")
    traceback.print_exc(limit=5)
