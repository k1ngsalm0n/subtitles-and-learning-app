"""German's entries in the per-language tables (no model is loaded)."""

import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "server"))


class GermanRoutesTest(unittest.TestCase):
    def test_opus_routes(self):
        from translate import opus_prefix, opus_route

        # FLORES-200, chrF++ against NLLB-600M (300 sentences): de->en 65.37
        # (NLLB 64.09), en->de 60.41 with >>deu<< (NLLB 58.19).
        self.assertEqual(opus_route("de", "en")["model"], "Helsinki-NLP/opus-mt-tc-bible-big-gmw-en")
        self.assertEqual(opus_prefix(opus_route("de", "en")), "")
        self.assertEqual(
            opus_route("en", "de")["model"], "Helsinki-NLP/opus-mt-tc-bible-big-deu_eng_fra_por_spa-gmw"
        )
        self.assertEqual(opus_prefix(opus_route("en", "de")), ">>deu<< ")

    def test_into_chinese_uses_the_mandarin_token(self):
        from translate import opus_prefix, opus_route

        # opus-mt-de-ZH's targets are cmn, yue, zh_TW…: >>zh_TW<< wrote HTML
        # garbage, >>zh<< Cantonese; >>cmn<< 13.98 against NLLB's 11.7. The
        # script is the app's own afterwards, so ZH_SCRIPT doesn't change it.
        self.assertEqual(opus_route("de", "zh")["model"], "Helsinki-NLP/opus-mt-de-ZH")
        self.assertEqual(opus_prefix(opus_route("de", "zh")), ">>cmn<< ")
        with mock.patch.dict(os.environ, {"ZH_SCRIPT": "off"}):
            self.assertEqual(opus_prefix(opus_route("de", "zh")), ">>cmn<< ")


class GermanLanguageRowTest(unittest.TestCase):
    def test_offered_read_by_the_latin_model_transcribed_by_medium(self):
        import languages
        import transcribe

        self.assertIn("de", languages.offered())
        self.assertEqual(languages.whisper_code("de"), "de")
        # PP-OCRv5 latin kept „ and a line the default dropped.
        self.assertEqual(languages.ocr_model("de"), "latin")
        # small misheard ~1 word in 10 on news and a vlog, medium ~1 in 50.
        self.assertEqual(transcribe.WHISPER_MIN_MODEL["de"], "medium")
        with mock.patch("platform.system", return_value="Linux"), \
             mock.patch("platform.machine", return_value="x86_64"), \
             mock.patch.dict(os.environ, {"WHISPER_MODEL": "auto"}):
            self.assertEqual(transcribe._resolve_model("cpu", language="de"), "medium")
            self.assertEqual(transcribe._resolve_model("cpu", language="en"), "small")


if __name__ == "__main__":
    unittest.main()
