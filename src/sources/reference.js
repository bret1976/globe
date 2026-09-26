import { createUsgsEarthquakeSource } from '../layers/earthquakes/source.js';
import { createWfigsPerimeterSource } from '../layers/perimeters/source.js';
import { createAuFireSource } from '../layers/auFire/source.js';
import { createBundledCableSource } from '../layers/submarineCables/bundledSource.js';
import { createGpsjamSource } from '../layers/gpsInterference/source.js';

/** Construct the existing reference feeds independently of application setup. */
export function createReferenceSources() {
  return {
    earthquakes: createUsgsEarthquakeSource(),
    'fire-perimeters': createWfigsPerimeterSource(),
    auFire: createAuFireSource(),
    cables: createBundledCableSource(),
    gpsjam: createGpsjamSource(),
  };
}
