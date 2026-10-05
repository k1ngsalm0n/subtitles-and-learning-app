// "Get clear word meanings" — the dialog that sets up a chat model.
//
// A fresh install has no API key, and without one every word lookup quietly
// settles for the dictionary entry and a literal offline translation. Nothing
// said so; the reader just got worse meanings than the person who wrote the
// .env. So on first open, when no choice has been made anywhere, this asks —
// once. "Offline only" is a real answer and is remembered server-side; "Not
// now" asks again next time the app opens.
//
// The key goes to the server (server/llmConfig.mjs), which tries it before
// keeping it and never sends it back.

import { createCombobox } from "./combobox.mjs";

// Shown beside each option. The server owns the URLs and model names; this
// owns the words a person choosing between them needs.
const BLURBS = {
  groq: "Free account, then paste a key. Fast.",
  gemini: "Free tier with a Google account.",
  openrouter: "Free models with an account; daily limit.",
  openai: "Paid per use — pennies for a lot of lookups.",
  ollama: "No account, stays on this computer. Install Ollama and pull any model. Slower.",
  custom: "Any OpenAI-compatible chat API.",
  offline: "No account, nothing sent. Dictionary meanings only, no explanations.",
};

const ORDER = ["groq", "gemini", "openrouter", "openai", "ollama", "custom", "offline"];

let status = null;
let els = null;

function $(id) {
  return document.getElementById(id);
}

async function fetchStatus() {
  const res = await fetch("/api/llm");
  if (!res.ok) throw new Error("Couldn't reach the server.");
  status = await res.json();
  return status;
}

function selected() {
  return els.provider.value || "groq";
}

// One dropdown rather than a card per provider: the list had grown to fill the
// dialog. Searching matches the blurb too, so "free" finds every free one.
function renderOptions() {
  els.provider.setItems(ORDER.map((id) => ({
    value: id,
    label: id === "offline" ? "Offline only" : status.providers[id].label,
    detail: BLURBS[id],
    tag: id === "groq" ? "Recommended" : "",
  })));
}

// Each provider brings its own address, model and "where do I get a key".
function fillFields(id) {
  const preset = status.providers[id];
  const offline = id === "offline";
  els.blurb.textContent = BLURBS[id] || "";
  els.fields.hidden = offline;
  els.error.textContent = "";
  els.save.textContent = offline ? "Use offline only" : "Check and save";
  if (offline) return;

  const current = status.provider === id;
  els.baseUrl.value = current ? status.baseUrl : preset.baseUrl;
  els.model.value = current ? status.model : preset.model;
  els.key.value = "";
  els.key.placeholder = current && status.keyHint
    ? `Saved key ${status.keyHint} — leave blank to keep it`
    : preset.needsKey ? "Paste your API key" : "Not needed";
  els.keyRow.hidden = id === "ollama";
  els.modelRow.hidden = id !== "ollama";
  if (id === "ollama") loadOllamaModels();

  if (preset.keyUrl) {
    els.keyLink.href = preset.keyUrl;
    els.keyLink.textContent = id === "ollama" ? "Download Ollama ↗" : `Get a ${preset.label} key ↗`;
    els.keyLink.hidden = false;
  } else {
    els.keyLink.hidden = true;
  }
  // Custom has nothing to prefill, so the address and model can't hide.
  els.advanced.open = id === "custom";
}

// Ollama's models are whatever this computer has pulled, so offer those rather
// than make the reader type a name exactly. The text field under "Address and
// model" stays the source of truth; the dropdown just fills it.
let listing = 0;

function note(text) {
  els.modelNote.textContent = text;
}

async function loadOllamaModels() {
  const ticket = ++listing;
  const pick = els.modelPick;
  pick.setItems([]);
  pick.disabled = true;
  note("Looking for installed models…");
  let data = null;
  try {
    const base = encodeURIComponent(els.baseUrl.value.trim());
    const res = await fetch(`/api/llm/models?base=${base}`);
    data = await res.json();
  } catch {
    data = { ok: false, error: "Couldn't reach the app's server." };
  }
  // A second load started meanwhile, or the reader moved to another provider
  // whose model this must not overwrite.
  if (ticket !== listing || selected() !== "ollama") return;

  if (!data.ok) {
    note(data.running === false
      ? "Ollama isn't running. Start it, then press Refresh."
      : data.error);
    return;
  }
  if (!data.models.length) {
    note("No models installed yet. Run `ollama pull qwen2.5:3b` (or any model), then press Refresh.");
    return;
  }

  pick.setItems(data.models.map((name) => ({ value: name, label: name })));
  // Keep the saved model if it's still there; otherwise prefer a Qwen, which
  // is strongest on Chinese, then whatever comes first.
  const wanted = els.model.value;
  pick.value = data.models.includes(wanted)
    ? wanted
    : data.models.find((m) => /qwen/i.test(m)) || data.models[0];
  els.model.value = pick.value;
  pick.disabled = false;
  note(data.models.length === 1 ? "1 model installed." : `${data.models.length} models installed.`);
}

function describeCurrent() {
  if (status.origin === "env") {
    return `Using the key in .env (${status.model}, ${status.keyHint}). A choice saved here takes over from it.`;
  }
  if (status.provider === "offline") return "Currently: offline only.";
  if (status.configured) {
    return `Currently: ${status.providers[status.provider]?.label} (${status.model}, key ${status.keyHint || "not needed"}).`;
  }
  return "";
}

async function save() {
  const provider = selected();
  els.error.textContent = "";
  els.save.disabled = true;
  const label = els.save.textContent;
  if (provider !== "offline") els.save.textContent = "Checking…";
  try {
    const body = provider === "offline"
      ? { provider }
      : {
          provider,
          baseUrl: els.baseUrl.value.trim(),
          model: els.model.value.trim(),
          apiKey: els.key.value.trim(),
        };
    const res = await fetch("/api/llm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Couldn't save that.");
    status = data;
    els.key.value = "";
    els.dialog.close("saved");
    els.onSaved?.(status);
  } catch (error) {
    els.error.textContent = error.message;
  } finally {
    els.save.disabled = false;
    els.save.textContent = label;
  }
}

export async function openLlmSetup() {
  if (!els) return;
  try {
    await fetchStatus();
  } catch {
    return;
  }
  renderOptions();
  const start = status.provider && status.provider !== "env" ? status.provider : "groq";
  els.provider.value = ORDER.includes(start) ? start : "groq";
  fillFields(selected());
  els.current.textContent = describeCurrent();
  els.current.hidden = !els.current.textContent;
  els.dialog.showModal();
}

// onSaved: called with the new status, so the caller can refresh what depends
// on it (the "What's running" page, a toast).
export function setupLlmDialog({ onSaved } = {}) {
  els = {
    dialog: $("llmSetupDialog"),
    provider: $("llmProvider"),
    blurb: $("llmBlurb"),
    fields: $("llmFields"),
    keyRow: $("llmKeyRow"),
    key: $("llmKey"),
    keyLink: $("llmKeyLink"),
    advanced: $("llmAdvanced"),
    baseUrl: $("llmBaseUrl"),
    model: $("llmModel"),
    error: $("llmError"),
    current: $("llmCurrent"),
    modelRow: $("llmModelRow"),
    modelPick: $("llmModelPick"),
    modelNote: $("llmModelNote"),
    modelRefresh: $("llmModelRefresh"),
    save: $("llmSave"),
    onSaved,
  };
  if (!els.dialog) {
    els = null;
    return;
  }
  els.provider = createCombobox(els.provider, {
    label: "Provider",
    placeholder: "Search providers…",
    onChange: fillFields,
  });
  els.modelPick = createCombobox(els.modelPick, {
    label: "Model",
    placeholder: "Search installed models…",
    onChange: (name) => {
      els.model.value = name;
    },
  });
  els.dialog.addEventListener("close", () => {
    els.provider.close();
    els.modelPick.close();
  });
  els.save.addEventListener("click", save);
  els.modelRefresh.addEventListener("click", loadOllamaModels);
  // A different address is a different Ollama, with different models.
  els.baseUrl.addEventListener("change", () => {
    if (selected() === "ollama") loadOllamaModels();
  });
  els.key.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      save();
    }
  });
}

// On startup: ask only if nothing has been decided, here or in .env.
export async function promptLlmSetupIfNeeded() {
  try {
    const current = await fetchStatus();
    if (!current.chosen) await openLlmSetup();
  } catch {
    // Server unreachable: nothing to set up against.
  }
}
