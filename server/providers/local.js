import { openSkyProxy } from './aircraft/opensky.js';
import { celestrakProxy, rocketLaunchesProxy } from './space.js';
import { tomtomProxy } from './traffic.js';
import { firmsProxy } from './firms.js';
import { terrainHeightsProxy } from './terrain.js';
import { adsbdbProxy } from './aircraft/enrichment.js';
import { overpassProxy } from './overpass.js';
import { militaryInstallationsProxy } from './military-installations.js';
import { regionalBriefProxy } from './regional/briefing.js';
import { geocodeProxy } from './regional/place.js';
import { weatherEffectsProxy } from './regional/weather-effects.js';
import { cctvProxy } from './cctv.js';
import { defaultSourceRoot } from './common/source-root.js';
import { radioBrowserProxy } from './radio.js';
import { gbfsProxy } from './gbfs.js';
import { localReceiversProxy } from './local-receivers.js';
import { transitProxy } from './transit.js';
import { adsbLolProxy } from './aircraft/adsb-lol.js';
import { aisLiveProxy } from './vessels/ais-live.js';
import { trackBackfillProxies } from './aircraft/tracks.js';
import { openAiRealtimeProxy } from './openai.js';
import { selfHostedVoiceProxy } from './voice.js';
import { googlePlacesContextProxy } from './places.js';
import { keySetupEndpoint } from '../standalone/key-setup.js';
import { auFireProxy } from './auFire.js';
import { firePerimetersProxy } from './firePerimeters.js';
import { windProxy } from './wind.js';
import { replayProxy } from './replay/index.js';
import { cyclonesProxy } from './cyclones.js';
import { earthquakesProxy } from './earthquakes.js';
import { gpsjamProxy } from './gpsjam.js';
import { volcanoesProxy } from './volcanoes.js';
import { auroraProxy } from './aurora.js';
import { radiationProxy } from './radiation.js';
import { floodsProxy } from './floods.js';
import { nwsAlertsProxy } from './nwsAlerts.js';
import { ndbcBuoysProxy } from './ndbcBuoys.js';
import { usgsGaugesProxy } from './usgsGauges.js';
import { tideGaugesProxy } from './tideGauges.js';
import { usdmDroughtProxy } from './usdmDrought.js';
import { airQualityProxy } from './airQuality.js';
import { stormReportsProxy } from './stormReports.js';
import { radiosondesProxy } from './radiosondes.js';
import { flightRestrictionsProxy } from './flightRestrictions.js';
import { aviationHazardsProxy } from './aviationHazards.js';
import { fireballsProxy } from './fireballs.js';
import { spcOutlookProxy } from './spcOutlook.js';
import { airportDelaysProxy } from './airportDelays.js';
import { hurricaneConesProxy } from './hurricaneCones.js';
import { ionosphereProxy } from './ionosphere.js';
import { oceanCurrentsProxy } from './oceanCurrents.js';
import { powerPlantsProxy } from './powerPlants.js';
import { ukraineFiresProxy } from './ukraineFires.js';
import { tsunamiAlertsProxy } from './tsunamiAlerts.js';
import { hmsSmokeProxy } from './hmsSmoke.js';
import { worldSigmetsProxy } from './worldSigmets.js';
import { coralBleachingProxy, CORAL_DISK_CACHE } from './coralBleaching.js';
import { canadaAlertsProxy } from './canadaAlerts.js';
import { gnssIntegrityProxy } from './gnssIntegrity.js';

/** Construct the local provider plugins in their established order. */
function localProviderPlugins() {
  return [
    openSkyProxy(),
    celestrakProxy(),
    tomtomProxy(),
    firmsProxy(),
    rocketLaunchesProxy(),
    terrainHeightsProxy(),
    adsbdbProxy(),
    overpassProxy(),
    militaryInstallationsProxy(),
    regionalBriefProxy(),
    geocodeProxy(),
    weatherEffectsProxy(),
    cctvProxy({ sourceRoot: defaultSourceRoot }),
    radioBrowserProxy(),
    gbfsProxy(),
    localReceiversProxy(),
    transitProxy(),
    adsbLolProxy(),
    aisLiveProxy(),
    trackBackfillProxies(),
    openAiRealtimeProxy(),
    selfHostedVoiceProxy(),
    googlePlacesContextProxy(),
    auFireProxy(),
    windProxy(),
    replayProxy(),
    cyclonesProxy(),
    firePerimetersProxy(),
    earthquakesProxy(),
    gpsjamProxy(),
    volcanoesProxy(),
    auroraProxy(),
    radiationProxy(),
    floodsProxy(),
    nwsAlertsProxy(),
    ndbcBuoysProxy(),
    usgsGaugesProxy(),
    tideGaugesProxy(),
    usdmDroughtProxy(),
    airQualityProxy(),
    stormReportsProxy(),
    radiosondesProxy(),
    flightRestrictionsProxy(),
    aviationHazardsProxy(),
    worldSigmetsProxy(),
    coralBleachingProxy({ diskCache: CORAL_DISK_CACHE }),
    canadaAlertsProxy(),
    gnssIntegrityProxy(),
    fireballsProxy(),
    spcOutlookProxy(),
    airportDelaysProxy(),
    hurricaneConesProxy(),
    ionosphereProxy(),
    oceanCurrentsProxy(),
    powerPlantsProxy(),
    ukraineFiresProxy(),
    tsunamiAlertsProxy(),
    hmsSmokeProxy(),
    keySetupEndpoint(),
  ];
}

export { localProviderPlugins };

export {
  CCTV_FRAME_FETCH_TIMEOUT_MS,
  fetchCctvImageFromUpstream,
} from './cctv.js';
export {
  createRadioProxyMiddleware,
  isPublicRadioAddress,
  normalizeRadioBrowserStation,
  publicRadioStation,
  publicRadioHttpsUrl,
} from './radio.js';
export { LL2_CACHE_TTL_MS, launchLibraryRequestHeaders } from './space.js';
export { googlePlacesContextProxy } from './places.js';
export { googleServerApiKey } from './places.js';
export { keylessGooglePlacesResponse } from './places.js';
export { adsbLolFallbackAnchor } from './aircraft/opensky.js';
export { readResponseTextCapped } from './common/http.js';
export { readResponseJsonCapped } from './common/http.js';
export { coalesceProxyRequest } from './common/http.js';
export { requiredFiniteQueryNumber } from './common/query.js';
export { isOverpassBoundaryQuery } from './overpass/query.js';
export { simplifyOverpassPayloadBody } from './overpass/geometry.js';
export { readOverpassDisk } from './overpass/cache.js';
export { resolveOverpassPreflight } from './overpass/cache.js';
export { overpassPayloadIsData } from './overpass/transport.js';
export { fetchOverpassPayload } from './overpass/transport.js';
export { openAiRealtimeProxy } from './openai.js';
export { selfHostedVoiceProxy } from './voice.js';
export { MILITARY_INSTALLATION_ELEMENT_CAP } from './military-installations/constants.js';
export { quantizeMilitaryInstallationBox } from './military-installations/query.js';
export { militaryInstallationCacheKey } from './military-installations/query.js';
export { resolveMilitaryInstallationTier } from './military-installations/cache.js';
export { migrateMilitaryInstallationEntry } from './military-installations/cache.js';
export { militaryInstallationDiskFresh } from './military-installations/cache.js';
export { militaryInstallationDiskPath } from './military-installations/cache.js';
export { readMilitaryInstallationDisk } from './military-installations/cache.js';
export { writeMilitaryInstallationDisk } from './military-installations/cache.js';
export { validMilitaryInstallationBox } from './military-installations/query.js';
export { militaryInstallationFailureReason } from './military-installations/query.js';
export { validRegionalPoint } from './regional/query.js';
export { regionalBriefHasAnySource } from './regional/briefing.js';
