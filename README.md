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

## About

A local, cloud-free vault for your **Matter**, **HomeKit** and **Z-Wave** pairing codes and
QR payloads, running inside Home Assistant. No account, no cloud sync, no outbound
connections — everything lives in the add-on's own config folder, reachable over SAMBA and
included in Home Assistant's own backups.

## Install

[![Open your Home Assistant instance and show the add add-on repository dialog with a specific repository URL pre-filled.](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2FCl3tus%2FHA-Addons)

1. In Home Assistant go to **Settings → Add-ons → Add-on Store → ⋮ → Repositories**.
2. Add this repository URL:
   ```
   https://github.com/Cl3tus/HA-Addons
   ```
3. Install the **Anti-Matter** add-on and start it. Open it from the sidebar (it runs through
   Home Assistant ingress).

The add-on itself lives in [`anti_matter/`](anti_matter/) — see its
[README](anti_matter/README.md) and [DOCS](anti_matter/DOCS.md), or the
[wiki](https://github.com/Cl3tus/Anti-Matter-HA/wiki) (English + Dutch) for the full manual.

## Highlights

- Add, scan and organize Matter / Z-Wave / Zigbee / HomeKit / Tuya pairing codes with
  branded, scannable QR cards (each protocol's own logo), or switch to a filterable
  spreadsheet-style table view.
- **Other** covers anything else not natively parsed (Wyze, Zigbee 3.0, …) — free-text
  standard name plus a manual code/QR payload, no parsing required; a scanned QR that
  matches none of the known protocols lands here automatically instead of being rejected.
- Vendor, product name, area (with Home Assistant area suggestions), device type,
  connectivity and category on every code — Matter payload decode auto-fills vendor/product
  from the official CSA DCL registry.
- Webcam scanning (mobile-friendly, with pinch-to-zoom and tap-to-focus) + photo upload,
  fully offline — nothing loads from a CDN.
- Duplicate detection on save and on restoring from Trash, with a Cancel/Merge choice.
- Link a code to a Home Assistant device (searchable, with auto-match) and jump to its page;
  double-click any code (grid card or table row) for a quick-view with a large QR, right-click
  to edit instead.
- Zoomable card grid (buttons, a 50–150% preset dropdown, or Ctrl+scroll/pinch).
- Local, SAMBA-reachable storage in the add-on config folder, included in HA backups; Trash
  is a separate file, and downloads also save to Home Assistant's Media folder.
- Backup schedule (hourly/daily/weekly/monthly) with automatic pruning, plus manual
  Backup now, Export and Import.
- NL / EN / Auto language and Light / Dark / Auto theme that follow Home Assistant.
- No cloud, no account, no outbound connections.

## Screenshots

<p align="center">
  <img src="https://raw.githubusercontent.com/Cl3tus/Anti-Matter-HA/main/docs/screenshots/en/anti-matter-dark-light-tear-en.png" alt="Anti-Matter — Dark and Light theme" width="90%">
</p>

More in the [wiki's Screenshots page](https://github.com/Cl3tus/Anti-Matter-HA/wiki/Screenshots)
(English + Dutch).

## Credits

Anti-Matter is a rewrite of [Rematters](https://github.com/Rematters/Rematters-HA) by
Jesse Hulswit ([JesseFPV](https://rematters.casa/)), reworked into a cloud-free, local-only
add-on. Full credit to Jesse for the original Rematters add-on and its design.

## License

MIT — see [LICENSE](LICENSE).
