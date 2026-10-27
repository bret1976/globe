// Ports of upstream bilawalsidhu/gods-eye-view #1385, #1386, #1387, #1389,
// #1390, #1396 (MIT): numbers that round across a unit or north boundary.
import test from 'node:test';
import assert from 'node:assert/strict';
import { formatRouteDistance, formatRouteDuration } from './routeSteps.js';
import { formatAwarenessDistance } from './militaryAwarenessEngine.js';
import { formatCockpitWindDirection } from '../ui/cockpitPresentation.js';
import { localAdsbCardModel } from '../layers/localAdsb/card.js';
import { formatHeadingReadout } from '../cockpitMath.js';

test('route distance rounds before the metre/kilometre cut', () => {
  assert.equal(formatRouteDistance(994), '990 m');
  assert.equal(formatRouteDistance(996), '1.0 km');
  assert.equal(formatRouteDistance(1500), '1.5 km');
  assert.equal(formatRouteDistance(9940), '9.9 km');
  assert.equal(formatRouteDistance(9960), '10 km');
  assert.equal(formatRouteDistance(236), '240 m');
});

test('route duration of 59.6 s reads 1 min, not 60 s', () => {
  assert.equal(formatRouteDuration(39), '39 s');
  assert.equal(formatRouteDuration(59.4), '59 s');
  assert.equal(formatRouteDuration(59.6), '1 min');
  assert.equal(formatRouteDuration(3900), '1 h 5 min');
});

test('awareness distance of 999.6 m reads 1.0 km', () => {
  assert.equal(formatAwarenessDistance(999.4), '999 m');
  assert.equal(formatAwarenessDistance(999.6), '1.0 km');
  assert.equal(formatAwarenessDistance(4600), '4.6 km');
  assert.equal(formatAwarenessDistance(9960), '10 km');
  assert.equal(formatAwarenessDistance(-1), '—');
});

test('cockpit wind just west of north reads 0°, not 360°', () => {
  assert.equal(formatCockpitWindDirection(90), 'E · 90°');
  assert.equal(formatCockpitWindDirection(359.4), 'N · 359°');
  assert.equal(formatCockpitWindDirection(359.6), 'N · 0°');
});

test('bearings that round through north read 000', () => {
  assert.equal(formatHeadingReadout(359.4), '359');
  assert.equal(formatHeadingReadout(359.6), '000');
  assert.equal(formatHeadingReadout(-0.4), '000');
});

test('local ADS-B track of 359.7° reads TRK 0°', () => {
  const model = localAdsbCardModel(
    {
      icao: 'abc123',
      altitudeFt: 12500,
      groundSpeedKt: 240,
      trackDeg: 359.7,
      lastPositionAt: 1000,
    },
    5000,
  );
  const line = JSON.stringify(model);
  assert.match(line, /TRK 0°/);
  assert.doesNotMatch(line, /TRK 360°/);
});
