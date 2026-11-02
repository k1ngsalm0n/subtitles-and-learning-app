"""Speak a phrase with piper, into a WAV file (server/speak.mjs).

Request (one JSON object):
    {"model": "/path/voice.onnx", "text": "...", "length_scale": 1.0, "out": "/tmp/x.wav"}
Reply:
    {"ok": true}

With --serve it stays running and answers one request per line
(server/pyworker.mjs), each reply carrying the request's "id". That matters
more here than for most workers: a Chinese voice that reads pinyin
(zh_CN-xiao_ya) loads g2pW, a BERT model, to choose each character's reading,
and `python -m piper` paid ~2.7 s for that on every press of a listen button.

Voices are kept loaded by path. Anything a voice needs to download (g2pW's
model) goes beside the voices rather than into whatever directory the server
happened to start in, which is where `python -m piper` puts it.
"""

import json
import sys
import wave
from pathlib import Path

_voices = {}


def _voice(model):
    voice = _voices.get(model)
    if voice is None:
        from piper import PiperVoice

        voice = PiperVoice.load(model, download_dir=Path(model).parent)
        _voices[model] = voice
    return voice


def speak(req):
    from piper import SynthesisConfig

    model = str(req["model"])
    text = str(req.get("text") or "").strip()
    if not text:
        raise ValueError("Nothing to say.")
    config = SynthesisConfig(length_scale=float(req.get("length_scale") or 1.0))
    with wave.open(str(req["out"]), "wb") as out:
        _voice(model).synthesize_wav(text, out, syn_config=config)
    return {"ok": True}


def serve(stdin=sys.stdin, stdout=sys.stdout):
    # Replies are the only thing on stdout: anything a library prints (a
    # download notice, a warning) goes to stderr, where the server logs it.
    sys.stdout = sys.stderr
    stdout.write(json.dumps({"ready": True}) + "\n")
    stdout.flush()
    for line in stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError:
            continue
        rid = req.get("id") if isinstance(req, dict) else None
        try:
            resp = {"id": rid, **speak(req)}
        except Exception as exc:  # noqa: BLE001 - the caller tries the next voice
            resp = {"id": rid, "error": f"{type(exc).__name__}: {exc}"}
        stdout.write(json.dumps(resp, ensure_ascii=False) + "\n")
        stdout.flush()


def main():
    if "--serve" in sys.argv[1:]:
        serve()
        return
    json.dump(speak(json.load(sys.stdin)), sys.stdout)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
