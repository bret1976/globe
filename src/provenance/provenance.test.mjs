import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LAYER_PROVENANCE,
  PROVENANCE_KINDS,
  formatAge,
  rawFieldRows,
  resolveProvenance,
  stampSource,
  toEpochMs,
} from './provenance.js';
import { DATA_CREDITS, FZ1073_CREDIT, BHOTE_KOSHI_CREDIT, BHOTE_KOSHI_LOCATOR_CREDIT, TOMTOM_CREDIT } from '../data/dataCredits.js';
import { describeSourceItem } from '../ui/sourceInspector.js';

test('every layer default is one of observed / inferred / simulated', () => {
  for (const [id, entry] of Object.entries(LAYER_PROVENANCE))
    assert.ok(PROVENANCE_KINDS.includes(entry.kind), id);
});

test('every creditKey points at a real attribution entry', () => {
  const keys = new Set([...DATA_CREDITS, FZ1073_CREDIT, BHOTE_KOSHI_CREDIT, BHOTE_KOSHI_LOCATOR_CREDIT, TOMTOM_CREDIT].map((c) => c?.key));
  for (const [id, entry] of Object.entries(LAYER_PROVENANCE))
    if (entry.creditKey) assert.ok(keys.has(entry.creditKey), `${id} → ${entry.creditKey}`);
});

test('the existing ad-hoc labels map onto the badge', () => {
  assert.equal(resolveProvenance({ layerId: 'rocket-launches', properties: { ascent: 'RECONSTRUCTED ESTIMATE' } }).kind, 'inferred');
  assert.equal(resolveProvenance({ layerId: 'rocket-launches' }).kind, 'observed');
  assert.equal(resolveProvenance({ layerId: 'cctv', properties: { calBadge: 'raw-prior' } }).kind, 'inferred');
  assert.equal(resolveProvenance({ layerId: 'cctv' }).kind, 'observed');
  assert.equal(resolveProvenance({ layerId: 'traffic' }).kind, 'simulated');
  assert.equal(resolveProvenance({ layerId: 'traffic', properties: { flowLive: true } }).kind, 'observed');
  const jam = resolveProvenance({ layerId: 'gps-interference' });
  assert.equal(jam.kind, 'inferred');
  assert.match(jam.reason, /Potential interference/);
  assert.equal(resolveProvenance({ layerId: 'went-dark' }).label, 'INFERRED');
  assert.equal(resolveProvenance({ layerId: 'satellites' }).kind, 'inferred');
});

test('record-level provenance and provider override the layer default', () => {
  const r = resolveProvenance({ layerId: 'flights', properties: { provenance: 'SIMULATED', provider: 'Test rig' } });
  assert.equal(r.kind, 'simulated');
  assert.equal(r.provider, 'Test rig');
  assert.equal(resolveProvenance({ layerId: 'nope' }).provider, 'Unknown source');
});

test('stampSource is additive and never overwrites provider fields', () => {
  assert.deepEqual(stampSource({ a: 1 }, { provider: 'X', fetchedAt: 1_700_000_000 }), { a: 1, provider: 'X', fetchedAt: 1_700_000_000_000 });
  assert.deepEqual(stampSource({ provider: 'Y', fetchedAt: 5 }, { provider: 'X', fetchedAt: 9e12 }), { provider: 'Y', fetchedAt: 5 });
  assert.equal(toEpochMs('2026-10-25T00:00:00Z'), Date.parse('2026-10-25T00:00:00Z'));
  assert.equal(toEpochMs('garbage'), null);
});

test('ages and raw rows render plainly', () => {
  assert.equal(formatAge(0, 2000), 'just now');
  assert.equal(formatAge(0, 90_000), '2 min ago');
  assert.equal(formatAge(null), 'unknown');
  const rows = rawFieldRows({ a: 1, b: { c: 2 }, f() {}, long: 'x'.repeat(500) }, { maxChars: 10 });
  assert.deepEqual(rows.slice(0, 2), [['a', '1'], ['b', '{"c":2}']]);
  assert.equal(rows.find(([k]) => k === 'f'), undefined);
  assert.equal(rows.find(([k]) => k === 'long')[1].length, 10);
});

test('the Source panel shows provider, record age, licence and raw fields', () => {
  const d = describeSourceItem({
    layerId: 'gps-interference',
    label: 'hex 8a2a',
    fetchedAt: 1_800_000_000_000,
    properties: { level: 'high', _private: 1, provider: 'gpsjam.org' },
  });
  assert.equal(d.badge.kind, 'inferred');
  assert.equal(d.provider, 'gpsjam.org');
  assert.equal(d.fetchedBasis, 'record');
  assert.ok(d.credit && d.credit.length > 0);
  assert.deepEqual(d.rawRows.map(([k]) => k).includes('_private'), false);
  const fallback = describeSourceItem({ layerId: 'earthquakes', properties: {} }, { layerInfo: { name: 'Quakes', stats: { lastUpdate: 1_800_000_000_000 } } });
  assert.equal(fallback.fetchedBasis, 'layer');
  assert.equal(describeSourceItem({ layerId: 'earthquakes' }).fetchedBasis, 'unknown');
});
