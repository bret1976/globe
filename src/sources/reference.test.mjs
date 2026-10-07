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
    'ndbcBuoys',
    'usgsGauges',
    'tideGauges',
    'usdmDrought',
    'airQuality',
    'stormReports',
    'oceanCurrents',
    'powerPlants',
    'radiosondes',
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
  assert.notEqual(first.ndbcBuoys, second.ndbcBuoys);
  assert.notEqual(first.usgsGauges, second.usgsGauges);
  assert.notEqual(first.tideGauges, second.tideGauges);
  assert.notEqual(first.usdmDrought, second.usdmDrought);
  assert.notEqual(first.airQuality, second.airQuality);
  assert.notEqual(first.stormReports, second.stormReports);
  assert.notEqual(first.oceanCurrents, second.oceanCurrents);
  assert.notEqual(first.powerPlants, second.powerPlants);
  assert.notEqual(first.radiosondes, second.radiosondes);
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
  assert.equal(typeof first.ndbcBuoys.getSnapshot, 'function');
  assert.equal(typeof first.usgsGauges.getSnapshot, 'function');
  assert.equal(typeof first.tideGauges.getSnapshot, 'function');
  assert.equal(typeof first.usdmDrought.getSnapshot, 'function');
  assert.equal(typeof first.airQuality.getSnapshot, 'function');
  assert.equal(typeof first.stormReports.getSnapshot, 'function');
  assert.equal(typeof first.oceanCurrents.getSnapshot, 'function');
  assert.equal(typeof first.powerPlants.getSnapshot, 'function');
  assert.equal(typeof first.radiosondes.getSnapshot, 'function');
  assert.equal(requests, 0);
});
