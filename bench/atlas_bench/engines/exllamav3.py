"""ExLlamaV3 adapter — attach to a TabbyAPI-style OpenAI server.

ExLlamaV3 has no canonical server of its own; contributors run it behind TabbyAPI. The
adapter therefore attaches by default and only records the command TabbyAPI is normally
started with, so the result stays reproducible.
"""

from __future__ import annotations

import shlex

from .base import EngineAdapter, ServeResult

__all__ = ["ExllamaV3Adapter"]


class ExllamaV3Adapter(EngineAdapter):
    """Attach-only adapter for TabbyAPI/ExLlamaV3."""

    engine_id = "exllamav3"
    default_port = 5000

    def serve_command(self) -> str:
        """The TabbyAPI command a contributor would run by hand."""
        tokens = [
            "python",
            "start.py",
            "--model-name",
            self.model_ref(),
            *self.flags(),
            "--host",
            "127.0.0.1",
            "--port",
            str(self.port),
        ]
        return f"# tabbyAPI: {shlex.join(tokens)}"

    def start(self) -> ServeResult:
        """Attach; never spawn."""
        return ServeResult(
            base_url=self.base_url,
            serve_command=self.serve_command(),
            started=False,
            notes=["exllamav3 is attach-only: start TabbyAPI yourself and pass --base-url"],
        )

    def stop(self) -> None:
        """Nothing to stop."""
        return None
