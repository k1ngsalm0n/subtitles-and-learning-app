# Stele for Android

The Android app is the phone edition (see "The phone edition" in CLAUDE.md)
in a small native shell. It needs no computer: videos come from the phone's
own files, and Groq, on the reader's own free key, transcribes, translates
and explains them. Cards, videos and settings stay on the phone.

## Installing it (for readers)

1. On the phone, open the repo's **Releases** page and download `stele.apk`.
2. Open the downloaded file. Android says the browser (or Files app) isn't
   allowed to install apps: tap **Settings**, turn on **Allow from this
   source**, and go back. This is asked once.
3. Tap **Install**, then **Open**. Paste a Groq key when asked (or "Not now"
   for dictionary meanings only).

Play Protect may warn that it doesn't recognise the app — it says that of any
app not from the Play Store. **More details → Install anyway**.

A newer `stele.apk` installs over the old one and keeps everything. Moving
cards to another phone or a computer is **Settings → Your data → Export**,
then **Import** there. Uninstalling the app deletes its cards: export first.

## Building it

```bash
npm run build:android            # → dist/stele.apk, signed with your release key
npm run build:android -- --debug # → dist/stele-debug.apk, the SDK's debug key
```

Needs the Android SDK (a platform and build-tools — Android Studio installs
both into `~/Android/Sdk`; or set `ANDROID_HOME`) and a JDK (`JAVA_HOME`, or
Android Studio's own `jbr`, which the script finds). No Gradle: one activity
and no libraries is little enough for the SDK's command-line tools
(`aapt2`, `javac`, `d8`, `zipalign`, `apksigner`); `scripts/build-android.mjs`
runs them in turn. The full CC-CEDICT goes in when `npm run sync` has fetched
it, else the small seed; a worktree can point `--dict` at the main checkout's
`data/cedict.u8`.

**The signing key.** The first release build makes one in
`~/.local/share/stele/android/release.jks`, with its password in
`release.password` beside it. Android installs an update only when it is
signed with the same key as the app already on the phone, so **back both
files up**: without them, the next version can't install over the old one,
and readers would have to uninstall — losing their cards — to get it. Never
commit them. A CI build would take them from secrets through
`STELE_ANDROID_KEYSTORE` and `STELE_ANDROID_KEYSTORE_PASSWORD`.

## How the shell works

`android/src/app/stele/MainActivity.java` is a WebView that does only what a
browser would have done for the page:

- **Serves the page** from the APK's assets on
  `https://appassets.androidplatform.net/` — ES modules refuse `file://`, and
  this address is a secure origin for IndexedDB and `crypto`. `sw.js` answers
  404 on purpose: the files are already on the phone. Every file type in the
  build needs an entry in `MIME`, or a module won't run (a test checks).
- **File picker** for `<input type="file">` — the system's, with audio
  allowed wherever video is.
- **Export**: a WebView has no downloads. `android/web/android.js`, which the
  build puts first in `<head>`, remembers each blob as `URL.createObjectURL`
  makes it (the page revokes the address right after clicking) and hands a
  download link's bytes to `SteleAndroid.saveFile`, which opens Android's
  "Save to…" screen.
- **Back** closes a dialog, the word pop-up or Words to learn, then goes back
  to Study, and only then leaves the app (`steleAndroidBack` in android.js).
- **System bars** take the page's `--bg`, light or dark, and the page is padded
  clear of them (Android 15 draws apps edge to edge).

Links to other sites (Groq's key page) open in the phone's browser.

## Trying a build in the emulator

```bash
~/Android/Sdk/emulator/emulator -avd <name> -no-audio -no-snapshot -gpu host -qt-hide-window &
adb install -r dist/stele-debug.apk && adb shell am start -n app.stele/.MainActivity
adb exec-out screencap -p > screen.png
adb logcat -s Stele        # the page's console
```

On one Fedora machine the emulator crashed during boot with the software
renderers (`swiftshader_indirect`, `guest`) and booted with `-gpu host`.
