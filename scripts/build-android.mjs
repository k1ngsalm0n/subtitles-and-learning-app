// Builds Stele for Android: an .apk anyone can install by hand.
//
//   node scripts/build-android.mjs [--out dist/stele.apk] [--debug] [--dict data/cedict.u8]
//
// The dictionary is the full CC-CEDICT when `npm run sync` has fetched it,
// as in build-phone; a worktree without it can point --dict at another
// checkout's.
//
// The app is the phone edition (scripts/build-phone.mjs) inside a WebView
// (android/src/app/stele/MainActivity.java), so there is nothing to keep in
// step: whatever the phone edition does, the app does. No Gradle and no
// Android Studio — the SDK's own command-line tools are enough for one
// activity with no libraries, in the same spirit as the server's "standard
// library only":
//
//   aapt2 compile + link   resources and manifest → an apk with no code
//   javac + d8             MainActivity.java → classes.dex
//   aapt add               classes.dex into the apk
//   zipalign + apksigner   aligned and signed
//
// Needs a JDK (javac, keytool) and the Android SDK with a platform and
// build-tools (ANDROID_HOME, else ~/Android/Sdk). Android Studio installs
// both; so does `sdkmanager "platforms;android-36" "build-tools;36.1.0"`.
//
// Signing: Android only installs an update signed with the same key as the
// app already on the phone, so the key must outlive any checkout. It is made
// once, on first build, in ~/.local/share/stele/android (outside the repo —
// never commit it), with its password beside it. STELE_ANDROID_KEYSTORE /
// STELE_ANDROID_KEYSTORE_PASSWORD name another (CI). Lose it and readers have
// to uninstall — losing their cards — to take the next version: back it up.
// --debug signs with the SDK's debug key instead, for trying a build.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile, chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildPhone } from "./build-phone.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const ANDROID = path.join(ROOT, "android");
let JDK = { javac: "javac", keytool: "keytool" };
const MIN_SDK = 26; // Android 8: WebView updates through the Play Store from here on
const TARGET_SDK = 35;

function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 && process.argv[at + 1] ? process.argv[at + 1] : fallback;
}

function newestVersionDir(dir) {
  if (!existsSync(dir)) return null;
  const versions = readdirSync(dir)
    .filter((name) => /^(android-)?\d/.test(name))
    .sort((a, b) => b.replace(/^android-/, "").localeCompare(a.replace(/^android-/, ""), undefined, { numeric: true }));
  return versions.length ? path.join(dir, versions[0]) : null;
}

export function findSdk(env = process.env) {
  const sdk = [env.ANDROID_HOME, env.ANDROID_SDK_ROOT, path.join(os.homedir(), "Android", "Sdk")].find(
    (dir) => dir && existsSync(dir),
  );
  if (!sdk) throw new Error("No Android SDK found. Set ANDROID_HOME, or install Android Studio (it puts one in ~/Android/Sdk).");
  const buildTools = newestVersionDir(path.join(sdk, "build-tools"));
  const platform = newestVersionDir(path.join(sdk, "platforms"));
  if (!buildTools) throw new Error(`No build-tools in ${sdk}: sdkmanager "build-tools;36.1.0"`);
  if (!platform || !existsSync(path.join(platform, "android.jar"))) {
    throw new Error(`No platform in ${sdk}: sdkmanager "platforms;android-36"`);
  }
  return { sdk, buildTools, androidJar: path.join(platform, "android.jar") };
}

// javac and keytool: JAVA_HOME's, else Android Studio's own JDK (it ships
// one, and a machine with only a Java runtime has no javac), else PATH's.
export function findJdk(env = process.env, home = os.homedir()) {
  const exe = process.platform === "win32" ? ".exe" : "";
  const candidates = [
    env.JAVA_HOME,
    path.join(home, ".local", "share", "JetBrains", "Toolbox", "apps", "android-studio", "jbr"),
    path.join(home, "android-studio", "jbr"),
    "/opt/android-studio/jbr",
    "/Applications/Android Studio.app/Contents/jbr/Contents/Home",
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Programs", "Android Studio", "jbr"),
    "C:\\Program Files\\Android\\Android Studio\\jbr",
  ].filter(Boolean);
  const home_ = candidates.find((dir) => existsSync(path.join(dir, "bin", "javac" + exe)));
  if (home_) return { javac: path.join(home_, "bin", "javac" + exe), keytool: path.join(home_, "bin", "keytool" + exe) };
  return { javac: "javac", keytool: "keytool" };
}

// The page loads android.js before anything else, so its hooks are in place
// before main.mjs makes its first blob. build-phone has already marked the
// <html> tag; this adds one line after <head>.
export function addAndroidScript(html) {
  if (!/<head>/.test(html)) throw new Error("index.html has no <head> for android.js.");
  return html.replace("<head>", '<head>\n    <script src="android.js"></script>');
}

// Every build gets a higher versionCode than the last (Android refuses to
// "update" to a lower one): the number of commits, which only grows on main.
export function versionCode(commitCount) {
  const n = Number(commitCount);
  if (!Number.isInteger(n) || n < 1) throw new Error(`Not a commit count: ${commitCount}`);
  return n;
}

function run(cmd, args, opts = {}) {
  try {
    return execFileSync(cmd, args, { stdio: ["ignore", "pipe", "pipe"], ...opts }).toString();
  } catch (error) {
    const detail = [error.stdout, error.stderr].map((b) => b?.toString().trim()).filter(Boolean).join("\n");
    throw new Error(`${path.basename(cmd)} failed:\n${detail || error.message}`);
  }
}

function listFiles(dir, ext) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(ext))
    .map((entry) => path.join(entry.parentPath ?? entry.path, entry.name));
}

async function signingKey(debug) {
  if (debug) {
    const ks = path.join(os.homedir(), ".android", "debug.keystore");
    if (!existsSync(ks)) {
      await mkdir(path.dirname(ks), { recursive: true });
      run(JDK.keytool, ["-genkeypair", "-keystore", ks, "-storepass", "android", "-keypass", "android", "-alias", "androiddebugkey",
        "-keyalg", "RSA", "-keysize", "2048", "-validity", "10000", "-dname", "CN=Android Debug,O=Android,C=US"]);
    }
    return { ks, pass: "android", made: false };
  }
  if (process.env.STELE_ANDROID_KEYSTORE) {
    const pass = process.env.STELE_ANDROID_KEYSTORE_PASSWORD;
    if (!pass) throw new Error("STELE_ANDROID_KEYSTORE is set but STELE_ANDROID_KEYSTORE_PASSWORD isn't.");
    return { ks: process.env.STELE_ANDROID_KEYSTORE, pass, made: false };
  }
  const dir = path.join(os.homedir(), ".local", "share", "stele", "android");
  const ks = path.join(dir, "release.jks");
  const passFile = path.join(dir, "release.password");
  if (existsSync(ks)) return { ks, pass: (await readFile(passFile, "utf8")).trim(), made: false };
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const pass = (await import("node:crypto")).randomBytes(24).toString("base64url");
  await writeFile(passFile, pass + "\n", { mode: 0o600 });
  run(JDK.keytool, ["-genkeypair", "-keystore", ks, "-storetype", "PKCS12", "-storepass", pass, "-keypass", pass,
    "-alias", "stele", "-keyalg", "RSA", "-keysize", "4096", "-validity", "36500", "-dname", "CN=Stele"]);
  await chmod(ks, 0o600);
  return { ks, pass, made: true };
}

export async function buildAndroid({ out = path.join(ROOT, "dist", "stele.apk"), debug = false, dict } = {}) {
  const { buildTools, androidJar } = findSdk();
  JDK = findJdk();
  const tool = (name) => path.join(buildTools, name);
  const pkg = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8"));
  const code = versionCode(run("git", ["rev-list", "--count", "HEAD"], { cwd: ROOT }).trim());

  const work = await mkdtemp(path.join(os.tmpdir(), "stele-android-"));
  try {
    // 1. The page: the phone edition, plus android.js.
    const www = path.join(work, "assets", "www");
    await buildPhone({ out: www, dict });
    await rm(path.join(www, ".nojekyll"), { force: true });
    const indexPath = path.join(www, "index.html");
    await writeFile(indexPath, addAndroidScript(await readFile(indexPath, "utf8")));
    await copyFile(path.join(ANDROID, "web", "android.js"), path.join(www, "android.js"));

    // 2. Resources: the checked-in values, plus the launcher icon made from
    //    the page's own (192px is a launcher icon's xxxhdpi size; Android 8+
    //    uses the adaptive one in mipmap-anydpi-v26, from the maskable icon).
    const res = path.join(work, "res");
    await mkdir(path.join(res, "mipmap-xxxhdpi"), { recursive: true });
    await cpDir(path.join(ANDROID, "res"), res);
    await copyFile(path.join(ROOT, "public", "icons", "icon-192.png"), path.join(res, "mipmap-xxxhdpi", "ic_launcher.png"));
    await copyFile(path.join(ROOT, "public", "icons", "maskable-512.png"), path.join(res, "mipmap-xxxhdpi", "ic_launcher_foreground.png"));
    const compiled = path.join(work, "res.zip");
    run(tool("aapt2"), ["compile", "--dir", res, "-o", compiled]);
    const gen = path.join(work, "gen");
    const bare = path.join(work, "bare.apk");
    run(tool("aapt2"), ["link", "-o", bare, "-I", androidJar, "--manifest", path.join(ANDROID, "AndroidManifest.xml"),
      "-A", path.join(work, "assets"), "--java", gen, "--min-sdk-version", String(MIN_SDK),
      "--target-sdk-version", String(TARGET_SDK), "--version-code", String(code), "--version-name", pkg.version,
      // Already-compressed files gain nothing from zipping again, and the
      // dictionary is read whole on every start.
      "-0", "png", "-0", "mp4", compiled]);

    // 3. Code.
    const classes = path.join(work, "classes");
    await mkdir(classes);
    run(JDK.javac, ["--release", "11", "-encoding", "UTF-8",
      "-classpath", androidJar, "-d", classes, ...listFiles(path.join(ANDROID, "src"), ".java"), ...listFiles(gen, ".java")]);
    const dex = path.join(work, "dex");
    await mkdir(dex);
    run(tool("d8"), ["--release", "--min-api", String(MIN_SDK), "--lib", androidJar, "--output", dex, ...listFiles(classes, ".class")]);
    run(tool("aapt"), ["add", bare, "classes.dex"], { cwd: dex });

    // 4. Aligned, then signed (in that order: signing covers the alignment).
    const aligned = path.join(work, "aligned.apk");
    run(tool("zipalign"), ["-p", "-f", "4", bare, aligned]);
    const key = await signingKey(debug);
    await mkdir(path.dirname(out), { recursive: true });
    run(tool("apksigner"), ["sign", "--v4-signing-enabled", "false", "--ks", key.ks, "--ks-pass", `pass:${key.pass}`, "--out", out, aligned]);
    run(tool("apksigner"), ["verify", out]);
    return { out, versionCode: code, versionName: pkg.version, keystore: key.ks, madeKey: key.made };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

async function cpDir(from, to) {
  const { cp } = await import("node:fs/promises");
  await cp(from, to, { recursive: true });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const debug = process.argv.includes("--debug");
  const result = await buildAndroid({ out: path.resolve(arg("out", path.join(ROOT, "dist", debug ? "stele-debug.apk" : "stele.apk"))), debug, dict: arg("dict", undefined) });
  console.log(`Built ${path.relative(process.cwd(), result.out)} (version ${result.versionName}, code ${result.versionCode})`);
  if (result.madeKey) {
    console.log(`\nMade a signing key: ${result.keystore}\nBack it up (with release.password beside it). Every update must be signed`);
    console.log("with it, or phones refuse to install the update over the old version.");
  }
}
