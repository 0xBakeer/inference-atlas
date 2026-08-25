"""Shared test fixtures: a fake OpenAI-compatible server and a throwaway Atlas checkout.

Nothing here touches the network, spawns an engine or downloads a model. The fake server is
an :class:`httpx.MockTransport` that emits real SSE frames with real (tiny) delays, so TTFT
and ITL are measured the same way they are against a live engine.
"""

from __future__ import annotations

import asyncio
import json
import shutil
from collections.abc import AsyncIterator, Callable
from pathlib import Path
from typing import Any

import httpx
import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
FIXTURES = Path(__file__).parent / "fixtures"


class _SSEStream(httpx.AsyncByteStream):
    """Async byte stream that yields SSE frames with a delay between them."""

    def __init__(self, frames: list[bytes], delay_s: float) -> None:
        self._frames = frames
        self._delay_s = delay_s

    async def __aiter__(self) -> AsyncIterator[bytes]:
        for index, frame in enumerate(self._frames):
            if self._delay_s and index:
                await asyncio.sleep(self._delay_s)
            yield frame


class FakeOpenAIServer:
    """A minimal OpenAI-compatible server backed by ``httpx.MockTransport``.

    Configurable enough to exercise the paths that matter: streaming, usage reporting,
    per-request failures, and a responder that turns a prompt into an answer so the eval
    workload can be scored end to end.
    """

    def __init__(
        self,
        *,
        model: str = "fake-model",
        chunks: int = 8,
        chunk_delay_s: float = 0.002,
        ttft_delay_s: float = 0.005,
        prompt_tokens: int = 100,
        responder: Callable[[list[dict[str, Any]]], str] | None = None,
        tool_responder: Callable[[dict[str, Any]], dict[str, Any] | None] | None = None,
        fail_every: int | None = None,
        fail_status: int = 500,
        fail_body: str = "internal error",
        report_usage: bool = True,
        reject_stream_options: bool = False,
        stream_error: str | None = None,
        delta_key: str = "content",
    ) -> None:
        self.model = model
        self.chunks = chunks
        self.chunk_delay_s = chunk_delay_s
        self.ttft_delay_s = ttft_delay_s
        self.prompt_tokens = prompt_tokens
        self.responder = responder
        self.tool_responder = tool_responder
        self.fail_every = fail_every
        self.fail_status = fail_status
        self.fail_body = fail_body
        self.report_usage = report_usage
        #: LM Studio-style: reject the request outright, without naming the field.
        self.reject_stream_options = reject_stream_options
        #: LM Studio-style: answer 200, then report the failure inside the stream.
        self.stream_error = stream_error
        #: Which delta field the text arrives under: SparkInfer uses "reasoning".
        self.delta_key = delta_key
        self.requests: list[dict[str, Any]] = []

    # ------------------------------------------------------------------ wiring

    @property
    def transport(self) -> httpx.MockTransport:
        """Transport to hand to :class:`atlas_bench.client.ChatClient`."""
        return httpx.MockTransport(self.handle)

    def handle(self, request: httpx.Request) -> httpx.Response:
        """Route one request."""
        path = request.url.path
        if path.endswith("/v1/models"):
            return httpx.Response(200, json={"data": [{"id": self.model}]})
        if path.endswith("/health"):
            return httpx.Response(200, json={"status": "ok"})
        if path.endswith("/tokenize"):
            return httpx.Response(200, json={"count": self.prompt_tokens})
        if not path.endswith("/chat/completions"):
            return httpx.Response(404, json={"error": "not found"})

        body = json.loads(request.content.decode())
        self.requests.append(body)
        if self.reject_stream_options and "stream_options" in body:
            return httpx.Response(400, json={"error": "Unexpected parameter in request body"})
        index = len(self.requests)
        if self.fail_every and index % self.fail_every == 0:
            return httpx.Response(self.fail_status, json={"error": {"message": self.fail_body}})
        text = self.responder(body.get("messages") or []) if self.responder else None
        if body.get("stream"):
            return self._stream(body, text)
        return self._once(body, text)

    # ---------------------------------------------------------------- responses

    def _pieces(self, text: str | None) -> list[str]:
        """Split the answer into as many deltas as the server is configured for."""
        if text is None:
            return [f"tok{i} " for i in range(self.chunks)]
        words = text.split(" ")
        return [w + (" " if i < len(words) - 1 else "") for i, w in enumerate(words)]

    def _stream(self, body: dict[str, Any], text: str | None) -> httpx.Response:
        if self.stream_error is not None:
            frames = [
                b"event: error\n" + _frame({"error": {"message": self.stream_error}}),
                b"data: [DONE]\n\n",
            ]
            return httpx.Response(
                200,
                headers={"content-type": "text/event-stream"},
                stream=_SSEStream(frames, self.chunk_delay_s),
            )
        pieces = self._pieces(text)
        frames: list[bytes] = []
        for piece in pieces:
            frames.append(_frame({"choices": [{"index": 0, "delta": {self.delta_key: piece}}]}))
        frames.append(_frame({"choices": [{"index": 0, "delta": {}, "finish_reason": "length"}]}))
        if self.report_usage and (body.get("stream_options") or {}).get("include_usage"):
            frames.append(
                _frame(
                    {
                        "choices": [],
                        "usage": {
                            "prompt_tokens": self.prompt_tokens,
                            "completion_tokens": len(pieces),
                            "total_tokens": self.prompt_tokens + len(pieces),
                        },
                    }
                )
            )
        frames.append(b"data: [DONE]\n\n")
        return httpx.Response(
            200,
            headers={"content-type": "text/event-stream"},
            stream=_SSEStream(frames, self.chunk_delay_s),
        )

    def _once(self, body: dict[str, Any], text: str | None) -> httpx.Response:
        """A non-streaming completion, with tool calls when the row asked for one."""
        content = text if text is not None else "".join(self._pieces(None))
        message: dict[str, Any] = {"role": "assistant", "content": content}
        call = self.tool_responder(body) if self.tool_responder else None
        if call:
            message["content"] = None
            message["tool_calls"] = [
                {
                    "id": "call_0",
                    "type": "function",
                    "function": {
                        "name": call["name"],
                        "arguments": json.dumps(call.get("arguments") or {}),
                    },
                }
            ]
        return httpx.Response(
            200,
            json={
                "choices": [
                    {
                        "index": 0,
                        "message": message,
                        "finish_reason": "tool_calls" if call else "stop",
                    }
                ],
                "usage": {
                    "prompt_tokens": self.prompt_tokens,
                    "completion_tokens": max(len(content.split()), 1),
                    "total_tokens": self.prompt_tokens + max(len(content.split()), 1),
                },
            },
        )


def _frame(payload: dict[str, Any]) -> bytes:
    """One SSE ``data:`` frame."""
    return f"data: {json.dumps(payload)}\n\n".encode()


def schema_accepts_hf_model_ids() -> bool:
    """Whether this checkout's schemas already carry the HF ``model_id`` definition.

    `bench/` implements SPEC §2 decision 20 (model ids are Hugging Face repo ids); the
    schemas are migrated by another workspace. While that is in flight, a locally generated
    result is correct but trips the old lowercase-kebab pattern, so the validation tests
    ignore exactly that one schema error and nothing else.
    """
    common = REPO_ROOT / "schemas" / "common.schema.json"
    if not common.is_file():
        return True
    try:
        defs = json.loads(common.read_text(encoding="utf-8")).get("$defs") or {}
    except json.JSONDecodeError:  # pragma: no cover - only while a writer is mid-file
        return True
    return "model_id" in defs


def drop_pre_migration_schema_errors(issues: list) -> list:
    """Filter out the model-id pattern error while the schemas are still being migrated."""
    if schema_accepts_hf_model_ids():
        return issues
    return [
        issue
        for issue in issues
        if not (issue.code == "schema" and issue.message.startswith("model/id:"))
    ]


@pytest.fixture
def fake_server() -> FakeOpenAIServer:
    """A default fake server: 8 deltas, usage reported."""
    return FakeOpenAIServer()


# ------------------------------------------------------------------- registries


HARDWARE = {
    "schema_version": 1,
    "id": "test-gpu-24gb",
    "name": "Test GPU 24GB",
    "vendor": "nvidia",
    "kind": "gpu",
    "memory_gb": 24,
    "memory_bandwidth_gbs": 1000,
    "tdp_w": 350,
    "detect": {"nvidia_smi_name": ["Test GPU 24GB"]},
}
ENGINE_META = {
    "schema_version": 1,
    "id": "vllm",
    "name": "vLLM",
    "api": "openai",
    "default_port": 8000,
    "serve": {
        "command_template": "vllm serve {model_ref} {flags}",
        "flag_style": "--{name} {value}",
        "bool_style": "--{name}",
    },
    "health": {"path": "/health", "models_path": "/v1/models"},
    "drop_params": ["model", "host", "port", "api-key", "served-model-name"],
    "param_aliases": {"tp": "tensor-parallel-size"},
    "install": [{"method": "docker", "image": "vllm/vllm-openai:v{version}"}],
}
ENGINE_VERSION = {
    "schema_version": 1,
    "engine_id": "vllm",
    "version": "0.27.1",
    "params": [
        {"name": "tensor-parallel-size", "type": "int", "default": 1, "aliases": ["-tp", "tp"]},
        {"name": "gpu-memory-utilization", "type": "float", "default": 0.9},
        {"name": "max-model-len", "type": "int", "default": None},
        {"name": "enable-prefix-caching", "type": "bool", "default": False},
        {"name": "port", "type": "int", "default": 8000},
    ],
}
MODEL = {
    "schema_version": 1,
    "id": "acme/test-model-1b",
    "name": "Test Model 1B",
    # model.json.hf_id must equal the id: the directory layout *is* the repo id.
    "hf_id": "acme/test-model-1b",
    "params_b": 1,
    "moe": False,
    "context_length": 32768,
    "modalities": ["text"],
}
QUANT = {
    "schema_version": 1,
    "id": "fp8",
    "model_id": "acme/test-model-1b",
    "format": "fp8",
    "bits": 8,
    # The quant's hf_id is the repo that actually holds these weights — a different repo.
    "hf_id": "acme-quants/test-model-1b-FP8",
    "size_gb": 1.0,
    "engines": ["vllm"],
}
WORKLOAD = {
    "schema_version": 1,
    "id": "serve-test-c2-v1",
    "name": "Test serving workload",
    "kind": "serving",
    "dataset_id": "prompts-test-v1",
    "params": {
        "concurrency": 2,
        "num_requests": 6,
        "input_tokens": 128,
        "output_tokens": 16,
        "seed": 42,
        "warmup_requests": 1,
        "temperature": 0,
        "repeat": 1,
    },
    "metrics_required": ["ttft_ms", "output_tok_s", "success_rate"],
    "immutable": True,
}
SWEEP_WORKLOAD = {
    "schema_version": 1,
    "id": "sweep-test-1-4-v1",
    "name": "Test sweep",
    "kind": "sweep",
    "dataset_id": "prompts-test-v1",
    "params": {"num_requests": 4, "output_tokens": 8, "seed": 7},
    "sweep": {"concurrency": [1, 2, 4], "success_threshold": 0.95},
}
EVAL_WORKLOAD = {
    "schema_version": 1,
    "id": "eval-test-v1",
    "name": "Test eval",
    "kind": "eval",
    "dataset_id": "eval-test-v1",
    "params": {"concurrency": 2, "output_tokens": 64},
    "eval": {"suite": "math", "scorer": "numeric"},
}
DATASET = {
    "schema_version": 1,
    "id": "prompts-test-v1",
    "name": "Test prompts",
    "kind": "prompts",
    "licence": "MIT",
    "files": ["prompts.jsonl"],
    "count": 4,
}
EVAL_DATASET = {
    "schema_version": 1,
    "id": "eval-test-v1",
    "name": "Test eval rows",
    "kind": "eval",
    "licence": "MIT",
    "files": ["items.jsonl"],
    "count": 3,
}


def _write(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


LMSTUDIO_META = {
    "schema_version": 1,
    "id": "lmstudio",
    "name": "LM Studio",
    "api": "openai",
    "default_port": 1234,
    "serve": {"flag_style": "--{name} {value}", "bool_style": "--{name}"},
    "health": {"path": "/v1/models", "models_path": "/v1/models"},
    "drop_params": ["model", "host", "port", "api-key"],
    "param_aliases": {},
    "install": [{"method": "app"}],
}
GEMMA = {
    "schema_version": 1,
    "id": "google/gemma-4-E2B-it",
    "name": "Gemma 4 E2B IT",
    "hf_id": "google/gemma-4-E2B-it",
    "params_b": 2,
    "moe": False,
    "context_length": 131072,
    "modalities": ["text", "image"],
}
GEMMA_QUANT = {
    "schema_version": 1,
    "id": "mlx-4bit",
    "model_id": "google/gemma-4-E2B-it",
    "format": "mlx",
    "bits": 4,
    "hf_id": "lmstudio-community/gemma-4-E2B-it-MLX-4bit",
    "size_gb": 1.6,
    "engines": ["lmstudio", "mlx-lm"],
}
APPLE_HARDWARE = {
    "schema_version": 1,
    "id": "apple-m2-max-32gb",
    "name": "Apple M2 Max (32 GB)",
    "vendor": "apple",
    "kind": "soc",
    "memory_gb": 32,
    "memory_bandwidth_gbs": 400,
    "tdp_w": 79,
    "detect": {"apple_chip": ["Apple M2 Max"], "memory_gb": 32},
}


@pytest.fixture
def lmstudio_repo(atlas_repo: Path) -> Path:
    """The throwaway checkout, plus the registry entries an LM Studio run needs."""
    _write(atlas_repo / "engines" / "lmstudio" / "meta.json", LMSTUDIO_META)
    _write(atlas_repo / "hardware" / "apple-m2-max-32gb.json", APPLE_HARDWARE)
    _write(atlas_repo / "models" / "google" / "gemma-4-E2B-it" / "model.json", GEMMA)
    _write(
        atlas_repo / "models" / "google" / "gemma-4-E2B-it" / "quants" / "mlx-4bit.json",
        GEMMA_QUANT,
    )
    return atlas_repo


@pytest.fixture
def atlas_repo(tmp_path: Path) -> Path:
    """A throwaway Atlas checkout with one engine, model, quant, hardware and workloads."""
    root = tmp_path / "atlas"
    _write(root / "hardware" / "test-gpu-24gb.json", HARDWARE)
    _write(root / "engines" / "vllm" / "meta.json", ENGINE_META)
    _write(root / "engines" / "vllm" / "versions" / "0.27.1.json", ENGINE_VERSION)
    _write(root / "models" / "acme" / "test-model-1b" / "model.json", MODEL)
    _write(root / "models" / "acme" / "test-model-1b" / "quants" / "fp8.json", QUANT)
    for workload in (WORKLOAD, SWEEP_WORKLOAD, EVAL_WORKLOAD):
        _write(root / "workloads" / f"{workload['id']}.json", workload)
    _write(root / "datasets" / "prompts-test-v1" / "dataset.json", DATASET)
    (root / "datasets" / "prompts-test-v1" / "prompts.jsonl").write_text(
        "\n".join(
            json.dumps(
                {
                    "id": f"p-{i:04d}",
                    "topic": "code",
                    "bucket": "s",
                    "approx_tokens": 128,
                    "messages": [{"role": "user", "content": f"Explain concept number {i}."}],
                }
            )
            for i in range(4)
        )
        + "\n",
        encoding="utf-8",
    )
    _write(root / "datasets" / "eval-test-v1" / "dataset.json", EVAL_DATASET)
    (root / "datasets" / "eval-test-v1" / "items.jsonl").write_text(
        "\n".join(
            json.dumps(row)
            for row in (
                {
                    "id": "m-1",
                    "category": "arithmetic",
                    "difficulty": "easy",
                    "prompt": "2+2?",
                    "answer": "4",
                    "scorer": "numeric",
                },
                {
                    "id": "m-2",
                    "category": "arithmetic",
                    "difficulty": "easy",
                    "prompt": "3+3?",
                    "answer": "6",
                    "scorer": "numeric",
                },
                {
                    "id": "m-3",
                    "category": "algebra",
                    "difficulty": "hard",
                    "prompt": "x?",
                    "answer": "42",
                    "scorer": "numeric",
                },
            )
        )
        + "\n",
        encoding="utf-8",
    )
    schemas = REPO_ROOT / "schemas"
    if schemas.is_dir():
        shutil.copytree(schemas, root / "schemas")
    (root / "results").mkdir(parents=True, exist_ok=True)
    return root
