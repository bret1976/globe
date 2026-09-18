import { LayerPanel } from '../ui/layers.js';
import { governorRequestRender } from '../renderGovernor.js';
import { markDetectionSourcesChanged } from '../data/detection.js';
import { shouldFocusUserEnabledLayer } from './layerFocusPlan.js';

/** Own the layer panel and application reactions to lifecycle activity. */
export class LayerPresentation {
  constructor(
    manager,
    {
      requestRender = governorRequestRender,
      invalidateDetection = markDetectionSourcesChanged,
      onUserLayerEnablePrepare = null,
      onUserLayerEnabled = null,
    } = {},
  ) {
    this.manager = manager;
    this._panel = null;
    this.pendingVisible = false;
    this._onUserLayerEnablePrepare = onUserLayerEnablePrepare;
    this._onUserLayerEnabled = onUserLayerEnabled;
    this._unsubscribe = manager.subscribeActivity((change) => {
      if (change.type === 'status') this.refresh();
      else if (change.type === 'destroy-all') this.destroy();
      else {
        const reason =
          change.type === 'data-updated'
            ? `layer-tick:${change.layerId}`
            : change.type === 'visibility-settled'
              ? 'layer-visibility'
              : change.type === 'params-settled'
                ? `layer-params:${change.layerId}`
                : null;
        if (!reason) return;
        requestRender(reason);
        if (change.type !== 'params-settled') invalidateDetection(reason);
      }
    });
  }
  get panel() {
    if (!this._panel)
      this._panel = new LayerPanel({
        getLayers: () => this.manager.getAll(),
        isEnabled: (id) => this.manager.isEnabled(id),
        setEnabled: async (id, enabled, options) => {
          if (shouldFocusUserEnabledLayer(enabled, options)) {
            try {
              await this._onUserLayerEnablePrepare?.(id);
            } catch (error) {
              console.warn(`[Data] ${id} operator prepare error:`, error);
            }
          }
          const result = await this.manager.setEnabled(id, enabled, options);
          if (
            shouldFocusUserEnabledLayer(enabled, options) &&
            this.manager.isEnabled(id)
          ) {
            try {
              await this._onUserLayerEnabled?.(id);
            } catch (error) {
              console.warn(`[Data] ${id} operator focus error:`, error);
            }
          }
          return result;
        },
        focusLayer: async (id) => {
          try {
            await this._onUserLayerEnablePrepare?.(id);
            await this._onUserLayerEnabled?.(id);
          } catch (error) {
            console.warn(`[Data] ${id} operator focus error:`, error);
          }
        },
        setLayerParams: (id, params, options) =>
          this.manager.setLayerParams(id, params, options),
        getRowControls: (id) => {
          const module = this.manager.layers.get(id)?.module;
          try {
            return module?.getRowControls?.() || null;
          } catch (error) {
            console.warn(`[Data] ${id} getRowControls error:`, error);
            return null;
          }
        },
        hasRowControls: (id) =>
          typeof this.manager.layers.get(id)?.module?.getRowControls ===
          'function',
        subscribeRowControls: (id, listener) => {
          const module = this.manager.layers.get(id)?.module;
          module?.setRowControlsListener?.(listener);
          return () => module?.setRowControlsListener?.(null);
        },
        onHiddenRefresh: () => {
          this.pendingVisible = true;
        },
      });
    return this._panel;
  }
  mount(container) {
    this.panel.mount(container);
  }
  refresh() {
    this._panel?._refreshTogglePanel();
  }
  flushVisible() {
    if (!this.pendingVisible) return;
    this.pendingVisible = false;
    this.refresh();
  }
  destroy() {
    this._panel?.destroy();
    this._panel = null;
    this.pendingVisible = false;
    this._unsubscribe?.();
    this._unsubscribe = null;
  }
}
