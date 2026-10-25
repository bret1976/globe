import test from 'node:test';
import assert from 'node:assert/strict';
import { gpsjamManifestDates } from './parse.js';
import { gpsjamDateSlider } from './index.js';
import { gpsjamProxy } from '../../../server/providers/gpsjam.js';
import { REPLAY_JAMMING_MARGIN_DEG, replayJammingDate, replayJammingRows } from '../../replay/model.js';

test('manifest dates are parsed, de-duplicated and sorted', () => {
  assert.deepEqual(
    gpsjamManifestDates('\uFEFFdate,suspect\n2026-10-24,true\n2026-10-22,false\n2026-10-24,x\nbad\n'),
    ['2026-10-22', '2026-10-24'],
  );
});

test('the day slider defaults to the latest day', () => {
  const s = gpsjamDateSlider(['2026-10-22', '2026-10-23', '2026-10-24'], null);
  assert.equal(s.latest, true);
  assert.equal(s.date, null);
  assert.equal(s.valueText, '2026-10-24 · LATEST');
  assert.equal(gpsjamDateSlider(['2026-10-22', '2026-10-23'], 0).date, '2026-10-22');
  assert.equal(gpsjamDateSlider(['2026-10-24'], null).disabled, true);
});

test('replay picks the day it starts in and rows near its box', () => {
  assert.equal(replayJammingDate(Date.parse('2026-10-24T23:59:00Z') / 1000), '2026-10-24');
  assert.equal(replayJammingDate(NaN), null);
  const rows = [{ lat: 10, lon: 10 }, { lat: 10, lon: 11 + REPLAY_JAMMING_MARGIN_DEG + 0.5 }];
  assert.deepEqual(replayJammingRows(rows, [9, 9, 11, 11]), [rows[0]]);
});

function install(fetchImpl) {
  let handler;
  gpsjamProxy({ fetchImpl, now: () => 1_800_000_000_000 }).configureServer({ middlewares: { use: (_p, cb) => (handler = cb) } });
  return async (url) => {
    const res = { writeHead(s) { this.status = s; }, end(b) { this.body = JSON.parse(b); } };
    await handler({ url, method: 'GET' }, res, () => { res.status = 'next'; });
    return res;
  };
}

test('server: /dates lists manifest days and ?date= serves a past day, 404s unpublished ones', async () => {
  const urls = [];
  const get = install(async (url) => {
    urls.push(url);
    if (url.endsWith('manifest.csv')) return new Response('date,suspect\n2026-10-23,false\n2026-10-24,false\n');
    return new Response('hex,count_good_aircraft,count_bad_aircraft\n882a100d9dfffff,2,8\n');
  });
  const dates = await get('/dates');
  assert.equal(dates.status, 200);
  assert.deepEqual(dates.body.dates, ['2026-10-23', '2026-10-24']);
  assert.equal(dates.body.latest, '2026-10-24');
  const past = await get('/?date=2026-10-23');
  assert.equal(past.status, 200);
  assert.equal(past.body.date, '2026-10-23');
  assert.equal(past.body.provider, 'gpsjam.org');
  assert.ok(urls.some((u) => u.includes('2026-10-23')));
  assert.equal((await get('/?date=2020-01-01')).status, 404);
  assert.equal((await get('/?date=junk')).status, 400);
});
