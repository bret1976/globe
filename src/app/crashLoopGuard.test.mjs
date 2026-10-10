import test from 'node:test';
import assert from 'node:assert/strict';
import { BOOT_MARKER_KEY, BOOT_STABLE_MS, layerRestorePacing, startBootCrashGuard } from './crashLoopGuard.js';

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
  assert.equal(layerRestorePacing({ constrained: false, recovering: true }), null);
  const normal = layerRestorePacing({ constrained: true, recovering: false });
  const gentle = layerRestorePacing({ constrained: true, recovering: true });
  assert.ok(normal.stepMs > 0 && gentle.stepMs > normal.stepMs && gentle.gapMs > normal.gapMs);
});
