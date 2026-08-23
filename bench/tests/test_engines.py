"""Engine adapters: the commands they build are the commands that go into the result."""

from __future__ import annotations

import shlex
from pathlib import Path

import pytest

from atlas_bench.engines import ADAPTERS, AttachAdapter, build_flags, get_adapter
from atlas_bench.registry import Registry
from atlas_bench.spec import TaskSpec


def spec(**overrides) -> TaskSpec:
    """A packet with overridable engine/model blocks."""
    payload = {
        "engine": {
            "id": "vllm",
            "version": "0.27.1",
            "install": {"method": "docker", "image": "vllm/vllm-openai:v{version}"},
        },
        "model": {"id": "test-model-1b", "quant_id": "fp8", "hf_id": "test/Test-Model-1B-FP8"},
        "hardware": {"id": "test-gpu-24gb", "count": 1},
        "args": {"max-model-len": 32768, "enable-prefix-caching": True},
        "workloads": ["serve-test-c2-v1"],
    }
    for key, value in overrides.items():
        if isinstance(value, dict) and isinstance(payload.get(key), dict):
            payload[key] = {**payload[key], **value}
        else:
            payload[key] = value
    return TaskSpec.model_validate(payload)


def test_build_flags_renders_every_value_kind() -> None:
    """Bools, numbers, lists and JSON objects all become correct CLI tokens."""
    tokens = build_flags(
        {
            "max-model-len": 262144,
            "enable-prefix-caching": True,
            "enforce-eager": False,
            "not-passed": None,
            "speculative-config": {"method": "mtp", "num_speculative_tokens": 3},
            "lora-modules": ["a", "b"],
        }
    )
    assert "--max-model-len" in tokens
    assert "262144" in tokens
    assert "--enable-prefix-caching" in tokens
    assert "--enforce-eager" not in tokens
    assert "--not-passed" not in tokens
    assert '{"method":"mtp","num_speculative_tokens":3}' in tokens
    assert tokens.count("--lora-modules") == 2


def test_build_flags_honours_bool_false_style() -> None:
    """vLLM turns things off with ``--no-<flag>``, and the meta says so."""
    tokens = build_flags({"enable-prefix-caching": False}, bool_false_style="--no-{name}")
    assert tokens == ["--no-enable-prefix-caching"]


def test_vllm_docker_command(atlas_repo: Path) -> None:
    """The official image needs ``--entrypoint vllm … serve``."""
    adapter = get_adapter(spec(), Registry(atlas_repo))
    command = shlex.split(adapter.serve_command())
    assert command[:3] == ["docker", "run", "--rm"]
    assert "--gpus" in command and "all" in command
    assert "--ipc=host" in command
    assert command[command.index("--entrypoint") + 1] == "vllm"
    assert "vllm/vllm-openai:v0.27.1" in command
    assert command[command.index("serve") + 1] == "test/Test-Model-1B-FP8"
    assert "--max-model-len" in command
    assert command[-1] == "8000"


def test_aliases_are_rendered_with_the_engine_flag_name(atlas_repo: Path) -> None:
    """A packet written with ``-tp`` must not produce ``--tp`` on the command line."""
    adapter = get_adapter(spec(args={"-tp": 2, "max_model_len": 4096}), Registry(atlas_repo))
    command = shlex.split(adapter.serve_command())
    assert "--tensor-parallel-size" in command
    assert "--tp" not in command
    assert "--max-model-len" in command


def test_vllm_pip_command(atlas_repo: Path) -> None:
    """The pip install method drops the container wrapper."""
    adapter = get_adapter(spec(engine={"install": {"method": "pip"}}), Registry(atlas_repo))
    command = shlex.split(adapter.serve_command())
    assert command[:2] == ["vllm", "serve"]
    assert "docker" not in command


@pytest.mark.parametrize(
    ("engine_id", "expected"),
    [
        ("sglang", "sglang.launch_server"),
        ("mlx-lm", "mlx_lm.server"),
        ("tensorrt-llm", "trtllm-serve"),
        ("tgi", "text-generation-inference"),
    ],
)
def test_other_adapters_build_their_command(
    atlas_repo: Path, engine_id: str, expected: str
) -> None:
    """Every adapter produces a command a human could paste into a terminal."""
    packet = spec(engine={"id": engine_id, "install": {"method": "pip"}})
    adapter = ADAPTERS[engine_id](packet, Registry(atlas_repo))
    assert expected in adapter.serve_command()


def test_ollama_pulls_and_maps_options(atlas_repo: Path) -> None:
    """Ollama's knobs are per-request options, not server flags."""
    packet = spec(
        engine={"id": "ollama", "install": {"method": "ollama"}},
        model={"ollama_tag": "test:1b-q4_K_M"},
        args={"num-ctx": 8192, "max-model-len": 4096},
    )
    adapter = ADAPTERS["ollama"](packet, Registry(atlas_repo))
    assert "ollama pull test:1b-q4_K_M" in adapter.serve_command()
    assert adapter.request_extra_body() == {"options": {"num_ctx": 8192}}


def test_llamacpp_needs_a_gguf(atlas_repo: Path) -> None:
    """A GGUF-less packet fails loudly instead of serving the wrong file."""
    packet = spec(engine={"id": "llamacpp"}, model={"quant_id": "gguf-q5-k-m"})
    adapter = ADAPTERS["llamacpp"](packet, Registry(atlas_repo))
    with pytest.raises(ValueError, match="GGUF"):
        adapter.gguf_path()


def test_llamacpp_uses_a_local_path(atlas_repo: Path) -> None:
    """A local GGUF is served without touching the network."""
    packet = spec(engine={"id": "llamacpp"}, model={"local_path": "/models/x.gguf"})
    adapter = ADAPTERS["llamacpp"](packet, Registry(atlas_repo))
    assert adapter.gguf_path() == "/models/x.gguf"
    assert "/models/x.gguf" in adapter.serve_command()


def test_attach_mode_starts_nothing(atlas_repo: Path) -> None:
    """``--base-url`` is the common path and works for every engine."""
    packet = spec(engine={"base_url": "http://box:8000/v1"})
    adapter = get_adapter(packet, Registry(atlas_repo), attach=True)
    assert isinstance(adapter, AttachAdapter)
    assert adapter.base_url == "http://box:8000"
    result = adapter.start()
    assert result.started is False
    assert "attach" in result.serve_command


def test_unknown_engine_falls_back_to_attach(atlas_repo: Path) -> None:
    """Measuring a brand-new engine only needs a base URL."""
    adapter = get_adapter(spec(engine={"id": "brand-new-engine"}), Registry(atlas_repo))
    assert isinstance(adapter, AttachAdapter)


def test_lmstudio_and_exllamav3_never_spawn(atlas_repo: Path) -> None:
    """Both are attach-only by design."""
    for engine_id in ("lmstudio", "exllamav3"):
        adapter = ADAPTERS[engine_id](spec(engine={"id": engine_id}), Registry(atlas_repo))
        assert adapter.start().started is False


def test_health_and_models_urls_come_from_the_meta(atlas_repo: Path) -> None:
    """The engine registry decides where health lives."""
    adapter = get_adapter(spec(), Registry(atlas_repo))
    assert adapter.health_url == "http://127.0.0.1:8000/health"
    assert adapter.models_url == "http://127.0.0.1:8000/v1/models"


def test_hf_cache_mount_is_absolute(atlas_repo: Path) -> None:
    """``~`` is expanded: docker does not expand tildes and the command must be pasteable."""
    from atlas_bench.engines.base import hf_cache_dir

    command = get_adapter(spec(), Registry(atlas_repo)).serve_command()
    assert "~" not in command
    assert f"{hf_cache_dir()}:/root/.cache/huggingface" in shlex.split(command)


def test_hf_home_is_honoured(atlas_repo: Path, monkeypatch) -> None:
    """A contributor with weights on another volume sets HF_HOME and it is used."""
    monkeypatch.setenv("HF_HOME", "/mnt/weights/hf")
    command = get_adapter(spec(), Registry(atlas_repo)).serve_command()
    assert "/mnt/weights/hf:/root/.cache/huggingface" in shlex.split(command)
