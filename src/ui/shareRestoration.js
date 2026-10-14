import { LayerStateCoordinator } from '../data/layerState.js';
import { stampInitialShareGesture } from '../navigationPolicy.js';
import { canPresentDeferredStatusNotice } from '../loadingFeedback.js';
import { UiLifetime } from './uiLifetime.js';
import { isConstrainedGlobeClient } from '../app/clientCapabilities.js';
import { isPhoneLite } from '../app/phoneLite.js';
import {
  startBootCrashGuard,
  layerRestorePacing,
  planLocalLayerRestore,
  isSafeBootRequested,
  DEFERRED_LAYERS_KEY,
} from '../app/crashLoopGuard.js';
import { LAYER_STATE_STORAGE_KEY } from '../data/layerState.js';
import { showDeferredLayersChip } from './deferredLayersChip.js';

let bootGuard = null;
function ensureBootGuard() {
  if (!bootGuard) bootGuard = startBootCrashGuard();
  return bootGuard;
}
function restorePacing() {
  let constrained = false;
  try {
    constrained = isConstrainedGlobeClient();
  } catch {
    constrained = false;
  }
  return layerRestorePacing({
    constrained,
    recovering: ensureBootGuard().recovering,
  });
}

/**
 * Trim the saved local layer set before the coordinator reads it: ?safe=1
 * clears it, a crashed previous boot starts empty, and more than the
 * auto-restore cap waits for a tap. Returns the layer ids held back.
 */
function prepareLocalLayerRestore() {
  let storage = null;
  try {
    storage = globalThis.localStorage || null;
  } catch {
    storage = null;
  }
  if (!storage) return [];
  try {
    const safe = isSafeBootRequested();
    const plan = planLocalLayerRestore({
      raw: storage.getItem(LAYER_STATE_STORAGE_KEY),
      recovering: ensureBootGuard().recovering,
      safe,
    });
    if (safe) storage.removeItem(DEFERRED_LAYERS_KEY);
    if (!plan.changed) {
      // Still offer layers held back on an earlier boot until resumed/dismissed.
      try {
        const prior = JSON.parse(storage.getItem(DEFERRED_LAYERS_KEY) || '[]');
        return Array.isArray(prior) ? prior.map(String) : [];
      } catch {
        return [];
      }
    }
    if (plan.raw == null) storage.removeItem(LAYER_STATE_STORAGE_KEY);
    else storage.setItem(LAYER_STATE_STORAGE_KEY, plan.raw);
    if (plan.deferred.length)
      storage.setItem(DEFERRED_LAYERS_KEY, JSON.stringify(plan.deferred));
    return plan.deferred;
  } catch {
    return [];
  }
}

/** Own initial share restoration, durable layer state and restoration notices. */
export class ShareRestoration {
  constructor({
    viewer,
    navigation,
    syncShareState,
    syncModels3d,
    showStatus,
    feedback,
    updateFeedback,
  }) {
    Object.assign(this, {
      viewer,
      navigation,
      syncShareState,
      syncModels3d,
      showStatus,
      feedback,
      updateFeedback,
    });
    this._lifetime = new UiLifetime();
    this._disposed = false;
    this._shareTrackingAcquiringKey = null;
    this._shareTrackingNoticeGeneration = 0;
    this._initialShareState = null;
    this._initialShareNavigationGeneration = null;
    this._initialShareRestoreTimeout = null;
    this._layerStateCoordinator = null;
    this._layerStateRestorePromise = null;
  }
  attachLinks(shareLinkManager) {
    this.shareLinkManager = shareLinkManager;
    this._initialShareState = shareLinkManager.parseInitialHash();
  }
  start() {
    // Restore from URL hash if present
    const savedState = this._initialShareState;
    this._initialShareRestorePromise = savedState
      ? new Promise((resolve) => {
          this._resolveInitialShareRestore = resolve;
        })
      : Promise.resolve({ status: 'not-requested', share: null, layers: [] });
    if (savedState) {
      this._hasShareState = true;
      // Reserve camera authority now; the delayed mesh-friendly flight may
      // run only if no newer user, voice, or tracking navigation has won.
      this._initialShareNavigationGeneration =
        this.navigation._beginDeferredNavigation('shared view', {
          cancelPendingSelection: false,
        });
      this._initialShareRestoreTimeout = setTimeout(() => {
        this._initialShareRestoreTimeout = null;
        if (this._disposed) return;
        const generation = this._initialShareNavigationGeneration;
        const applyCamera =
          Number.isInteger(generation) &&
          this.navigation._reassertNavigationHandoff(generation);
        void (async () => {
          try {
            const share = await this.shareLinkManager.applyState(savedState, {
              applyCamera,
              navigationToken: generation,
            });
            const layers = await (this._layerStateRestorePromise ||
              Promise.resolve([]));
            const tracking =
              share.camera === 'applied'
                ? await this._layerStateCoordinator?.restoreShareTrackingSelection?.()
                : {
                    status: 'superseded',
                    cleared:
                      this._layerStateCoordinator?.cancelPendingShareTracking?.(
                        'shared-camera-superseded',
                        { clearSelection: true },
                      ) === true,
                  };
            this.shareLinkManager.completeInitialRestore();
            this._settleInitialShareRestore({
              status: 'settled',
              share,
              layers,
              tracking,
            });
          } catch (error) {
            this.shareLinkManager.completeInitialRestore();
            this._settleInitialShareRestore({
              status: 'failed',
              error: String(error?.message || error),
              share: null,
              layers: [],
            });
          }
        })();
      }, 1500);
    } else {
      this.syncShareState();
    }
    // A recipient can orbit before or during the delayed share flight. That
    // gesture keeps ordinary layer state but revokes the passive base camera
    // and selected-subject Follow so delayed work cannot seize navigation.
    this._initialShareGestureHandler = () => {
      if (
        this._disposed ||
        !this._hasShareState ||
        !this._resolveInitialShareRestore
      )
        return;
      stampInitialShareGesture((options) =>
        this.navigation._stampNavigation(options),
      );
    };
    this.viewer?.canvas?.addEventListener(
      'pointerdown',
      this._initialShareGestureHandler,
      {
        passive: true,
      },
    );
    this.viewer?.canvas?.addEventListener(
      'wheel',
      this._initialShareGestureHandler,
      {
        passive: true,
      },
    );
  }
  connect(dataManager) {
    this._dataManager = dataManager;
    this._layerStateCoordinator?.destroy();
    this._layerStateCoordinator = null;
    this._layerStateRestorePromise = null;
    if (this._dataManager) {
      const deferredLayers = this._initialShareState
        ? []
        : prepareLocalLayerRestore();
      this._layerStateCoordinator = new LayerStateCoordinator(
        this._dataManager,
        this.shareLinkManager,
        {
          onDurableStateChange: (state) => this.syncModels3d(state),
          onTrackingRestoreStatus: (result) =>
            this._handleShareTrackingRestoreStatus(result),
          staggerRestore: restorePacing(),
        },
      );
      this._layerStateRestorePromise = this._layerStateCoordinator.start({
        shareLayerState: this._initialShareState?.layerState || null,
        shareCreatedAtMs: this._initialShareState?.sharedAtMs ?? null,
        // Any valid camera/style share isolates recipient-local preferences,
        // including legacy and malformed-v2 layer payloads.
        allowLocalState: !this._initialShareState,
      });
      if (this._initialShareSelectionSuperseded) {
        this._layerStateCoordinator.cancelPendingShareTracking(
          'superseded-before-layer-coordinator-start',
          { clearSelection: true },
        );
      }
      void this._layerStateRestorePromise.then(() => {
        this.syncModels3d(this._layerStateCoordinator?.getDurableState());
        if (deferredLayers.length && !this._disposed) {
          const dataManager = this._dataManager;
          this._deferredChip?.remove?.();
          this._deferredChip = showDeferredLayersChip({
            layerIds: deferredLayers,
            onResume: async (ids) => {
              try {
                globalThis.localStorage?.removeItem(DEFERRED_LAYERS_KEY);
              } catch {
                /* best effort */
              }
              // Paced like the restore so a tap cannot re-create the freeze.
              for (const id of ids) {
                if (this._disposed) break;
                try {
                  await Promise.race([
                    dataManager.setEnabled(id, true, { origin: 'user' }),
                    new Promise((r) => setTimeout(r, 1500)),
                  ]);
                } catch {
                  /* one bad layer must not stop the rest */
                }
                await new Promise((r) => setTimeout(r, 400));
              }
            },
          });
        }
      });
    }
  }
  cancelSelection() {
    if (
      this._hasShareState &&
      this._resolveInitialShareRestore &&
      !this._layerStateCoordinator
    )
      this._initialShareSelectionSuperseded = true;
    return (
      this._layerStateCoordinator?.cancelPendingShareTracking?.(
        'superseded-by-explicit-navigation',
        { clearSelection: true },
      ) === true
    );
  }
  get initialRestorePromise() {
    return (
      this._initialShareRestorePromise ||
      Promise.resolve({ status: 'not-requested' })
    );
  }
  _handleShareTrackingRestoreStatus(result) {
    if (!result || this._disposed) return;
    const trackingKey = `${result.layerId || ''}:${result.targetId ?? ''}`;
    if (result.classification === 'pending') {
      this._shareTrackingNoticeGeneration += 1;
      this._shareTrackingAcquiringKey = trackingKey;
      this.showStatus('ACQUIRING', {
        state: 'acquiring',
        detail: `SHARED ${String(result.label || 'SUBJECT').toUpperCase()}`,
        // Phones: a timed notice (auto-dismisses) so it never parks over the
        // globe; desktop keeps the persistent acquiring chip.
        persistent: !isPhoneLite(),
      });
      return;
    }
    const ownsAcquiringNotice = this._shareTrackingAcquiringKey === trackingKey;
    if (ownsAcquiringNotice) {
      this._shareTrackingNoticeGeneration += 1;
      this._shareTrackingAcquiringKey = null;
      if (this.feedback._globalStatusNotice?.state === 'acquiring') {
        this.feedback._globalStatusNotice = null;
        this.updateFeedback();
      }
    }
    if (
      result.classification === 'followed' ||
      result.classification === 'cancelled'
    )
      return;
    // A stale terminal result must never replace a newer target's acquisition.
    if (this._shareTrackingAcquiringKey) return;
    const noticeGeneration = ownsAcquiringNotice
      ? this._shareTrackingNoticeGeneration
      : ++this._shareTrackingNoticeGeneration;
    const subject = result.label || 'entity';
    const message =
      result.classification === 'expired'
        ? `Shared ${subject} follow expired`
        : result.classification === 'source-unavailable'
          ? `Shared ${subject} could not be restored — feed unavailable`
          : `Shared ${subject} is unavailable`;
    const showAfterStartupCover = () => {
      this._lifetime.frame(() => {
        if (
          !canPresentDeferredStatusNotice(
            noticeGeneration,
            this._shareTrackingNoticeGeneration,
            this._disposed,
          )
        )
          return;
        const startupCover = document.getElementById('loading-screen');
        if (
          !startupCover ||
          getComputedStyle(startupCover).visibility === 'hidden'
        ) {
          this.showStatus(message);
          return;
        }
        let fallbackTimer = null;
        let removeStartupListener = () => {};
        const showOnce = () => {
          removeStartupListener();
          if (fallbackTimer) this._lifetime.cancelTimeout(fallbackTimer);
          if (
            canPresentDeferredStatusNotice(
              noticeGeneration,
              this._shareTrackingNoticeGeneration,
              this._disposed,
            )
          )
            this.showStatus(message);
        };
        removeStartupListener = this._lifetime.listen(
          startupCover,
          'transitionend',
          showOnce,
          { once: true },
        );
        fallbackTimer = this._lifetime.timeout(showOnce, 1000);
      });
    };
    if (this._resolveInitialShareRestore) {
      void this.initialRestorePromise.then(showAfterStartupCover);
      return;
    }
    showAfterStartupCover();
  }
  _settleInitialShareRestore(result) {
    if (!this._resolveInitialShareRestore) return;
    const resolve = this._resolveInitialShareRestore;
    this._resolveInitialShareRestore = null;
    resolve(result);
    window.dispatchEvent(
      new CustomEvent('gev:initial-share-restore-settled', { detail: result }),
    );
  }
  destroy() {
    if (this._disposed) return;
    this._disposed = true;
    this._shareTrackingNoticeGeneration += 1;
    this._shareTrackingAcquiringKey = null;
    this._layerStateCoordinator?.destroy();
    this._layerStateCoordinator = null;
    this._layerStateRestorePromise = null;
    clearTimeout(this._initialShareRestoreTimeout);
    this._initialShareRestoreTimeout = null;
    this._settleInitialShareRestore({
      status: 'destroyed',
      share: null,
      layers: [],
    });
    this.viewer?.canvas?.removeEventListener(
      'pointerdown',
      this._initialShareGestureHandler,
    );
    this.viewer?.canvas?.removeEventListener(
      'wheel',
      this._initialShareGestureHandler,
    );
    this._initialShareGestureHandler = null;
    this._lifetime.destroy();
  }
}
