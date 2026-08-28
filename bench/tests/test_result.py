"""Result assembly: payload bounding, derived metrics, gotchas, provenance and paths."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from atlas_bench.registry import Registry
from atlas_bench.result import (
    PAYLOAD_LIMIT_BYTES,
    ResultInputs,
    auto_gotchas,
    bound_payload,
    build_result,
    derived_metrics,
    output_path,
    resolve_login,
)
from atlas_bench.workloads.base import WorkloadOutcome
from tests.test_run_e2e import host, make_spec


def test_payload_under_the_limit_is_untouched() -> None:
    """Small payloads are stored verbatim."""
    payload = {"requests": [{"id": "r1"}], "iterations": [{"output_tok_s": 1.0}]}
    bounded, truncated = bound_payload(payload)
    assert bounded == payload
    assert truncated is False


def test_payload_over_the_limit_drops_traces_first() -> None:
    """Aggregates survive; the per-request trace is what gets cut (SPEC §4)."""
    payload = {
        "iterations": [{"output_tok_s": 1.0}],
        "requests": [{"id": f"r{i}", "blob": "x" * 200} for i in range(2000)],
    }
    bounded, truncated = bound_payload(payload)
    assert truncated is True
    assert bounded["iterations"] == [{"output_tok_s": 1.0}]
    assert len(json.dumps(bounded).encode()) <= PAYLOAD_LIMIT_BYTES
    assert bounded["requests_truncated_from"] == 2000


def test_derived_metrics() -> None:
    """tokens/watt, roofline ratio, bandwidth efficiency, headroom and cloud cost."""
    metrics = {
        "output_tok_s": 200.0,
        "power_avg_w": 100.0,
        "decode_tok_s_per_request": {"mean": 50.0},
        "vram_peak_gb": 20.0,
    }
    hardware = {"memory_bandwidth_gbs": 1000, "memory_gb": 24, "typical_cloud_usd_per_h": 2.0}
    derived = derived_metrics(metrics, hardware, {"moe": False}, {"size_gb": 10.0})

    assert derived["tokens_per_watt"] == 2.0
    assert derived["tok_s_per_gb_bandwidth"] == 0.05
    assert derived["bandwidth_efficiency"] == 0.5
    assert derived["memory_headroom_gb"] == 4.0
    # 200 tok/s * 3600 s = 720k tokens per $2 → $2.78 per million
    assert derived["cost_per_1m_output_tokens_usd"] == 2.777778


def test_derived_metrics_without_data_are_null() -> None:
    """No power measurement means no tokens/watt — not a zero."""
    derived = derived_metrics({"output_tok_s": 10.0}, {})
    assert derived["tokens_per_watt"] is None
    assert derived["cost_per_1m_output_tokens_usd"] is None


def test_moe_models_use_active_weights_for_efficiency() -> None:
    """A 30B-A3B reads a tenth of its weights per token."""
    dense = derived_metrics(
        {"decode_tok_s_per_request": {"mean": 100.0}},
        {"memory_bandwidth_gbs": 273},
        {"moe": False},
        {"size_gb": 20.0},
    )
    moe = derived_metrics(
        {"decode_tok_s_per_request": {"mean": 100.0}},
        {"memory_bandwidth_gbs": 273},
        {"moe": True, "params_b": 30, "active_params_b": 3},
        {"size_gb": 20.0},
    )
    assert moe["bandwidth_efficiency"] < dense["bandwidth_efficiency"]


def inputs(atlas_repo: Path, outcome: WorkloadOutcome, **kwargs) -> ResultInputs:
    """Result inputs for the throwaway registry."""
    return ResultInputs(
        spec=make_spec(),
        registry=Registry(atlas_repo),
        host=host(),
        outcome=outcome,
        workload={"id": "serve-test-c2-v1", "kind": "serving"},
        github_login="tester",
        started_at="2026-08-23T10:00:00Z",
        finished_at="2026-08-23T10:05:00Z",
        serve_command="vllm serve test",
        **kwargs,
    )


def test_auto_gotchas_from_failures_and_telemetry(atlas_repo: Path) -> None:
    """OOM, context overflow and thermal throttling are detected, not typed by hand."""
    outcome = WorkloadOutcome(
        kind="serving",
        metrics={"thermal_throttle_detected": True},
        failures=[
            {"at": "request", "count": 1, "category": "oom"},
            {"at": "request", "count": 2, "category": "context-overflow"},
        ],
    )
    found = auto_gotchas(
        inputs(atlas_repo, outcome, extra_gotchas=["Prefix caching defaults OFF here."]),
        outcome.metrics,
    )
    text = " ".join(g["text"] for g in found)
    assert "out-of-memory" in text
    assert "context window" in text
    assert "thermal" in text
    assert "Prefix caching defaults OFF here." in text
    assert {g["severity"] for g in found} <= {"info", "warn", "blocker"}


def test_warnings_become_gotchas(atlas_repo: Path) -> None:
    """A synthetic dataset fallback is disclosed in the result itself."""
    outcome = WorkloadOutcome(kind="serving", warnings=["dataset-missing:prompts-x-v1"])
    found = auto_gotchas(inputs(atlas_repo, outcome), None)
    assert any("synthetically" in g["text"] for g in found)


def test_gotchas_are_deduplicated(atlas_repo: Path) -> None:
    """The same detection firing twice is still one gotcha."""
    outcome = WorkloadOutcome(
        kind="serving",
        warnings=["dataset-missing:x", "dataset-missing:x"],
    )
    found = auto_gotchas(inputs(atlas_repo, outcome), None)
    assert len(found) == 1


def test_agent_provenance_from_environment(atlas_repo: Path, monkeypatch) -> None:
    """``ATLAS_AGENT_NAME`` flips the method to ``agent`` and fills the agent block."""
    monkeypatch.setenv("ATLAS_AGENT_NAME", "claude-code")
    monkeypatch.setenv("ATLAS_AGENT_MODEL", "claude-fable-5")
    record = build_result(inputs(atlas_repo, WorkloadOutcome(kind="serving", metrics=None)))
    assert record["provenance"]["method"] == "agent"
    assert record["provenance"]["agent"] == {"name": "claude-code", "model": "claude-fable-5"}


def test_attach_install_method_is_null(atlas_repo: Path) -> None:
    """``attach`` is not a schema install method; it becomes null rather than invalid."""
    record = build_result(
        inputs(atlas_repo, WorkloadOutcome(kind="serving"), install_method="attach")
    )
    assert record["engine"]["install_method"] is None


def test_output_path_from_repo_root_or_results_dir(atlas_repo: Path) -> None:
    """Both ``--out .`` and ``--out results`` land in the same place."""
    record = build_result(inputs(atlas_repo, WorkloadOutcome(kind="serving")))
    from_root = output_path(record, atlas_repo)
    from_results = output_path(record, atlas_repo / "results")
    assert from_root == from_results
    assert from_root.parent.name == "test-gpu-24gb"
    assert from_root.name == f"{record['run_id']}.json"


def test_resolve_login_prefers_the_explicit_value(monkeypatch) -> None:
    """``--login`` wins over the environment."""
    monkeypatch.setenv("ATLAS_GITHUB_LOGIN", "from-env")
    assert resolve_login("explicit") == "explicit"
    assert resolve_login(None) == "from-env"


def test_derived_metrics_scales_registered_figures_by_hardware_count() -> None:
    """Bandwidth and memory are per device; a tensor-parallel run has all of them.

    Without this the repository's first multi-device result reported twice the bandwidth
    efficiency it actually achieved. packages/core/src/plausibility.ts already scales the
    same way, so the two implementations agreeing is the point.
    """
    metrics = {
        "output_tok_s": 50.0,
        "decode_tok_s_per_request": {"mean": 50.0},
        "vram_peak_gb": 100.0,
    }
    hardware = {"memory_bandwidth_gbs": 273.0, "memory_gb": 128.0}
    model = {"moe": False}
    quant = {"size_gb": 10.0}

    one = derived_metrics(metrics, hardware, model, quant, hw_count=1)
    two = derived_metrics(metrics, hardware, model, quant, hw_count=2)

    # Twice the aggregate bandwidth for the same achieved throughput is half the efficiency.
    assert two["bandwidth_efficiency"] == pytest.approx(one["bandwidth_efficiency"] / 2)
    assert two["tok_s_per_gb_bandwidth"] == pytest.approx(one["tok_s_per_gb_bandwidth"] / 2)
    # Two devices' worth of registered memory, against one measured peak.
    assert one["memory_headroom_gb"] == pytest.approx(28.0)
    assert two["memory_headroom_gb"] == pytest.approx(156.0)
    # Measured figures are never scaled: power is what the meter said.
    assert two["tokens_per_watt"] == one["tokens_per_watt"]
    # The default stays single-device.
    assert (
        derived_metrics(metrics, hardware, model, quant)["bandwidth_efficiency"]
        == (one["bandwidth_efficiency"])
    )
