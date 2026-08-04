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

export async function renderHealth(els, { force = false } = {}) {
  const list = els?.healthList;
  if (!list) return;
  // Each visit would otherwise spawn a Python process to ask the same
  // questions; the answers only change when something is installed.
  if (loaded && !force) return;

  const last = remembered();
  if (last?.checks?.length) {
    paint(list, last);
  } else {
    list.textContent = "";
    const pending = document.createElement("p");
    pending.className = "muted";
    pending.textContent = "Checking…";
    list.append(pending);
  }

  let data = null;
  try {
    const res = await fetch(force ? "/api/health?fresh=1" : "/api/health");
    if (res.ok) data = await res.json();
  } catch {
    // handled below
  }

  if (!data?.checks?.length) {
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
