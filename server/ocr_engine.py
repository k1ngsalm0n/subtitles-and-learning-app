"""Which engine RapidOCR runs on — one place for caption OCR and screenshots.

OpenVINO when it's installed, because on an Intel machine it read the same
caption frames 2.9× faster than onnxruntime — 0.66 s a frame against 1.9 s on
a Core Ultra X7 358H, 40 frames of a 640×360 interview — with the same text on
every frame. At 1.9 s a frame a 7-minute video spent 17 minutes in OCR, and
Whisper, starved of cores, finished only after it. onnxruntime stays the
fallback: it ships with RapidOCR, so OCR works wherever RapidOCR does, and a
broken OpenVINO install degrades to it instead of breaking OCR.

OCR_ENGINE=onnxruntime forces the old engine (to compare, or if OpenVINO
misbehaves on some machine). OCR_THREADS applies to onnxruntime only — the
measurements behind dropping thread caps were onnxruntime's.

Which *recognition model* runs is the study language's business: the default
(PP-OCRv6 multi) reads Chinese, Japanese and Latin script, and other scripts
get their own PP-OCRv5 model (languages.py: OCR_BY_SCRIPT). A language whose
script no model reads raises NoOcrModel rather than returning garbage.
"""

import os
import sys

import languages


class NoOcrModel(Exception):
    """No RapidOCR model reads this language's script (Hebrew, Bengali, …)."""

    def __init__(self, language):
        self.language = language
        super().__init__(f"no OCR model reads {language}")


def can_read(language):
    """Whether any OCR model reads `language` (an empty code means "unknown",
    which the default model is used for, as before OCR knew the language)."""
    return languages.ocr_model(language or "") != languages.NO_MODEL


def recognition_params(language):
    """RapidOCR params choosing the recognition model for `language`: {} for
    the default model, else the PP-OCRv5 mobile model for its script.

    Plain strings, so this can be checked without importing RapidOCR;
    _as_enums() turns them into the enums RapidOCR insists on for
    ocr_version and model_type (it refuses strings for those)."""
    model = languages.ocr_model(language or "")
    if model == languages.NO_MODEL:
        raise NoOcrModel(language)
    if model is None:
        return {}
    return {
        "Rec.ocr_version": "PP-OCRv5",
        "Rec.lang_type": model,
        "Rec.model_type": "mobile",
    }


def openvino_available():
    try:
        import openvino  # noqa: F401
    except Exception:  # noqa: BLE001 - any failure means "can't use it"
        return False
    return True


def engine_name():
    """The engine build_engine() will use here: "openvino" or "onnxruntime"."""
    if os.environ.get("OCR_ENGINE", "").lower() == "onnxruntime":
        return "onnxruntime"
    return "openvino" if openvino_available() else "onnxruntime"


def _as_enums(rec):
    if not rec:
        return {}
    from rapidocr import LangRec, ModelType, OCRVersion

    return {
        "Rec.ocr_version": OCRVersion(rec["Rec.ocr_version"]),
        "Rec.lang_type": LangRec(rec["Rec.lang_type"]),
        "Rec.model_type": ModelType(rec["Rec.model_type"]),
    }


def _onnxruntime(threads, rec=None):
    from rapidocr import RapidOCR

    params = _as_enums(rec)
    if threads and threads > 0:
        params["EngineConfig.onnxruntime.intra_op_num_threads"] = threads
    return RapidOCR(params=params) if params else RapidOCR()


def build_engine(threads=None, language=None):
    """A RapidOCR instance on the best engine available here, recognising
    `language`'s script (None: the default model). Raises NoOcrModel when no
    model reads it — callers check can_read() first."""
    rec = recognition_params(language)
    if engine_name() == "openvino":
        try:
            from rapidocr import EngineType, RapidOCR

            return RapidOCR(
                params={
                    "Det.engine_type": EngineType.OPENVINO,
                    "Cls.engine_type": EngineType.OPENVINO,
                    "Rec.engine_type": EngineType.OPENVINO,
                    **_as_enums(rec),
                }
            )
        except Exception as exc:  # noqa: BLE001 - fall back rather than fail OCR
            sys.stderr.write(f"OCR: OpenVINO didn't start ({exc}); using onnxruntime\n")
    return _onnxruntime(threads, rec)
