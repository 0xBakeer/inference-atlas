"""TensorRT-LLM adapter (``trtllm-serve``)."""

from __future__ import annotations

import shlex

from .base import EngineAdapter

__all__ = ["TensorrtLlmAdapter"]


class TensorrtLlmAdapter(EngineAdapter):
    """Starts ``trtllm-serve <model> --host … --port …``."""

    engine_id = "tensorrt-llm"
    default_port = 8000

    def serve_command(self) -> str:
        """Exact command line."""
        tokens = [
            "trtllm-serve",
            self.model_ref(),
            *self.flags(),
            "--host",
            "127.0.0.1",
            "--port",
            str(self.port),
        ]
        return shlex.join(tokens)
