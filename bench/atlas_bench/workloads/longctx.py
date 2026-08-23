"""Long-context workload: throughput as the prompt grows, with a retrieval check.

Two dataset shapes feed this runner:

* a ``haystack`` dataset (``haystack-v1``) — recipes materialized through the dataset's own
  ``build.py``, one point per (``target_tokens``, depth). ``params.needle_depth`` picks the
  depth, ``sweep.input_tokens`` picks the sizes.
* an ``eval`` dataset (``eval-longctx-v1``) — rows whose ``meta.haystack`` is a recipe and
  whose ``prompt`` is the **question only**; the document is rebuilt and prepended.
  ``dataset_categories`` and ``dataset_target_tokens`` filter them.

With ``params.needle_check`` a wrong needle answer is a **failed request**: it lowers
``success_rate`` and adds a ``failures[]`` entry with category ``malformed-output``
(workloads/README.md). The timing numbers of that request are still reported — the request
completed, it just came back wrong — so a point never loses its throughput measurement.

A point whose input exceeds the served context length fails with ``context-overflow`` and is
recorded, never omitted: "did not fit" is a result.

The headline ``metrics`` block is the **longest fully successful context**; the full table
lives in ``sweep``.
"""

from __future__ import annotations

from typing import Any

from ..data import (
    PromptRow,
    build_haystack,
    filter_eval_rows,
    load_eval_rows,
    load_haystack_rows,
    render_haystack_prompt,
)
from ..metrics import aggregate_failures, aggregate_serving
from ..scorers import get_scorer
from .base import RunContext, WorkloadOutcome, execute_requests, gotcha, raw_payload, sampling

__all__ = ["DEFAULT_DEPTHS", "DEFAULT_LENGTHS", "longctx_points", "run_longctx"]

#: Fallback grid when neither a dataset nor a sweep axis is available.
DEFAULT_LENGTHS = (1024, 8192, 32768)
DEFAULT_DEPTHS = (10.0, 50.0, 90.0)


def _depth_pct(value: Any, default: float | None = None) -> float | None:
    """Accept a depth as a fraction (``0.9``) or a percentage (``90``)."""
    if value is None:
        return default
    try:
        depth = float(value)
    except (TypeError, ValueError):
        return default
    return depth * 100.0 if depth <= 1.0 else depth


def _point(
    row_id: str, tokens: int, depth: float | None, prompt: PromptRow, answer: Any, scorer: str
) -> dict[str, Any]:
    """One measured long-context point."""
    return {
        "id": row_id,
        "input_tokens": tokens,
        "depth_pct": depth,
        "prompt": prompt,
        "answer": answer,
        "scorer": scorer,
    }


def longctx_points(ctx: RunContext) -> list[dict[str, Any]]:
    """Build the (context length, depth, prompt) grid for this workload."""
    dataset_id = str(ctx.workload.get("dataset_id") or "")
    meta = ctx.registry.dataset(dataset_id) or {}
    kind = str(meta.get("kind") or "")
    sweep = ctx.workload.get("sweep") or {}
    default_scorer = str((ctx.workload.get("eval") or {}).get("scorer") or "needle")

    if kind == "haystack":
        wanted = {int(v) for v in (sweep.get("input_tokens") or ())}
        depth = _depth_pct(ctx.params.get("needle_depth"))
        points = [
            _point(row.id, row.input_tokens, row.depth_pct, row.prompt, row.answer, "needle")
            for row in load_haystack_rows(ctx.registry, dataset_id)
            if (not wanted or row.input_tokens in wanted)
            and (depth is None or abs(row.depth_pct - depth) < 1e-6)
        ]
        if points:
            return points

    if kind == "eval":
        rows = filter_eval_rows(
            load_eval_rows(ctx.registry, dataset_id),
            ctx.params.get("dataset_categories"),
            ctx.params.get("dataset_target_tokens") or sweep.get("input_tokens"),
        )
        limit = ctx.param("num_requests")
        points = []
        for row in rows[: int(limit)] if limit else rows:
            messages, warnings = render_haystack_prompt(row, ctx.registry)
            ctx.warnings.extend(warnings)
            tokens = row.target_tokens or 0
            points.append(
                _point(
                    row.id,
                    tokens,
                    _depth_pct(row.meta.get("depth")),
                    PromptRow(id=row.id, messages=messages, approx_tokens=tokens),
                    row.answer,
                    row.scorer or default_scorer,
                )
            )
        if points:
            return sorted(points, key=lambda p: (p["input_tokens"], p["id"]))

    ctx.warnings.append(f"dataset-missing:{dataset_id or '<none>'}")
    raw_lengths = sweep.get("input_tokens") or ctx.param("input_tokens_list") or DEFAULT_LENGTHS
    depths = [
        _depth_pct(v, 50.0)
        for v in (
            sweep.get("depth")
            or ([ctx.params["needle_depth"]] if ctx.params.get("needle_depth") else None)
            or DEFAULT_DEPTHS
        )
    ]
    seed = int(ctx.param("seed", ctx.spec.request.seed or 42))
    points = []
    for length in (int(v) for v in raw_lengths):
        for depth in depths:
            messages, answer = build_haystack(
                input_tokens=length, depth_pct=depth or 50.0, seed=seed
            )
            points.append(
                _point(
                    f"needle-{length}-{int(depth or 50)}",
                    length,
                    depth,
                    PromptRow(
                        id=f"needle-{length}-{int(depth or 50)}",
                        messages=messages,
                        approx_tokens=length,
                    ),
                    answer,
                    "needle",
                )
            )
    return points


class _ScoreRow:
    """The minimal row shape the needle/contains scorers read."""

    def __init__(self, answer: Any) -> None:
        self.answer = answer
        self.meta: dict[str, Any] = {}


def _apply_needle_failures(block: dict[str, Any], missed: int) -> None:
    """Count needle misses as failed requests without discarding their timings.

    ``requests_ok + requests_failed == requests_total`` still holds; the throughput and
    latency numbers keep describing the requests that actually completed, which is what the
    point is measuring.
    """
    if not missed:
        return
    total = block.get("requests_total") or 0
    ok = max((block.get("requests_ok") or 0) - missed, 0)
    block["requests_ok"] = ok
    block["requests_failed"] = max(total - ok, 0)
    block["success_rate"] = round(ok / total, 6) if total else 0.0


async def run_longctx(ctx: RunContext) -> WorkloadOutcome:
    """Run every long-context point and score the needle at each."""
    output_tokens = int(
        ctx.param("output_tokens", (ctx.workload.get("eval") or {}).get("max_output_tokens") or 128)
    )
    needle_check = ctx.params.get("needle_check", True) is not False
    entries: list[dict[str, Any]] = []
    points_detail: list[dict[str, Any]] = []
    all_results: list[Any] = []
    gotchas: list[dict[str, Any]] = []
    missed_total = 0
    missed_sample: str | None = None

    for point in longctx_points(ctx):
        with sampling(ctx) as telemetry:
            results, duration = await execute_requests(
                ctx,
                [point["prompt"]],
                concurrency=1,
                max_tokens=output_tokens,
                label=f"ctx{point['input_tokens']}",
            )
        block = aggregate_serving(results, concurrency=1, duration_s=duration)
        block.update(telemetry)
        all_results.extend(results)

        found: bool | None = None
        if point["answer"] and results and results[0].ok:
            scorer = get_scorer(point["scorer"])
            found = scorer(results[0].text, _ScoreRow(point["answer"])).correct
            if needle_check and not found:
                missed_total += 1
                missed_sample = missed_sample or results[0].request_id
                _apply_needle_failures(block, 1)
                gotchas.append(
                    gotcha(
                        "warn",
                        f"Needle missed at {point['input_tokens']} tokens"
                        + (f", {point['depth_pct']:.0f}% depth" if point["depth_pct"] else "")
                        + " — counted as a failed request.",
                    )
                )

        needle = "n/a" if found is None else ("found" if found else "missed")
        depth_label = f"depth {point['depth_pct']:g}% · " if point["depth_pct"] else ""
        entries.append(
            {
                "input_tokens": point["input_tokens"],
                "output_tokens": output_tokens,
                "label": f"{depth_label}needle {needle}",
                "metrics": block,
            }
        )
        points_detail.append(
            {
                "id": point["id"],
                "input_tokens": point["input_tokens"],
                "depth_pct": point["depth_pct"],
                "needle_correct": found,
                "output_tok_s": block.get("output_tok_s"),
                "decode_tok_s": (block.get("decode_tok_s_per_request") or {}).get("mean"),
                "ttft_ms": (block.get("ttft_ms") or {}).get("p50"),
                "success_rate": block.get("success_rate"),
            }
        )

    successful = [e for e in entries if (e["metrics"].get("success_rate") or 0) >= 1.0]
    headline = max(successful, key=lambda e: e["input_tokens"], default=None)

    failures = aggregate_failures([r for r in all_results if not r.warmup])
    if missed_total:
        failures.append(
            {
                "at": "request",
                "count": missed_total,
                "category": "malformed-output",
                "message": "the needle was not in the answer; the model did not read the "
                "context it was given",
                "sample_request_id": missed_sample,
            }
        )

    return WorkloadOutcome(
        kind="longctx",
        metrics=headline["metrics"] if headline else None,
        sweep=entries,
        failures=failures,
        resolved_params={
            "axis": "input_tokens",
            "points": [[p["input_tokens"], p["depth_pct"]] for p in points_detail],
            "output_tokens": output_tokens,
            "needle_check": needle_check,
            "needle_depth": ctx.params.get("needle_depth"),
            "headline_input_tokens": headline["input_tokens"] if headline else None,
            "needles_found": sum(1 for p in points_detail if p["needle_correct"]),
            "needles_total": sum(1 for p in points_detail if p["needle_correct"] is not None),
            "dataset_categories": ctx.params.get("dataset_categories"),
            "dataset_target_tokens": ctx.params.get("dataset_target_tokens"),
            "timeout_s": ctx.timeout_s,
            "seed": ctx.param("seed", ctx.spec.request.seed),
        },
        raw={"points": points_detail, "requests": raw_payload(all_results)},
        gotchas=gotchas,
        requests=all_results,
        warnings=list(ctx.warnings),
    )
