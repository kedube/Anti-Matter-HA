# Changelog

Detailed per-commit history is in [git log](https://github.com/Cl3tus/Anti-Matter-HA/commits/main).
This file summarizes the notable changes by theme.

## 3.0.1 — moving a vault over from another install

- **Imported HomeKit codes are repaired right away.** An export or backup from 2.x can hold HomeKit pairing codes
  decoded with the old, wrong bit mask. 3.0.0 fixed those only on the next add-on start. Import now fixes them as the
  file comes in.
- **New guide: moving from another repository.** Installing Anti-Matter from a different repository (for example a
  fork instead of `Cl3tus/HA-Addons`) gives a separate add-on with an empty vault; your old vault stays in the old
  add-on's folder. The Documentation tab and the README now explain the two ways to bring it over: **Export** →
  **Import**, or copy the files over Samba to keep the Trash and backups too.

## 3.0.0 — redesign, new scanner, 24 languages

A complete rebuild of the interface and the scanner. Your vault, Trash, backups, schedule and options carry over
unchanged, so there is nothing to migrate. See *Upgrade notes* at the end of this entry.

### Redesign

- A new interface built from scratch, with three views: **Cards** (a live QR on every card), **Labels** (printable labels) and **Table** (sortable, every column). A summary strip shows the codes per protocol (tap to filter), how many are in use or spare, and how many are linked to Home Assistant.
- **Layouts for every width.** Wide screens get a sidebar with the categories, backup status, Trash, Backups and Import & export. Tablets get a **⋮ More** menu and a category chip row. Phones get a bottom dock with a big Scan button and bottom sheets you can swipe away.
- **The details sheet replaces the quick view.** It shows a large label, **Copy code / Present / Download / Invert**, the manual code and QR payload with copy buttons, device facts, and an always-visible decode with the CSA DCL or zwave-js names and links. Step through codes with ↑/↓ or K/J.
- **Present mode:** a full-screen label with the screen kept awake (where the browser supports it), Invert, previous/next and swipe. **Present all** cycles through the filtered codes.
- **Labels:** each protocol gets its own label with the official wordmark. **Flip** shows the decoded back (Matter IDs and passcode; Z-Wave security classes and the DSK with its PIN underlined). You can choose to show names and setup codes, and **Print** prints the labels only.
- **Editor:** a live label preview and decode as you type. Every protocol is validated (Matter check digit and QR match, HomeKit code against its URI, Z-Wave DSK groups and QR checksum). HomeKit **setup ID and accessory category** can now be set by hand. **Fill from the label** takes a scan or photo. The Home Assistant device picker suggests a match. **Save & scan next** saves and goes straight to the scanner, and closing with unsaved changes asks first.
- **Finding codes:** filter popovers with search, per-value counts and *(Empty)*, and a filter sheet on phones. Search now also covers the standard name, protocol, category names and the linked Home Assistant device.
- **Categories:** a **⋯** button next to each category for Edit and Delete, which also works on touch screens (iOS had no way to edit a category before). The editor offers 12 colour presets or a custom colour, and a searchable picker of more than 7,000 Material Design Icons.
- **Import & export:** a summary of the file before anything changes, then a choice of **Merge** (add what is new) or **Replace** (makes a safety backup first). The **Trash** has Codes and Categories tabs, per-row Restore, Merge and Delete forever, and **Empty bin**.
- **Feedback:** Move to Trash offers **Undo**. Confirmations appear only for destructive actions, and alerts are titled by what they are ("Heads up", "Something went wrong").
- **Every action works by mouse, touch and keyboard.** There is a full set of shortcuts, and `?` shows them. Right-click (or `Ctrl`-click on a Mac) is a shortcut to the same menus, never the only way in.
- **Display menu:** Auto / Light / Dark and **Invert QR codes**. Theme and language choices are now remembered per browser; before, they reset on reload.
- **QR codes are crisp vector SVGs**, snapped to whole pixels per module with the full quiet zone, so they scan reliably from the screen.
- **Download label** now gives the same PNG for every protocol (HomeKit and Z-Wave were SVG before), drawn in the browser. The same image is copied to Home Assistant's media folder.
- **New fonts and icons:** Manrope and JetBrains Mono, with Latin, Cyrillic and Greek, bundled. Interface icons now come from Lucide.

### Scanning

- **A new scanning engine.** It uses the browser's own QR detector where one exists (Chrome on Android, macOS and ChromeOS). Everywhere else it uses a bundled **zxing-wasm** decoder in a background worker. Live camera scanning now works on iPhone and iPad (Safari and the Home Assistant app), Firefox, and Chrome on Windows and Linux. Everything is bundled and works offline.
- **Camera controls:** a lock-on overlay that snaps to the code, the torch, hardware zoom (or a digital zoom that the decoder follows too), pinch, tap-to-focus and camera switching. Each control appears only where the device supports it.
- **The Home Assistant Companion app's native scanner** is used automatically inside the app, including batch scanning with native "Saved" / "Already in your vault" messages. It works over `http://`.
- **Photos:** decoding now makes several passes (grayscale and contrast, inverted, upscaled, tiled for large photos, then the native detector). Photos with **several codes** show a numbered picker. **Take photo** and **Choose image** are separate buttons, so phones can pick an existing screenshot again. You can **drag and drop** or **paste** an image anywhere, and there is a new **Paste text** mode.
- **Batch scanning:** **Save & scan next** saves each code at once and returns to the camera. A session tray has **Undo** on each code, and **Done** shows a summary with **Review**, which filters the vault to that session.
- **Duplicates are caught before anything is saved.** The result sheet says *Already in your vault* and offers **Open existing**. A duplicate is never saved twice.
- **On plain `http://`** a dedicated photo page explains why the live camera needs HTTPS and offers photo, drop, paste and the Home Assistant app.
- **Better recognition:**
  - A bare 40-digit Z-Wave DSK is now recognised.
  - Zigbee install-code QRs (the ZHA formats) map to the Zigbee preset, and Tuya / Smart Life links map to the Tuya preset.
  - `MT:` and `X-HM://` payloads are found inside surrounding or percent-encoded text.
  - Multi-device `MT:…*…` payloads are understood.
  - A bare 8-digit number is no longer silently filed as HomeKit with a made-up setup URI; you are asked to confirm.
  - HomeKit's forbidden codes (such as `12345678`) are not taken as HomeKit.
- **Name suggestions:** a new code is named from the CSA DCL, the zwave-js device database, or its HomeKit accessory type.
- **The camera is always released,** on every way of closing, with the torch switched off first. Closing the scanner during the permission prompt no longer leaves the camera running.

### Languages

- **24 languages:** English, Čeština, Dansk, Deutsch, Español, Français, Italiano, Magyar, Nederlands, Norsk bokmål, Polski, Português (Brasil), Português (Portugal), Suomi, Svenska, Türkçe, Русский, Українська, עברית, العربية, 日本語, 한국어, 简体中文 and 繁體中文. The language menu lists them by their own names and has a search field.
- Hebrew and Arabic get a **full right-to-left layout**. QR codes, setup codes and payloads stay left to right.
- **Auto** follows Home Assistant's language live, then the browser.
- Proper plural forms for every language, and dates and numbers formatted for the locale.
- The **Configuration tab** is translated into all 24 languages. The *Language* option lists every language; the existing values `Auto`, `English` and `Nederlands` stay valid.

### Fixes

- **HomeKit pairing codes:** setup URIs were decoded with a 31-bit mask instead of 27 bits. For any URI with non-zero flag bits, the stored 8 digits were wrong. This is fixed in the app and the server. On first start, 3.0 **repairs** saved HomeKit codes in the vault and in the Trash whose digits exactly match the old mistake; hand-typed codes are never touched.
- **Matter QR payloads** with extra TLV data (serial number and so on) or several `*`-joined devices are now parsed correctly and **stored verbatim**. Before, they were regenerated without that data, which gave a QR that no longer matched the label.
- **Duplicate rules** are the same in the app and on the server, and they now recognise:
  - 21-digit Matter manual codes
  - the same Matter device across its QR, its manual code and each `*` payload (same passcode and discriminator)
  - a HomeKit pairing code decoded from its URI
  - a Z-Wave DSK inside a SmartStart QR
  - *Other* codes that differ only in upper and lower case or spacing
- **Codes in a trashed category** keep their link to it. Saving such a code no longer drops the link, *Uncategorized* shows and filters it consistently, and restoring the category puts the code back in it.
- **Clear filters** no longer pops up an empty "0 selected" bar.
- **`Ctrl`-click on macOS** now toggles the selection instead of opening the editor.
- **`Shift`-click ranges in a sorted table** select the rows you see, not rows in the unsorted order.
- **Importing** `{}` or any other JSON that is not an Anti-Matter export with *Replace* **no longer empties the vault**. The file is refused, both in the app and on the server.
- A duplicate found while saving no longer wipes what you typed.
- Scanning a code right after editing it no longer skips the duplicate check for that code.
- A selection that includes codes deleted on another device no longer breaks *Move to Trash*.
- Information messages are no longer titled "Please confirm".
- The details of a code with nothing scannable show a placeholder instead of a broken image.
- Category icons saved by v1.0.0–1.0.3 (Lucide names) are mapped to their Material Design equivalents, on the server as well.
- A name containing `$&` no longer garbles translated messages.
- The `?v=` cache busters in `index.html` were stuck at 1.0.39.
- The container image description now lists Zigbee and Tuya.

### Backend

- `GET /api/codes/{id}/qr.svg?border=N` serves crisp vector QR codes. `POST /api/qr.svg` previews the QR of a code that is not saved yet; it uses POST so payloads never appear in URLs or logs.
- `POST /api/codes/check-duplicate` applies the same rules as saving, without saving.
- **Error codes:** every error now returns `{"detail": {"error": <code>, "message": …}}` with a stable code that the app translates (`duplicate`, `category_name_taken`, `invalid_import`, `qr_payload_too_long`, …). A 409 includes the existing item, and validation errors (422) and framework errors use the same shape. A payload too long for a QR now returns `qr_payload_too_long` instead of a server error.
- The Matter DCL and Z-Wave device lookups answer **204 No Content** when there is no record, instead of 404.
- `POST /api/codes/{id}/save-to-media` accepts the label the app drew (raw `image/png` or `image/svg+xml`, up to 8 MB). The file is validated, and SVGs with scripts or external references are refused. Without a body it renders on the server as before.
- `/api/info` also reports the available `languages` and `translations`.
- Codes may keep category ids of categories that are in the Trash; unknown ids are still refused.
- Import errors are redacted in the log, and the frequent preview and duplicate-check requests are not logged.
- 258 back-end tests in `anti_matter/tests/`.

### Removed

- **html5-qrcode**, replaced by the native detector plus bundled zxing-wasm.
- **The always-loaded MDI webfont for icons.** Interface icons are now a Lucide SVG sprite, and common category icons are a small MDI sprite. The full MDI font is loaded only for the icon picker or an uncommon category icon.
- **The old interface code and CSS:** `app.js`, `style.css`, `brand/css/tokens.css` and `components.css`, `vault-cards.js`, `vault-scan-ui.js`, `vault-share-ui.js`, `matter-scanner.js`, `category-color-picker.js`, the old root `static/i18n.js`, and unused assets (the Lucide category-icon folder, the recycle-bin PNGs, old Matter wordmarks and `assets/logo.svg`).
- **The IBM Plex fonts**, which covered Latin only.
- **The single-button EN ↔ NL and Light ↔ Dark toggles**, now replaced by the Language and Display menus.
- **The `arm64` badge.** The add-on runs on `aarch64` and `amd64`; `arm64` is not a Home Assistant architecture name.

### Docs

- README, the add-on page and this Documentation were rewritten. They now correct:
  - the old "no outbound connections" claim (the optional Matter DCL name lookup is outbound)
  - the menu names, which are now **Settings → Apps → App store**
  - the Samba folder name
  - which Home Assistant users can open the panel
  - how the *Backups to keep* option relates to the in-app schedule
- Every screenshot, the scan GIF, the banner and the social preview were regenerated from the new UI with a fake demo vault. The generator is `tools/screenshots` (`node capture.mjs`).

### Tooling

- CI on every push and pull request: add-on linter, version consistency, translation checks, back-end tests, a browser smoke test and Docker builds for amd64 and aarch64.
- Automatic releases: pushing a new version to `main` tags it, publishes a GitHub release from this changelog and mirrors the add-on into the HA-Addons store repository.
- `config.yaml` drops keys that only repeated Home Assistant's defaults (`startup`, `boot`, `ingress_port`, `hassio_api`); behaviour is unchanged.

### Upgrade notes

- **Nothing to migrate.** HomeKit codes are repaired automatically on first start, as described under *Fixes*.
- If your vault already holds the **same device twice** (for example once from its QR and once from its manual code), both entries stay. Saving a change to either one, including linking it to a Home Assistant device, shows *Already saved as…* until you move the extra copy to the Trash.
- **Different clicks:** a click or tap on a card or row opens its details. Right-click opens the actions menu, and the pencil button or `E` opens the editor.
- A language or theme picked in the app now overrides the Configuration tab in that browser. Choose **Automatic** / **Auto** in the app to follow the add-on option again.

## 2.0.5 — QR photo-scan decode retry, fix Android device-link keyboard

- Photo/screenshot QR scanning now retries once against a grayscale +
  contrast-stretched version of the image before giving up. Fixes decode
  failures on screenshots/copies (e.g. iPhone screenshot → iMac) that bake in
  a faint grey cast instead of true white — invisible to the eye but enough
  to break the decoder's black/white threshold. (#1)
- Home Assistant device-link field: replaced the native `<input list>`
  datalist with a custom filtered dropdown. On Android, inside HA's ingress
  iframe, the native datalist popup could swallow the tap that should open
  the soft keyboard once the list had 100+ devices, leaving the field
  focused but impossible to type into. (#2)

## 2.0.4 — drop category multi-select, credits out of the in-app docs

- Removed category multi-select/bulk-delete entirely (Ctrl/Shift-click,
  the sidebar selection bar, "Delete selected") — codes keep it, categories
  go back to plain click-to-filter/right-click-to-edit.
- Dropped the **Credits** section from DOCS.md, since Home Assistant's
  add-on store renders that file in the Documentation tab. It stays on
  README.md, which only ever shows up on the GitHub repo page.

## 2.0.3 — Shift-deselect, selection bar styling

- Shift+Click on codes/categories now sets the selection to just that range
  (shrinking it deselects whatever falls back out), matching Windows
  Explorer — it previously only ever added to the selection, so a range
  could grow but never shrink. Ctrl+Shift+Click still adds the range on top
  of the existing selection instead of replacing it.
- The code selection bar (Delete selected / Clear) now matches the filter
  buttons' height and sits flush at the right edge of the filter row instead
  of its own bordered box. The category selection bar got the same
  treatment, moved from above the category list into the sidebar's header
  row (right of the "+" add-category button, wrapping onto its own
  right-aligned line since the 240px sidebar has no room for it inline).

## 2.0.2 — empty-bin visibility, code multi-select relocation

- The **Empty bin** button now hides itself entirely when the trash is empty,
  instead of just showing disabled.
- The code selection bar (Delete selected / Clear, shown once you Ctrl/Shift-
  click to multi-select codes) now sits inline at the right edge of the
  filter bar, next to Clear filters, instead of on its own row below it.
  The underlying Ctrl-toggle / Shift-range / mixed selection (Explorer-style)
  was already there for both grid and table view — this only moves where the
  bar renders.
- Also fixes the in-app version badge: it reads a separate `APP_VERSION`
  constant in main.py that didn't get bumped alongside config.yaml in 2.0.1,
  so the header kept showing v2.0.0.

## 2.0.1 — trash scroll/empty-bin, SAMBA share rename

- Trash dialog now scrolls when it has enough items (it wasn't wrapped in a
  `<form>`, so it never picked up the scrolling rule other dialogs use) and
  gained an **Empty bin** button to purge everything in one go.
- Renamed the add-on's SAMBA config share from `addon_configs` to `app_configs`
  (map key `addon_config:rw` → `app_config:rw`) to match Home Assistant's
  newer add-on/app terminology.

## 2.0.0 — docs refresh, version milestone

- Re-shot and reorganized the wiki screenshots (language-suffixed file names, a new
  Dark/Light theme hero shot), refreshed the README/DOCS for Zigbee/Tuya and the zoom
  control, added an `arm64` support badge, and condensed this changelog.
- Version bumped to 2.0.0 to mark this set of changes (Zigbee/Tuya as first-class
  protocols, the card-grid zoom control, and the round of dialog/sticker-card fixes
  below) as a milestone release.

## 1.0.42–1.0.65 — Zigbee/Tuya, card-grid zoom, sticker/dialog polish

- Added a 4th code type, **Other**, for standards Anti-Matter doesn't natively parse
  (Tuya, Wyze, Zigbee 3.0, …) — free-text standard name + manual code/QR payload, no
  validation; an unrecognized scan lands here instead of being rejected or mistagged.
  Zigbee and Tuya were later promoted to their own protocol-dropdown entries with a
  branded card, still stored as "other" + a standard name under the hood.
- Unified every protocol's sticker card to the same layout and found/fixed several real
  sizing bugs along the way: HomeKit's QR rendered visibly bigger than the others (its
  generator used no quiet zone, unlike Matter/Z-Wave); Tuya's logo looked small because
  its bundled SVG had ~66% baked-in transparent padding; the QR briefly went non-square
  on narrow grid columns. Every protocol's QR is now exactly 300×300.
- Added a card-grid zoom control — −/+ buttons, a percentage that opens a 50–150% preset
  dropdown, a reset button, and Ctrl+scroll/pinch — grid view only, remembered across
  reloads.
- Found and fixed a real client-side bug in Z-Wave QR handling: the browser-side parser
  never validated the SmartStart QR's checksum (only an unused async stub existed), so a
  checksum-invalid code could still render a broken-image icon instead of the QR
  placeholder. Ported the backend's SHA-1 check into sync JS.
- New/Edit code dialog: consistent spacing throughout (previously several sections had
  no gap between stacked fields), Scan/Upload buttons actually side-by-side (one was a
  stray sibling instead of being in the same row), matching checkbox sizes, "In use"
  reordered above Device vendor, and a couple of real regressions introduced and then
  fixed within this same span (collapsed `<details>` sections gaining phantom
  whitespace from a `display:flex` interaction with Chromium's native collapse
  behavior; non-form dialogs losing their centering from a scrollbar-inset change that
  only compensated form-based ones).
- Replaced font-glyph icons (the categories "+", the Invert button's QR icon) with
  hand-drawn SVGs after repeated reports of sub-pixel centering drift that couldn't be
  reproduced or fixed via CSS alone.
- Dialogs switched from a semi-transparent glass background to solid — whatever sat
  behind a dialog (a card's mostly-black QR image) was showing through empty areas.
- Added Matter's own "find your device" link (Distributed Compliance Ledger) next to
  Z-Wave's, in both the standalone decode dialogs and the New/Edit dialog's inline
  decode sections; both always open in a new tab, same as "Open device in Home
  Assistant" (since 1.0.41).
- Protocol/In-use/Connectivity filter dropdowns: fixed oversized unstyled radio buttons
  wrapping their labels, expanded the Protocol filter to all 6 entries, fixed a
  scrollbar clipping a panel's rounded corner.
- Trash button now shows an empty vs. full icon based on actual contents.

## 1.0.0–1.0.41 — foundation

Cloud-free rewrite of [Rematters](https://github.com/Rematters/Rematters-HA) into a
local-only Home Assistant add-on: Matter/HomeKit/Z-Wave code storage with QR rendering,
webcam + photo-upload scanning, categories, a filterable table view alongside the card
grid, a Trash bin with restore/merge, scheduled + manual backups with Export/Import, a
Home Assistant device link (searchable, with auto-match suggestions and CSA DCL /
Z-Wave device-DB lookups for vendor/product names), and NL/EN + Light/Dark that follow
Home Assistant.
