"""Image workload: how long one picture takes, and how much memory it took to make it.

`kind: image` is the latency half of image-generation measurement. It renders a handful of
prompts at one fixed shape — size, steps, guidance, reference count — repeats each of them
and reports the distribution of seconds per image. The shape is the workload, because the
same prompts at another size are another measurement, and the prompts come from a dataset
so that two lanes are asked for the same pictures.

Three things are deliberate:

* **Concurrency is one.** A 7B transformer over thousands of latent tokens saturates a
  single GPU by itself; a second request in flight measures the queue.
* **Warmup is excluded, not skipped.** The first render of a process pays for weight load,
  kernel selection and allocator growth. It is rendered and thrown away, and the number of
  warmups is in the result.
* **Nothing generated is kept.** Images go to a temporary directory and are deleted when
  the workload ends, unless the caller asked for them somewhere (`params.image_dir`, which
  is how `atlas-bench t2i-reference` builds a reference bundle). No result file has ever
  carried a picture.
"""

from __future__ import annotations

import tempfile
from collections import defaultdict
from contextlib import nullcontext
from pathlib import Path
from typing import Any

from ..data import load_rows
from ..images import ImageLane, ImageRequest, ImageResult, build_lane
from ..metrics import distribution
from .base import RunContext, WorkloadOutcome, gotcha, sampling

__all__ = ["build_requests", "image_metrics", "render_all", "run_image", "select_prompt_rows"]

#: Per-render rows kept in `raw.payload`.
RAW_LIMIT = 400


def select_prompt_rows(ctx: RunContext, dataset_id: str) -> list[dict[str, Any]]:
    """Rows of a generation-prompt dataset, filtered by the workload's categories.

    A latency workload takes the first `num_requests` rows of its categories, in file
    order, so a shorter run is a prefix of a longer one rather than a different sample.
    """
    rows = load_rows(ctx.registry, dataset_id) if dataset_id else []
    if not rows:
        ctx.warnings.append(f"dataset-missing:{dataset_id or '<none>'}")
        return []
    categories = ctx.params.get("dataset_categories")
    if categories:
        wanted = {str(c).lower() for c in categories}
        rows = [r for r in rows if str(r.get("category") or "").lower() in wanted]
    limit = ctx.param("num_requests")
    return rows[: int(limit)] if limit else rows


def build_requests(ctx: RunContext, rows: list[dict[str, Any]], dataset_dir: Path) -> list:
    """One :class:`ImageRequest` per row, at the workload's shape."""
    width = int(ctx.param("width", 1024))
    height = int(ctx.param("height", 1024))
    steps = int(ctx.param("steps", 40))
    seed = int(ctx.param("seed", 42))
    guidance = ctx.params.get("guidance")
    transparent = bool(ctx.params.get("transparent") or False)
    wanted_refs = ctx.params.get("ref_images")

    requests = []
    for row in rows:
        references = [dataset_dir / name for name in (row.get("reference_images") or [])]
        if wanted_refs is not None and len(references) != int(wanted_refs):
            ctx.warnings.append(
                f"reference-count-mismatch:{row.get('id')} has {len(references)} reference "
                f"images, the workload asks for {int(wanted_refs)}"
            )
        requests.append(ImageRequest(
            id=str(row.get("id")),
            prompt=str(row.get("prompt") or ""),
            width=width,
            height=height,
            steps=steps,
            seed=seed,
            guidance=float(guidance) if guidance is not None else None,
            transparent=transparent,
            n=int(ctx.param("images_per_request", 1)),
            references=references,
        ))
    return requests


async def render_all(
    lane: ImageLane,
    requests: list[ImageRequest],
    out_dir: Path,
    *,
    repeat: int = 1,
    warmup: int = 0,
    progress: Any = None,
) -> list[ImageResult]:
    """Render every request `repeat` times, warmups first, sequentially.

    Sequential by design (see the module docstring). The warmups render the first request
    and are tagged rather than dropped, so the result can show what was excluded.
    """
    results: list[ImageResult] = []
    for index in range(warmup):
        if not requests:
            break
        request = requests[index % len(requests)]
        warm = ImageRequest(**{**request.__dict__, "warmup": True})
        results.append(await lane.render(warm, out_dir / f"warmup-{index:02d}.png"))

    for round_index in range(max(1, repeat)):
        for request in requests:
            path = out_dir / (f"{request.id}.png" if repeat == 1
                              else f"{request.id}-r{round_index}.png")
            result = await lane.render(request, path)
            results.append(result)
            if progress is not None:
                progress(result)
    return results


def image_metrics(results: list[ImageResult]) -> dict[str, Any]:
    """The metric block of an image run: counts, seconds per image, nothing invented.

    `s_per_image` is over the measured renders only. Where a lane reports its own inference
    time that is what is used, because the wall clock includes the client; which of the two
    each render used is in the raw payload rather than averaged into silence.
    """
    measured = [r for r in results if not r.warmup]
    ok = [r for r in measured if r.ok]
    return {
        "requests_total": len(measured),
        "requests_ok": len(ok),
        "requests_failed": len(measured) - len(ok),
        "success_rate": round(len(ok) / len(measured), 6) if measured else None,
        "duration_s": round(sum(r.wall_s for r in results), 3),
        "s_per_image": distribution([r.seconds for r in ok]),
        "e2e_ms": distribution([r.wall_s * 1000 for r in ok]),
        "load_s": None,
    }


def failure_blocks(results: list[ImageResult]) -> list[dict[str, Any]]:
    """`failures[]` grouped by category — a failure is a result, not an omission."""
    by_category: dict[str, list[ImageResult]] = defaultdict(list)
    for result in results:
        if not result.ok:
            by_category[result.error_category or "other"].append(result)
    return [
        {
            "at": "request",
            "count": len(group),
            "category": category,
            "message": (group[0].error_message or category)[:500],
            "sample_request_id": group[0].id,
        }
        for category, group in sorted(by_category.items())
    ]


def raw_payload(results: list[ImageResult]) -> list[dict[str, Any]]:
    return [
        {
            "id": result.id,
            "warmup": result.warmup,
            "ok": result.ok,
            "seconds": round(result.seconds, 4),
            "wall_s": round(result.wall_s, 4),
            "timing_source": result.timing_source,
            "status": result.status,
            "error_category": result.error_category,
        }
        for result in results[:RAW_LIMIT]
    ]


def lane_gotchas(lane: ImageLane, requests: list[ImageRequest]) -> list[dict[str, Any]]:
    """Say it out loud when the lane cannot do what the workload asked for."""
    found = []
    wants_transparency = any(r.transparent for r in requests)
    supports = getattr(lane, "supports_transparency", None)
    if wants_transparency and supports is not None and not supports():
        found.append(gotcha(
            "blocker",
            "This lane has no transparency parameter, so the images were rendered without "
            "one: what was measured is the API, not the model's RGBA mode.",
        ))
    return found


async def run_image(ctx: RunContext) -> WorkloadOutcome:
    """Render the workload's prompts at its shape and report seconds per image."""
    dataset_id = str(ctx.workload.get("dataset_id") or "")
    rows = select_prompt_rows(ctx, dataset_id)
    if not rows:
        return WorkloadOutcome(
            kind="image",
            resolved_params={"dataset_id": dataset_id},
            gotchas=[gotcha("blocker",
                            f"Prompt dataset '{dataset_id}' has no rows in this checkout.")],
            warnings=list(ctx.warnings),
        )

    dataset_dir = ctx.registry.dataset_dir(dataset_id)
    requests = build_requests(ctx, rows, dataset_dir)
    lane = ctx.image_lane or build_lane(ctx.spec)
    owns_lane = ctx.image_lane is None
    repeat = int(ctx.param("repeat", 3))
    warmup = int(ctx.param("warmup_requests", 1))

    keep = ctx.params.get("image_dir")
    scratch = nullcontext(str(keep)) if keep else tempfile.TemporaryDirectory(prefix="atlas-t2i-")
    try:
        with scratch as directory, sampling(ctx) as telemetry:
            out_dir = Path(directory)
            out_dir.mkdir(parents=True, exist_ok=True)
            results = await render_all(lane, requests, out_dir, repeat=repeat, warmup=warmup)
    finally:
        if owns_lane:
            await lane.aclose()

    metrics = image_metrics(results)
    metrics.update(telemetry)
    return WorkloadOutcome(
        kind="image",
        metrics=metrics,
        failures=failure_blocks([r for r in results if not r.warmup]),
        resolved_params={
            "dataset_id": dataset_id,
            "prompts": len(requests),
            "width": ctx.param("width", 1024),
            "height": ctx.param("height", 1024),
            "steps": ctx.param("steps", 40),
            "seed": ctx.param("seed", 42),
            "guidance": ctx.params.get("guidance"),
            "images_per_request": ctx.param("images_per_request", 1),
            "ref_images": ctx.params.get("ref_images"),
            "transparent": bool(ctx.params.get("transparent") or False),
            "concurrency": 1,
            "repeat": repeat,
            "warmup_requests": warmup,
            "timeout_s": ctx.timeout_s,
            "dataset_categories": ctx.params.get("dataset_categories"),
            "lane": lane.kind,
            "invocation": lane.invocation,
        },
        raw={"lane": lane.kind, "payload": raw_payload(results)},
        gotchas=lane_gotchas(lane, requests),
        warnings=list(ctx.warnings),
    )
