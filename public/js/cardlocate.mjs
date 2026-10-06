// Pinpointing each card's word in its video (server/locate.py does the
// listening). A card remembers the line it was saved from, but cards made
// before #143 took the time of whichever line was *playing*, and no card knew
// where in its line the word falls. Once placed, "Replay video" lands on the
// word.
//
// Cards are sent per video, since the server listens to a video once and
// answers for all its cards from that.

// Results back onto cards, pure so it can be tested. A word that was found
// moves the card's line to the one it's in; one that wasn't keeps the card's
// time and is marked, so it isn't asked about again on every review.
export function applyLocations(cards, results, now = Date.now()) {
  let found = 0;
  let missed = 0;
  for (const card of cards) {
    if (!(card.id in results)) continue;
    const hit = results[card.id];
    card.locatedAt = now;
    if (hit && Number.isFinite(hit.start) && Number.isFinite(hit.end)) {
      card.wordStart = hit.start;
      card.wordEnd = hit.end;
      if (Number.isFinite(hit.lineStart) && Number.isFinite(hit.lineEnd)) {
        card.sourceTime = hit.lineStart;
        card.sourceEnd = hit.lineEnd;
      }
      found++;
    } else {
      card.wordStart = null;
      card.wordEnd = null;
      missed++;
    }
  }
  return { found, missed };
}

// Cards that have a stored video to listen to, grouped by it.
export function groupByVideo(cards, sources) {
  const byId = new Map(sources.map((s) => [s.id, s]));
  const groups = new Map();
  for (const card of cards) {
    const url = byId.get(card.sourceId)?.videoUrl;
    if (!url || !card.word) continue;
    if (!groups.has(url)) groups.set(url, []);
    groups.get(url).push(card);
  }
  return groups;
}

// Place `cards` in their videos. `onVideo(done, total)` reports progress.
// Resolves { found, missed, gone, failed } — `gone` counts cards whose video
// has been pruned from the cache.
export async function locateCards(cards, sources, { onVideo = () => {} } = {}) {
  const groups = groupByVideo(cards, sources);
  const totals = { found: 0, missed: 0, gone: 0, failed: 0 };
  let done = 0;
  for (const [videoUrl, group] of groups) {
    onVideo(done, groups.size);
    try {
      const res = await fetch("/api/locate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          videoUrl,
          items: group.map((c) => ({
            id: c.id,
            word: c.word,
            example: c.example || "",
            near: Number.isFinite(c.sourceTime) ? c.sourceTime : null,
          })),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 404 && data.gone) totals.gone += group.length;
      else if (!res.ok) totals.failed += group.length;
      else {
        const { found, missed } = applyLocations(group, data.results || {});
        totals.found += found;
        totals.missed += missed;
      }
    } catch {
      totals.failed += group.length;
    }
    done++;
  }
  onVideo(done, groups.size);
  return totals;
}
