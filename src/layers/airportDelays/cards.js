/** Card model for one selected FAA airport status. Pure — no Cesium types. */
import { airportDelayColorCss } from './parse.js';

export const AIRPORT_DELAY_KIND_LABELS = Object.freeze({
  closure: 'Closed',
  restriction: 'Restriction',
  ground_stop: 'Ground stop',
  ground_delay: 'Ground delay',
  delay: 'Delay',
  other: 'Status',
});

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad2 = (n) => String(n).padStart(2, '0');

/** ISO → "May 27, 2026 18:26 UTC"; null when unparseable. */
export function formatAirportTime(iso) {
  const ms = Date.parse(String(iso || ''));
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())} UTC`;
}

export function airportDelayLabel(row) {
  const kind = AIRPORT_DELAY_KIND_LABELS[row.kind] || 'Status';
  return `${row.arpt || row.icao} · ${kind}`;
}

function titleCase(name) {
  return String(name)
    .toLowerCase()
    .replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

/** NOTAM body without the "!LAX 05/277 LAX" header and trailing range. */
export function notamSummary(reason, max = 60) {
  let text = String(reason || '').replace(/\s+/g, ' ').trim();
  text = text.replace(/^!\S+\s+\d+\/\d+\s+\S+\s+/, '');
  text = text.replace(/\s*\d{10}-(?:\d{10}|PERM)(?:EST)?\s*$/, '');
  if (text.length > max) text = `${text.slice(0, max - 1).trimEnd()}…`;
  return text || null;
}

const strip = (s) => (s ? String(s).replace(/\.\s*$/, '') : null);

/**
 * Overlay-host entry for one selected airport (caller adds `position`).
 * Same card shape as the fire-perimeter incident card.
 */
export function buildAirportDelayCard(row) {
  const details = [];
  const where = [row.icao, row.name ? titleCase(row.name) : null].filter(Boolean);
  if (where.length) details.push(where.join(' · '));
  details.push(
    row.kind === 'restriction'
      ? `${row.delayType || 'FAA status'} · partial — not a full closure`
      : row.delayType || 'FAA status',
  );
  const summary = notamSummary(row.reason);
  if (summary) details.push(summary);
  const from = formatAirportTime(row.startIso);
  const until = row.permanent
    ? 'permanent'
    : formatAirportTime(row.endIso)
      ? `${formatAirportTime(row.endIso)}${row.endEstimated ? ' (est.)' : ''}`
      : null;
  if (from && until) details.push(`from ${from} · until ${until}`);
  else if (from) details.push(`from ${from}`);
  else {
    const legacy = [
      row.start ? `from ${strip(row.start)}` : null,
      row.reopen ? `reopens ${strip(row.reopen)}` : row.end ? `until ${strip(row.end)}` : null,
    ].filter(Boolean);
    if (legacy.length) details.push(legacy.join(' · '));
  }
  details.push('FAA NAS Status · not for flight planning');
  return {
    id: `airport-delay-card:${row.stableId}`,
    selected: true,
    interactive: false,
    title: `AIRPORT · ${airportDelayLabel(row)}`,
    details,
    accent: airportDelayColorCss(row.kind),
    priority: Number.MAX_SAFE_INTEGER,
    gapPx: 15,
    verticalOnly: true,
    placement: 'above',
  };
}
