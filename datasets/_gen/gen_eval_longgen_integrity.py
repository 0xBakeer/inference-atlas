# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Generate `datasets/eval-longgen-integrity-v1/`.

36 long-output code-generation items whose only question is whether the decoded
token stream stays intact over one to two thousand tokens.

Every other eval in this corpus asks a short question and reads a short answer, so
a serving build that corrupts roughly one token in several thousand passes all of
them: the answer is over before the defect has room to appear. The failure this
suite is built for looks like a single spliced identifier or number in an otherwise
correct file — `carrierhed` where the project defines `carrier`, `seedapse` for
`seed`, `128Pin` for `128`, or a bare word standing where a numeric literal belongs
(`[6, visible, 0]`). One such token makes the file unusable, and nothing about the
surrounding prose or logic looks wrong.

Each item is a synthetic JavaScript ES-module project — five to seven files of
exported constants, functions and classes built from seeded vocabulary tables — plus
a task: write one complete new module that imports at least six named exports from
the project and defines a listed set of exports. The model must reply with the file
contents and nothing else, which is what makes the output long, mechanical and
scoreable without a judge.

Scoring is the `integrity` scorer, not a correctness check. It masks strings,
comments and regex literals, builds a definition set from the row's
`meta.context_identifiers` plus everything the output itself declares plus the
JavaScript globals, and reports a splice when an identifier or number could only
have come from two fragments being welded together. An item is correct when the
generation contains no splice, so `accuracy` reads as "share of long generations
that came back intact". A model that writes wrong-but-well-formed code still scores
1.0 here, deliberately: correctness is what the other suites measure.

`meta.context_identifiers` is computed from the generated project, never typed: the
generator records every name it mints and every template-local it emits, then keeps
the ones that actually occur in the finished context.

Run: `uv run datasets/_gen/gen_eval_longgen_integrity.py`
"""

from __future__ import annotations

import posixpath
import random
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import _lib as L  # noqa: E402

SEED = 20260902
DATASET_ID = "eval-longgen-integrity-v1"
CREATED = "2026-09-02"

#: (difficulty, target output tokens, min lines, max lines). The difficulty vocabulary
#: is the corpus-wide closed set (easy/medium/hard); here it orders the items by how
#: much output the task asks for, which is the axis under test.
LENGTHS = (
    ("easy", 1200, 150, 180),
    ("medium", 1800, 200, 230),
    ("hard", 2400, 250, 290),
)

#: Module area of the file the model has to write. Doubles as the row category.
AREAS = ("models", "systems", "ui", "utils")

#: Items per (area, difficulty) cell — 4 x 3 x 3 = 36.
PER_CELL = 3

# --------------------------------------------------------------------------------------
# vocabulary
# --------------------------------------------------------------------------------------

#: Distinctive, multi-syllable stems. Short or generic words would make the splice
#: heuristic ambiguous: a three-letter stem has a prefix in almost everything.
NOUNS = (
    "carrier", "lattice", "terrain", "beacon", "cascade", "harbour", "meridian",
    "spawner", "ripple", "girder", "aurora", "canopy", "thicket", "plateau",
    "cinder", "drifter", "marker", "pylon", "trellis", "column", "furrow",
    "glacier", "hollow", "ledger", "mantle", "nimbus", "quarry", "raster",
    "shoal", "tundra", "vessel", "willow",
)

#: Leading qualifiers, used as `<qualifier><Tail>` (`dirAngle`, `elapsedMs`).
QUALIFIERS = (
    "dir", "elapsed", "ambient", "nominal", "residual", "lateral", "orbital",
    "seeded", "cached", "pending", "active", "latent", "baseline", "adaptive",
    "primary", "idle", "coarse", "settled",
)

#: Trailing nouns, used as `<stem><Tail>` (`latticeSize`, `carrierIndex`).
TAILS = (
    "Size", "Angle", "Count", "Index", "Factor", "Offset", "Scale", "Radius",
    "Budget", "Depth", "Ms", "Ratio", "Limit", "Seed", "Phase", "Span", "Width",
    "Weight", "Step", "Bias", "Group", "Field", "Table", "Window",
)

VERBS = (
    "spawn", "resolve", "integrate", "sample", "project", "blend", "clamp",
    "advance", "register", "compose", "derive", "flush", "rebuild", "normalise",
    "collapse", "gather", "expand", "settle", "reconcile", "trace", "align",
    "fold", "seed", "prune",
)

CLASS_TAILS = (
    "Controller", "Registry", "Buffer", "Field", "Grid", "Pipeline", "Ledger",
    "Cache", "Bundle", "Pool",
)

#: Identifiers the code templates below spell out verbatim. They are recorded as part
#: of the context only when they actually survive into the generated text.
TEMPLATE_LOCALS = (
    "entry", "acc", "value", "step", "left", "right", "state", "deltaMs", "seed",
    "index", "total", "input", "items", "options", "target",
)

WORDS = (
    "coarse", "fine", "linear", "radial", "planar", "stable", "drifting", "banked",
    "queued", "settled", "primed", "idle",
)


class Mint:
    """Seeded, collision-free identifier factory for one project."""

    def __init__(self, rng: random.Random) -> None:
        self.rng = rng
        self.used: set[str] = set()
        self.minted: set[str] = set()

    def _claim(self, name: str) -> str | None:
        if name in self.used:
            return None
        self.used.add(name)
        self.minted.add(name)
        return name

    def _try(self, make) -> str:
        for _ in range(400):
            name = self._claim(make())
            if name:
                return name
        raise RuntimeError("identifier vocabulary exhausted")

    def const(self) -> str:
        def make() -> str:
            if self.rng.random() < 0.5:
                return self.rng.choice(NOUNS) + self.rng.choice(TAILS)
            return self.rng.choice(QUALIFIERS) + self.rng.choice(TAILS)

        return self._try(make)

    def func(self) -> str:
        def make() -> str:
            noun = self.rng.choice(NOUNS)
            base = self.rng.choice(VERBS) + noun[0].upper() + noun[1:]
            if self.rng.random() < 0.4:
                base += self.rng.choice(TAILS)
            return base

        return self._try(make)

    def cls(self) -> str:
        def make() -> str:
            noun = self.rng.choice(NOUNS)
            return noun[0].upper() + noun[1:] + self.rng.choice(CLASS_TAILS)

        return self._try(make)

    def local(self) -> str:
        def make() -> str:
            return self.rng.choice(QUALIFIERS) + self.rng.choice(NOUNS).capitalize()

        return self._try(make)

    def field(self) -> str:
        def make() -> str:
            noun = self.rng.choice(NOUNS)
            return noun + self.rng.choice(TAILS)

        return self._try(make)


# --------------------------------------------------------------------------------------
# code templates
# --------------------------------------------------------------------------------------

FUNCTION_TEMPLATES = (
    """/** {doc} */
export function {fn}({p1}, {p2} = {d2}) {{
  const {l1} = Number.isFinite({p1}) ? {p1} : 0;
  let {l2} = {l1} * {c1};
  for (let step = 0; step < {p2}; step += 1) {{
    {l2} += Math.sin(({l1} + step) * {f1}) * {c2};
  }}
  return {l2} / Math.max(1, {p2});
}}""",
    """/** {doc} */
export function {fn}({p1}) {{
  const {l1} = ({p1} ?? []).map((entry) => Number(entry.{k1}) || 0);
  const {l2} = {l1}.reduce((acc, value) => acc + value, 0);
  return {{
    {k2}: {l2},
    {k3}: {l1}.length,
    {k4}: {l1}.length ? {l2} / {l1}.length : 0,
  }};
}}""",
    """/** {doc} */
export function {fn}({p1}, {p2}, {p3} = {f1}) {{
  const {l1} = Math.max(0, Math.min(1, {p3}));
  const {l2} = {p1} * (1 - {l1}) + {p2} * {l1};
  return Math.round({l2} * {c1}) / {c1};
}}""",
    """/** {doc} */
export function {fn}({p1}) {{
  switch ({p1}) {{
    case '{w1}':
      return {c1};
    case '{w2}':
      return {c2};
    case '{w3}':
      return {c1} + {c2};
    default:
      return {n1};
  }}
}}""",
    """/** {doc} */
export function {fn}({p1}, {p2} = {n1}) {{
  if (!Array.isArray({p1})) {{
    throw new TypeError('{fn} expects an array of records');
  }}
  const {l1} = {p1}.filter((entry) => entry != null && Number(entry.{k1}) > {p2});
  {l1}.sort((left, right) => Number(right.{k1}) - Number(left.{k1}));
  return {l1}.slice(0, {n2});
}}""",
    """/** {doc} */
export function {fn}({p1}, {p2}) {{
  const {l1} = new Map();
  for (const entry of {p1} ?? []) {{
    const {l2} = String(entry?.{k1} ?? '{w1}');
    {l1}.set({l2}, ({l1}.get({l2}) ?? 0) + Number(entry?.{k2} ?? {p2}));
  }}
  return Array.from({l1}, ([{k3}, {k4}]) => ({{ {k3}, {k4} }}));
}}""",
    """/** {doc} */
export function {fn}({p1}, {p2} = {c1}) {{
  const {l1} = {p2} === 0 ? 1 : {p2};
  const {l2} = Math.trunc({p1} / {l1});
  return {{
    {k1}: {l2},
    {k2}: {p1} - {l2} * {l1},
    {k3}: {l1},
  }};
}}""",
)

IMPORTING_FUNCTION_TEMPLATE = """/** {doc} */
export function {fn}({p1}, {p2} = {n1}) {{
  const {l1} = {ref}({p1});
  let {l2} = 0;
  for (let step = 0; step < {p2}; step += 1) {{
    {l2} += typeof {l1} === 'function' ? {l1}() : Number({l1}) || 0;
  }}
  return {l2} / Math.max(1, {p2});
}}"""

CLASS_TEMPLATE = """/** {doc} */
export class {cls} {{
  constructor({p1}, {p2} = {c1}) {{
    this.{f1} = {p1};
    this.{f2} = {p2};
    this.{f3} = [];
  }}

  {m1}({p3}) {{
    this.{f3}.push({p3});
    return this;
  }}

  {m2}() {{
    if (!this.{f3}.length) {{
      return 0;
    }}
    const total = this.{f3}.reduce((acc, value) => acc + Number(value), 0);
    return total / this.{f3}.length;
  }}

  {m3}({p4} = 0) {{
    return this.{f3}.filter((entry) => Number(entry) >= {p4});
  }}

  {m4}() {{
    return {{ {f1}: this.{f1}, {f2}: this.{f2}, {f3}: this.{f3}.length }};
  }}
}}"""

#: `src/utils/rng.js` is the same shape in every project: the seeded generator is what
#: makes the synthetic project hang together, and `mulberry32` is a name a model will
#: reach for.
RNG_MODULE = """// src/utils/rng.js
// Deterministic pseudo-random source shared by every system in the project.

export const {default_seed} = {seed_value};

export function mulberry32(seed) {{
  let t = (seed >>> 0) + 0x6d2b79f5;
  return function next() {{
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }};
}}

export function {pick}(source, list) {{
  if (!Array.isArray(list) || list.length === 0) {{
    return undefined;
  }}
  return list[Math.floor(source() * list.length) % list.length];
}}

export function {between}(source, low, high) {{
  return low + source() * (high - low);
}}

export function {stream}(seed = {default_seed}, count = 8) {{
  const source = mulberry32(seed);
  const values = [];
  for (let index = 0; index < count; index += 1) {{
    values.push(source());
  }}
  return values;
}}
"""

MODULE_POOL = (
    ("src/utils/geometry.js", "utils", "planar geometry helpers"),
    ("src/models/terrain.js", "models", "terrain sampling and height fields"),
    ("src/models/fleet.js", "models", "fleet composition and carrier grouping"),
    ("src/systems/physics.js", "systems", "integration of motion and drag"),
    ("src/systems/spawner.js", "systems", "spawn scheduling and budgets"),
    ("src/ui/hud.js", "ui", "heads-up display formatting"),
    ("src/ui/overlay.js", "ui", "overlay layout and hit testing"),
)

DOCS = (
    "Reduce {a} to the scalar the {b} stage expects.",
    "Fold the supplied records into the running {a} total.",
    "Blend two {a} readings; the third argument is the blend weight.",
    "Resolve the {a} preset named by the caller.",
    "Rank the supplied records by {a} and keep the strongest few.",
    "Group the supplied records by {a} and total their {b}.",
    "Split {a} into whole steps plus the remainder that did not fit.",
    "Accumulate {a} over a fixed number of steps.",
    "Track {a} for one subsystem and summarise it on demand.",
)

BEHAVIOURS = (
    "combine `{a}` and `{b}` into one normalised value between 0 and 1",
    "advance a state object by `deltaMs`, using `{a}` as the per-step budget, and return the new state",
    "return a plain object summarising `{a}`, `{b}` and the number of records processed",
    "return a sorted copy of the supplied list, ranked by `{a}` descending and capped at `{b}` entries",
    "wrap `{a}` so that repeated calls stay deterministic for a given seed",
    "throw a `RangeError` when `{a}` falls outside the range implied by `{b}`, and otherwise return it unchanged",
    "map a list of records onto the shape `{a}` expects, dropping entries with no usable value",
    "compute the running mean of `{a}` and expose it alongside the sample count",
    "format `{a}` and `{b}` into a single display string for the overlay",
)


def _cap(name: str) -> str:
    return name[0].upper() + name[1:]


def _number(rng: random.Random) -> str:
    return str(rng.choice((2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64, 96, 128, 180, 256, 360)))


def _float(rng: random.Random) -> str:
    return f"{rng.uniform(0.05, 3.5):.3f}"


def _const_value(rng: random.Random, mint: Mint) -> tuple[str, bool]:
    """A constant initialiser, plus whether it is a plain number.

    Only the numeric ones are handed to the templates as arithmetic operands, so the
    generated project reads as code somebody could have written rather than as
    something that multiplies by a string.
    """
    roll = rng.random()
    if roll < 0.35:
        return _number(rng), True
    if roll < 0.65:
        return _float(rng), True
    if roll < 0.78:
        return f"'{rng.choice(WORDS)}'", False
    if roll < 0.9:
        return f"[{_number(rng)}, {_number(rng)}, {_number(rng)}]", False
    return (
        f"Object.freeze({{ {mint.field()}: {_number(rng)}, "
        f"{mint.field()}: {_float(rng)} }})",
        False,
    )


def _render_function(rng: random.Random, mint: Mint, numbers: list[str], doc: str) -> str:
    template = rng.choice(FUNCTION_TEMPLATES)
    fields = {
        "doc": doc,
        "fn": mint.func(),
        "p1": mint.local(),
        "p2": mint.local(),
        "p3": mint.local(),
        "l1": mint.local(),
        "l2": mint.local(),
        "k1": mint.field(),
        "k2": mint.field(),
        "k3": mint.field(),
        "k4": mint.field(),
        "c1": rng.choice(numbers),
        "c2": rng.choice(numbers),
        "d2": _number(rng),
        "f1": _float(rng),
        "n1": _number(rng),
        "n2": _number(rng),
        "w1": rng.choice(WORDS),
        "w2": rng.choice(WORDS),
        "w3": rng.choice(WORDS),
    }
    return template.format(**fields)


def _render_importing_function(
    rng: random.Random, mint: Mint, reference: str, doc: str
) -> str:
    return IMPORTING_FUNCTION_TEMPLATE.format(
        doc=doc,
        fn=mint.func(),
        p1=mint.local(),
        p2=mint.local(),
        l1=mint.local(),
        l2=mint.local(),
        ref=reference,
        n1=_number(rng),
    )


def _render_class(rng: random.Random, mint: Mint, numbers: list[str], doc: str) -> str:
    return CLASS_TEMPLATE.format(
        doc=doc,
        cls=mint.cls(),
        p1=mint.local(),
        p2=mint.local(),
        p3=mint.local(),
        p4=mint.local(),
        f1=mint.field(),
        f2=mint.field(),
        f3=mint.field(),
        m1=mint.func(),
        m2=mint.func(),
        m3=mint.func(),
        m4=mint.func(),
        c1=rng.choice(numbers),
    )


def _relative(from_path: str, to_path: str) -> str:
    relative = posixpath.relpath(to_path, posixpath.dirname(from_path))
    return relative if relative.startswith(".") else f"./{relative}"


def _doc(rng: random.Random, names: list[str]) -> str:
    return rng.choice(DOCS).format(a=rng.choice(names), b=rng.choice(names))


def _build_rng_module(rng: random.Random, mint: Mint) -> tuple[str, list[str]]:
    """The shared seeded-random module, identical in shape across every project."""
    default_seed = mint.const()
    pick, between, stream = mint.func(), mint.func(), mint.func()
    mint.used.add("mulberry32")
    mint.minted.add("mulberry32")
    text = RNG_MODULE.format(
        default_seed=default_seed,
        seed_value=str(rng.randint(100_000, 999_999)),
        pick=pick,
        between=between,
        stream=stream,
    )
    return text, [default_seed, "mulberry32", pick, between, stream]


def _build_module(
    rng: random.Random,
    mint: Mint,
    path: str,
    role: str,
    imports: list[tuple[str, list[str]]],
    target_chars: int,
) -> tuple[str, list[str]]:
    """One synthetic module. Returns its source and the names it exports."""
    lines = [f"// {path}", f"// {_cap(role)}."]
    exported: list[str] = []

    imported_names: list[str] = []
    for source_path, names in imports:
        chosen = names[: min(len(names), rng.randint(1, 3))]
        if not chosen:
            continue
        imported_names.extend(chosen)
        lines.append(
            f"import {{ {', '.join(chosen)} }} from '{_relative(path, source_path)}';"
        )
    if imported_names:
        lines.append("")

    consts: list[str] = []
    numbers: list[str] = []
    for _ in range(rng.randint(3, 5)):
        name = mint.const()
        value, numeric = _const_value(rng, mint)
        lines.append(f"export const {name} = {value};")
        consts.append(name)
        exported.append(name)
        if numeric:
            numbers.append(name)
    if not numbers:
        name = mint.const()
        lines.append(f"export const {name} = {_number(rng)};")
        consts.append(name)
        exported.append(name)
        numbers.append(name)
    lines.append("")

    pool = list(consts)
    used_class = False
    while sum(len(line) + 1 for line in lines) < target_chars:
        doc = _doc(rng, pool)
        if not used_class and rng.random() < 0.3:
            block = _render_class(rng, mint, numbers, doc)
            used_class = True
        elif imported_names and rng.random() < 0.35:
            block = _render_importing_function(
                rng, mint, rng.choice(imported_names), doc
            )
        else:
            block = _render_function(rng, mint, numbers, doc)
        lines.append(block)
        lines.append("")
        match = re.search(r"export (?:function|class) ([A-Za-z_$][\w$]*)", block)
        if match:
            exported.append(match.group(1))
            pool.append(match.group(1))

    return "\n".join(lines).rstrip() + "\n", exported


def _build_project(rng: random.Random, mint: Mint, file_count: int, per_file: int):
    """Five to seven modules, each importing from the ones already written."""
    extras = rng.sample(MODULE_POOL, file_count - 2)
    extras.sort(key=lambda spec: MODULE_POOL.index(spec))

    modules: list[tuple[str, str]] = []
    exports: list[tuple[str, list[str]]] = []

    text, names = _build_rng_module(rng, mint)
    modules.append(("src/utils/rng.js", text))
    exports.append(("src/utils/rng.js", names))

    for path, _area, role in extras:
        sources = rng.sample(exports, min(len(exports), rng.randint(1, 2)))
        sources.sort(key=lambda item: [p for p, _ in exports].index(item[0]))
        text, names = _build_module(rng, mint, path, role, sources, per_file)
        modules.append((path, text))
        exports.append((path, names))

    sources = rng.sample(exports, min(len(exports), 3))
    sources.sort(key=lambda item: [p for p, _ in exports].index(item[0]))
    text, names = _build_module(
        rng, mint, "src/main.js", "application entry point and wiring", sources, per_file
    )
    modules.append(("src/main.js", text))
    exports.append(("src/main.js", names))

    return modules, exports


PROMPT_HEAD = (
    "You are extending an existing JavaScript project. It is plain ES modules — no "
    "framework, no bundler, no third-party packages. The complete current source "
    "follows.\n"
)

PROMPT_TASK = """
=== TASK ===

Write ONE new module, `{path}`, of roughly {min_lines} to {max_lines} lines.

It must import and use at least 6 named exports from the modules above. Use import
paths relative to the new file exactly as they would resolve in the tree above.

It must define and export exactly these, and nothing else:

{exports}

Rules:

- Plain ES module syntax. No third-party packages, no TypeScript, no build step.
- Every identifier you use must be one you import from the project above, one you
  declare in this file, or a standard JavaScript global.
- Write real implementations. No `TODO`, no stubs, no `throw new Error('not
  implemented')`.
- Reply with the contents of the file and nothing else: no markdown fences, no
  commentary before or after, no explanation.
"""


def _required_exports(rng: random.Random, mint: Mint, pool: list[str], count: int):
    """`count` export lines, each a minted name plus a behaviour drawn from the vocab."""
    lines: list[str] = []
    names: list[str] = []
    for _ in range(count):
        name = mint.func()
        names.append(name)
        behaviour = rng.choice(BEHAVIOURS).format(a=rng.choice(pool), b=rng.choice(pool))
        signature = rng.choice(
            ("(input)", "(input, options)", "(state, deltaMs)", "(items, target)")
        )
        lines.append(f"- `{name}{signature}` — {behaviour}.")
    return lines, names


def build_item(index: int, area: str, difficulty: str, target_tokens: int,
               min_lines: int, max_lines: int) -> dict:
    rng = random.Random(SEED + index * 7919)
    mint = Mint(rng)

    file_count = rng.randint(5, 7)
    # The context is budgeted as a whole (20-24k characters) and split over the files,
    # so a five-file project and a seven-file project are the same size of read.
    per_file = (rng.randint(19_500, 22_500) - len(RNG_MODULE)) // (file_count - 1)
    modules, exports = _build_project(rng, mint, file_count, per_file)

    context = PROMPT_HEAD + "".join(
        f"\n=== {path} ===\n\n{text}" for path, text in modules
    )

    module_name = mint.func()
    module_path = f"src/{area}/{module_name}.js"
    export_pool = sorted({name for _, names in exports for name in names})
    export_lines, export_names = _required_exports(
        rng, mint, export_pool, rng.randint(3, 6)
    )

    prompt = context + PROMPT_TASK.format(
        path=module_path,
        min_lines=min_lines,
        max_lines=max_lines,
        exports="\n".join(export_lines),
    )

    # Computed from the finished text, never typed: every name the generator minted
    # (plus the template locals the templates spell out) that actually occurs in the
    # project source. This is the definition set the scorer starts from.
    candidates = mint.minted | set(TEMPLATE_LOCALS)
    identifiers = sorted(
        name for name in candidates if re.search(rf"\b{re.escape(name)}\b", context)
    )

    return {
        "id": f"lgi-{index + 1:04d}",
        "category": area,
        "difficulty": difficulty,
        "prompt": prompt,
        "answer": "clean",
        "scorer": "integrity",
        "meta": {
            "language": "javascript",
            "module_path": module_path,
            "area": area,
            "target_output_tokens": target_tokens,
            "min_lines": min_lines,
            "max_lines": max_lines,
            "required_exports": export_names,
            "context_files": [path for path, _ in modules],
            "context_chars": len(context),
            "approx_prompt_tokens": L.approx_tokens_from_chars(len(prompt)),
            "context_identifiers": identifiers,
        },
    }


def main() -> None:
    rows: list[dict] = []
    index = 0
    for area in AREAS:
        for difficulty, target_tokens, min_lines, max_lines in LENGTHS:
            for _ in range(PER_CELL):
                rows.append(
                    build_item(index, area, difficulty, target_tokens, min_lines, max_lines)
                )
                index += 1

    assert len(rows) == len(AREAS) * len(LENGTHS) * PER_CELL == 36, len(rows)
    for row in rows:
        chars = len(row["prompt"])
        assert 18_000 <= chars <= 28_000, f"{row['id']} prompt is {chars} chars"
        assert len(row["meta"]["context_identifiers"]) >= 60, row["id"]

    by_target: dict[str, int] = {}
    for row in rows:
        key = str(row["meta"]["target_output_tokens"])
        by_target[key] = by_target.get(key, 0) + 1

    d = L.dataset_dir(DATASET_ID)
    n = L.write_jsonl(d / "items.jsonl", rows)
    L.write_json(
        d / "dataset.json",
        L.eval_dataset_json(
            DATASET_ID,
            "Long-generation token integrity v1",
            "36 long-output code-generation items over synthetic JavaScript ES-module "
            "projects of 20-25k characters. Each asks for one complete new module of 150 "
            "to 290 lines that imports at least six named exports from the project. The "
            "item is correct when the generation contains no spliced token — an identifier "
            "or number welded together from two fragments, which is what a decode-path "
            "defect looks like in a long output. Correctness of the code is deliberately "
            "not scored; the other eval suites measure that.",
            rows,
            "gen_eval_longgen_integrity.py",
            "integrity",
            seed=SEED,
            created=CREATED,
            counts_by_target_output_tokens=by_target,
            notes=[
                "This suite exists because every other eval here has short answers. A "
                "serving build that corrupts roughly one token in several thousand passes "
                "all of them, because the answer ends before the defect has room to "
                "appear. Only a long, mechanical, checkable output exposes it.",
                "accuracy = share of generations with no spliced token. A model that "
                "writes wrong but well-formed code still scores 1.0 here; a model that "
                "writes perfect code with one `carrierhed` in it scores 0 for that item.",
                "meta.context_identifiers is the definition set the scorer starts from: "
                "every identifier the generated project defines or exports, computed from "
                "the generated source. The scorer adds everything the model's own output "
                "declares plus the JavaScript globals before deciding an identifier is "
                "undefined.",
                "An undefined identifier is NOT by itself a failure. Models invent helper "
                "names and forget to declare them, and that is an ordinary code error, not "
                "a decode defect. Only the three splice shapes count: a numeric literal "
                "with a word glued on, an identifier that is a known name plus 2-6 "
                "lowercase letters, and a bare word standing where a number belongs "
                "between two numeric literals.",
                "difficulty orders the items by requested output length: easy ~1200 "
                "tokens, medium ~1800, hard ~2400, recorded exactly in "
                "meta.target_output_tokens and expressed to the model as a line range.",
                "The generic answer-extraction step that keeps the last `Answer:` line is "
                "NOT applied to these rows. The output is a source file; a line inside it "
                "that begins `answer:` is code, and truncating to it would destroy the "
                "generation the scorer exists to inspect. <think> blocks and a surrounding "
                "code fence are still stripped.",
                "A clean run proves less than it looks. At an observed rate of roughly one "
                "affected generation in five, 36 clean items is a plausible outcome for an "
                "affected build; report the run, do not conclude the defect is absent.",
            ],
        ),
    )
    L.report(DATASET_ID, n)


if __name__ == "__main__":
    main()
