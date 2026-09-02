"""`eval-longgen-integrity-v1` and the `integrity` scorer.

Two halves. The dataset half checks the generator is deterministic and that the rows carry
what the scorer needs — a definition set that really comes from the prompt, and prompts of
the size the workload assumes. The scorer half is the part that decides published accuracy
numbers, so it is pinned in both directions: the real splices observed on a defective
serving build must be flagged, and the JavaScript that trips a naive implementation —
hex and exponent literals, template substitutions, comments, property access — must not be.
"""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest

from atlas_bench.data import EvalRow
from atlas_bench.scorers import get_scorer, normalize_scorer_name
from atlas_bench.scorers.integrity import declared_identifiers, mask_literals, score_integrity

REPO = Path(__file__).resolve().parents[2]
DATASETS = REPO / "datasets"
DATASET_ID = "eval-longgen-integrity-v1"
GENERATOR = DATASETS / "_gen" / "gen_eval_longgen_integrity.py"

pytestmark = pytest.mark.skipif(
    not (DATASETS / DATASET_ID).is_dir(), reason="datasets/ is not in this checkout"
)

#: The names the synthetic project defines, for the scorer fixtures below.
CONTEXT = ["group", "seed", "carrier", "roll", "dirAngle", "scene", "mulberry32"]


def _rows() -> list[dict]:
    path = DATASETS / DATASET_ID / "items.jsonl"
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line]


def _row(code_context: list[str] | None = CONTEXT) -> EvalRow:
    meta = {} if code_context is None else {"context_identifiers": list(code_context)}
    return EvalRow(
        id="lgi-test",
        messages=[{"role": "user", "content": "write a module"}],
        answer="clean",
        scorer="integrity",
        meta=meta,
    )


def _score(code: str, row: EvalRow | None = None):
    return score_integrity(code, row if row is not None else _row())


# ------------------------------------------------------------------------------ generator


def _run_generator(destination: Path) -> None:
    """Run the generator with its output redirected into *destination*."""
    spec = importlib.util.spec_from_file_location("gen_longgen_integrity", GENERATOR)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.L.DATASETS_DIR = destination
    module.main()


def test_generator_is_deterministic(tmp_path: Path, capsys: pytest.CaptureFixture) -> None:
    """Two runs produce byte-identical files, and they match what is committed."""
    first, second = tmp_path / "one", tmp_path / "two"
    _run_generator(first)
    _run_generator(second)
    capsys.readouterr()

    committed = DATASETS / DATASET_ID
    for name in ("items.jsonl", "dataset.json"):
        left = (first / DATASET_ID / name).read_bytes()
        right = (second / DATASET_ID / name).read_bytes()
        assert left == right, f"{name} differs between two runs of the generator"
        assert left == (committed / name).read_bytes(), (
            f"{name} in the checkout is not what the generator produces; re-run "
            f"uv run datasets/_gen/gen_eval_longgen_integrity.py"
        )


def test_dataset_shape() -> None:
    """36 items, four categories, the three length tiers, all scored ``integrity``."""
    rows = _rows()
    meta = json.loads((DATASETS / DATASET_ID / "dataset.json").read_text(encoding="utf-8"))
    assert len(rows) == 36 == meta["count"]
    assert meta["default_scorer"] == "integrity"
    assert {row["scorer"] for row in rows} == {"integrity"}
    assert {row["answer"] for row in rows} == {"clean"}
    assert {row["category"] for row in rows} == {"models", "systems", "ui", "utils"}
    assert {row["meta"]["target_output_tokens"] for row in rows} == {1200, 1800, 2400}
    assert normalize_scorer_name("integrity") in {"integrity"}
    assert get_scorer("integrity") is score_integrity
    assert get_scorer("token-integrity") is score_integrity


def test_prompts_are_the_size_the_workload_assumes() -> None:
    """A short prompt would mean a short generation, which measures nothing here."""
    for row in _rows():
        chars = len(row["prompt"])
        assert 18_000 <= chars <= 28_000, f"{row['id']} prompt is {chars} chars"


def test_context_identifiers_all_occur_in_their_prompt() -> None:
    """The definition set is computed from the generated project, not typed."""
    for row in _rows():
        prompt = row["prompt"]
        identifiers = row["meta"]["context_identifiers"]
        assert identifiers == sorted(identifiers)
        assert len(identifiers) >= 60
        missing = [name for name in identifiers if name not in prompt]
        assert not missing, f"{row['id']} claims identifiers its prompt never defines: {missing}"


def test_required_exports_appear_in_the_prompt() -> None:
    """The model is told exactly what to define, and the row records the same names."""
    for row in _rows():
        exports = row["meta"]["required_exports"]
        assert 3 <= len(exports) <= 6
        for name in exports:
            assert f"`{name}(" in row["prompt"], f"{row['id']} never asks for {name}"
        assert row["meta"]["module_path"] in row["prompt"]


# --------------------------------------------------------------------------------- scorer

#: The shapes actually observed on the serving build that motivated this suite.
SPLICED = (
    ("identifier", "const shape = 1;\nscene.add(groupipse);", "groupipse"),
    ("identifier", "const source = mulberry32(seedapse);", "seedapse"),
    ("numeric", "const n = 128Pin;", "128Pin"),
    ("word-for-number", "const v = [6, visible, 0];", "visible"),
    ("identifier", "group.add(carrierhed);", "carrierhed"),
    ("identifier", "const value = rollorton(1);", "rollorton"),
    ("identifier", "const angle = dirAngleorton * 2;", "dirAngleorton"),
    ("word-for-number", "const out = compose(1, visible, 2);", "visible"),
)


@pytest.mark.parametrize(("kind", "code", "token"), SPLICED, ids=[c[2] for c in SPLICED])
def test_real_splices_are_flagged(kind: str, code: str, token: str) -> None:
    """Every splice shape this suite exists for is caught, and named in ``predicted``."""
    result = _score(code)
    assert not result.correct, f"{token} was not flagged"
    assert token in result.predicted
    assert result.expected == "clean"
    assert "splice_count=" in (result.detail or "")


CLEAN = """import { group, seed, carrier } from '../models/fleet.js';

const arr = [1, 2, 3, 4];
const label = '128px';
const w = 12;
const sized = `${w}px`;
// carrierhed groupipse 128Pin seedapse are only mentioned in this comment
/* rollorton 42Foo dirAngleorton */
const flags = 0x1F | 0b101 | 0o7;
const tiny = 1e-5 + 2.5e3 + 0.5;
const huge = 10n;
const pattern = /128Pin[a-z]+/g;

export function summarise({ carrierGroup, latticeSize = 4 }, holder) {
  let total = 0;
  for (let i = 0; i < 10; i++) {
    total += arr[3] + carrierGroup + latticeSize;
  }
  const spawnBudget = seed + carrier + group;
  try {
    total /= arr.length;
  } catch (problem) {
    total = problem ? 0 : 1;
  }
  return {
    total,
    spawnBudget,
    label,
    sized,
    flags,
    tiny,
    huge,
    matched: pattern.test(label),
    tail: holder.carrierhed,
  };
}
"""


def test_clean_code_is_not_flagged() -> None:
    """Everything that trips a naive implementation, in one file, scoring clean."""
    result = _score(CLEAN)
    assert result.correct, f"clean code was flagged: {result.predicted}"
    assert result.predicted == "clean"


@pytest.mark.parametrize(
    "code",
    [
        "const a = 0x1F;",
        "const b = 0b1010_1010;",
        "const c = 0o755;",
        "const d = 1e-5;",
        "const e = 2.5e3;",
        "const f = 10n;",
        "const g = 1_000_000;",
        "const h = (1.5).toFixed(2);",
        "const i = 1.5.toFixed(2);",
        "for (let index = 0; index < 10; index += 1) { total += index; }",
        "const arr = [1, 2, 3];\nconst third = arr[3];",
        "const cssWidth = '128px';",
        "const w = 4;\nconst styled = `${w}px`;",
        "// 128Pin carrierhed\nconst plain = 1;",
        "/* seedapse groupipse */\nconst plain = 2;",
        "const holder = {};\nconst tail = holder.carrierhed;",
        "const pick = ({ carrierGroup, dirAngleValue }) => carrierGroup + dirAngleValue;",
        "const halve = (total, count) => total / count;",
    ],
)
def test_valid_javascript_is_never_flagged(code: str) -> None:
    """Literals, comments, strings, property access and destructuring all score clean."""
    result = _score(code)
    assert result.correct, f"{code!r} was flagged: {result.predicted}"


def test_a_splice_inside_a_template_substitution_is_still_a_splice() -> None:
    """The literal part of a template is data; the ``${…}`` part is code."""
    assert not _score("const text = `value ${carrierhed} px`;").correct
    assert _score("const text = `carrierhed 128Pin`;").correct


def test_ordinary_undefined_identifiers_are_not_splices() -> None:
    """A model that forgets to declare a helper has written a bug, not a corrupt token."""
    assert _score("const total = someHelperNobodyDefined(4);").correct
    assert _score("const total = carriers + carrierList;").correct


def test_the_scorer_never_raises_and_never_needs_a_definition_set() -> None:
    """No row metadata, unbalanced syntax, an empty answer: scored, never crashed."""
    assert _score("", _row()).correct is False
    assert _score("<think>still thinking", _row()).correct is False
    for junk in ("function (", "`unterminated", "/* never closed", "'", "){}[]"):
        assert _score(junk).correct in (True, False)

    bare = EvalRow(
        id="bare",
        messages=[{"role": "user", "content": "project defines carrier and group"}],
        answer="clean",
        scorer="integrity",
    )
    # Without meta.context_identifiers the prompt supplies the definition set.
    assert not score_integrity("const x = carrierhed;", bare).correct
    assert score_integrity("const x = carrier + group;", bare).correct


def test_fenced_and_thinking_output_is_unwrapped() -> None:
    """A model that fences its file or thinks out loud is still scored on the file."""
    fenced = "```javascript\nconst n = 128Pin;\n```"
    assert not _score(fenced).correct
    assert not _score("<think>planning</think>\nconst n = 128Pin;").correct


def test_predicted_is_capped_for_the_result_file() -> None:
    """``scores.items[].predicted`` is 500 characters in the schema; the list fits it."""
    code = "\n".join(f"const v{n} = carrierhed{'' if n % 2 else 'x'} + {n};" for n in range(80))
    result = _score(code)
    assert not result.correct
    assert len(result.predicted) <= 500
    assert "more)" in result.predicted


# ------------------------------------------------------------------------------- internals


def test_mask_literals_keeps_length_and_lines() -> None:
    """Masking is positional: the same length, the same line breaks, no code removed."""
    source = "const a = 'text';\n// note\nconst b = `x${y}z`;\n"
    masked = mask_literals(source)
    assert len(masked) == len(source)
    assert masked.count("\n") == source.count("\n")
    assert "text" not in masked and "note" not in masked
    assert "const a" in masked and "y" in masked
    assert mask_literals(masked) == masked, "masking must be idempotent"


def test_declared_identifiers_covers_the_binding_forms() -> None:
    """Imports, declarations, destructuring, parameters, catch, methods and properties."""
    source = """
import { alpha, beta as gamma } from './x.js';
import defaultExport, * as namespace from './y.js';
const { delta, epsilon: zeta } = source;
let [eta, theta] = pair;
var iota = 1, kappa = 2;
function lambda(mu, nu = 3) { return mu + nu; }
class Xi { omicron(pi) { return pi; } }
const rho = (sigma) => sigma;
for (const tau of list) { total += tau; }
try { risky(); } catch (upsilon) { report(upsilon); }
const phi = { chi: 1 };
"""
    names = declared_identifiers(source)
    for name in (
        "alpha", "gamma", "defaultExport", "namespace", "delta", "zeta", "eta", "theta",
        "iota", "kappa", "lambda", "mu", "nu", "Xi", "omicron", "pi", "rho", "sigma",
        "tau", "upsilon", "phi", "chi",
    ):
        assert name in names, f"{name} was not recognised as declared"


# ------------------------------------------------------------------- corpus-wide behaviour


def _context_modules(row: dict) -> list[str]:
    """The generated project's source files, as they appear in the row's prompt."""
    import re

    body = row["prompt"].split("=== TASK ===")[0]
    return re.split(r"=== src/[^\n]+ ===\n", body)[1:]


def test_no_false_positives_on_the_generated_projects() -> None:
    """Every module the generator wrote scores clean.

    This is the guard that matters most. The context is real, valid JavaScript in exactly
    the style the model is asked to produce, so anything the scorer flags here is a false
    accusation it would also make against an intact generation — and a false accusation
    lands in a published result file as evidence of a defect that is not there.
    """
    flagged: list[str] = []
    total = 0
    for row in _rows():
        item = EvalRow(
            id=row["id"],
            messages=[{"role": "user", "content": row["prompt"]}],
            answer="clean",
            scorer="integrity",
            meta=row["meta"],
        )
        for module in _context_modules(row):
            total += 1
            result = score_integrity(module, item)
            if not result.correct:
                flagged.append(f"{row['id']}: {result.predicted[:120]}")
    assert total > 150, "the projects should have five to seven modules each"
    assert not flagged, f"clean generated code was flagged: {flagged[:5]}"


def test_a_splice_injected_into_real_generated_code_is_caught() -> None:
    """The other direction: corrupt one use site per project and it must be found."""
    import random
    import re

    rng = random.Random(7)
    missed: list[str] = []
    checked = 0
    for row in _rows():
        item = EvalRow(
            id=row["id"],
            messages=[{"role": "user", "content": row["prompt"]}],
            answer="clean",
            scorer="integrity",
            meta=row["meta"],
        )
        # A splice inside a comment is unscoreable by design, so comments come out first.
        module = re.sub(r"/\*.*?\*/", "", _context_modules(row)[1], flags=re.S)
        candidates = []
        for name in row["meta"]["context_identifiers"]:
            if len(name) < 5:
                continue
            hits = [
                match
                for match in re.finditer(rf"\b{re.escape(name)}\b", module)
                if not module[: match.start()]
                .rstrip()
                .endswith((".", "function", "class", "const", "let", "var"))
            ]
            if len(hits) >= 2:
                candidates.append((name, hits[-1]))
        if not candidates:
            continue
        name, hit = rng.choice(candidates)
        tail = rng.choice(["hed", "ipse", "apse", "orton"])
        spliced = module[: hit.end()] + tail + module[hit.end() :]
        checked += 1
        if score_integrity(spliced, item).correct:
            missed.append(f"{row['id']}: {name}{tail}")
    assert checked >= 30
    # Not 100 %: a use site that also reads as a binding (a parameter default, say) is
    # deliberately absorbed into the definition set, because the alternative is accusing
    # real code. One or two misses in a corpus of 36 is the trade that buys zero false
    # positives above.
    assert len(missed) <= 2, f"too many injected splices went unnoticed: {missed}"
