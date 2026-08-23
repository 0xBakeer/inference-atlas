"""Scorers: an unparseable answer is a wrong answer, never a crash."""

from __future__ import annotations

import pytest

from atlas_bench.data import EvalRow
from atlas_bench.scorers import (
    collapse_ws,
    extract_answer,
    get_scorer,
    strip_boxed,
    strip_fences,
    strip_think,
)
from atlas_bench.scorers.code_exec import extract_code
from atlas_bench.scorers.json_match import extract_json, is_subset
from atlas_bench.scorers.mc import extract_letter
from atlas_bench.scorers.numeric import last_number, parse_number


def row(**kwargs) -> EvalRow:
    """An eval row with sensible defaults."""
    kwargs.setdefault("id", "item-1")
    kwargs.setdefault("messages", [{"role": "user", "content": "q"}])
    return EvalRow(**kwargs)


def score(name: str, output: str, **row_kwargs):
    """Run a scorer by name."""
    return get_scorer(name)(output, row(**row_kwargs))


# ------------------------------------------------------------------ extraction


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("The answer is 42.", "The answer is 42"),
        ("Long reasoning...\nAnswer: 42", "42"),
        ("Final answer: blue", "blue"),
        ("first\nAnswer: one\nlater\nAnswer: two", "two"),
        ("<think>hidden 7</think>\nAnswer: 9", "9"),
        ("<think>never closed, answer is 7", ""),
        ('```json\n{"a": 1}\n```', '{"a": 1}'),
        ('"quoted answer"', "quoted answer"),
        ("Paris.", "Paris"),
        ("Wait...", "Wait.."),
        ("", ""),
    ],
)
def test_extract_answer(text: str, expected: str) -> None:
    """The four normative steps: think, fences, last Answer: line, trimming."""
    assert extract_answer(text) == expected


def test_extraction_helpers() -> None:
    """Each step in isolation."""
    assert strip_think("<think>x</think>keep").strip() == "keep"
    assert strip_fences("```py\ncode\n```") == "code"
    assert strip_fences("prose\n```\ncode\n```\nmore").strip().splitlines()[0] == "prose"
    assert collapse_ws("  The   Answer ") == "the answer"


def test_strip_boxed_is_brace_balanced() -> None:
    """Nested braces inside \\boxed{} survive."""
    assert strip_boxed(r"x = \boxed{\frac{a}{b}}") == r"\frac{a}{b}"
    assert strip_boxed("no box here") == "no box here"


def test_collapse_ws_is_case_and_space_insensitive_only() -> None:
    """Punctuation is *not* stripped: the contract says whitespace and case only."""
    assert collapse_ws("  The  Answer ") == "the answer"
    assert collapse_ws("A, B") == "a, b"


# ----------------------------------------------------------------------- exact


@pytest.mark.parametrize(
    ("output", "answer", "correct"),
    [
        ("Answer: Paris", "Paris", True),
        ("answer: paris.", "Paris", True),
        ("Paris", "Paris", True),
        (r"\boxed{Paris}", "Paris", True),
        ("Answer: Lyon", "Paris", False),
        ("The answer is 12", "2", False),
        ("Answer: 2", "2", True),
        ("Answer: red", ["blue", "red"], True),
    ],
)
def test_exact(output: str, answer, correct: bool) -> None:
    """Case-insensitive equality after collapsing whitespace, on the extracted answer."""
    assert score("exact", output, answer=answer).correct is correct


def test_exact_accepts_meta_answer_aliases() -> None:
    """``meta.answer_aliases`` is how eval-format-v1 allows a second spelling."""
    assert score("exact", "TRUE", answer="true").correct
    assert score("exact", "yes", answer="true", meta={"answer_aliases": ["yes"]}).correct
    assert score("exact", "nope", answer="true", meta={"answer_aliases": ["yes"]}).correct is False


# --------------------------------------------------------------------- numeric


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("42", 42.0),
        ("1,234.5", 1234.5),
        ("$1,000", 1000.0),
        # A trailing % is stripped, not converted: the authored answers are plain numbers.
        ("12 %", 12.0),
        ("1.2e3", 1200.0),
        ("-5 kg", -5.0),
        ("first 1 then 2 then 3", 3.0),
        ("nonsense", None),
    ],
)
def test_parse_number(text: str, expected) -> None:
    """The last number in the text, with separators and currency stripped."""
    assert parse_number(text) == expected


def test_numeric_scoring() -> None:
    """The number is extracted from the final answer, not from the reasoning."""
    assert score("numeric", "Let me think: 7 times 6.\nAnswer: 42", answer="42").correct
    assert score("numeric", r"\boxed{193950}", answer="193950").correct
    assert score("numeric", "Answer: 43", answer="42").correct is False
    assert score("numeric", "I refuse", answer="42").correct is False
    assert score(
        "numeric", "Answer: 0.333333", answer="0.3333333", meta={"tolerance": 1e-4}
    ).correct
    assert (
        score("numeric", "Answer: 0.34", answer="0.3333333", meta={"tolerance": 1e-4}).correct
        is False
    )


def test_last_number_fallback() -> None:
    """When no final answer marker exists, the last number is used."""
    assert last_number("first 1 then 2 then 3") == 3.0


# -------------------------------------------------------------------------- mc


@pytest.mark.parametrize(
    ("output", "expected"),
    [
        ("Answer: B", "B"),
        ("(C)", "C"),
        ("**D**", "D"),
        ("b", "B"),
        ("The correct option is A because ...", "A"),
        ("nothing here", None),
    ],
)
def test_extract_letter(output: str, expected) -> None:
    """Letters come from the answer marker, parentheses, bold or a bare letter."""
    assert extract_letter(output) == expected


def test_mc_matches_choice_text() -> None:
    """A model that answered with the option text is mapped back onto its letter."""
    choices = ["Paris", "Lyon", "Nice"]
    assert score("mc", "Answer: Lyon", answer="B", choices=choices).correct
    assert score("mc", "Answer: B", answer="Lyon", choices=choices).correct
    assert score("mc", "Answer: C", answer="B", choices=choices).correct is False


# -------------------------------------------------------------- contains/needle


def test_contains_all_and_any() -> None:
    """A list requires every keyword; ``{"any": [...]}`` requires one."""
    assert score("contains", "alpha and beta", answer=["alpha", "beta"]).correct
    assert score("contains", "only alpha", answer=["alpha", "beta"]).correct is False
    assert score("contains", "only alpha", answer={"any": ["alpha", "beta"]}).correct


def test_contains_entry_may_be_a_list_of_alternatives() -> None:
    """An entry that is itself a list passes when any one alternative is found."""
    answer = {"all": ["bahnhof", "sonntag", ["geschlossen", "zu"]]}
    assert score("contains", "Der Bahnhof ist am Sonntag zu.", answer=answer).correct
    assert score("contains", "Der Bahnhof ist am Sonntag geschlossen.", answer=answer).correct
    assert score("contains", "Der Bahnhof ist am Sonntag offen.", answer=answer).correct is False


def test_contains_combines_all_and_any() -> None:
    """Both keys may appear on one row; both must be satisfied."""
    answer = {"all": ["alpha"], "any": ["beta", "gamma"]}
    assert score("contains", "alpha gamma", answer=answer).correct
    assert score("contains", "alpha delta", answer=answer).correct is False


def test_needle_found_anywhere() -> None:
    """The needle scorer only asks whether the secret appears."""
    assert score("needle", "The passphrase is 16018, I think.", answer="16018").correct
    assert score("needle", "I could not find it.", answer="16018").correct is False


def test_needle_ignores_spaces_commas_and_hyphens() -> None:
    """Retrieval, not phrasing: 7431-KILO and "7431 KILO" are the same answer."""
    assert score("needle", "the code is 7431 KILO", answer="7431-KILO").correct
    assert score("needle", "Answer: 16,018", answer="16018").correct


def test_needle_row_with_a_contains_answer_delegates() -> None:
    """The "absent" category of eval-longctx-v1 carries a contains-shaped answer."""
    answer = {"any": ["not mentioned", "does not appear"]}
    assert score("needle", "It is not mentioned in the log.", answer=answer).correct
    assert score("needle", "The code is 4242.", answer=answer).correct is False


# ------------------------------------------------------------------------ json


def test_json_scoring() -> None:
    """Valid JSON is the baseline; an expected object must be a subset."""
    assert score("json", '```json\n{"a": 1, "b": 2}\n```', answer=None).correct
    assert score("json", '{"a": 1, "b": 2}', answer={"a": 1}).correct
    assert score("json", '{"a": 2}', answer={"a": 1}).correct is False
    assert score("json", "not json at all", answer=None).correct is False


def test_json_match_modes() -> None:
    """``meta.match: exact`` forbids extra keys; numbers compare numerically."""
    assert score("json", '{"a": 1, "b": 2}', answer={"a": 1}, meta={"match": "subset"}).correct
    assert (
        score("json", '{"a": 1, "b": 2}', answer={"a": 1}, meta={"match": "exact"}).correct is False
    )
    assert score("json", '{"a": 1.0}', answer={"a": 1}).correct
    assert score("json", '{"xs": [2, 1]}', answer={"xs": [1, 2]}).correct is False
    assert score(
        "json", '{"xs": [2, 1]}', answer={"xs": [1, 2]}, meta={"array_order": False}
    ).correct


def test_json_helpers() -> None:
    """Extraction tolerates prose around the object; subset is recursive."""
    assert extract_json('Here you go: {"x": [1, 2]} done') == {"x": [1, 2]}
    assert is_subset({"a": {"b": 1}}, {"a": {"b": 1, "c": 2}})
    assert not is_subset({"a": {"b": 1}}, {"a": {"c": 2}})


# -------------------------------------------------------------------- code-exec


def test_code_exec_pass_and_fail() -> None:
    """The candidate plus the row's asserts must exit 0."""
    good = "```python\ndef add(a, b):\n    return a + b\n```"
    bad = "```python\ndef add(a, b):\n    return a - b\n```"
    tests = "assert add(2, 3) == 5"
    assert score("code-exec", good, tests=tests).correct
    assert score("code_exec", good, tests=tests).correct
    assert score("code-exec", bad, tests=tests).correct is False


def test_code_exec_without_tests_is_unscored() -> None:
    """A row with no tests cannot be judged, and says so."""
    result = score("code-exec", "print(1)")
    assert result.scored is False


def test_code_exec_timeout() -> None:
    """An infinite loop fails instead of hanging the run."""
    from atlas_bench.scorers.code_exec import run_candidate

    passed, detail = run_candidate("while True:\n    pass", "", timeout_s=1.0)
    assert passed is False
    assert detail == "timeout"


def test_extract_code_prefers_the_fenced_block() -> None:
    """Prose around the code is discarded."""
    assert extract_code("Sure!\n```python\nx = 1\n```\nHope that helps") == "x = 1"


# ----------------------------------------------------------------------- judge


def test_judge_is_a_stub() -> None:
    """Judged items are recorded as unscored until a judge model is pinned."""
    result = score("judge", "some answer", answer="expected")
    assert result.scored is False
    assert result.correct is False


def test_unknown_scorer_falls_back_to_exact() -> None:
    """An unknown scorer name must not lose the item."""
    assert get_scorer("does-not-exist") is get_scorer("exact")


def test_kebab_and_snake_scorer_names_are_the_same_scorer() -> None:
    """Workloads say ``code-exec``; dataset rows say ``code_exec``."""
    assert get_scorer("code-exec") is get_scorer("code_exec")
