import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "server"))

from ocr_image import mark_chrome, merge_wrapped, split_sentences  # noqa: E402


def line(text, y, height=0.08, x=0.05, width=0.4):
    return {"text": text, "score": 0.99, "box": [x, y, width, height]}


def chrome_of(lines):
    return [entry["text"] for entry in mark_chrome(lines) if entry["chrome"]]


class MarkChromeTests(unittest.TestCase):
    def test_phone_furniture_is_flagged(self):
        lines = [
            line("9:41", 0.01, height=0.04),
            line("5G", 0.01, height=0.04, x=0.85),
            line("你今天有空吗？", 0.30),
            line("我下午三点以后都可以", 0.45),
            line("好啊，我早就想去了", 0.60),
            line("发送消息…", 0.94, height=0.04),
        ]
        self.assertEqual(chrome_of(lines), ["9:41", "5G", "发送消息…"])

    def test_body_text_is_never_flagged(self):
        lines = [
            line("你今天有空吗？", 0.30),
            line("我下午三点以后都可以", 0.45),
        ]
        self.assertEqual(chrome_of(lines), [])

    # A page of scanned text is all one size. Nothing is furniture, including
    # the lines that happen to sit at the very top and bottom.
    def test_uniform_text_has_no_chrome(self):
        lines = [line(f"line {n}", n * 0.09) for n in range(11)]
        self.assertEqual(chrome_of(lines), [])

    # Big text at the top is a headline, not a status bar.
    def test_large_text_in_the_top_band_is_kept(self):
        lines = [
            line("重要通知", 0.01, height=0.10),
            line("会议改到下午三点", 0.40, height=0.08),
            line("请准时参加", 0.60, height=0.08),
        ]
        self.assertEqual(chrome_of(lines), [])

    def test_clock_shapes(self):
        for stamp in ["9:41", "12:30", "23.59"]:
            lines = [line(stamp, 0.01, height=0.05), line("正文内容在这里", 0.5)]
            self.assertEqual(chrome_of(lines), [stamp], stamp)

    def test_battery_and_network_badges(self):
        for badge in ["85%", "5G", "LTE", "Wi-Fi", "wifi"]:
            lines = [line(badge, 0.01, height=0.05), line("正文内容在这里", 0.5)]
            self.assertEqual(chrome_of(lines), [badge], badge)

    # A number in the middle of the picture is a price, a date, a score.
    def test_a_clock_shape_outside_the_band_is_kept(self):
        lines = [line("12:30", 0.45, height=0.05), line("正文内容在这里", 0.5)]
        self.assertEqual(chrome_of(lines), [])

    def test_empty_input(self):
        self.assertEqual(mark_chrome([]), [])


def row(text, y, height=0.06, x=0.10, width=0.60):
    return {"text": text, "score": 0.99, "box": [x, y, width, height], "chrome": False}


def texts(lines):
    return [entry["text"] for entry in merge_wrapped(lines)]


class MergeWrappedTests(unittest.TestCase):
    # The case that started this: one sentence the layout broke in two.
    def test_a_wrapped_sentence_is_rejoined(self):
        lines = [
            row("那我们去那家新开的", 0.30),
            row("火锅店吧。", 0.37),
        ]
        self.assertEqual(texts(lines), ["那我们去那家新开的火锅店吧。"])

    def test_finished_sentences_stay_apart(self):
        lines = [
            row("你今天有空吗？", 0.30),
            row("我下午三点以后都可以。", 0.37),
        ]
        self.assertEqual(len(texts(lines)), 2)

    # Separate chat bubbles sit further apart than the rows inside one.
    def test_rows_pushed_apart_are_left_alone(self):
        lines = [row("第一条消息", 0.30), row("第二条消息", 0.44)]
        self.assertEqual(len(texts(lines)), 2)

    # A reply on the other side of the chat shares no column with the message
    # above it, however close it sits.
    def test_opposite_columns_do_not_merge(self):
        lines = [
            row("左边的消息", 0.30, x=0.05, width=0.35),
            row("右边的回复", 0.37, x=0.60, width=0.35),
        ]
        self.assertEqual(len(texts(lines)), 2)

    def test_a_heading_does_not_swallow_the_paragraph(self):
        lines = [row("大标题", 0.20, height=0.11), row("正文第一行", 0.32, height=0.05)]
        self.assertEqual(len(texts(lines)), 2)

    def test_latin_wraps_get_their_space_back(self):
        lines = [row("the quick brown", 0.30), row("fox jumps over", 0.37)]
        self.assertEqual(texts(lines), ["the quick brown fox jumps over"])

    def test_cjk_wraps_get_no_space(self):
        lines = [row("这条河从山里", 0.30), row("一直流到海边", 0.37)]
        self.assertEqual(texts(lines), ["这条河从山里一直流到海边"])

    def test_three_rows_of_one_sentence(self):
        lines = [row("两岸的村子", 0.20), row("已经有几百年", 0.27), row("历史。", 0.34)]
        self.assertEqual(texts(lines), ["两岸的村子已经有几百年历史。"])

    # The merged line has to cover both rows, or a highlight would point at half
    # of what it describes.
    def test_the_box_grows_to_cover_both_rows(self):
        lines = [row("上一行", 0.20, x=0.10, width=0.50), row("下一行", 0.27, x=0.08, width=0.60)]
        box = merge_wrapped(lines)[0]["box"]
        self.assertAlmostEqual(box[0], 0.08, places=4)
        self.assertAlmostEqual(box[1], 0.20, places=4)
        self.assertAlmostEqual(box[0] + box[2], 0.68, places=4)
        self.assertAlmostEqual(box[1] + box[3], 0.33, places=4)

    # Furniture must never be glued onto real content.
    def test_chrome_never_merges_with_content(self):
        clock = row("9:41", 0.02, height=0.05)
        clock["chrome"] = True
        lines = [clock, row("正文内容", 0.08, height=0.05)]
        self.assertEqual(len(texts(lines)), 2)

    def test_empty_input(self):
        self.assertEqual(merge_wrapped([]), [])


def sentences(text, chrome=False):
    line = {"text": text, "score": 0.99, "box": [0.1, 0.2, 0.8, 0.4], "chrome": chrome}
    return [entry["text"] for entry in split_sentences([line])]


class SplitSentencesTests(unittest.TestCase):
    # The case from the real screenshot: a rejoined paragraph is four sentences,
    # and handing all of it to the translator at once gets it truncated.
    def test_a_paragraph_becomes_one_line_per_sentence(self):
        text = (
            "东弗里斯兰号战列舰是德意志帝国海军黑尔戈兰级战列舰的二号舰，以东弗里斯兰地区命名。"
            "1911年8月1日投入舰队服役。"
            "该舰在六座双联装炮塔中装备有十二门305毫米50倍径速射炮。"
        )
        self.assertEqual(
            sentences(text),
            [
                "东弗里斯兰号战列舰是德意志帝国海军黑尔戈兰级战列舰的二号舰，以东弗里斯兰地区命名。",
                "1911年8月1日投入舰队服役。",
                "该舰在六座双联装炮塔中装备有十二门305毫米50倍径速射炮。",
            ],
        )

    def test_a_single_sentence_is_left_alone(self):
        self.assertEqual(sentences("我下午三点以后都可以。"), ["我下午三点以后都可以。"])

    # Commas are mid-sentence; splitting there would recreate the bug.
    def test_commas_do_not_split(self):
        text = "连同其姊妹舰一起，东弗里斯兰号参加了一战期间的行动。"
        self.assertEqual(sentences(text), [text])

    def test_trailing_text_without_a_terminator_is_kept(self):
        self.assertEqual(sentences("第一句。没有句号的结尾"), ["第一句。", "没有句号的结尾"])

    def test_terminator_keeps_its_closing_quote(self):
        self.assertEqual(sentences("他说：“我来了。”然后走了。"), ["他说：“我来了。”", "然后走了。"])

    def test_question_and_exclamation_split(self):
        self.assertEqual(sentences("你今天有空吗？我下午可以！"), ["你今天有空吗？", "我下午可以！"])

    # Furniture is one short label; splitting it would be noise.
    def test_chrome_is_not_split(self):
        self.assertEqual(sentences("9:41", chrome=True), ["9:41"])

    # Each sentence should sit over roughly its own part of the block, so a
    # highlight points somewhere sensible rather than at the whole paragraph.
    def test_the_box_is_shared_out_between_sentences(self):
        line = {"text": "一二三四。五六七八。", "score": 0.9, "box": [0.1, 0.2, 0.8, 0.4]}
        boxes = [entry["box"] for entry in split_sentences([line])]
        self.assertEqual(len(boxes), 2)
        self.assertAlmostEqual(boxes[0][1], 0.2, places=4)
        self.assertAlmostEqual(boxes[0][1] + boxes[0][3], boxes[1][1], places=4)
        self.assertAlmostEqual(boxes[1][1] + boxes[1][3], 0.6, places=4)


if __name__ == "__main__":
    unittest.main()


def charline(text, y, height=0.06, x=0.10, char_w=0.05):
    """A line carrying one box per character, laid out left to right."""
    chars = [
        {"t": ch, "box": [round(x + i * char_w, 5), y, char_w, height]}
        for i, ch in enumerate(text)
    ]
    return {
        "text": text,
        "score": 0.99,
        "box": [x, y, round(char_w * len(text), 5), height],
        "chars": chars,
        "chrome": False,
    }


def rebuilds(line):
    """The invariant everything downstream leans on."""
    return "".join(item["t"] for item in line["chars"]) == line["text"]


class CharBoxTests(unittest.TestCase):
    # If characters and text ever drift apart, highlights point at the wrong
    # place — silently. So it is checked after every transform.
    def test_chars_still_rebuild_the_text_after_a_cjk_merge(self):
        lines = [charline("那我们去那家新开的", 0.30), charline("火锅店吧。", 0.37)]
        merged = merge_wrapped(lines)
        self.assertEqual(len(merged), 1)
        self.assertTrue(rebuilds(merged[0]))
        self.assertEqual(merged[0]["text"], "那我们去那家新开的火锅店吧。")

    def test_chars_still_rebuild_the_text_after_a_latin_merge(self):
        lines = [charline("the quick brown", 0.30), charline("fox jumps", 0.37)]
        merged = merge_wrapped(lines)
        self.assertEqual(merged[0]["text"], "the quick brown fox jumps")
        self.assertTrue(rebuilds(merged[0]))

    def test_chars_still_rebuild_the_text_after_splitting(self):
        merged = merge_wrapped([charline("第一句。第二句。", 0.30)])
        pieces = split_sentences(merged)
        self.assertEqual([p["text"] for p in pieces], ["第一句。", "第二句。"])
        for piece in pieces:
            self.assertTrue(rebuilds(piece), piece["text"])

    def test_each_sentence_gets_only_its_own_characters(self):
        pieces = split_sentences([charline("第一句。第二句。", 0.30)])
        self.assertEqual(pieces[0]["chars"][0]["t"], "第")
        self.assertEqual(pieces[1]["chars"][0]["t"], "第")
        # The second sentence starts where the first ended, not at the origin.
        self.assertGreater(pieces[1]["chars"][0]["box"][0], pieces[0]["chars"][0]["box"][0])

    def test_a_split_sentence_gets_an_exact_box_not_an_estimate(self):
        pieces = split_sentences([charline("第一句。第二句。", 0.30)])
        # Four characters each, 0.05 wide, starting at x=0.10.
        self.assertAlmostEqual(pieces[0]["box"][0], 0.10, places=4)
        self.assertAlmostEqual(pieces[0]["box"][2], 0.20, places=4)
        self.assertAlmostEqual(pieces[1]["box"][0], 0.30, places=4)

    # A row the recogniser gave no characters for must not poison its neighbour.
    def test_merging_with_a_charless_row_drops_the_characters(self):
        first = charline("那我们去那家新开的", 0.30)
        second = charline("火锅店吧。", 0.37)
        del second["chars"]
        merged = merge_wrapped([first, second])
        self.assertEqual(len(merged), 1)
        self.assertNotIn("chars", merged[0])
        self.assertEqual(merged[0]["text"], "那我们去那家新开的火锅店吧。")

    def test_lines_without_characters_still_split(self):
        line = {"text": "第一句。第二句。", "score": 0.9, "box": [0.1, 0.2, 0.8, 0.4]}
        pieces = split_sentences([line])
        self.assertEqual([p["text"] for p in pieces], ["第一句。", "第二句。"])
        self.assertNotIn("chars", pieces[0])
