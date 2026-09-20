import test from 'node:test';
import assert from 'node:assert/strict';
import { createSelfHostedSession } from './selfHostedSession.js';
import { createVoiceSession } from './session.js';

function backendFixture(plan) {
  const calls = [];
  return {
    protocol: 'self-hosted-qwen',
    async status() {
      return {
        asr: false,
        llm: true,
        tts: false,
        protocol: 'self-hosted-qwen',
      };
    },
    async act(payload) {
      calls.push(['act', payload.text]);
      return plan;
    },
    async speak({ text }) {
      calls.push(['speak', text]);
      return { text, audio: null };
    },
    calls,
  };
}

test('self-hosted session runs planner actions then speaks', async () => {
  const actions = [];
  const events = [];
  const backend = backendFixture({
    calls: [
      {
        name: 'fly_to_location',
        arguments: { query: 'Pentagon', waitForArrival: true },
      },
      { name: 'select_nearest_aircraft', arguments: { layerId: 'flights' } },
      { name: 'control_cockpit', arguments: { action: 'enter' } },
    ],
    speech:
      'Flying to Pentagon. Finding the nearest airborne flight. Entering the cockpit.',
    locationQuery: 'Pentagon',
    place: { query: 'Pentagon' },
    source: 'planner',
  });
  const session = createVoiceSession({
    runner: async (name, args) => {
      actions.push([name, args]);
      return { ok: true, name };
    },
    createAdapter: (hooks) =>
      createSelfHostedSession({
        ...hooks,
        backend,
      }),
  });
  session.subscribe((event) => events.push(event.type));
  await session.start();
  assert.equal(session.isActive(), true);
  assert.equal(await session.sendText('Take me to the Pentagon'), true);
  assert.deepEqual(
    actions.map(([name]) => name),
    ['fly_to_location', 'select_nearest_aircraft', 'control_cockpit'],
  );
  assert.ok(backend.calls.some(([kind]) => kind === 'speak'));
  assert.ok(events.includes('action-call'));
  assert.ok(events.includes('completion'));
  session.stop();
});

test('start() begins SpeechRecognition before awaiting backend status', async () => {
  const order = [];
  let recognition;
  const previousRecognition = globalThis.SpeechRecognition;
  const previousWebkit = globalThis.webkitSpeechRecognition;
  class FakeRecognition {
    constructor() {
      recognition = this;
      this.lang = '';
      this.continuous = false;
      this.interimResults = false;
      this.maxAlternatives = 1;
    }
    start() {
      order.push('recognition-start');
    }
    stop() {
      order.push('recognition-stop');
    }
  }
  globalThis.SpeechRecognition = FakeRecognition;
  globalThis.webkitSpeechRecognition = undefined;
  let resolveStatus;
  const statusGate = new Promise((resolve) => {
    resolveStatus = resolve;
  });
  const actions = [];
  const backend = backendFixture({
    calls: [
      {
        name: 'fly_to_location',
        arguments: { query: 'Pentagon', waitForArrival: true },
      },
    ],
    speech: 'Flying to Pentagon.',
    locationQuery: 'Pentagon',
    place: { query: 'Pentagon' },
    source: 'planner',
  });
  const originalStatus = backend.status;
  backend.status = async () => {
    order.push('status');
    await statusGate;
    return originalStatus();
  };
  try {
    const session = createVoiceSession({
      runner: async (name, args) => {
        actions.push([name, args]);
        return { ok: true, name };
      },
      createAdapter: (hooks) =>
        createSelfHostedSession({
          ...hooks,
          backend,
        }),
    });
    const started = session.start();
    assert.equal(order[0], 'recognition-start');
    assert.ok(recognition.continuous);
    assert.ok(recognition.interimResults);
    assert.equal(session.isActive(), true);
    resolveStatus();
    await started;
    recognition.onresult({
      results: [
        {
          0: { transcript: 'Take me to the Pentagon' },
          isFinal: true,
        },
      ],
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(
      actions.map(([name]) => name),
      ['fly_to_location'],
    );
    session.stop();
  } finally {
    globalThis.SpeechRecognition = previousRecognition;
    globalThis.webkitSpeechRecognition = previousWebkit;
  }
});

test('typed sendText activates an idle session and runs the planner', async () => {
  const actions = [];
  const backend = backendFixture({
    calls: [
      { name: 'select_nearest_aircraft', arguments: { layerId: 'flights' } },
    ],
    speech: 'Finding the nearest airborne flight.',
    source: 'planner',
  });
  const session = createVoiceSession({
    runner: async (name, args) => {
      actions.push([name, args]);
      return { ok: true, name };
    },
    createAdapter: (hooks) =>
      createSelfHostedSession({
        ...hooks,
        backend,
      }),
  });
  assert.equal(session.isActive(), false);
  assert.equal(await session.sendText('Find the nearest flight'), true);
  assert.deepEqual(
    actions.map(([name]) => name),
    ['select_nearest_aircraft'],
  );
  session.stop();
});
