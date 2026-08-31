"""Building the result record (SPEC §4).

One run of one workload is one JSON file. Everything in it is either measured, computed
from the registries or copied from the packet — nothing is invented. Unknown quantities stay
``null``; that is explicitly allowed and infinitely better than a plausible-looking guess.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import HARNESS_NAME, __version__
from .canonical import canonicalize
from .client import utc_now
from .hwinfo import HostInfo, fingerprint
from .ids import cell_id, config_id_from_canonical, result_path, run_id
from .plausibility import active_weight_gb
from .registry import Registry
from .spec import RunConditions, TaskSpec
from .workloads.base import WorkloadOutcome

__all__ = [
    "PAYLOAD_LIMIT_BYTES",
    "ResultInputs",
    "auto_gotchas",
    "bound_payload",
    "build_result",
    "derived_metrics",
    "resolve_login",
]

#: ``raw.payload`` above this size is truncated (SPEC §4).
PAYLOAD_LIMIT_BYTES = 100 * 1024


@dataclass
class ResultInputs:
    """Everything needed to assemble one result file."""

    spec: TaskSpec
    registry: Registry
    host: HostInfo
    outcome: WorkloadOutcome
    workload: dict[str, Any]
    github_login: str
    started_at: str
    finished_at: str
    #: ``None`` in attach mode: we did not start the server and do not know how it was.
    serve_command: str | None
    container: str | None = None
    install_method: str | None = None
    #: What the server answered to in the OpenAI ``model`` field — transport, not identity.
    served_model_id: str | None = None
    #: Everything ``/v1/models`` advertised, so a wrong-model run can be spotted afterwards.
    advertised_models: list[str] = field(default_factory=list)
    #: True when the engine was already running and the harness only measured it.
    attached: bool = False
    extra_gotchas: list[str] = field(default_factory=list)
    notes: str | None = None
    #: Run conditions: dedicated-or-not is asserted, ``isolation_check`` is measured.
    conditions: RunConditions | None = None
    warnings: list[str] = field(default_factory=list)


def resolve_login(explicit: str | None = None) -> str | None:
    """Find the contributor's GitHub login.

    Order: ``--login`` → ``ATLAS_GITHUB_LOGIN`` → ``gh api user`` → ``git config github.user``.
    Returns ``None`` when nothing is configured; the caller must then refuse to build a
    result, because ``run_id`` and the ownership check both depend on the login.
    """
    if explicit:
        return explicit.strip()
    env = os.environ.get("ATLAS_GITHUB_LOGIN")
    if env:
        return env.strip()
    if shutil.which("gh"):
        proc = subprocess.run(
            ["gh", "api", "user", "-q", ".login"], capture_output=True, text=True, check=False
        )
        if proc.returncode == 0 and proc.stdout.strip():
            return proc.stdout.strip()
    proc = subprocess.run(
        ["git", "config", "--get", "github.user"], capture_output=True, text=True, check=False
    )
    if proc.returncode == 0 and proc.stdout.strip():
        return proc.stdout.strip()
    return None


def bound_payload(
    payload: dict[str, Any], limit: int = PAYLOAD_LIMIT_BYTES
) -> tuple[dict[str, Any], bool]:
    """Shrink ``raw.payload`` below ``limit`` bytes, keeping the aggregates.

    Per-request traces are dropped first (they are the bulk and the least valuable part),
    then any remaining oversized list is emptied. Returns ``(payload, truncated)``.
    """

    def size(value: Any) -> int:
        return len(json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode("utf-8"))

    if size(payload) <= limit:
        return payload, False
    shrunk = dict(payload)
    requests = shrunk.get("requests")
    if isinstance(requests, list) and requests:
        kept = requests[:50]
        shrunk["requests"] = kept
        shrunk["requests_truncated_from"] = len(requests)
        if size(shrunk) <= limit:
            return shrunk, True
        shrunk["requests"] = []
        if size(shrunk) <= limit:
            return shrunk, True
    for key, value in list(shrunk.items()):
        if isinstance(value, list) and size(shrunk) > limit:
            shrunk[key] = []
    if size(shrunk) > limit:
        shrunk = {"note": "payload dropped: exceeded 100 KB even after truncation"}
    return shrunk, True


#: ``engine.install_method`` values the result schema accepts.
INSTALL_METHODS = frozenset(
    {"docker", "pip", "uv", "brew", "binary", "source", "script", "npm", "app"}
)


def _install_method(value: str | None) -> str | None:
    """Map an install method onto the schema enum (``attach`` has no enum member)."""
    return value if value in INSTALL_METHODS else None


def derived_metrics(
    metrics: dict[str, Any] | None,
    hardware: dict[str, Any] | None,
    model: dict[str, Any] | None = None,
    quant: dict[str, Any] | None = None,
    hw_count: int = 1,
) -> dict[str, Any]:
    """Compute ``result.derived`` (SPEC §4).

    * ``tokens_per_watt`` — ``output_tok_s / power_avg_w``
    * ``tok_s_per_gb_bandwidth`` — single-request decode throughput divided by the
      registered memory bandwidth (the roofline ratio)
    * ``bandwidth_efficiency`` — achieved bytes/s (decode tok/s × weight GB) over the
      hardware's peak bandwidth; 1.0 means the run saturated memory
    * ``memory_headroom_gb`` — registered memory minus measured peak VRAM
    * ``cost_per_1m_output_tokens_usd`` — only when the hardware has a cloud price

    ``hw_count`` scales the *registered* figures, because bandwidth and memory are per
    device and a tensor-parallel run has all of them. Without it a two-device result reports
    twice the bandwidth efficiency it achieved, which is how the repository's first
    multi-device contribution came out. ``packages/core/src/plausibility.ts`` already scales
    the same way (``bandwidthCeiling``, the VRAM limit and the TDP check all take
    ``hwCount``); this is the Python side catching up. Measured figures — power, VRAM — are
    never scaled: they are what the meter said.
    """
    out: dict[str, Any] = {
        "cost_per_1m_output_tokens_usd": None,
        "tokens_per_watt": None,
        "tok_s_per_gb_bandwidth": None,
        "bandwidth_efficiency": None,
        "memory_headroom_gb": None,
    }
    if not metrics:
        return out
    output_tok_s = metrics.get("output_tok_s")
    power = metrics.get("power_avg_w")
    if output_tok_s and power:
        out["tokens_per_watt"] = round(output_tok_s / power, 4)
    devices = max(1, int(hw_count or 1))
    per_device_bandwidth = (hardware or {}).get("memory_bandwidth_gbs")
    bandwidth = per_device_bandwidth * devices if per_device_bandwidth else None
    decode = (metrics.get("decode_tok_s_per_request") or {}).get("mean")
    reference = decode if decode else output_tok_s
    if bandwidth and reference:
        out["tok_s_per_gb_bandwidth"] = round(reference / bandwidth, 6)
    weight = active_weight_gb(model or {}, quant or {})
    if bandwidth and decode and weight:
        out["bandwidth_efficiency"] = round(decode * weight / bandwidth, 6)
    memory_gb = (hardware or {}).get("memory_gb")
    vram_peak = metrics.get("vram_peak_gb")
    if memory_gb and vram_peak:
        out["memory_headroom_gb"] = round(float(memory_gb) * devices - float(vram_peak), 3)
    price = (hardware or {}).get("typical_cloud_usd_per_h")
    if price and output_tok_s:
        tokens_per_hour = output_tok_s * 3600
        out["cost_per_1m_output_tokens_usd"] = round(price / tokens_per_hour * 1_000_000, 6)
    return out


def auto_gotchas(inputs: ResultInputs, metrics: dict[str, Any] | None) -> list[dict[str, str]]:
    """Detect the gotchas the harness can see by itself, plus the CLI additions."""
    found: list[dict[str, str]] = list(inputs.outcome.gotchas)
    categories = {f.get("category") for f in inputs.outcome.failures}
    if "oom" in categories:
        found.append(
            {
                "severity": "blocker",
                "text": "Requests failed with out-of-memory errors during "
                "this run — lower the memory utilization or the context length.",
            }
        )
    if "context-overflow" in categories:
        found.append(
            {
                "severity": "warn",
                "text": "Requests exceeded the model's context window; the "
                "workload's input length does not fit this configuration.",
            }
        )
    if metrics and metrics.get("thermal_throttle_detected"):
        found.append(
            {
                "severity": "warn",
                "text": "The driver reported thermal/hardware slowdown during "
                "the run — the numbers are throttled.",
            }
        )
    for warning in inputs.warnings + inputs.outcome.warnings:
        if warning.startswith("dataset-missing"):
            found.append(
                {
                    "severity": "warn",
                    "text": f"Dataset not present in this checkout ({warning}); "
                    "prompts were generated synthetically and are not comparable to dataset runs.",
                }
            )
        elif warning.startswith("unknown-engine-version"):
            version = warning.split(":", 1)[1]
            found.append(
                {
                    "severity": "info",
                    "text": f"No engine version file for {version}; no defaults could be "
                    "dropped from the canonical config.",
                }
            )
    found.extend({"severity": "info", "text": text} for text in inputs.extra_gotchas)
    deduped: list[dict[str, str]] = []
    seen: set[tuple[str, str]] = set()
    for item in found:
        key = (item.get("severity", "info"), item.get("text", ""))
        if key not in seen:
            seen.add(key)
            deduped.append(item)
    return deduped


def build_result(inputs: ResultInputs) -> dict[str, Any]:
    """Assemble the full SPEC §4 result record for one workload run."""
    spec = inputs.spec
    registry = inputs.registry
    outcome = inputs.outcome

    resolved = registry.resolve_config(
        engine_id=spec.engine.id,
        engine_version=spec.engine.version,
        args=spec.args,
        quant_id=spec.model.quant_id,
        dtype=spec.model.dtype,
        build=spec.engine.build,
    )
    inputs.warnings.extend(resolved.warnings)
    args_canonical = canonicalize(resolved.canonical_input)
    cfg_id = config_id_from_canonical(args_canonical)
    hardware_id = spec.hardware.id
    cid = (
        cell_id(
            model_id=spec.model.id,
            quant_id=spec.model.quant_id,
            hardware_id=hardware_id,
            hw_count=spec.hardware.count,
            engine_id=spec.engine.id,
            engine_version=spec.engine.version,
        )
        if hardware_id
        else None
    )
    rid = run_id(
        cfg_id=cfg_id,
        workload_id=str(inputs.workload.get("id")),
        github_login=inputs.github_login,
        started_at=inputs.started_at,
    )

    hardware_record = registry.hardware(hardware_id) if hardware_id else None
    quant = registry.quant(spec.model.id, spec.model.quant_id) or {}
    model_record = registry.model(spec.model.id) or {}

    metrics = outcome.metrics
    raw_payload = dict(outcome.raw or {})
    # The wire-level facts that have no home in the (closed) engine/model blocks: what the
    # server called the model, what else it had loaded, and whether we started it at all.
    raw_payload["engine_endpoint"] = {
        "attached": inputs.attached,
        "base_url": spec.engine.base_url,
        "served_model_id": inputs.served_model_id,
        "advertised_models": inputs.advertised_models,
    }
    payload, truncated = bound_payload(raw_payload)
    payload_json = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)

    agent_name = os.environ.get("ATLAS_AGENT_NAME")
    record: dict[str, Any] = {
        "schema_version": 1,
        "run_id": rid,
        "config_id": cfg_id,
        "cell_id": cid,
        "workload_id": str(inputs.workload.get("id")),
        "kind": outcome.kind,
        "engine": {
            "id": spec.engine.id,
            "version": spec.engine.version,
            "commit": spec.engine.commit,
            "build": spec.engine.build,
            "container": inputs.container or spec.engine.container,
            "install_method": _install_method(inputs.install_method or spec.engine.install_method),
        },
        "model": {
            "id": spec.model.id,
            "quant_id": spec.model.quant_id,
            # model.hf_id is the model's own repo (equal to the id); the quant's weights
            # repo lives in the quant record and is not duplicated here.
            "hf_id": spec.model.hf_id or model_record.get("hf_id") or spec.model.id,
            "revision": spec.model.revision,
            "dtype": spec.model.dtype or "auto",
            "local_path": spec.model.local_path,
        },
        "hardware": {
            "id": hardware_id,
            "count": spec.hardware.count,
            "driver": inputs.host.driver,
            "cuda": inputs.host.cuda,
            "host": inputs.host.host_block(),
            "fingerprint": fingerprint(inputs.host),
            "captured": inputs.host.captured,
        },
        "args": spec.args,
        "args_canonical": args_canonical,
        "serve_command": inputs.serve_command,
        "workload": {
            "id": str(inputs.workload.get("id")),
            "resolved_params": outcome.resolved_params,
        },
    }
    if spec.engine.env:
        record["env"] = dict(spec.engine.env)
    if metrics is not None:
        record["metrics"] = metrics
    if outcome.sweep is not None:
        record["sweep"] = outcome.sweep
    if outcome.scores is not None:
        record["scores"] = outcome.scores
    record["failures"] = outcome.failures
    conditions = inputs.conditions or spec.conditions
    record["conditions"] = conditions.record_dict() if conditions else None
    record["gotchas"] = auto_gotchas(inputs, metrics)
    record["derived"] = derived_metrics(
        metrics, hardware_record, model_record, quant, spec.hardware.count
    )
    record["raw"] = {
        "harness": HARNESS_NAME,
        "harness_version": __version__,
        "sha256": hashlib.sha256(payload_json.encode("utf-8")).hexdigest(),
        "payload_path": None,
        "payload": payload,
        "truncated": truncated,
    }
    record["provenance"] = {
        "github_login": inputs.github_login,
        "github_user_id": None,
        "started_at": inputs.started_at,
        "finished_at": inputs.finished_at,
        "submitted_at": None,
        "commit": None,
        "pr": None,
        "method": "agent" if agent_name else HARNESS_NAME,
        "agent": {
            "name": agent_name,
            "model": os.environ.get("ATLAS_AGENT_MODEL"),
        }
        if agent_name
        else None,
        "notes": inputs.notes or spec.notes,
    }
    record["verification"] = {"level": "self-reported", "reproduced_by": [], "flags": []}
    return record


def output_path(record: dict[str, Any], out_dir: Path | str) -> Path:
    """Where a result record must be written.

    ``out_dir`` may be the repo root or an explicit ``results/`` directory; both produce
    ``results/<engine>/<model>/<hardware>/<run_id>.json``.
    """
    relative = result_path(
        engine_id=record["engine"]["id"],
        model_id=record["model"]["id"],
        hardware_id=record["hardware"]["id"] or "unknown-hardware",
        rid=record["run_id"],
    )
    base = Path(out_dir)
    if base.name == "results":
        return base.joinpath(*relative.parts[1:])
    return base / Path(str(relative))


def timestamp() -> str:
    """UTC timestamp used for ``started_at``/``finished_at``."""
    return utc_now()
