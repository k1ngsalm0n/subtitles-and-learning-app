import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "server"))

import ocr_engine  # noqa: E402

# No engine is ever built here: constructing RapidOCR loads its models, and CI
# runs these offline with an empty model cache.


class EngineChoice(unittest.TestCase):
    def test_openvino_when_installed(self):
        with mock.patch.dict(os.environ, {"OCR_ENGINE": ""}), mock.patch.object(ocr_engine, "openvino_available", return_value=True):
            self.assertEqual(ocr_engine.engine_name(), "openvino")

    def test_onnxruntime_when_openvino_is_missing(self):
        with mock.patch.dict(os.environ, {"OCR_ENGINE": ""}), mock.patch.object(ocr_engine, "openvino_available", return_value=False):
            self.assertEqual(ocr_engine.engine_name(), "onnxruntime")

    def test_forced_back_to_onnxruntime(self):
        with mock.patch.dict(os.environ, {"OCR_ENGINE": "onnxruntime"}), mock.patch.object(ocr_engine, "openvino_available", return_value=True):
            self.assertEqual(ocr_engine.engine_name(), "onnxruntime")

    def test_openvino_that_fails_to_start_falls_back(self):
        built = []
        fallback = mock.MagicMock(side_effect=lambda threads, rec=None: built.append(threads) or "onnx-engine")

        class Broken:
            def __init__(self, *a, **k):
                raise RuntimeError("no device")

        fake_rapidocr = mock.MagicMock(RapidOCR=Broken, EngineType=mock.MagicMock())
        with mock.patch.dict(os.environ, {"OCR_ENGINE": ""}), \
                mock.patch.object(ocr_engine, "openvino_available", return_value=True), \
                mock.patch.dict(sys.modules, {"rapidocr": fake_rapidocr}), \
                mock.patch.object(ocr_engine, "_onnxruntime", fallback):
            self.assertEqual(ocr_engine.build_engine(4), "onnx-engine")
        self.assertEqual(built, [4])



class ModelByLanguage(unittest.TestCase):
    """The recognition model follows the study language's script (#65)."""

    def test_default_model_for_chinese_english_japanese_and_latin(self):
        # Esperanto, not a study language Whisper can hear, stands for the
        # Latin rows with no override of their own (German has "latin").
        for code in ("zh", "en", "ja", "es", "eo", "vi", "nb", ""):
            self.assertEqual(ocr_engine.recognition_params(code), {}, code)

    def test_own_model_for_other_scripts(self):
        expected = {"ru": "cyrillic", "uk": "cyrillic", "ar": "arabic", "ur": "arabic",
                    "hi": "devanagari", "el": "el", "ko": "korean", "th": "th"}
        for code, model in expected.items():
            params = ocr_engine.recognition_params(code)
            self.assertEqual(params["Rec.lang_type"], model, code)
            self.assertEqual(params["Rec.ocr_version"], "PP-OCRv5")
            self.assertEqual(params["Rec.model_type"], "mobile")

    def test_no_model_for_hebrew_or_bengali(self):
        for code in ("he", "bn"):
            self.assertFalse(ocr_engine.can_read(code))
            with self.assertRaises(ocr_engine.NoOcrModel):
                ocr_engine.recognition_params(code)
        self.assertTrue(ocr_engine.can_read("en"))
        self.assertTrue(ocr_engine.can_read(""))

    def test_every_model_named_exists_in_the_installed_rapidocr(self):
        # Read off RapidOCR's own model list, so a name that doesn't exist (or
        # disappears in an upgrade) fails here rather than at an import. No
        # model is loaded or downloaded.
        import importlib.util

        import yaml

        spec = importlib.util.find_spec("rapidocr")
        if spec is None:
            self.skipTest("rapidocr not installed")
        models = os.path.join(os.path.dirname(spec.origin), "default_models.yaml")
        with open(models, encoding="utf-8") as f:
            table = yaml.safe_load(f)
        import languages

        wanted = {m for m in languages.OCR_BY_SCRIPT.values() if m} | {
            row["ocr"] for row in languages.ROWS.values() if row.get("ocr")
        }
        for engine in ("onnxruntime", "openvino"):
            rec = table[engine]["PP-OCRv5"]["rec"]
            for model in wanted:
                self.assertIn(f"{model}_PP-OCRv5_rec_mobile", rec, f"{engine}: {model}")

    def test_build_engine_passes_the_model_to_rapidocr(self):
        seen = {}

        class FakeRapidOCR:
            def __init__(self, params=None):
                seen.update(params or {})

        fake = mock.MagicMock(
            RapidOCR=FakeRapidOCR,
            LangRec=lambda v: ("LangRec", v),
            OCRVersion=lambda v: ("OCRVersion", v),
            ModelType=lambda v: ("ModelType", v),
        )
        with mock.patch.dict(os.environ, {"OCR_ENGINE": "onnxruntime"}), \
                mock.patch.dict(sys.modules, {"rapidocr": fake}):
            ocr_engine.build_engine(language="ru")
        self.assertEqual(seen["Rec.lang_type"], ("LangRec", "cyrillic"))
        self.assertEqual(seen["Rec.ocr_version"], ("OCRVersion", "PP-OCRv5"))
        self.assertEqual(seen["Rec.model_type"], ("ModelType", "mobile"))


if __name__ == "__main__":
    unittest.main()
