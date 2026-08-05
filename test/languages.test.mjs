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

test("detectLanguage identifies non-Latin scripts", () => {
  assert.equal(detectLanguage("这是一个测试句子"), "zh");
  assert.equal(detectLanguage("これはテストの文章です"), "ja");
});

test("detectLanguage returns a code or null, never throws", () => {
  const result = detectLanguage("the quick brown fox jumps over the lazy dog");
  assert.ok(result === null || typeof result === "string");
});
