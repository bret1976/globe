# Third-party software notices

The project depends on third-party npm packages whose own licenses apply. This
file records the packages added for the browser-local SDR feature; the complete
resolved dependency inventory remains in `package-lock.json`.

## Web RTL-SDR

- Package: `@jtarrio/webrtlsdr` 3.0.6
- Author: Jacobo Tarrio Barreiro; portions copyright Google Inc.
- Source: <https://github.com/jtarrio/webrtlsdr>
- License: Apache License 2.0
- License text: <https://www.apache.org/licenses/LICENSE-2.0>

## Signals

- Package: `@jtarrio/signals` 0.10.1
- Author: Jacobo Tarrio Barreiro
- Source: <https://github.com/jtarrio/signals>
- License: Apache License 2.0
- License text: <https://www.apache.org/licenses/LICENSE-2.0>

## Geo file import (GeoJSON / KML / KMZ / GPX)

`src/data/geoFileImport.js`, `src/data/geoImportImages.js`, `src/data/geoImportPins.js`,
`src/data/cameraFraming.js`, `src/ui/geoFileImport.js`, `src/ui/flyToDataSource.js` and their
tests are ported from bilawalsidhu/gods-eye-view PR #1122 (merge 533d7c6), MIT License,
Copyright (c) Bilawal Sidhu.

## Street Photos (Panoramax)

`src/layers/streetPhotos/panoramax/policy.js`, `src/layers/streetPhotos/panoramax/source.js`,
`src/layers/streetPhotos/limiter.js`, `src/testSupport/panoramaxFixtures.mjs` and the
`policy.test.mjs` / `source.test.mjs` tests are ported from bilawalsidhu/gods-eye-view
PR #1134 ("Street Level: Panoramax as a fourth, keyless imagery provider", by asturksever),
MIT License, Copyright (c) Bilawal Sidhu. The layer, viewer and coverage dots are a GodsEye
adaptation. Imagery © Panoramax contributors; each picture carries its own licence, named in
the photo caption.

## Hardening ports (2026-10-19)

`src/terrainHeightsBounds.test.mjs` and the terrain-heights cache bounds in
`server/providers/terrain.js` / `src/data/terrainHeightsProxy.js` are ported from
bilawalsidhu/gods-eye-view PR #686 (daikaginza); `src/layers/launches/ingestion.test.mjs`
and the Space Missions stale-provenance changes from PR #1199 (rudycelekli); the Launch
Library request window and User-Agent from PR #1197 (rudycelekli). MIT License,
Copyright (c) Bilawal Sidhu.

## CCTV + flights ports (2026-10-20)

`src/layers/cctv/rendering.test.mjs` and the live-video icon color in `src/layers/cctv/policy.js` /
`rendering.js` are ported from bilawalsidhu/gods-eye-view PR #1200 (Danielslay86);
`src/layers/cctv/frames.test.mjs` and the still-aspect fit in `frames.js` from PR #1201
(Danielslay86); the Kartverket ground heights for Statens vegvesen cameras in
`server/providers/cctv/sources.js` / `constants.js` and `src/data/cctvVegvesen.test.mjs` from
PR #945 (trygvehhh); `src/data/routeSegment.test.mjs` and the along-track leg bound in
`src/data/routePlausible.js` from PR #1284 (rudycelekli); the position-less OpenSky row
handling in `src/sources/live/contract.js` / `aircraft.js` and `src/layers/flights/records.js` /
`snapshotRenderer.js` (with their tests) from PR #1110 (Rohilalala). MIT License, Copyright (c) Bilawal
Sidhu. Ground heights © Kartverket, CC BY 4.0 (modified: heights over water set to 0 m, rounded
to 0.1 m).
