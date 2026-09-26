"""Building a bf16 reference bundle for the fidelity suite.

`eval-t2i-fidelity-v1` compares a lane against bf16 at identical prompt, size, steps and
seed. The reference cannot be shipped in the repository — a generated image is model output
and this repository stores none (SPEC §0.6) — so it is produced locally, once, on the box
that will run the quantized lanes:

    atlas-bench t2i-reference --spec bf16.json --out ~/t2i-reference-bf16

What that writes is a directory of PNGs plus a manifest naming the configuration that made
them: the engine and its version, the canonical args and their `config_id`, the hardware
id, and per case the sha256, a 64-bit perceptual hash and the render digest. The manifest
is what travels into every fidelity result; the PNGs never leave the box.

Keeping the bundle honest matters more than keeping it convenient. The render digest is
recomputed from the dataset row rather than copied, so a bundle built from an edited case
set cannot silently be compared against the published one.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
from pathlib import Path
from typing import Any

from .canonical import canonicalize
from .client import utc_now
from .data import filter_eval_rows, load_eval_rows
from .ids import config_id_from_canonical
from .images import build_lane, render_digest
from .registry import Registry
from .scorers.fidelity import BUNDLE_SCHEMA, MANIFEST_NAME
from .scorers.imagemath import load_image, phash
from .spec import TaskSpec
from .workloads.image_eval import render_request_for

__all__ = ["DEFAULT_WORKLOAD", "build_reference_bundle", "build_reference_bundle_sync"]

DEFAULT_WORKLOAD = "eval-t2i-fidelity-v1"


async def build_reference_bundle(
    spec: TaskSpec,
    *,
    registry: Registry,
    out_dir: Path,
    workload_id: str = DEFAULT_WORKLOAD,
    lane: Any = None,
    progress: Any = None,
) -> dict[str, Any]:
    """Render every case of the fidelity suite and write the bundle. Returns the manifest."""
    workload = registry.workload(workload_id) or {}
    dataset_id = str(workload.get("dataset_id") or workload_id)
    rows = filter_eval_rows(
        load_eval_rows(registry, dataset_id),
        (workload.get("params") or {}).get("dataset_categories"),
        None,
    )
    if not rows:
        raise RuntimeError(f"dataset {dataset_id!r} has no rows in this checkout")

    dataset_dir = registry.dataset_dir(dataset_id)
    images_dir = out_dir / "images"
    images_dir.mkdir(parents=True, exist_ok=True)

    own_lane = lane is None
    lane = lane or build_lane(spec)
    items: dict[str, Any] = {}
    failures: list[dict[str, str]] = []
    try:
        for row in rows:
            request = render_request_for(row, dataset_dir)
            target = images_dir / f"{row.id}.png"
            result = await lane.render(request, target)
            if progress is not None:
                progress(row.id, result)
            if not result.ok or result.path is None:
                failures.append({
                    "id": row.id,
                    "category": result.error_category or "other",
                    "message": (result.error_message or "")[:300],
                })
                continue
            payload = target.read_bytes()
            items[row.id] = {
                "file": f"images/{row.id}.png",
                "sha256": hashlib.sha256(payload).hexdigest(),
                "phash": phash(load_image(target)),
                "render_digest": render_digest(request.prompt, {
                    "width": request.width,
                    "height": request.height,
                    "steps": request.steps,
                    "seed": request.seed,
                    "transparent": request.transparent,
                    "reference_images": (row.meta or {}).get("reference_images") or [],
                }),
                "width": request.width,
                "height": request.height,
                "steps": request.steps,
                "seed": request.seed,
                "seconds": round(result.seconds, 4),
            }
    finally:
        if own_lane:
            await lane.aclose()

    resolved = registry.resolve_config(
        engine_id=spec.engine.id,
        engine_version=spec.engine.version,
        args=spec.args,
        quant_id=spec.model.quant_id,
        dtype=spec.model.dtype,
        build=spec.engine.build,
    )
    args_canonical = canonicalize(resolved.canonical_input)
    manifest = {
        "schema": BUNDLE_SCHEMA,
        "created": utc_now(),
        "workload_id": workload_id,
        "dataset_id": dataset_id,
        "engine": {"id": spec.engine.id, "version": spec.engine.version,
                   "build": spec.engine.build},
        "model": {"id": spec.model.id, "quant_id": spec.model.quant_id},
        "hardware_id": spec.hardware.id,
        "args": spec.args,
        "args_canonical": args_canonical,
        "config_id": config_id_from_canonical(args_canonical),
        # Filled by the caller when the bundle was produced alongside a submitted run; a
        # bundle made on its own has no run to name, and null says exactly that.
        "run_id": None,
        "items": items,
        "failures": failures,
    }
    (out_dir / MANIFEST_NAME).write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return manifest


def build_reference_bundle_sync(spec: TaskSpec, **kwargs: Any) -> dict[str, Any]:
    """Blocking wrapper for the CLI."""
    return asyncio.run(build_reference_bundle(spec, **kwargs))
