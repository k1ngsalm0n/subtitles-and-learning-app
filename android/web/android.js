// Loaded first by the Android app's copy of index.html (scripts/build-android.mjs),
// never by a browser. It fills the three gaps between a WebView and a browser,
// talking to MainActivity.java through window.SteleAndroid:
//
//  * Export: a WebView has no downloads, so a click on an <a download> whose
//    address is a blob hands the blob's bytes to the phone's "Save to…" screen.
//    The page revokes the address right after clicking (flashcards.mjs), so
//    blobs are remembered as their addresses are made, not fetched afterwards.
//  * The back button: closes what's open — a dialog, the word pop-up, Words to
//    learn — then goes back to Study, and only then leaves the app.
//  * The status and navigation bars take the page's background, light or dark.
(() => {
  const bridge = window.SteleAndroid;
  if (!bridge) return;

  const blobs = new Map();
  const make = URL.createObjectURL.bind(URL);
  const revoke = URL.revokeObjectURL.bind(URL);
  URL.createObjectURL = (obj) => {
    const url = make(obj);
    if (obj instanceof Blob) blobs.set(url, obj);
    return url;
  };
  // Kept a moment longer than the page keeps it, for the click that's reading it.
  URL.revokeObjectURL = (url) => {
    revoke(url);
    setTimeout(() => blobs.delete(url), 10_000);
  };

  function save(blob, name) {
    const reader = new FileReader();
    reader.onload = () => {
      const data = String(reader.result);
      bridge.saveFile(name || "stele-export", blob.type || "application/octet-stream", data.slice(data.indexOf(",") + 1));
    };
    reader.readAsDataURL(blob);
  }

  const click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    const blob = this.hasAttribute("download") && blobs.get(this.href);
    if (blob) return save(blob, this.getAttribute("download"));
    return click.call(this);
  };
  document.addEventListener(
    "click",
    (event) => {
      const link = event.target.closest?.("a[download]");
      const blob = link && blobs.get(link.href);
      if (!blob) return;
      event.preventDefault();
      save(blob, link.getAttribute("download"));
    },
    true,
  );

  const shown = (el) => el && !el.hidden && el.getClientRects().length > 0;
  const escape = () =>
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));

  window.steleAndroidBack = () => {
    const dialog = [...document.querySelectorAll("dialog[open]")].pop();
    if (dialog) {
      dialog.close();
      return true;
    }
    if ([...document.querySelectorAll(".word-bubble, .word-list-panel, details.card-menu[open]")].some(shown)) {
      escape();
      return true;
    }
    // The phone's own screens: the languages panel, then player → videos.
    if (window.stelePhoneBack?.()) return true;
    const study = document.querySelector('.nav-tab[data-view="study"]');
    if (study && !study.classList.contains("active")) {
      study.click();
      return true;
    }
    return false;
  };

  // Android reads #rrggbb only: "#000" and "rgb(0, 0, 0)" are turned into it.
  const toHex = (css) => {
    const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(css);
    if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
    const rgb = /^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i.exec(css);
    if (rgb) return `#${rgb.slice(1, 4).map((n) => Number(n).toString(16).padStart(2, "0")).join("")}`;
    return css;
  };
  window.steleAndroidColour = toHex;
  let last = "";
  const paintBars = () => {
    const colour = toHex(getComputedStyle(document.documentElement).getPropertyValue("--bg").trim());
    if (colour && colour !== last) {
      last = colour;
      bridge.setBarColor(colour);
    }
  };
  new MutationObserver(paintBars).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "style"] });
  document.addEventListener("DOMContentLoaded", paintBars);
  // The phone's own stylesheet (phone.css) may land after that first read.
  window.addEventListener("load", paintBars);
  setTimeout(paintBars, 1500);
})();
