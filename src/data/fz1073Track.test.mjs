import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FZ1073_LAYER_ID,
  FZ1073_PEAK_VS_FPM,
  FZ1073_TRACK,
  fz1073DivePoints,
  fz1073FpvShots,
} from './fz1073Track.js';

test('FZ1073 curated track includes peak dive and divert endpoints', () => {
  assert.equal(FZ1073_LAYER_ID, 'fz1073-2026');
  assert.ok(FZ1073_TRACK.length >= 80);
  const peak = FZ1073_TRACK.reduce((best, p) =>
    !best || p.vs_fpm < best.vs_fpm ? p : best,
  );
  assert.equal(peak.vs_fpm, FZ1073_PEAK_VS_FPM);
  assert.ok(Math.abs(peak.lat - 29.797119) < 0.001);
  assert.ok(Math.abs(peak.lon - 38.294483) < 0.001);
  const first = FZ1073_TRACK[0];
  const last = FZ1073_TRACK[FZ1073_TRACK.length - 1];
  assert.ok(first.lat > 25 && first.lat < 26); // DXB
  assert.ok(last.lat > 28 && last.lat < 29); // TUU
  assert.equal(last.alt_ft, 0);
});

test('FZ1073 FPV shots stay nose-forward along the dive window', () => {
  const dive = fz1073DivePoints();
  assert.ok(dive.length >= 10);
  const shots = fz1073FpvShots();
  assert.ok(shots.length >= 5);
  assert.ok(shots.some((s) => s.vs_fpm <= -20_000));
  assert.ok(shots.every((s) => s.height > 500));
  assert.ok(shots.every((s) => s.pitch <= -8));
});
