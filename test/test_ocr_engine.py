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
        fallback = mock.MagicMock(side_effect=lambda threads: built.append(threads) or "onnx-engine")

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


if __name__ == "__main__":
    unittest.main()
