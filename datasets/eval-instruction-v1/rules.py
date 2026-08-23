"""Reference implementation of the `eval-instruction-v1` rule DSL.

An item's `answer` is a rule set: `{"all": [rule, ...]}`. The item is correct when
every rule passes against the model's **raw** output — no answer extraction, no
fence stripping, no trimming, because the instructions being tested are precisely
about the shape of the output. (The two JSON rules are the exception: they strip a
surrounding markdown fence first, because a fenced JSON block is universally
understood as "here is JSON".)

Self-contained, standard library only, so `bench/` can import it directly:

    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "instruction_rules", "datasets/eval-instruction-v1/rules.py")
    ir = importlib.util.module_from_spec(spec); spec.loader.exec_module(ir)
    ok, failures = ir.evaluate(item["answer"], model_output)

`python datasets/eval-instruction-v1/rules.py --self-test` runs the built-in
examples; `datasets/_gen/check.py` runs the same self-test.

## Shared definitions (normative)

* **words** — matches of `[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*`. "don't" and
  "state-of-the-art" are one word each; "3.5" is two.
* **lines** — `text.strip().split("\\n")`, then lines that are empty after
  `strip()` are dropped.
* **paragraphs** — blocks separated by a blank line: `re.split(r"\\n\\s*\\n", text.strip())`,
  empties dropped.
* **sentences** — split on `[.!?]+` followed by whitespace or end of text, empties
  dropped.
* **bullets** — lines whose `lstrip()` begins with one of `markers` followed by a
  space (default markers: `-`, `*`, `•`).
* **numbered items** — lines matching `^\\s*(\\d+)[.)]\\s+`. The captured numbers
  must be exactly 1..n in order.
"""

from __future__ import annotations

import argparse
import json
import re

WORD_RE = re.compile(r"[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*")
SENTENCE_SPLIT = re.compile(r"[.!?]+(?=\s|$)")
PARAGRAPH_SPLIT = re.compile(r"\n\s*\n")
NUMBERED_RE = re.compile(r"^\s*(\d+)[.)]\s+")
FENCE_RE = re.compile(r"^\s*```[a-zA-Z0-9_-]*\s*\n(.*?)\n?\s*```\s*$", re.DOTALL)

DEFAULT_BULLETS = ("-", "*", "•")


def words(text: str) -> list[str]:
    return WORD_RE.findall(text)


def lines(text: str) -> list[str]:
    return [ln for ln in text.strip().split("\n") if ln.strip()]


def paragraphs(text: str) -> list[str]:
    return [p for p in PARAGRAPH_SPLIT.split(text.strip()) if p.strip()]


def sentences(text: str) -> list[str]:
    return [s.strip() for s in SENTENCE_SPLIT.split(text) if s.strip()]


def strip_fence(text: str) -> str:
    match = FENCE_RE.match(text)
    return match.group(1) if match else text.strip()


def _in_range(value: int, rule: dict) -> bool:
    low = rule.get("min")
    high = rule.get("max")
    if low is not None and value < low:
        return False
    if high is not None and value > high:
        return False
    return True


def _needles(rule: dict, text: str) -> tuple[list[str], str]:
    if rule.get("case_sensitive"):
        return list(rule["values"]), text
    return [v.lower() for v in rule["values"]], text.lower()


def _flags(rule: dict) -> int:
    flags = 0
    for letter in rule.get("flags", ""):
        flags |= {"i": re.IGNORECASE, "m": re.MULTILINE, "s": re.DOTALL}[letter]
    return flags


def check(rule: dict, text: str) -> bool:
    """True when *text* satisfies one rule. Unknown rule names raise."""
    name = rule["rule"]

    if name == "word_count":
        return _in_range(len(words(text)), rule)
    if name == "char_count":
        return _in_range(len(text.strip()), rule)
    if name == "sentence_count":
        return _in_range(len(sentences(text)), rule)
    if name == "line_count":
        return _in_range(len(lines(text)), rule)
    if name == "paragraph_count":
        return _in_range(len(paragraphs(text)), rule)
    if name == "bullet_count":
        prefixes = tuple(m + " " for m in rule.get("markers", DEFAULT_BULLETS))
        all_lines = lines(text)
        found = [ln for ln in all_lines if ln.lstrip().startswith(prefixes)]
        if rule.get("only_bullets") and len(found) != len(all_lines):
            return False
        return _in_range(len(found), rule)
    if name == "numbered_list":
        numbers = []
        for ln in lines(text):
            match = NUMBERED_RE.match(ln)
            if match:
                numbers.append(int(match.group(1)))
        return numbers == list(range(1, rule["count"] + 1))
    if name == "contains_all":
        needles, haystack = _needles(rule, text)
        return all(v in haystack for v in needles)
    if name == "contains_none":
        needles, haystack = _needles(rule, text)
        return not any(v in haystack for v in needles)
    if name == "contains_any":
        needles, haystack = _needles(rule, text)
        return sum(1 for v in needles if v in haystack) >= rule.get("min_matches", 1)
    if name == "starts_with":
        target = rule["value"]
        head = text.strip()
        if not rule.get("case_sensitive", True):
            return head.lower().startswith(target.lower())
        return head.startswith(target)
    if name == "ends_with":
        target = rule["value"]
        tail = text.strip()
        if not rule.get("case_sensitive", True):
            return tail.lower().endswith(target.lower())
        return tail.endswith(target)
    if name == "all_caps":
        letters = [c for c in text if c.isalpha()]
        return bool(letters) and all(c.isupper() for c in letters)
    if name == "all_lower":
        letters = [c for c in text if c.isalpha()]
        return bool(letters) and all(c.islower() for c in letters)
    if name == "no_commas":
        return "," not in text
    if name == "regex":
        pattern = re.compile(rule["pattern"], _flags(rule))
        return bool(pattern.fullmatch(text.strip()) if rule.get("mode") == "fullmatch"
                    else pattern.search(text))
    if name == "not_regex":
        return not re.compile(rule["pattern"], _flags(rule)).search(text)
    if name == "json_only":
        try:
            json.loads(strip_fence(text))
        except (ValueError, TypeError):
            return False
        return True
    if name == "json_path_equals":
        try:
            current = json.loads(strip_fence(text))
        except (ValueError, TypeError):
            return False
        for key in rule["path"].split("."):
            if isinstance(current, list):
                if not key.isdigit() or int(key) >= len(current):
                    return False
                current = current[int(key)]
            elif isinstance(current, dict) and key in current:
                current = current[key]
            else:
                return False
        return current == rule["value"]
    if name == "is_number":
        stripped = text.strip().replace(",", "")
        try:
            float(stripped)
        except ValueError:
            return False
        return True
    if name == "word_repeat":
        target = rule["value"] if rule.get("case_sensitive") else rule["value"].lower()
        found = words(text) if rule.get("case_sensitive") else [w.lower() for w in words(text)]
        return _in_range(sum(1 for w in found if w == target), rule)
    if name == "max_words_per_line":
        return all(len(words(ln)) <= rule["max"] for ln in lines(text))
    if name == "every_line_starts_with":
        return bool(lines(text)) and all(ln.lstrip().startswith(rule["value"]) for ln in lines(text))
    if name == "unique_lines":
        found = [ln.strip() for ln in lines(text)]
        return len(found) == len(set(found))
    raise ValueError(f"unknown rule: {name!r}")


def evaluate(answer: dict, text: str) -> tuple[bool, list[dict]]:
    """Return `(passed, failed_rules)` for one item's rule set."""
    failures = [rule for rule in answer["all"] if not check(rule, text)]
    return not failures, failures


#: (rule set, text that must pass, text that must fail)
SELF_TEST = [
    ({"all": [{"rule": "word_count", "min": 3, "max": 5}]}, "one two three four", "one two"),
    ({"all": [{"rule": "sentence_count", "min": 2, "max": 2}]}, "First one. Second one.", "Only one."),
    ({"all": [{"rule": "line_count", "min": 3, "max": 3}]}, "a\nb\nc", "a\nb"),
    ({"all": [{"rule": "paragraph_count", "min": 2, "max": 2}]}, "one\n\ntwo", "one\ntwo"),
    ({"all": [{"rule": "bullet_count", "min": 2, "max": 2}]}, "- a\n- b", "- a"),
    ({"all": [{"rule": "numbered_list", "count": 3}]}, "1. a\n2. b\n3. c", "1. a\n3. b\n2. c"),
    ({"all": [{"rule": "contains_all", "values": ["alpha", "beta"]}]}, "Alpha and BETA", "alpha only"),
    ({"all": [{"rule": "contains_none", "values": ["sorry"]}]}, "here you go", "Sorry, no"),
    ({"all": [{"rule": "starts_with", "value": "RESULT:"}]}, "RESULT: 4", "the RESULT: 4"),
    ({"all": [{"rule": "ends_with", "value": "Thank you."}]}, "Done. Thank you.", "Thank you. Done."),
    ({"all": [{"rule": "all_caps"}]}, "LOUD AND CLEAR", "Loud and clear"),
    ({"all": [{"rule": "all_lower"}]}, "quiet and clear", "Quiet"),
    ({"all": [{"rule": "no_commas"}]}, "no separators here", "one, two"),
    ({"all": [{"rule": "regex", "pattern": "^[A-Z_]+=.+$", "mode": "fullmatch"}]}, "MAX_SIZE=12", "max=12"),
    ({"all": [{"rule": "not_regex", "pattern": "\\bthe\\b", "flags": "i"}]}, "a cat sat", "the cat sat"),
    ({"all": [{"rule": "json_only"}]}, '{"a": 1}', '{"a": 1} and a note'),
    ({"all": [{"rule": "json_only"}]}, '```json\n{"a": 1}\n```', "not json"),
    ({"all": [{"rule": "json_path_equals", "path": "user.id", "value": 7}]},
     '{"user": {"id": 7}}', '{"user": {"id": 8}}'),
    ({"all": [{"rule": "is_number"}]}, " 42 ", "42 apples"),
    ({"all": [{"rule": "word_repeat", "value": "atlas", "min": 3}]},
     "Atlas atlas ATLAS", "atlas atlas"),
    ({"all": [{"rule": "max_words_per_line", "max": 3}]}, "one two\nthree four", "one two three four"),
    ({"all": [{"rule": "every_line_starts_with", "value": "- "}]}, "- a\n- b", "- a\nb"),
    ({"all": [{"rule": "unique_lines"}]}, "a\nb", "a\na"),
    ({"all": [{"rule": "char_count", "min": 1, "max": 10}]}, "short", "far too long to fit here"),
    ({"all": [{"rule": "contains_any", "values": ["ja", "nein"], "min_matches": 1}]}, "ja", "yes"),
]


def self_test() -> int:
    failed = 0
    for answer, good, bad in SELF_TEST:
        ok, why = evaluate(answer, good)
        if not ok:
            failed += 1
            print(f"FAIL (should pass): {answer} vs {good!r} -> {why}")
        ok, _ = evaluate(answer, bad)
        if ok:
            failed += 1
            print(f"FAIL (should fail): {answer} vs {bad!r}")
    print(f"rules self-test: {len(SELF_TEST) * 2 - failed}/{len(SELF_TEST) * 2} checks passed")
    return failed


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="eval-instruction-v1 rule DSL")
    ap.add_argument("--self-test", action="store_true")
    args = ap.parse_args()
    if args.self_test:
        raise SystemExit(1 if self_test() else 0)
    ap.print_help()
