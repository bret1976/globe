/**
 * Decide whether the hosted process should serve a production preview
 * (one JS bundle) or the Vite module graph (hundreds of requests).
 *
 * Phone Safari sat on "Initializing photorealistic world" while it downloaded
 * every source file from `vite --mode development`. Preview is the fix.
 */
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
