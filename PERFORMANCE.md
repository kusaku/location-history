# Performance verification

## Final optimization pass, 2026-10-23

Compared against `a0be2e5` using Node 26.11.1 and the same seven-case benchmark described below. The three local historical files contain 3,306,412 valid observations; all files remained local. All seven sample cases and all seven large-file cases retained identical statistics, feature counts, and active-geometry hashes. A separate seeded comparison matched complete results for 180 combinations of visualization, metric, viewport, and filters, including negative timestamps and wrapped longitudes.

| Repeated query, large dataset | Before | After | Speedup |
| --- | ---: | ---: | ---: |
| World heat | 524.53 ms | 225.33 ms | 2.3× |
| Europe heat pan | 378.70 ms | 223.05 ms | 1.7× |
| City heat pan | 324.41 ms | 181.40 ms | 1.8× |
| Day filter | 0.22 ms | 0.21 ms | effectively unchanged |
| Hour/accuracy hexagons | 226.17 ms | 159.49 ms | 1.4× |
| Points | 74.41 ms | 63.78 ms | 1.2× |
| Journeys | 102.50 ms | 55.90 ms | 1.8× |

The first world heat query decreased from 1,220 to 916 ms. Import/sort was comparable (15.94 vs 15.51 s), with index creation at 136 vs 124 ms. Peak RSS across the sequential run decreased from 1,604 to 1,179 MiB, about 26%; this includes all live geometry and garbage collection and is not a guaranteed browser memory reduction. These are worker-computation measurements, not browser frame-rate or network timings.

Changes:

- Numeric column/row bin lookup avoids constructing millions of string keys; insertion order preserves exact geometry output.
- Chronological UTC-day counters replace per-bin and per-selection sets. Projection indexing avoids a temporary coordinate array per observation. Full-day filters skip hour extraction, and broken track intervals skip unused distance calculations.
- Journey viewport queries count visible records without allocating or sorting a visible-index array.
- Slider changes issue only their affected map-style setters: opacity/intensity use four instead of sixteen, and radius uses two. Mode switching and fresh styles retain correct state; native tests compare incremental and full paint results.
- Yandex SDK loading requests only directly used modules. Google stays on quarterly releases; MapLibre stays pinned to 6.15.0. No dependencies or build tooling were added.
- The variable-font request reduced the uncompressed Google Fonts stylesheet from 11,387 to 2,206 bytes for the tested Chromium user agent (26 to five font-face declarations, the same five unique font files). This is a CSS reduction, not a reduction in font downloads.
- Corrected OpenFreeMap Dark's missing `circle-11` sprite reference to the published `circle_11` icon, retaining town/city markers, and removed an unused CSS rule.

All **66 native tests** pass. Live browser checks for this pass are recorded after deployment.

## Earlier optimization pass

Measured locally on 2026-10-23 with Node 26.11.1, using baseline `4d0208644ecfaa964a8e519382be89693055942f` and the optimized code. No tools or dependencies were installed.

## Method

`node scripts/benchmark.mjs --revision 4d02086 [files...]` and `node scripts/benchmark.mjs [files...]` parse identical files and execute the same seven queries in the same order. Each case runs four times with slightly shifted viewport longitudes. The table uses the median of the final three pans, after the first query of that case. This measures local worker computation, excluding browser rendering, worker messaging, map tile latency, and file download. Cases share a dataset query, matching app use. It is not a cold-start benchmark for each case.

The large dataset contains **3,306,412 valid observations** from three local historical files totaling about 1.74 GB. All files were read locally; no private data was uploaded or added to the repository. Both versions skipped the same 52 invalid records, removed zero duplicates, and returned identical counts, visible counts, UTC days, distances, feature counts, and active-geometry SHA-256 hashes in all seven cases. The public 266,682-point sample also matched all seven cases. A separate seeded comparison matched complete statistics and active geometry for 108 combinations of mode, metric, viewport, and filters.

## Results on 3,306,412 observations

| Repeated query | Before | After | Speedup |
| --- | ---: | ---: | ---: |
| world heat | 1,401.32 ms | 571.61 ms | 2.5× |
| europe pan | 1,483.98 ms | 381.92 ms | 3.9× |
| city pan | 1,199.07 ms | 321.75 ms | 3.7× |
| day filter | 60.32 ms | 0.24 ms | 251.3× |
| hour accuracy hex | 1,217.51 ms | 226.65 ms | 5.4× |
| points | 1,440.71 ms | 66.21 ms | 21.8× |
| journeys | 1,972.88 ms | 66.75 ms | 29.6× |

Initial import/sort was effectively unchanged: 15.85 s before, 15.70 s after. The new index added 129 ms. The first world heatmap query dropped from 1,435 ms to 1,129 ms. Peak process RSS across the entire sequential benchmark was 1,789 MiB before and 1,366 MiB after (about 24% lower); this includes imports, live results, garbage collection, and final geometry hashing, not just the index. Memory measurements vary with garbage collection and cannot be treated as a device limit.

The index uses typed arrays (roughly 12 bytes per observation plus cell offsets); the current filter mask and selected index list add up to about 5 bytes per observation. Only the current filter/selection is cached. Large imports and first-time journey rendering still require substantial device memory. Heatmap queries over millions of visible observations still scan and aggregate those observations; this change does not promise a constant-time heatmap or a fixed browser frame rate.

## Changes verified

- Spatial candidate lookup plus exact viewport clipping; chronological ordering, wrapped longitudes, polar coordinates, quality filters, and inclusive date boundaries are preserved.
- Cached histogram, selection statistics, shortest-arc bounds, and simplified journey geometry. Points and Journeys skip unused heatmap bins.
- Acknowledged geometry versions avoid repeated worker transfers and MapLibre `setData` calls, including when an intermediate response is discarded. Paint-only controls no longer trigger filtering.
- Bounded GeoJSON batches and Blob parts avoid a whole-history feature array/string. Export filenames use the requested date snapshot; repeated clicks are disabled until completion. A local full-data export produced 505,141,685 bytes in 3.79 s and was streamed back through the importer with all 3,306,412 observations preserved.
- Transactional import replacement, failed-import recovery, exact duplicate merging, gzip, malformed semantic entries, and clear/reset remain covered by native tests.
- Consolidated CSS component rules, removal of unused variables/selectors, corrected disabled/hover/focus selectors, and larger compact timeline targets.

Run `node --test` for regression coverage. Browser verification is performed against the deployed project URL because this browser does not permit the local preview origin. Network/provider availability is separate from these local CPU measurements.

## Deployed browser checks

Verified at `https://kusaku.su/location-history/` after deployment:

- **46 native tests passed**, plus the 108-query baseline comparison and the two seven-case sample/large-history hash comparisons.
- No horizontal document overflow at **320, 390, 768, 1280, or 1600 px**. Statistics and timeline stay within the viewport. Compact period buttons are 36 px; range sliders have a 24 px hit area.
- All nine provider choices switch with visible attribution and no map error. Google and Yandex tiles were also visually checked after loading, on desktop/mobile. Browser error/warning logs were empty.
- Heatmap, Hexagons, Points, and Journeys render; journeys remain visible after panning. All three metrics and palettes work. Radius, intensity, and opacity labels update through keyboard controls.
- Day/back/forward, 30-day/year/all presets, advancing/pausing playback, custom dates, keyboard ranges, invalid-date restoration, and empty results work. An empty selection disables Fit without discarding the dataset.
- A browser download contained the expected **79 exact observations** from the selected day. Reimporting it alongside ten overlapping observations produced **79 observations and ten removed duplicates**. A subsequent malformed JSON import retained that history; Clear reset statistics and controls; the gzip sample then reloaded successfully.
- Guide export instructions expand on mobile without horizontal overflow; Escape closes the modal and restores a visible 2 px keyboard focus ring.

These checks exercise the main workflows, not every possible browser/device/provider failure. The real historical files were tested offline; production browser tests used the public sample and derived test fixtures.
