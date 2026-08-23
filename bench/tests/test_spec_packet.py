"""Task packet: model, loader, generation and round-trip (SPEC §7)."""

from __future__ import annotations

import json
from pathlib import Path

from atlas_bench.packet import AGENT_RULES, build_packet, find_cell, parse_cell
from atlas_bench.registry import Registry
from atlas_bench.spec import PACKET_VERSION, TaskSpec, load_spec


def test_workload_refs_accept_both_forms() -> None:
    """``"id"`` and ``{"id": ..., "params": {...}}`` both work."""
    spec = TaskSpec.model_validate(
        {
            "engine": {"id": "vllm", "version": "0.27.1"},
            "model": {"id": "m", "quant_id": "fp8"},
            "workloads": ["serve-a-v1", {"id": "sweep-b-v1", "params": {"num_requests": 4}}],
        }
    )
    assert [w.id for w in spec.workloads] == ["serve-a-v1", "sweep-b-v1"]
    assert spec.workloads[1].params == {"num_requests": 4}


def test_unknown_packet_fields_are_preserved() -> None:
    """A newer packet must not break an older harness."""
    spec = TaskSpec.model_validate(
        {
            "engine": {"id": "vllm", "version": "0.27.1"},
            "model": {"id": "m", "quant_id": "fp8"},
            "future_field": {"x": 1},
        }
    )
    assert spec.packet_dict()["future_field"] == {"x": 1}


def test_load_spec_round_trip(tmp_path: Path) -> None:
    """A packet written to disk loads back identically."""
    payload = {
        "packet_version": PACKET_VERSION,
        "engine": {"id": "vllm", "version": "0.27.1"},
        "model": {"id": "m", "quant_id": "fp8"},
        "hardware": {"id": "h", "count": 2},
        "args": {"max-model-len": 4096},
        "workloads": ["serve-a-v1"],
    }
    path = tmp_path / "task.json"
    path.write_text(json.dumps(payload))
    spec = load_spec(path)
    assert spec.hardware.count == 2
    assert spec.args == {"max-model-len": 4096}
    reloaded = TaskSpec.model_validate(spec.packet_dict())
    assert reloaded.packet_dict() == spec.packet_dict()


def test_packet_dict_is_ordered_like_the_spec() -> None:
    """The JSON tab in the app shows the fields in SPEC §7 order."""
    spec = TaskSpec.model_validate(
        {"engine": {"id": "vllm", "version": "0.27.1"}, "model": {"id": "m", "quant_id": "fp8"}}
    )
    keys = list(spec.packet_dict())[:8]
    assert keys == [
        "packet_version",
        "repo",
        "cell",
        "engine",
        "model",
        "hardware",
        "args",
        "workloads",
    ]


def test_build_packet_fills_from_the_registry(atlas_repo: Path) -> None:
    """Ids, HF ids, container image, branch and PR title are all derived."""
    packet = build_packet(
        Registry(atlas_repo),
        engine_id="vllm",
        engine_version="0.27.1",
        model_id="test-model-1b",
        quant_id="fp8",
        hardware_id="test-gpu-24gb",
        workloads=["serve-test-c2-v1"],
        args={"max-model-len": 32768},
    )
    assert packet["packet_version"] == PACKET_VERSION
    assert packet["model"]["hf_id"] == "test/Test-Model-1B-FP8"
    assert packet["engine"]["install"]["method"] == "docker"
    assert packet["engine"]["install"]["image"] == "vllm/vllm-openai:v0.27.1"
    assert packet["hardware"]["expected_detect"]["nvidia_smi_name"] == ["Test GPU 24GB"]
    assert packet["cell"]["engine_minor"] == "0.27"
    assert packet["branch"].startswith("result/vllm-test-model-1b-test-gpu-24gb-")
    assert packet["pr_title"].startswith("results: vllm 0.27.1 test-model-1b fp8 on")
    assert packet["agent_rules"] == AGENT_RULES


def test_generated_packet_is_a_valid_task_spec(atlas_repo: Path) -> None:
    """What ``atlas-bench packet`` prints is exactly what ``atlas-bench run`` consumes."""
    packet = build_packet(
        Registry(atlas_repo),
        engine_id="vllm",
        engine_version="0.27.1",
        model_id="test-model-1b",
        quant_id="fp8",
        hardware_id="test-gpu-24gb",
        workloads=["serve-test-c2-v1"],
    )
    spec = TaskSpec.model_validate(packet)
    assert spec.engine.id == "vllm"
    assert [w.id for w in spec.workloads] == ["serve-test-c2-v1"]
    assert spec.hardware.id == "test-gpu-24gb"


def test_packet_for_unregistered_hardware(atlas_repo: Path) -> None:
    """A "new hardware" gap still produces a usable packet."""
    packet = build_packet(
        Registry(atlas_repo),
        engine_id="vllm",
        engine_version="0.27.1",
        model_id="test-model-1b",
        quant_id="fp8",
        hardware_id=None,
        workloads=["serve-test-c2-v1"],
    )
    assert packet["cell"] is None or packet["cell"]["cell_id"] is None
    assert packet["branch"].endswith("new-hardware-new")


def test_parse_cell() -> None:
    """The compact cell form used by ``--cell``."""
    assert parse_cell("vllm@0.27.1/qwen3.8-27b/fp8/nvidia-gb10-dgx-spark") == {
        "engine_id": "vllm",
        "engine_version": "0.27.1",
        "model_id": "qwen3.8-27b",
        "quant_id": "fp8",
        "hardware_id": "nvidia-gb10-dgx-spark",
    }
    assert parse_cell("nonsense") is None


def test_find_cell_scans_existing_results(atlas_repo: Path) -> None:
    """A 12-hex cell id resolves against the results already in the checkout."""
    record = {
        "cell_id": "abcdef123456",
        "engine": {"id": "vllm", "version": "0.27.1"},
        "model": {"id": "test-model-1b", "quant_id": "fp8"},
        "hardware": {"id": "test-gpu-24gb"},
    }
    target = atlas_repo / "results" / "vllm" / "test-model-1b" / "test-gpu-24gb" / "r.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(record))
    assert find_cell(Registry(atlas_repo), "abcdef123456")["model_id"] == "test-model-1b"
    assert find_cell(Registry(atlas_repo), "000000000000") is None


def test_repo_accepts_both_a_url_and_the_site_config_object() -> None:
    """``site/config.json`` carries ``repo`` as an object; a packet may also carry a URL."""
    base = {"engine": {"id": "vllm", "version": "0.27.1"}, "model": {"id": "m", "quant_id": "fp8"}}
    as_url = TaskSpec.model_validate({**base, "repo": "https://github.com/owner/repo"})
    as_object = TaskSpec.model_validate(
        {**base, "repo": {"owner": "owner", "name": "repo", "default_branch": "main"}}
    )
    assert as_url.repo_url == "https://github.com/owner/repo"
    assert as_object.repo_url == "https://github.com/owner/repo"
    assert TaskSpec.model_validate(base).repo_url is None
