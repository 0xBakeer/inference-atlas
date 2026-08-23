"""The LM Studio attach path: a desktop server whose model key is its own.

LM Studio serves the Hugging Face repo ``google/gemma-4-E2B-it`` under the key
``google/gemma-4-e2b``. The two must never be confused: the repo id is the identity that
every computed id hashes and that the result path is built from, the key is transport. These
tests pin that separation, because getting it wrong produces a result that looks perfect and
describes a different model.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from atlas_bench.engines import ADAPTERS
from atlas_bench.engines.base import AttachAdapter, get_adapter
from atlas_bench.registry import Registry
from atlas_bench.runner import run_spec
from atlas_bench.spec import TaskSpec
from atlas_bench.validate import validate_file
from tests.conftest import FakeOpenAIServer, drop_pre_migration_schema_errors
from tests.test_run_e2e import host

MODEL_ID = "google/gemma-4-E2B-it"
LM_STUDIO_KEY = "google/gemma-4-e2b"
LOGIN = "tester"


def make_spec(**overrides) -> TaskSpec:
    """A packet for the gemma run on this machine."""
    payload = {
        "packet_version": 1,
        "engine": {
            "id": "lmstudio",
            "version": "0.4.21",
            "install": {"method": "app"},
            "base_url": "http://localhost:1234/v1",
        },
        "model": {
            "id": MODEL_ID,
            "quant_id": "mlx-4bit",
            "hf_id": MODEL_ID,
            "served_model_id": LM_STUDIO_KEY,
            "dtype": "auto",
        },
        "hardware": {"id": "apple-m2-max-32gb", "count": 1},
        "args": {},
        "workloads": ["eval-test-v1"],
        "request": {"temperature": 0, "seed": 42},
        "github_login": LOGIN,
    }
    for key, value in overrides.items():
        if isinstance(value, dict) and isinstance(payload.get(key), dict):
            payload[key] = {**payload[key], **value}
        else:
            payload[key] = value
    return TaskSpec.model_validate(payload)


async def run(repo: Path, server: FakeOpenAIServer, spec: TaskSpec, **kwargs):
    """Run the packet against a fake LM Studio."""
    return await run_spec(
        spec,
        registry=Registry(repo),
        out_dir=repo / "results",
        github_login=LOGIN,
        telemetry=False,
        transport=server.transport,
        host=host(),
        **kwargs,
    )


# --------------------------------------------------------------------- adapter


def test_adapter_is_attach_only(lmstudio_repo: Path) -> None:
    """``--base-url`` gives the attach adapter, which starts nothing and claims nothing."""
    adapter = get_adapter(make_spec(), Registry(lmstudio_repo))
    assert isinstance(adapter, AttachAdapter)
    assert adapter.base_url == "http://localhost:1234"
    assert adapter.serve_command() is None
    result = adapter.start()
    assert result.started is False


def test_lmstudio_adapter_uses_the_model_key(lmstudio_repo: Path) -> None:
    """``lms load`` takes the LM Studio key, not the Hugging Face repo id."""
    adapter = ADAPTERS["lmstudio"](make_spec(), Registry(lmstudio_repo))
    assert adapter.model_ref() == LM_STUDIO_KEY
    assert adapter.default_port == 1234
    command = adapter.serve_command()
    assert command is None or LM_STUDIO_KEY in command


def test_lmstudio_adapter_falls_back_to_the_registry(lmstudio_repo: Path) -> None:
    """Without a key in the packet the quant record may name one, else the repo id.

    Note this is the *LM Studio* key, not a download location: LM Studio already has the
    weights, so unlike vLLM it is addressed by its own model key.
    """
    spec = make_spec()
    spec.model.served_model_id = None
    adapter = ADAPTERS["lmstudio"](spec, Registry(lmstudio_repo))
    assert adapter.model_ref() == MODEL_ID


# ------------------------------------------------------------ served model id


async def test_served_model_id_is_sent_and_recorded(lmstudio_repo: Path) -> None:
    """The key goes on the wire and into raw.payload; the ids stay the repo id."""
    server = FakeOpenAIServer(model=LM_STUDIO_KEY, responder=lambda m: "Answer: 4")
    output = await run(lmstudio_repo, server, make_spec())
    record = json.loads(output.paths[0].read_text())

    assert all(body["model"] == LM_STUDIO_KEY for body in server.requests)
    endpoint = record["raw"]["payload"]["engine_endpoint"]
    assert endpoint["served_model_id"] == LM_STUDIO_KEY
    assert endpoint["advertised_models"] == [LM_STUDIO_KEY]
    assert endpoint["attached"] is True
    assert endpoint["base_url"] == "http://localhost:1234/v1"

    # Identity is untouched by transport.
    assert record["model"]["id"] == MODEL_ID
    assert record["model"]["hf_id"] == MODEL_ID
    assert record["serve_command"] is None
    assert output.warnings == []


async def test_result_lands_under_owner_and_name(lmstudio_repo: Path) -> None:
    """``results/<engine>/<owner>/<name>/<hardware>/`` — the model id is two levels."""
    server = FakeOpenAIServer(model=LM_STUDIO_KEY, responder=lambda m: "Answer: 4")
    output = await run(lmstudio_repo, server, make_spec())
    path = output.paths[0]

    assert path.relative_to(lmstudio_repo).parts[:5] == (
        "results",
        "lmstudio",
        "google",
        "gemma-4-E2B-it",
        "apple-m2-max-32gb",
    )
    assert path.name.endswith(".json")
    issues = drop_pre_migration_schema_errors(validate_file(path, Registry(lmstudio_repo)))
    errors = [i for i in issues if i.level == "error"]
    assert errors == [], "\n".join(str(i) for i in errors)


async def test_a_key_the_server_does_not_advertise_warns(lmstudio_repo: Path) -> None:
    """Sending an unknown key is allowed — LM Studio may load on demand — but it is said."""
    server = FakeOpenAIServer(model="something/else", responder=lambda m: "Answer: 4")
    output = await run(lmstudio_repo, server, make_spec())

    assert any(w.startswith("served-model-not-advertised") for w in output.warnings)
    assert all(body["model"] == LM_STUDIO_KEY for body in server.requests)


async def test_case_only_difference_resolves_itself(lmstudio_repo: Path) -> None:
    """When the server differs from the repo id only by case, no packet field is needed."""
    server = FakeOpenAIServer(model=MODEL_ID.lower(), responder=lambda m: "Answer: 4")
    spec = make_spec()
    spec.model.served_model_id = None
    output = await run(lmstudio_repo, server, spec)

    assert all(body["model"] == MODEL_ID.lower() for body in server.requests)
    assert output.warnings == []
    record = json.loads(output.paths[0].read_text())
    assert record["model"]["id"] == MODEL_ID


async def test_guessing_between_loaded_models_is_reported(lmstudio_repo: Path) -> None:
    """Two models loaded and none matching: the run continues but says it guessed."""

    class TwoModels(FakeOpenAIServer):
        def handle(self, request):
            if request.url.path.endswith("/v1/models"):
                import httpx

                return httpx.Response(
                    200, json={"data": [{"id": "other/model-a"}, {"id": "other/model-b"}]}
                )
            return super().handle(request)

    server = TwoModels(responder=lambda m: "Answer: 4")
    spec = make_spec()
    spec.model.served_model_id = None
    output = await run(lmstudio_repo, server, spec)

    assert any(w.startswith("served-model-guessed") for w in output.warnings)
    assert all(body["model"] == "other/model-a" for body in server.requests)


@pytest.mark.parametrize("field", ["served_model_id", "served_name"])
def test_both_spellings_of_the_field_are_accepted(field: str) -> None:
    """Packets in the wild may carry either name; they mean the same thing."""
    spec = TaskSpec.model_validate(
        {
            "engine": {"id": "lmstudio", "version": "0.4.21"},
            "model": {"id": MODEL_ID, "quant_id": "mlx-4bit", field: LM_STUDIO_KEY},
        }
    )
    assert spec.model.served_model_id == LM_STUDIO_KEY
    assert spec.packet_dict()["model"]["served_model_id"] == LM_STUDIO_KEY


async def test_stream_options_rejection_does_not_break_a_run(lmstudio_repo: Path) -> None:
    """A server that rejects ``stream_options`` still produces a full serving result."""
    server = FakeOpenAIServer(
        model=LM_STUDIO_KEY, reject_stream_options=True, chunks=4, chunk_delay_s=0
    )
    spec = make_spec(workloads=["serve-test-c2-v1"])
    output = await run(lmstudio_repo, server, spec)
    record = json.loads(output.paths[0].read_text())

    assert record["metrics"]["success_rate"] == 1.0
    assert record["metrics"]["output_tokens_total"] > 0
    assert record["metrics"]["ttft_ms"]["p50"] >= 0
