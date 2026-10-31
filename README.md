# Location History

A responsive, static location-history explorer at **https://kusaku.su/location-history/**.

## Run and verify

No build, package installation, or backend is required. Six maps work without credentials; additional providers use public browser keys in `js/map-config.mjs`. Use a current browser with WebGL2, module workers, and Compression Streams for gzip files.

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

OpenFreeMap Midnight is selected on the first visit. This browser remembers the chosen base map, visualization, density metric, independent Points/Journeys Time, Speed or Altitude colour choices, palette, sliders, and date/hour/accuracy/speed/altitude filters and Track quality (mode, speed-spike allowance and drift window) across reloads. Date selections apply when history is reopened and stay within its bounds. Imported locations, filenames, and the map camera are never saved. Preferences use the project-specific `location-history.settings.v1` local-storage key; invalid or unavailable storage falls back safely to defaults. Slider preferences are written only when a change is committed.

- **Heatmap:** GPU-rendered density with a screen-space spread, intensity, opacity, and three colour palettes.
- **Hexagons:** zoom-adaptive cells with record, recorded-day, and estimated time-in-area details on click.
- **Points:** individual observations with timestamps and accuracy; at most 20,000 representative points in view. Observation counts remain exact; visit time can exist without a new location recording. The selected palette maps Time across Date window, Speed with fixed km/h stops, or Altitude across the known selection range (stable while panning). Click details include timestamp, accuracy, recorded/estimated speed and altitude; unavailable speed is grey. The popup date and time are separate keyboard-accessible links: the date selects the complete UTC day, and the time selects that UTC hour on the same day. They share the calendar selection flow, reset hours for a full-day selection, and persist the resulting window.
- **Journeys:** consecutive retained locations, with independent line-thickness and opacity sliders. Geometry preserves turns; it never replaces every N recordings with a single chord. Only movement smaller than a map pixel at the current zoom is reduced, and zooming in restores detail. Accuracy filtering connects retained observations. Hour/jump exclusions, gaps over six hours, dateline crossings and speeds above 1,000 km/h still break paths. Time uses 256 fixed bands across Date window. Speed and Altitude use time-weighted interval averages in bounded colour sections (about 20,000 plus run boundaries), retaining the intermediate coordinates of each section; at least half its duration needs known values. A small bounding-box index excludes offscreen sections while retaining segments that cross the view with both endpoints outside. The current piece index and colour averages are cached; geometry changes only when the visible pieces or integer zoom level change. Sparse paths are not road routing. Distance uses accumulated displacement beyond GPS uncertainty; short intervals with device speed integrate that measurement. Distance remains an estimate.

- **Journey shape:** Straight is the default. Smooth is a saved, route-only display choice, active from zoom 12 when visible pieces contain at most 10,000 edges. Closely spaced fixes (under four screen pixels) stay straight. Four rolling anchor entries allow accuracy-bounded rounding toward time-interpolated neighbours, capped at four pixels; unknown-accuracy fixes and run endpoints stay at their recorded positions. Cubic Bézier controls use shortened Catmull–Rom tangents with eight-pixel handles. Adaptive de Casteljau subdivision adds at most 16 samples per edge, only for visible geometry, with padded culling for curve overhang. Pixel thresholds use the cached integer zoom level; fractional zoom scales the same geometry. No coordinates or fields are added to imported observations. Counts, speed, distance, filters and place statistics use the original data, and all colour modes retain contiguous boundaries. Overview/dense fallbacks reuse the straight geometry cache.

- **Speed and altitude:** raw Google positions preserve altitude metres and device speed (m/s converted to km/h). GeoJSON accepts a third coordinate or altitude/elevation properties; explicit speedMetersPerSecond and Android-style provider/time_long exports have known m/s units. Unlabelled generic speed properties are not assigned guessed units. Outside GPS drift mode, device speed takes priority at a point; otherwise valid incoming/outgoing intervals from the same device and source are averaged on demand. Approximate event boundaries are excluded from speed estimates. With Track quality enabled, estimation skips detected outliers so a bad fix does not inflate its valid neighbours’ speeds. Accuracy filtering changes visibility; GPS drift separately uses reported accuracy to assess confidence. Keep the 15-minute interval and 1,000 km/h safeguards. Speed stops are 0, 5, 20, 50, 130 and 1,000 km/h. Altitude spans the known selection range, handles negative/zero values, and stays stable on pan. It is the recorded height, often WGS84 ellipsoid height rather than mean sea level; there are no elevation-service calls. Missing values are grey.
- **Map controls:** zoom and history tools share the summary/timeline inset. The compass resets both rotation and tilt and is hidden for the flat Google/Yandex SDK satellite modes. Fit uses the current filtered selection, waits for pending filters, resets perspective, and uses the map's full zoom range. In Journeys it fits connected, moving tracks across the whole selection; isolated fixes and entirely stationary runs do not expand its bounds. Padding reserves the summary and date window; a floating place panel does not shrink the full map.
- **Density metrics:** number of records, distinct UTC days per cell, or estimated stationary time. Explicit visit durations and stationary intervals of at most 30 minutes within 200 metres contribute time; known visit intervals are intersected with every selected UTC day/hour, including when their start precedes Date window. A prefix-end index over blocks of 256 observations finds overlapping intervals, using about 1/256 of the previous interval-index memory. Overlapping intervals within a cell are counted as a union. Sampling gaps and movement do not become stays. Visit intervals are retained without manufacturing GPS observations; days with known time can have zero newly recorded locations.
- **Place history:** click a hexagon or draw up to 64 corners in any mode. The highlighted area reports exact observations, recorded visits and days, first/last observation, and estimated time in the area, including movement. Choose the current window or all dates; hour, accuracy and jump filters still apply. The wider panel keeps its summary and Calendar / Recorded stays / By day tabs visible while the active view scrolls. The UTC calendar has independent Year, Quarter, Month, Week and Day views, with previous/next and date/year controls. Opening or switching views starts at Date window's first day, including a day just selected in the calendar. Calendar arrows and the date/year fields still browse independently. Quarter shows three monthly grids. Week uses seven day rows and 24 hour columns to fit without scrolling; Day uses hourly bars. All calendar views and the legend share the app's lime accent scale. Hover/focus shows exact totals. Selecting a date updates Date window and resets hours to 00:00–24:00 without changing the calendar view, period or scope; selecting an hour sets that hour instead. Year, Quarter and Month reuse existing daily totals. Day and Week query only the displayed interval through the worker index, returning at most 168 hourly bins. One pending hourly request coalesces changes and stale replies are ignored. Metric changes reuse the hourly result. Hidden calendar views do not request hourly data. At most 366 day cells or 168 hour cells are rendered. On narrow screens the yearly calendar scrolls horizontally. Sortable UTC tables include every stay and recorded day, newest first by default. Stays show From, To, Locations and Duration; daily totals show Date, Locations and Duration. Simple 100-row pages keep large tables responsive; sorting covers the complete result. Selecting a stay or day selects its dates. Summary totals cover the entire selection. Selections stay in memory. Drawing supports clicks, Finish/Undo, Enter/Escape, and Space to add the map centre after keyboard panning.
- **Track quality:** immediately after Accuracy, this popover controls outlier removal and a 0–200 km/h speed-spike allowance (default +15 km/h). Lower allowance is stricter; steady fast travel is preserved. Original incoming/outgoing segment speeds are compared with the median and MAD of up to eight surrounding segments within 15 minutes. There must be at least four context segments, with support on both sides. A point is removed only when both incident speeds exceed the local median plus the larger of the allowance or three scaled MADs, the direct neighbour-to-neighbour path fits the local movement band, and the detour exceeds measurement resolution. Larger allowance cannot introduce additional exclusions. Existing extreme-speed and acceleration guards remain. Short bursts of up to eight fixes are rejected when both boundary transitions are impossible while the direct bypass is plausible; long gaps do not establish that evidence. Large gaps and insufficient local context do not trigger the local rule. Decisions use original observations before display filters; no records are mutated. Native popovers also provide Hours, Accuracy, Speed and Altitude ranges. Unknown metadata stays included unless explicitly excluded. Dates share a two-thumb track with exact daily steps. Dragging either thumb in Day/Week/Month/Quarter/Year moves the complete current window, preserves its exact day count and selected preset, and clamps it at the history edges. All time keeps the thumbs independent and stays selected while the free range is resized; its saved custom range is restored on reload. Clicking All time restores the complete history. Accuracy and speed slider positions are logarithmic; numeric values remain in metres and km/h.
- **Relative density:** occupied cells are scaled to their 95th-percentile value, then square-root transformed to keep less frequent places visible. Density is recalculated for the padded visible area and current zoom. Colours compare spatial patterns in the current view, not absolute values across zoom levels or filters.
- **Timeline:** Day, Week, Month, Quarter, and Year resize the current window from its start, using UTC days and calendar arithmetic (Week is seven days; Quarter is three months). If the resized window would exceed the history, it moves back to fit. Backward/forward and Play move the entire window by that unit; custom windows move by their duration. Playback stops at the end and never resets to the beginning or grows cumulatively. Histogram bars span calendar days, Monday–Sunday weeks, months or quarters, choosing the finest interval that fits the full history and panel width at roughly 10 px per bar. Very long histories use calendar years. The first and last bars stop at the imported UTC dates; empty intervals remain visible, and bars share the full width. The current interval appears below the chart; hover for exact dates and counts. Measurement, hour, device and track-quality filters update counts without changing the intervals. Selecting a bar reproduces its count. Arrow keys, Home, and End move between bars; Enter or Space selects one. Resizing uses cached filter totals per 256 observations and at most 255 mask bytes per boundary, without rescanning the dataset or changing the selected window.
- **Import:** multiple files, drag and drop, explicit sample loading, and transactional replacement. Large JSON and gzip files are read incrementally, with byte progress and a running location count. A failed import keeps the existing dataset. Select all files together to merge them. Clear or reload removes imported history from memory.

### Performance verification

Run `node tests/benchmark.mjs` for the bundled sample, or append local JSON/gzip paths for larger histories. `--synthetic 1000000` exercises a generated million-record history. `--revision <commit>` compares against an earlier revision, including revisions before the folder reorganization. Files stay local; output contains aggregate statistics and geometry hashes.

The 2026-10-23 optimization measurement used 3,306,412 observations: repeated world-heat computation fell from 524.53 to 225.33 ms, and sequential-run peak RSS from 1,604 to 1,179 MiB. All seven sample and large-history cases retained identical statistics and active-geometry hashes; a seeded 180-query comparison also matched. These measure local worker computation, not browser frame rate or network latency. Reproduce the previous baseline with `node tests/benchmark.mjs --revision a0be2e5 [files...]`.

The worker builds a compact spatial index and caches only the current measurement/hour/jump filter and date selection. Point speeds use original neighbours (skipping detected outliers when Track quality is enabled) and are computed on demand for displayed points or active speed filtering, without a full-size speed array outside GPS drift mode. Panning reuses the histogram, date bounds, distance, and journey piece index. Only visible route pieces are transferred; subpixel geometry detail follows zoom. Points and Journeys skip density aggregation. Unchanged geometry is transferred only when the UI has not already acknowledged its version, so discarded queries cannot leave missing overlays. GPU style changes do not rerun filtering. Track-quality flags cost one byte per observation and are calculated lazily when enabled, cached for the current allowance. Changing the allowance replaces that cache; panning and date/hour/measurement filtering reuse it. The local detector uses fixed-size distance and median scratch buffers, without adding per-point fields. The quality slider applies filtering on commit, keeping dragging responsive. Place queries reuse the spatial index and filter mask without invalidating map date/route caches; only the last aggregate result is cached. Small areas sort their spatial candidates; broad areas stream chronologically. Repeated panning does not rerun a selected place query.

Dates and hours use **UTC**, including distinct-day counts. Accuracy choices are All, <10 m, <50 m, <100 m, <500 m and <1 km. Limits are strict; observations without accuracy metadata remain included. Empty selections are valid.

Recorded place stays merge when the gap from the previous stay end is less than 15 minutes, including short exits or filtered intervals. A gap of exactly 15 minutes starts a new stay. Time in the area combines stored durations with intervals under 15 minutes between consecutive, accepted observations inside the selection, including travel. Exits, excluded observations and longer recording gaps do not establish continuous time. Intervals are clipped to the date window and hours, split at midnight for daily totals, and overlapping time is counted once. Endpoint observations estimate presence between recordings; the exact path and arrival/departure times are unknown. Explicit intervals stop at the first later accepted exit, found by a shared forward scan without a per-point exit array. The stationary-density metric remains separate and excludes movement.

Device/source metadata uses one optional shared descriptor per point. Multiple devices get an 8-byte-per-point index; single-device imports allocate no device arrays. Device selection is dataset-scoped, applies to map/place queries and never persists original identifiers. Outlier detection and estimated speed do not compare different devices or recording sources. Approximate Timeline event boundaries retain their place durations but do not establish instantaneous speed.

Track quality offers Off, Outliers and GPS drift. Drift fits movement within a 15–600 second window, independently per device and with separate offsets for recording sources. At most one representative per source per five seconds prevents bursts from manufacturing confidence. Accuracy and residual scatter set a noise floor; unsupported movement is unknown, not forced to zero. The result is heuristic and may miss short/small movements. Drift uses a lazy 4-byte-per-point speed cache, reused across date/hour/accuracy/device/viewport changes; changing its averaging window or outlier mask recomputes it. Rolling moments keep computation linear, with periodic rebasing for numeric stability. Distance in this mode integrates only confirmed speeds; original device speed remains visible separately in the point popup. Imported observations are never deleted by these controls.

## Supported inputs

- Google Takeout `Records.json` / legacy `locations`, with ISO `timestamp` or numeric/string `timestampMs`.
- Monthly `timelineObjects` with `placeVisit` and `activitySegment` records.
- On-device Timeline `semanticSegments` and `rawSignals.position` in the same export or separately, with visits, timestamped paths, offset-timed paths and activity endpoints. Raw sensor/activity/Wi-Fi records without positions are ignored. Combined imports accept recognized empty exports.
- Delta-compressed history: the original sample format and version 2 with optional accuracy and explicit visit durations.
- GeoJSON FeatureCollections of Point features with `properties.timestamp` or `properties.time` (ISO or milliseconds), and optional `properties.accuracy` in metres.
- Any of the above compressed with gzip; compression is detected by its magic bytes.

Coordinates and timestamps are validated. Exact duplicates use timestamp, coordinates **and device identifier**; different locations sharing a timestamp survive. Unknown JSON schemas and files with no valid observations produce an explicit error. Untimed semantic waypoints cannot become dated observations. Records, Timeline, and GeoJSON collections are parsed in batches of up to 1,000 array entries or about one million characters rather than decoding a whole file into one string; there is no 512 MB file-size restriction. The import retains at most five million combined observations before deduplication, with in-place sorting and deduplication to reduce memory use. An individual JSON value is limited to 32 million characters; compressed numeric columns have a 512-million-character bound. Available device memory still limits very large imports. Google changes its export formats; unsupported structures are reported rather than silently treated as locations.

### Recreate the public sample

```sh
node scripts/create-sample.mjs /Users/user/Projects/jupyter/location/tanya.json --end 2020-04-01 --output data/sample-location-history.json.gz
```

The script streams the source, keeps the entire end date in UTC, sorts observations, and merges only exact timestamp/coordinate/device duplicates, retaining the best accuracy and longest explicit duration. Repeated positions at different times remain because they establish visits and time spent. It replaces the output atomically, leaves the input untouched, and reports aggregate counts without coordinates. Output is deterministic. It retains at most five million selected observations and requires no packages.

The sample has 910,311 observations through April 1, 2020, with accuracy preserved for every record. The previous 266,682-point sample was additionally reduced; exact deduplication alone does not reproduce that selection. The regenerated file includes all trimmed observations and removes zero exact duplicates. It contains precise location history and is a public asset; do not extend its dates or change its source without reviewing what will be published.

Version 2 retains `format: "delta-compressed"`, adds `version: 2`, and keeps the existing `base` plus three delta arrays: latitude E7, longitude E7, and timestamp milliseconds. Optional full-length `accuracy` (metres), `duration` (explicit milliseconds), `altitude` (metres) and `recordedSpeed` (km/h) columns preserve metadata. Unknown accuracy, altitude and speed use null; zero and negative altitude are retained. All-unknown accuracy and all-zero durations are omitted. Coordinates use seven decimal places; Google E7 coordinates and millisecond timestamps round-trip exactly. Stationary durations are inferred after import, never baked into an export. An optional `streams` table plus a full-length `stream` integer column retains recording source and anonymous device membership. Original device identifiers are replaced with deterministic sample aliases. Activity labels and other unused source fields are omitted. Malformed column lengths, invalid values and unknown versions are rejected; the original unversioned format still imports.

Delta columns plus gzip remain compact and use only native browser APIs. For this sample, gzip level 9 produces 5,254,299 bytes, versus 7,938,230 bytes for absolute coordinate/time columns with the same accuracy. Device/source metadata adds 48,917 compressed bytes to the previous accuracy-preserving sample. The 623 MiB source is streamed rather than loaded as a single JSON string.

## Maps and providers

The selector uses Roads → Terrain → Satellite → Hybrid → Dark tabs, then compact provider choices in a consistent Google/Yandex/OpenStreetMap/Azure/Esri/OpenFreeMap order where available. Switching tabs only browses choices; selecting a provider changes the map. Provider names use the same readable size on mobile and desktop. The shared `images/map-previews.svg` supplies decorative illustrations with distinct provider palettes; terrain has contours and hybrid includes roads and labels. It makes no map API requests and loads no SDK. Map IDs and saved preferences stay stable.

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

Keys in `js/map-config.mjs` are deliberately public, as required by a static browser app. Keep application/API restrictions and quotas in the provider console. Never add Apple signing keys, service-account credentials, server secrets, or session tokens to this file. The remaining maps continue working when a configured provider is unavailable.

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
- **Library review, 2026-10-23:** retain MapLibre as the single overlay renderer; its [current release](https://github.com/maplibre/maplibre-gl-js/releases/tag/v6.15.0) already supplies all four visualization layers. The Google SDK remains on its documented [quarterly channel](https://developers.google.com/maps/documentation/javascript/versions). Yandex 2.1 loads only `Map` and `projection.sphericalMercator` through its [module loader](https://yandex.com/dev/jsapi-v2-1/doc/en/v2-1/dg/concepts/modules), with dependency resolution handled by the SDK. Both SDKs remain optional and reuse one map instance per provider. Azure, Esri, and OSM use tiles without additional SDKs. Native file streams, JSON parsing, gzip decompression, and workers cover the data flow without extra libraries.
- **Native CSS** handles the responsive desktop workspace and mobile map/settings layout. DM Sans and Space Grotesk are optional variable fonts served by Google Fonts, with system fallbacks. Weight ranges avoid repeated font-face declarations without adding font files.
Runtime modules live in `js/`:

- `app.mjs`: UI, map rendering, provider switching, and debounced queries with backpressure.
- `import.mjs`: incremental UTF-8/JSON decoding, gzip decompression, bounded record batches, schema validation, and read progress.
- `worker.mjs`: transactional import staging, dataset query lifecycle, and acknowledged geometry transfers.
- `motion.mjs`: device indexing and lazy GPS-drift speed estimates using rolling weighted moments, bounded source-balanced sampling and a reusable Float32 cache.
- `data.mjs`: parsing, validation, duplicate handling, indexed viewport queries, density normalization, cached selection statistics, track splitting, cached track-quality flags, indexed place statistics, and dateline-aware bounds.
- `place-history.mjs`: area drawing, selected-cell highlighting, bounded visit details, scoped worker requests, and stale-response handling.
- `native-maps.mjs`: lazy provider SDK loading, synchronized satellite cameras, and reused SDK instances.
- `maps.mjs`: provider catalog, URLs, session lifecycle, attribution, rate limiting, palettes, and incremental history-layer paint updates. `map-config.mjs` contains only public browser keys.
- `filters.mjs`: native two-thumb ranges and filter popovers; linear hours/dates and logarithmic accuracy/speed positions.
- `settings.mjs`: validated, allowlisted per-mode visualization and shared date/hour/measurement/jump preferences in project-specific local storage. History and map camera state are excluded.
- `timeline.mjs`: UTC calendar window resizing/navigation and date formatting, with leap-year, month-end, boundary, and persistence checks.
- `tests/`: Node built-in tests for import formats and chunk boundaries, transactional failures, exact filtering, calendar windows, histogram counts, providers, SDK lifecycle, preferences, and incremental paint equivalence. Run with `node --test`; no test dependencies are required.

```text
index.html       Static entry point
js/              Runtime modules and public browser map configuration
css/             Responsive styles
images/          Shared decorative map previews
data/            Public bundled sample, loaded only on request
scripts/         Reproducible sample generation
tests/           All functional tests and the performance benchmark
```

Imported data remains in worker memory and only rendered geometry is sent to the map renderer. The app processes files locally without uploading them or saving them in browser storage. Selected providers receive map requests revealing the viewed area; jsDelivr and Google Fonts receive normal asset requests. The existing sample is already a public repository asset and only loads when explicitly requested. Optional Google/Yandex SDKs make their own provider requests and are governed by their providers’ privacy policies. No service worker is included.

Google Analytics (`G-J8N1Q1GVVB`) and Yandex Metrica (`105986243`) use the same asynchronous snippets and settings as `elliptic-curve-lab` and the political maps, including Yandex Session Replay, click maps, bounce measurement, and link tracking. The app layout containing imported filenames, history controls, statistics, map, and popups uses Yandex’s `ym-hide-content` class to exclude its content from replay. No custom analytics events or parameters containing history data are sent by the app.

## GitHub Pages deployment

This follows the same repository-root Pages pattern as `elliptic-curve-lab` and the political-map repositories: a standalone repository published at a path under the account site's custom domain.

- Publish the **`master` branch, `/` (root)** through GitHub Pages. Keep the existing branch-based publishing mode; no build workflow or artifact assembly is necessary.
- `.nojekyll` makes this a plain static site.
- **Do not add a `CNAME`.** The account site owns `kusaku.su`; this project inherits its domain and is served under `/location-history/`.
- On publication, clear **Settings → Pages → Custom domain** on `kusaku/location-history` if it still says `location-history.kusaku.su`. Removing the tracked `CNAME` takes effect when the updated branch is published; verify the setting too.
- Verify https://kusaku.su/location-history/, module/worker imports, the bundled gzip sample, and provider attribution before disabling the old subdomain's DNS.
- The project card in `kusaku.github.io/index.html` points to the new path and should be published alongside this change.

The main site's `CNAME` stays in place. This repository does not modify DNS, the account site's publishing configuration, or other project sites.
