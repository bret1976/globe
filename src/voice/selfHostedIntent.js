/**
 * Deterministic understand/act planner for the self-hosted voice path.
 * Qwen3-8B can replace this when VOICE_INFERENCE_URL is set; this planner
 * covers navigation, data layers, nearest flight, and cockpit without a key.
 */

const PLACE_ALIASES = Object.freeze({
  pentagon: {
    query: 'Pentagon',
    latitude: 38.8711,
    longitude: -77.0559,
  },
  'the pentagon': {
    query: 'Pentagon',
    latitude: 38.8711,
    longitude: -77.0559,
  },
  arlington: {
    query: 'Arlington Virginia',
    latitude: 38.8816,
    longitude: -77.091,
  },
  'washington dc': { locationId: 'dc', query: 'Washington DC' },
  'washington d c': { locationId: 'dc', query: 'Washington DC' },
  'washington d.c': { locationId: 'dc', query: 'Washington DC' },
  'washington d.c.': { locationId: 'dc', query: 'Washington DC' },
  'district of columbia': { locationId: 'dc', query: 'Washington DC' },
  'white house': {
    query: 'White House',
    latitude: 38.8977,
    longitude: -77.0365,
  },
  austin: { locationId: 'austin', query: 'Austin' },
  london: { locationId: 'london', query: 'London' },
  'las vegas airport': {
    query: 'Harry Reid International Airport',
    latitude: 36.084,
    longitude: -115.1537,
  },
  'harry reid': {
    query: 'Harry Reid International Airport',
    latitude: 36.084,
    longitude: -115.1537,
  },
  mccarran: {
    query: 'Harry Reid International Airport',
    latitude: 36.084,
    longitude: -115.1537,
  },
  summerlin: {
    query: '89135 Las Vegas',
    latitude: 36.1486,
    longitude: -115.333,
    zip: '89135',
  },
  89135: {
    query: '89135 Las Vegas',
    latitude: 36.1486,
    longitude: -115.333,
    zip: '89135',
  },
  'las vegas': { query: 'Las Vegas', latitude: 36.1699, longitude: -115.1398 },
  vegas: { query: 'Las Vegas', latitude: 36.1699, longitude: -115.1398 },
  'persian gulf': {
    query: 'Persian Gulf',
    latitude: 26.6,
    longitude: 51.8,
    rangeM: 900000,
    region: true,
  },
  'arabian gulf': {
    query: 'Persian Gulf',
    latitude: 26.6,
    longitude: 51.8,
    rangeM: 900000,
    region: true,
  },
  'the gulf': {
    query: 'Persian Gulf',
    latitude: 26.6,
    longitude: 51.8,
    rangeM: 900000,
    region: true,
  },
  'new york': { locationId: 'nyc', query: 'New York' },
  nyc: { locationId: 'nyc', query: 'New York' },
});

const LAYER_ALIASES = Object.freeze([
  ['street traffic', 'traffic'],
  ['road traffic', 'traffic'],
  ['live traffic', 'traffic'],
  ['traffic', 'traffic'],
  ['live vessels', 'ais-live-vessels'],
  ['live ships', 'ais-live-vessels'],
  ['live boats', 'ais-live-vessels'],
  ['vessels', 'ais-live-vessels'],
  ['ships', 'ais-live-vessels'],
  ['ais', 'ais-live-vessels'],
  ['submarine cables', 'telegeography-submarine-cables'],
  ['undersea cables', 'telegeography-submarine-cables'],
  ['sea cables', 'telegeography-submarine-cables'],
  ['cable seas', 'telegeography-submarine-cables'],
  ['cables', 'telegeography-submarine-cables'],
  ['live cameras', 'cctv'],
  ['cctv', 'cctv'],
  ['cameras', 'cctv'],
  ['street cameras', 'cctv'],
  ['flights', 'flights'],
  ['military', 'military'],
  ['fires', 'local-firms'],
  ['fire perimeters', 'fire-perimeters'],
  ['wildfire perimeters', 'fire-perimeters'],
  ['perimeters', 'fire-perimeters'],
  ['au fire', 'au-fire'],
  ['australia fire', 'au-fire'],
  ['earthquakes', 'earthquakes'],
  ['satellites', 'satellites'],
]);

const LAYER_FILLER =
  /\b(street traffic|road traffic|live traffic|traffic|live vessels|live ships|live boats|vessels|ships|ais|submarine cables|undersea cables|sea cables|cable seas|cables|live cameras|street cameras|cctv|cameras|fire perimeters|wildfire perimeters|perimeters|zip code|zip|cockpit view|data layers?|layer)\b/g;

const PLACE_ALIAS_KEYS = Object.keys(PLACE_ALIASES).sort(
  (a, b) => b.length - a.length,
);

export function normalizeVoiceUtterance(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/[^a-z0-9.&'\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function matchLayer(normalized) {
  for (const [alias, layerId] of LAYER_ALIASES) {
    if (normalized.includes(alias)) return layerId;
  }
  return null;
}

function stripLayerWords(normalized) {
  return String(normalized || '')
    .replace(LAYER_FILLER, ' ')
    .replace(
      /\b(take me to|fly me to|fly to|go to|navigate to|show me|turn on|enable|open)\b/g,
      ' ',
    )
    .replace(/\b(in|at|near|around|for|the|and|then|to|of)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function matchZip(normalized) {
  const zip = normalized.match(/\b(\d{5})\b/);
  if (!zip) return null;
  const city = /\blas vegas\b|\bvegas\b/.test(normalized)
    ? ' Las Vegas'
    : /\bwashington\b/.test(normalized)
      ? ' Washington DC'
      : '';
  return {
    query: `${zip[1]}${city}`.trim(),
    zip: zip[1],
  };
}

function matchAliasPlace(normalized) {
  for (const alias of PLACE_ALIAS_KEYS) {
    if (normalized.includes(alias)) return { ...PLACE_ALIASES[alias] };
  }
  if (
    /\bwashington\b/.test(normalized) &&
    /\b(dc|d c|district)\b/.test(normalized)
  )
    return { ...PLACE_ALIASES['washington dc'] };
  return null;
}

function matchPlace(normalized) {
  const zip = matchZip(normalized);
  if (zip) return zip;
  const alias = matchAliasPlace(normalized);
  if (alias) return alias;
  const takeMe = normalized.match(
    /(?:take me to|fly me to|fly to|go to|navigate to|show me)\s+(.+)$/,
  );
  if (takeMe?.[1]) {
    const rest = stripLayerWords(takeMe[1]);
    if (rest) return { query: rest };
  }
  return null;
}

function wantsNearestAircraft(normalized) {
  return (
    /\bnearest\b/.test(normalized) &&
    /\b(flight|flights|aircraft|plane|airplane|jet)\b/.test(normalized)
  );
}

function wantsCockpitEnter(normalized) {
  if (wantsCockpitExit(normalized)) return false;
  if (/\bcockpit view\b/.test(normalized)) return false;
  return (
    /\benter (the )?cockpit\b/.test(normalized) ||
    /\bgo into (the )?cockpit\b/.test(normalized) ||
    /\bget in(to)? (the )?cockpit\b/.test(normalized)
  );
}

function wantsCockpitExit(normalized) {
  return /\b(exit|leave|get out of) (the )?cockpit\b/.test(normalized);
}

function nearestLayerId(normalized) {
  return /\bmilitary\b/.test(normalized) ? 'military' : 'flights';
}

function locationQueryOf(place) {
  return place?.query || place?.locationId || place?.zip || null;
}

function flyArguments(place, layerId) {
  const args = { waitForArrival: true };
  if (place.locationId) args.locationId = place.locationId;
  if (place.query) args.query = place.query;
  if (Number.isFinite(place.latitude) && Number.isFinite(place.longitude)) {
    args.latitude = place.latitude;
    args.longitude = place.longitude;
  }
  if (Number.isFinite(place.rangeM)) args.rangeM = place.rangeM;
  else if (place.region || layerId === 'ais-live-vessels')
    args.viewMode = 'overview';
  else if (place.zip || layerId === 'traffic' || layerId === 'cctv')
    args.viewMode = 'close';
  return args;
}

/**
 * @param {string} text
 * @param {{ lastLocationQuery?: string, lastPlace?: object, viewport?: { lat?: number, lon?: number } }} [context]
 * @returns {{ calls: Array<{ name: string, arguments: object }>, speech: string, locationQuery: string|null, place: object|null }}
 */
export function planSelfHostedVoiceTurn(text, context = {}) {
  const normalized = normalizeVoiceUtterance(text);
  const calls = [];
  const spokenPlace = matchPlace(normalized);
  const place = spokenPlace || context.lastPlace || null;
  const locationQuery =
    locationQueryOf(spokenPlace) ||
    locationQueryOf(place) ||
    context.lastLocationQuery ||
    null;
  const viewport = context.viewport || {};
  const layerId = matchLayer(normalized);

  if (spokenPlace) {
    calls.push({
      name: 'fly_to_location',
      arguments: flyArguments(spokenPlace, layerId),
    });
  }

  if (layerId) {
    calls.push({
      name: 'set_layer_visibility',
      arguments: { layerId, enabled: true },
    });
    if (layerId === 'cctv') {
      calls.push({
        name: 'control_cctv',
        arguments: { action: 'nearest' },
      });
    }
  }

  if (wantsNearestAircraft(normalized)) {
    const args = { layerId: nearestLayerId(normalized) };
    if (place?.locationId) args.locationId = place.locationId;
    if (locationQuery) args.locationQuery = locationQuery;
    if (Number.isFinite(place?.latitude) && Number.isFinite(place?.longitude)) {
      args.latitude = place.latitude;
      args.longitude = place.longitude;
    } else if (
      !locationQuery &&
      Number.isFinite(viewport.lat) &&
      Number.isFinite(viewport.lon)
    ) {
      args.latitude = viewport.lat;
      args.longitude = viewport.lon;
    }
    calls.push({
      name: 'select_nearest_aircraft',
      arguments: args,
    });
  }

  if (wantsCockpitExit(normalized)) {
    calls.push({
      name: 'control_cockpit',
      arguments: { action: 'exit' },
    });
  } else if (wantsCockpitEnter(normalized)) {
    calls.push({
      name: 'control_cockpit',
      arguments: {
        action: 'enter',
        targetLayer: nearestLayerId(normalized),
      },
    });
  }

  return {
    calls,
    locationQuery,
    place: spokenPlace || place,
    speech: composeSelfHostedSpeech(calls, text),
  };
}

export function composeSelfHostedSpeech(calls, originalText) {
  if (!calls?.length) {
    return `I heard “${String(originalText || '').trim() || 'that'}” — give me a place, zip code, traffic, vessels, cables, CCTV, a nearest flight, or a cockpit command.`;
  }
  const parts = [];
  for (const call of calls) {
    if (call.name === 'fly_to_location') {
      parts.push(
        `On my way to ${call.arguments.query || call.arguments.locationId}.`,
      );
    } else if (call.name === 'set_layer_visibility') {
      const labels = {
        traffic: 'street traffic',
        'ais-live-vessels': 'live vessels',
        'telegeography-submarine-cables': 'submarine cables',
        cctv: 'CCTV',
        flights: 'flights',
        military: 'military flights',
        'local-firms': 'fires',
        'fire-perimeters': 'fire perimeters',
        'au-fire': 'AU fire incidents',
        earthquakes: 'earthquakes',
        satellites: 'satellites',
      };
      parts.push(
        `I'll turn on ${labels[call.arguments.layerId] || call.arguments.layerId}.`,
      );
    } else if (call.name === 'control_cctv') {
      parts.push("I'll open the nearest camera.");
    } else if (call.name === 'select_nearest_aircraft') {
      parts.push("Looking for the closest flight that's in the air.");
    } else if (call.name === 'control_cockpit') {
      parts.push(
        call.arguments.action === 'exit'
          ? 'Stepping out of the cockpit.'
          : 'Heading into the cockpit.',
      );
    }
  }
  return parts.join(' ');
}

export function qwenToolDefinitions() {
  return [
    {
      type: 'function',
      function: {
        name: 'fly_to_location',
        description:
          'Fly the globe camera to a named place, zip code, or region.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            locationId: { type: 'string' },
            latitude: { type: 'number' },
            longitude: { type: 'number' },
            viewMode: { type: 'string', enum: ['close', 'overview'] },
            rangeM: { type: 'number' },
            waitForArrival: { type: 'boolean' },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'set_layer_visibility',
        description:
          'Turn a data layer on. Use traffic, ais-live-vessels, telegeography-submarine-cables, cctv, or fire-perimeters when asked.',
        parameters: {
          type: 'object',
          properties: {
            layerId: {
              type: 'string',
              enum: [
                'flights',
                'military',
                'traffic',
                'cctv',
                'ais-live-vessels',
                'telegeography-submarine-cables',
                'local-firms',
                'fire-perimeters',
                'au-fire',
                'earthquakes',
                'satellites',
              ],
            },
            enabled: { type: 'boolean' },
          },
          required: ['layerId', 'enabled'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'control_cctv',
        description: 'Select the nearest CCTV camera after the layer is on.',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['nearest', 'enable'] },
          },
          required: ['action'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'select_nearest_aircraft',
        description: 'Enable flights and select the nearest airborne aircraft.',
        parameters: {
          type: 'object',
          properties: {
            layerId: { type: 'string', enum: ['flights', 'military'] },
            locationId: { type: 'string' },
            locationQuery: { type: 'string' },
            latitude: { type: 'number' },
            longitude: { type: 'number' },
          },
          required: ['layerId'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'control_cockpit',
        description: 'Enter or exit the tracked-aircraft cockpit.',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['enter', 'exit'] },
            targetLayer: { type: 'string', enum: ['flights', 'military'] },
          },
          required: ['action'],
        },
      },
    },
  ];
}

export function parseQwenToolCalls(payload) {
  const message = payload?.choices?.[0]?.message;
  const raw = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
  const calls = [];
  for (const entry of raw) {
    const name = entry?.function?.name;
    if (!name) continue;
    let args = {};
    try {
      args = JSON.parse(entry.function.arguments || '{}');
    } catch {
      args = {};
    }
    calls.push({ name, arguments: args });
  }
  const speech =
    typeof message?.content === 'string' ? message.content.trim() : '';
  return { calls, speech };
}

export function qwenActMessages(text, context = {}) {
  return [
    {
      role: 'system',
      content: [
        "You are God's Eye View voice control.",
        'Call tools to fly the globe, turn on data layers, select the nearest airborne aircraft, and enter or leave the cockpit.',
        'For a zip code or named place use fly_to_location.',
        'For street traffic use set_layer_visibility layerId traffic.',
        'For live vessels or ships use set_layer_visibility layerId ais-live-vessels.',
        'For cables or cable seas use set_layer_visibility layerId telegeography-submarine-cables.',
        'For CCTV or cameras use set_layer_visibility layerId cctv and control_cctv nearest.',
        'For “Take me to the Pentagon” use fly_to_location with query Pentagon and the Pentagon coordinates.',
        'For “Find the nearest flight” use select_nearest_aircraft on flights with the last place or current view.',
        'For “Enter cockpit” use control_cockpit action enter.',
        'Prefer tool calls over chat. Keep any spoken reply to one short sentence.',
        context.lastLocationQuery
          ? `Last place: ${context.lastLocationQuery}.`
          : '',
      ]
        .filter(Boolean)
        .join(' '),
    },
    { role: 'user', content: String(text || '').trim() },
  ];
}
