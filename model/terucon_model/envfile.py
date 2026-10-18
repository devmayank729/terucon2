"""A small, dependency-free .env reader.

Supports the forms people actually paste:

    KEY=value
    export KEY=value
    KEY="value with \\n escapes"      (double quotes: \\n \\r \\t \\" \\\\ are expanded)
    KEY='{"literal": "json"}'         (single quotes: taken literally, may span lines)
    KEY=value   # trailing comment   (a # needs whitespace before it to start a comment)

Real environment variables win over the file, like every other dotenv loader, so a value
set on a host (Render, Cloud Run, a shell export) is never silently replaced.
"""
from __future__ import annotations

import os
import re
from pathlib import Path

_KEY = re.compile(r"[A-Za-z_][A-Za-z0-9_.\-]*")
_ESCAPES = {"n": "\n", "r": "\r", "t": "\t", '"': '"', "\\": "\\"}


def parse_env(text: str) -> dict[str, str]:
    """Parse .env text. Later duplicates win. Never raises on odd input; bad lines are skipped."""
    text = text.lstrip("﻿").replace("\r\n", "\n").replace("\r", "\n")
    values: dict[str, str] = {}
    i, n = 0, len(text)
    while i < n:
        # skip blanks and whole-line comments
        j = text.find("\n", i)
        j = n if j == -1 else j
        line = text[i:j]
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            i = j + 1
            continue
        if stripped.startswith("export ") or stripped.startswith("export\t"):
            line = line.lstrip()[7:]
            stripped = line.strip()
        eq = stripped.find("=")
        if eq <= 0:
            i = j + 1
            continue
        key = stripped[:eq].strip()
        if not _KEY.fullmatch(key):
            i = j + 1
            continue
        # the first '=' on the line is the separator (a key cannot contain one)
        rest_start = text.find("=", i, j) + 1
        while rest_start < n and text[rest_start] in " \t":
            rest_start += 1
        value, next_i = _read_value(text, rest_start, n)
        values[key] = value
        i = next_i
    return values


def _read_value(text: str, start: int, n: int) -> tuple[str, int]:
    if start >= n or text[start] == "\n":
        return "", start + 1
    quote = text[start]
    if quote in ("'", '"'):
        k = start + 1
        buf: list[str] = []
        while k < n:
            ch = text[k]
            if quote == '"' and ch == "\\" and k + 1 < n:
                nxt = text[k + 1]
                buf.append(_ESCAPES.get(nxt, "\\" + nxt))
                k += 2
                continue
            if ch == quote:
                # consume the rest of the line (a trailing comment is allowed)
                eol = text.find("\n", k + 1)
                return "".join(buf), (n if eol == -1 else eol + 1)
            buf.append(ch)
            k += 1
        # unterminated quote: take what we have to the end of the line it started on
        eol = text.find("\n", start)
        raw = text[start + 1 : (n if eol == -1 else eol)]
        return raw, (n if eol == -1 else eol + 1)
    eol = text.find("\n", start)
    eol = n if eol == -1 else eol
    raw = text[start:eol]
    m = re.search(r"\s#", raw)
    if m:
        raw = raw[: m.start()]
    return raw.strip(), eol + 1


def load_env_file(path: str | Path) -> dict[str, str]:
    p = Path(path)
    try:
        return parse_env(p.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}


def merged_environment(path: str | Path) -> dict[str, str]:
    """The .env file overlaid by the real process environment (the environment wins)."""
    merged = load_env_file(path)
    for key, value in os.environ.items():
        merged[key] = value
    return merged
