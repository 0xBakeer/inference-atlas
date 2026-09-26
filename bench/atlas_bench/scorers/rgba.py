"""Transparency scorer: is the background actually transparent.

`transparent: true` is the parameter a lane is most likely to accept and ignore. What comes
back then is a perfectly good picture of a sticker on a white square, and every other
metric in this harness is happy with it: it scores well on CLIP, it has a fine PSNR against
a reference that made the same mistake, and only the alpha channel knows. So this scorer
looks at the alpha channel and nothing else.

Three questions, all from the row's own thresholds, because a sticker of a cup with three
curls of steam is legitimately four components and a fox is one:

* how much of the image is transparent (a missing or uniformly opaque alpha fails here);
* how wide the ambiguous band is (a grey halo is an alpha that was inferred afterwards
  rather than generated);
* how many connected components the opaque region has (speckle detection).
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from . import ImageScore
from .imagemath import alpha_stats, component_count, load_image

__all__ = ["score_rgba"]


def score_rgba(path: Path, row: Any, cfg: dict[str, Any] | None = None) -> ImageScore:
    cfg = cfg or {}
    want = dict(getattr(row, "answer", None) or {})
    image = load_image(path)
    stats = alpha_stats(image)
    metrics: dict[str, Any] = {
        "transparent_fraction": round(stats["transparent_fraction"], 6),
        "opaque_fraction": round(stats["opaque_fraction"], 6),
        "ambiguous_fraction": round(stats["ambiguous_fraction"], 6),
    }

    if not stats["has_alpha"]:
        # Not "unscorable": a lane that returned no alpha channel answered the question.
        return ImageScore(False, metrics={**metrics, "has_alpha": 0},
                          detail="no alpha channel in the returned image")

    components, largest = component_count(
        image, min_fraction=float(cfg.get("min_component_fraction") or 0.001)
    )
    metrics.update({
        "has_alpha": 1,
        "components": components,
        "largest_component_fraction": round(largest, 6),
    })

    reasons = []
    minimum = want.get("min_transparent_fraction")
    if minimum is not None and stats["transparent_fraction"] < float(minimum):
        reasons.append(
            f"transparent {stats['transparent_fraction']:.3f} < {float(minimum):.3f}"
        )
    ceiling = want.get("max_ambiguous_fraction")
    if ceiling is not None and stats["ambiguous_fraction"] > float(ceiling):
        reasons.append(f"ambiguous {stats['ambiguous_fraction']:.3f} > {float(ceiling):.3f}")
    max_components = want.get("max_components")
    if max_components is not None and components > int(max_components):
        reasons.append(f"{components} components > {int(max_components)}")

    return ImageScore(
        correct=not reasons,
        metrics=metrics,
        detail="; ".join(reasons) or "within thresholds",
    )
