"""LM Studio adapter — attach-only, with an optional ``lms load`` when the CLI is present.

LM Studio is a desktop app that runs its own OpenAI-compatible server (``:1234`` by default),
so the harness never spawns it: the normal path is

    atlas-bench run --spec task.json --base-url http://localhost:1234/v1

Its model keys are its own: the app serves the Hugging Face repo ``google/gemma-4-E2B-it``
under the key ``google/gemma-4-e2b``. That key belongs in ``model.served_model_id`` — it is
what goes in the OpenAI ``model`` field, while ``model.id`` stays the repo id that every
computed id hashes.
"""

from __future__ import annotations

import shlex
import shutil
import subprocess

from .base import EngineAdapter, ServeResult

__all__ = ["LmStudioAdapter"]


class LmStudioAdapter(EngineAdapter):
    """Attaches to a running LM Studio server; loads the model through ``lms`` if it can."""

    engine_id = "lmstudio"
    default_port = 1234

    def model_ref(self) -> str:
        """The key LM Studio knows this model by (``lms load`` takes the same string)."""
        model = self.spec.model
        if model.served_model_id:
            return model.served_model_id
        quant = self.registry.quant(model.id, model.quant_id) or {}
        return str(quant.get("lmstudio_key") or model.local_path or model.hf_id or model.id)

    def serve_command(self) -> str | None:
        """``lms load <key>`` when the CLI is there, else null — the app was started by hand."""
        if shutil.which("lms"):
            return shlex.join(["lms", "load", self.model_ref(), "--yes"])
        return None

    def start(self) -> ServeResult:
        """Load the model through ``lms`` when possible; never spawn a server."""
        notes: list[str] = []
        if shutil.which("lms"):
            proc = subprocess.run(
                ["lms", "load", self.model_ref(), "--yes"],
                capture_output=True,
                text=True,
                check=False,
            )
            notes.append(
                f"lms load exited {proc.returncode}: {(proc.stderr or proc.stdout).strip()[:200]}"
            )
        else:
            notes.append(
                "lms CLI not found; attaching to the LM Studio server started from the app"
            )
        return ServeResult(
            base_url=self.base_url, serve_command=self.serve_command(), started=False, notes=notes
        )

    def stop(self) -> None:
        """Never stop a server we did not start."""
        return None
