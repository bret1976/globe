import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { selfHostedVoiceProxy } from '../voice.js';
import { hostedAsrConfigured, transcribeWithHostedAsr } from './hostedAsr.js';

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
  let payload = '';
  const res = {
    statusCode: 200,
    headers: {},
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    end(chunk) {
      payload += chunk || '';
    },
  };
  return Promise.resolve(handler(req, res)).then(() => ({
    status: res.statusCode,
    body: payload ? JSON.parse(payload) : null,
  }));
}

test('hosted ASR is off without GEMINI_API_KEY', () => {
  assert.equal(hostedAsrConfigured({}), false);
  assert.equal(hostedAsrConfigured({ GEMINI_API_KEY: '   ' }), false);
  assert.equal(hostedAsrConfigured({ GEMINI_API_KEY: 'test-key' }), true);
});

test('hosted ASR reads the Gemini transcript text', async () => {
  const result = await transcribeWithHostedAsr(
    { audio: 'Zg==', mimeType: 'audio/webm' },
    {
      env: { GEMINI_API_KEY: 'test-key' },
      fetchImpl: async (url, options) => {
        assert.match(String(url), /gemini-2\.5-flash:generateContent/);
        assert.equal(options.headers['x-goog-api-key'], 'test-key');
        const body = JSON.parse(options.body);
        assert.equal(
          body.contents[0].parts[1].inline_data.mime_type,
          'audio/webm',
        );
        return Response.json({
          candidates: [
            { content: { parts: [{ text: 'Take me to the Pentagon' }] } },
          ],
        });
      },
    },
  );
  assert.equal(result.text, 'Take me to the Pentagon');
});

test('hosted ASR falls back when the preferred Gemini model rejects', async () => {
  const models = [];
  const result = await transcribeWithHostedAsr(
    { audio: 'Zg==', mimeType: 'audio/webm' },
    {
      env: { GEMINI_API_KEY: 'test-key', GEMINI_ASR_MODEL: 'gemini-3.6-flash' },
      fetchImpl: async (url) => {
        models.push(String(url));
        if (String(url).includes('gemini-3.6-flash')) {
          return Response.json(
            { error: { message: 'model not found' } },
            { status: 404 },
          );
        }
        return Response.json({
          candidates: [{ content: { parts: [{ text: 'Show earthquakes' }] } }],
        });
      },
    },
  );
  assert.equal(result.text, 'Show earthquakes');
  assert.match(models[0], /gemini-3\.6-flash/);
  assert.ok(models.some((url) => url.includes('gemini-2.5-flash')));
});

test('voice ASR uses hosted Gemini when the GPU box is offline', async () => {
  const previousInference = process.env.VOICE_INFERENCE_URL;
  const previousKey = process.env.GEMINI_API_KEY;
  delete process.env.VOICE_INFERENCE_URL;
  process.env.GEMINI_API_KEY = 'test-key';
  try {
    const routes = install(
      selfHostedVoiceProxy({
        fetchImpl: async () =>
          Response.json({
            candidates: [
              { content: { parts: [{ text: 'Find the nearest flight' }] } },
            ],
          }),
      }),
    );
    const status = await request(routes.get('/api/voice/status'));
    assert.equal(status.body.asr, true);
    assert.equal(status.body.hostedAsr, true);
    const res = await request(routes.get('/api/voice/asr'), {
      method: 'POST',
      body: JSON.stringify({ audio: 'Zg==', mimeType: 'audio/webm' }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.text, 'Find the nearest flight');
  } finally {
    if (previousInference === undefined) delete process.env.VOICE_INFERENCE_URL;
    else process.env.VOICE_INFERENCE_URL = previousInference;
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousKey;
  }
});
