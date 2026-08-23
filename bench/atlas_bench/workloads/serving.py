"""Serving workload: fixed concurrency, fixed input/output lengths.

Parameters (from ``workloads/<id>.json``): ``concurrency``, ``num_requests``,
``input_tokens``, ``output_tokens``, ``seed``, ``warmup_requests``, ``temperature``,
``repeat``.

``repeat > 1`` runs the whole measurement that many times and reports the **median**
iteration by ``output_tok_s``; every iteration's metric block is kept in the raw payload,
because reporting a mean over a cold first iteration is how bad benchmark numbers happen.
"""

from __future__ import annotations

from typing import Any

from ..data import PromptRow, filter_prompt_rows, load_prompt_rows
from ..metrics import aggregate_failures, aggregate_serving
from .base import (
    RunContext,
    WorkloadOutcome,
    detect_warmup_outlier,
    execute_requests,
    prompts_for,
    raw_payload,
    sampling,
)

__all__ = ["grouped_prompts", "measure_once", "run_serving"]


def grouped_prompts(ctx: RunContext, count: int) -> tuple[list[PromptRow], list[bool]] | None:
    """Order the prompts by group for a shared-prefix workload.

    ``serve-prefix-c16-v1`` measures what prefix caching is worth, which only works if all
    rows of one ``prefix_id`` are sent back to back and the list is *not* shuffled. The
    first ``warmup_per_group`` requests of each group pay the cold prefill and are excluded
    from the aggregate, so the reported TTFT is the warm one.

    Returns ``None`` when the workload does not ask for grouping.
    """
    group_by = ctx.params.get("group_by")
    if not group_by:
        return None
    dataset_id = str(ctx.workload.get("dataset_id") or "")
    rows = filter_prompt_rows(
        load_prompt_rows(ctx.registry, dataset_id), ctx.params.get("dataset_buckets")
    )
    if not rows:
        ctx.warnings.append(f"dataset-missing:{dataset_id or '<none>'}")
        return None

    order: list[str] = []
    groups: dict[str, list[PromptRow]] = {}
    for row in rows:
        key = str(getattr(row, str(group_by), None) or "")
        if key not in groups:
            groups[key] = []
            order.append(key)
        groups[key].append(row)
    if ctx.params.get("shuffle"):
        import random

        random.Random(int(ctx.param("seed", 42))).shuffle(order)

    per_group_warmup = int(ctx.params.get("warmup_per_group") or 0)
    prompts: list[PromptRow] = []
    warmup: list[bool] = []
    while len(prompts) < count:
        for key in order:
            for index, row in enumerate(groups[key]):
                if len(prompts) >= count:
                    break
                prompts.append(row)
                warmup.append(index < per_group_warmup)
            if len(prompts) >= count:
                break
    return prompts, warmup


async def measure_once(
    ctx: RunContext,
    *,
    concurrency: int,
    num_requests: int,
    input_tokens: int | None,
    output_tokens: int | None,
    warmup_requests: int,
    label: str,
) -> tuple[dict[str, Any], list[Any]]:
    """Run one measurement window and return ``(metric_block, request_results)``."""
    grouped = grouped_prompts(ctx, num_requests)
    if grouped is not None:
        prompts, mask = grouped
        with sampling(ctx) as telemetry:
            results, _ = await execute_requests(
                ctx,
                prompts,
                concurrency=concurrency,
                max_tokens=output_tokens,
                warmup_mask=mask,
                label=label,
            )
        # The per-group warmups are interleaved, so the measured window is the span of the
        # non-warmup requests rather than the whole gather.
        duration = None
    else:
        prompts = prompts_for(ctx, num_requests, target_tokens=input_tokens)
        with sampling(ctx) as telemetry:
            results, duration = await execute_requests(
                ctx,
                prompts,
                concurrency=concurrency,
                max_tokens=output_tokens,
                warmup_requests=warmup_requests,
                label=label,
            )
    block = aggregate_serving(results, concurrency=concurrency, duration_s=duration)
    block.update(telemetry)
    return block, results


async def run_serving(ctx: RunContext) -> WorkloadOutcome:
    """Run the serving workload and build its outcome."""
    concurrency = int(ctx.param("concurrency", 1))
    num_requests = int(ctx.param("num_requests", 32))
    input_tokens = ctx.param("input_tokens")
    output_tokens = ctx.param("output_tokens", 256)
    warmup_requests = int(ctx.param("warmup_requests", 0))
    repeat = max(1, int(ctx.param("repeat", 1)))

    iterations: list[dict[str, Any]] = []
    all_results: list[Any] = []
    for index in range(repeat):
        block, results = await measure_once(
            ctx,
            concurrency=concurrency,
            num_requests=num_requests,
            input_tokens=int(input_tokens) if input_tokens else None,
            output_tokens=int(output_tokens) if output_tokens else None,
            warmup_requests=warmup_requests if index == 0 else 0,
            label=f"i{index}",
        )
        iterations.append(block)
        all_results.extend(results)

    chosen = _median_iteration(iterations)
    gotchas = []
    outlier = detect_warmup_outlier(all_results)
    if outlier:
        gotchas.append(outlier)

    return WorkloadOutcome(
        kind="serving",
        metrics=chosen,
        failures=aggregate_failures([r for r in all_results if not r.warmup]),
        resolved_params={
            "concurrency": concurrency,
            "num_requests": num_requests,
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "warmup_requests": warmup_requests,
            "repeat": repeat,
            "seed": ctx.param("seed", ctx.spec.request.seed),
            "temperature": ctx.param("temperature", ctx.spec.request.temperature),
            "timeout_s": ctx.timeout_s,
            "dataset_buckets": ctx.params.get("dataset_buckets"),
            "group_by": ctx.params.get("group_by"),
            "warmup_per_group": ctx.params.get("warmup_per_group"),
            "shuffle": ctx.params.get("shuffle"),
        },
        raw={
            "iterations": iterations,
            "selected_iteration": iterations.index(chosen) if iterations else None,
            "requests": raw_payload(all_results),
        },
        gotchas=gotchas,
        requests=all_results,
        warnings=list(ctx.warnings),
    )


def _median_iteration(iterations: list[dict[str, Any]]) -> dict[str, Any]:
    """Pick the median iteration by ``output_tok_s`` (the lower one on a tie)."""
    if not iterations:
        return {}
    ordered = sorted(iterations, key=lambda block: block.get("output_tok_s") or 0.0)
    return ordered[(len(ordered) - 1) // 2]
