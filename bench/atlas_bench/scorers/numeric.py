"""Numeric scorer.

`datasets/README.md`: parse the **last** number in the extracted output — thousands
separators, a leading currency symbol and a trailing ``%`` are stripped — and accept it when
``abs(got - expected) <= max(meta.tolerance or 1e-6, 1e-9 * abs(expected))``.

Note that ``%`` is *stripped*, not converted: ``"12%"`` parses as ``12``, because the
authored answers are plain numbers in the unit the question asked for.
"""

from __future__ import annotations

from typing import Any

from . import ScoreResult, extract_answer, strip_think, unwrap_boxed

__all__ = ["DEFAULT_TOLERANCE", "last_number", "parse_number", "score_numeric"]

import re

#: Absolute tolerance when a row does not set ``meta.tolerance``.
DEFAULT_TOLERANCE = 1e-6

#: A number with optional sign, thousands separators, decimals and exponent.
_NUMBER_RE = re.compile(r"[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:[eE][-+]?\d+)?")
_LATEX_FRAC = re.compile(r"\\[dt]?frac\s*\{([^{}]+)\}\s*\{([^{}]+)\}")
_CURRENCY = "$€£¥₹"


def _clean(text: str) -> str:
    """Normalize LaTeX spacing, unicode minus and currency before scanning for numbers."""
    body = strip_think(text or "")
    body = _LATEX_FRAC.sub(r"\1/\2", body)
    body = body.replace("\\!", "").replace("\\,", "").replace("\\%", "%")
    body = body.replace("−", "-").replace("–", "-").replace("\\times10^", "e").replace("×10^", "e")
    for symbol in _CURRENCY:
        body = body.replace(symbol, " ")
    return body


def last_number(text: str) -> float | None:
    """The last number appearing in the text, or ``None``."""
    matches = _NUMBER_RE.findall(_clean(text))
    if not matches:
        return None
    try:
        return float(matches[-1].replace(",", ""))
    except ValueError:  # pragma: no cover - the regex guarantees a float-able string
        return None


def parse_number(text: str) -> float | None:
    """Parse a single expected answer (``"193950"``, ``"-4.5"``, ``"12%"``)."""
    return last_number(text)


def score_numeric(output: str, row: Any) -> ScoreResult:
    """Compare the last number of the output with the expected number."""
    raw_expected = getattr(row, "answer", None)
    expected = last_number(str(raw_expected)) if raw_expected is not None else None
    extracted = unwrap_boxed(extract_answer(output))
    predicted = last_number(extracted)
    if predicted is None:
        predicted = last_number(output)

    meta = getattr(row, "meta", None)
    tolerance = float((meta or {}).get("tolerance") or DEFAULT_TOLERANCE)
    if expected is None or predicted is None:
        return ScoreResult(
            False,
            predicted=extracted[:500] or (output or "")[:500],
            expected=str(raw_expected),
            detail="no number parsed",
        )
    allowed = max(tolerance, 1e-9 * abs(expected))
    return ScoreResult(
        abs(predicted - expected) <= allowed, predicted=_fmt(predicted), expected=_fmt(expected)
    )


def _fmt(value: float) -> str:
    """Render a parsed number without a spurious ``.0``."""
    return str(int(value)) if float(value).is_integer() else repr(value)
