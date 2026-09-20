#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MDCHART_CAMERAS_URL,
  MDCHART_STREAM_HOST_PATTERN,
} from '../server/providers/cctv/constants.js';
import { mdchartRowToSource } from '../server/providers/cctv/mdchart.js';

const dest = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../server/providers/cctv/mdchart.snapshot.json',
);

const response = await fetch(MDCHART_CAMERAS_URL, {
  headers: {
    Accept: 'application/json',
    'User-Agent':
      'GodsEyeView/1.0 (cctv catalog; +https://github.com/bret1976/globe)',
  },
});
if (!response.ok) throw new Error(`CHART HTTP ${response.status}`);
const payload = await response.json();
const rows = Array.isArray(payload) ? payload : payload.cameras || [];
const keep = [];
for (const row of rows) {
  if (!mdchartRowToSource(row)) continue;
  const host = String(row.cctvIp || '')
    .trim()
    .toLowerCase();
  if (!MDCHART_STREAM_HOST_PATTERN.test(host)) continue;
  keep.push({
    id: String(row.id || '').trim(),
    lat: Number(row.lat),
    lon: Number(row.lon),
    cctvIp: host,
    description: String(row.description || '').trim(),
    name: String(row.name || '').trim(),
    routePrefix: String(row.routePrefix || '').trim(),
    routeNumber: row.routeNumber,
    routeSuffix: String(row.routeSuffix || '').trim(),
    cameraCategories: Array.isArray(row.cameraCategories)
      ? row.cameraCategories
          .map((item) => String(item || '').trim())
          .filter(Boolean)
          .slice(0, 3)
      : [],
    opStatus: String(row.opStatus || 'OK')
      .trim()
      .toUpperCase(),
    commMode: String(row.commMode || 'ONLINE')
      .trim()
      .toUpperCase(),
  });
}
writeFileSync(dest, JSON.stringify(keep));
console.log(`Wrote ${keep.length} CHART cameras to ${dest}`);
