// Text-to-speech via the browser's built-in speechSynthesis — the app has no
// TTS engine of its own and never calls an external service. Voices are
// feature-detected: when no voice matches the learning language (common on
// Linux), audio fields are hidden entirely rather than leaving dead buttons.

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

export function ttsAvailable(lang) {
  return Boolean(voiceFor(lang));
}

export function speak(text, lang) {
  const voice = voiceFor(lang);
  const trimmed = String(text || "").trim();
  if (!voice || !trimmed) return false;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(trimmed);
  utterance.voice = voice;
  utterance.lang = voice.lang;
  window.speechSynthesis.speak(utterance);
  return true;
}
