# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Generate `datasets/prompts-shared-prefix-v1/`.

100 prompts that share one of four long system prompts (roughly 8K, 19K, 32K and
53K characters) followed by a short, distinct question. This is the dataset for
measuring prefix caching: with caching off, every request pays the full prefill;
with caching on, only the first request in each of the four groups does. The seed
notes record exactly this effect on a DGX Spark (19K prefix: 12.64 s -> 0.89 s).

The prefix text is stored inline on every row (`shared_prefix`) so the harness
needs no side table: **when `shared_prefix` is non-null it must be sent as a
leading system message, before `messages`.** The rows themselves stay short.

Run: `uv run datasets/_gen/gen_prompts_shared_prefix.py`
"""

from __future__ import annotations

import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import _lib as L  # noqa: E402

SEED = 20260824
DATASET_ID = "prompts-shared-prefix-v1"

PREFIX_SPECS = (
    # (prefix_id, target_chars, topic, role sentence, question templates)
    (
        "sp-8k",
        8_000,
        "business",
        "You are the duty supervisor for a support desk. The operations handbook below is the "
        "only source of truth; when it is silent, say so instead of guessing.",
    ),
    (
        "sp-19k",
        19_000,
        "code",
        "You are a senior engineer answering questions about the service below. Quote function "
        "names exactly as they appear in the source and never invent an API that is not shown.",
    ),
    (
        "sp-32k",
        32_000,
        "medicine",
        "You are a clinical documentation assistant. Answer strictly from the ward records below, "
        "cite the day number for every claim, and never infer a diagnosis that is not written down.",
    ),
    (
        "sp-53k",
        53_000,
        "law",
        "You are a contract analyst. Answer only from the agreement below, always give the clause "
        "number, and flag explicitly when the agreement does not address the question.",
    ),
)

#: Every template carries at least one varying slot, so 25 rows per group are all distinct
#: while staying short — the cache measurement needs the *prefix* shared, not the question.
QUESTIONS: dict[str, tuple[str, ...]] = {
    "sp-8k": (
        "A customer on the {plan} plan is {n} days past the escalation window. What should the desk do first?",
        "Summarise, in {few} bullets, what the handbook says about a backlog above {n} open cases.",
        "Which metric does the handbook treat as the tie-breaker when {metric_a} and {metric_b} disagree?",
        "Draft a two-sentence reply to a customer whose order {uid} was delayed by the carrier.",
        "Does the handbook allow a supervisor to approve {n} hours of overtime without written sign-off?",
        "Escalation {uid} has been open for {n} days. Who owns it now, and what is the next checkpoint?",
        "What does the handbook say about vendor {ref} missing its on-time target for {n} weeks running?",
        "A shift is {n} people short on the {plan} queue. Which mitigation does the handbook rank first?",
        "Quote what the handbook requires before the {metric_a} target is changed mid-quarter.",
    ),
    "sp-19k": (
        "Which function is on the hot path for every request, and what does it allocate? Answer in {few} sentences.",
        "A caller reports that {n} tenants collide in the cache. Which cache key is at fault and why?",
        "Write a unit test for the uncovered error branch and name it after ticket {ref}.",
        "The p{n} latency has a step in it. Which retry setting explains that, and what would you change?",
        "List every function whose behaviour would change if the semaphore bound were raised to {n}.",
        "Ticket {ref}: an error is swallowed somewhere in this module. Point at the function and the context.",
        "Explain in at most {few} sentences what this module does, for a developer who has never seen it.",
        "If the {service_q} timeout were raised to {ms} ms, which call sites would have to change?",
        "Rank the {few} riskiest things in this module for a reviewer who has {mins} minutes.",
    ),
    "sp-32k": (
        "Record check {uid}: on which day was the {marker_q} first recorded outside the reference range?",
        "List every investigation requested twice, with the day number for each. Keep it to {few} lines.",
        "What does the record say about allergy status, and where was it captured? Cross-check entry {ref}.",
        "Write a {few}-sentence handover for the incoming night team, citing day numbers.",
        "Was a follow-up appointment booked, and if so how many weeks after discharge? Audit item {uid}.",
        "Which entry first mentions the {marker_q}, and what value was recorded there?",
        "Summarise the management plan in {few} bullets, each citing a day number.",
        "Audit {uid}: name every documentation gap a reviewer would flag in these notes.",
        "Between day {n} and day {n2}, what changed in the recorded observations?",
    ),
    "sp-53k": (
        "What is the payment term for invoices, and which clause sets it? Answer in {few} sentences.",
        "Which clause caps aggregate liability, and what is the cap measured against? Our reference is {ref}.",
        "May the Customer terminate for convenience, and on how many days notice? Query {uid}.",
        "List every obligation that survives termination, with clause numbers. Limit the list to {few} items.",
        "Does the agreement address transfers to a third country? Cite the clause. Query {uid}.",
        "A dispute has been raised under clause {n}. What does the agreement say about governing law?",
        "Client question {uid}: are service credits the sole remedy for missed availability targets?",
        "Summarise the change control procedure in {few} bullets, citing clause numbers.",
        "What notice period applies to termination for material breach, and how does clause {n} qualify it?",
    ),
}

SLOTS = {
    "plan": ("starter", "standard", "business", "enterprise", "legacy"),
    "metric_a": ("first-response time", "cost per order", "utilisation", "rework rate", "on-time delivery rate"),
    "metric_b": ("customer satisfaction", "backlog age", "average handling time", "escalation rate", "net retention"),
    "marker_q": (
        "inflammatory marker",
        "resting heart rate",
        "serum creatinine",
        "oxygen saturation",
        "fasting glucose",
    ),
    "service_q": ("payments service", "identity service", "object store", "search cluster", "message broker"),
    "few": ("three", "four", "five", "six"),
    "mins": ("five", "ten", "fifteen", "twenty"),
}

PER_PREFIX = 25


def build_prefix(rng: random.Random, counter: L.Counter, topic: str, role: str, target: int) -> str:
    """Compose a system prompt of *target* characters (+/- 2 %)."""
    lo, hi = int(target * 0.98), int(target * 1.02)
    body_target = target - len(role) - 80
    for _ in range(12):
        body = L.document(rng, topic, counter, body_target)
        text = f"{role}\n\n---\n\n{body}\n\n---\n\nEnd of reference material."
        if len(text) > hi:
            text = L.trim_to_chars(text, hi - 30) + "\n\n---\n\nEnd of reference material."
        if lo <= len(text) <= hi:
            return text
        body_target = int(body_target * (1.2 if len(text) < lo else 0.85))
    raise RuntimeError(f"could not build a {target}-char prefix for {topic}")


def main() -> None:
    rng = random.Random(SEED)
    counter = L.Counter(value=500_000)

    prefixes: dict[str, dict] = {}
    for prefix_id, target, topic, role in PREFIX_SPECS:
        text = build_prefix(rng, counter, topic, role, target)
        prefixes[prefix_id] = {
            "id": prefix_id,
            "topic": topic,
            "chars": len(text),
            "approx_tokens": L.approx_tokens_from_chars(len(text)),
            "text": text,
        }

    rows: list[dict] = []
    i = 0
    for prefix_id, _target, topic, _role in PREFIX_SPECS:
        templates = QUESTIONS[prefix_id]
        seen: set[str] = set()
        for k in range(PER_PREFIX):
            tpl = templates[k % len(templates)]
            for _ in range(20):
                q = tpl.format_map(L.Filler(rng, SLOTS, counter.next()))
                if q not in seen:
                    break
            else:
                raise RuntimeError(f"duplicate question for {prefix_id}")
            seen.add(q)
            i += 1
            prefix = prefixes[prefix_id]
            messages = [{"role": "user", "content": q}]
            tokens = L.approx_tokens(messages, prefix["text"])
            rows.append(
                {
                    "id": f"pfx-{i:04d}",
                    "topic": topic,
                    "bucket": L.bucket_of(tokens),
                    "lang": "en",
                    "approx_tokens": tokens,
                    "messages": messages,
                    "shared_prefix": prefix["text"],
                    "prefix_id": prefix_id,
                    "prefix_approx_tokens": prefix["approx_tokens"],
                }
            )

    d = L.dataset_dir(DATASET_ID)
    n = L.write_jsonl(d / "prompts.jsonl", rows)
    L.write_json(
        d / "prefixes.json",
        {
            "note": "The same four strings that appear inline in prompts.jsonl:shared_prefix. "
            "Provided separately so a harness can warm the cache once per group without "
            "scanning the rows.",
            "prefixes": [
                {k: v for k, v in p.items() if k != "text"} | {"text": p["text"]} for p in prefixes.values()
            ],
        },
    )

    groups = {
        p["id"]: {
            "chars": p["chars"],
            "approx_tokens": p["approx_tokens"],
            "rows": sum(1 for r in rows if r["prefix_id"] == p["id"]),
        }
        for p in prefixes.values()
    }
    L.write_json(
        d / "dataset.json",
        L.base_dataset_json(
            DATASET_ID,
            "Shared-prefix prompts v1",
            "prompts",
            "100 short questions sharing one of four long system prompts (about 8K, 19K, 32K and "
            "53K characters). Built to measure prefix caching: the delta between a run with the "
            "engine's prefix cache enabled and one without is the whole point of the dataset.",
            ["prompts.jsonl", "prefixes.json"],
            n,
            "gen_prompts_shared_prefix.py",
            seed=SEED,
            topics=sorted({r["topic"] for r in rows}),
            length_buckets={k: list(v) for k, v in L.BUCKETS.items()},
            prefix_groups=groups,
            schema={
                "fields": ["id", "topic", "bucket", "approx_tokens", "messages", "shared_prefix"],
                "optional_fields": ["lang", "prefix_id", "prefix_approx_tokens"],
                "shared_prefix": "Non-null on every row. The harness MUST send it as a leading "
                "system message: [{role:'system',content:shared_prefix}, *messages]. "
                "approx_tokens already includes it.",
            },
            usage=[
                "Send the rows of one prefix_id group back to back so the cache can hit.",
                "Report ttft_ms per prefix group; a cold-vs-warm ratio near 1.0 means the engine "
                "is not reusing the prefix.",
                "Pair a run with --enable-prefix-caching against one without it; the workload id "
                "serve-prefix-c16-v1 is used for both, the engine args differ.",
            ],
        ),
    )
    L.report(DATASET_ID, n)


if __name__ == "__main__":
    main()
