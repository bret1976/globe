/**
 * Render budget for fire perimeters. The live feed carries ~4,300 polygons
 * (~31k vertices; single incidents up to ~430 fragments). Each became a
 * ground-clamped polygon *and* a ground-clamped outline, which pinned the
 * main thread. Keep each incident's largest fragments, thin long rings, and
 * cap the total; small slivers are invisible at the zoom they render at.
 */
export const MAX_POLYGONS_PER_INCIDENT = 24;
export const MAX_POLYGONS_TOTAL = 800;
export const MAX_RING_VERTICES = 200;

function ringArea(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
  }
  return Math.abs(a / 2);
}

/** Thin a ring to at most `max` vertices, keeping first and last. */
export function thinRing(ring, max = MAX_RING_VERTICES) {
  if (!Array.isArray(ring) || ring.length <= max) return ring;
  const step = Math.ceil(ring.length / (max - 1));
  const out = [];
  for (let i = 0; i < ring.length; i += step) out.push(ring[i]);
  const last = ring[ring.length - 1];
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

/**
 * @param {Array<{polygons: Array<Array<Array<[number,number]>>>}>} rows
 * @returns per-row arrays of kept polygons (same shape), index-aligned.
 */
export function budgetPerimeterPolygons(
  rows,
  {
    perIncident = MAX_POLYGONS_PER_INCIDENT,
    total = MAX_POLYGONS_TOTAL,
    ringMax = MAX_RING_VERTICES,
  } = {},
) {
  const candidates = [];
  rows.forEach((row, rowIndex) => {
    const polys = (row?.polygons || [])
      .map((rings) => ({ rings, area: ringArea(rings?.[0] || []) }))
      .sort((a, b) => b.area - a.area)
      .slice(0, perIncident);
    // Every incident keeps at least its largest fragment.
    polys.forEach((p, rank) => candidates.push({ rowIndex, rank, ...p }));
  });
  candidates.sort((a, b) => a.rank - b.rank || b.area - a.area);
  const kept = rows.map(() => []);
  let n = 0;
  for (const c of candidates) {
    if (n >= total && c.rank > 0) continue;
    kept[c.rowIndex].push(c.rings.map((ring) => thinRing(ring, ringMax)));
    n++;
  }
  return kept;
}
