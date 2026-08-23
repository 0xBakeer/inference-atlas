"""Computed identifiers (SPEC §2)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from atlas_bench.ids import (
    cell_id,
    config_id_from_canonical,
    engine_minor,
    is_valid_id,
    result_path,
    run_id,
    run_suffix,
    sha256_hex,
    slugify_id,
)

FIXTURE = Path(__file__).resolve().parents[2] / "schemas" / "fixtures" / "id-vectors.json"


@pytest.mark.skipif(not FIXTURE.exists(), reason="id-vectors.json not in this checkout")
def test_shared_id_vectors() -> None:
    """Every id vector from the cross-language fixture file must reproduce exactly."""
    payload = json.loads(FIXTURE.read_text(encoding="utf-8"))
    for vector in payload.get("cell_id", []):
        args = vector["input"]
        assert (
            cell_id(
                model_id=args["model_id"],
                quant_id=args["quant_id"],
                hardware_id=args["hardware_id"],
                hw_count=args["hw_count"],
                engine_id=args["engine_id"],
                engine_version=args["engine_minor"],
            )
            == vector["expected"]
        ), vector["name"]
    for vector in payload.get("run_id", []):
        args = vector["input"]
        assert (
            run_id(
                cfg_id=args["config_id"],
                workload_id=args["workload_id"],
                github_login=args["github_login"],
                started_at=args["started_at"],
            )
            == vector["expected"]
        ), vector["name"]
    for vector in payload.get("engine_minor", []):
        assert engine_minor(vector["input"]) == vector["expected"], vector["input"]
    for vector in payload.get("result_path", []):
        args = vector["input"]
        assert (
            str(
                result_path(
                    engine_id=args["engine_id"],
                    model_id=args["model_id"],
                    hardware_id=args["hardware_id"],
                    rid=args["run_id"],
                )
            )
            == vector["expected"]
        ), vector["name"]


def test_config_id_is_16_hex_of_sha256() -> None:
    """``config_id = sha256(canonical)[:16]``."""
    canonical = "@dtype=auto;@quant=fp8"
    assert config_id_from_canonical(canonical) == sha256_hex(canonical)[:16]
    assert len(config_id_from_canonical(canonical)) == 16


@pytest.mark.parametrize(
    ("version", "expected"),
    [
        ("0.27.1", "0.27"),
        ("v1.2.3", "1.2"),
        ("0.26.1.dev0+g568afb3a1", "0.26"),
        ("b7000", "b7000"),
        ("  0.12  ", "0.12"),
        ("2026.08.1", "2026.08"),
    ],
)
def test_engine_minor(version: str, expected: str) -> None:
    """Patch releases share a cell; minors do not."""
    assert engine_minor(version) == expected


def test_cell_id_depends_on_every_component() -> None:
    """Changing any component of a cell changes the id."""
    base = {
        "model_id": "qwen3.8-27b",
        "quant_id": "fp8",
        "hardware_id": "nvidia-gb10-dgx-spark",
        "hw_count": 1,
        "engine_id": "vllm",
        "engine_version": "0.27.1",
    }
    reference = cell_id(**base)
    assert len(reference) == 12
    for key, value in (
        ("model_id", "qwen3-8b"),
        ("quant_id", "bf16"),
        ("hardware_id", "nvidia-rtx-4090"),
        ("hw_count", 2),
        ("engine_id", "sglang"),
        ("engine_version", "0.26.1"),
    ):
        assert cell_id(**{**base, key: value}) != reference, key
    # A patch release is the same square.
    assert cell_id(**{**base, "engine_version": "0.27.9"}) == reference


def test_run_id_separates_contributors_and_times() -> None:
    """Two people, or the same person twice, never collide on a filename."""
    common = {"cfg_id": "0" * 16, "workload_id": "serve-test-v1"}
    a = run_id(**common, github_login="alice", started_at="2026-08-23T10:00:00Z")
    b = run_id(**common, github_login="bob", started_at="2026-08-23T10:00:00Z")
    c = run_id(**common, github_login="alice", started_at="2026-08-23T11:00:00Z")
    assert len({a, b, c}) == 3
    assert a.split("--")[2] == run_suffix("alice", "2026-08-23T10:00:00Z")


def test_result_path_shape() -> None:
    """The only place a result may live."""
    path = result_path(
        engine_id="vllm", model_id="qwen3.8-27b", hardware_id="nvidia-gb10-dgx-spark", rid="abc"
    )
    assert str(path) == "results/vllm/qwen3.8-27b/nvidia-gb10-dgx-spark/abc.json"


def test_id_validation_and_slugify() -> None:
    """Registry ids are lowercase kebab-case."""
    assert is_valid_id("nvidia-gb10-dgx-spark")
    assert is_valid_id("qwen3.8-27b")
    assert not is_valid_id("Qwen3.8-27B")
    assert not is_valid_id("-leading")
    assert slugify_id("NVIDIA GeForce RTX 4090") == "nvidia-geforce-rtx-4090"
    assert slugify_id("Apple M2 Max 32gb") == "apple-m2-max-32gb"
