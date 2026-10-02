"""scripts/subtitle_audit.py: parsing import results and flagging segments."""

import json
import os
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))

import subtitle_audit as A  # noqa: E402

SRT = """1
00:00:00,360 --> 00:00:03,240
高架橋上停滿轎車,但這回不是塞車,

2
00:00:03,240 --> 00:00:04,600
而是為了躲颱風。
"""


class ParseTest(unittest.TestCase):
    def test_srt_timings_and_text(self):
        self.assertEqual(
            A.parse_srt(SRT),
            [(0.36, 3.24, "高架橋上停滿轎車,但這回不是塞車,"), (3.24, 4.6, "而是為了躲颱風。")],
        )

    def test_multi_line_blocks_keep_their_lines(self):
        srt = "1\n00:00:14,000 --> 00:00:19,000\n第一行字幕\n第二行字幕\n"
        self.assertEqual(A.parse_srt(srt)[0][2], "第一行字幕\n第二行字幕")

    def test_every_saved_form_loads(self):
        stream = "\n".join([
            json.dumps({"stage": "progress", "message": "Reading the link…"}),
            json.dumps({"stage": "done", "subtitles": SRT, "source": "whisper"}),
        ])
        with tempfile.TemporaryDirectory() as tmp:
            for name, body in [("a.json", stream), ("b.srt", SRT)]:
                path = os.path.join(tmp, name)
                with open(path, "w", encoding="utf-8") as f:
                    f.write(body)
                result = A.load_result(path)
                self.assertEqual(result["stage"], "done", name)
                self.assertEqual(len(A.parse_srt(result["subtitles"])), 2, name)


class FlagsTest(unittest.TestCase):
    def flags(self, *segments):
        return A.flags_for(list(segments))

    def test_clean_speech_raises_nothing(self):
        self.assertEqual(self.flags((0.36, 3.24, "高架橋上停滿轎車"), (3.24, 4.6, "而是為了躲颱風")), {})

    def test_overlap_and_long_gap(self):
        found = self.flags((0, 3, "第一句話"), (2.5, 5, "第二句話"), (20, 23, "第三句話"))
        self.assertIn("overlaps previous", found[1][0])
        self.assertIn("gap before", found[2][0])

    def test_a_headline_squeezed_into_a_pause_reads_too_fast(self):
        # The banner #127 removed: 18 characters in 1.16 s.
        found = self.flags((57.84, 59.0, '防吹跑!浙江工廠架10公尺鐵桶護"羅漢松'))
        self.assertTrue(any("too fast" in f for f in found[0]))

    def test_short_lines_and_lines_without_chinese(self):
        found = self.flags((0, 0.5, "好"), (1, 4, "SOCIAL MEDIA"))
        self.assertTrue(any("only" in f for f in found[0]))
        self.assertTrue(any("no Chinese" in f for f in found[1]))

    def test_a_long_unpaced_block_and_a_stretched_hallucination(self):
        found = self.flags((0, 8, "第一行字幕\n第二行字幕"), (10, 40, "中文字幕"))
        self.assertTrue(any("not paced" in f for f in found[0]))
        self.assertTrue(any("slower than speech" in f for f in found[1]))


if __name__ == "__main__":
    unittest.main()
