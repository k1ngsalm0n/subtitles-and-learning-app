// One-shot environment bootstrap, run via `npm run sync`.
//
//   1. `uv sync`               — install the locked Python deps (CPU torch).
//   2. nightly yt-dlp          — URL import; kept off the lockfile on purpose.
//   3. deno                    — JS runtime yt-dlp needs for full-quality
//                                YouTube extraction; dropped into the venv.
//   4. best-fit CUDA torch     — detect the GPU and install a matching wheel
//                                over the CPU build, or stay on CPU if there's
//                                no usable NVIDIA card.
//
// Stdlib only — the project has no third-party Node deps. Re-runnable: each run
// re-syncs to the lock, then re-applies the yt-dlp/deno and GPU overrides.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { chmodSync, mkdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function run(cmd, args) {
  console.log(`\n$ ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: "inherit" });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    console.error(`\n✗ \`${cmd}\` exited with code ${r.status}`);
    process.exit(r.status ?? 1);
  }
}

// Capture stdout without failing the script if the command is missing/errors.
function capture(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: "utf8" });
  if (r.error || r.status !== 0) return null;
  return (r.stdout ?? "").trim();
}

// Put deno (yt-dlp's default JS runtime) in the venv so it travels with the
// project, mirroring how yt-dlp itself is pinned there. Best-effort: a failure
// here must not abort the bootstrap — URL import just stays on yt-dlp's
// degraded, no-JS-runtime fallback (lower-quality formats). Downloads a single
// static binary from GitHub releases and unzips it with the venv's Python, so
// it needs only curl + the Python we just installed (no unzip / shell prompts).
function ensureDeno() {
  const denoPath = join(ROOT, ".venv", "bin", "deno");
  if (existsSync(denoPath)) {
    console.log("  deno already present in .venv/bin — skipping.");
    return;
  }
  if (capture("deno", ["--version"])) {
    console.log("  deno found on PATH — yt-dlp will auto-detect it.");
    return;
  }

  const arch =
    process.arch === "arm64"
      ? "aarch64"
      : process.arch === "x64"
        ? "x86_64"
        : null;
  const triple =
    process.platform === "linux"
      ? `${arch}-unknown-linux-gnu`
      : process.platform === "darwin"
        ? `${arch}-apple-darwin`
        : null;
  if (!arch || !triple) {
    console.warn(
      `  ⚠ No prebuilt deno for ${process.platform}/${process.arch}; ` +
        "install deno manually for full-quality YouTube downloads.",
    );
    return;
  }

  const url = `https://github.com/denoland/deno/releases/latest/download/deno-${triple}.zip`;
  const zip = join(ROOT, ".venv", "deno.zip");
  const py = join(ROOT, ".venv", "bin", "python");
  const warn = (why) =>
    console.warn(
      `  ⚠ deno install failed (${why}) — URL import will use yt-dlp's ` +
        "degraded path. Install deno manually to restore full-quality downloads.",
    );

  const dl = spawnSync("curl", ["-fsSL", "-o", zip, url], {
    cwd: ROOT,
    stdio: "inherit",
  });
  if (dl.error || dl.status !== 0) {
    warn("download");
    rmSync(zip, { force: true });
    return;
  }
  const ex = spawnSync(py, ["-m", "zipfile", "-e", zip, dirname(denoPath)], {
    cwd: ROOT,
    stdio: "inherit",
  });
  rmSync(zip, { force: true });
  if (ex.error || ex.status !== 0 || !existsSync(denoPath)) {
    warn("extract");
    return;
  }
  chmodSync(denoPath, 0o755);
  const ver = capture(denoPath, ["--version"]);
  console.log(`  Installed ${ver ? ver.split("\n")[0] : "deno"} → .venv/bin/deno`);
}

function torchVersion() {
  const m = readFileSync(join(ROOT, "pyproject.toml"), "utf8").match(
    /torch==([0-9][0-9A-Za-z.+-]*)/,
  );
  if (!m) throw new Error("could not find a torch== pin in pyproject.toml");
  return m[1];
}

// Map a GPU compute capability to the CUDA wheel that supports it.
// - cu130 is the latest but drops everything below sm_75.
// - cu126 covers sm_50..sm_90 and JIT-compiles its PTX down to in-between archs
//   (e.g. Pascal sm_61 on a GTX 10-series), so it's the safe choice for older
//   cards; cu130 is required for the newest (sm_100/sm_120) GPUs.
// Returns a `cuXXX` string, or null to stay on the CPU build.
function cudaBuildFor(computeCap) {
  if (!Number.isFinite(computeCap)) return null;
  if (computeCap >= 10.0) return "cu130"; // Blackwell and newer
  if (computeCap >= 5.0) return "cu126"; // Maxwell .. Hopper
  return null; // older than Maxwell — no modern wheel, use CPU
}

function detectComputeCap() {
  const out = capture("nvidia-smi", [
    "--query-gpu=name,compute_cap",
    "--format=csv,noheader",
  ]);
  if (!out) return { cap: NaN, name: null };
  // First GPU line: "NVIDIA GeForce GTX 1060 6GB, 6.1"
  const [first] = out.split("\n");
  const parts = first.split(",").map((s) => s.trim());
  const cap = Number.parseFloat(parts[parts.length - 1]);
  return { cap, name: parts.slice(0, -1).join(", ") || null };
}

console.log("→ Syncing locked Python deps (uv sync)…");
run("uv", ["sync"]);

console.log("\n→ Installing nightly yt-dlp (URL import)…");
run("uv", ["pip", "install", "-U", "--prerelease=allow", "yt-dlp[default]"]);

console.log("\n→ Ensuring deno (yt-dlp JS runtime for full-quality YouTube)…");
ensureDeno();

console.log("\n→ Selecting torch build for this machine…");
// CUDA_BUILD overrides detection: a `cuXXX` tag, or `cpu` to force the CPU build.
const override = process.env.CUDA_BUILD?.trim();
const { cap, name } = detectComputeCap();
let build;
if (override) {
  build = override.toLowerCase() === "cpu" ? null : override;
  console.log(`  CUDA_BUILD override → ${build ?? "cpu"}`);
} else if (!name) {
  build = null;
  console.log("  No NVIDIA GPU detected (nvidia-smi unavailable) → CPU torch.");
} else {
  build = cudaBuildFor(cap);
  console.log(`  GPU: ${name} (compute ${cap}) → ${build ?? "CPU (too old)"}`);
}

if (build) {
  console.log(`\n→ Installing GPU torch (${build}) over the CPU build…`);
  run("uv", [
    "pip",
    "install",
    "--reinstall-package",
    "torch",
    `torch==${torchVersion()}`,
    "--index",
    `https://download.pytorch.org/whl/${build}`,
    "--index-strategy",
    "unsafe-best-match",
  ]);
} else {
  console.log("\n→ Keeping the locked CPU torch build.");
}

// Make Me a Hanzi stroke-order data (~30 MB, gitignored). Best-effort like the
// deno step: a failure just means the app runs without stroke-order charts.
function ensureStrokeData() {
  const target = join(ROOT, "data", "graphics.txt");
  if (existsSync(target)) {
    console.log("  graphics.txt already present in data/ — skipping.");
    return;
  }
  mkdirSync(dirname(target), { recursive: true });
  const url =
    "https://raw.githubusercontent.com/skishore/makemeahanzi/master/graphics.txt";
  const tmp = `${target}.download`;
  const dl = spawnSync("curl", ["-fsSL", "-o", tmp, url], {
    cwd: ROOT,
    stdio: "inherit",
  });
  if (dl.error || dl.status !== 0 || !existsSync(tmp)) {
    rmSync(tmp, { force: true });
    console.warn(
      "  ⚠ stroke-order download failed — the app will run without stroke " +
        "charts. Re-run `npm run sync` to retry.",
    );
    return;
  }
  renameSync(tmp, target);
  console.log("  Downloaded stroke-order data → data/graphics.txt");
}

if (process.env.SKIP_STROKES) {
  console.log("\n→ SKIP_STROKES set — not downloading stroke-order data.");
} else {
  console.log("\n→ Ensuring Han stroke-order data (Make Me a Hanzi)…");
  ensureStrokeData();
}

// The full CC-CEDICT (~10 MB, gitignored). Without it the word pop-up has only
// the 66-entry seed: no definitions, no character breakdown, for nearly every
// word. Best-effort, like the stroke data.
if (process.env.SKIP_DICT) {
  console.log("\n→ SKIP_DICT set — not downloading CC-CEDICT.");
} else if (existsSync(join(ROOT, "data", "cedict.u8"))) {
  console.log("\n→ CC-CEDICT already present in data/ — skipping.");
} else {
  console.log("\n→ Downloading the CC-CEDICT dictionary…");
  const dl = spawnSync(process.execPath, [join(ROOT, "scripts", "fetch-cedict.mjs")], {
    cwd: ROOT,
    stdio: "inherit",
  });
  if (dl.status !== 0) {
    console.warn("  ⚠ dictionary download failed — word meanings use the small seed. Re-run `npm run sync` to retry.");
  }
}

// A Wiktionary dictionary for each offered study language other than Chinese
// (CC-CEDICT, above) and English: meanings, dictionary forms and genders
// for the word pop-up without a chat model (server/wiktionary.mjs). Each is
// a 50–100 MB download from kaikki.org, cut to ~50 MB in data/. Best-effort.
const offeredLanguages = JSON.parse(readFileSync(join(ROOT, "public", "data", "languages.json"), "utf8"))
  .languages.filter((l) => l.offered && l.code !== "zh" && l.code !== "en").map((l) => l.code);
const missingDicts = offeredLanguages.filter((code) => !existsSync(join(ROOT, "data", `wiktionary-${code}.tsv`)));
if (process.env.SKIP_WIKTIONARY) {
  console.log("\n→ SKIP_WIKTIONARY set — not downloading Wiktionary dictionaries.");
} else if (!missingDicts.length) {
  if (offeredLanguages.length) console.log("\n→ Wiktionary dictionaries already present in data/ — skipping.");
} else {
  console.log(`\n→ Downloading Wiktionary dictionaries (${missingDicts.join(", ")})…`);
  const dl = spawnSync(process.execPath, [join(ROOT, "scripts", "fetch-wiktionary.mjs"), ...missingDicts], {
    cwd: ROOT,
    stdio: "inherit",
  });
  if (dl.status !== 0) {
    console.warn("  ⚠ a dictionary download failed — those words get the chat model or the offline translator. Re-run `npm run sync` to retry.");
  }
}

if (process.env.SKIP_MODELS) {
  console.log("\n→ SKIP_MODELS set — not prefetching Whisper/NLLB.");
} else {
  console.log("\n→ Prefetching Whisper + NLLB models (skips if cached)…");
  // --no-sync so uv doesn't re-resolve the env back to the locked CPU torch and
  // undo the GPU build installed above.
  run("uv", ["run", "--no-sync", "python", "scripts/prefetch_models.py"]);
}


// Neural speech voices for the "listen" button. Without one the app falls back
// to espeak-ng, which is intelligible but robotic — fine as a safety net, not
// something to learn pronunciation from. They live beside the backups, outside
// the repo, because they are 60 MB each and must not end up in a commit.
const VOICE_DIR = join(
  process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
  "stele",
  "voices",
);
// xiao_ya reads pinyin (g2pW chooses each character's reading, tones and all).
// It replaced zh_CN-huayan, which goes through espeak-ng's phonemes — those give
// tone 1 and tone 4 the same symbol, so it guessed tones and read 什麼 as
// "shén mó". An install that still has huayan keeps it as a fallback.
const VOICE_MODELS = [
  ["zh_CN-xiao_ya-medium", "zh/zh_CN/xiao_ya/medium"],
  ["en_US-amy-medium", "en/en_US/amy/medium"],
  // Read back by Whisper: 4.8% word errors at normal speed, 3.8% slow
  // (faber 3.8/5.7, jeff 13.3, pt_PT tugão 30, espeak-ng 51/16).
  ["pt_BR-cadu-medium", "pt/pt_BR/cadu/medium"],
  // French: siwis read 12 test sentences back through Whisper at 3.9% WER
  // (5.9% slow); upmc 5.9/8.8, tom 4.9/5.9 at twice the time, espeak-ng 52/38.
  ["fr_FR-siwis-medium", "fr/fr_FR/siwis/medium"],
  // German: eva_k read 24 test sentences back through Whisper at 4.4% WER
  // (4.3% slow); thorsten-high 4.9/5.4 at 3.5x the time and 5x the size,
  // kerstin 6.5/3.3, karlsson 7.1/5.5, thorsten-medium 7.7/7.1, ramona 12/20.
  ["de_DE-eva_k-x_low", "de/de_DE/eva_k/x_low"],
];

function ensureVoices() {
  // The voices are useless without the synthesiser that plays them: downloading
  // 126 MB of .onnx and leaving `python -m piper` missing means every press
  // falls through to espeak-ng, which is the robotic voice this step exists to
  // replace — and it does it silently, because the server treats a failed piper
  // run as "try the next engine".
  console.log("   piper (the synthesiser that plays them)…");
  // [zh]: g2pW and the rest of what a pinyin voice needs. Without them the
  // Chinese voice fails and the server falls back to the next one.
  const piper = spawnSync("uv", ["pip", "install", "-q", "piper-tts[zh]"], {
    cwd: ROOT,
    stdio: "inherit",
  });
  if (piper.status !== 0) {
    console.log("   ⚠ piper install failed — voices downloaded but unusable.");
  }

  mkdirSync(VOICE_DIR, { recursive: true });
  for (const [name, path_] of VOICE_MODELS) {
    const model = join(VOICE_DIR, `${name}.onnx`);
    if (existsSync(model)) {
      console.log(`   ${name} — already there`);
      continue;
    }
    const base = `https://huggingface.co/rhasspy/piper-voices/resolve/main/${path_}`;
    console.log(`   ${name} — downloading (~63 MB)…`);
    // Best-effort: a machine with no network still gets a working app, just a
    // robotic voice.
    // spawnSync directly, not run(): run() exits the process on failure, and a
    // voice that won't download must not abort the whole bootstrap.
    const got = spawnSync("curl", ["-sL", "--fail", "-o", model, `${base}/${name}.onnx`], {
      cwd: ROOT,
      stdio: "inherit",
    });
    if (got.status !== 0) {
      rmSync(model, { force: true });
      console.log(`   ${name} — download failed, the app falls back to espeak-ng`);
      continue;
    }
    spawnSync("curl", ["-sL", "--fail", "-o", `${model}.json`, `${base}/${name}.onnx.json`], {
      cwd: ROOT,
      stdio: "inherit",
    });
  }

  // A pinyin voice downloads g2pW (~110 MB) the first time it speaks; do that
  // here rather than on the reader's first press of a listen button.
  const zh = join(VOICE_DIR, "zh_CN-xiao_ya-medium.onnx");
  if (existsSync(zh)) {
    console.log("   g2pW (how the Chinese voice reads each character)…");
    const py = join(ROOT, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
    spawnSync(py, ["-c",
      "import sys; from pathlib import Path; from piper import PiperVoice; " +
      "p = Path(sys.argv[1]); PiperVoice.load(str(p), download_dir=p.parent).phonemize('你好')",
      zh,
    ], { cwd: ROOT, stdio: "inherit" });
  }
}

// Opt-in: 126 MB on top of Whisper and NLLB, for a button some people never
// press. Without a voice the app still speaks, just robotically.
if (process.env.VOICES) {
  console.log("\n→ Fetching speech voices (skips what's already there)…");
  ensureVoices();
} else {
  console.log(
    "\n→ Skipping speech voices. `listen` will use espeak-ng, which is robotic.",
  );
  console.log("   For a natural voice: VOICES=1 npm run sync   (~63 MB each)");
}

console.log("\n✓ Done. Start the app with: npm start");
