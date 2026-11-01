#!/usr/bin/env node
// Measures the transcript fixer (server/transcriptFix.mjs) against the chat
// model the app is set up with, on scripts/transcript_fix_cases.json.
//
//   node scripts/transcript_fix_eval.mjs                 # every case, the app's chat model
//   node scripts/transcript_fix_eval.mjs --language es   # one language
//   node scripts/transcript_fix_eval.mjs --claude sonnet # Claude Code instead
//   node scripts/transcript_fix_eval.mjs --runs 3        # repeat, models aren't deterministic
//
// Per line that needed a fix: fixed (one of the accepted answers, punctuation
// aside), wrong (changed to something else), or missed. Per line that was
// right: a false alarm if it changed. False alarms are the number to watch —
// a fixer that rewrites what someone actually said is worse than none.

import { readFileSync } from "node:fs";
import { getLlmConfig } from "../server/llmConfig.mjs";
import { findFixes } from "../server/transcriptFix.mjs";
import { languageRow } from "../server/languages.mjs";
import { chatHealth } from "../server/chat.mjs";
import { execFileSync } from "node:child_process";

// As the import does (ZH_SCRIPT=trad): a fix to a Traditional line that came
// back in Simplified is converted before it's shown, so it's scored that way.
// A case written in Simplified is left as it is.
const PYTHON = new URL("../.venv/bin/python", import.meta.url).pathname;
const ZH_CONVERT = new URL("../server/zh_convert.py", import.meta.url).pathname;
const toTraditional = (lines) =>
  lines.length ? execFileSync(PYTHON, [ZH_CONVERT], { input: lines.join("\n") }).toString().split("\n") : lines;

const args = process.argv.slice(2);
const flag = (name) => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? null : args[at + 1];
};
const only = flag("language");
const runs = Number(flag("runs") || 1);
const pick = flag("case");
// Seconds between cases, for free plans' per-minute limits.
const pause = Number(flag("pause") || 0);

const config = flag("claude") ? { provider: "claude", model: flag("claude") } : await getLlmConfig();
if (!config) {
  console.error("No chat model is set up (Settings → What's running, or LLM_* in .env).");
  process.exit(1);
}
console.log(`Model: ${config.provider} ${config.model || ""}\n`);

const { cases } = JSON.parse(readFileSync(new URL("./transcript_fix_cases.json", import.meta.url), "utf8"));
const bare = (s) => String(s).replace(/[\s\p{P}\p{S}]/gu, "").toLowerCase();

const totals = {};
const tally = (lang) => (totals[lang] ??= { needed: 0, fixed: 0, wrong: 0, missed: 0, clean: 0, falseAlarms: 0, guarded: 0, unanswered: 0, seconds: 0 });

for (let run = 1; run <= runs; run++) {
  if (runs > 1) console.log(`— run ${run} —`);
  for (const c of cases) {
    if (only && c.language !== only) continue;
    if (pick && c.id !== pick) continue;
    const t = tally(c.language);
    const rejected = [];
    const began = Date.now();
    const fixes = await findFixes(config, c.lines, c.language, {
      placeholder: languageRow(c.language)?.inaudible || "",
      rejected,
    });
    t.seconds += (Date.now() - began) / 1000;
    if (c.language === "zh" && toTraditional(c.lines).join("\n") === c.lines.join("\n")) {
      const converted = toTraditional(fixes.map((f) => f.to));
      fixes.forEach((f, i) => (f.to = converted[i]));
    }
    const got = new Map(fixes.map((f) => [f.index, f.to]));
    const notes = [];
    c.lines.forEach((line, i) => {
      const answers = c.fix[i];
      const out = got.get(i);
      if (answers) {
        t.needed++;
        if (out === undefined) {
          t.missed++;
          notes.push(`  MISSED  #${i} ${line}`);
        } else if (answers.some((a) => bare(a) === bare(out))) {
          t.fixed++;
          notes.push(`  fixed   #${i} ${line} → ${out}`);
        } else {
          t.wrong++;
          notes.push(`  WRONG   #${i} ${line} → ${out}   (wanted ${answers[0]})`);
        }
      } else {
        if (c.allowChanged?.includes(i)) {
          if (out !== undefined) notes.push(`  (either) #${i} ${line} → ${out}`);
          return;
        }
        t.clean++;
        if (out !== undefined) {
          t.falseAlarms++;
          notes.push(`  FALSE   #${i} ${line} → ${out}`);
        }
      }
    });
    for (const r of rejected) {
      if (r.unanswered) {
        t.unanswered++;
        notes.push(`  NO ANSWER from the model (${chatHealth()?.reason || "bad reply"})`);
        continue;
      }
      t.guarded++;
      notes.push(`  guarded #${r.index} ${r.from} → ${r.to}   (${r.why})`);
    }
    if (pause) await new Promise((r) => setTimeout(r, pause * 1000));
    const bad = notes.some((n) => /MISSED|WRONG|FALSE|NO ANSWER/.test(n));
    console.log(`${bad ? "✗" : "✓"} ${c.id}`);
    if (notes.length) console.log(notes.join("\n"));
  }
  console.log("");
}

const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(0)}%` : "—");
console.log("lang  fixed       wrong  missed  false alarms     guarded  no answer  time");
for (const [lang, t] of Object.entries(totals)) {
  console.log(
    `${lang.padEnd(5)} ${`${t.fixed}/${t.needed} (${pct(t.fixed, t.needed)})`.padEnd(11)} ${String(t.wrong).padEnd(6)} ${String(t.missed).padEnd(7)} ${`${t.falseAlarms}/${t.clean} (${pct(t.falseAlarms, t.clean)})`.padEnd(16)} ${String(t.guarded).padEnd(8)} ${String(t.unanswered).padEnd(10)} ${t.seconds.toFixed(0)}s`,
  );
}
