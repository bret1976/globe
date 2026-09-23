/**
 * PCM → WAV helpers so hosted Gemini ASR receives a format it accepts.
 * Chrome MediaRecorder emits audio/webm; Gemini generateContent does not.
 */

export const GEMINI_WAV_RATE = 16_000;

function writeAscii(view, offset, text) {
  for (let i = 0; i < text.length; i += 1) {
    view.setUint8(offset + i, text.charCodeAt(i));
  }
}

/** Linear-resample a mono Float32 buffer to `toRate`. */
export function resampleMono(samples, fromRate, toRate) {
  if (!samples?.length) return new Float32Array(0);
  if (!Number.isFinite(fromRate) || fromRate <= 0) return Float32Array.from(samples);
  if (!Number.isFinite(toRate) || toRate <= 0 || fromRate === toRate) {
    return Float32Array.from(samples);
  }
  const ratio = fromRate / toRate;
  const out = new Float32Array(Math.max(1, Math.round(samples.length / ratio)));
  for (let i = 0; i < out.length; i += 1) {
    const src = i * ratio;
    const i0 = Math.min(Math.floor(src), samples.length - 1);
    const i1 = Math.min(i0 + 1, samples.length - 1);
    const t = src - i0;
    out[i] = samples[i0] * (1 - t) + samples[i1] * t;
  }
  return out;
}

/** Mix an AudioBuffer (or {numberOfChannels,length,getChannelData}) to mono. */
export function mixToMono(audioBuffer) {
  const channels = Number(audioBuffer?.numberOfChannels) || 0;
  const length = Number(audioBuffer?.length) || 0;
  const out = new Float32Array(length);
  if (!channels || !length || typeof audioBuffer.getChannelData !== 'function') {
    return out;
  }
  for (let channel = 0; channel < channels; channel += 1) {
    const data = audioBuffer.getChannelData(channel);
    for (let i = 0; i < length; i += 1) out[i] += data[i] / channels;
  }
  return out;
}

/** Encode mono Float32 PCM as 16-bit little-endian WAV bytes. */
export function encodePcm16Wav(samples, sampleRate) {
  const count = samples?.length || 0;
  const rate = Math.round(Number(sampleRate) || GEMINI_WAV_RATE);
  const bytes = new ArrayBuffer(44 + count * 2);
  const view = new DataView(bytes);
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + count * 2, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, count * 2, true);
  for (let i = 0; i < count; i += 1) {
    const clipped = Math.max(-1, Math.min(1, samples[i] || 0));
    view.setInt16(44 + i * 2, clipped < 0 ? clipped * 0x8000 : clipped * 0x7fff, true);
  }
  return bytes;
}

/**
 * Decode a recorded Blob (webm/opus, mp4, …) to 16 kHz mono WAV bytes.
 * @param {Blob} blob
 * @param {{ decodeAudioData?: Function, targetRate?: number }} [options]
 */
export async function audioBlobToWavBytes(
  blob,
  { decodeAudioData, targetRate = GEMINI_WAV_RATE } = {},
) {
  if (!blob) throw new TypeError('Audio blob required');
  const raw = await blob.arrayBuffer();
  const decode =
    decodeAudioData ||
    (async (buffer) => {
      const Ctor = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!Ctor) throw new Error('No AudioContext to decode microphone audio');
      const ctx = new Ctor();
      try {
        return await ctx.decodeAudioData(buffer.slice(0));
      } finally {
        void Promise.resolve(ctx.close?.()).catch(() => {});
      }
    });
  const decoded = await decode(raw);
  const mono = mixToMono(decoded);
  const resampled = resampleMono(mono, decoded.sampleRate, targetRate);
  return encodePcm16Wav(resampled, targetRate);
}
