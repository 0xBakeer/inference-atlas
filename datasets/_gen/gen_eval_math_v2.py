# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Generate `datasets/eval-math-v2/`.

140 mathematics items, superseding eval-math-v1 because v1 saturates: strong
models score 98-100 % on it. v2 keeps the v1 contract — every answer is computed
by this script from the same numbers that go into the prompt, no hand-typed key
anywhere — and raises the bar per family: chained three-step percentages,
4x4-digit products, 3x3 integer systems, CRT residue systems, totients and
divisor sums, multiplicative orders, multi-step word problems that contain one
deliberately irrelevant number, exact probabilities over exhaustively enumerated
sample spaces, linear recurrences, and a new `claims` category: bounded
conjectures ("for every n from 1 to N ...") whose verdict the generator PROVES
by exhaustive check over the stated range, plus smallest-counterexample items
for the false ones.

Design rules (inherited from v1):
  * answers are exact: fractions only appear when they terminate as decimals,
    probabilities are asked to four decimal places with `meta.tolerance` 5e-5;
  * easy/medium items ask for the bare number, hard items ask for reasoning plus
    a final `Answer: <number>` line, which the shared answer-extraction rule
    looks for;
  * every constructed item is re-checked by an assertion against an independent
    property (a system's solution satisfies its equations, a CRT answer hits all
    residues, a claim's verdict is the brute-forced one).

Run: `uv run datasets/_gen/gen_eval_math_v2.py`
"""

from __future__ import annotations

import random
import sys
from fractions import Fraction
from itertools import combinations, product
from math import comb, factorial, gcd, isqrt
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import _lib as L  # noqa: E402

SEED = 20260910
DATASET_ID = "eval-math-v2"

BARE = "Reply with the final number only, with no units and no explanation."
SHOW = "Work through it step by step, then give the final answer on the last line in the form 'Answer: <number>'."
DP2 = "Round to two decimal places. Reply with the final number only."
DP4 = "Round to four decimal places."


def fmt(x: float, places: int = 2) -> str:
    return f"{round(x, places):.{places}f}"


def _is_prime(n: int) -> bool:
    if n < 2:
        return False
    if n % 2 == 0:
        return n == 2
    for i in range(3, isqrt(n) + 1, 2):
        if n % i == 0:
            return False
    return True


def _digit_sum(n: int) -> int:
    return sum(int(c) for c in str(abs(n)))


# --------------------------------------------------------------------------------------
# arithmetic
# --------------------------------------------------------------------------------------


def g_percent_chain3(rng):
    start = rng.randint(30, 300) * 10
    p1 = rng.choice([8, 12, 15, 18, 22, 35])
    p2 = rng.choice([5, 10, 14, 24, 28, 32])
    p3 = rng.choice([6, 9, 16, 21, 26, 34])
    if rng.random() < 0.5:
        final = start * (100 + p1) / 100 * (100 - p2) / 100 * (100 + p3) / 100
        story = f"first rises by {p1}%, then falls by {p2}% from the new value, then rises by {p3}%"
    else:
        final = start * (100 - p1) / 100 * (100 + p2) / 100 * (100 - p3) / 100
        story = f"first falls by {p1}%, then rises by {p2}% from the new value, then falls by {p3}%"
    return (
        f"A price of {start} euro {story} from the value it had after the second change. "
        f"What is the final price in euro? {DP2} {SHOW}",
        fmt(final),
        "hard",
        {"tolerance": 0.011},
    )


def g_bigmult(rng):
    a, b = rng.randint(1023, 9876), rng.randint(1201, 9877)
    return f"Compute {a} x {b}. {SHOW}", str(a * b), "hard", {}


def g_div_rem_big(rng):
    b = rng.randint(101, 997)
    q = rng.randint(1_020, 9_899)
    r = rng.randint(1, b - 1)
    a = b * q + r
    return (
        f"What is the remainder when {a} is divided by {b}? {SHOW}",
        str(r),
        "easy",
        {},
    )


def g_nested_frac(rng):
    dens = [2, 4, 5, 8, 10, 16, 20, 25]
    d1, d2, d3, d4 = (rng.choice(dens) for _ in range(4))
    n1, n2 = rng.randint(1, d1 - 1), rng.randint(1, d2 - 1)
    n3, n4 = rng.randint(1, d3 - 1), rng.randint(1, d4 - 1)
    left = Fraction(n1, d1) + Fraction(n2, d2)
    right = Fraction(n3, d3) - Fraction(n4, d4)
    total = left * right
    if right == 0:
        return g_nested_frac(rng)
    return (
        f"Compute ({n1}/{d1} + {n2}/{d2}) x ({n3}/{d3} - {n4}/{d4}) and give the result as an "
        f"exact decimal. {SHOW}",
        str(float(total)),
        "hard",
        {"tolerance": 1e-9},
    )


# --------------------------------------------------------------------------------------
# algebra
# --------------------------------------------------------------------------------------


def _det3(m) -> int:
    (a, b, c), (d, e, f), (g_, h, i) = m
    return a * (e * i - f * h) - b * (d * i - f * g_) + c * (d * h - e * g_)


def g_system3(rng):
    x, y, z = rng.randint(-9, 12), rng.randint(-9, 12), rng.randint(-9, 12)
    while True:
        m = [[rng.randint(-4, 6) or 1 for _ in range(3)] for _ in range(3)]
        if _det3(m) != 0:
            break
    rhs = [row[0] * x + row[1] * y + row[2] * z for row in m]
    for row, r in zip(m, rhs):
        assert row[0] * x + row[1] * y + row[2] * z == r
    eqs = []
    for row, r in zip(m, rhs):
        terms = []
        for coeff, var in zip(row, ("x", "y", "z")):
            if not terms:
                terms.append(f"{coeff}{var}" if coeff != 1 else var)
            else:
                sign = "+" if coeff >= 0 else "-"
                mag = "" if abs(coeff) == 1 else str(abs(coeff))
                terms.append(f"{sign} {mag}{var}")
        eqs.append(f"{' '.join(terms)} = {r}")
    what, value = rng.choice(
        [("x + y + z", x + y + z), ("x", x), ("z", z), ("x - z", x - z)]
    )
    return (
        f"Solve the system: {eqs[0]}, {eqs[1]}, {eqs[2]}. What is {what}? {SHOW}",
        str(value),
        "hard",
        {},
    )


def g_quad_sq(rng):
    r1, r2 = rng.randint(-12, 12), rng.randint(-12, 12)
    if r1 == r2:
        r2 += 1
    b, c = -(r1 + r2), r1 * r2
    terms = "x^2"
    if b:
        coeff = "" if abs(b) == 1 else str(abs(b))
        terms += f" + {coeff}x" if b > 0 else f" - {coeff}x"
    if c:
        terms += f" + {c}" if c > 0 else f" - {abs(c)}"
    if rng.random() < 0.5:
        what, value = "the sum of the squares of the two roots", r1 * r1 + r2 * r2
    else:
        what, value = "the product of the roots minus the sum of the roots", r1 * r2 - (r1 + r2)
    return (
        f"The equation {terms} = 0 has two real roots. What is {what}? {SHOW}",
        str(value),
        "medium",
        {},
    )


def g_compose(rng):
    a, b = rng.randint(2, 7), rng.randint(-9, 9)
    c, d = rng.randint(2, 5), rng.randint(-8, 8)
    e, k = rng.randint(2, 6), rng.randint(-7, 7)
    x0 = rng.randint(-5, 6)
    h = e * x0 - k
    g_v = c * h * h + d
    value = a * g_v + b
    return (
        f"Let f(x) = {a}x + ({b}), g(x) = {c}x^2 + ({d}) and h(x) = {e}x - ({k}). "
        f"Compute f(g(h({x0}))). {BARE}",
        str(value),
        "easy",
        {},
    )


def g_linear_param(rng):
    c = rng.choice([2, 3, 4])
    a, d = rng.randint(2, 7), rng.randint(1, 6)
    while gcd(a + d, c) != 1:  # guarantees a solvable congruence below
        a, d = rng.randint(2, 7), rng.randint(1, 6)
    b, e = rng.randint(-9, 9), rng.randint(-9, 9)
    x = rng.randint(-10, 15)
    while ((a + d) * x + b + e) % c != 0:
        x = rng.randint(-10, 15)
    rhs = ((a + d) * x + b + e) // c
    sb = f"+ {b}" if b >= 0 else f"- {abs(b)}"
    se = f"+ {e}" if e >= 0 else f"- {abs(e)}"
    return (
        f"Solve for x: (({a}x {sb}) + ({d}x {se})) / {c} = {rhs}. {BARE}",
        str(x),
        "medium",
        {},
    )


# --------------------------------------------------------------------------------------
# number theory
# --------------------------------------------------------------------------------------

CRT_MODULI = (
    (7, 11, 13), (5, 9, 11), (5, 8, 9), (7, 9, 10), (11, 13, 16), (9, 13, 14),
    (5, 7, 16), (7, 13, 15), (8, 11, 15), (9, 11, 16),
)


def g_crt(rng):
    mods = rng.choice(CRT_MODULI)
    residues = tuple(rng.randint(1, m - 1) for m in mods)
    limit = mods[0] * mods[1] * mods[2]
    n = next(
        n for n in range(1, limit + 1)
        if all(n % m == r for m, r in zip(mods, residues))
    )
    for m, r in zip(mods, residues):
        assert n % m == r
    return (
        f"Find the smallest positive integer n with n mod {mods[0]} = {residues[0]}, "
        f"n mod {mods[1]} = {residues[1]} and n mod {mods[2]} = {residues[2]}. {SHOW}",
        str(n),
        "hard",
        {},
    )


def g_totient(rng):
    n = rng.randint(200, 1500)
    while _is_prime(n):
        n = rng.randint(200, 1500)
    phi = sum(1 for i in range(1, n + 1) if gcd(i, n) == 1)
    return (
        f"Euler's totient phi(n) counts the integers from 1 to n that are coprime to n. "
        f"Compute phi({n}). {SHOW}",
        str(phi),
        "medium",
        {},
    )


def g_divisor_sum(rng):
    n = rng.randint(300, 1500)
    total = sum(d for d in range(1, n + 1) if n % d == 0)
    return (
        f"What is the sum of all positive divisors of {n}, including 1 and {n} itself? {SHOW}",
        str(total),
        "medium",
        {},
    )


def g_last_two(rng):
    a = rng.randint(12, 97)
    while a % 10 == 0:
        a = rng.randint(12, 97)
    b = rng.randint(21, 79)
    return (
        f"Compute {a}^{b} mod 100 (the last two digits of {a}^{b}). {SHOW}",
        str(pow(a, b, 100)),
        "hard",
        {},
    )


def g_mult_order(rng):
    n = rng.choice([11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53, 59, 61, 67, 71, 73, 79, 83, 89, 97])
    a = rng.randint(2, n - 1)
    order = next(k for k in range(1, n) if pow(a, k, n) == 1)
    assert pow(a, order, n) == 1
    return (
        f"The multiplicative order of a modulo n is the smallest positive integer k with "
        f"a^k mod n = 1. Compute the multiplicative order of {a} modulo {n}. {SHOW}",
        str(order),
        "hard",
        {},
    )


# --------------------------------------------------------------------------------------
# word problems (each carries one deliberately irrelevant number)
# --------------------------------------------------------------------------------------

NAMES = ("Mira", "Tomas", "Ines", "Rafael", "Nadia", "Bo", "Juno", "Emre", "Dana", "Priya")


def g_work_three(rng):
    a = rng.choice([3, 4, 5, 6, 8, 10])
    b = rng.choice([4, 6, 8, 10, 12, 15])
    c = rng.choice([5, 6, 9, 12, 18, 20])
    litres = rng.randint(120, 900) * 5
    together = 1 / (Fraction(1, a) + Fraction(1, b) + Fraction(1, c))
    return (
        f"Three pumps fill the same tank in {a} hours, {b} hours and {c} hours respectively. "
        f"The tank holds {litres} litres. Working together, how many hours do the three pumps "
        f"take to fill it? {DP2} {SHOW}",
        fmt(float(together)),
        "hard",
        {"tolerance": 0.011},
    )


def g_boat(rng):
    c = rng.randint(2, 6)
    b = c + rng.choice([4, 6, 8, 10, 12])
    d = rng.randint(20, 120)
    width = rng.randint(40, 300)
    total = Fraction(d, b - c) + Fraction(d, b + c)
    return (
        f"A boat travels at {b} km/h in still water on a river whose current is {c} km/h; the "
        f"river is {width} metres wide. The boat goes {d} km upstream and then returns the same "
        f"{d} km downstream. How many hours does the round trip take? {DP2} {SHOW}",
        fmt(float(total)),
        "hard",
        {"tolerance": 0.011},
    )


def g_trains(rng):
    s_kmh = rng.choice([90, 108, 126, 144, 162, 180])
    v1 = rng.randint(30, s_kmh - 30)
    v2 = s_kmh - v1
    assert (v1 + v2) * 5 % 18 == 0
    s_ms = (v1 + v2) * 5 // 18
    t = rng.randint(8, 30)
    total_len = s_ms * t
    l1 = rng.randint(total_len // 4, 3 * total_len // 4)
    l2 = total_len - l1
    cars = rng.randint(6, 18)
    return (
        f"A train {l1} m long travelling at {v1} km/h and a train {l2} m long travelling at "
        f"{v2} km/h move towards each other on parallel tracks; the first train has {cars} "
        f"carriages. How many seconds pass from the moment the trains meet until they have "
        f"completely passed each other? {SHOW}",
        str(t),
        "hard",
        {},
    )


def g_ages2(rng):
    t = rng.choice([2, 3, 4])
    m = rng.randint(2, 12)
    b_now = m + rng.randint(2, 12)
    k = (t - 1) * (b_now - m)
    a_now = b_now + k
    assert a_now - m == t * (b_now - m)
    cousin = rng.randint(20, 60)
    who_a, who_b = rng.sample(NAMES, 2)
    return (
        f"{who_a} is {k} years older than {who_b}, and {m} years ago {who_a} was exactly "
        f"{t} times as old as {who_b}. Their cousin is {cousin} years old. How old is "
        f"{who_a} now? {SHOW}",
        str(a_now),
        "medium",
        {},
    )


# --------------------------------------------------------------------------------------
# combinatorics and probability
# --------------------------------------------------------------------------------------


def g_dice(rng):
    space = list(product(range(1, 7), repeat=3))
    kind = rng.choice(["sum", "max", "pair"])
    if kind == "sum":
        s = rng.randint(9, 14)
        fav = sum(1 for r in space if sum(r) == s)
        what = f"the three numbers add up to exactly {s}"
    elif kind == "max":
        k = rng.randint(4, 6)
        fav = sum(1 for r in space if max(r) == k)
        what = f"the largest of the three numbers is exactly {k}"
    else:
        fav = sum(1 for r in space if len(set(r)) < 3)
        what = "at least two of the three dice show the same number"
    p = Fraction(fav, len(space))
    assert 0 < p < 1
    return (
        f"Three fair six-sided dice are rolled. What is the probability that {what}? "
        f"{DP4} {SHOW}",
        f"{float(p):.4f}",
        "hard",
        {"tolerance": 0.00005},
    )


def g_draws(rng):
    r, g_n, b = rng.randint(2, 6), rng.randint(2, 6), rng.randint(2, 6)
    balls = ["red"] * r + ["green"] * g_n + ["blue"] * b
    kind = rng.choice(["all_diff", "no_red", "two_same"])
    triples = list(combinations(range(len(balls)), 3))
    if kind == "all_diff":
        fav = sum(1 for t in triples if len({balls[i] for i in t}) == 3)
        what = "the three balls all have different colours"
    elif kind == "no_red":
        fav = sum(1 for t in triples if all(balls[i] != "red" for i in t))
        what = "none of the three balls is red"
    else:
        fav = sum(1 for t in triples if len({balls[i] for i in t}) == 2)
        what = "exactly two of the three balls share a colour"
    p = Fraction(fav, len(triples))
    if not 0 < p < 1:
        return g_draws(rng)
    return (
        f"A bag holds {r} red, {g_n} green and {b} blue balls. Three balls are drawn at random "
        f"without replacement. What is the probability that {what}? {DP4} {SHOW}",
        f"{float(p):.4f}",
        "hard",
        {"tolerance": 0.00005},
    )


def g_grid_paths(rng):
    m, n = rng.randint(5, 9), rng.randint(5, 9)
    bx, by = rng.randint(1, m - 1), rng.randint(1, n - 1)
    dp = [[0] * (n + 1) for _ in range(m + 1)]
    dp[0][0] = 1
    for i in range(m + 1):
        for j in range(n + 1):
            if (i, j) == (bx, by):
                dp[i][j] = 0
                continue
            if i:
                dp[i][j] += dp[i - 1][j]
            if j:
                dp[i][j] += dp[i][j - 1] if (i, j) != (0, 0) else 0
    paths = dp[m][n]
    assert 0 < paths < comb(m + n, m)
    return (
        f"On a grid you walk from (0, 0) to ({m}, {n}) taking unit steps only right or up, "
        f"and you must avoid the point ({bx}, {by}). How many distinct paths are there? {SHOW}",
        str(paths),
        "hard",
        {},
    )


def g_committees(rng):
    eng, des = rng.randint(5, 9), rng.randint(4, 8)
    k = rng.randint(4, min(7, eng + des - 1))
    j = rng.randint(2, min(3, k - 1, des))
    ways = sum(comb(des, d) * comb(eng, k - d) for d in range(j, min(des, k) + 1))
    assert 0 < ways <= comb(eng + des, k)
    return (
        f"A team of {k} people is chosen from {eng} engineers and {des} designers, and the team "
        f"must include at least {j} designers. How many different teams are possible? {SHOW}",
        str(ways),
        "medium",
        {},
    )


# --------------------------------------------------------------------------------------
# sequences
# --------------------------------------------------------------------------------------


def g_linrec(rng):
    p = rng.choice([1, 2, 3])
    q = rng.choice([-2, -1, 1, 2, 3])
    a1, a2 = rng.randint(1, 6), rng.randint(1, 6)
    n = rng.randint(12, 16)
    seq = [a1, a2]
    while len(seq) < n:
        seq.append(p * seq[-1] + q * seq[-2])
    if not 10_000 < abs(seq[n - 1]) < 10**9:
        return g_linrec(rng)
    return (
        f"A sequence is defined by a(1) = {a1}, a(2) = {a2} and "
        f"a(n) = {p}*a(n-1) + ({q})*a(n-2) for n >= 3. Compute a({n}). {SHOW}",
        str(seq[n - 1]),
        "hard",
        {},
    )


def g_geom_sum(rng):
    a0 = rng.randint(1, 9)
    r = rng.choice([2, 3])
    n = rng.randint(8, 13)
    total = a0 * (r**n - 1) // (r - 1)
    assert total == sum(a0 * r**i for i in range(n))
    return (
        f"Add up the first {n} terms of the geometric sequence that starts at {a0} and "
        f"multiplies by {r} each step. {SHOW}",
        str(total),
        "medium",
        {},
    )


def g_digit_seq(rng):
    k = rng.randint(10, 80)
    m = rng.randint(10, 14)
    t = k
    for _ in range(m - 1):
        t = t + _digit_sum(t)
    return (
        f"A sequence is defined by t(1) = {k} and t(n) = t(n-1) plus the sum of the decimal "
        f"digits of t(n-1). Compute t({m}). {SHOW}",
        str(t),
        "medium",
        {},
    )


# --------------------------------------------------------------------------------------
# claims — bounded conjectures, verdict proved by exhaustive check
# --------------------------------------------------------------------------------------


def _stern_holds(n: int) -> bool:
    """n (odd) = p + 2k^2 for some prime p and integer k >= 0."""
    k = 0
    while 2 * k * k < n:
        if _is_prime(n - 2 * k * k):
            return True
        k += 1
    return False


def _consecutive_sum(n: int) -> bool:
    for length in range(2, isqrt(2 * n) + 2):
        # a + (a+1) + ... + (a+length-1) = length*a + length*(length-1)/2 = n
        num = n - length * (length - 1) // 2
        if num <= 0:
            break
        if num % length == 0:
            return True
    return False


#: (statement, domain description for the counterexample question, holds(n), lo, hi,
#:  wants_counterexample_item)
CLAIMS = (
    (
        "For every integer n from 1 to 45, n^2 + n + 41 is prime.",
        "integer n",
        lambda n: _is_prime(n * n + n + 41), 1, 45, True,
    ),
    (
        "For every integer n from 1 to 39, n^2 + n + 41 is prime.",
        "integer n",
        lambda n: _is_prime(n * n + n + 41), 1, 39, False,
    ),
    (
        "For every integer n from 1 to 20, n^2 + n + 17 is prime.",
        "integer n",
        lambda n: _is_prime(n * n + n + 17), 1, 20, False,
    ),
    (
        "For every prime p from 2 to 20, the number 2^p - 1 is also prime.",
        "prime p",
        lambda n: not _is_prime(n) or _is_prime(2**n - 1), 2, 20, True,
    ),
    (
        "For every prime p from 2 to 7, the number 2^p - 1 is also prime.",
        "prime p",
        lambda n: not _is_prime(n) or _is_prime(2**n - 1), 2, 7, False,
    ),
    (
        "For every integer n from 1 to 300, n^5 - n is divisible by 30.",
        "integer n",
        lambda n: (n**5 - n) % 30 == 0, 1, 300, False,
    ),
    (
        "Every odd integer from 3 to 6001 can be written as p + 2*k^2 where p is a prime "
        "and k is an integer that may be 0.",
        "odd integer",
        lambda n: n % 2 == 0 or _stern_holds(n), 3, 6001, True,
    ),
    (
        "Every odd integer from 3 to 5000 can be written as p + 2*k^2 where p is a prime "
        "and k is an integer that may be 0.",
        "odd integer",
        lambda n: n % 2 == 0 or _stern_holds(n), 3, 5000, False,
    ),
    (
        "For every integer n from 16 to 100, 2^n is strictly greater than n^4.",
        "integer n",
        lambda n: 2**n > n**4, 16, 100, True,
    ),
    (
        "For every integer n from 9 to 30, n! is strictly greater than 4^n.",
        "integer n",
        lambda n: factorial(n) > 4**n, 9, 30, False,
    ),
    (
        "There is no integer n from 1 to 5000 whose square has a decimal digit sum equal to 15.",
        "integer n",
        lambda n: _digit_sum(n * n) != 15, 1, 5000, False,
    ),
    (
        "There is no integer n from 1 to 5000 whose square has a decimal digit sum equal to 18.",
        "integer n",
        lambda n: _digit_sum(n * n) != 18, 1, 5000, True,
    ),
    (
        "For every two-digit integer n from 10 to 99, n plus the number formed by reversing "
        "the digits of n is divisible by 11.",
        "two-digit integer n",
        lambda n: (n + int(str(n)[::-1])) % 11 == 0, 10, 99, False,
    ),
    (
        "Every integer from 100 to 260 can be written as a sum of two or more consecutive "
        "positive integers.",
        "integer",
        lambda n: _consecutive_sum(n), 100, 260, True,
    ),
)

MC_TAIL = "Reply with the letter of the correct option only."


def claim_rows(rng: random.Random, start_index: int) -> list[dict]:
    rows: list[dict] = []
    idx = start_index
    for statement, domain, holds, lo, hi, wants_cx in CLAIMS:
        failures = [n for n in range(lo, hi + 1) if not holds(n)]
        verdict = "True" if not failures else "False"
        options = ["True", "False"]
        rng.shuffle(options)
        letter = "AB"[options.index(verdict)]
        prompt = (
            f'Consider the claim:\n\n"{statement}"\n\nIs the claim true or false?\n\n'
            f"A. {options[0]}\nB. {options[1]}\n\n{MC_TAIL}"
        )
        rows.append(
            {
                "id": f"math2-{idx:04d}",
                "category": "claims",
                "difficulty": "medium",
                "prompt": prompt,
                "answer": letter,
                "scorer": "mc",
                "choices": options,
            }
        )
        idx += 1
        if wants_cx:
            assert failures, f"claim marked for a counterexample item but it is true: {statement}"
            rows.append(
                {
                    "id": f"math2-{idx:04d}",
                    "category": "claims",
                    "difficulty": "hard",
                    "prompt": (
                        f'The following claim is false:\n\n"{statement}"\n\nWhat is the '
                        f"smallest {domain} in the stated range for which it fails? {SHOW}"
                    ),
                    "answer": str(failures[0]),
                    "scorer": "numeric",
                }
            )
            idx += 1
    return rows


# --------------------------------------------------------------------------------------

PLAN = (
    ("arithmetic", (g_percent_chain3, 5), (g_bigmult, 5), (g_div_rem_big, 5), (g_nested_frac, 5)),
    ("algebra", (g_system3, 6), (g_quad_sq, 5), (g_compose, 5), (g_linear_param, 4)),
    ("number_theory", (g_crt, 6), (g_totient, 4), (g_divisor_sum, 4), (g_last_two, 4),
     (g_mult_order, 4)),
    ("word_problems", (g_work_three, 5), (g_boat, 5), (g_trains, 5), (g_ages2, 5)),
    ("combinatorics_probability", (g_dice, 5), (g_draws, 5), (g_grid_paths, 5), (g_committees, 5)),
    ("sequences", (g_linrec, 6), (g_geom_sum, 6), (g_digit_seq, 6)),
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
                    "id": f"math2-{len(rows) + 1:04d}",
                    "category": category,
                    "difficulty": difficulty,
                    "prompt": prompt,
                    "answer": answer,
                    "scorer": "numeric",
                }
                if meta:
                    row["meta"] = meta
                rows.append(row)

    rows.extend(claim_rows(rng, len(rows) + 1))
    assert len(rows) == 140, f"expected 140 rows, built {len(rows)}"
    assert len({r["prompt"] for r in rows}) == len(rows)

    d = L.dataset_dir(DATASET_ID)
    n = L.write_jsonl(d / "items.jsonl", rows)
    L.write_json(
        d / "dataset.json",
        L.eval_dataset_json(
            DATASET_ID,
            "Mathematics eval v2",
            "140 mathematics items with programmatically computed answers, superseding "
            "eval-math-v1 (which strong models saturate): three-step percentage chains, "
            "4x4-digit products, 3x3 integer systems and composed functions, CRT residue "
            "systems, totients, divisor sums, multiplicative orders and a^b mod 100, "
            "multi-step word problems that each contain one deliberately irrelevant number, "
            "exact probabilities over exhaustively enumerated sample spaces, lattice-path and "
            "committee counting, linear recurrences, and bounded true/false claims whose "
            "verdict the generator proves by exhaustive check, with "
            "smallest-counterexample items for false claims.",
            rows,
            "gen_eval_math_v2.py",
            "numeric",
            seed=SEED,
            supersedes="eval-math-v1",
            notes=[
                "Every answer is derived from the generated numbers; none was typed by hand. "
                "Claim verdicts and counterexamples are brute-forced over the exact range "
                "stated in the prompt.",
                "Word problems each contain one deliberately irrelevant number (a tank volume, "
                "a river width, a carriage count, a cousin's age); using it is the error the "
                "item is designed to catch.",
                "Probability answers are requested to four decimal places with meta.tolerance "
                "0.00005; other rounded decimals pin two decimal places like v1.",
                "Hard items ask for reasoning and a final 'Answer: <number>' line. Give "
                "reasoning models enough max_tokens (the eval-math-v2 workload uses 4096).",
                "claims rows are multiple choice (scorer mc, choices True/False with the "
                "correct letter balanced); everything else is numeric.",
            ],
        ),
    )
    L.report(DATASET_ID, n)


if __name__ == "__main__":
    main()
