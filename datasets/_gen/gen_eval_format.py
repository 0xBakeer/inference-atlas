# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Generate `datasets/eval-format-v1/`.

30 short items that measure one thing only: can the model produce *exactly* the
output that was asked for, with nothing around it. Every question is trivially
easy; the point of failure is the preamble ("Sure! The answer is 42."), the unit
that was not requested, or the explanation nobody asked for.

This is the fast smoke test of the suite — 30 items, tiny outputs, seconds to run
— and it is unusually sensitive to chat templates, system prompts and reasoning
settings, which is exactly what makes it useful next to a serving number.

Scoring is `exact` after the shared answer extraction, so a trailing full stop or
a different case is forgiven but an extra sentence is not.

Run: `uv run datasets/_gen/gen_eval_format.py`
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import _lib as L  # noqa: E402

DATASET_ID = "eval-format-v1"

#: (category, difficulty, prompt, answer, accepted aliases)
ITEMS = [
    ("number_only", "easy", "What is 7 times 6? Output only the number.", "42", []),
    ("number_only", "easy", "What is 100 divided by 4? Output only the number, no words.",
     "25", []),
    ("number_only", "easy", "How many bits are in one byte? Reply with the digits only.", "8", []),
    ("number_only", "easy", "What is 19 + 23? Reply with only the result.", "42", []),
    ("number_only", "medium", "How many letters are in the word 'benchmark'? Output only the "
     "number.", "9", []),
    ("number_only", "medium", "How many days does September have? Output only the number.",
     "30", []),
    ("number_only", "medium", "What is the decimal value of the binary number 1101? Output only "
     "the number.", "13", []),
    ("number_only", "medium", "How many minutes are there in two and a half hours? Output only "
     "the number.", "150", []),
    ("one_word", "easy", "Reply with exactly the word OK. Do not write anything else.", "OK", []),
    ("one_word", "easy", "What is the capital city of Japan? Reply with one word only.",
     "Tokyo", []),
    ("one_word", "easy", "What colour do you get when you mix blue and yellow? One word only.",
     "green", []),
    ("one_word", "easy", "What is the opposite of 'hot'? Reply with a single word.", "cold", []),
    ("one_word", "medium", "What is the plural of 'mouse'? Reply with one word only.",
     "mice", []),
    ("one_word", "medium", "Write the word 'atlas' backwards. Reply with the single reversed "
     "word only.", "salta", []),
    ("one_word", "medium", "What is the last word of this sentence: The quick brown fox jumps. "
     "Reply with that word only.", "jumps", []),
    ("one_word", "hard", "Reply with the first three letters of the word 'inference', in lower "
     "case, and nothing else.", "inf", []),
    ("token", "easy", "What is the chemical symbol for iron? Reply with the symbol only.",
     "Fe", []),
    ("token", "easy", "What is the two-letter ISO 3166 country code for Germany? Reply with the "
     "code only.", "DE", []),
    ("token", "medium", "What is the ISO 639-1 language code for Japanese? Reply with the code "
     "only.", "ja", []),
    ("token", "medium", "What is the SI unit symbol for the second? Reply with the symbol only.",
     "s", []),
    ("token", "medium", "Write 255 in hexadecimal, lower case, without any 0x prefix. Reply with "
     "the value only.", "ff", []),
    ("token", "medium", "Write the number 9 as a Roman numeral. Reply with the numeral only.",
     "IX", []),
    ("token", "hard", "Reply with the last character of the word 'model' and nothing else.",
     "l", []),
    ("boolean", "easy", "Is 17 a prime number? Reply with yes or no only.", "yes", []),
    ("boolean", "easy", "Is 10 greater than 9? Reply with only true or false.", "true", []),
    ("boolean", "medium", "Is the Pacific the largest ocean? Answer with one word: yes or no.",
     "yes", []),
    ("boolean", "medium", "Does a leap year have 365 days? Reply with only true or false.",
     "false", []),
    ("pattern", "medium", "What date is the day after 2026-02-28? 2026 is not a leap year. Reply "
     "in YYYY-MM-DD form only.", "2026-03-01", []),
    ("pattern", "medium", "What time is 45 minutes after 23:30? Reply in 24-hour HH:MM form only.",
     "00:15", ["0:15"]),
    ("pattern", "hard", "Write the first letter of the alphabet as a single upper-case letter, "
     "with no punctuation and no explanation.", "A", []),
]


def main() -> None:
    rows = []
    for category, difficulty, prompt, answer, aliases in ITEMS:
        row = {
            "id": f"fmt-{len(rows) + 1:04d}",
            "category": category,
            "difficulty": difficulty,
            "prompt": prompt,
            "answer": answer,
            "scorer": "exact",
        }
        if aliases:
            row["meta"] = {"answer_aliases": aliases}
        rows.append(row)
    assert len(rows) == 30, len(rows)
    assert len({r["prompt"] for r in rows}) == len(rows)

    d = L.dataset_dir(DATASET_ID)
    n = L.write_jsonl(d / "items.jsonl", rows)
    L.write_json(
        d / "dataset.json",
        L.eval_dataset_json(
            DATASET_ID,
            "Format robustness eval v1",
            "30 trivially easy questions with a strict output contract: one word, one number, one "
            "symbol, yes/no, or an exact pattern. It measures whether the model can stop talking, "
            "which is the thing that breaks first when a chat template, a system prompt or a "
            "reasoning mode changes.",
            rows,
            "gen_eval_format.py",
            "exact",
            notes=[
                "The exact scorer compares case-insensitively after collapsing whitespace and "
                "removing surrounding quotes and one trailing '.' or '!'. meta.answer_aliases "
                "lists any other spelling that must be accepted.",
                "Anything beyond the requested token is wrong on purpose: 'The answer is 42' "
                "fails, '42' passes.",
                "A low score here next to a high score on eval-math-v1 usually means the "
                "reasoning trace is leaking into the answer — check whether <think> blocks are "
                "being stripped, and record the reasoning setting in the result.",
                "Refusal-versus-help calibration is deliberately out of scope for this suite.",
            ],
        ),
    )
    L.report(DATASET_ID, n)


if __name__ == "__main__":
    main()
