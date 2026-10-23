// "Use on phone": one button that ends at a QR code your phone can scan.
//
// The phone opens Stele from this computer through Tailscale — a private
// network between the reader's own devices (server/tailscale.mjs). Pressing
// the button asks the server where things stand and does whatever is still
// missing, in order: install Tailscale → get it running → sign in → share
// this app on the tailnet → show the address as a QR code. When everything is
// ready, which is the usual case after the first time, the QR code is the
// first thing shown.
//
// Opened *on* the phone (through the ts.net address), the button is hidden:
// you're already there. Settings → "Use on your phone" shows the same status,
// and is where sharing is switched off — from the computer only.

import { api } from "./backend.mjs";
import { qrSvg } from "./qr.mjs";

const DOWNLOAD = "https://tailscale.com/download";
// Tailscale's own page for making an account (or signing in to one).
const SIGN_UP = "https://login.tailscale.com/start";
const POLL_MS = 3000;

let els = null;
let poll = null;
let ticket = 0;

const onThisComputer = () => ["localhost", "127.0.0.1", "[::1]", "::1"].includes(location.hostname);

async function getStatus() {
  const res = await api("/api/tailscale");
  // An old server without this endpoint answers 405 until it's restarted.
  if (res.status === 405) throw new Error("Restart Stele so it picks up this feature, then try again.");
  if (!res.ok) throw new Error("The computer didn't answer.");
  return res.json();
}

async function act(action) {
  const res = await api("/api/tailscale", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action }),
  });
  return res.json().catch(() => ({ ok: false, error: "The computer didn't answer." }));
}

// --- Building blocks --------------------------------------------------------
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (v != null && v !== false) el.setAttribute(k, v === true ? "" : v);
  }
  for (const child of children.flat()) if (child != null && child !== false) el.append(child);
  return el;
}

function copyButton(text, label = "Copy") {
  const button = h("button", { type: "button", class: "health-copy" }, label);
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(text);
      button.textContent = "Copied";
      setTimeout(() => (button.textContent = label), 1500);
    } catch {
      button.textContent = "Select it";
    }
  });
  return button;
}

// A command for a terminal, as on Settings → What's running.
const command = (text) =>
  h("div", { class: "health-fix" }, h("span", { class: "health-fix-label" }, "Run"), h("code", {}, text), copyButton(text));

const button = (label, onclick) => h("button", { type: "button", onclick }, label);

// A link that looks like a button: it leaves for Tailscale's site, so it opens
// a new tab and the window here stays where it was.
const linkButton = (label, href) =>
  h("a", { class: "phone-link-button", href, target: "_blank", rel: "noopener noreferrer" }, label);

const checkAgain = () => button("Check again", () => run());

function show(...nodes) {
  // Steps add optional parts as `cond && node`; a skipped one must not reach
  // the page, where replaceChildren would write it out as "undefined".
  els.body.replaceChildren(...nodes.filter(Boolean));
}

function stopPolling() {
  clearInterval(poll);
  poll = null;
}

// Waiting on something done outside the app (signing in in another tab):
// look again every few seconds and carry on by itself once it's done.
function pollUntil(ready) {
  stopPolling();
  poll = setInterval(async () => {
    if (!els.dialog.open) return stopPolling();
    try {
      if (ready(await getStatus())) {
        stopPolling();
        run();
      }
    } catch {
      // Keep waiting; the next tick may answer.
    }
  }, POLL_MS);
}

// --- The steps ---------------------------------------------------------------
function showInstall() {
  show(
    h("p", {}, "Your phone reaches this computer through ", h("strong", {}, "Tailscale"), ", a free private network between your own devices. Nothing goes on the public internet."),
    h("div", { class: "phone-start" }, linkButton("Create a free Tailscale account ↗", SIGN_UP),
      h("p", { class: "muted" }, "Already have one? The same page signs you in.")),
    h(
      "ol",
      { class: "phone-steps" },
      h("li", {}, h("a", { href: DOWNLOAD, target: "_blank", rel: "noopener noreferrer" }, "Install Tailscale on this computer ↗"), " and sign in with that account."),
      h("li", {}, "Install the ", h("strong", {}, "Tailscale"), " app on your phone from its app store, and sign in with the ", h("strong", {}, "same account"), "."),
    ),
    h("div", { class: "settings-actions" }, button("I've done it — check again", () => run())),
  );
}

function showNotRunning(status) {
  show(
    h("p", {}, "Tailscale is installed on this computer, but it isn't running."),
    status.platform === "linux"
      ? command("sudo systemctl enable --now tailscaled")
      : h("p", { class: "muted" }, "Open the Tailscale app on this computer."),
    h("div", { class: "settings-actions" }, checkAgain()),
  );
}

function showSignIn(note = "") {
  show(
    h("p", {}, "Tailscale is installed. Sign in to connect this computer to your devices."),
    note && h("p", { class: "muted" }, note),
    h("p", { class: "muted" }, "No account yet? ", h("a", { href: SIGN_UP, target: "_blank", rel: "noopener noreferrer" }, "Create one free ↗"), " — then come back and sign in."),
    h(
      "div",
      { class: "settings-actions" },
      button("Sign in to Tailscale", async (event) => {
        const pressed = event.currentTarget;
        pressed.disabled = true;
        pressed.textContent = "Opening…";
        const result = await act("signin");
        if (!result.ok) return showProblem(result);
        if (result.link) window.open(result.link, "_blank", "noopener");
        show(
          h("p", {}, "Finish signing in in the tab that opened."),
          result.link && h("p", { class: "muted" }, "No tab? ", h("a", { href: result.link, target: "_blank", rel: "noopener noreferrer" }, "Open the sign-in page ↗")),
          h("p", { class: "muted phone-waiting" }, "This continues by itself once you're signed in…"),
        );
        pollUntil((s) => s.signedIn);
      }),
      checkAgain(),
    ),
  );
}

function showHttps() {
  show(
    h("p", {}, "One setting to switch on: your phone needs a secure ", h("code", {}, "https://"), " address, and Tailscale only gives one when its HTTPS certificates are on."),
    h(
      "ol",
      { class: "phone-steps" },
      h("li", {}, h("a", { href: "https://login.tailscale.com/admin/dns", target: "_blank", rel: "noopener noreferrer" }, "Open Tailscale's DNS settings ↗")),
      h("li", {}, "Turn on ", h("strong", {}, "MagicDNS"), " and ", h("strong", {}, "HTTPS Certificates"), "."),
    ),
    h("div", { class: "settings-actions" }, button("I've done it — continue", () => run())),
  );
  // Back here with it switched on, carry on without another press.
  pollUntil((s) => s.httpsReady || !s.signedIn);
}

function showProblem(result) {
  stopPolling();
  show(
    h("p", { class: "phone-problem" }, result.error || "Something went wrong."),
    result.fix && command(result.fix),
    result.fix && h("p", { class: "muted" }, "Then press Check again."),
    result.link && h("p", {}, h("a", { href: result.link, target: "_blank", rel: "noopener noreferrer" }, "Open Tailscale's settings ↗")),
    h("div", { class: "settings-actions" }, checkAgain()),
  );
}

function deviceList(peers) {
  if (!peers?.length) {
    return h("p", { class: "muted" }, "No other device is on your Tailscale yet.");
  }
  const online = peers.filter((p) => p.online);
  return h(
    "div",
    { class: "phone-devices" },
    online.length ? null : h("p", { class: "muted" }, "None of your devices is connected right now — open the Tailscale app on your phone."),
    h(
      "ul",
      {},
      peers.slice(0, 6).map((p) =>
        h("li", { class: p.online ? "online" : "" }, h("span", { class: "phone-dot", "aria-hidden": "true" }), `${p.name}`, h("span", { class: "muted" }, p.online ? "· online" : "· offline")),
      ),
    ),
  );
}

// No phone connected yet, so the big code would only reach "site can't be
// reached". Getting the app comes first: a small second code the phone can
// scan for Tailscale's download page (it picks the right store itself), and
// the account page, for whoever has no account to sign in with on the phone.
function getTheApp() {
  const qr = h("div", { class: "phone-qr phone-qr-small", role: "img", "aria-label": `QR code for ${DOWNLOAD}` });
  qr.innerHTML = qrSvg(DOWNLOAD);
  return h(
    "div",
    { class: "phone-get-app" },
    h("h3", {}, "Phone not on Tailscale yet?"),
    h(
      "div",
      { class: "phone-get-app-row" },
      qr,
      h(
        "ol",
        { class: "phone-steps" },
        h("li", {}, "Scan this small code with your phone to get the ", h("strong", {}, "Tailscale"), " app."),
        h("li", {}, "Sign in on the phone with the ", h("strong", {}, "same account"), " as this computer."),
        h("li", {}, "Scan the big code above."),
      ),
    ),
    h("div", { class: "phone-start" }, linkButton("Create a free Tailscale account ↗", SIGN_UP),
      h("p", { class: "muted" }, "No account yet? Make one here on the computer. Already have one? The same page signs you in.")),
  );
}

function showReady(status) {
  stopPolling();
  const qr = h("div", { class: "phone-qr", role: "img", "aria-label": `QR code for ${status.url}` });
  qr.innerHTML = qrSvg(status.url);
  const phoneOnline = (status.peers || []).some((p) => p.online);
  show(
    qr,
    h("div", { class: "phone-url" }, h("code", {}, status.url.replace(/\/$/, "")), copyButton(status.url, "Copy link")),
    h("p", { class: "phone-hint" }, "Open the ", h("strong", {}, "Tailscale"), " app on your phone first, then scan this with the camera."),
    deviceList(status.peers),
    !phoneOnline && getTheApp(),
  );
  // Waiting on the phone: once it shows up online, redraw without the help.
  if (!phoneOnline) pollUntil((s) => (s.peers || []).some((p) => p.online));
}

// Look, then do the next thing that's missing.
async function run() {
  const mine = ++ticket;
  stopPolling();
  show(h("p", { class: "muted phone-waiting" }, "Checking Tailscale…"));
  let status;
  try {
    status = await getStatus();
  } catch (error) {
    return showProblem({ error: error.message });
  }
  if (mine !== ticket) return;
  if (!status.installed) return showInstall();
  if (!status.running) return showNotRunning(status);
  if (!status.signedIn) return showSignIn(status.state === "Stopped" ? "Tailscale is switched off on this computer — signing in turns it back on." : "");
  if (status.shared) return showReady(status);
  if (status.here !== "computer") {
    return showProblem({ error: "Stele isn't shared on Tailscale. Turn it on from the computer it runs on." });
  }
  if (!status.httpsReady) return showHttps();
  if (status.servingOther) {
    return showProblem({ error: `Something else is already shared at ${status.url}, so Stele won't replace it.` });
  }
  show(h("p", { class: "muted phone-waiting" }, "Making Stele reachable from your devices…"));
  const result = await act("share");
  if (mine !== ticket) return;
  if (result.ok && result.status?.shared) return showReady(result.status);
  showProblem(result);
}

export function openPhone() {
  if (!els) return;
  if (!els.dialog.open) els.dialog.showModal();
  run();
}

// Settings → "Use on your phone": the same facts, and the off switch.
export async function renderPhoneSettings() {
  const out = document.querySelector("#phoneSettingsStatus");
  const stop = document.querySelector("#phoneSettingsStop");
  const open = document.querySelector("#phoneSettingsOpen");
  if (!out) return;
  out.textContent = "Checking Tailscale…";
  stop.hidden = true;
  let s;
  try {
    s = await getStatus();
  } catch (error) {
    out.textContent = error.message;
    return;
  }
  const online = (s.peers || []).filter((p) => p.online).map((p) => p.name);
  if (s.here !== "computer") {
    out.textContent = "You're using Stele from another device through Tailscale right now.";
    open.hidden = true;
  } else if (!s.installed) out.textContent = "Tailscale isn't installed yet. “Set up” walks you through it.";
  else if (!s.running) out.textContent = "Tailscale is installed but not running.";
  else if (!s.signedIn) out.textContent = "Tailscale is installed but not signed in.";
  else if (!s.shared) out.textContent = "Stele isn't shared on Tailscale yet.";
  else {
    out.textContent = `Shared at ${s.url} — only your own devices can open it.` +
      (online.length ? ` Online now: ${online.join(", ")}.` : " None of your other devices is online right now.");
    stop.hidden = false;
  }
  open.textContent = s.shared ? "Show QR code" : "Set up";
}

export function setupPhone() {
  els = {
    dialog: document.querySelector("#phoneDialog"),
    body: document.querySelector("#phoneBody"),
    button: document.querySelector("#phoneButton"),
  };
  if (!els.dialog) return;
  // On the phone already: nothing to open.
  if (!onThisComputer()) els.button.hidden = true;
  els.button.addEventListener("click", openPhone);
  els.dialog.addEventListener("close", () => {
    stopPolling();
    ticket++;
  });

  document.querySelector("#phoneSettingsOpen")?.addEventListener("click", openPhone);
  document.querySelector("#phoneSettingsStop")?.addEventListener("click", async (event) => {
    // Kept: event.currentTarget is null again once the await below returns.
    const stop = event.currentTarget;
    if (!confirm("Stop sharing Stele on Tailscale? Your phone won't be able to open it until you share it again.")) return;
    stop.disabled = true;
    const result = await act("unshare");
    stop.disabled = false;
    if (!result.ok) alert(`${result.error || "Tailscale refused."}${result.fix ? `\n\nRun: ${result.fix}` : ""}`);
    renderPhoneSettings();
  });
}
