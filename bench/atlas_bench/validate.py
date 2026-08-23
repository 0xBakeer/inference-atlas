"""Local pre-flight validation of result files (SPEC §5, items 1, 2, 4 and 5).

This is the same set of checks CI runs, minus the ones that need the GitHub context
(ownership against the PR author, duplicate detection across the whole repo, user-id
resolution). Running it before opening a PR is the difference between a green check and a
round trip.
"""

from __future__ import annotations

import json
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .canonical import canonicalize
from .ids import (
    cell_id,
    config_id_from_canonical,
    is_valid_id,
    is_valid_model_id,
    model_parts,
    run_suffix,
)
from .plausibility import check_plausibility
from .registry import Registry

__all__ = [
    "Issue",
    "check_model_registry",
    "format_issues",
    "validate_file",
    "validate_record",
]


@dataclass
class Issue:
    """One validation finding."""

    level: str  # error | warning
    code: str
    message: str
    path: str | None = None

    def __str__(self) -> str:
        location = f"{self.path}: " if self.path else ""
        return f"[{self.level}] {location}{self.code} — {self.message}"


def _reference_registry(registry: Registry) -> Any:
    """A ``referencing`` registry holding every local schema, keyed by its ``$id``.

    The Atlas schemas cross-reference each other by absolute URL; without this the
    validator would try to fetch ``inference-atlas.dev`` at validation time.
    """
    from referencing import Registry as RefRegistry
    from referencing import Resource

    resources = []
    for document in registry.schema_documents():
        uri = document.get("$id")
        if uri:
            resources.append((str(uri), Resource.from_contents(document)))
    return RefRegistry().with_resources(resources)


def _schema_issues(record: dict[str, Any], registry: Registry, path: str) -> list[Issue]:
    """Validate against ``schemas/result.schema.json`` when the schema exists."""
    schema = registry.schema("result")
    if schema is None:
        return [
            Issue(
                "warning",
                "schema-missing",
                "schemas/result.schema.json not found; structural validation skipped",
                path,
            )
        ]
    try:
        import jsonschema
    except ImportError:  # pragma: no cover - declared dependency
        return [Issue("warning", "jsonschema-missing", "jsonschema is not installed", path)]
    validator_cls = jsonschema.validators.validator_for(schema)
    validator = validator_cls(schema, registry=_reference_registry(registry))
    issues: list[Issue] = []
    for error in sorted(validator.iter_errors(record), key=lambda e: list(e.path)):
        pointer = "/".join(str(p) for p in error.path) or "<root>"
        issues.append(Issue("error", "schema", f"{pointer}: {error.message}", path))
    return issues


def _id_issues(record: dict[str, Any], registry: Registry, file_path: Path | None) -> list[Issue]:
    """Recompute every derived id and compare it with what the file claims."""
    issues: list[Issue] = []
    path = str(file_path) if file_path else None
    engine = record.get("engine") or {}
    model = record.get("model") or {}
    hardware = record.get("hardware") or {}
    resolved = registry.resolve_config(
        engine_id=str(engine.get("id")),
        engine_version=str(engine.get("version")),
        args=record.get("args") or {},
        quant_id=str(model.get("quant_id")),
        dtype=model.get("dtype"),
    )
    for warning in resolved.warnings:
        issues.append(Issue("warning", warning.split(":", 1)[0], warning, path))

    canonical = canonicalize(resolved.canonical_input)
    if record.get("args_canonical") != canonical:
        issues.append(
            Issue(
                "error",
                "args-canonical-mismatch",
                f"stored {record.get('args_canonical')!r} != recomputed {canonical!r}",
                path,
            )
        )
    expected_config = config_id_from_canonical(canonical)
    if record.get("config_id") != expected_config:
        issues.append(
            Issue(
                "error",
                "config-id-mismatch",
                f"stored {record.get('config_id')} != recomputed {expected_config}",
                path,
            )
        )
    if hardware.get("id"):
        expected_cell = cell_id(
            model_id=str(model.get("id")),
            quant_id=str(model.get("quant_id")),
            hardware_id=str(hardware.get("id")),
            hw_count=int(hardware.get("count") or 1),
            engine_id=str(engine.get("id")),
            engine_version=str(engine.get("version")),
        )
        if record.get("cell_id") != expected_cell:
            issues.append(
                Issue(
                    "error",
                    "cell-id-mismatch",
                    f"stored {record.get('cell_id')} != recomputed {expected_cell}",
                    path,
                )
            )
    else:
        issues.append(
            Issue(
                "error",
                "hardware-id-missing",
                "hardware.id is null — register the machine first (atlas-bench hwinfo)",
                path,
            )
        )

    provenance = record.get("provenance") or {}
    login = str(provenance.get("github_login") or "")
    started = str(provenance.get("started_at") or "")
    expected_run = f"{expected_config}--{record.get('workload_id')}--{run_suffix(login, started)}"
    if record.get("run_id") != expected_run:
        issues.append(
            Issue(
                "error",
                "run-id-mismatch",
                f"stored {record.get('run_id')} != recomputed {expected_run}",
                path,
            )
        )

    if file_path is not None:
        if file_path.name != f"{record.get('run_id')}.json":
            issues.append(
                Issue(
                    "error",
                    "filename-mismatch",
                    f"file must be named {record.get('run_id')}.json",
                    path,
                )
            )
        parts = file_path.resolve().parts
        owner, name = model_parts(str(model.get("id")))
        expected_tail = (
            "results",
            str(engine.get("id")),
            *[part for part in (owner, name) if part],
            str(hardware.get("id")),
        )
        depth = len(expected_tail)
        if len(parts) <= depth or tuple(parts[-depth - 1 : -1]) != expected_tail:
            issues.append(
                Issue(
                    "error",
                    "path-mismatch",
                    f"file must live at results/{'/'.join(expected_tail[1:])}/",
                    path,
                )
            )
    return issues


def _reference_issues(record: dict[str, Any], registry: Registry, path: str | None) -> list[Issue]:
    """Check that every id the result references exists in the registries (SPEC §5.4)."""
    issues: list[Issue] = []
    engine = record.get("engine") or {}
    model = record.get("model") or {}
    hardware = record.get("hardware") or {}
    for label, value in (
        ("engine.id", engine.get("id")),
        ("model.quant_id", model.get("quant_id")),
        ("hardware.id", hardware.get("id")),
        ("workload_id", record.get("workload_id")),
    ):
        if value is not None and not is_valid_id(value):
            issues.append(Issue("error", "id-format", f"{label}={value!r} is not kebab-case", path))
    # model_id is the Hugging Face repo id: case-preserved, exactly one slash. Nothing may
    # lowercase or kebab-case it (SPEC §2, decision 20).
    if model.get("id") is not None and not is_valid_model_id(model.get("id")):
        issues.append(
            Issue(
                "error",
                "model-id-format",
                f"model.id={model.get('id')!r} is not a Hugging Face repo id (<owner>/<name>)",
                path,
            )
        )

    # Under the HF-id contract these are the same string; a result that disagrees is
    # pointing at a different repo than the one it claims to measure (usually the quant's
    # weights repo, which belongs in the quant record).
    if model.get("hf_id") and model.get("id") and model["hf_id"] != model["id"]:
        issues.append(
            Issue(
                "error",
                "model-hf-id-mismatch",
                f"model.hf_id={model['hf_id']!r} must equal model.id={model['id']!r} "
                "(the quant's weights repo lives in the quant record)",
                path,
            )
        )

    if engine.get("id") and registry.engine_meta(str(engine["id"])) is None:
        issues.append(
            Issue("error", "unknown-engine", f"engines/{engine['id']}/meta.json is missing", path)
        )
    if model.get("id") and registry.model(str(model["id"])) is None:
        issues.append(
            Issue(
                "error",
                "unknown-model",
                f"models/{model['id']}/model.json is missing",
                path,
            )
        )
    quant = (
        registry.quant(str(model.get("id")), str(model.get("quant_id")))
        if model.get("id") and model.get("quant_id")
        else None
    )
    if model.get("quant_id") and quant is None:
        issues.append(
            Issue(
                "error",
                "unknown-quant",
                f"models/{model.get('id')}/quants/{model.get('quant_id')}.json is missing",
                path,
            )
        )
    elif (
        quant and engine.get("id") and quant.get("engines") and engine["id"] not in quant["engines"]
    ):
        issues.append(
            Issue(
                "error",
                "quant-engine-mismatch",
                f"quant {model.get('quant_id')} does not list engine {engine['id']}",
                path,
            )
        )
    if hardware.get("id") and registry.hardware(str(hardware["id"])) is None:
        issues.append(
            Issue("error", "unknown-hardware", f"hardware/{hardware['id']}.json is missing", path)
        )
    if record.get("workload_id") and registry.workload(str(record["workload_id"])) is None:
        issues.append(
            Issue(
                "error",
                "unknown-workload",
                f"workloads/{record['workload_id']}.json is missing",
                path,
            )
        )
    if (
        engine.get("id")
        and engine.get("version")
        and registry.engine_version(str(engine["id"]), str(engine["version"])) is None
    ):
        issues.append(
            Issue(
                "warning",
                "unknown-engine-version",
                f"engines/{engine['id']}/versions/{engine['version']}.json is missing",
                path,
            )
        )
    return issues


def _plausibility_issues(
    record: dict[str, Any], registry: Registry, path: str | None
) -> list[Issue]:
    """Sanity-check the numbers themselves (SPEC §5.5).

    Delegates to :mod:`atlas_bench.plausibility`, the port of the module CI runs, so a file
    that passes here passes ``pnpm validate`` too.
    """
    model_id = str((record.get("model") or {}).get("id") or "")
    quant_id = str((record.get("model") or {}).get("quant_id") or "")
    findings = check_plausibility(
        record,
        hardware=registry.hardware(str((record.get("hardware") or {}).get("id") or "")),
        model=registry.model(model_id),
        quant=registry.quant(model_id, quant_id),
        site=registry.site(),
    )
    return [
        Issue("error" if f.level == "error" else "warning", f.code, f.message, path)
        for f in findings
    ]


def validate_record(
    record: dict[str, Any], registry: Registry, file_path: Path | None = None
) -> list[Issue]:
    """Run every local check on one result record."""
    path = str(file_path) if file_path else None
    issues = _schema_issues(record, registry, path or "")
    issues += _id_issues(record, registry, file_path)
    issues += _reference_issues(record, registry, path)
    issues += _plausibility_issues(record, registry, path)
    return issues


def validate_file(path: Path | str, registry: Registry) -> list[Issue]:
    """Validate one result file on disk."""
    file_path = Path(path)
    try:
        record = json.loads(file_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        return [Issue("error", "unreadable", str(exc), str(file_path))]
    if not isinstance(record, dict):
        return [
            Issue(
                "error", "not-an-object", "result files must contain a JSON object", str(file_path)
            )
        ]
    return validate_record(record, registry, file_path)


def check_model_registry(registry: Registry) -> list[Issue]:
    """Registry-wide model checks that no single result file can see.

    Two model directories that differ only by case are the same directory on macOS and
    Windows, so one of them silently wins on a contributor's checkout and the ids stop
    round-tripping (SPEC §2, decision 20). ``model.json.hf_id`` must also equal the id: the
    directory layout *is* the Hugging Face repo id, and a mismatch means one of the two is a
    typo nobody would notice.
    """
    issues: list[Issue] = []
    seen: dict[str, str] = {}
    for model_id in registry.model_ids():
        relative = f"models/{model_id}/model.json"
        if not is_valid_model_id(model_id):
            issues.append(
                Issue(
                    "error",
                    "model-id-format",
                    f"{model_id!r} is not a Hugging Face repo id (<owner>/<name>)",
                    relative,
                )
            )
        folded = model_id.casefold()
        if folded in seen and seen[folded] != model_id:
            issues.append(
                Issue(
                    "error",
                    "model-id-case-collision",
                    f"{model_id!r} and {seen[folded]!r} differ only by case; they are one "
                    "directory on a case-insensitive filesystem",
                    relative,
                )
            )
        seen.setdefault(folded, model_id)

        record = registry.model(model_id)
        if isinstance(record, dict):
            if record.get("id") != model_id:
                issues.append(
                    Issue(
                        "error",
                        "model-id-mismatch",
                        f"model.json says id={record.get('id')!r} but it lives in {model_id}",
                        relative,
                    )
                )
            if record.get("hf_id") not in (None, model_id):
                issues.append(
                    Issue(
                        "error",
                        "model-hf-id-mismatch",
                        f"model.json hf_id={record.get('hf_id')!r} must equal the id {model_id!r}",
                        relative,
                    )
                )
    return issues


def format_issues(issues: Iterable[Issue]) -> str:
    """Render issues as newline-separated text."""
    return "\n".join(str(issue) for issue in issues)
