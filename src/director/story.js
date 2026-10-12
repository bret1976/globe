/**
 * Per-shot storytelling fields: caption, narration, a geolocated media pin and
 * a dated before/after imagery swipe. Pure validation and helpers only — no
 * renderer, DOM or network. Uploaded images are stored inline as small data
 * URLs; uploaded videos are stored by reference (`upload:<id>`) and travel in
 * a story file (see src/scenes/storyMedia.js).
 */
import { fail, fields, number, optional, string } from './documentFields.js';

export const STORY_LIMITS = Object.freeze({
  title: 200,
  caption: 2000,
  narration: 4000,
  label: 200,
  src: 65536,
});

export const STORY_IMAGERY_SOURCES = Object.freeze(['wayback', 'esri']);
const MEDIA_KINDS = ['image', 'video'];
const CAPTION_POSITIONS = ['bottom', 'top'];
const SRC_PATTERN =
  /^(https:\/\/[^\s"'<>]+|data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+|upload:[a-z0-9-]{4,64})$/;

function text(value, path, max) {
  if (typeof value !== 'string' || value.length > max)
    fail(path, `expected text, at most ${max} characters`);
}

function imagery(value, path) {
  fields(value, path, ['source', 'release', 'label']);
  if (!STORY_IMAGERY_SOURCES.includes(value.source))
    fail(`${path}.source`, 'expected wayback or esri');
  if (value.source === 'wayback')
    number(value.release, `${path}.release`, 1, 1e9);
  else optional(value, 'release', path, (v, p) => number(v, p, 1, 1e9));
  optional(value, 'label', path, (v, p) => text(v, p, STORY_LIMITS.label));
}

/** Validate an authored `shot.story` object without mutating it. */
export function validateShotStory(story, path) {
  fields(story, path, ['caption', 'narration', 'media', 'compare']);
  optional(story, 'caption', path, (caption, at) => {
    fields(caption, at, ['title', 'text', 'position']);
    optional(caption, 'title', at, (v, p) => text(v, p, STORY_LIMITS.title));
    optional(caption, 'text', at, (v, p) => text(v, p, STORY_LIMITS.caption));
    optional(caption, 'position', at, (v, p) => {
      if (!CAPTION_POSITIONS.includes(v)) fail(p, 'expected bottom or top');
    });
  });
  optional(story, 'narration', path, (narration, at) => {
    fields(narration, at, ['text', 'rate', 'voice']);
    string(narration.text, `${at}.text`, STORY_LIMITS.narration);
    optional(narration, 'rate', at, (v, p) => number(v, p, 0.5, 2));
    optional(narration, 'voice', at, (v, p) => string(v, p, 200));
  });
  optional(story, 'media', path, (media, at) => {
    fields(media, at, ['kind', 'src', 'lat', 'lon', 'label', 'fileName']);
    if (!MEDIA_KINDS.includes(media.kind))
      fail(`${at}.kind`, 'expected image or video');
    if (
      typeof media.src !== 'string' ||
      media.src.length > STORY_LIMITS.src ||
      !SRC_PATTERN.test(media.src)
    )
      fail(`${at}.src`, 'expected an https URL, inline image or upload');
    number(media.lat, `${at}.lat`, -90, 90);
    number(media.lon, `${at}.lon`, -180, 180);
    optional(media, 'label', at, (v, p) => text(v, p, STORY_LIMITS.label));
    optional(media, 'fileName', at, (v, p) => text(v, p, STORY_LIMITS.label));
  });
  optional(story, 'compare', path, (compare, at) => {
    fields(compare, at, ['before', 'after', 'split', 'sweep']);
    imagery(compare.before, `${at}.before`);
    imagery(compare.after, `${at}.after`);
    optional(compare, 'split', at, (v, p) => number(v, p, 0, 1));
    optional(compare, 'sweep', at, (v, p) => {
      if (typeof v !== 'boolean') fail(p, 'expected a boolean');
    });
  });
}

/** True when a story carries at least one feature worth presenting. */
export function storyHasContent(story) {
  if (!story) return false;
  return !!(
    story.caption?.title?.trim() ||
    story.caption?.text?.trim() ||
    story.narration?.text?.trim() ||
    story.media ||
    story.compare
  );
}

/** Rough spoken length so the timeline and progress bar include narration. */
export function estimateNarrationSec(story) {
  const words = story?.narration?.text
    ?.trim()
    .split(/\s+/)
    .filter(Boolean).length;
  if (!words) return 0;
  const rate = Number(story.narration.rate) || 1;
  return Math.ceil((words / 2.5 / rate + 0.6) * 10) / 10;
}

const WAYBACK_TILE =
  'https://wayback.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/WMTS/1.0.0/default028mm/MapServer/tile/{release}/{z}/{y}/{x}';
const ESRI_TILE =
  'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
export const WAYBACK_CONFIG_URL =
  'https://s3-us-west-2.amazonaws.com/config.maptiles.arcgis.com/waybackconfig.json';

/** XYZ tile template for one side of a comparison. */
export function imageryTileTemplate(side) {
  if (side?.source === 'wayback')
    return WAYBACK_TILE.replace('{release}', String(Math.trunc(side.release)));
  return ESRI_TILE;
}

/** Human label for one side of a comparison. */
export function imageryLabel(side) {
  if (side?.label) return side.label;
  return side?.source === 'wayback'
    ? `Esri Wayback ${side.release}`
    : 'Esri World Imagery (current)';
}

/** Parse the public Wayback config into releases sorted newest first. */
export function parseWaybackReleases(config) {
  const out = [];
  for (const [key, entry] of Object.entries(config || {})) {
    const release = Number(key);
    const date = /(\d{4}-\d{2}-\d{2})/.exec(entry?.itemTitle || '')?.[1];
    if (Number.isFinite(release) && date) out.push({ release, date });
  }
  return out.sort((a, b) => b.date.localeCompare(a.date));
}

/** The release whose date is nearest to an ISO day. */
export function nearestWaybackRelease(releases, isoDay) {
  const target = Date.parse(isoDay);
  if (!releases?.length || !Number.isFinite(target)) return null;
  return releases.reduce((best, r) =>
    Math.abs(Date.parse(r.date) - target) <
    Math.abs(Date.parse(best.date) - target)
      ? r
      : best,
  );
}
