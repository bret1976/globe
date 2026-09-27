/**
 * Normalize USGS Volcano Hazards elevated-volcano JSON into globe rows.
 *
 * Feed: https://volcanoes.usgs.gov/vsc/api/volcanoApi/elevated
 * Public US government open data (no key). Original Bret/GodsEye code.
 */

const COLOR_RANK = Object.freeze({
  RED: 3,
  ORANGE: 2,
  YELLOW: 1,
  GREEN: 0,
});

/**
 * @param {unknown} payload
 * @returns {Array<{
 *   stableId: string,
 *   vnum: string,
 *   name: string,
 *   lat: number,
 *   lon: number,
 *   colorCode: string,
 *   alertLevel: string,
 *   obs: string,
 *   synopsis: string,
 *   noticeUrl: string,
 *   sentUtc: string,
 *   threat: string,
 * }>}
 */
export function normalizeElevatedVolcanoes(payload) {
  if (!Array.isArray(payload)) return [];
  const rows = [];
  for (const item of payload) {
    if (!item || typeof item !== 'object') continue;
    const lat = Number(item.lat);
    const lon = Number(item.long ?? item.lon ?? item.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) continue;
    const vnum = String(item.vnum || item.volcanoCd || '').trim();
    const name = String(item.vName || item.volcano_name || item.name || '').trim();
    if (!vnum && !name) continue;
    const colorCode = String(item.colorCode || item.color_code || 'YELLOW')
      .trim()
      .toUpperCase();
    const alertLevel = String(item.alertLevel || item.alert_level || '')
      .trim()
      .toUpperCase();
    const stableId = vnum || `${name}:${lat.toFixed(4)}:${lon.toFixed(4)}`;
    rows.push({
      stableId,
      vnum: vnum || stableId,
      name: name || `Volcano ${stableId}`,
      lat,
      lon,
      colorCode,
      alertLevel,
      obs: String(item.obs || item.obs_abbr || '').trim().toLowerCase(),
      synopsis: String(item.noticeSynopsis || item.synopsis || '').trim(),
      noticeUrl: String(item.noticeUrl || item.notice_url || '').trim(),
      sentUtc: String(item.sentUtc || item.sent_utc || item.alertDate || '').trim(),
      threat: String(item.nvewsThreat || item.threat || '').trim(),
    });
  }
  rows.sort((a, b) => {
    const rank =
      (COLOR_RANK[b.colorCode] || 0) - (COLOR_RANK[a.colorCode] || 0);
    if (rank) return rank;
    return a.name.localeCompare(b.name);
  });
  return rows;
}

export function volcanoColorCss(colorCode) {
  switch (String(colorCode || '').toUpperCase()) {
    case 'RED':
      return '#FF2244';
    case 'ORANGE':
      return '#FF8800';
    case 'YELLOW':
      return '#FFCC33';
    default:
      return '#88CC66';
  }
}
