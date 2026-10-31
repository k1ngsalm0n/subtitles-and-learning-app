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
"""

import os
import sys


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


def _onnxruntime(threads):
    from rapidocr import RapidOCR

    if threads and threads > 0:
        return RapidOCR(params={"EngineConfig.onnxruntime.intra_op_num_threads": threads})
    return RapidOCR()


def build_engine(threads=None):
    """A RapidOCR instance on the best engine available here."""
    if engine_name() == "openvino":
        try:
            from rapidocr import EngineType, RapidOCR

            return RapidOCR(
                params={
                    "Det.engine_type": EngineType.OPENVINO,
                    "Cls.engine_type": EngineType.OPENVINO,
                    "Rec.engine_type": EngineType.OPENVINO,
                }
            )
        except Exception as exc:  # noqa: BLE001 - fall back rather than fail OCR
            sys.stderr.write(f"OCR: OpenVINO didn't start ({exc}); using onnxruntime\n")
    return _onnxruntime(threads)
