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
  assert.match(plan.speech, /On my way to Pentagon/);
  assert.match(plan.speech, /closest flight/);
  assert.match(plan.speech, /Heading into the cockpit/);
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

test('89135 Las Vegas street traffic flies to the zip and turns traffic on', () => {
  const plan = planSelfHostedVoiceTurn(
    'Take me to 89135 zip code, Las Vegas for street traffic',
  );
  assert.equal(plan.calls[0].name, 'fly_to_location');
  assert.equal(plan.calls[0].arguments.query, '89135 Las Vegas');
  assert.equal(plan.calls[0].arguments.viewMode, 'close');
  assert.deepEqual(plan.calls[1], {
    name: 'set_layer_visibility',
    arguments: { layerId: 'traffic', enabled: true },
  });
  assert.match(plan.speech, /89135/);
  assert.match(plan.speech, /street traffic/);
});

test('live vessels in the Persian Gulf flies there and enables ships', () => {
  const plan = planSelfHostedVoiceTurn(
    'Take me to the live vessels in the Persian Gulf',
  );
  assert.equal(plan.calls[0].name, 'fly_to_location');
  assert.equal(plan.calls[0].arguments.query, 'Persian Gulf');
  assert.equal(plan.calls[0].arguments.latitude, 26.6);
  assert.equal(plan.calls[1].name, 'set_layer_visibility');
  assert.equal(plan.calls[1].arguments.layerId, 'ais-live-vessels');
  assert.match(plan.speech, /live vessels/);
});

test('cable seas turns on submarine cables', () => {
  const plan = planSelfHostedVoiceTurn(
    'Take me to the cable seas for the cables',
  );
  assert.deepEqual(plan.calls, [
    {
      name: 'set_layer_visibility',
      arguments: {
        layerId: 'telegeography-submarine-cables',
        enabled: true,
      },
    },
  ]);
  assert.match(plan.speech, /submarine cables/);
});

test('CCTV in Washington DC flies to DC and opens a camera', () => {
  const plan = planSelfHostedVoiceTurn('Take me to CCTV in Washington, D.C.');
  assert.equal(plan.calls[0].name, 'fly_to_location');
  assert.equal(plan.calls[0].arguments.locationId, 'dc');
  assert.equal(plan.calls[1].name, 'set_layer_visibility');
  assert.equal(plan.calls[1].arguments.layerId, 'cctv');
  assert.deepEqual(plan.calls[2], {
    name: 'control_cctv',
    arguments: { action: 'nearest' },
  });
  assert.match(plan.speech, /CCTV/);
});

test('Las Vegas Airport cockpit view still flies and enters cockpit', () => {
  const plan = planSelfHostedVoiceTurn(
    'Take me to Las Vegas Airport Cockpit View',
  );
  assert.equal(plan.calls[0].name, 'fly_to_location');
  assert.match(plan.calls[0].arguments.query, /Harry Reid|Las Vegas/);
  assert.equal(plan.calls[1].name, 'control_cockpit');
  assert.equal(plan.calls[1].arguments.action, 'enter');
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
  assert.equal(composeSelfHostedSpeech(parsed.calls), 'Stepping out of the cockpit.');
});
