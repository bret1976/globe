import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizePowerPlants,
  powerPlantKind,
  powerPlantPixelSize,
  splitCsvLine,
} from './parse.js';

const HEADER =
  'country,country_long,name,gppd_idnr,capacity_mw,latitude,longitude,primary_fuel,other_fuel1,other_fuel2,other_fuel3,commissioning_year,owner';

test('csv split honors quotes', () => {
  assert.deepEqual(splitCsvLine('a,"b, c",d'), ['a', 'b, c', 'd']);
  assert.deepEqual(splitCsvLine('"say ""hi""",2'), ['say "hi"', '2']);
});

test('fuel kinds', () => {
  assert.equal(powerPlantKind('Coal'), 'coal');
  assert.equal(powerPlantKind('Nuclear'), 'nuclear');
  assert.equal(powerPlantKind('Wave and Tidal'), 'hydro');
  assert.equal(powerPlantKind('Mystery'), 'other');
  assert.ok(powerPlantPixelSize(6000) <= 18 && powerPlantPixelSize(250) > 5);
});

test('normalize filters by capacity and sorts largest first', () => {
  const csv = [
    HEADER,
    'USA,United States of America,"Palo Verde, Unit 1-3",USA0006008,3937.0,33.3881,-112.8617,Nuclear,,,,1986.0,Arizona Public Service',
    'AFG,Afghanistan,Small Hydro,GEODB1,33.0,32.32,65.11,Hydro,,,,,',
    'CHN,China,Three Gorges Dam,CHN0000001,22500.0,30.8235,111.0032,Hydro,,,,2003.0,',
    'XXX,Nowhere,Bad Coords,X1,900,999,0,Coal,,,,,',
  ].join('\n');
  const rows = normalizePowerPlants(csv);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].name, 'Three Gorges Dam');
  assert.equal(rows[1].name, 'Palo Verde, Unit 1-3');
  assert.equal(rows[1].commissioned, 1986);
  assert.equal(rows[1].kind, 'nuclear');
  assert.equal(rows[0].owner, null);
});
