"""Shared helpers for the Inference Atlas dataset generators.

Everything in `datasets/` is authored in this repository: this module holds the
seeded, deterministic text machinery that the `gen_*.py` scripts compose into
prompts and eval items. No external corpora, no scraped text.

Two rules the whole corpus depends on:

1. **Determinism.** Every generator seeds its own `random.Random(seed)` and never
   touches the global `random` module. Re-running a generator must produce a
   byte-identical directory.
2. **Uniqueness.** Serving benchmarks are distorted by prefix caching and by
   tokenizer merges when the same sentence repeats. Sentences are therefore
   rendered from templates with a wide slot vocabulary *and* carry running
   reference numbers (`{uid}`), so near-duplicate lines are rare and exact
   duplicates essentially absent. `check.py` measures the duplicate-line ratio.
"""

from __future__ import annotations

import json
import random
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Iterable, Sequence

# --------------------------------------------------------------------------------------
# paths / io
# --------------------------------------------------------------------------------------

DATASETS_DIR = Path(__file__).resolve().parent.parent
SCHEMA_VERSION = 1
LICENCE = "MIT"
CREATED = "2026-08-23"

#: The one and only token heuristic used across `datasets/`. Documented in every
#: dataset.json as `token_heuristic`. It is deliberately tokenizer-independent;
#: real token counts differ per model (CJK text runs ~3-4x higher).
TOKEN_HEURISTIC = "approx_tokens = ceil(sum(len(m.content) for m in messages) / 4)"


def approx_tokens_from_chars(n_chars: int) -> int:
    return -(-n_chars // 4)


def approx_tokens(messages: Sequence[dict], shared_prefix: str | None = None) -> int:
    n = sum(len(m["content"]) for m in messages)
    if shared_prefix:
        n += len(shared_prefix)
    return approx_tokens_from_chars(n)


def dataset_dir(dataset_id: str) -> Path:
    d = DATASETS_DIR / dataset_id
    d.mkdir(parents=True, exist_ok=True)
    return d


def write_jsonl(path: Path, rows: Iterable[dict]) -> int:
    n = 0
    with path.open("w", encoding="utf-8") as fh:
        for row in rows:
            fh.write(json.dumps(row, ensure_ascii=False, sort_keys=False))
            fh.write("\n")
            n += 1
    return n


def write_json(path: Path, obj: Any) -> None:
    path.write_text(json.dumps(obj, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def dir_size_bytes(path: Path) -> int:
    return sum(p.stat().st_size for p in path.rglob("*") if p.is_file())


def human_size(n: int) -> str:
    if n < 1024:
        return f"{n} B"
    if n < 1024 * 1024:
        return f"{n / 1024:.1f} KB"
    return f"{n / 1024 / 1024:.2f} MB"


def report(dataset_id: str, count: int) -> None:
    d = DATASETS_DIR / dataset_id
    print(f"{dataset_id}: {count} rows, {human_size(dir_size_bytes(d))} in {d.relative_to(DATASETS_DIR.parent)}")


def base_dataset_json(
    dataset_id: str,
    name: str,
    kind: str,
    description: str,
    files: list[str],
    count: int,
    generator: str,
    **extra: Any,
) -> dict:
    """The common head of every dataset.json (SPEC §4)."""
    doc = {
        "schema_version": SCHEMA_VERSION,
        "id": dataset_id,
        "name": name,
        "kind": kind,
        "description": description,
        "licence": LICENCE,
        "created": CREATED,
        "files": files,
        "count": count,
        "generator": f"datasets/_gen/{generator}",
        "token_heuristic": TOKEN_HEURISTIC,
        "provenance": "Synthetic, authored in this repository. No third-party text.",
    }
    doc.update(extra)
    return doc


# --------------------------------------------------------------------------------------
# eval conventions (shared by every eval-*-v1 dataset)
# --------------------------------------------------------------------------------------

#: How the harness turns raw model output into the string a scorer sees. Applied in
#: this order, before any scorer runs. Written into every eval dataset.json so the
#: contract lives next to the data.
ANSWER_EXTRACTION = [
    "Drop everything inside <think>...</think> (and an unterminated leading <think> block).",
    "Drop markdown code fences, keeping the fenced content.",
    "If any line matches /^\\s*(?:final answer|answer)\\s*[:\\-]\\s*(.+)$/i, take the capture of "
    "the LAST such line and use only that.",
    "Strip surrounding whitespace, matching quotes, and a single trailing '.' or '!'.",
    "Scorers that need the untouched output (instruction, json) get the raw text as well; the "
    "instruction scorer always works on the raw output.",
]

#: The scorer vocabulary used across datasets/. `metrics` and `scores` in a result
#: file are produced from these.
SCORERS = {
    "exact": "Case-insensitive comparison after collapsing internal whitespace. `answer` is a "
    "string; `meta.answer_aliases` (list) are also accepted.",
    "numeric": "Parse the last number in the extracted output (thousands separators, a leading "
    "currency symbol and a trailing % are stripped). Correct when "
    "abs(got - float(answer)) <= max(meta.tolerance or 1e-6, 1e-9 * abs(expected)).",
    "mc": "Multiple choice. `choices` is a list of strings; `answer` is the 0-based-letter label "
    "('A', 'B', ...). Accept the bare letter, 'A)', '(A)', 'A.' or the full text of the "
    "correct choice, case-insensitively.",
    "contains": "`answer` is {all: [...], any: [...]} (either key may be absent). An entry may be "
    "a string, or a LIST of alternatives that passes when any one of them is found. Correct "
    "when every entry of `all` and at least one entry of `any` occurs in the casefolded "
    "output. Substring match, no diacritic folding.",
    "json": "Parse the extracted output as JSON. `answer` is the expected value; `meta.match` is "
    "'subset' (default — every key/value in `answer` must appear, extra keys allowed) or "
    "'exact'. Arrays compare elementwise in order unless meta.array_order is false.",
    "code_exec": "Concatenate the model's code with the `tests` string and run it in a subprocess "
    "with no network, a fresh temp cwd and meta.timeout_s (default 10). Correct when the "
    "process exits 0.",
    "needle": "Casefolded substring test of `answer` in the extracted output, after removing "
    "spaces, commas and hyphens from both sides. Meant for retrieval, not phrasing.",
    "instruction": "Evaluate the rule DSL in `answer` against the RAW output. See "
    "eval-instruction-v1/dataset.json for the rule list.",
    "integrity": "Long-output token integrity, not correctness. Mask strings, comments and "
    "regex literals in the generated code; build a definition set from "
    "meta.context_identifiers plus every name the output declares plus the JavaScript "
    "globals; report a splice when a digit-initial token is not a valid numeric literal "
    "(`128Pin`), when an undefined identifier is a defined name — down to one letter — "
    "plus 2-6 lower-case letters (`carrier` + `hed`, `z` + `hed`), when a property name "
    "the file defines is welded to a tail (`ship.bobAmporton`), when an undefined bare "
    "word or dotted fragment sits between two numeric literals in a comma-separated list "
    "(`[6, visible, 0]`, `[2, 0, .src, 4]`), or when a non-ASCII character appears in "
    "code (`[2, 0, 惯, 4]`). A welded name that recurs counts once per generation. "
    "Correct = no splice; an undefined identifier that is not one of those shapes is an "
    "ordinary code error and is not counted.",
}


def eval_dataset_json(
    dataset_id: str,
    name: str,
    description: str,
    rows: list[dict],
    generator: str,
    default_scorer: str,
    files: list[str] | None = None,
    **extra: Any,
) -> dict:
    """dataset.json for an eval dataset, with the counts derived from *rows*."""
    by_category: dict[str, int] = {}
    by_difficulty: dict[str, int] = {}
    by_scorer: dict[str, int] = {}
    for r in rows:
        by_category[r["category"]] = by_category.get(r["category"], 0) + 1
        by_difficulty[r["difficulty"]] = by_difficulty.get(r["difficulty"], 0) + 1
        by_scorer[r["scorer"]] = by_scorer.get(r["scorer"], 0) + 1
    scorers_used = {k: v for k, v in SCORERS.items() if k in by_scorer}
    return base_dataset_json(
        dataset_id,
        name,
        "eval",
        description,
        files or ["items.jsonl"],
        len(rows),
        generator,
        default_scorer=default_scorer,
        scoring={
            "answer_extraction": ANSWER_EXTRACTION,
            "scorers": scorers_used,
            "pass_rule": "One item is correct or incorrect; there is no partial credit. "
            "accuracy = correct / total. An item whose request failed (timeout, 5xx, "
            "context overflow) counts as incorrect AND is reported in "
            "scores.failures and metrics.requests_failed.",
        },
        categories=sorted(by_category),
        difficulties=["easy", "medium", "hard"],
        counts={"by_category": by_category, "by_difficulty": by_difficulty, "by_scorer": by_scorer},
        **extra,
    )


EVAL_ROW_FIELDS = ["id", "category", "difficulty", "prompt", "answer", "scorer"]
EVAL_ROW_OPTIONAL = ["messages", "choices", "tests", "image", "meta"]


# --------------------------------------------------------------------------------------
# template filling
# --------------------------------------------------------------------------------------

_NUMERIC: dict[str, Callable[[random.Random, int], str]] = {
    "n": lambda r, u: str(r.randint(3, 97)),
    "big": lambda r, u: f"{r.randint(1200, 98000):,}",
    "pct": lambda r, u: str(r.randint(4, 96)),
    "dec": lambda r, u: f"{r.uniform(0.4, 9.8):.2f}",
    "year": lambda r, u: str(r.randint(1861, 2024)),
    "day": lambda r, u: str(r.randint(1, 28)),
    "ms": lambda r, u: str(r.randint(12, 980)),
    "uid": lambda r, u: f"{u:05d}",
    "ref": lambda r, u: f"{r.choice('ABCDEFGHJKMNPQRTVWXY')}-{u:05d}",
}


class Filler(dict):
    """`str.format_map` mapping that resolves slots and numbers lazily.

    `{material}` and `{material2}` both draw from the `material` slot list; the
    suffixed form re-draws until it differs from what the bare form got (up to a
    few attempts), so a template never renders "steel and steel".
    """

    def __init__(self, rng: random.Random, slots: dict[str, Sequence[str]], uid: int):
        super().__init__()
        self.rng = rng
        self.slots = slots
        self.uid = uid

    def __missing__(self, key: str) -> str:
        # exact slot names win: a slot literally called `year2` is not a second draw
        # from a `year` slot.
        base = key if key in self.slots else (key.rstrip("0123456789") or key)
        if base in self.slots:
            options = self.slots[base]
            value = self.rng.choice(options)
            if base != key and len(options) > 2:
                for _ in range(6):
                    if value != self.get(base):
                        break
                    value = self.rng.choice(options)
        elif base in _NUMERIC:
            value = _NUMERIC[base](self.rng, self.uid)
        else:
            raise KeyError(f"unknown template slot {key!r}")
        self[key] = value
        return value


@dataclass
class Counter:
    """Monotonic reference number shared by everything in one generator run."""

    value: int = 1000

    def next(self) -> int:
        self.value += 1
        return self.value


class Deck:
    """Draw from *items* without replacement, reshuffling only when exhausted.

    Plain `rng.choice` happily returns the same sentence template twice inside one
    paragraph, which produces the near-duplicate lines this corpus is supposed to
    avoid. A deck spreads templates evenly instead.
    """

    def __init__(self, rng: random.Random, items: Sequence[str]):
        self.rng = rng
        self.items = list(items)
        self._pool: list[str] = []

    def draw(self) -> str:
        if not self._pool:
            self._pool = self.items[:]
            self.rng.shuffle(self._pool)
        return self._pool.pop()


# --------------------------------------------------------------------------------------
# topic banks
# --------------------------------------------------------------------------------------


@dataclass
class TopicBank:
    label: str
    doc_kind: str  # what a long document of this topic is called
    titles: Sequence[str]
    sections: Sequence[str]
    sentences: Sequence[str]
    slots: dict[str, Sequence[str]]
    short_questions: Sequence[str]
    asks: Sequence[str]  # appended after a long document
    transcript: bool = False  # may also be rendered as a meeting/interview transcript
    speakers: Sequence[str] = field(default_factory=tuple)


SHARED_SLOTS: dict[str, Sequence[str]] = {
    "adj": (
        "measurable",
        "unexpected",
        "modest",
        "substantial",
        "reproducible",
        "marginal",
        "consistent",
        "short-lived",
        "well-documented",
        "counterintuitive",
        "gradual",
        "abrupt",
    ),
    "verb": (
        "reduced",
        "increased",
        "stabilised",
        "delayed",
        "amplified",
        "suppressed",
        "shifted",
        "narrowed",
        "widened",
        "flattened",
    ),
    "conn": (
        "As a result",
        "In practice",
        "By contrast",
        "For the same reason",
        "Notably",
        "On closer inspection",
        "Taken together",
        "In the follow-up round",
    ),
    "unit": ("units", "batches", "cycles", "intervals", "segments", "cases", "records"),
}


TOPICS: dict[str, TopicBank] = {}


def _bank(topic_id: str, **kwargs: Any) -> None:
    slots = dict(SHARED_SLOTS)
    slots.update(kwargs.pop("slots", {}))
    TOPICS[topic_id] = TopicBank(slots=slots, **kwargs)


_bank(
    "science",
    label="science",
    doc_kind="lab report",
    titles=(
        "Effect of {factor} on {measure} in {system}",
        "A replication study of {measure} drift under {factor}",
        "Field notes: {system} response to {factor}",
        "Instrument calibration report for {measure} in {system}",
    ),
    sections=(
        "Method",
        "Apparatus",
        "Sample preparation",
        "Observations",
        "Control runs",
        "Sources of error",
        "Discussion",
        "Follow-up experiments",
    ),
    sentences=(
        "Run {uid} exposed {n} {unit} of {system} to {factor} for {n2} minutes while {measure} was logged every {ms} ms.",
        "The {adj} response {verb} {measure} by roughly {pct} percent relative to the paired control.",
        "{conn}, the {instrument} drifted by {dec} {unit2} over the session, which we corrected in post-processing.",
        "Sample batch {ref} was prepared at {n} degrees and stored for {n2} hours before {measure} was read.",
        "Replicates disagreed by {pct} percent, so the run was repeated with a fresh {instrument} and a longer settling time.",
        "We attribute the {adj} offset in run {uid} to {failure}, not to {factor} itself.",
        "Across {n} sessions the mean {measure} was {dec} with a standard deviation of {dec2}.",
        "The {instrument} was recalibrated against the reference standard before every third run, most recently ahead of run {uid}.",
        "{conn}, removing {factor} from the protocol {verb} the variance between operators by about {pct} percent.",
        "Blind re-reads of {n} archived traces from series {ref} agreed with the original scoring in {pct} percent of cases.",
        "Ambient temperature held at {n} degrees plus or minus {dec}, which is inside the tolerance the method specifies.",
        "The residual pattern in run {uid} looks periodic, with a period close to {n2} {unit}.",
    ),
    slots={
        "factor": (
            "elevated humidity",
            "a stronger magnetic field",
            "reduced illumination",
            "an added surfactant",
            "faster stirring",
            "a colder buffer",
            "longer exposure",
            "a coarser mesh",
            "higher salinity",
            "intermittent vibration",
        ),
        "measure": (
            "conductivity",
            "fluorescence intensity",
            "settling time",
            "surface tension",
            "germination rate",
            "resonance frequency",
            "optical density",
            "diffusion length",
            "yield strength",
        ),
        "system": (
            "the diatom culture",
            "the copper lattice sample",
            "the aerogel disc",
            "the estuary sediment core",
            "the hydrogel column",
            "the test alloy coupon",
            "the moss transplant tray",
        ),
        "instrument": (
            "spectrometer",
            "load cell",
            "thermocouple array",
            "flow meter",
            "particle counter",
            "interferometer",
            "pH probe",
        ),
        "failure": (
            "a loose ground strap",
            "condensation on the window",
            "an ageing reference cell",
            "operator-dependent timing",
            "a partially blocked inlet",
            "an unshielded cable run",
        ),
    },
    short_questions=(
        "Explain in plain language why a control group is necessary when a measurement instrument drifts during a session.",
        "What is the difference between precision and accuracy for a laboratory instrument, and why does the distinction matter?",
        "Describe two practical ways to detect a systematic error that affects every run of an experiment equally.",
        "Why does averaging repeated readings help with random error but not with a calibration offset?",
        "Give a short explanation of what a p-value does and does not tell you about an experimental result.",
        "How would you decide whether an outlier in a data series should be excluded from the analysis?",
        "Explain what it means for an experiment to be reproducible and what a paper must report for that to be possible.",
        "Describe how you would design a blind re-read of archived measurements to check for scoring bias.",
    ),
    asks=(
        "Summarise the report above in five bullet points, then list every source of error the author admits to.",
        "Read the report above and write a critique: which conclusions are supported by the data, and which are not?",
        "Extract every numeric measurement from the report above and present them as a table with units.",
        "Based on the report above, propose the three follow-up experiments that would most reduce the remaining uncertainty.",
    ),
)

_bank(
    "history",
    label="history",
    doc_kind="chronicle",
    titles=(
        "The {org} of {place}, {year}-{year2}",
        "Notes toward a history of the {place} {trade}",
        "The {place} {event}: a documentary chronicle",
        "Administration and dissent in {place} under the {org}",
    ),
    sections=(
        "Background",
        "The first decade",
        "Trade and taxation",
        "The {event}",
        "Aftermath",
        "Sources and their limits",
        "Later interpretations",
    ),
    sentences=(
        "In {year} the {org} recorded {big} {unit} of {good} passing through the {place} customs house, entry {uid} in the ledger.",
        "The {figure} argued in {year} that the {event} had been provoked by the {org}, a reading later {verb} by the {place} archive.",
        "{conn}, the {trade} guild of {place} kept its own register, and its figures differ from the official ones by about {pct} percent.",
        "Charter {ref}, sealed in {year}, granted the {org} the right to levy a toll of {n} coins on every cart of {good}.",
        "Only {n} of the original {big} folios survive, and {pct} percent of those are damaged along the spine.",
        "The {figure} spent {n} years in {place} before the {event}, which explains the {adj} tone of the later letters.",
        "Population estimates for {place} in {year} range from {big} to {big2}, depending on whether the {trade} quarter is counted.",
        "{conn}, the {org} began to record disputes separately after {year}, which is why series {ref} is unusually detailed.",
        "A marginal note in folio {uid} claims that the {event} lasted {n} days; no other source repeats the figure.",
        "Historians disagree about whether the {org} ever enforced the {year} statute outside the walls of {place}.",
        "Wages in the {trade} rose by roughly {pct} percent in the decade after {year}, but rents rose faster.",
        "The chronicle attributed to the {figure} breaks off mid-sentence in folio {uid} and resumes {n} pages later in a different hand.",
    ),
    slots={
        "org": (
            "river guild",
            "salt commission",
            "harbour council",
            "cloth assize",
            "provincial treasury",
            "brotherhood of carters",
            "mint authority",
        ),
        "place": (
            "Valcrest",
            "Oldmarsh",
            "Aberholt",
            "Threeford",
            "Kesswater",
            "Dunhallow",
            "Marren Bay",
            "Stonereach",
        ),
        "trade": ("tanners", "coopers", "shipwrights", "weavers", "glaziers", "saltmakers", "cartwrights"),
        "good": ("wool", "salt", "timber", "dyed cloth", "iron blooms", "smoked fish", "window glass"),
        "event": ("grain riot", "harbour fire", "toll revolt", "winter siege", "great flood", "charter dispute"),
        "figure": (
            "town clerk",
            "visiting inspector",
            "guild warden",
            "cathedral notary",
            "harbour master",
            "itinerant judge",
        ),
    },
    short_questions=(
        "Explain why tax records are often more reliable than chronicles for reconstructing the economy of a medieval town.",
        "What are the main risks of relying on a single surviving manuscript when reconstructing a historical event?",
        "Describe how historians estimate the population of a city for a period with no census, and what can go wrong.",
        "Why do wage series and price series often tell different stories about living standards in the same decade?",
        "Explain the difference between a primary and a secondary source, with one concrete example of each.",
        "How should a historian treat a marginal note added to a document decades after it was written?",
        "Give a short account of why archives are systematically biased toward the concerns of the people who kept them.",
    ),
    asks=(
        "Summarise the chronicle above and list the three claims that rest on a single source.",
        "Write a short critical commentary on the chronicle above: where is the author inferring rather than reporting?",
        "Build a timeline from the chronicle above, one line per dated event, in chronological order.",
        "Using only the chronicle above, describe what can and cannot be said about the town's economy.",
    ),
)

_bank(
    "law",
    label="law",
    doc_kind="contract",
    titles=(
        "Master {agreement} between {party} and {party2}",
        "{agreement} — execution copy, reference {ref}",
        "Schedule {n} to the {agreement} dated {day} March {year}",
        "Amended and restated {agreement} (internal draft {uid})",
    ),
    sections=(
        "Definitions",
        "Scope of services",
        "Fees and invoicing",
        "Term and termination",
        "Confidentiality",
        "Data protection",
        "Liability and indemnities",
        "Change control",
        "Governing law",
    ),
    sentences=(
        'Clause {n}.{n2}: "{party}" means the entity identified in Schedule {n3}, together with any {affiliate} it controls.',
        "The {party} shall provide the {service} during the Term, subject to the acceptance procedure in clause {n}.{n2}.",
        "Invoices are payable within {n} days of receipt; late payment carries interest at {n2} percent above the reference rate.",
        "Either party may terminate for {cause} on {n} days written notice, without prejudice to accrued rights under clause {n2}.",
        "The aggregate liability of the {party} under this agreement is capped at the fees paid in the preceding {n} months.",
        "{conn}, nothing in clause {n} limits liability for {excluded}, which cannot be excluded by law.",
        "Confidential Information does not include information that the receiving party can show was already public through no breach of clause {n}.",
        "The {party} shall retain records relating to the {service} for {n} years after the end of the Term, reference {ref}.",
        "Change requests take effect only when signed by an authorised representative of both parties; see the template in Schedule {n}.",
        "Where the {service} is provided from a third country, the parties shall enter into the standard contractual clauses within {n} days of the transfer being agreed.",
        "Service credits of {pct} percent of the monthly fee apply for each full hour the availability target in Schedule {n} is missed.",
        "Notices are validly given when delivered to the address in clause {n}.{n2} or acknowledged by return email.",
    ),
    slots={
        "agreement": (
            "services agreement",
            "software licence agreement",
            "data processing agreement",
            "supply agreement",
            "maintenance agreement",
            "reseller agreement",
        ),
        "party": (
            "Supplier",
            "Customer",
            "Licensor",
            "Licensee",
            "Processor",
            "Controller",
            "Contractor",
        ),
        "service": (
            "hosting service",
            "support service",
            "implementation work",
            "managed backup service",
            "training programme",
            "audit assistance",
        ),
        "cause": (
            "material breach that remains unremedied",
            "insolvency of the other party",
            "convenience",
            "a change of control",
            "a persistent failure to meet the service levels",
        ),
        "excluded": (
            "death or personal injury caused by negligence",
            "fraud or fraudulent misrepresentation",
            "wilful misconduct",
        ),
        "affiliate": ("affiliate", "subsidiary", "group company"),
    },
    short_questions=(
        "Explain in plain language what an indemnity clause does and how it differs from a liability cap.",
        "What is the practical difference between a data controller and a data processor in a service contract?",
        "Describe what a change control procedure in a services contract is for, and what happens without one.",
        "Explain why a confidentiality clause normally carves out information that is already public.",
        "What should a termination-for-convenience clause say about work already in progress?",
        "Summarise the risks of agreeing to an uncapped liability clause in a software support contract.",
        "Explain what service credits are and why they are usually described as the sole remedy for downtime.",
    ),
    asks=(
        "Review the contract above and list every obligation that falls on the Supplier, with the clause number.",
        "Summarise the contract above for a non-lawyer in under 200 words, then flag the three riskiest clauses.",
        "Read the contract above and produce a redline proposal from the Customer's perspective on liability and termination.",
        "Extract every deadline and notice period from the contract above into a table of clause, party, and duration.",
    ),
)

_bank(
    "medicine",
    label="medicine",
    doc_kind="case notes",
    titles=(
        "Case notes {ref}: {presentation} in a {age}-year-old",
        "Ward round summary, bay {n}, admission {ref}",
        "Discharge summary for admission {ref} ({presentation})",
        "Clinical audit extract: {presentation} pathway, quarter {n}",
    ),
    sections=(
        "Presentation",
        "History",
        "Examination",
        "Investigations",
        "Working diagnosis",
        "Management",
        "Progress",
        "Discharge plan",
        "Audit notes",
    ),
    sentences=(
        "Day {n}: the patient reported {symptom}, unchanged from the previous review, with observations recorded at {ms} hours.",
        "Baseline {marker} was {dec} and repeat sampling on day {n} gave {dec2}, an increase of about {pct} percent.",
        "{conn}, the {symptom} settled after {n} doses of the {drug}, and the {marker} trended back toward the reference range.",
        "Examination found no {finding}; the previously noted {finding2} had resolved by day {n}.",
        "Case {uid} was flagged for review because the {investigation} was requested twice within {n} hours.",
        "The team documented a plan to review the {drug} dose once the {marker} had been stable for {n} days.",
        "Allergy status was rechecked on admission and recorded as {allergy} in the electronic record, entry {ref}.",
        "{conn}, the audit found that {pct} percent of {presentation} admissions had a documented {investigation} within four hours.",
        "The patient's own account of onset differs from the referral letter by roughly {n} days, which is noted for the record.",
        "A follow-up appointment was booked for {n} weeks, with clear safety-netting advice given verbally and in writing.",
        "Observations remained within the expected range apart from a transient rise in {marker} on day {n}.",
        "Discharge was delayed by {n} days while the community team arranged support at home.",
    ),
    slots={
        "presentation": (
            "unexplained fatigue",
            "chest discomfort on exertion",
            "recurrent dizziness",
            "persistent cough",
            "postoperative fever",
            "new-onset ankle swelling",
            "intermittent abdominal pain",
        ),
        "symptom": (
            "shortness of breath on stairs",
            "a dull ache after meals",
            "poor sleep",
            "reduced appetite",
            "morning stiffness",
            "light-headedness on standing",
        ),
        "marker": (
            "the inflammatory marker",
            "haemoglobin",
            "serum creatinine",
            "the resting heart rate",
            "oxygen saturation",
            "fasting glucose",
        ),
        "drug": (
            "oral analgesic",
            "inhaled bronchodilator",
            "antiemetic",
            "electrolyte replacement",
            "short course of steroids",
        ),
        "finding": (
            "focal tenderness",
            "peripheral oedema",
            "an audible murmur",
            "neurological deficit",
            "rash over the trunk",
        ),
        "investigation": (
            "chest radiograph",
            "twelve-lead ECG",
            "renal panel",
            "abdominal ultrasound",
            "venous blood gas",
        ),
        "allergy": ("no known drug allergies", "penicillin rash in childhood", "documented latex sensitivity"),
        "age": ("34", "47", "58", "63", "71", "29", "82"),
    },
    short_questions=(
        "Explain, for a general audience, why a single abnormal blood test is rarely enough to make a diagnosis.",
        "What is safety-netting advice at discharge, and what should it always contain?",
        "Describe the difference between sensitivity and specificity of a clinical test using a simple example.",
        "Why is the timing of symptom onset so often decisive in clinical reasoning? Give two examples.",
        "Explain in plain language what a clinical audit is and how it differs from research.",
        "What information must a discharge summary contain so that a community team can safely continue care?",
        "Describe why patient-reported onset and referral-letter onset frequently disagree, and how a clinician should handle that.",
    ),
    asks=(
        "Summarise the case notes above into a structured handover: background, current problem, assessment, plan.",
        "Read the case notes above and list every investigation ordered, with the day it was requested.",
        "From the case notes above, write a plain-language letter to the patient explaining what happened and what comes next.",
        "Identify the documentation gaps in the case notes above that an audit would flag, and explain why each matters.",
    ),
)

_bank(
    "business",
    label="business",
    doc_kind="operations review",
    titles=(
        "Quarterly operations review: {unit_name}, Q{q} {fyear}",
        "Post-incident business review {ref}: {incident}",
        "{unit_name} planning memo — {topic_word} for the next two quarters",
        "Cost review {ref}: {topic_word} across {unit_name}",
    ),
    sections=(
        "Summary",
        "Demand",
        "Capacity",
        "Costs",
        "Quality",
        "Risks",
        "Decisions requested",
        "Open questions",
    ),
    sentences=(
        "{unit_name} handled {big} {unit} in the quarter, {pct} percent above plan, with backlog peaking in week {n}.",
        "The {metric} moved from {dec} to {dec2} after the {change}, which is the largest single-quarter shift on record for this team.",
        "{conn}, unit cost {verb} by roughly {pct} percent once the {change} was fully rolled out in region {ref}.",
        "Headcount stood at {n} at quarter end against an approved plan of {n2}; recruitment for the remaining roles is under way.",
        "Escalation {uid} showed that the handover between {unit_name} and the vendor is still undocumented.",
        "The {metric} target of {dec} was missed in {n} of {n2} weeks, mostly in the two weeks around the {incident}.",
        "Vendor {ref} delivered {pct} percent of orders on time, down from the prior quarter, and we have opened a review.",
        "{conn}, we recommend deferring the {change} until the {metric} has been stable for {n} consecutive weeks.",
        "Training completion reached {pct} percent, with the gap concentrated in the {n} newest joiners.",
        "The forecast assumes demand grows by {n} percent per quarter, which is the mid-case, not the optimistic case.",
        "Approval is requested for {big} of additional spend in line item {uid}, offset by the savings described above.",
        "Risk register entry {ref} remains open: a single supplier still covers {pct} percent of the volume.",
    ),
    slots={
        "unit_name": (
            "the fulfilment team",
            "customer operations",
            "the field service group",
            "the onboarding desk",
            "the returns centre",
            "the partner support team",
        ),
        "metric": (
            "first-response time",
            "cost per order",
            "on-time delivery rate",
            "rework rate",
            "utilisation",
            "net retention",
            "average handling time",
        ),
        "change": (
            "routing change",
            "new shift pattern",
            "self-service rollout",
            "supplier consolidation",
            "pricing update",
            "automated triage step",
        ),
        "incident": (
            "warehouse outage",
            "billing misconfiguration",
            "carrier strike",
            "portal downtime",
            "data import failure",
        ),
        "topic_word": ("capacity", "cost to serve", "quality", "staffing", "supplier risk", "service levels"),
        "q": ("1", "2", "3", "4"),
        "fyear": ("2024", "2025", "2026"),
    },
    short_questions=(
        "Explain the difference between a leading and a lagging operational metric, with one example of each.",
        "Why is average handling time a dangerous target to optimise on its own? Suggest a better paired metric.",
        "Describe how you would decide whether to fix a process problem with headcount or with automation.",
        "What belongs in a post-incident business review that does not belong in a technical post-mortem?",
        "Explain in plain language why a single-supplier dependency is a risk even when that supplier performs well.",
        "How would you present a cost increase to a sceptical executive who only reads the first paragraph?",
        "Describe two ways a quarterly forecast can be wrong even when every input number is accurate.",
    ),
    asks=(
        "Summarise the review above into an executive brief of at most 150 words plus three decisions requested.",
        "Read the review above and list the risks in order of expected impact, with your reasoning for the ordering.",
        "Extract every metric mentioned in the review above with its value and direction of travel.",
        "Turn the review above into a one-page plan for the next quarter with owners and measurable targets.",
    ),
    transcript=True,
    speakers=("Priya", "Marcus", "Dana", "Tomas", "Ines", "Rafael"),
)

_bank(
    "everyday",
    label="everyday",
    doc_kind="community notice",
    titles=(
        "Residents' notice: {subject} at {venue}",
        "Minutes of the {venue} committee, meeting {n}",
        "Handbook extract: {subject} for new members of {venue}",
        "Seasonal plan for {venue}: {subject}",
    ),
    sections=(
        "What is changing",
        "Timings",
        "Who is affected",
        "What you need to do",
        "Costs",
        "Questions raised",
        "Next meeting",
    ),
    sentences=(
        "From {day} of next month the {subject} at {venue} moves to {n} in the morning, notice reference {ref}.",
        "{conn}, {n} households replied to the survey, and {pct} percent preferred the later slot.",
        "The {role} reminded everyone that the {item} must be returned to the store cupboard within {n} hours of use.",
        "Item {uid} on the agenda was the {problem}, which has now been reported {n} times this year.",
        "The cost per household works out at about {n} currency units per month, unchanged since {year}.",
        "Volunteers are needed for {n} shifts; sign-up sheet {ref} is on the noticeboard by the side entrance.",
        "{conn}, the committee agreed to trial the change for {n} weeks and review it at meeting {n2}.",
        "Please do not leave the {item} in the corridor overnight, as it blocks the fire route; this was raised again as item {uid}.",
        "The {role} will circulate the revised plan by email within {n} days of this notice.",
        "Parking near {venue} will be restricted on {n} days in total, all of them announced two weeks in advance.",
        "A reminder that the key for the {item} store is held by the {role}, not by the caretaker, and must be signed out in book {ref}.",
        "{n} of the {n2} radiators in the hall were serviced in {year}; the rest are scheduled for this autumn.",
    ),
    slots={
        "subject": (
            "recycling collection",
            "hall booking rules",
            "the shared garden rota",
            "the parking permit scheme",
            "fire drill arrangements",
            "the tool library",
        ),
        "venue": (
            "Ashgrove Community Hall",
            "the Riverside allotments",
            "Beckton Court",
            "the Old Library annexe",
            "the Willow Lane centre",
        ),
        "role": ("secretary", "treasurer", "caretaker", "chair", "volunteer coordinator"),
        "item": ("projector", "trestle tables", "garden tools", "recycling bins", "sound system", "first-aid kit"),
        "problem": (
            "blocked side gate",
            "flickering hall lighting",
            "noise after ten in the evening",
            "overflowing bins",
            "damp in the storeroom",
        ),
    },
    short_questions=(
        "Write a short, friendly notice asking neighbours not to leave bicycles in a shared stairwell.",
        "Explain how to plan a week of meals for four people on a tight budget without wasting food.",
        "Give practical advice for someone who has to run a first committee meeting and has never chaired one.",
        "Describe a simple system for keeping track of shared household chores that does not require an app.",
        "What is a fair way to split a shared bill when one person had much more than everyone else?",
        "Write clear instructions for a neighbour who is watering your plants for two weeks while you are away.",
        "Explain how to decide whether to repair an old appliance or replace it, in plain language.",
    ),
    asks=(
        "Rewrite the notice above so that it fits on a single postcard while keeping every deadline.",
        "Summarise the minutes above into a list of decisions, actions, owners and dates.",
        "Read the notice above and draft a polite reply asking for two things to be reconsidered.",
        "Turn the document above into a short FAQ with the six questions residents are most likely to ask.",
    ),
    transcript=True,
    speakers=("Nadia", "Ollie", "Beth", "Samir", "Greta", "Luca"),
)

_bank(
    "creative",
    label="creative",
    doc_kind="story draft",
    titles=(
        "Draft {n} — {story_title}",
        "{story_title}: opening chapters",
        "Workshop submission {ref}: {story_title}",
        "Notes and draft for {story_title}",
    ),
    sections=(
        "Opening",
        "The house",
        "What the neighbours said",
        "Night",
        "The letter",
        "Departure",
        "Revision notes",
    ),
    sentences=(
        "{character} counted {n} steps from the {place_c} to the gate and stopped, because the {object} was not where it had been.",
        "{conn}, the {weather} came in off the flats and for {n} days the whole street smelled of {smell}.",
        "Letter {uid} was still on the table, unopened, with {character2}'s handwriting slanting across the envelope.",
        "The {object} had belonged to {character2}'s mother and had stood in the same corner since {year}; nobody could agree what it was for.",
        "{character} had promised to be back before {n} o'clock, and it was already later than that by any clock in the house.",
        "In the {place_c} at {n} in the afternoon the light was the colour of {smell}, which is not a sensible description but is the true one.",
        "{conn}, {character} did the arithmetic again: {n} days of rent, {n2} in the tin, and no answer to the letter.",
        "The neighbours said {n} different things about the night of the {weather}, and none of the versions matched.",
        "{character2} kept a list of everything the house had lost, and item {uid} on that list was simply the word 'quiet'.",
        "Nobody had used the {object} since {year}, but it was polished every spring without discussion.",
        "The {weather} stopped some time after {n} o'clock; {character} noticed only because the {object} had stopped rattling.",
        "There were {n} photographs in the drawer and {character} was in none of them, which felt like an answer.",
    ),
    slots={
        "story_title": (
            "The Long Way Round the Harbour",
            "Nine Doors on Alder Street",
            "What the Tide Kept",
            "The Inventory",
            "A Short History of the Kitchen Table",
            "Everything the House Lost",
        ),
        "character": ("Mira", "Aldo", "Nell", "Bram", "Josefa", "Teodor", "Wren"),
        "place_c": ("kitchen", "boat shed", "back stairs", "orchard", "washroom", "attic landing"),
        "object": ("brass barometer", "sewing box", "wall clock", "copper kettle", "harbour map", "iron key"),
        "weather": ("east wind", "sea fog", "hail", "first frost", "long rain"),
        "smell": ("wet rope", "burnt sugar", "cold iron", "cut grass", "paraffin"),
    },
    short_questions=(
        "Write the opening paragraph of a story in which a character returns to a house they have not entered in twenty years.",
        "Describe a rainy harbour at dawn in exactly one paragraph, without using the words rain, grey, or lonely.",
        "Write a short scene in which two people argue without either of them saying what the argument is really about.",
        "Invent a small ritual that a family performs every spring and explain, in a paragraph, how it started.",
        "Write six lines of dialogue that reveal that one speaker is lying, without stating that they are lying.",
        "Describe an object that has outlived everyone who knew what it was for, in under 120 words.",
        "Write the last paragraph of a novel you have not written, so that it sounds like an ending.",
    ),
    asks=(
        "Give a structural critique of the draft above: pacing, point of view, and what the opening promises.",
        "Rewrite the first two paragraphs of the draft above in a tighter, plainer style, then explain your choices.",
        "Read the draft above and suggest three concrete cuts that would lose no information but improve the rhythm.",
        "Continue the draft above for two paragraphs in the same voice, then note where you diverged deliberately.",
    ),
)

_bank(
    "math",
    label="math",
    doc_kind="problem set",
    titles=(
        "Problem set {n}: {math_topic}",
        "Worked notes on {math_topic} (revision {uid})",
        "Seminar handout: {math_topic} and {math_topic2}",
        "Exercise sheet {ref}: {math_topic}",
    ),
    sections=(
        "Warm-up",
        "Core exercises",
        "Worked example",
        "Common mistakes",
        "Harder problems",
        "Hints",
        "Answers",
    ),
    sentences=(
        "Exercise {uid}: show that the {object_m} defined by a = {n} and b = {n2} satisfies the stated {property}.",
        "The standard proof of the {property} uses {method} and runs to {n} pages, but the argument below avoids it entirely.",
        "{conn}, replacing {n} by any value above {n2} keeps the conclusion but breaks the estimate in step three.",
        "A frequent mistake is to divide by {object_m} without checking that it is non-zero when the parameter equals {n}.",
        "Exercise {uid}: compute the {quantity} for n = {n} and for n = {n2}, then describe the pattern.",
        "The bound improves from {dec} to {dec2} once {method} is applied twice rather than once.",
        "Hint for exercise {uid}: consider the {object_m} modulo {n}, and count the residues that survive.",
        "{conn}, the {property} fails for {n} of the {n2} cases below; identify them before reading the answers.",
        "Write the {quantity} as a sum of {n} terms and show that all but {n2} of them cancel.",
        "The answer to exercise {uid} is {big}; a full derivation appears in the answers section.",
        "Note that {method} gives the result in one line, whereas the elementary argument needs {n} cases.",
        "Estimate the {quantity} to within {pct} percent without a calculator, then check your estimate exactly.",
    ),
    slots={
        "math_topic": (
            "modular arithmetic",
            "linear recurrences",
            "convex inequalities",
            "counting with symmetry",
            "elementary number theory",
            "coordinate geometry",
            "generating functions",
        ),
        "object_m": ("sequence", "polynomial", "matrix", "graph", "residue class", "triangle", "partition"),
        "property": (
            "triangle inequality",
            "divisibility criterion",
            "pigeonhole bound",
            "monotonicity claim",
            "closed form",
            "symmetry argument",
        ),
        "method": (
            "induction on n",
            "a telescoping sum",
            "the pigeonhole principle",
            "a change of variables",
            "a counting bijection",
            "the Euclidean algorithm",
        ),
        "quantity": ("determinant", "greatest common divisor", "number of solutions", "sum of the first n terms", "area"),
    },
    short_questions=(
        "Explain why the pigeonhole principle proves that two people in a room of 400 share a birthday, and what it does not prove.",
        "Describe, without formulas, what it means for a sequence to converge, and give an everyday analogy.",
        "Explain why the greatest common divisor of two numbers can be found without factorising either of them.",
        "What is the difference between a proof by induction and a proof by contradiction? Give a one-line example of each.",
        "Explain in plain language why the sum of the first n odd numbers is always a perfect square.",
        "Describe why dividing by a variable is dangerous when solving an equation, with a worked example.",
        "Explain what a counterexample is and why one is enough to refute a universal claim.",
    ),
    asks=(
        "Work through every exercise in the sheet above and show your reasoning step by step.",
        "Read the problem set above and write model answers for the three hardest exercises only.",
        "Identify each place in the sheet above where the phrasing is ambiguous, and propose a precise rewording.",
        "Turn the sheet above into a graded set of hints: one nudge, one substantial hint, one full solution per exercise.",
    ),
)

_bank(
    "reasoning",
    label="reasoning",
    doc_kind="puzzle dossier",
    titles=(
        "Dossier {ref}: the {case_name} scheduling problem",
        "Constraint briefing {uid}: allocating {resource}",
        "Puzzle collection {n}: {case_name}",
        "Planning notes for the {case_name} rota",
    ),
    sections=(
        "The situation",
        "Constraints",
        "What people said",
        "Partial deductions",
        "Contradictions found",
        "Remaining unknowns",
        "Your task",
    ),
    sentences=(
        "{person} must be assigned before {person2}, and neither may take slot {n}.",
        "Statement {uid}: {person} claims that {person2} was never assigned to the {resource} on day {n}.",
        "{conn}, exactly {n} of the {n2} people can be on duty at once, which rules out the naive rota.",
        "If {person} takes the early slot on day {n} then {person2} takes the late one; the reverse is not required.",
        "Nobody may work {n} consecutive days, and {person} has already worked {n2} of the last five.",
        "The {resource} is unavailable on day {n}, so any plan that uses it that day is immediately invalid.",
        "{conn}, statements {uid} and {uid2} cannot both be true, which narrows the possibilities considerably.",
        "{person} is available only in the second half of week {n}, and {person2} only in the first half.",
        "At most {n} assignments may be changed after publication, and each change needs a written reason.",
        "The rota published on day {n} violated constraint {uid}, which is why it was withdrawn within the hour.",
        "Two of the {n} candidate schedules satisfy every hard constraint; the rest fail at least one.",
        "If the {resource} count drops to {n}, then the fairness rule and the coverage rule cannot both hold.",
    ),
    slots={
        "case_name": (
            "night shift",
            "harbour pilot",
            "conference room",
            "delivery van",
            "laboratory bench",
            "reading room",
        ),
        "resource": ("the shared van", "bench three", "the small meeting room", "the on-call phone", "the loading bay"),
        "person": ("Ada", "Bo", "Cai", "Dita", "Emre", "Fenna", "Gus", "Hana", "Ivo", "Juno"),
    },
    short_questions=(
        "Three people each make one statement and exactly one of them is lying. Explain the general method for solving such puzzles.",
        "Explain why 'all A are B' does not imply 'all B are A', using a concrete everyday example.",
        "Describe a systematic way to check whether a set of scheduling constraints is satisfiable at all.",
        "Explain the difference between a necessary and a sufficient condition, with a clear example of each.",
        "You have twelve coins, one of which is a different weight. Explain the reasoning strategy, not the full solution.",
        "Explain why eliminating impossible options is often faster than searching for the correct one directly.",
        "Describe how to detect that a puzzle has more than one valid solution rather than exactly one.",
    ),
    asks=(
        "Solve the scheduling problem above, state the unique assignment, and justify each step.",
        "Determine whether the constraints above are satisfiable; if they are not, identify the minimal conflicting subset.",
        "Read the dossier above and list which statements must be false if the published rota was valid.",
        "Produce a valid rota from the dossier above and prove that no constraint is violated.",
    ),
)

_bank(
    "code",
    label="code",
    doc_kind="source file",
    titles=(
        "Module review: {module}.{ext}",
        "Refactor brief for {module}",
        "Incident follow-up: {module} in the {service_c}",
        "Code reading notes for {module}",
    ),
    sections=("Overview", "Hot path", "Error handling", "Tests", "Known issues", "Migration notes"),
    sentences=(
        "The function {fn}_{uid} is called once per request and allocates a new {structure} every time.",
        "{conn}, retry {n} of the {service_c} client uses a fixed backoff, which is why the p{n2} latency has a step in it.",
        "Ticket {ref} reports that {fn}_{uid} silently swallows a {error} instead of propagating it.",
        "The cache in {module} is keyed by {key_c} only, so the {n} callers with different {key_c2} values collide.",
        "Tests cover the happy path and {n} error cases; the {error} branch has no coverage at all.",
        "{conn}, moving the {structure} construction out of the loop cut allocation count by about {pct} percent locally.",
        "The {service_c} timeout is {ms} ms, which is shorter than the {n}-second retry budget above it.",
        "Function {fn}_{uid} returns {n} different shapes depending on its arguments, which the type hints do not capture.",
        "A comment from {year} claims the {structure} must stay sorted, but nothing enforces that invariant today.",
        "Log line {uid} prints the whole {structure}, which is why the log volume triples under load.",
        "The migration renames {key_c} to {key_c2} and keeps a compatibility shim for {n} releases.",
        "Concurrency is bounded by a semaphore of {n}; raising it did not help because the {service_c} is the bottleneck.",
    ),
    slots={
        "module": (
            "order_router",
            "session_store",
            "billing_sync",
            "media_pipeline",
            "auth_gateway",
            "search_indexer",
            "config_loader",
        ),
        "ext": ("py", "ts", "go", "rs"),
        "fn": ("resolve", "flush", "normalise", "dispatch", "reconcile", "hydrate", "expire"),
        "structure": ("dictionary", "buffer", "connection pool", "index shard", "queue", "lookup table"),
        "service_c": ("payments service", "identity service", "object store", "search cluster", "message broker"),
        "error": ("timeout error", "decode error", "permission error", "conflict error", "not-found error"),
        "key_c": ("tenant id", "region", "user id", "locale", "api version", "shard key"),
    },
    short_questions=(
        "Explain the difference between a mutex and a semaphore, and when each is the right tool.",
        "Write a Python function that returns the longest run of consecutive equal values in a list, with a docstring.",
        "Why is catching a broad exception and logging it usually worse than letting it propagate? Give two reasons.",
        "Explain what an idempotent HTTP endpoint is and why retries make idempotency a requirement.",
        "Describe how you would find the source of a memory leak in a long-running service, step by step.",
        "Explain, with a short example, why floating point equality comparisons are unreliable.",
        "What is the difference between a unit test and an integration test, and what does each fail to catch?",
    ),
    asks=(
        "Review the source file above and list the bugs you find, most severe first, with the line context.",
        "Refactor the source file above for readability without changing behaviour, and explain each change.",
        "Write unit tests for the file above, covering the error branches that are currently untested.",
        "Explain what the file above does, function by function, to a developer who has never seen this codebase.",
    ),
)


LONG_TOPICS = [t for t in TOPICS if t != "multilingual"]
ALL_TOPICS = LONG_TOPICS + ["multilingual"]


def _audit_banks() -> None:
    """Every sentence template must be able to render a unique instance.

    A template with no numeric slot can only produce as many distinct sentences as
    its slot vocabulary allows, which is how verbatim repeats sneak into long
    documents. Composing 60k-token prompts out of a few hundred distinct sentences
    would hand prefix caching a free win, so this is enforced rather than reviewed.
    """
    for topic, bank in TOPICS.items():
        for tpl in bank.sentences:
            keys = {k.rstrip("0123456789") or k for k in re.findall(r"{(\w+)}", tpl)}
            unknown = keys - set(bank.slots) - set(_NUMERIC)
            if unknown:
                raise AssertionError(f"{topic}: template uses unknown slots {sorted(unknown)}")
            if not keys & set(_NUMERIC):
                raise AssertionError(f"{topic}: template has no numeric slot: {tpl!r}")


_audit_banks()


# --------------------------------------------------------------------------------------
# composition
# --------------------------------------------------------------------------------------


def sentence(rng: random.Random, topic: str, counter: Counter, deck: Deck | None = None) -> str:
    bank = TOPICS[topic]
    tpl = deck.draw() if deck is not None else rng.choice(bank.sentences)
    text = tpl.format_map(Filler(rng, bank.slots, counter.next()))
    return text[0].upper() + text[1:]


def title(rng: random.Random, topic: str, counter: Counter) -> str:
    bank = TOPICS[topic]
    tpl = rng.choice(bank.titles)
    return tpl.format_map(Filler(rng, bank.slots, counter.next()))


def paragraph(
    rng: random.Random,
    topic: str,
    counter: Counter,
    n_sentences: int | None = None,
    deck: Deck | None = None,
) -> str:
    n = n_sentences if n_sentences is not None else rng.randint(3, 6)
    deck = deck if deck is not None else Deck(rng, TOPICS[topic].sentences)
    return " ".join(sentence(rng, topic, counter, deck) for _ in range(n))


# --- synthetic source files -----------------------------------------------------------

_PY_HELPERS = (
    ("def {name}(items):\n"
     "    \"\"\"Return the {word} of *items*, ignoring entries below {n}.\"\"\"\n"
     "    kept = [x for x in items if x >= {n}]\n"
     "    if not kept:\n"
     "        return 0\n"
     "    return sum(kept) // len(kept)\n"),
    ("def {name}(rows, key):\n"
     "    \"\"\"Group *rows* by *key* and drop groups smaller than {n}.\"\"\"\n"
     "    out = {{}}\n"
     "    for row in rows:\n"
     "        out.setdefault(row.get(key), []).append(row)\n"
     "    return {{k: v for k, v in out.items() if len(v) >= {n}}}\n"),
    ("def {name}(text):\n"
     "    \"\"\"Normalise *text* for the {word} index (case, spacing, stray dashes).\"\"\"\n"
     "    cleaned = \" \".join(text.replace(\"-\", \" \").split())\n"
     "    return cleaned.lower()[:{n}]\n"),
    ("class {cls}:\n"
     "    \"\"\"Small {word} cache with a fixed capacity of {n} entries.\"\"\"\n\n"
     "    def __init__(self, capacity={n}):\n"
     "        self.capacity = capacity\n"
     "        self._data = {{}}\n\n"
     "    def put(self, key, value):\n"
     "        if len(self._data) >= self.capacity:\n"
     "            self._data.pop(next(iter(self._data)))\n"
     "        self._data[key] = value\n\n"
     "    def get(self, key, default=None):\n"
     "        return self._data.get(key, default)\n"),
    ("def {name}(a, b, tolerance={dec}):\n"
     "    \"\"\"True when *a* and *b* agree within *tolerance* ({word} comparison).\"\"\"\n"
     "    return abs(a - b) <= tolerance * max(1.0, abs(a), abs(b))\n"),
    ("def {name}(records):\n"
     "    \"\"\"Split *records* into ({word}, rejected) using rule {uid}.\"\"\"\n"
     "    good, bad = [], []\n"
     "    for rec in records:\n"
     "        (good if rec.get(\"score\", 0) >= {n} else bad).append(rec)\n"
     "    return good, bad\n"),
)

_TS_HELPERS = (
    ("export function {name}(items: number[]): number {{\n"
     "  // rule {uid}: ignore anything below {n}\n"
     "  const kept = items.filter((x) => x >= {n});\n"
     "  if (kept.length === 0) return 0;\n"
     "  return Math.round(kept.reduce((a, b) => a + b, 0) / kept.length);\n"
     "}}\n"),
    ("export interface {cls} {{\n"
     "  id: string;\n"
     "  {word}: number;\n"
     "  updatedAt: string;\n"
     "  tags: string[];\n"
     "}}\n\n"
     "export function {name}(rows: {cls}[], min = {n}): {cls}[] {{\n"
     "  return rows.filter((r) => r.{word} >= min).sort((a, b) => b.{word} - a.{word});\n"
     "}}\n"),
    ("export async function {name}(url: string, retries = {n}): Promise<Response> {{\n"
     "  let lastError: unknown;\n"
     "  for (let attempt = 0; attempt < retries; attempt += 1) {{\n"
     "    try {{\n"
     "      return await fetch(url);\n"
     "    }} catch (err) {{\n"
     "      lastError = err;\n"
     "    }}\n"
     "  }}\n"
     "  throw lastError;\n"
     "}}\n"),
    ("export function {name}(input: Record<string, unknown>): Map<string, number> {{\n"
     "  const out = new Map<string, number>();\n"
     "  for (const [key, value] of Object.entries(input)) {{\n"
     "    if (typeof value === \"number\" && value >= {n}) out.set(key, value);\n"
     "  }}\n"
     "  return out;\n"
     "}}\n"),
)

_GO_HELPERS = (
    ("// {name} returns the {word} of xs, ignoring values below {n}.\n"
     "func {name}(xs []int) int {{\n"
     "\tkept := make([]int, 0, len(xs))\n"
     "\tfor _, x := range xs {{\n"
     "\t\tif x >= {n} {{\n"
     "\t\t\tkept = append(kept, x)\n"
     "\t\t}}\n"
     "\t}}\n"
     "\tif len(kept) == 0 {{\n"
     "\t\treturn 0\n"
     "\t}}\n"
     "\ttotal := 0\n"
     "\tfor _, x := range kept {{\n"
     "\t\ttotal += x\n"
     "\t}}\n"
     "\treturn total / len(kept)\n"
     "}}\n"),
    ("// {cls} is one entry of the {word} pipeline (rule {uid}).\n"
     "type {cls} struct {{\n"
     "\tID      string\n"
     "\t{word_title} int\n"
     "\tUpdated time.Time\n"
     "}}\n\n"
     "// {name} drops entries below {n} and forwards the rest.\n"
     "func {name}(in <-chan {cls}, out chan<- {cls}) {{\n"
     "\tdefer close(out)\n"
     "\tfor item := range in {{\n"
     "\t\tif item.{word_title} < {n} {{\n"
     "\t\t\tcontinue\n"
     "\t\t}}\n"
     "\t\tout <- item\n"
     "\t}}\n"
     "}}\n"),
    ("// {name} retries fn up to {n} times with a fixed pause of {dec} seconds.\n"
     "func {name}(fn func() error) error {{\n"
     "\tvar err error\n"
     "\tfor attempt := 0; attempt < {n}; attempt++ {{\n"
     "\t\tif err = fn(); err == nil {{\n"
     "\t\t\treturn nil\n"
     "\t\t}}\n"
     "\t\ttime.Sleep({dec} * time.Second)\n"
     "\t}}\n"
     "\treturn err\n"
     "}}\n"),
)

_RUST_HELPERS = (
    ("/// Returns the {word} of `xs`, ignoring values below {n}.\n"
     "pub fn {name}(xs: &[i64]) -> i64 {{\n"
     "    let kept: Vec<i64> = xs.iter().copied().filter(|x| *x >= {n}).collect();\n"
     "    if kept.is_empty() {{\n"
     "        return 0;\n"
     "    }}\n"
     "    kept.iter().sum::<i64>() / kept.len() as i64\n"
     "}}\n"),
    ("/// One entry of the {word} pipeline (rule {uid}).\n"
     "#[derive(Debug, Clone, PartialEq)]\n"
     "pub struct {cls} {{\n"
     "    pub id: String,\n"
     "    pub {word}: u32,\n"
     "    pub updated_at: String,\n"
     "}}\n\n"
     "impl {cls} {{\n"
     "    pub fn is_active(&self) -> bool {{\n"
     "        self.{word} >= {n}\n"
     "    }}\n"
     "}}\n"),
    ("/// Keeps only the entries at or above {n}, sorted by key (rule {uid}).\n"
     "pub fn {name}(input: &HashMap<String, i64>) -> BTreeMap<String, i64> {{\n"
     "    input\n"
     "        .iter()\n"
     "        .filter(|(_, v)| **v >= {n})\n"
     "        .map(|(k, v)| (k.clone(), *v))\n"
     "        .collect()\n"
     "}}\n"),
    ("/// Retries `f` up to {n} times, returning the last error (rule {uid}).\n"
     "pub fn {name}<F, T, E>(mut f: F) -> Result<T, E>\n"
     "where\n"
     "    F: FnMut() -> Result<T, E>,\n"
     "{{\n"
     "    let mut last = f();\n"
     "    for _ in 1..{n} {{\n"
     "        if last.is_ok() {{\n"
     "            return last;\n"
     "        }}\n"
     "        last = f();\n"
     "    }}\n"
     "    last\n"
     "}}\n"),
)

_SQL_HELPERS = (
    ("-- rule {uid}: rolling {word} per tenant\n"
     "CREATE OR REPLACE VIEW {name} AS\n"
     "SELECT tenant_id,\n"
     "       date_trunc('day', created_at) AS day,\n"
     "       count(*) FILTER (WHERE status = 'ok') AS ok_count,\n"
     "       avg(duration_ms)                       AS avg_duration_ms\n"
     "FROM {table}\n"
     "WHERE created_at >= now() - interval '{n} days'\n"
     "GROUP BY 1, 2;\n"),
    ("CREATE TABLE {table} (\n"
     "    id         bigserial PRIMARY KEY,\n"
     "    tenant_id  text        NOT NULL,\n"
     "    {word}     integer     NOT NULL DEFAULT {n},\n"
     "    status     text        NOT NULL DEFAULT 'ok',\n"
     "    created_at timestamptz NOT NULL DEFAULT now()\n"
     ");\n"
     "CREATE INDEX {table}_tenant_created_idx ON {table} (tenant_id, created_at DESC);\n"),
    ("-- rule {uid}\n"
     "SELECT t.tenant_id, count(*) AS n\n"
     "FROM {table} t\n"
     "JOIN {table2} u ON u.tenant_id = t.tenant_id\n"
     "WHERE t.{word} >= {n}\n"
     "GROUP BY t.tenant_id\n"
     "HAVING count(*) > {n2}\n"
     "ORDER BY n DESC\n"
     "LIMIT {n3};\n"),
    ("-- backfill for rule {uid}; safe to re-run\n"
     "UPDATE {table}\n"
     "SET {word} = {n}\n"
     "WHERE {word} IS NULL\n"
     "  AND created_at < now() - interval '{n2} days';\n"),
)

_CODE_HELPERS = {
    "python": _PY_HELPERS,
    "typescript": _TS_HELPERS,
    "go": _GO_HELPERS,
    "rust": _RUST_HELPERS,
    "sql": _SQL_HELPERS,
}

CODE_LANGS = tuple(_CODE_HELPERS)

_CODE_WORDS = ("median", "digest", "rollup", "window", "checkpoint", "ledger", "quota", "snapshot")
_SQL_TABLES = ("events", "orders", "sessions", "invoices", "shipments", "audit_log", "webhooks")

#: markdown fence label per language
CODE_FENCE = {"python": "python", "typescript": "typescript", "go": "go", "rust": "rust", "sql": "sql"}


def code_file(rng: random.Random, counter: Counter, target_chars: int, lang: str | None = None) -> tuple[str, str]:
    """Return `(language, source_text)` of a synthetic module of roughly *target_chars*."""
    lang = lang or rng.choice(("python", "typescript", "go"))
    helpers = _CODE_HELPERS[lang]
    bank = TOPICS["code"]
    module = rng.choice(bank.slots["module"])
    header = {
        "python": f'"""{module}: internal helpers, generated module {counter.next()}."""\n\nfrom __future__ import annotations\n\n',
        "typescript": f"// {module}.ts — internal helpers, generated module {counter.next()}\n\n",
        "go": f"package {module.split('_')[0]}\n\nimport (\n\t\"time\"\n)\n\n",
        "rust": f"//! {module}: internal helpers, generated module {counter.next()}.\n\nuse std::collections::{{BTreeMap, HashMap}};\n\n",
        "sql": f"-- {module}.sql — generated migration {counter.next()}\n\n",
    }[lang]
    parts = [header]
    size = len(header)
    deck = Deck(rng, helpers)
    words = Deck(rng, _CODE_WORDS)
    tables = Deck(rng, _SQL_TABLES)
    while size < target_chars:
        uid = counter.next()
        word = words.draw()
        fill = Filler(rng, {"table": _SQL_TABLES}, uid)
        fill["name"] = f"{rng.choice(bank.slots['fn'])}_{uid}"
        fill["cls"] = f"{word.title()}{uid}"
        fill["word"] = word
        fill["word_title"] = word.title()
        fill["table"] = f"{tables.draw()}_{uid}"
        fill["n"] = str(rng.randint(2, 64))
        fill["dec"] = f"{rng.uniform(0.001, 0.2):.3f}"
        fill["uid"] = str(uid)
        block = deck.draw().format_map(fill)
        parts.append(block)
        size += len(block) + 1
    return lang, "\n".join(parts)


# --- transcripts ----------------------------------------------------------------------


def transcript(rng: random.Random, topic: str, counter: Counter, target_chars: int) -> str:
    bank = TOPICS[topic]
    speakers = list(bank.speakers) or ["A", "B", "C"]
    minute = rng.randint(0, 9)
    lines = [f"Transcript {counter.next()} — automatic captions, lightly corrected.", ""]
    size = sum(len(x) for x in lines)
    deck = Deck(rng, bank.sentences)
    while size < target_chars:
        minute += rng.randint(1, 3)
        who = rng.choice(speakers)
        body = " ".join(sentence(rng, topic, counter, deck) for _ in range(rng.randint(1, 3)))
        line = f"[00:{minute:02d}] {who}: {body}"
        lines.append(line)
        size += len(line) + 1
    return "\n".join(lines)


# --- document assembly ----------------------------------------------------------------


def document(rng: random.Random, topic: str, counter: Counter, target_chars: int) -> str:
    """Compose a coherent synthetic document of roughly *target_chars* characters."""
    bank = TOPICS[topic]
    if topic == "code":
        lang, src = code_file(rng, counter, target_chars)
        return f"```{CODE_FENCE[lang]}\n{src}```"
    if bank.transcript and rng.random() < 0.35:
        return transcript(rng, topic, counter, target_chars)

    parts = [f"# {title(rng, topic, counter)}"]
    size = len(parts[0])
    deck = Deck(rng, bank.sentences)
    heads = Deck(rng, bank.sections)
    while size < target_chars:
        head = heads.draw().format_map(Filler(rng, bank.slots, counter.next()))
        chunk = [f"## {head}"]
        for _ in range(rng.randint(2, 4)):
            chunk.append(paragraph(rng, topic, counter, deck=deck))
            if size + sum(len(c) for c in chunk) >= target_chars:
                break
        block = "\n\n".join(chunk)
        parts.append(block)
        size += len(block) + 2
    return "\n\n".join(parts)


_SENT_SPLIT = re.compile(r"(?<=[.!?])\s+")


def trim_to_chars(text: str, max_chars: int) -> str:
    """Trim *text* to at most *max_chars*, cutting at paragraph then sentence boundaries."""
    if len(text) <= max_chars:
        return text
    paras = text.split("\n\n")
    while len(paras) > 1 and len("\n\n".join(paras)) > max_chars:
        paras.pop()
    text = "\n\n".join(paras)
    if len(text) <= max_chars:
        return text
    sents = _SENT_SPLIT.split(text)
    while len(sents) > 1 and len(" ".join(sents)) > max_chars:
        sents.pop()
    text = " ".join(sents)
    return text[:max_chars]


BUCKETS: dict[str, tuple[int, int]] = {
    "xs": (16, 64),
    "s": (65, 256),
    "m": (257, 1024),
    "l": (1025, 4096),
    "xl": (4097, 16384),
    "xxl": (16385, 65536),
}


def bucket_of(tokens: int) -> str | None:
    for name, (lo, hi) in BUCKETS.items():
        if lo <= tokens <= hi:
            return name
    return None
