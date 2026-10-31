// YouTube cookies for yt-dlp: none, read from a browser, or a pasted file.
//
// A pasted cookies.txt is a live sign-in to the reader's Google account, so it
// is treated like the chat-model key: kept in the data folder outside the
// checkout (~/.local/share/stele, 0600 in a 0700 folder) and never sent back
// to the page. GET /api/cookies says whether a file is saved and how many
// cookies are in it, which is all the Settings page needs to show.
//
// It used to live in the checkout's data/ folder, world-readable, and GET
// returned the whole file. adoptLegacyCookies() moves an old copy across once.

import { readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJsonBody, sendJson, HttpError } from "./util.mjs";
import { dir, writePrivate } from "./prefs.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LEGACY_DIR = path.join(__dirname, "..", "data");

// Per call, like prefs.mjs, so STELE_PREFS_DIR (tests, the sandbox) applies.
const settingsPath = () => path.join(dir(), "cookies.json");
const cookiesTxtPath = () => path.join(dir(), "cookies.txt");

// Move data/cookies.json and data/cookies.txt into the data folder, once, and
// delete the old copies. Only when the new location has nothing yet: a choice
// made since is the newer one. Anything that fails is left where it was.
let adopted = null;
export function adoptLegacyCookies(legacyDir = LEGACY_DIR) {
  adopted ??= (async () => {
    for (const [name, target] of [
      ["cookies.json", settingsPath()],
      ["cookies.txt", cookiesTxtPath()],
    ]) {
      const old = path.join(legacyDir, name);
      const text = await readFile(old, "utf8").catch(() => null);
      if (text === null) continue;
      const already = await stat(target).then(() => true, () => false);
      try {
        if (!already) await writePrivate(target, text);
        await rm(old, { force: true });
      } catch {
        // Leave the original rather than lose it.
      }
    }
  })();
  return adopted;
}

// Tests point dir() somewhere new and want the move to run again.
export function forgetCookieAdoption() {
  adopted = null;
}

async function readSettings() {
  await adoptLegacyCookies();
  try {
    return JSON.parse(await readFile(settingsPath(), "utf8"));
  } catch {
    return { mode: "none" };
  }
}

// yt-dlp's --cookies-from-browser takes BROWSER[+KEYRING][:PROFILE][::CONTAINER].
// The browser and keyring come from yt-dlp's own lists. A profile is either a
// name ("Profile 1") or an absolute path to an existing profile folder — the
// way to reach a fork such as Zen, which yt-dlp reads as firefox. A relative
// path, "..", or anything with a newline is refused.
const BROWSERS = ["brave", "chrome", "chromium", "edge", "firefox", "opera", "safari", "vivaldi", "whale"];
const KEYRINGS = ["basictext", "gnomekeyring", "kwallet", "kwallet5", "kwallet6"];

export async function validBrowserSpec(value) {
  const spec = String(value || "").trim();
  if (!spec || /[\0\r\n]/.test(spec) || spec.length > 500) return null;
  const [main, container, ...extra] = spec.split("::");
  if (extra.length || (container !== undefined && !/^[\w .-]{1,100}$/.test(container))) return null;
  const at = main.indexOf(":");
  const head = at < 0 ? main : main.slice(0, at);
  const profile = at < 0 ? "" : main.slice(at + 1);
  const [browser, keyring, ...more] = head.toLowerCase().split("+");
  if (more.length || !BROWSERS.includes(browser)) return null;
  if (keyring !== undefined && !KEYRINGS.includes(keyring)) return null;
  if (at >= 0) {
    if (!profile) return null;
    if (/[\\/]/.test(profile)) {
      if (!path.isAbsolute(profile) || profile.split(/[\\/]/).includes("..")) return null;
      const info = await stat(profile).catch(() => null);
      if (!info?.isDirectory()) return null;
    }
  }
  return spec;
}

// Netscape format: one tab-separated cookie per line; comments start with #,
// except "#HttpOnly_", which marks a real cookie.
export function countCookies(text) {
  return String(text || "")
    .split(/\r?\n/)
    .filter((line) => line.trim() && (!line.startsWith("#") || line.startsWith("#HttpOnly_")) && line.split("\t").length >= 7)
    .length;
}

export async function ytdlpCookieArgs() {
  const settings = await readSettings();
  if (settings.mode === "browser" && settings.browser) {
    // Checked again here: a cookies.json written before validation existed, or
    // edited by hand, must not reach yt-dlp's command line unchecked.
    const spec = await validBrowserSpec(settings.browser);
    return spec ? ["--cookies-from-browser", spec] : [];
  }
  if (settings.mode === "file") {
    try {
      await stat(cookiesTxtPath());
      return ["--cookies", cookiesTxtPath()];
    } catch {
      return [];
    }
  }
  return [];
}

// GET /api/cookies -> { mode, browser, hasFile, cookieCount }. Never the file.
export async function handleGetCookies(_req, res) {
  const settings = await readSettings();
  const text = await readFile(cookiesTxtPath(), "utf8").catch(() => null);
  sendJson(res, 200, {
    mode: settings.mode || "none",
    browser: settings.browser || "",
    hasFile: text !== null,
    cookieCount: text === null ? 0 : countCookies(text),
  });
}

// POST /api/cookies { mode: "none" | "browser" | "file", browser, cookiesTxt, removeFile }
//
// In file mode an empty cookiesTxt keeps the saved file — the page no longer
// has its contents to send back, so "save" with the box left empty must not
// wipe it. Removing it is its own request: { removeFile: true }.
export async function handleSaveCookies(req, res) {
  const body = await readJsonBody(req);
  const { mode, browser, cookiesTxt, removeFile } = body || {};

  if (removeFile) await rm(cookiesTxtPath(), { force: true });

  if (mode === "browser") {
    const spec = await validBrowserSpec(browser);
    if (!spec) {
      throw new HttpError(
        400,
        `Name a browser yt-dlp can read: ${BROWSERS.join(", ")} — optionally with :profile, ` +
          "where a profile path must be absolute and exist.",
      );
    }
    await writePrivate(settingsPath(), JSON.stringify({ mode: "browser", browser: spec }, null, 2));
  } else if (mode === "file") {
    const text = String(cookiesTxt || "");
    if (text.trim()) {
      if (!countCookies(text)) throw new HttpError(400, "That doesn't look like a cookies.txt file (Netscape format).");
      await writePrivate(cookiesTxtPath(), text);
    }
    await writePrivate(settingsPath(), JSON.stringify({ mode: "file" }, null, 2));
  } else {
    await writePrivate(settingsPath(), JSON.stringify({ mode: "none" }, null, 2));
  }

  await handleGetCookies(req, res);
}
