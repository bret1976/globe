import test from 'node:test';
import assert from 'node:assert/strict';
import { createMilAircraftWatcher, MIL_POLL_MS, MIL_BACKOFF_MIN_MS } from './milAircraft.js';
import { adsbLolTake, adsbLolBudget, resetAdsbLolGate, ADSBLOL_DAILY_BUDGET, ADSBLOL_INTERACTIVE_DAILY, sharedAdsbLolMilBody } from '../providers/aircraft/adsbLolGate.js';

const memStore = () => ({ register: () => null });
const T0 = 1_800_000_000_000;

test('daily budget: rolling 24 h cap, small interactive slice, frees after a day', () => {
  resetAdsbLolGate();
  let t = T0;
  for (let i = 0; i < ADSBLOL_INTERACTIVE_DAILY; i += 1) assert.equal(adsbLolTake({ interactive: true }, t++), true);
  assert.equal(adsbLolTake({ interactive: true }, t), false);
  while (adsbLolBudget(t).used < ADSBLOL_DAILY_BUDGET) assert.equal(adsbLolTake({}, t++), true);
  assert.equal(adsbLolTake({}, t), false);
  assert.ok(ADSBLOL_DAILY_BUDGET < 500);
  assert.equal(adsbLolTake({}, T0 + 86_400_001), true);
});

test('military poller: 5 min cadence, honours Retry-After, backs off without hammering', async () => {
  resetAdsbLolGate();
  assert.equal(MIL_POLL_MS, 5 * 60_000);
  let t = T0;
  let calls = 0;
  let status = 429;
  let retryAfter = '1800';
  const fetchImpl = async () => {
    calls += 1;
    if (status === 429) return { ok: false, status, headers: new Headers(retryAfter ? { 'retry-after': retryAfter } : {}), body: null };
    return { ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify({ now: t, ac: [] }) };
  };
  const w = createMilAircraftWatcher({ fetchImpl, store: memStore(), now: () => t, random: () => 0.5 });
  assert.equal(await w.pollOnce(), false);
  assert.equal(calls, 1);
  const s = w.snapshot();
  assert.equal(s.backoffUntil, T0 + 1_800_000);
  assert.equal(s.rateLimited.count429, 1);
  t += 20 * 60_000; // still inside Retry-After: no request
  assert.equal(await w.pollOnce(), false);
  assert.equal(calls, 1);
  t = T0 + 1_800_001; retryAfter = null; resetAdsbLolGate();
  assert.equal(await w.pollOnce(), false); // second 429, no header: doubled default
  assert.equal(w.snapshot().backoffUntil, t + 2 * MIL_BACKOFF_MIN_MS);
  t += 2 * MIL_BACKOFF_MIN_MS + 1; status = 200; resetAdsbLolGate();
  assert.equal(await w.pollOnce(), true);
  assert.equal(w.snapshot().lastError, null);
  assert.ok(sharedAdsbLolMilBody());
  assert.equal(w.snapshot().adsbLolBudget.used, 1);
});
