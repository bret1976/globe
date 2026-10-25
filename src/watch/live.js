/**
 * Blackout live map, event feed, email-alert sign-up and disappearance
 * history. Everything here reads same-origin live endpoints
 * (/api/blackout/v1/live, /events, /history, /alerts) — no samples.
 * Plain 2D canvas (equirectangular), no Cesium.
 */
import './live.css';

const $ = (id) => document.getElementById(id);
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids) if (c != null) n.append(c);
  return n;
};
const COARSE = matchMedia('(pointer: coarse)').matches;
const POLL_MS = COARSE ? 8_000 : 5_000;
const COLORS = { ship: '#4fe3ff', shipDim: 'rgba(79,227,255,0.55)', plane: '#c58cff', dark: '#ff5c5c', land: '#141a24', landEdge: '#26303d', sea: '#05080d', grid: 'rgba(255,255,255,0.04)', sel: '#ffffff' };
const fmtN = (n) => (Number.isFinite(n) ? n.toLocaleString('en-US') : '—');
const ago = (ms) => {
  if (!Number.isFinite(ms)) return '—';
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400 * 2) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
};
const when = (ms) => (Number.isFinite(ms) ? new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
const dur = (min) => (!Number.isFinite(min) ? '—' : min < 60 ? `${min} min` : min < 2880 ? `${Math.floor(min / 60)} h ${min % 60} min` : `${Math.round(min / 1440)} days`);
const ll = (lat, lon) => (Number.isFinite(lat) && Number.isFinite(lon) ? `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? 'N' : 'S'} ${Math.abs(lon).toFixed(2)}°${lon >= 0 ? 'E' : 'W'}` : '—');
async function getJson(url, ms = 20_000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { cache: 'no-store', signal: ctrl.signal });
    const j = await r.json().catch(() => null);
    return { ok: r.ok, status: r.status, j };
  } catch (e) { return { ok: false, status: 0, j: null, error: e?.name === 'AbortError' ? 'timed out' : 'network error' }; } finally { clearTimeout(t); }
}

/* ------------------------------------------------------------------ map */
const map = {
  canvas: $('live-map'), ctx: null, W: 0, H: 0, dpr: 1,
  cx: 10, cy: 25, k: 0, minK: 1,
  land: null, data: null, fetchedAt: 0,
  show: { ships: true, aircraft: true, dark: true },
  hits: { ships: null, planes: null, dark: [] },
  sel: null, // { kind, id, lat, lon }
  pending: false, loading: false, lastFetchKey: '',
};

function resize() {
  const c = map.canvas;
  const r = c.getBoundingClientRect();
  map.dpr = Math.min(2, window.devicePixelRatio || 1);
  map.W = Math.max(200, r.width); map.H = Math.max(160, r.height);
  c.width = Math.round(map.W * map.dpr); c.height = Math.round(map.H * map.dpr);
  const first = !map.k;
  map.minK = Math.max(map.W / 360, map.H / 180) * 0.98;
  if (first) map.k = map.minK;
  clampView();
  schedule();
}
function clampView() {
  map.k = Math.min(400, Math.max(map.minK, map.k));
  const halfH = map.H / 2 / map.k, halfW = map.W / 2 / map.k;
  map.cy = halfH >= 90 ? 0 : Math.max(-90 + halfH, Math.min(90 - halfH, map.cy));
  map.cx = halfW >= 180 ? 0 : Math.max(-180 + halfW, Math.min(180 - halfW, map.cx));
}
const px = (lon) => (lon - map.cx) * map.k + map.W / 2;
const py = (lat) => (map.cy - lat) * map.k + map.H / 2;
const toLon = (x) => (x - map.W / 2) / map.k + map.cx;
const toLat = (y) => map.cy - (y - map.H / 2) / map.k;
function zoomAt(f, x = map.W / 2, y = map.H / 2) {
  const lon = toLon(x), lat = toLat(y);
  map.k *= f; clampView();
  map.cx = lon - (x - map.W / 2) / map.k; map.cy = lat + (y - map.H / 2) / map.k;
  clampView(); schedule(); refetchSoon();
}
function focus(lat, lon, k = 24) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
  map.k = Math.max(map.k, k); map.cx = lon; map.cy = lat; clampView(); schedule(); refetchSoon();
}

/** Dead-reckoned position for a ship / plane row. */
function dr(lon, lat, cog, sogKt, ageS, extraS) {
  if (!Number.isFinite(cog) || !Number.isFinite(sogKt) || sogKt < 0.5 || sogKt > 700) return [lon, lat];
  const t = Math.min(600, (ageS || 0) + extraS);
  const d = (sogKt * 0.514444 * t) / 111_320;
  const a = (cog * Math.PI) / 180;
  const nlat = lat + d * Math.cos(a);
  return [lon + (d * Math.sin(a)) / Math.max(0.2, Math.cos((lat * Math.PI) / 180)), nlat];
}

let raf = 0;
function schedule() { if (!raf) raf = requestAnimationFrame(() => { raf = 0; draw(); }); }

function draw() {
  const { ctx, W, H, dpr, k } = map;
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = COLORS.sea; ctx.fillRect(0, 0, W, H);
  // graticule
  ctx.strokeStyle = COLORS.grid; ctx.lineWidth = 1; ctx.beginPath();
  const step = k > 30 ? 5 : k > 8 ? 10 : 30;
  for (let lo = -180; lo <= 180; lo += step) { const x = px(lo); if (x >= 0 && x <= W) { ctx.moveTo(x, 0); ctx.lineTo(x, H); } }
  for (let la = -90; la <= 90; la += step) { const y = py(la); if (y >= 0 && y <= H) { ctx.moveTo(0, y); ctx.lineTo(W, y); } }
  ctx.stroke();
  if (map.land) {
    ctx.fillStyle = COLORS.land; ctx.strokeStyle = COLORS.landEdge; ctx.lineWidth = 0.8;
    ctx.beginPath();
    for (const ring of map.land.rings) {
      for (let i = 0; i < ring.length; i += 1) { const x = px(ring[i][0]), y = py(ring[i][1]); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); }
      ctx.closePath();
    }
    ctx.fill(); ctx.stroke();
  }
  const d = map.data;
  const extra = (Date.now() - map.fetchedAt) / 1000;
  if (d?.ships && map.show.ships) {
    const rows = d.ships.rows;
    const hx = new Float32Array(rows.length * 2);
    const big = k > 20;
    ctx.fillStyle = COLORS.shipDim;
    for (let i = 0; i < rows.length; i += 1) {
      const r = rows[i];
      const [lo, la] = big ? dr(r[1], r[2], r[3], r[4], r[5], extra) : [r[1], r[2]];
      const x = px(lo), y = py(la);
      hx[i * 2] = x; hx[i * 2 + 1] = y;
      if (x < -4 || y < -4 || x > W + 4 || y > H + 4) continue;
      const n = r[6] || 1;
      if (n > 1) { const s = Math.min(7, 1.6 + Math.log2(n) * 0.7); ctx.fillStyle = COLORS.shipDim; ctx.fillRect(x - s / 2, y - s / 2, s, s); }
      else if (big && Number.isFinite(r[3]) && r[4] > 0.5) {
        ctx.fillStyle = COLORS.ship; const a = (r[3] * Math.PI) / 180;
        ctx.beginPath(); ctx.moveTo(x + Math.sin(a) * 6, y - Math.cos(a) * 6); ctx.lineTo(x + Math.sin(a + 2.5) * 3.5, y - Math.cos(a + 2.5) * 3.5); ctx.lineTo(x + Math.sin(a - 2.5) * 3.5, y - Math.cos(a - 2.5) * 3.5); ctx.fill();
      } else { ctx.fillStyle = COLORS.ship; ctx.fillRect(x - 1, y - 1, big ? 3 : 2, big ? 3 : 2); }
    }
    map.hits.ships = hx;
  } else map.hits.ships = null;
  if (d?.aircraft && map.show.aircraft) {
    const rows = d.aircraft.rows;
    const hx = new Float32Array(rows.length * 2);
    ctx.fillStyle = COLORS.plane; ctx.strokeStyle = '#000'; ctx.lineWidth = 0.6;
    for (let i = 0; i < rows.length; i += 1) {
      const r = rows[i];
      const [lo, la] = dr(r[1], r[2], r[3], r[4], r[5], extra);
      const x = px(lo), y = py(la);
      hx[i * 2] = x; hx[i * 2 + 1] = y;
      if (x < -8 || y < -8 || x > W + 8 || y > H + 8) continue;
      const a = ((Number.isFinite(r[3]) ? r[3] : 0) * Math.PI) / 180, s = 6.5;
      ctx.beginPath(); ctx.moveTo(x + Math.sin(a) * s, y - Math.cos(a) * s); ctx.lineTo(x + Math.sin(a + 2.4) * s * 0.75, y - Math.cos(a + 2.4) * s * 0.75); ctx.lineTo(x + Math.sin(a + Math.PI) * s * 0.3, y - Math.cos(a + Math.PI) * s * 0.3); ctx.lineTo(x + Math.sin(a - 2.4) * s * 0.75, y - Math.cos(a - 2.4) * s * 0.75); ctx.closePath(); ctx.fill(); ctx.stroke();
    }
    map.hits.planes = hx;
  } else map.hits.planes = null;
  map.hits.dark = [];
  if (d?.dark && map.show.dark) {
    const pulse = (Date.now() % 2000) / 2000;
    for (const t of d.dark) {
      if (!Number.isFinite(t.lat) || !Number.isFinite(t.lon)) continue;
      const x = px(t.lon), y = py(t.lat);
      map.hits.dark.push([x, y, t]);
      if (x < -20 || y < -20 || x > W + 20 || y > H + 20) continue;
      ctx.strokeStyle = `rgba(255,92,92,${0.9 - pulse * 0.8})`; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, y, 6 + pulse * 10, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = COLORS.dark; ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 1; ctx.stroke();
      if (k > 6) { ctx.fillStyle = '#ffd0d0'; ctx.font = '11px ui-monospace, Menlo, monospace'; ctx.fillText(String(t.label || t.id).slice(0, 18), x + 9, y - 7); }
    }
  }
  if (map.sel && Number.isFinite(map.sel.lat)) {
    if (map.sel.track?.length > 1) {
      ctx.strokeStyle = 'rgba(255,255,255,0.6)'; ctx.lineWidth = 1.5; ctx.beginPath();
      map.sel.track.forEach((p, i) => { const x = px(p.lon), y = py(p.lat); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
      ctx.stroke();
    }
    const x = px(map.sel.lon), y = py(map.sel.lat);
    ctx.strokeStyle = COLORS.sel; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(x, y, 11, 0, Math.PI * 2); ctx.stroke();
  }
}

function viewQuery() {
  const kinds = ['ships', 'aircraft', 'dark'].filter((x) => map.show[x] || x === 'dark');
  const q = new URLSearchParams({ kinds: kinds.join(',') });
  if (map.k > map.minK * 1.3) {
    const pad = 0.25;
    const w = toLon(-map.W * pad), e = toLon(map.W * (1 + pad)), n = toLat(-map.H * pad), s = toLat(map.H * (1 + pad));
    q.set('bbox', [w, s, e, n].map((v) => v.toFixed(2)).join(','));
  }
  const g = 3 / map.k;
  q.set('grid', g < 0.02 ? '0' : String(2 ** Math.round(Math.log2(g))));
  return q.toString();
}

async function refresh() {
  if (map.loading || document.hidden) return;
  map.loading = true;
  const q = viewQuery();
  const r = await getJson(`/api/blackout/v1/live?${q}`);
  map.loading = false;
  $('live-loading').hidden = true;
  if (!r.ok || !r.j) { $('live-status').textContent = `Live update failed (${r.error || `HTTP ${r.status}`}) — retrying.`; return; }
  map.data = r.j; map.fetchedAt = Date.now(); map.lastFetchKey = q;
  const s = r.j.ships, a = r.j.aircraft, dk = r.j.dark || [];
  $('live-n-ships').textContent = s ? fmtN(s.total) : '';
  $('live-n-aircraft').textContent = a ? fmtN(a.total) : '';
  $('live-n-dark').textContent = fmtN(dk.length);
  const thinNote = s && s.grid > 0 && s.rows.length < s.visible ? ` · ${fmtN(s.visible)} ships in view shown as ${fmtN(s.rows.length)} dots (zoom in for all)` : '';
  $('live-status').textContent = `Updated ${new Date().toLocaleTimeString()} · ${s ? `${fmtN(s.total)} ships` : 'ships hidden'} · ${a ? `${fmtN(a.total)} military aircraft${a.snapshotAt ? ` (feed ${ago(Date.parse(a.snapshotAt))})` : ''}` : 'aircraft hidden'} · ${fmtN(dk.length)} went dark${thinNote}. Auto-updates every ${POLL_MS / 1000} s.`;
  if (s && s.total === 0 && a && a.total === 0) $('live-status').textContent += ' The server is still connecting to the feeds — positions appear within a minute or two of a restart.';
  schedule();
}
let refetchTimer = 0;
function refetchSoon() { clearTimeout(refetchTimer); refetchTimer = setTimeout(refresh, 350); }

/* --- hit test + details */
function nearest(x, y) {
  let best = null; let bd = Infinity;
  const consider = (dx, dy, lim, item) => { const dd = dx * dx + dy * dy; if (dd < lim * lim && dd < bd) { bd = dd; best = item; } };
  for (const [dx, dy, t] of map.hits.dark) consider(dx - x, dy - y, COARSE ? 22 : 16, { type: 'dark', t });
  if (best) return best;
  const P = map.hits.planes; const ar = map.data?.aircraft?.rows || [];
  if (P) for (let i = 0; i < ar.length; i += 1) consider(P[i * 2] - x, P[i * 2 + 1] - y, COARSE ? 20 : 14, { type: 'plane', r: ar[i] });
  if (best) return best;
  const S = map.hits.ships; const sr = map.data?.ships?.rows || [];
  if (S) for (let i = 0; i < sr.length; i += 1) consider(S[i * 2] - x, S[i * 2 + 1] - y, COARSE ? 18 : 12, { type: 'ship', r: sr[i] });
  return best;
}

function detailBox(title, rows, { dark = false, actions = [] } = {}) {
  const box = $('live-detail');
  const dl = el('dl');
  for (const [k, v] of rows) if (v != null && v !== '' && v !== '—') dl.append(el('dt', { text: k }), el('dd', { text: String(v) }));
  const close = el('button', { type: 'button', class: 'btn btn--sm', 'aria-label': 'Close details', onclick: () => { box.hidden = true; map.sel = null; schedule(); } }, '×');
  box.replaceChildren(el('h3', { class: dark ? 'is-dark' : '' }, el('span', { text: title }), close), dl, actions.length ? el('div', { class: 'row' }, ...actions) : null);
  box.hidden = false;
}

async function showTarget(hit) {
  if (hit.type === 'ship' && hit.r[6] > 1) {
    focus(hit.r[2], hit.r[1], map.k * 3);
    detailBox(`${fmtN(hit.r[6])} vessels here`, [['Tip', 'Zoomed in — tap a single vessel for its details.']]);
    return;
  }
  if (hit.type === 'dark') {
    const t = hit.t;
    map.sel = { lat: t.lat, lon: t.lon };
    detailBox(`${t.kind === 'ship' ? 'Ship' : 'Military aircraft'} ${t.label || t.id} — went dark`, [
      ['Status', 'Stopped reporting (inferred from silence)'], [t.kind === 'ship' ? 'MMSI' : 'Hex', t.id], ['Last seen', `${when(Date.parse(t.lastSeenAt))} (${ago(Date.parse(t.lastSeenAt))})`], ['Silent for', dur(t.silentMin)],
      ['Last position', `${ll(t.lat, t.lon)}${t.place ? ` · ${t.place}` : ''}`], ['Speed', Number.isFinite(t.speedMps) ? `${(t.speedMps * 1.943844).toFixed(1)} kt` : null], ['Heading', Number.isFinite(t.headingDeg) ? `${t.headingDeg}°` : null], ['Altitude', Number.isFinite(t.altitudeM) ? `${fmtN(t.altitudeM)} m` : null], ['Source', t.source],
    ], { dark: true });
    schedule();
    return;
  }
  const isShip = hit.type === 'ship';
  const id = hit.r[0];
  map.sel = { lat: hit.r[2], lon: hit.r[1] };
  schedule();
  detailBox(isShip ? `Vessel ${id}` : `Aircraft ${hit.r[6] || id}`, [['Loading', 'fetching details…']]);
  const r = await getJson(`/api/blackout/v1/target?kind=${isShip ? 'ship' : 'aircraft'}&id=${encodeURIComponent(id)}`);
  const past = (r.j?.history || []).map((h) => `${when(h.lastSeenAt)} · ${dur(h.darkMin)} ${h.state === 'dark' ? '(still dark)' : ''}`).join('; ');
  if (isShip) {
    const v = r.j?.vessel;
    if (!v) { detailBox(`Vessel ${id}`, [['Status', 'No longer in the live feed (no report for 30 min).']]); return; }
    map.sel = { lat: Number(v.lat), lon: Number(v.lon), track: v.track };
    schedule();
    detailBox(v.name ? String(v.name).trim() : `Vessel ${id}`, [
      ['MMSI', v.mmsi], ['IMO', v.imo || null], ['Type', v.type || null], ['Destination', v.destination ? String(v.destination).trim() : null],
      ['Speed', Number.isFinite(Number(v.speed)) ? `${Number(v.speed).toFixed(1)} kt` : null], ['Course', Number.isFinite(Number(v.course)) ? `${Math.round(v.course)}°` : null],
      ['Position', `${ll(Number(v.lat), Number(v.lon))}${r.j.place ? ` · ${r.j.place}` : ''}`], ['Last report', v.last_position_UTC ? `${when(Date.parse(v.last_position_UTC))} (${ago(Date.parse(v.last_position_UTC))})` : null],
      ['Past dark spells', past || null], ['Source', 'AISStream.io · observed'],
    ]);
  } else {
    const a = r.j?.aircraft;
    if (!a) { detailBox(`Aircraft ${id}`, [['Status', 'Not in the latest military snapshot.']]); return; }
    detailBox(`${a.label || id}`, [
      ['Hex', a.id], ['Type', a.type || null], ['Altitude', Number.isFinite(a.altitudeM) ? `${fmtN(Math.round(a.altitudeM))} m` : null], ['Speed', Number.isFinite(a.speed) ? `${Math.round(a.speed * 1.943844)} kt` : null], ['Heading', Number.isFinite(a.heading) ? `${Math.round(a.heading)}°` : null],
      ['Position', `${ll(a.lat, a.lon)}${r.j.place ? ` · ${r.j.place}` : ''}`], ['Last report', `${ago(a.at)}`], ['Past dark spells', past || null], ['Source', 'adsb.lol /v2/mil (ODbL 1.0) · observed'],
    ]);
  }
}

/* --- pointer / touch */
function initPointer() {
  const c = map.canvas;
  const pts = new Map();
  let start = null; let pinch = null;
  const pos = (e) => { const r = c.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  c.addEventListener('pointerdown', (e) => {
    c.setPointerCapture?.(e.pointerId);
    pts.set(e.pointerId, pos(e));
    if (pts.size === 1) start = { p: pos(e), t: Date.now(), cx: map.cx, cy: map.cy, moved: false };
    if (pts.size === 2) { const [a, b] = [...pts.values()]; pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), k: map.k }; if (start) start.moved = true; }
  });
  c.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, pos(e));
    if (pts.size >= 2 && pinch) {
      const [a, b] = [...pts.values()];
      const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const lon = toLon(mid[0]), lat = toLat(mid[1]);
      map.k = pinch.k * (d / Math.max(10, pinch.d)); clampView();
      map.cx = lon - (mid[0] - map.W / 2) / map.k; map.cy = lat + (mid[1] - map.H / 2) / map.k; clampView();
      schedule();
      return;
    }
    if (!start) return;
    const [x, y] = pos(e);
    const dx = x - start.p[0], dy = y - start.p[1];
    if (Math.abs(dx) + Math.abs(dy) > 6) { start.moved = true; c.classList.add('is-drag'); }
    if (start.moved) { map.cx = start.cx - dx / map.k; map.cy = start.cy + dy / map.k; clampView(); schedule(); }
  });
  const end = (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.delete(e.pointerId);
    c.classList.remove('is-drag');
    if (pts.size < 2) pinch = null;
    if (pts.size === 0 && start) {
      if (!start.moved && e.type === 'pointerup' && Date.now() - start.t < 700) {
        const [x, y] = pos(e); const hit = nearest(x, y);
        if (hit) showTarget(hit);
      } else refetchSoon();
      start = null;
    } else if (pts.size === 1) { const p = [...pts.values()][0]; start = { p, t: Date.now(), cx: map.cx, cy: map.cy, moved: true }; }
  };
  c.addEventListener('pointerup', end); c.addEventListener('pointercancel', end);
  c.addEventListener('wheel', (e) => { e.preventDefault(); const [x, y] = pos(e); zoomAt(Math.exp(-Math.max(-300, Math.min(300, e.deltaY)) * 0.002), x, y); }, { passive: false });
  // iOS Safari: stop the page's own pinch-zoom gesture over the map.
  c.addEventListener('gesturestart', (e) => e.preventDefault());
  $('live-zoom-in').addEventListener('click', () => zoomAt(2));
  $('live-zoom-out').addEventListener('click', () => zoomAt(0.5));
  $('live-world').addEventListener('click', () => { map.k = map.minK; map.cx = 10; map.cy = 25; clampView(); schedule(); refetchSoon(); });
  for (const b of document.querySelectorAll('[data-live]')) {
    b.addEventListener('click', () => {
      const key = b.dataset.live; map.show[key] = !map.show[key]; b.setAttribute('aria-pressed', String(map.show[key])); schedule(); refetchSoon();
    });
  }
}

function initMap() {
  if (!map.canvas) return;
  map.ctx = map.canvas.getContext('2d');
  new ResizeObserver(resize).observe(map.canvas);
  resize();
  initPointer();
  fetch('/watch/land-110m.json').then((r) => (r.ok ? r.json() : null)).then((j) => { map.land = j; schedule(); }).catch(() => {});
  refresh();
  setInterval(refresh, POLL_MS);
  setInterval(() => { if (!document.hidden) schedule(); }, 1000);
  setInterval(() => { if (!document.hidden && map.data?.dark?.length) schedule(); }, 250);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
}
window.__blackoutLive = { focus, map };

/* --------------------------------------------------------------- events */
const feed = { lastId: null, items: [], es: null, failures: 0, pollTimer: 0 };
function eventLi(ev, isNew) {
  const li = el('li', { class: `event event--${ev.type}${isNew ? ' is-new' : ''}`, 'data-id': ev.id });
  const meta = el('div', { class: 'event__m' }, el('time', { datetime: new Date(ev.at).toISOString(), title: when(ev.at), text: ago(ev.at) }));
  if (Number.isFinite(ev.lat) && Number.isFinite(ev.lon)) meta.append(el('button', { type: 'button', onclick: () => { focus(ev.lat, ev.lon, 20); $('live').scrollIntoView({ behavior: 'smooth', block: 'start' }); } }, 'Show on map'));
  li.append(el('span', { class: 'event__ico', 'aria-hidden': 'true' }), el('span', { class: 'event__t', text: ev.text }), meta);
  return li;
}
function renderFeed(newOnes = []) {
  const list = $('events-list');
  if (!feed.items.length) {
    list.replaceChildren(el('li', { class: 'empty' }, el('strong', { text: 'No events yet. ' }), 'Nothing has gone dark or reappeared since the server started keeping this feed. The detector needs about 20 minutes after a restart; new events appear here live.'));
    return;
  }
  const ids = new Set(newOnes.map((e) => e.id));
  list.replaceChildren(...feed.items.slice(0, 100).map((e) => eventLi(e, ids.has(e.id))));
}
function addEvents(evs) {
  const fresh = evs.filter((e) => !feed.items.some((x) => x.id === e.id));
  if (!fresh.length) return;
  feed.items = [...fresh, ...feed.items].sort((a, b) => Number(b.id) - Number(a.id)).slice(0, 300);
  feed.lastId = feed.items[0].id;
  renderFeed(fresh);
}
async function pollEvents() {
  const r = await getJson(`/api/blackout/v1/events?limit=100${feed.lastId ? `&since=${feed.lastId}` : ''}`);
  if (r.ok && r.j) { addEvents(r.j.events || []); if (!feed.items.length) renderFeed(); return true; }
  return false;
}
function startStream() {
  if (!('EventSource' in window)) return startPolling();
  const es = new EventSource(`/api/blackout/v1/events/stream${feed.lastId ? `?since=${feed.lastId}` : ''}`);
  feed.es = es;
  es.addEventListener('open', () => { feed.failures = 0; $('events-state').textContent = 'Live — new events appear as they happen.'; });
  es.addEventListener('activity', (m) => { try { addEvents([JSON.parse(m.data)]); } catch { /* ignore */ } });
  es.addEventListener('error', () => {
    feed.failures += 1;
    if (feed.failures >= 3) { es.close(); feed.es = null; startPolling(); } else $('events-state').textContent = 'Reconnecting…';
  });
}
function startPolling() {
  $('events-state').textContent = 'Live (checking every 15 s).';
  clearInterval(feed.pollTimer);
  feed.pollTimer = setInterval(() => { if (!document.hidden) pollEvents(); }, 15_000);
}
async function initEvents() {
  if (!$('events-list')) return;
  const ok = await pollEvents();
  if (!ok) $('events-list').replaceChildren(el('li', { class: 'empty empty--error', text: 'Could not load events — retrying.' }));
  startStream();
  setInterval(() => { for (const t of document.querySelectorAll('#events-list time')) { const iso = t.dateTime; t.textContent = ago(Date.parse(iso)); } }, 30_000);
}

/* --------------------------------------------------------------- alerts */
async function initAlerts() {
  const form = $('alerts-form');
  if (!form) return;
  const r = await getJson('/api/blackout/v1/alerts');
  const areas = r.j?.areas || [];
  $('alerts-areas').replaceChildren(...areas.map((a) => el('label', { class: 'check' }, el('input', { type: 'checkbox', name: 'areas', value: a.id }), ` ${a.name}`)));
  const histArea = $('hist-area');
  for (const a of areas) histArea.append(el('option', { value: a.id, text: a.name }));
  if (r.j?.mail && r.j.mail.mode !== 'live') {
    const n = $('alerts-mode');
    n.textContent = 'Email sending is not switched on yet. You can sign up now; your confirmation mail goes out once sending is enabled (unconfirmed sign-ups are deleted after 48 hours).';
    n.hidden = false;
  }
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = $('alerts-msg'); const btn = $('alerts-submit');
    const fd = new FormData(form);
    const email = String(fd.get('email') || '').trim();
    msg.className = 'alerts-msg';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { msg.textContent = 'Please enter a valid email address.'; msg.classList.add('is-err'); $('alerts-email').focus(); return; }
    const types = fd.getAll('types');
    if (!types.length) { msg.textContent = 'Pick at least one kind of alert.'; msg.classList.add('is-err'); return; }
    btn.disabled = true; btn.textContent = 'Sending…';
    try {
      const res = await fetch('/api/blackout/v1/alerts/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, types, areas: fd.getAll('areas'), website: fd.get('website') || '' }) });
      const j = await res.json().catch(() => ({}));
      msg.textContent = j.message || (res.ok ? 'Saved.' : `Sign-up failed (HTTP ${res.status}).`);
      msg.classList.add(res.ok && j.ok ? 'is-ok' : 'is-err');
      if (res.ok && j.ok) form.reset();
    } catch { msg.textContent = 'Network error — please try again.'; msg.classList.add('is-err'); } finally { btn.disabled = false; btn.textContent = 'Subscribe'; }
  });
}

/* -------------------------------------------------------------- history */
let histTimer = 0;
function histQuery(format) {
  const fd = new FormData($('hist-filters'));
  const q = new URLSearchParams();
  for (const [k, v] of fd) if (v && v !== 'all') q.set(k, String(v));
  if (format) q.set('format', format);
  return q.toString();
}
async function loadHistory() {
  $('hist-csv').href = `/api/blackout/v1/history?${histQuery('csv')}`;
  $('hist-geojson').href = `/api/blackout/v1/history?${histQuery('geojson')}`;
  const r = await getJson(`/api/blackout/v1/history?${histQuery()}&limit=300`);
  const body = $('hist-body');
  if (!r.ok || !r.j) { body.replaceChildren(el('tr', {}, el('td', { colspan: '5', class: 'empty empty--error', text: 'Could not load history — retrying shortly.' }))); return; }
  const rows = r.j.rows || [];
  const countText = r.j.total ? `${fmtN(r.j.total)} disappearance${r.j.total === 1 ? '' : 's'} match${r.j.total === 1 ? 'es' : ''}${rows.length < r.j.total ? ` — newest ${fmtN(rows.length)} shown; the export has all of them` : ''}.` : '';
  $('hist-count').textContent = countText;
  if (!rows.length) {
    const filtered = histQuery() !== '';
    body.replaceChildren(el('tr', {}, el('td', { colspan: '5', class: 'empty' }, el('strong', { text: filtered ? 'Nothing matches these filters. ' : 'No disappearances recorded yet. ' }), filtered ? 'Try a wider area or time range.' : 'The history starts from the detectors’ saved 24-hour logs and grows with every new flag.')));
    return;
  }
  body.replaceChildren(...rows.map((h) => el('tr', {},
    el('td', { 'data-label': 'Target' }, el('button', { type: 'button', class: 'linkish', onclick: () => { focus(h.lat, h.lon, 20); map.sel = { lat: h.lat, lon: h.lon }; $('live').scrollIntoView({ behavior: 'smooth', block: 'start' }); } }, `${h.kind === 'ship' ? '🚢' : '✈'} ${h.label || h.id}`), el('div', { class: 'dim', text: `${h.kind === 'ship' ? 'MMSI' : 'hex'} ${h.id}` })),
    el('td', { 'data-label': 'Last seen' }, el('span', { text: when(h.lastSeenAt) }), el('div', { class: 'dim', text: ago(h.lastSeenAt) })),
    el('td', { 'data-label': 'Where' }, el('span', { text: h.place || '—' }), el('div', { class: 'dim', text: ll(h.lat, h.lon) })),
    el('td', { 'data-label': 'Dark for', text: `${dur(h.darkMin)}${h.state === 'dark' ? ' so far' : ''}` }),
    el('td', { 'data-label': 'Status' }, el('span', { class: `st st--${h.state}`, text: h.state === 'dark' ? 'Still dark' : `Back ${ago(h.reappearedAt)}` })),
  )));
}
function initHistory() {
  const f = $('hist-filters');
  if (!f) return;
  f.addEventListener('submit', (e) => { e.preventDefault(); loadHistory(); });
  f.addEventListener('input', () => { clearTimeout(histTimer); histTimer = setTimeout(loadHistory, 300); });
  f.addEventListener('change', () => { clearTimeout(histTimer); histTimer = setTimeout(loadHistory, 50); });
  loadHistory();
  setInterval(() => { if (!document.hidden) loadHistory(); }, 60_000);
}

initMap();
initEvents();
initAlerts();
initHistory();
