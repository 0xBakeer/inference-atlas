# /// script
# requires-python = ">=3.11"
# dependencies = ["pillow>=11,<12"]
# ///
"""Generate the five text-to-image datasets.

One case table, five datasets, because a case is asked four different questions and an
eval row carries exactly one scorer:

  * `t2i-prompts-v1`      — prompts and reference images for the latency workloads
  * `eval-t2i-text-v1`    — does the text in the picture say what it was asked to say
  * `eval-t2i-adherence-v1` — does the picture show what was asked for
  * `eval-t2i-rgba-v1`    — is the transparent background really transparent
  * `eval-t2i-fidelity-v1` — how far a quantized lane drifts from a bf16 reference

The 24 cases keep one id across all four suites (`t2i-0007` is the same picture
everywhere), so a text score and a fidelity score can be put next to each other per case.

Nothing here is drawn at random and nothing is downloaded. The reference images the edit
cases condition on are drawn from primitives with Pillow, which keeps the corpus MIT and
free of anyone else's photographs, and has the useful side effect that drift in an edited
subject is obvious against flat colour in a way it never is against photographic texture.
Regeneration is byte-identical; `bench/tests/test_t2i_dataset.py` asserts it.

**No generated image is committed here, and none ever should be.** The reference images are
inputs drawn by this script; the pictures a model makes are not data (datasets/README.md,
SPEC §0.6). That is what shapes the fidelity suite: it publishes numbers and perceptual
hashes computed against a reference run on the contributor's own box, never its pixels.

Run: `uv run datasets/_gen/gen_t2i.py`
"""

from __future__ import annotations

import sys
from dataclasses import dataclass, field
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

sys.path.insert(0, str(Path(__file__).resolve().parent))

import _lib as L  # noqa: E402

REF_SIZE = 512
MAX_IMAGE_BYTES = 30 * 1024
CREATED = "2026-09-20"

#: Native sizes the checkpoint publishes, used verbatim by the 2K cases.
NATIVE_2K_SQUARE = (2048, 2048)
NATIVE_2K_16_9 = (2752, 1536)
#: The pipeline's own 1K resolution for 9:16 (area 1024², both sides a multiple of 32).
ONE_K_9_16 = (768, 1376)

STEPS = 40


@dataclass
class Case:
    """One frozen case. `prompt` is sent; `short` is the text a CLIP encoder sees."""

    id: str
    category: str
    difficulty: str
    short: str
    prompt: str
    seed: int
    width: int = 1024
    height: int = 1024
    transparent: bool = False
    refs: tuple[str, ...] = ()
    text: tuple[str, ...] = ()
    components: int | None = None
    notes: str = ""

    @property
    def render(self) -> dict:
        """The part of the case that must be identical for two images to be comparable."""
        spec = {
            "width": self.width,
            "height": self.height,
            "steps": STEPS,
            "seed": self.seed,
            "transparent": self.transparent,
        }
        if self.refs:
            spec["reference_images"] = [f"images/{name}" for name in self.refs]
        return spec


# --------------------------------------------------------------------------------------
# reference images — flat geometry, no fonts, no noise, deterministic
# --------------------------------------------------------------------------------------


def _mascot(scale: int = 4) -> Image.Image:
    """The mascot on transparent: drawn 4x and downsampled, so the edges are clean."""
    s = scale
    img = Image.new("RGBA", (REF_SIZE * s, REF_SIZE * s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    fur, dark, cream, ink = (236, 126, 66, 255), (214, 96, 52, 255), (247, 216, 190, 255), (43, 40, 48, 255)
    d.ellipse((165 * s, 105 * s, 225 * s, 200 * s), fill=dark)      # ears
    d.ellipse((287 * s, 105 * s, 347 * s, 200 * s), fill=dark)
    d.ellipse((150 * s, 165 * s, 362 * s, 390 * s), fill=fur)       # head
    d.ellipse((186 * s, 125 * s, 212 * s, 180 * s), fill=cream)     # ear inner
    d.ellipse((300 * s, 125 * s, 326 * s, 180 * s), fill=cream)
    d.ellipse((196 * s, 280 * s, 316 * s, 380 * s), fill=cream)     # muzzle
    d.ellipse((199 * s, 226 * s, 229 * s, 256 * s), fill=ink)       # eyes
    d.ellipse((283 * s, 226 * s, 313 * s, 256 * s), fill=ink)
    d.ellipse((209 * s, 231 * s, 219 * s, 241 * s), fill=(255, 255, 255, 255))
    d.ellipse((293 * s, 231 * s, 303 * s, 241 * s), fill=(255, 255, 255, 255))
    d.ellipse((241 * s, 293 * s, 271 * s, 316 * s), fill=ink)       # nose
    d.arc((226 * s, 306 * s, 256 * s, 336 * s), 0, 180, fill=ink, width=3 * s)
    d.arc((256 * s, 306 * s, 286 * s, 336 * s), 0, 180, fill=ink, width=3 * s)
    d.polygon([(150 * s, 350 * s), (90 * s, 430 * s), (180 * s, 406 * s)], fill=dark)  # tail
    return img.resize((REF_SIZE, REF_SIZE), Image.LANCZOS)


def mascot_rgba() -> Image.Image:
    return _mascot()


def mascot_scene() -> Image.Image:
    """The mascot over a flat outdoor background: the input of both edit-with-one-ref cases."""
    bg = Image.new("RGB", (REF_SIZE, REF_SIZE), (150, 192, 220))
    d = ImageDraw.Draw(bg)
    d.rectangle((0, 300, REF_SIZE, REF_SIZE), fill=(122, 156, 104))     # ground
    d.ellipse((-100, 250, 210, 400), fill=(96, 132, 92))                # hills
    d.ellipse((310, 268, 620, 410), fill=(86, 122, 84))
    d.ellipse((380, 60, 450, 130), fill=(250, 238, 192))                # sun
    shadow = Image.new("L", (REF_SIZE, REF_SIZE), 0)
    ImageDraw.Draw(shadow).ellipse((160, 360, 360, 410), fill=110)
    bg = Image.composite(Image.new("RGB", (REF_SIZE, REF_SIZE), (70, 96, 70)),
                         bg, shadow.filter(ImageFilter.GaussianBlur(9)))
    mascot = _mascot()
    bg.paste(mascot, (0, -20), mascot.getchannel("A"))
    return bg


def product_flat() -> Image.Image:
    """A flat product shot: one bottle, one label, one soft shadow."""
    img = Image.new("RGB", (REF_SIZE, REF_SIZE), (238, 236, 231))
    d = ImageDraw.Draw(img)
    d.rectangle((0, 350, REF_SIZE, REF_SIZE), fill=(226, 222, 214))
    shadow = Image.new("L", (REF_SIZE, REF_SIZE), 0)
    ImageDraw.Draw(shadow).ellipse((165, 350, 380, 395), fill=120)
    img = Image.composite(Image.new("RGB", (REF_SIZE, REF_SIZE), (176, 172, 166)),
                          img, shadow.filter(ImageFilter.GaussianBlur(8)))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((190, 150, 322, 372), radius=17, fill=(62, 104, 96))    # body
    d.rectangle((235, 95, 277, 160), fill=(62, 104, 96))                        # neck
    d.rounded_rectangle((228, 75, 284, 106), radius=7, fill=(206, 168, 92))     # cap
    d.rectangle((190, 215, 322, 300), fill=(240, 238, 230))                     # label
    d.rectangle((203, 235, 309, 243), fill=(62, 104, 96))
    d.rectangle((203, 256, 280, 262), fill=(150, 150, 146))
    d.rectangle((203, 274, 250, 280), fill=(150, 150, 146))
    d.rounded_rectangle((199, 160, 214, 360), radius=7, fill=(104, 148, 138))   # highlight
    return img


def text_plate() -> Image.Image:
    """A blank enamel street plate: the surface the add-text edit writes on."""
    img = Image.new("RGB", (REF_SIZE, REF_SIZE), (197, 190, 180))
    shadow = Image.new("L", (REF_SIZE, REF_SIZE), 0)
    ImageDraw.Draw(shadow).rounded_rectangle((94, 196, 426, 332), radius=9, fill=130)
    img = Image.composite(Image.new("RGB", (REF_SIZE, REF_SIZE), (120, 116, 110)),
                          img, shadow.filter(ImageFilter.GaussianBlur(5)))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((90, 190, 422, 326), radius=8, fill=(28, 62, 122))
    d.rounded_rectangle((102, 202, 410, 314), radius=4, outline=(245, 245, 240), width=5)
    for x, y in ((114, 214), (398, 214), (114, 302), (398, 302)):
        d.ellipse((x - 6, y - 6, x + 6, y + 6), fill=(228, 228, 224))
    return img


def pattern_swatch() -> Image.Image:
    """A tileable pattern: the second reference of the compose case."""
    img = Image.new("RGB", (REF_SIZE, REF_SIZE), (246, 240, 228))
    d = ImageDraw.Draw(img)
    step = 64
    for i in range(-REF_SIZE // step, 2 * REF_SIZE // step):
        d.line((i * step, 0, i * step + REF_SIZE, REF_SIZE), fill=(214, 198, 166), width=13)
    for row in range(0, REF_SIZE + step, step):
        for col in range(0, REF_SIZE + step, step):
            cx = col + (step // 2 if (row // step) % 2 else 0)
            d.ellipse((cx - 9, row - 9, cx + 9, row + 9), fill=(178, 92, 74))
            d.ellipse((cx - 4, row - 4, cx + 4, row + 4), fill=(246, 240, 228))
    return img


REFERENCES = {
    "mascot_rgba.png": mascot_rgba,
    "mascot_scene.png": mascot_scene,
    "pattern_swatch.png": pattern_swatch,
    "product_flat.png": product_flat,
    "text_plate.png": text_plate,
}


# --------------------------------------------------------------------------------------
# the case table — frozen; a change here is a new -v2 dataset, never an edit
# --------------------------------------------------------------------------------------

CASES: list[Case] = [
    # ---------------------------------------------------------------- text rendering (6)
    Case(
        id="t2i-0001", category="text", difficulty="easy", seed=110001,
        short="a bakery sign reading GOLDEN CRUMB BAKERY with OPEN 7 AM TO 6 PM below it",
        prompt=(
            "A photograph of a small corner bakery at street level on an overcast morning. "
            "Above the window hangs a painted wooden sign with large cream serif letters "
            'reading "GOLDEN CRUMB BAKERY", and directly beneath it a smaller brass plate '
            'reads "OPEN 7 AM TO 6 PM". Warm light from inside, wet cobblestones, shallow '
            "depth of field."
        ),
        text=("GOLDEN CRUMB BAKERY", "OPEN 7 AM TO 6 PM"),
        notes="Two text blocks at different scales; the small one degrades first.",
    ),
    Case(
        id="t2i-0002", category="text", difficulty="easy", seed=110002,
        width=NATIVE_2K_SQUARE[0], height=NATIVE_2K_SQUARE[1],
        short="an exhibition poster titled NORTHERN LIGHTS dated SEPTEMBER 14 in HALL B",
        prompt=(
            "A minimalist exhibition poster, flat vector style on a deep indigo background. "
            'Centred in large condensed white uppercase type: "NORTHERN LIGHTS". Below it, in '
            'a thin line of smaller type: "SEPTEMBER 14". In the bottom right corner, small '
            'and set in a box: "HALL B". Generous margins, one thin horizontal rule, no other '
            "decoration."
        ),
        text=("NORTHERN LIGHTS", "SEPTEMBER 14", "HALL B"),
        notes="Native 2K square. Large flat type: a good lane should be near perfect here.",
    ),
    Case(
        id="t2i-0003", category="text", difficulty="medium", seed=110003,
        short="a cafe chalkboard menu listing ESPRESSO 2.50, FLAT WHITE 3.80 and CROISSANT 2.20",
        prompt=(
            "A close photograph of a black chalkboard menu leaning against a cafe wall, "
            "hand-lettered in white chalk. Three lines, left aligned, evenly spaced: "
            '"ESPRESSO 2.50", "FLAT WHITE 3.80", "CROISSANT 2.20". Slight chalk dust, soft '
            "diffuse daylight from the left."
        ),
        text=("ESPRESSO 2.50", "FLAT WHITE 3.80", "CROISSANT 2.20"),
        notes="Digits and decimal points on three lines; prices must stay with their items.",
    ),
    Case(
        id="t2i-0004", category="text", difficulty="medium", seed=110004,
        short="a phone app screen headed Weekly Report showing 4208 steps and a Continue button",
        prompt=(
            "A clean mobile app screenshot on a light grey background, rendered as a flat UI "
            'mockup. At the top a bold heading reads "Weekly Report". In the middle, a large '
            'number "4208" with the word "steps" underneath it. At the bottom, a full-width '
            'rounded blue button with white centred text reading "Continue". Generous white '
            "space, rounded cards, no photographic texture."
        ),
        text=("Weekly Report", "4208", "Continue"),
        notes="Mixed case plus a four-digit number; UI mocks expose letterform drift.",
    ),
    Case(
        id="t2i-0005", category="text", difficulty="hard", seed=110005,
        short="a bilingual cafe door sign reading 欢迎光临 above WELCOME FRIENDS",
        prompt=(
            "A photograph of a glass cafe door seen from the street. A vinyl decal on the "
            'glass shows large red Chinese characters "欢迎光临" on the upper line, and '
            'directly below them, in smaller black uppercase Latin letters, "WELCOME FRIENDS". '
            "Reflections of the street in the glass, evening light."
        ),
        text=("欢迎光临", "WELCOME FRIENDS"),
        notes=(
            "CJK and Latin in one image. OCR backends differ here: tesseract needs the chi_sim "
            "pack, rapidocr and easyocr ship Chinese models. The two strings score separately."
        ),
    ),
    Case(
        id="t2i-0006", category="text", difficulty="hard", seed=110006,
        short="a handwritten paper note reading Meet me at Pier 9 at dusk",
        prompt=(
            "A top-down photograph of a torn page of cream notepaper on a dark walnut desk, a "
            "fountain pen beside it. On the paper, in neat looping blue ink handwriting: "
            '"Meet me at Pier 9 at dusk". Raking window light, visible paper fibre, shallow '
            "depth of field."
        ),
        notes=(
            "The hardest text case, and deliberately not in the OCR suite: handwriting defeats "
            "OCR often enough that the score would measure the backend, not the lane."
        ),
    ),
    # ---------------------------------------------------------------- people (4)
    Case(
        id="t2i-0007", category="portrait", difficulty="easy", seed=120001,
        short="a portrait of a woman beside a window in soft directional light",
        prompt=(
            "A medium close-up portrait of a woman in her thirties standing beside a tall "
            "window, turned three-quarters toward the camera. Soft directional daylight falls "
            "across one side of her face and leaves the other in gentle shadow, with a faint "
            "rim of light on her hair and shoulder. Natural skin texture, calm expression, "
            "muted interior behind her, 85mm look."
        ),
        notes="The falloff across the face is where aggressive quantization shows first.",
    ),
    Case(
        id="t2i-0008", category="portrait", difficulty="hard", seed=120002,
        short="a person holding a ceramic cup with both hands, all ten fingers visible",
        prompt=(
            "A close photograph of a seated person cradling a stoneware cup with both hands at "
            "chest height, fingers wrapped around the cup and clearly separated, thumbs resting "
            "on the rim. Both hands fully in frame and in focus. Steam rising, soft overcast "
            "light from a window, knitted sleeve texture."
        ),
        notes="Hands and finger count. Judged by eye; no metric here catches a sixth finger.",
    ),
    Case(
        id="t2i-0009", category="portrait", difficulty="medium", seed=120003,
        short="two people talking outdoors, strongly backlit by a low sun",
        prompt=(
            "Two friends standing face to face on a grass field in late afternoon, photographed "
            "against a low sun so that both are strongly backlit, with bright rim light on hair "
            "and shoulders and their faces held in open shade. Visible lens flare, haze in the "
            "air, long shadows toward the camera, faces still readable and correctly exposed."
        ),
        notes="High dynamic range plus two faces; watch for crushed shadows in low-bit lanes.",
    ),
    Case(
        id="t2i-0010", category="portrait", difficulty="medium", seed=120004,
        short="a studio headshot on a grey backdrop with visible skin texture and catchlights",
        prompt=(
            "A tightly cropped studio headshot of an older man against a seamless mid-grey "
            "backdrop, lit by a large softbox slightly above and to the left with a subtle fill "
            "from the right. Fine skin texture, individual eyebrow and stubble hairs resolved, "
            "a single rectangular catchlight in each eye, neutral colour, sharp focus on the "
            "near eye."
        ),
        notes="Fine high-frequency detail: LPIPS moves here long before PSNR does.",
    ),
    # ---------------------------------------------------------------- products (4)
    Case(
        id="t2i-0011", category="product", difficulty="medium", seed=130001,
        short="a clear glass bottle on polished marble with refraction and a soft shadow",
        prompt=(
            "A product photograph of an unlabelled clear glass bottle standing upright, centred, "
            "on a slab of white polished marble. Lit by one large softbox from behind and to the "
            "right, so the glass carries a long vertical highlight and refracts the marble "
            "veining through its body. A soft contact shadow pools to the left. Dark grey "
            "seamless background, nothing else in frame."
        ),
        notes="Transparency, refraction and a clean specular highlight: a quantization canary.",
    ),
    Case(
        id="t2i-0012", category="product", difficulty="medium", seed=130002,
        short="a macro shot of a steel watch with a brown leather strap on slate",
        prompt=(
            "A macro product photograph of a wristwatch lying at a slight angle on dark slate. "
            "The case is brushed stainless steel with a polished bezel, the strap is tan "
            "full-grain leather with visible pores and stitching. Raking light picks out the "
            "brush marks on the steel and the grain of the leather. Very shallow depth of "
            "field, the crown in sharp focus."
        ),
        notes="Two competing materials, metal and leather, at macro scale.",
    ),
    Case(
        id="t2i-0013", category="product", difficulty="easy", seed=130003,
        short="three matte ceramic bowls stacked centred on a linen cloth, nothing else in frame",
        prompt=(
            "A still life of exactly three matte glazed ceramic bowls stacked one inside the "
            "other, placed dead centre on a crumpled oatmeal linen cloth. The bowls are sage "
            "green, cream and terracotta from bottom to top. Even diffuse light from above, "
            "soft shadows, plain warm white background, no other objects in the frame."
        ),
        notes="Counting and an explicit colour order: easy to check by eye, hard for weak lanes.",
    ),
    Case(
        id="t2i-0014", category="product", difficulty="hard", seed=130004,
        short="a top-down flat lay of four objects in a two by two grid on folded linen",
        prompt=(
            "A top-down flat lay photographed straight down onto a sheet of folded grey-blue "
            "linen with a visible weave. Four objects are arranged in an even two by two grid "
            "with equal spacing: a brass key in the upper left, a pair of round tortoiseshell "
            "glasses in the upper right, a small amber glass jar in the lower left, and a sprig "
            "of rosemary in the lower right. Soft window light from the top of the frame, "
            "gentle shadows."
        ),
        notes="A spatial layout constraint: composition adherence rather than texture.",
    ),
    # ---------------------------------------------------------------- scenes (3)
    Case(
        id="t2i-0015", category="scene", difficulty="easy", seed=140001,
        width=NATIVE_2K_16_9[0], height=NATIVE_2K_16_9[1],
        short="a wide coastal cliff at sunrise with sea mist in the bays",
        prompt=(
            "A wide landscape photograph of a green headland of sea cliffs at sunrise, shot from "
            "a neighbouring clifftop. Low mist sits in the bays below, the sea is calm and "
            "catching warm light, and a narrow path runs along the cliff edge into the distance. "
            "High detail in the grass and rock, gentle golden light, clear sky graduating from "
            "orange to pale blue."
        ),
        notes=(
            "Native 2K 16:9, one of the sizes the checkpoint publishes. The heavy case for "
            "latency and the one where peak memory is worth watching."
        ),
    ),
    Case(
        id="t2i-0016", category="scene", difficulty="medium", seed=140002,
        width=ONE_K_9_16[0], height=ONE_K_9_16[1],
        short="a narrow rainy alley at night in vertical framing with neon reflections",
        prompt=(
            "A tall vertical photograph looking down a narrow alley at night after rain. Neon "
            "shop signs in magenta and cyan line both walls and reflect in the wet cobblestones, "
            "steam drifts from a vent, and a single figure with an umbrella walks away from the "
            "camera into the depth of the frame. Deep shadows, saturated colour, cinematic."
        ),
        notes="9:16 at the pipeline's 1K resolution for that ratio; checks non-square handling.",
    ),
    Case(
        id="t2i-0017", category="scene", difficulty="hard", seed=140003,
        short="layered mountain ridges in fog with soft tonal separation",
        prompt=(
            "A quiet landscape photograph of four receding ridges of forested mountains "
            "separated by bands of fog, each ridge paler than the one in front of it. Flat "
            "overcast light, almost monochrome blue-grey, fine pine texture on the nearest "
            "ridge, no sky detail."
        ),
        notes=(
            "Low contrast and smooth gradients: where banding from low-bit weights is most "
            "visible and where PSNR is most sensitive."
        ),
    ),
    # ---------------------------------------------------------------- transparent (3)
    Case(
        id="t2i-0018", category="rgba", difficulty="easy", seed=150001, transparent=True,
        short="a die-cut sticker of a sitting fox on a transparent background",
        prompt=(
            "A die-cut vinyl sticker of a stylised sitting fox, flat illustration with clean "
            "bold outlines and a thin white sticker border following the silhouette. The fox is "
            "orange and cream with a dark nose. The background is fully transparent, nothing "
            "behind the subject, no shadow, no backdrop."
        ),
        components=1,
        notes="One compact subject: the connected-component check should find exactly one.",
    ),
    Case(
        id="t2i-0019", category="rgba", difficulty="medium", seed=150002, transparent=True,
        short="a sticker of a takeaway coffee cup with steam on a transparent background",
        prompt=(
            "A die-cut sticker illustration of a takeaway coffee cup with a lid and a cardboard "
            "sleeve, with three curls of steam rising above it. Flat colour with a heavy "
            "outline, warm browns and cream. The background is fully transparent, with no card, "
            "no shadow and no rectangle behind the artwork."
        ),
        components=4,
        notes=(
            "The steam curls are genuinely separate from the cup, so several components are "
            "expected; the threshold is higher here rather than the check being skipped."
        ),
    ),
    Case(
        id="t2i-0020", category="rgba", difficulty="medium", seed=150003, transparent=True,
        short="a soft shaded icon of a potted monstera on a transparent background",
        prompt=(
            "A single app-icon style illustration of a monstera plant in a terracotta pot, "
            "softly shaded with smooth gradients and a subtle ambient occlusion where the "
            "leaves meet the pot. Centred with even margins. The background is fully "
            "transparent: no plate, no circle, no drop shadow behind the pot."
        ),
        components=2,
        notes="Soft gradients against transparency; watch for a grey halo in the alpha edge.",
    ),
    # ---------------------------------------------------------------- edits (4)
    Case(
        id="t2i-0021", category="edit", difficulty="easy", seed=160001,
        refs=("mascot_scene.png",),
        short="the same character on a night sky background",
        prompt=(
            "Keep the character in the reference image exactly as it is — same shape, same "
            "colours, same position and size in the frame — and replace only the background "
            "behind it with a deep blue night sky full of small stars. Do not restyle, recolour "
            "or move the character."
        ),
        notes=(
            "Subject preservation under an edit. The reference is flat colour on purpose, so "
            "drift in the subject is visible rather than hidden in texture."
        ),
    ),
    Case(
        id="t2i-0022", category="edit", difficulty="medium", seed=160002,
        refs=("text_plate.png",),
        short="a blue enamel street plate reading HARBOUR ROAD 12",
        prompt=(
            "Using the reference image of a blank blue enamel street plate with a white border, "
            'add the text "HARBOUR ROAD 12" centred on the plate in white uppercase letters in '
            "the classic enamel street-sign style. Keep the plate, its border, its colour and "
            "its position exactly as they are, and change nothing else in the image."
        ),
        text=("HARBOUR ROAD 12",),
        notes="Text rendering inside an edit, on a surface whose perspective is already given.",
    ),
    Case(
        id="t2i-0023", category="edit", difficulty="hard", seed=160003,
        refs=("product_flat.png", "pattern_swatch.png"),
        short="the bottle from the first image standing on a surface of the second image's pattern",
        prompt=(
            "Take the bottle from the first reference image and place it upright on a flat "
            "surface covered with the repeating pattern from the second reference image. Keep "
            "the bottle's shape, proportions and label colours unchanged, add a soft contact "
            "shadow where it meets the surface, and let the pattern recede naturally toward the "
            "back of the frame."
        ),
        notes=(
            "Two references in one request: the case that exposes an edit endpoint which "
            "silently keeps only the first `image` field."
        ),
    ),
    Case(
        id="t2i-0024", category="edit", difficulty="hard", seed=160004, transparent=True,
        refs=("mascot_scene.png",),
        short="the character from the reference image cut out on a transparent background",
        prompt=(
            "Extract only the character from the reference image and return it on a fully "
            "transparent background, with clean edges that follow the character's silhouette "
            "exactly. Keep the character's colours and proportions unchanged. Remove the "
            "background completely: no remnants of the old backdrop, no halo, no shadow."
        ),
        components=2,
        notes="RGBA out of an edit: both the transparency checks and the fidelity metrics apply.",
    ),
]

# --------------------------------------------------------------------------------------
# the latency prompt set — a shape is measured over a few prompts, not over the case set
# --------------------------------------------------------------------------------------


@dataclass
class PromptRow:
    id: str
    category: str
    short: str
    prompt: str
    refs: tuple[str, ...] = ()
    meta: dict = field(default_factory=dict)


SPEED_PROMPTS: list[PromptRow] = [
    PromptRow("spd-0001", "t2i", "a paper boat on a still lake at dawn",
              "A paper boat on a still lake at dawn, soft directional light, fine detail in "
              "the folds of the paper, mist on the far shore, muted colour."),
    PromptRow("spd-0002", "t2i", "a bowl of figs on a stone table",
              "A bowl of ripe figs on a rough stone table by a window, one fig cut open, warm "
              "side light, deep shadows, still-life photography."),
    PromptRow("spd-0003", "t2i", "a lighthouse on a rocky headland under cloud",
              "A white lighthouse on a rocky headland under heavy grey cloud, spray at the base "
              "of the rocks, cold flat light, wide landscape framing."),
    PromptRow("spd-0004", "t2i", "a cyclist on a wet city street at night",
              "A cyclist crossing a wet city street at night, headlights behind, reflections on "
              "the asphalt, motion in the wheels, cinematic colour."),
    PromptRow("spd-0005", "t2i", "a wooden workbench with hand tools",
              "A wooden workbench seen from above with a plane, a chisel and a folding rule laid "
              "out on it, shavings of wood around them, soft overhead daylight."),
    PromptRow("spd-0006", "t2i", "a greenhouse full of ferns in morning light",
              "The inside of a Victorian greenhouse full of ferns in morning light, condensation "
              "on the glass, dust in the sunbeams, deep green tones."),
    PromptRow("spd-0007", "edit-ref1", "the character on a night sky background",
              "Keep the character in the reference image exactly as it is and replace only the "
              "background behind it with a deep blue night sky full of small stars.",
              refs=("mascot_scene.png",)),
    PromptRow("spd-0008", "edit-ref1", "the bottle on a dark slate surface",
              "Keep the bottle from the reference image exactly as it is and replace the "
              "background and surface with dark wet slate under a single soft light.",
              refs=("product_flat.png",)),
    PromptRow("spd-0009", "edit-ref1", "the street plate photographed on a brick wall",
              "Keep the enamel plate from the reference image unchanged and place it on a red "
              "brick wall in late afternoon light, with a soft shadow under its lower edge.",
              refs=("text_plate.png",)),
    PromptRow("spd-0010", "edit-ref4", "a shelf holding all four reference objects",
              "Arrange the four objects from the reference images together on one wooden shelf: "
              "the character sitting on the left, the bottle standing beside it, the enamel "
              "plate leaning against the wall behind, and the patterned cloth folded under all "
              "of them. Keep each object's colours and proportions unchanged.",
              refs=("mascot_rgba.png", "product_flat.png", "text_plate.png",
                    "pattern_swatch.png")),
    PromptRow("spd-0011", "edit-ref4", "a flat lay of all four reference objects",
              "A top-down flat lay of the four objects from the reference images on the "
              "patterned cloth: the character in the upper left, the bottle in the upper right, "
              "the enamel plate across the bottom. Keep each object's colours and proportions "
              "unchanged, soft even light.",
              refs=("mascot_rgba.png", "product_flat.png", "text_plate.png",
                    "pattern_swatch.png")),
    PromptRow("spd-0012", "edit-ref4", "a shop window showing all four reference objects",
              "A shop window display holding the four objects from the reference images: the "
              "character and the bottle on a low plinth, the enamel plate mounted on the wall "
              "behind them, the patterned cloth draped beneath. Keep each object's colours and "
              "proportions unchanged, warm interior light.",
              refs=("mascot_rgba.png", "product_flat.png", "text_plate.png",
                    "pattern_swatch.png")),
]


# --------------------------------------------------------------------------------------
# writing
# --------------------------------------------------------------------------------------

NO_GENERATED_CONTENT = (
    "The reference images in this dataset are drawn by the generator. No model output is "
    "stored here or in any result file: an image a lane produced is not data (SPEC §0.6)."
)


def write_reference_images(directory: Path, names: list[str]) -> int:
    """Write the reference PNGs a dataset needs and return their total size."""
    images_dir = directory / "images"
    images_dir.mkdir(exist_ok=True)
    for old in images_dir.glob("*.png"):
        if old.name not in names:
            old.unlink()
    total = 0
    for name in sorted(names):
        path = images_dir / name
        REFERENCES[name]().save(path, format="PNG", optimize=True)
        size = path.stat().st_size
        if size > MAX_IMAGE_BYTES:
            raise SystemExit(f"{path.name} is {size} bytes, over the {MAX_IMAGE_BYTES} limit")
        total += size
    return total


def case_row(case: Case, scorer: str, answer) -> dict:
    """The part of a row every suite shares: what to render, and how."""
    row = {
        "id": case.id,
        "category": case.category,
        "difficulty": case.difficulty,
        "prompt": case.prompt,
        "answer": answer,
        "scorer": scorer,
        "meta": {
            "render": case.render,
            "short_prompt": case.short,
            "render_digest": L.render_digest(case.prompt, case.render),
            "notes": case.notes,
        },
    }
    if case.refs:
        row["meta"]["reference_images"] = [f"images/{name}" for name in case.refs]
    return row


def image_dataset(dataset_id: str, name: str, description: str, rows: list[dict],
                  default_scorer: str, images: list[str], notes: list[str],
                  suite_extra: dict | None = None) -> None:
    """Write one eval dataset: rows, reference images, dataset.json."""
    directory = L.dataset_dir(dataset_id)
    extra = dict(suite_extra or {})
    if images:
        total_bytes = write_reference_images(directory, images)
        extra["images"] = {"dir": "images", "format": "PNG", "sizes_px": [REF_SIZE],
                           "count": len(images), "total_bytes": total_bytes,
                           "max_bytes": MAX_IMAGE_BYTES}
    count = L.write_jsonl(directory / "items.jsonl", rows)
    L.write_json(
        directory / "dataset.json",
        L.eval_dataset_json(
            dataset_id, name, description, rows, "gen_t2i.py", default_scorer,
            files=["items.jsonl"] + (["images/"] if images else []),
            created=CREATED,
            render={
                "sizes_px": sorted({(r["meta"]["render"]["width"], r["meta"]["render"]["height"])
                                    for r in rows}),
                "steps": STEPS,
                "note": "Every row carries its own meta.render. Two images are only comparable "
                        "when prompt, size, steps and seed are identical, which is what "
                        "meta.render_digest pins.",
            },
            notes=[NO_GENERATED_CONTENT, *notes],
            **extra,
        ),
    )
    L.report(dataset_id, count)


def build_prompts_dataset() -> None:
    """`t2i-prompts-v1`: what the latency workloads render."""
    dataset_id = "t2i-prompts-v1"
    directory = L.dataset_dir(dataset_id)
    names = sorted({name for row in SPEED_PROMPTS for name in row.refs})
    total_bytes = write_reference_images(directory, names)
    rows = []
    for row in SPEED_PROMPTS:
        item = {
            "id": row.id,
            "category": row.category,
            "prompt": row.prompt,
            "meta": {"short_prompt": row.short, **row.meta},
        }
        if row.refs:
            item["reference_images"] = [f"images/{name}" for name in row.refs]
        rows.append(item)
    count = L.write_jsonl(directory / "items.jsonl", rows)
    L.write_json(
        directory / "dataset.json",
        L.base_dataset_json(
            dataset_id,
            "Text-to-image latency prompts v1",
            "images",
            "Twelve prompts for the image-generation latency workloads: six text-to-image, "
            "three single-reference edits and three four-reference edits. The render shape "
            "(size, steps, seed, guidance) comes from the workload, not from the row — a "
            "latency workload measures one shape over several prompts.",
            ["items.jsonl", "images/"],
            count,
            "gen_t2i.py",
            created=CREATED,
            categories=sorted({r.category for r in SPEED_PROMPTS}),
            counts={"by_category": {
                c: sum(1 for r in SPEED_PROMPTS if r.category == c)
                for c in sorted({r.category for r in SPEED_PROMPTS})}},
            images={"dir": "images", "format": "PNG", "sizes_px": [REF_SIZE],
                    "count": len(names), "total_bytes": total_bytes,
                    "max_bytes": MAX_IMAGE_BYTES},
            schema={"fields": ["id", "category", "prompt", "reference_images", "meta"]},
            notes=[
                NO_GENERATED_CONTENT,
                "`reference_images` are sent as the conditioning images of an edit request "
                "(repeated `image` fields in multipart, or base64 in JSON). Four references "
                "cost sequence length in both the text encoder and the transformer, which is "
                "why edit-ref1 and edit-ref4 are separate workloads.",
                "Row order is the order the workloads render in; a latency workload takes the "
                "first `num_requests` rows of its category so a shorter run is a prefix of a "
                "longer one.",
            ],
        ),
    )
    L.report(dataset_id, count)


def main() -> None:
    build_prompts_dataset()

    text_cases = [c for c in CASES if c.text]
    image_dataset(
        "eval-t2i-text-v1",
        "Text-rendering eval v1",
        "Seven prompts whose pictures must contain exact strings: shop signs, a poster, a "
        "chalkboard menu, a UI mock, a bilingual sign, and one edit that writes a street name "
        "onto a blank plate. Scored by OCR against the strings the prompt asked for.",
        [case_row(c, "ocr", {"strings": list(c.text)}) for c in text_cases],
        "ocr",
        sorted({name for c in text_cases for name in c.refs}),
        [
            "An item is correct when every expected string is found after normalisation "
            "(NFKC, casefold, collapse whitespace, drop punctuation). The character error "
            "rate is reported next to it in items[].metrics because a lane that renders "
            "GOLDEN CRUMB BAKERV is not as wrong as one that renders nothing.",
            "The OCR backend is part of the measurement: record it in the result's "
            "workload.resolved_params.ocr_backend. Scores from different backends are not "
            "comparable.",
            "The handwriting case (t2i-0006) is deliberately absent: handwriting defeats OCR "
            "often enough that the score would measure the backend rather than the lane.",
        ],
    )

    adherence_cases = [c for c in CASES if c.category != "edit"]
    image_dataset(
        "eval-t2i-adherence-v1",
        "Prompt-adherence eval v1",
        "Twenty text-to-image prompts scored for how well the picture matches the request: "
        "text signage, people and hands, product materials and composition constraints, "
        "landscapes at 1K and native 2K, and transparent stickers. Scored with CLIPScore "
        "against the short form of each prompt.",
        [case_row(c, "clip", c.short) for c in adherence_cases],
        "clip",
        [],
        [
            "`answer` is the short form of the prompt, and it is what the CLIP text encoder "
            "sees: CLIP truncates at 77 tokens, so scoring against the full descriptive "
            "prompt would compare the picture to a sentence cut off mid-clause.",
            "CLIPScore is 100 * max(cosine(image, text), 0). It is a weak, relative measure: "
            "it separates a picture of the wrong thing from a picture of the right thing, and "
            "it says nothing useful about two lanes within a point or two of each other.",
            "An item counts as correct when its CLIPScore clears the workload's "
            "pass_threshold. The per-item score in items[].metrics is the number worth "
            "reading; accuracy is a convenience.",
            "The four edit cases are excluded: their prompt is an instruction about a "
            "reference image, and CLIP scores it against the output alone, which measures "
            "nothing.",
        ],
    )

    rgba_cases = [c for c in CASES if c.transparent]
    image_dataset(
        "eval-t2i-rgba-v1",
        "Transparency eval v1",
        "Four cases that must come back with a real alpha channel: three stickers and one "
        "cut-out edit. Scored on the alpha channel itself — how much of it is transparent, "
        "how clean the edge is, and whether the opaque part is one subject rather than a "
        "field of speckles.",
        [case_row(c, "rgba", {
            "transparent_background": True,
            "min_transparent_fraction": 0.25,
            "max_components": c.components,
            "max_ambiguous_fraction": 0.08,
        }) for c in rgba_cases],
        "rgba",
        sorted({name for c in rgba_cases for name in c.refs}),
        [
            "A lane that returns a JPEG, or a PNG with a fully opaque alpha channel, fails "
            "every item here. That is the point: `transparent: true` silently ignored is the "
            "failure mode this suite exists to catch.",
            "max_components is per case, not global: the steam curls of t2i-0019 are "
            "genuinely separate from the cup. Components smaller than 0.1 % of the image are "
            "ignored before counting.",
            "max_ambiguous_fraction bounds the share of pixels whose alpha is between 0.1 and "
            "0.9 — a soft grey halo around the subject is the usual sign of an alpha channel "
            "that was inferred rather than generated.",
        ],
    )

    image_dataset(
        "eval-t2i-fidelity-v1",
        "Reference-fidelity eval v1",
        "All 24 cases, scored for how far a lane's picture is from the same lane's bf16 "
        "reference at identical prompt, size, steps and seed: PSNR, SSIM, LPIPS when it is "
        "installed, and mean absolute alpha error on the transparent cases.",
        [case_row(c, "fidelity", {
            "reference": "bf16-same-box",
            "render_digest": L.render_digest(c.prompt, c.render),
        }) for c in CASES],
        "fidelity",
        sorted({name for c in CASES for name in c.refs}),
        [
            "There are no reference pixels in this repository and there never will be: a "
            "generated image is model output, not authored data (SPEC §0.6). The reference is "
            "produced on the contributor's own box by running this suite on the bf16 "
            "configuration with `atlas-bench t2i-reference`, which writes a local bundle of "
            "images plus a manifest (per-case sha256, perceptual hash, and the config_id and "
            "args_canonical of the run that produced them).",
            "A result therefore publishes numbers and 64-bit perceptual hashes, never pixels. "
            "The hashes are what lets two contributors compare bf16 references at all: equal "
            "hashes mean the same picture, a large Hamming distance means two boxes that "
            "disagree about what bf16 produces, and that is itself worth knowing.",
            "Fidelity metrics are only meaningful at identical prompt, size, steps and seed. "
            "meta.render_digest pins exactly that, and the scorer refuses to compare a "
            "candidate against a reference bundle whose digest differs rather than reporting "
            "a number that looks like drift but is a different picture.",
            "An item counts as correct when it clears both thresholds in the workload "
            "(psnr_min and ssim_min). Running the suite on the bf16 configuration that "
            "produced the reference is a determinism check, not a quality one: anything below "
            "a perfect score there means the lane is not reproducible at a fixed seed.",
        ],
        suite_extra={"reference": {
            "kind": "local-bundle",
            "produced_by": "atlas-bench t2i-reference --spec <bf16 packet>",
            "manifest_fields": ["case_id", "sha256", "phash", "width", "height", "steps",
                                "seed", "render_digest", "config_id", "args_canonical"],
        }},
    )


if __name__ == "__main__":
    main()
