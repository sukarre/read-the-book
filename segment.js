// Sentence segmentation with character offsets, so sentences can be mapped back to word positions on the page.

const MAX_CHUNK = 220;

/** @returns {Array<[number, number]>} [start, end) ranges of sentences in text, trimmed, long ones split */
export function sentenceRanges(text, lang = 'en') {
  let raw;
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    const seg = new Intl.Segmenter(lang, { granularity: 'sentence' });
    raw = [...seg.segment(text)].map((s) => [s.index, s.index + s.segment.length]);
  } else {
    raw = [...text.matchAll(/[^.!?।]+[.!?।]+["'”’)\]]*\s*|[^.!?।]+$/g)].map((m) => [m.index, m.index + m[0].length]);
  }
  const out = [];
  for (let [a, b] of raw) {
    while (a < b && /\s/.test(text[a])) a++;
    while (b > a && /\s/.test(text[b - 1])) b--;
    if (a < b) splitLong(text, a, b, out);
  }
  return out;
}

function splitLong(text, a, b, out) {
  while (b - a > MAX_CHUNK) {
    const win = text.slice(a, a + MAX_CHUNK);
    let cut = Math.max(win.lastIndexOf(', '), win.lastIndexOf('; '), win.lastIndexOf(': '), win.lastIndexOf(' – '), win.lastIndexOf(' — '));
    if (cut < MAX_CHUNK * 0.4) cut = win.lastIndexOf(' ');
    if (cut <= 0) cut = MAX_CHUNK - 1;
    let end = a + cut + 1;
    let e = end;
    while (e > a && /\s/.test(text[e - 1])) e--;
    out.push([a, e]);
    a = end;
    while (a < b && /\s/.test(text[a])) a++;
  }
  if (a < b) out.push([a, b]);
}
