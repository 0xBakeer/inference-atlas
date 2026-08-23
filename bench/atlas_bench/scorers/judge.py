"""LLM-as-judge scorer (stub).

v1 does not ship a judge: judging needs a second model, and a benchmark that silently uses
an unspecified judge is not reproducible. Until a judge model is pinned in the workload
file, judged items are recorded with ``scored: false`` and excluded from accuracy.
"""

from __future__ import annotations

from typing import Any

from . import ScoreResult

__all__ = ["score_judge"]


def score_judge(output: str, row: Any) -> ScoreResult:
    """Always returns ``scored=False`` unless a judge is configured on the row."""
    judge = getattr(row, "extra", {}).get("judge") if hasattr(row, "extra") else None
    detail = (
        "judge model configured on the row but the judge scorer is not implemented in v1"
        if judge
        else "no judge model configured"
    )
    return ScoreResult(
        False,
        predicted=(output or "")[:500],
        expected=str(getattr(row, "answer", "") or "")[:500],
        scored=False,
        detail=detail,
    )
