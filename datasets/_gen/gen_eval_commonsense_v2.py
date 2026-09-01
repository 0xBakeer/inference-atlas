# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Generate `datasets/eval-commonsense-v2/`.

~112 pragmatic-reasoning items built to punish pattern matching. Six families:

  * goal_tracking — the means must serve the end. "I want to run my car through
    the car wash — should I walk there?" A model that answers from the surface
    pattern ("walking is healthy") fails; the goal requires the car.
  * reversed_classics — items that *look* like famous riddles but are altered so
    the memorised classic answer is wrong (two pounds of feathers vs one pound
    of bricks; a bat that costs exactly $1.00; Noah, not Moses).
  * physical — physical consequences where the intuitive answer is wrong (a
    floating ice cube melting does not overflow the glass; an open fridge warms
    the kitchen).
  * false_presupposition — questions whose premise is wrong, with the rejection
    of the premise offered as an option (Beethoven's 15th symphony; the snake's
    legs). The trap is answering as if the premise held.
  * text_selfref — questions about the literal text of a word or sentence
    (letter counts, positions, reversals). Answers are computed from the string
    by this script, never typed.
  * feasibility — small planning problems where the tempting plan does not
    actually reach the goal in time or in order (buy the eggs before preheating
    the oven; the 11:00 ferry you cannot catch).

Hand-authored families follow the eval-format-v1 precedent (hand-written items);
every hand-authored row carries `meta.trap` naming the wrong answer it is built
to catch, so a reviewer can audit the key. The text_selfref family is fully
computed.

Run: `uv run datasets/_gen/gen_eval_commonsense_v2.py`
"""

from __future__ import annotations

import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import _lib as L  # noqa: E402

SEED = 20260910
DATASET_ID = "eval-commonsense-v2"
LETTERS = "ABCDE"
MC_TAIL = "Reply with the letter of the correct option only."
BARE_NUM = "Reply with the number only."


_MC_COUNTER = 0


def mc(rng: random.Random, stem: str, correct: str, distractors: list[str]) -> tuple[str, list[str], str]:
    """Shuffle distractors, then place the correct option round-robin over A-D.

    Round-robin placement keeps the correct-letter distribution flat, so a model
    that always answers the same letter scores ~25 %, not more.
    """
    global _MC_COUNTER
    options = list(distractors)
    rng.shuffle(options)
    idx = _MC_COUNTER % (len(options) + 1)
    _MC_COUNTER += 1
    options.insert(idx, correct)
    rendered = "\n".join(f"{LETTERS[i]}. {opt}" for i, opt in enumerate(options))
    return f"{stem}\n\n{rendered}\n\n{MC_TAIL}", options, LETTERS[idx]


# --------------------------------------------------------------------------------------
# goal_tracking — the means must serve the end
# (stem, correct, distractors, difficulty, trap)
# --------------------------------------------------------------------------------------

GOAL_TRACKING = [
    ("My car is dirty and I want to run it through the drive-through car wash on the other "
     "side of town this afternoon. What is the best way for me to get to the car wash?",
     "Drive the car there, since the car is what needs washing",
     ["Walk there, because walking is healthy and saves fuel",
      "Take the bus there to avoid traffic",
      "Cycle there, since it is not that far"],
     "medium",
     "Recommending walking/cycling for health leaves the car at home, defeating the goal."),
    ("My broken umbrella needs to be repaired at the repair shop. It is raining lightly "
     "outside. Should I take the broken umbrella with me to the shop?",
     "Yes — the shop cannot repair an umbrella that is not there",
     ["No — leave it at home so it does not get wetter",
      "No — buy a new umbrella at the shop instead",
      "Only if the rain stops first"],
     "easy",
     "The 'protect it from rain' answer defeats the repair goal."),
    ("I need a new passport photo of myself for my passport renewal. My friend is much more "
     "photogenic than I am. Who should sit for the photo at the studio?",
     "I must sit for it myself — a passport photo has to show the passport holder",
     ["My friend, since the photo will look better",
      "Either of us, as long as the photo is sharp",
      "My friend, if we have a similar hair colour"],
     "easy",
     "A 'better photo' is useless if it shows the wrong person."),
    ("The vet needs to vaccinate my dog today. The clinic is a ten-minute walk away and my "
     "dog hates car rides. What should I bring to the appointment?",
     "The dog — the vaccination goes into the dog, so the dog must be there",
     ["Just the dog's vaccination booklet, to spare the dog the stress",
      "A photo of the dog and its medical history",
      "Nothing — I can collect the vaccine and store it at home"],
     "easy",
     "Sparing the dog the trip makes the vaccination impossible."),
    ("A locksmith is going to cut a copy of my apartment key while I wait. What do I need "
     "to hand the locksmith?",
     "The original key, so it can be copied",
     ["A photo of the key from both sides",
      "My apartment address, so the right key can be looked up",
      "The new blank key I bought online"],
     "easy",
     "Photos and addresses do not let a walk-in locksmith duplicate a physical key."),
    ("My suit needs dry-cleaning before a wedding. The cleaner is next to my office. "
     "What is the sensible way to get the suit there on my commute?",
     "Carry the suit there in a garment bag and hand it in",
     ["Wear the suit there and hand it over at the counter",
      "Describe the stains by phone so the cleaner can prepare",
      "Send a photo of the suit and wait for a quote"],
     "medium",
     "'Wear it there' leaves me standing in the shop with nothing to wear."),
    ("My car is due for its mandatory roadworthiness inspection. We own two cars, and my "
     "partner's newer car would surely pass more easily. Which car do I take to the "
     "inspection station for my car's inspection?",
     "My own car — the inspection certifies the specific car that is due",
     ["My partner's car, because it is more likely to pass",
      "Whichever car has more fuel in the tank",
      "My partner's car, if the paperwork for both is brought along"],
     "medium",
     "The 'more likely to pass' option certifies the wrong vehicle."),
    ("My blood test tomorrow at 8:00 requires fasting for at least 8 hours beforehand. "
     "Breakfast is the most important meal of the day. What should I do tomorrow morning "
     "before the test?",
     "Skip breakfast until after the blood is drawn",
     ["Eat a good breakfast at 7:00 so I have energy for the test",
      "Eat only a light breakfast at 7:30",
      "Drink a sugary juice instead of eating"],
     "easy",
     "The 'breakfast is important' pattern breaks the fasting requirement."),
    ("The phone shop gives a trade-in discount when you hand in your old phone at purchase. "
     "I want that discount on a new phone today. What must I take to the shop?",
     "My old phone, to hand it in at the counter",
     ["Only my ID and bank card, to keep my pockets light",
      "The old phone's original box and receipt, but not the phone",
      "A screenshot of the old phone's settings page"],
     "easy",
     "No old phone at the counter, no trade-in."),
    ("My electric car shows 10 km of remaining range. The cheap fast charger I like is "
     "40 km away; a slower charger is 2 km away. Where should I charge?",
     "At the charger 2 km away — the car cannot reach the one 40 km away",
     ["At the fast charger 40 km away, since fast charging saves time overall",
      "At the fast charger 40 km away, driving slowly to save energy",
      "Wait until tomorrow when the fast charger is even cheaper"],
     "medium",
     "'Fast charger saves time' ignores that 10 km of range cannot cover 40 km."),
    ("The piano in my living room is out of tune. The tuner I called offers home visits for "
     "a small fee. What is the sensible arrangement?",
     "Book the home visit so the tuner works on the piano where it stands",
     ["Ship the piano to the tuner's workshop to avoid the visit fee",
      "Record the piano and email the recording to be tuned",
      "Carry the piano to the workshop with two friends to save the fee"],
     "easy",
     "Moving a piano to dodge a small visit fee inverts the costs."),
    ("I want my winter coat altered by the tailor so that it fits me. The tailor asked me "
     "to come in for a fitting. My roommate is free that day and we are the same height. "
     "Who should go to the fitting wearing the coat?",
     "I should — the coat is being fitted to my body",
     ["My roommate, since we are the same height",
      "Either of us, because the tailor only needs the coat",
      "Nobody — I can just drop the coat off"],
     "medium",
     "Same height is not the same build; the fitting needs the wearer."),
    ("At the optician, my new glasses are ready and need a final adjustment of the frame. "
     "I am busy, and my brother offered to pick them up. The optician says the adjustment "
     "is bent to the wearer's face and ears. What should happen?",
     "I go in myself so the frame is adjusted to my face",
     ["My brother picks them up and the frame stays as it is",
      "My brother wears them during the adjustment, since we look alike",
      "The optician adjusts them from my photo"],
     "medium",
     "Delegating the pickup skips the fit that only my face can define."),
    ("I am returning my neighbour's power drill that I borrowed. I plan to visit him "
     "tonight anyway to play chess. What should I take along tonight?",
     "The drill — returning it is the point of returning it",
     ["Nothing extra; the visit itself counts as returning it",
      "A thank-you card instead of the drill",
      "A photo of the drill so he can see it is fine"],
     "easy",
     "The visit without the object returns nothing."),
    ("My washing machine broke. The manufacturer offers free in-home repairs this month. "
     "The repair depot is 30 km away. What should I do?",
     "Book the free in-home repair and let the technician come to the machine",
     ["Rent a van and haul the machine to the depot",
      "Carry the machine to the depot by public transport",
      "Buy a new machine to avoid dealing with the repair"],
     "easy",
     "Hauling the machine somewhere is strictly worse than the free home visit."),
    ("The notary needs my signature on the house contract tomorrow, given in person with "
     "photo ID. I am busy, and my sister has excellent handwriting. Who must attend?",
     "I must attend and sign myself, with my ID",
     ["My sister, signing my name neatly",
      "My sister, bringing a photocopy of my ID",
      "Nobody — the notary can copy my signature from an old letter"],
     "easy",
     "Better handwriting does not make someone else's signature mine."),
    ("I want to weigh my suitcase against the airline's 23 kg limit. My bathroom scale is "
     "at home and I finish packing at home tonight. When and where should I weigh it?",
     "At home tonight, so I can still repack if it is over the limit",
     ["At the airport check-in counter, where the official scale is",
      "After security, where the queues are shorter",
      "No need to weigh it; suitcases rarely exceed limits"],
     "medium",
     "Weighing first at the counter finds the problem when it is too late to fix calmly."),
    ("My daughter's feet have grown and she needs new school shoes. Shoe sizes vary a lot "
     "between brands. I could shop faster alone during school hours. What is the right "
     "way to buy shoes that fit her?",
     "Take her along (or shop when she can try them on)",
     ["Go alone during school hours and buy her usual size",
      "Go alone and buy one size up in every brand",
      "Order five pairs online in random sizes and keep them all"],
     "medium",
     "'Faster alone' buys speed at the cost of the actual goal: shoes that fit."),
    ("I want a haircut before an interview on Friday. My calendar is packed, and my "
     "flatmate has a free afternoon. Can my flatmate go to the barber for me?",
     "No — the haircut has to happen on my head, so I must go myself",
     ["Yes, if he shows the barber a photo of me",
      "Yes, and he can bring back the instructions for me to do it at home",
      "Yes, because barbers keep customer records"],
     "easy",
     "A haircut is not a collectible item; presence is the whole errand."),
    ("The bike shop will fit my new helmet to my head for free. My head is round-ish and "
     "my friend's is too, and he passes the shop every day. Who should the helmet be "
     "fitted on?",
     "Me — helmet fit is to the specific head that will wear it",
     ["My friend, since he passes the shop anyway",
      "Either head, as helmets stretch over time",
      "Nobody — the labelled size is enough for safety"],
     "medium",
     "A convenience substitution ('he passes it anyway') breaks the safety goal."),
    ("I am going on holiday for three weeks and want my balcony plants alive when I "
     "return. When do I need to arrange for someone to water them?",
     "Before I leave — once I am away, I can no longer hand over keys and instructions",
     ["During the second week, once the soil is properly dry",
      "After I return, so I can supervise the watering",
      "No arrangement is needed if I water them very well on the last day"],
     "medium",
     "Any plan that starts after departure cannot be set up by me at all."),
    ("The framing shop needs my painting in order to build a custom frame around it this "
     "week. The painting is fragile. What do I do?",
     "Bring the painting in, packed carefully — the frame is built to the physical piece",
     ["Keep the painting safe at home and bring in a sketch of it",
      "Email the painting's dimensions and colours instead",
      "Ask the shop to guess a popular size"],
     "medium",
     "Protecting the object at home prevents the very service it needs."),
]

# --------------------------------------------------------------------------------------
# reversed_classics — the memorised riddle answer is wrong here
# Items are (kind, ...) where kind is "mc" or "num".
# --------------------------------------------------------------------------------------

REVERSED_MC = [
    ("Which weighs more: two pounds of feathers or one pound of bricks?",
     "The feathers — two pounds is more than one pound",
     ["The bricks — brick is much denser than feathers",
      "They weigh exactly the same",
      "It depends on the humidity of the feathers"],
     "medium",
     "The classic riddle uses equal weights; here the numbers differ and the 'they're equal' reflex is wrong."),
    ("You are running a race and you try to overtake the runner who is in last place. "
     "What must be true?",
     "It is impossible — to overtake the last runner you would have to be behind them, "
     "and then they would not be last",
     ["You are now in last place",
      "You are now in second-to-last place",
      "You are now exactly in the middle of the field"],
     "hard",
     "Pattern-matches the 'overtake second place → you are second' riddle, but this variant is a contradiction."),
    ("Maria's mother has three daughters. Two of them are named Anna and Berta. "
     "Someone claims the third daughter is called Clara, not Maria. Is that possible?",
     "No — Maria is one of the mother's daughters, so the third daughter must be Maria",
     ["Yes, if Clara is the youngest",
      "Yes, because the riddle never lists Maria as a daughter",
      "Only if Anna and Berta are twins"],
     "medium",
     "The classic asks for the third name; the reversal asks the model to defend the entailment."),
    ("A diesel locomotive travels south at 80 km/h while a steady wind blows from the "
     "east. In which direction does its exhaust smoke drift, as seen from the ground?",
     "Toward the west, pushed by the wind from the east",
     ["There is no smoke, because locomotives are electric",
      "Toward the north, opposite to the train's motion",
      "Straight up, because exhaust is hot"],
     "medium",
     "The classic uses an electric train with no smoke; a diesel does produce exhaust."),
    ("A duck lays an egg on the exactly flat roof of a barn on a windless day. "
     "Which way does the egg roll off?",
     "It does not roll off — the roof is flat",
     ["Ducks do not lay eggs, so there is no egg",
      "Down the north slope",
      "Down whichever side faces the sun"],
     "medium",
     "The memorised answer is 'roosters don't lay eggs'; ducks do, and a flat roof rolls nothing."),
    ("Two coins add up to 35 cents. One of them is not a dime. What are the two coins?",
     "A quarter and a dime — the quarter is the one that is not a dime",
     ["A quarter and two nickels",
      "Three dimes and a nickel",
      "This is impossible with standard US coins"],
     "hard",
     "Same trick as the classic 30-cent version, at a total the memorised answer does not fit."),
    ("Before the Mariana Trench was first surveyed, what was the deepest point of the "
     "world's oceans?",
     "The Mariana Trench — it was the deepest whether or not anyone had surveyed it",
     ["The Puerto Rico Trench, until the survey",
      "The Java Trench, until the survey",
      "There was no deepest point before surveys existed"],
     "medium",
     "The Everest version of this riddle is famous; the point is that discovery does not change geography."),
    ("A farmer has 17 sheep. All but 9 are sold. Of the sheep the farmer still has, "
     "3 are then given to a neighbour. How many sheep does the farmer have left?",
     "6",
     ["9", "14", "5"],
     "medium",
     "The classic stops at 'all but 9' = 9; the added step catches models that answer from memory."),
]

REVERSED_NUM = [
    ("A bat and a ball cost $1.10 in total. The bat costs exactly $1.00. "
     "How many cents does the ball cost? " + BARE_NUM,
     "10", "hard",
     "The famous version says 'costs $1.00 more than the ball' (ball = 5); here the bat price is stated outright."),
    ("If 100 machines take 100 minutes to make 100 widgets, how many minutes do 5 machines "
     "take to make 5 widgets? Each machine works at the same constant rate. " + BARE_NUM,
     "100", "hard",
     "The famous version (5 machines, 5 minutes, 5 widgets) has answer 5; these numbers give 100."),
    ("A patch of lily pads doubles in size every day. It covers the entire lake on day 48. "
     "On which day did it cover one quarter of the lake? " + BARE_NUM,
     "46", "medium",
     "The memorised answer to this family is 47 (half); one quarter is two doublings back."),
    ("How many animals of each kind did Noah take on the ark, according to the well-known "
     "Bible story? " + BARE_NUM,
     "2", "medium",
     "The trick version asks about Moses (answer 0); over-corrected models answer 0 here too."),
    ("A doctor gives you 4 pills and tells you to take one every 15 minutes, starting now. "
     "After how many minutes do you take the last pill? " + BARE_NUM,
     "45", "medium",
     "The fencepost: 4 pills span 3 intervals, and the classic (3 pills / 30 min) answer 60 is also wrong here."),
    ("How many months of the year have exactly 30 days? " + BARE_NUM,
     "4", "medium",
     "Pattern-matches the '28 days' riddle whose answer is 12; exactly-30 is April, June, September, November."),
]

# --------------------------------------------------------------------------------------
# physical — the intuitive physical answer is wrong
# --------------------------------------------------------------------------------------

PHYSICAL = [
    ("A rigid glass bottle is filled completely to the top with water, sealed airtight, and "
     "left in a freezer overnight until the water is fully frozen. What is the most likely "
     "state of the bottle in the morning?",
     "Cracked or burst, because water expands as it freezes",
     ["Intact, with the ice sitting slightly lower than the waterline",
      "Intact, because the seal prevents any change in volume",
      "Intact, because glass shrinks more than water in the cold"],
     "easy",
     "Ice takes more volume than the water it came from; a full rigid sealed bottle has nowhere for it to go."),
    ("A burning candle is covered with a large sealed glass jar. What happens and why?",
     "It goes out after a while, when the oxygen in the jar is used up",
     ["It burns indefinitely, because wax is the only fuel it needs",
      "It burns brighter, because the jar focuses the heat",
      "It goes out instantly, because glass blocks oxygen"],
     "easy",
     "The flame needs the oxygen sealed in with it; 'instantly' and 'indefinitely' are both wrong."),
    ("On a hot day, someone leaves the refrigerator door wide open in a small closed "
     "kitchen for several hours. Over time, the kitchen's average temperature will:",
     "Rise slightly — the fridge pumps heat from inside to its coils plus the motor's own heat",
     ["Fall noticeably, because cold air flows out of the fridge",
      "Stay exactly the same, because cold out equals warm in",
      "Fall at first and stay lower as long as the door is open"],
     "hard",
     "A fridge is a heat pump inside the same room: net effect is heating, not cooling."),
    ("An ice cube floats in a glass filled with water exactly to the brim. When the ice "
     "melts completely, the glass will:",
     "Not overflow — the floating ice already displaced exactly its melt volume",
     ["Overflow, because the ice adds its volume as it melts",
      "Overflow only if the ice was clear rather than cloudy",
      "Drop noticeably in level, because melt water is denser"],
     "hard",
     "Archimedes: floating ice displaces its own weight of water; melting changes nothing at the brim."),
    ("A helium balloon floats above the back seat of a closed car, tied loosely so it can "
     "move. The car accelerates sharply forward. Which way does the balloon swing?",
     "Forward, because the denser air is thrown backward and pushes the light balloon ahead",
     ["Backward, like everything else in the car",
      "It stays exactly where it is",
      "Downward, because acceleration adds weight"],
     "hard",
     "Everything heavy goes back; the balloon is lighter than the air that displaces it."),
    ("A ceiling fan runs all day in a completely closed, well-insulated room with nobody "
     "inside. By evening, the air temperature in the room is:",
     "Slightly higher, because the motor's work ends up as heat",
     ["Slightly lower, because moving air is cooler air",
      "Exactly the same, because a fan neither heats nor cools",
      "Much lower, as the fan works like an air conditioner"],
     "medium",
     "Fans cool people (evaporation/convection), not rooms; the motor adds heat."),
    ("A metal railing and a wooden fence stand side by side outdoors on a freezing morning, "
     "both at the same air temperature. Why does the metal feel much colder to your hand?",
     "Metal conducts heat away from your skin far faster, though both are equally cold",
     ["The metal really is several degrees colder than the wood",
      "Metal stores more cold overnight than wood can",
      "Thin frost forms only on metal surfaces"],
     "medium",
     "The felt difference is conduction rate, not temperature."),
    ("Water boils in an open pot on a mountain at 4,000 m altitude. Compared with sea "
     "level, the boiling water there is:",
     "Cooler than 100 °C, so food cooks more slowly in it",
     ["Hotter than 100 °C, because mountain air is drier",
      "Exactly 100 °C — boiling always happens at 100 °C",
      "Cooler than 100 °C, so food cooks faster in it"],
     "medium",
     "Lower pressure lowers the boiling point; the second distractor pairs the right temperature with the wrong consequence."),
    ("Freshly washed wet laundry is hung outside on a line in dry air at −10 °C for two "
     "days. What happens to it?",
     "It freezes stiff, then dries anyway as the ice slowly turns directly to vapour",
     ["It stays frozen and wet until the air warms above 0 °C",
      "It cannot dry, because evaporation stops below freezing",
      "It gets wetter, absorbing moisture from the cold air"],
     "hard",
     "Sublimation dries laundry below freezing; 'evaporation stops' is the intuitive wrong answer."),
    ("A steel ball and an equally sized solid rubber ball are dropped together from a "
     "table onto the floor. Ignoring the tiny effect of air over such a short fall, "
     "which hits the floor first?",
     "They land essentially together — falling speed does not depend on weight here",
     ["The steel ball, because heavier objects fall faster",
      "The rubber ball, because it is more aerodynamic",
      "The steel ball, because gravity pulls harder on it and that makes it faster"],
     "easy",
     "The last distractor states a true premise (more force) with the false conclusion (faster fall)."),
    ("Why does sprinkling salt on an icy pavement melt the ice even though the salt "
     "is not warm?",
     "Salt water freezes below 0 °C, so at the same temperature the ice can melt into brine",
     ["Salt crystals release heat when they touch ice",
      "Salt makes the ice heavier so pressure melts it",
      "Salt absorbs sunlight better than ice does"],
     "medium",
     "Freezing-point depression, not any heat source."),
    ("A raw egg still in its shell is heated in a microwave oven. The likely outcome is:",
     "It bursts, because steam builds up inside the sealed shell",
     ["It cooks into a normal boiled egg",
      "Nothing happens; microwaves pass through shells",
      "It cooks only on the outside like a fried egg"],
     "easy",
     "The shell is a pressure vessel; microwaving it is a small explosion waiting to happen."),
    ("An alarm bell rings inside a sealed glass jar from which all the air has been "
     "pumped out. Standing next to the jar, you will:",
     "See the hammer moving but hear nothing, because sound needs a medium",
     ["Hear it slightly muffled through the glass",
      "Hear it normally, since glass carries sound well",
      "Neither see nor hear it, as a vacuum blocks light too"],
     "medium",
     "Light crosses the vacuum, sound does not."),
    ("A straw passes through an airtight cap on a completely sealed rigid bottle of juice. "
     "When you suck on the straw, what happens after the first small sip?",
     "The juice stops coming, because no air can enter the bottle to replace it",
     ["The juice flows normally as long as you keep sucking",
      "The juice flows faster, because the seal builds pressure",
      "The bottle heats up until the juice rises by itself"],
     "medium",
     "Drinking through a straw is atmospheric pressure doing the pushing; sealed bottle, no push."),
    ("A toy boat carrying a small steel weight floats in a bucket that is full to the "
     "brim. The weight is taken out of the boat and dropped into the water, where it "
     "sinks. The water level at the brim now:",
     "Falls slightly — sunk, the weight displaces less water than it did while afloat",
     ["Rises slightly, because the weight is now in the water",
      "Stays exactly the same, because nothing left the bucket",
      "Rises or falls depending on the water temperature"],
     "hard",
     "Afloat it displaces its weight in water; sunk, only its volume. Classic but rarely memorised correctly."),
    ("A tin can of oil has a single small opening. Tilting it to pour, the oil comes out "
     "in irregular glugs. Punching a second small hole on the opposite side of the lid "
     "makes the pouring smooth because:",
     "Air can enter through the second hole while oil leaves through the first",
     ["The second hole doubles the flow area",
      "The second hole lowers the pressure inside the can",
      "The oil becomes thinner with more oxygen"],
     "medium",
     "The glug is the air fighting the oil for one opening."),
    ("You stand in front of a plane mirror and raise your right hand. The image you see "
     "appears to be raising:",
     "Its left hand, on the same side of the mirror as your raised hand",
     ["Its right hand, exactly copying you",
      "Both hands, due to reflection symmetry",
      "Neither — mirrors swap top and bottom, not left and right"],
     "easy",
     "The apparent handedness swap is the point; the last distractor inverts the real explanation."),
    ("On a cold winter day, the inside of a car's windscreen keeps fogging up while "
     "people sit in the car. The fog is:",
     "Moisture from the occupants' breath condensing on the cold glass inside",
     ["Rain seeping through microscopic pores in the glass",
      "Cold outside air leaking in and turning to mist",
      "Engine exhaust entering through the ventilation"],
     "easy",
     "Warm humid air meets cold glass; the source is inside, not outside."),
    ("A sealed vacuum flask is completely full of hot coffee. After it is shaken hard "
     "for several minutes, the coffee's temperature is:",
     "Very slightly higher, because the shaking does work on the liquid",
     ["Very slightly lower, because shaking releases heat",
      "Exactly unchanged, because the flask is sealed",
      "Much lower, because motion always cools liquids"],
     "hard",
     "Joule's stirring experiment in a thermos: mechanical work becomes heat."),
    ("Two identical open glasses hold the same amount of water. Glass X's water is at "
     "60 °C, glass Y's at 20 °C, in a 20 °C room. After one hour on the same table, "
     "which statement is right?",
     "X has lost more water to evaporation than Y",
     ["Y has lost more water, because cool water evaporates longer",
      "Both lost the same, since evaporation depends only on surface area",
      "Neither lost any water, because neither was boiling"],
     "medium",
     "Evaporation happens well below boiling and speeds up with temperature."),
]

# --------------------------------------------------------------------------------------
# false_presupposition — the premise is wrong; the trap is answering as if it held
# --------------------------------------------------------------------------------------

FALSE_PRESUPPOSITION = [
    ("When did Albert Einstein invent the electric light bulb?",
     "He never did — Einstein did not invent the light bulb",
     ["1879", "1905", "1921"],
     "easy",
     "Every year offered is 'plausible' (1905, 1921 are Einstein years; 1879 is the bulb)."),
    ("Which chemical element has the symbol 'Xy'?",
     "None — no element has the symbol Xy",
     ["Xenon", "Yttrium", "Xylophonium"],
     "medium",
     "Xenon (Xe) and yttrium (Y) are near-misses that reward fuzzy recall."),
    ("In which year did Switzerland enter World War I as a fighting nation?",
     "It never did — Switzerland stayed neutral throughout World War I",
     ["1914", "1916", "1917"],
     "medium",
     "All three years lie inside the war; only the premise is false."),
    ("How many legs does a snake use for walking?",
     "None — snakes have no legs and do not walk",
     ["Two", "Four", "It varies by species between two and four"],
     "easy",
     "A model completing the 'how many legs' frame picks a number."),
    ("What is the capital city of the continent of Africa?",
     "Continents do not have capital cities",
     ["Cairo", "Nairobi", "Johannesburg"],
     "easy",
     "Prominent African cities make tempting 'answers' to a category error."),
    ("Which of Beethoven's symphonies is his famous 15th?",
     "None — Beethoven completed only nine symphonies",
     ["The 'Eroica'", "The 'Pastoral'", "The 'Choral'"],
     "medium",
     "The nicknames belong to real symphonies (3, 6, 9); the count in the premise is wrong."),
    ("What colours are the stripes on the national flag of Japan?",
     "The flag of Japan has no stripes — it is a red disc on a white field",
     ["Red and white", "White and blue", "Red, white and black"],
     "medium",
     "'Red and white' is nearly irresistible: right colours, wrong pattern."),
    ("Which ocean lies between Germany and France?",
     "None — Germany and France share a land border",
     ["The Atlantic Ocean", "The North Sea", "The Baltic Sea"],
     "easy",
     "Both touch real seas; between them, though, is land."),
    ("How tall was the first human being to walk on the surface of the Sun?",
     "No human has ever walked on the Sun — it has no solid surface and would be impossible",
     ["1.80 m", "1.65 m", "Roughly average height for an astronaut"],
     "easy",
     "The frame invites a plausible-sounding height."),
    ("How many bones are there in an earthworm's skeleton?",
     "None — earthworms have no skeleton at all",
     ["33", "120", "About 200, depending on length"],
     "medium",
     "Counting questions pressure a model into producing a count."),
    ("Which king of the United States signed the Declaration of Independence?",
     "None — the United States has never had a king",
     ["King George III", "King John Hancock", "King James Madison"],
     "easy",
     "George III is the tempting one: a real king, on the wrong side of the premise."),
    ("On which day does a sale that ends on February 30th actually end?",
     "There is no February 30th — the date does not exist in any year",
     ["February 28th", "February 29th, in leap years", "March 1st"],
     "medium",
     "The 'closest real date' answers look like helpfulness but validate a nonexistent date."),
    ("Which side of an equilateral triangle is its hypotenuse?",
     "None — only right-angled triangles have a hypotenuse",
     ["The longest side", "The bottom side", "Any side, since all three are equal"],
     "medium",
     "'Any side, all equal' sounds insightful and is still a category error."),
    ("What did the Roman Empire name its first Moon base?",
     "Nothing — the Roman Empire never had a Moon base",
     ["Luna Prima", "Nova Roma", "Castra Lunae"],
     "easy",
     "Latin-sounding names lend the premise false credibility."),
    ("How many minutes did it take the Titanic to complete its first successful "
     "transatlantic crossing to New York?",
     "It never completed the crossing — the Titanic sank on its maiden voyage",
     ["About 8,000 minutes", "About 10,000 minutes", "About 12,000 minutes"],
     "medium",
     "Unit weirdness (minutes) distracts from the false 'successful' premise."),
    ("Which two even prime numbers are greater than 2?",
     "There are none — 2 is the only even prime number",
     ["4 and 6", "6 and 8", "2 and 4"],
     "medium",
     "A maths-flavoured false premise; every listed pair contains a composite."),
]

# --------------------------------------------------------------------------------------
# feasibility — the tempting plan does not reach the goal
# --------------------------------------------------------------------------------------

FEASIBILITY_MC = [
    ("The post office closes in 5 minutes and is 2 minutes away on foot. The stamp shop "
     "is 10 minutes away in the other direction, and my letter needs a stamp that the "
     "post office also sells. What gets the letter posted today?",
     "Go straight to the post office and buy the stamp there",
     ["Buy the stamp at the stamp shop first, then go to the post office",
      "Go to the stamp shop first because it is cheaper, then hurry",
      "Wait until tomorrow to buy the cheaper stamp"],
     "medium",
     "The stamp-shop detour arrives after closing; the post office sells stamps too."),
    ("A roast needs 40 uninterrupted minutes in the oven. Guests arrive in exactly 30 "
     "minutes and want to eat immediately. If I put the roast in right now, when is it "
     "ready?",
     "10 minutes after the guests arrive",
     ["Exactly when the guests arrive",
      "5 minutes before the guests arrive",
      "20 minutes after the guests arrive"],
     "easy",
     "Simple, but models eager to reassure often 'round' the conflict away."),
    ("A ferry leaves every hour on the hour. It is 10:20 now and the drive to the port "
     "takes 45 minutes. Which ferry is the earliest I can catch?",
     "The 12:00 ferry — I arrive at 11:05, just after the 11:00 has left",
     ["The 11:00 ferry, if I leave immediately",
      "The 11:00 ferry, because ferries usually wait a few minutes",
      "The 10:00 ferry"],
     "medium",
     "11:05 misses 11:00 by five minutes; hoping the ferry waits is not a plan."),
    ("I am baking a cake but have no eggs. The shop is a 30-minute round trip, the oven "
     "takes 10 minutes to preheat, and the batter (with eggs) takes 15 minutes to make. "
     "What should I do FIRST to be done soonest without wasting energy?",
     "Go buy the eggs",
     ["Preheat the oven so it is ready when I return",
      "Make the batter now and add the eggs later",
      "Grease the tin and preheat the oven together"],
     "hard",
     "Preheating 'to save time' runs an empty oven for 30+ minutes; nothing can proceed without eggs."),
    ("My visa application takes at least 10 business days to process, and my flight "
     "departs 7 calendar days from today. Which statement is true?",
     "The visa cannot be counted on to arrive before the flight; I must change plans "
     "or seek an expedited option",
     ["Submitting today guarantees the visa just in time",
      "7 days is enough because weekends speed up processing",
      "The airline can extend the visa deadline at check-in"],
     "medium",
     "10 business days can never fit inside 7 calendar days."),
    ("The pharmacy can only fill my prescription after my doctor faxes it over. The "
     "doctor's office closed an hour ago and opens tomorrow at 9:00. The pharmacy is "
     "open until midnight. Can I get the medicine tonight?",
     "No — the pharmacy is open but the prescription cannot arrive until tomorrow",
     ["Yes, if I get to the pharmacy before midnight",
      "Yes, because pharmacies keep copies of prescriptions",
      "Yes, if I show the pharmacist my empty pill bottle"],
     "medium",
     "The open pharmacy is a decoy; the blocking dependency is the closed doctor's office."),
    ("My library book is due today, Saturday. The library closes at 18:00 and it is now "
     "17:50; the library is a 15-minute ride away and it is closed on Sundays. There is "
     "a 24-hour return box at its entrance. How do I avoid a late fee?",
     "Ride over and drop the book in the 24-hour return box",
     ["Race to the counter before 18:00",
      "Return it Sunday morning instead",
      "It is impossible to return the book in time"],
     "hard",
     "Both the 'race' and the 'impossible' options miss the drop box stated in the problem."),
    ("A meeting runs 14:00–15:00 on one side of town. A dentist appointment is booked "
     "for 14:30 on the other side of town, 25 minutes away. What is true?",
     "The two appointments overlap and cannot both be kept; one must be moved",
     ["Both can be kept by leaving the meeting at 14:25",
      "Both can be kept because dentists always run late",
      "Both can be kept if the meeting starts on time"],
     "easy",
     "14:30 lies inside 14:00–15:00; no travel plan fixes an overlap."),
    ("An electric car has a 300 km range on a full battery. The trip is 450 km, and "
     "there is one fast charger at the 250 km mark that adds 200 km of range in 30 "
     "minutes. Is the trip feasible?",
     "Yes — charge at the 250 km mark, then finish with range to spare",
     ["No, because 450 km is more than the 300 km range",
      "No, because charging en route does not add usable range",
      "Only if the car starts half charged"],
     "medium",
     "The reflex 'trip longer than range → impossible' ignores the charger placed within reach."),
    ("My phone is at 1% and my navigation app must run for a 3-hour drive that starts "
     "right now. The car has a working USB charging port. What do I do about the phone?",
     "Plug it into the car's port and navigate while it charges",
     ["Stay home until the phone is fully charged, then leave",
      "Leave the phone at home to save its battery",
      "Turn the phone off for the whole drive to preserve 1%"],
     "easy",
     "'Charge fully first' breaks the 'starts right now' constraint for no reason."),
]

FEASIBILITY_EXACT = [
    ("A wall needs 2 coats of paint. Each coat takes 1 hour to apply, and each coat must "
     "dry for 3 hours before anything else can happen to the wall. I start painting at "
     "09:00. At what time is the wall completely finished (second coat applied and dry)? "
     "Reply with the time only, in HH:MM format.",
     "17:00", "hard",
     "09:00 +1h coat +3h dry +1h coat +3h dry = 17:00; models often skip the final drying step."),
    ("Bread dough must rise twice for 1 hour each time, with 15 minutes of kneading "
     "before each rise, and then bake for 45 minutes. I want the bread out of the oven "
     "at exactly 12:00. What is the latest time I can start the first kneading? "
     "Reply with the time only, in HH:MM format.",
     "08:45", "hard",
     "Total 15+60+15+60+45 = 195 minutes; 12:00 minus 3h15m = 08:45."),
]

# --------------------------------------------------------------------------------------
# text_selfref — computed from the literal text
# --------------------------------------------------------------------------------------

SELF_WORDS = [
    "possessions", "committee", "Mississippi", "bookkeeper", "senselessness",
    "abracadabra", "onomatopoeia", "dressmaker", "assassination", "lollipop",
    "riffraff", "hodgepodge", "sweettooth", "peppercorn", "gobbledygook",
]

SELF_SENTENCES = [
    "The quick brown fox jumps over the lazy dog near the riverbank",
    "Every good benchmark needs at least one question nobody can pattern match",
    "She sells seashells by the seashore while the tide slides sideways",
    "A model that counts letters carefully deserves every point it gets",
]

REVERSE_WORDS = ["stressed", "diaper", "drawer", "regal", "deliver", "straw"]


def gen_text_selfref(rng: random.Random) -> list[dict]:
    items: list[dict] = []

    letter_jobs = [
        ("possessions", "s"), ("Mississippi", "s"), ("committee", "e"),
        ("bookkeeper", "e"), ("senselessness", "s"), ("abracadabra", "a"),
        ("onomatopoeia", "o"), ("assassination", "s"), ("riffraff", "f"),
        ("gobbledygook", "o"), ("peppercorn", "p"), ("hodgepodge", "d"),
    ]
    for word, letter in letter_jobs:
        count = word.lower().count(letter)
        items.append(dict(
            category="text_selfref", difficulty="hard",
            prompt=(f"How many times does the letter '{letter}' appear in the word "
                    f"\"{word}\"? Count every occurrence, including repeated ones. {BARE_NUM}"),
            answer=str(count), scorer="numeric", meta={},
        ))

    position_jobs = [("xylophone", 5), ("benchmark", 6), ("labyrinth", 4),
                     ("quixotic", 7), ("wharf", 3)]
    for word, pos in position_jobs:
        items.append(dict(
            category="text_selfref", difficulty="medium",
            prompt=(f"What is the {pos}th letter of the word \"{word}\", counting from "
                    "the first letter as number 1? Reply with the single letter only."),
            answer=word[pos - 1], scorer="exact", meta={},
        ))

    for sentence in SELF_SENTENCES:
        n = len(sentence.split())
        items.append(dict(
            category="text_selfref", difficulty="medium",
            prompt=(f"How many words are in the following sentence?\n\n\"{sentence}\"\n\n"
                    f"{BARE_NUM}"),
            answer=str(n), scorer="numeric", meta={},
        ))

    for word in REVERSE_WORDS:
        items.append(dict(
            category="text_selfref", difficulty="medium",
            prompt=(f"Write the word \"{word}\" backwards. Reply with the reversed "
                    "word only."),
            answer=word[::-1], scorer="exact", meta={},
        ))

    vowel_jobs = ["gobbledygook", "onomatopoeia", "dressmaker", "sweettooth", "lollipop"]
    for word in vowel_jobs:
        count = sum(1 for ch in word.lower() if ch in "aeiou")
        items.append(dict(
            category="text_selfref", difficulty="hard",
            prompt=(f"How many vowels (a, e, i, o, u) does the word \"{word}\" contain? "
                    f"Count repeats. {BARE_NUM}"),
            answer=str(count), scorer="numeric", meta={},
        ))
    return items


# --------------------------------------------------------------------------------------
# assembly
# --------------------------------------------------------------------------------------


def build_items(rng: random.Random) -> list[dict]:
    items: list[dict] = []

    for stem, correct, distractors, difficulty, trap in GOAL_TRACKING:
        prompt, choices, letter = mc(rng, stem, correct, distractors)
        items.append(dict(category="goal_tracking", difficulty=difficulty, prompt=prompt,
                          answer=letter, scorer="mc", choices=choices, meta={"trap": trap}))

    for stem, correct, distractors, difficulty, trap in REVERSED_MC:
        prompt, choices, letter = mc(rng, stem, correct, distractors)
        items.append(dict(category="reversed_classics", difficulty=difficulty, prompt=prompt,
                          answer=letter, scorer="mc", choices=choices, meta={"trap": trap}))

    for prompt, answer, difficulty, trap in REVERSED_NUM:
        items.append(dict(category="reversed_classics", difficulty=difficulty, prompt=prompt,
                          answer=answer, scorer="numeric", meta={"trap": trap}))

    for stem, correct, distractors, difficulty, trap in PHYSICAL:
        prompt, choices, letter = mc(rng, stem, correct, distractors)
        items.append(dict(category="physical", difficulty=difficulty, prompt=prompt,
                          answer=letter, scorer="mc", choices=choices, meta={"trap": trap}))

    for stem, correct, distractors, difficulty, trap in FALSE_PRESUPPOSITION:
        prompt, choices, letter = mc(rng, stem, correct, distractors)
        items.append(dict(category="false_presupposition", difficulty=difficulty,
                          prompt=prompt, answer=letter, scorer="mc", choices=choices,
                          meta={"trap": trap}))

    for stem, correct, distractors, difficulty, trap in FEASIBILITY_MC:
        prompt, choices, letter = mc(rng, stem, correct, distractors)
        items.append(dict(category="feasibility", difficulty=difficulty, prompt=prompt,
                          answer=letter, scorer="mc", choices=choices, meta={"trap": trap}))

    for prompt, answer, difficulty, trap in FEASIBILITY_EXACT:
        items.append(dict(category="feasibility", difficulty=difficulty, prompt=prompt,
                          answer=answer, scorer="exact", meta={"trap": trap}))

    items.extend(gen_text_selfref(rng))

    rng.shuffle(items)
    for i, item in enumerate(items, start=1):
        item_id = f"common-{i:04d}"
        item_out = {"id": item_id, "category": item["category"],
                    "difficulty": item["difficulty"], "prompt": item["prompt"],
                    "answer": item["answer"], "scorer": item["scorer"]}
        if item.get("choices"):
            item_out["choices"] = item["choices"]
        if item.get("meta"):
            item_out["meta"] = item["meta"]
        items[i - 1] = item_out
    return items


def main() -> None:
    rng = random.Random(SEED)
    items = build_items(rng)

    by_cat: dict[str, int] = {}
    by_diff: dict[str, int] = {}
    by_scorer: dict[str, int] = {}
    letters: dict[str, int] = {}
    for item in items:
        by_cat[item["category"]] = by_cat.get(item["category"], 0) + 1
        by_diff[item["difficulty"]] = by_diff.get(item["difficulty"], 0) + 1
        by_scorer[item["scorer"]] = by_scorer.get(item["scorer"], 0) + 1
        if item["scorer"] == "mc":
            letters[item["answer"]] = letters.get(item["answer"], 0) + 1

    out = L.dataset_dir(DATASET_ID)
    L.write_jsonl(out / "items.jsonl", items)

    meta = L.base_dataset_json(
        DATASET_ID,
        "Commonsense traps eval v2",
        "eval",
        (f"{len(items)} pragmatic-reasoning items built to punish pattern matching: "
         "goal-tracking errands where the tempting 'virtuous' option defeats the goal "
         "(wash the car — so the car must come along), classic riddles altered so the "
         "memorised answer is wrong, physical-consequence questions with a seductive "
         "wrong intuition, questions built on false premises with the premise-rejection "
         "offered as an option, small feasibility plans whose obvious ordering fails, "
         "and literal-text questions (letter counts, reversals) computed from the "
         "string itself."),
        ["items.jsonl"],
        len(items),
        "gen_eval_commonsense_v2.py",
        default_scorer="mc",
        scoring={
            "answer_extraction": [
                "Drop everything inside <think>...</think> (and an unterminated leading <think> block).",
                "Drop markdown code fences, keeping the fenced content.",
                "If any line matches /^\\s*(?:final answer|answer)\\s*[:\\-]\\s*(.+)$/i, take the capture of the LAST such line and use only that.",
                "Strip surrounding whitespace, matching quotes, and a single trailing '.' or '!'.",
            ],
            "scorers": {
                "mc": "Multiple choice. `choices` is a list of strings; `answer` is the letter label. Accept the bare letter, 'A)', '(A)', 'A.' or the full text of the correct choice, case-insensitively.",
                "exact": "Case-insensitive comparison after collapsing internal whitespace.",
                "numeric": "Parse the last number in the extracted output; correct when within meta.tolerance (default 1e-6) of the key.",
            },
            "pass_rule": "One item is correct or incorrect; there is no partial credit. accuracy = correct / total. An item whose request failed counts as incorrect AND is reported in scores.failures and metrics.requests_failed.",
        },
        categories=sorted(by_cat),
        difficulties=["easy", "medium", "hard"],
        counts={"by_category": by_cat, "by_difficulty": by_diff, "by_scorer": by_scorer,
                "mc_letter_balance": {k: letters[k] for k in sorted(letters)}},
        seed=SEED,
        notes=[
            "Hand-authored families (everything except text_selfref) follow the eval-format-v1 precedent: the key is typed, and every such row carries meta.trap naming the specific wrong answer the item is built to catch, for auditability.",
            "text_selfref answers are computed from the literal string by the generator.",
            "The suite is adversarial on purpose: each item has a surface pattern (a famous riddle, a 'healthy choice', a helpful-sounding count) that points at a wrong answer, and a correct answer that requires actually modelling the situation.",
            "created is the date this dataset was authored; the -v2 suffix marks the second-generation (hardened) eval wave alongside the -v2 refreshes of the saturated v1 suites.",
        ],
    )
    meta["created"] = "2026-09-01"
    L.write_json(out / "dataset.json", meta)
    L.report(DATASET_ID, len(items))
    print(f"  letters: {dict(sorted(letters.items()))}")


if __name__ == "__main__":
    main()
