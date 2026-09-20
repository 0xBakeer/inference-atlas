"""The image workload runners, against the real workload and dataset files.

The lane is a stub that writes a picture instead of asking a GPU for one; everything else —
the workload JSON, the dataset rows, the render specs, the scorers — is what ships. That is
deliberate: these tests fail if a committed workload stops lining up with the runner that
has to execute it.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from atlas_bench.images import ImageLane, ImageResult
from atlas_bench.registry import Registry
from atlas_bench.spec import TaskSpec
from atlas_bench.workloads import RunContext, get_runner, resolve_workload
from atlas_bench.workloads.eval import run_eval
from atlas_bench.workloads.image import run_image

REPO_ROOT = Path(__file__).resolve().parents[2]


class StubLane(ImageLane):
    """Writes a flat PNG per request and remembers what it was asked for."""

    kind = "stub"
    invocation = "stub://lane"

    def __init__(self, *, fail_ids: set[str] | None = None, transparent: bool = True,
                 seconds: float = 1.5):
        self.requests = []
        self.written: list[Path] = []
        self.fail_ids = set(fail_ids or ())
        self.transparent = transparent
        self.seconds = seconds

    def supports_transparency(self) -> bool:
        return self.transparent

    async def render(self, request, out_path: Path) -> ImageResult:
        from PIL import Image, ImageDraw

        self.requests.append(request)
        if request.id in self.fail_ids:
            return ImageResult(request.id, False, warmup=request.warmup, wall_s=0.1,
                               status=500, error_category="http-5xx", error_message="boom")
        rgba = request.transparent and self.transparent
        image = Image.new("RGBA" if rgba else "RGB", (request.width, request.height),
                          (0, 0, 0, 0) if rgba else (30, 40, 60))
        box = (request.width // 4, request.height // 4, request.width // 2, request.height // 2)
        ImageDraw.Draw(image).rectangle(box, fill=(200, 120, 60, 255) if rgba else (200, 120, 60))
        out_path.parent.mkdir(parents=True, exist_ok=True)
        image.save(out_path)
        self.written.append(out_path)
        return ImageResult(request.id, True, path=out_path, wall_s=self.seconds,
                           server_s=self.seconds, warmup=request.warmup, status=200)


def context_for(workload_id: str, lane: ImageLane, **overrides) -> RunContext:
    registry = Registry(REPO_ROOT)
    spec = TaskSpec.model_validate({
        "engine": {"id": "qwen-image-spark", "version": "0.1.0", "base_url": "http://box:8020"},
        "model": {"id": "Qwen/Qwen-Image-2.1", "quant_id": "bf16"},
        "hardware": {"id": "nvidia-gb10-dgx-spark", "count": 1},
        "workloads": [{"id": workload_id}],
    })
    workload, params = resolve_workload(registry, spec.workloads[0])
    params.update(overrides)
    return RunContext(spec=spec, registry=registry, client=None, workload=workload,
                      params=params, image_lane=lane)


# ------------------------------------------------------------------ kind = image


def test_the_registry_routes_image_workloads_to_the_image_runner() -> None:
    assert get_runner("image") is run_image


@pytest.mark.asyncio
async def test_latency_workload_renders_every_prompt_and_excludes_warmup() -> None:
    lane = StubLane()
    ctx = context_for("t2i-single-1k-40s-v1", lane)
    outcome = await run_image(ctx)

    assert outcome.kind == "image"
    # 6 prompts x 3 repeats measured, plus 1 warmup that is rendered and then ignored.
    assert len(lane.requests) == 19
    assert sum(1 for r in lane.requests if r.warmup) == 1
    assert outcome.metrics["requests_total"] == 18
    assert outcome.metrics["requests_ok"] == 18
    assert outcome.metrics["success_rate"] == 1.0
    assert outcome.metrics["s_per_image"]["p50"] == pytest.approx(1.5)
    assert outcome.resolved_params["width"] == 1024
    assert outcome.resolved_params["repeat"] == 3
    assert outcome.resolved_params["lane"] == "stub"
    assert not outcome.failures


@pytest.mark.asyncio
async def test_the_2k_workload_asks_for_the_native_2k_size() -> None:
    lane = StubLane()
    outcome = await run_image(context_for("t2i-single-2k-40s-v1", lane, repeat=1,
                                          warmup_requests=0))
    assert {(r.width, r.height) for r in lane.requests} == {(2048, 2048)}
    assert outcome.metrics["requests_total"] == 6


@pytest.mark.asyncio
async def test_edit_workloads_send_the_reference_images_the_rows_carry() -> None:
    one = StubLane()
    await run_image(context_for("edit-ref1-1k-40s-v1", one, repeat=1, warmup_requests=0))
    assert {len(r.references) for r in one.requests} == {1}
    assert all(path.is_file() for r in one.requests for path in r.references)

    four = StubLane()
    await run_image(context_for("edit-ref4-1k-40s-v1", four, repeat=1, warmup_requests=0))
    assert {len(r.references) for r in four.requests} == {4}


@pytest.mark.asyncio
async def test_failures_are_recorded_rather_than_dropped() -> None:
    lane = StubLane(fail_ids={"spd-0002"})
    outcome = await run_image(context_for("t2i-single-1k-40s-v1", lane, repeat=1,
                                          warmup_requests=0))
    assert outcome.metrics["requests_total"] == 6
    assert outcome.metrics["requests_failed"] == 1
    assert outcome.metrics["success_rate"] == pytest.approx(5 / 6)
    assert outcome.failures[0]["category"] == "http-5xx"
    assert outcome.failures[0]["sample_request_id"] == "spd-0002"


@pytest.mark.asyncio
async def test_no_generated_images_survive_the_run() -> None:
    lane = StubLane()
    outcome = await run_image(context_for("t2i-single-1k-40s-v1", lane, repeat=1,
                                          warmup_requests=0))
    assert lane.written, "the stub did write pictures"
    assert not any(path.exists() for path in lane.written), (
        "the scratch directory is removed with the run: no generated image outlives it"
    )
    # And nothing image-shaped leaked into the record either.
    assert "b64_json" not in str(outcome.raw)


# ------------------------------------------------------------------ kind = eval, image suites


@pytest.mark.asyncio
async def test_run_eval_dispatches_an_image_suite_to_the_image_runner() -> None:
    lane = StubLane()
    outcome = await run_eval(context_for("eval-t2i-rgba-v1", lane, warmup_requests=0))
    assert outcome.kind == "eval"
    assert outcome.scores["suite"] == "t2i-rgba"
    assert outcome.scores["total"] == 4
    assert outcome.resolved_params["lane"] == "stub"


@pytest.mark.asyncio
async def test_transparency_suite_scores_the_alpha_channel() -> None:
    lane = StubLane(transparent=True)
    outcome = await run_eval(context_for("eval-t2i-rgba-v1", lane, warmup_requests=0))
    item = next(i for i in outcome.scores["items"] if i["id"] == "t2i-0018")
    assert item["correct"] is True
    assert item["metrics"]["has_alpha"] == 1
    assert item["metrics"]["components"] == 1
    assert item["predicted"] is None, "a generated picture is never stored, not even as text"
    assert outcome.scores["accuracy"] == 1.0


@pytest.mark.asyncio
async def test_a_lane_without_transparency_fails_the_suite_and_says_why() -> None:
    lane = StubLane(transparent=False)
    outcome = await run_eval(context_for("eval-t2i-rgba-v1", lane, warmup_requests=0))
    assert outcome.scores["accuracy"] == 0.0
    assert any(g["severity"] == "blocker" and "transparency" in g["text"]
               for g in outcome.gotchas)


@pytest.mark.asyncio
async def test_text_suite_uses_the_row_render_spec_and_an_injected_reader() -> None:
    lane = StubLane()
    expected = {
        "t2i-0001": "GOLDEN CRUMB BAKERY OPEN 7 AM TO 6 PM",
        "t2i-0002": "NORTHERN LIGHTS SEPTEMBER 14 HALL B",
    }
    ctx = context_for("eval-t2i-text-v1", lane, warmup_requests=0,
                      scorer_config={"ocr_reader": lambda path: expected.get(Path(path).stem, "")})
    outcome = await run_eval(ctx)

    # t2i-0002 is the native 2K poster: the size comes from the frozen row, not the workload.
    sizes = {r.id: (r.width, r.height) for r in lane.requests}
    assert sizes["t2i-0002"] == (2048, 2048)
    assert sizes["t2i-0001"] == (1024, 1024)

    by_id = {item["id"]: item for item in outcome.scores["items"]}
    assert by_id["t2i-0001"]["correct"] is True
    assert by_id["t2i-0001"]["metrics"]["cer"] == 0.0
    assert by_id["t2i-0003"]["correct"] is False
    assert outcome.scores["total"] == 6 and outcome.scores["correct"] == 2


@pytest.mark.asyncio
async def test_the_edit_case_of_the_text_suite_sends_its_reference() -> None:
    lane = StubLane()
    await run_eval(context_for("eval-t2i-text-v1", lane, warmup_requests=0,
                               scorer_config={"ocr_reader": lambda path: ""}))
    edit = next(r for r in lane.requests if r.id == "t2i-0022")
    assert len(edit.references) == 1 and edit.references[0].name == "text_plate.png"


@pytest.mark.asyncio
async def test_fidelity_suite_without_a_bundle_blocks_instead_of_scoring_zero() -> None:
    lane = StubLane()
    outcome = await run_eval(context_for("eval-t2i-fidelity-v1", lane, warmup_requests=0))
    assert outcome.scores["total"] == 0, "nothing is scorable without a reference"
    assert outcome.scores["accuracy"] == 0.0
    assert outcome.failures[0]["category"] == "unscorable"
    assert "no reference bundle" in outcome.failures[0]["message"]


@pytest.mark.asyncio
async def test_fidelity_against_a_bundle_this_very_lane_produced(tmp_path: Path) -> None:
    """A lane compared against its own reference is a determinism check, and scores 1.0."""
    from atlas_bench.reference import build_reference_bundle
    from atlas_bench.scorers.fidelity import load_reference_bundle

    lane = StubLane()
    ctx = context_for("eval-t2i-fidelity-v1", lane, warmup_requests=0)
    manifest = await build_reference_bundle(
        ctx.spec, registry=ctx.registry, out_dir=tmp_path / "bundle", lane=lane
    )
    assert len(manifest["items"]) == 24
    assert manifest["config_id"] and manifest["args_canonical"]
    assert not manifest["failures"]

    bundle = load_reference_bundle(tmp_path / "bundle")
    outcome = await run_eval(context_for("eval-t2i-fidelity-v1", StubLane(), warmup_requests=0,
                                         reference_bundle=bundle, lpips="off"))
    assert outcome.scores["total"] == 24
    assert outcome.scores["accuracy"] == 1.0
    item = outcome.scores["items"][0]
    assert item["metrics"]["psnr"] == 100.0
    assert item["metrics"]["phash_hamming"] == 0
    assert outcome.resolved_params["reference_cases"] == 24
    # result.schema.json's workload.resolved_params is a flat map: string, number, boolean,
    # array or null, and nothing else. The bundle header is nested, so it is flattened into
    # reference_* keys — a sub-object here is a schema error on every eval suite run with a
    # reference bundle, not only on the fidelity one.
    assert not any(isinstance(value, dict)
                   for value in outcome.resolved_params.values()), outcome.resolved_params
    assert outcome.resolved_params["reference_engine_id"] == "qwen-image-spark"
    assert outcome.resolved_params["reference_workload_id"] == "eval-t2i-fidelity-v1"


@pytest.mark.asyncio
async def test_a_reference_from_another_case_set_is_refused(tmp_path: Path) -> None:
    import json

    from atlas_bench.reference import build_reference_bundle
    from atlas_bench.scorers.fidelity import load_reference_bundle

    lane = StubLane()
    ctx = context_for("eval-t2i-fidelity-v1", lane, warmup_requests=0)
    await build_reference_bundle(ctx.spec, registry=ctx.registry, out_dir=tmp_path / "b",
                                 lane=lane)
    manifest_path = tmp_path / "b" / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["items"]["t2i-0001"]["render_digest"] = "0" * 16
    manifest_path.write_text(json.dumps(manifest))

    outcome = await run_eval(context_for(
        "eval-t2i-fidelity-v1", StubLane(), warmup_requests=0,
        reference_bundle=load_reference_bundle(tmp_path / "b"), lpips="off"))
    assert outcome.scores["total"] == 23, "the tampered case is not scored"
    assert any("digest-mismatch" in f["message"] for f in outcome.failures)


def test_runners_are_not_coroutine_leaks() -> None:
    """A sanity check that the module-level asyncio import is actually used by the tests."""
    assert asyncio.iscoroutinefunction(run_image)


# ------------------------------------------------------------------ end to end


@pytest.mark.asyncio
async def test_an_image_run_produces_a_result_file_that_validates(tmp_path: Path) -> None:
    """Packet in, valid result file out — schema, recomputed ids, path and plausibility."""
    from atlas_bench.client import utc_now
    from atlas_bench.hwinfo import GpuInfo, HostInfo
    from atlas_bench.repo import write_json
    from atlas_bench.result import ResultInputs, build_result, output_path
    from atlas_bench.validate import validate_file

    lane = StubLane()
    ctx = context_for("t2i-single-1k-40s-v1", lane, repeat=1, warmup_requests=1)
    outcome = await run_image(ctx)

    host = HostInfo(platform="linux", arch="aarch64", os="Ubuntu 24.04", kernel="6.11.0",
                    cpu="NVIDIA GB10", cpu_cores=20, ram_gb=121.0, driver="580.95",
                    cuda="13.0")
    host.gpus = [GpuInfo(name="NVIDIA GB10", memory_total_mb=124000, driver="580.95")]
    record = build_result(ResultInputs(
        spec=ctx.spec,
        registry=ctx.registry,
        host=host,
        outcome=outcome,
        workload=ctx.workload,
        github_login="tester",
        started_at=utc_now(),
        finished_at=utc_now(),
        serve_command="./run.sh serve",
        attached=True,
    ))
    assert record["kind"] == "image"
    assert record["metrics"]["s_per_image"]["p50"] == pytest.approx(1.5)
    assert "scores" not in record

    path = output_path(record, tmp_path)
    write_json(path, record)
    issues = validate_file(path, Registry(REPO_ROOT))
    errors = [i for i in issues if i.level == "error"]
    assert errors == [], "\n".join(str(i) for i in issues)


@pytest.mark.asyncio
async def test_an_image_eval_result_validates_and_keeps_no_content(tmp_path: Path) -> None:
    from atlas_bench.client import utc_now
    from atlas_bench.hwinfo import GpuInfo, HostInfo
    from atlas_bench.repo import write_json
    from atlas_bench.result import ResultInputs, build_result, output_path
    from atlas_bench.validate import validate_file

    lane = StubLane()
    ctx = context_for("eval-t2i-rgba-v1", lane, warmup_requests=0)
    outcome = await run_eval(ctx)

    host = HostInfo(platform="linux", arch="aarch64", os="Ubuntu 24.04", kernel="6.11.0",
                    cpu="NVIDIA GB10", cpu_cores=20, ram_gb=121.0)
    host.gpus = [GpuInfo(name="NVIDIA GB10", memory_total_mb=124000)]
    record = build_result(ResultInputs(
        spec=ctx.spec, registry=ctx.registry, host=host, outcome=outcome,
        workload=ctx.workload, github_login="tester", started_at=utc_now(),
        finished_at=utc_now(), serve_command="./run.sh serve", attached=True,
    ))
    assert record["kind"] == "eval"
    assert all(item["predicted"] is None for item in record["scores"]["items"])
    assert record["scores"]["items"][0]["metrics"]["has_alpha"] == 1

    path = output_path(record, tmp_path)
    write_json(path, record)
    errors = [i for i in validate_file(path, Registry(REPO_ROOT)) if i.level == "error"]
    assert errors == []
