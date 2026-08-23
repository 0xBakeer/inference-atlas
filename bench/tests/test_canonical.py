"""Canonicalization must be byte-identical to the TypeScript reference (SPEC §3)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from atlas_bench.canonical import (
    CanonicalInput,
    ParamSpec,
    canonicalize,
    canonicalize_full,
    normalize_key,
    normalize_number,
    normalize_value,
    stable_json,
)

FIXTURE = Path(__file__).resolve().parents[2] / "schemas" / "fixtures" / "fingerprint-vectors.json"

VLLM_PARAMS = (
    ParamSpec("tensor-parallel-size", 1, ("-tp", "tp"), "int"),
    ParamSpec("gpu-memory-utilization", 0.9, (), "float"),
    ParamSpec("max-model-len", None, (), "int"),
    ParamSpec("enable-prefix-caching", False, (), "bool"),
    ParamSpec("speculative-config", None, (), "json"),
    ParamSpec("lora-modules", None, (), "list"),
    ParamSpec("port", 8000, (), "int"),
)
DROP = ("model", "host", "port", "api-key", "served-model-name", "download-dir")


def vllm(args: dict, **kwargs) -> CanonicalInput:
    """A vLLM canonicalization input with the standard param set."""
    return CanonicalInput(
        engine_id="vllm",
        engine_version="0.27.1",
        args=args,
        quant_id=kwargs.pop("quant_id", "fp8"),
        dtype=kwargs.pop("dtype", None),
        params=kwargs.pop("params", VLLM_PARAMS),
        drop_params=kwargs.pop("drop_params", DROP),
        **kwargs,
    )


# ------------------------------------------------------------ the golden vectors


@pytest.mark.skipif(not FIXTURE.exists(), reason="fingerprint-vectors.json not in this checkout")
def test_shared_fixture_vectors() -> None:
    """Every vector in the cross-language fixture file must reproduce exactly."""
    payload = json.loads(FIXTURE.read_text(encoding="utf-8"))
    vectors = payload["vectors"] if isinstance(payload, dict) else payload
    assert vectors, "fixture file has no vectors"
    for vector in vectors:
        result = canonicalize_full(CanonicalInput.from_dict(vector["input"]))
        assert result.canonical == vector["expected"]["canonical"], vector["name"]
        assert result.config_id == vector["expected"]["config_id"], vector["name"]


@pytest.mark.skipif(not FIXTURE.exists(), reason="fingerprint-vectors.json not in this checkout")
def test_equivalence_groups_share_a_config_id() -> None:
    """Vectors tagged with the same equivalence_group must hash identically."""
    payload = json.loads(FIXTURE.read_text(encoding="utf-8"))
    groups: dict[str, set[str]] = {}
    for vector in payload["vectors"]:
        group = vector.get("equivalence_group")
        if not group:
            continue
        result = canonicalize_full(CanonicalInput.from_dict(vector["input"]))
        groups.setdefault(group, set()).add(result.config_id)
    for group, ids in groups.items():
        assert len(ids) == 1, f"{group} forked into {ids}"


# ------------------------------------------------------------------ own vectors


def test_empty_args_still_has_pseudo_params() -> None:
    """SPEC §3.5: the canonical string is never empty."""
    assert canonicalize(vllm({})) == "@dtype=auto;@quant=fp8"


def test_pseudo_params_sort_first() -> None:
    """``@`` sorts below ``a``, so quant and dtype always lead."""
    canonical = canonicalize(vllm({"max-model-len": 262144}, dtype="bfloat16", quant_id="bf16"))
    assert canonical == "@dtype=bfloat16;@quant=bf16;max-model-len=262144"


def test_alias_and_key_normalization() -> None:
    """Aliases, dashes, underscores and case all collapse onto the canonical name."""
    forms = [
        {"-tp": 2},
        {"tp": 2},
        {"tensor-parallel-size": 2},
        {"tensor_parallel_size": 2},
        {"--Tensor-Parallel-Size": 2},
    ]
    ids = {canonicalize_full(vllm(f)).config_id for f in forms}
    assert len(ids) == 1


def test_defaults_are_dropped_only_for_known_versions() -> None:
    """Unknown version → ``params is None`` → nothing is dropped (SPEC §3.2)."""
    known = canonicalize(vllm({"gpu-memory-utilization": 0.9, "tensor-parallel-size": 1}))
    unknown = canonicalize(
        vllm({"gpu-memory-utilization": 0.9, "tensor-parallel-size": 1}, params=None)
    )
    assert known == "@dtype=auto;@quant=fp8"
    assert unknown == ("@dtype=auto;@quant=fp8;gpu-memory-utilization=0.9;tensor-parallel-size=1")


def test_drop_params_never_reach_the_hash() -> None:
    """Paths, ports and credentials cannot change a number, so they are removed."""
    canonical = canonicalize(
        vllm({"model": "org/Model", "port": 8123, "api-key": "secret", "max-model-len": 4096})
    )
    assert canonical == "@dtype=auto;@quant=fp8;max-model-len=4096"


def test_null_value_is_not_a_flag() -> None:
    """A null value means "not passed" and must not appear."""
    assert canonicalize(vllm({"max-model-len": None})) == "@dtype=auto;@quant=fp8"


def test_string_numbers_fold_onto_their_numeric_value() -> None:
    """``"0.4400"`` from a shell command line is the same configuration as ``0.44``."""
    a = canonicalize_full(vllm({"gpu-memory-utilization": "0.4400"})).config_id
    b = canonicalize_full(vllm({"gpu-memory-utilization": 0.44})).config_id
    assert a == b
    assert canonicalize(vllm({"gpu-memory-utilization": "0.90"})) == "@dtype=auto;@quant=fp8"


def test_boolish_values_fold_for_declared_bools() -> None:
    """``1``/``"True"``/``"on"`` are all true for a param the version declares boolean."""
    ids = {
        canonicalize_full(vllm({"enable-prefix-caching": v})).config_id
        for v in (True, 1, "True", "on", "yes")
    }
    assert len(ids) == 1


def test_nested_objects_and_arrays_are_order_independent() -> None:
    """Objects sort their keys, arrays sort their elements, strings parse as JSON."""
    a = canonicalize(vllm({"speculative-config": {"num_speculative_tokens": 3, "method": "mtp"}}))
    b = canonicalize(vllm({"speculative-config": '{"method": "mtp", "num_speculative_tokens": 3}'}))
    assert a == b
    assert 'speculative-config={"method":"mtp","num_speculative_tokens":3}' in a
    left = canonicalize(vllm({"lora-modules": ["sql", "alpha"]}))
    right = canonicalize(vllm({"lora-modules": ["alpha", "sql"]}))
    assert left == right == '@dtype=auto;@quant=fp8;lora-modules=["alpha","sql"]'


def test_unknown_flags_are_kept_verbatim() -> None:
    """A brand-new flag must not silently vanish, or two configs would collide."""
    canonical = canonicalize(vllm({"some-brand-new-flag": "yes"}))
    assert canonical == "@dtype=auto;@quant=fp8;some-brand-new-flag=yes"


def test_key_order_does_not_matter() -> None:
    """The same flags in any order produce the same string."""
    a = canonicalize(vllm({"max-model-len": 4096, "enable-prefix-caching": True}))
    b = canonicalize(vllm({"enable-prefix-caching": True, "max-model-len": 4096}))
    assert a == b


# ---------------------------------------------------------------- number format


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        (8192, "8192"),
        (8192.0, "8192"),
        (0.9, "0.9"),
        (0.44, "0.44"),
        (0.8800000000000001, "0.88"),
        (1 / 3, "0.333333"),
        (0.0000001, "0"),
        (-0.0, "0"),
        (-2.5, "-2.5"),
        (1e21, "1e+21"),
        (1.5e-7, "0"),
        (2.0000004, "2"),
        (2.0000006, "2.000001"),
    ],
)
def test_number_formatting_matches_javascript(value: float, expected: str) -> None:
    """``String(Math.round(n * 1e6) / 1e6)`` semantics, ported exactly."""
    assert normalize_number(value) == expected


def test_stable_json_sorts_and_compacts() -> None:
    """Nested values render as compact JSON with sorted keys."""
    assert stable_json({"b": 1, "a": [3, 1, 2]}) == '{"a":[1,2,3],"b":1}'
    assert stable_json(None) == "null"
    assert stable_json(True) == "true"


def test_normalize_key_and_value_basics() -> None:
    """The small primitives other modules rely on."""
    assert normalize_key("  --Max_Model-Len ") == "max-model-len"
    assert normalize_value(" text ") == "text"
    assert normalize_value("TRUE") == "true"
    assert normalize_value(3) == "3"
