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
  await presentation.panel.focusLayer('bikeshare');
  assert.deepEqual(focused, [{ id: 'bikeshare', enabled: true }]);

  presentation.destroy();
  await manager.destroyAll();
});
