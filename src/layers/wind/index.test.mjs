import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HIDE_BELOW_M,
  WIND_ZOOM_OUT_MESSAGE,
  createWindLayer,
} from './index.js';

test('wind reports zoom-out guidance at street level instead of looking broken', async () => {
  const layer = createWindLayer({
    source: {
      getSnapshot: async () => ({
        samples: [{ lat: 30, lon: -97, speed: 20, direction: 90 }],
      }),
    },
  });
  const viewer = {
    dataSources: {
      add() {},
      remove() {},
    },
    camera: {
      positionCartographic: { height: 600 },
      moveEnd: { addEventListener() {} },
    },
  };
  layer.init(viewer);
  layer.enable();
  await layer.update();
  const stats = layer.getStats();
  assert.equal(stats.count, 1);
  assert.equal(stats.error, null);
  assert.equal(stats.status, 'zoom-out');
  assert.equal(stats.statusMessage, WIND_ZOOM_OUT_MESSAGE);
  assert.ok(HIDE_BELOW_M > 600);
  layer.destroy(viewer);
});
