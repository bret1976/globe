import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { selfHostedVoiceProxy } from './voice.js';
import { resolveVoiceAct } from './voice/routes.js';

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
    headers: res.headers,
  }));
}

test('voice status reports the planner without a GPU box', async () => {
  const previous = process.env.VOICE_INFERENCE_URL;
  delete process.env.VOICE_INFERENCE_URL;
  try {
    const routes = install(selfHostedVoiceProxy());
    const res = await request(routes.get('/api/voice/status'));
    assert.equal(res.status, 200);
    assert.equal(res.body.protocol, 'self-hosted-qwen');
    assert.equal(res.body.planner, true);
    assert.equal(res.body.llm, true);
    assert.equal(res.body.asr, false);
    assert.equal(res.body.inference, false);
  } finally {
    if (previous === undefined) delete process.env.VOICE_INFERENCE_URL;
    else process.env.VOICE_INFERENCE_URL = previous;
  }
});

test('voice act uses the JS planner when inference is unset', async () => {
  const previous = process.env.VOICE_INFERENCE_URL;
  delete process.env.VOICE_INFERENCE_URL;
  try {
    const plan = await resolveVoiceAct({
      text: 'Take me to the Pentagon. Find the nearest flight. Enter cockpit.',
    });
    assert.equal(plan.source, 'planner');
    assert.equal(plan.calls.length, 3);
    assert.equal(plan.calls[0].arguments.query, 'Pentagon');
  } finally {
    if (previous === undefined) delete process.env.VOICE_INFERENCE_URL;
    else process.env.VOICE_INFERENCE_URL = previous;
  }
});

test('voice act prefers parsed Qwen tool calls when the GPU box answers', async () => {
  process.env.VOICE_INFERENCE_URL = 'http://voice-gpu.test';
  try {
    const plan = await resolveVoiceAct(
      { text: 'Take me to the Pentagon' },
      {
        fetchImpl: async () =>
          Response.json({
            choices: [
              {
                message: {
                  content: '',
                  tool_calls: [
                    {
                      function: {
                        name: 'fly_to_location',
                        arguments: '{"query":"Pentagon","waitForArrival":true}',
                      },
                    },
                  ],
                },
              },
            ],
          }),
      },
    );
    assert.equal(plan.source, 'qwen');
    assert.equal(plan.calls[0].name, 'fly_to_location');
  } finally {
    delete process.env.VOICE_INFERENCE_URL;
  }
});

test('voice TTS returns spoken text when Kokoro is offline', async () => {
  const previous = process.env.VOICE_INFERENCE_URL;
  delete process.env.VOICE_INFERENCE_URL;
  try {
    const routes = install(selfHostedVoiceProxy());
    const res = await request(routes.get('/api/voice/tts'), {
      method: 'POST',
      body: JSON.stringify({ text: 'Flying to Pentagon.' }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.speech, 'Flying to Pentagon.');
  } finally {
    if (previous === undefined) delete process.env.VOICE_INFERENCE_URL;
    else process.env.VOICE_INFERENCE_URL = previous;
  }
});
