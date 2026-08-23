"""llama.cpp adapter (``llama-server`` with a local or downloaded GGUF)."""

from __future__ import annotations

import shlex
from pathlib import Path

from .base import EngineAdapter

__all__ = ["LlamaCppAdapter"]


class LlamaCppAdapter(EngineAdapter):
    """Starts ``llama-server -m <gguf> --host … --port …``.

    The GGUF comes from ``model.local_path`` when the contributor already has the file,
    otherwise it is fetched with ``huggingface_hub.hf_hub_download`` from
    ``model.gguf_repo`` (or the quant record's ``hf_id``) + ``model.gguf_file``.
    """

    engine_id = "llamacpp"
    default_port = 8080

    def gguf_path(self) -> str:
        """Path of the GGUF to serve (downloads it if necessary)."""
        model = self.spec.model
        if model.local_path:
            return model.local_path
        quant = self.registry.quant(model.id, model.quant_id) or {}
        repo = model.gguf_repo or quant.get("hf_id") or model.hf_id
        files = quant.get("files") or []
        filename = model.gguf_file or (files[0] if files else None)
        if not repo or not filename:
            raise ValueError(
                "llama.cpp needs a GGUF: set model.local_path, or model.gguf_repo + "
                "model.gguf_file, or register the quant with hf_id + files[]"
            )
        try:
            from huggingface_hub import hf_hub_download
        except ImportError as exc:  # pragma: no cover - optional dependency
            raise RuntimeError(
                "downloading a GGUF needs the 'hf' extra: uv pip install 'atlas-bench[hf]'"
            ) from exc
        return hf_hub_download(repo_id=repo, filename=filename, revision=model.revision)

    def serve_command(self) -> str:
        """Exact command line."""
        model_path = self.spec.model.local_path or self._cached_gguf() or "<gguf-path>"
        tokens = [
            "llama-server",
            "-m",
            model_path,
            *self.flags(),
            "--host",
            "127.0.0.1",
            "--port",
            str(self.port),
        ]
        return shlex.join(tokens)

    def _cached_gguf(self) -> str | None:
        """The GGUF path if it is already known, without triggering a download."""
        model = self.spec.model
        if model.local_path and Path(model.local_path).exists():
            return model.local_path
        return getattr(self, "_gguf", None)

    def prepare(self) -> list[str]:
        """Download the GGUF so ``serve_command`` can name a real path."""
        path = self.gguf_path()
        self._gguf = path
        return [f"gguf: {path}"]
