import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "server"))

from romanize import pinyin_tokens  # noqa: E402


def reading(text):
    """The pinyin for a phrase, as one space-separated string."""
    return " ".join(pron for _base, pron in pinyin_tokens(text) if pron)


class PolyphoneTests(unittest.TestCase):
    # The one that started this. 很长 is not in pypinyin's phrase dictionary, so
    # it fell back to the bare-character default, which was zhǎng.
    def test_hen_chang(self):
        self.assertEqual(reading("很长"), "hěn cháng")

    def test_other_adverbs_before_chang(self):
        self.assertEqual(reading("太长"), "tài cháng")
        self.assertEqual(reading("多长"), "duō cháng")
        self.assertEqual(reading("更长"), "gèng cháng")

    # This one was quietly wrong before and nobody had noticed.
    def test_chang_shi_jian(self):
        self.assertEqual(reading("长时间"), "cháng shí jiān")

    # Changing a default is only safe if the phrase dictionary still wins. These
    # are the words that would break if it didn't.
    def test_zhang_words_are_unharmed(self):
        for word, want in [
            ("长大", "zhǎng dà"),
            ("校长", "xiào zhǎng"),
            ("队长", "duì zhǎng"),
            ("市长", "shì zhǎng"),
            ("家长", "jiā zhǎng"),
            ("成长", "chéng zhǎng"),
            ("生长", "shēng zhǎng"),
            ("长辈", "zhǎng bèi"),
            ("部长", "bù zhǎng"),
            ("长相", "zhǎng xiàng"),
            ("车长", "chē zhǎng"),
        ]:
            self.assertEqual(reading(word), want, word)

    def test_chang_words_are_unharmed(self):
        for word, want in [
            ("长城", "cháng chéng"),
            ("长江", "cháng jiāng"),
            ("长期", "cháng qī"),
            ("长度", "cháng dù"),
            ("擅长", "shàn cháng"),
            ("长发", "cháng fà"),
        ]:
            self.assertEqual(reading(word), want, word)

    def test_gan_is_pinned_only_where_it_is_unambiguous(self):
        self.assertEqual(reading("很干"), "hěn gān")
        self.assertEqual(reading("太干"), "tài gān")
        # A bare 干 is genuinely either reading, so it is left as it was.
        self.assertEqual(reading("干活"), "gàn huó")
        self.assertEqual(reading("干净"), "gān jìng")

    # Corrections must not disturb the polyphones pypinyin already handles.
    def test_untouched_polyphones(self):
        for word, want in [
            ("银行", "yín háng"),
            ("重新", "chóng xīn"),
            ("重要", "zhòng yào"),
            ("头发", "tóu fà"),
        ]:
            self.assertEqual(reading(word), want, word)

    # Tokens must still line up with the characters, ruby depends on it.
    def test_tokens_still_rebuild_the_line(self):
        text = "头发很长，我在里面吃面条。"
        self.assertEqual("".join(base for base, _ in pinyin_tokens(text)), text)


if __name__ == "__main__":
    unittest.main()
