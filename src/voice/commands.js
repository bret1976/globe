import { createVoiceCommands as bindVoiceCommands } from './sessionCommands.js';
import { createSelfHostedSession } from './selfHostedSession.js';

/** Default composition: self-hosted Qwen/Kokoro. No OpenAI key. */
export function createVoiceCommands(options) {
  return bindVoiceCommands({
    createSession: createSelfHostedSession,
    ...options,
  });
}
