// Settings → "What's running": every part of the app that quietly settles for
// second best, and what to type to fix it.
//
// The app is built to degrade rather than break — no voice model gives a
// robotic voice, no API key gives the offline translator, no segmenter gives
// the browser's. That keeps it working everywhere, but it also means a reader
// can't tell a deliberate fallback from something they installed wrongly. This
// page is the answer to "why does this sound like that?".

const LABELS = {
  best: "Best available",
  fallback: "Using a fallback",
  off: "Unavailable",
};

let loaded = false;
// Kept so a toggle can re-render without its caller passing els back in.
let _els = null;
// Which toggle is mid-change. Re-rendering builds fresh elements, so the
// spinner has to be re-applied to the new one or it vanishes for the whole
// wait — which is precisely the wait it exists to cover.
let pending = null;

// The last answer, kept so reopening the page shows it at once instead of
// flashing "Checking…" while a Python process starts. It is only ever a
// starting point: a fresh check is always run behind it, because the reason to
// open this page is usually that something just changed.
const REMEMBERED = "stele.health";

function remembered() {
  try {
    const raw = localStorage.getItem(REMEMBERED);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function remember(data) {
  try {
    localStorage.setItem(REMEMBERED, JSON.stringify(data));
  } catch {
    // Storage full or blocked: the page still works, it just re-checks.
  }
}

// Both controls on this page take a couple of seconds — they restart a probe
// that starts a Python process. Silence for that long reads as a broken button,
// so every press says it is working and then says it is done.
function setBusy(slot) {
  if (!slot) return;
  slot.className = "health-status busy";
  slot.textContent = "";
  slot.setAttribute("aria-label", "Working");
}

function setDone(slot, ok = true) {
  if (!slot) return;
  slot.className = ok ? "health-status" : "health-status failed";
  slot.textContent = ok ? "✓" : "!";
  slot.setAttribute("aria-label", ok ? "Done" : "Didn't work");
  // Long enough to be seen, short enough not to look like a permanent badge.
  clearTimeout(slot._clear);
  slot._clear = setTimeout(() => {
    slot.className = "health-status";
    slot.textContent = "";
    slot.removeAttribute("aria-label");
  }, ok ? 1800 : 4000);
}

// Some rows are a *choice*, not a defect: which voice speaks, whether text is
// sent to a chat model. Those get a segmented control. The rest are missing
// software, where a switch would be a lie — they keep their command instead.
function toggleRow(toggle) {
  const wrap = document.createElement("div");
  wrap.className = "health-toggle";

  const line = document.createElement("div");
  line.className = "health-toggle-row";

  const slot = document.createElement("span");
  slot.className = "health-status";
  slot.setAttribute("role", "status");
  slot.setAttribute("aria-live", "polite");
  // Re-rendering replaces this element, so the tick is put back afterwards by
  // name rather than being expected to survive.
  slot.dataset.status = toggle.name;
  if (pending === toggle.name) setBusy(slot);

  const group = document.createElement("div");
  group.className = "segmented";
  group.setAttribute("role", "radiogroup");
  group.setAttribute("aria-label", toggle.name);

  for (const option of toggle.options) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = option.label;
    button.setAttribute("role", "radio");
    const active = option.value === toggle.value;
    button.classList.toggle("active", active);
    button.setAttribute("aria-checked", String(active));
    if (!option.enabled) {
      button.disabled = true;
      button.title = "Not available on this machine";
    }
    button.addEventListener("click", async () => {
      if (option.value === toggle.value) return;
      for (const other of group.children) other.disabled = true;
      pending = toggle.name;
      setBusy(slot);
      let ok = false;
      try {
        const res = await fetch("/api/prefs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ [toggle.name]: option.value }),
        });
        const saved = await res.json();
        // The server replies with what it stored, so "did it take?" is a fact
        // rather than a hope — asking for something it refuses leaves the old
        // value, and that must not show a tick.
        ok = res.ok && saved?.prefs?.[toggle.name] === option.value;
      } catch {
        ok = false;
      }
      // Re-ask rather than assume: the row's wording, its state dot and its
      // fix line all depend on the setting, and the server is what decides
      // whether the change was accepted at all.
      await renderHealth(_els, { force: true });
      pending = null;
      // That replaced this element, so find its successor to mark.
      setDone(_els?.healthList?.querySelector(`[data-status="${toggle.name}"]`), ok);
    });
    group.append(button);
  }
  line.append(group, slot);
  wrap.append(line);

  if (toggle.note) {
    const note = document.createElement("p");
    note.className = "health-note muted";
    note.textContent = toggle.note;
    wrap.append(note);
  }
  return wrap;
}

function checkRow(check) {
  const row = document.createElement("article");
  row.className = `health-row health-${check.state}`;

  const head = document.createElement("div");
  head.className = "health-head";

  const dot = document.createElement("span");
  dot.className = "health-dot";
  // The state is a colour, and colour alone is not a message: name it too.
  dot.setAttribute("role", "img");
  dot.setAttribute("aria-label", LABELS[check.state] || check.state);
  head.append(dot);

  const name = document.createElement("h3");
  name.textContent = check.label;
  head.append(name);

  const tag = document.createElement("span");
  tag.className = "health-tag";
  tag.textContent = LABELS[check.state] || check.state;
  head.append(tag);
  row.append(head);

  const using = document.createElement("p");
  using.className = "health-using";
  using.textContent = check.using;
  row.append(using);

  if (check.detail) {
    const detail = document.createElement("p");
    detail.className = "health-detail muted";
    detail.textContent = check.detail;
    row.append(detail);
  }

  if (check.toggle) row.append(toggleRow(check.toggle));

  if (check.fix) {
    const fix = document.createElement("div");
    fix.className = "health-fix";

    const label = document.createElement("span");
    label.className = "health-fix-label";
    label.textContent = "To fix";
    fix.append(label);

    const code = document.createElement("code");
    code.textContent = check.fix;
    fix.append(code);

    // Typed into a terminal, so make it one click to carry across.
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "health-copy";
    copy.textContent = "Copy";
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(check.fix);
        copy.textContent = "Copied";
        setTimeout(() => { copy.textContent = "Copy"; }, 1500);
      } catch {
        copy.textContent = "Select it";
      }
    });
    fix.append(copy);
    row.append(fix);

    if (check.fixNote) {
      const note = document.createElement("p");
      note.className = "health-note muted";
      note.textContent = check.fixNote;
      row.append(note);
    }
  }

  return row;
}

export async function renderHealth(els, { force = false, status = null } = {}) {
  if (els) _els = els;
  const list = _els?.healthList;
  if (!list) return;
  // Each visit would otherwise spawn a Python process to ask the same
  // questions; the answers only change when something is installed.
  if (loaded && !force) return;

  if (status) setBusy(status);

  const last = remembered();
  if (last?.checks?.length) {
    paint(list, last);
  } else {
    list.textContent = "";
    const checking = document.createElement("p");
    checking.className = "muted";
    checking.textContent = "Checking…";
    list.append(checking);
  }

  let data = null;
  try {
    const res = await fetch(force ? "/api/health?fresh=1" : "/api/health");
    if (res.ok) data = await res.json();
  } catch {
    // handled below
  }

  if (!data?.checks?.length) {
    setDone(status, false);
    // Keep whatever was on screen if we had something; stale beats blank.
    if (!last?.checks?.length) {
      list.textContent = "";
      const failed = document.createElement("p");
      failed.className = "muted";
      failed.textContent = "Couldn't reach the server to check.";
      list.append(failed);
    }
    return;
  }
  loaded = true;
  remember(data);
  paint(list, data);
  setDone(status, true);
}

function paint(list, data) {
  list.textContent = "";

  const summary = document.createElement("p");
  summary.className = "health-summary muted";
  const { fallback = 0, off = 0 } = data.summary || {};
  summary.textContent =
    fallback || off
      ? `${fallback + off} of ${data.checks.length} could work better. Everything below still works — this is what it is settling for.`
      : "Everything is on its best setting.";
  list.append(summary);

  // Anything settling for less goes first: it is the reason to open this page.
  const order = { fallback: 0, off: 1, best: 2 };
  for (const check of [...data.checks].sort(
    (a, b) => (order[a.state] ?? 3) - (order[b.state] ?? 3),
  )) {
    list.append(checkRow(check));
  }
}
