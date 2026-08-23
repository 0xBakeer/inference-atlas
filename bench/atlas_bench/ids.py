"""Identifier computation (SPEC §2).

Every id in the Atlas is derived, never typed by hand:

* ``config_id`` — ``sha256(canonical)[:16]``
* ``cell_id``   — ``sha256("model|quant|hardware|count|engine|engine_minor")[:12]``
* ``run_id``    — ``<config_id>--<workload_id>--<sha256(login|started_at)[:6]>``
* result path   — ``results/<engine>/<owner>/<name>/<hardware>/<run_id>.json``, where
  ``<owner>/<name>`` is the Hugging Face model id (SPEC §2, decision 20)
"""

from __future__ import annotations

import hashlib
import re
from pathlib import PurePosixPath
from typing import Any

from .canonical import CanonicalInput, canonicalize

__all__ = [
    "ID_RE",
    "MODEL_ID_RE",
    "cell_id",
    "config_id",
    "engine_minor",
    "is_valid_id",
    "is_valid_model_id",
    "model_parts",
    "model_slug",
    "parse_result_path",
    "result_path",
    "run_id",
    "run_suffix",
    "sha256_hex",
    "slugify_id",
]

#: Registry ids other than ``model_id`` are lowercase kebab-case (SPEC §2).
ID_RE = re.compile(r"^[a-z0-9][a-z0-9.-]*$")

#: ``model_id`` is the Hugging Face repo id, verbatim and case-preserved, exactly one slash.
MODEL_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._-]*$")

#: Characters a model slug may keep; every other character becomes ``-``.
_SLUG_KEEP_RE = re.compile(r"[^a-z0-9.-]")


def sha256_hex(text: str) -> str:
    """Hex sha256 of the UTF-8 encoding of ``text``."""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def config_id(inp: CanonicalInput) -> str:
    """16 hex chars of ``sha256`` over the canonical config string."""
    return sha256_hex(canonicalize(inp))[:16]


def config_id_from_canonical(canonical: str) -> str:
    """16 hex chars of ``sha256`` over an already canonicalized string."""
    return sha256_hex(canonical)[:16]


_MINOR_RE = re.compile(r"^v?(\d+)\.(\d+)")


def engine_minor(version: str) -> str:
    """First two components of a version.

    ``0.27.1 → 0.27``, ``v1.2.3 → 1.2``, ``0.26.1.dev0+g568afb3a1 → 0.26``. Version schemes
    that are not dotted numbers (llama.cpp's ``b7000``, LM Studio's dates) have no minor to
    speak of and are returned lowercased and trimmed, so each build is its own square.
    """
    cleaned = str(version).strip().lower()
    match = _MINOR_RE.match(cleaned)
    return f"{match.group(1)}.{match.group(2)}" if match else cleaned


def cell_id(
    *,
    model_id: str,
    quant_id: str,
    hardware_id: str,
    hw_count: int,
    engine_id: str,
    engine_version: str,
) -> str:
    """12 hex chars identifying one square of the coverage map."""
    key = "|".join(
        [
            model_id,
            quant_id,
            hardware_id,
            str(int(hw_count)),
            engine_id,
            engine_minor(engine_version),
        ]
    )
    return sha256_hex(key)[:12]


def run_suffix(github_login: str, started_at: str) -> str:
    """6 hex chars distinguishing two runs of the same config+workload."""
    return sha256_hex(f"{github_login}|{started_at}")[:6]


def run_id(*, cfg_id: str, workload_id: str, github_login: str, started_at: str) -> str:
    """``<config_id>--<workload_id>--<suffix>``."""
    return f"{cfg_id}--{workload_id}--{run_suffix(github_login, started_at)}"


def model_parts(model_id: str) -> tuple[str, str]:
    """Split a Hugging Face model id into ``(owner, name)``.

    The two halves are directory levels everywhere: ``models/<owner>/<name>/`` and
    ``results/<engine>/<owner>/<name>/<hardware>/``. Nothing here lowercases or rewrites
    them — the id is the repo id, verbatim (SPEC §2, decision 20).
    """
    owner, _, name = str(model_id).partition("/")
    return owner, name


def model_slug(model_id: str) -> str:
    """Filesystem/branch-safe rendering of a model id: lowercased, ``[^a-z0-9.-]`` to ``-``.

    Used for branch names and nothing else. It is lossy on purpose (``Qwen/Qwen3.8-27B`` and
    ``qwen/qwen3.8-27b`` slug identically) and is never written into a result file, so it can
    never be mistaken for the id itself.
    """
    return _SLUG_KEEP_RE.sub("-", str(model_id).lower())


def result_path(*, engine_id: str, model_id: str, hardware_id: str, rid: str) -> PurePosixPath:
    """Repo-relative path a result file must live at.

    ``<owner>/<name>`` is the model id, so the path has one more level than the other
    registries: ``results/<engine>/<owner>/<name>/<hardware>/<run_id>.json``.
    """
    owner, name = model_parts(model_id)
    parts = [part for part in (owner, name) if part]
    return PurePosixPath("results", engine_id, *parts, hardware_id, f"{rid}.json")


def parse_result_path(path: str | PurePosixPath) -> dict[str, str] | None:
    """Inverse of :func:`result_path`; ``None`` when the path is not a result file.

    Reads the *tail* of the path, so it works on repo-relative and absolute paths alike.
    """
    parts = PurePosixPath(str(path).replace("\\", "/")).parts
    if len(parts) < 6 or not parts[-1].endswith(".json") or parts[-6] != "results":
        return None
    engine, owner, name, hardware, filename = parts[-5:]
    return {
        "engine_id": engine,
        "model_id": f"{owner}/{name}",
        "hardware_id": hardware,
        "run_id": filename[: -len(".json")],
    }


def is_valid_id(value: Any) -> bool:
    """True when ``value`` is a well-formed lowercase kebab-case registry id."""
    return isinstance(value, str) and bool(ID_RE.match(value))


def is_valid_model_id(value: Any) -> bool:
    """True when ``value`` is a Hugging Face repo id: ``<owner>/<name>``, exactly one slash."""
    return isinstance(value, str) and bool(MODEL_ID_RE.match(value))


def slugify_id(text: str) -> str:
    """Best-effort conversion of a free-form name into a registry-shaped id."""
    slug = re.sub(r"[^a-z0-9.]+", "-", text.strip().lower())
    slug = re.sub(r"-{2,}", "-", slug).strip("-.")
    return slug or "unknown"
