# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Generate `datasets/eval-knowledge-v2/`.

~150 four-option multiple-choice items over stable, unambiguous facts a tier
deeper than eval-knowledge-v1, which strong models saturate. v1 asks for element
symbols and planet order; v2 asks which base-unit decomposition a henry has,
which planet Iapetus orbits, which gland secretes cortisol, into which sea the
Dnieper empties, and who discovered the neutron. Six categories: physics,
chemistry, biology, astronomy, geography, history_biography.

Deliberately excluded, exactly as in v1: anything a model could be right about
and be marked wrong for — current office-holders, populations, contested
superlatives, recent events, capitals that have moved, and anything that depends
on the year. Every fact here is textbook-stable.

Distractors are drawn from the same fact table as the answer (atomic numbers use
the numerically nearest table values), so a wrong option is always plausible
rather than absurd — that, plus the deeper fact tier, is what keeps this suite
off the ceiling.

Run: `uv run datasets/_gen/gen_eval_knowledge_v2.py`
"""

from __future__ import annotations

import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import _lib as L  # noqa: E402

SEED = 20260910
DATASET_ID = "eval-knowledge-v2"
LETTERS = "ABCD"
TAIL = "Reply with the letter of the correct option only."

# --------------------------------------------------------------------------------------
# physics
# --------------------------------------------------------------------------------------

#: derived unit -> its expression in SI base units
SI_DECOMPOSITIONS = {
    "newton": "kg·m·s^-2",
    "pascal": "kg·m^-1·s^-2",
    "joule": "kg·m^2·s^-2",
    "watt": "kg·m^2·s^-3",
    "volt": "kg·m^2·s^-3·A^-1",
    "ohm": "kg·m^2·s^-3·A^-2",
    "farad": "kg^-1·m^-2·s^4·A^2",
    "weber": "kg·m^2·s^-2·A^-1",
    "tesla": "kg·s^-2·A^-1",
    "henry": "kg·m^2·s^-2·A^-2",
}

#: unit -> the physical quantity it measures
UNIT_QUANTITY = {
    "weber": "Magnetic flux",
    "tesla": "Magnetic flux density",
    "henry": "Inductance",
    "farad": "Capacitance",
    "siemens": "Electrical conductance",
    "gray": "Absorbed dose of ionising radiation",
    "sievert": "Equivalent dose of ionising radiation",
    "becquerel": "Activity of a radioactive source",
    "katal": "Catalytic activity",
    "lux": "Illuminance",
    "candela": "Luminous intensity",
    "poise": "Dynamic viscosity",
    "stokes": "Kinematic viscosity",
    "barn": "Cross-sectional area in nuclear physics",
    "dioptre": "Optical power of a lens",
}

#: particle -> Standard Model classification
PARTICLES = {
    "muon": "A lepton",
    "pion": "A meson",
    "kaon": "A meson",
    "neutron": "A baryon",
    "gluon": "A gauge boson",
    "Higgs particle": "A scalar boson",
}

# --------------------------------------------------------------------------------------
# chemistry
# --------------------------------------------------------------------------------------

#: element -> atomic number (mid-table; distractors are the nearest table values)
ATOMIC_NUMBERS = {
    "boron": "5", "fluorine": "9", "sodium": "11", "magnesium": "12",
    "aluminium": "13", "silicon": "14", "phosphorus": "15", "sulfur": "16",
    "chlorine": "17", "potassium": "19", "calcium": "20", "chromium": "24",
    "manganese": "25", "iron": "26", "nickel": "28", "copper": "29",
    "zinc": "30", "bromine": "35", "silver": "47", "iodine": "53",
    "gold": "79", "mercury": "80", "lead": "82", "uranium": "92",
}

#: (compound, formula, three chemically plausible wrong formulas)
COMPOUND_FORMULAS = [
    ("sulfuric acid", "H2SO4", ["H2SO3", "SO3", "H2S"]),
    ("nitric acid", "HNO3", ["HNO2", "NO2", "N2O3"]),
    ("phosphoric acid", "H3PO4", ["H3PO3", "P2O5", "HPO2"]),
    ("hydrogen peroxide", "H2O2", ["H2O", "HO2", "H2O3"]),
    ("calcium carbonate", "CaCO3", ["CaC2", "Ca(HCO3)2", "CaO"]),
    ("sodium bicarbonate", "NaHCO3", ["Na2CO3", "NaOH", "NaCO3"]),
    ("potassium permanganate", "KMnO4", ["K2MnO4", "KMnO2", "MnO2"]),
    ("glucose", "C6H12O6", ["C6H10O5", "C12H22O11", "C6H6O6"]),
]

#: polyatomic ion -> formula with charge
POLYATOMIC_IONS = {
    "sulfate": "SO4^2-",
    "sulfite": "SO3^2-",
    "nitrate": "NO3^-",
    "nitrite": "NO2^-",
    "carbonate": "CO3^2-",
    "phosphate": "PO4^3-",
    "ammonium": "NH4^+",
    "cyanide": "CN^-",
    "permanganate": "MnO4^-",
    "chlorate": "ClO3^-",
    "hypochlorite": "ClO^-",
    "acetate": "CH3COO^-",
}

# --------------------------------------------------------------------------------------
# biology
# --------------------------------------------------------------------------------------

#: organelle -> primary function
ORGANELLES = {
    "mitochondrion": "Producing ATP by cellular respiration",
    "rough endoplasmic reticulum": "Synthesising and folding proteins destined for membranes or secretion",
    "smooth endoplasmic reticulum": "Synthesising lipids and detoxifying certain compounds",
    "Golgi apparatus": "Modifying, sorting and packaging proteins for transport",
    "lysosome": "Digesting worn-out organelles and macromolecules with hydrolytic enzymes",
    "peroxisome": "Breaking down fatty acids and detoxifying hydrogen peroxide",
    "nucleolus": "Assembling ribosomal subunits",
    "ribosome": "Translating messenger RNA into protein",
    "chloroplast": "Carrying out photosynthesis",
    "central vacuole of a plant cell": "Storing water and maintaining turgor pressure",
}

#: vitamin -> classic deficiency disease
VITAMIN_DEFICIENCIES = {
    "C": "Scurvy",
    "D": "Rickets",
    "B1 (thiamine)": "Beriberi",
    "B3 (niacin)": "Pellagra",
    "B12": "Pernicious anaemia",
}

#: hormone -> secreting gland or organ
HORMONE_GLANDS = {
    "insulin": "The pancreas",
    "glucagon": "The pancreas",
    "thyroxine": "The thyroid gland",
    "cortisol": "The adrenal glands",
    "melatonin": "The pineal gland",
    "growth hormone": "The pituitary gland",
    "adrenaline": "The adrenal glands",
}

# --------------------------------------------------------------------------------------
# astronomy
# --------------------------------------------------------------------------------------

#: moon -> the planet (or dwarf planet) it orbits
MOONS = {
    "Enceladus": "Saturn",
    "Iapetus": "Saturn",
    "Rhea": "Saturn",
    "Triton": "Neptune",
    "Europa": "Jupiter",
    "Io": "Jupiter",
    "Callisto": "Jupiter",
    "Phobos": "Mars",
    "Deimos": "Mars",
    "Titania": "Uranus",
    "Oberon": "Uranus",
    "Miranda": "Uranus",
    "Charon": "Pluto",
}

# --------------------------------------------------------------------------------------
# geography
# --------------------------------------------------------------------------------------

#: country -> capital (harder tier than v1; only capitals that have not moved)
CAPITALS = {
    "Mongolia": "Ulaanbaatar",
    "Uzbekistan": "Tashkent",
    "Azerbaijan": "Baku",
    "Georgia (the Caucasus country)": "Tbilisi",
    "Armenia": "Yerevan",
    "Nepal": "Kathmandu",
    "Cambodia": "Phnom Penh",
    "Laos": "Vientiane",
    "Ethiopia": "Addis Ababa",
    "Ghana": "Accra",
    "Senegal": "Dakar",
    "Algeria": "Algiers",
    "Uruguay": "Montevideo",
    "Paraguay": "Asunción",
    "Ecuador": "Quito",
    "Croatia": "Zagreb",
    "Slovenia": "Ljubljana",
    "Slovakia": "Bratislava",
    "Bulgaria": "Sofia",
    "Romania": "Bucharest",
    "New Zealand": "Wellington",
}

#: strait -> the two land areas it separates
STRAITS = {
    "Strait of Gibraltar": "The Iberian Peninsula from North Africa",
    "Bosporus": "The European part of Turkey from its Asian part",
    "Bering Strait": "Northeastern Asia from northwestern North America",
    "Strait of Dover": "England from France",
    "Strait of Malacca": "The Malay Peninsula from the island of Sumatra",
    "Strait of Magellan": "Mainland South America from the Tierra del Fuego archipelago",
    "Strait of Hormuz": "Iran from the Musandam Peninsula of Arabia",
}

#: river -> the body of water it empties into
RIVER_MOUTHS = {
    "Danube": "The Black Sea",
    "Rhine": "The North Sea",
    "Rhône": "The Mediterranean Sea",
    "Volga": "The Caspian Sea",
    "Ganges": "The Bay of Bengal",
    "Po": "The Adriatic Sea",
    "Vistula": "The Baltic Sea",
    "Dnieper": "The Black Sea",
    "Indus": "The Arabian Sea",
    "Mekong": "The South China Sea",
    "Niger": "The Gulf of Guinea",
}

#: desert or mountain range -> continent
LANDFORMS = {
    "Gobi Desert": "Asia",
    "Atacama Desert": "South America",
    "Kalahari Desert": "Africa",
    "Mojave Desert": "North America",
    "Thar Desert": "Asia",
    "Atlas Mountains": "Africa",
    "Carpathian Mountains": "Europe",
    "Great Dividing Range": "Australia",
    "Zagros Mountains": "Asia",
}

# --------------------------------------------------------------------------------------
# history & biography
# --------------------------------------------------------------------------------------

#: scientist -> the discovery or theory they are best known for
DISCOVERIES = {
    "Gregor Mendel": "The basic laws of inheritance, from experiments with pea plants",
    "Ernest Rutherford": "The atomic nucleus, from the gold-foil scattering experiment",
    "James Chadwick": "The neutron",
    "J.J. Thomson": "The electron",
    "Alfred Wegener": "The theory of continental drift",
    "Wilhelm Röntgen": "X-rays",
    "Henri Becquerel": "Natural radioactivity",
    "Dmitri Mendeleev": "The periodic table of the elements",
    "Michael Faraday": "Electromagnetic induction",
    "Werner Heisenberg": "The uncertainty principle",
    "Edwin Hubble": "That distant galaxies are receding — the expansion of the universe",
    "Alexander Fleming": "Penicillin",
}

#: classic work (pre-1950) -> author
CLASSIC_WORKS = {
    "Don Quixote": "Miguel de Cervantes",
    "Moby-Dick": "Herman Melville",
    "Crime and Punishment": "Fyodor Dostoevsky",
    "Jane Eyre": "Charlotte Brontë",
    "Wuthering Heights": "Emily Brontë",
    "Frankenstein": "Mary Shelley",
    "Dracula": "Bram Stoker",
    "Madame Bovary": "Gustave Flaubert",
    "Faust": "Johann Wolfgang von Goethe",
    "The Divine Comedy": "Dante Alighieri",
    "The Metamorphosis": "Franz Kafka",
    "The Magic Mountain": "Thomas Mann",
    "The Grapes of Wrath": "John Steinbeck",
    "War and Peace": "Leo Tolstoy",
}

#: composer -> musical era
COMPOSER_ERAS = {
    "Johann Sebastian Bach": "Baroque",
    "George Frideric Handel": "Baroque",
    "Antonio Vivaldi": "Baroque",
    "Joseph Haydn": "Classical",
    "Wolfgang Amadeus Mozart": "Classical",
    "Frédéric Chopin": "Romantic",
    "Johannes Brahms": "Romantic",
    "Pyotr Ilyich Tchaikovsky": "Romantic",
    "Giovanni Pierluigi da Palestrina": "Renaissance",
}

#: explorer or aviator -> the deed they are famous for
EXPLORERS = {
    "Ferdinand Magellan's expedition": "Completing the first circumnavigation of the Earth",
    "Roald Amundsen": "Leading the first expedition to reach the South Pole",
    "Vasco da Gama": "Sailing the first sea route from Europe to India around Africa",
    "Charles Lindbergh": "Making the first solo nonstop flight across the Atlantic",
}

#: (category, difficulty, question, correct answer, three distractors)
CURATED = [
    # physics
    ("physics", "hard",
     "According to Noether's theorem, invariance of physical laws under translation in time "
     "implies the conservation of which quantity?",
     "Energy", ["Linear momentum", "Angular momentum", "Electric charge"]),
    ("physics", "hard",
     "According to Noether's theorem, invariance of physical laws under rotation implies the "
     "conservation of which quantity?",
     "Angular momentum", ["Energy", "Linear momentum", "Electric charge"]),
    ("physics", "medium",
     "Which statement expresses the second law of thermodynamics?",
     "The entropy of an isolated system never decreases",
     ["Energy can be neither created nor destroyed, only transformed",
      "If two systems are each in thermal equilibrium with a third, they are in equilibrium "
      "with each other",
      "The entropy of a perfect crystal approaches zero as the temperature approaches "
      "absolute zero"]),
    ("physics", "easy",
     "Which colour of visible light has the longest wavelength?",
     "Red", ["Violet", "Blue", "Green"]),
    # chemistry
    ("chemistry", "hard",
     "Why does graphite conduct electricity while diamond does not?",
     "Graphite has delocalised electrons that are free to move between its layers",
     ["Diamond's carbon atoms hold fewer electrons than graphite's",
      "Graphite contains traces of metal atoms between its layers",
      "Diamond's electrons are destroyed by the pressure under which it forms"]),
    ("chemistry", "medium",
     "Which is the only nonmetallic element that is liquid at room temperature and pressure?",
     "Bromine", ["Mercury", "Iodine", "Chlorine"]),
    ("chemistry", "easy",
     "In redox chemistry, oxidation is defined as what?",
     "The loss of electrons", ["The gain of electrons", "The gain of protons",
                               "The loss of neutrons"]),
    # biology
    ("biology", "medium",
     "In biological classification, which rank comes immediately above genus?",
     "Family", ["Order", "Species", "Class"]),
    ("biology", "hard",
     "In biological classification, which rank sits between phylum and order?",
     "Class", ["Family", "Kingdom", "Genus"]),
    ("biology", "medium",
     "People with which blood group are called universal red-cell donors?",
     "O negative", ["AB positive", "O positive", "AB negative"]),
    ("biology", "medium",
     "Which structure is absent from mature human red blood cells?",
     "The nucleus", ["The cell membrane", "Haemoglobin", "The cytoplasm"]),
    ("biology", "medium",
     "In RNA, which base takes the place of the thymine found in DNA?",
     "Uracil", ["Guanine", "Adenine", "Cytosine"]),
    ("biology", "medium",
     "In plants, which tissue transports water from the roots upward?",
     "Xylem", ["Phloem", "Cambium", "Epidermis"]),
    # astronomy
    ("astronomy", "medium",
     "Which is the largest moon in the Solar System?",
     "Ganymede", ["Titan", "Callisto", "Triton"]),
    ("astronomy", "medium",
     "Which planet has the hottest average surface temperature?",
     "Venus", ["Mercury", "Mars", "Jupiter"]),
    ("astronomy", "medium",
     "On which planet is Olympus Mons, the tallest volcano in the Solar System?",
     "Mars", ["Venus", "Earth", "Mercury"]),
    ("astronomy", "medium",
     "Which of these units of distance is the longest?",
     "A parsec", ["A light-year", "An astronomical unit", "A million kilometres"]),
    ("astronomy", "easy",
     "One astronomical unit is approximately the distance between which two bodies?",
     "The Earth and the Sun",
     ["The Earth and the Moon", "The Sun and Pluto", "The Earth and Mars"]),
    ("astronomy", "easy",
     "Which element makes up most of the Sun's mass?",
     "Hydrogen", ["Helium", "Oxygen", "Carbon"]),
    ("astronomy", "hard",
     "The star Betelgeuse is best described as what?",
     "A red supergiant", ["A white dwarf", "A neutron star", "A main-sequence yellow star"]),
    ("astronomy", "medium",
     "Which star appears brightest in Earth's night sky?",
     "Sirius", ["Polaris", "Betelgeuse", "Vega"]),
    ("astronomy", "hard",
     "In which constellation is Polaris, the North Star?",
     "Ursa Minor", ["Ursa Major", "Cassiopeia", "Orion"]),
    ("astronomy", "medium",
     "What type of galaxy is the Milky Way?",
     "A barred spiral galaxy",
     ["An elliptical galaxy", "A lenticular galaxy", "An irregular galaxy"]),
    ("astronomy", "medium",
     "The main asteroid belt lies between the orbits of which two planets?",
     "Mars and Jupiter", ["Earth and Mars", "Jupiter and Saturn", "Venus and Earth"]),
    ("astronomy", "medium",
     "The Kuiper belt lies beyond the orbit of which planet?",
     "Neptune", ["Jupiter", "Saturn", "Mars"]),
    ("astronomy", "hard",
     "Roughly how long is the orbital period of Halley's comet?",
     "About 76 years", ["About 7 years", "About 200 years", "About 760 years"]),
    ("astronomy", "easy",
     "During a total solar eclipse, which body passes between the other two?",
     "The Moon — it passes between the Sun and the Earth",
     ["The Earth — it passes between the Sun and the Moon",
      "The Sun — it passes between the Earth and the Moon",
      "No body is between the others; the Sun itself briefly dims"]),
    ("astronomy", "medium",
     "Which two planets in the Solar System have no moons?",
     "Mercury and Venus", ["Mercury and Mars", "Venus and Mars", "Venus and Neptune"]),
    # history & biography — fixed dates with nearby-year distractors
    ("history_biography", "hard",
     "In which year was Magna Carta sealed?", "1215", ["1066", "1266", "1315"]),
    ("history_biography", "medium",
     "In which year was the Battle of Hastings fought?", "1066", ["1016", "1106", "1215"]),
    ("history_biography", "hard",
     "Which year is conventionally given for the fall of the Western Roman Empire?",
     "AD 476", ["AD 410", "AD 395", "AD 529"]),
    ("history_biography", "medium",
     "In which year was Napoleon finally defeated at the Battle of Waterloo?",
     "1815", ["1805", "1812", "1821"]),
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
    """Rotate each option list so the correct letter is spread evenly over A-D."""
    for i, row in enumerate(rows):
        target = i % 4
        current = row["options"].index(row["correct"])
        shift = (current - target) % 4
        row["options"] = row["options"][shift:] + row["options"][:shift]


def render(row: dict, index: int) -> dict:
    options = row["options"]
    rendered = "\n".join(f"{LETTERS[i]}. {opt}" for i, opt in enumerate(options))
    return {
        "id": f"know2-{index:04d}",
        "category": row["category"],
        "difficulty": row["difficulty"],
        "prompt": f"{row['question']}\n\n{rendered}\n\n{TAIL}",
        "answer": LETTERS[options.index(row["correct"])],
        "scorer": "mc",
        "choices": options,
    }


def table_items(rng, table, count, category, difficulty, question):
    """`count` MC items drawn from a fact table, with distractors from the same table."""
    keys = sorted(table)
    rng.shuffle(keys)
    out = []
    for key in keys[:count]:
        correct = table[key]
        # distinct *values*: several keys can share a value (two Saturn moons, two
        # Baroque composers), so a naive pool would offer the right answer twice
        pool = sorted({table[k] for k in keys} - {correct})
        out.append(
            mc_row(rng, category, difficulty, question.format(key=key), correct,
                   rng.sample(pool, 3))
        )
    return out


def nearest_number_items(rng, table, count, category, difficulty, question):
    """Like `table_items` for numeric values, but the distractors are the three
    numerically nearest values in the table — iron (26) is offered next to
    manganese (25) and nickel (28), not next to uranium (92)."""
    keys = sorted(table)
    rng.shuffle(keys)
    out = []
    for key in keys[:count]:
        correct = table[key]
        others = sorted({v for v in table.values()} - {correct},
                        key=lambda v: (abs(int(v) - int(correct)), int(v)))
        out.append(
            mc_row(rng, category, difficulty, question.format(key=key), correct, others[:3])
        )
    return out


def main() -> None:
    rng = random.Random(SEED)
    rows: list[dict] = []

    # physics
    rows += table_items(rng, SI_DECOMPOSITIONS, 8, "physics", "hard",
                        "Expressed entirely in SI base units, one {key} is equal to one of "
                        "the following. Which?")
    rows += table_items(rng, UNIT_QUANTITY, 8, "physics", "medium",
                        "What physical quantity is the {key} a unit of?")
    rows += table_items(rng, PARTICLES, 6, "physics", "medium",
                        "In particle physics, the {key} is classified as which of the "
                        "following?")

    # chemistry
    rows += nearest_number_items(rng, ATOMIC_NUMBERS, 8, "chemistry", "hard",
                                 "What is the atomic number of {key}?")
    for name, formula, wrong in COMPOUND_FORMULAS:
        rows.append(mc_row(rng, "chemistry", "medium",
                           f"What is the chemical formula of {name}?", formula, wrong))
    rows += table_items(rng, POLYATOMIC_IONS, 6, "chemistry", "hard",
                        "What is the formula, including its charge, of the {key} ion?")

    # biology
    rows += table_items(rng, ORGANELLES, 8, "biology", "medium",
                        "What is the primary function of the {key}?")
    rows += table_items(rng, VITAMIN_DEFICIENCIES, 5, "biology", "medium",
                        "A dietary deficiency of vitamin {key} classically causes which "
                        "disease?")
    rows += table_items(rng, HORMONE_GLANDS, 6, "biology", "medium",
                        "Which gland or organ secretes {key}?")

    # astronomy
    rows += table_items(rng, MOONS, 10, "astronomy", "medium",
                        "{key} is a moon of which planet?")

    # geography
    rows += table_items(rng, CAPITALS, 8, "geography", "medium",
                        "What is the capital city of {key}?")
    rows += table_items(rng, STRAITS, 5, "geography", "medium",
                        "What does the {key} primarily separate?")
    rows += table_items(rng, RIVER_MOUTHS, 7, "geography", "hard",
                        "Into which body of water does the {key} flow?")
    rows += table_items(rng, LANDFORMS, 5, "geography", "medium",
                        "On which continent would you find the {key}?")

    # history & biography
    rows += table_items(rng, DISCOVERIES, 8, "history_biography", "medium",
                        "What is {key} best known for discovering or proposing?")
    rows += table_items(rng, CLASSIC_WORKS, 6, "history_biography", "medium",
                        "Who wrote {key}?")
    rows += table_items(rng, COMPOSER_ERAS, 4, "history_biography", "hard",
                        "With which musical era is {key} most associated?")
    rows += table_items(rng, EXPLORERS, 3, "history_biography", "medium",
                        "What is {key} famous for?")

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
            "Knowledge eval v2",
            f"{n} four-option multiple-choice questions on stable facts a tier deeper than "
            "eval-knowledge-v1, which strong models saturate: SI base-unit decompositions "
            "and second-tier units, particle classification, atomic numbers and compound "
            "and ion formulas, organelles, vitamins and hormones, planetary moons and "
            "stellar facts, harder capitals, straits, river mouths and landforms, and "
            "scientists, authors, composers and fixed dates.",
            rows,
            "gen_eval_knowledge_v2.py",
            "mc",
            seed=SEED,
            supersedes="eval-knowledge-v1",
            notes=[
                "Same exclusions as v1: nothing here depends on the current year, on an "
                "office-holder, or on a superlative that sources disagree about — a model "
                "must not be able to lose a point for being more up to date than the "
                "dataset.",
                "Every fact was hand-curated for stability and cross-checked; distractors "
                "are drawn from the same fact table as the answer (atomic numbers use the "
                "numerically nearest table values), so wrong options are plausible rather "
                "than absurd.",
                "Options are shuffled with the dataset seed, so the correct letter is "
                "spread evenly and is stable across regenerations.",
                "The mc scorer accepts the bare letter, 'A)', '(A)', 'A.' or the full text "
                "of the correct option.",
            ],
        ),
    )
    L.report(DATASET_ID, n)


if __name__ == "__main__":
    main()
