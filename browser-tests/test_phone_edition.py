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
# The build falls back to a 66-entry seed dictionary, which can't turn the
# heard Simplified into Traditional; CI downloads the full one.
FULL_DICT = Path(__file__).resolve().parent.parent / "data" / "cedict.u8"


def set_up_groq(page):
    page.wait_for_selector("#llmSetupDialog[open]")
    page.fill("#llmKey", FakeGroq.KEY)
    page.locator("#llmSave").tap()
    page.wait_for_selector("#llmSetupDialog", state="hidden")


# The settings drum draws its rows in 3D, so a click at a row's centre (what
# Playwright's click does) can land beside it; the tests click the row itself.

def open_player(page):
    """From the Videos list to the player screen, with what's open now."""
    page.locator("#phoneContinue").tap()
    page.wait_for_selector("#transcript .line .word")


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
        page.locator("#phoneSettings").tap()
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
        # Adding a video is the ＋ in the bottom bar, which presses the folder button.
        self.assertTrue(page.locator(".phone-tab-add").is_visible())
        page.locator("#phoneSettings").tap()
        pages = page.evaluate("[...document.querySelectorAll('.settings-wheel [role=option], .settings-wheel li')].map(e => e.textContent.trim()).filter(Boolean)")
        self.assertEqual(pages, ["Appearance", "Your data", "Groq key"])

    def test_home_is_a_feed_and_a_video_plays_full_screen_with_its_line_over_it(self):
        page, _ = self.phone()
        page.keyboard.press("Escape")
        # Home: the feed, a ＋ to add, no player yet.
        self.assertTrue(page.locator("#phoneContinue").is_visible())
        self.assertTrue(page.locator("#phoneEmpty").is_visible())
        self.assertFalse(page.locator("#transcript").is_visible())
        self.assertIn("on", page.locator('.phone-tab[data-tab="study"]').get_attribute("class"))

        open_player(page)
        # Full screen: no bars, the picture fills the window, one line shows.
        self.assertFalse(page.locator(".phone-nav").is_visible())
        self.assertFalse(page.locator(".topbar").is_visible())
        box = page.locator(".media-pane").bounding_box()
        self.assertEqual((box["x"], box["y"], box["width"]), (0, 0, 390))
        shown = page.evaluate("[...document.querySelectorAll('#transcript .line')].filter(l => l.getClientRects().length).length")
        self.assertLessEqual(shown, 2)
        self.assertIn("Sample lesson", page.inner_text("#phoneStageBack"))
        first = page.evaluate("document.querySelector('#transcript .line.active')?.dataset.index ?? null")
        # Swipe up: the next line.
        page.locator("#phoneSide, .phone-side").first.wait_for()
        page.mouse.move(195, 300)
        page.mouse.down()
        page.mouse.move(195, 180, steps=4)
        page.mouse.up()
        page.wait_for_function(f"document.querySelector('#transcript .line.active')?.dataset.index !== {json.dumps(first)}")
        # Pinyin off and on from the side.
        page.locator('.phone-side-button[data-side="pinyin"]').tap()
        self.assertEqual(page.evaluate("document.documentElement.dataset.phonePinyin"), "off")
        page.locator('.phone-side-button[data-side="words"]').tap()
        page.wait_for_selector(".word-list-panel")
        page.keyboard.press("Escape")

        # Android's back button asks the page first: player → Home.
        self.assertTrue(page.evaluate("window.stelePhoneBack()"))
        self.assertTrue(page.locator("#phoneContinue").is_visible())
        self.assertFalse(page.evaluate("window.stelePhoneBack()"))

        page.locator('.phone-tab[data-tab="cards"]').tap()
        self.assertTrue(page.locator("#cardsView").is_visible())
        self.assertEqual(page.inner_text("#phoneTitle"), "Cards")
        page.locator("#phoneSettings").tap()
        self.assertTrue(page.locator("#settingsView").is_visible())
        page.locator("#phoneBack").tap()
        self.assertTrue(page.locator("#phoneContinue").is_visible())

        # The language pair is a chip; tapping it shows the translate bar.
        self.assertIn("→", page.inner_text("#phoneLangs"))
        self.assertFalse(page.locator(".translate-bar").is_visible())
        page.locator("#phoneLangs").tap()
        self.assertTrue(page.locator(".translate-bar").is_visible())

    def test_switching_screens_slides_the_new_one_in_from_its_side(self):
        page, _ = self.phone(motion=True)
        page.keyboard.press("Escape")
        slide = """() => document.getAnimations()
            .filter(a => (a.effect?.pseudoElement || '').includes('view-transition-new'))
            .map(a => a.animationName)[0]"""
        page.locator('.phone-tab[data-tab="cards"]').tap()
        self.assertEqual(page.wait_for_function(slide).json_value(), "phone-in-right")
        page.wait_for_function("document.querySelector('#cardsView').classList.contains('active')")
        page.wait_for_function(f"!({slide})()")
        page.locator('.phone-tab[data-tab="study"]').tap()
        self.assertEqual(page.wait_for_function(slide).json_value(), "phone-in-left")

    def test_a_review_card_is_swiped(self):
        page, _ = self.phone()
        page.keyboard.press("Escape")
        open_player(page)
        page.locator("#transcript .word").nth(1).tap()
        page.get_by_text("+ Flashcard").tap()
        page.locator("#modalSave").tap()
        page.locator("#phoneStageBack").tap()
        page.locator('.phone-tab[data-tab="cards"]').tap()
        card = page.locator("#reviewCard").bounding_box()
        mid_y = card["y"] + card["height"] / 2
        page.mouse.click(card["x"] + card["width"] / 2, mid_y)  # a tap turns it
        page.wait_for_selector(".grade-good", state="visible")
        page.wait_for_timeout(300)
        card = page.locator("#reviewCard").bounding_box()  # the back is taller
        mid_y = card["y"] + min(card["height"] / 2, 120)
        page.mouse.move(card["x"] + 60, mid_y)
        page.mouse.down()
        page.mouse.move(card["x"] + card["width"] - 40, mid_y, steps=5)
        page.mouse.up()
        # Graded Got it: nothing left to review now, the card back in ten minutes.
        page.wait_for_function("document.querySelector('#reviewProgress').textContent === ''")
        self.assertIn("10m", page.inner_text("#reviewCard"))

    def test_pinyin_and_word_cuts_come_from_the_dictionary_in_the_page(self):
        page, groq = self.phone()
        readings = page.evaluate("[...document.querySelectorAll('#transcript .line rt')].map(r => r.textContent).filter(Boolean)")
        self.assertGreater(len(readings), 10)
        self.assertEqual(own_api_requests(groq, self.url), [])

    def test_tap_a_word_and_groq_explains_it(self):
        page, groq = self.phone()
        set_up_groq(page)
        open_player(page)
        page.locator("#transcript .word").nth(1).tap()
        page.wait_for_selector(".word-bubble")
        page.wait_for_function("document.querySelector('.word-bubble').textContent.includes('Mock explanation')")
        self.assertIn("real; true", page.inner_text(".word-bubble"))
        self.assertTrue(any(c["url"].endswith("/chat/completions") for c in groq.groq_calls))

    @unittest.skipUnless(FULL_DICT.exists(), "data/cedict.u8 not downloaded (node scripts/fetch-cedict.mjs)")
    def test_transcribe_a_video_from_the_phone_then_find_it_again_after_a_reload(self):
        page, groq = self.phone()
        set_up_groq(page)
        page.set_input_files("#videoInput", CLIP)
        page.locator("#transcribeFile").tap()
        # Heard (Simplified), written in Traditional, translated, opened under the video.
        # Read the whole transcript, not what's on screen: the phone shows
        # only the current line.
        page.wait_for_function(
            "(t => t.includes('銀行') && t.includes('頭髮'))(document.querySelector('#transcript').textContent)",
            timeout=20000,
        )
        text = page.text_content("#transcript")
        self.assertIn("頭髮", text)
        self.assertIn("EN 我們今天去銀行", text)
        self.assertGreater(len(page.evaluate("[...document.querySelectorAll('#transcript rt')].map(r => r.textContent).filter(Boolean)")), 4)
        self.assertTrue(any(c["url"].endswith("/audio/transcriptions") for c in groq.groq_calls))

        page.reload()
        page.wait_for_selector("#transcript .line .word", state="attached")
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
        open_player(page)
        word = page.locator("#transcript .word").nth(1).get_attribute("data-word")
        page.locator("#transcript .word").nth(1).tap()
        page.get_by_text("+ Flashcard").tap()
        page.locator("#modalSave").tap()
        page.locator("#phoneStageBack").tap()
        page.locator("#phoneSettings").tap()
        page.locator(".settings-wheel .wheel-item", has_text="Your data").dispatch_event("click")
        with page.expect_download() as download:
            page.locator("#exportFromData").tap()
        exported = download.value.path()
        data = json.loads(Path(exported).read_text())
        self.assertIn(word, json.dumps(data, ensure_ascii=False))

        # Another phone: its own browser, nothing in it yet.
        other, _ = self.phone()
        other.keyboard.press("Escape")
        other.locator('.phone-tab[data-tab="cards"]').tap()
        self.assertNotIn(word, other.inner_text(".card-panel"))
        other.locator("#phoneSettings").tap()
        other.locator(".settings-wheel .wheel-item", has_text="Your data").dispatch_event("click")
        other.set_input_files("#importFileSettings", exported)
        other.locator('.phone-tab[data-tab="cards"]').tap()
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
        page.wait_for_selector("#transcript .line rt", state="attached")
        self.assertTrue(page.evaluate("Boolean(navigator.serviceWorker.controller)"))
        # The dictionary has been fetched once, through the worker.
        page.wait_for_function("caches.open('stele-app-v1').then(c => c.match(new URL('data/cedict.txt', location.href).href)).then(Boolean)")
        page.context.set_offline(True)
        self.addCleanup(page.context.set_offline, False)
        page.reload()
        page.wait_for_function("[...document.querySelectorAll('#transcript .line rt')].filter(r => r.textContent).length > 10")


if __name__ == "__main__":
    unittest.main()
