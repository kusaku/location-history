# Location History

A responsive, static location-history explorer at **https://kusaku.su/location-history/**.

## Run and verify

No build, package installation, or backend is required. Six maps work without credentials; additional providers use public browser keys in `map-config.mjs`. Use a current browser with WebGL2, module workers, and Compression Streams for gzip files.

```sh
python3 -m http.server 8080
node --test
```

Open http://localhost:8080/. To verify a project subpath from the parent directory:

```sh
python3 -m http.server 8080 --directory ..
```

Open http://localhost:8080/location-history/. Every app URL is relative; the canonical URL is the only hardcoded production path.

## Interface

- **Heatmap:** GPU-rendered density with a screen-space spread, intensity, opacity, and three colour palettes.
- **Hexagons:** zoom-adaptive cells with record, recorded-day, and stationary-minute details on click.
- **Points:** individual observations with timestamps and accuracy; at most 20,000 representative points in view. Counts and exports remain exact.
- **Journeys:** consecutive recorded locations. Breaks occur at filtered observations, gaps over six hours, dateline crossings, or speeds above 1,000 km/h. Sparse paths are not road routing. Distance is an estimate along usable recorded tracks, not total travel distance.
- **Density metrics:** number of records, distinct UTC days per cell, or estimated stationary time. Explicit visit durations and stationary intervals of at most 30 minutes within 200 metres contribute time; each observation is clipped to its UTC day, the end of the selection, and the chosen end hour. Sampling gaps and movement do not become stays. This estimate can undercount visits spanning days and is affected by overlapping visit/path records.
- **Relative density:** occupied cells are scaled to their 95th-percentile value, then square-root transformed to keep less frequent places visible. Density is recalculated for the padded visible area and current zoom. Colours compare spatial patterns in the current view, not absolute values across zoom levels or filters.
- **Timeline:** date fields, keyboard-accessible start/end ranges, day, 30-day and one-year presets relative to the newest observation, and previous/next buttons that shift the selected window by its duration. Navigation stops at the history boundaries without shrinking the window. Custom ranges work too. Cumulative playback and a histogram cover the imported history after hour/accuracy filtering.
- **Import:** multiple files, drag and drop, explicit sample loading, and transactional replacement. A failed import keeps the existing dataset. Select all files together to merge them. Clear or reload removes imported history from memory.
- **Export:** the exact filtered observations as timestamped GeoJSON points; no display sampling or viewport clipping is applied.

Dates and hours use **UTC**, including distinct-day counts. Accuracy filters keep observations without accuracy metadata. Empty selections are valid.

## Supported inputs

- Google Takeout `Records.json` / legacy `locations`, with ISO `timestamp` or numeric/string `timestampMs`.
- Monthly `timelineObjects` with `placeVisit` and `activitySegment` records.
- On-device Timeline `semanticSegments` or an array of segments, with visits, timestamped paths, offset-timed paths, and activity endpoints.
- The original `delta-compressed` sample format.
- GeoJSON FeatureCollections of Point features with `properties.timestamp` or `properties.time` (ISO or milliseconds), and optional `properties.accuracy` in metres.
- Any of the above compressed with gzip; compression is detected by its magic bytes.

Coordinates and timestamps are validated. Exact duplicates use timestamp **and** coordinates; different locations sharing a timestamp survive. Unknown JSON schemas and files with no valid observations produce an explicit error. Untimed semantic waypoints cannot become dated observations. Inputs are limited to two million combined observations and 512 MB per file after decompression to bound browser memory use. Google changes its export formats; unsupported structures are reported rather than silently treated as locations.

## Maps and providers

The built-in choices require no credentials:

| Map | Provider | Endpoint / documentation |
| --- | --- | --- |
| Midnight | OpenFreeMap Dark | https://tiles.openfreemap.org/styles/dark |
| Paper | OpenFreeMap Positron | https://tiles.openfreemap.org/styles/positron |
| Streets | OpenFreeMap Liberty | https://tiles.openfreemap.org/styles/liberty |
| Bright | OpenFreeMap Bright | https://tiles.openfreemap.org/styles/bright |
| Satellite | Esri public World Imagery | https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer |
| Classic | OpenStreetMap Standard | https://operations.osmfoundation.org/policies/tiles/ |

OpenFreeMap explicitly supports its public instance without registration or API keys: https://openfreemap.org/quick_start/. Attribution remains visible for all providers. OSM browser requests retain the Referer header and normal browser caching; there is no tile prefetch or offline downloader. Esri imagery uses the service's published contributor attribution. These hosted services can change availability or terms. Base-map failure does not discard imported history; another provider can be selected.

### Google Maps

Google roads and terrain use the supported [Map Tiles API](https://developers.google.com/maps/documentation/tile). The app creates and renews sessions, requests viewport-specific copyright notices after navigation, escapes that text, and keeps the Google Maps brand and attribution visible. Attribution failure returns to Midnight. No private tile endpoints or deprecated Google heatmap library are used. EEA projects cannot request Google satellite tiles; Esri imagery remains available.

The dedicated Cloud project is `location-history-512511`. Its browser key permits only `tile.googleapis.com` and the website `https://kusaku.su/*`. Restricting the whole origin is necessary because cross-origin browser requests send the origin as Referer. The 2D-tile quota is **3,000 requests/day**, at most 93,000 in a 31-day month, below the console's current 100,000/month free allowance. Street View and 3D-root daily quotas are zero. Google allowances are shared by billing account, so usage from other projects on the same account also counts. [Quota console](https://console.cloud.google.com/google/maps-apis/quotas?project=location-history-512511&api=tile.googleapis.com).

Keys in `map-config.mjs` are deliberately public, as required by a static browser app. Keep application/API restrictions and quotas in the provider console. Never add Apple signing keys, service-account credentials, server secrets, or session tokens to this file. The remaining maps continue working when a configured provider is unavailable.

### Yandex Maps

The supported [Tiles API](https://yandex.ru/maps-api/docs/tiles-api/) has a free plan limited to 30 requests/second, with no daily limit in the account console. `createYandexProvider` requests `projection=web_mercator` explicitly; Yandex's default elliptical projection would misalign the imported geometry. It uses the `future_map` street style, the vendor's unchanged logo, a terms link, and an Open in Maps link for the current viewport. The custom MapLibre protocol spaces tile requests by at least 40 ms and supports cancellation and normal HTTP caching. The service-wide limit still applies across visitors.

Activation can take up to 15 minutes. Set `yandexTilesApiKey` only after a live tile request succeeds. The console provides no HTTP Referer restriction for Tiles API; its restriction fields apply to JavaScript API instead. The separate JavaScript API key is not used by this app.

The key is configured in `MAP_CONFIG`. On 2026-10-23 live Web Mercator tile requests passed with HTTP 200, PNG output, and browser CORS support. Initial account propagation exceeded the documented activation window; no frontend workaround was needed.

### Other providers

- Apple MapKit JS requires a Maps token. The signed-in account currently reports **Access Unavailable** for Certificates, Identifiers & Profiles until it belongs to a developer program/team. No membership was purchased and no Apple provider is exposed.
- Azure Maps was skipped at the user's request because the account has no active subscription. Bing Maps Basic is retired; new integrations should use Azure Maps. No Microsoft credential or selector is included.

OpenFreeMap replaces CARTO, whose current public basemap terms require a licence/grant. The old Thunderforest cycle layer required a key, and legacy Esri streets/topographic and OpenTopoMap layers have been removed from the selector.

## Implementation and dependencies

- **MapLibre GL JS 6.15.0**, pinned JS and CSS from jsDelivr; native WebGL heatmap, fill, circle, and line layers. ES modules are used as required by v6. No Leaflet, Leaflet.heat, runtime Tailwind, bundler, framework, or package manager.
- **Native CSS** handles the responsive desktop workspace and mobile map/settings layout. DM Sans and Space Grotesk are optional fonts served by Google Fonts, with system fallbacks.
- `app.mjs`: UI, map rendering, provider switching, debounced queries with backpressure, and local download.
- `worker.mjs`: bounded file decoding, gzip decompression, import staging, filtering, and export.
- `data.mjs`: pure parsing, validation, duplicate handling, spatial aggregation, density normalization, track splitting, and dateline-aware bounds.
- `maps.mjs`: provider URLs, session lifecycle, attribution, rate limiting, and palettes. `map-config.mjs` contains only public browser keys; `yandex-logo.svg` is the unchanged vendor asset from its Tiles API documentation.
- `data.test.mjs`, `worker.test.mjs`, and `maps.test.mjs`: Node built-in tests covering import formats, the full 266,682-point sample, gzip, transactional failures, filtering, period navigation, exact exports, clearing memory, provider requests, attribution, invalid sessions, and cancellation. No test dependency installation.

Imported data remains in worker memory and only rendered geometry is sent to the map renderer. Files are not uploaded or saved in browser storage. Selected providers receive map requests revealing the viewed area; jsDelivr and Google Fonts receive normal asset requests. The existing sample is already a public repository asset and only loads when explicitly requested. No analytics, session recording, or service worker is included.

## GitHub Pages deployment

This follows the same repository-root Pages pattern as `elliptic-curve-lab` and the political-map repositories: a standalone repository published at a path under the account site's custom domain.

- Publish the **`master` branch, `/` (root)** through GitHub Pages. Keep the existing branch-based publishing mode; no build workflow or artifact assembly is necessary.
- `.nojekyll` makes this a plain static site.
- **Do not add a `CNAME`.** The account site owns `kusaku.su`; this project inherits its domain and is served under `/location-history/`.
- On publication, clear **Settings → Pages → Custom domain** on `kusaku/location-history` if it still says `location-history.kusaku.su`. Removing the tracked `CNAME` takes effect when the updated branch is published; verify the setting too.
- Verify https://kusaku.su/location-history/, module/worker imports, the bundled gzip sample, and provider attribution before disabling the old subdomain's DNS.
- The project card in `kusaku.github.io/index.html` points to the new path and should be published alongside this change.

The main site's `CNAME` stays in place. This repository does not modify DNS, the account site's publishing configuration, or other project sites.
