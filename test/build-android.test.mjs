import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";

import { addAndroidScript, findJdk, findSdk, versionCode } from "../scripts/build-android.mjs";
import { buildPhone } from "../scripts/build-phone.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const SEED = path.join(ROOT, "data", "cedict-seed.u8");

test("android.js goes in ahead of every other script", () => {
  const html = '<!doctype html>\n<html lang="en" data-edition="phone">\n  <head>\n    <script>early()</script>';
  const out = addAndroidScript(html);
  assert.ok(out.indexOf("android.js") < out.indexOf("early()"));
  assert.throws(() => addAndroidScript("<html><body></body></html>"), /<head>/);
  // The real page has a <head> for it.
  assert.match(addAndroidScript(readFileSync(path.join(ROOT, "public", "index.html"), "utf8")), /<head>\n    <script src="android.js">/);
});

test("the version code is the commit count, and nothing that isn't one", () => {
  assert.equal(versionCode("295"), 295);
  assert.throws(() => versionCode("0"));
  assert.throws(() => versionCode("abc"));
});

test("the SDK is found from ANDROID_HOME, newest build-tools and platform first", (t) => {
  const sdk = mkdtempSync(path.join(os.tmpdir(), "stele-sdk-"));
  t.after(() => rmSync(sdk, { recursive: true, force: true }));
  for (const dir of ["build-tools/34.0.0", "build-tools/36.1.0", "build-tools/9.0.0", "platforms/android-34", "platforms/android-36"]) {
    mkdirSync(path.join(sdk, dir), { recursive: true });
  }
  writeFileSync(path.join(sdk, "platforms/android-36/android.jar"), "");
  const found = findSdk({ ANDROID_HOME: sdk });
  assert.equal(found.buildTools, path.join(sdk, "build-tools/36.1.0"));
  assert.equal(found.androidJar, path.join(sdk, "platforms/android-36/android.jar"));
});

test("javac comes from JAVA_HOME, else Android Studio's JDK, else PATH", (t) => {
  const home = mkdtempSync(path.join(os.tmpdir(), "stele-jdk-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  assert.equal(findJdk({}, home).javac, "javac");
  const studio = path.join(home, ".local/share/JetBrains/Toolbox/apps/android-studio/jbr/bin");
  mkdirSync(studio, { recursive: true });
  writeFileSync(path.join(studio, "javac"), "");
  assert.equal(findJdk({}, home).javac, path.join(studio, "javac"));
  const javaHome = path.join(home, "jdk");
  mkdirSync(path.join(javaHome, "bin"), { recursive: true });
  writeFileSync(path.join(javaHome, "bin", "javac"), "");
  assert.equal(findJdk({ JAVA_HOME: javaHome }, home).keytool, path.join(javaHome, "bin", "keytool"));
});

test("the app serves every kind of file the phone build contains with its own type", async (t) => {
  const out = mkdtempSync(path.join(os.tmpdir(), "stele-phone-"));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  await buildPhone({ out, dict: SEED });
  const walk = (dir) => readdirSync(dir).flatMap((n) => (statSync(path.join(dir, n)).isDirectory() ? walk(path.join(dir, n)) : [n]));
  const exts = new Set(walk(out).filter((n) => n.includes(".") && !n.startsWith(".")).map((n) => n.split(".").pop().toLowerCase()));
  const java = readFileSync(path.join(ROOT, "android/src/app/stele/MainActivity.java"), "utf8");
  const served = new Set([...java.matchAll(/MIME\.put\("(\w+)"/g)].map((m) => m[1]));
  // A module served as octet-stream doesn't run at all, so this would be a blank screen.
  for (const ext of exts) assert.ok(served.has(ext), `MainActivity has no type for .${ext}`);
});

// android.js, run against just enough of a page to watch what it hands the phone.
function loadAndroidJs({ dialogs = [], shown = [], studyActive = true } = {}) {
  const saved = [];
  const events = [];
  let studyClicked = false;
  class FakeAnchor {
    constructor() { this.attrs = {}; this.href = ""; this.clicked = false; }
    hasAttribute(name) { return name in this.attrs; }
    getAttribute(name) { return this.attrs[name]; }
    click() { this.clicked = true; }
  }
  const study = { classList: { contains: () => studyActive }, click: () => { studyClicked = true; } };
  const document = {
    documentElement: {},
    addEventListener: () => {},
    dispatchEvent: (event) => events.push(event.key),
    querySelector: (sel) => (sel.includes("study") ? study : null),
    querySelectorAll: (sel) => (sel === "dialog[open]" ? dialogs : sel.includes("word-bubble") ? shown : []),
  };
  let n = 0;
  const URL_ = { createObjectURL: () => `blob:stele/${++n}`, revokeObjectURL: () => {} };
  class FileReader {
    readAsDataURL(blob) {
      blob.arrayBuffer().then((buf) => {
        this.result = `data:${blob.type};base64,${Buffer.from(buf).toString("base64")}`;
        this.onload();
      });
    }
  }
  const window = { SteleAndroid: { saveFile: (...args) => saved.push(args), setBarColor: () => {} }, addEventListener: () => {} };
  const context = vm.createContext({
    window, document, URL: URL_, Blob, FileReader, HTMLAnchorElement: FakeAnchor, KeyboardEvent: class { constructor(type, init) { this.key = init.key; } },
    MutationObserver: class { observe() {} }, getComputedStyle: () => ({ getPropertyValue: () => "" }), setTimeout,
  });
  vm.runInContext(readFileSync(path.join(ROOT, "android/web/android.js"), "utf8"), context);
  return { context, window, saved, events, FakeAnchor, studyClicked: () => studyClicked };
}

test("Export's download link hands its file to the phone, even after the page revokes it", async () => {
  const { context, saved, FakeAnchor } = loadAndroidJs();
  const url = context.URL.createObjectURL(new Blob(['{"cards":[]}'], { type: "application/json" }));
  const link = new FakeAnchor();
  link.href = url;
  link.attrs.download = "stele-flashcards.json";
  link.click();
  context.URL.revokeObjectURL(url);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(link.clicked, false);
  assert.deepEqual(saved, [["stele-flashcards.json", "application/json", Buffer.from('{"cards":[]}').toString("base64")]]);

  // An ordinary link is left alone.
  const plain = new FakeAnchor();
  plain.href = "https://console.groq.com/keys";
  plain.click();
  assert.equal(plain.clicked, true);
});

test("the bar colour is handed to Android as #rrggbb, the only form it reads", () => {
  const { context } = loadAndroidJs();
  const toHex = context.window.steleAndroidColour;
  assert.equal(toHex("#000"), "#000000");
  assert.equal(toHex("#0d0f12"), "#0d0f12");
  assert.equal(toHex("rgb(246, 244, 239)"), "#f6f4ef");
});

test("back closes a dialog, then a pop-up, then returns to Study, then leaves", () => {
  let closed = false;
  const visible = { hidden: false, getClientRects: () => [1] };
  assert.equal(loadAndroidJs({ dialogs: [{ close: () => { closed = true; } }] }).window.steleAndroidBack(), true);
  assert.ok(closed);

  const popup = loadAndroidJs({ shown: [visible] });
  assert.equal(popup.window.steleAndroidBack(), true);
  assert.deepEqual(popup.events, ["Escape"]);

  const cards = loadAndroidJs({ studyActive: false });
  assert.equal(cards.window.steleAndroidBack(), true);
  assert.ok(cards.studyClicked());

  assert.equal(loadAndroidJs().window.steleAndroidBack(), false);
});
