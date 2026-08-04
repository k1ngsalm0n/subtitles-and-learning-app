// Show, on the picture, which characters a line was read from.
//
// The recogniser returns a box per character, so a sentence highlights like a
// text selection in a browser — tight to the glyphs, one rectangle per row it
// occupies — rather than as a box around the whole paragraph it lives in.
//
// Boxes arrive as fractions of the image, because the image is drawn scaled.
// `object-fit: contain` letterboxes it, so the drawn area has to be worked out
// before a fraction means anything in pixels.

// Characters count as the same row while their vertical centres stay close.
const ROW_TOLERANCE = 0.6;

// One rectangle per row of the sentence. A sentence that wrapped gets two,
// exactly as a selection would.
// `range` narrows the highlight to one word: {start, length} in characters,
// counted the same way the transcript counts them. Out of range or absent, the
// whole line lights up as before — a word whose characters the recogniser
// didn't box individually should still show the reader where it came from.
export function rectsFor(line, range) {
  let chars = (line?.chars || []).filter((item) => item?.box);
  if (range && chars.length) {
    const start = Math.max(0, range.start | 0);
    const slice = chars.slice(start, start + Math.max(0, range.length | 0));
    if (slice.length) chars = slice;
  }
  if (!chars.length) return line?.box ? [line.box] : [];

  const rows = [];
  for (const { box } of chars) {
    const [x, y, width, height] = box;
    const middle = y + height / 2;
    const row = rows[rows.length - 1];
    if (row && Math.abs(row.middle - middle) <= row.height * ROW_TOLERANCE) {
      row.left = Math.min(row.left, x);
      row.top = Math.min(row.top, y);
      row.right = Math.max(row.right, x + width);
      row.bottom = Math.max(row.bottom, y + height);
    } else {
      rows.push({
        middle, height,
        left: x, top: y, right: x + width, bottom: y + height,
      });
    }
  }
  return rows.map((row) => [
    row.left,
    row.top,
    row.right - row.left,
    row.bottom - row.top,
  ]);
}

// Where the picture is actually drawn inside its element, given that
// `object-fit: contain` centres it and leaves bars on two sides.
export function drawnArea(naturalWidth, naturalHeight, boxWidth, boxHeight) {
  if (!naturalWidth || !naturalHeight || !boxWidth || !boxHeight) return null;
  const scale = Math.min(boxWidth / naturalWidth, boxHeight / naturalHeight);
  const width = naturalWidth * scale;
  const height = naturalHeight * scale;
  return {
    left: (boxWidth - width) / 2,
    top: (boxHeight - height) / 2,
    width,
    height,
  };
}

export function clearHighlight(els) {
  els?.imageHighlight?.replaceChildren();
}

export function paintHighlight(els, line, range) {
  const layer = els?.imageHighlight;
  const image = els?.imageView;
  if (!layer || !image) return;
  layer.replaceChildren();
  // Nothing to point at unless a picture is on screen and has loaded.
  if (image.classList.contains("hidden") || !image.naturalWidth) return;

  const area = drawnArea(
    image.naturalWidth,
    image.naturalHeight,
    image.clientWidth,
    image.clientHeight,
  );
  if (!area) return;

  for (const [x, y, width, height] of rectsFor(line, range)) {
    const mark = document.createElement("span");
    mark.style.left = `${area.left + x * area.width}px`;
    mark.style.top = `${area.top + y * area.height}px`;
    mark.style.width = `${width * area.width}px`;
    mark.style.height = `${height * area.height}px`;
    layer.append(mark);
  }
}
