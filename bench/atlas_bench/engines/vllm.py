"""vLLM adapter (docker or pip install)."""

from __future__ import annotations

import shlex
import subprocess

from .base import EngineAdapter, ServeResult, hf_cache_dir

__all__ = ["VllmAdapter"]


class VllmAdapter(EngineAdapter):
    """Starts ``vllm serve`` either natively or inside the official container.

    The official image ships an entrypoint that is not ``vllm``, so the docker form uses
    ``--entrypoint vllm … serve`` (this is the pattern that actually works with
    ``vllm/vllm-openai:*``, including the ``-aarch64`` build used on GB10).
    """

    engine_id = "vllm"
    default_port = 8000

    def image(self) -> str:
        """Container image for this version (packet wins over the engine meta)."""
        install = self.spec.engine.install
        if self.spec.engine.container:
            return self.spec.engine.container
        template = (install.image if install and install.image else None) or self._meta_image()
        return template.replace("{version}", self.spec.engine.version)

    def _meta_image(self) -> str:
        for entry in self.meta.get("install") or []:
            if entry.get("method") == "docker" and entry.get("image"):
                return str(entry["image"])
        return "vllm/vllm-openai:v{version}"

    def serve_command(self) -> str:
        """Exact command line, recorded in ``result.serve_command``."""
        flags = self.flags()
        model = self.model_ref()
        method = self.spec.engine.install.method if self.spec.engine.install else "docker"
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
                "--entrypoint",
                "vllm",
            ]
            for key, value in (self.spec.engine.env or {}).items():
                tokens.extend(["-e", f"{key}={value}"])
            tokens.append(self.image())
            tokens.extend(["serve", model, *flags, "--host", "0.0.0.0", "--port", str(self.port)])
        else:
            tokens = [
                "vllm",
                "serve",
                model,
                *flags,
                "--host",
                "127.0.0.1",
                "--port",
                str(self.port),
            ]
        if self.spec.model.served_name:
            tokens.extend(["--served-model-name", self.spec.model.served_name])
        return shlex.join(tokens)

    def prepare(self) -> list[str]:
        """Pull the container image when running the docker install method."""
        install = self.spec.engine.install
        if install and install.method != "docker":
            return []
        image = self.image()
        proc = subprocess.run(
            ["docker", "pull", image], capture_output=True, text=True, check=False
        )
        if proc.returncode != 0:
            return [f"docker pull {image} failed: {proc.stderr.strip()[:200]}"]
        return [f"pulled {image}"]

    def start(self) -> ServeResult:
        """Start vLLM and record the container image in the result."""
        result = super().start()
        install = self.spec.engine.install
        if not install or install.method == "docker":
            result.container = self.image()
        return result
