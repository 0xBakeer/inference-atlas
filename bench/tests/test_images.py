"""Request shaping for the image lanes: what actually goes on the wire.

No server and no GPU. The HTTP lane runs against an `httpx.MockTransport` that records
every request, and the CLI lane runs a real subprocess — a throwaway Python script that
writes a PNG — because the thing worth testing there is argv handling, and a mock of
`subprocess` would only test the mock.
"""

from __future__ import annotations

import base64
import json
import re
import sys
from pathlib import Path

import httpx
import pytest

from atlas_bench.images import (
    CliImagesLane,
    ImageRequest,
    OpenAIImagesLane,
    build_lane,
    render_digest,
)
from atlas_bench.spec import TaskSpec

PNG_1X1 = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)


def request_of(**overrides) -> ImageRequest:
    base = {
        "id": "t2i-0001",
        "prompt": "a bakery sign",
        "width": 1024,
        "height": 1024,
        "steps": 40,
        "seed": 110001,
    }
    return ImageRequest(**{**base, **overrides})


def recording_transport(seen: list[httpx.Request], body: dict | None = None):
    payload = body if body is not None else {
        "data": [{"b64_json": base64.b64encode(PNG_1X1).decode()}],
        "timing": {"total_ms": 4200.0},
    }

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json=payload)

    return httpx.MockTransport(handler)


def spec_for(engine_id: str, **extra) -> TaskSpec:
    return TaskSpec.model_validate({
        "engine": {"id": engine_id, "version": "1.0", "base_url": "http://box:8000"},
        "model": {"id": "Qwen/Qwen-Image-2.1", "quant_id": "bf16"},
        **extra,
    })


# ------------------------------------------------------------------ parameter maps


@pytest.mark.parametrize(
    ("engine_id", "guidance_key"),
    [("vllm-omni", "true_cfg_scale"), ("sglang-diffusion", "guidance_scale"),
     ("qwen-image-spark", "guidance_scale")],
)
def test_guidance_is_spelled_per_engine(engine_id: str, guidance_key: str) -> None:
    lane = OpenAIImagesLane("http://box:8000", engine_id=engine_id)
    payload = lane.payload_for(request_of(guidance=4.0))
    assert payload[guidance_key] == 4.0
    assert payload["num_inference_steps"] == 40
    assert payload["size"] == "1024x1024"
    assert payload["seed"] == 110001


def test_transparency_is_sent_only_where_it_exists() -> None:
    """A lane without an RGBA switch must not be sent one: it 400s or ignores it."""
    ours = OpenAIImagesLane("http://box:8000", engine_id="qwen-image-spark")
    theirs = OpenAIImagesLane("http://box:8000", engine_id="vllm-omni")
    assert ours.payload_for(request_of(transparent=True))["transparent"] is True
    assert "transparent" not in theirs.payload_for(request_of(transparent=True))
    assert ours.supports_transparency() and not theirs.supports_transparency()


def test_param_map_is_a_whitelist() -> None:
    lane = OpenAIImagesLane("http://box:8000", param_map={"prompt": "prompt"})
    assert lane.payload_for(request_of(guidance=3.0)) == {"prompt": "a bakery sign"}


# ------------------------------------------------------------------ HTTP lane


@pytest.mark.asyncio
async def test_generation_posts_json_and_writes_the_png(tmp_path: Path) -> None:
    seen: list[httpx.Request] = []
    lane = OpenAIImagesLane("http://box:8000", engine_id="qwen-image-spark",
                            model="Qwen/Qwen-Image-2.1", transport=recording_transport(seen))
    out = tmp_path / "t2i-0001.png"
    result = await lane.render(request_of(), out)
    await lane.aclose()

    assert result.ok and out.read_bytes() == PNG_1X1
    assert seen[0].url.path == "/v1/images/generations"
    assert json.loads(seen[0].content)["prompt"] == "a bakery sign"
    # The server reported 4200 ms, so that is the number — not the (near-zero) wall clock.
    assert result.server_s == pytest.approx(4.2)
    assert result.seconds == pytest.approx(4.2)
    assert result.timing_source == "server"


@pytest.mark.asyncio
async def test_wall_clock_is_used_when_the_lane_reports_no_timing(tmp_path: Path) -> None:
    seen: list[httpx.Request] = []
    lane = OpenAIImagesLane("http://box:8000", engine_id="vllm-omni",
                            transport=recording_transport(seen))
    result = await lane.render(request_of(), tmp_path / "a.png")
    await lane.aclose()
    assert result.server_s is None and result.timing_source == "wall"
    assert result.seconds == result.wall_s


@pytest.mark.asyncio
async def test_edit_sends_multipart_with_one_image_field_per_reference(tmp_path: Path) -> None:
    references = []
    for name in ("mascot.png", "pattern.png"):
        path = tmp_path / name
        path.write_bytes(PNG_1X1)
        references.append(path)
    seen: list[httpx.Request] = []
    lane = OpenAIImagesLane("http://box:8000", engine_id="sglang-diffusion",
                            transport=recording_transport(seen))
    result = await lane.render(request_of(references=references), tmp_path / "out.png")
    await lane.aclose()

    assert result.ok
    assert seen[0].url.path == "/v1/images/edits"
    body = seen[0].content.decode("latin-1")
    assert seen[0].headers["content-type"].startswith("multipart/form-data")
    assert body.count('name="image"') == 2, "both references must be sent, not just the first"
    assert 'filename="mascot.png"' in body and 'filename="pattern.png"' in body
    assert 'name="num_inference_steps"' in body


@pytest.mark.asyncio
async def test_url_responses_are_followed(tmp_path: Path) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith(".png"):
            return httpx.Response(200, content=PNG_1X1)
        return httpx.Response(200, json={"data": [{"url": "http://box:8000/files/a.png"}]})

    lane = OpenAIImagesLane("http://box:8000", transport=httpx.MockTransport(handler))
    out = tmp_path / "a.png"
    result = await lane.render(request_of(), out)
    await lane.aclose()
    assert result.ok and out.read_bytes() == PNG_1X1


@pytest.mark.asyncio
@pytest.mark.parametrize(("status", "category"), [(400, "http-4xx"), (503, "http-5xx")])
async def test_http_failures_are_categorized(tmp_path: Path, status: int, category: str) -> None:
    lane = OpenAIImagesLane(
        "http://box:8000",
        transport=httpx.MockTransport(lambda r: httpx.Response(status, text="nope")),
    )
    result = await lane.render(request_of(), tmp_path / "a.png")
    await lane.aclose()
    assert not result.ok and result.error_category == category
    assert result.error_message == "nope"


@pytest.mark.asyncio
async def test_a_response_without_data_is_a_failure_not_a_crash(tmp_path: Path) -> None:
    lane = OpenAIImagesLane(
        "http://box:8000",
        transport=httpx.MockTransport(lambda r: httpx.Response(200, json={"data": []})),
    )
    result = await lane.render(request_of(), tmp_path / "a.png")
    await lane.aclose()
    assert not result.ok and result.error_category == "malformed-output"


# ------------------------------------------------------------------ CLI lane


FAKE_SD = """
import argparse, base64
ap = argparse.ArgumentParser()
ap.add_argument("-p"); ap.add_argument("-o"); ap.add_argument("-W"); ap.add_argument("-H")
ap.add_argument("--steps"); ap.add_argument("--seed")
ap.add_argument("--rgba", action="store_true")
ap.add_argument("-r", action="append", default=[]); ap.add_argument("--model")
args = ap.parse_args()
open(args.o, "wb").write(base64.b64decode(PNG))
print("wrote", args.o, "refs", len(args.r))
"""


def fake_cli(tmp_path: Path) -> list[str]:
    """A stand-in for `sd-cli`: parses the argv this lane builds and writes the PNG."""
    script = tmp_path / "fake_sd.py"
    script.write_text(
        f'PNG = "{base64.b64encode(PNG_1X1).decode()}"\n' + FAKE_SD, encoding="utf-8"
    )
    return [sys.executable, str(script), "-p", "{prompt}", "-W", "{width}", "-H", "{height}",
            "--steps", "{steps}", "--seed", "{seed}", "-o", "{out}", "--model", "{model_path}"]


def test_cli_argv_fills_every_placeholder(tmp_path: Path) -> None:
    lane = CliImagesLane(fake_cli(tmp_path), variables={"model_path": "/w/q8.gguf"},
                         image_args=["-r", "{image}"], transparent_args=["--rgba"])
    argv = lane.argv(
        request_of(transparent=True, references=[Path("/w/a.png"), Path("/w/b.png")]),
        tmp_path / "out.png",
    )
    assert argv[argv.index("-W") + 1] == "1024"
    assert argv[argv.index("--seed") + 1] == "110001"
    assert argv[argv.index("--model") + 1] == "/w/q8.gguf"
    assert argv.count("-r") == 2, "the flag repeats once per reference image"
    assert argv[-1] == "--rgba"


def test_cli_single_token_reference_form(tmp_path: Path) -> None:
    lane = CliImagesLane([*fake_cli(tmp_path), "--ref={image...}"])
    argv = lane.argv(request_of(references=[Path("/w/a.png"), Path("/w/b.png")]), tmp_path / "o.png")
    assert argv[-2:] == ["--ref=/w/a.png", "--ref=/w/b.png"]
    plain = lane.argv(request_of(), tmp_path / "o.png")
    assert not [t for t in plain if t.startswith("--ref=")], "no references, no tokens"


def test_cli_template_without_out_is_rejected() -> None:
    with pytest.raises(ValueError, match=re.escape("{out}")):
        CliImagesLane(["sd-cli", "-p", "{prompt}"])


@pytest.mark.asyncio
async def test_cli_lane_runs_a_real_process(tmp_path: Path) -> None:
    lane = CliImagesLane(fake_cli(tmp_path), variables={"model_path": "/w/q8.gguf"})
    out = tmp_path / "out.png"
    result = await lane.render(request_of(prompt='a sign reading "OPEN"'), out)
    assert result.ok and out.read_bytes() == PNG_1X1
    assert result.wall_s > 0 and result.timing_source == "wall"


@pytest.mark.asyncio
async def test_cli_exit_zero_without_a_file_is_a_failure(tmp_path: Path) -> None:
    script = tmp_path / "quiet.py"
    script.write_text("print('done')\n", encoding="utf-8")
    lane = CliImagesLane([sys.executable, str(script), "{out}"])
    result = await lane.render(request_of(), tmp_path / "never.png")
    assert not result.ok and result.error_category == "malformed-output"


@pytest.mark.asyncio
async def test_cli_missing_binary_is_reported_not_raised(tmp_path: Path) -> None:
    lane = CliImagesLane(["definitely-not-a-binary-9x", "{out}"])
    result = await lane.render(request_of(), tmp_path / "a.png")
    assert not result.ok and "cannot start" in (result.error_message or "")


# ------------------------------------------------------------------ lane construction


def test_build_lane_defaults_to_http_and_honours_the_engine_map() -> None:
    lane = build_lane(spec_for("vllm-omni"))
    assert isinstance(lane, OpenAIImagesLane)
    assert lane.param_map["guidance"] == "true_cfg_scale"
    assert lane.model == "Qwen/Qwen-Image-2.1"


def test_build_lane_builds_a_cli_lane_from_the_packet(tmp_path: Path) -> None:
    lane = build_lane(spec_for("sdcpp", image_lane={
        "kind": "cli", "command": ["sd-cli", "-o", "{out}"], "image_args": ["-r", "{image}"],
    }))
    assert isinstance(lane, CliImagesLane) and lane.image_args == ["-r", "{image}"]


def test_unknown_lane_kind_is_refused() -> None:
    with pytest.raises(ValueError, match="unknown image lane kind"):
        build_lane(spec_for("comfyui", image_lane={"kind": "workflow", "command": []}))


def test_render_digest_changes_with_every_ingredient() -> None:
    base = {"width": 1024, "height": 1024, "steps": 40, "seed": 7, "transparent": False}
    digest = render_digest("a fox", base)
    assert len(digest) == 16
    assert render_digest("a fox", base) == digest
    assert render_digest("a cat", base) != digest
    for key, value in (("width", 2048), ("steps", 20), ("seed", 8), ("transparent", True)):
        assert render_digest("a fox", {**base, key: value}) != digest
    assert render_digest("a fox", {**base, "reference_images": ["images/a.png"]}) != digest


def test_sglang_spells_transparency_as_the_background_enum() -> None:
    """`transparent: True` is `background: "transparent"` on this lane, not `background: true`.

    SGLang-Diffusion's ImageGenerationsRequest declares `background: transparent|opaque|auto`,
    gpt-image-1's spelling. Sending the boolean is the failure mode eval-t2i-rgba-v1 exists to
    catch: it comes back opaque and the suite scores the API rather than the model.
    """
    lane = OpenAIImagesLane("http://x", engine_id="sglang-diffusion", model="m")
    payload = lane.payload_for(
        ImageRequest(id="a", prompt="p", width=1024, height=1024, steps=40, seed=42,
                     transparent=True))
    assert payload["background"] == "transparent"
    assert lane.supports_transparency() is True
    plain = lane.payload_for(
        ImageRequest(id="b", prompt="p", width=1024, height=1024, steps=40, seed=42))
    assert "background" not in plain, "an opaque case leaves the lane's own default alone"


def test_the_recipe_server_keeps_the_boolean_spelling() -> None:
    """Only targets in _WIRE_TRUE are translated; qwen-image-spark's knob really is a bool."""
    lane = OpenAIImagesLane("http://x", engine_id="qwen-image-spark", model="m")
    payload = lane.payload_for(
        ImageRequest(id="a", prompt="p", width=1024, height=1024, steps=40, seed=42,
                     transparent=True))
    assert payload["transparent"] is True


def test_sglang_inference_time_is_preferred_over_the_wall_clock() -> None:
    """SGLang returns inference_time_s; it is the engine's own number and excludes the client."""
    lane = OpenAIImagesLane("http://x", engine_id="sglang-diffusion", model="m")
    assert lane.timing == ("inference_time_s", "s")
    assert lane._server_seconds({"inference_time_s": 36.08}) == 36.08
    assert lane._server_seconds({}) is None
