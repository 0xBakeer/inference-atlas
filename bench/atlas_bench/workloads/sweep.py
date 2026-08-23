"""Sweep workload: repeat the serving measurement across a parameter axis.

Axis comes from ``workload.sweep`` — ``{"concurrency": [1,2,4,8,16,32]}`` or
``{"input_tokens": [1024, 8192, 32768]}``. Escalation stops as soon as a level's
``success_rate`` drops below ``sweep.success_threshold`` (default 0.95); the failing level
is still recorded, together with a ``blocker`` gotcha, because "it fell over at 32" is
exactly the information the atlas is missing everywhere else.
"""

from __future__ import annotations

from typing import Any

from ..metrics import aggregate_failures
from .base import RunContext, WorkloadOutcome, gotcha, raw_payload
from .serving import measure_once

__all__ = ["run_sweep", "sweep_axis"]

#: Default axis when a sweep workload does not declare one.
DEFAULT_AXIS = ("concurrency", [1, 2, 4, 8, 16, 32])


def sweep_axis(workload: dict[str, Any]) -> tuple[str, list[Any]]:
    """Return ``(axis_name, levels)`` for a sweep workload."""
    sweep = workload.get("sweep") or {}
    for name in ("concurrency", "input_tokens", "output_tokens", "num_requests"):
        if isinstance(sweep.get(name), list) and sweep[name]:
            return name, list(sweep[name])
    return DEFAULT_AXIS[0], list(DEFAULT_AXIS[1])


async def run_sweep(ctx: RunContext) -> WorkloadOutcome:
    """Run one serving measurement per sweep level."""
    axis, levels = sweep_axis(ctx.workload)
    threshold = float((ctx.workload.get("sweep") or {}).get("success_threshold", 0.95))
    num_requests = int(ctx.param("num_requests", 32))
    warmup_requests = int(ctx.param("warmup_requests", 0))
    base_concurrency = int(ctx.param("concurrency", 1))
    base_input = ctx.param("input_tokens")
    output_tokens = ctx.param("output_tokens", 256)

    entries: list[dict[str, Any]] = []
    all_results: list[Any] = []
    gotchas: list[dict[str, Any]] = []
    stopped_at: Any = None

    per_concurrency = ctx.params.get("requests_per_concurrency")
    for index, level in enumerate(levels):
        concurrency = int(level) if axis == "concurrency" else base_concurrency
        input_tokens = int(level) if axis == "input_tokens" else base_input
        requests = int(level) if axis == "num_requests" else num_requests
        outputs = int(level) if axis == "output_tokens" else output_tokens
        if axis == "concurrency" and per_concurrency:
            # Every stream must serve a few requests of its own, or a low-concurrency point
            # degenerates into a warmup measurement (workloads/README.md).
            requests = max(requests, concurrency * int(per_concurrency))
        block, results = await measure_once(
            ctx,
            concurrency=concurrency,
            num_requests=requests,
            input_tokens=int(input_tokens) if input_tokens else None,
            output_tokens=int(outputs) if outputs else None,
            warmup_requests=warmup_requests if index == 0 else 0,
            label=f"{axis}{level}",
        )
        all_results.extend(results)
        entries.append({axis: level, "num_requests": requests, "metrics": block})
        if block.get("success_rate", 0.0) < threshold:
            stopped_at = level
            categories = sorted({r.error_category or "other" for r in results if not r.ok})
            gotchas.append(
                gotcha(
                    "blocker",
                    f"Sweep stopped at {axis}={level}: success_rate "
                    f"{block.get('success_rate')} < {threshold} "
                    f"({', '.join(categories) or 'no category'}).",
                )
            )
            break

    best = max(
        (e for e in entries if (e["metrics"].get("success_rate") or 0) >= threshold),
        key=lambda e: e["metrics"].get("output_tok_s") or 0.0,
        default=entries[-1] if entries else None,
    )

    return WorkloadOutcome(
        kind="sweep",
        metrics=best["metrics"] if best else None,
        sweep=entries,
        failures=aggregate_failures([r for r in all_results if not r.warmup]),
        resolved_params={
            "axis": axis,
            "levels": levels,
            "levels_run": [e[axis] for e in entries],
            "success_threshold": threshold,
            "num_requests": num_requests,
            "requests_per_concurrency": per_concurrency,
            "requests_per_level": [e.get("num_requests") for e in entries],
            "dataset_buckets": ctx.params.get("dataset_buckets"),
            "timeout_s": ctx.timeout_s,
            "input_tokens": base_input,
            "output_tokens": output_tokens,
            "warmup_requests": warmup_requests,
            "stopped_at": stopped_at,
            "seed": ctx.param("seed", ctx.spec.request.seed),
        },
        raw={"requests": raw_payload(all_results)},
        gotchas=gotchas,
        requests=all_results,
        warnings=list(ctx.warnings),
    )
