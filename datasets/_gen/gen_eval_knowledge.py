# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Generate `datasets/eval-knowledge-v1/`.

120 multiple-choice items over facts that are widely known and do not change:
element symbols, planet order, SI prefixes and base units, number-base
conversions, big-O of textbook algorithms, HTTP status meanings, computing
acronyms, capital cities that have not moved, a small set of dates that every
history syllabus agrees on, and definitions of everyday technical terms.

Deliberately excluded: anything a model could be right about and be marked wrong
for — current office-holders, populations, "largest/longest" superlatives that
sources disagree on, recent events, and anything that depends on the year.

Distractors for the table-driven families are drawn from the same table, so a
wrong answer is always plausible rather than absurd.

Run: `uv run datasets/_gen/gen_eval_knowledge.py`
"""

from __future__ import annotations

import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import _lib as L  # noqa: E402

SEED = 20260903
DATASET_ID = "eval-knowledge-v1"
LETTERS = "ABCD"
TAIL = "Reply with the letter of the correct option only."

ELEMENTS = {
    "gold": "Au", "iron": "Fe", "sodium": "Na", "potassium": "K", "lead": "Pb",
    "silver": "Ag", "tin": "Sn", "tungsten": "W", "mercury": "Hg", "copper": "Cu",
    "helium": "He", "carbon": "C", "nitrogen": "N", "calcium": "Ca",
}

BIG_O = {
    "binary search on a sorted array": "O(log n)",
    "linear search of an unsorted array": "O(n)",
    "merge sort in the worst case": "O(n log n)",
    "quicksort in the worst case": "O(n^2)",
    "bubble sort in the worst case": "O(n^2)",
    "looking up a key in a hash table on average": "O(1)",
    "heap sort in the worst case": "O(n log n)",
    "inserting at the front of a singly linked list": "O(1)",
    "finding the maximum of an unsorted array": "O(n)",
    "accessing an array element by index": "O(1)",
    "breadth-first search of a graph with V vertices and E edges": "O(V + E)",
    "comparing every pair of n items": "O(n^2)",
}

HTTP_CODES = {
    "200": "OK — the request succeeded",
    "201": "Created — a new resource was created",
    "204": "No Content — success with no response body",
    "301": "Moved Permanently — the resource has a new permanent URL",
    "400": "Bad Request — the request was malformed",
    "401": "Unauthorized — authentication is missing or invalid",
    "403": "Forbidden — authenticated but not allowed",
    "404": "Not Found — the resource does not exist",
    "409": "Conflict — the request conflicts with the current state",
    "429": "Too Many Requests — the client is being rate limited",
    "500": "Internal Server Error — the server failed unexpectedly",
    "503": "Service Unavailable — the server is temporarily unable to handle the request",
}

SI_PREFIXES = {
    "kilo": "10^3", "mega": "10^6", "giga": "10^9", "tera": "10^12",
    "milli": "10^-3", "micro": "10^-6", "nano": "10^-9", "pico": "10^-12",
}

ACRONYMS = {
    "CPU": "Central Processing Unit",
    "RAM": "Random Access Memory",
    "HTTP": "Hypertext Transfer Protocol",
    "DNS": "Domain Name System",
    "TCP": "Transmission Control Protocol",
    "URL": "Uniform Resource Locator",
    "API": "Application Programming Interface",
    "SQL": "Structured Query Language",
    "GPU": "Graphics Processing Unit",
    "SSD": "Solid State Drive",
    "JSON": "JavaScript Object Notation",
    "HTML": "Hypertext Markup Language",
    "SSH": "Secure Shell",
    "VPN": "Virtual Private Network",
}

CAPITALS = {
    "France": "Paris", "Japan": "Tokyo", "Egypt": "Cairo", "Brazil": "Brasilia",
    "Canada": "Ottawa", "Australia": "Canberra", "Turkey": "Ankara", "Morocco": "Rabat",
    "Switzerland": "Bern", "Norway": "Oslo", "Kenya": "Nairobi", "India": "New Delhi",
    "Portugal": "Lisbon", "Poland": "Warsaw", "Vietnam": "Hanoi", "Chile": "Santiago",
}

#: (category, difficulty, question, correct answer, three distractors)
CURATED = [
    ("science", "easy", "Which planet is closest to the Sun?", "Mercury", ["Venus", "Mars", "Earth"]),
    ("science", "easy", "Which planet in our solar system is the largest?", "Jupiter",
     ["Saturn", "Neptune", "Uranus"]),
    ("science", "medium", "Which planet is the fourth from the Sun?", "Mars", ["Venus", "Jupiter", "Earth"]),
    ("science", "easy", "At sea level, at what temperature does pure water boil?", "100 degrees Celsius",
     ["90 degrees Celsius", "120 degrees Celsius", "212 degrees Celsius"]),
    ("science", "easy", "Which gas makes up the largest share of dry air in Earth's atmosphere?",
     "Nitrogen", ["Oxygen", "Carbon dioxide", "Argon"]),
    ("science", "medium", "How many bases make up the genetic alphabet of DNA?", "Four",
     ["Two", "Three", "Twenty"]),
    ("science", "medium", "Which of these is NOT one of the four DNA bases?", "Uracil",
     ["Adenine", "Cytosine", "Guanine"]),
    ("science", "easy", "What is the chemical formula of water?", "H2O", ["CO2", "O2", "H2O2"]),
    ("science", "medium", "Roughly how fast does light travel in a vacuum?",
     "About 300,000 kilometres per second",
     ["About 300 kilometres per second", "About 3,000 kilometres per second",
      "About 30,000,000 kilometres per second"]),
    ("science", "medium", "What force keeps the planets in orbit around the Sun?", "Gravity",
     ["Magnetism", "Friction", "The strong nuclear force"]),
    ("science", "easy", "What do plants take in from the air during photosynthesis?", "Carbon dioxide",
     ["Oxygen", "Nitrogen", "Hydrogen"]),
    ("science", "medium", "Which part of the human body produces insulin?", "The pancreas",
     ["The liver", "The kidneys", "The spleen"]),
    ("science", "medium", "What is the freezing point of pure water in kelvin?", "273.15 K",
     ["0 K", "100 K", "373.15 K"]),
    ("science", "hard", "Which particle carries a negative electric charge?", "The electron",
     ["The proton", "The neutron", "The photon"]),
    ("geography", "easy", "Which is the largest ocean on Earth?", "The Pacific Ocean",
     ["The Atlantic Ocean", "The Indian Ocean", "The Arctic Ocean"]),
    ("geography", "easy", "On which continent is the Sahara desert?", "Africa",
     ["Asia", "South America", "Australia"]),
    ("geography", "easy", "How many continents are usually counted in the English-speaking world?",
     "Seven", ["Five", "Six", "Eight"]),
    ("geography", "medium", "Which mountain is the highest above sea level?", "Mount Everest",
     ["K2", "Mont Blanc", "Kilimanjaro"]),
    ("geography", "medium", "Which country is directly south of the United States?", "Mexico",
     ["Canada", "Cuba", "Guatemala"]),
    ("geography", "medium", "Through which country does the Amazon river mostly flow?", "Brazil",
     ["Peru", "Colombia", "Venezuela"]),
    ("geography", "hard", "Which line of latitude is at 0 degrees?", "The equator",
     ["The Tropic of Cancer", "The prime meridian", "The Arctic Circle"]),
    ("geography", "medium", "Which sea separates Europe from Africa?", "The Mediterranean Sea",
     ["The Baltic Sea", "The Red Sea", "The Black Sea"]),
    ("history", "easy", "In which year did the Second World War end?", "1945", ["1918", "1939", "1949"]),
    ("history", "easy", "In which year did humans first land on the Moon?", "1969",
     ["1957", "1961", "1972"]),
    ("history", "easy", "In which year did the Berlin Wall fall?", "1989", ["1961", "1979", "1991"]),
    ("history", "medium", "In which year did the French Revolution begin?", "1789",
     ["1776", "1799", "1812"]),
    ("history", "medium", "Who is credited with introducing movable-type printing in Europe?",
     "Johannes Gutenberg", ["Leonardo da Vinci", "Galileo Galilei", "Isaac Newton"]),
    ("history", "medium", "Who was the first human to travel into space?", "Yuri Gagarin",
     ["Neil Armstrong", "Alan Shepard", "Valentina Tereshkova"]),
    ("history", "medium", "In which year was the United States Declaration of Independence signed?",
     "1776", ["1789", "1812", "1620"]),
    ("history", "hard", "In which year did Constantinople fall to the Ottoman Empire?", "1453",
     ["1291", "1492", "1517"]),
    ("history", "medium", "Which ancient civilisation built the pyramids at Giza?", "The Egyptians",
     ["The Romans", "The Greeks", "The Persians"]),
    ("history", "hard", "Which conflict ended with the Treaty of Versailles?", "The First World War",
     ["The Second World War", "The Franco-Prussian War", "The Crimean War"]),
    ("cs_basics", "easy", "How many bits are there in one byte?", "8", ["4", "16", "32"]),
    ("cs_basics", "easy", "What is 2 to the power of 10?", "1024", ["512", "1000", "2048"]),
    ("cs_basics", "medium", "How many bits does an IPv4 address have?", "32", ["16", "64", "128"]),
    ("cs_basics", "medium", "Which data structure works last in, first out?", "A stack",
     ["A queue", "A linked list", "A hash table"]),
    ("cs_basics", "medium", "Which data structure works first in, first out?", "A queue",
     ["A stack", "A binary tree", "A set"]),
    ("cs_basics", "medium", "What does a compiler do that an interpreter does not?",
     "It translates the whole program before it runs",
     ["It executes the program line by line", "It removes all bugs", "It compresses the source code"]),
    ("cs_basics", "medium", "In ASCII, what is the decimal code of the capital letter A?", "65",
     ["64", "97", "41"]),
    ("cs_basics", "hard", "What is the worst-case time complexity of inserting into a balanced "
     "binary search tree?", "O(log n)", ["O(1)", "O(n)", "O(n log n)"]),
    ("cs_basics", "medium", "Which of these is a lossless compression format?", "PNG",
     ["JPEG", "MP3", "MPEG-4"]),
    ("cs_basics", "medium", "What does DNS translate?", "Domain names into IP addresses",
     ["IP addresses into MAC addresses", "URLs into HTML", "Passwords into hashes"]),
    ("cs_basics", "hard", "Which port does HTTPS use by default?", "443", ["21", "80", "8080"]),
    ("cs_basics", "medium", "In git, what does a commit record?", "A snapshot of the tracked files",
     ["Only the lines that changed, with no history", "The running processes",
      "The contents of the working directory ignoring the index"]),
    ("units", "easy", "What is the SI base unit of mass?", "The kilogram",
     ["The gram", "The newton", "The pound"]),
    ("units", "easy", "What is the SI base unit of time?", "The second",
     ["The minute", "The hertz", "The day"]),
    ("units", "medium", "What is the SI unit of force?", "The newton",
     ["The joule", "The watt", "The pascal"]),
    ("units", "medium", "What is the SI unit of power?", "The watt",
     ["The joule", "The newton", "The ampere"]),
    ("units", "medium", "What is the SI unit of pressure?", "The pascal",
     ["The newton", "The bar", "The joule"]),
    ("units", "medium", "One hertz is equal to what?", "One cycle per second",
     ["One metre per second", "One joule per second", "One radian per second"]),
    ("units", "easy", "How many metres are there in one kilometre?", "1000", ["10", "100", "10000"]),
    ("units", "medium", "How many grams are there in one kilogram?", "1000", ["10", "100", "10000"]),
    ("units", "hard", "Zero kelvin corresponds to which Celsius temperature?", "-273.15 degrees",
     ["0 degrees", "-100 degrees", "-459.67 degrees"]),
    ("units", "easy", "What is the SI base unit of electric current?", "The ampere",
     ["The volt", "The ohm", "The coulomb"]),
    ("units", "medium", "What is the SI base unit of the amount of a substance?", "The mole",
     ["The gram", "The litre", "The kelvin"]),
    ("units", "medium", "One megabyte is how many kilobytes, using decimal SI units?", "1000",
     ["8", "1024", "1000000"]),
    ("definitions", "medium", "What does latency measure?",
     "The time between a request and its response",
     ["The number of requests handled per second", "The amount of memory a request uses",
      "The size of the response"]),
    ("definitions", "medium", "What does throughput measure?",
     "How much work is completed per unit of time",
     ["How long one request takes", "How many errors occur", "How much memory is free"]),
    ("definitions", "medium", "What does it mean for an operation to be idempotent?",
     "Repeating it has the same effect as doing it once",
     ["It always fails the second time", "It runs in constant time",
      "It can only be executed by one caller at a time"]),
    ("definitions", "medium", "What is the median of a set of numbers?",
     "The middle value when they are sorted",
     ["The average of all the values", "The most frequent value",
      "The difference between the largest and smallest value"]),
    ("definitions", "medium", "What is the mean of a set of numbers?",
     "The sum divided by how many there are",
     ["The middle value when sorted", "The most frequent value", "The largest value"]),
    ("definitions", "hard", "What is the key difference between hashing and encryption?",
     "Hashing is one-way, encryption can be reversed with a key",
     ["Encryption is one-way, hashing can be reversed", "They are two names for the same thing",
      "Hashing always produces a longer output than its input"]),
    ("definitions", "medium", "What is a cache?",
     "A store of results kept so they need not be computed or fetched again",
     ["A permanent database of records", "A queue of pending requests",
      "A log of every error that occurred"]),
    ("definitions", "hard", "What is a deadlock?",
     "Two or more tasks each waiting for a resource the other holds",
     ["A task that runs forever using all the CPU", "A crash caused by running out of memory",
      "A request that times out on the network"]),
    ("definitions", "hard", "What is a race condition?",
     "A bug whose outcome depends on the timing of concurrent operations",
     ["A loop that never terminates", "A function that returns before it finishes",
      "An error caused by an invalid input"]),
    ("definitions", "medium", "What is a checksum used for?",
     "Detecting whether data changed in transit or storage",
     ["Compressing data", "Encrypting data", "Sorting data"]),
    ("definitions", "medium", "What does an API define?",
     "The contract by which one program calls another",
     ["The visual design of an application", "The database schema of an application",
      "The hardware an application runs on"]),
    ("definitions", "hard", "In statistics, what does the standard deviation describe?",
     "How spread out the values are around the mean",
     ["The middle value of the data", "The number of samples",
      "The difference between the largest and the smallest value"]),
]


def mc_row(rng, category, difficulty, question, correct, distractors):
    """An unrendered item; `render` turns it into a row once the labels are balanced."""
    options = [correct, *distractors]
    rng.shuffle(options)
    return {
        "category": category,
        "difficulty": difficulty,
        "question": question,
        "options": options,
        "correct": correct,
    }


def balance_labels(rows: list[dict]) -> None:
    """Rotate each option list so the correct letter is spread evenly over A-D.

    With 130-odd items a plain shuffle leaves a visibly lopsided key (D twice as
    often as A here), and a lopsided key is worth points to a model that always
    guesses the same letter.
    """
    for i, row in enumerate(rows):
        target = i % 4
        current = row["options"].index(row["correct"])
        shift = (current - target) % 4
        row["options"] = row["options"][shift:] + row["options"][:shift]


def render(row: dict, index: int) -> dict:
    options = row["options"]
    rendered = "\n".join(f"{LETTERS[i]}. {opt}" for i, opt in enumerate(options))
    return {
        "id": f"know-{index:04d}",
        "category": row["category"],
        "difficulty": row["difficulty"],
        "prompt": f"{row['question']}\n\n{rendered}\n\n{TAIL}",
        "answer": LETTERS[options.index(row["correct"])],
        "scorer": "mc",
        "choices": options,
    }


def table_items(rng, table, count, category, difficulty, question, key_is_question=True):
    """`count` MC items drawn from a fact table, with distractors from the same table."""
    keys = sorted(table)
    rng.shuffle(keys)
    out = []
    for key in keys[:count]:
        correct = table[key] if key_is_question else key
        # distinct *values*: several algorithms share a complexity, so a naive pool
        # would offer the right answer twice
        pool = sorted({table[k] if key_is_question else k for k in keys} - {correct})
        out.append(
            mc_row(rng, category, difficulty, question.format(key=key), correct, rng.sample(pool, 3))
        )
    return out


def base_items(rng, count):
    out = []
    for i in range(count):
        n = rng.randint(18, 4_000)
        if i % 2 == 0:
            text, question = format(n, "b"), "What is the binary number {v} in decimal?"
        else:
            text, question = format(n, "X"), "What is the hexadecimal number 0x{v} in decimal?"
        distractors = set()
        while len(distractors) < 3:
            delta = rng.choice([-1, 1]) * rng.choice([1, 2, 3, 8, 16, 100, n // 2 or 1])
            candidate = n + delta
            if candidate > 0 and candidate != n:
                distractors.add(str(candidate))
        out.append(
            mc_row(rng, "cs_basics", "medium", question.format(v=text), str(n), sorted(distractors))
        )
    return out


def main() -> None:
    rng = random.Random(SEED)
    rows: list[dict] = []

    rows += table_items(rng, ELEMENTS, 12, "science", "medium",
                        "What is the chemical symbol for {key}?")
    rows += base_items(rng, 8)
    rows += table_items(rng, BIG_O, 8, "cs_basics", "hard",
                        "What is the time complexity of {key}?")
    rows += table_items(rng, HTTP_CODES, 6, "cs_basics", "medium",
                        "What does the HTTP status code {key} mean?")
    rows += table_items(rng, SI_PREFIXES, 8, "units", "medium",
                        "The SI prefix {key} stands for which factor?")
    rows += table_items(rng, ACRONYMS, 8, "cs_basics", "easy", "What does {key} stand for?")
    rows += table_items(rng, CAPITALS, 12, "geography", "medium",
                        "What is the capital city of {key}?")
    for category, difficulty, question, correct, distractors in CURATED:
        rows.append(mc_row(rng, category, difficulty, question, correct, distractors))

    for row in rows:
        assert len(set(row["options"])) == 4, row["question"]
    rng.shuffle(rows)
    balance_labels(rows)
    rows = [render(row, i) for i, row in enumerate(rows, start=1)]
    assert len({r["prompt"] for r in rows}) == len(rows), "duplicate question"

    d = L.dataset_dir(DATASET_ID)
    n = L.write_jsonl(d / "items.jsonl", rows)
    L.write_json(
        d / "dataset.json",
        L.eval_dataset_json(
            DATASET_ID,
            "Knowledge eval v1",
            "120 four-option multiple-choice questions on stable, widely known facts: element "
            "symbols, planets, SI units and prefixes, number bases, big-O of textbook algorithms, "
            "HTTP status codes, computing acronyms, capital cities, fixed historical dates, and "
            "definitions of common technical terms.",
            rows,
            "gen_eval_knowledge.py",
            "mc",
            seed=SEED,
            notes=[
                "Nothing here depends on the current year, on an office-holder, or on a "
                "superlative that sources disagree about — a model must not be able to lose a "
                "point for being more up to date than the dataset.",
                "Options are shuffled with the dataset seed, so the correct letter is spread "
                "evenly and is stable across regenerations.",
                "The mc scorer accepts the bare letter, 'A)', '(A)', 'A.' or the full text of the "
                "correct option.",
            ],
        ),
    )
    L.report(DATASET_ID, n)


if __name__ == "__main__":
    main()
