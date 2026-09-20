/**
 * Hosted speech-to-text when the Qwen GPU box is offline.
 * Uses GEMINI_API_KEY already on Railway. Never logs the key.
 */

const DEFAULT_GEMINI_ASR_MODEL = 'gemini-2.0-flash';

export function hostedAsrConfigured(env = process.env) {
  return Boolean(String(env.GEMINI_API_KEY || '').trim());
}

export function hostedAsrModel(env = process.env) {
  return String(env.GEMINI_ASR_MODEL || DEFAULT_GEMINI_ASR_MODEL).trim();
}

export async function transcribeWithHostedAsr(
  { audio, mimeType = 'audio/webm' } = {},
  { fetchImpl = (...args) => fetch(...args), env = process.env } = {},
) {
  const apiKey = String(env.GEMINI_API_KEY || '').trim();
  if (!apiKey) throw new Error('Hosted ASR is not configured');
  if (!audio) throw new TypeError('ASR requires audio');
  const model = hostedAsrModel(env);
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
                text: 'Transcribe this spoken English command verbatim. Return only the transcript, no quotes or extra words.',
              },
              {
                inline_data: {
                  mime_type: normalizeMime(mimeType),
                  data: audio,
                },
              },
            ],
          },
        ],
        generationConfig: { temperature: 0 },
      }),
    },
  );
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      data?.error?.message || `Hosted ASR HTTP ${response.status}`,
    );
  }
  const text = extractGeminiText(data);
  if (!text) throw new Error('Hosted ASR returned no transcript');
  return { text, model };
}

function normalizeMime(mimeType) {
  const raw = String(mimeType || 'audio/webm')
    .split(';')[0]
    .trim();
  if (raw === 'audio/webm' || raw === 'audio/mp4' || raw === 'audio/mpeg')
    return raw;
  if (raw === 'audio/ogg' || raw === 'audio/wav' || raw === 'audio/mp3')
    return raw;
  return 'audio/webm';
}

function extractGeminiText(data) {
  const parts = data?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return '';
  return parts
    .map((part) => (typeof part?.text === 'string' ? part.text : ''))
    .join(' ')
    .replace(/^["'\s]+|["'\s]+$/g, '')
    .trim();
}
