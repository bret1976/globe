import test from 'node:test';
import assert from 'node:assert/strict';
import {
  composeSelfHostedSpeech,
  parseQwenToolCalls,
  planSelfHostedVoiceTurn,
} from './selfHostedIntent.js';
import { findPoiByName } from '../locations.js';

test('Pentagon is a unique curated POI, not a loose single-word match', () => {
  assert.deepEqual(findPoiByName('Pentagon'), { cityId: 'dc', index: 3 });
  assert.equal(findPoiByName('Tower'), null);
});

test('Pentagon → nearest flight → cockpit is one planner turn', () => {
  const plan = planSelfHostedVoiceTurn(
    'Take me to the Pentagon. Find the nearest flight. Enter the cockpit.',
  );
  assert.equal(plan.calls.length, 3);
  assert.equal(plan.calls[0].name, 'fly_to_location');
  assert.equal(plan.calls[0].arguments.query, 'Pentagon');
  assert.equal(plan.calls[0].arguments.latitude, 38.8711);
  assert.equal(plan.calls[0].arguments.longitude, -77.0559);
  assert.equal(plan.calls[0].arguments.waitForArrival, true);
  assert.equal(plan.calls[1].name, 'select_nearest_aircraft');
  assert.equal(plan.calls[1].arguments.layerId, 'flights');
  assert.equal(plan.calls[1].arguments.locationQuery, 'Pentagon');
  assert.equal(plan.calls[2].name, 'control_cockpit');
  assert.equal(plan.calls[2].arguments.action, 'enter');
  assert.match(plan.speech, /Flying to Pentagon/);
  assert.match(plan.speech, /nearest airborne flight/);
  assert.match(plan.speech, /Entering the cockpit/);
});

test('follow-up nearest flight reuses the last Pentagon place', () => {
  const first = planSelfHostedVoiceTurn('Take me to the Pentagon');
  const second = planSelfHostedVoiceTurn('Find the nearest flight', {
    lastLocationQuery: first.locationQuery,
    lastPlace: first.place,
  });
  assert.equal(second.calls[0].name, 'select_nearest_aircraft');
  assert.equal(second.calls[0].arguments.locationQuery, 'Pentagon');
  assert.equal(second.calls[0].arguments.latitude, 38.8711);
});

test('nearest aircraft without a place uses viewport coordinates', () => {
  const plan = planSelfHostedVoiceTurn('Find the nearest aircraft', {
    viewport: { lat: 38.87, lon: -77.05 },
  });
  assert.equal(plan.calls[0].name, 'select_nearest_aircraft');
  assert.equal(plan.calls[0].arguments.latitude, 38.87);
  assert.equal(plan.calls[0].arguments.longitude, -77.05);
  assert.equal(plan.calls[0].arguments.locationQuery, undefined);
});

test('unknown utterance asks for a place, flight, or cockpit command', () => {
  const plan = planSelfHostedVoiceTurn('what color is the sky');
  assert.deepEqual(plan.calls, []);
  assert.match(plan.speech, /place/);
});

test('Qwen tool-call payloads flatten into planner-shaped calls', () => {
  const parsed = parseQwenToolCalls({
    choices: [
      {
        message: {
          content: 'On it.',
          tool_calls: [
            {
              function: {
                name: 'control_cockpit',
                arguments: '{"action":"exit"}',
              },
            },
          ],
        },
      },
    ],
  });
  assert.deepEqual(parsed.calls, [
    { name: 'control_cockpit', arguments: { action: 'exit' } },
  ]);
  assert.equal(parsed.speech, 'On it.');
  assert.equal(composeSelfHostedSpeech(parsed.calls), 'Leaving the cockpit.');
});
