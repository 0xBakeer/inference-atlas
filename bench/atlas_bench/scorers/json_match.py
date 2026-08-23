"""JSON scorer: the output must parse as JSON and match the expected value.

``meta.match`` is ``subset`` (default — every key/value of ``answer`` must appear, extra keys
tolerated) or ``exact``. Arrays compare elementwise in order unless ``meta.array_order`` is
false, and numbers compare numerically so ``1`` matches ``1.0``.
"""

from __future__ import annotations

import json
import re
from typing import Any

from . import ScoreResult, extract_answer, strip_fences, strip_think

__all__ = ["extract_json", "is_subset", "score_json", "values_equal"]

_OBJECT_RE = re.compile(r"[{\[].*[}\]]", re.DOTALL)


def extract_json(output: str) -> Any | None:
    """Parse JSON out of a response, tolerating fences and surrounding prose."""
    body = strip_fences(strip_think(output or "")).strip()
    candidates = [body, extract_answer(output)]
    match = _OBJECT_RE.search(body)
    if match:
        candidates.append(match.group(0))
    for candidate in candidates:
        if not candidate:
            continue
        try:
            return json.loads(candidate)
        except (json.JSONDecodeError, TypeError):
            continue
    return None


def _number(value: Any) -> float | None:
    """A JSON number (booleans are not numbers)."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value)


def values_equal(expected: Any, actual: Any, *, case_insensitive: bool = False) -> bool:
    """Scalar comparison: numbers numerically, strings optionally case-insensitively."""
    left, right = _number(expected), _number(actual)
    if left is not None and right is not None:
        return left == right
    if isinstance(expected, str) and isinstance(actual, str) and case_insensitive:
        return expected.strip().casefold() == actual.strip().casefold()
    return expected == actual


def is_subset(
    expected: Any,
    actual: Any,
    *,
    exact: bool = False,
    array_order: bool = True,
    case_insensitive: bool = False,
) -> bool:
    """True when ``actual`` matches ``expected`` under the row's match rules."""
    kwargs = {"exact": exact, "array_order": array_order, "case_insensitive": case_insensitive}
    if isinstance(expected, dict):
        if not isinstance(actual, dict):
            return False
        if exact and set(actual) != set(expected):
            return False
        return all(
            key in actual and is_subset(value, actual[key], **kwargs)
            for key, value in expected.items()
        )
    if isinstance(expected, list):
        if not isinstance(actual, list):
            return False
        if array_order:
            if exact and len(actual) != len(expected):
                return False
            if len(actual) < len(expected):
                return False
            return all(is_subset(item, actual[i], **kwargs) for i, item in enumerate(expected))
        if exact and len(actual) != len(expected):
            return False
        remaining = list(actual)
        for item in expected:
            for index, candidate in enumerate(remaining):
                if is_subset(item, candidate, **kwargs):
                    remaining.pop(index)
                    break
            else:
                return False
        return True
    return values_equal(expected, actual, case_insensitive=case_insensitive)


def score_json(output: str, row: Any) -> ScoreResult:
    """Valid JSON is the baseline; an expected value must match under ``meta.match``."""
    parsed = extract_json(output)
    if parsed is None:
        return ScoreResult(
            False,
            predicted=(output or "").strip()[:500],
            expected="<json>",
            detail="not valid JSON",
        )
    meta = getattr(row, "meta", None) or {}
    expected = getattr(row, "answer", None)
    if isinstance(expected, str):
        try:
            expected = json.loads(expected)
        except json.JSONDecodeError:
            expected = None
    rendered = json.dumps(parsed, sort_keys=True, separators=(",", ":"), ensure_ascii=False)[:500]
    if expected is None:
        return ScoreResult(True, predicted=rendered, expected="<valid json>")
    correct = is_subset(
        expected,
        parsed,
        exact=str(meta.get("match") or "subset").lower() == "exact",
        array_order=meta.get("array_order", True) is not False,
    )
    return ScoreResult(
        correct,
        predicted=rendered,
        expected=json.dumps(expected, sort_keys=True, separators=(",", ":"), ensure_ascii=False)[
            :500
        ],
    )
