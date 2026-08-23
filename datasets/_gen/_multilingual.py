"""Natively written multilingual text banks.

Every string in this file was written directly in the target language for this
repository — nothing is machine-translated and nothing is copied from an external
corpus. Topics are deliberately everyday and non-idiomatic so that the sentences
stay natural but easy to score.

Used by:
  * `gen_prompts_mixed.py`  — the `multilingual` topic (xs/s buckets only)
  * `gen_eval_multilingual.py` — translation, comprehension and word problems

Note on token counts: the repo-wide `chars/4` heuristic under-counts Latin-script
languages slightly and over-counts nothing, but for `zh`/`ja` real tokenizers
produce roughly 2-4x the heuristic value. This is stated in every dataset.json.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Sequence

LANG_NAMES = {
    "de": "German",
    "fr": "French",
    "es": "Spanish",
    "it": "Italian",
    "pt": "Portuguese",
    "ar": "Arabic",
    "zh": "Chinese (Simplified)",
    "ja": "Japanese",
    "tr": "Turkish",
}


@dataclass(frozen=True)
class LangBank:
    code: str
    #: Self-contained instructions/questions written in the language (used as xs prompts).
    prompts: Sequence[str]
    #: Coherent paragraphs, composed into longer prompts.
    paragraphs: Sequence[str]
    #: Follow-up asks in the language, appended after composed paragraphs.
    asks: Sequence[str]


BANKS: dict[str, LangBank] = {}


BANKS["de"] = LangBank(
    code="de",
    prompts=(
        "Erkläre einem Neuling in einfachen Worten, warum man Fahrradreifen regelmäßig aufpumpen sollte und woran man einen zu niedrigen Druck erkennt.",
        "Schreibe eine kurze, höfliche E-Mail an eine Vermieterin, in der du um einen Termin für die Wohnungsübergabe am Monatsende bittest.",
        "Fasse in drei Sätzen zusammen, worauf man beim Kauf einer gebrauchten Waschmaschine achten sollte, und nenne einen typischen Fehler.",
        "Beschreibe den Unterschied zwischen einem Girokonto und einem Sparkonto so, dass eine Schülerin es sofort versteht.",
        "Nenne fünf praktische Tipps, wie man in einer kleinen Küche mehr Stauraum schafft, ohne neue Möbel zu kaufen.",
        "Erkläre, warum man Brot nicht im Kühlschrank lagern sollte, und schlage eine bessere Aufbewahrung vor.",
        "Formuliere eine freundliche Nachricht an Nachbarn, in der du ankündigst, dass am Samstagvormittag gebohrt wird.",
        "Erkläre kurz, wie man in Deutschland einen Arzttermin vereinbart, wenn man neu in der Stadt ist und noch keinen Hausarzt hat.",
    ),
    paragraphs=(
        "Die Stadtbibliothek hat seit dem Umbau längere Öffnungszeiten. Wer einen Ausweis besitzt, kann Bücher jetzt auch am Sonntag zurückgeben, weil im Eingangsbereich ein Automat aufgestellt wurde. Für die Nutzung der Arbeitsplätze im Obergeschoss ist keine Anmeldung mehr nötig.",
        "Im Winter fahren die Busse auf der Linie zwölf seltener, vor allem am frühen Morgen. Die Verkehrsbetriebe begründen das mit dem geringeren Fahrgastaufkommen und mit Personalmangel. Wer pünktlich zur Arbeit kommen muss, sollte deshalb die vorherige Verbindung nehmen.",
        "Wer zum ersten Mal Brot backt, unterschätzt meistens die Gehzeit. Der Teig braucht Ruhe und eine gleichmäßige Temperatur, sonst bleibt er fest und schmeckt später fade. Ein Topf mit Deckel im heißen Ofen ersetzt dabei fast einen echten Steinofen.",
        "Viele Haushalte trennen ihren Müll sorgfältig, sind sich aber bei Verpackungen unsicher. Ein Joghurtbecher gehört in die gelbe Tonne, der Aluminiumdeckel wird aber getrennt entsorgt. Papier mit Essensresten darf nicht ins Altpapier, weil es die Wiederverwertung stört.",
        "Der Verein sucht für den Sommer Ehrenamtliche, die einmal pro Woche zwei Stunden Zeit haben. Vorkenntnisse sind nicht nötig, eine kurze Einführung findet im Mai statt. Wer Interesse hat, meldet sich am besten direkt im Büro neben dem Sportplatz.",
        "Beim Umzug in eine andere Stadt muss man sich innerhalb von zwei Wochen ummelden. Dafür braucht man den Personalausweis und eine Bestätigung des Vermieters. Viele Ämter vergeben Termine inzwischen nur noch online, was ohne Internetzugang schwierig ist.",
        "Der alte Bahnhof soll saniert werden, aber die Finanzierung ist noch nicht gesichert. Die Stadt rechnet mit mehreren Jahren Bauzeit und mit Einschränkungen für Reisende. Anwohner fürchten vor allem den Lärm und die Parkplatzsituation während der Arbeiten.",
        "Wer Pflanzen auf dem Balkon zieht, sollte auf die Himmelsrichtung achten. Nach Norden wächst kaum etwas, das viel Sonne braucht, und Tomaten bleiben klein. Kräuter wie Minze und Petersilie kommen dagegen auch mit wenig Licht zurecht.",
    ),
    asks=(
        "Fasse den Text in zwei Sätzen zusammen und nenne die wichtigste praktische Konsequenz.",
        "Beantworte auf Deutsch: Welche Personen sind von den beschriebenen Änderungen betroffen und warum?",
        "Schreibe aus dem Text eine kurze Liste mit konkreten Handlungsempfehlungen.",
    ),
)

BANKS["fr"] = LangBank(
    code="fr",
    prompts=(
        "Explique simplement à quelqu'un qui déménage pour la première fois quelles démarches administratives il ne faut surtout pas oublier.",
        "Rédige un court message poli à un voisin pour lui demander de récupérer un colis pendant ton absence de trois jours.",
        "Résume en trois phrases les avantages et les inconvénients de prendre le train plutôt que la voiture pour un trajet de deux heures.",
        "Explique la différence entre une garantie légale et une garantie commerciale lors de l'achat d'un appareil électroménager.",
        "Donne cinq conseils pratiques pour réduire sa consommation d'électricité dans un appartement sans faire de travaux.",
        "Explique pourquoi il vaut mieux arroser les plantes le soir en été, et ce qui se passe si on les arrose à midi.",
        "Écris une annonce courte et claire pour vendre un vélo d'occasion en bon état, en précisant ce qu'il faut mentionner.",
        "Explique à un étudiant étranger comment fonctionne le système des transports en commun dans une grande ville française.",
    ),
    paragraphs=(
        "La médiathèque du quartier a modifié ses horaires depuis la rentrée. Elle ouvre désormais plus tard le matin mais ferme à vingt heures du mardi au vendredi. Les inscriptions restent gratuites pour les habitants de la commune, sur présentation d'un justificatif de domicile.",
        "Le marché du samedi attire beaucoup de monde entre neuf et onze heures. Les producteurs conseillent de venir plus tôt si l'on cherche des fruits fragiles, car les meilleures caisses partent vite. En fin de matinée, en revanche, certains vendeurs baissent leurs prix.",
        "Faire du pain chez soi demande surtout de la patience. La pâte doit reposer dans un endroit tiède et à l'abri des courants d'air, sinon elle lève mal. Une cocotte en fonte préchauffée donne une croûte proche de celle d'un four professionnel.",
        "Beaucoup de locataires ignorent qu'un état des lieux détaillé les protège autant que le propriétaire. Il faut photographier chaque pièce et noter les défauts, même minimes. Sans ce document, il devient très difficile de contester une retenue sur le dépôt de garantie.",
        "L'association cherche des bénévoles pour l'été, deux heures par semaine. Aucune expérience n'est demandée et une courte formation est prévue en mai. Les personnes intéressées peuvent se présenter directement au bureau situé près du gymnase.",
        "Le chantier de la gare devrait durer plusieurs années si le financement est confirmé. Les voyageurs devront emprunter un accès provisoire par la rue latérale. Les riverains s'inquiètent surtout du bruit et de la disparition temporaire du parking.",
        "Cultiver des légumes sur un balcon dépend beaucoup de l'orientation. Au nord, presque rien ne pousse correctement et les tomates restent petites. Les herbes aromatiques, elles, supportent bien un ensoleillement limité.",
        "Le tri des emballages reste mal compris malgré les campagnes d'information. Un pot de yaourt se jette avec les plastiques, mais son couvercle en aluminium doit être séparé. Le papier souillé par de la nourriture ne doit jamais rejoindre le bac bleu.",
    ),
    asks=(
        "Résume le texte en deux phrases et indique la conséquence pratique la plus importante.",
        "Réponds en français : qui est concerné par ce qui est décrit, et pourquoi ?",
        "Transforme le texte en une courte liste de recommandations concrètes.",
    ),
)

BANKS["es"] = LangBank(
    code="es",
    prompts=(
        "Explica de forma sencilla qué trámites no hay que olvidar cuando alguien se muda de ciudad por primera vez.",
        "Escribe un mensaje breve y amable para pedirle a un vecino que recoja un paquete mientras estás de viaje.",
        "Resume en tres frases las ventajas y desventajas de ir en tren en lugar de en coche en un trayecto de dos horas.",
        "Explica la diferencia entre una cuenta corriente y una cuenta de ahorro para que lo entienda una estudiante.",
        "Da cinco consejos prácticos para gastar menos electricidad en un piso sin hacer obras ni comprar aparatos nuevos.",
        "Explica por qué conviene regar las plantas por la tarde en verano y qué ocurre si se riegan al mediodía.",
        "Redacta un anuncio corto y claro para vender una bicicleta de segunda mano en buen estado.",
        "Explica cómo se pide cita con un médico de cabecera cuando uno acaba de llegar a una ciudad nueva.",
    ),
    paragraphs=(
        "La biblioteca del barrio ha cambiado su horario desde septiembre. Ahora abre más tarde por la mañana, pero cierra a las ocho de la tarde de martes a viernes. La inscripción sigue siendo gratuita para quien viva en el municipio y presente un justificante.",
        "El mercado de los sábados se llena entre las nueve y las once. Los agricultores recomiendan llegar pronto si se buscan frutas delicadas, porque las mejores cajas se acaban enseguida. A última hora, en cambio, algunos puestos bajan los precios.",
        "Hacer pan en casa exige sobre todo paciencia. La masa necesita reposar en un lugar templado y sin corrientes de aire, o no subirá bien. Una olla de hierro precalentada da una corteza parecida a la de un horno profesional.",
        "Muchos inquilinos no saben que un inventario detallado les protege tanto como al propietario. Conviene fotografiar cada habitación y anotar cualquier desperfecto, por pequeño que sea. Sin ese documento es muy difícil reclamar la fianza.",
        "La asociación busca voluntarios para el verano, dos horas por semana. No hace falta experiencia previa y en mayo se organiza una formación breve. Quien esté interesado puede pasar por la oficina que hay junto al polideportivo.",
        "Las obras de la estación durarán varios años si se confirma la financiación. Los viajeros tendrán que usar un acceso provisional por la calle lateral. A los vecinos les preocupa sobre todo el ruido y la pérdida temporal del aparcamiento.",
        "Cultivar verduras en un balcón depende mucho de la orientación. Hacia el norte casi nada crece bien y los tomates se quedan pequeños. En cambio, las hierbas aromáticas aguantan con poca luz.",
        "El reciclaje de envases sigue generando dudas pese a las campañas informativas. Un vaso de yogur va con los plásticos, pero la tapa de aluminio se separa. El papel manchado de comida nunca debe ir al contenedor azul.",
    ),
    asks=(
        "Resume el texto en dos frases e indica la consecuencia práctica más importante.",
        "Responde en español: ¿a quién afecta lo que se describe y por qué?",
        "Convierte el texto en una lista breve de recomendaciones concretas.",
    ),
)

BANKS["it"] = LangBank(
    code="it",
    prompts=(
        "Spiega in modo semplice quali pratiche burocratiche non bisogna dimenticare quando ci si trasferisce in un'altra città.",
        "Scrivi un messaggio breve e gentile per chiedere a un vicino di ritirare un pacco mentre sei via per tre giorni.",
        "Riassumi in tre frasi i vantaggi e gli svantaggi del treno rispetto all'automobile per un viaggio di due ore.",
        "Dai cinque consigli pratici per consumare meno energia elettrica in appartamento senza fare lavori.",
        "Spiega perché conviene innaffiare le piante la sera in estate e che cosa succede se lo si fa a mezzogiorno.",
    ),
    paragraphs=(
        "La biblioteca di quartiere ha cambiato orario da settembre. Apre più tardi la mattina ma chiude alle venti dal martedì al venerdì. L'iscrizione resta gratuita per chi risiede nel comune e presenta un documento.",
        "Il mercato del sabato si riempie tra le nove e le undici. I produttori consigliano di arrivare presto per la frutta delicata, perché le cassette migliori finiscono subito. A fine mattinata, invece, alcuni banchi abbassano i prezzi.",
        "Fare il pane in casa richiede soprattutto pazienza. L'impasto deve riposare in un luogo tiepido e senza correnti d'aria, altrimenti non lievita bene. Una pentola di ghisa preriscaldata dà una crosta simile a quella di un forno professionale.",
        "I lavori alla stazione dureranno diversi anni se il finanziamento verrà confermato. I viaggiatori dovranno usare un accesso provvisorio dalla via laterale. Gli abitanti temono soprattutto il rumore e la perdita temporanea dei parcheggi.",
    ),
    asks=(
        "Riassumi il testo in due frasi e indica la conseguenza pratica più importante.",
        "Rispondi in italiano: chi è coinvolto in ciò che viene descritto e perché?",
    ),
)

BANKS["pt"] = LangBank(
    code="pt",
    prompts=(
        "Explica de forma simples que tratos administrativos não se devem esquecer quando alguém muda de cidade pela primeira vez.",
        "Escreve uma mensagem curta e simpática a pedir a um vizinho que receba uma encomenda enquanto estás fora.",
        "Resume em três frases as vantagens e desvantagens de ir de comboio em vez de carro numa viagem de duas horas.",
        "Dá cinco conselhos práticos para gastar menos eletricidade num apartamento sem fazer obras.",
        "Explica por que motivo é melhor regar as plantas ao fim da tarde no verão e o que acontece se as regarmos ao meio-dia.",
    ),
    paragraphs=(
        "A biblioteca do bairro mudou o horário desde setembro. Abre mais tarde de manhã, mas fecha às oito da noite de terça a sexta. A inscrição continua gratuita para quem mora no concelho e apresenta um comprovativo.",
        "O mercado de sábado enche entre as nove e as onze horas. Os produtores aconselham chegar cedo se procurar fruta delicada, porque as melhores caixas acabam depressa. Ao fim da manhã, no entanto, algumas bancas baixam os preços.",
        "Fazer pão em casa exige sobretudo paciência. A massa precisa de descansar num sítio morno e sem correntes de ar, senão não cresce bem. Um tacho de ferro pré-aquecido dá uma côdea parecida com a de um forno profissional.",
        "As obras da estação vão durar vários anos se o financiamento for confirmado. Os passageiros terão de usar um acesso provisório pela rua lateral. Os moradores preocupam-se sobretudo com o ruído e com a falta temporária de estacionamento.",
    ),
    asks=(
        "Resume o texto em duas frases e indica a consequência prática mais importante.",
        "Responde em português: quem é afetado pelo que é descrito e porquê?",
    ),
)

BANKS["ar"] = LangBank(
    code="ar",
    prompts=(
        "اشرح بأسلوب بسيط ما هي الإجراءات الإدارية التي لا ينبغي نسيانها عند الانتقال إلى مدينة جديدة لأول مرة.",
        "اكتب رسالة قصيرة ومهذبة تطلب فيها من الجار استلام طرد بريدي أثناء سفرك لمدة ثلاثة أيام.",
        "لخّص في ثلاث جمل مزايا وعيوب السفر بالقطار بدل السيارة في رحلة تستغرق ساعتين.",
        "اشرح الفرق بين الحساب الجاري وحساب التوفير بطريقة تفهمها طالبة في المرحلة الثانوية.",
        "اذكر خمس نصائح عملية لتقليل استهلاك الكهرباء في شقة صغيرة دون شراء أجهزة جديدة.",
        "اشرح لماذا يُفضَّل سقي النباتات في المساء خلال الصيف، وما الذي يحدث إذا سقيناها عند الظهيرة.",
        "اكتب إعلانًا قصيرًا وواضحًا لبيع دراجة هوائية مستعملة في حالة جيدة، مع ذكر أهم التفاصيل.",
        "اشرح كيف يحجز شخص وصل حديثًا إلى المدينة موعدًا لدى طبيب عام، خطوة بخطوة.",
    ),
    paragraphs=(
        "غيّرت مكتبة الحي مواعيد العمل منذ شهر أيلول. صارت تفتح في وقت متأخر صباحًا لكنها تغلق في الثامنة مساءً من الثلاثاء إلى الجمعة. ما زال الاشتراك مجانيًا لسكان المدينة عند تقديم ما يثبت العنوان.",
        "يزدحم سوق السبت بين التاسعة والحادية عشرة صباحًا. ينصح المزارعون بالحضور مبكرًا لمن يبحث عن الفواكه سريعة التلف، لأن أفضل الصناديق تنفد بسرعة. أما في نهاية الصباح فيخفض بعض الباعة أسعارهم.",
        "خبز المنزل يحتاج إلى الصبر أكثر من أي شيء آخر. يجب أن ترتاح العجينة في مكان دافئ بعيد عن تيارات الهواء، وإلا فلن تنتفخ جيدًا. وتعطي القدر الحديدية المسخّنة مسبقًا قشرة قريبة من قشرة الأفران المهنية.",
        "لا يعرف كثير من المستأجرين أن محضر التسليم المفصل يحميهم بقدر ما يحمي المالك. من الأفضل تصوير كل غرفة وتسجيل أي عيب مهما كان صغيرًا. فبدون هذه الوثيقة يصعب جدًا استرداد مبلغ التأمين.",
        "تبحث الجمعية عن متطوعين لفصل الصيف بواقع ساعتين أسبوعيًا. لا تُشترط خبرة سابقة، وهناك تدريب قصير في أيار. من يرغب في المشاركة يمكنه المرور على المكتب المجاور للملعب.",
        "ستستمر أعمال محطة القطار سنوات عدة إذا تأكد التمويل. سيضطر المسافرون إلى استخدام مدخل مؤقت من الشارع الجانبي. ويقلق السكان أكثر ما يقلقهم الضجيج واختفاء مواقف السيارات مؤقتًا.",
        "تعتمد زراعة الخضار في الشرفة على اتجاهها بدرجة كبيرة. فإلى الشمال لا ينمو تقريبًا أي نبات يحتاج إلى شمس كثيرة، وتبقى ثمار الطماطم صغيرة. أما الأعشاب مثل النعناع والبقدونس فتتحمل الضوء القليل.",
        "ما زال فرز النفايات غير واضح لكثير من الناس رغم الحملات التوعوية. توضع عبوة اللبن مع البلاستيك، لكن غطاءها المعدني يُفصل عنها. والورق الملوث ببقايا الطعام لا يوضع أبدًا مع الورق النظيف.",
    ),
    asks=(
        "لخّص النص في جملتين واذكر أهم نتيجة عملية تترتب عليه.",
        "أجب بالعربية: من المعني بما ورد في النص ولماذا؟",
        "حوّل النص إلى قائمة قصيرة من التوصيات العملية.",
    ),
)

BANKS["zh"] = LangBank(
    code="zh",
    prompts=(
        "请用简单的语言解释，第一次搬到另一个城市时有哪些手续绝对不能忘记办理，并说明为什么这些手续很重要。",
        "请写一段简短而礼貌的留言，请邻居在你外出三天期间帮忙代收快递，并说明快递大概什么时候会到。",
        "请用三句话总结，两个小时的行程里坐火车与开车各有什么优点和缺点，最后给出你的建议。",
        "请向一位高中生解释活期账户和储蓄账户的区别，尽量避免使用专业术语，并举一个日常的例子。",
        "请给出五条实用建议，说明在不装修、也不购买新电器的情况下，如何减少一套小公寓的用电量。",
        "请解释为什么夏天最好在傍晚给植物浇水，如果中午浇水会发生什么，并说明背后的原因。",
        "请写一则简短清晰的二手自行车出售启事，说明车况、价格和联系方式应该怎么写才可信。",
        "请一步一步说明，一个刚搬到新城市、还没有固定医生的人，应该如何预约看病。",
    ),
    paragraphs=(
        "社区图书馆从九月开始调整了开放时间。早上开门比以前晚，但周二到周五要到晚上八点才关门。只要能出示居住证明，本地居民办证仍然免费。",
        "周六的集市在上午九点到十一点之间最热闹。摊主建议想买容易坏的水果的人早点来，因为最好的几箱很快就卖完了。不过临近中午的时候，有些摊位反而会降价。",
        "在家做面包最需要的其实是耐心。面团必须放在温暖、没有穿堂风的地方醒发，否则就发不起来。提前预热的铸铁锅可以烤出接近专业烤箱的外皮。",
        "很多租客不知道，一份详细的交接记录既保护房东，也保护自己。最好把每个房间都拍下来，再小的损坏也要写清楚。没有这份文件，押金很难要得回来。",
        "协会正在招募暑期志愿者，每周只需要两个小时。不要求任何经验，五月还会安排一次简短的培训。有兴趣的人可以直接到体育场旁边的办公室报名。",
        "如果资金落实，火车站的改造工程会持续好几年。这期间旅客只能从侧面的临时通道进出。附近居民最担心的是噪音，以及施工期间停车位不够用。",
        "在阳台上种菜，朝向的影响非常大。朝北的阳台几乎种不好需要阳光的作物，番茄也长不大。相反，薄荷和香菜这类香草在光线不足时也能活。",
        "尽管宣传了很多年，包装垃圾的分类仍然让人困惑。酸奶杯应该扔进塑料类，但铝制的盖子要单独分开。沾了食物残渣的纸不能放进废纸回收桶。",
    ),
    asks=(
        "请用两句话概括上面的内容，并指出最重要的实际影响。",
        "请用中文回答：上面描述的情况会影响到哪些人？为什么？",
        "请把上面的内容整理成一份简短的行动建议清单。",
    ),
)

BANKS["ja"] = LangBank(
    code="ja",
    prompts=(
        "初めて別の都市へ引っ越すときに、絶対に忘れてはいけない手続きは何か、理由もあわせて分かりやすく説明してください。",
        "三日間留守にするあいだ、宅配便を代わりに受け取ってほしいと隣人に頼む、短くて丁寧なメッセージを書いてください。",
        "二時間の移動で電車と自動車のどちらを選ぶべきか、それぞれの長所と短所を三文でまとめ、最後に結論を書いてください。",
        "普通預金口座と定期預金口座の違いを、高校生にも分かるように、専門用語を使わずに説明してください。",
        "工事をせず、新しい家電も買わずに、小さなアパートの電気使用量を減らす実用的な方法を五つ挙げてください。",
        "夏に植物へ水をやるなら夕方がよいのはなぜか、真昼に水をやるとどうなるかを、理由とともに説明してください。",
        "状態のよい中古自転車を売るための、短くて分かりやすい告知文を書いてください。何を書くと信頼されるかも説明してください。",
        "引っ越したばかりでかかりつけ医がいない人が診察を予約する手順を、順を追って説明してください。",
    ),
    paragraphs=(
        "地域の図書館は九月から開館時間が変わりました。朝は以前より遅く開きますが、火曜から金曜は夜八時まで開いています。住所を証明する書類があれば、市内に住む人の利用登録は今も無料です。",
        "土曜日の市場は午前九時から十一時ごろが一番混みます。傷みやすい果物を買いたい人は早めに行くとよいと、生産者はすすめています。ただし昼前になると値段を下げる店もあります。",
        "家でパンを焼くときに一番必要なのは、実は忍耐です。生地は暖かく風の当たらない場所で休ませないと、うまく膨らみません。あらかじめ熱した鋳物の鍋を使うと、専門店に近い皮が焼き上がります。",
        "詳しい引き渡し記録は、大家だけでなく借り手も守ってくれることを知らない人が多いようです。各部屋を写真に撮り、小さな傷でも書き残しておくとよいでしょう。この書類がないと、敷金の返還を求めるのは非常に難しくなります。",
        "協会では夏のあいだ、週に二時間だけ手伝ってくれるボランティアを探しています。経験は必要なく、五月には短い研修も行われます。興味のある人は、運動場のとなりの事務所へ直接来てください。",
        "駅の改修工事は、資金の見通しが立てば数年かかる見込みです。その間、利用者は側面の仮設通路を通ることになります。近隣の住民が最も心配しているのは、騒音と駐車場が一時的に減ることです。",
        "ベランダで野菜を育てられるかどうかは、方角に大きく左右されます。北向きでは日光を必要とする作物はほとんど育たず、トマトも大きくなりません。一方、ミントやパセリのような香草は光が少なくても育ちます。",
        "長年の広報にもかかわらず、容器包装の分別はいまだに分かりにくいままです。ヨーグルトの容器はプラスチックですが、アルミのふたは分けて捨てます。食べ物が付いた紙は、古紙の回収に出してはいけません。",
    ),
    asks=(
        "上の文章を二文で要約し、最も重要な実際上の影響を挙げてください。",
        "日本語で答えてください。ここで書かれていることは誰に影響し、それはなぜですか。",
        "上の文章を、短い実践的な提案のリストにまとめてください。",
    ),
)

BANKS["tr"] = LangBank(
    code="tr",
    prompts=(
        "Başka bir şehre ilk kez taşınan biri için unutulmaması gereken resmi işlemleri basit bir dille anlat.",
        "Üç gün şehir dışında olacağın için kargonu teslim alması amacıyla komşuna kısa ve kibar bir mesaj yaz.",
        "İki saatlik bir yolculukta trenle gitmenin arabayla gitmeye göre avantaj ve dezavantajlarını üç cümlede özetle.",
        "Tadilat yapmadan ve yeni cihaz almadan bir dairede elektrik tüketimini azaltmak için beş pratik öneri ver.",
        "Yazın bitkileri neden akşam sulamanın daha iyi olduğunu, öğle saatinde sulanırsa ne olacağını açıkla.",
    ),
    paragraphs=(
        "Mahalle kütüphanesi eylül ayından beri çalışma saatlerini değiştirdi. Sabahları daha geç açılıyor ama salıdan cumaya akşam sekize kadar açık kalıyor. İkametini belgeleyen şehir sakinleri için üyelik hâlâ ücretsiz.",
        "Cumartesi pazarı en çok dokuz ile on bir arasında kalabalık oluyor. Üreticiler, çabuk bozulan meyve arayanların erken gelmesini öneriyor; en iyi kasalar hızla tükeniyor. Öğleye doğru ise bazı tezgâhlar fiyat indiriyor.",
        "Evde ekmek yapmanın en çok gerektirdiği şey sabır. Hamurun ılık ve hava akımı olmayan bir yerde dinlenmesi gerekir, yoksa iyi kabarmaz. Önceden ısıtılmış döküm bir tencere, profesyonel fırına yakın bir kabuk verir.",
        "Finansman onaylanırsa gar çalışmaları birkaç yıl sürecek. Bu süre boyunca yolcular yan sokaktaki geçici girişi kullanacak. Çevre sakinlerini en çok gürültü ve otoparkın geçici olarak kapanması endişelendiriyor.",
    ),
    asks=(
        "Metni iki cümlede özetle ve en önemli pratik sonucu belirt.",
        "Türkçe yanıtla: Anlatılan durumdan kimler etkileniyor ve neden?",
    ),
)


#: Languages used by the `multilingual` topic of prompts-mixed-v1.
PROMPT_LANGS = ("de", "fr", "es", "ar", "zh", "ja")
#: Languages used by eval-multilingual-v1.
EVAL_LANGS = ("de", "fr", "es", "it", "pt", "ar", "zh", "ja", "tr")
