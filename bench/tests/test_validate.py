"""Local pre-flight validation (SPEC §5 items 1, 2, 4, 5)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from atlas_bench.plausibility import active_weight_gb, tokens_per_forward_pass
from atlas_bench.registry import Registry
from atlas_bench.validate import Issue, validate_file, validate_record


def base_record() -> dict:
    """A minimal well-formed record for the throwaway registry."""
    return {
        "schema_version": 1,
        "run_id": "x",
        "config_id": "x",
        "cell_id": "x",
        "workload_id": "serve-test-c2-v1",
        "kind": "serving",
        "engine": {"id": "vllm", "version": "0.27.1"},
        "model": {"id": "test-model-1b", "quant_id": "fp8", "dtype": "auto"},
        "hardware": {"id": "test-gpu-24gb", "count": 1},
        "args": {"max-model-len": 32768},
        "args_canonical": "",
        "metrics": {},
        "provenance": {
            "github_login": "tester",
            "started_at": "2026-08-23T10:00:00Z",
            "method": "atlas-bench",
        },
        "verification": {"level": "self-reported"},
    }


def codes(issues: list[Issue], level: str = "error") -> set[str]:
    """Issue codes of one level."""
    return {i.code for i in issues if i.level == level}


def test_unknown_registry_ids_are_errors(atlas_repo: Path) -> None:
    """Referential integrity: every id must exist (SPEC §5.4)."""
    record = base_record()
    record["model"]["id"] = "does-not-exist"
    record["hardware"]["id"] = "no-such-gpu"
    record["workload_id"] = "no-such-workload-v1"
    found = codes(validate_record(record, Registry(atlas_repo)))
    assert {"unknown-model", "unknown-hardware", "unknown-workload"} <= found


def test_quant_must_list_the_engine(atlas_repo: Path) -> None:
    """A GGUF quant cannot be served by vLLM, and the registry says so."""
    quant_path = atlas_repo / "models" / "test-model-1b" / "quants" / "fp8.json"
    quant = json.loads(quant_path.read_text())
    quant["engines"] = ["llamacpp"]
    quant_path.write_text(json.dumps(quant))
    assert "quant-engine-mismatch" in codes(validate_record(base_record(), Registry(atlas_repo)))


def test_missing_engine_version_is_only_a_warning(atlas_repo: Path) -> None:
    """An unpinned engine version does not block a contribution; it warns."""
    record = base_record()
    record["engine"]["version"] = "9.99.9"
    issues = validate_record(record, Registry(atlas_repo))
    assert "unknown-engine-version" in codes(issues, "warning")


def test_id_format_is_enforced(atlas_repo: Path) -> None:
    """Registry ids are lowercase kebab-case."""
    record = base_record()
    record["model"]["id"] = "Test-Model-1B"
    assert "id-format" in codes(validate_record(record, Registry(atlas_repo)))


def test_null_hardware_id_is_an_error(atlas_repo: Path) -> None:
    """An unregistered machine must be registered before its numbers are published."""
    record = base_record()
    record["hardware"]["id"] = None
    assert "hardware-id-missing" in codes(validate_record(record, Registry(atlas_repo)))


@pytest.mark.parametrize(
    ("metrics", "expected"),
    [
        ({"requests_total": 10, "requests_ok": 8, "requests_failed": 1}, "request-counts-mismatch"),
        ({"success_rate": 1.4}, "success-rate-out-of-range"),
        ({"duration_s": -1}, "negative-metric"),
        ({"ttft_ms": {"mean": -5}}, "negative-metric"),
        ({"vram_peak_gb": 48}, "vram-exceeds-device-memory"),
        ({"decode_tok_s_per_request": {"mean": 9000}}, "bandwidth-ceiling-exceeded"),
    ],
)
def test_plausibility_checks(atlas_repo: Path, metrics: dict, expected: str) -> None:
    """SPEC §5.5: numbers that cannot be true are rejected locally."""
    record = base_record()
    record["metrics"] = metrics
    assert expected in codes(validate_record(record, Registry(atlas_repo)))


def test_plausibility_applies_to_sweep_points(atlas_repo: Path) -> None:
    """A sweep hides its numbers one level deeper; they are checked too."""
    record = base_record()
    record["kind"] = "sweep"
    record["metrics"] = {}
    record["sweep"] = [{"concurrency": 1, "metrics": {"success_rate": 2.0}}]
    assert "success-rate-out-of-range" in codes(validate_record(record, Registry(atlas_repo)))


def test_active_weight_gb_uses_active_params_for_moe() -> None:
    """The roofline ceiling for an MoE model uses its active weights."""
    assert active_weight_gb({"params_b": 27}, {"size_gb": 20}) == 20
    assert active_weight_gb({"params_b": 30, "active_params_b": 3}, {"size_gb": 20}) == 2.0
    assert active_weight_gb(None, {"size_gb": 20}) is None
    # Without size_gb the width is derived from the parameter count and bits.
    assert active_weight_gb({"params_b": 7}, {"bits": 8}) == 7.0
    assert active_weight_gb({"params_b": 7}, None) is None


def test_speculative_decoding_lifts_the_ceiling() -> None:
    """MTP verifies several drafted tokens per pass over the weights (SPEC §5.5)."""
    assert tokens_per_forward_pass({}) == 1.0
    assert tokens_per_forward_pass({}, {"accepted_tokens_per_step": 2.96}) == 2.96
    spec = {"speculative-config": {"method": "mtp", "num_speculative_tokens": 3}}
    assert tokens_per_forward_pass(spec) == 4.0
    assert tokens_per_forward_pass({"speculative-config": '{"num_speculative_tokens": 3}'}) == 4.0
    assert tokens_per_forward_pass({"speculative-model": "some/draft"}) == 4.0


def test_filename_and_path_must_match_the_ids(atlas_repo: Path) -> None:
    """A result in the wrong directory is rejected before the PR is opened."""
    wrong = atlas_repo / "results" / "vllm" / "wrong-model" / "test-gpu-24gb" / "nope.json"
    wrong.parent.mkdir(parents=True, exist_ok=True)
    wrong.write_text(json.dumps(base_record()))
    found = codes(validate_file(wrong, Registry(atlas_repo)))
    assert "filename-mismatch" in found
    assert "path-mismatch" in found


def test_unreadable_file(tmp_path: Path, atlas_repo: Path) -> None:
    """Broken JSON is reported, not raised."""
    broken = tmp_path / "broken.json"
    broken.write_text("{not json")
    assert codes(validate_file(broken, Registry(atlas_repo))) == {"unreadable"}


def test_missing_schema_only_warns(tmp_path: Path) -> None:
    """A checkout without schemas can still run the id and plausibility checks."""
    issues = validate_record(base_record(), Registry(tmp_path))
    assert "schema-missing" in codes(issues, "warning")
