import { describeDarkStatus, lastSeenText } from '../../data/wentDark.js';

/** Most recent first, at most `limit`, ships and aircraft merged. */
export function mergeWentDark(snapshot, { limit = 40, localNowMs = Date.now() } = {}) {
  const items = [];
  const ships = snapshot?.ships;
  const shipSkew =
    ships?.generatedAt != null && ships?.receivedAtMs != null
      ? ships.receivedAtMs - ships.generatedAt
      : 0;
  for (const f of ships?.flagged || []) {
    items.push({ ...f, kind: 'ship', lastAtLocal: f.lastAt + shipSkew, provider: 'AISStream' });
  }
  const air = snapshot?.aircraft;
  const airSkew = air?.feedNowMs != null ? localNowMs - air.feedNowMs : 0;
  for (const f of air?.flagged || []) {
    items.push({ ...f, kind: 'aircraft', lastAtLocal: f.lastAt + airSkew, provider: 'OpenSky / adsb.lol' });
  }
  items.sort((a, b) => b.lastAtLocal - a.lastAtLocal);
  return items.slice(0, limit);
}

/** Row status line, honest about stale/partial feeds. */
export function wentDarkInfo(snapshot) {
  return [
    `Ships: ${describeDarkStatus(snapshot?.ships, 'AIS feed')}`,
    `Aircraft: ${describeDarkStatus(snapshot?.aircraft, 'Aircraft feed')}`,
  ].join(' · ');
}

export function wentDarkItemText(item, localNowMs = Date.now()) {
  return `${item.label} · ${lastSeenText(localNowMs - item.lastAtLocal)}`;
}
