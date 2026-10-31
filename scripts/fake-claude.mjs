#!/usr/bin/env node
// A stand-in for Claude Code's headless mode (`claude -p … --output-format
// json`), so the "Claude (your subscription)" provider can be tested without
// Claude Code or a Claude plan. Point STELE_CLAUDE_BIN at this file.
// FAKE_CLAUDE=signedout answers like a signed-out Claude Code; =fenced wraps
// the JSON in a code fence, as the real one sometimes does. It also acts out
// `--version`, `auth status --json` and `auth login` (which prints a link and
// waits for a code; "good-code" signs in). With FAKE_CLAUDE_DIR set, signing
// in is remembered there, as Claude Code's own config would remember it.
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const marker = process.env.FAKE_CLAUDE_DIR ? join(process.env.FAKE_CLAUDE_DIR, "signed-in") : null;
const signedIn = () => (marker ? existsSync(marker) : process.env.FAKE_CLAUDE !== "signedout");

if (args[0] === "--version") {
  console.log("9.9.9 (Claude Code)");
  process.exit(0);
}
if (args[0] === "auth" && args[1] === "status") {
  console.log(JSON.stringify(signedIn()
    ? { loggedIn: true, authMethod: "claude.ai", email: "reader@example.com", subscriptionType: "pro" }
    : { loggedIn: false, authMethod: "none" }));
  process.exit(0);
}
if (args[0] === "auth" && args[1] === "login") {
  console.log("Opening browser to sign in…");
  console.log("If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&state=fake");
  process.stdout.write("Paste code here if prompted > ");
  createInterface({ input: process.stdin }).once("line", (code) => {
    if (code.trim() === "good-code") {
      if (marker) writeFileSync(marker, "1");
      console.log("Login successful.");
      process.exit(0);
    }
    console.error("Invalid code.");
    process.exit(1);
  });
} else {
  // Anything else is a `-p` question, answered below.
const arg = (name) => args[args.indexOf(name) + 1];
const prompt = arg("-p") || "";
const system = arg("--system-prompt") || "";
const mode = process.env.FAKE_CLAUDE || "";
const reply = (result, isError = false) =>
  console.log(JSON.stringify({ type: "result", is_error: isError, result, num_turns: 1 }));

if (mode === "signedout") {
  reply("Not logged in · Please run /login", true);
} else if (/subtitle translator/.test(system)) {
  // Numbered lines in, a number → text object out.
  const out = {};
  for (const line of prompt.split("\n")) {
    const m = /^(\d+)\. (.*)$/.exec(line);
    if (m) out[m[1]] = `[en] ${m[2]}`;
  }
  const json = JSON.stringify(out);
  reply(mode === "fenced" ? "```json\n" + json + "\n```" : json);
} else if (/language tutor/.test(system)) {
  const word = /Word: (.*)/.exec(prompt)?.[1] || "";
  reply(JSON.stringify({ pronunciation: "lěng'ào", meaning: `meaning of ${word}`, explanation: "from the fake", partOfSpeech: "adjective" }));
} else {
  reply("OK");
}
}
