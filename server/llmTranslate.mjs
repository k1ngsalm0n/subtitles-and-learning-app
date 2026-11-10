// Translate whole lines through an OpenAI-compatible chat model, when one is
// configured, falling back to the offline model otherwise.
//
// The offline translator (Marian/NLLB) is fast, private and free, and it is
// genuinely bad at names. It rendered 黑尔戈兰级 as "Herle Golan class" instead
// of Helgoland, and 日德兰海战 as "the battle in the Sea of Japan" instead of
// Jutland — it transliterates syllable by syllable because it has no idea the
// string is a place. A chat model knows, and it also has the neighbouring lines
// to go on, which is most of what fixes this.
//
// Everything here degrades quietly: no key, too much text, a bad response, a
// dropped connection — all return null and the caller runs the offline path.
// A worse translation beats no translation.

import { toTraditional } from "./zhconvert.mjs";

import { readPrefs } from "./prefs.mjs";
import { getLlmConfig } from "./llmConfig.mjs";
import { chatJson } from "./chat.mjs";
import {
  MAX_LINES,
  batches,
  buildPrompt,
  parseCues,
  readTranslations,
  rebuildSrt,
} from "../public/js/shared/linetranslate.mjs";
// The prompt and the reply's reading are shared with the phone version.
export {
  batches,
  buildPrompt,
  languageName,
  parseCues,
  readTranslations,
  rebuildSrt,
} from "../public/js/shared/linetranslate.mjs";

// LLM_TRANSLATE=off is the deployment-level switch and still wins; the
// Settings toggle is the reader's, checked per call so flipping it takes effect
// without a restart.
const ENV_ENABLED = String(process.env.LLM_TRANSLATE || "").toLowerCase() !== "off";

const TIMEOUT_MS = 60_000;

async function askModel(config, prompt, lines) {
  const numbered = lines.map((text, index) => `${index + 1}. ${text}`).join("\n");
  // An OpenAI-compatible API, or Claude through Claude Code (chat.mjs).
  const content = await chatJson(config, { system: prompt, user: numbered, timeoutMs: TIMEOUT_MS, patient: true });
  return content ? readTranslations(content, lines.length) : null;
}

// Whether a chat model *could* be used: one is configured and the deployment
// hasn't forbidden it. Says nothing about the reader's preference — see the
// caller.
export async function llmTranslationConfigured() {
  return Boolean(await getLlmConfig()) && ENV_ENABLED;
}

// The config to translate with, or null for "use the offline translator".
export async function llmTranslationAvailable() {
  if (!ENV_ENABLED) return null;
  const config = await getLlmConfig();
  if (!config) return null;
  const { llm } = await readPrefs();
  return llm !== "off" ? config : null;
}

// Whether a chat model would have taken this SRT: one is on, and it's within
// the line ceiling. An offline translation of one that would is worth redoing
// once the model answers again (retranslate.mjs); one past the ceiling isn't.
export async function llmCouldTranslate(srt) {
  const cues = parseCues(srt);
  return Boolean(cues.length && cues.length <= MAX_LINES && (await llmTranslationAvailable()));
}

// Returns a translated SRT, or null to mean "use the offline translator".
export async function translateSrtWithLlm(srt, from, to) {
  const config = await llmTranslationAvailable();
  if (!config) return null;

  const cues = parseCues(srt);
  if (!cues.length || cues.length > MAX_LINES) return null;

  const prompt = buildPrompt(from, to);
  const groups = batches(cues.map((cue) => cue.text));
  const results = await Promise.all(groups.map((group) => askModel(config, prompt, group)));
  // A batch that came back wrong — a dropped line, a hiccup — gets one more
  // try before the whole video goes to the offline translator: one bad reply
  // out of eight used to cost every line its chat-model translation.
  await Promise.all(
    results.map(async (group, i) => {
      if (group === null) results[i] = await askModel(config, prompt, groups[i]);
    }),
  );
  // Still a bad batch: the rest would be a mix of two translators with
  // different names for the same ship. Hand the whole job back instead.
  if (results.some((group) => group === null)) return null;

  // Into Chinese, the app's script: "Chinese" in the prompt names no script,
  // and models answer in Simplified under Traditional transcripts.
  const translated = rebuildSrt(cues, results.flat());
  return to === "zh" ? toTraditional(translated, "zh") : translated;
}
