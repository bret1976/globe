import test from 'node:test';
import assert from 'node:assert/strict';
import {
  geminiModelChain,
  geminiTranscribe,
  geminiIntent,
  sanitizeIntent,
} from './gemini.js';

const env = { GEMINI_API_KEY: 'test-key-not-real' };
const reply = (text, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () =>
    status === 200
      ? { candidates: [{ content: { parts: [{ text }] } }] }
      : { error: { status: 'NOT_FOUND' } },
});

test('never uses retired 1.x/2.x models', () => {
  assert.ok(
    !geminiModelChain({ GEMINI_VOICE_MODEL: 'gemini-2.0-flash' }).some((m) =>
      /^gemini-(1|2)\./.test(m),
    ),
  );
  assert.equal(
    geminiModelChain({ GEMINI_VOICE_MODEL: 'gemini-3.9-pro' })[0],
    'gemini-3.9-pro',
  );
});

test('GEMINI_ASR_MODEL leads speech-to-text and retired names are skipped', () => {
  assert.equal(
    geminiModelChain(
      { GEMINI_ASR_MODEL: 'gemini-3.8-flash' },
      { purpose: 'asr' },
    )[0],
    'gemini-3.8-flash',
  );
  const skipped = geminiModelChain(
    {
      GEMINI_ASR_MODEL: 'gemini-2.5-flash',
      GEMINI_VOICE_MODEL: 'gemini-3.6-flash',
    },
    { purpose: 'asr' },
  );
  assert.equal(skipped[0], 'gemini-3.6-flash');
  assert.ok(!skipped.some((model) => /^gemini-(1|2)\./.test(model)));
  assert.notEqual(
    geminiModelChain({ GEMINI_ASR_MODEL: 'gemini-3.8-flash' })[0],
    'gemini-3.8-flash',
  );
});

test('transcribe falls through a failing model and strips quotes', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push(url);
    assert.equal(init.headers['x-goog-api-key'], env.GEMINI_API_KEY);
    assert.ok(!url.includes(env.GEMINI_API_KEY));
    return seen.length === 1 ? reply('', 404) : reply('"Turn on aurora."');
  };
  const result = await geminiTranscribe(
    { audio: 'data:audio/wav;base64,AAAA', mimeType: 'audio/wav' },
    { fetchImpl, env },
  );
  assert.equal(result.text, 'Turn on aurora.');
  assert.equal(seen.length, 2);
});

test('errors never echo the key', async () => {
  const fetchImpl = async () => reply('', 403);
  await assert.rejects(
    geminiTranscribe(
      { audio: 'AAAA', mimeType: 'audio/webm' },
      { fetchImpl, env },
    ),
    (error) => !String(error.message).includes(env.GEMINI_API_KEY),
  );
});

test('intent output is validated against known tools and layers', async () => {
  const fetchImpl = async () =>
    reply(
      JSON.stringify({
        calls: [
          {
            name: 'set_layer_visibility',
            arguments: { layerId: 'aurora', enabled: true },
          },
          {
            name: 'set_layer_visibility',
            arguments: { layerId: 'not-a-layer', enabled: true },
          },
          { name: 'rm_rf', arguments: {} },
          { name: 'fly_to_location', arguments: { query: 'Tokyo' } },
        ],
        speech: 'Turning on aurora.',
      }),
    );
  const result = await geminiIntent('please show the aurora then go to tokyo', {
    fetchImpl,
    env,
  });
  assert.deepEqual(result.calls, [
    {
      name: 'set_layer_visibility',
      arguments: { layerId: 'aurora', enabled: true },
    },
    {
      name: 'fly_to_location',
      arguments: { query: 'Tokyo', waitForArrival: true },
    },
  ]);
  assert.deepEqual(sanitizeIntent('not json'), { calls: [], speech: '' });
});
