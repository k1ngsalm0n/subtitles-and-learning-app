// Chinese text in the app's script: Traditional by default, through OpenCC
// (zh_convert.py). Transcripts (import.mjs) and translations into Chinese
// (llmTranslate.mjs; translate.py does the same for the offline models) go
// through it, so a Chinese reader sees one script.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCommand } from "./util.mjs";
import { PYTHON_BIN } from "./device.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ZH_CONVERT_SCRIPT = path.join(__dirname, "zh_convert.py");
// Subtitles are normalised to Traditional characters by default (the app's
// current focus is Taiwanese content, and mixed-script sources — Simplified
// clips embedded in Traditional broadcasts — read jarringly otherwise). Set
// ZH_SCRIPT=off to keep each source's original script.
const ZH_SCRIPT = process.env.ZH_SCRIPT || "trad";

// Convert subtitle text to Traditional Chinese via OpenCC (zh_convert.py).
// Best-effort: any failure returns the text unchanged. Chinese only: any other
// study language passes through untouched (and costs no Python spawn).
export async function toTraditional(srt, language = "zh") {
  if (language !== "zh" || ZH_SCRIPT !== "trad" || !srt) return srt;
  try {
    const result = await runCommand(PYTHON_BIN, [ZH_CONVERT_SCRIPT], {
      timeoutMs: 60_000,
      input: srt,
    });
    return result.stdout || srt;
  } catch (err) {
    console.warn(
      `Traditional conversion skipped (${String(err.message || err).split("\n")[0]})`,
    );
    return srt;
  }
}
