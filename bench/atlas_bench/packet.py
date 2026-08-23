"""Task packet generation (SPEC §7).

``atlas-bench packet`` prints the same JSON an "Add measurement" button in the app would
hand to an agent, so the whole contribution loop works offline from a checkout.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .ids import cell_id
from .registry import Registry
from .spec import PACKET_VERSION

__all__ = ["AGENT_RULES", "build_packet", "find_cell", "parse_cell"]

#: The rules block every packet carries (SPEC §7.8).
AGENT_RULES = [
    "Never type hardware specs by hand — run `uv run atlas-bench hwinfo` and use what it "
    "reports. If the machine matches no hardware/*.json, add the printed draft first and say "
    "so in the PR.",
    "Only add your own new result files. Never edit, move or delete a file authored by "
    "someone else.",
    "Do not silently lower the configuration. If a flag or context length does not fit, run "
    "what fits and report the deviation in the PR body — a smaller honest run is useful, a "
    "mislabelled one is not.",
    "The machine must be otherwise idle. Note anything resident (a second engine, a desktop "
    "session, another benchmark) in provenance.notes.",
    "Run `uv run atlas-bench validate <file>` and `pnpm validate` before opening the PR. If "
    "validation fails, report it — never hand-edit the numbers.",
    "Record ambient conditions and anything unusual (thermal throttling, fan curve, power "
    "limit) in provenance.notes.",
]


def parse_cell(text: str) -> dict[str, str] | None:
    """Parse the compact cell form ``engine@version/model/quant/hardware``."""
    if "/" not in text or "@" not in text:
        return None
    head, _, tail = text.partition("/")
    engine, _, version = head.partition("@")
    parts = tail.split("/")
    if len(parts) != 3:
        return None
    model, quant, hardware = parts
    return {
        "engine_id": engine,
        "engine_version": version,
        "model_id": model,
        "quant_id": quant,
        "hardware_id": hardware,
    }


def find_cell(registry: Registry, cell: str) -> dict[str, str] | None:
    """Resolve a 12-hex ``cell_id`` by scanning existing result files."""
    results = registry.root / "results"
    if not results.is_dir():
        return None
    for path in results.rglob("*.json"):
        try:
            record = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if record.get("cell_id") != cell:
            continue
        return {
            "engine_id": str(record["engine"]["id"]),
            "engine_version": str(record["engine"]["version"]),
            "model_id": str(record["model"]["id"]),
            "quant_id": str(record["model"]["quant_id"]),
            "hardware_id": str(record["hardware"]["id"]),
        }
    return None


def build_packet(
    registry: Registry,
    *,
    engine_id: str,
    engine_version: str,
    model_id: str,
    quant_id: str,
    hardware_id: str | None,
    workloads: list[str],
    args: dict[str, Any] | None = None,
    hw_count: int = 1,
    repo: str | None = None,
    output_dir: str = "results",
) -> dict[str, Any]:
    """Build the packet for one cell, filling defaults from the registries."""
    meta = registry.engine_meta(engine_id) or {}
    model = registry.model(model_id) or {}
    quant = registry.quant(model_id, quant_id) or {}
    hardware = registry.hardware(hardware_id) if hardware_id else None
    site = registry.site()

    install = next(iter(meta.get("install") or []), {"method": "attach"})
    image = str(install.get("image") or "").replace("{version}", engine_version) or None
    cid = (
        cell_id(
            model_id=model_id,
            quant_id=quant_id,
            hardware_id=hardware_id,
            hw_count=hw_count,
            engine_id=engine_id,
            engine_version=engine_version,
        )
        if hardware_id
        else None
    )
    short = (cid or "new")[:6]
    branch_prefix = str((site.get("repo") or {}).get("branch_prefix") or "result/")
    dtype = "auto"

    return {
        "packet_version": PACKET_VERSION,
        "repo": repo or site.get("repo"),
        "cell": {
            "cell_id": cid,
            "model_id": model_id,
            "quant_id": quant_id,
            "hardware_id": hardware_id,
            "hw_count": hw_count,
            "engine_id": engine_id,
            "engine_minor": ".".join(engine_version.split(".")[:2]),
        },
        "engine": {
            "id": engine_id,
            "version": engine_version,
            "install": {
                "method": install.get("method", "attach"),
                "image": image,
                "package": str(install.get("package") or "").replace("{version}", engine_version)
                or None,
            },
            "container": image,
        },
        "model": {
            "id": model_id,
            "quant_id": quant_id,
            "hf_id": quant.get("hf_id") or model.get("hf_id"),
            "revision": quant.get("revision"),
            "dtype": dtype,
            "gguf_file": (quant.get("files") or [None])[0],
            "ollama_tag": quant.get("ollama_tag"),
        },
        "hardware": {
            "id": hardware_id,
            "count": hw_count,
            "expected_detect": (hardware or {}).get("detect"),
        },
        "args": dict(args or {}),
        "workloads": list(workloads),
        "output_dir": output_dir,
        "branch": (
            f"{branch_prefix}{engine_id}-{model_id}-{hardware_id or 'new-hardware'}-{short}"
        ),
        "pr_title": (
            f"results: {engine_id} {engine_version} {model_id} {quant_id} on "
            f"{hardware_id or 'new hardware'} ({len(workloads)} runs)"
        ),
        "agent_rules": AGENT_RULES,
    }


def write_packet(packet: dict[str, Any], path: Path | str) -> Path:
    """Write a packet to disk as pretty JSON."""
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(packet, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return target
