import { createVoiceCommands as bindVoiceCommands } from './sessionCommands.js';
import { createBrowserVoice } from './browserVoice.js';
import { createSelfHostedSession } from './selfHostedSession.js';

/** Default composition: in-browser Whisper + Kokoro. No Gemini/OpenAI key. */
export function createVoiceCommands(options = {}) {
  const { createSession, browserVoice, ...rest } = options;
  const voice =
    browserVoice === undefined ? createBrowserVoice() : browserVoice;
  return bindVoiceCommands({
    createSession:
      createSession ||
      ((hooks) => createSelfHostedSession({ ...hooks, browserVoice: voice })),
    ...rest,
  });
}
