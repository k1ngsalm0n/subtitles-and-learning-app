import {
  state,
  saveSources,
  saveSession,
  loadSession,
  clearSession,
  saveDecks,
  getDeck,
  deckName,
  getChildDecks,
  cardsInDeck,
  DEFAULT_NEW_PER_DAY,
  DEFAULT_REVIEWS_PER_DAY,
  STORAGE_KEYS,
  setLastView,
  setSettingsPage,
  setSelectedDeck,
  setCardSearch,
  setTranscriptSearch,
  setTranslateTo,
  setStorageErrorHandler,
  setBackupEnabled,
  setBackupInterval,
  storageUsage,
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
  nestDeck,
  removeCards,
} from "./flashcards.mjs";
import { validateNesting } from "./carddata.mjs";
import {
  startAutoBackup,
  backupNow,
  backupStatus,
  listBackups,
  readBackup,
} from "./backup.mjs";
import { describeReport } from "./portability.mjs";
import { createWheel } from "./wheel.mjs";
import { paintHighlight, clearHighlight } from "./imagehighlight.mjs";
import { chooseScript } from "./zhscript.mjs";
import { romanizeSubtitles } from "./romanize.mjs";
import {
  createAccentDial,
  applyAccent,
  accentFor,
  storedAccent,
  storeAccent,
} from "./appearance.mjs";
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
  visibleCards,
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
  zhScriptToggle: document.querySelector("#zhScriptToggle"),
  zhSimp: document.querySelector("#zhSimp"),
  zhTrad: document.querySelector("#zhTrad"),
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
  deckEmojiTrigger: document.querySelector("#deckEmojiTrigger"),
  emojiDialog: document.querySelector("#emojiDialog"),
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
  deckMenu: document.querySelector(".card-tools .overflow-menu"),
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
  nestDeck: document.querySelector("#nestDeck"),
  nestDeckDialog: document.querySelector("#nestDeckDialog"),
  nestDeckName: document.querySelector("#nestDeckName"),
  nestDeckParent: document.querySelector("#nestDeckParent"),
  nestDeckError: document.querySelector("#nestDeckError"),
  nestDeckSave: document.querySelector("#nestDeckSave"),
  restoreBackup: document.querySelector("#restoreBackup"),
  backupList: document.querySelector("#backupList"),
  restoreDir: document.querySelector("#restoreDir"),
  backupNow: document.querySelector("#backupNow"),
  backupEnabled: document.querySelector("#backupEnabled"),
  backupInterval: document.querySelector("#backupInterval"),
  backupStatus: document.querySelector("#backupStatus"),
  exportFromData: document.querySelector("#exportFromData"),
  importFileSettings: document.querySelector("#importFileSettings"),
  usageFill: document.querySelector("#usageFill"),
  usageText: document.querySelector("#usageText"),
  imagesMode: document.querySelector("#imagesMode"),
  imagePane: document.querySelector("#imagePane"),
  imageView: document.querySelector("#imageView"),
  imageHighlight: document.querySelector("#imageHighlight"),
  imageInput: document.querySelector("#imageInput"),
  imageBrowse: document.querySelector("#imageBrowse"),
  dropMessage: document.querySelector("#dropMessage"),
  settingsWheel: document.querySelector("#settingsWheel"),
  settingsLayout: document.querySelector("#settingsLayout"),
  themeDark: document.querySelector("#themeDark"),
  themeLight: document.querySelector("#themeLight"),
  accentBay: document.querySelector("#accentBay"),
  accentDial: document.querySelector("#accentDial"),
  accentFace: document.querySelector("#accentFace"),
  accentHub: document.querySelector("#accentHub"),
  accentName: document.querySelector("#accentName"),
  accentNote: document.querySelector("#accentNote"),
  accentPill: document.querySelector("#accentPill"),
  applyAccent: document.querySelector("#applyAccent"),
  emptyCards: document.querySelector("#emptyCards"),
  emptyCardsDialog: document.querySelector("#emptyCardsDialog"),
  emptyCardsText: document.querySelector("#emptyCardsText"),
  emptyCardsConfirm: document.querySelector("#emptyCardsConfirm"),
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

// Settings owns two long-lived controls: the wheel of pages and the colour
// dial. `appliedAccent` is the scheme the whole app is wearing; the dial can
// sit on a different one while you're trying it out.
let settingsPages = null;
let accentDial = null;
let appliedAccent = storedAccent();

function init() {
  setTheme(localStorage.getItem(STORAGE_KEYS.theme) || "dark", { store: false });
  // Before anything else can try to save: a failed write is silent inside
  // state.mjs by design, and this is what makes it audible. Fires once per
  // session, while the data is still in memory and exportable.
  setStorageErrorHandler(() => {
    showToast(
      "Couldn't save — this browser's storage is full or blocked. Export a copy now.",
      {
        duration: 20000,
        actions: [
          { label: "Export", onClick: exportCards },
          { label: "Back up", onClick: backupNow },
        ],
      },
    );
  });
  bindEvents();
  populateLanguageSelects(els);
  restoreSession();
  restoreUiState();
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
  startAutoBackup();
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
  els.searchInput.addEventListener("input", () => {
    setTranscriptSearch(els.searchInput.value);
    renderTranscript(els);
  });
  els.translateTo.addEventListener("change", () =>
    setTranslateTo(els.translateTo.value),
  );
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
  const importFromInput = async (input) => {
    const file = input.files[0];
    input.value = "";
    if (!file) return;
    const result = importCardsFromText(await file.text());
    showToast(result.error ? result.error : describeReport(result.report));
  };
  els.importFile.addEventListener("change", () => importFromInput(els.importFile));
  els.importFileSettings.addEventListener("change", async () => {
    await importFromInput(els.importFileSettings);
    renderDataPanel();
  });

  // The menu entry is a signpost now: the panel itself lives in Settings, so
  // send the wheel to it rather than dropping the user on whichever page it
  // was last left on.
  els.restoreBackup.addEventListener("click", () => {
    switchView("settings");
    settingsPages?.selectById("backups");
  });
  els.backupEnabled.addEventListener("change", () => {
    setBackupEnabled(els.backupEnabled.checked);
    renderDataPanel();
  });
  els.backupInterval.addEventListener("change", () => {
    setBackupInterval(els.backupInterval.value);
    renderDataPanel();
  });
  els.exportFromData.addEventListener("click", exportCards);
  els.backupNow.addEventListener("click", async () => {
    els.backupNow.disabled = true;
    const result = await backupNow();
    els.backupNow.disabled = false;
    renderDataPanel();
    if (!result) {
      showToast("Couldn't save a backup — is the server running?");
      return;
    }
    renderBackupList();
  });

  setupSettings();
  setupImagesMode();
  // One control, one behaviour: press it and you get the other script. Which
  // half of it was pressed doesn't matter — the lit half is a readout, not a
  // pair of targets.
  els.zhScriptToggle.addEventListener("click", () => {
    const next = state.zhScript === "trad" ? "simp" : "trad";
    chooseScript(next, els, () => renderTranscript(els));
  });

  els.cookieModeNone.addEventListener("click", () => setCookieMode("none"));
  els.cookieModeBrowser.addEventListener("click", () => setCookieMode("browser"));
  els.cookieModeFile.addEventListener("click", () => setCookieMode("file"));
  els.saveCookies.addEventListener("click", saveCookieSettings);
}

// Browsers don't report a localStorage quota, but ~5 MB is the near-universal
// figure. Shown as an estimate, because that's what it is.
const ESTIMATED_QUOTA = 5 * 1024 * 1024;

function formatAgo(timestamp) {
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  return `${hours} hour${hours === 1 ? "" : "s"} ago`;
}

// The "where is my data" half of the panel: how full this browser's storage is,
// and whether backups are actually happening.
function renderDataPanel() {
  const usage = storageUsage();
  const share = Math.min(1, usage.bytes / ESTIMATED_QUOTA);
  els.usageFill.style.width = `${Math.max(2, share * 100)}%`;
  els.usageFill.className = share > 0.9 ? "full" : share > 0.66 ? "warn" : "";
  const kb = Math.max(1, Math.round(usage.bytes / 1024));
  els.usageText.textContent = usage.available
    ? `${state.cards.length} cards using about ${kb} KB of an estimated 5 MB limit.`
    : "This browser isn't allowing storage — nothing is being saved.";

  const status = backupStatus();
  els.backupInterval.disabled = !status.enabled;
  if (!status.enabled) {
    els.backupStatus.textContent =
      "Off. Nothing outside this browser is keeping a copy.";
  } else if (status.error) {
    els.backupStatus.textContent = `Last attempt failed: ${status.error}`;
  } else if (status.lastBackupAt) {
    els.backupStatus.textContent = `Last backed up ${formatAgo(status.lastBackupAt)}.`;
  } else {
    els.backupStatus.textContent = status.pending
      ? "Waiting for the first snapshot of this session."
      : "Nothing new to back up yet.";
  }
}

// Backup list: newest first, each row restoring by merging that snapshot in.
// Restoring can only add — mergeImport skips ids that already exist — so it's
// safe to try one without losing what's on screen.
async function renderBackupList() {
  els.backupList.textContent = "";
  els.restoreDir.textContent = "";
  const { files = [], dir, error } = await listBackups();
  if (error || !files.length) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent =
      error || "No snapshots yet — one is saved a few minutes after you start.";
    els.backupList.append(empty);
  }
  if (dir) els.restoreDir.textContent = `Saved in ${dir}`;
  for (const file of files) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "backup-item";
    const when = document.createElement("span");
    when.textContent = new Date(file.savedAt).toLocaleString();
    const size = document.createElement("span");
    size.className = "backup-size";
    size.textContent = `${Math.max(1, Math.round(file.bytes / 1024))} KB`;
    button.append(when, size);
    button.addEventListener("click", async () => {
      const text = await readBackup(file.name);
      if (text === null) {
        showToast("Couldn't read that backup.");
        return;
      }
      const result = importCardsFromText(text);
      showToast(result.error ? result.error : describeReport(result.report));
      renderDataPanel();
    });
    els.backupList.append(button);
  }
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
    setSelectedDeck(result.deck.id);
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

  // "Move into…": the parent choices are the top-level decks that could hold
  // this one — a deck that already has sub-decks can't become one itself.
  els.nestDeck.addEventListener("click", () => {
    const deck = getDeck(state.selectedDeckId);
    if (!deck) return;
    els.nestDeckName.textContent = `"${deck.name}"`;
    els.nestDeckError.textContent = "";
    els.nestDeckParent.textContent = "";
    els.nestDeckParent.append(new Option("the top level (no parent)", ""));
    for (const other of state.decks) {
      if (other.id === deck.id || other.parentId) continue;
      if (validateNesting(state.decks, deck.id, other.id)) continue;
      const selected = other.id === deck.parentId;
      els.nestDeckParent.append(
        new Option(other.name, other.id, selected, selected),
      );
    }
    els.nestDeckDialog.showModal();
  });
  els.nestDeckSave.addEventListener("click", () => {
    const result = nestDeck(state.selectedDeckId, els.nestDeckParent.value);
    if (result.error) {
      els.nestDeckError.textContent = result.error;
      return;
    }
    els.nestDeckDialog.close();
  });

  els.deleteDeck.addEventListener("click", () => {
    const deck = getDeck(state.selectedDeckId);
    if (!deck) return;
    // cardsInDeck rolls sub-decks up, so the count covers the whole group.
    const count = cardsInDeck(deck.id).length;
    const subs = getChildDecks(deck.id).length;
    const holds = [
      count ? `${count} card${count === 1 ? "" : "s"}` : "",
      subs ? `${subs} sub-deck${subs === 1 ? "" : "s"}` : "",
    ].filter(Boolean);
    els.deckDeleteText.textContent = holds.length
      ? `Delete "${deck.name}"? It holds ${holds.join(" and ")}.`
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

  // "Empty this list" deletes exactly what the list is showing — the selected
  // deck, narrowed by the search box — so the confirmation spells out which
  // that is rather than saying "all cards".
  els.emptyCards.addEventListener("click", () => {
    const cards = visibleCards();
    if (!cards.length) {
      showToast("There's nothing in this list to delete.");
      return;
    }
    const count = `${cards.length} card${cards.length === 1 ? "" : "s"}`;
    const query = (state.cardSearch || "").trim();
    const where =
      state.selectedDeckId === "all"
        ? "across every deck"
        : `from "${deckName(state.selectedDeckId)}"`;
    els.emptyCardsText.textContent = query
      ? `Delete the ${count} matching "${query}" ${where}?`
      : `Delete ${count} ${where}?`;
    els.emptyCardsDialog.showModal();
  });
  els.emptyCardsConfirm.addEventListener("click", () => {
    const doomed = visibleCards();
    els.emptyCardsDialog.close();
    const { removed, undo } = removeCards(doomed.map((card) => card.id));
    if (!removed) return;
    showToast(`Deleted ${removed} card${removed === 1 ? "" : "s"}.`, {
      actions: [{ label: "Undo", onClick: undo }],
    });
  });

  els.cardSearch.addEventListener("input", () => {
    setCardSearch(els.cardSearch.value);
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
  setLastView(view);
  // Settings shows live figures (storage in use, when the last backup ran), so
  // they're read when the tab opens rather than left to go stale in the DOM.
  if (view === "settings") {
    els.backupEnabled.checked = state.backupEnabled;
    els.backupInterval.value = String(state.backupIntervalMin);
    renderDataPanel();
    renderBackupList();
    // The wheel measures itself, and nothing inside a display:none view has a
    // size — so it can only be positioned once the view is actually on screen.
    settingsPages?.reveal();
  }
}

// Put the UI back the way it was left: the open tab and the two search boxes.
// (The deck filter and translate target restore themselves — they're read from
// state, which loads them.) A stored view with no matching tab (older build,
// hand-edited storage) falls back to Study rather than hiding every panel.
function restoreUiState() {
  const known = [...document.querySelectorAll(".nav-tab")].some(
    (button) => button.dataset.view === state.lastView,
  );
  switchView(known ? state.lastView : "study");
  // Both filters live in the DOM, so put the stored text back in the boxes —
  // renderTranscript/renderCardList read from them. Setting .value fires no
  // input event, so this doesn't loop back through the setters.
  els.searchInput.value = state.transcriptSearch;
  els.cardSearch.value = state.cardSearch;
  // The inline <head> script stamped these so the right tab and settings page
  // painted immediately. The .active classes now agree with them, so drop them
  // and leave styling purely class-driven (keeps :hover and later switches
  // working normally).
  delete document.documentElement.dataset.view;
  delete document.documentElement.dataset.settingsPage;
  // Let things animate again, from the next frame — by which point everything
  // restored above has already been painted in place rather than eased into.
  requestAnimationFrame(() => {
    document.documentElement.classList.remove("booting");
  });
}

function toggleTheme() {
  setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
}

// One way in, so the topbar button and the Appearance page can't disagree.
// Each accent scheme carries a dark and a light value, so changing theme also
// changes which colour "the same accent" means.
function setTheme(next, { store = true } = {}) {
  document.documentElement.dataset.theme = next;
  if (store) localStorage.setItem(STORAGE_KEYS.theme, next);
  els.themeToggle.textContent = next === "dark" ? "☾" : "☀";
  els.themeDark.classList.toggle("active", next === "dark");
  els.themeLight.classList.toggle("active", next === "light");
  applyAccent(appliedAccent, next);
  if (accentDial) {
    accentDial.repaint(next);
    paintAccentState();
  }
}

// "Images" swaps the player for instructions on getting a screenshot in. The
// URL box goes with it: a URL imports media, and has nothing to say about an
// image on the clipboard. Clicking Images again — or loading a video — returns.
function setupImagesMode() {
  // The player's own prompt is hidden with a class elsewhere in this file, so
  // this remembers its state rather than guessing it back on the way out.
  let promptWasHidden = false;

  // Three things share the player box, and exactly one of them belongs on
  // screen: the video, a loaded image, or the drop zone. Everything that can
  // change which one that is calls this, so they can't disagree.
  const hasImage = () => Boolean(els.imageView.getAttribute("src"));
  const inImagesMode = () => els.imagesMode.getAttribute("aria-pressed") === "true";

  const syncPlayerBox = () => {
    const on = inImagesMode();
    const image = hasImage();
    els.video.hidden = on;
    els.imageView.classList.toggle("hidden", !on || !image);
    els.imagePane.classList.toggle("hidden", !on || image);
    els.imageBrowse.textContent = image ? "Replace image…" : "Choose a file…";
    if (!on || !image) clearHighlight(els);
  };

  const setImagesMode = (on) => {
    els.imagesMode.setAttribute("aria-pressed", String(on));
    els.imagesMode.classList.toggle("active", on);
    syncPlayerBox();
    // The URL row stays put and swaps its contents. Hiding the whole row would
    // change the panel's height, which shifts the page — and can take the
    // scrollbar with it.
    els.sourceUrl.hidden = on;
    els.queueUrl.hidden = on;
    els.imageBrowse.hidden = !on;
    if (on) {
      promptWasHidden = els.emptyPlayer.classList.contains("hidden");
      els.emptyPlayer.classList.add("hidden");
    } else {
      els.emptyPlayer.classList.toggle("hidden", promptWasHidden);
    }
  };

  // The highlight is drawn in pixels over a scaled picture, so it has to be
  // redrawn whenever that scaling changes — on load, when the natural size is
  // finally known, and on any resize.
  const repaintHighlight = () =>
    paintHighlight(els, state.subtitles[state.activeIndex]);
  els.imageView.addEventListener("load", repaintHighlight);
  addEventListener("resize", () => {
    if (inImagesMode()) repaintHighlight();
  });

  els.imagesMode.addEventListener("click", () => {
    setImagesMode(els.imagesMode.getAttribute("aria-pressed") !== "true");
  });
  els.videoInput.addEventListener("change", () => setImagesMode(false));

  // ---- getting an image in: paste, drop, or browse ----

  let preview = null;
  let reading = false;

  async function readImage(file) {
    if (reading) return;
    if (!file || !file.type.startsWith("image/")) {
      showToast("That isn't an image file.");
      return;
    }
    reading = true;
    setImagesMode(true);
    if (preview) URL.revokeObjectURL(preview);
    preview = URL.createObjectURL(file);
    clearHighlight(els);
    els.imageView.src = preview;
    // Once a picture is on screen the drop zone goes behind it, and the button
    // in the row below becomes the visible way to swap it out — and says so.
    syncPlayerBox();
    // The transcript panel is where the answer will appear, so that is where
    // "working on it" belongs — the import status line lives inside the URL
    // row, which Images mode hides.
    els.transcript.innerHTML = '<p class="muted">Reading the image…</p>';

    try {
      const res = await fetch("/api/ocr-image", {
        method: "POST",
        headers: { "Content-Type": file.type },
        body: file,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Server said ${res.status}.`);

      const lines = (data.lines || []).filter((line) => line.text.trim());
      if (!lines.length) {
        els.transcript.innerHTML =
          '<p class="muted">No text found in that image.</p>';
        return;
      }

      // Reuse the transcript wholesale: it already gives us clickable words,
      // saved-word marks, search and Save Line. `start: null` means "no
      // timecode" — an image has no time, and renderTranscript leaves the
      // gutter blank rather than printing 00:00 for every line.
      state.subtitles = lines.map((line, index) => ({
        cueIndex: index + 1,
        start: null,
        end: null,
        text: line.text,
        box: line.box,
        // One box per character, when the recogniser gave them: what lets a
        // selected line highlight its own characters on the picture.
        chars: line.chars || null,
        // Interface furniture the recogniser picked up. Kept in the list so it
        // gets translated too — it's only hidden — but folded away by default.
        chrome: Boolean(line.chrome),
      }));
      state.activeIndex = 0;
      state.showChrome = false;
      renderAll(els);
      // Lines loaded from a subtitle file get their pronunciation line from
      // loadSubtitles(); these bypass that, so ask for it here or a screenshot
      // would be the one place in the app with no pinyin.
      romanizeSubtitles();
      // The point of the feature is the translation, so don't make them ask.
      await runTranslation(els);
    } catch (error) {
      els.transcript.innerHTML = '<p class="muted">Couldn\'t read that image.</p>';
      showToast(error.message || "Couldn't read that image.");
    } finally {
      reading = false;
    }
  }

  els.imageBrowse.addEventListener("click", () => els.imageInput.click());
  els.imageInput.addEventListener("change", () => {
    const file = els.imageInput.files[0];
    els.imageInput.value = "";
    readImage(file);
  });
  els.imagePane.addEventListener("click", () => els.imageInput.click());

  // Drop anywhere on the player, so you don't have to hit the prompt exactly.
  // While a file is over it the drop zone comes *forward* — over a loaded image
  // if there is one — because otherwise you'd be dragging on faith: the zone
  // that would light up is behind the picture.
  const shell = document.querySelector("#playerShell");
  let dragging = false;

  const startDrag = () => {
    if (dragging) return;
    dragging = true;
    els.dropMessage.textContent = hasImage() ? "Drop to replace" : "Drop to read it";
    els.imagePane.classList.remove("hidden");
    els.imagePane.classList.add("dragging");
  };

  const endDrag = () => {
    if (!dragging) return;
    dragging = false;
    els.imagePane.classList.remove("dragging");
    syncPlayerBox();
  };

  shell.addEventListener("dragover", (event) => {
    if (!event.dataTransfer?.types.includes("Files")) return;
    event.preventDefault();
    startDrag();
  });
  // dragleave also fires when the pointer crosses onto a child element, so the
  // only real departure is one where the new target is outside the player.
  shell.addEventListener("dragleave", (event) => {
    if (event.relatedTarget && shell.contains(event.relatedTarget)) return;
    endDrag();
  });
  shell.addEventListener("drop", (event) => {
    if (!event.dataTransfer?.files.length) return;
    event.preventDefault();
    endDrag();
    readImage(event.dataTransfer.files[0]);
  });

  // Paste works anywhere in the app — you shouldn't have to click into a
  // panel first to use the clipboard.
  addEventListener("paste", (event) => {
    const item = [...(event.clipboardData?.items || [])].find((entry) =>
      entry.type.startsWith("image/"),
    );
    if (!item) return;
    event.preventDefault();
    readImage(item.getAsFile());
  });
}

// The wheel picks the page; everything inside a page is an ordinary control.
function setupSettings() {
  const showSettingsPage = (id) => {
    for (const page of document.querySelectorAll(".settings-page")) {
      page.classList.toggle("active", page.dataset.page === id);
    }
  };

  settingsPages = createWheel(
    els.settingsWheel,
    [
      { id: "appearance", label: "Appearance" },
      { id: "data", label: "Your data" },
      { id: "backups", label: "Automatic backups" },
      { id: "cookies", label: "Importing video" },
    ],
    (entry) => {
      showSettingsPage(entry.id);
      setSettingsPage(entry.id);
    },
    { startAt: state.settingsPage },
  );
  // createWheel deliberately doesn't fire onSelect for its starting row, so
  // the markup (which hard-codes Appearance) is brought into line here.
  showSettingsPage(state.settingsPage);

  accentDial = createAccentDial({
    dial: els.accentDial,
    face: els.accentFace,
    hub: els.accentHub,
    onPreview: paintAccentState,
  });
  accentDial.show(appliedAccent, document.documentElement.dataset.theme);

  els.applyAccent.addEventListener("click", () => {
    appliedAccent = accentDial.scheme().id;
    storeAccent(appliedAccent);
    applyAccent(appliedAccent, document.documentElement.dataset.theme);
    paintAccentState();
  });
  els.themeDark.addEventListener("click", () => setTheme("dark"));
  els.themeLight.addEventListener("click", () => setTheme("light"));
}

// Turning the dial repaints Settings alone, so a colour can be judged against
// real controls before the rest of the app commits to it.
function paintAccentState() {
  const scheme = accentDial.scheme();
  const settled = scheme.id === appliedAccent;
  els.accentName.textContent = scheme.name;
  els.accentNote.textContent = scheme.note;
  els.accentBay.classList.toggle("previewing", !settled);
  els.accentPill.textContent = settled ? "In use everywhere" : "Preview only";
  els.accentPill.classList.toggle("settled", settled);
  els.applyAccent.disabled = settled;
  els.applyAccent.textContent = settled
    ? "Already in use"
    : "Use this everywhere";
  if (settled) {
    els.settingsLayout.style.removeProperty("--accent");
  } else {
    els.settingsLayout.style.setProperty(
      "--accent",
      accentFor(scheme.id, document.documentElement.dataset.theme),
    );
  }
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

// Started last, not from the middle of the file. Functions hoist but `const`s
// don't: opening straight into Settings called renderDataPanel() before
// ESTIMATED_QUOTA below had been evaluated, which threw and left the rest of
// init — including the first-paint cleanup — unrun.
init();
