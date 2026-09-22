# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Generate `datasets/eval-tools-small-v1/`.

100 tool-use items at the scale a phone or a small local model actually sees: one or two
tools per request, a date in the system prompt, and short conversations that already
contain earlier calls and their results. `eval-tools-v1` asks for one call whose arguments
are copied straight out of the request, and small models saturate it (google/gemma-4-E2B-it
scores 1.00 on two engines); this suite asks for the parts of tool use that are still hard
at 1-3B:

  * ``derive_args`` (20) — the arguments have to be worked out, not copied: "this coming
    Thursday at half past three in the afternoon" against today's date, "an hour and a
    quarter" as minutes, "two dozen" as a count, Fahrenheit into a tool that takes Celsius;
  * ``pick_tool``   (20) — two near-identical tools (current weather vs forecast, one order
    vs all orders, SMS vs email, a rate vs a conversion) and the request decides which;
  * ``clarify``     (15) — a required argument is missing, and the right move is to ask
                     instead of inventing one: correct only when no call is made;
  * ``chain``       (20) — the conversation holds the first call and its result, and the
                     next call needs a value out of that result (a customer id, the cheapest
                     flight, a coordinate pair);
  * ``use_result``  (15) — the tool result already answers the question: correct only when
                     no further call is made AND the reply contains the value;
  * ``revise``      (10) — after a completed call the user changes one detail, and the new
                     call must carry the change and keep everything else.

Every expected argument is computed — dates with `datetime`, times and durations from
their components, conversions arithmetically — and validated against the tool's own
schema at generation time.

Run: `uv run datasets/_gen/gen_eval_tools_small.py`
"""

from __future__ import annotations

import datetime as dt
import json
import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import _lib as L  # noqa: E402

SEED = 20260923
DATASET_ID = "eval-tools-small-v1"
CREATED = "2026-09-22"

CITIES = ("Kesswater", "Aberholt", "Valcrest", "Threeford", "Marren Bay", "Dunhallow",
          "Oldmarsh", "Brightwell")
RESTAURANTS = ("Ferro", "Olmo", "Brasa", "Saltrock", "Juniper", "Lanterna")
FIRST = ("Mira", "Tomas", "Ines", "Rafael", "Nadia", "Juno", "Emre", "Dana", "Priya", "Lars")
LAST = ("Alder", "Braith", "Corvin", "Dunmore", "Ellery", "Fairbank", "Holt", "Ivers")
CURRENCIES = ("EUR", "USD", "GBP", "CHF", "JPY", "SEK")
NUMBER_WORDS = {2: "two", 3: "three", 4: "four", 5: "five", 6: "six", 7: "seven", 8: "eight"}
WEEKDAY_NAMES = ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")


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


DATE = {"type": "string", "description": "Calendar date, YYYY-MM-DD"}
TIME = {"type": "string", "description": "24-hour time, HH:MM"}

TOOLS = {
    "set_reminder": tool(
        "set_reminder", "Create a reminder that fires at a date and time.",
        {"date": DATE, "time": TIME,
         "note": {"type": "string", "description": "What to be reminded about"}},
        ["date", "time"]),
    "start_timer": tool(
        "start_timer", "Start a countdown timer.",
        {"minutes": {"type": "integer", "minimum": 1, "description": "Length in minutes"}},
        ["minutes"]),
    "order_groceries": tool(
        "order_groceries", "Add an item to the grocery order.",
        {"item": {"type": "string", "enum": ["eggs", "apples", "bread rolls", "lemons"]},
         "quantity": {"type": "integer", "minimum": 1, "description": "Number of pieces"}},
        ["item", "quantity"]),
    "set_thermostat": tool(
        "set_thermostat", "Set the target room temperature.",
        {"celsius": {"type": "number", "description": "Target temperature in degrees Celsius"}},
        ["celsius"]),
    "book_table": tool(
        "book_table", "Reserve a table at a restaurant.",
        {"restaurant": {"type": "string"}, "date": DATE, "time": TIME,
         "party_size": {"type": "integer", "minimum": 1}},
        ["restaurant", "date", "time", "party_size"]),
    "get_current_weather": tool(
        "get_current_weather", "Current conditions in a city, right now.",
        {"city": {"type": "string"}},
        ["city"]),
    "get_forecast": tool(
        "get_forecast", "Weather forecast for a city on a future date.",
        {"city": {"type": "string"}, "date": DATE},
        ["city", "date"]),
    "lookup_order": tool(
        "lookup_order", "Status of one order, by order id.",
        {"order_id": {"type": "string"}},
        ["order_id"]),
    "list_orders": tool(
        "list_orders", "All orders placed by a customer, by the customer's email address.",
        {"email": {"type": "string"}},
        ["email"]),
    "send_sms": tool(
        "send_sms", "Send a text message to a phone number.",
        {"phone": {"type": "string", "description": "E.164, e.g. +4915112345678"},
         "text": {"type": "string"}},
        ["phone", "text"]),
    "send_email": tool(
        "send_email", "Send an email.",
        {"to": {"type": "string"}, "subject": {"type": "string"}, "body": {"type": "string"}},
        ["to", "subject", "body"]),
    "get_exchange_rate": tool(
        "get_exchange_rate", "Today's exchange rate between two currencies.",
        {"from_currency": {"type": "string"}, "to_currency": {"type": "string"}},
        ["from_currency", "to_currency"]),
    "convert_amount": tool(
        "convert_amount", "Convert an amount of money into another currency at today's rate.",
        {"amount": {"type": "number"}, "from_currency": {"type": "string"},
         "to_currency": {"type": "string"}},
        ["amount", "from_currency", "to_currency"]),
    "find_customer": tool(
        "find_customer", "Find a customer record by email address.",
        {"email": {"type": "string"}},
        ["email"]),
    "list_invoices": tool(
        "list_invoices", "List a customer's invoices, filtered by status.",
        {"customer_id": {"type": "string"},
         "status": {"type": "string", "enum": ["paid", "unpaid", "overdue"]}},
        ["customer_id", "status"]),
    "search_flights": tool(
        "search_flights", "Search for flights between two cities on a date.",
        {"origin": {"type": "string"}, "destination": {"type": "string"}, "date": DATE},
        ["origin", "destination", "date"]),
    "book_flight": tool(
        "book_flight", "Book one flight returned by search_flights.",
        {"flight_id": {"type": "string"}},
        ["flight_id"]),
    "create_return": tool(
        "create_return", "Open a return for a delivered order.",
        {"order_id": {"type": "string"},
         "reason": {"type": "string", "enum": ["damaged", "wrong_item", "not_needed"]}},
        ["order_id", "reason"]),
    "geocode": tool(
        "geocode", "Latitude and longitude of a place.",
        {"place": {"type": "string"}},
        ["place"]),
    "get_air_quality": tool(
        "get_air_quality", "Air-quality index at a coordinate.",
        {"lat": {"type": "number"}, "lon": {"type": "number"}},
        ["lat", "lon"]),
}


# --------------------------------------------------------------------------------------
# helpers: dates, spoken times, messages
# --------------------------------------------------------------------------------------


def today(rng: random.Random) -> dt.date:
    return dt.date(2026, 10, 1) + dt.timedelta(days=rng.randint(0, 60))


def system_prompt(day: dt.date) -> str:
    return (
        "You are an assistant on the user's phone. "
        f"Today is {WEEKDAY_NAMES[day.weekday()]}, {day.isoformat()}. "
        "Use a tool when the request needs one. If a detail that a tool requires is missing, "
        "ask the user for it instead of guessing. When a tool result already answers the "
        "question, answer in plain text without calling a tool again."
    )


def twelve(hour: int) -> int:
    return hour - 12 if hour > 12 else hour


def period(hour: int) -> str:
    return "in the morning" if hour < 12 else ("in the afternoon" if hour < 18 else
                                                "in the evening")


def spoken_time(hour: int, minute: int) -> str:
    """"half past three in the afternoon" for (15, 30). The expected HH:MM is computed from
    the same (hour, minute) pair, never read back out of the phrase."""
    if minute == 0:
        return f"{twelve(hour)} o'clock {period(hour)}"
    if minute == 15:
        return f"quarter past {twelve(hour)} {period(hour)}"
    if minute == 30:
        return f"half past {twelve(hour)} {period(hour)}"
    if minute == 45:
        return f"quarter to {twelve(hour + 1)} {period(hour)}"
    raise ValueError(minute)


def hhmm(hour: int, minute: int) -> str:
    return f"{hour:02d}:{minute:02d}"


def relative_day(rng: random.Random, base: dt.date) -> tuple[str, dt.date]:
    """A relative day phrase and the date it resolves to."""
    kind = rng.choice(("tomorrow", "after", "weekday", "days", "week"))
    if kind == "tomorrow":
        return "tomorrow", base + dt.timedelta(days=1)
    if kind == "after":
        return "the day after tomorrow", base + dt.timedelta(days=2)
    if kind == "days":
        n = rng.randint(3, 12)
        return f"in {n} days", base + dt.timedelta(days=n)
    if kind == "week":
        return "a week from today", base + dt.timedelta(days=7)
    # "this coming <weekday>": the next occurrence strictly after today.
    ahead = rng.randint(2, 6)
    target = base + dt.timedelta(days=ahead)
    return f"this coming {WEEKDAY_NAMES[target.weekday()]}", target


def call(call_id: str, name: str, arguments: dict) -> dict:
    return {"role": "assistant", "content": "", "tool_calls": [
        {"id": call_id, "type": "function",
         "function": {"name": name, "arguments": json.dumps(arguments, ensure_ascii=False)}}]}


def result(call_id: str, payload: dict) -> dict:
    return {"role": "tool", "tool_call_id": call_id,
            "content": json.dumps(payload, ensure_ascii=False)}


def email(rng: random.Random) -> tuple[str, str]:
    first, last = rng.choice(FIRST), rng.choice(LAST)
    return f"{first} {last}", f"{first.lower()}.{last.lower()}@example.org"


class Rows:
    def __init__(self, rng: random.Random) -> None:
        self.rng = rng
        self.rows: list[dict] = []

    def add(self, category: str, difficulty: str, day: dt.date, turns: list[dict],
            tools: list[str], expected: dict | None, reply_contains: list | None = None,
            arguments_match: str = "subset") -> None:
        catalogue = [TOOLS[t] for t in tools]
        self.rng.shuffle(catalogue)
        answer: dict = {"tool_call": expected}
        if reply_contains is not None:
            answer["reply_contains"] = reply_contains
        meta = {"tools": catalogue, "tool_choice": "auto", "today": day.isoformat()}
        if expected is not None:
            meta["arguments_match"] = arguments_match
        last_user = next(t["content"] for t in reversed(turns) if t["role"] == "user")
        self.rows.append({
            "id": f"tsm-{len(self.rows) + 1:04d}",
            "category": category,
            "difficulty": difficulty,
            "prompt": last_user,
            "messages": [{"role": "system", "content": system_prompt(day)}, *turns],
            "answer": answer,
            "scorer": "json",
            "meta": meta,
        })


# --------------------------------------------------------------------------------------
# categories
# --------------------------------------------------------------------------------------

TIMER_PHRASES = (  # (phrase, hours, minutes)
    ("an hour and a quarter", 1, 15), ("two and a half hours", 2, 30),
    ("three quarters of an hour", 0, 45), ("an hour and forty minutes", 1, 40),
)
DOZENS = (("half a dozen", 0.5), ("a dozen", 1), ("a dozen and a half", 1.5),
          ("two dozen", 2), ("three dozen", 3))
NOTES = ("call the landlord", "renew the parking permit", "water the plants",
         "send the meter reading", "pick up the dry cleaning")


def derive_args(out: Rows) -> None:
    rng = out.rng
    for i in range(4):
        day = today(rng)
        phrase, target = relative_day(rng, day)
        hour, minute = rng.choice(((8, 45), (15, 30), (19, 15), (10, 0), (13, 30)))
        note = NOTES[i]
        out.add("derive_args", "medium", day,
                [{"role": "user", "content":
                  f"Remind me to {note} {phrase} at {spoken_time(hour, minute)}."}],
                ["set_reminder"],
                {"name": "set_reminder",
                 "arguments": {"date": target.isoformat(), "time": hhmm(hour, minute)}})
    for phrase, hours, minutes in TIMER_PHRASES:
        out.add("derive_args", "easy", today(rng),
                [{"role": "user", "content": f"Set a timer for {phrase}."}],
                ["start_timer"],
                {"name": "start_timer", "arguments": {"minutes": hours * 60 + minutes}})
    items = ("eggs", "apples", "bread rolls", "lemons")
    for i in range(4):
        phrase, dozens = DOZENS[(i + 1) % len(DOZENS)]
        item = items[i]
        out.add("derive_args", "easy", today(rng),
                [{"role": "user", "content": f"Add {phrase} {item} to the grocery order."}],
                ["order_groceries"],
                {"name": "order_groceries",
                 "arguments": {"item": item, "quantity": int(dozens * 12)}})
    for fahrenheit in (50, 59, 68, 77):
        celsius = (fahrenheit - 32) * 5 / 9
        assert celsius == int(celsius)
        out.add("derive_args", "medium", today(rng),
                [{"role": "user", "content":
                  f"My guest asked for {fahrenheit} degrees Fahrenheit. Set the heating to "
                  "that."}],
                ["set_thermostat"],
                {"name": "set_thermostat", "arguments": {"celsius": int(celsius)}})
    for i in range(4):
        day = today(rng)
        phrase, target = relative_day(rng, day)
        hour = rng.choice((18, 19, 20))
        minute = rng.choice((0, 30))
        size = rng.choice(sorted(NUMBER_WORDS))
        restaurant = RESTAURANTS[i]
        out.add("derive_args", "medium", day,
                [{"role": "user", "content":
                  f"Get us a table at {restaurant} {phrase}, {spoken_time(hour, minute)}, for "
                  f"{NUMBER_WORDS[size]} people."}],
                ["book_table"],
                {"name": "book_table",
                 "arguments": {"restaurant": restaurant, "date": target.isoformat(),
                               "time": hhmm(hour, minute), "party_size": size}})


def pick_tool(out: Rows) -> None:
    rng = out.rng
    for i in range(5):
        day = today(rng)
        city = CITIES[i]
        if i % 2 == 0:
            phrase, target = relative_day(rng, day)
            out.add("pick_tool", "medium", day,
                    [{"role": "user", "content": f"Will I need a coat in {city} {phrase}?"}],
                    ["get_current_weather", "get_forecast"],
                    {"name": "get_forecast",
                     "arguments": {"city": city, "date": target.isoformat()}})
        else:
            out.add("pick_tool", "easy", day,
                    [{"role": "user", "content": f"Is it raining in {city} at the moment?"}],
                    ["get_current_weather", "get_forecast"],
                    {"name": "get_current_weather", "arguments": {"city": city}})
    for i in range(5):
        name, address = email(rng)
        order = f"ORD-{rng.randint(10000, 99999)}"
        if i % 2 == 0:
            out.add("pick_tool", "easy", today(rng),
                    [{"role": "user", "content": f"Has order {order} shipped yet?"}],
                    ["lookup_order", "list_orders"],
                    {"name": "lookup_order", "arguments": {"order_id": order}})
        else:
            out.add("pick_tool", "medium", today(rng),
                    [{"role": "user", "content":
                      f"Show me everything I have ordered so far. My account email is "
                      f"{address}."}],
                    ["lookup_order", "list_orders"],
                    {"name": "list_orders", "arguments": {"email": address}})
    messages = ("Running ten minutes late", "Dinner is at eight", "Parcel is at the door",
                "Meeting moved to Friday", "Call me when you land")
    for i in range(5):
        _, address = email(rng)
        text = messages[i]
        if i % 2 == 0:
            phone = f"+49151{rng.randint(10000000, 99999999)}"
            out.add("pick_tool", "medium", today(rng),
                    [{"role": "user", "content":
                      f"Text {phone} with exactly this message: \"{text}\""}],
                    ["send_sms", "send_email"],
                    {"name": "send_sms", "arguments": {"phone": phone, "text": text}})
        else:
            out.add("pick_tool", "medium", today(rng),
                    [{"role": "user", "content":
                      f"Email {address} with the subject \"Update\" and exactly this body: "
                      f"\"{text}\""}],
                    ["send_sms", "send_email"],
                    {"name": "send_email",
                     "arguments": {"to": address, "subject": "Update", "body": text}})
    for i in range(5):
        src, dst = rng.sample(CURRENCIES, 2)
        if i % 2 == 0:
            amount = rng.choice((40, 125, 260, 75.5, 1200))
            out.add("pick_tool", "easy", today(rng),
                    [{"role": "user", "content": f"How much is {amount} {src} in {dst}?"}],
                    ["get_exchange_rate", "convert_amount"],
                    {"name": "convert_amount",
                     "arguments": {"amount": amount, "from_currency": src,
                                   "to_currency": dst}})
        else:
            out.add("pick_tool", "medium", today(rng),
                    [{"role": "user", "content":
                      f"What is today's {src} to {dst} exchange rate?"}],
                    ["get_exchange_rate", "convert_amount"],
                    {"name": "get_exchange_rate",
                     "arguments": {"from_currency": src, "to_currency": dst}})


CLARIFY = (
    ("send_email", ("Email my landlord that the boiler is fixed.",
                    "Send an email to the plumber asking when he can come.",
                    "Write to my accountant that the forms are ready.")),
    ("start_timer", ("Start a timer.", "Can you set a timer for me?",
                     "Timer please, I am putting the bread in.")),
    ("set_thermostat", ("Change the heating temperature.", "Adjust the thermostat for me.",
                        "The room feels wrong, set the heating.")),
    ("convert_amount", ("Convert that into yen for me.", "How much would it be in euros?",
                        "What does that come to in Swiss francs?")),
    ("lookup_order", ("Where is my order?", "Has my parcel shipped?",
                      "Check the status of my last order.")),
)


def clarify(out: Rows) -> None:
    for name, requests in CLARIFY:
        for request in requests:
            out.add("clarify", "medium", today(out.rng),
                    [{"role": "user", "content": request}], [name], None)


def chain(out: Rows) -> None:
    rng = out.rng
    statuses = ("unpaid", "overdue", "paid", "unpaid", "overdue")
    for i in range(5):
        name, address = email(rng)
        customer = f"C-{rng.randint(10000, 99999)}"
        status = statuses[i]
        out.add("chain", "hard", today(rng), [
            {"role": "user", "content": f"List the {status} invoices of the customer whose "
                                        f"email is {address}."},
            call("call_1", "find_customer", {"email": address}),
            result("call_1", {"customer_id": customer, "name": name, "email": address}),
        ], ["find_customer", "list_invoices"],
            {"name": "list_invoices", "arguments": {"customer_id": customer, "status": status}})
    for i in range(5):
        day = today(rng)
        origin, destination = rng.sample(CITIES, 2)
        date = (day + dt.timedelta(days=rng.randint(3, 20))).isoformat()
        while True:
            flights = [
                {
                    "flight_id": f"FL-{rng.randint(100, 999)}",
                    "departure": hhmm(rng.randint(6, 21), rng.choice((0, 15, 30, 45))),
                    "price_eur": rng.randint(79, 420),
                }
                for _ in range(3)
            ]
            # Distinct ids, prices and departures, so "the cheapest" and "the earliest"
            # each name exactly one flight.
            if all(len({f[k] for f in flights}) == 3 for k in flights[0]):
                break
        cheapest = i % 2 == 0
        pick = (min(flights, key=lambda f: f["price_eur"]) if cheapest
                else min(flights, key=lambda f: f["departure"]))
        which = "the cheapest one" if cheapest else "the one that leaves earliest"
        out.add("chain", "hard", day, [
            {"role": "user", "content": f"Find flights from {origin} to {destination} on "
                                        f"{date} and book {which}."},
            call("call_1", "search_flights",
                 {"origin": origin, "destination": destination, "date": date}),
            result("call_1", {"flights": flights}),
        ], ["search_flights", "book_flight"],
            {"name": "book_flight", "arguments": {"flight_id": pick["flight_id"]}})
    reasons = (("it arrived damaged", "damaged"), ("they sent me the wrong item", "wrong_item"),
               ("I no longer need it", "not_needed"), ("the box was crushed and the lamp is "
                                                       "broken", "damaged"),
               ("it is not what I ordered", "wrong_item"))
    for phrase, reason in reasons:
        order = f"ORD-{rng.randint(10000, 99999)}"
        out.add("chain", "hard", today(rng), [
            {"role": "user", "content": f"Order {order}: {phrase}. Please start a return."},
            call("call_1", "lookup_order", {"order_id": order}),
            result("call_1", {"order_id": order, "status": "delivered",
                              "returnable": True}),
        ], ["lookup_order", "create_return"],
            {"name": "create_return", "arguments": {"order_id": order, "reason": reason}})
    for i in range(5):
        place = f"{CITIES[i]} harbour"
        lat = round(rng.uniform(43.0, 59.0), 4)
        lon = round(rng.uniform(-4.0, 18.0), 4)
        out.add("chain", "hard", today(rng), [
            {"role": "user", "content": f"What is the air quality at {place}?"},
            call("call_1", "geocode", {"place": place}),
            result("call_1", {"place": place, "lat": lat, "lon": lon}),
        ], ["geocode", "get_air_quality"],
            {"name": "get_air_quality", "arguments": {"lat": lat, "lon": lon}})


def use_result(out: Rows) -> None:
    rng = out.rng
    conditions = ("light rain", "overcast", "sunny", "fog", "showers")
    for i in range(5):
        city = CITIES[(i + 3) % len(CITIES)]
        temp = rng.randint(3, 29)
        out.add("use_result", "easy", today(rng), [
            {"role": "user", "content": f"How warm is it in {city} right now?"},
            call("call_1", "get_current_weather", {"city": city}),
            result("call_1", {"city": city, "temp_c": temp, "condition": conditions[i],
                              "wind_kmh": rng.randint(31, 64)}),
        ], ["get_current_weather", "get_forecast"], None, reply_contains=[str(temp)])
    for i in range(5):
        order = f"ORD-{rng.randint(10000, 99999)}"
        eta = hhmm(rng.randint(10, 19), rng.choice((5, 20, 35, 50)))
        out.add("use_result", "easy", today(rng), [
            {"role": "user", "content": f"When will order {order} arrive today?"},
            call("call_1", "lookup_order", {"order_id": order}),
            result("call_1", {"order_id": order, "status": "out for delivery",
                              "eta": eta}),
        ], ["lookup_order", "list_orders"], None, reply_contains=[eta])
    for i in range(5):
        src, dst = rng.sample(CURRENCIES, 2)
        amount = rng.choice((40, 125, 260, 310, 85))
        converted = f"{rng.randint(20, 900)}.{rng.randint(1, 9)}{rng.randint(1, 9)}"
        out.add("use_result", "easy", today(rng), [
            {"role": "user", "content": f"Convert {amount} {src} to {dst}."},
            call("call_1", "convert_amount",
                 {"amount": amount, "from_currency": src, "to_currency": dst}),
            result("call_1", {"amount": amount, "from_currency": src, "to_currency": dst,
                              "converted": float(converted)}),
        ], ["get_exchange_rate", "convert_amount"], None, reply_contains=[converted])


def revise(out: Rows) -> None:
    rng = out.rng
    for i in range(5):
        day = today(rng)
        target = day + dt.timedelta(days=rng.randint(1, 6))
        restaurant = RESTAURANTS[(i + 2) % len(RESTAURANTS)]
        hour, minute = rng.choice(((18, 30), (19, 0), (19, 30), (20, 0)))
        size, new_size = rng.sample(sorted(NUMBER_WORDS), 2)
        first = {"restaurant": restaurant, "date": target.isoformat(),
                 "time": hhmm(hour, minute), "party_size": size}
        later = dt.datetime.combine(target, dt.time(hour, minute)) + dt.timedelta(minutes=30)
        revised = {**first, "time": later.strftime("%H:%M"), "party_size": new_size}
        out.add("revise", "hard", day, [
            {"role": "user", "content": f"Book {restaurant} for {NUMBER_WORDS[size]} people on "
                                        f"{target.isoformat()} at {hhmm(hour, minute)}."},
            call("call_1", "book_table", first),
            result("call_1", {"status": "confirmed", "booking_ref": f"BK-{rng.randint(1000, 9999)}"}),
            {"role": "assistant", "content": f"Done: {restaurant}, {target.isoformat()} at "
                                             f"{hhmm(hour, minute)}, table for {size}."},
            {"role": "user", "content": f"Actually, make it {NUMBER_WORDS[new_size]} people and "
                                        "half an hour later. Please book that instead."},
        ], ["book_table"], {"name": "book_table", "arguments": revised})
    for i in range(5):
        day = today(rng)
        first_date = day + dt.timedelta(days=rng.randint(1, 5))
        hour, minute = rng.choice(((9, 0), (11, 30), (16, 15), (17, 45)))
        shift = rng.randint(2, 5)
        new_date = first_date + dt.timedelta(days=shift)
        note = NOTES[i]
        first = {"date": first_date.isoformat(), "time": hhmm(hour, minute), "note": note}
        out.add("revise", "hard", day, [
            {"role": "user", "content": f"Remind me to {note} on {first_date.isoformat()} at "
                                        f"{hhmm(hour, minute)}."},
            call("call_1", "set_reminder", first),
            result("call_1", {"status": "created"}),
            {"role": "assistant", "content": f"Reminder set for {first_date.isoformat()} at "
                                             f"{hhmm(hour, minute)}."},
            {"role": "user", "content": f"Move it {shift} days later, same time. Set the new "
                                        "one."},
        ], ["set_reminder"],
            {"name": "set_reminder",
             "arguments": {"date": new_date.isoformat(), "time": hhmm(hour, minute)}})


# --------------------------------------------------------------------------------------


def validate(rows: list[dict]) -> None:
    for row in rows:
        expected = row["answer"]["tool_call"]
        names = [t["function"]["name"] for t in row["meta"]["tools"]]
        assert 1 <= len(names) <= 2, row["id"]
        if expected is None:
            continue
        assert expected["name"] in names, row["id"]
        schema = next(t for t in row["meta"]["tools"]
                      if t["function"]["name"] == expected["name"])["function"]["parameters"]
        for key, value in expected["arguments"].items():
            spec = schema["properties"][key]
            if "enum" in spec:
                assert value in spec["enum"], (row["id"], key, value)
            if spec.get("type") == "integer":
                assert isinstance(value, int), (row["id"], key)
        for key in schema["required"]:
            assert key in expected["arguments"], (row["id"], key)
        # Every called-for value must be derivable from the conversation: dates and times
        # are computed, so check the ones that are copied instead.
        for key in ("order_id", "customer_id", "flight_id", "email", "phone", "city"):
            value = expected["arguments"].get(key)
            if value is not None:
                blob = json.dumps(row["messages"], ensure_ascii=False)
                assert str(value) in blob, (row["id"], key)
    for row in rows:
        contains = row["answer"].get("reply_contains")
        if contains:
            tool_text = next(m["content"] for m in row["messages"] if m["role"] == "tool")
            assert all(str(c) in tool_text for c in contains), row["id"]


def main() -> None:
    rng = random.Random(SEED)
    out = Rows(rng)
    for part in (derive_args, pick_tool, clarify, chain, use_result, revise):
        part(out)
    rows = out.rows
    assert len(rows) == 100, len(rows)
    assert len({json.dumps(r["messages"]) for r in rows}) == len(rows), "duplicate item"
    validate(rows)

    d = L.dataset_dir(DATASET_ID)
    n = L.write_jsonl(d / "items.jsonl", rows)
    L.write_json(
        d / "dataset.json",
        L.eval_dataset_json(
            DATASET_ID,
            "Small-scale tool use v1",
            "100 tool-use items with one or two tools each: arguments that must be derived "
            "(relative dates, spoken times, durations, dozens, Fahrenheit into a Celsius tool), "
            "a choice between two near-identical tools, asking instead of guessing when a "
            "required argument is missing, a second call that needs a value from the first "
            "call's result, answering from a tool result without calling again, and "
            "re-issuing a call after the user changes one detail.",
            rows,
            "gen_eval_tools_small.py",
            "json",
            seed=SEED,
            created=CREATED,
            tool_catalogue=sorted(TOOLS),
            notes=[
                "The harness sends meta.tools as the request's `tools` parameter with "
                "tool_choice='auto' and scores the FIRST entry of response.tool_calls, "
                "exactly as for eval-tools-v1.",
                "Multi-turn rows carry earlier assistant tool calls and `tool` role results in "
                "`messages`, in the OpenAI chat format (assistant.tool_calls[].id matched by "
                "tool.tool_call_id). A server or chat template that cannot take them fails "
                "the request, and that is recorded as a failure, not skipped.",
                "answer.tool_call = {name, arguments}: the name must match and the arguments "
                "must match as a subset (strings case-insensitively, numbers numerically). "
                "answer.tool_call = null: correct only when no tool call is made; when "
                "answer.reply_contains is present the reply text must also contain every "
                "entry (casefolded substring, <think> blocks removed).",
                "Every row's system prompt states today's date; relative dates are resolved "
                "against it with datetime, and spoken times, durations, dozens and the "
                "Fahrenheit conversions are computed from their components.",
                "The dates in `meta.today` span 2026-10-01 to 2026-11-30 so no single "
                "weekday or month boundary dominates.",
            ],
        ),
    )
    L.report(DATASET_ID, n)


if __name__ == "__main__":
    main()
