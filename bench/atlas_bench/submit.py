"""Opening the pull request (SPEC §7.7).

The harness refuses to submit when the working tree has changes outside ``results/``: the
one rule that keeps the repo mergeable is that a contributor's PR only adds their own result
files. Everything else about the PR (branch name, commit message, body) is derived from the
result files themselves, so two contributors never produce colliding branches.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .ids import model_slug

__all__ = ["SubmitPlan", "build_plan", "dirty_outside_results", "submit"]


@dataclass
class SubmitPlan:
    """Everything the submit command is about to do."""

    branch: str
    commit_message: str
    files: list[str]
    pr_title: str
    pr_body: str
    labels: list[str] = field(default_factory=lambda: ["results"])


def _git(repo: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    """Run a git command inside the checkout."""
    proc = subprocess.run(
        ["git", "-C", str(repo), *args], capture_output=True, text=True, check=False
    )
    if check and proc.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} failed: {proc.stderr.strip()}")
    return proc


def dirty_outside_results(repo: Path) -> list[str]:
    """Tracked files outside ``results/`` that have been modified, staged or deleted.

    Untracked files are deliberately ignored: an agent's ``task.json`` or a brand-new
    ``hardware/<id>.json`` sitting in the checkout cannot overwrite anybody's data, and the
    commit only ever contains the files passed explicitly to ``git add``. What must never
    happen is *editing* a file somebody else owns, and that is what this catches.
    """
    proc = _git(repo, "status", "--porcelain")
    dirty: list[str] = []
    for line in proc.stdout.splitlines():
        if not line.strip():
            continue
        status, path = line[:2], line[3:].strip().strip('"')
        if status == "??":
            continue
        if " -> " in path:  # renames
            path = path.split(" -> ", 1)[1]
        if not path.startswith("results/"):
            dirty.append(path)
    return dirty


def _load(paths: Sequence[Path]) -> list[dict[str, Any]]:
    """Read the result records that are being submitted."""
    records: list[dict[str, Any]] = []
    for path in paths:
        records.append(json.loads(Path(path).read_text(encoding="utf-8")))
    return records


def _site_repo(repo: Path) -> dict[str, Any]:
    """``site/config.json``'s repo block (branch prefix, results label), if present."""
    config = repo / "site" / "config.json"
    if not config.is_file():
        return {}
    try:
        data = json.loads(config.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    block = data.get("repo")
    return block if isinstance(block, dict) else {}


def build_plan(repo: Path, paths: Sequence[Path], *, draft: bool = False) -> SubmitPlan:
    """Derive branch, commit message and PR body from the result files."""
    records = _load(paths)
    if not records:
        raise ValueError("no result files to submit")
    first = records[0]
    engine = first["engine"]
    model = first["model"]
    hardware = first["hardware"]
    short = str(first.get("cell_id") or first.get("config_id") or "new")[:6]
    site = _site_repo(repo)
    prefix = str(site.get("branch_prefix") or "result/")
    # A model id is a Hugging Face repo id (`Qwen/Qwen3.8-27B`); a git branch cannot hold a
    # slash or an upper-case letter portably, so the branch uses the slug. The id itself is
    # never rewritten — it lives in the file, the path and every hash.
    branch = f"{prefix}{engine['id']}-{model_slug(str(model['id']))}-{hardware['id']}-{short}"
    message = (
        f"results: {engine['id']} {engine['version']} {model['id']} {model['quant_id']} "
        f"on {hardware['id']} ({len(records)} runs)"
    )
    return SubmitPlan(
        branch=branch,
        commit_message=message,
        files=[str(Path(p).resolve().relative_to(repo.resolve())) for p in paths],
        pr_title=message,
        pr_body=build_body(records, draft=draft),
        labels=[str(site.get("results_label") or "results")],
    )


def build_body(records: list[dict[str, Any]], *, draft: bool = False) -> str:
    """The PR body template of SPEC §7."""
    first = records[0]
    engine = first["engine"]
    model = first["model"]
    hardware = first["hardware"]
    provenance = first.get("provenance") or {}
    lines = [
        f"## {engine['id']} {engine['version']} · {model['id']} · {model['quant_id']} "
        f"· {hardware['id']}",
        "",
        "### Cells filled",
        "",
        "| run | workload | kind | headline | success |",
        "| --- | --- | --- | --- | --- |",
    ]
    for record in records:
        metrics = record.get("metrics") or {}
        scores = record.get("scores") or {}
        headline = (
            f"{metrics.get('output_tok_s')} tok/s"
            if metrics.get("output_tok_s")
            else (f"accuracy {scores.get('accuracy')}" if scores else "—")
        )
        lines.append(
            f"| `{record['run_id']}` | `{record['workload_id']}` | {record.get('kind')} | "
            f"{headline} | {metrics.get('success_rate', '—')} |"
        )
    lines += [
        "",
        "### Configuration",
        "",
        f"- `args_canonical`: `{first.get('args_canonical')}`",
        f"- `config_id`: `{first.get('config_id')}` · `cell_id`: `{first.get('cell_id')}`",
        f"- serve command: `{first.get('serve_command')}`",
        f"- hardware fingerprint: `{hardware.get('fingerprint')}`",
        f"- driver `{hardware.get('driver')}` · CUDA `{hardware.get('cuda')}` · host "
        f"`{(hardware.get('host') or {}).get('os')}`",
        "",
        "### Conditions",
        "",
        f"{provenance.get('notes') or 'Box otherwise idle.'}",
        "",
    ]
    gotchas = [g for record in records for g in (record.get("gotchas") or [])]
    if gotchas:
        lines += ["### Gotchas", ""]
        lines += [f"- **{g.get('severity')}** — {g.get('text')}" for g in gotchas]
        lines.append("")
    lines += [
        "### Checklist",
        "",
        "- [x] Hardware captured with `atlas-bench hwinfo` (not typed by hand)",
        "- [x] `atlas-bench validate` passes locally",
        "- [ ] `pnpm validate` passes locally",
        "- [x] Only my own new result files are touched",
        "",
        f"Method: `{provenance.get('method')}` · harness "
        f"`{(first.get('raw') or {}).get('harness_version')}`",
    ]
    if draft:
        lines.append("\n_Opened as a draft._")
    return "\n".join(lines)


def submit(
    repo: Path,
    paths: Sequence[Path],
    *,
    draft: bool = False,
    dry_run: bool = False,
    push: bool = True,
) -> SubmitPlan:
    """Create the branch, commit only the result files and open the PR."""
    dirty = dirty_outside_results(repo)
    if dirty:
        raise RuntimeError(
            "working tree has changes outside results/: "
            + ", ".join(dirty[:10])
            + " — commit or stash them first"
        )
    plan = build_plan(repo, paths, draft=draft)
    if dry_run:
        return plan

    existing = _git(repo, "rev-parse", "--verify", plan.branch, check=False)
    if existing.returncode == 0:
        _git(repo, "checkout", plan.branch)
    else:
        _git(repo, "checkout", "-b", plan.branch)
    _git(repo, "add", "--", *plan.files)
    _git(repo, "commit", "-m", plan.commit_message)
    if not push:
        return plan
    _git(repo, "push", "--set-upstream", "origin", plan.branch)

    if not shutil.which("gh"):
        raise RuntimeError("gh CLI not found — push succeeded, open the PR manually")
    args = [
        "gh",
        "pr",
        "create",
        "--title",
        plan.pr_title,
        "--body",
        plan.pr_body,
    ]
    for label in plan.labels:
        args += ["--label", label]
    if draft:
        args.append("--draft")
    proc = subprocess.run(args, cwd=repo, capture_output=True, text=True, check=False)
    if proc.returncode != 0:
        raise RuntimeError(f"gh pr create failed: {proc.stderr.strip()}")
    return plan
