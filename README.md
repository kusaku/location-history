# Location History

Static location-history explorer: [kusaku.su/location-history](https://kusaku.su/location-history/).

## Run and check

No build or package installation is needed. Use a current browser with WebGL2 and module workers; gzip imports also need Compression Streams.

```sh
python3 -m http.server 8000
node --test tests/*.test.mjs
node tests/benchmark.mjs --synthetic 1000000
```

Open [localhost:8000](http://localhost:8000/). The benchmark also accepts local JSON/gzip paths, or `--revision <commit>` for comparison. It reports worker timings, aggregate results and geometry hashes; it does not upload files.

## Use

The in-app **Guide** covers exports and controls.

- Open JSON, GeoJSON or JSON.GZ files together to merge them. Exact timestamp/coordinate/device duplicates merge, preserving richer metadata. A failed import keeps the previous history. Extract ZIP files first.
- Heatmap and Hexagons show density by locations, recorded days or estimated stationary time. Points and Journeys colour by time, speed or altitude. Each mode keeps its own visualization settings.
- Date window selects UTC dates and hours. Day, Week, Month, Quarter and Year resize the current window; dragging moves that fixed window. All time allows independent endpoints. Bars represent calendar periods fitted to the panel width.
- Track quality offers Off, Outliers and GPS drift. Outliers checks nearby sources together within each device, accounting for accuracy. GPS drift also recognizes stationary noise using direction, pace and uncertainty across its context window, with the default outlier allowance. Stationary estimates become 0; insufficient evidence stays unknown. Devices and Source appear when several choices exist.
- Click a point for details and previous/next navigation, or a hexagon for Place history. Drawing an area works in every mode. The calendar and sortable stay/day tables share the active filters. Selecting a full date resets Hours; selecting an hour narrows it.

## Data and calculations

Supported inputs: legacy Google `locations`/Records, semantic `timelineObjects`, phone `semanticSegments` and `rawSignals.position`, timestamped GeoJSON Point features, and delta-compressed history. Gzip is detected automatically. Imports are streamed and validated, with a combined limit of five million observations.

Device speed is used when its units are known; otherwise speed comes from nearby observations of the same device and source. Journeys uses interval speed, falling back to known point speeds when the recording source changes. Gaps over 15 minutes and estimates above 1,000 km/h have no speed estimate. Altitude preserves the file's reference system. Unknown measurements are included unless filtered out.

Journey geometry follows retained locations, with subpixel reduction at the current zoom. Accuracy, measurement and outlier filters connect retained locations; excluded hours, device boundaries, dateline crossings, implausible travel and gaps over six hours break tracks. Smooth uses accuracy-aware cubic curves for display, with bounded detail and a straight fallback for dense paths. It does not change measurements. Points draw at most 20,000 representative observations in view; counts remain exact.

Distance uses displacement beyond GPS uncertainty, or integrates short intervals with device speed. Stationary estimates add no distance in GPS drift. Place time combines explicit visit durations and accepted consecutive observations less than 15 minutes apart, clipped to the selected dates/hours. Overlaps count once; gaps under 15 minutes merge stays without adding time. The stationary-density metric separately uses recorded visits and short nearby intervals. All time and distance totals are estimates.

One worker owns the imported history, spatial/device indexes and current filter/selection caches. Panning reuses statistics, quality flags and journey sections. Only changed visible geometry crosses to the renderer. Quality flags use one byte per observation; GPS drift adds two bits, with no full speed array. Calendar rendering and table pages are bounded.

## Maps and privacy

MapLibre GL JS **6.15.0**, pinned from jsDelivr, supplies every overlay. Google and Yandex SDKs load only for their satellite/hybrid views and reuse their map instance. Azure, Esri, OpenStreetMap and OpenFreeMap need no additional renderer. No framework, bundler or other runtime library is required.

OpenFreeMap Midnight is the default. The selector groups Roads, Terrain, Satellite, Hybrid and Dark. `images/map-previews.svg` supplies decorative provider previews without map requests. Browser provider configuration lives in `js/map-config.mjs`; its keys are public. Restrict APIs, origins and quotas in provider consoles. Free allowances are not universal spending caps. Preserve provider attribution. Apple and Bing are not configured.

Imported files stay in memory; Clear or reload removes them. Local storage saves display/filter preferences, excluding history, filenames and the map camera. Map providers receive requests for the viewed area. Google Analytics and Yandex Metrica measure usage; Yandex Session Replay hides the map and history controls. Google Fonts and jsDelivr serve assets. The bundled sample is a public asset loaded on request.

## Sample generation

```sh
node scripts/create-sample.mjs /path/to/history.json --end 2020-04-01 --output data/sample-location-history.json.gz
```

The script streams, trims through the complete UTC end date, sorts, deduplicates and atomically writes deterministic gzip. Version 2 stores E7 coordinate/time deltas plus available accuracy, explicit duration, altitude, speed and anonymous device/source metadata. Stationary durations are inferred at import, not stored in the sample. The current public sample has **910,311 observations through 2020-04-01**. Review location disclosure before changing its source or dates.

## Files and deployment

```text
index.html   Interface and User guide
js/          App, worker, import, math, maps and controls
css/         Responsive styles
images/      Decorative map previews
data/        Public sample
scripts/     Sample generator
tests/       Functional tests and performance benchmark
```

GitHub Pages publishes **master / root**, with `.nojekyll` and no build workflow. Keep this repository free of `CNAME`: the account site owns `kusaku.su`, and this project is served at `/location-history/`. App URLs are relative. Check the project path, worker imports, sample and provider attribution after deployment.
