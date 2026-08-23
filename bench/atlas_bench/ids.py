"""Identifier computation (SPEC §2).

Every id in the Atlas is derived, never typed by hand:

* ``config_id`` — ``sha256(canonical)[:16]``
* ``cell_id``   — ``sha256("model|quant|hardware|count|engine|engine_minor")[:12]``
* ``run_id``    — ``<config_id>--<workload_id>--<sha256(login|started_at)[:6]>``
* result path   — ``results/<engine>/<model>/<hardware>/<run_id>.json``
"""

from __future__ import annotations

import hashlib
import re
from pathlib import PurePosixPath
from typing import Any

from .canonical import CanonicalInput, canonicalize

__all__ = [
    "ID_RE",
    "cell_id",
    "config_id",
    "engine_minor",
    "is_valid_id",
    "result_path",
    "run_id",
    "run_suffix",
    "sha256_hex",
    "slugify_id",
]

#: Registry ids are lowercase kebab-case (SPEC §2).
ID_RE = re.compile(r"^[a-z0-9][a-z0-9.-]*$")


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


def result_path(*, engine_id: str, model_id: str, hardware_id: str, rid: str) -> PurePosixPath:
    """Repo-relative path a result file must live at."""
    return PurePosixPath("results") / engine_id / model_id / hardware_id / f"{rid}.json"


def is_valid_id(value: Any) -> bool:
    """True when ``value`` is a well-formed registry id."""
    return isinstance(value, str) and bool(ID_RE.match(value))


def slugify_id(text: str) -> str:
    """Best-effort conversion of a free-form name into a registry-shaped id."""
    slug = re.sub(r"[^a-z0-9.]+", "-", text.strip().lower())
    slug = re.sub(r"-{2,}", "-", slug).strip("-.")
    return slug or "unknown"
