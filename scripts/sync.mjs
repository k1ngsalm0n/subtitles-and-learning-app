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
import { chmodSync } from "node:fs";
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

if (process.env.SKIP_MODELS) {
  console.log("\n→ SKIP_MODELS set — not prefetching Whisper/NLLB.");
} else {
  console.log("\n→ Prefetching Whisper + NLLB models (skips if cached)…");
  // --no-sync so uv doesn't re-resolve the env back to the locked CPU torch and
  // undo the GPU build installed above.
  run("uv", ["run", "--no-sync", "python", "scripts/prefetch_models.py"]);
}

console.log("\n✓ Done. Start the app with: npm start");
