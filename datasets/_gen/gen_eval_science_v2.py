# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Generate `datasets/eval-science-v2/`.

120 applied physics and chemistry problems whose answers are computed by this
script from the same numbers that go into the prompt — the repository's
"answers are computed, never typed" rule, applied to science. Every constant a
solution needs is pinned in the prompt itself (g, R, specific heats, latent
heats, molar masses, molar volumes, sine values, the speed of sound), so an
item tests multi-step quantitative reasoning, never constant recall — a model
cannot be marked wrong for having learned g = 9.80665 instead of 10.

Part of the -v2 generation of evals: eval-knowledge-v1/eval-math-v1/
eval-reasoning-v1 saturated (several models at or near 100 %), so the v2 suites
are built to spread strong models across 40-80 %. The instruments here are
multi-step chains (slide down the ramp, then grind across the rough floor),
limiting-reagent traps where the naive non-limiting computation gives a
plausible wrong answer, and deliberate unit mismatches (°C next to K, kPa next
to Pa, cm³ next to m³) that the prompt states openly but the model must notice.

Design rules, inherited from gen_eval_math.py:
  * numbers are chosen so answers are exact, or the prompt pins the rounding
    ("round to two decimal places") and `meta.tolerance` is raised to match;
  * easy/medium items ask for the bare number, hard items ask for reasoning
    plus a final `Answer: <number>` line;
  * every family asserts its answer through the physics (energy bookkeeping,
    the limiting answer never exceeding the naive one) before emitting a row.

Run: `uv run datasets/_gen/gen_eval_science_v2.py`
"""

from __future__ import annotations

import math
import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import _lib as L  # noqa: E402

SEED = 20260910
DATASET_ID = "eval-science-v2"

BARE = "Reply with the final number only, with no units and no explanation."
SHOW = (
    "Work through it step by step, then give the final answer on the last line "
    "in the form 'Answer: <number>'."
)
DP2 = "Round to two decimal places."


def fmt(x: float, places: int = 2) -> str:
    return f"{round(x, places):.{places}f}"


def clean(x: float) -> str:
    """Render an exact value without a trailing .0 when it is an integer."""
    if abs(x - round(x)) < 1e-9:
        return str(int(round(x)))
    return repr(round(x, 6))


# --------------------------------------------------------------------------------------
# mechanics
# --------------------------------------------------------------------------------------


def g_fall_time(rng):
    t = rng.randint(2, 7)
    h = 5 * t * t  # h = g t^2 / 2 with g = 10
    assert abs(math.sqrt(2 * h / 10) - t) < 1e-9
    return (
        f"A stone is dropped from rest off a cliff {h} m high. Take g = 10 m/s^2 and ignore "
        f"air resistance. How many seconds does it take to reach the ground? {BARE}",
        str(t),
        "easy",
        {},
    )


def g_projectile_range(rng):
    t = rng.randint(2, 6)
    h = 5 * t * t
    v = rng.choice([8, 12, 15, 18, 24, 30])
    r = v * t
    assert abs(v * math.sqrt(2 * h / 10) - r) < 1e-9
    return (
        f"A ball is thrown horizontally at {v} m/s from the top of a tower {h} m tall. "
        f"Take g = 10 m/s^2 and ignore air resistance. How far from the base of the tower, "
        f"in metres, does it land? {SHOW}",
        str(r),
        "hard",
        {},
    )


def g_incline_friction(rng):
    # 3-4-5 incline, sin and cos pinned in the prompt.
    mu_num = rng.choice([1, 2, 3])  # mu = mu_num / 8 -> a = 10*(0.6 - mu*0.8) stays clean
    mu = mu_num / 8
    a = 10 * (0.6 - mu * 0.8)
    m = rng.choice([2, 3, 4, 5, 8])
    assert a > 0
    return (
        f"A {m} kg block slides down a ramp inclined so that sin(theta) = 0.6 and "
        f"cos(theta) = 0.8. The coefficient of kinetic friction between block and ramp is "
        f"{mu}. Take g = 10 m/s^2. What is the block's acceleration down the ramp, in m/s^2? "
        f"{SHOW}",
        clean(a),
        "hard",
        {},
    )


def g_inelastic_collision(rng):
    m1 = rng.choice([2, 3, 4, 6])
    m2 = rng.choice([2, 3, 4, 6])
    total = m1 + m2
    # pick velocities so the combined velocity is exact to one decimal at worst
    v_final = rng.choice([1, 2, 3, 4, 5])
    for _ in range(100):
        v1 = rng.randint(2, 12)
        p2 = v_final * total - m1 * v1
        if p2 % m2 == 0 and p2 // m2 != v1 and abs(p2 // m2) <= 15:
            v2 = p2 // m2
            break
    else:  # pragma: no cover - the search space always contains a solution
        raise RuntimeError("no clean collision found")
    assert m1 * v1 + m2 * v2 == total * v_final
    return (
        f"A {m1} kg cart moving at {v1} m/s collides head-on with a {m2} kg cart moving at "
        f"{v2} m/s along the same line (positive numbers mean the same direction). They stick "
        f"together. What is the speed of the pair after the collision, in m/s? {SHOW}",
        str(v_final),
        "medium",
        {},
    )


def g_centripetal(rng):
    m = rng.choice([1, 2, 3, 5])
    r = rng.choice([2, 4, 5, 8, 10])
    v = rng.choice([4, 6, 8, 10, 12])
    f = m * v * v / r
    return (
        f"A {m} kg mass moves in a circle of radius {r} m at a constant speed of {v} m/s. "
        f"What net centripetal force, in newtons, keeps it on the circle? {BARE}",
        clean(f),
        "medium",
        {},
    )


def g_energy_friction(rng):
    # slide down a frictionless ramp of height h, then across a rough floor: d = h / mu
    mu = rng.choice([0.2, 0.25, 0.4, 0.5])
    d = rng.choice([8, 10, 12, 16, 20])
    h = mu * d
    # energy bookkeeping: m g h == mu m g d, mass cancels
    assert abs(h - mu * d) < 1e-9
    return (
        f"A block starts from rest at the top of a frictionless ramp of height {clean(h)} m, "
        f"slides down, and then moves across a horizontal floor where the coefficient of "
        f"kinetic friction is {mu}. Take g = 10 m/s^2. How far along the floor, in metres, "
        f"does it slide before stopping? {SHOW}",
        str(d),
        "hard",
        {},
    )


# --------------------------------------------------------------------------------------
# electricity
# --------------------------------------------------------------------------------------

# parallel pairs whose combination is an integer
_PAR_PAIRS = [(6, 3), (12, 4), (12, 6), (10, 10), (8, 8), (20, 5), (6, 6), (15, 10), (30, 6)]


def g_branch_current(rng):
    for _ in range(400):
        r2, r3 = rng.choice(_PAR_PAIRS)
        rp = r2 * r3 // (r2 + r3)
        r1 = rng.choice([2, 3, 4, 5, 6, 8, 10])
        i_total = rng.choice([1, 2, 3, 4, 5, 6, 8])
        v = i_total * (r1 + rp)
        v_par = i_total * rp
        if v_par % r2 == 0 and v_par // r2 >= 1:
            break
    else:  # pragma: no cover
        raise RuntimeError("no clean branch current")
    i2 = v_par // r2
    assert abs(v_par / r2 + v_par / r3 - i_total) < 1e-9
    return (
        f"A {v} V battery drives a circuit made of a {r1} ohm resistor R1 in series with a "
        f"parallel pair: R2 = {r2} ohm and R3 = {r3} ohm. What current flows through R2, in "
        f"amperes? {SHOW}",
        str(i2),
        "hard",
        {},
    )


def g_power_in_series_resistor(rng):
    r2, r3 = rng.choice(_PAR_PAIRS)
    rp = r2 * r3 // (r2 + r3)
    r1 = rng.choice([2, 3, 4, 5, 6, 8])
    i_total = rng.choice([1, 2, 3, 4])
    v = i_total * (r1 + rp)
    p1 = i_total * i_total * r1
    assert p1 + i_total * i_total * rp == v * i_total
    return (
        f"A {v} V battery is connected to a {r1} ohm resistor R1 in series with a parallel "
        f"pair: R2 = {r2} ohm and R3 = {r3} ohm. How much power, in watts, is dissipated in "
        f"R1? {SHOW}",
        str(p1),
        "hard",
        {},
    )


def g_equivalent_resistance(rng):
    ra = rng.choice([2, 3, 4, 5, 6, 8, 10])
    rb = rng.choice([2, 3, 4, 5, 6, 8, 10])
    rc = rng.choice([3, 4, 5, 6, 8, 10, 12, 15, 20])
    series = ra + rb
    req = series * rc / (series + rc)
    return (
        f"Resistors of {ra} ohm and {rb} ohm are connected in series, and that combination is "
        f"connected in parallel with a {rc} ohm resistor. What is the equivalent resistance of "
        f"the whole arrangement, in ohms? {DP2} {BARE}",
        fmt(req),
        "medium",
        {"tolerance": 0.011},
    )


def g_energy_cost(rng):
    p = rng.choice([500, 800, 1200, 1500, 2000, 2500])
    hours = rng.choice([2, 3, 4, 5, 6])
    days = rng.choice([10, 20, 30])
    cents = rng.choice([20, 25, 30, 40])
    kwh = p / 1000 * hours * days
    cost = kwh * cents / 100
    return (
        f"An appliance rated at {p} W runs {hours} hours a day for {days} days. Electricity "
        f"costs {cents} cents per kWh. What is the total cost in euros? {DP2} {SHOW}",
        fmt(cost),
        "medium",
        {"tolerance": 0.011},
    )


def g_ohm_ma(rng):
    r = rng.choice([200, 400, 500, 800, 1000, 2000])
    ma = rng.choice([5, 10, 15, 20, 25, 40, 50])
    v = r * ma / 1000
    return (
        f"A current of {ma} mA flows through a {r} ohm resistor. What is the voltage across "
        f"the resistor, in volts? {BARE}",
        clean(v),
        "easy",
        {},
    )


# --------------------------------------------------------------------------------------
# thermodynamics
# --------------------------------------------------------------------------------------


def g_calorimetry_mix(rng):
    # water mixed with water: Teq is the mass-weighted mean; pick masses/temps so it is exact
    w1 = rng.choice([1, 2, 3])
    w2 = rng.choice([1, 2, 3])
    for _ in range(200):
        t1 = rng.randrange(10, 40, 2)
        t2 = rng.randrange(50, 96, 2)
        if (w1 * t1 + w2 * t2) % (w1 + w2) == 0 and t1 != t2:
            break
    else:  # pragma: no cover
        raise RuntimeError("no clean mix")
    teq = (w1 * t1 + w2 * t2) // (w1 + w2)
    assert w1 * (teq - t1) == w2 * (t2 - teq)  # heat gained == heat lost
    return (
        f"{w1} kg of water at {t1} degrees C is mixed with {w2} kg of water at {t2} degrees C "
        f"in an insulated container. The specific heat of water is 4200 J/(kg*K) throughout. "
        f"What is the final temperature in degrees C? {SHOW}",
        str(teq),
        "medium",
        {},
    )


def g_calorimetry_metal(rng):
    # hot metal dropped into water; c values pinned, numbers chosen for an exact Teq
    c_m = rng.choice([400, 500, 900])  # J/(kg K), pinned in prompt
    m_m = rng.choice([1, 2])
    m_w = rng.choice([1, 2])
    cw = 4200
    for _ in range(500):
        t_w = rng.randrange(10, 30, 5)
        t_m = rng.randrange(100, 320, 20)
        num = m_m * c_m * t_m + m_w * cw * t_w
        den = m_m * c_m + m_w * cw
        if num % den == 0:
            teq = num // den
            if t_w < teq < t_m:
                break
    else:  # pragma: no cover
        raise RuntimeError("no clean metal mix")
    assert m_m * c_m * (t_m - teq) == m_w * cw * (teq - t_w)
    return (
        f"A {m_m} kg block of metal with specific heat {c_m} J/(kg*K) at {t_m} degrees C is "
        f"dropped into {m_w} kg of water (specific heat 4200 J/(kg*K)) at {t_w} degrees C in "
        f"an insulated container. What is the equilibrium temperature in degrees C? {SHOW}",
        str(teq),
        "hard",
        {},
    )


def g_phase_change(rng):
    # ice below zero -> water above zero; constants pinned; answer in kJ, exact
    m = rng.choice([1, 2, 4, 5])  # kg
    t_ice = rng.choice([5, 10, 20])  # degrees below zero
    t_end = rng.choice([10, 20, 25, 40, 50])
    q = m * 2100 * t_ice + m * 336000 + m * 4200 * t_end
    assert q == m * (2100 * t_ice + 336000 + 4200 * t_end)
    return (
        f"How much energy, in kJ, does it take to turn {m} kg of ice at -{t_ice} degrees C "
        f"into water at {t_end} degrees C? Use: specific heat of ice 2100 J/(kg*K), latent "
        f"heat of fusion 336000 J/kg, specific heat of water 4200 J/(kg*K). {SHOW}",
        str(q // 1000),
        "hard",
        {},
    )


def g_ideal_gas(rng):
    # n = PV / (RT) with kPa and litres and degrees C in the prompt; R pinned
    p_kpa = rng.choice([100, 120, 150, 200, 250])
    v_l = rng.choice([5, 8, 10, 12, 20, 25])
    t_c = rng.choice([17, 27, 47, 77, 127])
    n = (p_kpa * 1000) * (v_l / 1000) / (8.314 * (t_c + 273))
    return (
        f"A rigid container of volume {v_l} L holds a gas at a pressure of {p_kpa} kPa and a "
        f"temperature of {t_c} degrees C. Take R = 8.314 J/(mol*K) and 0 degrees C = 273 K. "
        f"How many moles of gas are in the container? {DP2} {SHOW}",
        fmt(n),
        "hard",
        {"tolerance": 0.011},
    )


def g_gas_isochoric(rng):
    # P1/T1 = P2/T2 at constant volume; temperatures given in Celsius on purpose
    t1_c = rng.choice([7, 27, 57, 77])
    t1 = t1_c + 273
    factor_num, factor_den = rng.choice([(3, 2), (4, 3), (5, 4), (2, 1), (6, 5)])
    t2 = t1 * factor_num // factor_den
    if t1 * factor_num % factor_den != 0:
        t2 = t1  # fall back, filtered below
    p1 = rng.choice([100, 120, 150, 200])
    p2 = p1 * t2 // t1
    if p1 * t2 % t1 != 0 or t2 == t1:
        # regenerate deterministically from a fixed clean set
        t1_c, t1 = 27, 300
        t2 = 450
        p1, p2 = 120, 180
    assert p1 * t2 == p2 * t1
    return (
        f"A sealed rigid container holds gas at {p1} kPa and {t1_c} degrees C. It is heated "
        f"until its absolute temperature is {t2} K (use 0 degrees C = 273 K). What is the new "
        f"pressure in kPa? {SHOW}",
        str(p2),
        "medium",
        {},
    )


# --------------------------------------------------------------------------------------
# chemistry
# --------------------------------------------------------------------------------------


def g_limiting_reagent(rng):
    # 2 H2 + O2 -> 2 H2O with molar masses pinned; masses chosen so O2 (or H2) limits
    # and the naive answer from the other reagent is larger.
    h2_g = rng.choice([8, 10, 12, 16, 20])
    o2_g = rng.choice([32, 48, 64, 80])
    mol_h2 = h2_g / 2
    mol_o2 = o2_g / 32
    water_from_h2 = mol_h2  # 2 H2 -> 2 H2O
    water_from_o2 = 2 * mol_o2
    mol_water = min(water_from_h2, water_from_o2)
    if water_from_h2 == water_from_o2:
        o2_g += 16
        mol_o2 = o2_g / 32
        water_from_o2 = 2 * mol_o2
        mol_water = min(water_from_h2, water_from_o2)
    mass_water = mol_water * 18
    assert mass_water <= water_from_h2 * 18 and mass_water <= water_from_o2 * 18
    return (
        f"Hydrogen burns as 2 H2 + O2 -> 2 H2O. You mix {h2_g} g of H2 with {o2_g} g of O2 "
        f"and ignite it. Molar masses: H2 = 2 g/mol, O2 = 32 g/mol, H2O = 18 g/mol. What "
        f"mass of water, in grams, can actually form? {SHOW}",
        clean(mass_water),
        "hard",
        {},
    )


def g_limiting_reagent_n2(rng):
    # N2 + 3 H2 -> 2 NH3
    n2_g = rng.choice([28, 42, 56, 84])
    h2_g = rng.choice([6, 9, 12, 15, 18])
    mol_n2 = n2_g / 28
    mol_h2 = h2_g / 2
    nh3_from_n2 = 2 * mol_n2
    nh3_from_h2 = 2 * mol_h2 / 3
    mol_nh3 = min(nh3_from_n2, nh3_from_h2)
    if abs(nh3_from_n2 - nh3_from_h2) < 1e-9:
        n2_g += 28
        mol_n2 = n2_g / 28
        nh3_from_n2 = 2 * mol_n2
        mol_nh3 = min(nh3_from_n2, nh3_from_h2)
    mass = mol_nh3 * 17
    assert mass <= nh3_from_n2 * 17 and mass <= nh3_from_h2 * 17
    return (
        f"Ammonia forms as N2 + 3 H2 -> 2 NH3. You react {n2_g} g of N2 with {h2_g} g of H2. "
        f"Molar masses: N2 = 28 g/mol, H2 = 2 g/mol, NH3 = 17 g/mol. What mass of NH3, in "
        f"grams, can actually form? {SHOW}",
        clean(mass),
        "hard",
        {},
    )


def g_dilution_chain(rng):
    c0 = rng.choice([2, 4, 5, 8])  # mol/L stock
    v1 = rng.choice([25, 50, 100])  # mL taken
    v2 = rng.choice([250, 500, 1000])  # mL after first dilution
    v3 = rng.choice([10, 20, 50])  # mL taken again
    v4 = rng.choice([100, 200, 500])  # mL final
    c1 = c0 * v1 / v2
    c2 = c1 * v3 / v4
    assert abs(c0 * v1 * v3 - c2 * v2 * v4) < 1e-9
    return (
        f"You take {v1} mL of a {c0} mol/L stock solution and dilute it to {v2} mL. Then you "
        f"take {v3} mL of that dilution and dilute it to {v4} mL. What is the final "
        f"concentration in mol/L? Give the exact decimal. {SHOW}",
        clean(c2),
        "medium",
        {"tolerance": 1e-6},
    )


def g_percent_yield(rng):
    mol = rng.choice([2, 3, 4, 5])
    m_product = rng.choice([44, 18, 17, 40])  # pinned as "the product's molar mass"
    theoretical = mol * m_product
    pct = rng.choice([60, 65, 70, 75, 80, 85, 90])
    actual = theoretical * pct / 100
    assert abs(actual / theoretical * 100 - pct) < 1e-9
    return (
        f"A reaction should produce {mol} mol of a product whose molar mass is {m_product} "
        f"g/mol, so the theoretical yield is {theoretical} g. The actual yield is "
        f"{clean(actual)} g. What is the percent yield? {BARE}",
        str(pct),
        "easy",
        {},
    )


def g_gas_stoich(rng):
    # CaCO3 -> CaO + CO2; molar volume pinned at 24 L/mol
    mol = rng.choice([1, 2, 3, 5])
    mass = mol * 100
    vol = mol * 24
    assert vol == mass // 100 * 24
    return (
        f"Calcium carbonate decomposes as CaCO3 -> CaO + CO2. You fully decompose {mass} g "
        f"of CaCO3 (molar mass 100 g/mol). At the conditions of the experiment one mole of "
        f"gas occupies 24 L. What volume of CO2, in litres, is produced? {SHOW}",
        str(vol),
        "medium",
        {},
    )


# --------------------------------------------------------------------------------------
# waves_optics
# --------------------------------------------------------------------------------------


def g_wave_chain(rng):
    f_mhz = rng.choice([50, 75, 100, 150, 200])
    v = 300000000
    lam = v / (f_mhz * 1000000)
    return (
        f"A radio wave travels at 3.00e8 m/s. Its frequency is {f_mhz} MHz. What is its "
        f"wavelength in metres? {BARE}",
        clean(lam),
        "easy",
        {},
    )


def g_standing_wave(rng):
    v = rng.choice([40, 60, 80, 120])
    l_str = rng.choice([1, 2, 4])
    n = rng.choice([2, 3, 4, 5])
    f_n = n * v / (2 * l_str)
    assert abs(f_n / n * 2 * l_str - v) < 1e-9
    return (
        f"A string of length {l_str} m is fixed at both ends, and waves travel along it at "
        f"{v} m/s. What is the frequency of its harmonic number {n} (the fundamental is "
        f"harmonic number 1), in Hz? {SHOW}",
        clean(f_n),
        "hard",
        {},
    )


def g_snell(rng):
    n1, n2 = rng.choice([(1.5, 1.0), (1.2, 1.0), (1.5, 1.2), (1.6, 1.2), (1.4, 1.0)])
    sin1 = rng.choice([0.2, 0.25, 0.4, 0.5, 0.6])
    sin2 = n1 * sin1 / n2
    if sin2 >= 1:
        sin1, sin2 = 0.2, n1 * 0.2 / n2
    assert sin2 < 1
    return (
        f"Light passes from a medium with refractive index {n1} into a medium with refractive "
        f"index {n2}. The sine of the angle of incidence is {sin1}. Using Snell's law, what "
        f"is the sine of the angle of refraction? {DP2} {BARE}",
        fmt(sin2),
        "medium",
        {"tolerance": 0.011},
    )


def g_period(rng):
    t_ms = rng.choice([4, 5, 8, 10, 20, 25, 40])
    f = 1000 / t_ms
    return (
        f"An oscillation has a period of {t_ms} ms. What is its frequency in Hz? {BARE}",
        clean(f),
        "easy",
        {},
    )


def g_echo(rng):
    t = rng.choice([1, 2, 3, 4, 6])
    d = 340 * t // 2
    assert 2 * d == 340 * t
    return (
        f"A ship sounds its horn and hears the echo off a cliff {t} s later. Sound travels at "
        f"340 m/s in the air that day. How far away is the cliff, in metres? {SHOW}",
        str(d),
        "medium",
        {},
    )


# --------------------------------------------------------------------------------------
# radioactivity_units
# --------------------------------------------------------------------------------------


def g_half_life_mass(rng):
    half = rng.choice([5, 8, 10, 12, 20])
    k = rng.choice([3, 4, 5, 6])
    m0 = rng.choice([64, 80, 96, 128, 160]) * (2 ** max(0, k - 4))
    total = half * k
    m = m0 / 2**k
    assert m * 2**k == m0
    return (
        f"A radioactive sample has a half-life of {half} days. You start with {m0} g. What "
        f"mass, in grams, remains after {total} days? {SHOW}",
        clean(m),
        "medium",
        {},
    )


def g_half_life_time(rng):
    half = rng.choice([6, 9, 15, 25, 30])
    k = rng.choice([3, 4, 5])
    frac = 2**k
    assert half * k == k * half
    return (
        f"A radioactive isotope has a half-life of {half} years. How many years pass before "
        f"only 1/{frac} of the original sample remains? {SHOW}",
        str(half * k),
        "medium",
        {},
    )


def g_speed_convert_chain(rng):
    v_ms = rng.choice([5, 10, 15, 20, 25, 30])
    kmh = v_ms * 18 // 5
    minutes = rng.choice([3, 5, 10, 15, 20])
    d = v_ms * minutes * 60
    assert kmh * 5 == v_ms * 18 and d == v_ms * minutes * 60
    return (
        f"A train travels at a steady {kmh} km/h for {minutes} minutes. How many metres does "
        f"it cover? {SHOW}",
        str(d),
        "hard",
        {},
    )


def g_density_units(rng):
    rho = rng.choice([0.8, 0.9, 1.2, 2.5, 7.8])  # g/cm^3
    v_m3 = rng.choice([2, 3, 4, 5]) / 10  # cubic metres, one decimal
    kg = rho * 1000 * v_m3
    assert abs(kg - rho * (v_m3 * 1000000) / 1000) < 1e-9
    return (
        f"A material has a density of {rho} g/cm^3. What is the mass, in kilograms, of "
        f"{v_m3} m^3 of it? (1 m^3 = 1,000,000 cm^3, 1 kg = 1000 g.) {SHOW}",
        clean(kg),
        "hard",
        {},
    )


def g_kmh_to_ms(rng):
    v_ms = rng.choice([5, 10, 15, 20, 25, 35, 40])
    kmh = v_ms * 18 // 5
    assert kmh * 5 == v_ms * 18
    return (
        f"Convert {kmh} km/h to m/s. {BARE}",
        str(v_ms),
        "easy",
        {},
    )


PLAN = (
    ("mechanics", (g_fall_time, 3), (g_projectile_range, 3), (g_incline_friction, 4),
     (g_inelastic_collision, 4), (g_centripetal, 3), (g_energy_friction, 3)),
    ("electricity", (g_branch_current, 5), (g_power_in_series_resistor, 4),
     (g_equivalent_resistance, 4), (g_energy_cost, 4), (g_ohm_ma, 3)),
    ("thermodynamics", (g_calorimetry_mix, 4), (g_calorimetry_metal, 4), (g_phase_change, 4),
     (g_ideal_gas, 4), (g_gas_isochoric, 4)),
    ("chemistry", (g_limiting_reagent, 4), (g_limiting_reagent_n2, 4), (g_dilution_chain, 4),
     (g_percent_yield, 4), (g_gas_stoich, 4)),
    ("waves_optics", (g_wave_chain, 4), (g_standing_wave, 4), (g_snell, 4), (g_period, 4),
     (g_echo, 4)),
    ("radioactivity_units", (g_half_life_mass, 4), (g_half_life_time, 4),
     (g_speed_convert_chain, 4), (g_density_units, 4), (g_kmh_to_ms, 4)),
)


def main() -> None:
    rng = random.Random(SEED)
    rows: list[dict] = []
    seen: set[str] = set()
    for category, *generators in PLAN:
        for gen, count in generators:
            for _ in range(count):
                for _attempt in range(80):
                    prompt, answer, difficulty, meta = gen(rng)
                    if prompt not in seen:
                        break
                else:
                    raise RuntimeError(f"cannot make a unique item with {gen.__name__}")
                seen.add(prompt)
                row = {
                    "id": f"sci-{len(rows) + 1:04d}",
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
            "Science eval v2",
            "120 applied physics and chemistry problems with programmatically computed "
            "answers: mechanics (projectiles, friction on inclines, collisions, energy "
            "chains), DC circuits (branch currents and power in mixed networks, energy "
            "cost), thermodynamics (calorimetry, phase changes, ideal gas with unit "
            "conversions), chemistry (limiting reagents, dilution chains, percent yield, "
            "gas stoichiometry), waves and optics, and half-life plus multi-hop unit "
            "conversions. Every constant a solution needs is pinned in the prompt.",
            rows,
            "gen_eval_science_v2.py",
            "numeric",
            seed=SEED,
            notes=[
                "Part of the -v2 eval generation: built to spread models that saturate the "
                "v1 suites. The hard items are multi-step chains, limiting-reagent traps "
                "and deliberate unit mismatches stated openly in the prompt.",
                "Every answer is derived from the generated numbers; none was typed by "
                "hand, and each family asserts its answer through the physics before "
                "emitting a row.",
                "All constants are pinned in the prompt (g, R, specific and latent heats, "
                "molar masses, molar volumes, sine values, the speed of sound), so an item "
                "never depends on which value of a constant the model memorised.",
                "Hard items ask for reasoning and a final 'Answer: <number>' line. Give "
                "reasoning models enough max_tokens (the eval-science-v2 workload uses "
                "4096).",
                "meta.tolerance overrides the numeric scorer's default of 1e-6 where the "
                "prompt asks for a rounded decimal.",
            ],
        ),
    )
    L.report(DATASET_ID, n)


if __name__ == "__main__":
    main()
