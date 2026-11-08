import test from "node:test";
import assert from "node:assert/strict";

import { glueToWords } from "../public/js/linebreak.mjs";

const w = (text) => ({ word: true, html: `<w>${text}</w>` });
const t = (text) => ({ word: false, text });

// 「我多耐心 請你等著瞧」 wrapped with its 。 alone at the start of a line: each
// word is an inline-block, and a browser breaks beside one where Chinese
// line-breaking wouldn't.
test("a full stop stays with the word before it", () => {
  assert.equal(glueToWords([w("等著"), w("瞧"), t("。")]), '<w>等著</w><span class="nobreak"><w>瞧</w>。</span>');
});

test("a comma and a closing quote go with their word; the space after stays free", () => {
  assert.equal(
    glueToWords([w("你好"), t("，」 "), w("再見")]),
    '<span class="nobreak"><w>你好</w>，」</span> <w>再見</w>',
  );
});

test("an opening quote goes with the word after it", () => {
  assert.equal(
    glueToWords([w("他說"), t("：「"), w("好")]),
    '<span class="nobreak"><w>他說</w>：</span><span class="nobreak">「<w>好</w></span>',
  );
});

test("punctuation with no word beside it, and spaces, are left as they are", () => {
  assert.equal(glueToWords([t("「"), t("♫ ")]), "「♫ ");
  assert.equal(glueToWords([w("我"), t(" "), w("你")]), "<w>我</w> <w>你</w>");
});

test("text is escaped", () => {
  assert.equal(glueToWords([w("a"), t("<b>")]), "<w>a</w>&lt;b&gt;");
});
