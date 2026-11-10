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
