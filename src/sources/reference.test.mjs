import test from 'node:test';
import assert from 'node:assert/strict';
import { createReferenceSources } from './reference.js';
import { createStandaloneReferenceSources } from '../standalone/layerSources.js';

test('reference factories retain compatibility without starting acquisition or sharing instances', (t) => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', () => {
    requests++;
    throw new Error('unexpected acquisition');
  });
  assert.equal(createReferenceSources, createStandaloneReferenceSources);
  const first = createReferenceSources();
  const second = createReferenceSources();
  assert.deepEqual(Object.keys(first), [
    'earthquakes',
    'fire-perimeters',
    'auFire',
    'cables',
    'gpsjam',
    'volcanoes',
    'aurora',
    'radiation',
    'floods',
    'nwsAlerts',
  ]);
  assert.notEqual(first.earthquakes, second.earthquakes);
  assert.notEqual(first['fire-perimeters'], second['fire-perimeters']);
  assert.notEqual(first.auFire, second.auFire);
  assert.notEqual(first.cables, second.cables);
  assert.notEqual(first.gpsjam, second.gpsjam);
  assert.notEqual(first.volcanoes, second.volcanoes);
  assert.notEqual(first.aurora, second.aurora);
  assert.notEqual(first.radiation, second.radiation);
  assert.notEqual(first.floods, second.floods);
  assert.notEqual(first.nwsAlerts, second.nwsAlerts);
  assert.equal(typeof first.earthquakes.getSnapshot, 'function');
  assert.equal(typeof first['fire-perimeters'].getSnapshot, 'function');
  assert.equal(typeof first.auFire.getSnapshot, 'function');
  assert.equal(typeof first.cables.fetch, 'function');
  assert.equal(typeof first.gpsjam.getSnapshot, 'function');
  assert.equal(typeof first.volcanoes.getSnapshot, 'function');
  assert.equal(typeof first.aurora.getSnapshot, 'function');
  assert.equal(typeof first.radiation.getSnapshot, 'function');
  assert.equal(typeof first.floods.getSnapshot, 'function');
  assert.equal(typeof first.nwsAlerts.getSnapshot, 'function');
  assert.equal(requests, 0);
});
