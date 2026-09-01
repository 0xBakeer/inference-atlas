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
        (
            200,
            "The number of tokens to keep from the initial prompt is greater than the "
            "context length. Try to load the model with a larger context length, or "
            "provide a shorter input",
            None,
            "context-overflow",
        ),
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


#: One verbatim over-the-ceiling message per engine we have measured. `longctx` promises a
#: point that does not fit is recorded as `context-overflow` and never omitted
#: (`workloads/README.md`), and that promise is only kept if every engine's wording matches.
#: An engine whose phrasing is not here silently downgrades to its status class, so add the
#: real string when adding an engine rather than trusting the regex to generalise.
CONTEXT_OVERFLOW_MESSAGES = {
    "vllm": "This model's maximum context length is 8192 tokens. However, you requested "
    "9000 tokens. Please reduce the length of the messages.",
    "atlas": '{"error":{"message":"Prompt too long: 5152 tokens exceeds max_seq_len 2048 '
    '(leave room for output tokens)","type":"invalid_request_error"}}',
    "llamacpp": "the request exceeds the available context size, n_ctx = 4096",
    "lmstudio": "The number of tokens to keep from the initial prompt is greater than the "
    "context length. Try to load the model with a larger context length, or provide a "
    "shorter input",
    "sglang": "Input length 40316 exceeds the maximum allowed length 32768",
}


@pytest.mark.parametrize("engine", sorted(CONTEXT_OVERFLOW_MESSAGES))
def test_context_overflow_is_recognised_per_engine(engine: str) -> None:
    """Every engine's own over-the-ceiling wording categorises as context-overflow.

    A 4xx that is really a context overflow must not fall through to ``http-4xx``: the
    category is what the site and ``result.py``'s warning read.
    """
    assert categorize_error(400, CONTEXT_OVERFLOW_MESSAGES[engine], None) == "context-overflow"


def test_context_overflow_beats_the_status_class() -> None:
    """Atlas returns 400 for an oversized prompt; the category must still be the reason."""
    message = "Prompt too long: 5152 tokens exceeds max_seq_len 2048"
    assert categorize_error(400, message, None) == "context-overflow"


def test_a_plain_bad_request_is_still_http_4xx() -> None:
    """Widening the context patterns must not swallow unrelated 4xx failures."""
    assert categorize_error(400, "unknown field 'temperatur'", None) == "http-4xx"
    assert categorize_error(404, "model not found", None) == "http-4xx"


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        # Granite 4.2: the template opens the block, so the model only closes it.
        ("Let me think about it. The value is 42.\n</think>\nThe answer is 42", "The answer is 42"),
        ("<think>hidden working</think>The answer is 42", "The answer is 42"),
        ("The answer is 42", "The answer is 42"),
    ],
)
def test_a_closing_think_tag_without_an_opening_one_is_still_thinking(
    raw: str, expected: str
) -> None:
    """Everything before an unopened `</think>` is deliberation, not the answer.

    Leaving it in place does not merely add noise: the extracted answer becomes a paragraph
    of reasoning, and every scorer then compares that paragraph against the expected value.
    """
    from atlas_bench.scorers import extract_answer

    assert extract_answer(raw) == expected


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


@pytest.mark.parametrize("delta_key", ["content", "reasoning_content", "reasoning"])
async def test_text_is_counted_whatever_field_the_delta_uses(delta_key: str) -> None:
    """A thought-only stream is still decoded tokens, not an empty answer.

    `reasoning_content` is what vLLM and LM Studio use; SparkInfer emits `reasoning`. A
    server whose whole 256-token budget goes into a thought block sends no `content` at all,
    and reading only the two known fields turned every such request into
    "stream produced no content deltas" — 594 of 600 requests on a working server.
    """
    server = FakeOpenAIServer(chunks=5, delta_key=delta_key)
    async with ChatClient("http://fake", "fake-model", transport=server.transport) as client:
        result = await client.chat_stream(MESSAGES, request_id="r1", max_tokens=32)

    assert result.ok, f"{delta_key} deltas must count as output"
    assert len(result.chunk_times) == 5
    assert result.ttft_s is not None


async def test_a_buffered_flush_is_not_a_decode_measurement() -> None:
    """Several deltas arriving at once is a flush, not a decode interval.

    LM Studio buffers short answers behind a long prefill: at a 65k-token context the six
    tokens of the answer landed inside half a millisecond after a 40s time to first token,
    which the delta count alone accepted as 9,197 tok/s — past what the memory bandwidth of
    the machine allows, and enough to fail plausibility on an otherwise good run.
    """
    server = FakeOpenAIServer(chunks=6, chunk_delay_s=0)
    async with ChatClient("http://fake", "fake-model", transport=server.transport) as client:
        result = await client.chat_stream(MESSAGES, request_id="r1", max_tokens=16)

    assert result.ok
    assert len(result.chunk_times) == 6, "the deltas are still counted as tokens"
    assert result.measured_decode is False
    assert result.decode_tok_s is None
    assert result.tpot_s is None
    assert result.ttft_s is not None


async def test_a_real_decode_interval_is_still_measured() -> None:
    """Deltas spread over a real interval keep producing a decode rate."""
    server = FakeOpenAIServer(chunks=6, chunk_delay_s=0.004)
    async with ChatClient("http://fake", "fake-model", transport=server.transport) as client:
        result = await client.chat_stream(MESSAGES, request_id="r1", max_tokens=16)

    assert result.measured_decode is True
    assert result.decode_tok_s is not None
    assert result.tpot_s is not None


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


async def test_an_error_frame_inside_a_200_stream_is_surfaced() -> None:
    """LM Studio answers 200 and puts the failure in the stream; it is still a failure.

    An overlong prompt comes back as `event: error` with the reason in the payload. Ignoring
    frames without `choices` used to reduce this to "stream produced no content deltas",
    which reads as a model that answered nothing rather than a request that was refused, and
    threw away the one sentence saying why.
    """
    overflow = (
        "The number of tokens to keep from the initial prompt is greater than the context "
        "length. Try to load the model with a larger context length, or provide a shorter input"
    )
    server = FakeOpenAIServer(stream_error=overflow)
    async with ChatClient("http://fake", "fake-model", transport=server.transport) as client:
        result = await client.chat_stream(MESSAGES, request_id="r1")

    assert not result.ok
    assert result.error_category == "context-overflow"
    assert result.error_message == overflow


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
