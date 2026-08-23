"""Instruction-following scorer.

`eval-instruction-v1` ships the normative implementation of its rule DSL next to the data
(`datasets/eval-instruction-v1/rules.py`, ``evaluate(answer, text) -> (passed, failed)``).
Re-implementing the DSL here would guarantee a slow drift between the harness and the
dataset, so the module is imported from the dataset directory and called on the **raw**
output — the extraction steps would destroy exactly what these rows test (fences, casing,
leading "Answer:" text, trailing punctuation).
"""

from __future__ import annotations

import importlib.util
from pathlib import Path
from typing import Any

from . import ScoreResult

__all__ = ["load_rules", "score_instruction"]

_CACHE: dict[Path, Any] = {}


def load_rules(dataset_dir: Path | str | None) -> Any | None:
    """Import ``rules.py`` from a dataset directory (cached), or ``None`` when absent."""
    if dataset_dir is None:
        return None
    path = Path(dataset_dir) / "rules.py"
    if not path.is_file():
        return None
    resolved = path.resolve()
    if resolved not in _CACHE:
        spec = importlib.util.spec_from_file_location(
            f"atlas_rules_{resolved.parent.name}", resolved
        )
        if spec is None or spec.loader is None:  # pragma: no cover - defensive
            return None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        _CACHE[resolved] = module if hasattr(module, "evaluate") else None
    return _CACHE[resolved]


def score_instruction(output: str, row: Any) -> ScoreResult:
    """Evaluate the row's rule set against the raw output."""
    answer = getattr(row, "answer", None)
    if not isinstance(answer, dict) or not answer.get("all"):
        return ScoreResult(
            False,
            predicted=(output or "")[:500],
            expected="<rules>",
            scored=False,
            detail="row carries no instruction rule set",
        )
    rules = load_rules(getattr(row, "dataset_dir", None))
    if rules is None:
        return ScoreResult(
            False,
            predicted=(output or "")[:500],
            expected="<rules>",
            scored=False,
            detail="datasets/<id>/rules.py not found; cannot judge instruction rows",
        )
    try:
        passed, failed = rules.evaluate(answer, output or "")
    except Exception as exc:
        return ScoreResult(
            False,
            predicted=(output or "")[:500],
            expected="<rules>",
            scored=False,
            detail=f"rule evaluation failed: {type(exc).__name__}: {exc}",
        )
    names = ", ".join(str(rule.get("rule")) for rule in failed)
    return ScoreResult(
        bool(passed),
        predicted=(output or "")[:500],
        expected=f"{len(answer['all'])} rules",
        detail=None if passed else f"failed: {names}",
    )
