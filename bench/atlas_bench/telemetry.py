"""Background power / memory / thermal sampling while a workload runs (SPEC §8).

On NVIDIA boxes we poll ``nvidia-smi --query-gpu=...`` once per second; on AMD ``rocm-smi``;
on macOS ``powermetrics`` needs root, so unless the harness already runs as root we record
``power_avg_w: null`` rather than guessing. Host RAM always comes from ``psutil``.

The sampler is a plain daemon thread — no event loop involvement — so it keeps sampling
while the async client is saturating the engine.
"""

from __future__ import annotations

import itertools
import os
import re
import shutil
import subprocess
import sys
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

__all__ = [
    "THERMAL_THROTTLE_MASK",
    "TelemetrySample",
    "TelemetrySampler",
    "parse_nvidia_smi_csv",
    "parse_powermetrics",
]

#: NVML ``clocks_throttle_reasons.active`` bits that mean "hot": HwSlowdown,
#: SwThermalSlowdown, HwThermalSlowdown.
THERMAL_THROTTLE_MASK = 0x08 | 0x20 | 0x40

_NVIDIA_QUERY = (
    "utilization.gpu,memory.used,power.draw,temperature.gpu,clocks_throttle_reasons.active"
)
_NA = {"", "n/a", "[n/a]", "not supported", "[not supported]", "unknown"}


@dataclass
class TelemetrySample:
    """One sampling tick."""

    t: float
    gpu_util_pct: float | None = None
    vram_used_gb: float | None = None
    power_w: float | None = None
    temp_c: float | None = None
    throttle_mask: int | None = None
    ram_used_gb: float | None = None

    @property
    def thermal_throttled(self) -> bool:
        """True when the driver reported a thermal or hardware slowdown."""
        return bool(self.throttle_mask and self.throttle_mask & THERMAL_THROTTLE_MASK)


def _number(text: str) -> float | None:
    """Parse an ``nvidia-smi`` CSV cell, mapping ``[N/A]``-style values to ``None``."""
    cleaned = text.strip()
    if cleaned.lower() in _NA:
        return None
    try:
        return float(cleaned)
    except ValueError:
        return None


def parse_nvidia_smi_csv(text: str, *, now: float = 0.0) -> TelemetrySample | None:
    """Aggregate one ``--query-gpu`` CSV block (one line per GPU) into a sample.

    Utilization and temperature are averaged/maxed over devices, memory and power summed —
    a multi-GPU box is measured as one system.
    """
    utils: list[float] = []
    vram_mb = 0.0
    vram_seen = False
    power = 0.0
    power_seen = False
    temps: list[float] = []
    mask = 0
    mask_seen = False
    for line in text.splitlines():
        if not line.strip():
            continue
        cells = [c.strip() for c in line.split(",")]
        if len(cells) < 5:
            continue
        util, mem, watt, temp, throttle = cells[:5]
        if (value := _number(util)) is not None:
            utils.append(value)
        if (value := _number(mem)) is not None:
            vram_mb += value
            vram_seen = True
        if (value := _number(watt)) is not None:
            power += value
            power_seen = True
        if (value := _number(temp)) is not None:
            temps.append(value)
        throttle_clean = throttle.strip().lower()
        if throttle_clean not in _NA:
            try:
                mask |= int(throttle_clean, 16 if throttle_clean.startswith("0x") else 10)
                mask_seen = True
            except ValueError:
                pass
    if not (utils or vram_seen or power_seen or temps or mask_seen):
        return None
    return TelemetrySample(
        t=now,
        gpu_util_pct=sum(utils) / len(utils) if utils else None,
        vram_used_gb=vram_mb / 1024 if vram_seen else None,
        power_w=power if power_seen else None,
        temp_c=max(temps) if temps else None,
        throttle_mask=mask if mask_seen else None,
    )


_POWERMETRICS_LINE = re.compile(
    r"Combined Power \(CPU \+ GPU \+ ANE\):\s*([\d.]+)\s*mW", re.IGNORECASE
)
_PACKAGE_LINE = re.compile(r"Package Power:\s*([\d.]+)\s*mW", re.IGNORECASE)


def parse_powermetrics(text: str) -> float | None:
    """Extract system power in watts from a ``powermetrics`` sample."""
    for pattern in (_POWERMETRICS_LINE, _PACKAGE_LINE):
        match = pattern.search(text)
        if match:
            return float(match.group(1)) / 1000.0
    return None


def _run(cmd: list[str], timeout: float = 5.0) -> str | None:
    """Run a short command, returning stdout or ``None`` on any failure."""
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, check=False)
    except (OSError, subprocess.SubprocessError):
        return None
    if proc.returncode != 0:
        return None
    return proc.stdout


class TelemetrySampler:
    """Samples GPU/host telemetry on a background thread while a workload runs."""

    def __init__(
        self,
        *,
        interval_s: float = 1.0,
        enabled: bool = True,
        sampler: Callable[[float], TelemetrySample | None] | None = None,
    ) -> None:
        self.interval_s = interval_s
        self.enabled = enabled
        self.samples: list[TelemetrySample] = []
        self.backend: str = "none"
        self._sampler = sampler or self._detect_backend()
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self._psutil = _import_psutil()

    # ---------------------------------------------------------------- backend

    def _detect_backend(self) -> Callable[[float], TelemetrySample | None]:
        """Pick the best available telemetry source for this machine."""
        if shutil.which("nvidia-smi"):
            self.backend = "nvidia-smi"
            return self._sample_nvidia
        if shutil.which("rocm-smi"):
            self.backend = "rocm-smi"
            return self._sample_rocm
        if sys.platform == "darwin" and self._powermetrics_available():
            self.backend = "powermetrics"
            return self._sample_powermetrics
        self.backend = "host-only" if sys.platform == "darwin" else "none"
        return self._sample_host_only

    @staticmethod
    def _powermetrics_available() -> bool:
        """``powermetrics`` needs root; we never prompt for a password."""
        return bool(shutil.which("powermetrics")) and os.geteuid() == 0

    def _sample_nvidia(self, now: float) -> TelemetrySample | None:
        out = _run(["nvidia-smi", f"--query-gpu={_NVIDIA_QUERY}", "--format=csv,noheader,nounits"])
        return parse_nvidia_smi_csv(out, now=now) if out else None

    def _sample_rocm(self, now: float) -> TelemetrySample | None:
        out = _run(["rocm-smi", "--showuse", "--showmemuse", "--showpower", "--showtemp", "--csv"])
        if not out:
            return None
        util: float | None = None
        power: float | None = None
        temp: float | None = None
        for line in out.splitlines():
            cells = [c.strip() for c in line.split(",")]
            if len(cells) >= 2 and cells[0].lower().startswith("card"):
                numbers = [v for v in (_number(c) for c in cells[1:]) if v is not None]
                if numbers:
                    util = numbers[0] if util is None else util
                    power = numbers[-1] if power is None else power
        return TelemetrySample(t=now, gpu_util_pct=util, power_w=power, temp_c=temp)

    def _sample_powermetrics(self, now: float) -> TelemetrySample | None:
        out = _run(
            ["powermetrics", "-n", "1", "-i", "200", "--samplers", "cpu_power,gpu_power"],
            timeout=10.0,
        )
        if not out:
            return None
        return TelemetrySample(t=now, power_w=parse_powermetrics(out))

    def _sample_host_only(self, now: float) -> TelemetrySample | None:
        return TelemetrySample(t=now)

    # ------------------------------------------------------------------ loop

    def start(self) -> None:
        """Start sampling (no-op when disabled)."""
        if not self.enabled or self._thread is not None:
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, name="atlas-telemetry", daemon=True)
        self._thread.start()

    def _loop(self) -> None:
        started = time.perf_counter()
        while not self._stop.is_set():
            now = time.perf_counter() - started
            try:
                sample = self._sampler(now)
            except Exception:  # pragma: no cover - telemetry must never kill a run
                sample = None
            if sample is None:
                sample = TelemetrySample(t=now)
            if self._psutil is not None:
                sample.ram_used_gb = self._psutil.virtual_memory().used / 1024**3
            self.samples.append(sample)
            self._stop.wait(self.interval_s)

    def stop(self) -> dict[str, Any]:
        """Stop sampling and return the summary merged into the metric block."""
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=self.interval_s * 3)
            self._thread = None
        return self.summary()

    def summary(self) -> dict[str, Any]:
        """Aggregate the collected samples into SPEC metric fields."""
        return summarize(self.samples)


def summarize(samples: list[TelemetrySample]) -> dict[str, Any]:
    """Aggregate telemetry samples into the SPEC power/memory/thermal fields."""
    out: dict[str, Any] = {
        "vram_peak_gb": None,
        "ram_peak_gb": None,
        "power_avg_w": None,
        "power_peak_w": None,
        "energy_wh": None,
        "gpu_util_avg_pct": None,
        "temp_max_c": None,
        "thermal_throttle_detected": None,
    }
    if not samples:
        return out
    vram = [s.vram_used_gb for s in samples if s.vram_used_gb is not None]
    ram = [s.ram_used_gb for s in samples if s.ram_used_gb is not None]
    power = [(s.t, s.power_w) for s in samples if s.power_w is not None]
    util = [s.gpu_util_pct for s in samples if s.gpu_util_pct is not None]
    temps = [s.temp_c for s in samples if s.temp_c is not None]
    masks = [s.throttle_mask for s in samples if s.throttle_mask is not None]

    if vram:
        out["vram_peak_gb"] = round(max(vram), 3)
    if ram:
        out["ram_peak_gb"] = round(max(ram), 3)
    if power:
        watts = [w for _, w in power]
        out["power_avg_w"] = round(sum(watts) / len(watts), 2)
        out["power_peak_w"] = round(max(watts), 2)
        out["energy_wh"] = round(_trapezoid_wh(power), 4)
    if util:
        out["gpu_util_avg_pct"] = round(sum(util) / len(util), 2)
    if temps:
        out["temp_max_c"] = round(max(temps), 2)
    if masks:
        out["thermal_throttle_detected"] = any(m & THERMAL_THROTTLE_MASK for m in masks)
    return out


def _trapezoid_wh(power: list[tuple[float, float]]) -> float:
    """Integrate a (seconds, watts) series into watt-hours."""
    if len(power) < 2:
        return 0.0
    joules = 0.0
    for (t0, w0), (t1, w1) in itertools.pairwise(power):
        joules += (w0 + w1) / 2 * max(t1 - t0, 0.0)
    return joules / 3600.0


def _import_psutil() -> Any | None:
    """psutil is a hard dependency, but telemetry must survive it being unavailable."""
    try:
        import psutil
    except ImportError:  # pragma: no cover - dependency is declared
        return None
    return psutil
