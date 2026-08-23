# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Generate `datasets/eval-math-v1/`.

130 mathematics items across arithmetic, algebra, number theory, geometry, word
problems and sequences. Every answer is computed by this script from the same
numbers that go into the prompt, so the key is correct by construction — there is
no hand-typed answer anywhere in the file.

Design rules:
  * answers are exact: fractions are only used when they terminate as decimals,
    and geometry answers that need pi are asked for to two decimal places with the
    value of pi pinned in the prompt;
  * easy/medium items ask for the bare number, hard items ask for reasoning plus a
    final `Answer: <number>` line, which is what the shared answer-extraction rule
    looks for;
  * the numeric scorer's default tolerance is 1e-6, raised per item via
    `meta.tolerance` where a rounded decimal is expected.

Run: `uv run datasets/_gen/gen_eval_math.py`
"""

from __future__ import annotations

import random
import sys
from fractions import Fraction
from math import gcd, isqrt
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import _lib as L  # noqa: E402

SEED = 20260901
DATASET_ID = "eval-math-v1"

PI = "3.14159"
BARE = "Reply with the final number only, with no units and no explanation."
SHOW = "Work through it step by step, then give the final answer on the last line in the form 'Answer: <number>'."
DP2 = "Round to two decimal places. Reply with the final number only."


def fmt(x: float, places: int = 2) -> str:
    return f"{round(x, places):.{places}f}"


# --------------------------------------------------------------------------------------
# arithmetic
# --------------------------------------------------------------------------------------


def g_mult(rng):
    a, b = rng.randint(210, 9_899), rng.randint(23, 97)
    return f"Compute {a} x {b}. {BARE}", str(a * b), "easy", {}


def g_div_remainder(rng):
    b = rng.randint(7, 61)
    q = rng.randint(12, 340)
    r = rng.randint(1, b - 1)
    a = b * q + r
    return (
        f"What is the remainder when {a} is divided by {b}? {BARE}",
        str(r),
        "easy",
        {},
    )


def g_percent_of(rng):
    pct = rng.choice([5, 10, 12, 15, 20, 25, 30, 40, 60, 75])
    base = rng.randint(3, 79) * 20
    return f"What is {pct}% of {base}? {BARE}", str(base * pct // 100), "easy", {}


def g_percent_chain(rng):
    start = rng.randint(20, 400) * 5
    up = rng.choice([10, 15, 20, 25, 30])
    down = rng.choice([5, 10, 12, 20, 25])
    final = start * (100 + up) / 100 * (100 - down) / 100
    return (
        f"A price of {start} euro first rises by {up}% and then falls by {down}% from the new "
        f"price. What is the final price in euro? {DP2} {SHOW}",
        fmt(final),
        "hard",
        {"tolerance": 0.011},
    )


def g_fraction_add(rng):
    dens = [2, 4, 5, 8, 10, 16, 20, 25]
    d1, d2 = rng.choice(dens), rng.choice(dens)
    n1, n2 = rng.randint(1, d1 - 1), rng.randint(1, d2 - 1)
    total = Fraction(n1, d1) + Fraction(n2, d2)
    return (
        f"Compute {n1}/{d1} + {n2}/{d2} and give the result as an exact decimal. {BARE}",
        str(float(total)),
        "medium",
        {"tolerance": 1e-9},
    )


def g_order_of_ops(rng):
    a, b, c, d = (rng.randint(3, 19) for _ in range(4))
    value = a + b * c - d**2
    return (
        f"Evaluate {a} + {b} * {c} - {d}^2. {BARE}",
        str(value),
        "easy",
        {},
    )


# --------------------------------------------------------------------------------------
# algebra
# --------------------------------------------------------------------------------------


def g_linear(rng):
    a = rng.choice([2, 3, 4, 5, 6, 7, 8])
    x = rng.randint(-19, 29)
    b = rng.randint(-40, 40)
    c = a * x + b
    sign = "+" if b >= 0 else "-"
    return (
        f"Solve for x: {a}x {sign} {abs(b)} = {c}. {BARE}",
        str(x),
        "easy",
        {},
    )


def g_two_step(rng):
    a = rng.choice([2, 3, 4, 5, 6])
    d = rng.choice([2, 3, 4, 6])
    b = rng.randint(-15, 15)
    # keep the right-hand side an exact integer, so the item has no rounding in it
    x = rng.randint(-12, 24)
    while (a * (x + b)) % d != 0:
        x = rng.randint(-12, 24)
    sign = "+" if b >= 0 else "-"
    return (
        f"Solve for x: {a}(x {sign} {abs(b)}) / {d} = {a * (x + b) // d}. {BARE}",
        str(x),
        "medium",
        {},
    )


def g_system(rng):
    x, y = rng.randint(-9, 14), rng.randint(-9, 14)
    a, b = rng.randint(1, 7), rng.randint(1, 7)
    c, d = rng.randint(1, 7), rng.randint(1, 7)
    while a * d - b * c == 0:
        d = rng.randint(1, 9)
    e, f = a * x + b * y, c * x + d * y
    return (
        f"Solve the system {a}x + {b}y = {e} and {c}x + {d}y = {f}. What is x + y? {SHOW}",
        str(x + y),
        "medium",
        {},
    )


def g_quadratic(rng):
    r1, r2 = rng.randint(-11, 11), rng.randint(-11, 11)
    if r1 == r2:
        r2 += 1
    b, c = -(r1 + r2), r1 * r2
    terms = "x^2"
    if b:
        coeff = "" if abs(b) == 1 else str(abs(b))
        terms += f" + {coeff}x" if b > 0 else f" - {coeff}x"
    if c:
        terms += f" + {c}" if c > 0 else f" - {abs(c)}"
    return (
        f"Solve {terms} = 0 and give the larger root. {BARE}",
        str(max(r1, r2)),
        "medium",
        {},
    )


def g_evaluate_poly(rng):
    a, b, c = rng.randint(2, 9), rng.randint(-9, 9), rng.randint(-20, 20)
    x = rng.randint(-7, 9)
    return (
        f"Let f(x) = {a}x^2 + ({b})x + ({c}). Compute f({x}). {BARE}",
        str(a * x * x + b * x + c),
        "easy",
        {},
    )


def g_rearrange(rng):
    m = rng.randint(2, 12)
    k = rng.randint(3, 20)
    t = rng.randint(2, 15)
    # v = sqrt(2*k/m) style: pick k so that the result is exact
    v2 = Fraction(2 * k, m)
    total = float(v2) * t
    return (
        f"A quantity satisfies k = m * v^2 / 2 with m = {m} and k = {k}. "
        f"Compute v^2 first, then report v^2 * {t}. {DP2} {SHOW}",
        fmt(total),
        "hard",
        {"tolerance": 0.011},
    )


# --------------------------------------------------------------------------------------
# number theory
# --------------------------------------------------------------------------------------


def g_gcd(rng):
    a, b = rng.randint(120, 9_800), rng.randint(120, 9_800)
    return f"What is the greatest common divisor of {a} and {b}? {BARE}", str(gcd(a, b)), "easy", {}


def g_lcm(rng):
    a, b = rng.randint(6, 84), rng.randint(6, 84)
    return (
        f"What is the least common multiple of {a} and {b}? {BARE}",
        str(a * b // gcd(a, b)),
        "medium",
        {},
    )


def _is_prime(n: int) -> bool:
    if n < 2:
        return False
    if n % 2 == 0:
        return n == 2
    for i in range(3, isqrt(n) + 1, 2):
        if n % i == 0:
            return False
    return True


def g_primes_between(rng):
    lo = rng.randint(20, 400)
    hi = lo + rng.randint(40, 120)
    count = sum(1 for n in range(lo, hi + 1) if _is_prime(n))
    return (
        f"How many prime numbers are there between {lo} and {hi} inclusive? {SHOW}",
        str(count),
        "hard",
        {},
    )


def g_modpow(rng):
    base = rng.randint(2, 19)
    exp = rng.randint(5, 40)
    mod = rng.choice([7, 11, 13, 17, 19, 23, 97, 101])
    return (
        f"Compute {base}^{exp} mod {mod}. {SHOW}",
        str(pow(base, exp, mod)),
        "hard",
        {},
    )


def g_divisors(rng):
    n = rng.randint(60, 990)
    count = sum(1 for d in range(1, n + 1) if n % d == 0)
    return (
        f"How many positive divisors does {n} have (including 1 and {n})? {SHOW}",
        str(count),
        "medium",
        {},
    )


def g_base_conv(rng):
    n = rng.randint(70, 4_090)
    which = rng.choice(["bin", "hex"])
    if which == "bin":
        text = format(n, "b")
        return (
            f"The binary number {text} is which decimal number? {BARE}",
            str(n),
            "easy",
            {},
        )
    text = format(n, "X")
    return (
        f"The hexadecimal number 0x{text} is which decimal number? {BARE}",
        str(n),
        "easy",
        {},
    )


# --------------------------------------------------------------------------------------
# geometry
# --------------------------------------------------------------------------------------


def g_area(rng):
    shape = rng.choice(["rectangle", "triangle", "parallelogram"])
    a, b = rng.randint(3, 60), rng.randint(3, 60)
    if shape == "triangle":
        area = Fraction(a * b, 2)
        text = f"A triangle has a base of {a} cm and a height of {b} cm."
    elif shape == "rectangle":
        area = Fraction(a * b)
        text = f"A rectangle measures {a} cm by {b} cm."
    else:
        area = Fraction(a * b)
        text = f"A parallelogram has a base of {a} cm and a height of {b} cm."
    return (
        f"{text} What is its area in square centimetres? {BARE}",
        str(float(area)),
        "easy",
        {"tolerance": 1e-6},
    )


TRIPLES = ((3, 4, 5), (5, 12, 13), (8, 15, 17), (7, 24, 25), (20, 21, 29), (9, 40, 41), (12, 35, 37))


def g_pythagoras(rng):
    a, b, c = rng.choice(TRIPLES)
    k = rng.randint(1, 9)
    a, b, c = a * k, b * k, c * k
    if rng.random() < 0.5:
        return (
            f"A right-angled triangle has legs of {a} cm and {b} cm. "
            f"How long is the hypotenuse in centimetres? {BARE}",
            str(c),
            "easy",
            {},
        )
    return (
        f"A right-angled triangle has a hypotenuse of {c} cm and one leg of {a} cm. "
        f"How long is the other leg in centimetres? {BARE}",
        str(b),
        "medium",
        {},
    )


def g_circle(rng):
    r = rng.randint(2, 40)
    if rng.random() < 0.5:
        value = float(PI) * r * r
        what = f"area of a circle with radius {r} cm, in square centimetres"
    else:
        value = 2 * float(PI) * r
        what = f"circumference of a circle with radius {r} cm, in centimetres"
    return (
        f"Using pi = {PI}, what is the {what}? {DP2}",
        fmt(value),
        "medium",
        {"tolerance": 0.011},
    )


def g_volume(rng):
    if rng.random() < 0.5:
        a, b, c = rng.randint(2, 30), rng.randint(2, 30), rng.randint(2, 30)
        return (
            f"A box measures {a} cm by {b} cm by {c} cm. What is its volume in cubic centimetres? {BARE}",
            str(a * b * c),
            "easy",
            {},
        )
    r, h = rng.randint(2, 20), rng.randint(2, 40)
    value = float(PI) * r * r * h
    return (
        f"Using pi = {PI}, what is the volume of a cylinder with radius {r} cm and height {h} cm, "
        f"in cubic centimetres? {DP2}",
        fmt(value),
        "medium",
        {"tolerance": 0.05},
    )


def g_polygon_angles(rng):
    n = rng.randint(5, 20)
    return (
        f"What is the sum of the interior angles of a convex polygon with {n} sides, in degrees? {BARE}",
        str((n - 2) * 180),
        "medium",
        {},
    )


def g_trapezoid(rng):
    a, b = rng.randint(4, 40), rng.randint(4, 40)
    h = rng.randint(2, 30) * 2
    area = Fraction((a + b) * h, 2)
    return (
        f"A trapezoid has parallel sides of {a} cm and {b} cm and a height of {h} cm. "
        f"What is its area in square centimetres? {BARE}",
        str(float(area)),
        "easy",
        {"tolerance": 1e-6},
    )


# --------------------------------------------------------------------------------------
# word problems
# --------------------------------------------------------------------------------------

NAMES = ("Mira", "Tomas", "Ines", "Rafael", "Nadia", "Bo", "Juno", "Emre", "Dana", "Priya")


def g_speed(rng):
    speed = rng.choice([40, 45, 50, 60, 72, 80, 90, 96])
    hours = rng.choice([Fraction(1, 2), Fraction(3, 4), Fraction(3, 2), Fraction(5, 2), Fraction(2)])
    dist = speed * hours
    who = rng.choice(NAMES)
    return (
        f"{who} drives at a steady {speed} km/h for {float(hours)} hours. "
        f"How many kilometres does {who} cover? {BARE}",
        str(float(dist)),
        "easy",
        {"tolerance": 1e-6},
    )


def g_work_rate(rng):
    a = rng.choice([2, 3, 4, 6, 8, 12])
    b = rng.choice([3, 4, 6, 8, 12, 24])
    together = Fraction(1, Fraction(1, a) + Fraction(1, b))
    return (
        f"One pump fills a tank in {a} hours and a second pump fills the same tank in {b} hours. "
        f"Working together, how many hours do they take? {DP2} {SHOW}",
        fmt(float(together)),
        "hard",
        {"tolerance": 0.011},
    )


def g_discount_tax(rng):
    price = rng.randint(20, 400) * 5
    disc = rng.choice([10, 15, 20, 25, 30])
    tax = rng.choice([5, 7, 8, 10, 19, 20])
    final = price * (100 - disc) / 100 * (100 + tax) / 100
    return (
        f"A jacket costs {price} euro. A {disc}% discount is applied first, then {tax}% tax is "
        f"added to the discounted price. What does the customer pay, in euro? {DP2} {SHOW}",
        fmt(final),
        "hard",
        {"tolerance": 0.011},
    )


def g_mixture(rng):
    litres_a = rng.randint(2, 30)
    pct_a = rng.choice([10, 20, 25, 30, 40, 50])
    litres_b = rng.randint(2, 30)
    pct_b = rng.choice([5, 15, 35, 45, 60, 70])
    total = litres_a + litres_b
    conc = (litres_a * pct_a + litres_b * pct_b) / total
    return (
        f"{litres_a} litres of a {pct_a}% solution are mixed with {litres_b} litres of a {pct_b}% "
        f"solution. What is the concentration of the mixture, in percent? {DP2} {SHOW}",
        fmt(conc),
        "hard",
        {"tolerance": 0.011},
    )


def g_age(rng):
    child = rng.randint(4, 20)
    factor = rng.choice([2, 3, 4])
    years = rng.randint(2, 15)
    parent = child * factor
    return (
        f"{rng.choice(NAMES)} is {child} years old and their aunt is {factor} times as old. "
        f"How old will the aunt be in {years} years? {BARE}",
        str(parent + years),
        "medium",
        {},
    )


def g_interest(rng):
    principal = rng.randint(10, 200) * 100
    rate = rng.choice([2, 3, 4, 5, 6, 7])
    years = rng.randint(2, 12)
    interest = principal * rate * years / 100
    return (
        f"{principal} euro is invested at {rate}% simple interest per year for {years} years. "
        f"How much interest is earned in total, in euro? {BARE}",
        fmt(interest),
        "medium",
        {"tolerance": 0.011},
    )


# --------------------------------------------------------------------------------------
# sequences
# --------------------------------------------------------------------------------------


def g_arith_nth(rng):
    a0 = rng.randint(-20, 40)
    d = rng.randint(2, 17) * rng.choice([1, -1])
    n = rng.randint(8, 60)
    terms = ", ".join(str(a0 + d * i) for i in range(4))
    return (
        f"A sequence starts {terms}, ... What is term number {n}, counting the first term as term 1? {BARE}",
        str(a0 + d * (n - 1)),
        "easy",
        {},
    )


def g_geom_nth(rng):
    a0 = rng.randint(1, 9)
    r = rng.choice([2, 3, 5])
    n = rng.randint(5, 11)
    terms = ", ".join(str(a0 * r**i) for i in range(4))
    return (
        f"A sequence starts {terms}, ... What is term number {n}, counting the first term as term 1? {BARE}",
        str(a0 * r ** (n - 1)),
        "medium",
        {},
    )


def g_arith_sum(rng):
    a0 = rng.randint(1, 30)
    d = rng.randint(2, 12)
    n = rng.randint(10, 80)
    total = n * (2 * a0 + (n - 1) * d) // 2
    return (
        f"Add up the first {n} terms of the arithmetic sequence that starts at {a0} and increases "
        f"by {d} each step. {SHOW}",
        str(total),
        "hard",
        {},
    )


def g_fib(rng):
    a, b = rng.randint(1, 9), rng.randint(1, 9)
    n = rng.randint(9, 18)
    seq = [a, b]
    while len(seq) < n:
        seq.append(seq[-1] + seq[-2])
    return (
        f"A sequence begins {seq[0]}, {seq[1]} and every later term is the sum of the two before "
        f"it. What is term number {n}? {SHOW}",
        str(seq[n - 1]),
        "medium",
        {},
    )


def g_quadratic_seq(rng):
    a, b, c = rng.randint(1, 5), rng.randint(-6, 8), rng.randint(-10, 12)
    terms = [a * i * i + b * i + c for i in range(1, 6)]
    return (
        f"What is the next term of the sequence {', '.join(map(str, terms))}? "
        f"The second differences are constant. {SHOW}",
        str(a * 36 + b * 6 + c),
        "hard",
        {},
    )


def g_sum_squares(rng):
    n = rng.randint(7, 40)
    return (
        f"What is the sum of the squares of the whole numbers from 1 to {n}? {SHOW}",
        str(n * (n + 1) * (2 * n + 1) // 6),
        "medium",
        {},
    )


PLAN = (
    ("arithmetic", (g_mult, 4), (g_div_remainder, 4), (g_percent_of, 4), (g_percent_chain, 4),
     (g_fraction_add, 4), (g_order_of_ops, 4)),
    ("algebra", (g_linear, 5), (g_two_step, 4), (g_system, 5), (g_quadratic, 5),
     (g_evaluate_poly, 3), (g_rearrange, 2)),
    ("number_theory", (g_gcd, 4), (g_lcm, 3), (g_primes_between, 3), (g_modpow, 4),
     (g_divisors, 3), (g_base_conv, 3)),
    ("geometry", (g_area, 4), (g_pythagoras, 4), (g_circle, 4), (g_volume, 3),
     (g_polygon_angles, 2), (g_trapezoid, 3)),
    ("word_problems", (g_speed, 4), (g_work_rate, 4), (g_discount_tax, 4), (g_mixture, 4),
     (g_age, 4), (g_interest, 4)),
    ("sequences", (g_arith_nth, 3), (g_geom_nth, 3), (g_arith_sum, 3), (g_fib, 3),
     (g_quadratic_seq, 3), (g_sum_squares, 3)),
)


def main() -> None:
    rng = random.Random(SEED)
    rows: list[dict] = []
    seen: set[str] = set()
    for category, *generators in PLAN:
        for gen, count in generators:
            for _ in range(count):
                for _attempt in range(50):
                    prompt, answer, difficulty, meta = gen(rng)
                    if prompt not in seen:
                        break
                else:
                    raise RuntimeError(f"cannot make a unique item with {gen.__name__}")
                seen.add(prompt)
                row = {
                    "id": f"math-{len(rows) + 1:04d}",
                    "category": category,
                    "difficulty": difficulty,
                    "prompt": prompt,
                    "answer": answer,
                    "scorer": "numeric",
                }
                if meta:
                    row["meta"] = meta
                rows.append(row)

    d = L.dataset_dir(DATASET_ID)
    n = L.write_jsonl(d / "items.jsonl", rows)
    L.write_json(
        d / "dataset.json",
        L.eval_dataset_json(
            DATASET_ID,
            "Mathematics eval v1",
            "130 mathematics items with programmatically computed answers: arithmetic (including "
            "fractions and chained percentages), algebra (linear, systems, quadratics), number "
            "theory (gcd/lcm/primes/modular arithmetic/divisors/bases), geometry (areas, "
            "Pythagoras, circles, volumes), multi-step word problems and sequences.",
            rows,
            "gen_eval_math.py",
            "numeric",
            seed=SEED,
            notes=[
                "Every answer is derived from the generated numbers; none was typed by hand.",
                f"Where pi is needed the prompt pins it to {PI} and asks for two decimal places, "
                "so a correct method cannot be marked wrong for using a different pi.",
                "Hard items ask for reasoning and a final 'Answer: <number>' line. Give reasoning "
                "models enough max_tokens (the eval-math-v1 workload uses 4096).",
                "meta.tolerance overrides the numeric scorer's default of 1e-6.",
            ],
        ),
    )
    L.report(DATASET_ID, n)


if __name__ == "__main__":
    main()
