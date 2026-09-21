/**
 * Hosted Gemini text-to-speech when Kokoro is offline.
 * Uses GEMINI_API_KEY already on Railway. Never logs the key.
 */

const DEFAULT_GEMINI_TTS_MODEL = 'gemini-3.1-flash-tts-preview';
const FALLBACK_GEMINI_TTS_MODEL = 'gemini-2.5-flash-preview-tts';
const DEFAULT_GEMINI_TTS_VOICE = 'Callirrhoe';
const PCM_SAMPLE_RATE = 24_000;

export function hostedTtsConfigured(env = process.env) {
  return Boolean(String(env.GEMINI_API_KEY || '').trim());
}

export function hostedTtsModel(env = process.env) {
  return String(env.GEMINI_TTS_MODEL || DEFAULT_GEMINI_TTS_MODEL).trim();
}

export function hostedTtsVoice(env = process.env) {
  return String(env.GEMINI_TTS_VOICE || DEFAULT_GEMINI_TTS_VOICE).trim();
}

export function hostedTtsModels(env = process.env) {
  const preferred = hostedTtsModel(env);
  return [...new Set([preferred, FALLBACK_GEMINI_TTS_MODEL].filter(Boolean))];
}

export function pcmToWav(
  pcm,
  { sampleRate = PCM_SAMPLE_RATE, channels = 1, bitDepth = 16 } = {},
) {
  const data = Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm || []);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * (bitDepth / 8), 28);
  header.writeUInt16LE(channels * (bitDepth / 8), 32);
  header.writeUInt16LE(bitDepth, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

export async function synthesizeWithHostedTts(
  { text } = {},
  { fetchImpl = (...args) => fetch(...args), env = process.env } = {},
) {
  const apiKey = String(env.GEMINI_API_KEY || '').trim();
  if (!apiKey) throw new Error('Hosted TTS is not configured');
  const spoken = String(text || '').trim();
  if (!spoken) throw new TypeError('TTS requires text');
  const voice = hostedTtsVoice(env);
  let lastError = new Error('Hosted TTS failed');
  for (const model of hostedTtsModels(env)) {
    try {
      const audio = await requestGeminiSpeech({
        text: spoken,
        model,
        voice,
        apiKey,
        fetchImpl,
      });
      return { ...audio, model, voice };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function requestGeminiSpeech({
  text,
  model,
  voice,
  apiKey,
  fetchImpl,
}) {
  const response = await fetchImpl(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                text: `Speak this in a warm, natural, conversational American English voice. Sound like a real person, not a robot or radio dispatcher. Do not add extra words:\n\n${text}`,
              },
            ],
          },
        ],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: voice },
            },
          },
        },
      }),
    },
  );
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      data?.error?.message || `Hosted TTS HTTP ${response.status}`,
    );
  }
  const part = extractAudioPart(data);
  if (!part?.data) throw new Error('Hosted TTS returned no audio');
  const raw = Buffer.from(part.data, 'base64');
  const mime = String(part.mimeType || 'audio/L16').toLowerCase();
  if (mime.includes('wav')) {
    return { bytes: raw, contentType: 'audio/wav' };
  }
  if (mime.includes('mpeg') || mime.includes('mp3')) {
    return { bytes: raw, contentType: 'audio/mpeg' };
  }
  return {
    bytes: pcmToWav(raw),
    contentType: 'audio/wav',
  };
}

function extractAudioPart(data) {
  const parts = data?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return null;
  for (const part of parts) {
    const inline = part?.inlineData || part?.inline_data;
    if (inline?.data) {
      return {
        data: inline.data,
        mimeType: inline.mimeType || inline.mime_type || '',
      };
    }
  }
  return null;
}
