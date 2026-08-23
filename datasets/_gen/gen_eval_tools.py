# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Generate `datasets/eval-tools-v1/`.

80 tool-calling items: 60 where exactly one tool call is correct and its arguments
follow unambiguously from the request, and 20 where no tool applies and the model
is expected to answer directly.

Every item carries its own tool catalogue in `meta.tools` (OpenAI function-calling
schemas), containing the right tool plus two or three plausible distractors. The
harness sends `meta.tools` as the `tools` parameter and inspects the FIRST tool
call in the response.

Run: `uv run datasets/_gen/gen_eval_tools.py`
"""

from __future__ import annotations

import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import _lib as L  # noqa: E402

SEED = 20260906
DATASET_ID = "eval-tools-v1"

SYSTEM = (
    "You are an assistant with access to the tools below. Call a tool when it is the right way "
    "to answer, and answer directly when no tool applies. Never invent a tool."
)


def tool(name: str, description: str, properties: dict, required: list[str]) -> dict:
    return {
        "type": "function",
        "function": {
            "name": name,
            "description": description,
            "parameters": {
                "type": "object",
                "properties": properties,
                "required": required,
                "additionalProperties": False,
            },
        },
    }


TOOLS = {
    "get_weather": tool(
        "get_weather", "Get the current weather for a city.",
        {"city": {"type": "string", "description": "City name"},
         "unit": {"type": "string", "enum": ["celsius", "fahrenheit"],
                  "description": "Temperature unit"}},
        ["city"]),
    "search_flights": tool(
        "search_flights", "Search for flights between two cities on a date.",
        {"origin": {"type": "string"}, "destination": {"type": "string"},
         "date": {"type": "string", "description": "YYYY-MM-DD"},
         "passengers": {"type": "integer", "minimum": 1}},
        ["origin", "destination", "date"]),
    "create_calendar_event": tool(
        "create_calendar_event", "Create an event in the user's calendar.",
        {"title": {"type": "string"}, "start": {"type": "string", "description": "ISO 8601"},
         "duration_minutes": {"type": "integer"}},
        ["title", "start", "duration_minutes"]),
    "send_email": tool(
        "send_email", "Send an email on behalf of the user.",
        {"to": {"type": "string"}, "subject": {"type": "string"}, "body": {"type": "string"}},
        ["to", "subject", "body"]),
    "convert_currency": tool(
        "convert_currency", "Convert an amount from one currency to another at today's rate.",
        {"amount": {"type": "number"}, "from_currency": {"type": "string"},
         "to_currency": {"type": "string"}},
        ["amount", "from_currency", "to_currency"]),
    "get_stock_quote": tool(
        "get_stock_quote", "Get the latest quote for a stock ticker.",
        {"symbol": {"type": "string", "description": "Ticker symbol, upper case"}},
        ["symbol"]),
    "translate_text": tool(
        "translate_text", "Translate text into a target language.",
        {"text": {"type": "string"},
         "target_language": {"type": "string", "description": "ISO 639-1 code"}},
        ["text", "target_language"]),
    "set_reminder": tool(
        "set_reminder", "Create a reminder at a given time.",
        {"text": {"type": "string"}, "due": {"type": "string", "description": "ISO 8601"}},
        ["text", "due"]),
    "find_restaurant": tool(
        "find_restaurant", "Find a restaurant in a city.",
        {"city": {"type": "string"}, "cuisine": {"type": "string"},
         "party_size": {"type": "integer", "minimum": 1}},
        ["city", "cuisine", "party_size"]),
    "get_directions": tool(
        "get_directions", "Get travel directions between two places.",
        {"origin": {"type": "string"}, "destination": {"type": "string"},
         "mode": {"type": "string", "enum": ["driving", "walking", "cycling", "transit"]}},
        ["origin", "destination", "mode"]),
    "lookup_order": tool(
        "lookup_order", "Look up the status of a customer order.",
        {"order_id": {"type": "string"}},
        ["order_id"]),
    "create_ticket": tool(
        "create_ticket", "File an issue in the tracker.",
        {"title": {"type": "string"},
         "priority": {"type": "string", "enum": ["low", "medium", "high", "urgent"]},
         "component": {"type": "string"}},
        ["title", "priority", "component"]),
    "book_meeting_room": tool(
        "book_meeting_room", "Book a meeting room for a period of time.",
        {"room": {"type": "string"}, "start": {"type": "string", "description": "ISO 8601"},
         "minutes": {"type": "integer"}},
        ["room", "start", "minutes"]),
    "unit_convert": tool(
        "unit_convert", "Convert a value between two units of measurement.",
        {"value": {"type": "number"}, "from_unit": {"type": "string"}, "to_unit": {"type": "string"}},
        ["value", "from_unit", "to_unit"]),
}

CITIES = ("Kesswater", "Aberholt", "Valcrest", "Threeford", "Marren Bay", "Dunhallow", "Oldmarsh")
TICKERS = ("ACME", "NTRX", "VLCR", "KSWT", "ORBP")
CURRENCIES = ("EUR", "USD", "GBP", "CHF", "JPY")
LANGS = {"German": "de", "French": "fr", "Spanish": "es", "Japanese": "ja", "Arabic": "ar",
         "Italian": "it", "Turkish": "tr"}
COMPONENTS = ("billing", "search", "auth", "notifications", "reporting")


def item(rng, rows, difficulty, request, name, arguments, arguments_match="subset"):
    distractors = [t for t in sorted(TOOLS) if t != name]
    rng.shuffle(distractors)
    catalogue = [TOOLS[name]] + [TOOLS[d] for d in distractors[: rng.choice([2, 3])]]
    rng.shuffle(catalogue)
    rows.append(
        {
            "id": f"tools-{len(rows) + 1:04d}",
            "category": "single_call",
            "difficulty": difficulty,
            "prompt": request,
            "messages": [{"role": "system", "content": SYSTEM},
                         {"role": "user", "content": request}],
            "answer": {"tool_call": {"name": name, "arguments": arguments}},
            "scorer": "json",
            "meta": {"tools": catalogue, "arguments_match": arguments_match,
                     "tool_choice": "auto"},
        }
    )


def no_call(rng, rows, difficulty, request):
    names = sorted(TOOLS)
    rng.shuffle(names)
    catalogue = [TOOLS[n] for n in names[: rng.choice([3, 4])]]
    rows.append(
        {
            "id": f"tools-{len(rows) + 1:04d}",
            "category": "no_call",
            "difficulty": difficulty,
            "prompt": request,
            "messages": [{"role": "system", "content": SYSTEM},
                         {"role": "user", "content": request}],
            "answer": {"tool_call": None},
            "scorer": "json",
            "meta": {"tools": catalogue, "tool_choice": "auto"},
        }
    )


def build(rng) -> list[dict]:
    rows: list[dict] = []

    for i in range(5):
        city = CITIES[i % len(CITIES)]
        if i % 2:
            item(rng, rows, "easy", f"What is the weather like in {city} right now?",
                 "get_weather", {"city": city})
        else:
            unit = "fahrenheit" if i % 4 == 0 else "celsius"
            item(rng, rows, "medium",
                 f"Tell me the current temperature in {city}, in {unit}.",
                 "get_weather", {"city": city, "unit": unit})

    for i in range(5):
        origin, dest = CITIES[i % 7], CITIES[(i + 3) % 7]
        day = 10 + i
        passengers = rng.choice([1, 2, 3, 4])
        if i % 2:
            item(rng, rows, "medium",
                 f"Find me a flight from {origin} to {dest} on 2026-09-{day:02d} for "
                 f"{passengers} people.",
                 "search_flights",
                 {"origin": origin, "destination": dest, "date": f"2026-09-{day:02d}",
                  "passengers": passengers})
        else:
            item(rng, rows, "easy",
                 f"I need to fly from {origin} to {dest} on 2026-09-{day:02d}. What is available?",
                 "search_flights",
                 {"origin": origin, "destination": dest, "date": f"2026-09-{day:02d}"})

    titles = ("Dentist", "Team retro", "Budget review", "Handover call", "Site visit", "One to one")
    for i in range(5):
        hour = 9 + i
        minutes = rng.choice([30, 45, 60, 90])
        item(rng, rows, "medium",
             f"Put \"{titles[i]}\" in my calendar for 2026-09-0{i + 1} at {hour:02d}:00 for "
             f"{minutes} minutes.",
             "create_calendar_event",
             {"title": titles[i], "start": f"2026-09-0{i + 1}T{hour:02d}:00:00",
              "duration_minutes": minutes})

    for i in range(5):
        who = ("ines", "tomas", "nadia", "rafael", "juno")[i]
        item(rng, rows, "medium",
             f"Email {who}@example.org with the subject \"Invoice {2000 + i}\" and the body "
             f"\"The invoice is attached, please confirm receipt.\"",
             "send_email",
             {"to": f"{who}@example.org", "subject": f"Invoice {2000 + i}",
              "body": "The invoice is attached, please confirm receipt."})

    for i in range(5):
        amount = rng.choice([25, 120, 480, 1500, 99.5, 12.75])
        src, dst = CURRENCIES[i % 5], CURRENCIES[(i + 2) % 5]
        item(rng, rows, "easy",
             f"How much is {amount} {src} in {dst} today?",
             "convert_currency",
             {"amount": amount, "from_currency": src, "to_currency": dst})

    for i in range(5):
        symbol = TICKERS[i % len(TICKERS)]
        item(rng, rows, "easy", f"What is {symbol} trading at right now?",
             "get_stock_quote", {"symbol": symbol})

    phrases = ("Where is the nearest pharmacy?", "The lift is out of order.",
               "Please leave the parcel with a neighbour.", "The meeting has been moved.",
               "Thank you for your help yesterday.")
    langs = list(LANGS)
    for i in range(4):
        language = langs[i % len(langs)]
        item(rng, rows, "medium",
             f"Translate \"{phrases[i]}\" into {language}.",
             "translate_text", {"text": phrases[i], "target_language": LANGS[language]})

    tasks = ("call the landlord", "renew the parking permit", "back up the laptop",
             "book the annual service", "send the meter reading")
    for i in range(5):
        item(rng, rows, "medium",
             f"Remind me to {tasks[i]} on 2026-10-{12 + i:02d} at 08:30.",
             "set_reminder", {"text": tasks[i], "due": f"2026-10-{12 + i:02d}T08:30:00"})

    cuisines = ("Georgian", "Vietnamese", "Ethiopian", "Portuguese", "Lebanese")
    for i in range(4):
        city = CITIES[(i + 2) % len(CITIES)]
        size = rng.choice([2, 4, 6, 8])
        item(rng, rows, "medium",
             f"Book-worthy {cuisines[i]} places in {city} for {size} of us — find one.",
             "find_restaurant", {"city": city, "cuisine": cuisines[i], "party_size": size})

    modes = ("driving", "walking", "cycling", "transit")
    for i in range(3):
        origin, dest = CITIES[i], CITIES[(i + 4) % 7]
        item(rng, rows, "medium",
             f"How do I get from {origin} to {dest} by {modes[i]}?",
             "get_directions", {"origin": origin, "destination": dest, "mode": modes[i]})

    for i in range(4):
        order = f"ORD-{7000 + i * 13}"
        item(rng, rows, "easy", f"Where has my order {order} got to?",
             "lookup_order", {"order_id": order})

    problems = ("Export button does nothing", "Password reset email never arrives",
               "Report totals are off by one day", "Push notifications arrive twice")
    priorities = ("high", "urgent", "medium", "low")
    for i in range(4):
        item(rng, rows, "hard",
             f"File a {priorities[i]}-priority issue on the {COMPONENTS[i]} component titled "
             f"\"{problems[i]}\".",
             "create_ticket",
             {"title": problems[i], "priority": priorities[i], "component": COMPONENTS[i]})

    for i in range(3):
        room = ("Ash", "Birch", "Cedar")[i]
        item(rng, rows, "hard",
             f"Reserve the {room} room on 2026-11-0{i + 3} from 14:00 for 45 minutes.",
             "book_meeting_room",
             {"room": room, "start": f"2026-11-0{i + 3}T14:00:00", "minutes": 45})

    conversions = ((12, "miles", "kilometres"), (3.5, "kilograms", "pounds"),
                   (450, "millilitres", "cups"))
    for value, src, dst in conversions:
        item(rng, rows, "medium", f"Convert {value} {src} to {dst}.",
             "unit_convert", {"value": value, "from_unit": src, "to_unit": dst})

    direct = (
        ("easy", "What is 12 multiplied by 12?"),
        ("easy", "Explain in two sentences what a variable is in programming."),
        ("easy", "How many days are there in a leap year?"),
        ("medium", "Give me three ideas for a cheap weekend with two children."),
        ("easy", "What does the acronym HTTP stand for?"),
        ("medium", "Rewrite this sentence more politely: 'Send me the file now.'"),
        ("easy", "Which is heavier, a kilogram of feathers or a kilogram of steel?"),
        ("medium", "Summarise the difference between a stack and a queue."),
        ("easy", "Spell the word 'necessary' backwards."),
        ("medium", "Write a two-line thank-you note for a colleague who covered a shift."),
        ("hard", "I am thinking about learning a language. Which would you pick and why?"),
        ("easy", "What is the capital city of Portugal?"),
        ("medium", "Explain why a checklist helps under time pressure."),
        ("easy", "Convert the binary number 1011 to decimal in your head and tell me the result."),
        ("medium", "Suggest a subject line for an email asking for a deadline extension."),
        ("hard", "My code prints nothing and exits 0. What are the three most likely causes?"),
        ("easy", "What is the plural of 'analysis'?"),
        ("medium", "Give me a two-sentence definition of latency for a non-technical reader."),
        ("hard", "Argue briefly for and against working from home two days a week."),
        ("easy", "How many minutes are there in a day?"),
    )
    for difficulty, request in direct:
        no_call(rng, rows, difficulty, request)

    return rows


def main() -> None:
    rng = random.Random(SEED)
    rows = build(rng)
    assert len({r["prompt"] for r in rows}) == len(rows), "duplicate prompt"
    calls = [r for r in rows if r["category"] == "single_call"]
    assert len(calls) == 60, len(calls)
    for row in calls:
        expected = row["answer"]["tool_call"]
        names = [t["function"]["name"] for t in row["meta"]["tools"]]
        assert expected["name"] in names, row["id"]
        schema = next(t for t in row["meta"]["tools"] if t["function"]["name"] == expected["name"])
        params = schema["function"]["parameters"]
        for key in expected["arguments"]:
            assert key in params["properties"], (row["id"], key)
        for key in params["required"]:
            assert key in expected["arguments"], (row["id"], key)

    d = L.dataset_dir(DATASET_ID)
    n = L.write_jsonl(d / "items.jsonl", rows)
    L.write_json(
        d / "dataset.json",
        L.eval_dataset_json(
            DATASET_ID,
            "Tool calling eval v1",
            "80 tool-calling items over a catalogue of 14 OpenAI-style function schemas: 60 "
            "requests where exactly one call with unambiguous arguments is correct, and 20 "
            "requests that need no tool at all and must be answered directly.",
            rows,
            "gen_eval_tools.py",
            "json",
            seed=SEED,
            tool_catalogue=sorted(TOOLS),
            notes=[
                "The harness sends meta.tools as the request's `tools` parameter with "
                "tool_choice='auto', and scores the FIRST entry of response.tool_calls.",
                "For a single_call item: the call is correct when tool_calls[0].function.name "
                "equals answer.tool_call.name AND the parsed arguments match "
                "answer.tool_call.arguments. Matching is subset by default (extra optional "
                "arguments are tolerated) unless meta.arguments_match is 'exact'. String values "
                "compare case-insensitively after stripping; numbers compare numerically.",
                "For a no_call item the response must contain no tool call at all; the text of "
                "the reply is not scored.",
                "Every item's expected arguments are validated at generation time against the "
                "tool's own JSON schema: keys exist, and every required parameter is present.",
                "Engines differ in how they emit tool calls (native field vs a parsed text "
                "block). Record the parser flag used in the result's args, because it changes "
                "the score.",
            ],
        ),
    )
    L.report(DATASET_ID, n)


if __name__ == "__main__":
    main()
