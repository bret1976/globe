import test from 'node:test';
import assert from 'node:assert/strict';
import { NO_IMAGERY_HOST, resolveImageryHost } from './imageryHost.js';

test('a shown globe hosts imagery on the viewer collection', () => {
  const imageryLayers = { id: 'globe' };
  const host = resolveImageryHost({
    viewer: { scene: { globe: { show: true } }, imageryLayers },
    tileset: { imageryLayers: { id: 'tiles' } },
  });
  assert.deepEqual(host, { collection: imageryLayers, kind: 'globe' });
});

test('a hidden globe hands imagery to the tileset collection', () => {
  const imageryLayers = { id: 'tiles' };
  const host = resolveImageryHost({
    viewer: { scene: { globe: { show: false } }, imageryLayers: {} },
    tileset: { imageryLayers, isDestroyed: () => false },
  });
  assert.deepEqual(host, { collection: imageryLayers, kind: 'tileset' });
});

test('photoreal (hidden globe, no tileset imagery) still drapes on the viewer', () => {
  const imageryLayers = { id: 'globe' };
  const globe = { show: false, translucency: { enabled: false } };
  const host = resolveImageryHost({
    viewer: { scene: { globe }, imageryLayers },
    tileset: null,
  });
  assert.deepEqual(host, { collection: imageryLayers, kind: 'globe' });
  assert.equal(globe.show, true);
  assert.equal(globe.translucency.enabled, true);
});

test('no globe and no tileset means nowhere to drape', () => {
  assert.deepEqual(resolveImageryHost({}), { collection: null, kind: 'none' });
  assert.deepEqual(
    resolveImageryHost({
      viewer: { scene: { globe: { show: false } } },
      tileset: { imageryLayers: {}, isDestroyed: () => true },
    }),
    { collection: null, kind: 'none' },
  );
  assert.match(NO_IMAGERY_HOST, /globe map/);
});
