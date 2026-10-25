/**
 * One provenance vocabulary for every item the info panel can show.
 *
 *   OBSERVED  — a sensor/operator reported this record (ADS-B fix, AIS
 *               position, satellite fire detection, seismometer event…).
 *   INFERRED  — derived from observations by a model or rule (GNSS-integrity
 *               cells, gpsjam "potential interference" hexes, SGP4-propagated
 *               satellites, reconstructed launch ascents, CCTV aim priors,
 *               went-dark last-known positions).
 *   SIMULATED — generated for display with no live observation behind it
 *               (traffic dots when no flow feed is connected).
 *
 * The existing ad-hoc labels (RECONSTRUCTED ESTIMATE, SIMULATED traffic,
 * RAW PRIOR camera aim, gpsjam "potential") keep their wording; each now
 * maps onto this single field so the info panel badges them the same way.
 *
 * Pure (no DOM, no Cesium): shared by the client inspector and tests.
 */

export const PROVENANCE = Object.freeze({
  OBSERVED: 'observed',
  INFERRED: 'inferred',
  SIMULATED: 'simulated',
});

export const PROVENANCE_KINDS = Object.freeze(Object.values(PROVENANCE));

export const PROVENANCE_LABELS = Object.freeze({
  observed: 'OBSERVED',
  inferred: 'INFERRED',
  simulated: 'SIMULATED',
});

/** HUD accent per kind (existing palette: cyan / amber / magenta-grey). */
export const PROVENANCE_COLORS = Object.freeze({
  observed: '#4fe3ff',
  inferred: '#ffb547',
  simulated: '#c58cff',
});

const O = PROVENANCE.OBSERVED;
const I = PROVENANCE.INFERRED;
const S = PROVENANCE.SIMULATED;

/**
 * Default provenance per layer id. `creditKey` points at DATA_CREDITS
 * (src/data/dataCredits.js) for the licence/attribution text.
 * @type {Readonly<Record<string, {kind: string, provider: string, creditKey?: string, note?: string}>>}
 */
export const LAYER_PROVENANCE = Object.freeze({
  flights: { kind: O, provider: 'OpenSky Network / adsb.lol', creditKey: 'opensky', note: 'ADS-B position reports.' },
  military: { kind: O, provider: 'adsb.lol', creditKey: 'adsblol', note: 'ADS-B position reports.' },
  'military-awareness': { kind: O, provider: 'adsb.lol', creditKey: 'adsblol' },
  'local-adsb': { kind: O, provider: 'Local ADS-B receiver', note: 'Your own receiver.' },
  'ais-live-vessels': { kind: O, provider: 'AISStream', creditKey: 'aisstream', note: 'AIS position reports.' },
  satellites: { kind: I, provider: 'CelesTrak', creditKey: 'celestrak', note: 'Position propagated from published orbital elements (SGP4), not a live fix.' },
  'rocket-launches': { kind: O, provider: 'Launch Library 2', creditKey: 'launch-library-2', note: 'Scheduled launch record.' },
  earthquakes: { kind: O, provider: 'USGS', creditKey: 'usgs' },
  'local-firms': { kind: O, provider: 'NASA FIRMS', creditKey: 'firms', note: 'Satellite thermal-anomaly detection.' },
  'ukraine-fires': { kind: O, provider: 'NASA FIRMS', creditKey: 'ukraine-fires' },
  cctv: { kind: O, provider: 'Public traffic cameras', note: 'Camera image is observed; its on-globe aim may be an estimated prior.' },
  transit: { kind: O, provider: 'GTFS-Realtime feeds', creditKey: 'gtfs-rt', note: 'Agency vehicle positions.' },
  bikeshare: { kind: O, provider: 'GBFS feeds', creditKey: 'gbfs' },
  traffic: { kind: S, provider: 'Simulated (TomTom flow when connected)', creditKey: 'tomtom', note: 'Dots are simulated; colours are live only when the TomTom flow feed is connected.' },
  'gps-interference': { kind: I, provider: 'gpsjam.org', creditKey: 'gpsjam', note: 'Potential interference inferred from aircraft navigation-accuracy reports; not confirmed jamming.' },
  'gnss-integrity': { kind: I, provider: 'adsb.lol', creditKey: 'adsblol', note: 'Cells classified from aircraft NIC/NACp reports; an integrity anomaly is not a detection of jamming.' },
  'went-dark': { kind: I, provider: 'AISStream / OpenSky / adsb.lol', note: 'Last-known position of a target that stopped reporting; where it is now is unknown.' },
  'nws-alerts': { kind: O, provider: 'NOAA NWS', creditKey: 'nws-alerts' },
  'weather-cyclones': { kind: O, provider: 'NOAA NHC', creditKey: 'nhc-eonet' },
  'hurricane-cones': { kind: I, provider: 'NOAA NHC', creditKey: 'nhc-eonet', note: 'Forecast cone (model output).' },
  'fire-perimeters': { kind: O, provider: 'NIFC WFIGS', creditKey: 'wfigs' },
  'au-fire': { kind: O, provider: 'Australian fire agencies', creditKey: 'au-fire' },
  volcanoes: { kind: O, provider: 'USGS Volcano Hazards', creditKey: 'usgs-volcanoes' },
  aurora: { kind: I, provider: 'NOAA SWPC OVATION', creditKey: 'noaa-ovation', note: 'Model nowcast.' },
  wind: { kind: I, provider: 'NOAA GFS', creditKey: 'noaa-gfs-wind', note: 'Model analysis/forecast.' },
  radiosondes: { kind: O, provider: 'Radiosonde network', creditKey: 'radiosondes' },
  'storm-reports': { kind: O, provider: 'NOAA SPC', creditKey: 'storm-reports' },
  'air-quality': { kind: O, provider: 'Air-quality monitors', creditKey: 'air-quality' },
  'flight-restrictions': { kind: O, provider: 'FAA', creditKey: 'flight-restrictions' },
  'aviation-hazards': { kind: O, provider: 'Aviation weather', creditKey: 'aviation-hazards' },
  'world-sigmets': { kind: O, provider: 'Aviation weather', creditKey: 'world-sigmets' },
  'ndbc-buoys': { kind: O, provider: 'NOAA NDBC', creditKey: 'ndbc-buoys' },
  'usgs-gauges': { kind: O, provider: 'USGS', creditKey: 'usgs-gauges' },
  'tide-gauges': { kind: O, provider: 'NOAA CO-OPS', creditKey: 'tide-gauges' },
  'alpr-cameras': { kind: O, provider: 'OpenStreetMap', creditKey: 'alpr-osm' },
  'military-installations': { kind: O, provider: 'OpenStreetMap', creditKey: 'military-installations-osm' },
  fireballs: { kind: O, provider: 'NASA CNEOS', creditKey: 'fireballs' },
  ionosphere: { kind: I, provider: 'Ionosphere model', creditKey: 'ionosphere' },
  'coral-bleaching': { kind: I, provider: 'NOAA Coral Reef Watch', creditKey: 'coral-bleaching' },
  'canada-alerts': { kind: O, provider: 'Canadian alerting', creditKey: 'canada-alerts' },
  'power-plants': { kind: O, provider: 'Power-plant database', creditKey: 'power-plants' },
  'ocean-currents': { kind: I, provider: 'Ocean model', creditKey: 'ocean-currents' },
  'usdm-drought': { kind: I, provider: 'US Drought Monitor', creditKey: 'usdm-drought' },
  'street-photos': { kind: O, provider: 'Panoramax', creditKey: 'panoramax' },
  'local-datacenters': { kind: O, provider: 'OpenStreetMap', creditKey: 'datacenters' },
  'local-dams': { kind: O, provider: 'OpenStreetMap', creditKey: 'dams' },
  'telegeography-submarine-cables': { kind: O, provider: 'OpenStreetMap', creditKey: 'osm-submarine-cables' },
  'fz1073-2026': { kind: O, provider: 'Bundled event record', creditKey: 'fz1073-2026' },
  'bhote-koshi-2026': { kind: I, provider: 'Bundled event record', creditKey: 'bhote-koshi-2026', note: 'Schematic corridor.' },
  'bhote-koshi-locator': { kind: I, provider: 'Bundled locator', creditKey: 'bhote-koshi-locator' },
});

const UNKNOWN = Object.freeze({ kind: O, provider: 'Unknown source' });

/** Normalise a free-form kind, or null when it is not one of the three. */
export function normalizeProvenanceKind(value) {
  const text = String(value ?? '').trim().toLowerCase();
  return PROVENANCE_KINDS.includes(text) ? text : null;
}

/**
 * Resolve the badge for one item.
 *
 * Record-level evidence overrides the layer default, so the same layer can
 * carry mixed items (a launch whose ascent is reconstructed; a camera whose aim
 * is a raw prior; traffic whose colours are live).
 *
 * @param {{layerId?: string, source?: string, properties?: object}} item
 * @returns {{kind: string, label: string, reason: string|null, provider: string, creditKey: string|null}}
 */
export function resolveProvenance(item = {}) {
  const layerId = String(item.layerId || '');
  const base = LAYER_PROVENANCE[layerId] || UNKNOWN;
  const p = item.properties || {};
  let kind = base.kind;
  let reason = base.note || null;

  const explicit = normalizeProvenanceKind(p.provenance);
  if (explicit) {
    kind = explicit;
    if (p.provenanceReason) reason = String(p.provenanceReason);
  } else if (layerId === 'rocket-launches' && p.ascent === 'RECONSTRUCTED ESTIMATE') {
    kind = I;
    reason = 'Ascent path is a RECONSTRUCTED ESTIMATE, not supplied trajectory points.';
  } else if (layerId === 'cctv' && p.calBadge === 'raw-prior') {
    kind = I;
    reason = 'Image is live, but the camera position/aim on the globe is an estimated RAW PRIOR.';
  } else if (layerId === 'traffic' && p.flowLive === true) {
    kind = O;
    reason = 'Colours from the live TomTom flow feed; dot positions are still simulated.';
  }

  const provider =
    (typeof p.provider === 'string' && p.provider) ||
    (typeof item.provider === 'string' && item.provider) ||
    (typeof item.source === 'string' && item.source) ||
    base.provider;
  return {
    kind,
    label: PROVENANCE_LABELS[kind],
    reason,
    provider,
    creditKey: base.creditKey || null,
  };
}

/**
 * "12 s ago" / "4 min ago" / "3 h ago" / "2 d ago". Future times read "just now".
 * @param {number|null|undefined} atMs
 * @param {number} nowMs
 */
export function formatAge(atMs, nowMs = Date.now()) {
  if (!Number.isFinite(atMs)) return 'unknown';
  const s = Math.max(0, Math.round((nowMs - atMs) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s} s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

/**
 * Coerce a fetchedAt value (ms, s, or ISO string) to epoch ms, or null.
 * @param {unknown} value
 */
export function toEpochMs(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null;
    return value < 10_000_000_000 ? value * 1000 : value;
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Additive provenance stamp for a record or response: never overwrites a
 * field a provider already set, so existing payloads and caches keep their
 * shape and only gain `provider` / `fetchedAt`.
 * @template T
 * @param {T} target
 * @param {{provider?: string, fetchedAt?: number|string}} stamp
 * @returns {T}
 */
export function stampSource(target, { provider, fetchedAt } = {}) {
  if (!target || typeof target !== 'object') return target;
  if (provider && target.provider == null) target.provider = provider;
  const at = toEpochMs(fetchedAt);
  if (at != null && target.fetchedAt == null) target.fetchedAt = at;
  return target;
}

/** Strip markup from a DATA_CREDITS html string for plain-text display. */
export function creditText(html) {
  return String(html || '')
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Raw-field rows for the collapsible "Raw record" view: primitive values
 * only, nested objects JSON-encoded and clipped, functions dropped.
 * @param {object} record
 * @param {{limit?: number, maxChars?: number}} [options]
 * @returns {Array<[string, string]>}
 */
export function rawFieldRows(record, { limit = 60, maxChars = 160 } = {}) {
  const rows = [];
  if (!record || typeof record !== 'object') return rows;
  for (const [key, value] of Object.entries(record)) {
    if (rows.length >= limit) break;
    if (typeof value === 'function' || value === undefined) continue;
    let text;
    if (value === null) text = 'null';
    else if (typeof value === 'object') {
      try {
        text = JSON.stringify(value);
      } catch {
        text = '[unserialisable]';
      }
    } else text = String(value);
    if (text.length > maxChars) text = `${text.slice(0, maxChars - 1)}…`;
    rows.push([key, text]);
  }
  return rows;
}
