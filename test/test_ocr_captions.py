"""Tests for the pure caption-merging helpers in server/ocr_captions.py.

Run from the project root with:  python -m unittest discover -s test
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "server"))

from ocr_captions import (  # noqa: E402
    _is_caption_line,
    cjk_ratio,
    filter_furniture,
    is_similar,
    pick_text,
    samples_to_segments,
)


class IsSimilarTest(unittest.TestCase):
    def test_identical_and_jittered_readings_match(self):
        self.assertTrue(is_similar("浙江省台州市岸邊", "浙江省台州市岸邊"))
        # One misread character (浪 -> 良) is still the same caption.
        self.assertTrue(
            is_similar("掀起超過10公尺高的巨浪", "掀起超過10公尺高的巨良")
        )

    def test_different_captions_do_not_match(self):
        self.assertFalse(is_similar("屋內都是海水", "街道上汽車都被沖走"))

    def test_empty_only_matches_empty(self):
        self.assertTrue(is_similar("", ""))
        self.assertFalse(is_similar("", "浙江"))


class PickTextTest(unittest.TestCase):
    def test_majority_wins_over_score(self):
        variants = [("正確的字", 0.8), ("正確的字", 0.8), ("正確的宇", 0.99)]
        self.assertEqual(pick_text(variants), "正確的字")

    def test_score_breaks_ties(self):
        variants = [("甲", 0.7), ("乙", 0.9)]
        self.assertEqual(pick_text(variants), "乙")

    def test_content_breaks_count_ties(self):
        # 1:1 between a frame that read both lines and a frame that missed
        # one: prefer the fuller reading, whatever the scores say.
        variants = [("第一行\n第二行", 0.8), ("第一行", 0.99)]
        self.assertEqual(pick_text(variants), "第一行\n第二行")


class SamplesToSegmentsTest(unittest.TestCase):
    def test_consecutive_similar_readings_merge(self):
        samples = [
            (0.0, "屋內都是海水", 0.9),
            (1.0, "屋內都是海水", 0.9),
            (2.0, "屋內都是海水", 0.9),
        ]
        segments = samples_to_segments(samples, 1.0)
        self.assertEqual(len(segments), 1)
        self.assertEqual(segments[0]["start"], 0.0)
        self.assertEqual(segments[0]["end"], 3.0)
        self.assertEqual(segments[0]["text"], "屋內都是海水")

    def test_empty_reading_closes_a_segment(self):
        samples = [
            (0.0, "第一句", 0.9),
            (1.0, "", 0.0),
            (2.0, "第二句", 0.9),
        ]
        segments = samples_to_segments(samples, 1.0)
        self.assertEqual([s["text"] for s in segments], ["第一句", "第二句"])
        self.assertEqual(segments[0]["end"], 1.0)
        self.assertEqual(segments[1]["start"], 2.0)

    def test_caption_change_without_gap_splits_segments(self):
        samples = [
            (0.0, "屋內都是海水", 0.9),
            (1.0, "街道上汽車都被沖走", 0.9),
        ]
        segments = samples_to_segments(samples, 1.0)
        self.assertEqual(len(segments), 2)

    def test_jittered_frame_folds_into_majority(self):
        samples = [
            (0.0, "掀起超過10公尺高的巨浪", 0.9),
            (1.0, "掀起超過10公尺高的巨良", 0.8),
            (2.0, "掀起超過10公尺高的巨浪", 0.9),
        ]
        segments = samples_to_segments(samples, 1.0)
        self.assertEqual(len(segments), 1)
        self.assertEqual(segments[0]["text"], "掀起超過10公尺高的巨浪")

    def test_no_samples(self):
        self.assertEqual(samples_to_segments([], 1.0), [])

    def test_caption_vanishing_under_a_tag_splits_the_segment(self):
        # A source tag stays on screen while the caption disappears at t=6.
        # Judged by text similarity alone these chain into one segment and the
        # caption-less majority erases the caption; the line-set change must
        # split them (seen live with a NEWSFLARE/路透社 tag).
        tag = "NEWSFLARE路透社"
        cap = "海水漫過堤壩，淹沒了道路\n畫面相當驚人"
        samples = [
            (float(t), f"{tag}\n{cap}", 0.9, frozenset({1, 2, 3})) for t in range(6)
        ] + [(float(t), tag, 0.9, frozenset({1})) for t in range(6, 13)]
        segments = samples_to_segments(samples, 1.0)
        self.assertEqual(len(segments), 2)
        self.assertIn("海水漫過堤壩", segments[0]["text"])
        self.assertEqual(segments[0]["end"], 6.0)

    def test_fragment_stub_absorbed_into_full_neighbour(self):
        # A frame caught mid-transition reads only a piece of the caption; the
        # resulting stub segment must fold into the full-text neighbour
        # instead of standing as its own subtitle.
        full = "颱風巴威十一日深夜登陸浙江"
        samples = [
            (0.0, "颱風巴威", 0.8, frozenset({2})),
            (1.0, full, 0.99, frozenset({1})),
            (2.0, full, 0.99, frozenset({1})),
            (3.0, full, 0.99, frozenset({1})),
        ]
        segments = samples_to_segments(samples, 1.0)
        self.assertEqual(len(segments), 1)
        self.assertEqual(segments[0]["text"], full)
        self.assertEqual(segments[0]["start"], 0.0)
        self.assertEqual(segments[0]["end"], 4.0)

    def test_rotating_line_under_static_block_stays_split(self):
        # A static 4-line summary fills the screen while a broadcaster caption
        # rotates beneath it. Whole-text similarity would reunite these states
        # (the big block dominates the ratio) and majority-vote lines away —
        # they must stay separate, each keeping the full block plus its own
        # rotating line.
        block = "第一行摘要文字\n第二行摘要文字\n第三行摘要文字\n第四行摘要文字"
        rotating = ["車主們自發把車開上高架橋", "沿道路兩側整齊停放車輛", "留出中間讓應急車輛通行"]
        samples = []
        for t in range(9):
            line = rotating[t // 3]
            samples.append(
                (float(t), f"{block}\n{line}", 0.95, frozenset({1, 2, 3, 4, 10 + t // 3}))
            )
        segments = samples_to_segments(samples, 1.0)
        self.assertEqual(len(segments), 3)
        for seg, line in zip(segments, rotating):
            self.assertIn("第一行摘要文字", seg["text"])
            self.assertIn(line, seg["text"])

    def test_flickering_watermark_does_not_shred_a_caption(self):
        # A small watermark is only readable every third frame; the resulting
        # line-set changes must not cut the stable caption into pieces, and
        # the majority vote should drop the flicker from the final text.
        cap = "這樣的木板是一塊一塊的"
        samples = []
        for t in range(9):
            if t % 3 == 2:
                samples.append((float(t), f"{cap}\n新京报", 0.9, frozenset({1, 2})))
            else:
                samples.append((float(t), cap, 0.9, frozenset({1})))
        segments = samples_to_segments(samples, 1.0)
        self.assertEqual(len(segments), 1)
        self.assertEqual(segments[0]["start"], 0.0)
        self.assertEqual(segments[0]["end"], 9.0)
        self.assertEqual(segments[0]["text"], cap)


class FilterFurnitureTest(unittest.TestCase):
    def frames(self, seconds, lines_at):
        """Build raw samples: lines_at maps second -> [(y, text, score)]."""
        return [(float(t), lines_at.get(t, [])) for t in range(seconds)]

    def test_topically_similar_lines_stay_separate_clusters(self):
        # Two different captions about the same topic score ~0.61 similar —
        # above the loose state threshold but below the strict clustering
        # one. Merging them corrupts both lines' runs; both must survive.
        a = "台风“巴威”逼近浙江临海车主自发"
        b = "颱風巴威逼近浙江台州臨海"
        lines_at = {t: [(40.0, a, 0.99)] for t in range(0, 6)}
        for t in range(6, 9):
            lines_at[t] = [(40.0, a, 0.99), (400.0, b, 0.99)]
        samples = filter_furniture(self.frames(20, lines_at), 1.0)
        joined = "".join(s[1] for s in samples)
        self.assertIn(a, joined)
        self.assertIn(b, joined)

    def test_static_logo_dropped_captions_kept(self):
        # A station logo on screen the whole video, a caption for 4 seconds.
        lines_at = {
            t: [(430.0, "TVBS", 0.95)]
            + ([(60.0, "記者體驗颱風威力", 0.99)] if 10 <= t < 14 else [])
            for t in range(60)
        }
        samples = filter_furniture(self.frames(60, lines_at), 1.0)
        texts = {s[1] for s in samples if s[1]}
        self.assertEqual(texts, {"記者體驗颱風威力"})

    def test_long_dwell_headline_dropped(self):
        # A headline strip that stays up 30 s straight exceeds the dwell cap.
        lines_at = {
            t: [(380.0, "巴威直撲！陸浙江高架橋變停車場", 0.95)]
            + ([(60.0, "這樣的木板是一塊一塊的", 0.99)] if 5 <= t < 11 else [])
            for t in range(30)
        }
        samples = filter_furniture(self.frames(30, lines_at), 1.0)
        texts = {s[1] for s in samples if s[1]}
        self.assertEqual(texts, {"這樣的木板是一塊一塊的"})

    def test_jittered_furniture_clusters_and_drops_together(self):
        # OCR reads the same ticker slightly differently frame to frame; the
        # fuzzy clustering must treat the variants as one long-lived line.
        variants = ["更多新聞在這裡", "更多新聞在道裡", "更多新聞在道理"]
        lines_at = {
            t: [(368.0, variants[t % 3], 0.9)] for t in range(40)
        }
        samples = filter_furniture(self.frames(40, lines_at), 1.0)
        self.assertTrue(all(s[1] == "" for s in samples))

    def test_blinking_logo_dropped_by_presence_fraction(self):
        # Visible only in alternating stretches (never 20 s straight) but
        # covering half the runtime — the presence cutoff catches it.
        lines_at = {
            t: [(26.0, "二度登陸浙江", 0.95)] if (t // 10) % 2 == 0 else []
            for t in range(120)
        }
        samples = filter_furniture(self.frames(120, lines_at), 1.0)
        self.assertTrue(all(s[1] == "" for s in samples))

    def test_survivors_join_top_to_bottom(self):
        lines_at = {
            0: [(90.0, "下面那一行", 0.9), (40.0, "上面這一行", 0.9)],
        }
        samples = filter_furniture(self.frames(1, lines_at), 1.0)
        self.assertEqual(samples[0][1], "上面這一行\n下面那一行")

    def test_line_cap_counts_after_furniture_removal(self):
        # A busy news frame: 9 raw lines, 7 of them furniture. The graphics-
        # screen cap must count the 2 surviving caption lines, not the 9 raw
        # ones — otherwise every frame of a busy layout is discarded.
        furniture = [
            (430.0 + i, f"電視台元素{i}", 0.9) for i in range(7)
        ]
        lines_at = {
            t: furniture
            + ([(60.0, "真正的字幕", 0.99), (85.0, "第二行字幕", 0.99)] if t < 5 else [])
            for t in range(60)
        }
        samples = filter_furniture(self.frames(60, lines_at), 1.0)
        texts = {s[1] for s in samples if s[1]}
        self.assertEqual(texts, {"真正的字幕\n第二行字幕"})

    def test_promo_wall_of_short_lived_lines_discarded(self):
        # An end-card promo screen: many distinct short-lived lines at once.
        wall = [(20.0 + i * 30, f"促銷文字{i}下載", 0.9) for i in range(12)]
        lines_at = {t: wall if t >= 55 else [] for t in range(60)}
        samples = filter_furniture(self.frames(60, lines_at), 1.0)
        self.assertTrue(all(s[1] == "" for s in samples))

    def test_reporter_tag_spanning_several_captions_dropped(self):
        # A speaker/source tag (新京報記者) sits on screen across four distinct
        # interview captions — the user reads it as noise. Its run contains
        # four complete shorter runs, so the local-tag rule removes it while
        # each caption line survives on its own.
        caps = ["這樣的木板是一塊一塊的", "然後放在這裡的縫隙裡", "所以當我去碰觸的時候", "實際上它是紋絲不動的"]
        lines_at = {}
        for t in range(43, 52):
            cap = caps[min((t - 43) // 2, 3)]
            lines_at[t] = [(360.0, "新京報記者", 0.95), (400.0, cap, 0.99)]
        samples = filter_furniture(
            [(float(t), lines_at.get(t, [])) for t in range(60)], 1.0
        )
        texts = {s[1] for s in samples if s[1]}
        self.assertEqual(texts, set(caps))

    def test_a_tag_is_dropped_wherever_it_recurs(self):
        # A headline strip: alone on screen 0-5 s, then sitting through three
        # caption changes 10-19 s, then alone again 25-30 s. Only the middle
        # run has captions to outlast, so the run-by-run rule caught it there
        # and kept it at both ends, where it shipped as a caption (seen live,
        # GzUpiAc1Irc). Once it is a tag, it is a tag everywhere.
        banner = "巴威直撲陸浙江高架橋變停車場躲淹水"
        caps = ["颱風巴威逼近浙江台州臨海", "車主們自發集體把車開上高架橋", "車輛沿道路兩側整齊停放"]
        lines_at = {t: [(30.0, banner, 0.97)] for t in range(0, 5)}
        for t in range(10, 19):
            lines_at[t] = [(30.0, banner, 0.97), (400.0, caps[(t - 10) // 3], 0.99)]
        for t in range(25, 30):
            lines_at[t] = [(30.0, banner, 0.97)]
        samples = filter_furniture(self.frames(40, lines_at), 1.0)
        joined = "".join(s[1] for s in samples)
        self.assertNotIn(banner, joined)
        for cap in caps:
            self.assertIn(cap, joined)

    def test_a_caption_that_recurs_without_ever_being_a_tag_survives(self):
        # A refrain shown twice, each time on its own: never sat through
        # anything, so there is no verdict to spread.
        refrain = "風雨過後就是晴天"
        lines_at = {t: [(400.0, refrain, 0.99)] for t in [*range(0, 3), *range(20, 23)]}
        lines_at.update({t: [(400.0, "中間的另一句台詞", 0.99)] for t in range(8, 11)})
        samples = filter_furniture(self.frames(30, lines_at), 1.0)
        times = [s[0] for s in samples if s[1] == refrain]
        self.assertEqual(times, [0.0, 1.0, 2.0, 20.0, 21.0, 22.0])

    def test_a_backdrop_verdict_does_not_spread_to_a_matching_caption(self):
        # An article screenshot whose first line the narration's caption later
        # reads out word for word. The block is dropped as backdrop over
        # 0-12 s; the caption at 20-23 s is the same text, and must stay.
        block = ["台风巴威逼近浙江临海车主自发", "把车开上还未通车的立交桥避险"]
        lines_at = {}
        for t in range(12):
            rotating = "高架橋上停滿避險車輛" if t < 6 else "沿路兩側整齊停放留出車道"
            lines_at[t] = [(30.0, block[0], 0.99), (55.0, block[1], 0.99), (400.0, rotating, 0.95)]
        for t in range(20, 23):
            lines_at[t] = [(400.0, block[0], 0.99)]
        samples = filter_furniture(self.frames(30, lines_at), 1.0)
        times = [s[0] for s in samples if s[1] == block[0]]
        self.assertEqual(times, [20.0, 21.0, 22.0])

    # Furniture slots and one-frame noise. Boxes are (x0, y0, x1, y1) as
    # fractions of the frame, measured off the test videos.
    CREDIT = (0.40, 0.07, 0.95, 0.12)     # MANBO HOMESTAY…/AP, top right
    CAPTION = (0.32, 0.79, 0.86, 0.90)    # centred, bottom
    LABEL = (0.245, 0.742, 0.356, 0.806)  # 錢江新聞, a speaker/source label

    def line(self, text, box, score=0.99):
        return (box[1] * 360, text, score, box)

    def test_a_new_credit_in_a_furniture_slot_is_dropped(self):
        # MANBO…/AP sits top right for 60 s and is dropped for dwell. Later a
        # different credit appears for 12 s on the same right edge, at the same
        # height: no time rule can call it, but it is the same furniture.
        lines_at = {t: [self.line("MANBO HOMESTAY VALIDATED UGC/AP", self.CREDIT)] for t in range(60)}
        for t in range(70, 82):
            lines_at[t] = [self.line("SOCIAL MEDIA/路透社", (0.68, 0.07, 0.95, 0.12))]
        for t in range(72, 77):
            lines_at[t] = lines_at[t] + [self.line("街道上汽車都被沖走", self.CAPTION)]
        samples = filter_furniture(self.frames(90, lines_at), 1.0)
        joined = "".join(s[1] for s in samples)
        self.assertNotIn("SOCIAL MEDIA", joined)
        self.assertIn("街道上汽車都被沖走", joined)

    def test_a_slot_shared_mostly_with_captions_is_left_alone(self):
        # TVBS's headline strip sits in the caption band at caption height and
        # is dropped for dwell. Captions there share its top, bottom and,
        # for a long one, nearly its edges. They outnumber it, so its slot
        # must not be used — or every caption goes with it.
        strip = (0.25, 0.79, 0.96, 0.90)
        lines_at = {t: [self.line("巴威直撲陸浙江高架橋變停車場躲淹水", strip)] for t in range(0, 30)}
        caps = ["颱風巴威逼近浙江台州臨海", "車主們自發集體把車開上高架橋避險", "車輛沿道路兩側整齊停放"]
        for i, cap in enumerate(caps):
            for t in range(40 + 3 * i, 42 + 3 * i):
                lines_at[t] = [self.line(cap, (0.27, 0.79, 0.94, 0.90))]
        samples = filter_furniture(self.frames(60, lines_at), 1.0)
        joined = "".join(s[1] for s in samples)
        for cap in caps:
            self.assertIn(cap, joined)

    def test_a_backdrop_block_does_not_teach_its_slot(self):
        # An on-screen article (a backdrop block) sits in the picture's
        # content area, where an embedded clip's own captions also go. The
        # article is dropped; captions later shown in the same place are not.
        block = ["台风巴威逼近浙江临海车主自发", "把车开上还未通车的立交桥避险"]
        lines_at = {}
        for t in range(12):
            rotating = "高架橋上停滿避險車輛" if t < 6 else "沿路兩側整齊停放留出車道"
            lines_at[t] = [
                self.line(block[0], (0.30, 0.30, 0.70, 0.36)),
                self.line(block[1], (0.30, 0.37, 0.70, 0.43)),
                self.line(rotating, self.CAPTION),
            ]
        for t in range(20, 23):
            lines_at[t] = [self.line("网友把车都停在楼顶停车场", (0.30, 0.37, 0.62, 0.43))]
        samples = filter_furniture(self.frames(30, lines_at), 1.0)
        self.assertIn("网友把车都停在楼顶停车场", "".join(s[1] for s in samples))

    def test_speaker_labels_in_a_tag_slot_are_dropped(self):
        # 錢江新聞 sits through three captions: a tag. Later labels in the
        # same slot (left-aligned, same height) are labels too, even shown
        # beside a single caption. A third label, already dropped with a
        # backdrop block, must not count as a survivor and outvote the slot.
        caps = ["颱風巴威逼近浙江台州臨海", "車主們自發集體把車開上高架橋", "車輛沿道路兩側整齊停放"]
        lines_at = {}
        for t in range(0, 9):
            lines_at[t] = [self.line("錢江新聞", self.LABEL), self.line(caps[t // 3], self.CAPTION)]
        for t in range(20, 24):
            lines_at[t] = [
                self.line("浙江溫嶺公司值班人員", (0.247, 0.742, 0.506, 0.803)),
                self.line("羅漢松前兩天就開始做這個罩子", self.CAPTION),
            ]
        # 侶行…王曠涵 shares its span with a second line, so the tag rule's
        # partner guard spares it and the backdrop rule drops the pair.
        rotating = ["強風一吹頭髮瞬間凌亂", "現場還同步測試", "窗戶貼上米字膠帶"]
        for t in range(40, 49):
            lines_at[t] = [
                self.line("侶行杭州基地負責人王曠涵", (0.25, 0.744, 0.566, 0.803)),
                self.line("@钱江视频", (0.88, 0.12, 0.97, 0.16)),
                self.line(rotating[(t - 40) // 3], self.CAPTION),
            ]
        samples = filter_furniture(self.frames(60, lines_at), 1.0)
        joined = "".join(s[1] for s in samples)
        self.assertNotIn("浙江溫嶺公司值班人員", joined)
        self.assertIn("羅漢松前兩天就開始做這個罩子", joined)

    def test_a_one_frame_low_confidence_read_is_noise(self):
        lines_at = {
            5: [self.line("博校频号", (0.59, 0.05, 0.64, 0.08), score=0.80)],
            9: [self.line("進行有效的保護", self.CAPTION, score=1.0)],
        }
        samples = filter_furniture(self.frames(15, lines_at), 1.0)
        texts = {s[1] for s in samples if s[1]}
        self.assertEqual(texts, {"進行有效的保護"}, "one crisp frame is still a caption")

    def test_noise_still_counts_as_the_screen_changing_under_a_tag(self):
        # 75公斤記者實測… was caught as a tag because it sat through flickering
        # watermark reads. Those reads leave the output, but they must still
        # count as other lines changing, or the banner comes back as a caption.
        banner = "75公斤記者實測12級風像溺水窒息快嚇哭"
        lines_at = {t: [self.line(banner, (0.25, 0.79, 0.96, 0.90))] for t in range(0, 12)}
        for t, junk in [(2, "博校频号"), (5, "工视频"), (8, "新以信")]:
            lines_at[t] = lines_at[t] + [self.line(junk, (0.59, 0.05, 0.64, 0.08), score=0.8)]
        samples = filter_furniture(self.frames(20, lines_at), 1.0)
        joined = "".join(s[1] for s in samples)
        self.assertNotIn(banner, joined)
        self.assertNotIn("博校频号", joined)

    def test_backdrop_block_over_rotating_captions_dropped(self):
        # An article screenshot: four summary lines share the screen 0-12 s
        # while the clip's real captions rotate beneath them, reading the
        # same story out. The block is scenery — shown as a subtitle it's a
        # wall of text whose content then repeats line by line (seen live,
        # user-reported). The first line's final frame fails to read, so its
        # run ends 1 s early: the slack that groups equal-span partners must
        # absorb the miss, not split the block out of backdrop detection.
        block = [
            "台风巴威逼近浙江临海车主自发",
            "把车开上还未通车的立交桥避险",
            "这是迎战利奇马换来的生存智慧",
            "浙江宁波等地宣布道路泊位免费",
        ]
        lines_at = {}
        for t in range(12):
            lines = [(30.0 + i * 25, text, 0.99) for i, text in enumerate(block)]
            if t == 11:
                lines = lines[1:]  # line 1 unreadable in the last frame
            rotating = "高架橋上停滿避險車輛" if t < 6 else "沿路兩側整齊停放留出車道"
            lines.append((400.0, rotating, 0.95))
            lines_at[t] = lines
        samples = filter_furniture(
            [(float(t), lines_at.get(t, [])) for t in range(20)], 1.0
        )
        joined = "".join(s[1] for s in samples)
        self.assertNotIn("台风巴威逼近浙江临海车主自发", joined)
        self.assertIn("高架橋上停滿避險車輛", joined)
        self.assertIn("沿路兩側整齊停放留出車道", joined)

    def test_equal_span_caption_block_is_not_a_tag(self):
        # A static multi-line summary: all lines share one span, so none
        # "contains" the others and the block survives intact.
        block = [(30.0 + i * 25, f"字幕內容第{i}行的文字", 0.95) for i in range(4)]
        lines_at = {t: block for t in range(1, 12)}
        samples = filter_furniture(
            [(float(t), lines_at.get(t, [])) for t in range(20)], 1.0
        )
        texts = {s[1] for s in samples if s[1]}
        self.assertEqual(len(texts), 1)
        self.assertEqual(len(next(iter(texts)).split("\n")), 4)

    def test_title_block_over_several_caption_changes_dropped(self):
        # A two-line title card sitting through two complete caption changes
        # has the same temporal shape as a single-line tag over the same
        # captions — the group rule drops it the same way (a single-line
        # header there would already be a tag; line count shouldn't grant
        # immunity).
        lines_at = {}
        for t in range(8):
            lines_at[t] = [
                (40.0, "巴威颱風登陸浙江", 0.99),
                (70.0, "岸邊掀巨浪吞民宅", 0.99),
                (250.0, "巨浪拍向窗戶" if t < 3 else "屋頂也全是海水", 0.95),
            ]
        samples = filter_furniture(
            [(float(t), lines_at.get(t, [])) for t in range(30)], 1.0
        )
        joined = "".join(s[1] for s in samples)
        self.assertNotIn("巴威颱風登陸浙江", joined)
        self.assertIn("巨浪拍向窗戶", joined)
        self.assertIn("屋頂也全是海水", joined)

    def test_title_block_over_one_caption_change_survives(self):
        # A block with a single caption line living inside its span hasn't
        # "sat through caption changes" — it's a title card plus its one
        # sub-caption, both study material. The backdrop rule needs several
        # contained runs, same bar as the single-line tag rule.
        lines_at = {}
        for t in range(2, 10):
            lines_at[t] = [
                (40.0, "巴威颱風登陸浙江", 0.99),
                (70.0, "岸邊掀巨浪吞民宅", 0.99),
            ] + ([(250.0, "巨浪拍向窗戶", 0.95)] if 4 <= t < 7 else [])
        samples = filter_furniture(
            [(float(t), lines_at.get(t, [])) for t in range(30)], 1.0
        )
        joined = "".join(s[1] for s in samples)
        self.assertIn("巴威颱風登陸浙江", joined)
        self.assertIn("岸邊掀巨浪吞民宅", joined)
        self.assertIn("巨浪拍向窗戶", joined)

    def test_fragment_reads_do_not_make_a_caption_a_tag(self):
        # OCR occasionally reads fragments ("颱風", "登陸") out of one long
        # caption. Those contained runs are jitter, not caption changes — the
        # full line must not be classified as a tag because of them.
        full = "颱風巴威登陸浙江後帶來強勁風雨"
        lines_at = {}
        for t in range(8):
            if t in (2, 5):
                lines_at[t] = [(60.0, "颱風", 0.9), (60.0, "登陸", 0.9)]
            else:
                lines_at[t] = [(60.0, full, 0.99)]
        samples = filter_furniture(
            [(float(t), lines_at.get(t, [])) for t in range(30)], 1.0
        )
        self.assertIn(full, "".join(s[1] for s in samples))

    def test_short_video_keeps_short_captions(self):
        # In a 10 s clip a 5 s caption is half the runtime; the presence rule
        # must not eat legitimate captions just because the video is short.
        lines_at = {t: [(60.0, "短片字幕", 0.9)] if t < 5 else [] for t in range(10)}
        samples = filter_furniture(self.frames(10, lines_at), 1.0)
        texts = {s[1] for s in samples if s[1]}
        self.assertEqual(texts, {"短片字幕"})


class CaptionLineFilterTest(unittest.TestCase):
    def test_stray_marks_dropped_cjk_and_words_kept(self):
        self.assertFalse(_is_caption_line("1"))
        self.assertFalse(_is_caption_line("|/"))
        # Single CJK characters are dropped too: every observed one (我, 日)
        # was a half-read watermark or graphic, not a caption.
        self.assertFalse(_is_caption_line("我"))
        # Short non-CJK strings are graphics fragments ("NB2"), not words.
        self.assertFalse(_is_caption_line("NB2"))
        self.assertTrue(_is_caption_line("木板"))
        self.assertTrue(_is_caption_line("ETtoday"))


class CjkRatioTest(unittest.TestCase):
    def test_chinese_captions_dominate(self):
        segments = [{"text": "浙江省台州市岸邊"}, {"text": "10公尺"}]
        self.assertGreater(cjk_ratio(segments), 0.5)

    def test_latin_text_scores_low(self):
        segments = [{"text": "BREAKING NEWS"}, {"text": "storm surge"}]
        self.assertLess(cjk_ratio(segments), 0.2)

    def test_empty(self):
        self.assertEqual(cjk_ratio([]), 0.0)


if __name__ == "__main__":
    unittest.main()
