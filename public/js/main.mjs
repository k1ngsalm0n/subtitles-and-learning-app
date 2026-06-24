import { state, saveSources, STORAGE_KEYS } from "./state.mjs";
import { loadSubtitles, sampleOriginal, sampleTranslation } from "./subtitle.mjs";
import { addCard, flipReviewCard, gradeCard, shuffleCards, exportCards } from "./flashcards.mjs";
import { syncToVideo, loopActiveLine, saveActiveLine } from "./player.mjs";
import {
  renderAll,
  renderTranscript,
  renderActiveSubtitle,
  startHighlightLoop,
  renderSources,
  renderDeck,
  renderReviewCard,
  setElements,
  setSourceStatus,
  addDialogCard,
} from "./ui.mjs";

const els = {
  video: document.querySelector("#video"),
  emptyPlayer: document.querySelector("#emptyPlayer"),
  videoInput: document.querySelector("#videoInput"),
  originalInput: document.querySelector("#originalInput"),
  translationInput: document.querySelector("#translationInput"),
  sampleButton: document.querySelector("#sampleButton"),
  sourceUrl: document.querySelector("#sourceUrl"),
  queueUrl: document.querySelector("#queueUrl"),
  sourceStatus: document.querySelector("#sourceStatus"),
  transcript: document.querySelector("#transcript"),
  activeOriginal: document.querySelector("#activeOriginal"),
  activeTranslation: document.querySelector("#activeTranslation"),
  subtitleCount: document.querySelector("#subtitleCount"),
  cardCount: document.querySelector("#cardCount"),
  reviewDue: document.querySelector("#reviewDue"),
  searchInput: document.querySelector("#searchInput"),
  loopLine: document.querySelector("#loopLine"),
  saveLine: document.querySelector("#saveLine"),
  themeToggle: document.querySelector("#themeToggle"),
  deckList: document.querySelector("#deckList"),
  reviewCard: document.querySelector("#reviewCard"),
  flipCard: document.querySelector("#flipCard"),
  markHard: document.querySelector("#markHard"),
  markGood: document.querySelector("#markGood"),
  shuffleCards: document.querySelector("#shuffleCards"),
  exportCards: document.querySelector("#exportCards"),
  manualCardForm: document.querySelector("#manualCardForm"),
  manualFront: document.querySelector("#manualFront"),
  manualBack: document.querySelector("#manualBack"),
  sourceList: document.querySelector("#sourceList"),
  translatorPrompt: document.querySelector("#translatorPrompt"),
  savePrompt: document.querySelector("#savePrompt"),
  cookieModeNone: document.querySelector("#cookieModeNone"),
  cookieModeBrowser: document.querySelector("#cookieModeBrowser"),
  cookieModeFile: document.querySelector("#cookieModeFile"),
  cookieBrowserSection: document.querySelector("#cookieBrowserSection"),
  cookieFileSection: document.querySelector("#cookieFileSection"),
  cookieBrowser: document.querySelector("#cookieBrowser"),
  cookiesTxt: document.querySelector("#cookiesTxt"),
  saveCookies: document.querySelector("#saveCookies"),
  cookieStatus: document.querySelector("#cookieStatus"),
  progressWrap: document.querySelector("#progressWrap"),
  progressFill: document.querySelector("#progressFill"),
  wordDialog: document.querySelector("#wordDialog"),
  dialogWord: document.querySelector("#dialogWord"),
  dialogMeaning: document.querySelector("#dialogMeaning"),
  dialogExample: document.querySelector("#dialogExample"),
  addWordCard: document.querySelector("#addWordCard"),
};

setElements(els);
init();

function init() {
  document.documentElement.dataset.theme =
    localStorage.getItem(STORAGE_KEYS.theme) || "dark";
  els.translatorPrompt.value =
    localStorage.getItem(STORAGE_KEYS.prompt) || els.translatorPrompt.value;
  bindEvents();
  loadSubtitles(sampleOriginal, sampleTranslation);
  renderAll(els);
  loadCookieSettings();
}

function bindEvents() {
  document.querySelectorAll(".nav-tab").forEach((button) => {
    button.addEventListener("click", () => switchView(button.dataset.view));
  });

  els.themeToggle.addEventListener("click", toggleTheme);
  els.sampleButton.addEventListener("click", () =>
    loadSubtitles(sampleOriginal, sampleTranslation),
  );
  els.videoInput.addEventListener("change", handleVideoInput);
  els.originalInput.addEventListener("change", () => readSubtitleInputs());
  els.translationInput.addEventListener("change", () => readSubtitleInputs());
  els.video.addEventListener("timeupdate", () => syncToVideo(els));
  startHighlightLoop(els);
  els.searchInput.addEventListener("input", () => renderTranscript(els));
  els.loopLine.addEventListener("click", () => loopActiveLine(els));
  els.saveLine.addEventListener("click", () => saveActiveLine(els));
  els.queueUrl.addEventListener("click", () => importSourceUrl());
  els.sourceUrl.addEventListener("keydown", (e) => { if (e.key === "Enter") importSourceUrl(); });
  els.manualCardForm.addEventListener("submit", addManualCard);
  els.flipCard.addEventListener("click", flipReviewCard);
  els.markHard.addEventListener("click", () => gradeCard("hard"));
  els.markGood.addEventListener("click", () => gradeCard("good"));
  els.shuffleCards.addEventListener("click", shuffleCards);
  els.exportCards.addEventListener("click", exportCards);
  els.savePrompt.addEventListener("click", () =>
    localStorage.setItem(STORAGE_KEYS.prompt, els.translatorPrompt.value),
  );
  els.addWordCard.addEventListener("click", () => addDialogCard(els));

  els.cookieModeNone.addEventListener("click", () => setCookieMode("none"));
  els.cookieModeBrowser.addEventListener("click", () => setCookieMode("browser"));
  els.cookieModeFile.addEventListener("click", () => setCookieMode("file"));
  els.saveCookies.addEventListener("click", saveCookieSettings);
}

function switchView(view) {
  document
    .querySelectorAll(".nav-tab")
    .forEach((button) =>
      button.classList.toggle("active", button.dataset.view === view),
    );
  document.querySelectorAll(".view").forEach((panel) => panel.classList.remove("active"));
  document.querySelector(`#${view}View`).classList.add("active");
}

function toggleTheme() {
  const next =
    document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  localStorage.setItem(STORAGE_KEYS.theme, next);
  els.themeToggle.textContent = next === "dark" ? "☾" : "☀";
}

function handleVideoInput(event) {
  const file = event.target.files[0];
  if (!file) return;
  els.video.src = URL.createObjectURL(file);
  els.emptyPlayer.classList.add("hidden");
}

async function readSubtitleInputs() {
  const originalFile = els.originalInput.files[0];
  const translationFile = els.translationInput.files[0];
  if (!originalFile) return;
  const original = await originalFile.text();
  const translation = translationFile ? await translationFile.text() : "";
  loadSubtitles(original, translation);
}


function addManualCard(event) {
  event.preventDefault();
  addCard(els.manualFront.value, els.manualBack.value, "");
  els.manualCardForm.reset();
}

function showProgress(message, percent) {
  els.progressWrap.classList.add("visible");
  setSourceStatus(message, els);
  if (percent === undefined) {
    els.progressFill.style.width = "";
    els.progressFill.classList.add("indeterminate");
  } else {
    els.progressFill.classList.remove("indeterminate");
    els.progressFill.style.width = `${percent}%`;
  }
}

function hideProgress() {
  els.progressFill.classList.remove("indeterminate");
  els.progressWrap.classList.remove("visible");
}

async function importSourceUrl() {
  const url = els.sourceUrl.value.trim();
  if (!url) return;

  const source = {
    id: crypto.randomUUID(),
    url,
    status: "importing",
    createdAt: Date.now(),
  };
  state.sources.unshift(source);
  saveSources();
  els.queueUrl.disabled = true;
  renderSources(els);

  showProgress("Connecting and looking for captions...", 10);

  const steps = [
    { message: "Downloading media info...", percent: 25, delay: 2000 },
    { message: "Extracting subtitles...", percent: 50, delay: 4000 },
    { message: "Processing audio (this may take a while)...", percent: 70, delay: 8000 },
    { message: "Almost done...", percent: 85, delay: 15000 },
  ];
  let stepTimer = 0;
  const stepTimeouts = steps.map((step) => {
    stepTimer += step.delay;
    return setTimeout(() => showProgress(step.message, step.percent), stepTimer);
  });

  try {
    const response = await fetch("/api/import-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });

    stepTimeouts.forEach(clearTimeout);
    showProgress("Loading results...", 95);

    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Import failed.");

    if (result.videoUrl) {
      els.video.src = result.videoUrl;
      els.emptyPlayer.classList.add("hidden");
    }

    loadSubtitles(result.subtitles || "", result.translation || "");
    source.status =
      result.source === "whisper" ? "transcribed" : "captions loaded";
    source.title = result.title || "";
    els.sourceUrl.value = "";
    showProgress("", 100);
    const langNote = result.language ? ` (${result.language})` : "";
    setSourceStatus(
      result.source === "whisper"
        ? `Transcribed with Whisper${langNote}.`
        : "Loaded existing subtitles.",
      els,
    );
    setTimeout(hideProgress, 2000);
  } catch (error) {
    stepTimeouts.forEach(clearTimeout);
    source.status = "error";
    source.error = error.message;
    setSourceStatus(error.message, els);
    hideProgress();
  } finally {
    els.queueUrl.disabled = false;
    saveSources();
    renderSources(els);
  }
}

function setCookieMode(mode) {
  els.cookieModeNone.classList.toggle("active", mode === "none");
  els.cookieModeBrowser.classList.toggle("active", mode === "browser");
  els.cookieModeFile.classList.toggle("active", mode === "file");
  els.cookieBrowserSection.style.display = mode === "browser" ? "" : "none";
  els.cookieFileSection.style.display = mode === "file" ? "" : "none";
  els.cookieStatus.textContent = "";
}

async function loadCookieSettings() {
  try {
    const res = await fetch("/api/cookies");
    const data = await res.json();
    setCookieMode(data.mode || "none");
    if (data.browser) els.cookieBrowser.value = data.browser;
    if (data.cookiesTxt) els.cookiesTxt.value = data.cookiesTxt;
  } catch {
    // server unavailable — leave defaults
  }
}

async function saveCookieSettings() {
  const mode = els.cookieModeBrowser.classList.contains("active")
    ? "browser"
    : els.cookieModeFile.classList.contains("active")
      ? "file"
      : "none";

  const body = { mode };
  if (mode === "browser") body.browser = els.cookieBrowser.value.trim();
  if (mode === "file") body.cookiesTxt = els.cookiesTxt.value;

  try {
    const res = await fetch("/api/cookies", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error("Save failed");
    els.cookieStatus.textContent = "Saved.";
  } catch (err) {
    els.cookieStatus.textContent = err.message;
  }
}
