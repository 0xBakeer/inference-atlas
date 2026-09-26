"""The image metrics, on images the test draws itself.

Every input here is synthetic and every expected value is one the maths pins: PSNR of an
image against itself is the cap, SSIM of an image against itself is exactly 1, the alpha
MAE between a half-transparent and a fully opaque image is 0.5. The OCR and CLIP backends
are injected rather than installed — what is tested is the scoring, not tesseract.
"""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest

from atlas_bench.scorers import ImageScore, get_image_scorer, is_image_scorer
from atlas_bench.scorers.fidelity import BUNDLE_SCHEMA, load_reference_bundle, score_fidelity
from atlas_bench.scorers.imagemath import (
    PSNR_MAX_DB,
    alpha_mae,
    alpha_stats,
    component_count,
    hamming,
    load_image,
    phash,
    psnr,
    ssim,
)
from atlas_bench.scorers.ocr import character_error_rate, normalize, score_ocr
from atlas_bench.scorers.rgba import score_rgba

pytestmark = pytest.mark.filterwarnings("ignore::DeprecationWarning")


def draw(path: Path, *, size: int = 64, alpha: int | None = None, shift: int = 0,
         blobs: int = 1) -> Path:
    """A small flat picture: a coloured square, optionally with an alpha channel."""
    from PIL import Image, ImageDraw

    mode = "RGBA" if alpha is not None else "RGB"
    background = (0, 0, 0, 0) if alpha is not None else (12, 24, 48)
    image = Image.new(mode, (size, size), background)
    drawer = ImageDraw.Draw(image)
    fill = (200, 120 + shift, 60, alpha) if alpha is not None else (200, 120 + shift, 60)
    for index in range(blobs):
        left = 6 + index * 22
        drawer.rectangle((left, 10, left + 12, 30), fill=fill)
    image.save(path)
    return path


def row(**fields) -> SimpleNamespace:
    base = {"id": "t2i-0001", "answer": None, "scorer": "ocr", "category": "text",
            "difficulty": "easy", "meta": {}}
    return SimpleNamespace(**{**base, **fields})


# ------------------------------------------------------------------ fidelity maths


def test_psnr_of_identical_images_is_capped(tmp_path: Path) -> None:
    image = load_image(draw(tmp_path / "a.png"))
    assert psnr(image, image) == PSNR_MAX_DB


def test_psnr_falls_as_the_images_diverge(tmp_path: Path) -> None:
    a = load_image(draw(tmp_path / "a.png"))
    near = load_image(draw(tmp_path / "b.png", shift=2))
    far = load_image(draw(tmp_path / "c.png", shift=90))
    assert PSNR_MAX_DB > psnr(a, near) > psnr(a, far) > 0


def test_ssim_of_identical_images_is_one(tmp_path: Path) -> None:
    image = load_image(draw(tmp_path / "a.png"))
    assert ssim(image, image) == pytest.approx(1.0, abs=1e-9)


def test_ssim_falls_on_a_structural_change(tmp_path: Path) -> None:
    a = load_image(draw(tmp_path / "a.png"))
    b = load_image(draw(tmp_path / "b.png", blobs=2))
    assert 0.0 <= ssim(a, b) < 0.99


def test_alpha_mae(tmp_path: Path) -> None:
    half = load_image(draw(tmp_path / "half.png", alpha=128, size=32))
    opaque = load_image(draw(tmp_path / "opaque.png", alpha=255, size=32))
    assert alpha_mae(half, half) == 0.0
    # The squares are 13x21 of 32x32; only they differ, and there by 127/255.
    assert 0.0 < alpha_mae(half, opaque) < 0.5
    rgb = load_image(draw(tmp_path / "rgb.png"))
    assert alpha_mae(rgb, rgb) is None, "no alpha on either side is not a zero error"


def test_alpha_stats_and_components(tmp_path: Path) -> None:
    image = load_image(draw(tmp_path / "two.png", alpha=255, size=64, blobs=2))
    stats = alpha_stats(image)
    assert stats["has_alpha"] is True
    assert stats["transparent_fraction"] > 0.8
    assert stats["ambiguous_fraction"] < 0.05
    count, largest = component_count(image)
    assert count == 2 and 0.0 < largest < 0.2

    one = load_image(draw(tmp_path / "one.png", alpha=255, size=64, blobs=1))
    assert component_count(one)[0] == 1


def test_phash_is_stable_and_discriminating(tmp_path: Path) -> None:
    a = phash(load_image(draw(tmp_path / "a.png", size=128)))
    again = phash(load_image(draw(tmp_path / "a2.png", size=128)))
    other = phash(load_image(draw(tmp_path / "b.png", size=128, blobs=3)))
    assert len(a) == 16 and a == again
    assert hamming(a, again) == 0
    assert hamming(a, other) > 0


# ------------------------------------------------------------------ OCR


def test_normalisation_folds_case_and_punctuation() -> None:
    assert normalize("Golden Crumb Bakery!") == "golden crumb bakery"
    assert normalize("ESPRESSO  2.50") == "espresso 2 50"


def test_character_error_rate_ignores_surrounding_text() -> None:
    assert character_error_rate("HARBOUR ROAD 12", "noise HARBOUR ROAD 12 more noise") == 0.0
    assert 0.0 < character_error_rate("HARBOUR ROAD 12", "HARBOUR ROAD 13") < 0.2
    assert character_error_rate("HARBOUR ROAD 12", "") == 1.0


def test_ocr_scorer_requires_every_string(tmp_path: Path) -> None:
    path = draw(tmp_path / "sign.png")
    item = row(answer={"strings": ["GOLDEN CRUMB BAKERY", "OPEN 7 AM TO 6 PM"]})

    good = score_ocr(path, item, {"ocr_reader": lambda _p: "golden crumb bakery\nopen 7 am to 6 pm"})
    assert good.correct and good.metrics["ocr_exact"] == 1.0 and good.metrics["cer"] == 0.0

    partial = score_ocr(path, item, {"ocr_reader": lambda _p: "GOLDEN CRUMB BAKERY"})
    assert not partial.correct
    assert partial.metrics["ocr_strings_found"] == 1
    # The missing line still shares a few letters with what was read, so its CER is high
    # rather than exactly 1 — which is the point of reporting a rate instead of a flag.
    assert partial.metrics["cer_worst"] > 0.5
    assert partial.backend == "injected"


def test_ocr_scorer_without_a_backend_is_unscored(tmp_path: Path) -> None:
    path = draw(tmp_path / "sign.png")
    item = row(answer={"strings": ["ANYTHING"]})
    result = score_ocr(path, item, {"ocr_backend": "tesseract", "ocr_reader": None})
    # No tesseract on this machine: unscored with a reason, never a wrong answer.
    if not result.scored:
        assert "ocr-unavailable" in (result.detail or "")
    else:  # a machine that does have it must still produce a verdict and a CER
        assert "cer" in result.metrics


# ------------------------------------------------------------------ transparency


def test_rgba_scorer_passes_a_clean_sticker(tmp_path: Path) -> None:
    path = draw(tmp_path / "fox.png", alpha=255, size=64, blobs=1)
    item = row(scorer="rgba", answer={"transparent_background": True,
                                      "min_transparent_fraction": 0.25,
                                      "max_components": 1,
                                      "max_ambiguous_fraction": 0.08})
    score = score_rgba(path, item, {})
    assert score.correct and score.metrics["components"] == 1
    assert score.metrics["has_alpha"] == 1


def test_rgba_scorer_fails_an_image_with_no_alpha(tmp_path: Path) -> None:
    path = draw(tmp_path / "flat.png")
    item = row(scorer="rgba", answer={"min_transparent_fraction": 0.25, "max_components": 1})
    score = score_rgba(path, item, {})
    assert score.scored and not score.correct
    assert "no alpha channel" in (score.detail or "")


def test_rgba_scorer_fails_too_many_components(tmp_path: Path) -> None:
    path = draw(tmp_path / "speckles.png", alpha=255, size=64, blobs=3)
    item = row(scorer="rgba", answer={"min_transparent_fraction": 0.25, "max_components": 1})
    score = score_rgba(path, item, {})
    assert not score.correct and "components" in (score.detail or "")


# ------------------------------------------------------------------ CLIP


def test_clip_scorer_uses_the_injected_encoder(tmp_path: Path) -> None:
    from atlas_bench.scorers.clip import score_clip

    path = draw(tmp_path / "a.png")
    item = row(scorer="clip", answer="a die-cut sticker of a sitting fox")
    good = score_clip(path, item, {"clip_encoder": lambda _p, _t: 0.31, "clipscore_min": 26.0})
    assert good.correct and good.metrics["clipscore"] == 31.0
    weak = score_clip(path, item, {"clip_encoder": lambda _p, _t: 0.12, "clipscore_min": 26.0})
    assert not weak.correct and weak.metrics["clipscore"] == 12.0
    negative = score_clip(path, item, {"clip_encoder": lambda _p, _t: -0.4})
    assert negative.metrics["clipscore"] == 0.0, "cosine is clamped at zero, as CLIPScore is"


# ------------------------------------------------------------------ fidelity scorer


def bundle_at(tmp_path: Path, *, digest: str = "deadbeefdeadbeef", size: int = 64) -> Path:
    import json

    root = tmp_path / "bundle"
    (root / "images").mkdir(parents=True)
    reference = draw(root / "images" / "t2i-0001.png", size=size)
    (root / "manifest.json").write_text(json.dumps({
        "schema": BUNDLE_SCHEMA,
        "run_id": "abc--eval-t2i-fidelity-v1--0000aa",
        "config_id": "0123456789abcdef",
        "items": {"t2i-0001": {
            "file": "images/t2i-0001.png",
            "sha256": "x",
            "phash": phash(load_image(reference)),
            "render_digest": digest,
        }},
    }), encoding="utf-8")
    return root


def fidelity_row(digest: str = "deadbeefdeadbeef") -> SimpleNamespace:
    return row(scorer="fidelity", answer={"reference": "bf16-same-box"},
               meta={"render_digest": digest})


def test_fidelity_scores_an_identical_render_as_perfect(tmp_path: Path) -> None:
    bundle = load_reference_bundle(bundle_at(tmp_path))
    candidate = draw(tmp_path / "candidate.png")
    score = score_fidelity(candidate, fidelity_row(),
                           {"reference_bundle": bundle, "psnr_min": 30.0, "ssim_min": 0.9,
                            "lpips": "off"})
    assert score.correct
    assert score.metrics["psnr"] == PSNR_MAX_DB and score.metrics["ssim"] == pytest.approx(1.0)
    assert score.metrics["phash_hamming"] == 0
    assert "lpips" not in score.metrics


def test_fidelity_fails_a_drifted_render(tmp_path: Path) -> None:
    bundle = load_reference_bundle(bundle_at(tmp_path))
    candidate = draw(tmp_path / "candidate.png", shift=90, blobs=2)
    score = score_fidelity(candidate, fidelity_row(),
                           {"reference_bundle": bundle, "psnr_min": 30.0, "ssim_min": 0.9,
                            "lpips": "off"})
    assert score.scored and not score.correct
    assert score.metrics["psnr"] < 30.0


def test_fidelity_refuses_a_reference_from_another_spec(tmp_path: Path) -> None:
    bundle = load_reference_bundle(bundle_at(tmp_path, digest="0000000000000000"))
    score = score_fidelity(draw(tmp_path / "c.png"), fidelity_row(),
                           {"reference_bundle": bundle, "lpips": "off"})
    assert not score.scored and "digest-mismatch" in (score.detail or "")


def test_fidelity_refuses_a_size_mismatch(tmp_path: Path) -> None:
    bundle = load_reference_bundle(bundle_at(tmp_path, size=32))
    score = score_fidelity(draw(tmp_path / "c.png", size=64), fidelity_row(),
                           {"reference_bundle": bundle, "lpips": "off"})
    assert not score.scored and "size-mismatch" in (score.detail or "")


def test_fidelity_without_a_bundle_is_unscored(tmp_path: Path) -> None:
    score = score_fidelity(draw(tmp_path / "c.png"), fidelity_row(), {})
    assert not score.scored and score.detail == "no reference bundle"


def test_missing_bundle_directory_says_how_to_make_one(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError, match="t2i-reference"):
        load_reference_bundle(tmp_path / "nowhere")


# ------------------------------------------------------------------ registry


def test_image_scorers_are_registered_separately_from_text_ones() -> None:
    assert is_image_scorer("fidelity") and is_image_scorer("rgba")
    assert not is_image_scorer("exact") and not is_image_scorer(None)
    assert callable(get_image_scorer("ocr"))
    with pytest.raises(KeyError):
        get_image_scorer("numeric")


def test_image_score_defaults() -> None:
    score = ImageScore(True)
    assert score.metrics == {} and score.scored and score.backend is None
