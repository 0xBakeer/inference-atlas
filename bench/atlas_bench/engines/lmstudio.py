"""LM Studio adapter — attach-only, with an optional ``lms load`` when the CLI is present."""

from __future__ import annotations

import shlex
import shutil
import subprocess

from .base import EngineAdapter, ServeResult

__all__ = ["LmStudioAdapter"]


class LmStudioAdapter(EngineAdapter):
    """LM Studio runs its own server; the harness attaches to ``:1234``.

    When the ``lms`` CLI is installed we can at least load the right model first, which is
    the only part of the configuration the harness controls.
    """

    engine_id = "lmstudio"
    default_port = 1234

    def serve_command(self) -> str:
        """The ``lms`` command that loads the model, or an attach note."""
        if shutil.which("lms"):
            return shlex.join(["lms", "load", self.model_ref(), "--yes"])
        return f"# LM Studio server expected at {self.base_url} (start it from the app)"

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
            notes.append("lms CLI not found; attaching to the running LM Studio server")
        return ServeResult(
            base_url=self.base_url, serve_command=self.serve_command(), started=False, notes=notes
        )

    def stop(self) -> None:
        """Never stop a server we did not start."""
        return None
