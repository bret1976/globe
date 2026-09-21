export const OPEN_MIC_SILENCE_MS = 900;
export const OPEN_MIC_MIN_RECORD_MS = 600;
export const OPEN_MIC_ARM_MS = 400;
export const OPEN_MIC_MAX_MS = 8_000;

/** After a reply, ignore leftover energy from speakers and the prior turn. */
export function nextListenArmTime(now, armMs = OPEN_MIC_ARM_MS) {
  return now + armMs;
}

/**
 * Open-mic VAD must hear the next command even while TTS is still playing.
 * `speaking` is intentionally omitted — blocking on it left the mic dead.
 */
export function shouldHearOpenMic({
  busy = false,
  flushing = false,
  holding = false,
  now = 0,
  listenArmedAt = 0,
} = {}) {
  return !busy && !flushing && !holding && now >= listenArmedAt;
}

/** Re-arm after TTS only when the user has not already started talking. */
export function shouldRearmAfterReply({
  busy = false,
  flushing = false,
  heardSpeech = false,
} = {}) {
  return !busy && !flushing && !heardSpeech;
}

/** Commit a clip only after fresh speech and a real pause. */
export function shouldCommitOpenMic({
  heardSpeech = false,
  holding = false,
  busy = false,
  flushing = false,
  lastSpeechAt = 0,
  now = 0,
  silenceMs = OPEN_MIC_SILENCE_MS,
  recordStartedAt = 0,
  listenArmedAt = 0,
  minRecordMs = OPEN_MIC_MIN_RECORD_MS,
} = {}) {
  if (!heardSpeech || holding || busy || flushing) return false;
  if (now < listenArmedAt) return false;
  if (now - lastSpeechAt <= silenceMs) return false;
  if (recordStartedAt && now - recordStartedAt < minRecordMs) return false;
  return true;
}

/** Force-send only when the user actually spoke, never on silence. */
export function shouldWatchdogFlush({
  heardSpeech = false,
  holding = false,
  busy = false,
  flushing = false,
  chunkCount = 0,
} = {}) {
  return Boolean(
    heardSpeech && !holding && !busy && !flushing && chunkCount > 0,
  );
}
