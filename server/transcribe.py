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

import happy_eyeballs  # noqa: F401 — RFC 8305 connect race (see module docstring)

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


def _cpu_threads():
    """How many cores CTranslate2 may use. 0 means "the library's own default".

    Left at 0 on a GPU box, where the CPU is free anyway. It exists because on
    a machine with no GPU this process and the OCR pass are both CPU-bound and
    each library, asked for nothing, takes every core — so the two fight, and
    the laptop running them becomes unusable while they do.
    """
    try:
        return max(0, int(os.environ.get("WHISPER_CPU_THREADS", "0")))
    except ValueError:
        return 0


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
# Repetitive output above this ratio counts as a failed decode: retried hotter
# during transcription, and reported as unintelligible if it never recovers.
COMPRESSION_RATIO_THRESHOLD = 2.4

# Progress goes to stderr, tagged, so server/import.mjs can pick it out of the
# ordinary diagnostics on the same pipe. stdout stays exactly one JSON line —
# the result — so nothing downstream has to learn a new output shape.
PROGRESS_PREFIX = "@progress "
# Each segment, the moment it is decoded, so the reader can start reading a
# nine-minute transcript at thirty seconds instead of at four minutes. Slim on
# purpose — no word timings — because these lines are provisional: the caller
# shows them marked as such and replaces the lot with the real result, which is
# the only thing that has been merged with the captions and script-converted.
SEGMENT_PREFIX = "@segment "


def _emit_segment(seg):
    sys.stderr.write(
        SEGMENT_PREFIX
        + json.dumps(
            {"start": seg["start"], "end": seg["end"], "text": seg["text"],
             "logprob": seg["logprob"]},
            ensure_ascii=False,
        )
        + "\n"
    )
    sys.stderr.flush()


def _emit_progress(done_seconds, total_seconds):
    """Report how much of the audio has been decoded.

    Honest as a fraction of *audio*, which is what the denominator says; it is
    not a prediction of remaining time, since a window that falls back to a
    hotter temperature costs more than a clean one. Emitted only when the whole
    percent moves, so a long clip sends ~100 lines rather than one per segment.
    """
    global _last_percent
    # `done >= total` is its own case rather than falling out of the division:
    # in floating point x * 100 / x can land on 99.999…, which truncates to 99
    # and — matching the previous reading — would suppress the line that
    # finishes the bar, leaving it stalled just short of the end.
    complete = done_seconds >= total_seconds or not total_seconds
    percent = 100 if complete else int(done_seconds * 100 / total_seconds)
    if percent == _last_percent:
        return
    _last_percent = percent
    sys.stderr.write(
        PROGRESS_PREFIX
        + json.dumps({"done": round(done_seconds, 2), "total": round(total_seconds, 2)})
        + "\n"
    )
    sys.stderr.flush()


_last_percent = -1


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


def _transcribe_on(device, audio, known_language=None):
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
        DETECT_MODEL, device=device, compute_type=_compute_type(),
        cpu_threads=_cpu_threads(),
    ) if model_name == DETECT_MODEL or known_language != "zh" else None
    if known_language == "zh":
        # The import already listened (detect(), above) and was confident; the
        # same vote over the same windows would only say it again.
        sys.stderr.write("language: zh (already detected by the import)\n")
        sys.stderr.flush()
    else:
        language, prob, zh_avg, zh_max = _detect_language(detector, audio)
        sys.stderr.write(
            f"language vote: {language} p={prob:.2f} "
            f"(zh avg={zh_avg:.2f} max={zh_max:.2f})\n"
        )
        sys.stderr.flush()

        # CHINESE-ONLY (temporary): reject non-Chinese audio so we don't emit a
        # garbage transcript in a language we aren't focusing on yet. See #65.
        if language != "zh" and zh_avg < ZH_ACCEPT_PROB and zh_max < ZH_WINDOW_PROB:
            raise UnsupportedLanguage(language)
    model = (
        detector
        if model_name == DETECT_MODEL
        else WhisperModel(
            model_name, device=device, compute_type=_compute_type(),
            cpu_threads=_cpu_threads(),
        )
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
        # repetitive garbage, retry hotter once, then give up and emit (the
        # caller masks anything under -0.8 as "(indistinct voice)"). The full
        # [0.0 … 1.0] ladder was measured on a noise-heavy clip (typhoon
        # footage, ~90 s of wind/rain): every window fails as a *confident
        # repetition loop* (logprob ≈ -0.1, compression ratio 30+, no-speech
        # ≈ 0.4 — so neither threshold can pre-skip it), walks all six
        # temperatures, and lands on t=1.0 babble that gets masked anyway —
        # 105 s of transcription for a 94 s clip, vs 23 s at t=0 alone.
        # Real speech stuck in a loop breaks at the first hot retry; the
        # deeper temperatures only ever "rescued" noise into sub-threshold
        # pseudo-text, so they bought nothing but time.
        temperature=[0.0, 0.2],
        compression_ratio_threshold=COMPRESSION_RATIO_THRESHOLD,
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
    duration = len(audio) / SAMPLE_RATE
    _emit_progress(0.0, duration)
    segs = []
    for s in segments:
        # `segments` is a generator: this loop is where decoding actually
        # happens, one window at a time, in time order. Reporting from inside
        # it is what turns a silent multi-minute wait into a moving bar.
        _emit_progress(min(float(s.end), duration), duration)
        seg = {
            "start": float(s.start),
            "end": float(s.end),
            "text": s.text,
            # The decoder's own confidence; the caller uses it to tell garbled
            # attempts at unintelligible speech (dialect under storm noise)
            # from clean transcription, and shows a placeholder instead.
            # A segment still failing the compression check after the retries
            # is a stuck repetition loop ("關於關於關於…") — the decoder is
            # *confident* in a loop, so its logprob is meaningless. Report it
            # as unintelligible or the caller's mask would print the loop.
            "logprob": (
                -9.0
                if s.compression_ratio > COMPRESSION_RATIO_THRESHOLD
                else float(s.avg_logprob)
            ),
        }
        # Out the door before the word timings are attached below: this line
        # exists to get text on screen early, and the timings are both the bulk
        # of the payload and useless until the final result carries them.
        _emit_segment(seg)
        # avg_logprob is computed once per ~30s decode window and copied onto
        # every segment carved out of it, so it can't see a brief hallucination
        # sitting inside an otherwise-clean window. Per-word probabilities are
        # already computed (word_timestamps=True, above) for cue timing, so
        # averaging them gives a real per-segment confidence at no extra cost.
        words = getattr(s, "words", None) or []
        word_probs = [w.probability for w in words if w.probability is not None]
        if word_probs:
            seg["wordProb"] = sum(word_probs) / len(word_probs)
        # The timings themselves, for the karaoke highlight (#26). They are
        # already computed above for cue alignment and for wordProb; without
        # them the reader has to assume every character takes equally long,
        # which drifts badly on any line that isn't spoken at an even pace.
        # Rounded because milliseconds are past what a highlight can show, and
        # this rides along in the browser's storage with the transcript.
        timed = [
            {"start": round(float(w.start), 3), "end": round(float(w.end), 3), "word": w.word}
            for w in words
            if w.start is not None and w.end is not None and w.word.strip()
        ]
        if timed:
            seg["words"] = timed
        segs.append(seg)
    # The last segment can end before the audio does (trailing silence, or a
    # window skipped by no_speech_threshold), so finish the bar explicitly
    # rather than leaving it stalled at 97%.
    _emit_progress(duration, duration)
    return {"language": info.language, "segments": segs}


def _detect_on(device, audio):
    from faster_whisper import WhisperModel

    detector = WhisperModel(
        DETECT_MODEL, device=device, compute_type=_compute_type(),
        cpu_threads=_cpu_threads(),
    )
    language, prob, zh_avg, zh_max = _detect_language(detector, audio)
    return {
        "language": language,
        "probability": round(prob, 3),
        "zhAvg": round(zh_avg, 3),
        "zhMax": round(zh_max, 3),
    }


def detect(audio_path):
    """Only the language vote, not the transcript: what the import asks when a
    video's metadata names no language and it has to tell the original
    subtitle track from a translation. The same windows and the same small
    model transcription itself votes with, so the two can't disagree."""
    audio = _decode_audio(audio_path)
    device = _select_device()
    if device != "cpu":
        try:
            return _detect_on(device, audio)
        except Exception as exc:  # OOM / driver — CPU still works
            sys.stderr.write(f"language detection on {device} failed ({exc}); retrying on CPU.\n")
            sys.stderr.flush()
    return _detect_on("cpu", audio)


def transcribe(audio_path, known_language=None):
    audio = _decode_audio(audio_path)
    device = _select_device()
    if device != "cpu":
        try:
            return _transcribe_on(device, audio, known_language)
        except UnsupportedLanguage:
            raise  # not a device problem — CPU wouldn't help, and #65 gates it
        except Exception as exc:  # OOM / driver — CPU still works
            sys.stderr.write(
                f"faster-whisper on {device} failed ({exc}); retrying on CPU.\n"
            )
            sys.stderr.flush()
    return _transcribe_on("cpu", audio, known_language)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("audio", help="path to an audio file")
    ap.add_argument(
        "--detect", action="store_true",
        help="only report the spoken language: {language, probability, zhAvg, zhMax}",
    )
    ap.add_argument(
        "--language",
        help="skip detection: the caller already knows the audio is this language "
        "(only 'zh' is acted on, since that's all the Chinese-only gate lets through)",
    )
    args = ap.parse_args()
    if args.detect:
        json.dump(detect(args.audio), sys.stdout)
        sys.stdout.write("\n")
        return
    try:
        result = transcribe(args.audio, args.language)
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
