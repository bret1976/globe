import test from 'node:test';
import assert from 'node:assert/strict';
import { createSpcOutlookLayer, buildSpcOutlookCard } from './index.js';
import { formatSpcTime } from './cards.js';

const ring = [[-83, 31], [-80, 31], [-80, 34], [-83, 34]];
const ROWS = [
  { stableId: 'spc:d1:SLGT:0:a', day: 1, label: 'SLGT', label2: 'Slight Risk', issue: '2026-10-10T12:48:00+00:00', valid: '2026-10-10T13:00:00+00:00', expire: '2026-10-11T12:00:00+00:00', lat: 32.5, lon: -81.5, ring },
  { stableId: 'spc:d1:TSTM:0:b', day: 1, label: 'TSTM', label2: 'General Thunderstorms Risk', valid: '2026-10-10T13:00:00+00:00', lat: 32.6, lon: -81.6, ring },
  { stableId: 'spc:d2:MRGL:0:c', day: 2, label: 'MRGL', label2: 'Marginal Risk', lat: 32.7, lon: -81.7, ring },
];

function harness({ pick = () => null, drill = () => [] } = {}) {
  const overlay = { entries: new Map() };
  const clicks = { handler: null, destroyed: 0 };
  const sources = [];
  const viewer = {
    scene: { pick: (p) => pick(p), drillPick: (p, n) => drill(p, n) },
    dataSources: { add: (d) => sources.push(d), remove: () => {} },
  };
  const layer = createSpcOutlookLayer({
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

const entries = (h) => h.overlay.entries.get('spc-outlook') || [];
const card = (h) => entries(h).find((e) => String(e.id).startsWith('spc-outlook-card:'));

test('reload replaces entities for real so toggle-off hides everything (on→off→on→off)', async () => {
  const h = harness();
  const ds = h.sources[0];
  const events = [];
  ds.entities.collectionChanged.addEventListener((_c, added, removed) =>
    events.push({ added: added.length, removed: removed.length }),
  );
  h.layer.enable();
  await h.layer.update();
  const first = ds.entities.values.slice();
  h.layer.disable();
  h.layer.enable();
  await h.layer.update();
  // The second load must report the old entities as removed — a suspended
  // removeAll()+add() of identical ids cancels out and leaves visualizers
  // drawing the first-load Entity objects (the "ghost polygons" bug).
  const removedTotal = events.reduce((n, e) => n + e.removed, 0);
  assert.equal(removedTotal, ROWS.length);
  h.layer.disable();
  assert.equal(ds.show, false);
  for (const entity of ds.entities.values) assert.equal(entity.isShowing, false);
  for (const old of first) assert.equal(ds.entities.contains(old), false);
});

test('tap selects the highest-risk polygon under the finger and shows its card', async () => {
  let picked = null;
  let drilled = [];
  const h = harness({ pick: () => picked, drill: () => drilled });
  h.layer.enable();
  await h.layer.update();
  assert.deepEqual(entries(h).map((e) => e.title), ['Day 1 · Slight Risk']);
  picked = { id: 'spc-outlook:spc:d1:TSTM:0:b' };
  drilled = [picked, { id: 'spc-outlook:spc:d2:MRGL:0:c' }, { id: 'spc-outlook:spc:d1:SLGT:0:a' }];
  h.clicks.handler({ position: { x: 5, y: 5 } });
  assert.equal(card(h).title, 'SPC · Day 1 · Slight Risk');
  // The selected polygon's ambient label yields to its card.
  assert.equal(entries(h).filter((e) => e.title === 'Day 1 · Slight Risk').length, 0);
  drilled = [];
  picked = { id: 'spc-outlook:spc:d2:MRGL:0:c' };
  h.clicks.handler({ position: { x: 5, y: 5 } });
  assert.equal(card(h).title, 'SPC · Day 2 · Marginal Risk');
  picked = { id: 'other:x' };
  h.clicks.handler({ position: { x: 5, y: 5 } });
  assert.ok(card(h));
  picked = null;
  h.clicks.handler({ position: { x: 5, y: 5 } });
  assert.equal(card(h), undefined);
  h.layer.disable();
  assert.equal(h.clicks.destroyed, 1);
  assert.equal(h.overlay.entries.has('spc-outlook'), false);
});

test('SPC card content', () => {
  const c = buildSpcOutlookCard(ROWS[0]);
  assert.equal(c.title, 'SPC · Day 1 · Slight Risk');
  assert.equal(c.selected, true);
  assert.equal(c.interactive, false);
  assert.deepEqual(c.details, [
    'SLGT · severe level 2 of 5 · categorical outlook',
    'valid Oct 10 13:00 UTC – Oct 11 12:00 UTC',
    'issued Oct 10 12:48 UTC',
    'NOAA/NWS Storm Prediction Center',
  ]);
  assert.match(buildSpcOutlookCard(ROWS[1]).details[0], /general thunder/);
  assert.equal(buildSpcOutlookCard(ROWS[1]).details[1], 'valid from Oct 10 13:00 UTC');
  assert.equal(formatSpcTime('nope'), null);
});
