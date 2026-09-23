/**
 * Right-rail weather readout. Zero UI-kit imports so the layer-panel
 * package boundary stays small: cards are plain DOM.
 */

const WEATHER_PANEL_ID = 'weather-panel';
const ORDER = Object.freeze(['weather-cyclones', 'weather', 'wind']);

function setText(node, value) {
  const next = value == null ? '' : String(value);
  if (node && node.textContent !== next) node.textContent = next;
}

function productCopy(product) {
  const stats = product?.stats || {};
  const count = Number.isFinite(stats.count) ? stats.count : null;
  const error = stats.error ? String(stats.error) : '';
  if (error) return error;
  if (product.id === 'weather')
    return count
      ? `${count} IR drape${count === 1 ? '' : 's'} · NASA GIBS`
      : 'NASA GIBS infrared';
  if (product.id === 'wind')
    return count != null ? `${count} wind samples · Open-Meteo GFS` : 'Open-Meteo GFS';
  if (product.id === 'weather-cyclones')
    return count != null
      ? `${count} storm${count === 1 ? '' : 's'} · NHC + EONET`
      : 'NHC + EONET';
  return product.source || '';
}

/** Host the weather rail body. */
export function createWeatherPanel({
  container,
  setLayerParams = () => {},
} = {}) {
  const document = container?.ownerDocument;
  if (!document?.createElement) return null;
  const root = document.createElement('section');
  root.className = 'weather-readout';
  root.hidden = true;
  root.setAttribute('aria-label', 'Active weather');
  container.appendChild(root);

  const panel = document.getElementById(WEATHER_PANEL_ID);
  const countNode = document.getElementById('weather-panel-count');

  function destroy() {
    root.remove();
    if (panel) panel.hidden = true;
  }

  function update(products = []) {
    const list = ORDER.map((id) => products.find((item) => item.id === id)).filter(
      Boolean,
    );
    root.hidden = list.length === 0;
    if (panel) panel.hidden = list.length === 0;
    setText(countNode, list.length ? String(list.length) : '0');
    root.replaceChildren();
    for (const product of list) {
      const card = document.createElement('article');
      card.className = 'weather-card';
      card.dataset.layerId = product.id;
      const title = document.createElement('h3');
      title.className = 'weather-card-title';
      title.textContent = `${product.icon || ''} ${product.name || product.id}`.trim();
      const meta = document.createElement('p');
      meta.className = 'weather-card-meta';
      meta.textContent = productCopy(product);
      card.append(title, meta);
      const chips = Array.isArray(product.chips) ? product.chips : [];
      if (chips.length) {
        const row = document.createElement('div');
        row.className = 'weather-card-chips';
        for (const chip of chips) {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'weather-chip';
          button.dataset.chipId = chip.id;
          button.setAttribute('aria-pressed', chip.active ? 'true' : 'false');
          if (chip.active) button.classList.add('is-active');
          button.textContent = chip.label || chip.id;
          if (chip.title) button.title = chip.title;
          button.addEventListener('click', () => {
            if (chip.params) setLayerParams(product.id, chip.params);
          });
          row.appendChild(button);
        }
        card.appendChild(row);
      }
      root.appendChild(card);
    }
  }

  return { update, destroy };
}
