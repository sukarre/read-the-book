// Turns PDFs, Word files, images and text into a readable document model:
//   sentences  – what is spoken
//   boxes      – where each sentence sits on the original page (for page-view highlighting)
//   blocks     – text-view layout: paragraphs and figures, in reading order
//   pages      – original pages (PDF pages or photos) for page view
//   sources    – the original PDF files, kept so pages can be re-rendered
// Everything runs locally in the browser; libraries load on demand from a CDN.

import { sentenceRanges } from './segment.js';

const PDFJS_BASE = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/';
const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';

const SCANNED_PAGE_MIN_CHARS = 25;   // fewer extracted characters than this → treat the PDF page as a scan and OCR it
const HEADER_BAND = 0.09;            // top/bottom fraction of a page where running headers, footers and page numbers live
const FOOTER_BAND = 0.06;
const MAX_IMAGE_SIDE = 2400;         // photos are downscaled to this before OCR and display
const CAPTION_RE = /^(?:fig(?:ure)?|exhibit|chart)\.?\s*(\d+(?:[.\-–]\d+)*)/i;
// A caption, not a sentence that mentions a figure: "Figure 3.1 Daily ranges" / "Figure 1:", not "Figure 3.1 shows…".
const isCaptionText = (t) => /^(?:fig(?:ure)?|exhibit|chart)\.?\s*\d+(?:[.\-–]\d+)*(?:\s*[:.—–|-]|\s+[A-Z"“‘(]|\s*$)/i.test(t) && !/^(?:[Ff]ig(?:ure)?|FIG(?:URE)?|[Ee]xhibit|EXHIBIT|[Cc]hart|CHART)\.?\s*\d+(?:[.\-–]\d+)*\s+[a-z]/.test(t);

// ---------- Library loading ----------
let pdfjsPromise = null;
export function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import(PDFJS_BASE + 'pdf.min.mjs').then((m) => {
      m.GlobalWorkerOptions.workerSrc = PDFJS_BASE + 'pdf.worker.min.mjs';
      return m;
    });
  }
  return pdfjsPromise;
}

export async function openPdf(blob) {
  const pdfjs = await loadPdfjs();
  return pdfjs.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) }).promise;
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Could not load ' + src + '. Check your internet connection.'));
    document.head.appendChild(s);
  });
}

// ---------- OCR ----------
let ocrWorker = null;
let ocrLang = null;
let ocrProgress = null;

async function getOcrWorker(lang) {
  if (!window.Tesseract) await loadScript(TESSERACT_URL);
  if (ocrWorker && ocrLang === lang) return ocrWorker;
  if (ocrWorker) { await ocrWorker.terminate(); ocrWorker = null; }
  ocrWorker = await window.Tesseract.createWorker(lang, 1, { logger: (m) => ocrProgress && ocrProgress(m) });
  ocrLang = lang;
  return ocrWorker;
}

/** OCR a canvas into paragraphs of positioned words. Noise read from pictures is dropped. */
async function ocrParagraphs(canvas, lang, pageIndex, onProgress) {
  ocrProgress = onProgress;
  const worker = await getOcrWorker(lang);
  const { data } = await worker.recognize(canvas, {}, { text: true, blocks: true });
  ocrProgress = null;
  const W = canvas.width, H = canvas.height;
  const paras = [];
  const keep = (words, conf) => {
    if (!words.length) return;
    const all = words.map((w) => w.t).join('');
    const letterRatio = all.replace(/[^\p{L}\p{N}]/gu, '').length / all.length;
    // Low-confidence or symbol-heavy paragraphs are almost always texture from photos and figures.
    if (conf / words.length < 55 || letterRatio < 0.5) return;
    const firstLine = [];
    for (const w of words) { firstLine.push(w.t); if (w.lineEnd) break; }
    paras.push({ top: words[0].box[1], words, caption: isCaptionText(firstLine.join(' ')) });
  };
  for (const block of data.blocks || []) {
    for (const par of block.paragraphs || []) {
      let words = [];
      let conf = 0;
      let prevBottom = null;
      for (const line of par.lines || []) {
        const lw = (line.words || []).filter((w) => w.text.trim());
        if (!lw.length) continue;
        const lb = line.bbox;
        const lineH = lb.y1 - lb.y0;
        const text = lw.map((w) => w.text).join(' ');
        // Tesseract sometimes joins text across a picture, or a caption onto the text above: split there.
        if (words.length && (lb.y0 - prevBottom > lineH * 1.5 || isCaptionText(text))) {
          keep(words, conf);
          words = []; conf = 0;
        }
        lw.forEach((w, i) => {
          const bb = w.bbox;
          words.push({ t: w.text.trim(), p: pageIndex, box: [bb.x0 / W, bb.y0 / H, (bb.x1 - bb.x0) / W, (bb.y1 - bb.y0) / H], lineEnd: i === lw.length - 1 });
          conf += w.confidence;
        });
        prevBottom = lb.y1;
      }
      keep(words, conf);
    }
  }
  return paras;
}

// ---------- PDF layout ----------
const toFrac = (r, W, H) => [r[0] / W, r[1] / H, (r[2] - r[0]) / W, (r[3] - r[1]) / H];

/** Rectangles (viewport px, [x0,y0,x1,y1]) of raster figures drawn on the page. */
async function figureRects(pdfjs, page, vp) {
  const ops = await page.getOperatorList();
  const O = pdfjs.OPS;
  const U = pdfjs.Util;
  const pageArea = vp.width * vp.height;
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  const rects = [];
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    const a = ops.argsArray[i];
    if (fn === O.save) stack.push(ctm);
    else if (fn === O.restore) ctm = stack.pop() || ctm;
    else if (fn === O.transform) ctm = U.transform(ctm, a);
    else if (fn === O.paintFormXObjectBegin) { stack.push(ctm); if (a && Array.isArray(a[0]) && a[0].length === 6) ctm = U.transform(ctm, a[0]); }
    else if (fn === O.paintFormXObjectEnd) ctm = stack.pop() || ctm;
    else if (fn === O.paintImageXObject || fn === O.paintInlineImageXObject || fn === O.paintImageMaskXObject || fn === O.paintImageXObjectRepeat) {
      const m = U.transform(vp.transform, ctm);
      const pts = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]);
      const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
      const r = [Math.max(0, Math.min(...xs)), Math.max(0, Math.min(...ys)), Math.min(vp.width, Math.max(...xs)), Math.min(vp.height, Math.max(...ys))];
      const area = (r[2] - r[0]) * (r[3] - r[1]);
      // Ignore tiny ornaments and full-page backgrounds (e.g. a scanned page under an invisible text layer).
      if (area > pageArea * 0.015 && area < pageArea * 0.6) rects.push(r);
    }
  }
  // Merge overlapping rectangles into single figures.
  let merged = true;
  while (merged) {
    merged = false;
    for (let i = 0; i < rects.length && !merged; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const A = rects[i], B = rects[j];
        if (A[0] <= B[2] && B[0] <= A[2] && A[1] <= B[3] && B[1] <= A[3]) {
          rects[i] = [Math.min(A[0], B[0]), Math.min(A[1], B[1]), Math.max(A[2], B[2]), Math.max(A[3], B[3])];
          rects.splice(j, 1);
          merged = true;
          break;
        }
      }
    }
  }
  return rects;
}

/** Group a PDF page's text into lines of positioned tokens. */
export function pdfLines(pdfjs, content, vp) {
  const lines = [];
  let line = null;
  let spaceBefore = true;
  let lastEnd = 0;
  for (const it of content.items) {
    if (!('str' in it)) continue;
    if (!it.str.trim()) { spaceBefore = true; continue; }
    const t = pdfjs.Util.transform(vp.transform, it.transform);
    const fh = Math.hypot(t[2], t[3]) || it.height || 10;
    const x = t[4], base = t[5];
    const w = it.width * vp.scale;
    if (!line || Math.abs(base - line.base) > fh * 0.5 || x < lastEnd - fh * 2) {
      line = { base, fh, x0: x, x1: x, tokens: [] };
      lines.push(line);
      spaceBefore = true;
    }
    const str = it.str;
    for (const m of str.matchAll(/\S+/g)) {
      const tx = x + (w * m.index) / str.length;
      const tw = (w * m[0].length) / str.length;
      const box = [tx, base - fh * 0.85, tx + tw, base + fh * 0.25];
      const last = line.tokens[line.tokens.length - 1];
      if (m.index === 0 && !spaceBefore && last && tx - lastEnd < fh * 0.2) {
        // Same word split across text runs (e.g. a change of font mid-word).
        last.t += m[0];
        last.box = [Math.min(last.box[0], box[0]), Math.min(last.box[1], box[1]), Math.max(last.box[2], box[2]), Math.max(last.box[3], box[3])];
      } else {
        line.tokens.push({ t: m[0], box });
      }
      lastEnd = tx + tw;
    }
    line.x1 = Math.max(line.x1, lastEnd);
    line.fh = Math.max(line.fh, fh);
    spaceBefore = /\s$/.test(str);
  }
  for (const l of lines) l.text = l.tokens.map((k) => k.t).join(' ');
  return lines;
}

const inside = (cx, cy, r, pad) => cx >= r[0] - pad && cx <= r[2] + pad && cy >= r[1] - pad && cy <= r[3] + pad;

const NUM_TOKEN = /^[\d.,:;%$€£₹()\-–—+/*#…]+$/;
// A real word: optional capital then lowercase letters with a vowel, allowing quotes and trailing punctuation.
const WORD_TOKEN = /^[("“‘'\[]*(?:[A-Za-z]?[a-z]*[aeiou][a-z]*(?:['’-][a-z]+)*|[aAI]|[A-Z][a-z]*[aeiouy][a-z]*|by|my|why|fly|try|dry|shy|sky)[.,;:!?"”’)\]]*$/;

/** True for chart labels, axis numbers and letter-grid charts (e.g. Market Profile "yz yzABC"), not prose. */
export function isJunkTokens(tokens) {
  const n = tokens.length;
  if (!n) return true;
  if (n === 1) return /^[\divxlcdm.\-–]+$/i.test(tokens[0]); // stray page number
  const nums = tokens.filter((t) => NUM_TOKEN.test(t)).length;
  const rest = n - nums;
  if (rest === 0) return true;
  const words = tokens.filter((t) => !NUM_TOKEN.test(t) && WORD_TOKEN.test(t)).length;
  return n >= 3 && words / rest < 0.45;
}
const isChartJunk = (words) => isJunkTokens(words.map((w) => w.t));

/** A single line of a text-drawn chart: no real words (allowing a lone price or label). */
export function lineIsChart(tokens) {
  if (tokens.length === 1) return !WORD_TOKEN.test(tokens[0]) && !/^[.…•·\-–—]+$/.test(tokens[0]) && tokens[0].length >= 2;
  const nonNum = tokens.filter((t) => !NUM_TOKEN.test(t));
  return nonNum.filter((t) => WORD_TOKEN.test(t)).length / Math.max(1, nonNum.length) < 0.45;
}

/** Lay out one text-based PDF page: paragraphs of positioned words, plus figures. */
function pdfPageLayout(pdfjs, content, vp, figs, pageIndex) {
  const W = vp.width, H = vp.height;
  const lines = pdfLines(pdfjs, content, vp);
  const figPad = Math.min(W, H) * 0.03;
  const figExtent = figs.map((r) => r.slice());
  const body = [];
  for (const l of lines) {
    const cy = l.base - l.fh * 0.3;
    const cx = (l.x0 + l.x1) / 2;
    const isCaption = /^(fig(ure)?|exhibit|chart|table|source)\b/i.test(l.text);
    const labelLike = l.text.length < 30 || isChartJunk(l.tokens);
    // Text inside a figure, or short label-like text right at its edge, belongs to the figure.
    const fi = isCaption ? -1 : figs.findIndex((r) => inside(cx, cy, r, 0) || (labelLike && inside(cx, cy, r, figPad)));
    if (fi >= 0) {
      // Text that belongs to a figure (axis labels, legends): shown in the figure, not read aloud.
      const e = figExtent[fi];
      figExtent[fi] = [Math.min(e[0], l.x0), Math.min(e[1], l.base - l.fh), Math.max(e[2], l.x1), Math.max(e[3], l.base + l.fh * 0.3)];
      continue;
    }
    const inHeader = l.base < H * HEADER_BAND || l.base > H * (1 - FOOTER_BAND);
    // Running header / footer: short line in the margin band that carries a page number.
    if (inHeader && l.text.length < 90 && /(^|\s)([0-9]{1,4}|[ivxlc]{1,6})(\s|$)/i.test(l.text)) continue;
    if (inHeader && /^[0-9ivxlc]{1,6}$/i.test(l.text.trim())) continue;
    body.push(l);
  }

  // Charts typeset as text (e.g. Market Profile letter grids "11417 yzABKL"): group neighbouring chart rows
  // into regions; each region becomes a figure cropped from the page and is not read aloud.
  const regions = [];
  for (const l of body) {
    if (!lineIsChart(l.tokens.map((k) => k.t))) continue;
    const r = [l.x0, l.base - l.fh, l.x1, l.base + l.fh * 0.3];
    const near = regions.find((q) => r[1] <= q.r[3] + l.fh * 3 && q.r[1] <= r[3] + l.fh * 3);
    if (near) { near.r = [Math.min(near.r[0], r[0]), Math.min(near.r[1], r[1]), Math.max(near.r[2], r[2]), Math.max(near.r[3], r[3])]; near.n++; }
    else regions.push({ r, n: 1 });
  }
  const charts = regions.filter((q) => q.n >= 4).map((q) => q.r);
  if (charts.length) {
    for (let i = body.length - 1; i >= 0; i--) {
      const l = body[i];
      const cx = (l.x0 + l.x1) / 2, cy = l.base - l.fh * 0.3;
      const isCaption = /^(fig(ure)?|exhibit|chart|table|source)\b/i.test(l.text);
      const ci = isCaption ? -1 : charts.findIndex((r) => inside(cx, cy, r, l.fh * 0.5));
      if (ci < 0) continue;
      const r = charts[ci];
      charts[ci] = [Math.min(r[0], l.x0), Math.min(r[1], l.base - l.fh), Math.max(r[2], l.x1), Math.max(r[3], l.base + l.fh * 0.3)];
      body.splice(i, 1);
    }
    for (const r of charts) {
      const overlap = figExtent.find((e) => r[0] <= e[2] && e[0] <= r[2] && r[1] <= e[3] && e[1] <= r[3]);
      if (overlap) { overlap[0] = Math.min(overlap[0], r[0]); overlap[1] = Math.min(overlap[1], r[1]); overlap[2] = Math.max(overlap[2], r[2]); overlap[3] = Math.max(overlap[3], r[3]); }
      else figExtent.push(r);
    }
  }

  const widths = body.map((l) => l.x1 - l.x0).sort((a, b) => a - b);
  const typicalW = widths.length ? widths[Math.floor(widths.length * 0.75)] : W;
  const leftX = body.length ? Math.min(...body.filter((l) => l.x1 - l.x0 > typicalW * 0.5).map((l) => l.x0).concat([Infinity])) : 0;

  // Figures anchored by their caption: everything between the caption and the nearest prose above it
  // (or below it) is the figure, including word labels inside vector charts. Not read aloud; cropped as a figure.
  if (body.length && isFinite(leftX)) {
    const sorted = body.slice().sort((a, b) => a.base - b.base);
    const isProse = (l) => l.x1 - l.x0 >= typicalW * 0.8 && !lineIsChart(l.tokens.map((k) => k.t));
    const remove = new Set();
    const zones = [];
    for (let ci = 0; ci < sorted.length; ci++) {
      const cap = sorted[ci];
      if (!isCaptionText(cap.text)) continue;
      // Caption block: caption lines plus credit lines right under it ("Source: …", "All rights reserved …").
      let ce = ci;
      const CREDIT = /all rights reserved|courtesy of|^source:|www\.|\.com\b|©/i;
      while (ce + 1 < sorted.length && sorted[ce + 1].base - sorted[ce].base <= sorted[ce].fh * 1.8 &&
             (!isProse(sorted[ce + 1]) || CREDIT.test(sorted[ce + 1].text))) ce++;
      for (let k = ci + 1; k <= ce; k++) {
        if (/all rights reserved|courtesy of|^source:|www\.|\.com\b/i.test(sorted[k].text)) remove.add(sorted[k]);
      }
      // Above: back to the last full-width prose line, then forward through the end of that paragraph.
      let j = ci - 1;
      while (j >= 0 && !isProse(sorted[j]) && !remove.has(sorted[j])) j--;
      let k = j;
      while (k >= 0 && k + 1 < ci && sorted[k + 1].base - sorted[k].base <= sorted[k].fh * 1.6 &&
             Math.abs(sorted[k + 1].x0 - leftX) < sorted[k].fh && !lineIsChart(sorted[k + 1].tokens.map((t) => t.t))) k++;
      const top = k >= 0 ? sorted[k].base + sorted[k].fh * 0.45 : H * HEADER_BAND * 0.8;
      const capTop = cap.base - cap.fh;
      if (capTop - top > H * 0.06) {
        zones.push([leftX - 4, top, leftX + typicalW + 4, capTop - 2]);
        for (let q = k + 1; q < ci; q++) remove.add(sorted[q]);
        continue;
      }
      // Below the caption: down to the next prose line.
      let n = ce + 1;
      while (n < sorted.length && !isProse(sorted[n])) n++;
      const zTop = sorted[ce].base + sorted[ce].fh * 0.45;
      const zBottom = n < sorted.length ? sorted[n].base - sorted[n].fh : H * (1 - FOOTER_BAND);
      if (zBottom - zTop > H * 0.06) {
        zones.push([leftX - 4, zTop, leftX + typicalW + 4, zBottom]);
        for (let q = ce + 1; q < n; q++) remove.add(sorted[q]);
      }
    }
    if (remove.size) {
      for (let i = body.length - 1; i >= 0; i--) if (remove.has(body[i])) body.splice(i, 1);
    }
    for (const r of zones) {
      const overlap = figExtent.find((e) => r[0] <= e[2] && e[0] <= r[2] && r[1] <= e[3] && e[1] <= r[3]);
      if (overlap) { overlap[0] = Math.min(overlap[0], r[0]); overlap[1] = Math.min(overlap[1], r[1]); overlap[2] = Math.max(overlap[2], r[2]); overlap[3] = Math.max(overlap[3], r[3]); }
      else figExtent.push(r);
    }
  }

  const paras = [];
  let para = null;
  let prev = null;
  for (const l of body) {
    const gap = prev ? l.base - prev.base : 0;
    const prevShort = prev && prev.x1 - prev.x0 < typicalW * 0.6 && !/[-‐]$/.test(prev.text);
    const indented = isFinite(leftX) && l.x0 > leftX + l.fh * 0.8;
    const newPara = !para || gap > prev.fh * 1.9 || gap < -prev.fh * 0.5 || indented || prevShort;
    const caption = /^(fig(ure)?|exhibit|chart|table|source)\b/i.test(l.text);
    if (newPara || caption) { para = { top: (l.base - l.fh) / H, words: [], caption }; paras.push(para); }
    l.tokens.forEach((k, i) => para.words.push({ t: k.t, p: pageIndex, box: toFrac(k.box, W, H), lineEnd: i === l.tokens.length - 1 }));
    prev = l;
  }
  return {
    paras: paras.filter((p) => !isChartJunk(p.words)),
    figures: figExtent.map((r) => ({ top: r[1] / H, rect: toFrac([Math.max(0, r[0] - 4), Math.max(0, r[1] - 4), Math.min(W, r[2] + 4), Math.min(H, r[3] + 4)], W, H) })),
  };
}

// ---------- Document builder ----------
class Builder {
  constructor(lang) {
    this.lang = lang;
    this.sentences = [];
    this.boxes = [];
    this.blocks = [];
    this.pages = [];
    this.sources = [];
    this.stream = []; // pending items for positioned pages, so paragraphs can continue across pages
  }

  /** Queue a page's paragraphs and figures (in reading order). */
  queuePage(paras, figures, pageIndex) {
    const items = paras.map((p) => ({ type: 'para', top: p.top, words: p.words, page: pageIndex, caption: p.caption }));
    for (const f of figures) {
      const at = items.findIndex((it) => it.type === 'para' && it.top > f.top);
      const fig = { type: 'fig', page: pageIndex, rect: f.rect };
      if (at < 0) items.push(fig); else items.splice(at, 0, fig);
    }
    for (const it of items) {
      if (it.type === 'para' && !it.caption) {
        // Figures and their captions can sit in the middle of a sentence's text; look past them.
        let li = this.stream.length - 1;
        while (li >= 0 && (this.stream[li].type !== 'para' || this.stream[li].caption)) li--;
        const last = li >= 0 ? this.stream[li] : null;
        const unfinished = last && !/[.!?:;]["”’)\]]*$/.test(last.words[last.words.length - 1].t);
        // A paragraph that ran off the previous page continues here; on the same page, a "paragraph"
        // starting in lowercase or with a digit is really the next line of an unfinished sentence (common in OCR).
        const crossPage = last && last.page !== it.page && last.lastPage !== it.page;
        const sameLineBreak = last && li === this.stream.length - 1 && /^[\p{Ll}\d]/u.test(it.words[0].t);
        if (unfinished && (crossPage || sameLineBreak)) {
          last.words[last.words.length - 1].lineEnd = true;
          last.words.push(...it.words);
          last.lastPage = it.page;
          continue;
        }
      }
      this.stream.push(it);
    }
  }

  flush() {
    for (const it of this.stream) {
      if (it.type === 'para') this.addWordPara(it.words);
      else this.blocks.push(it);
    }
    this.stream = [];
  }

  addWordPara(words) {
    let text = '';
    const spans = [];
    let join = false;
    words.forEach((w, i) => {
      let t = w.t;
      const next = words[i + 1];
      if (text && !join) text += ' ';
      let nextJoin = false;
      if (w.lineEnd && next && /\p{L}[-‐­]$/u.test(t) && /^\p{Ll}/u.test(next.t)) {
        t = t.slice(0, -1); nextJoin = true;             // hyphenated across a line break
      } else if (i === 0 && /^[B-HJ-Z]$/.test(t) && next && /^\p{Ll}/u.test(next.t)) {
        nextJoin = true;                                // decorative drop cap: "W e" → "We"
      }
      const s = text.length;
      text += t;
      spans.push([s, text.length, w]);
      join = nextJoin;
    });
    const sIdx = [];
    let k = 0;
    for (const [a, b] of sentenceRanges(text, this.lang)) {
      const sentence = text.slice(a, b);
      const toks = sentence.split(/\s+/);
      if (toks.length >= 4 && isJunkTokens(toks)) continue; // chart residue inside a paragraph
      while (k < spans.length && spans[k][1] <= a) k++;
      const ws = [];
      for (let j = k; j < spans.length && spans[j][0] < b; j++) ws.push(spans[j][2]);
      this.sentences.push(sentence);
      this.boxes.push(mergeBoxes(ws));
      sIdx.push(this.sentences.length - 1);
    }
    if (sIdx.length) this.blocks.push({ type: 'p', s: sIdx, page: words[0].p });
  }

  addTextPara(text, tag) {
    text = text.replace(/\s+/g, ' ').trim();
    if (!text) return;
    const sIdx = [];
    for (const [a, b] of sentenceRanges(text, this.lang)) {
      this.sentences.push(text.slice(a, b));
      this.boxes.push(null);
      sIdx.push(this.sentences.length - 1);
    }
    this.blocks.push({ type: 'p', s: sIdx, tag });
  }

  addImageFigure(src, alt) { this.blocks.push({ type: 'fig', src, alt }); }
}

/** Merge word boxes into one rectangle per line, grouped by page. */
function mergeBoxes(words) {
  const out = [];
  let cur = null, r = null;
  for (const w of words) {
    if (!w.box) continue;
    const [x, y, bw, bh] = w.box;
    if (!cur || cur.p !== w.p) { cur = { p: w.p, r: [] }; out.push(cur); r = null; }
    if (r && Math.abs(y - r[1]) < bh * 0.6 && x >= r[0] + r[2] - bh * 2) {
      const x1 = Math.max(r[0] + r[2], x + bw), y1 = Math.max(r[1] + r[3], y + bh);
      r[1] = Math.min(r[1], y); r[2] = x1 - r[0]; r[3] = y1 - r[1];
    } else {
      r = [x, y, bw, bh];
      cur.r.push(r);
    }
  }
  for (const o of out) o.r = o.r.map((q) => q.map((v) => Math.round(v * 10000) / 10000));
  return out.length ? out : null;
}

// ---------- Per-format extraction ----------
async function extractPdf(file, b, { lang, onStatus }) {
  const pdfjs = await loadPdfjs();
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const src = b.sources.length;
  b.sources.push(file);
  let ocrCount = 0;
  for (let n = 1; n <= doc.numPages; n++) {
    onStatus(`Reading page ${n} of ${doc.numPages}…`, (n - 1) / doc.numPages);
    const page = await doc.getPage(n);
    const vp = page.getViewport({ scale: 1 });
    const pageIndex = b.pages.length;
    b.pages.push({ src, n, w: vp.width, h: vp.height, label: String(n) });
    const content = await page.getTextContent();
    const chars = content.items.reduce((s, i) => s + (i.str ? i.str.replace(/\s/g, '').length : 0), 0);
    if (chars < SCANNED_PAGE_MIN_CHARS) {
      ocrCount++;
      const scale = Math.min(2.5, 2000 / vp.width);
      const v2 = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(v2.width);
      canvas.height = Math.floor(v2.height);
      await page.render({ canvasContext: canvas.getContext('2d'), viewport: v2 }).promise;
      const paras = await ocrParagraphs(canvas, lang, pageIndex, (m) => {
        if (m.status === 'recognizing text') onStatus(`Scanning page ${n} of ${doc.numPages} (OCR)…`, (n - 1 + m.progress) / doc.numPages);
        else onStatus(`Preparing OCR: ${m.status}…`, (n - 1) / doc.numPages);
      });
      canvas.width = canvas.height = 0;
      b.queuePage(paras, [], pageIndex);
    } else {
      const figs = await figureRects(pdfjs, page, vp);
      const { paras, figures } = pdfPageLayout(pdfjs, content, vp, figs, pageIndex);
      b.queuePage(paras, figures, pageIndex);
    }
    page.cleanup();
  }
  await doc.destroy();
  b.flush();
  return ocrCount;
}

async function extractDocx(file, b) {
  if (!window.mammoth) throw new Error('The Word reader did not load. Check your internet connection.');
  const { value: html } = await window.mammoth.convertToHtml({ arrayBuffer: await file.arrayBuffer() });
  const dom = new DOMParser().parseFromString(html, 'text/html');
  const walk = (el) => {
    const tag = el.tagName.toLowerCase();
    if (tag === 'ul' || tag === 'ol') { for (const li of el.children) walk(li); return; }
    if (tag === 'table') {
      for (const tr of el.querySelectorAll('tr')) {
        b.addTextPara([...tr.children].map((c) => c.textContent.trim()).filter(Boolean).join(', '));
      }
      for (const img of el.querySelectorAll('img')) b.addImageFigure(img.src, img.alt);
      return;
    }
    let text = '';
    for (const node of el.childNodes) {
      if (node.nodeType === 1 && (node.tagName === 'UL' || node.tagName === 'OL')) continue;
      text += node.textContent;
    }
    b.addTextPara(text, /^h[1-6]$/.test(tag) ? 'h' : undefined);
    for (const img of el.querySelectorAll('img')) {
      const list = img.closest('ul,ol');
      if (!list || !el.contains(list)) b.addImageFigure(img.src, img.alt); // nested-list images are added by their own item
    }
    for (const sub of el.querySelectorAll(':scope > ul, :scope > ol')) walk(sub);
  };
  for (const el of dom.body.children) walk(el);
}

async function loadImageCanvas(file) {
  let bmp;
  try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch { bmp = await createImageBitmap(file); }
  const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close?.();
  return canvas;
}

async function extractImage(file, b, { lang, onStatus, index, total }) {
  const label = total > 1 ? `image ${index + 1} of ${total}` : 'image';
  onStatus(`Opening ${label}…`, index / total);
  const canvas = await loadImageCanvas(file);
  const pageIndex = b.pages.length;
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.88));
  b.pages.push({ blob, w: canvas.width, h: canvas.height, label: total > 1 ? `photo ${index + 1}` : 'photo' });
  const paras = await ocrParagraphs(canvas, lang, pageIndex, (m) => {
    if (m.status === 'recognizing text') onStatus(`Scanning ${label} (OCR)…`, (index + m.progress) / total);
    else onStatus(`Preparing OCR: ${m.status}…`, index / total);
  });
  canvas.width = canvas.height = 0;
  b.queuePage(paras, [], pageIndex);
}

function kindOf(file) {
  const name = file.name.toLowerCase();
  if (file.type === 'application/pdf' || name.endsWith('.pdf')) return 'pdf';
  if (name.endsWith('.docx')) return 'docx';
  if (name.endsWith('.doc')) return 'doc';
  if (file.type.startsWith('image/') || /\.(png|jpe?g|webp|bmp|gif|tiff?)$/.test(name)) return 'image';
  if (file.type.startsWith('text/') || /\.(txt|md|text)$/.test(name)) return 'text';
  return 'unknown';
}

export function cleanText(text) {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/­/g, '')
    .replace(/(\p{L})-\n(\p{Ll})/gu, '$1$2')
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/([^\n])\n(?=[^\n])/g, '$1 ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Build a document from plain text (paste). */
export function docFromText(title, text, lang = 'en') {
  const b = new Builder(lang);
  for (const para of cleanText(text).split(/\n\s*\n/)) b.addTextPara(para);
  return finish(b, title);
}


/** Rectangles of a block's text on one page. */
function blockRects(b, blk, page) {
  const out = [];
  for (const i of blk.s) for (const g of b.boxes[i] || []) if (g.p === page) out.push(...g.r);
  return out;
}

/**
 * Give each figure the label from its caption ("FIGURE 3.1 …" → "3.1") so mentions in the text can link to it.
 * A caption with no detected figure (vector-drawn charts) gets one: the blank area between it and the text above.
 */
function labelFigures(b) {
  const blocks = b.blocks;
  for (let i = 0; i < blocks.length; i++) {
    const blk = blocks[i];
    if (blk.type !== 'p') continue;
    const first = b.sentences[blk.s[0]];
    if (!isCaptionText(first)) continue;
    const m = CAPTION_RE.exec(first);
    const label = m[1].replace(/[–-]/g, '.');
    const samePage = (f) => f.type === 'fig' && !f.label && f.page === blk.page;
    // The figure is normally right above its caption; sometimes right below.
    let fig = null;
    for (let j = i - 1; j >= Math.max(0, i - 3) && !fig; j--) if (samePage(blocks[j])) fig = blocks[j];
    for (let j = i + 1; j <= Math.min(blocks.length - 1, i + 2) && !fig; j++) if (samePage(blocks[j])) fig = blocks[j];
    if (!fig && blk.page !== undefined && b.boxes[blk.s[0]]) {
      const cap = blockRects(b, blk, blk.page);
      if (cap.length) {
        const capTop = Math.min(...cap.map((r) => r[1]));
        const capBottom = Math.max(...cap.map((r) => r[1] + r[3]));
        let above = HEADER_BAND * 0.8, below = 1 - FOOTER_BAND;
        for (const other of blocks) {
          if (other === blk || other.type !== 'p' || !other.s) continue;
          for (const r of blockRects(b, other, blk.page)) {
            if (r[1] + r[3] <= capTop + 0.002) above = Math.max(above, r[1] + r[3]);
            else if (r[1] >= capBottom - 0.002) below = Math.min(below, r[1]);
          }
        }
        let rect = null;
        if (capTop - above > 0.08) rect = [0.05, above + 0.004, 0.9, capTop - above - 0.008];
        else if (below - capBottom > 0.08) rect = [0.05, capBottom + 0.004, 0.9, below - capBottom - 0.008];
        if (rect) {
          fig = { type: 'fig', page: blk.page, rect };
          blocks.splice(i, 0, fig);
          i++;
        }
      }
    }
    if (!fig) continue;
    fig.label = label;
    fig.caption = blk.s.map((k) => b.sentences[k]).join(' ').slice(0, 400);
    blk.tag = 'caption';
  }
}

function finish(b, title) {
  labelFigures(b);
  if (!b.sentences.length) {
    throw new Error('No readable text was found. For photos, make sure the page is well lit, in focus and fills the frame.');
  }
  return { v: 2, title, lang: b.lang, sentences: b.sentences, boxes: b.boxes, blocks: b.blocks, pages: b.pages, sources: b.sources };
}

/**
 * Extract a readable document from one or more files. Several images are treated as pages of one scan.
 */
export async function extractFiles(files, { lang = 'en', ocrLang = 'eng', onStatus = () => {} } = {}) {
  files = [...files];
  if (!files.length) throw new Error('No file selected.');
  const b = new Builder(lang);
  const images = files.filter((f) => kindOf(f) === 'image');
  let imgIndex = 0;
  for (const file of files) {
    const kind = kindOf(file);
    if (kind === 'pdf') await extractPdf(file, b, { lang: ocrLang, onStatus });
    else if (kind === 'docx') { onStatus('Reading Word document…', 0.5); await extractDocx(file, b); }
    else if (kind === 'image') await extractImage(file, b, { lang: ocrLang, onStatus, index: imgIndex++, total: images.length });
    else if (kind === 'text') { for (const p of cleanText(await file.text()).split(/\n\s*\n/)) b.addTextPara(p); }
    else if (kind === 'doc') throw new Error(`"${file.name}" is an old .doc file. Open it in Word and save it as .docx, then try again.`);
    else throw new Error(`"${file.name}" is not a supported file type. Use PDF, .docx, .txt or an image.`);
  }
  b.flush();
  const title = files.length === 1 ? files[0].name : `${files[0].name} + ${files.length - 1} more`;
  return finish(b, title);
}
