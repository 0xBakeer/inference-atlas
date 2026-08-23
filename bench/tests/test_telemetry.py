"""Telemetry sampling and aggregation."""

from __future__ import annotations

from pathlib import Path

from atlas_bench.telemetry import (
    TelemetrySample,
    TelemetrySampler,
    parse_nvidia_smi_csv,
    parse_powermetrics,
    summarize,
)

FIXTURES = Path(__file__).parent / "fixtures"


def test_parse_query_gpu_line() -> None:
    """One GPU: utilization, VRAM, power, temperature and the throttle mask."""
    sample = parse_nvidia_smi_csv((FIXTURES / "nvidia_smi_telemetry_gb10.csv").read_text())
    assert sample is not None
    assert sample.gpu_util_pct == 97
    assert sample.vram_used_gb == 51500 / 1024
    assert sample.power_w == 110.42
    assert sample.temp_c == 71
    assert sample.thermal_throttled is False


def test_parse_multi_gpu_aggregates() -> None:
    """Two GPUs are one system: memory and power sum, temperature maxes."""
    text = "50, 1024, 100.0, 60, 0x0\n70, 2048, 150.0, 80, 0x0\n"
    sample = parse_nvidia_smi_csv(text)
    assert sample is not None
    assert sample.gpu_util_pct == 60
    assert sample.vram_used_gb == 3072 / 1024
    assert sample.power_w == 250.0
    assert sample.temp_c == 80


def test_thermal_throttle_bits() -> None:
    """SwThermal|HwThermal|HwSlowdown mean the numbers are throttled."""
    text = (FIXTURES / "nvidia_smi_telemetry_throttled.csv").read_text()
    first = parse_nvidia_smi_csv(text.splitlines()[0])
    assert first is not None and first.thermal_throttled is True
    second = parse_nvidia_smi_csv(text.splitlines()[1])
    assert second is not None and second.thermal_throttled is False


def test_not_supported_cells_become_none() -> None:
    """``[N/A]`` is missing data, not zero."""
    sample = parse_nvidia_smi_csv("[N/A], 1024, [Not Supported], 60, [N/A]")
    assert sample is not None
    assert sample.gpu_util_pct is None
    assert sample.power_w is None
    assert sample.vram_used_gb == 1.0
    assert sample.throttle_mask is None


def test_parse_powermetrics() -> None:
    """macOS power comes from the combined CPU+GPU+ANE line, in watts."""
    text = "Combined Power (CPU + GPU + ANE): 15320 mW\n"
    assert parse_powermetrics(text) == 15.32
    assert parse_powermetrics("nothing here") is None


def test_summarize_peaks_and_energy() -> None:
    """Peaks, averages and a trapezoid energy integral."""
    samples = [
        TelemetrySample(
            t=0.0,
            gpu_util_pct=50,
            vram_used_gb=10,
            power_w=100,
            temp_c=60,
            throttle_mask=0,
            ram_used_gb=8,
        ),
        TelemetrySample(
            t=1.0,
            gpu_util_pct=100,
            vram_used_gb=20,
            power_w=200,
            temp_c=70,
            throttle_mask=0,
            ram_used_gb=9,
        ),
    ]
    summary = summarize(samples)
    assert summary["vram_peak_gb"] == 20
    assert summary["ram_peak_gb"] == 9
    assert summary["power_avg_w"] == 150
    assert summary["power_peak_w"] == 200
    assert summary["gpu_util_avg_pct"] == 75
    assert summary["temp_max_c"] == 70
    assert summary["thermal_throttle_detected"] is False
    # 150 W average over 1 s = 150 J = 0.0417 Wh
    assert summary["energy_wh"] == 0.0417


def test_summarize_without_samples() -> None:
    """No telemetry means null fields, never zeros that look like measurements."""
    summary = summarize([])
    assert set(summary.values()) == {None}


def test_sampler_thread_collects_and_stops() -> None:
    """The background sampler runs, collects and shuts down cleanly."""
    ticks = []

    def fake_sampler(now: float) -> TelemetrySample:
        ticks.append(now)
        return TelemetrySample(t=now, power_w=10.0, vram_used_gb=1.0)

    sampler = TelemetrySampler(interval_s=0.01, sampler=fake_sampler)
    sampler.start()
    while len(ticks) < 3:
        pass
    summary = sampler.stop()
    assert summary["power_avg_w"] == 10.0
    assert summary["vram_peak_gb"] == 1.0
    assert sampler._thread is None


def test_disabled_sampler_does_nothing() -> None:
    """``--no-telemetry`` must not spawn a thread or invent numbers."""
    sampler = TelemetrySampler(enabled=False)
    sampler.start()
    assert sampler.stop()["power_avg_w"] is None
