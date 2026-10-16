/* SkyNotes: offline-first handwriting notes for iPad.
   Storage: IndexedDB (records store). Each record = notebook or page.
   Sync: see sync.js (Supabase REST, last-writer-wins per record). */
'use strict';

const PAGE_W = 1000, PAGE_H = 1294;          // US Letter ratio, page units
const MAX_PAGE_CSS_W = 920;
const LIVE_MARGIN = '1200px';                // render canvases this far outside viewport

const PEN_COLORS = ['#1d2433', '#2357c6', '#d03232', '#23864a'];
const HL_COLORS  = ['#ffe14d', '#8de08a', '#ff9ecb', '#8ccfff'];
const PEN_SIZES  = [1.6, 2.6, 4.2];
const HL_SIZES   = [14, 22, 32];
const TEXT_SIZES = [18, 24, 32];
const ERASER_SIZES = [8, 16, 30];
const COVER_COLORS = ['#2357c6', '#1f3b57', '#c0392b', '#23864a', '#8e44ad', '#e67e22', '#6d6d6d', '#b8860b'];
const PAPERS = { blank: 'Blank', lined: 'Lined', grid: 'Grid', dots: 'Dotted' };

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
const now = () => Date.now();
const $ = s => document.querySelector(s);
const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ---------------- IndexedDB ---------------- */
const DB = {
  db: null,
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('skynotes', 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        const s = d.createObjectStore('records', { keyPath: 'id' });
        s.createIndex('kind', 'kind');
        d.createObjectStore('meta');
      };
      r.onsuccess = () => { DB.db = r.result; res(); };
      r.onerror = () => rej(r.error);
    });
  },
  tx(store, mode, fn) {
    return new Promise((res, rej) => {
      const t = DB.db.transaction(store, mode);
      const out = fn(t.objectStore(store));
      t.oncomplete = () => res(out && 'result' in out ? out.result : out);
      t.onerror = () => rej(t.error);
    });
  },
  get: id => DB.tx('records', 'readonly', s => s.get(id)),
  all: () => DB.tx('records', 'readonly', s => s.getAll()),
  byKind: k => DB.tx('records', 'readonly', s => s.index('kind').getAll(k)),
  put: rec => DB.tx('records', 'readwrite', s => { s.put(rec); }),
  putMany: recs => DB.tx('records', 'readwrite', s => { recs.forEach(r => s.put(r)); }),
  getMeta: k => DB.tx('meta', 'readonly', s => s.get(k)),
  setMeta: (k, v) => DB.tx('meta', 'readwrite', s => { s.put(v, k); }),
};

/* Save a record locally and flag it for sync. */
async function saveRecord(rec) {
  rec.updated = now();
  rec.dirty = 1;
  await DB.put(rec);
  if (window.Sync) Sync.schedule();
}

/* ---------------- App state ---------------- */
const prefs = Object.assign({
  tool: 'pen', penColor: PEN_COLORS[0], penSize: PEN_SIZES[1],
  hlColor: HL_COLORS[0], hlSize: HL_SIZES[1], textSize: TEXT_SIZES[1], textColor: PEN_COLORS[0],
  eraserSize: ERASER_SIZES[1], fingerDraw: false,
}, JSON.parse(localStorage.getItem('skynotes.prefs') || '{}'));
const savePrefs = () => localStorage.setItem('skynotes.prefs', JSON.stringify(prefs));

const state = {
  notebook: null,        // current notebook record
  pages: new Map(),      // pageId -> page record
  views: new Map(),      // pageId -> {wrap, canvas, ctx, texts, live}
  scale: 1,
  undo: [], redo: [],
  saveTimers: new Map(),
  drawing: null,
  currentPageIdx: 0,
};

/* ---------------- Rendering ---------------- */
function drawPaper(ctx, paper, scale) {
  ctx.fillStyle = '#fffef9';
  ctx.fillRect(0, 0, PAGE_W, PAGE_H);
  const hair = 1 / scale;
  if (paper === 'lined') {
    ctx.strokeStyle = '#c9d6ea'; ctx.lineWidth = hair;
    ctx.beginPath();
    for (let y = 130; y < PAGE_H - 30; y += 34) { ctx.moveTo(0, y); ctx.lineTo(PAGE_W, y); }
    ctx.stroke();
    ctx.strokeStyle = '#f0b7b7'; ctx.beginPath(); ctx.moveTo(90, 0); ctx.lineTo(90, PAGE_H); ctx.stroke();
  } else if (paper === 'grid') {
    ctx.strokeStyle = '#dde3ec'; ctx.lineWidth = hair;
    ctx.beginPath();
    for (let x = 25; x < PAGE_W; x += 25) { ctx.moveTo(x, 0); ctx.lineTo(x, PAGE_H); }
    for (let y = 22; y < PAGE_H; y += 25) { ctx.moveTo(0, y); ctx.lineTo(PAGE_W, y); }
    ctx.stroke();
  } else if (paper === 'dots') {
    ctx.fillStyle = '#b9c0cc';
    const r = 1.6 / Math.max(scale, .5);
    for (let x = 25; x < PAGE_W; x += 25) for (let y = 22; y < PAGE_H; y += 25) {
      ctx.fillRect(x - r / 2, y - r / 2, r, r);
    }
  }
}

const penWidth = (w, p) => w * (0.35 + p * 1.3);

function drawStroke(ctx, s) {
  const P = s.pts, n = P.length / 3;
  if (!n) return;
  ctx.save();
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.strokeStyle = s.c; ctx.fillStyle = s.c;
  if (s.t === 'hl') {
    ctx.globalAlpha = 0.4;
    ctx.globalCompositeOperation = 'multiply';
    ctx.lineCap = 'butt'; ctx.lineJoin = 'round';
    ctx.lineWidth = s.w;
    ctx.beginPath();
    ctx.moveTo(P[0], P[1]);
    if (n === 1) ctx.lineTo(P[0] + 0.1, P[1]);
    for (let i = 1; i < n - 1; i++) {
      const mx = (P[i * 3] + P[i * 3 + 3]) / 2, my = (P[i * 3 + 1] + P[i * 3 + 4]) / 2;
      ctx.quadraticCurveTo(P[i * 3], P[i * 3 + 1], mx, my);
    }
    if (n > 1) ctx.lineTo(P[(n - 1) * 3], P[(n - 1) * 3 + 1]);
    ctx.stroke();
    ctx.restore();
    return;
  }
  if (n === 1) {
    ctx.beginPath(); ctx.arc(P[0], P[1], penWidth(s.w, P[2]) / 2, 0, Math.PI * 2); ctx.fill();
    ctx.restore(); return;
  }
  let sx = P[0], sy = P[1];
  for (let i = 1; i < n; i++) {
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    const x = P[i * 3], y = P[i * 3 + 1], p = P[i * 3 + 2];
    ctx.lineWidth = penWidth(s.w, (p + P[(i - 1) * 3 + 2]) / 2);
    if (i < n - 1) {
      const mx = (x + P[i * 3 + 3]) / 2, my = (y + P[i * 3 + 4]) / 2;
      ctx.quadraticCurveTo(x, y, mx, my);
      sx = mx; sy = my;
    } else {
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  ctx.restore();
}

function renderPageToCtx(ctx, page, paper, scale) {
  drawPaper(ctx, paper, scale);
  for (const s of page.strokes) if (s.t === 'hl') drawStroke(ctx, s);
  for (const s of page.strokes) if (s.t !== 'hl') drawStroke(ctx, s);
}

function renderPage(pageId) {
  const v = state.views.get(pageId), page = state.pages.get(pageId);
  if (!v || !v.canvas || !page) return;
  const dpr = window.devicePixelRatio || 1;
  const k = state.scale * dpr;
  v.ctx.setTransform(k, 0, 0, k, 0, 0);
  renderPageToCtx(v.ctx, page, state.notebook.paper || 'lined', state.scale * dpr);
  renderTexts(pageId);
}

function renderTexts(pageId) {
  const v = state.views.get(pageId), page = state.pages.get(pageId);
  if (!v) return;
  const active = document.activeElement;
  const keep = active && active.classList.contains('tbox') && v.texts.contains(active) ? active.dataset.id : null;
  [...v.texts.children].forEach(c => { if (c.dataset.id !== keep) c.remove(); });
  for (const t of page.texts || []) {
    if (t.id === keep) { positionTbox(v.texts.querySelector(`[data-id="${t.id}"]`), t); continue; }
    v.texts.appendChild(makeTbox(pageId, t));
  }
}

function positionTbox(d, t) {
  const sc = state.scale;
  d.style.left = (t.x * sc) + 'px';
  d.style.top = (t.y * sc) + 'px';
  d.style.fontSize = (t.s * sc) + 'px';
  d.style.color = t.c;
  d.style.maxWidth = ((PAGE_W - t.x - 20) * sc) + 'px';
}

function makeTbox(pageId, t) {
  const d = el('div', 'tbox');
  d.dataset.id = t.id;
  d.contentEditable = 'true';
  d.spellcheck = true;
  d.innerText = t.v || '';
  positionTbox(d, t);
  d.addEventListener('input', () => {
    t.v = d.innerText;
    queueSave(pageId);
  });
  d.addEventListener('blur', () => {
    const page = state.pages.get(pageId);
    if (!d.innerText.trim()) {
      page.texts = page.texts.filter(x => x.id !== t.id);
      d.remove();
      queueSave(pageId);
    }
  });
  return d;
}

/* ---------------- Library ---------------- */
async function showLibrary() {
  await flushSaves();
  state.notebook = null;
  $('#editor').classList.add('hidden');
  $('#library').classList.remove('hidden');
  teardownEditor();
  const grid = $('#notebookGrid');
  grid.innerHTML = '';
  const nbs = (await DB.byKind('notebook')).filter(n => !n.deleted).sort((a, b) => b.updated - a.updated);
  $('#emptyHint').classList.toggle('hidden', nbs.length > 0);
  for (const nb of nbs) {
    const item = el('div', 'nb');
    const cover = el('div', 'cover');
    cover.style.background = nb.color || COVER_COLORS[0];
    cover.appendChild(el('div', 'spine'));
    const thumb = document.createElement('canvas');
    thumb.width = 224; thumb.height = 290;
    thumb.style.cssText = 'position:absolute;left:24px;top:14px;width:112px;height:145px;border-radius:3px;box-shadow:0 1px 3px rgba(0,0,0,.2)';
    cover.appendChild(thumb);
    item.appendChild(cover);
    item.appendChild(el('div', 'name', nb.title));
    const count = (nb.pageOrder || []).length;
    item.appendChild(el('div', 'meta', `${count} page${count === 1 ? '' : 's'} · ${new Date(nb.updated).toLocaleDateString()}`));
    cover.addEventListener('click', () => openNotebook(nb.id));
    let pressTimer;
    item.addEventListener('contextmenu', e => { e.preventDefault(); notebookMenu(nb); });
    cover.addEventListener('touchstart', () => { pressTimer = setTimeout(() => notebookMenu(nb), 550); }, { passive: true });
    cover.addEventListener('touchend', () => clearTimeout(pressTimer));
    cover.addEventListener('touchmove', () => clearTimeout(pressTimer));
    const more = el('button', 'tb', '⋯');
    more.style.height = '28px';
    more.addEventListener('click', e => { e.stopPropagation(); notebookMenu(nb); });
    item.appendChild(more);
    grid.appendChild(item);
    // thumbnail of first page
    const firstId = (nb.pageOrder || [])[0];
    if (firstId) DB.get(firstId).then(p => {
      if (!p) return;
      const c = thumb.getContext('2d');
      const k = thumb.width / PAGE_W;
      c.setTransform(k, 0, 0, k, 0, 0);
      renderPageToCtx(c, p, nb.paper || 'lined', k);
      c.fillStyle = '#1d2433';
      for (const t of p.texts || []) {
        c.font = `${t.s}px -apple-system, Helvetica, sans-serif`;
        (t.v || '').split('\n').forEach((line, i) => c.fillText(line, t.x + 4, t.y + t.s * (1.05 + i * 1.3)));
      }
    });
  }
}

async function newNotebook() {
  const title = await prompt2('New notebook', 'Title', 'Flight Lessons');
  if (title == null) return;
  const pageId = uid();
  const page = { id: pageId, kind: 'page', notebookId: null, strokes: [], texts: [], created: now() };
  const nb = {
    id: uid(), kind: 'notebook', title: title.trim() || 'Untitled', paper: 'lined',
    color: COVER_COLORS[Math.floor(Math.random() * COVER_COLORS.length)],
    pageOrder: [pageId], created: now(),
  };
  page.notebookId = nb.id;
  await saveRecord(page);
  await saveRecord(nb);
  openNotebook(nb.id);
}

function notebookMenu(nb) {
  sheet(`<h3>${esc(nb.title)}</h3>
    <button class="item" data-a="rename">Rename</button>
    <button class="item" data-a="cover">Cover color</button>
    <button class="item" data-a="paper">Paper style</button>
    <button class="item" data-a="pdf">Export as PDF</button>
    <button class="item danger" data-a="delete">Delete notebook</button>
    <div class="row"><button class="btn" data-a="close">Close</button></div>`, async a => {
    if (a === 'rename') {
      const t = await prompt2('Rename notebook', 'Title', nb.title);
      if (t != null) { nb.title = t.trim() || nb.title; await saveRecord(nb); }
      showLibrary();
    } else if (a === 'cover') {
      pickCover(nb);
    } else if (a === 'paper') {
      pickPaper(nb, showLibrary);
    } else if (a === 'pdf') {
      closeSheet(); exportPdf(nb);
    } else if (a === 'delete') {
      if (await confirm2(`Delete “${nb.title}”? This removes it from all devices.`)) {
        nb.deleted = true; await saveRecord(nb);
        for (const pid of nb.pageOrder || []) { const p = await DB.get(pid); if (p) { p.deleted = true; await saveRecord(p); } }
      }
      showLibrary();
    } else closeSheet();
  });
}

function pickCover(nb) {
  const btns = COVER_COLORS.map(c => `<button data-a="${c}" style="background:${c}" class="${c === nb.color ? 'active' : ''}"></button>`).join('');
  sheet(`<h3>Cover color</h3><div class="colorpick">${btns}</div><div class="row"><button class="btn" data-a="close">Done</button></div>`, async a => {
    if (a !== 'close') { nb.color = a; await saveRecord(nb); }
    closeSheet(); showLibrary();
  });
}

function pickPaper(nb, after) {
  const items = Object.entries(PAPERS).map(([k, v]) => `<button class="item" data-a="${k}">${v}${(nb.paper || 'lined') === k ? ' ✓' : ''}</button>`).join('');
  sheet(`<h3>Paper style</h3>${items}<div class="row"><button class="btn" data-a="close">Cancel</button></div>`, async a => {
    closeSheet();
    if (a !== 'close') { nb.paper = a; await saveRecord(nb); }
    after && after();
  });
}

/* ---------------- Editor ---------------- */
let observer = null;

async function openNotebook(id) {
  const nb = await DB.get(id);
  if (!nb) return;
  state.notebook = nb;
  state.pages.clear();
  state.undo = []; state.redo = [];
  // repair: drop missing pages, ensure at least one
  const pages = [];
  for (const pid of nb.pageOrder || []) {
    const p = await DB.get(pid);
    if (p && !p.deleted) { p.texts = p.texts || []; p.strokes = p.strokes || []; state.pages.set(pid, p); pages.push(pid); }
  }
  // pages created on another device at the same time can fall out of pageOrder: re-attach them
  for (const p of await DB.byKind('page')) {
    if (p.notebookId === nb.id && !p.deleted && !state.pages.has(p.id)) {
      p.texts = p.texts || []; p.strokes = p.strokes || []; state.pages.set(p.id, p); pages.push(p.id);
    }
  }
  if (!pages.length) {
    const p = { id: uid(), kind: 'page', notebookId: nb.id, strokes: [], texts: [], created: now() };
    await saveRecord(p); state.pages.set(p.id, p); pages.push(p.id);
  }
  if (pages.join() !== (nb.pageOrder || []).join()) { nb.pageOrder = pages; await saveRecord(nb); }
  $('#library').classList.add('hidden');
  $('#editor').classList.remove('hidden');
  $('#nbTitle').textContent = nb.title;
  buildPages();
  updateUndoButtons();
  $('#pages').scrollTop = 0;
}

function teardownEditor() {
  if (observer) { observer.disconnect(); observer = null; }
  for (const v of state.views.values()) releaseCanvas(v);
  state.views.clear();
  $('#pages').innerHTML = '';
}

function computeScale() {
  const w = Math.min($('#pages').clientWidth - 32, MAX_PAGE_CSS_W);
  state.scale = Math.max(w, 280) / PAGE_W;
}

function buildPages() {
  teardownEditor();
  computeScale();
  const container = $('#pages');
  observer = new IntersectionObserver(entries => {
    for (const e of entries) {
      const id = e.target.dataset.id;
      const v = state.views.get(id);
      if (!v) continue;
      if (e.isIntersecting) attachCanvas(v, id); else releaseCanvas(v);
    }
  }, { root: container, rootMargin: `${LIVE_MARGIN} 0px` });
  state.notebook.pageOrder.forEach((pid, i) => {
    const wrap = el('div', 'page');
    wrap.dataset.id = pid;
    wrap.style.width = (PAGE_W * state.scale) + 'px';
    wrap.style.height = (PAGE_H * state.scale) + 'px';
    const texts = el('div', 'texts');
    wrap.appendChild(texts);
    wrap.appendChild(el('div', 'pnum', `${i + 1}`));
    container.appendChild(wrap);
    const v = { wrap, texts, canvas: null, ctx: null, live: null };
    state.views.set(pid, v);
    bindPageInput(wrap, pid);
    observer.observe(wrap);
  });
  applyToolUI();
  updatePageIndicator();
}

function attachCanvas(v, id) {
  if (v.canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const c = document.createElement('canvas');
  c.width = Math.round(PAGE_W * state.scale * dpr);
  c.height = Math.round(PAGE_H * state.scale * dpr);
  v.wrap.insertBefore(c, v.texts);
  v.canvas = c; v.ctx = c.getContext('2d');
  renderPage(id);
}

function releaseCanvas(v) {
  if (!v.canvas) return;
  if (state.drawing && state.drawing.view === v) return;
  v.canvas.width = 0; v.canvas.height = 0;  // free memory on iOS
  v.canvas.remove();
  v.canvas = null; v.ctx = null;
}

function relayout() {
  if (!state.notebook) return;
  const container = $('#pages');
  const ratio = container.scrollTop / Math.max(1, container.scrollHeight);
  computeScale();
  for (const [id, v] of state.views) {
    v.wrap.style.width = (PAGE_W * state.scale) + 'px';
    v.wrap.style.height = (PAGE_H * state.scale) + 'px';
    if (v.canvas) { releaseCanvas(v); attachCanvas(v, id); }
    renderTexts(id);
  }
  container.scrollTop = ratio * container.scrollHeight;
}

/* ---- Input ---- */
function pagePoint(wrap, e) {
  const r = wrap.getBoundingClientRect();
  return [(e.clientX - r.left) / state.scale, (e.clientY - r.top) / state.scale];
}

function isDrawPointer(e) {
  if (e.pointerType === 'pen' || e.pointerType === 'mouse') return true;
  return e.pointerType === 'touch' && prefs.fingerDraw;
}

function bindPageInput(wrap, pageId) {
  // Stop Apple Pencil from scrolling the page; fingers still scroll.
  const stopStylus = e => {
    if (prefs.tool === 'text') return;
    for (const t of e.touches) if (t.touchType === 'stylus' || prefs.fingerDraw) { e.preventDefault(); return; }
  };
  wrap.addEventListener('touchstart', stopStylus, { passive: false });
  wrap.addEventListener('touchmove', stopStylus, { passive: false });

  wrap.addEventListener('pointerdown', e => {
    if (prefs.tool === 'text') return;
    if (!isDrawPointer(e) || state.drawing) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    const v = state.views.get(pageId);
    attachCanvas(v, pageId);
    wrap.setPointerCapture(e.pointerId);
    const [x, y] = pagePoint(wrap, e);
    if (prefs.tool === 'eraser') {
      state.drawing = { pointerId: e.pointerId, pageId, view: v, erase: true, removed: [], last: [x, y] };
      eraseAt(pageId, x, y, x, y);
      return;
    }
    const isHl = prefs.tool === 'highlighter';
    const stroke = {
      id: uid(), t: isHl ? 'hl' : 'pen',
      c: isHl ? prefs.hlColor : prefs.penColor,
      w: isHl ? prefs.hlSize : prefs.penSize,
      pts: [],
    };
    state.drawing = { pointerId: e.pointerId, pageId, view: v, stroke };
    addPoint(stroke, x, y, e);
    // live overlay canvas
    const live = document.createElement('canvas');
    live.width = v.canvas.width; live.height = v.canvas.height;
    live.style.pointerEvents = 'none';
    v.wrap.insertBefore(live, v.texts);
    v.live = live;
    drawLive();
  });

  wrap.addEventListener('pointermove', e => {
    const d = state.drawing;
    if (!d || d.pointerId !== e.pointerId) return;
    e.preventDefault();
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ev of (evs.length ? evs : [e])) {
      const [x, y] = pagePoint(wrap, ev);
      if (d.erase) { eraseAt(pageId, d.last[0], d.last[1], x, y); d.last = [x, y]; }
      else addPoint(d.stroke, x, y, ev);
    }
    if (!d.erase) drawLive();
  });

  const end = e => {
    const d = state.drawing;
    if (!d || d.pointerId !== e.pointerId) return;
    state.drawing = null;
    const page = state.pages.get(pageId);
    if (d.erase) {
      if (d.removed.length) pushUndo({ pageId, type: 'erase', strokes: d.removed });
      return;
    }
    if (d.view.live) { d.view.live.remove(); d.view.live = null; }
    if (d.stroke.pts.length) {
      page.strokes.push(d.stroke);
      pushUndo({ pageId, type: 'add', strokes: [d.stroke] });
      renderPage(pageId);
      queueSave(pageId);
    }
  };
  wrap.addEventListener('pointerup', end);
  wrap.addEventListener('pointercancel', end);

  // Text tool: tap to add/edit text (click = tap, so finger scrolling still works)
  wrap.addEventListener('click', e => {
    if (prefs.tool !== 'text') return;
    if (e.target.classList.contains('tbox')) return;
    const [x, y] = pagePoint(wrap, e);
    const page = state.pages.get(pageId);
    const t = { id: uid(), x: Math.max(0, x - 4), y: Math.max(0, y - prefs.textSize * 0.7), s: prefs.textSize, c: prefs.textColor, v: '' };
    page.texts.push(t);
    const v = state.views.get(pageId);
    const d = makeTbox(pageId, t);
    v.texts.appendChild(d);
    d.focus();
  });
}

function addPoint(stroke, x, y, e) {
  const p = e.pointerType === 'pen' ? Math.max(0.05, e.pressure || 0.5) : 0.5;
  const P = stroke.pts, n = P.length;
  if (n >= 3) {
    const dx = x - P[n - 3], dy = y - P[n - 2];
    if (dx * dx + dy * dy < 0.6) return;   // skip near-duplicate points
  }
  P.push(Math.round(x * 10) / 10, Math.round(y * 10) / 10, Math.round(p * 100) / 100);
}

function drawLive() {
  const d = state.drawing;
  if (!d || !d.view.live) return;
  const ctx = d.view.live.getContext('2d');
  const k = state.scale * (window.devicePixelRatio || 1);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, d.view.live.width, d.view.live.height);
  ctx.setTransform(k, 0, 0, k, 0, 0);
  drawStroke(ctx, d.stroke);
}

function distSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const L = dx * dx + dy * dy;
  let t = L ? ((px - ax) * dx + (py - ay) * dy) / L : 0;
  t = Math.max(0, Math.min(1, t));
  const qx = ax + t * dx - px, qy = ay + t * dy - py;
  return Math.sqrt(qx * qx + qy * qy);
}

function eraseAt(pageId, ax, ay, bx, by) {
  const page = state.pages.get(pageId);
  const r = prefs.eraserSize;
  const hit = [];
  for (const s of page.strokes) {
    const P = s.pts, tol = r + (s.t === 'hl' ? s.w / 2 : s.w);
    for (let i = 0; i < P.length; i += 3) {
      if (distSeg(P[i], P[i + 1], ax, ay, bx, by) < tol) { hit.push(s); break; }
    }
  }
  if (!hit.length) return;
  const ids = new Set(hit.map(s => s.id));
  page.strokes = page.strokes.filter(s => !ids.has(s.id));
  state.drawing && state.drawing.removed && state.drawing.removed.push(...hit);
  renderPage(pageId);
  queueSave(pageId);
}

/* ---- Undo ---- */
function pushUndo(op) { state.undo.push(op); if (state.undo.length > 200) state.undo.shift(); state.redo = []; updateUndoButtons(); }
function applyOp(op, inverse) {
  const page = state.pages.get(op.pageId);
  if (!page) return;
  const adding = (op.type === 'add') !== inverse;
  if (adding) page.strokes.push(...op.strokes);
  else { const ids = new Set(op.strokes.map(s => s.id)); page.strokes = page.strokes.filter(s => !ids.has(s.id)); }
  renderPage(op.pageId);
  queueSave(op.pageId);
}
function undo() { const op = state.undo.pop(); if (!op) return; applyOp(op, true); state.redo.push(op); updateUndoButtons(); }
function redo() { const op = state.redo.pop(); if (!op) return; applyOp(op, false); state.undo.push(op); updateUndoButtons(); }
function updateUndoButtons() { $('#btnUndo').disabled = !state.undo.length; $('#btnRedo').disabled = !state.redo.length; }

/* ---- Saving ---- */
function queueSave(pageId) {
  clearTimeout(state.saveTimers.get(pageId));
  state.saveTimers.set(pageId, setTimeout(() => savePage(pageId), 500));
}
async function savePage(pageId) {
  state.saveTimers.delete(pageId);
  const p = state.pages.get(pageId);
  if (p) await saveRecord(p);
}
async function flushSaves() {
  const ids = [...state.saveTimers.keys()];
  ids.forEach(id => clearTimeout(state.saveTimers.get(id)));
  for (const id of ids) await savePage(id);
}

/* ---- Pages ---- */
function currentPageIndex() {
  const c = $('#pages');
  const mid = c.scrollTop + c.clientHeight / 3;
  let idx = 0;
  state.notebook.pageOrder.forEach((pid, i) => {
    const v = state.views.get(pid);
    if (v && v.wrap.offsetTop <= mid) idx = i;
  });
  return idx;
}
let indTimer;
function updatePageIndicator() {
  if (!state.notebook) return;
  const i = currentPageIndex();
  state.currentPageIdx = i;
  const ind = $('#pageIndicator');
  ind.textContent = `${i + 1} / ${state.notebook.pageOrder.length}`;
  ind.style.opacity = 1;
  clearTimeout(indTimer);
  indTimer = setTimeout(() => ind.style.opacity = 0, 1500);
}

async function addPage(afterIdx) {
  const nb = state.notebook;
  await flushSaves();
  const p = { id: uid(), kind: 'page', notebookId: nb.id, strokes: [], texts: [], created: now() };
  await saveRecord(p);
  state.pages.set(p.id, p);
  const at = afterIdx == null ? nb.pageOrder.length : afterIdx + 1;
  nb.pageOrder.splice(at, 0, p.id);
  await saveRecord(nb);
  const top = $('#pages').scrollTop;
  buildPages();
  $('#pages').scrollTop = top;
  const v = state.views.get(p.id);
  v.wrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function deleteCurrentPage() {
  const nb = state.notebook;
  const i = currentPageIndex();
  if (!(await confirm2(`Delete page ${i + 1}?`))) return;
  const pid = nb.pageOrder[i];
  const p = state.pages.get(pid);
  p.deleted = true; await saveRecord(p);
  nb.pageOrder.splice(i, 1);
  state.pages.delete(pid);
  state.undo = state.undo.filter(o => o.pageId !== pid); state.redo = state.redo.filter(o => o.pageId !== pid);
  updateUndoButtons();
  if (!nb.pageOrder.length) {
    const np = { id: uid(), kind: 'page', notebookId: nb.id, strokes: [], texts: [], created: now() };
    await saveRecord(np); state.pages.set(np.id, np); nb.pageOrder.push(np.id);
  }
  await saveRecord(nb);
  const top = $('#pages').scrollTop;
  buildPages();
  $('#pages').scrollTop = top;
}

async function movePage(dir) {
  const nb = state.notebook, i = currentPageIndex(), j = i + dir;
  if (j < 0 || j >= nb.pageOrder.length) return;
  [nb.pageOrder[i], nb.pageOrder[j]] = [nb.pageOrder[j], nb.pageOrder[i]];
  await saveRecord(nb);
  buildPages();
  state.views.get(nb.pageOrder[j]).wrap.scrollIntoView({ block: 'start' });
}

function pageMenu() {
  const i = currentPageIndex();
  sheet(`<h3>Page ${i + 1}</h3>
    <button class="item" data-a="insert">Insert page after this one</button>
    <button class="item" data-a="up">Move page up</button>
    <button class="item" data-a="down">Move page down</button>
    <button class="item" data-a="clear">Clear page</button>
    <button class="item" data-a="paper">Paper style (whole notebook)</button>
    <button class="item" data-a="rename">Rename notebook</button>
    <button class="item" data-a="pdf">Export notebook as PDF</button>
    <button class="item danger" data-a="delete">Delete this page</button>
    <div class="row"><button class="btn" data-a="close">Close</button></div>`, async a => {
    closeSheet();
    const nb = state.notebook;
    if (a === 'insert') addPage(i);
    else if (a === 'up') movePage(-1);
    else if (a === 'down') movePage(1);
    else if (a === 'clear') {
      if (!(await confirm2('Clear all ink and text on this page?'))) return;
      const pid = nb.pageOrder[i], p = state.pages.get(pid);
      if (p.strokes.length) pushUndo({ pageId: pid, type: 'erase', strokes: p.strokes.slice() });
      p.strokes = []; p.texts = [];
      renderPage(pid); queueSave(pid);
    }
    else if (a === 'paper') pickPaper(nb, () => { for (const id of state.views.keys()) renderPage(id); });
    else if (a === 'rename') {
      const t = await prompt2('Rename notebook', 'Title', nb.title);
      if (t != null) { nb.title = t.trim() || nb.title; await saveRecord(nb); $('#nbTitle').textContent = nb.title; }
    }
    else if (a === 'pdf') { await flushSaves(); exportPdf(nb); }
    else if (a === 'delete') deleteCurrentPage();
  });
}

/* ---- Toolbar ---- */
function applyToolUI() {
  document.querySelectorAll('.tool').forEach(b => b.classList.toggle('active', b.dataset.tool === prefs.tool));
  for (const v of state.views.values()) v.wrap.classList.toggle('texting', prefs.tool === 'text');
  const colors = $('#colors'), sizes = $('#sizes');
  colors.innerHTML = ''; sizes.innerHTML = '';
  const t = prefs.tool;
  const colorList = t === 'highlighter' ? HL_COLORS : (t === 'eraser' ? [] : PEN_COLORS);
  const curColor = t === 'highlighter' ? prefs.hlColor : (t === 'text' ? prefs.textColor : prefs.penColor);
  colors.classList.toggle('hidden', !colorList.length);
  for (const c of colorList) {
    const b = el('button', 'swatch' + (c === curColor ? ' active' : ''));
    b.style.background = c;
    b.addEventListener('click', () => {
      if (t === 'highlighter') prefs.hlColor = c; else if (t === 'text') prefs.textColor = c; else prefs.penColor = c;
      savePrefs(); applyToolUI();
      if (t === 'text') { const a = document.activeElement; if (a && a.classList.contains('tbox')) recolorTbox(a, c); }
    });
    colors.appendChild(b);
  }
  const sizeList = { pen: PEN_SIZES, highlighter: HL_SIZES, text: TEXT_SIZES, eraser: ERASER_SIZES }[t];
  const curSize = { pen: prefs.penSize, highlighter: prefs.hlSize, text: prefs.textSize, eraser: prefs.eraserSize }[t];
  sizeList.forEach((s, i) => {
    const b = el('button', 'size' + (s === curSize ? ' active' : ''));
    const dot = el('i');
    const px = [5, 9, 14][i];
    dot.style.width = dot.style.height = px + 'px';
    if (t === 'eraser') { dot.style.background = 'none'; dot.style.border = '1.5px solid #1d2433'; }
    b.appendChild(dot);
    b.addEventListener('click', () => {
      ({ pen: () => prefs.penSize = s, highlighter: () => prefs.hlSize = s, text: () => prefs.textSize = s, eraser: () => prefs.eraserSize = s })[t]();
      savePrefs(); applyToolUI();
    });
    sizes.appendChild(b);
  });
}

function recolorTbox(d, c) {
  for (const [pid, p] of state.pages) {
    const t = (p.texts || []).find(x => x.id === d.dataset.id);
    if (t) { t.c = c; d.style.color = c; queueSave(pid); }
  }
}

/* ---------------- PDF export (no library: JPEG pages wrapped in a minimal PDF) ---------------- */
async function exportPdf(nb) {
  const W = 612, H = 792;                    // points (Letter)
  const pxW = 1275, pxH = 1650;              // 150 dpi
  const c = document.createElement('canvas');
  c.width = pxW; c.height = pxH;
  const ctx = c.getContext('2d');
  const k = pxW / PAGE_W;
  const images = [];
  for (const pid of nb.pageOrder) {
    const p = state.pages.get(pid) || await DB.get(pid);
    if (!p) continue;
    ctx.setTransform(k, 0, 0, k, 0, 0);
    renderPageToCtx(ctx, p, nb.paper || 'lined', k);
    for (const t of p.texts || []) {
      ctx.fillStyle = t.c || '#1d2433';
      ctx.font = `${t.s}px -apple-system, Helvetica, sans-serif`;
      const maxW = PAGE_W - t.x - 20;
      let row = 0;
      for (const para of (t.v || '').split('\n')) {
        let line = '';
        for (const word of para.split(' ')) {
          const test = line ? line + ' ' + word : word;
          if (ctx.measureText(test).width > maxW && line) { ctx.fillText(line, t.x + 4, t.y + 2 + t.s * (1.05 + row * 1.3)); row++; line = word; }
          else line = test;
        }
        ctx.fillText(line, t.x + 4, t.y + 2 + t.s * (1.05 + row * 1.3)); row++;
      }
    }
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.85));
    images.push(new Uint8Array(await blob.arrayBuffer()));
  }
  const enc = new TextEncoder();
  const parts = []; const offsets = []; let len = 0;
  const push = d => { const b = typeof d === 'string' ? enc.encode(d) : d; parts.push(b); len += b.length; };
  const obj = (n, body) => { offsets[n] = len; push(`${n} 0 obj\n`); body(); push('\nendobj\n'); };
  const nPages = images.length;
  // objects: 1 catalog, 2 pages, then per page: page, content, image
  push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  const kids = [];
  for (let i = 0; i < nPages; i++) kids.push(`${3 + i * 3} 0 R`);
  obj(1, () => push('<< /Type /Catalog /Pages 2 0 R >>'));
  obj(2, () => push(`<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${nPages} >>`));
  images.forEach((img, i) => {
    const pn = 3 + i * 3, cn = pn + 1, inum = pn + 2;
    obj(pn, () => push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /XObject << /Im${i} ${inum} 0 R >> >> /Contents ${cn} 0 R >>`));
    const content = `q ${W} 0 0 ${H} 0 0 cm /Im${i} Do Q`;
    obj(cn, () => push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`));
    obj(inum, () => { push(`<< /Type /XObject /Subtype /Image /Width ${pxW} /Height ${pxH} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${img.length} >>\nstream\n`); push(img); push('\nendstream'); });
  });
  const xref = len;
  const total = 3 + nPages * 3;
  let x = `xref\n0 ${total}\n0000000000 65535 f \n`;
  for (let i = 1; i < total; i++) x += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  push(x);
  push(`trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`);
  const file = new File(parts, `${nb.title.replace(/[^\w\- ]+/g, '').trim() || 'notebook'}.pdf`, { type: 'application/pdf' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: nb.title }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file); a.download = file.name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

/* ---------------- Sheets / dialogs ---------------- */
let sheetHandler = null;
function sheet(html, onAction) {
  $('#sheetBody').innerHTML = html;
  $('#sheet').classList.remove('hidden');
  sheetHandler = onAction;
}
function closeSheet() { $('#sheet').classList.add('hidden'); sheetHandler = null; }
$('#sheet').addEventListener('click', e => {
  if (e.target.id === 'sheet') { closeSheet(); return; }
  const b = e.target.closest('[data-a]');
  if (b && sheetHandler) {
    const h = sheetHandler;
    if (b.dataset.a === 'close') { closeSheet(); return; }
    h(b.dataset.a, b);
  }
});
function prompt2(title, label, value) {
  return new Promise(res => {
    sheet(`<h3>${esc(title)}</h3><label>${esc(label)}</label><input type="text" id="p2" value="${esc(value || '')}">
      <div class="row"><button class="btn" data-a="cancel">Cancel</button><button class="btn primary" data-a="ok">OK</button></div>`, a => {
      const v = $('#p2').value; closeSheet(); res(a === 'ok' ? v : null);
    });
    const i = $('#p2'); i.focus(); i.select();
    i.addEventListener('keydown', e => { if (e.key === 'Enter') { const v = i.value; closeSheet(); res(v); } });
  });
}
function confirm2(msg) {
  return new Promise(res => {
    sheet(`<p>${esc(msg)}</p><div class="row"><button class="btn" data-a="no">Cancel</button><button class="btn danger" data-a="yes">Delete</button></div>`, a => { closeSheet(); res(a === 'yes'); });
  });
}

/* ---------------- Settings ---------------- */
function settings() {
  const S = window.Sync;
  const signedIn = S && S.session;
  const cfg = S ? S.config() : {};
  const syncHtml = !S ? '' : signedIn ? `
      <p>Signed in as <b>${esc(S.session.user && S.session.user.email || '')}</b><br><span class="sync">${esc(S.statusText())}</span></p>
      <div class="row" style="justify-content:flex-start"><button class="btn primary" data-a="syncnow">Sync now</button><button class="btn" data-a="signout">Sign out</button></div>`
    : !cfg.url ? `<p class="sync">Sync server not configured yet.</p>
      <label>Server URL</label><input type="text" id="cfgUrl" placeholder="https://xxxx.supabase.co">
      <label>Public key</label><input type="text" id="cfgKey">
      <div class="row" style="justify-content:flex-start"><button class="btn" data-a="savecfg">Save server</button></div>`
    : `<label>Email</label><input type="email" id="sEmail" autocomplete="username">
      <label>Password</label><input type="password" id="sPass" autocomplete="current-password">
      <div class="row" style="justify-content:flex-start"><button class="btn primary" data-a="signin">Sign in</button><button class="btn" data-a="signup">Create account</button></div>
      <p class="sync" id="sMsg"></p>`;
  sheet(`<h3>Settings</h3>
    <h4 style="margin:8px 0 0">Sync</h4>${syncHtml}
    <h4 style="margin:18px 0 0">Writing</h4>
    <div class="toggle"><span>Draw with finger<br><span class="sync">Off: finger scrolls, Apple Pencil writes</span></span>
      <input type="checkbox" id="fingerDraw" ${prefs.fingerDraw ? 'checked' : ''}></div>
    <h4 style="margin:18px 0 0">Backup</h4>
    <div class="row" style="justify-content:flex-start"><button class="btn" data-a="backup">Download backup</button><button class="btn" data-a="restore">Restore backup</button></div>
    <p class="sync">SkyNotes v${APP_VERSION}</p>
    <div class="row"><button class="btn" data-a="close">Done</button></div>`, async a => {
    if (a === 'signin' || a === 'signup') {
      const email = $('#sEmail').value.trim(), pass = $('#sPass').value;
      $('#sMsg').textContent = 'Working…';
      try {
        if (a === 'signup') await S.signUp(email, pass); else await S.signIn(email, pass);
        settings(); S.run();
      } catch (e) { $('#sMsg').textContent = e.message; }
    } else if (a === 'savecfg') {
      S.setConfig($('#cfgUrl').value.trim(), $('#cfgKey').value.trim()); settings();
    } else if (a === 'signout') { S.signOut(); settings(); }
    else if (a === 'syncnow') { await S.run(true); settings(); }
    else if (a === 'backup') downloadBackup();
    else if (a === 'restore') restoreBackup();
  });
  $('#fingerDraw').addEventListener('change', e => { prefs.fingerDraw = e.target.checked; savePrefs(); });
}

async function downloadBackup() {
  const recs = (await DB.all()).map(r => { const c = Object.assign({}, r); delete c.dirty; return c; });
  const blob = new Blob([JSON.stringify({ app: 'skynotes', v: 1, at: new Date().toISOString(), records: recs })], { type: 'application/json' });
  const file = new File([blob], `skynotes-backup-${new Date().toISOString().slice(0, 10)}.json`, { type: 'application/json' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) { try { await navigator.share({ files: [file] }); return; } catch (e) { if (e.name === 'AbortError') return; } }
  const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = file.name; a.click();
}
function restoreBackup() {
  const inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.json,application/json';
  inp.onchange = async () => {
    try {
      const data = JSON.parse(await inp.files[0].text());
      if (data.app !== 'skynotes') throw new Error('Not a SkyNotes backup');
      for (const r of data.records) {
        const cur = await DB.get(r.id);
        if (!cur || (cur.updated || 0) < (r.updated || 0)) { r.dirty = 1; await DB.put(r); }
      }
      closeSheet(); showLibrary(); window.Sync && Sync.schedule();
    } catch (e) { alert('Restore failed: ' + e.message); }
  };
  inp.click();
}

/* Called by sync.js when remote changes arrive. */
window.onRemoteRecords = async recs => {
  if (!state.notebook) {
    if (!$('#library').classList.contains('hidden') && $('#sheet').classList.contains('hidden')) showLibrary();
    return;
  }
  const nb = recs.find(r => r.id === state.notebook.id);
  if (nb) {
    if (nb.deleted) { showLibrary(); return; }
    if (nb.pageOrder.join() !== state.notebook.pageOrder.join()) { await openNotebook(nb.id); return; }
    state.notebook = nb; $('#nbTitle').textContent = nb.title;
  }
  for (const r of recs) {
    if (r.kind !== 'page' || !state.pages.has(r.id)) continue;
    if (state.drawing && state.drawing.pageId === r.id) continue;
    const a = document.activeElement;
    if (a && a.classList.contains('tbox') && state.views.get(r.id)?.texts.contains(a)) continue;
    r.texts = r.texts || []; r.strokes = r.strokes || [];
    state.pages.set(r.id, r);
    renderPage(r.id);
  }
};

/* ---------------- Boot ---------------- */
const APP_VERSION = '1.0.0';

async function boot() {
  await DB.open();
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  $('#btnNewNotebook').addEventListener('click', newNotebook);
  $('#btnSettings').addEventListener('click', settings);
  $('#btnBack').addEventListener('click', showLibrary);
  $('#btnUndo').addEventListener('click', undo);
  $('#btnRedo').addEventListener('click', redo);
  $('#btnAddPage').addEventListener('click', () => addPage());
  $('#btnPageMenu').addEventListener('click', pageMenu);
  document.querySelectorAll('.tool').forEach(b => b.addEventListener('click', () => {
    prefs.tool = b.dataset.tool; savePrefs(); applyToolUI();
    if (prefs.tool !== 'text' && document.activeElement && document.activeElement.blur) document.activeElement.blur();
  }));
  $('#pages').addEventListener('scroll', updatePageIndicator, { passive: true });
  let rt; window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(relayout, 150); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) flushSaves(); });
  window.addEventListener('pagehide', () => flushSaves());
  document.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && !(document.activeElement && document.activeElement.isContentEditable)) {
      e.preventDefault(); e.shiftKey ? redo() : undo();
    }
  });
  // Block iOS double-tap zoom / gesture zoom on the toolbar and canvas
  document.addEventListener('gesturestart', e => e.preventDefault());
  await showLibrary();
  if (window.Sync) Sync.init();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}
boot();
