// Getting Claude Code ready, from inside the app: find it, install it, sign in.
//
// "Claude (your subscription)" (chat.mjs) needs the `claude` command on the
// computer running Stele, signed in to a paid Claude plan (Pro, Max, Team or
// Enterprise — the free plan doesn't include Claude Code). This module does
// both steps for the reader, so choosing Claude never means opening a
// terminal:
//
// - Install: Anthropic's own native installer (claude.ai/install.sh, or the
//   PowerShell one on Windows). No admin rights; it puts `claude` in
//   ~/.local/bin. That folder often isn't on the PATH of a server started by
//   systemd or by an older shell, so findClaude() looks there itself — or a
//   fresh install would still report "not installed".
// - Sign in: `claude auth login` prints a link and then waits for the code
//   Claude's page shows after signing in ("Paste code here if prompted >").
//   The page opens the link, the reader pastes the code into Stele, and it's
//   written to the waiting process. `claude auth status --json` reports the
//   result without asking Claude anything.
//
// Changes (install, sign in) are taken from the computer itself only, as in
// tailscale.mjs: a phone arriving through `tailscale serve` can't install
// software on the reader's computer.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { runCommand, sendJson, readJsonBody } from "./util.mjs";
import { fromThisComputer } from "./tailscale.mjs";

const WINDOWS = process.platform === "win32";
const INSTALLER = WINDOWS
  ? ["powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "irm https://claude.ai/install.ps1 | iex"]]
  : ["bash", ["-c", "curl -fsSL https://claude.ai/install.sh | bash"]];

// Where `claude` may be: an override, the PATH, then the places Anthropic's
// installers and Homebrew put it.
export function findClaude() {
  if (process.env.STELE_CLAUDE_BIN) return process.env.STELE_CLAUDE_BIN;
  const name = WINDOWS ? "claude.exe" : "claude";
  for (const dir of String(process.env.PATH || "").split(path.delimiter)) {
    if (dir && existsSync(path.join(dir, name))) return path.join(dir, name);
  }
  const candidates = [
    path.join(homedir(), ".local", "bin", name),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  ];
  return candidates.find((p) => existsSync(p)) || "claude";
}

const run = (args, timeoutMs = 15_000) => runCommand(findClaude(), args, { timeoutMs, allowFailure: true });
const missing = (r) => /ENOENT|not found/i.test(r.stderr) && !r.stdout;

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// { installed, version, signedIn, email, plan }
export async function claudeStatus() {
  const version = await run(["--version"]);
  if (missing(version) || version.code !== 0) return { installed: false, platform: process.platform };
  const auth = parseJson((await run(["auth", "status", "--json"])).stdout) || {};
  return {
    installed: true,
    version: version.stdout.trim().split(/\s+/)[0] || "",
    signedIn: Boolean(auth.loggedIn),
    method: auth.authMethod || "",
    email: auth.email || "",
    plan: auth.subscriptionType || "",
    platform: process.platform,
  };
}

let installing = null;
export function installClaude() {
  if (installing) return installing;
  // STELE_CLAUDE_INSTALLER replaces the real installer in tests.
  const [cmd, args] = process.env.STELE_CLAUDE_INSTALLER
    ? [process.env.STELE_CLAUDE_INSTALLER, []]
    : INSTALLER;
  installing = runCommand(cmd, args, { timeoutMs: 10 * 60_000, allowFailure: true })
    .then(async (result) => {
      const status = await claudeStatus();
      if (status.installed) return { ok: true, status };
      const said = `${result.stdout}\n${result.stderr}`.trim().split("\n").slice(-3).join(" ");
      return {
        ok: false,
        error: /curl|bash|powershell/i.test(result.stderr) && result.code !== 0 && !said
          ? "The installer couldn't run on this computer."
          : `Claude Code didn't install. ${said}`.trim(),
        fix: WINDOWS ? "irm https://claude.ai/install.ps1 | iex" : "curl -fsSL https://claude.ai/install.sh | bash",
        status,
      };
    })
    .finally(() => {
      installing = null;
    });
  return installing;
}

// The sign-in in progress: the waiting `claude auth login` and its link.
let login = null;

export function startSignIn() {
  if (login?.link) return Promise.resolve({ ok: true, link: login.link });
  return new Promise((resolve) => {
    let output = "";
    let answered = false;
    const answer = (value) => {
      if (answered) return;
      answered = true;
      clearTimeout(giveUp);
      resolve(value);
    };
    let child;
    try {
      // BROWSER=true: the page opens the link itself, in the reader's own
      // browser; a browser launched by the server could be on another screen.
      child = spawn(findClaude(), ["auth", "login", "--claudeai"], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, BROWSER: "true" },
      });
    } catch (error) {
      answer({ ok: false, error: error.message });
      return;
    }
    login = { child, link: "", output: "" };
    const read = (chunk) => {
      output += chunk.toString();
      login && (login.output = output);
      const link = /https:\/\/\S*oauth\S*/.exec(output.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, ""))?.[0];
      if (link && login) {
        login.link = link;
        answer({ ok: true, link });
      }
    };
    child.stdout.on("data", read);
    child.stderr.on("data", read);
    child.on("error", (e) =>
      answer({ ok: false, error: e.code === "ENOENT" ? "Claude Code isn't installed." : e.message }),
    );
    child.on("close", (code) => {
      if (login?.child === child) login = { ...login, child: null, exitCode: code };
      answer(code === 0 ? { ok: true, alreadySignedIn: true } : { ok: false, error: "Claude Code's sign-in stopped." });
    });
    // A link that never comes: answer anyway, and stop it after a while.
    const giveUp = setTimeout(() => answer({ ok: false, error: "Claude Code didn't give a sign-in link." }), 20_000);
    setTimeout(() => child.kill("SIGTERM"), 15 * 60_000).unref?.();
  });
}

// The code from Claude's page, handed to the waiting sign-in.
export async function finishSignIn(code) {
  const text = String(code || "").trim();
  if (!text) return { ok: false, error: "Paste the code from Claude's page." };
  const child = login?.child;
  if (!child) return { ok: false, error: "That sign-in has ended. Start again." };
  const done = new Promise((resolve) => child.once("close", resolve));
  child.stdin.write(`${text}\n`);
  child.stdin.end();
  let timer;
  await Promise.race([done, new Promise((r) => (timer = setTimeout(r, 30_000)))]);
  clearTimeout(timer);
  login = null;
  const status = await claudeStatus();
  return status.signedIn
    ? { ok: true, status }
    : { ok: false, error: "Claude didn't accept that code. Start the sign-in again and paste the newest code.", status };
}

// GET /api/claude-code, POST /api/claude-code { action: "install" | "signin" | "code", code }
export async function handleClaudeCode(req, res) {
  const here = fromThisComputer(req) ? "computer" : "remote";
  if (req.method === "GET") {
    sendJson(res, 200, { ...(await claudeStatus()), here });
    return;
  }
  if (!String(req.headers["content-type"] || "").startsWith("application/json")) {
    sendJson(res, 415, { error: "Send JSON." });
    return;
  }
  if (here !== "computer") {
    sendJson(res, 403, { error: "Set Claude Code up on the computer Stele runs on." });
    return;
  }
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: "Couldn't read that." });
    return;
  }
  const actions = { install: installClaude, signin: startSignIn, code: () => finishSignIn(body.code) };
  const act = actions[body?.action];
  if (!act) {
    sendJson(res, 400, { error: "Unknown action." });
    return;
  }
  const result = await act();
  sendJson(res, result.ok ? 200 : 409, result);
}
