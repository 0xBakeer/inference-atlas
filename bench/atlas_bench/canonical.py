"""Canonicalization of engine configuration (SPEC §3).

This is a line-by-line port of ``packages/core/src/canonical.ts``; the two implementations
are pinned against the same golden vectors in ``schemas/fixtures/fingerprint-vectors.json``.
Where a behaviour looks odd (``Number("")`` is ``0``, arrays are sorted by their *rendered*
form, a ``null`` default never drops a flag) it is odd in both languages on purpose.

Pipeline (SPEC §3):

1. normalize keys (trim, lowercase, strip leading dashes, ``_`` → ``-``) and resolve aliases
2. drop ``drop_params`` and any value equal to the engine version's default
3. normalize values to strings, using the declared/inferred param type
4. prepend the pseudo params ``@quant`` and ``@dtype``
5. sort keys by byte order and join as ``k=v;k=v``
6. ``config_id = sha256(canonical)[:16]``
"""

from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any

__all__ = [
    "MAX_DECIMALS",
    "CanonicalInput",
    "CanonicalResult",
    "ParamSpec",
    "canonicalize",
    "canonicalize_full",
    "infer_type",
    "normalize_key",
    "normalize_number",
    "normalize_value",
    "stable_json",
]

#: Numbers keep at most this many decimal places (``Math.round(n * 1e6) / 1e6`` in TS).
MAX_DECIMALS = 6

_TRUEISH = frozenset({"true", "yes", "on", "1"})
_FALSEISH = frozenset({"false", "no", "off", "0"})
_JS_NUMERIC_RE = re.compile(r"^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$")


@dataclass(frozen=True)
class ParamSpec:
    """The subset of an engine-version param that canonicalization needs."""

    name: str
    default: Any = None
    aliases: tuple[str, ...] = ()
    type: str | None = None
    #: Distinguishes "no default declared" from "declared null" (TS ``undefined`` vs ``null``).
    has_default: bool = True


@dataclass(frozen=True)
class CanonicalInput:
    """Canonicalization input — the same shape as a fixture ``input`` block."""

    engine_id: str = ""
    engine_version: str | None = None
    args: dict[str, Any] = field(default_factory=dict)
    quant_id: str = "bf16"
    dtype: str | None = None
    #: ``None`` means "unknown engine version": nothing is dropped as a default.
    params: tuple[ParamSpec, ...] | None = None
    drop_params: tuple[str, ...] = ()
    param_aliases: dict[str, str] = field(default_factory=dict)
    #: Identity of the engine BUILD when the version string alone does not pin it: a container
    #: digest, or ``<fork repo>@<fork ref>``. Required for engine versions registered as forks.
    build: str | None = None

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> CanonicalInput:
        """Build from the JSON shape used by ``schemas/fixtures/fingerprint-vectors.json``."""
        raw_params = raw.get("params")
        params: tuple[ParamSpec, ...] | None = None
        if raw_params is not None:
            params = tuple(
                ParamSpec(
                    name=str(p.get("name", "")),
                    default=p.get("default"),
                    aliases=tuple(str(a) for a in p.get("aliases") or ()),
                    type=p.get("type"),
                    has_default="default" in p,
                )
                for p in raw_params
            )
        return cls(
            engine_id=str(raw.get("engine_id", "")),
            engine_version=raw.get("engine_version"),
            args=dict(raw.get("args") or {}),
            quant_id=str(raw.get("quant_id") or ""),
            dtype=raw.get("dtype"),
            params=params,
            drop_params=tuple(str(d) for d in raw.get("drop_params") or ()),
            param_aliases={str(k): str(v) for k, v in (raw.get("param_aliases") or {}).items()},
            build=raw.get("build"),
        )


@dataclass(frozen=True)
class CanonicalResult:
    """Canonical string, its ``config_id`` and the surviving key/value pairs."""

    canonical: str
    config_id: str
    resolved: dict[str, str]


def normalize_key(key: str) -> str:
    """Trim, lowercase, strip leading dashes, ``_`` → ``-``. Applied to names and aliases."""
    return re.sub(r"^-+", "", key.strip().lower()).replace("_", "-")


# --------------------------------------------------------------------- numbers


def _js_number_to_string(value: float) -> str:
    """``String(value)`` as ECMAScript defines it, for a finite double.

    Python's ``repr`` produces the same shortest round-trip digits but a different layout
    (it switches to exponent notation at 1e16 and 1e-4, JavaScript at 1e21 and 1e-6), so the
    digits are re-laid-out here instead of trusting ``repr``.
    """
    if value == 0:
        return "0"
    sign = "-" if value < 0 else ""
    digits_tuple = Decimal(repr(abs(value))).as_tuple()
    digits = list(digits_tuple.digits)
    exponent = int(digits_tuple.exponent)
    while len(digits) > 1 and digits[-1] == 0:
        digits.pop()
        exponent += 1
    rendered = "".join(str(d) for d in digits)
    count = len(rendered)
    point = count + exponent  # value == 0.<rendered> * 10**point
    if count <= point <= 21:
        return sign + rendered + "0" * (point - count)
    if 0 < point <= 21:
        return f"{sign}{rendered[:point]}.{rendered[point:]}"
    if -6 < point <= 0:
        return f"{sign}0.{'0' * -point}{rendered}"
    mantissa = rendered[0] + (f".{rendered[1:]}" if count > 1 else "")
    exp = point - 1
    return f"{sign}{mantissa}e{'+' if exp >= 0 else '-'}{abs(exp)}"


def normalize_number(value: float | int) -> str:
    """Shortest round-trip decimal with at most :data:`MAX_DECIMALS` decimal places.

    ``0.90 → "0.9"``, ``8192 → "8192"``, ``0.8800000000000001 → "0.88"``.
    """
    number = float(value)
    if math.isnan(number):
        return "NaN"
    if math.isinf(number):
        return "Infinity" if number > 0 else "-Infinity"
    if number.is_integer() and abs(number) < 1e21:
        return str(int(number))
    scaled = number * 1e6
    if math.isinf(scaled):  # pragma: no cover - only for absurd magnitudes
        return _js_number_to_string(number)
    # Math.round() rounds halves towards +Infinity, unlike Python's banker's rounding.
    rounded = math.floor(scaled + 0.5) / 1e6
    return _js_number_to_string(rounded)


def _js_number(text: str) -> float:
    """``Number(string)`` semantics: empty/whitespace is 0, garbage is NaN."""
    stripped = text.strip()
    if not stripped:
        return 0.0
    lowered = stripped.lower()
    if lowered in ("infinity", "+infinity"):
        return math.inf
    if lowered == "-infinity":
        return -math.inf
    if lowered.startswith(("0x", "-0x", "+0x")):
        try:
            return float(int(stripped, 16))
        except ValueError:
            return math.nan
    if not _JS_NUMERIC_RE.match(stripped):
        return math.nan
    try:
        return float(stripped)
    except ValueError:  # pragma: no cover - regex already guarantees this parses
        return math.nan


# ----------------------------------------------------------------- json / types


def _json_string(value: str) -> str:
    """``JSON.stringify`` of a string (quotes + minimal escaping, non-ASCII kept)."""
    return json.dumps(value, ensure_ascii=False)


def stable_json(value: Any) -> str:
    """JSON with object keys sorted and array elements sorted by their rendered form."""
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (list, tuple)):
        parts = sorted(stable_json(item) for item in value)
        return "[" + ",".join(parts) + "]"
    if isinstance(value, dict):
        keys = sorted(str(k) for k in value)
        return "{" + ",".join(f"{_json_string(k)}:{stable_json(value[k])}" for k in keys) + "}"
    if isinstance(value, (int, float)):
        return normalize_number(value)
    return _json_string(str(value))


def _try_parse_json(text: str) -> Any | None:
    """Parse a string that looks like a JSON object/array; ``None`` when it is neither."""
    if not (text.startswith("{") or text.startswith("[")):
        return None
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return None


def infer_type(default: Any, has_default: bool = True) -> str | None:
    """Infer a param type from its declared default (``None``/absent → unknown)."""
    if not has_default or default is None:
        return None
    if isinstance(default, bool):
        return "bool"
    if isinstance(default, int):
        return "int"
    if isinstance(default, float):
        return "int" if float(default).is_integer() else "float"
    if isinstance(default, (list, tuple)):
        return "list"
    if isinstance(default, dict):
        return "json"
    return "str"


def normalize_value(value: Any, type_: str | None = None) -> str:
    """Normalize one argument value to its canonical string.

    ``type_`` is the declared param type when the engine version is known; without it the
    value's own type decides, which is why ``--enable-prefix-caching 1`` only folds to
    ``true`` for engines whose version file says the flag is a bool.
    """
    if value is None:
        return ""

    if type_ == "bool":
        if isinstance(value, bool):
            return "true" if value else "false"
        if isinstance(value, (int, float)):
            return "true" if value != 0 else "false"
        text = str(value).strip().lower()
        if text in _TRUEISH:
            return "true"
        if text in _FALSEISH:
            return "false"
        return text

    if type_ in ("int", "float"):
        if isinstance(value, bool):
            number = 1.0 if value else 0.0
        elif isinstance(value, (int, float)):
            number = float(value)
        else:
            number = _js_number(str(value))
        if not math.isnan(number):
            return normalize_number(number)
        return str(value).strip()

    if type_ in ("json", "list"):
        if isinstance(value, str):
            text = value.strip()
            parsed = _try_parse_json(text)
            return stable_json(parsed) if parsed is not None else text
        return stable_json(value)

    # Unknown / string-typed param: the value's own shape decides.
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return normalize_number(value)
    if isinstance(value, (dict, list, tuple)):
        return stable_json(value)

    text = str(value).strip()
    # A string that is JSON is JSON, whatever the version file thinks: this is how a
    # `--speculative-config '{...}'` from a shell command line reaches us.
    parsed = _try_parse_json(text)
    if parsed is not None:
        return stable_json(parsed)
    lowered = text.lower()
    if lowered in ("true", "false"):
        return lowered
    return text


# ------------------------------------------------------------- canonicalization


def canonicalize_full(inp: CanonicalInput) -> CanonicalResult:
    """SPEC §3 steps 1–6, returning the canonical string, the id and the surviving pairs."""
    by_name: dict[str, ParamSpec] = {}
    alias_map: dict[str, str] = {}

    for alias, target in (inp.param_aliases or {}).items():
        alias_map[normalize_key(alias)] = normalize_key(target)
    for param in inp.params or ():
        name = normalize_key(param.name)
        by_name[name] = param
        for alias in param.aliases:
            alias_map[normalize_key(alias)] = name

    dropped = {normalize_key(d) for d in inp.drop_params or ()}

    resolved: dict[str, str] = {}
    for raw_key, raw_value in (inp.args or {}).items():
        key = normalize_key(str(raw_key))
        key = alias_map.get(key, key)
        if not key or key in dropped:
            continue
        # A null value means "flag not passed"; it must not change the fingerprint.
        if raw_value is None:
            continue

        param = by_name.get(key)
        type_ = (
            param.type
            if param and param.type
            else infer_type(param.default if param else None, param.has_default if param else False)
        )
        value = normalize_value(raw_value, type_)

        # Unknown engine version → params is None → nothing is a known default.
        if (
            param is not None
            and param.has_default
            and param.default is not None
            and value == normalize_value(param.default, type_)
        ):
            continue

        resolved[key] = value

    resolved["@quant"] = (inp.quant_id or "").strip().lower()
    resolved["@dtype"] = (inp.dtype or "auto").strip().lower() or "auto"

    # ``@build`` distinguishes engine builds that share a version string (SPEC §3, decision
    # 24). A fork's version is usually ``<upstream release>+g<upstream sha>``: it names the
    # commit the fork branched from, not the fork's own patches, so two people patching the
    # same upstream commit differently produce the same string and land on the same
    # fingerprint. Omitted when absent, so results recorded before this existed keep their id.
    build = (getattr(inp, "build", None) or "").strip().lower()
    if build:
        resolved["@build"] = build

    canonical = ";".join(f"{key}={resolved[key]}" for key in sorted(resolved))
    return CanonicalResult(
        canonical=canonical,
        config_id=_sha256_hex(canonical)[:16],
        resolved=resolved,
    )


def canonicalize(inp: CanonicalInput) -> str:
    """The canonical ``k=v;k=v`` string for an engine configuration."""
    return canonicalize_full(inp).canonical


def _sha256_hex(text: str) -> str:
    """Local import to keep :mod:`atlas_bench.ids` free to import this module."""
    import hashlib

    return hashlib.sha256(text.encode("utf-8")).hexdigest()
