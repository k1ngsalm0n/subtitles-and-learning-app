import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { LANGUAGES, detectLanguage, languageName } from "../public/js/languages.mjs";
import { languageName as llmLanguageName } from "../server/llmTranslate.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

const table = JSON.parse(
  readFileSync(path.join(ROOT, "public", "data", "languages.json"), "utf8"),
);

// The three consumers now read public/data/languages.json instead of keeping
// their own copies (#32), so drift is structurally impossible. What is still
// worth guarding is the table itself — a row missing its Flores code, or an
// `offered` entry naming a language that isn't there, would take out the
// translate bar — and that each consumer really is reading it.
test("every language in the table has a name and a Flores-200 code (#32)", () => {
  const bad = table.languages.filter(
    (l) => !/^[a-z]{2,3}$/.test(l.code || "") || !l.name || !/^[a-z]{3}_[A-Z][a-z]{3}$/.test(l.nllb || ""),
  );
  assert.deepEqual(bad, [], "malformed rows in public/data/languages.json");

  const codes = table.languages.map((l) => l.code);
  assert.equal(new Set(codes).size, codes.length, "duplicate language codes");
});

test("the translate bar only offers languages the table describes (#32)", () => {
  const codes = new Set(table.languages.map((l) => l.code));
  const unknown = (table.offered || []).filter((code) => !codes.has(code));
  assert.deepEqual(unknown, [], "`offered` names languages missing from `languages`");

  // CHINESE-ONLY (temporary, #65): `offered` trims the bar to a subset, so the
  // invariant is "the UI never offers a language the server can't translate".
  // Dropping the key offers them all, and this still holds.
  assert.deepEqual(
    LANGUAGES.map((l) => l.code),
    table.offered || [...codes],
  );
});

test("server/translate.py builds its map from the table, not its own copy (#32)", () => {
  const src = readFileSync(path.join(ROOT, "server", "translate.py"), "utf8");
  assert.match(src, /languages\.json/);
  assert.doesNotMatch(
    src,
    /"[a-z]{2}":\s*"[a-z]{3}_[A-Z][a-z]{3}"/,
    "translate.py has hardcoded Flores codes again",
  );
});

test("both languageName helpers answer from the whole table (#32)", () => {
  // Not just the offered subset: a file can be detected as a language the bar
  // doesn't list, and the chat model is asked about whatever it was given.
  assert.equal(languageName("de"), "German");
  assert.equal(llmLanguageName("de"), "German");
  assert.equal(languageName("nope"), "nope");
});

// --- Detection --------------------------------------------------------------
//
// Two sentences per language, saying two unrelated things. TUNED is what the
// word lists were built against; HELD_OUT was written afterwards and nothing
// was adjusted to make it pass, so it is the honest measure. Detection is a
// heuristic and will never be perfect — what it must never do is answer
// *confidently and wrongly*, because a mis-detected source language is
// invisible: the file translates fine, into fluent nonsense.

const TUNED = {
  af: "Ek weet nie of dit 'n goeie idee is nie maar ons moet dit probeer",
  ar: "لا أعرف إذا كانت هذه فكرة جيدة لكن يجب أن نحاول اليوم",
  az: "Bunun yaxşı bir fikir olub olmadığını bilmirəm amma cəhd etməliyik",
  bn: "আমি জানি না এটা ভালো ধারণা কিনা কিন্তু আমাদের আজ চেষ্টা করতে হবে",
  bg: "Не знам дали това е добра идея но трябва да опитаме днес",
  ca: "No sé si aquesta és una bona idea però hem de provar-ho avui",
  zh: "我不知道这是不是一个好主意但是我们今天必须试一试",
  cs: "Nevím jestli je to dobrý nápad ale musíme to dnes zkusit",
  da: "Jeg ved ikke om det er en god idé men vi må prøve det i dag",
  nl: "Ik weet niet of dit een goed idee is maar we moeten het proberen",
  en: "I do not know if this is a good idea but we have to try it today",
  eo: "Mi ne scias ĉu tio estas bona ideo sed ni devas provi ĝin hodiaŭ",
  et: "Ma ei tea kas see on hea mõte aga me peame seda täna proovima",
  fi: "En tiedä onko tämä hyvä ajatus mutta meidän täytyy yrittää sitä tänään",
  fr: "Je ne sais pas si c'est une bonne idée mais nous devons essayer",
  de: "Ich weiß nicht ob das eine gute Idee ist aber wir müssen es versuchen",
  el: "Δεν ξέρω αν αυτή είναι καλή ιδέα αλλά πρέπει να προσπαθήσουμε σήμερα",
  he: "אני לא יודע אם זה רעיון טוב אבל אנחנו חייבים לנסות היום",
  hi: "मुझे नहीं पता कि यह अच्छा विचार है या नहीं लेकिन हमें कोशिश करनी होगी",
  hu: "Nem tudom hogy ez jó ötlet-e de meg kell próbálnunk ma",
  id: "Saya tidak tahu apakah ini ide yang bagus tetapi kita bisa mencobanya",
  ga: "Níl a fhios agam an bhfuil sé seo ina smaoineamh maith ach caithfimid triail a bhaint as",
  it: "Non so se questa sia una buona idea ma dobbiamo provare oggi",
  ja: "これが良い考えかどうかわからないけれど今日やってみなければならない",
  ko: "이것이 좋은 생각인지 모르겠지만 우리는 오늘 시도해야 합니다",
  lv: "Es nezinu vai tā ir laba ideja bet mums tas šodien jāmēģina",
  lt: "Nežinau ar tai gera mintis bet mes turime pabandyti šiandien",
  ms: "Saya tidak tahu sama ada ini idea yang baik tetapi kita boleh mencuba",
  nb: "Jeg vet ikke om dette er en god idé men vi må prøve det i dag",
  fa: "من نمی دانم که آیا این ایده خوبی است یا نه اما باید امتحان کنیم",
  pl: "Nie wiem czy to jest dobry pomysł ale musimy spróbować dzisiaj",
  pt: "Não sei se esta é uma boa ideia mas temos de tentar hoje",
  ro: "Nu știu dacă aceasta este o idee bună dar trebuie să încercăm astăzi",
  ru: "Я не знаю хорошая ли это идея но мы должны попробовать сегодня",
  sk: "Neviem či je to dobrý nápad ale musíme to dnes skúsiť",
  sl: "Ne vem ali je to dobra ideja ampak danes moramo poskusiti",
  es: "No sé si esta es una buena idea pero tenemos que intentarlo hoy",
  sv: "Jag vet inte om det är en bra idé men vi måste försöka idag",
  tl: "Hindi ko alam kung ito ay magandang ideya pero kailangan nating subukan",
  th: "ฉันไม่รู้ว่านี่เป็นความคิดที่ดีหรือไม่แต่เราต้องลองดูวันนี้",
  tr: "Bunun iyi bir fikir olup olmadığını bilmiyorum ama bugün denemeliyiz",
  uk: "Я не знаю чи це гарна ідея але ми повинні спробувати сьогодні",
  ur: "مجھے نہیں معلوم کہ یہ اچھا خیال ہے یا نہیں لیکن ہمیں آج کوشش کرنی چاہیے",
  vi: "Tôi không biết đây có phải là ý kiến hay không nhưng chúng ta phải thử",
};

const HELD_OUT = {
  af: "Gisteraand het ons na die fliek gegaan maar dit was baie vervelig",
  ar: "ذهبنا إلى السينما الليلة الماضية لكن الفيلم كان مملا جدا",
  az: "Dünən axşam kinoya getdik amma film çox darıxdırıcı idi",
  bn: "কাল রাতে আমরা সিনেমা দেখতে গিয়েছিলাম কিন্তু ছবিটা খুব বিরক্তিকর ছিল",
  bg: "Снощи отидохме на кино но филмът беше много скучен",
  ca: "Ahir a la nit vam anar al cinema però la pel·lícula va ser molt avorrida",
  zh: "昨天晚上我们去看电影但是那部电影很无聊",
  cs: "Včera večer jsme šli do kina ale ten film byl velmi nudný",
  da: "I går aftes gik vi i biografen men filmen var meget kedelig",
  nl: "Gisteravond gingen we naar de bioscoop maar de film was erg saai",
  en: "Last night we went to the cinema but the film was very boring",
  eo: "Hieraŭ vespere ni iris al la kinejo sed la filmo estis tre enuiga",
  et: "Eile õhtul läksime kinno aga film oli väga igav",
  fi: "Eilen illalla menimme elokuviin mutta elokuva oli hyvin tylsä",
  fr: "Hier soir nous sommes allés au cinéma mais le film était très ennuyeux",
  de: "Gestern Abend gingen wir ins Kino aber der Film war sehr langweilig",
  el: "Χθες το βράδυ πήγαμε στον κινηματογράφο αλλά η ταινία ήταν πολύ βαρετή",
  he: "אתמול בערב הלכנו לקולנוע אבל הסרט היה משעמם מאוד",
  hi: "कल रात हम सिनेमा गए लेकिन फिल्म बहुत उबाऊ थी",
  hu: "Tegnap este moziba mentünk de a film nagyon unalmas volt",
  id: "Tadi malam kami pergi ke bioskop tetapi filmnya sangat membosankan",
  ga: "Chuaigh mé go dtí an phictiúrlann aréir ach bhí an scannán an-leadránach",
  it: "Ieri sera siamo andati al cinema ma il film era molto noioso",
  ja: "昨日の夜映画館に行きましたが映画はとてもつまらなかったです",
  ko: "어젯밤에 우리는 영화관에 갔지만 영화가 매우 지루했습니다",
  lv: "Vakar vakarā mēs gājām uz kino bet filma bija ļoti garlaicīga",
  lt: "Vakar vakare nuėjome į kiną bet filmas buvo labai nuobodus",
  ms: "Malam tadi kami pergi ke pawagam tetapi filem itu sangat membosankan",
  nb: "I går kveld gikk vi på kino men filmen var veldig kjedelig",
  fa: "دیشب به سینما رفتیم اما فیلم خیلی خسته کننده بود",
  pl: "Wczoraj wieczorem poszliśmy do kina ale film był bardzo nudny",
  pt: "Ontem à noite fomos ao cinema mas o filme foi muito chato",
  ro: "Aseară am mers la cinema dar filmul a fost foarte plictisitor",
  ru: "Вчера вечером мы пошли в кино но фильм был очень скучным",
  sk: "Včera večer sme šli do kina ale ten film bol veľmi nudný",
  sl: "Včeraj zvečer smo šli v kino ampak film je bil zelo dolgočasen",
  es: "Anoche fuimos al cine pero la película fue muy aburrida",
  sv: "Igår kväll gick vi på bio men filmen var väldigt tråkig",
  tl: "Kagabi nanood kami ng pelikula pero ang boring nito",
  th: "เมื่อคืนเราไปดูหนังแต่หนังน่าเบื่อมาก",
  tr: "Dün akşam sinemaya gittik ama film çok sıkıcıydı",
  uk: "Вчора ввечері ми пішли в кіно але фільм був дуже нудним",
  ur: "کل رات ہم سینما گئے لیکن فلم بہت بورنگ تھی",
  vi: "Tối qua chúng tôi đi xem phim nhưng bộ phim rất chán",
};

function classify(corpus) {
  const wrong = [];
  const unsure = [];
  for (const [code, text] of Object.entries(corpus)) {
    const got = detectLanguage(text);
    if (got === code) continue;
    (got ? wrong : unsure).push(got ? `${code}->${got}` : code);
  }
  return { wrong, unsure };
}

test("a sample exists for every language in the table (#65)", () => {
  // Adding a language to languages.json without teaching detectLanguage about
  // it is how the "detected as English" class of bug got in. Fail here first.
  const codes = table.languages.map((l) => l.code).sort();
  assert.deepEqual(Object.keys(TUNED).sort(), codes);
  assert.deepEqual(Object.keys(HELD_OUT).sort(), codes);
});

test("detection is never confidently wrong (#65)", () => {
  // The invariant that matters. Answering "" costs the user one dropdown
  // click; answering the wrong language silently translates the file from a
  // language it isn't written in, and the output looks perfectly fine.
  assert.deepEqual(classify(TUNED).wrong, []);
  assert.deepEqual(classify(HELD_OUT).wrong, []);
});

test("detection identifies all 44 languages from one sentence (#65)", () => {
  assert.deepEqual(classify(TUNED).unsure, []);
});

test("detection generalises to sentences it wasn't tuned on (#65)", () => {
  // Indonesian and Malay share almost every function word; these two sentences
  // happen to contain no discriminator, so detection abstains. That is the
  // correct answer, not a failure — with adalah/bisa/karena or
  // ialah/boleh/kerana present it separates them (asserted below).
  assert.deepEqual(classify(HELD_OUT).unsure, ["id", "ms"]);
  assert.equal(detectLanguage("Saya tidak bisa datang karena saya sedang sakit"), "id");
  assert.equal(detectLanguage("Saya tidak boleh datang kerana saya sedang sakit"), "ms");
});

test("detection abstains instead of guessing (#65)", () => {
  // It used to return "en" for anything it couldn't place, which is what sent
  // Polish through the English model. Every caller handles "" — the translate
  // bar asks the user, romanize and zhscript skip, the card modal falls back
  // to the current learning language.
  for (const input of ["", "   ", "12345", "!!! ... ???", "🎬🎥", null, undefined]) {
    assert.equal(detectLanguage(input), "", `should abstain on ${JSON.stringify(input)}`);
  }
  // A lone Latin word carries no evidence either way.
  assert.equal(detectLanguage("hello"), "");
  // ...but a lone Han word is unambiguous.
  assert.equal(detectLanguage("電影"), "zh");
});

test("detection separates the pairs a shared script hides (#65)", () => {
  // Each pair is one script, and the naive test picks the wrong one. These are
  // the cases that were silently broken.
  assert.equal(detectLanguage(HELD_OUT.bg), "bg", "Bulgarian is not Russian");
  assert.equal(detectLanguage(HELD_OUT.uk), "uk", "Ukrainian is not Russian");
  assert.equal(detectLanguage(TUNED.ur), "ur", "Urdu is not Persian");
  assert.equal(detectLanguage(TUNED.fa), "fa", "Persian is not Arabic");
  assert.equal(detectLanguage(HELD_OUT.cs), "cs", "Czech is not Slovak");
  assert.equal(detectLanguage(HELD_OUT.sk), "sk", "Slovak is not Czech");
  assert.equal(detectLanguage(HELD_OUT.da), "da", "Danish is not Norwegian");
  assert.equal(detectLanguage(HELD_OUT.nb), "nb", "Norwegian is not Danish");
});

test("detection reads scripts and diacritics past Latin-1 (#65)", () => {
  // The tokenizer used to be [a-zà-ÿ], which dropped every word containing ł,
  // ř, ğ, ș or ơ — precisely the languages it most needed to tell apart.
  assert.equal(detectLanguage("pomysł"), "pl");
  assert.equal(detectLanguage("Přišel jsem domů"), "cs");
  assert.equal(detectLanguage("olmadığını"), "tr");
});

test("the shipped pair still detects on short lines", () => {
  assert.equal(detectLanguage("我今天很忙"), "zh");
  assert.equal(detectLanguage("我今天很忙，沒有時間"), "zh");
  assert.equal(detectLanguage("これはテストの文章です"), "ja");
  assert.equal(detectLanguage("What are you doing?"), "en");
});
