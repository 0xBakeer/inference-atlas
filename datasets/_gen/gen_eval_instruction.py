# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Generate `datasets/eval-instruction-v1/`.

104 instruction-following items whose compliance is decided by a program, not by a
judge model. Each item's `answer` is a rule set in the DSL implemented by
`datasets/eval-instruction-v1/rules.py` (the normative reference; the harness
`instruction` scorer must agree with it).

Every item is checked at generation time against a hand-built compliant example
(`meta.example_pass`) — if the example fails the rules, generation fails. That
catches the classic mistake of writing an instruction the rules cannot express, or
a rule set no answer can satisfy.

Run: `uv run datasets/_gen/gen_eval_instruction.py`
"""

from __future__ import annotations

import importlib.util
import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import _lib as L  # noqa: E402

SEED = 20260904
DATASET_ID = "eval-instruction-v1"


def load_rules():
    path = L.DATASETS_DIR / DATASET_ID / "rules.py"
    spec = importlib.util.spec_from_file_location("instruction_rules", path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


TOPICS = (
    "a rainy morning at a harbour", "how a bicycle brake works", "why bread needs to rest",
    "the first day in a new city", "keeping a shared kitchen tidy", "learning to swim as an adult",
    "a library that opens late", "the smell of a workshop", "packing for a long train journey",
    "why lists beat memory", "a garden in early spring", "waiting for a delayed bus",
    "an old radio that still works", "the last hour of a night shift", "a market before it opens",
)

QUESTIONS = (
    "What is the main advantage of writing a plan down before starting?",
    "Why is it easier to remember something you have explained to someone else?",
    "What should you check first when a laptop will not switch on?",
    "Why do people underestimate how long a task will take?",
    "What makes a good set of instructions easy to follow?",
    "Why is it worth reading the last page of a manual first?",
    "What is the point of a dress rehearsal?",
    "Why do shared calendars fail so often?",
)

WORDS_TO_INCLUDE = (
    ("harbour", "lantern", "rope"), ("kettle", "window", "rain"), ("ledger", "stamp", "drawer"),
    ("compass", "tide", "chart"), ("ladder", "paint", "hinge"), ("thermos", "platform", "timetable"),
)

WORDS_TO_AVOID = (
    ("very", "really"), ("good", "bad"), ("thing", "stuff"), ("just", "simply"),
    ("basically", "obviously"), ("great", "amazing"),
)

PHRASES = (
    "In short:", "Here is the summary:", "Final note:", "To begin with:", "Short answer:",
    "One thing first:",
)

TAIL_PHRASES = (
    "Thank you for reading.", "End of answer.", "That is all.", "Nothing further.",
)

BULLET_SUBJECTS = (
    "before a long drive", "before leaving a rented flat", "before a first day at a new job",
    "before a camping weekend", "before submitting a report", "before a long flight",
    "before hosting a dinner", "before closing a shop for the night",
)

LANG_ITEMS = (
    ("German", "Bahnhof", ["der", "die", "und", "ist"]),
    ("French", "gare", ["le", "la", "et", "est"]),
    ("Spanish", "estacion", ["el", "la", "y", "es"]),
    ("Italian", "stazione", ["il", "la", "e", "un"]),
    ("Portuguese", "estacao", ["o", "a", "e", "de"]),
)


def sample_words(rng, n: int) -> str:
    """A block of *n* filler words, used to build compliant examples."""
    pool = ("harbour", "lantern", "rope", "morning", "quiet", "signal", "ledger", "window",
            "kettle", "platform", "timetable", "hinge", "compass", "ladder", "paint", "tide")
    return " ".join(rng.choice(pool) for _ in range(n))


def build(rng, ir) -> list[dict]:
    items: list[tuple[str, str, str, dict, str]] = []  # (category, difficulty, prompt, answer, example)

    def add(category, difficulty, prompt, rules, example):
        items.append((category, difficulty, prompt, {"all": rules}, example))

    # 1. word-count ranges -------------------------------------------------------------
    for i in range(8):
        lo = rng.choice([15, 20, 25, 30, 40])
        hi = lo + rng.choice([5, 10, 15])
        q = QUESTIONS[i % len(QUESTIONS)]
        add("length", "easy",
            f"{q} Answer in no fewer than {lo} and no more than {hi} words. Do not add a title.",
            [{"rule": "word_count", "min": lo, "max": hi}],
            sample_words(rng, (lo + hi) // 2))

    # 2. exact word count --------------------------------------------------------------
    for i in range(7):
        n = rng.choice([3, 5, 7, 10, 12, 14, 16])
        add("length", "medium",
            f"Describe {TOPICS[i]} in exactly {n} words. Reply with the {n} words and nothing else.",
            [{"rule": "word_count", "min": n, "max": n}],
            sample_words(rng, n))

    # 3. one word / one number ---------------------------------------------------------
    add("format", "easy",
        "What is the capital city of Japan? Reply with exactly one word and no punctuation.",
        [{"rule": "word_count", "min": 1, "max": 1}, {"rule": "not_regex", "pattern": "[.!?,]"}],
        "Tokyo")
    add("format", "easy",
        "How many minutes are there in three hours? Output only the number, with no words and no "
        "units.",
        [{"rule": "is_number"}],
        "180")
    add("format", "medium",
        "How many days are there in a leap year? Reply with only the number, no other characters.",
        [{"rule": "is_number"}, {"rule": "char_count", "min": 1, "max": 4}],
        "366")
    add("format", "easy",
        "Name the largest ocean on Earth. Reply with exactly two words.",
        [{"rule": "word_count", "min": 2, "max": 2}],
        "Pacific Ocean")

    # 4. must include ------------------------------------------------------------------
    for i, trio in enumerate(WORDS_TO_INCLUDE):
        topic = TOPICS[(i + 3) % len(TOPICS)]
        add("inclusion", "medium",
            f"Write two sentences about {topic}. You must use all of these words: "
            f"{', '.join(trio)}.",
            [{"rule": "contains_all", "values": list(trio)},
             {"rule": "sentence_count", "min": 2, "max": 2}],
            f"The {trio[0]} was quiet. A {trio[1]} lay next to the {trio[2]}.")

    # 5. must exclude ------------------------------------------------------------------
    for i, pair in enumerate(WORDS_TO_AVOID):
        q = QUESTIONS[(i + 2) % len(QUESTIONS)]
        add("exclusion", "medium",
            f"{q} Answer in one paragraph without ever using the words '{pair[0]}' or "
            f"'{pair[1]}'.",
            [{"rule": "contains_none", "values": list(pair)},
             {"rule": "paragraph_count", "min": 1, "max": 1}],
            "Writing it down turns a vague intention into a concrete list of steps you can check.")

    add("exclusion", "hard",
        "Explain in three sentences why a checklist helps in an emergency, without using the word "
        "'the' anywhere in your answer.",
        [{"rule": "not_regex", "pattern": "\\bthe\\b", "flags": "i"},
         {"rule": "sentence_count", "min": 3, "max": 3}],
        "A checklist removes guesswork. It keeps steps in order. Nobody has to remember anything "
        "under pressure.")
    add("exclusion", "medium",
        "Summarise why regular backups matter. Write at least 20 words and do not use a single "
        "comma.",
        [{"rule": "no_commas"}, {"rule": "word_count", "min": 20}],
        "A backup is the only thing that turns a total loss into an inconvenience so it deserves "
        "to be tested regularly and not merely configured once and forgotten")

    # 6. casing ------------------------------------------------------------------------
    for i in range(6):
        q = QUESTIONS[(i + 1) % len(QUESTIONS)]
        add("casing", "easy",
            f"{q} Write your entire answer in capital letters, in at most 30 words.",
            [{"rule": "all_caps"}, {"rule": "word_count", "max": 30}],
            "A PLAN ON PAPER CANNOT BE FORGOTTEN AND CAN BE CHECKED OFF ONE STEP AT A TIME")
    for i in range(5):
        add("casing", "medium",
            f"Describe {TOPICS[(i + 6) % len(TOPICS)]} in one sentence, entirely in lower case, "
            f"including the first word.",
            [{"rule": "all_lower"}, {"rule": "sentence_count", "min": 1, "max": 1}],
            "the rain came in sideways and the ropes went dark with water.")

    # 7. bullets and numbered lists ----------------------------------------------------
    for i in range(7):
        n = rng.choice([3, 4, 5, 6])
        add("structure", "medium",
            f"List {n} things to check {BULLET_SUBJECTS[i]}. Reply with exactly {n} bullet points, "
            f"each line starting with '- ' and nothing before it. No introduction, no closing line.",
            [{"rule": "bullet_count", "min": n, "max": n, "only_bullets": True},
             {"rule": "every_line_starts_with", "value": "- "}],
            "\n".join(f"- item {k + 1}" for k in range(n)))
    for i in range(7):
        n = rng.choice([3, 4, 5])
        add("structure", "medium",
            f"Give exactly {n} steps for {TOPICS[(i + 2) % len(TOPICS)]}. Number them '1.', '2.' "
            f"and so on, one per line, with no other text.",
            [{"rule": "numbered_list", "count": n}, {"rule": "line_count", "min": n, "max": n}],
            "\n".join(f"{k + 1}. step {k + 1}" for k in range(n)))

    # 8. line and paragraph structure --------------------------------------------------
    for i in range(6):
        n = rng.choice([2, 3, 4])
        add("structure", "medium",
            f"Write exactly {n} paragraphs about {TOPICS[(i + 9) % len(TOPICS)]}, separated by a "
            f"blank line. Each paragraph must be a single sentence.",
            [{"rule": "paragraph_count", "min": n, "max": n},
             {"rule": "sentence_count", "min": n, "max": n}],
            "\n\n".join(f"Paragraph {k + 1} says something short." for k in range(n)))
    for i in range(5):
        n, m = rng.choice([(3, 4), (4, 5), (5, 3), (6, 4)])
        add("structure", "hard",
            f"Reply with exactly {n} lines. No line may contain more than {m} words, and no two "
            f"lines may be identical. Topic: {TOPICS[(i + 4) % len(TOPICS)]}.",
            [{"rule": "line_count", "min": n, "max": n},
             {"rule": "max_words_per_line", "max": m},
             {"rule": "unique_lines"}],
            "\n".join(" ".join(f"w{k}{j}" for j in range(m)) for k in range(n)))

    # 9. start / end phrases -----------------------------------------------------------
    for i, phrase in enumerate(PHRASES):
        q = QUESTIONS[i % len(QUESTIONS)]
        add("framing", "easy",
            f"{q} Begin your answer with the exact phrase \"{phrase}\" and then continue normally.",
            [{"rule": "starts_with", "value": phrase}, {"rule": "word_count", "min": 8}],
            f"{phrase} a written plan survives the moment you forget it, which is the whole point.")
    for i, phrase in enumerate(TAIL_PHRASES):
        add("framing", "medium",
            f"Describe {TOPICS[(i + 5) % len(TOPICS)]} in 20 to 60 words and finish with the exact "
            f"sentence \"{phrase}\" as the last thing you write.",
            [{"rule": "ends_with", "value": phrase}, {"rule": "word_count", "min": 20, "max": 60}],
            sample_words(rng, 30) + f". {phrase}")
    for i, phrase in enumerate(PHRASES[:3]):
        add("framing", "hard",
            f"Answer this in 25 to 45 words: {QUESTIONS[(i + 3) % len(QUESTIONS)]} Start with "
            f"\"{phrase}\", end with the word \"done\", and use no commas.",
            [{"rule": "starts_with", "value": phrase},
             {"rule": "ends_with", "value": "done"},
             {"rule": "no_commas"},
             {"rule": "word_count", "min": 25, "max": 45}],
            f"{phrase} " + sample_words(rng, 30) + " done")

    # 10. JSON-only --------------------------------------------------------------------
    add("json", "medium",
        "Reply with a single JSON object with the keys \"city\" and \"country\" for the Eiffel "
        "Tower. Output JSON only, with no prose and no code fence.",
        [{"rule": "json_only"},
         {"rule": "json_path_equals", "path": "city", "value": "Paris"},
         {"rule": "json_path_equals", "path": "country", "value": "France"}],
        '{"city": "Paris", "country": "France"}')
    add("json", "medium",
        "Return the numbers 1, 2 and 3 as a JSON array. Output nothing but the JSON.",
        [{"rule": "json_only"}, {"rule": "json_path_equals", "path": "1", "value": 2}],
        "[1, 2, 3]")
    add("json", "hard",
        "Reply with a JSON object shaped {\"ok\": true, \"count\": <number of days in a week>}. "
        "Output JSON only.",
        [{"rule": "json_only"},
         {"rule": "json_path_equals", "path": "ok", "value": True},
         {"rule": "json_path_equals", "path": "count", "value": 7}],
        '{"ok": true, "count": 7}')
    add("json", "hard",
        "Answer with a JSON object with a key \"steps\" holding an array of exactly three strings "
        "describing how to make tea. JSON only, no explanation.",
        [{"rule": "json_only"},
         {"rule": "regex", "pattern": "\"steps\"\\s*:\\s*\\["},
         {"rule": "not_regex", "pattern": "^[^{\\[]+", "flags": "m"}],
        '{"steps": ["Boil water", "Add the tea", "Wait four minutes"]}')

    # 11. exact formats ----------------------------------------------------------------
    add("format", "medium",
        "Report the maximum size as a single line in the form KEY=VALUE, where the key is upper "
        "case with underscores and the value is the number 4096. Nothing else.",
        [{"rule": "regex", "pattern": "^[A-Z][A-Z_]*=4096$", "mode": "fullmatch"}],
        "MAX_SIZE=4096")
    add("format", "medium",
        "Give today's date placeholder in the exact form YYYY-MM-DD using the year 2026, the month "
        "08 and the day 23. Reply with the date and nothing else.",
        [{"rule": "regex", "pattern": "^2026-08-23$", "mode": "fullmatch"}],
        "2026-08-23")
    add("format", "hard",
        "Reply with exactly three comma-separated values on one line: the words alpha, beta and "
        "gamma in that order, with no spaces anywhere.",
        [{"rule": "regex", "pattern": "^alpha,beta,gamma$", "mode": "fullmatch"}],
        "alpha,beta,gamma")
    add("format", "medium",
        "Write the word RESULT followed by a colon, a space, and the number 12. One line only.",
        [{"rule": "regex", "pattern": "^RESULT: 12$", "mode": "fullmatch"}],
        "RESULT: 12")

    # 12. language + keyword -----------------------------------------------------------
    for language, keyword, markers in LANG_ITEMS:
        add("language", "medium",
            f"Answer in {language}: describe a railway station in two sentences. Your answer must "
            f"contain the word \"{keyword}\" and must be written in {language} only.",
            [{"rule": "contains_all", "values": [keyword]},
             {"rule": "contains_any", "values": markers, "min_matches": 1},
             {"rule": "sentence_count", "min": 2, "max": 2}],
            f"{markers[0]} {keyword} ist ruhig. {markers[1]} {keyword} war voll.")

    # 13. repeated keyword -------------------------------------------------------------
    for i, word in enumerate(("atlas", "signal", "harbour", "ledger", "platform")):
        n = rng.choice([3, 4])
        add("inclusion", "hard",
            f"Write a short paragraph of 30 to 70 words about {TOPICS[(i + 7) % len(TOPICS)]} in "
            f"which the word \"{word}\" appears at least {n} times.",
            [{"rule": "word_repeat", "value": word, "min": n},
             {"rule": "word_count", "min": 30, "max": 70}],
            (f"{word} " * n) + sample_words(rng, 40))

    # 14. no-prose constraints ---------------------------------------------------------
    add("format", "hard",
        "Answer with a single word and nothing else, not even punctuation: what colour do you get "
        "when you mix blue and yellow?",
        [{"rule": "word_count", "min": 1, "max": 1},
         {"rule": "not_regex", "pattern": "[^A-Za-z]"}],
        "green")
    add("format", "hard",
        "Reply with exactly five words, all in capitals, with no punctuation at all.",
        [{"rule": "word_count", "min": 5, "max": 5},
         {"rule": "all_caps"},
         {"rule": "not_regex", "pattern": "[^A-Z ]"}],
        "ONE TWO THREE FOUR FIVE")
    add("length", "medium",
        "Summarise the idea of a checklist in at most 60 characters.",
        [{"rule": "char_count", "min": 1, "max": 60}],
        "A written list beats memory under pressure.")
    add("length", "hard",
        "Write a single sentence of between 12 and 18 words that does not contain the letter "
        "sequence 'ing'.",
        [{"rule": "sentence_count", "min": 1, "max": 1},
         {"rule": "word_count", "min": 12, "max": 18},
         {"rule": "not_regex", "pattern": "ing", "flags": "i"}],
        "A short note on paper survives the moment when memory fails you at work.")

    seen = set()
    rows = []
    for category, difficulty, prompt, answer, example in items:
        if prompt in seen:
            raise SystemExit(f"duplicate instruction prompt: {prompt[:70]!r}")
        seen.add(prompt)
        ok, failures = ir.evaluate(answer, example)
        if not ok:
            raise SystemExit(
                f"example for {prompt[:60]!r} fails its own rules: {failures}"
            )
        rows.append(
            {
                "id": f"inst-{len(rows) + 1:04d}",
                "category": category,
                "difficulty": difficulty,
                "prompt": prompt,
                "answer": answer,
                "scorer": "instruction",
                "meta": {"example_pass": example},
            }
        )
    return rows


RULE_SPEC = {
    "shape": "answer = {\"all\": [rule, ...]}; the item is correct only when every rule passes.",
    "applies_to": "the RAW model output — no answer extraction, no trimming. json_only and "
    "json_path_equals strip a surrounding markdown fence first.",
    "definitions": {
        "word": "match of [A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)* — \"don't\" is one word, \"3.5\" is two",
        "line": "text.strip().split('\\n') with blank lines dropped",
        "paragraph": "block from re.split(r'\\n\\s*\\n', text.strip()), empties dropped",
        "sentence": "split on [.!?]+ followed by whitespace or end of text, empties dropped",
        "bullet": "line whose lstrip() starts with a marker followed by a space",
    },
    "rules": {
        "word_count": "{min?, max?} — number of words is within the range (either bound may be absent)",
        "char_count": "{min?, max?} — len(text.strip())",
        "sentence_count": "{min?, max?}",
        "line_count": "{min?, max?}",
        "paragraph_count": "{min?, max?}",
        "bullet_count": "{min?, max?, markers?=['-','*','•'], only_bullets?=false} — when "
        "only_bullets is true every non-empty line must be a bullet",
        "numbered_list": "{count} — the numbers found at line starts must be exactly 1..count in order",
        "contains_all": "{values[], case_sensitive?=false} — every value occurs as a substring",
        "contains_none": "{values[], case_sensitive?=false} — no value occurs",
        "contains_any": "{values[], min_matches?=1, case_sensitive?=false}",
        "starts_with": "{value, case_sensitive?=true} — on text.strip()",
        "ends_with": "{value, case_sensitive?=true} — on text.strip()",
        "all_caps": "{} — at least one letter, and every cased letter is upper case",
        "all_lower": "{} — at least one letter, and every cased letter is lower case",
        "no_commas": "{} — the output contains no ','",
        "regex": "{pattern, flags?='', mode?='search'} — flags is a subset of 'ims'; mode "
        "'fullmatch' matches against text.strip()",
        "not_regex": "{pattern, flags?=''} — the pattern must NOT be found anywhere",
        "json_only": "{} — the whole output parses as JSON once a surrounding fence is removed",
        "json_path_equals": "{path, value} — dotted path (numeric segments index arrays) equals value",
        "is_number": "{} — text.strip() with ',' removed parses as a float",
        "word_repeat": "{value, min?, max?, case_sensitive?=false} — how often the word occurs",
        "max_words_per_line": "{max}",
        "every_line_starts_with": "{value} — every non-empty line, after lstrip()",
        "unique_lines": "{} — no two non-empty lines are identical after stripping",
    },
    "reference_implementation": "datasets/eval-instruction-v1/rules.py "
    "(evaluate(answer, text) -> (bool, failed_rules)); "
    "`python datasets/eval-instruction-v1/rules.py --self-test` must pass.",
}


def main() -> None:
    rng = random.Random(SEED)
    ir = load_rules()
    if ir.self_test():
        raise SystemExit("rules.py self-test failed")
    rows = build(rng, ir)

    used = sorted({rule["rule"] for r in rows for rule in r["answer"]["all"]})
    d = L.dataset_dir(DATASET_ID)
    n = L.write_jsonl(d / "items.jsonl", rows)
    L.write_json(
        d / "dataset.json",
        L.eval_dataset_json(
            DATASET_ID,
            "Instruction-following eval v1",
            "104 items whose instructions are checkable by a program: word and character counts, "
            "required and forbidden words, casing, bullet and numbered-list shape, paragraph and "
            "line structure, opening and closing phrases, exact one-line formats, JSON-only "
            "output, answering in a given language with a required keyword, and combinations of "
            "the above.",
            rows,
            "gen_eval_instruction.py",
            "instruction",
            files=["items.jsonl", "rules.py"],
            seed=SEED,
            rule_dsl=RULE_SPEC,
            rules_used=used,
            notes=[
                "The instruction scorer must evaluate the rule set against the raw output. "
                "Stripping <think> blocks first is allowed and recommended for reasoning models; "
                "nothing else may be normalised away.",
                "meta.example_pass is a compliant answer written by the generator, used to prove "
                "each rule set is satisfiable. It is never sent to the model.",
                "A model that adds a friendly preamble fails most of these items on purpose — "
                "that is the capability being measured.",
            ],
        ),
    )
    L.report(DATASET_ID, n)


if __name__ == "__main__":
    main()
