"""Reference implementation of the `haystack-v1` materialisation algorithm.

`items.jsonl` stores *recipes*, not text: a 256k-token haystack is a megabyte of
characters and there is no reason to keep eight of those in a git repository. The
harness reconstructs the exact same document from the recipe at run time.

This file is intentionally self-contained (standard library only, no imports from
`datasets/_gen/`) so `bench/` can import or exec it directly:

    import importlib.util, json, pathlib
    spec = importlib.util.spec_from_file_location("haystack_build", "datasets/haystack-v1/build.py")
    hb = importlib.util.module_from_spec(spec); spec.loader.exec_module(hb)
    item = json.loads(pathlib.Path("datasets/haystack-v1/items.jsonl").read_text().splitlines()[0])
    text = hb.build_haystack(item)
    prompt = hb.build_prompt(item)

CLI:

    python datasets/haystack-v1/build.py --id hay-8k-d50            # print the prompt
    python datasets/haystack-v1/build.py --id hay-8k-d50 --text     # print only the haystack
    python datasets/haystack-v1/build.py --all --out-dir static     # materialise files

## The algorithm, precisely

Given `seed`, `target_tokens` and a list of needles `[{depth, text, answer}]`:

1. `budget = target_tokens * CHARS_PER_TOKEN` (4), the same chars/4 heuristic used
   everywhere in `datasets/`.
2. `rng = random.Random(seed)`.
3. `needle_chars = sum(len(n["text"]) + LINE_PREFIX_LEN + 1 for n in needles)`.
4. Generate filler sentences one at a time. For each, draw a template with
   `rng.choice(TEMPLATES)` and fill its slots in the order they appear in the
   template with `rng.choice(SLOTS[name])` for word slots and `rng.randint(lo, hi)`
   for number slots (see `_fill`). Stop as soon as
   `filler_chars + needle_chars >= budget`, where each line costs
   `LINE_PREFIX_LEN + len(sentence) + 1` (the trailing newline).
5. Insert the needles, sorted by depth ascending. Needle `j` (0-based) goes to
   index `round(depth_j * F) + j` where `F` is the number of filler lines,
   clamped to `[0, len(lines)]`.
6. Number every line sequentially from 1: `f"Line {i:06d}: {sentence}"`.
7. Join with `"\n"`. No trailing newline.

Reordering steps 4 and 5 would change the numbering, so the order is normative.
Two implementations agree iff they produce the same SHA-256, which is recorded as
`sha256` on every item and re-checked by `datasets/_gen/check.py`.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import random
import re
from pathlib import Path

CHARS_PER_TOKEN = 4
LINE_PREFIX_LEN = len("Line 000000: ")

TEMPLATES = (
    "The {dept} team logged {num:2..90} {unit} of {material} at depot {num:100..999} on the {ord} pass.",
    "Shipment {num:1000..9999} left {city} carrying {material} bound for the {dept} store.",
    "Inspector {name} recorded a temperature of {num:2..38} degrees in bay {num:1..40} and signed the sheet.",
    "A note in the {dept} ledger puts the {unit} count at {num:20..900}, which the auditor has queried.",
    "The {ord} delivery from {city} arrived {num:2..14} days late and was accepted with a discount.",
    "Maintenance closed ticket {num:1000..9999} after replacing the {part} on line {num:1..9}.",
    "{name} reported that the {part} in {city} has been running for {num:100..9000} hours without service.",
    "Stock of {material} at the {dept} depot fell to {num:5..400} {unit} before the resupply arrived.",
    "The {ord} audit of the {dept} records found {num:1..30} entries with no matching receipt.",
    "Route {num:10..99} through {city} was rerouted because the {part} at the junction failed.",
    "{name} signed off {num:2..60} {unit} of {material} for the {dept} project, reference {num:1000..9999}.",
    "The {dept} rota for week {num:1..52} assigns {name} to the night shift in {city}.",
    "A meter in bay {num:1..40} showed {num:100..999} units, roughly {num:2..40} percent above the expected reading.",
    "Correspondence {num:1000..9999} confirms that the {part} was ordered but never delivered to {city}.",
    "The {ord} sample of {material} weighed {num:2..90} {unit} and was archived by {name}.",
    "Warehouse {num:1..12} in {city} holds {num:50..900} {unit} of {material} under the {dept} account.",
    "{name} asked whether the {part} replaced in {city} was covered by the {ord} maintenance contract.",
    "The {dept} budget line {num:1000..9999} was reduced by {num:2..40} percent after the {ord} review.",
    "Vehicle {num:10..99} covered {num:100..900} kilometres between {city} and the {dept} depot last month.",
    "An entry dated week {num:1..52} shows {num:5..400} {unit} of {material} written off as damaged.",
    "The {part} in warehouse {num:1..12} was inspected by {name} and cleared for another {num:100..9000} hours.",
    "Order {num:1000..9999} for {material} was split across {num:2..8} deliveries to {city}.",
    "{name} noted that the {dept} team in {city} works {num:2..12} hour shifts during the peak season.",
    "The {ord} reconciliation matched {num:50..900} of the {dept} entries and flagged the remainder.",
)

SLOTS = {
    "dept": ("logistics", "quality", "maintenance", "procurement", "dispatch", "records", "planning"),
    "unit": ("crates", "pallets", "drums", "reels", "sacks", "cases", "cartons"),
    "material": ("copper wire", "kiln bricks", "sail cloth", "beet sugar", "resin pellets",
                 "seed grain", "glass panes", "rock salt"),
    "city": ("Aberholt", "Valcrest", "Threeford", "Kesswater", "Marren Bay", "Dunhallow",
             "Stonereach", "Oldmarsh"),
    "name": ("Ines", "Marcus", "Priya", "Tomas", "Dana", "Rafael", "Nadia", "Bo", "Juno", "Emre"),
    "part": ("conveyor belt", "hydraulic seal", "barcode scanner", "loading ramp", "cooling fan",
             "weighbridge", "gate motor"),
    "ord": ("first", "second", "third", "fourth", "quarterly", "annual"),
}

_SLOT_RE = re.compile(r"\{(\w+)(?::(\d+)\.\.(\d+))?\}")


def _fill(template: str, rng: random.Random) -> str:
    """Fill one template. Slots are resolved left to right, one rng call each."""

    def repl(m: re.Match[str]) -> str:
        name, lo, hi = m.group(1), m.group(2), m.group(3)
        if name == "num":
            return str(rng.randint(int(lo), int(hi)))
        return rng.choice(SLOTS[name])

    return _SLOT_RE.sub(repl, template)


def build_haystack(item: dict) -> str:
    """Materialise the document described by a `haystack-v1` recipe row."""
    rng = random.Random(item["seed"])
    budget = item["target_tokens"] * CHARS_PER_TOKEN
    needles = sorted(item["needles"], key=lambda n: n["depth"])
    needle_chars = sum(LINE_PREFIX_LEN + len(n["text"]) + 1 for n in needles)

    filler: list[str] = []
    used = needle_chars
    while used < budget:
        sentence = _fill(rng.choice(TEMPLATES), rng)
        filler.append(sentence)
        used += LINE_PREFIX_LEN + len(sentence) + 1

    lines = list(filler)
    n_filler = len(filler)
    for j, needle in enumerate(needles):
        index = min(max(round(needle["depth"] * n_filler) + j, 0), len(lines))
        lines.insert(index, needle["text"])

    return "\n".join(f"Line {i:06d}: {text}" for i, text in enumerate(lines, start=1))


PREAMBLE = (
    "Below is a long log of numbered lines. Read it carefully; one or more lines "
    "contain information you will be asked about. Answer only with what the log says."
)


def build_prompt(item: dict) -> str:
    """The full user message: preamble, haystack, question. Used by the eval scorers."""
    return f"{PREAMBLE}\n\n{build_haystack(item)}\n\n{item['question']}"


def sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def load_items(path: Path | None = None) -> list[dict]:
    path = path or Path(__file__).resolve().parent / "items.jsonl"
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def main() -> None:
    ap = argparse.ArgumentParser(description="Materialise haystack-v1 documents.")
    ap.add_argument("--id", help="item id, e.g. hay-8k-d50")
    ap.add_argument("--all", action="store_true", help="materialise every item")
    ap.add_argument("--text", action="store_true", help="print the haystack only, without the question")
    ap.add_argument("--out-dir", help="write <id>.txt files into this directory instead of stdout")
    args = ap.parse_args()

    items = load_items()
    if args.id:
        items = [i for i in items if i["id"] == args.id]
        if not items:
            raise SystemExit(f"no such item: {args.id}")
    elif not args.all:
        raise SystemExit("pass --id <item-id> or --all")

    for item in items:
        text = build_haystack(item) if args.text or args.out_dir else build_prompt(item)
        if args.out_dir:
            out = Path(args.out_dir)
            out.mkdir(parents=True, exist_ok=True)
            (out / f"{item['id']}.txt").write_text(text + "\n", encoding="utf-8")
            print(f"{item['id']}: {len(text)} chars, sha256 {sha256(text)[:12]}")
        else:
            print(text)


if __name__ == "__main__":
    main()
