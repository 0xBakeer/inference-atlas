"""Vision scorer: the image is attached by the runner, then the row's own scorer applies.

`eval-vision-v1` rows carry ``scorer: "exact"`` while the workload names ``vision``; the two
are the same thing, because what makes a row a vision row is ``row.image``, not the scorer.
This entry exists so a workload-level ``vision`` never falls through to the wrong scorer.
"""

from __future__ import annotations

from typing import Any

from . import ScoreResult, get_scorer, normalize_scorer_name

__all__ = ["score_vision"]


def score_vision(output: str, row: Any) -> ScoreResult:
    """Delegate to the row's own scorer (``exact`` when the row only says ``vision``)."""
    name = normalize_scorer_name(getattr(row, "scorer", None))
    return get_scorer("exact" if name == "vision" else name)(output, row)
