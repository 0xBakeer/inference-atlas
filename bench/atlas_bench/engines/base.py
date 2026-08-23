"""Engine adapter base class.

An adapter knows three things: how to build the exact command that starts the engine (so
the result file can carry a reproducible ``serve_command``), how to wait for it to become
healthy, and how to stop it again. Every adapter speaks the OpenAI-compatible API — that is
what the client measures.

**Attach mode is the common path.** ``atlas-bench run --base-url http://host:8000/v1`` uses
:class:`AttachAdapter` for every engine: the contributor started the server themselves (or
it is a shared box) and the harness only measures it.
"""

from __future__ import annotations

import os
import shlex
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import IO, Any

import httpx

from ..canonical import normalize_key
from ..registry import Registry
from ..spec import TaskSpec

__all__ = [
    "AttachAdapter",
    "EngineAdapter",
    "ServeResult",
    "build_flags",
    "get_adapter",
    "hf_cache_dir",
]


def hf_cache_dir() -> str:
    """Absolute host path of the Hugging Face cache.

    Expanded here rather than left as ``~``: docker does not expand tildes, and the command
    is recorded verbatim in ``serve_command`` for somebody else to paste.
    """
    return str(Path(os.environ.get("HF_HOME") or (Path.home() / ".cache" / "huggingface")))


@dataclass
class ServeResult:
    """What ``serve`` reports back to the caller."""

    base_url: str
    serve_command: str | None
    started: bool
    pid: int | None = None
    log_path: str | None = None
    container: str | None = None
    notes: list[str] = field(default_factory=list)


def build_flags(
    args: dict[str, Any],
    *,
    flag_style: str = "--{name} {value}",
    bool_style: str = "--{name}",
    bool_false_style: str | None = None,
) -> list[str]:
    """Render an ``args`` object into CLI tokens using the engine's flag style.

    ``True`` renders as the bare flag, ``False`` renders as ``bool_false_style`` when the
    engine has one (vLLM's ``--no-<name>``) and is skipped otherwise, ``None`` is skipped,
    lists repeat the flag and objects are passed as compact JSON
    (``--speculative-config '{"method":"mtp"}'``).
    """
    tokens: list[str] = []
    for name, value in args.items():
        flag = str(name).lstrip("-")
        if value is None:
            continue
        if value is False:
            if bool_false_style:
                tokens.extend(shlex.split(bool_false_style.format(name=flag)))
            continue
        if value is True:
            tokens.extend(shlex.split(bool_style.format(name=flag)))
            continue
        values = value if isinstance(value, (list, tuple)) else [value]
        for item in values:
            rendered = _render_value(item)
            if "{value}" in flag_style:
                head = flag_style.split("{value}")[0].format(name=flag).strip()
                tokens.extend([*shlex.split(head), rendered])
            else:  # pragma: no cover - engines all use "--{name} {value}" today
                tokens.append(flag_style.format(name=flag, value=rendered))
    return tokens


def _render_value(value: Any) -> str:
    """Render one flag value; dicts/lists become compact JSON."""
    if isinstance(value, (dict, list, tuple)):
        import json

        return json.dumps(value, separators=(",", ":"), sort_keys=True)
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


class EngineAdapter:
    """Base adapter: subclasses build a command line; the rest is shared."""

    #: Registry id of the engine this adapter serves.
    engine_id = "base"
    #: Port used when neither the packet nor the engine meta says otherwise.
    default_port = 8000

    def __init__(self, spec: TaskSpec, registry: Registry, *, log_dir: str | None = None) -> None:
        self.spec = spec
        self.registry = registry
        self.meta = registry.engine_meta(spec.engine.id) or {}
        self.port = spec.engine.port or int(self.meta.get("default_port") or self.default_port)
        self.log_dir = log_dir
        self._process: subprocess.Popen[bytes] | None = None
        self._log_path: str | None = None
        self._log_file: IO[bytes] | None = None

    # ------------------------------------------------------------------ urls

    @property
    def base_url(self) -> str:
        """Base URL the client talks to (without the ``/v1`` suffix)."""
        if self.spec.engine.base_url:
            return self.spec.engine.base_url.rstrip("/").removesuffix("/v1")
        return f"http://127.0.0.1:{self.port}"

    @property
    def health_url(self) -> str:
        """Health endpoint from the engine meta (falls back to ``/v1/models``)."""
        path = ((self.meta.get("health") or {}).get("path")) or "/v1/models"
        return f"{self.base_url}{path}"

    @property
    def models_url(self) -> str:
        """Model-list endpoint."""
        path = ((self.meta.get("health") or {}).get("models_path")) or "/v1/models"
        return f"{self.base_url}{path}"

    # -------------------------------------------------------------- lifecycle

    def model_ref(self) -> str:
        """What to pass to the engine as "the model": where the weights actually live.

        For a quantized model that is the quant's own repo
        (``lmstudio-community/gemma-4-E2B-it-MLX-4bit``), not the model id — serving the base
        repo when the packet said ``fp8`` would quietly benchmark different weights than the
        result claims.
        """
        model = self.spec.model
        if model.local_path:
            return model.local_path
        if model.quant_hf_id:
            return model.quant_hf_id
        quant = self.registry.quant(model.id, model.quant_id) or {}
        return str(quant.get("hf_id") or model.hf_id or model.id)

    def serve_command(self) -> str | None:
        """The exact command line that starts this engine (recorded in the result).

        ``None`` means "we did not start this server and cannot claim to know how it was
        started" — the result records null rather than a plausible-looking guess.
        """
        raise NotImplementedError

    def start(self) -> ServeResult:
        """Start the engine as a child process using :meth:`serve_command`."""
        command = self.serve_command()
        if command is None:
            raise RuntimeError(
                f"{type(self).__name__} is attach-only: start the server yourself and pass "
                "--base-url"
            )
        env = {**os.environ, **(self.spec.engine.env or {})}
        log = None
        if self.log_dir:
            os.makedirs(self.log_dir, exist_ok=True)
            self._log_path = os.path.join(self.log_dir, f"{self.engine_id}-{self.port}.log")
            log = open(self._log_path, "wb")  # noqa: SIM115 - closed in stop()
            self._log_file = log
        self._process = subprocess.Popen(
            shlex.split(command),
            stdout=log or subprocess.DEVNULL,
            stderr=subprocess.STDOUT if log else subprocess.DEVNULL,
            env=env,
        )
        return ServeResult(
            base_url=self.base_url,
            serve_command=command,
            started=True,
            pid=self._process.pid,
            log_path=self._log_path,
        )

    def wait_healthy(self, timeout_s: float = 900.0, interval_s: float = 2.0) -> bool:
        """Poll the health endpoint until the engine answers or the timeout expires."""
        deadline = time.monotonic() + timeout_s
        with httpx.Client(timeout=10.0) as client:
            while time.monotonic() < deadline:
                if self._process is not None and self._process.poll() is not None:
                    return False
                try:
                    response = client.get(self.health_url)
                    if response.status_code < 400:
                        return True
                except httpx.HTTPError:
                    pass
                time.sleep(interval_s)
        return False

    def stop(self) -> None:
        """Terminate the engine process we started (no-op in attach mode)."""
        if self._process is None:
            return
        self._process.terminate()
        try:
            self._process.wait(timeout=60)
        except subprocess.TimeoutExpired:  # pragma: no cover - only on a wedged engine
            self._process.kill()
        self._process = None
        if self._log_file is not None:
            self._log_file.close()
            self._log_file = None

    def list_models(self) -> list[str]:
        """Model ids the running engine advertises."""
        try:
            with httpx.Client(timeout=15.0) as client:
                response = client.get(self.models_url)
                response.raise_for_status()
                payload = response.json()
        except (httpx.HTTPError, ValueError):
            return []
        return [str(item.get("id")) for item in payload.get("data") or [] if item.get("id")]

    def prepare(self) -> list[str]:
        """Pull images/weights before serving; returns human-readable notes."""
        return []

    # ---------------------------------------------------------------- helpers

    def resolved_args(self) -> dict[str, Any]:
        """Packet args with aliases resolved to the canonical flag names.

        A packet may say ``-tp`` or ``max_model_len``; the engine only accepts its own
        spelling. ``drop_params`` are deliberately *not* removed here — the fingerprint
        ignores ``--served-model-name``, but the engine still needs it.
        """
        aliases: dict[str, str] = {
            normalize_key(alias): normalize_key(target)
            for alias, target in (self.meta.get("param_aliases") or {}).items()
        }
        version = self.registry.engine_version(self.spec.engine.id, self.spec.engine.version)
        for param in (version or {}).get("params") or ():
            name = normalize_key(str(param.get("name", "")))
            for alias in param.get("aliases") or ():
                aliases[normalize_key(str(alias))] = name
        resolved: dict[str, Any] = {}
        for key, value in (self.spec.args or {}).items():
            flag = normalize_key(str(key))
            resolved[aliases.get(flag, flag)] = value
        return resolved

    def flags(self) -> list[str]:
        """The packet's ``args`` rendered with this engine's flag style."""
        serve = self.meta.get("serve") or {}
        return build_flags(
            self.resolved_args(),
            flag_style=serve.get("flag_style") or "--{name} {value}",
            bool_style=serve.get("bool_style") or "--{name}",
            bool_false_style=serve.get("bool_false_style"),
        )


class AttachAdapter(EngineAdapter):
    """Adapter for an engine that is already running (``--base-url``)."""

    engine_id = "attach"

    def serve_command(self) -> str | None:
        """Attach mode has no command: the engine was started outside the harness."""
        return None

    def start(self) -> ServeResult:
        """Nothing to start."""
        return ServeResult(
            base_url=self.base_url,
            serve_command=self.serve_command(),
            started=False,
            notes=["attach mode: engine was not started by atlas-bench"],
        )

    def stop(self) -> None:
        """Nothing to stop."""
        return None


def get_adapter(
    spec: TaskSpec, registry: Registry, *, attach: bool | None = None, log_dir: str | None = None
) -> EngineAdapter:
    """Pick the adapter for a packet.

    ``attach=None`` (the default) decides from the packet: a ``base_url`` means the server is
    already running and must not be started again. ``attach=False`` forces a real adapter,
    which is what ``atlas-bench serve`` wants; ``attach=True`` forces attach mode.
    """
    from . import ADAPTERS

    if attach is None:
        attach = bool(spec.engine.base_url)
    if attach or (spec.engine.install and spec.engine.install.method == "attach"):
        return AttachAdapter(spec, registry, log_dir=log_dir)
    adapter_cls = ADAPTERS.get(spec.engine.id)
    if adapter_cls is None:
        return AttachAdapter(spec, registry, log_dir=log_dir)
    return adapter_cls(spec, registry, log_dir=log_dir)
