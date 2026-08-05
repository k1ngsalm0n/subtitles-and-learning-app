#!/usr/bin/env python3
"""Audit a whole transcript for holes — speech the transcriber never wrote down.

A dropped span is a stretch where someone is talking and no subtitle came out.
It is the hardest kind of bug to notice in this app, because a transcript with
a hole looks exactly like a transcript of a pause: the lines either side are
fine, the timings are consistent, nothing errors. You cannot see the absence of
something you never saw. Spot-checking cannot find it either — you would have
to happen to look at the right ten seconds.

So this walks the entire timeline and, for every gap, answers the only question
that matters: *was anyone speaking there?* It does that by re-transcribing the
gap on its own, several times, at slightly different window boundaries — and
the repetition is the entire point.

Whisper's answer for a short isolated span is **not stable**. Asked about the
same 4.16s gap with nothing changed but 0.2s of padding, it said:

    no_speech 0.010   "這段影片就分享到這裏吧,謝謝觀看,下次見"   <- classic hallucination
    no_speech 1.000   (nothing)
    no_speech 0.000   "一開始"
    no_speech 0.000   "道理開始"
    no_speech 0.443   "還有離開時"
    no_speech 0.993   "他要離開時踹了地上的"

Six windows, six answers, no_speech swinging the full range. So no_speech on a
single window proves nothing, and a fix keyed to one reading of it would inject
"謝謝觀看,下次見" into people's transcripts.

Real dropped speech looks completely different. The same probe on a genuinely
lost 5.97s span returned the identical sentence all six times, no_speech 0.000
throughout. **Agreement across windows is the signal; no_speech is noise.**
That is what this tool measures, and why it would rather say "unstable" than
give you a confident answer it cannot support.

    python scripts/transcript_audit.py clip.mp4
    python scripts/transcript_audit.py clip.mp4 --min-gap 1.5
    python scripts/transcript_audit.py a.mp4 b.mp4 --json out.json

Uses the app's own settings (server/transcribe.py), so what it audits is what
the app would actually produce.
"""

import argparse
import json
import re
import subprocess
import sys
import tempfile
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "server"))

# Above this much silence between two lines, ask whether it should be silence.
DEFAULT_MIN_GAP = 2.0
# Window offsets to probe each gap at. Real speech survives all of them
# unchanged; a hallucination is a different sentence every time.
PROBE_PADS = (0.0, 0.2, 0.4, 0.6, 0.8)
# How many probes must agree before we call it real. 3 of 5 is deliberately
# not a bare majority of one — two independent windows agreeing by chance on
# the same Chinese sentence does not happen; two agreeing because the audio
# says it does.
AGREE = 3


def duration(path):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "csv=p=0", str(path)],
        capture_output=True, text=True,
    )
    return float(out.stdout.strip())


def transcribe_file(path):
    import transcribe as T

    return T.transcribe(str(path))["segments"]


def load_model():
    import transcribe as T
    from faster_whisper import WhisperModel

    # Same model the main pass used, or the comparison means nothing: a bigger
    # model finding speech a smaller one missed is a different finding entirely.
    device = T._select_device()
    return T, WhisperModel(
        T._resolve_model(device), device=device, compute_type=T._compute_type()
    )


def _decode_once(T, model, media, start, end, workdir):
    clip = Path(workdir) / f"span_{start:.2f}_{end:.2f}.wav"
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-ss", str(start), "-t", str(end - start),
         "-i", str(media), "-ac", "1", "-ar", "16000", str(clip)],
        check=True,
    )
    segments, _ = model.transcribe(
        str(clip), language="zh", initial_prompt=T.ZH_PROMPT, beam_size=5,
        condition_on_previous_text=False, temperature=[0.0, 0.2],
        compression_ratio_threshold=T.COMPRESSION_RATIO_THRESHOLD,
        log_prob_threshold=-1.0, no_speech_threshold=0.6, word_timestamps=True,
    )
    return " ".join(s.text.strip() for s in segments)


def _key(text):
    """Compare on characters alone — the probes differ freely in punctuation."""
    return re.sub(r"[\s,.，。、!?！？]+", "", text)


def probe_gap(T, model, media, start, end, workdir):
    """Decode the gap at several window boundaries and see if they agree.

    Returns (agreement, total, text). A gap that really contains speech gives
    the same answer every time; one that doesn't gives a different invention
    each time, so no answer wins.
    """
    readings = [
        _decode_once(T, model, media, max(start - pad, 0.0), end + pad, workdir)
        for pad in PROBE_PADS
    ]
    tally = Counter(_key(r) for r in readings if _key(r))
    if not tally:
        return 0, len(readings), ""
    winner, count = tally.most_common(1)[0]
    text = next(r for r in readings if _key(r) == winner)
    return count, len(readings), text


def audit(media, min_gap, workdir):
    total = duration(media)
    segments = transcribe_file(media)
    covered = sum(s["end"] - s["start"] for s in segments)

    gaps = []
    previous = 0.0
    for s in segments:
        if s["start"] - previous >= min_gap:
            gaps.append((previous, s["start"]))
        previous = s["end"]
    if total - previous >= min_gap:
        gaps.append((previous, total))  # the tail counts; it is easiest to lose

    print(f"\n=== {Path(media).name} ===")
    print(f"{len(segments)} segments, {covered:.1f}s of {total:.1f}s "
          f"({100 * covered / total:.0f}% covered), {len(gaps)} gap(s) >= {min_gap}s")

    if not gaps:
        print("  no gaps to check")
        return {"file": str(media), "duration": total, "segments": len(segments),
                "coverage": covered / total, "gaps": []}

    T, model = load_model()
    rows = []
    print(f"\n  {'span':>18} {'length':>7} {'agree':>7}  verdict")
    for start, end in gaps:
        agree, probes, text = probe_gap(T, model, media, start, end, workdir)
        dropped = agree >= AGREE
        verdict = "DROPPED SPEECH" if dropped else "no consistent speech"
        print(f"  {start:7.2f} -> {end:7.2f} {end - start:7.2f} {agree:4}/{probes:<2}  {verdict}")
        if dropped:
            print(f"  {'':18} {'':7} {'':7}  lost: {text[:52]!r}")
        rows.append({"start": start, "end": end, "length": end - start,
                     "agree": agree, "probes": probes, "dropped": dropped,
                     "text": text if dropped else ""})

    lost = [r for r in rows if r["dropped"]]
    if lost:
        print(f"\n  {len(lost)} dropped span(s), {sum(r['length'] for r in lost):.1f}s of "
              f"speech missing from the transcript")
    else:
        print("\n  no gap produced a consistent reading — nothing recoverable found")
    return {"file": str(media), "duration": total, "segments": len(segments),
            "coverage": covered / total, "gaps": rows}


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("media", nargs="+", type=Path, help="video or audio files")
    parser.add_argument("--min-gap", type=float, default=DEFAULT_MIN_GAP,
                        help=f"seconds of silence worth questioning (default {DEFAULT_MIN_GAP})")
    parser.add_argument("--json", type=Path, help="write the full result here")
    args = parser.parse_args()

    for path in args.media:
        if not path.exists():
            parser.error(f"no such file: {path}")

    results = []
    with tempfile.TemporaryDirectory(prefix="transcript-audit-") as workdir:
        for path in args.media:
            results.append(audit(path, args.min_gap, workdir))

    if args.json:
        args.json.write_text(json.dumps(results, ensure_ascii=False, indent=2), "utf-8")
        print(f"\nWrote {args.json}")


if __name__ == "__main__":
    main()
