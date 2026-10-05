import test from "node:test";
import assert from "node:assert/strict";

import { ytdlp403Message } from "../server/import.mjs";

test("a 403 from a non-venv yt-dlp says it's out of date and names npm run sync", () => {
  const message = ytdlp403Message("ERROR: HTTP Error 403: Forbidden", false);
  assert.match(message, /out of date/);
  assert.match(message, /npm run sync/);
  assert.doesNotMatch(message, /temporary/);
});

test("yt-dlp's own age warning counts as out of date, even from the venv", () => {
  const message = ytdlp403Message(
    "WARNING: Your yt-dlp version (2026.03.17) is older than 90 days!\nERROR: HTTP Error 403: Forbidden",
    true,
  );
  assert.match(message, /out of date/);
  assert.match(message, /npm run sync/);
});

test("a 403 from a current venv yt-dlp is called temporary but still offers npm run sync", () => {
  const message = ytdlp403Message("ERROR: HTTP Error 403: Forbidden", true);
  assert.match(message, /temporary/);
  assert.match(message, /npm run sync/);
  assert.match(message, /cookies/);
});
