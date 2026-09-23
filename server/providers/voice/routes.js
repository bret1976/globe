import { readRequestBody } from '../common/request.js';
import {
  composeSelfHostedSpeech,
  parseQwenToolCalls,
  planSelfHostedVoiceTurn,
  qwenActMessages,
  qwenToolDefinitions,
} from '../../../src/voice/selfHostedIntent.js';
import {
  inferenceAudio,
  inferenceHealth,
  inferenceJson,
  KOKORO_TTS_MODEL,
  QWEN_ASR_MODEL,
  QWEN_LLM_MODEL,
  voiceInferenceConfigured,
} from './inference.js';

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
};

const BROWSER_ASR_MODEL = 'onnx-community/whisper-tiny.en';
const BROWSER_TTS_MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', JSON_HEADERS['Content-Type']);
  res.setHeader('Cache-Control', JSON_HEADERS['Cache-Control']);
  res.end(JSON.stringify(payload));
}

function methodNotAllowed(req, res, allowed) {
  if (allowed.includes(req.method)) return false;
  sendJson(res, 405, { error: 'Method not allowed' });
  return true;
}

async function readJsonBody(req, maxBytes) {
  const body = await readRequestBody(req, maxBytes);
  if (!body) return {};
  return JSON.parse(body);
}

export async function handleVoiceStatus(req, res, { fetchImpl } = {}) {
  if (methodNotAllowed(req, res, ['GET'])) return;
  const health = await inferenceHealth({ fetchImpl }).catch(() => ({
    configured: voiceInferenceConfigured(),
    asr: false,
    llm: false,
    tts: false,
  }));
  sendJson(res, 200, {
    protocol: 'self-hosted-qwen',
    planner: true,
    asr: Boolean(health.asr),
    llm: true,
    tts: Boolean(health.tts) || true,
    inference: Boolean(health.configured),
    browserAsr: true,
    browserTts: true,
    models: {
      asr: health.asr ? QWEN_ASR_MODEL : BROWSER_ASR_MODEL,
      llm: QWEN_LLM_MODEL,
      tts: health.tts ? KOKORO_TTS_MODEL : BROWSER_TTS_MODEL,
      ...(health.models || {}),
    },
  });
}

export async function handleVoiceAsr(req, res, { fetchImpl } = {}) {
  if (methodNotAllowed(req, res, ['POST'])) return;
  let payload;
  try {
    payload = await readJsonBody(req, 8 * 1024 * 1024);
  } catch (error) {
    sendJson(res, 400, { error: error?.message || 'Invalid ASR request' });
    return;
  }
  if (voiceInferenceConfigured()) {
    try {
      const data = await inferenceJson(
        '/asr',
        {
          audio: payload.audio,
          mimeType: payload.mimeType || 'audio/webm',
          model: payload.model || QWEN_ASR_MODEL,
        },
        { fetchImpl },
      );
      if (typeof data.text !== 'string' || !data.text.trim()) {
        sendJson(res, 502, { error: 'ASR returned no transcript' });
        return;
      }
      sendJson(res, 200, { text: data.text.trim(), model: QWEN_ASR_MODEL });
      return;
    } catch (error) {
      sendJson(res, 502, { error: error?.message || 'ASR failed' });
      return;
    }
  }
  sendJson(res, 503, {
    error:
      'Speech-to-text runs in the browser with Whisper. Optional GPU ASR is unset.',
  });
}

export async function resolveVoiceAct(payload, { fetchImpl } = {}) {
  const text = String(payload?.text || '').trim();
  const planner = planSelfHostedVoiceTurn(text, {
    lastLocationQuery: payload?.lastLocationQuery,
    lastPlace: payload?.lastPlace,
    viewport: payload?.viewport,
  });
  if (!voiceInferenceConfigured()) {
    return { ...planner, source: 'planner' };
  }
  try {
    const qwen = await inferenceJson(
      '/v1/chat/completions',
      {
        model: payload?.model || QWEN_LLM_MODEL,
        messages: qwenActMessages(text, {
          lastLocationQuery:
            planner.locationQuery || payload?.lastLocationQuery,
        }),
        tools: qwenToolDefinitions(),
        tool_choice: 'auto',
        temperature: 0,
      },
      { fetchImpl },
    );
    const parsed = parseQwenToolCalls(qwen);
    if (parsed.calls.length) {
      return {
        calls: parsed.calls,
        speech: parsed.speech || composeSelfHostedSpeech(parsed.calls, text),
        locationQuery: planner.locationQuery,
        place: planner.place,
        source: 'qwen',
      };
    }
  } catch {
    /* Planner remains authoritative when the GPU box is unreachable. */
  }
  return { ...planner, source: 'planner' };
}

export async function handleVoiceAct(req, res, { fetchImpl } = {}) {
  if (methodNotAllowed(req, res, ['POST'])) return;
  try {
    const payload = await readJsonBody(req, 64 * 1024);
    const plan = await resolveVoiceAct(payload, { fetchImpl });
    sendJson(res, 200, {
      calls: plan.calls,
      speech: plan.speech,
      source: plan.source,
      locationQuery: plan.locationQuery,
      place: plan.place,
    });
  } catch (error) {
    sendJson(res, 400, {
      error: error?.message || 'Invalid voice act request',
    });
  }
}

export async function handleVoiceTts(req, res, { fetchImpl } = {}) {
  if (methodNotAllowed(req, res, ['POST'])) return;
  let payload;
  try {
    payload = await readJsonBody(req, 64 * 1024);
  } catch (error) {
    sendJson(res, 400, { error: error?.message || 'Invalid TTS request' });
    return;
  }
  const text = String(payload?.text || '').trim();
  if (!text) {
    sendJson(res, 400, { error: 'TTS requires text' });
    return;
  }
  if (voiceInferenceConfigured()) {
    try {
      const audio = await inferenceAudio(
        '/tts',
        { text, model: payload.model || KOKORO_TTS_MODEL },
        { fetchImpl },
      );
      res.statusCode = 200;
      res.setHeader('Content-Type', audio.contentType || 'audio/wav');
      res.setHeader('Cache-Control', 'no-store');
      res.end(audio.bytes);
      return;
    } catch {
      /* Browser Kokoro / speechSynthesis remains the last resort. */
    }
  }
  sendJson(res, 200, { speech: text, audio: null, model: 'speechSynthesis' });
}
