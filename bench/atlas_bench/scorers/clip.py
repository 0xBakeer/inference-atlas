"""CLIPScore: does the picture show what was asked for.

A weak measure used deliberately. It separates a picture of the wrong thing from a picture
of the right thing, which is what catches a quantization that has stopped following the
prompt rather than merely become softer, and it cannot tell two good lanes apart — two
scores a point from each other mean nothing and the workload notes say so.

The text side is the row's short prompt, not the full descriptive one: CLIP truncates at 77
tokens and scoring a picture against a sentence cut off mid-clause measures the truncation.

Two backends, both pure Python wheels on aarch64, both pulling torch: `open_clip` (the
reference implementation of the metric) and `transformers` CLIP. The backbone is part of
the number — ViT-L-14/openai is the default and another one is a different scale.
"""

from __future__ import annotations

import functools
from pathlib import Path
from typing import Any

from . import ImageScore

__all__ = ["clipscore", "score_clip"]

DEFAULT_MODEL = "ViT-L-14"
DEFAULT_PRETRAINED = "openai"


@functools.lru_cache(maxsize=2)
def _open_clip(model: str, pretrained: str):
    import open_clip
    import torch

    net, _, preprocess = open_clip.create_model_and_transforms(model, pretrained=pretrained)
    net.eval()
    tokenizer = open_clip.get_tokenizer(model)

    def encode(path: Path, text: str) -> float:
        from PIL import Image

        with Image.open(path) as handle:
            pixels = preprocess(handle.convert("RGB")).unsqueeze(0)
        with torch.no_grad():
            image_features = net.encode_image(pixels)
            text_features = net.encode_text(tokenizer([text]))
        image_features /= image_features.norm(dim=-1, keepdim=True)
        text_features /= text_features.norm(dim=-1, keepdim=True)
        return float((image_features @ text_features.T).item())

    return encode


@functools.lru_cache(maxsize=2)
def _transformers_clip(model: str):
    import torch
    from transformers import CLIPModel, CLIPProcessor

    net = CLIPModel.from_pretrained(model)
    net.eval()
    processor = CLIPProcessor.from_pretrained(model)

    def encode(path: Path, text: str) -> float:
        from PIL import Image

        with Image.open(path) as handle:
            inputs = processor(text=[text], images=handle.convert("RGB"), return_tensors="pt",
                               padding=True, truncation=True)
        with torch.no_grad():
            image_features = net.get_image_features(pixel_values=inputs["pixel_values"])
            text_features = net.get_text_features(
                input_ids=inputs["input_ids"], attention_mask=inputs.get("attention_mask")
            )
        image_features = image_features / image_features.norm(dim=-1, keepdim=True)
        text_features = text_features / text_features.norm(dim=-1, keepdim=True)
        return float((image_features @ text_features.T).item())

    return encode


def clipscore(path: Path, text: str, cfg: dict[str, Any] | None = None) -> float:
    """100 * max(cosine(image, text), 0) — the published CLIPScore scaling."""
    cfg = cfg or {}
    injected = cfg.get("clip_encoder")
    if injected is not None:
        cosine = float(injected(path, text))
    else:
        backend = str(cfg.get("clip_backend") or "open_clip")
        model = str(cfg.get("clip_model") or DEFAULT_MODEL)
        if backend == "open_clip":
            encode = _open_clip(model, str(cfg.get("clip_pretrained") or DEFAULT_PRETRAINED))
        elif backend == "transformers":
            encode = _transformers_clip(
                str(cfg.get("clip_model") or "openai/clip-vit-large-patch14")
            )
        else:
            raise RuntimeError(f"unknown CLIP backend {backend!r}: open_clip or transformers")
        cosine = encode(path, text)
    return round(100.0 * max(cosine, 0.0), 4)


def score_clip(path: Path, row: Any, cfg: dict[str, Any] | None = None) -> ImageScore:
    cfg = cfg or {}
    meta = getattr(row, "meta", None) or {}
    text = getattr(row, "answer", None) or meta.get("short_prompt")
    if not isinstance(text, str) or not text.strip():
        return ImageScore(False, scored=False, detail="no text to score against")
    try:
        score = clipscore(path, text, cfg)
    except (ImportError, RuntimeError, OSError) as exc:
        return ImageScore(False, scored=False, detail=f"clip-unavailable: {exc}"[:200])
    threshold = float(cfg.get("clipscore_min") or 0.0)
    return ImageScore(
        correct=score >= threshold,
        metrics={"clipscore": score, "clipscore_min": threshold},
        detail=f"backend={cfg.get('clip_backend') or 'open_clip'}",
        backend=str(cfg.get("clip_backend") or "open_clip"),
    )
