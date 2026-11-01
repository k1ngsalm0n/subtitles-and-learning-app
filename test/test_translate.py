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

    # Not a fixed list of pairs: each language PR adds its own lines, and a
    # list here would make every one of them edit this test.
    def test_routes_are_well_formed_and_cover_the_chinese_pairs(self):
        from translate import LANG_CODE_MAP, OPUS_ROUTES, opus_route

        self.assertLessEqual({("zh", "en"), ("en", "zh")}, set(OPUS_ROUTES))
        self.assertIsNone(opus_route("ja", "en"), "Japanese stays on NLLB (language-models.md)")
        for (src, tgt), route in OPUS_ROUTES.items():
            self.assertIn(src, LANG_CODE_MAP)
            self.assertIn(tgt, LANG_CODE_MAP)
            self.assertTrue(route["model"].startswith("Helsinki-NLP/opus-mt-"))
            self.assertLessEqual(set(route), {"model", "token"})

    def test_spanish_routes(self):
        from translate import opus_prefix, opus_route

        # Single-target models: no >>id<< token.
        self.assertEqual(opus_route("es", "en")["model"], "Helsinki-NLP/opus-mt-tc-bible-big-roa-en")
        self.assertEqual(opus_route("en", "es")["model"], "Helsinki-NLP/opus-mt-tc-big-en-es")
        self.assertEqual(opus_prefix(opus_route("es", "en")), "")
        self.assertEqual(opus_prefix(opus_route("en", "es")), "")
        # No dedicated model into Chinese: NLLB (or the chat model).
        self.assertIsNone(opus_route("es", "zh"))

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
        with mock.patch.object(translate, "get_ct2", return_value=None), mock.patch.object(
            translate, "get_opus", return_value=(FakeTokenizer(), FakeModel(), "cpu")
        ):
            out = translate.translate_batch_opus(["Hello.", "Good night."], group)
        self.assertEqual(seen, [">>hin<< Hello.", ">>hin<< Good night."])
        self.assertEqual(len(out), 2)


class CTranslate2PathTest(unittest.TestCase):
    """The CPU path. Fakes only: CI has no models and must not download one."""

    class FakeTokenizer:
        src_lang = None

        def encode(self, text, **_kw):
            return list(text)

        def convert_ids_to_tokens(self, ids):
            return list(ids)

        def convert_tokens_to_ids(self, tokens):
            return list(tokens)

        def decode(self, ids, skip_special_tokens=True):
            return "".join(ids).upper()

    class FakeTranslator:
        def __init__(self):
            self.calls = []

        def translate_batch(self, tokens, **kw):
            self.calls.append((tokens, kw))

            class Result:
                def __init__(self, hyp):
                    self.hypotheses = [hyp]

            prefix = kw.get("target_prefix")
            return [Result((prefix[i] if prefix else []) + list(t)) for i, t in enumerate(tokens)]

    def test_opus_goes_through_ctranslate2_with_the_token_in_the_text(self):
        from unittest import mock

        import translate

        fake = self.FakeTranslator()
        group = {"model": "Helsinki-NLP/opus-mt-tc-big-en-zle", "token": "rus"}
        with mock.patch.object(translate, "get_ct2", return_value=fake), mock.patch.object(
            translate, "get_tokenizer", return_value=self.FakeTokenizer()
        ), mock.patch.object(translate, "get_opus", side_effect=AssertionError("torch loaded")):
            out = translate.translate_batch_opus(["hi."], group)
        self.assertEqual(out, [">>RUS<< HI."])
        tokens, kw = fake.calls[0]
        self.assertEqual("".join(tokens[0]), ">>rus<< hi.")
        self.assertEqual(kw["beam_size"], translate.NUM_BEAMS)
        self.assertEqual(kw["no_repeat_ngram_size"], translate.NO_REPEAT_NGRAM)
        self.assertIsNone(kw["target_prefix"])

    def test_nllb_target_language_is_the_first_decoded_token_and_is_dropped(self):
        from unittest import mock

        import translate

        fake = self.FakeTranslator()
        tok = self.FakeTokenizer()
        with mock.patch.object(translate, "get_ct2", return_value=fake), mock.patch.object(
            translate, "get_tokenizer", return_value=tok
        ), mock.patch.object(translate, "get_model", side_effect=AssertionError("torch loaded")):
            out = translate.translate_batch(["hola"], "spa_Latn", "eng_Latn")
        self.assertEqual(out, ["HOLA"])
        self.assertEqual(tok.src_lang, "spa_Latn")
        self.assertEqual(fake.calls[0][1]["target_prefix"], [["eng_Latn"]])

    def test_torch_is_used_when_asked_or_off_the_cpu(self):
        from unittest import mock

        import translate

        with mock.patch.dict(os.environ, {"TRANSLATE_ENGINE": "torch"}):
            self.assertFalse(translate._ct2_wanted())
        with mock.patch.dict(os.environ, {"TRANSLATE_ENGINE": "", "TRANSLATE_DEVICE": "cuda"}):
            self.assertFalse(translate._ct2_wanted())
        with mock.patch.dict(os.environ, {"TRANSLATE_ENGINE": "", "TRANSLATE_DEVICE": ""}):
            self.assertTrue(translate._ct2_wanted())

    def test_a_failed_conversion_falls_back_to_torch_and_is_not_retried(self):
        import tempfile
        from unittest import mock

        import translate

        name = "Helsinki-NLP/not-a-real-model"
        translate._ct2_failed.discard(name)
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(translate, "CT2_DIR", tmp), mock.patch.dict(
            os.environ, {"TRANSLATE_ENGINE": "", "TRANSLATE_DEVICE": ""}
        ), mock.patch(
            "ctranslate2.converters.TransformersConverter", side_effect=OSError("offline")
        ), mock.patch("sys.stderr"):
            self.assertIsNone(translate.get_ct2(name))
            self.assertIn(name, translate._ct2_failed)
            self.assertEqual(os.listdir(tmp), [])
            self.assertIsNone(translate.get_ct2(name))
