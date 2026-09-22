import test from 'node:test';
import assert from 'node:assert/strict';
import { LayerLifecycle } from '../data/lifecycle.js';
import { LayerPresentation } from './layerPresentation.js';

test('user Data Layer enable with focus flies after the layer is on', async () => {
  const manager = new LayerLifecycle({});
  const focused = [];
  const prepared = [];
  const presentation = new LayerPresentation(manager, {
    requestRender() {},
    invalidateDetection() {},
    onUserLayerEnablePrepare: async (id) => {
      prepared.push({ id, enabled: manager.isEnabled(id) });
    },
    onUserLayerEnabled: async (id) => {
      focused.push({ id, enabled: manager.isEnabled(id) });
    },
  });
  manager.register({
    id: 'bikeshare',
    name: 'Bike Share',
    showInTogglePanel: true,
    icon: '🚲',
    source: 'GBFS',
    init() {},
    enable() {},
    disable() {},
    destroy() {},
    update() {
      return true;
    },
    getStats() {
      return { count: 0 };
    },
  });

  await presentation.panel.setEnabled('bikeshare', true, {
    origin: 'user',
    focus: true,
  });
  assert.deepEqual(prepared, [{ id: 'bikeshare', enabled: false }]);
  assert.deepEqual(focused, [{ id: 'bikeshare', enabled: true }]);

  focused.length = 0;
  prepared.length = 0;
  await presentation.panel.setEnabled('bikeshare', false, {
    origin: 'user',
    focus: false,
  });
  assert.deepEqual(focused, []);
  assert.deepEqual(prepared, []);

  await presentation.panel.setEnabled('bikeshare', true, { origin: 'user' });
  assert.deepEqual(focused, []);
  assert.deepEqual(prepared, []);

  focused.length = 0;
  prepared.length = 0;
  await presentation.panel.focusLayer('bikeshare');
  assert.deepEqual(prepared, [{ id: 'bikeshare', enabled: true }]);
  assert.deepEqual(focused, [{ id: 'bikeshare', enabled: true }]);

  presentation.destroy();
  await manager.destroyAll();
});

test('a slow layer enable cannot move the camera after a newer layer click', async () => {
  let finishFirst;
  const enabled = new Set(),
    focused = [];
  const manager = {
    subscribeActivity: () => () => {},
    getAll: () => [],
    isEnabled: (id) => enabled.has(id),
    async setEnabled(id) {
      if (id === 'first')
        await new Promise((resolve) => {
          finishFirst = resolve;
        });
      enabled.add(id);
      return true;
    },
  };
  const presentation = new LayerPresentation(manager, {
    onUserLayerEnabled: (id) => focused.push(id),
  });
  const first = presentation.panel.setEnabled('first', true, {
    origin: 'user',
    focus: true,
  });
  await new Promise((resolve) => setImmediate(resolve));
  await presentation.panel.setEnabled('second', true, {
    origin: 'user',
    focus: true,
  });
  finishFirst();
  await first;
  assert.deepEqual(focused, ['second']);
  presentation.destroy();
});
