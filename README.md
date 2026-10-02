# Smart Health Monitor

A web dashboard for a **personalized, context-aware wearable health monitoring system** (Sem 3 EL).

A wearable (ESP32) measures heart rate, SpO₂, temperature, humidity and motion (falls), and has an SOS button.
Readings travel over **LoRa** to a base station, which uploads them to **Blynk IoT** (server BLR1).
This dashboard reads Blynk every 2 seconds and shows live vitals, alerts, zone and charts.

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
| V9 | Location zone (string, from LoRa RSSI) |
| V10 | Help dispatched (0/1) |
| V11 | LoRa signal (dBm) |
