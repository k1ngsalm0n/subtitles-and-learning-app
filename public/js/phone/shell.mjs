// The phone edition's frame (and so the Android app's): the look chosen for
// it, "design C — Immersive". Home is a feed of big video cards with a yellow
// ＋ in the bar to add one; a video plays full screen with its line written
// big over the picture, words tapped right there; swipe up or down for the
// next or previous line, and the buttons down the side replay the line, slow
// it, hide the pinyin, save it, or list its new words. Reviews take a swipe:
// left Forgot, right Got it. phone.css draws it; this module adds the few
// elements it needs and keeps <html data-phone-screen="library|player"> and
// the tabs in step with the app.
//
// Nothing here replaces the app's own controls. The tabs press the hidden
// .nav-tab buttons (switchView in main.mjs stays the one way to change view);
// the transcript itself is the subtitle over the video — phone.css shows only
// its current line — so word taps, the karaoke sweep and the word pop-up are
// the app's own; and the side buttons and swipes go through the same keys and
// buttons a computer uses (→ next line, R replay, Save Line, "N new words").

import { state } from "../state.mjs";

const svg = (body) => `<svg viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;
const ICONS = {
  home: svg('<path d="M4 11l8-6.5 8 6.5"/><path d="M6.5 9.5V19h11V9.5"/>'),
  add: svg('<path d="M12 5v14M5 12h14"/>'),
  cards: svg('<rect x="6" y="4" width="12" height="16" rx="2.5"/><path d="M3.5 7.5v10A2.5 2.5 0 0 0 6 20"/>'),
  settings: svg('<circle cx="12" cy="12" r="3"/><path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7"/>'),
  replay: svg('<path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3"/><path d="M4.5 4.5v4h4"/>'),
  slow: svg('<path d="M3 16.5h13.5a3.5 3.5 0 0 0 0-7c-1 0-1.8.3-2.5.9"/><path d="M5 16.5a5.5 5.5 0 0 1 11 0"/><path d="M19.5 9.6l1.6-1.6"/>'),
  pinyin: svg('<path d="M5 8h14M9 4.5l1 3.5M15 4.5l-1 3.5M7 12h10l-1 7.5H8z"/>'),
  save: svg('<path d="M7 4h10v16l-5-3.5L7 20z"/>'),
  words: svg('<path d="M5 6h14M5 12h14M5 18h9"/>'),
};

export function setupPhoneShell(doc = globalThis.document) {
  const root = doc.documentElement;
  const $ = (sel) => doc.querySelector(sel);
  const topbar = $(".topbar");
  if (!topbar || root.dataset.phoneShell) return null;
  root.dataset.phoneShell = "on";
  root.dataset.phoneScreen = "library";
  const video = $("#video");

  // ── Top bar (Home, Cards, Settings): back, title, languages, cards due, ⚙.
  const back = el(doc, "button", { id: "phoneBack", class: "phone-back", type: "button", "aria-label": "Back" }, "‹");
  const title = el(doc, "span", { id: "phoneTitle", class: "phone-title" }, "Stele");
  const langs = el(doc, "button", { id: "phoneLangs", class: "phone-chip", type: "button", "aria-expanded": "false", title: "Languages" });
  const due = el(doc, "button", { id: "phoneDue", class: "phone-chip phone-due", type: "button", title: "Cards to review" });
  const gear = el(doc, "button", { id: "phoneSettings", class: "phone-icon", type: "button", "aria-label": "Settings" });
  gear.innerHTML = ICONS.settings;
  topbar.prepend(back, title);
  topbar.append(langs, due, gear);

  // ── Bottom bar: Home, a big ＋, Cards.
  const nav = el(doc, "nav", { class: "phone-nav", "aria-label": "Main views" });
  for (const [tab, label] of [["study", "Home"], ["add", "Add a video"], ["cards", "Cards"]]) {
    const button = el(doc, "button", { type: "button", class: `phone-tab phone-tab-${tab}`, "data-tab": tab, "aria-label": label });
    button.innerHTML = ICONS[tab === "study" ? "home" : tab];
    nav.append(button);
  }
  doc.body.append(nav);

  // ── Home: what's open now first, then every video, as big cards.
  const resume = el(doc, "button", { id: "phoneContinue", class: "phone-continue phone-reel", type: "button" });
  const empty = el(doc, "p", { id: "phoneEmpty", class: "phone-empty" }, "Tap ＋ to add a video or audio file from this phone. Stele writes its subtitles, and you tap any word to learn it.");
  const head = $("#videoListHead");
  head?.parentNode.insertBefore(resume, head);
  head?.parentNode.insertBefore(empty, head);

  // ── The player: a bar over the top, buttons down the side, progress along the bottom.
  const stage = el(doc, "div", { class: "phone-stage" });
  const stageBack = el(doc, "button", { id: "phoneStageBack", class: "phone-pill", type: "button", "aria-label": "Back to your videos" });
  const subsToggle = el(doc, "button", { id: "phoneSubs", class: "phone-pill", type: "button", "aria-pressed": "true", title: "Show the translation" }, "中 / EN");
  const top = el(doc, "div", { class: "phone-stage-top" }, stageBack, subsToggle);
  const side = el(doc, "div", { class: "phone-side" });
  const sideButtons = {};
  for (const [name, label] of [["replay", "Replay"], ["slow", "Slow"], ["pinyin", "Pinyin"], ["save", "Save"], ["words", "Words"]]) {
    const button = el(doc, "button", { type: "button", class: "phone-side-button", "data-side": name, "aria-label": label });
    button.innerHTML = `<i>${ICONS[name]}</i><span>${label}</span>`;
    sideButtons[name] = button;
    side.append(button);
  }
  const bar = el(doc, "div", { class: "phone-progress", role: "slider", "aria-label": "Position in the video" }, el(doc, "b"));
  const hint = el(doc, "div", { class: "phone-play-hint", "aria-hidden": "true" }, "▶");
  stage.append(top, side, bar, hint);
  $(".media-pane")?.append(stage);
  if (video) {
    // The bar and a tap on the picture are the controls; the browser's own
    // would sit over the subtitles.
    video.controls = false;
    video.setAttribute("playsinline", "");
    // Android's WebView paints a grey play button of its own over a video
    // that hasn't started; a blank poster keeps the picture ours.
    if (!video.getAttribute("poster")) video.setAttribute("poster", "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7");
  }

  const currentView = () => $(".nav-tab.active")?.dataset.view || root.dataset.view || "study";
  // A file just chosen has no Videos-list entry until it's transcribed.
  let chosenFile = "";
  const currentTitle = () => {
    const source = state.sources?.find((s) => s.id === state.currentSourceId);
    if (source) return source.title || source.url || "This video";
    return chosenFile || "Sample lesson";
  };
  const key = (k) => doc.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));

  function render() {
    const view = currentView();
    root.dataset.phoneView = view;
    for (const tab of nav.children) tab.classList.toggle("on", tab.dataset.tab === view);
    title.textContent = view === "cards" ? "Cards" : view === "settings" ? "Settings" : "Stele";
    stageBack.textContent = `‹  ${currentTitle()}`;
    const lines = state.subtitles?.length || 0;
    resume.innerHTML = "";
    resume.append(
      el(doc, "span", { class: "phone-reel-play", "aria-hidden": "true" }, "▶"),
      el(doc, "span", { class: "phone-reel-text" }, el(doc, "b", {}, currentTitle()), el(doc, "small", {}, `Continue · ${lines} lines`)),
    );
    resume.hidden = !lines;
    empty.hidden = Boolean($("#videoList") && !$("#videoList").hidden);
    const count = Number($("#reviewDue")?.textContent) || 0;
    due.textContent = count ? `${count} due` : "Cards";
    const from = $("#translateFrom");
    const to = $("#translateTo");
    const name = (select) => select?.selectedOptions?.[0]?.textContent?.trim() || "";
    const fromName = !from?.value || /^detect/i.test(name(from)) ? "Auto" : name(from);
    langs.textContent = to ? `${fromName} → ${name(to) || "English"}` : "";
    showHint();
  }

  // ── Moving between screens: the new one slides in from the side it lies
  // on (Home, Cards, Settings left to right; a video in front of Home).
  // Instant where the browser has no view transitions or the phone asks
  // for less motion.
  const ORDER = { study: 0, cards: 1, settings: 2 };
  function animate(direction, change) {
    if (!doc.startViewTransition || globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return change();
    root.dataset.phoneMotion = direction;
    const moving = doc.startViewTransition(change);
    // A second tap before the slide ends skips the first: not an error.
    moving.ready.catch(() => {});
    moving.finished.catch(() => {});
  }
  function go(view, change) {
    const from = currentView();
    const run = () => {
      change?.();
      $(`.nav-tab[data-view="${view}"]`)?.click();
      render();
    };
    if (from === view) return run();
    animate((ORDER[view] ?? 0) > (ORDER[from] ?? 0) ? "forward" : "back", run);
  }
  function setScreen(screen) {
    if (root.dataset.phoneScreen === screen) return render();
    animate(screen === "player" ? "forward" : "back", () => showScreen(screen));
  }

  function showScreen(screen) {
    if (root.dataset.phoneScreen !== screen) {
      root.dataset.phoneScreen = screen;
      if (screen === "library") video?.pause?.();
      globalThis.scrollTo?.(0, 0);
    }
    render();
  }

  function setLangs(open) {
    root.dataset.phoneLangs = open ? "open" : "";
    langs.setAttribute("aria-expanded", String(open));
  }

  // ── Bars.
  back.addEventListener("click", () => go("study"));
  langs.addEventListener("click", () => setLangs(root.dataset.phoneLangs !== "open"));
  due.addEventListener("click", () => go("cards"));
  gear.addEventListener("click", () => go("settings"));
  resume.addEventListener("click", () => setScreen("player"));
  nav.addEventListener("click", (event) => {
    const tab = event.target.closest(".phone-tab")?.dataset.tab;
    if (!tab) return;
    if (tab === "add") return $("#videoBrowse")?.click();
    if (tab === "study" && currentView() === "study") return setScreen("library");
    go(tab, tab === "study" ? () => showScreen("library") : null);
  });

  // ── Player.
  stageBack.addEventListener("click", () => setScreen("library"));
  subsToggle.addEventListener("click", () => {
    const off = root.dataset.phoneTranslation !== "off";
    root.dataset.phoneTranslation = off ? "off" : "";
    subsToggle.setAttribute("aria-pressed", String(!off));
  });
  side.addEventListener("click", (event) => {
    const action = event.target.closest(".phone-side-button")?.dataset.side;
    if (action === "replay") key("r");
    if (action === "save") $("#saveLine")?.click();
    if (action === "words") $("#newWordCount")?.click();
    if (action === "slow" && video) {
      video.playbackRate = video.playbackRate < 1 ? 1 : 0.7;
      sideButtons.slow.classList.toggle("on", video.playbackRate < 1);
    }
    if (action === "pinyin") {
      const off = root.dataset.phonePinyin !== "off";
      root.dataset.phonePinyin = off ? "off" : "";
      sideButtons.pinyin.classList.toggle("on", !off);
    }
  });
  sideButtons.pinyin.classList.add("on");
  video?.addEventListener("timeupdate", () => {
    const done = video.duration ? (video.currentTime / video.duration) * 100 : 0;
    bar.firstChild.style.width = `${done}%`;
  });
  function showHint() {
    hint.hidden = !(root.dataset.phoneScreen === "player" && video?.paused && video?.currentSrc);
  }
  video?.addEventListener("play", showHint);
  video?.addEventListener("pause", showHint);
  video?.addEventListener("loadeddata", showHint);
  bar.addEventListener("click", (event) => {
    if (!video?.duration) return;
    const box = bar.getBoundingClientRect();
    video.currentTime = ((event.clientX - box.left) / box.width) * video.duration;
  });

  // A tap on the picture plays or pauses; a swipe up is the next line, down
  // the one before. Over the subtitle, a tap is the word's.
  let start = null;
  const surface = (target) =>
    root.dataset.phoneScreen === "player" &&
    currentView() === "study" &&
    target.closest?.(".media-pane, .transcript-pane") &&
    !target.closest(".phone-side, .phone-stage-top, .phone-progress, .word, button, input, .word-bubble");
  doc.addEventListener("pointerdown", (event) => {
    start = surface(event.target) ? { x: event.clientX, y: event.clientY, t: Date.now(), target: event.target } : null;
  });
  doc.addEventListener("pointerup", (event) => {
    if (!start) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    const tapped = Math.abs(dx) < 12 && Math.abs(dy) < 12 && Date.now() - start.t < 400;
    if (Math.abs(dy) > 50 && Math.abs(dy) > Math.abs(dx)) key(dy < 0 ? "ArrowRight" : "ArrowLeft");
    else if (tapped && start.target.closest(".media-pane")) key(" ");
    start = null;
  });

  // ── Reviews: swipe the card left for Forgot, right for Got it; tap to turn it.
  const card = $("#reviewCard");
  let swipe = null;
  const visible = (sel) => {
    const b = $(sel);
    return b && !b.hidden && b.getClientRects().length > 0 ? b : null;
  };
  card?.addEventListener("pointerdown", (event) => {
    swipe = event.target.closest("button, a, input") ? null : { x: event.clientX, y: event.clientY };
  });
  card?.addEventListener("pointerup", (event) => {
    if (!swipe) return;
    const dx = event.clientX - swipe.x;
    const dy = event.clientY - swipe.y;
    swipe = null;
    if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy)) {
      const grade = visible(dx < 0 ? ".grade-again" : ".grade-good");
      if (grade) {
        card.classList.add(dx < 0 ? "phone-swiped-left" : "phone-swiped-right");
        setTimeout(() => card.classList.remove("phone-swiped-left", "phone-swiped-right"), 250);
        grade.click();
      }
    } else if (Math.abs(dx) < 12 && Math.abs(dy) < 12) {
      visible("#flipCard")?.click();
    }
  });

  // A video opened from the list, a file chosen, or the Open in a finished
  // import's toast: each loads the player within moments of a tap.
  let lastTap = -Infinity;
  doc.addEventListener("pointerdown", () => (lastTap = Date.now()), true);
  video?.addEventListener("loadstart", () => {
    if (Date.now() - lastTap < 4000) setScreen("player");
  });
  $("#videoInput")?.addEventListener("change", (event) => {
    chosenFile = event.target.files?.[0]?.name || "";
    setScreen("player");
  });
  $("#videoList")?.addEventListener("click", (event) => {
    const row = event.target.closest(".video-row.video-ready");
    if (row && !event.target.closest(".video-action, .video-select")) {
      chosenFile = "";
      setScreen("player");
    }
  });

  // Keep the names and tabs right as the app changes underneath.
  for (const id of ["#translateFrom", "#translateTo"]) $(id)?.addEventListener("change", render);
  const observer = new MutationObserver(render);
  for (const tab of doc.querySelectorAll(".nav-tab")) observer.observe(tab, { attributes: true, attributeFilter: ["class"] });
  observer.observe(root, { attributes: true, attributeFilter: ["data-view"] });
  const list = $("#videoList");
  if (list) observer.observe(list, { childList: true, attributes: true, attributeFilter: ["hidden"] });
  const transcript = $("#transcript");
  if (transcript) observer.observe(transcript, { childList: true });
  const dueCount = $("#reviewDue");
  if (dueCount) observer.observe(dueCount, { childList: true, characterData: true, subtree: true });
  render();

  // The Android back button (android.js) comes here once nothing is open.
  globalThis.stelePhoneBack = () => {
    if (root.dataset.phoneLangs === "open") return setLangs(false), true;
    if (currentView() === "study" && root.dataset.phoneScreen === "player") return setScreen("library"), true;
    if (currentView() !== "study") return go("study"), true;
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
