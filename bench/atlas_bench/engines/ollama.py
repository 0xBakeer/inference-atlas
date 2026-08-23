"""Ollama adapter (talks to the daemon's OpenAI-compatible ``/v1`` API)."""

from __future__ import annotations

import shlex
import subprocess

from .base import EngineAdapter

__all__ = ["OllamaAdapter"]

#: Packet args that map onto Ollama's per-request ``options`` object.
_OPTION_ARGS = {
    "num-ctx",
    "num-gpu",
    "num-thread",
    "num-batch",
    "num-predict",
    "repeat-penalty",
    "top-k",
    "top-p",
    "min-p",
    "seed",
    "temperature",
    "num-keep",
}


class OllamaAdapter(EngineAdapter):
    """Ensures the model tag is pulled; the daemon itself is usually already running.

    Ollama has no per-server flags for most knobs — they are per request ``options`` — so
    the adapter exposes them through :meth:`request_extra_body`, which the runner merges
    into every chat request.
    """

    engine_id = "ollama"
    default_port = 11434

    def model_ref(self) -> str:
        """The Ollama tag (``qwen3.8:27b-q5_K_M``)."""
        model = self.spec.model
        if model.ollama_tag:
            return model.ollama_tag
        quant = self.registry.quant(model.id, model.quant_id) or {}
        return str(quant.get("ollama_tag") or model.hf_id or model.id)

    def serve_command(self) -> str:
        """Exact command line (``ollama serve`` plus the pull that precedes it)."""
        env = " ".join(f"{k}={v}" for k, v in (self.spec.engine.env or {}).items())
        pull = f"ollama pull {shlex.quote(self.model_ref())}"
        serve = f"{env + ' ' if env else ''}ollama serve"
        return f"{pull} && {serve}"

    def request_extra_body(self) -> dict[str, object]:
        """Per-request ``options`` derived from the packet args."""
        options = {
            str(k).lstrip("-").replace("_", "-"): v
            for k, v in self.spec.args.items()
            if str(k).lstrip("-").replace("_", "-") in _OPTION_ARGS
        }
        return {"options": {k.replace("-", "_"): v for k, v in options.items()}} if options else {}

    def prepare(self) -> list[str]:
        """``ollama pull`` the tag before measuring."""
        tag = self.model_ref()
        proc = subprocess.run(["ollama", "pull", tag], capture_output=True, text=True, check=False)
        if proc.returncode != 0:
            return [f"ollama pull {tag} failed: {proc.stderr.strip()[:200]}"]
        return [f"pulled {tag}"]
