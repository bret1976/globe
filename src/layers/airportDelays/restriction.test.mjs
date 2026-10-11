import test from 'node:test';
import assert from 'node:assert/strict';
import {
  refineAirportDelayKind,
  parseNotamRange,
  parseAirportStatusXml,
  attachAirportCoords,
  indexAwcAirports,
  airportDelayColorCss,
  airportDelayRank,
} from './parse.js';
import { buildAirportDelayCard, notamSummary, airportDelayLabel } from './cards.js';

// Live FAA reasons captured 2026-10-10.
const LAX =
  '!LAX 05/277 LAX AD AP CLSD TO NON SKED TRANSIENT GA ACFT EXC 24HR PPR CTC ATLANTIC AVIATION 310-258-9884 OR SIGNATURE AVIATION 310-410-9605 2605271826-2705281600';
const PHL =
  '!PHL 09/263 PHL AD AP CLSD TO NON SKED ACFT WINGSPAN MORE THAN 214FT AND TAIL HGT MORE THAN 66FT. 2609301806-2610311200';
const PNS = '!PNS 10/060 PNS AD AP CLSD EXC HEL 2HR \nPPR 850-903-1251 2610101339-2610102200EST';
const FULL = '!ABC 10/001 ABC AD AP CLSD 2610101200-2610111200';

test('partial-closure NOTAMs classify as restriction; full closures stay closure', () => {
  assert.equal(refineAirportDelayKind('closure', LAX), 'restriction');
  assert.equal(refineAirportDelayKind('closure', PHL), 'restriction');
  assert.equal(refineAirportDelayKind('closure', PNS), 'restriction');
  assert.equal(refineAirportDelayKind('closure', FULL), 'closure');
  assert.equal(refineAirportDelayKind('closure', null), 'closure');
  // Only closures are refined.
  assert.equal(refineAirportDelayKind('ground_stop', 'EXC LIFEGUARD'), 'ground_stop');
  // Existing palette reused (ground-delay amber); ranks below real delays.
  assert.equal(airportDelayColorCss('restriction'), airportDelayColorCss('ground_delay'));
  assert.ok(airportDelayRank('restriction') < airportDelayRank('delay'));
  assert.ok(airportDelayRank('restriction') > airportDelayRank('other'));
});

test('NOTAM range parses to full UTC dates with year', () => {
  assert.deepEqual(parseNotamRange(LAX), {
    startIso: '2026-05-27T18:26:00Z',
    endIso: '2027-05-28T16:00:00Z',
    endEstimated: false,
    permanent: false,
  });
  assert.deepEqual(parseNotamRange(PNS), {
    startIso: '2026-10-10T13:39:00Z',
    endIso: '2026-10-10T22:00:00Z',
    endEstimated: true,
    permanent: false,
  });
  assert.deepEqual(parseNotamRange('!X 1/1 X AD AP CLSD 2601011200-PERM'), {
    startIso: '2026-01-01T12:00:00Z',
    endIso: null,
    endEstimated: false,
    permanent: true,
  });
  const empty = { startIso: null, endIso: null, endEstimated: false, permanent: false };
  assert.deepEqual(parseNotamRange('WX'), empty);
  assert.deepEqual(parseNotamRange(null), empty);
  assert.deepEqual(parseNotamRange('X 2613011200-2613021200'), empty); // month 13
  assert.deepEqual(parseNotamRange('X 2602311200-2603011200'), empty); // Feb 31
  assert.deepEqual(parseNotamRange('X 2610111200-2610101200'), empty); // end < start
  // Phone numbers are not mistaken for ranges.
  assert.deepEqual(parseNotamRange('CTC 310-258-9884'), empty);
});

test('server rows carry restriction kind and ISO range', () => {
  const xml = `<AIRPORT_STATUS_INFORMATION><Delay_type><Name>Airport Closures</Name><Airport_Closure_List>
    <Airport><ARPT>LAX</ARPT><Reason>${LAX}</Reason><Start>May 27 at 18:26 UTC.</Start><Reopen>May 28 at 16:00 UTC.</Reopen></Airport>
  </Airport_Closure_List></Delay_type></AIRPORT_STATUS_INFORMATION>`;
  const rows = attachAirportCoords(
    parseAirportStatusXml(xml),
    indexAwcAirports([{ icaoId: 'KLAX', lat: 33.94, lon: -118.41, name: 'LOS ANGELES/LOS ANGELES INTL' }]),
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'restriction');
  assert.equal(rows[0].startIso, '2026-05-27T18:26:00Z');
  assert.equal(rows[0].endIso, '2027-05-28T16:00:00Z');
  assert.equal(rows[0].reopen, 'May 28 at 16:00 UTC.');
});

test('airport card shows year-qualified window and restriction wording', () => {
  const row = {
    stableId: 'ad:restriction:KLAX:x',
    arpt: 'LAX',
    icao: 'KLAX',
    kind: 'restriction',
    delayType: 'Airport Closures',
    reason: LAX,
    name: 'LOS ANGELES/LOS ANGELES INTL',
    ...parseNotamRange(LAX),
  };
  const card = buildAirportDelayCard(row);
  assert.equal(card.title, 'AIRPORT · LAX · Restriction');
  assert.equal(airportDelayLabel(row), 'LAX · Restriction');
  assert.equal(card.selected, true);
  assert.equal(card.interactive, false);
  assert.equal(card.accent, airportDelayColorCss('restriction'));
  assert.ok(card.details.includes('KLAX · Los Angeles/Los Angeles Intl'));
  assert.ok(card.details.some((d) => /partial — not a full closure/.test(d)));
  assert.ok(card.details.includes('from May 27, 2026 18:26 UTC · until May 28, 2027 16:00 UTC'));
  assert.ok(card.details.at(-1).includes('not for flight planning'));
  assert.ok(notamSummary(LAX).startsWith('AD AP CLSD TO NON SKED'));
  assert.ok(!/2605271826/.test(notamSummary(LAX, 500)));
  const est = buildAirportDelayCard({ ...row, ...parseNotamRange(PNS) });
  assert.ok(est.details.some((d) => d.endsWith('(est.)')));
  // Non-NOTAM statuses fall back to FAA's own time text.
  const gs = buildAirportDelayCard({ stableId: 'g', arpt: 'PHL', icao: 'KPHL', kind: 'ground_stop', delayType: 'Ground Stop', reason: 'WX', end: 'Oct 10 at 16:00 UTC.' });
  assert.equal(gs.title, 'AIRPORT · PHL · Ground stop');
  assert.ok(gs.details.includes('until Oct 10 at 16:00 UTC'));
});
