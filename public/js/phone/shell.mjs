// The phone edition's frame (and so the Android app's): the look chosen for
// it, "design A" — a bar of four tabs at the bottom (Videos, Words, Cards,
// Settings), a Videos tab that opens on the list of videos rather than on a
// player, and a player screen of its own with a way back. phone.css draws it;
// this module only adds the few elements it needs and keeps
// <html data-phone-screen="library|player"> and the tabs in step with the app.
//
// Nothing here replaces the app's own controls: the tabs press the hidden
// .nav-tab buttons (so switchView in main.mjs stays the one way to change
// view), Words presses the "N new words" button, and a video opens through the
// Videos list exactly as before — this only notices that it did.

import { state } from "../state.mjs";

const ICONS = {
  study: '<path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v11a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 17.5z"/><path d="M10 9l5 3-5 3z" fill="currentColor"/>',
  words: '<path d="M5 6h14M5 12h14M5 18h9"/>',
  cards: '<rect x="6" y="4" width="12" height="16" rx="2.5"/><path d="M3.5 7.5v10A2.5 2.5 0 0 0 6 20"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7"/>',
};
const TABS = [
  ["study", "Videos"],
  ["words", "Words"],
  ["cards", "Cards"],
  ["settings", "Settings"],
];
const TITLES = { cards: "Cards", settings: "Settings" };

export function setupPhoneShell(doc = globalThis.document) {
  const root = doc.documentElement;
  const $ = (sel) => doc.querySelector(sel);
  const topbar = $(".topbar");
  if (!topbar || root.dataset.phoneShell) return null;
  root.dataset.phoneShell = "on";
  root.dataset.phoneScreen = "library";

  // ── Top bar: back (player only), the screen's name, the language pair.
  const back = el(doc, "button", { id: "phoneBack", class: "phone-back", type: "button", "aria-label": "Back to your videos" }, "‹");
  const title = el(doc, "span", { id: "phoneTitle", class: "phone-title" }, "Stele");
  const langs = el(doc, "button", { id: "phoneLangs", class: "phone-chip", type: "button", "aria-expanded": "false", title: "Languages" });
  topbar.prepend(back, title);
  topbar.append(langs);

  // ── Bottom bar.
  const nav = el(doc, "nav", { class: "phone-nav", "aria-label": "Main views" });
  for (const [view, label] of TABS) {
    const button = el(doc, "button", { type: "button", class: "phone-tab", "data-tab": view });
    button.innerHTML = `<i aria-hidden="true"><svg viewBox="0 0 24 24">${ICONS[view]}</svg></i><span>${label}</span>`;
    nav.append(button);
  }
  doc.body.append(nav);

  // ── The Videos tab's list: what's open now comes first.
  const resume = el(doc, "button", { id: "phoneContinue", class: "phone-continue", type: "button" });
  const head = $("#videoListHead");
  head?.parentNode.insertBefore(resume, head);

  const currentView = () => $(".nav-tab.active")?.dataset.view || root.dataset.view || "study";
  const currentTitle = () => {
    const source = state.sources?.find((s) => s.id === state.currentSourceId);
    return source ? source.title || source.url || "This video" : "Sample lesson";
  };

  function render() {
    const view = currentView();
    const screen = root.dataset.phoneScreen;
    root.dataset.phoneView = view;
    for (const tab of nav.children) tab.classList.toggle("on", tab.dataset.tab === view);
    title.textContent = view === "study" ? (screen === "player" ? currentTitle() : "Stele") : TITLES[view] || "Stele";
    const lines = state.subtitles?.length || 0;
    resume.innerHTML = "";
    resume.append(
      el(doc, "span", { class: "phone-continue-thumb", "aria-hidden": "true" }, "▶"),
      el(doc, "span", { class: "phone-continue-text" }, el(doc, "b", {}, currentTitle()), el(doc, "small", {}, lines ? `Continue · ${lines} lines` : "Continue")),
    );
    resume.hidden = !lines;
    const from = $("#translateFrom");
    const to = $("#translateTo");
    const name = (select) => select?.selectedOptions?.[0]?.textContent?.trim() || "";
    // "Detect language" is the long way of saying the app will work it out.
    const fromName = !from?.value || /^detect/i.test(name(from)) ? "Auto" : name(from);
    langs.textContent = to ? `${fromName} → ${name(to) || "English"}` : "";
  }

  function setScreen(screen) {
    if (root.dataset.phoneScreen === screen) return render();
    root.dataset.phoneScreen = screen;
    if (screen === "library") $("#video")?.pause?.();
    globalThis.scrollTo?.(0, 0);
    render();
  }

  function setLangs(open) {
    root.dataset.phoneLangs = open ? "open" : "";
    langs.setAttribute("aria-expanded", String(open));
  }

  back.addEventListener("click", () => setScreen("library"));
  langs.addEventListener("click", () => setLangs(root.dataset.phoneLangs !== "open"));
  resume.addEventListener("click", () => setScreen("player"));
  nav.addEventListener("click", (event) => {
    const tab = event.target.closest(".phone-tab")?.dataset.tab;
    if (!tab) return;
    if (tab === "words") {
      // The word list is a pop-up over the transcript it lists.
      $('.nav-tab[data-view="study"]')?.click();
      if (root.dataset.phoneScreen === "library" && state.subtitles?.length) setScreen("player");
      $("#newWordCount")?.click();
      return render();
    }
    // Videos again, from the player: back to the list, like any tab bar.
    if (tab === "study" && currentView() === "study") setScreen("library");
    $(`.nav-tab[data-view="${tab}"]`)?.click();
    render();
  });

  // A video opened from the list, a file chosen, or the Open in a finished
  // import's toast: each loads the player within moments of a tap.
  let lastTap = -Infinity;
  doc.addEventListener("pointerdown", () => (lastTap = Date.now()), true);
  $("#video")?.addEventListener("loadstart", () => {
    if (Date.now() - lastTap < 4000) setScreen("player");
  });
  $("#videoInput")?.addEventListener("change", () => setScreen("player"));
  $("#videoList")?.addEventListener("click", (event) => {
    const row = event.target.closest(".video-row.video-ready");
    if (row && !event.target.closest(".video-action, .video-select")) setScreen("player");
  });

  // Keep the names and tabs right as the app changes underneath.
  for (const id of ["#translateFrom", "#translateTo"]) $(id)?.addEventListener("change", render);
  const observer = new MutationObserver(render);
  for (const tab of doc.querySelectorAll(".nav-tab")) observer.observe(tab, { attributes: true, attributeFilter: ["class"] });
  observer.observe(root, { attributes: true, attributeFilter: ["data-view"] });
  const list = $("#videoList");
  if (list) observer.observe(list, { childList: true });
  const transcript = $("#transcript");
  if (transcript) observer.observe(transcript, { childList: true });
  render();

  // The Android back button (android.js) comes here once nothing is open.
  globalThis.stelePhoneBack = () => {
    if (root.dataset.phoneLangs === "open") return setLangs(false), true;
    if (currentView() === "study" && root.dataset.phoneScreen === "player") return setScreen("library"), true;
    return false;
  };
  return { setScreen, render };
}

function el(doc, tag, attrs = {}, ...children) {
  const node = doc.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  for (const child of children) node.append(child);
  return node;
}
