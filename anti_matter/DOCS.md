# Anti-Matter: user manual

Anti-Matter is a private vault for your smart-home **pairing codes**: Matter, HomeKit, Z-Wave, Zigbee, Tuya and
anything else. It scans and decodes each code, stores it on your Home Assistant, and shows a clean, scannable label
whenever you need to pair a device again.

Screenshots and the project page: <https://github.com/Cl3tus/Anti-Matter-HA>

---

## Getting started

1. Install and start the add-on, then open **Anti-Matter** from the sidebar. It runs through Home Assistant ingress, so no ports are opened and you are already logged in.
2. An empty vault offers three ways in: **Scan your first label**, **Type a code**, or **Import a JSON export**.
3. From then on, use **Scan** (`S`) and **New code** (`N`) in the top bar. On a phone, use the round Scan button and **New** in the bottom dock.

**The screen at a glance**

- **Top bar:** search, **Display** (theme and Invert), **Language**, **New code** and **Scan**. On a tablet the extra tools sit under **⋮ More**; on a phone they sit under **More** in the dock.
- **Sidebar** (wide screens): **All codes**, **Uncategorized**, your categories, the backup status, **Trash**, **Backups** and **Import & export**. Narrower screens show the categories as a row of chips instead.
- **Summary:** the number of pairing codes, a bar per protocol (tap a protocol to filter by it), the number in use and spare, and how many are linked to Home Assistant. **Show** next to the spares count lists the codes that are not in use.
- **View bar:** **Select**, **Cards / Labels / Table**, grid size, and **Invert**.
- **Filters row:** Protocol, Vendor, Product, Type, Area, In use, Connectivity, and **Clear filters**. On a phone, use the filter button in the search box.

---

## Scanning

Press **Scan** (or `S`). Anti-Matter picks the best scanner for where you are:

1. **In the Home Assistant Companion app**, the app's **native scanner** opens. This works over `http://` too.
2. **In a browser on `https://`**, the **live camera** starts.
3. **In a browser on `http://`**, a **photo page** opens instead, because browsers do not allow the camera there. See *Camera not available* under Troubleshooting.

At the top of the scanner you can switch between **Camera**, **Photo** and **Paste** at any time.

### Camera

- The first time, select **Allow camera** and accept the browser's prompt. The back camera is used when there is one. The video stays on your device and is never recorded.
- Point at the QR code on the label. When a code is read, brackets snap onto it and the frame pauses.
- The camera controls depend on the device: **Torch** (`T`), **Switch camera** (`C`), **zoom** (a slider, the 1× 2× 3× buttons, pinch, or `+` / `−`), and tap-to-focus.

### Photo, drop and paste

- **Take photo** opens your phone's camera app. **Choose image** picks an existing picture or screenshot.
- You can also **drag an image** onto Anti-Matter, or **paste one** with `Ctrl`/`⌘`+`V`, from anywhere on the vault screen.
- Hard photos get more attempts: grayscale and contrast, inverted, enlarged, and cut into tiles for big pictures. Photos are decoded in your browser and never uploaded.
- **Several codes in one photo:** every code found is numbered on the picture. Tick the ones to save; duplicates cannot be ticked.

### Paste text

Paste a setup code or payload, such as a QR string copied from another app. The line below the box shows what was
recognised before you continue.

### The result

When a code is read, a result sheet shows:

- **Code found** with **New to vault**, or **Already in your vault** (see *Duplicates* below).
- A printed-style preview of the label: QR, wordmark and setup code.
- **Name**, pre-filled from the official Matter registry ("From DCL"), the Z-Wave device database ("From device DB"), the HomeKit accessory type, or "Scanned device N". You can change it now or later.
- The decoded details: vendor, product, passcode, discriminator, security classes and so on.
- **Categories** to file it under.
- **Keep scanning after saving** (batch mode). Your choice is remembered in this browser.

Then choose one of:

- **Save & scan next** (batch mode on) saves the code and returns straight to the camera. The code is added to the session tray with **Undo**.
- **Save** (batch mode off) saves the code and closes the scanner.
- **Edit details** opens the full editor, pre-filled, so you can add an area, notes or a Home Assistant device first.
- **Skip** (or `Esc`) discards this read and keeps scanning.

Nothing is ever left half-saved. **Done** (or closing the scanner) shows a summary such as "2 saved, 1 duplicate
skipped". **Review** then filters the vault to the codes of that session; remove the *This session* chip to see
everything again.

### Companion app scanner

Inside the Home Assistant app, the native scanner opens and Anti-Matter shows *Scanning with the Home Assistant app*.
In batch mode, each code is saved as soon as you scan it, and the app tells you "Saved: …" or "Already in your vault:
…". **Use the web camera instead** switches to the browser camera, which needs HTTPS.

### What gets recognised

| You scan or type | Saved as |
| --- | --- |
| `MT:…` QR, or an 11 or 21-digit code with a valid check digit | **Matter**. Multi-device `MT:…*…` payloads and extra data are kept exactly as scanned. |
| `X-HM://…` setup URI, or `XXX-XX-XXX` | **HomeKit** |
| A bare 8-digit number | Probably HomeKit. You are asked to confirm, because other labels use 8-digit numbers too. |
| A long number starting with `90` (SmartStart QR), or a 40-digit DSK | **Z-Wave** |
| A Zigbee install-code QR (ZHA formats such as `Z:<EUI-64>$I:<code>`) | **Zigbee** |
| A Tuya or Smart Life link | **Tuya** |
| Anything else | **Other**, exactly as scanned. Nothing is rejected. |

### Duplicates

Before anything is saved, each result is checked against your vault, using the same rules as the server:

- **Matter:** the same manual code, the same QR, or the same device. A QR and a manual code that share a passcode and discriminator count as the same device.
- **HomeKit:** the same 8-digit pairing code (typed, or decoded from the URI) or the same URI.
- **Z-Wave:** the same DSK (typed, or inside the SmartStart QR) or the same QR.
- **Zigbee, Tuya and Other:** the same text, ignoring upper and lower case and spaces.

A duplicate is **never saved twice**; there is no "save anyway". **Open existing** shows the code you already have.
Only codes of the same protocol are compared.

---

## Adding and editing codes

**New code** (`N`) opens the editor, and so do the pencil button on a card, **Edit** (`E`) in the details, and
**Edit details** in the scanner. A live preview of the label and the decoded payload updates as you type.

1. **Protocol:** Matter, HomeKit, Z-Wave, Zigbee, Tuya or Other. When a scan fills the form, the detected protocol is shown above the choices. Picking Z-Wave or Zigbee by hand also ticks that connectivity.
2. **Name** (required).
3. **Setup code.** The fields depend on the protocol:
   - **Matter:** manual pairing code (11 or 21 digits) and/or QR payload (`MT:…`). The check digit is verified, and the code is compared with the QR.
   - **HomeKit:** setup URI (`X-HM://…`) and/or the 8-digit pairing code, plus setup ID and accessory category. Without a URI, the QR is built from the code, the setup ID and the category.
   - **Z-Wave:** the 40-digit DSK (the PIN, its first 5 digits, is underlined) and/or the SmartStart QR (`90…`). The checksum and the DSK groups are verified.
   - **Zigbee / Tuya / Other:** a manual code and/or raw QR payload, stored exactly as entered. *Other* also asks for a standard name, such as "Wyze".
   - **Fill from the label:** **Scan** or **Photo** fills these fields in from a label.
4. **Categories:** tick any number, or create one with **+ New category**.
5. **Home Assistant device** (optional): search by name or area and pick a device. A **Suggested match** appears when a device name resembles the code's name.
6. **Device details:** In use, Vendor, Product, Type, Area (with your Home Assistant areas as suggestions), Connectivity (Wi-Fi, Thread, Zigbee, Bluetooth, Z-Wave), Description and Notes. Vendor and product decoded from a Matter or Z-Wave payload fill only empty fields you have not typed in.

Save with **Save code** (`Enter`, or `Ctrl`/`⌘`+`Enter` from any field), or with **Save & scan next** to go straight to
the scanner. **Cancel** or `Esc` closes the editor, and asks first if you changed something. If the code is a
duplicate, a notice says *Already saved as "…"* with **Open existing**, and your input stays in the form.

---

## Browsing your vault

- **Cards** (`1`) show a QR label and the key facts; **Labels** (`2`) show a wall of printable labels; **Table** (`3`) shows every column. Select a column header to sort the table.
- **Grid size:** use **−** / **+**, select the percentage for 50–150 % presets, use `Ctrl`/`⌘` + `+` `−` `0`, or `Ctrl`+scroll over the grid.
- **Search** (`/`) looks in names, vendors, products, types, areas, descriptions, notes, codes, payloads, standards, categories and linked device names. Every word must match. A digits-only search also finds codes written with dashes.
- **Filters:** each filter lists the values in your vault with counts, including *(Empty)*. Several values within one filter match any of them (OR). Different filters, categories and search must all match (AND). **Clear filters** resets the filters but keeps the search and category.
- **Categories:** select one or more in the sidebar (or the chip row) to show their codes. **Uncategorized** shows codes without a category.
- **Open a code:** click or tap a card or row, or focus it and press `Enter`. Each card has a pencil (edit) and a **⋯** menu with Open details, Copy setup code, Present, Decode payload, Edit, Download label, Open in Home Assistant (for linked codes), Select and Move to Trash. Right-click opens the same menu.
- **Select several:** `Ctrl`/`⌘`-click toggles a code, `Shift`-click selects a range in the order shown (also in a sorted table), and `Ctrl`/`⌘`+`Shift`-click adds a range. On a Mac, `Ctrl`-click works like `⌘`-click. On touch screens, tap **Select** or long-press a card. The selection bar offers **Select all**, **Move to Trash** and clear.
- **Invert** (`I`) shows QR codes white-on-black for dark rooms. Some phone scanners cannot read inverted codes, so turn it off if a scan fails.

### Labels, print and present

- In **Labels**, choose what to *Show on labels* (**Names**, **Setup codes**). **Flip** a label (`F`) to read its decoded back.
- **Print** prints only the labels, several per row.
- **Present all** shows the filtered codes one by one, full screen. **Present** (`P`) on a single code does the same for that code. Present mode keeps the screen awake where the browser allows it. Use `←` `→` or swipe to move, **Invert** to switch colours, and `Esc` to close. It is handy for pairing with a phone that scans the screen.

---

## Details and decoding

The details sheet shows:

- The label, plus four buttons: **Copy code**, **Present**, **Download** and **Invert**.
- The **manual setup code** and raw **QR payload**, each with a copy button.
- The linked **Home Assistant device**, or a suggestion (see below).
- **Device** facts: type, area, connectivity, categories, and the added and updated dates.
- **Decoded payload** (decoded offline in your browser):
  - **Matter:** vendor ID and product ID (with the official names when the CSA registry knows them), passcode and whether it is valid, discriminator, discovery modes (Soft-AP, BLE, IP network) and commissioning flow. Links go to the vendor site, product page, support page and the CSA DCL entry.
  - **Z-Wave:** SmartStart/S2 and version, requested security classes, Z-Wave / Long Range, the DSK with its PIN underlined, device class, and manufacturer, product type and product ID. Names come from the bundled zwave-js device database, with a link to its page.
  - **HomeKit:** pairing code, setup ID and accessory category.

Use `↑` `↓` (or `K` `J`) for the previous or next code, `D` to jump to the decoded payload, and `Shift`+`D` to download.
**Move to Trash** and **Edit** are at the bottom.

**Download label** saves a PNG of the label to your device. It also copies it to Home Assistant's media folder as
`anti_matter/antimatter-<name>.png`, so you can find it in Media or on the Samba `media` share.

---

## Home Assistant device link

Linking a code to a device lets you jump from the code to that device's page in Home Assistant.

- In the details, an unlinked code may show **Suggested Home Assistant device** with **Link device**.
- In the editor, search the **Home Assistant device** field by name or area. Devices with the same name show their area. A code is linked only when you pick a device from the list.
- Once linked, **Open in Home Assistant** opens the device page. Inside Home Assistant it opens in the main window; in a plain browser tab it opens in a new tab. **Unlink** is in the **⋯** menu next to it.

If Home Assistant cannot be reached, the device list is empty and you can link later. Area suggestions come from
your Home Assistant areas, but you can type any area.

---

## Categories

- Create one with **+** in the sidebar, **Manage categories**, or **+ New category** in the editor.
- A category has a name (unique, ignoring case), a colour (12 presets or a custom one) and an icon from more than 7,000 Material Design Icons.
- Use the **⋯** next to a category, or right-click it, to **Edit** or **Delete**.
- A deleted category goes to the Trash. Its codes show as uncategorized meanwhile, and they are filed under it again when you restore it.

---

## Trash

**Trash** (sidebar, or **More** on a phone) has a **Codes** tab and a **Categories** tab.

- **Restore** puts an item back. If the vault already has the same code, the row says *Same code as "…"* and offers **Merge**. Merging deletes the trashed copy and keeps the one in your vault as it is.
- **Delete forever** removes one item, and **Empty bin** removes everything; both ask first.
- **Move to Trash** shows an **Undo** in the message at the bottom of the screen.

---

## Backups, import and export

**Backups** opens the schedule:

- **Automatic backups** on or off, then **Hourly / Daily / Weekly / Monthly**, the time (hourly runs use only the minute), the weekday, or the day of the month (1–28).
- **Backups to keep**, 1–100. Older copies are deleted automatically.
- **Back up now** makes a copy immediately. **Save schedule** stores the settings.

The schedule runs in the add-on's local time, and only while the add-on is running. Each backup is a copy of the vault
in `backups/anti_matter_YYYYMMDD_HHMMSS.json`, with the time in UTC.

**Import & export:**

- **Export** downloads `anti-matter-export.json`, which holds every code and category.
- **Import** reads a file and shows what is in it, for example "14 codes · 6 categories · 3 new, 11 already in your vault". It then offers:
  - **Merge**: add the codes and categories that are not in your vault yet, and keep everything you have. Entries that look like codes you already have are pointed out.
  - **Replace**: replace the whole vault with the file. A backup of your current vault is made first.
- Files that are not Anti-Matter exports are refused, and nothing changes.
- To restore a backup, copy a file from `backups/` to your computer (over Samba), then import it with **Replace**.

Backups and exports contain the vault only; the Trash is not included.

### Where your files are

The add-on's config folder is `/config` inside the add-on. Over Samba it is:

```text
\\<HA-IP>\app_configs\<hash>_anti_matter\
    anti_matter.json          your vault
    anti-matter-bin.json      the Trash
    backup_settings.json      the backup schedule
    backups/                  scheduled and manual backups
```

`<hash>` is set by Home Assistant from the repository the add-on was installed from. For `Cl3tus/HA-Addons` it is
`74e2a2e6`. Older setups call the share `addon_configs`. This folder is included in Home Assistant backups whenever
the Anti-Matter add-on is part of the backup.

### Moving from another repository

Anti-Matter installed from a different repository (for example a fork instead of `Cl3tus/HA-Addons`) is a separate
add-on with its own, empty folder. Your old vault stays in the old folder. To bring it over:

- **The vault:** click **Export** in the old Anti-Matter, then **Import a JSON export** in the new one. A file from
  the old `backups/` folder, or the old `anti_matter.json`, works too.
- **Everything, including the Trash and backups:** stop the new add-on, copy the four items listed above from the old
  `…_anti_matter` folder into the new one, then start it.

HomeKit codes saved by 2.x are repaired either way. Set the add-on options again on the Configuration tab, then
uninstall the old add-on.

---

## Language and theme

- **Language:** select the language button (it shows the current code, such as "EN"), or **More → Language** on a phone. You can choose **Automatic** or one of 24 languages, and search the list. Automatic follows Home Assistant's language live, then the browser, then English. Hebrew and Arabic mirror the layout; codes and QR codes stay left to right.
- **Theme:** **Display** offers **Auto / Light / Dark** and **Invert QR codes**. Auto follows Home Assistant's light or dark mode.
- A language or theme picked in the app is remembered by this browser and takes precedence over the add-on's **Configuration** tab. Pick **Automatic** or **Auto** to go back to the add-on's default.

**Configuration tab options:** *Language* (`Auto` or a language), *Theme* (`Auto`, `Light`, `Dark`) and *Backups to
keep* (1–100). *Backups to keep* only sets the starting value: once you save the in-app Backups dialog, the value
there is used instead.

---

## Keyboard shortcuts

Press `?` in the app for this list. Letter shortcuts are ignored while you are typing in a field.

| Key | Action |
| --- | --- |
| `/` | Search |
| `S` / `N` | Scan / New code |
| `1` `2` `3` | Cards / Labels / Table |
| `Ctrl`/`⌘` + `+` `−` `0` | Grid size larger, smaller, reset |
| `I` | Invert QR codes |
| Arrow keys | Move between cards or table rows |
| `Enter` | Open the focused code |
| `E` / `C` / `P` | Edit / copy setup code / present full screen |
| `D` / `Shift`+`D` | Decode payload / download label |
| `X` | Select the focused code |
| `Ctrl`/`⌘` + `A` | Select all shown codes (while selecting) |
| `Del` | Move to Trash |
| `F` | Flip the focused label |
| `↑` `↓` or `K` `J` | Previous / next code in the details |
| `←` `→` | Previous / next code when presenting |
| `Esc` | Close, cancel, or clear the selection |
| `Enter`, `Ctrl`/`⌘`+`Enter` | Save (in the editor) |
| `T` / `C` / `+` `−` | Torch / switch camera / zoom (in the scanner) |
| `1` `2` `3` | Camera / Photo / Paste (in the scanner) |
| `Ctrl`/`⌘` + `V` | Paste an image to scan it (or text, in the scanner) |

---

## Troubleshooting

**"Live camera needs a secure connection" / the camera is not available**
Browsers only allow the camera on `https://` pages (and on `localhost`). If you open Home Assistant at an address
like `http://homeassistant.local:8123` or `http://192.168.1.x:8123`, the live camera cannot start. That is a browser
rule, not a setting in Anti-Matter. You can:

- Use the **Home Assistant Companion app**. Its native scanner works over `http://`.
- Use **Take photo**, **Choose image**, drag and drop, or paste. Photos are decoded right away, offline.
- Turn on HTTPS, for example with a Home Assistant Cloud remote URL or your own certificate. Then open Home Assistant at its `https://` address and allow the camera.

**"Camera is blocked"**
The browser denied access for this site. Allow the camera in the site settings (the icon next to the address), then
select **Try again**.

**"Camera is busy"**
Another app or tab is using the camera. Close it and try again.

**"No camera found"**
Use a photo, or paste the code as text.

**The code is not recognised, or nothing is found in a photo**

- Fill the frame with the QR, avoid glare, and hold still for a moment. Try the torch or zoom.
- For photos, crop closer or use a sharper picture. Screenshots work well. Some formats, such as HEIC on some browsers, cannot be read; use JPEG or PNG.
- Type the printed code in the editor instead: the 11-digit Matter code, `XXX-XX-XXX` for HomeKit, or the Z-Wave DSK.
- A code of an unknown format is saved as **Other**, exactly as scanned, so you never lose it.

**"Only 8 digits were read"**
HomeKit codes have 8 digits, but other labels do too. Choose HomeKit or Other.

**"Already saved as …" / "Already in your vault"**
The code matches one you have (see *Duplicates*). Select **Open existing** to see it. If you meant to replace it,
edit the existing code or move it to the Trash first. After updating from 2.x, two old entries for the same device
can block each other's edits; move the extra one to the Trash.

**Restoring from the Trash shows *Same code as "…"***
The vault already has that code. **Merge** discards the trashed copy.

**No vendor or product names**
Matter names come from the online CSA registry. If Home Assistant has no internet access, or the product is not
listed there, the names are simply left empty. Z-Wave names come from the bundled database, which covers most
certified devices.

**The Home Assistant device list is empty**
Home Assistant could not be reached from the add-on. Restart the add-on; you can link devices later.

**Changing Language or Theme on the Configuration tab has no effect**
A choice made in the app wins in that browser. Select **Automatic** in the language menu and **Auto** under
**Display**, then reload.

**"Backups to keep" on the Configuration tab is ignored**
After the in-app Backups dialog has been saved, its own value is used. Change it there.

**A scheduled backup did not run**
Backups run only while the add-on is running, at the add-on's local time. File names use UTC, so the time in a file
name can differ from your clock.

**The app looks outdated after an update**
Reload the page. If that doesn't help, clear the site data or do a hard reload.

**Logs**
The add-on's **Log** tab shows what happened. Pairing codes and payloads are always left out of the log.

---

## Privacy and security

- **Local storage.** Your codes are stored only on your Home Assistant, as plain JSON. They are not encrypted, so treat the Samba share, Home Assistant backups and exported files like a password list.
- **One outbound request.** When you open, edit or scan a Matter code, the add-on asks the official CSA Distributed Compliance Ledger (`on.dcl.csa-iot.org`) for the vendor and product name. Only the vendor ID and product ID are sent: never the passcode or the QR payload. It is best-effort, and the app works fully without internet access. There is no setting to turn it off.
- **Offline everything else.** Scanning, decoding and Z-Wave device names work offline. Fonts, icons and the decoder are bundled. There is no telemetry, no account and no cloud. External links open only when you select them.
- **Home Assistant.** The add-on reads your device list and areas, and never changes anything in Home Assistant.
- **Who can open it.** The Anti-Matter panel is available to **every Home Assistant user**, including non-admins, and they can read all codes. Only give Home Assistant accounts to people you trust with these codes. Hiding the panel (**Show in sidebar** off on the add-on's page) is not a security boundary.
