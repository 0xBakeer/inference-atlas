"""Wrap an engine-native benchmark output into an Atlas result file.

Supports ``vllm bench serve --save-result`` and SGLang's ``bench_serving.py --output-file``
JSON. Those harnesses measure the same things we do but name them differently; the mapping
below is the whole point of this module. Anything they do not report stays ``null`` — a
wrapped result is honest about being second-hand, and records
``raw.payload.source: "vllm-bench-serve"`` so it can be told apart from a native run.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .metrics import empty_metric_block

__all__ = ["detect_source", "load_native", "native_started_at", "wrap_metrics"]

#: Distribution names as they appear in engine-native output, mapped to SPEC names.
_DISTRIBUTIONS = {
    "ttft_ms": ("ttft",),
    "tpot_ms": ("tpot",),
    "itl_ms": ("itl",),
    "e2e_ms": ("e2el", "e2e_latency", "e2e"),
}
_STAT_KEYS = {
    "mean": "mean",
    "median": "p50",
    "p50": "p50",
    "p90": "p90",
    "p95": "p95",
    "p99": "p99",
    "min": "min",
    "max": "max",
}


def detect_source(raw: dict[str, Any]) -> str:
    """Identify which engine-native harness produced this JSON."""
    if "mean_e2e_latency_ms" in raw or raw.get("backend") in {"sglang", "sglang-oai"}:
        return "sglang-bench-serving"
    if "mean_e2el_ms" in raw or "total_token_throughput" in raw:
        return "vllm-bench-serve"
    return "unknown"


def _distribution(raw: dict[str, Any], names: tuple[str, ...]) -> dict[str, float] | None:
    """Collect ``mean_/median_/p99_<name>_ms`` keys into a SPEC distribution block."""
    block: dict[str, float] = {}
    for name in names:
        for prefix, target in _STAT_KEYS.items():
            value = raw.get(f"{prefix}_{name}_ms")
            if isinstance(value, (int, float)):
                block.setdefault(target, round(float(value), 3))
    return block or None


def wrap_metrics(raw: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any], str]:
    """Convert engine-native JSON into ``(metric_block, resolved_params, source)``."""
    source = detect_source(raw)
    block = empty_metric_block()

    completed = raw.get("completed")
    total = raw.get("num_prompts") or raw.get("num_requests") or completed
    if isinstance(total, int):
        block["requests_total"] = total
    if isinstance(completed, int):
        block["requests_ok"] = completed
        block["requests_failed"] = max((total or completed) - completed, 0)
        denominator = total or completed
        block["success_rate"] = round(completed / denominator, 6) if denominator else 0.0

    duration = raw.get("duration") or raw.get("benchmark_duration") or raw.get("duration_s")
    if isinstance(duration, (int, float)):
        block["duration_s"] = round(float(duration), 3)
    for source_key, target in (
        ("output_throughput", "output_tok_s"),
        ("total_token_throughput", "total_tok_s"),
        ("request_throughput", "req_s"),
    ):
        value = raw.get(source_key)
        if isinstance(value, (int, float)):
            block[target] = round(float(value), 3)
    if block["total_tok_s"] is None and block["duration_s"]:
        total_tokens = (raw.get("total_input_tokens") or 0) + (raw.get("total_output_tokens") or 0)
        if total_tokens:
            block["total_tok_s"] = round(total_tokens / block["duration_s"], 3)

    concurrency = raw.get("max_concurrency") or raw.get("concurrency") or 1
    ttft_mean_ms = raw.get("mean_ttft_ms")
    input_tokens = raw.get("total_input_tokens")
    if isinstance(ttft_mean_ms, (int, float)) and input_tokens and completed:
        prefill_window_s = (ttft_mean_ms / 1000.0) * completed / max(int(concurrency), 1)
        if prefill_window_s > 0:
            block["prefill_tok_s"] = round(input_tokens / prefill_window_s, 3)

    for target, names in _DISTRIBUTIONS.items():
        block[target] = _distribution(raw, names)

    resolved = {
        "concurrency": int(concurrency),
        "num_requests": total,
        "request_rate": raw.get("request_rate"),
        "input_tokens": raw.get("total_input_tokens"),
        "output_tokens": raw.get("total_output_tokens"),
        "source": source,
        "source_model": raw.get("model_id") or raw.get("model"),
        "source_backend": raw.get("backend"),
        "source_date": raw.get("date"),
    }
    return block, resolved, source


def native_started_at(raw: dict[str, Any]) -> str | None:
    """Normalize the native harness' ``date`` field to an ISO-8601 UTC timestamp."""
    value = str(raw.get("date") or "").strip()
    if not value:
        return None
    for pattern in ("%Y%m%d-%H%M%S", "%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S"):
        try:
            return (
                datetime.strptime(value, pattern).replace(tzinfo=UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
            )
        except ValueError:
            continue
    return None


def load_native(path: Path | str) -> dict[str, Any]:
    """Read an engine-native benchmark JSON file."""
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    if isinstance(data, list) and data:
        data = data[-1]
    if not isinstance(data, dict):
        raise ValueError("engine-native benchmark output must be a JSON object")
    return data
