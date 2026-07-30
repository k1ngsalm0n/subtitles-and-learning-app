import {
  state,
  saveSources,
  saveSession,
  loadSession,
  clearSession,
  saveDecks,
  getDeck,
  cardsInDeck,
  DEFAULT_NEW_PER_DAY,
  DEFAULT_REVIEWS_PER_DAY,
  STORAGE_KEYS,
} from "./state.mjs";
import { loadSubtitles, sampleOriginal, sampleTranslation } from "./subtitle.mjs";
import {
  flipReviewCard,
  gradeCard,
  shuffleCards,
  exportCards,
  exportAnkiTsv,
  importCardsFromText,
  addDeck,
  renameDeck,
  deleteDeck,
} from "./flashcards.mjs";
import { describeReport } from "./portability.mjs";
import { setupTemplateEditor, setupTemplateManager } from "./templates.mjs";
import { setupCardModal, openCardModal } from "./cardmodal.mjs";
import { showToast } from "./toast.mjs";
import { syncToVideo, loopActiveLine, saveActiveLine } from "./player.mjs";
import {
  populateLanguageSelects,
  syncTranslateLangs,
  swapLanguages,
  runTranslation,
} from "./translate.mjs";
import {
  renderAll,
  renderTranscript,
  startHighlightLoop,
  setupTranscriptDelegation,
  renderSources,
  renderCardList,
  renderReviewCard,
  setElements,
  setSourceStatus,
  setSourceJumper,
  setPracticeOpener,
} from "./ui.mjs";
import { setupPractice, openPractice } from "./practice.mjs";
import { setupMiniPlayer } from "./miniplayer.mjs";

const els = {
  video: document.querySelector("#video"),
  emptyPlayer: document.querySelector("#emptyPlayer"),
  playerShell: document.querySelector("#playerShell"),
  playerWrap: document.querySelector("#playerWrap"),
  miniDrag: document.querySelector("#miniDrag"),
  miniDragSurface: document.querySelector("#miniDragSurface"),
  miniExpand: document.querySelector("#miniExpand"),
  videoInput: document.querySelector("#videoInput"),
  originalInput: document.querySelector("#originalInput"),
  translationInput: document.querySelector("#translationInput"),
  sourceUrl: document.querySelector("#sourceUrl"),
  queueUrl: document.querySelector("#queueUrl"),
  sourceStatus: document.querySelector("#sourceStatus"),
  transcript: document.querySelector("#transcript"),
  subtitleCount: document.querySelector("#subtitleCount"),
  cardCount: document.querySelector("#cardCount"),
  reviewDue: document.querySelector("#reviewDue"),
  searchInput: document.querySelector("#searchInput"),
  loopLine: document.querySelector("#loopLine"),
  saveLine: document.querySelector("#saveLine"),
  translateFrom: document.querySelector("#translateFrom"),
  translateTo: document.querySelector("#translateTo"),
  swapLangs: document.querySelector("#swapLangs"),
  translateButton: document.querySelector("#translateButton"),
  translateStatus: document.querySelector("#translateStatus"),
  themeToggle: document.querySelector("#themeToggle"),
  cardList: document.querySelector("#cardList"),
  reviewCard: document.querySelector("#reviewCard"),
  flipCard: document.querySelector("#flipCard"),
  shuffleCards: document.querySelector("#shuffleCards"),
  exportCards: document.querySelector("#exportCards"),
  sourceList: document.querySelector("#sourceList"),
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
  cardModal: document.querySelector("#cardModal"),
  cardModalTitle: document.querySelector("#cardModalTitle"),
  templateSelect: document.querySelector("#templateSelect"),
  templateDesc: document.querySelector("#templateDesc"),
  previewSide: document.querySelector("#previewSide"),
  previewFlip: document.querySelector("#previewFlip"),
  previewFace: document.querySelector("#previewFace"),
  modalFields: document.querySelector("#modalFields"),
  openPreview: document.querySelector("#openPreview"),
  previewDialog: document.querySelector("#previewDialog"),
  modalDeckList: document.querySelector("#modalDeckList"),
  modalNewDeck: document.querySelector("#modalNewDeck"),
  modalNewDeckRow: document.querySelector("#modalNewDeckRow"),
  deckEmojiMenu: document.querySelector("#deckEmojiMenu"),
  deckEmojiTrigger: document.querySelector("#deckEmojiTrigger"),
  modalDeckEmojis: document.querySelector("#modalDeckEmojis"),
  deckEmojiInput: document.querySelector("#deckEmojiInput"),
  deckEmojiChips: document.querySelector("#deckEmojiChips"),
  modalNewDeckName: document.querySelector("#modalNewDeckName"),
  modalNewDeckCreate: document.querySelector("#modalNewDeckCreate"),
  modalDeckError: document.querySelector("#modalDeckError"),
  modalError: document.querySelector("#modalError"),
  modalSave: document.querySelector("#modalSave"),
  newCardButton: document.querySelector("#newCardButton"),
  deckNav: document.querySelector("#deckNav"),
  deckTitle: document.querySelector("#deckTitle"),
  newDeck: document.querySelector("#newDeck"),
  newDeckForm: document.querySelector("#newDeckForm"),
  newDeckName: document.querySelector("#newDeckName"),
  newDeckError: document.querySelector("#newDeckError"),
  renameDeck: document.querySelector("#renameDeck"),
  renameDeckForm: document.querySelector("#renameDeckForm"),
  renameDeckName: document.querySelector("#renameDeckName"),
  renameDeckCancel: document.querySelector("#renameDeckCancel"),
  renameDeckError: document.querySelector("#renameDeckError"),
  deleteDeck: document.querySelector("#deleteDeck"),
  deckMenu: document.querySelector(".overflow-menu"),
  deckMenuSep: document.querySelector("#deckMenuSep"),
  practiceDialog: document.querySelector("#practiceDialog"),
  practiceMain: document.querySelector("#practiceMain"),
  practiceChar: document.querySelector("#practiceChar"),
  practiceProgress: document.querySelector("#practiceProgress"),
  practiceBoard: document.querySelector("#practiceBoard"),
  practiceFeedback: document.querySelector("#practiceFeedback"),
  practiceHint: document.querySelector("#practiceHint"),
  practiceReveal: document.querySelector("#practiceReveal"),
  practiceSummary: document.querySelector("#practiceSummary"),
  practiceSummaryText: document.querySelector("#practiceSummaryText"),
  practiceGradeRow: document.querySelector("#practiceGradeRow"),
  deckSettings: document.querySelector("#deckSettings"),
  deckSettingsDialog: document.querySelector("#deckSettingsDialog"),
  deckNewPerDay: document.querySelector("#deckNewPerDay"),
  deckReviewsPerDay: document.querySelector("#deckReviewsPerDay"),
  deckSettingsSave: document.querySelector("#deckSettingsSave"),
  deckDeleteDialog: document.querySelector("#deckDeleteDialog"),
  deckDeleteText: document.querySelector("#deckDeleteText"),
  deckDeleteConfirm: document.querySelector("#deckDeleteConfirm"),
  cardSearch: document.querySelector("#cardSearch"),
  reviewProgress: document.querySelector("#reviewProgress"),
  exportAnki: document.querySelector("#exportAnki"),
  importFile: document.querySelector("#importFile"),
  manageTemplates: document.querySelector("#manageTemplates"),
  templatesDialog: document.querySelector("#templatesDialog"),
  templatesList: document.querySelector("#templatesList"),
  newTemplate: document.querySelector("#newTemplate"),
  templateDialog: document.querySelector("#templateDialog"),
  tplEditorTitle: document.querySelector("#tplEditorTitle"),
  tplName: document.querySelector("#tplName"),
  tplFrontFields: document.querySelector("#tplFrontFields"),
  tplBackFields: document.querySelector("#tplBackFields"),
  tplStrokes: document.querySelector("#tplStrokes"),
  tplError: document.querySelector("#tplError"),
  tplSave: document.querySelector("#tplSave"),
};

setElements(els);
init();

function init() {
  document.documentElement.dataset.theme =
    localStorage.getItem(STORAGE_KEYS.theme) || "dark";
  bindEvents();
  populateLanguageSelects(els);
  restoreSession();
  renderAll(els);
  setupTranscriptDelegation(els);
  setupMiniPlayer(els);
  setupTemplateEditor(els);
  setupTemplateManager(els, () => renderAll(els));
  setupCardModal(els);
  setupPractice(els);
  setPracticeOpener(openPractice);
  setSourceJumper(jumpToSource);
  loadCookieSettings();
}

function bindEvents() {
  document.querySelectorAll(".nav-tab").forEach((button) => {
    button.addEventListener("click", () => switchView(button.dataset.view));
  });

  els.themeToggle.addEventListener("click", toggleTheme);
  els.videoInput.addEventListener("change", handleVideoInput);
  els.originalInput.addEventListener("change", () => readSubtitleInputs());
  els.translationInput.addEventListener("change", () => readSubtitleInputs());
  els.video.addEventListener("timeupdate", () => syncToVideo(els));
  els.video.addEventListener("pause", persistPlaybackTime);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") persistPlaybackTime();
  });
  startHighlightLoop(els);
  els.searchInput.addEventListener("input", () => renderTranscript(els));
  els.loopLine.addEventListener("click", () => loopActiveLine(els));
  els.saveLine.addEventListener("click", () => saveActiveLine(els));
  els.swapLangs.addEventListener("click", () => swapLanguages(els));
  els.translateButton.addEventListener("click", () => runTranslation(els));
  els.queueUrl.addEventListener("click", () => importSourceUrl());
  els.sourceUrl.addEventListener("keydown", (e) => { if (e.key === "Enter") importSourceUrl(); });
  els.newCardButton.addEventListener("click", () => openCardModal());
  bindDeckEvents();
  els.flipCard.addEventListener("click", flipReviewCard);
  document.querySelectorAll("#cardsView .grade-button").forEach((button) => {
    button.addEventListener("click", () => gradeCard(button.dataset.grade));
  });
  document.addEventListener("keydown", handleReviewKeys);
  els.shuffleCards.addEventListener("click", shuffleCards);
  els.exportCards.addEventListener("click", exportCards);
  els.exportAnki.addEventListener("click", exportAnkiTsv);
  els.importFile.addEventListener("change", async () => {
    const file = els.importFile.files[0];
    els.importFile.value = "";
    if (!file) return;
    const result = importCardsFromText(await file.text());
    showToast(result.error ? result.error : describeReport(result.report));
  });

  els.cookieModeNone.addEventListener("click", () => setCookieMode("none"));
  els.cookieModeBrowser.addEventListener("click", () => setCookieMode("browser"));
  els.cookieModeFile.addEventListener("click", () => setCookieMode("file"));
  els.saveCookies.addEventListener("click", saveCookieSettings);
}

// Review shortcuts (Flashcards view only): Space flips, 1–4 grade
// Again/Hard/Good/Easy.
const GRADE_KEYS = { 1: "again", 2: "hard", 3: "good", 4: "easy" };
function handleReviewKeys(event) {
  if (!document.querySelector("#cardsView").classList.contains("active")) return;
  if (document.querySelector("dialog[open]")) return;
  const tag = event.target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
  if (event.key === " ") {
    event.preventDefault();
    flipReviewCard();
  } else if (GRADE_KEYS[event.key]) {
    gradeCard(GRADE_KEYS[event.key]);
  }
}

function bindDeckEvents() {
  els.newDeck.addEventListener("click", () => {
    els.newDeckForm.hidden = !els.newDeckForm.hidden;
    els.newDeckError.textContent = "";
    if (!els.newDeckForm.hidden) els.newDeckName.focus();
  });
  els.newDeckForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const result = addDeck(els.newDeckName.value);
    if (result.error) {
      els.newDeckError.textContent = result.error;
      return;
    }
    els.newDeckForm.reset();
    els.newDeckForm.hidden = true;
    state.selectedDeckId = result.deck.id;
    renderAll(els);
  });

  els.renameDeck.addEventListener("click", () => {
    const deck = getDeck(state.selectedDeckId);
    if (!deck) return;
    els.renameDeckForm.hidden = false;
    els.renameDeckError.textContent = "";
    els.renameDeckName.value = deck.name;
    els.renameDeckName.focus();
    els.renameDeckName.select();
  });
  els.renameDeckCancel.addEventListener("click", () => {
    els.renameDeckForm.hidden = true;
  });
  els.renameDeckForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const result = renameDeck(state.selectedDeckId, els.renameDeckName.value);
    if (result.error) {
      els.renameDeckError.textContent = result.error;
      return;
    }
    els.renameDeckForm.hidden = true;
  });

  els.deleteDeck.addEventListener("click", () => {
    const deck = getDeck(state.selectedDeckId);
    if (!deck) return;
    const count = cardsInDeck(deck.id).length;
    els.deckDeleteText.textContent = count
      ? `Delete "${deck.name}"? It holds ${count} card${count === 1 ? "" : "s"}.`
      : `Delete the empty deck "${deck.name}"?`;
    els.deckDeleteDialog.showModal();
  });
  els.deckDeleteConfirm.addEventListener("click", () => {
    const mode = els.deckDeleteDialog.querySelector(
      'input[name="deckDeleteMode"]:checked',
    ).value;
    const result = deleteDeck(state.selectedDeckId, mode);
    els.deckDeleteDialog.close();
    if (result.error) showToast(result.error);
  });

  els.cardSearch.addEventListener("input", () => {
    state.cardSearch = els.cardSearch.value;
    renderCardList(els);
  });

  // Overflow (⋯) menu: <details> handles open/close, but we still need to close
  // it after an action is chosen and when the user clicks away.
  if (els.deckMenu) {
    els.deckMenu.addEventListener("click", (event) => {
      if (event.target.closest("button, .file-button")) els.deckMenu.open = false;
    });
    document.addEventListener("click", (event) => {
      if (els.deckMenu.open && !els.deckMenu.contains(event.target)) {
        els.deckMenu.open = false;
      }
    });
  }

  els.deckSettings.addEventListener("click", () => {
    const deck = getDeck(state.selectedDeckId);
    if (!deck) return;
    els.deckNewPerDay.value = deck.newPerDay ?? DEFAULT_NEW_PER_DAY;
    els.deckReviewsPerDay.value = deck.reviewsPerDay ?? DEFAULT_REVIEWS_PER_DAY;
    els.deckSettingsDialog.showModal();
  });
  els.deckSettingsSave.addEventListener("click", () => {
    const deck = getDeck(state.selectedDeckId);
    if (deck) {
      deck.newPerDay = Math.max(0, Number(els.deckNewPerDay.value) || 0);
      deck.reviewsPerDay = Math.max(0, Number(els.deckReviewsPerDay.value) || 0);
      saveDecks();
      renderAll(els);
    }
    els.deckSettingsDialog.close();
  });
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
  // A local file isn't a library source; cards made from it carry no link.
  state.currentSourceId = null;
  // A blob video can't be brought back after a reload, so drop any saved
  // import session — otherwise a refresh would resurrect the old imported
  // transcript over this local video.
  clearSession();
}

// On startup, bring back the last imported video and its real subtitles rather
// than the sample, so a reload — or a browser tab-restore that keeps the video
// element alive — doesn't leave a live video sitting over the sample
// transcript. Falls back to the sample when there's no resumable session or the
// source's video is gone.
function restoreSession() {
  const session = loadSession();
  const source =
    session && state.sources.find((s) => s.id === session.sourceId);
  if (!source || !source.videoUrl) {
    loadSubtitles(sampleOriginal, sampleTranslation);
    return;
  }
  els.video.src = source.videoUrl;
  els.emptyPlayer.classList.add("hidden");
  els.video.addEventListener(
    "error",
    () => {
      showToast("The saved video is gone — re-import the URL to restore it.");
      clearSession();
    },
    { once: true },
  );
  // Resume where playback left off (see persistPlaybackTime).
  if (session.time) {
    els.video.addEventListener(
      "loadedmetadata",
      () => {
        els.video.currentTime = session.time;
      },
      { once: true },
    );
  }
  state.currentSourceId = source.id;
  if (session.learningLang) {
    state.learningLang = session.learningLang;
    syncTranslateLangs(els);
  }
  loadSubtitles(session.original || "", session.translation || "");
}

// Persist playback position so a reload resumes where you left off. Written on
// pause and when the tab is hidden (covers reloads and browser tab-discards)
// rather than on every timeupdate, to avoid hammering localStorage. Only the
// currently loaded import owns the saved session, so guard on the source id.
function persistPlaybackTime() {
  const session = loadSession();
  if (!session || session.sourceId !== state.currentSourceId) return;
  session.time = els.video.currentTime || 0;
  saveSession(session);
}

// Jump back to the moment a card came from: seek if the source is already
// loaded, otherwise reload its downloaded video first.
function jumpToSource(sourceId, time) {
  const source = state.sources.find((s) => s.id === sourceId);
  if (!source) {
    showToast("That source is no longer in the library.");
    return;
  }
  switchView("study");
  const seek = () => {
    els.video.currentTime = time || 0;
    els.video.play();
  };
  if (state.currentSourceId === sourceId && els.video.src) {
    seek();
    return;
  }
  if (source.videoUrl) {
    els.video.src = source.videoUrl;
    els.emptyPlayer.classList.add("hidden");
    els.video.addEventListener("loadedmetadata", seek, { once: true });
    els.video.addEventListener(
      "error",
      () => showToast("The downloaded video is gone — re-import the URL to restore it."),
      { once: true },
    );
    state.currentSourceId = sourceId;
    setSourceStatus(
      `Loaded “${source.title || source.url}” — re-import the URL to restore its subtitles.`,
      els,
    );
    return;
  }
  showToast("Re-import this source to load its video.");
}

async function readSubtitleInputs() {
  const originalFile = els.originalInput.files[0];
  const translationFile = els.translationInput.files[0];
  if (!originalFile) return;
  const original = await originalFile.text();
  const translation = translationFile ? await translationFile.text() : "";
  loadSubtitles(original, translation);
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

  // The early phases are quick and roughly predictable, so show staged
  // percentages for them.
  const steps = [
    { message: "Downloading media info...", percent: 25, delay: 2000 },
    { message: "Extracting subtitles...", percent: 50, delay: 4000 },
    { message: "Downloading audio...", percent: 65, delay: 8000 },
  ];
  let stepTimer = 0;
  const stepTimeouts = steps.map((step) => {
    stepTimer += step.delay;
    return setTimeout(() => showProgress(step.message, step.percent), stepTimer);
  });

  // After those, transcription + translation run for an unknown (often
  // multi-minute) time with no way to report a real percentage. Switch to an
  // indeterminate bar with a live elapsed timer so the import keeps showing
  // motion instead of freezing at a fake percentage.
  const startedAt = Date.now();
  let elapsedTimer = 0;
  const beginIndeterminate = setTimeout(() => {
    const tick = () => {
      const secs = Math.floor((Date.now() - startedAt) / 1000);
      const mm = Math.floor(secs / 60);
      const ss = String(secs % 60).padStart(2, "0");
      showProgress(
        `Transcribing & translating — long videos can take a few minutes (${mm}:${ss})`,
      );
    };
    tick();
    elapsedTimer = setInterval(tick, 1000);
  }, stepTimer + 4000);

  const clearProgressTimers = () => {
    stepTimeouts.forEach(clearTimeout);
    clearTimeout(beginIndeterminate);
    if (elapsedTimer) clearInterval(elapsedTimer);
  };

  try {
    const response = await fetch("/api/import-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });

    clearProgressTimers();
    showProgress("Loading results...", 95);

    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Import failed.");

    if (result.videoUrl) {
      els.video.src = result.videoUrl;
      els.emptyPlayer.classList.add("hidden");
      // Persisted so a card's "jump back" control can reload the video later.
      source.videoUrl = result.videoUrl;
    }

    // New cards link back to this source + the moment they were made.
    state.currentSourceId = source.id;

    loadSubtitles(result.subtitles || "", result.translation || "");
    if (result.language) {
      // Drive word lookups off the imported video's language. Whisper may
      // report "chinese"; normalize it to the "zh" code the dictionary uses.
      const lang = result.language.toLowerCase();
      state.learningLang = lang === "chinese" ? "zh" : lang;
      syncTranslateLangs(els);
    }
    // Remember this loaded video + transcript so a reload restores it instead
    // of the sample (see restoreSession).
    saveSession({
      sourceId: source.id,
      original: result.subtitles || "",
      translation: result.translation || "",
      learningLang: state.learningLang,
    });
    source.status =
      result.source === "whisper"
        ? "transcribed"
        : result.source?.startsWith("ocr")
          ? "on-screen captions read"
          : "captions loaded";
    source.title = result.title || "";
    els.sourceUrl.value = "";
    showProgress("", 100);
    const langNote = result.language ? ` (${result.language})` : "";
    setSourceStatus(
      result.source === "whisper"
        ? `Transcribed with Whisper${langNote}.`
        : result.source === "ocr+whisper"
          ? "Read the on-screen captions and transcribed the speech between them."
          : result.source === "ocr"
            ? "Read the on-screen captions with OCR."
            : "Loaded existing subtitles.",
      els,
    );
    setTimeout(hideProgress, 2000);
  } catch (error) {
    clearProgressTimers();
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
