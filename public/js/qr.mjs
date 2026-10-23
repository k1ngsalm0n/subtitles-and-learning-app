// QR codes, so a phone can open this app by pointing its camera at the screen.
//
// Written out rather than pulled in: the app takes no third-party code, and
// the encoder is a few hundred lines of published standard (ISO/IEC 18004)
// with nothing to choose between implementations. Byte mode only — a URL is
// all this ever encodes — every version 1–40, all four error-correction
// levels, and the mask with the lowest penalty. The structure follows Project
// Nayuki's well-known reference implementation. test/qr.test.mjs checks the
// Reed–Solomon arithmetic against the standard's own worked example, and
// decodes generated codes with zbarimg where it's installed.

// Error-correction codewords per block, and number of blocks, by level and
// version (index 0 unused). Levels in the order L, M, Q, H.
const ECC_PER_BLOCK = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
];
const BLOCKS = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
];
const LEVELS = { L: 0, M: 1, Q: 2, H: 3 };
// What the format information calls each level — not the table order.
const FORMAT_BITS = [1, 0, 3, 2];

const bit = (value, i) => ((value >>> i) & 1) !== 0;

// --- Reed–Solomon over GF(2^8), polynomial 0x11D ----------------------------
function gfMultiply(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

function rsDivisor(degree) {
  const result = new Array(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMultiply(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

// The `degree` error-correction codewords for `data`.
export function reedSolomon(data, degree) {
  const divisor = rsDivisor(degree);
  const result = new Array(degree).fill(0);
  for (const b of data) {
    const factor = b ^ result.shift();
    result.push(0);
    divisor.forEach((coef, i) => (result[i] ^= gfMultiply(coef, factor)));
  }
  return result;
}

// --- Capacity ---------------------------------------------------------------
function rawDataModules(ver) {
  let result = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const align = Math.floor(ver / 7) + 2;
    result -= (25 * align - 10) * align - 55;
    if (ver >= 7) result -= 36;
  }
  return result;
}

function dataCodewords(ver, ecl) {
  return Math.floor(rawDataModules(ver) / 8) - ECC_PER_BLOCK[ecl][ver] * BLOCKS[ecl][ver];
}

// --- Data → codewords -------------------------------------------------------
function encodeBytes(bytes, ver, ecl) {
  const bits = [];
  const push = (value, length) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  push(0b0100, 4); // byte mode
  push(bytes.length, ver <= 9 ? 8 : 16);
  for (const b of bytes) push(b, 8);

  const capacity = dataCodewords(ver, ecl) * 8;
  push(0, Math.min(4, capacity - bits.length)); // terminator
  push(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) push(pad, 8);

  const words = [];
  for (let i = 0; i < bits.length; i += 8) {
    words.push(bits.slice(i, i + 8).reduce((acc, b) => (acc << 1) | b, 0));
  }
  return words;
}

// Split into blocks, add each block's error correction, interleave.
function addEcc(data, ver, ecl) {
  const numBlocks = BLOCKS[ecl][ver];
  const eccLen = ECC_PER_BLOCK[ecl][ver];
  const rawCodewords = Math.floor(rawDataModules(ver) / 8);
  const numShort = numBlocks - (rawCodewords % numBlocks);
  const shortLen = Math.floor(rawCodewords / numBlocks);

  const blocks = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const dat = data.slice(k, k + shortLen - eccLen + (i < numShort ? 0 : 1));
    k += dat.length;
    const ecc = reedSolomon(dat, eccLen);
    // Short blocks get a placeholder where the long ones have an extra byte,
    // so every block interleaves at the same index; it's skipped below.
    if (i < numShort) dat.push(0);
    blocks.push(dat.concat(ecc));
  }
  const result = [];
  for (let i = 0; i < blocks[0].length; i++) {
    blocks.forEach((block, j) => {
      if (i !== shortLen - eccLen || j >= numShort) result.push(block[i]);
    });
  }
  return result;
}

// --- Drawing ----------------------------------------------------------------
function alignmentPositions(ver) {
  if (ver === 1) return [];
  const size = ver * 4 + 17;
  const count = Math.floor(ver / 7) + 2;
  const step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (count * 2 - 2)) * 2;
  const result = [6];
  for (let pos = size - 7; result.length < count; pos -= step) result.splice(1, 0, pos);
  return result;
}

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function drawFunctionPatterns(grid, ver) {
  const { size } = grid;
  for (let i = 0; i < size; i++) {
    grid.fn(6, i, i % 2 === 0);
    grid.fn(i, 6, i % 2 === 0);
  }
  const finder = (cx, cy) => {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        const x = cx + dx;
        const y = cy + dy;
        if (x >= 0 && x < size && y >= 0 && y < size) grid.fn(x, y, d !== 2 && d !== 4);
      }
    }
  };
  finder(3, 3);
  finder(size - 4, 3);
  finder(3, size - 4);

  const align = alignmentPositions(ver);
  const last = align.length - 1;
  align.forEach((ay, i) =>
    align.forEach((ax, j) => {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          grid.fn(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }),
  );

  drawFormatBits(grid, 0, 0); // reserves the area; redrawn once the mask is chosen
  if (ver >= 7) {
    let rem = ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (ver << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      grid.fn(a, b, bit(bits, i));
      grid.fn(b, a, bit(bits, i));
    }
  }
}

function drawFormatBits(grid, formatLevel, mask) {
  const { size } = grid;
  const data = (formatLevel << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;

  for (let i = 0; i <= 5; i++) grid.fn(8, i, bit(bits, i));
  grid.fn(8, 7, bit(bits, 6));
  grid.fn(8, 8, bit(bits, 7));
  grid.fn(7, 8, bit(bits, 8));
  for (let i = 9; i < 15; i++) grid.fn(14 - i, 8, bit(bits, i));
  for (let i = 0; i < 8; i++) grid.fn(size - 1 - i, 8, bit(bits, i));
  for (let i = 8; i < 15; i++) grid.fn(8, size - 15 + i, bit(bits, i));
  grid.fn(8, size - 8, true); // the dark module, always set
}

function drawCodewords(grid, words) {
  const { size } = grid;
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // skip the vertical timing column
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!grid.isFn[y][x] && i < words.length * 8) {
          grid.dark[y][x] = bit(words[i >>> 3], 7 - (i & 7));
          i++;
        }
      }
    }
  }
}

function applyMask(grid, mask) {
  for (let y = 0; y < grid.size; y++) {
    for (let x = 0; x < grid.size; x++) {
      if (!grid.isFn[y][x] && MASKS[mask](x, y)) grid.dark[y][x] = !grid.dark[y][x];
    }
  }
}

// The standard's four penalty rules; the mask with the lowest total wins.
// Every mask decodes — this only picks the one easiest for a camera to read.
function penalty(dark) {
  const size = dark.length;
  let score = 0;
  const lines = [];
  for (let i = 0; i < size; i++) {
    lines.push(dark[i]);
    lines.push(dark.map((row) => row[i]));
  }
  const pattern = [true, false, true, true, true, false, true];
  for (const line of lines) {
    let run = 1;
    for (let i = 1; i <= size; i++) {
      if (i < size && line[i] === line[i - 1]) run++;
      else {
        if (run >= 5) score += 3 + (run - 5);
        run = 1;
      }
    }
    // A finder-like 1:1:3:1:1 with four light modules on either side.
    for (let i = 0; i + 7 <= size; i++) {
      if (!pattern.every((p, k) => line[i + k] === p)) continue;
      const lightBefore = [1, 2, 3, 4].every((k) => i - k < 0 || !line[i - k]);
      const lightAfter = [0, 1, 2, 3].every((k) => i + 7 + k >= size || !line[i + 7 + k]);
      if (lightBefore || lightAfter) score += 40;
    }
  }
  for (let y = 0; y + 1 < size; y++) {
    for (let x = 0; x + 1 < size; x++) {
      const c = dark[y][x];
      if (c === dark[y][x + 1] && c === dark[y + 1][x] && c === dark[y + 1][x + 1]) score += 3;
    }
  }
  const total = size * size;
  const darkCount = dark.reduce((n, row) => n + row.filter(Boolean).length, 0);
  score += (Math.ceil(Math.abs(darkCount * 20 - total * 10) / total) - 1) * 10;
  return score;
}

// The modules of a QR code for `text`: an array of rows of booleans, true for
// dark, without the quiet zone. Throws if it doesn't fit in version 40.
export function qrMatrix(text, { level = "M" } = {}) {
  const ecl = LEVELS[level];
  if (ecl == null) throw new Error(`Unknown error-correction level ${level}.`);
  const bytes = [...new TextEncoder().encode(String(text))];
  let ver = 1;
  for (; ver <= 40; ver++) {
    const needed = 4 + (ver <= 9 ? 8 : 16) + bytes.length * 8;
    if (needed <= dataCodewords(ver, ecl) * 8) break;
  }
  if (ver > 40) throw new Error("Too long for a QR code.");

  const size = ver * 4 + 17;
  const grid = {
    size,
    dark: Array.from({ length: size }, () => new Array(size).fill(false)),
    isFn: Array.from({ length: size }, () => new Array(size).fill(false)),
    fn(x, y, isDark) {
      this.dark[y][x] = isDark;
      this.isFn[y][x] = true;
    },
  };
  drawFunctionPatterns(grid, ver);
  drawCodewords(grid, addEcc(encodeBytes(bytes, ver, ecl), ver, ecl));

  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    applyMask(grid, mask);
    drawFormatBits(grid, FORMAT_BITS[ecl], mask);
    const score = penalty(grid.dark);
    if (!best || score < best.score) best = { score, mask, dark: grid.dark.map((row) => row.slice()) };
    applyMask(grid, mask); // XOR undoes it
  }
  return best.dark;
}

// An SVG of the code, black on white with the standard four-module quiet
// zone — fixed colours, since a camera wants contrast whatever the theme.
export function qrSvg(text, options = {}) {
  const dark = qrMatrix(text, options);
  const border = 4;
  const size = dark.length + border * 2;
  let path = "";
  dark.forEach((row, y) =>
    row.forEach((on, x) => {
      if (on) path += `M${x + border},${y + border}h1v1h-1z`;
    }),
  );
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges">` +
    `<rect width="${size}" height="${size}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`
  );
}
