import test from 'node:test';
import assert from 'node:assert/strict';
import { createWeatherPanel } from './weatherPanel.js';

function fakeDocument() {
  const store = new Map();
  const document = {
    createElement(name) {
      const node = {
        tagName: String(name).toUpperCase(),
        className: '',
        hidden: false,
        textContent: '',
        dataset: {},
        children: [],
        ownerDocument: null,
        setAttribute(key, value) {
          this[key] = value;
        },
        append(...nodes) {
          this.children.push(...nodes);
        },
        appendChild(node) {
          this.children.push(node);
          return node;
        },
        replaceChildren(...nodes) {
          this.children = nodes;
        },
        addEventListener() {},
        remove() {
          this.removed = true;
        },
      };
      node.ownerDocument = document;
      return node;
    },
    getElementById(id) {
      return store.get(id) || null;
    },
  };
  const panel = document.createElement('div');
  panel.hidden = true;
  store.set('weather-panel', panel);
  const count = document.createElement('span');
  store.set('weather-panel-count', count);
  const body = document.createElement('div');
  store.set('weather-panel-body', body);
  return { document, panel, count, body };
}

test('weather panel hides until a product is enabled', () => {
  const { document, panel, count, body } = fakeDocument();
  globalThis.document = document;
  const handle = createWeatherPanel({ container: body });
  handle.update([]);
  assert.equal(panel.hidden, true);
  handle.update([
    { id: 'weather', name: 'Observed Weather', icon: '🌩', stats: { count: 2 } },
  ]);
  assert.equal(panel.hidden, false);
  assert.equal(count.textContent, '1');
  assert.equal(body.children[0].hidden, false);
  handle.destroy();
  delete globalThis.document;
});
