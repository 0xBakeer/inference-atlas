"""Dataset loading, deterministic sampling and the long-context / prefill runners."""

from __future__ import annotations

import json
from pathlib import Path

from atlas_bench.client import ChatClient
from atlas_bench.data import (
    build_haystack,
    load_eval_rows,
    load_haystack_rows,
    load_prompt_rows,
    sample_prompts,
    synthetic_prompt,
)
from atlas_bench.registry import Registry
from atlas_bench.spec import TaskSpec
from atlas_bench.workloads import RunContext, get_runner, resolve_workload
from atlas_bench.workloads.longctx import longctx_points
from atlas_bench.workloads.sweep import sweep_axis
from tests.conftest import FakeOpenAIServer


def test_prompt_and_eval_rows_load(atlas_repo: Path) -> None:
    """Both row shapes are read from the dataset directory."""
    registry = Registry(atlas_repo)
    prompts = load_prompt_rows(registry, "prompts-test-v1")
    assert len(prompts) == 4
    assert prompts[0].messages[0]["role"] == "user"
    assert prompts[0].approx_tokens == 128

    items = load_eval_rows(registry, "eval-test-v1")
    assert len(items) == 3
    assert items[0].scorer == "numeric"
    assert items[0].messages[0]["content"] == "2+2?"


def test_missing_dataset_is_empty_not_an_error(atlas_repo: Path) -> None:
    """A dataset that has not been authored yet returns no rows."""
    assert load_prompt_rows(Registry(atlas_repo), "does-not-exist") == []


def test_sampling_is_deterministic() -> None:
    """The same seed picks the same prompts, a different seed does not."""
    rows = [synthetic_prompt(100, i) for i in range(20)]
    a = [r.id for r in sample_prompts(rows, 5, seed=42)]
    b = [r.id for r in sample_prompts(rows, 5, seed=42)]
    c = [r.id for r in sample_prompts(rows, 5, seed=43)]
    assert a == b
    assert a != c


def test_sampling_prefers_the_requested_length() -> None:
    """A prefill workload asking for 32k tokens draws from the longest prompts available."""
    lengths = [16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768]
    rows = [synthetic_prompt(length, i) for i, length in enumerate(lengths)]
    picked = sample_prompts(rows, 2, seed=1, target_tokens=32768, pad=False)
    assert all(row.approx_tokens >= 256 for row in picked)
    short = sample_prompts(rows, 2, seed=1, target_tokens=64, pad=False)
    assert all(row.approx_tokens <= 2048 for row in short)


def test_short_prompts_are_padded_to_the_target() -> None:
    """A long-context workload must really send long prompts."""
    rows = [synthetic_prompt(64, 0)]
    picked = sample_prompts(rows, 1, seed=1, target_tokens=4096)
    assert picked[0].padded is True
    assert picked[0].approx_tokens == 4096
    assert len(picked[0].messages[0]["content"]) > 1000


def test_sampling_without_rows_falls_back_to_synthetic() -> None:
    """The harness stays usable before the datasets land — visibly synthetic."""
    picked = sample_prompts([], 3, seed=1, target_tokens=128)
    assert len(picked) == 3
    assert all(row.id.startswith("synthetic-") for row in picked)


def test_build_haystack_places_the_needle_at_depth() -> None:
    """The needle really is where the depth says it is."""
    messages, answer = build_haystack(input_tokens=800, depth_pct=10)
    content = messages[0]["content"]
    assert answer == "7431-KILO"
    assert "7431-KILO" in content
    position = content.index("7431-KILO") / len(content)
    assert 0.05 < position < 0.35


def test_haystack_dataset_rows_are_materialized(tmp_path: Path) -> None:
    """A recipe dataset with a ``build.py`` is reconstructed through that build script."""
    root = tmp_path / "atlas"
    directory = root / "datasets" / "hay-v1"
    directory.mkdir(parents=True)
    (directory / "dataset.json").write_text(
        json.dumps(
            {"schema_version": 1, "id": "hay-v1", "kind": "haystack", "files": ["items.jsonl"]}
        )
    )
    (directory / "items.jsonl").write_text(
        json.dumps(
            {
                "id": "hay-1k-d50",
                "target_tokens": 1024,
                "question": "What is the code?",
                "answer": "4242",
                "needles": [{"depth": 0.5, "text": "The code is 4242.", "answer": "4242"}],
            }
        )
        + "\n"
    )
    (directory / "build.py").write_text(
        "def build_prompt(item):\n"
        "    return f\"DOC {item['needles'][0]['text']}\\n\\n{item['question']}\"\n"
    )
    rows = load_haystack_rows(Registry(root), "hay-v1")
    assert len(rows) == 1
    assert rows[0].input_tokens == 1024
    assert rows[0].depth_pct == 50.0
    assert rows[0].answer == "4242"
    assert "The code is 4242." in rows[0].prompt.messages[0]["content"]


def test_sweep_axis_selection() -> None:
    """The axis is whatever the workload declares, defaulting to concurrency."""
    assert sweep_axis({"sweep": {"concurrency": [1, 2]}}) == ("concurrency", [1, 2])
    assert sweep_axis({"sweep": {"input_tokens": [1024]}}) == ("input_tokens", [1024])
    assert sweep_axis({}) == ("concurrency", [1, 2, 4, 8, 16, 32])


def context(atlas_repo: Path, workload: dict, client: ChatClient) -> RunContext:
    """A run context for one synthetic workload."""
    spec = TaskSpec.model_validate(
        {
            "engine": {"id": "vllm", "version": "0.27.1"},
            "model": {"id": "acme/test-model-1b", "quant_id": "fp8"},
            "hardware": {"id": "test-gpu-24gb"},
            "workloads": [workload["id"]],
        }
    )
    return RunContext(
        spec=spec,
        registry=Registry(atlas_repo),
        client=client,
        workload=workload,
        params=workload.get("params") or {},
    )


def test_longctx_points_from_the_workload_sweep(
    atlas_repo: Path, fake_server: FakeOpenAIServer
) -> None:
    """Without a dataset the grid is generated locally and the run says so."""
    workload = {
        "id": "longctx-test-v1",
        "kind": "longctx",
        "sweep": {"input_tokens": [512, 1024], "depth": [10, 90]},
        "params": {"output_tokens": 8, "seed": 3},
    }
    ctx = context(
        atlas_repo, workload, ChatClient("http://fake", "m", transport=fake_server.transport)
    )
    points = longctx_points(ctx)
    assert [(p["input_tokens"], p["depth_pct"]) for p in points] == [
        (512, 10.0),
        (512, 90.0),
        (1024, 10.0),
        (1024, 90.0),
    ]
    assert any(w.startswith("dataset-missing") for w in ctx.warnings)


async def test_longctx_run_scores_the_needle(atlas_repo: Path) -> None:
    """Each point records throughput and whether the needle was found."""
    server = FakeOpenAIServer(responder=lambda m: "The code is 7431-KILO.")
    workload = {
        "id": "longctx-test-v1",
        "kind": "longctx",
        "sweep": {"input_tokens": [256], "depth": [50]},
        "params": {"output_tokens": 8, "seed": 3},
    }
    async with ChatClient("http://fake", "m", transport=server.transport) as client:
        outcome = await get_runner("longctx")(context(atlas_repo, workload, client))

    assert outcome.kind == "longctx"
    assert len(outcome.sweep) == 1
    entry = outcome.sweep[0]
    assert entry["input_tokens"] == 256
    assert "needle found" in entry["label"]
    assert set(entry) <= {
        "concurrency",
        "input_tokens",
        "output_tokens",
        "num_requests",
        "label",
        "metrics",
    }
    assert outcome.resolved_params["needles_found"] == 1
    assert outcome.raw["points"][0]["needle_correct"] is True


async def test_longctx_records_a_missed_needle(atlas_repo: Path) -> None:
    """A model that loses the needle produces a warn gotcha, not a silent pass."""
    server = FakeOpenAIServer(responder=lambda m: "I could not find it.")
    workload = {
        "id": "longctx-test-v1",
        "kind": "longctx",
        "sweep": {"input_tokens": [256], "depth": [50]},
        "params": {"output_tokens": 8},
    }
    async with ChatClient("http://fake", "m", transport=server.transport) as client:
        outcome = await get_runner("longctx")(context(atlas_repo, workload, client))
    assert outcome.resolved_params["needles_found"] == 0
    assert any(g["severity"] == "warn" for g in outcome.gotchas)


async def test_prefill_workload(atlas_repo: Path, fake_server: FakeOpenAIServer) -> None:
    """Prefill: big input, one output token, TTFT is the measurement."""
    workload = {
        "id": "prefill-test-v1",
        "kind": "prefill",
        "dataset_id": "prompts-test-v1",
        "params": {"num_requests": 2, "input_tokens": 2048, "output_tokens": 1, "concurrency": 1},
    }
    async with ChatClient("http://fake", "m", transport=fake_server.transport) as client:
        outcome = await get_runner("prefill")(context(atlas_repo, workload, client))

    assert outcome.kind == "prefill"
    assert outcome.metrics["requests_ok"] == 2
    assert outcome.metrics["ttft_ms"]["mean"] > 0
    assert outcome.metrics["prefill_tok_s"] > 0
    assert outcome.resolved_params["prompts_padded"] is True


def test_resolve_workload_merges_packet_overrides(atlas_repo: Path) -> None:
    """A packet may tune a registered workload's parameters for one run."""
    from atlas_bench.spec import WorkloadRef

    record, params = resolve_workload(
        Registry(atlas_repo), WorkloadRef(id="serve-test-c2-v1", params={"num_requests": 2})
    )
    assert record["kind"] == "serving"
    assert params["num_requests"] == 2
    assert params["concurrency"] == 2


def test_resolve_unknown_workload_infers_its_kind(atlas_repo: Path) -> None:
    """A workload added in the same PR is still runnable."""
    from atlas_bench.spec import WorkloadRef

    record, _ = resolve_workload(Registry(atlas_repo), WorkloadRef(id="eval-brand-new-v1"))
    assert record["kind"] == "eval"


# 1x1 transparent PNG — the smallest valid image, so vision rows can be tested offline.
TINY_PNG = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4"
    "890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082"
)


def test_vision_rows_inline_the_image(tmp_path: Path) -> None:
    """An eval row's ``image`` becomes a base64 data URL content part."""
    from atlas_bench.data import EvalRow
    from atlas_bench.workloads.eval import build_messages, encode_image

    (tmp_path / "images").mkdir()
    (tmp_path / "images" / "chart.png").write_bytes(TINY_PNG)

    row = EvalRow.from_dict(
        {"id": "v-1", "prompt": "What is in the image?", "image": "images/chart.png"}
    )
    messages = build_messages(row, tmp_path)
    parts = messages[0]["content"]
    assert parts[0] == {"type": "text", "text": "What is in the image?"}
    assert parts[1]["type"] == "image_url"
    assert parts[1]["image_url"]["url"].startswith("data:image/png;base64,")
    assert encode_image(tmp_path / "missing.png") is None


def test_vision_row_without_a_readable_image_still_runs(tmp_path: Path) -> None:
    """A missing image degrades to a text-only prompt instead of crashing the suite."""
    from atlas_bench.data import EvalRow
    from atlas_bench.workloads.eval import build_messages

    row = EvalRow.from_dict({"id": "v-2", "prompt": "Describe it", "image": "nope.png"})
    assert build_messages(row, tmp_path) == [{"role": "user", "content": "Describe it"}]


async def test_eval_row_scorer_overrides_the_workload_default(atlas_repo: Path) -> None:
    """A row that declares its own scorer wins over the workload's default."""
    server = FakeOpenAIServer(responder=lambda m: "Answer: Paris")
    workload = {
        "id": "eval-mixed-v1",
        "kind": "eval",
        "dataset_id": "eval-mixed-v1",
        "eval": {"suite": "mixed", "scorer": "numeric"},
        "params": {"concurrency": 1, "output_tokens": 16},
    }
    directory = atlas_repo / "datasets" / "eval-mixed-v1"
    directory.mkdir(parents=True)
    (directory / "dataset.json").write_text(
        json.dumps(
            {"schema_version": 1, "id": "eval-mixed-v1", "kind": "eval", "files": ["items.jsonl"]}
        )
    )
    (directory / "items.jsonl").write_text(
        json.dumps(
            {"id": "q-1", "prompt": "Capital of France?", "answer": "Paris", "scorer": "exact"}
        )
        + "\n"
    )
    async with ChatClient("http://fake", "m", transport=server.transport) as client:
        outcome = await get_runner("eval")(context(atlas_repo, workload, client))

    assert outcome.scores["correct"] == 1
    assert outcome.scores["items"][0]["predicted"] == "Paris"


async def test_eval_without_a_dataset_is_a_blocker(
    atlas_repo: Path, fake_server: FakeOpenAIServer
) -> None:
    """An eval with no rows produces no scores and says why."""
    workload = {
        "id": "eval-empty-v1",
        "kind": "eval",
        "dataset_id": "nope-v1",
        "eval": {"suite": "x"},
        "params": {},
    }
    async with ChatClient("http://fake", "m", transport=fake_server.transport) as client:
        outcome = await get_runner("eval")(context(atlas_repo, workload, client))
    assert outcome.scores is None
    assert outcome.gotchas[0]["severity"] == "blocker"


async def test_prompt_tokens_are_backfilled_when_usage_is_missing(atlas_repo: Path) -> None:
    """An engine without ``usage`` still yields input-token counts, via ``/tokenize``."""
    server = FakeOpenAIServer(report_usage=False, prompt_tokens=321)
    workload = {
        "id": "serve-test-c2-v1",
        "kind": "serving",
        "dataset_id": "prompts-test-v1",
        "params": {"concurrency": 1, "num_requests": 2, "output_tokens": 8},
    }
    async with ChatClient("http://fake", "m", transport=server.transport) as client:
        outcome = await get_runner("serving")(context(atlas_repo, workload, client))

    assert outcome.metrics["input_tokens_total"] == 642
    assert outcome.metrics["prefill_tok_s"] > 0
    assert all(r.prompt_tokens == 321 for r in outcome.requests if r.ok)
