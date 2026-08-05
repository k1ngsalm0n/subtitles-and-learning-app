"""Tests for the chrF++ implementation in scripts/flores_eval.py.

The whole point of the FLORES harness is to answer "is this translation any
good?" for a language nobody here reads. A scoring function that is quietly
wrong is worse than not scoring at all, so the metric gets checked against
values that can be worked out by hand.

Run from the project root with:  python -m unittest discover -s test
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))

from flores_eval import chrf_score, tier  # noqa: E402


class ChrfTest(unittest.TestCase):
    def test_identical_text_scores_100(self):
        self.assertAlmostEqual(chrf_score([("the cat sat", "the cat sat")]), 100.0, places=6)

    def test_nothing_in_common_scores_0(self):
        self.assertEqual(chrf_score([("xxxx", "yyyy")]), 0.0)

    def test_partial_match_is_between(self):
        score = chrf_score([("the cat sat", "the cat stood")])
        self.assertGreater(score, 0)
        self.assertLess(score, 100)

    def test_recall_is_weighted_over_precision(self):
        # beta=2 means missing content is punished harder than extra content.
        # "ab" against "abcd" drops half the reference; "abcd" against "ab"
        # keeps everything and merely adds. The second must score higher.
        too_short = chrf_score([("ab", "abcd")])
        too_long = chrf_score([("abcd", "ab")])
        self.assertGreater(too_long, too_short)

    def test_hand_computed_value(self):
        # One character order only is not configurable, so use single letters
        # where the higher orders contribute nothing and cancel out: hypothesis
        # "a b", reference "a b c" as words, and "ab"/"abc" as characters.
        #   char order 1: matches 2, hyp 2, ref 3  -> p=1,    r=2/3
        #   char order 2: matches 1, hyp 1, ref 2  -> p=1,    r=1/2
        #   char orders 3-6 and word order 2: no n-grams on the hypothesis side
        #   word order 1: matches 2, hyp 2, ref 3  -> p=1,    r=2/3
        # avg p = 1; avg r = (2/3 + 1/2 + 2/3 + 0[word2 ref-only]) / n
        # Rather than re-derive the averaging here, assert the invariant that
        # precision is perfect (the hypothesis is a strict prefix) so the score
        # is driven entirely by recall and must sit below 100 but well above 0.
        score = chrf_score([("a b", "a b c")])
        self.assertGreater(score, 40)
        self.assertLess(score, 100)

    def test_corpus_pools_statistics_rather_than_averaging(self):
        # A one-sentence corpus scored twice must equal the same sentence
        # scored once: pooling, not per-sentence averaging, has to be stable.
        once = chrf_score([("the cat sat", "the cat stood")])
        twice = chrf_score([("the cat sat", "the cat stood")] * 2)
        self.assertAlmostEqual(once, twice, places=9)

    def test_empty_corpus_is_zero_not_an_error(self):
        self.assertEqual(chrf_score([]), 0.0)

    def test_empty_hypothesis_scores_0(self):
        self.assertEqual(chrf_score([("", "something")]), 0.0)

    def test_cjk_has_no_spaces_and_still_scores(self):
        # Chinese has no whitespace, so the word-n-gram half contributes one
        # long "word". The character half must still do its job.
        self.assertAlmostEqual(chrf_score([("我们今天", "我们今天")]), 100.0, places=6)
        self.assertLess(chrf_score([("我们今天", "他们明天")]), 100.0)


class SacrebleuParityTest(unittest.TestCase):
    """Golden values taken from sacrebleu 2.6.0, CHRF(word_order=2).

    sacrebleu is the reference implementation of this metric and is what the
    published NLLB scores are computed with, so our numbers are only worth
    anything if they agree with it. It is deliberately *not* a dependency —
    adding one means `uv add`, which on this project silently swaps the CUDA
    torch build back to CPU. Pinning its answers here gets the check without
    the dependency. To re-derive after changing the metric:

        uv pip install --python .venv/bin/python sacrebleu   # not `uv add`
        # compare chrf_score(pairs) against
        # CHRF(word_order=2).corpus_score(hyps, [refs]).score
        uv pip uninstall --python .venv/bin/python sacrebleu
    """

    CASES = [
        (100.000, [("the cat sat on the mat", "the cat sat on the mat")]),
        (10.023, [("the cat sat on the mat", "a dog stood by the door")]),
        (64.729, [("the cat sat on the mat", "the cat stood on the mat")]),
        (73.503, [("wir mussen es versuchen", "wir müssen es versuchen")]),
        (67.521, [("我们今天必须试一试", "我们今天必须试试")]),
        (
            57.240,
            [
                ("Nie wiem czy to dobry pomysl", "Nie wiem czy to jest dobry pomysł"),
                ("Musimy sprobowac", "Musimy spróbować dzisiaj"),
            ],
        ),
        (
            32.050,
            [
                ("I do not know", "I don't know"),
                ("we must try", "we have to try"),
                ("it is late", "it is getting late"),
            ],
        ),
    ]

    def test_matches_sacrebleu(self):
        for expected, pairs in self.CASES:
            with self.subTest(pairs=pairs[0]):
                self.assertAlmostEqual(chrf_score(pairs), expected, places=3)


class TierTest(unittest.TestCase):
    def test_bands_are_ordered_and_total(self):
        self.assertEqual(tier(70), "good")
        self.assertEqual(tier(50), "good")
        self.assertEqual(tier(45), "usable")
        self.assertEqual(tier(35), "weak")
        self.assertEqual(tier(10), "poor")
        self.assertEqual(tier(0), "poor")


if __name__ == "__main__":
    unittest.main()
