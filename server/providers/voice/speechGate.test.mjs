import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeSpeech, clipHasSpeech, parsePcm16Wav } from './speechGate.js';

const RATE = 16000;
function wav(samples) {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((v, i) =>
    data.writeInt16LE(
      Math.max(-32768, Math.min(32767, Math.round(v * 32767))),
      i * 2,
    ),
  );
  const head = Buffer.alloc(44);
  head.write('RIFF', 0, 'ascii');
  head.writeUInt32LE(36 + data.length, 4);
  head.write('WAVEfmt ', 8, 'ascii');
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(RATE, 24);
  head.writeUInt32LE(RATE * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36, 'ascii');
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]).toString('base64');
}
let seed = 7;
const rand = () =>
  ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31) * 2 - 1;
const seconds = (s, fn) =>
  Array.from({ length: Math.round(s * RATE) }, (_, i) => fn(i / RATE));
// syllable-like bursts: 220 Hz voiced tone gated at ~4 Hz
const speechLike = (t) =>
  Math.sin(2 * Math.PI * 4 * t) > 0 ? 0.3 * Math.sin(2 * Math.PI * 220 * t) : 0;

test('digital silence and steady room noise are not speech', () => {
  assert.equal(clipHasSpeech(wav(seconds(2, () => 0)), 'audio/wav'), false);
  assert.equal(
    clipHasSpeech(wav(seconds(2, () => 0.03 * rand())), 'audio/wav'),
    false,
  );
  assert.equal(
    clipHasSpeech(
      wav(seconds(2, (t) => 0.05 * Math.sin(2 * Math.PI * 120 * t))),
      'audio/wav',
    ),
    false,
  );
});

test('spoken bursts are speech, also under steady noise and when quiet', () => {
  assert.equal(clipHasSpeech(wav(seconds(1.5, speechLike)), 'audio/wav'), true);
  assert.equal(
    clipHasSpeech(
      wav(seconds(1.5, (t) => speechLike(t) + 0.02 * rand())),
      'audio/wav',
    ),
    true,
  );
  assert.equal(
    clipHasSpeech(
      wav(seconds(1.5, (t) => speechLike(t) * 0.06 + 0.0005 * rand())),
      'audio/wav',
    ),
    true,
  );
});

test('a single click is not speech', () => {
  const clip = seconds(1.5, (t) =>
    t > 0.5 && t < 0.52 ? 0.8 : 0.001 * rand(),
  );
  assert.equal(clipHasSpeech(wav(clip), 'audio/wav'), false);
});

test('non-WAV clips are not judged (sent to the model as before)', () => {
  assert.equal(clipHasSpeech('AAAA', 'audio/webm'), null);
  assert.equal(
    clipHasSpeech(Buffer.from('not a wav').toString('base64'), 'audio/wav'),
    null,
  );
  assert.equal(parsePcm16Wav(Buffer.alloc(10)), null);
  assert.equal(
    analyzeSpeech({ sampleRate: RATE, samples: new Int16Array(0) }).speech,
    false,
  );
});
