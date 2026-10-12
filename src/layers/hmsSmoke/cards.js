import { hmsSmokeColorCss } from './parse.js';

export function hmsSmokeLabel(row) {
  const density = String(row?.density || 'Smoke').toLowerCase();
  const title = density.charAt(0).toUpperCase() + density.slice(1);
  return `Smoke · ${title}`;
}

export function buildHmsSmokeCard(row) {
  const details = [
    `${String(row.density || 'SMOKE').toUpperCase()} density plume · NOAA HMS analyst product`,
  ];
  if (row.start && row.end) details.push(`window ${row.start} – ${row.end}`);
  else if (row.start) details.push(`from ${row.start}`);
  if (row.satellite) details.push(`satellite ${row.satellite}`);
  if (row.dateKey) details.push(`product ${row.dateKey}`);
  details.push('NOAA NESDIS Hazard Mapping System');
  return {
    id: `hms-smoke-card:${row.stableId}`,
    selected: true,
    interactive: false,
    title: `HMS · ${hmsSmokeLabel(row)}`,
    details,
    accent: hmsSmokeColorCss(row.density),
    priority: Number.MAX_SAFE_INTEGER,
    gapPx: 15,
    verticalOnly: true,
    placement: 'above',
  };
}
