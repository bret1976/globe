/**
 * In-browser OSS voice: Hugging Face Transformers.js Whisper ASR and
 * hexgrad/Kokoro TTS (kokoro-js). Models download from Hugging Face on first
 * use and cache in the browser. No Gemini, no OpenAI, no COOP/COEP.
 */
import {
  WHISPER_SAMPLE_RATE,
  decodePcm16Wav,
  encodePcm16Wav,
  mixToMono,
  resampleMono,
} from './audioWav.js';

export const WHISPER_ASR_MODEL = 'onnx-community/whisper-tiny.en';
export const KOKORO_TTS_MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';
export const KOKORO_VOICE = 'af_heart';

function configureTransformersEnv(env) {
  env.allowLocalModels = false;
  env.useBrowserCache = true;
  // Single-thread WASM. Use the ORT proxy worker so compile does not freeze
  // Cesium; do not enable multi-thread (that needs COOP/COEP and would
  // block ion tiles).
  if (env.backends?.onnx?.wasm) {
    env.backends.onnx.wasm.numThreads = 1;
    env.backends.onnx.wasm.proxy = true;
  }
}

async function defaultLoadAsr() {
  // Literal specifiers so Vite emits real lazy chunks. A variable +
  // `@vite-ignore` leaves a bare specifier the production browser cannot
  // resolve, which is why TALK died after the Whisper deploy.
  const { pipeline, env } = await import('@huggingface/transformers');
  configureTransformersEnv(env);
  return pipeline('automatic-speech-recognition', WHISPER_ASR_MODEL, {
    dtype: 'q8',
    device: 'wasm',
  });
}

async function defaultLoadTts() {
  const { KokoroTTS } = await import('kokoro-js');
  return KokoroTTS.from_pretrained(KOKORO_TTS_MODEL, {
    dtype: 'q8',
    device: 'wasm',
  });
}

function isWavHeader(bytes) {
  if (!bytes || bytes.length < 12) return false;
  const ascii = (start) =>
    String.fromCharCode(
      bytes[start],
      bytes[start + 1],
      bytes[start + 2],
      bytes[start + 3],
    );
  return ascii(0) === 'RIFF' && ascii(8) === 'WAVE';
}

async function blobToSamples(blob) {
  const decode = async (buffer) => {
    const Ctor = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!Ctor) throw new Error('No AudioContext to decode microphone audio');
    const ctx = new Ctor();
    try {
      return await ctx.decodeAudioData(buffer.slice(0));
    } finally {
      void Promise.resolve(ctx.close?.()).catch(() => {});
    }
  };
  const decoded = await decode(await blob.arrayBuffer());
  return resampleMono(
    mixToMono(decoded),
    decoded.sampleRate,
    WHISPER_SAMPLE_RATE,
  );
}

/**
 * Lazy Whisper + Kokoro runner. Construction is free; models load on warmup
 * or first transcribe/speak so Node unit tests can inject fakes.
 */
export function createBrowserVoice({
  loadAsr = defaultLoadAsr,
  loadTts = defaultLoadTts,
} = {}) {
  let asr = null;
  let tts = null;
  let asrPromise = null;
  let ttsPromise = null;
  let asrFailed = false;
  let ttsFailed = false;

  async function ensureAsr() {
    if (asr) return asr;
    if (asrFailed) throw new Error('Whisper failed to load');
    if (!asrPromise) {
      asrPromise = Promise.resolve()
        .then(loadAsr)
        .then((model) => {
          asr = model;
          return model;
        })
        .catch((error) => {
          asrFailed = true;
          asrPromise = null;
          throw error;
        });
    }
    return asrPromise;
  }

  async function ensureTts() {
    if (tts) return tts;
    if (ttsFailed) throw new Error('Kokoro failed to load');
    if (!ttsPromise) {
      ttsPromise = Promise.resolve()
        .then(loadTts)
        .then((model) => {
          tts = model;
          return model;
        })
        .catch((error) => {
          ttsFailed = true;
          ttsPromise = null;
          throw error;
        });
    }
    return ttsPromise;
  }

  async function samplesFromRequest({
    audio,
    mimeType,
    blob,
    samples,
    sampleRate,
  }) {
    if (samples?.length) {
      return resampleMono(
        samples,
        sampleRate || WHISPER_SAMPLE_RATE,
        WHISPER_SAMPLE_RATE,
      );
    }
    if (blob) return blobToSamples(blob);
    if (!audio) throw new TypeError('ASR requires audio');
    const bytes = audio instanceof Uint8Array ? audio : new Uint8Array(audio);
    if (isWavHeader(bytes) || String(mimeType || '').includes('wav')) {
      const decoded = decodePcm16Wav(bytes);
      return resampleMono(
        decoded.samples,
        decoded.sampleRate,
        WHISPER_SAMPLE_RATE,
      );
    }
    return blobToSamples(
      new Blob([bytes], { type: mimeType || 'application/octet-stream' }),
    );
  }

  return {
    protocol: 'whisper-kokoro',
    asrReady: () => Boolean(asr),
    ttsReady: () => Boolean(tts),
    warmup() {
      return Promise.all([
        ensureAsr().catch(() => null),
        ensureTts().catch(() => null),
      ]);
    },
    async transcribe(request = {}) {
      const model = await ensureAsr();
      if (request.signal?.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }
      const pcm = await samplesFromRequest(request);
      if (!pcm?.length) throw new Error('ASR requires audio');
      const output = await model(pcm, {
        sampling_rate: WHISPER_SAMPLE_RATE,
        language: 'en',
        task: 'transcribe',
      });
      const text = String(
        typeof output === 'string' ? output : output?.text || '',
      ).trim();
      return { text, model: WHISPER_ASR_MODEL };
    },
    async speak({ text, signal } = {}) {
      const spoken = String(text || '').trim();
      if (!spoken) throw new TypeError('TTS requires text');
      const model = await ensureTts();
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const generated = await model.generate(spoken, { voice: KOKORO_VOICE });
      const samples =
        generated?.audio ||
        generated?.samples ||
        (generated instanceof Float32Array ? generated : null);
      if (!samples?.length) throw new Error('Kokoro returned no audio');
      const rate = generated?.sampling_rate || generated?.sampleRate || 24_000;
      return {
        text: spoken,
        audio: encodePcm16Wav(samples, rate),
        model: KOKORO_TTS_MODEL,
      };
    },
  };
}
