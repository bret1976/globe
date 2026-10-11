/** Card model for one selected SPC outlook polygon. Pure — no Cesium types. */
import { spcOutlookColorCss } from './parse.js';

/** SPC's 1–5 severe tiers; TSTM (general thunder) sits below them. */
const SEVERE_LEVEL = Object.freeze({ MRGL: 1, SLGT: 2, ENH: 3, MDT: 4, HIGH: 5 });

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad2 = (n) => String(n).padStart(2, '0');

/** ISO → "Oct 10 13:00 UTC"; null when unparseable. */
export function formatSpcTime(iso) {
  const ms = Date.parse(String(iso || ''));
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())} UTC`;
}

export function spcOutlookLabel(row) {
  const day = row.day === 2 ? 'Day 2' : 'Day 1';
  const name = row.label2 || row.label || 'SPC';
  return `${day} · ${name}`;
}

/**
 * Overlay-host entry for one selected outlook polygon (caller adds `position`).
 * Same card shape as the fire-perimeter incident card.
 */
export function buildSpcOutlookCard(row) {
  const label = String(row.label || '').toUpperCase();
  const level = SEVERE_LEVEL[label];
  const details = [
    level
      ? `${label} · severe level ${level} of 5 · categorical outlook`
      : `${label || 'SPC'} · general thunder (below severe) · categorical outlook`,
  ];
  const valid = formatSpcTime(row.valid);
  const expire = formatSpcTime(row.expire);
  if (valid && expire) details.push(`valid ${valid} – ${expire}`);
  else if (valid) details.push(`valid from ${valid}`);
  const issued = formatSpcTime(row.issue);
  if (issued) details.push(`issued ${issued}`);
  details.push('NOAA/NWS Storm Prediction Center');
  return {
    id: `spc-outlook-card:${row.stableId}`,
    selected: true,
    interactive: false,
    title: `SPC · ${spcOutlookLabel(row)}`,
    details,
    accent: spcOutlookColorCss(row.label),
    priority: Number.MAX_SAFE_INTEGER,
    gapPx: 15,
    verticalOnly: true,
    placement: 'above',
  };
}
