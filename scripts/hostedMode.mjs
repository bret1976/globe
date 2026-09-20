/**
 * Decide whether the hosted process should serve a production preview
 * (one JS bundle) or the Vite module graph (hundreds of requests).
 *
 * Phone Safari sat on "Initializing photorealistic world" while it downloaded
 * every source file from `vite --mode development`. Preview is the fix.
 */

/** Write runtime Railway secrets into the preview HTML. Vite bakes
 * CESIUM_ION_TOKEN at compile time; Docker builds often never see it. */
export function injectHostedClientKeys(html, env = process.env) {
  const ion = String(env.CESIUM_ION_TOKEN || '').trim();
  const google = String(env.GOOGLE_MAPS_API_KEY || '').trim();
  const snippet = `<script>window.__GEV_CESIUM_ION_TOKEN=${JSON.stringify(ion)};window.__GEV_GOOGLE_MAPS_API_KEY=${JSON.stringify(google)};</script>`;
  if (/<script>window\.__GEV_CESIUM_ION_TOKEN=/.test(html)) {
    return html.replace(
      /<script>window\.__GEV_CESIUM_ION_TOKEN=[\s\S]*?<\/script>/,
      snippet,
    );
  }
  if (html.includes('</head>'))
    return html.replace('</head>', `${snippet}</head>`);
  return `${snippet}${html}`;
}

export function hostedViteArgs({
  distExists = false,
  railway = false,
  forcePreview = false,
  host = '0.0.0.0',
  port = '43123',
} = {}) {
  const preview = Boolean(distExists && (railway || forcePreview));
  if (preview) {
    return ['preview', '--host', host, '--port', String(port), '--strictPort'];
  }
  return ['--host', host, '--port', String(port), '--mode', 'development'];
}
