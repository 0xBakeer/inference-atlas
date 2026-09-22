"""The small-model tier: eval-rag-grounded-v1, eval-tools-small-v1 and the 1-256 sweep.

Three things are checked here that the generic corpus tests cannot see:

* the grounded-answering suite really cannot be passed by answering with the sibling
  entity's value, and declining passes exactly the unanswerable half;
* the tool scorer's ``reply_contains`` path (answering from a tool result) accepts the
  value and rejects both a second call and a reply without the value;
* the published workloads run end to end against a fake server, multi-turn tool rows go
  on the wire with their assistant ``tool_calls`` and ``tool`` results intact, and the
  256-point sweep sends the number of requests its notes promise.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from atlas_bench.data import EvalRow, load_eval_rows
from atlas_bench.registry import Registry
from atlas_bench.scorers import get_scorer
from atlas_bench.scorers.tools import score_tool_call
from tests.conftest import FakeOpenAIServer
from tests.test_corpus_e2e import run_workload

REPO = Path(__file__).resolve().parents[2]

pytestmark = pytest.mark.skipif(
    not ((REPO / "datasets" / "eval-rag-grounded-v1").is_dir()
         and (REPO / "datasets" / "eval-tools-small-v1").is_dir()),
    reason="the small-model tier datasets are not in this checkout",
)


def rows(dataset_id: str) -> list[EvalRow]:
    return load_eval_rows(Registry(REPO), dataset_id)


def _call(name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": "call_9",
        "type": "function",
        "function": {"name": name, "arguments": json.dumps(arguments)},
    }


# ------------------------------------------------------------------ reply_contains scorer


def _row(answer: dict[str, Any], calls: list[dict[str, Any]] | None = None) -> Any:
    return SimpleNamespace(answer=answer, tool_calls=calls or [], meta={})


def test_reply_contains_accepts_the_value_from_the_tool_result() -> None:
    row = _row({"tool_call": None, "reply_contains": ["17"]})
    assert score_tool_call("<think>the result says 17</think>It is 17 °C in Kesswater.", row).correct


def test_reply_contains_rejects_a_reply_without_the_value() -> None:
    row = _row({"tool_call": None, "reply_contains": ["17"]})
    result = score_tool_call("<think>17</think>It is mild and a bit rainy.", row)
    assert not result.correct
    assert result.detail == "the reply did not contain the tool result"


def test_reply_contains_rejects_calling_the_tool_again() -> None:
    row = _row(
        {"tool_call": None, "reply_contains": ["17"]},
        [_call("get_current_weather", {"city": "Kesswater"})],
    )
    assert not score_tool_call("It is 17 degrees.", row).correct


def test_reply_contains_accepts_alternatives() -> None:
    row = _row({"tool_call": None, "reply_contains": [["14:35", "2:35 pm"]]})
    assert score_tool_call("Your parcel should arrive around 2:35 pm.", row).correct


def test_no_call_rows_without_reply_contains_ignore_the_text() -> None:
    """The eval-tools-v1 contract is unchanged: no_call rows do not score the reply."""
    row = _row({"tool_call": None})
    assert score_tool_call("", row).correct


# ------------------------------------------------------------------ eval-tools-small-v1


def test_tools_small_expected_calls_score_correct() -> None:
    for row in rows("eval-tools-small-v1"):
        expected = row.answer["tool_call"]
        if expected is None:
            continue
        row.tool_calls = [_call(expected["name"], expected["arguments"])]
        assert score_tool_call("", row).correct, row.id
        row.tool_calls = []
        assert not score_tool_call("Could you tell me more?", row).correct, row.id


def test_tools_small_a_changed_argument_fails() -> None:
    """Every expected argument is load-bearing: changing any one value fails the item."""
    for row in rows("eval-tools-small-v1"):
        expected = row.answer["tool_call"]
        if expected is None:
            continue
        for key, value in expected["arguments"].items():
            wrong = value + 1 if isinstance(value, (int, float)) else f"{value}x"
            row.tool_calls = [_call(expected["name"], {**expected["arguments"], key: wrong})]
            assert not score_tool_call("", row).correct, (row.id, key)


def test_tools_small_no_call_rows() -> None:
    no_call = [r for r in rows("eval-tools-small-v1") if r.answer["tool_call"] is None]
    assert {r.category for r in no_call} == {"clarify", "use_result"}
    for row in no_call:
        wanted = row.answer.get("reply_contains") or []
        reply = "Here you go: " + " ".join(str(w) for w in wanted) if wanted else "Which one?"
        row.tool_calls = []
        assert score_tool_call(reply, row).correct, row.id
        name = row.meta["tools"][0]["function"]["name"]
        row.tool_calls = [_call(name, {})]
        assert not score_tool_call(reply, row).correct, row.id
        if wanted:
            row.tool_calls = []
            assert not score_tool_call("Sorry, I cannot say.", row).correct, row.id


def test_tools_small_multi_turn_rows_are_well_formed() -> None:
    """Every tool result answers a call made earlier in the same conversation."""
    multi = [r for r in rows("eval-tools-small-v1") if any(m["role"] == "tool" for m in r.messages)]
    assert len(multi) == 45  # chain 20 + use_result 15 + revise 10
    for row in multi:
        ids = {c["id"] for m in row.messages for c in m.get("tool_calls") or []}
        for message in row.messages:
            if message["role"] == "tool":
                assert message["tool_call_id"] in ids, row.id
                json.loads(message["content"])
        assert row.messages[0]["role"] == "system"
        assert row.messages[-1]["role"] in {"user", "tool"}, row.id


# ------------------------------------------------------------------ eval-rag-grounded-v1


def _numbers(text: str) -> set[str]:
    return set(re.findall(r"[A-Z]*-?\d[\d,.:]*\d|\d", text))


def test_rag_reference_answers_and_declining() -> None:
    scorer = get_scorer("needle")
    all_rows = rows("eval-rag-grounded-v1")
    assert len(all_rows) == 120
    answerable = [r for r in all_rows if r.meta["answerable"]]
    unanswerable = [r for r in all_rows if not r.meta["answerable"]]
    assert len(answerable) == len(unanswerable) == 60

    for row in answerable:
        assert scorer(f"Answer: {row.answer}", row).correct, row.id
        assert scorer(f"It is {row.answer}.", row).correct, row.id
        assert not scorer("NOT IN PASSAGE", row).correct, row.id

    for row in unanswerable:
        assert scorer("NOT IN PASSAGE", row).correct, row.id
        assert scorer("The passage does not mention this.", row).correct, row.id


def test_rag_distractors_never_pass() -> None:
    """Answering with any other value printed in the passage scores incorrect.

    This is the point of the near-miss and lookup items: the right-looking number is in the
    passage and belongs to the other entity.
    """
    scorer = get_scorer("needle")
    for row in rows("eval-rag-grounded-v1"):
        passage = row.messages[-1]["content"].split("Passage:\n", 1)[1].split("\n\nQuestion:")[0]
        for value in _numbers(passage):
            if row.meta["answerable"] and value.replace(",", "") == str(row.answer):
                continue
            assert not scorer(f"Answer: {value}", row).correct, (row.id, value)


# ------------------------------------------------------------------ end to end


async def test_rag_workload_end_to_end() -> None:
    by_prompt = {r.messages[-1]["content"]: r for r in rows("eval-rag-grounded-v1")}

    def responder(messages: list[dict[str, Any]]) -> str:
        row = by_prompt[messages[-1]["content"]]
        return f"Answer: {row.answer}" if row.meta["answerable"] else "NOT IN PASSAGE"

    server = FakeOpenAIServer(responder=responder)
    outcome, _, workload = await run_workload("eval-rag-grounded-v1", server)
    assert outcome.scores["total"] == workload["params"]["num_requests"] == 120
    assert outcome.scores["accuracy"] == 1.0
    assert set(outcome.scores["by_category"]) == set(workload["eval"]["categories"])

    # A model that always declines lands on exactly one half.
    server = FakeOpenAIServer(responder=lambda messages: "NOT IN PASSAGE")
    outcome, _, _ = await run_workload("eval-rag-grounded-v1", server)
    assert outcome.scores["accuracy"] == 0.5


async def test_tools_small_workload_end_to_end() -> None:
    by_messages = {json.dumps(r.messages, sort_keys=True): r for r in rows("eval-tools-small-v1")}

    def lookup(messages: list[dict[str, Any]]) -> EvalRow:
        return by_messages[json.dumps(messages, sort_keys=True)]

    def tool_responder(body: dict[str, Any]) -> dict[str, Any] | None:
        return lookup(body["messages"]).answer["tool_call"]

    def responder(messages: list[dict[str, Any]]) -> str:
        wanted = lookup(messages).answer.get("reply_contains") or []
        return "It is " + " ".join(str(w) for w in wanted) if wanted else "Which one do you mean?"

    server = FakeOpenAIServer(tool_responder=tool_responder, responder=responder)
    outcome, _, workload = await run_workload("eval-tools-small-v1", server)

    assert all(body["tool_choice"] == "auto" and body["tools"] for body in server.requests)
    assert all(1 <= len(body["tools"]) <= 2 for body in server.requests)
    # Multi-turn rows reach the server with their earlier calls and results intact.
    with_results = [b for b in server.requests if any(m["role"] == "tool" for m in b["messages"])]
    assert len(with_results) == 45
    assert all(
        any(m.get("tool_calls") for m in b["messages"] if m["role"] == "assistant")
        for b in with_results
    )
    assert outcome.scores["total"] == workload["params"]["num_requests"] == 100
    assert outcome.scores["accuracy"] == 1.0
    assert set(outcome.scores["by_category"]) == set(workload["eval"]["categories"])


async def test_sweep_to_256_sends_the_documented_request_counts() -> None:
    server = FakeOpenAIServer(chunk_delay_s=0, ttft_delay_s=0, chunks=1)
    outcome, _, workload = await run_workload("sweep-parallel-1-256-i512-o256-v1", server)

    levels = workload["sweep"]["concurrency"]
    assert levels[-3:] == [64, 128, 256]
    counts = [entry["num_requests"] for entry in outcome.sweep]
    assert counts == [32, 32, 32, 32, 64, 128, 256, 512, 1024]
    assert sum(counts) == 2112  # the figure the workload's notes state
    assert all(entry["metrics"]["success_rate"] == 1.0 for entry in outcome.sweep)
    assert len(server.requests) == sum(counts) + workload["params"]["warmup_requests"]
