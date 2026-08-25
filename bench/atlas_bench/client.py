"""Async OpenAI-compatible chat client with per-request timing.

Streaming is how TTFT and ITL are measured (SPEC §8): the request start, the arrival of
the first content delta, every following delta and the end of the stream are timestamped
with :func:`time.perf_counter`. Token counts come from the engine's ``usage`` block
(``stream_options: {"include_usage": true}``); when an engine does not send usage we fall
back to the ``/tokenize`` endpoint, then to a local tokenizer (only if ``--tokenizer`` was
passed), then to counting streamed deltas.
"""

from __future__ import annotations

import json
import re
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

import httpx

__all__ = [
    "ChatClient",
    "ErrorCategory",
    "RequestResult",
    "categorize_error",
    "utc_now",
]

#: Failure buckets recorded in ``result.failures[].category`` (SPEC §4).
ErrorCategory = str

_OOM_PATTERNS = re.compile(
    r"out of memory|cuda oom|outofmemory|cublas_status_alloc_failed|"
    r"failed to allocate|no available memory for the cache blocks|hip out of memory",
    re.IGNORECASE,
)
_CONTEXT_PATTERNS = re.compile(
    r"maximum context length|context length exceeded|longer than the maximum|"
    r"exceeds the maximum|reduce the length|too many tokens|context window|"
    r"n_ctx|prompt is too long|greater than the context length|"
    r"provide a shorter input",
    re.IGNORECASE,
)
_REFUSAL_PATTERNS = re.compile(
    r"\bI can(?:no|')t (?:help|assist|comply)|\bI'm sorry, (?:but )?I can|"
    r"\bI am unable to (?:help|assist|provide)|as an ai language model, i cannot",
    re.IGNORECASE,
)
_TIMEOUT_PATTERNS = re.compile(r"timed out|timeout", re.IGNORECASE)

#: Shortest span between the first and last streamed delta that counts as an observed decode
#: interval. Anything faster is a buffered flush, not decoding (see ``measured_decode``).
MIN_DECODE_WINDOW_S = 0.001


#: Keys a streamed delta may carry its text under. `content` is the OpenAI field;
#: `reasoning_content` is what vLLM and LM Studio put a thought block in; `reasoning` is a
#: third spelling in the wild (SparkInfer). A server that emits only a thought block still
#: decoded tokens, and missing them makes a working request look like an empty answer.
_DELTA_TEXT_KEYS = ("content", "reasoning_content", "reasoning")


def _delta_text(delta: dict[str, Any]) -> str:
    """The text of one streamed delta, whichever field the server used for it."""
    for key in _DELTA_TEXT_KEYS:
        value = delta.get(key)
        if value:
            return str(value)
    return ""


def utc_now() -> str:
    """Current UTC time as ``2026-08-23T10:00:00Z``."""
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def categorize_error(
    status: int | None, message: str = "", exc: BaseException | None = None
) -> ErrorCategory:
    """Map an HTTP status and error text onto one of the SPEC failure categories."""
    text = message or ""
    if isinstance(exc, httpx.TimeoutException) or (not status and _TIMEOUT_PATTERNS.search(text)):
        return "timeout"
    if _OOM_PATTERNS.search(text):
        return "oom"
    if _CONTEXT_PATTERNS.search(text):
        return "context-overflow"
    if isinstance(exc, json.JSONDecodeError):
        return "malformed-output"
    if status is not None:
        if 500 <= status < 600:
            return "http-5xx"
        if 400 <= status < 500:
            return "http-4xx"
    if isinstance(exc, httpx.HTTPError):
        return "other"
    return "other"


def is_refusal(text: str) -> bool:
    """Heuristic refusal detection used by the eval workload."""
    return bool(_REFUSAL_PATTERNS.search(text or ""))


@dataclass
class RequestResult:
    """Everything measured for a single chat request."""

    request_id: str
    prompt_id: str | None = None
    started: float = 0.0
    first_token_at: float | None = None
    finished: float | None = None
    chunk_times: list[float] = field(default_factory=list)
    prompt_tokens: int | None = None
    completion_tokens: int | None = None
    #: Where ``completion_tokens`` came from: ``usage`` | ``stream-deltas`` | ``tokenizer``.
    token_source: str = "usage"
    status: str = "ok"
    http_status: int | None = None
    error_category: str | None = None
    error_message: str | None = None
    finish_reason: str | None = None
    text: str = ""
    #: Parsed ``tool_calls`` of the response, in the order the engine returned them.
    tool_calls: list[dict[str, Any]] = field(default_factory=list)
    warmup: bool = False

    @property
    def ok(self) -> bool:
        """True when the request completed without an error."""
        return self.status == "ok"

    @property
    def ttft_s(self) -> float | None:
        """Time to first token in seconds."""
        if self.first_token_at is None:
            return None
        return self.first_token_at - self.started

    @property
    def e2e_s(self) -> float | None:
        """End-to-end latency in seconds."""
        if self.finished is None:
            return None
        return self.finished - self.started

    @property
    def itls_s(self) -> list[float]:
        """Inter-token latencies (gaps between consecutive content deltas)."""
        return [b - a for a, b in zip(self.chunk_times, self.chunk_times[1:], strict=False)]

    @property
    def decode_s(self) -> float | None:
        """Time spent decoding after the first token."""
        if self.first_token_at is None or self.finished is None:
            return None
        return max(self.finished - self.first_token_at, 0.0)

    @property
    def measured_decode(self) -> bool:
        """Whether this request actually shows a decode interval.

        A server that sends the whole completion in one delta (short answers, some
        aggregating proxies) gives ``first_token_at == finished``: nothing about the decode
        rate was observed, and dividing by that near-zero window produces a four-digit tok/s
        that is pure artifact. Two content deltas is the minimum for the question to mean
        anything.

        Counting deltas is not enough on its own. A server that buffers a short answer and
        flushes it whole emits several deltas microseconds apart after a long time to first
        token — six deltas inside half a millisecond, which reads as 9,000 tok/s. No engine
        decodes tokens that fast, so a sub-millisecond window is the same non-measurement as
        a single delta, however many deltas it contains.
        """
        if len(self.chunk_times) < 2:
            return False
        return self.chunk_times[-1] - self.chunk_times[0] >= MIN_DECODE_WINDOW_S

    @property
    def tpot_s(self) -> float | None:
        """Mean time per output token, excluding the first token."""
        decode = self.decode_s
        tokens = self.completion_tokens or 0
        if decode is None or tokens < 2 or not self.measured_decode:
            return None
        return decode / (tokens - 1)

    @property
    def decode_tok_s(self) -> float | None:
        """Single-request decode throughput (tokens after the first / decode time)."""
        decode = self.decode_s
        tokens = self.completion_tokens or 0
        if not decode or tokens < 2 or not self.measured_decode:
            return None
        return (tokens - 1) / decode


class ChatClient:
    """Thin async client around ``/v1/chat/completions`` and ``/v1/models``."""

    def __init__(
        self,
        base_url: str,
        model: str,
        *,
        api_key: str | None = None,
        timeout_s: float = 600.0,
        transport: httpx.AsyncBaseTransport | None = None,
        client: httpx.AsyncClient | None = None,
        tokenizer: Any | None = None,
        extra_body: dict[str, Any] | None = None,
    ) -> None:
        # Every request path this client builds already starts with `/v1`, so a base URL that
        # ends in `/v1` — which is exactly what an engine's docs and LM Studio's UI hand you —
        # would otherwise produce `/v1/v1/chat/completions` and a silently empty run.
        self.base_url = base_url.rstrip("/").removesuffix("/v1").rstrip("/")
        self.model = model
        self.timeout_s = timeout_s
        self.tokenizer = tokenizer
        self.extra_body = dict(extra_body or {})
        self._supports_stream_options = True
        headers = {"content-type": "application/json"}
        if api_key:
            headers["authorization"] = f"Bearer {api_key}"
        self._client = client or httpx.AsyncClient(
            base_url=self.base_url,
            headers=headers,
            timeout=httpx.Timeout(timeout_s, connect=min(timeout_s, 30.0)),
            transport=transport,
        )
        self._owns_client = client is None

    async def __aenter__(self) -> ChatClient:
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self.aclose()

    async def aclose(self) -> None:
        """Close the underlying HTTP client when we own it."""
        if self._owns_client:
            await self._client.aclose()

    # ------------------------------------------------------------------ info

    async def list_models(self) -> list[str]:
        """Model ids advertised by ``/v1/models`` (empty list on failure)."""
        try:
            response = await self._client.get("/v1/models")
            response.raise_for_status()
            payload = response.json()
        except (httpx.HTTPError, json.JSONDecodeError, ValueError):
            return []
        return [str(item.get("id")) for item in payload.get("data") or [] if item.get("id")]

    async def count_prompt_tokens(self, messages: list[dict[str, Any]]) -> int | None:
        """Token count for a prompt via ``/tokenize`` or a local tokenizer, else ``None``."""
        body: dict[str, Any] = {"model": self.model, "messages": messages}
        for path in ("/tokenize", "/v1/tokenize"):
            try:
                response = await self._client.post(path, json=body, timeout=30.0)
                if response.status_code >= 400:
                    continue
                payload = response.json()
            except (httpx.HTTPError, json.JSONDecodeError, ValueError):
                continue
            for key in ("count", "num_tokens", "length"):
                if isinstance(payload.get(key), int):
                    return int(payload[key])
            tokens = payload.get("tokens")
            if isinstance(tokens, list):
                return len(tokens)
        if self.tokenizer is not None:
            text = "\n".join(str(m.get("content") or "") for m in messages)
            return len(self.tokenizer.encode(text).ids)
        return None

    # --------------------------------------------------------------- requests

    def _body(
        self,
        messages: list[dict[str, Any]],
        *,
        stream: bool,
        max_tokens: int | None,
        temperature: float,
        top_p: float | None,
        seed: int | None,
        stop: list[str] | None,
        extra_body: dict[str, Any] | None,
        stream_options: bool = True,
    ) -> dict[str, Any]:
        body: dict[str, Any] = {
            "model": self.model,
            "messages": messages,
            "temperature": temperature,
            "stream": stream,
        }
        if max_tokens is not None:
            body["max_tokens"] = max_tokens
        if top_p is not None:
            body["top_p"] = top_p
        if seed is not None:
            body["seed"] = seed
        if stop:
            body["stop"] = stop
        if stream and stream_options:
            body["stream_options"] = {"include_usage": True}
        body.update(self.extra_body)
        body.update(extra_body or {})
        return body

    async def chat_stream(
        self,
        messages: list[dict[str, Any]],
        *,
        request_id: str,
        prompt_id: str | None = None,
        max_tokens: int | None = None,
        temperature: float = 0.0,
        top_p: float | None = None,
        seed: int | None = None,
        stop: list[str] | None = None,
        extra_body: dict[str, Any] | None = None,
        warmup: bool = False,
        timeout_s: float | None = None,
        _without_stream_options: bool = False,
    ) -> RequestResult:
        """Run one streaming chat completion and time every delta."""
        result = RequestResult(request_id=request_id, prompt_id=prompt_id, warmup=warmup)
        body = self._body(
            messages,
            stream=True,
            stream_options=self._supports_stream_options and not _without_stream_options,
            max_tokens=max_tokens,
            temperature=temperature,
            top_p=top_p,
            seed=seed,
            stop=stop,
            extra_body=extra_body,
        )
        pieces: list[str] = []
        delta_count = 0
        usage: dict[str, Any] | None = None
        tool_fragments: dict[int, dict[str, Any]] = {}
        result.started = time.perf_counter()
        try:
            async with self._client.stream(
                "POST", "/v1/chat/completions", json=body, timeout=timeout_s or self.timeout_s
            ) as response:
                if response.status_code >= 400:
                    raw = await response.aread()
                    message = raw.decode("utf-8", "replace")[:2000]
                    if self._should_retry_without_stream_options(response.status_code, body):
                        # Servers that do not know `stream_options` reject the whole request,
                        # and not all of them name the offending field (LM Studio does not).
                        # Retry once without it: usage then falls back to counting deltas,
                        # which is a worse token count but a real measurement.
                        retry = await self.chat_stream(
                            messages,
                            request_id=request_id,
                            prompt_id=prompt_id,
                            max_tokens=max_tokens,
                            temperature=temperature,
                            top_p=top_p,
                            seed=seed,
                            stop=stop,
                            extra_body=extra_body,
                            warmup=warmup,
                            timeout_s=timeout_s,
                            _without_stream_options=True,
                        )
                        if retry.ok:
                            self._supports_stream_options = False
                        return retry
                    return self._fail(result, response.status_code, message)
                async for line in response.aiter_lines():
                    payload = _sse_payload(line)
                    if payload is None:
                        continue
                    if payload == "[DONE]":
                        break
                    try:
                        chunk = json.loads(payload)
                    except json.JSONDecodeError as exc:
                        return self._fail(result, response.status_code, f"malformed chunk: {exc}")
                    # Not every engine reports a failure with a failing status. LM Studio
                    # answers 200 and then writes the error into the stream as an `event:
                    # error` frame, so a prompt that overflows the context window arrives
                    # here rather than in the status branch above. Dropping it would leave
                    # the request looking like an empty answer instead of the refusal it is.
                    if error := chunk.get("error"):
                        message = error.get("message") if isinstance(error, dict) else str(error)
                        return self._fail(result, response.status_code, message or "stream error")
                    if chunk.get("usage"):
                        usage = chunk["usage"]
                    for choice in chunk.get("choices") or []:
                        delta = choice.get("delta") or {}
                        content = _delta_text(delta)
                        if content:
                            now = time.perf_counter()
                            if result.first_token_at is None:
                                result.first_token_at = now
                            result.chunk_times.append(now)
                            pieces.append(content)
                            delta_count += 1
                        _merge_tool_calls(tool_fragments, delta.get("tool_calls"))
                        if choice.get("finish_reason"):
                            result.finish_reason = str(choice["finish_reason"])
                result.http_status = response.status_code
        except httpx.HTTPError as exc:
            return self._fail(result, None, f"{type(exc).__name__}: {exc}", exc=exc)
        result.finished = time.perf_counter()
        result.text = "".join(pieces)
        result.tool_calls = [tool_fragments[i] for i in sorted(tool_fragments)]
        self._apply_usage(result, usage, delta_count, messages)
        if result.first_token_at is None and not result.tool_calls:
            result.status = "error"
            result.error_category = "malformed-output"
            result.error_message = "stream produced no content deltas"
        return result

    def _should_retry_without_stream_options(self, status: int, body: dict[str, Any]) -> bool:
        """Whether a 4xx is worth one retry with ``stream_options`` removed."""
        return (
            status in (400, 404, 422) and self._supports_stream_options and "stream_options" in body
        )

    async def chat_once(
        self,
        messages: list[dict[str, Any]],
        *,
        request_id: str,
        prompt_id: str | None = None,
        max_tokens: int | None = None,
        temperature: float = 0.0,
        top_p: float | None = None,
        seed: int | None = None,
        stop: list[str] | None = None,
        extra_body: dict[str, Any] | None = None,
        timeout_s: float | None = None,
    ) -> RequestResult:
        """Run one non-streaming chat completion (used by the eval workload)."""
        result = RequestResult(request_id=request_id, prompt_id=prompt_id)
        body = self._body(
            messages,
            stream=False,
            max_tokens=max_tokens,
            temperature=temperature,
            top_p=top_p,
            seed=seed,
            stop=stop,
            extra_body=extra_body,
        )
        result.started = time.perf_counter()
        try:
            response = await self._client.post(
                "/v1/chat/completions", json=body, timeout=timeout_s or self.timeout_s
            )
            if response.status_code >= 400:
                return self._fail(result, response.status_code, response.text[:2000])
            payload = response.json()
        except httpx.HTTPError as exc:
            return self._fail(result, None, f"{type(exc).__name__}: {exc}", exc=exc)
        except json.JSONDecodeError as exc:
            return self._fail(result, None, f"malformed response: {exc}", exc=exc)
        result.finished = time.perf_counter()
        result.first_token_at = result.finished
        result.http_status = response.status_code
        choices = payload.get("choices") or [{}]
        message = choices[0].get("message") or {}
        result.text = str(message.get("content") or "")
        result.tool_calls = [c for c in (message.get("tool_calls") or []) if isinstance(c, dict)]
        result.finish_reason = choices[0].get("finish_reason")
        self._apply_usage(result, payload.get("usage"), 0, messages)
        return result

    # ---------------------------------------------------------------- helpers

    def _fail(
        self,
        result: RequestResult,
        status: int | None,
        message: str,
        *,
        exc: BaseException | None = None,
    ) -> RequestResult:
        """Mark a request as failed and classify it."""
        result.finished = time.perf_counter()
        result.status = "error"
        result.http_status = status
        result.error_message = message.strip()[:1000]
        result.error_category = categorize_error(status, message, exc)
        return result

    def _apply_usage(
        self,
        result: RequestResult,
        usage: dict[str, Any] | None,
        delta_count: int,
        messages: list[dict[str, Any]],
    ) -> None:
        """Fill token counts from usage, falling back to counted deltas."""
        if usage:
            prompt = usage.get("prompt_tokens")
            completion = usage.get("completion_tokens")
            if isinstance(prompt, int):
                result.prompt_tokens = prompt
            if isinstance(completion, int):
                result.completion_tokens = completion
            if result.completion_tokens is not None:
                result.token_source = "usage"
                return
        if delta_count:
            result.completion_tokens = delta_count
            result.token_source = "stream-deltas"
        if result.prompt_tokens is None and self.tokenizer is not None:
            text = "\n".join(str(m.get("content") or "") for m in messages)
            result.prompt_tokens = len(self.tokenizer.encode(text).ids)
            result.token_source = "tokenizer"


def _merge_tool_calls(target: dict[int, dict[str, Any]], fragments: Any) -> None:
    """Accumulate streamed ``tool_calls`` deltas into whole calls.

    Engines stream a tool call the way they stream text: the name arrives once and the
    JSON arguments arrive in pieces, all tagged with the call's ``index``.
    """
    if not isinstance(fragments, list):
        return
    for fragment in fragments:
        if not isinstance(fragment, dict):
            continue
        index = int(fragment.get("index") or 0)
        call = target.setdefault(
            index, {"id": None, "type": "function", "function": {"name": "", "arguments": ""}}
        )
        if fragment.get("id"):
            call["id"] = fragment["id"]
        if fragment.get("type"):
            call["type"] = fragment["type"]
        function = fragment.get("function") or {}
        if function.get("name"):
            call["function"]["name"] = function["name"]
        if function.get("arguments"):
            call["function"]["arguments"] += function["arguments"]


def _sse_payload(line: str) -> str | None:
    """Return the payload of an SSE ``data:`` line, or ``None`` for keep-alives."""
    if not line:
        return None
    stripped = line.strip()
    if not stripped or stripped.startswith(":"):
        return None
    if stripped.startswith("data:"):
        return stripped[5:].strip()
    return None
