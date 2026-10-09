/**
 * Acoustic speech gate for server ASR.
 *
 * Gemini transcribes silence, fan hum and room noise as plausible globe
 * commands ("wildfires", "turn off earthquake layer", "zoom out" — measured
 * 2026-10-09 on gemini-3.6/3.8-flash), so a mic that opened on background
 * noise ran random actions. Real speech has syllable-rate loudness swings
 * well above the room floor; steady noise and silence do not. Clips that
 * fail this check are answered "no speech" without calling the model.
 */
const FRAME_MS = 20;
const MIN_PEAK_DBFS = -50;
const ABOVE_FLOOR_DB = 10;
const MIN_VOICED_MS = 160;

/** Parse a PCM16 WAV buffer → { sampleRate, channels, samples:Int16Array } or null. */
export function parsePcm16Wav(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF') return null;
  if (buf.toString('ascii', 8, 12) !== 'WAVE') return null;
  let offset = 12;
  let fmt = null;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ' && size >= 16) {
      fmt = {
        format: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14),
      };
    } else if (id === 'data' && fmt) {
      if (fmt.format !== 1 || fmt.bits !== 16 || !fmt.channels) return null;
      const end = Math.min(buf.length, body + size);
      const count = Math.floor((end - body) / 2);
      const samples = new Int16Array(count);
      for (let i = 0; i < count; i += 1)
        samples[i] = buf.readInt16LE(body + i * 2);
      return { sampleRate: fmt.sampleRate, channels: fmt.channels, samples };
    }
    offset = body + size + (size % 2);
  }
  return null;
}

/** Frame-energy speech check. Returns { speech, peakDb, floorDb, voicedMs }. */
export function analyzeSpeech({ sampleRate, channels = 1, samples }) {
  const frame = Math.max(1, Math.round((sampleRate * FRAME_MS) / 1000));
  const frames = Math.floor(samples.length / channels / frame);
  if (!frames)
    return { speech: false, peakDb: -120, floorDb: -120, voicedMs: 0 };
  const db = new Float64Array(frames);
  for (let f = 0; f < frames; f += 1) {
    let sum = 0;
    const start = f * frame * channels;
    const end = start + frame * channels;
    for (let i = start; i < end; i += 1) {
      const v = samples[i] / 32768;
      sum += v * v;
    }
    db[f] = 10 * Math.log10(sum / (frame * channels) + 1e-12);
  }
  const sorted = Array.from(db).sort((a, b) => a - b);
  const floorDb = sorted[Math.floor((sorted.length - 1) * 0.1)];
  const peakDb = sorted[sorted.length - 1];
  let voiced = 0;
  for (const value of db) {
    if (value > MIN_PEAK_DBFS && value > floorDb + ABOVE_FLOOR_DB) voiced += 1;
  }
  const voicedMs = voiced * FRAME_MS;
  return {
    speech: peakDb > MIN_PEAK_DBFS && voicedMs >= MIN_VOICED_MS,
    peakDb,
    floorDb,
    voicedMs,
  };
}

/**
 * true/false for a base64 WAV clip; null when the clip is not PCM16 WAV
 * (other containers go straight to the model, as before).
 */
export function clipHasSpeech(base64Audio, mimeType = '') {
  if (mimeType && !/wav/i.test(mimeType)) return null;
  let parsed = null;
  try {
    parsed = parsePcm16Wav(Buffer.from(String(base64Audio || ''), 'base64'));
  } catch {
    return null;
  }
  if (!parsed) return null;
  return analyzeSpeech(parsed).speech;
}
