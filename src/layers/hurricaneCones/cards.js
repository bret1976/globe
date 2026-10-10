/** Card model for one selected NHC storm. Pure — no Cesium types. */

export const HURRICANE_CONES_OVERLAY_SOURCE_ID = 'hurricane-cones';

/** CSS accent by current max wind (kt): depression → Cat 5. */
export function stormAccent(windKt) {
  const w = Number(windKt);
  if (!Number.isFinite(w)) return '#7ec8ff';
  if (w >= 113) return '#ff2d55';
  if (w >= 83) return '#ff4d6d';
  if (w >= 64) return '#ff7a00';
  if (w >= 34) return '#ffb703';
  return '#7ec8ff';
}

const kt = (value) => (Number.isFinite(value) ? `${Math.round(value)} kt` : null);

function compass(deg) {
  if (!Number.isFinite(deg)) return null;
  const names = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  return names[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
}

/**
 * Build the overlay-host entry for one selected storm. The caller supplies
 * `position`; the model stays JSON-safe for tests.
 * @param {Object} row - Normalized storm row (see parse.js).
 * @param {?Object} [point] - Optional tapped forecast point.
 */
export function buildHurricaneCard(row, point = null) {
  const current = row.current || {};
  const focus = point || current;
  const facts = [row.category];
  const wind = kt(focus.maxWindKt);
  if (wind) facts.push(`${wind} max`);
  const gust = kt(focus.gustKt);
  if (gust) facts.push(`gust ${gust}`);
  if (Number.isFinite(focus.pressureMb) && focus.pressureMb > 0)
    facts.push(`${Math.round(focus.pressureMb)} mb`);

  const details = [facts.filter(Boolean).join(' · ')];
  const dir = compass(current.directionDeg);
  if (dir && Number.isFinite(current.speedKt))
    details.push(`moving ${dir} at ${Math.round(current.speedKt)} kt`);
  if (point && Number.isFinite(point.tau))
    details.push(
      point.tau === 0
        ? `now · ${point.dateLabel || 'current position'}`
        : `forecast +${point.tau}h · ${point.dateLabel}${point.development ? ` · ${point.development}` : ''}`,
    );
  const peak = kt(row.peakWindKt);
  if (peak && row.points.length > 1)
    details.push(`${row.points.length} forecast points · peak ${peak}`);
  if (row.advisory)
    details.push(
      `NHC advisory ${row.advisory}${row.advisoryDate ? ` · ${row.advisoryDate}` : ''}`,
    );
  details.push('Cone = track uncertainty, not storm size');

  return {
    id: `hurricane-cones-card:${row.stableId}`,
    selected: true,
    interactive: false,
    title: `${row.basin} · ${row.name}`.toUpperCase(),
    details,
    accent: stormAccent(focus.maxWindKt ?? current.maxWindKt),
    priority: Number.MAX_SAFE_INTEGER,
    gapPx: 15,
    verticalOnly: true,
    placement: 'above',
  };
}
