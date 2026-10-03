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
  };
}
