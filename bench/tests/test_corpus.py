"""The harness against the real corpus: every dataset, every workload, every scorer.

These tests are the contract check between `bench/` and `datasets/` + `workloads/`. They run
against the checkout the harness lives in and skip when it does not have those directories
(an installed harness elsewhere still has a green suite).

The scoring assertions are deliberately blunt: feeding a row's **own reference answer** back
as the model output must score *correct*, and an obviously wrong output must score
*incorrect*. A scorer that fails either direction is broken in a way that would silently
distort every published accuracy number.
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import random
from pathlib import Path
from typing import Any

import pytest

from atlas_bench.data import (
    EvalRow,
    filter_eval_rows,
    filter_prompt_rows,
    load_eval_rows,
    load_haystack_rows,
    load_prompt_rows,
    render_haystack_prompt,
)
from atlas_bench.registry import Registry
from atlas_bench.scorers import SCORERS, get_scorer, normalize_scorer_name
from atlas_bench.scorers.instruction import load_rules
from atlas_bench.scorers.tools import score_tool_call
from atlas_bench.spec import WorkloadRef
from atlas_bench.workloads import RUNNERS, get_runner, resolve_workload

REPO = Path(__file__).resolve().parents[2]
DATASETS = REPO / "datasets"
WORKLOADS = REPO / "workloads"

pytestmark = pytest.mark.skipif(
    not (DATASETS.is_dir() and WORKLOADS.is_dir()),
    reason="datasets/ and workloads/ are not in this checkout",
)

#: How many rows of each eval dataset are scored both ways.
SAMPLE_SIZE = 12
#: code_exec really executes code, so it gets its own (smaller) sample.
CODE_SAMPLE_SIZE = 10
SEED = 20260823


def registry() -> Registry:
    """Registry rooted at the real checkout."""
    return Registry(REPO)


def dataset_ids(kind: str | None = None) -> list[str]:
    """Ids of the datasets in the checkout, optionally filtered by kind."""
    ids = []
    for directory in sorted(DATASETS.iterdir()):
        meta_path = directory / "dataset.json"
        if not meta_path.is_file():
            continue
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        if kind is None or meta.get("kind") == kind:
            ids.append(str(meta["id"]))
    return ids


def workload_files() -> list[Path]:
    """Every workload file in the checkout."""
    return sorted(WORKLOADS.glob("*.json"))


def sample(rows: list[Any], count: int) -> list[Any]:
    """A deterministic sample, so a failure is reproducible."""
    if len(rows) <= count:
        return rows
    return random.Random(SEED).sample(rows, count)


# --------------------------------------------------------------------- loading


@pytest.mark.parametrize("dataset_id", dataset_ids())
def test_every_dataset_loads(dataset_id: str) -> None:
    """Row counts match ``dataset.json`` and every row survives the loader."""
    reg = registry()
    meta = reg.dataset(dataset_id)
    assert meta is not None
    kind = meta["kind"]

    if kind == "prompts":
        rows = load_prompt_rows(reg, dataset_id)
        assert len(rows) == meta["count"]
        for row in rows:
            assert row.messages and row.messages[-1]["role"] == "user"
            assert row.messages[-1]["content"]
            assert row.approx_tokens > 0
            assert row.bucket
    elif kind == "eval":
        rows = load_eval_rows(reg, dataset_id)
        assert len(rows) == meta["count"]
        for row in rows:
            assert row.messages and row.messages[-1]["content"]
            assert row.answer is not None
            assert normalize_scorer_name(row.scorer) in SCORERS
            assert row.dataset_dir == reg.dataset_dir(dataset_id)
    elif kind == "haystack":
        rows = load_haystack_rows(reg, dataset_id)
        assert len(rows) == meta["count"]
        for row in rows:
            assert row.input_tokens > 0
            assert row.answer
            assert len(row.prompt.messages[-1]["content"]) > 100


def test_prompts_datasets_declare_their_buckets() -> None:
    """``dataset_buckets`` can only filter what the rows actually carry."""
    reg = registry()
    rows = load_prompt_rows(reg, "prompts-mixed-v1")
    buckets = {row.bucket for row in rows}
    assert {"xs", "s", "m"} <= buckets
    filtered = filter_prompt_rows(rows, ["m"])
    assert filtered and all(row.bucket == "m" for row in filtered)
    assert len(filtered) < len(rows)


def test_shared_prefix_rows_send_a_system_message() -> None:
    """`shared_prefix` is a contract: it goes on the wire as a leading system message."""
    rows = load_prompt_rows(registry(), "prompts-shared-prefix-v1")
    assert rows
    assert all(row.shared_prefix for row in rows)
    assert all(row.prefix_id for row in rows)
    for row in rows[:5]:
        messages = row.chat_messages()
        assert messages[0]["role"] == "system"
        assert messages[0]["content"] == row.shared_prefix
        assert messages[1:] == row.messages


# ------------------------------------------------------------------- workloads


@pytest.mark.parametrize("path", workload_files(), ids=lambda p: p.stem)
def test_every_workload_resolves(path: Path) -> None:
    """Every workload resolves to a runner, a known dataset and usable params."""
    record = json.loads(path.read_text(encoding="utf-8"))
    assert record["id"] == path.stem, "filename must equal the workload id"
    reg = registry()

    resolved, params = resolve_workload(reg, WorkloadRef(id=record["id"]))
    assert resolved["kind"] == record["kind"]
    assert resolved["kind"] in RUNNERS
    assert get_runner(resolved["kind"]) is RUNNERS[resolved["kind"]]
    assert params == record["params"]

    assert reg.dataset(record["dataset_id"]) is not None, "dataset_id must exist"

    if record["kind"] == "eval":
        assert normalize_scorer_name(record["eval"]["scorer"]) in SCORERS
        assert record["eval"]["max_output_tokens"] > 0
    if record["kind"] == "sweep":
        axes = [k for k in ("concurrency", "input_tokens") if record["sweep"].get(k)]
        assert len(axes) == 1, "a sweep has exactly one axis"


@pytest.mark.parametrize("path", workload_files(), ids=lambda p: p.stem)
def test_workload_params_the_runners_read(path: Path) -> None:
    """Every param a workload sets is one a runner understands (or is documentation)."""
    known = {
        "concurrency",
        "num_requests",
        "input_tokens",
        "output_tokens",
        "seed",
        "warmup_requests",
        "temperature",
        "repeat",
        "timeout_s",
        "dataset_buckets",
        "dataset_categories",
        "dataset_target_tokens",
        "requests_per_concurrency",
        "group_by",
        "shuffle",
        "warmup_per_group",
        "needle_check",
        "needle_depth",
        "reasoning",
        "limit",
        "item_timeout_s",
        "input_tokens_list",
        "depths",
        # agentic
        "num_conversations",
        "honour_tool_delays",
        "max_turns_per_conversation",
    }
    record = json.loads(path.read_text(encoding="utf-8"))
    unknown = set(record["params"]) - known
    assert not unknown, f"{path.name} sets params no runner reads: {sorted(unknown)}"


def test_eval_workloads_require_score_metrics() -> None:
    """For kind=eval all three required names are keys of the result's ``scores`` block."""
    for path in workload_files():
        record = json.loads(path.read_text(encoding="utf-8"))
        if record["kind"] != "eval":
            continue
        assert set(record["metrics_required"]) == {"accuracy", "success_rate", "avg_latency_ms"}


# --------------------------------------------------------------------- scoring


def _wrong_output(row: EvalRow) -> str:
    """An obviously wrong model output for this row."""
    scorer = normalize_scorer_name(row.scorer)
    if scorer == "numeric":
        from atlas_bench.scorers.numeric import last_number

        expected = last_number(str(row.answer)) or 0.0
        return f"Answer: {expected + 98765.25}"
    if scorer == "mc":
        letters = [chr(ord("A") + i) for i in range(len(row.choices or []) or 4)]
        wrong = next(letter for letter in letters if letter != str(row.answer).upper()[:1])
        return f"Answer: {wrong}"
    if scorer == "json":
        return "I am afraid I cannot produce that."
    if scorer in ("contains", "needle"):
        return "Answer: qqzzxx nothing of the sort"
    return "Answer: qqzzxx definitely not the expected answer"


def _grouped_digits(text: str) -> str:
    """``16018`` → ``16,018`` — the needle scorer must see through the separator."""
    if not text.isdigit() or len(text) < 4:
        return text
    return f"{int(text):,}"


def _reference_output(row: EvalRow) -> str:
    """The row's own reference answer, shaped the way a model would actually emit it.

    Deliberately not the bare answer string: wrapping it in a sentence, a fence or an
    ``Answer:`` line is what exercises the extraction and normalization the contract
    specifies. A test that fed the answer back untouched would pass against a scorer that
    does nothing at all.
    """
    scorer = normalize_scorer_name(row.scorer)
    answer = row.answer
    if scorer == "json":
        return f"Sure, here is the object:\n\n```json\n{json.dumps(answer)}\n```"
    if scorer == "contains":
        # A scalar answer is a valid `contains` row — score_contains wraps it into a
        # single required entry — and aa-lcr-v1 uses that shape throughout. Building an
        # empty reference for it made every such row look broken.
        if not isinstance(answer, dict):
            entries = answer if isinstance(answer, (list, tuple)) else [answer]
            body = " ".join(str(entry) for entry in entries if entry is not None)
            return f"<think>let me translate</think>\n{body}"
        parts: list[str] = []
        for key in ("all", "any"):
            for entry in (answer or {}).get(key, []):
                parts.append(entry[0] if isinstance(entry, list) else str(entry))
                if key == "any":
                    break
        return "<think>let me translate</think>\n" + " ".join(parts)
    if scorer == "code_exec":
        return f"```python\n{answer}\n```"
    if scorer == "needle":
        return f"<think>searching the log</think>\nThe value is {_grouped_digits(str(answer))}."
    if scorer == "mc":
        return f"Looking at the options, the right one is ({answer})."
    return f"<think>thinking</think>\nSome working out.\n\nAnswer: {answer}"


#: Scorers whose ``answer`` is not a string a model would type, so the blunt
#: reference-answer check below cannot apply to them. ``code_exec`` and ``instruction``
#: have their own tests further down; ``integrity`` has ``test_longgen_integrity.py``,
#: because its answer is an *observation* ("no spliced token") rather than a value —
#: there is no output that is wrong by virtue of what it says.
NON_REFERENCE_SCORERS = ("code_exec", "instruction", "integrity")


@pytest.mark.parametrize("dataset_id", dataset_ids("eval"))
def test_reference_answers_score_correct(dataset_id: str) -> None:
    """Feeding a row's own answer back must score correct; garbage must not."""
    reg = registry()
    rows = [
        row
        for row in load_eval_rows(reg, dataset_id)
        if normalize_scorer_name(row.scorer) not in NON_REFERENCE_SCORERS
        and not row.meta.get("tools")
    ]
    if not rows:
        pytest.skip(f"{dataset_id} has no plain-scored rows")

    for row in sample(rows, SAMPLE_SIZE):
        scorer = get_scorer(row.scorer)
        good = scorer(_reference_output(row), row)
        assert good.correct, f"{row.id} ({row.scorer}): reference answer scored incorrect"
        bad = scorer(_wrong_output(row), row)
        assert not bad.correct, f"{row.id} ({row.scorer}): a wrong answer scored correct"


def test_code_exec_runs_the_reference_solutions() -> None:
    """``eval-code-v1`` rows carry a reference solution; it must pass their own tests."""
    rows = load_eval_rows(registry(), "eval-code-v1")
    assert rows and all(row.tests for row in rows)
    scorer = get_scorer("code_exec")

    for row in sample(rows, CODE_SAMPLE_SIZE):
        good = scorer(f"```python\n{row.answer}\n```", row)
        assert good.correct, f"{row.id}: reference solution failed its own tests: {good.detail}"

        function = row.meta.get("function") or "solve"
        stub = f"```python\ndef {function}(*args, **kwargs):\n    return None\n```"
        assert not scorer(stub, row).correct, f"{row.id}: a stub passed the tests"


def test_instruction_scorer_agrees_with_the_normative_rules() -> None:
    """The harness scorer must agree with ``datasets/eval-instruction-v1/rules.py``."""
    reg = registry()
    rows = load_eval_rows(reg, "eval-instruction-v1")
    rules = load_rules(reg.dataset_dir("eval-instruction-v1"))
    assert rules is not None, "rules.py must ship with the dataset"
    scorer = get_scorer("instruction")

    for row in sample(rows, SAMPLE_SIZE):
        example = str(row.meta.get("example_pass") or "")
        assert example, f"{row.id}: meta.example_pass is the proof the rules are satisfiable"
        assert scorer(example, row).correct, f"{row.id}: example_pass failed the rules"

        for text in (example, "", "no.", example.upper(), f"Answer: {example}"):
            expected, _ = rules.evaluate(row.answer, text)
            assert scorer(text, row).correct is expected, f"{row.id}: disagreed on {text[:40]!r}"


def test_instruction_rules_self_test() -> None:
    """``python rules.py --self-test`` must pass, and our loader must run it."""
    rules = load_rules(registry().dataset_dir("eval-instruction-v1"))
    assert rules is not None
    assert rules.self_test() == 0


def test_tool_rows_score_their_own_expected_call() -> None:
    """``eval-tools-v1``: the expected call scores correct, a wrong or missing one does not."""
    rows = load_eval_rows(registry(), "eval-tools-v1")
    assert rows
    single = [row for row in rows if (row.answer or {}).get("tool_call")]
    absent = [row for row in rows if (row.answer or {}).get("tool_call") is None]
    assert single and absent

    for row in sample(single, SAMPLE_SIZE):
        expected = row.answer["tool_call"]
        row.tool_calls = [
            {
                "id": "call_1",
                "type": "function",
                "function": {
                    "name": expected["name"],
                    "arguments": json.dumps(expected["arguments"]),
                },
            }
        ]
        assert score_tool_call("", row).correct, f"{row.id}: expected call scored incorrect"

        row.tool_calls = [{"function": {"name": "definitely_not_this_tool", "arguments": "{}"}}]
        assert not score_tool_call("", row).correct, f"{row.id}: wrong tool scored correct"

        row.tool_calls = []
        assert not score_tool_call("Sure!", row).correct, f"{row.id}: no call scored correct"

    for row in sample(absent, 5):
        row.tool_calls = []
        assert score_tool_call("I can answer directly.", row).correct
        row.tool_calls = [{"function": {"name": "get_weather", "arguments": "{}"}}]
        assert not score_tool_call("", row).correct, f"{row.id}: a call was made and accepted"


def test_tool_arguments_tolerate_extra_optional_arguments() -> None:
    """Subset matching by default: an extra optional argument is not a failure."""
    rows = [
        r for r in load_eval_rows(registry(), "eval-tools-v1") if (r.answer or {}).get("tool_call")
    ]
    row = next(r for r in rows if str(r.meta.get("arguments_match") or "subset") == "subset")
    expected = row.answer["tool_call"]
    row.tool_calls = [
        {
            "function": {
                "name": expected["name"],
                "arguments": json.dumps({**expected["arguments"], "atlas_extra": 1}),
            }
        }
    ]
    assert score_tool_call("", row).correct


def test_vision_rows_carry_their_image() -> None:
    """Every ``eval-vision-v1`` row points at an image that exists on disk."""
    reg = registry()
    rows = load_eval_rows(reg, "eval-vision-v1")
    directory = reg.dataset_dir("eval-vision-v1")
    assert rows
    for row in rows:
        assert row.image, f"{row.id}: a vision row without an image"
        assert (directory / row.image).is_file(), f"{row.id}: {row.image} is missing"

    from atlas_bench.workloads.eval import build_messages

    row = rows[0]
    parts = build_messages(row, directory)[-1]["content"]
    assert parts[0]["type"] == "text"
    assert parts[-1]["image_url"]["url"].startswith("data:image/png;base64,")


# -------------------------------------------------------------------- haystack


def _build_module() -> Any:
    """Import the dataset's own ``build.py`` — the normative materialisation."""
    path = DATASETS / "haystack-v1" / "build.py"
    spec = importlib.util.spec_from_file_location("atlas_test_haystack_build", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_haystack_recipes_rebuild_to_their_recorded_digest() -> None:
    """The eight smallest recipes must rebuild byte-identically (sha256 is the contract)."""
    module = _build_module()
    items = [
        json.loads(line)
        for line in (DATASETS / "haystack-v1" / "items.jsonl").read_text().splitlines()
        if line.strip()
    ]
    smallest = sorted(items, key=lambda i: i["target_tokens"])[:8]
    assert len(smallest) == 8

    for item in smallest:
        document = module.build_haystack(item)
        digest = hashlib.sha256(document.encode("utf-8")).hexdigest()
        assert digest == item["sha256"], f"{item['id']}: rebuilt document differs"
        assert item["needles"][0]["text"] in document
        prompt = module.build_prompt(item)
        assert prompt.startswith(module.PREAMBLE)
        assert prompt.endswith(item["question"])


def test_loader_materializes_haystack_rows_through_build_py() -> None:
    """``load_haystack_rows`` produces the same documents the recipes describe."""
    rows = load_haystack_rows(registry(), "haystack-v1")
    module = _build_module()
    items = {
        json.loads(line)["id"]: json.loads(line)
        for line in (DATASETS / "haystack-v1" / "items.jsonl").read_text().splitlines()
        if line.strip()
    }
    for row in sorted(rows, key=lambda r: r.input_tokens)[:8]:
        content = row.prompt.messages[-1]["content"]
        assert module.build_haystack(items[row.id]) in content
        assert content.startswith(module.PREAMBLE)


def test_eval_longctx_rows_render_the_document_not_just_the_question() -> None:
    """``eval-longctx-v1`` prompts are the question only; the document must be rebuilt."""
    reg = registry()
    rows = load_eval_rows(reg, "eval-longctx-v1")
    assert rows
    small = sorted(rows, key=lambda r: r.target_tokens or 0)[:8]

    for row in small:
        question = row.messages[-1]["content"]
        messages, warnings = render_haystack_prompt(row, reg)
        assert warnings == [], f"{row.id}: {warnings}"
        content = messages[-1]["content"]
        assert content.endswith(question)
        assert len(content) > len(question) * 5
        digest = hashlib.sha256(
            content[: -len(question) - 2].split("\n\n", 1)[1].encode("utf-8")
        ).hexdigest()
        assert digest == row.meta["sha256"], f"{row.id}: rebuilt document differs"


def test_longctx_filters_pick_one_size_and_category() -> None:
    """``dataset_target_tokens`` + ``dataset_categories`` are what the 32k workload uses."""
    rows = load_eval_rows(registry(), "eval-longctx-v1")
    filtered = filter_eval_rows(rows, ["needle"], 32768)
    assert filtered
    assert all(row.category == "needle" for row in filtered)
    assert all(row.target_tokens == 32768 for row in filtered)
