"""Talking to an image-generation lane.

Two shapes cover every lane in this registry, and the rest of the harness sees neither:

* **`openai_images`** — an HTTP server with `/v1/images/generations` (JSON) and
  `/v1/images/edits` (multipart, one repeated `image` field per reference). vLLM-Omni,
  SGLang-Diffusion and the qwen-image-spark recipe all speak it, and they all spell the
  parameters differently: `num_inference_steps` here, `true_cfg_scale` there,
  `guidance_scale` somewhere else, `transparent` on exactly one of them. `PARAM_MAPS` is
  that translation, and it is a **whitelist**: a parameter a lane has no entry for is not
  sent at all, so a lane that rejects unknown fields does not fail on request 3 of 24.
* **`cli`** — a command that writes a PNG and exits (stable-diffusion.cpp). The packet
  carries an argv template with `{prompt} {seed} {width} {height} {steps} {out}` and a
  repeated `{image...}` token for references; nothing is passed through a shell.

What a lane reports about its own timing is preferred over the wall clock when it offers
one (`timing.total_ms`), because the wall clock includes the client. Which of the two was
used is recorded per request rather than averaged silently.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import os
import shlex
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import httpx

__all__ = [
    "PARAM_MAPS",
    "CliImagesLane",
    "ImageLane",
    "ImageRequest",
    "ImageResult",
    "OpenAIImagesLane",
    "build_lane",
    "render_digest",
]

#: Canonical parameter names. A lane maps them to its own spelling, or to ``None`` for
#: "this lane has no such knob", which is not the same as "send it and hope".
CANONICAL_PARAMS = (
    "prompt",
    "negative_prompt",
    "seed",
    "size",
    "steps",
    "guidance",
    "n",
    "transparent",
    "response_format",
    "model",
)

_OPENAI_BASE = {
    "prompt": "prompt",
    "negative_prompt": "negative_prompt",
    "seed": "seed",
    "size": "size",
    "steps": "num_inference_steps",
    "n": "n",
    "response_format": "response_format",
    "model": "model",
    "transparent": None,
    "guidance": None,
}

#: Per-engine parameter names. Extend this when a lane is added; do not guess at runtime.
PARAM_MAPS: dict[str, dict[str, str | None]] = {
    # vLLM-Omni calls classifier-free guidance true_cfg_scale and has no RGBA switch.
    "vllm-omni": {**_OPENAI_BASE, "guidance": "true_cfg_scale"},
    # SGLang-Diffusion calls the same knob guidance_scale, and spells transparency the way
    # gpt-image-1 does: `background`, an enum rather than a boolean (see _WIRE_TRUE).
    "sglang-diffusion": {**_OPENAI_BASE, "guidance": "guidance_scale",
                         "transparent": "background"},
    # The recipe's own server accepts either spelling and adds `transparent` for the RGBA
    # mode, which is the whole reason the transparency suite can be run at all.
    "qwen-image-spark": {**_OPENAI_BASE, "guidance": "guidance_scale",
                         "transparent": "transparent"},
    #: Anything else that claims the OpenAI images shape.
    "default": dict(_OPENAI_BASE),
}

#: What a canonical `True` becomes for targets that are not booleans. `transparent` is a flag
#: in one spelling and an enum in the other — OpenAI's `background` takes
#: transparent/opaque/auto — and a lane that is sent `background: true` either rejects it or,
#: worse, ignores it and returns an opaque picture that the RGBA suite then scores.
_WIRE_TRUE: dict[str, str] = {"background": "transparent"}

#: Where a lane reports its own inference time, and in which unit. Preferred over the wall
#: clock: it is the engine's own number and it excludes the client.
TIMING_PATHS: dict[str, tuple[str, str]] = {
    "qwen-image-spark": ("timing.total_ms", "ms"),
    "sglang-diffusion": ("inference_time_s", "s"),
}


def render_digest(prompt: str, render: dict[str, Any]) -> str:
    """Fingerprint of everything that decides what the picture is.

    The reference implementation is ``datasets/_gen/_lib.render_digest`` and the two are
    pinned to each other by a test over the committed dataset rows. It exists so the
    fidelity scorer can refuse to compare a candidate against a reference produced from a
    different spec: a number that looks like drift but is a different picture is worse than
    no number at all.
    """
    parts = [
        prompt,
        str(render["width"]),
        str(render["height"]),
        str(render["steps"]),
        str(render["seed"]),
        "rgba" if render.get("transparent") else "rgb",
        ",".join(render.get("reference_images") or ()),
    ]
    return hashlib.sha256("|".join(parts).encode("utf-8")).hexdigest()[:16]


@dataclass
class ImageRequest:
    """One picture to make."""

    id: str
    prompt: str
    width: int
    height: int
    steps: int
    seed: int
    guidance: float | None = None
    transparent: bool = False
    n: int = 1
    negative_prompt: str | None = None
    references: list[Path] = field(default_factory=list)
    warmup: bool = False

    @property
    def size(self) -> str:
        return f"{self.width}x{self.height}"

    @property
    def is_edit(self) -> bool:
        return bool(self.references)


@dataclass
class ImageResult:
    """What came back: a file on disk, or a failure that is itself a result."""

    id: str
    ok: bool
    path: Path | None = None
    wall_s: float = 0.0
    server_s: float | None = None
    warmup: bool = False
    status: int | None = None
    error_category: str | None = None
    error_message: str | None = None
    sent: dict[str, Any] = field(default_factory=dict)

    @property
    def seconds(self) -> float:
        """Server-reported inference time when the lane reports one, wall clock otherwise."""
        return self.server_s if self.server_s is not None else self.wall_s

    @property
    def timing_source(self) -> str:
        return "server" if self.server_s is not None else "wall"


class ImageLane:
    """Base class. A lane turns an :class:`ImageRequest` into a file."""

    kind = "lane"
    #: Filled with the command or URL that was used, for the result's ``serve_command``.
    invocation: str | None = None

    async def render(self, request: ImageRequest, out_path: Path) -> ImageResult:
        raise NotImplementedError

    async def aclose(self) -> None:
        pass


def _dig(payload: Any, path: str) -> Any:
    """Follow a dotted path into a JSON response, or return None."""
    node = payload
    for key in path.split("."):
        if not isinstance(node, dict) or key not in node:
            return None
        node = node[key]
    return node


class OpenAIImagesLane(ImageLane):
    """`/v1/images/generations` and `/v1/images/edits` against one base URL."""

    kind = "openai_images"

    def __init__(
        self,
        base_url: str,
        *,
        engine_id: str = "default",
        model: str | None = None,
        api_key: str | None = None,
        timeout_s: float = 1800.0,
        param_map: dict[str, str | None] | None = None,
        extra_params: dict[str, Any] | None = None,
        timing: tuple[str, str] | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
    ):
        self.base_url = base_url.rstrip("/")
        self.engine_id = engine_id
        self.model = model
        self.param_map = dict(param_map or PARAM_MAPS.get(engine_id, PARAM_MAPS["default"]))
        self.extra_params = dict(extra_params or {})
        self.timing = timing if timing is not None else TIMING_PATHS.get(engine_id)
        self.invocation = f"{self.base_url}/v1/images/generations"
        headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
        self._client = httpx.AsyncClient(
            base_url=self.base_url, timeout=timeout_s, headers=headers, transport=transport
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    def payload_for(self, request: ImageRequest) -> dict[str, Any]:
        """Canonical parameters translated into this lane's spelling.

        Only what the map names is sent. `transparent: None` in a map means the lane cannot
        do RGBA, and a transparent case run against it measures the API rather than the
        model — the runner records that as a gotcha instead of quietly sending the flag.
        """
        canonical: dict[str, Any] = {
            "prompt": request.prompt,
            "seed": request.seed,
            "size": request.size,
            "steps": request.steps,
            "n": request.n,
            "response_format": "b64_json",
            "model": self.model,
        }
        if request.guidance is not None:
            canonical["guidance"] = request.guidance
        if request.negative_prompt:
            canonical["negative_prompt"] = request.negative_prompt
        if request.transparent:
            canonical["transparent"] = True

        payload: dict[str, Any] = {}
        for name, value in canonical.items():
            target = self.param_map.get(name)
            if target is None or value is None:
                continue
            payload[target] = _WIRE_TRUE[target] if value is True and target in _WIRE_TRUE \
                else value
        payload.update(self.extra_params)
        return payload

    def supports_transparency(self) -> bool:
        return self.param_map.get("transparent") is not None

    async def render(self, request: ImageRequest, out_path: Path) -> ImageResult:
        payload = self.payload_for(request)
        started = time.perf_counter()
        try:
            if request.is_edit:
                response = await self._post_edit(request, payload)
            else:
                response = await self._client.post("/v1/images/generations", json=payload)
        except httpx.TimeoutException as exc:
            return ImageResult(request.id, False, wall_s=time.perf_counter() - started,
                               warmup=request.warmup, error_category="timeout",
                               error_message=str(exc)[:500], sent=payload)
        except httpx.HTTPError as exc:
            return ImageResult(request.id, False, wall_s=time.perf_counter() - started,
                               warmup=request.warmup, error_category="other",
                               error_message=str(exc)[:500], sent=payload)
        wall = time.perf_counter() - started

        if response.status_code != 200:
            category = "http-4xx" if response.status_code < 500 else "http-5xx"
            return ImageResult(request.id, False, wall_s=wall, warmup=request.warmup,
                               status=response.status_code, error_category=category,
                               error_message=response.text[:500], sent=payload)
        try:
            body = response.json()
        except json.JSONDecodeError as exc:
            return ImageResult(request.id, False, wall_s=wall, warmup=request.warmup,
                               status=response.status_code, error_category="malformed-output",
                               error_message=f"response is not JSON: {exc}", sent=payload)

        data = (body or {}).get("data") or []
        if not data:
            return ImageResult(request.id, False, wall_s=wall, warmup=request.warmup,
                               status=response.status_code, error_category="malformed-output",
                               error_message="response carries no data[]", sent=payload)
        try:
            await self._write_image(data[0], out_path)
        except (ValueError, httpx.HTTPError, OSError) as exc:
            return ImageResult(request.id, False, wall_s=wall, warmup=request.warmup,
                               status=response.status_code, error_category="malformed-output",
                               error_message=str(exc)[:500], sent=payload)

        return ImageResult(request.id, True, path=out_path, wall_s=wall,
                           server_s=self._server_seconds(body), warmup=request.warmup,
                           status=response.status_code, sent=payload)

    async def _post_edit(self, request: ImageRequest, payload: dict[str, Any]):
        """Edits go as multipart with one repeated `image` field per reference image."""
        files = [
            ("image", (path.name, path.read_bytes(), "image/png"))
            for path in request.references
        ]
        data = {k: ("true" if v is True else "false" if v is False else str(v))
                for k, v in payload.items()}
        return await self._client.post("/v1/images/edits", data=data, files=files)

    def _server_seconds(self, body: dict[str, Any]) -> float | None:
        if not self.timing:
            return None
        path, unit = self.timing
        value = _dig(body, path)
        if not isinstance(value, (int, float)):
            return None
        return float(value) / 1000.0 if unit == "ms" else float(value)

    async def _write_image(self, item: dict[str, Any], out_path: Path) -> None:
        out_path.parent.mkdir(parents=True, exist_ok=True)
        if item.get("b64_json"):
            out_path.write_bytes(base64.b64decode(item["b64_json"]))
            return
        url = item.get("url")
        if not url:
            raise ValueError("data[0] has neither b64_json nor url")
        response = await self._client.get(url)
        response.raise_for_status()
        out_path.write_bytes(response.content)


class CliImagesLane(ImageLane):
    """A command that renders one image and exits.

    The template is a list of argv tokens, never a shell string: a prompt with quotes in it
    is the normal case here, and a shell would be one escaping bug away from measuring a
    different prompt.

    Reference images come in two shapes because CLIs do. A token containing `{image...}`
    expands to one copy of that token per reference (`--ref-image={image...}`), and
    `image_args` is the fragment appended once per reference for tools that repeat the flag
    itself (`["-r", "{image}"]`, which is what stable-diffusion.cpp wants). Both disappear
    when there are no references, so one template serves generation and editing.
    """

    kind = "cli"

    def __init__(
        self,
        command: list[str],
        *,
        variables: dict[str, Any] | None = None,
        env: dict[str, str] | None = None,
        workdir: str | None = None,
        timeout_s: float = 1800.0,
        image_args: list[str] | None = None,
        transparent_args: list[str] | None = None,
        negative_args: list[str] | None = None,
    ):
        if not command:
            raise ValueError("a cli image lane needs a command")
        if not any("{out}" in token for token in command):
            raise ValueError("the command template must contain {out}, or nothing is written")
        self.command = list(command)
        self.variables = dict(variables or {})
        self.env = dict(env or {})
        self.workdir = workdir
        self.timeout_s = timeout_s
        self.image_args = list(image_args or [])
        self.transparent_args = list(transparent_args or [])
        self.negative_args = list(negative_args or [])
        self.invocation = " ".join(shlex.quote(token) for token in self.command)

    def argv(self, request: ImageRequest, out_path: Path) -> list[str]:
        values = {
            "prompt": request.prompt,
            "negative_prompt": request.negative_prompt or "",
            "seed": str(request.seed),
            "width": str(request.width),
            "height": str(request.height),
            "steps": str(request.steps),
            "guidance": "" if request.guidance is None else str(request.guidance),
            "out": str(out_path),
            **{k: str(v) for k, v in self.variables.items()},
        }
        argv: list[str] = []
        for token in self.command:
            if "{image...}" in token:
                argv += [token.replace("{image...}", str(path)) for path in request.references]
                continue
            argv.append(token.format_map(_Missing(values)))
        for path in request.references if self.image_args else ():
            argv += [t.format_map(_Missing({**values, "image": str(path)}))
                     for t in self.image_args]
        if request.transparent and self.transparent_args:
            argv += [t.format_map(_Missing(values)) for t in self.transparent_args]
        if request.negative_prompt and self.negative_args:
            argv += [t.format_map(_Missing(values)) for t in self.negative_args]
        return argv

    async def render(self, request: ImageRequest, out_path: Path) -> ImageResult:
        argv = self.argv(request, out_path)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        environment = {**os.environ, **self.env}
        started = time.perf_counter()
        try:
            process = await asyncio.create_subprocess_exec(
                *argv,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
                cwd=self.workdir,
                env=environment,
            )
        except (OSError, ValueError) as exc:
            return ImageResult(request.id, False, wall_s=time.perf_counter() - started,
                               warmup=request.warmup, error_category="other",
                               error_message=f"cannot start {argv[0]!r}: {exc}"[:500])
        try:
            stdout, _ = await asyncio.wait_for(process.communicate(), timeout=self.timeout_s)
        except TimeoutError:
            process.kill()
            await process.wait()
            return ImageResult(request.id, False, wall_s=time.perf_counter() - started,
                               warmup=request.warmup, error_category="timeout",
                               error_message=f"no output after {self.timeout_s:g}s")
        wall = time.perf_counter() - started
        tail = (stdout or b"").decode("utf-8", "replace")[-500:]

        if process.returncode != 0:
            return ImageResult(request.id, False, wall_s=wall, warmup=request.warmup,
                               status=process.returncode, error_category="other",
                               error_message=tail)
        if not out_path.exists():
            return ImageResult(request.id, False, wall_s=wall, warmup=request.warmup,
                               status=process.returncode, error_category="malformed-output",
                               error_message=f"exit 0 but {out_path.name} was not written: {tail}")
        return ImageResult(request.id, True, path=out_path, wall_s=wall, warmup=request.warmup,
                           status=process.returncode, sent={"argv": argv})


class _Missing(dict):
    """`format_map` mapping that leaves an unknown placeholder alone instead of raising.

    A command template may legitimately contain braces the harness knows nothing about —
    `--ref-image-args "preset=qwen_layered"` is not a placeholder — and a KeyError in the
    middle of a run would be a worse answer than passing the token through unchanged.
    """

    def __missing__(self, key: str) -> str:
        return "{" + key + "}"


def build_lane(spec: Any, *, transport: httpx.AsyncBaseTransport | None = None) -> ImageLane:
    """The lane a packet describes.

    Defaults to the OpenAI images shape against the engine's base URL, which is what every
    HTTP lane here speaks. A CLI lane is explicit, because it needs a command nobody can
    infer: `image_lane: {"kind": "cli", "command": [...]}` in the packet.
    """
    lane_spec = getattr(spec, "image_lane", None)
    kind = getattr(lane_spec, "kind", None) or "openai_images"
    engine_id = str(getattr(spec.engine, "id", "") or "default")

    if kind == "cli":
        return CliImagesLane(
            list(lane_spec.command or []),
            variables=dict(lane_spec.vars or {}),
            env=dict(lane_spec.env or {}),
            workdir=lane_spec.workdir,
            timeout_s=float(lane_spec.timeout_s or spec.request.timeout_s),
            image_args=list(lane_spec.image_args or []),
            transparent_args=list(lane_spec.transparent_args or []),
            negative_args=list(lane_spec.negative_args or []),
        )
    if kind != "openai_images":
        raise ValueError(
            f"unknown image lane kind {kind!r}: the harness speaks openai_images and cli. "
            "A workflow engine needs an adapter in front of it that speaks one of them."
        )

    base_url = getattr(spec.engine, "base_url", None)
    if not base_url:
        port = getattr(spec.engine, "port", None) or 8000
        base_url = f"http://127.0.0.1:{port}"
    param_map = getattr(lane_spec, "param_map", None) if lane_spec else None
    extra = getattr(lane_spec, "extra_params", None) if lane_spec else None
    return OpenAIImagesLane(
        base_url,
        engine_id=engine_id,
        model=spec.model.served_model_id or spec.model.hf_id or spec.model.id,
        api_key=spec.request.api_key,
        timeout_s=spec.request.timeout_s,
        param_map=param_map,
        extra_params=extra,
        transport=transport,
    )
