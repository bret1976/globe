import test from 'node:test';
import assert from 'node:assert/strict';
import { createNowcoastLayer, NOWCOAST_PRODUCTS, frameBucket } from './index.js';

function fakeCesium() {
  return {
    WebMapServiceImageryProvider: class {
      constructor(options) {
        this.options = options;
      }
    },
    GeographicTilingScheme: class {},
    Rectangle: { fromDegrees: (...a) => a },
    ImageryLayer: class {
      constructor(provider, options) {
        this.provider = provider;
        this.alpha = options.alpha;
      }
    },
  };
}
function fakeCollection() {
  const layers = [];
  return {
    layers,
    add: (layer) => layers.push(layer),
    remove: (layer) => {
      const i = layers.indexOf(layer);
      if (i >= 0) layers.splice(i, 1);
    },
  };
}

test('each product drapes once, toggles off cleanly and swaps frames', async () => {
  for (const id of Object.keys(NOWCOAST_PRODUCTS)) {
    const collection = fakeCollection();
    let t = 1_000_000_000;
    const layer = createNowcoastLayer({
      id,
      cesium: fakeCesium(),
      host: () => ({ collection, kind: 'globe' }),
      now: () => t,
    });
    layer.init({});
    layer.enable();
    assert.equal(collection.layers.length, 1, id);
    const opts = collection.layers[0].provider.options;
    assert.match(opts.url, /^https:\/\/nowcoast\.noaa\.gov\/geoserver\/observations\//);
    assert.equal(opts.layers, NOWCOAST_PRODUCTS[id].layer);
    await layer.update();
    assert.equal(collection.layers.length, 1, 'same bucket keeps frame');
    t += 5 * 60_000;
    await layer.update();
    assert.equal(collection.layers.length, 2, 'new frame added before old retires');
    layer.disable();
    assert.equal(collection.layers.length, 0, 'disable removes every frame');
    layer.enable();
    layer.disable();
    assert.equal(collection.layers.length, 0);
    layer.destroy();
  }
  assert.equal(frameBucket(0), 0);
});

test('reports a hidden host instead of draping', () => {
  const layer = createNowcoastLayer({
    id: 'weather-radar',
    cesium: fakeCesium(),
    host: () => ({ collection: null, kind: 'none' }),
  });
  layer.init({});
  layer.enable();
  assert.match(layer.getStats().error, /choose a globe map/);
});
