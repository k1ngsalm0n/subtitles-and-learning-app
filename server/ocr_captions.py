#!/usr/bin/env python3
"""Read burned-in (hardcoded) captions off video frames with RapidOCR.

Used by server/import.mjs when the user asks to read on-screen captions —
common for news clips whose commentary is written on the video instead of
spoken. Frames are sampled across the whole picture (every frame is OCR'd —
a cheap change-detection pass was tried and silently missed captions whose
strokes barely moved the pixel mask), and each text line is tracked over time
so screen furniture can be told apart from captions:

  * Furniture (station logos, tickers, headline strips, location tags) sits on
    screen for tens of seconds to the whole video — any text line whose dwell
    time is too long is dropped, wherever it appears.
  * Per-clip tags (source watermarks, reporter/location labels) are shorter-
    lived than global furniture but still outlast the captions they share the
    screen with — any line whose on-screen run fully contains several complete
    runs of other lines is dropped as a local tag.
  * Furniture slots: once a video's furniture is known, a new line in the
    exact slot it held (same top, bottom and one edge) is furniture too —
    a fresh credit or location pin, however briefly it shows. A slot counts
    only where furniture outnumbers the other lines ever seen in it.
  * One-frame noise: a line read in a single frame with low confidence is a
    flickering watermark, not a caption.
  * Captions (speech subtitles, title cards) live for a few seconds each —
    short-dwell lines are kept and merged into timed segments, with a majority
    vote across frames to iron out per-frame OCR jitter.

Prints one line of JSON to stdout, same shape as transcribe.py:
{"language": "zh", "segments": [{"start", "end", "text"}]}
or {"error": "no_captions"} when nothing legible was found.
Diagnostics go to stderr.
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
from difflib import SequenceMatcher

import happy_eyeballs  # noqa: F401 — RFC 8305 connect race (see module docstring)

# Frames sampled per second — every sampled frame is OCR'd. 1 fps is roughly
# 0.5 s of CPU per video-second on a modest machine; set OCR_FPS=0.5 to halve
# that on a weak laptop (captions persist for seconds, so timing barely
# coarsens).
FPS = float(os.environ.get("OCR_FPS", "1"))
# Fraction of the frame height, measured up from the bottom, to scan. Default
# is the whole frame — the dwell filter below removes non-caption text, so no
# positional guess is needed (news layouts put captions anywhere).
CAPTION_BAND = float(os.environ.get("OCR_CAPTION_BAND", "1"))
# Drop OCR readings below this confidence.
MIN_SCORE = 0.7
# Two frames' captions are "the same caption" above this similarity.
SIMILARITY = 0.6
# Stricter bar for clustering individual lines across frames. Misreads of one
# line score ~0.85+ (a character or two differs); genuinely different captions
# that share a topic can score just above 0.6 ("台风巴威逼近浙江临海车主自发"
# vs "颱風巴威逼近浙江台州臨海" ≈ 0.61) and merging them corrupts both lines'
# on-screen runs — which feeds every downstream rule wrong data.
CLUSTER_SIMILARITY = 0.75
# Bar for reuniting adjacent segments after a line-set split: reuniting is
# only safe when the segments differ by a small flickering line (a watermark
# blinking in and out of OCR readability), measured line-by-line — the
# differing lines' characters must stay under this fraction of the shared
# lines' characters. Whole-text similarity is NOT safe here: a big static
# caption block dominates the ratio, so states where a real caption line
# rotated beneath it look "similar", get glued, and the majority vote then
# erases lines.
REUNITE_DIFF_RATIO = 0.34
# Furniture cutoffs: a text line is dropped as screen furniture when it stays
# up longer than this in one stretch (speech captions run 3–15 s; headline
# strips and tickers run 20 s to minutes)…
MAX_DWELL_SECONDS = float(os.environ.get("OCR_MAX_DWELL", "20"))
# …or when it is visible for more than this fraction of the whole video
# (headline strips and location tags blink with scene cuts, so no single
# stretch trips the dwell cap, but they still accumulate much of the runtime).
MAX_PRESENCE_FRACTION = 0.25
# A frame still showing this many text lines after furniture removal isn't
# captions — it's a graphics screen (end-card promo walls: subscribe buttons,
# QR codes, app banners). Counted after the furniture filter, since busy news
# layouts carry ~10 raw lines of which most are furniture.
MAX_LINES = 8
# A line whose single on-screen run fully contains this many complete runs of
# other lines is a per-clip tag (source watermark, reporter/location label):
# real captions live and die with what is said, tags sit through several
# caption changes. Size/position can't tell them apart (embedded-clip captions
# are often *smaller* than watermarks), but this temporal shape can.
TAG_MIN_CONTAINED_RUNS = 2
# A line read in only one frame is weak evidence. Real captions read crisply
# even then (0.93-1.00 on the test videos); the one-frame readings below this
# were all garbled watermarks — 微博视频号 read as 博校频号, 新以信 — which
# flicker in and out of legibility and never read the same way twice, so no
# reading of them lasts long enough for the dwell or tag rules to see.
ONE_FRAME_MIN_SCORE = 0.9
# Furniture slots. A news layout puts the same kind of furniture in the same
# place every time — a source credit at the top right, a location pin under
# it, a speaker label at one left edge — and a new instance there is
# furniture too, however briefly it shows. A line is in a furniture line's
# slot when its top and bottom are within this fraction of the frame height
# of the furniture's, and it shares the furniture's left or right edge within
# this fraction of the width. Shared top, bottom and edge — not mere overlap:
# captions are centred, and their edges move with their length.
SLOT_TOLERANCE = 0.03
# Samples this far apart still belong to one on-screen run: OCR failing to
# read a line for a single frame must not split its run — a split run loses
# its equal-span partners and can be misclassified as a tag. Two consecutive
# missed frames end the run.
RUN_GAP_TOLERANCE = 2.5
# OCR now runs automatically on every URL import, so videos without burned-in
# text must bail out cheaply: probe this many frames spread across the video
# and only do the full pass when at least PROBE_MIN_HITS of them show Chinese
# text (~a few seconds instead of the full per-frame pass).
PROBE_FRAMES = 8
PROBE_MIN_HITS = 2


# Progress goes to stderr, tagged, so server/import.mjs can pick it out of the
# ordinary diagnostics on the same pipe. stdout stays exactly one JSON line —
# the result — so nothing downstream has to learn a new output shape.
PROGRESS_PREFIX = "@progress "
_last_percent = -1


def _emit_progress(done, total):
    """Report frames read. Emits only when the whole percent moves, so a long
    video sends ~100 lines rather than one per frame."""
    global _last_percent
    percent = int(done * 100 / total) if total else 100
    if percent == _last_percent and 0 < done < total:
        return
    _last_percent = percent
    sys.stderr.write(
        PROGRESS_PREFIX + json.dumps({"done": done, "total": total}) + "\n"
    )
    sys.stderr.flush()


def _extract_frames(video_path, workspace):
    """Sample the caption band into numbered JPEGs; returns their paths."""
    band = min(max(CAPTION_BAND, 0.05), 1.0)
    vf = f"fps={FPS}" if band >= 1.0 else (
        f"fps={FPS},crop=iw:ih*{band}:0:ih*{1 - band}"
    )
    subprocess.run(
        ["ffmpeg", "-y", "-i", video_path, "-vf", vf, "-qscale:v", "3",
         os.path.join(workspace, "%06d.jpg")],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        timeout=30 * 60,
    )
    return sorted(
        os.path.join(workspace, f)
        for f in os.listdir(workspace)
        if f.endswith(".jpg")
    )


def _is_caption_line(text):
    """Filter OCR noise. A stray pole/edge reads as '1' or '|', and a half-read
    watermark ('我们' logo) as a lone character — every single-character line
    observed in practice was junk, so captions need at least two CJK
    characters, or three characters otherwise."""
    cjk = sum(1 for ch in text if "㐀" <= ch <= "鿿")
    return cjk >= 2 or len(text) >= 4


def _read_lines(engine, img):
    """OCR one frame; returns text lines as [(y, text, score, box)], top first.

    `box` is (x0, y0, x1, y1) as fractions of the frame, so furniture slots
    compare across videos of any resolution.
    """
    out = engine(img)
    if not out.txts:
        return []
    height, width = img.shape[:2]
    lines = []
    for box, text, score in zip(out.boxes, out.txts, out.scores):
        text, score = text.strip(), float(score)
        if text and score >= MIN_SCORE and _is_caption_line(text):
            xs = [float(p[0]) for p in box]
            ys = [float(p[1]) for p in box]
            norm = (min(xs) / width, min(ys) / height, max(xs) / width, max(ys) / height)
            lines.append((min(ys), text, score, norm))
    return sorted(lines)


def is_similar(a, b, threshold=SIMILARITY):
    """Same caption modulo per-frame OCR jitter?"""
    a, b = "".join(a.split()), "".join(b.split())
    if not a or not b:
        return a == b
    return SequenceMatcher(None, a, b).ratio() >= threshold


def pick_text(variants):
    """Choose the representative reading: most seen, then most content, then
    highest score. Content breaks count ties because OCR is far likelier to
    miss a line for one frame than to hallucinate an extra line at high
    confidence — a 1:1 tie between "with line" and "without line" must not
    fall to chance."""
    tally = {}
    for text, score in variants:
        count, best = tally.get(text, (0, 0.0))
        tally[text] = (count + 1, max(best, score))
    return max(
        tally.items(),
        key=lambda kv: (kv[1][0], len("".join(kv[0].split())), kv[1][1]),
    )[0]


def _max_dwell(times, interval):
    """Longest contiguous on-screen stretch, given sorted sample times."""
    longest = run_start = prev = None
    for t in times:
        if prev is None or t - prev > interval * RUN_GAP_TOLERANCE:
            run_start = t
        run = t - run_start + interval
        longest = run if longest is None or run > longest else longest
        prev = t
    return longest or 0.0


def filter_furniture(raw, interval):
    """Drop long-dwell text lines; join the survivors per frame.

    `raw` is [(time, [(y, text, score[, box]), ...])]. Lines are fuzzily clustered
    across frames (OCR jitter makes furniture read slightly differently frame
    to frame), each cluster's screen time is measured, and clusters that
    exceed the dwell/presence cutoffs are removed everywhere. Returns samples
    for samples_to_segments: [(time, joined_text, mean_score)].
    """
    # A cluster keeps a few distinct example readings ("texts") and matches
    # new lines against any of them: jitter drifts (這裡 → 道裡 → 道理), and a
    # double-misread can sit below the threshold against the first reading
    # while clearly matching a later one.
    clusters = []  # {"rep", "texts", "times", "scores", "boxes"}
    assigned = []  # [(time, [(y, text, score, cluster_index), ...])]
    for time, lines in raw:
        row = []
        for line in lines:
            y, text, score = line[:3]
            box = line[3] if len(line) > 3 else None
            index = next(
                (
                    i
                    for i, c in enumerate(clusters)
                    if any(
                        is_similar(v, text, CLUSTER_SIMILARITY)
                        for v in c["texts"]
                    )
                ),
                None,
            )
            if index is None:
                index = len(clusters)
                clusters.append(
                    {"rep": text, "texts": [text], "times": [], "scores": [], "boxes": []}
                )
            cluster = clusters[index]
            if text not in cluster["texts"] and len(cluster["texts"]) < 5:
                cluster["texts"].append(text)
            cluster["times"].append(time)
            cluster["scores"].append(score)
            if box is not None:
                cluster["boxes"].append(box)
            row.append((y, text, score, index))
        assigned.append((time, row))

    total = raw[-1][0] - raw[0][0] + interval if raw else 0.0
    banned = set()
    for index, cluster in enumerate(clusters):
        times = sorted(set(cluster["times"]))
        presence = len(times) * interval
        # The fraction rule needs an absolute floor: on a short clip a normal
        # caption easily covers half the runtime without being furniture.
        fraction_furniture = (
            presence > MAX_DWELL_SECONDS
            and total > 0
            and presence / total > MAX_PRESENCE_FRACTION
        )
        if _max_dwell(times, interval) > MAX_DWELL_SECONDS or fraction_furniture:
            banned.add(index)
    noise = {
        index
        for index, cluster in enumerate(clusters)
        if index not in banned
        and len(set(cluster["times"])) == 1
        and max(cluster["scores"]) < ONE_FRAME_MIN_SCORE
    }
    if noise:
        dropped = ", ".join(repr(clusters[i]["rep"]) for i in sorted(noise))
        sys.stderr.write(f"OCR: dropped one-frame low-confidence reads: {dropped}\n")
    if banned:
        dropped = ", ".join(repr(clusters[i]["rep"]) for i in sorted(banned))
        sys.stderr.write(f"OCR: dropped screen furniture: {dropped}\n")
    # Noise stays in the run analysis below and only leaves the output: a
    # flickering watermark is still something on screen changing, and a
    # banner that sat through several of those flickers is a tag — the
    # 75公斤記者實測… strip was caught that way, and taking the noise out first
    # let it back in as a caption.

    # Contiguous on-screen runs per surviving cluster, for the local-tag rule.
    runs = []  # (cluster_index, start, end)
    for index, cluster in enumerate(clusters):
        if index in banned:
            continue
        times = sorted(set(cluster["times"]))
        run_start = prev = None
        for t in times:
            if prev is not None and t - prev > interval * RUN_GAP_TOLERANCE:
                runs.append((index, run_start, prev + interval))
                run_start = t
            elif run_start is None:
                run_start = t
            prev = t
        if run_start is not None:
            runs.append((index, run_start, prev + interval))

    # Local tags: a run that fully contains several complete, strictly shorter
    # runs of other lines sat through that many caption changes — it's a
    # source watermark or reporter/location label, not a caption. Two guards
    # protect real captions from the same shape:
    #   * a title card also outlasts the lines changing beneath it, but titles
    #     come as multi-line blocks — an equal-span partner run means caption;
    #   * OCR sometimes reads a fragment of a line ("颱風" out of a longer
    #     caption); a contained run whose text is a piece of the container is
    #     jitter, not an independent caption change.
    eps = interval / 2

    def _fragment_of(inner, outer):
        inner = "".join(inner.split())
        outer = "".join(outer.split())
        return inner in outer or is_similar(inner, outer)

    # Partner matching tolerates a missed read at a run's edge (same slack as
    # run bridging): one unreadable frame at the end of a line's run must not
    # strip its equal-span protection and feed it to the tag rule. Both edges
    # AND the duration must agree: a short caption nested just inside a longer
    # run's span has each edge within the slack while being half the length —
    # that's a contained caption change, not a partner (a 2 s caption inside a
    # 6 s watermark run was shielding the watermark from the tag rule, and the
    # backdrop grouping below then dropped the caption with it — seen live).
    partner_eps = interval * RUN_GAP_TOLERANCE

    def _equal_span(s2, e2, start, end):
        return (
            abs(s2 - start) <= partner_eps
            and abs(e2 - end) <= partner_eps
            and abs((e2 - s2) - (end - start)) <= partner_eps
        )

    tag_runs = []
    for ci, start, end in runs:
        partner = any(
            cj != ci and _equal_span(s2, e2, start, end)
            for cj, s2, e2 in runs
        )
        if partner:
            continue
        contained = sum(
            1
            for cj, s2, e2 in runs
            if cj != ci
            and s2 >= start - eps
            and e2 <= end + eps
            and (e2 - s2) <= (end - start) - interval
            and not _fragment_of(clusters[cj]["rep"], clusters[ci]["rep"])
        )
        if contained >= TAG_MIN_CONTAINED_RUNS:
            tag_runs.append((ci, start, end))
    if tag_runs:
        dropped = ", ".join(
            f"{clusters[ci]['rep']!r}@{s:.0f}-{e:.0f}s" for ci, s, e in tag_runs
        )
        sys.stderr.write(f"OCR: dropped per-clip tags: {dropped}\n")

    # A tag is a tag every time it appears. The rule above judges one run at a
    # time, so a headline strip caught sitting through captions at 14-24 s was
    # still kept at 0-6 s and 30-43 s, where nothing else was on screen for it
    # to outlast — and shipped as a caption twice. Captions don't sit through
    # several other captions; a line that did is a banner wherever it recurs.
    # Single-line tags only: a backdrop block's text is often what the
    # narration reads out, so spreading that verdict could take real captions
    # with it.
    tag_clusters = {ci for ci, _s, _e in tag_runs}
    repeats = [
        run for run in runs if run[0] in tag_clusters and run not in tag_runs
    ]
    if repeats:
        dropped = ", ".join(
            f"{clusters[ci]['rep']!r}@{s:.0f}-{e:.0f}s" for ci, s, e in repeats
        )
        sys.stderr.write(f"OCR: dropped repeats of per-clip tags: {dropped}\n")
        tag_runs.extend(repeats)

    # Static backdrop blocks. The partner guard above protects multi-line
    # blocks from the tag rule one run at a time — right for a title card
    # that lives and dies with its caption, but it also shields an article
    # screenshot or summary board that stays up while captions rotate
    # beneath it (its text is what those captions are reading out, so the
    # viewer gets a wall of text that then repeats line by line). Apply the
    # same containment test to each equal-span group as a whole: a block
    # whose shared span sits through several complete runs of other lines is
    # scenery, exactly like a single-line tag with the same temporal shape.
    tagged = set(tag_runs)
    span_groups = []
    for run in runs:
        if run in tagged:
            continue
        _ci, start, end = run
        group = next(
            (
                g
                for g in span_groups
                if _equal_span(start, end, g[0][1], g[0][2])
            ),
            None,
        )
        if group is None:
            span_groups.append([run])
        else:
            group.append(run)
    backdrop_runs = []
    for group in span_groups:
        if len(group) < 2:
            continue
        members = {ci for ci, _s, _e in group}
        start = min(s for _c, s, _e in group)
        end = max(e for _c, _s, e in group)
        contained = sum(
            1
            for run2 in runs
            if run2 not in tagged
            and run2[0] not in members
            and run2[1] >= start - eps
            and run2[2] <= end + eps
            and (run2[2] - run2[1]) <= (end - start) - interval
            and not any(
                _fragment_of(clusters[run2[0]]["rep"], clusters[ci]["rep"])
                for ci in members
            )
        )
        if contained >= TAG_MIN_CONTAINED_RUNS:
            backdrop_runs.extend(group)
    if backdrop_runs:
        dropped = ", ".join(
            f"{clusters[ci]['rep']!r}@{s:.0f}-{e:.0f}s"
            for ci, s, e in backdrop_runs
        )
        sys.stderr.write(f"OCR: dropped static backdrop block: {dropped}\n")
        tag_runs.extend(backdrop_runs)

    # Furniture slots: a line sitting exactly where this video's furniture
    # sits — same top and bottom, same left or right edge — is another piece
    # of it. Learned from the video itself, from lines already proven to be
    # furniture by dwell or as tags. SOCIAL MEDIA/路透社 at the top right ran
    # 17 s and outlasted one caption, so no time rule could call it; but it sat
    # on the right edge MANBO HOMESTAY…/AP and NEWSFLARE/路透社 had held. Same
    # for 河北省承德市 under 浙江省台州市, and speaker labels in the slot
    # 錢江新聞 and 新京報記者 used.
    #
    # The guard: a slot only counts when most of the distinct lines ever seen
    # in it are furniture already. A headline strip can sit in the caption
    # band at caption height — TVBS's does — and without this its slot would
    # take every caption with it; there, captions outnumber headlines ten to
    # one, and the slot is left alone.
    # Learned only from dwell furniture and single-line tags, not backdrop
    # blocks: an on-screen article sits in the picture's content area, where
    # an embedded clip's own captions also go, and learning its slot took two
    # of those captions with it.
    proven = (banned - noise) | tag_clusters
    # What the guard counts, though, is every line some rule already took out,
    # backdrop members included: a line already gone isn't a caption competing
    # for the slot. The speaker-label slot held 錢江新聞 and 新京報記者 (tags)
    # and 侶行杭州基地負責人王曠涵 (dropped with a backdrop block); counted as
    # a survivor, that last one outvoted the furniture and let two more
    # labels through.
    already_out = proven | {ci for ci, _s, _e in tag_runs}

    def _median_box(cluster):
        boxes = cluster["boxes"]
        if not boxes:
            return None
        return tuple(sorted(b[k] for b in boxes)[len(boxes) // 2] for k in range(4))

    boxes = {i: _median_box(c) for i, c in enumerate(clusters)}

    def _same_slot(a, b):
        return (
            a is not None
            and b is not None
            and abs(a[1] - b[1]) <= SLOT_TOLERANCE
            and abs(a[3] - b[3]) <= SLOT_TOLERANCE
            and (
                abs(a[0] - b[0]) <= SLOT_TOLERANCE
                or abs(a[2] - b[2]) <= SLOT_TOLERANCE
            )
        )

    in_slots = set()
    for f in proven:
        if boxes[f] is None:
            continue
        here = [
            i for i in range(len(clusters))
            if i not in noise and _same_slot(boxes[i], boxes[f])
        ]
        held_by_furniture = sum(1 for i in here if i in already_out)
        newcomers = [i for i in here if i not in already_out]
        if newcomers and held_by_furniture >= len(newcomers):
            in_slots.update(newcomers)
    if in_slots:
        dropped = ", ".join(repr(clusters[i]["rep"]) for i in sorted(in_slots))
        sys.stderr.write(f"OCR: dropped lines in furniture slots: {dropped}\n")
        banned |= in_slots
    banned |= noise

    def is_tagged(ci, time):
        return any(
            c == ci and s - eps <= time <= e + eps for c, s, e in tag_runs
        )

    samples = []
    for time, row in assigned:
        kept = [
            (y, text, score, ci)
            for y, text, score, ci in row
            if ci not in banned and not is_tagged(ci, time)
        ]
        if kept and len(kept) <= MAX_LINES:
            text = "\n".join(t for _y, t, _s, _ci in sorted(kept))
            score = sum(s for _y, _t, s, _ci in kept) / len(kept)
            ids = frozenset(ci for _y, _t, _s, ci in kept)
            samples.append((time, text, score, ids))
        else:
            samples.append((time, "", 0.0, frozenset()))
    return samples


def _flicker_only_diff(a, b):
    """True when two display states differ only by a small flickering line.

    Match the states' lines fuzzily; the unmatched lines' characters must be
    a small fraction (REUNITE_DIFF_RATIO) of the matched lines'. A watermark
    blinking over a caption qualifies; a caption line rotating beneath a
    static block does not.
    """
    a_lines = [l for l in a.split("\n") if l.strip()]
    b_lines = [l for l in b.split("\n") if l.strip()]
    used = set()
    common = diff = 0
    for line in a_lines:
        j = next(
            (
                k
                for k, other in enumerate(b_lines)
                if k not in used and is_similar(line, other)
            ),
            None,
        )
        if j is None:
            diff += len("".join(line.split()))
        else:
            used.add(j)
            common += len("".join(line.split()))
    for k, other in enumerate(b_lines):
        if k not in used:
            diff += len("".join(other.split()))
    return common > 0 and diff <= REUNITE_DIFF_RATIO * common


def samples_to_segments(samples, interval):
    """Merge per-frame readings into timed segments.

    Each sample is (time, text, score) or (time, text, score, line_ids). When
    line_ids (the frame's set of line clusters, from filter_furniture) are
    present they define segment boundaries exactly: the segment extends while
    the same lines are on screen and splits the moment the set changes. This
    matters when a persistent tag shares the screen with a caption — judged by
    text similarity alone, "tag + caption" and "tag" chain into one segment
    and the majority vote can erase the caption entirely. Without ids the old
    text-similarity rule applies. A post-pass reunites adjacent segments that
    differ only by a small flickering line (see _flicker_only_diff), so a
    watermark blinking in and out of OCR readability can't shred a stable
    caption — while states where a real caption line changed stay split. Each
    segment's text is the majority vote across its frames.
    """
    runs = []
    current = None  # {"start", "end", "variants": [(text, score)], "ids"}

    def close():
        nonlocal current
        if current:
            runs.append(current)
            current = None

    for sample in samples:
        time, text, score = sample[0], sample[1], sample[2]
        ids = sample[3] if len(sample) > 3 else None
        if not text:
            close()
            continue
        if current is None:
            same = False
        elif current["ids"] is not None and ids is not None:
            same = ids == current["ids"]
        else:
            same = is_similar(current["variants"][-1][0], text)
        if same:
            current["end"] = time + interval
            current["variants"].append((text, score))
        else:
            close()
            current = {
                "start": time,
                "end": time + interval,
                "variants": [(text, score)],
                "ids": ids,
            }
    close()

    merged = []
    for run in runs:
        prev = merged[-1] if merged else None
        if (
            prev
            and abs(run["start"] - prev["end"]) < interval / 2
            and _flicker_only_diff(
                pick_text(prev["variants"]), pick_text(run["variants"])
            )
        ):
            prev["end"] = run["end"]
            prev["variants"].extend(run["variants"])
        else:
            merged.append(run)

    # Absorb fragment stubs: a *brief* segment (a frame or two) whose text is
    # contained in an adjacent segment's text is a partial OCR read of that
    # caption (a frame caught mid-transition reading "颱風/登陸" out of the
    # full line) — fold its time into the fuller neighbour. Longer segments
    # are real state changes (a tag legitimately remaining after its caption
    # leaves) and must stay separate.
    def _within(a, b):
        a, b = "".join(a.split()), "".join(b.split())
        return bool(a) and a != b and a in b

    def _brief(run):
        return run["end"] - run["start"] <= 2 * interval

    cleaned = []
    for run in merged:
        text = pick_text(run["variants"])
        prev = cleaned[-1] if cleaned else None
        if prev and _brief(run) and _within(text, pick_text(prev["variants"])):
            prev["end"] = run["end"]
            continue
        if prev and _brief(prev) and _within(pick_text(prev["variants"]), text):
            run["start"] = prev["start"]
            cleaned[-1] = run
            continue
        cleaned.append(run)
    return [
        {"start": r["start"], "end": r["end"], "text": pick_text(r["variants"])}
        for r in cleaned
    ]


def cjk_ratio(segments):
    text = "".join(s["text"] for s in segments)
    text = "".join(text.split())
    if not text:
        return 0.0
    cjk = sum(1 for ch in text if "㐀" <= ch <= "鿿")
    return cjk / len(text)


def _video_duration(video_path):
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "quiet", "-show_entries", "format=duration",
             "-of", "csv=p=0", video_path],
            capture_output=True, text=True, timeout=60,
        )
        return float(out.stdout.strip())
    except (subprocess.SubprocessError, ValueError):
        return 0.0


def _probe_finds_text(engine, video_path, workspace):
    """OCR a handful of frames spread across the video: is there Chinese text?

    Counts a frame as a hit when any line has two or more CJK characters
    (captions and news furniture both qualify — the point is only to skip
    videos with no burned-in text at all, e.g. vlogs and lectures).
    """
    import cv2

    duration = _video_duration(video_path)
    if duration <= 0:
        return True  # can't probe; assume text and let the full pass decide
    # Probe frames live in their own directory: the full pass globs the
    # workspace for *.jpg and infers each frame's timestamp from its position,
    # so stray probe files would resurface as phantom segments past the end
    # of the video.
    probe_dir = os.path.join(workspace, "probe")
    os.makedirs(probe_dir, exist_ok=True)
    hits = 0
    for k in range(PROBE_FRAMES):
        t = duration * (k + 0.5) / PROBE_FRAMES
        frame = os.path.join(probe_dir, f"{k}.jpg")
        proc = subprocess.run(
            ["ffmpeg", "-y", "-ss", f"{t:.2f}", "-i", video_path,
             "-frames:v", "1", frame],
            capture_output=True, timeout=60,
        )
        if proc.returncode != 0 or not os.path.exists(frame):
            continue
        img = cv2.imread(frame)
        if img is None:
            continue
        cjk_line = any(
            sum(1 for ch in text if "㐀" <= ch <= "鿿") >= 2
            for _y, text, *_rest in _read_lines(engine, img)
        )
        if cjk_line:
            hits += 1
            if hits >= PROBE_MIN_HITS:
                return True
    return False


def _build_engine():
    """RapidOCR, optionally held to a thread budget.

    Left alone (-1), onnxruntime picks its own thread count, and its choice is
    good: measured on a 6-core/12-thread desktop it beat every number this knob
    can set — 81s against 94s at 4 threads, 98s at 8 and 107s at 12. So a cap
    here only ever buys politeness, never speed, and asking for MORE threads
    than the default makes things worse rather than better.

    Only intra_op is set. inter_op runs independent graph nodes in parallel and
    does nothing unless execution_mode is ORT_PARALLEL, which it isn't; setting
    it just builds a second thread pool that then competes with the first.
    """
    from rapidocr import RapidOCR

    try:
        threads = int(os.environ.get("OCR_THREADS", "-1"))
    except ValueError:
        threads = -1
    if threads <= 0:
        return RapidOCR()
    return RapidOCR(
        params={"EngineConfig.onnxruntime.intra_op_num_threads": threads}
    )


def read_captions(video_path):
    import cv2

    engine = _build_engine()
    workspace = tempfile.mkdtemp(prefix="stele-ocr-")
    try:
        if not _probe_finds_text(engine, video_path, workspace):
            sys.stderr.write(
                "OCR: probe found no on-screen Chinese text; skipping full pass\n"
            )
            return []
        frames = _extract_frames(video_path, workspace)
        total = len(frames)
        sys.stderr.write(f"OCR: reading {total} frames at {FPS} fps\n")
        # This loop is the longest single stretch of a URL import — measured at
        # 209 s of a 261 s import, outlasting the Whisper pass it runs beside.
        # Every frame is already counted, so the reader can be told how far in
        # it is instead of watching one unchanging line for three minutes.
        _emit_progress(0, total)
        raw = []
        for idx, frame_path in enumerate(frames):
            img = cv2.imread(frame_path)
            if img is not None:
                raw.append((idx / FPS, _read_lines(engine, img)))
            _emit_progress(idx + 1, total)
        samples = filter_furniture(raw, 1 / FPS)
        return samples_to_segments(samples, 1 / FPS)
    finally:
        shutil.rmtree(workspace, ignore_errors=True)


def main():
    if len(sys.argv) != 2:
        sys.stderr.write("usage: ocr_captions.py VIDEO\n")
        return 2
    segments = read_captions(sys.argv[1])
    if not segments:
        json.dump({"error": "no_captions"}, sys.stdout, ensure_ascii=False)
        sys.stdout.write("\n")
        return 0
    # The app is Chinese-only for now (issue #65); mirror transcribe.py's
    # signal when the on-screen text clearly isn't Chinese.
    language = "zh" if cjk_ratio(segments) >= 0.2 else "unknown"
    if language == "zh":
        # In a Chinese video a segment with no CJK at all is a misread
        # graphic or attribution fragment ("MA&AP"), not study material.
        segments = [
            s for s in segments if any("㐀" <= ch <= "鿿" for ch in s["text"])
        ]
    json.dump(
        {"language": language, "segments": segments},
        sys.stdout,
        ensure_ascii=False,
    )
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
