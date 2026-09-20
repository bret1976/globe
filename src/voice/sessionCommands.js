import { createVoiceControl } from './control.js';
import { createVoiceSession } from './session.js';

/** Bind common controls to a supplied voice-session adapter. */
export function createVoiceCommands({
  runner,
  dataManager,
  annotations = null,
  createSession,
  createController,
  backend,
  signal,
  debugSink,
  createControl = createVoiceControl,
}) {
  window.__gevVoiceCommands?.stop?.({ removeUi: true });
  const ui = createControl({ reset: true });
  const session = createVoiceSession({
    runner,
    signal,
    createAdapter: (hooks) =>
      createSession({
        ...hooks,
        runner,
        ui,
        dataManager,
        backend,
        debugSink,
        createController,
        radioLayer: dataManager?.layers?.get('radio')?.module || null,
      }),
  });
  const adapter = session.adapter;
  const capabilities = adapter.capabilities || {};
  if (ui.tierButton) ui.tierButton.hidden = !capabilities.costControls;
  if (ui.costValue) ui.costValue.hidden = !capabilities.costControls;
  if (!capabilities.costControls) {
    if (ui.helpDetail)
      ui.helpDetail.textContent =
        'Click the mic, allow it, then speak — or type a command';
  }
  ui.button?.setAttribute?.(
    'aria-label',
    'Voice control — click to listen and run spoken commands',
  );
  if (!capabilities.pushToTalk) {
    ui.button.setAttribute('aria-label', 'Toggle voice control');
    if (ui.helpDetail) ui.helpDetail.textContent = 'Activate to toggle voice';
  }
  // Retain the existing controller's inspection surface for browser tools.
  const controls = adapter.controller || session;
  controls.session = session;
  const updateStatus = session.subscribe((event) => {
    if (event.type !== 'state') return;
    ui.root.dataset.status = event.state;
    ui.status.textContent =
      event.state === 'idle' ? 'OFF' : event.state.toUpperCase();
    ui.detail.textContent =
      event.detail || (event.state === 'idle' ? 'Voice off' : 'Voice active');
    ui.button.setAttribute('aria-pressed', String(session.isActive()));
    if (ui.errorDetail)
      ui.errorDetail.textContent =
        event.state === 'error'
          ? event.detail || 'Voice could not be started.'
          : '';
    if (event.state === 'error') ui.root.classList?.remove('error-dismissed');
  });
  const annotationUnsubscribe = annotations?.onOutlineEvent?.((event) => {
    session.sendMapEvent({ type: 'map_annotation_outline', ...event });
  });
  const buttonHandler = () => {
    if (adapter.ignoreButtonClick?.()) return;
    if (session.isActive()) session.stop();
    else void session.start({ pushToTalk: false });
  };
  const formHandler = (event) => {
    event.preventDefault();
    const text = String(ui.commandInput?.value || '').trim();
    if (!text) return;
    void (async () => {
      if (!session.isActive()) await session.start({ pushToTalk: false });
      const sent = await session.sendText(text);
      if (sent && ui.commandInput) ui.commandInput.value = '';
    })();
  };
  ui.button.addEventListener('click', buttonHandler);
  ui.commandForm?.addEventListener?.('submit', formHandler);
  session.signal.addEventListener(
    'abort',
    () => {
      ui.button.removeEventListener('click', buttonHandler);
      ui.commandForm?.removeEventListener?.('submit', formHandler);
      annotationUnsubscribe?.();
      updateStatus();
      ui.root.remove();
    },
    { once: true },
  );
  if (session.disposed) {
    ui.button.removeEventListener('click', buttonHandler);
    annotationUnsubscribe?.();
    updateStatus();
    ui.root.remove();
  } else adapter.bindControls?.();
  window.__gevVoiceCommands = controls;
  return controls;
}
