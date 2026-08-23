"""SGLang adapter (``sglang.launch_server`` or the lmsysorg container)."""

from __future__ import annotations

import shlex
import sys

from .base import EngineAdapter, hf_cache_dir

__all__ = ["SglangAdapter"]


class SglangAdapter(EngineAdapter):
    """Starts ``python -m sglang.launch_server`` (pip) or ``lmsysorg/sglang`` (docker)."""

    engine_id = "sglang"
    default_port = 30000

    def image(self) -> str:
        """Container image for this version."""
        install = self.spec.engine.install
        template = (
            self.spec.engine.container
            or (install.image if install and install.image else None)
            or "lmsysorg/sglang:v{version}"
        )
        return template.replace("{version}", self.spec.engine.version)

    def serve_command(self) -> str:
        """Exact command line."""
        flags = self.flags()
        model = self.model_ref()
        method = self.spec.engine.install.method if self.spec.engine.install else "pip"
        launcher = [
            "--model-path",
            model,
            *flags,
            "--host",
            "0.0.0.0" if method == "docker" else "127.0.0.1",
            "--port",
            str(self.port),
        ]
        if method == "docker":
            tokens = [
                "docker",
                "run",
                "--rm",
                "--gpus",
                "all",
                "--ipc=host",
                "-v",
                f"{hf_cache_dir()}:/root/.cache/huggingface",
                "-p",
                f"{self.port}:{self.port}",
                self.image(),
                "python3",
                "-m",
                "sglang.launch_server",
                *launcher,
            ]
        else:
            tokens = [sys.executable, "-m", "sglang.launch_server", *launcher]
        return shlex.join(tokens)
