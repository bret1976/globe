import { worldSigmetColorCss, worldSigmetFamilyName } from './parse.js';

function flightLevel(feet) {
  if (!Number.isFinite(feet)) return null;
  if (feet <= 0) return 'SFC';
  return `FL${String(Math.round(feet / 100)).padStart(3, '0')}`;
}

function shortTime(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return null;
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${dd}/${hh}${mm}Z`;
}

export function worldSigmetLabel(row) {
  const hazard = row?.hazard || 'SIGMET';
  const qualifier =
    row?.qualifier && (row.family === 'ash' || row.family === 'cyclone')
      ? ` ${row.qualifier}`
      : '';
  const where = row?.fir ? ` · ${row.fir}` : '';
  return `SIGMET ${hazard}${qualifier}${where}`.trim();
}

export function buildWorldSigmetCard(row) {
  const details = [
    `${worldSigmetFamilyName(row.family)}${row.qualifier ? ` · ${row.qualifier}` : ''}`,
  ];
  if (row.firName || row.fir)
    details.push(
      `FIR ${row.firName || row.fir}${row.seriesId ? ` · SIGMET ${row.seriesId}` : ''}`,
    );
  const base = flightLevel(row.base);
  const top = flightLevel(row.top);
  if (base || top) details.push(`levels ${base || '?'} – ${top || '?'}`);
  if (row.dir || Number.isFinite(row.spd))
    details.push(
      `moving ${row.dir || '?'}${Number.isFinite(row.spd) ? ` ${row.spd} kt` : ''}`,
    );
  const from = shortTime(row.validFrom);
  const to = shortTime(row.validTo);
  if (from || to) details.push(`valid ${from || '?'} – ${to || '?'}`);
  details.push('NOAA/NWS Aviation Weather Center · not for flight planning');
  return {
    id: `world-sigmets-card:${row.stableId}`,
    selected: true,
    interactive: false,
    title: worldSigmetLabel(row),
    details,
    accent: worldSigmetColorCss(row.family || row.hazard),
    priority: Number.MAX_SAFE_INTEGER,
    gapPx: 15,
    verticalOnly: true,
    placement: 'above',
  };
}
