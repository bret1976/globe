/** Same-origin self-hosted voice endpoints. No OpenAI key. */

export function createSelfHostedBackend({
  statusEndpoint = '/api/voice/status',
  asrEndpoint = '/api/voice/asr',
  actEndpoint = '/api/voice/act',
  ttsEndpoint = '/api/voice/tts',
  transport = (...args) => fetch(...args),
  timeoutMs = 45_000,
  signal: lifetime,
} = {}) {
  const scoped = (signal) =>
    AbortSignal.any(
      [lifetime, signal, AbortSignal.timeout(timeoutMs)].filter(Boolean),
    );

  return Object.freeze({
    protocol: 'self-hosted-qwen',
    async status({ signal } = {}) {
      const response = await transport(statusEndpoint, {
        signal: scoped(signal),
        cache: 'no-store',
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok)
        throw new Error(data.error || `Voice status HTTP ${response.status}`);
      return data;
    },
    async transcribe({ audio, mimeType = 'audio/webm', signal } = {}) {
      if (!audio) throw new TypeError('ASR requires audio');
      const response = await transport(asrEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          audio: uint8ToBase64(audio),
          mimeType,
          model: 'Qwen3-ASR-0.6B',
        }),
        signal: scoped(signal),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok)
        throw new Error(data.error || `Voice ASR HTTP ${response.status}`);
      if (typeof data.text !== 'string' || !data.text.trim())
        throw new Error('ASR returned no transcript');
      return data;
    },
    async act({ text, viewport, lastLocationQuery, lastPlace, signal } = {}) {
      const response = await transport(actEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          viewport,
          lastLocationQuery,
          lastPlace,
          model: 'Qwen3-8B',
        }),
        signal: scoped(signal),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok)
        throw new Error(data.error || `Voice act HTTP ${response.status}`);
      return {
        calls: Array.isArray(data.calls) ? data.calls : [],
        speech: typeof data.speech === 'string' ? data.speech : '',
        source: data.source || 'planner',
        locationQuery: data.locationQuery || null,
        place: data.place || null,
      };
    },
    async speak({ text, signal } = {}) {
      const response = await transport(ttsEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, model: 'Kokoro-82M' }),
        signal: scoped(signal),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || `Voice TTS HTTP ${response.status}`);
      }
      const type = response.headers.get('content-type') || '';
      if (type.includes('application/json')) {
        const data = await response.json();
        return { text: data.speech || text, audio: null };
      }
      return { text, audio: await response.arrayBuffer() };
    },
  });
}

function uint8ToBase64(bytes) {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  let binary = '';
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (const octet of view) binary += String.fromCharCode(octet);
  return btoa(binary);
}
