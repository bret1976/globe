import test from 'node:test';
import assert from 'node:assert/strict';
import { isConstrainedGlobeClient } from './clientCapabilities.js';

test('narrow viewport alone is constrained', () => {
  assert.equal(
    isConstrainedGlobeClient({
      matchMedia: (query) => ({
        matches: query.includes('max-width: 720px'),
      }),
      devicePixelRatio: 1,
      maxTouchPoints: 0,
      userAgent: 'Mozilla/5.0',
    }),
    true,
  );
});

test('desktop mouse stays unconstrained', () => {
  assert.equal(
    isConstrainedGlobeClient({
      matchMedia: () => ({ matches: false }),
      devicePixelRatio: 2,
      maxTouchPoints: 0,
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)',
    }),
    false,
  );
});

test('iPhone UA is constrained even when wide', () => {
  assert.equal(
    isConstrainedGlobeClient({
      matchMedia: () => ({ matches: false }),
      devicePixelRatio: 3,
      maxTouchPoints: 5,
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
    }),
    true,
  );
});

test('coarse touch retina Android is constrained', () => {
  assert.equal(
    isConstrainedGlobeClient({
      matchMedia: (query) => ({
        matches: query.includes('pointer: coarse'),
      }),
      devicePixelRatio: 2.75,
      maxTouchPoints: 5,
      userAgent: 'Mozilla/5.0 (Linux; Android 14)',
    }),
    true,
  );
});
