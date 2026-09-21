import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { selfHostedVoiceProxy } from '../voice.js';
import {
  hostedTtsConfigured,
  hostedTtsModel,
  hostedTtsVoice,
  pcmToWav,
  synthesizeWithHostedTts,
} from './hostedTts.js';

function install(plugin) {
  const routes = new Map();
  plugin.configureServer({
    middlewares: {
      use(route, handler) {
        routes.set(route, handler);
      },
    },
  });
  return routes;
}

function request(handler, { method = 'GET', body = '' } = {}) {
  const req = Readable.from([Buffer.from(body)]);
  req.method = method;
  req.url = '/';
  const chunks = [];
  const res = {
    statusCode: 200,
    headers: {},
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    end(chunk) {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    },
  };
  return Promise.resolve(handler(req, res)).then(() => ({
    status: res.statusCode,
    headers: res.headers,
    buffer: Buffer.concat(chunks),
  }));
}

test('hosted TTS is off without GEMINI_API_KEY', () => {
  assert.equal(hostedTtsConfigured({}), false);
  assert.equal(hostedTtsConfigured({ GEMINI_API_KEY: '   ' }), false);
  assert.equal(hostedTtsConfigured({ GEMINI_API_KEY: 'test-key' }), true);
});

test('hosted TTS defaults to a natural Gemini voice', () => {
  assert.equal(hostedTtsModel({}), 'gemini-3.1-flash-tts-preview');
  assert.equal(hostedTtsVoice({}), 'Callirrhoe');
  assert.equal(hostedTtsVoice({ GEMINI_TTS_VOICE: 'Sulafat' }), 'Sulafat');
});

test('pcmToWav writes a valid RIFF header around 16-bit PCM', () => {
  const wav = pcmToWav(Buffer.from([0, 0, 1, 0]));
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  assert.equal(wav.readUInt32LE(24), 24000);
  assert.equal(wav.length, 48);
});

test('hosted TTS wraps Gemini PCM as wav audio', async () => {
  const pcm = Buffer.from([0, 0, 1, 0]);
  const result = await synthesizeWithHostedTts(
    { text: 'On my way to the Pentagon.' },
    {
      env: { GEMINI_API_KEY: 'test-key' },
      fetchImpl: async (url, options) => {
        assert.match(String(url), /gemini-3\.1-flash-tts-preview:generateContent/);
        assert.equal(options.headers['x-goog-api-key'], 'test-key');
        const body = JSON.parse(options.body);
        assert.equal(
          body.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig
            .voiceName,
          'Callirrhoe',
        );
        return Response.json({
          candidates: [
            {
              content: {
                parts: [
                  {
                    inlineData: {
                      mimeType: 'audio/L16;codec=pcm;rate=24000',
                      data: pcm.toString('base64'),
                    },
                  },
                ],
              },
            },
          ],
        });
      },
    },
  );
  assert.equal(result.contentType, 'audio/wav');
  assert.equal(result.voice, 'Callirrhoe');
  assert.equal(result.bytes.toString('ascii', 0, 4), 'RIFF');
});

test('voice TTS uses hosted Gemini when the GPU box is offline', async () => {
  const previousInference = process.env.VOICE_INFERENCE_URL;
  const previousKey = process.env.GEMINI_API_KEY;
  delete process.env.VOICE_INFERENCE_URL;
  process.env.GEMINI_API_KEY = 'test-key';
  const pcm = Buffer.from([0, 0, 1, 0]);
  try {
    const routes = install(
      selfHostedVoiceProxy({
        fetchImpl: async () =>
          Response.json({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      inlineData: {
                        mimeType: 'audio/L16;codec=pcm;rate=24000',
                        data: pcm.toString('base64'),
                      },
                    },
                  ],
                },
              },
            ],
          }),
      }),
    );
    const status = await request(routes.get('/api/voice/status'));
    const statusBody = JSON.parse(status.buffer.toString('utf8'));
    assert.equal(statusBody.hostedTts, true);
    assert.match(statusBody.models.tts, /tts/i);
    const res = await request(routes.get('/api/voice/tts'), {
      method: 'POST',
      body: JSON.stringify({ text: 'On my way to the Pentagon.' }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'audio/wav');
    assert.equal(res.buffer.toString('ascii', 0, 4), 'RIFF');
  } finally {
    if (previousInference === undefined) delete process.env.VOICE_INFERENCE_URL;
    else process.env.VOICE_INFERENCE_URL = previousInference;
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousKey;
  }
});
