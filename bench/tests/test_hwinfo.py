"""Hardware capture: parsing recorded tool output, sanitizing it and matching the registry."""

from __future__ import annotations

import json
from pathlib import Path

from atlas_bench.hwinfo import (
    GpuInfo,
    HostInfo,
    draft_hardware_file,
    fingerprint,
    match_hardware,
    parse_lscpu,
    parse_meminfo_gb,
    parse_nvidia_smi_q,
    parse_nvidia_smi_query,
    parse_os_release,
    parse_system_profiler,
    sanitize,
    suggest_id,
)
from atlas_bench.registry import Registry

FIXTURES = Path(__file__).parent / "fixtures"


def dgx_spark() -> HostInfo:
    """The DGX Spark (GB10) as the recorded tool output describes it."""
    info = HostInfo(platform="linux", arch="aarch64", kernel="6.11.0-1004-nvidia")
    info.gpus = parse_nvidia_smi_query((FIXTURES / "nvidia_smi_query_gb10.csv").read_text())
    detail = parse_nvidia_smi_q((FIXTURES / "nvidia_smi_q_gb10.txt").read_text())
    info.driver = detail["driver"]
    info.cuda = detail["cuda"]
    info.captured["nvidia_smi"] = sanitize(detail)
    lscpu = parse_lscpu((FIXTURES / "lscpu_grace.txt").read_text())
    info.captured["lscpu"] = lscpu
    info.cpu = lscpu["model_name"]
    info.cpu_cores = int(lscpu["cpus"])
    info.ram_gb = parse_meminfo_gb((FIXTURES / "proc_meminfo_grace.txt").read_text())
    info.os = parse_os_release((FIXTURES / "os_release_ubuntu.txt").read_text())
    info.tools = ["nvidia-smi", "lscpu"]
    return info


def m2_max() -> HostInfo:
    """The Mac Studio (M2 Max 32 GB) as ``system_profiler`` describes it."""
    hardware = parse_system_profiler((FIXTURES / "system_profiler_m2_max.json").read_text())
    info = HostInfo(platform="darwin", arch="arm64", kernel="25.5.0", os="macOS 26.5.2")
    info.captured["system_profiler"] = hardware
    info.apple_chip = hardware["chip_type"]
    info.cpu = "Apple M2 Max"
    info.cpu_cores = 12
    info.ram_gb = 32.0
    info.tools = ["system_profiler"]
    return info


# ---------------------------------------------------------------------- parsing


def test_parse_nvidia_smi_query() -> None:
    """``--query-gpu`` CSV gives name, driver, memory and power limit."""
    gpus = parse_nvidia_smi_query((FIXTURES / "nvidia_smi_query_gb10.csv").read_text())
    assert len(gpus) == 1
    assert gpus[0].name == "NVIDIA GB10"
    assert gpus[0].driver == "580.95.05"
    assert gpus[0].memory_total_mb == 131072
    assert gpus[0].power_limit_w == 140.0


def test_parse_nvidia_smi_q() -> None:
    """``nvidia-smi -q`` gives the CUDA version the CSV query does not carry."""
    parsed = parse_nvidia_smi_q((FIXTURES / "nvidia_smi_q_gb10.txt").read_text())
    assert parsed["driver"] == "580.95.05"
    assert parsed["cuda"] == "13.0"
    assert parsed["products"] == ["NVIDIA GB10"]
    assert parsed["fb_memory_total_mib"] == 131072.0
    assert parsed["power_limit_w"] == 140.0


def test_parse_system_profiler_drops_identifiers() -> None:
    """Serial numbers and UUIDs never leave the machine."""
    hardware = parse_system_profiler((FIXTURES / "system_profiler_m2_max.json").read_text())
    assert hardware["chip_type"] == "Apple M2 Max"
    assert hardware["physical_memory"] == "32 GB"
    assert hardware["machine_model"] == "Mac14,13"
    text = json.dumps(hardware).lower()
    for forbidden in ("serial", "uuid", "udid"):
        assert forbidden not in text


def test_sanitize_is_recursive() -> None:
    """Nested identifying keys are removed at any depth."""
    cleaned = sanitize(
        {"a": {"gpu_uuid": "x", "keep": 1}, "hostname": "box", "list": [{"serial_number": "y"}]}
    )
    assert cleaned == {"a": {"keep": 1}, "list": [{}]}


def test_parse_linux_sources() -> None:
    """lscpu, /proc/meminfo and /etc/os-release."""
    lscpu = parse_lscpu((FIXTURES / "lscpu_grace.txt").read_text())
    assert lscpu["model_name"] == "Cortex-X925"
    assert lscpu["cpus"] == "20"
    assert lscpu["bios_model_name"] == "NVIDIA Grace CPU"
    assert parse_meminfo_gb((FIXTURES / "proc_meminfo_grace.txt").read_text()) == 121.0
    assert (
        parse_os_release((FIXTURES / "os_release_ubuntu.txt").read_text()) == "Ubuntu 24.04.3 LTS"
    )


# ------------------------------------------------------------------ fingerprint


def test_fingerprint_is_stable_and_shaped() -> None:
    """``sha256:<64 hex>`` over the sanitized identity; equal machines hash equally."""
    a = fingerprint(dgx_spark())
    assert a.startswith("sha256:")
    assert len(a) == 71
    assert a == fingerprint(dgx_spark())
    assert a != fingerprint(m2_max())


def test_fingerprint_ignores_driver_and_kernel() -> None:
    """A driver update must not make the same box look like a new one."""
    info = dgx_spark()
    reference = fingerprint(info)
    info.driver = "999.99.99"
    info.cuda = "14.0"
    info.kernel = "6.99.0"
    assert fingerprint(info) == reference


def test_fingerprint_changes_with_memory() -> None:
    """A different memory configuration is a different machine."""
    info = m2_max()
    reference = fingerprint(info)
    info.ram_gb = 64.0
    assert fingerprint(info) != reference


# ---------------------------------------------------------------------- matching


def test_match_by_nvidia_name(atlas_repo) -> None:
    """A GPU name from ``nvidia-smi`` matches the registry ``detect`` rule."""
    registry = Registry(atlas_repo)
    info = HostInfo(platform="linux", arch="x86_64", cpu="AMD EPYC")
    info.gpus = [GpuInfo(name="Test GPU 24GB", memory_total_mb=24576)]
    matched, candidates = match_hardware(info, registry)
    assert matched == "test-gpu-24gb"
    assert candidates[0]["rules"] == ["nvidia_smi_name"]


def test_no_match_returns_none_not_a_guess(atlas_repo) -> None:
    """An unknown machine yields ``None`` — never a plausible-looking wrong id."""
    registry = Registry(atlas_repo)
    matched, candidates = match_hardware(m2_max(), registry)
    assert matched is None
    assert candidates == []


def test_detect_memory_rule_disambiguates(atlas_repo) -> None:
    """``detect.memory_gb`` (as the Apple SoC files use) is honoured too."""
    import json

    path = atlas_repo / "hardware" / "test-gpu-24gb.json"
    record = json.loads(path.read_text())
    record.pop("memory_gb")
    record["detect"]["memory_gb"] = 24
    path.write_text(json.dumps(record))

    registry = Registry(atlas_repo)
    info = HostInfo(platform="linux", arch="x86_64")
    info.gpus = [GpuInfo(name="Test GPU 24GB", memory_total_mb=24576)]
    assert match_hardware(info, registry)[0] == "test-gpu-24gb"


def test_memory_disambiguates_same_chip(atlas_repo) -> None:
    """A detect rule that fires but with the wrong memory size is rejected."""
    registry = Registry(atlas_repo)
    info = HostInfo(platform="linux", arch="x86_64")
    info.gpus = [GpuInfo(name="Test GPU 24GB", memory_total_mb=81920)]
    matched, candidates = match_hardware(info, registry)
    assert matched is None
    assert candidates[0]["memory_plausible"] is False


# ------------------------------------------------------------------------ draft


def test_draft_for_unregistered_apple_machine() -> None:
    """The draft is filled where we measured and null where we did not."""
    info = m2_max()
    assert suggest_id(info) == "apple-m2-max-32gb"
    draft = draft_hardware_file(info)
    assert draft["id"] == "apple-m2-max-32gb"
    assert draft["kind"] == "soc"
    assert draft["vendor"] == "apple"
    assert draft["memory_gb"] == 32
    assert draft["memory_bandwidth_gbs"] is None
    assert draft["detect"]["apple_chip"] == ["Apple M2 Max"]


def test_draft_for_unregistered_gpu() -> None:
    """A GPU box drafts as ``kind: gpu`` with the nvidia-smi name as the detect rule."""
    info = dgx_spark()
    draft = draft_hardware_file(info)
    assert draft["id"] == "nvidia-gb10"
    assert draft["kind"] == "gpu"
    assert draft["memory_gb"] == 128
    assert draft["detect"]["nvidia_smi_name"] == ["NVIDIA GB10"]
    assert draft["tdp_w"] == 140.0


def test_host_block_matches_the_result_schema_shape() -> None:
    """``result.hardware.host`` only carries the keys the schema allows."""
    block = dgx_spark().host_block()
    assert set(block) == {"cpu", "cpu_cores", "ram_gb", "os", "kernel", "arch"}
    assert block["ram_gb"] == 121.0
