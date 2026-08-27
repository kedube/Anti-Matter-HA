<p align="center">
  <img src="https://raw.githubusercontent.com/Cl3tus/Anti-Matter-HA/main/anti_matter/banner.png" alt="Anti-Matter" width="100%">
</p>

# Anti-Matter

[![GitHub release](https://img.shields.io/badge/version-2.0.5-blue)](https://github.com/Cl3tus/Anti-Matter-HA)
[![Project Stage](https://img.shields.io/badge/project%20stage-experimental-yellow.svg)](https://github.com/Cl3tus/Anti-Matter-HA)
[![Maintained](https://img.shields.io/badge/maintained-yes-brightgreen.svg)](https://github.com/Cl3tus/Anti-Matter-HA/commits/main)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/Cl3tus/Anti-Matter-HA/blob/main/LICENSE)

![Supports aarch64](https://img.shields.io/badge/aarch64-yes-green.svg)
![Supports amd64](https://img.shields.io/badge/amd64-yes-green.svg)
![Supports arm64](https://img.shields.io/badge/arm64-yes-green.svg)

Store, organize and back up your **Matter**, **Z-Wave**, **Zigbee**, **HomeKit** and
**Tuya** pairing codes and QR payloads — right inside Home Assistant.

Anti-Matter keeps a tidy vault of every commissioning code you own, renders a clean
scannable QR card for each one, and stores everything in a local folder that is reachable
over SAMBA and included in Home Assistant's own backups. No cloud, no account.

[![Open your Home Assistant instance and show the add add-on repository dialog with a specific repository URL pre-filled.](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2FCl3tus%2FHA-Addons)

## Features

- **+ Code** — add a code manually or by scanning, with an inline **+** to create a new
  category without leaving the form. Pick from **Matter, Z-Wave, Zigbee, HomeKit, Tuya or
  Other**; Matter/HomeKit/Z-Wave are natively decoded, Zigbee/Tuya get their own branded
  card. **Other** covers anything else (Wyze, Zigbee 3.0, …) — a free-text standard name
  plus a manual code/QR payload, stored as-is.
- **Zoom** — the card grid has its own zoom control (bottom-left status bar): −/+ buttons,
  a percentage that opens a 50–150% preset dropdown, a reset button, or Ctrl+scroll/pinch.
- **Scan** — webcam QR scanning (works on mobile, with pinch-to-zoom and tap-to-focus
  where the device supports it), with a photo-upload fallback. Fully offline: the scanner
  fallback library is bundled, nothing is loaded from a CDN. An unrecognized QR is captured
  as an **Other** code instead of being rejected.
- **Rich fields** — name, device type (suggest-dropdown), **vendor**, **product name**,
  **area**, **description**, category, connectivity (WiFi/Thread/Zigbee/Bluetooth/Z-Wave),
  notes, plus the protocol code + QR payload.
- **Area suggestions** — the Area field suggests your Home Assistant areas, but you can
  type anything.
- **Matter payload decode** — vendor/product ID, passcode, discriminator and more, with
  official CSA DCL vendor/product names and links where available; auto-fills device
  vendor/product (manual edits always win).
- **Home Assistant link** — a searchable device field (with an auto-match suggestion) links
  a code to a device and jumps to its page in a new tab. Double-click any code (grid card or
  table row) for a quick-view with a large QR; right-click to edit instead.
- **Duplicate detection** — matching QR payload or manual code is caught on save *and* on
  restoring from Trash, with a Cancel/Merge choice.
- **Categories** — colour- and icon-tagged, in the sidebar.
- **Trash** — deleted codes/categories go to Trash (its own file, see Storage below) until
  restored or permanently deleted.
- **Backup now** — writes a timestamped JSON copy into the add-on config folder; old copies
  are pruned to your configured count.
- **Export / Import** — move your vault between installs as a single JSON file.
- **Download to Media** — downloading a code's image also saves a copy under Home
  Assistant's Media folder.
- **NL / EN / Auto** language and **Light / Dark / Auto** theme that follows Home Assistant.

## Storage

Everything lives in the add-on config folder, mounted at `/config` inside the add-on and
reachable on your network at:

```
\\<HA-IP>\app_configs\<slug>_anti_matter\
    anti_matter.json          # the vault
    anti-matter-bin.json      # trashed codes/categories, until restored or purged
    backups/                  # timestamped backups
```

Because it sits in the add-on config folder, it is automatically included in Home Assistant
backups. Downloaded label/QR images are also saved under Home Assistant's Media folder, in
`media/anti_matter/`, if Media access is available.

## Configuration

| Option | Values | Meaning |
| --- | --- | --- |
| Language | Auto / Nederlands / English | UI language. Auto follows HA, then the browser. |
| Theme | Auto / Light / Dark | Auto follows HA's light/dark setting. |
| Backups to keep | 1–100 | How many timestamped backup copies to retain. |

## Screenshots

<p align="center">
  <img src="https://raw.githubusercontent.com/Cl3tus/Anti-Matter-HA/main/docs/screenshots/en/anti-matter-dark-light-tear-en.png" alt="Anti-Matter — Dark and Light theme" width="90%">
</p>

More in the [wiki's Screenshots page](https://github.com/Cl3tus/Anti-Matter-HA/wiki/Screenshots)
(English + Dutch).

## Documentation

Full manual, in English and Dutch: [the wiki](https://github.com/Cl3tus/Anti-Matter-HA/wiki).

## Credits

Anti-Matter is a rewrite of [Rematters](https://github.com/Rematters/Rematters-HA) by
Jesse Hulswit ([JesseFPV](https://rematters.casa/)), reworked into a cloud-free, local-only
add-on. Full credit to Jesse for the original Rematters add-on and its design.
