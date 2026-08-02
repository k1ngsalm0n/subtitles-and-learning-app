import test from "node:test";
import assert from "node:assert/strict";

import { looksChinese, transcriptIsChinese } from "../public/js/zhscript.mjs";

test("looksChinese spots Han characters", () => {
  assert.ok(looksChinese("头发很长"));
  assert.ok(looksChinese("這是繁體"));
  // Mixed lines count — a Chinese subtitle often carries a number or a name.
  assert.ok(looksChinese("1911年8月1日投入舰队服役。"));
});

test("looksChinese leaves other scripts alone", () => {
  assert.equal(looksChinese("Hello world"), false);
  assert.equal(looksChinese("こんにちは"), false); // kana only
  assert.equal(looksChinese("안녕하세요"), false);
  assert.equal(looksChinese(""), false);
  assert.equal(looksChinese(null), false);
});

// The toggle is a Chinese control; it shouldn't appear over an English
// transcript that happens to quote one Chinese word.
test("a transcript counts as Chinese only when most of it is", () => {
  const zh = [{ text: "头发很长" }, { text: "计算机网络" }, { text: "很好" }];
  assert.ok(transcriptIsChinese(zh));

  const mostlyEnglish = [
    { text: "The ship was commissioned" },
    { text: "in August 1911" },
    { text: "and served with 舰队" },
  ];
  assert.equal(transcriptIsChinese(mostlyEnglish), false);
});

test("an empty transcript is not Chinese", () => {
  assert.equal(transcriptIsChinese([]), false);
  assert.equal(transcriptIsChinese(null), false);
});

// Japanese uses Han characters too, so a kanji-heavy line will read as Chinese
// here. Conversion is a no-op on text that has no Simplified forms, so the
// cost of being wrong is an unused button, not damaged text.
test("kanji-heavy Japanese is accepted, which conversion makes harmless", () => {
  assert.ok(looksChinese("日本語の勉強"));
});
