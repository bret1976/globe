export function createIngestion({
  state: layerState,
  services,
  parts,
  source,
}) {
  const methods = {
    /**
     * Periodic update tick: syncs health state and runs auto-hop logic. Ground
     * geometry is NOT resampled here — v2 grounds each camera once via the
     * staggered load queue (see startGeometryLoadQueue/updateRecordGeometry)
     * and never resamples on a timer. The ONE exception is a one-shot
     * completion pass: the enable-time drain can run while 3D tiles are still
     * streaming (each such pass keeps the fabricated catalog height and leaves
     * the record `!groundResolved`), so the FIRST tick that sees
     * projectionTilesReady() re-enqueues the in-view cohort once — each then
     * takes its single real sample and freezes (design §4). Guarded by a
     * boolean latch (`_tilesReadyReenqueued`), NOT a timer loop: after it
     * fires, no tick ever samples anything again. Cameras outside the city
     * radius are left alone; a later camera settle picks them up.
     */
    async update() {
      if (!layerState._enabled) return;
      const now = Date.now();
      layerState._lastUpdate = now;
      if (
        !layerState._tilesReadyReenqueued &&
        parts.model.projectionTilesReady()
      ) {
        layerState._tilesReadyReenqueued = true;
        // Per-regime resolution (Task 5): only the in-view cohort still
        // unresolved for the CURRENT surface regime needs the completion
        // pass. Re-enqueueing the worldwide catalog here used to append
        // thousands of cameras onto a drain that had not finished, so the
        // first-click chip waited on all of them. On globe stacks
        // projectionTilesReady() is false while a (hidden) Google tileset
        // exists, so this latch effectively fires for the google-3d regime —
        // terrain-globe records resolve from the prior in their drain pass.
        parts.geometryQueue.enqueueUnresolvedFocusGeometry();
      }
      await parts.health.syncHealthState();
      parts.navigation.maybeAutoHop(now);
      parts.presentation.notifyListeners();
    },
  };

  return { methods };
}
