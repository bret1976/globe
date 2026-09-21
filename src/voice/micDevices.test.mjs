import test from 'node:test';
import assert from 'node:assert/strict';
import { pickPreferredMicId, OPEN_MIC_CONSTRAINTS } from './micDevices.js';

test('open-mic constraints do not enable Chrome noise suppression', () => {
  assert.equal(OPEN_MIC_CONSTRAINTS.noiseSuppression, false);
  assert.equal(OPEN_MIC_CONSTRAINTS.echoCancellation, false);
  assert.equal(OPEN_MIC_CONSTRAINTS.autoGainControl, true);
});

test('pickPreferredMicId chooses a USB desk mic over the built-in array', () => {
  assert.equal(
    pickPreferredMicId(
      [
        { kind: 'audioinput', deviceId: 'built', label: 'Built-in Microphone' },
        { kind: 'audioinput', deviceId: 'usb', label: 'USB Audio Device' },
      ],
      'built',
    ),
    'usb',
  );
});

test('pickPreferredMicId stays put when only internal mics exist', () => {
  assert.equal(
    pickPreferredMicId([
      { kind: 'audioinput', deviceId: 'built', label: 'MacBook Pro Microphone' },
    ]),
    '',
  );
});
