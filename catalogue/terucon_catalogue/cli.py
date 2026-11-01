"""The command line:  python -m terucon_catalogue <command>

    catalogues list | create     see and create catalogues
    publish                      put a finished bundle (the notebook's output folder, or this package's own) into the catalogue
    import-bundle                the same, plus --explain (what was found in the folder)
    verify                       check a bundle without publishing it
    releases / activate          list releases; make one live (also how to roll back)
    compute / ingest / evaluate  need the compute or serve extras (PY-A's pipeline, PY-B's search); imported only when used

Exit codes: 0 done, 1 a problem with the data (nothing was published) or a failed run, 2 usage or configuration (a missing setting, a bad option).
This module imports only the standard library at the top, so `--help` loads no torch, pymongo or Google library.
"""
from __future__ import annotations

import argparse
import datetime as _dt
import os
import re
import sys
import tempfile
from pathlib import Path
from typing import Any, Callable, Dict, List, Mapping, Optional, Sequence

from . import __version__

PROG = "python -m terucon_catalogue"
EXIT_OK, EXIT_PROBLEMS, EXIT_USAGE = 0, 1, 2


class UsageError(Exception):
    """A mistake in how the command was used or configured (exit 2)."""


# ------------------------------------------------------------------------------------------------------------------------- env files
_ENV_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def parse_env_file(path: Path) -> Dict[str, str]:
    """KEY=VALUE lines, `export KEY=VALUE`, # comments, 'single' or "double" quoted values (a quoted value may run over several lines). No interpolation.
    A bad line is reported by its number only, because the line may hold a secret."""
    try:
        lines = Path(path).read_text(encoding="utf-8").splitlines()
    except OSError as error:
        raise UsageError(f"Cannot read the settings file {path} ({type(error).__name__}).") from None
    values: Dict[str, str] = {}
    index = 0
    while index < len(lines):
        number, raw = index + 1, lines[index].strip()
        index += 1
        if not raw or raw.startswith("#"):
            continue
        if raw.startswith("export "):
            raw = raw[len("export "):].lstrip()
        name, equals, rest = raw.partition("=")
        name, rest = name.strip(), rest.lstrip()
        if not equals or not _ENV_NAME.match(name):
            raise UsageError(f"Line {number} of {path} is not NAME=value.")
        if rest[:1] in ("'", '"'):
            quote = rest[0]
            body = rest[1:]
            while quote not in body:
                if index >= len(lines):
                    raise UsageError(f"Line {number} of {path} opens a quote that is never closed.")
                body += "\n" + lines[index]
                index += 1
            value = body[:body.index(quote)]
        else:
            value = re.split(r"\s+#", rest, maxsplit=1)[0].strip()
        values[name] = value
    return values


def load_environment(env_file: Optional[str], base: Optional[Mapping[str, str]], say: Callable[[str], None]) -> Dict[str, str]:
    environ = dict(os.environ if base is None else base)
    if env_file:
        loaded = parse_env_file(Path(env_file).expanduser())
        ignored = sorted(name for name in loaded if name in environ)
        for name, value in loaded.items():
            environ.setdefault(name, value)
        say(f"Read {len(loaded)} settings from {env_file} (names: {', '.join(sorted(loaded)) or 'none'}).")
        if ignored:
            say(f"Already set in your environment, so the file's value was not used: {', '.join(ignored)}.")
    return environ


# ----------------------------------------------------------------------------------------------------------------------------- output
class Output:
    def __init__(self, out, err):
        self.out, self.err = out, err

    def say(self, text: str = "") -> None:
        print(text, file=self.out)

    def warn(self, text: str) -> None:
        print(text, file=self.err)

    def table(self, rows: Sequence[Sequence[Any]], headers: Optional[Sequence[str]] = None, indent: str = "  ") -> None:
        cells = [[str(cell) for cell in row] for row in rows]
        if headers:
            cells.insert(0, list(headers))
        if not cells:
            return
        widths = [max(len(row[col]) for row in cells) for col in range(len(cells[0]))]
        for position, row in enumerate(cells):
            self.say(indent + "  ".join(cell.ljust(widths[col]) for col, cell in enumerate(row)).rstrip())
            if headers and position == 0:
                self.say(indent + "  ".join("-" * width for width in widths))

    def facts(self, pairs: Sequence[Sequence[Any]], indent: str = "  ") -> None:
        width = max((len(str(key)) for key, _ in pairs), default=0)
        for key, value in pairs:
            self.say(f"{indent}{str(key).ljust(width)}  {value}")


def when(ms: Any) -> str:
    try:
        return _dt.datetime.fromtimestamp(int(ms) / 1000.0, _dt.timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    except (TypeError, ValueError, OverflowError, OSError):
        return "?"


def plural(count: int, noun: str, many: Optional[str] = None) -> str:
    return f"{count} {noun if count == 1 else (many or noun + 's')}"


# --------------------------------------------------------------------------------------------------------------------------- argparse
def _common() -> argparse.ArgumentParser:
    parent = argparse.ArgumentParser(add_help=False)
    parent.add_argument("--env-file", metavar="FILE", default=argparse.SUPPRESS,
                        help="read settings (MONGODB_URI, CATALOGUE_GCS_BUCKET, GCP_SERVICE_ACCOUNT_JSON, ...) from a NAME=value file; values are never printed")
    return parent


def build_parser() -> argparse.ArgumentParser:
    common = _common()
    parser = argparse.ArgumentParser(prog=PROG, parents=[common], formatter_class=argparse.RawDescriptionHelpFormatter,
                                     description="Put the material catalogue's data where the website and the search service read it.",
                                     epilog="Start with:  verify --bundle <folder>   then   publish --bundle <folder> --catalogue <id> --dry-run\n"
                                            "Settings come from the environment or --env-file: MONGODB_URI (+ MONGODB_DB), CATALOGUE_GCS_BUCKET, CATALOGUE_GCS_PREFIX,\n"
                                            "GCP_SERVICE_ACCOUNT_JSON (or GOOGLE_APPLICATION_CREDENTIALS). CATALOGUE_LOCAL_STORE=<folder> stores files in a folder instead of a bucket.")
    parser.add_argument("--version", action="version", version=f"terucon_catalogue {__version__}")
    sub = parser.add_subparsers(dest="command", metavar="<command>")

    cats = sub.add_parser("catalogues", parents=[common], help="list or create catalogues")
    cats_sub = cats.add_subparsers(dest="catalogues_command", metavar="list|create")
    cats_sub.required = True
    cats_sub.add_parser("list", parents=[common], help="show every catalogue")
    create = cats_sub.add_parser("create", parents=[common], help="create a new, empty catalogue")
    create.add_argument("--id", required=True, help="2 to 39 characters: lower-case letters, digits and '-' (for example superbond-colour)")
    create.add_argument("--name", required=True, help="the name people see")
    create.add_argument("--kind", default="materials", choices=["materials", "paint", "exterior", "other"])
    create.add_argument("--note", default=None)

    for name, help_text in (("publish", "publish a bundle into a catalogue"), ("import-bundle", "same as publish, plus --explain; the way to bring in a finished Kaggle run")):
        command = sub.add_parser(name, parents=[common], help=help_text)
        command.add_argument("--bundle", required=True, metavar="DIR", help="the notebook's output folder (state.sqlite and crops/), or one made by `compute`")
        command.add_argument("--catalogue", required=True, metavar="ID")
        command.add_argument("--source-pdf", action="extend", nargs="+", default=[], metavar="FILE", help="keep the original PDF(s) in the bucket (checked against the bundle)")
        command.add_argument("--activate", action="store_true", help="make the new release live (otherwise it is only stored, and you activate it after a look)")
        command.add_argument("--dry-run", action="store_true", help="check everything and say what would happen, write nothing")
        command.add_argument("--job-id", default=None, help="a name for this run (default: manual-<date>)")
        if name == "import-bundle":
            command.add_argument("--explain", action="store_true", help="first print what was found in the folder")

    verify = sub.add_parser("verify", parents=[common], help="check a bundle and list every problem; writes nothing, needs no settings")
    verify.add_argument("--bundle", required=True, metavar="DIR")

    activate = sub.add_parser("activate", parents=[common], help="make a release the live one (to roll back, activate the earlier one)")
    activate.add_argument("--catalogue", required=True, metavar="ID")
    activate.add_argument("--release", required=True, metavar="REL")

    releases = sub.add_parser("releases", parents=[common], help="list a catalogue's releases, newest first")
    releases.add_argument("--catalogue", required=True, metavar="ID")

    compute = sub.add_parser("compute", parents=[common], help="turn PDF(s) into a bundle (needs the compute extras: torch, PyMuPDF, ...)")
    compute.add_argument("--pdf", action="extend", nargs="+", required=True, metavar="FILE", help="PDF files, folders of PDFs or images")
    compute.add_argument("--work-dir", required=True, metavar="DIR", help="where the bundle (state.sqlite and crops/) is written; running again resumes")
    compute.add_argument("--stages", default=None, help="comma list of extract,features,vertex_mm,captions,text_vectors (default all)")
    compute.add_argument("--no-vertex", action="store_true", help="skip the steps that call Google (vertex_mm, captions, text_vectors)")

    ingest = sub.add_parser("ingest", parents=[common], help="compute a PDF and publish it in one go, on this computer (needs the compute extras)")
    ingest.add_argument("--pdf", required=True, metavar="FILE")
    ingest.add_argument("--catalogue", required=True, metavar="ID")
    ingest.add_argument("--activate", action="store_true")
    ingest.add_argument("--work-dir", default=None, metavar="DIR", help="default: a new temporary folder (its path is printed)")
    ingest.add_argument("--no-vertex", action="store_true")

    evaluate = sub.add_parser("evaluate", parents=[common], help="the notebook's self-retrieval table for a live release (needs the serve extras and the models)")
    evaluate.add_argument("--catalogue", required=True, metavar="ID")
    evaluate.add_argument("--release", default=None, metavar="REL", help="default: the catalogue's live release")
    evaluate.add_argument("--profile", default="fast", choices=["fast", "balanced", "full"])
    evaluate.add_argument("--n", type=int, default=40, metavar="N", help="how many catalogue pages to distort and look up (default 40, the notebook's)")
    return parser


# ------------------------------------------------------------------------------------------------------------------------------ main
def main(argv: Optional[Sequence[str]] = None, *, environ: Optional[Mapping[str, str]] = None, store: Any = None, db: Any = None, out=None, err=None) -> int:
    """Run one command. store / db may be passed in (tests do); otherwise they are built from the environment when a command needs them."""
    output = Output(out or sys.stdout, err or sys.stderr)
    parser = build_parser()
    try:
        args = parser.parse_args(list(argv) if argv is not None else None)
    except SystemExit as stop:
        return int(stop.code) if isinstance(stop.code, int) else (EXIT_OK if stop.code is None else EXIT_USAGE)
    if not args.command:
        parser.print_help(output.out)
        return EXIT_USAGE
    try:
        env = load_environment(getattr(args, "env_file", None), environ, output.say)
        handler = HANDLERS[args.command]
        return handler(args, Context(env, output, store, db))
    except UsageError as error:
        output.warn(f"Cannot do that: {error}")
        return EXIT_USAGE
    except KeyboardInterrupt:
        output.warn("Stopped. Nothing was activated; run the same command again to carry on.")
        return EXIT_PROBLEMS


class Context:
    def __init__(self, env: Mapping[str, str], output: Output, store: Any, db: Any):
        self.env, self.output, self._store, self._db = env, output, store, db

    @property
    def store(self):
        if self._store is None:
            from .objectstore import StoreConfigError, object_store_from_env

            try:
                self._store = object_store_from_env(self.env)
            except StoreConfigError as error:
                raise UsageError(str(error)) from None
        return self._store

    @property
    def db(self):
        if self._db is None:
            from .mongo import DbConfigError, db_from_env

            try:
                self._db = db_from_env(self.env)
            except DbConfigError as error:
                raise UsageError(str(error)) from None
        return self._db


def _guard_runtime(context: Context, action: Callable[[], int]) -> int:
    """Turn the errors a real service raises into a sentence and an exit code, without a traceback and without echoing a connection string."""
    from .mongo import CatalogueDbError, redact_uri
    from .objectstore import ObjectStoreError

    try:
        return action()
    except (CatalogueDbError, ObjectStoreError) as error:
        context.output.warn(f"Stopped: {redact_uri(str(error))}")
        return EXIT_PROBLEMS
    except Exception as error:                                                    # a service that is down, a bad key, a full disk ...
        context.output.warn(f"Stopped: {type(error).__name__}: {redact_uri(str(error))[:600]}")
        for note in getattr(error, "__notes__", []) or []:
            context.output.warn(note)
        return EXIT_PROBLEMS


# ---------------------------------------------------------------------------------------------------------------------------- handlers
def cmd_catalogues(args, context: Context) -> int:
    def run() -> int:
        out = context.output
        if args.catalogues_command == "list":
            rows = []
            for doc in context.db.list_catalogues():
                counts = doc.get("counts") or {}
                rows.append([doc["_id"], doc.get("name", ""), doc.get("kind", ""), counts.get("items", 0), counts.get("hidden", 0), doc.get("activeRelease") or "(none live)",
                             when(doc.get("updatedAt"))])
            if not rows:
                out.say("There are no catalogues yet. Create one with:")
                out.say(f"  {PROG} catalogues create --id superbond-colour --name \"Superbond colour\"")
                return EXIT_OK
            out.table(rows, ["id", "name", "kind", "items", "hidden", "live release", "updated"])
            return EXIT_OK
        existing = context.db.get_catalogue(args.id)
        if existing is not None:
            out.warn(f"The catalogue {args.id!r} already exists ({existing.get('name')!r}); nothing was changed.")
            return EXIT_PROBLEMS
        document = context.db.upsert_catalogue(args.id, name=args.name, kind=args.kind, note=args.note)
        out.say(f"Created the catalogue {document['_id']!r} ({document['name']}). It has no items and no live release yet.")
        out.say("Next:")
        out.say(f"  {PROG} publish --bundle <folder> --catalogue {document['_id']} --dry-run")
        return EXIT_OK

    from .mongo import CatalogueDbError

    try:
        return _guard_runtime(context, run)
    except CatalogueDbError as error:       # a bad id or kind
        context.output.warn(str(error))
        return EXIT_PROBLEMS


def _source_files(paths: Sequence[str], out: Output) -> Dict[str, Path]:
    from .bundle import sha256_of_file

    found: Dict[str, Path] = {}
    for text in paths or []:
        path = Path(text).expanduser()
        if not path.is_file():
            raise UsageError(f"--source-pdf {text!r} is not a file.")
        out.say(f"Reading {path.name} to take its checksum ({path.stat().st_size / 1e6:.1f} MB) ...")
        found[sha256_of_file(path)] = path
    return found


def _printer(out: Output) -> Callable[[str, int, int, str], None]:
    last = {"line": ""}

    def show(stage: str, done: int, total: int, message: str) -> None:
        line = f"  [{stage}] {message}" + (f" ({done}/{total})" if total > 1 else "")
        if line != last["line"]:
            out.say(line)
            last["line"] = line
    return show


def cmd_publish(args, context: Context) -> int:
    from .bundle import Bundle, BundleError
    from .config import load_config
    from .publish import PublishError, publish_bundle

    out = context.output
    explain = getattr(args, "explain", False)
    if explain:
        try:
            with Bundle(args.bundle) as bundle:
                _print_explain(out, bundle)
        except BundleError as error:
            out.warn(f"Nothing was published: {error}")
            return EXIT_PROBLEMS
    sources = _source_files(args.source_pdf, out)
    cfg = load_config(context.env)

    def run() -> int:
        out.say(("Checking (a dry run: nothing will be written)" if args.dry_run else "Publishing") + f" {args.bundle} into the catalogue {args.catalogue!r} ...")
        try:
            result = publish_bundle(args.bundle, catalogue=args.catalogue, store=context.store, db=context.db, cfg=cfg, job_id=args.job_id, source_files=sources or None,
                                    activate=args.activate, dry_run=args.dry_run, progress=None if args.dry_run else _printer(out),
                                    created_by="import" if args.command == "import-bundle" else "cli")
        except PublishError as error:
            out.say()
            out.warn(f"Nothing was published. {plural(len(error.problems), 'problem')} found:")
            for number, problem in enumerate(error.problems, start=1):
                out.warn(f"  {number}. {problem}")
            for warning in error.warnings:
                out.warn(f"  (also noted: {warning})")
            out.warn("\nFix these and run the same command again. To see the checks alone: verify --bundle <folder>")
            return EXIT_PROBLEMS
        _print_result(out, result, args)
        return EXIT_OK

    return _guard_runtime(context, run)


def _print_result(out: Output, result, args) -> None:
    out.say()
    for line in result.report:
        out.say(line)
    out.say()
    details = result.details
    out.facts([
        ("Catalogue", args.catalogue),
        ("Release", (result.release_id or "(would be created)") + (" (already existed)" if result.release_reused else "")),
        ("Items in the release", result.n_items),
        ("From this bundle", f"{result.n_bundle_items}: {result.n_new} new, {result.n_changed} changed, {result.n_unchanged} unchanged"
         + (f"; {result.n_dropped} left out (cannot be searched)" if result.n_dropped else "")),
        ("Pictures", f"{details['crops_uploaded']} crops + {details['thumbs_uploaded']} thumbnails to upload, {details['crops_present']} already there"
         + (f", {details['crops_replaced']} replaced" if details["crops_replaced"] else "")),
        ("Item documents", f"{details['docs_added']} to add, {details['docs_changed']} to update, {details['docs_unchanged']} already right"),
        ("Vectors", ", ".join(f"{name} {entry['count']}x{entry['dim']}" for name, entry in sorted(details["pillars"].items())) or "none"),
        ("Live", "yes, switched now" if result.activated else ("it already was" if (result.nothing_to_do or result.release_reused) and args.activate and not args.dry_run else "no")),
    ])
    if result.warnings:
        out.say()
        out.say(f"{plural(len(result.warnings), 'thing')} to know about:")
        for warning in result.warnings:
            out.say(f"  - {warning}")
    out.say()
    if args.dry_run:
        out.say("This was a dry run: nothing was written. To do it for real, run the same command without --dry-run.")
    elif result.activated:
        out.say("The release is live. To undo, make the earlier one live again:")
        out.say(f"  {PROG} releases --catalogue {args.catalogue}   (find the earlier release id)")
        out.say(f"  {PROG} activate --catalogue {args.catalogue} --release <earlier id>")
    elif result.release_id:
        out.say("The release is stored but NOT live yet. When you have looked at it:")
        out.say(f"  {PROG} activate --catalogue {args.catalogue} --release {result.release_id}")


def _print_explain(out: Output, bundle) -> None:
    found = bundle.describe()
    out.say(f"What was found in {found['folder']}:")
    out.facts([
        ("Database", found["state_file"] + ("   (with a -wal file, which was read too)" if found["has_wal_file"] else "")),
        ("Original PDFs", "; ".join(f"{pdf['name']} ({pdf['page_count']} pages, {pdf['status']})" for pdf in found["pdfs"]) or "none recorded"),
        ("Pages", f"{found['pages']} ({found['pages_done']} finished)"),
        ("Items", f"{found['items']} ({found['items_ok']} ok)"),
        ("Crop paths", ", ".join(f"{count} {style}" for style, count in sorted(found["crop_path_styles"].items())) + f"; {found['crops_found']} of {found['items']} crop files located in the folder"),
        ("Product ids", f"{found['items_ok'] - found['unmatched_product_ids']} read from the PDF's text, {found['unmatched_product_ids']} not (UNMATCHED)"),
        ("Descriptions", f"{found['captions_ok']} written by the caption step"),
    ])
    out.say("  Vectors:")
    out.table([[name, entry["count"], "/".join(map(str, entry["dims"])), "; ".join(entry["versions"])] for name, entry in sorted(found["pillars"].items())],
              ["pillar", "items", "numbers each", "version"], indent="    ")
    out.say()


def cmd_verify(args, context: Context) -> int:
    from .bundle import Bundle, BundleError, errors_of, warnings_of
    from .config import check_feature_versions, load_config

    out = context.output
    try:
        with Bundle(args.bundle) as bundle:
            found = bundle.verify(load_config(context.env))
            try:
                versions = bundle.feature_versions()
                found += [type("P", (), {"level": p.level, "message": p.message})() for p in check_feature_versions(versions, load_config(context.env))]
            except BundleError:
                pass                                      # already reported by verify() as a mixed-version error
            items = len(list(bundle.items(only_ok=False)))
    except BundleError as error:
        out.warn(f"Cannot open the bundle: {error}")
        return EXIT_USAGE
    errors = [p for p in found if p.level == "error"]
    warns = [p for p in found if p.level == "warning"]
    out.say(f"Checked {args.bundle}: {plural(items, 'item')}.")
    for problem in errors:
        out.say(f"  ERROR    {problem.message}")
    for problem in warns:
        out.say(f"  warning  {problem.message}")
    out.say()
    if errors:
        out.say(f"{plural(len(errors), 'error')}, {plural(len(warns), 'warning')}. This bundle would be refused: fix the errors first (a re-run of the compute usually does it).")
        return EXIT_PROBLEMS
    out.say(f"No errors, {plural(len(warns), 'warning')}. It can be published." if warns else "No problems. It can be published.")
    out.say(f"  {PROG} publish --bundle {args.bundle} --catalogue <id> --dry-run")
    return EXIT_OK


def cmd_activate(args, context: Context) -> int:
    from .publish import ActivationError, activate_release

    def run() -> int:
        before = context.db.get_catalogue(args.catalogue)
        if before is None:
            context.output.warn(f"The catalogue {args.catalogue!r} does not exist.")
            return EXIT_PROBLEMS
        try:
            after = activate_release(args.catalogue, args.release, store=context.store, db=context.db)
        except ActivationError as error:
            context.output.warn(f"Not activated: {error}")
            return EXIT_PROBLEMS
        context.output.say(f"{args.release} is now the live release of {args.catalogue!r} ({(after.get('counts') or {}).get('items', '?')} visible items).")
        if after.get("previousRelease"):
            context.output.say(f"To undo: {PROG} activate --catalogue {args.catalogue} --release {after['previousRelease']}")
        return EXIT_OK

    return _guard_runtime(context, run)


def cmd_releases(args, context: Context) -> int:
    def run() -> int:
        catalogue = context.db.get_catalogue(args.catalogue)
        if catalogue is None:
            context.output.warn(f"The catalogue {args.catalogue!r} does not exist.")
            return EXIT_PROBLEMS
        records = context.db.list_releases(args.catalogue)
        if not records:
            context.output.say(f"{args.catalogue!r} has no releases yet. Publish a bundle first.")
            return EXIT_OK
        live, previous = catalogue.get("activeRelease"), catalogue.get("previousRelease")
        context.output.table([[("LIVE" if r["_id"] == live else ("previous" if r["_id"] == previous else "")), r["_id"], when(r.get("createdAt")), r.get("nItems"),
                               ", ".join(sorted((r.get("pillars") or {}))), r.get("parent") or "-", r.get("createdBy")] for r in records],
                              ["", "release", "created", "items", "vectors", "built on", "by"])
        return EXIT_OK

    return _guard_runtime(context, run)


# ------------------------------------------------------------------------------------------------------ commands that need other modules
def _need(module: str, extra: str, out: Output):
    import importlib

    try:
        return importlib.import_module(f"terucon_catalogue.{module}")
    except ImportError as error:
        raise UsageError(f"This command needs the {extra} extras (it imports {module}: {error}). Install them with:  pip install \"terucon-catalogue[{extra}]\"") from None


def _maybe_manager(cfg, env: Mapping[str, str], skip: bool, out: Output):
    if skip:
        out.say("Skipping the steps that call Google (--no-vertex).")
        return None
    from .credentials import SecretUnavailableError, load_service_account_info

    try:
        info = load_service_account_info(env)
    except SecretUnavailableError:
        out.say("No Google service account is set (GCP_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS), so vertex_mm, captions and text vectors will be skipped.")
        return None
    vertex = _need("vertex", "compute", out)
    return vertex.VertexGenAIManager(cfg, info)


def _stage_table(out: Output, result) -> None:
    rows = [[name, info.get("status", "?"), info.get("processed", ""), info.get("pending", ""), info.get("message", "")] for name, info in result.stages.items()]
    out.table(rows, ["stage", "status", "done now", "left", "note"])


def cmd_compute(args, context: Context) -> int:
    from .config import load_config

    out = context.output
    pipeline = _need("pipeline", "compute", out)
    cfg = load_config(context.env)
    stages = tuple(s.strip() for s in args.stages.split(",") if s.strip()) if args.stages else ("extract", "features", "vertex_mm", "captions", "text_vectors")
    if args.no_vertex:
        stages = tuple(s for s in stages if s not in ("vertex_mm", "captions", "text_vectors"))
    manager = _maybe_manager(cfg, context.env, args.no_vertex, out)
    pdfs = [Path(p).expanduser() for p in args.pdf]
    out.say(f"Computing {plural(len(pdfs), 'input')} into {args.work_dir} (running it again carries on where it stopped) ...")
    result = pipeline.run_compute(cfg, pdfs=pdfs, work_dir=Path(args.work_dir), manager=manager, progress=_printer(out), stages=stages)
    out.say()
    out.facts([("Items", result.n_items), ("Pages", result.n_pages), ("Failed pages", len(result.failed_pages)), ("No product id (UNMATCHED)", result.unmatched)])
    _stage_table(out, result)
    for warning in result.warnings:
        out.say(f"  - {warning}")
    out.say()
    out.say("Next:")
    out.say(f"  {PROG} verify --bundle {args.work_dir}")
    out.say(f"  {PROG} publish --bundle {args.work_dir} --catalogue <id> --source-pdf <the pdf> --dry-run")
    return EXIT_OK if not result.failed_pages else EXIT_PROBLEMS


def cmd_ingest(args, context: Context) -> int:
    from .bundle import sha256_of_file
    from .config import load_config
    from .publish import PublishError, publish_bundle

    out = context.output
    pipeline = _need("pipeline", "compute", out)
    cfg = load_config(context.env)
    pdf = Path(args.pdf).expanduser()
    if not pdf.is_file():
        raise UsageError(f"--pdf {args.pdf!r} is not a file.")
    store, db = context.store, context.db                          # fail on missing settings before the (slow, paid) compute starts
    if db.get_catalogue(args.catalogue) is None:
        raise UsageError(f"The catalogue {args.catalogue!r} does not exist; create it first with: {PROG} catalogues create --id {args.catalogue} --name \"...\"")
    work_dir = Path(args.work_dir) if args.work_dir else Path(tempfile.mkdtemp(prefix="terucon-ingest-"))
    manager = _maybe_manager(cfg, context.env, args.no_vertex, out)
    out.say(f"Computing {pdf.name} into {work_dir} ...")
    result = pipeline.run_compute(cfg, pdfs=[pdf], work_dir=work_dir, manager=manager, progress=_printer(out))
    _stage_table(out, result)
    if result.failed_pages:
        out.warn(f"{plural(len(result.failed_pages), 'page')} failed; not publishing. Run the same command again to retry them (the bundle in {work_dir} keeps what is done).")
        return EXIT_PROBLEMS

    def run() -> int:
        try:
            published = publish_bundle(work_dir, catalogue=args.catalogue, store=store, db=db, cfg=cfg, source_files={sha256_of_file(pdf): pdf}, activate=args.activate,
                                       progress=_printer(out), created_by="cli")
        except PublishError as error:
            out.warn(f"Computed, but not published. {plural(len(error.problems), 'problem')}:")
            for problem in error.problems:
                out.warn(f"  - {problem}")
            return EXIT_PROBLEMS
        args.dry_run = False
        _print_result(out, published, args)
        return EXIT_OK

    return _guard_runtime(context, run)


def cmd_evaluate(args, context: Context) -> int:
    import asyncio
    import inspect

    from .config import load_config

    out = context.output
    search = _need("search", "serve", out)
    service_module = _need("service", "serve", out)
    encoders = _need("encoders", "compute", out)
    evaluate = getattr(search, "evaluate_self_retrieval", None)
    if evaluate is None:
        raise UsageError("search.evaluate_self_retrieval was not found in this version of the package.")
    accepts_profile = "profile" in inspect.signature(evaluate).parameters
    if args.profile != "fast" and not accepts_profile:
        raise UsageError(f"--profile {args.profile} is not available: search.evaluate_self_retrieval measures the notebook's configuration only (the 'fast' profile: "
                         "no Vertex image embedding, no Gemini description of the query).")
    cfg = load_config(context.env)
    catalogue = context.db.get_catalogue(args.catalogue)
    if catalogue is None:
        raise UsageError(f"The catalogue {args.catalogue!r} does not exist.")
    release = args.release or catalogue.get("activeRelease")
    if not release:
        raise UsageError(f"{args.catalogue!r} has no live release; pass --release.")
    cache_dir = Path(context.env.get("CATALOGUE_CACHE_DIR") or tempfile.mkdtemp(prefix="terucon-cache-"))
    manager = _maybe_manager(cfg, context.env, args.profile == "fast", out) if args.profile != "fast" else None
    out.say(f"Loading the models and release {release} (this can take minutes the first time) ...")
    bank = encoders.EncoderBank(cfg)
    service = service_module.SearchService(cfg, store=context.store, cache_dir=cache_dir, encoders=bank, manager=manager)

    def loader(item_id: str):
        from .util import load_rgb

        document = context.db.get_items(args.catalogue, [item_id]).get(item_id)
        if document is None:
            raise KeyError(f"item {item_id} has no document in MongoDB")
        return load_rgb(context.store.get_bytes(document["images"]["crop"]["key"]))

    async def run():
        _loaded, retriever = await service._release(args.catalogue, release)
        extra = {"profile": args.profile} if accepts_profile else {}
        return await evaluate(retriever, loader, sample_size=args.n, seed=0, **extra)

    rows = asyncio.run(run())
    out.say()
    out.say(f"Self-retrieval under simulated phone capture ({args.n} catalogue pages, profile {args.profile}):")
    out.table([[row["signal"], f"{row['recall@1']:.3f}", f"{row['recall@5']:.3f}", f"{row['mrr']:.3f}", row["queries"]] for row in rows], ["signal", "recall@1", "recall@5", "mrr", "queries"])
    out.say()
    out.say("This measures robustness to distortion of the catalogue's own pages (printed labels included), not how well a photo of a real sample matches.")
    return EXIT_OK


HANDLERS: Dict[str, Callable[[argparse.Namespace, Context], int]] = {
    "catalogues": cmd_catalogues, "publish": cmd_publish, "import-bundle": cmd_publish, "verify": cmd_verify, "activate": cmd_activate, "releases": cmd_releases,
    "compute": cmd_compute, "ingest": cmd_ingest, "evaluate": cmd_evaluate,
}
