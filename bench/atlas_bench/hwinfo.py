"""Truthful hardware capture (SPEC §7.2, §8).

Nobody types hardware specs by hand. ``atlas-bench hwinfo`` shells out to the tools the
machine already has (``nvidia-smi``, ``rocm-smi``, ``system_profiler``, ``lscpu``,
``/proc/meminfo``), sanitizes the output (serial numbers, UUIDs and host names never leave
the machine), computes a stable fingerprint and matches the box against the ``detect``
rules of ``hardware/*.json``.

When nothing matches we print ``null`` plus a ready-to-fill draft registry file — a wrong
``hardware_id`` is worse than a missing one, so the harness never guesses.
"""

from __future__ import annotations

import json
import platform
import re
import shutil
import subprocess
import sys
from dataclasses import asdict, dataclass, field
from typing import Any

from .ids import sha256_hex, slugify_id
from .registry import Registry

__all__ = [
    "SENSITIVE_KEY_RE",
    "GpuInfo",
    "HostInfo",
    "collect",
    "draft_hardware_file",
    "fingerprint",
    "match_hardware",
    "parse_lscpu",
    "parse_meminfo_gb",
    "parse_nvidia_smi_q",
    "parse_nvidia_smi_query",
    "parse_os_release",
    "parse_system_profiler",
]

#: Keys removed from any captured blob before it is written to a result file.
SENSITIVE_KEY_RE = re.compile(
    r"serial|uuid|udid|hostname|host_name|mac_address|ip_address|user|owner|license",
    re.IGNORECASE,
)

_NVIDIA_QUERY_FIELDS = ("name", "driver_version", "memory.total", "power.limit")


@dataclass
class GpuInfo:
    """One accelerator as reported by the vendor tool."""

    name: str
    memory_total_mb: float | None = None
    driver: str | None = None
    power_limit_w: float | None = None
    vendor: str = "nvidia"


@dataclass
class HostInfo:
    """Sanitized description of the machine the benchmark runs on."""

    platform: str = ""
    arch: str = ""
    os: str = ""
    kernel: str = ""
    cpu: str = ""
    cpu_cores: int | None = None
    ram_gb: float | None = None
    gpus: list[GpuInfo] = field(default_factory=list)
    driver: str | None = None
    cuda: str | None = None
    apple_chip: str | None = None
    captured: dict[str, Any] = field(default_factory=dict)
    tools: list[str] = field(default_factory=list)

    @property
    def gpu_count(self) -> int:
        """Number of accelerators found (0 on a CPU/SoC-only box)."""
        return len(self.gpus)

    @property
    def gpu_names(self) -> list[str]:
        """Names of the accelerators found."""
        return [g.name for g in self.gpus]

    def to_dict(self) -> dict[str, Any]:
        """JSON-ready dictionary (what ``hwinfo --json`` prints)."""
        data = asdict(self)
        data["gpu_count"] = self.gpu_count
        data["fingerprint"] = fingerprint(self)
        return data

    def host_block(self) -> dict[str, Any]:
        """The ``result.hardware.host`` block of SPEC §4."""
        return {
            "cpu": self.cpu or None,
            "cpu_cores": self.cpu_cores,
            "ram_gb": round(self.ram_gb, 1) if self.ram_gb else None,
            "os": self.os or None,
            "kernel": self.kernel or None,
            "arch": self.arch or None,
        }


# --------------------------------------------------------------------- parsers


def parse_nvidia_smi_query(text: str) -> list[GpuInfo]:
    """Parse ``nvidia-smi --query-gpu=name,driver_version,memory.total,power.limit``.

    Expects ``--format=csv,noheader,nounits``.
    """
    gpus: list[GpuInfo] = []
    for line in text.splitlines():
        if not line.strip():
            continue
        cells = [c.strip() for c in line.split(",")]
        if not cells or not cells[0]:
            continue
        memory = _float(cells[2]) if len(cells) > 2 else None
        power = _float(cells[3]) if len(cells) > 3 else None
        gpus.append(
            GpuInfo(
                name=cells[0],
                driver=cells[1] if len(cells) > 1 and cells[1] else None,
                memory_total_mb=memory,
                power_limit_w=power,
            )
        )
    return gpus


_Q_PATTERNS = {
    "driver": re.compile(r"^\s*Driver Version\s*:\s*(.+?)\s*$", re.MULTILINE),
    "cuda": re.compile(r"^\s*CUDA Version\s*:\s*(.+?)\s*$", re.MULTILINE),
}
_Q_PRODUCT = re.compile(r"^\s*Product Name\s*:\s*(.+?)\s*$", re.MULTILINE)
_Q_TOTAL_FB = re.compile(r"FB Memory Usage.*?Total\s*:\s*([\d.]+)\s*MiB", re.DOTALL)
_Q_POWER_LIMIT = re.compile(
    r"(?:Current Power Limit|Default Power Limit)\s*:\s*([\d.]+)\s*W", re.MULTILINE
)


def parse_nvidia_smi_q(text: str) -> dict[str, Any]:
    """Parse the subset of ``nvidia-smi -q`` we keep: driver, CUDA, products, memory, power."""
    out: dict[str, Any] = {}
    for key, pattern in _Q_PATTERNS.items():
        match = pattern.search(text)
        if match:
            out[key] = match.group(1)
    products = _Q_PRODUCT.findall(text)
    if products:
        out["products"] = products
    total = _Q_TOTAL_FB.search(text)
    if total:
        out["fb_memory_total_mib"] = float(total.group(1))
    power = _Q_POWER_LIMIT.search(text)
    if power:
        out["power_limit_w"] = float(power.group(1))
    return out


def parse_system_profiler(text: str) -> dict[str, Any]:
    """Parse ``system_profiler SPHardwareDataType -json`` and drop identifying fields."""
    try:
        payload = json.loads(text)
    except (json.JSONDecodeError, TypeError):
        return {}
    items = payload.get("SPHardwareDataType") or []
    if not items:
        return {}
    return sanitize(items[0])


_LSCPU_KEYS = {
    "Model name": "model_name",
    "Architecture": "architecture",
    "CPU(s)": "cpus",
    "Vendor ID": "vendor_id",
    "CPU max MHz": "cpu_max_mhz",
    "Socket(s)": "sockets",
    "Core(s) per socket": "cores_per_socket",
    "BIOS Model name": "bios_model_name",
}


def parse_lscpu(text: str) -> dict[str, Any]:
    """Parse the interesting lines of ``lscpu``."""
    out: dict[str, Any] = {}
    for line in text.splitlines():
        if ":" not in line:
            continue
        key, _, value = line.partition(":")
        mapped = _LSCPU_KEYS.get(key.strip())
        if mapped:
            out[mapped] = value.strip()
    return out


def parse_meminfo_gb(text: str) -> float | None:
    """Total RAM in GB from ``/proc/meminfo``."""
    match = re.search(r"^MemTotal:\s+(\d+)\s*kB", text, re.MULTILINE)
    return round(int(match.group(1)) / 1024**2, 2) if match else None


def parse_os_release(text: str) -> str | None:
    """``PRETTY_NAME`` from ``/etc/os-release``."""
    match = re.search(r'^PRETTY_NAME="?([^"\n]+)"?', text, re.MULTILINE)
    return match.group(1) if match else None


def sanitize(value: Any) -> Any:
    """Recursively drop serial numbers, UUIDs and other identifying keys."""
    if isinstance(value, dict):
        return {k: sanitize(v) for k, v in value.items() if not SENSITIVE_KEY_RE.search(str(k))}
    if isinstance(value, list):
        return [sanitize(v) for v in value]
    return value


def _float(text: str) -> float | None:
    try:
        return float(str(text).strip())
    except (TypeError, ValueError):
        return None


def _run(cmd: list[str], timeout: float = 20.0) -> str | None:
    """Run a capture command; ``None`` when the tool is missing or fails."""
    if not shutil.which(cmd[0]):
        return None
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, check=False)
    except (OSError, subprocess.SubprocessError):
        return None
    return proc.stdout if proc.returncode == 0 else None


def _read(path: str) -> str | None:
    try:
        with open(path, encoding="utf-8") as fh:
            return fh.read()
    except OSError:
        return None


# -------------------------------------------------------------------- capture


def collect() -> HostInfo:
    """Capture this machine (never raises — missing tools simply mean missing fields)."""
    info = HostInfo(
        platform=sys.platform,
        arch=platform.machine(),
        kernel=platform.release(),
    )
    _collect_nvidia(info)
    _collect_rocm(info)
    if sys.platform == "darwin":
        _collect_macos(info)
    else:
        _collect_linux(info)
    if not info.os:
        info.os = f"{platform.system()} {platform.release()}"
    return info


def _collect_nvidia(info: HostInfo) -> None:
    """nvidia-smi: GPU names, driver, CUDA, memory, power limit."""
    query = _run(
        [
            "nvidia-smi",
            f"--query-gpu={','.join(_NVIDIA_QUERY_FIELDS)}",
            "--format=csv,noheader,nounits",
        ]
    )
    if not query:
        return
    info.tools.append("nvidia-smi")
    info.gpus.extend(parse_nvidia_smi_query(query))
    if info.gpus:
        info.driver = info.gpus[0].driver
    detail = _run(["nvidia-smi", "-q"])
    if detail:
        parsed = parse_nvidia_smi_q(detail)
        info.cuda = parsed.get("cuda") or info.cuda
        info.driver = parsed.get("driver") or info.driver
        info.captured["nvidia_smi"] = sanitize(parsed)


def _collect_rocm(info: HostInfo) -> None:
    """rocm-smi: AMD product names (best effort, JSON output when available)."""
    if info.gpus:
        return
    out = _run(["rocm-smi", "--showproductname", "--json"])
    if not out:
        return
    info.tools.append("rocm-smi")
    try:
        payload = json.loads(out)
    except json.JSONDecodeError:
        return
    for card, values in payload.items():
        if not isinstance(values, dict):
            continue
        name = (
            values.get("Card Series")
            or values.get("Card series")
            or values.get("Card model")
            or card
        )
        info.gpus.append(GpuInfo(name=str(name), vendor="amd"))
    info.captured["rocm_smi"] = sanitize(payload)


def _collect_macos(info: HostInfo) -> None:
    """macOS: system_profiler + sysctl."""
    profile = _run(["system_profiler", "SPHardwareDataType", "-json"])
    if profile:
        info.tools.append("system_profiler")
        hardware = parse_system_profiler(profile)
        info.captured["system_profiler"] = hardware
        info.apple_chip = hardware.get("chip_type") or hardware.get("cpu_type")
        cores = hardware.get("number_processors")
        if isinstance(cores, str):
            match = re.search(r"(\d+)", cores)
            info.cpu_cores = int(match.group(1)) if match else None
        elif isinstance(cores, int):
            info.cpu_cores = cores
    brand = _run(["sysctl", "-n", "machdep.cpu.brand_string"])
    info.cpu = (brand or info.apple_chip or platform.processor() or "").strip()
    if not info.apple_chip and info.cpu.startswith("Apple "):
        info.apple_chip = info.cpu
    memsize = _run(["sysctl", "-n", "hw.memsize"])
    if memsize and memsize.strip().isdigit():
        info.ram_gb = round(int(memsize.strip()) / 1024**3, 2)
    product = _run(["sw_vers", "-productVersion"])
    name = _run(["sw_vers", "-productName"]) or "macOS"
    if product:
        info.os = f"{name.strip()} {product.strip()}"


def _collect_linux(info: HostInfo) -> None:
    """Linux: lscpu + /proc/meminfo + /etc/os-release."""
    lscpu = _run(["lscpu"])
    if lscpu:
        info.tools.append("lscpu")
        parsed = parse_lscpu(lscpu)
        info.captured["lscpu"] = parsed
        info.cpu = parsed.get("model_name") or parsed.get("bios_model_name") or ""
        cpus = parsed.get("cpus")
        info.cpu_cores = int(cpus) if isinstance(cpus, str) and cpus.isdigit() else None
    meminfo = _read("/proc/meminfo")
    if meminfo:
        info.ram_gb = parse_meminfo_gb(meminfo)
    os_release = _read("/etc/os-release")
    if os_release:
        info.os = parse_os_release(os_release) or ""
    if not info.cpu:
        info.cpu = platform.processor() or platform.machine()


# ---------------------------------------------------------------- fingerprint


def fingerprint(info: HostInfo) -> str:
    """``sha256:<hex>`` over the stable, sanitized identity of the machine.

    Deliberately excludes driver and CUDA versions (they are recorded separately and
    change on every driver update) and OS patch level: the fingerprint identifies the
    *box*, not its software state.
    """
    payload = {
        "arch": info.arch,
        "cpu": info.cpu.strip(),
        "gpu_count": info.gpu_count,
        "gpu_memory_mb": [round(g.memory_total_mb or 0) for g in info.gpus],
        "gpu_names": sorted(info.gpu_names),
        "platform": info.platform,
        "ram_gb": round(info.ram_gb) if info.ram_gb else None,
    }
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return "sha256:" + sha256_hex(canonical)


# --------------------------------------------------------------------- match


def _matches(candidates: list[str], values: list[str]) -> bool:
    """Case-insensitive substring match in either direction."""
    normalized = [v.strip().lower() for v in values if v]
    for candidate in candidates:
        needle = str(candidate).strip().lower()
        if not needle:
            continue
        for value in normalized:
            if needle == value or needle in value or value in needle:
                return True
    return False


def _memory_plausible(record: dict[str, Any], info: HostInfo) -> bool:
    """Reject a detect match whose registered memory is far from what we measured.

    Apple SoC ids carry the memory size (``apple-m2-max-32gb``) because it is the binding
    constraint, so ``apple_chip`` alone cannot disambiguate a 32 GB from a 64 GB machine.
    """
    detect = record.get("detect") or {}
    registered = detect.get("memory_gb", record.get("memory_gb"))
    if not isinstance(registered, (int, float)) or registered <= 0:
        return True
    if record.get("kind") == "gpu" and info.gpus:
        measured_mb = max((g.memory_total_mb or 0) for g in info.gpus)
        if measured_mb <= 0:
            return True
        measured = measured_mb / 1024
    elif info.ram_gb:
        measured = info.ram_gb
    else:
        return True
    return abs(measured - registered) / registered <= 0.2


def match_hardware(info: HostInfo, registry: Registry) -> tuple[str | None, list[dict[str, Any]]]:
    """Match a machine against every ``hardware/*.json`` ``detect`` block.

    Returns ``(hardware_id | None, matches)`` where ``matches`` lists every candidate with
    the rule that fired, so an ambiguous machine can be reported instead of guessed.
    """
    matches: list[dict[str, Any]] = []
    for record in registry.hardware_all():
        detect = record.get("detect") or {}
        fired: list[str] = []
        if info.gpu_names and _matches(list(detect.get("nvidia_smi_name") or []), info.gpu_names):
            fired.append("nvidia_smi_name")
        if info.gpu_names and _matches(list(detect.get("rocm_smi_name") or []), info.gpu_names):
            fired.append("rocm_smi_name")
        if info.apple_chip and _matches(list(detect.get("apple_chip") or []), [info.apple_chip]):
            fired.append("apple_chip")
        if info.cpu and _matches(list(detect.get("cpu_model") or []), [info.cpu]):
            fired.append("cpu_model")
        if not fired:
            continue
        plausible = _memory_plausible(record, info)
        matches.append(
            {
                "id": record.get("id"),
                "rules": fired,
                "memory_plausible": plausible,
                "memory_gb": record.get("memory_gb"),
            }
        )
    accepted = [m for m in matches if m["memory_plausible"]]
    if len(accepted) == 1:
        return str(accepted[0]["id"]), matches
    return None, matches


def suggest_id(info: HostInfo) -> str:
    """Suggested registry id for an unmatched machine."""
    if info.apple_chip:
        chip = info.apple_chip.replace("Apple ", "apple-")
        memory = f"-{round(info.ram_gb)}gb" if info.ram_gb else ""
        return slugify_id(f"{chip}{memory}")
    if info.gpus:
        name = info.gpus[0].name
        vendor = info.gpus[0].vendor
        cleaned = re.sub(r"^(nvidia|amd)\s+", "", name, flags=re.IGNORECASE)
        return slugify_id(f"{vendor}-{cleaned}")
    return slugify_id(info.cpu or "unknown-host")


def draft_hardware_file(info: HostInfo) -> dict[str, Any]:
    """A ready-to-fill ``hardware/<id>.json`` draft for an unregistered machine.

    Fields the harness cannot measure are ``null`` on purpose — the contributor fills them
    in from the vendor spec sheet and says so in the PR (SPEC §7.2).
    """
    suggested = suggest_id(info)
    vendor = info.gpus[0].vendor if info.gpus else ("apple" if info.apple_chip else "unknown")
    kind = "gpu" if info.gpus and not info.apple_chip else ("soc" if info.apple_chip else "cpu")
    memory_gb: float | None = None
    if kind == "gpu" and info.gpus and info.gpus[0].memory_total_mb:
        memory_gb = round(info.gpus[0].memory_total_mb / 1024)
    elif info.ram_gb:
        memory_gb = round(info.ram_gb)
    detect: dict[str, list[str]] = {
        "nvidia_smi_name": sorted(set(info.gpu_names)) if info.gpus else [],
        "apple_chip": [info.apple_chip] if info.apple_chip else [],
        "cpu_model": [info.cpu] if info.cpu and not info.gpus else [],
        "lspci": [],
    }
    return {
        "schema_version": 1,
        "id": suggested,
        "name": info.gpus[0].name if info.gpus else (info.apple_chip or info.cpu or suggested),
        "vendor": vendor,
        "kind": kind,
        "aliases": [],
        "memory_gb": memory_gb,
        "memory_type": None,
        "memory_bandwidth_gbs": None,
        "compute": {
            "arch": None,
            "sm": None,
            "fp16_tflops": None,
            "fp8_tflops": None,
            "fp4_tflops": None,
        },
        "tdp_w": info.gpus[0].power_limit_w if info.gpus else None,
        "release_year": None,
        "msrp_usd": None,
        "typical_cloud_usd_per_h": None,
        "form_factor": None,
        "notes": "Draft generated by `atlas-bench hwinfo`; fill in the null fields from the "
        "vendor spec sheet before opening a PR.",
        "detect": detect,
        "links": {},
    }
