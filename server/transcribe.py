#!/usr/bin/env python3
"""Transcribe audio with faster-whisper (CTranslate2).

Same Whisper model weights as openai-whisper, but a much faster inference engine
— so transcription speeds up several-fold at essentially the same accuracy. Used
by server/import.mjs, which falls back to the openai-whisper CLI if this (or its
dependency) is unavailable.

Prints one line of JSON to stdout: {"language": str, "segments": [{"start",
"end", "text"}]}. Diagnostics go to stderr.
"""

import argparse
import json
import os
import sys

MODEL = os.environ.get("WHISPER_MODEL", "base")
# Bias Chinese output toward Traditional characters (Taiwan/HK content), matching
# the old two-pass pipeline — but applied in a single pass here.
ZH_PROMPT = "以下是繁體中文的內容。"


def _select_device():
    forced = os.environ.get("WHISPER_DEVICE")
    if forced:
        return forced
    try:
        import ctranslate2

        if ctranslate2.get_cuda_device_count() > 0:
            return "cuda"
    except Exception:
        pass
    return "cpu"


def _compute_type():
    # int8 is fast and low-memory on both CPU and GPU with negligible accuracy
    # loss for transcription (and this GPU class has no fast float16 anyway).
    return os.environ.get("WHISPER_COMPUTE_TYPE", "int8")


def _decode_audio(path):
    try:
        from faster_whisper import decode_audio
    except ImportError:
        from faster_whisper.audio import decode_audio
    return decode_audio(path, sampling_rate=16000)


def _transcribe_on(device, audio):
    from faster_whisper import WhisperModel

    model = WhisperModel(MODEL, device=device, compute_type=_compute_type())
    # Detect the language up front so we can transcribe ONCE with the right
    # prompt, instead of the old detect-then-re-run-for-Traditional two passes.
    language, _prob, _all = model.detect_language(audio)
    prompt = ZH_PROMPT if language == "zh" else None
    segments, info = model.transcribe(
        audio,
        language=language,
        initial_prompt=prompt,
        beam_size=5,
    )
    segs = [
        {"start": float(s.start), "end": float(s.end), "text": s.text}
        for s in segments
    ]
    return {"language": info.language, "segments": segs}


def transcribe(audio_path):
    audio = _decode_audio(audio_path)
    device = _select_device()
    if device != "cpu":
        try:
            return _transcribe_on(device, audio)
        except Exception as exc:  # OOM / driver / unsupported — CPU still works
            sys.stderr.write(
                f"faster-whisper on {device} failed ({exc}); retrying on CPU.\n"
            )
            sys.stderr.flush()
    return _transcribe_on("cpu", audio)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("audio", help="path to an audio file")
    args = ap.parse_args()
    json.dump(transcribe(args.audio), sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
