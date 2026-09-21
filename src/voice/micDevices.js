const EXTERNAL_MIC = /usb|yeti|snowball|rode|hyperx|steelseries|logitech|samson|external|headset|wireless|fifine|elgato|scarlett|focusrite/i;
const INTERNAL_MIC = /built-?in|internal|array|webcam|camera|default|communications/i;

/** Loose constraints so a desk/USB mic is not processed away. */
export const OPEN_MIC_CONSTRAINTS = Object.freeze({
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: true,
});

/** Prefer a clearly external input over the laptop/webcam array. */
export function pickPreferredMicId(devices = [], currentId = '') {
  const mics = (Array.isArray(devices) ? devices : []).filter(
    (device) => device?.kind === 'audioinput' && device.deviceId,
  );
  if (!mics.length) return '';
  const score = (label) => {
    const text = String(label || '');
    if (EXTERNAL_MIC.test(text)) return 3;
    if (INTERNAL_MIC.test(text)) return 0;
    return 1;
  };
  const ranked = [...mics].sort((a, b) => score(b.label) - score(a.label));
  const best = ranked[0];
  if (!best || score(best.label) < 3) return '';
  if (best.deviceId === currentId) return '';
  return best.deviceId;
}
