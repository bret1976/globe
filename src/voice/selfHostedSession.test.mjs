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
