import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseAirportStatusXml,
  arptToIcao,
  airportDelayKind,
  airportDelayColorCss,
  awcAirportLookupUrl,
  indexAwcAirports,
  attachAirportCoords,
  normalizeAirportDelays,
  FAA_AIRPORT_STATUS_URL,
  countAirportDelayKinds,
} from './parse.js';
import { airportDelaysProxy } from '../../../server/providers/airportDelays.js';

const SAMPLE_XML = `<?xml version="1.0"?>
<AIRPORT_STATUS_INFORMATION>
  <Update_Time>Sat Oct 10 14:12:42 2026 GMT</Update_Time>
  <Delay_type>
    <Name>Airport Closures</Name>
    <Airport_Closure_List>
      <Airport>
        <ARPT>PNS</ARPT>
        <Reason>!PNS CLOSED EXC HEL</Reason>
        <Start>Oct 10 at 13:39 UTC.</Start>
        <Reopen>Oct 10 at 22:00 UTC.</Reopen>
      </Airport>
      <Airport>
        <ARPT>LAX</ARPT>
        <Reason>!LAX GA CLOSED</Reason>
        <Start>May 27 at 18:26 UTC.</Start>
        <Reopen>May 28 at 16:00 UTC.</Reopen>
      </Airport>
    </Airport_Closure_List>
  </Delay_type>
  <Delay_type>
    <Name>Ground Stop</Name>
    <Ground_Stop_List>
      <Airport>
        <ARPT>PHL</ARPT>
        <Reason>WX</Reason>
        <End>Oct 10 at 16:00 UTC.</End>
      </Airport>
    </Ground_Stop_List>
  </Delay_type>
  <Delay_type>
    <Name>Arrival/Departure Delay</Name>
    <Delay_List>
      <Airport>
        <ARPT>SAN</ARPT>
        <Reason>VOLUME</Reason>
        <Start>Oct 10 at 12:00 UTC.</Start>
      </Airport>
    </Delay_List>
  </Delay_type>
</AIRPORT_STATUS_INFORMATION>`;

test('ARPT to ICAO and kind/color mapping', () => {
  assert.equal(arptToIcao('lax'), 'KLAX');
  assert.equal(arptToIcao('KLAX'), 'KLAX');
  assert.equal(arptToIcao(''), null);
  assert.equal(airportDelayKind('Airport Closures'), 'closure');
  assert.equal(airportDelayKind('Ground Stop'), 'ground_stop');
  assert.equal(airportDelayKind('Ground Delay'), 'ground_delay');
  assert.equal(airportDelayKind('Arrival/Departure Delay'), 'delay');
  assert.equal(airportDelayColorCss('closure'), '#ff3b3b');
  assert.match(FAA_AIRPORT_STATUS_URL, /nasstatus\.faa\.gov/);
});

test('parseAirportStatusXml extracts airports across delay types', () => {
  const records = parseAirportStatusXml(SAMPLE_XML);
  assert.equal(records.length, 4);
  const pns = records.find((r) => r.arpt === 'PNS');
  assert.equal(pns.icao, 'KPNS');
  assert.equal(pns.kind, 'closure');
  assert.ok(pns.reason.includes('CLOSED'));
  assert.ok(pns.start.includes('13:39'));
  assert.equal(records.find((r) => r.arpt === 'PHL').kind, 'ground_stop');
  assert.equal(records.find((r) => r.arpt === 'SAN').kind, 'delay');
  assert.deepEqual(parseAirportStatusXml(''), []);
});

test('AWC index + attach coords skips missing and sorts by severity', () => {
  const records = parseAirportStatusXml(SAMPLE_XML);
  const indexed = indexAwcAirports([
    { icaoId: 'KPNS', lat: 30.47, lon: -87.19, name: 'PENSACOLA' },
    { icaoId: 'KLAX', lat: 33.94, lon: -118.41, name: 'LOS ANGELES' },
    { icaoId: 'KPHL', lat: 39.87, lon: -75.24, name: 'PHILADELPHIA' },
    // SAN missing on purpose
  ]);
  assert.equal(indexed.size, 3);
  const rows = attachAirportCoords(records, indexed);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].kind, 'closure');
  assert.ok(Number.isFinite(rows[0].lat) && Number.isFinite(rows[0].lon));
  assert.equal(rows.some((r) => r.arpt === 'SAN'), false);
  assert.match(awcAirportLookupUrl(['KLAX', 'KPHL']), /ids=KLAX%2CKPHL|ids=KLAX,KPHL/);
  assert.equal(countAirportDelayKinds(rows).closure, 2);
});

test('normalizeAirportDelays end-to-end with fixture XML', () => {
  const coords = indexAwcAirports([
    { icaoId: 'KPNS', lat: 30.47, lon: -87.19 },
    { icaoId: 'KLAX', lat: 33.94, lon: -118.41 },
    { icaoId: 'KPHL', lat: 39.87, lon: -75.24 },
    { icaoId: 'KSAN', lat: 32.73, lon: -117.19 },
  ]);
  const rows = normalizeAirportDelays(SAMPLE_XML, coords);
  assert.equal(rows.length, 4);
  assert.ok(rows.every((r) => Number.isFinite(r.lat) && Number.isFinite(r.lon)));
});

function harness(fetchImpl, clock = { t: 1_000_000 }) {
  const plugin = airportDelaysProxy({
    fetchImpl,
    now: () => clock.t,
    sleep: async () => {},
  });
  let handler;
  plugin.configureServer({
    middlewares: {
      use(path, fn) {
        assert.equal(path, '/api/airport-delays');
        handler = fn;
      },
    },
  });
  const call = () =>
    new Promise((resolve) => {
      const res = {
        headersSent: false,
        destroyed: false,
        status: 0,
        body: null,
        headers: {},
        writeHead(status, headers) {
          this.status = status;
          this.headers = headers;
        },
        end(body) {
          this.body = JSON.parse(body);
          resolve(this);
        },
      };
      handler({ method: 'GET' }, res, () => resolve({ status: 'next' }));
    });
  return { call, clock };
}

test('airportDelaysProxy resolves AWC coords and caches TTL', async () => {
  let faaHits = 0;
  let awcHits = 0;
  const { call, clock } = harness(async (url) => {
    const u = String(url);
    if (u.includes('nasstatus.faa.gov')) {
      faaHits += 1;
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => SAMPLE_XML,
      };
    }
    if (u.includes('aviationweather.gov')) {
      awcHits += 1;
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => [
          { icaoId: 'KPNS', lat: 30.47, lon: -87.19, name: 'PNS' },
          { icaoId: 'KLAX', lat: 33.94, lon: -118.41, name: 'LAX' },
          { icaoId: 'KPHL', lat: 39.87, lon: -75.24, name: 'PHL' },
          { icaoId: 'KSAN', lat: 32.73, lon: -117.19, name: 'SAN' },
        ],
      };
    }
    throw new Error(`unexpected url ${u}`);
  });
  const a = await call();
  assert.equal(a.status, 200);
  assert.equal(a.body.count, 4);
  assert.ok(a.body.rows.every((r) => Number.isFinite(r.lat)));
  assert.equal(faaHits, 1);
  assert.equal(awcHits, 1);
  const b = await call();
  assert.equal(b.status, 200);
  assert.equal(faaHits, 1, 'TTL cache');
  clock.t += 3 * 60_000;
  await call();
  assert.equal(faaHits, 2);
  assert.equal(awcHits, 1, '24h coord cache reused');
});
