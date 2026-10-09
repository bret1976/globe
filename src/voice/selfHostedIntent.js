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

/**
 * Every toggle in the layers list that voice can drive, with the spoken
 * label used in replies. Shared by the deterministic planner, the Gemini
 * intent fallback (server) and the Qwen tool enum so a new layer only needs
 * one entry here to become voice-controllable.
 */
export const VOICE_LAYER_LABELS = Object.freeze({
  satellites: 'satellites',
  flights: 'flights',
  military: 'military flights',
  'ais-live-vessels': 'live vessels',
  traffic: 'street traffic',
  transit: 'transit',
  bikeshare: 'bike share',
  cctv: 'CCTV',
  'recent-imagery': 'recent imagery',
  'military-installations': 'military installations',
  'local-datacenters': 'data centers',
  'power-plants': 'power plants',
  'telegeography-submarine-cables': 'submarine cables',
  'local-dams': 'dams',
  'alpr-cameras': 'mapped ALPR cameras',
  weather: 'observed weather',
  wind: 'wind',
  'weather-cyclones': 'cyclones',
  'nws-alerts': 'weather alerts',
  'ndbc-buoys': 'marine buoys',
  'usgs-gauges': 'stream gauges',
  'tide-gauges': 'tide gauges',
  'air-quality': 'air quality',
  'ocean-currents': 'ocean currents',
  radiosondes: 'weather balloons',
  'rocket-launches': 'rocket launches',
  'fz1073-2026': 'FlyDubai FZ1073',
  earthquakes: 'earthquakes',
  volcanoes: 'volcanoes',
  aurora: 'the aurora',
  ionosphere: 'ionosphere TEC',
  radiation: 'radiation',
  floods: 'floods and droughts',
  'usdm-drought': 'the drought monitor',
  'storm-reports': 'storm reports',
  'gps-interference': 'GPS interference',
  'flight-restrictions': 'flight restrictions',
  'ukraine-fires': 'Ukraine war fires',
  'local-firms': 'fires',
  'fire-perimeters': 'fire perimeters',
  'au-fire': 'AU fire incidents',
  directions: 'directions',
  radio: 'radio',
});

export const VOICE_LAYER_IDS = Object.freeze(Object.keys(VOICE_LAYER_LABELS));

const LAYER_ALIASES = Object.freeze([
  ['military flights', 'military'],
  ['military planes', 'military'],
  ['military aircraft', 'military'],
  ['military jets', 'military'],
  ['mapped alpr cameras', 'alpr-cameras'],
  ['alpr cameras', 'alpr-cameras'],
  ['mapped installations', 'military-installations'],
  ['military installations', 'military-installations'],
  ['military bases', 'military-installations'],
  ['data centers', 'local-datacenters'],
  ['data centres', 'local-datacenters'],
  ['dams', 'local-dams'],
  ['space missions', 'rocket-launches'],
  ['rocket launches', 'rocket-launches'],
  ['launches', 'rocket-launches'],
  ['bike share', 'bikeshare'],
  ['transit', 'transit'],
  ['directions', 'directions'],
  ['radio', 'radio'],
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
  ['flight', 'flights'],
  ['planes', 'flights'],
  ['airplanes', 'flights'],
  ['military', 'military'],
  ['fires', 'local-firms'],
  ['active fires', 'local-firms'],
  ['wildfires', 'local-firms'],
  ['fire perimeters', 'fire-perimeters'],
  ['wildfire perimeters', 'fire-perimeters'],
  ['perimeters', 'fire-perimeters'],
  ['au fire', 'au-fire'],
  ['australia fire', 'au-fire'],
  ['australia fires', 'au-fire'],
  ['ukraine fires', 'ukraine-fires'],
  ['ukraine fire', 'ukraine-fires'],
  ['ukraine war fires', 'ukraine-fires'],
  ['ukraine war', 'ukraine-fires'],
  ['war fires', 'ukraine-fires'],
  ['earthquakes', 'earthquakes'],
  ['earthquake', 'earthquakes'],
  ['quakes', 'earthquakes'],
  ['volcanoes', 'volcanoes'],
  ['volcanos', 'volcanoes'],
  ['volcano', 'volcanoes'],
  ['aurora', 'aurora'],
  ['auroras', 'aurora'],
  ['northern lights', 'aurora'],
  ['aurora borealis', 'aurora'],
  ['ionosphere', 'ionosphere'],
  ['electron content', 'ionosphere'],
  ['radiation', 'radiation'],
  ['floods', 'floods'],
  ['flooding', 'floods'],
  ['drought monitor', 'usdm-drought'],
  ['drought', 'usdm-drought'],
  ['droughts', 'usdm-drought'],
  ['storm reports', 'storm-reports'],
  ['tornado reports', 'storm-reports'],
  ['tornadoes', 'storm-reports'],
  ['flight restrictions', 'flight-restrictions'],
  ['no fly zones', 'flight-restrictions'],
  ['no-fly zones', 'flight-restrictions'],
  ['restricted airspace', 'flight-restrictions'],
  ['tfrs', 'flight-restrictions'],
  ['tfr', 'flight-restrictions'],
  ['weather alerts', 'nws-alerts'],
  ['weather warnings', 'nws-alerts'],
  ['nws alerts', 'nws-alerts'],
  ['buoys', 'ndbc-buoys'],
  ['marine buoys', 'ndbc-buoys'],
  ['stream gauges', 'usgs-gauges'],
  ['river gauges', 'usgs-gauges'],
  ['tide gauges', 'tide-gauges'],
  ['tides', 'tide-gauges'],
  ['air quality', 'air-quality'],
  ['air pollution', 'air-quality'],
  ['ocean currents', 'ocean-currents'],
  ['weather balloons', 'radiosondes'],
  ['radiosondes', 'radiosondes'],
  ['power plants', 'power-plants'],
  ['power stations', 'power-plants'],
  ['flydubai', 'fz1073-2026'],
  ['fly dubai', 'fz1073-2026'],
  ['gps jam', 'gps-interference'],
  ['gps jamming', 'gps-interference'],
  ['gps interference', 'gps-interference'],
  ['satellites', 'satellites'],
  ['recent imagery', 'recent-imagery'],
  ['satellite imagery', 'recent-imagery'],
  ['weather', 'weather'],
  ['observed weather', 'weather'],
  ['wind', 'wind'],
  ['cyclones', 'weather-cyclones'],
  ['hurricanes', 'weather-cyclones'],
  ['typhoons', 'weather-cyclones'],
]);

const LAYER_FILLER =
  /\b(street traffic|road traffic|live traffic|traffic|live vessels|live ships|live boats|vessels|ships|ais|submarine cables|undersea cables|sea cables|cable seas|cables|live cameras|street cameras|cctv|cameras|fire perimeters|wildfire perimeters|perimeters|recent imagery|satellite imagery|observed weather|weather|wind overlay|wind|cyclones|hurricanes|typhoons|zip code|zip|cockpit(?: view| mode)?|data layers?|layer)\b/g;

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

const SINGULAR_AIRCRAFT_ALIASES = new Set(['flight', 'planes', 'airplanes']);

/** Every distinct layer named in the utterance, in spoken order. */
function matchLayers(normalized) {
  let text = ` ${normalized} `;
  const found = [];
  // "nearest flight/plane" is an aircraft pick, not a layer toggle.
  const nearest = wantsNearestAircraft(normalized);
  for (const [alias, layerId] of [...LAYER_ALIASES].sort(
    (a, b) => b[0].length - a[0].length,
  )) {
    if (nearest && SINGULAR_AIRCRAFT_ALIASES.has(alias)) continue;
    const pattern = new RegExp(`\\b${alias}\\b`, 'g');
    let match;
    while ((match = pattern.exec(text))) {
      found.push({ at: match.index, layerId });
    }
    text = text.replace(pattern, (hit) => ' '.repeat(hit.length));
  }
  const ids = [];
  for (const { layerId } of found.sort((a, b) => a.at - b.at)) {
    if (!ids.includes(layerId)) ids.push(layerId);
  }
  return ids;
}

function stripLayerWords(normalized) {
  let text = String(normalized || '');
  for (const [alias] of [...LAYER_ALIASES].sort(
    (a, b) => b[0].length - a[0].length,
  )) {
    text = text.replace(new RegExp(`\\b${alias}\\b`, 'g'), ' ');
  }
  return text
    .replace(LAYER_FILLER, ' ')
    .replace(
      /\b(take me to|fly me to|fly to|go to|navigate to|zoom to|zoom in on|zoom on|center on|show me|turn on|turn off|switch on|switch off|enable|disable|hide|open)\b/g,
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

const NAVIGATE_TO =
  /(?:take me (?:over |back )?to|fly me (?:over )?to|fly (?:over )?to|go (?:over )?to|head (?:over )?to|navigate to|zoom (?:in )?(?:to|on|onto|into|over)|center (?:on|over)|show me)\s+(.+)$/;
const PLACE_PHRASE_END =
  /\s+(?:and|then|so|where|with|to see|while|because)\b|\s*[.;]\s*/;

function matchPlace(normalized) {
  const zip = matchZip(normalized);
  if (zip) return zip;
  const alias = matchAliasPlace(normalized);
  if (alias) return alias;
  const takeMe = normalized.match(NAVIGATE_TO);
  if (takeMe?.[1]) {
    // "take me over to Tokyo Japan and then turn on flights so I can see…"
    // → only "Tokyo Japan" is the place; the rest is the next instruction.
    const placePhrase = takeMe[1].split(PLACE_PHRASE_END)[0];
    const rest = stripLayerWords(placePhrase);
    if (rest) return { query: rest };
  }
  return null;
}

function wantsLayerOff(normalized) {
  return /\b(turn off|switch off|shut off|hide|disable|remove|stop showing|clear)\b/.test(
    normalized,
  );
}

function wantsAllLayersOff(normalized) {
  if (/\b(except|but)\b/.test(normalized)) return false;
  if (
    /\b(turn|switch|shut)\b/.test(normalized) &&
    /\boff\b/.test(normalized) &&
    /\b(all|every|everything)\b/.test(normalized) &&
    !/\b(turn|switch) on\b/.test(normalized)
  )
    return true;
  return (
    /\b(hide|disable|remove|clear) (all|every|everything)\b/.test(normalized) ||
    /\b(clear|reset) (the )?(map|globe)\b/.test(normalized) ||
    /\ball (the )?(data )?layers off\b/.test(normalized)
  );
}

function wantsNearestAircraft(normalized) {
  return (
    /\bnearest\b/.test(normalized) &&
    /\b(flight|flights|aircraft|plane|airplane|jet)\b/.test(normalized)
  );
}

function wantsCockpitEnter(normalized) {
  if (wantsCockpitExit(normalized)) return false;
  if (
    /\bcockpit(?: view| mode)?\b/.test(normalized) &&
    !/\b(no|not|don't|do not)\b/.test(normalized)
  )
    return true;
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

function clauseVerbPattern() {
  return /\b(turn off all(?: the)? layers|turn off every(?:thing| layer)|clear all(?: the)? layers|turn everything off|hide all(?: the)? layers|disable all(?: the)? layers|reset the globe|reset the map|clear the globe|clear the map|turn off|switch off|shut off|turn on|switch on|fly me to|fly to|zoom to|zoom on|zoom onto|zoom into|go to|take me to|navigate to|head to|center on|show me|hide|disable|enable)\b/g;
}

const FLY_CLAUSE_VERBS = new Set([
  'fly me to',
  'fly to',
  'zoom to',
  'zoom on',
  'zoom onto',
  'zoom into',
  'go to',
  'take me to',
  'navigate to',
  'head to',
  'center on',
  'show me',
]);

const LAYER_CLAUSE_VERBS = new Set([
  'turn off',
  'switch off',
  'shut off',
  'turn on',
  'switch on',
  'hide',
  'disable',
  'enable',
]);

/**
 * One spoken turn can carry several commands. "and" stays inside a command
 * ("earthquakes and aurora", "fly to Tokyo and turn on flights"). A new
 * verb starts the next command, except a fly followed immediately by its
 * layer toggle, which the single-clause planner already understands.
 * @param {string} normalized
 * @returns {string[]}
 */
export function splitVoiceClauses(normalized) {
  const matches = [...String(normalized || '').matchAll(clauseVerbPattern())];
  if (matches.length <= 1) return [normalized];
  const clauses = [];
  let index = 0;
  while (index < matches.length) {
    const start = index === 0 ? 0 : matches[index].index;
    let consumed = index;
    let next = index + 1;
    if (
      FLY_CLAUSE_VERBS.has(matches[index][1]) &&
      matches[next] &&
      LAYER_CLAUSE_VERBS.has(matches[next][1])
    ) {
      consumed = next;
      next = index + 2;
    }
    const end = matches[next] ? matches[next].index : normalized.length;
    const clause = normalized.slice(start, end).trim();
    if (clause) clauses.push(clause);
    index = consumed + 1;
  }
  return clauses.length ? clauses : [normalized];
}

/** On/off for one named layer from the verb closest before it. */
function layerSwitchOn(normalized, layerId) {
  let at = -1;
  for (const [alias, id] of LAYER_ALIASES) {
    if (id !== layerId) continue;
    const found = normalized.search(new RegExp(`\\b${alias}\\b`));
    if (found >= 0 && (at < 0 || found < at)) at = found;
  }
  if (at < 0) return !wantsLayerOff(normalized);
  const verbs = [
    ...normalized
      .slice(0, at)
      .matchAll(
        /\b(turn off|switch off|shut off|turn on|switch on|hide|disable|enable|show me)\b/g,
      ),
  ];
  if (!verbs.length) return !wantsLayerOff(normalized);
  return !/\b(?:off|hide|disable)\b/.test(verbs[verbs.length - 1][1]);
}

/**
 * A flood of "turn this layer off" calls is one Clear All. Running them one
 * by one, satellites included, stalls the page and the next spoken command.
 * @param {Array<{name:string, arguments?:object}>} calls
 */
export function collapseManyLayerOffs(calls) {
  if (!Array.isArray(calls)) return [];
  const offs = calls.filter(
    (call) =>
      call?.name === 'set_layer_visibility' &&
      call.arguments?.enabled === false,
  );
  if (offs.length < 8) return calls;
  let inserted = false;
  const next = [];
  for (const call of calls) {
    const isOff =
      call?.name === 'set_layer_visibility' &&
      call.arguments?.enabled === false;
    if (!isOff) {
      next.push(call);
      continue;
    }
    if (!inserted) {
      next.push({ name: 'clear_layers', arguments: {} });
      inserted = true;
    }
  }
  return next;
}

/**
 * @param {string} text
 * @param {{ lastLocationQuery?: string, lastPlace?: object, viewport?: { lat?: number, lon?: number } }} [context]
 * @returns {{ calls: Array<{ name: string, arguments: object }>, speech: string, locationQuery: string|null, place: object|null }}
 */
export function planSelfHostedVoiceTurn(text, context = {}) {
  const normalized = normalizeVoiceUtterance(text);
  const clauses = splitVoiceClauses(normalized);
  if (clauses.length > 1) {
    const calls = [];
    const speeches = [];
    let locationQuery = context.lastLocationQuery || null;
    let place = context.lastPlace || null;
    let cursor = context || {};
    for (const clause of clauses) {
      const plan = planSelfHostedVoiceTurn(clause, cursor);
      if (!plan.calls?.length) continue;
      calls.push(...plan.calls);
      if (plan.speech && !/I heard/.test(plan.speech)) speeches.push(plan.speech);
      if (plan.locationQuery) locationQuery = plan.locationQuery;
      if (plan.place) place = plan.place;
      cursor = {
        ...cursor,
        lastLocationQuery: locationQuery,
        lastPlace: place,
      };
    }
    if (calls.length) {
      return {
        calls: collapseManyLayerOffs(calls),
        locationQuery,
        place,
        speech: speeches.join(' '),
      };
    }
  }
  const calls = [];
  const spokenPlace = matchPlace(normalized);
  const place = spokenPlace || context.lastPlace || null;
  const locationQuery =
    locationQueryOf(spokenPlace) ||
    locationQueryOf(place) ||
    context.lastLocationQuery ||
    null;
  const viewport = context.viewport || {};
  if (wantsAllLayersOff(normalized)) {
    const enabled = Array.isArray(viewport.enabledLayers)
      ? viewport.enabledLayers.filter((id) => VOICE_LAYER_IDS.includes(id))
      : null;
    if (enabled && !enabled.length) {
      return {
        calls: [],
        locationQuery,
        place,
        speech: 'All layers are already off.',
        allLayersOff: true,
      };
    }
    // One Clear All. A call per layer (satellites first) froze the page
    // before the rest of a multi-command sentence could run.
    return {
      calls: [{ name: 'clear_layers', arguments: {} }],
      locationQuery,
      place,
      speech: 'Turning off all layers.',
      allLayersOff: true,
    };
  }
  // "turn off earthquakes and aurora" names two layers; the first one still
  // decides the fly-to framing. An "except …" turn goes to the model.
  const layerIds = /\b(except|but not|apart from)\b/.test(normalized)
    ? []
    : matchLayers(normalized);
  const layerId = layerIds[0] || null;

  if (spokenPlace) {
    calls.push({
      name: 'fly_to_location',
      arguments: flyArguments(spokenPlace, layerId),
    });
  }

  for (const id of layerIds) {
    // Polarity follows the verb in front of this layer, so "turn off
    // satellites and turn on flights" does not turn both off.
    const enabled = layerSwitchOn(normalized, id);
    calls.push({
      name: 'set_layer_visibility',
      arguments: {
        layerId: id,
        enabled,
        ...(spokenPlace ? { focus: false } : {}),
      },
    });
    if (id === 'cctv' && enabled) {
      calls.push({
        name: 'control_cctv',
        arguments: { action: 'nearest' },
      });
    }
  }

  if (
    wantsNearestAircraft(normalized) ||
    (wantsCockpitEnter(normalized) && spokenPlace)
  ) {
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
    return `I heard “${String(originalText || '').trim() || 'that'}” — give me a place, zip code, a data layer like earthquakes or aurora, a nearest flight, or a cockpit command.`;
  }
  const parts = [];
  for (const call of calls) {
    if (call.name === 'fly_to_location') {
      parts.push(
        `On my way to ${call.arguments.query || call.arguments.locationId}.`,
      );
    } else if (call.name === 'clear_layers') {
      parts.push('Turning off all layers.');
    } else if (call.name === 'set_layer_visibility') {
      const label =
        VOICE_LAYER_LABELS[call.arguments.layerId] || call.arguments.layerId;
      parts.push(
        call.arguments.enabled === false
          ? `I'll turn off ${label}.`
          : `I'll turn on ${label}.`,
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
          'Turn a data layer on or off. Use traffic, ais-live-vessels, telegeography-submarine-cables, cctv, aurora, earthquakes, or any listed layer id when asked.',
        parameters: {
          type: 'object',
          properties: {
            layerId: {
              type: 'string',
              enum: [...VOICE_LAYER_IDS],
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
