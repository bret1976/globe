import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeNdbcBuoys,
  parseNdbcObsLine,
  ndbcIntensityRank,
  ndbcIntensityColorCss,
} from './parse.js';

const SAMPLE = `#STN       LAT      LON  YYYY MM DD hh mm WDIR WSPD   GST WVHT  DPD APD MWD   PRES  PTDY  ATMP  WTMP  DEWP  VIS   TIDE
#text      deg      deg   yr mo day hr mn degT  m/s   m/s   m   sec sec degT   hPa   hPa  degC  degC  degC  nmi     ft
41008     31.402  -80.866 2026 10 02 13 00 180  12.0  15.0  2.0  8.0 5.0 180 1015.0   0.5  24.0  26.0  20.0   MM     MM
46026     37.759 -122.839 2026 10 02 13 30 270   3.0   MM  0.4   MM  MM  MM 1018.2    MM  16.0  15.5    MM   MM     MM
BADROW    91.000  200.000 2026 10 02 13 00  MM    MM    MM   MM  MM   MM  MM     MM    MM    MM    MM    MM   MM     MM
EMPTY0     0.000    0.000 2026 10 02 13 00  MM    MM    MM   MM  MM   MM  MM     MM    MM    MM    MM    MM   MM     MM
NOOBS     10.000  -20.000 2026 10 02 13 00  MM    MM    MM   MM  MM   MM  MM     MM    MM    MM    MM    MM   MM     MM
`;

test('parseNdbcObsLine reads wind wave temp fields', () => {
  const row = parseNdbcObsLine(
    '41008     31.402  -80.866 2026 10 02 13 00 180  12.0  15.0  2.0  8.0 5.0 180 1015.0   0.5  24.0  26.0  20.0   MM     MM',
  );
  assert.ok(row);
  assert.equal(row.station, '41008');
  assert.equal(row.lat, 31.402);
  assert.equal(row.lon, -80.866);
  assert.equal(row.wspd, 12);
  assert.equal(row.wvht, 2);
  assert.equal(row.wtmp, 26);
  assert.equal(row.observedAt, '2026-10-02T13:00:00Z');
  assert.ok(row.intensityRank >= 2);
});

test('parseNdbcObsLine rejects bad coords and empty obs', () => {
  assert.equal(
    parseNdbcObsLine(
      'BADROW    91.000  200.000 2026 10 02 13 00  MM    MM    MM   MM  MM   MM  MM     MM    MM    MM    MM    MM   MM     MM',
    ),
    null,
  );
  assert.equal(
    parseNdbcObsLine(
      'EMPTY0     0.000    0.000 2026 10 02 13 00  MM    MM    MM   MM  MM   MM  MM     MM    MM    MM    MM    MM   MM     MM',
    ),
    null,
  );
  assert.equal(
    parseNdbcObsLine(
      'NOOBS     10.000  -20.000 2026 10 02 13 00  MM    MM    MM   MM  MM   MM  MM     MM    MM    MM    MM    MM   MM     MM',
    ),
    null,
  );
});

test('normalizeNdbcBuoys ranks by intensity and skips junk', () => {
  const rows = normalizeNdbcBuoys(SAMPLE);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].station, '41008');
  assert.ok(rows[0].intensityRank >= rows[1].intensityRank);
});

test('ndbcIntensity helpers', () => {
  assert.equal(ndbcIntensityRank({ wspd: 22, wvht: null }), 4);
  assert.equal(ndbcIntensityRank({ wspd: null, wvht: 0.2 }), 0);
  assert.equal(ndbcIntensityColorCss(4), '#00EEFF');
  assert.equal(ndbcIntensityColorCss(0), '#4A7088');
});
