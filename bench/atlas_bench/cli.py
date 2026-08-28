"""``atlas-bench`` command line interface (SPEC §8).

Commands
--------
``hwinfo``   capture this machine truthfully and match it against ``hardware/*.json``
``serve``    start the engine described by a packet and wait for it to become healthy
``run``      run every workload of a packet and write result files
``validate`` local pre-flight of result files (schema, ids, path, plausibility)
``submit``   branch + commit + ``gh pr create`` for new result files only
``packet``   print the agent packet for a cell
``wrap``     turn an engine-native benchmark JSON into an Atlas result file
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

import typer
from rich.console import Console
from rich.syntax import Syntax
from rich.table import Table

from . import __version__
from . import hwinfo as hwinfo_module
from .client import utc_now
from .engines.base import get_adapter
from .packet import build_packet, find_cell, parse_cell, write_packet
from .registry import Registry
from .repo import find_repo_root, write_json
from .result import ResultInputs, build_result, output_path, resolve_login
from .runner import run_spec_sync
from .spec import RunConditions, load_spec
from .submit import submit as do_submit
from .validate import check_model_registry, validate_file
from .workloads import resolve_workload
from .workloads.base import WorkloadOutcome
from .wrap import load_native, native_started_at, wrap_metrics

app = typer.Typer(
    add_completion=False,
    help="Inference Atlas benchmark harness — measure an engine, emit a result file.",
)
console = Console()
error_console = Console(stderr=True)


def _registry(repo: Path | None) -> Registry:
    """Registry rooted at ``--repo``/``--registry-dir`` or the discovered checkout."""
    return Registry(repo)


def _conditions_option(
    dedicated: bool | None, detail: str | None, isolation_check: str | None
) -> RunConditions | None:
    """Build the ``conditions`` record from CLI flags.

    ``--dedicated``/``--not-dedicated`` is the anchor: detail and the isolation check only
    mean something relative to it, so passing them alone is an error rather than a guess.
    """
    if dedicated is None:
        if detail or isolation_check:
            raise typer.BadParameter(
                "--conditions-detail/--isolation-check need --dedicated or --not-dedicated"
            )
        return None
    return RunConditions(dedicated=dedicated, detail=detail, isolation_check=isolation_check)


def _parse_kv(pairs: list[str]) -> dict[str, Any]:
    """Parse ``--arg key=value`` pairs; values are JSON when parseable, else strings."""
    out: dict[str, Any] = {}
    for pair in pairs:
        if "=" not in pair:
            raise typer.BadParameter(f"expected key=value, got {pair!r}")
        key, _, value = pair.partition("=")
        try:
            out[key.strip()] = json.loads(value)
        except json.JSONDecodeError:
            out[key.strip()] = value
    return out


@app.callback(invoke_without_command=True)
def _root(
    ctx: typer.Context,
    version: bool = typer.Option(False, "--version", help="Print the harness version and exit."),
) -> None:
    """Root callback: handles ``--version`` and bare invocations."""
    if version:
        console.print(f"atlas-bench {__version__}")
        raise typer.Exit()
    if ctx.invoked_subcommand is None:
        console.print(ctx.get_help())
        raise typer.Exit()


# ---------------------------------------------------------------------- hwinfo


@app.command()
def hwinfo(
    json_out: bool = typer.Option(False, "--json", help="Print the captured info as JSON."),
    registry_dir: Path | None = typer.Option(
        None, "--registry-dir", "--repo", help="Atlas checkout to match against."
    ),
    write_draft: Path | None = typer.Option(
        None, "--write-draft", help="Write the hardware draft to this path when unmatched."
    ),
) -> None:
    """Capture this machine and match it against the hardware registry."""
    info = hwinfo_module.collect()
    registry = _registry(registry_dir)
    matched, candidates = hwinfo_module.match_hardware(info, registry)

    if json_out:
        payload = info.to_dict()
        payload["hardware_id"] = matched
        payload["candidates"] = candidates
        if matched is None:
            payload["draft"] = hwinfo_module.draft_hardware_file(info)
        console.print_json(json.dumps(payload))
        return

    table = Table(title="Captured hardware", show_header=False, box=None)
    table.add_row("platform", f"{info.platform} / {info.arch}")
    table.add_row("os", info.os)
    table.add_row("kernel", info.kernel)
    table.add_row("cpu", info.cpu or "—")
    table.add_row("ram_gb", str(info.ram_gb or "—"))
    for index, gpu in enumerate(info.gpus):
        memory = f"{gpu.memory_total_mb / 1024:.1f} GB" if gpu.memory_total_mb else "—"
        table.add_row(f"gpu[{index}]", f"{gpu.name} · {memory} · driver {gpu.driver or '—'}")
    table.add_row("cuda", info.cuda or "—")
    table.add_row("tools", ", ".join(info.tools) or "none")
    table.add_row("fingerprint", hwinfo_module.fingerprint(info))
    console.print(table)

    if matched:
        console.print(f"\n[bold green]hardware_id:[/] {matched}")
        return

    console.print("\n[bold yellow]hardware_id: null[/] — this machine matches no registry entry.")
    if candidates:
        console.print(f"near misses: {[c['id'] for c in candidates]}")
    draft = hwinfo_module.draft_hardware_file(info)
    console.print(
        f"\nCreate [bold]hardware/{draft['id']}.json[/] from this draft "
        "(fill the null fields from the vendor spec sheet, then re-run):\n"
    )
    console.print(Syntax(json.dumps(draft, indent=2), "json", theme="ansi_dark"))
    if write_draft:
        write_json(write_draft, draft)
        console.print(f"\nwrote {write_draft}")


# ----------------------------------------------------------------------- serve


@app.command()
def serve(
    spec_path: Path = typer.Option(..., "--spec", help="Task packet JSON."),
    engine_adapter_only: bool = typer.Option(
        False, "--engine-adapter-only", help="Print the serve command and base URL, start nothing."
    ),
    registry_dir: Path | None = typer.Option(None, "--registry-dir", "--repo"),
    log_dir: Path | None = typer.Option(None, "--log-dir", help="Where to write engine logs."),
    timeout_s: float = typer.Option(900.0, "--timeout", help="Health-check timeout in seconds."),
    skip_prepare: bool = typer.Option(False, "--skip-prepare", help="Do not pull images/weights."),
) -> None:
    """Start the engine described by a packet and wait until it is healthy."""
    spec = load_spec(spec_path)
    registry = _registry(registry_dir)
    # `serve` is explicitly the command that starts an engine, so it asks for a real adapter
    # even when the packet already names a base_url.
    adapter = get_adapter(spec, registry, attach=False, log_dir=str(log_dir) if log_dir else None)

    if engine_adapter_only:
        console.print(f"[bold]adapter[/]     {type(adapter).__name__}")
        console.print(f"[bold]base_url[/]    {adapter.base_url}")
        command = adapter.serve_command()
        console.print(
            f"[bold]command[/]     {command}"
            if command
            else "[bold]command[/]     — attach only: start the server yourself, then "
            "`run --base-url`"
        )
        return

    if not skip_prepare:
        for note in adapter.prepare():
            console.print(f"[dim]{note}[/]")
    result = adapter.start()
    if result.serve_command:
        console.print(f"[dim]{result.serve_command}[/]")
    for note in result.notes:
        console.print(f"[yellow]{note}[/]")
    if not adapter.wait_healthy(timeout_s=timeout_s):
        error_console.print("[bold red]engine did not become healthy[/]")
        raise typer.Exit(code=1)
    console.print(f"[bold green]healthy[/] {adapter.base_url}")
    console.print(f"models: {', '.join(adapter.list_models()) or '—'}")


# ------------------------------------------------------------------------- run


@app.command()
def run(
    spec_path: Path = typer.Option(..., "--spec", help="Task packet JSON."),
    base_url: str | None = typer.Option(
        None, "--base-url", help="Attach to an already running engine (the common path)."
    ),
    out: Path = typer.Option(Path("results"), "--out", help="Results directory or repo root."),
    dry_run: bool = typer.Option(False, "--dry-run", help="Resolve and print the plan only."),
    registry_dir: Path | None = typer.Option(None, "--registry-dir", "--repo"),
    login: str | None = typer.Option(None, "--login", help="GitHub login for provenance."),
    notes: str | None = typer.Option(None, "--notes", help="provenance.notes for this run."),
    dedicated: bool | None = typer.Option(
        None,
        "--dedicated/--not-dedicated",
        help="Run conditions: was the box dedicated to this run? Falls back to the packet's "
        "`conditions`; omitted entirely when neither is given.",
    ),
    conditions_detail: str | None = typer.Option(
        None, "--conditions-detail", help="What else was resident or reachable (asserted)."
    ),
    isolation_check: str | None = typer.Option(
        None, "--isolation-check", help="What was MEASURED about isolation, not just asserted."
    ),
    gotcha: list[str] = typer.Option([], "--gotcha", help="Add a gotcha (repeatable)."),
    telemetry: bool = typer.Option(True, "--telemetry/--no-telemetry"),
    tokenizer: str | None = typer.Option(
        None, "--tokenizer", help="HF tokenizer id, only for engines that report no usage."
    ),
) -> None:
    """Run every workload in the packet and write result files."""
    spec = load_spec(spec_path)
    if tokenizer:
        spec.tokenizer = tokenizer
    conditions = _conditions_option(dedicated, conditions_detail, isolation_check)
    registry = _registry(registry_dir)
    resolved_login = resolve_login(login or spec.github_login)
    if not resolved_login and not dry_run:
        error_console.print(
            "[bold red]no GitHub login[/] — pass --login, set ATLAS_GITHUB_LOGIN, or run "
            "`gh auth login`. run_id and ownership both depend on it."
        )
        raise typer.Exit(code=2)

    output = run_spec_sync(
        spec,
        registry=registry,
        out_dir=out,
        github_login=resolved_login or "unknown",
        base_url=base_url,
        dry_run=dry_run,
        telemetry=telemetry,
        gotchas=list(gotcha),
        notes=notes,
        conditions=conditions,
    )

    if dry_run:
        table = Table(title="Planned workloads")
        table.add_column("workload")
        table.add_column("kind")
        table.add_column("dataset")
        table.add_column("registered")
        table.add_column("params", overflow="fold")
        for entry in output.plan:
            table.add_row(
                entry["workload_id"],
                str(entry["kind"]),
                str(entry["dataset_id"] or "—"),
                "yes" if entry["registered"] else "NO",
                json.dumps(entry["params"], sort_keys=True),
            )
        console.print(table)
    else:
        _print_summary(output.records, output.paths)

    for warning in dict.fromkeys(output.warnings):
        error_console.print(f"[yellow]warning:[/] {warning}")


def _print_summary(records: list[dict[str, Any]], paths: list[Path]) -> None:
    """Print the per-workload summary table of a run."""
    table = Table(title="Runs")
    for column in (
        "workload",
        "kind",
        "output tok/s",
        "ttft p50 ms",
        "tpot p50 ms",
        "accuracy",
        "success",
        "file",
    ):
        table.add_column(column, overflow="fold")
    for record, path in zip(records, paths, strict=False):
        metrics = record.get("metrics") or {}
        scores = record.get("scores") or {}
        table.add_row(
            str(record.get("workload_id")),
            str(record.get("kind")),
            _fmt(metrics.get("output_tok_s")),
            _fmt((metrics.get("ttft_ms") or {}).get("p50")),
            _fmt((metrics.get("tpot_ms") or {}).get("p50")),
            _fmt(scores.get("accuracy")),
            _fmt(metrics.get("success_rate")),
            str(path),
        )
    console.print(table)


def _fmt(value: Any) -> str:
    """Format a metric for the summary table."""
    if value is None:
        return "—"
    if isinstance(value, float):
        return f"{value:.3f}".rstrip("0").rstrip(".")
    return str(value)


# -------------------------------------------------------------------- validate


@app.command()
def validate(
    files: list[Path] = typer.Argument(..., help="Result files to validate."),
    registry_dir: Path | None = typer.Option(None, "--registry-dir", "--repo"),
    strict: bool = typer.Option(False, "--strict", help="Treat warnings as errors."),
) -> None:
    """Validate result files locally (schema, recomputed ids, path, plausibility)."""
    registry = _registry(registry_dir)
    targets: list[Path] = []
    for entry in files:
        targets.extend(sorted(entry.rglob("*.json")) if entry.is_dir() else [entry])

    errors = 0
    warnings = 0

    # Registry-wide model checks first: a case-only directory clash or a model.json that
    # disagrees with its own path breaks every result that references it.
    registry_issues = check_model_registry(registry)
    if registry_issues:
        console.print("[bold]models/[/]")
        for issue in registry_issues:
            colour = "red" if issue.level == "error" else "yellow"
            console.print(f"  [{colour}]{issue.level}[/] {issue.code} — {issue.message}")
            errors += issue.level == "error"
            warnings += issue.level == "warning"

    for target in targets:
        issues = validate_file(target, registry)
        if not issues:
            console.print(f"[green]ok[/] {target}")
            continue
        console.print(f"[bold]{target}[/]")
        for issue in issues:
            colour = "red" if issue.level == "error" else "yellow"
            console.print(f"  [{colour}]{issue.level}[/] {issue.code} — {issue.message}")
            errors += issue.level == "error"
            warnings += issue.level == "warning"
    console.print(f"\n{len(targets)} file(s), {errors} error(s), {warnings} warning(s)")
    if errors or (strict and warnings):
        raise typer.Exit(code=1)


# ---------------------------------------------------------------------- submit


@app.command()
def submit(
    directory: Path = typer.Option(..., "--dir", help="Directory (or file) of new results."),
    draft: bool = typer.Option(False, "--draft", help="Open the PR as a draft."),
    dry_run: bool = typer.Option(False, "--dry-run", help="Print the plan, change nothing."),
    registry_dir: Path | None = typer.Option(None, "--registry-dir", "--repo"),
    push: bool = typer.Option(True, "--push/--no-push", help="Push and open the PR."),
) -> None:
    """Commit the new result files on a branch and open the pull request."""
    repo = Path(registry_dir).resolve() if registry_dir else (find_repo_root() or Path.cwd())
    paths = sorted(directory.rglob("*.json")) if directory.is_dir() else [directory]
    if not paths:
        error_console.print(f"[bold red]no result files under {directory}[/]")
        raise typer.Exit(code=2)
    try:
        plan = do_submit(repo, paths, draft=draft, dry_run=dry_run, push=push)
    except RuntimeError as exc:
        error_console.print(f"[bold red]{exc}[/]")
        raise typer.Exit(code=1) from exc
    console.print(f"[bold]branch[/]  {plan.branch}")
    console.print(f"[bold]commit[/]  {plan.commit_message}")
    console.print(f"[bold]files[/]   {len(plan.files)}")
    if dry_run:
        console.print("\n" + plan.pr_body)


# ---------------------------------------------------------------------- packet


@app.command()
def packet(
    cell: str | None = typer.Option(
        None, "--cell", help="Cell as engine@version/model/quant/hardware, or a 12-hex cell_id."
    ),
    engine: str | None = typer.Option(None, "--engine"),
    engine_version: str | None = typer.Option(None, "--engine-version"),
    model: str | None = typer.Option(None, "--model"),
    quant: str | None = typer.Option(None, "--quant"),
    hardware: str | None = typer.Option(None, "--hardware"),
    workload: list[str] = typer.Option([], "--workload", help="Workload id (repeatable)."),
    arg: list[str] = typer.Option([], "--arg", help="Engine arg as key=value (repeatable)."),
    hw_count: int = typer.Option(1, "--hw-count"),
    repo_url: str | None = typer.Option(None, "--repo-url"),
    out: Path | None = typer.Option(None, "--out", help="Write the packet here instead of stdout."),
    registry_dir: Path | None = typer.Option(None, "--registry-dir", "--repo"),
) -> None:
    """Print the agent task packet for one cell."""
    registry = _registry(registry_dir)
    parts: dict[str, str] | None = None
    if cell:
        parts = parse_cell(cell) or find_cell(registry, cell)
        if parts is None:
            error_console.print(
                "[bold red]could not resolve --cell[/] — use "
                "engine@version/model/quant/hardware or a known cell_id"
            )
            raise typer.Exit(code=2)
    if parts is None:
        missing = [
            name
            for name, value in (
                ("--engine", engine),
                ("--engine-version", engine_version),
                ("--model", model),
                ("--quant", quant),
            )
            if not value
        ]
        if missing:
            error_console.print(f"[bold red]missing {', '.join(missing)}[/]")
            raise typer.Exit(code=2)
        parts = {
            "engine_id": str(engine),
            "engine_version": str(engine_version),
            "model_id": str(model),
            "quant_id": str(quant),
            "hardware_id": hardware or "",
        }
    built = build_packet(
        registry,
        engine_id=parts["engine_id"],
        engine_version=parts["engine_version"],
        model_id=parts["model_id"],
        quant_id=parts["quant_id"],
        hardware_id=hardware or parts["hardware_id"] or None,
        workloads=list(workload),
        args=_parse_kv(arg),
        hw_count=hw_count,
        repo=repo_url,
    )
    if out:
        write_packet(built, out)
        console.print(f"wrote {out}")
    else:
        console.print_json(json.dumps(built))


# ------------------------------------------------------------------------ wrap


@app.command()
def wrap(
    raw_file: Path = typer.Argument(..., help="Engine-native benchmark JSON."),
    spec_path: Path = typer.Option(..., "--spec", help="Task packet describing the cell."),
    workload_id: str | None = typer.Option(
        None, "--workload", help="Workload id (defaults to the packet's first)."
    ),
    out: Path = typer.Option(Path("results"), "--out"),
    registry_dir: Path | None = typer.Option(None, "--registry-dir", "--repo"),
    login: str | None = typer.Option(None, "--login"),
    notes: str | None = typer.Option(None, "--notes"),
    dedicated: bool | None = typer.Option(None, "--dedicated/--not-dedicated"),
    conditions_detail: str | None = typer.Option(None, "--conditions-detail"),
    isolation_check: str | None = typer.Option(None, "--isolation-check"),
) -> None:
    """Wrap ``vllm bench serve`` / SGLang ``bench_serving`` output into a result file."""
    spec = load_spec(spec_path)
    registry = _registry(registry_dir)
    resolved_login = resolve_login(login or spec.github_login)
    if not resolved_login:
        error_console.print("[bold red]no GitHub login[/] — pass --login")
        raise typer.Exit(code=2)

    raw = load_native(raw_file)
    metrics, resolved_params, source = wrap_metrics(raw)
    if source == "unknown":
        error_console.print(
            "[yellow]unrecognized benchmark JSON[/] — mapped what could be matched; "
            "check the result before submitting"
        )
    ref = next(
        (w for w in spec.workloads if workload_id is None or w.id == workload_id),
        None,
    )
    if ref is None:
        error_console.print(f"[bold red]workload {workload_id} is not in the packet[/]")
        raise typer.Exit(code=2)
    workload, _ = resolve_workload(registry, ref)

    info = hwinfo_module.collect()
    if not spec.hardware.id:
        matched, _ = hwinfo_module.match_hardware(info, registry)
        spec.hardware.id = matched
    outcome = WorkloadOutcome(
        kind=str(workload.get("kind") or "serving"),
        metrics=metrics,
        resolved_params=resolved_params,
        raw={"source": source, "native": raw},
        gotchas=[
            {
                "severity": "info",
                "text": f"Numbers were produced by {source}, not by atlas-bench; metrics that "
                "harness does not report are null.",
            }
        ],
    )
    adapter = get_adapter(spec, registry, attach=True)
    record = build_result(
        ResultInputs(
            spec=spec,
            registry=registry,
            host=info,
            outcome=outcome,
            workload=workload,
            github_login=resolved_login,
            started_at=native_started_at(raw) or utc_now(),
            finished_at=utc_now(),
            serve_command=adapter.serve_command(),
            notes=notes,
            conditions=_conditions_option(dedicated, conditions_detail, isolation_check),
        )
    )
    path = output_path(record, out)
    write_json(path, record)
    console.print(f"wrote {path}")


def main() -> None:
    """Console-script entry point."""
    try:
        app()
    except KeyboardInterrupt:  # pragma: no cover - interactive only
        error_console.print("interrupted")
        sys.exit(130)


if __name__ == "__main__":  # pragma: no cover
    main()
