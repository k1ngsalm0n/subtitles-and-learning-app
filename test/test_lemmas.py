import io
import json
import os
import subprocess
import sys
import types
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "server"))

import lemmas  # noqa: E402


def _fake(word):
    if word == "boom":
        raise RuntimeError("analyser bug")
    return [word.rstrip("s"), "", 3, word.upper()]


class TestLemmas(unittest.TestCase):
    def setUp(self):
        module = types.ModuleType("fake_lemmatiser")
        module.forms = _fake
        sys.modules["fake_lemmatiser"] = module
        self.saved = dict(lemmas.LEMMATISERS)
        lemmas.LEMMATISERS["xx"] = "fake_lemmatiser:forms"
        lemmas.LEMMATISERS["yy"] = "not_installed_anywhere:forms"
        lemmas._loaded.clear()

    def tearDown(self):
        lemmas.LEMMATISERS.clear()
        lemmas.LEMMATISERS.update(self.saved)
        lemmas._loaded.clear()
        sys.modules.pop("fake_lemmatiser", None)

    def test_a_language_without_an_analyser_gets_nothing(self):
        self.assertEqual(lemmas.lemmatise({"lang": "zz", "words": ["evler"]}), {"lemmas": {"evler": []}})

    def test_forms_come_back_in_order_and_only_as_strings(self):
        self.assertEqual(lemmas.lemmatise({"lang": "xx", "words": ["cats"]})["lemmas"]["cats"], ["cat", "CATS"])

    def test_an_analyser_that_fails_costs_only_that_word(self):
        out = lemmas.lemmatise({"lang": "xx", "words": ["boom", "dogs"]})["lemmas"]
        self.assertEqual(out["boom"], [])
        self.assertEqual(out["dogs"], ["dog", "DOGS"])

    def test_an_analyser_that_isnt_installed_degrades_to_nothing(self):
        self.assertEqual(lemmas.lemmatise({"lang": "yy", "words": ["x"]}), {"lemmas": {"x": []}})

    def test_serve_answers_each_request_with_its_id(self):
        stdin = io.StringIO(json.dumps({"id": 7, "lang": "xx", "words": ["cats"]}) + "\n\nnot json\n")
        stdout = io.StringIO()
        lemmas.serve(stdin, stdout)
        replies = [json.loads(line) for line in stdout.getvalue().splitlines()]
        self.assertEqual(replies[0], {"ready": True})
        self.assertEqual(replies[1], {"id": 7, "lemmas": {"cats": ["cat", "CATS"]}})
        self.assertEqual(len(replies), 2)

    def test_one_shot_run(self):
        proc = subprocess.run(
            [sys.executable, os.path.join(ROOT, "server", "lemmas.py")],
            input=json.dumps({"lang": "zz", "words": ["a"]}),
            capture_output=True, text=True, timeout=60,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(json.loads(proc.stdout), {"lemmas": {"a": []}})


if __name__ == "__main__":
    unittest.main()
