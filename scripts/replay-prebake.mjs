#!/usr/bin/env node
/**
 * Pre-bake a replay event into public/replay/<id>.json from real recorded
 * data (ADSB.lol globe_history + NOAA AIS when published + Open-Meteo wind).
 *   node scripts/replay-prebake.mjs sf-fleet-week-2025
 * Streams ~3 GB per UTC day; takes a few minutes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { buildReplay } from '../server/providers/replay/index.js';

const EVENTS = {
  'sf-fleet-week-2025': {
    title: 'SF Fleet Week 2025 — Air Show Saturday',
    subtitle: 'San Francisco Bay · Sat Oct 11 2025 · 12:00–17:00 PDT',
    tz: 'America/Los_Angeles',
    bbox: [-122.75, 37.55, -122.2, 38.0],
    t0: Date.UTC(2025, 9, 11, 19, 0) / 1000,
    t1: Date.UTC(2025, 9, 11, 23, 59, 59) / 1000,
    startAt: Date.UTC(2025, 9, 11, 20, 9, 0) / 1000,
    camera: { lon: -122.43, lat: 37.735, height: 5200, heading: 0, pitch: -32 },
    geoidM: -32,
    notes: [
      'The Blue Angels F/A-18s fly without ADS-B Out and do not appear in this record. Their slot is not reconstructed or simulated.',
      'Recorded performers include the Canadian Snowbirds (SNBD1 / SNBD9, CT-114 Tutor), Patriots Jet Team L-39 (PTJ1), Ace Maker T-33 (ACEMKR3), a P-51 Mustang (N51MX), a Su-26 pair and a United 777-300ER (UAL4206). The Su-26s, Snowbird 1 and the T-33 also flew on Sun Oct 12.',
      'Tracks marked TIS-B (~hex) are anonymous, radar-derived rebroadcasts from the FAA.',
    ],
  },
  'sf-fleet-week-2024': {
    title: 'SF Fleet Week 2024 — Air Show Saturday (with ships)',
    subtitle: 'San Francisco Bay · Sat Oct 12 2024 · 12:00–17:00 PDT',
    tz: 'America/Los_Angeles',
    bbox: [-122.75, 37.55, -122.2, 38.0],
    t0: Date.UTC(2024, 9, 12, 19, 0) / 1000,
    t1: Date.UTC(2024, 9, 12, 23, 59, 59) / 1000,
    startAt: Date.UTC(2024, 9, 12, 21, 0, 0) / 1000,
    camera: { lon: -122.43, lat: 37.735, height: 5200, heading: 0, pitch: -32 },
    geoidM: -32,
    notes: [
      'The Blue Angels F/A-18s fly without ADS-B Out and are not in the record. Their C-130J support aircraft "Fat Albert" (callsign BERT10, Navy, orange) is recorded.',
      'Other recorded performers include the Ace Maker T-33 (ACEMKR1), L-39, P-51 Mustang, a Su-26 and a United 777-300ER (UAL3836).',
      'Ships from NOAA MarineCadastre AIS (US, public domain), sampled every ≥20 s; includes US Coast Guard vessels.',
      'Tracks marked TIS-B (~hex) are anonymous, radar-derived rebroadcasts from the FAA.',
    ],
  },
};

const id = process.argv[2];
const ev = EVENTS[id];
if (!ev) { console.error('unknown event; one of', Object.keys(EVENTS)); process.exit(1); }
const started = Date.now();
let last = '';
const replay = await buildReplay({
  id, title: ev.title, bbox: ev.bbox, t0: ev.t0, t1: ev.t1,
  onProgress: (p) => { const s = `${p.stage} ${p.pct}%`; if (s !== last) { last = s; if (p.pct % 10 === 0) console.log(s, `${((Date.now() - started) / 1000) | 0}s`); } },
});
Object.assign(replay, { ...ev, kind: 'reconstructed', gaps: replay.gaps, notes: ev.notes });
const out = path.join(process.cwd(), 'public', 'replay', `${id}.json`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(replay));
console.log('wrote', out, (fs.statSync(out).size / 1e6).toFixed(2), 'MB', replay.aircraft.length, 'aircraft', replay.ships?.length ?? 'no', 'ships');
