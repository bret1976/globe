// Runs one reconstruction off the main thread so the web server stays responsive
// while ~3 GB of history is streamed and parsed.
import { parentPort, workerData } from 'node:worker_threads';
import { buildReplay } from './index.js';

buildReplay({ ...workerData, onProgress: (p) => parentPort.postMessage({ type: 'progress', p }) })
  .then((replay) => parentPort.postMessage({ type: 'done', replay }))
  .catch((err) => parentPort.postMessage({ type: 'error', error: String(err?.message || err) }));
