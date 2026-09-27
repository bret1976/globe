import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeElevatedVolcanoes,
  volcanoColorCss,
} from './parse.js';

test('normalizeElevatedVolcanoes maps USGS elevated payload and ranks by color', () => {
  const rows = normalizeElevatedVolcanoes([
    {
      vName: 'Shishaldin',
      vnum: '311360',
      lat: 54.7554,
      long: -163.9711,
      colorCode: 'YELLOW',
      alertLevel: 'ADVISORY',
      obs: 'avo',
      noticeSynopsis: 'Quiet',
      noticeUrl: 'https://example.test/y',
      sentUtc: '2026-09-26 12:00:00',
      nvewsThreat: 'High Threat',
    },
    {
      vName: 'Kilauea',
      vnum: '332010',
      lat: 19.421,
      long: -155.287,
      colorCode: 'ORANGE',
      alertLevel: 'WATCH',
      obs: 'hvo',
      noticeSynopsis: 'Overflows',
      noticeUrl: 'https://example.test/o',
      sentUtc: '2026-09-26 18:41:56',
    },
    { vName: 'Bad', vnum: 'x', lat: 999, long: 0 },
    null,
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].name, 'Kilauea');
  assert.equal(rows[0].colorCode, 'ORANGE');
  assert.equal(rows[0].lon, -155.287);
  assert.equal(rows[1].name, 'Shishaldin');
  assert.equal(volcanoColorCss('ORANGE'), '#FF8800');
  assert.equal(volcanoColorCss('RED'), '#FF2244');
});

test('normalizeElevatedVolcanoes returns [] for non-arrays', () => {
  assert.deepEqual(normalizeElevatedVolcanoes(null), []);
  assert.deepEqual(normalizeElevatedVolcanoes({}), []);
});
