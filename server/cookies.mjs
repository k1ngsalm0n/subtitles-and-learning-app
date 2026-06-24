import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJsonBody, sendJson } from "./util.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
const SETTINGS_PATH = path.join(DATA_DIR, "cookies.json");
const COOKIES_TXT_PATH = path.join(DATA_DIR, "cookies.txt");

async function readSettings() {
  try {
    return JSON.parse(await readFile(SETTINGS_PATH, "utf8"));
  } catch {
    return { mode: "none" };
  }
}

async function writeSettings(settings) {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(SETTINGS_PATH, JSON.stringify(settings, null, 2));
}

export async function ytdlpCookieArgs() {
  const settings = await readSettings();
  if (settings.mode === "browser" && settings.browser) {
    return ["--cookies-from-browser", settings.browser];
  }
  if (settings.mode === "file") {
    try {
      await readFile(COOKIES_TXT_PATH);
      return ["--cookies", COOKIES_TXT_PATH];
    } catch {
      return [];
    }
  }
  return [];
}

export async function handleGetCookies(_req, res) {
  const settings = await readSettings();
  let cookiesTxt = "";
  if (settings.mode === "file") {
    try {
      cookiesTxt = await readFile(COOKIES_TXT_PATH, "utf8");
    } catch {
      // no file yet
    }
  }
  sendJson(res, 200, { ...settings, cookiesTxt });
}

export async function handleSaveCookies(req, res) {
  const body = await readJsonBody(req);
  const { mode, browser, cookiesTxt } = body;

  if (mode === "browser") {
    await writeSettings({ mode: "browser", browser: browser || "" });
  } else if (mode === "file") {
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(COOKIES_TXT_PATH, cookiesTxt || "");
    await writeSettings({ mode: "file" });
  } else {
    await writeSettings({ mode: "none" });
  }

  sendJson(res, 200, { ok: true });
}
