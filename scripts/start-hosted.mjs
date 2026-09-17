#!/usr/bin/env node
/**
 * Hosted entrypoint (Railway and similar).
 *
 * Live feeds still run through Vite middleware. When `dist/` exists (Docker
 * production build), this starts `vite preview` so a phone downloads one
 * bundle instead of hundreds of unbundled modules.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostedViteArgs } from './hostedMode.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const viteBin = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');
const port = String(process.env.PORT || '43123');
const host = process.env.HOST || '0.0.0.0';
const distExists = fs.existsSync(path.join(root, 'dist', 'index.html'));
const args = hostedViteArgs({
  distExists,
  railway: Boolean(process.env.RAILWAY_ENVIRONMENT),
  forcePreview: process.env.GEV_USE_PREVIEW === '1',
  host,
  port,
});

const child = spawn(
  process.execPath,
  [viteBin, ...args],
  {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, HOST: host, PORT: port },
  },
);

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
