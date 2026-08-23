# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Generate `datasets/eval-json-v1/`.

110 structured-output items: given a short natural-language description and some
source text, produce a JSON object of a stated shape. Extraction, rule-based
classification, nested objects, arrays, aggregation, normalisation and
transformation.

Every expected object is computed from the same generated data that goes into the
prompt, so nothing is judged by taste. Items whose answer would depend on
sentiment or on an opinion are deliberately absent: the classification items
classify against a rule that is written into the prompt.

Run: `uv run datasets/_gen/gen_eval_json.py`
"""

from __future__ import annotations

import json
import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import _lib as L  # noqa: E402

SEED = 20260905
DATASET_ID = "eval-json-v1"

JSON_ONLY = "Reply with the JSON object only: no prose, no code fence, no trailing commentary."

FIRST = ("Mira", "Tomas", "Ines", "Rafael", "Nadia", "Bo", "Juno", "Emre", "Dana", "Priya",
         "Lars", "Fenna", "Cai", "Hana", "Gus")
LAST = ("Alder", "Braith", "Corvin", "Dunmore", "Ellery", "Fairbank", "Gale", "Holt",
        "Ivers", "Jarrow", "Keswick", "Lund")
CITIES = ("Aberholt", "Valcrest", "Threeford", "Kesswater", "Marren Bay", "Dunhallow")
SERVICES = ("payments", "identity", "search", "media", "billing", "notify")
LEVELS = ("ERROR", "WARN", "INFO", "DEBUG")
CURRENCIES = ("EUR", "USD", "GBP", "CHF")
MONTHS = ("January", "February", "March", "April", "May", "June", "July", "August",
          "September", "October", "November", "December")
INTENTS = {
    "I would like to cancel the order I placed yesterday.": "cancel",
    "Can you tell me where my parcel is right now?": "track",
    "The invoice you sent has the wrong postal address on it.": "billing",
    "I want to change the delivery date to next Tuesday.": "reschedule",
    "Please close my account and delete my data.": "close_account",
    "The item arrived broken and I want to send it back.": "return",
    "Stop the shipment, I no longer need what I ordered.": "cancel",
    "Which courier has my package and when will it arrive?": "track",
    "You charged me twice for the same subscription this month.": "billing",
    "Could the delivery come on Saturday morning instead?": "reschedule",
    "I would like my profile removed from your systems entirely.": "close_account",
    "The jacket does not fit, how do I send it back for a refund?": "return",
}


def name_of(rng):
    return f"{rng.choice(FIRST)} {rng.choice(LAST)}"


def add(rows, category, difficulty, prompt, answer, match="subset", schema=None):
    rows.append(
        {
            "id": f"json-{len(rows) + 1:04d}",
            "category": category,
            "difficulty": difficulty,
            "prompt": prompt,
            "answer": answer,
            "scorer": "json",
            "meta": {"match": match, **({"schema": schema} if schema else {})},
        }
    )


def f_contact(rows, rng, n):
    for _ in range(n):
        name = name_of(rng)
        city = rng.choice(CITIES)
        email = f"{name.split()[0].lower()}.{name.split()[1].lower()}@example.org"
        age = rng.randint(19, 74)
        text = (
            f"{name} has been a member since {rng.randint(2005, 2024)}. They live in {city} and "
            f"prefer to be contacted at {email}. Their age on file is {age}."
        )
        add(rows, "extraction", "easy",
            f"Extract the contact details from the text below into a JSON object with the keys "
            f"\"name\", \"email\", \"city\" and \"age\" (age as a number). {JSON_ONLY}\n\n{text}",
            {"name": name, "email": email, "city": city, "age": age},
            schema={"type": "object",
                    "properties": {"name": {"type": "string"}, "email": {"type": "string"},
                                   "city": {"type": "string"}, "age": {"type": "integer"}},
                    "required": ["name", "email", "city", "age"]})


def f_invoice(rows, rng, n):
    for _ in range(n):
        number = f"INV-{rng.randint(10_000, 99_999)}"
        cents = rng.randint(500, 250_000)
        currency = rng.choice(CURRENCIES)
        days = rng.choice([7, 14, 30, 60])
        text = (
            f"Invoice {number} was issued to a customer in {rng.choice(CITIES)} for "
            f"{cents / 100:.2f} {currency}, payable within {days} days of receipt."
        )
        add(rows, "extraction", "medium",
            f"Read the sentence and return a JSON object with \"invoice_id\" (string), "
            f"\"amount_cents\" (integer number of cents), \"currency\" (three-letter code) and "
            f"\"due_days\" (integer). {JSON_ONLY}\n\n{text}",
            {"invoice_id": number, "amount_cents": cents, "currency": currency, "due_days": days})


def f_log(rows, rng, n):
    for _ in range(n):
        level = rng.choice(LEVELS)
        service = rng.choice(SERVICES)
        code = rng.choice([200, 400, 401, 404, 429, 500, 503])
        latency = rng.randint(3, 9_000)
        tenant = f"t-{rng.randint(1000, 9999)}"
        line = (f"2026-08-{rng.randint(10, 28)}T{rng.randint(10, 23)}:15:04Z {level} "
                f"service={service} tenant={tenant} status={code} latency_ms={latency}")
        add(rows, "extraction", "medium",
            f"Parse this log line into JSON with the keys \"level\", \"service\", \"tenant\", "
            f"\"status\" (number) and \"latency_ms\" (number). {JSON_ONLY}\n\n{line}",
            {"level": level, "service": service, "tenant": tenant, "status": code,
             "latency_ms": latency})


def f_threshold(rows, rng, n):
    for _ in range(n):
        reading = rng.randint(10, 400)
        threshold = rng.randint(50, 300)
        service = rng.choice(SERVICES)
        label = "high" if reading > threshold else "low"
        add(rows, "classification", "easy",
            f"The {service} service reported a queue depth of {reading}. The alert threshold is "
            f"{threshold}: a depth strictly greater than the threshold counts as \"high\", "
            f"anything else as \"low\". Return JSON with \"service\", \"depth\" (number) and "
            f"\"level\" (\"high\" or \"low\"). {JSON_ONLY}",
            {"service": service, "depth": reading, "level": label})


def f_intent(rows, rng, n):
    keys = list(INTENTS)
    for i in range(n):
        text = keys[i % len(keys)]
        label = INTENTS[text]
        options = sorted(set(INTENTS.values()))
        add(rows, "classification", "medium",
            f"Classify the customer message below into exactly one of these intents: "
            f"{', '.join(options)}. Return JSON with \"intent\" set to the chosen value and "
            f"\"confident\" set to true. {JSON_ONLY}\n\nMessage: \"{text}\"",
            {"intent": label, "confident": True})


def f_nested(rows, rng, n):
    for _ in range(n):
        name = name_of(rng)
        user_id = rng.randint(1000, 9999)
        order_id = f"ORD-{rng.randint(100, 999)}"
        items = rng.randint(1, 9)
        city = rng.choice(CITIES)
        text = (f"Order {order_id} contains {items} items and belongs to {name} (customer "
                f"{user_id}), who is shipping to {city}.")
        add(rows, "nested", "medium",
            f"Return a JSON object of the shape "
            f"{{\"user\": {{\"id\": number, \"name\": string}}, "
            f"\"order\": {{\"id\": string, \"item_count\": number, \"ship_to\": string}}}} "
            f"for the sentence below. {JSON_ONLY}\n\n{text}",
            {"user": {"id": user_id, "name": name},
             "order": {"id": order_id, "item_count": items, "ship_to": city}})


def f_array(rows, rng, n):
    for _ in range(n):
        ids = [f"t-{rng.randint(1000, 9999)}" for _ in range(rng.randint(3, 6))]
        text = "Affected tenants: " + ", ".join(ids) + "."
        add(rows, "arrays", "easy",
            f"Return a JSON object with a single key \"tenants\" holding the list of tenant ids "
            f"from the sentence, in the order they appear. {JSON_ONLY}\n\n{text}",
            {"tenants": ids})


def f_array_objects(rows, rng, n):
    for _ in range(n):
        people = [(name_of(rng), rng.randint(20, 65)) for _ in range(3)]
        text = " ".join(f"{who} is {age}." for who, age in people)
        add(rows, "arrays", "hard",
            f"Return JSON with a key \"people\" holding an array of objects, each with \"name\" "
            f"and \"age\" (number), in the order given. {JSON_ONLY}\n\n{text}",
            {"people": [{"name": who, "age": age} for who, age in people]})


def f_aggregate(rows, rng, n):
    for _ in range(n):
        values = [rng.randint(2, 400) for _ in range(rng.randint(3, 6))]
        text = "Measured values: " + ", ".join(map(str, values)) + "."
        add(rows, "aggregation", "medium",
            f"Return JSON with \"count\", \"total\", \"max\" and \"min\" for the values below, all "
            f"as numbers. {JSON_ONLY}\n\n{text}",
            {"count": len(values), "total": sum(values), "max": max(values), "min": min(values)})


def f_date(rows, rng, n):
    for _ in range(n):
        day = rng.randint(1, 28)
        month = rng.randint(1, 12)
        year = rng.randint(2019, 2030)
        text = f"{day} {MONTHS[month - 1]} {year}"
        add(rows, "normalisation", "medium",
            f"Normalise the date below. Return JSON with \"date\" in the exact form YYYY-MM-DD "
            f"and \"weekday_known\" set to false. {JSON_ONLY}\n\nDate: {text}",
            {"date": f"{year:04d}-{month:02d}-{day:02d}", "weekday_known": False})


def f_kv_transform(rows, rng, n):
    for _ in range(n):
        pairs = {
            "region": rng.choice(["eu-west", "eu-central", "us-east", "ap-south"]),
            "retries": rng.randint(0, 9),
            "enabled": rng.choice([True, False]),
        }
        line = ";".join(
            f"{k}={str(v).lower() if isinstance(v, bool) else v}" for k, v in pairs.items()
        )
        add(rows, "transformation", "medium",
            f"Convert this configuration line into a JSON object. Keep the key names, turn numeric "
            f"values into numbers and true/false into booleans. {JSON_ONLY}\n\n{line}",
            pairs, match="exact")


def f_absent(rows, rng, n):
    for _ in range(n):
        name = name_of(rng)
        text = f"{name} joined in {rng.randint(2010, 2024)}. No telephone number is on file."
        add(rows, "extraction", "hard",
            f"Return JSON with \"name\" and \"phone\". When the text does not give a telephone "
            f"number, \"phone\" must be null — do not invent one. {JSON_ONLY}\n\n{text}",
            {"name": name, "phone": None})


FAMILIES = (
    (f_contact, 12), (f_invoice, 12), (f_log, 12), (f_threshold, 10), (f_intent, 12),
    (f_nested, 10), (f_array, 10), (f_array_objects, 8), (f_aggregate, 10), (f_date, 6),
    (f_kv_transform, 4), (f_absent, 4),
)


def main() -> None:
    rng = random.Random(SEED)
    rows: list[dict] = []
    for family, count in FAMILIES:
        family(rows, rng, count)

    prompts = {r["prompt"] for r in rows}
    assert len(prompts) == len(rows), "duplicate prompt"
    for row in rows:
        json.dumps(row["answer"])  # the expected value must be serialisable

    d = L.dataset_dir(DATASET_ID)
    n = L.write_jsonl(d / "items.jsonl", rows)
    L.write_json(
        d / "dataset.json",
        L.eval_dataset_json(
            DATASET_ID,
            "Structured output eval v1",
            "110 items that ask for JSON of a described shape: field extraction from prose and "
            "from log lines, rule-based classification, nested objects, arrays of scalars and of "
            "objects, aggregation, date normalisation, config transformation, and correctly "
            "emitting null for information that is not in the source.",
            rows,
            "gen_eval_json.py",
            "json",
            seed=SEED,
            notes=[
                "Scoring: parse the extracted output as JSON (a surrounding ``` fence is "
                "stripped first). meta.match is 'subset' by default — every key and value in "
                "`answer` must be present and equal, extra keys are tolerated — or 'exact', "
                "which additionally forbids extra keys.",
                "Numbers compare numerically, so 7 and 7.0 both pass. Strings compare exactly, "
                "including case.",
                "Arrays compare elementwise in order.",
                "Output that is not valid JSON is simply incorrect; it is not a request failure "
                "and must not be counted as one.",
                "meta.schema, where present, describes the expected object. Validating against it "
                "is optional; equality with `answer` is what decides the score.",
            ],
        ),
    )
    L.report(DATASET_ID, n)


if __name__ == "__main__":
    main()
