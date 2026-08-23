# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Generate `datasets/eval-reasoning-v1/`.

120 reasoning items: syllogisms, ordering/seating constraint puzzles,
truth-teller/liar puzzles, counting and combinatorics, date and time arithmetic,
spatial navigation, and forward-chaining deduction.

The constraint puzzles are not just generated, they are *solved* here: the
ordering, liar and deduction items are brute-forced over the whole solution space
and only kept when the solution is unique. An item with two valid answers would
punish a model for being right, which is worse than having no item at all.

Run: `uv run datasets/_gen/gen_eval_reasoning.py`
"""

from __future__ import annotations

import random
import sys
from datetime import date, datetime, timedelta
from itertools import permutations, product
from math import comb, perm
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import _lib as L  # noqa: E402

SEED = 20260902
DATASET_ID = "eval-reasoning-v1"

NAMES = ("Ada", "Bo", "Cai", "Dita", "Emre", "Fenna", "Gus", "Hana", "Ivo", "Juno", "Kira", "Lars")
LETTERS = "ABCD"

BARE_NAME = "Reply with the name only."
BARE_NUM = "Reply with the number only."
MC_TAIL = "Reply with the letter of the correct option only."


def mc(rng: random.Random, prompt: str, correct: str, distractors: list[str]) -> tuple[str, list[str], str]:
    """Shuffle options deterministically and return (prompt, choices, answer letter)."""
    options = [correct, *distractors]
    rng.shuffle(options)
    idx = options.index(correct)
    rendered = "\n".join(f"{LETTERS[i]}. {opt}" for i, opt in enumerate(options))
    return f"{prompt}\n\n{rendered}\n\n{MC_TAIL}", options, LETTERS[idx]


# --------------------------------------------------------------------------------------
# syllogisms
# --------------------------------------------------------------------------------------

PLURALS = (
    "brackers", "vanmols", "tarpins", "quillocks", "senders", "morvats", "dellings",
    "kirnets", "plazons", "wodders", "sarnels", "tibbets",
)

#: (premise template pair, valid conclusion, invalid conclusions)
SYLLOGISMS = (
    (
        ("All {a} are {b}.", "All {b} are {c}."),
        "All {a} are {c}.",
        ["All {c} are {a}.", "Some {c} are not {a}.", "No {a} are {c}."],
    ),
    (
        ("All {b} are {c}.", "Some {a} are {b}."),
        "Some {a} are {c}.",
        ["All {a} are {c}.", "No {a} are {c}.", "Some {c} are not {a}."],
    ),
    (
        ("No {b} are {c}.", "All {a} are {b}."),
        "No {a} are {c}.",
        ["Some {a} are {c}.", "All {c} are {a}.", "No {c} are {b}."],
    ),
    (
        ("All {a} are {b}.", "No {b} are {c}."),
        "No {a} are {c}.",
        ["Some {a} are {c}.", "All {c} are {a}.", "Some {c} are {a}."],
    ),
    (
        ("Some {a} are {b}.", "All {b} are {c}."),
        "Some {a} are {c}.",
        ["All {a} are {c}.", "All {c} are {a}.", "No {a} are {c}."],
    ),
    (
        ("All {a} are {b}.", "All {c} are {b}."),
        "Nothing follows about {a} and {c}.",
        ["All {a} are {c}.", "Some {a} are {c}.", "No {a} are {c}."],
    ),
    (
        ("Some {a} are {b}.", "Some {b} are {c}."),
        "Nothing follows about {a} and {c}.",
        ["Some {a} are {c}.", "All {a} are {c}.", "No {a} are {c}."],
    ),
)


def g_syllogism(rng):
    premises, valid, invalid = rng.choice(SYLLOGISMS)
    a, b, c = rng.sample(PLURALS, 3)
    fields = {"a": a, "b": b, "c": c}
    text = " ".join(p.format(**fields) for p in premises)
    correct = valid.format(**fields)
    distractors = [d.format(**fields) for d in invalid]
    difficulty = "hard" if correct.startswith("Nothing follows") else "medium"
    prompt, choices, answer = mc(
        rng,
        f"Assume the following two statements are true. {text}\n\nWhich conclusion follows "
        f"necessarily?",
        correct,
        distractors,
    )
    return prompt, answer, difficulty, "mc", {"choices": choices}


# --------------------------------------------------------------------------------------
# ordering puzzles
# --------------------------------------------------------------------------------------


def _ordering_constraints(rng, people, solution):
    """Facts that are true of *solution*, phrased as puzzle clues."""
    pos = {p: i for i, p in enumerate(solution)}
    facts = []
    for x, y in permutations(people, 2):
        if pos[x] + 1 == pos[y]:
            facts.append((f"{x} sits immediately to the left of {y}.", lambda o, x=x, y=y: o.index(x) + 1 == o.index(y)))
        if pos[x] < pos[y]:
            facts.append((f"{x} sits somewhere to the left of {y}.", lambda o, x=x, y=y: o.index(x) < o.index(y)))
        gap = pos[y] - pos[x] - 1
        if gap >= 1:
            facts.append(
                (
                    f"Exactly {gap} {'person sits' if gap == 1 else 'people sit'} between {x} and {y}, "
                    f"with {x} on the left.",
                    lambda o, x=x, y=y, g=gap: o.index(y) - o.index(x) - 1 == g,
                )
            )
    for p in people:
        facts.append((f"{p} does not sit in seat {pos[p] + 2 if pos[p] + 2 <= len(people) else 1}.",
                      lambda o, p=p, s=(pos[p] + 1 if pos[p] + 2 <= len(people) else 0): o.index(p) != s))
    rng.shuffle(facts)
    return facts


def g_ordering(rng):
    n = rng.choice([4, 5, 5, 6])
    people = rng.sample(NAMES, n)
    solution = list(people)
    rng.shuffle(solution)
    facts = _ordering_constraints(rng, people, solution)
    all_orders = list(permutations(people))

    chosen: list[tuple[str, object]] = []
    survivors = all_orders
    for text, test in facts:
        if len(survivors) == 1:
            break
        nxt = [o for o in survivors if test(list(o))]
        if len(nxt) < len(survivors):
            chosen.append((text, test))
            survivors = nxt
    if len(survivors) != 1:
        return None
    # drop clues that are not needed
    minimal = list(chosen)
    for cand in list(minimal):
        trial = [c for c in minimal if c is not cand]
        kept = [o for o in all_orders if all(t(list(o)) for _, t in trial)]
        if len(kept) == 1:
            minimal = trial
    if len(minimal) < 2:
        return None

    seat = rng.randint(1, n)
    clues = "\n".join(f"- {t}" for t, _ in minimal)
    prompt = (
        f"{n} people sit in a row of {n} seats, numbered 1 to {n} from left to right: "
        f"{', '.join(sorted(people))}.\n\n{clues}\n\nWho sits in seat {seat}? {BARE_NAME}"
    )
    difficulty = "easy" if n == 4 else ("medium" if n == 5 else "hard")
    return prompt, solution[seat - 1], difficulty, "exact", {}


# --------------------------------------------------------------------------------------
# truth-tellers and liars
# --------------------------------------------------------------------------------------


def g_truth_liar(rng):
    n = rng.choice([3, 3, 4])
    people = rng.sample(NAMES, n)
    statements = []
    for i, speaker in enumerate(people):
        others = [p for p in people if p != speaker]
        kind = rng.choice(["is_liar", "is_knight", "both_knights", "at_least_one_liar", "count"])
        if kind == "is_liar":
            target = rng.choice(others)
            statements.append((speaker, f"{target} always lies.", lambda a, t=target: not a[t]))
        elif kind == "is_knight":
            target = rng.choice(others)
            statements.append((speaker, f"{target} always tells the truth.", lambda a, t=target: a[t]))
        elif kind == "both_knights":
            x, y = rng.sample(others, min(2, len(others)))
            statements.append(
                (speaker, f"{x} and {y} both always tell the truth.", lambda a, x=x, y=y: a[x] and a[y])
            )
        elif kind == "at_least_one_liar":
            x, y = rng.sample(others, min(2, len(others)))
            statements.append(
                (speaker, f"At least one of {x} and {y} always lies.", lambda a, x=x, y=y: not (a[x] and a[y]))
            )
        else:
            k = rng.randint(1, n - 1)
            statements.append(
                (
                    speaker,
                    f"Exactly {k} of us always lies." if k == 1 else f"Exactly {k} of us always lie.",
                    lambda a, k=k: sum(1 for v in a.values() if not v) == k,
                )
            )

    consistent = []
    for combo in product([True, False], repeat=n):
        assign = dict(zip(people, combo))
        if all(assign[sp] == test(assign) for sp, _, test in statements):
            consistent.append(assign)
    if len(consistent) != 1:
        return None
    assign = consistent[0]
    knights = sorted(p for p in people if assign[p])
    lines = "\n".join(f'- {sp} says: "{text}"' for sp, text, _ in statements)
    if rng.random() < 0.5 or not knights:
        answer = str(len(knights))
        question = f"How many of them always tell the truth? {BARE_NUM}"
    else:
        answer = ", ".join(knights)
        question = (
            "Which of them always tell the truth? Reply with their names in alphabetical order, "
            "separated by a comma and a space, and nothing else."
        )
    prompt = (
        f"On this island every person either always tells the truth or always lies.\n\n{lines}\n\n{question}"
    )
    return prompt, answer, "hard" if n == 4 else "medium", "exact", {}


# --------------------------------------------------------------------------------------
# counting and combinatorics
# --------------------------------------------------------------------------------------

THINGS = ("books", "tiles", "badges", "seedlings", "cables", "mugs", "stamps", "keys", "lamps")


def g_counting(rng):
    kind = rng.choice(["choose", "arrange", "divisible", "diagonals", "handshakes", "grid", "word", "either"])
    if kind == "choose":
        n, k = rng.randint(6, 16), rng.randint(2, 5)
        return (
            f"In how many ways can {k} {rng.choice(THINGS)} be chosen from {n} distinct ones, "
            f"if the order of the choice does not matter? {BARE_NUM}",
            str(comb(n, k)),
            "easy",
            "exact",
            {},
        )
    if kind == "arrange":
        n, k = rng.randint(5, 10), rng.randint(2, 4)
        return (
            f"How many different ordered sequences of {k} distinct letters can be made from an "
            f"alphabet of {n} letters? {BARE_NUM}",
            str(perm(n, k)),
            "easy",
            "exact",
            {},
        )
    if kind == "divisible":
        lo, hi = rng.randint(20, 300), 0
        hi = lo + rng.randint(200, 900)
        d = rng.choice([3, 4, 6, 7, 9, 11])
        count = hi // d - (lo - 1) // d
        return (
            f"How many whole numbers from {lo} to {hi} inclusive are divisible by {d}? {BARE_NUM}",
            str(count),
            "medium",
            "exact",
            {},
        )
    if kind == "diagonals":
        n = rng.randint(6, 22)
        return (
            f"How many diagonals does a convex polygon with {n} sides have? {BARE_NUM}",
            str(n * (n - 3) // 2),
            "medium",
            "exact",
            {},
        )
    if kind == "handshakes":
        n = rng.randint(6, 40)
        return (
            f"Everyone at a meeting of {n} people shakes hands with everyone else exactly once. "
            f"How many handshakes take place? {BARE_NUM}",
            str(comb(n, 2)),
            "easy",
            "exact",
            {},
        )
    if kind == "grid":
        w, h = rng.randint(3, 8), rng.randint(3, 8)
        return (
            f"On a grid of {w} by {h} blocks you may only walk east or north. How many different "
            f"shortest routes lead from the south-west corner to the north-east corner? {BARE_NUM}",
            str(comb(w + h, w)),
            "hard",
            "exact",
            {},
        )
    if kind == "word":
        word = rng.choice(["BALLOON", "SUCCESS", "TATTOO", "MISSISSIPPI", "PEPPER", "COMMITTEE"])
        counts: dict[str, int] = {}
        for ch in word:
            counts[ch] = counts.get(ch, 0) + 1
        total = 1
        for i in range(2, len(word) + 1):
            total *= i
        for c in counts.values():
            for i in range(2, c + 1):
                total //= i
        return (
            f"How many distinct arrangements are there of all the letters of the word {word}? {BARE_NUM}",
            str(total),
            "hard",
            "exact",
            {},
        )
    n = rng.randint(200, 2_000)
    a, b = rng.choice([(3, 5), (4, 6), (3, 7), (5, 6), (2, 7)])
    count = n // a + n // b - n // (a * b // _gcd(a, b))
    return (
        f"How many whole numbers from 1 to {n} inclusive are divisible by {a} or by {b} (or both)? "
        f"{BARE_NUM}",
        str(count),
        "hard",
        "exact",
        {},
    )


def _gcd(a: int, b: int) -> int:
    while b:
        a, b = b, a % b
    return a


# --------------------------------------------------------------------------------------
# dates and times
# --------------------------------------------------------------------------------------

WEEKDAYS = ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")


def g_datetime(rng):
    kind = rng.choice(["weekday", "between", "add", "meeting", "count_weekday", "offset"])
    d0 = date(rng.randint(2001, 2039), rng.randint(1, 12), rng.randint(1, 28))
    if kind == "weekday":
        return (
            f"What day of the week is {d0.isoformat()}? Reply with the English name of the day only.",
            WEEKDAYS[d0.weekday()],
            "medium",
            "exact",
            {},
        )
    if kind == "between":
        d1 = d0 + timedelta(days=rng.randint(30, 900))
        return (
            f"How many days are there from {d0.isoformat()} to {d1.isoformat()}, counting the "
            f"end date but not the start date? {BARE_NUM}",
            str((d1 - d0).days),
            "medium",
            "exact",
            {},
        )
    if kind == "add":
        k = rng.randint(40, 400)
        return (
            f"What date is {k} days after {d0.isoformat()}? Reply in YYYY-MM-DD form only.",
            (d0 + timedelta(days=k)).isoformat(),
            "medium",
            "exact",
            {},
        )
    if kind == "meeting":
        start = datetime(2026, 1, 1, rng.randint(6, 21), rng.choice([0, 5, 10, 15, 20, 25, 40, 45, 50]))
        minutes = rng.choice([25, 45, 50, 75, 90, 110, 135, 200, 245])
        end = start + timedelta(minutes=minutes)
        day_note = " (it may run past midnight)" if end.day != start.day else ""
        return (
            f"A meeting starts at {start.strftime('%H:%M')} and lasts {minutes} minutes{day_note}. "
            f"At what time does it end? Reply in 24-hour HH:MM form only.",
            end.strftime("%H:%M"),
            "easy",
            "exact",
            {},
        )
    if kind == "count_weekday":
        year, month = rng.randint(2001, 2039), rng.randint(1, 12)
        target = rng.randint(0, 6)
        count = 0
        day = date(year, month, 1)
        while day.month == month:
            if day.weekday() == target:
                count += 1
            day += timedelta(days=1)
        return (
            f"How many {WEEKDAYS[target]}s are there in {date(year, month, 1).strftime('%B %Y')}? "
            f"{BARE_NUM}",
            str(count),
            "hard",
            "exact",
            {},
        )
    off_a, off_b = rng.choice([(2, -5), (1, 9), (-3, 5), (8, -4), (0, 7), (5, -8)])
    hour, minute = rng.randint(0, 23), rng.choice([0, 15, 30, 45])
    base = datetime(2026, 6, 15, hour, minute)
    other = base + timedelta(hours=off_b - off_a)
    return (
        f"It is {base.strftime('%H:%M')} in a place that is at UTC{off_a:+d}. "
        f"What is the local time in a place at UTC{off_b:+d}? Ignore daylight saving. "
        f"Reply in 24-hour HH:MM form only.",
        other.strftime("%H:%M"),
        "medium",
        "exact",
        {},
    )


# --------------------------------------------------------------------------------------
# spatial
# --------------------------------------------------------------------------------------

COMPASS = ("north", "east", "south", "west")
DELTA = {"north": (0, 1), "east": (1, 0), "south": (0, -1), "west": (-1, 0)}


def g_spatial(rng):
    kind = rng.choice(["walk", "facing", "relative"])
    if kind == "facing":
        facing = rng.choice(COMPASS)
        turns = [rng.choice(["left", "right", "around"]) for _ in range(rng.randint(3, 6))]
        idx = COMPASS.index(facing)
        for t in turns:
            idx = (idx + {"left": -1, "right": 1, "around": 2}[t]) % 4
        seq = ", then ".join(f"turn {t}" if t != "around" else "turn around" for t in turns)
        return (
            f"You are facing {facing}. You {seq}. Which direction are you facing now? "
            f"Reply with one word: north, east, south or west.",
            COMPASS[idx],
            "easy",
            "exact",
            {},
        )
    if kind == "walk":
        facing = start_facing = rng.choice(COMPASS)
        x = y = 0
        steps = []
        for _ in range(rng.randint(3, 5)):
            dist = rng.randint(2, 9)
            dx, dy = DELTA[facing]
            x, y = x + dx * dist, y + dy * dist
            turn = rng.choice(["left", "right"])
            steps.append(f"walk {dist} blocks, then turn {turn}")
            facing = COMPASS[(COMPASS.index(facing) + (1 if turn == "right" else -1)) % 4]
        return (
            f"You start at a crossroads facing {start_facing}. You "
            + ", then ".join(steps)
            + ". Counting the north-south blocks and the east-west blocks and adding them "
            f"together, how many blocks from the starting crossroads are you now? {BARE_NUM}",
            str(abs(x) + abs(y)),
            "hard",
            "exact",
            {},
        )
    people = rng.sample(NAMES, 4)
    order = list(people)
    rng.shuffle(order)
    clues = []
    for i in range(len(order) - 1):
        clues.append(f"{order[i]} stands directly in front of {order[i + 1]}.")
    rng.shuffle(clues)
    k = rng.randint(1, 4)
    prompt = (
        "Four people stand in a single queue, one behind another.\n\n"
        + "\n".join(f"- {c}" for c in clues)
        + f"\n\nWho is {k}{'st' if k == 1 else 'nd' if k == 2 else 'rd' if k == 3 else 'th'} in the "
        f"queue, counting from the front? {BARE_NAME}"
    )
    return prompt, order[k - 1], "easy", "exact", {}


# --------------------------------------------------------------------------------------
# forward-chaining deduction
# --------------------------------------------------------------------------------------

PROPS = (
    "the night shift is staffed", "the loading bay is open", "the report is signed",
    "the alarm is armed", "the vault is sealed", "the courier has left",
    "the log is archived", "the gate is locked", "the audit is complete",
)


def g_deduction(rng):
    """A chain that fires from the given fact, plus a second chain that does not."""
    props = rng.sample(PROPS, 6)
    chain, orphan = props[:4], props[4:]
    rules = [(chain[i], chain[i + 1]) for i in range(3)]
    rules.append((orphan[0], orphan[1]))
    rules.append((chain[3], orphan[0]) if rng.random() < 0.25 else (orphan[1], chain[1]))
    rng.shuffle(rules)
    given = chain[0]

    derived = {given}
    changed = True
    while changed:
        changed = False
        for premise, conclusion in rules:
            if premise in derived and conclusion not in derived:
                derived.add(conclusion)
                changed = True
    not_derived = sorted(p for p in props if p not in derived)
    derived_only = sorted(derived - {given})
    if not not_derived or len(derived_only) < 3:
        return None

    rule_lines = "\n".join(f"- If {p}, then {c}." for p, c in rules)
    if rng.random() < 0.5:
        correct = f"It does not necessarily follow that {not_derived[0]}."
        distractors = [f"It does not necessarily follow that {p}." for p in derived_only[:3]]
        question = "Which of these statements is true?"
    else:
        correct = derived_only[-1].capitalize() + "."
        distractors = [p.capitalize() + "." for p in not_derived[:3]]
        while len(distractors) < 3:
            distractors.append(f"Neither {not_derived[0]} nor {derived_only[0]}.")
        question = "Which of these must be true?"
    if len({correct, *distractors}) != 4:
        return None
    prompt, choices, answer = mc(
        rng,
        f"The following rules always hold.\n\n{rule_lines}\n\nIt is given that {given}.\n\n{question}",
        correct,
        distractors[:3],
    )
    return prompt, answer, "hard", "mc", {"choices": choices}


PLAN = (
    ("syllogism", g_syllogism, 18),
    ("ordering", g_ordering, 18),
    ("truth_liar", g_truth_liar, 16),
    ("counting", g_counting, 20),
    ("datetime", g_datetime, 18),
    ("spatial", g_spatial, 15),
    ("deduction", g_deduction, 15),
)


def main() -> None:
    rng = random.Random(SEED)
    rows: list[dict] = []
    seen: set[str] = set()
    for category, gen, count in PLAN:
        made = 0
        attempts = 0
        while made < count:
            attempts += 1
            if attempts > 4_000:
                raise RuntimeError(f"could not generate {count} unique {category} items")
            item = gen(rng)
            if item is None:
                continue
            prompt, answer, difficulty, scorer, extra = item
            if prompt in seen or not answer:
                continue
            seen.add(prompt)
            row = {
                "id": f"reason-{len(rows) + 1:04d}",
                "category": category,
                "difficulty": difficulty,
                "prompt": prompt,
                "answer": answer,
                "scorer": scorer,
            }
            if "choices" in extra:
                row["choices"] = extra.pop("choices")
            if extra:
                row["meta"] = extra
            rows.append(row)
            made += 1

    d = L.dataset_dir(DATASET_ID)
    n = L.write_jsonl(d / "items.jsonl", rows)
    L.write_json(
        d / "dataset.json",
        L.eval_dataset_json(
            DATASET_ID,
            "Reasoning eval v1",
            "120 reasoning items: categorical syllogisms with a 'nothing follows' option, seating "
            "and queue ordering puzzles, knight-and-knave truth puzzles, counting and "
            "combinatorics, calendar and clock arithmetic, spatial orientation, and "
            "forward-chaining deduction over rule sets.",
            rows,
            "gen_eval_reasoning.py",
            "exact",
            seed=SEED,
            notes=[
                "Ordering, liar and deduction puzzles are brute-forced during generation and only "
                "kept when exactly one solution satisfies the clues.",
                "Multiple-choice items carry `choices`; the answer is the letter label.",
                "Free-text items pin the answer format in the prompt (a single name, a bare "
                "number, YYYY-MM-DD, HH:MM, or one compass word), which is what makes the exact "
                "scorer fair here.",
            ],
        ),
    )
    L.report(DATASET_ID, n)


if __name__ == "__main__":
    main()
