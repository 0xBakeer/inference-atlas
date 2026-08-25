"""Workload runners.

``RUNNERS`` maps a workload ``kind`` onto its coroutine. A workload file selects the kind
(``serving`` | ``sweep`` | ``prefill`` | ``longctx`` | ``eval`` | ``agentic``); the packet only names the
workload id, and the resolved parameter snapshot is stored in the result so a run stays
reproducible even if a workload file is later superseded.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any

from .agentic import run_agentic
from .base import RunContext, WorkloadOutcome
from .eval import run_eval
from .longctx import run_longctx
from .prefill import run_prefill
from .serving import run_serving
from .sweep import run_sweep

__all__ = ["RUNNERS", "RunContext", "WorkloadOutcome", "get_runner", "resolve_workload"]

RUNNERS: dict[str, Callable[[RunContext], Awaitable[WorkloadOutcome]]] = {
    "serving": run_serving,
    "sweep": run_sweep,
    "prefill": run_prefill,
    "longctx": run_longctx,
    "eval": run_eval,
    "agentic": run_agentic,
}


def get_runner(kind: str) -> Callable[[RunContext], Awaitable[WorkloadOutcome]]:
    """Runner for a workload kind (defaults to ``serving``)."""
    return RUNNERS.get((kind or "serving").strip().lower(), run_serving)


def resolve_workload(registry: Any, ref: Any) -> tuple[dict[str, Any], dict[str, Any]]:
    """Load ``workloads/<id>.json`` and merge the packet's per-run overrides.

    A workload that is not in the checkout still runs: the packet's overrides become the
    parameters and the kind is inferred from the id prefix, so a contributor can measure a
    brand-new workload in the same PR that adds it.
    """
    record = registry.workload(ref.id)
    if record is None:
        record = {
            "schema_version": 1,
            "id": ref.id,
            "kind": _kind_from_id(ref.id),
            "params": {},
            "dataset_id": ref.params.get("dataset_id"),
        }
    params = {**(record.get("params") or {}), **(ref.params or {})}
    return record, params


def _kind_from_id(workload_id: str) -> str:
    """Infer a workload kind from its id prefix (``sweep-…`` → ``sweep``)."""
    prefix = (workload_id or "").split("-", 1)[0].lower()
    return {
        "serve": "serving",
        "serving": "serving",
        "sweep": "sweep",
        "prefill": "prefill",
        "longctx": "longctx",
        "eval": "eval",
        "agentic": "agentic",
    }.get(prefix, "serving")
