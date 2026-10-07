import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeRadiosondes,
  parseRadiosonde,
  radiosondeColorCss,
  radiosondePhase,
  RADIOSONDES_URL,
} from './parse.js';

const NOW = Date.parse('2026-10-07T14:30:00Z');

function frame(serial, over = {}) {
  return {
    serial,
    type: 'RS41',
    subtype: 'RS41-SG',
    manufacturer: 'Vaisala',
    datetime: '2026-10-07T14:01:21.986000Z',
    lat: 49.69192,
    lon: -4.27558,
    alt: 23456.7,
    vel_v: 5.24,
    vel_h: 15.4,
    heading: 159.09,
    temp: -48.13,
    humidity: 12.4,
    frequency: 405.700875,
    uploader_callsign: 'SOMEONE',
    uploader_position: '50.1645,-5.1335',
    ...over,
  };
}

test('feed URL is the keyless SondeHub latest-per-sonde endpoint', () => {
  assert.match(RADIOSONDES_URL, /^https:\/\/api\.v2\.sondehub\.org\/sondes\?last=\d+$/);
});

test('phase and colour mapping', () => {
  assert.equal(radiosondePhase(5, 12000), 'ascending');
  assert.equal(radiosondePhase(-12, 9000), 'descending');
  assert.equal(radiosondePhase(0.2, 150), 'landed');
  assert.equal(radiosondePhase(0.2, 30000), 'floating');
  assert.equal(radiosondePhase(null, 100), 'landed');
  assert.equal(radiosondeColorCss('ascending'), '#00E5FF');
  assert.equal(radiosondeColorCss('descending'), '#FF9100');
  assert.equal(radiosondeColorCss('landed'), '#B0BEC5');
  assert.equal(radiosondeColorCss('lost'), '#78909C');
});

test('a frame maps to a row and drops the receiver station', () => {
  const row = parseRadiosonde(frame('Y1952528'));
  assert.equal(row.stableId, 'sonde-Y1952528');
  assert.equal(row.altM, 23457);
  assert.equal(row.velV, 5.2);
  assert.equal(row.tempC, -48.1);
  assert.equal(row.humidity, 12);
  assert.equal(row.type, 'RS41-SG');
  assert.equal(row.frequencyMHz, 405.701);
  assert.equal(row.phase, 'ascending');
  assert.equal(row.observedAt, '2026-10-07T14:01:21.986Z');
  assert.equal('uploader_callsign' in row, false);
  assert.equal('uploader_position' in row, false);
  assert.equal(JSON.stringify(row).includes('SOMEONE'), false);
});

test('bad frames are rejected', () => {
  assert.equal(parseRadiosonde(frame('A', { lat: 999 })), null);
  assert.equal(parseRadiosonde(frame('A', { lat: 0, lon: 0 })), null);
  assert.equal(parseRadiosonde(frame('A', { alt: 90000 })), null);
  assert.equal(parseRadiosonde(frame('A', { alt: null })), null);
  assert.equal(parseRadiosonde(frame('A', { datetime: 'nope' })), null);
  assert.equal(parseRadiosonde(frame('<script>')), null);
  assert.equal(parseRadiosonde(frame('A', { temp: -400 })).tempC, null);
});

test('normalize keeps one newest row per serial, drops stale, newest first', () => {
  const rows = normalizeRadiosondes(
    {
      A: frame('A', { datetime: '2026-10-07T14:20:00Z' }),
      B: frame('B', { datetime: '2026-10-07T13:50:00Z', vel_v: -20 }),
      OLD: frame('OLD', { datetime: '2026-10-06T01:00:00Z' }),
      BAD: frame('BAD', { lat: 'x' }),
    },
    { now: NOW },
  );
  assert.deepEqual(
    rows.map((r) => r.serial),
    ['A', 'B'],
  );
  // B was last heard 40 min ago mid-descent: down somewhere, not airborne.
  assert.equal(rows[1].phase, 'lost');
  assert.equal(rows[0].phase, 'ascending');
  assert.equal(rows[0].ageS, 600);

  const dedup = normalizeRadiosondes(
    [
      frame('C', { datetime: '2026-10-07T14:00:00Z', alt: 1000 }),
      frame('C', { datetime: '2026-10-07T14:10:00Z', alt: 5000 }),
    ],
    { now: NOW },
  );
  assert.equal(dedup.length, 1);
  assert.equal(dedup[0].altM, 5000);
  assert.deepEqual(normalizeRadiosondes(null), []);
});
