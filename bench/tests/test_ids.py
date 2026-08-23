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
    is_valid_model_id,
    model_parts,
    model_slug,
    parse_result_path,
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
    """``<owner>/<name>`` is the model id, so the path has one level more."""
    path = result_path(
        engine_id="vllm",
        model_id="Qwen/Qwen3.8-27B",
        hardware_id="nvidia-gb10-dgx-spark",
        rid="abc",
    )
    assert str(path) == "results/vllm/Qwen/Qwen3.8-27B/nvidia-gb10-dgx-spark/abc.json"


def test_result_path_round_trips() -> None:
    """``parse_result_path`` is the inverse, on relative and absolute paths alike."""
    fields = {
        "engine_id": "lmstudio",
        "model_id": "google/gemma-4-E2B-it",
        "hardware_id": "apple-m2-max-32gb",
        "rid": "0123456789abcdef--eval-format-v1--abc123",
    }
    path = result_path(**fields)
    parsed = parse_result_path(path)
    assert parsed == {
        "engine_id": "lmstudio",
        "model_id": "google/gemma-4-E2B-it",
        "hardware_id": "apple-m2-max-32gb",
        "run_id": fields["rid"],
    }
    assert parse_result_path(f"/home/me/checkout/{path}") == parsed
    assert parse_result_path("some/other/file.json") is None
    assert parse_result_path("results/vllm/owner/name/hw/run") is None


@pytest.mark.parametrize(
    ("model_id", "expected"),
    [
        ("Qwen/Qwen3.8-27B", "qwen-qwen3.8-27b"),
        ("google/gemma-4-E2B-it", "google-gemma-4-e2b-it"),
        (
            "nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-BF16",
            "nvidia-nvidia-nemotron-3.5-lightning-30b-a3b-bf16",
        ),
        ("acme/model_with_underscores", "acme-model-with-underscores"),
    ],
)
def test_model_slug(model_id: str, expected: str) -> None:
    """The slug is for branch names only: lowercased, ``[^a-z0-9.-]`` becomes ``-``."""
    assert model_slug(model_id) == expected


def test_model_parts() -> None:
    """The two halves of a repo id are two directory levels."""
    assert model_parts("google/gemma-4-E2B-it") == ("google", "gemma-4-E2B-it")


@pytest.mark.parametrize(
    ("value", "valid"),
    [
        ("Qwen/Qwen3.8-27B", True),
        ("google/gemma-4-E2B-it", True),
        ("acme/model.v2_final-1", True),
        ("qwen3.8-27b", False),
        ("owner/name/extra", False),
        ("/name", False),
        ("owner/", False),
        ("own er/name", False),
        (None, False),
    ],
)
def test_is_valid_model_id(value, valid: bool) -> None:
    """model_id is a Hugging Face repo id — exactly one slash, case preserved."""
    assert is_valid_model_id(value) is valid


def test_nothing_lowercases_a_model_id() -> None:
    """The id that is hashed and written to disk keeps its case, always."""
    model_id = "Qwen/Qwen3.8-27B"
    path = result_path(engine_id="vllm", model_id=model_id, hardware_id="h", rid="r")
    assert model_id in str(path)
    assert cell_id(
        model_id=model_id,
        quant_id="fp8",
        hardware_id="h",
        hw_count=1,
        engine_id="vllm",
        engine_version="0.27.1",
    ) != cell_id(
        model_id=model_id.lower(),
        quant_id="fp8",
        hardware_id="h",
        hw_count=1,
        engine_id="vllm",
        engine_version="0.27.1",
    )


def test_id_validation_and_slugify() -> None:
    """Registry ids are lowercase kebab-case."""
    assert is_valid_id("nvidia-gb10-dgx-spark")
    assert is_valid_id("qwen3.8-27b")
    assert not is_valid_id("Qwen3.8-27B")
    assert not is_valid_id("-leading")
    assert slugify_id("NVIDIA GeForce RTX 4090") == "nvidia-geforce-rtx-4090"
    assert slugify_id("Apple M2 Max 32gb") == "apple-m2-max-32gb"
