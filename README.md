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
- **Import:** multiple files, drag and drop, explicit sample loading, and transactional replacement. Large JSON and gzip files are read incrementally, with byte progress and a running location count. A failed import keeps the existing dataset. Select all files together to merge them. Clear or reload removes imported history from memory.
- **Export:** the exact filtered observations as timestamped GeoJSON points; no display sampling or viewport clipping is applied.

### Performance verification

Run `node scripts/benchmark.mjs` for the bundled sample, or append local JSON/gzip paths for larger histories. `--revision <commit>` runs the same queries against an earlier `data.mjs`. Files stay local; the output contains aggregate statistics and geometry hashes. See [PERFORMANCE.md](PERFORMANCE.md) for measured before/after results and limitations.

The worker builds a compact spatial index and caches only the current quality/hour filter and date selection. Panning reuses the histogram, date bounds, distance, and journey geometry. Points and Journeys skip density aggregation. Unchanged geometry is transferred only when the UI has not already acknowledged its version, so discarded queries cannot leave missing overlays. GPU style changes do not rerun filtering. Exports use bounded feature batches and Blob parts rather than a whole-history feature array and JSON string.

Dates and hours use **UTC**, including distinct-day counts. Accuracy filters keep observations without accuracy metadata. Empty selections are valid.

## Supported inputs

- Google Takeout `Records.json` / legacy `locations`, with ISO `timestamp` or numeric/string `timestampMs`.
- Monthly `timelineObjects` with `placeVisit` and `activitySegment` records.
- On-device Timeline `semanticSegments` or an array of segments, with visits, timestamped paths, offset-timed paths, and activity endpoints.
- The original `delta-compressed` sample format.
- GeoJSON FeatureCollections of Point features with `properties.timestamp` or `properties.time` (ISO or milliseconds), and optional `properties.accuracy` in metres.
- Any of the above compressed with gzip; compression is detected by its magic bytes.

Coordinates and timestamps are validated. Exact duplicates use timestamp **and** coordinates; different locations sharing a timestamp survive. Unknown JSON schemas and files with no valid observations produce an explicit error. Untimed semantic waypoints cannot become dated observations. Records, Timeline, and GeoJSON collections are parsed in batches of up to 1,000 array entries or about one million characters rather than decoding a whole file into one string; there is no 512 MB file-size restriction. The import retains at most five million combined observations before deduplication, with in-place sorting and deduplication to reduce memory use. An individual JSON value is limited to 32 million characters; the older delta-compressed format retains its bounded decoder for the three numeric arrays (512 million characters). Available device memory still limits very large imports. Google changes its export formats; unsupported structures are reported rather than silently treated as locations.

## Maps and providers

The built-in choices require no credentials:

| Map | Provider | Endpoint / documentation |
| --- | --- | --- |
| Midnight | OpenFreeMap Dark | https://tiles.openfreemap.org/styles/dark |
| Paper | OpenFreeMap Positron | https://tiles.openfreemap.org/styles/positron |
| Streets | OpenFreeMap Liberty | https://tiles.openfreemap.org/styles/liberty |
| Bright | OpenFreeMap Bright | https://tiles.openfreemap.org/styles/bright |
| Esri satellite | Esri public World Imagery | https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer |
| OpenStreetMap | OpenStreetMap Standard | https://operations.osmfoundation.org/policies/tiles/ |

OpenFreeMap explicitly supports its public instance without registration or API keys: https://openfreemap.org/quick_start/. Attribution remains visible for all providers. OSM browser requests retain the Referer header and normal browser caching; there is no tile prefetch or offline downloader. Esri imagery uses the service's published contributor attribution. These hosted services can change availability or terms. Base-map failure does not discard imported history; another provider can be selected.

### Google Maps

Google roads and terrain use the supported [Map Tiles API](https://developers.google.com/maps/documentation/tile). The app creates and renews sessions, requests viewport-specific copyright notices after navigation, escapes that text, and keeps the Google Maps brand and attribution visible. Attribution failure returns to Midnight. No private tile endpoints or deprecated Google heatmap library are used. EEA projects cannot request Google satellite tiles; the separate Maps JavaScript integration supplies Google satellite and hybrid.

The dedicated Cloud project is `location-history-512511`. Its browser key permits only `tile.googleapis.com` and the website `https://kusaku.su/*`. Restricting the whole origin is necessary because cross-origin browser requests send the origin as Referer. The 2D-tile quota is **3,000 requests/day**, at most 93,000 in a 31-day month, below the console's current 100,000/month free allowance. Street View and 3D-root daily quotas are zero. Google allowances are shared by billing account, so usage from other projects on the same account also counts. [Quota console](https://console.cloud.google.com/google/maps-apis/quotas?project=location-history-512511&api=tile.googleapis.com).

Keys in `map-config.mjs` are deliberately public, as required by a static browser app. Keep application/API restrictions and quotas in the provider console. Never add Apple signing keys, service-account credentials, server secrets, or session tokens to this file. The remaining maps continue working when a configured provider is unavailable.

### Satellite SDK integrations

The existing `Satellite` source is Esri World Imagery; its selector is now explicitly named **Esri satellite**. Google and Yandex imagery are separate choices.

Google's [EEA Tiles adjustments](https://developers.google.com/maps/comms/eea/map-tiles) block satellite images through the Tile API for this project. Its supported alternative is Maps JavaScript API's satellite/hybrid map types. The separate `googleMapsJavaScriptApiKey` is configured and restricted to Maps JavaScript API and `https://kusaku.su/*`. The project’s **Map loads per day hard quota is 300**, at most 9,300 loads in a 31-day month. 3D Map loads and Maps Grounding Widget daily quotas are zero. The Dynamic Maps allowance is separate from Tile API usage: 10,000 map loads/month, shared across the billing account. The daily quota was verified in the console on 2026-10-23. [JavaScript quota console](https://console.cloud.google.com/google/maps-apis/quotas?project=location-history-512511&api=maps-backend.googleapis.com).

Yandex's free JavaScript API supports `yandex#satellite` and `yandex#hybrid`, unlike its street-only Tiles API. The existing `yandexJavaScriptApiKey` is restricted to `kusaku.su`; the account currently shows a free allowance of 100 API requests/day. No paid plan was activated.

`native-maps.mjs` loads an SDK only when its satellite/hybrid choice is selected. One instance per SDK is reused across style switches, preserving billing behavior. A transparent MapLibre overlay keeps all four visualization modes and local history processing. Camera updates include the 256px/512px zoom offset and fractional zoom. SDK maps use a flat, north-up view; rotation and pitch controls are restored when returning to tile/vector providers. A reserved footer keeps native copyright controls visible and clickable.

### Yandex Maps

The supported [Tiles API](https://yandex.ru/maps-api/docs/tiles-api/) has a free plan limited to 30 requests/second, with no daily limit in the account console. `createYandexProvider` requests `projection=web_mercator` explicitly; Yandex's default elliptical projection would misalign the imported geometry. It uses the `future_map` street style, a terms link, and an Open in Maps link for the current viewport. Yandex's [documentation](https://yandex.com/maps-api/docs/tiles-api/index.html) requires a clickable corner logo; this site omits that overlay at the owner's request. The [supported styles](https://yandex.com/maps-api/docs/tiles-api/request.html) do not include terrain; the Tiles API only supplies roadmap tiles. The custom MapLibre protocol spaces tile requests by at least 40 ms and supports cancellation and normal HTTP caching. The service-wide limit still applies across visitors.

Activation can take up to 15 minutes. Set `yandexTilesApiKey` only after a live tile request succeeds. The console provides no HTTP Referer restriction for Tiles API; its restriction fields apply to JavaScript API instead. The separate JavaScript API key is used only for the satellite/hybrid SDK integration.

The key is configured in `MAP_CONFIG`. On 2026-10-23 live Web Mercator tile requests passed with HTTP 200, PNG output, and browser CORS support. Initial account propagation exceeded the documented activation window; no frontend workaround was needed.

### Azure Maps

The Gen2 renderer supports roads, dark roads, satellite imagery, satellite with road labels, and shaded relief (the relief tiles stop at zoom 6). Selectors appear only when `azureMapsSubscriptionKey` is configured. It uses the documented Render `2024-04-01` endpoints and fetches current attribution for every tileset, including both sides of a dateline-crossing view. Missing or malformed attribution fails closed; a valid empty contributor list, as returned for relief, retains the Microsoft provider credit. Relief uses 512px tiles; the other styles use 256px tiles.

The [monthly allowance](https://azure.microsoft.com/pricing/details/azure-maps/) includes 5,000 base-map and 1,000 imagery transactions; 15 tile requests count as one transaction. This corresponds to 75,000 road tiles and 15,000 imagery tiles. These are usage allowances, not hard monthly caps. Free-trial spending protection prevents automatic charges until an explicit upgrade; Azure's free trial is time-limited. Never claim that a paid Azure subscription is capped by these allowances.

The dedicated `location-history` Gen2 Maps account is configured in North Europe with CORS limited to `https://kusaku.su`. West Europe rejected new customers at creation time. The subscription remains on its existing free-trial offer; it was not upgraded to pay-as-you-go. Azure shared keys authorize all Maps REST services for their account; CORS is a browser restriction, not authentication against non-browser clients. A public static app cannot conceal a shared key. SAS tokens permit narrower access and rate limits but expire within 24 hours and require a renewal service or job. Never put Azure management credentials, service-principal secrets, or other account secrets in this repository.

### Other providers

- Apple MapKit JS requires a Maps token. The signed-in account currently reports **Access Unavailable** for Certificates, Identifiers & Profiles until it belongs to a developer program/team. No membership was purchased and no Apple provider is exposed.
- Bing Maps Basic is retired; new Microsoft integrations use Azure Maps.

OpenFreeMap replaces CARTO, whose current public basemap terms require a licence/grant. The old Thunderforest cycle layer required a key, and legacy Esri streets/topographic and OpenTopoMap layers have been removed from the selector.

## Implementation and dependencies

- **MapLibre GL JS 6.15.0**, pinned JS and CSS from jsDelivr; native WebGL heatmap, fill, circle, and line layers. ES modules are used as required by v6. No Leaflet, Leaflet.heat, runtime Tailwind, bundler, framework, or package manager.
- **Native CSS** handles the responsive desktop workspace and mobile map/settings layout. DM Sans and Space Grotesk are optional fonts served by Google Fonts, with system fallbacks.
- `app.mjs`: UI, map rendering, provider switching, debounced queries with backpressure, and local download.
- `import.mjs`: incremental UTF-8/JSON decoding, gzip decompression, bounded record batches, schema validation, and read progress.
- `worker.mjs`: transactional import staging, dataset query lifecycle, acknowledged geometry transfers, and export.
- `data.mjs`: parsing, validation, duplicate handling, indexed viewport queries, density normalization, cached selection statistics, track splitting, dateline-aware bounds, and bounded GeoJSON export.
- `native-maps.mjs`: lazy provider SDK loading, synchronized satellite cameras, and reused SDK instances.
- `maps.mjs`: provider URLs, session lifecycle, attribution, rate limiting, and palettes. `map-config.mjs` contains only public browser keys.
- `data.test.mjs`, `import.test.mjs`, `worker.test.mjs`, `maps.test.mjs`, and `native-maps.test.mjs`: Node built-in tests covering import formats, UTF-8 and JSON chunk boundaries, the full 266,682-point sample, gzip, transactional failures after partial parsing, filtering, period navigation, exact exports, clearing memory, provider requests, attribution, invalid sessions, cancellation, lazy SDK loading, renderer camera alignment, and SDK lifecycle. No test dependency installation.

Imported data remains in worker memory and only rendered geometry is sent to the map renderer. Files are not uploaded or saved in browser storage. Selected providers receive map requests revealing the viewed area; jsDelivr and Google Fonts receive normal asset requests. The existing sample is already a public repository asset and only loads when explicitly requested. The app includes no analytics, session recording, or service worker. Optional Google/Yandex SDKs make their own provider requests and are governed by their providers’ privacy policies.

## GitHub Pages deployment

This follows the same repository-root Pages pattern as `elliptic-curve-lab` and the political-map repositories: a standalone repository published at a path under the account site's custom domain.

- Publish the **`master` branch, `/` (root)** through GitHub Pages. Keep the existing branch-based publishing mode; no build workflow or artifact assembly is necessary.
- `.nojekyll` makes this a plain static site.
- **Do not add a `CNAME`.** The account site owns `kusaku.su`; this project inherits its domain and is served under `/location-history/`.
- On publication, clear **Settings → Pages → Custom domain** on `kusaku/location-history` if it still says `location-history.kusaku.su`. Removing the tracked `CNAME` takes effect when the updated branch is published; verify the setting too.
- Verify https://kusaku.su/location-history/, module/worker imports, the bundled gzip sample, and provider attribution before disabling the old subdomain's DNS.
- The project card in `kusaku.github.io/index.html` points to the new path and should be published alongside this change.

The main site's `CNAME` stays in place. This repository does not modify DNS, the account site's publishing configuration, or other project sites.
