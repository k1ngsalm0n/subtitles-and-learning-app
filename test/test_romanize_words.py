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


class TraditionalTests(unittest.TestCase):
    """jieba's dictionary is Simplified, so Traditional is cut via a round trip.

    Without it 弗里斯蘭號 came apart as 弗里斯 | 蘭號 and 德意志帝國海軍 as
    德意志帝 | 國海 | 軍.
    """

    SIMP = "东弗里斯兰号战列舰是德意志帝国海军的一艘无畏舰。"
    TRAD = "東弗里斯蘭號戰列艦是德意志帝國海軍的一艘無畏艦。"

    def test_same_boundaries_in_both_scripts(self):
        # The reader can flip script at any time; where the words start must
        # not depend on which one they are looking at.
        simp = chinese_words(self.SIMP)
        trad = chinese_words(self.TRAD)
        self.assertEqual([len(w) for w in simp], [len(w) for w in trad])

    def test_traditional_words_stay_whole(self):
        words = chinese_words(self.TRAD)
        for expected in ("弗里斯蘭", "戰列艦", "德意志", "帝國", "海軍"):
            self.assertIn(expected, words)

    def test_traditional_words_rebuild_the_line(self):
        for text in (self.TRAD, "該艦參加了日德蘭海戰。", "繁體字與简体字混合"):
            self.assertEqual("".join(chinese_words(text)), text, text)

    def test_traditional_words_are_traditional(self):
        # Cut on the Simplified form, but made of the glyphs on screen — a
        # saved word has to match what was clicked.
        self.assertIn("弗里斯蘭", chinese_words(self.TRAD))
        self.assertNotIn("弗里斯兰", chinese_words(self.TRAD))


if __name__ == "__main__":
    unittest.main()


class WordFrequencyTest(unittest.TestCase):
    """A made-up example sentence keeps to common words by these counts."""

    def test_common_words_count_more_than_rare_ones(self):
        from romanize import word_frequencies

        common, neighbour, rare = word_frequencies(["朋友", "鄰居", "龃龉"])
        self.assertGreater(common, neighbour)
        self.assertGreater(neighbour, 400)
        self.assertLess(rare, 400)

    def test_a_pair_jieba_made_up_counts_as_its_rarest_character(self):
        from romanize import word_frequencies

        (pair,) = word_frequencies(["太累"])
        self.assertGreater(pair, 400)

    def test_the_request_flag_adds_one_count_per_word(self):
        from romanize import romanize

        out = romanize({"lang": "zh", "lines": ["我想改行。"], "frequencies": True})
        self.assertEqual(len(out["freqs"][0]), len(out["words"][0]))
        self.assertNotIn("freqs", romanize({"lang": "zh", "lines": ["我"]}))


class ElidedWordsTests(unittest.TestCase):
    """French glues words with apostrophes and hyphens. Intl.Segmenter keeps
    "qu'il" whole and splits "peut-être"; a click should find a real word."""

    def words(self, text):
        from romanize import elided_words

        cut = elided_words(text, "fr")
        self.assertEqual("".join(cut), text)
        return [w for w in cut if any(c.isalnum() for c in w)]

    def test_elisions_become_their_own_word(self):
        self.assertEqual(self.words("L’homme qu’il a vu"), ["L’", "homme", "qu’", "il", "a", "vu"])
        self.assertEqual(self.words("J'ai dit qu'on s'en va"), ["J'", "ai", "dit", "qu'", "on", "s'", "en", "va"])

    def test_words_spelled_with_an_apostrophe_stay_whole(self):
        self.assertEqual(self.words("aujourd'hui quelqu'un jusqu'à"), ["aujourd'hui", "quelqu'un", "jusqu'à"])

    def test_hyphenated_words_stay_whole(self):
        self.assertEqual(self.words("peut-être l'arc-en-ciel ce week-end"), ["peut-être", "l'", "arc-en-ciel", "ce", "week-end"])

    def test_pronouns_after_a_verb_are_peeled_off(self):
        self.assertEqual(self.words("Est-ce dites-le-moi a-t-il"), ["Est", "ce", "dites", "le", "moi", "a", "t", "il"])
        self.assertEqual(self.words("Qu'est-ce que c'est"), ["Qu'", "est", "ce", "que", "c'", "est"])

    def test_ci_and_la_after_a_demonstrative_stay(self):
        self.assertEqual(self.words("celui-ci, ce jour-là"), ["celui-ci", "ce", "jour", "là"])
        self.assertEqual(self.words("rendez-vous"), ["rendez-vous"])

    def test_loose_hyphens_and_apostrophes_survive(self):
        for text in ("22h30 - non", "'citation' -tiret", "fin-", "l'", "« Où ? » — oui"):
            self.words(text)

    def test_other_languages_get_nothing(self):
        from romanize import elided_words, word_splitter

        self.assertEqual(elided_words("l'uomo", "it"), [])
        self.assertIsNone(word_splitter("en"))
        self.assertEqual(word_splitter("fr")("c'est"), ["c'", "est"])
