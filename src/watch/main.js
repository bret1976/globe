/**
 * /watch dashboard runtime: polls existing same-origin endpoints, runs the
 * in-page aircraft went-dark tracker, and draws a 2D jamming map. No Cesium.
 */
import './watch.css';
import {
  REFRESH_MS, WARMING_NOTE, feedHealth, feedStateLabel, healthBanner, wentDarkRows, wentDarkSideNote,
  jammingTimeline, historyNote, jamPoints, regionCounts, project, provenanceRows,
  updatedAgo, licenceFor,
} from './model.js';
import { observeAircraftSnapshot, aircraftWentDarkSnapshot } from '../data/wentDarkAircraft.js';
import { openSkySnapshot } from '../sources/live/aircraft.js';
import { PROVENANCE_COLORS, PROVENANCE_LABELS } from '../provenance/provenance.js';

const $ = (id) => document.getElementById(id);
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
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

const state = { probes: {}, updatedAt: null, ships: null, aircraft: null, timeline: [], stepIndex: null, playing: null, jamCache: new Map(), land: null };

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

/* ── Went dark ──────────────────────────────────────── */
function renderDark(now) {
  const { rows, ships, aircraft } = wentDarkRows(state.ships, state.aircraft, now);
  $('dark-ships').textContent = state.ships?.status === 'ok' ? String(ships) : '—';
  $('dark-aircraft').textContent = state.aircraft?.status === 'ok' ? String(aircraft) : '—';
  const notes = [wentDarkSideNote(state.ships, 'Ships', now), wentDarkSideNote(state.aircraft, 'Aircraft', now)].filter(Boolean);
  $('dark-notes').replaceChildren(...notes.map((t) => el('li', { text: t })));
  const list = $('dark-list');
  if (!rows.length) {
    list.replaceChildren(el('li', { class: 'empty' },
      el('strong', { text: 'Nothing has gone dark.' }),
      el('span', { text: ` ${WARMING_NOTE} Flags appear only when a steadily reporting, moving target falls silent while its neighbours keep reporting.` })));
    return;
  }
  list.replaceChildren(...rows.slice(0, 200).map((r) => el('li', { class: `dark dark--${r.kind}` },
    el('span', { class: 'dark__type', text: r.typeLabel }),
    el('span', { class: 'dark__label', text: r.label }),
    el('span', { class: 'dark__seen', text: r.lastSeen }),
    el('span', { class: 'dark__pos', text: r.position }),
    el('a', { class: 'dark__open', href: r.href, text: 'Open in globe', 'aria-label': `Open ${r.label} in the globe` }),
  )));
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
  const { rows, totals } = provenanceRows(live, now);
  $('prov-totals').replaceChildren(...['observed', 'inferred', 'simulated'].map((k) => el('div', { class: `total total--${k}` },
    el('span', { class: 'badge', style: `--badge:${PROVENANCE_COLORS[k]}`, text: PROVENANCE_LABELS[k] }),
    el('span', { class: 'total__n', text: String(totals[k] || 0) }), el('span', { class: 'total__l', text: 'layers' }))));
  $('prov-body').replaceChildren(...rows.map((r) => el('tr', {},
    el('th', { scope: 'row', text: r.layerId }),
    el('td', {}, el('span', { class: 'badge', style: `--badge:${PROVENANCE_COLORS[r.kind]}`, text: r.badge })),
    el('td', { text: r.provider }),
    el('td', { class: 'num', text: r.count == null ? '—' : r.count.toLocaleString('en-US') }),
    el('td', { text: r.freshness }),
    el('td', { class: 'licence', text: r.licence }),
  )));
}

/* ── Jamming map ────────────────────────────────────── */
const canvas = () => $('jam-map');
function drawMap(points = []) {
  const c = canvas();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = c.clientWidth, h = Math.round(w / 2);
  c.style.height = `${h}px`;
  c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.fillStyle = '#070b12'; g.fillRect(0, 0, w, h);
  g.strokeStyle = 'rgba(0,212,255,0.07)'; g.lineWidth = 1;
  for (let lon = -180; lon <= 180; lon += 30) { const [x] = project(lon, 0, w, h); g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke(); }
  for (let lat = -60; lat <= 60; lat += 30) { const [, y] = project(0, lat, w, h); g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); }
  if (state.land) {
    g.fillStyle = 'rgba(232,234,237,0.06)'; g.strokeStyle = 'rgba(0,212,255,0.35)';
    for (const ring of state.land.rings) {
      g.beginPath();
      ring.forEach(([lon, lat], i) => { const [x, y] = project(lon, lat, w, h); i ? g.lineTo(x, y) : g.moveTo(x, y); });
      g.closePath(); g.fill(); g.stroke();
    }
  }
  const counts = regionCounts(points);
  for (const r of counts) {
    const [x0, y0] = project(r.box[0], r.box[3], w, h);
    const [x1, y1] = project(r.box[2], r.box[1], w, h);
    g.strokeStyle = r.count ? 'rgba(255,181,71,0.8)' : 'rgba(255,255,255,0.18)';
    g.setLineDash([4, 3]); g.strokeRect(x0, y0, x1 - x0, y1 - y0); g.setLineDash([]);
  }
  const rad = Math.max(1.5, w / 500);
  for (const p of points) {
    g.fillStyle = p.level === 'high' ? 'rgba(255,68,68,0.85)' : p.level === 'medium' ? 'rgba(255,181,71,0.8)' : 'rgba(197,140,255,0.7)';
    if (p.box) {
      const [x0, y0] = project(p.box[0], p.box[3], w, h); const [x1, y1] = project(p.box[2], p.box[1], w, h);
      g.fillRect(x0, y0, Math.max(2, x1 - x0), Math.max(2, y1 - y0));
    } else { const [x, y] = project(p.lon, p.lat, w, h); g.beginPath(); g.arc(x, y, rad, 0, Math.PI * 2); g.fill(); }
  }
  $('jam-regions').replaceChildren(...counts.map((r) => el('li', { class: r.count ? 'hot' : '' },
    el('span', { text: r.name }), el('strong', { text: String(r.count) }))));
  $('jam-count').textContent = `${points.length.toLocaleString('en-US')} cells`;
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

async function showStep(index) {
  const steps = state.timeline;
  if (!steps.length) { $('jam-label').textContent = 'No jamming history available yet'; drawMap([]); return; }
  const i = Math.max(0, Math.min(steps.length - 1, index));
  state.stepIndex = i;
  const slider = $('jam-slider');
  slider.max = String(steps.length - 1); slider.value = String(i);
  slider.setAttribute('aria-valuetext', steps[i].label);
  $('jam-label').textContent = steps[i].label;
  $('jam-source').textContent = steps[i].kind === 'gpsjam' ? 'gpsjam.org daily H3 hexes — potential interference, not confirmed jamming' : 'adsb.lol NIC/NACp 0.5° cells — integrity anomaly, not a jamming detection';
  const pts = await loadStep(steps[i]);
  if (state.stepIndex !== i) return;
  if (pts == null) { $('jam-label').textContent = `${steps[i].label} — failed to load`; return; }
  drawMap(pts);
}

function togglePlay() {
  const btn = $('jam-play');
  if (state.playing) { clearInterval(state.playing); state.playing = null; btn.textContent = 'Play'; btn.setAttribute('aria-pressed', 'false'); return; }
  btn.textContent = 'Pause'; btn.setAttribute('aria-pressed', 'true');
  if (state.stepIndex >= state.timeline.length - 1) showStep(0);
  state.playing = setInterval(() => {
    if (state.stepIndex >= state.timeline.length - 1) return togglePlay();
    showStep(state.stepIndex + 1);
  }, 1200);
}

/* ── Refresh loop ───────────────────────────────────── */
async function refresh() {
  $('refresh-state').textContent = 'refreshing…';
  const [flights, military, ais, gpsjam, gnss] = await Promise.all([
    probe('/api/opensky'), probe('/api/adsblol/mil'), probe('/api/ais-live/dark'),
    probe('/api/gpsjam/dates'), probe('/api/gnss-integrity/history'),
  ]);
  const local = Date.now();
  state.probes = { flights, military, ais, gpsjam, gnss };
  state.ships = ais.ok ? { ...ais.payload, fetchedLocalMs: local } : null;
  if (flights.ok) {
    observeAircraftSnapshot(openSkySnapshot(flights.payload, {
      source: flights.headers.source || 'OpenSky Network',
      coverage: flights.headers.coverage || 'unknown coverage',
      now: local,
    }), local);
  }
  state.aircraft = { ...aircraftWentDarkSnapshot(local), fetchedLocalMs: local };
  const atEnd = state.stepIndex == null || state.stepIndex >= state.timeline.length - 1;
  state.timeline = jammingTimeline(gpsjam.ok ? gpsjam.payload.dates : [], gnss.ok ? gnss.payload.frames : []);
  $('jam-history').textContent = historyNote(gpsjam.ok ? gpsjam.payload.dates : [], gnss.ok ? gnss.payload : null, local);
  state.updatedAt = local;
  const health = renderHealth(local);
  renderDark(local);
  if (!state.playing && atEnd) await showStep(state.timeline.length - 1);
  const last = state.jamCache.get(`gpsjam:${gpsjam.payload?.latest}`);
  state.gpsjamLatestCount = last?.count ?? state.gpsjamLatestCount ?? null;
  const lastGnss = [...state.timeline].reverse().find((s) => s.kind === 'gnss');
  const gnssPayload = lastGnss && state.jamCache.get(`gnss:${lastGnss.key}`);
  state.gnssLatestCount = gnssPayload ? jamPoints(lastGnss, gnssPayload).length : null;
  renderProvenance(local, health);
  $('refresh-state').textContent = '';
}

function tick() { $('updated').textContent = updatedAgo(state.updatedAt); }

async function boot() {
  $('map-credit').textContent = 'Coastlines: Natural Earth 1:110m land (public domain).';
  $('footer-licences').textContent = ['opensky', 'adsblol', 'aisstream', 'gpsjam'].map(licenceFor).join(' · ');
  $('jam-slider').addEventListener('input', (e) => showStep(Number(e.target.value)));
  $('jam-play').addEventListener('click', togglePlay);
  $('refresh-now').addEventListener('click', () => refresh());
  window.addEventListener('resize', () => showStep(state.stepIndex ?? 0));
  fetch('/watch/land-110m.json').then((r) => r.json()).then((j) => { state.land = j; showStep(state.stepIndex ?? 0); }).catch(() => {});
  await refresh();
  setInterval(refresh, REFRESH_MS);
  setInterval(tick, 1000);
  tick();
}
boot();
