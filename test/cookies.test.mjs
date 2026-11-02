import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, stat, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

const ROOT = await mkdtemp(join(tmpdir(), "stele-cookies-"));
process.env.STELE_PREFS_DIR = join(ROOT, "stele");
const {
  handleGetCookies,
  handleSaveCookies,
  ytdlpCookieArgs,
  validBrowserSpec,
  countCookies,
  adoptLegacyCookies,
  forgetCookieAdoption,
} = await import("../server/cookies.mjs");

const COOKIES = [
  "# Netscape HTTP Cookie File",
  ".youtube.com\tTRUE\t/\tTRUE\t0\tSID\tsecret-session",
  "#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t0\tHSID\tsecret-two",
  "",
].join("\n");

function request(body) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  req.headers = { "content-type": "application/json" };
  return req;
}
function response() {
  const res = { status: 0, body: "" };
  res.writeHead = (status) => (res.status = status);
  res.end = (text) => (res.body = text || "");
  return res;
}
async function get() {
  const res = response();
  await handleGetCookies({}, res);
  return JSON.parse(res.body);
}
async function save(body) {
  const res = response();
  await handleSaveCookies(request(body), res);
  return JSON.parse(res.body);
}

// No legacy folder for these tests; adoption has its own.
forgetCookieAdoption();
await adoptLegacyCookies(join(ROOT, "no-legacy"));

test("a pasted cookie file is stored 0600 and never sent back", async () => {
  const saved = await save({ mode: "file", cookiesTxt: COOKIES });
  assert.deepEqual(saved, { mode: "file", browser: "", hasFile: true, cookieCount: 2 });
  const read = await get();
  assert.equal(JSON.stringify(read).includes("secret"), false);
  if (process.platform !== "win32") {
    assert.equal((await stat(join(process.env.STELE_PREFS_DIR, "cookies.txt"))).mode & 0o777, 0o600);
    assert.equal((await stat(process.env.STELE_PREFS_DIR)).mode & 0o777, 0o700);
  }
  assert.deepEqual(await ytdlpCookieArgs(), ["--cookies", join(process.env.STELE_PREFS_DIR, "cookies.txt")]);
});

test("saving with the box empty keeps the file; removing is explicit", async () => {
  await save({ mode: "file", cookiesTxt: COOKIES });
  assert.equal((await save({ mode: "file", cookiesTxt: "" })).hasFile, true);
  const removed = await save({ mode: "none", removeFile: true });
  assert.equal(removed.hasFile, false);
  assert.deepEqual(await ytdlpCookieArgs(), []);
});

test("text that isn't a cookie file is refused", async () => {
  await assert.rejects(save({ mode: "file", cookiesTxt: "hello" }), { status: 400 });
});

test("only browsers yt-dlp knows, and only absolute existing profile paths", async () => {
  const profile = join(ROOT, "profile.Default");
  await mkdir(profile);
  assert.equal(await validBrowserSpec("firefox"), "firefox");
  assert.equal(await validBrowserSpec("chrome:Profile 1"), "chrome:Profile 1");
  assert.equal(await validBrowserSpec("chromium+kwallet6"), "chromium+kwallet6");
  assert.equal(await validBrowserSpec(`firefox:${profile}`), `firefox:${profile}`);
  assert.equal(await validBrowserSpec("firefox::Personal"), "firefox::Personal");
  for (const bad of [
    "",
    "netscape",
    "firefox+evil",
    "firefox:",
    "firefox:relative/path",
    `firefox:${profile}/../..`,
    `firefox:${join(ROOT, "missing")}`,
    "firefox\n--exec",
    "--exec=rm",
    "firefox::a::b",
  ]) {
    assert.equal(await validBrowserSpec(bad), null, JSON.stringify(bad));
  }
  await assert.rejects(save({ mode: "browser", browser: "--exec=touch /tmp/x" }), { status: 400 });
  assert.equal((await save({ mode: "browser", browser: "firefox" })).browser, "firefox");
  assert.deepEqual(await ytdlpCookieArgs(), ["--cookies-from-browser", "firefox"]);
});

test("a hand-edited cookies.json can't put an unchecked value on yt-dlp's command line", async () => {
  await writeFile(join(process.env.STELE_PREFS_DIR, "cookies.json"), JSON.stringify({ mode: "browser", browser: "--exec=x" }));
  assert.deepEqual(await ytdlpCookieArgs(), []);
});

test("countCookies skips comments and blank lines but counts #HttpOnly_", () => {
  assert.equal(countCookies(COOKIES), 2);
  assert.equal(countCookies(""), 0);
});

test("old data/cookies.* move into the data folder once and the originals go", async () => {
  const legacy = join(ROOT, "legacy");
  await mkdir(legacy);
  process.env.STELE_PREFS_DIR = join(ROOT, "adopted");
  try {
    await writeFile(join(legacy, "cookies.json"), JSON.stringify({ mode: "file" }));
    await writeFile(join(legacy, "cookies.txt"), COOKIES);
    forgetCookieAdoption();
    await adoptLegacyCookies(legacy);
    assert.equal(await readFile(join(ROOT, "adopted", "cookies.txt"), "utf8"), COOKIES);
    await assert.rejects(access(join(legacy, "cookies.txt")));
    await assert.rejects(access(join(legacy, "cookies.json")));
    assert.deepEqual(await get(), { mode: "file", browser: "", hasFile: true, cookieCount: 2 });
  } finally {
    process.env.STELE_PREFS_DIR = join(ROOT, "stele");
  }
});
