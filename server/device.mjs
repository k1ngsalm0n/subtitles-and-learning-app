// What this machine can actually do, and what that means for an import.
//
// The two heavy passes of an import — OCR over the frames and Whisper over the
// audio — are started together, on the premise that they use different
// hardware: "OCR is CPU-bound, Whisper runs on the GPU". Until this module that
// premise was written in a comment and checked nowhere.
//
// The obvious conclusion — that a machine without a GPU has the two fighting
// over one set of cores, and should run them in turn — is WRONG on anything
// but a small machine, and was measured to be wrong before this shipped. A
// nine-minute video, GPU disabled, 6 cores / 12 threads:
//
//   concurrent   249.1s        sequential   288.5s
//
// Contention is real (queued, Whisper takes 99s and OCR 188s; overlapped, 170s
// and 248s) but neither pass saturates the machine alone — measured on their
// own, OCR wants 6.0 cores and Whisper 3.7 — so there is room for both and the
// overlap wins by 39s. What decides is therefore not the GPU at all. It is how
// many cores there are to share. Giving the pair a fixed budget and splitting
// it between them, against giving it to each in turn (3-minute clip):
//
//    4 cores   concurrent 141.7s   sequential 134.5s   queueing    by  5.1%
//    6 cores   concurrent 114.0s   sequential 115.4s   overlapping by  1.3%
//    8 cores   concurrent 112.1s   sequential 141.8s   overlapping by 21.0%
//   12 cores   concurrent 102.1s   sequential 149.0s   overlapping by 31.5%
//
// So the crossover is at six, and below it the win is small. A GPU short-cuts
// the question — Whisper is not on the CPU at all, so the overlap is free
// whatever the core count.
//
// Deliberately NOT here: a thread cap. It was built, measured, and dropped.
// onnxruntime's own choice beat every number the knob could set (81s against
// 94s at 4 threads, 98s at 8, 107s at 12), so capping only ever buys quiet at
// the cost of speed. OCR_THREADS and WHISPER_CPU_THREADS still exist on the
// Python side for someone who wants that trade, and are inherited straight
// from the environment — no plumbing needed here.
//
// One module rather than a check at each call site, for the reason #32 records:
// three copies of a language table drifted apart behind a "keep in sync"
// comment. A second opinion about the hardware would drift the same way, and
// the symptom would be a laptop that is slow for no reason.

import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

import { runCommand } from "./util.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HEALTH_SCRIPT = path.join(__dirname, "health.py");
export const PYTHON_BIN =
  process.env.STELE_PYTHON || path.join(__dirname, "..", ".venv", "bin", "python");

// Below this, the two passes are better off queued. Measured, not guessed —
// see the table above. Six is where they tie, and ties go to the simpler path.
const MIN_CORES_TO_OVERLAP = 6;

// Cached for the life of the process: a graphics card does not appear halfway
// through a session, and the probe costs a Python start plus a torch import.
let probed = null;

export async function probeMachine({ fresh = false } = {}) {
  if (probed && !fresh) return probed;
  let answer;
  try {
    const result = await runCommand(PYTHON_BIN, [HEALTH_SCRIPT], {
      timeoutMs: 30_000,
    });
    const line = result.stdout.trim().split("\n").filter(Boolean).at(-1) || "{}";
    answer = JSON.parse(line);
  } catch {
    // No venv at all. Report everything missing rather than failing whatever
    // asked — an import that can't probe should still run.
    answer = { modules: {}, cuda: false, whisperCuda: false, cores: 0 };
  }
  probed = {
    modules: answer.modules || {},
    cuda: Boolean(answer.cuda),
    // What CTranslate2 says, since that is what actually runs Whisper. Falls
    // back to torch's answer when the key is absent (an older health.py).
    whisperCuda: Boolean(answer.whisperCuda ?? answer.cuda),
    cores: answer.cores || os.cpus().length || 1,
  };
  return probed;
}

// The scheduling plan for an import on this machine: whether the two heavy
// passes overlap. `why` is for the health page, which has to explain a choice
// nobody made.
export function importPlan({ whisperCuda, cores } = {}) {
  const forced = process.env.STELE_IMPORT_PLAN;
  if (forced === "concurrent") return { concurrent: true, why: "forced" };
  if (forced === "sequential") return { concurrent: false, why: "forced" };
  if (whisperCuda) return { concurrent: true, why: "gpu" };
  if ((cores || 1) >= MIN_CORES_TO_OVERLAP) return { concurrent: true, why: "cores" };
  return { concurrent: false, why: "small" };
}
