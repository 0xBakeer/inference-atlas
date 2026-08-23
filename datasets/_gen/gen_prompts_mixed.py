# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Generate `datasets/prompts-mixed-v1/`.

600 chat prompts across 11 topics and 6 length buckets. This is the default
dataset for serving workloads: it exercises short chat turns, medium documents,
long documents (a report + a question, a big source file + a task, a meeting
transcript + a summary ask) and very long ones, without ever repeating a
paragraph verbatim — repeated text would be absorbed by prefix caching and by
tokenizer merges and would flatter the prefill numbers.

Run: `uv run datasets/_gen/gen_prompts_mixed.py`
"""

from __future__ import annotations

import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import _lib as L  # noqa: E402
import _multilingual as ML  # noqa: E402

SEED = 20260823
DATASET_ID = "prompts-mixed-v1"

#: rows per (bucket, topic). Multilingual prompts stay short by design.
BUCKET_PLAN: dict[str, int] = {"xs": 140, "s": 160, "m": 150, "l": 120, "xl": 20, "xxl": 10}
MULTILINGUAL_PLAN: dict[str, int] = {"xs": 14, "s": 16}

#: character targets fed to the composer per bucket (before bucket-fitting)
CHAR_TARGET: dict[str, tuple[int, int]] = {
    "m": (1200, 3400),
    "l": (4400, 15000),
    "xl": (17000, 40000),
    "xxl": (70000, 110000),
}

XS_FRAMES = (
    "{q}",
    "{q}",
    "{q} Keep the answer under {n} sentences.",
    "Answer for a {audience}: {q}",
    "{q} Be concrete and skip the preamble.",
    "I have {n} minutes before a meeting. {q}",
    "{q} Give exactly one worked example.",
    "A colleague asked me this today and I fumbled it. {q}",
    "{q} Assume the reader knows nothing about the field.",
    "Note {uid}. {q}",
)

AUDIENCES = (
    "curious teenager",
    "busy manager",
    "new graduate",
    "sceptical reviewer",
    "non-technical client",
    "night-shift colleague",
)


def xs_prompt(rng: random.Random, topic: str, counter: L.Counter) -> str:
    bank = L.TOPICS[topic]
    frame = rng.choice(XS_FRAMES)
    return frame.format(
        q=rng.choice(bank.short_questions),
        n=rng.randint(2, 6),
        audience=rng.choice(AUDIENCES),
        uid=counter.next(),
    )


def s_prompt(rng: random.Random, topic: str, counter: L.Counter) -> str:
    bank = L.TOPICS[topic]
    context = L.paragraph(rng, topic, counter, n_sentences=rng.randint(2, 4))
    ask = rng.choice(bank.asks)
    return f"Context ({bank.doc_kind}, extract {counter.next()}):\n\n{context}\n\n{ask}"


def long_prompt(rng: random.Random, topic: str, bucket: str, counter: L.Counter) -> str:
    lo, hi = L.BUCKETS[bucket]
    min_chars, max_chars = lo * 4, hi * 4
    tlo, thi = CHAR_TARGET[bucket]
    target = rng.randint(tlo, thi)
    bank = L.TOPICS[topic]
    for attempt in range(8):
        body = L.document(rng, topic, counter, target)
        ask = rng.choice(bank.asks)
        text = f"{body}\n\n---\n\n{ask}"
        if len(text) > max_chars:
            text = L.trim_to_chars(text, max_chars - len(ask) - 8) + f"\n\n---\n\n{ask}"
        if min_chars <= len(text) <= max_chars:
            return text
        target = int(target * (1.35 if len(text) < min_chars else 0.8))
    raise RuntimeError(f"could not fit {topic}/{bucket} into {min_chars}..{max_chars} chars")


def multilingual_prompt(rng: random.Random, bucket: str, lang: str) -> str:
    bank = ML.BANKS[lang]
    lo, hi = L.BUCKETS[bucket]
    min_chars, max_chars = lo * 4, hi * 4
    if bucket == "xs":
        # de/fr/es/ar standalone instructions already land in the xs range; zh and ja
        # are far denser per character, so those rows are composed from paragraphs.
        for text in rng.sample(list(bank.prompts), k=len(bank.prompts)):
            if min_chars <= len(text) <= max_chars:
                return text
    paras = list(bank.paragraphs)
    rng.shuffle(paras)
    ask = rng.choice(bank.asks)
    for k in range(1, len(paras) + 1):
        text = "\n\n".join(paras[:k] + [ask])
        if len(text) >= min_chars:
            if len(text) <= max_chars:
                return text
            break
    raise RuntimeError(f"could not fit multilingual {lang}/{bucket}")


def plan_topics(total: int, topics: list[str]) -> list[str]:
    """Spread *total* rows as evenly as possible over *topics* (deterministic order)."""
    out: list[str] = []
    i = 0
    while len(out) < total:
        out.append(topics[i % len(topics)])
        i += 1
    return sorted(out, key=topics.index)


def main() -> None:
    rng = random.Random(SEED)
    counter = L.Counter(value=10_000)
    rows: list[dict] = []
    seen: set[str] = set()
    topics = list(L.LONG_TOPICS)

    for bucket, total in BUCKET_PLAN.items():
        ml_count = MULTILINGUAL_PLAN.get(bucket, 0)
        for i, topic in enumerate(plan_topics(total - ml_count, topics)):
            for attempt in range(12):
                if bucket == "xs":
                    content = xs_prompt(rng, topic, counter)
                elif bucket == "s":
                    content = s_prompt(rng, topic, counter)
                else:
                    content = long_prompt(rng, topic, bucket, counter)
                if content not in seen:
                    break
            else:
                raise RuntimeError(f"duplicate prompt for {topic}/{bucket}")
            seen.add(content)
            rows.append({"topic": topic, "bucket": bucket, "content": content, "lang": "en"})
        for i in range(ml_count):
            lang = ML.PROMPT_LANGS[i % len(ML.PROMPT_LANGS)]
            for attempt in range(20):
                content = multilingual_prompt(rng, bucket, lang)
                if content not in seen:
                    break
            else:
                raise RuntimeError(f"duplicate multilingual prompt for {lang}/{bucket}")
            seen.add(content)
            rows.append({"topic": "multilingual", "bucket": bucket, "content": content, "lang": lang})

    order = {b: i for i, b in enumerate(BUCKET_PLAN)}
    rows.sort(key=lambda r: (order[r["bucket"]], r["topic"], r["lang"]))

    out = []
    for i, r in enumerate(rows, start=1):
        messages = [{"role": "user", "content": r["content"]}]
        tokens = L.approx_tokens(messages)
        assert L.bucket_of(tokens) == r["bucket"], (r["topic"], r["bucket"], tokens)
        out.append(
            {
                "id": f"mix-{i:04d}",
                "topic": r["topic"],
                "bucket": r["bucket"],
                "lang": r["lang"],
                "approx_tokens": tokens,
                "messages": messages,
                "shared_prefix": None,
            }
        )

    d = L.dataset_dir(DATASET_ID)
    n = L.write_jsonl(d / "prompts.jsonl", out)

    by_bucket: dict[str, int] = {}
    by_topic: dict[str, int] = {}
    for row in out:
        by_bucket[row["bucket"]] = by_bucket.get(row["bucket"], 0) + 1
        by_topic[row["topic"]] = by_topic.get(row["topic"], 0) + 1

    L.write_json(
        d / "dataset.json",
        L.base_dataset_json(
            DATASET_ID,
            "Mixed chat prompts v1",
            "prompts",
            "600 synthetic chat prompts spanning eleven topics and six length buckets, from "
            "single-sentence questions to 60k-token documents with a task attached. Every prompt "
            "is unique and carries running reference numbers so that prefix caching and tokenizer "
            "merges cannot inflate prefill throughput.",
            ["prompts.jsonl"],
            n,
            "gen_prompts_mixed.py",
            seed=SEED,
            topics=sorted(by_topic),
            length_buckets={k: list(v) for k, v in L.BUCKETS.items()},
            counts={"by_bucket": by_bucket, "by_topic": by_topic},
            languages=["en", *ML.PROMPT_LANGS],
            schema={
                "fields": ["id", "topic", "bucket", "approx_tokens", "messages", "shared_prefix"],
                "optional_fields": ["lang"],
                "messages": "OpenAI chat format: [{role, content}]. Every row is a single user turn.",
                "shared_prefix": "Always null in this dataset; see prompts-shared-prefix-v1.",
            },
            notes=[
                "approx_tokens uses the repo-wide chars/4 heuristic; real tokenizers differ, and "
                "for the zh/ja multilingual rows the real count is roughly 2-4x higher.",
                "Multilingual rows appear only in the xs and s buckets and are written natively "
                "(de, fr, es, ar, zh, ja).",
                "Buckets are inclusive token ranges on approx_tokens.",
            ],
        ),
    )
    L.report(DATASET_ID, n)


if __name__ == "__main__":
    main()
