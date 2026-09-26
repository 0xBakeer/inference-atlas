# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Generate `datasets/eval-reasoning-v2/`.

140 reasoning items, deliberately harder than eval-reasoning-v1, which strong
~30B models saturate. Same seven categories, bigger search spaces:

  * syllogisms over 3-4 quantified premises, validity decided by exhaustive
    model checking over set regions (never hand-labelled), with an explicit
    "a category may be empty" reading pinned in the prompt so the existential
    fallacy is a real trap and still fair;
  * ordering puzzles with 6-7 people and mixed clue types (adjacency,
    non-adjacency, gaps, ends, negations), brute-forced for a unique solution;
  * knight-and-knave puzzles with 4-5 people and relational statements
    ("same kind", "at least one of ... lies"), brute-forced for uniqueness;
  * counting questions answered by exhaustive enumeration (derangements,
    forbidden-pair committees, non-adjacent seatings, binary strings without
    adjacent ones, coprime counts, blocked grid paths, divisibility unions);
  * calendar/clock arithmetic across centuries, fractional time zones and
    week boundaries;
  * spatial simulation: relative-turn walks and a rolled standard die, both
    simulated step by step;
  * forward-chaining deduction over 8-10 rules with conjunctive premises and
    distractor rules that never fire.

Every answer is computed or brute-forced from the same structure that renders
the prompt; puzzle items are kept only when the solution is unique.

Run: `uv run datasets/_gen/gen_eval_reasoning_v2.py`
"""

from __future__ import annotations

import random
import sys
from datetime import date, datetime, timedelta
from itertools import combinations, permutations, product
from math import gcd
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import _lib as L  # noqa: E402

SEED = 20260911
DATASET_ID = "eval-reasoning-v2"

NAMES = ("Ada", "Bo", "Cai", "Dita", "Emre", "Fenna", "Gus", "Hana", "Ivo", "Juno", "Kira", "Lars")
LETTERS = "ABCD"

BARE_NAME = "Reply with the name only."
BARE_NUM = "Reply with the number only."
SHOW_NUM = (
    "Work through it step by step, then give the final answer on the last line in the form "
    "'Answer: <number>'."
)
MC_TAIL = "Reply with the letter of the correct option only."


_mc_slot = 0


def mc(rng: random.Random, prompt: str, correct: str, distractors: list[str]) -> tuple[str, list[str], str]:
    """Deterministic options with the correct letter cycled A→D for balance."""
    global _mc_slot
    options = list(distractors)
    rng.shuffle(options)
    idx = _mc_slot % (len(distractors) + 1)
    _mc_slot += 1
    options.insert(idx, correct)
    rendered = "\n".join(f"{LETTERS[i]}. {opt}" for i, opt in enumerate(options))
    return f"{prompt}\n\n{rendered}\n\n{MC_TAIL}", options, LETTERS[idx]


# --------------------------------------------------------------------------------------
# syllogisms — validity by exhaustive model checking over set regions
# --------------------------------------------------------------------------------------

PLURALS = (
    "brackers", "vanmols", "tarpins", "quillocks", "senders", "morvats", "dellings",
    "kirnets", "plazons", "wodders", "sarnels", "tibbets",
)

#: statement = (form, i, j) over term indices; forms are the four categorical ones.
FORMS = ("all", "no", "some", "some_not")


def _region_masks(k: int) -> tuple[dict[tuple[str, int, int], int], int]:
    """For every statement form and term pair, the mask of regions it talks about.

    A region is one truth assignment to the k terms (bit t set = member of term t).
    A model is a set of *occupied* regions. "All i are j" is true iff no occupied
    region has i and not j; "Some i are j" iff some occupied region has i and j.
    """
    masks: dict[tuple[str, int, int], int] = {}
    for i in range(k):
        for j in range(k):
            if i == j:
                continue
            m_all = m_no = m_some = m_some_not = 0
            for r in range(1 << k):
                has_i, has_j = bool(r >> i & 1), bool(r >> j & 1)
                if has_i and not has_j:
                    m_all |= 1 << r        # forbidden regions for "All i are j"
                    m_some_not |= 1 << r   # witness regions for "Some i are not j"
                if has_i and has_j:
                    m_no |= 1 << r         # forbidden regions for "No i are j"
                    m_some |= 1 << r       # witness regions for "Some i are j"
            masks[("all", i, j)] = m_all
            masks[("no", i, j)] = m_no
            masks[("some", i, j)] = m_some
            masks[("some_not", i, j)] = m_some_not
    return masks, (1 << (1 << k)) - 1


def _follows(premises: list[tuple[str, int, int]], concl: tuple[str, int, int], k: int,
             masks: dict[tuple[str, int, int], int]) -> bool:
    """True iff *concl* holds in every model of *premises* (empty terms allowed).

    Universal premises forbid regions; existential premises need a witness region.
    A countermodel is built directly from the allowed-region mask, which is exact
    for monadic statements like these.
    """
    full = (1 << (1 << k)) - 1
    allowed = full
    for st in premises:
        if st[0] in ("all", "no"):
            allowed &= full ^ masks[st]
    exist = [st for st in premises if st[0] in ("some", "some_not")]
    if concl[0] in ("all", "no"):
        # countermodel: witnesses in allowed + one occupied region the conclusion forbids
        if not allowed & masks[concl]:
            return True
        return not all(allowed & masks[st] for st in exist)
    # existential conclusion: countermodel keeps every occupied region outside its witnesses
    base = allowed & (full ^ masks[concl])
    return not all(base & masks[st] for st in exist)


def _satisfiable(premises: list[tuple[str, int, int]], k: int,
                 masks: dict[tuple[str, int, int], int]) -> bool:
    full = (1 << (1 << k)) - 1
    allowed = full
    for st in premises:
        if st[0] in ("all", "no"):
            allowed &= full ^ masks[st]
    return all(allowed & masks[st] for st in premises if st[0] in ("some", "some_not"))


def _render_stmt(st: tuple[str, int, int], terms: list[str]) -> str:
    form, i, j = st
    a, b = terms[i], terms[j]
    return {
        "all": f"All {a} are {b}.",
        "no": f"No {a} are {b}.",
        "some": f"Some {a} are {b}.",
        "some_not": f"Some {a} are not {b}.",
    }[form]


#: premise chains as (form, i, j) with the terms 0..k-1; the outer pair is (0, k-1).
SYLLOGISM_CHAINS: tuple[tuple[int, tuple[tuple[str, int, int], ...]], ...] = (
    # three terms, three premises
    (3, (("all", 0, 1), ("all", 1, 2), ("some", 0, 1))),
    (3, (("all", 0, 1), ("no", 1, 2), ("some", 2, 1))),
    (3, (("some", 0, 1), ("all", 1, 2), ("no", 2, 0))),          # inconsistent-ish traps rejected by _satisfiable
    (3, (("all", 1, 0), ("all", 1, 2), ("some", 1, 1))),
    (3, (("no", 0, 1), ("some", 2, 1), ("all", 2, 0))),
    (3, (("some_not", 0, 1), ("all", 2, 1), ("some", 0, 2))),
    (3, (("all", 0, 1), ("some_not", 2, 1), ("some", 2, 0))),
    (3, (("all", 2, 1), ("no", 1, 0), ("some", 2, 2))),
    # four terms, three or four premises
    (4, (("all", 0, 1), ("all", 1, 2), ("all", 2, 3))),
    (4, (("all", 0, 1), ("some", 1, 2), ("all", 2, 3))),
    (4, (("all", 0, 1), ("no", 1, 2), ("all", 3, 2))),
    (4, (("some", 0, 1), ("all", 1, 2), ("no", 2, 3))),
    (4, (("all", 1, 0), ("all", 1, 2), ("some", 3, 1), ("all", 2, 3))),
    (4, (("no", 0, 1), ("all", 2, 1), ("some", 3, 2))),
    (4, (("all", 0, 1), ("all", 2, 1), ("no", 2, 3))),
    (4, (("some", 0, 1), ("some", 1, 2), ("some", 2, 3))),
    (4, (("all", 3, 2), ("no", 2, 1), ("some", 0, 3))),
    (4, (("all", 0, 1), ("some_not", 1, 2), ("all", 3, 2))),
)

SYL_PREAMBLE = (
    "Assume the following statements are all true. A category may be empty, and a conclusion "
    "follows only if it must be true in every situation consistent with the statements."
)


def g_syllogism(rng):
    k, chain = rng.choice(SYLLOGISM_CHAINS)
    # drop self-referential helper statements like ("some", 1, 1) — they were only
    # placeholders for "there is at least one {b}"; render those separately.
    masks, _ = _region_masks(k)
    premises = [st for st in chain if st[1] != st[2]]
    nonempty = [st[1] for st in chain if st[1] == st[2]]
    for t in nonempty:
        # "there is at least one X" == "Some X are X"
        premises.append(("some", t, t))
        masks[("some", t, t)] = 0
        for r in range(1 << k):
            if r >> t & 1:
                masks[("some", t, t)] |= 1 << r
    if not _satisfiable(premises, k, masks):
        return None

    terms = list(rng.sample(PLURALS, k))
    outer = (0, k - 1)
    candidates = [(f, outer[0], outer[1]) for f in FORMS] + [(f, outer[1], outer[0]) for f in FORMS]
    for c in candidates:
        if c not in masks:  # pragma: no cover - all pairs precomputed
            return None
    valid = [c for c in candidates if _follows(premises, c, k, masks)]
    invalid = [c for c in candidates if not _follows(premises, c, k, masks)]
    nothing = f"Nothing follows about {terms[outer[0]]} and {terms[outer[1]]}."

    lines = []
    for st in premises:
        if st[1] == st[2]:
            lines.append(f"There is at least one {terms[st[1]][:-1]}.")
        else:
            lines.append(_render_stmt(st, terms))
    text = " ".join(lines)

    if valid:
        correct = _render_stmt(rng.choice(valid), terms)
        pool = [_render_stmt(c, terms) for c in rng.sample(invalid, min(4, len(invalid)))]
        distractors = pool[:2] + [nothing]
    else:
        correct = nothing
        pool = [_render_stmt(c, terms) for c in rng.sample(invalid, min(5, len(invalid)))]
        distractors = pool[:3]
    if len({correct, *distractors}) != 4:
        return None
    prompt, choices, answer = mc(
        rng, f"{SYL_PREAMBLE}\n\n{text}\n\nWhich conclusion follows necessarily?", correct, distractors
    )
    difficulty = "hard" if (correct == nothing or k == 4) else "medium"
    return prompt, answer, difficulty, "mc", {"choices": choices}


# --------------------------------------------------------------------------------------
# ordering puzzles — 6-7 people, mixed clue types, brute-forced
# --------------------------------------------------------------------------------------


def _ordering_facts(rng, people, solution):
    pos = {p: i for i, p in enumerate(solution)}
    n = len(people)
    facts = []
    for x, y in permutations(people, 2):
        if pos[x] + 1 == pos[y]:
            facts.append((f"{x} sits immediately to the left of {y}.",
                          lambda o, x=x, y=y: o.index(x) + 1 == o.index(y)))
        if pos[x] < pos[y]:
            facts.append((f"{x} sits somewhere to the left of {y}.",
                          lambda o, x=x, y=y: o.index(x) < o.index(y)))
        gap = pos[y] - pos[x] - 1
        if gap >= 1:
            facts.append((
                f"Exactly {gap} {'person sits' if gap == 1 else 'people sit'} between {x} and {y}, "
                f"with {x} on the left.",
                lambda o, x=x, y=y, g=gap: o.index(y) - o.index(x) - 1 == g,
            ))
    for x, y in combinations(people, 2):
        if abs(pos[x] - pos[y]) == 1:
            facts.append((f"{x} and {y} sit next to each other, in some order.",
                          lambda o, x=x, y=y: abs(o.index(x) - o.index(y)) == 1))
        else:
            facts.append((f"{x} and {y} do not sit next to each other.",
                          lambda o, x=x, y=y: abs(o.index(x) - o.index(y)) != 1))
    for p in people:
        if pos[p] in (0, n - 1):
            facts.append((f"{p} sits at one end of the row.",
                          lambda o, p=p: o.index(p) in (0, len(o) - 1)))
        else:
            facts.append((f"{p} does not sit at either end of the row.",
                          lambda o, p=p: o.index(p) not in (0, len(o) - 1)))
        wrong = rng.choice([s for s in range(n) if s != pos[p]])
        facts.append((f"{p} does not sit in seat {wrong + 1}.",
                      lambda o, p=p, s=wrong: o.index(p) != s))
    rng.shuffle(facts)
    return facts


def g_ordering(rng):
    n = rng.choice([6, 6, 6, 7])
    people = rng.sample(NAMES, n)
    solution = list(people)
    rng.shuffle(solution)
    facts = _ordering_facts(rng, people, solution)
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
    minimal = list(chosen)
    for cand in list(minimal):
        trial = [c for c in minimal if c is not cand]
        kept = [o for o in all_orders if all(t(list(o)) for _, t in trial)]
        if len(kept) == 1:
            minimal = trial
    if len(minimal) < 4:
        return None

    clues = "\n".join(f"- {t}" for t, _ in minimal)
    header = (
        f"{n} people sit in a row of {n} seats, numbered 1 to {n} from left to right: "
        f"{', '.join(sorted(people))}.\n\n{clues}\n\n"
    )
    if rng.random() < 0.6:
        seat = rng.randint(1, n)
        prompt = header + f"Who sits in seat {seat}? {BARE_NAME}"
        answer, scorer = solution[seat - 1], "exact"
    else:
        x, y = rng.sample(people, 2)
        between = abs(solution.index(x) - solution.index(y)) - 1
        prompt = header + f"How many people sit between {x} and {y}? {BARE_NUM}"
        answer, scorer = str(between), "numeric"
    return prompt, answer, "hard" if n == 7 else "medium", scorer, {}


# --------------------------------------------------------------------------------------
# truth-tellers and liars — 4-5 people, relational statements
# --------------------------------------------------------------------------------------


def g_truth_liar(rng):
    n = rng.choice([3, 4, 4, 5])
    people = rng.sample(NAMES, n)
    statements = []
    for speaker in people:
        others = [p for p in people if p != speaker]
        kind = rng.choice([
            "is_liar", "is_knight", "same_kind", "diff_kind", "both_lie",
            "at_least_one_liar", "count", "count_knights",
        ])
        if kind == "is_liar":
            t = rng.choice(others)
            statements.append((speaker, f"{t} always lies.", lambda a, t=t: not a[t]))
        elif kind == "is_knight":
            t = rng.choice(others)
            statements.append((speaker, f"{t} always tells the truth.", lambda a, t=t: a[t]))
        elif kind == "same_kind":
            x, y = rng.sample(others, 2)
            statements.append((speaker, f"{x} and {y} are of the same kind.",
                               lambda a, x=x, y=y: a[x] == a[y]))
        elif kind == "diff_kind":
            x, y = rng.sample(others, 2)
            statements.append((speaker, f"{x} and {y} are of different kinds.",
                               lambda a, x=x, y=y: a[x] != a[y]))
        elif kind == "both_lie":
            x, y = rng.sample(others, 2)
            statements.append((speaker, f"{x} and {y} both always lie.",
                               lambda a, x=x, y=y: not a[x] and not a[y]))
        elif kind == "at_least_one_liar":
            x, y = rng.sample(others, 2)
            statements.append((speaker, f"At least one of {x} and {y} always lies.",
                               lambda a, x=x, y=y: not (a[x] and a[y])))
        elif kind == "count":
            k = rng.randint(1, n - 1)
            statements.append((speaker,
                               f"Exactly {k} of us always lies." if k == 1 else f"Exactly {k} of us always lie.",
                               lambda a, k=k: sum(1 for v in a.values() if not v) == k))
        else:
            k = rng.randint(1, n - 1)
            statements.append((speaker,
                               f"Exactly {k} of us always {'tells' if k == 1 else 'tell'} the truth.",
                               lambda a, k=k: sum(1 for v in a.values() if v) == k))

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
        scorer = "numeric"
    else:
        answer = ", ".join(knights)
        question = (
            "Which of them always tell the truth? Reply with their names in alphabetical order, "
            "separated by a comma and a space, and nothing else."
        )
        scorer = "exact"
    prompt = (
        f"On this island every person either always tells the truth or always lies.\n\n{lines}\n\n{question}"
    )
    return prompt, answer, {3: "easy", 4: "medium", 5: "hard"}[n], scorer, {}


# --------------------------------------------------------------------------------------
# counting — every answer found by exhaustive enumeration
# --------------------------------------------------------------------------------------

THINGS = ("books", "tiles", "badges", "seedlings", "cables", "mugs", "stamps", "keys", "lamps")


def g_counting(rng):
    kind = rng.choice([
        "derange", "committee", "non_adjacent", "no_11", "coprime", "union3", "blocked_grid",
        "divisible",
    ])
    if kind == "divisible":
        lo = rng.randint(20, 300)
        hi = lo + rng.randint(200, 900)
        d = rng.choice([3, 4, 6, 7, 9, 11, 13])
        count = hi // d - (lo - 1) // d
        return (
            f"How many whole numbers from {lo} to {hi} inclusive are divisible by {d}? {BARE_NUM}",
            str(count), "easy", "numeric", {},
        )
    if kind == "derange":
        n = rng.randint(6, 8)
        count = sum(
            1 for p in permutations(range(n)) if all(p[i] != i for i in range(n))
        )
        return (
            f"{n} people check {n} coats. In how many ways can the coats be handed back so that "
            f"nobody receives their own coat? {SHOW_NUM}",
            str(count), "hard", "numeric", {},
        )
    if kind == "committee":
        n, k = rng.randint(8, 10), rng.randint(3, 4)
        people = rng.sample(NAMES, n)
        (a, b), (c, d) = rng.sample(list(combinations(people, 2)), 2)
        if {a, b} == {c, d}:
            return None
        count = sum(
            1
            for team in combinations(people, k)
            if not ({a, b} <= set(team)) and not ({c, d} <= set(team))
        )
        return (
            f"A committee of {k} must be chosen from {n} people: {', '.join(people)}. "
            f"{a} and {b} refuse to serve together, and so do {c} and {d}. "
            f"How many different committees are possible? {SHOW_NUM}",
            str(count), "hard", "numeric", {},
        )
    if kind == "non_adjacent":
        n = rng.randint(6, 7)
        people = rng.sample(NAMES, n)
        x, y = rng.sample(people, 2)
        count = sum(
            1 for p in permutations(people) if abs(p.index(x) - p.index(y)) != 1
        )
        return (
            f"{n} people — {', '.join(people)} — are to be seated in a row of {n} chairs. "
            f"{x} and {y} must not sit next to each other. How many seatings are possible? {SHOW_NUM}",
            str(count), "hard", "numeric", {},
        )
    if kind == "no_11":
        n = rng.randint(10, 15)
        count = sum(1 for v in range(1 << n) if "11" not in format(v, f"0{n}b"))
        return (
            f"How many binary strings of length {n} contain no two adjacent 1s? {SHOW_NUM}",
            str(count), "hard", "numeric", {},
        )
    if kind == "coprime":
        n = rng.randint(120, 400)
        m = rng.choice([12, 18, 20, 30, 36, 42])
        count = sum(1 for v in range(1, n + 1) if gcd(v, m) == 1)
        return (
            f"How many whole numbers from 1 to {n} inclusive share no common factor greater "
            f"than 1 with {m}? {SHOW_NUM}",
            str(count), "hard", "numeric", {},
        )
    if kind == "union3":
        n = rng.randint(500, 3000)
        a, b, c = rng.choice([(3, 5, 7), (4, 6, 9), (3, 4, 5), (5, 6, 8), (2, 9, 15)])
        count = sum(1 for v in range(1, n + 1) if v % a == 0 or v % b == 0 or v % c == 0)
        return (
            f"How many whole numbers from 1 to {n} inclusive are divisible by {a}, by {b} or by "
            f"{c} (or by more than one of them)? {SHOW_NUM}",
            str(count), "hard", "numeric", {},
        )
    # blocked_grid
    w, h = rng.randint(5, 8), rng.randint(4, 7)
    bx, by = rng.randint(1, w - 1), rng.randint(1, h - 1)
    ways = [[0] * (h + 1) for _ in range(w + 1)]
    for x in range(w + 1):
        for y in range(h + 1):
            if (x, y) == (0, 0):
                ways[x][y] = 1
            elif (x, y) == (bx, by):
                ways[x][y] = 0
            else:
                ways[x][y] = (ways[x - 1][y] if x else 0) + (ways[x][y - 1] if y else 0)
    return (
        f"On a street grid you walk from corner (0, 0) to corner ({w}, {h}), moving only east "
        f"(increasing x) or north (increasing y) one block at a time. The intersection at "
        f"({bx}, {by}) is closed and cannot be entered. How many different shortest routes are "
        f"there? {SHOW_NUM}",
        str(ways[w][h]), "hard", "numeric", {},
    )


# --------------------------------------------------------------------------------------
# dates and times — centuries, fractional zones, week boundaries
# --------------------------------------------------------------------------------------

WEEKDAYS = ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")
ORDINALS = ("first", "second", "third", "fourth")


def g_datetime(rng):
    kind = rng.choice(["weekday_far", "nth_weekday", "between_years", "add_dt", "tz_frac", "week_monday",
                       "before", "meeting"])
    if kind == "meeting":
        start = datetime(2026, 1, 1, rng.randint(6, 21), rng.choice([0, 5, 10, 15, 20, 25, 40, 45, 50]))
        minutes = rng.choice([25, 45, 50, 75, 90, 110, 135, 200, 245])
        end = start + timedelta(minutes=minutes)
        day_note = " (it may run past midnight)" if end.day != start.day else ""
        return (
            f"A meeting starts at {start.strftime('%H:%M')} and lasts {minutes} minutes{day_note}. "
            f"At what time does it end? Reply in 24-hour HH:MM form only.",
            end.strftime("%H:%M"), "easy", "exact", {},
        )
    if kind == "weekday_far":
        d0 = date(rng.randint(1800, 2199), rng.randint(1, 12), rng.randint(1, 28))
        return (
            f"What day of the week is {d0.isoformat()} in the Gregorian calendar? "
            f"Reply with the English name of the day only.",
            WEEKDAYS[d0.weekday()], "hard", "exact", {},
        )
    if kind == "nth_weekday":
        year, month = rng.randint(1900, 2099), rng.randint(1, 12)
        target, nth = rng.randint(0, 6), rng.randint(0, 3)
        day, hits = date(year, month, 1), []
        while day.month == month:
            if day.weekday() == target:
                hits.append(day)
            day += timedelta(days=1)
        if nth >= len(hits):
            return None
        return (
            f"What is the date of the {ORDINALS[nth]} {WEEKDAYS[target]} of "
            f"{date(year, month, 1).strftime('%B %Y')}? Reply in YYYY-MM-DD form only.",
            hits[nth].isoformat(), "medium", "exact", {},
        )
    if kind == "between_years":
        d0 = date(rng.randint(1900, 2090), rng.randint(1, 12), rng.randint(1, 28))
        d1 = d0 + timedelta(days=rng.randint(900, 4000))
        return (
            f"How many days are there from {d0.isoformat()} to {d1.isoformat()}, counting the "
            f"end date but not the start date? {SHOW_NUM}",
            str((d1 - d0).days), "hard", "numeric", {},
        )
    if kind == "add_dt":
        start = datetime(rng.randint(2001, 2039), rng.randint(1, 12), rng.randint(1, 28),
                         rng.randint(0, 23), rng.choice([0, 10, 15, 20, 30, 40, 45, 50]))
        hours = rng.randint(30, 400)
        minutes = rng.choice([0, 15, 30, 45, 50])
        end = start + timedelta(hours=hours, minutes=minutes)
        return (
            f"It is {start.strftime('%H:%M')} on {start.date().isoformat()}. What is the date "
            f"and time exactly {hours} hours and {minutes} minutes later? "
            f"Reply in the form 'YYYY-MM-DD HH:MM' (24-hour clock) and nothing else.",
            end.strftime("%Y-%m-%d %H:%M"), "hard", "exact", {},
        )
    if kind == "tz_frac":
        offsets = [(-570, "UTC-9:30"), (-240, "UTC-4"), (0, "UTC+0"), (330, "UTC+5:30"),
                   (345, "UTC+5:45"), (525, "UTC+8:45"), (630, "UTC+10:30"), (780, "UTC+13")]
        (off_a, name_a), (off_b, name_b) = rng.sample(offsets, 2)
        base = datetime(2026, 3, 10, rng.randint(0, 23), rng.choice([0, 5, 15, 30, 40, 45]))
        dur = rng.choice([65, 95, 130, 145, 170, 205, 250])
        end_local_b = base + timedelta(minutes=dur) + timedelta(minutes=off_b - off_a)
        return (
            f"A call starts at {base.strftime('%H:%M')} local time in a city at {name_a} and "
            f"lasts {dur} minutes. At what local time does it end in a city at {name_b}? "
            f"Ignore daylight saving. Reply in 24-hour HH:MM form only.",
            end_local_b.strftime("%H:%M"), "hard", "exact", {},
        )
    if kind == "week_monday":
        d0 = date(rng.randint(1990, 2049), rng.randint(1, 12), rng.randint(1, 28))
        monday = d0 - timedelta(days=d0.weekday())
        return (
            f"Weeks run from Monday to Sunday. What is the date of the Monday of the week that "
            f"contains {d0.isoformat()}? Reply in YYYY-MM-DD form only.",
            monday.isoformat(), "medium", "exact", {},
        )
    d0 = date(rng.randint(1950, 2049), rng.randint(1, 12), rng.randint(1, 28))
    k = rng.randint(45, 900)
    return (
        f"What date is {k} days before {d0.isoformat()}? Reply in YYYY-MM-DD form only.",
        (d0 - timedelta(days=k)).isoformat(), "medium", "exact", {},
    )


# --------------------------------------------------------------------------------------
# spatial — simulated relative-turn walks and a rolled die
# --------------------------------------------------------------------------------------

COMPASS = ("north", "east", "south", "west")
DELTA = {"north": (0, 1), "east": (1, 0), "south": (0, -1), "west": (-1, 0)}


def _roll(state: tuple[int, int, int], direction: str) -> tuple[int, int, int]:
    """(top, north, east) of a standard die after tipping one square in *direction*."""
    top, north, east = state
    if direction == "north":
        return 7 - north, top, east
    if direction == "south":
        return north, 7 - top, east
    if direction == "east":
        return 7 - east, north, top
    return east, north, 7 - top


def _check_die() -> None:
    """Four rolls in one direction must return the die to its starting state."""
    start = (1, 2, 3)
    for d in COMPASS:
        state = start
        for _ in range(4):
            state = _roll(state, d)
        if state != start:
            raise AssertionError(f"die roll is not a 4-cycle for {d}")


_check_die()


def g_spatial(rng):
    kind = rng.choice(["walk_dist", "walk_face", "dice", "facing"])
    if kind == "facing":
        facing = rng.choice(COMPASS)
        turns = [rng.choice(["left", "right", "around"]) for _ in range(rng.randint(3, 6))]
        idx = COMPASS.index(facing)
        for t in turns:
            idx = (idx + {"left": -1, "right": 1, "around": 2}[t]) % 4
        seq = ", then ".join("turn around" if t == "around" else f"turn {t}" for t in turns)
        return (
            f"You are facing {facing}. You {seq}. Which direction are you facing now? "
            f"Reply with one word: north, east, south or west.",
            COMPASS[idx], "easy", "exact", {},
        )
    if kind == "dice":
        n = rng.randint(4, 7)
        rolls = [rng.choice(COMPASS) for _ in range(n)]
        state = (1, 2, 3)
        for d in rolls:
            state = _roll(state, d)
        seq = ", then ".join(rolls)
        return (
            "A standard die (opposite faces sum to 7) rests on a table with 1 on top, 2 facing "
            "north and 3 facing east. Rolling the die in a compass direction tips it over that "
            f"edge onto the next square. The die is rolled {seq}. "
            f"What number is now on top? {BARE_NUM}",
            str(state[0]), "hard", "numeric", {},
        )
    facing = start_facing = rng.choice(COMPASS)
    x = y = 0
    steps = []
    for _ in range(rng.randint(4, 6)):
        dist = rng.randint(2, 9)
        dx, dy = DELTA[facing]
        x, y = x + dx * dist, y + dy * dist
        turn = rng.choice(["left", "right", "around"])
        steps.append(f"walk {dist} blocks, then turn {turn if turn != 'around' else 'around'}")
        facing = COMPASS[(COMPASS.index(facing) + {"left": -1, "right": 1, "around": 2}[turn]) % 4]
    walk = ", then ".join(steps)
    if kind == "walk_face":
        return (
            f"You start at a crossroads facing {start_facing}. You {walk}. "
            f"Which compass direction are you facing now? "
            f"Reply with one word: north, east, south or west.",
            facing, "medium", "exact", {},
        )
    return (
        f"You start at a crossroads facing {start_facing}. You {walk}. Counting the north-south "
        f"blocks and the east-west blocks and adding them together, how many blocks from the "
        f"starting crossroads are you now? {SHOW_NUM}",
        str(abs(x) + abs(y)), "hard", "numeric", {},
    )


# --------------------------------------------------------------------------------------
# forward-chaining deduction — conjunctive rules, distractor rules
# --------------------------------------------------------------------------------------

PROPS = (
    "the night shift is staffed", "the loading bay is open", "the report is signed",
    "the alarm is armed", "the vault is sealed", "the courier has left",
    "the log is archived", "the gate is locked", "the audit is complete",
    "the manifest is stamped", "the depot is lit", "the ledger is balanced",
)


def _closure(rules, given):
    derived = set(given)
    changed = True
    while changed:
        changed = False
        for premises, conclusion in rules:
            if premises <= derived and conclusion not in derived:
                derived.add(conclusion)
                changed = True
    return derived


def g_deduction(rng):
    props = rng.sample(PROPS, 9)
    given = set(props[:2])
    pool = props[2:]
    rules: list[tuple[frozenset, str]] = []
    reachable = list(props[:2])
    # a real chain of 4-5 rules, some with conjunctive premises
    for i in range(rng.randint(4, 5)):
        if i >= len(pool):
            break
        concl = pool[i]
        if len(reachable) >= 2 and rng.random() < 0.5:
            premises = frozenset(rng.sample(reachable, 2))
        else:
            premises = frozenset([rng.choice(reachable)])
        rules.append((premises, concl))
        reachable.append(concl)
    # distractor rules whose premises never all hold
    unreached = [p for p in pool if p not in _closure(rules, given)]
    if len(unreached) < 3:
        return None
    for i in range(2):
        premises = frozenset([unreached[i]])
        concl = rng.choice([p for p in props if p != unreached[i]])
        rules.append((premises, concl))
    rng.shuffle(rules)

    derived = _closure(rules, given)
    derived_only = sorted(derived - given)
    not_derived = sorted(p for p in props if p not in derived)
    if len(derived_only) < 3 or len(not_derived) < 3:
        return None

    def render(premises: frozenset, concl: str) -> str:
        ps = sorted(premises)
        if len(ps) == 1:
            return f"- If {ps[0]}, then {concl}."
        return f"- If {ps[0]} and {ps[1]}, then {concl}."

    rule_lines = "\n".join(render(p, c) for p, c in rules)
    given_line = " and ".join(sorted(given))
    if rng.random() < 0.5:
        correct = f"It does not necessarily follow that {rng.choice(not_derived)}."
        distractors = [f"It does not necessarily follow that {p}." for p in rng.sample(derived_only, 3)]
        question = "Which of these statements is true?"
    else:
        correct = rng.choice(derived_only).capitalize() + "."
        distractors = [p.capitalize() + "." for p in rng.sample(not_derived, 3)]
        question = "Which of these must be true?"
    if len({correct, *distractors}) != 4:
        return None
    prompt, choices, answer = mc(
        rng,
        f"The following rules always hold.\n\n{rule_lines}\n\nIt is given that {given_line}.\n\n{question}",
        correct,
        distractors,
    )
    return prompt, answer, "hard", "mc", {"choices": choices}


# --------------------------------------------------------------------------------------


PLAN = (
    ("syllogism", g_syllogism, 20),
    ("ordering", g_ordering, 20),
    ("truth_liar", g_truth_liar, 20),
    ("counting", g_counting, 20),
    ("datetime", g_datetime, 20),
    ("spatial", g_spatial, 20),
    ("deduction", g_deduction, 20),
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
            if attempts > 8_000:
                raise RuntimeError(f"could not generate {count} unique {category} items")
            item = gen(rng)
            if item is None:
                continue
            prompt, answer, difficulty, scorer, extra = item
            if prompt in seen or not answer:
                continue
            seen.add(prompt)
            row = {
                "id": f"reason2-{len(rows) + 1:04d}",
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
            "Reasoning eval v2",
            "140 reasoning items, harder than eval-reasoning-v1: 3-4 premise syllogisms whose "
            "validity is decided by exhaustive model checking (empty categories allowed, stated "
            "in the prompt), 6-7 person ordering puzzles with mixed clue types, 4-5 person "
            "knight-and-knave puzzles with relational statements, counting questions answered "
            "by exhaustive enumeration, calendar and clock arithmetic across centuries and "
            "fractional time zones, simulated walks and die rolls, and forward-chaining "
            "deduction over rule sets with conjunctive premises and distractor rules.",
            rows,
            "gen_eval_reasoning_v2.py",
            "exact",
            seed=SEED,
            supersedes="eval-reasoning-v1",
            notes=[
                "Ordering, liar, deduction and syllogism items are brute-forced or model-checked "
                "during generation and only kept when exactly one answer is correct.",
                "Syllogism prompts pin the modern reading (a category may be empty), which makes "
                "the existential-fallacy distractors fair.",
                "Counting answers come from exhaustive enumeration, never from a formula typed "
                "into the generator.",
                "Multiple-choice items carry `choices`; the answer is the letter label.",
                "Free-text items pin the answer format in the prompt; bare-number items are "
                "scored with the numeric scorer so a model is not punished for units of prose.",
            ],
        ),
    )
    L.report(DATASET_ID, n)


if __name__ == "__main__":
    main()
