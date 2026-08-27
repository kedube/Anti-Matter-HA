# Changelog

Detailed per-commit history is in [git log](https://github.com/Cl3tus/Anti-Matter-HA/commits/main).
This file summarizes the notable changes by theme.

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
