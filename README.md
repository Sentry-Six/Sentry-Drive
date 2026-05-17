# Sentry Drive
Sentry Drive is a desktop app for visualizing and analyzing your drive history. Meant to be used in conjunction with Sentry USB or TeslaUSB, you can track your self-driving stats, distance driven, drives made, etc. all on your computer! Simply point it to your TeslaCam folder and start processing. See every drive - where you used Full Self Driving, every disengagement, duration, average and max speed, and more!

<img width="1920" height="1005" alt="image" src="https://github.com/user-attachments/assets/cd95c638-fe3e-4ca4-9a6d-4d3940000eb0" />

## How It Works
Sentry Drive works by taking advantage of the SEI data embedded in TeslaCam files! By reading that data, we extract and process that data so that your drives are overlayed on top of a map. The data shares information such as GPS data, self-driving state, speed, pedal presses, and more. All data is handled locally and is not uploaded at any point.

## Features
- **Visualize your Recent Drives**
<br> With TeslaUSB, Sentry USB, and Tesla's 2026 Spring Update (2026.14), you can save and visualize your drives. Every single one.
- **Fix Broken Drives (ALPHA)**
<br> Attempts to bridge missing data points in a drive by generating the missing data using Open Street Map's route API.
<br> **Note:** _Feature is currently in ALPHA and may not work as expected. Bridged gaps will appear as manual._
- **Full Self Driving Analytics**
<br> Track your FSD usage - even with Hardware 3.
- **Drive Tagging**
<br> Add tags to your drives for your organization.
- **Drive Timelines**
<br> Observe each drive in detail at your own pace - up to 10x speed.
- **Tessie Import**
<br> Import your drives from Tessie for a more extensive drive history using the Tessie API!

### Sentry USB-Compatible
Running Sentry USB? You can import your drive data! Simply locate your drives-data.json and load it! If it's in your TeslaCam folder, it'll automatically locate and load it for you.

## Platforms
This application is available for Windows and Mac. [Check the releases tab](https://github.com/JeffFromTheIRS/Sentry-Drive/releases) for the latest version.

Because this program is unsigned, you will need to follow this step after you run the .dmg for the first time:
<br> System Settings ? Privacy & Security ? Open Anyway

## Credits
Originally created by [Scottmg1](https://github.com/Scottmg1), derived from his [Sentry USB project](https://github.com/Scottmg1/Sentry-USB). UI made with the help of Claude.
