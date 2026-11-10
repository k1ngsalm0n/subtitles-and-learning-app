import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildPhone } from "../scripts/build-phone.mjs";

const SEED = new URL("../data/cedict-seed.u8", import.meta.url).pathname;

function filesUnder(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? filesUnder(full) : [full];
  });
}

test("the phone build is public/ marked as the phone edition, with the dictionary beside it", async (t) => {
  const out = mkdtempSync(path.join(os.tmpdir(), "stele-phone-"));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  const result = await buildPhone({ out, dict: SEED });
  assert.equal(result.dictionary, SEED);

  const html = readFileSync(path.join(out, "index.html"), "utf8");
  assert.match(html, /<html lang="en" data-edition="phone">/);
  assert.equal(readFileSync(path.join(out, "data", "cedict.txt"), "utf8"), readFileSync(SEED, "utf8"));
  for (const file of [".nojekyll", "sw.js", "manifest.webmanifest", "icons/icon-192.png", "js/phone/engine.mjs", "data/languages.json"]) {
    assert.ok(existsSync(path.join(out, file)), file);
  }
  // The computer's source is untouched.
  assert.match(readFileSync(new URL("../public/index.html", import.meta.url), "utf8"), /<html lang="en">/);
});

// GitHub Pages serves the site under /subtitles-and-learning-app/, so every
// file the page loads must be found relative to it: an absolute "/js/…" or a
// module path that doesn't exist works nowhere but on a computer's server.
test("every module and asset the page loads exists in the build, by a relative path", async (t) => {
  const out = mkdtempSync(path.join(os.tmpdir(), "stele-phone-"));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  await buildPhone({ out, dict: SEED });

  const missing = [];
  const absolute = [];
  let checked = 0;
  for (const file of filesUnder(out).filter((f) => /\.(mjs|html)$/.test(f))) {
    const text = readFileSync(file, "utf8");
    const specs = [
      ...text.matchAll(/^\s*(?:import|export)\s[^;]*?from\s+["']([^"']+)["']/gm),
      ...text.matchAll(/^\s*import\s+["']([^"']+)["']/gm),
      ...text.matchAll(/<(?:script|link)\b[^>]*?(?:src|href)="([^"]+)"/g),
    ].map((m) => m[1]);
    for (const spec of specs) {
      if (/^(https?:|data:|#)/.test(spec)) continue;
      checked++;
      if (spec.startsWith("/")) absolute.push(`${path.relative(out, file)}: ${spec}`);
      else if (!existsSync(path.resolve(path.dirname(file), spec))) missing.push(`${path.relative(out, file)}: ${spec}`);
    }
  }
  assert.ok(checked > 100, `only ${checked} paths found — is the scan reading the files?`);
  assert.deepEqual(absolute, []);
  assert.deepEqual(missing, []);
});
