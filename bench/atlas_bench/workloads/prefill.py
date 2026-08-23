"""Prefill workload: large input, one output token.

With ``output_tokens = 1`` the end-to-end latency *is* the prefill latency, so
``prefill_tok_s`` and the TTFT distribution are the whole point of this workload. Decode
metrics are reported as ``null`` because a single token cannot produce them.
"""

from __future__ import annotations

from ..metrics import aggregate_failures
from .base import RunContext, WorkloadOutcome, prompts_for, raw_payload
from .serving import measure_once

__all__ = ["run_prefill"]


async def run_prefill(ctx: RunContext) -> WorkloadOutcome:
    """Run the prefill workload."""
    concurrency = int(ctx.param("concurrency", 1))
    num_requests = int(ctx.param("num_requests", 8))
    input_tokens = int(ctx.param("input_tokens", 32768))
    output_tokens = int(ctx.param("output_tokens", 1))
    warmup_requests = int(ctx.param("warmup_requests", 0))

    block, results = await measure_once(
        ctx,
        concurrency=concurrency,
        num_requests=num_requests,
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        warmup_requests=warmup_requests,
        label="prefill",
    )
    prompts = prompts_for(ctx, 1, target_tokens=input_tokens)
    padded = any(p.padded for p in prompts)

    return WorkloadOutcome(
        kind="prefill",
        metrics=block,
        failures=aggregate_failures([r for r in results if not r.warmup]),
        resolved_params={
            "concurrency": concurrency,
            "num_requests": num_requests,
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "warmup_requests": warmup_requests,
            "prompts_padded": padded,
            "needle_check": ctx.params.get("needle_check"),
            "timeout_s": ctx.timeout_s,
            "seed": ctx.param("seed", ctx.spec.request.seed),
        },
        raw={"requests": raw_payload(results)},
        requests=results,
        warnings=list(ctx.warnings),
    )
