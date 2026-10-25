import test from 'node:test';
import assert from 'node:assert/strict';
globalThis.window = new EventTarget();
import { clearInspection, getInspection, publishInspection } from './inspection.js';

test('the inspection channel publishes, reads and clears only its own layer', () => {
  const events = [];
  window.addEventListener('gev:inspection', (e) => events.push(e.detail.id));
  assert.equal(publishInspection({}), null);
  const rec = publishInspection({ layerId: 'flights', id: 'abc' });
  assert.equal(getInspection().id, 'abc');
  assert.ok(Number.isFinite(rec.publishedAt));
  assert.deepEqual(events, ['abc']);
  clearInspection('cctv');
  assert.equal(getInspection().id, 'abc');
  clearInspection('flights');
  assert.equal(getInspection(), null);
});
