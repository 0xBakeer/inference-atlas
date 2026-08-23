"""String scorers: ``exact``, ``contains`` and ``needle``."""

from __future__ import annotations

import re
from typing import Any

from . import ScoreResult, collapse_ws, extract_answer, unwrap_boxed

__all__ = ["needle_key", "score_contains", "score_exact", "score_needle"]

_NEEDLE_STRIP_RE = re.compile(r"[ ,\-‐-―]")


def _meta(row: Any) -> dict[str, Any]:
    """The row's ``meta`` block, whatever shape of row object was passed."""
    meta = getattr(row, "meta", None)
    return meta if isinstance(meta, dict) else {}


def score_exact(output: str, row: Any) -> ScoreResult:
    """Case-insensitive comparison after collapsing whitespace.

    ``meta.answer_aliases`` are accepted as well, which is how a row allows "true" for
    "yes" without loosening the comparison for everybody.
    """
    predicted = unwrap_boxed(extract_answer(output))
    answer = getattr(row, "answer", None)
    expected: list[str] = []
    if isinstance(answer, (list, tuple)):
        expected = [str(a) for a in answer]
    elif answer is not None:
        expected = [str(answer)]
    expected += [str(a) for a in _meta(row).get("answer_aliases") or ()]

    got = collapse_ws(predicted)
    for candidate in expected:
        if got == collapse_ws(candidate):
            return ScoreResult(True, predicted, candidate)
    return ScoreResult(False, predicted, expected[0] if expected else "")


def _entry_matches(entry: Any, haystack: str) -> bool:
    """One ``contains`` entry: a string, or a list of alternatives (any one passes)."""
    if isinstance(entry, (list, tuple)):
        return any(_entry_matches(alternative, haystack) for alternative in entry)
    needle = collapse_ws(str(entry))
    return bool(needle) and needle in haystack


def score_contains(output: str, row: Any) -> ScoreResult:
    """``{all: [...], any: [...]}`` casefolded substring matching, no diacritic folding.

    Every entry of ``all`` must occur and at least one entry of ``any``; an entry may itself
    be a list of accepted alternatives.
    """
    answer = getattr(row, "answer", None)
    haystack = collapse_ws(extract_answer(output))
    if isinstance(answer, dict):
        required = list(answer.get("all") or ())
        optional = list(answer.get("any") or ())
    elif isinstance(answer, (list, tuple)):
        required, optional = list(answer), []
    else:
        required, optional = ([answer] if answer is not None else []), []

    hits = [entry for entry in required if _entry_matches(entry, haystack)]
    all_ok = len(hits) == len(required)
    any_ok = not optional or any(_entry_matches(entry, haystack) for entry in optional)
    return ScoreResult(
        bool(required or optional) and all_ok and any_ok,
        predicted=(output or "").strip()[:500],
        expected=str(answer)[:500],
        detail=f"all {len(hits)}/{len(required)}, any {'ok' if any_ok else 'missed'}",
    )


def needle_key(text: str) -> str:
    """Casefold and drop spaces, commas and hyphens — retrieval, not phrasing."""
    return _NEEDLE_STRIP_RE.sub("", collapse_ws(text))


def score_needle(output: str, row: Any) -> ScoreResult:
    """Casefolded substring test of the answer in the extracted output.

    Rows whose ``answer`` is a ``contains`` object (the "absent" category of
    ``eval-longctx-v1``) are delegated to :func:`score_contains`.
    """
    answer = getattr(row, "answer", None)
    if isinstance(answer, dict):
        return score_contains(output, row)
    extracted = extract_answer(output)
    candidates = (
        [str(a) for a in answer] if isinstance(answer, (list, tuple)) else [str(answer or "")]
    )
    haystack = needle_key(extracted)
    for candidate in candidates:
        key = needle_key(candidate)
        if key and key in haystack:
            return ScoreResult(True, extracted[:500], candidate)
    return ScoreResult(False, extracted[:500], candidates[0] if candidates else "")
