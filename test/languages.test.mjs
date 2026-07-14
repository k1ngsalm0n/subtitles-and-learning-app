import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { LANGUAGES, detectLanguage } from "../public/js/languages.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Pull the keys of LANG_CODE_MAP out of server/translate.py so we can assert the
// client language list and the server's supported set never drift apart (#32).
function pythonLangCodes() {
  const src = readFileSync(
    path.join(__dirname, "..", "server", "translate.py"),
    "utf8",
  );
  const block = src.match(/LANG_CODE_MAP\s*=\s*\{([\s\S]*?)\}/);
  assert.ok(block, "LANG_CODE_MAP not found in translate.py");
  return [...block[1].matchAll(/"([a-z]{2,3})"\s*:/g)].map((m) => m[1]);
}

test("every client LANGUAGE is supported by the server LANG_CODE_MAP (#32)", () => {
  // CHINESE-ONLY (temporary, #65): the client list is trimmed to a subset while
  // the server keeps the full set, so the invariant is now "the UI never offers
  // a language the server can't translate" rather than exact equality. Restore
  // the deepEqual check when the full LANGUAGES list comes back.
  const jsCodes = LANGUAGES.map((l) => l.code);
  const pyCodes = new Set(pythonLangCodes());
  const unsupported = jsCodes.filter((code) => !pyCodes.has(code));
  assert.deepEqual(
    unsupported,
    [],
    "public/js/languages.mjs offers languages missing from server/translate.py",
  );
});

test("detectLanguage identifies non-Latin scripts", () => {
  assert.equal(detectLanguage("这是一个测试句子"), "zh");
  assert.equal(detectLanguage("これはテストの文章です"), "ja");
});

test("detectLanguage returns a code or null, never throws", () => {
  const result = detectLanguage("the quick brown fox jumps over the lazy dog");
  assert.ok(result === null || typeof result === "string");
});
