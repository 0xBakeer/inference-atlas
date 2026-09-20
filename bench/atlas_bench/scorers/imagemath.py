"""The pixel arithmetic the image scorers share.

Pure numpy and Pillow, no torch: these run on the box that produced the images, which is a
Linux aarch64 CUDA machine, and adding a second deep-learning stack to compute a PSNR would
be a poor trade. LPIPS is the one metric that genuinely needs a network and it stays
optional (`atlas_bench.scorers.fidelity`).

Two conventions worth knowing before reading a number out of here:

* **PSNR of two identical images is infinite**, and infinity is not JSON. It is capped at
  `PSNR_MAX_DB` (100), which is far above anything a real pair of renders reaches.
* **Everything is computed on the RGB channels, alpha separately.** Compositing an RGBA
  image onto white before comparing would hide exactly the failure the transparency suite
  is looking for.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

__all__ = [
    "PSNR_MAX_DB",
    "LoadedImage",
    "alpha_mae",
    "alpha_stats",
    "component_count",
    "load_image",
    "phash",
    "psnr",
    "ssim",
]

#: What PSNR reports for two identical images, instead of an infinity no JSON can hold.
PSNR_MAX_DB = 100.0

#: Side of the DCT grid the perceptual hash is built from (8x8 = 64 bits).
_PHASH_SIDE = 8
_PHASH_IMAGE = 32


def _numpy():
    try:
        import numpy as np
    except ImportError as exc:  # pragma: no cover - environment without the extra
        raise RuntimeError(
            "image scoring needs numpy: uv pip install 'atlas-bench[images]'"
        ) from exc
    return np


def _pillow():
    """Pillow's Image module, with a message that names the extra when it is absent."""
    try:
        from PIL import Image as PILImage
    except ImportError as exc:  # pragma: no cover - environment without the extra
        raise RuntimeError(
            "image scoring needs Pillow: uv pip install 'atlas-bench[images]'"
        ) from exc
    return PILImage


@dataclass
class LoadedImage:
    """One image as arrays: RGB in [0,1], alpha in [0,1] or None when there is none."""

    rgb: Any
    alpha: Any | None
    width: int
    height: int
    mode: str

    @property
    def has_alpha(self) -> bool:
        return self.alpha is not None

    @property
    def shape(self) -> tuple[int, int]:
        return (self.width, self.height)


def load_image(path: Path | str) -> LoadedImage:
    """Read a PNG (or anything Pillow knows) without flattening its alpha channel."""
    np = _numpy()
    pil = _pillow()
    with pil.open(path) as handle:
        handle.load()
        mode = handle.mode
        has_alpha = mode in ("RGBA", "LA") or "transparency" in handle.info
        converted = handle.convert("RGBA" if has_alpha else "RGB")
        array = np.asarray(converted, dtype=np.float32) / 255.0
    if has_alpha:
        return LoadedImage(array[..., :3], array[..., 3], converted.width, converted.height, mode)
    return LoadedImage(array, None, converted.width, converted.height, mode)


def psnr(a: LoadedImage, b: LoadedImage) -> float:
    """Peak signal-to-noise ratio over the RGB channels, in dB, capped at PSNR_MAX_DB."""
    np = _numpy()
    mse = float(np.mean((a.rgb - b.rgb) ** 2))
    if mse <= 0:
        return PSNR_MAX_DB
    return min(PSNR_MAX_DB, float(10.0 * np.log10(1.0 / mse)))


def _gaussian_window(np, size: int = 11, sigma: float = 1.5):
    axis = np.arange(size, dtype=np.float64) - (size - 1) / 2.0
    line = np.exp(-(axis**2) / (2.0 * sigma**2))
    line /= line.sum()
    return np.outer(line, line)


def _filter2(np, image, window):
    """Valid-mode 2-D convolution with a small separable window, via strided views."""
    size = window.shape[0]
    height, width = image.shape
    if height < size or width < size:
        return None
    shape = (height - size + 1, width - size + 1, size, size)
    strides = image.strides * 2
    patches = np.lib.stride_tricks.as_strided(image, shape=shape, strides=strides)
    return np.einsum("ijkl,kl->ij", patches, window)


def ssim(a: LoadedImage, b: LoadedImage) -> float:
    """Mean SSIM on luminance, 11x11 Gaussian window, the standard constants.

    Luminance rather than per-channel: the three channels of a render are highly correlated
    and averaging three nearly identical numbers only makes the metric look more precise
    than it is. Two identical images give exactly 1.0.
    """
    np = _numpy()
    weights = np.array([0.2126, 0.7152, 0.0722], dtype=np.float64)
    x = (a.rgb.astype(np.float64) @ weights)
    y = (b.rgb.astype(np.float64) @ weights)
    window = _gaussian_window(np)
    mu_x, mu_y = _filter2(np, x, window), _filter2(np, y, window)
    if mu_x is None or mu_y is None:
        return float("nan")
    sigma_x = _filter2(np, x * x, window) - mu_x * mu_x
    sigma_y = _filter2(np, y * y, window) - mu_y * mu_y
    sigma_xy = _filter2(np, x * y, window) - mu_x * mu_y
    c1, c2 = 0.01**2, 0.03**2
    numerator = (2 * mu_x * mu_y + c1) * (2 * sigma_xy + c2)
    denominator = (mu_x**2 + mu_y**2 + c1) * (sigma_x + sigma_y + c2)
    return float(np.mean(numerator / denominator))


def alpha_mae(a: LoadedImage, b: LoadedImage) -> float | None:
    """Mean absolute error between two alpha channels, or None when either has none.

    An image with no alpha channel counts as fully opaque, so a lane that dropped the
    channel is compared as the opaque image it actually returned rather than skipped.
    """
    np = _numpy()
    if a.alpha is None and b.alpha is None:
        return None
    left = a.alpha if a.alpha is not None else np.ones_like(a.rgb[..., 0])
    right = b.alpha if b.alpha is not None else np.ones_like(b.rgb[..., 0])
    if left.shape != right.shape:
        return None
    return float(np.mean(np.abs(left - right)))


def alpha_stats(image: LoadedImage, *, ambiguous: tuple[float, float] = (0.1, 0.9)) -> dict:
    """Transparent share, opaque share and the ambiguous band between them.

    The ambiguous band is the interesting one: a real generated alpha channel is mostly 0
    or 1 with a thin antialiased edge, while an alpha inferred by background removal leaves
    a wide grey halo, and that shows up here as a percent or two instead of a fraction of
    one.
    """
    np = _numpy()
    if image.alpha is None:
        return {"has_alpha": False, "transparent_fraction": 0.0, "opaque_fraction": 1.0,
                "ambiguous_fraction": 0.0, "histogram": None}
    alpha = image.alpha
    low, high = ambiguous
    histogram = np.histogram(alpha, bins=16, range=(0.0, 1.0))[0]
    total = alpha.size
    return {
        "has_alpha": True,
        "transparent_fraction": float(np.count_nonzero(alpha <= 0.01) / total),
        "opaque_fraction": float(np.count_nonzero(alpha >= 0.99) / total),
        "ambiguous_fraction": float(np.count_nonzero((alpha > low) & (alpha < high)) / total),
        "histogram": [int(v) for v in histogram],
    }


def component_count(
    image: LoadedImage, *, threshold: float = 0.5, min_fraction: float = 0.001,
    max_side: int = 512,
) -> tuple[int, float]:
    """Connected components of the opaque region: `(count, largest fraction)`.

    Four-connected, on a mask downsampled to at most `max_side` on the long side — the
    question is "is this one subject or a field of speckles", which survives downsampling,
    and a 2048x2048 mask does not need to be walked pixel by pixel to answer it. Components
    smaller than `min_fraction` of the mask are dropped first, which is what stops a few
    stray antialiased pixels from being counted as a second subject.
    """
    np = _numpy()
    if image.alpha is None:
        return (1, 1.0)
    mask = image.alpha >= threshold
    if mask.ndim != 2:
        return (0, 0.0)
    scale = max(1, int(max(mask.shape) / max_side))
    if scale > 1:
        height = (mask.shape[0] // scale) * scale
        width = (mask.shape[1] // scale) * scale
        mask = mask[:height, :width].reshape(
            height // scale, scale, width // scale, scale
        ).any(axis=(1, 3))
    opaque = int(np.count_nonzero(mask))
    if opaque == 0:
        return (0, 0.0)

    # Two-pass labelling with union-find: one row-wise vectorized pass to give every run an
    # id, then a merge of runs that touch the row above.
    labels = np.zeros(mask.shape, dtype=np.int32)
    parent: list[int] = [0]

    def find(x: int) -> int:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a: int, b: int) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[max(ra, rb)] = min(ra, rb)

    next_label = 1
    for y in range(mask.shape[0]):
        row = mask[y]
        for x in np.flatnonzero(row):
            left = labels[y, x - 1] if x > 0 else 0
            up = labels[y - 1, x] if y > 0 else 0
            if left and up:
                labels[y, x] = min(left, up)
                union(int(left), int(up))
            elif left or up:
                labels[y, x] = left or up
            else:
                labels[y, x] = next_label
                parent.append(next_label)
                next_label += 1

    flat = labels.ravel()
    roots = np.array([find(int(i)) for i in range(next_label)], dtype=np.int32)
    resolved = roots[flat]
    counts = np.bincount(resolved)
    counts[0] = 0
    sizes = counts[counts > 0]
    if sizes.size == 0:
        return (0, 0.0)
    total = float(mask.size)
    kept = sizes[sizes >= max(1.0, min_fraction * total)]
    return (int(kept.size), float(sizes.max() / total))


def phash(image: LoadedImage) -> str:
    """64-bit perceptual hash of the luminance, as 16 hex characters.

    The only thing about a generated image this repository ever publishes. It is enough to
    say "these two runs produced the same picture" or "these two boxes disagree about what
    bf16 does here", and not enough to reconstruct anything: 64 bits of a 32x32 DCT.
    """
    np = _numpy()
    weights = np.array([0.2126, 0.7152, 0.0722], dtype=np.float64)
    grey = image.rgb.astype(np.float64) @ weights
    pil = _pillow()
    small = np.asarray(
        pil.fromarray((grey * 255).astype("uint8"), "L").resize(
            (_PHASH_IMAGE, _PHASH_IMAGE), pil.LANCZOS
        ),
        dtype=np.float64,
    )
    basis = np.cos(
        (2 * np.arange(_PHASH_IMAGE)[:, None] + 1)
        * np.arange(_PHASH_IMAGE)[None, :]
        * np.pi
        / (2 * _PHASH_IMAGE)
    )
    dct = basis.T @ small @ basis
    block = dct[:_PHASH_SIDE, :_PHASH_SIDE]
    median = np.median(block[1:, 1:])  # the DC term would swamp the median
    bits = (block > median).ravel()
    value = 0
    for bit in bits:
        value = (value << 1) | int(bit)
    return f"{value:016x}"


def hamming(left: str, right: str) -> int | None:
    """Bit distance between two hex hashes, or None when either is missing."""
    if not left or not right or len(left) != len(right):
        return None
    return bin(int(left, 16) ^ int(right, 16)).count("1")
