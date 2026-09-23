"""Orchestration: packet in, result files out.

``atlas-bench run`` is a thin CLI over :func:`run_spec`. The order of operations matters and
is fixed: capture the hardware truthfully, resolve the hardware id (never guess), attach to
or start the engine, discover the served model name, then run each workload in the packet
and write one result file per workload.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import httpx

from . import hwinfo
from .client import ChatClient, utc_now
from .engines.base import AttachAdapter, EngineAdapter, get_adapter
from .registry import Registry
from .repo import write_json
from .result import ResultInputs, build_result, output_path
from .spec import RunConditions, TaskSpec
from .telemetry import TelemetrySampler
from .workloads import RunContext, get_runner, resolve_workload
from .workloads.sweep import sweep_axis

__all__ = ["RunOutput", "plan_spec", "run_spec", "run_spec_sync"]


@dataclass
class RunOutput:
    """Everything one ``run`` produced."""

    records: list[dict[str, Any]] = field(default_factory=list)
    paths: list[Path] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    plan: list[dict[str, Any]] = field(default_factory=list)


def _resolve_hardware(spec: TaskSpec, registry: Registry, host: hwinfo.HostInfo) -> list[str]:
    """Fill ``spec.hardware.id`` from the detect rules when the packet left it open."""
    warnings: list[str] = []
    if spec.hardware.id:
        return warnings
    matched, candidates = hwinfo.match_hardware(host, registry)
    if matched:
        spec.hardware.id = matched
    else:
        warnings.append(
            "hardware-unmatched: this machine matches no hardware/*.json detect rule "
            f"(candidates: {[c['id'] for c in candidates] or 'none'}). "
            "Run `atlas-bench hwinfo` and add the printed draft first."
        )
    return warnings


class AmbiguousServedModelError(RuntimeError):
    """Several models are loaded, none is the one in the packet, and nothing says which."""


async def _served_model(client: ChatClient, spec: TaskSpec) -> tuple[str, list[str], list[str]]:
    """Pick the model name to send in requests: ``(served_model_id, advertised, warnings)``.

    The registry ``model.id`` is an identity, not an address. What a server answers to is a
    separate string — LM Studio serves ``google/gemma-4-E2B-it`` under ``google/gemma-4-e2b``,
    vLLM under whatever ``--served-model-name`` said — so the packet may carry
    ``model.served_model_id``, and it is used verbatim.

    Without one we look for the model id in ``/v1/models`` (case-insensitively, since that is
    exactly the kind of difference this field exists for). A server with exactly one model loaded
    serves that one. A server with several and no match is an error, not a guess.
    """
    advertised = await client.list_models()
    warnings: list[str] = []
    wanted = spec.model.served_model_id
    if wanted:
        if advertised and not any(name.casefold() == wanted.casefold() for name in advertised):
            warnings.append(
                f"served-model-not-advertised: '{wanted}' is not in /v1/models "
                f"({advertised}); sending it anyway"
            )
        return wanted, advertised, warnings

    for candidate in (spec.model.id, spec.model.hf_id):
        if not candidate:
            continue
        for name in advertised:
            if name.casefold() == str(candidate).casefold():
                return name, advertised, warnings
    if len(advertised) > 1:
        # This used to pick advertised[0] and warn. Behind a proxy that serves several models,
        # that measures whichever one is listed first and files it under the packet's model;
        # a warning at the end of the run is not enough to stop that row being submitted.
        raise AmbiguousServedModelError(
            f"{len(advertised)} models are loaded ({', '.join(advertised)}) and none matches "
            f"'{spec.model.id}'. Set model.served_model_id in the packet to the one to measure."
        )
    if advertised:
        return advertised[0], advertised, warnings
    return spec.model.hf_id or spec.model.id, advertised, warnings


def _load_tokenizer(name: str | None) -> Any | None:
    """Load a local tokenizer (only when ``--tokenizer`` was passed)."""
    if not name:
        return None
    try:
        from tokenizers import Tokenizer
    except ImportError as exc:  # pragma: no cover - optional dependency
        raise RuntimeError(
            "--tokenizer needs the 'tokenizer' extra: uv pip install 'atlas-bench[tokenizer]'"
        ) from exc
    return Tokenizer.from_pretrained(name)


def _sampler_factory() -> TelemetrySampler:
    """Fresh 1 Hz telemetry sampler for one measured window."""
    return TelemetrySampler(enabled=True)


def plan_spec(spec: TaskSpec, registry: Registry) -> list[dict[str, Any]]:
    """What a run would do, without touching the network (``--dry-run``)."""
    plan: list[dict[str, Any]] = []
    for ref in spec.workloads:
        workload, params = resolve_workload(registry, ref)
        plan.append(
            {
                "workload_id": ref.id,
                "kind": workload.get("kind"),
                "dataset_id": workload.get("dataset_id"),
                "params": params,
                "registered": registry.workload(ref.id) is not None,
            }
        )
    return plan


def max_concurrency(spec: TaskSpec, registry: Registry) -> int:
    """Largest number of requests any workload in ``spec`` will have in flight at once.

    One client serves every workload of a packet, so the pool has to fit the widest of
    them — and for a sweep that is the top of its axis, not the ``concurrency`` in its
    params, which is only the first level.
    """
    widest = 1
    for ref in spec.workloads:
        workload, params = resolve_workload(registry, ref)
        levels = [int(params.get("concurrency") or 1)]
        if str(workload.get("kind") or "") == "sweep":
            axis, values = sweep_axis(workload)
            if axis == "concurrency":
                levels += [int(v) for v in values]
        widest = max(widest, *levels)
    return widest


async def run_spec(
    spec: TaskSpec,
    *,
    registry: Registry,
    out_dir: Path | str,
    github_login: str,
    base_url: str | None = None,
    dry_run: bool = False,
    telemetry: bool = True,
    gotchas: list[str] | None = None,
    notes: str | None = None,
    conditions: RunConditions | None = None,
    transport: httpx.AsyncBaseTransport | None = None,
    adapter: EngineAdapter | None = None,
    host: hwinfo.HostInfo | None = None,
) -> RunOutput:
    """Run every workload of a packet and write the result files."""
    output = RunOutput()
    host = host or hwinfo.collect()
    output.warnings.extend(_resolve_hardware(spec, registry, host))

    if base_url:
        spec.engine.base_url = base_url
    adapter = adapter or get_adapter(spec, registry, attach=bool(spec.engine.base_url))
    # `run` never starts an engine — it measures one. In attach mode we genuinely do not know
    # how the server was started, so `serve_command` is null rather than a plausible guess.
    attached = isinstance(adapter, AttachAdapter)
    serve_command = adapter.serve_command()

    if dry_run:
        output.plan = plan_spec(spec, registry)
        output.warnings.append("dry-run: no requests were sent and no files were written")
        return output

    tokenizer = _load_tokenizer(spec.tokenizer)
    extra_body: dict[str, Any] = {}
    if hasattr(adapter, "request_extra_body"):
        extra_body.update(adapter.request_extra_body())

    async with ChatClient(
        adapter.base_url,
        model=spec.model.served_model_id or spec.model.hf_id or spec.model.id,
        api_key=spec.request.api_key,
        timeout_s=spec.request.timeout_s,
        transport=transport,
        tokenizer=tokenizer,
        extra_body=extra_body,
        max_connections=max_concurrency(spec, registry),
    ) as client:
        client.model, advertised, model_warnings = await _served_model(client, spec)
        output.warnings.extend(model_warnings)
        server_build = None
        if spec.engine.id == "llamacpp":
            server_build = await client.server_build(client.model)
        if server_build and spec.engine.version.lower() not in server_build.lower().split("-"):
            output.warnings.append(
                f"engine-version-mismatch: the packet says {spec.engine.id} {spec.engine.version} "
                f"but the server reports build {server_build}; record the build you measured"
            )
        for ref in spec.workloads:
            workload, params = resolve_workload(registry, ref)
            started_at = utc_now()
            ctx = RunContext(
                spec=spec,
                registry=registry,
                client=client,
                workload=workload,
                params=params,
                telemetry_factory=_sampler_factory if telemetry else None,
            )
            outcome = await get_runner(str(workload.get("kind") or "serving"))(ctx)
            record = build_result(
                ResultInputs(
                    spec=spec,
                    registry=registry,
                    host=host,
                    outcome=outcome,
                    workload=workload,
                    github_login=github_login,
                    started_at=started_at,
                    finished_at=utc_now(),
                    serve_command=serve_command,
                    container=getattr(adapter, "container", None) or spec.engine.container,
                    install_method=spec.engine.install_method,
                    served_model_id=client.model,
                    advertised_models=advertised,
                    server_build=server_build,
                    attached=attached,
                    extra_gotchas=list(gotchas or []),
                    notes=notes,
                    conditions=conditions,
                    warnings=list(output.warnings),
                )
            )
            path = output_path(record, out_dir)
            write_json(path, record)
            output.records.append(record)
            output.paths.append(path)
            output.warnings.extend(outcome.warnings)
    return output


def run_spec_sync(spec: TaskSpec, **kwargs: Any) -> RunOutput:
    """Blocking wrapper around :func:`run_spec` for the CLI."""
    return asyncio.run(run_spec(spec, **kwargs))
