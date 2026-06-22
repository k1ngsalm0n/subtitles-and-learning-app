const STORAGE_KEYS = {
  cards: "miraaStudio.cards",
  sources: "miraaStudio.sources",
  theme: "miraaStudio.theme",
  prompt: "miraaStudio.prompt"
};

const sampleOriginal = `1
00:00:00,000 --> 00:00:03,200
Learning with real conversations makes vocabulary easier to remember.

2
00:00:03,200 --> 00:00:06,800
Pause when you hear a useful phrase and save it as a flashcard.

3
00:00:06,800 --> 00:00:10,500
Short daily reviews help new words become active language.`;

const sampleTranslation = `1
00:00:00,000 --> 00:00:03,200
用真实对话学习，会让词汇更容易记住。

2
00:00:03,200 --> 00:00:06,800
听到有用短语时暂停，并把它保存成抽认卡。

3
00:00:06,800 --> 00:00:10,500
每天简短复习能帮助新词变成主动语言。`;

const state = {
  subtitles: [],
  cards: loadJson(STORAGE_KEYS.cards, []),
  sources: loadJson(STORAGE_KEYS.sources, []),
  activeIndex: 0,
  reviewIndex: 0,
  showingBack: false,
  translationMode: "human",
  selectedWord: ""
};

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
  modeHuman: document.querySelector("#modeHuman"),
  modeAI: document.querySelector("#modeAI"),
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
  addWordCard: document.querySelector("#addWordCard")
};

init();

function init() {
  document.documentElement.dataset.theme = localStorage.getItem(STORAGE_KEYS.theme) || "dark";
  els.translatorPrompt.value = localStorage.getItem(STORAGE_KEYS.prompt) || els.translatorPrompt.value;
  bindEvents();
  loadSubtitles(sampleOriginal, sampleTranslation);
  renderAll();
}

function bindEvents() {
  document.querySelectorAll(".nav-tab").forEach((button) => {
    button.addEventListener("click", () => switchView(button.dataset.view));
  });

  els.themeToggle.addEventListener("click", toggleTheme);
  els.sampleButton.addEventListener("click", () => loadSubtitles(sampleOriginal, sampleTranslation));
  els.videoInput.addEventListener("change", handleVideoInput);
  els.originalInput.addEventListener("change", () => readSubtitleInputs());
  els.translationInput.addEventListener("change", () => readSubtitleInputs());
  els.video.addEventListener("timeupdate", syncToVideo);
  els.searchInput.addEventListener("input", renderTranscript);
  els.loopLine.addEventListener("click", loopActiveLine);
  els.saveLine.addEventListener("click", saveActiveLine);
  els.queueUrl.addEventListener("click", importSourceUrl);
  els.modeHuman.addEventListener("click", () => setTranslationMode("human"));
  els.modeAI.addEventListener("click", () => setTranslationMode("ai"));
  els.manualCardForm.addEventListener("submit", addManualCard);
  els.flipCard.addEventListener("click", flipReviewCard);
  els.markHard.addEventListener("click", () => gradeCard("hard"));
  els.markGood.addEventListener("click", () => gradeCard("good"));
  els.shuffleCards.addEventListener("click", shuffleCards);
  els.exportCards.addEventListener("click", exportCards);
  els.savePrompt.addEventListener("click", () => localStorage.setItem(STORAGE_KEYS.prompt, els.translatorPrompt.value));
  els.addWordCard.addEventListener("click", addDialogCard);
}

function switchView(view) {
  document.querySelectorAll(".nav-tab").forEach((button) => button.classList.toggle("active", button.dataset.view === view));
  document.querySelectorAll(".view").forEach((panel) => panel.classList.remove("active"));
  document.querySelector(`#${view}View`).classList.add("active");
}

function toggleTheme() {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
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

function loadSubtitles(originalText, translationText = "") {
  const original = parseSubtitle(originalText);
  const translated = parseSubtitle(translationText);
  state.subtitles = original.map((line, index) => ({
    ...line,
    translation: translated[index]?.text || ""
  }));
  state.activeIndex = 0;
  renderAll();
}

async function importSourceUrl() {
  const url = els.sourceUrl.value.trim();
  if (!url) return;

  const source = { id: crypto.randomUUID(), url, status: "importing", createdAt: Date.now() };
  state.sources.unshift(source);
  saveSources();
  setSourceStatus("Looking for captions...");
  els.queueUrl.disabled = true;
  renderSources();

  try {
    const response = await fetch("/api/import-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url })
    });

    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Import failed.");

    if (result.videoUrl) {
      els.video.src = result.videoUrl;
      els.emptyPlayer.classList.add("hidden");
    }

    loadSubtitles(result.subtitles || "");
    source.status = result.source === "whisper" ? "transcribed" : "captions loaded";
    source.title = result.title || "";
    els.sourceUrl.value = "";
    setSourceStatus(result.source === "whisper" ? "Transcribed with Whisper." : "Loaded existing subtitles.");
  } catch (error) {
    source.status = "error";
    source.error = error.message;
    setSourceStatus(error.message);
  } finally {
    els.queueUrl.disabled = false;
    saveSources();
    renderSources();
  }
}

function parseSubtitle(text) {
  return text
    .replace(/\r/g, "")
    .trim()
    .split(/\n{2,}/)
    .map((block) => block.split("\n").filter(Boolean))
    .map((lines) => {
      const timeIndex = lines.findIndex((line) => line.includes("-->"));
      if (timeIndex === -1) return null;
      const [start, end] = lines[timeIndex].split("-->").map((value) => parseTime(value.trim()));
      return {
        start,
        end,
        text: lines.slice(timeIndex + 1).join(" ").trim()
      };
    })
    .filter(Boolean);
}

function parseTime(value) {
  const clean = value.replace(",", ".").split(" ")[0];
  const parts = clean.split(":").map(Number);
  const seconds = parts.pop() || 0;
  const minutes = parts.pop() || 0;
  const hours = parts.pop() || 0;
  return hours * 3600 + minutes * 60 + seconds;
}

function formatTime(seconds) {
  const min = Math.floor(seconds / 60).toString().padStart(2, "0");
  const sec = Math.floor(seconds % 60).toString().padStart(2, "0");
  return `${min}:${sec}`;
}

function renderAll() {
  renderTranscript();
  renderActiveSubtitle();
  renderDeck();
  renderReviewCard();
  renderSources();
  updateStats();
}

function renderTranscript() {
  const query = els.searchInput.value.trim().toLowerCase();
  const html = state.subtitles
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => !query || `${line.text} ${line.translation}`.toLowerCase().includes(query))
    .map(({ line, index }) => {
      const translation = getTranslation(line);
      return `<article class="line ${index === state.activeIndex ? "active" : ""}" data-index="${index}">
        <span class="time">${formatTime(line.start)}</span>
        <div>
          <div class="original">${tokenize(line.text)}</div>
          <p class="translation">${escapeHtml(translation)}</p>
        </div>
      </article>`;
    })
    .join("");

  els.transcript.innerHTML = html || `<p class="muted">No matching subtitles.</p>`;
  els.transcript.querySelectorAll(".line").forEach((lineEl) => {
    lineEl.addEventListener("click", (event) => {
      if (event.target.classList.contains("word")) return;
      activateLine(Number(lineEl.dataset.index), true);
    });
  });
  els.transcript.querySelectorAll(".word").forEach((button) => {
    button.addEventListener("click", () => openWordDialog(button.dataset.word));
  });
}

function tokenize(text) {
  return escapeHtml(text).replace(/\b[\w'-]+\b/g, (word) => {
    return `<button class="word" type="button" data-word="${escapeHtml(word.toLowerCase())}">${word}</button>`;
  });
}

function activateLine(index, seek) {
  state.activeIndex = index;
  if (seek && Number.isFinite(state.subtitles[index]?.start)) {
    els.video.currentTime = state.subtitles[index].start;
  }
  renderTranscript();
  renderActiveSubtitle();
}

function renderActiveSubtitle() {
  const line = state.subtitles[state.activeIndex];
  els.activeOriginal.textContent = line?.text || "Load subtitles to begin.";
  els.activeTranslation.textContent = line ? getTranslation(line) : "";
}

function getTranslation(line) {
  if (state.translationMode === "human") return line.translation || "No translation loaded.";
  return line.translation || draftTranslation(line.text);
}

function draftTranslation(text) {
  const words = text.split(/\s+/).slice(0, 12).join(" ");
  return `AI draft: ${words}`;
}

function syncToVideo() {
  const time = els.video.currentTime;
  const index = state.subtitles.findIndex((line) => time >= line.start && time < line.end);
  if (index !== -1 && index !== state.activeIndex) {
    state.activeIndex = index;
    renderTranscript();
    renderActiveSubtitle();
  }
}

function loopActiveLine() {
  const line = state.subtitles[state.activeIndex];
  if (!line) return;
  els.video.currentTime = line.start;
  els.video.play();
  const stopAt = line.end;
  const stop = () => {
    if (els.video.currentTime >= stopAt) {
      els.video.currentTime = line.start;
      els.video.removeEventListener("timeupdate", stop);
    }
  };
  els.video.addEventListener("timeupdate", stop);
}

function saveActiveLine() {
  const line = state.subtitles[state.activeIndex];
  if (!line) return;
  addCard(line.text, getTranslation(line), line.text);
}

function setTranslationMode(mode) {
  state.translationMode = mode;
  els.modeHuman.classList.toggle("active", mode === "human");
  els.modeAI.classList.toggle("active", mode === "ai");
  renderTranscript();
  renderActiveSubtitle();
}

function openWordDialog(word) {
  const line = state.subtitles[state.activeIndex];
  state.selectedWord = word;
  els.dialogWord.textContent = word;
  els.dialogMeaning.value = "";
  els.dialogExample.value = line?.text || "";
  els.wordDialog.showModal();
}

function addDialogCard() {
  addCard(state.selectedWord, els.dialogMeaning.value || "Add your meaning", els.dialogExample.value);
  els.wordDialog.close();
}

function addManualCard(event) {
  event.preventDefault();
  addCard(els.manualFront.value, els.manualBack.value, "");
  els.manualCardForm.reset();
}

function addCard(front, back, example) {
  const card = {
    id: crypto.randomUUID(),
    front: front.trim(),
    back: back.trim(),
    example: example.trim(),
    interval: 1,
    due: Date.now(),
    createdAt: Date.now()
  };
  if (!card.front || !card.back) return;
  state.cards.unshift(card);
  saveCards();
  renderDeck();
  renderReviewCard();
  updateStats();
}

function renderDeck() {
  els.deckList.innerHTML = state.cards
    .map((card) => `<article class="deck-item">
      <div>
        <strong>${escapeHtml(card.front)}</strong>
        <p>${escapeHtml(card.back)}</p>
      </div>
      <button class="delete-card danger" type="button" data-id="${card.id}">Delete</button>
    </article>`)
    .join("") || `<p class="muted">Click words in the transcript or add cards manually.</p>`;

  els.deckList.querySelectorAll(".delete-card").forEach((button) => {
    button.addEventListener("click", () => {
      state.cards = state.cards.filter((card) => card.id !== button.dataset.id);
      saveCards();
      renderAll();
    });
  });
}

function renderReviewCard() {
  const card = state.cards[state.reviewIndex];
  if (!card) {
    els.reviewCard.innerHTML = "<p>No flashcards yet.</p>";
    return;
  }
  els.reviewCard.innerHTML = state.showingBack
    ? `<div><strong>${escapeHtml(card.back)}</strong><p class="muted">${escapeHtml(card.example || card.front)}</p></div>`
    : `<div><strong>${escapeHtml(card.front)}</strong><p class="muted">Flip to check meaning</p></div>`;
}

function flipReviewCard() {
  state.showingBack = !state.showingBack;
  renderReviewCard();
}

function gradeCard(grade) {
  const card = state.cards[state.reviewIndex];
  if (!card) return;
  card.interval = grade === "good" ? Math.min(card.interval * 2, 30) : 1;
  card.due = Date.now() + card.interval * 86400000;
  state.reviewIndex = (state.reviewIndex + 1) % state.cards.length;
  state.showingBack = false;
  saveCards();
  renderReviewCard();
  updateStats();
}

function shuffleCards() {
  state.cards.sort(() => Math.random() - 0.5);
  state.reviewIndex = 0;
  state.showingBack = false;
  saveCards();
  renderAll();
}

function exportCards() {
  const blob = new Blob([JSON.stringify(state.cards, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "miraa-flashcards.json";
  link.click();
  URL.revokeObjectURL(url);
}

function saveSources() {
  localStorage.setItem(STORAGE_KEYS.sources, JSON.stringify(state.sources));
}

function setSourceStatus(message) {
  els.sourceStatus.textContent = message;
}

function renderSources() {
  els.sourceList.innerHTML = state.sources
    .map((source) => `<article class="source-item">
      <strong>${escapeHtml(source.status)}</strong>
      ${source.title ? `<p>${escapeHtml(source.title)}</p>` : ""}
      <p class="muted">${escapeHtml(source.url)}</p>
      ${source.error ? `<p class="danger">${escapeHtml(source.error)}</p>` : ""}
    </article>`)
    .join("") || `<p class="muted">Queued media URLs will appear here.</p>`;
}

function updateStats() {
  els.subtitleCount.textContent = state.subtitles.length;
  els.cardCount.textContent = state.cards.length;
  els.reviewDue.textContent = state.cards.filter((card) => card.due <= Date.now()).length;
}

function saveCards() {
  localStorage.setItem(STORAGE_KEYS.cards, JSON.stringify(state.cards));
}

function loadJson(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) || fallback;
  } catch {
    return fallback;
  }
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
