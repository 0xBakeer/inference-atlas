"""End-to-end: packet in, valid result file out — against a fake streaming server."""

from __future__ import annotations

import json
from types import SimpleNamespace
from pathlib import Path

import pytest

from atlas_bench.canonical import canonicalize
from atlas_bench.hwinfo import GpuInfo, HostInfo
from atlas_bench.ids import cell_id, config_id_from_canonical, run_id
from atlas_bench.registry import Registry
from atlas_bench.runner import plan_spec, run_spec
from atlas_bench.spec import TaskSpec
from atlas_bench.validate import validate_file
from atlas_bench.scorers import get_scorer
from tests.conftest import FakeOpenAIServer, drop_pre_migration_schema_errors

LOGIN = "tester"


def host() -> HostInfo:
    """A fixed host so the fingerprint and host block are deterministic."""
    info = HostInfo(
        platform="linux",
        arch="x86_64",
        os="Ubuntu 24.04.3 LTS",
        kernel="6.11.0",
        cpu="AMD EPYC 7543",
        cpu_cores=32,
        ram_gb=256.0,
        driver="580.95.05",
        cuda="13.0",
    )
    info.gpus = [GpuInfo(name="Test GPU 24GB", memory_total_mb=24576, driver="580.95.05")]
    info.captured = {"nvidia_smi": {"driver": "580.95.05", "cuda": "13.0"}}
    return info


def make_spec(workload: str = "serve-test-c2-v1", **overrides) -> TaskSpec:
    """A packet for the throwaway registry."""
    payload = {
        "packet_version": 1,
        "engine": {
            "id": "vllm",
            "version": "0.27.1",
            "install": {"method": "docker", "image": "vllm/vllm-openai:v0.27.1"},
            "base_url": "http://fake",
        },
        "model": {
            "id": "acme/test-model-1b",
            "quant_id": "fp8",
            "hf_id": "acme/test-model-1b",
            "dtype": "auto",
        },
        "hardware": {"id": "test-gpu-24gb", "count": 1},
        "args": {
            "max-model-len": 32768,
            "gpu-memory-utilization": 0.9,
            "-tp": 1,
            "enable-prefix-caching": True,
        },
        "workloads": [workload],
        "request": {"temperature": 0, "seed": 42},
        "github_login": LOGIN,
    }
    payload.update(overrides)
    return TaskSpec.model_validate(payload)


async def run(atlas_repo: Path, server: FakeOpenAIServer, spec: TaskSpec, **kwargs):
    """Run a packet against the fake server."""
    return await run_spec(
        spec,
        registry=Registry(atlas_repo),
        out_dir=atlas_repo / "results",
        github_login=LOGIN,
        telemetry=False,
        transport=server.transport,
        host=host(),
        **kwargs,
    )


# ------------------------------------------------------------------- serving


async def test_serving_run_writes_a_valid_result(
    atlas_repo: Path, fake_server: FakeOpenAIServer
) -> None:
    """The happy path: one workload, one file, everything recomputable."""
    output = await run(atlas_repo, fake_server, make_spec())

    assert len(output.paths) == 1
    path = output.paths[0]
    record = json.loads(path.read_text())

    # Path and filename are derived, not chosen.
    # <owner>/<name> is the model id, so the path has one level more than the other
    # registries (SPEC §2, decision 20).
    assert path.relative_to(atlas_repo).parts[:5] == (
        "results",
        "vllm",
        "acme",
        "test-model-1b",
        "test-gpu-24gb",
    )
    assert path.name == f"{record['run_id']}.json"

    # Ids recompute from the content.
    registry = Registry(atlas_repo)
    resolved = registry.resolve_config(
        engine_id="vllm",
        engine_version="0.27.1",
        args=record["args"],
        quant_id="fp8",
        dtype="auto",
    )
    canonical = canonicalize(resolved.canonical_input)
    assert record["args_canonical"] == canonical
    assert record["config_id"] == config_id_from_canonical(canonical)
    assert record["cell_id"] == cell_id(
        model_id="acme/test-model-1b",
        quant_id="fp8",
        hardware_id="test-gpu-24gb",
        hw_count=1,
        engine_id="vllm",
        engine_version="0.27.1",
    )
    assert record["run_id"] == run_id(
        cfg_id=record["config_id"],
        workload_id="serve-test-c2-v1",
        github_login=LOGIN,
        started_at=record["provenance"]["started_at"],
    )

    # Defaults dropped, aliases resolved, ports removed.
    assert "gpu-memory-utilization" not in canonical
    assert "tensor-parallel-size" not in canonical  # tp=1 is the version default
    assert "max-model-len=32768" in canonical

    # Metrics were actually measured.
    metrics = record["metrics"]
    assert metrics["requests_total"] == 6
    assert metrics["requests_ok"] == 6
    assert metrics["success_rate"] == 1.0
    assert metrics["output_tok_s"] > 0
    assert metrics["ttft_ms"]["p50"] > 0
    assert metrics["itl_ms"]["mean"] > 0
    assert metrics["decode_tok_s_per_request"]["mean"] > 0

    # Warmup happened and is excluded from the aggregate.
    assert len(fake_server.requests) == 7

    # Provenance and bookkeeping.
    assert record["provenance"]["github_login"] == LOGIN
    assert record["provenance"]["method"] == "atlas-bench"
    assert record["provenance"]["github_user_id"] is None
    assert record["provenance"]["commit"] is None
    assert record["hardware"]["fingerprint"].startswith("sha256:")
    assert record["raw"]["harness"] == "atlas-bench"
    assert len(record["raw"]["sha256"]) == 64
    assert record["verification"]["level"] == "self-reported"
    assert record["failures"] == []


async def test_result_passes_local_validation(
    atlas_repo: Path, fake_server: FakeOpenAIServer
) -> None:
    """The file the harness writes passes its own validator, schema included."""
    output = await run(atlas_repo, fake_server, make_spec())
    issues = drop_pre_migration_schema_errors(validate_file(output.paths[0], Registry(atlas_repo)))
    errors = [i for i in issues if i.level == "error"]
    assert errors == [], "\n".join(str(i) for i in issues)


async def test_validator_catches_hand_edited_numbers(
    atlas_repo: Path, fake_server: FakeOpenAIServer
) -> None:
    """Editing a flag by hand breaks the recomputed ids — which is the whole point."""
    output = await run(atlas_repo, fake_server, make_spec())
    path = output.paths[0]
    record = json.loads(path.read_text())
    record["args"]["max-model-len"] = 8192
    path.write_text(json.dumps(record))

    codes = {i.code for i in validate_file(path, Registry(atlas_repo)) if i.level == "error"}
    assert "args-canonical-mismatch" in codes
    assert "config-id-mismatch" in codes


async def test_failures_are_recorded_not_hidden(atlas_repo: Path) -> None:
    """A server that OOMs every third request produces failures and a blocker gotcha."""
    server = FakeOpenAIServer(fail_every=3, fail_status=500, fail_body="CUDA out of memory")
    output = await run(atlas_repo, server, make_spec())
    record = json.loads(output.paths[0].read_text())

    assert record["metrics"]["requests_failed"] >= 1
    assert record["metrics"]["success_rate"] < 1.0
    assert record["failures"][0]["category"] == "oom"
    assert record["failures"][0]["at"] == "request"
    assert any(g["severity"] == "blocker" for g in record["gotchas"])


# --------------------------------------------------------------------- sweep


async def test_sweep_walks_the_axis(atlas_repo: Path, fake_server: FakeOpenAIServer) -> None:
    """Every concurrency level is measured and recorded."""
    output = await run(atlas_repo, fake_server, make_spec("sweep-test-1-4-v1"))
    record = json.loads(output.paths[0].read_text())

    assert record["kind"] == "sweep"
    assert [entry["concurrency"] for entry in record["sweep"]] == [1, 2, 4]
    assert all(entry["metrics"]["requests_ok"] == 4 for entry in record["sweep"])
    assert record["workload"]["resolved_params"]["levels_run"] == [1, 2, 4]
    assert record["workload"]["resolved_params"]["stopped_at"] is None


async def test_sweep_stops_escalating_on_failure(atlas_repo: Path) -> None:
    """When a level falls over, the sweep records it and stops instead of pretending."""
    server = FakeOpenAIServer(fail_every=2, fail_status=500, fail_body="CUDA out of memory")
    output = await run(atlas_repo, server, make_spec("sweep-test-1-4-v1"))
    record = json.loads(output.paths[0].read_text())

    assert len(record["sweep"]) == 1
    assert record["workload"]["resolved_params"]["stopped_at"] == 1
    assert any("Sweep stopped" in g["text"] for g in record["gotchas"])


# ---------------------------------------------------------------------- eval


async def test_eval_scores_every_item(atlas_repo: Path) -> None:
    """The eval workload answers, scores and aggregates by category and difficulty."""
    answers = {"2+2?": "The answer is 4", "3+3?": "The answer is 6", "x?": "The answer is 41"}

    def responder(messages):
        prompt = str(messages[-1].get("content"))
        return answers.get(prompt, "no idea")

    server = FakeOpenAIServer(responder=responder)
    output = await run(atlas_repo, server, make_spec("eval-test-v1"))
    record = json.loads(output.paths[0].read_text())

    scores = record["scores"]
    assert record["kind"] == "eval"
    assert scores["suite"] == "math"
    assert scores["total"] == 3
    assert scores["correct"] == 2
    assert scores["accuracy"] == pytest.approx(2 / 3, abs=1e-6)
    assert scores["by_category"] == {
        "algebra": {"total": 1, "correct": 0},
        "arithmetic": {"total": 2, "correct": 2},
    }
    assert scores["by_difficulty"]["easy"] == {"total": 2, "correct": 2}
    assert {item["id"] for item in scores["items"]} == {"m-1", "m-2", "m-3"}
    assert all(isinstance(item["correct"], bool) for item in scores["items"])
    assert scores["avg_latency_ms"] > 0
    # Every request completed; one of them was simply wrong, which is accuracy, not failure.
    assert scores["success_rate"] == 1.0
    assert record["metrics"]["success_rate"] == 1.0


async def test_eval_success_rate_is_independent_of_correctness(atlas_repo: Path) -> None:
    """A failed request lowers ``success_rate`` and leaves accuracy to the scored items."""
    server = FakeOpenAIServer(responder=lambda m: "The answer is 4", fail_every=3)
    output = await run(atlas_repo, server, make_spec("eval-test-v1"))
    record = json.loads(output.paths[0].read_text())

    scores = record["scores"]
    assert scores["success_rate"] == pytest.approx(2 / 3, abs=1e-6)
    assert scores["total"] == 2, "the failed request cannot be scored"
    assert len(scores["items"]) == 2
    assert scores["failures"] == 1
    assert record["failures"][0]["category"] == "http-5xx"
    # The request layer agrees with the score layer about what completed.
    assert record["metrics"]["success_rate"] == scores["success_rate"]
    assert record["metrics"]["requests_failed"] == 1


async def test_eval_result_is_schema_valid(atlas_repo: Path) -> None:
    """An eval result validates too (``scores`` is required for kind=eval)."""
    server = FakeOpenAIServer(responder=lambda m: "Answer: 4")
    output = await run(atlas_repo, server, make_spec("eval-test-v1"))
    issues = drop_pre_migration_schema_errors(validate_file(output.paths[0], Registry(atlas_repo)))
    errors = [i for i in issues if i.level == "error"]
    assert errors == [], "\n".join(str(i) for i in errors)


# ------------------------------------------------------------------- dry run


async def test_abstaining_beats_guessing_in_the_index(atlas_repo: Path) -> None:
    """Declining costs nothing; a wrong answer costs what a right one earns.

    Accuracy alone cannot tell an honest "I don't know" from a fabrication — both score
    zero — which pays a model to guess. omniscience_index has to separate them.
    """
    items = [
        {"id": "k-1", "category": "Finance", "difficulty": "unrated",
         "prompt": "Which reference?", "answer": "ASC 606-10-25-15", "scorer": "abstention"},
        {"id": "k-2", "category": "Finance", "difficulty": "unrated",
         "prompt": "Which reference?", "answer": "ASC 842-10-15-3", "scorer": "abstention"},
    ]
    dataset_dir = atlas_repo / "datasets" / "eval-test-v1"
    (dataset_dir / "items.jsonl").write_text(
        "\n".join(json.dumps(i) for i in items) + "\n", encoding="utf-8"
    )
    meta = json.loads((dataset_dir / "dataset.json").read_text())
    meta["count"] = len(items)
    (dataset_dir / "dataset.json").write_text(json.dumps(meta), encoding="utf-8")

    # One right, one declined: nothing was fabricated, so the index is not dragged down.
    replies = iter(["The reference is ASC 606-10-25-15.", "I do not know."])

    def responder(messages):
        return next(replies)

    output = await run(atlas_repo, FakeOpenAIServer(responder=responder), make_spec("eval-test-v1"))
    honest = json.loads(output.paths[0].read_text())["scores"]
    assert honest["correct"] == 1
    assert honest["abstained"] == 1
    assert honest["incorrect"] == 0
    assert honest["accuracy"] == pytest.approx(0.5)
    assert honest["omniscience_index"] == pytest.approx(0.5)
    assert honest["hallucination_rate"] == pytest.approx(0.0)

    # One right, one fabricated: identical accuracy, and the index says the difference.
    guesses = iter(["The reference is ASC 606-10-25-15.", "It is ASC 999-99-99."])
    output = await run(
        atlas_repo, FakeOpenAIServer(responder=lambda m: next(guesses)), make_spec("eval-test-v1")
    )
    guessing = json.loads(output.paths[0].read_text())["scores"]
    assert guessing["accuracy"] == pytest.approx(honest["accuracy"]), "accuracy cannot tell them apart"
    assert guessing["incorrect"] == 1
    assert guessing["omniscience_index"] == pytest.approx(0.0)
    assert guessing["hallucination_rate"] == pytest.approx(0.5)
    assert guessing["omniscience_index"] < honest["omniscience_index"]


@pytest.mark.parametrize(
    ("reply", "expected_detail"),
    [
        ("The reference is ASC 606-10-25-15.", "correct"),
        ("I do not know.", "abstained"),
        ("I do not have access to that database, so I cannot provide the figure.", "abstained"),
        ("I am an AI and cannot name the individual directly.", "abstained"),
        ("It is ASC 999-99-99.", "incorrect"),
    ],
)
def test_abstention_verdicts(reply: str, expected_detail: str) -> None:
    """The three verdicts, including the phrasings a real model actually used.

    "I cannot provide" and "I do not have access" are how gemma-4-E2B declined 52 times in
    a 600-item run, and a regex that only knew "I don't know" scored every one of them as a
    fabrication.
    """
    row = SimpleNamespace(answer="ASC 606-10-25-15", meta={})
    result = get_scorer("abstention")(reply, row)
    assert result.detail == expected_detail
    assert result.scored is True


def test_an_empty_answer_is_unscorable_not_wrong() -> None:
    """Silence is not a wrong answer.

    With thinking on and a fixed output budget the thought block can consume the whole
    allowance and leave `content` empty. Counting those as fabrications once turned a 3%
    score into a 97% "hallucination rate" that described the output cap, not the model.
    """
    row = SimpleNamespace(answer="ASC 606-10-25-15", meta={})
    result = get_scorer("abstention")("   ", row)
    assert result.scored is False
    assert result.detail == "empty-output"
    assert result.correct is False


def test_zip_entry_names_survive_a_missing_utf8_flag() -> None:
    """A zip that stores UTF-8 names without setting bit 11 must still round-trip.

    zipfile falls back to CP437, so a curly apostrophe arrives as mojibake and the file no
    longer exists under the name the questions reference. Four AA-LCR items went unscorable
    for exactly that reason, with nothing wrong in the data.
    """
    from zipfile import ZipInfo

    from datasets_prepare_aa_lcr import _entry_name  # type: ignore[import-not-found]

    real = "EU\u2019s Official Journal.txt"
    mangled = ZipInfo(real.encode("utf-8").decode("cp437"))
    mangled.flag_bits = 0
    assert _entry_name(mangled) == real

    proper = ZipInfo(real)
    proper.flag_bits = 0x800
    assert _entry_name(proper) == real


async def test_documents_are_prepended_to_the_question(atlas_repo: Path) -> None:
    """The corpus goes in front of the question, and the question survives.

    The missing-corpus path returns before it ever builds a prompt, so testing only that
    branch left the path that actually runs unexercised — and it shipped broken, reaching
    for a `prompt` attribute EvalRow does not have.
    """
    dataset_dir = atlas_repo / "datasets" / "eval-test-v1"
    corpus_dir = dataset_dir / "documents" / "lcr" / "Legal" / "set_a"
    corpus_dir.mkdir(parents=True)
    (corpus_dir / "one.txt").write_text("Apple prevailed on the design claim.", encoding="utf-8")
    (corpus_dir / "two.txt").write_text("Crocs lost on appeal.", encoding="utf-8")

    items = [
        {
            "id": "lcr-1",
            "category": "Legal",
            "difficulty": "unrated",
            "prompt": "Which party prevailed on the design claim?",
            "answer": "Apple",
            "scorer": "contains",
            "meta": {
                "documents": {
                    "set_id": "set_a",
                    "category": "Legal",
                    "files": ["one.txt", "two.txt"],
                }
            },
        }
    ]
    (dataset_dir / "items.jsonl").write_text(
        "\n".join(json.dumps(i) for i in items) + "\n", encoding="utf-8"
    )
    meta = json.loads((dataset_dir / "dataset.json").read_text())
    meta["count"] = len(items)
    (dataset_dir / "dataset.json").write_text(json.dumps(meta), encoding="utf-8")

    server = FakeOpenAIServer(responder=lambda m: "Apple")
    output = await run(atlas_repo, server, make_spec("eval-test-v1"))
    record = json.loads(output.paths[0].read_text())

    sent = server.requests[-1]["messages"]
    body = "\n".join(str(m.get("content") or "") for m in sent)
    assert "Apple prevailed on the design claim." in body, "document one is missing"
    assert "Crocs lost on appeal." in body, "document two is missing"
    assert "Which party prevailed on the design claim?" in body, "the question was dropped"
    assert body.index("Apple prevailed") < body.index("Which party prevailed"), (
        "documents must precede the question"
    )

    scores = record["scores"]
    assert scores["total"] == 1, "with its documents present the item is scorable"
    assert scores["correct"] == 1


async def test_documents_missing_leaves_the_item_unscored(atlas_repo: Path) -> None:
    """A long-context question asked without its documents is not a smaller measurement.

    aa-lcr items carry `meta.documents`; when the fetched corpus is absent the item must be
    left unscored and counted as a failure, never answered on the bare question and folded
    into accuracy as though the model had read 95k tokens it never saw.
    """
    items = [
        {
            "id": "lcr-1",
            "category": "Legal",
            "difficulty": "unrated",
            "prompt": "Which party prevailed?",
            "answer": "Apple",
            "scorer": "contains",
            "meta": {"documents": {"set_id": "missing_set", "category": "Legal", "files": ["a.txt"]}},
        }
    ]
    dataset_dir = atlas_repo / "datasets" / "eval-test-v1"
    (dataset_dir / "items.jsonl").write_text(
        "\n".join(json.dumps(i) for i in items) + "\n", encoding="utf-8"
    )
    meta = json.loads((dataset_dir / "dataset.json").read_text())
    meta["count"] = len(items)
    (dataset_dir / "dataset.json").write_text(json.dumps(meta), encoding="utf-8")

    server = FakeOpenAIServer(responder=lambda m: "Apple")
    output = await run(atlas_repo, server, make_spec("eval-test-v1"))
    record = json.loads(output.paths[0].read_text())

    scores = record["scores"]
    assert scores["total"] == 0, "an item with no documents must not reach accuracy"
    assert scores["items"] == []
    assert scores["failures"] >= 1
    # The request itself completed — the item is unscorable, not failed on the wire.
    assert record["metrics"]["requests_ok"] == 1


async def test_agentic_result_passes_schema_validation(atlas_repo: Path) -> None:
    """The record an agentic run writes must validate, not merely be written.

    The first real agentic result failed on two counts the unit tests could not see:
    per-session rows were put in `sweep`, which the schema defines as a swept point WITH a
    metric block, and the session-depth distribution was a metric name the closed block does
    not allow. Both only surface against the real schema.
    """
    server = FakeOpenAIServer(responder=lambda m: "ack")
    output = await run(atlas_repo, server, make_spec("agentic-test-v1"))
    issues = drop_pre_migration_schema_errors(
        validate_file(output.paths[0], Registry(atlas_repo))
    )
    errors = [i for i in issues if i.level == "error"]
    assert not errors, f"agentic result does not validate: {[i.message for i in errors]}"

    record = json.loads(output.paths[0].read_text())
    assert record.get("sweep") in (None, []), "sessions are not swept points"
    assert record["raw"]["payload"]["sessions"], "per-session detail must survive in raw"


async def test_agentic_replays_the_recording_not_the_model(atlas_repo: Path) -> None:
    """Every assistant turn is measured, and the history that grows is the recording's.

    The point of a replay is that the prompt is identical on every engine. If the model's
    own answer were appended instead, two servers would diverge after the first turn and the
    comparison would be between trajectories rather than between servers.
    """
    server = FakeOpenAIServer(responder=lambda m: "I would do something else entirely")
    output = await run(atlas_repo, server, make_spec("agentic-test-v1"))
    record = json.loads(output.paths[0].read_text())

    assert record["kind"] == "agentic"
    # Two assistant turns in the recording, so two measured requests.
    assert record["metrics"]["requests_ok"] == 2
    sessions = record["raw"]["payload"]["sessions"]
    assert len(sessions) == 1
    assert sessions[0]["conversation_id"] == "sess-1"
    assert sessions[0]["turns_measured"] == 2

    # The second request must carry the recorded tool call and its result, never the text
    # the fake server just produced.
    second = server.requests[-1]["messages"]
    roles = [m["role"] for m in second]
    assert roles == ["system", "user", "assistant", "tool"]
    assert second[2]["tool_calls"][0]["function"]["name"] == "shell"
    assert second[3]["content"] == "1 failed"
    assert all("something else entirely" not in json.dumps(m) for m in second)

    # Tools travel with every turn, not just the first.
    assert server.requests[-1]["tools"][0]["function"]["name"] == "shell"


async def test_agentic_context_grows_turn_over_turn(atlas_repo: Path) -> None:
    """Each turn sends strictly more than the last — the property the workload exists for."""
    server = FakeOpenAIServer(responder=lambda m: "ack")
    await run(atlas_repo, server, make_spec("agentic-test-v1"))
    lengths = [len(req["messages"]) for req in server.requests if "messages" in req]
    assert lengths == sorted(lengths)
    assert lengths[-1] > lengths[0]


async def test_agentic_records_whether_tool_delays_were_honoured(atlas_repo: Path) -> None:
    """Skipping the recorded pauses is an upper bound, and says so in the result."""
    server = FakeOpenAIServer(responder=lambda m: "ack")
    output = await run(atlas_repo, server, make_spec("agentic-test-v1"))
    record = json.loads(output.paths[0].read_text())

    # The fixture sets honour_tool_delays: False so the 30s pause is not slept through.
    assert record["workload"]["resolved_params"]["honour_tool_delays"] is False
    assert any("upper bound" in g["text"] for g in record["gotchas"])
    assert record["raw"]["payload"]["sessions"][0]["tool_delay_s"] == 0.0


async def test_dry_run_touches_nothing(atlas_repo: Path, fake_server: FakeOpenAIServer) -> None:
    """``--dry-run`` resolves the plan without sending a request or writing a file."""
    output = await run(atlas_repo, fake_server, make_spec(), dry_run=True)
    assert output.paths == []
    assert fake_server.requests == []
    assert output.plan[0]["workload_id"] == "serve-test-c2-v1"
    assert output.plan[0]["kind"] == "serving"
    assert output.plan[0]["registered"] is True
    assert not list((atlas_repo / "results").rglob("*.json"))


def test_plan_marks_unregistered_workloads(atlas_repo: Path) -> None:
    """A workload the checkout does not have is still runnable, but flagged."""
    plan = plan_spec(make_spec("sweep-brand-new-v1"), Registry(atlas_repo))
    assert plan[0]["registered"] is False
    assert plan[0]["kind"] == "sweep"


async def test_two_workloads_produce_two_files(
    atlas_repo: Path, fake_server: FakeOpenAIServer
) -> None:
    """One result file per workload, both under the same cell."""
    spec = make_spec()
    spec.workloads = TaskSpec.model_validate(
        {
            **json.loads(spec.model_dump_json()),
            "workloads": ["serve-test-c2-v1", "sweep-test-1-4-v1"],
        }
    ).workloads
    output = await run(atlas_repo, fake_server, spec)
    assert len(output.paths) == 2
    cells = {json.loads(p.read_text())["cell_id"] for p in output.paths}
    assert len(cells) == 1
