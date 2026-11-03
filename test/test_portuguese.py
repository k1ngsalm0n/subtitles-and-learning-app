"""Portuguese's entries in the per-language tables (no model is loaded)."""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "server"))


class PortugueseRoutesTest(unittest.TestCase):
    def test_opus_routes_both_ways(self):
        from translate import opus_prefix, opus_route

        # FLORES-200, 100 sentences, chrF++ against NLLB-600M: pt->en 69.97
        # (NLLB 66.17), en->pt 69.65 with >>por<< (>>pob<< 69.07, NLLB 67.28).
        self.assertEqual(opus_route("pt", "en")["model"], "Helsinki-NLP/opus-mt-tc-bible-big-roa-en")
        self.assertEqual(opus_prefix(opus_route("pt", "en")), "")
        self.assertEqual(opus_route("en", "pt")["model"], "Helsinki-NLP/opus-mt-tc-big-en-pt")
        self.assertEqual(opus_prefix(opus_route("en", "pt")), ">>por<< ")
        # Into Chinese: NLLB 13.1, and a pivot through English 13.1 too.
        self.assertIsNone(opus_route("pt", "zh"))


class PortugueseLanguageRowTest(unittest.TestCase):
    def test_offered_and_transcribed_at_the_default_size(self):
        import languages
        import transcribe

        self.assertIn("pt", languages.offered())
        self.assertEqual(languages.whisper_code("pt"), "pt")
        # small measured as well as medium on real clips: no minimum.
        self.assertNotIn("pt", transcribe.WHISPER_MIN_MODEL)


if __name__ == "__main__":
    unittest.main()
