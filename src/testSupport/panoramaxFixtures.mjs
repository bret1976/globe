// Panoramax STAC item stand-ins for tests. Ported from bilawalsidhu/gods-eye-view (MIT).
/**
 * A STAC item as the meta-catalogue returns it.
 * @param {{id: string, lon: number, lat: number, sequenceId?: string, heading?: number, pano?: boolean, datetime?: string, producer?: string, license?: string, width?: number, prevId?: string|null, nextId?: string|null, host?: string}} options
 */
export function stacItem({
  id,
  lon,
  lat,
  sequenceId = 'seq-1',
  heading = 90,
  pano = false,
  datetime = '2025-06-01T10:00:00+00:00',
  producer = 'tester',
  license = 'CC-BY-SA-4.0',
  width = pano ? 5760 : 4032,
  prevId = null,
  nextId = null,
  host = 'https://panoramax.example.org',
}) {
  const api = 'https://api.panoramax.xyz/api';
  const links = [
    { rel: 'self', href: `${api}/collections/${sequenceId}/items/${id}` },
  ];
  if (prevId)
    links.push({
      rel: 'prev',
      href: `${api}/collections/${sequenceId}/items/${prevId}`,
    });
  if (nextId)
    links.push({
      rel: 'next',
      href: `${api}/collections/${sequenceId}/items/${nextId}`,
    });
  return {
    type: 'Feature',
    id,
    collection: sequenceId,
    geometry: { type: 'Point', coordinates: [lon, lat] },
    providers: [{ name: producer, roles: ['producer'] }],
    properties: {
      datetime,
      license,
      'view:azimuth': heading,
      'geovisio:producer': producer,
      'pers:interior_orientation': {
        ...(pano ? { field_of_view: 360 } : {}),
        sensor_array_dimensions: [width, pano ? width / 2 : 3024],
      },
    },
    assets: {
      hd: { href: `${host}/pictures/${id}/hd.jpg` },
      sd: { href: `${host}/pictures/${id}/sd.jpg` },
      thumb: { href: `${host}/pictures/${id}/thumb.jpg` },
    },
    links,
  };
}
