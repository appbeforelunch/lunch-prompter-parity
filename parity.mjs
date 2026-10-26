#!/usr/bin/env node
// lunch-prompter-parity v1: a frozen acceptance check for a browser teleprompter.
// Scores the 11 jobs paid teleprompter apps list (J1-J11) as HAVE / PARTIAL / MISSING. Rules: README.md. MIT licensed.
//
//   node parity.mjs <index.html> [--passes 2] [--out DIR] [--expect expected.json] [--no-record] [--only J1,J4]
import { chromium } from 'playwright';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const VERSION = '1.0.0';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const VIEWPORT = { width: 1280, height: 720 };
const DSF = 2;                                   // stills at 2x
const VIDEO_SIZE = { width: 1920, height: 1080 };
const LAUNCH_ARGS = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'];
const JOBS = ['J1', 'J2', 'J3', 'J4', 'J5', 'J6', 'J7', 'J8', 'J9', 'J10', 'J11'];
const RANK = { HAVE: 2, PARTIAL: 1, MISSING: 0 };

// ---------------------------------------------------------------- frozen rules (README "The rules")
const R = {
  minFontPx: 20,          // "prompter text" = the element holding the marker word with the largest font, at least 20 px
  motionPx: 10,           // scrolling has started when the text moves up >= 10 px within 1 s without moving back
  motionWindowMs: 1000,
  startWaitMs: 8000,      // each start step waits up to 8 s for scrolling (a 3-2-1 countdown + the 2 s motion rule fit)
  j3: { skipMs: 1000, windowMs: 10000, binMs: 100, backTolPx: 1, jumpFactor: 2, minTravelPx: 20, partialTravelPx: 50 },
  j4: { settleMs: 1500, measureMs: 5000, band: [0.9, 1.1], noEffect: [0.95, 1.05], stoppedBelow: 0.2 }, // band x setting ratio: 1.8-2.2 for a doubling
  j5: { runMs: 1500, stopMs: 200, partialStopMs: 2000, stillMs: 1000, stillPx: 1, resumeMs: 5000 },
  j6: { minGrowPx: 1, buttonClicks: 3 },
  j8: { minValues: 2 },
  j9: { recordMs: 5000, minSec: 3 },
  j10: { recordMs: 63000, minSec: 60, greenMargin: 40, darkMax: 48, offFrac: 0.0001, overlayShare: 0.5 },
  rec: { startWaitMs: 8000, stopWaitMs: 4000, autoDownloadMs: 8000, clickDownloadMs: 10000 },
};

// Control patterns, matched against each visible control's accessible name (+ title, id, name, placeholder). First match in page order wins.
const PAT = {
  newScript: { re: /^\W*(new|add|create)\b|new script|add script|^\+$|^＋$/i, ex: /record|camera|video|speed|font|size/i },
  title: { re: /title|name/i, ex: /search|filter|find|file/i },
  save: { re: /^\W*save\b|save script|save changes/i, ex: /video|recording|download|export|file/i },
  start: [
    { re: /^\W*(start|open|launch|show)\s+(the\s+)?(teleprompter|prompter|prompting)/i },
    { re: /^\W*(start|play|go)\b|^▶|^⏵/i },
    { re: /prompt(er|ing)?\b|teleprompt/i },
    { re: /present|read(ing)?\s*mode|^\W*read\b|^\W*begin\b|launch|full\s*-?screen/i },
  ],
  startEx: /record|camera|stop|pause|delete|remove|new|save|import|export|download|setting|speed|font|size|mirror|countdown|title|name|wpm/i,
  play: { re: /^\W*(play|resume|start|go)\b|play\s*\/\s*pause|play|^▶|^⏵|^⏯/i, ex: /record|camera|stop|speed|countdown/i },
  speed: { re: /speed|wpm|words?\s*per\s*min|pace|scroll\s*rate/i, ex: /record/i },
  font: { re: /font|text\s*size|size\s*of\s*text|letter\s*size|type\s*size|^\W*size\b|text\s*scale|zoom|^a\s*[+＋]$|^a\s*[-−–]$|larger\s*text|smaller\s*text|bigger/i, ex: /speed|record|margin|width/i },
  mirror: { re: /mirror|flip|reverse|horizontal/i, ex: /record/i },
  countdown: { re: /count\s*-?\s*down|delay|timer/i, ex: /record\b(?!.*count)/i },
  record: [{ re: /(start|begin)\s*(a\s*)?recording|^\W*[⏺●]/i, ex: /recordings|recorded|stop|download|delete|save/i }, { re: /record|^\W*rec\b/i, ex: /recordings|recorded|stop|download|delete|save/i }],
  camera: { re: /camera|webcam|\bcam\b/i, ex: /record|stop|disable/i },
  stop: [{ re: /(stop|end|finish)\s*(the\s*)?rec|^\W*[■⏹]/i }, { re: /stop/i }, { re: /finish|^\W*done\b/i }],
  download: [{ re: /download/i, ex: /script|title/i }, { re: /save\s*(video|recording|file|take)|export/i, ex: /script|title/i }, { re: /^\W*save\b|keep/i, ex: /script|title/i }],
  settings: { re: /settings|options|preferences|controls|customi[sz]e|^⚙|gear|^\W*more\b|menu/i, ex: /record/i },
  exit: [{ re: /^\W*(back|edit|exit|close|done|scripts|library|home)\b|exit\s*full|^[×✕✖]$/i, ex: /record|delete/i }, { re: /^\W*stop\b/i, ex: /record/i }],
  inc: /^\W*[+＋]$|increase|faster|larger|bigger|more|\bup\b|^a\s*[+＋]$|›|»|plus/i,
  dec: /^\W*[-−–]$|decrease|slower|smaller|less|\bdown\b|^a\s*[-−–]$|‹|«|minus/i,
};

// The test scripts: fixed text, no digits (digits would look like a countdown), no real names or places.
const SENTENCES = [
  'The kettle hums on the stove while the bread waits on the board.',
  'A good reading pace feels slow from behind the lens and natural to the viewer.',
  'Look at the lens, breathe between lines, and let the words come to you.',
  'Each line should be short enough to read in one glance and say in one breath.',
  'If you lose your place, pause, find the next line, and carry on calmly.',
  'The room is quiet, the light is soft, and the camera is ready to roll.',
  'Practice once out loud before you record, then trust the scroll.',
  'Small pauses sound confident, and a smile changes the sound of a sentence.',
  'This paragraph exists only to make the script long enough to scroll for a while.',
  'Keep going at a steady speed, and the text will keep pace with you.',
  'When the take is done, stop, check the file, and save it somewhere safe.',
  'A plain wall, a steady shot, and clear words are all a short video needs.',
];
function makeScript(title, marker) {
  const paras = [`Good morning and welcome to this short reading test for the ${marker} prompter check.`];
  for (let p = 0; p < 24; p++) {
    const s = [];
    for (let k = 0; k < 4; k++) s.push(SENTENCES[(p * 5 + k * 7) % SENTENCES.length]);
    paras.push(s.join(' '));
  }
  return { title, marker, text: `${title}\n\n${paras.join('\n\n')}` };
}
const MAIN = makeScript('Parity Check', 'Quokkaflint');
const SCRIPT_A = makeScript('Parity Alpha', 'Marlowquill');
const SCRIPT_B = makeScript('Parity Bravo', 'Fennimoor');

// ---------------------------------------------------------------- args
function parseArgs(argv) {
  const o = { passes: 2, out: null, expect: null, record: true, only: null, target: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--passes') o.passes = Math.max(1, parseInt(argv[++i], 10));
    else if (a === '--out') o.out = argv[++i];
    else if (a === '--expect') o.expect = argv[++i];
    else if (a === '--no-record') o.record = false;
    else if (a === '--only') o.only = argv[++i].split(',').map((s) => s.trim().toUpperCase());
    else if (a === '-h' || a === '--help') { console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 5).join('\n')); process.exit(0); }
    else if (!o.target) o.target = a;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!o.target) throw new Error('usage: node parity.mjs <index.html> [options]');
  const abs = path.resolve(o.target);
  if (!fs.existsSync(abs)) throw new Error(`not found: ${o.target}`);
  o.targetUrl = pathToFileURL(abs).href;
  o.targetName = path.basename(abs);
  o.targetDir = path.dirname(abs);
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
  o.out = path.resolve(o.out || path.join('parity-runs', `run-${stamp}`));
  return o;
}

// Never write absolute local paths into reports or logs.
let SCRUB = [];
const scrub = (s) => { let t = String(s); for (const [a, b] of SCRUB) t = t.split(a).join(b); return t; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round = (x, n = 2) => (x == null || !Number.isFinite(x) ? x : Math.round(x * 10 ** n) / 10 ** n);

// ---------------------------------------------------------------- in-page library (added before the app's own scripts; it only observes)
function pageLib() {
  if (window.__parity) return;
  const P = (window.__parity = { media: [], keys: [], frames: [], sampling: false, _els: [], nextId: 1 });
  const ids = new WeakMap();
  const now = () => performance.now();
  P.idOf = (el) => { if (!ids.has(el)) ids.set(el, P.nextId++); return ids.get(el); };

  // Media observers (J9, J10): log camera requests and recorder start/stop. Behaviour is unchanged.
  try {
    const md = navigator.mediaDevices;
    if (md && md.getUserMedia) {
      const orig = md.getUserMedia.bind(md);
      md.getUserMedia = async (c) => {
        P.media.push({ t: now(), ev: 'getUserMedia', c: JSON.stringify(c) });
        try { const s = await orig(c); P.media.push({ t: now(), ev: 'camera-ok', tracks: s.getTracks().map((t) => `${t.kind}:${t.id}`) }); return s; }
        catch (e) { P.media.push({ t: now(), ev: 'camera-error', err: String(e && e.name) }); throw e; }
      };
    }
  } catch (e) {}
  try {
    const MR = window.MediaRecorder;
    if (MR) {
      window.MediaRecorder = class extends MR {
        constructor(stream, opts) { super(stream, opts); P.media.push({ t: now(), ev: 'recorder', tracks: stream.getTracks().map((t) => `${t.kind}:${t.id}`) }); }
        start(...a) { P.media.push({ t: now(), ev: 'start' }); return super.start(...a); }
        stop(...a) { P.media.push({ t: now(), ev: 'stop' }); return super.stop(...a); }
      };
    }
  } catch (e) {}
  window.addEventListener('keydown', (e) => { P.keys.push({ t: now(), key: e.key }); }, true);

  const SKIP = 'textarea,input,select,option,[contenteditable=""],[contenteditable="true"],[contenteditable="plaintext-only"],script,style,noscript,template';
  P.visible = (el) => {
    if (!el.getClientRects().length) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    if (getComputedStyle(el).visibility === 'hidden') return false;
    if (el.closest('[hidden],[inert]')) return false;
    return true;
  };
  P.opacity = (el) => { let o = 1; for (let e = el; e && e.nodeType === 1; e = e.parentElement) o *= parseFloat(getComputedStyle(e).opacity || '1'); return o; };
  P.kind = (el) => {
    const t = el.tagName;
    if (t === 'INPUT') {
      const ty = (el.getAttribute('type') || 'text').toLowerCase();
      if (ty === 'range') return 'range';
      if (ty === 'number') return 'number';
      if (ty === 'checkbox' || ty === 'radio') return 'checkbox';
      if (['button', 'submit', 'reset', 'image'].includes(ty)) return 'button';
      if (ty === 'file') return 'file';
      if (ty === 'color') return 'color';
      return 'text';
    }
    if (t === 'SELECT') return 'select';
    if (t === 'TEXTAREA') return 'textarea';
    if (t === 'LABEL') return 'label';
    if (t === 'A') return 'link';
    const role = el.getAttribute('role');
    if (role === 'checkbox' || role === 'switch') return 'checkbox';
    if (el.isContentEditable) return 'editable';
    return 'button';
  };
  P.ownText = (el) => {
    let s = '';
    const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = tw.nextNode(); n; n = tw.nextNode()) { if (n.parentElement && n.parentElement.closest('select,textarea,option,script,style') && n.parentElement.closest('select,textarea,option,script,style') !== el) continue; s += n.nodeValue + ' '; }
    return s.replace(/\s+/g, ' ').trim();
  };
  P.label = (el) => {
    const parts = [];
    const lb = el.getAttribute('aria-labelledby');
    if (lb) parts.push(lb.split(/\s+/).map((id) => (document.getElementById(id) || {}).textContent || '').join(' '));
    const al = el.getAttribute('aria-label'); if (al) parts.push(al);
    if (el.labels && el.labels.length) parts.push([...el.labels].map((l) => P.ownText(l)).join(' '));
    const isField = ['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName);
    if (!isField) { const t = P.ownText(el); if (t.length <= 80) parts.push(t); }
    else if (!parts.length) {
      const prev = el.previousElementSibling;
      if (prev && !prev.matches('input,select,textarea,button')) { const t = P.ownText(prev); if (t.length <= 80) parts.push(t); }
      const par = el.parentElement;
      if (par) parts.push([...par.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(' '));
    }
    for (const a of ['title', 'placeholder', 'alt', 'name', 'id']) { const v = el.getAttribute(a); if (v) parts.push(v); }
    if (el.tagName === 'INPUT' && ['button', 'submit'].includes((el.type || '').toLowerCase()) && el.value) parts.push(el.value);
    return parts.join(' | ').replace(/\s+/g, ' ').trim();
  };
  P.ctrls = () => {
    const sel = 'button,[role=button],[role=switch],[role=checkbox],[role=slider],[role=tab],[role=menuitem],[role=option],[role=spinbutton],a[href],input:not([type=hidden]),select,textarea,summary,label,[onclick],[tabindex]:not([tabindex="-1"]),[contenteditable=""],[contenteditable="true"],[contenteditable="plaintext-only"]';
    const out = []; P._els = [];
    for (const el of document.querySelectorAll(sel)) {
      if (!P.visible(el)) continue;
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
      const i = P._els.push(el) - 1;
      out.push({ i, kind: P.kind(el), tag: el.tagName.toLowerCase(), label: P.label(el).slice(0, 200), checked: !!el.checked, pressed: el.getAttribute('aria-pressed') || el.getAttribute('aria-checked') || '' });
    }
    return out;
  };
  P.el = (i) => P._els[i];

  // Text finder: the displayed element holding the word with the largest font size (form fields and editors excluded).
  P.findText = (word, minFont) => {
    const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let best = null, bestFs = -1;
    for (let n = tw.nextNode(); n; n = tw.nextNode()) {
      if (!n.nodeValue.includes(word)) continue;
      const el = n.parentElement;
      if (!el || el.closest(SKIP)) continue;
      if (!el.getClientRects().length) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden') continue;
      const fs = parseFloat(cs.fontSize);
      if (fs < minFont) continue;
      if (fs > bestFs) { best = { el, node: n }; bestFs = fs; }
    }
    return best;
  };
  P.flipInfo = (el) => {
    let M = new DOMMatrix();
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
      const cs = getComputedStyle(e);
      let m = new DOMMatrix();
      if (cs.rotate && cs.rotate !== 'none') {
        const p = cs.rotate.trim().split(/\s+/);
        const ang = parseFloat(p[p.length - 1]) * (/rad$/.test(p[p.length - 1]) ? 180 / Math.PI : /turn$/.test(p[p.length - 1]) ? 360 : 1);
        let ax = [0, 0, 1];
        if (p.length === 2) ax = p[0] === 'x' ? [1, 0, 0] : p[0] === 'y' ? [0, 1, 0] : [0, 0, 1];
        if (p.length === 4) ax = p.slice(0, 3).map(parseFloat);
        m = m.multiply(new DOMMatrix().rotateAxisAngle(ax[0], ax[1], ax[2], ang));
      }
      if (cs.scale && cs.scale !== 'none') { const s = cs.scale.trim().split(/\s+/).map(parseFloat); m = m.multiply(new DOMMatrix().scale(s[0], s.length > 1 ? s[1] : s[0])); }
      if (cs.transform && cs.transform !== 'none') m = m.multiply(new DOMMatrix(cs.transform));
      M = m.multiply(M);
    }
    return { a: Math.round(M.a * 1000) / 1000, d: Math.round(M.d * 1000) / 1000, flippedX: M.a < 0 && M.d > 0 };
  };
  P.glyphFlip = (node, word) => {
    const i = node.nodeValue.indexOf(word);
    if (i < 0) return null;
    const r = document.createRange();
    r.setStart(node, i); r.setEnd(node, i + 1);
    const a = r.getBoundingClientRect();
    r.setStart(node, i + word.length - 1); r.setEnd(node, i + word.length);
    const b = r.getBoundingClientRect();
    return a.left > b.left;
  };
  P.textInfo = (word, minFont) => {
    const f = P.findText(word, minFont);
    if (!f) return { found: false };
    const cs = getComputedStyle(f.el);
    const r = f.el.getBoundingClientRect();
    return { found: true, fontPx: parseFloat(cs.fontSize), opacity: Math.round(P.opacity(f.el) * 100) / 100, top: r.top, inView: r.bottom > 0 && r.top < innerHeight, flip: P.flipInfo(f.el), glyphFlip: P.glyphFlip(f.node, word) };
  };
  // Is the word anywhere in the page: editor fields included (J2 "the script's text comes back").
  P.hasWord = (word) => {
    for (const el of document.querySelectorAll('textarea,input')) if ((el.value || '').includes(word) && P.visible(el)) return 'field';
    for (const el of document.querySelectorAll('[contenteditable]')) if ((el.textContent || '').includes(word) && P.visible(el)) return 'editor';
    const f = P.findText(word, 0);
    return f ? 'text' : '';
  };
  // Elements whose own text includes a title (J2 list check). Returns indexes into P._els.
  P.findTitle = (title) => {
    P._els = [];
    const out = [];
    for (const el of document.body.querySelectorAll('*')) {
      if (el.closest('textarea,script,style,template')) continue;
      let own = '';
      if (el.tagName === 'OPTION') own = el.textContent; else for (const c of el.childNodes) if (c.nodeType === 3) own += c.nodeValue;
      if (!own.includes(title)) continue;
      if (el.tagName === 'OPTION') { const s = el.closest('select'); if (!s || !P.visible(s)) continue; out.push({ i: P._els.push(el) - 1, option: true, value: el.value, label: el.textContent.trim() }); continue; }
      if (!P.visible(el)) continue;
      out.push({ i: P._els.push(el) - 1, option: false, tag: el.tagName.toLowerCase() });
    }
    return out;
  };
  // Count-like text (J8): an element whose own text is short and holds exactly one whole number from 1 to 10.
  P.countLike = () => {
    const out = [];
    for (const el of document.body.querySelectorAll('*')) {
      let own = '';
      for (const c of el.childNodes) if (c.nodeType === 3) own += c.nodeValue;
      own = own.trim();
      if (!own || own.length > 24) continue;
      const m = own.match(/\d+/g);
      if (!m || m.length !== 1) continue;
      const v = parseInt(m[0], 10);
      if (v < 1 || v > 10) continue;
      if (el.closest('textarea,select,option,script,style')) continue;
      if (!el.getClientRects().length) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || P.opacity(el) < 0.05) continue;
      out.push({ key: `${P.idOf(el)}:${own}`, v });
    }
    return out;
  };
  // Sampler: every animation frame, the marker element's position (-top, px; grows as text scrolls up) and optionally count-like text.
  P.sampleStart = (word, counts) => {
    P.frames = []; P.sampling = true;
    const pre = counts ? new Set(P.countLike().map((c) => c.key)) : null;
    let cur = null, n = 0;
    const tick = () => {
      if (!P.sampling) return;
      n++;
      if (!cur || !cur.el.isConnected || !cur.el.getClientRects().length || n % 30 === 0) {
        const f = P.findText(word, 20);
        if (f) { if (!cur || f.el !== cur.el) cur = f; } else if (cur && (!cur.el.isConnected || !cur.el.getClientRects().length)) cur = null;
      }
      const fr = { t: now() };
      if (cur) { fr.pos = -cur.el.getBoundingClientRect().top; fr.el = P.idOf(cur.el); }
      if (pre) fr.counts = P.countLike().filter((c) => !pre.has(c.key)).map((c) => c.v);
      P.frames.push(fr);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    return now();
  };
  P.sampleStop = () => { P.sampling = false; return P.frames.length; };
  P.now = now;
}

// ---------------------------------------------------------------- analysis helpers (pure)
// Scrolling has started at frame t when the text is >= 10 px higher 1 s later AND another >= 10 px higher 1 s after that
// (sustained, so a view sliding in does not count), same element throughout.
function motionStart(frames, fromT) {
  const W = R.motionWindowMs;
  const at = (k0, t) => { for (let k = k0; k < frames.length; k++) if (frames[k].t >= t) return k; return -1; };
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    if (f.t < fromT || f.pos == null) continue;
    const j = at(i, f.t + W); if (j < 0) return null;
    const k = at(j, f.t + 2 * W); if (k < 0) return null;
    const g = frames[j], h = frames[k];
    if (g.pos == null || h.pos == null || g.el !== f.el || h.el !== f.el) continue;
    if (g.pos - f.pos >= R.motionPx && h.pos - g.pos >= R.motionPx) return f.t;
  }
  return null;
}
function posAt(frames, t) {   // linear interpolation between the two frames around t
  let prev = null;
  for (const f of frames) {
    if (f.pos == null) continue;
    if (f.t >= t) { if (!prev) return f.pos; if (f.el !== prev.el) return f.pos; return prev.pos + ((f.pos - prev.pos) * (t - prev.t)) / (f.t - prev.t || 1); }
    prev = f;
  }
  return prev ? prev.pos : null;
}
function rate(frames, t0, t1) {   // px/s by least squares over [t0, t1]
  const pts = frames.filter((f) => f.pos != null && f.t >= t0 && f.t <= t1);
  if (pts.length < 5) return null;
  const elId = pts[pts.length - 1].el;
  const q = pts.filter((f) => f.el === elId);
  const n = q.length, mx = q.reduce((s, f) => s + f.t, 0) / n, my = q.reduce((s, f) => s + f.pos, 0) / n;
  let sxy = 0, sxx = 0;
  for (const f of q) { sxy += (f.t - mx) * (f.pos - my); sxx += (f.t - mx) ** 2; }
  return sxx ? (sxy / sxx) * 1000 : null;
}
const median = (a) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

// ---------------------------------------------------------------- page helpers
async function ctrls(page) { return page.evaluate(() => window.__parity.ctrls()); }
function matchList(list, spec, kinds) {
  const specs = Array.isArray(spec) ? spec : [spec];
  for (const s of specs) {
    const hits = list.filter((c) => (!kinds || kinds.includes(c.kind)) && s.re.test(c.label) && !(s.ex && s.ex.test(c.label)));
    if (hits.length) return hits;
  }
  return [];
}
async function find(page, spec, kinds) { const h = matchList(await ctrls(page), spec, kinds); return h[0] || null; }
async function findAll(page, spec, kinds) { return matchList(await ctrls(page), spec, kinds); }
async function handleOf(page, c) { return page.evaluateHandle((i) => window.__parity.el(i), c.i); }
async function click(page, c) {
  const h = await handleOf(page, c);
  try { await h.click({ timeout: 3000 }); }
  catch (e) { try { await h.click({ force: true, timeout: 2000 }); } catch (e2) { await h.evaluate((el) => el.click()); } }
  await h.dispose();
}
async function wake(page) {   // controls that hide until the pointer moves
  for (const [x, y] of [[640, 360], [640, 690], [640, 30], [640, 360]]) { await page.mouse.move(x, y, { steps: 3 }); await sleep(60); }
  await sleep(250);
}
async function findEditor(page) {
  const list = await ctrls(page);
  const eds = list.filter((c) => c.kind === 'textarea' || c.kind === 'editable');
  if (!eds.length) return null;
  const sizes = await page.evaluate((ix) => ix.map((i) => { const r = window.__parity.el(i).getBoundingClientRect(); return r.width * r.height; }), eds.map((c) => c.i));
  let best = 0;
  for (let k = 1; k < eds.length; k++) if (sizes[k] > sizes[best]) best = k;
  return eds[best];
}
async function editorVisible(page) { return !!(await findEditor(page)); }
async function goEditor(page) {
  if (await editorVisible(page)) return true;
  await page.keyboard.press('Escape'); await sleep(500);
  if (await editorVisible(page)) return true;
  await wake(page);
  const c = await find(page, PAT.exit);
  if (c) { await click(page, c); await sleep(700); }
  return editorVisible(page);
}
async function textInfo(page, word, minFont = R.minFontPx) { return page.evaluate(([w, m]) => window.__parity.textInfo(w, m), [word, minFont]); }

// Find a control: current view, then after the pointer moves, then inside a settings panel, then in the other view.
async function locate(page, spec, { kinds = null, switchView = true, ctx = {} } = {}) {
  let c = await find(page, spec, kinds);
  if (c) return { c, where: 'view' };
  await wake(page);
  c = await find(page, spec, kinds);
  if (c) return { c, where: 'view' };
  const s = await find(page, PAT.settings);
  if (s) { await click(page, s); await sleep(500); c = await find(page, spec, kinds); if (c) return { c, where: 'settings' }; }
  if (!switchView) return null;
  const inEditor = await editorVisible(page);
  if (inEditor) { await openPrompter(page, ctx); } else { await goEditor(page); }
  await wake(page);
  c = await find(page, spec, kinds);
  if (c) return { c, where: inEditor ? 'prompter' : 'editor' };
  const s2 = await find(page, PAT.settings);
  if (s2) { await click(page, s2); await sleep(500); c = await find(page, spec, kinds); if (c) return { c, where: (inEditor ? 'prompter' : 'editor') + '+settings' }; }
  return null;
}

// Put a script in: the editor (a "new script" control first if no editor shows), an optional title field, then Save if there is one.
let PROMPT_ANSWER = MAIN.title;   // a browser prompt() (e.g. "Name this script") is answered with the current script's title
async function enterScript(page, s, { clickNew = false } = {}) {
  PROMPT_ANSWER = s.title;
  if (clickNew) { const n = await find(page, PAT.newScript); if (n) { await click(page, n); await sleep(600); } }
  let ed = await findEditor(page);
  if (!ed) { const n = await find(page, PAT.newScript); if (n) { await click(page, n); await sleep(600); ed = await findEditor(page); } }
  if (!ed) { await goEditor(page); ed = await findEditor(page); }
  if (!ed) return { ok: false, reason: 'no script editor found' };
  const list = await ctrls(page);
  const title = matchList(list, PAT.title, ['text']).find((c) => c.i !== ed.i);
  if (title) { const h = await handleOf(page, title); await h.fill(s.title); await h.dispose(); }
  const h = await handleOf(page, ed);
  await h.fill(s.text);
  await h.focus();
  await page.keyboard.type(' ');
  await page.keyboard.press('Backspace');
  await h.evaluate((el) => el.blur());
  await h.dispose();
  await sleep(200);
  const sv = await find(page, PAT.save);
  if (sv) { await click(page, sv); await sleep(400); }
  return { ok: true, titleField: !!title, saved: !!sv, editor: ed.kind };
}

// Start scrolling: (a) a start/open-prompter control, (b) a play control, (c) the space bar. Each waits up to 8 s for motion.
async function startSequence(page, word, { counts = false } = {}) {
  const t0 = await page.evaluate(([w, c]) => window.__parity.sampleStart(w, c), [word, counts]);
  const steps = [];
  const moving = async (from, ms) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      await sleep(250);
      const fr = await page.evaluate(() => window.__parity.frames);
      const m = motionStart(fr, from);
      if (m != null) return m;
    }
    return null;
  };
  let m = await moving(t0, 2500);   // some apps scroll as soon as the script is in
  if (m == null) {
    await wake(page);
    const list = await ctrls(page);
    let c = null;
    for (const s of PAT.start) {
      const hits = list.filter((x) => s.re.test(x.label) && !PAT.startEx.test(x.label));
      c = hits.find((x) => x.kind !== 'link') || hits[0];
      if (c) break;
    }
    if (c) { steps.push(`start control "${c.label}"`); const t = await page.evaluate(() => performance.now()); await click(page, c); m = await moving(t, R.startWaitMs); }
  }
  if (m == null) {
    await wake(page);
    const c = await find(page, PAT.play);
    if (c) { steps.push(`play control "${c.label}"`); const t = await page.evaluate(() => performance.now()); await click(page, c); m = await moving(t, R.startWaitMs); }
  }
  if (m == null) {
    await page.evaluate(() => { const a = document.activeElement; if (a && a !== document.body && a.matches('input,textarea,select,button,[contenteditable],a,summary,[role=button]')) a.blur(); });
    steps.push('space bar');
    const t = await page.evaluate(() => performance.now());
    await page.keyboard.press('Space');
    m = await moving(t, R.startWaitMs);
  }
  return { t0, motionT: m, steps };
}
async function openPrompter(page, ctx = {}) {   // used by locate(): get to the prompter view without measuring
  const r = await startSequence(page, ctx.word || MAIN.marker);
  await page.evaluate(() => window.__parity.sampleStop());
  return r;
}
async function frames(page) { return page.evaluate(() => window.__parity.frames); }

// Set a numeric-ish control. Returns { before, after } setting values (numbers) or null.
async function readSetting(page, c) {
  return page.evaluate((i) => {
    const el = window.__parity.el(i);
    const num = (s) => { const m = String(s).match(/-?\d+(\.\d+)?/); return m ? parseFloat(m[0]) : null; };
    if (el.tagName === 'SELECT') return { kind: 'select', value: num(el.value) ?? num(el.options[el.selectedIndex]?.text), index: el.selectedIndex, options: [...el.options].map((o) => num(o.value) ?? num(o.text)) };
    if (el.tagName === 'INPUT') return { kind: el.type, value: parseFloat(el.value), min: el.min === '' ? null : parseFloat(el.min), max: el.max === '' ? null : parseFloat(el.max), step: el.step === '' || el.step === 'any' ? null : parseFloat(el.step) };
    return { kind: 'other' };
  }, c.i);
}
async function writeSetting(page, c, v) {
  return page.evaluate(([i, v]) => {
    const el = window.__parity.el(i);
    if (el.tagName === 'SELECT') { el.selectedIndex = v; }
    else { const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(el, String(v)); }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    const num = (s) => { const m = String(s).match(/-?\d+(\.\d+)?/); return m ? parseFloat(m[0]) : null; };
    return el.tagName === 'SELECT' ? (num(el.value) ?? num(el.options[el.selectedIndex]?.text)) : parseFloat(el.value);
  }, [c.i, v]);
}
// For +/- buttons: the number shown next to them (nearest ancestor text, button text removed).
async function readNear(page, c) {
  return page.evaluate((i) => {
    let el = window.__parity.el(i);
    for (let k = 0; k < 3 && el.parentElement; k++) {
      el = el.parentElement;
      const clone = el.cloneNode(true);
      clone.querySelectorAll('button,[role=button],input[type=button]').forEach((b) => b.remove());
      const vals = clone.querySelectorAll('input,output,select');
      for (const v of vals) { const x = parseFloat(v.value); if (Number.isFinite(x)) return x; }
      const m = clone.textContent.match(/\d+(\.\d+)?/);
      if (m) return parseFloat(m[0]);
    }
    return null;
  }, c.i);
}
// Pick the matched controls to adjust: a field if any (range/number/select, or a label's own field), else +/- buttons.
async function adjustable(page, spec) {
  const hits = await findAll(page, spec);
  for (const h of hits) {
    if (['range', 'number', 'select'].includes(h.kind)) return { field: h };
    if (h.kind === 'label' || h.kind === 'button') {
      const sub = await page.evaluate((i) => {
        const el = window.__parity.el(i);
        const f = el.tagName === 'LABEL' && el.control ? el.control : el.querySelector('input[type=range],input[type=number],select');
        if (!f) return -1;
        return window.__parity._els.indexOf(f);
      }, h.i);
      if (sub >= 0) { const list = await ctrls(page); const f = list.find((x) => x.i === sub); if (f && ['range', 'number', 'select'].includes(f.kind)) return { field: f }; }
    }
  }
  const btns = hits.filter((h) => h.kind === 'button');
  const inc = btns.find((b) => PAT.inc.test(b.label));
  const dec = btns.find((b) => PAT.dec.test(b.label));
  if (inc || dec) return { inc, dec };
  // a "speed"/"font" label near unlabeled +/- buttons
  if (hits.length) {
    const near = await page.evaluate((i) => {
      let el = window.__parity.el(i);
      for (let k = 0; k < 3 && el.parentElement; k++) {
        el = el.parentElement;
        const b = [...el.querySelectorAll('button,[role=button]')].map((x) => window.__parity._els.indexOf(x)).filter((x) => x >= 0);
        if (b.length) return b;
      }
      return [];
    }, hits[0].i);
    const list = await ctrls(page);
    const bs = list.filter((x) => near.includes(x.i));
    const inc2 = bs.find((b) => PAT.inc.test(b.label));
    const dec2 = bs.find((b) => PAT.dec.test(b.label));
    if (inc2 || dec2) return { inc: inc2, dec: dec2 };
  }
  return hits.length ? { other: hits[0] } : null;
}
async function locateAdjustable(page, spec, opts) {
  const l = await locate(page, spec, opts);
  if (!l) return null;
  const a = await adjustable(page, spec);
  return a ? { ...a, where: l.where } : null;
}

// ---------------------------------------------------------------- recording (J9, J10)
async function mediaLog(page) { return page.evaluate(() => window.__parity.media.slice()); }
async function recordFlow(page, ms, downloads, label) {
  const ev = { steps: [] };
  const since = async (t, name) => (await mediaLog(page)).find((m) => m.t >= t && m.ev === name);
  const waitEv = async (t, name, wait) => { const end = Date.now() + wait; while (Date.now() < end) { const e = await since(t, name); if (e) return e; await sleep(200); } return null; };
  let l = await locate(page, PAT.record);
  let camClicked = false;
  if (!l) {
    const cam = await locate(page, PAT.camera);
    if (cam) { ev.steps.push(`camera control "${cam.c.label}"`); await click(page, cam.c); camClicked = true; await sleep(1500); l = await locate(page, PAT.record, { switchView: false }); }
  }
  if (!l) return { ...ev, ok: false, reason: 'not found: no record control' };
  // Click record; if no recorder starts within 8 s: turn the camera on (once), then try each other record-like control (up to 2 more).
  const tried = new Set();
  let recHandle = null, st = null;
  const tryRec = async (c, where) => {
    tried.add(c.label);
    const t = await page.evaluate(() => performance.now());
    ev.steps.push(`record control "${c.label}"${where ? ` (${where})` : ''}`);
    const h = await handleOf(page, c);
    await click(page, c);
    const e = await waitEv(t, 'start', R.rec.startWaitMs);
    if (e) { recHandle = h; return e; }
    await h.dispose();
    return null;
  };
  st = await tryRec(l.c, l.where);
  for (let k = 0; !st && k < 3; k++) {
    if (!camClicked) {
      const cam = await find(page, PAT.camera);
      camClicked = true;
      if (cam) { ev.steps.push(`camera control "${cam.label}"`); await click(page, cam); await sleep(1500); const l2 = await find(page, PAT.record); if (l2) { st = await tryRec(l2); continue; } }
    }
    await wake(page);
    const other = matchList(await ctrls(page), PAT.record).find((c) => !tried.has(c.label));
    if (!other) break;
    st = await tryRec(other);
  }
  const log = await mediaLog(page);
  ev.camera = log.filter((m) => m.ev.startsWith('camera') || m.ev === 'getUserMedia').map((m) => m.ev + (m.err ? `:${m.err}` : ''));
  if (!st) return { ...ev, ok: false, reason: 'recording did not start (no MediaRecorder start within 8 s)' };
  const nDl = downloads.length;
  await sleep(ms);
  let stopped = await since(st.t, 'stop');
  if (!stopped) {
    await wake(page);
    const s = matchList(await ctrls(page), PAT.stop)[0];
    if (s) { ev.steps.push(`stop control "${s.label}"`); await click(page, s); }
    stopped = await waitEv(st.t, 'stop', R.rec.stopWaitMs);
    if (!stopped && recHandle) {   // the record control is often a toggle: click the same element again
      ev.steps.push('record control again (toggle)');
      try { await recHandle.click({ timeout: 3000 }); } catch (e) { try { await recHandle.evaluate((el) => el.click()); } catch (e2) {} }
      stopped = await waitEv(st.t, 'stop', R.rec.stopWaitMs);
    }
  } else ev.steps.push('recorder stopped by itself');
  if (recHandle) await recHandle.dispose().catch(() => {});
  ev.recordedMs = stopped ? Math.round(stopped.t - st.t) : null;
  const rec = (await mediaLog(page)).filter((m) => m.ev === 'recorder').pop();
  const cams = (await mediaLog(page)).filter((m) => m.ev === 'camera-ok').flatMap((m) => m.tracks);
  ev.recordsCameraTrackDirectly = rec ? rec.tracks.filter((x) => x.startsWith('video')).every((x) => cams.includes(x)) && rec.tracks.some((x) => x.startsWith('video')) : null;
  const waitDl = async (wait) => { const end = Date.now() + wait; while (Date.now() < end) { if (downloads.length > nDl) return true; await sleep(200); } return downloads.length > nDl; };
  let got = await waitDl(R.rec.autoDownloadMs);
  if (!got) {
    await wake(page);
    const d = await find(page, PAT.download);
    if (d) { ev.steps.push(`download control "${d.label}"`); await click(page, d); got = await waitDl(R.rec.clickDownloadMs); }
  }
  if (!got) return { ...ev, ok: false, reason: 'no file downloaded' };
  const dl = downloads[downloads.length - 1];
  return { ...ev, ok: true, file: dl };
}
function probe(file) {
  const r = { file: path.basename(file) };
  const p = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration,format_name:stream=codec_type,codec_name,width,height', '-of', 'json', file], { encoding: 'utf8' });
  try {
    const j = JSON.parse(p.stdout);
    r.format = j.format?.format_name;
    r.streams = (j.streams || []).map((s) => `${s.codec_type}:${s.codec_name}${s.width ? `:${s.width}x${s.height}` : ''}`);
    const v = (j.streams || []).find((s) => s.codec_type === 'video');
    if (v) { r.width = v.width; r.height = v.height; }
    const d = parseFloat(j.format?.duration);
    if (Number.isFinite(d)) { r.duration = d; r.durationFrom = 'format'; }
  } catch (e) { r.probeError = (p.stderr || String(e)).slice(0, 200); }
  if (r.duration == null) {   // MediaRecorder WebM has no duration in its header: use the last packet time
    const q = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'packet=pts_time,duration_time', '-of', 'csv=p=0', file], { encoding: 'utf8', maxBuffer: 1e9 });
    let last = null;
    for (const line of q.stdout.split('\n')) { const [a, b] = line.split(','); const x = parseFloat(a), y = parseFloat(b); if (Number.isFinite(x)) last = Math.max(last ?? 0, x + (Number.isFinite(y) ? y : 0)); }
    if (last != null) { r.duration = last; r.durationFrom = 'last packet'; }
  }
  const dec = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:v:0?', '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 1e9 });
  r.decodes = dec.status === 0;
  if (dec.stderr && dec.stderr.trim()) r.decodeErrors = dec.stderr.trim().split('\n').length;
  const n = spawnSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', file], { encoding: 'utf8', maxBuffer: 1e9 });
  r.videoFrames = parseInt(n.stdout, 10) || 0;
  r.playable = r.decodes && r.videoFrames > 0;
  return r;
}
// J10 overlay: 1 frame per second; pixels that are neither green-dominant (the browser test camera is all greens) nor near-black.
function overlayCheck(file, info, shotPath) {
  const { width: w, height: h } = info;
  if (!w || !h) return { error: 'no video size' };
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-vf', 'fps=1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 4e9 });
  const buf = r.stdout, fsz = w * h * 3, n = Math.floor(buf.length / fsz);
  const fr = [];
  let worst = -1, worstK = -1;
  for (let k = 0; k < n; k++) {
    let off = 0;
    for (let i = k * fsz; i < (k + 1) * fsz; i += 3) {
      const R0 = buf[i], G = buf[i + 1], B = buf[i + 2];
      if (G - Math.max(R0, B) >= R.j10.greenMargin) continue;
      if (Math.max(R0, G, B) < R.j10.darkMax) continue;
      off++;
    }
    const frac = off / (w * h);
    fr.push(round(frac * 100, 4));
    if (frac > worst) { worst = frac; worstK = k; }
  }
  const flagged = fr.filter((p) => p / 100 > R.j10.offFrac).length;
  const overlay = n > 0 && flagged / n >= R.j10.overlayShare;
  if (shotPath && worstK >= 0) spawnSync('ffmpeg', ['-v', 'error', '-y', '-ss', String(worstK), '-i', file, '-frames:v', '1', shotPath]);
  return { framesChecked: n, framesFlagged: flagged, offPercentPerFrame: fr.length > 20 ? fr.filter((_, i) => i % 5 === 0) : fr, overlay };
}

// ---------------------------------------------------------------- the jobs
async function prepare(page, ctx, script = MAIN) {
  await page.goto(ctx.url, { waitUntil: 'load' });
  await sleep(800);
  return enterScript(page, script);
}
const res = (status, reason, extra = {}) => ({ status, reason, ...extra });

const CHECKS = {
  async J1(page, ctx) {
    const e = await prepare(page, ctx);
    if (!e.ok) return res('MISSING', e.reason);
    const s = await startSequence(page, MAIN.marker);
    await page.evaluate(() => window.__parity.sampleStop());
    let info = await textInfo(page, MAIN.marker);
    const end = Date.now() + 3000;
    while ((!info.found || info.opacity <= 0.05) && Date.now() < end) { await sleep(300); info = await textInfo(page, MAIN.marker); }
    await ctx.shot(page, 'J1-prompter');
    if (info.found && info.opacity > 0.05) return res('HAVE', `typed text shown at ${info.fontPx}px`, { steps: s.steps, text: info });
    return res('MISSING', `typed text not shown in a prompter view (no displayed element with the marker word at >= ${R.minFontPx}px)`, { steps: s.steps, text: info });
  },

  async J2(page, ctx) {
    await page.goto(ctx.url, { waitUntil: 'load' });
    await sleep(800);
    const ea = await enterScript(page, SCRIPT_A, { clickNew: true });
    if (!ea.ok) return res('MISSING', ea.reason);
    await goEditor(page);
    const eb = await enterScript(page, SCRIPT_B, { clickNew: true });
    if (!eb.ok) return res('MISSING', eb.reason);
    await sleep(1000);
    await page.reload({ waitUntil: 'load' });
    await sleep(1500);
    const out = {};
    for (const s of [SCRIPT_A, SCRIPT_B]) {
      let hits = await page.evaluate((t) => window.__parity.findTitle(t), s.title);
      if (!hits.length) { await goEditor(page); await wake(page); hits = await page.evaluate((t) => window.__parity.findTitle(t), s.title); }
      const o = { titleListed: hits.length > 0, opened: false, via: '' };
      if (hits.length) {
        const hOpt = hits.find((x) => x.option);
        const hEl = hits.find((x) => !x.option);
        if (hOpt) { await page.evaluate((i) => { const op = window.__parity.el(i); const sel = op.closest('select'); sel.value = op.value; sel.dispatchEvent(new Event('input', { bubbles: true })); sel.dispatchEvent(new Event('change', { bubbles: true })); }, hOpt.i); o.via = 'selected title'; }
        else if (hEl) { const h = await handleOf(page, hEl); try { await h.click({ timeout: 3000 }); } catch (e) { await h.evaluate((el) => el.click()); } await h.dispose(); o.via = 'clicked title'; }
        await sleep(800);
      }
      const where = await page.evaluate((w) => window.__parity.hasWord(w), s.marker);
      o.opened = !!where; o.textIn = where;
      out[s.title] = o;
    }
    await ctx.shot(page, 'J2-after-reload');
    const vals = Object.values(out);
    const titled = vals.filter((o) => o.titleListed && o.opened).length;
    const survived = vals.filter((o) => o.opened).length;
    const ev = { scripts: out, titleField: ea.titleField, saveControl: ea.saved };
    if (titled === 2) return res('HAVE', 'both titled scripts listed after reload and each opens its own text', ev);
    if (survived >= 1) return res('PARTIAL', `${survived} of 2 scripts' text came back after reload, ${titled} of 2 listed by title and opened`, ev);
    return res('MISSING', 'neither script survived a reload', ev);
  },

  async J3(page, ctx) {
    const e = await prepare(page, ctx);
    if (!e.ok) return res('MISSING', e.reason);
    const s = await startSequence(page, MAIN.marker);
    if (s.motionT == null) { await page.evaluate(() => window.__parity.sampleStop()); return res('MISSING', 'text did not start scrolling', { steps: s.steps }); }
    const T0 = s.motionT + R.j3.skipMs, T1 = T0 + R.j3.windowMs;
    for (;;) { const now = await page.evaluate(() => performance.now()); if (now > T1 + 200) break; if (now > T0 + 4000 && now < T0 + 4400) await ctx.shot(page, 'J3-scrolling'); await sleep(250); }
    await page.evaluate(() => window.__parity.sampleStop());
    const fr = await frames(page);
    const n = Math.round(R.j3.windowMs / R.j3.binMs);
    const d = [];
    for (let k = 0; k < n; k++) { const a = posAt(fr, T0 + k * R.j3.binMs), b = posAt(fr, T0 + (k + 1) * R.j3.binMs); d.push(b - a); }
    const travel = d.reduce((x, y) => x + y, 0);
    const back = Math.min(...d);
    const med = median(d), max = Math.max(...d);
    const fps = fr.filter((f) => f.t >= T0 && f.t <= T1).length / (R.j3.windowMs / 1000);
    const ev = { steps: s.steps, travelPx: round(travel, 1), medianStepPx: round(med, 2), maxStepPx: round(max, 2), minStepPx: round(back, 2), samplesPerSec: round(fps, 1) };
    const monotonic = back >= -R.j3.backTolPx;
    const noJump = med > 0 && max <= R.j3.jumpFactor * med;
    if (travel >= R.j3.minTravelPx && monotonic && noJump) return res('HAVE', `moved ${round(travel, 0)} px in 10 s, never back, biggest 0.1 s step ${round(max / med, 2)}x the median`, ev);
    if (travel >= R.j3.partialTravelPx) return res('PARTIAL', `scrolls but not smoothly: ${!monotonic ? `moved back ${round(-back, 1)} px` : ''}${!monotonic && !noJump ? '; ' : ''}${!noJump ? `biggest 0.1 s step ${med > 0 ? round(max / med, 2) + 'x' : 'vs'} median ${round(med, 2)} px` : ''}`, ev);
    return res('MISSING', `text moved only ${round(travel, 1)} px in 10 s`, ev);
  },

  async J4(page, ctx) {
    const e = await prepare(page, ctx);
    if (!e.ok) return res('MISSING', e.reason);
    let a = await locateAdjustable(page, PAT.speed, { ctx });
    if (!a || a.other) return res('MISSING', a ? `not found: speed control "${a.other.label}" is not a slider, number, list or +/- pair` : 'not found: no speed control');
    // choose the pair of settings (lo, hi = 2 x lo when possible)
    let plan;
    if (a.field) {
      const s0 = await readSetting(page, a.field);
      if (s0.kind === 'select') {
        const opts = s0.options; let best = null;
        for (let i = 0; i < opts.length; i++) for (let j = 0; j < opts.length; j++) {
          if (opts[i] == null || opts[j] == null || !(opts[i] > 0) || !(opts[j] > opts[i])) continue;
          const score = Math.abs(opts[j] / opts[i] - 2) + (i === s0.index ? 0 : 0.001);
          if (!best || score < best.score) best = { i, j, score };
        }
        if (!best) return res('MISSING', 'speed list has no two numeric options to compare', { control: a.field.label });
        plan = { lo: best.i, hi: best.j, field: true };
      } else {
        const min = s0.min ?? (s0.kind === 'range' ? 0 : -Infinity), max = s0.max ?? (s0.kind === 'range' ? 100 : Infinity), step = s0.step || 1;
        let lo = s0.value;
        if (!(lo > 0) || 2 * lo > max) { lo = Math.floor((max / 2 - (Number.isFinite(min) ? min : 0)) / step) * step + (Number.isFinite(min) ? min : 0); }
        if (!(lo > 0)) lo = Math.max(step, Number.isFinite(min) ? min : step);
        plan = { lo, hi: 2 * lo, field: true };
      }
    } else plan = { buttons: true };
    // measure at lo
    let vlo, vhi;
    const setLo = async () => {
      if (plan.field) { const c = (await locateAdjustable(page, PAT.speed, { ctx })).field; vlo = await writeSetting(page, c, plan.lo); }
      else { vlo = await readNear(page, a.inc || a.dec); }
    };
    await setLo();
    let s = await startSequence(page, MAIN.marker);
    if (s.motionT == null) { await page.evaluate(() => window.__parity.sampleStop()); return res('MISSING', 'text did not start scrolling', { steps: s.steps }); }
    const measure = async (from) => { const t1 = from + R.j4.measureMs; for (;;) { const now = await page.evaluate(() => performance.now()); if (now > t1 + 100) break; await sleep(250); } return rate(await frames(page), from, t1); };
    const rLo = await measure(s.motionT + R.j4.settleMs);
    // set hi live (same view); if that has no effect, set it again from the start
    const setHi = async (switchView) => {
      const l = await locateAdjustable(page, PAT.speed, { switchView, ctx });
      if (!l) return false;
      if (plan.field && l.field) { vhi = await writeSetting(page, l.field, plan.hi); return true; }
      if (!plan.field && l.inc) {
        const target = 2 * (vlo || 0);
        for (let k = 0; k < 60; k++) { const cur = await readNear(page, l.inc); if (cur != null && vlo != null && cur >= target) break; await click(page, l.inc); await sleep(80); }
        vhi = await readNear(page, l.inc);
        return true;
      }
      return false;
    };
    let mode = 'live';
    let rHi = null;
    if (await setHi(false)) { const t = await page.evaluate(() => performance.now()); rHi = await measure(t + R.j4.settleMs); }
    let ratio = rLo && rHi ? rHi / rLo : null;
    if (ratio == null || (ratio > R.j4.noEffect[0] && ratio < R.j4.noEffect[1]) || ratio < R.j4.stoppedBelow) {
      mode = 'restart';
      rHi = null;
      await page.evaluate(() => window.__parity.sampleStop());
      await goEditor(page);
      if (await setHi(true)) {
        s = await startSequence(page, MAIN.marker);
        if (s.motionT != null) rHi = await measure(s.motionT + R.j4.settleMs);
      }
      ratio = rLo && rHi ? rHi / rLo : null;
    }
    await page.evaluate(() => window.__parity.sampleStop());
    const settingRatio = vlo > 0 && vhi > 0 ? vhi / vlo : null;
    const ev = { control: (a.field || a.inc || a.dec).label, where: a.where, settingLo: vlo, settingHi: vhi, settingRatio: round(settingRatio, 3), pxPerSecLo: round(rLo, 1), pxPerSecHi: round(rHi, 1), ratio: round(ratio, 3), mode };
    if (!settingRatio || settingRatio <= 1) return res('MISSING', 'could not raise the speed setting', ev);
    if (ratio == null) return res('MISSING', 'speed could not be measured', ev);
    const rel = ratio / settingRatio;
    if (rel >= R.j4.band[0] && rel <= R.j4.band[1]) return res('HAVE', `setting x${round(settingRatio, 2)} gave x${round(ratio, 2)} px/s`, ev);
    if (ratio <= R.j4.noEffect[0] || ratio >= R.j4.noEffect[1]) return res('PARTIAL', `setting x${round(settingRatio, 2)} gave x${round(ratio, 2)} px/s (outside ${R.j4.band.map((b) => round(b * settingRatio, 2)).join('-')})`, ev);
    return res('MISSING', `setting x${round(settingRatio, 2)} changed nothing (x${round(ratio, 2)} px/s)`, ev);
  },

  async J5(page, ctx) {
    const e = await prepare(page, ctx);
    if (!e.ok) return res('MISSING', e.reason);
    const s = await startSequence(page, MAIN.marker);
    if (s.motionT == null) { await page.evaluate(() => window.__parity.sampleStop()); return res('MISSING', 'text did not start scrolling', { steps: s.steps }); }
    for (;;) { const now = await page.evaluate(() => performance.now()); if (now > s.motionT + R.j5.runMs) break; await sleep(100); }
    await page.evaluate(() => { const a = document.activeElement; if (a && a !== document.body && a.matches('input,textarea,select,button,[contenteditable],a,summary,[role=button]')) a.blur(); });
    const nk = await page.evaluate(() => window.__parity.keys.length);
    await page.keyboard.press('Space');
    await sleep(R.j5.partialStopMs + R.j5.stillMs + 300);
    const keys = await page.evaluate((n) => window.__parity.keys.slice(n), nk);
    const tk = keys.find((k) => k.key === ' ')?.t;
    let fr = await frames(page);
    const ev = { steps: s.steps };
    if (tk == null) { await page.evaluate(() => window.__parity.sampleStop()); return res('MISSING', 'space key not received', ev); }
    const after = fr.filter((f) => f.t >= tk && f.pos != null);
    const endT = tk + R.j5.partialStopMs + R.j5.stillMs;
    const tail = after.filter((f) => f.t >= tk + R.j5.partialStopMs && f.t <= endT);
    const rest = tail.length ? tail[tail.length - 1].pos : null;
    const stillAtEnd = tail.length > 3 && tail.every((f) => Math.abs(f.pos - rest) <= R.j5.stillPx);
    let stopAt = null;
    if (stillAtEnd) { for (const f of after) { if (f.t > endT) break; if (Math.abs(f.pos - rest) > R.j5.stillPx) stopAt = null; else if (stopAt == null) stopAt = f.t; } }
    ev.stopMs = stopAt != null ? Math.round(stopAt - tk) : null;
    if (!stillAtEnd) { await page.evaluate(() => window.__parity.sampleStop()); return res('MISSING', `space did not stop the scroll within ${R.j5.partialStopMs} ms`, ev); }
    // resume
    const nk2 = await page.evaluate(() => window.__parity.keys.length);
    await page.keyboard.press('Space');
    const tk2 = (await page.evaluate((n) => window.__parity.keys.slice(n), nk2)).find((k) => k.key === ' ')?.t;
    let resumed = null;
    const end = Date.now() + R.j5.resumeMs + 2500;
    while (Date.now() < end && resumed == null) { await sleep(250); fr = await frames(page); resumed = tk2 != null ? motionStart(fr, tk2) : null; }
    await page.evaluate(() => window.__parity.sampleStop());
    ev.resumeMs = resumed != null ? Math.round(resumed - tk2) : null;
    const resumedOk = resumed != null && resumed - tk2 <= R.j5.resumeMs;
    if (ev.stopMs <= R.j5.stopMs && resumedOk) return res('HAVE', `space stopped it in ${ev.stopMs} ms and started it again`, ev);
    return res('PARTIAL', `space stops it${ev.stopMs > R.j5.stopMs ? ` but takes ${ev.stopMs} ms (rule: ${R.j5.stopMs})` : ''}${resumedOk ? '' : `${ev.stopMs > R.j5.stopMs ? ';' : ''} space did not start it again within ${R.j5.resumeMs / 1000} s`}`, ev);
  },

  async J6(page, ctx) {
    const e = await prepare(page, ctx);
    if (!e.ok) return res('MISSING', e.reason);
    await openPrompter(page);
    const i0 = await textInfo(page, MAIN.marker);
    if (!i0.found) return res('MISSING', 'no prompter text to measure');
    const a = await locateAdjustable(page, PAT.font, { ctx });
    if (!a || a.other) return res('MISSING', a ? `not found: text size control "${a.other.label}" is not a slider, number, list or +/- pair` : 'not found: no text size control');
    let base = i0.fontPx, set = {};
    if (a.field) {
      const s0 = await readSetting(page, a.field);
      if (s0.kind === 'select') {
        const opts = s0.options; let j = -1;
        for (let k = 0; k < opts.length; k++) if (opts[k] != null && opts[k] > (opts[s0.index] ?? -Infinity) && (j < 0 || opts[k] < opts[j])) j = k;
        if (j < 0) j = Math.min(opts.length - 1, s0.index + 1);
        set.from = opts[s0.index]; set.to = await writeSetting(page, a.field, j);
      } else {
        const max = s0.max ?? (s0.kind === 'range' ? 100 : Infinity), step = s0.step || 1;
        let v = s0.value;
        if (v >= max) { const min = s0.min ?? 0; v = Math.floor(((min + max) / 2) / step) * step; await writeSetting(page, a.field, v); if (a.where !== 'view') await openPrompter(page); base = (await textInfo(page, MAIN.marker)).fontPx; }
        const to = Math.min(max, v + Math.max(step, Math.round((v * 0.5) / step) * step));
        set.from = v; set.to = await writeSetting(page, a.field, to);
      }
    } else if (a.inc) { for (let k = 0; k < R.j6.buttonClicks; k++) { await click(page, a.inc); await sleep(120); } set.clicked = `${a.inc.label} x${R.j6.buttonClicks}`; }
    else return res('MISSING', 'not found: no way to make the text larger');
    await sleep(500);
    let i1 = await textInfo(page, MAIN.marker);
    if (!i1.found || i1.fontPx <= base) { await openPrompter(page); i1 = await textInfo(page, MAIN.marker); }
    await ctx.shot(page, 'J6-larger');
    const ev = { control: (a.field || a.inc).label, where: a.where, ...set, fontBefore: base, fontAfter: i1.fontPx };
    if (i1.found && i1.fontPx >= base + R.j6.minGrowPx) return res('HAVE', `text ${base}px -> ${i1.fontPx}px`, ev);
    return res('MISSING', `text size did not grow (${base}px -> ${i1.found ? i1.fontPx + 'px' : 'not found'})`, ev);
  },

  async J7(page, ctx) {
    const e = await prepare(page, ctx);
    if (!e.ok) return res('MISSING', e.reason);
    await openPrompter(page);
    const i0 = await textInfo(page, MAIN.marker);
    if (!i0.found) return res('MISSING', 'no prompter text to check');
    const l = await locate(page, PAT.mirror, { ctx });
    if (!l) return res('MISSING', 'not found: no mirror control');
    let c = l.c;
    if (c.kind === 'label') { const sub = await page.evaluate((i) => { const el = window.__parity.el(i); return el.control ? window.__parity._els.indexOf(el.control) : -1; }, c.i); if (sub >= 0) c = (await ctrls(page)).find((x) => x.i === sub) || c; }
    if (c.kind === 'select') {
      await page.evaluate((i) => { const el = window.__parity.el(i); const k = [...el.options].findIndex((o) => /mirror|flip|on|yes|horizontal/i.test(o.text) && !/off|no|none/i.test(o.text)); if (k >= 0) { el.selectedIndex = k; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); } }, c.i);
    } else await click(page, c);
    await sleep(600);
    let i1 = await textInfo(page, MAIN.marker);
    if (!i1.found || i1.flip.flippedX === i0.flip.flippedX) { await openPrompter(page); i1 = await textInfo(page, MAIN.marker); }
    await ctx.shot(page, 'J7-mirror');
    const ev = { control: c.label, where: l.where, before: i0.flip, after: i1.found ? i1.flip : null, glyphsReversedAfter: i1.found ? i1.glyphFlip : null };
    if (i1.found && i1.flip.flippedX !== i0.flip.flippedX && (i1.flip.flippedX || i0.flip.flippedX)) return res('HAVE', 'mirror control flips the prompter text left to right', ev);
    return res('MISSING', 'prompter text not flipped left to right', ev);
  },

  async J8(page, ctx) {
    const once = async () => {
      const s = await startSequence(page, MAIN.marker, { counts: true });
      await page.evaluate(() => window.__parity.sampleStop());
      const fr = await frames(page);
      const until = s.motionT ?? Infinity;
      const seq = [];
      for (const f of fr) { if (f.t >= until) break; for (const v of f.counts || []) if (seq[seq.length - 1] !== v) seq.push(v); }
      let desc = 0;
      const distinct = [];
      for (const v of seq) if (!distinct.includes(v)) distinct.push(v);
      for (let i = 1; i < seq.length; i++) if (seq[i] < seq[i - 1]) desc++;
      return { s, seq: seq.slice(0, 20), desc, distinct: distinct.length };
    };
    const e = await prepare(page, ctx);
    if (!e.ok) return res('MISSING', e.reason);
    let r = await once();
    const ev = { steps: r.s.steps, seen: r.seq, scrolled: r.s.motionT != null };
    if (r.desc >= 1 && r.distinct >= R.j8.minValues && r.s.motionT != null) return res('HAVE', `count ${r.seq.join('-')} before scrolling`, ev);
    // second try: turn on a countdown setting if the app has one
    await page.reload({ waitUntil: 'load' }); await sleep(800);
    const e2 = await enterScript(page, MAIN);
    if (!e2.ok) return res('MISSING', 'no countdown seen', ev);
    const l = await locate(page, PAT.countdown, { ctx });
    if (!l) return res('MISSING', r.s.motionT == null ? 'text did not start scrolling; no countdown control' : 'no count before scrolling and no countdown control', ev);
    let c = l.c;
    if (c.kind === 'label') { const sub = await page.evaluate((i) => { const el = window.__parity.el(i); return el.control ? window.__parity._els.indexOf(el.control) : -1; }, c.i); if (sub >= 0) c = (await ctrls(page)).find((x) => x.i === sub) || c; }
    const st = await readSetting(page, c);
    if (c.kind === 'checkbox') { if (!c.checked) await click(page, c); }
    else if (st.kind === 'select') { const k = st.options.findIndex((x) => x === 3); await writeSetting(page, c, k >= 0 ? k : Math.min(st.options.length - 1, Math.max(1, st.index))); }
    else if (st.kind === 'range' || st.kind === 'number') await writeSetting(page, c, 3);
    else await click(page, c);
    ev.countdownControl = c.label;
    await goEditor(page);
    r = await once();
    ev.second = { steps: r.s.steps, seen: r.seq, scrolled: r.s.motionT != null };
    if (r.desc >= 1 && r.distinct >= R.j8.minValues && r.s.motionT != null) return res('HAVE', `count ${r.seq.join('-')} before scrolling, after turning on "${c.label}"`, ev);
    return res('MISSING', 'no count before scrolling', ev);
  },

  async J9(page, ctx) {
    const e = await prepare(page, ctx);
    if (!e.ok) return res('MISSING', e.reason);
    const r = await recordFlow(page, R.j9.recordMs, ctx.downloads, 'J9');
    await ctx.shot(page, 'J9-after');
    if (!r.ok) return res('MISSING', r.reason, r);
    const saved = path.join(ctx.passDir, `J9-recording${path.extname(r.file.name) || '.webm'}`);
    fs.copyFileSync(r.file.path, saved);
    const p = probe(saved);
    const ev = { ...r, file: undefined, probe: p };
    if (p.playable && p.duration >= R.j9.minSec) return res('HAVE', `${round(p.duration, 1)} s ${p.format || ''} file, plays (${p.videoFrames} frames)`, ev);
    return res('PARTIAL', `a file downloaded but ${!p.playable ? 'it does not play' : `it is ${round(p.duration, 1)} s (rule: >= ${R.j9.minSec} s)`}`, ev);
  },

  async J10(page, ctx) {
    const e = await prepare(page, ctx);
    if (!e.ok) return res('MISSING', e.reason);
    const r = await recordFlow(page, R.j10.recordMs, ctx.downloads, 'J10');
    if (!r.ok) return res('MISSING', r.reason, r);
    const saved = path.join(ctx.passDir, `J10-recording${path.extname(r.file.name) || '.webm'}`);
    fs.copyFileSync(r.file.path, saved);
    const p = probe(saved);
    const ov = p.playable ? overlayCheck(saved, p, path.join(ctx.passDir, 'J10-most-off-palette-frame.png')) : { error: 'file does not play' };
    const long = p.playable && p.duration >= R.j10.minSec;
    const clean = ov.overlay === false;
    const ev = { ...r, file: undefined, probe: p, overlay: ov };
    if (long && clean) return res('HAVE', `${round(p.duration, 1)} s recording, no added overlay`, ev);
    if (long || clean) return res('PARTIAL', long ? 'long recording works but something is drawn over the camera' : `no overlay, but the recording is ${round(p.duration, 1)} s (rule: >= ${R.j10.minSec} s)`, ev);
    return res('MISSING', `recording is ${round(p.duration, 1)} s and has something drawn over the camera`, ev);
  },

  async J11(page, ctx) {
    // runs in its own context: offline, every non-file request aborted
    const e = await prepare(page, ctx);
    if (!e.ok) return res('MISSING', `offline: ${e.reason}`, { blocked: ctx.blocked });
    const s = await startSequence(page, MAIN.marker);
    await page.evaluate(() => window.__parity.sampleStop());
    const ev = { steps: s.steps, blockedRequests: ctx.blocked.slice(0, 20) };
    if (s.motionT != null) return res('HAVE', 'loads and scrolls with the network blocked', ev);
    return res('MISSING', 'with the network blocked, the text did not scroll', ev);
  },
};

// ---------------------------------------------------------------- runner
async function runJob(browser, opts, job, passNo, passDir) {
  const ctxOpts = { viewport: VIEWPORT, deviceScaleFactor: DSF, acceptDownloads: true };
  if (opts.record) ctxOpts.recordVideo = { dir: path.join(passDir, 'video-tmp'), size: VIDEO_SIZE };
  const context = await browser.newContext(ctxOpts);
  const blocked = [];
  const requests = [];
  if (job === 'J11') {
    await context.setOffline(true);
    await context.route('**/*', (route) => { const u = route.request().url(); if (/^(file|data|blob):/i.test(u)) return route.continue(); blocked.push(scrub(u).slice(0, 120)); return route.abort('internetdisconnected'); });
  }
  await context.addInitScript(pageLib);
  const page = await context.newPage();
  const errors = [];
  const downloads = [];
  page.on('pageerror', (e) => errors.push(scrub(e.message).slice(0, 200)));
  page.on('dialog', async (d) => { try { if (d.type() === 'prompt') await d.accept(PROMPT_ANSWER); else await d.accept(); } catch (e) {} });
  page.on('request', (r) => { const u = r.url(); if (!/^(file|data|blob|about):/i.test(u)) requests.push(scrub(u).slice(0, 120)); });
  page.on('download', async (d) => { try { const p = path.join(passDir, 'downloads', `${job}-${downloads.length}-${d.suggestedFilename().replace(/[^\w.-]/g, '_')}`); fs.mkdirSync(path.dirname(p), { recursive: true }); await d.saveAs(p); downloads.push({ path: p, name: d.suggestedFilename() }); } catch (e) { errors.push(`download failed: ${e.message}`); } });
  const ctx = {
    url: opts.targetUrl, passDir, downloads, blocked,
    shot: async (pg, name) => { try { fs.mkdirSync(path.join(passDir, 'stills'), { recursive: true }); await pg.screenshot({ path: path.join(passDir, 'stills', `${name}.png`) }); } catch (e) {} },
  };
  const t = Date.now();
  let r;
  try { r = await CHECKS[job](page, ctx); }
  catch (e) { r = res('MISSING', `check error: ${scrub(e.message).split('\n')[0].slice(0, 200)}`, { checkError: true }); }
  r.seconds = Math.round((Date.now() - t) / 100) / 10;
  if (errors.length) r.pageErrors = errors.slice(0, 10);
  if (requests.length) r.networkRequests = [...new Set(requests)].slice(0, 20);
  const video = opts.record ? page.video() : null;
  await context.close();
  if (video) { try { const vp = await video.path(); fs.mkdirSync(path.join(passDir, 'video'), { recursive: true }); fs.renameSync(vp, path.join(passDir, 'video', `${job}.webm`)); } catch (e) {} }
  return JSON.parse(scrub(JSON.stringify(r)));
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  SCRUB = [[opts.targetDir + path.sep, ''], [opts.targetDir, '.'], [path.dirname(opts.out), '.'], [os.homedir(), '~'], [pathToFileURL(opts.targetDir).href, 'file://.']];
  fs.mkdirSync(opts.out, { recursive: true });
  const jobs = opts.only ? JOBS.filter((j) => opts.only.includes(j)) : JOBS;
  const started = new Date().toISOString();
  const passes = [];
  let browserVersion = '';
  for (let p = 1; p <= opts.passes; p++) {
    const passDir = path.join(opts.out, `pass-${p}`);
    fs.mkdirSync(passDir, { recursive: true });
    const browser = await chromium.launch({ headless: true, args: LAUNCH_ARGS });
    browserVersion = browser.version();
    const out = {};
    for (const j of jobs) {
      process.stdout.write(`pass ${p} ${j} ... `);
      out[j] = await runJob(browser, opts, j, p, passDir);
      console.log(`${out[j].status}  ${out[j].reason}`);
    }
    await browser.close();
    try { fs.rmSync(path.join(passDir, 'video-tmp'), { recursive: true, force: true }); } catch (e) {}
    passes.push({ pass: p, jobs: out });
  }
  // rows: the lower of the passes; H = rows HAVE in every pass
  const rows = {};
  for (const j of jobs) {
    const st = passes.map((p) => p.jobs[j].status);
    const low = st.reduce((a, b) => (RANK[b] < RANK[a] ? b : a));
    rows[j] = { status: low, passes: st, reason: passes.map((p) => p.jobs[j].reason).find((_, i) => st[i] === low) };
  }
  const H = jobs.filter((j) => rows[j].status === 'HAVE').length;
  const report = {
    tool: 'lunch-prompter-parity', version: VERSION, target: opts.targetName, started, finished: new Date().toISOString(),
    browser: `Chromium ${browserVersion} headless, ${LAUNCH_ARGS.join(' ')}`, node: process.version,
    headline: `${H} of ${jobs.length} jobs`, H, of: jobs.length, rows, passes,
    notTested: { P1: 'Voice-following scroll: MISSING by design', P2: 'Native phone app, text near the lens, floating script: MISSING (browser app)', P3: 'Cloud sync, remote control from a second device: MISSING', P4: 'AI script writer, subtitles, background removal: MISSING', P5: 'Support and updates from a developer: MISSING' },
  };
  fs.writeFileSync(path.join(opts.out, 'report.json'), JSON.stringify(report, null, 2));
  const md = [`# Parity report: ${opts.targetName}`, '', `lunch-prompter-parity ${VERSION}, ${report.browser}. ${opts.passes} passes, ${started}.`, '', `**Headline: ${H} of ${jobs.length} jobs HAVE in every pass.**`, '', '| Job | Result | Passes | Why |', '|---|---|---|---|'];
  const NAMES = { J1: 'Write or paste a script', J2: 'Save and reuse scripts', J3: 'Smooth auto-scroll', J4: 'Adjustable speed', J5: 'Play/pause by keyboard', J6: 'Font size', J7: 'Mirror mode', J8: 'Countdown before start', J9: 'Record video while reading', J10: 'No watermark, no time limit', J11: 'Works offline' };
  for (const j of jobs) md.push(`| ${j} ${NAMES[j]} | ${rows[j].status} | ${rows[j].passes.join(' / ')} | ${String(rows[j].reason).replace(/\|/g, '/')} |`);
  md.push('', '| Not in the app (by design) | |', '|---|---|');
  for (const [k, v] of Object.entries(report.notTested)) md.push(`| ${k} | ${v} |`);
  md.push('', 'Rows scored MISSING with "not found" are checked once by hand; a control found by hand that works is reported as "HAVE (found by hand)" in a separate note, never by editing this file.');
  fs.writeFileSync(path.join(opts.out, 'report.md'), md.join('\n') + '\n');
  console.log(`\n${report.headline} HAVE in every pass. Report: ${scrub(path.join(opts.out, 'report.md'))}`);
  if (opts.expect) {
    const exp = JSON.parse(fs.readFileSync(opts.expect, 'utf8'));
    let allOk = true;
    for (const p of passes) {
      let ok = 0; const miss = [];
      for (const j of jobs) { if (p.jobs[j].status === exp[j]) ok++; else miss.push(`${j} got ${p.jobs[j].status}, expected ${exp[j]}`); }
      console.log(`self-test pass ${p.pass}: ${ok}/${jobs.length} correct${miss.length ? ' (' + miss.join('; ') + ')' : ''}`);
      if (ok !== jobs.length) allOk = false;
    }
    process.exit(allOk ? 0 : 1);
  }
}

main().catch((e) => { console.error(scrub(e.stack || e.message)); process.exit(2); });
