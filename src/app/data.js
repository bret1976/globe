import { LayerLifecycle } from '../data/lifecycle.js';
import { LayerPresentation } from './layerPresentation.js';
/** Register the application layer catalog before allowing state restoration. */
export function createApplicationData({
  scene: { viewer, mapStackController },
  controls: { styleManager },
  catalog,
  allowQaRegistration,
  onData,
  defer,
}) {
  // Initialize data layer manager
  const dataManager = new LayerLifecycle(viewer, {
    allowQaRegistration,
  });
  defer(async () => {
    await dataManager.destroyAll();
    if (dataManager.layers.size)
      throw new Error(
        `Data layers could not be destroyed: ${[...dataManager.layers.keys()].join(', ')}`,
      );
  });
  const presentation = new LayerPresentation(dataManager, {
    onUserLayerEnablePrepare: async (layerId) => {
      const { abortShortsPack } = await import('../data/shortsPack.js');
      abortShortsPack();
      if (styleManager.cockpitView?.active) {
        const result = await styleManager.controlCockpit('exit');
        if (result?.ok === false)
          throw new Error(result.error || 'Could not leave cockpit');
      }
      const context = styleManager.getContextModeState?.();
      if (context?.active || context?.changing) {
        const result = await styleManager.setContextMode('off');
        if (result?.ok === false)
          throw new Error(result.error || 'Could not leave current view');
      }
      // Release Context, follow, orbit and deferred navigation before moving.
      styleManager.runImmediateNavigation?.('data layer', () => true);
      const { prepareEnabledLayerFocus } = await import('./layerFocus.js');
      return prepareEnabledLayerFocus({
        viewer,
        layerId,
      });
    },
    onUserLayerEnabled: async (layerId) => {
      const { focusEnabledLayer } = await import('./layerFocus.js');
      return focusEnabledLayer({
        viewer,
        layerId,
        module: dataManager.layers.get(layerId)?.module,
      });
    },
  });
  defer(() => presentation.destroy());
  onData?.(dataManager);
  if (!catalog?.layers || !catalog?.metadata)
    throw new TypeError('An application layer catalog is required');
  for (const layer of catalog.layers) dataManager.register(layer);
  for (const layer of catalog.layers) layer.attachDataManager?.(dataManager);
  for (const layer of catalog.layers)
    layer.attachMapStackController?.(mapStackController);
  // Restoration starts only after the caller's complete registry is sealed.
  dataManager.finalizeRegistrations(catalog.metadata);
  if (allowQaRegistration) {
    window.__gevQaRegisterLayer = (targetManager, layerModule) => {
      if (targetManager !== dataManager)
        throw new Error('QA layer manager mismatch');
      return dataManager.registerForQa(layerModule);
    };
    window.__gevQaUnregisterLayer = (targetManager, layerId) => {
      if (targetManager !== dataManager)
        throw new Error('QA layer manager mismatch');
      return dataManager.unregisterForQa(layerId);
    };
    const register = window.__gevQaRegisterLayer;
    const unregister = window.__gevQaUnregisterLayer;
    defer(() => {
      if (window.__gevQaRegisterLayer === register)
        delete window.__gevQaRegisterLayer;
      if (window.__gevQaUnregisterLayer === unregister)
        delete window.__gevQaUnregisterLayer;
    });
  }
  presentation.mount(document.getElementById('data-toggles'));
  styleManager.attachDataManager(dataManager);

  return { dataManager, catalog, presentation };
}
