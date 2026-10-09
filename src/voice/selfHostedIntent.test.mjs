import test from 'node:test';
import assert from 'node:assert/strict';
import {
  composeSelfHostedSpeech,
  parseQwenToolCalls,
  planSelfHostedVoiceTurn,
} from './selfHostedIntent.js';
import { findPoiByName } from '../locations.js';

test('Take me to Austin is a fly to Austin', () => {
  const plan = planSelfHostedVoiceTurn('Take me to Austin');
  assert.equal(plan.calls[0].name, 'fly_to_location');
  assert.equal(plan.calls[0].arguments.query, 'Austin');
  assert.equal(plan.calls[0].arguments.locationId, 'austin');
  assert.equal(plan.calls[0].arguments.waitForArrival, true);
});

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
    arguments: { layerId: 'traffic', enabled: true, focus: false },
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
  assert.equal(
    plan.calls[1].arguments.focus,
    false,
    'preserve the explicitly requested Gulf destination',
  );
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

test('airport cockpit view navigates, selects a local flight, then enters cockpit', () => {
  for (const text of [
    'Take me to Cockpit View Las Vegas Airport',
    'Take me to Las Vegas Airport Cockpit View',
  ]) {
    const plan = planSelfHostedVoiceTurn(text);
    assert.deepEqual(
      plan.calls.map((call) => call.name),
      ['fly_to_location', 'select_nearest_aircraft', 'control_cockpit'],
    );
    assert.equal(plan.calls[1].arguments.latitude, 36.084);
    assert.equal(plan.calls[2].arguments.action, 'enter');
  }
});

test('explicit enter cockpit still enters', () => {
  const plan = planSelfHostedVoiceTurn('Enter the cockpit');
  assert.equal(plan.calls[0].name, 'control_cockpit');
  assert.equal(plan.calls[0].arguments.action, 'enter');
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
  assert.equal(
    composeSelfHostedSpeech(parsed.calls),
    'Stepping out of the cockpit.',
  );
});

test('layer-only requests never geocode a layer name as a destination', () => {
  for (const [label, layerId] of [
    ['satellites', 'satellites'],
    ['military flights', 'military'],
    ['data centers', 'local-datacenters'],
    ['mapped ALPR cameras', 'alpr-cameras'],
    ['bike share', 'bikeshare'],
    ['space missions', 'rocket-launches'],
    ['earthquakes', 'earthquakes'],
    ['transit', 'transit'],
    ['dams', 'local-dams'],
  ]) {
    const plan = planSelfHostedVoiceTurn(`Show me ${label}`);
    assert.deepEqual(plan.calls, [
      { name: 'set_layer_visibility', arguments: { layerId, enabled: true } },
    ]);
  }
});

test('mic commands cover every data layer, including aurora and turning layers off', () => {
  for (const [phrase, layerId, enabled] of [
    ['show earthquakes', 'earthquakes', true],
    ['turn on aurora', 'aurora', true],
    ['turn on the northern lights', 'aurora', true],
    ['show volcanoes', 'volcanoes', true],
    ['show flight restrictions', 'flight-restrictions', true],
    ['show weather balloons', 'radiosondes', true],
    ['show the ionosphere', 'ionosphere', true],
    ['show ukraine war fires', 'ukraine-fires', true],
    ['turn off aurora', 'aurora', false],
    ['hide earthquakes', 'earthquakes', false],
  ]) {
    const plan = planSelfHostedVoiceTurn(phrase);
    assert.deepEqual(
      plan.calls,
      [{ name: 'set_layer_visibility', arguments: { layerId, enabled } }],
      phrase,
    );
  }
  const tokyo = planSelfHostedVoiceTurn('fly to Tokyo');
  assert.equal(tokyo.calls[0].name, 'fly_to_location');
  assert.match(tokyo.calls[0].arguments.query, /tokyo/i);
});

test('zoom-to and take-me-over-to phrasing fly without the model', () => {
  for (const text of ['Zoom to Ukraine', 'zoom in on Ukraine']) {
    const plan = planSelfHostedVoiceTurn(text);
    assert.equal(plan.calls[0].name, 'fly_to_location');
    assert.equal(plan.calls[0].arguments.query, 'ukraine');
  }
  const long = planSelfHostedVoiceTurn(
    "Okay, so what I'd like you to do now is take me over to Tokyo, Japan and then turn on the flights layer so I can see the planes around there.",
  );
  assert.deepEqual(
    long.calls.map((call) => call.name),
    ['fly_to_location', 'set_layer_visibility'],
  );
  assert.equal(long.calls[0].arguments.query, 'tokyo japan');
  assert.equal(long.calls[1].arguments.layerId, 'flights');
  assert.equal(long.calls[1].arguments.enabled, true);
});

test('turn off all layers is one clear, including reset and an empty viewport', () => {
  const viewport = { lat: 0, lon: 0, enabledLayers: ['earthquakes', 'aurora'] };
  for (const text of [
    'Turn off all layers.',
    'turn everything off',
    'clear the map',
    'hide all layers',
    'reset the globe',
  ]) {
    const plan = planSelfHostedVoiceTurn(text, { viewport });
    assert.deepEqual(plan.calls, [{ name: 'clear_layers', arguments: {} }], text);
    assert.equal(plan.speech, 'Turning off all layers.');
  }
  const none = planSelfHostedVoiceTurn('turn off all layers', {
    viewport: { enabledLayers: [] },
  });
  assert.deepEqual(none.calls, []);
  assert.equal(none.speech, 'All layers are already off.');
  assert.equal(
    planSelfHostedVoiceTurn('turn off all layers except flights').calls.length,
    0,
  );
});

test('a three-command sentence keeps order and does not flip later layers off', () => {
  const mixed = planSelfHostedVoiceTurn(
    'turn off satellites, fly to Tokyo, and turn on flights',
  );
  assert.deepEqual(
    mixed.calls.map((call) => [
      call.name,
      call.arguments.layerId || call.arguments.query,
      call.arguments.enabled,
    ]),
    [
      ['set_layer_visibility', 'satellites', false],
      ['fly_to_location', 'tokyo', undefined],
      ['set_layer_visibility', 'flights', true],
    ],
  );
  const sequence = planSelfHostedVoiceTurn(
    'zoom to Ukraine. turn off all layers. fly to Tokyo and turn on flights',
  );
  assert.deepEqual(
    sequence.calls.map((call) => [
      call.name,
      call.arguments.layerId || call.arguments.query,
      call.arguments.enabled,
    ]),
    [
      ['fly_to_location', 'ukraine', undefined],
      ['clear_layers', undefined, undefined],
      ['fly_to_location', 'tokyo', undefined],
      ['set_layer_visibility', 'flights', true],
    ],
  );
});

test('two layers in one on or off clause keep that polarity', () => {
  const off = planSelfHostedVoiceTurn('turn off earthquakes and aurora');
  assert.deepEqual(
    off.calls.map((call) => [call.arguments.layerId, call.arguments.enabled]),
    [
      ['earthquakes', false],
      ['aurora', false],
    ],
  );
  assert.deepEqual(
    planSelfHostedVoiceTurn('show military planes').calls.map(
      (call) => call.arguments.layerId,
    ),
    ['military'],
  );
  assert.equal(
    planSelfHostedVoiceTurn('turn on the flight').calls[0].arguments.layerId,
    'flights',
  );
  const on = planSelfHostedVoiceTurn('fly to Tokyo and turn on flights');
  assert.equal(on.calls[0].name, 'fly_to_location');
  assert.equal(on.calls[1].arguments.layerId, 'flights');
  assert.equal(on.calls[1].arguments.enabled, true);
});
