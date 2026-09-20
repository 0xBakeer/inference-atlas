"""OCR scorer: does the text in the picture say what the prompt asked for.

The backend is part of the measurement, not an implementation detail. Tesseract, RapidOCR
and EasyOCR disagree on exactly the images this suite is made of — small type, stylised
signage, Chinese next to Latin — so a score is only comparable to another score from the
same backend, and the name of the one that ran is recorded in the result.

Two numbers come out of every item. Whether every expected string is *there* decides
correct/incorrect, because a sign that says something else is wrong however elegantly it is
drawn. The character error rate sits next to it, because GOLDEN CRUMB BAKERV and a sign
with no letters at all are not the same failure, and a table of pass/fail alone cannot tell
them apart.
"""

from __future__ import annotations

import re
import shutil
import unicodedata
from pathlib import Path
from typing import Any

from . import ImageScore

__all__ = ["BACKENDS", "character_error_rate", "normalize", "read_text", "score_ocr"]

#: Tried in this order when the workload says `ocr_backend: auto`.
BACKENDS = ("tesseract", "rapidocr", "easyocr")

_WS_RE = re.compile(r"\s+")
_KEEP_RE = re.compile(r"[^\w\s]", re.UNICODE)


def normalize(text: str) -> str:
    """NFKC, casefold, drop punctuation, collapse whitespace.

    Deliberately not stripping spaces entirely: "FLATWHITE" is not what the menu was asked
    to say, and an OCR backend that runs words together should lose points for it.
    """
    folded = unicodedata.normalize("NFKC", text or "").casefold()
    return _WS_RE.sub(" ", _KEEP_RE.sub(" ", folded)).strip()


def _edit_distance(a: str, b: str) -> int:
    """Levenshtein distance, row by row."""
    if a == b:
        return 0
    if not a:
        return len(b)
    if not b:
        return len(a)
    previous = list(range(len(b) + 1))
    for i, ca in enumerate(a, start=1):
        current = [i]
        for j, cb in enumerate(b, start=1):
            current.append(min(previous[j] + 1, current[j - 1] + 1,
                               previous[j - 1] + (ca != cb)))
        previous = current
    return previous[-1]


def _best_substring_distance(haystack: str, needle: str) -> int:
    """Edit distance from `needle` to its closest substring of `haystack`.

    Plain edit distance against the whole OCR output would charge an image for every other
    word in it — a poster legitimately carries three strings and each is scored separately.
    Free start and free end positions is the standard approximate-substring variant: the
    first DP row is zeros and the answer is the minimum of the last.
    """
    if not needle:
        return 0
    if not haystack:
        return len(needle)
    previous = [0] * (len(haystack) + 1)
    for i, cn in enumerate(needle, start=1):
        current = [i]
        for j, ch in enumerate(haystack, start=1):
            current.append(min(previous[j] + 1, current[j - 1] + 1,
                               previous[j - 1] + (cn != ch)))
        previous = current
    return min(previous)


def character_error_rate(expected: str, text: str) -> float:
    """Edit distance to the closest matching region, over the expected length."""
    want, got = normalize(expected), normalize(text)
    if not want:
        return 0.0
    return min(1.0, _best_substring_distance(got, want) / len(want))


def _tesseract(path: Path, languages: list[str]) -> str:
    import pytesseract
    from PIL import Image

    with Image.open(path) as handle:
        return pytesseract.image_to_string(handle.convert("RGB"), lang="+".join(languages))


def _rapidocr(path: Path, languages: list[str]) -> str:
    from rapidocr_onnxruntime import RapidOCR

    result, _ = RapidOCR()(str(path))
    return "\n".join(line[1] for line in (result or []))


def _easyocr(path: Path, languages: list[str]) -> str:
    import easyocr

    codes = ["en" if lang.startswith("eng") else "ch_sim" if "chi" in lang else lang
             for lang in languages]
    return "\n".join(easyocr.Reader(codes, gpu=False).readtext(str(path), detail=0))


def _available(name: str) -> bool:
    if name == "tesseract":
        try:
            import pytesseract  # noqa: F401
        except ImportError:
            return False
        return shutil.which("tesseract") is not None
    module = {"rapidocr": "rapidocr_onnxruntime", "easyocr": "easyocr"}.get(name)
    if not module:
        return False
    try:
        __import__(module)
    except ImportError:
        return False
    return True


def read_text(path: Path, *, backend: str = "auto", languages: list[str] | None = None,
              reader: Any = None) -> tuple[str, str]:
    """Read an image with the named backend; returns `(text, backend that ran)`.

    `reader` is an injected callable — the tests use it, and so can anyone comparing a
    backend this module does not know about, as long as they record which one it was.
    """
    if reader is not None:
        return str(reader(path) or ""), "injected"
    languages = list(languages or ["eng"])
    candidates = [backend] if backend and backend != "auto" else list(BACKENDS)
    readers = {"tesseract": _tesseract, "rapidocr": _rapidocr, "easyocr": _easyocr}
    for name in candidates:
        if name not in readers:
            raise RuntimeError(f"unknown OCR backend {name!r}; known: {', '.join(BACKENDS)}")
        if not _available(name):
            if backend == "auto":
                continue
            raise RuntimeError(
                f"the {name} OCR backend is not installed on this machine"
                + (" (pytesseract is present but the tesseract binary is not)"
                   if name == "tesseract" else "")
            )
        return readers[name](path, languages), name
    raise RuntimeError(
        "no OCR backend is installed. pytesseract needs the tesseract binary; "
        "rapidocr-onnxruntime and easyocr are pure-Python wheels that pull onnxruntime or "
        "torch. Install one (uv pip install 'atlas-bench[ocr]') and name it in the "
        "workload's ocr_backend so the score says what read it."
    )


def score_ocr(path: Path, row: Any, cfg: dict[str, Any] | None = None) -> ImageScore:
    """Every expected string must be present after normalisation."""
    cfg = cfg or {}
    expected = list((getattr(row, "answer", None) or {}).get("strings") or [])
    if not expected:
        return ImageScore(False, scored=False, detail="no-expected-strings")
    try:
        text, backend = read_text(
            path,
            backend=str(cfg.get("ocr_backend") or "auto"),
            languages=list(cfg.get("ocr_languages") or ["eng"]),
            reader=cfg.get("ocr_reader"),
        )
    except RuntimeError as exc:
        return ImageScore(False, scored=False, detail=f"ocr-unavailable: {exc}"[:200])

    normalized = normalize(text)
    found = [want for want in expected if normalize(want) in normalized]
    rates = [character_error_rate(want, text) for want in expected]
    return ImageScore(
        correct=len(found) == len(expected),
        metrics={
            "ocr_strings_found": len(found),
            "ocr_strings_expected": len(expected),
            "ocr_exact": round(len(found) / len(expected), 6),
            "cer": round(sum(rates) / len(rates), 6),
            "cer_worst": round(max(rates), 6),
        },
        detail=f"backend={backend}",
        backend=backend,
    )
