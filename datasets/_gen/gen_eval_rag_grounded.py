# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Generate `datasets/eval-rag-grounded-v1/`.

120 grounded-answering items over 30 short passages (roughly 80-110 words each). Every
passage describes two sibling things of the same kind — two bus routes, two ferries, two
workshops — so every value in it has a same-type distractor next to it. Four questions
are asked of each passage:

  * ``lookup``    — one value of the second sibling, with the first sibling's value of
                    the same attribute sitting in the passage as a distractor;
  * ``combine``   — a sum or difference of two values in the passage (even passages);
  * ``condition`` — a value that depends on a condition the passage states, e.g. the
                    weekend frequency when the question names a Sunday (odd passages);
  * ``absent``    — an attribute the passage never mentions for either sibling;
  * ``near_miss`` — an attribute the passage gives for the FIRST sibling only, asked of
                    the second one. This is the trap: the right-looking number is right
                    there, and it belongs to the other thing.

Half the items are answerable and half are not, so a model that always declines scores
exactly 0.5 and a model that never declines scores at most 0.5. The split in
``scores.by_category`` is the point of the suite: ``lookup``/``combine``/``condition`` say
whether the model can read, ``absent``/``near_miss`` whether it stays inside the passage.

All entities, places and people are invented, so nothing can be answered from parametric
knowledge, and every answer is computed from the same values that were rendered into the
passage. Scored with the ``needle`` scorer: the answer (or, for the unanswerable items, one
of the listed ways of saying "not in the passage") must occur in the extracted output.

Run: `uv run datasets/_gen/gen_eval_rag_grounded.py`
"""

from __future__ import annotations

import random
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import _lib as L  # noqa: E402

SEED = 20260922
DATASET_ID = "eval-rag-grounded-v1"
CREATED = "2026-09-22"
PASSAGES_PER_DOMAIN = 5

INSTRUCTION = (
    "Answer the question using only the passage below. Reply with the answer only, without "
    "explanation. If the passage does not contain the answer, reply exactly: NOT IN PASSAGE"
)

#: Accepted ways of declining. The instruction asks for the first; the rest are the
#: phrasings small models actually use when they decline without following the format, and
#: declining is what these items test, not the format.
ABSTAIN = [
    "NOT IN PASSAGE",
    "not in the passage",
    "not mentioned",
    "does not mention",
    "doesn't mention",
    "not stated",
    "does not state",
    "doesn't state",
    "does not say",
    "doesn't say",
    "not specified",
    "does not specify",
    "doesn't specify",
    "not provided",
    "does not provide",
    "doesn't provide",
    "not given",
    "no information",
    "not included",
    "cannot be determined",
]

TOWNS = ("Kesswater", "Aberholt", "Valcrest", "Threeford", "Marren Bay", "Dunhallow",
         "Oldmarsh", "Brightwell", "Corrin Vale", "Hollin Cross")
FIRST = ("Mira", "Tomas", "Ines", "Rafael", "Nadia", "Juno", "Emre", "Dana", "Priya", "Lars",
         "Fenna", "Hana", "Oskar", "Talia", "Wren")
LAST = ("Alder", "Braith", "Corvin", "Dunmore", "Ellery", "Fairbank", "Holt", "Ivers",
        "Jarrow", "Keswick", "Lund", "Marrow")
WEEKDAYS = ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday")
WEEKEND = ("Saturday", "Sunday")

FILLER = (
    "The figures below come from the most recent annual summary.",
    "Local residents were consulted before the current arrangement was agreed.",
    "A review of the arrangement is planned but no date has been set.",
    "The summary was prepared for the members of the regional committee.",
    "Earlier arrangements are described in a separate archive note.",
    "Feedback can be left through the usual channels.",
)


def person(rng: random.Random) -> str:
    return f"{rng.choice(FIRST)} {rng.choice(LAST)}"


def distinct(rng: random.Random, draw, n: int) -> list:
    """*n* different values from *draw*, deterministic for the rng state."""
    out: list = []
    while len(out) < n:
        value = draw()
        if value not in out:
            out.append(value)
    return out


def clock(rng: random.Random) -> str:
    """A time of day from 10:05 to 18:55. Hours from 10 up, so nobody's '7:45' vs '07:45'
    formatting decides an item."""
    return f"{rng.randint(10, 18)}:{rng.choice(range(5, 60, 5)):02d}"


def money(rng: random.Random, low: int, high: int) -> str:
    """A price whose last digit is never 0, so '12.40' vs '12.4' cannot decide an item."""
    return f"{rng.randint(low, high)}.{rng.randint(1, 9)}{rng.choice('123456789')}"


# --------------------------------------------------------------------------------------
# domains
#
# A domain turns one rng draw into a passage and the questions about it. `values` holds
# every rendered value (for the distractor check); the questions are computed from the
# same variables that were formatted into the sentences.
# --------------------------------------------------------------------------------------


def bus(rng: random.Random, n: int) -> dict:
    town = TOWNS[n % len(TOWNS)]
    a, b = distinct(rng, lambda: rng.randint(11, 98), 2)
    stops_a, stops_b = distinct(rng, lambda: rng.randint(14, 61), 2)
    km_a, km_b = distinct(rng, lambda: f"{rng.randint(6, 29)}.{rng.randint(1, 9)}", 2)
    last_a = f"{rng.randint(19, 23)}:{rng.choice(range(5, 60, 5)):02d}"
    wk_a, we_a = distinct(rng, lambda: rng.choice([12, 15, 18, 20, 25]), 2)
    wk_b, we_b = distinct(rng, lambda: rng.choice([30, 35, 40, 45, 50]), 2)
    fare = money(rng, 1, 4)
    sentences = [
        f"{town} Transit runs two cross-town services, Route {a} and Route {b}.",
        f"Route {a} is {km_a} km long and serves {stops_a} stops, and its last bus leaves "
        f"the terminus at {last_a}.",
        f"Route {b} covers {km_b} km with {stops_b} stops.",
        f"On weekdays Route {a} runs every {wk_a} minutes; at weekends it runs every {we_a} "
        "minutes.",
        f"Route {b} runs every {wk_b} minutes on weekdays and every {we_b} minutes at "
        "weekends.",
        f"A single fare on either route costs {fare}.",
    ]
    day = rng.choice(WEEKEND)
    return {
        "sentences": sentences,
        "values": [str(v) for v in (a, b, stops_a, stops_b, km_a, km_b, last_a, wk_a, we_a,
                                     wk_b, we_b, fare)],
        "lookup": (f"How many stops does Route {b} serve?", str(stops_b)),
        "combine": (f"How many stops do Route {a} and Route {b} serve in total?",
                    str(stops_a + stops_b)),
        "condition": (f"How often does Route {b} run on a {day}, in minutes?", str(we_b)),
        "absent": rng.choice((
            f"How many drivers does {town} Transit employ?",
            f"What colour are the buses on Route {a}?",
            f"How much does a monthly pass for Route {b} cost?",
        )),
        "near_miss": f"At what time does the last bus on Route {b} leave the terminus?",
    }


def ferry(rng: random.Random, n: int) -> dict:
    town = TOWNS[(n + 3) % len(TOWNS)]
    names = rng.sample(("Heron", "Cormorant", "Petrel", "Kittiwake", "Gannet", "Tern"), 2)
    a, b = (f"MV {x}" for x in names)
    built_a, built_b = distinct(rng, lambda: rng.randint(1978, 2021), 2)
    cars_a, cars_b = distinct(rng, lambda: rng.randint(24, 96), 2)
    pax_a = rng.randint(180, 640)
    mins_a, mins_b = distinct(rng, lambda: rng.randint(35, 95), 2)
    summer, winter = distinct(rng, lambda: rng.choice([60, 75, 90, 120, 150]), 2)
    sentences = [
        f"Two ferries, the {a} and the {b}, cross the sound between {town} and the island "
        "harbour.",
        f"The {a} was built in {built_a}, carries up to {cars_a} cars and is licensed for "
        f"{pax_a} passengers.",
        f"The {b} was built in {built_b} and carries up to {cars_b} cars.",
        f"The crossing takes {mins_a} minutes on the {a} and {mins_b} minutes on the {b}.",
        f"In summer there is a departure every {summer} minutes; in winter the interval "
        f"grows to {winter} minutes.",
    ]
    season = rng.choice(("January", "February", "December"))
    return {
        "sentences": sentences,
        "values": [str(v) for v in (built_a, built_b, cars_a, cars_b, pax_a, mins_a, mins_b,
                                     summer, winter)],
        "lookup": (f"How many cars can the {b} carry?", str(cars_b)),
        "combine": ("How many minutes longer is the crossing on the slower of the two ferries?",
                    str(abs(mins_a - mins_b))),
        "condition": (f"In {season}, how many minutes are there between departures?",
                      str(winter)),
        "absent": rng.choice((
            f"What is the name of the captain of the {a}?",
            "How much does a foot-passenger ticket cost?",
            f"How long is the {b}, in metres?",
        )),
        "near_miss": f"How many passengers is the {b} licensed to carry?",
    }


def workshop(rng: random.Random, n: int) -> dict:
    town = TOWNS[(n + 6) % len(TOWNS)]
    topics = rng.sample(("pottery", "bookbinding", "woodturning", "screen printing",
                         "watch repair", "stone carving"), 2)
    a, b = (t.capitalize() for t in topics)
    room_a, room_b = distinct(rng, lambda: f"{rng.choice('BCDFGH')}{rng.randint(101, 348)}", 2)
    seats_a, seats_b = distinct(rng, lambda: rng.randint(8, 28), 2)
    tutor_a = person(rng)
    start_b = clock(rng)
    member_b, public_b = distinct(rng, lambda: money(rng, 18, 95), 2)
    fee_a = money(rng, 18, 95)
    sentences = [
        f"The {town} Craft Centre is running two evening workshops this term: {a} and {b}.",
        f"{a} is taught by {tutor_a} in room {room_a} and has {seats_a} seats.",
        f"{b} takes place in room {room_b}, starts at {start_b} and has {seats_b} seats.",
        f"The {a} workshop costs {fee_a} for everyone.",
        f"For {b}, members of the centre pay {member_b} and non-members pay {public_b}.",
    ]
    return {
        "sentences": sentences,
        "values": [str(v) for v in (room_a, room_b, seats_a, seats_b, start_b, member_b,
                                     public_b, fee_a)],
        "lookup": (f"In which room does the {b} workshop take place?", room_b),
        "combine": ("How many seats do the two workshops offer altogether?",
                    str(seats_a + seats_b)),
        "condition": (f"I am not a member of the centre. How much will the {b} workshop "
                      "cost me?", public_b),
        "absent": rng.choice((
            f"How many sessions does the {b} workshop have?",
            f"What is the minimum age for the {a} workshop?",
            f"Where can the {town} Craft Centre's visitors park?",
        )),
        "near_miss": f"Who teaches the {b} workshop?",
    }


def device(rng: random.Random, n: int) -> dict:
    brand = ("Orvane", "Kestrel", "Lumio", "Tessary", "Valdris")[n % 5]
    a, b = distinct(rng, lambda: f"{brand} {rng.choice('KRTV')}{rng.randint(2, 9)}", 2)
    grams_a, grams_b = distinct(rng, lambda: rng.randint(142, 389), 2)
    warranty_a = rng.choice([12, 18, 24, 36])
    screen_b, standby_b = distinct(rng, lambda: rng.randint(7, 41), 2)
    screen_b, standby_b = min(screen_b, standby_b), max(screen_b, standby_b) + 60
    screen_a = rng.randint(7, 41)
    charge_a, charge_b = distinct(rng, lambda: rng.randint(38, 145), 2)
    sentences = [
        f"The {a} and the {b} are the two handheld scanners in this year's catalogue.",
        f"The {a} weighs {grams_a} g, comes with a {warranty_a}-month warranty and runs for "
        f"{screen_a} hours on a charge.",
        f"The {b} weighs {grams_b} g.",
        f"With the screen on, the {b} runs for {screen_b} hours; in standby mode it lasts "
        f"{standby_b} hours.",
        f"A full charge takes {charge_a} minutes for the {a} and {charge_b} minutes for the "
        f"{b}.",
    ]
    return {
        "sentences": sentences,
        "values": [str(v) for v in (grams_a, grams_b, warranty_a, screen_a, screen_b,
                                     standby_b, charge_a, charge_b)],
        "lookup": (f"How much does the {b} weigh, in grams?", str(grams_b)),
        "combine": ("How many grams heavier is the heavier of the two scanners?",
                    str(abs(grams_a - grams_b))),
        "condition": (f"If I leave the {b} in standby mode, how many hours will it last?",
                      str(standby_b)),
        "absent": rng.choice((
            f"How much does the {a} cost?",
            f"Which operating system does the {b} run?",
            f"In which country is the {a} made?",
        )),
        "near_miss": f"How long is the warranty on the {b}, in months?",
    }


def depot(rng: random.Random, n: int) -> dict:
    town_a, town_b = TOWNS[n % len(TOWNS)], TOWNS[(n + 5) % len(TOWNS)]
    a, b = f"the {town_a} depot", f"the {town_b} depot"
    area_a, area_b = distinct(rng, lambda: rng.randint(1200, 9800), 2)
    bays_a, bays_b = distinct(rng, lambda: rng.randint(4, 31), 2)
    opened_a = rng.randint(1964, 2019)
    manager_a = person(rng)
    weekday_b, saturday_b = distinct(rng, lambda: clock(rng), 2)
    code_a, code_b = distinct(rng, lambda: f"WH-{rng.randint(1000, 9999)}", 2)
    sentences = [
        f"The company stores its spare parts at two sites, {a} (site code {code_a}) and "
        f"{b} (site code {code_b}).",
        f"{a[0].upper() + a[1:]} opened in {opened_a}, has a floor area of {area_a:,} square "
        f"metres and {bays_a} loading bays, and is managed by {manager_a}.",
        f"{b[0].upper() + b[1:]} has {area_b:,} square metres and {bays_b} loading bays.",
        f"At {b} the loading shift starts at {weekday_b} on weekdays and at {saturday_b} on "
        "Saturdays.",
    ]
    day = rng.choice(WEEKDAYS)
    return {
        "sentences": sentences,
        "values": [str(v) for v in (area_a, area_b, bays_a, bays_b, opened_a, weekday_b,
                                     saturday_b, code_a, code_b)],
        "lookup": (f"What is the site code of {b}?", code_b),
        "combine": ("How many loading bays do the two depots have in total?",
                    str(bays_a + bays_b)),
        "condition": (f"At what time does the loading shift start at {b} on a {day}?",
                      weekday_b),
        "absent": rng.choice((
            f"How many people work at {a}?",
            f"What is the annual rent of {b}?",
            f"How far apart are {a} and {b}?",
        )),
        "near_miss": f"In which year did {b} open?",
    }


def trial(rng: random.Random, n: int) -> dict:
    town = TOWNS[(n + 2) % len(TOWNS)]
    names = rng.sample(("Amberlight", "Greyfell", "Sunmere", "Rookwood", "Pale Morrow",
                        "Copperleaf"), 2)
    a, b = (f"{x} tomato" for x in names)
    yield_a, yield_b = distinct(rng, lambda: f"{rng.randint(3, 19)}.{rng.randint(1, 9)}", 2)
    water_a = rng.randint(22, 88)
    cold_b, heated_b = distinct(rng, lambda: rng.randint(52, 118), 2)
    cold_b, heated_b = max(cold_b, heated_b), min(cold_b, heated_b)
    batch_a, batch_b = distinct(rng, lambda: f"SB-{rng.randint(1000, 9999)}", 2)
    plots_a, plots_b = distinct(rng, lambda: rng.randint(6, 24), 2)
    sentences = [
        f"The {town} growers' trial compared two varieties this season, the {a} and the {b}.",
        f"The {a} (seed batch {batch_a}) was grown on {plots_a} plots, needed {water_a} "
        f"litres of water per plot each week and yielded {yield_a} kg per plot.",
        f"The {b} (seed batch {batch_b}) was grown on {plots_b} plots and yielded {yield_b} "
        "kg per plot.",
        f"Grown in the cold frame, the {b} took {cold_b} days from sowing to first harvest; "
        f"in the heated glasshouse it took {heated_b} days.",
    ]
    return {
        "sentences": sentences,
        "values": [str(v) for v in (yield_a, yield_b, water_a, cold_b, heated_b, batch_a,
                                     batch_b, plots_a, plots_b)],
        "lookup": (f"What was the seed batch of the {b}?", batch_b),
        "combine": ("How many plots were used in the trial altogether?",
                    str(plots_a + plots_b)),
        "condition": (f"How many days from sowing to first harvest did the {b} take in the "
                      "heated glasshouse?", str(heated_b)),
        "absent": rng.choice((
            f"Which fertiliser was used on the {a}?",
            "Who organised the growers' trial?",
            f"How much does a packet of {b} seed cost?",
        )),
        "near_miss": f"How many litres of water per plot did the {b} need each week?",
    }


DOMAINS = (bus, ferry, workshop, device, depot, trial)


# --------------------------------------------------------------------------------------


def _key(text: str) -> str:
    """The needle scorer's comparison key: casefolded, no spaces, commas or hyphens."""
    return re.sub(r"[ ,\-]", "", str(text).casefold())


_NUMBERISH_RE = re.compile(r"[A-Za-z]*-?\d[\d,.:]*\d|\d")


def _clean(passage: dict) -> bool:
    """No rendered value may contain another one, and no answer may hide inside any other
    number in the passage: otherwise a model that answers with the distractor could pass the
    substring test for the right answer."""
    keys = [_key(v) for v in passage["values"]]
    if len(set(keys)) != len(keys):
        return False
    if any(a != b and a in b for a in keys for b in keys):
        return False
    tokens = {_key(t) for t in _NUMBERISH_RE.findall(" ".join(passage["sentences"]))}
    for category in ("lookup", "combine", "condition"):
        answer = _key(passage[category][1])
        if any(answer != t and answer in t for t in tokens):
            return False
    # A computed answer must not also be printed in the passage, or quoting that other
    # value would pass as the computation.
    return _key(passage["combine"][1]) not in tokens


def render(rng: random.Random, passage: dict) -> str:
    sentences = list(passage["sentences"])
    opener, body = sentences[0], sentences[1:]
    rng.shuffle(body)
    filler = rng.sample(FILLER, 2)
    return " ".join([opener, filler[0], *body, filler[1]])


def prompt(passage_text: str, question: str) -> str:
    return f"{INSTRUCTION}\n\nPassage:\n{passage_text}\n\nQuestion: {question}"


def build(rng: random.Random) -> list[dict]:
    rows: list[dict] = []
    index = 0
    for domain in DOMAINS:
        for n in range(PASSAGES_PER_DOMAIN):
            for _ in range(50):
                passage = domain(rng, n)
                if _clean(passage):
                    break
            else:  # pragma: no cover - the value ranges make this unreachable in practice
                raise RuntimeError(f"{domain.__name__}: no clean passage in 50 draws")
            text = render(rng, passage)
            pid = f"p{index + 1:02d}"
            second = "combine" if index % 2 == 0 else "condition"
            planned = [
                ("lookup", "easy", *passage["lookup"]),
                (second, "hard" if second == "combine" else "medium", *passage[second]),
                ("absent", "easy", passage["absent"], ABSTAIN),
                ("near_miss", "hard", passage["near_miss"], ABSTAIN),
            ]
            for category, difficulty, question, answer in planned:
                answerable = answer is not ABSTAIN
                if answerable:
                    # The answer must be literally in the passage, except for a computed
                    # combination, whose inputs must be.
                    assert category == "combine" or str(answer) in text, (pid, question)
                rows.append(
                    {
                        "id": f"rag-{len(rows) + 1:04d}",
                        "category": category,
                        "difficulty": difficulty,
                        "prompt": prompt(text, question),
                        "answer": answer if answerable else list(ABSTAIN),
                        "scorer": "needle",
                        "meta": {
                            "passage_id": pid,
                            "domain": domain.__name__,
                            "answerable": answerable,
                            "passage_words": len(text.split()),
                        },
                    }
                )
            index += 1
    return rows


def main() -> None:
    rng = random.Random(SEED)
    rows = build(rng)
    assert len(rows) == 4 * PASSAGES_PER_DOMAIN * len(DOMAINS), len(rows)
    assert len({r["prompt"] for r in rows}) == len(rows), "duplicate prompt"
    answerable = sum(1 for r in rows if r["meta"]["answerable"])
    assert answerable * 2 == len(rows), answerable
    for row in rows:
        if not row["meta"]["answerable"]:
            continue
        # No abstention phrase may hide inside a real answer, or declining would pass it.
        assert not any(_key(p) in _key(row["answer"]) for p in ABSTAIN), row["id"]

    words = [r["meta"]["passage_words"] for r in rows]
    d = L.dataset_dir(DATASET_ID)
    n = L.write_jsonl(d / "items.jsonl", rows)
    L.write_json(
        d / "dataset.json",
        L.eval_dataset_json(
            DATASET_ID,
            "Grounded answering over a short passage v1",
            "120 questions over 30 short invented passages, half answerable from the passage "
            "and half not. Measures whether a model reads a provided context correctly "
            "(lookup with a same-type distractor, a one-step sum or difference, a stated "
            "condition) and whether it declines when the passage does not hold the answer, "
            "including the near-miss case where the passage gives the same attribute for a "
            "sibling entity.",
            rows,
            "gen_eval_rag_grounded.py",
            "needle",
            seed=SEED,
            created=CREATED,
            passages=len({r["meta"]["passage_id"] for r in rows}),
            passage_words={"min": min(words), "max": max(words)},
            abstain_phrases=ABSTAIN,
            notes=[
                "Every passage, entity, place and person is invented, so no item can be "
                "answered from memory; every answer is computed from the values rendered "
                "into the passage.",
                "Answerable rows (lookup, combine, condition) carry the value as `answer`; "
                "unanswerable rows (absent, near_miss) carry the list of accepted ways to "
                "decline, any one of which passes. The needle scorer compares casefolded "
                "text with spaces, commas and hyphens removed.",
                "A generation-time check guarantees that no rendered value in a passage is a "
                "substring of another, so answering with the distractor can never pass the "
                "substring test for the right value.",
                "Answers never need a unit: prices, times and measurements are asked as bare "
                "values, times use two-digit hours (10:05-18:55) and prices never end in 0, "
                "so formatting cannot decide an item.",
                "Always declining scores exactly 0.5; always answering scores at most 0.5. "
                "Read scores.by_category, not only accuracy.",
            ],
        ),
    )
    L.report(DATASET_ID, n)


if __name__ == "__main__":
    main()
