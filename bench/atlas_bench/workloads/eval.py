"""Eval workload: capability, scored per item (SPEC §4 ``scores``).

Each row is one non-streaming request — latency and token counts are still recorded — scored
by **the row's own scorer**; the workload's ``eval.scorer`` is only the default, because
several datasets mix scorers (``eval-reasoning-v1`` mixes ``mc`` and ``exact``,
``eval-multilingual-v1`` mixes three).

Row shapes that need more than a prompt:

* ``row.image`` — inlined as a ``data:image/…;base64,…`` content part next to the text.
* ``row.meta.tools`` — sent as the request's ``tools`` with ``tool_choice: "auto"``; the
  scored object is ``tool_calls[0]``, not the text.
* ``row.meta.haystack`` — the row's ``prompt`` is the question only; the document is rebuilt
  from the recipe and prepended. Sending the question alone is not a smaller measurement, it
  is a wrong one.

Scoring runs in a worker thread because ``code_exec`` spawns a subprocess — the event loop
has other items in flight.

``accuracy``, ``avg_latency_ms`` and ``success_rate`` — the three names an eval workload's
``metrics_required`` lists — all live in ``scores``. ``success_rate`` is the share of
requests that completed at all, independent of whether the answers were right, and it is
mirrored in the reduced request-layer ``metrics`` block next to the request counts.
"""

from __future__ import annotations

import asyncio
import base64
import mimetypes
from collections import defaultdict
from pathlib import Path
from typing import Any

from ..client import RequestResult, is_refusal
from ..data import EvalRow, filter_eval_rows, load_eval_rows, render_haystack_prompt
from ..metrics import aggregate_serving, distribution
from ..scorers import ScoreResult, get_scorer, normalize_scorer_name
from ..scorers.tools import score_tool_call
from .base import RunContext, WorkloadOutcome, gotcha, sampling

__all__ = ["PREDICTED_LIMIT", "build_messages", "encode_image", "run_eval"]

#: ``predicted`` is truncated to this many characters in the stored items (SPEC §4).
PREDICTED_LIMIT = 500


def encode_image(path: Path) -> str | None:
    """Return a ``data:`` URL for an image file, or ``None`` when it cannot be read."""
    try:
        payload = path.read_bytes()
    except OSError:
        return None
    mime = mimetypes.guess_type(path.name)[0] or "image/png"
    return f"data:{mime};base64,{base64.b64encode(payload).decode('ascii')}"


def build_messages(row: EvalRow, dataset_dir: Path) -> list[dict[str, Any]]:
    """Messages for one eval row, inlining the image of a vision row."""
    messages = [dict(m) for m in row.messages]
    if not row.image:
        return messages
    candidate = Path(row.image)
    if not candidate.is_absolute():
        candidate = dataset_dir / row.image
    url = encode_image(candidate)
    if url is None:
        return messages
    for message in reversed(messages):
        if message.get("role") != "user":
            continue
        content = message.get("content")
        parts: list[dict[str, Any]] = []
        if isinstance(content, str):
            parts.append({"type": "text", "text": content})
        elif isinstance(content, list):
            parts.extend(content)
        parts.append({"type": "image_url", "image_url": {"url": url}})
        message["content"] = parts
        break
    return messages


def _row_messages(row: EvalRow, ctx: RunContext, dataset_dir: Path) -> list[dict[str, Any]]:
    """Everything that has to happen to a row before it goes on the wire."""
    if row.meta.get("haystack"):
        messages, warnings = render_haystack_prompt(row, ctx.registry)
        ctx.warnings.extend(warnings)
        row = EvalRow(**{**row.__dict__, "messages": messages})
    return build_messages(row, dataset_dir)


def _score(row: EvalRow, result: RequestResult, default_scorer: str) -> ScoreResult:
    """Score one completed item with the row's own scorer."""
    if row.meta.get("tools"):
        row.tool_calls = result.tool_calls
        return score_tool_call(result.text, row)
    name = normalize_scorer_name(row.scorer or default_scorer)
    return get_scorer(name)(result.text, row)


def _eval_metrics(results: list[RequestResult]) -> dict[str, Any]:
    """The request-layer metrics of an eval run.

    Deliberately *not* the full serving block: eval items are single non-streaming requests
    run at a fixed concurrency for wall-clock reasons only, so there is no meaningful TTFT,
    TPOT or decode rate to report — publishing one would invite comparison against a serving
    run that measured something else. What is meaningful is how many requests completed
    (``success_rate``), how long they took and how many tokens they moved.
    """
    block = aggregate_serving(results, concurrency=1)
    keep = {
        "requests_total",
        "requests_ok",
        "requests_failed",
        "success_rate",
        "duration_s",
        "input_tokens_total",
        "output_tokens_total",
        "e2e_ms",
    }
    metrics = {key: value for key, value in block.items() if key in keep}
    metrics["e2e_ms"] = distribution(
        [r.e2e_s * 1000 for r in results if r.ok and r.e2e_s is not None]
    )
    return metrics


async def run_eval(ctx: RunContext) -> WorkloadOutcome:
    """Run every eval row, score it and build the ``scores`` block."""
    eval_cfg = ctx.workload.get("eval") or {}
    dataset_id = str(ctx.workload.get("dataset_id") or "")
    rows = load_eval_rows(ctx.registry, dataset_id) if dataset_id else []
    rows = filter_eval_rows(
        rows, ctx.params.get("dataset_categories"), ctx.params.get("dataset_target_tokens")
    )
    limit = ctx.param("limit") or ctx.param("num_requests")
    if limit:
        rows = rows[: int(limit)]
    if not rows:
        ctx.warnings.append(f"dataset-missing:{dataset_id or '<none>'}")
        return WorkloadOutcome(
            kind="eval",
            scores=None,
            resolved_params={"dataset_id": dataset_id, "suite": eval_cfg.get("suite")},
            gotchas=[
                gotcha("blocker", f"Eval dataset '{dataset_id}' has no rows in this checkout.")
            ],
            warnings=list(ctx.warnings),
        )

    dataset_dir = ctx.registry.dataset_dir(dataset_id)
    default_scorer = normalize_scorer_name(eval_cfg.get("scorer") or "exact")
    max_tokens = int(eval_cfg.get("max_output_tokens") or ctx.param("output_tokens", 1024))
    concurrency = int(ctx.param("concurrency", 4))
    item_timeout = ctx.timeout_s
    semaphore = asyncio.Semaphore(max(1, concurrency))

    async def run_row(index: int, row: EvalRow) -> tuple[EvalRow, RequestResult, ScoreResult]:
        extra = dict(ctx.extra_body())
        if row.meta.get("tools"):
            extra["tools"] = row.meta["tools"]
            extra["tool_choice"] = row.meta.get("tool_choice") or "auto"
        async with semaphore:
            result = await ctx.client.chat_once(
                _row_messages(row, ctx, dataset_dir),
                request_id=f"eval-{index:05d}",
                prompt_id=row.id,
                max_tokens=row.max_tokens or max_tokens,
                temperature=float(ctx.param("temperature", ctx.spec.request.temperature)),
                top_p=ctx.spec.request.top_p,
                seed=ctx.spec.request.seed,
                extra_body=extra,
                timeout_s=item_timeout,
            )
        if not result.ok:
            return (
                row,
                result,
                ScoreResult(
                    False,
                    predicted="",
                    expected=str(row.answer or ""),
                    scored=False,
                    detail=result.error_category,
                ),
            )
        return row, result, await asyncio.to_thread(_score, row, result, default_scorer)

    with sampling(ctx) as telemetry:
        outcomes = list(await asyncio.gather(*(run_row(i, r) for i, r in enumerate(rows))))

    items: list[dict[str, Any]] = []
    by_category: dict[str, dict[str, int]] = defaultdict(lambda: {"total": 0, "correct": 0})
    by_difficulty: dict[str, dict[str, int]] = defaultdict(lambda: {"total": 0, "correct": 0})
    latencies: list[float] = []
    output_tokens: list[int] = []
    failures_by_category: dict[str, list[RequestResult]] = defaultdict(list)
    scored_total = 0
    correct_total = 0

    for row, result, score in outcomes:
        latency_ms = round((result.e2e_s or 0.0) * 1000, 3)
        latencies.append(latency_ms)
        if result.completion_tokens:
            output_tokens.append(result.completion_tokens)
        if score.scored:
            scored_total += 1
            correct_total += int(score.correct)
            by_category[row.category]["total"] += 1
            by_category[row.category]["correct"] += int(score.correct)
            by_difficulty[row.difficulty]["total"] += 1
            by_difficulty[row.difficulty]["correct"] += int(score.correct)
        if not result.ok:
            failures_by_category[result.error_category or "other"].append(result)
        elif not score.correct and is_refusal(result.text):
            failures_by_category["refusal"].append(result)
        if score.scored:
            # Unscored items are deliberately absent from `items`: the schema requires a
            # boolean `correct`, and recording "could not be judged" as "wrong" would
            # quietly corrupt the accuracy. They are counted in `failures` instead.
            items.append(
                {
                    "id": row.id,
                    "correct": score.correct,
                    "predicted": (score.predicted or "")[:PREDICTED_LIMIT],
                    "expected": (score.expected or "")[:PREDICTED_LIMIT],
                    "latency_ms": latency_ms,
                    "output_tokens": result.completion_tokens,
                    "category": row.category,
                    "difficulty": row.difficulty,
                }
            )

    completed = sum(1 for _, result, _ in outcomes if result.ok)
    scores = {
        "suite": str(eval_cfg.get("suite") or dataset_id or "eval"),
        "total": scored_total,
        "correct": correct_total,
        "accuracy": round(correct_total / scored_total, 6) if scored_total else 0.0,
        # The share of requests that completed at all, whatever the answers were. It is
        # mirrored in the metric block: `metrics_required` for an eval workload names it
        # alongside accuracy, and both layers are meaningful.
        "success_rate": round(completed / len(outcomes), 6) if outcomes else None,
        "by_category": {k: dict(v) for k, v in sorted(by_category.items())},
        "by_difficulty": {k: dict(v) for k, v in sorted(by_difficulty.items())},
        "avg_output_tokens": round(sum(output_tokens) / len(output_tokens), 2)
        if output_tokens
        else None,
        "avg_latency_ms": round(sum(latencies) / len(latencies), 2) if latencies else None,
        "failures": sum(len(v) for v in failures_by_category.values()),
        "items": items,
    }

    failures = [
        {
            "at": "score" if category == "refusal" else "request",
            "count": len(results),
            "category": category,
            "message": (results[0].error_message or "refusal detected")[:500],
            "sample_request_id": results[0].request_id,
        }
        for category, results in sorted(failures_by_category.items())
    ]

    gotchas: list[dict[str, Any]] = []
    unscored = len(outcomes) - scored_total
    if unscored:
        gotchas.append(
            gotcha(
                "warn",
                f"{unscored} of {len(outcomes)} eval items could not be scored and are "
                "excluded from both accuracy and scores.items.",
            )
        )
    threshold = eval_cfg.get("pass_threshold")
    if isinstance(threshold, (int, float)) and scored_total and scores["accuracy"] < threshold:
        gotchas.append(
            gotcha(
                "warn",
                f"Accuracy {scores['accuracy']:.3f} is below the workload's pass_threshold "
                f"of {threshold}.",
            )
        )

    metrics = _eval_metrics([r for _, r, _ in outcomes])
    metrics.update(telemetry)

    return WorkloadOutcome(
        kind="eval",
        metrics=metrics,
        scores=scores,
        failures=failures,
        resolved_params={
            "dataset_id": dataset_id,
            "suite": scores["suite"],
            "scorer": default_scorer,
            "items": len(rows),
            "concurrency": concurrency,
            "max_output_tokens": max_tokens,
            "timeout_s": item_timeout,
            "temperature": ctx.param("temperature", ctx.spec.request.temperature),
            "reasoning": ctx.params.get("reasoning"),
            "dataset_categories": ctx.params.get("dataset_categories"),
            "dataset_target_tokens": ctx.params.get("dataset_target_tokens"),
            "pass_threshold": threshold,
            "seed": ctx.param("seed", ctx.spec.request.seed),
        },
        raw={
            "scorer": default_scorer,
            "scorers_used": sorted(
                {normalize_scorer_name(r.scorer or default_scorer) for r, _, _ in outcomes}
            ),
        },
        gotchas=gotchas,
        requests=[r for _, r, _ in outcomes],
        warnings=list(ctx.warnings),
    )
