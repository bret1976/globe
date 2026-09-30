/**
 * Normalize GDACS Orange/Red flood & drought GeoJSON into globe rows.
 *
 * Feed: GDACS geteventlist/SEARCH?alertlevel=Orange;Red&eventlist=FL;DR
 * Public EU/UN coordination data; attribute GDACS. Original Bret/GodsEye code.
 */

const ALERT_RANK = Object.freeze({
  RED: 3,
  ORANGE: 2,
  GREEN: 1,
});

const TYPE_LABEL = Object.freeze({
  FL: 'Flood',
  DR: 'Drought',
});

/**
 * @param {unknown} payload GeoJSON FeatureCollection or features array
 * @returns {Array<{
 *   stableId: string,
 *   eventType: string,
 *   eventTypeLabel: string,
 *   eventId: string,
 *   episodeId: string,
 *   name: string,
 *   country: string,
 *   lat: number,
 *   lon: number,
 *   alertLevel: string,
 *   alertScore: number,
 *   fromDate: string,
 *   toDate: string,
 *   reportUrl: string,
 *   geometryUrl: string,
 *   detailsUrl: string,
 * }>}
 */
export function normalizeGdacsFloodDroughts(payload) {
  const features = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.features)
      ? payload.features
      : [];
  const rows = [];
  for (const feature of features) {
    if (!feature || typeof feature !== 'object') continue;
    const props = feature.properties;
    if (!props || typeof props !== 'object') continue;
    const eventType = String(props.eventtype || props.eventType || '')
      .trim()
      .toUpperCase();
    if (eventType !== 'FL' && eventType !== 'DR') continue;

    let lon;
    let lat;
    const coords = feature.geometry?.coordinates;
    if (Array.isArray(coords) && coords.length >= 2) {
      lon = Number(coords[0]);
      lat = Number(coords[1]);
    } else {
      lat = Number(props.lat ?? props.latitude);
      lon = Number(props.lon ?? props.longitude ?? props.lng);
    }
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) continue;

    const eventId = String(props.eventid ?? props.eventId ?? '').trim();
    const episodeId = String(props.episodeid ?? props.episodeId ?? '').trim();
    const name = String(props.name || props.eventname || props.description || '')
      .trim();
    if (!eventId && !name) continue;

    const alertLevel = String(props.alertlevel || props.alertLevel || 'ORANGE')
      .trim()
      .toUpperCase();
    const alertScore = Number(props.alertscore ?? props.alertScore);
    const urls =
      props.url && typeof props.url === 'object' ? props.url : {};
    const stableId =
      eventId && episodeId
        ? `${eventType}:${eventId}:${episodeId}`
        : eventId
          ? `${eventType}:${eventId}`
          : `${eventType}:${name}:${lat.toFixed(4)}:${lon.toFixed(4)}`;

    rows.push({
      stableId,
      eventType,
      eventTypeLabel: TYPE_LABEL[eventType] || eventType,
      eventId: eventId || stableId,
      episodeId,
      name: name || `${TYPE_LABEL[eventType] || 'Event'} ${stableId}`,
      country: String(props.country || '').trim(),
      lat,
      lon,
      alertLevel,
      alertScore: Number.isFinite(alertScore) ? alertScore : 0,
      fromDate: String(props.fromdate || props.fromDate || '').trim(),
      toDate: String(props.todate || props.toDate || '').trim(),
      reportUrl: String(urls.report || props.reportUrl || '').trim(),
      geometryUrl: String(urls.geometry || props.geometryUrl || '').trim(),
      detailsUrl: String(urls.details || props.detailsUrl || '').trim(),
    });
  }
  rows.sort((a, b) => {
    const rank =
      (ALERT_RANK[b.alertLevel] || 0) - (ALERT_RANK[a.alertLevel] || 0);
    if (rank) return rank;
    if (a.eventType !== b.eventType) return a.eventType.localeCompare(b.eventType);
    return a.name.localeCompare(b.name);
  });
  return rows;
}

export function gdacsAlertColorCss(alertLevel) {
  switch (String(alertLevel || '').toUpperCase()) {
    case 'RED':
      return '#FF2244';
    case 'ORANGE':
      return '#FF8800';
    case 'GREEN':
      return '#44CC66';
    default:
      return '#66AADD';
  }
}
