// A link to no video stops with yt-dlp's reason, not a JavaScript error.
import { test } from "node:test";
import assert from "node:assert/strict";
import { unavailableReason } from "../server/import.mjs";

test("yt-dlp's reason a video is missing, for the reader", () => {
  assert.equal(
    unavailableReason("WARNING: no impersonate target\nERROR: [youtube] xb_5JkD5S6k: This video is unavailable\n"),
    "This video is unavailable.",
  );
  assert.equal(unavailableReason("ERROR: [youtube] abc: Private video. Sign in if you've been granted access"),
    "Private video. Sign in if you've been granted access.");
  assert.equal(unavailableReason("ERROR: Unsupported URL: https://example.com/x"), "Unsupported URL: https://example.com/x.");
  // Nothing said: the import degrades as before.
  assert.equal(unavailableReason("WARNING: something\n"), "");
  assert.equal(unavailableReason(""), "");
});
