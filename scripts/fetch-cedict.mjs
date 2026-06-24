// Downloads the full CC-CEDICT dictionary to data/cedict.u8.
// The app falls back to data/cedict-seed.u8 when this file is absent, so this
// is optional — run it to get full Chinese coverage offline.
//
//   node scripts/fetch-cedict.mjs
//
// CC-CEDICT is licensed CC BY-SA 4.0 (https://www.mdbg.net/chinese/dictionary?page=cc-cedict).
import { createWriteStream } from "node:fs";
import { mkdir, rename, stat } from "node:fs/promises";
import { createGunzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
const OUT = path.join(DATA_DIR, "cedict.u8");
const TMP = `${OUT}.download`;
const SOURCE =
  "https://www.mdbg.net/chinese/export/cedict/cedict_1_0_ts_utf-8_mdbg.txt.gz";

async function main() {
  await mkdir(DATA_DIR, { recursive: true });
  console.log(`Downloading CC-CEDICT from ${SOURCE} ...`);
  const res = await fetch(SOURCE);
  if (!res.ok || !res.body) {
    throw new Error(`Download failed: HTTP ${res.status}`);
  }
  await pipeline(res.body, createGunzip(), createWriteStream(TMP));
  await rename(TMP, OUT);
  const { size } = await stat(OUT);
  console.log(`Saved ${OUT} (${(size / 1e6).toFixed(1)} MB). Restart the server.`);
}

main().catch((err) => {
  console.error(err.message);
  console.error(
    "If your network blocks mdbg.net, download cedict_ts.u8 manually and place it at data/cedict.u8.",
  );
  process.exit(1);
});
