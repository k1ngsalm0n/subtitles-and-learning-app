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
import { api } from "./backend.mjs";

// Shown beside each option. The server owns the URLs and model names; this
// owns the words a person choosing between them needs.
const BLURBS = {
  claude: "No key. Uses your Claude plan through Claude Code on this computer. A few seconds per word.",
  groq: "Free account, then paste a key. Fast.",
  gemini: "Free tier with a Google account.",
  openrouter: "Free models with an account; daily limit.",
  openai: "Paid per use — pennies for a lot of lookups.",
  deepseek: "Paid per use, and among the cheapest. Strong at Chinese.",
  ollama: "No account, stays on this computer. Install Ollama and pull any model. Slower.",
  custom: "Any OpenAI-compatible chat API.",
  offline: "No account, nothing sent. Dictionary meanings only, no explanations.",
};

const ORDER = ["claude", "groq", "gemini", "openrouter", "openai", "deepseek", "ollama", "custom", "offline"];

let status = null;
let els = null;

function $(id) {
  return document.getElementById(id);
}

async function fetchStatus() {
  const res = await api("/api/llm");
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
    tag: id === "groq" ? "Recommended" : id === "claude" ? "No key" : "",
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
  // Claude has no key and no address: Claude Code signs in by itself.
  els.keyRow.hidden = id === "ollama" || Boolean(preset.noAddress);
  els.baseUrl.closest("label").hidden = Boolean(preset.noAddress);
  els.modelRow.hidden = id !== "ollama";
  if (id === "ollama") loadOllamaModels();

  if (preset.keyUrl) {
    els.keyLink.href = preset.keyUrl;
    els.keyLink.textContent =
      id === "ollama" ? "Download Ollama ↗" : id === "claude" ? "Get Claude Code ↗"
        : `Get ${/^[AEIOU]/i.test(preset.label) ? "an" : "a"} ${preset.label} key ↗`;
    els.keyLink.hidden = false;
  } else {
    els.keyLink.hidden = true;
  }
  // What leaves this computer, said in terms of this choice: Claude has no key.
  els.privacy.textContent = preset.noAddress
    ? "No key. The words you look up and the subtitle lines go to Claude through Claude Code on this computer, on your own Claude plan."
    : "The key stays on this computer and goes only to that provider, along with the words you look up and the subtitle lines.";
  if (id === "claude") refreshClaudeSetup();
  else {
    claudeTicket++;
    stopClaudePoll();
    els.claudeSetup.hidden = true;
  }
  // Custom has nothing to prefill, so the address and model can't hide.
  els.advanced.open = id === "custom";
}

// Claude Code's state, and the one next step: install it, sign in, or nothing
// (server/claudecode.mjs). The reader never opens a terminal. From a phone
// (through Tailscale) it only reports: installing software on the computer is
// done on the computer.
let claudeTicket = 0;
let claudePoll = null;

function claudeEl(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "onclick") el.addEventListener("click", v);
    else if (k === "class") el.className = v;
    else el.setAttribute(k, v);
  }
  el.append(...children.filter((c) => c != null && c !== false));
  return el;
}

async function claudeAct(action, extra = {}) {
  const res = await api("/api/claude-code", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, ...extra }),
  });
  return res.json().catch(() => ({ ok: false, error: "The computer didn't answer." }));
}

function stopClaudePoll() {
  clearInterval(claudePoll);
  claudePoll = null;
}

async function refreshClaudeSetup(message = "") {
  const panel = els.claudeSetup;
  const ticket = ++claudeTicket;
  stopClaudePoll();
  panel.hidden = false;
  panel.replaceChildren(claudeEl("span", { class: "muted" }, "Checking Claude Code on this computer…"));
  let s;
  try {
    s = await (await api("/api/claude-code")).json();
  } catch {
    s = null;
  }
  if (ticket !== claudeTicket || selected() !== "claude") return;
  if (!s || s.error) {
    panel.replaceChildren(claudeEl("span", { class: "claude-error" }, "Restart Stele so it can set up Claude Code, then try again."));
    return;
  }
  const note = message && claudeEl("span", { class: "claude-error" }, message);
  const remote = s.here !== "computer";
  if (!s.installed) {
    panel.replaceChildren(
      claudeEl("span", {}, "Claude Code isn't on this computer yet. It's free to install, and needs a paid Claude plan (Pro or Max) to sign in."),
      note,
      remote
        ? claudeEl("span", { class: "muted" }, "Install it from the computer Stele runs on.")
        : claudeEl("div", { class: "claude-row" }, claudeEl("button", { type: "button", onclick: onInstall }, "Install Claude Code")),
    );
    return;
  }
  if (!s.signedIn) {
    panel.replaceChildren(
      claudeEl("span", {}, "Claude Code is installed. Sign in with your Claude account (Pro or Max)."),
      note,
      remote
        ? claudeEl("span", { class: "muted" }, "Sign in from the computer Stele runs on.")
        : claudeEl("div", { class: "claude-row" }, claudeEl("button", { type: "button", onclick: onSignIn }, "Sign in to Claude")),
    );
    return;
  }
  const plan = s.plan ? ` (${s.plan[0].toUpperCase()}${s.plan.slice(1)})` : "";
  panel.replaceChildren(
    claudeEl("span", { class: "claude-ok" }, `✓ Claude Code is ready, signed in as ${s.email || "you"}${plan}.`),
    note,
  );
}

async function onInstall(event) {
  const button = event.currentTarget;
  button.disabled = true;
  button.textContent = "Installing… (about a minute)";
  const result = await claudeAct("install");
  refreshClaudeSetup(result.ok ? "" : result.error || "Claude Code didn't install.");
}

async function onSignIn(event) {
  const button = event.currentTarget;
  button.disabled = true;
  button.textContent = "Opening Claude…";
  const result = await claudeAct("signin");
  if (!result.ok) return refreshClaudeSetup(result.error);
  if (result.alreadySignedIn || !result.link) return refreshClaudeSetup();
  window.open(result.link, "_blank", "noopener");
  const code = claudeEl("input", { type: "text", id: "claudeCode", autocomplete: "off", spellcheck: "false", placeholder: "Paste the code from Claude's page" });
  const finish = claudeEl("button", { type: "button" }, "Finish sign-in");
  finish.addEventListener("click", async () => {
    finish.disabled = true;
    finish.textContent = "Signing in…";
    const done = await claudeAct("code", { code: code.value });
    refreshClaudeSetup(done.ok ? "" : done.error);
  });
  code.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      finish.click();
    }
  });
  els.claudeSetup.replaceChildren(
    claudeEl("span", {}, "Sign in on the page that opened. Claude then shows a code: paste it here."),
    claudeEl("span", { class: "muted" }, "No page? ", claudeEl("a", { href: result.link, target: "_blank", rel: "noopener noreferrer" }, "Open Claude's sign-in ↗")),
    claudeEl("div", { class: "claude-row" }, code, finish),
  );
  // Some sign-ins finish in the browser without a code: notice that too.
  const ticket = claudeTicket;
  claudePoll = setInterval(async () => {
    if (ticket !== claudeTicket || !els.dialog.open) return stopClaudePoll();
    try {
      const s = await (await api("/api/claude-code")).json();
      if (s.signedIn) refreshClaudeSetup();
    } catch {
      // Keep waiting.
    }
  }, 3000);
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
    const res = await api(`/api/llm/models?base=${base}`);
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
  if (provider !== "offline") els.save.textContent = provider === "claude" ? "Asking Claude…" : "Checking…";
  try {
    const body = provider === "offline"
      ? { provider }
      : {
          provider,
          baseUrl: els.baseUrl.value.trim(),
          model: els.model.value.trim(),
          apiKey: els.key.value.trim(),
        };
    const res = await api("/api/llm", {
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
    privacy: $("llmPrivacy"),
    claudeSetup: $("claudeSetup"),
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
