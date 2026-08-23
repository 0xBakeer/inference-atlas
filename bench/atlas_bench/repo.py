"""Locating the Atlas repository and reading JSON out of it.

The harness is normally run from inside a checkout, but it must also work when it is
installed elsewhere and pointed at a checkout with ``--repo`` / ``--registry-dir``.
Everything here is tolerant: a missing registry is a warning, never a crash, because a
contributor may be measuring hardware that does not have a file yet.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

__all__ = ["REGISTRY_DIRS", "find_repo_root", "read_json", "write_json"]

#: Directories that make a checkout recognizable as an Atlas repo.
REGISTRY_DIRS = ("schemas", "hardware", "engines", "models", "workloads", "results")


def find_repo_root(start: Path | str | None = None) -> Path | None:
    """Walk upwards from ``start`` looking for an Atlas checkout.

    ``ATLAS_REPO`` overrides the search. Returns ``None`` when nothing looks like a
    checkout, in which case the caller falls back to the current directory.
    """
    env = os.environ.get("ATLAS_REPO")
    if env:
        candidate = Path(env).expanduser().resolve()
        if candidate.is_dir():
            return candidate
    here = Path(start or Path.cwd()).expanduser().resolve()
    for directory in [here, *here.parents]:
        hits = sum(1 for name in REGISTRY_DIRS if (directory / name).is_dir())
        if hits >= 3 and (directory / "docs" / "SPEC.md").exists():
            return directory
        if hits >= 5:
            return directory
    return None


def read_json(path: Path | str) -> Any | None:
    """Read a JSON file, returning ``None`` when it does not exist."""
    p = Path(path)
    if not p.is_file():
        return None
    with p.open(encoding="utf-8") as fh:
        return json.load(fh)


def write_json(path: Path | str, data: Any, *, indent: int = 2) -> Path:
    """Write pretty JSON with a trailing newline (matches the repo's Prettier style)."""
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(data, indent=indent, ensure_ascii=False, sort_keys=False)
    p.write_text(text + "\n", encoding="utf-8")
    return p
