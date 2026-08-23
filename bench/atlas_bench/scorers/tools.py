"""Tool-calling scorer for ``eval-tools-v1``.

The row's ``scorer`` says ``json``, but the thing being judged is not the text: it is
``tool_calls[0]`` of the response. The runner sends ``meta.tools`` with
``tool_choice: "auto"`` and calls this scorer with the parsed tool calls attached to the row.

- ``answer.tool_call = {name, arguments}`` — the name must match and the arguments must
  match, subset by default (extra optional arguments tolerated) or exactly when
  ``meta.arguments_match == "exact"``. Strings compare case-insensitively after stripping,
  numbers numerically.
- ``answer.tool_call = null`` — correct only when no tool call was made at all. The text of
  the reply is not scored.
"""

from __future__ import annotations

import json
from typing import Any

from . import ScoreResult
from .json_match import is_subset

__all__ = ["parse_arguments", "score_tool_call"]


def parse_arguments(raw: Any) -> Any:
    """Tool-call arguments arrive as a JSON string; return the parsed object."""
    if isinstance(raw, str):
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return None
    return raw


def score_tool_call(output: str, row: Any) -> ScoreResult:
    """Score ``tool_calls[0]`` against ``answer.tool_call``."""
    answer = getattr(row, "answer", None)
    expected = (answer or {}).get("tool_call") if isinstance(answer, dict) else None
    calls = list(getattr(row, "tool_calls", None) or [])
    meta = getattr(row, "meta", None) or {}
    exact = str(meta.get("arguments_match") or "subset").lower() == "exact"

    if expected is None:
        made = ", ".join(str((c.get("function") or {}).get("name")) for c in calls)
        return ScoreResult(
            not calls,
            predicted=f"tool_calls: {made}" if calls else "no tool call",
            expected="no tool call",
            detail=None if not calls else "a tool was called where none was expected",
        )

    if not calls:
        return ScoreResult(
            False,
            predicted=(output or "").strip()[:500] or "no tool call",
            expected=json.dumps(expected, sort_keys=True)[:500],
            detail="no tool call was made",
        )

    function = calls[0].get("function") or {}
    name = str(function.get("name") or "")
    arguments = parse_arguments(function.get("arguments"))
    rendered = json.dumps(
        {"name": name, "arguments": arguments}, sort_keys=True, ensure_ascii=False
    )[:500]
    if name != str(expected.get("name") or ""):
        return ScoreResult(
            False, rendered, json.dumps(expected, sort_keys=True)[:500], detail="wrong tool"
        )
    if arguments is None:
        return ScoreResult(
            False,
            rendered,
            json.dumps(expected, sort_keys=True)[:500],
            detail="arguments were not valid JSON",
        )
    correct = is_subset(
        expected.get("arguments") or {}, arguments, exact=exact, case_insensitive=True
    )
    return ScoreResult(correct, rendered, json.dumps(expected, sort_keys=True)[:500])
