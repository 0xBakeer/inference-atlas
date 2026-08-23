# /// script
# requires-python = ">=3.11"
# dependencies = ["pillow>=11,<12"]
# ///
"""Generate `datasets/eval-vision-v1/`.

60 synthetic PNGs and the questions that go with them: counting and locating
coloured shapes, reading a bar chart, reading rendered text and numbers, finding a
filled cell in a grid, arrow directions, analogue clock faces and dice pips.

Nothing is photographed or downloaded — every pixel is drawn here with Pillow, and
every answer is the value that was used to draw the picture, so the key cannot
drift from the image.

Images are 320x320 or 360x360 flat-colour PNGs, a couple of kilobytes each; the
generator asserts that none exceeds 30 KB.

Run: `uv run datasets/_gen/gen_eval_vision.py`
"""

from __future__ import annotations

import math
import random
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, str(Path(__file__).resolve().parent))

import _lib as L  # noqa: E402

SEED = 20260907
DATASET_ID = "eval-vision-v1"
MAX_IMAGE_BYTES = 30 * 1024
SIZE = 320

WHITE = (255, 255, 255)
BLACK = (20, 20, 20)
COLOURS = {
    "red": (214, 48, 49),
    "blue": (9, 132, 227),
    "green": (0, 148, 90),
    "yellow": (253, 203, 40),
    "purple": (108, 92, 231),
    "orange": (230, 126, 34),
}
SHAPES = ("circle", "square", "triangle")
LETTERS = "ABCD"


def font(size: int) -> ImageFont.FreeTypeFont:
    """Pillow's bundled Aileron font — no system font lookup, so this is portable."""
    return ImageFont.load_default(size=size)


def centred_text(draw: ImageDraw.ImageDraw, xy, text, size, fill=BLACK):
    f = font(size)
    left, top, right, bottom = draw.textbbox((0, 0), text, font=f)
    draw.text((xy[0] - (right - left) / 2 - left, xy[1] - (bottom - top) / 2 - top), text,
              font=f, fill=fill)


def canvas(size: int = SIZE) -> tuple[Image.Image, ImageDraw.ImageDraw]:
    img = Image.new("RGB", (size, size), WHITE)
    return img, ImageDraw.Draw(img)


def draw_shape(draw, kind, box, colour):
    x0, y0, x1, y1 = box
    if kind == "circle":
        draw.ellipse(box, fill=colour)
    elif kind == "square":
        draw.rectangle(box, fill=colour)
    else:
        draw.polygon([(x0 + (x1 - x0) / 2, y0), (x0, y1), (x1, y1)], fill=colour)


def quadrant(cx, cy, size=SIZE):
    vertical = "top" if cy < size / 2 else "bottom"
    horizontal = "left" if cx < size / 2 else "right"
    return f"{vertical}-{horizontal}"


# --------------------------------------------------------------------------------------
# image families
# --------------------------------------------------------------------------------------


def f_shapes(rng, n):
    """Non-overlapping coloured shapes on a 3x3 lattice."""
    out = []
    for _ in range(n):
        img, draw = canvas()
        cells = [(c, r) for r in range(3) for c in range(3)]
        rng.shuffle(cells)
        count = rng.randint(3, 6)
        placed = []
        for col, row in cells[:count]:
            kind = rng.choice(SHAPES)
            colour_name = rng.choice(sorted(COLOURS))
            side = rng.choice([54, 66, 78])
            cx = 55 + col * 105
            cy = 55 + row * 105
            box = (cx - side / 2, cy - side / 2, cx + side / 2, cy + side / 2)
            draw_shape(draw, kind, box, COLOURS[colour_name])
            placed.append({"kind": kind, "colour": colour_name, "side": side, "cx": cx, "cy": cy})

        mode = rng.choice(["count_kind", "count_colour", "total", "largest_colour", "quadrant"])
        if mode == "count_kind":
            kind = rng.choice(SHAPES)
            question = f"How many {kind}s are in the image? Reply with the number only."
            answer, difficulty, scorer, choices = (
                str(sum(1 for p in placed if p["kind"] == kind)), "easy", "exact", None)
        elif mode == "count_colour":
            colour = rng.choice(sorted({p["colour"] for p in placed}))
            question = f"How many {colour} shapes are in the image? Reply with the number only."
            answer, difficulty, scorer, choices = (
                str(sum(1 for p in placed if p["colour"] == colour)), "easy", "exact", None)
        elif mode == "total":
            question = "How many shapes are in the image in total? Reply with the number only."
            answer, difficulty, scorer, choices = str(len(placed)), "easy", "exact", None
        elif mode == "largest_colour":
            biggest = max(placed, key=lambda p: (p["side"], -p["cy"], -p["cx"]))
            if sum(1 for p in placed if p["side"] == biggest["side"]) != 1:
                continue
            question = ("What colour is the largest shape in the image? Reply with the colour "
                        "name only.")
            answer, difficulty, scorer, choices = biggest["colour"], "medium", "exact", None
        else:
            target = rng.choice(placed)
            same = [p for p in placed if p["kind"] == target["kind"]]
            if len(same) != 1:
                continue
            question = (f"In which quarter of the image is the {target['kind']}? Answer with one "
                        f"of: top-left, top-right, bottom-left, bottom-right.")
            answer, difficulty, scorer, choices = (
                quadrant(target["cx"], target["cy"]), "medium", "exact", None)
        out.append((img, "shapes", difficulty, question, answer, scorer, choices,
                    {"shapes": placed}))
    return out


def f_chart(rng, n):
    out = []
    for _ in range(n):
        img, draw = canvas(360)
        count = rng.randint(4, 6)
        heights = rng.sample(range(40, 250, 14), count)
        labels = [chr(ord("A") + i) for i in range(count)]
        width = 300 // count
        base = 300
        for i, (label, h) in enumerate(zip(labels, heights)):
            x = 40 + i * width
            draw.rectangle((x, base - h, x + width - 14, base), fill=COLOURS["blue"])
            centred_text(draw, (x + (width - 14) / 2, base + 18), label, 20)
        draw.line((30, base, 340, base), fill=BLACK, width=3)

        mode = rng.choice(["tallest", "shortest", "taller_than", "difference"])
        pairs = dict(zip(labels, heights))
        if mode == "tallest":
            question = ("Which bar is the tallest? Reply with the letter of the bar only.")
            answer, difficulty, scorer = max(pairs, key=lambda k: pairs[k]), "easy", "exact"
        elif mode == "shortest":
            question = "Which bar is the shortest? Reply with the letter of the bar only."
            answer, difficulty, scorer = min(pairs, key=lambda k: pairs[k]), "easy", "exact"
        elif mode == "taller_than":
            pivot = rng.choice(labels)
            question = (f"How many bars are taller than bar {pivot}? Reply with the number only.")
            answer = str(sum(1 for k, v in pairs.items() if v > pairs[pivot]))
            difficulty, scorer = "medium", "exact"
        else:
            a, b = rng.sample(labels, 2)
            question = (f"Is bar {a} taller than bar {b}? Reply with yes or no only.")
            answer = "yes" if pairs[a] > pairs[b] else "no"
            difficulty, scorer = "easy", "exact"
        out.append((img, "chart", difficulty, question, answer, scorer, None,
                    {"bars": pairs}))
    return out


def f_ocr(rng, n):
    out = []
    words = ("HARBOUR", "LANTERN", "COMPASS", "TIMETABLE", "LEDGER", "PLATFORM", "KETTLE")
    for i in range(n):
        img, draw = canvas()
        kind = ("number", "code", "word")[i % 3]
        if kind == "number":
            text = str(rng.randint(1000, 999_999))
            question = "What number is written in the image? Reply with the digits only."
        elif kind == "code":
            text = f"{rng.choice('ABCDEFGHJKLMNPQRSTVWXYZ')}{rng.randint(10, 99)}-{rng.randint(1000, 9999)}"
            question = "What code is written in the image? Reply with the code exactly as shown."
        else:
            text = rng.choice(words)
            question = "Which word is written in the image? Reply with the word only."
        draw.rectangle((20, 120, SIZE - 20, SIZE - 120), outline=BLACK, width=3)
        centred_text(draw, (SIZE / 2, SIZE / 2), text, 44)
        out.append((img, "ocr", "easy" if kind != "code" else "medium", question, text,
                    "exact", None, {"text": text}))
    return out


def f_grid(rng, n):
    out = []
    for _ in range(n):
        img, draw = canvas()
        cells = rng.choice([4, 5])
        step = (SIZE - 40) / cells
        filled = [(rng.randrange(cells), rng.randrange(cells)) for _ in range(rng.randint(1, 4))]
        filled = sorted(set(filled))
        for col, row in filled:
            draw.rectangle((20 + col * step + 3, 20 + row * step + 3,
                            20 + (col + 1) * step - 3, 20 + (row + 1) * step - 3),
                           fill=COLOURS["purple"])
        for i in range(cells + 1):
            draw.line((20 + i * step, 20, 20 + i * step, SIZE - 20), fill=BLACK, width=2)
            draw.line((20, 20 + i * step, SIZE - 20, 20 + i * step), fill=BLACK, width=2)

        if len(filled) == 1 and rng.random() < 0.6:
            col, row = filled[0]
            question = (f"The grid has {cells} rows and {cells} columns. In which row is the "
                        f"filled square? Count rows from the top starting at 1 and reply with the "
                        f"number only.")
            answer, difficulty = str(row + 1), "medium"
        else:
            question = "How many squares in the grid are filled? Reply with the number only."
            answer, difficulty = str(len(filled)), "easy"
        out.append((img, "grid", difficulty, question, answer, "exact", None,
                    {"cells": cells, "filled": [list(f) for f in filled]}))
    return out


ARROWS = {
    "up": (0, -1), "down": (0, 1), "left": (-1, 0), "right": (1, 0),
}


def draw_arrow(draw, cx, cy, direction, length, colour):
    dx, dy = ARROWS[direction]
    x0, y0 = cx - dx * length / 2, cy - dy * length / 2
    x1, y1 = cx + dx * length / 2, cy + dy * length / 2
    draw.line((x0, y0, x1, y1), fill=colour, width=7)
    head = 16
    px, py = -dy, dx
    draw.polygon([(x1, y1),
                  (x1 - dx * head + px * head * 0.7, y1 - dy * head + py * head * 0.7),
                  (x1 - dx * head - px * head * 0.7, y1 - dy * head - py * head * 0.7)],
                 fill=colour)


def f_arrows(rng, n):
    out = []
    for i in range(n):
        img, draw = canvas()
        if i % 2 == 0:
            direction = rng.choice(sorted(ARROWS))
            draw_arrow(draw, SIZE / 2, SIZE / 2, direction, 190, COLOURS["red"])
            question = ("Which way does the arrow point? Answer with one word: up, down, left or "
                        "right.")
            out.append((img, "arrows", "easy", question, direction, "exact", None,
                        {"direction": direction}))
        else:
            directions = [rng.choice(sorted(ARROWS)) for _ in range(4)]
            for k, direction in enumerate(directions):
                cx = 90 + (k % 2) * 145
                cy = 90 + (k // 2) * 145
                draw_arrow(draw, cx, cy, direction, 90, COLOURS["blue"])
            target = rng.choice(sorted(set(directions)))
            question = (f"How many arrows point {target}? Reply with the number only.")
            out.append((img, "arrows", "medium", question,
                        str(directions.count(target)), "exact", None,
                        {"directions": directions}))
    return out


def f_clock(rng, n):
    out = []
    for _ in range(n):
        img, draw = canvas()
        hour = rng.randint(1, 12)
        minute = rng.choice([0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55])
        cx = cy = SIZE / 2
        radius = 130
        draw.ellipse((cx - radius, cy - radius, cx + radius, cy + radius), outline=BLACK, width=4)
        for tick in range(12):
            angle = math.radians(tick * 30 - 90)
            inner = radius - (18 if tick % 3 == 0 else 10)
            draw.line((cx + math.cos(angle) * inner, cy + math.sin(angle) * inner,
                       cx + math.cos(angle) * (radius - 4), cy + math.sin(angle) * (radius - 4)),
                      fill=BLACK, width=4 if tick % 3 == 0 else 2)
        minute_angle = math.radians(minute * 6 - 90)
        hour_angle = math.radians((hour % 12) * 30 + minute * 0.5 - 90)
        draw.line((cx, cy, cx + math.cos(hour_angle) * 70, cy + math.sin(hour_angle) * 70),
                  fill=BLACK, width=8)
        draw.line((cx, cy, cx + math.cos(minute_angle) * 108, cy + math.sin(minute_angle) * 108),
                  fill=COLOURS["red"], width=5)
        draw.ellipse((cx - 7, cy - 7, cx + 7, cy + 7), fill=BLACK)
        question = ("What time does this clock show? The short black hand is the hour hand and the "
                    "long red hand is the minute hand. Reply in the form H:MM, for example 4:05, "
                    "and nothing else.")
        out.append((img, "clock", "hard", question, f"{hour}:{minute:02d}", "exact", None,
                    {"hour": hour, "minute": minute}))
    return out


PIPS = {
    1: [(0.5, 0.5)],
    2: [(0.28, 0.28), (0.72, 0.72)],
    3: [(0.28, 0.28), (0.5, 0.5), (0.72, 0.72)],
    4: [(0.28, 0.28), (0.72, 0.28), (0.28, 0.72), (0.72, 0.72)],
    5: [(0.28, 0.28), (0.72, 0.28), (0.5, 0.5), (0.28, 0.72), (0.72, 0.72)],
    6: [(0.28, 0.25), (0.72, 0.25), (0.28, 0.5), (0.72, 0.5), (0.28, 0.75), (0.72, 0.75)],
}


def draw_die(draw, x, y, side, value):
    draw.rounded_rectangle((x, y, x + side, y + side), radius=14, fill=WHITE, outline=BLACK,
                           width=4)
    r = side * 0.075
    for fx, fy in PIPS[value]:
        cx, cy = x + fx * side, y + fy * side
        draw.ellipse((cx - r, cy - r, cx + r, cy + r), fill=BLACK)


def f_dice(rng, n):
    out = []
    for i in range(n):
        img, draw = canvas()
        count = rng.choice([2, 3])
        values = [rng.randint(1, 6) for _ in range(count)]
        side = 110 if count == 2 else 88
        gap = (SIZE - count * side) / (count + 1)
        for k, value in enumerate(values):
            draw_die(draw, gap + k * (side + gap), (SIZE - side) / 2, side, value)
        if i % 2 == 0:
            question = "What is the total number of pips on all the dice? Reply with the number only."
            answer, difficulty = str(sum(values)), "medium"
        else:
            question = ("How many pips are on the leftmost die? Reply with the number only.")
            answer, difficulty = str(values[0]), "easy"
        out.append((img, "dice", difficulty, question, answer, "exact", None, {"values": values}))
    return out


PLAN = ((f_shapes, 12), (f_chart, 10), (f_ocr, 10), (f_grid, 6), (f_arrows, 8),
        (f_clock, 8), (f_dice, 6))


def main() -> None:
    rng = random.Random(SEED)
    d = L.dataset_dir(DATASET_ID)
    images_dir = d / "images"
    images_dir.mkdir(exist_ok=True)
    for old in images_dir.glob("*.png"):
        old.unlink()

    produced: list[tuple] = []
    for family, count in PLAN:
        made = family(rng, count)
        while len(made) < count:  # families skip ambiguous draws
            made += family(rng, count - len(made))
        produced += made[:count]

    rows: list[dict] = []
    for img, category, difficulty, question, answer, scorer, choices, meta in produced:
        item_id = f"vis-{len(rows) + 1:04d}"
        path = images_dir / f"{item_id}.png"
        img.save(path, format="PNG", optimize=True)
        size = path.stat().st_size
        if size > MAX_IMAGE_BYTES:
            raise SystemExit(f"{path.name} is {size} bytes, over the {MAX_IMAGE_BYTES} limit")
        row = {
            "id": item_id,
            "category": category,
            "difficulty": difficulty,
            "prompt": question,
            "answer": answer,
            "scorer": scorer,
            "image": f"images/{item_id}.png",
            "meta": {"image_bytes": size, "ground_truth": meta},
        }
        if choices:
            row["choices"] = choices
        rows.append(row)

    n = L.write_jsonl(d / "items.jsonl", rows)
    total_bytes = sum(r["meta"]["image_bytes"] for r in rows)
    L.write_json(
        d / "dataset.json",
        L.eval_dataset_json(
            DATASET_ID,
            "Vision eval v1",
            "60 synthetic images with questions: counting and locating coloured shapes, reading a "
            "bar chart, reading rendered words, numbers and codes, counting filled cells in a "
            "grid, arrow directions, analogue clock faces and dice pips. Every image is drawn by "
            "the generator, so the answer is the value the picture was drawn from.",
            rows,
            "gen_eval_vision.py",
            "exact",
            files=["items.jsonl", "images/"],
            seed=SEED,
            images={
                "dir": "images",
                "format": "PNG",
                "sizes_px": [320, 360],
                "count": len(rows),
                "total_bytes": total_bytes,
                "max_bytes": MAX_IMAGE_BYTES,
            },
            notes=[
                "The harness attaches the image as a base64 data URL in an OpenAI-style "
                "image_url content part, together with `prompt` as the text part.",
                "meta.ground_truth records what was drawn (shape list, bar heights, clock hands, "
                "dice values). It is for debugging a disagreement, not for scoring.",
                "Answers are short and pinned by the prompt (a number, a colour word, a letter, a "
                "compass word, yes/no, or H:MM), which is what makes the exact scorer fair.",
                "A text-only model will score near zero here; that is the point. Record it as a "
                "real result rather than skipping the workload, since some engines silently drop "
                "image parts instead of failing.",
                "Fonts come from Pillow's bundled default face, so regeneration does not depend "
                "on system fonts. The committed PNGs are authoritative.",
            ],
        ),
    )
    L.report(DATASET_ID, n)


if __name__ == "__main__":
    main()
