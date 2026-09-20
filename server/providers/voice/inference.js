export const QWEN_ASR_MODEL = 'Qwen3-ASR-0.6B';
export const QWEN_LLM_MODEL = 'Qwen3-8B';
export const KOKORO_TTS_MODEL = 'Kokoro-82M';

export function voiceInferenceUrl() {
  const raw = String(process.env.VOICE_INFERENCE_URL || '').trim();
  return raw.replace(/\/+$/, '');
}

export function voiceInferenceConfigured() {
  return Boolean(voiceInferenceUrl());
}

export async function inferenceJson(
  path,
  body,
  { fetchImpl = fetch, signal } = {},
) {
  const base = voiceInferenceUrl();
  if (!base) throw new Error('VOICE_INFERENCE_URL is not set');
  const response = await fetchImpl(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      data.error || data.message || `Inference HTTP ${response.status}`,
    );
  }
  return data;
}

export async function inferenceHealth({ fetchImpl = fetch, signal } = {}) {
  const base = voiceInferenceUrl();
  if (!base) {
    return { configured: false, asr: false, llm: false, tts: false };
  }
  try {
    const response = await fetchImpl(`${base}/health`, {
      signal,
      cache: 'no-store',
    });
    const data = await response.json().catch(() => ({}));
    return {
      configured: true,
      asr: Boolean(data.asr ?? data.ok),
      llm: Boolean(data.llm ?? data.ok),
      tts: Boolean(data.tts ?? data.ok),
      models: data.models || {},
    };
  } catch {
    return { configured: true, asr: false, llm: false, tts: false };
  }
}

export async function inferenceAudio(
  path,
  body,
  { fetchImpl = fetch, signal } = {},
) {
  const base = voiceInferenceUrl();
  if (!base) throw new Error('VOICE_INFERENCE_URL is not set');
  const response = await fetchImpl(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(
      data.error || data.message || `Inference HTTP ${response.status}`,
    );
  }
  return {
    bytes: Buffer.from(await response.arrayBuffer()),
    contentType: response.headers.get('content-type') || 'audio/wav',
  };
}
