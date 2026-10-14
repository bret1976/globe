/**
 * REPLAY — historical event reconstruction from recorded ADS-B / AIS.
 *
 * Self-contained screen: a REPLAY button in the top action row (and the
 * `#replay=<event>` deep link) opens it. While open, live layers are hidden,
 * the Cesium clock is driven to the event time (so sun lighting matches) and
 * recorded tracks play back. Leaving restores everything it touched.
 *
 * Every plotted position is a recorded fix. Between fixes the marker is
 * linearly interpolated for display only, and never across a gap longer than
 * MAX_GAP_S — the target simply disappears ("signal gap") there.
 */
import * as Cesium from 'cesium';
import './replay.css';
import { holdContinuousRender, releaseContinuousRender } from '../renderGovernor.js';
import { classifyAircraft, CLASS_MODEL_REAL, CLASS_MODEL_URL } from '../data/aircraftClass.js';
import { REPLAY_SPEEDS, splitSegments, parseReplayHash, clampBbox, formatClock, formatDate, speedLabel } from './model.js';

export const REPLAY_EVENTS = [
  { id: 'sf-fleet-week-2025', label: 'SF Fleet Week 2025 · Air show Sat Oct 11', url: '/replay/sf-fleet-week-2025.json' },
  { id: 'sf-fleet-week-2024', label: 'SF Fleet Week 2024 · Air show Sat Oct 12 (+ ships)', url: '/replay/sf-fleet-week-2024.json' },
];
const DEFAULT_EVENT = REPLAY_EVENTS[0].id;
// Captured at import: the share-link writer rewrites the hash on camera moves.
const INITIAL_HASH = typeof location !== 'undefined' ? location.hash : '';
const FT = 0.3048;
const KN = 0.514444;

const el = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; };
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

export function initReplay({ viewer }) {
  if (!viewer || document.getElementById('replay-btn')) return null;
  const isPhone = () => window.matchMedia('(max-width: 760px)').matches;
  const state = { open: false, replay: null, entities: [], selected: null, mode: 'chase', speed: 3, saved: null, ds: null, trail: null, wind: [], timeZone: undefined, loadToken: 0, customToken: 0 };

  // ---------- button ----------
  const nav = document.getElementById('top-center-actions');
  const btn = el('button', '', '<span class="replay-btn-glyph" aria-hidden="true">⟲</span>');
  btn.id = 'replay-btn';
  btn.type = 'button';
  btn.title = 'Replay a historical event from recorded ADS-B / AIS';
  btn.setAttribute('aria-label', 'Open historical replay');
  btn.setAttribute('aria-pressed', 'false');
  (nav || document.body).appendChild(btn);
  if (!nav) btn.classList.add('replay-btn-floating');

  // ---------- screen ----------
  const root = el('div', 'replay-root');
  root.id = 'replay-root';
  root.hidden = true;
  root.innerHTML = `
    <div class="replay-top">
      <div class="replay-badge" role="status"><span class="replay-dot"></span>RECONSTRUCTED / HISTORICAL</div>
      <div class="replay-title"><b class="replay-title-text">REPLAY</b><span class="replay-sub"></span></div>
      <button class="replay-close" type="button" aria-label="Exit replay" title="Exit replay">✕</button>
    </div>
    <div class="replay-clock" aria-live="off"><div class="replay-clock-time">--:--:--</div><div class="replay-clock-date"></div><div class="replay-clock-speed">3 s/s</div></div>
    <div class="replay-target" hidden></div>
    <div class="replay-status" role="status" aria-live="polite"></div>
    <div class="replay-bar">
      <div class="replay-row replay-row-pick">
        <select class="replay-event" aria-label="Replay event"></select>
        <button class="replay-custom-toggle" type="button" aria-expanded="false">CUSTOM AREA / TIME</button>
        <button class="replay-notes-toggle" type="button" aria-expanded="false">DATA NOTES</button>
      </div>
      <form class="replay-custom" hidden>
        <div class="replay-custom-grid">
          <label>Date<input type="date" name="date" required></label>
          <label>Start (local)<input type="time" name="time" required value="12:00"></label>
          <label>Length<select name="dur"><option value="1800">30 min</option><option value="3600" selected>1 h</option><option value="7200">2 h</option><option value="10800">3 h</option></select></label>
          <button type="submit" class="replay-go">RECONSTRUCT CURRENT VIEW</button>
        </div>
        <div class="replay-custom-hint">Uses the area you are looking at (max 2.5° per side). Aircraft from ADSB.lol daily history (2023 → ~2 days ago). Ships from NOAA AIS where published (US waters, through 2024). First request for an area streams a ~3 GB daily dump on the server and takes a few minutes; it is cached afterwards.</div>
      </form>
      <div class="replay-notes" hidden></div>
      <div class="replay-row replay-row-transport">
        <button class="replay-play" type="button" aria-label="Play">▶</button>
        <input class="replay-scrub" type="range" min="0" max="1000" value="0" step="1" aria-label="Timeline">
        <div class="replay-speeds" role="group" aria-label="Playback speed"></div>
      </div>
      <div class="replay-credits"></div>
    </div>`;
  document.body.appendChild(root);
  const $ = (s) => root.querySelector(s);
  try {
    new ResizeObserver(() => document.documentElement.style.setProperty('--replay-bar-h', `${Math.round($('.replay-bar').getBoundingClientRect().height)}px`)).observe($('.replay-bar'));
  } catch { /* old browser: CSS fallback height */ }
  const sel = $('.replay-event');
  for (const ev of REPLAY_EVENTS) sel.appendChild(new Option(ev.label, ev.id));
  sel.appendChild(new Option('Custom replay (current view)…', '__custom'));
  const speeds = $('.replay-speeds');
  for (const s of REPLAY_SPEEDS) {
    const b = el('button', 'replay-speed', `${s}×`);
    b.type = 'button';
    b.dataset.speed = s;
    b.addEventListener('click', () => setSpeed(s));
    speeds.appendChild(b);
  }

  // ---------- open / close ----------
  function open(eventId = DEFAULT_EVENT) {
    if (!state.open) {
      state.open = true;
      root.hidden = false;
      document.body.classList.add('replay-active');
      btn.setAttribute('aria-pressed', 'true');
      holdContinuousRender('replay');
      const c = viewer.clock;
      state.saved = {
        clock: { start: c.startTime.clone(), stop: c.stopTime.clone(), cur: c.currentTime.clone(), mult: c.multiplier, anim: c.shouldAnimate, range: c.clockRange, step: c.clockStep },
        hidden: [],
        lighting: viewer.scene.globe.enableLighting,
      };
      for (let i = 0; i < viewer.dataSources.length; i++) {
        const d = viewer.dataSources.get(i);
        if (d.show) { d.show = false; state.saved.hidden.push(d); }
      }
      for (let i = 0; i < viewer.scene.primitives.length; i++) {
        const p = viewer.scene.primitives.get(i);
        if (p instanceof Cesium.Cesium3DTileset || p?.show !== true) continue;
        p.show = false;
        state.saved.hidden.push(p);
      }
      if (viewer.entities.show) { viewer.entities.show = false; state.saved.hidden.push(viewer.entities); }
      state.ds = new Cesium.CustomDataSource('replay');
      viewer.dataSources.add(state.ds);
    }
    const ev = REPLAY_EVENTS.find((e) => e.id === eventId);
    if (ev) {
      state.customToken++; sel.value = ev.id; load(fetch(ev.url).then((r) => { if (!r.ok) throw new Error(`event file ${r.status}`); return r.json(); })); }
    else if (eventId === 'custom' || eventId === '__custom') { sel.value = '__custom'; toggleCustom(true); }
    else if (/^custom-[0-9a-f]{16}$/.test(eventId)) {
      sel.value = '__custom';
      state.customToken++;
      load(fetch(`/api/replay/custom?key=${eventId.slice(7)}`).then(async (r) => { const b = await r.json(); if (!r.ok) throw new Error(b.error || r.status); return { ...b.replay, tz: Intl.DateTimeFormat().resolvedOptions().timeZone }; }));
    }
    setHash(/^custom-/.test(eventId) ? eventId : sel.value === '__custom' ? 'custom' : sel.value);
  }

  function close() {
    if (!state.open) return;
    state.open = false;
    state.loadToken++;
    state.customToken++;
    clearReplay();
    if (state.ds) { viewer.dataSources.remove(state.ds, true); state.ds = null; }
    const s = state.saved;
    if (s) {
      for (const h of s.hidden) h.show = true;
      const c = viewer.clock;
      c.startTime = s.clock.start; c.stopTime = s.clock.stop; c.clockRange = s.clock.range; c.clockStep = s.clock.step;
      c.currentTime = Cesium.JulianDate.now(); // live again
      c.multiplier = s.clock.mult; c.shouldAnimate = s.clock.anim;
      viewer.scene.globe.enableLighting = s.lighting;
    }
    releaseContinuousRender('replay');
    root.hidden = true;
    document.body.classList.remove('replay-active');
    btn.setAttribute('aria-pressed', 'false');
    if (parseReplayHash(location.hash)) history.replaceState(null, '', location.pathname + location.search);
    viewer.scene.requestRender();
  }

  function setHash(id) {
    const h = `#replay=${encodeURIComponent(id)}`;
    if (location.hash !== h) history.replaceState(null, '', location.pathname + location.search + h);
  }

  // ---------- data → entities ----------
  function clearReplay() {
    unselect();
    for (const w of state.wind) state.ds?.entities.remove(w);
    state.wind = [];
    state.ds?.entities.removeAll();
    state.entities = [];
    state.replay = null;
  }

  function status(msg, kind = '') {
    const s = $('.replay-status');
    s.textContent = msg || '';
    s.dataset.kind = kind;
    s.hidden = !msg;
  }

  async function load(promise) {
    const token = ++state.loadToken;
    status('Loading recorded tracks…');
    let replay;
    try { replay = await promise; } catch (err) { if (token === state.loadToken) status(`Could not load replay: ${err.message}`, 'error'); return; }
    if (token !== state.loadToken || !state.open) return;
    clearReplay();
    state.replay = replay;
    state.timeZone = replay.tz || Intl.DateTimeFormat().resolvedOptions().timeZone;
    build(replay);
    status('');
  }

  function build(r) {
    const ents = state.ds.entities;
    const phone = isPhone();
    const geoid = Number.isFinite(r.geoidM) ? r.geoidM : 0;
    const base = Cesium.JulianDate.fromDate(new Date(r.t0 * 1000));
    const at = (s) => Cesium.JulianDate.addSeconds(base, s, new Cesium.JulianDate());
    const add = (rec, kind) => {
      const segs = splitSegments(rec.pts);
      const pos = new Cesium.SampledPositionProperty();
      pos.setInterpolationOptions({ interpolationDegree: 1, interpolationAlgorithm: Cesium.LinearApproximation });
      const avail = new Cesium.TimeIntervalCollection();
      for (const seg of segs) {
        if (seg.length < 2) continue;
        for (const p of seg) {
          const h = kind === 'ship' ? geoid + 2 : Math.max(p[3] == null ? 0 : p[3] * FT, 0) + geoid + 3;
          pos.addSample(at(p[0]), Cesium.Cartesian3.fromDegrees(p[2], p[1], h));
        }
        avail.addInterval(new Cesium.TimeInterval({ start: at(seg[0][0]), stop: at(seg[seg.length - 1][0]) }));
      }
      if (!avail.length) return null;
      const tis = kind === 'air' && rec.hex?.startsWith('~');
      const name = kind === 'air' ? rec.cs || rec.reg || (tis ? 'TIS-B' : rec.hex.toUpperCase()) : rec.name || `MMSI ${rec.mmsi}`;
      const color = kind === 'ship' ? Cesium.Color.fromCssColorString('#7CFFB2') : rec.mil ? Cesium.Color.fromCssColorString('#FFB547') : tis ? Cesium.Color.fromCssColorString('#9fb3c8') : Cesium.Color.fromCssColorString('#4FE3FF');
      const e = ents.add({
        name,
        availability: avail,
        position: pos,
        point: { pixelSize: kind === 'ship' ? 6 : 7, color, outlineColor: Cesium.Color.BLACK.withAlpha(0.7), outlineWidth: 1, disableDepthTestDistance: 5e4 },
        label: {
          text: name, font: '11px "JetBrains Mono", monospace', fillColor: color, outlineColor: Cesium.Color.BLACK, outlineWidth: 3,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE, pixelOffset: new Cesium.Cartesian2(9, -9), horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, phone ? 9000 : 16000), disableDepthTestDistance: 5e4,
        },
        path: kind === 'air' && !phone ? { leadTime: 0, trailTime: 60, width: 1.5, resolution: 4, material: color.withAlpha(0.45) } : undefined,
      });
      e._replay = { kind, rec, color };
      state.entities.push(e);
      return e;
    };
    for (const a of r.aircraft || []) add(a, 'air');
    for (const s of r.ships || []) add(s, 'ship');
    buildWind(r, at);

    // clock → event time (sun lighting follows the clock)
    const c = viewer.clock;
    c.startTime = at(0);
    c.stopTime = at(r.t1 - r.t0);
    c.currentTime = r.startAt ? Cesium.JulianDate.fromDate(new Date(r.startAt * 1000)) : at(0);
    c.clockRange = Cesium.ClockRange.CLAMPED;
    c.clockStep = Cesium.ClockStep.SYSTEM_CLOCK_MULTIPLIER;
    viewer.scene.globe.enableLighting = true;
    setSpeed(state.speed);
    setPlaying(true);

    $('.replay-title-text').textContent = r.title || 'Replay';
    $('.replay-sub').textContent = r.subtitle || `${formatDate(r.t0, state.timeZone)} · ${(r.aircraft || []).length} aircraft`;
    const shipLine = r.ships?.length ? `${r.ships.length} ships` : r.shipsNote || 'no ship history';
    $('.replay-credits').textContent = `${r.credits || 'ADS-B: ADSB.lol (ODbL)'} · ${(r.aircraft || []).length} aircraft · ${shipLine}`;
    const notes = [...(r.notes || []), ...(r.gaps || []).map((g) => `Gap: ${g}`), r.shipsNote && !r.ships?.length ? r.shipsNote : null,
      'Markers move linearly between recorded fixes for display; no position is invented across receiver gaps > 2 min (target hides).',
      ...(r.sources || []).map((s) => `Source: ${s.name}${s.release ? ` (${s.release})` : ''} — ${s.license}`)].filter(Boolean);
    $('.replay-notes').innerHTML = `<ul>${notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>`;

    flyToEvent(r);
    // Startup camera moves (first-run tour, share-link restore) can land after
    // ours; re-aim once if the view ended up far from the event in the first seconds.
    const until = Date.now() + 12_000;
    const reaim = () => {
      if (!state.open || state.replay !== r || Date.now() > until) { viewer.camera.moveEnd.removeEventListener(reaim); return; }
      const [w, s, e, n] = r.bbox;
      const c = viewer.camera.positionCartographic;
      const d = Cesium.Cartesian3.distance(Cesium.Cartesian3.fromRadians(c.longitude, c.latitude, 0), Cesium.Cartesian3.fromDegrees((w + e) / 2, (s + n) / 2, 0));
      if (d > 60_000 && !state.selected) flyToEvent(r);
    };
    viewer.camera.moveEnd.addEventListener(reaim);
    setTimeout(reaim, 4000);
  }

  function flyToEvent(r) {
    const cam = r.camera;
    if (cam) viewer.camera.flyTo({ destination: Cesium.Cartesian3.fromDegrees(cam.lon, cam.lat, cam.height), orientation: { heading: Cesium.Math.toRadians(cam.heading || 0), pitch: Cesium.Math.toRadians(cam.pitch ?? -35), roll: 0 }, duration: 1.5 });
    else {
      const [w, s, e, n] = r.bbox;
      viewer.camera.flyTo({ destination: Cesium.Rectangle.fromDegrees(w, s, e, n), duration: 1.5 });
    }
  }

  function windArrow() {
    const cv = document.createElement('canvas');
    cv.width = 32; cv.height = 32;
    const g = cv.getContext('2d');
    g.strokeStyle = 'rgba(200,240,255,0.95)'; g.fillStyle = 'rgba(200,240,255,0.95)'; g.lineWidth = 2.5;
    g.beginPath(); g.moveTo(16, 28); g.lineTo(16, 8); g.stroke();
    g.beginPath(); g.moveTo(16, 2); g.lineTo(9, 12); g.lineTo(23, 12); g.closePath(); g.fill();
    return cv;
  }

  function buildWind(r, at) {
    const w = r.wind;
    if (!w?.points?.length) return;
    const img = windArrow();
    const idx = () => {
      const s = Cesium.JulianDate.secondsDifference(viewer.clock.currentTime, at(0));
      let best = 0;
      for (let i = 0; i < w.hours.length; i++) if (Math.abs(w.hours[i] - s) < Math.abs(w.hours[best] - s)) best = i;
      return best;
    };
    for (const p of w.points) {
      state.wind.push(state.ds.entities.add({
        position: Cesium.Cartesian3.fromDegrees(p.lon, p.lat, 400),
        billboard: {
          image: img, scale: 0.9, alignedAxis: Cesium.Cartesian3.UNIT_Z, color: Cesium.Color.WHITE.withAlpha(0.8),
          rotation: new Cesium.CallbackProperty(() => -Cesium.Math.toRadians(((p.dir[idx()] ?? 0) + 180) % 360), false),
          disableDepthTestDistance: 5e4,
        },
        label: {
          text: new Cesium.CallbackProperty(() => `${Math.round(p.kn[idx()] ?? 0)} kn`, false),
          font: '10px "JetBrains Mono", monospace', fillColor: Cesium.Color.fromCssColorString('#c8f0ff'), outlineColor: Cesium.Color.BLACK, outlineWidth: 3,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE, pixelOffset: new Cesium.Cartesian2(0, 22), disableDepthTestDistance: 5e4,
        },
      }));
    }
  }

  // ---------- transport ----------
  function setSpeed(s) {
    state.speed = s;
    viewer.clock.multiplier = s;
    for (const b of speeds.children) b.setAttribute('aria-pressed', String(+b.dataset.speed === s));
    $('.replay-clock-speed').textContent = speedLabel(s);
  }
  function setPlaying(on) {
    viewer.clock.shouldAnimate = on;
    const p = $('.replay-play');
    p.textContent = on ? '❚❚' : '▶';
    p.setAttribute('aria-label', on ? 'Pause' : 'Play');
  }
  $('.replay-play').addEventListener('click', () => {
    const c = viewer.clock;
    if (!c.shouldAnimate && Cesium.JulianDate.greaterThanOrEquals(c.currentTime, c.stopTime)) c.currentTime = c.startTime.clone();
    setPlaying(!c.shouldAnimate);
  });
  const scrub = $('.replay-scrub');
  let scrubbing = false;
  scrub.addEventListener('input', () => {
    scrubbing = true;
    const c = viewer.clock;
    const span = Cesium.JulianDate.secondsDifference(c.stopTime, c.startTime);
    c.currentTime = Cesium.JulianDate.addSeconds(c.startTime, (span * scrub.value) / 1000, new Cesium.JulianDate());
  });
  scrub.addEventListener('change', () => { scrubbing = false; });

  // ---------- selection / chase cam ----------
  const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
  handler.setInputAction((m) => {
    if (!state.open) return;
    const picked = viewer.scene.drillPick(m.position, 5).map((x) => x.id).find((id) => id?._replay);
    if (picked) select(picked);
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

  function select(e) {
    unselect();
    state.selected = e;
    const { kind, color } = e._replay;
    let uri = '/models/ship.glb';
    if (kind === 'air') {
      let cls = null;
      try { cls = classifyAircraft({ typeCode: e._replay.rec.type || '' }); } catch { /* unknown type */ }
      const t = e._replay.rec.type || '';
      // airshow types the shared classifier treats as airliners
      if (/^(CL41|T33|L39|L159|VAMP|F86|MIG\d|F18|FA18|F16|F35|A10|T38|HAWK|ALPJ|U2)$/.test(t)) cls = 'fastjet';
      else if (/^(P51|P47|P40|F4U|SPIT|T6|SU26|SU29|SU31|EXTR|EA30|EA50|YK52|YK18|PTS[12]|PITTS|S2|SBR1|CP10|RV\d+|PA18|J3)$/.test(t)) cls = 'light';
      else if (/^(C130|C30J|P3|E2|C2)$/.test(t)) cls = 'turboprop';
      uri = cls === 'fastjet' ? '/models/jet.glb' : CLASS_MODEL_REAL[cls]?.url || CLASS_MODEL_URL[cls] || '/models/airplane.glb';
    }
    const flip = Cesium.Quaternion.fromAxisAngle(Cesium.Cartesian3.UNIT_Z, Math.PI); // shared GLB nose is −X
    const vel = new Cesium.VelocityOrientationProperty(e.position);
    let lastQ = null;
    e.orientation = new Cesium.CallbackProperty((time, result) => {
      const q = vel.getValue(time, result);
      if (q) lastQ = Cesium.Quaternion.multiply(q, flip, new Cesium.Quaternion());
      return lastQ;
    }, false);
    e.model = { uri, minimumPixelSize: kind === 'ship' ? 40 : 56, maximumScale: 400, color: Cesium.Color.WHITE, silhouetteColor: color, silhouetteSize: 1.5 };
    e.point.show = false;
    if (e.path) e.path.show = false;
    // fading trail: per-vertex alpha ramp, rebuilt from recorded samples
    state.trail = viewer.scene.primitives.add(new Cesium.PrimitiveCollection());
    state.trailAt = 0;
    renderTarget(true);
  }
  function unselect() {
    const e = state.selected;
    if (e) {
      e.model = undefined; e.orientation = undefined; e.point.show = true;
      if (e.path) e.path.show = true;
    }
    state.selected = null;
    if (state.trail) { viewer.scene.primitives.remove(state.trail); state.trail = null; }
    try { viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY); } catch { /* */ }
    if (viewer.trackedEntity) viewer.trackedEntity = undefined;
    $('.replay-target').hidden = true;
  }

  function rebuildTrail(now) {
    const e = state.selected;
    if (!e || !state.trail) return;
    state.trail.removeAll();
    const TRAIL = 240, STEP = 2;
    const positions = [], colors = [];
    const c = e._replay.color;
    for (let s = -TRAIL; s <= 0; s += STEP) {
      const t = Cesium.JulianDate.addSeconds(now, s, new Cesium.JulianDate());
      if (!e.isAvailable(t)) { if (positions.length) break; continue; }
      const p = e.position.getValue(t);
      if (!p) continue;
      positions.push(p);
      colors.push(c.withAlpha(0.05 + 0.9 * ((s + TRAIL) / TRAIL) ** 1.6));
    }
    if (positions.length < 2) return;
    state.trail.add(new Cesium.Primitive({
      geometryInstances: new Cesium.GeometryInstance({ geometry: new Cesium.PolylineGeometry({ positions, colors, width: 4, colorsPerVertex: true, arcType: Cesium.ArcType.NONE }) }),
      appearance: new Cesium.PolylineColorAppearance({ translucent: true }),
      asynchronous: false,
    }));
  }

  function renderTarget(force) {
    const e = state.selected;
    const card = $('.replay-target');
    if (!e) { card.hidden = true; return; }
    const now = viewer.clock.currentTime;
    const rec = e._replay.rec;
    const avail = e.isAvailable(now);
    const r0 = state.replay.t0;
    const s = Cesium.JulianDate.secondsDifference(now, viewer.clock.startTime);
    let fix = null;
    for (const p of rec.pts) { if (p[0] <= s) fix = p; else break; }
    const air = e._replay.kind === 'air';
    const line2 = air
      ? `${esc(rec.type || '')}${rec.desc ? ' · ' + esc(rec.desc) : ''}${rec.reg ? ' · ' + esc(rec.reg) : ''}${rec.hex?.startsWith('~') ? ' · TIS-B (radar-derived)' : ''}`
      : `MMSI ${esc(rec.mmsi)}${rec.len ? ' · ' + rec.len + ' m' : ''}`;
    const line3 = !avail ? '<span class="replay-gap">NO RECORDED FIX — signal gap / out of area</span>'
      : air ? `${fix?.[3] != null ? Math.round(fix[3]).toLocaleString() + ' ft' : '— ft'} · ${fix?.[4] ?? '—'} kt · hdg ${fix?.[5] ?? '—'}°`
        : `${fix?.[3] ?? '—'} kn · cog ${fix?.[4] ?? '—'}°`;
    if (!card.querySelector('.replay-target-name')) {
      card.innerHTML = `<div class="replay-target-name"></div><div class="replay-target-l2"></div><div class="replay-target-l3"></div><div class="replay-target-fix"></div>
        <div class="replay-target-btns"><button type="button" data-m="chase">CHASE</button><button type="button" data-m="orbit">ORBIT</button><button type="button" data-m="release">RELEASE</button></div>`;
    }
    const k = `${rec.hex || rec.mmsi}|${line3}|${fix?.[0]}|${state.mode}`;
    if (force || card.dataset.k !== k) {
      card.dataset.k = k;
      card.querySelector('.replay-target-name').textContent = e.name;
      card.querySelector('.replay-target-l2').innerHTML = line2;
      card.querySelector('.replay-target-l3').innerHTML = line3;
      card.querySelector('.replay-target-fix').textContent = `last fix ${fix ? formatClock(r0 + fix[0], state.timeZone) : '—'}`;
      for (const b of card.querySelectorAll('[data-m]')) if (b.dataset.m !== 'release') b.setAttribute('aria-pressed', String(b.dataset.m === state.mode));
    }
    card.hidden = false;
  }
  $('.replay-target').addEventListener('click', (ev) => {
    const m = ev.target?.dataset?.m;
    if (!m) return;
    if (m === 'release') { unselect(); return; }
    state.mode = m;
    try { viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY); } catch { /* */ }
    viewer.trackedEntity = m === 'orbit' ? state.selected : undefined;
    renderTarget(true);
  });

  const chase = { range: 140, pitch: -12 };
  viewer.scene.canvas.addEventListener('wheel', (ev) => {
    if (!state.open || !state.selected || state.mode !== 'chase') return;
    chase.range = Cesium.Math.clamp(chase.range * (ev.deltaY > 0 ? 1.15 : 0.87), 40, 5000);
  }, { passive: true });

  const onTick = () => {
    if (!state.open || !state.replay) return;
    const c = viewer.clock;
    const span = Cesium.JulianDate.secondsDifference(c.stopTime, c.startTime) || 1;
    if (!scrubbing) scrub.value = String(Math.round((1000 * Cesium.JulianDate.secondsDifference(c.currentTime, c.startTime)) / span));
    const epoch = Cesium.JulianDate.toDate(c.currentTime).getTime() / 1000;
    $('.replay-clock-time').textContent = formatClock(epoch, state.timeZone);
    $('.replay-clock-date').textContent = formatDate(epoch, state.timeZone);
    if (c.shouldAnimate && Cesium.JulianDate.greaterThanOrEquals(c.currentTime, c.stopTime)) setPlaying(false);
    const e = state.selected;
    if (e) {
      const now = c.currentTime;
      if (Math.abs(Cesium.JulianDate.secondsDifference(now, state.trailTime || now)) > 0.4 * Math.max(1, state.speed) / 3 || !state.trailTime) {
        state.trailTime = now.clone();
        rebuildTrail(now);
      }
      renderTarget(false);
      if (state.mode === 'chase' && e.isAvailable(now)) {
        const p = e.position.getValue(now);
        const prev = e.position.getValue(Cesium.JulianDate.addSeconds(now, -2, new Cesium.JulianDate()));
        if (p && prev) {
          const enu = Cesium.Transforms.eastNorthUpToFixedFrame(p);
          const inv = Cesium.Matrix4.inverse(enu, new Cesium.Matrix4());
          const d = Cesium.Matrix4.multiplyByPoint(inv, prev, new Cesium.Cartesian3());
          if (Math.hypot(d.x, d.y) > 0.5) chase.heading = Math.atan2(-d.x, -d.y);
          viewer.camera.lookAt(p, new Cesium.HeadingPitchRange(chase.heading ?? 0, Cesium.Math.toRadians(chase.pitch), chase.range));
        }
      }
    }
  };
  viewer.clock.onTick.addEventListener(onTick);

  // ---------- custom ----------
  function toggleCustom(force) {
    const f = $('.replay-custom');
    const show = force ?? f.hidden;
    f.hidden = !show;
    $('.replay-custom-toggle').setAttribute('aria-expanded', String(show));
    if (show && !f.date.value) {
      const d = new Date(Date.now() - 3 * 86400e3);
      f.date.value = d.toISOString().slice(0, 10);
    }
  }
  $('.replay-custom-toggle').addEventListener('click', () => toggleCustom());
  $('.replay-notes-toggle').addEventListener('click', () => {
    const n = $('.replay-notes');
    n.hidden = !n.hidden;
    $('.replay-notes-toggle').setAttribute('aria-expanded', String(!n.hidden));
  });
  sel.addEventListener('change', () => {
    if (sel.value === '__custom') { toggleCustom(true); setHash('custom'); return; }
    open(sel.value);
  });

  function viewBbox() {
    const rect = viewer.camera.computeViewRectangle(viewer.scene.globe.ellipsoid);
    let b;
    if (rect) b = [rect.west, rect.south, rect.east, rect.north].map(Cesium.Math.toDegrees);
    const carto = viewer.scene.camera.positionCartographic;
    const lon = Cesium.Math.toDegrees(carto.longitude), lat = Cesium.Math.toDegrees(carto.latitude);
    if (!b || b[2] < b[0]) b = [lon - 0.5, lat - 0.5, lon + 0.5, lat + 0.5];
    return clampBbox(b);
  }

  $('.replay-custom').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = ev.currentTarget;
    const t0 = Math.floor(new Date(`${f.date.value}T${f.time.value}`).getTime() / 1000);
    const t1 = t0 + Number(f.dur.value);
    await runCustom(viewBbox(), t0, t1);
  });

  async function runCustom(bbox, t0, t1) {
    const mine = ++state.customToken;
    const q = `/api/replay/custom?bbox=${bbox.join(',')}&t0=${t0}&t1=${t1}`;
    status(`Reconstructing ${bbox.map((x) => x.toFixed(2)).join(', ')}…`);
    const poll = async () => {
      for (;;) {
        if (mine !== state.customToken || !state.open) throw new Error('cancelled');
        const res = await fetch(q);
        const body = await res.json().catch(() => ({}));
        if (res.status === 200 && body.replay) return body.replay;
        if (res.status === 202 || res.status === 429) {
          const p = body.progress || {};
          status(`${res.status === 429 ? 'Server busy with another replay — waiting. ' : ''}Reconstructing from recorded data: ${p.stage || '…'} ${p.pct != null ? p.pct + '%' : ''}${p.tracks != null ? ` · ${p.tracks} aircraft found` : ''}`);
          await new Promise((r) => setTimeout(r, 4000));
          continue;
        }
        throw new Error(body.error || `server ${res.status}`);
      }
    };
    await load(poll().then((r) => ({ ...r, tz: Intl.DateTimeFormat().resolvedOptions().timeZone, subtitle: `${formatDate(t0)} · ${new Date(t0 * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}–${new Date(t1 * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })} · ${bbox.map((x) => x.toFixed(2)).join(', ')}` })));
    if (mine === state.customToken && state.replay?.id?.startsWith('custom-')) { toggleCustom(false); setHash(state.replay.id); }
  }

  // ---------- wiring ----------
  btn.addEventListener('click', () => (state.open ? close() : open(sel.value && sel.value !== '__custom' ? sel.value : DEFAULT_EVENT)));
  $('.replay-close').addEventListener('click', close);
  document.addEventListener('keydown', (ev) => {
    if (!state.open || ev.target?.matches?.('input,select,textarea')) return;
    if (ev.key === 'Escape') { if (state.selected) unselect(); else close(); }
    if (ev.key === ' ') { ev.preventDefault(); $('.replay-play').click(); }
  });
  const fromHash = (h = location.hash) => { const id = parseReplayHash(h); if (id) open(id === 'default' ? DEFAULT_EVENT : id); };
  window.addEventListener('hashchange', () => fromHash());
  fromHash(parseReplayHash(location.hash) ? location.hash : INITIAL_HASH);

  const api = { open, close, runCustom, select: (name) => { const e = state.entities.find((x) => x.name === name || x._replay.rec.hex === name); if (e) select(e); return Boolean(e); }, state, setSpeed, setPlaying };
  window.__gevReplay = api;
  return api;
}
