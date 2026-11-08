// One check in front of every request, before any route sees it.
//
// The server only listens on loopback, which keeps the network out — but not
// the reader's own browser, and every website open in it can send requests to
// localhost. Two ways that goes wrong:
//
// - A page on another site posts a form to http://localhost:3000/api/… . The
//   browser sends it without asking (a form post is a "simple" request), so
//   the server acts on it even though the page never sees the answer: wipe
//   the backups by rotating junk in, start imports, overwrite the cookies.
// - DNS rebinding: a name the attacker controls answers with 127.0.0.1, so
//   their page *is* same-origin with the app as far as the browser knows, and
//   can read the replies too — the YouTube cookies, every card, and by
//   re-saving the chat provider with a new address, the stored API key.
//
// A few handlers guarded themselves by demanding a JSON content type, which
// stops the first and not the second, and only where someone remembered. This
// does it once, for every route, including ones added later:
//
// 1. `Host` must be this computer (localhost / 127.0.0.1 / [::1], on this
//    port) or this machine's Tailscale name. A rebinding page arrives with its
//    own name in `Host`, so it stops here.
// 2. Anything that changes something (not GET/HEAD) must come from the app's
//    own page: an `Origin`, when the browser sends one, has to name the same
//    host. POST must also be JSON — a form can't send that cross-site without
//    a CORS preflight this server never answers. The screenshot upload is the
//    one exception (its body is the image), and it is still held to rule 1
//    and to the Origin check.
// 3. Over Tailscale, the device must have been paired: the QR code carries a
//    random token, the first visit trades it for a cookie, and a request
//    without that cookie is refused. Otherwise every device on the tailnet —
//    which can be shared with other people — would have the whole API.
//
// Pure apart from the token file, so the decisions are tested without a
// server (test/gate.test.mjs).

import { randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { dir } from "./prefs.mjs";

export const PAIR_COOKIE = "stele_pair";
export const PAIR_PARAM = "pair";
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
// Bodies that aren't JSON, by path. Their handlers check what they were sent:
// the image's type (ocr.mjs), the chosen file's name (import.mjs).
const NOT_JSON = new Set(["/api/ocr-image", "/api/import-file"]);
// The browser's cap on a cookie's life; re-scanning the code renews it.
const COOKIE_MAX_AGE = 400 * 24 * 60 * 60;

// "pc.ts.net:443" -> { name: "pc.ts.net", port: "443" }. Brackets stay on an
// IPv6 literal, so "[::1]" matches the set above.
export function splitHost(value) {
  const host = String(value || "").trim().toLowerCase();
  const m = /^(\[[^\]]*\]|[^:]*)(?::(\d+))?$/.exec(host);
  return m ? { name: m[1], port: m[2] || "" } : null;
}

export function isLoopbackHost(value, port) {
  const host = splitHost(value);
  if (!host || !LOOPBACK.has(host.name)) return false;
  return !host.port || host.port === String(port);
}

// Headers only a proxy adds. `tailscale serve` is one, and puts these on
// everything it passes on; a request carrying any of them came from another
// device, whatever its `Host` says — so a phone is never mistaken for this
// computer even if a proxy rewrote Host to loopback. A cross-site page can't
// add them without a CORS preflight, which this server never answers, so a
// browser can't use them to look local (and adding them only ever makes a
// request *less* trusted).
const PROXY_HEADERS = ["x-forwarded-for", "x-forwarded-host", "forwarded", "tailscale-user-login"];

export function isProxied(req) {
  return PROXY_HEADERS.some((name) => req?.headers?.[name] !== undefined);
}

// The computer itself: a loopback Host and no proxy in between.
export function fromLoopback(req, port) {
  return isLoopbackHost(req?.headers?.host, port) && !isProxied(req);
}

export function isTailnetHost(value, tailnetName) {
  const host = splitHost(value);
  if (!host || !tailnetName) return false;
  // `tailscale serve` answers on https, so a port, if any, is 443.
  return host.name === tailnetName.toLowerCase() && (!host.port || host.port === "443");
}

function readCookie(header, name) {
  for (const part of String(header || "").split(";")) {
    const at = part.indexOf("=");
    if (at > 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return "";
}

// Constant-time, and false for anything empty or a different length (which
// timingSafeEqual would throw on).
export function tokenMatches(given, token) {
  const a = Buffer.from(String(given || ""));
  const b = Buffer.from(String(token || ""));
  return a.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}

const refuse = (status, error) => ({ ok: false, status, error });

// What to do with a request. `tailnetName` is this machine's ts.net name, or
// "" when it isn't on a tailnet; `token` the pairing token.
//
// -> { ok: true }
//  | { ok: false, status, error }
//  | { ok: false, redirect, setCookie }   (a valid ?pair=: trade it for a cookie)
export function checkRequest(req, { port, tailnetName = "", token = "" }) {
  const method = String(req.method || "GET").toUpperCase();
  const host = req.headers?.host;
  const proxied = isProxied(req);
  const loopback = !proxied && isLoopbackHost(host, port);
  // Through a proxy, a loopback Host means it was rewritten on the way: still
  // another device, held to pairing like any arrival over the tailnet.
  const tailnet =
    !loopback && (isTailnetHost(host, tailnetName) || (proxied && isLoopbackHost(host, port)));
  if (!loopback && !tailnet) {
    return refuse(403, "This address isn't Stele's. Open it at http://localhost:" + port + "/.");
  }

  const url = new URL(req.url || "/", "http://x");

  if (tailnet) {
    const offered = url.searchParams.get(PAIR_PARAM);
    if (offered !== null) {
      if (method !== "GET" || !tokenMatches(offered, token)) {
        return refuse(403, "That pairing code is out of date. Scan the QR code on your computer again.");
      }
      url.searchParams.delete(PAIR_PARAM);
      const rest = url.searchParams.toString();
      // Lax, not Strict. The QR code is opened from the camera app, which the
      // browser counts as a cross-site navigation, and a Strict cookie is
      // withheld for the rest of that navigation — including this redirect —
      // so a freshly paired phone was refused on arrival (and again whenever
      // it followed a link from a chat). Lax goes along with top-level GETs
      // only; another site's POSTs are already stopped by the Origin and JSON
      // checks above, and its images or scripts still get no cookie.
      return {
        ok: false,
        redirect: url.pathname + (rest ? `?${rest}` : ""),
        setCookie:
          `${PAIR_COOKIE}=${token}; Path=/; Max-Age=${COOKIE_MAX_AGE}; HttpOnly; Secure; SameSite=Lax`,
      };
    }
    if (!tokenMatches(readCookie(req.headers.cookie, PAIR_COOKIE), token)) {
      return refuse(403, "This device isn't paired with Stele. Scan the QR code on your computer again.");
    }
  }

  if (method === "GET" || method === "HEAD") return { ok: true };

  // Browsers send Origin on every cross-site request that changes something;
  // tools like curl send none and are already on this machine.
  const origin = req.headers?.origin;
  if (origin !== undefined) {
    let originHost = "";
    try {
      originHost = new URL(origin).host.toLowerCase();
    } catch {
      // "null" (a sandboxed frame, a file:// page) or garbage: not the app.
    }
    // Behind a proxy the page's own address is the forwarded host, if given.
    const forwarded = proxied && req.headers["x-forwarded-host"];
    const own = String(forwarded || host).split(",")[0].trim().toLowerCase();
    if (!originHost || (originHost !== own && originHost !== String(host).trim().toLowerCase())) {
      return refuse(403, "Requests that change something must come from Stele's own page.");
    }
  }

  if (method === "POST" && !NOT_JSON.has(url.pathname)) {
    const type = String(req.headers?.["content-type"] || "").split(";")[0].trim().toLowerCase();
    if (type !== "application/json") return refuse(415, "Send JSON.");
  }
  return { ok: true };
}

// The pairing token, made once and kept beside the settings (0600), so a
// phone stays paired across restarts. Keyed by directory, like prefs.mjs, so
// tests pointed elsewhere don't share one.
const tokens = new Map();

export function pairTokenFile() {
  return path.join(dir(), "pair-token");
}

export async function pairToken() {
  const file = pairTokenFile();
  if (tokens.has(file)) return tokens.get(file);
  let token = "";
  try {
    token = (await fs.readFile(file, "utf8")).trim();
  } catch {
    // None yet.
  }
  if (!/^[A-Za-z0-9_-]{32,}$/.test(token)) {
    token = randomBytes(32).toString("base64url");
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(temp, token, { mode: 0o600 });
    await fs.rename(temp, file);
  }
  tokens.set(file, token);
  return token;
}

export function forgetPairToken() {
  tokens.clear();
}
