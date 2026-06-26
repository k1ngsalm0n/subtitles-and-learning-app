"""Tests for the pure parsing helpers in server/translate.py.

Run from the project root with:  python -m unittest discover -s test
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "server"))

from translate import parse_srt  # noqa: E402


class ParseSrtTest(unittest.TestCase):
    def test_parses_index_timestamp_and_content(self):
        srt = "1\n00:00:00,000 --> 00:00:02,000\nHello world"
        self.assertEqual(
            parse_srt(srt),
            [("1", "00:00:00,000 --> 00:00:02,000", "Hello world")],
        )

    def test_parses_multiple_blocks(self):
        srt = (
            "1\n00:00:00,000 --> 00:00:02,000\nFirst\n\n"
            "2\n00:00:02,000 --> 00:00:04,000\nSecond"
        )
        entries = parse_srt(srt)
        self.assertEqual(len(entries), 2)
        self.assertEqual(entries[1][0], "2")
        self.assertEqual(entries[1][2], "Second")

    def test_joins_multiline_content(self):
        srt = "1\n00:00:00,000 --> 00:00:02,000\nline one\nline two"
        self.assertEqual(parse_srt(srt)[0][2], "line one\nline two")

    def test_drops_blocks_with_fewer_than_three_lines(self):
        # A block missing its content line is skipped entirely.
        srt = (
            "1\n00:00:00,000 --> 00:00:02,000\n\n"
            "2\n00:00:02,000 --> 00:00:04,000\nKept"
        )
        entries = parse_srt(srt)
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0][0], "2")

    def test_tolerates_blank_lines_and_surrounding_whitespace(self):
        srt = "\n\n1\n00:00:00,000 --> 00:00:02,000\nHi\n\n\n"
        self.assertEqual(len(parse_srt(srt)), 1)

    def test_empty_input_yields_no_entries(self):
        self.assertEqual(parse_srt(""), [])
        self.assertEqual(parse_srt("   \n\n  "), [])


if __name__ == "__main__":
    unittest.main()
