"""Metric aggregation from synthetic request traces."""

from __future__ import annotations

import pytest

from atlas_bench.client import RequestResult
from atlas_bench.metrics import (
    aggregate_failures,
    aggregate_serving,
    distribution,
    empty_metric_block,
    percentile,
)


def trace(
    *,
    request_id: str = "r1",
    start: float = 0.0,
    ttft_s: float = 0.1,
    itl_s: float = 0.01,
    completion_tokens: int = 11,
    prompt_tokens: int = 100,
    ok: bool = True,
    warmup: bool = False,
    category: str | None = None,
) -> RequestResult:
    """A synthetic request with exactly known timings."""
    first = start + ttft_s
    chunks = [first + i * itl_s for i in range(completion_tokens)]
    result = RequestResult(
        request_id=request_id,
        started=start,
        first_token_at=first,
        finished=chunks[-1],
        chunk_times=chunks,
        prompt_tokens=prompt_tokens,
        completion_tokens=completion_tokens,
        warmup=warmup,
    )
    if not ok:
        result.status = "error"
        result.error_category = category or "http-5xx"
        result.error_message = "boom"
        result.first_token_at = None
        result.finished = start + 0.2
        result.chunk_times = []
        result.completion_tokens = None
    return result


def test_percentile_interpolates() -> None:
    """Linear interpolation between neighbouring ranks (the numpy default)."""
    assert percentile([1, 2], 50) == 1.5
    assert percentile([1, 2, 3, 4], 0) == 1
    assert percentile([1, 2, 3, 4], 100) == 4
    assert percentile([10], 99) == 10


def test_percentile_of_empty_raises() -> None:
    """An empty sequence has no percentile; callers must filter first."""
    with pytest.raises(ValueError, match="empty"):
        percentile([], 50)


def test_distribution_shape() -> None:
    """Every distribution carries mean/p50/p90/p95/p99/min/max."""
    block = distribution([1, 2, 3, 4, 5])
    assert set(block) == {"mean", "p50", "p90", "p95", "p99", "min", "max"}
    assert block["mean"] == 3.0
    assert block["p50"] == 3.0
    assert distribution([]) is None


def test_empty_block_has_every_spec_key() -> None:
    """A metric block always has the full key set, null where nothing was measured."""
    block = empty_metric_block()
    for key in ("requests_total", "output_tok_s", "ttft_ms", "vram_peak_gb", "energy_wh"):
        assert key in block


def test_aggregate_known_trace() -> None:
    """Hand-computable trace: 4 requests, 10 s window, 11 output tokens each."""
    results = [
        trace(request_id=f"r{i}", start=0.0, ttft_s=0.1, itl_s=0.01, completion_tokens=11)
        for i in range(4)
    ]
    block = aggregate_serving(results, concurrency=4, duration_s=10.0)

    assert block["requests_total"] == 4
    assert block["requests_ok"] == 4
    assert block["requests_failed"] == 0
    assert block["success_rate"] == 1.0
    assert block["duration_s"] == 10.0
    assert block["output_tokens_total"] == 44
    assert block["input_tokens_total"] == 400
    assert block["output_tok_s"] == pytest.approx(4.4)
    assert block["total_tok_s"] == pytest.approx(44.4)
    assert block["req_s"] == pytest.approx(0.4)
    # prefill: 400 input tokens over (4 * 0.1 s / 4 concurrent) = 0.1 s of wall clock
    assert block["prefill_tok_s"] == pytest.approx(4000.0)
    assert block["ttft_ms"]["mean"] == pytest.approx(100.0)
    # decode = 10 gaps * 10 ms = 100 ms over 10 further tokens
    assert block["tpot_ms"]["mean"] == pytest.approx(10.0)
    assert block["itl_ms"]["mean"] == pytest.approx(10.0)
    assert block["e2e_ms"]["mean"] == pytest.approx(200.0)
    assert block["decode_tok_s_per_request"]["mean"] == pytest.approx(100.0)


def test_warmup_requests_are_excluded() -> None:
    """Warmup never contributes to a published number."""
    results = [trace(request_id="w", warmup=True), trace(request_id="r")]
    block = aggregate_serving(results, concurrency=1, duration_s=1.0)
    assert block["requests_total"] == 1
    assert block["output_tokens_total"] == 11


def test_failures_lower_success_rate_and_are_grouped() -> None:
    """Failed requests are counted, categorized and sampled."""
    results = [
        trace(request_id="r0"),
        trace(request_id="r1", ok=False, category="oom"),
        trace(request_id="r2", ok=False, category="oom"),
        trace(request_id="r3", ok=False, category="timeout"),
    ]
    block = aggregate_serving(results, concurrency=1, duration_s=4.0)
    assert block["requests_ok"] == 1
    assert block["requests_failed"] == 3
    assert block["success_rate"] == 0.25

    failures = aggregate_failures(results)
    assert {f["category"]: f["count"] for f in failures} == {"oom": 2, "timeout": 1}
    assert all(f["at"] == "request" for f in failures)
    assert failures[0]["sample_request_id"] == "r1"


def test_single_token_requests_have_no_tpot() -> None:
    """TPOT needs at least two output tokens; prefill workloads report null."""
    results = [trace(completion_tokens=1)]
    block = aggregate_serving(results, concurrency=1, duration_s=1.0)
    assert block["tpot_ms"] is None
    assert block["decode_tok_s_per_request"] is None
    assert block["ttft_ms"] is not None


def test_empty_trace_is_not_a_crash() -> None:
    """A run where everything failed to even start still produces a block."""
    block = aggregate_serving([], concurrency=1)
    assert block["requests_total"] == 0
    assert block["output_tok_s"] is None
