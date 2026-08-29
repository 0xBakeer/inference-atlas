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

import json
import shlex
import shutil
import subprocess
from typing import Any

from .base import EngineAdapter, ServeResult

__all__ = ["LmStudioAdapter"]


class LmStudioAdapter(EngineAdapter):
    """Attaches to a running LM Studio server; loads the model through ``lms`` if it can."""

    engine_id = "lmstudio"
    default_port = 1234

    def model_ref(self) -> str:
        """The key LM Studio knows this model by (``lms load`` takes the same string).

        There used to be a ``quant["lmstudio_key"]`` fallback ahead of ``local_path``. It was
        unreachable: ``lmstudio_key`` is not in ``schemas/quant.schema.json``, and quant records
        are ``additionalProperties: false``, so a contributor who set it would fail validation.
        Nothing in the repository ever wrote it. The per-run escape hatch is ``served_model_id``
        on the packet, which is the right scope for it — what one machine's app indexed a
        download as is not a property of the weights and does not belong in a shared registry.
        """
        model = self.spec.model
        if model.served_model_id:
            return model.served_model_id
        return str(model.local_path or model.hf_id or model.id)

    def serve_command(self) -> str | None:
        """``lms load <key>`` when the CLI is there, else null — the app was started by hand."""
        if shutil.which("lms"):
            return shlex.join(["lms", "load", self.model_ref(), "--yes"])
        return None

    def _resident(self) -> list[dict[str, Any]]:
        """Instances LM Studio currently has loaded, from ``lms ps --json``."""
        proc = subprocess.run(["lms", "ps", "--json"], capture_output=True, text=True, check=False)
        if proc.returncode != 0:
            return []
        try:
            listed = json.loads(proc.stdout or "[]")
        except json.JSONDecodeError:
            return []
        return listed if isinstance(listed, list) else []

    def start(self) -> ServeResult:
        """Reuse the resident instance when there is one; never spawn a server.

        ``lms load <key> --yes`` is NOT idempotent. With the model already loaded it exits 0,
        prints no warning, and loads a SECOND instance under ``<key>:2`` at the app's defaults
        rather than the flags the packet asked for. Both then answer ``/v1/models``, so a run
        can be served by an instance whose configuration is not the one recorded in ``args`` —
        which is the "silently lower the configuration" failure AGENTS.md rule 3 forbids, except
        the harness would be doing it to itself. Reported with a reproduction by @bumasoft.

        A mismatch is a hard error rather than an unload-and-reload: the box may be shared, and
        unloading a model another run is using would destroy somebody else's measurement.
        """
        notes: list[str] = []
        if shutil.which("lms"):
            ref = self.model_ref()
            wanted_ctx = self.spec.args.get("context-length")
            wanted_par = self.spec.args.get("parallel")
            # Match on both: model_ref falls through to the Hugging Face repo id when the packet
            # sets no served_model_id, and LM Studio answers to that as indexedModelIdentifier
            # while the resident instance is keyed by the short modelKey.
            match = next(
                (
                    inst
                    for inst in self._resident()
                    if ref in (inst.get("modelKey"), inst.get("indexedModelIdentifier"))
                ),
                None,
            )
            if match is not None:
                got_ctx = match.get("contextLength")
                got_par = match.get("parallel")
                ident = match.get("identifier", ref)
                if (wanted_ctx is not None and got_ctx != wanted_ctx) or (
                    wanted_par is not None and got_par != wanted_par
                ):
                    raise RuntimeError(
                        f"LM Studio already has {ref!r} loaded as {ident!r} with "
                        f"context-length={got_ctx}, parallel={got_par}, but this packet asks for "
                        f"context-length={wanted_ctx}, parallel={wanted_par}. Loading again would "
                        f"stack a second instance at the app defaults instead of reconfiguring "
                        f"this one. Unload it yourself and rerun, or fix the packet — the harness "
                        f"will not unload a model it did not load."
                    )
                notes.append(
                    f"reusing the resident instance {ident!r} "
                    f"(context-length={got_ctx}, parallel={got_par}); lms load not called, "
                    f"because it would have stacked a second copy at the app defaults"
                )
                return ServeResult(
                    base_url=self.base_url,
                    serve_command=self.serve_command(),
                    started=False,
                    notes=notes,
                )
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
