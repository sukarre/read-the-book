import { extractFiles, docFromText, openPdf } from './extract.js';
import { Reader, getVoices, voiceScore, isNaturalVoice } from './reader.js';
import { isNative, NativeReader, getNativeVoices, openVoiceSettings } from './native.js';

const $ = (id) => document.getElementById(id);

// UI language code -> Tesseract OCR language code
const LANGS = [
  ['en', 'English', 'eng'],
  ['hi', 'Hindi', 'hin'],
  ['te', 'Telugu', 'tel'],
  ['ta', 'Tamil', 'tam'],
  ['kn', 'Kannada', 'kan'],
  ['ml', 'Malayalam', 'mal'],
  ['mr', 'Marathi', 'mar'],
  ['bn', 'Bengali', 'ben'],
  ['gu', 'Gujarati', 'guj'],
  ['es', 'Spanish', 'spa'],
  ['fr', 'French', 'fra'],
  ['de', 'German', 'deu'],
];

// ---------- Storage ----------
const LS = { settings: 'rtb:settings', pos: 'rtb:pos' };
const lsGet = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* full */ } };
localStorage.removeItem('rtb:doc'); // old text-only format

let dbPromise = null;
function db() {
  dbPromise ??= new Promise((res, rej) => {
    const r = indexedDB.open('read-the-book', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbPromise;
}
async function idb(mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const tx = d.transaction('kv', mode);
    const req = fn(tx.objectStore('kv'));
    tx.oncomplete = () => res(req?.result);
    tx.onerror = () => rej(tx.error);
  });
}
const saveDoc = (doc) => idb('readwrite', (s) => s.put(doc, 'current')).catch((e) => console.warn('Could not save document', e));
const loadDoc = () => idb('readonly', (s) => s.get('current')).catch(() => null);
const clearDoc = () => idb('readwrite', (s) => s.delete('current')).catch(() => {});

const settings = Object.assign({ lang: 'en', voiceURI: null, rate: 0.95, pitch: 1, volume: 1, sleep: 0, view: 'page', autoOpenFig: false, figPlace: 'printed' }, lsGet(LS.settings, {}));
const saveSettings = () => lsSet(LS.settings, settings);

// ---------- State ----------
let allVoices = [];
let doc = null;
let spans = [];          // text-view sentence spans
let pageEls = [];        // page-view page elements
let pageSentences = [];  // page index -> sentence indexes on it (for click-to-read)
let hlEls = [];
let lastIdx = -1;
let sentenceFigs = [];   // sentence index -> labels of figures it mentions
let sleepTimer = null;

const reader = new (isNative ? NativeReader : Reader)({
  onSentence: highlight,
  onState: (playing) => {
    $('playIcon').toggleAttribute('hidden', playing);
    $('pauseIcon').toggleAttribute('hidden', !playing);
    $('playBtn').setAttribute('aria-label', playing ? 'Pause' : 'Play');
    if (playing) armSleepTimer(); else clearTimeout(sleepTimer);
  },
  onEnd: () => lsSet(LS.pos, 0),
});

// ---------- Rendering original pages ----------
const pdfCache = new Map();
const getPdf = (src) => {
  if (!pdfCache.has(src)) pdfCache.set(src, openPdf(doc.sources[src]));
  return pdfCache.get(src);
};

/** Render page `pi` of the current document so that it is `pxWidth` device pixels wide. */
async function renderPage(pi, pxWidth) {
  const info = doc.pages[pi];
  if (info.blob) {
    const bmp = await createImageBitmap(info.blob);
    const c = document.createElement('canvas');
    c.width = bmp.width; c.height = bmp.height;
    c.getContext('2d').drawImage(bmp, 0, 0);
    bmp.close?.();
    return c;
  }
  const pdf = await getPdf(info.src);
  const page = await pdf.getPage(info.n);
  const scale = Math.min(4, pxWidth / info.w);
  const vp = page.getViewport({ scale });
  const c = document.createElement('canvas');
  c.width = Math.floor(vp.width);
  c.height = Math.floor(vp.height);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  return c;
}

const dpr = () => Math.min(2, window.devicePixelRatio || 1);

// Load visible pages/figures, free the ones far off-screen (a 300-page book would otherwise use gigabytes).
const lazy = new IntersectionObserver((entries) => {
  for (const e of entries) {
    const el = e.target;
    if (e.isIntersecting) el._load?.();
    else el._unload?.();
  }
}, { rootMargin: '1500px 0px' });

function makeLazy(el, draw) {
  let state = '';
  el._load = async () => {
    if (state) return;
    state = 'loading';
    try {
      const canvas = await draw();
      if (state !== 'loading') { canvas.width = canvas.height = 0; return; }
      el.querySelector('canvas')?.remove();
      el.prepend(canvas);
      el.classList.remove('lazy');
      state = 'loaded';
    } catch (err) {
      console.warn('Render failed', err);
      state = '';
    }
  };
  el._unload = () => {
    const c = el.querySelector('canvas');
    if (c) { c.width = c.height = 0; c.remove(); }
    state = '';
  };
  lazy.observe(el);
}

/** Crop a PDF figure out of its rendered page, exactly as printed, `cssWidth` CSS pixels wide. */
async function renderFigure(block, cssWidth) {
  const [fx, fy, fw, fh] = block.rect;
  const page = await renderPage(block.page, (cssWidth * dpr()) / fw);
  const c = document.createElement('canvas');
  c.width = Math.round(fw * page.width);
  c.height = Math.round(fh * page.height);
  c.getContext('2d').drawImage(page, fx * page.width, fy * page.height, c.width, c.height, 0, 0, c.width, c.height);
  page.width = page.height = 0;
  c.style.width = '100%';
  return c;
}

// ---------- Figure links and side panel ----------
let figByLabel = new Map();
const FIG_MENTION = /\b(Fig(?:ure)?s?\.?|Exhibits?|Charts?)\s+(\d+(?:\.\d+)*)((?:\s*(?:,|and|&|–|-|to)\s*\d+(?:\.\d+)*)*)/gi;

/** Write text into el, turning "Figure 3.1" (and "Figures 3.1 and 3.2") into links to known figures. */
function appendWithFigureLinks(el, text) {
  let last = 0;
  for (const m of text.matchAll(FIG_MENTION)) {
    const full = m[0];
    const parts = [...full.matchAll(/\d+(?:\.\d+)*/g)].map((x) => [x.index, x.index + x[0].length, x[0]]);
    if (!parts.some((q) => figByLabel.has(q[2]))) continue;
    el.append(text.slice(last, m.index));
    let off = 0;
    parts.forEach(([start, end, n], k) => {
      const from = k === 0 ? 0 : start; // the first link includes the word "Figure"
      el.append(full.slice(off, from));
      const t = full.slice(from, end);
      if (figByLabel.has(n)) {
        const link = document.createElement('a');
        link.href = '#';
        link.className = 'figlink';
        link.dataset.label = n;
        link.textContent = t;
        link.title = 'Show figure ' + n;
        el.append(link);
      } else {
        el.append(t);
      }
      off = end;
    });
    el.append(full.slice(off));
    last = m.index + full.length;
  }
  el.append(text.slice(last));
}

/** Labels of known figures mentioned in `text` ("Figures 3.1 and 3.2" -> ['3.1', '3.2']). */
function mentionedFigures(text) {
  const out = [];
  for (const m of text.matchAll(FIG_MENTION)) {
    for (const x of m[0].matchAll(/\d+(?:\.\d+)*/g)) if (figByLabel.has(x[0]) && !out.includes(x[0])) out.push(x[0]);
  }
  return out;
}

let panelFig = null;
async function openFigure(block) {
  if (!block) return;
  panelFig = block;
  const body = $('figBody');
  body.textContent = '';
  $('figTitle').textContent = block.label ? 'Figure ' + block.label : 'Figure';
  $('figCaption').textContent = block.caption || '';
  $('figGoto').hidden = block.page === undefined || !hasPageView();
  if (block.page !== undefined) {
    const lbl = doc.pages[block.page].label;
    $('figGoto').textContent = lbl.startsWith('photo') ? 'Show on ' + lbl : 'Go to page ' + lbl;
  }
  document.body.classList.add('panel-open');
  $('figPanel').hidden = false;
  markOpenChip();
  if (block.src) {
    const img = document.createElement('img');
    img.src = block.src;
    img.alt = block.alt || 'Figure';
    body.appendChild(img);
  } else {
    body.textContent = 'Loading…';
    const canvas = await renderFigure(block, Math.max(320, body.clientWidth || 480));
    if (panelFig !== block) return;
    body.textContent = '';
    body.appendChild(canvas);
  }
}

function closeFigure() {
  panelFig = null;
  markOpenChip();
  $('figPanel').hidden = true;
  document.body.classList.remove('panel-open');
  const c = $('figBody').querySelector('canvas');
  if (c) c.width = c.height = 0;
  $('figBody').textContent = '';
}

function gotoFigurePage(block) {
  if (block.page === undefined) return;
  settings.view = 'page';
  saveSettings();
  applyView();
  requestAnimationFrame(() => {
    const el = pageEls[block.page];
    if (!el) return;
    const y = window.scrollY + el.getBoundingClientRect().top + block.rect[1] * el.clientHeight - 90;
    window.scrollTo({ top: Math.max(0, y), behavior: 'auto' });
  });
}

// ---------- Building the views ----------
function buildTextView() {
  const container = $('docText');
  container.textContent = '';
  figByLabel = new Map();
  for (const b of doc.blocks) if (b.type === 'fig' && b.label && !figByLabel.has(b.label)) figByLabel.set(b.label, b);
  spans = new Array(doc.sentences.length);
  sentenceFigs = new Array(doc.sentences.length);
  // Which figures each sentence mentions (captions excluded), and the first paragraph mentioning each.
  const firstMention = new Map();
  doc.blocks.forEach((b, bi) => {
    if (b.type !== 'p' || b.tag === 'caption') return;
    for (const i of b.s) {
      const labels = mentionedFigures(doc.sentences[i]);
      if (labels.length) sentenceFigs[i] = labels;
      for (const l of labels) if (!firstMention.has(l)) firstMention.set(l, bi);
    }
  });
  // Optional: show each figure right after the paragraph that first mentions it.
  let order = doc.blocks;
  if (settings.figPlace === 'mention') {
    const after = new Map();
    const moved = new Set();
    for (const b of doc.blocks) {
      const bi = b.type === 'fig' && b.label ? firstMention.get(b.label) : undefined;
      if (bi === undefined) continue;
      moved.add(b);
      if (!after.has(bi)) after.set(bi, []);
      after.get(bi).push(b);
    }
    order = [];
    doc.blocks.forEach((b, bi) => {
      if (!moved.has(b)) order.push(b);
      for (const f of after.get(bi) || []) order.push(f);
    });
  }
  let lastPage = null;
  for (const block of order) {
    if (block.type === 'p' && block.page !== undefined && block.page !== lastPage && doc.pages.length > 1) {
      const mark = document.createElement('div');
      mark.className = 'page-mark';
      mark.textContent = doc.pages[block.page].label.startsWith('photo') ? doc.pages[block.page].label : 'page ' + doc.pages[block.page].label;
      container.appendChild(mark);
      lastPage = block.page;
    }
    if (block.type === 'p') {
      const p = document.createElement('p');
      if (block.tag) p.className = block.tag;
      for (const i of block.s) {
        const span = document.createElement('span');
        span.className = 's';
        span.dataset.i = i;
        if (block.tag === 'caption') span.textContent = doc.sentences[i] + ' ';
        else appendWithFigureLinks(span, doc.sentences[i] + ' ');
        p.appendChild(span);
        spans[i] = span;
      }
      container.appendChild(p);
    } else if (block.type === 'fig') {
      const fig = document.createElement('figure');
      fig.dataset.fig = doc.blocks.indexOf(block);
      fig.title = 'Open figure' + (block.label ? ' ' + block.label : '');
      if (block.src) {
        const img = document.createElement('img');
        img.src = block.src;
        img.alt = block.alt || 'Figure';
        img.loading = 'lazy';
        fig.appendChild(img);
      } else {
        const info = doc.pages[block.page];
        const [, , fw, fh] = block.rect;
        fig.classList.add('lazy');
        // Sized by CSS (the view may be hidden now, so nothing can be measured yet).
        fig.style.width = `min(100%, ${Math.round(fw * info.w * 2.2)}px)`;
        fig.style.marginLeft = fig.style.marginRight = 'auto';
        fig.style.aspectRatio = `${fw * info.w} / ${fh * info.h}`;
        makeLazy(fig, () => renderFigure(block, Math.max(200, fig.clientWidth)));
      }
      container.appendChild(fig);
    }
  }
}

function buildPageView() {
  const container = $('pageView');
  container.textContent = '';
  pageEls = [];
  pageSentences = doc.pages.map(() => []);
  doc.boxes.forEach((bx, i) => bx?.forEach((g) => pageSentences[g.p]?.push(i)));
  doc.pages.forEach((info, pi) => {
    const el = document.createElement('div');
    el.className = 'page';
    el.style.aspectRatio = `${info.w} / ${info.h}`;
    el.dataset.p = pi;
    const num = document.createElement('span');
    num.className = 'page-num';
    num.textContent = info.label;
    el.appendChild(num);
    makeLazy(el, () => renderPage(pi, el.clientWidth * dpr()));
    container.appendChild(el);
    pageEls.push(el);
  });
}

function hasPageView() { return !!doc?.pages?.length; }
function activeView() { return hasPageView() && settings.view === 'page' ? 'page' : 'text'; }

function applyView() {
  const view = activeView();
  $('docText').hidden = view !== 'text';
  $('pageView').hidden = view !== 'page';
  $('viewBtn').hidden = !hasPageView();
  $('viewBtn').textContent = view === 'page' ? 'Text view' : 'Page view';
  // Hidden elements never report as visible, so nudge lazy loading after switching.
  requestAnimationFrame(() => {
    if (lastIdx >= 0) scrollToSentence(lastIdx, 'auto', true);
  });
}

// ---------- Opening documents ----------
async function openFiles(files) {
  files = [...files];
  if (!files.length) return;
  reader.stop();
  showStatus('Opening…', 0);
  try {
    const ocrLang = LANGS.find((l) => l[0] === settings.lang)?.[2] || 'eng';
    const d = await extractFiles(files, { lang: settings.lang, ocrLang, onStatus: showStatus });
    await saveDoc(d);
    lsSet(LS.pos, 0);
    showDoc(d, 0);
  } catch (err) {
    console.error(err);
    hideStatus();
    alert(err.message || String(err));
  }
}

function showDoc(d, startAt) {
  for (const p of pdfCache.values()) p.then((x) => x.destroy()).catch(() => {});
  pdfCache.clear();
  lazy.disconnect();
  doc = d;
  hideStatus();
  $('openPanel').hidden = true;
  $('docSection').hidden = false;
  $('player').hidden = false;
  $('docTitle').textContent = d.title;
  document.title = d.title + ' · Read the Book';
  lastIdx = -1;
  hlEls = [];
  chipKey = null;
  buildTextView();
  buildPageView();
  $('seek').max = Math.max(0, d.sentences.length - 1);
  window.scrollTo({ top: 0 });
  reader.load(d.sentences, startAt);
  applyView();
}

function closeDoc() {
  reader.stop();
  lazy.disconnect();
  doc = null;
  clearDoc();
  lsSet(LS.pos, 0);
  $('docSection').hidden = true;
  $('player').hidden = true;
  $('figChips').hidden = true;
  chipKey = '';
  $('openPanel').hidden = false;
  $('docText').textContent = '';
  $('pageView').textContent = '';
  document.title = 'Read the Book';
}

function showStatus(text, fraction) {
  $('status').hidden = false;
  $('statusText').textContent = text;
  $('statusBar').style.width = Math.round((fraction || 0) * 100) + '%';
}
function hideStatus() { $('status').hidden = true; }

// ---------- Figure button above the player ----------
// When the narration mentions a figure, a "Figure 3.1" button appears; it stays for a few
// sentences so there is time to tap it. Tapping opens the figure pane (tap again to close).
const FIG_CHIP_SPAN = 8;
let chipKey = '';
function updateFigChips(i) {
  let labels = null;
  for (let k = i; k >= Math.max(0, i - FIG_CHIP_SPAN); k--) if (sentenceFigs[k]) { labels = sentenceFigs[k]; break; }
  const key = labels ? labels.join(',') : '';
  if (key === chipKey) { markOpenChip(); return; }
  chipKey = key;
  const box = $('figChips');
  box.textContent = '';
  box.hidden = !labels;
  for (const l of (labels || []).slice(0, 3)) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'fig-chip';
    b.dataset.label = l;
    b.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 19V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2zM8.5 13.5l2.5 3 3.5-4.5 4.5 6H5l3.5-4.5z"/></svg>';
    b.append('Figure ' + l);
    box.appendChild(b);
  }
  markOpenChip();
}
function markOpenChip() {
  for (const b of $('figChips').children) b.classList.toggle('on', b.dataset.label === panelFig?.label);
}

// ---------- Highlighting ----------
function highlight(i) {
  if (!doc || !doc.sentences.length) return;
  // Text view
  if (lastIdx >= 0) spans[lastIdx]?.classList.remove('cur');
  const lo = Math.min(lastIdx < 0 ? 0 : lastIdx, i);
  const hi = Math.max(lastIdx < 0 ? spans.length - 1 : lastIdx, i);
  for (let k = lo; k <= hi; k++) spans[k]?.classList.toggle('done', k < i);
  spans[i]?.classList.add('cur');
  // Page view
  for (const el of hlEls) el.remove();
  hlEls = [];
  for (const g of doc.boxes[i] || []) {
    const pageEl = pageEls[g.p];
    if (!pageEl) continue;
    for (const [x, y, w, h] of g.r) {
      const el = document.createElement('div');
      el.className = 'hl';
      el.style.left = (x - 0.004) * 100 + '%';
      el.style.top = (y - 0.002) * 100 + '%';
      el.style.width = (w + 0.008) * 100 + '%';
      el.style.height = (h + 0.004) * 100 + '%';
      pageEl.appendChild(el);
      hlEls.push(el);
    }
  }
  lastIdx = i;
  $('seek').value = i;
  $('posLabel').textContent = `${i + 1} / ${doc.sentences.length}`;
  lsSet(LS.pos, i);
  updateFigChips(i);
  if (reader.playing) {
    scrollToSentence(i, 'smooth');
    const labels = sentenceFigs[i];
    if (settings.autoOpenFig && labels && !labels.includes(panelFig?.label)) openFigure(figByLabel.get(labels[0]));
  }
}

function scrollToSentence(i, behavior, force) {
  let target = null;
  if (activeView() === 'page') {
    target = hlEls[0];
    if (!target) { // sentence has no position (e.g. pasted text): fall back to its page
      const g = doc.boxes[i]?.[0];
      target = g ? pageEls[g.p] : null;
    }
  } else {
    target = spans[i];
  }
  if (!target) return;
  const r = target.getBoundingClientRect();
  const playerH = $('player').offsetHeight || 0;
  const visible = r.top > 80 && r.bottom < window.innerHeight - playerH - 20;
  if (!visible || force) {
    const y = window.scrollY + r.top - (window.innerHeight - playerH) / 2.5;
    window.scrollTo({ top: Math.max(0, y), behavior });
  }
}

// ---------- Voices ----------
function populateLangs() {
  const sel = $('langSelect');
  sel.innerHTML = LANGS.map(([code, name]) => `<option value="${code}">${name}</option>`).join('');
  sel.value = settings.lang;
}

function populateVoices() {
  const sel = $('voiceSelect');
  let list = allVoices.filter((v) => v.lang.toLowerCase().startsWith(settings.lang));
  const fallback = !list.length;
  if (fallback) list = allVoices.slice();
  list.sort((a, b) => voiceScore(b) - voiceScore(a) || a.name.localeCompare(b.name));

  sel.innerHTML = '';
  for (const v of list) {
    const o = document.createElement('option');
    o.value = v.voiceURI;
    o.textContent = (isNaturalVoice(v) ? '★ ' : '') + v.name.replace(/^Microsoft /, '') + ` (${v.lang})`;
    sel.appendChild(o);
  }

  const chosen = list.find((v) => v.voiceURI === settings.voiceURI) || list[0] || null;
  if (chosen) sel.value = chosen.voiceURI;
  if (chosen?.voiceURI !== reader.voice?.voiceURI) reader.setVoice(chosen);

  const hint = $('voiceHint');
  const hasNatural = list.some(isNaturalVoice);
  if (isNative) {
    hint.innerHTML = (fallback ? `No ${LANGS.find((l) => l[0] === settings.lang)[1]} voice is installed, so all voices are listed. ` : '★ marks high-quality voices. ')
      + '<a href="#" id="ttsSettings">Install more voices</a> in Android text-to-speech settings (choose Speech Services by Google).';
    $('ttsSettings').onclick = (e) => { e.preventDefault(); openVoiceSettings(); };
  } else if (!allVoices.length) {
    hint.textContent = 'This browser has no speech voices. Use Microsoft Edge or Chrome.';
  } else if (fallback) {
    hint.textContent = `No ${LANGS.find((l) => l[0] === settings.lang)[1]} voice is installed, so all voices are listed. On Android, add one in Settings → Text-to-speech; on Windows, in Settings → Time & language → Speech.`;
  } else if (!hasNatural) {
    hint.textContent = /android/i.test(navigator.userAgent)
      ? 'For a smoother voice, set Google as the text-to-speech engine in Android settings and download a high-quality voice.'
      : 'For the most natural, soothing voices, open this app in Microsoft Edge (its "Natural" voices are free).';
  } else {
    hint.textContent = '★ marks natural-sounding neural voices.';
  }
}

async function initVoices() {
  if (isNative) {
    allVoices = await getNativeVoices();
    populateVoices();
    // Voices installed in Android settings while the app was in the background.
    document.addEventListener('visibilitychange', async () => {
      if (document.visibilityState === 'visible') { allVoices = await getNativeVoices(); populateVoices(); }
    });
    return;
  }
  allVoices = await getVoices();
  populateVoices();
  window.speechSynthesis?.addEventListener?.('voiceschanged', () => {
    allVoices = speechSynthesis.getVoices();
    populateVoices();
  });
}

// ---------- Settings ----------
function applySettingsUI() {
  $('rate').value = settings.rate;
  $('pitch').value = settings.pitch;
  $('rateVal').textContent = Number(settings.rate).toFixed(2) + '×';
  $('pitchVal').textContent = Number(settings.pitch).toFixed(2);
  $('sleepSelect').value = String(settings.sleep);
  $('autoFig').checked = !!settings.autoOpenFig;
  $('figPlace').value = settings.figPlace;
  $('volume').value = settings.volume;
  showVolume();
  reader.volume = settings.volume;
  reader.rate = settings.rate;
  reader.pitch = settings.pitch;
}

function showVolume() {
  const v = Number(settings.volume);
  $('volume').style.setProperty('--fill', v * 100 + '%');
  $('volVal').textContent = Math.round(v * 100) + '%';
  $('volIcon').innerHTML = v === 0
    ? '<path d="M16.5 12A4.5 4.5 0 0 0 14 8v2.2l2.45 2.45c.03-.2.05-.42.05-.65zM19 12c0 .94-.2 1.82-.54 2.64l1.51 1.51A8.8 8.8 0 0 0 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3 3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06a8.99 8.99 0 0 0 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4 9.91 6.09 12 8.18V4z"/>'
    : v < 0.5
      ? '<path d="M18.5 12A4.5 4.5 0 0 0 16 8v8a4.47 4.47 0 0 0 2.5-4zM5 9v6h4l5 5V4L9 9H5z"/>'
      : '<path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 8v8a4.47 4.47 0 0 0 2.5-4zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/>';
  $('muteBtn').setAttribute('aria-label', v === 0 ? 'Unmute' : 'Mute');
}

function armSleepTimer() {
  clearTimeout(sleepTimer);
  if (settings.sleep > 0) sleepTimer = setTimeout(() => reader.pause(), settings.sleep * 60000);
}

// ---------- Wire up ----------
function bind() {
  $('fileInput').addEventListener('change', (e) => { openFiles(e.target.files); e.target.value = ''; });
  $('cameraInput').addEventListener('change', (e) => { openFiles(e.target.files); e.target.value = ''; });

  const dz = $('dropZone');
  ['dragenter', 'dragover'].forEach((t) => dz.addEventListener(t, (e) => { e.preventDefault(); dz.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((t) => dz.addEventListener(t, () => dz.classList.remove('over')));
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => { e.preventDefault(); if (e.dataTransfer?.files?.length) openFiles(e.dataTransfer.files); });

  $('pasteBtn').addEventListener('click', () => { $('pasteBox').hidden = false; $('pasteText').focus(); });
  $('pasteCancel').addEventListener('click', () => { $('pasteBox').hidden = true; });
  $('pasteRead').addEventListener('click', async () => {
    const t = $('pasteText').value;
    if (!t.trim()) return;
    try {
      const d = docFromText('Pasted text', t, settings.lang);
      $('pasteBox').hidden = true;
      $('pasteText').value = '';
      await saveDoc(d);
      showDoc(d, 0);
    } catch (err) { alert(err.message); }
  });

  $('closeDoc').addEventListener('click', () => { closeFigure(); closeDoc(); });
  $('figClose').addEventListener('click', closeFigure);
  $('figGoto').addEventListener('click', () => { if (panelFig) gotoFigurePage(panelFig); });
  $('viewBtn').addEventListener('click', () => {
    settings.view = activeView() === 'page' ? 'text' : 'page';
    saveSettings();
    applyView();
  });
  $('playBtn').addEventListener('click', () => reader.toggle());
  $('prevBtn').addEventListener('click', () => reader.prev());
  $('nextBtn').addEventListener('click', () => reader.next());
  $('seek').addEventListener('input', (e) => {
    reader.seek(Number(e.target.value));
    scrollToSentence(Number(e.target.value), 'auto');
  });
  $('settingsBtn').addEventListener('click', () => { $('settings').hidden = !$('settings').hidden; });
  // Tapping the page closes the settings, so they never get in the way of reading.
  $('docSection').addEventListener('pointerdown', () => { $('settings').hidden = true; $('volumeRow').classList.remove('open'); });

  $('docText').addEventListener('click', (e) => {
    const link = e.target.closest('.figlink');
    if (link) { e.preventDefault(); openFigure(figByLabel.get(link.dataset.label)); return; }
    const fig = e.target.closest('figure');
    if (fig) { openFigure(doc.blocks[Number(fig.dataset.fig)]); return; }
    const s = e.target.closest('.s');
    if (s && !window.getSelection().toString()) reader.play(Number(s.dataset.i));
  });

  // Click on an original page: read from the sentence under the pointer (or the nearest one below it).
  $('pageView').addEventListener('click', (e) => {
    const el = e.target.closest('.page');
    if (!el) return;
    const p = Number(el.dataset.p);
    const r = el.getBoundingClientRect();
    const fx = (e.clientX - r.left) / r.width, fy = (e.clientY - r.top) / r.height;
    let best = null, bestDist = Infinity;
    for (const i of pageSentences[p]) {
      for (const g of doc.boxes[i]) {
        if (g.p !== p) continue;
        for (const [x, y, w, h] of g.r) {
          if (fx >= x - 0.01 && fx <= x + w + 0.01 && fy >= y - 0.005 && fy <= y + h + 0.005) { reader.play(i); return; }
          const d = y - fy;
          if (d >= 0 && d < bestDist) { bestDist = d; best = i; }
        }
      }
    }
    if (best !== null) reader.play(best);
  });

  $('langSelect').addEventListener('change', (e) => {
    settings.lang = e.target.value; settings.voiceURI = null; saveSettings(); populateVoices();
  });
  $('voiceSelect').addEventListener('change', (e) => {
    settings.voiceURI = e.target.value; saveSettings();
    reader.setVoice(allVoices.find((v) => v.voiceURI === settings.voiceURI) || null);
  });
  $('rate').addEventListener('input', (e) => {
    settings.rate = Number(e.target.value); $('rateVal').textContent = settings.rate.toFixed(2) + '×';
  });
  $('rate').addEventListener('change', () => { saveSettings(); reader.setRate(settings.rate); });
  $('pitch').addEventListener('input', (e) => {
    settings.pitch = Number(e.target.value); $('pitchVal').textContent = settings.pitch.toFixed(2);
  });
  $('pitch').addEventListener('change', () => { saveSettings(); reader.setPitch(settings.pitch); });
  $('sleepSelect').addEventListener('change', (e) => {
    settings.sleep = Number(e.target.value); saveSettings(); if (reader.playing) armSleepTimer();
  });
  $('autoFig').addEventListener('change', (e) => { settings.autoOpenFig = e.target.checked; saveSettings(); });
  $('figChips').addEventListener('click', (e) => {
    const b = e.target.closest('.fig-chip');
    if (!b) return;
    if (panelFig?.label === b.dataset.label) closeFigure();
    else openFigure(figByLabel.get(b.dataset.label));
  });
  $('figPlace').addEventListener('change', (e) => {
    settings.figPlace = e.target.value; saveSettings();
    if (!doc) return;
    buildTextView();
    const i = lastIdx; lastIdx = -1;
    if (i >= 0) highlight(i);
    if (activeView() === 'text') scrollToSentence(Math.max(0, i), 'auto', true);
  });
  // Volume: live while dragging (applies from the next sentence; the current one is restarted on release).
  let volBefore = settings.volume || 1;
  $('volume').addEventListener('input', (e) => { settings.volume = Number(e.target.value); showVolume(); reader.volume = settings.volume; });
  $('volume').addEventListener('change', () => { saveSettings(); reader.setVolume(settings.volume); });
  const narrow = window.matchMedia('(max-width: 600px)');
  $('muteBtn').addEventListener('click', () => {
    if (narrow.matches) { $('volumeRow').classList.toggle('open'); return; }
    if (settings.volume > 0) { volBefore = settings.volume; settings.volume = 0; } else settings.volume = volBefore || 1;
    $('volume').value = settings.volume; showVolume(); saveSettings(); reader.setVolume(settings.volume);
  });
  $('previewBtn').addEventListener('click', () =>
    reader.preview('Hello. Settle in, get comfortable, and I will read this for you, nice and slowly.'));

  document.addEventListener('keydown', (e) => {
    if (!doc || e.target.closest('input, textarea, select')) return;
    if (e.key === 'Escape' && panelFig) closeFigure();
    else if (e.code === 'Space') { e.preventDefault(); reader.toggle(); }
    else if (e.key === 'ArrowRight') reader.next();
    else if (e.key === 'ArrowLeft') reader.prev();
  });

  let deferred = null;
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; $('installBtn').hidden = false; });
  $('installBtn').addEventListener('click', async () => {
    if (!deferred) return;
    deferred.prompt();
    await deferred.userChoice;
    deferred = null;
    $('installBtn').hidden = true;
  });
}

async function init() {
  if (!isNative && !('speechSynthesis' in window)) {
    alert('This browser cannot speak text. Please use Microsoft Edge or Google Chrome.');
  }
  populateLangs();
  applySettingsUI();
  bind();
  initVoices();

  const saved = await loadDoc();
  if (saved?.v === 2 && saved.sentences?.length) showDoc(saved, lsGet(LS.pos, 0));

  if (!isNative && 'serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW registration failed', e));
  }
}

init();
