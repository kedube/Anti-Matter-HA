# Screenshot tool

Reproducible README and wiki screenshots, `scan-demo.gif` and the brand images
(`anti_matter/banner.png`, `social-preview.png`) for Anti-Matter. Everything is captured from the
real add-on UI with Playwright, filled with a **fake demo vault**. No real pairing code, device
or person appears in any image.

## Run it

Requirements: Node 18+, Python 3.10+, Google Chrome (or Playwright's bundled Chromium) and
`ffmpeg` on `PATH` (fake camera clip, GIF, PNG palette fallback).

```sh
cd tools/screenshots
npm install                                   # Playwright only (uses your Chrome)
python3 -m venv .venv
.venv/bin/pip install -r ../../anti_matter/app/requirements.txt numpy
node capture.mjs                              # everything (about 2 minutes)
```

`capture.mjs` uses `.venv/bin/python` when it exists, otherwise `python3`; set `PYTHON=/path/to/python`
to choose another interpreter. It starts its own backend (`anti_matter/app/main.py`) on a free port,
with `STORAGE_DIR`, `ANTIMATTER_DATA`, `ANTIMATTER_OPTIONS` and `ANTIMATTER_MEDIA` pointing at a
temporary directory that is deleted afterwards (`KEEP_WORK=1` keeps it).

Useful options:

| Command | What it does |
| --- | --- |
| `node capture.mjs --list` | List the shot names and groups |
| `node capture.mjs --only readme` | One or more groups (`readme`, `legacy`, `brand`, `gif`) or shot names, comma separated |
| `node capture.mjs --skip gif` | Everything except some groups or shots |
| `node capture.mjs --no-optimize` | Skip the PNG optimizer (faster while iterating) |
| `BASE_URL=http://localhost:8099/ STORAGE_DIR=/path/to/storage node capture.mjs` | Capture a server you already run. With `STORAGE_DIR` the demo data is written into that server's storage first (it **replaces** the vault, trash and backup settings there, so only use a throwaway instance). Without `STORAGE_DIR` it captures whatever data the server holds |
| `PW_CHANNEL= node capture.mjs` | Use Playwright's bundled Chromium instead of Chrome (`npx playwright install chromium` first) |

Output:

- `docs/screenshots/*.png` and `scan-demo.gif`: the README set (English, no language suffix).
- `docs/screenshots/en/*-en.png` and `docs/screenshots/nl/*-nl.png`: the 24 files the upstream wiki embeds
  by name (see `docs/screenshots/README.md`). NL shots use `?lang=nl` and a Dutch copy of the demo vault.
- `anti_matter/banner.png` (1920×480, the 960×240 banner at 2×) and `social-preview.png` (1280×640).
  `icon.png` and `logo.png` are inputs only and are never changed.

## How it works

| File | Role |
| --- | --- |
| `capture.mjs` | Starts the backend, seeds the demo data, drives Chrome (1280×800 at 2×, phones 390 px wide at 3×) and writes every image. `node capture.mjs --list` shows the shots. |
| `seed_demo.py` | Writes `demo/` into a `STORAGE_DIR`: vault, trash (2 codes, 1 category), a weekly backup schedule. Shifts timestamps so the newest entry is a few hours old, and with `--locale nl` translates names, areas, notes and categories (`demo/nl.json`). `--rebuild` regenerates the demo JSON from the definitions in the script, using the add-on's own Matter and HomeKit encoders. |
| `demo/demo-vault.json`, `demo/demo-bin.json` | The fake vault and trash (11 codes: Matter, HomeKit, Z-Wave, Zigbee, Tuya, Wyze). |
| `demo/demo-ha.json` | Mock Home Assistant devices and areas, served for `/api/ha/devices` and `/api/ha/areas` through `page.route` (and `ha_available: true` in `/api/info`), so the HA-link shots work without Home Assistant. Four demo codes are linked; "Office smart plug" and "Hallway motion sensor" are unlinked on purpose so the "Suggested match" hint appears. |
| `demo/demo-dcl.json` | Recorded answers of the public Matter DCL for the demo vendor and product IDs, served for `/api/matter/vendor/*` and `/api/matter/model/*`. A capture run never calls the internet. |
| `make_fixtures.py` | Generates the fake webcam clip `.work/fixtures/cam-flow.y4m` (about 180 MB, gitignored, created on demand): a pan onto a Matter sticker, then a HomeKit sticker, then an empty desk, looping. A faint tint in one corner encodes the phase, so the scanner flow clicks at the right moment. Needs `numpy`, `Pillow`, `qrcode` and `ffmpeg`. |
| `templates/*.html` | Composites and brand images, drawn in HTML with the add-on's own fonts and design tokens: `hero`, `mobile` (drawn phone frames), `languages`, `tear` (dark/light split), `banner`, `social`. |
| `optimize_png.py` | Shrinks the PNGs: `pngquant` + `oxipng` when installed (`brew install pngquant oxipng`), otherwise lossless Pillow recompression, plus a 256-colour `ffmpeg` palette for opaque files still above 700 KB. |

The scanner shots run Chrome with `--use-fake-device-for-media-stream` and the generated clip, so they
show the real live-camera engine locking on. The camera device name is replaced with "Back Camera"
(Chrome would otherwise show the clip's file path). The HTTP fallback shot pretends the page came
from `http://homeassistant.local:8123` (proxied to the local backend) with `isSecureContext = false`.

## Demo data rules

Every code in `demo/` and in the fixture clip is made up: random Matter passcodes and discriminators,
invented HomeKit setup codes and IDs, fake Z-Wave DSKs, Zigbee install codes and Tuya/Wyze strings.
Vendor and product names are ordinary catalogue names, and the Matter vendor/product IDs match them so the
DCL readouts are consistent. Keep it that way: a real setup code is a live pairing secret, and these
images are public.
