"""Installing to a home screen and opening with no connection (sw.js).

What a reader would check by hand: the browser finds a manifest and icons, the
app opens again with the connection off — cards and all — and, back online,
the newest files from the server win over the stored copies, so an update is
never hidden behind the offline copy.
"""

import unittest

from stele_browser import AppTestCase


class Installable(AppTestCase):
    def controlled_page(self):
        page = self.open()
        ready = page.evaluate(
            "Promise.race([navigator.serviceWorker.ready.then(() => true),"
            " new Promise(r => setTimeout(() => r(false), 10000))])"
        )
        self.assertTrue(ready, "no service worker became ready")
        # The page that registered the worker isn't controlled by it until it
        # loads again; a reader's second visit is.
        page.reload()
        page.wait_for_selector("#transcript .line .word")
        self.assertTrue(page.evaluate("Boolean(navigator.serviceWorker.controller)"))
        return page

    def test_manifest_and_icons_are_served(self):
        page = self.open()
        href = page.evaluate("document.querySelector('link[rel=manifest]').href")
        manifest = page.request.get(href)
        self.assertEqual(manifest.status, 200)
        self.assertTrue(manifest.headers["content-type"].startswith("application/manifest+json"))
        data = manifest.json()
        self.assertEqual(data["display"], "standalone")
        for icon in data["icons"]:
            res = page.request.get(page.url + icon["src"])
            with self.subTest(icon=icon["src"]):
                self.assertEqual(res.status, 200)
                self.assertEqual(res.headers["content-type"], "image/png")
        apple = page.evaluate("document.querySelector('link[rel=apple-touch-icon]').href")
        self.assertEqual(page.request.get(apple).status, 200)

    def test_opens_offline_with_its_cards(self):
        page = self.controlled_page()
        word = page.locator("#transcript .word").first.get_attribute("data-word")
        page.locator("#transcript .word").first.tap()
        page.get_by_text("+ Flashcard").tap()
        page.locator("#modalSave").tap()
        page.wait_for_timeout(300)

        page.context.set_offline(True)
        self.addCleanup(page.context.set_offline, False)
        page.reload()
        page.wait_for_selector("#transcript .line .word")
        page.locator('button.nav-tab[data-view="cards"]').tap()
        page.wait_for_selector(".card-list > *")
        self.assertIn(word, page.locator(".card-list").inner_text())

    def test_the_api_is_never_answered_from_the_cache(self):
        page = self.controlled_page()
        page.evaluate("fetch('./api/health').then(r => r.status)")
        page.context.set_offline(True)
        self.addCleanup(page.context.set_offline, False)
        failed = page.evaluate("fetch('./api/health').then(() => false, () => true)")
        self.assertTrue(failed, "an /api/ answer came from the cache")

    def test_online_the_server_wins_over_the_stored_copy(self):
        page = self.controlled_page()
        # The server's page changes (an update); the stored copy is the old one.
        original = page.request.get(self.url).text()
        updated = original.replace("<title>Stele</title>", "<title>Stele (updated)</title>")
        page.context.route(self.url, lambda r: r.fulfill(body=updated, content_type="text/html"))
        page.reload()
        self.assertEqual(page.title(), "Stele (updated)")


if __name__ == "__main__":
    unittest.main()
