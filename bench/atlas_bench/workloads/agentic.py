"""Agentic workload: replay a recorded multi-turn session, turn by turn.

Every other workload in this suite sends one independent request. An agent does not: it
sends a conversation that grows with each tool call, so by turn 80 the prompt carries every
file it read and every command it ran. Prefill cost climbs monotonically, cache reuse
becomes the dominant term, and the output is short tool calls rather than prose. None of
that is visible in a single-shot measurement, which is why this kind exists.

The trajectory is **replayed, not generated**. After each measured request the *recorded*
assistant turn is appended to the history, not whatever the model just said, and the
recorded tool result follows it. Two consequences, both deliberate:

* the token sequence is identical on every engine, so the comparison is between servers
  rather than between the trajectories their models happened to wander into;
* nothing here scores the model. This measures serving under an agentic shape. Capability
  under the same shape is a different workload with ground truth attached.

Tool turns carry the delay the real tool took. Honouring it is the default because a cache
that survives a 200 ms gap may not survive a 30 s one, and that difference is the thing
being measured; ``honour_tool_delays: false`` turns the run into a throughput upper bound
instead, and either way the choice lands in the result's resolved params.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

from ..client import RequestResult
from ..data import AgenticTurn, load_agentic_conversations
from ..metrics import aggregate_serving, distribution
from .base import RunContext, WorkloadOutcome, gotcha, raw_payload, sampling

__all__ = ["run_agentic"]


def _tool_result_messages(turn: AgenticTurn) -> list[dict[str, Any]]:
    """Recorded tool outputs as OpenAI ``role: tool`` messages."""
    out: list[dict[str, Any]] = []
    for item in turn.tool_results or []:
        if not isinstance(item, dict):
            continue
        content = item.get("content")
        if not isinstance(content, str):
            content = json.dumps(content, ensure_ascii=False)
        message: dict[str, Any] = {"role": "tool", "content": content}
        call_id = item.get("tool_call_id") or item.get("id")
        if call_id:
            message["tool_call_id"] = str(call_id)
        if item.get("name"):
            message["name"] = str(item["name"])
        out.append(message)
    return out


def _recorded_assistant(turn: AgenticTurn) -> dict[str, Any]:
    """The recorded assistant turn, as it goes back into the history."""
    message: dict[str, Any] = {"role": "assistant", "content": turn.content or ""}
    if turn.tool_calls:
        message["tool_calls"] = turn.tool_calls
        # An assistant message carrying tool_calls must not also carry text content on
        # several servers; they reject the pair rather than ignoring one half of it.
        message["content"] = turn.content or None
    return message


async def run_agentic(ctx: RunContext) -> WorkloadOutcome:
    """Replay each recorded session and measure every assistant turn."""
    dataset_id = str(ctx.workload.get("dataset_id") or "")
    conversations = load_agentic_conversations(ctx.registry, dataset_id) if dataset_id else []

    limit = ctx.param("num_conversations") or ctx.param("num_requests")
    if limit:
        conversations = conversations[: int(limit)]
    max_turns = int(ctx.param("max_turns_per_conversation", 0) or 0)

    if not conversations:
        ctx.warnings.append(f"dataset-missing:{dataset_id or '<none>'}")
        return WorkloadOutcome(
            kind="agentic",
            resolved_params={"dataset_id": dataset_id},
            gotchas=[
                gotcha("blocker", f"Agentic dataset '{dataset_id}' has no sessions here.")
            ],
            warnings=list(ctx.warnings),
        )

    honour_delays = bool(ctx.param("honour_tool_delays", True))
    concurrency = max(1, int(ctx.param("concurrency", 1)))
    max_tokens = int(ctx.param("output_tokens", 2048))
    semaphore = asyncio.Semaphore(concurrency)

    results: list[RequestResult] = []
    sessions: list[dict[str, Any]] = []

    async def run_session(index: int, turns: list[AgenticTurn]) -> None:
        cid = turns[0].conversation_id
        system = next((t.system for t in turns if t.system), None)
        tools = next((t.tools for t in turns if t.tools), None)
        history: list[dict[str, Any]] = []
        if system:
            history.append({"role": "system", "content": system})

        extra_base = dict(ctx.extra_body())
        if tools:
            extra_base["tools"] = tools
            extra_base["tool_choice"] = "auto"

        turn_results: list[RequestResult] = []
        measured = 0
        started = asyncio.get_running_loop().time()
        delayed_s = 0.0

        for turn in turns:
            if turn.role == "user":
                history.append({"role": "user", "content": turn.content or ""})
                continue
            if turn.role == "tool":
                history.extend(_tool_result_messages(turn))
                if honour_delays and turn.delay_seconds > 0:
                    delayed_s += turn.delay_seconds
                    await asyncio.sleep(turn.delay_seconds)
                continue
            if turn.role != "assistant":
                continue
            if max_turns and measured >= max_turns:
                break

            async with semaphore:
                result = await ctx.client.chat_stream(
                    list(history),
                    request_id=f"{cid}-t{turn.turn:04d}",
                    prompt_id=cid,
                    max_tokens=max_tokens,
                    temperature=float(ctx.param("temperature", ctx.spec.request.temperature)),
                    top_p=ctx.spec.request.top_p,
                    seed=ctx.spec.request.seed,
                    extra_body=extra_base,
                    timeout_s=ctx.timeout_s,
                )
            turn_results.append(result)
            measured += 1
            # The recorded turn goes back, never the model's own: that is what keeps the
            # prompt identical across engines.
            history.append(_recorded_assistant(turn))

        elapsed = asyncio.get_running_loop().time() - started
        results.extend(turn_results)
        prompt_tokens = [r.prompt_tokens for r in turn_results if r.prompt_tokens]
        sessions.append(
            {
                "conversation_id": cid,
                "turns_measured": measured,
                "ok": sum(1 for r in turn_results if r.ok),
                "failed": sum(1 for r in turn_results if not r.ok),
                "wall_s": round(elapsed, 3),
                "tool_delay_s": round(delayed_s, 3),
                "active_s": round(max(elapsed - delayed_s, 0.0), 3),
                "prompt_tokens_first": prompt_tokens[0] if prompt_tokens else None,
                "prompt_tokens_last": prompt_tokens[-1] if prompt_tokens else None,
                "prompt_tokens_max": max(prompt_tokens) if prompt_tokens else None,
            }
        )

    with sampling(ctx) as telemetry:
        await asyncio.gather(
            *(run_session(i, turns) for i, turns in enumerate(conversations))
        )

    metrics = aggregate_serving(results, concurrency=concurrency)
    metrics.update(telemetry)
    growth = [s["prompt_tokens_max"] for s in sessions if s["prompt_tokens_max"]]
    metrics["session_prompt_tokens_max"] = distribution(growth) if growth else None

    sessions.sort(key=lambda s: s["conversation_id"])
    gotchas = []
    if not honour_delays:
        gotchas.append(
            gotcha(
                "warn",
                "Recorded tool delays were skipped, so the cache never had to survive the "
                "gaps a real agent leaves; treat the throughput as an upper bound.",
            )
        )
    if max_turns:
        gotchas.append(
            gotcha(
                "info",
                f"Each session stopped after {max_turns} assistant turns, so the deepest "
                "context in the recording was not reached.",
            )
        )

    return WorkloadOutcome(
        kind="agentic",
        metrics=metrics,
        resolved_params={
            "dataset_id": dataset_id,
            "num_conversations": len(conversations),
            "concurrency": concurrency,
            "output_tokens": max_tokens,
            "honour_tool_delays": honour_delays,
            "max_turns_per_conversation": max_turns or None,
            "temperature": float(ctx.param("temperature", ctx.spec.request.temperature)),
            "timeout_s": ctx.timeout_s,
        },
        sweep=sessions,
        raw={"requests": raw_payload(results), "sessions": sessions},
        gotchas=gotchas,
        warnings=list(ctx.warnings),
    )
