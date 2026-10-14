import { canadaAlertColorCss } from './parse.js';

function shortTime(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return null;
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${dd}/${hh}${mm}Z`;
}

function titleCase(text) {
  return String(text || '').replace(/(^|\s)(\p{Ll})/gu, (m, sp, ch) => sp + ch.toUpperCase());
}

export function canadaAlertLabel(row) {
  const name = titleCase(row?.name || 'Weather alert');
  const where = row?.area ? ` · ${row.area}` : '';
  return `🇨🇦 ${name}${where}`.trim();
}

export function buildCanadaAlertCard(row) {
  const details = [];
  const head = [titleCase(row.type || 'alert')];
  if (row.risk) head.push(`${row.risk} risk`);
  if (row.impact) head.push(`impact ${row.impact.toLowerCase()}`);
  if (row.confidence) head.push(`confidence ${row.confidence.toLowerCase()}`);
  details.push(head.join(' · '));
  if (row.area || row.province)
    details.push([row.area, row.province].filter(Boolean).join(', '));
  if (row.summary) details.push(row.summary);
  const from = shortTime(row.effective || row.issued);
  const to = shortTime(row.eventEnd || row.expires);
  if (from || to) details.push(`in effect ${from || '?'} – ${to || '?'}`);
  details.push('Data Source: Environment and Climate Change Canada');
  return {
    id: `canada-alerts-card:${row.stableId}`,
    selected: true,
    interactive: false,
    title: canadaAlertLabel(row),
    details,
    accent: canadaAlertColorCss(row),
    priority: Number.MAX_SAFE_INTEGER,
    gapPx: 15,
    verticalOnly: true,
    placement: 'above',
  };
}
