"""Translations into Chinese come out in the app's script (no model loaded)."""

import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "server"))


class ChineseOutputScriptTest(unittest.TestCase):
    def setUp(self):
        import translate

        translate._to_traditional = None

    def test_simplified_in_a_translation_becomes_traditional(self):
        from translate import in_app_script

        # Real NLLB/Opus output: Traditional asked for, Simplified mixed in.
        lines = ["這項研究仍处于初期階段", "加拿大糖尿病協會临床和科學系", "", "Dalhousie"]
        with mock.patch.dict(os.environ, {"ZH_SCRIPT": "trad"}):
            out = in_app_script(lines)
        self.assertEqual(out, ["這項研究仍處於初期階段", "加拿大糖尿病協會臨床和科學系", "", "Dalhousie"])

    def test_zh_script_off_leaves_the_model_s_script(self):
        from translate import in_app_script

        with mock.patch.dict(os.environ, {"ZH_SCRIPT": "off"}):
            self.assertEqual(in_app_script(["临床"]), ["临床"])

    def test_only_translations_into_chinese_are_touched(self):
        from unittest import mock as m

        import translate

        with m.patch.object(translate, "translate_batch", lambda texts, s, t: ["临床" for _ in texts]), \
                m.patch.object(translate, "_plan_batch", lambda: 8):
            self.assertEqual(translate._translate_lines(["clinical"], "pt", "zh"), ["臨床"])
            self.assertEqual(translate._translate_lines(["clinical"], "pt", "ja"), ["临床"])


if __name__ == "__main__":
    unittest.main()
