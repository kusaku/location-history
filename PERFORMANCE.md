# Performance verification

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
- Bounded GeoJSON batches and Blob parts avoid a whole-history feature array/string. Export filenames use the requested date snapshot; repeated clicks are disabled until completion.
- Transactional import replacement, failed-import recovery, exact duplicate merging, gzip, malformed semantic entries, and clear/reset remain covered by native tests.
- Consolidated CSS component rules, removal of unused variables/selectors, corrected disabled/hover/focus selectors, and larger compact timeline targets.

Run `node --test` for regression coverage. Browser verification is performed against the deployed project URL because this browser does not permit the local preview origin. Network/provider availability is separate from these local CPU measurements.
