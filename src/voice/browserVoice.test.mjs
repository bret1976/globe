import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  KOKORO_TTS_MODEL,
  WHISPER_ASR_MODEL,
  createBrowserVoice,
} from './browserVoice.js';
import { encodePcm16Wav } from './audioWav.js';

test('Whisper and Kokoro are loaded through runtime specifiers', () => {
  const source = readFileSync(
    new URL('./browserVoice.js', import.meta.url),
    'utf8',
  );
  assert.equal(source.includes("import('@huggingface/transformers')"), false);
  assert.equal(source.includes("import('kokoro-js')"), false);
  assert.match(source, /import\(\/\* @vite-ignore \*\/ TRANSFORMERS_PKG\)/);
  assert.match(source, /import\(\/\* @vite-ignore \*\/ KOKORO_PKG\)/);
});

test('createBrowserVoice does not load models until used', () => {
  let loaded = 0;
  const voice = createBrowserVoice({
    loadAsr: async () => {
      loaded += 1;
      return async () => ({ text: 'x' });
    },
    loadTts: async () => {
      loaded += 1;
      return {
        generate: async () => ({
          audio: new Float32Array(1),
          sampling_rate: 24_000,
        }),
      };
    },
  });
  assert.equal(loaded, 0);
  assert.equal(voice.asrReady(), false);
  assert.equal(voice.ttsReady(), false);
  assert.equal(voice.protocol, 'whisper-kokoro');
});

test('warmup loads Whisper and Kokoro once', async () => {
  let asrLoads = 0;
  let ttsLoads = 0;
  const voice = createBrowserVoice({
    loadAsr: async () => {
      asrLoads += 1;
      return async () => ({ text: 'x' });
    },
    loadTts: async () => {
      ttsLoads += 1;
      return {
        generate: async () => ({
          audio: new Float32Array(1),
          sampling_rate: 24_000,
        }),
      };
    },
  });
  await voice.warmup();
  await voice.warmup();
  assert.equal(asrLoads, 1);
  assert.equal(ttsLoads, 1);
  assert.equal(voice.asrReady(), true);
  assert.equal(voice.ttsReady(), true);
});

test('browser voice transcribes float samples through Whisper', async () => {
  const seen = [];
  const voice = createBrowserVoice({
    loadAsr: async () => async (samples, options) => {
      seen.push({ length: samples.length, rate: options.sampling_rate });
      return { text: ' Take me to the Pentagon ' };
    },
    loadTts: async () => ({
      generate: async () => ({
        audio: new Float32Array(1),
        sampling_rate: 24_000,
      }),
    }),
  });
  const result = await voice.transcribe({
    samples: new Float32Array(16),
    sampleRate: 16_000,
  });
  assert.equal(result.text, 'Take me to the Pentagon');
  assert.equal(result.model, WHISPER_ASR_MODEL);
  assert.equal(seen[0].length, 16);
  assert.equal(seen[0].rate, 16_000);
});

test('browser voice transcribes a 16 kHz WAV clip', async () => {
  const voice = createBrowserVoice({
    loadAsr: async () => async () => ({ text: 'Show earthquakes' }),
    loadTts: async () => ({
      generate: async () => ({
        audio: new Float32Array(1),
        sampling_rate: 24_000,
      }),
    }),
  });
  const wav = encodePcm16Wav(new Float32Array([0.1, -0.2, 0.3]), 16_000);
  const result = await voice.transcribe({
    audio: new Uint8Array(wav),
    mimeType: 'audio/wav',
  });
  assert.equal(result.text, 'Show earthquakes');
});

test('browser voice speaks through Kokoro as WAV', async () => {
  const asked = [];
  const voice = createBrowserVoice({
    loadAsr: async () => async () => ({ text: '' }),
    loadTts: async () => ({
      generate: async (text, options) => {
        asked.push([text, options.voice]);
        return {
          audio: new Float32Array([0.25, -0.25]),
          sampling_rate: 24_000,
        };
      },
    }),
  });
  const spoken = await voice.speak({ text: 'On my way to the Pentagon.' });
  assert.equal(spoken.text, 'On my way to the Pentagon.');
  assert.equal(spoken.model, KOKORO_TTS_MODEL);
  assert.deepEqual(asked, [['On my way to the Pentagon.', 'af_heart']]);
  const bytes = new Uint8Array(spoken.audio);
  assert.equal(String.fromCharCode(...bytes.subarray(0, 4)), 'RIFF');
  const view = new DataView(bytes.buffer);
  assert.equal(view.getUint32(24, true), 24_000);
});
