# How it works

Technical notes for contributors. For using the app, see the in-app **Guide**.

## Project layout

```text
index.html   Interface and in-app Guide
js/          App, worker, import, calculations, maps and controls
css/         Styles
images/      Decorative map previews
data/        Public sample history
scripts/     Sample generator
tests/       Node tests and benchmark
docs/        This document
```

No framework or bundler is needed. MapLibre GL JS supplies the renderer.

## Import

Supported inputs:

- legacy Google `locations` (Records)
- semantic `timelineObjects`
- phone `semanticSegments` and `rawSignals.position`
- timestamped GeoJSON `Point` features
- the delta-compressed format used by the sample

Gzip is detected automatically. Files are streamed and validated, with a combined limit of five million locations. A failed import keeps the previous history. Locations with the same timestamp, coordinates and device are merged, keeping the richer metadata.

One worker owns the imported history, its spatial and device indexes, and the current filter and selection caches. Panning reuses statistics, quality flags and journey sections; only changed visible geometry is sent to the renderer.

## Measurements

- **Speed:** device-recorded speed is used when its unit is known. Otherwise speed is estimated from nearby locations of the same device and source. Journeys use the speed between consecutive locations, falling back to point speeds when the recording source changes. Gaps over 15 minutes and estimates above 1,000 km/h have no speed.
- **Altitude:** kept in the file's own reference system.
- **Unknown values:** included unless a filter's *Include unknown* is turned off.
- **Distance:** counts displacement beyond the GPS uncertainty of both locations, or integrates short intervals with device speed. In GPS drift mode, stationary locations add no distance.
- **Time in a place:** combines explicit visit durations with accepted consecutive locations less than 15 minutes apart, clipped to the selected dates and hours. Overlaps count once, and gaps under 15 minutes merge stays without adding time.
- **Stationary-time density:** uses recorded visits and intervals of at most 30 minutes between locations within 200 metres.

Place history also clips retained straight track segments to the outline, including crossings with no location recorded inside. Track length uses the same uncertainty, recorded-speed and stationary rules as the map total; display smoothing does not affect it. Average and median speeds use known segment speeds weighted by time inside the outline, including known stops. A fixed histogram gives median speeds a resolution of 0.1 km/h without storing another value per location. Date and measurement filters and journey breaks still apply.

All times and distances are estimates.

## Track quality

Quality flags use one byte per location and are computed before display filters.

- **Outliers** checks all sources of a device together. It removes:
  - physically impossible jumps;
  - sharp detours with implausible acceleration;
  - speed spikes above the typical nearby speed plus the user's allowance.

  For an isolated fix between more precise sources, the speed-spike check also requires a position outside its own stated accuracy. A handover between sources alone is never treated as a spike.
- **GPS drift** adds two things, using the default allowance:
  - It removes short excursions away from a stable position and back.
  - It classifies each location's speed from up to four locations on each side, spread across the context window. Stationary speeds become 0 and uncertain ones become unknown; other speeds are left unchanged. This adds two bits per location.

## Journeys

Journeys connect retained locations across accuracy, measurement and outlier filters. Tracks break at:

- excluded hours
- device boundaries
- dateline crossings
- implausible travel
- gaps over six hours

Lines are simplified below one pixel at the current zoom. **Smooth** draws accuracy-aware cubic curves with bounded detail and falls back to straight lines for dense paths; it never changes measurements. The Points view draws at most 20,000 representative locations in view; counts remain exact.

## Maps

[MapLibre GL JS](https://maplibre.org/) 6.15.0, pinned from jsDelivr, draws every overlay. The Google and Yandex SDKs load only for their satellite and hybrid views. Azure, Esri, OpenStreetMap and OpenFreeMap need no extra renderer. OpenFreeMap is the default base map.

Provider keys in `js/map-config.mjs` are public browser keys. Restrict their APIs, origins and quotas in each provider's console, and keep provider attribution visible. Free allowances are not universal spending caps.

## Sample data

`scripts/create-sample.mjs` streams an export, trims it through the end of the given UTC date, then sorts, deduplicates and writes deterministic gzip. Version 2 stores E7 coordinate and time deltas, plus accuracy, explicit durations, altitude, speed and anonymised device and source metadata when present.

The public sample has 910,311 locations through 2020-04-01. Review what it discloses before changing its source or dates.

## Deployment

GitHub Pages publishes the `master` branch root, with `.nojekyll` and no build workflow. Keep the repository free of `CNAME`: the account site owns `kusaku.su`, and this project is served at `/location-history/`. All app URLs are relative.

Modules and styles are imported with `?v=` cache-busting versions. When a file changes, bump its version in every place that imports it, including `index.html`.
