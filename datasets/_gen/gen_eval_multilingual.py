# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Generate `datasets/eval-multilingual-v1/`.

80 items across German, French, Spanish, Italian, Portuguese, Arabic, Chinese,
Japanese and Turkish:

  * 24 translations from English into one of those languages, scored leniently on
    key tokens rather than on an exact string;
  * 16 translations from a natively written sentence into English;
  * 20 reading-comprehension multiple-choice items whose passage, question and
    options are all in the target language;
  * 20 arithmetic word problems stated in the target language with a computed
    numeric answer — these separate "understands the language" from "writes the
    language".

Every non-English string in this file was written directly in that language for
this repository. Key-token lists include spelling variants with and without
diacritics, because the `contains` scorer does not fold them.

Run: `uv run datasets/_gen/gen_eval_multilingual.py`
"""

from __future__ import annotations

import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import _lib as L  # noqa: E402
import _multilingual as ML  # noqa: E402

SEED = 20260908
DATASET_ID = "eval-multilingual-v1"
LETTERS = "ABCD"

#: (source sentence, target language code, key tokens; a nested list means "any of these")
TO_TARGET = [
    ("The station is closed on Sunday.", "de", ["bahnhof", "sonntag", ["geschlossen", "zu"]]),
    ("The station is closed on Sunday.", "fr", ["gare", "dimanche", ["fermée", "fermee", "fermé", "ferme"]]),
    ("The station is closed on Sunday.", "es", [["estación", "estacion"], "domingo",
                                                ["cerrada", "cerrado"]]),
    ("I would like a coffee without sugar, please.", "it", [["caffè", "caffe"], "zucchero", "senza"]),
    ("I would like a coffee without sugar, please.", "pt", [["café", "cafe"], ["açúcar", "acucar"], "sem"]),
    ("I would like a coffee without sugar, please.", "tr", ["kahve", ["şeker", "seker"]]),
    ("The meeting starts at half past three.", "de", [["besprechung", "sitzung", "treffen", "meeting"],
                                                      "halb", "drei"]),
    ("The meeting starts at half past three.", "fr", [["réunion", "reunion"], "trois",
                                                      ["demie", "heure"]]),
    ("The meeting starts at half past three.", "ar", [["الاجتماع", "اجتماع"],
                                                      ["الثالثة", "ثلاث"], ["النصف", "نصف"]]),
    ("Where is the nearest pharmacy?", "es", ["farmacia", ["dónde", "donde"],
                                              ["cercana", "cerca", "próxima", "proxima"]]),
    ("Where is the nearest pharmacy?", "zh", [["药店", "药房"], ["哪里", "在哪", "哪儿"]]),
    ("Where is the nearest pharmacy?", "ja", ["薬局", ["どこ", "何処"]]),
    ("My train was delayed by twenty minutes.", "de", ["zug", "zwanzig", ["minuten", "verspätung",
                                                                          "verspatung", "verspätet"]]),
    ("My train was delayed by twenty minutes.", "ja", [["電車", "列車"], ["20", "二十"],
                                                       ["遅れ", "遅延"]]),
    ("My train was delayed by twenty minutes.", "tr", ["tren", "yirmi", ["dakika", "gecik"]]),
    ("Please send me the invoice by email.", "fr", ["facture", ["e-mail", "email", "courriel"],
                                                    ["envoy", "adress"]]),
    ("Please send me the invoice by email.", "pt", [["fatura", "factura"], ["e-mail", "email"],
                                                    ["envi", "mand"]]),
    ("Please send me the invoice by email.", "ar", [["الفاتورة", "فاتورة"], "البريد",
                                                    ["أرسل", "ارسل", "إرسال", "ارسال"]]),
    ("The library opens later on Tuesdays.", "it", ["biblioteca", ["martedì", "martedi"],
                                                    ["apre", "tardi"]]),
    ("The library opens later on Tuesdays.", "zh", ["图书馆", ["周二", "星期二"], ["晚", "迟"]]),
    ("The library opens later on Tuesdays.", "de", ["bibliothek", ["dienstag", "dienstags"],
                                                    ["später", "spater", "spät"]]),
    ("We need two more chairs for the meeting room.", "es", [["sillas", "silla"], "dos",
                                                             ["sala", "reunión", "reunion"]]),
    ("We need two more chairs for the meeting room.", "ar", [["كرسي", "كراسي", "كرسيين"],
                                                             ["اجتماع", "الاجتماع"],
                                                             ["غرفة", "قاعة"]]),
    ("We need two more chairs for the meeting room.", "ja", ["椅子", ["2", "二", "ふた"],
                                                             ["会議", "ミーティング"]]),
]

#: (native sentence, language code, English key tokens)
TO_ENGLISH = [
    ("Der Zug fährt heute von Gleis vier ab.", "de", ["train", ["platform", "track"],
                                                      ["four", "4"]]),
    ("Die Bibliothek hat am Sonntag geschlossen.", "de", ["library", "sunday", ["closed", "shut"]]),
    ("Le marché ouvre à huit heures du matin.", "fr", ["market", ["open"], ["eight", "8"]]),
    ("Je voudrais réserver une table pour quatre personnes.", "fr", [["book", "reserve"], "table",
                                                                     ["four", "4"]]),
    ("La reunión se ha aplazado hasta el jueves.", "es", ["meeting", ["postponed", "moved",
                                                                     "delayed", "put off"],
                                                          "thursday"]),
    ("El ascensor está fuera de servicio desde ayer.", "es", [["lift", "elevator"],
                                                              ["out of service", "out of order",
                                                               "not working", "broken"],
                                                              "yesterday"]),
    ("Il treno delle nove è in ritardo di dieci minuti.", "it", ["train", ["late", "delay"],
                                                                 ["ten", "10"]]),
    ("Il negozio chiude alle sette di sera.", "it", [["shop", "store"], "close", ["seven", "7"]]),
    ("A reunião foi adiada para sexta-feira.", "pt", ["meeting", ["postponed", "moved", "delayed",
                                                                 "put off"], "friday"]),
    ("O comboio parte da plataforma dois.", "pt", ["train", ["platform", "track"], ["two", "2"]]),
    ("سيغلق المتحف أبوابه في الساعة الخامسة.", "ar", ["museum", ["close", "shut"], ["five", "5"]]),
    ("لا يوجد ماء ساخن في الشقة منذ أمس.", "ar", [["hot water", "no hot water"],
                                                   ["flat", "apartment"], "yesterday"]),
    ("这家商店周一不营业。", "zh", [["shop", "store"], "monday", ["closed", "not open", "does not open"]]),
    ("会议改到下午三点。", "zh", ["meeting", ["three", "3"], ["afternoon", "pm"]]),
    ("この電車は次の駅で止まりません。", "ja", ["train", ["stop"], ["next station", "next stop"]]),
    ("会議は水曜日に延期されました。", "ja", ["meeting", "wednesday", ["postponed", "moved",
                                                                      "delayed", "put off"]]),
]

#: (language code, passage, question, correct option, three distractors)
COMPREHENSION = [
    ("de",
     "Die Stadtbibliothek öffnet ab September später am Morgen, schließt dafür aber von Dienstag "
     "bis Freitag erst um zwanzig Uhr. Der Ausweis bleibt für Einwohner der Stadt kostenlos.",
     "Was hat sich seit September geändert?",
     "Die Bibliothek öffnet morgens später und schließt abends später.",
     ["Die Bibliothek ist am Wochenende geschlossen.",
      "Der Ausweis kostet jetzt Geld.",
      "Die Bibliothek ist umgezogen."]),
    ("de",
     "Wer in eine andere Stadt zieht, muss sich innerhalb von zwei Wochen ummelden. Dafür braucht "
     "man den Personalausweis und eine Bestätigung des Vermieters.",
     "Was braucht man für die Ummeldung?",
     "Den Personalausweis und eine Bestätigung des Vermieters.",
     ["Nur den Mietvertrag.", "Einen Reisepass und ein Foto.", "Eine Bescheinigung der Bank."]),
    ("fr",
     "Le marché du samedi attire beaucoup de monde entre neuf et onze heures. Les producteurs "
     "conseillent de venir tôt pour les fruits fragiles, car les meilleures caisses partent vite.",
     "Pourquoi faut-il venir tôt au marché ?",
     "Parce que les meilleurs fruits fragiles partent rapidement.",
     ["Parce que le marché ferme à neuf heures.",
      "Parce que les prix montent le matin.",
      "Parce qu'il y a moins de monde à onze heures."]),
    ("fr",
     "L'état des lieux protège autant le locataire que le propriétaire. Il faut photographier "
     "chaque pièce et noter les défauts, même petits, sinon il est difficile de contester une "
     "retenue sur le dépôt de garantie.",
     "Que conseille le texte au locataire ?",
     "De photographier chaque pièce et de noter les défauts.",
     ["De payer le dépôt de garantie en espèces.",
      "De refuser l'état des lieux.",
      "De demander une réduction de loyer."]),
    ("es",
     "El mercado de los sábados se llena entre las nueve y las once. Los agricultores recomiendan "
     "llegar pronto si se buscan frutas delicadas, porque las mejores cajas se acaban enseguida.",
     "¿Qué recomiendan los agricultores?",
     "Llegar pronto si se buscan frutas delicadas.",
     ["Comprar solo al final de la mañana.",
      "Ir al mercado los domingos.",
      "Pedir un descuento por la fruta."]),
    ("es",
     "La biblioteca del barrio abre más tarde por la mañana desde septiembre, pero cierra a las "
     "ocho de la tarde de martes a viernes. La inscripción sigue siendo gratuita.",
     "¿Cuánto cuesta la inscripción?",
     "Nada, sigue siendo gratuita.",
     ["Ocho euros al año.", "Depende del barrio.", "Es gratuita solo para estudiantes."]),
    ("it",
     "La biblioteca di quartiere apre più tardi la mattina ma chiude alle venti dal martedì al "
     "venerdì. L'iscrizione resta gratuita per chi risiede nel comune.",
     "A che ora chiude la biblioteca dal martedì al venerdì?",
     "Alle venti.",
     ["Alle diciotto.", "A mezzogiorno.", "Alle ventidue."]),
    ("it",
     "Fare il pane in casa richiede soprattutto pazienza: l'impasto deve riposare in un luogo "
     "tiepido e senza correnti d'aria, altrimenti non lievita bene.",
     "Di che cosa ha bisogno l'impasto?",
     "Di riposare in un luogo tiepido e senza correnti d'aria.",
     ["Di essere lavorato a lungo con il mattarello.",
      "Di essere messo subito in frigorifero.",
      "Di molto più sale."]),
    ("pt",
     "As obras da estação vão durar vários anos se o financiamento for confirmado. Os passageiros "
     "terão de usar um acesso provisório pela rua lateral.",
     "O que terão de fazer os passageiros?",
     "Usar um acesso provisório pela rua lateral.",
     ["Apanhar o autocarro em vez do comboio.",
      "Comprar um bilhete mais caro.",
      "Esperar o fim das obras para viajar."]),
    ("pt",
     "A biblioteca do bairro abre mais tarde de manhã, mas fecha às oito da noite de terça a "
     "sexta. A inscrição continua gratuita para quem mora no concelho.",
     "Quem pode inscrever-se gratuitamente?",
     "Quem mora no concelho.",
     ["Apenas os estudantes.", "Apenas quem tem mais de 65 anos.", "Ninguém, agora paga-se."]),
    ("ar",
     "غيّرت مكتبة الحي مواعيد العمل منذ شهر أيلول، فصارت تفتح متأخرة صباحًا وتغلق في الثامنة مساءً "
     "من الثلاثاء إلى الجمعة. وما زال الاشتراك مجانيًا لسكان المدينة.",
     "متى تغلق المكتبة من الثلاثاء إلى الجمعة؟",
     "في الثامنة مساءً.",
     ["عند الظهر.", "في السادسة صباحًا.", "في العاشرة مساءً."]),
    ("ar",
     "تبحث الجمعية عن متطوعين لفصل الصيف بواقع ساعتين أسبوعيًا، ولا تُشترط خبرة سابقة، وهناك تدريب "
     "قصير في أيار.",
     "ما الذي تشترطه الجمعية على المتطوعين؟",
     "لا تشترط خبرة سابقة.",
     ["تشترط خبرة خمس سنوات.", "تشترط دفع رسوم اشتراك.", "تشترط العمل يوميًا."]),
    ("zh",
     "社区图书馆从九月开始调整了开放时间：早上开门比以前晚，但周二到周五要到晚上八点才关门。只要能出示居住证明，本地居民办证仍然免费。",
     "本地居民办证需要付钱吗？",
     "不需要，仍然免费。",
     ["需要，每年二十元。", "只有学生免费。", "需要先预约再付费。"]),
    ("zh",
     "如果资金落实，火车站的改造工程会持续好几年。这期间旅客只能从侧面的临时通道进出。",
     "施工期间旅客怎么进出车站？",
     "只能从侧面的临时通道进出。",
     ["从正门照常进出。", "必须改乘公共汽车。", "车站会完全关闭。"]),
    ("ja",
     "地域の図書館は九月から開館時間が変わりました。朝は以前より遅く開きますが、火曜から金曜は夜八時まで開いています。",
     "火曜から金曜は何時まで開いていますか。",
     "夜八時までです。",
     ["夕方五時までです。", "昼十二時までです。", "夜十時までです。"]),
    ("ja",
     "詳しい引き渡し記録は、大家だけでなく借り手も守ってくれます。各部屋を写真に撮り、小さな傷でも書き残しておくとよいでしょう。",
     "借り手は何をするとよいと書かれていますか。",
     "各部屋を写真に撮り、傷を書き残すこと。",
     ["敷金を現金で払うこと。", "引き渡し記録を断ること。", "家賃の値下げを求めること。"]),
    ("tr",
     "Mahalle kütüphanesi eylül ayından beri sabahları daha geç açılıyor ama salıdan cumaya akşam "
     "sekize kadar açık kalıyor.",
     "Kütüphane salıdan cumaya saat kaça kadar açık?",
     "Akşam sekize kadar.",
     ["Öğlen on ikiye kadar.", "Akşam altıya kadar.", "Gece ona kadar."]),
    ("tr",
     "Evde ekmek yapmanın en çok gerektirdiği şey sabırdır. Hamurun ılık ve hava akımı olmayan bir "
     "yerde dinlenmesi gerekir.",
     "Hamurun nerede dinlenmesi gerekir?",
     "Ilık ve hava akımı olmayan bir yerde.",
     ["Buzdolabında.", "Açık pencerenin önünde.", "Sıcak fırının içinde."]),
    ("de",
     "Wer Pflanzen auf dem Balkon zieht, sollte auf die Himmelsrichtung achten. Nach Norden wächst "
     "kaum etwas, das viel Sonne braucht, Kräuter wie Minze kommen aber mit wenig Licht zurecht.",
     "Was wächst auf einem Balkon nach Norden gut?",
     "Kräuter wie Minze.",
     ["Tomaten.", "Sonnenblumen.", "Weintrauben."]),
    ("fr",
     "Cultiver des légumes sur un balcon dépend beaucoup de l'orientation : au nord, les tomates "
     "restent petites, alors que les herbes aromatiques supportent bien un ensoleillement limité.",
     "Que dit le texte des tomates sur un balcon au nord ?",
     "Elles restent petites.",
     ["Elles poussent mieux qu'au sud.", "Elles n'ont pas besoin d'eau.",
      "Elles mûrissent plus tôt."]),
]

#: (language code, template, answer function) — numbers are filled in by the generator
WORD_PROBLEMS = [
    ("de", "Ein Zug fährt {a} Stunden lang mit {b} Kilometern pro Stunde. Wie viele Kilometer legt "
           "er zurück? Antworte nur mit der Zahl.", lambda a, b: a * b),
    ("de", "Ein Buch kostet {a} Euro. Wie viel kosten {b} Bücher? Antworte nur mit der Zahl.",
     lambda a, b: a * b),
    ("fr", "Un train roule pendant {a} heures à {b} kilomètres par heure. Combien de kilomètres "
           "parcourt-il ? Réponds uniquement avec le nombre.", lambda a, b: a * b),
    ("fr", "Un carnet coûte {a} euros. Combien coûtent {b} carnets ? Réponds uniquement avec le "
           "nombre.", lambda a, b: a * b),
    ("es", "Un tren circula durante {a} horas a {b} kilómetros por hora. ¿Cuántos kilómetros "
           "recorre? Responde solo con el número.", lambda a, b: a * b),
    ("es", "Una caja contiene {a} manzanas. ¿Cuántas manzanas hay en {b} cajas? Responde solo con "
           "el número.", lambda a, b: a * b),
    ("it", "Un treno viaggia per {a} ore a {b} chilometri all'ora. Quanti chilometri percorre? "
           "Rispondi solo con il numero.", lambda a, b: a * b),
    ("it", "Una scatola contiene {a} mele. Quante mele ci sono in {b} scatole? Rispondi solo con "
           "il numero.", lambda a, b: a * b),
    ("pt", "Um comboio viaja durante {a} horas a {b} quilómetros por hora. Quantos quilómetros "
           "percorre? Responde apenas com o número.", lambda a, b: a * b),
    ("pt", "Uma caixa tem {a} laranjas. Quantas laranjas há em {b} caixas? Responde apenas com o "
           "número.", lambda a, b: a * b),
    ("ar", "يسير قطار لمدة {a} ساعات بسرعة {b} كيلومترًا في الساعة. كم كيلومترًا يقطع؟ أجب بالرقم فقط.",
     lambda a, b: a * b),
    ("ar", "في الصندوق {a} تفاحات. كم تفاحة في {b} صندوقًا؟ أجب بالرقم فقط.", lambda a, b: a * b),
    ("zh", "一列火车以每小时{b}公里的速度行驶了{a}小时，一共行驶了多少公里？只回答数字。",
     lambda a, b: a * b),
    ("zh", "一个箱子里有{a}个苹果，{b}个箱子里一共有多少个苹果？只回答数字。", lambda a, b: a * b),
    ("ja", "電車が時速{b}キロメートルで{a}時間走りました。何キロメートル進みましたか。数字だけで答えてください。",
     lambda a, b: a * b),
    ("ja", "箱の中にりんごが{a}個あります。{b}箱では全部で何個ですか。数字だけで答えてください。",
     lambda a, b: a * b),
    ("tr", "Bir tren {a} saat boyunca saatte {b} kilometre hızla gidiyor. Kaç kilometre yol alır? "
           "Sadece sayıyla cevap ver.", lambda a, b: a * b),
    ("tr", "Bir kutuda {a} elma var. {b} kutuda toplam kaç elma vardır? Sadece sayıyla cevap ver.",
     lambda a, b: a * b),
    ("de", "Ein Kurs dauert {a} Wochen mit je {b} Stunden. Wie viele Stunden sind das insgesamt? "
           "Antworte nur mit der Zahl.", lambda a, b: a * b),
    ("es", "Un curso dura {a} semanas con {b} horas cada semana. ¿Cuántas horas son en total? "
           "Responde solo con el número.", lambda a, b: a * b),
]


def main() -> None:
    rng = random.Random(SEED)
    rows: list[dict] = []

    def add(category, difficulty, prompt, answer, scorer, **extra):
        rows.append({
            "id": f"lang-{len(rows) + 1:04d}",
            "category": category,
            "difficulty": difficulty,
            "prompt": prompt,
            "answer": answer,
            "scorer": scorer,
            **extra,
        })

    for sentence, code, tokens in TO_TARGET:
        language = ML.LANG_NAMES[code]
        add("translate_to", "medium",
            f"Translate the following English sentence into {language}. Reply with the "
            f"translation only.\n\n{sentence}",
            {"all": tokens}, "contains",
            meta={"language": code, "direction": "en->" + code, "source": sentence})

    for sentence, code, tokens in TO_ENGLISH:
        language = ML.LANG_NAMES[code]
        add("translate_from", "medium",
            f"Translate the following {language} sentence into English. Reply with the "
            f"translation only.\n\n{sentence}",
            {"all": tokens}, "contains",
            meta={"language": code, "direction": code + "->en", "source": sentence})

    for position, (code, passage, question, correct, distractors) in enumerate(COMPREHENSION):
        options = [correct, *distractors]
        rng.shuffle(options)
        # spread the correct letter evenly over A-D rather than leaving it to the shuffle
        shift = (options.index(correct) - position % 4) % 4
        options = options[shift:] + options[:shift]
        rendered = "\n".join(f"{LETTERS[i]}. {opt}" for i, opt in enumerate(options))
        add("comprehension", "medium",
            f"{passage}\n\n{question}\n\n{rendered}",
            LETTERS[options.index(correct)], "mc",
            choices=options, meta={"language": code})

    for code, template, compute in WORD_PROBLEMS:
        # Arabic counts 3-10 take the plural noun; 11 and above take the singular, so the
        # Arabic templates only ever see a number the sentence stays grammatical with.
        # Arabic also needs 11+ for the second noun, which takes the singular accusative.
        a = rng.randint(3, 10) if code == "ar" else rng.randint(3, 19)
        b = rng.randint(11, 60) if code == "ar" else rng.randint(4, 60)
        add("word_problem", "medium", template.format(a=a, b=b), str(compute(a, b)), "numeric",
            meta={"language": code, "values": [a, b]})

    assert len(rows) == 80, len(rows)
    assert len({r["prompt"] for r in rows}) == len(rows), "duplicate prompt"

    languages: dict[str, int] = {}
    for row in rows:
        code = row["meta"]["language"]
        languages[code] = languages.get(code, 0) + 1

    d = L.dataset_dir(DATASET_ID)
    n = L.write_jsonl(d / "items.jsonl", rows)
    L.write_json(
        d / "dataset.json",
        L.eval_dataset_json(
            DATASET_ID,
            "Multilingual eval v1",
            "80 items in nine languages: 24 English-to-target translations scored on key tokens, "
            "16 target-to-English translations, 20 reading-comprehension multiple-choice items "
            "written entirely in the target language, and 20 arithmetic word problems stated in "
            "the target language with a numeric answer.",
            rows,
            "gen_eval_multilingual.py",
            "contains",
            seed=SEED,
            languages={ML.LANG_NAMES[c]: v for c, v in sorted(languages.items())},
            notes=[
                "Translation items use the `contains` scorer with an extended `all` list: an "
                "entry that is itself a list passes when ANY of its alternatives is found. That "
                "is how 'fermée'/'ferme' and '20'/'二十' are both accepted.",
                "Matching is a casefolded substring test with no diacritic folding, so every "
                "accented form that a competent translator might write is listed explicitly.",
                "Word problems isolate comprehension from production: the model has to read the "
                "language but only has to write a number.",
                "The chars/4 token heuristic under-counts Chinese and Japanese by roughly 2-4x; "
                "budget max_tokens accordingly.",
            ],
        ),
    )
    L.report(DATASET_ID, n)


if __name__ == "__main__":
    main()
