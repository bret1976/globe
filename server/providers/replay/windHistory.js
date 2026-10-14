/** Hourly historical 10 m wind on a small grid from Open-Meteo's
 *  historical-forecast API using NOAA HRRR (CONUS) with a GFS fallback. No key. */
export async function fetchHistoricalWind({ bbox, t0, t1, grid = 4, fetchImpl = fetch }) {
  const [w, s, e, n] = bbox;
  const lats = [], lons = [];
  for (let i = 0; i < grid; i++) for (let j = 0; j < grid; j++) {
    lats.push((s + ((i + 0.5) * (n - s)) / grid).toFixed(3));
    lons.push((w + ((j + 0.5) * (e - w)) / grid).toFixed(3));
  }
  const day = (t) => new Date(t * 1000).toISOString().slice(0, 10);
  for (const model of ['gfs_hrrr', 'gfs_seamless']) {
    const url = `https://historical-forecast-api.open-meteo.com/v1/forecast?latitude=${lats}&longitude=${lons}` +
      `&start_date=${day(t0)}&end_date=${day(t1)}&hourly=wind_speed_10m,wind_direction_10m&models=${model}&wind_speed_unit=kn&timezone=GMT`;
    try {
      const res = await fetchImpl(url);
      if (!res.ok) continue;
      let j = await res.json();
      if (!Array.isArray(j)) j = [j];
      const times = j[0].hourly.time.map((x) => Date.parse(x + 'Z') / 1000);
      const keep = times.map((t, i) => [t, i]).filter(([t]) => t >= t0 - 3600 && t <= t1 + 3600);
      if (!keep.length || j[0].hourly.wind_speed_10m[keep[0][1]] == null) continue;
      return {
        model: model === 'gfs_hrrr' ? 'NOAA HRRR via Open-Meteo' : 'NOAA GFS via Open-Meteo',
        hours: keep.map(([t]) => Math.round(t - t0)),
        points: j.map((p, k) => ({
          lat: +lats[k], lon: +lons[k],
          kn: keep.map(([, i]) => p.hourly.wind_speed_10m[i]),
          dir: keep.map(([, i]) => p.hourly.wind_direction_10m[i]),
        })),
      };
    } catch { /* try next */ }
  }
  return null;
}
