"""Wrapping engine-native benchmark output into a result file."""

from __future__ import annotations

import json
from pathlib import Path

from atlas_bench.wrap import detect_source, load_native, native_started_at, wrap_metrics

FIXTURES = Path(__file__).parent / "fixtures"


def test_detects_vllm_bench_serve() -> None:
    """``mean_e2el_ms`` / ``total_token_throughput`` identify vLLM's harness."""
    raw = load_native(FIXTURES / "vllm_bench_serve.json")
    assert detect_source(raw) == "vllm-bench-serve"


def test_detects_sglang_bench_serving() -> None:
    """``mean_e2e_latency_ms`` identifies SGLang's."""
    raw = load_native(FIXTURES / "sglang_bench_serving.json")
    assert detect_source(raw) == "sglang-bench-serving"


def test_unknown_shape_is_flagged_not_guessed() -> None:
    """An unrecognized JSON is reported as such rather than silently mismapped."""
    assert detect_source({"hello": "world"}) == "unknown"


def test_vllm_field_mapping() -> None:
    """Every vLLM field lands on its SPEC counterpart."""
    metrics, params, source = wrap_metrics(load_native(FIXTURES / "vllm_bench_serve.json"))

    assert source == "vllm-bench-serve"
    assert metrics["requests_total"] == 200
    assert metrics["requests_ok"] == 198
    assert metrics["requests_failed"] == 2
    assert metrics["success_rate"] == 0.99
    assert metrics["duration_s"] == 123.4
    assert metrics["output_tok_s"] == 410.76
    assert metrics["total_tok_s"] == 2070.4
    assert metrics["req_s"] == 1.604
    assert metrics["ttft_ms"] == {"mean": 184.2, "p50": 161.0, "p99": 611.3}
    assert metrics["tpot_ms"]["p50"] == 10.9
    assert metrics["itl_ms"]["mean"] == 11.1
    assert metrics["e2e_ms"]["p50"] == 2950.0
    assert params["concurrency"] == 8
    assert params["source_model"] == "Qwen/Qwen3.8-27B-FP8"


def test_sglang_field_mapping() -> None:
    """SGLang names its e2e distribution differently; the mapping handles it."""
    metrics, params, source = wrap_metrics(load_native(FIXTURES / "sglang_bench_serving.json"))

    assert source == "sglang-bench-serving"
    assert metrics["requests_ok"] == 160
    assert metrics["output_tok_s"] == 512.0
    assert metrics["e2e_ms"] == {"mean": 2800.5, "p50": 2700.0, "p99": 3900.0}
    assert metrics["itl_ms"]["p95"] == 13.2
    assert params["concurrency"] == 16


def test_prefill_is_derived_from_ttft_and_concurrency() -> None:
    """``prefill_tok_s`` is reconstructed with the documented formula."""
    metrics, _, _ = wrap_metrics(load_native(FIXTURES / "vllm_bench_serve.json"))
    # 204800 input tokens over (0.1842 s * 198 / 8) = 4.559 s of prefill wall clock
    assert metrics["prefill_tok_s"] == 44922.625


def test_unmeasured_fields_stay_null() -> None:
    """A wrapped result never invents what the native harness did not report."""
    metrics, _, _ = wrap_metrics(load_native(FIXTURES / "vllm_bench_serve.json"))
    assert metrics["vram_peak_gb"] is None
    assert metrics["power_avg_w"] is None
    assert metrics["decode_tok_s_per_request"] is None


def test_native_started_at_normalizes_the_date() -> None:
    """vLLM's ``20260816-141516`` becomes an ISO-8601 timestamp."""
    assert native_started_at({"date": "20260816-141516"}) == "2026-08-16T14:15:16Z"
    assert native_started_at({"date": "nonsense"}) is None
    assert native_started_at({}) is None


def test_load_native_takes_the_last_entry_of_a_list(tmp_path: Path) -> None:
    """Some harnesses append runs to a JSON array."""
    path = tmp_path / "runs.json"
    path.write_text(json.dumps([{"completed": 1}, {"completed": 2}]))
    assert load_native(path)["completed"] == 2
