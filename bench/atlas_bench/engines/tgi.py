"""Text Generation Inference adapter (docker only, as upstream recommends)."""

from __future__ import annotations

import shlex

from .base import EngineAdapter, ServeResult, hf_cache_dir

__all__ = ["TgiAdapter"]


class TgiAdapter(EngineAdapter):
    """Starts ``ghcr.io/huggingface/text-generation-inference`` with ``--model-id``."""

    engine_id = "tgi"
    default_port = 8080

    def image(self) -> str:
        """Container image for this version."""
        install = self.spec.engine.install
        template = (
            self.spec.engine.container
            or (install.image if install and install.image else None)
            or "ghcr.io/huggingface/text-generation-inference:{version}"
        )
        return template.replace("{version}", self.spec.engine.version)

    def serve_command(self) -> str:
        """Exact command line."""
        tokens = [
            "docker",
            "run",
            "--rm",
            "--gpus",
            "all",
            "--shm-size",
            "1g",
            "-v",
            f"{hf_cache_dir()}:/data",
            "-p",
            f"{self.port}:80",
            self.image(),
            "--model-id",
            self.model_ref(),
            *self.flags(),
        ]
        return shlex.join(tokens)

    def start(self) -> ServeResult:
        """Start TGI and record the container image."""
        result = super().start()
        result.container = self.image()
        return result
