"""Cues of one sentence translated together (no model is loaded)."""

import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "server"))

import translate  # noqa: E402

TAGESSCHAU = [
    "Jugendproteste in Deutschland.",
    "In mehr als 30 Städten gingen gestern junge",
    "Menschen auf die Straße, um für eine bessere",
    "Bildung, mehr Klimaschutz und bezahlbaren Wohnraum zu demonstrieren.",
    "Aufgerufen hatte dazu die Initiative Gen Z regelt.",
]


class SentenceRunsTest(unittest.TestCase):
    def test_a_sentence_cut_over_cues_is_one_run(self):
        self.assertEqual(translate.sentence_runs(TAGESSCHAU, "de"), [[0], [1, 2, 3], [4]])

    def test_lyrics_and_chinese_stay_line_by_line(self):
        lyrics = ["I walk this empty street", "on the boulevard of broken dreams", "where the city sleeps"]
        self.assertEqual(translate.sentence_runs(lyrics, "en"), [[0], [1], [2]])
        self.assertEqual(translate.sentence_runs(["我們今天", "去公園。", "天氣很好。"], "zh"), [[0], [1], [2]])

    def test_a_run_is_capped(self):
        cues = [f"und dann noch ein Wort {i}" for i in range(9)] + ["Ende."] * 9
        runs = translate.sentence_runs(cues, "de")
        self.assertTrue(all(len(r) <= translate._RUN_CUES for r in runs))
        self.assertEqual([i for r in runs for i in r], list(range(len(cues))))


class SpreadTest(unittest.TestCase):
    def test_spread_by_length_at_words(self):
        pieces = translate.spread("In more than 30 cities young people took to the streets yesterday", [10, 10])
        self.assertEqual(" ".join(pieces), "In more than 30 cities young people took to the streets yesterday")
        self.assertTrue(all(pieces))
        self.assertLess(abs(len(pieces[0]) - len(pieces[1])), 20)

    def test_chinese_is_cut_between_characters_after_punctuation(self):
        pieces = translate.spread("我們現在有四個月大的老鼠，以前有糖尿病。", [10, 10], spaced=False)
        self.assertEqual("".join(pieces), "我們現在有四個月大的老鼠，以前有糖尿病。")
        self.assertTrue(pieces[0].endswith("，"))

    def test_no_cue_is_left_empty_while_there_is_enough(self):
        self.assertTrue(all(translate.spread("one two three", [50, 1, 1])))
        self.assertEqual(translate.spread("hello", [1]), ["hello"])


class TranslateSrtTest(unittest.TestCase):
    def test_a_sentence_goes_to_the_model_whole_and_comes_back_spread(self):
        srt = "\n\n".join(f"{i + 1}\n00:00:0{i},000 --> 00:00:0{i},900\n{t}" for i, t in enumerate(TAGESSCHAU))
        sent = []

        def fake(texts, from_code, to_code):
            sent.extend(texts)
            return [t.upper() for t in texts]

        with mock.patch.object(translate, "_translate_lines", fake):
            out = translate.translate_srt(srt, "de", "en")
        self.assertIn(
            "In mehr als 30 Städten gingen gestern junge Menschen auf die Straße, um für eine bessere "
            "Bildung, mehr Klimaschutz und bezahlbaren Wohnraum zu demonstrieren.",
            sent,
        )
        blocks = out.split("\n\n")
        self.assertEqual(len(blocks), 5)
        self.assertEqual(blocks[0].split("\n")[2], "JUGENDPROTESTE IN DEUTSCHLAND.")
        middle = " ".join(b.split("\n")[2] for b in blocks[1:4])
        self.assertEqual(middle, sent[1].upper())
        self.assertTrue(all(b.split("\n")[2] for b in blocks))


if __name__ == "__main__":
    unittest.main()
