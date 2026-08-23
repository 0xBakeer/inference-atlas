# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Generate `datasets/eval-code-v1/`.

140 small Python tasks: 120 "write this function" items and 20 "fix this bug"
items. Each carries hidden tests as a block of `assert` statements. The tasks are
hand-authored here (nothing is copied from an existing benchmark), and every one
ships with a reference solution that this generator *runs against the tests*: if a
reference solution fails, generation fails. That makes it impossible to publish a
task whose tests are unsatisfiable or disagree with the docstring.

The reference solution is stored in `answer`. It is never sent to the model — the
prompt contains only the signature and the docstring (plus the buggy code for the
fix items). Scoring is `code_exec`: the model's code and the `tests` string are
concatenated and run in a subprocess.

Run: `uv run datasets/_gen/gen_eval_code.py`
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import _lib as L  # noqa: E402

DATASET_ID = "eval-code-v1"

WRITE_PROMPT = (
    "Write a Python 3 function with exactly this signature and behaviour:\n\n"
    "```python\n{stub}\n```\n\n"
    "Reply with one Python code block containing the complete function and nothing else. "
    "Use only the standard library. Do not print anything and do not include tests."
)

FIX_PROMPT = (
    "The function below has a bug: {symptom}\n\n"
    "```python\n{code}\n```\n\n"
    "Fix it. Reply with one Python code block containing the corrected function and nothing "
    "else. Keep the name and the signature exactly as they are."
)

#: (category, difficulty, name, signature, docstring, reference solution, tests)
TASKS: list[tuple[str, str, str, str, str, str, str]] = []


def T(category, difficulty, name, sig, doc, body, tests):
    TASKS.append((category, difficulty, name, sig, doc, body, tests))


# --------------------------------------------------------------------------------------
# strings (14)
# --------------------------------------------------------------------------------------

T("strings", "easy", "reverse_words", "reverse_words(text: str) -> str",
  "Return *text* with the order of its whitespace-separated words reversed. Runs of\n"
  "    whitespace collapse to a single space and leading/trailing whitespace is dropped.",
  "    return ' '.join(reversed(text.split()))",
  "assert reverse_words('one two three') == 'three two one'\n"
  "assert reverse_words('  padded   words  ') == 'words padded'\n"
  "assert reverse_words('single') == 'single'\n"
  "assert reverse_words('   ') == ''")

T("strings", "easy", "is_palindrome", "is_palindrome(text: str) -> bool",
  "Return True when *text* reads the same forwards and backwards, ignoring case\n"
  "    and every character that is not a letter or a digit.",
  "    cleaned = [c.lower() for c in text if c.isalnum()]\n"
  "    return cleaned == cleaned[::-1]",
  "assert is_palindrome('A man, a plan, a canal: Panama') is True\n"
  "assert is_palindrome('hello') is False\n"
  "assert is_palindrome('') is True\n"
  "assert is_palindrome('Ab1 1bA') is True")

T("strings", "easy", "count_vowels", "count_vowels(text: str) -> int",
  "Return how many of the letters a, e, i, o and u occur in *text*, ignoring case.",
  "    return sum(1 for c in text.lower() if c in 'aeiou')",
  "assert count_vowels('Education') == 5\n"
  "assert count_vowels('rhythm') == 0\n"
  "assert count_vowels('') == 0")

T("strings", "easy", "capitalize_words", "capitalize_words(text: str) -> str",
  "Upper-case the first character of every whitespace-separated word and lower-case\n"
  "    the rest. Whitespace between words is preserved exactly.",
  "    import re\n"
  "    return re.sub(r'\\S+', lambda m: m.group(0)[:1].upper() + m.group(0)[1:].lower(), text)",
  "assert capitalize_words('hello WORLD') == 'Hello World'\n"
  "assert capitalize_words('a  b') == 'A  B'\n"
  "assert capitalize_words('') == ''")

T("strings", "medium", "truncate", "truncate(text: str, limit: int) -> str",
  "Return *text* unchanged when it is at most *limit* characters long. Otherwise cut\n"
  "    it so the result including the trailing '...' is exactly *limit* characters. When\n"
  "    *limit* is 3 or less, return the first *limit* characters of '...'.",
  "    if len(text) <= limit:\n"
  "        return text\n"
  "    if limit <= 3:\n"
  "        return '...'[:limit]\n"
  "    return text[:limit - 3] + '...'",
  "assert truncate('hello', 10) == 'hello'\n"
  "assert truncate('hello world', 8) == 'hello...'\n"
  "assert len(truncate('hello world', 8)) == 8\n"
  "assert truncate('hello', 2) == '..'\n"
  "assert truncate('hello', 5) == 'hello'")

T("strings", "easy", "longest_word", "longest_word(text: str) -> str",
  "Return the longest whitespace-separated word in *text*. On a tie return the one\n"
  "    that occurs first. Return '' for text with no words.",
  "    best = ''\n"
  "    for word in text.split():\n"
  "        if len(word) > len(best):\n"
  "            best = word\n"
  "    return best",
  "assert longest_word('a bb ccc') == 'ccc'\n"
  "assert longest_word('aa bb') == 'aa'\n"
  "assert longest_word('') == ''")

T("strings", "medium", "dedupe_chars", "dedupe_chars(text: str) -> str",
  "Return *text* with later occurrences of a character removed, keeping the first\n"
  "    occurrence in place. The comparison is case sensitive.",
  "    seen = set()\n"
  "    out = []\n"
  "    for c in text:\n"
  "        if c not in seen:\n"
  "            seen.add(c)\n"
  "            out.append(c)\n"
  "    return ''.join(out)",
  "assert dedupe_chars('banana') == 'ban'\n"
  "assert dedupe_chars('AaA') == 'Aa'\n"
  "assert dedupe_chars('') == ''")

T("strings", "medium", "char_frequency", "char_frequency(text: str) -> dict",
  "Return a dict mapping each non-whitespace character of *text* to how often it\n"
  "    occurs. Case is significant.",
  "    counts = {}\n"
  "    for c in text:\n"
  "        if not c.isspace():\n"
  "            counts[c] = counts.get(c, 0) + 1\n"
  "    return counts",
  "assert char_frequency('aab') == {'a': 2, 'b': 1}\n"
  "assert char_frequency('a b') == {'a': 1, 'b': 1}\n"
  "assert char_frequency('') == {}")

T("strings", "medium", "snake_to_camel", "snake_to_camel(name: str) -> str",
  "Convert a snake_case identifier to camelCase. Leading underscores are preserved,\n"
  "    repeated underscores are treated as one separator, and a trailing underscore is\n"
  "    dropped.",
  "    lead = len(name) - len(name.lstrip('_'))\n"
  "    parts = [p for p in name.strip('_').split('_') if p]\n"
  "    if not parts:\n"
  "        return name[:lead]\n"
  "    return '_' * lead + parts[0] + ''.join(p[:1].upper() + p[1:] for p in parts[1:])",
  "assert snake_to_camel('user_id') == 'userId'\n"
  "assert snake_to_camel('__private_field') == '__privateField'\n"
  "assert snake_to_camel('a__b') == 'aB'\n"
  "assert snake_to_camel('plain') == 'plain'\n"
  "assert snake_to_camel('trailing_') == 'trailing'")

T("strings", "hard", "camel_to_snake", "camel_to_snake(name: str) -> str",
  "Convert a camelCase or PascalCase identifier to snake_case. A run of capitals is\n"
  "    treated as one word, except that its last capital starts the next word when a\n"
  "    lower-case letter follows.",
  "    import re\n"
  "    step = re.sub(r'(.)([A-Z][a-z]+)', r'\\1_\\2', name)\n"
  "    return re.sub(r'([a-z0-9])([A-Z])', r'\\1_\\2', step).lower()",
  "assert camel_to_snake('userId') == 'user_id'\n"
  "assert camel_to_snake('HTTPResponse') == 'http_response'\n"
  "assert camel_to_snake('plain') == 'plain'\n"
  "assert camel_to_snake('parseHTTPHeader') == 'parse_http_header'")

T("strings", "easy", "is_anagram", "is_anagram(a: str, b: str) -> bool",
  "Return True when *a* and *b* contain the same letters with the same counts,\n"
  "    ignoring case and every non-letter character.",
  "    def key(s):\n"
  "        return sorted(c for c in s.lower() if c.isalpha())\n"
  "    return key(a) == key(b)",
  "assert is_anagram('Listen', 'Silent') is True\n"
  "assert is_anagram('a gentleman', 'elegant man') is True\n"
  "assert is_anagram('abc', 'abd') is False\n"
  "assert is_anagram('', '') is True")

T("strings", "medium", "compress", "compress(text: str) -> str",
  "Run-length encode *text*: every run of the same character becomes the character\n"
  "    followed by the run length, but runs of length 1 keep no number. Return '' for ''.",
  "    if not text:\n"
  "        return ''\n"
  "    out = []\n"
  "    current, count = text[0], 1\n"
  "    for c in text[1:]:\n"
  "        if c == current:\n"
  "            count += 1\n"
  "        else:\n"
  "            out.append(current + (str(count) if count > 1 else ''))\n"
  "            current, count = c, 1\n"
  "    out.append(current + (str(count) if count > 1 else ''))\n"
  "    return ''.join(out)",
  "assert compress('aaabbc') == 'a3b2c'\n"
  "assert compress('abc') == 'abc'\n"
  "assert compress('') == ''\n"
  "assert compress('aa') == 'a2'")

T("strings", "medium", "caesar", "caesar(text: str, shift: int) -> str",
  "Shift every ASCII letter of *text* by *shift* places through the alphabet, wrapping\n"
  "    around and preserving case. Non-letters are returned unchanged. A negative shift\n"
  "    shifts backwards.",
  "    out = []\n"
  "    for c in text:\n"
  "        if 'a' <= c <= 'z':\n"
  "            out.append(chr((ord(c) - 97 + shift) % 26 + 97))\n"
  "        elif 'A' <= c <= 'Z':\n"
  "            out.append(chr((ord(c) - 65 + shift) % 26 + 65))\n"
  "        else:\n"
  "            out.append(c)\n"
  "    return ''.join(out)",
  "assert caesar('abc', 1) == 'bcd'\n"
  "assert caesar('XYZ', 3) == 'ABC'\n"
  "assert caesar('Hello, World!', 13) == 'Uryyb, Jbeyq!'\n"
  "assert caesar('abc', -1) == 'zab'")

T("strings", "easy", "normalise_whitespace", "normalise_whitespace(text: str) -> str",
  "Collapse every run of whitespace in *text* to a single space and strip the ends.",
  "    return ' '.join(text.split())",
  "assert normalise_whitespace('  a\\t\\tb \\n c ') == 'a b c'\n"
  "assert normalise_whitespace('') == ''\n"
  "assert normalise_whitespace('one') == 'one'")

# --------------------------------------------------------------------------------------
# lists (14)
# --------------------------------------------------------------------------------------

T("lists", "easy", "chunk", "chunk(items: list, size: int) -> list",
  "Split *items* into consecutive lists of at most *size* elements. Raise ValueError\n"
  "    when *size* is not at least 1.",
  "    if size < 1:\n"
  "        raise ValueError('size must be at least 1')\n"
  "    return [items[i:i + size] for i in range(0, len(items), size)]",
  "assert chunk([1, 2, 3, 4, 5], 2) == [[1, 2], [3, 4], [5]]\n"
  "assert chunk([], 3) == []\n"
  "assert chunk([1, 2], 5) == [[1, 2]]\n"
  "try:\n"
  "    chunk([1], 0)\n"
  "    raise AssertionError('expected ValueError')\n"
  "except ValueError:\n"
  "    pass")

T("lists", "easy", "flatten_once", "flatten_once(items: list) -> list",
  "Flatten one level: elements that are lists are spliced in, everything else is kept\n"
  "    as it is. Strings are never flattened.",
  "    out = []\n"
  "    for item in items:\n"
  "        if isinstance(item, list):\n"
  "            out.extend(item)\n"
  "        else:\n"
  "            out.append(item)\n"
  "    return out",
  "assert flatten_once([1, [2, 3], 4]) == [1, 2, 3, 4]\n"
  "assert flatten_once([[1, [2]], 3]) == [1, [2], 3]\n"
  "assert flatten_once(['ab', ['c']]) == ['ab', 'c']\n"
  "assert flatten_once([]) == []")

T("lists", "easy", "rotate", "rotate(items: list, n: int) -> list",
  "Return a new list with *items* rotated *n* places to the left. A negative *n*\n"
  "    rotates right. Rotating an empty list returns an empty list.",
  "    if not items:\n"
  "        return []\n"
  "    n %= len(items)\n"
  "    return items[n:] + items[:n]",
  "assert rotate([1, 2, 3, 4], 1) == [2, 3, 4, 1]\n"
  "assert rotate([1, 2, 3, 4], -1) == [4, 1, 2, 3]\n"
  "assert rotate([1, 2, 3], 3) == [1, 2, 3]\n"
  "assert rotate([], 2) == []")

T("lists", "medium", "second_largest", "second_largest(numbers: list) -> float | None",
  "Return the second largest distinct value in *numbers*, or None when there are\n"
  "    fewer than two distinct values.",
  "    distinct = sorted(set(numbers), reverse=True)\n"
  "    return distinct[1] if len(distinct) > 1 else None",
  "assert second_largest([3, 1, 4, 4, 2]) == 3\n"
  "assert second_largest([5, 5, 5]) is None\n"
  "assert second_largest([]) is None\n"
  "assert second_largest([-1, -2]) == -2")

T("lists", "easy", "running_sum", "running_sum(numbers: list) -> list",
  "Return the list of running totals: element i is the sum of the first i+1 numbers.",
  "    total = 0\n"
  "    out = []\n"
  "    for x in numbers:\n"
  "        total += x\n"
  "        out.append(total)\n"
  "    return out",
  "assert running_sum([1, 2, 3]) == [1, 3, 6]\n"
  "assert running_sum([]) == []\n"
  "assert running_sum([-1, 1]) == [-1, 0]")

T("lists", "easy", "drop_consecutive_duplicates", "drop_consecutive_duplicates(items: list) -> list",
  "Remove elements that are equal to the element directly before them.",
  "    out = []\n"
  "    for item in items:\n"
  "        if not out or item != out[-1]:\n"
  "            out.append(item)\n"
  "    return out",
  "assert drop_consecutive_duplicates([1, 1, 2, 2, 2, 1]) == [1, 2, 1]\n"
  "assert drop_consecutive_duplicates([]) == []\n"
  "assert drop_consecutive_duplicates(['a', 'a']) == ['a']")

T("lists", "easy", "differences", "differences(numbers: list) -> list",
  "Return the differences between consecutive elements: element i is numbers[i+1] -\n"
  "    numbers[i]. A list of fewer than two numbers gives an empty list.",
  "    return [b - a for a, b in zip(numbers, numbers[1:])]",
  "assert differences([1, 4, 9]) == [3, 5]\n"
  "assert differences([5]) == []\n"
  "assert differences([]) == []")

T("lists", "medium", "interleave", "interleave(a: list, b: list) -> list",
  "Alternate elements of *a* and *b*, starting with *a*. When one list is longer, its\n"
  "    remaining elements are appended in order.",
  "    out = []\n"
  "    for i in range(max(len(a), len(b))):\n"
  "        if i < len(a):\n"
  "            out.append(a[i])\n"
  "        if i < len(b):\n"
  "            out.append(b[i])\n"
  "    return out",
  "assert interleave([1, 3], [2, 4]) == [1, 2, 3, 4]\n"
  "assert interleave([1], [2, 3, 4]) == [1, 2, 3, 4]\n"
  "assert interleave([], []) == []")

T("lists", "easy", "partition_evens", "partition_evens(numbers: list) -> tuple",
  "Return a tuple (evens, odds), each preserving the original order.",
  "    evens = [x for x in numbers if x % 2 == 0]\n"
  "    odds = [x for x in numbers if x % 2 != 0]\n"
  "    return evens, odds",
  "assert partition_evens([1, 2, 3, 4]) == ([2, 4], [1, 3])\n"
  "assert partition_evens([]) == ([], [])\n"
  "assert partition_evens([-2, -3]) == ([-2], [-3])")

T("lists", "hard", "top_k_frequent", "top_k_frequent(items: list, k: int) -> list",
  "Return the *k* most frequent elements, most frequent first. Ties are broken by\n"
  "    first appearance in *items*. When *k* exceeds the number of distinct elements,\n"
  "    return all of them.",
  "    order = {}\n"
  "    counts = {}\n"
  "    for i, item in enumerate(items):\n"
  "        counts[item] = counts.get(item, 0) + 1\n"
  "        order.setdefault(item, i)\n"
  "    ranked = sorted(counts, key=lambda x: (-counts[x], order[x]))\n"
  "    return ranked[:k]",
  "assert top_k_frequent(['a', 'b', 'a', 'c', 'b', 'a'], 2) == ['a', 'b']\n"
  "assert top_k_frequent(['x', 'y'], 5) == ['x', 'y']\n"
  "assert top_k_frequent([], 3) == []\n"
  "assert top_k_frequent([1, 2, 2, 1], 1) == [1]")

T("lists", "hard", "longest_increasing_run", "longest_increasing_run(numbers: list) -> list",
  "Return the longest run of strictly increasing consecutive elements. On a tie return\n"
  "    the earliest such run. An empty input gives an empty list.",
  "    best = []\n"
  "    current = []\n"
  "    for x in numbers:\n"
  "        if current and x > current[-1]:\n"
  "            current.append(x)\n"
  "        else:\n"
  "            current = [x]\n"
  "        if len(current) > len(best):\n"
  "            best = list(current)\n"
  "    return best",
  "assert longest_increasing_run([1, 2, 1, 2, 3]) == [1, 2, 3]\n"
  "assert longest_increasing_run([3, 2, 1]) == [3]\n"
  "assert longest_increasing_run([]) == []\n"
  "assert longest_increasing_run([1, 2, 5, 1, 2, 9]) == [1, 2, 5]")

T("lists", "medium", "move_zeros", "move_zeros(numbers: list) -> list",
  "Return a new list with every 0 moved to the end, other elements keeping their\n"
  "    relative order.",
  "    kept = [x for x in numbers if x != 0]\n"
  "    return kept + [0] * (len(numbers) - len(kept))",
  "assert move_zeros([0, 1, 0, 2]) == [1, 2, 0, 0]\n"
  "assert move_zeros([1, 2]) == [1, 2]\n"
  "assert move_zeros([0, 0]) == [0, 0]\n"
  "assert move_zeros([]) == []")

T("lists", "easy", "index_of_min", "index_of_min(numbers: list) -> int",
  "Return the index of the smallest element, the earliest one on a tie. Return -1 for\n"
  "    an empty list.",
  "    if not numbers:\n"
  "        return -1\n"
  "    best = 0\n"
  "    for i, x in enumerate(numbers):\n"
  "        if x < numbers[best]:\n"
  "            best = i\n"
  "    return best",
  "assert index_of_min([3, 1, 2, 1]) == 1\n"
  "assert index_of_min([]) == -1\n"
  "assert index_of_min([5]) == 0")

T("lists", "medium", "split_at_threshold", "split_at_threshold(numbers: list, threshold: float) -> tuple",
  "Return (below, at_or_above): numbers strictly below *threshold* and the rest, each\n"
  "    keeping the original order.",
  "    below = [x for x in numbers if x < threshold]\n"
  "    rest = [x for x in numbers if x >= threshold]\n"
  "    return below, rest",
  "assert split_at_threshold([1, 5, 3, 9], 5) == ([1, 3], [5, 9])\n"
  "assert split_at_threshold([], 0) == ([], [])\n"
  "assert split_at_threshold([2.5, 2.4], 2.5) == ([2.4], [2.5])")

# --------------------------------------------------------------------------------------
# dicts (12)
# --------------------------------------------------------------------------------------

T("dicts", "easy", "invert", "invert(mapping: dict) -> dict",
  "Return a dict with keys and values swapped. When two keys share a value, the key\n"
  "    that comes later in iteration order wins.",
  "    return {v: k for k, v in mapping.items()}",
  "assert invert({'a': 1, 'b': 2}) == {1: 'a', 2: 'b'}\n"
  "assert invert({'a': 1, 'b': 1}) == {1: 'b'}\n"
  "assert invert({}) == {}")

T("dicts", "medium", "merge_sum", "merge_sum(a: dict, b: dict) -> dict",
  "Merge two dicts of numbers by adding the values of shared keys.",
  "    out = dict(a)\n"
  "    for k, v in b.items():\n"
  "        out[k] = out.get(k, 0) + v\n"
  "    return out",
  "assert merge_sum({'x': 1}, {'x': 2, 'y': 3}) == {'x': 3, 'y': 3}\n"
  "assert merge_sum({}, {}) == {}\n"
  "assert merge_sum({'a': 1}, {}) == {'a': 1}")

T("dicts", "easy", "group_by_length", "group_by_length(words: list) -> dict",
  "Group *words* into a dict from word length to the list of words of that length, in\n"
  "    input order.",
  "    out = {}\n"
  "    for word in words:\n"
  "        out.setdefault(len(word), []).append(word)\n"
  "    return out",
  "assert group_by_length(['a', 'bb', 'cc']) == {1: ['a'], 2: ['bb', 'cc']}\n"
  "assert group_by_length([]) == {}\n"
  "assert group_by_length(['']) == {0: ['']}")

T("dicts", "medium", "word_count", "word_count(text: str) -> dict",
  "Count the whitespace-separated words of *text* case-insensitively, ignoring leading\n"
  "    and trailing punctuation of each word (. , ! ? ; :).",
  "    counts = {}\n"
  "    for raw in text.split():\n"
  "        word = raw.strip('.,!?;:').lower()\n"
  "        if word:\n"
  "            counts[word] = counts.get(word, 0) + 1\n"
  "    return counts",
  "assert word_count('The cat, the hat.') == {'the': 2, 'cat': 1, 'hat': 1}\n"
  "assert word_count('') == {}\n"
  "assert word_count('...') == {}")

T("dicts", "medium", "top_n_by_value", "top_n_by_value(mapping: dict, n: int) -> list",
  "Return the *n* keys with the largest values, largest first. Ties are broken by the\n"
  "    key in ascending order.",
  "    return sorted(mapping, key=lambda k: (-mapping[k], k))[:n]",
  "assert top_n_by_value({'a': 3, 'b': 5, 'c': 5}, 2) == ['b', 'c']\n"
  "assert top_n_by_value({'a': 1}, 5) == ['a']\n"
  "assert top_n_by_value({}, 2) == []")

T("dicts", "easy", "filter_values", "filter_values(mapping: dict, minimum: float) -> dict",
  "Return a new dict with only the entries whose value is at least *minimum*.",
  "    return {k: v for k, v in mapping.items() if v >= minimum}",
  "assert filter_values({'a': 1, 'b': 5}, 2) == {'b': 5}\n"
  "assert filter_values({}, 0) == {}\n"
  "assert filter_values({'a': 2}, 2) == {'a': 2}")

T("dicts", "easy", "pairs_to_dict", "pairs_to_dict(pairs: list) -> dict",
  "Build a dict from a list of (key, value) tuples. A later pair overwrites an earlier\n"
  "    one with the same key.",
  "    out = {}\n"
  "    for key, value in pairs:\n"
  "        out[key] = value\n"
  "    return out",
  "assert pairs_to_dict([('a', 1), ('b', 2)]) == {'a': 1, 'b': 2}\n"
  "assert pairs_to_dict([('a', 1), ('a', 2)]) == {'a': 2}\n"
  "assert pairs_to_dict([]) == {}")

T("dicts", "medium", "nested_get", "nested_get(data: dict, path: str, default=None)",
  "Look up a dotted *path* such as 'a.b.c' in nested dicts. Return *default* when any\n"
  "    step is missing or when a step runs into something that is not a dict. An empty\n"
  "    path returns *data*.",
  "    if path == '':\n"
  "        return data\n"
  "    current = data\n"
  "    for key in path.split('.'):\n"
  "        if not isinstance(current, dict) or key not in current:\n"
  "            return default\n"
  "        current = current[key]\n"
  "    return current",
  "assert nested_get({'a': {'b': 1}}, 'a.b') == 1\n"
  "assert nested_get({'a': {'b': 1}}, 'a.c', 0) == 0\n"
  "assert nested_get({'a': 1}, 'a.b', 'x') == 'x'\n"
  "assert nested_get({'a': 1}, '') == {'a': 1}")

T("dicts", "medium", "sum_by_prefix", "sum_by_prefix(mapping: dict, prefix: str) -> float",
  "Add up the values of every entry whose key starts with *prefix*.",
  "    return sum(v for k, v in mapping.items() if k.startswith(prefix))",
  "assert sum_by_prefix({'ab': 1, 'ac': 2, 'b': 4}, 'a') == 3\n"
  "assert sum_by_prefix({'x': 1}, 'y') == 0\n"
  "assert sum_by_prefix({}, '') == 0")

T("dicts", "easy", "most_common_key", "most_common_key(counts: dict) -> str | None",
  "Return the key with the largest value, breaking ties by the smaller key. Return\n"
  "    None for an empty dict.",
  "    if not counts:\n"
  "        return None\n"
  "    return min(counts, key=lambda k: (-counts[k], k))",
  "assert most_common_key({'a': 1, 'b': 3}) == 'b'\n"
  "assert most_common_key({'b': 2, 'a': 2}) == 'a'\n"
  "assert most_common_key({}) is None")

T("dicts", "hard", "dict_diff", "dict_diff(old: dict, new: dict) -> dict",
  "Compare two flat dicts and return {'added': [...], 'removed': [...], 'changed':\n"
  "    [...]}, each a sorted list of keys.",
  "    added = sorted(k for k in new if k not in old)\n"
  "    removed = sorted(k for k in old if k not in new)\n"
  "    changed = sorted(k for k in old if k in new and old[k] != new[k])\n"
  "    return {'added': added, 'removed': removed, 'changed': changed}",
  "assert dict_diff({'a': 1}, {'a': 2}) == {'added': [], 'removed': [], 'changed': ['a']}\n"
  "assert dict_diff({'a': 1}, {'b': 1}) == {'added': ['b'], 'removed': ['a'], 'changed': []}\n"
  "assert dict_diff({}, {}) == {'added': [], 'removed': [], 'changed': []}")

T("dicts", "medium", "update_missing", "update_missing(target: dict, defaults: dict) -> dict",
  "Return a new dict: *target* plus every key of *defaults* that *target* does not\n"
  "    already have. Neither argument is modified.",
  "    out = dict(defaults)\n"
  "    out.update(target)\n"
  "    return out",
  "assert update_missing({'a': 1}, {'a': 9, 'b': 2}) == {'a': 1, 'b': 2}\n"
  "base = {'a': 1}\n"
  "update_missing(base, {'b': 2})\n"
  "assert base == {'a': 1}\n"
  "assert update_missing({}, {}) == {}")

# --------------------------------------------------------------------------------------
# math (14)
# --------------------------------------------------------------------------------------

T("math", "easy", "gcd_of", "gcd_of(a: int, b: int) -> int",
  "Return the greatest common divisor of two non-negative integers, without using\n"
  "    math.gcd. gcd_of(0, 0) is 0.",
  "    while b:\n"
  "        a, b = b, a % b\n"
  "    return a",
  "assert gcd_of(12, 18) == 6\n"
  "assert gcd_of(7, 13) == 1\n"
  "assert gcd_of(0, 5) == 5\n"
  "assert gcd_of(0, 0) == 0")

T("math", "easy", "lcm_of", "lcm_of(a: int, b: int) -> int",
  "Return the least common multiple of two positive integers. Return 0 when either is 0.",
  "    if a == 0 or b == 0:\n"
  "        return 0\n"
  "    x, y = a, b\n"
  "    while y:\n"
  "        x, y = y, x % y\n"
  "    return a * b // x",
  "assert lcm_of(4, 6) == 12\n"
  "assert lcm_of(7, 7) == 7\n"
  "assert lcm_of(0, 3) == 0")

T("math", "medium", "is_prime", "is_prime(n: int) -> bool",
  "Return True when *n* is a prime number. Numbers below 2 are not prime.",
  "    if n < 2:\n"
  "        return False\n"
  "    if n % 2 == 0:\n"
  "        return n == 2\n"
  "    i = 3\n"
  "    while i * i <= n:\n"
  "        if n % i == 0:\n"
  "            return False\n"
  "        i += 2\n"
  "    return True",
  "assert is_prime(2) is True\n"
  "assert is_prime(1) is False\n"
  "assert is_prime(97) is True\n"
  "assert is_prime(9409) is False\n"
  "assert is_prime(-7) is False")

T("math", "easy", "digit_sum", "digit_sum(n: int) -> int",
  "Return the sum of the decimal digits of *n*. Negative numbers use their absolute\n"
  "    value.",
  "    return sum(int(c) for c in str(abs(n)))",
  "assert digit_sum(1234) == 10\n"
  "assert digit_sum(-45) == 9\n"
  "assert digit_sum(0) == 0")

T("math", "easy", "fizz_list", "fizz_list(n: int) -> list",
  "Return the FizzBuzz list for 1..n: multiples of 3 become 'Fizz', of 5 'Buzz', of\n"
  "    both 'FizzBuzz', everything else the number as a string.",
  "    out = []\n"
  "    for i in range(1, n + 1):\n"
  "        if i % 15 == 0:\n"
  "            out.append('FizzBuzz')\n"
  "        elif i % 3 == 0:\n"
  "            out.append('Fizz')\n"
  "        elif i % 5 == 0:\n"
  "            out.append('Buzz')\n"
  "        else:\n"
  "            out.append(str(i))\n"
  "    return out",
  "assert fizz_list(5) == ['1', '2', 'Fizz', '4', 'Buzz']\n"
  "assert fizz_list(15)[-1] == 'FizzBuzz'\n"
  "assert fizz_list(0) == []")

T("math", "easy", "factorial", "factorial(n: int) -> int",
  "Return n! computed iteratively. factorial(0) is 1. Raise ValueError for negative n.",
  "    if n < 0:\n"
  "        raise ValueError('n must not be negative')\n"
  "    result = 1\n"
  "    for i in range(2, n + 1):\n"
  "        result *= i\n"
  "    return result",
  "assert factorial(0) == 1\n"
  "assert factorial(5) == 120\n"
  "try:\n"
  "    factorial(-1)\n"
  "    raise AssertionError('expected ValueError')\n"
  "except ValueError:\n"
  "    pass")

T("math", "easy", "fib_list", "fib_list(n: int) -> list",
  "Return the first *n* Fibonacci numbers starting 0, 1, 1, 2, ...",
  "    out = []\n"
  "    a, b = 0, 1\n"
  "    for _ in range(n):\n"
  "        out.append(a)\n"
  "        a, b = b, a + b\n"
  "    return out",
  "assert fib_list(6) == [0, 1, 1, 2, 3, 5]\n"
  "assert fib_list(0) == []\n"
  "assert fib_list(1) == [0]")

T("math", "medium", "median", "median(numbers: list) -> float",
  "Return the median of *numbers*. For an even count return the mean of the two middle\n"
  "    values. Raise ValueError for an empty list.",
  "    if not numbers:\n"
  "        raise ValueError('numbers must not be empty')\n"
  "    ordered = sorted(numbers)\n"
  "    mid = len(ordered) // 2\n"
  "    if len(ordered) % 2:\n"
  "        return float(ordered[mid])\n"
  "    return (ordered[mid - 1] + ordered[mid]) / 2",
  "assert median([3, 1, 2]) == 2\n"
  "assert median([4, 1, 3, 2]) == 2.5\n"
  "try:\n"
  "    median([])\n"
  "    raise AssertionError('expected ValueError')\n"
  "except ValueError:\n"
  "    pass")

T("math", "easy", "clamp", "clamp(value: float, low: float, high: float) -> float",
  "Return *value* limited to the range [low, high]. Raise ValueError when low > high.",
  "    if low > high:\n"
  "        raise ValueError('low must not exceed high')\n"
  "    return max(low, min(value, high))",
  "assert clamp(5, 0, 3) == 3\n"
  "assert clamp(-1, 0, 3) == 0\n"
  "assert clamp(2, 0, 3) == 2\n"
  "try:\n"
  "    clamp(1, 5, 2)\n"
  "    raise AssertionError('expected ValueError')\n"
  "except ValueError:\n"
  "    pass")

T("math", "hard", "round_to_multiple", "round_to_multiple(value: float, step: float) -> float",
  "Round *value* to the nearest multiple of *step*, rounding halves away from zero.\n"
  "    Raise ValueError when *step* is not positive.",
  "    if step <= 0:\n"
  "        raise ValueError('step must be positive')\n"
  "    import math\n"
  "    quotient = value / step\n"
  "    rounded = math.floor(quotient + 0.5) if quotient >= 0 else math.ceil(quotient - 0.5)\n"
  "    return rounded * step",
  "assert round_to_multiple(7, 5) == 5\n"
  "assert round_to_multiple(7.5, 5) == 10\n"
  "assert round_to_multiple(-7.5, 5) == -10\n"
  "try:\n"
  "    round_to_multiple(1, 0)\n"
  "    raise AssertionError('expected ValueError')\n"
  "except ValueError:\n"
  "    pass")

T("math", "medium", "to_base", "to_base(n: int, base: int) -> str",
  "Render the non-negative integer *n* in *base* (2 to 16) using digits 0-9 then\n"
  "    lower-case a-f. to_base(0, b) is '0'. Raise ValueError for a base outside 2..16.",
  "    if not 2 <= base <= 16:\n"
  "        raise ValueError('base must be between 2 and 16')\n"
  "    if n == 0:\n"
  "        return '0'\n"
  "    digits = '0123456789abcdef'\n"
  "    out = []\n"
  "    while n:\n"
  "        out.append(digits[n % base])\n"
  "        n //= base\n"
  "    return ''.join(reversed(out))",
  "assert to_base(10, 2) == '1010'\n"
  "assert to_base(255, 16) == 'ff'\n"
  "assert to_base(0, 8) == '0'\n"
  "try:\n"
  "    to_base(5, 1)\n"
  "    raise AssertionError('expected ValueError')\n"
  "except ValueError:\n"
  "    pass")

T("math", "easy", "is_perfect_square", "is_perfect_square(n: int) -> bool",
  "Return True when *n* is the square of a whole number. Negative numbers are never\n"
  "    perfect squares.",
  "    if n < 0:\n"
  "        return False\n"
  "    root = int(n ** 0.5)\n"
  "    for candidate in (root - 1, root, root + 1):\n"
  "        if candidate >= 0 and candidate * candidate == n:\n"
  "            return True\n"
  "    return False",
  "assert is_perfect_square(0) is True\n"
  "assert is_perfect_square(144) is True\n"
  "assert is_perfect_square(145) is False\n"
  "assert is_perfect_square(-4) is False")

T("math", "hard", "count_divisors", "count_divisors(n: int) -> int",
  "Return how many positive divisors the positive integer *n* has, including 1 and n.\n"
  "    Raise ValueError when n is not positive.",
  "    if n < 1:\n"
  "        raise ValueError('n must be positive')\n"
  "    count = 0\n"
  "    i = 1\n"
  "    while i * i <= n:\n"
  "        if n % i == 0:\n"
  "            count += 2 if i * i != n else 1\n"
  "        i += 1\n"
  "    return count",
  "assert count_divisors(1) == 1\n"
  "assert count_divisors(36) == 9\n"
  "assert count_divisors(97) == 2\n"
  "try:\n"
  "    count_divisors(0)\n"
  "    raise AssertionError('expected ValueError')\n"
  "except ValueError:\n"
  "    pass")

T("math", "medium", "percent_change", "percent_change(old: float, new: float) -> float | None",
  "Return the percentage change from *old* to *new*. Return None when *old* is 0.",
  "    if old == 0:\n"
  "        return None\n"
  "    return (new - old) / old * 100",
  "assert percent_change(100, 150) == 50\n"
  "assert percent_change(100, 50) == -50\n"
  "assert percent_change(0, 5) is None")

# --------------------------------------------------------------------------------------
# parsing (12)
# --------------------------------------------------------------------------------------

T("parsing", "medium", "parse_kv", "parse_kv(text: str) -> dict",
  "Parse 'a=1;b=2' into {'a': '1', 'b': '2'}. Empty segments are skipped, surrounding\n"
  "    whitespace is stripped from keys and values, and a segment with no '=' is ignored.\n"
  "    Only the first '=' separates key from value.",
  "    out = {}\n"
  "    for part in text.split(';'):\n"
  "        if '=' not in part:\n"
  "            continue\n"
  "        key, _, value = part.partition('=')\n"
  "        key = key.strip()\n"
  "        if key:\n"
  "            out[key] = value.strip()\n"
  "    return out",
  "assert parse_kv('a=1;b=2') == {'a': '1', 'b': '2'}\n"
  "assert parse_kv(' a = 1 ;;junk; b=x=y') == {'a': '1', 'b': 'x=y'}\n"
  "assert parse_kv('') == {}")

T("parsing", "hard", "parse_duration", "parse_duration(text: str) -> int",
  "Parse a duration such as '1h30m10s' into whole seconds. Units must appear in the\n"
  "    order h, m, s and each at most once; any of them may be missing. Raise ValueError\n"
  "    for an empty string or anything that does not match.",
  "    import re\n"
  "    match = re.fullmatch(r'(?:(\\d+)h)?(?:(\\d+)m)?(?:(\\d+)s)?', text)\n"
  "    if not text or not match or not any(match.groups()):\n"
  "        raise ValueError('bad duration: ' + text)\n"
  "    h, m, s = (int(g) if g else 0 for g in match.groups())\n"
  "    return h * 3600 + m * 60 + s",
  "assert parse_duration('1h30m10s') == 5410\n"
  "assert parse_duration('45s') == 45\n"
  "assert parse_duration('2h') == 7200\n"
  "for bad in ('', '10', '30m1h', 'abc'):\n"
  "    try:\n"
  "        parse_duration(bad)\n"
  "        raise AssertionError('expected ValueError for ' + repr(bad))\n"
  "    except ValueError:\n"
  "        pass")

T("parsing", "hard", "parse_csv_line", "parse_csv_line(line: str) -> list",
  "Split one CSV line into fields. A field may be wrapped in double quotes, in which\n"
  "    case it may contain commas, and a doubled quote inside means a literal quote.\n"
  "    Unquoted fields are taken as they are. An empty line gives ['']. ",
  "    fields = []\n"
  "    current = []\n"
  "    in_quotes = False\n"
  "    i = 0\n"
  "    while i < len(line):\n"
  "        c = line[i]\n"
  "        if in_quotes:\n"
  "            if c == '\"':\n"
  "                if i + 1 < len(line) and line[i + 1] == '\"':\n"
  "                    current.append('\"')\n"
  "                    i += 1\n"
  "                else:\n"
  "                    in_quotes = False\n"
  "            else:\n"
  "                current.append(c)\n"
  "        elif c == '\"':\n"
  "            in_quotes = True\n"
  "        elif c == ',':\n"
  "            fields.append(''.join(current))\n"
  "            current = []\n"
  "        else:\n"
  "            current.append(c)\n"
  "        i += 1\n"
  "    fields.append(''.join(current))\n"
  "    return fields",
  "assert parse_csv_line('a,b,c') == ['a', 'b', 'c']\n"
  "assert parse_csv_line('a,\"b,c\",d') == ['a', 'b,c', 'd']\n"
  "assert parse_csv_line('\"he said \"\"hi\"\"\"') == ['he said \"hi\"']\n"
  "assert parse_csv_line('') == ['']\n"
  "assert parse_csv_line('a,,b') == ['a', '', 'b']")

T("parsing", "medium", "parse_version", "parse_version(text: str) -> tuple",
  "Parse 'MAJOR.MINOR.PATCH' into a tuple of three ints. Missing components default to\n"
  "    0, so '1.2' is (1, 2, 0). Raise ValueError when a component is not a number or\n"
  "    when there are more than three.",
  "    parts = text.split('.')\n"
  "    if len(parts) > 3:\n"
  "        raise ValueError('too many components')\n"
  "    numbers = []\n"
  "    for part in parts:\n"
  "        if not part.isdigit():\n"
  "            raise ValueError('bad component: ' + part)\n"
  "        numbers.append(int(part))\n"
  "    while len(numbers) < 3:\n"
  "        numbers.append(0)\n"
  "    return tuple(numbers)",
  "assert parse_version('1.2.3') == (1, 2, 3)\n"
  "assert parse_version('1.2') == (1, 2, 0)\n"
  "for bad in ('1.2.3.4', '1.x', ''):\n"
  "    try:\n"
  "        parse_version(bad)\n"
  "        raise AssertionError('expected ValueError')\n"
  "    except ValueError:\n"
  "        pass")

T("parsing", "medium", "parse_query", "parse_query(query: str) -> dict",
  "Parse 'a=1&b=2&a=3' into {'a': ['1', '3'], 'b': ['2']}. A key with no '=' maps to\n"
  "    ['']. Empty segments are skipped. No percent-decoding is required.",
  "    out = {}\n"
  "    for part in query.split('&'):\n"
  "        if not part:\n"
  "            continue\n"
  "        key, sep, value = part.partition('=')\n"
  "        out.setdefault(key, []).append(value if sep else '')\n"
  "    return out",
  "assert parse_query('a=1&b=2&a=3') == {'a': ['1', '3'], 'b': ['2']}\n"
  "assert parse_query('flag') == {'flag': ['']}\n"
  "assert parse_query('') == {}\n"
  "assert parse_query('a=') == {'a': ['']}")

T("parsing", "hard", "parse_ini_section", "parse_ini_section(text: str, section: str) -> dict",
  "Return the key/value pairs of one [section] of an INI-style text. Lines starting\n"
  "    with '#' or ';' and blank lines are ignored, keys and values are stripped, and a\n"
  "    missing section gives {}.",
  "    out = {}\n"
  "    current = None\n"
  "    for raw in text.splitlines():\n"
  "        line = raw.strip()\n"
  "        if not line or line[0] in '#;':\n"
  "            continue\n"
  "        if line.startswith('[') and line.endswith(']'):\n"
  "            current = line[1:-1].strip()\n"
  "            continue\n"
  "        if current == section and '=' in line:\n"
  "            key, _, value = line.partition('=')\n"
  "            out[key.strip()] = value.strip()\n"
  "    return out",
  "text = '[a]\\nx = 1\\n# comment\\n\\n[b]\\ny=2\\n'\n"
  "assert parse_ini_section(text, 'a') == {'x': '1'}\n"
  "assert parse_ini_section(text, 'b') == {'y': '2'}\n"
  "assert parse_ini_section(text, 'c') == {}")

T("parsing", "medium", "extract_numbers", "extract_numbers(text: str) -> list",
  "Return every integer or decimal number in *text* as a float, in order. A leading\n"
  "    minus sign belongs to the number.",
  "    import re\n"
  "    return [float(m) for m in re.findall(r'-?\\d+(?:\\.\\d+)?', text)]",
  "assert extract_numbers('a 1 b -2.5 c') == [1.0, -2.5]\n"
  "assert extract_numbers('none here') == []\n"
  "assert extract_numbers('3.14') == [3.14]")

T("parsing", "easy", "parse_bool", "parse_bool(text: str) -> bool",
  "Parse a human-written boolean: 'true', 'yes', 'y', 'on' and '1' are True; 'false',\n"
  "    'no', 'n', 'off' and '0' are False. Case and surrounding whitespace are ignored.\n"
  "    Anything else raises ValueError.",
  "    value = text.strip().lower()\n"
  "    if value in ('true', 'yes', 'y', 'on', '1'):\n"
  "        return True\n"
  "    if value in ('false', 'no', 'n', 'off', '0'):\n"
  "        return False\n"
  "    raise ValueError('not a boolean: ' + text)",
  "assert parse_bool(' YES ') is True\n"
  "assert parse_bool('0') is False\n"
  "try:\n"
  "    parse_bool('maybe')\n"
  "    raise AssertionError('expected ValueError')\n"
  "except ValueError:\n"
  "    pass")

T("parsing", "medium", "split_name", "split_name(full: str) -> tuple",
  "Split a full name into (first, last). With one word the last name is ''. With more\n"
  "    than two words everything between first and last belongs to the first name.",
  "    parts = full.split()\n"
  "    if not parts:\n"
  "        return ('', '')\n"
  "    if len(parts) == 1:\n"
  "        return (parts[0], '')\n"
  "    return (' '.join(parts[:-1]), parts[-1])",
  "assert split_name('Ada Lovelace') == ('Ada', 'Lovelace')\n"
  "assert split_name('Prince') == ('Prince', '')\n"
  "assert split_name('Jean Luc Picard') == ('Jean Luc', 'Picard')\n"
  "assert split_name('  ') == ('', '')")

T("parsing", "hard", "parse_range_list", "parse_range_list(text: str) -> list",
  "Expand '1-3,5,7-8' into [1, 2, 3, 5, 7, 8]. Whitespace is ignored, the result is\n"
  "    sorted and free of duplicates, and a reversed range such as '5-3' raises\n"
  "    ValueError, as does any non-numeric part.",
  "    values = set()\n"
  "    for part in text.replace(' ', '').split(','):\n"
  "        if not part:\n"
  "            continue\n"
  "        if '-' in part[1:]:\n"
  "            start, _, end = part.partition('-')\n"
  "            if not start.isdigit() or not end.isdigit():\n"
  "                raise ValueError('bad range: ' + part)\n"
  "            if int(start) > int(end):\n"
  "                raise ValueError('reversed range: ' + part)\n"
  "            values.update(range(int(start), int(end) + 1))\n"
  "        else:\n"
  "            if not part.isdigit():\n"
  "                raise ValueError('bad number: ' + part)\n"
  "            values.add(int(part))\n"
  "    return sorted(values)",
  "assert parse_range_list('1-3,5,7-8') == [1, 2, 3, 5, 7, 8]\n"
  "assert parse_range_list('2, 1') == [1, 2]\n"
  "assert parse_range_list('') == []\n"
  "for bad in ('5-3', 'a-b', '1,x'):\n"
  "    try:\n"
  "        parse_range_list(bad)\n"
  "        raise AssertionError('expected ValueError')\n"
  "    except ValueError:\n"
  "        pass")

T("parsing", "medium", "parse_hhmm", "parse_hhmm(text: str) -> int",
  "Parse a 24-hour 'HH:MM' string into minutes since midnight. Raise ValueError for a\n"
  "    malformed string or an out-of-range hour or minute.",
  "    parts = text.split(':')\n"
  "    if len(parts) != 2 or not all(p.isdigit() and len(p) == 2 for p in parts):\n"
  "        raise ValueError('bad time: ' + text)\n"
  "    hours, minutes = int(parts[0]), int(parts[1])\n"
  "    if hours > 23 or minutes > 59:\n"
  "        raise ValueError('out of range: ' + text)\n"
  "    return hours * 60 + minutes",
  "assert parse_hhmm('00:00') == 0\n"
  "assert parse_hhmm('13:45') == 825\n"
  "for bad in ('24:00', '1:00', '12:60', 'noon'):\n"
  "    try:\n"
  "        parse_hhmm(bad)\n"
  "        raise AssertionError('expected ValueError')\n"
  "    except ValueError:\n"
  "        pass")

T("parsing", "medium", "strip_comments", "strip_comments(text: str) -> str",
  "Remove '#' comments from every line, keeping the code before the '#' with trailing\n"
  "    whitespace stripped. Lines that become empty are dropped entirely. A '#' inside a\n"
  "    single-quoted string still counts as a comment for this simplified version.",
  "    out = []\n"
  "    for line in text.splitlines():\n"
  "        code = line.split('#', 1)[0].rstrip()\n"
  "        if code.strip():\n"
  "            out.append(code)\n"
  "    return '\\n'.join(out)",
  "assert strip_comments('a = 1  # set a\\n# only comment\\nb = 2') == 'a = 1\\nb = 2'\n"
  "assert strip_comments('') == ''\n"
  "assert strip_comments('   # x') == ''")

# --------------------------------------------------------------------------------------
# recursion (10)
# --------------------------------------------------------------------------------------

T("recursion", "medium", "sum_nested", "sum_nested(items: list) -> float",
  "Add up every number in an arbitrarily nested list of numbers and lists.",
  "    total = 0\n"
  "    for item in items:\n"
  "        total += sum_nested(item) if isinstance(item, list) else item\n"
  "    return total",
  "assert sum_nested([1, [2, [3, 4]], 5]) == 15\n"
  "assert sum_nested([]) == 0\n"
  "assert sum_nested([[], [[]]]) == 0")

T("recursion", "medium", "flatten_deep", "flatten_deep(items: list) -> list",
  "Flatten an arbitrarily nested list into a flat list, preserving order. Strings are\n"
  "    never flattened.",
  "    out = []\n"
  "    for item in items:\n"
  "        if isinstance(item, list):\n"
  "            out.extend(flatten_deep(item))\n"
  "        else:\n"
  "            out.append(item)\n"
  "    return out",
  "assert flatten_deep([1, [2, [3, [4]]]]) == [1, 2, 3, 4]\n"
  "assert flatten_deep(['ab', ['cd']]) == ['ab', 'cd']\n"
  "assert flatten_deep([]) == []")

T("recursion", "easy", "power", "power(base: float, exponent: int) -> float",
  "Compute base ** exponent recursively for a non-negative integer exponent, without\n"
  "    using the ** operator or pow().",
  "    if exponent == 0:\n"
  "        return 1\n"
  "    half = power(base, exponent // 2)\n"
  "    return half * half * (base if exponent % 2 else 1)",
  "assert power(2, 10) == 1024\n"
  "assert power(5, 0) == 1\n"
  "assert power(3, 3) == 27")

T("recursion", "medium", "count_leaves", "count_leaves(node: dict) -> int",
  "Count the leaves of a tree where a node is {'children': [...]}. A node with no\n"
  "    children, or with an empty list, is a leaf.",
  "    children = node.get('children') or []\n"
  "    if not children:\n"
  "        return 1\n"
  "    return sum(count_leaves(child) for child in children)",
  "assert count_leaves({}) == 1\n"
  "assert count_leaves({'children': [{}, {}]}) == 2\n"
  "assert count_leaves({'children': [{'children': [{}, {}]}, {}]}) == 3")

T("recursion", "medium", "binary_search_rec", "binary_search_rec(items: list, target) -> int",
  "Return the index of *target* in the sorted list *items* using recursion, or -1 when\n"
  "    it is absent. Any matching index is acceptable when there are duplicates.",
  "    def go(lo, hi):\n"
  "        if lo > hi:\n"
  "            return -1\n"
  "        mid = (lo + hi) // 2\n"
  "        if items[mid] == target:\n"
  "            return mid\n"
  "        if items[mid] < target:\n"
  "            return go(mid + 1, hi)\n"
  "        return go(lo, mid - 1)\n"
  "    return go(0, len(items) - 1)",
  "assert binary_search_rec([1, 3, 5, 7], 5) == 2\n"
  "assert binary_search_rec([1, 3, 5], 4) == -1\n"
  "assert binary_search_rec([], 1) == -1\n"
  "assert binary_search_rec([2], 2) == 0")

T("recursion", "hard", "collatz_steps", "collatz_steps(n: int) -> int",
  "Count how many steps it takes to reach 1: even numbers are halved, odd numbers\n"
  "    become 3n+1. collatz_steps(1) is 0. Raise ValueError for n below 1.",
  "    if n < 1:\n"
  "        raise ValueError('n must be at least 1')\n"
  "    if n == 1:\n"
  "        return 0\n"
  "    return 1 + collatz_steps(n // 2 if n % 2 == 0 else 3 * n + 1)",
  "assert collatz_steps(1) == 0\n"
  "assert collatz_steps(6) == 8\n"
  "assert collatz_steps(27) == 111\n"
  "try:\n"
  "    collatz_steps(0)\n"
  "    raise AssertionError('expected ValueError')\n"
  "except ValueError:\n"
  "    pass")

T("recursion", "medium", "tree_depth", "tree_depth(node: dict) -> int",
  "Return the depth of a tree where a node is {'children': [...]}. A single node has\n"
  "    depth 1.",
  "    children = node.get('children') or []\n"
  "    if not children:\n"
  "        return 1\n"
  "    return 1 + max(tree_depth(child) for child in children)",
  "assert tree_depth({}) == 1\n"
  "assert tree_depth({'children': [{}]}) == 2\n"
  "assert tree_depth({'children': [{}, {'children': [{'children': [{}]}]}]}) == 4")

T("recursion", "easy", "reverse_rec", "reverse_rec(text: str) -> str",
  "Reverse a string recursively, without slicing the whole string with [::-1].",
  "    if len(text) <= 1:\n"
  "        return text\n"
  "    return reverse_rec(text[1:]) + text[0]",
  "assert reverse_rec('abc') == 'cba'\n"
  "assert reverse_rec('') == ''\n"
  "assert reverse_rec('a') == 'a'")

T("recursion", "hard", "count_paths", "count_paths(rows: int, cols: int) -> int",
  "Count the shortest paths across a grid of *rows* by *cols* blocks when only moves\n"
  "    east and north are allowed. A grid with a zero dimension has exactly one path.",
  "    from functools import lru_cache\n"
  "    @lru_cache(maxsize=None)\n"
  "    def go(r, c):\n"
  "        if r == 0 or c == 0:\n"
  "            return 1\n"
  "        return go(r - 1, c) + go(r, c - 1)\n"
  "    return go(rows, cols)",
  "assert count_paths(2, 2) == 6\n"
  "assert count_paths(0, 5) == 1\n"
  "assert count_paths(3, 3) == 20")

T("recursion", "medium", "gcd_rec", "gcd_rec(a: int, b: int) -> int",
  "Return the greatest common divisor of two non-negative integers using recursion.",
  "    return a if b == 0 else gcd_rec(b, a % b)",
  "assert gcd_rec(48, 18) == 6\n"
  "assert gcd_rec(5, 0) == 5\n"
  "assert gcd_rec(0, 0) == 0")

# --------------------------------------------------------------------------------------
# algorithms (12)
# --------------------------------------------------------------------------------------

T("algorithms", "hard", "binary_search", "binary_search(items: list, target) -> int",
  "Return the index of the FIRST occurrence of *target* in the sorted list *items*, or\n"
  "    -1 when it is absent.",
  "    lo, hi = 0, len(items) - 1\n"
  "    found = -1\n"
  "    while lo <= hi:\n"
  "        mid = (lo + hi) // 2\n"
  "        if items[mid] == target:\n"
  "            found = mid\n"
  "            hi = mid - 1\n"
  "        elif items[mid] < target:\n"
  "            lo = mid + 1\n"
  "        else:\n"
  "            hi = mid - 1\n"
  "    return found",
  "assert binary_search([1, 2, 2, 2, 3], 2) == 1\n"
  "assert binary_search([1, 3], 2) == -1\n"
  "assert binary_search([], 1) == -1")

T("algorithms", "medium", "merge_sorted", "merge_sorted(a: list, b: list) -> list",
  "Merge two already sorted lists into one sorted list, without calling sorted() or\n"
  "    .sort().",
  "    out = []\n"
  "    i = j = 0\n"
  "    while i < len(a) and j < len(b):\n"
  "        if a[i] <= b[j]:\n"
  "            out.append(a[i])\n"
  "            i += 1\n"
  "        else:\n"
  "            out.append(b[j])\n"
  "            j += 1\n"
  "    out.extend(a[i:])\n"
  "    out.extend(b[j:])\n"
  "    return out",
  "assert merge_sorted([1, 3], [2, 4]) == [1, 2, 3, 4]\n"
  "assert merge_sorted([], [1]) == [1]\n"
  "assert merge_sorted([1, 1], [1]) == [1, 1, 1]")

T("algorithms", "hard", "two_sum", "two_sum(numbers: list, target: int) -> tuple | None",
  "Return the indices (i, j) with i < j of two numbers that add up to *target*, or None\n"
  "    when there is no such pair. Return the pair with the smallest j, and for that j\n"
  "    the smallest i.",
  "    seen = {}\n"
  "    for j, x in enumerate(numbers):\n"
  "        need = target - x\n"
  "        if need in seen:\n"
  "            return (seen[need], j)\n"
  "        seen.setdefault(x, j)\n"
  "    return None",
  "assert two_sum([2, 7, 11, 15], 9) == (0, 1)\n"
  "assert two_sum([3, 2, 4], 6) == (1, 2)\n"
  "assert two_sum([1, 2], 100) is None\n"
  "assert two_sum([], 0) is None")

T("algorithms", "hard", "max_subarray_sum", "max_subarray_sum(numbers: list) -> int",
  "Return the largest sum of any non-empty contiguous slice of *numbers*. Raise\n"
  "    ValueError for an empty list.",
  "    if not numbers:\n"
  "        raise ValueError('numbers must not be empty')\n"
  "    best = current = numbers[0]\n"
  "    for x in numbers[1:]:\n"
  "        current = max(x, current + x)\n"
  "        best = max(best, current)\n"
  "    return best",
  "assert max_subarray_sum([-2, 1, -3, 4, -1, 2, 1, -5, 4]) == 6\n"
  "assert max_subarray_sum([-5, -2, -9]) == -2\n"
  "assert max_subarray_sum([3]) == 3\n"
  "try:\n"
  "    max_subarray_sum([])\n"
  "    raise AssertionError('expected ValueError')\n"
  "except ValueError:\n"
  "    pass")

T("algorithms", "medium", "is_balanced", "is_balanced(text: str) -> bool",
  "Return True when the brackets (), [] and {} in *text* are correctly nested and\n"
  "    closed. Other characters are ignored.",
  "    pairs = {')': '(', ']': '[', '}': '{'}\n"
  "    stack = []\n"
  "    for c in text:\n"
  "        if c in '([{':\n"
  "            stack.append(c)\n"
  "        elif c in pairs:\n"
  "            if not stack or stack.pop() != pairs[c]:\n"
  "                return False\n"
  "    return not stack",
  "assert is_balanced('a(b[c]{d})') is True\n"
  "assert is_balanced('(]') is False\n"
  "assert is_balanced(')(') is False\n"
  "assert is_balanced('') is True\n"
  "assert is_balanced('(') is False")

T("algorithms", "easy", "longest_common_prefix", "longest_common_prefix(words: list) -> str",
  "Return the longest string that starts every word in *words*. An empty list gives ''.",
  "    if not words:\n"
  "        return ''\n"
  "    prefix = words[0]\n"
  "    for word in words[1:]:\n"
  "        while not word.startswith(prefix):\n"
  "            prefix = prefix[:-1]\n"
  "            if not prefix:\n"
  "                return ''\n"
  "    return prefix",
  "assert longest_common_prefix(['flower', 'flow', 'flight']) == 'fl'\n"
  "assert longest_common_prefix(['dog', 'cat']) == ''\n"
  "assert longest_common_prefix([]) == ''\n"
  "assert longest_common_prefix(['same', 'same']) == 'same'")

T("algorithms", "hard", "roman_to_int", "roman_to_int(text: str) -> int",
  "Convert an upper-case Roman numeral from I to MMMCMXCIX into an integer. Raise\n"
  "    ValueError when a character is not a Roman digit or the string is empty.",
  "    values = {'I': 1, 'V': 5, 'X': 10, 'L': 50, 'C': 100, 'D': 500, 'M': 1000}\n"
  "    if not text:\n"
  "        raise ValueError('empty numeral')\n"
  "    total = 0\n"
  "    previous = 0\n"
  "    for c in reversed(text):\n"
  "        if c not in values:\n"
  "            raise ValueError('bad digit: ' + c)\n"
  "        value = values[c]\n"
  "        total += -value if value < previous else value\n"
  "        previous = max(previous, value)\n"
  "    return total",
  "assert roman_to_int('IX') == 9\n"
  "assert roman_to_int('MCMXCIV') == 1994\n"
  "assert roman_to_int('III') == 3\n"
  "for bad in ('', 'ABC'):\n"
  "    try:\n"
  "        roman_to_int(bad)\n"
  "        raise AssertionError('expected ValueError')\n"
  "    except ValueError:\n"
  "        pass")

T("algorithms", "medium", "int_to_roman", "int_to_roman(number: int) -> str",
  "Convert an integer from 1 to 3999 into an upper-case Roman numeral. Raise ValueError\n"
  "    outside that range.",
  "    if not 1 <= number <= 3999:\n"
  "        raise ValueError('out of range')\n"
  "    table = ((1000, 'M'), (900, 'CM'), (500, 'D'), (400, 'CD'), (100, 'C'), (90, 'XC'),\n"
  "             (50, 'L'), (40, 'XL'), (10, 'X'), (9, 'IX'), (5, 'V'), (4, 'IV'), (1, 'I'))\n"
  "    out = []\n"
  "    for value, symbol in table:\n"
  "        while number >= value:\n"
  "            out.append(symbol)\n"
  "            number -= value\n"
  "    return ''.join(out)",
  "assert int_to_roman(9) == 'IX'\n"
  "assert int_to_roman(1994) == 'MCMXCIV'\n"
  "assert int_to_roman(3999) == 'MMMCMXCIX'\n"
  "try:\n"
  "    int_to_roman(0)\n"
  "    raise AssertionError('expected ValueError')\n"
  "except ValueError:\n"
  "    pass")

T("algorithms", "medium", "insertion_sort", "insertion_sort(numbers: list) -> list",
  "Return a sorted copy of *numbers* using insertion sort. Do not call sorted() or\n"
  "    .sort(), and do not modify the input.",
  "    out = []\n"
  "    for x in numbers:\n"
  "        i = len(out)\n"
  "        while i > 0 and out[i - 1] > x:\n"
  "            i -= 1\n"
  "        out.insert(i, x)\n"
  "    return out",
  "assert insertion_sort([3, 1, 2]) == [1, 2, 3]\n"
  "source = [2, 1]\n"
  "insertion_sort(source)\n"
  "assert source == [2, 1]\n"
  "assert insertion_sort([]) == []")

T("algorithms", "easy", "find_duplicates", "find_duplicates(items: list) -> list",
  "Return the values that occur more than once, each once, in order of first repeat.",
  "    seen = set()\n"
  "    reported = set()\n"
  "    out = []\n"
  "    for item in items:\n"
  "        if item in seen and item not in reported:\n"
  "            out.append(item)\n"
  "            reported.add(item)\n"
  "        seen.add(item)\n"
  "    return out",
  "assert find_duplicates([1, 2, 1, 3, 2, 1]) == [1, 2]\n"
  "assert find_duplicates([1, 2]) == []\n"
  "assert find_duplicates([]) == []")

T("algorithms", "hard", "group_anagrams", "group_anagrams(words: list) -> list",
  "Group words that are anagrams of each other, ignoring case. Return a list of groups\n"
  "    sorted by the first word of each group; inside a group keep the input order.",
  "    groups = {}\n"
  "    for word in words:\n"
  "        key = ''.join(sorted(word.lower()))\n"
  "        groups.setdefault(key, []).append(word)\n"
  "    return sorted(groups.values(), key=lambda g: g[0])",
  "assert group_anagrams(['eat', 'tea', 'tan', 'ate']) == [['eat', 'tea', 'ate'], ['tan']]\n"
  "assert group_anagrams([]) == []\n"
  "assert group_anagrams(['ab', 'BA']) == [['ab', 'BA']]")

T("algorithms", "hard", "min_coins", "min_coins(amount: int, coins: list) -> int",
  "Return the fewest coins that add up to *amount*, or -1 when it cannot be made. Coins\n"
  "    may be used any number of times. min_coins(0, ...) is 0.",
  "    best = [0] + [float('inf')] * amount\n"
  "    for value in range(1, amount + 1):\n"
  "        for coin in coins:\n"
  "            if coin <= value and best[value - coin] + 1 < best[value]:\n"
  "                best[value] = best[value - coin] + 1\n"
  "    return -1 if best[amount] == float('inf') else int(best[amount])",
  "assert min_coins(11, [1, 2, 5]) == 3\n"
  "assert min_coins(3, [2]) == -1\n"
  "assert min_coins(0, [1]) == 0\n"
  "assert min_coins(6, [1, 3, 4]) == 2")

# --------------------------------------------------------------------------------------
# edge cases (12)
# --------------------------------------------------------------------------------------

T("edge_cases", "easy", "safe_divide", "safe_divide(a: float, b: float, default: float = 0.0) -> float",
  "Divide *a* by *b* and return *default* when *b* is 0.",
  "    return default if b == 0 else a / b",
  "assert safe_divide(6, 3) == 2\n"
  "assert safe_divide(1, 0) == 0.0\n"
  "assert safe_divide(1, 0, -1) == -1")

T("edge_cases", "easy", "first_or", "first_or(items: list, default=None)",
  "Return the first element of *items*, or *default* when the list is empty.",
  "    return items[0] if items else default",
  "assert first_or([1, 2]) == 1\n"
  "assert first_or([]) is None\n"
  "assert first_or([], 'x') == 'x'\n"
  "assert first_or([None], 'x') is None")

T("edge_cases", "medium", "at_index", "at_index(items: list, index: int, default=None)",
  "Return items[index], supporting negative indices, and *default* when the index is\n"
  "    out of range.",
  "    try:\n"
  "        return items[index]\n"
  "    except IndexError:\n"
  "        return default",
  "assert at_index([1, 2, 3], 1) == 2\n"
  "assert at_index([1, 2, 3], -1) == 3\n"
  "assert at_index([1], 5, 'x') == 'x'\n"
  "assert at_index([], 0) is None")

T("edge_cases", "easy", "mean_or_zero", "mean_or_zero(numbers: list) -> float",
  "Return the arithmetic mean of *numbers*, or 0.0 for an empty list.",
  "    return sum(numbers) / len(numbers) if numbers else 0.0",
  "assert mean_or_zero([1, 2, 3]) == 2\n"
  "assert mean_or_zero([]) == 0.0\n"
  "assert mean_or_zero([2.5]) == 2.5")

T("edge_cases", "medium", "to_int", "to_int(value, default: int = 0) -> int",
  "Convert *value* to an int, returning *default* when it cannot be converted. Strings\n"
  "    with surrounding whitespace are accepted; floats are truncated toward zero;\n"
  "    booleans convert to 1 and 0.",
  "    try:\n"
  "        if isinstance(value, str):\n"
  "            return int(value.strip())\n"
  "        return int(value)\n"
  "    except (TypeError, ValueError):\n"
  "        return default",
  "assert to_int(' 42 ') == 42\n"
  "assert to_int('x', -1) == -1\n"
  "assert to_int(3.9) == 3\n"
  "assert to_int(None, 7) == 7\n"
  "assert to_int(True) == 1")

T("edge_cases", "easy", "take", "take(items: list, n: int) -> list",
  "Return the first *n* elements. A negative *n* gives an empty list, and an *n* larger\n"
  "    than the list gives the whole list.",
  "    return items[:max(n, 0)]",
  "assert take([1, 2, 3], 2) == [1, 2]\n"
  "assert take([1], 5) == [1]\n"
  "assert take([1, 2], -1) == []")

T("edge_cases", "easy", "last_n", "last_n(items: list, n: int) -> list",
  "Return the last *n* elements in their original order. A negative or zero *n* gives\n"
  "    an empty list.",
  "    return items[len(items) - n:] if n > 0 else []",
  "assert last_n([1, 2, 3], 2) == [2, 3]\n"
  "assert last_n([1], 5) == [1]\n"
  "assert last_n([1, 2], 0) == []")

T("edge_cases", "easy", "is_blank", "is_blank(text) -> bool",
  "Return True when *text* is None, empty, or only whitespace.",
  "    return text is None or text.strip() == ''",
  "assert is_blank(None) is True\n"
  "assert is_blank('   ') is True\n"
  "assert is_blank(' x ') is False\n"
  "assert is_blank('') is True")

T("edge_cases", "medium", "drop_none", "drop_none(items: list) -> list",
  "Remove every None from the list, keeping the order. Falsy values that are not None,\n"
  "    such as 0 and '', are kept.",
  "    return [x for x in items if x is not None]",
  "assert drop_none([1, None, 2]) == [1, 2]\n"
  "assert drop_none([0, None, '']) == [0, '']\n"
  "assert drop_none([]) == []")

T("edge_cases", "easy", "split_or_empty", "split_or_empty(text: str, sep: str = ',') -> list",
  "Split *text* on *sep* and strip each part, dropping parts that are empty after\n"
  "    stripping. An empty or whitespace-only input gives an empty list.",
  "    return [part.strip() for part in text.split(sep) if part.strip()]",
  "assert split_or_empty('a, b') == ['a', 'b']\n"
  "assert split_or_empty('') == []\n"
  "assert split_or_empty(' , ,a') == ['a']\n"
  "assert split_or_empty('a|b', '|') == ['a', 'b']")

T("edge_cases", "easy", "ensure_list", "ensure_list(value) -> list",
  "Wrap *value* in a list unless it already is one. None becomes an empty list, and a\n"
  "    string is treated as a single value, not a sequence.",
  "    if value is None:\n"
  "        return []\n"
  "    if isinstance(value, list):\n"
  "        return value\n"
  "    return [value]",
  "assert ensure_list(None) == []\n"
  "assert ensure_list('ab') == ['ab']\n"
  "assert ensure_list([1]) == [1]\n"
  "assert ensure_list(0) == [0]")

T("edge_cases", "medium", "clamp_slice", "clamp_slice(items: list, start: int, end: int) -> list",
  "Return items[start:end] with the bounds clamped into range and with start never\n"
  "    greater than end. Negative bounds are clamped to 0, not counted from the end.",
  "    size = len(items)\n"
  "    lo = min(max(start, 0), size)\n"
  "    hi = min(max(end, 0), size)\n"
  "    if lo > hi:\n"
  "        return []\n"
  "    return items[lo:hi]",
  "assert clamp_slice([1, 2, 3], 1, 2) == [2]\n"
  "assert clamp_slice([1, 2, 3], -5, 99) == [1, 2, 3]\n"
  "assert clamp_slice([1, 2, 3], 2, 1) == []\n"
  "assert clamp_slice([], 0, 1) == []")

# --------------------------------------------------------------------------------------
# second pass (20) — one more per area, mostly at the harder end
# --------------------------------------------------------------------------------------

T("strings", "medium", "mask_email", "mask_email(email: str) -> str",
  "Mask an email address: keep the first character of the local part, replace the\n"
  "    rest of it with one '*' per character, and leave the domain untouched. A string\n"
  "    with no '@', or with an empty local part, is returned unchanged.",
  "    local, sep, domain = email.partition('@')\n"
  "    if not sep or not local:\n"
  "        return email\n"
  "    return local[0] + '*' * (len(local) - 1) + '@' + domain",
  "assert mask_email('ines@example.org') == 'i***@example.org'\n"
  "assert mask_email('a@b.c') == 'a@b.c'\n"
  "assert mask_email('nope') == 'nope'\n"
  "assert mask_email('@x.y') == '@x.y'")

T("strings", "easy", "starts_with_any", "starts_with_any(text: str, prefixes: list) -> bool",
  "Return True when *text* starts with any of the given prefixes. An empty list of\n"
  "    prefixes gives False; an empty prefix string counts as a match.",
  "    return any(text.startswith(p) for p in prefixes)",
  "assert starts_with_any('atlas', ['at', 'zz']) is True\n"
  "assert starts_with_any('atlas', ['zz']) is False\n"
  "assert starts_with_any('atlas', []) is False\n"
  "assert starts_with_any('atlas', ['']) is True")

T("strings", "hard", "wrap_text", "wrap_text(text: str, width: int) -> list",
  "Wrap *text* into lines of at most *width* characters, breaking only at spaces and\n"
  "    never splitting a word. A word longer than *width* gets a line of its own. Runs of\n"
  "    whitespace collapse; empty input gives an empty list. Raise ValueError when width\n"
  "    is below 1.",
  "    if width < 1:\n"
  "        raise ValueError('width must be at least 1')\n"
  "    lines, current = [], ''\n"
  "    for word in text.split():\n"
  "        candidate = f'{current} {word}' if current else word\n"
  "        if len(candidate) <= width or not current:\n"
  "            current = candidate\n"
  "        else:\n"
  "            lines.append(current)\n"
  "            current = word\n"
  "    if current:\n"
  "        lines.append(current)\n"
  "    return lines",
  "assert wrap_text('one two three', 7) == ['one two', 'three']\n"
  "assert wrap_text('extraordinarily long', 5) == ['extraordinarily', 'long']\n"
  "assert wrap_text('', 5) == []\n"
  "try:\n"
  "    wrap_text('x', 0)\n"
  "    raise AssertionError('expected ValueError')\n"
  "except ValueError:\n"
  "    pass")

T("lists", "medium", "zip_fill", "zip_fill(a: list, b: list, fill=None) -> list",
  "Pair up elements of *a* and *b*, padding the shorter list with *fill* so the result\n"
  "    is as long as the longer input.",
  "    size = max(len(a), len(b))\n"
  "    return [(a[i] if i < len(a) else fill, b[i] if i < len(b) else fill)\n"
  "            for i in range(size)]",
  "assert zip_fill([1, 2], ['a']) == [(1, 'a'), (2, None)]\n"
  "assert zip_fill([], [1], 0) == [(0, 1)]\n"
  "assert zip_fill([], []) == []")

T("lists", "easy", "count_occurrences", "count_occurrences(items: list, value) -> int",
  "Count how many elements of *items* are equal to *value*.",
  "    return sum(1 for item in items if item == value)",
  "assert count_occurrences([1, 2, 1], 1) == 2\n"
  "assert count_occurrences([], 1) == 0\n"
  "assert count_occurrences(['a'], 'b') == 0")

T("lists", "hard", "rank", "rank(numbers: list) -> list",
  "Return the competition rank of each number: the largest gets rank 1, equal values\n"
  "    share a rank, and the next distinct value skips the ranks that were used up\n"
  "    (10, 8, 8, 5 gives 1, 2, 2, 4).",
  "    ordered = sorted(set(numbers), reverse=True)\n"
  "    position = {}\n"
  "    seen = 0\n"
  "    for value in ordered:\n"
  "        position[value] = seen + 1\n"
  "        seen += numbers.count(value)\n"
  "    return [position[x] for x in numbers]",
  "assert rank([10, 8, 8, 5]) == [1, 2, 2, 4]\n"
  "assert rank([1, 2, 3]) == [3, 2, 1]\n"
  "assert rank([]) == []\n"
  "assert rank([7, 7]) == [1, 1]")

T("dicts", "hard", "deep_merge", "deep_merge(a: dict, b: dict) -> dict",
  "Merge two nested dicts recursively and return a new dict. Where both sides hold a\n"
  "    dict the merge continues one level deeper; otherwise the value from *b* wins.\n"
  "    Neither input is modified.",
  "    out = dict(a)\n"
  "    for key, value in b.items():\n"
  "        if isinstance(value, dict) and isinstance(out.get(key), dict):\n"
  "            out[key] = deep_merge(out[key], value)\n"
  "        else:\n"
  "            out[key] = value\n"
  "    return out",
  "assert deep_merge({'a': {'x': 1}}, {'a': {'y': 2}}) == {'a': {'x': 1, 'y': 2}}\n"
  "assert deep_merge({'a': 1}, {'a': {'b': 2}}) == {'a': {'b': 2}}\n"
  "base = {'a': {'x': 1}}\n"
  "deep_merge(base, {'a': {'y': 2}})\n"
  "assert base == {'a': {'x': 1}}")

T("dicts", "easy", "keys_with_value", "keys_with_value(mapping: dict, value) -> list",
  "Return the keys whose value equals *value*, sorted ascending.",
  "    return sorted(k for k, v in mapping.items() if v == value)",
  "assert keys_with_value({'b': 1, 'a': 1, 'c': 2}, 1) == ['a', 'b']\n"
  "assert keys_with_value({}, 1) == []\n"
  "assert keys_with_value({'a': 1}, 2) == []")

T("dicts", "medium", "invert_multi", "invert_multi(mapping: dict) -> dict",
  "Invert a dict, collecting the keys that share a value into a sorted list.",
  "    out = {}\n"
  "    for key, value in mapping.items():\n"
  "        out.setdefault(value, []).append(key)\n"
  "    return {k: sorted(v) for k, v in out.items()}",
  "assert invert_multi({'b': 1, 'a': 1, 'c': 2}) == {1: ['a', 'b'], 2: ['c']}\n"
  "assert invert_multi({}) == {}\n"
  "assert invert_multi({'x': 'y'}) == {'y': ['x']}")

T("math", "medium", "average_of_top", "average_of_top(numbers: list, k: int) -> float",
  "Return the mean of the *k* largest values. When *k* exceeds the length, average\n"
  "    everything. Raise ValueError when *k* is below 1 or the list is empty.",
  "    if k < 1 or not numbers:\n"
  "        raise ValueError('k must be at least 1 and numbers must not be empty')\n"
  "    top = sorted(numbers, reverse=True)[:k]\n"
  "    return sum(top) / len(top)",
  "assert average_of_top([1, 5, 3], 2) == 4\n"
  "assert average_of_top([2], 9) == 2\n"
  "for bad in (0, -1):\n"
  "    try:\n"
  "        average_of_top([1], bad)\n"
  "        raise AssertionError('expected ValueError')\n"
  "    except ValueError:\n"
  "        pass")

T("math", "hard", "prime_factors", "prime_factors(n: int) -> list",
  "Return the prime factors of *n* in ascending order, repeating a factor as often as\n"
  "    it divides. prime_factors(1) is []. Raise ValueError for n below 1.",
  "    if n < 1:\n"
  "        raise ValueError('n must be positive')\n"
  "    factors = []\n"
  "    divisor = 2\n"
  "    while divisor * divisor <= n:\n"
  "        while n % divisor == 0:\n"
  "            factors.append(divisor)\n"
  "            n //= divisor\n"
  "        divisor += 1\n"
  "    if n > 1:\n"
  "        factors.append(n)\n"
  "    return factors",
  "assert prime_factors(12) == [2, 2, 3]\n"
  "assert prime_factors(97) == [97]\n"
  "assert prime_factors(1) == []\n"
  "try:\n"
  "    prime_factors(0)\n"
  "    raise AssertionError('expected ValueError')\n"
  "except ValueError:\n"
  "    pass")

T("parsing", "medium", "parse_size", "parse_size(text: str) -> int",
  "Parse a size such as '1.5MB' or '512' into whole bytes, rounded down. Suffixes are\n"
  "    B, KB, MB and GB, case insensitive, each 1024 times the one before; a missing\n"
  "    suffix means bytes. Raise ValueError for anything else.",
  "    import re\n"
  "    match = re.fullmatch(r'\\s*(\\d+(?:\\.\\d+)?)\\s*([KMG]?B?)\\s*', text, re.IGNORECASE)\n"
  "    if not match:\n"
  "        raise ValueError('bad size: ' + text)\n"
  "    factors = {'': 1, 'B': 1, 'K': 1024, 'KB': 1024, 'M': 1024 ** 2, 'MB': 1024 ** 2,\n"
  "               'G': 1024 ** 3, 'GB': 1024 ** 3}\n"
  "    return int(float(match.group(1)) * factors[match.group(2).upper()])",
  "assert parse_size('512') == 512\n"
  "assert parse_size('1.5MB') == 1572864\n"
  "assert parse_size(' 2 kb ') == 2048\n"
  "for bad in ('', 'MB', '5 TB'):\n"
  "    try:\n"
  "        parse_size(bad)\n"
  "        raise AssertionError('expected ValueError for ' + repr(bad))\n"
  "    except ValueError:\n"
  "        pass")

T("parsing", "hard", "parse_flags", "parse_flags(argv: list) -> dict",
  "Parse a simple argument list. '--name=value' and '--name value' both map name to\n"
  "    the value; a flag with no value maps to True. Leading dashes are stripped from\n"
  "    the key. Arguments that are not flags are ignored.",
  "    out = {}\n"
  "    i = 0\n"
  "    while i < len(argv):\n"
  "        token = argv[i]\n"
  "        if token.startswith('-'):\n"
  "            key, sep, value = token.lstrip('-').partition('=')\n"
  "            if sep:\n"
  "                out[key] = value\n"
  "            elif i + 1 < len(argv) and not argv[i + 1].startswith('-'):\n"
  "                out[key] = argv[i + 1]\n"
  "                i += 1\n"
  "            else:\n"
  "                out[key] = True\n"
  "        i += 1\n"
  "    return out",
  "assert parse_flags(['--a=1', '--b', '2', '-c']) == {'a': '1', 'b': '2', 'c': True}\n"
  "assert parse_flags([]) == {}\n"
  "assert parse_flags(['plain']) == {}\n"
  "assert parse_flags(['--x', '--y']) == {'x': True, 'y': True}")

T("recursion", "medium", "deep_get_path", "deep_get_path(data, keys: list, default=None)",
  "Walk a nested structure recursively following *keys*, returning *default* when a\n"
  "    step is missing or the current value is not a dict. An empty key list returns the\n"
  "    data itself.",
  "    if not keys:\n"
  "        return data\n"
  "    if not isinstance(data, dict) or keys[0] not in data:\n"
  "        return default\n"
  "    return deep_get_path(data[keys[0]], keys[1:], default)",
  "assert deep_get_path({'a': {'b': {'c': 3}}}, ['a', 'b', 'c']) == 3\n"
  "assert deep_get_path({'a': 1}, ['a', 'b'], 'x') == 'x'\n"
  "assert deep_get_path({'a': 1}, []) == {'a': 1}\n"
  "assert deep_get_path({}, ['a']) is None")

T("recursion", "hard", "permutations_of", "permutations_of(items: list) -> list",
  "Return every permutation of *items* as a list of tuples, sorted ascending, using\n"
  "    recursion and without itertools. An empty input gives [()].",
  "    if not items:\n"
  "        return [()]\n"
  "    out = []\n"
  "    for i, item in enumerate(items):\n"
  "        rest = items[:i] + items[i + 1:]\n"
  "        out.extend((item, *tail) for tail in permutations_of(rest))\n"
  "    return sorted(out)",
  "assert permutations_of([1, 2]) == [(1, 2), (2, 1)]\n"
  "assert permutations_of([]) == [()]\n"
  "assert len(permutations_of([1, 2, 3])) == 6")

T("recursion", "easy", "count_down", "count_down(n: int) -> list",
  "Return [n, n-1, ..., 1] using recursion. A non-positive n gives an empty list.",
  "    if n < 1:\n"
  "        return []\n"
  "    return [n] + count_down(n - 1)",
  "assert count_down(3) == [3, 2, 1]\n"
  "assert count_down(0) == []\n"
  "assert count_down(-2) == []")

T("algorithms", "medium", "is_subsequence", "is_subsequence(needle: str, haystack: str) -> bool",
  "Return True when every character of *needle* appears in *haystack* in the same\n"
  "    order, not necessarily next to each other. An empty needle is always a\n"
  "    subsequence.",
  "    it = iter(haystack)\n"
  "    return all(c in it for c in needle)",
  "assert is_subsequence('ace', 'abcde') is True\n"
  "assert is_subsequence('aec', 'abcde') is False\n"
  "assert is_subsequence('', 'abc') is True\n"
  "assert is_subsequence('a', '') is False")

T("algorithms", "hard", "lcs_length", "lcs_length(a: str, b: str) -> int",
  "Return the length of the longest common subsequence of two strings.",
  "    previous = [0] * (len(b) + 1)\n"
  "    for x in a:\n"
  "        current = [0]\n"
  "        for j, y in enumerate(b):\n"
  "            current.append(previous[j] + 1 if x == y else max(previous[j + 1], current[j]))\n"
  "        previous = current\n"
  "    return previous[-1]",
  "assert lcs_length('abcde', 'ace') == 3\n"
  "assert lcs_length('abc', 'def') == 0\n"
  "assert lcs_length('', 'abc') == 0\n"
  "assert lcs_length('aab', 'azb') == 2")

T("edge_cases", "medium", "normalise_bool", "normalise_bool(value, default: bool = False) -> bool",
  "Coerce a value to a boolean: real booleans pass through, numbers use 0 as False,\n"
  "    strings accept true/yes/y/on/1 and false/no/n/off/0 case insensitively, and\n"
  "    anything else (including None) returns *default*.",
  "    if isinstance(value, bool):\n"
  "        return value\n"
  "    if isinstance(value, (int, float)):\n"
  "        return value != 0\n"
  "    if isinstance(value, str):\n"
  "        text = value.strip().lower()\n"
  "        if text in ('true', 'yes', 'y', 'on', '1'):\n"
  "            return True\n"
  "        if text in ('false', 'no', 'n', 'off', '0'):\n"
  "            return False\n"
  "    return default",
  "assert normalise_bool('YES') is True\n"
  "assert normalise_bool(0) is False\n"
  "assert normalise_bool(None, True) is True\n"
  "assert normalise_bool('maybe') is False\n"
  "assert normalise_bool(True) is True")

T("edge_cases", "easy", "first_matching", "first_matching(items: list, prefix: str)",
  "Return the first string in *items* that starts with *prefix*, or None when there is\n"
  "    none. Non-string elements are skipped.",
  "    for item in items:\n"
  "        if isinstance(item, str) and item.startswith(prefix):\n"
  "            return item\n"
  "    return None",
  "assert first_matching(['ab', 'ac'], 'a') == 'ab'\n"
  "assert first_matching([1, 'bc'], 'b') == 'bc'\n"
  "assert first_matching([], 'a') is None\n"
  "assert first_matching(['zz'], 'a') is None")


# --------------------------------------------------------------------------------------
# fix-the-bug items (20)
# --------------------------------------------------------------------------------------

#: (difficulty, name, symptom, buggy code, fixed code, tests)
BUGS: list[tuple[str, str, str, str, str, str]] = []


def B(difficulty, name, symptom, buggy, fixed, tests):
    BUGS.append((difficulty, name, symptom, buggy, fixed, tests))


B("easy", "average", "it raises ZeroDivisionError on an empty list, where it should return 0.0.",
  "def average(numbers):\n"
  "    \"\"\"Return the mean of *numbers*, or 0.0 when the list is empty.\"\"\"\n"
  "    return sum(numbers) / len(numbers)",
  "def average(numbers):\n"
  "    \"\"\"Return the mean of *numbers*, or 0.0 when the list is empty.\"\"\"\n"
  "    if not numbers:\n"
  "        return 0.0\n"
  "    return sum(numbers) / len(numbers)",
  "assert average([1, 2, 3]) == 2\n"
  "assert average([]) == 0.0")

B("easy", "count_up", "the last value is missing: count_up(3) should end at 3.",
  "def count_up(n):\n"
  "    \"\"\"Return [1, 2, ..., n].\"\"\"\n"
  "    return list(range(1, n))",
  "def count_up(n):\n"
  "    \"\"\"Return [1, 2, ..., n].\"\"\"\n"
  "    return list(range(1, n + 1))",
  "assert count_up(3) == [1, 2, 3]\n"
  "assert count_up(0) == []\n"
  "assert count_up(1) == [1]")

B("medium", "add_item", "every call shares the same list, so items from earlier calls keep showing up.",
  "def add_item(item, bucket=[]):\n"
  "    \"\"\"Append *item* to *bucket* and return it. A fresh call starts a fresh list.\"\"\"\n"
  "    bucket.append(item)\n"
  "    return bucket",
  "def add_item(item, bucket=None):\n"
  "    \"\"\"Append *item* to *bucket* and return it. A fresh call starts a fresh list.\"\"\"\n"
  "    if bucket is None:\n"
  "        bucket = []\n"
  "    bucket.append(item)\n"
  "    return bucket",
  "assert add_item(1) == [1]\n"
  "assert add_item(2) == [2]\n"
  "assert add_item(3, [0]) == [0, 3]")

B("medium", "remove_evens", "it skips elements, because the list is modified while it is being iterated.",
  "def remove_evens(numbers):\n"
  "    \"\"\"Return *numbers* with every even value removed, keeping order.\"\"\"\n"
  "    for x in numbers:\n"
  "        if x % 2 == 0:\n"
  "            numbers.remove(x)\n"
  "    return numbers",
  "def remove_evens(numbers):\n"
  "    \"\"\"Return *numbers* with every even value removed, keeping order.\"\"\"\n"
  "    return [x for x in numbers if x % 2 != 0]",
  "assert remove_evens([1, 2, 2, 3]) == [1, 3]\n"
  "assert remove_evens([2, 4]) == []\n"
  "assert remove_evens([]) == []")

B("easy", "starts_with_vowel", "upper-case words are reported as not starting with a vowel.",
  "def starts_with_vowel(word):\n"
  "    \"\"\"Return True when *word* starts with a, e, i, o or u, ignoring case.\"\"\"\n"
  "    return word[:1] in 'aeiou'",
  "def starts_with_vowel(word):\n"
  "    \"\"\"Return True when *word* starts with a, e, i, o or u, ignoring case.\"\"\"\n"
  "    return word[:1].lower() in 'aeiou' and word != ''",
  "assert starts_with_vowel('Apple') is True\n"
  "assert starts_with_vowel('pear') is False\n"
  "assert starts_with_vowel('') is False")

B("medium", "percentage", "it always returns 0 for small counts, because of integer division.",
  "def percentage(part, whole):\n"
  "    \"\"\"Return part as a percentage of whole, or 0.0 when whole is 0.\"\"\"\n"
  "    if whole == 0:\n"
  "        return 0.0\n"
  "    return part // whole * 100",
  "def percentage(part, whole):\n"
  "    \"\"\"Return part as a percentage of whole, or 0.0 when whole is 0.\"\"\"\n"
  "    if whole == 0:\n"
  "        return 0.0\n"
  "    return part / whole * 100",
  "assert percentage(1, 4) == 25.0\n"
  "assert percentage(0, 5) == 0.0\n"
  "assert percentage(1, 0) == 0.0")

B("medium", "last_element", "it raises IndexError on an empty list instead of returning None.",
  "def last_element(items):\n"
  "    \"\"\"Return the last element, or None when the list is empty.\"\"\"\n"
  "    return items[len(items) - 1]",
  "def last_element(items):\n"
  "    \"\"\"Return the last element, or None when the list is empty.\"\"\"\n"
  "    if not items:\n"
  "        return None\n"
  "    return items[-1]",
  "assert last_element([1, 2]) == 2\n"
  "assert last_element([]) is None")

B("medium", "merge_configs", "it modifies the caller's default dict instead of leaving it alone.",
  "def merge_configs(defaults, overrides):\n"
  "    \"\"\"Return a new dict of *defaults* updated with *overrides*, leaving both inputs alone.\"\"\"\n"
  "    defaults.update(overrides)\n"
  "    return defaults",
  "def merge_configs(defaults, overrides):\n"
  "    \"\"\"Return a new dict of *defaults* updated with *overrides*, leaving both inputs alone.\"\"\"\n"
  "    merged = dict(defaults)\n"
  "    merged.update(overrides)\n"
  "    return merged",
  "base = {'a': 1}\n"
  "assert merge_configs(base, {'b': 2}) == {'a': 1, 'b': 2}\n"
  "assert base == {'a': 1}")

B("hard", "find_index", "it returns the last matching index instead of the first.",
  "def find_index(items, target):\n"
  "    \"\"\"Return the index of the first occurrence of *target*, or -1.\"\"\"\n"
  "    found = -1\n"
  "    for i, item in enumerate(items):\n"
  "        if item == target:\n"
  "            found = i\n"
  "    return found",
  "def find_index(items, target):\n"
  "    \"\"\"Return the index of the first occurrence of *target*, or -1.\"\"\"\n"
  "    for i, item in enumerate(items):\n"
  "        if item == target:\n"
  "            return i\n"
  "    return -1",
  "assert find_index([1, 2, 1], 1) == 0\n"
  "assert find_index([1], 9) == -1\n"
  "assert find_index([], 1) == -1")

B("medium", "title_case", "words after a hyphen are not capitalised.",
  "def title_case(text):\n"
  "    \"\"\"Capitalise every word, treating both spaces and hyphens as separators.\"\"\"\n"
  "    return ' '.join(w.capitalize() for w in text.split(' '))",
  "def title_case(text):\n"
  "    \"\"\"Capitalise every word, treating both spaces and hyphens as separators.\"\"\"\n"
  "    return ' '.join(\n"
  "        '-'.join(p.capitalize() for p in word.split('-')) for word in text.split(' ')\n"
  "    )",
  "assert title_case('hello world') == 'Hello World'\n"
  "assert title_case('jean-luc picard') == 'Jean-Luc Picard'\n"
  "assert title_case('') == ''")

B("medium", "running_max", "the first element is dropped from the result.",
  "def running_max(numbers):\n"
  "    \"\"\"Return the running maximum: element i is max(numbers[0..i]).\"\"\"\n"
  "    out = []\n"
  "    best = numbers[0] if numbers else None\n"
  "    for x in numbers[1:]:\n"
  "        best = max(best, x)\n"
  "        out.append(best)\n"
  "    return out",
  "def running_max(numbers):\n"
  "    \"\"\"Return the running maximum: element i is max(numbers[0..i]).\"\"\"\n"
  "    out = []\n"
  "    best = None\n"
  "    for x in numbers:\n"
  "        best = x if best is None else max(best, x)\n"
  "        out.append(best)\n"
  "    return out",
  "assert running_max([1, 3, 2]) == [1, 3, 3]\n"
  "assert running_max([]) == []\n"
  "assert running_max([5]) == [5]")

B("hard", "dedupe", "the order of the result is not stable between runs.",
  "def dedupe(items):\n"
  "    \"\"\"Remove duplicates, keeping the first occurrence of each value in order.\"\"\"\n"
  "    return list(set(items))",
  "def dedupe(items):\n"
  "    \"\"\"Remove duplicates, keeping the first occurrence of each value in order.\"\"\"\n"
  "    seen = set()\n"
  "    out = []\n"
  "    for item in items:\n"
  "        if item not in seen:\n"
  "            seen.add(item)\n"
  "            out.append(item)\n"
  "    return out",
  "assert dedupe(['b', 'a', 'b', 'c']) == ['b', 'a', 'c']\n"
  "assert dedupe([]) == []\n"
  "assert dedupe([1, 1]) == [1]")

B("medium", "clamp_value", "the bounds are applied the wrong way round, so it returns the wrong end.",
  "def clamp_value(value, low, high):\n"
  "    \"\"\"Return *value* limited to [low, high].\"\"\"\n"
  "    return min(low, max(value, high))",
  "def clamp_value(value, low, high):\n"
  "    \"\"\"Return *value* limited to [low, high].\"\"\"\n"
  "    return max(low, min(value, high))",
  "assert clamp_value(5, 0, 3) == 3\n"
  "assert clamp_value(-1, 0, 3) == 0\n"
  "assert clamp_value(2, 0, 3) == 2")

B("medium", "count_matches", "the count is always 1 too high because the accumulator starts wrong.",
  "def count_matches(items, predicate_value):\n"
  "    \"\"\"Count how many elements equal *predicate_value*.\"\"\"\n"
  "    total = 1\n"
  "    for item in items:\n"
  "        if item == predicate_value:\n"
  "            total += 1\n"
  "    return total",
  "def count_matches(items, predicate_value):\n"
  "    \"\"\"Count how many elements equal *predicate_value*.\"\"\"\n"
  "    total = 0\n"
  "    for item in items:\n"
  "        if item == predicate_value:\n"
  "            total += 1\n"
  "    return total",
  "assert count_matches([1, 2, 1], 1) == 2\n"
  "assert count_matches([], 1) == 0")

B("hard", "chunk_list", "the last partial chunk is lost when the length is not a multiple of size.",
  "def chunk_list(items, size):\n"
  "    \"\"\"Split *items* into lists of at most *size* elements.\"\"\"\n"
  "    return [items[i:i + size] for i in range(0, len(items) - size + 1, size)]",
  "def chunk_list(items, size):\n"
  "    \"\"\"Split *items* into lists of at most *size* elements.\"\"\"\n"
  "    return [items[i:i + size] for i in range(0, len(items), size)]",
  "assert chunk_list([1, 2, 3], 2) == [[1, 2], [3]]\n"
  "assert chunk_list([1, 2], 2) == [[1, 2]]\n"
  "assert chunk_list([], 2) == []")

B("medium", "strip_prefix", "it strips individual characters instead of the whole prefix.",
  "def strip_prefix(text, prefix):\n"
  "    \"\"\"Remove *prefix* from the start of *text* if it is there, otherwise return *text*.\"\"\"\n"
  "    return text.lstrip(prefix)",
  "def strip_prefix(text, prefix):\n"
  "    \"\"\"Remove *prefix* from the start of *text* if it is there, otherwise return *text*.\"\"\"\n"
  "    if prefix and text.startswith(prefix):\n"
  "        return text[len(prefix):]\n"
  "    return text",
  "assert strip_prefix('test_case', 'test_') == 'case'\n"
  "assert strip_prefix('setup', 'test_') == 'setup'\n"
  "assert strip_prefix('ttt', 't') == 'tt'")

B("hard", "sum_positive", "it stops at the first non-positive number instead of skipping it.",
  "def sum_positive(numbers):\n"
  "    \"\"\"Add up every number greater than 0, skipping the rest.\"\"\"\n"
  "    total = 0\n"
  "    for x in numbers:\n"
  "        if x <= 0:\n"
  "            break\n"
  "        total += x\n"
  "    return total",
  "def sum_positive(numbers):\n"
  "    \"\"\"Add up every number greater than 0, skipping the rest.\"\"\"\n"
  "    return sum(x for x in numbers if x > 0)",
  "assert sum_positive([1, -2, 3]) == 4\n"
  "assert sum_positive([-1]) == 0\n"
  "assert sum_positive([]) == 0")

B("medium", "get_setting", "a stored value of 0 or '' is replaced by the default.",
  "def get_setting(config, key, default=None):\n"
  "    \"\"\"Return config[key], or *default* only when the key is missing.\"\"\"\n"
  "    return config.get(key) or default",
  "def get_setting(config, key, default=None):\n"
  "    \"\"\"Return config[key], or *default* only when the key is missing.\"\"\"\n"
  "    return config[key] if key in config else default",
  "assert get_setting({'a': 0}, 'a', 5) == 0\n"
  "assert get_setting({'a': ''}, 'a', 'x') == ''\n"
  "assert get_setting({}, 'a', 5) == 5")

B("hard", "is_sorted", "it returns True for a list that is only sorted at the start.",
  "def is_sorted(numbers):\n"
  "    \"\"\"Return True when *numbers* is non-decreasing.\"\"\"\n"
  "    for i in range(len(numbers) - 1):\n"
  "        if numbers[i] <= numbers[i + 1]:\n"
  "            return True\n"
  "    return False",
  "def is_sorted(numbers):\n"
  "    \"\"\"Return True when *numbers* is non-decreasing.\"\"\"\n"
  "    return all(numbers[i] <= numbers[i + 1] for i in range(len(numbers) - 1))",
  "assert is_sorted([1, 2, 3]) is True\n"
  "assert is_sorted([1, 3, 2]) is False\n"
  "assert is_sorted([]) is True\n"
  "assert is_sorted([1, 1]) is True")

B("medium", "word_lengths", "punctuation is counted as part of the word length.",
  "def word_lengths(text):\n"
  "    \"\"\"Return the length of every word, ignoring leading and trailing . , ! and ?\"\"\"\n"
  "    return [len(w) for w in text.split()]",
  "def word_lengths(text):\n"
  "    \"\"\"Return the length of every word, ignoring leading and trailing . , ! and ?\"\"\"\n"
  "    return [len(w.strip('.,!?')) for w in text.split()]",
  "assert word_lengths('hi, there!') == [2, 5]\n"
  "assert word_lengths('') == []\n"
  "assert word_lengths('a') == [1]")


def verify(solution: str, tests: str, label: str) -> None:
    namespace: dict = {}
    try:
        exec(compile(solution + "\n\n" + tests, f"<{label}>", "exec"), namespace)
    except Exception as exc:  # noqa: BLE001 - a failing reference solution must stop generation
        raise SystemExit(f"reference solution for {label} does not pass its tests: {exc!r}") from exc


def main() -> None:
    rows: list[dict] = []

    assert len(TASKS) == 120, len(TASKS)
    assert len(BUGS) == 20, len(BUGS)
    for category, difficulty, name, sig, doc, body, tests in TASKS:
        stub = f'def {sig}:\n    """{doc}\n    """'
        solution = f'def {sig}:\n    """{doc}\n    """\n{body}'
        verify(solution, tests, name)
        rows.append(
            {
                "id": f"code-{len(rows) + 1:04d}",
                "category": category,
                "difficulty": difficulty,
                "prompt": WRITE_PROMPT.format(stub=stub),
                "answer": solution,
                "scorer": "code_exec",
                "tests": tests,
                "meta": {"function": name, "task": "write", "language": "python", "timeout_s": 10},
            }
        )

    for difficulty, name, symptom, buggy, fixed, tests in BUGS:
        verify(fixed, tests, f"{name} (fixed)")
        namespace: dict = {}
        exec(compile(buggy, f"<{name} buggy>", "exec"), namespace)
        try:
            exec(compile(tests, f"<{name} tests>", "exec"), namespace)
        except Exception:
            pass
        else:
            raise SystemExit(f"the 'buggy' version of {name} passes the tests — the item is broken")
        rows.append(
            {
                "id": f"code-{len(rows) + 1:04d}",
                "category": "bugfix",
                "difficulty": difficulty,
                "prompt": FIX_PROMPT.format(symptom=symptom, code=buggy),
                "answer": fixed,
                "scorer": "code_exec",
                "tests": tests,
                "meta": {"function": name, "task": "fix", "language": "python", "timeout_s": 10},
            }
        )

    d = L.dataset_dir(DATASET_ID)
    n = L.write_jsonl(d / "items.jsonl", rows)
    L.write_json(
        d / "dataset.json",
        L.eval_dataset_json(
            DATASET_ID,
            "Code eval v1",
            "140 small Python tasks with hidden tests: 120 write-a-function items across strings, "
            "lists, dicts, maths, parsing, recursion, algorithms and edge-case handling, plus 20 "
            "fix-the-bug items where the buggy code is supplied. Every reference solution is run "
            "against its own tests at generation time, and every buggy version is checked to "
            "actually fail them.",
            rows,
            "gen_eval_code.py",
            "code_exec",
            notes=[
                "`tests` is a block of Python assert statements. The harness appends it to the "
                "model's extracted code block and runs the whole thing in a subprocess with no "
                "network, a temporary working directory, and meta.timeout_s seconds.",
                "`answer` holds a reference solution. It exists so the tests are provably "
                "satisfiable and so a contributor can diff a failure against something real. It "
                "is never sent to the model and never used for scoring.",
                "Only the standard library may be imported by a solution.",
                "The tests pin the documented edge cases (empty input, ValueError, no mutation of "
                "the caller's data), so a solution that only handles the happy path fails.",
            ],
            execution={
                "language": "python",
                "python": ">=3.11",
                "assembly": "extracted_code + '\\n\\n' + tests",
                "default_timeout_s": 10,
                "network": "denied",
            },
        ),
    )
    L.report(DATASET_ID, n)


if __name__ == "__main__":
    main()
