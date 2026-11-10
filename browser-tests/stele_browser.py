"""Shared set-up for the browser tests: one sandboxed app server per test
module, and Playwright pages at phone and desktop sizes.

The server is scripts/sandbox.mjs on a free port, with an empty video folder,
so nothing here touches the reader's own app, backups or videos. Every page
blocks /api/backup anyway (see .claude/skills/verify/SKILL.md) and answers
/api/lookup with a fixed meaning, so no test depends on a dictionary or a key.
"""

import json
import os
import socket
import subprocess
import tempfile
import time
import unittest
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent

LOOKUP = {
    "word": "真實",
    "meaning": "real; true",
    "pinyin": "zhēn shí",
    "definitions": ["real", "true"],
    "source": "dictionary",
}


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class AppTestCase(unittest.TestCase):
    """Starts the sandbox once for the class and a browser beside it."""

    @classmethod
    def setUpClass(cls):
        cls._videos = tempfile.TemporaryDirectory()
        cls.port = free_port()
        env = {**os.environ, "SANDBOX_PORT": str(cls.port), "STELE_VIDEO_DIR": cls._videos.name}
        cls._server = subprocess.Popen(
            ["node", str(ROOT / "scripts" / "sandbox.mjs")],
            cwd=ROOT,
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        cls.url = f"http://localhost:{cls.port}/"
        deadline = time.time() + 30
        while True:
            try:
                urllib.request.urlopen(cls.url, timeout=1).read()
                break
            except OSError:
                if time.time() > deadline or cls._server.poll() is not None:
                    cls._server.kill()
                    raise RuntimeError("the sandbox server did not start")
                time.sleep(0.2)
        cls._pw = sync_playwright().start()
        cls.browser = cls._pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls._pw.stop()
        cls._server.terminate()  # SIGTERM: the sandbox deletes its folder
        try:
            cls._server.wait(10)
        except subprocess.TimeoutExpired:
            cls._server.kill()
        cls._videos.cleanup()

    def open(self, *, phone=True, width=390, height=844, path=""):
        """A fresh page (own localStorage) on the app, sample lesson loaded."""
        if phone:
            ctx = self.browser.new_context(
                viewport={"width": width, "height": height},
                device_scale_factor=3,
                is_mobile=True,
                has_touch=True,
            )
        else:
            ctx = self.browser.new_context(viewport={"width": width, "height": height})
        self.addCleanup(ctx.close)
        page = ctx.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "uncaught errors in the page"))
        page.route("**/api/backup*", lambda r: r.abort())
        page.route("**/api/lookup*", lambda r: r.fulfill(json=LOOKUP))
        page.goto(self.url + path)
        page.wait_for_selector("#transcript .line .word")
        return page


def rect(page, selector):
    return page.evaluate(
        "(s) => { const r = document.querySelector(s).getBoundingClientRect();"
        " return {left: r.left, top: r.top, right: r.right, bottom: r.bottom,"
        " width: r.width, height: r.height}; }",
        selector,
    )


def tap(page, selector):
    page.locator(selector).first.tap()


class PhoneEditionTestCase(unittest.TestCase):
    """The phone edition as a phone gets it: scripts/build-phone.mjs into a
    temporary folder, served as plain files like GitHub Pages
    (scripts/serve-phone.mjs), with Groq answered by FakeGroq — no server,
    no network, no key."""

    @classmethod
    def setUpClass(cls):
        cls._site = tempfile.TemporaryDirectory()
        subprocess.run(
            ["node", str(ROOT / "scripts" / "build-phone.mjs"), "--out", cls._site.name],
            cwd=ROOT, check=True, stdout=subprocess.DEVNULL,
        )
        cls.port = free_port()
        cls._server = subprocess.Popen(
            ["node", str(ROOT / "scripts" / "serve-phone.mjs"), cls._site.name, str(cls.port)],
            cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        cls.url = f"http://localhost:{cls.port}/"
        deadline = time.time() + 15
        while True:
            try:
                urllib.request.urlopen(cls.url, timeout=1).read()
                break
            except OSError:
                if time.time() > deadline:
                    cls._server.kill()
                    raise RuntimeError("the phone edition's server did not start")
                time.sleep(0.1)
        cls._pw = sync_playwright().start()
        cls.browser = cls._pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls._pw.stop()
        cls._server.terminate()
        cls._server.wait(10)
        cls._site.cleanup()

    def phone(self, *, groq=None, context=None):
        """A phone-sized page on the phone edition. Returns (page, groq)."""
        groq = groq or FakeGroq()
        if context is None:
            context = self.browser.new_context(
                viewport={"width": 390, "height": 844}, device_scale_factor=3,
                is_mobile=True, has_touch=True, accept_downloads=True,
            )
            self.addCleanup(context.close)
        page = context.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        self.addCleanup(lambda: self.assertEqual(errors, [], "uncaught errors in the page"))
        page.on("request", groq.saw)
        context.route("https://api.groq.com/**", groq.answer)
        page.goto(self.url)
        page.wait_for_selector("#transcript .line .word")
        return page, groq


class FakeGroq:
    """Answers what the phone edition asks Groq, and remembers every request
    the page made anywhere."""

    KEY = "gsk_fake_key_9876"

    def __init__(self, heard=None):
        self.requests = []
        self.groq_calls = []
        self.heard = heard or {
            "language": "chinese",
            "duration": 3.0,
            "segments": [
                {"start": 0.0, "end": 1.5, "text": "我们今天去银行", "no_speech_prob": 0.01, "avg_logprob": -0.2},
                {"start": 1.5, "end": 3.0, "text": "头发很长", "no_speech_prob": 0.01, "avg_logprob": -0.2},
            ],
            "words": [{"start": 0.0, "end": 0.5, "word": "我们"}],
        }

    def saw(self, request):
        self.requests.append({"url": request.url, "headers": request.headers})

    def answer(self, route):
        request = route.request
        if request.method == "OPTIONS":
            route.fulfill(status=204, headers=self._cors())
            return
        auth = request.headers.get("authorization", "")
        self.groq_calls.append({"url": request.url, "auth": auth})
        if auth != f"Bearer {self.KEY}":
            route.fulfill(status=401, headers=self._cors(), json={"error": {"message": "Invalid API Key"}})
            return
        if request.url.endswith("/audio/transcriptions"):
            route.fulfill(headers=self._cors(), json=self.heard)
            return
        body = json.loads(request.post_data or "{}")
        if body.get("max_tokens") == 5:
            route.fulfill(headers=self._cors(), json={"choices": [{"message": {"content": "OK"}}]})
            return
        system, user = body["messages"][0]["content"], body["messages"][1]["content"]
        if "subtitle translator" in system:
            lines = user.split("\n")
            reply = {str(i + 1): "EN " + line.split(". ", 1)[1] for i, line in enumerate(lines)}
        else:
            reply = {"pronunciation": "", "meaning": "real; true", "explanation": "Mock explanation of the word.", "partOfSpeech": "adjective"}
        route.fulfill(headers=self._cors(), json={"choices": [{"message": {"content": json.dumps(reply, ensure_ascii=False)}}]})

    @staticmethod
    def _cors():
        return {"Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization,content-type"}
