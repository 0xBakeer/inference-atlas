"""Streaming client: timing, token accounting and error categorization."""

from __future__ import annotations

import httpx
import pytest

from atlas_bench.client import ChatClient, categorize_error, is_refusal
from tests.conftest import FakeOpenAIServer

MESSAGES = [{"role": "user", "content": "hello"}]


@pytest.mark.parametrize(
    ("status", "message", "exc", "expected"),
    [
        (None, "", httpx.ReadTimeout("timed out"), "timeout"),
        (None, "request timed out", None, "timeout"),
        (500, "CUDA out of memory. Tried to allocate 2.00 GiB", None, "oom"),
        (400, "No available memory for the cache blocks", None, "oom"),
        (400, "This model's maximum context length is 8192 tokens", None, "context-overflow"),
        (400, "Please reduce the length of the messages", None, "context-overflow"),
        (500, "internal server error", None, "http-5xx"),
        (404, "model not found", None, "http-4xx"),
        (429, "rate limited", None, "http-4xx"),
        (None, "connection refused", httpx.ConnectError("refused"), "other"),
    ],
)
def test_error_categorization(status, message, exc, expected) -> None:
    """HTTP status plus message patterns decide the SPEC failure category."""
    assert categorize_error(status, message, exc) == expected


def test_oom_beats_the_status_class() -> None:
    """An OOM behind a 500 is an OOM, not a generic server error."""
    assert categorize_error(500, "torch.cuda.OutOfMemoryError", None) == "oom"


def test_refusal_detection() -> None:
    """Refusals are a distinct eval failure category."""
    assert is_refusal("I'm sorry, I can't help with that.")
    assert is_refusal("I cannot assist with this request.")
    assert not is_refusal("The answer is 42.")


@pytest.mark.parametrize(
    "given",
    [
        "http://localhost:1234",
        "http://localhost:1234/",
        "http://localhost:1234/v1",
        "http://localhost:1234/v1/",
    ],
)
def test_base_url_with_a_v1_suffix_is_not_doubled(given: str) -> None:
    """`--base-url http://localhost:1234/v1` must not become `/v1/v1/...`."""
    client = ChatClient(given, "m")
    assert client.base_url == "http://localhost:1234"


async def test_streaming_measures_ttft_itl_and_usage(fake_server: FakeOpenAIServer) -> None:
    """A streamed response yields TTFT, per-chunk ITL and usage-derived token counts."""
    async with ChatClient("http://fake", "fake-model", transport=fake_server.transport) as client:
        result = await client.chat_stream(MESSAGES, request_id="r1", max_tokens=16)

    assert result.ok
    assert result.finish_reason == "length"
    assert result.prompt_tokens == 100
    assert result.completion_tokens == 8
    assert result.token_source == "usage"
    assert result.ttft_s is not None and result.ttft_s > 0
    assert len(result.chunk_times) == 8
    assert len(result.itls_s) == 7
    assert result.e2e_s >= result.ttft_s
    assert result.tpot_s is not None
    assert result.text.startswith("tok0 ")


async def test_a_single_chunk_response_reports_no_decode_rate() -> None:
    """One delta means no decode interval was observed — not an enormous tok/s.

    Short answers routinely arrive in a single chunk (LM Studio does this for a two-token
    reply); ``(tokens - 1) / ~0s`` would put four digits into a published metric.
    """
    server = FakeOpenAIServer(chunks=1, chunk_delay_s=0)
    async with ChatClient("http://fake", "fake-model", transport=server.transport) as client:
        result = await client.chat_stream(MESSAGES, request_id="r1", max_tokens=16)

    assert result.ok
    assert len(result.chunk_times) == 1
    assert result.measured_decode is False
    assert result.decode_tok_s is None
    assert result.tpot_s is None
    # TTFT and e2e are still real measurements.
    assert result.ttft_s is not None
    assert result.e2e_s is not None


async def test_stream_without_usage_falls_back_to_counting_deltas() -> None:
    """An engine that never reports usage still produces a token count, marked as such."""
    server = FakeOpenAIServer(report_usage=False, chunks=5)
    async with ChatClient("http://fake", "fake-model", transport=server.transport) as client:
        result = await client.chat_stream(MESSAGES, request_id="r1")
    assert result.completion_tokens == 5
    assert result.token_source == "stream-deltas"
    assert result.prompt_tokens is None


async def test_stream_options_rejection_falls_back_without_failing() -> None:
    """A server that rejects ``stream_options`` without naming it still gets measured.

    LM Studio answers 400 with a generic "unexpected parameter" message. Retrying once
    without the field costs one request and keeps the run alive; token counts then come from
    counting streamed deltas.
    """
    server = FakeOpenAIServer(reject_stream_options=True, chunks=6)
    async with ChatClient("http://fake", "fake-model", transport=server.transport) as client:
        first = await client.chat_stream(MESSAGES, request_id="r1")
        second = await client.chat_stream(MESSAGES, request_id="r2")

    assert first.ok and second.ok
    assert first.completion_tokens == 6
    assert first.token_source == "stream-deltas"
    assert first.ttft_s is not None
    # The first request paid for the probe; afterwards the field is not sent again.
    assert "stream_options" in server.requests[0]
    assert "stream_options" not in server.requests[1]
    assert "stream_options" not in server.requests[2]
    assert len(server.requests) == 3


async def test_a_real_400_is_not_retried_forever() -> None:
    """A 400 that has nothing to do with stream_options is reported, not looped on."""
    server = FakeOpenAIServer(
        fail_every=1, fail_status=400, fail_body="This model's maximum context length is 8192"
    )
    async with ChatClient("http://fake", "fake-model", transport=server.transport) as client:
        result = await client.chat_stream(MESSAGES, request_id="r1")

    assert not result.ok
    assert result.error_category == "context-overflow"
    assert len(server.requests) == 2, "exactly one retry, then the real error"


async def test_http_error_is_captured_not_raised() -> None:
    """A failing request becomes a categorized failure, never an exception."""
    server = FakeOpenAIServer(fail_every=1, fail_status=500, fail_body="CUDA out of memory")
    async with ChatClient("http://fake", "fake-model", transport=server.transport) as client:
        result = await client.chat_stream(MESSAGES, request_id="r1")
    assert not result.ok
    assert result.error_category == "oom"
    assert result.http_status == 500


async def test_non_streaming_request(fake_server: FakeOpenAIServer) -> None:
    """The eval path uses a single response and still records latency and tokens."""
    async with ChatClient("http://fake", "fake-model", transport=fake_server.transport) as client:
        result = await client.chat_once(MESSAGES, request_id="e1", max_tokens=32)
    assert result.ok
    assert result.text
    assert result.e2e_s is not None
    assert result.prompt_tokens == 100


async def test_list_models_and_tokenize(fake_server: FakeOpenAIServer) -> None:
    """``/v1/models`` drives model-name discovery; ``/tokenize`` is the usage fallback."""
    async with ChatClient("http://fake", "fake-model", transport=fake_server.transport) as client:
        assert await client.list_models() == ["fake-model"]
        assert await client.count_prompt_tokens(MESSAGES) == 100


async def test_stream_options_are_requested(fake_server: FakeOpenAIServer) -> None:
    """Usage only arrives when ``stream_options.include_usage`` is sent."""
    async with ChatClient("http://fake", "fake-model", transport=fake_server.transport) as client:
        await client.chat_stream(MESSAGES, request_id="r1")
    assert fake_server.requests[0]["stream_options"] == {"include_usage": True}
    assert fake_server.requests[0]["stream"] is True


async def test_extra_body_passes_through(fake_server: FakeOpenAIServer) -> None:
    """``chat_template_kwargs`` / ``reasoning_effort`` reach the engine untouched."""
    async with ChatClient("http://fake", "fake-model", transport=fake_server.transport) as client:
        await client.chat_stream(
            MESSAGES,
            request_id="r1",
            extra_body={
                "chat_template_kwargs": {"enable_thinking": False},
                "reasoning_effort": "low",
            },
        )
    body = fake_server.requests[0]
    assert body["chat_template_kwargs"] == {"enable_thinking": False}
    assert body["reasoning_effort"] == "low"
