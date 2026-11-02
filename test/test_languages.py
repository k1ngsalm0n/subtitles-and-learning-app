"""The language table as the Python side reads it (server/languages.py), the
transcription gate built on it (transcribe.choose_language) and caption OCR's
per-language checks. No model is loaded: CI runs these offline."""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "server"))

import languages  # noqa: E402
from ocr_captions import _probe_line_hit, label_captions  # noqa: E402
from transcribe import UnsupportedLanguage, choose_language  # noqa: E402


class TableTest(unittest.TestCase):
    def test_chinese_and_english_are_offered(self):
        self.assertTrue({"zh", "en"} <= languages.offered())
        self.assertNotIn("fr", languages.offered())

    def test_whisper_codes_map_to_the_table(self):
        self.assertEqual(languages.table_code("no"), "nb")
        self.assertEqual(languages.table_code("yue"), "zh")
        self.assertEqual(languages.table_code("EN"), "en")
        self.assertEqual(languages.whisper_code("nb"), "no")
        self.assertEqual(languages.whisper_code("en"), "en")
        # Whisper has no Esperanto or Irish.
        self.assertIsNone(languages.whisper_code("eo"))
        self.assertIsNone(languages.whisper_code("ga"))

    def test_script_comes_from_the_flores_code(self):
        self.assertEqual(languages.script("zh"), "Hant")
        self.assertEqual(languages.script("en"), "Latn")
        self.assertEqual(languages.script("ru"), "Cyrl")
        self.assertEqual(languages.script("xx"), "")

    def test_every_script_in_the_table_has_letters_and_a_decision(self):
        # A new script must say what its letters are (SCRIPT_RANGES) and is
        # then either read by a model or skipped — never silently defaulted.
        for code in languages.ROWS:
            sc = languages.script(code)
            self.assertIn(sc, languages.SCRIPT_RANGES, code)
        self.assertEqual(languages.ocr_model("he"), languages.NO_MODEL)
        self.assertEqual(languages.ocr_model("bn"), languages.NO_MODEL)
        self.assertIsNone(languages.ocr_model("en"))
        self.assertEqual(languages.ocr_model("ru"), "cyrillic")

    def test_script_letters(self):
        self.assertEqual(languages.script_letters("Hello, 世界", "en"), 5)
        self.assertEqual(languages.script_letters("Hello, 世界", "zh"), 2)


class ChooseLanguageTest(unittest.TestCase):
    OFFERED = {"zh", "en"}

    def test_chinese_rescue_comes_before_the_winner(self):
        # A typhoon report: storm noise votes "en", one window is surely
        # Chinese. Checking the winner first would transcribe it as English.
        self.assertEqual(choose_language("en", 0.02, 0.6, self.OFFERED), "zh")
        self.assertEqual(choose_language("en", 0.4, 0.4, self.OFFERED), "zh")
        self.assertEqual(choose_language("zh", 0.9, 0.9, self.OFFERED), "zh")

    def test_an_offered_winner_is_transcribed_as_itself(self):
        self.assertEqual(choose_language("en", 0.01, 0.02, self.OFFERED), "en")

    def test_a_language_not_offered_is_refused(self):
        with self.assertRaises(UnsupportedLanguage) as caught:
            choose_language("fr", 0.01, 0.02, self.OFFERED)
        self.assertEqual(caught.exception.language, "fr")

    def test_whisper_codes_are_translated_before_the_gate(self):
        self.assertEqual(choose_language("no", 0.0, 0.0, {"nb"}), "nb")

    def test_a_language_whisper_cant_transcribe_is_refused_even_if_offered(self):
        with self.assertRaises(UnsupportedLanguage):
            choose_language("eo", 0.0, 0.0, {"eo"})

    def test_without_chinese_offered_there_is_no_rescue(self):
        self.assertEqual(choose_language("en", 0.4, 0.6, {"en"}), "en")


class CaptionLanguageTest(unittest.TestCase):
    def seg(self, text):
        return {"start": 0, "end": 1, "text": text}

    def test_chinese_is_judged_as_before(self):
        found, segs = label_captions([self.seg("今天天氣很好"), self.seg("MA&AP")])
        self.assertEqual(found, "zh")
        self.assertEqual([s["text"] for s in segs], ["今天天氣很好"])
        found, _ = label_captions([self.seg("GOOD IDEAS"), self.seg("TEDx")])
        self.assertEqual(found, "unknown")

    def test_english_captions_read_as_english(self):
        found, segs = label_captions(
            [self.seg("We need to talk about this"), self.seg("12:30"), self.seg("I agree")],
            "en",
        )
        self.assertEqual(found, "en")
        self.assertEqual([s["text"] for s in segs], ["We need to talk about this", "I agree"])

    def test_the_wrong_script_is_not_the_study_language(self):
        # Chinese captions on a video expected to be English.
        found, _ = label_captions([self.seg("今天天氣很好"), self.seg("我們走吧")], "en")
        self.assertEqual(found, "unknown")

    def test_probe_counts_letters_of_the_script(self):
        self.assertTrue(_probe_line_hit("你好嗎", None))
        self.assertTrue(_probe_line_hit("你好嗎", "zh"))
        self.assertFalse(_probe_line_hit("Hello there", None))  # as before OCR knew the language
        self.assertTrue(_probe_line_hit("Hello there", "en"))
        self.assertFalse(_probe_line_hit("CNN 4", "en"))
        self.assertTrue(_probe_line_hit("Привет друзья", "ru"))


if __name__ == "__main__":
    unittest.main()
