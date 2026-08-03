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

// The server can always speak, so audio is offered even when the browser
// reports no voices — which on Linux is the usual case, and used to hide the
// feature completely.
export function ttsAvailable() {
  return true;
}

let audio = null;

// A browser voice is preferred: no round trip, and usually a better voice than
// the offline synthesiser. Falling back to the server is what makes the button
// worth showing at all on a machine whose browser exposes nothing.
export function speak(text, lang) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return false;

  const voice = voiceFor(lang);
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
