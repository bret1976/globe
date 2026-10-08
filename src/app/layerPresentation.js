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
    this._focusGeneration = 0;
    this._onUserLayerEnablePrepare = onUserLayerEnablePrepare;
    this._onUserLayerEnabled = onUserLayerEnabled;
    // Layers whose data lands outside a manager tick (AIS first position,
    // GBFS city sync, CCTV catalog drain, async loaders) used to leave their
    // row on LOADING / "—" until the next periodic refresh — up to a minute,
    // which read as a stalled layer. Watch the live stats and repaint the
    // panel as soon as an enabled row's presentation actually changes.
    this._statsSignature = '';
    this._statsWatch =
      typeof setInterval === 'function'
        ? setInterval(() => this._watchStats(), 1000)
        : null;
    this._statsWatch?.unref?.();
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
          const focusGeneration = ++this._focusGeneration;
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
            this.manager.isEnabled(id) &&
            focusGeneration === this._focusGeneration
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
          const focusGeneration = ++this._focusGeneration;
          try {
            await this._onUserLayerEnablePrepare?.(id);
            if (focusGeneration !== this._focusGeneration) return;
            // Leaving cockpit/context restores its saved layer selection. The
            // operator's explicit layer click must survive that restoration.
            if (!this.manager.isEnabled(id)) {
              await this.manager.setEnabled(id, true, { origin: 'user' });
            }
            if (
              focusGeneration === this._focusGeneration &&
              this.manager.isEnabled(id)
            )
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
  attachRecentImagery(factory) {
    if (factory) this.panel.attachRecentImagery(factory);
    else this._panel?.attachRecentImagery(null);
  }
  mount(container) {
    this.panel.mount(container);
  }
  refresh() {
    this._panel?._refreshTogglePanel();
  }
  _watchStats() {
    if (!this._panel) return;
    if (typeof document !== 'undefined' && document.hidden) return;
    let layers;
    try {
      layers = this.manager.getAll();
    } catch {
      return;
    }
    const signature = layers
      .filter((layer) => layer.enabled || layer.lifecycleState !== 'disabled')
      .map((layer) => {
        const stats = layer.stats || {};
        return [
          layer.id,
          layer.lifecycleState,
          stats.count,
          stats.countLabel,
          stats.loading,
          stats.loadingLabel,
          stats.stale,
          stats.partial,
          stats.status,
          stats.error || stats.lastError || stats.managerRefreshError || '',
        ].join(':');
      })
      .join('|');
    if (signature === this._statsSignature) return;
    this._statsSignature = signature;
    this.refresh();
  }
  flushVisible() {
    if (!this.pendingVisible) return;
    this.pendingVisible = false;
    this.refresh();
  }
  destroy() {
    if (this._statsWatch) clearInterval(this._statsWatch);
    this._statsWatch = null;
    this._panel?.destroy();
    this._panel = null;
    this.pendingVisible = false;
    this._unsubscribe?.();
    this._unsubscribe = null;
  }
}
