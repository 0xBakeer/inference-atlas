"""Scorers turn a model's raw output into ``correct: true|false``.

The normative contract is `datasets/README.md` ("Answer extraction and scorers") plus each
dataset's own ``scoring`` block; this package implements it. Every scorer has the same
signature — ``score(output: str, row: EvalRow) -> ScoreResult`` — so a dataset row selects
its scorer by name and **the row's own ``scorer`` always wins** over the workload default
(``eval-reasoning-v1`` mixes ``mc`` and ``exact``, ``eval-multilingual-v1`` mixes three).

Answer extraction, applied to the raw output before every scorer except ``instruction``:

1. drop everything inside ``<think>…</think>``, including an unterminated leading block;
2. drop markdown code fences, keeping the fenced content;
3. if any line matches ``/^\\s*(?:final answer|answer)\\s*[:-]\\s*(.+)$/i``, keep only the
   capture of the **last** such line;
4. strip surrounding whitespace, matching quotes, and a single trailing ``.`` or ``!``.

Scorers never raise: an unparseable answer is a wrong answer, not a crash. ``scored=False``
means "this item could not be judged at all" (a failed request, a missing judge); those are
excluded from accuracy and counted as failures.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

__all__ = [
    "SCORERS",
    "ScoreResult",
    "collapse_ws",
    "extract_answer",
    "get_scorer",
    "normalize_scorer_name",
    "strip_boxed",
    "strip_fences",
    "strip_think",
    "unwrap_boxed",
]

_WS_RE = re.compile(r"\s+")
_THINK_RE = re.compile(r"<think>.*?</think>", re.DOTALL | re.IGNORECASE)
_UNTERMINATED_THINK_RE = re.compile(r"^\s*<think>.*", re.DOTALL | re.IGNORECASE)
_WHOLE_FENCE_RE = re.compile(r"^\s*```[a-zA-Z0-9_+-]*\s*\n(.*?)\n?\s*```\s*$", re.DOTALL)
_FENCE_LINE_RE = re.compile(r"^\s*```[a-zA-Z0-9_+-]*\s*$", re.MULTILINE)
_ANSWER_LINE_RE = re.compile(
    r"^[ \t]*(?:final answer|answer)[ \t]*[:\-][ \t]*(.+)$", re.IGNORECASE | re.MULTILINE
)
_QUOTE_PAIRS = (('"', '"'), ("'", "'"), ("“", "”"), ("‘", "’"), ("«", "»"), ("`", "`"))


@dataclass
class ScoreResult:
    """Outcome of scoring one eval item."""

    correct: bool
    predicted: str = ""
    expected: str = ""
    scored: bool = True
    detail: str | None = None


def strip_think(text: str) -> str:
    """Drop ``<think>…</think>`` blocks, an unterminated leading one, and an unopened one.

    A closing tag with no opening tag means the chat template opened the block in the prompt
    and the model only had to close it — Granite 4.2 does this, and so do several reasoning
    models. Everything up to that tag is thinking, and leaving it in front of the answer
    corrupts every scorer: the extracted answer becomes a paragraph of deliberation.
    """
    body = _THINK_RE.sub(" ", text or "")
    lowered = body.lower()
    if "<think>" in lowered and "</think>" not in lowered:
        body = _UNTERMINATED_THINK_RE.sub("", body)
    elif "</think>" in lowered and "<think>" not in lowered:
        body = body[lowered.rindex("</think>") + len("</think>") :]
    return body


def strip_fences(text: str) -> str:
    """Drop markdown code fences, keeping the fenced content.

    A response that *is* one fenced block unwraps to its content (the same rule the
    normative ``rules.py`` uses); a response that merely contains fences keeps its prose and
    loses only the fence markers.
    """
    body = text or ""
    whole = _WHOLE_FENCE_RE.match(body)
    if whole:
        return whole.group(1)
    if "```" in body:
        return _FENCE_LINE_RE.sub("", body)
    return body


def strip_boxed(text: str) -> str:
    """Content of the last brace-balanced ``\\boxed{...}``, or the text unchanged."""
    marker = "\\boxed"
    index = (text or "").rfind(marker)
    if index < 0:
        return text or ""
    rest = text[index + len(marker) :].lstrip()
    if not rest.startswith("{"):
        return text
    depth = 0
    for position, char in enumerate(rest):
        if char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return rest[1:position]
    return rest[1:]


def unwrap_boxed(text: str) -> str:
    """Unwrap ``\\boxed{...}`` when present.

    Not part of the dataset's normative extraction — no authored row produces one — but
    real models wrap maths answers in it, and reading through it costs nothing.
    """
    return strip_boxed(text).strip() if "\\boxed" in (text or "") else (text or "")


def _trim_wrapping(text: str) -> str:
    """Strip whitespace, one pair of matching quotes and a single trailing ``.``/``!``."""
    body = (text or "").strip()
    for opening, closing in _QUOTE_PAIRS:
        if len(body) >= 2 and body.startswith(opening) and body.endswith(closing):
            body = body[1:-1].strip()
            break
    if body.endswith((".", "!")):
        # Exactly one character, as the contract says — not a greedy ellipsis strip.
        body = body[:-1].strip()
    return body


def extract_answer(text: str) -> str:
    """The four normative extraction steps of ``datasets/README.md``."""
    body = strip_fences(strip_think(text or ""))
    matches = _ANSWER_LINE_RE.findall(body)
    if matches:
        body = matches[-1]
    return _trim_wrapping(body)


def collapse_ws(text: str) -> str:
    """Collapse internal whitespace and casefold — the ``exact`` comparison basis."""
    return _WS_RE.sub(" ", (text or "").strip()).casefold()


def normalize_scorer_name(name: str | None) -> str:
    """``code-exec`` (workload vocabulary) and ``code_exec`` (row vocabulary) are one scorer."""
    return (name or "exact").strip().lower().replace("-", "_")


#: Populated at the bottom of the module once every scorer is imported.
SCORERS: dict[str, Callable[[str, Any], ScoreResult]] = {}


def get_scorer(name: str | None) -> Callable[[str, Any], ScoreResult]:
    """Look up a scorer by name; unknown names fall back to ``exact``."""
    return SCORERS.get(normalize_scorer_name(name), SCORERS["exact"])


from .code_exec import score_code_exec  # noqa: E402
from .instruction import score_instruction  # noqa: E402
from .integrity import score_integrity  # noqa: E402
from .json_match import score_json  # noqa: E402
from .judge import score_judge  # noqa: E402
from .mc import score_mc  # noqa: E402
from .numeric import score_numeric  # noqa: E402
from .text import score_abstention, score_contains, score_exact, score_needle  # noqa: E402
from .tools import score_tool_call  # noqa: E402
from .vision import score_vision  # noqa: E402

SCORERS.update(
    {
        "exact": score_exact,
        "abstention": score_abstention,
        "contains": score_contains,
        "needle": score_needle,
        "numeric": score_numeric,
        "mc": score_mc,
        "multiple_choice": score_mc,
        "json": score_json,
        "code_exec": score_code_exec,
        "instruction": score_instruction,
        # One scorer, two spellings: `integrity` is the row vocabulary,
        # `token-integrity` the workload one (normalized to `token_integrity`).
        "integrity": score_integrity,
        "token_integrity": score_integrity,
        "vision": score_vision,
        "tool_call": score_tool_call,
        "judge": score_judge,
    }
)
