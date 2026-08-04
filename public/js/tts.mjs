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

const supported =
  typeof window !== "undefined" && "speechSynthesis" in window;

// Some engines expose Chinese as "cmn-Hans-CN" rather than "zh-*".
const LANG_ALIASES = { zh: ["zh", "cmn"], yue: ["yue", "zh-hk"] };

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

export function voiceFor(lang) {
  if (!supported || !lang) return null;
  const short = String(lang).toLowerCase().slice(0, 2);
  const prefixes = LANG_ALIASES[short] || [short];
  return (
    voices.find((voice) =>
      prefixes.some((p) => voice.lang?.toLowerCase().startsWith(p)),
    ) || null
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
if (typeof fetch === "function") {
  fetch("/api/voices")
    .then((res) => (res.ok ? res.json() : null))
    .then((data) => {
      if (Array.isArray(data?.languages)) neural = new Set(data.languages);
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
export function speak(text, lang) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return false;

  const short = String(lang || "").toLowerCase().slice(0, 2);
  const voice = neural.has(short) ? null : voiceFor(lang);
  if (voice) {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(trimmed);
    utterance.voice = voice;
    utterance.lang = voice.lang;
    window.speechSynthesis.speak(utterance);
    return true;
  }

  speakViaServer(trimmed, lang);
  return true;
}

async function speakViaServer(text, lang) {
  try {
    const res = await fetch("/api/speak", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, lang }),
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
