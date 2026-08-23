# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Generate `datasets/eval-longctx-v1/`.

100 long-context question items built on the `haystack-v1` algorithm: single-needle
retrieval at three depths, three-needle aggregation (add the secret numbers),
line-number lookup, and control items whose answer is deliberately NOT in the
document — a model that invents one should lose the point.

Items are weighted towards the cheap sizes: 1k and 4k carry the most variants and
128k the fewest, so the suite has enough items to be a real measurement without
turning into hours of 128k prefills. The 32k and 128k needle groups hold exactly
six items each, which is what `longctx-needle-32k-v1` and `longctx-needle-128k-v1`
run.

Sizes run 1k, 4k, 8k, 32k and 128k tokens, so a contributor with a small context
window can still run the cheap half of the suite and report it honestly.

Each row embeds its own recipe in `meta.haystack`; the document is materialised at
run time by `datasets/haystack-v1/build.py`. The row's `prompt` is the *question*
only — the harness must send `PREAMBLE + "\\n\\n" + document + "\\n\\n" + prompt`,
which is exactly what `build_prompt()` produces.

Run: `uv run datasets/_gen/gen_eval_longctx.py`
"""

from __future__ import annotations

import importlib.util
import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import _lib as L  # noqa: E402

SEED = 20260909
DATASET_ID = "eval-longctx-v1"
HAYSTACK_ID = "haystack-v1"

SIZES = ((1_024, "1k", "easy"), (4_096, "4k", "easy"), (8_192, "8k", "medium"),
         (32_768, "32k", "medium"), (131_072, "128k", "hard"))
DEPTHS = (0.1, 0.5, 0.9)

#: variants per size, per category — cheap sizes carry more of the weight
VARIANTS = {
    "needle": {1_024: 5, 4_096: 5, 8_192: 4, 32_768: 2, 131_072: 2},
    "multi_needle": {1_024: 4, 4_096: 4, 8_192: 3, 32_768: 2, 131_072: 2},
    "line_lookup": {1_024: 4, 4_096: 3, 8_192: 3, 32_768: 2, 131_072: 1},
    "absent": {1_024: 5, 4_096: 5, 8_192: 4, 32_768: 2, 131_072: 2},
}

CITIES = ("Aberholt", "Valcrest", "Threeford", "Kesswater", "Marren Bay", "Dunhallow",
          "Stonereach", "Oldmarsh")
ABSENT_CITIES = ("Redlow Point", "Norhaven", "Westcarr", "Ilmouth", "Garrowby")

NOT_FOUND_TOKENS = [
    "not mentioned", "not in the log", "no line", "does not appear", "not appear",
    "not stated", "not present", "no mention", "cannot find", "can't find", "not there",
    "nothing about", "no such", "not given", "not found",
]


def load_builder():
    path = L.DATASETS_DIR / HAYSTACK_ID / "build.py"
    spec = importlib.util.spec_from_file_location("haystack_build", path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def recipe(item_id, seed, target_tokens, needles, question, answer):
    return {
        "id": item_id,
        "kind": "multi" if len(needles) > 1 else "single",
        "target_tokens": target_tokens,
        "seed": seed,
        "algorithm": "haystack-v1",
        "needles": needles,
        "question": question,
        "answer": answer,
    }


def main() -> None:
    rng = random.Random(SEED)
    hb = load_builder()
    rows: list[dict] = []

    def add(category, difficulty, target_tokens, hay, answer, scorer, question, extra=None):
        text = hb.build_haystack(hay)
        lines = text.split("\n")
        for needle in hay["needles"]:
            line_no = next(i for i, ln in enumerate(lines, start=1)
                           if ln.split(": ", 1)[1] == needle["text"])
            needle["line_number"] = line_no
        rows.append({
            "id": f"lctx-{len(rows) + 1:04d}",
            "category": category,
            "difficulty": difficulty,
            "prompt": question,
            "answer": answer,
            "scorer": scorer,
            "meta": {
                "haystack": hay,
                "haystack_dataset": HAYSTACK_ID,
                "render": "haystack-v1: PREAMBLE + document + prompt (see build_prompt)",
                "target_tokens": target_tokens,
                "approx_tokens": L.approx_tokens_from_chars(len(text)),
                "lines": len(lines),
                "sha256": hb.sha256(text),
                **(extra or {}),
            },
        })

    # --- single-needle retrieval, three depths, several seeds each -------------------
    for target, label, difficulty in SIZES:
        for depth in DEPTHS:
            for variant in range(VARIANTS["needle"][target]):
                city = rng.choice(CITIES)
                code = str(rng.randint(10_000, 99_999))
                question = (f"What is the maintenance passphrase for the {city} vault? "
                            f"Reply with the passphrase only.")
                hay = recipe(
                    f"lctx-hay-{label}-d{int(depth * 100):02d}-{variant}",
                    8_100_000 + target + int(depth * 100) * 7 + variant,
                    target,
                    [{"depth": depth,
                      "text": f"The maintenance passphrase for the {city} vault is {code}.",
                      "answer": code}],
                    question, code)
                add("needle", difficulty, target, hay, code, "needle", question,
                    {"depth": depth})

    # --- three-needle aggregation ----------------------------------------------------
    for target, label, difficulty in SIZES:
        for variant in range(VARIANTS["multi_needle"][target]):
            codes = [rng.randint(100, 999) for _ in range(3)]
            question = ("Three lines in the log each state a secret number. Add all three "
                        "together and reply with the sum only.")
            hay = recipe(
                f"lctx-hay-{label}-multi-{variant}",
                8_200_000 + target + variant,
                target,
                [{"depth": depth,
                  "text": f"The {ordinal} secret number in this log is {code}.",
                  "answer": str(code)}
                 for depth, ordinal, code in zip(DEPTHS, ("first", "second", "third"), codes)],
                question, str(sum(codes)))
            add("multi_needle", "hard" if target >= 32_768 else difficulty, target, hay,
                str(sum(codes)), "needle", question, {"needle_count": 3})

    # --- line-number lookup ----------------------------------------------------------
    for target, label, difficulty in SIZES:
        for variant in range(VARIANTS["line_lookup"][target]):
            city = rng.choice(CITIES)
            code = str(rng.randint(10_000, 99_999))
            question = (f"On which numbered line does the log mention the {city} vault? Reply "
                        f"with the line number only, without the word 'line'.")
            hay = recipe(
                f"lctx-hay-{label}-line-{variant}",
                8_300_000 + target + variant * 31,
                target,
                [{"depth": 0.5,
                  "text": f"The maintenance passphrase for the {city} vault is {code}.",
                  "answer": code}],
                question, "")
            text = hb.build_haystack(hay)
            line_no = next(i for i, ln in enumerate(text.split("\n"), start=1)
                           if ln.split(": ", 1)[1] == hay["needles"][0]["text"])
            hay["answer"] = str(line_no)
            add("line_lookup", "hard" if target >= 8_192 else difficulty, target, hay,
                str(line_no), "exact", question)

    # --- control items: the answer is genuinely absent --------------------------------
    for target, label, difficulty in SIZES:
        for variant in range(VARIANTS["absent"][target]):
            present = rng.choice(CITIES)
            absent = ABSENT_CITIES[variant % len(ABSENT_CITIES)]
            code = str(rng.randint(10_000, 99_999))
            question = (f"What is the maintenance passphrase for the {absent} vault? If the log "
                        f"does not mention it, say clearly that it is not mentioned and do not "
                        f"guess.")
            hay = recipe(
                f"lctx-hay-{label}-absent-{variant}",
                8_400_000 + target + variant * 17,
                target,
                [{"depth": 0.5,
                  "text": f"The maintenance passphrase for the {present} vault is {code}.",
                  "answer": code}],
                question, "not mentioned")
            add("absent", "hard", target, hay, {"any": NOT_FOUND_TOKENS}, "contains", question,
                {"decoy_city": present, "asked_about": absent})

    assert len(rows) == 100, len(rows)

    by_size: dict[str, int] = {}
    for row in rows:
        key = f"{row['meta']['target_tokens'] // 1024}k"
        by_size[key] = by_size.get(key, 0) + 1

    d = L.dataset_dir(DATASET_ID)
    n = L.write_jsonl(d / "items.jsonl", rows)
    L.write_json(
        d / "dataset.json",
        L.eval_dataset_json(
            DATASET_ID,
            "Long-context eval v1",
            "100 questions over synthetic haystacks at 1k, 4k, 8k, 32k and 128k tokens: "
            "single-needle retrieval at 10 %, 50 % and 90 % depth, three-needle aggregation, "
            "line-number lookup, and control items whose answer is not in the document at all.",
            rows,
            "gen_eval_longctx.py",
            "needle",
            seed=SEED,
            sizes=list(by_size),
            counts_by_size=by_size,
            depends_on=[HAYSTACK_ID],
            notes=[
                "Rows carry a recipe, not text. Materialise with "
                "datasets/haystack-v1/build.py: build_haystack(meta.haystack) gives the document "
                "and build_prompt(meta.haystack) gives the full user message. meta.sha256 is the "
                "digest of the document, so an implementation can prove it agrees.",
                "The row's `prompt` equals meta.haystack.question; sending `prompt` alone, "
                "without the document, is a bug and will read as a catastrophic accuracy drop.",
                "Report accuracy per meta.target_tokens, not only overall — the interesting "
                "signal is where a model falls off, and averaging hides it.",
                "An item whose context exceeds the served max-model-len must be recorded as a "
                "failure with category 'context-overflow', not silently skipped.",
                "The `absent` items are scored leniently with contains/any over a list of "
                "not-found phrasings. A model that invents a passphrase fails; a model that says "
                "it is not in the log passes in any wording from the list.",
            ],
        ),
    )
    L.report(DATASET_ID, n)


if __name__ == "__main__":
    main()
