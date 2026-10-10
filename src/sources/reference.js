import { createUsgsEarthquakeSource } from '../layers/earthquakes/source.js';
import { createWfigsPerimeterSource } from '../layers/perimeters/source.js';
import { createAuFireSource } from '../layers/auFire/source.js';
import { createBundledCableSource } from '../layers/submarineCables/bundledSource.js';
import { createGpsjamSource } from '../layers/gpsInterference/source.js';
import { createUsgsVolcanoSource } from '../layers/volcanoes/source.js';
import { createOvationAuroraSource } from '../layers/aurora/source.js';
import { createSafecastRadiationSource } from '../layers/radiation/source.js';
import { createGdacsFloodsSource } from '../layers/floods/source.js';
import { createNwsAlertsSource } from '../layers/nwsAlerts/source.js';
import { createNdbcBuoysSource } from '../layers/ndbcBuoys/source.js';
import { createUsgsGaugesSource } from '../layers/usgsGauges/source.js';
import { createTideGaugesSource } from '../layers/tideGauges/source.js';
import { createUsdmDroughtSource } from '../layers/usdmDrought/source.js';
import { createAirQualitySource } from '../layers/airQuality/source.js';
import { createStormReportsSource } from '../layers/stormReports/source.js';
import { createRadiosondesSource } from '../layers/radiosondes/source.js';
import { createFlightRestrictionsSource } from '../layers/flightRestrictions/source.js';
import { createAviationHazardsSource } from '../layers/aviationHazards/source.js';
import { createFireballsSource } from '../layers/fireballs/source.js';
import { createSpcOutlookSource } from '../layers/spcOutlook/source.js';
import { createAirportDelaysSource } from '../layers/airportDelays/source.js';
import { createIonosphereSource } from '../layers/ionosphere/source.js';
import { createUkraineFiresSource } from '../layers/ukraineFires/source.js';
import { createOceanCurrentsSource } from '../layers/oceanCurrents/source.js';
import { createPowerPlantsSource } from '../layers/powerPlants/source.js';

/** Construct the existing reference feeds independently of application setup. */
export function createReferenceSources() {
  return {
    earthquakes: createUsgsEarthquakeSource(),
    'fire-perimeters': createWfigsPerimeterSource(),
    auFire: createAuFireSource(),
    cables: createBundledCableSource(),
    gpsjam: createGpsjamSource(),
    volcanoes: createUsgsVolcanoSource(),
    aurora: createOvationAuroraSource(),
    radiation: createSafecastRadiationSource(),
    floods: createGdacsFloodsSource(),
    nwsAlerts: createNwsAlertsSource(),
    ndbcBuoys: createNdbcBuoysSource(),
    usgsGauges: createUsgsGaugesSource(),
    tideGauges: createTideGaugesSource(),
    usdmDrought: createUsdmDroughtSource(),
    airQuality: createAirQualitySource(),
    stormReports: createStormReportsSource(),
    oceanCurrents: createOceanCurrentsSource(),
    powerPlants: createPowerPlantsSource(),
    radiosondes: createRadiosondesSource(),
    flightRestrictions: createFlightRestrictionsSource(),
    aviationHazards: createAviationHazardsSource(),
    fireballs: createFireballsSource(),
    spcOutlook: createSpcOutlookSource(),
    airportDelays: createAirportDelaysSource(),
    ionosphere: createIonosphereSource(),
    ukraineFires: createUkraineFiresSource(),
  };
}
