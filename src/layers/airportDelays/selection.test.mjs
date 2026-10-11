import test from 'node:test';
import assert from 'node:assert/strict';
import { createAirportDelaysLayer } from './index.js';

const ROWS = [
  { stableId: 'ad:restriction:KLAX:a', arpt: 'LAX', icao: 'KLAX', kind: 'restriction', delayType: 'Airport Closures', reason: '!LAX 05/277 LAX AD AP CLSD TO GA 2605271826-2705281600', startIso: '2026-05-27T18:26:00Z', endIso: '2027-05-28T16:00:00Z', name: 'LOS ANGELES', lat: 33.94, lon: -118.41 },
  { stableId: 'ad:delay:KSFO:b', arpt: 'SFO', icao: 'KSFO', kind: 'delay', delayType: 'Delay', reason: 'VOLUME', lat: 37.6, lon: -122.4 },
];

function harness({ pick = () => null } = {}) {
  const overlay = { entries: new Map() };
  const clicks = { handler: null, destroyed: 0 };
  const sources = [];
  const viewer = {
    scene: { pick: (p) => pick(p) },
    dataSources: { add: (d) => sources.push(d), remove: () => {} },
  };
  const layer = createAirportDelaysLayer({
    source: { getSnapshot: async () => ({ rows: ROWS }) },
    overlayHost: {
      setEntries: (id, entries) => overlay.entries.set(id, entries),
      setVisible: () => {},
      clearSource: (id) => overlay.entries.delete(id),
    },
    screenSpaceEventHandlerFactory: () => ({
      setInputAction(cb) { clicks.handler = cb; },
      destroy() { clicks.destroyed += 1; clicks.handler = null; },
    }),
    picking: {
      resolvePickId: (picked) => picked?.id ?? null,
      isOwnedByOtherLayer: (_l, id) => String(id).startsWith('other:'),
    },
    pointer: { isPointerFree: () => true },
  });
  layer.init(viewer);
  return { layer, overlay, clicks, sources };
}

const entries = (h) => h.overlay.entries.get('airport-delays') || [];
const card = (h) => entries(h).find((e) => String(e.id).startsWith('airport-delay-card:'));

test('tap on an airport publishes its info card; empty tap clears it', async () => {
  let picked = null;
  const h = harness({ pick: () => picked });
  h.layer.enable();
  assert.equal(await h.layer.update(), true);
  // Restriction keeps an ambient label (look unchanged); plain delay does not.
  assert.deepEqual(entries(h).map((e) => e.title), ['LAX · Restriction']);
  picked = { id: 'airport-delay:ad:restriction:KLAX:a' };
  h.clicks.handler({ position: { x: 1, y: 1 } });
  assert.equal(card(h).title, 'AIRPORT · LAX · Restriction');
  // Card replaces that airport's ambient label instead of stacking on it.
  assert.equal(entries(h).filter((e) => e.title === 'LAX · Restriction').length, 0);
  picked = { id: 'other:aircraft' };
  h.clicks.handler({ position: { x: 1, y: 1 } });
  assert.ok(card(h), 'sibling-owned pick leaves selection alone');
  picked = null;
  h.clicks.handler({ position: { x: 1, y: 1 } });
  assert.equal(card(h), undefined);
  assert.equal(entries(h).length, 1);
});

test('selection survives refresh and is cleared with the click handler on disable', async () => {
  let picked = { id: 'airport-delay:ad:delay:KSFO:b' };
  const h = harness({ pick: () => picked });
  h.layer.enable();
  await h.layer.update();
  h.clicks.handler({ position: { x: 1, y: 1 } });
  assert.equal(card(h).title, 'AIRPORT · SFO · Delay');
  await h.layer.update();
  assert.equal(card(h).title, 'AIRPORT · SFO · Delay');
  h.layer.disable();
  assert.equal(h.clicks.destroyed, 1);
  assert.equal(h.clicks.handler, null);
  assert.equal(h.overlay.entries.has('airport-delays'), false);
  h.layer.enable();
  await h.layer.update();
  assert.equal(card(h), undefined, 'no stale card after re-enable');
});
