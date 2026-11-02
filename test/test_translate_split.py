import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "server"))

from translate import _split_for_model, _translate_split  # noqa: E402

LIMIT = 120


class SplitTests(unittest.TestCase):
    """The splitter exists because these models are trained on sentences.

    Handed a paragraph, Marian doesn't truncate so much as stop early: the tail
    of a 240-character line stopped appearing while the output was still only
    ~120 tokens, nowhere near the 256-token cap. So the pieces have to be
    sentence-shaped, and putting them back together has to be lossless.
    """

    def test_a_short_line_is_left_alone(self):
        text = "这艘战列舰在一九零九年开始建造。"
        self.assertEqual(_split_for_model(text), [text])

    def test_pieces_always_rebuild_the_line(self):
        # If this ever fails, a translation silently loses or duplicates text.
        for text in (
            "她的主炮口径达到三百零五毫米。" * 20,
            "这艘船很长，装甲很厚，火炮很大，" * 12,
            "啊" * 400,
            "This is a sentence. And another one here. " * 10,
            "混合 English and 中文 in one line。" * 12,
            "",
            "。。。",
        ):
            self.assertEqual("".join(_split_for_model(text)), text, repr(text[:30]))

    def test_long_lines_are_actually_broken_up(self):
        text = "她的主炮口径达到三百零五毫米。" * 20
        pieces = _split_for_model(text)
        self.assertGreater(len(pieces), 1)

    def test_a_run_on_with_no_punctuation_is_still_broken(self):
        # Nothing to split on: it must still be cut rather than sent whole and
        # silently half-translated.
        pieces = _split_for_model("啊" * 500)
        self.assertGreater(len(pieces), 1)
        self.assertLessEqual(max(len(p) for p in pieces), LIMIT)

    def test_sentence_endings_stay_with_their_sentence(self):
        pieces = _split_for_model("第一句话。第二句话！第三句话？" * 12)
        joined = [p for p in pieces if p.strip()]
        self.assertTrue(any(p.rstrip().endswith(("。", "！", "？")) for p in joined))


class RejoinTests(unittest.TestCase):
    """One translation per input line, whatever the splitting did.

    alignTranslations matches cues by index, so a line count that changes here
    shifts every later subtitle onto the wrong cue.
    """

    def test_one_result_per_line(self):
        lines = ["短。", "她的主炮口径达到三百零五毫米。" * 20, "也短。"]
        out = _translate_split(lines, lambda pieces: [f"<{p[:4]}>" for p in pieces])
        self.assertEqual(len(out), len(lines))

    def test_pieces_are_translated_in_one_batch(self):
        # Splitting must not cost a model round trip per sentence.
        calls = []

        def fake(pieces):
            calls.append(len(pieces))
            return ["x" for _ in pieces]

        _translate_split(["第一句话。" * 40, "第二句话。" * 40], fake)
        self.assertEqual(len(calls), 1, "expected a single batched call")
        self.assertGreater(calls[0], 2, "expected the long lines to have been split")

    def test_empty_input(self):
        self.assertEqual(_translate_split([], lambda p: []), [])

    def test_blank_pieces_do_not_leave_stray_spaces(self):
        out = _translate_split(["一句。" * 40], lambda pieces: ["" for _ in pieces])
        self.assertEqual(out, [""])


if __name__ == "__main__":
    unittest.main()


class SpacedLanguageTests(unittest.TestCase):
    """Text with spaces, going into a language with spaces, splits at 400.

    120 characters is a short French or English sentence; on FLORES the longer
    limit gained 1-3 chrF++ for fr/es<->en (Opus and NLLB), while text into
    Chinese lost, so that keeps the short limit."""

    SENTENCE = (
        "Le docteur Ehud Ur, professeur de médecine à l'université Dalhousie de Halifax "
        "et président de la division clinique et scientifique de l'association, a prévenu."
    )

    def test_a_long_latin_sentence_stays_whole_into_english(self):
        self.assertGreater(len(self.SENTENCE), LIMIT)
        self.assertEqual(_split_for_model(self.SENTENCE, into_cjk=False), [self.SENTENCE])

    def test_into_chinese_keeps_the_short_limit(self):
        self.assertGreater(len(_split_for_model(self.SENTENCE, into_cjk=True)), 1)

    def test_chinese_text_keeps_the_short_limit_whatever_the_target(self):
        text = "这艘船很长，装甲很厚，火炮很大，" * 12
        self.assertEqual(_split_for_model(text, into_cjk=False), _split_for_model(text))

    def test_a_hard_cut_falls_between_words(self):
        text = "abcdefgh " * 60  # 540 characters, no sentence end or comma
        pieces = _split_for_model(text, into_cjk=False)
        self.assertEqual("".join(pieces), text)
        for piece in pieces[:-1]:
            self.assertTrue(piece.endswith(" "), repr(piece[-12:]))

    def test_a_word_longer_than_the_limit_is_still_cut(self):
        pieces = _split_for_model("x" * 900, into_cjk=False)
        self.assertEqual("".join(pieces), "x" * 900)
        self.assertTrue(all(len(p) <= 400 for p in pieces))

    def test_translate_split_passes_the_target_on(self):
        seen = []
        _translate_split([self.SENTENCE], lambda pieces: seen.extend(pieces) or pieces, into_cjk=False)
        self.assertEqual(seen, [self.SENTENCE])
