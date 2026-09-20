import {
  handleVoiceAct,
  handleVoiceAsr,
  handleVoiceStatus,
  handleVoiceTts,
} from './voice/routes.js';

/**
 * Vite plugin: self-hosted Qwen3-ASR / Qwen3-8B / Kokoro voice.
 * No OpenAI key. GPU inference is optional via VOICE_INFERENCE_URL.
 */
function selfHostedVoiceProxy({
  fetchImpl = (...args) => fetch(...args),
} = {}) {
  function install(middlewares) {
    middlewares.use('/api/voice/status', (req, res) =>
      handleVoiceStatus(req, res, { fetchImpl }),
    );
    middlewares.use('/api/voice/asr', (req, res) =>
      handleVoiceAsr(req, res, { fetchImpl }),
    );
    middlewares.use('/api/voice/act', (req, res) =>
      handleVoiceAct(req, res, { fetchImpl }),
    );
    middlewares.use('/api/voice/tts', (req, res) =>
      handleVoiceTts(req, res, { fetchImpl }),
    );
  }

  return {
    name: 'self-hosted-voice-proxy',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}

export { selfHostedVoiceProxy };
