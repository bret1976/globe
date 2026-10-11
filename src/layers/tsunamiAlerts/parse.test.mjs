import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeTsunamiRows,
  normalizeTsunamiAtom,
  normalizeTsunamiCategory,
  parseTsunamiEntry,
  tsunamiCategoryColorCss,
} from './parse.js';

const SAMPLE_ENTRY = `
<title>in Panama</title><updated>2026-10-09T20:37:44Z</updated>
<geo:lat>7.800</geo:lat>
<geo:long>-81.400</geo:long>
<summary type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml">
     <strong>Category:</strong> Information<br/><strong>Bulletin Issue Time: </strong> 2026.10.09 20:37:44 UTC <br/><strong>Preliminary Magnitude: </strong>6.9(Mwp)<br/><strong>Lat/Lon: </strong>7.800 / -81.400<br/><strong>Affected Region: </strong>in Panama<br/>
</div></summary>
    <id>urn:uuid:31715b06-fb43-4add-9ef7-53bb4433fd6a</id>
<link rel="alternate" title="Bulletin" href="https://www.tsunami.gov/events/PAAQ/2026/10/09/tmnq2s/1/WEAK53/WEAK53.txt" type="application/xml" />
`;

const SAMPLE_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:geo="http://www.w3.org/2003/01/geo/wgs84_pos#">
<entry>${SAMPLE_ENTRY}</entry>
<entry>
<title>WARNING TEST</title><updated>2026-10-08T12:00:00Z</updated>
<geo:lat>35.1</geo:lat>
<geo:long>139.2</geo:long>
<summary><strong>Category:</strong> Warning<br/><strong>Preliminary Magnitude: </strong>7.2<br/><strong>Affected Region: </strong>Japan</summary>
<id>urn:uuid:warning-test</id>
</entry>
</feed>`;

test('normalizeTsunamiCategory maps bulletin wording', () => {
  assert.equal(normalizeTsunamiCategory('Warning'), 'Warning');
  assert.equal(normalizeTsunamiCategory('Tsunami Advisory'), 'Advisory');
  assert.equal(normalizeTsunamiCategory('WATCH'), 'Watch');
  assert.equal(normalizeTsunamiCategory('Information'), 'Information');
  assert.equal(normalizeTsunamiCategory(''), 'Unknown');
});

test('parseTsunamiEntry extracts geo + magnitude', () => {
  const row = parseTsunamiEntry(SAMPLE_ENTRY, { center: 'PAAQ' });
  assert.equal(row.lat, 7.8);
  assert.equal(row.lon, -81.4);
  assert.equal(row.category, 'Information');
  assert.equal(row.magnitude, 6.9);
  assert.equal(row.center, 'PAAQ');
  assert.match(row.link, /WEAK53\.txt$/);
  assert.equal(row.issuedAt, '2026-10-09T20:37:44.000Z');
});

test('parseTsunamiEntry drops bad geometry', () => {
  assert.equal(parseTsunamiEntry('<title>x</title>', { center: 'PAAQ' }), null);
  assert.equal(
    parseTsunamiEntry('<geo:lat>999</geo:lat><geo:long>1</geo:long>', {
      center: 'PAAQ',
    }),
    null,
  );
});

test('normalizeTsunamiAtom ranks Warning above Information', () => {
  const rows = normalizeTsunamiAtom(SAMPLE_FEED, { center: 'PHEB' });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].category, 'Warning');
  assert.equal(rows[0].region, 'Japan');
  assert.equal(rows[1].category, 'Information');
  assert.equal(tsunamiCategoryColorCss('Warning'), '#FF1144');
});

test('mergeTsunamiRows dedupes near-duplicate epicenters', () => {
  const a = normalizeTsunamiAtom(SAMPLE_FEED, { center: 'PAAQ' });
  const b = normalizeTsunamiAtom(SAMPLE_FEED, { center: 'PHEB' });
  const merged = mergeTsunamiRows([a, b]);
  assert.equal(merged.length, 2);
  assert.ok(merged.every((row) => Number.isFinite(row.lat)));
});
