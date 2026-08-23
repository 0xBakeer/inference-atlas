"""Every workload kind, run end to end against the real datasets and a fake server.

The unit tests check the pieces; these check that a *published* workload file, pointed at a
*published* dataset, actually runs through the harness and produces the shape the result
schema expects. They are the tests that would have caught "the prefix workload silently
dropped the system message" or "the long-context eval sent the question without the
document".

No engine, no model, no network: the fake server answers instantly.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from atlas_bench.client import ChatClient
from atlas_bench.data import load_eval_rows, render_haystack_prompt
from atlas_bench.registry import Registry
from atlas_bench.spec import TaskSpec, WorkloadRef
from atlas_bench.workloads import RunContext, get_runner, resolve_workload
from tests.conftest import FakeOpenAIServer

REPO = Path(__file__).resolve().parents[2]

pytestmark = pytest.mark.skipif(
    not (REPO / "workloads").is_dir() or not (REPO / "datasets").is_dir(),
    reason="datasets/ and workloads/ are not in this checkout",
)


def _spec() -> TaskSpec:
    """A packet pointed at the fake server."""
    return TaskSpec.model_validate(
        {
            "engine": {"id": "vllm", "version": "0.27.1", "base_url": "http://fake"},
            "model": {"id": "qwen3.8-27b", "quant_id": "fp8"},
            "hardware": {"id": "nvidia-gb10-dgx-spark", "count": 1},
            "workloads": [],
            "request": {"temperature": 0, "seed": 42},
        }
    )


async def run_workload(
    workload_id: str, server: FakeOpenAIServer, *, overrides: dict[str, Any] | None = None
):
    """Run a published workload against the fake server and return its outcome."""
    registry = Registry(REPO)
    workload, params = resolve_workload(
        registry, WorkloadRef(id=workload_id, params=overrides or {})
    )
    assert registry.workload(workload_id) is not None, f"{workload_id} is not in this checkout"
    async with ChatClient("http://fake", "m", transport=server.transport) as client:
        ctx = RunContext(
            spec=_spec(), registry=registry, client=client, workload=workload, params=params
        )
        outcome = await get_runner(str(workload["kind"]))(ctx)
    return outcome, ctx, workload


def _rendered_answers(registry: Registry, dataset_id: str) -> dict[str, Any]:
    """Map every row's fully rendered prompt onto its answer.

    Long-context rows share their questions — what makes a row unique is its document — so a
    fake server has to key on the rendered prompt to answer the right one.
    """
    answers: dict[str, Any] = {}
    for row in load_eval_rows(registry, dataset_id):
        messages, _ = render_haystack_prompt(row, registry)
        answers[str(messages[-1]["content"])] = row.answer
    return answers


def _messages_of(server: FakeOpenAIServer) -> list[list[dict[str, Any]]]:
    """The message lists the server actually received."""
    return [body["messages"] for body in server.requests]


# --------------------------------------------------------------------- serving


async def test_serving_workload_uses_the_declared_bucket() -> None:
    """``serve-single-i256-o256-v1`` draws from the s/m buckets of prompts-mixed-v1."""
    server = FakeOpenAIServer(chunk_delay_s=0, chunks=4)
    outcome, _, workload = await run_workload("serve-single-i256-o256-v1", server)

    params = workload["params"]
    assert outcome.kind == "serving"
    assert outcome.metrics["requests_total"] == params["num_requests"]
    assert outcome.metrics["success_rate"] == 1.0
    assert len(server.requests) == params["num_requests"] + params["warmup_requests"]
    assert all(body["max_tokens"] == params["output_tokens"] for body in server.requests)
    assert all(body["temperature"] == 0 for body in server.requests)
    assert outcome.resolved_params["dataset_buckets"] == ["s", "m"]
    assert outcome.warnings == []


async def test_prefix_workload_groups_and_sends_the_system_message() -> None:
    """``serve-prefix-c16-v1``: grouped, unshuffled, warm TTFT, prefix as a system turn."""
    server = FakeOpenAIServer(chunk_delay_s=0, chunks=2)
    outcome, _, workload = await run_workload(
        "serve-prefix-c16-v1", server, overrides={"repeat": 1}
    )

    messages = _messages_of(server)
    assert len(messages) == workload["params"]["num_requests"]
    # Every row of prompts-shared-prefix-v1 carries a prefix, sent as a leading system turn.
    assert all(m[0]["role"] == "system" and m[0]["content"] for m in messages)

    prefixes = [m[0]["content"] for m in messages]
    groups = []
    for prefix in prefixes:
        if not groups or groups[-1] != prefix:
            groups.append(prefix)
    # Four prefixes, sent in contiguous runs (two passes over the dataset → 8 runs at most).
    assert len(set(prefixes)) == 4
    assert len(groups) <= 8, "rows of one prefix must be sent back to back"

    assert outcome.resolved_params["group_by"] == "prefix_id"
    assert outcome.resolved_params["warmup_per_group"] == 1
    # One warmup per group per pass is excluded from the aggregate.
    assert outcome.metrics["requests_total"] < workload["params"]["num_requests"]
    assert outcome.metrics["success_rate"] == 1.0


# ----------------------------------------------------------------------- sweep


async def test_sweep_scales_requests_with_concurrency() -> None:
    """``requests_per_concurrency`` keeps a low point from becoming a warmup measurement."""
    server = FakeOpenAIServer(chunk_delay_s=0, chunks=2)
    outcome, _, workload = await run_workload("sweep-parallel-1-32-i512-o256-v1", server)

    levels = workload["sweep"]["concurrency"]
    per = workload["params"]["requests_per_concurrency"]
    base = workload["params"]["num_requests"]
    assert [entry["concurrency"] for entry in outcome.sweep] == levels
    assert [entry["num_requests"] for entry in outcome.sweep] == [
        max(base, level * per) for level in levels
    ]
    assert outcome.sweep[-1]["metrics"]["requests_total"] == max(base, levels[-1] * per)
    assert outcome.resolved_params["requests_per_concurrency"] == per


# --------------------------------------------------------------------- prefill


async def test_prefill_workload_sends_real_long_documents() -> None:
    """``prefill-8k-v1`` uses haystack recipes, not filler."""
    server = FakeOpenAIServer(chunk_delay_s=0, chunks=1)
    outcome, _, workload = await run_workload("prefill-8k-v1", server)

    assert outcome.kind == "prefill"
    assert outcome.metrics["requests_total"] == workload["params"]["num_requests"]
    assert all(body["max_tokens"] == 16 for body in server.requests)
    lengths = [len(m[-1]["content"]) for m in _messages_of(server)]
    # 8k tokens at the dataset's chars/4 heuristic is ~32k characters.
    assert min(lengths) > 25_000
    assert outcome.metrics["ttft_ms"] is not None


# --------------------------------------------------------------------- longctx


async def test_longctx_eval_workload_sends_the_document_and_scores_the_needle() -> None:
    """``longctx-needle-32k-v1``: the document is rebuilt, the needle is scored."""
    registry = Registry(REPO)
    # Keyed by the *rendered* prompt: several rows share a question, only the document
    # (and therefore the answer) differs.
    answers = _rendered_answers(registry, "eval-longctx-v1")

    def responder(messages: list[dict[str, Any]]) -> str:
        answer = answers.get(str(messages[-1]["content"]))
        return f"The answer is {answer}." if answer else "I could not find it."

    server = FakeOpenAIServer(chunk_delay_s=0, chunks=1, responder=responder)
    outcome, _, workload = await run_workload("longctx-needle-32k-v1", server)

    assert outcome.kind == "longctx"
    assert len(outcome.sweep) == workload["params"]["num_requests"]
    assert all(entry["input_tokens"] == 32768 for entry in outcome.sweep)
    assert all("needle found" in entry["label"] for entry in outcome.sweep)
    assert outcome.resolved_params["needles_found"] == len(outcome.sweep)
    assert all(f["category"] != "malformed-output" for f in outcome.failures)
    # The prompt is the question *plus* a 32k-token document.
    assert min(len(m[-1]["content"]) for m in _messages_of(server)) > 100_000


async def test_longctx_counts_a_missed_needle_as_a_failed_request() -> None:
    """A wrong needle answer lowers success_rate and is recorded as malformed-output."""
    server = FakeOpenAIServer(chunk_delay_s=0, chunks=1, responder=lambda m: "No idea.")
    outcome, _, _ = await run_workload("longctx-needle-32k-v1", server)

    assert all(entry["metrics"]["success_rate"] == 0.0 for entry in outcome.sweep)
    assert all("needle missed" in entry["label"] for entry in outcome.sweep)
    failure = next(f for f in outcome.failures if f["category"] == "malformed-output")
    assert failure["count"] == len(outcome.sweep)
    assert outcome.metrics is None, "no point succeeded, so there is no headline block"


# ------------------------------------------------------------------------ eval


async def test_eval_math_workload_scores_the_real_dataset() -> None:
    """``eval-math-v1`` end to end: every row answered correctly scores 1.0."""
    registry = Registry(REPO)
    answers = {
        row.messages[-1]["content"]: str(row.answer)
        for row in load_eval_rows(registry, "eval-math-v1")
    }
    server = FakeOpenAIServer(
        responder=lambda m: f"Answer: {answers.get(str(m[-1]['content']), 'no idea')}"
    )
    outcome, _, workload = await run_workload("eval-math-v1", server)

    scores = outcome.scores
    assert scores["suite"] == "math"
    assert scores["total"] == workload["params"]["num_requests"]
    assert scores["accuracy"] == 1.0
    assert set(scores["by_category"]) == set(workload["eval"]["categories"])
    assert scores["avg_latency_ms"] is not None
    # All three names of metrics_required live in scores; success_rate is mirrored in the
    # request-layer metric block.
    assert scores["success_rate"] == 1.0
    assert outcome.metrics["success_rate"] == scores["success_rate"]
    assert set(workload["metrics_required"]) <= set(scores)
    assert all(
        body["max_tokens"] == workload["eval"]["max_output_tokens"] for body in server.requests
    )


async def test_eval_reasoning_uses_the_row_scorer_not_the_workload_default() -> None:
    """``eval-reasoning-v1`` mixes ``mc`` and ``exact``; both must be scored on their terms."""
    registry = Registry(REPO)
    rows = {
        row.messages[-1]["content"]: row for row in load_eval_rows(registry, "eval-reasoning-v1")
    }

    def responder(messages: list[dict[str, Any]]) -> str:
        row = rows[str(messages[-1]["content"])]
        return f"Answer: {row.answer}"

    server = FakeOpenAIServer(responder=responder)
    outcome, _, _ = await run_workload("eval-reasoning-v1", server)

    assert outcome.scores["accuracy"] == 1.0
    assert set(outcome.raw["scorers_used"]) == {"mc", "exact"}


async def test_eval_tools_workload_sends_tools_and_scores_the_call() -> None:
    """``eval-tools-v1``: tools go on the request, ``tool_calls[0]`` is what is scored."""
    registry = Registry(REPO)
    rows = {row.messages[-1]["content"]: row for row in load_eval_rows(registry, "eval-tools-v1")}

    def tool_responder(body: dict[str, Any]) -> dict[str, Any] | None:
        row = rows[str(body["messages"][-1]["content"])]
        return (row.answer or {}).get("tool_call")

    server = FakeOpenAIServer(tool_responder=tool_responder, responder=lambda m: "No tool needed.")
    outcome, _, workload = await run_workload("eval-tools-v1", server)

    assert all("tools" in body and body["tool_choice"] == "auto" for body in server.requests)
    assert outcome.scores["total"] == workload["params"]["num_requests"]
    assert outcome.scores["accuracy"] == 1.0
    assert set(outcome.scores["by_category"]) == {"single_call", "no_call"}


async def test_eval_instruction_workload_scores_the_raw_output() -> None:
    """``eval-instruction-v1``: the rule DSL is evaluated against the untouched output."""
    registry = Registry(REPO)
    examples = {
        row.messages[-1]["content"]: str(row.meta["example_pass"])
        for row in load_eval_rows(registry, "eval-instruction-v1")
    }
    server = FakeOpenAIServer(responder=lambda m: examples[str(m[-1]["content"])])
    outcome, _, workload = await run_workload("eval-instruction-v1", server)

    assert outcome.scores["total"] == workload["params"]["num_requests"]
    assert outcome.scores["accuracy"] == 1.0, "every example_pass must satisfy its rules"


async def test_eval_vision_workload_attaches_the_images() -> None:
    """``eval-vision-v1``: every request carries the row's PNG as a data URL."""
    from atlas_bench.workloads.eval import encode_image

    registry = Registry(REPO)
    directory = registry.dataset_dir("eval-vision-v1")
    # Keyed by the image, not the question: many rows ask the same question of a
    # different picture.
    answers = {
        encode_image(directory / str(row.image)): str(row.answer)
        for row in load_eval_rows(registry, "eval-vision-v1")
    }

    def responder(messages: list[dict[str, Any]]) -> str:
        parts = messages[-1]["content"]
        url = next(p["image_url"]["url"] for p in parts if p["type"] == "image_url")
        return f"Answer: {answers[url]}"

    server = FakeOpenAIServer(responder=responder)
    outcome, _, workload = await run_workload("eval-vision-v1", server)

    for body in server.requests:
        parts = body["messages"][-1]["content"]
        assert isinstance(parts, list)
        assert parts[-1]["image_url"]["url"].startswith("data:image/png;base64,")
    assert outcome.scores["total"] == workload["params"]["num_requests"]
    assert outcome.scores["accuracy"] == 1.0


async def test_eval_longctx_as_an_eval_workload_renders_the_document() -> None:
    """``eval-longctx-v1`` run as an eval still sends document + question."""
    registry = Registry(REPO)
    answers = _rendered_answers(registry, "eval-longctx-v1")

    def responder(messages: list[dict[str, Any]]) -> str:
        answer = answers.get(str(messages[-1]["content"]))
        if answer is None:
            return "?"
        if isinstance(answer, dict):
            return "It is not mentioned in the log."
        return f"Answer: {answer}"

    server = FakeOpenAIServer(responder=responder)
    outcome, ctx, _ = await run_workload("eval-longctx-v1", server, overrides={"num_requests": 12})

    assert ctx.warnings == [], "every haystack must rebuild to its recorded sha256"
    assert outcome.scores["total"] == 12
    assert outcome.scores["accuracy"] == 1.0
    assert min(len(json.dumps(m[-1]["content"])) for m in _messages_of(server)) > 4_000


def test_depth_sweep_grid_matches_the_declared_axis() -> None:
    """``longctx-depth-sweep-v1`` walks its eight sizes at the declared 90 % depth."""
    from atlas_bench.workloads.longctx import longctx_points

    registry = Registry(REPO)
    workload, params = resolve_workload(registry, WorkloadRef(id="longctx-depth-sweep-v1"))
    ctx = RunContext(spec=_spec(), registry=registry, client=None, workload=workload, params=params)
    points = longctx_points(ctx)

    assert [p["input_tokens"] for p in points] == workload["sweep"]["input_tokens"]
    assert {p["depth_pct"] for p in points} == {90.0}
    assert ctx.warnings == [], "every recipe must rebuild to its recorded sha256"
    # The 256k point really is a megabyte of document, not a filler stand-in.
    assert len(points[-1]["prompt"].messages[-1]["content"]) > 1_000_000


async def test_reasoning_default_is_left_alone() -> None:
    """``params.reasoning: "default"`` must not put a reasoning_effort on the request."""
    server = FakeOpenAIServer(responder=lambda m: "Answer: 1")
    await run_workload("eval-format-v1", server)
    assert all("reasoning_effort" not in body for body in server.requests)


async def test_explicit_reasoning_is_passed_through() -> None:
    """Any other value is an explicit effort level and goes to the engine."""
    server = FakeOpenAIServer(responder=lambda m: "Answer: 1")
    await run_workload("eval-format-v1", server, overrides={"reasoning": "high"})
    assert all(body["reasoning_effort"] == "high" for body in server.requests)
