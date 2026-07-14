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

# Which Whisper model to load. "auto" (the default) sizes the model to the
# machine so the app runs well out of the box on anyone's hardware — see
# _resolve_model(). Set WHISPER_MODEL to a concrete name (tiny/base/small/
# medium/large-v3) to force one regardless of device.
MODEL = os.environ.get("WHISPER_MODEL", "auto")
# Bias Chinese output toward Traditional characters (Taiwan/HK content), matching
# the old two-pass pipeline — but applied in a single pass here.
ZH_PROMPT = "以下是繁體中文的內容。"


# CHINESE-ONLY (temporary): the app is scoped to Chinese for now, so audio in
# any other language is rejected rather than transcribed. Remove this guard and
# restore the general transcription path when re-enabling other languages.
# See https://github.com/k1ngsalm0n/subtitles-and-learning-app/issues/65
class UnsupportedLanguage(Exception):
    def __init__(self, language):
        self.language = language
        super().__init__(f"unsupported transcription language: {language}")


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


def _free_vram_mib():
    """Best-effort free VRAM in MiB via nvidia-smi, or None if undeterminable."""
    import subprocess

    try:
        out = subprocess.run(
            ["nvidia-smi", "--query-gpu=memory.free",
             "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=5,
        )
        return int(out.stdout.strip().split("\n")[0])
    except Exception:
        return None


def _resolve_model(device):
    """Resolve the model name, expanding "auto" to fit the actual device.

    The goal is a good experience on any machine without manual tuning:
      * CPU-only  -> "small": light (~0.5 GB) and quick enough to be usable;
                     bigger models are punishingly slow without a GPU.
      * GPU       -> "large-v3" when there's VRAM for it (best accuracy, and the
                     GPU keeps it fast), stepping down to medium/small on smaller
                     cards. VRAM is checked live so a busy GPU doesn't OOM.
    A concrete WHISPER_MODEL always wins over this.
    """
    requested = os.environ.get("WHISPER_MODEL", "auto")
    if requested and requested != "auto":
        return requested
    if device != "cuda":
        return "small"
    free = _free_vram_mib()
    if free is None:
        return "medium"  # GPU present but VRAM unknown: safe middle ground
    if free >= 4000:
        return "large-v3"
    if free >= 2200:
        return "medium"
    return "small"


def _decode_audio(path):
    try:
        from faster_whisper import decode_audio
    except ImportError:
        from faster_whisper.audio import decode_audio
    return decode_audio(path, sampling_rate=16000)


SAMPLE_RATE = 16000
DETECT_WINDOW = 30 * SAMPLE_RATE  # Whisper's detector only ever sees 30 s
# Language detection always runs on the small model, even when transcription
# uses a bigger one. large-v3's language ID is unreliable on noisy audio (it
# called a Chinese typhoon report "en"/"tr" from the storm bed, where small
# scored zh 0.74–0.85 on the same windows) — and small's detection is cheap.
DETECT_MODEL = "small"
# A clip counts as Chinese if zh wins the vote outright, or holds at least this
# averaged probability while the winner is a low-confidence guess. Genuine
# foreign-language audio scores zh well under 0.1; Chinese speech behind a
# noisy window still averages above this.
ZH_ACCEPT_PROB = 0.25
# …or if any single window is confidently Chinese. A clip whose speech sits in
# the middle of long ambience (a typhoon report: storm noise, speech, storm
# noise) averages low overall, but the speech window itself is unambiguous —
# and non-Chinese audio essentially never scores zh this high on any window.
ZH_WINDOW_PROB = 0.5


def _detect_language(model, audio):
    """Detect the clip's language from several windows, not just the opening.

    Whisper's detect_language samples only the first 30 seconds, and clips
    often open with a music bed or ambience (news intros, storm footage) that
    detects as a random low-confidence language. Probe up to three windows —
    start, middle, end — and average per-language probabilities so a noisy
    opening can't outvote the actual speech.

    Returns (language, averaged_probability, averaged_zh_probability,
    max_single_window_zh_probability).
    """
    starts = {0}
    if len(audio) > DETECT_WINDOW:
        starts.add(max(0, (len(audio) - DETECT_WINDOW) // 2))
        starts.add(len(audio) - DETECT_WINDOW)
    totals = {}
    zh_max = 0.0
    for start in sorted(starts):
        _lang, _prob, all_probs = model.detect_language(
            audio[start : start + DETECT_WINDOW]
        )
        for lang, prob in all_probs:
            totals[lang] = totals.get(lang, 0.0) + prob
            if lang == "zh":
                zh_max = max(zh_max, prob)
    best = max(totals, key=totals.get)
    n = len(starts)
    return best, totals[best] / n, totals.get("zh", 0.0) / n, zh_max


def _transcribe_on(device, audio):
    from faster_whisper import WhisperModel

    # Resolve "auto" against the *actual* device, so a GPU->CPU OOM retry also
    # drops to a CPU-appropriate (smaller) model instead of re-loading the big one.
    model_name = _resolve_model(device)
    sys.stderr.write(f"transcribing with model={model_name} on {device}\n")
    sys.stderr.flush()
    # Detect the language up front so we can transcribe ONCE with the right
    # prompt, instead of the old detect-then-re-run-for-Traditional two passes.
    # Detection runs on DETECT_MODEL (see above) and, when the audio is
    # rejected, the transcription model is never loaded at all.
    detector = WhisperModel(
        DETECT_MODEL, device=device, compute_type=_compute_type()
    )
    language, prob, zh_avg, zh_max = _detect_language(detector, audio)
    sys.stderr.write(
        f"language vote: {language} p={prob:.2f} "
        f"(zh avg={zh_avg:.2f} max={zh_max:.2f})\n"
    )
    sys.stderr.flush()

    # CHINESE-ONLY (temporary): reject non-Chinese audio so we don't emit a
    # garbage transcript in a language we aren't focusing on yet. See issue #65.
    if language != "zh" and zh_avg < ZH_ACCEPT_PROB and zh_max < ZH_WINDOW_PROB:
        raise UnsupportedLanguage(language)
    model = (
        detector
        if model_name == DETECT_MODEL
        else WhisperModel(model_name, device=device, compute_type=_compute_type())
    )
    segments, info = model.transcribe(
        audio,
        language="zh",
        initial_prompt=ZH_PROMPT,
        beam_size=5,
        # --- Anti-hallucination settings ---
        # Whisper's worst failure mode on short clips (news intros, music stings,
        # silence) is inventing fluent text that has nothing to do with the audio
        # — and, crucially, fixating on it: with condition_on_previous_text the
        # model feeds its own last output forward, so one wrong phrase ("South
        # Korea") gets echoed across every later segment. Turning that off makes
        # each window independent, so a stray hallucination can't snowball.
        condition_on_previous_text=False,
        # NOTE: deliberately NOT using vad_filter. Silero VAD treats a music bed
        # under speech (news-broadcast intros, on-screen segues) as non-speech and
        # drops the narration with it — that swallowed this video's whole intro
        # and stamped the first surviving line at 0.00, desyncing everything after.
        # The thresholds below suppress silence/music hallucinations without VAD.
        # Temperature fallback: when a window decodes as low-confidence or
        # repetitive garbage, retry hotter, then drop it instead of emitting it.
        temperature=[0.0, 0.2, 0.4, 0.6, 0.8, 1.0],
        compression_ratio_threshold=2.4,  # repetitive output -> treat as failed
        log_prob_threshold=-1.0,          # very low-confidence -> treat as failed
        no_speech_threshold=0.6,          # likely-silence window -> emit nothing
        # Derive timings from word-level alignment, not Whisper's coarse timestamp
        # tokens. Without this, the first 30 s window of a broadcast collapses into
        # one giant segment stamped from 0.00 (e.g. the opening line lands at 0.00
        # instead of ~17 s), which desyncs the whole transcript against the video.
        # Alignment pins each segment to when its words are actually spoken.
        word_timestamps=True,
    )
    # --- General multi-language path (restore when re-enabling, see #65): ---
    # prompt = ZH_PROMPT if language == "zh" else None
    # segments, info = model.transcribe(
    #     audio, language=language, initial_prompt=prompt, beam_size=5,
    # )
    segs = [
        {
            "start": float(s.start),
            "end": float(s.end),
            "text": s.text,
            # The decoder's own confidence; the caller uses it to tell garbled
            # attempts at unintelligible speech (dialect under storm noise)
            # from clean transcription, and shows a placeholder instead.
            "logprob": float(s.avg_logprob),
        }
        for s in segments
    ]
    return {"language": info.language, "segments": segs}


def transcribe(audio_path):
    audio = _decode_audio(audio_path)
    device = _select_device()
    if device != "cpu":
        try:
            return _transcribe_on(device, audio)
        except UnsupportedLanguage:
            raise  # not a device problem — CPU wouldn't help, and #65 gates it
        except Exception as exc:  # OOM / driver — CPU still works
            sys.stderr.write(
                f"faster-whisper on {device} failed ({exc}); retrying on CPU.\n"
            )
            sys.stderr.flush()
    return _transcribe_on("cpu", audio)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("audio", help="path to an audio file")
    args = ap.parse_args()
    try:
        result = transcribe(args.audio)
    except UnsupportedLanguage as exc:
        # Structured, machine-readable signal for server/import.mjs (see #65).
        json.dump(
            {"error": "unsupported_language", "language": exc.language},
            sys.stdout,
            ensure_ascii=False,
        )
        sys.stdout.write("\n")
        return
    json.dump(result, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
