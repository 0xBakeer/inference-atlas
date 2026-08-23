"""Metric aggregation from raw request traces (SPEC §4 ``metrics`` block).

Definitions used throughout (documented here because a benchmark number without its
formula is worthless):

``duration_s``
    Wall clock from the first non-warmup request start to the last request end.
``output_tok_s``
    ``Σ completion_tokens(ok) / duration_s`` — system-level output throughput.
``total_tok_s``
    ``Σ (prompt_tokens + completion_tokens)(ok) / duration_s``.
``req_s``
    ``requests_ok / duration_s``.
``prefill_tok_s``
    ``Σ input_tokens / (Σ ttft_s / concurrency)``. The sum of TTFTs counts each of the
    ``concurrency`` in-flight requests separately, so dividing it by the concurrency turns
    it back into the wall-clock time the prefills actually occupied. At concurrency 1 this
    is exactly ``Σ input_tokens / Σ ttft_s``.
``tpot_ms``
    Per request ``(e2e - ttft) / (completion_tokens - 1)``; requests with fewer than two
    output tokens are excluded.
``itl_ms``
    Gaps between consecutive streamed content deltas, pooled over all requests.
``decode_tok_s_per_request``
    Per request ``(completion_tokens - 1) / (e2e - ttft)`` — what a single user sees.

Percentiles use linear interpolation between the two nearest ranks (the ``numpy.percentile``
default), so p50 of ``[1, 2]`` is ``1.5``.
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Iterable, Sequence
from typing import Any

from .client import RequestResult

__all__ = [
    "aggregate_failures",
    "aggregate_serving",
    "distribution",
    "empty_metric_block",
    "percentile",
]

_DEFAULT_QUANTILES = ("p50", "p90", "p95", "p99")


def percentile(values: Sequence[float], q: float) -> float:
    """Linear-interpolation percentile (``q`` in ``[0, 100]``) of a non-empty sequence."""
    ordered = sorted(values)
    if not ordered:
        raise ValueError("percentile of an empty sequence")
    if len(ordered) == 1:
        return float(ordered[0])
    position = (len(ordered) - 1) * (q / 100.0)
    low = int(position)
    high = min(low + 1, len(ordered) - 1)
    weight = position - low
    return float(ordered[low] * (1 - weight) + ordered[high] * weight)


def _round(value: float | None, digits: int = 3) -> float | None:
    """Round for JSON output; ``None`` passes through."""
    return None if value is None else round(float(value), digits)


def distribution(values: Iterable[float], digits: int = 3) -> dict[str, float] | None:
    """``{mean, p50, p90, p95, p99, min, max}`` or ``None`` when there is no data."""
    data = [float(v) for v in values if v is not None]
    if not data:
        return None
    block: dict[str, float] = {"mean": _round(sum(data) / len(data), digits)}
    for name in _DEFAULT_QUANTILES:
        block[name] = _round(percentile(data, float(name[1:])), digits)
    block["min"] = _round(min(data), digits)
    block["max"] = _round(max(data), digits)
    return block


def empty_metric_block() -> dict[str, Any]:
    """A metric block with every SPEC key present and null/zero valued."""
    return {
        "requests_total": 0,
        "requests_ok": 0,
        "requests_failed": 0,
        "success_rate": 0.0,
        "duration_s": 0.0,
        "input_tokens_total": None,
        "output_tokens_total": None,
        "output_tok_s": None,
        "total_tok_s": None,
        "req_s": None,
        "prefill_tok_s": None,
        "ttft_ms": None,
        "tpot_ms": None,
        "itl_ms": None,
        "e2e_ms": None,
        "decode_tok_s_per_request": None,
        "vram_peak_gb": None,
        "ram_peak_gb": None,
        "kv_cache_tokens": None,
        "power_avg_w": None,
        "power_peak_w": None,
        "energy_wh": None,
        "gpu_util_avg_pct": None,
        "temp_max_c": None,
        "thermal_throttle_detected": None,
    }


def aggregate_serving(
    results: Sequence[RequestResult],
    *,
    concurrency: int = 1,
    duration_s: float | None = None,
) -> dict[str, Any]:
    """Build a SPEC metric block from request traces (warmup requests are ignored)."""
    trace = [r for r in results if not r.warmup]
    block = empty_metric_block()
    block["requests_total"] = len(trace)
    if not trace:
        return block

    ok = [r for r in trace if r.ok]
    block["requests_ok"] = len(ok)
    block["requests_failed"] = len(trace) - len(ok)
    block["success_rate"] = round(len(ok) / len(trace), 6)

    if duration_s is None:
        starts = [r.started for r in trace]
        ends = [r.finished for r in trace if r.finished is not None]
        duration_s = (max(ends) - min(starts)) if ends else 0.0
    block["duration_s"] = _round(duration_s)

    completion_tokens = sum(r.completion_tokens or 0 for r in ok)
    prompt_tokens = sum(r.prompt_tokens or 0 for r in ok)
    block["output_tokens_total"] = completion_tokens
    block["input_tokens_total"] = prompt_tokens
    if duration_s and duration_s > 0:
        block["output_tok_s"] = _round(completion_tokens / duration_s)
        block["total_tok_s"] = _round((completion_tokens + prompt_tokens) / duration_s)
        block["req_s"] = _round(len(ok) / duration_s)

    ttfts = [r.ttft_s for r in ok if r.ttft_s is not None]
    if ttfts and prompt_tokens:
        prefill_window_s = sum(ttfts) / max(concurrency, 1)
        if prefill_window_s > 0:
            block["prefill_tok_s"] = _round(prompt_tokens / prefill_window_s)

    block["ttft_ms"] = distribution([t * 1000 for t in ttfts])
    block["tpot_ms"] = distribution([r.tpot_s * 1000 for r in ok if r.tpot_s is not None])
    itls: list[float] = []
    for r in ok:
        itls.extend(gap * 1000 for gap in r.itls_s)
    block["itl_ms"] = distribution(itls)
    block["e2e_ms"] = distribution([r.e2e_s * 1000 for r in ok if r.e2e_s is not None])
    block["decode_tok_s_per_request"] = distribution(
        [r.decode_tok_s for r in ok if r.decode_tok_s is not None]
    )
    return block


def aggregate_failures(results: Sequence[RequestResult]) -> list[dict[str, Any]]:
    """Group failed requests into the SPEC ``failures[]`` shape."""
    failed = [r for r in results if not r.ok]
    if not failed:
        return []
    counts: Counter[str] = Counter(r.error_category or "other" for r in failed)
    out: list[dict[str, Any]] = []
    for category, count in sorted(counts.items()):
        sample = next(r for r in failed if (r.error_category or "other") == category)
        out.append(
            {
                "at": "request",
                "count": count,
                "category": category,
                "message": (sample.error_message or "")[:500],
                "sample_request_id": sample.request_id,
            }
        )
    return out
