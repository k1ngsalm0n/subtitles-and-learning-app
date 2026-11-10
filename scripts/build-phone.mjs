// Builds the phone edition: plain files that any static host serves (GitHub
// Pages does, .github/workflows/phone.yml). No server runs behind it — the
// page answers its own /api/… requests (public/js/phone/engine.mjs) and asks
// Groq directly, with the reader's own key.
//
//   node scripts/build-phone.mjs [--out dist/phone] [--dict data/cedict.u8]
//
// It is public/ copied as it is, plus two things:
//   * <html data-edition="phone">, which switches the engine on and hides
//     what needs a computer before the first paint (edition.mjs);
//   * data/cedict.txt, CC-CEDICT for pinyin, word cuts, script conversion
//     and meanings — the full dictionary when `npm run sync` has fetched it
//     (data/cedict.u8), else the small seed. CC-CEDICT is CC BY-SA 4.0; its
//     own header, with the licence, is kept at the top of the file.

import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 && process.argv[at + 1] ? process.argv[at + 1] : fallback;
}

export async function buildPhone({ out = path.join(ROOT, "dist", "phone"), dict } = {}) {
  const dictionary =
    dict || [path.join(ROOT, "data", "cedict.u8"), path.join(ROOT, "data", "cedict-seed.u8")].find((p) => existsSync(p));
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  await cp(path.join(ROOT, "public"), out, { recursive: true });

  const indexPath = path.join(out, "index.html");
  const html = await readFile(indexPath, "utf8");
  if (!/<html lang="en">/.test(html)) throw new Error("index.html's <html> tag isn't the one this build marks.");
  await writeFile(indexPath, html.replace('<html lang="en">', '<html lang="en" data-edition="phone">'));

  await mkdir(path.join(out, "data"), { recursive: true });
  await writeFile(path.join(out, "data", "cedict.txt"), await readFile(dictionary));
  // GitHub Pages runs Jekyll otherwise, which skips some files.
  await writeFile(path.join(out, ".nojekyll"), "");
  const { size } = await stat(path.join(out, "data", "cedict.txt"));
  return { out, dictionary, dictionaryBytes: size };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await buildPhone({ out: arg("out", undefined) && path.resolve(arg("out")), dict: arg("dict", undefined) });
  console.log(`Phone edition in ${path.relative(process.cwd(), result.out) || "."}`);
  console.log(`Dictionary: ${path.relative(ROOT, result.dictionary)} (${(result.dictionaryBytes / 1e6).toFixed(1)} MB)`);
}
