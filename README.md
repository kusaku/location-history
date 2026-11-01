# Location History

Explore your Google Timeline location history in the browser: heatmaps, hexagon density, individual points and journeys, with date, measurement and track-quality filters. Your files are processed on your device and never uploaded.

**[Open the app](https://kusaku.su/location-history/)**, then choose **Load sample** to try it without your own data.

## Features

- **Four views:** Heatmap, Hexagons, Points and Journeys. Points and Journeys are coloured by time, speed or altitude; journeys can be drawn straight or smoothed.
- **Date window:** a histogram of your history, day to year windows, playback, and a UTC hour filter.
- **Filters:** accuracy, speed, altitude, device and recording source.
- **Track quality:** remove outliers, or also suppress stationary GPS drift.
- **Place history:** click a hexagon or draw an area for stays, recorded days, time spent, track length, and average/median speed. Explore activity as a calendar or table.
- **Large histories:** merge several exports, up to five million locations, without a server.
- **Base maps:** OpenFreeMap, OpenStreetMap, Esri, Azure Maps, Google Maps and Yandex Maps.

## Supported files

- Phone Timeline exports from Android and iOS
- Google Takeout Location History: `Records.json` and monthly semantic-history files
- Timestamped GeoJSON `Point` features
- `.gz` versions of any of the above (extract `.zip` archives first)

The in-app **Guide** explains how to export your Timeline and how each control works.

## Privacy

Imported files are read in a Web Worker and stay in browser memory until you choose **Clear** or reload the page. Only display preferences are saved, in local storage. Map providers receive tile requests for the area you view. The hosted site uses Google Analytics and Yandex Metrica; Yandex session replay hides the map and history controls.

## Run locally

There is no build step or package installation. You need a current browser with WebGL2 and module workers.

```sh
python3 -m http.server 8000
```

Then open <http://localhost:8000/>.

## Development

Run the tests:

```sh
node --test tests/*.test.mjs
```

Run the benchmark on synthetic data, a local export, or an older commit:

```sh
node tests/benchmark.mjs --synthetic 1000000
```

```sh
node tests/benchmark.mjs path/to/history.json
```

```sh
node tests/benchmark.mjs --revision HEAD~1
```

Regenerate the bundled sample:

```sh
node scripts/create-sample.mjs path/to/history.json --end 2020-04-01 --output data/sample-location-history.json.gz
```

[docs/how-it-works.md](docs/how-it-works.md) describes the import formats, calculations, track quality, map providers and deployment.

## License

[MIT](LICENSE)
