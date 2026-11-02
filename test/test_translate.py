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


class OpusRoutingTest(unittest.TestCase):
    def test_app_pairs_route_to_opus(self):
        from translate import OPUS_MODELS

        self.assertIn(("zh", "en"), OPUS_MODELS)
        self.assertIn(("en", "zh"), OPUS_MODELS)
        # Other pairs stay on the NLLB path.
        self.assertNotIn(("ja", "en"), OPUS_MODELS)


class ToSimplifiedTest(unittest.TestCase):
    def test_traditional_converts_via_cedict_pairs(self):
        from translate import to_simplified

        # 學習/学习 is in the bundled seed dictionary, so this holds even
        # without the full CC-CEDICT download.
        self.assertEqual(to_simplified("學習"), "学习")

    def test_simplified_and_non_chinese_pass_through(self):
        from translate import to_simplified

        self.assertEqual(to_simplified("学习 abc 123"), "学习 abc 123")


class OpusRouteTableTest(unittest.TestCase):
    """OPUS_ROUTES: (from, to) -> model, plus a target token for multi-target
    group models (docs/language-models.md)."""

    def test_only_the_chinese_pairs_are_routed_so_far(self):
        from translate import OPUS_ROUTES, opus_route

        self.assertEqual(set(OPUS_ROUTES), {("zh", "en"), ("en", "zh")})
        self.assertIsNone(opus_route("ja", "en"))
        for route in OPUS_ROUTES.values():
            self.assertTrue(route["model"].startswith("Helsinki-NLP/"))

    def test_token_is_prepended_and_follows_the_chinese_script(self):
        from unittest import mock

        from translate import opus_prefix, opus_route

        self.assertEqual(opus_prefix(opus_route("zh", "en")), "")
        with mock.patch.dict(os.environ, {"ZH_SCRIPT": "trad"}):
            self.assertEqual(opus_prefix(opus_route("en", "zh")), ">>cmn_Hant<< ")
        with mock.patch.dict(os.environ, {"ZH_SCRIPT": "off"}):
            self.assertEqual(opus_prefix(opus_route("en", "zh")), ">>cmn_Hans<< ")
        # A group model, as a per-language entry would add it.
        group = {"model": "Helsinki-NLP/opus-mt-tc-big-en-zle", "token": "rus"}
        self.assertEqual(opus_prefix(group), ">>rus<< ")
        self.assertEqual(opus_prefix("Helsinki-NLP/opus-mt-zh-en"), "")

    def test_every_sentence_goes_to_the_model_with_the_token(self):
        from unittest import mock

        import translate

        seen = []

        class FakeTokenizer:
            def __call__(self, pieces, **_kw):
                seen.extend(pieces)

                class Batch(dict):
                    def to(self, _device):
                        return self

                return Batch()

            def batch_decode(self, out, skip_special_tokens=True):
                return [f"t{i}" for i in range(len(out))]

        class FakeModel:
            def generate(self, **_kw):
                return list(range(len(seen)))

        group = {"model": "Helsinki-NLP/opus-mt-tc-bible-big-deu_eng_fra_por_spa-inc", "token": "hin"}
        with mock.patch.object(translate, "get_opus", return_value=(FakeTokenizer(), FakeModel(), "cpu")):
            out = translate.translate_batch_opus(["Hello.", "Good night."], group)
        self.assertEqual(seen, [">>hin<< Hello.", ">>hin<< Good night."])
        self.assertEqual(len(out), 2)
