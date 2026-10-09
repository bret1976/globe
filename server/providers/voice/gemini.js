/**
 * Gemini speech-to-text + intent fallback for the TALK mic.
 *
 * The browser records the mic (MediaRecorder → 16 kHz WAV) and posts it to
 * /api/voice/asr. With GEMINI_API_KEY set on the server we transcribe it with
 * a current Gemini 3.x model (audio input), so phones and Safari no longer
 * depend on downloading in-browser Whisper. The key never reaches the client.
 *
 * Retired models (gemini-1.5 / 2.0 / 2.x) are never used; the chain below is
 * tried in order and the first model that answers is remembered.
 */
import {
  VOICE_LAYER_IDS,
  VOICE_LAYER_LABELS,
} from '../../../src/voice/selfHostedIntent.js';
import { clipHasSpeech } from './speechGate.js';

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
export const GEMINI_VOICE_MODELS = Object.freeze([
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3.1-flash-lite',
]);
const PER_MODEL_TIMEOUT_MS = 12_000;
const TOTAL_TIMEOUT_MS = 22_000;
const RETIRED = /^gemini-(1\.|2\.)/;

let preferredModel = null;

/** Models that reject thinkingLevel 'minimal' (HTTP 400); they get 'low'. */
const NO_MINIMAL_THINKING = new Set();

function withThinkingLevel(body, level) {
  const config = body?.generationConfig;
  if (!config?.thinkingConfig) return body;
  return {
    ...body,
    generationConfig: {
      ...config,
      thinkingConfig: { ...config.thinkingConfig, thinkingLevel: level },
    },
  };
}

export function geminiApiKey(env = process.env) {
  return String(
    env.GEMINI_API_KEY || env.GOOGLE_GENERATIVE_AI_API_KEY || '',
  ).trim();
}

export function geminiConfigured(env = process.env) {
  return Boolean(geminiApiKey(env));
}

/**
 * Model order: ASR override (speech-to-text only), voice override, last good
 * model, then defaults. Retired gemini-1.x / 2.x names are skipped.
 * GEMINI_ASR_MODEL is the production speech-to-text override (gemini-3.8-flash).
 */
export function geminiModelChain(
  env = process.env,
  { purpose = 'voice' } = {},
) {
  const asrOverride = String(env.GEMINI_ASR_MODEL || '').trim();
  const override = String(env.GEMINI_VOICE_MODEL || '').trim();
  const chain = [];
  if (purpose === 'asr' && asrOverride && !RETIRED.test(asrOverride)) {
    chain.push(asrOverride);
  }
  if (override && !RETIRED.test(override)) chain.push(override);
  if (preferredModel) chain.push(preferredModel);
  chain.push(...GEMINI_VOICE_MODELS);
  return [...new Set(chain)];
}

export function geminiActiveModel(env = process.env) {
  return geminiModelChain(env)[0];
}

export function geminiAsrModel(env = process.env) {
  return geminiModelChain(env, { purpose: 'asr' })[0];
}

function normalizeMime(mimeType) {
  const raw = String(mimeType || '')
    .toLowerCase()
    .split(';')[0]
    .trim();
  if (!raw) return 'audio/webm';
  if (raw === 'audio/x-wav' || raw === 'audio/wave') return 'audio/wav';
  if (raw === 'audio/x-m4a' || raw === 'audio/m4a') return 'audio/mp4';
  if (raw === 'video/webm') return 'audio/webm';
  if (raw === 'video/mp4') return 'audio/mp4';
  return raw;
}

function candidateText(data) {
  const parts = data?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return '';
  return parts
    .filter((part) => typeof part?.text === 'string' && !part.thought)
    .map((part) => part.text)
    .join('')
    .trim();
}

async function generate(
  body,
  { fetchImpl = fetch, env = process.env, signal, purpose = 'voice' } = {},
) {
  const key = geminiApiKey(env);
  if (!key) throw new Error('GEMINI_API_KEY is not set');
  const deadline = AbortSignal.any(
    [signal, AbortSignal.timeout(TOTAL_TIMEOUT_MS)].filter(Boolean),
  );
  const postModel = (model) => {
    const requestBody = NO_MINIMAL_THINKING.has(model)
      ? withThinkingLevel(body, 'low')
      : body;
    return fetchImpl(
      `${GEMINI_BASE}/${encodeURIComponent(model)}:generateContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': key,
        },
        body: JSON.stringify(requestBody),
        signal: AbortSignal.any([
          deadline,
          AbortSignal.timeout(PER_MODEL_TIMEOUT_MS),
        ]),
      },
    );
  };
  let lastError = null;
  for (const model of geminiModelChain(env, { purpose })) {
    if (deadline.aborted) break;
    try {
      const response = await postModel(model);
      const data = await response.json().catch(() => ({}));
      if (
        !response.ok &&
        response.status === 400 &&
        body?.generationConfig?.thinkingConfig?.thinkingLevel === 'minimal' &&
        !NO_MINIMAL_THINKING.has(model) &&
        /thinking/i.test(String(data?.error?.message || ''))
      ) {
        // e.g. gemini-3.8-flash rejects 'minimal'. Remember and retry once
        // at the lowest level it accepts instead of dropping to the next model.
        NO_MINIMAL_THINKING.add(model);
        const retry = await postModel(model);
        const retryData = await retry.json().catch(() => ({}));
        if (retry.ok) {
          preferredModel = model;
          return { text: candidateText(retryData), model };
        }
        lastError = new Error(`Gemini ${model} HTTP ${retry.status}`);
        continue;
      }
      if (!response.ok) {
        // Never echo the request (it carries the key header); status + short reason only.
        const reason = String(
          data?.error?.status || data?.error?.message || '',
        ).slice(0, 80);
        lastError = new Error(
          `Gemini ${model} HTTP ${response.status}${reason ? ` ${reason}` : ''}`,
        );
        continue;
      }
      const text = candidateText(data);
      preferredModel = model;
      return { text, model };
    } catch (error) {
      lastError = new Error(
        error?.name === 'TimeoutError' || error?.name === 'AbortError'
          ? `Gemini ${model} timed out`
          : `Gemini ${model} failed`,
      );
    }
  }
  throw lastError || new Error('Gemini unavailable');
}

const TRANSCRIBE_PROMPT =
  'Transcribe the spoken English in this audio clip verbatim. It may be a ' +
  'voice command for a 3D globe app (place names and map data layers). ' +
  'Write only words that are actually spoken in the audio; never guess, ' +
  'complete or invent a command. If the clip has no clearly spoken words ' +
  '(silence, noise, hum, music, breathing, or unintelligible sound), reply ' +
  'with exactly: NO_SPEECH. Reply with only the transcript, no quotes or ' +
  'commentary.';

/** Transcribe a base64 audio clip. Returns { text, model }. */
export async function geminiTranscribe(
  { audio, mimeType },
  { fetchImpl, env, signal } = {},
) {
  const data = String(audio || '').replace(/^data:[^,]*,/, '');
  if (!data) throw new Error('ASR requires audio');
  if (clipHasSpeech(data, mimeType) === false) {
    return { text: '', model: 'speech-gate', noSpeech: true };
  }
  const result = await generate(
    {
      contents: [
        {
          role: 'user',
          parts: [
            { inline_data: { mime_type: normalizeMime(mimeType), data } },
            { text: TRANSCRIBE_PROMPT },
          ],
        },
      ],
      generationConfig: {
        temperature: 0,
        maxOutputTokens: 200,
        thinkingConfig: { thinkingLevel: 'minimal' },
      },
    },
    { fetchImpl, env, signal, purpose: 'asr' },
  );
  const text = result.text
    .replace(/^["“”'\s]+|["“”'\s]+$/g, '')
    .replace(/^(transcript|transcription)\s*:\s*/i, '')
    .trim();
  if (/^no[_ ]speech\.?$/i.test(text)) {
    return { text: '', model: result.model, noSpeech: true };
  }
  return { text, model: result.model };
}

const INTENT_TOOLS = [
  'fly_to_location {query: string}',
  'set_layer_visibility {layerId: one of the layer ids, enabled: boolean}',
  'select_nearest_aircraft {layerId: "flights"|"military", locationQuery?: string}',
  'control_cockpit {action: "enter"|"exit"}',
  'control_cctv {action: "nearest"}',
];

/**
 * Map a transcript the deterministic planner could not act on to tool calls.
 * Output is validated: unknown tools / layer ids are dropped.
 */
export async function geminiIntent(
  text,
  { fetchImpl, env, signal, lastLocationQuery } = {},
) {
  const spoken = String(text || '').trim();
  if (!spoken) return { calls: [], speech: '' };
  const layers = VOICE_LAYER_IDS.map(
    (id) => `${id} (${VOICE_LAYER_LABELS[id]})`,
  ).join(', ');
  const prompt = [
    "You control God's Eye View, a 3D globe. Convert the user's voice command into tool calls.",
    `Tools: ${INTENT_TOOLS.join('; ')}.`,
    `Layer ids: ${layers}.`,
    lastLocationQuery ? `The last place was ${lastLocationQuery}.` : '',
    'Reply with JSON only: {"calls":[{"name":"...","arguments":{...}}],"speech":"one short sentence"}.',
    'Use an empty calls array if the request cannot be done with these tools.',
    `Command: ${JSON.stringify(spoken)}`,
  ]
    .filter(Boolean)
    .join('\n');
  const result = await generate(
    {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0,
        maxOutputTokens: 400,
        responseMimeType: 'application/json',
        thinkingConfig: { thinkingLevel: 'minimal' },
      },
    },
    { fetchImpl, env, signal },
  );
  return { ...sanitizeIntent(result.text), model: result.model };
}

export function sanitizeIntent(raw) {
  let parsed = null;
  try {
    parsed =
      typeof raw === 'string'
        ? JSON.parse(raw.replace(/^```(?:json)?|```$/g, '').trim())
        : raw;
  } catch {
    parsed = null;
  }
  const calls = [];
  for (const call of Array.isArray(parsed?.calls)
    ? parsed.calls.slice(0, 4)
    : []) {
    const name = String(call?.name || '');
    const args =
      call?.arguments && typeof call.arguments === 'object'
        ? call.arguments
        : {};
    if (name === 'set_layer_visibility') {
      if (!VOICE_LAYER_IDS.includes(args.layerId)) continue;
      calls.push({
        name,
        arguments: { layerId: args.layerId, enabled: args.enabled !== false },
      });
    } else if (name === 'fly_to_location') {
      const query = String(args.query || '')
        .trim()
        .slice(0, 120);
      if (!query) continue;
      calls.push({ name, arguments: { query, waitForArrival: true } });
    } else if (name === 'select_nearest_aircraft') {
      const layerId = args.layerId === 'military' ? 'military' : 'flights';
      const next = { layerId };
      if (args.locationQuery)
        next.locationQuery = String(args.locationQuery).slice(0, 120);
      calls.push({ name, arguments: next });
    } else if (name === 'control_cockpit') {
      if (!['enter', 'exit'].includes(args.action)) continue;
      calls.push({ name, arguments: { action: args.action } });
    } else if (name === 'control_cctv') {
      calls.push({ name, arguments: { action: 'nearest' } });
    }
  }
  const speech =
    typeof parsed?.speech === 'string' ? parsed.speech.slice(0, 200) : '';
  return { calls, speech };
}
