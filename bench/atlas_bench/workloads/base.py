"""Shared plumbing for workload runners.

A runner receives a :class:`RunContext` (packet, registry, client, resolved workload
parameters) and returns a :class:`WorkloadOutcome` that the result builder turns into a
SPEC §4 record. Everything a runner does that could surprise a reader — padding prompts,
falling back to a synthetic dataset, aborting a sweep — is recorded as a warning or a
gotcha rather than hidden.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Callable, Iterator, Sequence
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Any

from ..client import ChatClient, RequestResult
from ..data import (
    PromptRow,
    filter_prompt_rows,
    load_haystack_rows,
    load_prompt_rows,
    sample_prompts,
)
from ..registry import Registry
from ..spec import TaskSpec
from ..telemetry import TelemetrySampler

__all__ = [
    "RunContext",
    "WorkloadOutcome",
    "detect_warmup_outlier",
    "execute_requests",
    "gotcha",
    "prompts_for",
    "raw_payload",
    "sampling",
]


@dataclass
class RunContext:
    """Everything a workload runner needs for one workload of one packet."""

    spec: TaskSpec
    registry: Registry
    client: ChatClient
    workload: dict[str, Any]
    params: dict[str, Any]
    telemetry_factory: Callable[[], TelemetrySampler | None] | None = None
    warnings: list[str] = field(default_factory=list)
    dry_run: bool = False

    def new_sampler(self) -> TelemetrySampler | None:
        """A fresh telemetry sampler for one measured window (``None`` when disabled)."""
        return self.telemetry_factory() if self.telemetry_factory else None

    @property
    def workload_id(self) -> str:
        """Id of the workload being run."""
        return str(self.workload.get("id"))

    @property
    def kind(self) -> str:
        """Workload kind (``serving`` | ``sweep`` | ``prefill`` | ``longctx`` | ``eval``)."""
        return str(self.workload.get("kind") or "serving")

    def param(self, name: str, default: Any = None) -> Any:
        """Resolved workload parameter."""
        value = self.params.get(name)
        return default if value is None else value

    @property
    def timeout_s(self) -> float:
        """Per-request timeout: the workload's ``params.timeout_s`` wins over the packet."""
        value = self.params.get("timeout_s")
        return float(value) if isinstance(value, (int, float)) else self.spec.request.timeout_s

    def extra_body(self) -> dict[str, Any]:
        """Request-level extras from the packet (``chat_template_kwargs`` etc.)."""
        request = self.spec.request
        extra: dict[str, Any] = dict(request.extra_body or {})
        if request.chat_template_kwargs:
            extra["chat_template_kwargs"] = request.chat_template_kwargs
        if request.reasoning_effort:
            extra["reasoning_effort"] = request.reasoning_effort
        # `params.reasoning: "default"` means "leave the engine's own default alone"
        # (workloads/README.md); anything else is an explicit effort level.
        reasoning = self.params.get("reasoning")
        if reasoning and str(reasoning).lower() != "default":
            extra["reasoning_effort"] = reasoning
        return extra


@dataclass
class WorkloadOutcome:
    """The measured output of one workload."""

    kind: str
    metrics: dict[str, Any] | None = None
    sweep: list[dict[str, Any]] | None = None
    scores: dict[str, Any] | None = None
    failures: list[dict[str, Any]] = field(default_factory=list)
    resolved_params: dict[str, Any] = field(default_factory=dict)
    raw: dict[str, Any] = field(default_factory=dict)
    gotchas: list[dict[str, Any]] = field(default_factory=list)
    requests: list[RequestResult] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


def gotcha(severity: str, text: str) -> dict[str, str]:
    """Build a SPEC ``gotchas[]`` entry."""
    return {"severity": severity, "text": text}


def prompts_for(
    ctx: RunContext, count: int, *, target_tokens: int | None = None
) -> list[PromptRow]:
    """Deterministically pick ``count`` prompts for this workload.

    Honours the workload's ``dataset_buckets`` filter, and understands both dataset kinds a
    performance workload can point at: a ``prompts`` dataset (sampled by length) and a
    ``haystack`` dataset (materialized recipes at the requested size — this is how the
    prefill workloads get a real 128k-token document instead of filler).

    Falls back to synthetic filler only when the dataset is absent, recording a
    ``dataset-missing`` warning so a run is never silently synthetic.
    """
    dataset_id = str(ctx.workload.get("dataset_id") or "")
    meta = ctx.registry.dataset(dataset_id) or {}
    seed = int(ctx.param("seed", ctx.spec.request.seed or 42))

    if str(meta.get("kind") or "") == "haystack":
        rows = load_haystack_rows(ctx.registry, dataset_id)
        if rows:
            depth = ctx.params.get("needle_depth")
            picked = _haystack_prompts(rows, count, target_tokens, depth)
            if picked:
                return picked

    rows = load_prompt_rows(ctx.registry, dataset_id) if dataset_id else []
    if not rows:
        ctx.warnings.append(f"dataset-missing:{dataset_id or '<none>'}")
    rows = filter_prompt_rows(rows, ctx.params.get("dataset_buckets"))
    return sample_prompts(rows, count, seed=seed, target_tokens=target_tokens)


def _haystack_prompts(
    rows: list[Any], count: int, target_tokens: int | None, depth: Any
) -> list[PromptRow]:
    """Pick materialized haystack documents at (or nearest to) the requested size."""
    pool = list(rows)
    if depth is not None:
        wanted = float(depth) * 100 if float(depth) <= 1 else float(depth)
        at_depth = [row for row in pool if abs(row.depth_pct - wanted) < 1e-6]
        pool = at_depth or pool
    if target_tokens:
        exact = [row for row in pool if row.input_tokens == target_tokens]
        pool = exact or sorted(pool, key=lambda r: abs(r.input_tokens - target_tokens))[:1]
    if not pool:
        return []
    return [pool[i % len(pool)].prompt for i in range(count)]


async def execute_requests(
    ctx: RunContext,
    prompts: Sequence[PromptRow],
    *,
    concurrency: int,
    max_tokens: int | None,
    warmup_requests: int = 0,
    warmup_mask: Sequence[bool] | None = None,
    label: str = "req",
) -> tuple[list[RequestResult], float]:
    """Run prompts at a fixed concurrency and return ``(results, duration_s)``.

    Warmup requests run first at the same concurrency and are tagged ``warmup=True`` so the
    aggregation ignores them (they still show up in the raw payload). ``warmup_mask`` is the
    grouped variant: the warmup requests sit *inside* the sequence (one per prefix group)
    and must not be reordered, so they are marked in place instead.
    """
    request = ctx.spec.request
    semaphore = asyncio.Semaphore(max(1, concurrency))

    async def one(index: int, row: PromptRow, warmup: bool) -> RequestResult:
        async with semaphore:
            return await ctx.client.chat_stream(
                row.chat_messages(),
                request_id=f"{label}-{'w' if warmup else 'r'}{index:05d}",
                prompt_id=row.id,
                max_tokens=max_tokens,
                temperature=float(ctx.param("temperature", request.temperature)),
                top_p=request.top_p,
                seed=request.seed,
                stop=request.stop,
                extra_body=ctx.extra_body(),
                warmup=warmup,
                timeout_s=ctx.timeout_s,
            )

    if warmup_mask is not None:
        started = time.perf_counter()
        results = list(
            await asyncio.gather(
                *(one(i, row, bool(warmup_mask[i])) for i, row in enumerate(prompts))
            )
        )
        duration = time.perf_counter() - started
        await backfill_prompt_tokens(ctx, prompts, results)
        return results, duration

    warmup_results: list[RequestResult] = []
    if warmup_requests > 0:
        warm_prompts = [prompts[i % len(prompts)] for i in range(warmup_requests)]
        warmup_results = list(
            await asyncio.gather(*(one(i, row, True) for i, row in enumerate(warm_prompts)))
        )

    started = time.perf_counter()
    measured = list(await asyncio.gather(*(one(i, row, False) for i, row in enumerate(prompts))))
    duration = time.perf_counter() - started
    await backfill_prompt_tokens(ctx, prompts, measured)
    return [*warmup_results, *measured], duration


async def backfill_prompt_tokens(
    ctx: RunContext, prompts: Sequence[PromptRow], results: Sequence[RequestResult]
) -> None:
    """Fill ``prompt_tokens`` for engines that report no ``usage``.

    Runs *after* the measured window so the extra ``/tokenize`` calls cannot influence the
    timings. One call per distinct prompt; the first failure aborts the backfill and records
    a warning rather than paying a round trip per request for nothing.
    """
    missing = [r for r in results if r.ok and r.prompt_tokens is None]
    if not missing:
        return
    by_id = {p.id: p for p in prompts}
    counts: dict[str, int] = {}
    for result in missing:
        row = by_id.get(result.prompt_id or "")
        if row is None:
            continue
        if row.id not in counts:
            count = await ctx.client.count_prompt_tokens(row.chat_messages())
            if count is None:
                ctx.warnings.append(
                    "prompt-tokens-unavailable: the engine reports no usage and has no "
                    "/tokenize endpoint; pass --tokenizer to count prompt tokens locally"
                )
                return
            counts[row.id] = count
        result.prompt_tokens = counts[row.id]


def detect_warmup_outlier(results: Sequence[RequestResult]) -> dict[str, str] | None:
    """Flag a first request that is much slower than the rest (cold engine)."""
    ok = [r for r in results if r.ok and not r.warmup and r.decode_tok_s]
    if len(ok) < 4:
        return None
    first = ok[0].decode_tok_s or 0.0
    rest = sorted(r.decode_tok_s or 0.0 for r in ok[1:])
    median = rest[len(rest) // 2]
    if median > 0 and first < median * 0.6:
        return gotcha(
            "info",
            f"First measured request decoded at {first:.1f} tok/s vs a median of "
            f"{median:.1f} tok/s — the engine was still warming up; use warmup_requests.",
        )
    return None


def raw_payload(results: Sequence[RequestResult], limit: int = 400) -> list[dict[str, Any]]:
    """Per-request trace kept in ``result.raw.payload`` (bounded by the caller)."""
    rows: list[dict[str, Any]] = []
    for r in results[:limit]:
        rows.append(
            {
                "id": r.request_id,
                "prompt_id": r.prompt_id,
                "warmup": r.warmup,
                "status": r.status,
                "ttft_ms": round(r.ttft_s * 1000, 3) if r.ttft_s is not None else None,
                "e2e_ms": round(r.e2e_s * 1000, 3) if r.e2e_s is not None else None,
                "prompt_tokens": r.prompt_tokens,
                "completion_tokens": r.completion_tokens,
                "token_source": r.token_source,
                "finish_reason": r.finish_reason,
                "error_category": r.error_category,
            }
        )
    return rows


@contextmanager
def sampling(ctx: RunContext) -> Iterator[dict[str, Any]]:
    """Sample telemetry for the duration of a measured window.

    The yielded dict is filled with the SPEC power/memory/thermal fields when the block
    exits, so a caller can ``block.update(summary)`` afterwards.
    """
    summary: dict[str, Any] = {}
    sampler = ctx.new_sampler()
    if sampler is not None:
        sampler.start()
    try:
        yield summary
    finally:
        if sampler is not None:
            summary.update(sampler.stop())
