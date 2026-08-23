"""End-to-end: packet in, valid result file out — against a fake streaming server."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from atlas_bench.canonical import canonicalize
from atlas_bench.hwinfo import GpuInfo, HostInfo
from atlas_bench.ids import cell_id, config_id_from_canonical, run_id
from atlas_bench.registry import Registry
from atlas_bench.runner import plan_spec, run_spec
from atlas_bench.spec import TaskSpec
from atlas_bench.validate import validate_file
from tests.conftest import FakeOpenAIServer

LOGIN = "tester"


def host() -> HostInfo:
    """A fixed host so the fingerprint and host block are deterministic."""
    info = HostInfo(
        platform="linux",
        arch="x86_64",
        os="Ubuntu 24.04.3 LTS",
        kernel="6.11.0",
        cpu="AMD EPYC 7543",
        cpu_cores=32,
        ram_gb=256.0,
        driver="580.95.05",
        cuda="13.0",
    )
    info.gpus = [GpuInfo(name="Test GPU 24GB", memory_total_mb=24576, driver="580.95.05")]
    info.captured = {"nvidia_smi": {"driver": "580.95.05", "cuda": "13.0"}}
    return info


def make_spec(workload: str = "serve-test-c2-v1", **overrides) -> TaskSpec:
    """A packet for the throwaway registry."""
    payload = {
        "packet_version": 1,
        "engine": {
            "id": "vllm",
            "version": "0.27.1",
            "install": {"method": "docker", "image": "vllm/vllm-openai:v0.27.1"},
            "base_url": "http://fake",
        },
        "model": {
            "id": "test-model-1b",
            "quant_id": "fp8",
            "hf_id": "test/Test-Model-1B-FP8",
            "dtype": "auto",
        },
        "hardware": {"id": "test-gpu-24gb", "count": 1},
        "args": {
            "max-model-len": 32768,
            "gpu-memory-utilization": 0.9,
            "-tp": 1,
            "enable-prefix-caching": True,
        },
        "workloads": [workload],
        "request": {"temperature": 0, "seed": 42},
        "github_login": LOGIN,
    }
    payload.update(overrides)
    return TaskSpec.model_validate(payload)


async def run(atlas_repo: Path, server: FakeOpenAIServer, spec: TaskSpec, **kwargs):
    """Run a packet against the fake server."""
    return await run_spec(
        spec,
        registry=Registry(atlas_repo),
        out_dir=atlas_repo / "results",
        github_login=LOGIN,
        telemetry=False,
        transport=server.transport,
        host=host(),
        **kwargs,
    )


# ------------------------------------------------------------------- serving


async def test_serving_run_writes_a_valid_result(
    atlas_repo: Path, fake_server: FakeOpenAIServer
) -> None:
    """The happy path: one workload, one file, everything recomputable."""
    output = await run(atlas_repo, fake_server, make_spec())

    assert len(output.paths) == 1
    path = output.paths[0]
    record = json.loads(path.read_text())

    # Path and filename are derived, not chosen.
    assert path.relative_to(atlas_repo).parts[:4] == (
        "results",
        "vllm",
        "test-model-1b",
        "test-gpu-24gb",
    )
    assert path.name == f"{record['run_id']}.json"

    # Ids recompute from the content.
    registry = Registry(atlas_repo)
    resolved = registry.resolve_config(
        engine_id="vllm",
        engine_version="0.27.1",
        args=record["args"],
        quant_id="fp8",
        dtype="auto",
    )
    canonical = canonicalize(resolved.canonical_input)
    assert record["args_canonical"] == canonical
    assert record["config_id"] == config_id_from_canonical(canonical)
    assert record["cell_id"] == cell_id(
        model_id="test-model-1b",
        quant_id="fp8",
        hardware_id="test-gpu-24gb",
        hw_count=1,
        engine_id="vllm",
        engine_version="0.27.1",
    )
    assert record["run_id"] == run_id(
        cfg_id=record["config_id"],
        workload_id="serve-test-c2-v1",
        github_login=LOGIN,
        started_at=record["provenance"]["started_at"],
    )

    # Defaults dropped, aliases resolved, ports removed.
    assert "gpu-memory-utilization" not in canonical
    assert "tensor-parallel-size" not in canonical  # tp=1 is the version default
    assert "max-model-len=32768" in canonical

    # Metrics were actually measured.
    metrics = record["metrics"]
    assert metrics["requests_total"] == 6
    assert metrics["requests_ok"] == 6
    assert metrics["success_rate"] == 1.0
    assert metrics["output_tok_s"] > 0
    assert metrics["ttft_ms"]["p50"] > 0
    assert metrics["itl_ms"]["mean"] > 0
    assert metrics["decode_tok_s_per_request"]["mean"] > 0

    # Warmup happened and is excluded from the aggregate.
    assert len(fake_server.requests) == 7

    # Provenance and bookkeeping.
    assert record["provenance"]["github_login"] == LOGIN
    assert record["provenance"]["method"] == "atlas-bench"
    assert record["provenance"]["github_user_id"] is None
    assert record["provenance"]["commit"] is None
    assert record["hardware"]["fingerprint"].startswith("sha256:")
    assert record["raw"]["harness"] == "atlas-bench"
    assert len(record["raw"]["sha256"]) == 64
    assert record["verification"]["level"] == "self-reported"
    assert record["failures"] == []


async def test_result_passes_local_validation(
    atlas_repo: Path, fake_server: FakeOpenAIServer
) -> None:
    """The file the harness writes passes its own validator, schema included."""
    output = await run(atlas_repo, fake_server, make_spec())
    issues = validate_file(output.paths[0], Registry(atlas_repo))
    errors = [i for i in issues if i.level == "error"]
    assert errors == [], "\n".join(str(i) for i in issues)


async def test_validator_catches_hand_edited_numbers(
    atlas_repo: Path, fake_server: FakeOpenAIServer
) -> None:
    """Editing a flag by hand breaks the recomputed ids — which is the whole point."""
    output = await run(atlas_repo, fake_server, make_spec())
    path = output.paths[0]
    record = json.loads(path.read_text())
    record["args"]["max-model-len"] = 8192
    path.write_text(json.dumps(record))

    codes = {i.code for i in validate_file(path, Registry(atlas_repo)) if i.level == "error"}
    assert "args-canonical-mismatch" in codes
    assert "config-id-mismatch" in codes


async def test_failures_are_recorded_not_hidden(atlas_repo: Path) -> None:
    """A server that OOMs every third request produces failures and a blocker gotcha."""
    server = FakeOpenAIServer(fail_every=3, fail_status=500, fail_body="CUDA out of memory")
    output = await run(atlas_repo, server, make_spec())
    record = json.loads(output.paths[0].read_text())

    assert record["metrics"]["requests_failed"] >= 1
    assert record["metrics"]["success_rate"] < 1.0
    assert record["failures"][0]["category"] == "oom"
    assert record["failures"][0]["at"] == "request"
    assert any(g["severity"] == "blocker" for g in record["gotchas"])


# --------------------------------------------------------------------- sweep


async def test_sweep_walks_the_axis(atlas_repo: Path, fake_server: FakeOpenAIServer) -> None:
    """Every concurrency level is measured and recorded."""
    output = await run(atlas_repo, fake_server, make_spec("sweep-test-1-4-v1"))
    record = json.loads(output.paths[0].read_text())

    assert record["kind"] == "sweep"
    assert [entry["concurrency"] for entry in record["sweep"]] == [1, 2, 4]
    assert all(entry["metrics"]["requests_ok"] == 4 for entry in record["sweep"])
    assert record["workload"]["resolved_params"]["levels_run"] == [1, 2, 4]
    assert record["workload"]["resolved_params"]["stopped_at"] is None


async def test_sweep_stops_escalating_on_failure(atlas_repo: Path) -> None:
    """When a level falls over, the sweep records it and stops instead of pretending."""
    server = FakeOpenAIServer(fail_every=2, fail_status=500, fail_body="CUDA out of memory")
    output = await run(atlas_repo, server, make_spec("sweep-test-1-4-v1"))
    record = json.loads(output.paths[0].read_text())

    assert len(record["sweep"]) == 1
    assert record["workload"]["resolved_params"]["stopped_at"] == 1
    assert any("Sweep stopped" in g["text"] for g in record["gotchas"])


# ---------------------------------------------------------------------- eval


async def test_eval_scores_every_item(atlas_repo: Path) -> None:
    """The eval workload answers, scores and aggregates by category and difficulty."""
    answers = {"2+2?": "The answer is 4", "3+3?": "The answer is 6", "x?": "The answer is 41"}

    def responder(messages):
        prompt = str(messages[-1].get("content"))
        return answers.get(prompt, "no idea")

    server = FakeOpenAIServer(responder=responder)
    output = await run(atlas_repo, server, make_spec("eval-test-v1"))
    record = json.loads(output.paths[0].read_text())

    scores = record["scores"]
    assert record["kind"] == "eval"
    assert scores["suite"] == "math"
    assert scores["total"] == 3
    assert scores["correct"] == 2
    assert scores["accuracy"] == pytest.approx(2 / 3, abs=1e-6)
    assert scores["by_category"] == {
        "algebra": {"total": 1, "correct": 0},
        "arithmetic": {"total": 2, "correct": 2},
    }
    assert scores["by_difficulty"]["easy"] == {"total": 2, "correct": 2}
    assert {item["id"] for item in scores["items"]} == {"m-1", "m-2", "m-3"}
    assert all(isinstance(item["correct"], bool) for item in scores["items"])
    assert scores["avg_latency_ms"] > 0
    # Every request completed; one of them was simply wrong, which is accuracy, not failure.
    assert scores["success_rate"] == 1.0
    assert record["metrics"]["success_rate"] == 1.0


async def test_eval_success_rate_is_independent_of_correctness(atlas_repo: Path) -> None:
    """A failed request lowers ``success_rate`` and leaves accuracy to the scored items."""
    server = FakeOpenAIServer(responder=lambda m: "The answer is 4", fail_every=3)
    output = await run(atlas_repo, server, make_spec("eval-test-v1"))
    record = json.loads(output.paths[0].read_text())

    scores = record["scores"]
    assert scores["success_rate"] == pytest.approx(2 / 3, abs=1e-6)
    assert scores["total"] == 2, "the failed request cannot be scored"
    assert len(scores["items"]) == 2
    assert scores["failures"] == 1
    assert record["failures"][0]["category"] == "http-5xx"
    # The request layer agrees with the score layer about what completed.
    assert record["metrics"]["success_rate"] == scores["success_rate"]
    assert record["metrics"]["requests_failed"] == 1


async def test_eval_result_is_schema_valid(atlas_repo: Path) -> None:
    """An eval result validates too (``scores`` is required for kind=eval)."""
    server = FakeOpenAIServer(responder=lambda m: "Answer: 4")
    output = await run(atlas_repo, server, make_spec("eval-test-v1"))
    errors = [i for i in validate_file(output.paths[0], Registry(atlas_repo)) if i.level == "error"]
    assert errors == [], "\n".join(str(i) for i in errors)


# ------------------------------------------------------------------- dry run


async def test_dry_run_touches_nothing(atlas_repo: Path, fake_server: FakeOpenAIServer) -> None:
    """``--dry-run`` resolves the plan without sending a request or writing a file."""
    output = await run(atlas_repo, fake_server, make_spec(), dry_run=True)
    assert output.paths == []
    assert fake_server.requests == []
    assert output.plan[0]["workload_id"] == "serve-test-c2-v1"
    assert output.plan[0]["kind"] == "serving"
    assert output.plan[0]["registered"] is True
    assert not list((atlas_repo / "results").rglob("*.json"))


def test_plan_marks_unregistered_workloads(atlas_repo: Path) -> None:
    """A workload the checkout does not have is still runnable, but flagged."""
    plan = plan_spec(make_spec("sweep-brand-new-v1"), Registry(atlas_repo))
    assert plan[0]["registered"] is False
    assert plan[0]["kind"] == "sweep"


async def test_two_workloads_produce_two_files(
    atlas_repo: Path, fake_server: FakeOpenAIServer
) -> None:
    """One result file per workload, both under the same cell."""
    spec = make_spec()
    spec.workloads = TaskSpec.model_validate(
        {
            **json.loads(spec.model_dump_json()),
            "workloads": ["serve-test-c2-v1", "sweep-test-1-4-v1"],
        }
    ).workloads
    output = await run(atlas_repo, fake_server, spec)
    assert len(output.paths) == 2
    cells = {json.loads(p.read_text())["cell_id"] for p in output.paths}
    assert len(cells) == 1
