"""Fidelity scorer: how far a lane drifted from a bf16 reference of the same picture.

The reference cannot live in this repository. A generated image is model output, not
authored data (SPEC §0.6, datasets/README.md), and 24 of them at 1K and 2K would also eat a
fifth of the corpus budget for something nobody can license. So the comparison is against a
**local bundle**: the contributor runs `atlas-bench t2i-reference` on the bf16 configuration
of the same box, which writes the images plus a manifest, and every quantized lane is then
scored against that.

What gets published is the numbers and a 64-bit perceptual hash of each side. The hash is
what makes two contributors' references comparable at all — equal hashes mean the same
picture, a large Hamming distance means two boxes that disagree about what bf16 produces on
this case, and that disagreement is worth knowing before anyone compares their PSNR tables.

The scorer refuses rather than guesses. A case whose reference was produced from a
different render spec, or at a different size, is left unscored with the reason attached:
a number that looks like drift but is actually a different picture would be worse than a
gap.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from . import ImageScore
from .imagemath import PSNR_MAX_DB, alpha_mae, hamming, load_image, phash, psnr, ssim

__all__ = ["ReferenceBundle", "load_reference_bundle", "lpips_distance", "score_fidelity"]

BUNDLE_SCHEMA = "t2i-reference/1"
MANIFEST_NAME = "manifest.json"


@dataclass
class ReferenceBundle:
    """A bf16 reference run on this box: images plus what produced them."""

    root: Path
    meta: dict[str, Any]
    items: dict[str, dict[str, Any]]

    @property
    def run_id(self) -> str | None:
        return self.meta.get("run_id")

    @property
    def config_id(self) -> str | None:
        return self.meta.get("config_id")

    def item(self, case_id: str) -> dict[str, Any] | None:
        return self.items.get(case_id)

    def path_for(self, case_id: str) -> Path | None:
        item = self.items.get(case_id)
        if not item or not item.get("file"):
            return None
        return self.root / item["file"]

    def describe(self) -> dict[str, Any]:
        """What the result records about the reference, without any pixels."""
        return {
            "schema": self.meta.get("schema"),
            "run_id": self.meta.get("run_id"),
            "config_id": self.meta.get("config_id"),
            "args_canonical": self.meta.get("args_canonical"),
            "engine": self.meta.get("engine"),
            "hardware_id": self.meta.get("hardware_id"),
            "workload_id": self.meta.get("workload_id"),
            "created": self.meta.get("created"),
            "cases": len(self.items),
        }

    def describe_flat(self) -> dict[str, Any]:
        """:meth:`describe` as ``reference_*`` scalars, which is what a result may hold.

        ``workload.resolved_params`` is a flat map in ``result.schema.json`` — its values are
        strings, numbers, booleans, arrays or null, and nothing else. The bundle header is a
        nested object, so it goes in one key per field rather than as a sub-object; the same
        information, in the shape the schema allows.
        """
        engine = self.meta.get("engine") or {}
        header = self.describe()
        flat = {f"reference_{key}": header[key]
                for key in ("schema", "run_id", "config_id", "args_canonical", "hardware_id",
                            "workload_id", "created", "cases")}
        flat["reference_engine_id"] = engine.get("id")
        flat["reference_engine_version"] = engine.get("version")
        flat["reference_engine_build"] = engine.get("build")
        return flat


def load_reference_bundle(path: Path | str) -> ReferenceBundle:
    """Read a bundle directory (or its manifest.json directly)."""
    target = Path(path)
    manifest = target if target.is_file() else target / MANIFEST_NAME
    if not manifest.is_file():
        raise FileNotFoundError(
            f"no {MANIFEST_NAME} in {target}: produce one with `atlas-bench t2i-reference` "
            "on the bf16 configuration of this box before running the fidelity suite."
        )
    meta = json.loads(manifest.read_text(encoding="utf-8"))
    if meta.get("schema") != BUNDLE_SCHEMA:
        raise ValueError(f"{manifest} is not a {BUNDLE_SCHEMA} bundle")
    items = {str(k): dict(v) for k, v in (meta.get("items") or {}).items()}
    return ReferenceBundle(manifest.parent, meta, items)


def lpips_distance(candidate: Path, reference: Path, net: str = "alex") -> float | None:
    """LPIPS between two images, or None when the package is not installed.

    Optional on purpose: it is the only metric here that needs torch and a downloaded
    network, and a PSNR/SSIM table with an empty LPIPS column is honest, while a table that
    silently dropped the cases it could not compute is not.
    """
    try:
        import lpips as lpips_lib
        import torch
    except ImportError:
        return None
    from PIL import Image

    model = _lpips_model(lpips_lib, net)

    def tensor(path: Path):
        with Image.open(path) as handle:
            import numpy as np

            array = np.asarray(handle.convert("RGB"), dtype="float32") / 255.0
        chw = torch.from_numpy(array).permute(2, 0, 1).unsqueeze(0)
        return chw * 2.0 - 1.0  # LPIPS wants [-1, 1]

    with torch.no_grad():
        return float(model(tensor(candidate), tensor(reference)).item())


_LPIPS_MODELS: dict[str, Any] = {}


def _lpips_model(lpips_lib: Any, net: str) -> Any:
    if net not in _LPIPS_MODELS:
        _LPIPS_MODELS[net] = lpips_lib.LPIPS(net=net)
    return _LPIPS_MODELS[net]


def score_fidelity(path: Path, row: Any, cfg: dict[str, Any] | None = None) -> ImageScore:
    cfg = cfg or {}
    bundle = cfg.get("reference_bundle")
    if bundle is None:
        return ImageScore(False, scored=False, detail="no reference bundle")

    item = bundle.item(row.id)
    reference_path = bundle.path_for(row.id)
    if item is None or reference_path is None or not reference_path.is_file():
        return ImageScore(False, scored=False, detail="reference-missing")

    want_digest = (getattr(row, "meta", {}) or {}).get("render_digest")
    if want_digest and item.get("render_digest") and item["render_digest"] != want_digest:
        return ImageScore(
            False, scored=False,
            detail=f"reference-digest-mismatch: bundle {item['render_digest']}, row {want_digest}",
        )

    candidate = load_image(path)
    reference = load_image(reference_path)
    if candidate.shape != reference.shape:
        return ImageScore(
            False, scored=False,
            detail=(f"size-mismatch: candidate {candidate.width}x{candidate.height}, "
                    f"reference {reference.width}x{reference.height}"),
        )

    metrics: dict[str, Any] = {
        "psnr": round(psnr(candidate, reference), 4),
        "ssim": round(ssim(candidate, reference), 6),
        "phash": phash(candidate),
        "reference_phash": item.get("phash"),
    }
    distance = hamming(str(metrics["phash"]), str(item.get("phash") or ""))
    if distance is not None:
        metrics["phash_hamming"] = distance
    mae = alpha_mae(candidate, reference)
    if mae is not None:
        metrics["alpha_mae"] = round(mae, 6)
    if cfg.get("lpips") != "off":
        value = lpips_distance(path, reference_path, str(cfg.get("lpips_net") or "alex"))
        metrics["lpips"] = round(value, 6) if value is not None else None

    psnr_min = float(cfg.get("psnr_min") or 0.0)
    ssim_min = float(cfg.get("ssim_min") or 0.0)
    reasons = []
    if metrics["psnr"] < psnr_min:
        reasons.append(f"psnr {metrics['psnr']:.2f} < {psnr_min:.2f}")
    if metrics["ssim"] < ssim_min:
        reasons.append(f"ssim {metrics['ssim']:.4f} < {ssim_min:.4f}")
    identical = metrics["psnr"] >= PSNR_MAX_DB
    return ImageScore(
        correct=not reasons,
        metrics=metrics,
        detail="; ".join(reasons) or ("identical to the reference" if identical
                                      else "within thresholds"),
    )
