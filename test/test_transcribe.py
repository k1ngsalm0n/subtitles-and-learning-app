"""Tests for the language-detection vote in server/transcribe.py.

Run from the project root with:  python -m unittest discover -s test
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "server"))

from transcribe import (  # noqa: E402
    DETECT_WINDOW,
    ZH_ACCEPT_PROB,
    ZH_WINDOW_PROB,
    _detect_language,
)


def accepted_as_chinese(language, zh_avg, zh_max):
    """Mirror of the CHINESE-ONLY gate in _transcribe_on."""
    return language == "zh" or zh_avg >= ZH_ACCEPT_PROB or zh_max >= ZH_WINDOW_PROB


class FakeModel:
    """Returns a scripted (language, prob, all_probs) per detect_language call."""

    def __init__(self, results):
        self.results = list(results)
        self.calls = []

    def detect_language(self, chunk):
        self.calls.append(len(chunk))
        lang, prob, all_probs = self.results[len(self.calls) - 1]
        return lang, prob, all_probs


def audio_of(seconds):
    return [0.0] * (seconds * 16000)


class DetectLanguageTest(unittest.TestCase):
    def test_short_clip_uses_single_window(self):
        model = FakeModel([("zh", 0.9, [("zh", 0.9), ("en", 0.05)])])
        lang, prob, zh_avg, zh_max = _detect_language(model, audio_of(20))
        self.assertEqual(len(model.calls), 1)
        self.assertEqual(lang, "zh")
        self.assertAlmostEqual(prob, 0.9)
        self.assertAlmostEqual(zh_avg, 0.9)
        self.assertAlmostEqual(zh_max, 0.9)

    def test_long_clip_probes_three_windows(self):
        model = FakeModel(
            [
                ("en", 0.8, [("en", 0.8), ("zh", 0.1)]),
                ("en", 0.7, [("en", 0.7), ("zh", 0.2)]),
                ("en", 0.9, [("en", 0.9), ("zh", 0.05)]),
            ]
        )
        lang, prob, zh_avg, zh_max = _detect_language(model, audio_of(94))
        self.assertEqual(len(model.calls), 3)
        # Every window is capped at Whisper's 30 s detection span.
        self.assertTrue(all(c <= DETECT_WINDOW for c in model.calls))
        self.assertEqual(lang, "en")
        self.assertAlmostEqual(prob, 0.8)
        self.assertAlmostEqual(zh_max, 0.2)
        self.assertFalse(accepted_as_chinese(lang, zh_avg, zh_max))

    def test_noisy_intro_outvoted_by_chinese_speech(self):
        # Real-world shape of the bug: a storm/music opening detects as a
        # low-confidence "en", while the rest of the clip is clearly Chinese.
        model = FakeModel(
            [
                ("en", 0.40, [("en", 0.40), ("nn", 0.26), ("zh", 0.08)]),
                ("zh", 0.74, [("zh", 0.74), ("ja", 0.08)]),
                ("zh", 0.85, [("zh", 0.85), ("en", 0.06)]),
            ]
        )
        lang, _prob, zh_avg, zh_max = _detect_language(model, audio_of(94))
        self.assertEqual(lang, "zh")
        self.assertTrue(accepted_as_chinese(lang, zh_avg, zh_max))

    def test_single_confident_zh_window_wins_over_ambience(self):
        # Speech buried mid-clip between long stretches of ambience: the
        # average stays low, but one window is unambiguously Chinese.
        model = FakeModel(
            [
                ("en", 0.56, [("en", 0.56), ("zh", 0.02)]),
                ("zh", 0.60, [("zh", 0.60), ("en", 0.03)]),
                ("en", 0.35, [("en", 0.35), ("zh", 0.02)]),
            ]
        )
        lang, _prob, zh_avg, zh_max = _detect_language(model, audio_of(94))
        self.assertEqual(lang, "en")  # en still wins the raw vote…
        self.assertLess(zh_avg, ZH_ACCEPT_PROB)  # …and the average is low…
        self.assertGreaterEqual(zh_max, ZH_WINDOW_PROB)  # …but one window is sure
        self.assertTrue(accepted_as_chinese(lang, zh_avg, zh_max))

    def test_zh_runner_up_still_passes_accept_threshold(self):
        # zh loses the vote but keeps a solid averaged probability: the caller
        # should accept it (zh_avg >= ZH_ACCEPT_PROB), not reject the clip.
        model = FakeModel(
            [
                ("en", 0.5, [("en", 0.5), ("zh", 0.4)]),
                ("en", 0.5, [("en", 0.5), ("zh", 0.4)]),
                ("en", 0.5, [("en", 0.5), ("zh", 0.4)]),
            ]
        )
        lang, _prob, zh_avg, zh_max = _detect_language(model, audio_of(94))
        self.assertEqual(lang, "en")
        self.assertTrue(accepted_as_chinese(lang, zh_avg, zh_max))

    def test_confidently_foreign_clip_is_rejected(self):
        model = FakeModel(
            [
                ("en", 0.9, [("en", 0.9), ("zh", 0.01)]),
                ("en", 0.95, [("en", 0.95), ("zh", 0.01)]),
                ("en", 0.92, [("en", 0.92), ("zh", 0.02)]),
            ]
        )
        lang, _prob, zh_avg, zh_max = _detect_language(model, audio_of(94))
        self.assertEqual(lang, "en")
        self.assertFalse(accepted_as_chinese(lang, zh_avg, zh_max))

    def test_two_windows_when_clip_barely_exceeds_one(self):
        # 40 s clip: start and end windows overlap, middle collapses into them.
        model = FakeModel(
            [
                ("zh", 0.6, [("zh", 0.6)]),
                ("zh", 0.7, [("zh", 0.7)]),
                ("zh", 0.7, [("zh", 0.7)]),
            ]
        )
        lang, _prob, _zh_avg, _zh_max = _detect_language(model, audio_of(40))
        self.assertEqual(lang, "zh")
        self.assertLessEqual(len(model.calls), 3)


if __name__ == "__main__":
    unittest.main()
