import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGpsjamCsv, latestGpsjamDate } from './parse.js';

test('latestGpsjamDate picks newest row', () => {
  const manifest = `date,suspect,num_bad_aircraft_hexes,source
2026-09-24,false,1,merged
2026-09-25,false,2,merged
2026-09-20,false,9,merged
`;
  assert.equal(latestGpsjamDate(manifest), '2026-09-25');
});

test('parseGpsjamCsv classifies medium/high with FAQ formula', () => {
  const csv = `hex,count_good_aircraft,count_bad_aircraft
840135dffffffff,10,5
8413609ffffffff,100,0
8429a47ffffffff,3,0
84deadbeef00001,1,1
`;
  const { rows, skippedLowSample, skippedLow } = parseGpsjamCsv(csv);
  assert.equal(skippedLowSample, 1); // 1+1 < 3
  assert.ok(skippedLow >= 1);
  const high = rows.find((r) => r.h3 === '840135dffffffff');
  assert.ok(high);
  assert.equal(high.level, 'high');
  // 100*(5-1)/15 = 26.666… → 26.7
  assert.equal(high.pct, 26.7);
});
