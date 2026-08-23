"""Submitting: the branch, the commit and the one rule that keeps the repo mergeable."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

from atlas_bench.submit import build_body, build_plan, dirty_outside_results, submit


def git(repo: Path, *args: str) -> None:
    """Run a git command in the fixture repo."""
    subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True)


@pytest.fixture
def git_repo(atlas_repo: Path) -> Path:
    """The throwaway checkout, turned into a git repo with one commit."""
    git(atlas_repo, "init", "-q", "-b", "main")
    git(atlas_repo, "config", "user.email", "test@example.invalid")
    git(atlas_repo, "config", "user.name", "Test")
    git(atlas_repo, "add", "-A")
    git(atlas_repo, "commit", "-qm", "initial")
    return atlas_repo


def write_result(repo: Path, run_id: str = "a" * 16 + "--serve-test-c2-v1--abcdef") -> Path:
    """A result file on disk to submit."""
    path = repo / "results" / "vllm" / "acme/test-model-1b" / "test-gpu-24gb" / f"{run_id}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(
            {
                "run_id": run_id,
                "config_id": "a" * 16,
                "cell_id": "1ba1c0546128",
                "workload_id": "serve-test-c2-v1",
                "kind": "serving",
                "engine": {"id": "vllm", "version": "0.27.1"},
                "model": {"id": "acme/test-model-1b", "quant_id": "fp8"},
                "hardware": {
                    "id": "test-gpu-24gb",
                    "fingerprint": "sha256:" + "0" * 64,
                    "driver": "580.95.05",
                    "cuda": "13.0",
                    "host": {"os": "Ubuntu 24.04"},
                },
                "args_canonical": "@dtype=auto;@quant=fp8",
                "serve_command": "vllm serve test",
                "metrics": {"output_tok_s": 123.4, "success_rate": 1.0},
                "gotchas": [{"severity": "warn", "text": "Prefix caching defaults OFF."}],
                "raw": {"harness_version": "0.1.0"},
                "provenance": {"method": "atlas-bench", "notes": "Box idle, ambient 22C."},
            }
        )
    )
    return path


def test_plan_derives_branch_and_commit_message(git_repo: Path) -> None:
    """Branch and commit message come from the result files, not from the contributor."""
    path = write_result(git_repo)
    plan = build_plan(git_repo, [path])
    assert plan.branch == "result/vllm-acme-test-model-1b-test-gpu-24gb-1ba1c0"
    assert plan.commit_message == (
        "results: vllm 0.27.1 acme/test-model-1b fp8 on test-gpu-24gb (1 runs)"
    )
    assert plan.labels == ["results"]
    assert plan.files == [
        "results/vllm/acme/test-model-1b/test-gpu-24gb/"
        + "a" * 16
        + "--serve-test-c2-v1--abcdef.json"
    ]


def test_pr_body_lists_cells_config_and_gotchas(git_repo: Path) -> None:
    """The body is the SPEC §7 template: what was filled, how, and what to watch out for."""
    body = build_body([json.loads(write_result(git_repo).read_text())])
    assert "### Cells filled" in body
    assert "serve-test-c2-v1" in body
    assert "123.4 tok/s" in body
    assert "@dtype=auto;@quant=fp8" in body
    assert "Prefix caching defaults OFF." in body
    assert "Box idle, ambient 22C." in body
    assert "- [x] Hardware captured with `atlas-bench hwinfo`" in body


def test_refuses_when_the_tree_is_dirty_outside_results(git_repo: Path) -> None:
    """The one rule: a results PR only touches result files."""
    write_result(git_repo)
    (git_repo / "hardware" / "test-gpu-24gb.json").write_text('{"tampered": true}')
    assert dirty_outside_results(git_repo) == ["hardware/test-gpu-24gb.json"]
    with pytest.raises(RuntimeError, match="outside results/"):
        submit(git_repo, [write_result(git_repo)], dry_run=True)


def test_result_only_changes_are_clean(git_repo: Path) -> None:
    """New result files alone are not "dirty"."""
    write_result(git_repo)
    assert dirty_outside_results(git_repo) == []


def test_untracked_scratch_files_do_not_block(git_repo: Path) -> None:
    """An agent's task.json or a new hardware file must not block the PR."""
    write_result(git_repo)
    (git_repo / "task.json").write_text("{}")
    (git_repo / "hardware" / "brand-new-gpu.json").write_text("{}")
    assert dirty_outside_results(git_repo) == []


def test_submit_commits_only_the_result_files(git_repo: Path) -> None:
    """The commit contains the results and nothing else; no push in the test."""
    path = write_result(git_repo)
    (git_repo / "untracked-note.txt").write_text("scratch")
    plan = submit(git_repo, [path], push=False)

    branch = subprocess.run(
        ["git", "-C", str(git_repo), "rev-parse", "--abbrev-ref", "HEAD"],
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()
    assert branch == plan.branch

    committed = subprocess.run(
        ["git", "-C", str(git_repo), "show", "--name-only", "--format=", "HEAD"],
        capture_output=True,
        text=True,
        check=True,
    ).stdout.split()
    assert committed == plan.files
