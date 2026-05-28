# whoof

An **independent, unofficial, educational** BLE client for the WHOOP 4.0
strap. Reads heart rate, RR intervals, SpO₂, and skin temperature off the
band over Bluetooth Low Energy, stores everything locally in your browser,
and computes textbook **HRV, recovery, and strain** estimates on-device.

Built on top of open research from [`jogolden/whoomp`][whoomp] and
[`bWanShiTong/reverse-engineering-whoop`][bwan].

> [!IMPORTANT]
> **Disclaimer.** This is an unofficial, third-party project provided for
> **educational, research, and personal interoperability purposes only**.
> It is **not affiliated with, endorsed by, or sponsored by WHOOP, Inc.**
> "WHOOP" and "WHOOP 4.0" are trademarks of WHOOP, Inc.; references here
> are nominative and describe hardware compatibility only.
>
> The metrics surfaced by this software are **not clinically validated and
> are not medical advice**. Do not use for medical, clinical, diagnostic,
> or therapeutic purposes. The software is provided "as is" without
> warranty of any kind (MIT). **See [DISCLAIMER.md](DISCLAIMER.md) before
> using.**

> The WHOOP 4.0 device itself broadcasts raw sensor telemetry over standard
> BLE without a subscription gate at the wire layer. This project lets you
> read that telemetry from a strap you own — nothing more.

---

## Pick your install path

| Where you'll use it | Best path | Cost | Setup time |
|---|---|---|---|
| **iPhone — phone-only, never want a Mac in the loop** | **[docs/IPHONE_BLUEFY.md](docs/IPHONE_BLUEFY.md)** — Bluefy browser + Cloudflare Pages. Pair the strap directly from iPhone | Free forever, no developer account | ~20 min |
| **iPhone — happy to keep a Mac around as the hub** | [docs/IPHONE.md](docs/IPHONE.md) — install the PWA from Safari, pair on Mac, JSON export/import | Free, no developer account | 5 min |
| **Mac Chrome, day-to-day dev** | Read on below | Free | 30 sec |
| **iPhone — want a polished native-app feel and have Xcode** | See the [`ios-app` branch](../../tree/ios-app) — Capacitor wrap, free Apple-ID signing | Free but re-sign in Xcode every 7 days | 15 min |

---

## Quick start (Mac Chrome)

```bash
# Start the local server (serves web/ as http://localhost:8765/).
# Use --host 0.0.0.0 if you also want iPhone Health Auto Export to reach it.
./run.sh dash --host 0.0.0.0 --port 8765
```

Open **Chrome** (not Safari — Web Bluetooth only works in Chromium-family
browsers on Mac) at `http://localhost:8765/`. In the top-right panel:

1. Tap your Whoop band to wake it (it won't advertise while charging).
2. Click **Connect Whoop** — Chrome shows a device picker.
3. Select your band.

On every connect, whoof automatically:

- Fetches the strap's identity, serial, and on-wrist state (`GET_HELLO`).
- Compares the strap's RTC to your system clock and re-syncs if drifted (`SET_CLOCK`).
- **Drains the strap's flash buffer** — every HR sample + RR interval recorded
  while your Mac was away (`SEND_HISTORICAL_DATA` → `HISTORICAL_DATA_RESULT` ACK loop).
- Starts realtime streaming.

If you wear the strap on a workout without your Mac nearby, the data lands
in IndexedDB the moment you walk back in range. You can also tap **Sync from
strap now** to trigger another backfill manually.

The small dots in the panel show live state:

- 🟢 **Wrist** — strap is on your arm (from `WRIST_ON`/`WRIST_OFF` events)
- ⚡ **Charge** — strap is on the charger
- 🟢 **Clock** — strap RTC is in sync (🔴 = `RTC_LOST` fired, re-syncing)

### Want to see the dashboard before connecting?

The first time you open the dashboard with an empty IndexedDB, 14 days of
synthetic data are seeded automatically so the rings and charts aren't blank.
Real data from your strap accumulates alongside it; once you have a week of
real recordings the demo data is hard to notice. Export → Import (the buttons
in the panel) gives you a full JSON backup if you want a clean slate.

## Set your weight (for accurate calorie estimates)

Four ways, pick whichever fits your setup:

| Path | Button | Friction | Needs |
|---|---|---|---|
| **📱 iPhone Shortcut** | "📱 iPhone" | One-tap pull | Install `WhoopPullWeight` shortcut (see [docs/SHORTCUT.md](docs/SHORTCUT.md)) |
| **Health Auto Export** | "Setup…" → instructions | Set-and-forget | $1.99/mo HAE app + LAN access |
| **⚖️ Bluetooth scale** | "⚖️ Scale" | Tap, step on scale | A standards-compliant BT scale (SIG `0x181D`) |
| **✎ Manual entry** | "✎" | Always works | Nothing |

The Bluetooth scale path uses the standard Weight Scale Service (0x181D)
directly from Web Bluetooth — no app, no cloud, no iPhone. Compatible scales:
Beurer BF600 series, A&D UC-352BLE, some Withings/Nokia BPM models. Proprietary
scales (Renpho, Eufy, Xiaomi) don't expose 0x181D — use the iPhone path or
manual entry instead.

## Apple Health bridge (advanced)

The Python dashboard exposes `POST /api/health/ingest` accepting the
Health Auto Export JSON schema. Run with `--host 0.0.0.0` so the iPhone HAE
app can reach you on the LAN. Values land in `data/health-latest.json`,
which the browser polls every minute and merges into `profile.weight_kg`.

See [docs/SHORTCUT.md](docs/SHORTCUT.md) for the on-demand Apple Shortcut
that round-trips through `shortcuts://x-callback-url`.

## Features

### Analysis & coaching
- **Activity journal with tag correlation** — log up to 11 lifestyle tags
  (alcohol, stress, hardworkout, caffeine, meditation, cold, nap, …). After
  accumulating 2+ tagged/untagged days per tag, the app automatically computes
  a Cohen's d effect size and surfaces insights like *"Alcohol strongly lowers
  next-day recovery −20pts (−28%)(n=4)"*. Unlike the official app, you own
  this analysis and the underlying data.
- **Daily training plan** — rest / active / train / push recommendation driven
  by today's recovery score, 7-day strain load, and accumulated sleep debt.
  Includes the day-specific rationale (actual numbers) alongside the zone advice.
- **Health insights engine** — 12 generators watching HRV trend, RHR trend,
  sleep debt, sleep consistency, recovery streaks, strain/recovery balance,
  skin temp deviation, respiratory rate drift, sleep duration trend, SpO₂
  anomaly (< 95% / < 93%), sleep performance (< 70% / < 55%), and
  **Acute:Chronic Workload Ratio** (ACWR) — flags training spikes above 1.5×
  or detraining below 0.6× the chronic baseline, reducing injury risk.
- **Weekly summary with week-over-week comparison** — emoji-formatted 7-day
  recap in the Trends tab. When prior-week data exists, ✅/⚠️ delta lines
  show how recovery, HRV, resting HR, and sleep changed vs the previous 7
  days. Top-3 personalised tag insights are appended automatically.
- **Switchable metric heatmap calendar** — the 30-day calendar in the Trends
  tab now has a metric picker (Recovery / Sleep performance / Strain / HRV).
  HRV uses percentile-relative colouring to account for individual variation.
- **Poincaré plot** — SD1/SD2 scatter from last night's RR intervals, rendered
  in the Recovery tab. Tells you at a glance whether short-term or long-term
  HRV is dominating.
- **Recovery coach + strain target** — a one-line recommendation below the
  recovery ring ("Ready for high intensity · Target strain 14–18") guides
  training intensity without tab-switching. The same target also appears in
  the Strain tab next to the cumulative score.
- **HRV, RHR, and skin temp baselines** — Recovery Components card shows
  today's RMSSD, resting HR, and skin temperature each compared to their
  14-day rolling baseline with colour-coded deltas. The RMSSD number is the
  one Whoop shows only to paying subscribers.
- **Recovery calendar heatmap** — 30-day grid in the Trends tab coloured
  green/yellow/red by recovery score. Today's cell is highlighted. **Click
  any cell to jump straight to the Recovery tab for that day.**
- **Historical date navigation** — ‹ › buttons in Recovery, Sleep, and Strain
  tabs let you browse any past day in your data without leaving the app.
- **Workout labels** — click the "✎ label" affordance on any detected workout
  to add or rename it inline (e.g., "Running", "Cycling"). Labels are stored
  in IndexedDB and included in the Workouts CSV export.
- **Journal backfill & delete** — a date picker (defaults to today) lets you
  log tags for past days you forgot to annotate; a × button on each history
  row lets you delete individual entries.
- **Sleep trend charts** — the Sleep tab now shows a 30-day stacked bar chart
  (Deep / REM / Light duration) and a 30-day respiratory rate line chart,
  mirroring the HRV/RHR/skin-temp trend charts in the Recovery tab.
- **Personal records** — the Trends tab shows all-time bests for HRV, lowest
  RHR, peak recovery, longest sleep, peak strain, and best sleep performance,
  each with the date it was achieved.

### Data & export
- **IndexedDB persistence** — samples, daily_metrics, journal, captures,
  workouts, sleep_stages, and profile — all local, no server.
- **CSV export** — separate buttons for raw samples, daily metrics (includes
  `hrv_baseline_ms`), journal entries, and detected workouts (includes label).
  JSON export/import for full backup/restore.
- **Progressive Web App** — installable, cache-first for assets, offline-capable.
- **Push notifications** — opt-in for backfill complete, low recovery, low
  battery, and HR anomaly alerts.

### Hardware & connectivity
- **Generic HR Profile toggle** — Diagnostics → "HR profile" turns on the
  standard BLE HR service (0x180D) so Strava / Zwift / Peloton / Apple
  Watch companions can pair with the strap as a regular HR monitor.
- **Smart alarm** — set a wake time; the strap vibrates even if your phone
  is in the other room. Set / Off / Test from the **Wake Alarm card** on
  the Overview tab.
- **Bluetooth scale** — pairs directly with any standard Weight Scale Service
  (0x181D) scale (Beurer, A&D, some Withings). No app, no cloud.
- **Apple Health weight sync** — poll via iPhone Shortcut or Health Auto Export.
- **Raw packet capture** — records every framed packet to NDJSON, useful for
  bytes 18+ reverse-engineering research.
- **Diagnostics drawer** — Hello / Battery / Clock / Data Range / Haptic /
  Raw IMU / Extended Battery / HR Profile.
- **Console log drawer** — last 30 lines of firmware printf output.
- **Multi-tab guard** — refuses to connect if another tab is already holding
  the GATT connection.

---

## On iPhone (Bluefy)

Web Bluetooth is not available in Mobile Safari. Use
[**Bluefy**](https://apps.apple.com/app/bluefy-web-ble-browser/id1492822055)
($0.99 one-time) — it's a WebKit browser with a proper Web Bluetooth
implementation via CoreBluetooth.

1. Serve the dashboard from your Mac (`./run.sh dash`).
2. Make sure your iPhone and Mac are on the same Wi-Fi network.
3. Open Bluefy on iPhone and navigate to `http://<your-Mac-IP>:8765/`.
4. Tap **Connect Whoop** — Bluefy will ask for Bluetooth permission.

The Whoop band pairs directly to your iPhone over BLE; your Mac is only
serving the HTML/JS files.

---

## Where's the data?

Everything lives in **IndexedDB** inside your browser — no server-side
storage. To inspect it:

*Chrome → DevTools (F12) → Application → Storage → IndexedDB → `whoof`*

You'll find these object stores:

| Store | Contents |
| ----- | -------- |
| `samples` | every ~30-second sensor packet (HR/RR/SpO2/temp/accel) |
| `sessions` | start/stop of each recording session |
| `device_events` | connect/disconnect/battery/error log |
| `daily_metrics` | one row per calendar day with HRV/recovery/strain/sleep |
| `profile` | age, sex, weight (used for calorie estimates) |
| `sleep_stages` | nightly sleep stage breakdown |
| `workouts` | detected workout windows with zone time and calories |
| `journal` | daily activity entries with tags (for correlation analysis) |
| `captures` | raw NDJSON packet dumps for protocol research |

Use the **Export** button to download a full JSON backup. **Import** restores
it on any machine (or after clearing browser storage).

---

## What you get

| Metric              | Source                       | How it's computed                                   |
| ------------------- | ---------------------------- | --------------------------------------------------- |
| Heart rate (BPM)    | Live BLE packet bytes 1–2    | direct decode                                       |
| RR interval (ms)    | Live BLE packet bytes 3–4    | direct decode                                       |
| SpO2 (%)            | Live BLE packet byte 5       | direct decode                                       |
| Skin temperature    | Live BLE packet byte 6       | `byte − 25 °C` offset                               |
| **HRV (RMSSD)**     | RR intervals during 02–06 local | √(mean of squared successive RR diffs), Malik filter |
| **Recovery score**  | Today's RMSSD vs 14-day baseline | z-score → 0-100 scale                            |
| **Strain score**    | HR throughout the day        | Borg-like load: `21·(1 − e^(−load/100))`            |
| Resting HR          | 5th percentile of daily HR   | order-stat                                          |

Whoop's actual algorithms are closed-source — these reproduce the *spirit*
of the metrics using textbook HRV and training-load formulas.

---

## The strap as offline buffer

Whoop 4.0 has internal flash that records 1 Hz HR + RR intervals continuously,
even when no host is connected. The official Whoop app drains that buffer over
BLE on next connection — and so does whoof.

The wire protocol is fully reverse-engineered: see
[`docs/PROTOCOL.md`](docs/PROTOCOL.md) for the complete reference (73 commands,
100+ events, frame format, the historical-dump state machine).

In practice for you:

- **Wear the strap on a workout, leave the Mac at home.** Strap records to flash.
- **Walk back in range, page open.** WhoopClient sees `gattserverdisconnected`
  resolve, runs `_postConnectFlow()` → backfill kicks in → samples arrive on
  the data channel → IndexedDB grows. The progress bar shows samples received.
- **Reach the end of buffer.** Strap sends `HISTORY_COMPLETE`, realtime
  streaming resumes.

If flash starts filling up between connects (long absence, charger plugged in),
the strap emits `HIGH_FREQ_SYNC_PROMPT` on its event channel and the client
kicks off another sync automatically.

## How the protocol works

The Whoop 4.0 advertises a single custom BLE GATT service
`61080000-8d6d-82b8-614a-1c8cb0f8dcc6` with five characteristics:

| UUID  | Direction | Purpose                                  |
| ----- | --------- | ---------------------------------------- |
| ...01 | write     | commands to strap                        |
| ...02 | notify    | command responses                        |
| ...03 | notify    | async device events                      |
| ...04 | notify    | 96-byte real-time sensor packets         |
| ...05 | notify    | diagnostic / memfault reports            |

Each command frame is `[0xAA][cmd][len:LE16][payload][CRC32:LE]`. The
CRC uses polynomial `0x04C11DB7`, init `0xFFFFFFFF`, reflect in/out, and
final XOR `0xF43F44AC` — see [`web/js/ble/crc.js`](web/js/ble/crc.js).

Bytes 0–19 of each 96-byte real-time packet are decoded. Bytes 20–91 are
not yet known publicly — likely PPG waveform samples, gyroscope, and
respiration estimates. They are stored raw so the schema doesn't need to
change once they're decoded.

---

## Troubleshooting

**"Connect Whoop" does nothing** — Web Bluetooth requires a secure context
(HTTPS or localhost). Serving from `./run.sh dash` at `localhost:8765` is
fine; a raw `file://` URL is not.

**Device picker shows no Whoop** — tap the band to wake it (LEDs will
blink). If it still doesn't show, check that Chrome has Bluetooth permission
in *System Settings → Privacy & Security → Bluetooth*.

**HR drops and reconnects** — BLE on macOS drops occasionally. The client
auto-reconnects with exponential backoff; samples already written to
IndexedDB are safe.

**HRV / recovery showing `—`** — you need at least one full overnight with
the band on your wrist. Metrics are computed automatically after data is
recorded; check back the next day.

**iPhone: "Web Bluetooth is not supported"** — use
[Bluefy](https://apps.apple.com/app/bluefy-web-ble-browser/id1492822055)
instead of Safari.

---

## Project layout

```
whoof/
├── web/
│   ├── index.html          dashboard UI (Chart.js, v0.2 charts + BLE panel)
│   ├── app.js              v0.2 dashboard render (reads from api-shim)
│   ├── styles.css
│   ├── vendor/
│   │   ├── chart.umd.min.js   Chart.js 4.4.0 (vendored)
│   │   └── idb.min.js         idb 8.0.0 IndexedDB wrapper
│   └── js/
│       ├── app-mvp.js      BLE connect/disconnect + live HR display
│       ├── ble/
│       │   ├── uuids.js    GATT service/characteristic UUIDs
│       │   ├── crc.js      Whoop custom CRC-32
│       │   ├── protocol.js buildCommand / parseResponseHeader
│       │   ├── parser.js   parseRealtimePacket (96-byte → typed fields)
│       │   └── client.js   WhoopClient (BLE lifecycle, auto-reconnect)
│       ├── data/
│       │   ├── schema.js   IndexedDB store definitions
│       │   ├── db.js       openDb()
│       │   ├── queries.js  typed read/write helpers for every store
│       │   ├── api-shim.js intercepts /api/* fetch calls → IndexedDB
│       │   └── export.js   buildExportPayload / exportAllToJson / importAllFromJson
│       ├── metrics/
│       │   ├── hrv.js      rmssd, sdnn, pnn50
│       │   ├── strain.js   strainScore
│       │   ├── zones.js    HR zones, calories
│       │   ├── sleep.js    sleep window detection, stage classification
│       │   ├── workouts.js detectWorkouts
│       │   ├── recovery.js recoveryScore, recoveryBreakdown
│       │   ├── rollup.js   rollupDay / rollupMissing / recomputeRecent
│       │   ├── insights.js 9-generator health insights engine
│       │   ├── plan.js     dailyPlan (rest/active/train/push zones)
│       │   ├── weekly.js   weeklySummary
│       │   └── correlate.js analyseTagCorrelations / tagInsights (Cohen's d)
│       ├── util/
│       │   ├── events.js   createEmitter (on / emit)
│       │   ├── time.js     isoUtcNow, localDateKey, startOfLocalDay
│       │   ├── multitab.js single-tab BLE guard
│       │   └── notify.js   push notifications (backfill/recovery/battery/HR)
│       └── dev/
│           ├── seed.js     seedDemoData (14 days of synthetic data + journal)
│           ├── capture.js  raw NDJSON packet recorder
│           └── analyzer.js capture file analysis tool
├── whoof/              Python package (HTTP server that serves web/)
│   └── dashboard.py        stdlib http.server → serves web/
├── tests/
│   ├── js/                 Vitest unit tests (306 tests, ~2.5 s)
│   └── *.py                Python metric tests (kept for reference)
└── run.sh                  `./run.sh dash` starts the server
```

---

## Credits

* [jogolden/whoomp][whoomp] — original Whoop 4.0 reverse engineering, web demo
* [bWanShiTong/reverse-engineering-whoop][bwan] — protocol writeup, CRC parameters
* [christianmeurer/whoop-reader][whoop-reader] — Python BLE driver (reference for BLE layer)
* [jacc/whoop-re][jacc] — REST API research

[whoop-reader]: https://github.com/christianmeurer/whoop-reader
[whoomp]:       https://github.com/jogolden/whoomp
[bwan]:         https://github.com/bWanShiTong/reverse-engineering-whoop
[jacc]:         https://github.com/jacc/whoop-re

---

## Mirrors

This project is published on two networks so it survives any one host
going away:

- **GitHub** — <https://github.com/madhursatija/whoof> (primary; issues, PRs)
- **Radicle** — peer-to-peer, no central account needed:
  `rad:z4AzVRT4Z3HmHgwLWpZCY9Vy4wLn9`
  ([web view](https://radicle.network/nodes/iris.radicle.network/rad:z4AzVRT4Z3HmHgwLWpZCY9Vy4wLn9))

Clone via Radicle (install [`rad`](https://radicle.xyz) first):

```sh
rad clone rad:z4AzVRT4Z3HmHgwLWpZCY9Vy4wLn9
```

Both mirrors carry the same `main` and `ios-app` branches.

## License & legal

MIT, like everything upstream. See [LICENSE](LICENSE) for the warranty
disclaimer and [DISCLAIMER.md](DISCLAIMER.md) for the trademark notice,
non-affiliation statement, and acceptable-use terms — **read it before
using or redistributing**.

WHOOP® and WHOOP 4.0 are trademarks of WHOOP, Inc. This project is not
affiliated with, endorsed by, or sponsored by WHOOP, Inc.
