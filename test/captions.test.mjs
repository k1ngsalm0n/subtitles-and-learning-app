import test from "node:test";
import assert from "node:assert/strict";

import {
  cleanCaptions,
  alignTranslationByTime,
  dedupeContinuationLines,
  markUnintelligible,
  mergeCaptionSpeech,
  paceCaptionLines,
  UNINTELLIGIBLE,
} from "../server/captions.mjs";

// A trimmed slice of a real YouTube auto-caption VTT (rolling format). Built
// from an array so the whitespace-only rows — which YouTube emits as a single
// space, not an empty line — stay explicit and survive editing. Cues are
// separated by genuinely empty lines ("").
const SP = " ";
const ROLLING_VTT = [
  "WEBVTT",
  "Kind: captions",
  "Language: ko",
  "",
  "00:00:03.159 --> 00:00:10.190 align:start position:0%",
  SP,
  "일단<00:00:03.360><c> 기름이</c><00:00:03.679><c> 많으니까</c>",
  "",
  "00:00:10.190 --> 00:00:10.200 align:start position:0%",
  SP,
  SP,
  "",
  "00:00:10.200 --> 00:00:12.190 align:start position:0%",
  SP,
  "&gt;&gt; 야<00:00:10.320><c> 근데</c><00:00:10.480><c> 잘했다.</c>",
  "",
  "00:00:12.190 --> 00:00:12.200 align:start position:0%",
  "&gt;&gt; 야 근데 잘했다.",
  SP,
  "",
  "00:00:12.200 --> 00:00:13.030 align:start position:0%",
  "&gt;&gt; 야 근데 잘했다.",
  "&gt;&gt; 아",
  "",
].join("\n");

test("rolling captions collapse to one cue per spoken line", () => {
  const srt = cleanCaptions(ROLLING_VTT);
  const blocks = srt.trim().split("\n\n");
  const texts = blocks.map((b) => b.split("\n").slice(2).join(" "));
  assert.deepEqual(texts, ["일단 기름이 많으니까", "야 근데 잘했다.", "아"]);
});

test("rolling output strips markup, entities and >> markers", () => {
  const srt = cleanCaptions(ROLLING_VTT);
  assert.ok(!srt.includes(">>"), "speaker markers should be gone");
  assert.ok(!srt.includes("<c>"), "karaoke spans should be gone");
  assert.ok(!srt.includes("&gt;"), "entities should be decoded/removed");
  assert.ok(!/<\d{2}:\d{2}:\d{2}/.test(srt), "word-timing tags should be gone");
});

test("rolling cue end time runs until the next line begins", () => {
  const srt = cleanCaptions(ROLLING_VTT);
  const first = srt.trim().split("\n\n")[0].split("\n")[1];
  // "일단…" is introduced at 3.159 and the next line starts at 10.200.
  assert.equal(first, "00:00:03,159 --> 00:00:10,200");
});

test("plain SRT keeps its original timing", () => {
  const plain = `1
00:00:01,000 --> 00:00:02,000
Hello there.

2
00:00:05,000 --> 00:00:06,500
General Kenobi.
`;
  const out = cleanCaptions(plain).trim().split("\n\n");
  assert.equal(out[0].split("\n")[1], "00:00:01,000 --> 00:00:02,000");
  assert.equal(out[1].split("\n")[1], "00:00:05,000 --> 00:00:06,500");
});

test("plain track drops exact consecutive duplicate cues", () => {
  const plain = `1
00:00:01,000 --> 00:00:02,000
Same line.

2
00:00:02,000 --> 00:00:03,000
Same line.

3
00:00:03,000 --> 00:00:04,000
Different.
`;
  const texts = cleanCaptions(plain)
    .trim()
    .split("\n\n")
    .map((b) => b.split("\n")[2]);
  assert.deepEqual(texts, ["Same line.", "Different."]);
});

test("empty or text-free input yields empty string", () => {
  assert.equal(cleanCaptions(""), "");
  assert.equal(cleanCaptions("WEBVTT\n\n"), "");
});

const SRC = `1
00:00:01,000 --> 00:00:03,000
원래 문장 하나.

2
00:00:03,000 --> 00:00:05,000
두 번째 문장.
`;

test("a matching translation track aligns 1:1 to the source cues", () => {
  const tr = `1
00:00:01,000 --> 00:00:03,000
First original sentence.

2
00:00:03,000 --> 00:00:05,000
Second sentence.
`;
  const out = alignTranslationByTime(SRC, tr);
  const blocks = out.trim().split("\n\n");
  assert.equal(blocks.length, 2, "one translation cue per source cue");
  // Indices and timings mirror the source so the frontend pairs them by index.
  assert.equal(blocks[0].split("\n")[0], "1");
  assert.equal(blocks[0].split("\n")[1], "00:00:01,000 --> 00:00:03,000");
  assert.equal(blocks[0].split("\n")[2], "First original sentence.");
  assert.equal(blocks[1].split("\n")[2], "Second sentence.");
});

test("translation cues are assigned by maximum time overlap, not order", () => {
  // The translation is timed differently; each line still lands on the source
  // cue it overlaps most.
  const tr = `1
00:00:03,200 --> 00:00:04,800
Second sentence.

2
00:00:00,900 --> 00:00:02,900
First original sentence.
`;
  const out = alignTranslationByTime(SRC, tr).trim().split("\n\n");
  assert.equal(out[0].split("\n")[2], "First original sentence.");
  assert.equal(out[1].split("\n")[2], "Second sentence.");
});

test("source cues with no overlapping translation stay blank but are kept", () => {
  const tr = `1
00:00:03,000 --> 00:00:05,000
Only the second one.
`;
  // Split the way the frontend's parseSubtitle does (/\n{2,}/), so an empty-text
  // cue's extra blank line doesn't read as a separate block.
  const out = alignTranslationByTime(SRC, tr).trim().split(/\n{2,}/);
  assert.equal(out.length, 2, "all source cues are preserved for index alignment");
  assert.equal(out[0].split("\n").slice(2).join(" ").trim(), "");
  assert.equal(out[1].split("\n").slice(2).join(" ").trim(), "Only the second one.");
});

test("mergeCaptionSpeech: sparse speech -> captions lead, speech fills gaps", () => {
  // Raw-footage video: captions carry the content, only a little real speech.
  const captions = [
    { start: 10, end: 16, text: "字幕寫的第一句話" },
    { start: 30, end: 36, text: "字幕寫的第二句話" },
  ];
  const speech = [
    { start: 0, end: 4, text: "現場有人喊了一句話" }, // gap -> kept
    { start: 11, end: 15, text: "與字幕重疊的雜音" }, // captioned -> dropped
  ];
  const merged = mergeCaptionSpeech(captions, speech);
  assert.deepEqual(
    merged.map((s) => s.text),
    ["現場有人喊了一句話", "字幕寫的第一句話", "字幕寫的第二句話"],
  );
});

test("mergeCaptionSpeech: continuous narration -> speech leads, captions fill gaps", () => {
  // Narrated news: the anchor talks over muted clips whose captions say
  // something else. Speech covers >50% of the span, so it must win overlaps —
  // otherwise the subtitles stop matching the audio.
  const speech = [
    { start: 0, end: 10, text: "主播的旁白內容第一句話說個不停" },
    { start: 10, end: 20, text: "主播的旁白繼續說明現場的情況喔" },
    { start: 26, end: 34, text: "主播收尾總結整段新聞內容的旁白" },
  ];
  const captions = [
    { start: 2, end: 9, text: "被消音影片自己的字幕" }, // overlaps narration -> dropped
    { start: 20, end: 25, text: "受訪者說的話字幕有寫" }, // narration gap -> kept
  ];
  const merged = mergeCaptionSpeech(captions, speech);
  assert.deepEqual(
    merged.map((s) => s.start),
    [0, 10, 20, 26],
  );
  assert.ok(merged.some((s) => s.text === "受訪者說的話字幕有寫"));
  assert.ok(!merged.some((s) => s.text === "被消音影片自己的字幕"));
});

test("mergeCaptionSpeech clips gap-fill to the gap so lines never overlap", () => {
  // The reported bug: anchor speaks 0–4.6 s, a clip caption is on screen
  // 0–12 s. Kept whole, the caption fights the narration for the highlight
  // while the anchor talks; it must start when the narration ends.
  const speech = [
    { start: 0, end: 3, text: "主播的旁白第一句話講了很多" },
    { start: 3, end: 4.6, text: "而是為了躲颱風跑上高架橋" },
    { start: 13.5, end: 20, text: "主播繼續說明溫州高架橋的情況" },
    { start: 20, end: 26, text: "旁白說明大樓停車場車位掃空" },
  ];
  const captions = [{ start: 0, end: 12, text: "被消音短片的字幕內容" }];
  const merged = mergeCaptionSpeech(captions, speech);
  const caption = merged.find((s) => s.text === "被消音短片的字幕內容");
  assert.ok(caption, "caption survives as gap fill");
  assert.equal(caption.start, 4.6);
  assert.equal(caption.end, 12);
  // Strictly non-overlapping timeline.
  const sorted = merged.map((s) => [s.start, s.end]);
  for (let i = 1; i < sorted.length; i++) {
    assert.ok(sorted[i][0] >= sorted[i - 1][1] - 1e-9, `no overlap at ${i}`);
  }
});

test("mergeCaptionSpeech drops stretched hallucinations before deciding", () => {
  // A classic Whisper silence hallucination: a few characters over 23 s. It
  // must neither appear in the output nor push the video into speech-led mode.
  const captions = [{ start: 0, end: 40, text: "整段都有的字幕內容" }];
  const speech = [{ start: 5, end: 28, text: "中文字幕 李宗盛" }];
  const merged = mergeCaptionSpeech(captions, speech);
  assert.deepEqual(merged.map((s) => s.text), ["整段都有的字幕內容"]);
});

test("paceCaptionLines spreads a long static block line by line", () => {
  const seg = {
    start: 4.6,
    end: 12,
    caption: true,
    text: "第一行的字\n第二行的字\n第三行的字\n第四行的字",
  };
  const paced = paceCaptionLines(seg);
  assert.equal(paced.length, 4);
  assert.equal(paced[0].start, 4.6);
  assert.equal(paced.at(-1).end, 12);
  for (let i = 1; i < paced.length; i++) {
    assert.equal(paced[i].start, paced[i - 1].end, "contiguous lines");
  }
  // Equal-length lines split the window evenly.
  assert.ok(Math.abs(paced[0].end - paced[0].start - 1.85) < 0.01);
  assert.deepEqual(
    paced.map((s) => s.text),
    ["第一行的字", "第二行的字", "第三行的字", "第四行的字"],
  );
});

test("paceCaptionLines leaves short or single-line blocks alone", () => {
  const short = { start: 0, end: 5, text: "上一行\n下一行" };
  assert.deepEqual(paceCaptionLines(short), [short]);
  const single = { start: 0, end: 20, text: "只有一行但顯示很久的字幕" };
  assert.deepEqual(paceCaptionLines(single), [single]);
});

test("mergeCaptionSpeech with no captions keeps all speech, and vice versa", () => {
  const speech = [{ start: 0, end: 2, text: "有人說話" }];
  assert.deepEqual(mergeCaptionSpeech([], speech), speech);
  const captions = [{ start: 0, end: 2, text: "字幕" }];
  assert.deepEqual(mergeCaptionSpeech(captions, []), captions);
});

test("mergeCaptionSpeech drops non-Chinese and interjection-only speech", () => {
  const captions = [{ start: 0, end: 30, text: "整段都有的字幕內容在這裡" }];
  const speech = [
    { start: 31, end: 34, text: "26、 27、 28、 30、 32、 34" }, // number hallucination
    { start: 35, end: 35.5, text: "哇" }, // lone interjection
    { start: 36, end: 39, text: "這句是真的有人在說話" }, // real -> kept
  ];
  const merged = mergeCaptionSpeech(captions, speech);
  assert.deepEqual(
    merged.map((s) => s.text),
    ["整段都有的字幕內容在這裡", "這句是真的有人在說話"],
  );
});

test("mergeCaptionSpeech drops known Whisper hallucination phrases", () => {
  const captions = [{ start: 0, end: 40, text: "整段都有的字幕內容在這裡" }];
  const speech = [
    // Streaming-site watermark reproduced over 22 s of storm noise — passes
    // the speed and CJK filters, must be caught by the phrase blacklist.
    { start: 47, end: 69, text: "优优独播剧场——YoYo Television Series Exclusive 优优独播剧场" },
    { start: 70, end: 73, text: "這句是真的有人在說話" },
  ];
  const merged = mergeCaptionSpeech(captions, speech);
  assert.ok(!merged.some((s) => s.text.includes("独播剧场")));
  assert.ok(merged.some((s) => s.text === "這句是真的有人在說話"));
});

test("dedupeContinuationLines shows repeated static lines only once", () => {
  const block =
    "台风“巴威”逼近浙江临海车主自发\n把车开上还未通车的立交桥避险\n这是迎战“利奇马”换来的生存智慧";
  const segments = [
    { start: 6, end: 8, caption: true, text: `${block}\n颱風巴威逼近浙江台州臨海` },
    // OCR jitter: 、 appears in one reading of the repeated line.
    { start: 8, end: 10, caption: true, text: `${block.replace("台风“巴威”", "台风、“巴威”")}\n車主們自發集體把車開上高架橋避險` },
    { start: 10, end: 12, caption: true, text: `${block}\n車輛沿道路兩側整齊停放` },
  ];
  const out = dedupeContinuationLines(segments);
  assert.equal(out[0].text.split("\n").length, 4); // first block complete
  assert.equal(out[1].text, "車主們自發集體把車開上高架橋避險");
  assert.equal(out[2].text, "車輛沿道路兩側整齊停放");
});

test("dedupeContinuationLines: gaps reset, speech untouched, empty repeats vanish", () => {
  const segments = [
    { start: 0, end: 4, caption: true, text: "字幕的第一句話\n持續顯示的標題" },
    { start: 4, end: 6, text: "主播說話的內容不參與去重" }, // whisper, no caption flag
    { start: 6, end: 8, caption: true, text: "持續顯示的標題" }, // nothing new -> dropped
    { start: 20, end: 24, caption: true, text: "持續顯示的標題" }, // after a gap -> kept
  ];
  const out = dedupeContinuationLines(segments);
  assert.deepEqual(
    out.map((s) => s.text),
    ["字幕的第一句話\n持續顯示的標題", "主播說話的內容不參與去重", "持續顯showing".replace("showing", "示的標題")],
  );
  assert.equal(out.at(-1).start, 20);
});

test("markUnintelligible replaces garbled speech and merges neighbours", () => {
  const segments = [
    { start: 0, end: 4.6, text: "高架橋上停滿轎車", logprob: -0.16 },
    { start: 47.1, end: 48.9, text: "这种感情没有顿顿的", logprob: -1.23 },
    { start: 49.8, end: 54.3, text: "我都要去拿裤子", logprob: -1.23 },
    { start: 58.6, end: 59.9, text: "还给你一个", logprob: -1.23 },
    { start: 70, end: 72, text: "沒有信心分數的舊格式" }, // no logprob -> untouched
  ];
  const out = markUnintelligible(segments);
  assert.deepEqual(
    out.map((s) => [s.start, s.end, s.text]),
    [
      [0, 4.6, "高架橋上停滿轎車"],
      [47.1, 54.3, UNINTELLIGIBLE], // 47.1-48.9 and 49.8-54.3 merged
      [58.6, 59.9, UNINTELLIGIBLE], // 4.3 s gap -> separate
      [70, 72, "沒有信心分數的舊格式"],
    ],
  );
});

test("mergeCaptionSpeech keeps unintelligible placeholders despite slow cps", () => {
  const speech = [{ start: 47.1, end: 63.4, text: UNINTELLIGIBLE }];
  const merged = mergeCaptionSpeech([], speech);
  assert.deepEqual(merged, speech);
});

test("a mostly-covered caption still surfaces in its trailing gap", () => {
  // The reported bug: narration ends at 4.6, the man starts talking at ~5,
  // but the caption block (on screen 0-6, 77% covered) was discarded outright
  // — leaving dead air until the next display state at 6. It must clip to
  // 4.6-6 instead of vanishing.
  const speech = [
    { start: 0, end: 3, text: "主播的旁白第一句話講了很多內容" },
    { start: 3, end: 4.6, text: "而是為了躲颱風跑上高架橋去" },
    { start: 6.5, end: 12, text: "主播繼續說明現場的最新情況喔" },
  ];
  const captions = [{ start: 0, end: 6, text: "短片畫面上的字幕內容" }];
  const merged = mergeCaptionSpeech(captions, speech);
  const caption = merged.find((s) => s.text === "短片畫面上的字幕內容");
  assert.ok(caption, "clipped remainder survives");
  assert.equal(caption.start, 4.6);
  assert.equal(caption.end, 6);
});

test("a clipped unreadable glimpse folds into the next matching state", () => {
  const block = "第一行摘要\n第二行摘要\n第三行摘要\n第四行摘要";
  const segments = [
    { start: 4.6, end: 6, caption: true, clipped: true, text: `${block}\n多餘的標題一行` },
    { start: 6, end: 8, caption: true, text: `${block}\n輪播的字幕第一句` },
    { start: 8, end: 10, caption: true, text: `${block}\n輪播的字幕第二句` },
  ];
  const out = dedupeContinuationLines(segments);
  assert.equal(out[0].start, 4.6, "next state extends back over the glimpse");
  assert.ok(out[0].text.includes("第一行摘要"));
  assert.ok(out[0].text.includes("輪播的字幕第一句"));
  assert.equal(out[1].text, "輪播的字幕第二句");
});

test("a genuinely short caption is never absorbed", () => {
  // 巨浪拍向窗戶 shows for 2 s then is replaced — a real display state, not a
  // clipped artifact; it must survive even though the next state shares its
  // other lines.
  const segments = [
    { start: 0, end: 2, caption: true, text: "巨浪拍向窗戶\n標題一\n標題二" },
    { start: 2, end: 5, caption: true, text: "屋頂也全是海水\n標題一\n標題二" },
  ];
  const out = dedupeContinuationLines(segments);
  assert.ok(out[0].text.includes("巨浪拍向窗戶"));
  assert.equal(out[1].text, "屋頂也全是海水");
});
