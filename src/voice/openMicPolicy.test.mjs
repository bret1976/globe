import test from 'node:test';
import assert from 'node:assert/strict';
import {
  nextListenArmTime,
  shouldCommitOpenMic,
  shouldWatchdogFlush,
} from './openMicPolicy.js';

test('stale speech from the previous turn does not commit a new clip', () => {
  assert.equal(
    shouldCommitOpenMic({
      heardSpeech: true,
      lastSpeechAt: 1000,
      now: 5000,
      recordStartedAt: 4990,
      listenArmedAt: 5400,
      silenceMs: 900,
      minRecordMs: 600,
    }),
    false,
  );
});

test('fresh speech plus silence after arming commits the clip', () => {
  assert.equal(
    shouldCommitOpenMic({
      heardSpeech: true,
      lastSpeechAt: 2000,
      now: 3000,
      recordStartedAt: 1500,
      listenArmedAt: 1600,
      silenceMs: 900,
      minRecordMs: 600,
    }),
    true,
  );
});

test('watchdog never flushes a silent restart after a reply', () => {
  assert.equal(
    shouldWatchdogFlush({
      heardSpeech: false,
      chunkCount: 12,
    }),
    false,
  );
  assert.equal(
    shouldWatchdogFlush({
      heardSpeech: true,
      chunkCount: 12,
    }),
    true,
  );
});

test('next listen arm time sits after the reply so speaker echo is ignored', () => {
  assert.equal(nextListenArmTime(1000, 400), 1400);
});

test('busy or flushing turns never commit leftover energy', () => {
  const fresh = {
    heardSpeech: true,
    lastSpeechAt: 2000,
    now: 3000,
    recordStartedAt: 1500,
    listenArmedAt: 1600,
    silenceMs: 900,
    minRecordMs: 600,
  };
  assert.equal(shouldCommitOpenMic({ ...fresh, busy: true }), false);
  assert.equal(shouldCommitOpenMic({ ...fresh, flushing: true }), false);
  assert.equal(shouldWatchdogFlush({ heardSpeech: true, chunkCount: 4, busy: true }), false);
  assert.equal(
    shouldWatchdogFlush({ heardSpeech: true, chunkCount: 4, flushing: true }),
    false,
  );
});
