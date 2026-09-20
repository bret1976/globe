/**
 * Deterministic understand/act planner for the self-hosted voice path.
 * Qwen3-8B can replace this when VOICE_INFERENCE_URL is set; this planner
 * always covers the Pentagon → nearest flight → cockpit flow without a key.
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
  'washington d.c': { locationId: 'dc', query: 'Washington DC' },
  'washington d.c.': { locationId: 'dc', query: 'Washington DC' },
  'white house': {
    query: 'White House',
    latitude: 38.8977,
    longitude: -77.0365,
  },
  austin: { locationId: 'austin', query: 'Austin' },
  london: { locationId: 'london', query: 'London' },
  'las vegas': { query: 'Las Vegas', latitude: 36.1699, longitude: -115.1398 },
  vegas: { query: 'Las Vegas', latitude: 36.1699, longitude: -115.1398 },
  'new york': { locationId: 'nyc', query: 'New York' },
  nyc: { locationId: 'nyc', query: 'New York' },
});

export function normalizeVoiceUtterance(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/[^a-z0-9.&'\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function matchPlace(normalized) {
  for (const [alias, place] of Object.entries(PLACE_ALIASES)) {
    if (normalized.includes(alias)) return { ...place };
  }
  const takeMe = normalized.match(
    /(?:take me to|fly to|go to|navigate to|show me)\s+(.+)$/,
  );
  if (takeMe?.[1]) {
    const rest = takeMe[1]
      .replace(/\b(and|then|find|enter|the nearest.*)$/i, '')
      .trim();
    const cleaned = rest.replace(/\bthe\b/g, '').trim();
    if (cleaned) return { query: cleaned };
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
  return (
    (/\bcockpit\b/.test(normalized) &&
      !/\b(exit|leave|get out)\b/.test(normalized)) ||
    /\benter (the )?cockpit\b/.test(normalized)
  );
}

function wantsCockpitExit(normalized) {
  return /\b(exit|leave|get out of) (the )?cockpit\b/.test(normalized);
}

function nearestLayerId(normalized) {
  return /\bmilitary\b/.test(normalized) ? 'military' : 'flights';
}

function locationQueryOf(place) {
  return place?.query || place?.locationId || null;
}

/**
 * @param {string} text
 * @param {{ lastLocationQuery?: string, lastPlace?: object, viewport?: { lat?: number, lon?: number } }} [context]
 * @returns {{ calls: Array<{ name: string, arguments: object }>, speech: string, locationQuery: string|null, place: object|null }}
 */
export function planSelfHostedVoiceTurn(text, context = {}) {
  const normalized = normalizeVoiceUtterance(text);
  const calls = [];
  const place = matchPlace(normalized) || context.lastPlace || null;
  const locationQuery =
    locationQueryOf(place) || context.lastLocationQuery || null;
  const viewport = context.viewport || {};

  if (matchPlace(normalized)) {
    const args = { waitForArrival: true };
    if (place.locationId) args.locationId = place.locationId;
    if (place.query) args.query = place.query;
    if (Number.isFinite(place.latitude) && Number.isFinite(place.longitude)) {
      args.latitude = place.latitude;
      args.longitude = place.longitude;
    }
    calls.push({ name: 'fly_to_location', arguments: args });
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
    place,
    speech: composeSelfHostedSpeech(calls, text),
  };
}

export function composeSelfHostedSpeech(calls, originalText) {
  if (!calls?.length) {
    return `I heard “${String(originalText || '').trim() || 'that'}” but I need a place, a nearest flight, or a cockpit command.`;
  }
  const parts = [];
  for (const call of calls) {
    if (call.name === 'fly_to_location') {
      parts.push(
        `Flying to ${call.arguments.query || call.arguments.locationId}.`,
      );
    } else if (call.name === 'select_nearest_aircraft') {
      parts.push('Finding the nearest airborne flight.');
    } else if (call.name === 'control_cockpit') {
      parts.push(
        call.arguments.action === 'exit'
          ? 'Leaving the cockpit.'
          : 'Entering the cockpit.',
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
        description: 'Fly the globe camera to a named place.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            locationId: { type: 'string' },
            latitude: { type: 'number' },
            longitude: { type: 'number' },
            waitForArrival: { type: 'boolean' },
          },
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
        'Call tools to fly the globe, select the nearest airborne aircraft, and enter or leave the cockpit.',
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
