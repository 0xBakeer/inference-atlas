"""Eval workloads whose item is a picture: OCR, adherence, transparency, fidelity.

These are `kind: eval` like every other suite — they produce a `scores` block, they count
toward eval coverage, and `accuracy` means the same thing it always does. What differs is
that the item has to be *made* before it can be scored, and that the render spec is frozen
in the dataset row rather than chosen by the workload: `t2i-0007` is one picture, at one
size, from one seed, or the numbers are not comparable to anybody else's.

`scores.items[]` carries the measurement behind each verdict in `metrics` (psnr, ssim, cer,
clipscore, transparent_fraction, and the perceptual hashes), and `predicted` is always
null. A picture is generated content and this repository stores none of it — not the
pixels, and not the OCR transcription of them either, which is the same content read back.
"""

from __future__ import annotations

import tempfile
from collections import defaultdict
from contextlib import nullcontext
from pathlib import Path
from typing import Any

from ..data import EvalRow, filter_eval_rows, load_eval_rows
from ..images import ImageRequest, build_lane
from ..metrics import distribution
from ..scorers import ImageScore, get_image_scorer, normalize_scorer_name
from ..scorers.fidelity import load_reference_bundle
from .base import RunContext, WorkloadOutcome, gotcha, sampling
from .image import failure_blocks, image_metrics, lane_gotchas, raw_payload

__all__ = ["render_request_for", "run_image_eval", "scorer_config"]


def render_request_for(row: EvalRow, dataset_dir: Path) -> ImageRequest:
    """The picture a frozen case asks for, exactly as the dataset pinned it."""
    render = dict((row.meta or {}).get("render") or {})
    references = [dataset_dir / name for name in (row.meta or {}).get("reference_images", [])]
    prompt = next(
        (str(m.get("content") or "") for m in reversed(row.messages or [])
         if m.get("role") == "user"),
        "",
    )
    return ImageRequest(
        id=row.id,
        prompt=prompt,
        width=int(render.get("width") or 1024),
        height=int(render.get("height") or 1024),
        steps=int(render.get("steps") or 40),
        seed=int(render.get("seed") or 42),
        guidance=None,
        transparent=bool(render.get("transparent") or False),
        references=references,
    )


def scorer_config(ctx: RunContext) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Everything the scorers need out of the workload, plus any gotchas loading it raised.

    The fidelity suite is the one that can fail here: it needs a reference bundle from a
    bf16 run on this box, and without one there is nothing to compare against. That is
    reported as a blocker with the reason, not worked around.
    """
    cfg = {k: v for k, v in ctx.params.items() if not str(k).startswith("dataset_")}
    cfg.update(ctx.params.get("scorer_config") or {})
    gotchas: list[dict[str, Any]] = []

    reference = ctx.params.get("reference_bundle") or ctx.params.get("reference_dir")
    if reference and not isinstance(reference, (str, Path)):
        cfg["reference_bundle"] = reference  # already loaded (tests, or a caller that has one)
    elif reference:
        try:
            cfg["reference_bundle"] = load_reference_bundle(Path(str(reference)).expanduser())
        except (OSError, ValueError) as exc:
            gotchas.append(gotcha("blocker", f"Reference bundle unusable: {exc}"))
    return cfg, gotchas


async def run_image_eval(ctx: RunContext) -> WorkloadOutcome:
    """Render every frozen case of the suite, score it, and build the `scores` block."""
    eval_cfg = ctx.workload.get("eval") or {}
    dataset_id = str(ctx.workload.get("dataset_id") or "")
    rows = load_eval_rows(ctx.registry, dataset_id) if dataset_id else []
    rows = filter_eval_rows(rows, ctx.params.get("dataset_categories"), None)
    limit = ctx.param("limit") or ctx.param("num_requests")
    if limit:
        rows = rows[: int(limit)]
    default_scorer = normalize_scorer_name(eval_cfg.get("scorer") or "ocr")

    if not rows:
        ctx.warnings.append(f"dataset-missing:{dataset_id or '<none>'}")
        return WorkloadOutcome(
            kind="eval",
            resolved_params={"dataset_id": dataset_id, "suite": eval_cfg.get("suite")},
            gotchas=[gotcha("blocker",
                            f"Eval dataset '{dataset_id}' has no rows in this checkout.")],
            warnings=list(ctx.warnings),
        )

    dataset_dir = ctx.registry.dataset_dir(dataset_id)
    requests = [render_request_for(row, dataset_dir) for row in rows]
    cfg, cfg_gotchas = scorer_config(ctx)
    lane = ctx.image_lane or build_lane(ctx.spec)
    owns_lane = ctx.image_lane is None
    warmup = int(ctx.param("warmup_requests", 1))

    keep = ctx.params.get("image_dir")
    scratch = nullcontext(str(keep)) if keep else tempfile.TemporaryDirectory(prefix="atlas-t2i-")
    outcomes: list[tuple[EvalRow, Any, ImageScore]] = []
    warmups: list[Any] = []
    try:
        with scratch as directory, sampling(ctx) as telemetry:
            out_dir = Path(directory)
            out_dir.mkdir(parents=True, exist_ok=True)
            for index in range(warmup):
                warm = ImageRequest(**{**requests[index % len(requests)].__dict__,
                                       "warmup": True})
                warmups.append(await lane.render(warm, out_dir / f"warmup-{index:02d}.png"))
            for row, request in zip(rows, requests, strict=True):
                result = await lane.render(request, out_dir / f"{row.id}.png")
                outcomes.append((row, result, _score(row, result, default_scorer, cfg)))
    finally:
        if owns_lane:
            await lane.aclose()

    results = [r for _, r, _ in outcomes]
    scores = _scores_block(eval_cfg, dataset_id, outcomes)
    metrics = image_metrics(warmups + results)
    metrics.update(telemetry)

    unscored = sum(1 for _, _, score in outcomes if not score.scored)
    gotchas = list(cfg_gotchas) + lane_gotchas(lane, requests)
    if unscored:
        gotchas.append(gotcha(
            "warn",
            f"{unscored} of {len(outcomes)} items could not be scored and are excluded from "
            "accuracy and from scores.items; the reason is in failures[].",
        ))

    bundle = cfg.get("reference_bundle")
    resolved = {
        "dataset_id": dataset_id,
        "suite": scores["suite"],
        "scorer": default_scorer,
        "items": len(rows),
        "concurrency": 1,
        "warmup_requests": warmup,
        "timeout_s": ctx.timeout_s,
        "dataset_categories": ctx.params.get("dataset_categories"),
        "lane": lane.kind,
        "invocation": lane.invocation,
        "backend": next((s.backend for _, _, s in outcomes if s.backend), None),
    }
    for key in ("ocr_backend", "ocr_languages", "clip_backend", "clip_model", "clip_pretrained",
                "clipscore_min", "psnr_min", "ssim_min", "min_component_fraction", "lpips"):
        if key in ctx.params:
            resolved[key] = ctx.params[key]
    if bundle is not None:
        resolved["reference"] = bundle.describe()
        resolved["reference_run_id"] = bundle.run_id

    return WorkloadOutcome(
        kind="eval",
        metrics=metrics,
        scores=scores,
        failures=failure_blocks(results) + _unscorable_failures(outcomes),
        resolved_params=resolved,
        raw={"lane": lane.kind, "scorer": default_scorer,
             "payload": raw_payload(warmups + results)},
        gotchas=gotchas,
        warnings=list(ctx.warnings),
    )


def _score(row: EvalRow, result: Any, default_scorer: str, cfg: dict[str, Any]) -> ImageScore:
    """Score one rendered case; a failed render is unscored rather than wrong."""
    if not result.ok or result.path is None:
        return ImageScore(False, scored=False, detail=result.error_category or "render-failed")
    scorer = get_image_scorer(normalize_scorer_name(row.scorer or default_scorer))
    try:
        return scorer(result.path, row, cfg)
    except Exception as exc:  # a scorer must never take the run down with it
        return ImageScore(False, scored=False, detail=f"{type(exc).__name__}: {exc}"[:200])


def _scores_block(eval_cfg: dict[str, Any], dataset_id: str, outcomes: list) -> dict[str, Any]:
    items: list[dict[str, Any]] = []
    by_category: dict[str, dict[str, int]] = defaultdict(lambda: {"total": 0, "correct": 0})
    by_difficulty: dict[str, dict[str, int]] = defaultdict(lambda: {"total": 0, "correct": 0})
    latencies: list[float] = []
    scored_total = correct_total = 0

    for row, result, score in outcomes:
        latency_ms = round((result.wall_s or 0.0) * 1000, 3)
        latencies.append(latency_ms)
        if not score.scored:
            continue
        scored_total += 1
        correct_total += int(score.correct)
        by_category[row.category]["total"] += 1
        by_category[row.category]["correct"] += int(score.correct)
        by_difficulty[row.difficulty]["total"] += 1
        by_difficulty[row.difficulty]["correct"] += int(score.correct)
        items.append({
            "id": row.id,
            "correct": score.correct,
            # Null on purpose: what the model produced is a picture, and this repository
            # stores no generated content. The measurement is in `metrics`.
            "predicted": None,
            "expected": _expected_text(row),
            "latency_ms": latency_ms,
            "output_tokens": None,
            "category": row.category,
            "difficulty": row.difficulty,
            "metrics": score.metrics or None,
        })

    completed = sum(1 for _, result, _ in outcomes if result.ok)
    return {
        "suite": str(eval_cfg.get("suite") or dataset_id or "image"),
        "total": scored_total,
        "correct": correct_total,
        "accuracy": round(correct_total / scored_total, 6) if scored_total else 0.0,
        "success_rate": round(completed / len(outcomes), 6) if outcomes else None,
        "by_category": {k: dict(v) for k, v in sorted(by_category.items())},
        "by_difficulty": {k: dict(v) for k, v in sorted(by_difficulty.items())},
        "avg_output_tokens": None,
        "avg_latency_ms": round(sum(latencies) / len(latencies), 2) if latencies else None,
        "failures": sum(1 for _, result, score in outcomes if not result.ok or not score.scored),
        "items": items,
    }


def _expected_text(row: EvalRow) -> str | None:
    """The authored side of the comparison, which is already public in the dataset."""
    answer = getattr(row, "answer", None)
    if isinstance(answer, str):
        return answer[:500]
    if isinstance(answer, dict) and answer.get("strings"):
        return " | ".join(str(s) for s in answer["strings"])[:500]
    return None


def _unscorable_failures(outcomes: list) -> list[dict[str, Any]]:
    """Items that rendered but could not be judged: a missing reference, no OCR backend."""
    by_reason: dict[str, list[Any]] = defaultdict(list)
    for row, result, score in outcomes:
        if result.ok and not score.scored:
            by_reason[score.detail or "unscored"].append(row)
    return [
        {
            "at": "score",
            "count": len(rows),
            "category": "unscorable",
            "message": f"completed but could not be judged: {reason}"[:500],
            "sample_request_id": rows[0].id,
        }
        for reason, rows in sorted(by_reason.items())
    ]


def distribution_of(values: list[float]) -> dict[str, float] | None:
    """Re-exported for callers that build their own metric blocks (the reference command)."""
    return distribution(values)
