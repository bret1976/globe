import { createStandaloneApplication } from './standalone/application.js';
import { describeError } from './standalone/errors.js';
import { initShortsPack, SHORTS_PACK_VERSION } from './data/shortsPack.js';

const application = createStandaloneApplication({
  googleApiKey: import.meta.env.GOOGLE_MAPS_API_KEY,
  cesiumToken: import.meta.env.CESIUM_ION_TOKEN,
  allowQaRegistration: import.meta.env.DEV,
});

application
  .start()
  .then((components) => {
    const viewer = components?.scene?.viewer;
    const dataManager = components?.data?.dataManager;
    const { pack, promise } = initShortsPack({ viewer, dataManager });
    if (pack) {
      console.info(`[shorts-pack ${SHORTS_PACK_VERSION}] launching`, pack);
      return promise.catch((error) => {
        console.warn('[shorts-pack] failed', error);
      });
    }
    console.info(`[shorts-pack ${SHORTS_PACK_VERSION}] ready (add #shorts=bay|nervous|cockpit|area51|nepal|traffic)`);
  })
  .catch((error) => {
    console.error("God's Eye View initialization failed:", error);
    const loaderStatus = document.querySelector('#loading-screen .loader-status');
    if (loaderStatus) {
      loaderStatus.textContent = `Error: ${describeError(error)}`;
      loaderStatus.style.color = '#ff4444';
    }
  });

export { application };
