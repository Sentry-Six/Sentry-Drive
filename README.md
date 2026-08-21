<h1 align="center">Sentry Drive</h1>

<p align="center">
  <strong>Your drives, visualized.</strong><br>
  Drive routes. FSD tracking. All local. Privacy-first.
</p>

<p align="center">
  <a href="https://github.com/Sentry-Six/Sentry-Drive/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/Sentry-Six/Sentry-Drive"></a>
  <a href="https://discord.gg/9QZEzVwdnt"><img alt="Discord" src="https://img.shields.io/badge/Discord-join-5865F2?logo=discord&logoColor=white"></a>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/License-MIT-yellow.svg"></a>
</p>

---

Sentry Drive by Sentry Six is a desktop app for visualizing and analyzing your drive history. Meant to be used in conjunction with Sentry USB or TeslaUSB, you can track your self-driving stats, distance driven, drives made, etc. all on your computer! Simply point it to your TeslaCam folder and start processing. See every drive - where you used Full Self Driving, every disengagement, duration, average and max speed, and more!

Sentry Drive is one of four free tools for Tesla owners from the [Sentry Six](https://sentry-six.com) project, alongside [Sentry Studio](https://github.com/Sentry-Six/Sentry-Six) (desktop TeslaCam viewer), [Sentry USB](https://github.com/Sentry-Six/Sentry-USB-Rusty) (Raspberry Pi smart dashcam drive), and [Sentry Connect](https://sentry-six.com/sentry-connect/) (iPhone companion app for Sentry USB). Not affiliated with Tesla, Inc. Unrelated to the Sentry (sentry.io) error-monitoring service.

<img width="2560" height="1369" alt="electron_HWfDb2Px9G" src="https://github.com/user-attachments/assets/ed8af61f-33b4-4b83-82c3-413977013d15" />

## How It Works
Sentry Drive works by taking advantage of the SEI data embedded in TeslaCam files! By reading that data, we extract and process that data so that your drives are overlayed on top of a map. The data shares information such as GPS data, self-driving state, speed, pedal presses, and more. Your drive data is processed and stored locally on your computer and is never uploaded to us. A few optional, clearly-labeled features do contact third-party services when you use them — see [Privacy & Data](#privacy--data) below.

## Features
- **Visualize your Recent Drives and**
<br> With TeslaUSB, Sentry USB, and Tesla's 2025 Holiday Update (2025.44.25 or newer), you can save and visualize your drives. Every single one.
- **[NEW] Visualize your Charging Stops**
<br> Using Sentry USB's BLE telemetry feature, you can track and see every charging stop you make - whether at home or at a Supercharger.
- **Check your drives (ALPHA)**
<br> Using Open Street Map's route API, attempt to fix drives that may be broken. You can also check for previous Summon driving.
<br> **Note:** _Feature is currently in ALPHA and may not work as expected. Bridged gaps will appear as manual._
- **Full Self Driving Analytics**
<br> Track your FSD usage - even with Hardware 3.
- **Drive Tagging**
<br> Add tags to your drives for your organization.
- **Drive Timelines**
<br> Observe each drive in detail at your own pace - up to 10x speed.
- **Import from 3rd Party Sources**
<br> Import your drives from Tessie or Teslascope for a more extensive drive history!
<br> **Note:** _Imported drives do not affect FSD score._

### Sentry USB-Compatible
Running Sentry USB? You can import your drive data! Simply locate your drives-data.json and load it! If it's in your TeslaCam folder, it'll automatically locate and load it for you. Any telemetry included in your drive-data.json is also loaded, such as location and state of charge!

## Platforms
This application is available for Windows, macOS, and Linux (AppImage and .deb). [Check the releases tab](https://github.com/Sentry-Six/Sentry-Drive/releases) for the latest version.

Because this program is unsigned, you will need to follow this step after you run the .dmg for the first time:
<br> System Settings -> Privacy & Security -> Open Anyway

## Privacy & Data
Sentry Drive is local-first: your TeslaCam footage, SEI telemetry, GPS data, tags, and analytics live only on your computer and are never uploaded to us. The following features do communicate with third parties, and only as described:

- **Map tiles** — Drives are drawn on a map using tiles from third-party providers (OpenStreetMap/CARTO and Google Maps, depending on the map style you pick). Because the tiles requested depend on where your drives took place, your approximate drive locations are shared with the selected tile provider as part of normal map rendering.
- **Reverse Geocoding** — Your departure and arrival locations are determined using GPS points from your drive data OR from your Tesla's own geocoding. Geocoding is determined via [Nominatim](nominatim.openstreetmap.org), OSM's geocoder.
- **Fix Broken Drives (OSRM)** — When you use this feature, drive coordinates are sent to the public [OSRM](https://project-osrm.org/) (Open Source Routing Machine) routing service to reconstruct missing route segments.
- **3rd Party Import** — When you import from Tessie or Teslascope, the app connects to the respective service using an API token you provide to fetch your drive history. That data is governed by your relationship with [Tessie](https://tessie.com/privacy) and [Teslascope](https://teslascope.com/legalese/privacy).
- **Updates** — The app checks GitHub Releases for new versions. It does **not** send any hashed device identifier or telemetry on update checks.

This is a summary; the full Sentry-Six Privacy Policy is at [sentry-six.com/privacy](https://sentry-six.com/privacy).

## Credits
Originally created by [Scottmg1](https://github.com/Scottmg1), derived from his [Sentry USB project](https://github.com/Sentry-Six/Sentry-USB-Rusty). UI made with the help of Claude.
