/**
 * Inspection channel: a side lane that lets layers which do NOT use the
 * shared selection slot (CCTV, transit, launches, bikeshare…) tell the
 * Source inspector what was just clicked — without touching the selection
 * slot that voice and the cockpit read.
 *
 *   publishInspection({ layerId, id, label, provider, fetchedAt, properties, raw })
 *   clearInspection(layerId?)
 *
 * Events: `gev:inspection` (detail = item) and `gev:inspection-cleared`.
 */

const KEY = '__gevInspection';

function host() {
  return typeof window !== 'undefined' && window ? window : null;
}

/** @returns {object|null} The last published item (null when cleared). */
export function getInspection() {
  return host()?.[KEY] || null;
}

/**
 * @param {{layerId: string, id?: string, label?: string, provider?: string,
 *   fetchedAt?: number|string, properties?: object, raw?: object}} item
 */
export function publishInspection(item) {
  const w = host();
  if (!w || !item?.layerId) return null;
  const record = { ...item, publishedAt: Date.now() };
  w[KEY] = record;
  try {
    w.dispatchEvent?.(new CustomEvent('gev:inspection', { detail: record }));
  } catch {
    /* no CustomEvent in this host */
  }
  return record;
}

/** Clear the item (only when it belongs to `layerId`, if given). */
export function clearInspection(layerId = null) {
  const w = host();
  if (!w || !w[KEY]) return;
  if (layerId && w[KEY].layerId !== layerId) return;
  const previous = w[KEY];
  w[KEY] = null;
  try {
    w.dispatchEvent?.(
      new CustomEvent('gev:inspection-cleared', {
        detail: { layerId: previous.layerId },
      }),
    );
  } catch {
    /* no CustomEvent in this host */
  }
}
