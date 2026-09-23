import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WHISPER_SAMPLE_RATE,
  audioBlobToWavBytes,
  decodePcm16Wav,
  encodePcm16Wav,
  mixToMono,
  resampleMono,
} from './audioWav.js';

test('PCM WAV header is 16 kHz mono 16-bit', () => {
  const samples = new Float32Array([0, 0.5, -0.5, 1]);
  const bytes = new Uint8Array(encodePcm16Wav(samples, WHISPER_SAMPLE_RATE));
  const ascii = (start, n) =>
    String.fromCharCode(...bytes.subarray(start, start + n));
  assert.equal(ascii(0, 4), 'RIFF');
  assert.equal(ascii(8, 4), 'WAVE');
  const view = new DataView(bytes.buffer);
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(24, true), 16_000);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(bytes.byteLength, 44 + samples.length * 2);
});

test('resampleMono halves a 2× rate buffer', () => {
  const input = new Float32Array([0, 1, 0, 1, 0, 1, 0, 1]);
  const out = resampleMono(input, 16_000, 8_000);
  assert.equal(out.length, 4);
});

test('mixToMono averages two channels', () => {
  const left = new Float32Array([1, 1]);
  const right = new Float32Array([-1, 1]);
  const mixed = mixToMono({
    numberOfChannels: 2,
    length: 2,
    getChannelData: (channel) => (channel === 0 ? left : right),
  });
  assert.equal(mixed[0], 0);
  assert.equal(mixed[1], 1);
});

test('audioBlobToWavBytes decodes through the supplied decoder', async () => {
  const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/webm' });
  const wav = await audioBlobToWavBytes(blob, {
    decodeAudioData: async () => ({
      sampleRate: 8_000,
      numberOfChannels: 1,
      length: 2,
      getChannelData: () => new Float32Array([0.25, -0.25]),
    }),
  });
  const bytes = new Uint8Array(wav);
  assert.equal(String.fromCharCode(...bytes.subarray(0, 4)), 'RIFF');
  const view = new DataView(bytes.buffer);
  assert.equal(view.getUint32(24, true), 16_000);
});

test('decodePcm16Wav round-trips encodePcm16Wav', () => {
  const original = new Float32Array([0, 0.5, -0.5, 1]);
  const decoded = decodePcm16Wav(encodePcm16Wav(original, 16_000));
  assert.equal(decoded.sampleRate, 16_000);
  assert.equal(decoded.samples.length, 4);
  assert.ok(Math.abs(decoded.samples[1] - 0.5) < 0.01);
  assert.ok(Math.abs(decoded.samples[2] + 0.5) < 0.01);
});
