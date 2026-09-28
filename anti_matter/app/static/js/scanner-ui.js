/* Anti-Matter 3.0 — js/scanner-ui.js: the full-screen scanner (#scanner).
   Camera (web engine or the Home Assistant app scanner), Photo (file, drop, paste), Paste text,
   the no-live-camera page, the result sheet (printout receipt, dedupe, name, readouts, categories,
   batch switch), the several-codes chooser and the session tray. SPEC §13; contract DOM-CONTRACT.md.
   Engine: AntiMatterScanEngine, AntiMatterHaBridge, AntiMatterScan. Provides AM action "openScanner".
   Never logs or sends codes/payloads anywhere except the add-on API calls that need them. */
(function (global) {
  "use strict";
  var AM = global.AM;
  if (!AM) return;
  var doc = global.document;
  var h = AM.h;
  var t = AM.t;
  // i18n-dynamic: scan.hkcat_ scan.reason_ scan.err_ scan.mode_ code.protocol_

  function E() { return global.AntiMatterScanEngine; }
  function B() { return global.AntiMatterHaBridge; }
  function P() { return global.AntiMatterScan; }
  function MP() { return global.AntiMatterMatterPayload; }
  function ZW() { return global.AntiMatterZWavePayload; }
  function I18N() { return global.AntiMatterI18n; }
  function ic(name, cls) { return AM.icon(name, cls); }
  function tk(prefix, name, vars) { return t(prefix + name, vars); } // dynamic key families (declared above)
  function byId(id) { return doc.getElementById(id); }
  function secs(ms) { return Math.max(0.1, Math.round((ms || 0) / 100) / 10); }
  function hex(n, w) { return "0x" + Number(n).toString(16).toUpperCase().padStart(w || 4, "0"); }
  function rx(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
  var RTL_CH = /[\u0590-\u08FF\uFB1D-\uFDFD\uFE70-\uFEFC]/;
  var LTR_CH = /[A-Za-z\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF\u3040-\u30FF\u3400-\u9FFF\uAC00-\uD7AF]/;
  /** Direction of the first strong character ("" when none), like dir="auto". */
  function textDir(s) {
    s = String(s || "");
    for (var i = 0; i < s.length; i++) {
      var c = s.charAt(i);
      if (RTL_CH.test(c)) return "rtl";
      if (LTR_CH.test(c)) return "ltr";
    }
    return "";
  }
  function kbd(k) { return h("span", { class: "kbd", "aria-hidden": "true" }, k); }

  var SHEET_W = 460;       // --scan-sheet-w
  var CAM_MIN = 320;       // --cam-min (phones)
  var PHONE = 720;
  var S = null;            // state of the open scanner
  var clearTimer = null;
  var bridgeWaited = false;

  // ======================================================================
  // Small builders
  // ======================================================================
  function button(cls, iconName, label, onClick, attrs) {
    var a = Object.assign({ type: "button", class: cls }, attrs || {});
    if (onClick) a.onclick = onClick;
    return h("button", a, iconName ? ic(iconName) : null, label == null ? null : typeof label === "string" ? h("span", null, label) : label);
  }
  function darkBtn(iconName, label, onClick, attrs) { return button("btn btn--dark", iconName, label, onClick, attrs); }

  /** Orbit art in its own box (SPEC §6.2): 3 ellipses, core and 3 particles. Never behind text. */
  function orbits(w, hgt) {
    var cx = w * 0.62, cy = hgt * 0.55;
    return h("svg", { class: "orbit-art", viewBox: "0 0 " + w + " " + hgt, preserveAspectRatio: "xMidYMid slice", "aria-hidden": "true", focusable: "false" },
      h("g", { style: "fill:none;stroke:var(--orb-line);stroke-width:1" },
        h("ellipse", { cx: cx, cy: cy, rx: w * 0.46, ry: hgt * 0.28, transform: "rotate(-16 " + cx + " " + cy + ")" }),
        h("ellipse", { cx: cx, cy: cy, rx: w * 0.34, ry: hgt * 0.62, transform: "rotate(24 " + cx + " " + cy + ")" }),
        h("ellipse", { cx: cx, cy: cy, rx: w * 0.2, ry: hgt * 0.2, "stroke-dasharray": "2 5" })),
      h("circle", { cx: cx, cy: cy, r: 5, style: "fill:var(--orb-1)" }),
      h("circle", { cx: cx, cy: cy, r: 15, style: "fill:var(--orb-1);opacity:.14" }),
      h("circle", { cx: w * 0.2, cy: hgt * 0.4, r: 3, style: "fill:var(--orb-2)" }),
      h("circle", { cx: w * 0.93, cy: hgt * 0.22, r: 2.5, style: "fill:var(--orb-3)" }),
      h("circle", { cx: w * 0.8, cy: hgt * 0.92, r: 2, style: "fill:var(--orb-2);opacity:.8" }));
  }

  function batchOn() { return !!AM.prefs.get("batch"); }
  function isPhone() { return global.innerWidth <= PHONE; }

  // ======================================================================
  // Environment
  // ======================================================================
  function engineEnv() {
    try { if (E()) return E().env(); } catch (e) { /* ignore */ }
    return { secureContext: !!global.isSecureContext, hasMediaDevices: false, canLiveScan: false, canDecodeImages: false, platform: {} };
  }
  function bridgeOk() {
    try { return !!(B() && B().available()); } catch (e) { return false; }
  }
  function companionUA() { return /Home ?Assistant\//i.test((global.navigator || {}).userAgent || ""); }
  function permissionState() {
    var nav = global.navigator;
    if (!nav.permissions || !nav.permissions.query) return Promise.resolve("unknown");
    var q;
    try { q = nav.permissions.query({ name: "camera" }); } catch (e) { return Promise.resolve("unknown"); }
    return Promise.race([
      Promise.resolve(q).then(function (r) { return (r && r.state) || "unknown"; }, function () { return "unknown"; }),
      new Promise(function (r) { setTimeout(function () { r("unknown"); }, 600); }),
    ]);
  }

  // ======================================================================
  // Parsing, dedupe, naming
  // ======================================================================
  function bodyOf(p) {
    var b = { code_type: p.code_type, manual_code: p.manual_code || "", qr_payload: p.qr_payload || "", custom_standard: p.custom_standard || "" };
    if (p.code_type === "homekit") {
      b.setup_id = p.setup_id || "";
      b.homekit_category = p.homekit_category || "other";
      if (p.homekit_flag != null) b.homekit_flag = p.homekit_flag;
    }
    return b;
  }
  /** Codes to dedupe against: the vault (may be stale while a layer is open) + this session's saves. */
  function knownCodes() {
    var list = AM.store.vault.codes.slice();
    if (S) S.tray.forEach(function (r) { if (r.status === "saved" && r.code) list.push(r.code); });
    return list;
  }
  function clientDup(body) {
    try {
      var c = P().findDuplicate(knownCodes(), body, (S && S.excludeId) || null);
      return c ? { id: c.id, name: c.name || "" } : null;
    } catch (e) { return null; }
  }
  function makeItem(p, raw, source, n) {
    var it = { parsed: p, raw: raw.text, corners: raw.corners || null, frameCorners: raw.frameCorners || null, n: n, source: source,
      enrich: {}, cats: [], name: "", nameTouched: false, nameSrc: null, ver: 0 };
    it.low = p.code_type === "homekit" && p.confidence === "low";
    it.unknown = p.recognized === false;
    setItemType(it, it.low ? "homekit" : null);
    return it;
  }
  function setItemType(it, asType) {
    var p = it.parsed;
    it.asType = asType;
    if (it.low && asType === "other") {
      it.body = { code_type: "other", manual_code: p.manual_code, qr_payload: it.source === "paste" ? "" : p.raw, custom_standard: "" };
    } else {
      it.body = bodyOf(p);
    }
    it.proto = AM.proto.of(it.body);
    it.info = null;
    it.dup = clientDup(it.body);
    it.kind = it.dup ? "dup" : "new";
    it.serverChecked = false;
  }
  /** Parse raw texts into items; the same code twice in one capture is kept once. */
  function itemsFrom(raws, source) {
    var out = [];
    raws.forEach(function (r) {
      var parsed = [];
      try { parsed = P().parseScannedTextAll(r.text); } catch (e) { parsed = []; }
      parsed.forEach(function (p) {
        var it = makeItem(p, r, source, out.length + 1);
        var twin = out.some(function (o) {
          try { return !!P().findDuplicate([Object.assign({ id: "_" }, o.body)], it.body, null); } catch (e) { return false; }
        });
        if (!twin) { it.n = out.length + 1; out.push(it); }
      });
    });
    return out;
  }

  function nextDefaultName(extra) {
    var base = t("scan.default_name");
    var parts = t("scan.default_name_n", { n: "#N#" }).split("#N#");
    var re = parts.length === 2 ? new RegExp("^" + rx(parts[0]) + "(\\d+)" + rx(parts[1]) + "$") : null;
    var names = AM.store.vault.codes.map(function (c) { return String(c.name || "").trim(); });
    if (S) names = names.concat(S.names);
    if (extra) names = names.concat(extra);
    var found = false, max = 0;
    names.forEach(function (n) {
      if (n === base) { found = true; max = Math.max(max, 1); return; }
      var m = re && re.exec(n);
      if (m) { found = true; max = Math.max(max, parseInt(m[1], 10) || 0); }
    });
    return found ? t("scan.default_name_n", { n: String(max + 1) }) : base;
  }

  function hkCatName(key) {
    var I = I18N();
    var k = "scan.hkcat_" + key;
    return I && I.has && I.has(k) ? t(k) : String(key || "");
  }

  function suggestName(it) {
    var e = it.enrich, p = it.proto;
    if (p === "matter") {
      var vn = e.vendor && e.vendor.name, pn = e.model && e.model.name;
      if (pn) return { name: vn && pn.toLowerCase().indexOf(vn.toLowerCase()) !== 0 ? vn + " " + pn : pn, src: "dcl" };
      if (vn) return { name: t("scan.vendor_device", { vendor: vn }), src: "suggested" };
    } else if (p === "zwave" && e.zw) {
      var parts = [e.zw.manufacturer, e.zw.label].filter(Boolean);
      if (parts.length) return { name: parts.join(" "), src: "db" };
    } else if (p === "homekit" && it.body.homekit_category && it.body.homekit_category !== "other") {
      return { name: t("scan.hk_device", { category: hkCatName(it.body.homekit_category) }), src: "suggested" };
    }
    return null;
  }

  // ======================================================================
  // Decoding for readouts + enrichment (DCL / Z-Wave device DB; silent on failure)
  // ======================================================================
  var BAD_PASSCODES = ["00000000", "11111111", "22222222", "33333333", "44444444", "55555555", "66666666", "77777777", "88888888", "99999999", "12345678", "87654321"];
  function matterInfo(body) {
    var M = MP();
    if (!M) return null;
    var qr = String(body.qr_payload || "").trim();
    try { if (/^MT:/i.test(qr)) return Object.assign({ fromQr: true }, M.parseQrPayload(qr)); } catch (e) { /* manual next */ }
    try {
      var d = String(body.manual_code || "").replace(/\D/g, "");
      if (d) return Object.assign({ fromQr: false }, M.parseManualPayload(d));
    } catch (e) { /* none */ }
    return null;
  }
  function zwaveInfo(body) {
    var Z = ZW();
    if (!Z) return null;
    try {
      var q = Z.extractQrString(String(body.qr_payload || ""));
      return q ? Z.parseQrDigits(q) : null;
    } catch (e) { return null; }
  }
  var lookup = AM.lookup; // shared, cached DCL / Z-Wave DB lookups (core.js)
  function enrich(it) {
    if (it.enrichStarted) return;
    it.enrichStarted = true;
    if (it.proto === "matter") {
      var mi = it.info || (it.info = matterInfo(it.body));
      if (mi && mi.vid) {
        lookup("/matter/vendor/" + mi.vid).then(function (v) { it.enrich.vendor = v; onEnriched(it); });
        if (mi.pid) lookup("/matter/model/" + mi.vid + "/" + mi.pid).then(function (m) { it.enrich.model = m; onEnriched(it); });
      }
    } else if (it.proto === "zwave") {
      var zi = it.info || (it.info = zwaveInfo(it.body));
      var m = zi && zi.meta;
      if (m && m.manufacturerId != null && m.productType != null && m.productId != null) {
        lookup("/zwave/device/" + m.manufacturerId + "/" + m.productType + "/" + m.productId).then(function (d) { it.enrich.zw = d; onEnriched(it); });
      }
    }
  }
  function onEnriched(it) {
    if (!S) return;
    var sug = suggestName(it);
    if (sug && !it.nameTouched) { it.name = sug.name; it.nameSrc = sug.src; }
    if (S.result === it) { syncNameField(it); refreshReadouts(it); }
    else if (S.multi && S.multi.items.indexOf(it) >= 0) renderMulti();
  }
  function vendorOf(it) {
    var e = it.enrich;
    if (it.proto === "matter") return (e.vendor && e.vendor.name) || "";
    if (it.proto === "zwave") return (e.zw && e.zw.manufacturer) || "";
    return "";
  }
  function productOf(it) {
    var e = it.enrich;
    if (it.proto === "matter") return (e.model && e.model.name) || "";
    if (it.proto === "zwave") return (e.zw && e.zw.label) || "";
    return "";
  }

  // ======================================================================
  // Open / close
  // ======================================================================
  function newState(o) {
    return {
      opts: o,
      single: o.mode === "single" || o.target === "editor",
      onResult: typeof o.onResult === "function" ? o.onResult : null,
      excludeId: o.excludeId || null,
      layout: "camera", variant: null, source: "camera", camEngine: "web", view: "idle",
      liveOk: false, bridge: false,
      cam: { session: null, caps: null, zoom: null, torch: false, label: "", searchSince: 0, logged: false, busy: false },
      camToken: 0, nativeToken: 0, decodeToken: 0,
      native: { active: false, logged: false },
      camError: null, photo: null, photoFail: null, photoLogged: false,
      result: null, multi: null, locked: null,
      tray: [], trayOpen: false, names: [],
      els: {}, off: [],
    };
  }

  function openScanner(o) {
    o = o || {};
    var root = byId("scanner");
    if (!root) return false;
    if (S && AM.sheets.isOpen("scanner")) {
      if (o.file) scanFile(o.file);
      else if (o.text) pasteText(o.text);
      else if (o.source && o.source !== S.source) switchMode(o.source);
      return true;
    }
    // Inside the Companion app the native-scanner detection may still be running (first seconds).
    if (!bridgeWaited && companionUA() && B() && !bridgeOk()) {
      bridgeWaited = true;
      Promise.race([B().ready(), new Promise(function (r) { setTimeout(r, 1500); })]).then(function () { openScanner(o); });
      return true;
    }
    if (clearTimer) { clearTimeout(clearTimer); clearTimer = null; }
    S = newState(o);
    S.els.root = root;
    var env = engineEnv();
    S.liveOk = !!(env.secureContext && env.hasMediaDevices && env.canLiveScan);
    S.bridge = bridgeOk();
    S.camEngine = S.bridge ? "native" : "web";
    var source = o.file ? "photo" : o.text ? "paste" : o.source === "photo" || o.source === "paste" ? o.source : "camera";
    if (!S.liveOk && !S.bridge) {
      S.layout = "page";
      S.variant = !env.secureContext ? "insecure" : "nocamera";
      if (source === "camera") source = "photo";
    }
    S.source = source;
    root.setAttribute("data-swipe", "none");
    root.removeAttribute("data-state");
    build();
    AM.sheets.open("scanner", { onClose: onLayerClose, beforeClose: beforeLayerClose }); // focus lands on the dialog itself (no tooltip flash)
    setMeta();
    listen();
    try { if (E()) E().warmup(); } catch (e) { /* ignore */ }
    var pick = source === "photo" && !o.file && (o.pick === true || (S.single && o.pick !== false));
    enterMode(source, { pick: pick });
    if (o.file) scanFile(o.file);
    else if (o.text) pasteText(o.text);
    return true;
  }

  function setMeta() {
    var T = global.AntiMatterTheme;
    if (T && T.setMetaColor) T.setMetaColor(S && S.layout === "camera" ? "#000" : null);
  }

  function hasPending() {
    if (!S) return false;
    var r = S.result;
    if (r && r.kind !== "dup" && !r.saved && !r.delivered) return true;
    if (S.multi && S.multi.items.some(function (i) { return i.kind !== "dup" && !i.saved; })) return true;
    return false;
  }
  function confirmDiscard(skipOnly) {
    var count = S.multi ? S.multi.items.filter(function (i) { return i.kind !== "dup" && !i.saved; }).length : 1;
    return AM.confirm({
      title: skipOnly ? t("scan.skip_confirm_title", { count: count }) : t("scan.discard_title", { count: count }),
      message: t("scan.discard_body", { count: count }),
      confirmLabel: skipOnly ? t("scan.skip") : t("scan.discard"),
      cancelLabel: t("scan.keep"),
      icon: "triangle-alert",
      okIcon: false,
    });
  }
  function guardPending() { return hasPending() ? confirmDiscard(false) : Promise.resolve(true); }
  function beforeLayerClose() { return hasPending() ? confirmDiscard(false) : true; }
  function requestClose() { return AM.sheets.requestClose("scanner", "close"); }
  function closeNow(result) { AM.sheets.close("scanner", result || "api", "api"); }

  function onLayerClose(result) {
    var st = S;
    if (!st) return;
    S = null;
    st.decodeToken++;
    st.camToken++;
    st.nativeToken++;
    stopCameraOf(st);
    if (st.native.active) { try { B().close(); } catch (e) { /* ignore */ } }
    st.off.forEach(function (fn) { try { fn(); } catch (e) { /* ignore */ } });
    if (st.photo && st.photo.url) { try { URL.revokeObjectURL(st.photo.url); } catch (e) { /* ignore */ } }
    var T = global.AntiMatterTheme;
    if (T && T.setMetaColor) T.setMetaColor(null);
    hideVeil();
    summarize(st, result);
    var root = st.els.root;
    clearTimer = setTimeout(function () {
      clearTimer = null;
      if (!S && root) { AM.fill(root); root.removeAttribute("data-state"); root.removeAttribute("data-view"); root.removeAttribute("data-layout"); }
    }, 400);
  }

  function summarize(st, result) {
    var saved = st.tray.filter(function (r) { return r.status === "saved"; });
    var dups = st.tray.filter(function (r) { return r.status === "dup"; });
    if (saved.length || dups.length) AM.log("Scan: batch summary saved=" + saved.length + " duplicates=" + dups.length + " mode=" + (st.single ? "single" : "vault"));
    if (saved.length === 1 && !dups.length) {
      var one = saved[0];
      AM.toast({ message: t("scan.saved_toast", { name: one.name }), tone: "ok", action: AM.can("openDetail") ? { label: t("scan.open"), run: function () { AM.act("openDetail", one.code.id); } } : null });
      return;
    }
    if (!saved.length && !dups.length) return;
    var parts = [];
    if (saved.length) parts.push(t("scan.done_saved", { count: saved.length }));
    if (dups.length) parts.push(t("scan.done_dups", { count: dups.length }));
    var ids = saved.map(function (r) { return r.code.id; });
    AM.toast({
      message: AM.fmt.list(parts),
      tone: saved.length ? "ok" : "info",
      action: ids.length ? { label: t("scan.review"), run: function () { AM.filters.set({ ids: new Set(ids) }); } } : null,
    });
  }

  function listen() {
    var onResize = AM.debounce(function () {
      if (!S) return;
      if (S.locked) layoutFreeze();
      placeMarkers();
    }, 60);
    global.addEventListener("resize", onResize);
    S.off.push(function () { global.removeEventListener("resize", onResize); });
    S.off.push(AM.on("locale", function () { if (S) rebuild(); }));
  }

  // ======================================================================
  // Build: camera layout and page layout
  // ======================================================================
  function build() {
    var root = S.els.root;
    AM.fill(root);
    root.setAttribute("data-layout", S.layout);
    S.els.fileChoose = h("input", { type: "file", accept: "image/*", hidden: true, tabindex: "-1", "aria-hidden": "true" });
    S.els.fileTake = h("input", { type: "file", accept: "image/*", capture: "environment", hidden: true, tabindex: "-1", "aria-hidden": "true" });
    [S.els.fileChoose, S.els.fileTake].forEach(function (inp) {
      inp.addEventListener("change", function () {
        var f = inp.files && inp.files[0];
        inp.value = "";
        if (f) scanFile(f);
      });
    });
    if (S.layout === "page") buildPage(); else buildCamera();
    root.append(S.els.fileChoose, S.els.fileTake);
  }

  /** Full rebuild keeping the state (locale change, layout switch). */
  function rebuild() {
    var keepText = S.els.pasteArea ? S.els.pasteArea.value : "";
    var hadFocus = S.els.root.contains(doc.activeElement);
    var hadCam = !!S.cam.session;
    if (hadCam) stopCamera(); // the <video> is replaced
    S.els = { root: S.els.root };
    build();
    if (keepText) { pasteBox(); S.els.pasteArea.value = keepText; }
    setMeta();
    if (S.layout === "page") renderPage();
    else if (hadCam && !S.result && !S.multi) beginCamera();
    else setView(S.view === "live" || S.view === "locked" || S.view === "starting" ? "idle" : S.view);
    renderSheet();
    renderTray();
    if (hadFocus) focusMode();
  }

  function modeSeg(kind) {
    var page = kind === "page";
    var group = h("div", { class: page ? "seg" : "hud-seg glass", role: "radiogroup", "aria-label": t("scan.source") });
    [["camera", "camera"], ["photo", "image"], ["paste", "clipboard-paste"]].forEach(function (m) {
      var off = page && m[0] === "camera" && !S.bridge;
      var b = h("button", {
        type: "button", class: page ? "seg__btn" : "hud-seg__btn", role: "radio", "data-mode": m[0],
        "aria-checked": String(S.source === m[0]), "aria-disabled": off ? "true" : null,
        tip: off ? (S.variant === "insecure" ? t("scan.needs_https") : t("scan.tag_no_camera")) : null,
      }, ic(off ? "camera-off" : m[1]), h("span", null, t(page && m[0] === "paste" ? "scan.mode_paste_text" : "scan.mode_" + m[0])));
      b.addEventListener("click", function () { if (!off) switchMode(m[0]); });
      group.appendChild(b);
    });
    AM.radio.sync(group);
    return group;
  }
  function syncSeg() {
    AM.$$("[data-mode]", S.els.root).forEach(function (b) { b.setAttribute("aria-checked", String(b.getAttribute("data-mode") === S.source)); });
    AM.$$("[role=radiogroup]", S.els.root).forEach(function (g) { if (g.querySelector("[data-mode]")) AM.radio.sync(g); });
  }
  function focusMode() {
    if (!S) return;
    var r = S.els.root.querySelector('[data-mode][aria-checked="true"]');
    try { (r || S.els.close).focus({ preventScroll: true }); } catch (e) { /* ignore */ }
  }

  function buildCamera() {
    var els = S.els;
    els.video = h("video", { class: "scanner__video", playsinline: true, muted: true, autoplay: true, "aria-hidden": "true", tabindex: "-1" });
    els.video.muted = true;
    els.freeze = h("canvas", { class: "scanner__freeze", "aria-hidden": "true" });
    els.frame = h("div", { class: "scanner__frame" }, els.video, els.freeze);
    els.idle = h("div", { class: "cam-idle", "aria-hidden": "true" });
    els.reticle = h("div", { class: "reticle", "aria-hidden": "true" }, h("div", { class: "reticle__sweep" }));
    els.chip = h("div", { class: "lock-chip", role: "status", hidden: true });
    els.stage = h("div", { class: "scanner__stage" });
    els.close = h("button", { type: "button", class: "hud-btn glass", tip: t("scan.close"), kbd: "Esc", onclick: requestClose }, ic("x"));
    els.status = h("span", { class: "hud-pill glass not-phone", role: "status", hidden: true });
    els.seg = modeSeg("hud");
    els.torch = h("button", { type: "button", class: "hud-btn glass", "aria-pressed": "false", tip: t("scan.torch_label"), kbd: "T", hidden: true, onclick: toggleTorch }, ic("flashlight"));
    els.switchBtn = h("button", { type: "button", class: "hud-btn glass not-phone", tip: t("scan.switch_camera"), kbd: "C", hidden: true, onclick: switchCamera }, ic("switch-camera"));
    els.hudPad = h("span", { class: "hud__pad", "aria-hidden": "true" });
    els.hudTop = h("div", { class: "hud hud--top" }, els.close, els.status, h("div", { class: "hud__mid" }, els.seg), els.torch, els.switchBtn, els.hudPad);
    buildZoom();
    els.hint = h("span", { class: "hint-pill glass", role: "status" });
    els.hudBottom = h("div", { class: "hud hud--bottom", hidden: true }, els.hint);
    els.tray = h("section", { class: "tray", hidden: true, "aria-labelledby": "scn-tray-title" });
    els.pillSlot = h("span", { class: "cam-row__pill" });
    els.camSwitch = h("button", { type: "button", class: "hud-btn glass cam-switch", tip: t("scan.switch_camera"), hidden: true, onclick: switchCamera }, ic("switch-camera"));
    els.camRow = h("div", { class: "cam-row only-phone-hud" }, els.pillSlot, h("span", { class: "spacer" }), els.zoomPresets, els.camSwitch);
    els.camera = h("div", { class: "scanner__camera" }, els.idle, els.frame, els.reticle, els.chip, els.stage, els.hudTop, els.zoomRail, els.hudBottom, els.tray, els.camRow);
    els.sheet = h("section", { class: "result", hidden: true, "aria-labelledby": "scn-r-title" });
    els.root.append(els.camera, els.sheet);
    wireGestures();
  }

  function buildPage() {
    var els = S.els;
    els.close = h("button", { type: "button", class: "icon-btn", tip: t("scan.close"), kbd: "Esc", onclick: requestClose }, ic("x"));
    els.seg = modeSeg("page");
    els.col1 = h("div", { class: "scanpage__col" });
    els.col2 = h("div", { class: "scanpage__col scanpage__col--side", hidden: true });
    els.page = h("div", { class: "scanpage" },
      h("div", { class: "scanpage__bar" }, els.close, h("h1", { id: "scn-page-title" }, t("scan.page_title")), els.seg, h("span", { class: "scanpage__pad not-phone", "aria-hidden": "true" })),
      h("div", { class: "scanpage__main" }, els.col1, els.col2));
    els.dim = h("div", { class: "scanner__dim", hidden: true, "aria-hidden": "true", onclick: function () { if (S && S.result) skipWithGuard(); } });
    els.sheet = h("section", { class: "result", hidden: true, "aria-labelledby": "scn-r-title" });
    els.tray = h("section", { class: "tray tray--page", hidden: true, "aria-labelledby": "scn-tray-title" });
    els.pillSlot = h("div", { class: "page-pill only-phone-hud" });
    els.root.append(els.page, els.tray, els.pillSlot, els.dim, els.sheet);
  }

  // ======================================================================
  // Modes & views (camera layout)
  // ======================================================================
  function switchMode(m) {
    if (!S) return;
    if (S.layout === "page" && m === "camera" && !S.bridge) return;
    if (m === S.source && !S.result && !S.multi && S.view !== "decoding") return;
    guardPending().then(function (ok) {
      if (!ok || !S) { if (S) syncSeg(); return; }
      enterMode(m, {});
    });
  }

  function enterMode(m, o) {
    o = o || {};
    S.source = m;
    S.decodeToken++;
    clearResult();
    syncSeg();
    if (m !== "camera") { stopCamera(); stopNative(); }
    if (S.layout === "page") {
      if (m === "camera") { toCameraLayout(); return; }
      S.view = m;
      renderPage();
      if (o.pick) pickFile(false);
      if (m === "paste") focusPaste();
      return;
    }
    if (m === "camera") {
      if (S.camEngine === "native") startNative();
      else beginCamera();
    } else if (m === "photo") {
      setView("photo");
      if (o.pick) pickFile(false);
    } else {
      setView("paste");
      focusPaste();
    }
  }

  function toPage(variant) {
    S.layout = "page";
    S.variant = variant;
    if (S.source === "camera") S.source = "photo";
    S.view = S.source;
    rebuild();
    focusMode();
  }
  function toCameraLayout() {
    S.layout = "camera";
    S.source = "camera";
    S.view = "idle";
    build();
    setMeta();
    renderTray();
    startNative();
  }

  /** view: starting | permission | live | locked | denied | native | photo | decoding | photo-result | paste */
  function setView(v) {
    S.view = v;
    if (S.layout === "page") { renderPage(); return; }
    var els = S.els;
    els.root.setAttribute("data-view", v);
    syncState();
    var dark = v === "idle" || v === "starting" || v === "permission" || v === "denied" || v === "native" || v === "decoding" || v === "photo-result";
    els.idle.hidden = !dark;
    els.frame.hidden = !(v === "live" || v === "locked" || v === "starting");
    var content = null;
    if (v === "permission") content = permissionCard();
    else if (v === "denied") content = errorCard();
    else if (v === "native") content = nativeWait();
    else if (v === "photo") content = photoPanel();
    else if (v === "decoding") content = decodingView();
    else if (v === "photo-result") content = photoView();
    else if (v === "paste") content = pastePanel();
    if (content !== els.stage.firstChild) AM.fill(els.stage, content);
    renderHud();
    if (v === "permission" || v === "denied") {
      var first = els.stage.querySelector(".cam-card .btn");
      if (first && els.root.contains(doc.activeElement) && !doc.activeElement.closest(".hud")) first.focus({ preventScroll: true });
    }
  }
  /** Replace an element's content only when it changes (live regions must not re-announce the same text). */
  function fillIf(el, key) {
    if (el._amKey === key) return false;
    el._amKey = key;
    AM.fill.apply(null, [el].concat(Array.prototype.slice.call(arguments, 2)));
    return true;
  }
  function syncState() {
    if (!S || S.layout !== "camera") return;
    var st = (S.result && !S.result.delivering) || (S.multi && S.multi.inSheet) ? "result" : S.view === "live" ? "searching" : "idle";
    S.els.root.setAttribute("data-state", st);
  }

  function renderHud() {
    if (!S || S.layout !== "camera") return;
    var els = S.els, v = S.view;
    var web = S.source === "camera" && S.camEngine === "web";
    var on = web && (v === "live" || v === "locked") && !!S.cam.session;
    var caps = S.cam.caps || {};
    // status pill (desktop)
    els.status.hidden = !(web && (v === "live" || v === "locked" || v === "starting"));
    if (!els.status.hidden) {
      if (v === "locked" && S.locked) {
        var pt = t("scan.paused", { seconds: secs(S.locked.ms) });
        fillIf(els.status, "p" + pt, h("span", { class: "dot dot--paused" }), h("b", null, pt));
      } else if (v === "starting") {
        fillIf(els.status, "s", h("span", { class: "dot dot--paused" }), h("b", null, t("scan.starting")));
      } else {
        fillIf(els.status, "l" + S.cam.label, h("span", { class: "dot" }), h("b", null, t("scan.live")), S.cam.label ? h("span", { dir: "auto" }, "· " + S.cam.label) : null);
      }
    }
    els.torch.hidden = !(on && caps.torch);
    els.torch.setAttribute("aria-pressed", String(!!S.cam.torch));
    var multiCam = on && caps.cameras && caps.cameras.length > 1;
    els.switchBtn.hidden = !multiCam;
    els.camSwitch.hidden = !multiCam;
    els.hudPad.hidden = !els.torch.hidden || (!els.switchBtn.hidden && !isPhone());
    // hint pill
    els.hudBottom.hidden = !(web && (v === "live" || v === "starting"));
    fillIf(els.hint, v === "starting" ? "s" : "p", ic(v === "starting" ? "loader-circle" : "scan-qr-code", v === "starting" ? "spin" : null), h("span", null, t(v === "starting" ? "scan.starting" : "scan.point_hint")));
    renderZoom();
  }

  // ---------- camera area cards ----------
  function camCard(iconName, warn, title, body, extra, actions) {
    return h("div", { class: "cam-card", role: "group", "aria-labelledby": "scn-card-title" },
      h("span", { class: ["cam-card__icon", warn && "cam-card__icon--warn"] }, ic(iconName)),
      h("h2", { id: "scn-card-title" }, title),
      h("p", null, body),
      extra,
      h("div", { class: "actions" }, actions));
  }
  function permissionCard() {
    return camCard("camera", false, t("scan.allow_title"), t("scan.allow_body"), null, [
      button("btn btn--hero btn--lg", "camera", t("scan.allow_btn"), function () { startCamera(); }, { "data-autofocus": "" }),
      darkBtn("image", t("scan.use_photo"), function () { enterMode("photo", {}); }),
    ]);
  }
  function errorCard() {
    var e = S.camError || { code: "unknown", name: "" };
    var title = e.code === "permission_denied" ? t("scan.blocked_title") : e.code === "in_use" ? t("scan.busy_title") : t("scan.error_title");
    var body = e.code === "permission_denied" ? t("scan.blocked_body") : e.code === "in_use" ? t("scan.busy_body") : tk("scan.err_", (["unsupported", "timeout"].indexOf(e.code) >= 0 ? e.code : "camera"));
    return camCard("camera-off", true, title, body, e.name ? h("code", { dir: "ltr" }, e.name) : null, [
      button("btn btn--primary btn--lg", "refresh-cw", t("scan.try_again"), function () { startCamera(); }),
      darkBtn("image", t("scan.use_photo"), function () { enterMode("photo", {}); }),
      darkBtn("keyboard", t("scan.type_code"), typeCode),
    ]);
  }
  function typeCode() {
    if (!S) return;
    var single = S.single;
    guardPending().then(function (ok) {
      if (!ok) return;
      closeNow("type");
      if (!single) AM.act("openEditor", null);
    });
  }

  function nativeWait() {
    var counts = trayCounts();
    return h("div", { class: "native-wait" },
      h("div", { class: "native-wait__art" }, orbits(180, 110), h("span", { class: "native-wait__icon" }, ic("smartphone", "icon--lg"))),
      h("h2", null, t("scan.native_title")),
      h("p", null, t("scan.native_body")),
      counts.saved || counts.dups ? h("span", { class: "hud-pill glass" }, h("span", { class: "dot dot--paused" }), h("b", null, sessionText(counts))) : null,
      h("div", { class: "native-wait__actions" },
        S.native.active ? null : button("btn btn--primary", "smartphone", t("scan.native_again"), function () { startNative(); }),
        S.liveOk ? darkBtn("camera", t("scan.use_web_camera"), function () { useWebCamera(); }) : darkBtn("image", t("scan.use_photo"), function () { enterMode("photo", {}); })));
  }
  function useWebCamera() {
    stopNative();
    S.camEngine = "web";
    beginCamera();
  }

  // ======================================================================
  // Web camera
  // ======================================================================
  function beginCamera() {
    stopNative();
    if (S.cam.session && S.cam.caps) { resumeCamera(); return; }
    setView("starting");
    permissionState().then(function (st) {
      if (!S || S.source !== "camera" || S.camEngine !== "web" || S.cam.session || S.view !== "starting") return;
      if (st === "granted" || st === "unknown") startCamera(); // unknown: the browser asks itself
      else if (st === "denied") showCamError({ code: "permission_denied", cause: { name: "NotAllowedError" } });
      else setView("permission");
    });
  }

  function startCamera() {
    var eng = E();
    if (!eng) { showCamError({ code: "unsupported" }); return; }
    stopCamera();
    S.camError = null;
    S.camEngine = "web";
    var token = ++S.camToken;
    setView("starting");
    var p = eng.createCameraSession({
      video: S.els.video,
      facingMode: "environment",
      continuous: false,
      onDetect: function (res, meta) { if (S && S.camToken === token) onDetect(res, meta); },
      onError: function (err) { if (S && S.camToken === token) { S.cam.session = null; S.cam.caps = null; showCamError(err); } },
      onState: function (st) { if (S && S.camToken === token && st === "live" && S.view === "starting") onCamLive(); },
    });
    S.cam.session = p.session;
    p.then(function () { if (S && S.camToken === token) onCamLive(); }, function () { /* onError handles it */ });
  }

  function onCamLive() {
    var s = S.cam.session;
    if (!s) return;
    var caps = s.capabilities();
    S.cam.caps = caps;
    S.cam.zoom = caps.zoom
      ? { min: caps.zoom.min, max: caps.zoom.max, step: caps.zoom.step || 0.1, value: caps.zoom.value, hw: true }
      : { min: 1, max: (caps.cssZoom && caps.cssZoom.max) || 4, step: 0.1, value: (caps.cssZoom && caps.cssZoom.value) || 1, hw: false };
    S.cam.label = cameraLabel(caps);
    if (!S.cam.logged) { S.cam.logged = true; AM.log("Scan: engine=" + (s.engine || "unknown") + " source=camera mode=" + (S.single ? "single" : "vault")); }
    if (S.result || S.multi) return;
    S.cam.searchSince = Date.now();
    if (S.view === "starting" || S.view === "permission") setView("live");
    else renderHud();
  }

  function cameraLabel(caps) {
    var id = caps.deviceId;
    var cams = caps.cameras || [];
    for (var i = 0; i < cams.length; i++) if (cams[i].deviceId === id && cams[i].label) return cams[i].label.replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$/i, "");
    if (caps.facingMode === "user") return t("scan.front_camera");
    if (caps.facingMode === "environment") return t("scan.back_camera");
    return "";
  }

  function showCamError(err) {
    if (!S) return;
    var code = (err && err.code) || "unknown";
    if (code === "aborted") return;
    stopCamera();
    if (code === "insecure_context" || code === "no_camera" || (code === "permission_denied" && err.policy)) {
      S.liveOk = false;
      AM.log("Scan: live camera unavailable reason=" + code + (err && err.policy ? " policy" : ""));
      if (S.bridge) { S.camEngine = "native"; startNative(); return; }
      toPage(code === "no_camera" ? "nocamera" : code === "insecure_context" ? "insecure" : "blocked");
      return;
    }
    S.camError = { code: code, name: (err && err.cause && err.cause.name) || "" };
    AM.log("Scan: camera error reason=" + code);
    setView("denied");
    var a = S.els.stage.querySelector(".btn--primary");
    if (a) a.focus({ preventScroll: true });
  }

  function stopCameraOf(st) {
    var s = st.cam.session;
    st.cam.session = null;
    st.cam.caps = null;
    st.cam.torch = false;
    st.locked = null;
    if (s) { try { s.stop(); } catch (e) { /* ignore */ } }
  }
  function stopCamera() {
    if (!S) return;
    if (S.cam.session) S.camToken++;
    stopCameraOf(S);
    unfreeze();
  }
  function resumeCamera() {
    var s = S.cam.session;
    unfreeze();
    if (!s) { beginCamera(); return; }
    try { s.resume(); } catch (e) { /* ignore */ }
    S.cam.searchSince = Date.now();
    setView("live");
  }

  function toggleTorch() {
    var s = S && S.cam.session;
    if (!s) return;
    var want = !S.cam.torch;
    s.setTorch(want).then(function (ok) {
      if (!S) return;
      if (ok) S.cam.torch = want;
      S.els.torch.setAttribute("aria-pressed", String(!!S.cam.torch));
    });
  }
  function switchCamera() {
    var s = S && S.cam.session;
    if (!s || S.cam.busy) return;
    S.cam.busy = true;
    S.cam.torch = false;
    s.switchCamera().then(function () {
      if (!S || S.cam.session !== s) return;
      S.cam.busy = false;
      onCamLive();
    }, function (err) {
      if (!S) return;
      S.cam.busy = false;
      if (err && err.code !== "aborted") AM.toast({ message: t("scan.err_switch"), tone: "warn" });
    });
  }

  // ---------- zoom ----------
  function buildZoom() {
    var els = S.els;
    els.zoomTrack = h("div", { class: "zoom-rail__track", role: "slider", tabindex: "0", "aria-label": t("scan.zoom"), "aria-orientation": "vertical" },
      h("span", { class: "zoom-rail__fill" }), h("span", { class: "zoom-rail__thumb" }));
    els.zoomVal = h("span", { class: "zoom-rail__val", dir: "ltr", "aria-hidden": "true" });
    els.zoomRail = h("div", { class: "zoom-rail glass", role: "group", "aria-label": t("scan.zoom"), hidden: true },
      h("button", { type: "button", class: "hud-btn", tip: t("action.zoom_in"), kbd: "+", onclick: function () { zoomBy(0.5); } }, ic("plus")),
      els.zoomTrack,
      h("button", { type: "button", class: "hud-btn", tip: t("action.zoom_out"), kbd: "−", onclick: function () { zoomBy(-0.5); } }, ic("minus")),
      els.zoomVal);
    els.zoomPresets = h("div", { class: "zoom-presets glass", role: "group", "aria-label": t("scan.zoom"), hidden: true });
    els.zoomTrack.addEventListener("keydown", function (e) {
      var z = S && S.cam.zoom;
      if (!z) return;
      var d = { ArrowUp: z.step, ArrowRight: z.step, ArrowDown: -z.step, ArrowLeft: -z.step, PageUp: 0.5, PageDown: -0.5 }[e.key];
      if (e.key === "Home") setZoom(z.min);
      else if (e.key === "End") setZoom(z.max);
      else if (d) setZoom(z.value + d);
      else return;
      e.preventDefault();
      e.stopPropagation();
    });
    var drag = null;
    function fromY(y) {
      var r = els.zoomTrack.getBoundingClientRect();
      var z = S.cam.zoom;
      var f = Math.min(1, Math.max(0, (r.bottom - y) / (r.height || 1)));
      setZoom(z.min + f * (z.max - z.min));
    }
    els.zoomTrack.addEventListener("pointerdown", function (e) {
      if (!S || !S.cam.zoom) return;
      drag = e.pointerId;
      try { els.zoomTrack.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      fromY(e.clientY);
      e.preventDefault();
    });
    els.zoomTrack.addEventListener("pointermove", function (e) { if (drag === e.pointerId) fromY(e.clientY); });
    function end(e) { if (drag === e.pointerId) drag = null; }
    els.zoomTrack.addEventListener("pointerup", end);
    els.zoomTrack.addEventListener("pointercancel", end);
  }
  function presetsFor(z) {
    var out = [];
    [1, 2, 3].forEach(function (v) {
      var c = Math.min(z.max, Math.max(z.min, v));
      if (out.every(function (o) { return Math.abs(o - c) > 0.05; })) out.push(c);
    });
    return out;
  }
  function fmtZoom(v) { return t("scan.zoom_value", { value: Math.round(v * 10) / 10 }); }
  function renderZoom() {
    var els = S.els, z = S.cam.zoom;
    var show = S.source === "camera" && S.camEngine === "web" && !!S.cam.session && !!z && (S.view === "live" || S.view === "locked") && z.max > z.min;
    els.zoomRail.hidden = !show;
    els.zoomPresets.hidden = !show;
    if (!show) return;
    var f = (z.value - z.min) / (z.max - z.min || 1);
    els.zoomRail.style.setProperty("--zp", String(Math.min(1, Math.max(0, f))));
    els.zoomTrack.setAttribute("aria-valuemin", String(z.min));
    els.zoomTrack.setAttribute("aria-valuemax", String(z.max));
    els.zoomTrack.setAttribute("aria-valuenow", String(Math.round(z.value * 10) / 10));
    els.zoomTrack.setAttribute("aria-valuetext", fmtZoom(z.value));
    els.zoomVal.textContent = fmtZoom(z.value);
    var presets = presetsFor(z);
    if (els.zoomPresets.childElementCount !== presets.length) {
      AM.fill(els.zoomPresets, presets.map(function (v) {
        return h("button", { type: "button", dir: "ltr", "data-z": String(v), "aria-pressed": "false", "aria-label": t("scan.zoom_to", { value: Math.round(v * 10) / 10 }), onclick: function () { setZoom(v); } }, fmtZoom(v));
      }));
    }
    AM.$$("button", els.zoomPresets).forEach(function (b) {
      b.setAttribute("aria-pressed", String(Math.abs(parseFloat(b.getAttribute("data-z")) - z.value) < 0.05));
    });
  }
  var zoomRaf = 0;
  function setZoom(v) {
    var z = S && S.cam.zoom, s = S && S.cam.session;
    if (!z || !s) return;
    z.value = Math.min(z.max, Math.max(z.min, Math.round(v * 100) / 100));
    renderZoom();
    if (zoomRaf) return;
    zoomRaf = global.requestAnimationFrame(function () {
      zoomRaf = 0;
      if (!S || !S.cam.session || !S.cam.zoom) return;
      var want = S.cam.zoom.value;
      S.cam.session.setZoom(want).then(function (r) {
        if (S && S.cam.zoom && r && r.mode === "css") S.cam.zoom.hw = false;
      }, function () { /* ignore */ });
    });
  }
  function zoomBy(d) { if (S && S.cam.zoom) setZoom(S.cam.zoom.value + d); }

  /** Pinch = hardware (or digital) zoom; a tap focuses when the camera supports it. */
  function wireGestures() {
    var frame = S.els.frame, pts = new Map(), pinch = null, tap = null;
    function dist() { var a = Array.from(pts.values()); return Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y) || 1; }
    frame.addEventListener("pointerdown", function (e) {
      if (!S || S.view !== "live") return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 2 && S.cam.zoom) { pinch = { d0: dist(), z0: S.cam.zoom.value }; tap = null; }
      else if (pts.size === 1) tap = { x: e.clientX, y: e.clientY, t: Date.now() };
    });
    frame.addEventListener("pointermove", function (e) {
      if (!pts.has(e.pointerId)) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch && pts.size === 2) setZoom(pinch.z0 * (dist() / pinch.d0));
      if (tap && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) > 10) tap = null;
    });
    function end(e) {
      if (!pts.has(e.pointerId)) return;
      pts.delete(e.pointerId);
      if (pts.size < 2) pinch = null;
      if (tap && e.type === "pointerup" && Date.now() - tap.t < 450 && S && S.cam.session && S.cam.caps && S.cam.caps.focus) {
        var r = S.els.video.getBoundingClientRect();
        S.cam.session.focusAt((tap.x - r.left) / (r.width || 1), (tap.y - r.top) / (r.height || 1));
        showFocusRing(tap.x - S.els.camera.getBoundingClientRect().left, tap.y - S.els.camera.getBoundingClientRect().top);
      }
      tap = null;
    }
    frame.addEventListener("pointerup", end);
    frame.addEventListener("pointercancel", end);
  }
  function showFocusRing(x, y) {
    var ring = h("span", { class: "focus-ring", "aria-hidden": "true", style: { left: x + "px", top: y + "px" } });
    S.els.camera.appendChild(ring);
    setTimeout(function () { ring.remove(); }, 700);
  }

  // ---------- lock-on ----------
  function onDetect(results, meta) {
    if (!S || S.view !== "live" || !results || !results.length) return;
    var ms = Math.max(0, Date.now() - (S.cam.searchSince || Date.now()));
    freeze(results, meta, ms);
    capture(results.map(function (r) { return { text: r.text, frameCorners: r.frameCorners }; }), { source: "camera", ms: ms });
  }

  function freeze(results, meta, ms) {
    var v = S.els.video, c = S.els.freeze;
    var vw = v.videoWidth || (meta.video && meta.video.width) || 0, vh = v.videoHeight || (meta.video && meta.video.height) || 0;
    if (!vw || !vh) return;
    c.width = vw;
    c.height = vh;
    try { c.getContext("2d").drawImage(v, 0, 0, vw, vh); } catch (e) { /* tainted or not ready: keep the live frame */ }
    var quads = results.map(function (r) { return (r.frameCorners || []).map(function (p) { return [p.x, p.y]; }); }).filter(function (q) { return q.length === 4; });
    S.locked = { vw: vw, vh: vh, quads: quads, ms: ms, zoom: S.cam.zoom && !S.cam.zoom.hw ? S.cam.zoom.value : 1, results: results };
    var old = S.els.frame.querySelector(".scanner__overlay");
    if (old) old.remove();
    var quadD = function (q) { return q.map(function (p, i) { return (i ? "L" : "M") + p[0] + " " + p[1]; }).join("") + "Z"; };
    var corner = function (q, i) {
      var p = q[i], a = q[(i + 1) % 4], b = q[(i + 3) % 4], k = 0.2;
      return "M" + (p[0] + (a[0] - p[0]) * k) + " " + (p[1] + (a[1] - p[1]) * k) + "L" + p[0] + " " + p[1] + "L" + (p[0] + (b[0] - p[0]) * k) + " " + (p[1] + (b[1] - p[1]) * k);
    };
    var g = h("g", { class: "lock" }, h("path", { class: "lock__dim", d: "M-4000 -4000H" + (vw + 4000) + "V" + (vh + 4000) + "H-4000Z " + quads.map(quadD).join(" ") }));
    quads.forEach(function (q) {
      g.appendChild(h("path", { class: "lock__quad", d: quadD(q) }));
      [0, 1, 2, 3].forEach(function (i) {
        g.appendChild(h("path", { class: "lock__halo", d: corner(q, i) }));
        g.appendChild(h("path", { class: "lock__corner", d: corner(q, i) }));
      });
    });
    S.els.overlay = h("svg", { class: "scanner__overlay", viewBox: "0 0 " + vw + " " + vh, preserveAspectRatio: "none", "aria-hidden": "true", focusable: "false" }, g);
    S.els.frame.appendChild(S.els.overlay);
    S.els.frame.classList.add("is-frozen");
    S.view = "locked";
    S.els.root.setAttribute("data-view", "locked");
  }

  function unfreeze() {
    if (!S || S.layout !== "camera") return;
    var els = S.els;
    S.locked = null;
    if (els.overlay) { els.overlay.remove(); els.overlay = null; }
    if (els.frame) {
      els.frame.classList.remove("is-frozen");
      els.frame.style.transform = "";
      [els.freeze, els.video].forEach(function (x) { if (x) { x.style.inset = x.style.left = x.style.top = x.style.width = x.style.height = ""; } });
    }
    if (els.chip) els.chip.hidden = true;
  }

  /** Place the frozen frame so the locked quad sits centred in the uncovered camera area (SPEC §13.4). */
  function layoutFreeze() {
    var L = S && S.locked;
    if (!L || S.layout !== "camera") return;
    var root = S.els.root.getBoundingClientRect();
    var phone = root.width <= PHONE;
    var sheet = (S.result && !S.result.delivering) || (S.multi && S.multi.inSheet);
    var W = root.width, H = root.height, under = 0;
    if (sheet && !phone) W = root.width - SHEET_W;
    if (sheet && phone) { var sh = Math.min(470, H - CAM_MIN); H = H - (sh - 24); under = 24; }
    var s = Math.max(W / L.vw, H / L.vh) * (L.zoom || 1);
    var ox = (W - L.vw * s) / 2, oy = (H - L.vh * s) / 2;
    var xs = [], ys = [];
    L.quads.forEach(function (q) { q.forEach(function (p) { xs.push(ox + p[0] * s); ys.push(oy + p[1] * s); }); });
    var k = 1, tx = 0, ty = 0;
    if (xs.length) {
      var qx0 = Math.min.apply(null, xs), qx1 = Math.max.apply(null, xs), qy0 = Math.min.apply(null, ys), qy1 = Math.max.apply(null, ys);
      var top = phone ? 64 : 88, bottom = (H - under) - (sheet ? (phone ? 124 : 120) : (phone ? 150 : 110));
      // Horizontal band: clear of the zoom rail (inline start, desktop), which is physical right in RTL.
      var rail = !phone && S.els.zoomRail && !S.els.zoomRail.hidden ? 88 : 20;
      var rtl = AM.dir() === "rtl";
      var left = rtl ? 20 : rail, right = W - (rtl ? rail : 20);
      k = Math.min(1, Math.max(0.25, (bottom - top) / Math.max(1, qy1 - qy0)), (right - left) / Math.max(1, qx1 - qx0));
      var cx = (qx0 + qx1) / 2, cy = (qy0 + qy1) / 2;
      tx = (left + right) / 2 - cx * k;
      ty = (top + bottom) / 2 - cy * k;
      // Keep the frozen frame covering the box (no seams) unless that would push the quad out of
      // its band (under the HUD, or onto the lock chip / camera row): centring wins over seams.
      var iw = L.vw * s * k, ih = L.vh * s * k;
      if (iw >= W) {
        var tx2 = Math.min(-ox * k, Math.max(W - iw - ox * k, tx));
        if (qx0 * k + tx2 >= left - 4 && qx1 * k + tx2 <= right + 4) tx = tx2;
      }
      if (ih >= H) {
        var ty2 = Math.min(-oy * k, Math.max(H - ih - oy * k, ty));
        if (qy0 * k + ty2 >= top - 4 && qy1 * k + ty2 <= bottom + 4) ty = ty2;
      }
    }
    [S.els.freeze, S.els.overlay].forEach(function (el) {
      if (!el) return;
      el.style.inset = "auto";
      el.style.left = ox + "px";
      el.style.top = oy + "px";
      el.style.width = L.vw * s + "px";
      el.style.height = L.vh * s + "px";
    });
    S.els.frame.style.transform = "translate(" + tx + "px, " + ty + "px) scale(" + k + ")";
    // Lock chip under the quad (single code only)
    var chip = S.els.chip;
    var it = S.result;
    if (L.quads.length === 1 && it) {
      var q = L.quads[0];
      var bx = ((q[2][0] + q[3][0]) / 2) * s + ox, by = Math.max(q[2][1], q[3][1]) * s + oy;
      AM.fill(chip, ic("check"), h("span", null, it.unknown ? t("scan.unknown_short") : AM.proto.name(it.body)), chipCode(it));
      chip.style.left = tx + bx * k + "px";
      chip.style.top = Math.min(ty + by * k + 12, H - under - (phone ? 96 : 60)) + "px";
      chip.hidden = false;
    } else if (L.quads.length > 1) {
      AM.fill(chip, ic("check"), h("span", null, t("scan.n_codes", { count: L.quads.length })));
      chip.style.left = W / 2 + "px";
      chip.style.top = Math.min(ty + Math.max.apply(null, ys) * k + 12, H - under - (phone ? 96 : 60)) + "px";
      chip.hidden = false;
    } else chip.hidden = true;
  }
  function chipCode(it) {
    if (it.unknown) return null;
    var f = AM.proto.formatCode(it.body);
    if (!f.text) return null;
    return h("span", { class: "mono", dir: "ltr" }, f.pre ? f.pre + " " + f.text : f.text);
  }

  // ======================================================================
  // Home Assistant app scanner
  // ======================================================================
  function stopNative() {
    if (!S || !S.native.active) return;
    S.nativeToken++;
    S.native.active = false;
    try { B().close(); } catch (e) { /* ignore */ }
  }
  function startNative() {
    var br = B();
    if (!br || !bridgeOk()) {
      S.bridge = false;
      S.camEngine = "web";
      if (S.liveOk) beginCamera(); else toPage(engineEnv().secureContext ? "nocamera" : "insecure");
      return;
    }
    stopCamera();
    S.camEngine = "native";
    if (S.native.active) { setView("native"); return; }
    S.native.active = true;
    setView("native");
    var token = ++S.nativeToken;
    if (!S.native.logged) { S.native.logged = true; AM.log("Scan: engine=ha-app source=camera mode=" + (S.single ? "single" : "vault")); }
    var o = { title: t("scan.native_scan_title"), description: t("scan.point_hint"), alternativeOptionLabel: t("scan.native_alt") };
    var done = function (reason) {
      if (!S || S.nativeToken !== token) return;
      S.native.active = false;
      onNativeEnd(reason);
    };
    if (!S.single && batchOn()) {
      o.onResult = function (text) { return nativeResult(text, token); };
      br.scanMany(o).then(function (r) { done((r && r.reason) || "closed"); }, function (err) { done((err && err.code) || "aborted"); });
    } else {
      br.scan(o).then(function (res) {
        if (!S || S.nativeToken !== token) return;
        S.native.active = false;
        if (res && res.text) capture([{ text: res.text }], { source: "native" });
        else setView("native");
      }, function (err) { done((err && err.code) || "aborted"); });
    }
  }
  function onNativeEnd(reason) {
    if (reason === "alternative") { enterMode("photo", {}); return; }
    if (reason === "unavailable" || reason === "timeout") {
      AM.toast({ message: t("scan.err_native"), tone: "warn" });
      S.bridge = false;
      S.camEngine = "web";
      if (S.liveOk) beginCamera(); else toPage(engineEnv().secureContext ? "nocamera" : "insecure");
      return;
    }
    if (reason === "replaced") return;
    if (S.native.handoff) { S.native.handoff = false; if (!S.result && !S.multi) setView("native"); return; }
    // closed / aborted: the user left the app scanner; nothing else to do here.
    if (!S.result && !S.multi && S.view === "native") closeNow("native-closed");
  }
  /** Batch in the app scanner: save new codes at once, report duplicates natively, hand anything unclear to the sheet. */
  function nativeResult(text, token) {
    if (!S || S.nativeToken !== token) return { keepOpen: false };
    var items = itemsFrom([{ text: text }], "native");
    if (items.length !== 1 || items[0].low || items[0].unknown) {
      S.native.handoff = true; // the sheet asks; the app scanner closes
      capture([{ text: text }], { source: "native" });
      return { keepOpen: false };
    }
    var it = items[0];
    enrich(it);
    return serverDup(it).then(function (dup) {
      if (!S || S.nativeToken !== token) return { keepOpen: false };
      if (dup) it.dup = dup;
      if (it.dup) {
        it.kind = "dup";
        addTrayDup(it);
        AM.haptic("warning");
        AM.log("Scan: captured protocol=" + it.proto + " source=native duplicate");
        return { keepOpen: true, notify: t("scan.native_dup", { name: it.dup.name }) };
      }
      return waitEnriched(it, 1200).then(function () {
        var sug = suggestName(it);
        it.name = (sug && sug.name) || nextDefaultName();
        return saveItem(it).then(function (ok) {
          if (!S) return { keepOpen: false };
          setView("native");
          if (ok === true) return { keepOpen: true, notify: t("scan.native_saved", { name: it.name }) };
          if (ok === "dup") return { keepOpen: true, notify: t("scan.native_dup", { name: it.dup.name }) };
          S.native.handoff = true;
          return { keepOpen: false };
        });
      });
    });
  }
  function waitEnriched(it, ms) {
    var ps = [];
    if (it.proto === "matter" && it.info && it.info.vid) {
      ps.push(lookup("/matter/vendor/" + it.info.vid));
      if (it.info.pid) ps.push(lookup("/matter/model/" + it.info.vid + "/" + it.info.pid));
    }
    if (it.proto === "zwave" && it.info && it.info.meta && it.info.meta.manufacturerId != null) {
      var m = it.info.meta;
      ps.push(lookup("/zwave/device/" + m.manufacturerId + "/" + m.productType + "/" + m.productId));
    }
    return Promise.race([Promise.all(ps), new Promise(function (r) { setTimeout(r, ms); })]).then(function () {
      return new Promise(function (r) { setTimeout(r, 0); }); // let the .then(onEnriched) handlers run
    });
  }

  // ======================================================================
  // Captures → result sheet or chooser
  // ======================================================================
  function capture(raws, meta) {
    if (!S) return;
    var items = itemsFrom(raws, meta.source);
    // Several codes in one frame/photo: number them in reading order (their markers are physical positions).
    if (items.length > 1 && items.every(function (i) { return (i.corners || i.frameCorners || []).length === 4; })) {
      var cx = function (i) { return (i.corners || i.frameCorners).reduce(function (a, p) { return a + p.x; }, 0); };
      var rtl = AM.dir() === "rtl";
      items.sort(function (a, b) { return rtl ? cx(b) - cx(a) : cx(a) - cx(b); });
      items.forEach(function (i, k) { i.n = k + 1; });
    }
    if (!items.length) {
      if (meta.source === "camera") resumeCamera();
      return;
    }
    var protos = [];
    items.forEach(function (i) { if (protos.indexOf(i.proto) < 0) protos.push(i.proto); });
    AM.log("Scan: captured protocol=" + protos.join(",") + " count=" + items.length + " source=" + meta.source + (items.some(function (i) { return i.kind === "dup"; }) ? " duplicate" : ""));
    if (items.length === 1) showResult(items[0], meta);
    else showMulti(items, meta);
  }

  function showResult(it, meta) {
    S.result = it;
    S.multi = null;
    it.meta = meta;
    it.defaultName = nextDefaultName();
    it.info = it.proto === "matter" ? matterInfo(it.body) : it.proto === "zwave" ? zwaveInfo(it.body) : null;
    var sug = suggestName(it);
    it.name = (sug && sug.name) || it.defaultName;
    it.nameSrc = sug ? sug.src : null;
    AM.haptic(it.kind === "dup" ? "warning" : "success");
    if (it.kind === "dup" && !S.single) addTrayDup(it);
    enrich(it);
    checkServer(it);
    if (S.single && it.kind === "new" && !it.low && !it.unknown) {
      // Editor mode: the first plain result fills the open form (after the lock is visible for a moment).
      it.delivering = true;
      if (meta.source === "camera") { renderHud(); layoutFreeze(); }
      var wait = new Promise(function (r) { setTimeout(r, meta.source === "camera" ? 450 : 0); });
      Promise.all([wait, Promise.race([it.serverPromise, new Promise(function (r) { setTimeout(r, 1200); })])]).then(function () {
        if (!S || S.result !== it) return;
        if (it.kind === "dup") { it.delivering = false; presentResult(it); return; }
        deliver(it);
      });
      return;
    }
    presentResult(it);
  }
  function presentResult(it) {
    var src = it.meta.source;
    if (S.layout === "page") { S.view = S.source; renderPage(); }
    else {
      if (src === "photo") setView("photo-result");
      else if (src === "paste") setView("paste");
      else if (src === "native") setView("native");
      else { syncState(); renderHud(); }
    }
    renderSheet();
    if (src === "camera") layoutFreeze();
    focusPrimary();
  }

  function focusPrimary() {
    setTimeout(function () {
      if (!S) return;
      var p = S.els.root.querySelector(".result:not([hidden]) .result__foot .btn--primary, .picker .picker__foot .btn--primary");
      if (p && !p.disabled) p.focus({ preventScroll: true });
      else if (S.els.sheet && !S.els.sheet.hidden) { var tt = S.els.sheet.querySelector("h2"); if (tt) { tt.setAttribute("tabindex", "-1"); tt.focus({ preventScroll: true }); } }
    }, 30);
  }

  function serverDup(it) {
    var body = Object.assign({}, it.body, { exclude_id: (S && S.excludeId) || null });
    return AM.api("/codes/check-duplicate", { method: "POST", body: body }).then(function (r) {
      var ex = r && r.duplicate && r.duplicate.existing;
      return ex ? { id: ex.id, name: ex.name || "" } : null;
    }, function () { return undefined; });
  }
  /** Client check first (instant), the server confirms (the vault can be stale while the scanner is open). */
  function checkServer(it) {
    var ver = ++it.ver;
    it.serverPromise = serverDup(it).then(function (dup) {
      if (!S || it.ver !== ver || dup === undefined || it.saved) return;
      it.serverChecked = true;
      var was = it.kind;
      if (dup) { it.dup = dup; it.kind = "dup"; }
      else if (it.kind === "dup") { it.dup = null; it.kind = "new"; }
      if (was === it.kind) return;
      if (it.kind === "dup") { AM.haptic("warning"); if (!S.single) addTrayDup(it); }
      else removeTrayDup(it);
      if (it.delivering) return;
      if (S.result === it) { renderSheet(); if (S.locked) layoutFreeze(); }
      else if (S.multi && S.multi.items.indexOf(it) >= 0) renderMulti();
    });
    return it.serverPromise;
  }

  function clearResult() {
    if (!S) return;
    S.result = null;
    S.multi = null;
    if (S.els.sheet) { S.els.sheet.hidden = true; AM.fill(S.els.sheet); }
    if (S.els.dim) S.els.dim.hidden = true;
    unfreeze();
    syncState();
  }

  /** After Save & scan next, Skip or Scan next: back to the current source. */
  function resumeSource(o) {
    o = o || {};
    clearResult();
    if (!S) return;
    if (S.layout === "page") {
      S.view = S.source;
      if (o.clearPaste && S.els.pasteArea) S.els.pasteArea.value = "";
      renderPage();
      if (S.els.page) S.els.page.scrollTop = 0;
      focusMode();
      return;
    }
    if (S.source === "camera") {
      if (S.camEngine === "native") startNative();
      else resumeCamera();
    } else if (S.source === "photo") setView("photo");
    else {
      if (o.clearPaste && S.els.pasteArea) { S.els.pasteArea.value = ""; detectPaste(); }
      setView("paste");
      focusPaste();
      return;
    }
    focusMode();
  }
  function skipResult() { resumeSource({}); }
  function skipWithGuard() {
    if (!S) return;
    if (!hasPending()) { skipResult(); return; }
    confirmDiscard(true).then(function (ok) { if (ok && S) skipResult(); });
  }

  // ======================================================================
  // Result sheet (single code)
  // ======================================================================
  function renderSheet() {
    if (!S) return;
    var els = S.els, it = S.result;
    if (S.multi && S.multi.inSheet) { renderMulti(); return; }
    if (!it || it.delivering) { els.sheet.hidden = true; if (els.dim) els.dim.hidden = true; syncState(); return; }
    var dup = it.kind === "dup";
    var sheet = els.sheet;
    sheet.className = "result" + (dup ? " result--dup" : "");
    var variant = dup ? "dup" : it.unknown ? "unknown" : it.low ? "low" : "new";
    var title = { dup: t("scan.already_in_vault"), unknown: t("scan.unknown_title"), low: t("scan.low_title"), new: t("scan.code_found") }[variant];
    var dotIcon = { dup: "triangle-alert", unknown: "circle-help", low: "circle-help", new: "check" }[variant];
    var tag = dup
      ? h("span", { class: "tag tag--warn" }, ic("copy"), h("span", null, t("scan.duplicate_tag")))
      : h("span", { class: "tag tag--ok" }, ic("sparkles"), h("span", null, t("scan.new_to_vault")));
    var head = h("header", { class: "result__head" },
      h("div", { class: "result__heading" },
        h("h2", { class: "result__title", id: "scn-r-title" }, h("span", { class: ["ok-dot", variant !== "new" && variant !== "dup" && "ok-dot--info"] }, ic(dotIcon)), h("span", null, title), tag),
        subline(it)),
      h("button", { type: "button", class: "icon-btn icon-btn--sm", tip: dup ? t("scan.close_result") : t("scan.skip_tip"), kbd: "Esc", onclick: skipResult }, ic("x")));
    var body = h("div", { class: "result__body" });
    body.appendChild(receipt(it));
    if (it.low) body.appendChild(lowNotice(it)); // the HomeKit/Other choice stays available, also on a duplicate
    if (dup) body.appendChild(dupNotice(it));
    else {
      if (it.unknown) body.appendChild(unknownNotice(it));
      if (!S.single) body.appendChild(nameField(it));
    }
    var ro = readouts(it);
    if (ro) body.appendChild(ro);
    if (!dup && !S.single) {
      body.appendChild(catsField(it));
      body.appendChild(batchRow());
    }
    var foot = h("footer", { class: "result__foot" }, footer(it));
    AM.fill(sheet, h("div", { class: "sheet__grabber", "aria-hidden": "true" }), head, body, foot);
    sheet.hidden = false;
    if (els.dim) els.dim.hidden = false;
    wireSheetSwipe(sheet);
    syncState();
  }

  function subline(it) {
    var m = it.meta || {}, proto = it.unknown ? t("scan.unknown_short") : AM.proto.name(it.body);
    var count = AM.store.vault.codes.length;
    var desk;
    if (it.kind === "dup") desk = m.ms != null ? t("scan.sub_read_dup", { protocol: proto, seconds: secs(m.ms) }) : t("scan.sub_dup", { protocol: proto });
    else desk = m.ms != null ? t("scan.sub_read", { protocol: proto, seconds: secs(m.ms), count: count }) : t("scan.sub_checked", { protocol: proto, count: count });
    var phone = m.source === "camera" ? t("scan.paused", { seconds: secs(m.ms) }) : desk;
    return h("p", { class: "result__sub" }, h("span", { class: "not-phone" }, desk), h("span", { class: "only-phone" }, phone));
  }

  function receipt(it) {
    var b = it.body, p = it.proto;
    var phone = AM.mq.phone.matches;
    var target = phone ? 66 : 99;
    var qrBox = h("span", { class: "receipt__qr", "aria-hidden": "true" });
    var txt = h("div", { class: "receipt__txt" });
    var hk = p === "homekit" && AM.proto.homekitDigits(b);
    txt.appendChild(hk ? h("span", { class: "receipt__hk" }, AM.proto.wordmark(b)) : AM.proto.wordmark(b));
    var f = AM.proto.formatCode(b);
    if (p === "zwave" && f.pre) {
      var g = AM.proto.dsk(b);
      txt.appendChild(h("span", { class: "receipt__code receipt__code--pin", dir: "ltr" }, f.pre + " " + f.text));
      if (g) txt.appendChild(h("span", { class: "receipt__dsk", dir: "ltr" }, h("u", null, g[0]), "-" + g.slice(1, 4).join("-"), h("br"), g.slice(4).join("-")));
    } else if (!hk && f.text) {
      txt.appendChild(h("span", { class: ["receipt__code", f.text.length > 16 && "receipt__code--long"], dir: "ltr" }, f.text));
    }
    if (b.qr_payload && p !== "zwave") txt.appendChild(h("span", { class: "receipt__raw", dir: "ltr" }, b.qr_payload));
    var rc = h("div", { class: "receipt receipt--print p-" + p, role: "img", "aria-label": t("scan.receipt_label", { protocol: AM.proto.name(b) }) }, qrBox, txt);
    var qrLabel = t("scan.qr_label", { protocol: AM.proto.name(b) });
    AM.qr.forPayload(b, { label: qrLabel }).then(function (svg) {
      if (svg) AM.qr.mount(qrBox, svg, { targetPx: target });
      else AM.fill(qrBox, AM.qr.placeholder(t("scan.no_qr"), target));
    }, function () { AM.fill(qrBox, AM.qr.placeholder(t("scan.no_qr"), target)); });
    return h("div", { class: "printer" }, rc);
  }

  function dupNotice(it) {
    return h("div", { class: "notice notice--warn", role: "status" }, ic("triangle-alert"),
      h("div", { class: "notice__body" },
        h("span", { class: "notice__title" }, AM.tNodes("scan.dup_title", {}, { name: h("bdi", { dir: "auto" }, it.dup.name) })),
        h("span", null, t("scan.dup_body")),
        h("div", { class: "notice__actions" }, button("btn btn--sm", "maximize-2", t("scan.open_existing"), function () { openExisting(it.dup.id); }))));
  }
  function lowNotice(it) {
    var seg = h("div", { class: "seg seg--block", role: "radiogroup", "aria-label": t("scan.save_as") });
    [["homekit", "code.protocol_homekit"], ["other", "code.protocol_other"]].forEach(function (o) {
      var b = h("button", { type: "button", class: "seg__btn", role: "radio", "aria-checked": String(it.asType === o[0]) }, h("span", null, t(o[1])));
      b.addEventListener("click", function () {
        if (it.asType === o[0]) return;
        removeTrayDup(it);
        setItemType(it, o[0]);
        it.info = null;
        if (!it.nameTouched) { var s = suggestName(it); it.name = (s && s.name) || it.defaultName; it.nameSrc = s ? s.src : null; }
        if (it.kind === "dup" && !S.single) addTrayDup(it);
        checkServer(it);
        renderSheet();
        var again = S.els.sheet.querySelector('.seg [aria-checked="true"]');
        if (again) again.focus({ preventScroll: true });
      });
      seg.appendChild(b);
    });
    AM.radio.sync(seg);
    return h("div", { class: "notice notice--accent" }, ic("circle-help"),
      h("div", { class: "notice__body" },
        h("span", { class: "notice__title" }, t("scan.low_note_title")),
        h("span", null, t("scan.low_note_body")),
        h("span", { class: "notice__label" }, t("scan.save_as")), seg));
  }
  function unknownNotice(it) {
    var reason = it.parsed.reason || "unknown_format";
    var I = I18N();
    return h("div", { class: "notice notice--accent" }, ic("info"),
      h("div", { class: "notice__body" },
        h("span", { class: "notice__title" }, t("scan.unknown_note_title")),
        I && I.has && I.has("scan.reason_" + reason) ? h("span", null, tk("scan.reason_", reason)) : null,
        h("span", null, t("scan.unknown_note_body"))));
  }

  function nameField(it) {
    var input = h("input", { class: "input", id: "scn-r-name", type: "text", dir: "auto", autocomplete: "off", spellcheck: "false", maxlength: "200" });
    input.value = it.name;
    var badge = h("span", { class: "badge-src" });
    var box = h("div", { class: "name-field__box" }, input, badge);
    input.addEventListener("input", function () { it.name = input.value; it.nameTouched = true; it.nameSrc = null; syncBadge(it); });
    var wrap = h("div", { class: "field name-field" },
      h("label", { class: "field__label", for: "scn-r-name" }, t("scan.name"), h("span", { class: "aside" }, t("scan.rename_later"))),
      box);
    it.els = { name: input, badge: badge, box: box };
    syncBadge(it);
    return wrap;
  }
  function syncBadge(it) {
    var b = it.els && it.els.badge;
    if (!b) return;
    var src = it.nameSrc;
    // The badge sits at the end of the text's own direction (an English name in an Arabic UI, or the reverse).
    if (it.els.box) it.els.box.setAttribute("dir", textDir(it.els.name.value) || AM.dir());
    b.hidden = !src;
    if (it.els.name) it.els.name.classList.toggle("has-badge", !!src);
    if (!src) return;
    var label = src === "dcl" ? t("scan.from_dcl") : src === "db" ? t("scan.from_db") : t("scan.suggested");
    var tip = src === "dcl" ? t("scan.from_dcl_tip") : src === "db" ? t("scan.from_db_tip") : t("scan.suggested_tip");
    AM.fill(b, ic("sparkles"), h("span", null, label));
    b.setAttribute("data-tip", tip);
  }
  function syncNameField(it) {
    if (!it.els || !it.els.name) return;
    if (!it.nameTouched && it.els.name.value !== it.name) it.els.name.value = it.name;
    syncBadge(it);
  }

  function readout(key, value, alt, src, o) {
    o = o || {};
    return h("div", { class: ["readout", o.wide && "readout--wide"] },
      h("span", { class: "key" }, key),
      h("span", { class: ["readout__value", o.text && "readout__value--text"], dir: o.text ? "auto" : "ltr" }, value, alt != null && alt !== "" ? h("span", { class: "alt" }, alt) : null),
      src ? h("span", { class: "readout__src" }, src) : null);
  }
  function readouts(it) {
    var p = it.proto, e = it.enrich, list = [];
    if (it.unknown) return null;
    if (p === "matter") {
      var mi = it.info || (it.info = matterInfo(it.body));
      if (mi) {
        if (mi.vid != null && mi.vid !== 0) {
          var vn = e.vendor && e.vendor.name;
          list.push(vn ? readout(t("scan.key_vendor"), vn, null, h("span", { class: "mono", dir: "ltr" }, hex(mi.vid) + " · " + mi.vid), { text: true })
            : readout(t("scan.key_vendor"), hex(mi.vid), String(mi.vid)));
          if (mi.pid != null) list.push(readout(t("scan.key_product"), hex(mi.pid), String(mi.pid), e.model ? [ic("badge-check"), h("span", null, t("scan.csa_dcl"))] : null));
        }
        var pc = String(mi.pincode).padStart(8, "0");
        var okPc = BAD_PASSCODES.indexOf(pc) < 0 && mi.pincode > 0 && mi.pincode < 99999999;
        list.push(readout(t("scan.key_passcode"), pc, null, [ic(okPc ? "circle-check" : "circle-alert"), h("span", null, t(okPc ? "scan.valid" : "scan.passcode_invalid"))]));
        var disc = [];
        if (mi.discovery != null) {
          if (mi.discovery & 1) disc.push(t("scan.disc_softap"));
          if (mi.discovery & 2) disc.push(t("scan.disc_ble"));
          if (mi.discovery & 4) disc.push(t("scan.disc_ip"));
        }
        var srcTxt = [t("scan.short_disc", { value: String(mi.short_discriminator) })].concat(disc).join(" · ");
        list.push(mi.long_discriminator != null
          ? readout(t("scan.key_discriminator"), String(mi.long_discriminator), hex(mi.long_discriminator, 3), srcTxt)
          : readout(t("scan.key_discriminator"), String(mi.short_discriminator), null, t("scan.short_only")));
      }
    } else if (p === "zwave") {
      var zi = it.info || (it.info = zwaveInfo(it.body));
      if (zi) {
        var sc = zi.requestedSecurityClasses || {};
        var cls = [];
        if (sc.s2AccessControl) cls.push(t("code.decode_zwave_s2_access_control"));
        if (sc.s2Authenticated) cls.push(t("code.decode_zwave_s2_authenticated"));
        if (sc.s2Unauthenticated) cls.push(t("code.decode_zwave_s2_unauthenticated"));
        if (sc.s0Legacy) cls.push(t("code.decode_zwave_s0"));
        if (cls.length) list.push(readout(t("scan.key_security"), cls.join(" · "), null, zi.smartStart ? t("code.decode_zwave_smartstart") : null, { text: true, wide: true }));
        var m = zi.meta || {};
        if (m.manufacturerId != null) {
          var mf = e.zw && e.zw.manufacturer;
          list.push(mf ? readout(t("scan.key_manufacturer"), mf, null, h("span", { class: "mono", dir: "ltr" }, hex(m.manufacturerId)), { text: true }) : readout(t("scan.key_manufacturer"), hex(m.manufacturerId)));
        }
        if (m.productType != null && m.productId != null) {
          var lb = e.zw && e.zw.label;
          var ids = hex(m.productType) + " · " + hex(m.productId);
          list.push(lb ? readout(t("scan.key_product"), lb, null, [h("span", { class: "mono", dir: "ltr" }, ids)], { text: true }) : readout(t("scan.key_product"), ids));
        }
      }
    } else if (p === "homekit") {
      var b = it.body;
      if (b.setup_id) list.push(readout(t("scan.key_setup_id"), b.setup_id));
      if (b.qr_payload) list.push(readout(t("scan.key_category"), hkCatName(b.homekit_category || "other"), null, null, { text: true }));
    } else if (p === "zigbee" && it.parsed.zigbee_ieee) {
      list.push(readout(t("scan.key_eui64"), it.parsed.zigbee_ieee, null, null, { wide: true }));
      list.push(readout(t("scan.key_install_code"), it.parsed.zigbee_install_code, null, null, { wide: true }));
    }
    if (!list.length) return null;
    var box = h("div", { class: "readouts readouts--2 p-" + p }, list);
    it.readoutsEl = box;
    return box;
  }
  function refreshReadouts(it) {
    var old = it.readoutsEl;
    var fresh = readouts(it);
    if (old && old.parentNode && fresh) old.parentNode.replaceChild(fresh, old);
  }

  function catsField(it) {
    var row = h("div", { class: "row row--wrap result__cats", role: "group", "aria-labelledby": "scn-cats-l" });
    function draw() {
      AM.fill(row, AM.cat.list().map(function (c) {
        var on = it.cats.indexOf(c.id) >= 0;
        return h("button", {
          type: "button", class: "chip", "aria-pressed": String(on),
          onclick: function (e) {
            var i = it.cats.indexOf(c.id);
            if (i >= 0) it.cats.splice(i, 1); else it.cats.push(c.id);
            e.currentTarget.setAttribute("aria-pressed", String(i < 0));
          },
        }, AM.cat.markEl(c), h("span", { dir: "auto" }, c.name));
      }), AM.can("openCategoryEditor") ? button("chip chip--dashed", "plus", t("scan.new_category"), function () {
        AM.act("openCategoryEditor", null, {
          onSaved: function (cat) {
            if (cat && cat.id && it.cats.indexOf(cat.id) < 0) it.cats.push(cat.id);
            AM.refresh({ force: true }).then(function () { if (S && S.result === it) draw(); }, function () { if (S && S.result === it) draw(); });
          },
        });
      }) : null);
    }
    draw();
    return h("div", { class: "field" }, h("span", { class: "field__label", id: "scn-cats-l" }, t("scan.categories"), h("span", { class: "opt" }, t("scan.optional"))), row);
  }

  function batchRow() {
    var sw = h("input", { type: "checkbox", class: "switch", role: "switch", id: "scn-batch" });
    sw.checked = batchOn();
    sw.addEventListener("change", function () {
      AM.prefs.set("batch", sw.checked);
      var p = S && S.els.sheet.querySelector(".result__foot .btn--primary");
      if (p && S.result) { var fresh = primaryButton(S.result); p.replaceWith(fresh); }
    });
    return h("label", { class: "batch-row", for: "scn-batch" }, ic("layers"), h("span", null, t("scan.keep_scanning")), sw);
  }

  function nextLabel() {
    var src = S.result && S.result.meta ? S.result.meta.source : S.source;
    if (src === "photo") return [ "image-plus", t("scan.another_image") ];
    if (src === "paste") return [ "clipboard-paste", t("scan.paste_another") ];
    return [ "scan-line", t("scan.scan_next") ];
  }
  function primaryButton(it) {
    var label, iconName = "check";
    if (it.kind === "dup") { var nl = nextLabel(); iconName = nl[0]; label = nl[1]; }
    else if (S.single) label = t("scan.use_code");
    else if (it.unknown) label = batchOn() ? t("scan.save_other_next") : t("scan.save_as_other");
    else label = batchOn() ? t("editor.save_scan_next") : t("action.save");
    var b = button("btn btn--primary", iconName, label, primaryAction);
    b.appendChild(kbd("↵"));
    return b;
  }
  function footer(it) {
    if (it.kind === "dup") return [button("btn", "maximize-2", t("scan.open"), function () { openExisting(it.dup.id); }), h("span"), primaryButton(it)];
    if (S.single) return [button("btn", null, t("scan.skip"), skipResult), h("span"), primaryButton(it)];
    return [
      button("btn", null, t("scan.skip"), skipResult),
      button("btn", "pencil", [h("span", { class: "not-phone" }, t("scan.edit_details")), h("span", { class: "only-phone" }, t("action.edit"))], function () { editDetails(it); }),
      primaryButton(it),
    ];
  }

  function primaryAction() {
    if (!S) return;
    if (S.multi) { saveMulti(); return; }
    var it = S.result;
    if (!it) return;
    if (it.kind === "dup") { resumeSource({ clearPaste: true }); return; }
    if (S.single) { deliver(it); return; }
    saveResult(it);
  }

  function wireSheetSwipe(sheet) {
    var st = null;
    sheet.addEventListener("pointerdown", function (e) {
      if (!AM.mq.phone.matches || e.button > 0) return;
      if (!e.target.closest(".sheet__grabber, .result__head") || e.target.closest("button, a, input")) return;
      st = { y: e.clientY, id: e.pointerId, dy: 0, t: Date.now() };
    });
    sheet.addEventListener("pointermove", function (e) {
      if (!st || e.pointerId !== st.id) return;
      st.dy = Math.max(0, e.clientY - st.y);
      if (st.dy > 4) { sheet.style.transition = "none"; sheet.style.transform = "translateY(" + st.dy + "px)"; }
    });
    function end(e) {
      if (!st || e.pointerId !== st.id) return;
      var s = st;
      st = null;
      sheet.style.transition = "";
      sheet.style.transform = "";
      if (s.dy > 110 || (s.dy > 40 && Date.now() - s.t < 250)) skipWithGuard();
    }
    sheet.addEventListener("pointerup", end);
    sheet.addEventListener("pointercancel", end);
  }

  // ---------- actions ----------
  function prefillOf(it) {
    var b = it.body, p = it.proto;
    var pre = {
      code_type: p === "zigbee" || p === "tuya" ? p : b.code_type,
      manual_code: b.manual_code || "", qr_payload: b.qr_payload || "",
      setup_id: b.setup_id || "", homekit_category: b.homekit_category || "other",
      homekit_flag: b.homekit_flag != null ? b.homekit_flag : 2, custom_standard: b.custom_standard || "",
    };
    var out = Object.assign({}, it.parsed, pre);
    if (!S.single || it.nameTouched) out.name = (it.name || "").trim() || it.defaultName || "";
    var v = vendorOf(it), pr = productOf(it);
    if (v) out.device_vendor = v;
    if (pr) out.device_product = pr;
    if (it.cats && it.cats.length) out.category_ids = it.cats.slice();
    return out;
  }

  function deliver(it) {
    if (!S) return;
    it.delivered = true;
    var pre = prefillOf(it);
    var cb = S.onResult;
    AM.log("Scan: filled the editor protocol=" + it.proto + " source=" + (it.meta && it.meta.source));
    closeNow("filled");
    if (cb) { try { cb(pre); } catch (e) { console.error(e); } }
    else if (AM.can("openEditor")) AM.act("openEditor", null, pre, { provenance: "scan" });
  }

  function editDetails(it) {
    if (!S) return;
    var pre = prefillOf(it);
    it.delivered = true;
    closeNow("edit");
    AM.act("openEditor", null, pre, { provenance: "scan" });
  }

  function openExisting(id) {
    if (!S) return;
    guardPending().then(function (ok) {
      if (!ok || !S) return;
      closeNow("open");
      if (AM.can("openDetail")) AM.act("openDetail", id);
    });
  }

  function saveBodyOf(it) {
    var b = it.body, p = it.proto;
    var body = {
      name: (it.name || "").trim() || it.defaultName || nextDefaultName(),
      code_type: b.code_type, manual_code: b.manual_code || "", qr_payload: b.qr_payload || "",
      custom_standard: b.custom_standard || "", category_ids: (it.cats || []).slice(),
    };
    if (b.code_type === "homekit") {
      body.setup_id = b.setup_id || "";
      body.homekit_category = b.homekit_category || "other";
      if (b.homekit_flag != null) body.homekit_flag = b.homekit_flag;
    }
    var v = vendorOf(it), pr = productOf(it);
    if (v) body.device_vendor = v;
    if (pr) body.device_product = pr;
    var conn = AM.proto.meta(p).conn;
    if (conn) body[conn] = true;
    return body;
  }

  /** POST the item. Resolves true (saved), "dup" (server 409; item switched to duplicate) or false (error shown). */
  function saveItem(it) {
    var body = saveBodyOf(it);
    it.saving = true;
    return AM.api("/codes", { method: "POST", body: body }).then(function (code) {
      it.saving = false;
      it.saved = code;
      it.name = body.name;
      if (S) {
        S.names.push(body.name);
        addTraySaved(it, code);
      }
      AM.haptic("success");
      AM.log("Scan: saved protocol=" + it.proto + " source=" + (it.meta ? it.meta.source : it.source));
      return true;
    }, function (err) {
      it.saving = false;
      if (err && err.code === "duplicate") {
        it.dup = err.existing ? { id: err.existing.id, name: err.existing.name || "" } : { id: "", name: "" };
        it.kind = "dup";
        if (S) addTrayDup(it);
        AM.haptic("warning");
        return "dup";
      }
      AM.haptic("failure");
      AM.reportError(err);
      return false;
    });
  }

  function saveResult(it) {
    if (it.saving || it.saved) return;
    var btn = S.els.sheet.querySelector(".result__foot .btn--primary");
    if (btn) { btn.disabled = true; btn.setAttribute("aria-busy", "true"); }
    saveItem(it).then(function (ok) {
      if (!S || S.result !== it) return;
      if (btn) { btn.disabled = false; btn.removeAttribute("aria-busy"); }
      if (ok === "dup") { renderSheet(); if (S.locked) layoutFreeze(); focusPrimary(); return; }
      if (ok !== true) return;
      AM.refresh({ force: true });
      if (batchOn()) {
        announce(t("scan.saved_toast", { name: it.name }));
        resumeSource({ clearPaste: true });
      } else {
        closeNow("saved");
      }
    });
  }

  function announce(msg) {
    if (!S) return;
    var region = byId("scn-live") || h("span", { id: "scn-live", class: "sr-only", role: "status", "aria-live": "polite" });
    if (S && !region.isConnected) S.els.root.appendChild(region);
    region.textContent = "";
    setTimeout(function () { region.textContent = msg; }, 30);
  }

  // ======================================================================
  // Several codes in one capture
  // ======================================================================
  function showMulti(items, meta) {
    S.result = null;
    var m = { items: items, meta: meta, inSheet: S.layout === "camera" };
    S.multi = m;
    var extra = [];
    items.forEach(function (it) {
      it.meta = meta;
      it.checked = it.kind !== "dup" && !it.low && !it.unknown;
      it.info = it.proto === "matter" ? matterInfo(it.body) : it.proto === "zwave" ? zwaveInfo(it.body) : null;
      var sug = suggestName(it);
      it.defaultName = nextDefaultName(extra);
      if (!sug) extra.push(it.defaultName); // numbered defaults stay distinct within the photo
      it.name = (sug && sug.name) || it.defaultName;
      enrich(it);
      checkServer(it);
      if (it.kind === "dup" && !S.single) addTrayDup(it);
    });
    AM.haptic(items.some(function (i) { return i.kind !== "dup"; }) ? "success" : "warning");
    if (S.layout === "camera") {
      if (meta.source === "photo") setView("photo-result");
      else if (meta.source === "paste") setView("paste");
      else if (meta.source === "native") setView("native");
      else { syncState(); renderHud(); }
      renderMulti();
      if (meta.source === "camera") layoutFreeze();
    } else {
      S.view = "multi";
      renderPage();
      var pk = S.els.col2.querySelector(".picker");
      if (pk && global.innerWidth <= 900) pk.scrollIntoView({ block: "start", behavior: AM.mq.reducedMotion.matches ? "auto" : "smooth" });
    }
    focusPrimary();
  }

  function multiTitle(m) {
    var n = m.items.length, src = m.meta.source;
    return t(src === "photo" ? "scan.multi_title" : src === "paste" ? "scan.multi_title_paste" : "scan.multi_title_camera", { count: n });
  }
  function pickList(m) {
    var list = h("div", { class: "picker__list", role: "group", "aria-label": t("scan.codes_to_save") });
    m.items.forEach(function (it) {
      var f = AM.proto.formatCode(it.body);
      var qr = h("span", { class: "pick__qr", "aria-hidden": "true" });
      miniQr(it.body, qr, 36);
      var sub;
      if (it.kind === "dup") sub = h("span", null, AM.tNodes("scan.already_saved_as", {}, { name: h("bdi", { dir: "auto" }, it.dup.name) }));
      else if (it.saved) sub = h("span", { class: "pick__ok" }, ic("check", "icon--sm"), t("scan.saved"));
      else if (it.unknown) sub = h("span", null, t("scan.pick_unknown"));
      else if (it.low) sub = h("span", null, t("scan.pick_low"));
      else {
        var vp = [vendorOf(it), productOf(it)].filter(Boolean).join(" · ");
        sub = h("span", { dir: "auto" }, vp || it.name);
      }
      var txt = h("span", { class: "pick__txt" },
        h("b", null, h("span", { class: "proto p-" + it.proto }, it.unknown ? t("scan.unknown_short") : AM.proto.name(it.body)),
          f.text ? h("span", { class: "mono", dir: "ltr" }, f.pre ? f.pre + " " + f.text : f.text) : h("span", { class: "mono trunc", dir: "ltr" }, it.body.qr_payload)),
        sub);
      var n = h("span", { class: "pick__n", "aria-hidden": "true" }, String(it.n));
      var row;
      if (it.kind === "dup") {
        row = h("div", { class: "pick pick--dup" },
          h("input", { type: "checkbox", class: "check", disabled: true, "aria-label": t("scan.already_saved_short") }), qr, txt,
          button("btn btn--sm", null, t("scan.open"), function () { openExisting(it.dup.id); }), n);
      } else if (S.single) {
        row = h("div", { class: "pick pick--use" }, qr, txt, button("btn btn--sm btn--primary", "check", t("scan.use_this"), function () { S.result = it; S.multi = null; deliver(it); }), n);
      } else {
        var cb = h("input", { type: "checkbox", class: "check", disabled: !!it.saved });
        cb.checked = !!it.checked && !it.saved;
        cb.addEventListener("change", function () { it.checked = cb.checked; syncMultiFoot(m); });
        row = h("label", { class: ["pick", it.saved && "pick--saved"] }, cb, qr, txt, n);
      }
      list.appendChild(row);
    });
    return list;
  }
  function multiFoot(m) {
    var src = m.meta.source;
    var first = src === "photo" ? button("btn", "image-plus", t(S.layout === "page" ? "scan.another_image" : "scan.another"), function () { anotherImage(); })
      : button("btn", null, t("scan.skip"), function () { skipWithGuard(); });
    if (S.single) return [first, h("span")];
    var n = m.items.filter(function (i) { return i.checked && i.kind !== "dup" && !i.saved; }).length;
    var save = button("btn btn--primary", "check", t("scan.save_n", { count: n }), function () { saveMulti(); }, { disabled: n === 0, "data-role": "save-n" });
    save.appendChild(kbd("↵"));
    return [first, save];
  }
  function syncMultiFoot(m) {
    var root = S.els.root;
    var old = root.querySelector('[data-role="save-n"]');
    if (!old) return;
    var fresh = multiFoot(m)[1];
    if (fresh) old.replaceWith(fresh);
  }
  function anotherImage() {
    guardPending().then(function (ok) {
      if (!ok || !S) return;
      resumeSource({});
      pickFile(false);
    });
  }
  function renderMulti() {
    var m = S && S.multi;
    if (!m) return;
    var newCount = m.items.filter(function (i) { return i.kind !== "dup"; }).length;
    var head = [
      h("h2", { class: "result__title", id: "scn-r-title" }, h("span", { class: "ok-dot" }, ic("check")), h("span", null, multiTitle(m)),
        h("span", { class: "tag tag--ok" }, t("scan.multi_new", { count: newCount }))),
      h("p", { class: "result__sub" }, t(S.single ? "scan.multi_hint_single" : "scan.multi_hint")),
    ];
    if (m.inSheet) {
      var sheet = S.els.sheet;
      sheet.className = "result result--multi";
      AM.fill(sheet, h("div", { class: "sheet__grabber", "aria-hidden": "true" }),
        h("header", { class: "result__head" }, h("div", { class: "result__heading" }, head),
          h("button", { type: "button", class: "icon-btn icon-btn--sm", tip: t("scan.skip_tip"), kbd: "Esc", onclick: skipWithGuard }, ic("x"))),
        h("div", { class: "result__body" }, pickList(m)),
        h("footer", { class: "result__foot result__foot--multi" }, multiFoot(m)));
      sheet.hidden = false;
      wireSheetSwipe(sheet);
      syncState();
      placeMarkers();
    } else {
      renderPage();
    }
  }
  function pickerCard(m) {
    var photo = S.photo && S.photo.url && m.meta.source === "photo" ? photoBox("picker__photo", m.items) : null;
    var newCount = m.items.filter(function (i) { return i.kind !== "dup"; }).length;
    return h("section", { class: "picker", "aria-labelledby": "scn-pk-title" },
      photo,
      h("div", { class: "picker__head" }, h("h3", { id: "scn-pk-title" }, multiTitle(m)), h("span", { class: "spacer" }), h("span", { class: "tag tag--ok" }, t("scan.multi_new", { count: newCount }))),
      h("p", { class: "picker__hint" }, t(S.single ? "scan.multi_hint_single" : "scan.multi_hint")),
      pickList(m),
      h("div", { class: "picker__foot" }, multiFoot(m)));
  }

  function saveMulti() {
    var m = S && S.multi;
    if (!m || m.saving || S.single) return;
    var todo = m.items.filter(function (i) { return i.checked && i.kind !== "dup" && !i.saved; });
    if (!todo.length) return;
    m.saving = true;
    var btn = S.els.root.querySelector('[data-role="save-n"]');
    if (btn) { btn.disabled = true; btn.setAttribute("aria-busy", "true"); }
    var chain = Promise.resolve(), saved = 0;
    todo.forEach(function (it) {
      chain = chain.then(function () {
        if (!S || S.multi !== m) return null;
        if (!it.nameTouched) {
          var sug = suggestName(it);
          if (sug) it.name = sug.name;
          else if (S.names.indexOf(it.name) >= 0 || AM.store.vault.codes.some(function (c) { return c.name === it.name; })) it.name = nextDefaultName();
        }
        return saveItem(it).then(function (ok) { if (ok === true) saved++; });
      });
    });
    chain.then(function () {
      if (!S || S.multi !== m) return;
      m.saving = false;
      AM.refresh({ force: true });
      var left = m.items.some(function (i) { return i.kind !== "dup" && !i.saved && i.checked; });
      if (left) { renderMulti(); return; }
      if (batchOn()) {
        announce(t("scan.done_saved", { count: saved }));
        resumeSource({ clearPaste: true });
      } else closeNow("saved");
    });
  }

  // ======================================================================
  // Photo mode
  // ======================================================================
  function pickFile(take) {
    var inp = take ? S.els.fileTake : S.els.fileChoose;
    if (!inp) return;
    inp.value = "";
    try { inp.click(); } catch (e) { /* ignore */ }
  }

  /** Scan an image File: from the pickers, drag-and-drop, or a pasted image. */
  function scanFile(file) {
    if (!file) return;
    if (!S || !AM.sheets.isOpen("scanner")) { openScanner({ mode: "vault", source: "photo", file: file }); return; }
    guardPending().then(function (ok) { if (ok && S) decodeFile(file); });
  }

  function decodeFile(file) {
    var isImg = /^image\//.test(file.type || "") || /\.(png|jpe?g|gif|webp|bmp|avif|heic|heif|tiff?)$/i.test(file.name || "");
    stopCamera();
    stopNative();
    clearResult();
    S.source = "photo";
    syncSeg();
    if (S.photo && S.photo.url) { try { URL.revokeObjectURL(S.photo.url); } catch (e) { /* ignore */ } }
    S.photo = null;
    if (!isImg || !E()) {
      S.photoFail = !E() ? "unsupported" : "unsupported_image";
      setView("photo");
      return;
    }
    S.photo = { url: URL.createObjectURL(file), width: 0, height: 0 };
    S.photoFail = null;
    var token = ++S.decodeToken;
    var t0 = Date.now();
    setView("decoding");
    E().decodeImage(file, { multi: true }).then(function (res) {
      if (!S || S.decodeToken !== token) return;
      S.photo.width = res.width || 0;
      S.photo.height = res.height || 0;
      if (!res.results || !res.results.length) { var e = new Error("not_found"); e.code = "not_found"; throw e; }
      if (!S.photoLogged) { S.photoLogged = true; AM.log("Scan: engine=" + (res.engine || "unknown") + " source=photo"); }
      capture(res.results.map(function (r) { return { text: r.text, corners: r.corners }; }), { source: "photo", ms: res.ms != null ? res.ms : Date.now() - t0 });
    }).catch(function (err) {
      if (!S || S.decodeToken !== token) return;
      var code = (err && err.code) || "not_found";
      S.photoFail = ["not_found", "unsupported_image", "unsupported", "timeout"].indexOf(code) >= 0 ? code : "decode_failed";
      AM.haptic("failure");
      AM.log("Scan: photo decode failed reason=" + S.photoFail);
      setView("photo");
      var a = S.els.root.querySelector(".photo-fail .btn");
      if (a) a.focus({ preventScroll: true });
    });
  }
  function cancelDecode() {
    S.decodeToken++;
    setView("photo");
    focusMode();
  }

  function photoFailNotice() {
    var code = S.photoFail;
    if (!code) return null;
    var title = code === "not_found" ? t("scan.no_code_in_image") : tk("scan.err_", code);
    var body = code === "not_found" ? t("scan.photo_tips") : code === "unsupported_image" ? t("scan.photo_format_tip") : null;
    return h("div", { class: "notice notice--warn photo-fail", role: "alert" }, ic("triangle-alert"),
      h("div", { class: "notice__body" }, h("span", { class: "notice__title" }, title), body ? h("span", null, body) : null,
        h("div", { class: "notice__actions" },
          button("btn btn--sm", "image-plus", t("scan.choose_another"), function () { pickFile(false); }),
          button("btn btn--sm", "keyboard", t("scan.type_code"), typeCode))));
  }
  function dropzone() {
    var keys = /Mac|iP(hone|ad|od)/.test((global.navigator || {}).platform || "") ? "⌘" : "Ctrl";
    var hint = AM.mq.hover.matches && !AM.mq.phone.matches
      ? AM.tNodes("scan.drop_hint_paste", {}, { keys: h("span", { class: "key-caps", dir: "ltr" }, h("kbd", { class: "key-cap" }, keys), h("kbd", { class: "key-cap" }, "V")) })
      : t("scan.drop_hint");
    var tile = h("span", { class: "qr-float" }, ic("qr-code", "qr-float__icon"));
    var zone = h("section", { class: "dropzone", "aria-labelledby": "scn-dz-title" },
      h("div", { class: "dropzone__art", "aria-hidden": "true" }, orbits(220, 120), tile),
      h("h3", { id: "scn-dz-title" }, t("scan.take_photo_title")),
      h("p", null, hint),
      h("div", { class: "dropzone__actions" },
        button("btn btn--hero btn--lg", "camera", t("scan.take_photo"), function () { pickFile(true); }),
        button("btn btn--lg", "image-plus", t("scan.choose_image"), function () { pickFile(false); })),
      h("span", { class: "dropzone__fine" }, ic("shield-check"), t("scan.local_only")));
    S.els.dropzone = zone;
    return zone;
  }
  function photoPanel() {
    return h("div", { class: "photo-panel" }, h("div", { class: "panel__inner" }, photoFailNotice(), dropzone(), haCard(true)));
  }
  function decodingView() {
    return h("div", { class: "decoding" },
      h("div", { class: "decoding__col" },
        S.photo && S.photo.url ? h("div", { class: "decoding__photo" }, h("img", { src: S.photo.url, alt: t("scan.your_photo") }), h("span", { class: "decoding__scan" })) : null,
        h("div", { class: "decoding__text" },
          h("b", null, t("scan.reading_photo")),
          h("div", { class: "progress", role: "progressbar", "aria-label": t("scan.reading_photo") }, h("span")),
          h("span", null, t("scan.reading_fixes"))),
        darkBtn(null, t("action.cancel"), cancelDecode)));
  }
  function photoBox(cls, items) {
    var box = h("div", { class: cls + " photo-box" });
    var img = h("img", { src: S.photo.url, alt: t("scan.your_photo") });
    box.appendChild(img);
    var w = S.photo.width, hh = S.photo.height;
    if (w && hh) box.style.setProperty("--ar", String(Math.min(2.2, Math.max(1, w / hh))));
    (items || []).forEach(function (it) {
      if (!it.corners || it.corners.length !== 4) return;
      var cx = 0, cy = 0;
      it.corners.forEach(function (p) { cx += p.x / 4; cy += p.y / 4; });
      box.appendChild(h("span", { class: ["picker__mark", it.kind === "dup" && "picker__mark--dup"], "data-x": String(cx), "data-y": String(cy), "aria-hidden": "true" }, String(it.n)));
    });
    img.addEventListener("load", placeMarkers);
    // The box resizes while the camera area makes room for the sheet: keep the markers on the codes.
    if (global.ResizeObserver && S) {
      var ro = new global.ResizeObserver(function () { placeMarkers(); });
      ro.observe(box);
      S.off.push(function () { ro.disconnect(); });
    }
    return box;
  }
  /** Markers sit on the code centres of an object-fit: contain photo (physical positions, never mirrored). */
  function placeMarkers() {
    if (!S || !S.photo || !S.photo.width) return;
    AM.$$(".photo-box", S.els.root).forEach(function (box) {
      var bw = box.clientWidth, bh = box.clientHeight, w = S.photo.width, hh = S.photo.height;
      if (!bw || !bh) return;
      var s = Math.min(bw / w, bh / hh), ox = (bw - w * s) / 2, oy = (bh - hh * s) / 2;
      AM.$$(".picker__mark", box).forEach(function (mk) {
        mk.style.left = ox + parseFloat(mk.getAttribute("data-x")) * s + "px";
        mk.style.top = oy + parseFloat(mk.getAttribute("data-y")) * s + "px";
      });
    });
  }
  function photoView() {
    var items = S.multi ? S.multi.items : [];
    return h("div", { class: "photo-view" }, S.photo && S.photo.url ? photoBox("photo-view__box", items) : null);
  }

  // ======================================================================
  // Paste mode
  // ======================================================================
  function pasteBox() {
    if (S.els.pasteBox) return S.els.pasteBox;
    var area = h("textarea", { class: "textarea input--mono", id: "scn-paste", dir: "ltr", rows: "3", spellcheck: "false", autocomplete: "off", autocapitalize: "off", "aria-describedby": "scn-paste-detect" });
    var detect = h("div", { class: "detect-row", id: "scn-paste-detect", role: "status", hidden: true });
    var go = button("btn btn--primary btn--lg", "arrow-right", t("scan.continue"), function () { continuePaste(); }, { disabled: true });
    go.querySelector(".icon").classList.add("icon--flip-rtl");
    area.addEventListener("input", AM.debounce(detectPaste, 120));
    area.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); continuePaste(); }
    });
    var fmts = h("div", { class: "formats" },
      h("span", null, t("scan.recognised")),
      h("span", null, h("code", { dir: "ltr" }, "MT:…"), " ", t("scan.fmt_matter")),
      h("span", null, h("code", { dir: "ltr" }, "X-HM://…"), " ", t("scan.fmt_homekit")),
      h("span", null, h("code", { dir: "ltr" }, "90…"), " ", t("scan.fmt_zwave")),
      h("span", null, t("scan.fmt_other")));
    S.els.pasteArea = area;
    S.els.pasteDetect = detect;
    S.els.pasteGo = go;
    S.els.pasteBox = h("div", { class: "paste-box" },
      h("div", { class: "field" }, h("label", { class: "field__label", for: "scn-paste" }, t("scan.paste_label")), area),
      detect, go, fmts);
    return S.els.pasteBox;
  }
  function pastePanel() { return h("div", { class: "paste-panel" }, h("div", { class: "panel__inner" }, pasteBox())); }
  function focusPaste() { setTimeout(function () { if (S && S.els.pasteArea && S.els.pasteArea.isConnected) S.els.pasteArea.focus({ preventScroll: true }); }, 40); }
  function pasteLines(text) {
    return String(text || "").split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean).map(function (s) { return { text: s }; });
  }
  function detectPaste() {
    if (!S || !S.els.pasteArea) return;
    var lines = pasteLines(S.els.pasteArea.value);
    var row = S.els.pasteDetect;
    S.els.pasteGo.disabled = !lines.length;
    if (!lines.length) { row.hidden = true; AM.fill(row); return; }
    var items = itemsFrom(lines, "paste");
    row.hidden = false;
    row.className = "detect-row";
    if (items.length > 1) {
      var dups = items.filter(function (i) { return i.kind === "dup"; }).length;
      AM.fill(row, ic("circle-check"), h("span", null, t("scan.n_codes", { count: items.length })), h("span", { class: "spacer" }),
        h("span", { class: "tag tag--ok" }, t("scan.multi_new", { count: items.length - dups })));
      return;
    }
    var it = items[0];
    if (!it) { row.hidden = true; return; }
    if (it.unknown) row.classList.add("detect-row--info");
    else if (it.kind === "dup") row.classList.add("detect-row--warn");
    var f = AM.proto.formatCode(it.body);
    var parts = [h("b", null, it.unknown ? t("scan.unknown_short") : AM.proto.name(it.body))];
    if (f.text) parts.push(" · ", h("span", { class: "mono", dir: "ltr" }, f.pre ? f.pre + " " + f.text : f.text));
    if (it.unknown) parts.push(" · ", t("scan.will_save_other"));
    else if (it.low) parts.push(" · ", t("scan.pick_low"));
    var tag = it.kind === "dup" ? h("span", { class: "tag tag--warn" }, t("scan.duplicate_tag")) : h("span", { class: "tag tag--ok" }, t("scan.new_short"));
    AM.fill(row, ic(it.unknown ? "info" : it.kind === "dup" ? "triangle-alert" : "circle-check"), h("span", { class: "detect-row__txt" }, parts), h("span", { class: "spacer" }), tag);
    // Vendor from the DCL when it is already known (no extra request while typing).
    if (it.proto === "matter") {
      var mi = matterInfo(it.body);
      var known = mi && mi.vid ? AM.lookup.peek("/matter/vendor/" + mi.vid) : null;
      if (known) {
        known.then(function (v) {
          var tx = row.querySelector(".detect-row__txt");
          if (v && v.name && tx && S && S.els.pasteArea && pasteLines(S.els.pasteArea.value).length === 1) tx.append(" · ", h("span", { dir: "auto" }, v.name));
        });
      }
    }
  }
  function continuePaste() {
    if (!S || !S.els.pasteArea) return;
    var lines = pasteLines(S.els.pasteArea.value);
    if (!lines.length) return;
    capture(lines, { source: "paste" });
  }
  /** Text pasted anywhere in the scanner (not into a field): go to Paste mode with it. */
  function pasteText(text) {
    if (!S) return;
    guardPending().then(function (ok) {
      if (!ok || !S) return;
      if (S.source !== "paste") enterMode("paste", {});
      else clearResult();
      pasteBox();
      S.els.pasteArea.value = String(text || "").trim();
      detectPaste();
      var items = itemsFrom(pasteLines(S.els.pasteArea.value), "paste");
      if (items.length && items.every(function (i) { return !i.unknown; })) continuePaste();
      else focusPaste();
    });
  }

  // ======================================================================
  // Page layout (no live camera)
  // ======================================================================
  function renderPage() {
    if (!S || S.layout !== "page") return;
    var els = S.els, v = S.variant;
    var url = global.location.protocol + "//" + global.location.host;
    var title = v === "insecure" ? t("scan.fallback_title") : v === "blocked" ? t("scan.blocked_title") : t("scan.nocamera_title");
    var body = v === "insecure"
      ? AM.tNodes("scan.fallback_body", {}, { url: h("code", { dir: "ltr" }, url) })
      : v === "blocked" ? t("scan.blocked_page_body") : t("scan.nocamera_body");
    var tags = h("div", { class: "status-tags", role: "list" });
    if (v === "insecure") tags.appendChild(h("span", { class: "tag tag--warn", role: "listitem" }, ic("lock-open"), h("span", null, t("scan.tag_http"))));
    tags.appendChild(h("span", { class: ["tag", v === "blocked" && "tag--warn"], role: "listitem" }, ic("camera-off"), h("span", null, v === "nocamera" ? t("scan.tag_no_camera") : v === "blocked" ? t("scan.tag_blocked") : t("scan.tag_no_live"))));
    var dec = h("span", { class: "tag", role: "listitem" }, ic("loader-circle", "spin"), h("span", null, t("scan.tag_decoder_loading")));
    tags.appendChild(dec);
    var eng = E();
    Promise.resolve(eng ? eng.warmup() : false).then(function (ok) {
      ok = ok || engineEnv().canDecodeImages;
      AM.fill(dec, ic(ok ? "shield-check" : "circle-x"), h("span", null, t(ok ? "scan.tag_decoder_ready" : "scan.tag_decoder_missing")));
      dec.className = "tag " + (ok ? "tag--ok" : "tag--danger");
    });
    var panel;
    if (S.view === "decoding") panel = h("div", { class: "decoding decoding--card" }, decodingView().firstChild);
    else if (S.source === "paste") panel = h("section", { class: "paste-card" }, pasteBox());
    else panel = h("div", { class: "stack" }, photoFailNotice(), dropzone());
    var howto = v === "insecure" ? h("details", { class: "howto disclosure", open: !AM.mq.phone.matches },
      h("summary", null, ic("circle-help"), h("span", null, t("scan.howto_title")), ic("chevron-down", "chev")),
      h("ol", null,
        h("li", null, h("b", null, t("scan.howto_1_b")), " ", t("scan.howto_1")),
        h("li", null, h("b", null, t("scan.howto_2_b")), " ", t("scan.howto_2")),
        h("li", null, h("b", null, t("scan.howto_3_b")), " ", t("scan.howto_3")))) : null;
    AM.fill(els.col1, h("div", { class: "fallback-hero" }, h("h2", null, title), h("p", null, body)), tags, panel, haCard(false), howto);
    var m = S.multi;
    els.col2.hidden = !m;
    AM.fill(els.col2, m ? pickerCard(m) : null);
    els.root.classList.toggle("has-side", !!m);
    placeMarkers();
    if (S.source === "paste" && S.view !== "decoding") detectPaste();
  }

  /** HA app scanner: an action in the Companion app, a non-actionable hint elsewhere (SPEC §13.12). */
  function haCard(compact) {
    if (S.bridge) {
      return h("div", { class: "hint-card" + (compact ? " hint-card--compact" : "") },
        h("span", { class: "hint-card__icon" }, ic("smartphone")),
        h("div", { class: "hint-card__body" }, h("h3", null, t("scan.ha_scanner_title")), h("p", null, t("scan.ha_scanner_body")),
          button("btn btn--primary btn--sm", "smartphone", t("scan.use_ha_scanner"), function () { S.camEngine = "native"; if (S.layout === "page") toCameraLayout(); else enterMode("camera", {}); })));
    }
    if (compact) return null;
    return h("div", { class: "hint-card" },
      h("span", { class: "hint-card__icon" }, ic("smartphone")),
      h("div", null, h("h3", null, t("scan.ha_hint_title")), h("p", null, AM.tNodes("scan.ha_hint_body", {}, { app: h("b", null, t("scan.ha_app")), http: h("span", { dir: "ltr" }, "http://") }))));
  }

  // ======================================================================
  // Session tray
  // ======================================================================
  function trayCounts() {
    var c = { saved: 0, dups: 0 };
    if (S) S.tray.forEach(function (r) { if (r.status === "saved") c.saved++; else c.dups++; });
    return c;
  }
  function sessionText(c) {
    var parts = [];
    if (c.saved) parts.push(t("scan.session_saved", { count: c.saved }));
    if (c.dups) parts.push(t("scan.session_dups", { count: c.dups }));
    return parts.join(" · ");
  }
  function addTraySaved(it, code) {
    removeTrayDup(it);
    S.tray.unshift({ key: "s" + code.id, status: "saved", code: code, name: code.name || it.name, body: it.body, proto: it.proto });
    renderTray();
  }
  function trayKey(it) { return "d" + (it.dup ? it.dup.id : "") + "|" + it.body.code_type + "|" + (it.body.manual_code || "") + "|" + (it.body.qr_payload || ""); }
  function addTrayDup(it) {
    if (!S || !it.dup) return;
    var key = trayKey(it);
    if (S.tray.some(function (r) { return r.key === key; })) return;
    it.trayKey = key;
    S.tray.unshift({ key: key, status: "dup", existing: it.dup, name: it.dup.name, body: it.body, proto: it.proto });
    renderTray();
  }
  function removeTrayDup(it) {
    if (!S || !it.trayKey) return;
    var k = it.trayKey;
    it.trayKey = null;
    S.tray = S.tray.filter(function (r) { return r.key !== k; });
    renderTray();
  }
  function miniQr(body, box, px) {
    AM.qr.forPayload(body).then(function (svg) {
      if (svg) AM.qr.mount(box, svg, { targetPx: px });
      else AM.fill(box, ic("scan-qr-code", "icon--sm"));
    }, function () { AM.fill(box, ic("scan-qr-code", "icon--sm")); });
  }
  function codeLine(r) {
    var f = AM.proto.formatCode(r.body);
    return h("span", { class: "tray__code" }, AM.proto.name(r.body), f.text ? [" · ", h("span", { class: "mono", dir: "ltr" }, f.pre ? f.pre + " " + f.text : f.text)] : null);
  }
  function renderTray() {
    if (!S) return;
    var els = S.els, c = trayCounts(), any = S.tray.length > 0;
    els.root.classList.toggle("has-tray", any);
    // Panel (desktop; phones: opened from the pill as a sheet)
    if (els.tray) {
      els.tray.hidden = !any;
      els.tray.classList.toggle("is-open", any && S.trayOpen);
      if (any) {
        var rows = h("div", { class: "tray__rows" });
        S.tray.forEach(function (r) {
          var qr = h("span", { class: "tray__qr", "aria-hidden": "true" });
          miniQr(r.body, qr, 36);
          if (r.status === "saved") {
            rows.appendChild(h("div", { class: "tray__row" }, qr,
              h("span", { class: "tray__txt" }, h("b", { dir: "auto" }, r.name), codeLine(r)),
              h("span", { class: "row", style: "--gap:6px" },
                h("span", { class: "tray__state tray__state--ok" }, ic("check", "icon--sm"), t("scan.saved")),
                h("button", { type: "button", class: "tbtn", onclick: function (e) { undoRow(r, e.currentTarget); } }, ic("undo-2", "icon--sm"), t("action.undo")))));
          } else {
            rows.appendChild(h("div", { class: "tray__row tray__row--dup" }, qr,
              h("span", { class: "tray__txt" }, h("span", { class: "tray__state tray__state--warn" }, ic("triangle-alert", "icon--sm"), t("scan.dup_not_saved")),
                h("span", null, AM.tNodes("scan.already_as", {}, { name: h("b", { dir: "auto", class: "tray__inline" }, r.name) }))),
              h("button", { type: "button", class: "tbtn", onclick: function () { openExisting(r.existing.id); } }, t("scan.open"))));
          }
        });
        AM.fill(els.tray,
          h("div", { class: "tray__head" }, ic("layers"), h("span", { id: "scn-tray-title" }, t("scan.session")), h("span", { class: "sub" }, sessionText(c)), h("span", { class: "spacer" }),
            h("button", { type: "button", class: "tbtn", onclick: requestClose }, t("action.done")),
            h("button", { type: "button", class: "tbtn tbtn--icon only-phone-hud", "aria-label": t("action.close"), onclick: function () { setTrayOpen(false); } }, ic("x", "icon--sm"))),
          rows);
      }
    }
    // Pill (phones)
    if (els.pillSlot) {
      if (!any) AM.fill(els.pillSlot);
      else {
        var stack = h("span", { class: "tray-pill__stack", "aria-hidden": "true" });
        S.tray.slice(0, 3).forEach(function (r) { var s = h("span"); miniQr(r.body, s, 28); stack.appendChild(s); });
        var label = sessionText(c);
        AM.fill(els.pillSlot, h("button", { type: "button", class: "tray-pill glass", "aria-label": t("scan.session_aria", { summary: label }), "aria-expanded": String(!!S.trayOpen), onclick: function () { setTrayOpen(!S.trayOpen); } },
          stack,
          h("span", { class: "lbl-long" }, c.saved ? t("scan.session_saved", { count: c.saved }) : null, c.saved && c.dups ? " · " : null, c.dups ? h("span", { class: "warn" }, t("scan.pill_dups", { count: c.dups })) : null),
          h("span", { class: "lbl-short" }, c.saved ? [ic("check", "icon--sm"), h("bdi", null, AM.fmt.number(c.saved))] : null, c.dups ? h("span", { class: "warn" }, ic("triangle-alert", "icon--sm"), h("bdi", null, AM.fmt.number(c.dups))) : null)));
      }
    }
    if (S.view === "native" && S.layout === "camera" && !S.result && !S.multi) setView("native");
  }
  function setTrayOpen(on) {
    if (!S) return;
    S.trayOpen = !!on && S.tray.length > 0;
    renderTray();
    if (S.trayOpen) { var b = S.els.tray.querySelector(".tbtn"); if (b) b.focus({ preventScroll: true }); }
    else { var p = S.els.pillSlot && S.els.pillSlot.querySelector("button"); if (p) p.focus({ preventScroll: true }); }
  }
  function undoRow(r, btnEl) {
    if (r.busy) return;
    r.busy = true;
    if (btnEl) btnEl.disabled = true;
    var id = encodeURIComponent(r.code.id);
    AM.api("/codes/" + id, { method: "DELETE" }).then(function () {
      return AM.api("/codes/" + id + "/purge", { method: "DELETE" }).catch(function () { return null; });
    }).then(function () {
      if (S) {
        S.tray = S.tray.filter(function (x) { return x !== r; });
        S.names = S.names.filter(function (n) { return n !== r.name; });
        renderTray();
        announce(t("scan.undone", { name: r.name }));
      }
      AM.log("Scan: undo protocol=" + r.proto);
      AM.refresh({ force: true });
    }, function (err) {
      r.busy = false;
      if (btnEl) btnEl.disabled = false;
      AM.reportError(err);
    });
  }

  // ======================================================================
  // Keyboard (scope: scanner on top) — SPEC §13.14
  // ======================================================================
  function scanOpen() { return !!S && AM.sheets.top() === "scanner"; }
  AM.shortcuts.register("escape", function () {
    if (!scanOpen()) return false;
    if (S.trayOpen) { setTrayOpen(false); return true; }
    if (S.view === "decoding") { cancelDecode(); return true; }
    if (S.result || S.multi) { skipWithGuard(); return true; }
    return false; // default: close the scanner (through the pending-capture veto)
  }, { scope: "scanner" });
  AM.shortcuts.register("enter", function (e) {
    if (!scanOpen() || !(S.result || S.multi)) return false;
    var tg = e.target;
    if (tg && tg.closest && tg.closest("button, a, textarea, select, summary, [role=radio], [role=switch], [role=slider], input[type=checkbox]")) return false;
    primaryAction();
    return true;
  }, { scope: "scanner", allowInInput: true });
  AM.shortcuts.register("t", function () {
    if (!scanOpen() || !S.cam.session || S.els.torch.hidden) return false;
    toggleTorch();
  }, { scope: "scanner" });
  AM.shortcuts.register("c", function () {
    if (!scanOpen() || !S.cam.session || !S.cam.caps || !(S.cam.caps.cameras || []).length || S.cam.caps.cameras.length < 2) return false;
    switchCamera();
  }, { scope: "scanner" });
  ["+", "="].forEach(function (k) { AM.shortcuts.register(k, function () { if (!scanOpen() || !S.cam.zoom || !S.cam.session) return false; zoomBy(0.5); }, { scope: "scanner" }); });
  AM.shortcuts.register("-", function () { if (!scanOpen() || !S.cam.zoom || !S.cam.session) return false; zoomBy(-0.5); }, { scope: "scanner" });
  [["1", "camera"], ["2", "photo"], ["3", "paste"]].forEach(function (k) {
    AM.shortcuts.register(k[0], function () { if (!scanOpen()) return false; switchMode(k[1]); }, { scope: "scanner" });
  });

  // ======================================================================
  // Drag-and-drop anywhere + Ctrl/⌘+V image paste (global; opens the scanner)
  // ======================================================================
  var veil = null, veilTimer = null;
  function dropAllowed() { var top = AM.sheets.top(); return !top || top === "scanner"; }
  function dragImage(e) {
    var dt = e.dataTransfer;
    if (!dt) return false;
    var types = Array.prototype.slice.call(dt.types || []);
    if (types.indexOf("Files") < 0) return false;
    var items = dt.items;
    if (items && items.length) {
      for (var i = 0; i < items.length; i++) if (items[i].kind === "file" && /^image\//.test(items[i].type || "")) return true;
      return false;
    }
    return true;
  }
  function showVeil() {
    if (!veil) {
      veil = h("div", { class: "drop-veil", "aria-hidden": "true" },
        h("div", { class: "drop-veil__card" }, ic("image-plus", "icon--lg"), h("b", null, t("scan.drop_title")), h("span", null, t("scan.local_only"))));
    }
    AM.fill(veil.firstChild, ic("image-plus", "icon--lg"), h("b", null, t("scan.drop_title")), h("span", null, t("scan.local_only")));
    if (!veil.isConnected) doc.body.appendChild(veil);
    veil.classList.add("is-on");
    if (S && S.els.dropzone) S.els.dropzone.classList.add("is-over");
    clearTimeout(veilTimer);
    veilTimer = setTimeout(hideVeil, 400);
  }
  function hideVeil() {
    clearTimeout(veilTimer);
    if (veil) veil.classList.remove("is-on");
    if (S && S.els.dropzone) S.els.dropzone.classList.remove("is-over");
  }
  // Image drags never navigate the page away (the browser default); they scan when no other layer is on top.
  doc.addEventListener("dragenter", function (e) { if (dragImage(e)) { e.preventDefault(); if (dropAllowed()) showVeil(); } });
  doc.addEventListener("dragover", function (e) {
    if (!dragImage(e)) return;
    e.preventDefault();
    var ok = dropAllowed();
    try { e.dataTransfer.dropEffect = ok ? "copy" : "none"; } catch (err) { /* ignore */ }
    if (ok) showVeil();
  });
  doc.addEventListener("drop", function (e) {
    hideVeil();
    if (!e.dataTransfer || e.defaultPrevented) return;
    var files = Array.prototype.slice.call(e.dataTransfer.files || []);
    var img = files.filter(function (f) { return /^image\//.test(f.type || "") || /\.(heic|heif)$/i.test(f.name || ""); })[0];
    if (!img) return;
    e.preventDefault();
    if (dropAllowed()) scanFile(img);
  });
  doc.addEventListener("paste", function (e) {
    if (AM.isTyping(e.target)) return; // a text field takes its own paste
    var top = AM.sheets.top();
    if (top && top !== "scanner") return;
    var cd = e.clipboardData;
    if (!cd) return;
    var file = null;
    var items = cd.items || [];
    for (var i = 0; i < items.length && !file; i++) if (items[i].kind === "file" && /^image\//.test(items[i].type || "")) file = items[i].getAsFile();
    if (!file && cd.files && cd.files.length && /^image\//.test(cd.files[0].type || "")) file = cd.files[0];
    if (file) { e.preventDefault(); scanFile(file); return; }
    if (top === "scanner" && S) {
      var text = cd.getData("text/plain");
      if (text && text.trim()) { e.preventDefault(); pasteText(text); }
    }
  });

  AM.provide("openScanner", openScanner);
})(window);
