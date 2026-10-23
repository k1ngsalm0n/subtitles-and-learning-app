import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { qrMatrix, qrSvg, reedSolomon } from "../public/js/qr.mjs";

test("Reed–Solomon matches the standard's worked example (ISO 18004, 1-M)", () => {
  const data = [0x10, 0x20, 0x0c, 0x56, 0x61, 0x80, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11];
  assert.deepEqual(reedSolomon(data, 10), [0xa5, 0x24, 0xd4, 0xc1, 0xed, 0x36, 0xc7, 0x87, 0x2c, 0x55]);
});

test("the size grows with the text, by whole versions", () => {
  const side = (text, level) => qrMatrix(text, { level }).length;
  assert.equal(side("a", "M"), 21); // version 1
  assert.equal(side("https://pc.tail1234.ts.net/", "M"), 29); // version 3
  assert.ok(side("x".repeat(500), "M") > side("x".repeat(100), "M"));
  assert.ok(side("x".repeat(100), "H") > side("x".repeat(100), "L"));
  assert.throws(() => qrMatrix("x".repeat(3000), { level: "H" }), /Too long/);
});

test("the three finder patterns are where a camera looks for them", () => {
  const m = qrMatrix("https://pc.tail1234.ts.net/");
  const n = m.length;
  for (const [x0, y0] of [[0, 0], [n - 7, 0], [0, n - 7]]) {
    for (let d = 0; d < 7; d++) {
      // Outer ring dark, the ring inside it light, a 3×3 dark centre.
      assert.ok(m[y0][x0 + d] && m[y0 + 6][x0 + d] && m[y0 + d][x0] && m[y0 + d][x0 + 6]);
    }
    assert.ok(!m[y0 + 1][x0 + 1] && m[y0 + 3][x0 + 3]);
  }
});

test("the SVG is black on white with a quiet zone, whatever the theme", () => {
  const svg = qrSvg("https://pc.tail1234.ts.net/");
  assert.match(svg, /viewBox="0 0 37 37"/); // 29 modules + 4 each side
  assert.match(svg, /fill="#fff"/);
  assert.match(svg, /fill="#000"/);
});

// The real proof: another decoder reads it back. Skipped where zbarimg isn't
// installed (CI); run locally it covers every version size class and level.
const zbar = spawnSync("zbarimg", ["--version"]).status === 0;
test("a separate decoder (zbarimg) reads back exactly what was encoded", { skip: !zbar && "zbarimg not installed" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "stele-qr-"));
  const texts = ["https://swagalicious.taila41e36.ts.net/", "https://例子.測試/你好?q=我多喜歡你"];
  for (const n of [1, 60, 200, 700, 1400]) texts.push("https://x.ts.net/" + "abc".repeat(n));
  let i = 0;
  for (const level of ["L", "M", "Q", "H"]) {
    for (const text of texts) {
      let m;
      try {
        m = qrMatrix(text, { level });
      } catch {
        continue; // too long for this level
      }
      const scale = 3;
      const size = (m.length + 8) * scale;
      const rows = [];
      for (let y = 0; y < size; y++) {
        const row = [];
        for (let x = 0; x < size; x++) row.push(m[Math.floor(y / scale) - 4]?.[Math.floor(x / scale) - 4] ? 0 : 1);
        rows.push(row.join(" "));
      }
      const file = join(dir, `q${i++}.pgm`);
      writeFileSync(file, `P2\n${size} ${size}\n1\n${rows.join("\n")}\n`);
      const out = spawnSync("zbarimg", ["-q", "--raw", "-Sbinary", file]);
      assert.equal(out.stdout.toString("utf8").replace(/\n$/, ""), text, `${level}, ${text.length} bytes`);
    }
  }
});
