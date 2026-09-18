export function createControls({ state: layerState, services, parts, source }) {
  const methods = {
    id: 'rocket-launches',

    name: 'Space Missions (30d)',

    icon: '🚀',

    source: 'Launch Library 2',

    updateInterval: 300000,

    /** Release only Space Mission camera ownership, preserving layer and selection state. */
    releaseCameraOwnership() {
      parts.panel.clearMissionRosterHover();
      parts.replay.stopMissionReplay();
      parts.selection.stopMissionZoomAnchor();
    },

    getDetectableObjects(options = {}) {
      const maxCount = Number.isFinite(options.maxCount)
        ? Math.max(1, Math.floor(options.maxCount))
        : 2500;
      const out = [];
      for (const launch of layerState._launches || []) {
        if (!Number.isFinite(launch?.lat) || !Number.isFinite(launch?.lon))
          continue;
        out.push({
          id: launch.id,
          sourceId: launch.id,
          lat: launch.lat,
          lon: launch.lon,
          label: launch.name,
        });
        if (out.length >= maxCount) break;
      }
      return out;
    },

    getStats() {
      return {
        count: layerState._count,
        orbitMatches: layerState._orbitMatches,
        lastUpdate: layerState._lastUpdate,
        error: layerState._lastError,
      };
    },

    attachDataManager(dataManager) {
      layerState._dataManager = dataManager;
    },
  };

  return { methods };
}
