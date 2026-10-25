import { applicationHtmlPlugin } from './application-html.js';
import { hostedAssetsPlugin } from './hostedAssets.js';
import cesium from 'vite-plugin-cesium';
import { fileURLToPath } from 'node:url';

/** HTML entry points: the globe and the standalone /watch dashboard. */
export const HTML_ENTRIES = Object.freeze({
  index: fileURLToPath(new URL('../index.html', import.meta.url)),
  watch: fileURLToPath(new URL('../watch.html', import.meta.url)),
});

const CESIUM_TAGS = /[ \t]*<link[^>]+href="\/cesium\/Widgets\/widgets\.css"[^>]*>\s*|[ \t]*<script[^>]+src="\/cesium\/Cesium\.js"[^>]*><\/script>\s*/g;

/** The /watch dashboard has no globe: drop the Cesium tags vite-plugin-cesium injects. */
export function stripCesiumFromWatch(html, path = '') {
  return /(^|\/)watch\.html$/.test(String(path)) ? html.replace(CESIUM_TAGS, '') : html;
}

function watchPagePlugin() {
  return {
    name: 'gev-watch-page',
    transformIndexHtml: {
      order: 'post',
      handler: (html, ctx) => stripCesiumFromWatch(html, ctx?.filename || ctx?.path),
    },
  };
}

/** Build browser assets with explicit inputs; never load environment or providers. */
export function createBrowserViteConfig({
  plugins = [],
  publicDir,
  googleApiKey,
  cesiumToken,
  host = 'localhost',
  port = 4173,
  command,
} = {}) {
  return {
    plugins: [
      cesium(),
      applicationHtmlPlugin(),
      hostedAssetsPlugin(),
      watchPagePlugin(),
      ...plugins,
    ],
    ...(publicDir === undefined ? {} : { publicDir }),
    // A production build must not clean the dependency cache a running dev
    // server is still serving optimized module URLs from.
    ...(command === 'build' ? { cacheDir: 'node_modules/.vite-build' } : {}),
    optimizeDeps: {
      // Keep Transformers.js / Kokoro on their own WASM build (see below).
      exclude: ['@huggingface/transformers', 'kokoro-js'],
      // First reached through the SDR worker or a dynamic import. Pre-bundle
      // them at startup so first use cannot invalidate already-transformed
      // URLs with Vite's "Outdated Optimize Dep" 504 response.
      include: [
        '@jtarrio/signals/demod/demodulator.js',
        '@jtarrio/signals/demod/modes.js',
        '@jtarrio/webrtlsdr/rtlsdr.js',
        'egm96-universal',
      ],
    },
    server: {
      host: host || 'localhost',
      port: parseInt(port, 10) || 4173,
      allowedHosts:
        host === '0.0.0.0' || host === '::'
          ? true
          : ['localhost', '127.0.0.1', '.local'],
      fs: {
        deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/ENVIRONMENT'],
      },
      // These headers protect the document containing Provider Settings.
      headers: {
        'X-Frame-Options': 'DENY',
        'Content-Security-Policy': "frame-ancestors 'none'",
      },
    },
    define: {
      'import.meta.env.GOOGLE_MAPS_API_KEY': JSON.stringify(googleApiKey),
      'import.meta.env.CESIUM_ION_TOKEN': JSON.stringify(cesiumToken),
    },
    build: {
      chunkSizeWarningLimit: 1500,
      rollupOptions: { input: { ...HTML_ENTRIES } },
    },
    // Transformers.js / Kokoro stay excluded from optimizeDeps above. Do not
    // set COOP/COEP — that would block Cesium ion tiles on other origins.
  };
}
