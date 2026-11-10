"""Render the app icons (public/icons/*.png) from their SVG sources.

    python scripts/make_icons.py     # needs Playwright: see browser-tests/

Home screens want PNGs at fixed sizes, and the server has no image library
(no third-party deps), so the PNGs are committed and this re-makes them when
icon.svg or maskable.svg changes. maskable.svg keeps the flower inside the
middle 60%, the safe zone Android crops every maskable icon to.
"""

from pathlib import Path

from playwright.sync_api import sync_playwright

ICONS = Path(__file__).resolve().parent.parent / "public" / "icons"
SIZES = [
    ("icon.svg", "icon-192.png", 192),
    ("icon.svg", "icon-512.png", 512),
    ("maskable.svg", "maskable-512.png", 512),
    # iOS ignores the manifest's icons and draws its own rounded corners.
    ("maskable.svg", "apple-touch-icon.png", 180),
]

with sync_playwright() as p:
    browser = p.chromium.launch()
    for source, target, size in SIZES:
        page = browser.new_page(viewport={"width": size, "height": size})
        svg = (ICONS / source).read_text()
        page.set_content(
            f'<style>html,body{{margin:0;background:transparent}}svg{{display:block;width:{size}px;height:{size}px}}</style>{svg}'
        )
        page.screenshot(path=str(ICONS / target), omit_background=True)
        page.close()
        print(target, size)
    browser.close()
