/** Fixed upstream request URLs; callers own validation, credentials and transport. */
export function celestrakTleUrl(group) {
  const url = new URL('https://celestrak.org/NORAD/elements/gp.php');
  url.searchParams.set('GROUP', group);
  url.searchParams.set('FORMAT', 'tle');
  return url;
}

export function launchLibraryRecentUrl(end) {
  // Stable minute boundaries let different installations share LL2's cache.
  const roundedEnd = new Date(Math.floor(end.getTime() / 60000) * 60000);
  const start = new Date(roundedEnd.getTime() - 30 * 86400000);
  const url = new URL('https://ll.thespacedevs.com/2.3.0/launches/');
  url.searchParams.set('net__gte', start.toISOString());
  url.searchParams.set('net__lte', roundedEnd.toISOString());
  url.searchParams.set('limit', '100');
  url.searchParams.set('mode', 'detailed');
  return url;
}

/** Fallback TLE source (tle.ivanstanojevic.me, CelesTrak-derived) for one NORAD id. */
export function fallbackTleUrl(noradId) {
  const id = String(noradId).replace(/\D/g, '');
  return new URL(`https://tle.ivanstanojevic.me/api/tle/${id}`);
}

/** CelesTrak group mirror (satvisorcom/satvisor-data on GitHub, refreshed by cron). */
export function mirrorTleUrl(group) {
  const slug = String(group)
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '');
  return new URL(
    `https://raw.githubusercontent.com/satvisorcom/satvisor-data/master/celestrak/tle/${slug}.tle`,
  );
}
