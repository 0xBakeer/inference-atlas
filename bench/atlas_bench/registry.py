"""Read-only access to the Atlas registries (``hardware/``, ``engines/``, ``models/`` …).

Everything the harness needs to canonicalize a config and to fill in a result record
comes from these files. All lookups return ``None`` instead of raising so the harness
still produces a (warned-about) result on a machine whose registry entry is missing.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .canonical import CanonicalInput, ParamSpec
from .ids import model_parts
from .repo import find_repo_root, read_json

__all__ = ["Registry", "ResolvedConfig"]


@dataclass
class ResolvedConfig:
    """The canonicalization input for a run plus any warnings collected on the way."""

    canonical_input: CanonicalInput
    warnings: list[str]


class Registry:
    """Lazy loader for the JSON registries of one checkout."""

    def __init__(self, root: Path | str | None = None) -> None:
        resolved = Path(root).expanduser().resolve() if root else find_repo_root()
        self.root: Path = resolved or Path.cwd()
        self._cache: dict[str, Any] = {}

    # ---------------------------------------------------------------- generic

    def _json(self, rel: str) -> Any | None:
        if rel not in self._cache:
            self._cache[rel] = read_json(self.root / rel)
        return self._cache[rel]

    def exists(self, rel: str) -> bool:
        """True when a repo-relative path exists in this checkout."""
        return (self.root / rel).exists()

    # --------------------------------------------------------------- hardware

    def hardware_files(self) -> list[Path]:
        """All ``hardware/*.json`` files, sorted by id."""
        directory = self.root / "hardware"
        return sorted(directory.glob("*.json")) if directory.is_dir() else []

    def hardware_all(self) -> list[dict[str, Any]]:
        """Every hardware record in the registry."""
        out: list[dict[str, Any]] = []
        for path in self.hardware_files():
            data = read_json(path)
            if isinstance(data, dict):
                out.append(data)
        return out

    def hardware(self, hardware_id: str) -> dict[str, Any] | None:
        """One hardware record by id (falls back to a scan over ``aliases``)."""
        direct = self._json(f"hardware/{hardware_id}.json")
        if isinstance(direct, dict):
            return direct
        for record in self.hardware_all():
            if hardware_id in (record.get("aliases") or []):
                return record
        return None

    # ---------------------------------------------------------------- engines

    def engine_meta(self, engine_id: str) -> dict[str, Any] | None:
        """``engines/<id>/meta.json``."""
        data = self._json(f"engines/{engine_id}/meta.json")
        return data if isinstance(data, dict) else None

    def engine_version(self, engine_id: str, version: str) -> dict[str, Any] | None:
        """``engines/<id>/versions/<version>.json``."""
        data = self._json(f"engines/{engine_id}/versions/{version}.json")
        return data if isinstance(data, dict) else None

    # ----------------------------------------------------------------- models

    def model_dir(self, model_id: str) -> Path:
        """Directory of a model: ``models/<owner>/<name>`` (SPEC §2, decision 20).

        The model id is a Hugging Face repo id, so its two halves are two directory levels.
        Nothing is lowercased on the way — the id is the repo id, verbatim.
        """
        owner, name = model_parts(model_id)
        parts = [part for part in (owner, name) if part]
        return self.root.joinpath("models", *parts)

    def model(self, model_id: str) -> dict[str, Any] | None:
        """``models/<owner>/<name>/model.json``."""
        data = read_json(self.model_dir(model_id) / "model.json")
        return data if isinstance(data, dict) else None

    def quant(self, model_id: str, quant_id: str) -> dict[str, Any] | None:
        """``models/<owner>/<name>/quants/<quant-id>.json``."""
        data = read_json(self.model_dir(model_id) / "quants" / f"{quant_id}.json")
        return data if isinstance(data, dict) else None

    def model_files(self) -> list[Path]:
        """Every ``models/<owner>/<name>/model.json`` in the registry."""
        directory = self.root / "models"
        return sorted(directory.glob("*/*/model.json")) if directory.is_dir() else []

    def model_ids(self) -> list[str]:
        """Ids of every registered model, derived from the directory layout."""
        return [f"{path.parent.parent.name}/{path.parent.name}" for path in self.model_files()]

    # -------------------------------------------------- workloads & datasets

    def workload(self, workload_id: str) -> dict[str, Any] | None:
        """``workloads/<id>.json``."""
        data = self._json(f"workloads/{workload_id}.json")
        return data if isinstance(data, dict) else None

    def dataset(self, dataset_id: str) -> dict[str, Any] | None:
        """``datasets/<id>/dataset.json``."""
        data = self._json(f"datasets/{dataset_id}/dataset.json")
        return data if isinstance(data, dict) else None

    def dataset_dir(self, dataset_id: str) -> Path:
        """Directory holding a dataset's data files."""
        return self.root / "datasets" / dataset_id

    def site(self) -> dict[str, Any]:
        """``site/config.json`` (empty dict when the checkout has none)."""
        data = self._json("site/config.json")
        return data if isinstance(data, dict) else {}

    def schema_documents(self) -> list[dict[str, Any]]:
        """Every ``schemas/*.schema.json`` document in this checkout.

        Needed because the schemas ``$ref`` each other by absolute ``$id`` URL
        (``https://inference-atlas.dev/schemas/common.schema.json``), which only resolves
        offline if all of them are handed to the validator up front.
        """
        directory = self.root / "schemas"
        if not directory.is_dir():
            return []
        documents: list[dict[str, Any]] = []
        for path in sorted(directory.glob("*.schema.json")):
            data = read_json(path)
            if isinstance(data, dict):
                documents.append(data)
        return documents

    def schema(self, name: str) -> dict[str, Any] | None:
        """``schemas/<name>.schema.json`` when the schemas package exists."""
        data = self._json(f"schemas/{name}.schema.json")
        return data if isinstance(data, dict) else None

    # ------------------------------------------------------- canonicalization

    def resolve_config(
        self,
        *,
        engine_id: str,
        engine_version: str,
        args: dict[str, Any],
        quant_id: str,
        dtype: str | None,
        build: str | None = None,
    ) -> ResolvedConfig:
        """Build the :class:`CanonicalInput` for a run from the registries.

        The engine meta contributes ``drop_params`` and ``param_aliases``; the version file
        contributes the params (with their types, defaults and per-param aliases). A missing
        version file means ``params is None`` — nothing is dropped as a default and the
        caller gets an ``unknown-engine-version`` warning, exactly as SPEC §3.2 requires.
        """
        warnings: list[str] = []
        meta = self.engine_meta(engine_id) or {}
        if not meta:
            warnings.append(f"unknown-engine:{engine_id}")
        version = self.engine_version(engine_id, engine_version)
        if version is None:
            warnings.append(f"unknown-engine-version:{engine_id}@{engine_version}")
        elif version.get("distribution") == "fork" and not (build or "").strip():
            # The validator refuses this on review; failing here means the contributor finds
            # out before the run rather than after it.
            warnings.append(f"fork-build-unnamed:{engine_id}@{engine_version}")

        params: tuple[ParamSpec, ...] | None = None
        if version is not None:
            params = tuple(
                ParamSpec(
                    name=str(raw.get("name", "")),
                    default=raw.get("default"),
                    aliases=tuple(str(a) for a in raw.get("aliases") or ()),
                    type=raw.get("type"),
                    has_default="default" in raw,
                )
                for raw in version.get("params") or ()
                if raw.get("name")
            )

        return ResolvedConfig(
            canonical_input=CanonicalInput(
                engine_id=engine_id,
                engine_version=engine_version,
                args=dict(args or {}),
                quant_id=quant_id,
                dtype=dtype,
                params=params,
                drop_params=tuple(str(d) for d in (meta.get("drop_params") or ())),
                param_aliases={
                    str(k): str(v) for k, v in (meta.get("param_aliases") or {}).items()
                },
                build=build,
            ),
            warnings=warnings,
        )
