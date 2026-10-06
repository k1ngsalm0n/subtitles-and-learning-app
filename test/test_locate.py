"""Tests for server/locate.py: finding a card's word in its video's
word-timed transcript. No model is loaded — the segments are written here."""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "server"))

from locate import locate  # noqa: E402


def seg(start, text, step=0.4):
    """A segment with one word per character, `step` seconds each."""
    words = [{"word": ch, "start": start + i * step, "end": start + (i + 1) * step}
             for i, ch in enumerate(text)]
    return {"start": start, "end": start + len(text) * step, "text": text, "words": words}


# A song: the same word in two different lines, 40 s apart.
SONG = [
    seg(10.0, "八方來財來財"),
    seg(20.0, "錢包裡面多幾百"),
    seg(50.0, "願花錢交朋友來財"),
]


class LocateTest(unittest.TestCase):
    def test_the_word_is_found_where_it_is_said(self):
        hit = locate(SONG, "錢包", "錢包裡面多幾百", 20.0)
        self.assertAlmostEqual(hit["start"], 20.0)
        self.assertAlmostEqual(hit["end"], 20.8)
        self.assertEqual((hit["lineStart"], hit["lineEnd"]), (20.0, 22.8))

    def test_a_wrong_saved_time_doesnt_matter_when_the_sentence_matches(self):
        # Cards from before #143 could carry another line's time entirely.
        hit = locate(SONG, "錢包", "錢包裡面多幾百", 51.0)
        self.assertAlmostEqual(hit["start"], 20.0)

    def test_a_repeated_word_is_the_one_in_the_cards_sentence(self):
        hit = locate(SONG, "來財", "願花錢交朋友來財", 10.0)
        self.assertAlmostEqual(hit["start"], 50.0 + 6 * 0.4)

    def test_scripts_are_compared_alike(self):
        # Whisper wrote Simplified; the card is Traditional.
        simplified = [seg(20.0, "钱包里面多几百")]
        hit = locate(simplified, "錢包", "錢包裡面多幾百", 20.0)
        self.assertAlmostEqual(hit["start"], 20.0)

    def test_a_misheard_word_is_placed_by_its_sentence(self):
        # Whisper heard 六合踩 this time; the card says 六合彩.
        heard = [seg(50.0, "一的是六合踩難的是等何排")]
        hit = locate(heard, "六合彩", "一的是六合彩", None)
        self.assertAlmostEqual(hit["start"], 50.0 + 3 * 0.4)

    def test_without_a_sentence_only_a_nearby_time_counts(self):
        self.assertAlmostEqual(locate(SONG, "錢包", "", 22.0)["start"], 20.0)
        self.assertIsNone(locate(SONG, "錢包", "", 200.0))

    def test_not_in_the_video_is_none_rather_than_a_guess(self):
        self.assertIsNone(locate(SONG, "因果", "看懂這因果業障", 20.0))
        self.assertIsNone(locate([], "錢包", "錢包裡面", 20.0))


if __name__ == "__main__":
    unittest.main()
