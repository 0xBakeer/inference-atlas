"""Multiple-choice scorer: a bare letter, ``A)``, ``(A)``, ``A.`` or the full choice text."""

from __future__ import annotations

import re
from typing import Any

from . import ScoreResult, collapse_ws, extract_answer, strip_think

__all__ = ["extract_letter", "score_mc"]

_LETTER_PATTERNS = (
    re.compile(r"^\(?([A-Za-z])\)?[.):]?$"),
    re.compile(r"\b(?:answer|option|choice)\s*(?:is)?\s*[:\-]?\s*\(?([A-Za-z])\)?\b", re.I),
    re.compile(r"^\s*\(?([A-Za-z])\)?\s*[.):]"),
    re.compile(r"\*\*\s*\(?([A-Za-z])\)?\s*\*\*"),
)


def extract_letter(text: str, valid: str = "ABCDEFGH") -> str | None:
    """Find the answer letter in a response, preferring explicit answer forms."""
    body = strip_think(text or "").strip()
    if not body:
        return None
    for candidate in (extract_answer(body) or body, body):
        stripped = candidate.strip()
        for pattern in _LETTER_PATTERNS:
            match = pattern.search(stripped)
            if match and match.group(1).upper() in valid:
                return match.group(1).upper()
    match = re.search(rf"\b([{valid}])\b", extract_answer(body) or body)
    return match.group(1).upper() if match else None


def score_mc(output: str, row: Any) -> ScoreResult:
    """Compare the extracted letter with the expected letter.

    A model that answered with the option text instead of a letter is mapped back onto its
    letter through ``row.choices``.
    """
    raw_expected = str(getattr(row, "answer", "") or "").strip()
    choices = list(getattr(row, "choices", None) or [])
    valid = "".join(chr(ord("A") + i) for i in range(max(len(choices), 8)))
    expected = raw_expected.upper()[:1]
    if len(raw_expected) > 1 and choices:
        for index, choice in enumerate(choices):
            if collapse_ws(choice) == collapse_ws(raw_expected):
                expected = chr(ord("A") + index)
                break

    predicted = extract_letter(output, valid)
    if predicted is None and choices:
        answer_text = collapse_ws(extract_answer(output) or output)
        for index, choice in enumerate(choices):
            text = collapse_ws(choice)
            if text and (answer_text == text or answer_text.endswith(text)):
                predicted = chr(ord("A") + index)
                break
    return ScoreResult(
        bool(predicted) and predicted == expected,
        predicted=predicted or (output or "").strip()[:120],
        expected=expected,
    )
