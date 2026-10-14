import { coralAlertColorCss, coralAlertName, coralAlertShort } from './parse.js';

const TREND_ARROW = Object.freeze({ rising: '↑', falling: '↓', steady: '→' });

function fixed(value, digits, unit) {
  return Number.isFinite(value) ? `${value.toFixed(digits)}${unit}` : '—';
}

export function coralStationLabel(row) {
  const arrow = row?.trend ? ` ${TREND_ARROW[row.trend] || ''}` : '';
  return `🪸 ${row?.name || 'Reef'} · ${coralAlertShort(row?.level)}${arrow}`.trim();
}

export function buildCoralCard(row) {
  const details = [`${coralAlertName(row.level)} (bleaching heat stress)`];
  if (row.trend && row.prevLevel != null && row.prevLevel !== row.level)
    details.push(
      `7-day trend ${row.trend} (was ${coralAlertName(row.prevLevel)})`,
    );
  else if (row.trend) details.push(`7-day trend ${row.trend}`);
  details.push(
    `DHW ${fixed(row.dhw, 1, ' °C-weeks')} · HotSpot ${fixed(row.hotspot, 2, ' °C')}`,
  );
  details.push(
    `SST ${fixed(row.sst, 2, ' °C')} · anomaly ${Number.isFinite(row.ssta) && row.ssta > 0 ? '+' : ''}${fixed(row.ssta, 2, ' °C')}`,
  );
  if (row.date) details.push(`satellite day ${row.date}`);
  details.push('NOAA Coral Reef Watch · heat-stress outlook, not field survey');
  return {
    id: `coral-bleaching-card:${row.stableId}`,
    selected: true,
    interactive: false,
    title: coralStationLabel(row),
    details,
    accent: coralAlertColorCss(row.level),
    priority: Number.MAX_SAFE_INTEGER,
    gapPx: 15,
    verticalOnly: true,
    placement: 'above',
  };
}
