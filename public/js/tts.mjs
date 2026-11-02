// Text-to-speech, best engine first. Nothing leaves the machine.
//
//   1. piper, via the server, when a neural voice for the language is
//      installed — the one that sounds like a person.
//   2. the browser's speechSynthesis, when it is a *different* engine from the
//      server's fallback (macOS, Windows).
//   3. the server again, which ends at espeak-ng: robotic, but it means the
//      button works on a machine with no voice model at all.
//
// See `neural` below for why the browser isn't simply preferred.

import { api } from "./backend.mjs";
import { detectLanguage } from "./languages.mjs";

const base = (code) => String(code || "").toLowerCase().split(/[-_]/)[0];
const CJK_LANGS = new Set(["zh", "ja", "ko", "yue"]);
const CJK_TEXT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

// The language to speak `text` in. Callers pass the language being studied —
// the open video's — but a card made from another video, or an English word
// in a Chinese line, isn't in it, and a voice reading another language's text
// sounds like nonsense: the Chinese voice spelling out "patience", the English
// one reading 耐心 as nothing at all. So the text has the last word when it
// clearly says otherwise. detectLanguage abstains rather than guess, so an
// ordinary word stays in the language given.
export function spokenLanguage(text, lang) {
  const given = base(lang);
  const detected = detectLanguage(text);
  // Kanji alone reads as Chinese to the detector; a Japanese or Cantonese
  // reader's Han text is still theirs.
  if (detected === "zh" && (given === "ja" || given === "yue")) return given;
  if (detected && detected !== given) return detected;
  // No Han, kana or Hangul in it: whatever it is, a CJK voice can't read it.
  if (CJK_LANGS.has(given) && !CJK_TEXT.test(text)) return detected || "en";
  return given || detected;
}

const supported =
  typeof window !== "undefined" && "speechSynthesis" in window;

// Some engines expose Chinese as "cmn-Hans-CN" rather than "zh-*".
const LANG_ALIASES = { zh: ["zh", "cmn"], yue: ["yue", "zh-hk"] };
// Voices that start with "zh" but speak Cantonese: Hong Kong's and Macau's.
// Mac, Windows and Android all list one, often before the Mandarin ones, and
// taking the first "zh" voice read Mandarin words in Cantonese.
const CANTONESE = /^(yue|zh[-_](hk|mo)|zh[-_]yue)/i;

let voices = supported ? window.speechSynthesis.getVoices() : [];
const listeners = new Set();

if (supported) {
  // Voice lists load asynchronously in most browsers.
  window.speechSynthesis.addEventListener?.("voiceschanged", () => {
    voices = window.speechSynthesis.getVoices();
    listeners.forEach((fn) => fn());
  });
}

// UI that depends on voice availability re-renders when voices arrive late.
export function onVoicesChanged(fn) {
  listeners.add(fn);
}

export function voiceFor(lang, list = voices) {
  if (!lang || !list?.length) return null;
  const short = base(lang);
  const prefixes = LANG_ALIASES[short] || [short];
  const candidates = list.filter((voice) => {
    const code = String(voice.lang || "").toLowerCase().replace("_", "-");
    if (!prefixes.some((p) => code === p || code.startsWith(`${p}-`))) return false;
    // Mandarin asked for: never a Cantonese voice.
    return short !== "zh" || !CANTONESE.test(code);
  });
  // The region the reader's language names (zh-TW), then the system's default
  // voice, then whatever comes first.
  const wanted = String(lang).toLowerCase().replace("_", "-");
  return (
    candidates.find((voice) => voice.lang?.toLowerCase().replace("_", "-") === wanted) ||
    candidates.find((voice) => voice.default) ||
    candidates[0] ||
    null
  );
}

// The server can always speak, so audio is offered even when the browser
// reports no voices — which on Linux is the usual case, and used to hide the
// feature completely.
export function ttsAvailable() {
  return true;
}

let audio = null;

// Languages the server has a neural voice for. Asked once, at load, so the
// answer is in hand long before anyone presses a button; until it arrives, and
// on any failure, the browser keeps its old first refusal.
let neural = new Set();
// What the reader picked in Settings → What's running: "auto" leaves the choice
// to the order below, "browser" and "espeak" name an engine outright.
let prefer = "auto";
if (typeof fetch === "function") {
  api("/api/voices")
    .then((res) => (res.ok ? res.json() : null))
    .then((data) => {
      if (Array.isArray(data?.languages)) neural = new Set(data.languages);
      if (data?.prefer) prefer = data.prefer;
    })
    .catch(() => {});
}

// A browser voice is preferred where it is genuinely a different engine: no
// round trip, and on macOS or Windows a better voice than anything here.
//
// On Linux it usually isn't a different engine. Firefox's voice list comes from
// speech-dispatcher, whose only output module is typically espeak-ng — so the
// browser offers a long list of names that are all the same robotic
// synthesiser, and preferring it meant the piper voice sitting on disk was
// never reached. So when the server says it has a real voice for this
// language, that wins.
// `rate` is "fast" or "slow" — an intent, not a number, because the three
// engines below express speed in three different units. "fast" is the phrase
// said normally; it is named for the pair it belongs to, not for being hurried.
export function speak(text, lang, rate = "fast") {
  const trimmed = String(text || "").trim();
  if (!trimmed) return false;
  const slow = rate === "slow";
  lang = spokenLanguage(trimmed, lang);

  const short = base(lang);
  // Asking for espeak-ng means the server, which is the only thing that can
  // guarantee it — a browser voice would be whatever the system happens to
  // have. Asking for the browser skips the server entirely when it can.
  const useBrowser =
    prefer === "browser" ? true : prefer === "espeak" ? false : !neural.has(short);
  const voice = useBrowser ? voiceFor(lang) : null;
  if (voice) {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(trimmed);
    utterance.voice = voice;
    utterance.lang = voice.lang;
    // 1 is the browser's normal. 0.45 is about the same stretch the other two
    // engines give, so a word doesn't change pace depending on which one
    // happens to be speaking it.
    utterance.rate = slow ? 0.45 : 1;
    window.speechSynthesis.speak(utterance);
    return true;
  }

  speakViaServer(trimmed, lang, slow ? "slow" : "fast");
  return true;
}

async function speakViaServer(text, lang, rate) {
  try {
    const res = await api("/api/speak", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, lang, rate }),
    });
    if (!res.ok) return;
    const url = URL.createObjectURL(await res.blob());
    // One player, so a second press replaces the first instead of talking over
    // it — the same thing speechSynthesis.cancel() does above.
    if (audio) {
      audio.pause();
      URL.revokeObjectURL(audio.src);
    }
    audio = new Audio(url);
    audio.addEventListener("ended", () => URL.revokeObjectURL(url), { once: true });
    await audio.play();
  } catch {
    // Speech is a nicety; a failure here shouldn't interrupt reading.
  }
}
