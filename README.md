# Smart Health Monitor

A web dashboard for a **personalized, context-aware wearable health monitoring system** (Sem 3 EL).

A wearable (ESP32) measures heart rate, SpO₂, temperature, humidity and motion (falls), has an SOS button,
and gets its position from a **Neo-6M GPS** module. It uploads everything over Wi-Fi to **Blynk IoT** (server BLR1).
This dashboard reads Blynk every 2 seconds and shows live vitals, alerts, a live GPS map and charts.

## Run it

1. Copy `config.example.js` to `config.js`.
2. Open `config.js` and paste your Blynk Auth Token between the quotes.
3. Double-click `index.html` to open it in your browser.

Without a token the page runs in **demo mode** with made-up data.

`config.js` is listed in `.gitignore`, so your token is never pushed to GitHub.

## Files

| File | What it does |
|---|---|
| `index.html` | Page layout (overview, vital signs, location, charts, alert history, device pages) |
| `style.css` | Dark glass theme with ECG-style background |
| `app.js` | Reads/writes Blynk, colour-codes vitals, alerts, charts, alert history |
| `config.example.js` | Template for your private `config.js` |

## Blynk datastreams

| Pin | Data |
|---|---|
| V0 | Status (string) |
| V1 | Heart rate (bpm) |
| V2 | SpO₂ (%) |
| V3 | Temperature (°C) |
| V4 | Humidity (%) |
| V5 | Fall (0/1) |
| V6 | SOS (0/1) |
| V10 | Help dispatched (0/1) |
| V11 | GPS latitude (decimal degrees, e.g. `12.923700`) |
| V12 | GPS longitude (decimal degrees, e.g. `77.498700`) |
| V13 | GPS satellites in view (number, optional) |

When the Neo-6M has no fix, send `0` for both latitude and longitude (or nothing) and the dashboard shows "No GPS fix".
In the firmware (TinyGPS++), send `gps.location.lat()` / `gps.location.lng()` with 6 decimals and `gps.satellites.value()`.

The maps use OpenStreetMap tiles through [Leaflet](https://leafletjs.com/), so no API key is needed.
