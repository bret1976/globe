/**
 * Normalize live radiosonde (weather balloon) positions into globe rows.
 *
 * Feed: SondeHub v2 (`api.v2.sondehub.org/sondes`), the community network of
 * amateur receiving stations that decode the telemetry national weather
 * services' balloons broadcast as they climb to ~35 km twice a day. One
 * latest frame per sonde serial. Keyless; data CC BY-SA 2.0 (SondeHub).
 * Receiver (uploader) callsigns and station positions are deliberately
 * dropped: only the balloon itself is shown.
 * Original Bret/GodsEye code — does not copy third-party application source.
 */

/** Look-back window: a balloon flight lasts ~2 h, so 3 h keeps whole flights. */
export const RADIOSONDES_LAST_S = 3 * 3600;
export const RADIOSONDES_URL = `https://api.v2.sondehub.org/sondes?last=${RADIOSONDES_LAST_S}`;
export const RADIOSONDES_MAX_ROWS = 1500;
/** A sonde unheard for this long has almost always fallen below receiver
 * range and landed; it is shown as a last-heard marker, not in the air. */
export const RADIOSONDES_LOST_AFTER_MS = 20 * 60_000;
/** Highest altitude a real sonde frame can report (burst is ~30–38 km). */
export const RADIOSONDES_MAX_ALT_M = 50_000;

/** @param {unknown} value */
function parseNum(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** @param {unknown} value @param {number} max */
function text(value, max = 40) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

/**
 * Flight phase from vertical speed (m/s) and altitude (m).
 * Ascending under the balloon, descending under parachute after burst,
 * landed once near the ground and barely moving, floating otherwise.
 * (normalizeRadiosondes additionally marks long-unheard sondes 'lost'.)
 *
 * @param {?number} velV
 * @param {?number} altM
 */
export function radiosondePhase(velV, altM) {
  const v = Number(velV);
  const alt = Number(altM);
  if (Number.isFinite(v) && v > 1) return 'ascending';
  if (Number.isFinite(v) && v < -1) return 'descending';
  if (Number.isFinite(alt) && alt < 2_000) return 'landed';
  return 'floating';
}

/** CSS color by flight phase. @param {string} phase */
export function radiosondeColorCss(phase) {
  switch (phase) {
    case 'ascending':
      return '#00E5FF';
    case 'descending':
      return '#FF9100';
    case 'floating':
      return '#EEFF41';
    case 'lost':
      return '#78909C';
    default:
      return '#B0BEC5';
  }
}

/**
 * One SondeHub frame -> one row, or null.
 * @param {any} frame
 * @param {string} [key] - Map key (the serial) when the payload is keyed.
 */
export function parseRadiosonde(frame, key = '') {
  if (!frame || typeof frame !== 'object') return null;
  const lat = parseNum(frame.lat);
  const lon = parseNum(frame.lon);
  if (lat == null || lon == null) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  if (lat === 0 && lon === 0) return null;
  const altM = parseNum(frame.alt);
  if (altM == null || altM < -500 || altM > RADIOSONDES_MAX_ALT_M) return null;
  const serial = text(frame.serial || key, 32);
  if (!/^[A-Za-z0-9_.:-]{1,32}$/.test(serial)) return null;
  const observedAt = text(frame.datetime, 40);
  const t = Date.parse(observedAt);
  if (!Number.isFinite(t)) return null;
  const velV = parseNum(frame.vel_v);
  const velH = parseNum(frame.vel_h);
  const heading = parseNum(frame.heading);
  const temp = parseNum(frame.temp);
  const humidity = parseNum(frame.humidity);
  const frequency = parseNum(frame.frequency ?? frame.tx_frequency);
  return {
    stableId: `sonde-${serial}`,
    serial,
    lat,
    lon,
    altM: Math.round(altM),
    velV: velV == null ? null : Math.round(velV * 10) / 10,
    velH: velH == null ? null : Math.round(velH * 10) / 10,
    heading: heading == null ? null : Math.round(heading),
    tempC: temp == null || temp < -120 || temp > 60 ? null : Math.round(temp * 10) / 10,
    humidity: humidity == null || humidity < 0 || humidity > 100 ? null : Math.round(humidity),
    type: text(frame.subtype || frame.type, 24),
    manufacturer: text(frame.manufacturer, 32),
    frequencyMHz: frequency == null ? null : Math.round(frequency * 1000) / 1000,
    observedAt: new Date(t).toISOString(),
    phase: radiosondePhase(velV, altM),
  };
}

/**
 * Normalize the SondeHub `/sondes` payload (an object keyed by serial, or an
 * array of frames) into rows, newest first, one per serial.
 *
 * @param {unknown} payload
 * @param {{maxRows?: number, now?: number, maxAgeMs?: number}} [options]
 */
export function normalizeRadiosondes(
  payload,
  {
    maxRows = RADIOSONDES_MAX_ROWS,
    now = Date.now(),
    maxAgeMs = RADIOSONDES_LAST_S * 1000 + 10 * 60_000,
  } = {},
) {
  const entries = Array.isArray(payload)
    ? payload.map((frame) => ['', frame])
    : payload && typeof payload === 'object'
      ? Object.entries(payload)
      : [];
  const bySerial = new Map();
  for (const [key, frame] of entries) {
    const row = parseRadiosonde(frame, key);
    if (!row) continue;
    const age = now - Date.parse(row.observedAt);
    if (age > maxAgeMs || age < -10 * 60_000) continue;
    const prev = bySerial.get(row.serial);
    if (!prev || prev.observedAt < row.observedAt) bySerial.set(row.serial, row);
  }
  for (const row of bySerial.values()) {
    const age = now - Date.parse(row.observedAt);
    row.ageS = Math.max(0, Math.round(age / 1000));
    // Signal lost mid-flight: the balloon is down somewhere near here.
    if (age > RADIOSONDES_LOST_AFTER_MS && row.phase !== 'landed') row.phase = 'lost';
  }
  const rows = [...bySerial.values()];
  rows.sort((a, b) => b.observedAt.localeCompare(a.observedAt));
  return rows.slice(0, maxRows);
}
