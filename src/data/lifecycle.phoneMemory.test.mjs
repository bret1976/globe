import test from 'node:test';
import assert from 'node:assert/strict';
import { LayerLifecycle } from './lifecycle.js';

function fakeLayer(id, log) {
  return {
    id,
    name: id,
    updateInterval: 60000,
    init() { log.push(`init:${id}`); },
    enable() { log.push(`enable:${id}`); return true; },
    update() { return true; },
    disable() { log.push(`disable:${id}`); },
    destroy() { log.push(`destroy:${id}`); },
  };
}

test('releaseOnDisable destroys on toggle-off and re-inits on the next enable', async () => {
  const log = [];
  const m = new LayerLifecycle({}, { releaseOnDisable: true });
  m.register(fakeLayer('a', log));
  await m.setEnabled('a', true);
  await m.setEnabled('a', false);
  await m.setEnabled('a', true);
  await m.setEnabled('a', false);
  assert.deepEqual(log, ['init:a', 'enable:a', 'disable:a', 'destroy:a', 'init:a', 'enable:a', 'disable:a', 'destroy:a']);
  await m.destroyAll();
});

test('default (desktop) keeps disabled layers initialized', async () => {
  const log = [];
  const m = new LayerLifecycle({});
  m.register(fakeLayer('a', log));
  await m.setEnabled('a', true);
  await m.setEnabled('a', false);
  await m.setEnabled('a', true);
  assert.equal(log.filter((x) => x === 'init:a').length, 1);
  assert.ok(!log.includes('destroy:a'));
  await m.destroyAll();
});

test('maxActiveLayers turns off the least recently enabled layer', async () => {
  const log = [];
  const m = new LayerLifecycle({}, { maxActiveLayers: 2 });
  for (const id of ['a', 'b', 'c']) m.register(fakeLayer(id, log));
  await m.setEnabled('a', true);
  await m.setEnabled('b', true);
  await m.setEnabled('c', true);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(m.isEnabled('a'), false);
  assert.equal(m.isEnabled('b'), true);
  assert.equal(m.isEnabled('c'), true);
  await m.destroyAll();
});

test('releaseOnDisable as an id list only releases those layers', async () => {
  const log = [];
  const m = new LayerLifecycle({}, { releaseOnDisable: ['a'] });
  m.register(fakeLayer('a', log));
  m.register(fakeLayer('b', log));
  for (const id of ['a', 'b']) {
    await m.setEnabled(id, true);
    await m.setEnabled(id, false);
  }
  assert.ok(log.includes('destroy:a'));
  assert.ok(!log.includes('destroy:b'));
  await m.destroyAll();
});
