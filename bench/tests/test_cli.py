"""CLI surface: exit codes, output shape and the refusals that matter."""

from __future__ import annotations

import json
from pathlib import Path

from typer.testing import CliRunner

from atlas_bench import __version__
from atlas_bench.cli import app
from tests.test_run_e2e import host

runner = CliRunner()


def test_version() -> None:
    """``--version`` prints the harness version used in ``raw.harness_version``."""
    result = runner.invoke(app, ["--version"])
    assert result.exit_code == 0
    assert __version__ in result.stdout


def test_help_lists_every_command() -> None:
    """All seven SPEC §8 commands are exposed."""
    result = runner.invoke(app, ["--help"])
    assert result.exit_code == 0
    for command in ("hwinfo", "serve", "run", "validate", "submit", "packet", "wrap"):
        assert command in result.stdout


def test_hwinfo_json_matched(atlas_repo: Path, monkeypatch) -> None:
    """A machine that matches the registry reports its id."""
    import atlas_bench.cli as cli

    monkeypatch.setattr(cli.hwinfo_module, "collect", host)
    result = runner.invoke(app, ["hwinfo", "--json", "--registry-dir", str(atlas_repo)])
    assert result.exit_code == 0
    payload = json.loads(result.stdout)
    assert payload["hardware_id"] == "test-gpu-24gb"
    assert payload["fingerprint"].startswith("sha256:")
    assert "draft" not in payload


def test_hwinfo_unmatched_prints_a_draft(atlas_repo: Path, monkeypatch) -> None:
    """An unknown machine gets ``null`` plus a ready-to-fill registry draft."""
    import atlas_bench.cli as cli
    from atlas_bench.hwinfo import HostInfo

    def unknown() -> HostInfo:
        return HostInfo(
            platform="darwin",
            arch="arm64",
            cpu="Apple M9 Ultra",
            apple_chip="Apple M9 Ultra",
            ram_gb=256.0,
            os="macOS 27",
        )

    monkeypatch.setattr(cli.hwinfo_module, "collect", unknown)
    result = runner.invoke(app, ["hwinfo", "--json", "--registry-dir", str(atlas_repo)])
    payload = json.loads(result.stdout)
    assert payload["hardware_id"] is None
    assert payload["draft"]["id"] == "apple-m9-ultra-256gb"
    assert payload["draft"]["memory_bandwidth_gbs"] is None


def test_hwinfo_human_output(atlas_repo: Path, monkeypatch) -> None:
    """The default output is a readable table, not JSON."""
    import atlas_bench.cli as cli

    monkeypatch.setattr(cli.hwinfo_module, "collect", host)
    result = runner.invoke(app, ["hwinfo", "--registry-dir", str(atlas_repo)])
    assert result.exit_code == 0
    assert "Captured hardware" in result.stdout
    assert "test-gpu-24gb" in result.stdout


def test_serve_adapter_only_prints_the_command(atlas_repo: Path, tmp_path: Path) -> None:
    """``--engine-adapter-only`` resolves the command without starting anything."""
    from tests.test_run_e2e import make_spec

    spec_path = tmp_path / "task.json"
    spec_path.write_text(make_spec().model_dump_json())
    result = runner.invoke(
        app,
        [
            "serve",
            "--spec",
            str(spec_path),
            "--engine-adapter-only",
            "--registry-dir",
            str(atlas_repo),
        ],
    )
    assert result.exit_code == 0
    assert "http://fake" in result.stdout
    assert "VllmAdapter" in result.stdout
    # aliases from the packet are rendered with the engine's own flag names
    assert "--tensor-parallel-size" in result.stdout.replace("\n", "")


def test_run_dry_run_writes_nothing(atlas_repo: Path, tmp_path: Path) -> None:
    """``--dry-run`` prints the plan and touches no files."""
    from tests.test_run_e2e import make_spec

    spec_path = tmp_path / "task.json"
    spec_path.write_text(make_spec().model_dump_json())
    result = runner.invoke(
        app,
        [
            "run",
            "--spec",
            str(spec_path),
            "--dry-run",
            "--registry-dir",
            str(atlas_repo),
            "--out",
            str(atlas_repo / "results"),
            "--login",
            "tester",
        ],
    )
    assert result.exit_code == 0
    assert "serve-test-c2-v1" in result.stdout
    assert not list((atlas_repo / "results").rglob("*.json"))


def test_run_refuses_without_a_login(atlas_repo: Path, tmp_path: Path, monkeypatch) -> None:
    """``run_id`` depends on the login, so a run without one is refused."""
    from tests.test_run_e2e import make_spec

    monkeypatch.delenv("ATLAS_GITHUB_LOGIN", raising=False)
    monkeypatch.setattr("atlas_bench.cli.resolve_login", lambda *_: None)
    spec = make_spec()
    spec.github_login = None
    spec_path = tmp_path / "task.json"
    spec_path.write_text(spec.model_dump_json())
    result = runner.invoke(
        app, ["run", "--spec", str(spec_path), "--registry-dir", str(atlas_repo)]
    )
    assert result.exit_code == 2


def test_packet_command_outputs_valid_json(atlas_repo: Path, tmp_path: Path) -> None:
    """``packet --cell`` writes a packet the run command can consume."""
    out = tmp_path / "packet.json"
    result = runner.invoke(
        app,
        [
            "packet",
            "--cell",
            "vllm@0.27.1/acme/test-model-1b/fp8/test-gpu-24gb",
            "--workload",
            "serve-test-c2-v1",
            "--arg",
            "max-model-len=32768",
            "--arg",
            "enable-prefix-caching=true",
            "--registry-dir",
            str(atlas_repo),
            "--out",
            str(out),
        ],
    )
    assert result.exit_code == 0
    packet = json.loads(out.read_text())
    assert packet["args"] == {"max-model-len": 32768, "enable-prefix-caching": True}
    assert packet["workloads"] == ["serve-test-c2-v1"]


def test_packet_rejects_an_unresolvable_cell(atlas_repo: Path) -> None:
    """A cell nobody can resolve is an error, not a half-filled packet."""
    result = runner.invoke(
        app, ["packet", "--cell", "not-a-cell", "--registry-dir", str(atlas_repo)]
    )
    assert result.exit_code == 2


def test_validate_reports_and_exits_nonzero(atlas_repo: Path, tmp_path: Path) -> None:
    """A broken result file makes ``validate`` fail loudly."""
    broken = tmp_path / "broken.json"
    broken.write_text(json.dumps({"run_id": "nope"}))
    result = runner.invoke(app, ["validate", str(broken), "--registry-dir", str(atlas_repo)])
    assert result.exit_code == 1
    assert "error" in result.stdout


def test_wrap_writes_a_result(atlas_repo: Path, tmp_path: Path, monkeypatch) -> None:
    """``wrap`` turns a vLLM benchmark JSON into an Atlas result file."""
    import atlas_bench.cli as cli
    from tests.conftest import FIXTURES
    from tests.test_run_e2e import make_spec

    monkeypatch.setattr(cli.hwinfo_module, "collect", host)
    spec_path = tmp_path / "task.json"
    spec_path.write_text(make_spec().model_dump_json())
    result = runner.invoke(
        app,
        [
            "wrap",
            str(FIXTURES / "vllm_bench_serve.json"),
            "--spec",
            str(spec_path),
            "--registry-dir",
            str(atlas_repo),
            "--out",
            str(atlas_repo / "results"),
            "--login",
            "tester",
        ],
    )
    assert result.exit_code == 0, result.stdout

    files = list((atlas_repo / "results").rglob("*.json"))
    assert len(files) == 1
    record = json.loads(files[0].read_text())
    assert record["metrics"]["output_tok_s"] == 410.76
    assert record["raw"]["payload"]["source"] == "vllm-bench-serve"
    assert record["provenance"]["started_at"] == "2026-08-16T14:15:16Z"
    assert any("not by atlas-bench" in g["text"] for g in record["gotchas"])


# ------------------------------------------------------------------- restamp


def _result_for_restamp(atlas_repo: Path) -> Path:
    """One written result whose engine.build is missing, at its correct path."""
    record = {
        "schema_version": 1,
        "config_id": "0000000000000000",
        "cell_id": "000000000000",
        "run_id": "0000000000000000--workload-test-v1--aaaaaa",
        "engine": {"id": "vllm", "version": "0.27.1", "build": None},
        "model": {"id": "acme/test-model-1b", "quant_id": "fp8", "dtype": "auto"},
        "hardware": {"id": "test-gpu-24gb", "count": 1},
        "args": {"max-model-len": 4096},
        "args_canonical": "max-model-len=4096",
        "workload": {"id": "workload-test-v1"},
        "provenance": {"github_login": "someone", "started_at": "2026-01-01T00:00:00Z"},
    }
    path = (
        atlas_repo
        / "results"
        / "vllm"
        / "acme"
        / "test-model-1b"
        / "test-gpu-24gb"
        / f"{record['run_id']}.json"
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
    return path


def test_restamp_names_the_build_and_moves_the_file(atlas_repo: Path) -> None:
    """Adding the build changes the config fingerprint, so the result relocates with it."""
    path = _result_for_restamp(atlas_repo)
    build = "ghcr.io/example/vllm@sha256:" + "a" * 64

    result = runner.invoke(
        app, ["restamp", str(path), "--build", build, "--registry-dir", str(atlas_repo)]
    )
    assert result.exit_code == 0, result.stdout
    assert not path.exists(), "the old filename still carries the old fingerprint"

    written = sorted(p for p in path.parent.glob("*.json"))
    assert len(written) == 1
    record = json.loads(written[0].read_text())
    assert record["engine"]["build"] == build
    assert record["config_id"] != "0000000000000000"
    assert written[0].name == f"{record['run_id']}.json"
    assert record["run_id"].startswith(record["config_id"])
    # A build is a property of the configuration, not of the cell it sits in.
    assert record["cell_id"] == "000000000000"


def test_restamp_is_idempotent(atlas_repo: Path) -> None:
    """Restamping the same build twice is a no-op, not a second relocation."""
    path = _result_for_restamp(atlas_repo)
    build = "ghcr.io/example/vllm@sha256:" + "b" * 64
    args = ["restamp", "--build", build, "--registry-dir", str(atlas_repo)]

    first = runner.invoke(app, ["restamp", str(path), *args[1:]])
    assert first.exit_code == 0, first.stdout
    moved = next(iter(path.parent.glob("*.json")))
    before = moved.read_text()

    second = runner.invoke(app, ["restamp", str(moved), *args[1:]])
    assert second.exit_code == 0, second.stdout
    assert "unchanged" in second.stdout
    assert moved.read_text() == before


def test_restamp_refuses_to_replace_a_different_build(atlas_repo: Path) -> None:
    """Silently overwriting a recorded build would rewrite somebody's measurement."""
    path = _result_for_restamp(atlas_repo)
    args = ["--registry-dir", str(atlas_repo)]
    first = runner.invoke(app, ["restamp", str(path), "--build", "image-a", *args])
    assert first.exit_code == 0, first.stdout
    moved = next(iter(path.parent.glob("*.json")))

    refused = runner.invoke(app, ["restamp", str(moved), "--build", "image-b", *args])
    assert refused.exit_code == 1
    assert json.loads(moved.read_text())["engine"]["build"] == "image-a"

    forced = runner.invoke(app, ["restamp", str(moved), "--build", "image-b", "--force", *args])
    assert forced.exit_code == 0, forced.stdout
    replaced = next(iter(path.parent.glob("*.json")))
    assert json.loads(replaced.read_text())["engine"]["build"] == "image-b"


def test_restamp_dry_run_changes_nothing(atlas_repo: Path) -> None:
    """The plan is printable without touching the file."""
    path = _result_for_restamp(atlas_repo)
    before = path.read_text()
    result = runner.invoke(
        app,
        ["restamp", str(path), "--build", "image-x", "--dry-run", "--registry-dir", str(atlas_repo)],
    )
    assert result.exit_code == 0, result.stdout
    assert path.exists() and path.read_text() == before


def test_packet_request_options_land_in_the_request_block(atlas_repo: Path, tmp_path: Path) -> None:
    """``packet --request`` fills the packet's ``request`` block, JSON values parsed."""
    out = tmp_path / "packet.json"
    result = runner.invoke(
        app,
        [
            "packet",
            "--cell",
            "vllm@0.27.1/acme/test-model-1b/fp8/test-gpu-24gb",
            "--workload",
            "serve-test-c2-v1",
            "--request",
            'chat_template_kwargs={"thinking": false, "reasoning_effort": "low"}',
            "--request",
            "timeout_s=900",
            "--registry-dir",
            str(atlas_repo),
            "--out",
            str(out),
        ],
    )
    assert result.exit_code == 0, result.output
    packet = json.loads(out.read_text())
    assert packet["request"]["chat_template_kwargs"] == {
        "thinking": False,
        "reasoning_effort": "low",
    }
    assert packet["request"]["timeout_s"] == 900
    assert packet["request"]["temperature"] == 0.0  # defaults are written out, not implied


def test_packet_rejects_an_unknown_request_option(atlas_repo: Path, tmp_path: Path) -> None:
    """A typo in ``--request`` fails the packet, not the run an hour later."""
    result = runner.invoke(
        app,
        [
            "packet",
            "--cell",
            "vllm@0.27.1/acme/test-model-1b/fp8/test-gpu-24gb",
            "--workload",
            "serve-test-c2-v1",
            "--request",
            "chat_template_kwarg={}",
            "--registry-dir",
            str(atlas_repo),
            "--out",
            str(tmp_path / "packet.json"),
        ],
    )
    assert result.exit_code == 2
    assert "unknown request option" in result.output
