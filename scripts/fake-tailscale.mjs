#!/usr/bin/env node
// A stand-in for the tailscale CLI, so server/tailscale.mjs and the "Use on
// phone" flow can be tested in every state without touching a real tailnet.
// Point STELE_TAILSCALE_BIN at this file. FAKE_TS_STATE picks the state:
//   down        the daemon isn't running
//   needslogin  installed, signed out (`up` prints a sign-in link)
//   nohttps     signed in, HTTPS certificates off (serve refuses)
//   denied      signed in, but this user may not change settings
//   ready       signed in; `serve --bg PORT` shares the app
//   alone       as ready, but no other device on the account
//   phoneoff    as ready, but every other device is offline
// FAKE_TS_DIR keeps the serve config between calls, as tailscaled would; a
// `state` file there overrides FAKE_TS_STATE, so a running sandbox can be
// moved between states without a restart.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const dir = process.env.FAKE_TS_DIR || "/tmp";
const stateFile = join(dir, "state");
const state = (existsSync(stateFile) && readFileSync(stateFile, "utf8").trim()) || process.env.FAKE_TS_STATE || "ready";
const file = join(dir, "fake-tailscale-serve.json");
const args = process.argv.slice(2);
const dns = "laptop.tail-fake.ts.net";
const serve = () => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {});

if (args[0] === "status") {
  if (state === "down") {
    console.error("failed to connect to local tailscaled; it doesn't appear to be running");
    process.exit(1);
  }
  const signedIn = state !== "needslogin";
  console.log(JSON.stringify({
    BackendState: signedIn ? "Running" : "NeedsLogin",
    Self: { DNSName: signedIn ? `${dns}.` : "", HostName: "laptop" },
    CertDomains: signedIn && state !== "nohttps" ? [dns] : null,
    Peer: !signedIn || state === "alone"
      ? {}
      : {
          a: { HostName: "Pixel 11", OS: "android", Online: state !== "phoneoff" },
          b: { HostName: "old-ipad", OS: "iOS", Online: false },
        },
  }));
} else if (args[0] === "serve" && args[1] === "status") {
  console.log(JSON.stringify(serve()));
} else if (args[0] === "serve" && args[1] === "--bg") {
  if (state === "denied") {
    console.error("Access denied: serve config denied. Use 'sudo tailscale serve' or 'sudo tailscale set --operator=$USER'");
    process.exit(1);
  }
  if (state === "nohttps") {
    console.error("Serve is not enabled on your tailnet.\nTo enable, visit:\n\n\thttps://login.tailscale.com/f/serve?node=abc");
    process.exit(1);
  }
  writeFileSync(file, JSON.stringify({
    TCP: { 443: { HTTPS: true } },
    Web: { [`${dns}:443`]: { Handlers: { "/": { Proxy: `http://127.0.0.1:${args[2]}` } } } },
  }));
  console.log(`Available within your tailnet:\n\nhttps://${dns}/\n|-- proxy http://127.0.0.1:${args[2]}`);
} else if (args[0] === "serve" && args[1] === "--https=443" && args[2] === "off") {
  writeFileSync(file, "{}");
} else if (args[0] === "up") {
  if (state === "needslogin") {
    console.error("\nTo authenticate, visit:\n\n\thttps://login.tailscale.com/a/fake123\n");
    // tailscale waits here until the browser sign-in completes.
    setTimeout(() => process.exit(0), 2000);
  }
} else {
  console.error(`fake-tailscale: unhandled ${args.join(" ")}`);
  process.exit(2);
}
