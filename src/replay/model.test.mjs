import test from 'node:test';
import assert from 'node:assert/strict';
import { splitSegments, parseReplayHash, clampBbox, speedLabel } from './model.js';
import { validateReplayRequest } from '../../server/providers/replay/index.js';
import { createTarReader } from '../../server/providers/replay/adsbHistory.js';

test('splitSegments breaks at receiver gaps', () => {
  const s = splitSegments([[0], [10], [20], [500], [505]]);
  assert.equal(s.length, 2);
  assert.equal(s[1][0][0], 500);
});
test('parseReplayHash', () => {
  assert.equal(parseReplayHash('#replay=sf-fleet-week-2025'), 'sf-fleet-week-2025');
  assert.equal(parseReplayHash('#replay'), 'default');
  assert.equal(parseReplayHash('#shorts=bay'), null);
});
test('clampBbox keeps centre under max span', () => {
  const b = clampBbox([-130, 30, -110, 45]);
  assert.ok(b[2] - b[0] <= 2.5 && b[3] - b[1] <= 2.5);
  assert.ok(Math.abs((b[0] + b[2]) / 2 + 120) < 0.02);
});
test('speed label', () => assert.equal(speedLabel(3), '3 s/s'));
test('validateReplayRequest limits', () => {
  const now = Date.parse('2026-10-13T00:00:00Z');
  const t0 = Date.parse('2025-06-01T18:00:00Z') / 1000;
  assert.equal(validateReplayRequest({ bbox: [-1, 51, 0, 52], t0, t1: t0 + 3600 }, now), null);
  assert.match(validateReplayRequest({ bbox: [-5, 50, 0, 52], t0, t1: t0 + 3600 }, now), /too large/);
  assert.match(validateReplayRequest({ bbox: [-1, 51, 0, 52], t0, t1: t0 + 5 * 3600 }, now), /too long/);
  assert.match(validateReplayRequest({ bbox: [-1, 51, 0, 52], t0: now / 1000 - 3600, t1: now / 1000 }, now), /too recent/);
});
test('tar reader yields regular files', () => {
  const mk = (name, body) => {
    const h = Buffer.alloc(512);
    h.write(name, 0);
    h.write(body.length.toString(8).padStart(11, '0') + '\0', 124);
    h.write('0', 156);
    const pad = Buffer.alloc(Math.ceil(body.length / 512) * 512);
    Buffer.from(body).copy(pad);
    return Buffer.concat([h, pad]);
  };
  const tar = Buffer.concat([mk('./traces/aa/trace_full_abc.json', '{"a":1}'), mk('./x.txt', 'hi'), Buffer.alloc(1024)]);
  const got = [];
  const push = createTarReader((n, b) => got.push([n, b.toString()]));
  for (let i = 0; i < tar.length; i += 300) push(tar.subarray(i, i + 300));
  assert.deepEqual(got, [['./traces/aa/trace_full_abc.json', '{"a":1}'], ['./x.txt', 'hi']]);
});
