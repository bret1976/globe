/**
 * /watch dashboard runtime: polls same-origin endpoints (all live upstream
 * data — no samples or fixtures), and draws a 2D jamming + went-dark map.
 * Went-dark detection runs server-side (/api/ais-live/dark for ships,
 * /api/blackout/v1/aircraft for worldwide military aircraft). No Cesium.
 */
import './watch.css';
import {
  REFRESH_MS, WARMING_NOTE, feedHealth, feedStateLabel, healthBanner, wentDarkRows, wentDarkSideNote,
  jammingTimeline, historyNote, jamPoints, regionCounts, provenanceRows,
  updatedAgo, licenceFor, countNoun, formatLatLon, globeDeepLink,
  JAM_REGIONS, PLAY_SPEEDS, parseWatchHash, watchHash, stepIndexFor, viewProvenanceRows,
  viewBoxFor, projectView, regionAt, refreshDiff,
} from './model.js';
import { lastSeenText } from '../data/wentDark.js';

const FOOTER_CREDIT_KEYS = ['opensky', 'adsblol', 'aisstream', 'gpsjam'];
import { PROVENANCE_COLORS, PROVENANCE_LABELS } from '../provenance/provenance.js';

const $ = (id) => document.getElementById(id);
const CELL_NOUN = 'cell';
const LAYER_NOUN = 'layer';
const TXT = Object.freeze({
  play: 'Play', pause: 'Pause', refreshing: 'Refreshing…', justNow: 'Updated just now', noChange: 'no change',
  failed: 'Refresh failed — retrying in 30 s', loadingGlobe: 'Loading globe…', world: 'World view',
});
const STEP_MS = 1200;

const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const k of kids) if (k != null) n.append(k);
  return n;
};

async function probe(url, { timeoutMs = 15_000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
    const payload = await res.json().catch(() => null);
    const h = (n) => res.headers.get(n);
    return {
      ok: res.ok, status: res.status, payload,
      error: res.ok ? null : `HTTP ${res.status}`,
      headers: { source: h('x-flight-source'), coverage: h('x-flight-coverage'), count: h('x-flight-count') },
    };
  } catch (e) {
    return { ok: false, error: e?.name === 'AbortError' ? 'timed out' : 'network error' };
  } finally {
    clearTimeout(t);
  }
}

const url0 = parseWatchHash(location.hash);
const state = {
  probes: {}, updatedAt: null, ships: null, aircraft: null, timeline: [], stepIndex: null, playing: null,
  jamCache: new Map(), land: null, points: [], darkRows: [], recent: null,
  t: url0.t, region: url0.region, target: url0.target, speed: url0.speed, kinds: url0.kinds, sort: url0.sort,
  window: 'live', query: '', provRows: [], summary: null, refreshing: false, health: null, regions: null,
};

/* ── URL state ──────────────────────────────────────── */
function syncHash() {
  const h = watchHash(state);
  if (h !== location.hash && !(h === '' && !location.hash)) history.replaceState(null, '', `${location.pathname}${location.search}${h}`);
}

/* ── Header ─────────────────────────────────────────── */
function renderHealth(now) {
  const rows = feedHealth(state.probes, now);
  const strip = $('feeds');
  strip.replaceChildren(...rows.map((r) => el('div', { class: `feed feed--${r.state}`, role: 'listitem' },
    el('span', { class: 'feed__dot', 'aria-hidden': 'true' }),
    el('span', { class: 'feed__name', text: r.name }),
    el('span', { class: 'feed__state', text: feedStateLabel(r.state) }),
    el('span', { class: 'feed__meta', text: `${r.provider}${Number.isFinite(r.ageMs) ? ` · data ${fmtAge(r.ageMs)} old` : ''}` }),
    el('span', { class: 'feed__detail', text: r.detail || '' }),
  )));
  const banner = healthBanner(rows);
  const b = $('banner');
  b.hidden = !banner;
  if (banner) { b.className = `banner banner--${banner.level}`; $('banner-text').textContent = banner.text; }
  return rows;
}
const fmtAge = (ms) => (ms < 90_000 ? `${Math.round(ms / 1000)} s` : ms < 90 * 60_000 ? `${Math.round(ms / 60_000)} min` : ms < 48 * 3_600_000 ? `${Math.round(ms / 3_600_000)} h` : `${Math.round(ms / 86_400_000)} d`);

function renderStatus() {
  const h = state.health;
  const dot = $('status-dot');
  const s = h?.status || 'unknown';
  dot.dataset.state = s;
  dot.setAttribute('aria-label', `Service status: ${s}`);
  dot.querySelector('.status__t').textContent = s;
  const st = h?.checks?.storage;
  const onDisk = st?.mode === 'disk';
  const where = onDisk ? 'persistent volume' : 'memory only';
  const storageText = st ? `Storage: ${where} — ${st.note}` : '';
  $('storage-note').textContent = storageText;
}

/* ── Went dark ──────────────────────────────────────── */
function recentRows(now) {
  const rows = state.recent?.rows || [];
  return rows.map((r) => {
    const kind = r.kind === 'ship' ? 'ship' : 'aircraft';
    const lastAt = Date.parse(r.lastSeenAt);
    return {
      id: `${kind}:${r.id}`, kind, rawId: r.id, typeLabel: kind === 'ship' ? 'Vessel' : 'Military aircraft',
      label: r.label || r.id, lat: r.lat, lon: r.lon, lastAt,
      lastSeen: r.state === 'reappeared' ? `reappeared · was silent ${r.silentMin} min` : lastSeenText(Math.max(0, now - lastAt)),
      position: formatLatLon(r.lat, r.lon), reappeared: r.state === 'reappeared',
      href: globeDeepLink({ lat: r.lat, lon: r.lon, altM: kind === 'ship' ? 60_000 : 150_000, layers: ['went-dark', kind === 'ship' ? 'ais-live-vessels' : 'military'] }),
    };
  });
}

function renderDark(now) {
  const { rows: liveRows, ships, aircraft } = wentDarkRows(state.ships, state.aircraft, now);
  const rows = state.window === '24h' ? recentRows(now) : liveRows;
  state.darkRows = rows;
  const shipsLive = state.ships?.status === 'ok';
  const airLive = ['ok', 'partial'].includes(state.aircraft?.status);
  $('dark-ships').textContent = shipsLive ? String(ships) : '—';
  $('dark-aircraft').textContent = airLive ? String(aircraft) : '—';
  const notes = [wentDarkSideNote(state.ships, 'Ships', now), wentDarkSideNote(state.aircraft, 'Military aircraft', now)].filter(Boolean);
  if (state.aircraft?.civilNote) notes.push(`Civil aircraft: not checked — ${state.aircraft.civilNote.replace(/^Civil aircraft are not checked: /, '')}`);
  $('dark-notes').replaceChildren(...notes.map((t) => el('li', { text: t })));
  for (const a of [$('export-csv'), $('export-geojson')]) {
    const u = new URL(a.getAttribute('href'), location.origin);
    u.searchParams.set('window', state.window);
    a.setAttribute('href', `${u.pathname}?${u.searchParams}`);
  }
  const list = $('dark-list');
  if (!rows.length) {
    const failed = state.window === '24h' ? state.recent == null : !state.probes.ais?.ok && !state.probes.aircraft?.ok;
    list.replaceChildren(el('li', { class: failed ? 'empty empty--error' : 'empty' },
      failed
        ? el('strong', { text: 'Could not load the went-dark list.' })
        : el('strong', { text: state.window === '24h' ? 'Nothing went dark in the last 24 h.' : 'Nothing has gone dark.' }),
      el('span', { text: failed ? ' It will retry on the next refresh.' : ` ${WARMING_NOTE} Flags appear only when a steadily reporting, moving target falls silent while its neighbours keep reporting.` })));
    return;
  }
  list.replaceChildren(...rows.slice(0, 200).map((r) => {
    const selected = state.target === r.id;
    const li = el('li', { class: `dark dark--${r.kind}${selected ? ' is-selected' : ''}${r.reappeared ? ' is-back' : ''}`, 'data-id': r.id },
      el('button', { type: 'button', class: 'dark__pick', 'aria-pressed': String(selected), 'aria-label': `Show ${r.label} on the map`, onclick: () => selectTarget(r.id) },
        el('span', { class: 'dark__type', text: r.typeLabel }),
        el('span', { class: 'dark__label', text: r.label }),
        el('span', { class: 'dark__seen', text: r.lastSeen }),
        el('span', { class: 'dark__pos', text: r.position })),
      el('a', { class: 'dark__open', href: r.href, text: 'Open in globe', 'aria-label': `Open ${r.label} in the globe`, onclick: onGlobeLink }),
    );
    return li;
  }));
}

function selectTarget(id, { scroll = false } = {}) {
  state.target = state.target === id ? null : id;
  const r = state.darkRows.find((x) => x.id === state.target);
  if (r) {
    const reg = regionAt(r.lon, r.lat);
    state.region = reg ? reg.id : null;
  }
  syncHash();
  renderDark(Date.now());
  drawMap(state.points);
  if (scroll && state.target) document.querySelector(`.dark[data-id="${CSS.escape(state.target)}"]`)?.scrollIntoView({ block: 'nearest' });
}

/* ── Provenance ─────────────────────────────────────── */
function renderProvenance(now, health) {
  const by = Object.fromEntries(health.map((r) => [r.id, r]));
  const dark = wentDarkRows(state.ships, state.aircraft, now);
  const live = {
    flights: { count: by.flights?.count ?? null, atMs: by.flights?.atMs },
    military: { count: by.military?.count ?? null, atMs: by.military?.atMs },
    'ais-live-vessels': { count: by.ais?.count ?? null, atMs: by.ais?.atMs },
    'gps-interference': { count: state.gpsjamLatestCount ?? null, atMs: by.gpsjam?.atMs },
    'gnss-integrity': { count: state.gnssLatestCount ?? null, atMs: by.gnss?.atMs },
    'went-dark': { count: dark.rows.length, atMs: state.updatedAt },
  };
  const { rows, totals } = provenanceRows(live, now, { excludeSimulated: true });
  state.provRows = rows;
  $('prov-totals').replaceChildren(...['observed', 'inferred', 'simulated'].map((k) => el('div', { class: `total total--${k}` },
    el('span', { class: 'badge', style: `--badge:${PROVENANCE_COLORS[k]}`, text: PROVENANCE_LABELS[k] }),
    el('span', { class: 'total__n', text: String(totals[k] || 0) }),
    el('span', { class: 'total__l', text: k === 'simulated' ? `${countNoun(totals[k] || 0, LAYER_NOUN).replace(/^[\d,]+ /, '')} · excluded from Blackout` : countNoun(totals[k] || 0, LAYER_NOUN).replace(/^[\d,]+ /, '') }))));
  renderProvTable();
}

function renderProvTable() {
  const rows = viewProvenanceRows(state.provRows, { kinds: state.kinds, sort: state.sort, query: state.query });
  for (const b of document.querySelectorAll('.prov-tools .chip')) b.setAttribute('aria-pressed', String(state.kinds.includes(b.dataset.kind)));
  $('prov-sort').value = [...$('prov-sort').options].some((o) => o.value === state.sort) ? state.sort : '';
  for (const b of document.querySelectorAll('.th-sort')) {
    const th = b.closest('th');
    const [k, d] = state.sort.split(':');
    th.setAttribute('aria-sort', k === b.dataset.sort ? (d === 'desc' ? 'descending' : 'ascending') : 'none');
  }
  $('prov-shown').textContent = `${rows.length} of ${state.provRows.length} shown`;
  if (!rows.length) {
    $('prov-body').replaceChildren(el('tr', {}, el('td', { colspan: '6', class: 'empty', text: 'No layers match these filters.' })));
    return;
  }
  $('prov-body').replaceChildren(...rows.map((r) => el('tr', { class: r.excluded ? 'is-excluded' : null },
    el('th', { scope: 'row', 'data-label': 'Layer', text: r.layerId }),
    el('td', { 'data-label': 'Badge' }, el('span', { class: 'badge', style: `--badge:${PROVENANCE_COLORS[r.kind]}`, text: r.badge })),
    el('td', { 'data-label': 'Provider', text: r.provider }),
    el('td', { class: 'num', 'data-label': 'Count', text: r.count == null ? '—' : r.count.toLocaleString('en-US') }),
    el('td', { 'data-label': 'Freshness', text: r.freshness }),
    el('td', { class: 'licence', 'data-label': 'Licence', text: r.licence }),
  )));
}

/* ── Jamming + went-dark map ────────────────────────── */
const canvas = () => $('jam-map');
function drawMap(points = []) {
  state.points = points;
  const c = canvas();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = c.clientWidth || 600, h = Math.round(w / 2);
  c.style.height = `${h}px`;
  c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
  const box = viewBoxFor(state.region);
  const P = (lon, lat) => projectView(lon, lat, w, h, box);
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.fillStyle = '#070b12'; g.fillRect(0, 0, w, h);
  g.strokeStyle = 'rgba(0,212,255,0.07)'; g.lineWidth = 1;
  const grid = state.region ? 5 : 30;
  for (let lon = -180; lon <= 180; lon += grid) { const [x] = P(lon, 0); g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke(); }
  for (let lat = -90; lat <= 90; lat += grid) { const [, y] = P(0, lat); g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); }
  if (state.land) {
    g.fillStyle = 'rgba(232,234,237,0.06)'; g.strokeStyle = 'rgba(0,212,255,0.35)';
    for (const ring of state.land.rings) {
      g.beginPath();
      ring.forEach(([lon, lat], i) => { const [x, y] = P(lon, lat); i ? g.lineTo(x, y) : g.moveTo(x, y); });
      g.closePath(); g.fill(); g.stroke();
    }
  }
  const counts = regionCounts(points);
  for (const r of counts) {
    const [x0, y0] = P(r.box[0], r.box[3]);
    const [x1, y1] = P(r.box[2], r.box[1]);
    const sel = r.id === state.region;
    g.lineWidth = sel ? 2 : 1;
    g.strokeStyle = sel ? 'rgba(0,212,255,0.95)' : r.count ? 'rgba(255,181,71,0.8)' : 'rgba(255,255,255,0.18)';
    g.setLineDash([4, 3]); g.strokeRect(x0, y0, x1 - x0, y1 - y0); g.setLineDash([]);
  }
  g.lineWidth = 1;
  const rad = Math.max(1.5, w / (state.region ? 160 : 500));
  for (const p of points) {
    g.fillStyle = p.level === 'high' ? 'rgba(255,68,68,0.85)' : p.level === 'medium' ? 'rgba(255,181,71,0.8)' : 'rgba(197,140,255,0.7)';
    if (p.box) {
      const [x0, y0] = P(p.box[0], p.box[3]); const [x1, y1] = P(p.box[2], p.box[1]);
      g.fillRect(x0, y0, Math.max(2, x1 - x0), Math.max(2, y1 - y0));
    } else { const [x, y] = P(p.lon, p.lat); g.beginPath(); g.arc(x, y, rad, 0, Math.PI * 2); g.fill(); }
  }
  // Went-dark targets: white diamonds; the selected one gets a ring.
  for (const r of state.darkRows) {
    if (!Number.isFinite(r.lat) || !Number.isFinite(r.lon)) continue;
    const [x, y] = P(r.lon, r.lat);
    const s = r.id === state.target ? 6 : 4;
    g.fillStyle = r.kind === 'ship' ? '#4fe3ff' : '#ffffff';
    g.beginPath(); g.moveTo(x, y - s); g.lineTo(x + s, y); g.lineTo(x, y + s); g.lineTo(x - s, y); g.closePath(); g.fill();
    if (r.id === state.target) { g.strokeStyle = '#00d4ff'; g.lineWidth = 2; g.beginPath(); g.arc(x, y, 12, 0, Math.PI * 2); g.stroke(); g.lineWidth = 1; }
  }
  $('jam-regions').replaceChildren(...counts.map((r) => el('li', { class: `${r.count ? 'hot' : ''}${r.id === state.region ? ' is-selected' : ''}` },
    el('button', { type: 'button', class: 'region', 'aria-pressed': String(r.id === state.region), 'aria-label': `${r.name}: ${countNoun(r.count, CELL_NOUN)}. Zoom map`, onclick: () => selectRegion(r.id) },
      el('span', { text: r.name }), el('strong', { text: String(r.count) })))));
  $('jam-count').textContent = countNoun(points.length, CELL_NOUN);
  $('map-reset').hidden = !state.region;
  const sel = state.darkRows.find((x) => x.id === state.target);
  const ms = $('map-sel');
  ms.hidden = !sel && !state.region;
  ms.textContent = sel ? `Selected: ${sel.typeLabel} ${sel.label} · ${sel.position} · ${sel.lastSeen}` : state.region ? `Zoomed: ${JAM_REGIONS.find((r) => r.id === state.region)?.name}` : '';
}

function selectRegion(id) {
  state.region = state.region === id ? null : id;
  syncHash();
  drawMap(state.points);
}

function onMapClick(ev) {
  const c = canvas();
  const rect = c.getBoundingClientRect();
  const x = ev.clientX - rect.left, y = ev.clientY - rect.top;
  const w = rect.width, h = rect.height;
  const box = viewBoxFor(state.region);
  // Nearest went-dark target within 14 px wins; else a region box zooms.
  let best = null, bestD = 14 * 14;
  for (const r of state.darkRows) {
    if (!Number.isFinite(r.lat)) continue;
    const [px, py] = projectView(r.lon, r.lat, w, h, box);
    const d = (px - x) ** 2 + (py - y) ** 2;
    if (d < bestD) { best = r; bestD = d; }
  }
  if (best) return selectTarget(best.id, { scroll: true });
  const lon = box[0] + (x / w) * (box[2] - box[0]);
  const lat = box[3] - (y / h) * (box[3] - box[1]);
  const reg = regionAt(lon, lat);
  if (reg) return selectRegion(reg.id);
  if (state.region) selectRegion(state.region);
}

async function loadStep(step) {
  if (!step) return [];
  const key = `${step.kind}:${step.key}`;
  if (!state.jamCache.has(key)) {
    const url = step.kind === 'gpsjam' ? `/api/gpsjam?date=${encodeURIComponent(step.key)}` : `/api/gnss-integrity/history?at=${encodeURIComponent(step.key)}`;
    const r = await probe(url, { timeoutMs: 30_000 });
    if (!r.ok) return null;
    state.jamCache.set(key, r.payload);
    if (state.jamCache.size > 60) state.jamCache.delete(state.jamCache.keys().next().value);
  }
  return jamPoints(step, state.jamCache.get(key));
}

async function showStep(index, { fromUser = false } = {}) {
  const steps = state.timeline;
  const btns = [$('jam-prev'), $('jam-next'), $('jam-play'), $('jam-slider')];
  if (!steps.length) {
    $('jam-label').textContent = state.probes.gpsjam?.ok === false && state.probes.gnss?.ok === false ? 'Jamming history failed to load — retrying on next refresh' : 'No jamming history available yet';
    for (const b of btns) b.disabled = true;
    drawMap([]);
    return;
  }
  for (const b of btns) b.disabled = false;
  const i = Math.max(0, Math.min(steps.length - 1, index));
  state.stepIndex = i;
  $('jam-prev').disabled = i <= 0;
  $('jam-next').disabled = i >= steps.length - 1;
  const slider = $('jam-slider');
  slider.max = String(steps.length - 1); slider.value = String(i);
  slider.setAttribute('aria-valuetext', steps[i].label);
  if (fromUser || state.t) { state.t = i === steps.length - 1 && !fromUser ? state.t : steps[i].key; }
  if (fromUser) { state.t = i === steps.length - 1 ? null : steps[i].key; syncHash(); }
  $('jam-label').textContent = `${steps[i].label} — loading…`;
  $('jam-label').closest('.scrub__meta').setAttribute('aria-busy', 'true');
  $('jam-source').textContent = steps[i].kind === 'gpsjam' ? 'gpsjam.org daily H3 hexes — potential interference, not confirmed jamming' : 'adsb.lol NIC/NACp 0.5° cells — integrity anomaly, not a jamming detection';
  const pts = await loadStep(steps[i]);
  if (state.stepIndex !== i) return;
  $('jam-label').closest('.scrub__meta').setAttribute('aria-busy', 'false');
  if (pts == null) { $('jam-label').textContent = `${steps[i].label} — failed to load`; return; }
  $('jam-label').textContent = `${steps[i].label}${i === steps.length - 1 ? ' · latest' : ''}`;
  drawMap(pts);
}

function setPlaying(on) {
  const btn = $('jam-play');
  clearInterval(state.playing); state.playing = null;
  btn.textContent = on ? TXT.pause : TXT.play;
  btn.setAttribute('aria-pressed', String(on));
  if (!on) return;
  if (state.stepIndex >= state.timeline.length - 1) showStep(0, { fromUser: true });
  state.playing = setInterval(() => {
    if (state.stepIndex >= state.timeline.length - 1) return setPlaying(false);
    showStep(state.stepIndex + 1, { fromUser: true });
  }, STEP_MS / state.speed);
}
const togglePlay = () => setPlaying(!state.playing);

/* ── Refresh loop ───────────────────────────────────── */
function summarize(health) {
  return {
    darkIds: wentDarkRows(state.ships, state.aircraft, Date.now()).rows.map((r) => r.id),
    shipsTracked: state.ships?.tracked, milTracked: state.aircraft?.tracked, frames: state.probes.gnss?.payload?.frames?.length,
    feeds: Object.fromEntries(health.map((r) => [r.name, r.state])),
  };
}

let flashTimer = null;
function setBusy(on) {
  state.refreshing = on;
  const btn = $('refresh-now');
  btn.classList.toggle('is-busy', on);
  btn.setAttribute('aria-busy', String(on));
  btn.disabled = on;
  btn.querySelector('.btn__label').textContent = on ? TXT.refreshing : 'Refresh';
  if (on) { clearTimeout(flashTimer); $('refresh-state').textContent = TXT.refreshing; }
}

async function refresh({ manual = false } = {}) {
  if (state.refreshing) return;
  const busyStart = Date.now();
  setBusy(true);
  try {
    const [flights, military, ais, gpsjam, gnss, aircraft, health, recent, regions] = await Promise.all([
      probe('/api/opensky'), probe('/api/adsblol/mil'), probe('/api/ais-live/dark'),
      probe('/api/gpsjam/dates'), probe('/api/gnss-integrity/history'), probe('/api/blackout/v1/aircraft'),
      probe('/api/blackout/v1/health'), probe('/api/blackout/v1/dark?window=24h'), probe('/api/blackout/v1/regions'),
    ]);
    if (![flights, military, ais, gpsjam, gnss, aircraft, health, recent, regions].some((x) => x.ok)) window.__watchError?.('live data: every /api request failed (offline, or a content blocker such as Brave Shields)');
    const local = Date.now();
    state.probes = { flights, military, ais, gpsjam, gnss, aircraft };
    state.ships = ais.ok ? { ...ais.payload, fetchedLocalMs: local } : null;
    state.aircraft = aircraft.ok ? { ...aircraft.payload, layer: 'military', fetchedLocalMs: local } : { status: 'stale', reason: `military detector unreachable (${aircraft.error})`, flagged: [] };
    state.health = health.payload || null;
    state.recent = recent.ok ? recent.payload : null;
    state.regions = regions.ok ? regions.payload : null;
    const atEnd = state.stepIndex == null || state.stepIndex >= state.timeline.length - 1;
    state.timeline = jammingTimeline(gpsjam.ok ? gpsjam.payload.dates : [], gnss.ok ? gnss.payload.frames : []);
    const regionsPolled = state.regions?.status === 'ok';
    const gpsDates = gpsjam.ok ? gpsjam.payload.dates : [];
    const gnssHist = gnss.ok ? gnss.payload : null;
    $('jam-history').textContent = historyNote(gpsDates, gnssHist, local, { regionsPolled });
    state.updatedAt = local;
    const rows = renderHealth(local);
    renderStatus();
    renderDark(local);
    renderRegions();
    const want = stepIndexFor(state.timeline, state.t);
    if (!state.playing && want != null && state.stepIndex !== want) await showStep(want);
    else if (!state.playing && atEnd && want == null) await showStep(state.timeline.length - 1);
    else drawMap(state.points);
    const last = state.jamCache.get(`gpsjam:${gpsjam.payload?.latest}`);
    state.gpsjamLatestCount = last?.count ?? state.gpsjamLatestCount ?? null;
    const lastGnss = [...state.timeline].reverse().find((s) => s.kind === 'gnss');
    const gnssPayload = lastGnss && state.jamCache.get(`gnss:${lastGnss.key}`);
    state.gnssLatestCount = gnssPayload ? jamPoints(lastGnss, gnssPayload).length : null;
    renderProvenance(local, rows);
    const next = summarize(rows);
    const diff = refreshDiff(state.summary, next);
    state.summary = next;
    const allDown = [flights, military, ais, gpsjam, gnss].every((p) => !p.ok);
    $('refresh-state').textContent = allDown ? TXT.failed : TXT.justNow;
    const changesEl = $('changes');
    const changeText = diff.length ? diff.join(' · ') : TXT.noChange;
    const showChange = !allDown && (manual || diff.length);
    if (allDown) changesEl.textContent = '';
    else if (showChange) changesEl.textContent = `Last refresh: ${changeText}`;
    flashTimer = setTimeout(() => { if (!state.refreshing) $('refresh-state').textContent = ''; }, 4000);
  } catch (e) {
    $('refresh-state').textContent = TXT.failed;
    console.error('[blackout] refresh failed', e);
  } finally {
    const held = Date.now() - busyStart;
    if (held < 600) await new Promise((r) => setTimeout(r, 600 - held));
    setBusy(false);
    $('refresh-now').querySelector('.btn__label').textContent = 'Refresh';
  }
}

function renderRegions() {
  const list = state.regions?.regions || [];
  $('region-live').replaceChildren(...list.filter((r) => r.aircraft != null).map((r) => el('li', {
    text: `${r.name}: ${r.aircraft} aircraft within 250 nm, ${r.degraded} with degraded GNSS${Number.isFinite(r.at) ? ` · read ${fmtAge(Math.max(0, Date.now() - r.at))} ago` : ''}`,
  })));
}

function tick() {
  if (!state.refreshing && !/just now|failed/.test($('refresh-state').textContent)) $('refresh-state').textContent = '';
  $('updated').textContent = updatedAgo(state.updatedAt);
}

/** Globe links: same tab, with a visible "Loading globe…" while it opens. */
function onGlobeLink(ev) {
  if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.button === 1) return;
  const a = ev.currentTarget;
  a.classList.add('is-loading');
  a.setAttribute('aria-busy', 'true');
  a.textContent = TXT.loadingGlobe;
  $('refresh-state').textContent = TXT.loadingGlobe;
}

function applyHash() {
  const u = parseWatchHash(location.hash);
  Object.assign(state, { t: u.t, region: u.region, target: u.target, speed: u.speed, kinds: u.kinds, sort: u.sort });
  $('jam-speed').value = String(state.speed);
  const i = stepIndexFor(state.timeline, state.t);
  if (i != null) showStep(i); else drawMap(state.points);
  renderDark(Date.now());
  renderProvTable();
}

async function boot() {
  $('map-credit').textContent = 'Coastlines: Natural Earth 1:110m land (public domain).';
  $('footer-licences').textContent = FOOTER_CREDIT_KEYS.map(licenceFor).join(' · ');
  $('jam-slider').addEventListener('input', (e) => showStep(Number(e.target.value), { fromUser: true }));
  $('jam-play').addEventListener('click', togglePlay);
  $('jam-prev').addEventListener('click', () => { setPlaying(false); showStep((state.stepIndex ?? 0) - 1, { fromUser: true }); });
  $('jam-next').addEventListener('click', () => { setPlaying(false); showStep((state.stepIndex ?? 0) + 1, { fromUser: true }); });
  $('jam-speed').value = String(state.speed);
  $('jam-speed').addEventListener('change', (e) => {
    const v = Number(e.target.value);
    state.speed = PLAY_SPEEDS.includes(v) ? v : 1;
    syncHash();
    if (state.playing) setPlaying(true);
  });
  $('refresh-now').addEventListener('click', () => refresh({ manual: true }));
  $('map-reset').addEventListener('click', () => { state.region = null; syncHash(); drawMap(state.points); });
  canvas().addEventListener('click', onMapClick);
  for (const a of [$('open-globe'), ...document.querySelectorAll('.foot a[href="/"]')]) a.addEventListener('click', onGlobeLink);
  for (const b of document.querySelectorAll('.dark-tools .chip')) {
    b.addEventListener('click', () => {
      state.window = b.dataset.window;
      for (const x of document.querySelectorAll('.dark-tools .chip')) x.setAttribute('aria-checked', String(x === b));
      renderDark(Date.now()); drawMap(state.points);
    });
  }
  for (const b of document.querySelectorAll('.prov-tools .chip')) {
    b.addEventListener('click', () => {
      const k = b.dataset.kind;
      state.kinds = state.kinds.includes(k) ? state.kinds.filter((x) => x !== k) : [...state.kinds, k].sort((a, c) => ['observed', 'inferred', 'simulated'].indexOf(a) - ['observed', 'inferred', 'simulated'].indexOf(c));
      syncHash(); renderProvTable();
    });
  }
  $('prov-filter').addEventListener('input', (e) => { state.query = e.target.value; renderProvTable(); });
  $('prov-sort').addEventListener('change', (e) => { state.sort = e.target.value; syncHash(); renderProvTable(); });
  for (const b of document.querySelectorAll('.th-sort')) {
    b.addEventListener('click', () => {
      const k = b.dataset.sort;
      const [cur, dir] = state.sort.split(':');
      state.sort = cur === k ? (dir === 'desc' ? '' : `${k}:desc`) : k;
      syncHash(); renderProvTable();
    });
  }
  window.addEventListener('hashchange', applyHash);
  window.addEventListener('pageshow', (e) => { if (e.persisted) for (const a of document.querySelectorAll('.is-loading')) { a.classList.remove('is-loading'); a.removeAttribute('aria-busy'); a.textContent = 'Open in globe'; } $('open-globe').textContent = 'Open globe'; });
  window.addEventListener('resize', () => drawMap(state.points));
  fetch('/watch/land-110m.json').then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); }).then((j) => { state.land = j; drawMap(state.points); }).catch((e) => window.__watchError?.(`land map (${e.message})`));
window.__watchBooted = true;
  drawMap([]);
  await refresh();
  setInterval(() => refresh(), REFRESH_MS);
  setInterval(tick, 1000);
  tick();
}
boot();
