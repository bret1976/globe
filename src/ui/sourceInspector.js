/**
 * Source inspector — the "Trace to source" panel.
 *
 * Whatever the operator clicks (any layer's item), this small HUD panel shows
 * where it came from: an Observed / Inferred / Simulated badge, the provider,
 * how old the data is, the attribution/licence note and the raw record fields
 * (collapsed). It only READS selection state:
 *
 *  - the shared context store (`gev:entity-selected`, tracked subjects),
 *  - the inspection side-lane (`gev:inspection`) for layers that keep their
 *    own selection (CCTV, transit, bikeshare, launches),
 *  - and, for everything else, a passive pick of the clicked Cesium entity.
 *
 * It never changes what is selected, and closing it changes nothing else.
 */
import * as Cesium from 'cesium';
import {
  BHOTE_KOSHI_CREDIT,
  BHOTE_KOSHI_LOCATOR_CREDIT,
  DATA_CREDITS,
  FZ1073_CREDIT,
  TOMTOM_CREDIT,
} from '../data/dataCredits.js';
import { getSelectedEntityContext } from '../data/contextStore.js';
import { isPointerFree } from '../data/inputOwnership.js';
import { getInspection } from '../provenance/inspection.js';
import {
  PROVENANCE_COLORS,
  creditText,
  formatAge,
  rawFieldRows,
  resolveProvenance,
  toEpochMs,
} from '../provenance/provenance.js';

export const SOURCE_INSPECTOR_ID = 'gev-source-inspector';
const AGE_REFRESH_MS = 1000;

/** Keys never shown as raw fields: render handles, not data. */
const RAW_SKIP = new Set([
  'entity',
  'contextEntity',
  'dataSource',
  'marker',
  'point',
  'billboard',
  'label',
  'position',
  'primitive',
  'trail',
]);

let _state = null;

function creditMap() {
  const map = new Map();
  for (const c of [
    ...DATA_CREDITS,
    TOMTOM_CREDIT,
    FZ1073_CREDIT,
    BHOTE_KOSHI_CREDIT,
    BHOTE_KOSHI_LOCATOR_CREDIT,
  ]) {
    if (c?.key) map.set(c.key, c.html);
  }
  return map;
}

/**
 * Plain (DOM-free) description of an item, ready to render. Exported for tests.
 * @param {object} item {layerId, id, label, provider, source, fetchedAt,
 *   observedAt, properties, raw}
 * @param {{layerInfo?: object, credits?: Map<string,string>}} [ctx]
 */
export function describeSourceItem(item, { layerInfo = null, credits } = {}) {
  const properties = item?.properties || {};
  const badge = resolveProvenance({
    layerId: item?.layerId,
    source: item?.source,
    provider: item?.provider,
    properties,
  });
  const recordFetchedAt = toEpochMs(item?.fetchedAt ?? properties.fetchedAt);
  const layerUpdatedAt = toEpochMs(layerInfo?.stats?.lastUpdate);
  const fetchedAt = recordFetchedAt ?? layerUpdatedAt ?? null;
  const fetchedBasis =
    recordFetchedAt != null
      ? 'record'
      : layerUpdatedAt != null
        ? 'layer'
        : 'unknown';
  const observedAt = toEpochMs(item?.observedAt ?? properties.observedAt);
  const creditKey =
    item?.creditKey ||
    (item?.layerId === 'transit' && item?.feedId
      ? `transit-${item.feedId}`
      : null) ||
    badge.creditKey;
  const creditHtml = creditKey ? (credits || creditMap()).get(creditKey) : null;
  const rawSource =
    item?.raw && typeof item.raw === 'object' ? item.raw : properties;
  const raw = {};
  for (const [k, v] of Object.entries(rawSource || {})) {
    if (RAW_SKIP.has(k) || k.startsWith('_') || k.startsWith('__')) continue;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      // Skip Cesium objects / anything with methods; keep plain data.
      const proto = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null) continue;
    }
    raw[k] = v;
  }
  return {
    title:
      item?.label ||
      properties.name ||
      properties.title ||
      (item?.id != null ? String(item.id) : 'Selected item'),
    layerName: layerInfo?.name || item?.layerName || item?.layerId || '',
    badge,
    provider: badge.provider,
    fetchedAt,
    fetchedBasis,
    observedAt,
    credit: creditHtml ? creditText(creditHtml) : null,
    rawRows: rawFieldRows(raw),
  };
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function utcStamp(ms) {
  return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

function ageLine(described, now) {
  if (described.fetchedAt == null) return 'Fetched: not recorded by this feed';
  const prefix =
    described.fetchedBasis === 'layer' ? 'Layer refreshed' : 'Fetched';
  return `${prefix}: ${formatAge(described.fetchedAt, now)} · ${utcStamp(described.fetchedAt)}`;
}

function render(described) {
  const s = _state;
  const root = s.root;
  root.replaceChildren();
  const head = el('div', 'gev-source-head');
  head.append(el('span', 'gev-source-kicker', 'SOURCE'));
  const close = el('button', 'gev-source-close', '×');
  close.type = 'button';
  close.setAttribute('aria-label', 'Close source panel');
  close.addEventListener('click', () => hide());
  head.append(close);
  root.append(head);

  root.append(el('div', 'gev-source-title', described.title));
  const badgeRow = el('div', 'gev-source-badge-row');
  const badge = el(
    'span',
    `gev-provenance-badge gev-provenance-${described.badge.kind}`,
    described.badge.label,
  );
  badge.style.setProperty(
    '--gev-provenance-color',
    PROVENANCE_COLORS[described.badge.kind],
  );
  badgeRow.append(badge);
  if (described.layerName)
    badgeRow.append(el('span', 'gev-source-layer', described.layerName));
  root.append(badgeRow);
  if (described.badge.reason)
    root.append(el('p', 'gev-source-reason', described.badge.reason));

  const dl = el('dl', 'gev-source-meta');
  dl.append(el('dt', null, 'Provider'), el('dd', null, described.provider));
  root.append(dl);
  s.ageNode = el('p', 'gev-source-age', ageLine(described, Date.now()));
  root.append(s.ageNode);
  s.observedNode = null;
  if (described.observedAt != null) {
    s.observedNode = el(
      'p',
      'gev-source-age',
      `Observed: ${formatAge(described.observedAt)} · ${utcStamp(described.observedAt)}`,
    );
    root.append(s.observedNode);
  }
  if (described.credit)
    root.append(el('p', 'gev-source-credit', described.credit));

  const details = el('details', 'gev-source-raw');
  details.append(
    el('summary', null, `Raw record (${described.rawRows.length} fields)`),
  );
  const raw = el('dl');
  for (const [k, v] of described.rawRows)
    raw.append(el('dt', null, k), el('dd', null, v));
  if (!described.rawRows.length)
    raw.append(el('dd', null, 'No raw fields exposed by this layer.'));
  details.append(raw);
  root.append(details);
  root.hidden = false;
}

function layerInfoFor(layerId) {
  try {
    return (
      _state?.getDataManager?.()
        ?.getAll?.()
        ?.find((l) => l.id === layerId) || null
    );
  } catch {
    return null;
  }
}

function show(item) {
  if (!_state || !item?.layerId) return;
  _state.item = item;
  _state.lastShownAt = Date.now();
  _state.described = describeSourceItem(item, {
    layerInfo: layerInfoFor(item.layerId),
    credits: _state.credits,
  });
  render(_state.described);
}

function hide() {
  if (!_state) return;
  _state.item = null;
  _state.described = null;
  _state.root.hidden = true;
}

function contextItem(record) {
  if (!record?.layerId) return null;
  return {
    layerId: record.layerId,
    layerName: record.layerName,
    id: record.id,
    label: record.label,
    source: record.source,
    provider: record.provider,
    fetchedAt: record.fetchedAt,
    observedAt: record.observedAt,
    properties: record.properties,
    raw: record.raw || record.properties,
  };
}

function entityItem(entity, viewer) {
  if (!(entity instanceof Cesium.Entity)) return null;
  const owner = entity.entityCollection?.owner;
  let layerId = entity.__gevLayerId || owner?.name || null;
  const dm = _state?.getDataManager?.();
  if (layerId && dm?.layers && !dm.layers.has(layerId)) {
    // Data-source names are usually the layer id; if not, try a prefix match.
    const match = [...dm.layers.keys()].find((id) =>
      String(layerId).startsWith(id),
    );
    layerId = match || layerId;
  }
  if (!layerId) return null;
  let properties = {};
  try {
    properties =
      entity.properties?.getValue?.(
        viewer?.clock?.currentTime || Cesium.JulianDate.now(),
      ) || {};
  } catch {
    properties = {};
  }
  return {
    layerId,
    id: entity.id,
    label: entity.name || properties.name || properties.title,
    provider: properties.provider,
    fetchedAt: properties.fetchedAt,
    observedAt: properties.observedAt,
    properties,
    raw: properties,
  };
}

/**
 * Mount the inspector.
 * @param {{viewer: Cesium.Viewer, getDataManager?: () => object}} options
 * @returns {() => void} Destroy.
 */
export function initSourceInspector({ viewer, getDataManager } = {}) {
  if (typeof document === 'undefined') return () => {};
  if (_state) destroySourceInspector();
  const root = document.createElement('aside');
  root.id = SOURCE_INSPECTOR_ID;
  root.className = 'gev-source-inspector';
  root.setAttribute('role', 'region');
  root.setAttribute('aria-label', 'Source of the selected item');
  root.hidden = true;
  document.body.append(root);

  _state = {
    root,
    viewer,
    getDataManager,
    credits: creditMap(),
    item: null,
    described: null,
    ageNode: null,
    observedNode: null,
    lastEventAt: 0,
    lastShownAt: 0,
    listeners: [],
    timer: null,
    handler: null,
  };
  const on = (type, fn) => {
    window.addEventListener(type, fn);
    _state.listeners.push([type, fn]);
  };
  const mark = () => {
    if (_state) _state.lastEventAt = Date.now();
  };

  on('gev:entity-selected', (e) => {
    mark();
    const item = contextItem(e.detail);
    if (item) show(item);
  });
  on('gev:awareness-subject-selected', (e) => {
    mark();
    const detail = e.detail || {};
    // The tracking layers publish the event just BEFORE their context record.
    setTimeout(() => {
      const record = getSelectedEntityContext();
      if (record && record.layerId === detail.layerId)
        show(contextItem(record));
      else if (detail.layerId)
        show({ layerId: detail.layerId, id: detail.id, label: detail.label });
    }, 0);
  });
  on('gev:inspection', (e) => {
    mark();
    if (e.detail) show(e.detail);
  });
  const clearFor = (e) => {
    const layerId = e.detail?.layerId;
    if (_state?.item && (!layerId || _state.item.layerId === layerId)) hide();
  };
  on('gev:entity-selection-cleared', (e) => {
    if (e.detail?.reason === 'evicted') return; // keep last-known values
    clearFor(e);
  });
  on('gev:awareness-subject-cleared', clearFor);
  on('gev:inspection-cleared', clearFor);
  const onKey = (e) => {
    if (e.key === 'Escape' && _state?.item) hide();
  };
  document.addEventListener('keydown', onKey);
  _state.onKey = onKey;

  // Passive fallback for layers that publish nothing: read the clicked entity.
  if (viewer?.scene?.canvas) {
    _state.handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    _state.handler.setInputAction((click) => {
      if (!isPointerFree()) return;
      const clickAt = Date.now();
      setTimeout(() => {
        if (!_state || _state.lastEventAt >= clickAt) return;
        let picked = null;
        try {
          picked = viewer.scene.pick(click.position);
        } catch {
          picked = null;
        }
        const item = entityItem(picked?.id, viewer);
        if (item) show(item);
        else if (!picked) hide();
      }, 0);
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  _state.timer = setInterval(() => {
    const s = _state;
    if (!s?.described || s.root.hidden || !s.ageNode) return;
    s.ageNode.textContent = ageLine(s.described, Date.now());
    if (s.observedNode && s.described.observedAt != null)
      s.observedNode.textContent = `Observed: ${formatAge(s.described.observedAt)} · ${utcStamp(s.described.observedAt)}`;
  }, AGE_REFRESH_MS);

  // Something may already be selected (e.g. a restored tracked subject).
  const pending = getInspection();
  if (pending) show(pending);
  return destroySourceInspector;
}

export function destroySourceInspector() {
  const s = _state;
  if (!s) return;
  for (const [type, fn] of s.listeners) window.removeEventListener(type, fn);
  if (s.onKey) document.removeEventListener('keydown', s.onKey);
  if (s.timer) clearInterval(s.timer);
  if (s.handler && !s.handler.isDestroyed()) s.handler.destroy();
  s.root.remove();
  _state = null;
}
