"""The notebook as an oracle: load chosen definitions out of terucon-cat-1.ipynb and run them, so a test can say
"the port gives exactly what the user's own code gave".

Nothing in the notebook is executed except the `def` / `class` statements and the constants you name. In particular cell 1's vibe
check, pip installs and GPU checks, cell 2's `CFG = PipelineConfig()` and cell 7's autorun are never run.

    ns = load([(1, ["PDF_PATH", "sha256_bytes"]), (2, ["PipelineConfig"])])
    ns["sha256_bytes"](b"x")

The notebook is the user's file and is not shipped with the package. Tests that need it call `require_notebook()` and are skipped when it is
not there. Point TERUCON_NOTEBOOK at it, or leave it where it is (the project root, next to catalogue/).
"""
from __future__ import annotations

import ast
import json
import os
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEFAULT_NOTEBOOK = HERE.parent.parent / "terucon-cat-1.ipynb"


def notebook_path():
    explicit = os.environ.get("TERUCON_NOTEBOOK")
    return Path(explicit) if explicit else DEFAULT_NOTEBOOK


def have_notebook():
    return notebook_path().is_file()


def require_notebook():
    """pytest.skip when the notebook is not present (the message says where it looked)."""
    import pytest

    if not have_notebook():
        pytest.skip(f"the notebook is not at {notebook_path()} (set TERUCON_NOTEBOOK)")


_CELLS = None


def cells():
    """{cell index: source} for the code cells."""
    global _CELLS
    if _CELLS is None:
        nb = json.loads(notebook_path().read_text())
        _CELLS = {i: "".join(c["source"]) for i, c in enumerate(nb["cells"]) if c["cell_type"] == "code"}
    return _CELLS


def _prelude():
    """Everything the notebook's cell 1 imports, minus torch/pandas/faiss/transformers (load them yourself via `extra` when a cell needs them)."""
    import asyncio
    import base64
    import contextlib
    import hashlib
    import io
    import logging
    import math
    import random
    import re
    import sqlite3
    import sys
    import threading
    import time
    import traceback
    import warnings
    from dataclasses import dataclass, field
    from datetime import datetime, timezone
    from enum import Enum
    from typing import Any, Callable, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

    import cv2
    import numpy as np
    from PIL import Image, ImageOps

    try:
        import pymupdf as fitz
    except ImportError:  # pragma: no cover
        import fitz
    from pydantic import BaseModel, Field
    from scipy.ndimage import gaussian_filter
    from scipy.optimize import linear_sum_assignment

    namespace = dict(
        asyncio=asyncio, base64=base64, contextlib=contextlib, hashlib=hashlib, io=io, json=json, logging=logging, math=math, os=os,
        random=random, re=re, sqlite3=sqlite3, sys=sys, threading=threading, time=time, traceback=traceback, warnings=warnings,
        dataclass=dataclass, field=field, datetime=datetime, timezone=timezone, Enum=Enum, Path=Path, Any=Any, Callable=Callable,
        Dict=Dict, Iterable=Iterable, List=List, Mapping=Mapping, Optional=Optional, Sequence=Sequence, Tuple=Tuple, cv2=cv2, np=np,
        Image=Image, ImageOps=ImageOps, fitz=fitz, BaseModel=BaseModel, Field=Field, gaussian_filter=gaussian_filter,
        linear_sum_assignment=linear_sum_assignment,
    )
    namespace["LOGGER"] = logging.getLogger("notebook-oracle")
    return namespace


def _nodes(cell_source):
    tree = ast.parse(cell_source)
    lines = cell_source.splitlines()
    found = {}
    for node in tree.body:
        names = []
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            names = [node.name]
        elif isinstance(node, ast.Assign):
            names = [t.id for t in node.targets if isinstance(t, ast.Name)]
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            names = [node.target.id]
        if not names:
            continue
        start = min([node.lineno] + [d.lineno for d in getattr(node, "decorator_list", [])])
        source = "\n".join(lines[start - 1: node.end_lineno])
        for name in names:
            found[name] = source
    return found


def load(spec, extra=None):
    """Exec the named top-level definitions, in the order given, into one namespace and return it.

    spec: [(cell_index, [name, ...]), ...]  a name is a function, a class, or a top-level constant assignment.
          "*defs" instead of a list means every function and class in that cell (not the assignments).
    extra: names to pre-load into the namespace (for example {"torch": torch, "pd": pandas}).
    """
    namespace = _prelude()
    namespace.update(extra or {})
    for cell_index, names in spec:
        source = cells()[cell_index]
        defs = _nodes(source)
        if names == "*defs":
            tree = ast.parse(source)
            names = [n.name for n in tree.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))]
        for name in names:
            if name not in defs:
                raise KeyError(f"cell {cell_index} has no top-level definition called {name!r}")
            # dont_inherit: this file has `from __future__ import annotations`; the notebook's code must be compiled exactly as written
            # (pydantic models there use real classes as annotations, and a dict namespace is not a module that could resolve strings)
            exec(compile(defs[name], f"<notebook cell {cell_index}: {name}>", "exec", dont_inherit=True), namespace)
    return namespace
