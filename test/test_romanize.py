import json
import os
import subprocess
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPT = os.path.join(ROOT, "server", "romanize.py")


def run(lang, lines):
    proc = subprocess.run(
        [sys.executable, SCRIPT],
        input=json.dumps({"lang": lang, "lines": lines}),
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert proc.returncode == 0, proc.stderr
    return json.loads(proc.stdout)["tokens"]


def text_of(tokens):
    return "".join(base for base, _ in tokens)


class TestRomanize(unittest.TestCase):
    def test_chinese_pinyin_per_character_with_tones(self):
        (line,) = run("zh", ["天氣"])
        self.assertEqual(line, [["天", "tiān"], ["氣", "qì"]])

    def test_tokens_reconstruct_the_line(self):
        (line,) = run("zh", ["天氣，真好！"])
        self.assertEqual(text_of(line), "天氣，真好！")

    def test_japanese_is_romaji(self):
        (line,) = run("ja", ["今日"])
        joined = "".join(pron for _, pron in line).replace(" ", "")
        self.assertIn("kyou", joined)

    def test_non_latin_transliterates(self):
        (line,) = run("ru", ["Привет"])
        self.assertEqual(line[0][1].lower(), "privet")

    def test_latin_language_returns_no_tokens(self):
        self.assertEqual(run("en", ["Hello world"]), [[]])

    def test_length_is_preserved(self):
        self.assertEqual(len(run("zh", ["你好", "謝謝", "再見"])), 3)


if __name__ == "__main__":
    unittest.main()
