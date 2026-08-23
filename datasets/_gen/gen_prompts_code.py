# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Generate `datasets/prompts-code-v1/`.

150 coding prompts across five languages (python, typescript, go, rust, sql) and
four task kinds (write, fix, explain, refactor). Code prompts behave differently
from prose on a serving benchmark — longer outputs, denser tokens, more
whitespace — so they get their own dataset and their own workload
(`serve-code-c8-i2k-o1k-v1`).

These are *prompts*, not an eval: nothing here is scored. Graded coding tasks with
hidden tests live in `eval-code-v1`.

Run: `uv run datasets/_gen/gen_prompts_code.py`
"""

from __future__ import annotations

import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import _lib as L  # noqa: E402

SEED = 20260825
DATASET_ID = "prompts-code-v1"

LANGS = ("python", "typescript", "go", "rust", "sql")
LANG_LABEL = {
    "python": "Python 3.11",
    "typescript": "TypeScript 5",
    "go": "Go 1.22",
    "rust": "Rust 2021 edition",
    "sql": "PostgreSQL 16",
}
#: (write, fix, explain, refactor) per language -> 30 rows per language, 150 total
KIND_PLAN = {"write": 8, "fix": 8, "explain": 7, "refactor": 7}

#: Function-writing specs that make sense in any of the four general-purpose languages.
SPECS = (
    ("parse_duration", "parse a duration string such as '1h30m10s' into whole seconds",
     "reject an empty string, a bare number, and units in the wrong order"),
    ("merge_intervals", "merge a list of possibly overlapping half-open intervals and return them sorted",
     "touching intervals such as [1,2) and [2,3), and an empty input"),
    ("chunk", "split a sequence into consecutive chunks of at most n elements",
     "n larger than the sequence, and n of zero or below"),
    ("word_frequency", "count words case-insensitively and return the counts sorted by count then word",
     "punctuation, repeated whitespace, and an empty input"),
    ("to_camel_case", "convert snake_case identifiers to camelCase",
     "leading underscores, doubled underscores, and an already-camelCase input"),
    ("flatten", "flatten a nested map into a single level with dotted keys",
     "empty nested maps, and keys that already contain a dot"),
    ("binary_search", "return the index of a value in a sorted slice, or -1 when it is absent",
     "duplicates (return the first match) and an empty slice"),
    ("top_k", "return the k most frequent values, ties broken by the value itself",
     "k larger than the number of distinct values, and k of zero"),
    ("roman_to_int", "convert a Roman numeral in the range I to MMMCMXCIX to an integer",
     "subtractive pairs such as IV and CM, and an invalid character"),
    ("run_length_encode", "run-length encode a string as pairs of character and count",
     "single-character runs, and an empty string"),
    ("is_balanced", "report whether brackets of three kinds are correctly nested",
     "a closing bracket with no opener, and brackets inside a quoted substring"),
    ("moving_average", "compute the moving average over a window of size n",
     "n larger than the input, and the first n-1 positions"),
    ("normalise_phone", "normalise a phone number to E.164 given a default country code",
     "existing plus prefixes, spaces and dashes, and clearly invalid input"),
    ("dedupe_stable", "remove duplicates while preserving first-seen order",
     "unhashable-looking values (document your assumption) and an empty input"),
    ("parse_csv_line", "parse one CSV line honouring quoted fields and escaped quotes",
     "an empty field, a quoted field containing a comma, and a trailing separator"),
    ("compare_semver", "compare two semantic version strings and return -1, 0 or 1",
     "pre-release suffixes, and different numbers of components"),
    ("group_anagrams", "group words that are anagrams of each other",
     "case handling (document it), and words with repeated letters"),
    ("retry_with_backoff", "retry a fallible callback with exponential backoff and a cap",
     "the cap being reached, and a callback that succeeds on the first try"),
    ("token_bucket", "implement a token-bucket rate limiter with a refill rate and a burst size",
     "a clock that goes backwards, and a burst larger than the bucket"),
    ("longest_common_prefix", "return the longest common prefix of a list of strings",
     "an empty list, and a list containing an empty string"),
    ("diff_lines", "return a minimal list of added and removed lines between two texts",
     "identical inputs, and one input being empty"),
    ("safe_get", "read a value from a nested structure by path, with a default",
     "a path that runs into a non-container, and an empty path"),
    ("format_bytes", "format a byte count as a human-readable string with one decimal",
     "exactly 1024, zero, and values above a terabyte"),
    ("validate_checksum", "validate an identifier whose last digit is a mod-97 checksum",
     "wrong length, non-digit characters, and a correct example"),
)

SQL_SPECS = (
    ("daily active tenants", "count distinct tenants per day for the last 30 days from an events table",
     "days with no events must still appear in the output"),
    ("slow endpoints", "list the ten endpoints with the highest p95 duration over the last week",
     "endpoints with fewer than 100 samples must be excluded"),
    ("first order per customer", "return each customer's first order with its date and amount",
     "customers with several orders on the same day"),
    ("gap detection", "find gaps longer than one hour in a per-tenant event stream",
     "tenants with a single event, and the window boundaries"),
    ("running total", "compute a running total of invoice amounts per tenant, ordered by date",
     "ties on the same date, and tenants with no invoices"),
    ("dedupe rows", "delete duplicate rows keeping the earliest id per (tenant_id, external_id)",
     "the statement must be safe to re-run"),
    ("cohort retention", "build a monthly cohort retention table from a signups and an events table",
     "months with no returning users"),
    ("upsert", "insert or update a row keyed by (tenant_id, external_id) in one statement",
     "concurrent writers, and only updating when the payload actually changed"),
    ("index review", "propose the indexes needed by a query that filters on tenant and a date range",
     "explain why a composite index order matters"),
    ("percentile by group", "return the median and p90 duration per endpoint for one day",
     "endpoints with an even number of samples"),
)

WRITE_FRAMES = (
    "Write a {label} function `{name}` that will {desc}.\n\nRequirements:\n"
    "- Handle these cases explicitly: {edge}.\n"
    "- Document the signature and the return value.\n"
    "- Keep it to the standard library.\n"
    "- Add {few} example calls with their expected results.",
    "I need a {label} implementation of `{name}`: it should {desc}.\n\n"
    "Edge cases that matter here: {edge}. Explain your approach in two sentences first, "
    "then give the code, then say what you would test.",
    "Implement `{name}` in {label}. Behaviour: {desc}.\n\n"
    "Be explicit about {edge}. If the specification is ambiguous, state the assumption you made "
    "rather than silently choosing one.",
)

SQL_FRAMES = (
    "Write a {label} query for the following: {desc}.\n\nConstraint: {edge}.\n"
    "Show the query, then explain the plan you expect and which index it needs.",
    "Using {label}, {desc}.\n\nConstraint: {edge}.\n\nAssume tables `events(id, tenant_id, endpoint, status, "
    "duration_ms, created_at)`, `orders(id, tenant_id, amount_cents, created_at)` and "
    "`invoices(id, tenant_id, amount_cents, issued_on)`. Give the query and a one-line explanation.",
)

FIX_FRAMES = (
    "Ticket {ref}: {symptom}\n\nThe module is below. Find the most likely cause, explain it, and "
    "post a patch as a unified diff. Do not restructure code that is not involved.\n\n{code}",
    "A user reports: \"{symptom}\"\n\nHere is the file. Work out what is wrong, say how you would "
    "confirm it from the logs, and then fix it.\n\n{code}",
)

EXPLAIN_FRAMES = (
    "Explain the file below to a developer who has just joined the team: what it does, function by "
    "function, and which parts they should be careful with. Finish with the {few} questions you "
    "would ask the original author.\n\n{code}",
    "I am reviewing this module and I do not know the codebase. Walk me through it, name the "
    "invariants it relies on, and flag anything that looks accidental rather than deliberate.\n\n{code}",
)

REFACTOR_FRAMES = (
    "Refactor the module below for readability without changing its behaviour. Keep the public "
    "names stable, explain each change in one line, and list anything you deliberately left alone.\n\n{code}",
    "This module is on a hot path and allocates more than it should. Suggest concrete changes, "
    "ordered by expected impact, and show the rewritten version of the {few} worst offenders.\n\n{code}",
)

SYMPTOMS = (
    "two tenants occasionally see each other's cached results, but only under load.",
    "the p95 latency has a visible step at exactly {ms} ms and nobody knows why.",
    "the process leaks memory over about {n} hours and only in the region with the most traffic.",
    "a decode error is swallowed somewhere and the caller gets an empty result instead of a failure.",
    "the retry loop makes the outage worse instead of better when the downstream is slow.",
    "results are correct but arrive in a different order on every run, which breaks a downstream diff.",
    "the log volume triples under load and the useful lines are impossible to find.",
    "after the migration, about {pct} percent of rows have a null where the old code wrote a default.",
)

FILL_SLOTS = {"few": ("three", "four", "five"), "symptom": SYMPTOMS}


def code_block(rng: random.Random, counter: L.Counter, lang: str, target: int) -> str:
    _lang, src = L.code_file(rng, counter, target, lang=lang)
    return f"```{L.CODE_FENCE[lang]}\n{src}```"


def main() -> None:
    rng = random.Random(SEED)
    counter = L.Counter(value=800_000)
    rows: list[dict] = []
    seen: set[str] = set()

    specs = {lang: L.Deck(rng, range(len(SQL_SPECS if lang == "sql" else SPECS))) for lang in LANGS}
    i = 0
    for lang in LANGS:
        label = LANG_LABEL[lang]
        for kind, count in KIND_PLAN.items():
            for _ in range(count):
                for _attempt in range(10):
                    fill = L.Filler(rng, FILL_SLOTS, counter.next())
                    if kind == "write":
                        table = SQL_SPECS if lang == "sql" else SPECS
                        name, desc, edge = table[specs[lang].draw()]
                        frame = rng.choice(SQL_FRAMES if lang == "sql" else WRITE_FRAMES)
                        fill.update({"label": label, "name": name, "desc": desc, "edge": edge})
                        content = frame.format_map(fill)
                    else:
                        target = rng.randint(900, 5200)
                        fill["code"] = code_block(rng, counter, lang, target)
                        # the symptom bank itself carries slots, so render it first
                        fill["symptom"] = rng.choice(SYMPTOMS).format_map(fill)
                        frames = {"fix": FIX_FRAMES, "explain": EXPLAIN_FRAMES, "refactor": REFACTOR_FRAMES}[kind]
                        content = rng.choice(frames).format_map(fill)
                    if content not in seen:
                        break
                else:
                    raise RuntimeError(f"duplicate prompt for {lang}/{kind}")
                seen.add(content)
                i += 1
                messages = [
                    {
                        "role": "system",
                        "content": f"You are an experienced {label} engineer. Answer with working code and a "
                        "short explanation. Never invent APIs that do not exist.",
                    },
                    {"role": "user", "content": content},
                ]
                tokens = L.approx_tokens(messages)
                rows.append(
                    {
                        "id": f"code-{i:04d}",
                        "topic": "code",
                        "bucket": L.bucket_of(tokens),
                        "lang": "en",
                        "code_lang": lang,
                        "task": kind,
                        "approx_tokens": tokens,
                        "messages": messages,
                        "shared_prefix": None,
                    }
                )

    assert len(rows) == 150, len(rows)

    by_bucket: dict[str, int] = {}
    by_task: dict[str, int] = {}
    by_lang: dict[str, int] = {}
    for r in rows:
        by_bucket[r["bucket"]] = by_bucket.get(r["bucket"], 0) + 1
        by_task[r["task"]] = by_task.get(r["task"], 0) + 1
        by_lang[r["code_lang"]] = by_lang.get(r["code_lang"], 0) + 1

    d = L.dataset_dir(DATASET_ID)
    n = L.write_jsonl(d / "prompts.jsonl", rows)
    L.write_json(
        d / "dataset.json",
        L.base_dataset_json(
            DATASET_ID,
            "Coding prompts v1",
            "prompts",
            "150 coding prompts in python, typescript, go, rust and sql, covering four task kinds: "
            "write a function from a specification, diagnose and fix a reported bug in a supplied "
            "module, explain an unfamiliar module, and refactor one. Used by the code serving "
            "workload, where output lengths are longer than in chat.",
            ["prompts.jsonl"],
            n,
            "gen_prompts_code.py",
            seed=SEED,
            topics=["code"],
            length_buckets={k: list(v) for k, v in L.BUCKETS.items()},
            code_languages=list(LANGS),
            tasks=list(KIND_PLAN),
            counts={"by_bucket": by_bucket, "by_task": by_task, "by_code_language": by_lang},
            schema={
                "fields": ["id", "topic", "bucket", "approx_tokens", "messages", "shared_prefix"],
                "optional_fields": ["lang", "code_lang", "task"],
                "messages": "Two turns: a system message naming the language, then the user task.",
            },
            notes=[
                "Nothing here is scored — these prompts exist to load the engine with code-shaped "
                "traffic. Graded coding tasks with hidden tests are in eval-code-v1.",
                "Supplied modules are synthetic and internally consistent, but they are not real "
                "programs; the 'fix' prompts describe a plausible symptom rather than a planted bug.",
            ],
        ),
    )
    L.report(DATASET_ID, n)


if __name__ == "__main__":
    main()
