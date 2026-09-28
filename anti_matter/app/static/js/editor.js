/**
 * Anti-Matter 3.0 — js/editor.js
 * Editor sheet (#sheet-editor): New / Edit a code.
 *
 * Provides: openEditor(codeOrNull, prefill?, {provenance?: "scan"})
 *   prefill = a parseScannedText-like object {code_type (incl. "zigbee"/"tuya"), manual_code,
 *   qr_payload, setup_id, homekit_category, homekit_flag, custom_standard, name,
 *   device_vendor, device_product, category_ids, recognized, confidence}.
 *
 * The form is rendered from a model (m) so it survives re-renders (language switch, a
 * scan filling the form) without losing typed input. Rules kept from 2.x (gaps.md):
 * Zigbee/Tuya are presets over code_type "other" + custom_standard and round-trip; a
 * manual protocol change ticks Z-Wave/Zigbee connectivity (never on open, never unticks);
 * decoded vendor/product fill only fields the user has not typed in; the HA device picker
 * is a custom listbox (never a <datalist>) that stores an id only on an exact match;
 * duplicates are never saved (client check, server check, 409), and the form is never
 * wiped by a duplicate or an error. Uses window.AM (core.js) and AntiMatterSheetKit (detail.js).
 */
(function (global) {
  "use strict";

  var AM = global.AM;
  var doc = global.document;
  var h = AM.h, t = AM.t, icon = AM.icon;
  var SHEET = "sheet-editor";

  function K() { return global.AntiMatterSheetKit; }
  function MP() { return global.AntiMatterMatterPayload; }
  function HK() { return global.AntiMatterHomeKitPayload; }
  function ZW() { return global.AntiMatterZWavePayload; }
  function SCAN() { return global.AntiMatterScan; }
  function digits(s) { return String(s == null ? "" : s).replace(/\D/g, ""); }
  function str(s) { return String(s == null ? "" : s).trim(); }
  function lc(s) { return str(s).toLocaleLowerCase(); }

  var PROTOS = ["matter", "homekit", "zwave", "zigbee", "tuya", "other"];
  var CONN_KEYS = ["conn_wifi", "conn_matter", "conn_zigbee", "conn_bluetooth", "conn_zwave"];
  var DEVICE_TYPES = [
    "light", "switch", "plug", "sensor", "binary_sensor", "motion_sensor", "contact_sensor", "climate",
    "thermostat", "lock", "cover", "garage_door", "fan", "camera", "doorbell", "siren", "smoke_detector",
    "water_leak_sensor", "button", "remote", "media_player", "speaker", "vacuum", "hub", "other",
  ];

  var m = null; // model of the open form
  var R = {};   // element refs of the current render
  var gen = 0;  // render generation (drops stale async results)

  // =========================================================================
  // Model
  // =========================================================================
  function fmtMatter(v) {
    var d = digits(v);
    return (d.length === 11 || d.length === 21) && MP() ? MP().formatManualDisplay(d) : str(v);
  }
  function fmtPairing(v) {
    var d = digits(v);
    return d.length === 8 ? d.slice(0, 3) + "-" + d.slice(3, 5) + "-" + d.slice(5) : str(v);
  }
  function fmtDsk(v) {
    var d = digits(v);
    return d.length === 40 && ZW() ? ZW().formatDsk(d) : str(v);
  }
  function uiProto(code) {
    if (!code) return "matter";
    var of = AM.proto.of(code);
    if (of === "zigbee" || of === "tuya") return AM.proto.preset(code) || "other";
    return of;
  }

  function modelFrom(code) {
    var p = uiProto(code);
    var c = code || {};
    var model = {
      id: code ? code.id : null,
      origName: str(c.name),
      origLive: code ? AM.cat.idsOf(code) : [],
      origIds: (c.category_ids || []).slice(),
      proto: p,
      name: c.name || "",
      matter: { manual: p === "matter" ? fmtMatter(c.manual_code) : "", qr: p === "matter" ? str(c.qr_payload) : "" },
      homekit: {
        uri: p === "homekit" ? str(c.qr_payload) : "",
        pairing: p === "homekit" ? fmtPairing(c.manual_code) : "",
        setupId: p === "homekit" ? str(c.setup_id).toUpperCase() : "",
        category: p === "homekit" && c.homekit_category ? c.homekit_category : "other",
        flag: p === "homekit" && c.homekit_flag != null ? c.homekit_flag : 2,
      },
      zwave: { dsk: p === "zwave" ? fmtDsk(c.manual_code) : "", qr: p === "zwave" ? str(c.qr_payload) : "", dskAuto: false },
      other: {
        standard: p === "other" ? str(c.custom_standard) : "",
        manual: p === "zigbee" || p === "tuya" || p === "other" ? str(c.manual_code) : "",
        qr: p === "zigbee" || p === "tuya" || p === "other" ? String(c.qr_payload || "") : "",
      },
      cats: code ? AM.cat.idsOf(code) : [],
      haId: (c.ha_link && c.ha_link.device_id) || "",
      haText: "",
      inUse: !!c.in_use,
      vendor: c.device_vendor || "",
      product: c.device_product || "",
      type: c.device_type || "",
      area: c.area || "",
      description: c.description || "",
      notes: c.notes || "",
      conn: {},
      touched: { vendor: !!str(c.device_vendor), product: !!str(c.device_product), name: !!str(c.name) },
      autofilled: { vendor: false, product: false },
      nameFrom: null,
      detailsOpen: null,
      provenance: null,
      detected: null,
      scanNote: null,
      dup: null,
      dirty: false,
    };
    CONN_KEYS.forEach(function (k) { model.conn[k] = !!c[k]; });
    if (model.haId) {
      var dev = AM.ha.device(model.haId);
      model.haText = dev ? AM.ha.label(dev) : "";
    }
    return model;
  }

  function filledCount() {
    var n = 0;
    ["vendor", "product", "type", "area", "description", "notes"].forEach(function (k) { if (str(m[k])) n++; });
    if (CONN_KEYS.some(function (k) { return m.conn[k]; })) n++;
    if (m.inUse) n++;
    return n;
  }

  /** Payload fields for the selected protocol, normalised exactly as the server stores them. */
  function payloadBody() {
    var p = m.proto;
    if (p === "matter") return { code_type: "matter", manual_code: str(m.matter.manual), qr_payload: str(m.matter.qr) };
    if (p === "homekit") {
      var n = HK() ? HK().normalizeFields(m.homekit.pairing, m.homekit.uri, { setup_id: m.homekit.setupId, homekit_category: m.homekit.category, homekit_flag: m.homekit.flag })
        : { manual_code: digits(m.homekit.pairing), qr_payload: str(m.homekit.uri), setup_id: m.homekit.setupId, homekit_category: m.homekit.category, homekit_flag: m.homekit.flag };
      return { code_type: "homekit", manual_code: n.manual_code, qr_payload: n.qr_payload, setup_id: n.setup_id || "", homekit_category: n.homekit_category || "other", homekit_flag: n.homekit_flag == null ? 2 : n.homekit_flag };
    }
    if (p === "zwave") {
      var z = ZW() ? ZW().normalizeFields(m.zwave.dsk, m.zwave.qr) : { manual_code: str(m.zwave.dsk), qr_payload: str(m.zwave.qr), zwave_pin: "" };
      return { code_type: "zwave", manual_code: z.manual_code, qr_payload: z.qr_payload, zwave_pin: z.zwave_pin || "" };
    }
    var std = p === "zigbee" || p === "tuya" ? AM.proto.meta(p).standard : str(m.other.standard);
    return { code_type: "other", custom_standard: std, manual_code: str(m.other.manual), qr_payload: String(m.other.qr || "").trim() };
  }
  function pseudoCode() {
    return Object.assign({ id: m.id || "preview", name: m.name, device_vendor: m.vendor, device_product: m.product }, payloadBody());
  }

  function buildBody() {
    var b = payloadBody();
    b.name = str(m.name);
    b.device_type = str(m.type);
    b.device_vendor = str(m.vendor);
    b.device_product = str(m.product);
    b.area = str(m.area);
    b.description = str(m.description);
    b.notes = String(m.notes || "").trim();
    b.in_use = !!m.inUse;
    CONN_KEYS.forEach(function (k) { b[k] = !!m.conn[k]; });
    b.ha_link = { device_id: m.haId || null };
    var live = m.cats.filter(function (id) { return AM.cat.known(id); });
    if (!m.id) {
      b.category_ids = live;
    } else {
      var same = live.length === m.origLive.length && live.every(function (id) { return m.origLive.indexOf(id) >= 0; });
      // Unchanged: omit category_ids so ids of categories now in the Trash stay attached (G1).
      if (!same) b.category_ids = AM.cat.idsToSave(m.origIds, live);
    }
    return b;
  }

  function defaultName() {
    var base = t("scan.default_name");
    var re = new RegExp("^" + base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?: (\\d+))?$");
    var max = 0;
    AM.store.vault.codes.forEach(function (c) {
      var mm = re.exec(str(c.name));
      if (mm) max = Math.max(max, mm[1] ? +mm[1] : 1);
    });
    return max ? base + " " + (max + 1) : base;
  }

  /** Put a scan/prefill result into the model (no render). */
  function applyToModel(parsed) {
    var ct = lc(parsed.code_type || "other");
    var std = str(parsed.custom_standard);
    var p = ct === "zigbee" || ct === "tuya" ? ct
      : ct === "other" ? (lc(std) === "zigbee" ? "zigbee" : lc(std) === "tuya" ? "tuya" : "other")
        : PROTOS.indexOf(ct) >= 0 ? ct : "other";
    m.proto = p;
    var manual = parsed.manual_code == null ? "" : String(parsed.manual_code);
    var qr = parsed.qr_payload == null ? "" : String(parsed.qr_payload);
    if (p === "matter") { m.matter.manual = fmtMatter(manual); m.matter.qr = str(qr); }
    else if (p === "homekit") {
      m.homekit.uri = str(qr);
      m.homekit.pairing = fmtPairing(manual);
      m.homekit.setupId = str(parsed.setup_id).toUpperCase();
      if (parsed.homekit_category) m.homekit.category = parsed.homekit_category;
      m.homekit.flag = parsed.homekit_flag != null ? parsed.homekit_flag : 2;
      syncHomekitFromUri();
    } else if (p === "zwave") { m.zwave.dsk = fmtDsk(manual); m.zwave.qr = str(qr); m.zwave.dskAuto = false; syncZwaveFromQr(); }
    else {
      if (p === "other" && std) m.other.standard = std;
      m.other.manual = str(manual);
      m.other.qr = qr.trim();
    }
    if (!str(m.name)) {
      m.name = str(parsed.name) || defaultName();
      m.nameFrom = str(parsed.name) ? (parsed.name_source || null) : null;
    }
    if (str(parsed.device_vendor) && !m.touched.vendor) { m.vendor = str(parsed.device_vendor); m.autofilled.vendor = true; }
    if (str(parsed.device_product) && !m.touched.product) { m.product = str(parsed.device_product); m.autofilled.product = true; }
    if (Array.isArray(parsed.category_ids)) {
      parsed.category_ids.forEach(function (id) { if (AM.cat.known(id) && m.cats.indexOf(id) < 0) m.cats.push(id); });
    }
    m.detected = p;
    m.scanNote = parsed.recognized === false ? "unknown" : parsed.confidence === "low" ? "low" : null;
    m.dup = null;
    m.dirty = true;
  }

  // HomeKit: the URI is authoritative when it parses; the pairing code, setup ID and
  // category follow it. Editing those three recomposes a present URI so they never disagree.
  function syncHomekitFromUri() {
    var H = HK();
    if (!H) return false;
    var parsed = H.parseSetupUri(m.homekit.uri);
    if (!parsed) return false;
    var f = H.decodeFieldsFromUri(parsed.uri);
    var pin = H.decodePairingFromUri(parsed.uri);
    if (/^\d{8}$/.test(pin)) m.homekit.pairing = fmtPairing(pin);
    m.homekit.setupId = f.setup_id || "";
    if (f.homekit_category) m.homekit.category = f.homekit_category;
    if (f.homekit_flag != null) m.homekit.flag = f.homekit_flag;
    return true;
  }
  function recomposeHomekitUri() {
    var H = HK();
    if (!H || !str(m.homekit.uri) || !H.parseSetupUri(m.homekit.uri)) return false;
    var d = digits(m.homekit.pairing);
    if (d.length !== 8) return false;
    var sid = H.normalizeSetupId(m.homekit.setupId);
    if (str(m.homekit.setupId) && !sid) return false;
    m.homekit.uri = H.composeSetupUri({ categoryId: H.categoryIdFor(m.homekit.category), flag: m.homekit.flag == null ? 2 : m.homekit.flag, password: d, setupId: sid });
    return true;
  }
  function syncZwaveFromQr() {
    var z = K().decodeZwave(m.zwave.qr, "");
    if (!z || !z.dsk) return false;
    if (!str(m.zwave.dsk) || m.zwave.dskAuto) { m.zwave.dsk = z.dsk; m.zwave.dskAuto = true; return true; }
    return false;
  }

  // =========================================================================
  // Small builders
  // =========================================================================
  function input(id, value, o) {
    o = o || {};
    var el = h(o.textarea ? "textarea" : "input", {
      class: [o.textarea ? "textarea" : "input", o.mono && "input--mono", o.cls],
      id: id,
      type: o.textarea ? null : o.type || "text",
      dir: o.dir || (o.mono ? "ltr" : "auto"),
      placeholder: o.placeholder || null,
      inputmode: o.inputmode || null,
      autocomplete: "off",
      spellcheck: o.mono ? "false" : null,
      autocapitalize: o.caps || (o.mono ? "off" : null),
      maxlength: o.maxlength || null,
      rows: o.rows || null,
      required: o.required || null,
      "aria-describedby": o.describedby || null,
      list: o.list || null,
    });
    el.value = value == null ? "" : String(value);
    if (o.onInput) el.addEventListener("input", function () { o.onInput(el.value, el); });
    return el;
  }
  function field(forId, label, control, o) {
    o = o || {};
    return h("div", { class: ["field", o.cls], hidden: o.hidden || null, "data-field": o.key || null },
      h("label", { class: "field__label", for: forId, id: forId + "-l" },
        h("span", null, label),
        o.req ? h("span", { class: "req", "aria-hidden": "true" }, "*") : null,
        o.opt ? h("span", { class: "opt" }, o.opt) : null,
        o.aside || null),
      control, o.hint || null);
  }
  function hintEl(id) { return h("span", { class: "field__hint", id: id, hidden: true }); }
  function setHint(el, tone, text, iconName) {
    if (!el) return;
    el.classList.remove("field__hint--ok", "field__hint--warn", "field__hint--error", "field__hint--busy");
    el.classList.add("field__hint");
    if (tone) el.classList.add("field__hint--" + tone);
    AM.fill(el, text ? [iconName ? icon(iconName) : null, h("span", null, text)] : null);
    el.hidden = !text;
  }
  function markDirty() {
    if (!m) return;
    m.dirty = true;
  }

  // =========================================================================
  // Render
  // =========================================================================
  function build() {
    gen++;
    R = {};
    var body = AM.byId("editor-body");
    R.dup = h("div", { class: "notice notice--warn editor__dup", id: "editor-dup", role: "alert", hidden: true });
    AM.fill(body, R.dup, h("div", { class: "editor__grid" }, previewCol(), mainCol(), sideCol()));
    AM.byId("editor-title").textContent = m.id ? t("editor.edit", { name: m.origName || t("scan.unnamed") }) : t("editor.new");
    AM.byId("editor-provenance").hidden = m.provenance !== "scan";
    setProtoUi();
    validateAll();
    renderDup();
    refreshPreview(true);
  }

  // ---- Preview column ----
  function previewCol() {
    R.stage = h("div", { class: "stage", "aria-live": "off" });
    R.readouts = h("div", { class: "editor__readouts" });
    R.previewKey = "";
    return h("aside", { class: "editor__col editor__preview", "aria-label": t("editor.live_preview") },
      h("div", { class: "row" }, h("span", { class: "overline subtle" }, t("editor.live_preview")), h("span", { class: "spacer" }),
        h("span", { class: "tag" }, icon("refresh-cw"), h("span", null, t("editor.updates_live")))),
      R.stage, R.readouts);
  }

  var previewTimer = null;
  function refreshPreview(now) {
    clearTimeout(previewTimer);
    if (now) doPreview();
    else previewTimer = setTimeout(doPreview, 220);
  }
  function qrPromise(pc) {
    var ok = false;
    var p = m.proto;
    if (p === "matter") ok = K().decodeMatter(pc.qr_payload, "").from === "qr";
    else if (p === "homekit") ok = !!(HK() && HK().parseSetupUri(pc.qr_payload)) || digits(pc.manual_code).length === 8;
    else if (p === "zwave") ok = !!(ZW() && ZW().extractQrString(pc.qr_payload));
    else ok = !!pc.qr_payload && pc.qr_payload.length <= 2000;
    if (!ok) return Promise.resolve(null);
    return AM.qr.forPayload(pc, { label: K().qrLabel(pc) }).catch(function () { return null; });
  }
  function doPreview() {
    if (!m || !R.stage) return;
    var pc = pseudoCode();
    var key = JSON.stringify([pc.code_type, pc.manual_code, pc.qr_payload, pc.custom_standard, pc.setup_id, pc.homekit_category, pc.homekit_flag, m.proto]);
    if (key === R.previewKey) return;
    R.previewKey = key;
    var p = AM.proto.of(pc);
    R.stage.className = "stage p-" + p;
    var lbl = K().labelEl(pc, { target: 150, width: 196, qr: qrPromise(pc) });
    AM.fill(R.stage, h("div", { class: "stage__art", "aria-hidden": "true" }, K().orbits(280, 300, 0)), lbl);
    // decoded readouts
    var dec = null;
    if (p === "matter") { var md = K().decodeMatter(m.matter.qr, m.matter.manual); if (md.parsed) dec = { kind: "matter", parsed: md.parsed }; }
    else if (p === "zwave") { var zd = K().decodeZwave(m.zwave.qr, m.zwave.dsk); if (zd) dec = { kind: "zwave", parsed: zd }; }
    else if (p === "homekit") { var hd = K().decodeHomekit(m.homekit.uri, m.homekit.pairing, m.homekit.setupId, m.homekit.category); if (hd) dec = { kind: "homekit", parsed: hd }; }
    var myGen = gen, myKey = key;
    if (dec) {
      AM.fill(R.readouts, K().readoutsEl(dec, {
        compact: true,
        onNames: function (vendor, product) {
          if (!m || gen !== myGen || R.previewKey !== myKey) return;
          autofillNames(vendor, product);
        },
      }));
    } else {
      AM.fill(R.readouts, h("p", { class: "field__hint editor__readouts-empty" }, icon("binary"),
        h("span", null, p === "zigbee" || p === "tuya" || p === "other" ? t("editor.preview_verbatim") : t("editor.preview_empty"))));
    }
  }

  function autofillNames(vendor, product) {
    var changed = false;
    if (vendor && !m.touched.vendor && m.vendor !== vendor) { m.vendor = vendor; m.autofilled.vendor = true; if (R.vendor) R.vendor.value = vendor; changed = true; }
    if (product && !m.touched.product && m.product !== product) { m.product = product; m.autofilled.product = true; if (R.product) R.product.value = product; changed = true; }
    if (changed) {
      if (R.vendorAside) R.vendorAside.hidden = !(m.autofilled.vendor || m.autofilled.product);
      refreshCount();
      refreshSuggest();
    }
  }

  // ---- Main column: protocol, name, setup code, categories ----
  function mainCol() {
    return h("div", { class: "editor__col" }, protoSection(), nameField(), codeSection(), catsField());
  }

  function protoSection() {
    R.detected = h("span", { class: "aside detected", hidden: true });
    R.tiles = h("div", { class: "proto-tiles", role: "radiogroup", "aria-labelledby": "ed-proto-h" },
      PROTOS.map(function (p) {
        var meta = AM.proto.meta(p);
        var plate = meta.logo
          ? h("img", { class: "wordmark wordmark--" + p, src: meta.logo, alt: "", draggable: "false", decoding: "async" })
          : h("span", { class: "wordmark wordmark--text" }, t("code.protocol_other"));
        return h("button", { type: "button", class: ["proto-tile", "p-" + p], role: "radio", "aria-checked": "false", "data-value": p,
          onclick: function () { setProto(p, true); } },
          h("span", { class: "proto-tile__plate", "aria-hidden": "true" }, plate),
          h("span", { class: "proto-tile__name" }, h("span", null, AM.proto.label(p)), h("span", { class: "proto-tile__radio", "aria-hidden": "true" })));
      }));
    return h("section", { class: "editor__section", "aria-labelledby": "ed-proto-h" },
      h("h3", { id: "ed-proto-h" }, h("span", null, t("code.protocol")), R.detected), R.tiles);
  }

  function nameField() {
    R.nameHint = hintEl("ed-name-h");
    R.nameAside = h("span", { class: "aside autofill", hidden: !m.nameFrom }, icon("sparkles"), h("span", null, m.nameFrom === "db" ? t("editor.from_db") : t("editor.from_dcl")));
    R.name = input("ed-name", m.name, {
      required: true, describedby: "ed-name-h", placeholder: t("editor.name_placeholder"),
      onInput: function (v) {
        m.name = v;
        m.touched.name = true;
        m.nameFrom = null;
        R.nameAside.hidden = true;
        R.name.removeAttribute("aria-invalid");
        setHint(R.nameHint, null, "");
        refreshSuggest();
      },
    });
    return field("ed-name", t("code.name"), R.name, { req: true, aside: R.nameAside, hint: R.nameHint });
  }

  function codeSection() {
    R.codeTitle = h("span", null, "");
    R.stripStatus = h("p", { class: "field__hint editor__strip-status", role: "status", hidden: true });
    R.file = h("input", { type: "file", accept: "image/*", hidden: true, tabindex: "-1", "aria-hidden": "true" });
    R.file.addEventListener("change", function () {
      var f = R.file.files && R.file.files[0];
      R.file.value = "";
      if (f) photoPicked(f);
    });
    var strip = h("div", { class: "fill-strip" },
      h("span", { class: "fill-strip__txt" }, h("b", null, t("editor.fill_from_label")), h("span", null, t("editor.fill_from_label_hint"))),
      h("button", { type: "button", class: "btn btn--sm", onclick: function () { startScan("camera"); } }, icon("scan-line"), h("span", null, t("action.scan"))),
      h("button", { type: "button", class: "btn btn--sm", onclick: function () { R.file.click(); } }, icon("image-plus"), h("span", null, t("editor.photo"))),
      R.file);
    R.groups = {
      matter: matterGroup(),
      homekit: homekitGroup(),
      zwave: zwaveGroup(),
      other: otherGroup(),
    };
    return h("section", { class: "editor__section", "aria-labelledby": "ed-code-h" },
      h("h3", { id: "ed-code-h" }, icon("key-round"), R.codeTitle),
      strip, R.stripStatus, R.groups.matter, R.groups.homekit, R.groups.zwave, R.groups.other);
  }

  function payloadChanged() {
    markDirty();
    validateAll();
    refreshPreview();
    liveDup();
  }

  function matterGroup() {
    R.mtManHint = hintEl("ed-mt-man-h");
    R.mtQrHint = hintEl("ed-mt-qr-h");
    R.mtBadge = h("span", { class: "input-badge input-badge--ok", hidden: true }, icon("check"), h("span", null, t("editor.valid")));
    R.mtMan = input("ed-mt-man", m.matter.manual, {
      mono: true, inputmode: "numeric", placeholder: t("code.manual_placeholder"), describedby: "ed-mt-man-h",
      onInput: function (v) { m.matter.manual = v; payloadChanged(); },
    });
    R.mtMan.addEventListener("blur", function (e) {
      var el = e.currentTarget;
      var f = fmtMatter(el.value);
      if (m && el.isConnected && f !== el.value && MP()) {
        try { MP().parseManualPayload(digits(f)); el.value = f; m.matter.manual = f; } catch (err) { /* keep as typed */ }
      }
    });
    R.mtQr = input("ed-mt-qr", m.matter.qr, {
      mono: true, placeholder: t("code.qr_placeholder"), describedby: "ed-mt-qr-h", caps: "characters",
      onInput: function (v) { m.matter.qr = v; payloadChanged(); },
    });
    return h("div", { class: "stack ed-group", "data-group": "matter", style: "--gap:14px" },
      field("ed-mt-man", t("editor.matter_manual"), h("div", { class: "input-group input-group--badge" }, R.mtMan, R.mtBadge), { opt: t("editor.matter_manual_opt"), hint: R.mtManHint }),
      field("ed-mt-qr", t("code.other_qr"), R.mtQr, { opt: "MT:…", hint: R.mtQrHint }));
  }

  function homekitGroup() {
    var H = HK();
    R.hkUriHint = hintEl("ed-hk-uri-h");
    R.hkPinHint = hintEl("ed-hk-pin-h");
    R.hkSidHint = hintEl("ed-hk-sid-h");
    R.hkUri = input("ed-hk-uri", m.homekit.uri, {
      mono: true, placeholder: t("code.homekit_uri_placeholder"), describedby: "ed-hk-uri-h", caps: "characters",
      onInput: function (v) {
        m.homekit.uri = v;
        if (syncHomekitFromUri()) {
          R.hkPin.value = m.homekit.pairing;
          R.hkSid.value = m.homekit.setupId;
          R.hkCat.value = m.homekit.category;
        }
        payloadChanged();
      },
    });
    function afterPart() {
      if (recomposeHomekitUri()) R.hkUri.value = m.homekit.uri;
      payloadChanged();
    }
    R.hkPin = input("ed-hk-pin", m.homekit.pairing, {
      mono: true, inputmode: "numeric", maxlength: 11, placeholder: t("code.homekit_pairing_placeholder"), describedby: "ed-hk-pin-h",
      onInput: function (v) { m.homekit.pairing = v; afterPart(); },
    });
    R.hkPin.addEventListener("blur", function (e) { var el = e.currentTarget, f = fmtPairing(el.value); if (m && el.isConnected && f !== el.value) { el.value = f; m.homekit.pairing = f; } });
    R.hkSid = input("ed-hk-sid", m.homekit.setupId, {
      mono: true, maxlength: 4, placeholder: t("code.homekit_setup_id_placeholder"), describedby: "ed-hk-sid-h", caps: "characters",
      onInput: function (v) {
        var up = v.toUpperCase().replace(/[^0-9A-Z]/g, "");
        if (up !== v) R.hkSid.value = up;
        m.homekit.setupId = up;
        afterPart();
      },
    });
    var keys = H ? H.CATEGORY_KEYS.slice() : ["other"];
    keys.sort(function (a, b) { return AM.compare(K().hkCategoryText(a), K().hkCategoryText(b)); });
    R.hkCat = h("select", { class: "select", id: "ed-hk-cat" }, keys.map(function (k) { return h("option", { value: k }, K().hkCategoryText(k)); }));
    R.hkCat.value = m.homekit.category || "other";
    R.hkCat.addEventListener("change", function () { m.homekit.category = R.hkCat.value; afterPart(); });
    return h("div", { class: "stack ed-group", "data-group": "homekit", style: "--gap:14px", hidden: true },
      field("ed-hk-uri", t("editor.hk_uri"), R.hkUri, { opt: "X-HM://…", hint: R.hkUriHint }),
      field("ed-hk-pin", t("editor.hk_pairing"), R.hkPin, { opt: t("editor.hk_pairing_opt"), hint: R.hkPinHint }),
      h("div", { class: "field-row" },
        field("ed-hk-sid", t("editor.hk_setup_id"), R.hkSid, { hint: R.hkSidHint }),
        field("ed-hk-cat", t("code.homekit_category"), h("div", { class: "select-wrap" }, R.hkCat, icon("chevron-down")))));
  }

  function zwaveGroup() {
    R.zwDskHint = hintEl("ed-zw-dsk-h");
    R.zwQrHint = hintEl("ed-zw-qr-h");
    R.zwBadge = h("span", { class: "input-badge input-badge--ok", hidden: true }, icon("check"), h("span", null, t("editor.valid")));
    R.zwDsk = input("ed-zw-dsk", m.zwave.dsk, {
      mono: true, cls: "input--dsk", inputmode: "numeric", placeholder: t("code.zwave_dsk_placeholder"), describedby: "ed-zw-dsk-h",
      onInput: function (v) { m.zwave.dsk = v; m.zwave.dskAuto = false; payloadChanged(); },
    });
    R.zwDsk.addEventListener("blur", function (e) { var el = e.currentTarget, f = fmtDsk(el.value); if (m && el.isConnected && f !== el.value) { el.value = f; m.zwave.dsk = f; } });
    R.zwQr = input("ed-zw-qr", m.zwave.qr, {
      mono: true, textarea: true, rows: 2, inputmode: "numeric", placeholder: t("code.zwave_qr_placeholder"), describedby: "ed-zw-qr-h",
      onInput: function (v) {
        m.zwave.qr = v;
        if (syncZwaveFromQr()) R.zwDsk.value = m.zwave.dsk;
        payloadChanged();
      },
    });
    return h("div", { class: "stack ed-group", "data-group": "zwave", style: "--gap:14px", hidden: true },
      field("ed-zw-dsk", t("editor.zw_dsk"), R.zwDsk, { opt: t("editor.zw_dsk_opt"), hint: R.zwDskHint }),
      field("ed-zw-qr", t("editor.zw_qr"), R.zwQr, { opt: "90…", hint: R.zwQrHint }));
  }

  function otherGroup() {
    R.otStd = input("ed-ot-std", m.other.standard, {
      placeholder: t("code.other_standard_placeholder"),
      onInput: function (v) { m.other.standard = v; payloadChanged(); setCodeTitle(); },
    });
    R.otMan = input("ed-ot-man", m.other.manual, {
      mono: true, placeholder: t("code.other_manual_placeholder"),
      onInput: function (v) { m.other.manual = v; payloadChanged(); },
    });
    R.otQr = input("ed-ot-qr", m.other.qr, {
      mono: true, textarea: true, rows: 3, placeholder: t("code.other_qr_placeholder"), describedby: "ed-ot-qr-h",
      onInput: function (v) { m.other.qr = v; payloadChanged(); },
    });
    R.otStdField = field("ed-ot-std", t("code.other_standard"), R.otStd, {});
    return h("div", { class: "stack ed-group", "data-group": "other", style: "--gap:14px", hidden: true },
      R.otStdField,
      field("ed-ot-man", t("code.other_manual"), R.otMan, {}),
      field("ed-ot-qr", t("code.other_qr"), R.otQr, { hint: h("span", { class: "field__hint", id: "ed-ot-qr-h" }, t("editor.verbatim_hint")) }));
  }

  function catsField() {
    R.cats = h("div", { class: "row row--wrap editor__cats", role: "group", "aria-labelledby": "ed-cat-l", style: "--gap:6px" });
    renderCats();
    return h("div", { class: "field" },
      h("span", { class: "field__label", id: "ed-cat-l" }, h("span", null, t("categories.title")), h("span", { class: "opt" }, t("editor.cats_opt"))),
      R.cats);
  }
  function renderCats() {
    if (!R.cats) return;
    m.cats = m.cats.filter(function (id) { return AM.cat.known(id); });
    AM.fill(R.cats,
      AM.cat.list().map(function (c) {
        var on = m.cats.indexOf(c.id) >= 0;
        return h("button", { type: "button", class: "chip", "aria-pressed": String(on), "data-id": c.id,
          onclick: function (e) {
            var i = m.cats.indexOf(c.id);
            if (i >= 0) m.cats.splice(i, 1); else m.cats.push(c.id);
            e.currentTarget.setAttribute("aria-pressed", String(i < 0));
            markDirty();
          } },
          AM.cat.markEl(c, { size: "sm" }), h("span", { dir: "auto" }, c.name));
      }),
      h("button", { type: "button", class: "chip chip--dashed", onclick: newCategory }, icon("plus"), h("span", null, t("categories.dialog_new"))));
  }
  function newCategory() {
    if (!AM.can("openCategoryEditor")) return;
    var myGen = gen;
    AM.act("openCategoryEditor", null, {
      onSaved: function (cat) {
        if (!m || !cat || !cat.id) return;
        if (m.cats.indexOf(cat.id) < 0) m.cats.push(cat.id);
        markDirty();
        if (gen === myGen) renderCats(); else renderCats();
      },
    });
  }

  // ---- Side column: HA device + details ----
  function sideCol() {
    return h("div", { class: "editor__col" }, haSection(), detailsSection());
  }

  function haSection() {
    R.haSec = h("section", { class: "editor__section", "aria-labelledby": "ed-ha-h" });
    fillHa();
    return R.haSec;
  }
  function fillHa() {
    var sec = R.haSec;
    if (!sec) return;
    var head = h("h3", { id: "ed-ha-h" }, icon("house-plug"), h("span", null, t("editor.ha_title")), h("span", { class: "aside" }, t("editor.ha_optional")));
    if (!AM.ha.available()) {
      AM.fill(sec, head,
        m.haId ? h("div", { class: "suggest suggest--linked" },
          h("span", { class: "suggest__icon" }, icon("house-plug")),
          h("span", { class: "suggest__txt" }, h("span", null, t("detail.linked_device")), h("b", { dir: "auto" }, m.haText || t("detail.linked_unknown"))),
          h("button", { type: "button", class: "btn btn--sm", onclick: function () { m.haId = ""; m.haText = ""; markDirty(); fillHa(); } }, icon("unlink"), h("span", null, t("detail.unlink")))) : null,
        h("div", { class: "notice" }, icon("cloud-off"), h("div", { class: "notice__body" }, h("span", null, t("editor.ha_unavailable")))));
      R.haInput = R.haStatus = R.haSuggest = R.haList = null;
      return;
    }
    R.haInput = h("input", {
      class: "input", id: "ed-ha", type: "text", role: "combobox", "aria-expanded": "false", "aria-controls": "ed-ha-list",
      "aria-autocomplete": "list", "aria-labelledby": "ed-ha-h", autocomplete: "off", spellcheck: "false", dir: "auto",
      placeholder: t("editor.ha_search"),
    });
    R.haInput.value = m.haId ? (m.haText || "") : m.haText;
    R.haClear = h("button", { type: "button", class: "icon-btn icon-btn--xs search__end", tip: t("editor.ha_clear"), hidden: !R.haInput.value }, icon("x"));
    R.haList = h("ul", { class: "combobox__list menu", id: "ed-ha-list", role: "listbox", "aria-labelledby": "ed-ha-h", hidden: true });
    R.haStatus = h("p", { class: "field__hint field__hint--ok", hidden: true });
    R.haSuggest = h("div", { class: "suggest", hidden: true });
    AM.fill(sec, head, h("div", { class: "combobox search" }, icon("search"), R.haInput, R.haClear, R.haList), R.haStatus, R.haSuggest);
    wireCombobox();
    refreshHaStatus();
    refreshSuggest();
  }

  var haActive = -1, haItems = [], haBlurTimer = null;
  function haOpen() { return R.haList && !R.haList.hidden; }
  function haShow() {
    if (!R.haList) return;
    renderHaList();
    R.haList.hidden = false;
    R.haInput.setAttribute("aria-expanded", "true");
  }
  function haHide() {
    if (!R.haList) return;
    R.haList.hidden = true;
    R.haInput.setAttribute("aria-expanded", "false");
    R.haInput.removeAttribute("aria-activedescendant");
    haActive = -1;
  }
  function renderHaList() {
    var q = R.haInput.value;
    var linked = m.haId ? AM.ha.device(m.haId) : null;
    if (linked && lc(q) === lc(AM.ha.label(linked))) q = "";
    var sug = !m.haId ? AM.ha.suggest(pseudoCode()) : null;
    haItems = AM.ha.search(q, 25);
    if (sug && !str(q)) haItems = [sug].concat(haItems.filter(function (d) { return d.id !== sug.id; })).slice(0, 25);
    haActive = -1;
    var lis = haItems.map(function (d, i) {
      return h("li", { class: "menu__item combobox__opt", role: "option", id: "ed-ha-opt-" + i, "aria-selected": "false", "data-i": String(i) },
        icon(d.id === m.haId ? "check" : "house"),
        h("span", { class: "combobox__txt" }, h("b", { dir: "auto" }, d.name), d.area ? h("small", { dir: "auto" }, d.area) : null),
        sug && d.id === sug.id ? h("span", { class: "tag tag--accent" }, t("scan.suggested")) : h("span"));
    });
    if (!lis.length) lis.push(h("li", { class: "combobox__empty", role: "presentation" }, t("editor.ha_none")));
    lis.push(h("li", { class: "combobox__legend", role: "presentation", "aria-hidden": "true" },
      h("span", null, h("span", { class: "kbd" }, "↑"), h("span", { class: "kbd" }, "↓"), " ", t("editor.legend_move")),
      h("span", null, h("span", { class: "kbd" }, "↵"), " ", t("editor.legend_pick")),
      h("span", null, h("span", { class: "kbd" }, "Esc"), " ", t("editor.legend_close"))));
    AM.fill(R.haList, lis);
    var cur = haItems.findIndex(function (d) { return d.id === m.haId; });
    if (cur >= 0) setHaActive(cur, true);
  }
  function setHaActive(i, noScroll) {
    var opts = AM.$$(".combobox__opt", R.haList);
    opts.forEach(function (o, j) {
      o.classList.toggle("is-hover", j === i);
      o.setAttribute("aria-selected", String(j === i));
    });
    haActive = i;
    if (i >= 0 && opts[i]) {
      R.haInput.setAttribute("aria-activedescendant", opts[i].id);
      if (!noScroll) opts[i].scrollIntoView({ block: "nearest" });
    } else R.haInput.removeAttribute("aria-activedescendant");
  }
  function haSelect(dev) {
    if (!dev) return;
    m.haId = dev.id;
    m.haText = AM.ha.label(dev);
    R.haInput.value = m.haText;
    haHide();
    markDirty();
    refreshHaStatus();
    refreshSuggest();
  }
  function exactDevice(text) {
    var q = lc(text);
    if (!q) return null;
    var list = AM.ha.devices();
    for (var i = 0; i < list.length; i++) if (lc(AM.ha.label(list[i])) === q) return list[i];
    return null;
  }
  function wireCombobox() {
    var inp = R.haInput;
    inp.addEventListener("focus", function () { clearTimeout(haBlurTimer); haShow(); });
    inp.addEventListener("click", function () { if (!haOpen()) haShow(); });
    inp.addEventListener("blur", function () { haBlurTimer = setTimeout(haHide, 150); });
    inp.addEventListener("input", function () {
      m.haText = inp.value;
      var dev = exactDevice(inp.value);
      m.haId = dev ? dev.id : ""; // an id is stored only on an exact match
      markDirty();
      haShow();
      refreshHaStatus();
      refreshSuggest();
    });
    inp.addEventListener("keydown", function (e) {
      var n = haItems.length;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (!haOpen()) { haShow(); if (!n) return; }
        if (!n) return;
        var d = e.key === "ArrowDown" ? 1 : -1;
        setHaActive(haActive < 0 ? (d > 0 ? 0 : n - 1) : (haActive + d + n) % n);
      } else if (e.key === "Enter") {
        if (!haOpen()) return; // closed: Enter submits the form
        e.preventDefault();
        if (haActive >= 0 && haItems[haActive]) haSelect(haItems[haActive]);
        else if (n === 1) haSelect(haItems[0]);
        else haHide();
      } else if (e.key === "Escape") {
        if (!haOpen()) return;
        e.preventDefault(); // core skips defaultPrevented keys: the editor stays open
        haHide();
      } else if (e.key === "Tab") {
        haHide();
      }
    });
    // Tap/click selection that never loses the input's focus first (Android WebView safe).
    R.haList.addEventListener("mousedown", function (e) { e.preventDefault(); });
    R.haList.addEventListener("click", function (e) {
      var li = e.target.closest && e.target.closest(".combobox__opt");
      if (li) haSelect(haItems[+li.getAttribute("data-i")]);
    });
    R.haClear.addEventListener("click", function () {
      m.haId = "";
      m.haText = "";
      inp.value = "";
      markDirty();
      refreshHaStatus();
      refreshSuggest();
      inp.focus();
    });
  }
  function refreshHaStatus() {
    if (!R.haStatus || !R.haInput) return;
    if (R.haClear) R.haClear.hidden = !R.haInput.value;
    if (m.haId) {
      var id = m.haId;
      AM.fill(R.haStatus, icon("circle-check"), h("span", null, t("editor.ha_linked")),
        h("button", { type: "button", class: "link-btn", onclick: function () { AM.ha.openDevice(id); } }, h("span", null, t("action.open_in_ha")), icon("external-link")));
      R.haStatus.classList.add("field__hint--ok");
      R.haStatus.hidden = false;
    } else if (str(R.haInput.value)) {
      AM.fill(R.haStatus, icon("info"), h("span", null, t("editor.ha_pick")));
      R.haStatus.classList.remove("field__hint--ok");
      R.haStatus.hidden = false;
    } else {
      R.haStatus.hidden = true;
    }
  }
  var suggestTimer = null;
  function refreshSuggest() {
    clearTimeout(suggestTimer);
    suggestTimer = setTimeout(function () {
      if (!m || !R.haSuggest) return;
      var sug = !m.haId ? AM.ha.suggest(pseudoCode()) : null;
      if (!sug) { R.haSuggest.hidden = true; return; }
      AM.fill(R.haSuggest,
        h("span", { class: "suggest__icon" }, icon("sparkles")),
        h("span", { class: "suggest__txt" }, h("span", null, t("editor.suggested_match")),
          h("b", { dir: "auto" }, sug.area ? t("detail.device_area", { name: sug.name, area: sug.area }) : sug.name)),
        h("button", { type: "button", class: "btn btn--sm", onclick: function () { haSelect(sug); } }, icon("link-2"), h("span", null, t("editor.link"))));
      R.haSuggest.hidden = false;
    }, 150);
  }

  function detailsSection() {
    var n = filledCount();
    R.filled = h("span", { class: "tag", hidden: !n }, t("editor.details_filled", { count: n }));
    var open = m.detailsOpen != null ? m.detailsOpen : n > 0;
    R.details = h("details", { class: "disclosure editor__details", open: open || null },
      h("summary", null, icon("layers"), h("span", null, t("code.device_details")), R.filled, icon("chevron-down", "chev")),
      detailsBody());
    R.details.addEventListener("toggle", function () { if (m) m.detailsOpen = R.details.open; });
    return R.details;
  }
  function detailsBody() {
    var inUse = h("input", { type: "checkbox", class: "switch", role: "switch", id: "ed-inuse" });
    inUse.checked = !!m.inUse;
    inUse.addEventListener("change", function () { m.inUse = inUse.checked; markDirty(); refreshCount(); });
    R.vendorAside = h("span", { class: "aside autofill", hidden: !(m.autofilled.vendor || m.autofilled.product) }, icon("sparkles"), h("span", null, t("editor.from_payload")));
    R.vendor = input("ed-vendor", m.vendor, { placeholder: t("code.device_vendor_placeholder"), onInput: function (v) { m.vendor = v; m.touched.vendor = true; markDirty(); refreshCount(); refreshSuggest(); } });
    R.product = input("ed-product", m.product, { placeholder: t("code.device_product_placeholder"), onInput: function (v) { m.product = v; m.touched.product = true; markDirty(); refreshCount(); refreshSuggest(); } });
    var typeList = h("datalist", { id: "ed-types" }, typeOptions().map(function (v) { return h("option", { value: v }); }));
    R.type = input("ed-type", m.type, { list: "ed-types", placeholder: t("code.device_type_placeholder"), onInput: function (v) { m.type = v; markDirty(); refreshCount(); } });
    R.area = input("ed-area", m.area, { placeholder: t("code.area_placeholder"), onInput: function (v) { m.area = v; markDirty(); refreshCount(); renderAreas(); } });
    R.areaSugg = h("div", { class: "area-sugg", hidden: true });
    R.conn = h("div", { class: "row row--wrap", role: "group", "aria-labelledby": "ed-conn-l", style: "--gap:6px" });
    renderConn();
    var desc = input("ed-desc", m.description, { placeholder: t("code.description_placeholder"), onInput: function (v) { m.description = v; markDirty(); refreshCount(); } });
    var notes = input("ed-notes", m.notes, { textarea: true, rows: 2, placeholder: t("editor.notes_placeholder"), onInput: function (v) { m.notes = v; markDirty(); refreshCount(); } });
    var body = h("div", { class: "stack editor__details-body", style: "--gap:14px" },
      h("label", { class: "toggle-row", for: "ed-inuse" },
        h("span", { class: "toggle-row__text" }, h("span", { class: "toggle-row__title" }, t("code.in_use")), h("span", { class: "toggle-row__desc" }, t("editor.in_use_desc"))),
        inUse),
      h("div", { class: "field-row" },
        field("ed-vendor", t("filter.vendor"), R.vendor, { aside: R.vendorAside }),
        field("ed-product", t("filter.product"), R.product, {})),
      h("div", { class: "field-row" },
        field("ed-type", t("filter.type"), h("div", null, R.type, typeList), {}),
        field("ed-area", t("code.area"), R.area, {})),
      R.areaSugg,
      h("div", { class: "field" }, h("span", { class: "field__label", id: "ed-conn-l" }, t("code.connectivity")), R.conn),
      field("ed-desc", t("code.description"), desc, {}),
      field("ed-notes", t("code.notes"), notes, {}));
    renderAreas();
    return body;
  }
  function typeOptions() {
    var seen = new Set();
    var out = [];
    AM.store.vault.codes.map(function (c) { return str(c.device_type); }).concat(DEVICE_TYPES).forEach(function (v) {
      var k = lc(v);
      if (v && !seen.has(k)) { seen.add(k); out.push(v); }
    });
    return out.slice(0, 60);
  }
  function renderAreas() {
    if (!R.areaSugg) return;
    var areas = AM.ha.areas() || [];
    if (!areas.length) { R.areaSugg.hidden = true; return; }
    var q = lc(m.area);
    var exact = areas.some(function (a) { return lc(a) === q; });
    var list = areas.filter(function (a) { return !q || exact || lc(a).indexOf(q) >= 0; }).slice(0, 10);
    if (!list.length) { R.areaSugg.hidden = true; return; }
    AM.fill(R.areaSugg, h("span", null, t("editor.ha_areas")), list.map(function (a) {
      return h("button", { type: "button", class: "chip", dir: "auto", "aria-pressed": String(lc(a) === q),
        onclick: function () { m.area = a; R.area.value = a; markDirty(); refreshCount(); renderAreas(); } }, a);
    }));
    R.areaSugg.hidden = false;
  }
  function renderConn() {
    if (!R.conn) return;
    AM.fill(R.conn, AM.filters.CONN.map(function (c) {
      return h("button", { type: "button", class: "chip", "aria-pressed": String(!!m.conn[c.key]), "data-key": c.key,
        onclick: function (e) {
          m.conn[c.key] = !m.conn[c.key];
          e.currentTarget.setAttribute("aria-pressed", String(m.conn[c.key]));
          markDirty();
          refreshCount();
        } }, icon(c.icon), h("span", null, t(c.label)));
    }));
  }
  function refreshCount() {
    if (!R.filled) return;
    var n = filledCount();
    R.filled.textContent = t("editor.details_filled", { count: n });
    R.filled.hidden = !n;
  }

  // ---- Protocol switching ----
  function setCodeTitle() {
    if (!R.codeTitle) return;
    var p = m.proto;
    var name = p === "other" && str(m.other.standard) ? str(m.other.standard) : AM.proto.label(p);
    R.codeTitle.textContent = t("editor.setup_code_title", { protocol: name });
  }
  function setProtoUi() {
    AM.$$('.proto-tile', R.tiles).forEach(function (b) { b.setAttribute("aria-checked", String(b.getAttribute("data-value") === m.proto)); });
    AM.radio.sync(R.tiles);
    var g = m.proto === "zigbee" || m.proto === "tuya" ? "other" : m.proto;
    Object.keys(R.groups).forEach(function (k) { R.groups[k].hidden = k !== g; });
    R.otStdField.hidden = m.proto !== "other";
    setCodeTitle();
    if (m.detected) {
      AM.fill(R.detected, icon("sparkles", "icon--sm"),
        h("span", null, AM.tNodes("editor.detected_from_qr", { protocol: "" }, { protocol: h("b", null, AM.proto.label(m.detected)) })));
      R.detected.hidden = false;
    } else R.detected.hidden = true;
    setStripNote();
  }
  function setProto(p, manual) {
    if (!m || m.proto === p) { if (m) AM.radio.sync(R.tiles); return; }
    m.proto = p;
    m.dup = null;
    if (manual) {
      m.detected = null;
      m.scanNote = null;
      var c = AM.proto.meta(p).conn; // Z-Wave / Zigbee: tick that radio (never untick)
      if (c && !m.conn[c]) { m.conn[c] = true; renderConn(); refreshCount(); }
    }
    markDirty();
    setProtoUi();
    validateAll();
    refreshPreview(true);
    liveDup();
  }

  // ---- Validation hints ----
  function validateAll() {
    if (!m || !R.groups) return;
    var p = m.proto;
    if (p === "matter") validateMatter();
    else if (p === "homekit") validateHomekit();
    else if (p === "zwave") validateZwave();
  }
  function validateMatter() {
    var M = MP();
    var man = str(m.matter.manual), qr = str(m.matter.qr);
    var d = digits(man);
    var pm = null, pq = null;
    R.mtBadge.hidden = true;
    R.mtMan.removeAttribute("aria-invalid");
    R.mtQr.removeAttribute("aria-invalid");
    if (qr && M) {
      if (!/^MT:/i.test(qr)) { setHint(R.mtQrHint, "error", t("editor.mt_qr_prefix"), "circle-alert"); R.mtQr.setAttribute("aria-invalid", "true"); }
      else {
        try { pq = M.parseQrPayload(qr); setHint(R.mtQrHint, null, ""); }
        catch (e) { setHint(R.mtQrHint, "error", t("editor.mt_qr_invalid"), "circle-alert"); R.mtQr.setAttribute("aria-invalid", "true"); }
      }
    } else setHint(R.mtQrHint, null, "");
    if (!man) { setHint(R.mtManHint, null, pq ? t("editor.mt_from_qr") : ""); return; }
    if (d.length !== 11 && d.length !== 21) { setHint(R.mtManHint, "warn", t("editor.mt_len"), "circle-alert"); return; }
    try { pm = M ? M.parseManualPayload(d) : null; } catch (e) {
      setHint(R.mtManHint, "error", e && e.message === "check digit" ? t("editor.mt_check_digit") : t("editor.mt_invalid"), "circle-alert");
      R.mtMan.setAttribute("aria-invalid", "true");
      return;
    }
    if (!pm) return;
    R.mtBadge.hidden = false;
    if (pq) {
      var match = pm.pincode === pq.pincode && pm.short_discriminator === (pq.long_discriminator >> 8);
      if (match) setHint(R.mtManHint, "ok", t("editor.check_ok"), "shield-check");
      else { setHint(R.mtManHint, "error", t("editor.mt_mismatch"), "circle-alert"); R.mtBadge.hidden = true; }
    } else setHint(R.mtManHint, "ok", t("editor.check_digit_ok"), "shield-check");
  }
  function validateHomekit() {
    var H = HK();
    if (!H) return;
    var uri = str(m.homekit.uri);
    var parsed = uri ? H.parseSetupUri(uri) : null;
    var pinD = digits(m.homekit.pairing);
    var uriPin = parsed ? H.decodePairingFromUri(parsed.uri) : "";
    if (uri && (!parsed || !/^\d{8}$/.test(uriPin))) setHint(R.hkUriHint, "error", t("editor.hk_uri_invalid"), "circle-alert");
    else if (parsed) {
      setHint(R.hkUriHint, "ok", t("editor.hk_derived", {
        code: fmtPairing(uriPin), setup: H.normalizeSetupId(m.homekit.setupId) || "—", category: K().hkCategoryText(m.homekit.category),
      }), "circle-check");
    } else setHint(R.hkUriHint, null, "");
    if (str(m.homekit.pairing) && pinD.length !== 8) setHint(R.hkPinHint, "warn", t("editor.hk_pairing_len"), "circle-alert");
    else if (parsed && pinD.length === 8 && uriPin && pinD !== uriPin) setHint(R.hkPinHint, "error", t("editor.hk_mismatch"), "circle-alert");
    else if (!uri && pinD.length === 8) setHint(R.hkPinHint, null, t("editor.hk_no_uri"), "info");
    else setHint(R.hkPinHint, null, "");
    var sid = str(m.homekit.setupId);
    if (sid && !H.normalizeSetupId(sid)) setHint(R.hkSidHint, "warn", t("editor.hk_setup_len"), "circle-alert");
    else setHint(R.hkSidHint, null, "");
  }
  function validateZwave() {
    var Z = ZW();
    if (!Z) return;
    var dsk = str(m.zwave.dsk), qr = str(m.zwave.qr);
    var d = digits(dsk);
    var z = qr ? K().decodeZwave(qr, "") : null;
    R.zwBadge.hidden = true;
    if (qr && !z) setHint(R.zwQrHint, "error", t("editor.zw_qr_invalid"), "circle-alert");
    else if (z) setHint(R.zwQrHint, "ok", z.smartStart ? t("editor.zw_qr_ok_smartstart") : t("editor.zw_qr_ok"), "shield-check");
    else setHint(R.zwQrHint, null, "");
    if (!dsk) { setHint(R.zwDskHint, null, ""); return; }
    if (d.length !== 40) { setHint(R.zwDskHint, "warn", t("editor.zw_dsk_len"), "circle-alert"); return; }
    if (!Z.isValidDskFormatted(Z.formatDsk(d))) { setHint(R.zwDskHint, "error", t("editor.zw_dsk_invalid"), "circle-alert"); return; }
    if (z && digits(z.dsk) !== d) { setHint(R.zwDskHint, "error", t("editor.zw_dsk_mismatch"), "circle-alert"); return; }
    R.zwBadge.hidden = false;
    setHint(R.zwDskHint, "ok", t("editor.zw_dsk_ok", { pin: d.slice(0, 5) }), "shield-check");
  }

  // ---- Duplicates ----
  function renderDup() {
    if (!R.dup) return;
    var ex = m.dup;
    if (!ex) { R.dup.hidden = true; AM.fill(R.dup); return; }
    AM.fill(R.dup, icon("triangle-alert"),
      h("div", { class: "notice__body" },
        h("span", { class: "notice__title", dir: "auto" }, t("editor.dup_title", { name: str(ex.name) || t("scan.unnamed") })),
        h("span", null, t("editor.dup_body")),
        h("div", { class: "notice__actions" },
          h("button", { type: "button", class: "btn btn--sm", onclick: function () { openExisting(ex.id); } }, icon("maximize-2"), h("span", null, t("scan.open_existing"))))));
    R.dup.hidden = false;
  }
  function showDup(existing, scroll) {
    m.dup = existing ? { id: existing.id, name: existing.name } : null;
    renderDup();
    if (existing && scroll) {
      AM.byId("editor-body").scrollTo({ top: 0, behavior: AM.mq.reducedMotion.matches ? "auto" : "smooth" });
      AM.haptic("warning");
    }
  }
  var dupTimer = null;
  function liveDup() {
    clearTimeout(dupTimer);
    dupTimer = setTimeout(function () {
      if (!m || !SCAN()) return;
      var pb = payloadBody();
      if (!pb.manual_code && !pb.qr_payload) { showDup(null); return; }
      var d = SCAN().findDuplicate(AM.store.vault.codes, pb, m.id);
      showDup(d ? { id: d.id, name: d.name } : null);
    }, 300);
  }
  async function openExisting(id) {
    if (!AM.store.codeById.has(id)) {
      try { await AM.refresh({ force: true }); } catch (e) { AM.reportError(e); return; }
    }
    if (AM.store.codeById.has(id)) AM.act("openDetail", id);
    else AM.toast({ message: t("error.code_not_found"), tone: "warn" });
  }

  // ---- Scan / photo ----
  function startScan(source) {
    if (!m) return;
    if (!AM.can("openScanner")) return;
    var myGen = gen;
    AM.act("openScanner", {
      mode: "single", target: "editor", source: source || "camera", excludeId: m.id || null,
      onResult: function (parsed) { if (m && gen >= myGen) applyScan(parsed); },
    });
  }
  function setStrip(tone, text, iconName) {
    if (!R.stripStatus) return;
    setHint(R.stripStatus, tone, text, iconName);
    R.stripStatus.classList.toggle("is-busy", tone === "busy");
  }
  function setStripNote() {
    if (!m.scanNote) { if (R.stripStatus && !R.stripStatus.classList.contains("is-busy") && R.stripStatus.dataset.kind === "note") setStrip(null, ""); return; }
    setStrip("warn", m.scanNote === "unknown" ? t("editor.scan_unknown") : t("editor.scan_low"), "info");
    R.stripStatus.dataset.kind = "note";
  }
  async function photoPicked(file) {
    var E = global.AntiMatterScanEngine;
    if (!E || !E.decodeImage) { setStrip("error", t("scan.photo_fail"), "circle-alert"); return; }
    var myGen = gen;
    setStrip("busy", t("scan.reading_photo"), "loader-circle");
    R.stripStatus.dataset.kind = "busy";
    try {
      var res = await E.decodeImage(file, { multi: true });
      if (!m || gen !== myGen) return;
      var list = [];
      (res.results || []).forEach(function (r) {
        if (r && r.text) list = list.concat(SCAN().parseScannedTextAll(r.text));
      });
      if (!list.length) { var nf = new Error("not_found"); nf.code = "not_found"; throw nf; }
      var pick = list.filter(function (x) { return x.recognized !== false; })[0] || list[0];
      AM.log("Scan: editor photo protocol=" + pick.code_type + " codes=" + list.length);
      applyScan(pick);
      if (list.length > 1) { setStrip(null, t("editor.photo_many", { count: list.length }), "info"); R.stripStatus.dataset.kind = "info"; }
    } catch (e) {
      if (!m || gen !== myGen) return;
      var code = e && e.code;
      setStrip("error", code === "not_found" ? t("scan.no_code_in_image") : code === "unsupported_image" ? t("editor.photo_unsupported") : t("scan.photo_fail"), "circle-alert");
      R.stripStatus.dataset.kind = "error";
      AM.log("Scan: editor photo failed reason=" + (code || "error"), "warning");
    }
  }
  function applyScan(parsed) {
    if (!m || !parsed) return;
    applyToModel(parsed);
    if (!m.provenance) m.provenance = "scan";
    var scroll = AM.byId("editor-body").scrollTop;
    build();
    AM.byId("editor-body").scrollTop = scroll;
    liveDup();
    AM.haptic("success");
    setTimeout(function () {
      if (!m || !AM.sheets.isOpen(SHEET) || AM.sheets.top() !== SHEET) return;
      if (!AM.mq.coarse.matches && R.name) R.name.focus({ preventScroll: true });
    }, 0);
  }

  // ---- Save ----
  var saving = false;
  function setBusy(on) {
    ["editor-save", "editor-save-next"].forEach(function (id) {
      var b = AM.byId(id);
      b.disabled = on;
      b.setAttribute("aria-busy", String(on));
    });
  }
  async function save(next) {
    if (!m || saving) return;
    if (!str(m.name)) {
      setHint(R.nameHint, "error", t("editor.name_required"), "circle-alert");
      R.name.setAttribute("aria-invalid", "true");
      R.name.focus();
      R.name.scrollIntoView({ block: "center", behavior: AM.mq.reducedMotion.matches ? "auto" : "smooth" });
      AM.haptic("failure");
      return;
    }
    var body = buildBody();
    var dupBody = {
      code_type: body.code_type, qr_payload: body.qr_payload || "", manual_code: body.manual_code || "",
      setup_id: body.setup_id || "", homekit_category: body.homekit_category || "other",
      homekit_flag: body.homekit_flag == null ? 2 : body.homekit_flag, custom_standard: body.custom_standard || "",
    };
    if ((dupBody.manual_code || dupBody.qr_payload) && SCAN()) {
      var local = SCAN().findDuplicate(AM.store.vault.codes, body, m.id);
      if (local) { showDup({ id: local.id, name: local.name }, true); return; }
    }
    saving = true;
    setBusy(true);
    var model = m;
    try {
      if (dupBody.manual_code || dupBody.qr_payload) {
        try {
          var chk = await AM.api("/codes/check-duplicate", { method: "POST", body: Object.assign({ exclude_id: m.id || null }, dupBody) });
          if (chk && chk.duplicate && chk.duplicate.existing) { if (m === model) showDup(chk.duplicate.existing, true); return; }
        } catch (e) { /* the server still refuses a duplicate with 409 */ }
      }
      var saved;
      try {
        saved = await put(body);
      } catch (e) {
        // The server accepts ids of categories in the Trash; "not found" means one was purged
        // elsewhere while this form was open. Re-read the vault + Trash and keep every id that
        // still exists (live or trashed, so G1 holds), then retry once.
        if (e && e.code === "category_not_found" && body.category_ids) {
          await AM.refresh({ force: true });
          var trashed = new Set(AM.store.trash.categories.map(function (c) { return c.id; }));
          body.category_ids = body.category_ids.filter(function (id) { return AM.cat.known(id) || trashed.has(id); });
          saved = await put(body);
        } else throw e;
      }
      if (m !== model) return;
      m.dirty = false;
      var name = str(body.name);
      var wasNew = !m.id;
      if (m.id) AM.qr.forget(m.id);
      AM.haptic("success");
      AM.log("Code saved: protocol=" + m.proto + " mode=" + (wasNew ? "new" : "edit") + " via=" + (m.provenance || "manual"));
      AM.sheets.close(SHEET, saved, "api");
      AM.toast({ message: t(wasNew ? "toast.code_saved" : "toast.code_updated", { name: name }), icon: "circle-check" });
      try { await AM.refresh({ force: true }); } catch (e) { AM.reportError(e); }
      if (next && AM.can("openScanner")) AM.act("openScanner", { mode: "vault", source: "camera" });
    } catch (e) {
      if (e && e.code === "duplicate" && e.existing) { if (m === model) showDup(e.existing, true); return; }
      AM.haptic("failure");
      AM.reportError(e);
    } finally {
      saving = false;
      setBusy(false);
    }
  }
  function put(body) {
    return m.id
      ? AM.api("/codes/" + encodeURIComponent(m.id), { method: "PUT", body: body })
      : AM.api("/codes", { method: "POST", body: body });
  }

  // =========================================================================
  // Open / close
  // =========================================================================
  var wired = false;
  function wireOnce() {
    if (wired) return;
    wired = true;
    var form = AM.byId(SHEET);
    form.addEventListener("submit", function (e) { e.preventDefault(); save(false); });
    form.addEventListener("input", function (e) { if (e.target && e.target.type !== "file") markDirty(); });
    AM.byId("editor-save-next").addEventListener("click", function () { save(true); });
    AM.byId("editor-scan").addEventListener("click", function () { startScan("camera"); });
  }

  async function confirmDiscard() {
    if (!m || !m.dirty) return true;
    return AM.confirm({
      title: t("editor.discard_title"),
      message: t("editor.discard_body"),
      confirmLabel: t("editor.discard"),
      cancelLabel: t("editor.keep_editing"),
      icon: "triangle-alert",
      okIcon: false,
    });
  }

  function openEditor(code, prefill, opts) {
    opts = opts || {};
    wireOnce();
    if (AM.sheets.isOpen(SHEET) && m) {
      // Never a second editor: a scan result fills the open form.
      if (prefill) applyScan(prefill);
      if (AM.sheets.top() === SHEET) AM.sheets.open(SHEET);
      return true;
    }
    if (typeof code === "string") code = AM.store.codeById.get(code) || null;
    else if (code && code.id) code = AM.store.codeById.get(code.id) || code;
    m = modelFrom(code || null);
    m.provenance = opts.provenance || (prefill ? "scan" : null);
    if (prefill) applyToModel(prefill);
    build();
    AM.byId("editor-body").scrollTop = 0;
    AM.sheets.open(SHEET, {
      initialFocus: AM.mq.coarse.matches ? null : "#ed-name",
      beforeClose: confirmDiscard,
      onClose: function () {
        haHide();
        clearTimeout(previewTimer);
        clearTimeout(dupTimer);
        clearTimeout(suggestTimer);
        m = null;
        R = {};
        gen++;
      },
    });
    if (prefill) liveDup();
    return true;
  }

  AM.shortcuts.register("mod+enter", function () { save(false); }, { scope: SHEET, allowInInput: true });

  AM.on("vault", function () {
    if (!m || !AM.sheets.isOpen(SHEET)) return;
    renderCats();
  });
  AM.on("ha", function () {
    if (!m || !AM.sheets.isOpen(SHEET)) return;
    if (m.haId && !m.haText) { var d = AM.ha.device(m.haId); if (d) m.haText = AM.ha.label(d); }
    fillHa();
    renderAreas();
  });
  AM.on("locale", function () {
    if (!m || !AM.sheets.isOpen(SHEET)) return;
    var scroll = AM.byId("editor-body").scrollTop;
    var focusId = doc.activeElement && doc.activeElement.id;
    build();
    AM.byId("editor-body").scrollTop = scroll;
    if (focusId && AM.byId(focusId)) AM.byId(focusId).focus({ preventScroll: true });
  });

  AM.provide("openEditor", openEditor);
})(window);
