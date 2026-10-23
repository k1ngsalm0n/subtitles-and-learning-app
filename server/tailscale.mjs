// Opening the app on a phone, through Tailscale.
//
// The phone reaches this machine over the reader's own tailnet, at the
// machine's private https address, with `tailscale serve` passing requests on
// to this server — which itself only ever listens on loopback. Nothing here is
// on the public internet (that would be `tailscale funnel`, never used).
//
// The page asks GET /api/tailscale where things stand — installed? running?
// signed in? is this app shared? which devices are online? — and walks the
// reader through whatever is missing, ending at a QR code of the address
// (public/js/phone.mjs). Every answer comes from the tailscale CLI, which
// needs no password to *read*. Changing anything — sharing the app, signing
// in — needs an operator (`sudo tailscale set --operator=$USER`) or root; when
// it's refused, the reply carries the command that fixes it.
//
// Changes are only accepted from the computer itself (`Host` is loopback):
// requests that arrive through `tailscale serve` carry the machine's ts.net
// name instead. Otherwise the phone could switch off the very sharing it is
// connected through.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { sendJson, readJsonBody, runCommand } from "./util.mjs";

// STELE_TAILSCALE_BIN points at another binary — the tests and the sandbox
// use a stand-in, since the reader's real tailnet is already set up.
function binary() {
  if (process.env.STELE_TAILSCALE_BIN) return process.env.STELE_TAILSCALE_BIN;
  // The Mac app doesn't put its CLI on PATH.
  const mac = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
  return process.platform === "darwin" && existsSync(mac) ? mac : "tailscale";
}

const run = (args, timeoutMs = 8000) =>
  runCommand(binary(), args, { timeoutMs, allowFailure: true });

const missing = (result) => /ENOENT|not found/i.test(result.stderr) && !result.stdout;

const ADMIN_DNS = "https://login.tailscale.com/admin/dns";
const OPERATOR_FIX = "sudo tailscale set --operator=$USER";

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// Does this serve config pass the root of the machine's https address to this
// app's port? Anything else served on 443 is the reader's own business.
export function servesUs(serve, dnsName, port) {
  const handlers = serve?.Web?.[`${dnsName}:443`]?.Handlers || {};
  const target = handlers["/"]?.Proxy || "";
  return new RegExp(`^(https?://)?(127\\.0\\.0\\.1|localhost)?:${port}/?$`).test(target);
}

// Everything the page needs, from `tailscale status --json` and
// `tailscale serve status --json`. Pure, so it's tested without a tailnet.
export function describeTailscale(status, serve, port) {
  const state = status?.BackendState || "NoState";
  const self = status?.Self || {};
  const dnsName = String(self.DNSName || "").replace(/\.$/, "");
  const peers = Object.values(status?.Peer || {})
    .map((p) => ({ name: p.HostName || p.DNSName || "device", os: p.OS || "", online: Boolean(p.Online) }))
    .sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
  return {
    installed: true,
    running: true,
    state,
    signedIn: state === "Running",
    dnsName,
    url: dnsName ? `https://${dnsName}/` : "",
    // Without HTTPS certificates `tailscale serve` can't give the https
    // address — and a phone needs https for the microphone and installing.
    httpsReady: Array.isArray(status?.CertDomains) && status.CertDomains.length > 0,
    shared: Boolean(dnsName) && servesUs(serve, dnsName, port),
    // Something else already answers on 443: sharing would replace it.
    servingOther: Boolean(serve?.Web?.[`${dnsName}:443`]) && !servesUs(serve, dnsName, port),
    peers,
  };
}

export async function tailscaleStatus(port) {
  const status = await run(["status", "--json"]);
  if (missing(status)) return { installed: false, platform: process.platform };
  const parsed = parseJson(status.stdout);
  if (!parsed) {
    // The CLI is there but the daemon isn't answering.
    return { installed: true, running: false, platform: process.platform };
  }
  const serve = parseJson((await run(["serve", "status", "--json"])).stdout) || {};
  return { ...describeTailscale(parsed, serve, port), platform: process.platform };
}

// What a refused change means, in the reader's terms.
function explain(output) {
  if (/access denied|permission|operator|must be root|sudo/i.test(output)) {
    return { error: "Tailscale needs permission for this app to change its settings.", fix: OPERATOR_FIX };
  }
  const link = output.match(/https:\/\/login\.tailscale\.com\/\S+/)?.[0];
  if (/serve is not enabled|https? (certificates? )?(is |are )?not enabled|enable https/i.test(output)) {
    return { error: "HTTPS certificates are off for your tailnet. Turn them on (and MagicDNS), then try again.", link: link || ADMIN_DNS };
  }
  return { error: output.trim().split("\n").slice(-3).join(" ") || "Tailscale refused." };
}

export async function shareApp(port) {
  const current = await tailscaleStatus(port);
  if (!current.signedIn) return { ok: false, error: "Sign in to Tailscale first." };
  if (current.shared) return { ok: true };
  if (current.servingOther) {
    return { ok: false, error: `Something else is already shared at ${current.url} — this won't replace it.` };
  }
  // `serve` can stop to ask for consent in a browser when HTTPS is off; with
  // no terminal to ask in, it waits, so the timeout turns that into an answer.
  const result = await run(["serve", "--bg", String(port)], 20_000);
  const after = await tailscaleStatus(port);
  if (after.shared) return { ok: true };
  return { ok: false, ...explain(`${result.stdout}\n${result.stderr}`) };
}

export async function unshareApp(port) {
  const current = await tailscaleStatus(port);
  if (!current.shared) return { ok: true };
  const result = await run(["serve", "--https=443", "off"]);
  const after = await tailscaleStatus(port);
  return after.shared ? { ok: false, ...explain(`${result.stdout}\n${result.stderr}`) } : { ok: true };
}

// `tailscale up` prints a sign-in link and then waits — for minutes — until
// the reader finishes in the browser. So: start it, answer with the link as
// soon as it appears, and leave it running to complete on its own.
let signingIn = null;
export function signIn() {
  if (signingIn?.link) return Promise.resolve({ ok: true, link: signingIn.link });
  return new Promise((resolve) => {
    let output = "";
    let done = false;
    let giveUp = null;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(giveUp);
      resolve(value);
    };
    let child;
    try {
      child = spawn(binary(), ["up"], { stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      finish({ ok: false, error: error.message });
      return;
    }
    signingIn = { child, link: "" };
    const kill = setTimeout(() => child.kill("SIGTERM"), 10 * 60_000);
    const read = (chunk) => {
      output += chunk.toString();
      const link = output.match(/https:\/\/login\.tailscale\.com\/\S+/)?.[0];
      if (link) {
        signingIn.link = link;
        finish({ ok: true, link });
      }
    };
    child.stdout.on("data", read);
    child.stderr.on("data", read);
    child.on("error", (error) => finish({ ok: false, error: error.message }));
    child.on("close", (code) => {
      clearTimeout(kill);
      signingIn = null;
      // Exited without a link: either already signed in (`up` just connects),
      // or refused.
      finish(code === 0 ? { ok: true } : { ok: false, ...explain(output) });
    });
    giveUp = setTimeout(() => {
      finish({ ok: false, error: "Tailscale didn't give a sign-in link. Open the Tailscale app and sign in there." });
    }, 20_000);
  });
}

// The computer itself, not a phone arriving through `tailscale serve`.
export function fromThisComputer(req) {
  const host = String(req.headers.host || "").replace(/:\d+$/, "").toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

// GET /api/tailscale, POST /api/tailscale { action: "share" | "unshare" | "signin" }
export async function handleTailscale(req, res, { port }) {
  const here = fromThisComputer(req) ? "computer" : "remote";
  if (req.method === "GET") {
    sendJson(res, 200, { ...(await tailscaleStatus(port)), here });
    return;
  }
  // As /api/llm: a JSON content type forces a CORS preflight this server never
  // answers, so another website can't drive this.
  if (!String(req.headers["content-type"] || "").startsWith("application/json")) {
    sendJson(res, 415, { error: "Send JSON." });
    return;
  }
  if (here !== "computer") {
    sendJson(res, 403, { error: "Change this from the computer Stele runs on." });
    return;
  }
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: "Couldn't read that." });
    return;
  }
  const actions = { share: () => shareApp(port), unshare: () => unshareApp(port), signin: signIn };
  const act = actions[body?.action];
  if (!act) {
    sendJson(res, 400, { error: "Unknown action." });
    return;
  }
  const result = await act();
  sendJson(res, result.ok ? 200 : 409, { ...result, status: await tailscaleStatus(port) });
}
