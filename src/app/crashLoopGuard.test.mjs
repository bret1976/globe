import test from 'node:test';
import assert from 'node:assert/strict';
import { BOOT_MARKER_KEY, BOOT_STABLE_MS, layerRestorePacing, startBootCrashGuard, planLocalLayerRestore, isSafeBootRequested } from './crashLoopGuard.js';

function store() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m };
}

test('a boot that never reached stable marks the next boot as recovering', () => {
  const s = store();
  let timer = null;
  const first = startBootCrashGuard({ storage: s, now: () => 1_000, setTimer: (fn) => { timer = fn; }, win: null });
  assert.equal(first.recovering, false);
  assert.ok(s.m.has(BOOT_MARKER_KEY), 'marker written during boot');
  // Page dies here (no stable timer, no pagehide). Next load:
  const second = startBootCrashGuard({ storage: s, now: () => 30_000, setTimer: () => {}, win: null });
  assert.equal(second.recovering, true);
  assert.equal(typeof timer, 'function');
});

test('a stable boot or clean pagehide clears the marker', () => {
  const s = store();
  let stable = null; let ms = 0;
  startBootCrashGuard({ storage: s, now: () => 1_000, setTimer: (fn, t) => { stable = fn; ms = t; }, win: null });
  assert.equal(ms, BOOT_STABLE_MS);
  stable();
  assert.equal(s.m.has(BOOT_MARKER_KEY), false);
  assert.equal(startBootCrashGuard({ storage: s, now: () => 2_000, setTimer: () => {}, win: null }).recovering, false);
  const listeners = {};
  const win = { addEventListener: (n, fn) => { listeners[n] = fn; } };
  const s2 = store();
  startBootCrashGuard({ storage: s2, now: () => 1, setTimer: () => {}, win });
  listeners.pagehide();
  assert.equal(s2.m.has(BOOT_MARKER_KEY), false);
});

test('stale markers and broken storage do not trigger recovery', () => {
  const s = store();
  s.setItem(BOOT_MARKER_KEY, 1);
  assert.equal(startBootCrashGuard({ storage: s, now: () => 60 * 60_000, setTimer: () => {}, win: null }).recovering, false);
  const broken = { getItem() { throw new Error('x'); }, setItem() { throw new Error('x'); }, removeItem() { throw new Error('x'); } };
  assert.equal(startBootCrashGuard({ storage: broken, setTimer: () => {}, win: null }).recovering, false);
});

test('desktop keeps the parallel restore; phones stagger, more when recovering', () => {
  assert.deepEqual(layerRestorePacing({ constrained: false, recovering: true }), { stepMs: 1500, gapMs: 400 });
  const normal = layerRestorePacing({ constrained: true, recovering: false });
  const gentle = layerRestorePacing({ constrained: true, recovering: true });
  assert.ok(normal.stepMs > 0 && gentle.stepMs > normal.stepMs && gentle.gapMs > normal.gapMs);
});

test('planLocalLayerRestore caps auto-restore and defers the rest', () => {
  const raw = JSON.stringify({ v: 2, l: ['a', 'b', 'c', 'd', 'e', 'f', 'g'], o: { x: 1 } });
  const plan = planLocalLayerRestore({ raw, cap: 5 });
  assert.equal(plan.changed, true);
  assert.deepEqual(JSON.parse(plan.raw), { v: 2, l: ['a', 'b', 'c', 'd', 'e'], o: { x: 1 } });
  assert.deepEqual(plan.deferred, ['f', 'g']);
  assert.equal(planLocalLayerRestore({ raw: JSON.stringify({ v: 2, l: ['a'] }) }).changed, false);
});

test('planLocalLayerRestore starts empty after a crashed boot and clears on safe', () => {
  const raw = JSON.stringify({ v: 2, l: ['a', 'b'], o: {} });
  const rec = planLocalLayerRestore({ raw, recovering: true });
  assert.deepEqual(JSON.parse(rec.raw).l, []);
  assert.deepEqual(rec.deferred, ['a', 'b']);
  const safe = planLocalLayerRestore({ raw, safe: true });
  assert.equal(safe.raw, null);
  assert.deepEqual(safe.deferred, []);
  assert.deepEqual(planLocalLayerRestore({ raw: 'garbage' }).deferred, []);
});

test('isSafeBootRequested reads ?safe=1', () => {
  assert.equal(isSafeBootRequested({ search: '?safe=1' }), true);
  assert.equal(isSafeBootRequested({ search: '?x=1' }), false);
  assert.equal(isSafeBootRequested(null), false);
});
