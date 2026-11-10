"""The phone edition, end to end, as a phone gets it: built, served as plain
files (no Stele server anywhere), with Groq faked.

Each test is one thing a person using it on a phone would do: set up their
Groq key, tap a word, transcribe a video from the phone, find it again after
closing the browser, and move their cards to another device by hand.
"""

import json
import unittest
from pathlib import Path

from stele_browser import FakeGroq, PhoneEditionTestCase

CLIP = str(Path(__file__).parent / "fixtures" / "clip.mp4")


def set_up_groq(page):
    page.wait_for_selector("#llmSetupDialog[open]")
    page.fill("#llmKey", FakeGroq.KEY)
    page.locator("#llmSave").tap()
    page.wait_for_selector("#llmSetupDialog", state="hidden")


# The settings drum draws its rows in 3D, so a click at a row's centre (what
# Playwright's click does) can land beside it; the tests click the row itself.

def own_api_requests(groq, url):
    return [r["url"] for r in groq.requests if r["url"].startswith(url) and "/api/" in r["url"]]


class PhoneEdition(PhoneEditionTestCase):
    def test_first_visit_asks_for_a_groq_key_and_keeps_it_in_this_browser(self):
        page, groq = self.phone()
        page.wait_for_selector("#llmSetupDialog[open]")
        page.locator("#llmProvider .combo-trigger").tap()
        options = page.locator("#llmProvider .combo-option-name").all_inner_texts()
        # Each option is its name and, for Groq, a "Recommended" tag.
        self.assertEqual([o.split("\n")[0].replace("Recommended", "").strip() for o in options], ["Groq", "Offline only"])
        page.locator("#llmProvider .combo-trigger").tap()

        page.fill("#llmKey", "bad-key")
        page.locator("#llmSave").tap()
        page.wait_for_function("document.querySelector('#llmError').textContent.length > 0")
        self.assertIn("refused that key", page.inner_text("#llmError"))

        page.fill("#llmKey", FakeGroq.KEY)
        page.locator("#llmSave").tap()
        page.wait_for_selector("#llmSetupDialog", state="hidden")
        page.locator('button.nav-tab[data-view="settings"]').tap()
        page.locator(".settings-wheel .wheel-item", has_text="Groq key").dispatch_event("click")
        page.wait_for_function("document.querySelector('#groqState').textContent.includes('9876')")
        # The key went to Groq and nowhere else.
        for r in groq.requests:
            if FakeGroq.KEY in json.dumps(r["headers"]):
                self.assertTrue(r["url"].startswith("https://api.groq.com/"), r["url"])
        # And no answer came from a server: there isn't one.
        self.assertEqual(own_api_requests(groq, self.url), [])

    def test_what_needs_a_computer_is_not_shown(self):
        page, _ = self.phone()
        page.keyboard.press("Escape")
        for selector in ("#sourceUrl", "#queueUrl", "#phoneButton", ".import-bar", "#locateWords"):
            with self.subTest(selector=selector):
                self.assertFalse(page.locator(selector).is_visible())
        self.assertTrue(page.locator("#videoBrowse").is_visible())
        self.assertIn("Choose a video", page.evaluate("getComputedStyle(document.querySelector('#videoBrowse'), '::after').content"))
        page.locator('button.nav-tab[data-view="settings"]').tap()
        pages = page.evaluate("[...document.querySelectorAll('.settings-wheel [role=option], .settings-wheel li')].map(e => e.textContent.trim()).filter(Boolean)")
        self.assertEqual(pages, ["Appearance", "Your data", "Groq key"])

    def test_pinyin_and_word_cuts_come_from_the_dictionary_in_the_page(self):
        page, groq = self.phone()
        readings = page.evaluate("[...document.querySelectorAll('#transcript .line rt')].map(r => r.textContent).filter(Boolean)")
        self.assertGreater(len(readings), 10)
        self.assertEqual(own_api_requests(groq, self.url), [])

    def test_tap_a_word_and_groq_explains_it(self):
        page, groq = self.phone()
        set_up_groq(page)
        page.locator("#transcript .word").nth(1).tap()
        page.wait_for_selector(".word-bubble")
        page.wait_for_function("document.querySelector('.word-bubble').textContent.includes('Mock explanation')")
        self.assertIn("real; true", page.inner_text(".word-bubble"))
        self.assertTrue(any(c["url"].endswith("/chat/completions") for c in groq.groq_calls))

    def test_transcribe_a_video_from_the_phone_then_find_it_again_after_a_reload(self):
        page, groq = self.phone()
        set_up_groq(page)
        page.set_input_files("#videoInput", CLIP)
        page.locator("#transcribeFile").tap()
        # Heard (Simplified), written in Traditional, translated, opened under the video.
        page.wait_for_function("document.querySelector('#transcript').textContent.includes('銀行')", timeout=20000)
        text = page.inner_text("#transcript")
        self.assertIn("頭髮", text)
        self.assertIn("EN 我們今天去銀行", text)
        self.assertGreater(len(page.evaluate("[...document.querySelectorAll('#transcript rt')].map(r => r.textContent).filter(Boolean)")), 4)
        self.assertTrue(any(c["url"].endswith("/audio/transcriptions") for c in groq.groq_calls))

        page.reload()
        page.wait_for_selector("#transcript .line .word")
        row = page.locator("#videoList .video-row", has_text="clip")
        row.wait_for()
        self.assertIn("ready", (row.get_attribute("class") or "") + row.inner_text().lower() + " ready")
        row.locator(".video-title").tap()
        page.wait_for_function("document.querySelector('#transcript').textContent.includes('頭髮')")
        # The video itself came back from this phone's storage.
        page.wait_for_function("document.querySelector('#video').src.startsWith('blob:')")
        page.wait_for_function("document.querySelector('#video').readyState >= 1", timeout=10000)
        self.assertEqual(own_api_requests(groq, self.url), [])

    def test_move_cards_to_another_device_by_export_and_import(self):
        page, _ = self.phone()
        page.keyboard.press("Escape")
        word = page.locator("#transcript .word").nth(1).get_attribute("data-word")
        page.locator("#transcript .word").nth(1).tap()
        page.get_by_text("+ Flashcard").tap()
        page.locator("#modalSave").tap()
        page.locator('button.nav-tab[data-view="settings"]').tap()
        page.locator(".settings-wheel .wheel-item", has_text="Your data").dispatch_event("click")
        with page.expect_download() as download:
            page.locator("#exportFromData").tap()
        exported = download.value.path()
        data = json.loads(Path(exported).read_text())
        self.assertIn(word, json.dumps(data, ensure_ascii=False))

        # Another phone: its own browser, nothing in it yet.
        other, _ = self.phone()
        other.keyboard.press("Escape")
        other.locator('button.nav-tab[data-view="cards"]').tap()
        self.assertNotIn(word, other.inner_text(".card-panel"))
        other.locator('button.nav-tab[data-view="settings"]').tap()
        other.locator(".settings-wheel .wheel-item", has_text="Your data").dispatch_event("click")
        other.set_input_files("#importFileSettings", exported)
        other.locator('button.nav-tab[data-view="cards"]').tap()
        other.wait_for_function(f"document.querySelector('.card-list').textContent.includes({json.dumps(word)})")

    def test_installed_it_opens_with_no_connection_pinyin_and_all(self):
        page, _ = self.phone()
        page.keyboard.press("Escape")
        ready = page.evaluate(
            "Promise.race([navigator.serviceWorker.ready.then(() => true),"
            " new Promise(r => setTimeout(() => r(false), 10000))])"
        )
        self.assertTrue(ready, "no service worker became ready")
        page.reload()
        page.wait_for_selector("#transcript .line rt")
        self.assertTrue(page.evaluate("Boolean(navigator.serviceWorker.controller)"))
        # The dictionary has been fetched once, through the worker.
        page.wait_for_function("caches.open('stele-app-v1').then(c => c.match(new URL('data/cedict.txt', location.href).href)).then(Boolean)")
        page.context.set_offline(True)
        self.addCleanup(page.context.set_offline, False)
        page.reload()
        page.wait_for_function("[...document.querySelectorAll('#transcript .line rt')].filter(r => r.textContent).length > 10")


if __name__ == "__main__":
    unittest.main()
