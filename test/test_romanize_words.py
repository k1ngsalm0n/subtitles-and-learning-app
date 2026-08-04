import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "server"))

from romanize import chinese_words, word_splitter  # noqa: E402


class WordSplitterTests(unittest.TestCase):
    def test_only_chinese_gets_a_splitter(self):
        for lang in ("zh", "zh-cn", "zh-tw", "Chinese"):
            self.assertIsNotNone(word_splitter(lang), lang)
        # Everything else has spaces, and Intl.Segmenter handles those.
        for lang in ("en", "ja", "ko", "ru", "", None):
            self.assertIsNone(word_splitter(lang), lang)


class SegmentationTests(unittest.TestCase):
    """The contract the frontend depends on, plus the cases that motivated it."""

    def test_words_rebuild_the_line(self):
        # The renderer walks these to lay ruby over the line, so a segmenter
        # that dropped or altered a character would shift every later word.
        for text in (
            "东弗里斯兰号战列舰是德意志帝国海军的一艘无畏舰。",
            "她于一九零九年开始建造，并在一九一一年下水。",
            "Mixed 中文 and English 123.",
            "。、，！",
        ):
            self.assertEqual("".join(chinese_words(text)), text, text)

    def test_empty_text(self):
        self.assertEqual(chinese_words(""), [])

    # The complaint that prompted this: the line translated as "Ostfriesland",
    # but clicking gave one character of the name because the browser's own
    # segmenter cut 弗里斯兰 into 弗 | 里斯 | 兰.
    def test_proper_nouns_stay_whole(self):
        self.assertIn("弗里斯兰", chinese_words("东弗里斯兰号战列舰"))
        self.assertIn("日德兰", chinese_words("该舰参加了日德兰海战。"))

    def test_compounds_stay_whole(self):
        self.assertIn("战列舰", chinese_words("东弗里斯兰号战列舰"))
        self.assertIn("海军", chinese_words("德意志帝国海军"))
        self.assertIn("参加", chinese_words("该舰参加了日德兰海战。"))

    def test_punctuation_is_its_own_word(self):
        self.assertIn("。", chinese_words("他走了。"))


if __name__ == "__main__":
    unittest.main()
