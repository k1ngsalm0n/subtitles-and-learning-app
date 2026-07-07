import { state, saveSources, saveLearningLang, STORAGE_KEYS } from "./state.mjs";
import { loadSubtitles, sampleOriginal, sampleTranslation } from "./subtitle.mjs";
import { addCard, flipReviewCard, gradeCard, shuffleCards, exportCards } from "./flashcards.mjs";
import { syncToVideo, loopActiveLine, saveActiveLine } from "./player.mjs";
import {
  renderAll,
  renderTranscript,
  renderActiveSubtitle,
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
  langSelect: document.querySelector("#langSelect"),
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
  sourceBadge: document.querySelector("#sourceBadge"),
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
  els.langSelect.value = state.learningLang;
  bindEvents();
  loadSubtitles(sampleOriginal, sampleTranslation, state.learningLang);
  renderAll(els);
  translateMissingLines();
}

function bindEvents() {
  document.querySelectorAll(".nav-tab").forEach((button) => {
    button.addEventListener("click", () => switchView(button.dataset.view));
  });

  els.themeToggle.addEventListener("click", toggleTheme);
  els.langSelect.addEventListener("change", () => {
    state.learningLang = els.langSelect.value;
    saveLearningLang();
    // Re-segment the transcript: word boundaries depend on the language.
    renderTranscript(els);
    renderActiveSubtitle(els);
  });
  els.sampleButton.addEventListener("click", () => {
    setSourceBadge("Sample lesson");
    // The sample lesson is Chinese, so switch the app (and dropdown) to zh.
    els.langSelect.value = "zh";
    loadSubtitles(sampleOriginal, sampleTranslation, "zh");
    translateMissingLines();
  });
  els.videoInput.addEventListener("change", handleVideoInput);
  els.originalInput.addEventListener("change", () => readSubtitleInputs());
  els.translationInput.addEventListener("change", () => readSubtitleInputs());
  els.video.addEventListener("timeupdate", () => syncToVideo(els));
  els.searchInput.addEventListener("input", () => renderTranscript(els));
  els.loopLine.addEventListener("click", () => loopActiveLine(els));
  els.saveLine.addEventListener("click", () => saveActiveLine(els));
  els.queueUrl.addEventListener("click", () => importSourceUrl());
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
  setSourceBadge("Imported files");
  loadSubtitles(original, translation, state.learningLang);
  translateMissingLines();
}

function setSourceBadge(text) {
  els.sourceBadge.textContent = text;
  els.sourceBadge.hidden = !text;
}

async function translateMissingLines() {
  const missing = state.subtitles.filter(
    (line) => !line.translation && !line.aiTranslation,
  );
  if (!missing.length || state.aiTranslating) return;

  state.aiTranslating = true;
  setSourceStatus(`Translating ${missing.length} lines with AI...`, els);
  renderTranscript(els);
  renderActiveSubtitle(els);

  try {
    const response = await fetch("/api/translate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        lines: missing.map((line) => line.text),
        target: "English",
        prompt: els.translatorPrompt.value,
      }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Translation failed.");

    missing.forEach((line, index) => {
      line.aiTranslation = result.translations[index] || "";
    });
    setSourceStatus("AI translation ready.", els);
  } catch (error) {
    setSourceStatus(error.message, els);
  } finally {
    state.aiTranslating = false;
    renderTranscript(els);
    renderActiveSubtitle(els);
  }
}

function addManualCard(event) {
  event.preventDefault();
  addCard(els.manualFront.value, els.manualBack.value, "");
  els.manualCardForm.reset();
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
  setSourceStatus("Looking for captions...", els);
  els.queueUrl.disabled = true;
  renderSources(els);

  try {
    const response = await fetch("/api/import-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, lang: state.learningLang }),
    });

    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Import failed.");

    if (result.videoUrl) {
      els.video.src = result.videoUrl;
      els.emptyPlayer.classList.add("hidden");
    }

    loadSubtitles(result.subtitles || "", "", state.learningLang);
    translateMissingLines();
    const sourceLabels = {
      subtitles: "Human captions",
      "auto-subtitles": "Auto captions",
      whisper: "AI transcription",
    };
    setSourceBadge(sourceLabels[result.source] || "");
    source.status =
      result.source === "whisper" ? "transcribed" : "captions loaded";
    source.title = result.title || "";
    els.sourceUrl.value = "";
    setSourceStatus(
      result.source === "whisper"
        ? "Transcribed with Whisper."
        : "Loaded existing subtitles.",
      els,
    );
  } catch (error) {
    source.status = "error";
    source.error = error.message;
    setSourceStatus(error.message, els);
  } finally {
    els.queueUrl.disabled = false;
    saveSources();
    renderSources(els);
  }
}
