import io
import json
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "server"))

from romanize import romanize, serve  # noqa: E402


def run(*requests):
    """Feed lines to serve() and return what it wrote, one object per line."""
    stdin = io.StringIO("".join(r if isinstance(r, str) else json.dumps(r) + "\n" for r in requests))
    stdout = io.StringIO()
    serve(stdin, stdout)
    return [json.loads(line) for line in stdout.getvalue().splitlines()]


class ServeTests(unittest.TestCase):
    """The --serve loop server/pyworker.mjs talks to."""

    def test_ready_comes_first(self):
        self.assertEqual(run(), [{"ready": True}])

    def test_each_reply_carries_its_id_and_matches_a_one_shot_run(self):
        req = {"lang": "zh", "lines": ["我們今天", "小幸運"]}
        ready, first, second = run({**req, "id": 7}, {"lang": "en", "lines": ["hi"], "id": 8})
        self.assertEqual(first["id"], 7)
        self.assertEqual(first["tokens"], romanize(req)["tokens"])
        self.assertEqual(first["words"], romanize(req)["words"])
        self.assertEqual(second, {"id": 8, "tokens": [[]], "words": [[]]})

    def test_blank_and_broken_lines_are_skipped_not_fatal(self):
        replies = run("\n", "{not json\n", {"lang": "ko", "lines": [], "id": 1})
        self.assertEqual(replies, [{"ready": True}, {"id": 1, "tokens": [], "words": []}])


if __name__ == "__main__":
    unittest.main()
