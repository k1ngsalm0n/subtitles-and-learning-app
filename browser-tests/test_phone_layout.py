"""The study and review screens at phone size (#phone-layout).

Each test states one thing the phone layout promises, in the terms a reader
would notice: nothing scrolls sideways, the video stays in sight, the
transcript is the rest of the screen, the word pop-up rises from the bottom,
targets are big enough for a finger. Desktop is checked too, so the phone
rules never leak into a wide window.
"""

import unittest

from stele_browser import AppTestCase, rect, tap

WIDTHS = (360, 390, 430)


class PhoneLayout(AppTestCase):
    def test_no_screen_scrolls_sideways(self):
        for width in WIDTHS:
            page = self.open(width=width)
            for view in ("study", "cards", "settings"):
                with self.subTest(width=width, view=view):
                    page.locator(f'button.nav-tab[data-view="{view}"]').tap()
                    page.wait_for_timeout(300)
                    scroll_width = page.evaluate("document.documentElement.scrollWidth")
                    self.assertLessEqual(scroll_width, width)

    def test_video_stays_pinned_and_transcript_fills_the_rest(self):
        page = self.open()
        page.evaluate("scrollTo(0, document.documentElement.scrollHeight)")
        page.wait_for_timeout(400)
        topbar = rect(page, ".topbar")
        player = rect(page, "#playerShell")
        pane = rect(page, ".transcript-pane")
        height = page.evaluate("innerHeight")
        # The video sits right under the topbar, still in view.
        self.assertAlmostEqual(player["top"], topbar["bottom"] + 8, delta=2)
        self.assertGreater(player["height"], 150)
        # The transcript starts below the video and ends at the bottom of the
        # screen: the whole of it is visible, none hidden under the video.
        self.assertGreaterEqual(pane["top"], player["bottom"] - 1)
        self.assertAlmostEqual(pane["bottom"], height, delta=2)
        # And it scrolls inside itself.
        self.assertEqual(page.evaluate("getComputedStyle(document.querySelector('#transcript')).overflowY"), "auto")

    def test_mini_player_never_starts_on_a_phone(self):
        page = self.open()
        # A video "loaded" is what the mini player waits for.
        page.evaluate("document.querySelector('#video').setAttribute('src', 'data:video/mp4,')")
        page.evaluate("scrollTo(0, document.documentElement.scrollHeight)")
        page.wait_for_timeout(600)
        self.assertNotIn("mini", page.get_attribute("#playerWrap", "class"))

    def test_play_scrolls_the_transcript_into_full_view(self):
        page = self.open()
        page.evaluate("scrollTo(0, 0)")
        self.assertGreater(rect(page, ".transcript-pane")["bottom"], page.evaluate("innerHeight") + 50)
        page.evaluate("document.querySelector('#video').dispatchEvent(new Event('play'))")
        page.wait_for_timeout(900)
        self.assertAlmostEqual(rect(page, ".transcript-pane")["bottom"], page.evaluate("innerHeight"), delta=3)

    def test_timestamp_sits_above_the_line_not_beside_it(self):
        page = self.open()
        time_box = rect(page, "#transcript .line .time")
        original = rect(page, "#transcript .line .original")
        self.assertLessEqual(time_box["bottom"], original["top"] + 1)

    def test_toolbar_takes_two_rows(self):
        page = self.open()
        tops = page.evaluate(
            "[...document.querySelectorAll('.toolbar-row > *')]"
            ".filter(e => e.offsetParent).map(e => Math.round(e.getBoundingClientRect().top))"
        )
        self.assertLessEqual(len(set(tops)), 2, tops)

    def test_word_popup_is_a_bottom_sheet(self):
        page = self.open()
        tap(page, "#transcript .word")
        page.wait_for_selector(".word-bubble")
        page.wait_for_timeout(300)
        sheet = rect(page, ".word-bubble")
        self.assertAlmostEqual(sheet["bottom"], page.evaluate("innerHeight"), delta=1)
        self.assertAlmostEqual(sheet["left"], 0, delta=1)
        self.assertAlmostEqual(sheet["width"], page.evaluate("innerWidth"), delta=1)

    def test_keyboard_hints_hidden_on_touch(self):
        page = self.open()
        for selector in (".study-keys", ".review-keys"):
            with self.subTest(selector=selector):
                display = page.evaluate(f"getComputedStyle(document.querySelector('{selector}')).display")
                self.assertEqual(display, "none")

    def test_save_a_word_and_review_it_by_touch(self):
        page = self.open()
        tap(page, "#transcript .word")
        page.get_by_text("+ Flashcard").tap()
        page.locator("#modalSave").tap()
        page.locator('button.nav-tab[data-view="cards"]').tap()
        page.locator("#flipCard").tap()
        page.locator(".grade-button.grade-good").wait_for(state="visible")
        grades = page.evaluate(
            "[...document.querySelectorAll('.grade-button')].filter(b => b.offsetParent)"
            ".map(b => { const r = b.getBoundingClientRect(); return [r.top, r.height, r.right]; })"
        )
        self.assertEqual(len(grades), 3)
        self.assertEqual(len({round(t) for t, _, _ in grades}), 1, "grades share one row")
        for _, height, right in grades:
            self.assertGreaterEqual(height, 44)
            self.assertLessEqual(right, page.evaluate("innerWidth"))
        # Grading moves on: the answer is hidden again for the next card (or
        # the deck is done), so the grades are gone until Show answer.
        page.locator(".grade-button.grade-easy").tap()
        page.locator(".grade-button.grade-easy").wait_for(state="hidden")

    def test_touch_targets_are_finger_sized(self):
        page = self.open()
        small = page.evaluate(
            "[...document.querySelectorAll('.nav-tab, #translateFrom, #translateTo, #sourceUrl, #searchInput, .grade-button')]"
            ".filter(e => e.offsetParent && e.getBoundingClientRect().height < 40)"
            ".map(e => e.id || e.className)"
        )
        self.assertEqual(small, [])


class DesktopUnchanged(AppTestCase):
    def test_transcript_stays_beside_the_video(self):
        page = self.open(phone=False, width=1280, height=800)
        media = rect(page, ".media-pane")
        pane = rect(page, ".transcript-pane")
        self.assertGreater(pane["left"], media["right"])
        self.assertEqual(page.evaluate("getComputedStyle(document.querySelector('.media-pane')).position"), "static")

    def test_keyboard_hints_shown(self):
        page = self.open(phone=False, width=1280, height=800)
        self.assertNotEqual(page.evaluate("getComputedStyle(document.querySelector('.study-keys')).display"), "none")

    def test_word_popup_still_centred(self):
        page = self.open(phone=False, width=1280, height=800)
        page.locator("#transcript .word").first.click()
        page.wait_for_selector(".word-bubble")
        page.wait_for_timeout(300)
        sheet = rect(page, ".word-bubble")
        self.assertAlmostEqual((sheet["left"] + sheet["right"]) / 2, 640, delta=2)

    def test_play_never_moves_the_page(self):
        page = self.open(phone=False, width=1280, height=600)
        before = page.evaluate("scrollY")
        page.evaluate("document.querySelector('#video').dispatchEvent(new Event('play'))")
        page.wait_for_timeout(600)
        self.assertEqual(page.evaluate("scrollY"), before)


if __name__ == "__main__":
    unittest.main()
