"""MLX adapter (``mlx_lm.server`` on Apple silicon)."""

from __future__ import annotations

import shlex

from .base import EngineAdapter

__all__ = ["MlxLmAdapter"]


class MlxLmAdapter(EngineAdapter):
    """Starts ``mlx_lm.server --model <hf-id> --port <port>``."""

    engine_id = "mlx-lm"
    default_port = 8080

    def serve_command(self) -> str:
        """Exact command line."""
        model = self.spec.model
        quant = self.registry.quant(model.id, model.quant_id) or {}
        reference = model.local_path or model.hf_id or quant.get("hf_id") or model.id
        tokens = [
            "mlx_lm.server",
            "--model",
            str(reference),
            *self.flags(),
            "--host",
            "127.0.0.1",
            "--port",
            str(self.port),
        ]
        return shlex.join(tokens)
