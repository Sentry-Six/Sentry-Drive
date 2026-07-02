# Sentry Drive
Sentry Drive is a desktop app for visualizing and analyzing your drive history. Meant to be used in conjunction with Sentry USB or TeslaUSB, you can track your self-driving stats, distance driven, drives made, etc. all on your computer! Simply point it to your TeslaCam folder and start processing. See every drive - where you used Full Self Driving, every disengagement, duration, average and max speed, and more!

<img width="2560" height="1369" alt="electron_HWfDb2Px9G" src="https://github.com/user-attachments/assets/ed8af61f-33b4-4b83-82c3-413977013d15" />

## How It Works
Sentry Drive works by taking advantage of the SEI data embedded in TeslaCam files! By reading that data, we extract and process that data so that your drives are overlayed on top of a map. The data shares information such as GPS data, self-driving state, speed, pedal presses, and more. Your drive data is processed and stored locally on your computer and is never uploaded to us. A few optional, clearly-labeled features do contact third-party services when you use them — see [Privacy & Data](#privacy--data) below.

## Features
- **Visualize your Recent Drives**
<br> With TeslaUSB, Sentry USB, and Tesla's 2025 Holiday Update (2025.44.25 or newer), you can save and visualize your drives. Every single one.
- **Fix Broken Drives (ALPHA)**
<br> Attempts to bridge missing data points in a drive by generating the missing data using Open Street Map's route API.
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
Running Sentry USB? You can import your drive data! Simply locate your drives-data.json and load it! If it's in your TeslaCam folder, it'll automatically locate and load it for you.

## Platforms
This application is available for Windows and Mac. [Check the releases tab](https://github.com/Sentry-Six/Sentry-Drive/releases) for the latest version.

Because this program is unsigned, you will need to follow this step after you run the .dmg for the first time:
<br> System Settings ? Privacy & Security ? Open Anyway

## Privacy & Data
Sentry Drive is local-first: your TeslaCam footage, SEI telemetry, GPS data, tags, and analytics live only on your computer and are never uploaded to us. The following features do communicate with third parties, and only as described:

- **Map tiles** — Drives are drawn on a map using tiles from third-party providers (OpenStreetMap/CARTO and Google Maps, depending on the map style you pick). Because the tiles requested depend on where your drives took place, your approximate drive locations are shared with the selected tile provider as part of normal map rendering.
- **Fix Broken Drives (OSRM)** — When you use this feature, drive coordinates are sent to the public [OSRM](https://project-osrm.org/) (Open Source Routing Machine) routing service to reconstruct missing route segments.
- **3rd Party Import** — When you import from Tessie or Teslascope, the app connects to the respective service using an API token you provide to fetch your drive history. That data is governed by your relationship with [Tessie](https://tessie.com/privacy) and [Teslascope](https://teslascope.com/legalese/privacy).
- **Updates** — The app checks GitHub Releases for new versions. It does **not** send any hashed device identifier or telemetry on update checks.

This is a summary; the full Sentry-Six Privacy Policy is at [sentry-six.com/privacy](https://sentry-six.com/privacy).

## Credits
Originally created by [Scottmg1](https://github.com/Scottmg1), derived from his [Sentry USB project](https://github.com/Scottmg1/Sentry-USB). UI made with the help of Claude.
