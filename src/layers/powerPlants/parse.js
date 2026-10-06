/**
 * Normalize the WRI Global Power Plant Database (GPPD) into globe point rows.
 *
 * Feed: github.com/wri/global-power-plant-database output CSV (CC BY 4.0,
 * World Resources Institute). ~35k plants; we keep utility-scale (≥ 250 MW).
 * Idea from FlightXCaptain/Gods-Eye (MIT) power-plants layer; this is
 * original Bret/GodsEye code — no third-party application source copied.
 */

export const POWER_PLANTS_URL =
  'https://raw.githubusercontent.com/wri/global-power-plant-database/master/output_database/global_power_plant_database.csv';
export const POWER_PLANTS_MIN_MW = 250;

/** Split one CSV line, honoring double-quoted fields and "" escapes. */
export function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else quoted = false;
      } else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

const FUEL_KIND = Object.freeze({
  coal: 'coal',
  petcoke: 'coal',
  gas: 'gas',
  oil: 'oil',
  cogeneration: 'gas',
  nuclear: 'nuclear',
  hydro: 'hydro',
  'wave and tidal': 'hydro',
  storage: 'hydro',
  wind: 'wind',
  solar: 'solar',
  geothermal: 'renewable',
  biomass: 'renewable',
  waste: 'renewable',
});

/** Coarse fuel kind used for color. */
export function powerPlantKind(fuel) {
  return (
    FUEL_KIND[
      String(fuel || '')
        .trim()
        .toLowerCase()
    ] || 'other'
  );
}

const COLORS = Object.freeze({
  coal: '#8b6b5a',
  gas: '#ff9d3d',
  oil: '#ff4f6d',
  nuclear: '#d86bff',
  hydro: '#3d9dff',
  wind: '#7dffe1',
  solar: '#ffe23d',
  renewable: '#7dff6b',
  other: '#c8c8c8',
});

/** CSS color for a fuel kind. */
export function powerPlantColorCss(kind) {
  return COLORS[kind] || COLORS.other;
}

/** Point size (px) from capacity in MW. */
export function powerPlantPixelSize(mw) {
  const v = Math.max(0, Number(mw) || 0);
  return Math.round(Math.min(18, 5 + Math.sqrt(v) / 6) * 10) / 10;
}

/** Parse the GPPD CSV text into trimmed rows (≥ minMw), largest first. */
export function normalizePowerPlants(
  text,
  { minMw = POWER_PLANTS_MIN_MW } = {},
) {
  const lines = String(text || '').split(/\r?\n/);
  if (lines.length < 2) return [];
  const header = splitCsvLine(lines[0]);
  const col = (name) => header.indexOf(name);
  const iName = col('name');
  const iId = col('gppd_idnr');
  const iMw = col('capacity_mw');
  const iLat = col('latitude');
  const iLon = col('longitude');
  const iFuel = col('primary_fuel');
  const iCountry = col('country_long');
  const iYear = col('commissioning_year');
  const iOwner = col('owner');
  if ([iName, iMw, iLat, iLon, iFuel].some((i) => i < 0))
    throw new Error('GPPD CSV header missing expected columns');
  const rows = [];
  for (let n = 1; n < lines.length; n += 1) {
    const line = lines[n];
    if (!line) continue;
    const f = splitCsvLine(line);
    const mw = Number(f[iMw]);
    const lat = Number(f[iLat]);
    const lon = Number(f[iLon]);
    if (!Number.isFinite(mw) || mw < minMw) continue;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    const year = Number(f[iYear]);
    rows.push({
      stableId: f[iId] || `pp:${lat}:${lon}`,
      name: f[iName] || 'Power plant',
      capacityMw: Math.round(mw),
      fuel: f[iFuel] || 'Unknown',
      kind: powerPlantKind(f[iFuel]),
      country: iCountry >= 0 ? f[iCountry] || null : null,
      commissioned:
        Number.isFinite(year) && year > 1800 ? Math.floor(year) : null,
      owner: iOwner >= 0 ? f[iOwner] || null : null,
      lat,
      lon,
    });
  }
  rows.sort((a, b) => b.capacityMw - a.capacityMw);
  return rows;
}
