"""The task packet (SPEC §7) — the single input of ``atlas-bench run`` / ``serve``.

A packet describes one cell (engine + version + model + quant + hardware + args) and the
workloads to run against it. The app, ``tools/packet`` and ``atlas-bench packet`` all emit
this shape; the harness consumes it. Unknown fields are preserved so a newer packet
version never breaks an older harness.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator

__all__ = [
    "PACKET_VERSION",
    "EngineRef",
    "HardwareRef",
    "InstallSpec",
    "ModelRef",
    "RequestOptions",
    "TaskSpec",
    "WorkloadRef",
    "load_spec",
]

PACKET_VERSION = 1


class _Base(BaseModel):
    """Base model that keeps unknown packet fields instead of rejecting them."""

    model_config = ConfigDict(extra="allow", populate_by_name=True)


class InstallSpec(_Base):
    """How to obtain the engine (mirrors one entry of ``engine.install``)."""

    method: str = "docker"  # docker | pip | binary | brew | ollama | attach
    image: str | None = None
    package: str | None = None
    command: str | None = None


class EngineRef(_Base):
    """Which engine build the measurement is about."""

    id: str
    version: str
    commit: str | None = None
    install: InstallSpec | None = None
    container: str | None = None
    base_url: str | None = None
    port: int | None = None
    env: dict[str, str] = Field(default_factory=dict)

    @property
    def install_method(self) -> str | None:
        """Install method recorded in ``result.engine.install_method``."""
        return self.install.method if self.install else None


class ModelRef(_Base):
    """Model + quantization to serve.

    ``id`` is the Hugging Face repo id, verbatim and case-preserved (SPEC §2, decision 20);
    it is what every computed id hashes and what the result path is built from.

    ``served_model_id`` is a different thing and must never be confused with it: it is the
    name *this particular server* answers to in the OpenAI ``model`` field. LM Studio, for
    instance, serves ``google/gemma-4-E2B-it`` under the key ``google/gemma-4-e2b``; vLLM
    serves whatever ``--served-model-name`` said. It is transport, not identity — it is sent
    on the wire and recorded in ``raw.payload``, and it never touches an id.
    """

    id: str
    quant_id: str
    hf_id: str | None = None
    #: The repo that holds this quantization's weights (often a community re-upload).
    quant_hf_id: str | None = None
    revision: str | None = None
    dtype: str | None = "auto"
    #: The name the running server answers to; ``served_name`` is accepted as an alias.
    served_model_id: str | None = Field(default=None, alias="served_name")
    gguf_file: str | None = None
    gguf_repo: str | None = None
    ollama_tag: str | None = None
    local_path: str | None = None


class HardwareRef(_Base):
    """Hardware the run happens on; ``id`` is null when the box is not registered yet."""

    id: str | None = None
    count: int = 1
    expected_detect: dict[str, Any] | None = None


class WorkloadRef(_Base):
    """One workload to run: an id plus optional per-run parameter overrides."""

    id: str
    params: dict[str, Any] = Field(default_factory=dict)

    @classmethod
    def coerce(cls, value: Any) -> WorkloadRef:
        """Accept both ``"serve-chat-c8-v1"`` and ``{"id": ..., "params": {...}}``."""
        if isinstance(value, WorkloadRef):
            return value
        if isinstance(value, str):
            return cls(id=value)
        if isinstance(value, dict):
            return cls(**value)
        raise TypeError(f"cannot read workload reference from {value!r}")


class RequestOptions(_Base):
    """Sampling/transport options applied to every request of the run."""

    temperature: float = 0.0
    top_p: float | None = None
    seed: int | None = 42
    max_tokens: int | None = None
    stop: list[str] | None = None
    timeout_s: float = 600.0
    extra_body: dict[str, Any] = Field(default_factory=dict)
    chat_template_kwargs: dict[str, Any] | None = None
    reasoning_effort: str | None = None
    api_key: str | None = None


class TaskSpec(_Base):
    """A full task packet."""

    packet_version: int = PACKET_VERSION
    #: Either a clone URL or the ``site/config.json`` repo object (``{owner, name, host}``).
    repo: str | dict[str, Any] | None = None
    cell: dict[str, Any] | None = None
    engine: EngineRef
    model: ModelRef
    hardware: HardwareRef = Field(default_factory=HardwareRef)
    args: dict[str, Any] = Field(default_factory=dict)
    workloads: list[WorkloadRef] = Field(default_factory=list)
    request: RequestOptions = Field(default_factory=RequestOptions)
    output_dir: str = "results"
    branch: str | None = None
    pr_title: str | None = None
    agent_rules: list[str] = Field(default_factory=list)
    notes: str | None = None
    github_login: str | None = None
    tokenizer: str | None = None

    @field_validator("workloads", mode="before")
    @classmethod
    def _coerce_workloads(cls, value: Any) -> Any:
        if isinstance(value, (list, tuple)):
            return [WorkloadRef.coerce(v) for v in value]
        return value

    @property
    def repo_url(self) -> str | None:
        """Clone URL for the packet's repo, in either of the two accepted forms."""
        if isinstance(self.repo, str):
            return self.repo or None
        if isinstance(self.repo, dict) and self.repo.get("owner") and self.repo.get("name"):
            host = str(self.repo.get("host") or "https://github.com").rstrip("/")
            return f"{host}/{self.repo['owner']}/{self.repo['name']}"
        return None

    def packet_dict(self) -> dict[str, Any]:
        """The packet as JSON, in the field order of SPEC §7."""
        data = self.model_dump(mode="json", exclude_none=False)
        order = [
            "packet_version",
            "repo",
            "cell",
            "engine",
            "model",
            "hardware",
            "args",
            "workloads",
            "request",
            "output_dir",
            "branch",
            "pr_title",
            "agent_rules",
            "notes",
        ]
        ordered = {k: data[k] for k in order if k in data}
        ordered.update({k: v for k, v in data.items() if k not in ordered})
        return ordered


def load_spec(path: Path | str) -> TaskSpec:
    """Load a task packet from disk (``-`` reads stdin)."""
    if str(path) == "-":
        import sys

        return TaskSpec.model_validate(json.load(sys.stdin))
    raw = json.loads(Path(path).expanduser().read_text(encoding="utf-8"))
    return TaskSpec.model_validate(raw)
