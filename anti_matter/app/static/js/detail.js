/**
 * Anti-Matter 3.0 — js/detail.js
 * Detail sheet (#sheet-detail), Present mode (#present) and the client-rendered label
 * download. Also defines window.AntiMatterSheetKit: small builders shared with
 * js/editor.js and js/dialogs.js (label specimen, decoded readouts, DCL / Z-Wave DB
 * lookups, orbit art), so the three sheet modules render payloads identically.
 *
 * Provides: openDetail(codeOrId, {list, focus}), openPresent(codeOrId, {list}),
 *           downloadLabel(code).
 * Contract: scratchpad/impl/DOM-CONTRACT.md. Uses window.AM (js/core.js).
 * Rules: user data only as text (AM.h), dir="auto" on user text, dir="ltr" on codes,
 * no pairing codes in AM.log, every string through AM.t.
 */
(function (global) {
  "use strict";

  var AM = global.AM;
  var doc = global.document;
  var h = AM.h, t = AM.t, icon = AM.icon;

  function MP() { return global.AntiMatterMatterPayload; }
  function HK() { return global.AntiMatterHomeKitPayload; }
  function ZW() { return global.AntiMatterZWavePayload; }
  function digits(s) { return String(s == null ? "" : s).replace(/\D/g, ""); }
  function str(s) { return String(s == null ? "" : s).trim(); }
  function hex4(n, lower) {
    var s = (Number(n) >>> 0).toString(16).padStart(4, "0");
    return "0x" + (lower ? s : s.toUpperCase());
  }
  function safeUrl(u) {
    if (!u) return null;
    try {
      var p = new URL(String(u));
      return p.protocol === "http:" || p.protocol === "https:" ? p.href : null;
    } catch (e) { return null; }
  }
  function codeOf(x) {
    if (!x) return null;
    if (typeof x === "string") return AM.store.codeById.get(x) || null;
    return x.id && AM.store.codeById.get(x.id) || x;
  }
  function safeName(name) { return String(name || "code").replace(/[^\w.-]+/g, "_") || "code"; }

  // =========================================================================
  // Shared kit (also used by editor.js and dialogs.js)
  // =========================================================================

  /** Static orbit art (never animated; lives in its own box behind the opaque label). */
  function orbits(w, hh, core) {
    var cx = w * 0.62, cy = hh * 0.55, c = core == null ? 5 : core;
    return h("svg", { viewBox: "0 0 " + w + " " + hh, preserveAspectRatio: "xMidYMid slice", "aria-hidden": "true", focusable: "false", style: "inline-size:100%;block-size:100%" },
      h("g", { fill: "none", stroke: "var(--orb-line)", "stroke-width": "1" },
        h("ellipse", { cx: cx, cy: cy, rx: w * 0.46, ry: hh * 0.28, transform: "rotate(-16 " + cx + " " + cy + ")" }),
        h("ellipse", { cx: cx, cy: cy, rx: w * 0.34, ry: hh * 0.62, transform: "rotate(24 " + cx + " " + cy + ")" }),
        h("ellipse", { cx: cx, cy: cy, rx: w * 0.2, ry: hh * 0.2, "stroke-dasharray": "2 5" })
      ),
      c ? h("circle", { cx: cx, cy: cy, r: c, fill: "var(--orb-1)" }) : null,
      h("circle", { cx: w * 0.2, cy: hh * 0.4, r: 3, fill: "var(--orb-2)" }),
      h("circle", { cx: w * 0.93, cy: hh * 0.22, r: 2.5, fill: "var(--orb-3)" }),
      h("circle", { cx: w * 0.8, cy: hh * 0.92, r: 2, fill: "var(--orb-2)", opacity: ".8" })
    );
  }

  /** Per-protocol empty text for a code with no payload at all. */
  // i18n-dynamic: card.no_payload_
  function emptyText(code) {
    var p = AM.proto.of(code);
    if (AM.proto.hasPayload(code)) return t("card.no_qr");
    var key = "card.no_payload_" + (p === "matter" || p === "homekit" || p === "zwave" ? p : "other");
    return t(key);
  }

  /** DSK groups → <p class="label__dsk"> with the PIN (first group) underlined, 4 + 4 groups. */
  function dskEl(groups, cls) {
    return h("p", { class: cls || "label__dsk", dir: "ltr" },
      h("span", null, h("u", null, groups[0]), "-" + groups.slice(1, 4).join("-")),
      h("br"),
      h("span", null, groups.slice(4).join("-"))
    );
  }

  /**
   * Label specimen (white paper, black ink, never themed): header (wordmark | HomeKit glyph
   * code | standard text) + module-snapped QR + code line in the protocol's convention.
   * o: {target (QR px), width (label px), qr: Promise<svg|null> (default: AM.qr.forCode),
   *     label (QR aria-label)}
   */
  function labelEl(code, o) {
    o = o || {};
    var p = AM.proto.of(code);
    var target = o.target || 188;
    var front = h("div", { class: "label__face label__front" });
    front.appendChild(h("div", { class: "label__head" }, AM.proto.wordmark(code)));
    var slot = AM.qr.placeholder(emptyText(code), target);
    front.appendChild(slot);
    var f = AM.proto.formatCode(code);
    if (p === "zwave") {
      var g = AM.proto.dsk(code);
      if (g) front.appendChild(dskEl(g));
      else if (f.text) front.appendChild(h("p", { class: "label__code", dir: "ltr" }, f.text));
    } else if (p !== "homekit" || !AM.proto.homekitDigits(code)) {
      if (f.text) front.appendChild(h("p", { class: "label__code", dir: "ltr" }, f.text));
    }
    var el = h("div", { class: ["label", "p-" + p], "data-flipped": "false", style: o.width ? { "--label-w": o.width + "px" } : null },
      h("div", { class: "label__card" }, front));
    var qrp = o.qr !== undefined ? o.qr : (AM.proto.hasQr(code) ? AM.qr.forCode(code, { label: o.label || qrLabel(code) }) : null);
    el._qrReady = Promise.resolve(qrp).then(function (svg) {
      if (!svg || !slot.isConnected && !el.contains(slot)) return null;
      var total = parseInt(svg.getAttribute("data-modules"), 10) || 0;
      svg.style.setProperty("--qr-size", AM.qr.snap(target, total) + "px");
      slot.replaceWith(svg);
      return svg;
    }).catch(function () { return null; });
    return el;
  }
  function qrLabel(code) {
    return t("card.qr_label", { protocol: AM.proto.name(code), name: str(code && code.name) || t("scan.unnamed") });
  }

  // ---- Lookups (cached, silent on failure) ----
  var lookup = AM.lookup; // shared, cached enrichment lookups (core.js)
  function isTestVid(vid) { return vid >= 0xFFF1 && vid <= 0xFFF4; }
  /** Matter DCL enrichment: Promise<{vendor, model}> (either may be null). */
  function dcl(vid, pid) {
    if (vid == null || isTestVid(vid) || !vid) return Promise.resolve({ vendor: null, model: null });
    return Promise.all([
      lookup("/matter/vendor/" + vid),
      pid != null && pid ? lookup("/matter/model/" + vid + "/" + pid) : Promise.resolve(null),
    ]).then(function (r) { return { vendor: r[0], model: r[1] }; });
  }
  function zwaveDb(meta) {
    if (!meta || meta.manufacturerId == null || meta.productType == null || meta.productId == null) return Promise.resolve(null);
    return lookup("/zwave/device/" + meta.manufacturerId + "/" + meta.productType + "/" + meta.productId);
  }
  function zwaveDbUrl(meta) {
    var base = "https://devices.zwave-js.io/";
    if (!meta || meta.manufacturerId == null || meta.productType == null || meta.productId == null) return base;
    return base + "?jumpTo=" + hex4(meta.manufacturerId, true) + ":" + hex4(meta.productType, true) + ":" + hex4(meta.productId, true) + ":0.0";
  }

  // ---- Decoding ----
  /** Matter: {parsed, from: "qr"|"manual", error} — the QR wins over the manual code. */
  function decodeMatter(qr, manual) {
    qr = str(qr);
    manual = str(manual);
    var M = MP();
    if (!M) return { parsed: null };
    if (/^MT:/i.test(qr)) {
      try { return { parsed: M.parseQrPayload(qr), from: "qr" }; } catch (e) { /* fall back to the manual code */ }
    }
    var d = digits(manual);
    if (d.length === 11 || d.length === 21) {
      try { return { parsed: M.parseManualPayload(d), from: "manual" }; } catch (e) { return { parsed: null, error: e && e.message === "check digit" ? "check_digit" : "invalid" }; }
    }
    return { parsed: null };
  }
  /** Z-Wave: SmartStart QR (full) or DSK only. */
  function decodeZwave(qr, manual) {
    var Z = ZW();
    if (!Z) return null;
    var ex = str(qr) ? Z.extractQrString(qr) : "";
    if (ex) {
      var p = Z.parseQrDigits(ex);
      if (p) return p;
    }
    var d = digits(manual);
    if (d.length === 40) {
      var f = Z.formatDsk(d);
      if (Z.isValidDskFormatted(f)) return { dsk: f, pin: Z.pinFromDsk(d), meta: {}, version: null, smartStart: false };
    }
    return null;
  }
  /** HomeKit: {pairing (8 digits), setupId, category, flag} from the URI and/or the pairing code. */
  function decodeHomekit(uri, manual, setupId, category) {
    var H = HK();
    if (!H) return null;
    var out = { pairing: H.pairingDigits(manual), setupId: str(setupId).toUpperCase(), category: category || "", fromUri: false };
    var parsed = H.parseSetupUri(uri);
    if (parsed) {
      var f = H.decodeFieldsFromUri(parsed.uri);
      var pin = H.decodePairingFromUri(parsed.uri);
      out.fromUri = true;
      if (!out.pairing && /^\d{8}$/.test(pin)) out.pairing = pin;
      if (f.setup_id) out.setupId = f.setup_id;
      if (f.homekit_category) out.category = f.homekit_category;
      out.flag = f.homekit_flag;
    }
    if (!out.pairing && !out.fromUri) return null;
    return out;
  }
  /** Decoded form of a stored code: {kind: "matter"|"zwave"|"homekit", …} or null. */
  function decodeCode(code) {
    var p = AM.proto.of(code);
    if (p === "matter") {
      var m = decodeMatter(code.qr_payload, code.manual_code);
      return m.parsed ? { kind: "matter", parsed: m.parsed, from: m.from } : null;
    }
    if (p === "zwave") {
      var z = decodeZwave(code.qr_payload, code.manual_code);
      return z ? { kind: "zwave", parsed: z } : null;
    }
    if (p === "homekit") {
      var hk = decodeHomekit(code.qr_payload, code.manual_code, code.setup_id, code.homekit_category);
      return hk ? { kind: "homekit", parsed: hk } : null;
    }
    return null;
  }

  // ---- Readouts ----
  function readout(key, value, o) {
    o = o || {};
    return h("div", { class: ["readout", o.wide && "readout--wide", o.cls] },
      h("span", { class: "key" }, key),
      value == null ? null : h("span", { class: ["readout__value", o.text && "readout__value--text"], dir: o.text ? "auto" : "ltr" },
        value, o.alt != null && o.alt !== "" ? h("span", { class: "alt" }, String(o.alt)) : null),
      o.body || null,
      h("span", { class: "readout__src", hidden: !o.src }, o.src || null)
    );
  }
  function setSrc(ro, nodes) {
    var s = ro.querySelector(".readout__src");
    if (!s) return;
    AM.fill(s, nodes);
    s.hidden = !s.firstChild;
  }
  function pill(on, iconName, text, o) {
    o = o || {};
    return h("span", { class: ["tag", on ? (o.onCls || "tag--ok") : "tag--outline", !on && "is-off"] },
      iconName ? icon(iconName) : null, h("span", null, text));
  }
  // i18n-dynamic: decode.flow_ homekit.category_
  function flowText(flow) {
    var key = "decode.flow_" + (flow >= 0 && flow <= 3 ? flow : 3);
    return flow == null ? "" : t(key);
  }
  function passcodeValid(pin) {
    var s = String(pin).padStart(8, "0");
    var bad = ["00000000", "11111111", "22222222", "33333333", "44444444", "55555555", "66666666", "77777777", "88888888", "99999999", "12345678", "87654321"];
    return pin > 0 && pin <= 99999998 && bad.indexOf(s) < 0;
  }
  function hkCategoryText(cat) {
    var key = "homekit.category_" + (cat || "other");
    var I = global.AntiMatterI18n;
    return I && I.has(key) ? t(key) : String(cat || "other");
  }

  /**
   * Readout tiles for a decoded payload. o: {compact, onNames(vendor, product), links: el
   * (filled with DCL / device-DB link buttons), protoCls}
   */
  function readoutsEl(dec, o) {
    o = o || {};
    var wrap = h("div", { class: ["readouts", "p-" + (dec.kind === "zwave" ? "zwave" : dec.kind === "homekit" ? "homekit" : "matter")] });
    if (dec.kind === "matter") matterReadouts(wrap, dec.parsed, o);
    else if (dec.kind === "zwave") zwaveReadouts(wrap, dec.parsed, o);
    else if (dec.kind === "homekit") homekitReadouts(wrap, dec.parsed, o);
    return wrap;
  }

  function matterReadouts(wrap, p, o) {
    var hasIds = p.vid != null;
    var rVid = readout(t("code.decode_vid"), hasIds ? hex4(p.vid) : "—", { alt: hasIds ? String(p.vid) : null });
    var rPid = readout(t("code.decode_pid"), hasIds && p.pid != null ? hex4(p.pid) : "—", { alt: hasIds && p.pid != null ? String(p.pid) : null });
    var pin = p.pincode != null ? String(p.pincode).padStart(8, "0") : "—";
    var ok = p.pincode != null && passcodeValid(p.pincode);
    var rPin = readout(t("decode.passcode"), pin, {
      src: p.pincode == null ? null : ok ? [icon("circle-check"), t("decode.valid_digits", { count: 8 })] : [icon("circle-alert"), t("decode.invalid_passcode")],
    });
    var disc = p.long_discriminator != null ? p.long_discriminator : p.short_discriminator;
    var rDisc = readout(t("code.decode_discriminator"), disc != null ? String(disc) : "—", {
      alt: p.long_discriminator != null ? hex4(p.long_discriminator).replace(/^0x0+(?=.)/, "0x") : null,
      src: p.long_discriminator != null ? t("decode.short", { value: String(p.long_discriminator >> 8) }) : t("decode.short_only"),
    });
    wrap.append(rVid, rPid, rPin, rDisc);
    var bits = p.discovery;
    var pills = h("div", { class: "pills" });
    if (bits != null) {
      var on = [];
      if (bits & 1) on.push(t("decode.softap"));
      if (bits & 2) on.push(t("decode.ble"));
      if (bits & 4) on.push(t("decode.on_ip"));
      pills.append(
        h("span", { class: "sr-only" }, t("decode.discovery_sr", { list: on.length ? AM.fmt.list(on, "unit") : t("code.decode_none") })),
        h("span", { class: "pills__set", "aria-hidden": "true" },
          pill(!!(bits & 1), "wifi", t("decode.softap")),
          pill(!!(bits & 2), "bluetooth", t("decode.ble")),
          pill(!!(bits & 4), "network", t("decode.on_ip")))
      );
    } else {
      pills.appendChild(h("span", { class: "subtle pills__note" }, t("decode.discovery_unknown")));
    }
    pills.append(h("span", { class: "spacer" }), h("span", { class: "tag" }, h("span", null, flowText(p.flow))));
    wrap.appendChild(readout(o.compact ? t("decode.discovery_flow_short") : t("decode.discovery_flow"), null, { wide: true, body: pills }));

    if (o.links) {
      AM.fill(o.links, linkBtn("https://webui.dcl.csa-iot.org/", t("decode.csa_dcl"), null));
    }
    if (!hasIds) return;
    dcl(p.vid, p.pid).then(function (r) {
      var vName = r.vendor && r.vendor.name ? String(r.vendor.name) : "";
      var mName = r.model && r.model.name ? String(r.model.name) : "";
      if (vName) setSrc(rVid, [icon("badge-check"), h("span", { dir: "auto" }, t("decode.dcl_source", { name: vName }))]);
      if (mName) setSrc(rPid, [h("span", { dir: "auto" }, mName)]);
      if (o.links) {
        var links = [
          linkBtn(r.vendor && r.vendor.landing_page, t("decode.vendor_site"), "globe"),
          linkBtn(r.model && r.model.product_page, t("decode.product_page"), null),
          linkBtn(r.model && r.model.support_page, t("decode.support"), null),
          linkBtn("https://webui.dcl.csa-iot.org/", t("decode.csa_dcl"), null),
        ].filter(Boolean);
        AM.fill(o.links, links);
      }
      if ((vName || mName) && typeof o.onNames === "function") o.onNames(vName || null, mName || null);
    });
  }

  function zwaveReadouts(wrap, p, o) {
    var meta = p.meta || {};
    var sec = p.requestedSecurityClasses;
    var protos = meta.supportedProtocols;
    var groups = digits(p.dsk).length === 40 ? p.dsk.split("-") : null;
    if (p.version != null) {
      wrap.appendChild(readout(t("code.decode_zwave_version"), t(p.smartStart ? "code.decode_zwave_smartstart" : "code.decode_zwave_s2"), { text: true, alt: "v" + p.version }));
    }
    if (!o.compact && groups) {
      wrap.appendChild(readout(t("code.decode_zwave_pin"), groups[0]));
    }
    if (sec) {
      wrap.appendChild(readout(t("code.decode_zwave_security_classes"), null, {
        wide: true, body: h("div", { class: "pills" },
          pill(sec.s2AccessControl, sec.s2AccessControl ? "check" : null, t("code.decode_zwave_s2_access_control")),
          pill(sec.s2Authenticated, sec.s2Authenticated ? "check" : null, t("code.decode_zwave_s2_authenticated")),
          pill(sec.s2Unauthenticated, sec.s2Unauthenticated ? "check" : null, t("code.decode_zwave_s2_unauthenticated")),
          pill(sec.s0Legacy, sec.s0Legacy ? "check" : null, t("code.decode_zwave_s0"))),
      }));
    }
    if (protos && !o.compact) {
      wrap.appendChild(readout(t("code.decode_zwave_protocols"), null, {
        wide: true, body: h("div", { class: "pills" },
          pill(protos.zwave, "radio", t("code.decode_zwave_protocol_zwave")),
          pill(protos.zwaveLongRange, "radio", t("code.decode_zwave_protocol_lr"))),
      }));
    }
    if (groups && !o.compact) {
      wrap.appendChild(readout(t("code.decode_zwave_dsk"), null, { wide: true, body: dskEl(groups, "readout__value readout__dsk") }));
    }
    var rMfg = null, rPid = null;
    if (meta.manufacturerId != null) {
      rMfg = readout(t("code.decode_zwave_mfg"), hex4(meta.manufacturerId, true), { alt: String(meta.manufacturerId) });
      wrap.appendChild(rMfg);
    }
    if (meta.productType != null) wrap.appendChild(readout(t("code.decode_zwave_product_type"), hex4(meta.productType, true), { alt: String(meta.productType) }));
    if (meta.productId != null) {
      rPid = readout(t("code.decode_zwave_product_id"), hex4(meta.productId, true), { alt: String(meta.productId) });
      wrap.appendChild(rPid);
    }
    if (!o.compact) {
      if (meta.genericDeviceClass != null) wrap.appendChild(readout(t("code.decode_zwave_generic_class"), hex4(meta.genericDeviceClass, true).replace(/^0x00/, "0x"), { alt: String(meta.genericDeviceClass) }));
      if (meta.specificDeviceClass != null) wrap.appendChild(readout(t("code.decode_zwave_specific_class"), hex4(meta.specificDeviceClass, true).replace(/^0x00/, "0x"), { alt: String(meta.specificDeviceClass) }));
      if (meta.installerIconType != null) wrap.appendChild(readout(t("code.decode_zwave_icon"), hex4(meta.installerIconType, true), { alt: String(meta.installerIconType) }));
      if (meta.applicationVersion) wrap.appendChild(readout(t("decode.app_version"), String(meta.applicationVersion)));
    }
    if (o.links) AM.fill(o.links, linkBtn(zwaveDbUrl(meta), t("decode.zwave_db"), null));
    zwaveDb(meta).then(function (d) {
      if (!d) return;
      var mfg = d.manufacturer ? String(d.manufacturer) : "";
      var label = d.label ? String(d.label) : "";
      var desc = d.description ? String(d.description) : "";
      if (rMfg && mfg) setSrc(rMfg, [icon("badge-check"), h("span", { dir: "auto" }, t("decode.zwave_db_source", { name: mfg }))]);
      if (rPid && (label || desc)) setSrc(rPid, [h("span", { dir: "auto" }, label && desc ? t("decode.label_desc", { label: label, description: desc }) : label || desc)]);
      if ((mfg || label) && typeof o.onNames === "function") o.onNames(mfg || null, label || null);
    });
  }

  function homekitReadouts(wrap, p) {
    var pc = p.pairing ? p.pairing.slice(0, 3) + "-" + p.pairing.slice(3, 5) + "-" + p.pairing.slice(5) : "—";
    wrap.append(
      readout(t("decode.hk_pairing"), pc),
      readout(t("decode.hk_setup_id"), p.setupId || "—"),
      readout(t("code.homekit_category"), hkCategoryText(p.category), { text: true, wide: true })
    );
  }

  function linkBtn(url, text, iconName) {
    var href = safeUrl(url);
    if (!href) return null;
    return h("a", { class: "btn btn--sm", href: href, target: "_blank", rel: "noopener noreferrer" },
      iconName ? icon(iconName) : null, h("span", null, text), icon("external-link"));
  }

  // Shared with editor.js / dialogs.js
  global.AntiMatterSheetKit = {
    orbits: orbits, labelEl: labelEl, dskEl: dskEl, emptyText: emptyText, qrLabel: qrLabel,
    decodeMatter: decodeMatter, decodeZwave: decodeZwave, decodeHomekit: decodeHomekit, decodeCode: decodeCode,
    readoutsEl: readoutsEl, readout: readout, hex4: hex4, safeUrl: safeUrl, hkCategoryText: hkCategoryText,
    dcl: dcl, zwaveDb: zwaveDb, digits: digits, safeName: safeName,
  };

  // =========================================================================
  // Detail sheet
  // =========================================================================
  var D = { id: null, list: [], unsubs: [] };
  var SHEET = "sheet-detail";

  function detailOpen() { return AM.sheets.isOpen(SHEET); }
  function curCode() { return D.id ? AM.store.codeById.get(D.id) || null : null; }

  function defaultList(id) {
    var ids = AM.filters.apply().map(function (c) { return c.id; });
    return ids.indexOf(id) >= 0 ? ids : [id];
  }

  function openDetail(codeOrId, opts) {
    opts = opts || {};
    var code = codeOf(codeOrId);
    if (!code || !code.id) return false;
    D.id = code.id;
    D.list = Array.isArray(opts.list) && opts.list.indexOf(code.id) >= 0 ? opts.list.slice() : (detailOpen() && D.list.indexOf(code.id) >= 0 ? D.list : defaultList(code.id));
    wireDetailOnce();
    var reopen = false;
    if (detailOpen() && AM.sheets.top() !== SHEET) {
      // Open beneath another layer (e.g. the editor's "Open existing"): bring it to the top.
      AM.sheets.close(SHEET, null, "api");
      D.id = code.id;
      reopen = true;
    }
    renderDetail();
    var wasOpen = detailOpen();
    AM.sheets.open(SHEET, {
      history: reopen ? false : undefined,
      initialFocus: AM.mq.coarse.matches ? null : "#detail-edit",
      onClose: function () { D.id = null; },
    });
    if (wasOpen) AM.byId("detail-body").scrollTop = 0;
    if (opts.focus === "decode") focusDecode();
    return true;
  }

  function focusDecode() {
    setTimeout(function () {
      var sec = AM.byId("detail-decoded");
      if (!sec) return;
      sec.scrollIntoView({ block: "start", behavior: AM.mq.reducedMotion.matches ? "auto" : "smooth" });
      sec.focus({ preventScroll: true });
    }, 60);
  }

  function statusEl(code) {
    return code.in_use
      ? h("span", { class: "status status--inuse" }, t("card.in_use"))
      : h("span", { class: "status status--spare" }, t("card.spare"));
  }

  function renderDetail() {
    var code = curCode();
    if (!code) return;
    var p = AM.proto.of(code);
    var sheet = AM.byId(SHEET);
    sheet.classList.remove.apply(sheet.classList, AM.proto.LIST.map(function (x) { return "p-" + x; }));
    sheet.classList.add("p-" + p);
    AM.fill(AM.byId("detail-meta"), h("span", { class: ["proto", "p-" + p] }, AM.proto.name(code)), statusEl(code));
    AM.byId("detail-title").textContent = str(code.name) || t("scan.unnamed");
    var sub = [str(code.device_vendor), str(code.device_product)].filter(Boolean).join(" · ");
    var subEl = AM.byId("detail-sub");
    subEl.textContent = sub;
    subEl.hidden = !sub;
    var idx = D.list.indexOf(code.id);
    var pos = AM.byId("detail-pos");
    var many = D.list.length > 1 && idx >= 0;
    pos.textContent = many ? t("detail.position", { index: idx + 1, total: D.list.length }) : "";
    AM.byId("detail-prev").disabled = !many || idx <= 0;
    AM.byId("detail-next").disabled = !many || idx >= D.list.length - 1;
    ["detail-prev", "detail-pos", "detail-next"].forEach(function (id) { AM.byId(id).hidden = !many; });
    var sep = AM.byId(SHEET).querySelector(".detail__nav .sep");
    if (sep) sep.hidden = !many;

    var body = AM.byId("detail-body");
    var keep = body.scrollTop;
    AM.fill(body, h("div", { class: "detail__grid" }, leftCol(code), rightCol(code)));
    body.scrollTop = keep;
  }

  function leftCol(code) {
    var K = global.AntiMatterSheetKit;
    var p = AM.proto.of(code);
    var lbl = K.labelEl(code, { target: 212 });
    var stage = h("div", { class: ["stage", "p-" + p] }, h("div", { class: "stage__art", "aria-hidden": "true" }, orbits(320, 360, 0)), lbl);
    stage.addEventListener("dblclick", function (e) {
      if (e.target.closest && e.target.closest("svg.qr") && decodeCode(code)) focusDecode();
    });
    var f = AM.proto.formatCode(code);
    var inv = !!AM.prefs.get("invert");
    var tiles = h("div", { class: "action-tiles" },
      h("button", { type: "button", class: "action-tile", disabled: !f.copy, "data-tip": t("action.copy_code"), "data-kbd": "C", onclick: function () { copyCode(code); } },
        icon("copy"), h("span", null, t("detail.copy_tile"))),
      h("button", { type: "button", class: "action-tile action-tile--primary", "data-tip": t("action.present"), "data-kbd": "P", onclick: function () { openPresent(code.id, { list: D.list }); } },
        icon("maximize-2"), h("span", null, t("action.present"))),
      h("button", { type: "button", class: "action-tile", disabled: !AM.proto.hasPayload(code), "data-tip": t("action.download_label"), "data-kbd": "⇧D", onclick: function () { downloadLabel(code); } },
        icon("download"), h("span", null, t("action.download"))),
      h("button", { type: "button", class: "action-tile", id: "detail-invert", "aria-pressed": String(inv), "data-tip": t("action.invert"), "data-kbd": "I", onclick: function () { AM.setInvert(!AM.prefs.get("invert")); } },
        icon("contrast"), h("span", null, t("action.qr_invert_label")))
    );
    return h("div", { class: "detail__col" }, stage, tiles, setupBlock(code));
  }

  function copyBtn(text, tip, sm) {
    return h("button", { type: "button", class: ["icon-btn", sm ? "icon-btn--xs" : "icon-btn--sm"], tip: tip, onclick: function () { AM.copy(text); } }, icon("copy"));
  }

  function setupBlock(code) {
    var p = AM.proto.of(code);
    var f = AM.proto.formatCode(code);
    var qr = str(code.qr_payload);
    var keyText = p === "matter" ? t("detail.manual_code") : p === "homekit" ? t("detail.hk_code") : p === "zwave" ? t("code.decode_zwave_dsk") : t("detail.setup_code");
    var box = h("div", { class: "setup-code" });
    var g = p === "zwave" ? AM.proto.dsk(code) : null;
    box.appendChild(h("div", { class: "setup-code__row" },
      h("span", { class: "key", style: "flex:1" }, keyText),
      f.full ? copyBtn(g ? f.full : f.copy, t("action.copy_code")) : null));
    if (g) box.appendChild(dskEl(g, "setup-code__value setup-code__value--dsk"));
    else if (f.text) box.appendChild(h("span", { class: "setup-code__value", dir: "ltr" }, f.text));
    else box.appendChild(h("span", { class: "setup-code__none subtle" }, emptyText(code)));
    if (qr) {
      box.appendChild(h("div", { class: "setup-code__raw" },
        h("span", { class: "key" }, t("detail.qr_key")),
        h("span", { class: "mono", dir: "ltr", title: qr }, qr),
        copyBtn(qr, t("action.copy_payload"), true)));
    }
    return box;
  }

  function copyCode(code) {
    var f = AM.proto.formatCode(code);
    if (!f.copy) return;
    AM.copy(f.copy);
  }

  function rightCol(code) {
    var K = global.AntiMatterSheetKit;
    var col = h("div", { class: "detail__col" });
    var ha = haRow(code);
    if (ha) col.appendChild(ha);
    col.appendChild(deviceSection(code));
    var dec = K.decodeCode(code);
    if (dec) {
      var links = h("div", { class: "dcl-links" });
      col.appendChild(h("section", { class: "stack detail__decoded", id: "detail-decoded", tabindex: "-1", style: "--gap:10px", "aria-labelledby": "detail-dec-h" },
        h("h3", { class: "section-title", id: "detail-dec-h" }, icon("binary"), h("span", null, t("detail.decoded")), h("span", { class: "spacer" }),
          h("span", { class: "tag tag--ok" }, icon("shield-check"), h("span", null, t("detail.decoded_offline")))),
        K.readoutsEl(dec, { links: dec.kind === "homekit" ? null : links }),
        dec.kind === "homekit" ? null : links));
    }
    return col;
  }

  function haRow(code) {
    var linkedId = code.ha_link && code.ha_link.device_id;
    if (linkedId) {
      var dev = AM.ha.device(linkedId);
      var more = h("button", { type: "button", class: "icon-btn icon-btn--sm", tip: t("detail.ha_more"), "aria-haspopup": "menu" }, icon("ellipsis"));
      more.addEventListener("click", function () {
        AM.menu.show(more, [
          { icon: "external-link", label: t("action.open_in_ha"), run: function () { AM.ha.openDevice(linkedId); } },
          { icon: "unlink", label: t("detail.unlink"), danger: true, run: function () { setLink(code, null); } },
        ], { label: t("detail.ha_more") });
      });
      return h("div", { class: "ha-row ha-row--linked" },
        h("span", { class: "ha-row__icon" }, icon("house-plug")),
        h("span", { class: "ha-row__text" }, h("span", null, t("detail.linked_device")),
          h("b", { dir: "auto" }, dev ? (dev.area ? t("detail.device_area", { name: dev.name, area: dev.area }) : dev.name) : t("detail.linked_unknown"))),
        h("button", { type: "button", class: "btn btn--sm", onclick: function () { AM.ha.openDevice(linkedId); } }, icon("house"), h("span", null, t("action.open_in_ha"))),
        more);
    }
    var sug = AM.ha.suggest(code);
    if (!sug) return null;
    return h("div", { class: "ha-row" },
      h("span", { class: "ha-row__icon" }, icon("house-plug")),
      h("span", { class: "ha-row__text" }, h("span", null, t("detail.suggested_device")),
        h("b", { dir: "auto" }, sug.area ? t("detail.device_area", { name: sug.name, area: sug.area }) : sug.name)),
      h("button", { type: "button", class: "btn btn--sm", onclick: function () { setLink(code, sug.id); } }, icon("link-2"), h("span", null, t("action.link_device"))));
  }

  async function setLink(code, deviceId) {
    try {
      await AM.api("/codes/" + encodeURIComponent(code.id), { method: "PUT", body: { ha_link: { device_id: deviceId || null } } });
      AM.haptic("success");
      var dev = deviceId ? AM.ha.device(deviceId) : null;
      AM.toast({ message: deviceId ? t("toast.linked", { name: dev ? dev.name : "" }) : t("toast.unlinked"), icon: deviceId ? "link-2" : "unlink" });
      await AM.refresh({ force: true });
    } catch (e) {
      AM.reportError(e);
    }
  }

  function humanType(v) {
    v = str(v);
    return /^[a-z0-9_]+$/.test(v) ? (v.charAt(0).toUpperCase() + v.slice(1)).replace(/_/g, " ") : v;
  }

  function deviceSection(code) {
    var dash = function () { return h("span", { class: "subtle" }, "—"); };
    var conns = AM.filters.CONN.filter(function (c) { return code[c.key]; });
    var cats = AM.cat.of(code);
    var facts = h("dl", { class: "facts" },
      fact(t("filter.type"), str(code.device_type) ? h("span", { dir: "auto" }, humanType(code.device_type)) : dash()),
      fact(t("code.area"), str(code.area) ? [icon("map-pin"), h("span", { dir: "auto" }, str(code.area))] : dash()),
      fact(t("code.connectivity"), conns.length ? conns.map(function (c) { return h("span", { class: "fact-conn" }, icon(c.icon), t(c.label)); }) : dash()),
      fact(t("categories.title"), cats.length ? cats.map(function (c) {
        return h("span", { class: "tag" }, AM.cat.markEl(c, { size: "sm" }), h("span", { dir: "auto" }, c.name));
      }) : h("span", { class: "tag tag--outline" }, t("categories.none"))),
      fact(t("detail.added"), code.created_at ? h("span", { class: "num" }, AM.fmt.date(code.created_at)) : dash()),
      fact(t("detail.updated"), code.updated_at ? h("span", { class: "num" }, AM.fmt.date(code.updated_at)) : dash())
    );
    if (str(code.description)) facts.appendChild(fact(t("code.description"), h("span", { dir: "auto" }, str(code.description)), true));
    var sec = h("section", { class: "stack", style: "--gap:10px", "aria-labelledby": "detail-dev-h" },
      h("h3", { class: "section-title", id: "detail-dev-h" }, icon("layers"), h("span", null, t("detail.device"))),
      facts);
    if (str(code.notes)) {
      sec.appendChild(h("div", { class: "notes", dir: "auto", "aria-label": t("code.notes") }, String(code.notes)));
    }
    return sec;
  }
  function fact(label, value, wide) {
    return h("div", { class: wide ? "span-all" : null }, h("dt", null, label), h("dd", null, value));
  }

  function step(d) {
    var i = D.list.indexOf(D.id);
    var next = D.list[i + d];
    if (i < 0 || !next || !AM.store.codeById.has(next)) return;
    D.id = next;
    renderDetail();
    AM.byId("detail-body").scrollTop = 0;
  }

  var detailWired = false;
  function wireDetailOnce() {
    if (detailWired) return;
    detailWired = true;
    AM.byId("detail-prev").addEventListener("click", function () { step(-1); });
    AM.byId("detail-next").addEventListener("click", function () { step(1); });
    AM.byId("detail-edit").addEventListener("click", function () { var c = curCode(); if (c) AM.act("openEditor", c); });
    AM.byId("detail-trash").addEventListener("click", trashCurrent);
  }

  async function trashCurrent() {
    var c = curCode();
    if (!c) return;
    var ok = await AM.act("deleteCodes", [c.id]);
    if (ok && detailOpen() && !AM.store.codeById.has(c.id)) AM.sheets.close(SHEET, null, "api");
  }

  var S = { scope: SHEET };
  AM.shortcuts.register("arrowup", function () { step(-1); }, S);
  AM.shortcuts.register("k", function () { step(-1); }, S);
  AM.shortcuts.register("arrowdown", function () { step(1); }, S);
  AM.shortcuts.register("j", function () { step(1); }, S);
  AM.shortcuts.register("e", function () { var c = curCode(); if (c) AM.act("openEditor", c); }, S);
  AM.shortcuts.register("c", function () { var c = curCode(); if (c) copyCode(c); }, S);
  AM.shortcuts.register("p", function () { var c = curCode(); if (c) openPresent(c.id, { list: D.list }); }, S);
  AM.shortcuts.register("d", function () { if (AM.byId("detail-decoded")) focusDecode(); else return false; }, S);
  AM.shortcuts.register("shift+d", function () { var c = curCode(); if (c) downloadLabel(c); }, S);
  AM.shortcuts.register("delete", function () { trashCurrent(); }, S);
  AM.shortcuts.register("i", function () { AM.setInvert(!AM.prefs.get("invert")); }, S);

  // =========================================================================
  // Present mode
  // =========================================================================
  var P = { id: null, list: [], lock: null, onResize: null, onVis: null, swipe: null };
  var PRESENT = "present";

  function openPresent(codeOrId, opts) {
    opts = opts || {};
    var code = codeOf(codeOrId);
    if (!code || !code.id) return false;
    P.id = code.id;
    P.list = Array.isArray(opts.list) && opts.list.indexOf(code.id) >= 0 ? opts.list.slice() : defaultList(code.id);
    wirePresentOnce();
    var already = AM.sheets.isOpen(PRESENT);
    presentMeta();
    AM.sheets.open(PRESENT, {
      initialFocus: null, // the layer itself: no focus ring or tooltip over the label
      onClose: function () { releaseWake(); detachPresent(); P.id = null; },
    });
    renderPresent();
    if (!already) {
      attachPresent();
      requestWake();
    }
    return true;
  }

  function presentWidth() {
    var stage = AM.byId("present-stage");
    var w = stage.clientWidth || global.innerWidth;
    var hh = stage.clientHeight || global.innerHeight * 0.7;
    // Label height ≈ 1.3 × its width (head + QR + code line); keep 8 px breathing room.
    return Math.max(200, Math.floor(Math.min(w * 0.92, (hh - 16) / 1.3, 760)));
  }

  function presentMeta() {
    var code = P.id && AM.store.codeById.get(P.id);
    if (!code) return null;
    var p = AM.proto.of(code);
    var protoEl = AM.byId("present-proto");
    protoEl.className = "proto p-" + p;
    protoEl.textContent = AM.proto.name(code);
    AM.byId("present-name").textContent = str(code.name) || t("scan.unnamed");
    var i = P.list.indexOf(code.id);
    var many = P.list.length > 1;
    AM.byId("present-pos").textContent = many ? t("detail.position", { index: i + 1, total: P.list.length }) : "";
    AM.byId("present-prev").disabled = !many || i <= 0;
    AM.byId("present-next").disabled = !many || i >= P.list.length - 1;
    AM.byId("present-prev").hidden = AM.byId("present-next").hidden = !many;
    AM.byId("present-invert").setAttribute("aria-pressed", String(!!AM.prefs.get("invert")));
    AM.byId(PRESENT).setAttribute("aria-label", t("present.aria", { name: str(code.name) || t("scan.unnamed") }));
    return code;
  }

  function renderPresent() {
    var code = presentMeta();
    if (!code) return;
    var stage = AM.byId("present-stage");
    AM.fill(stage);
    // measure after the layer is laid out
    var lw = presentWidth();
    var lbl = global.AntiMatterSheetKit.labelEl(code, { width: lw, target: lw - 48 });
    AM.fill(stage, lbl);
  }

  function presentStep(d) {
    var i = P.list.indexOf(P.id);
    var next = P.list[i + d];
    if (i < 0 || !next || !AM.store.codeById.has(next)) return;
    P.id = next;
    renderPresent();
  }

  async function requestWake() {
    var tag = AM.byId("present-awake");
    tag.hidden = true;
    if (!("wakeLock" in navigator) || doc.hidden) return;
    try {
      P.lock = await navigator.wakeLock.request("screen");
      if (!AM.sheets.isOpen(PRESENT)) { releaseWake(); return; }
      tag.hidden = false;
      P.lock.addEventListener("release", function () { if (tag) tag.hidden = true; });
    } catch (e) {
      P.lock = null;
    }
  }
  function releaseWake() {
    var l = P.lock;
    P.lock = null;
    AM.byId("present-awake").hidden = true;
    if (l) { try { l.release(); } catch (e) { /* ignore */ } }
  }

  function attachPresent() {
    P.onResize = AM.debounce(function () { if (AM.sheets.isOpen(PRESENT)) renderPresent(); }, 120);
    P.onVis = function () { if (!doc.hidden && AM.sheets.isOpen(PRESENT) && !P.lock) requestWake(); };
    global.addEventListener("resize", P.onResize);
    doc.addEventListener("visibilitychange", P.onVis);
  }
  function detachPresent() {
    if (P.onResize) global.removeEventListener("resize", P.onResize);
    if (P.onVis) doc.removeEventListener("visibilitychange", P.onVis);
    P.onResize = P.onVis = null;
  }

  var presentWired = false;
  function wirePresentOnce() {
    if (presentWired) return;
    presentWired = true;
    AM.byId("present-prev").addEventListener("click", function () { presentStep(-1); });
    AM.byId("present-next").addEventListener("click", function () { presentStep(1); });
    AM.byId("present-invert").addEventListener("click", function () { AM.setInvert(!AM.prefs.get("invert")); });
    // Swipe (touch/pen) on the stage: horizontal flick = prev/next (mirrored in RTL)
    var stage = AM.byId("present-stage");
    var sw = null;
    stage.addEventListener("pointerdown", function (e) {
      if (e.pointerType === "mouse") return;
      sw = { x: e.clientX, y: e.clientY, id: e.pointerId, t: Date.now() };
    });
    stage.addEventListener("pointerup", function (e) {
      if (!sw || e.pointerId !== sw.id) return;
      var dx = e.clientX - sw.x, dy = e.clientY - sw.y;
      sw = null;
      if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy) * 1.3) return;
      var forward = dx < 0; // swipe left = next (LTR)
      if (AM.dir() === "rtl") forward = !forward;
      presentStep(forward ? 1 : -1);
    });
    stage.addEventListener("pointercancel", function () { sw = null; });
  }

  var PS = { scope: PRESENT };
  AM.shortcuts.register("arrowleft", function () { presentStep(AM.dir() === "rtl" ? 1 : -1); }, PS);
  AM.shortcuts.register("arrowright", function () { presentStep(AM.dir() === "rtl" ? -1 : 1); }, PS);
  AM.shortcuts.register("i", function () { AM.setInvert(!AM.prefs.get("invert")); }, PS);

  // =========================================================================
  // Download label: client-side PNG of the SPEC label (canvas), browser download,
  // plus a copy in HA Media (POST the same PNG to save-to-media).
  // =========================================================================
  var glyphPaths = null;
  function hkGlyphs() {
    if (glyphPaths) return glyphPaths;
    glyphPaths = fetch(AM.ICONS_URL, { credentials: "same-origin" }).then(function (r) { return r.text(); }).then(function (txt) {
      var sprite = new DOMParser().parseFromString(txt, "image/svg+xml");
      var out = {};
      ["hk-house", "hk-0", "hk-1", "hk-2", "hk-3", "hk-4", "hk-5", "hk-6", "hk-7", "hk-8", "hk-9"].forEach(function (id) {
        var sym = sprite.getElementById(id);
        if (!sym) return;
        var vb = (sym.getAttribute("viewBox") || "0 0 1 1").split(/[\s,]+/).map(Number);
        out[id] = { vb: vb, d: Array.prototype.map.call(sym.querySelectorAll("path"), function (p) { return p.getAttribute("d"); }) };
      });
      return out;
    }).catch(function () { glyphPaths = null; return {}; });
    return glyphPaths;
  }
  function loadImg(src) {
    return new Promise(function (resolve) {
      var img = new Image();
      img.decoding = "async";
      img.onload = function () { resolve(img); };
      img.onerror = function () { resolve(null); };
      img.src = src;
    });
  }
  function rtlText(s) { return /^[^A-Za-zÀ-ɏ]*[֐-ࣿיִ-﷿ﹰ-﻿]/.test(s); }
  function fitText(ctx, text, maxW) {
    if (ctx.measureText(text).width <= maxW) return text;
    var s = text;
    while (s.length > 1 && ctx.measureText(s + "…").width > maxW) s = s.slice(0, -1);
    return s + "…";
  }
  function roundRect(ctx, x, y, w, hh, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + hh, r);
    ctx.arcTo(x + w, y + hh, x, y + hh, r);
    ctx.arcTo(x, y + hh, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /** Render the label for `code` to a PNG Blob (label ×3 of the 220 px CSS label). */
  async function renderLabelPng(code) {
    var S3 = 3, W = 220 * S3, PAD_X = 16 * S3, PAD_T = 18 * S3, PAD_B = 16 * S3, GAP = 8 * S3;
    var INK = "#0B0B10", INK2 = "#4A4A55";
    var p = AM.proto.of(code);
    var f = AM.proto.formatCode(code);
    var groups = p === "zwave" ? AM.proto.dsk(code) : null;
    var hkDigits = p === "homekit" ? AM.proto.homekitDigits(code) : "";
    var fontsReady = doc.fonts && doc.fonts.load ? Promise.all([
      doc.fonts.load("700 60px 'JetBrains Mono'"), doc.fonts.load("800 60px Manrope"), doc.fonts.load("600 40px Manrope"),
    ]).catch(function () {}) : Promise.resolve();
    var qrText = AM.proto.hasQr(code)
      ? AM.api("/codes/" + encodeURIComponent(code.id) + "/qr.svg?border=4", { as: "text" }).catch(function (e) { if (e && e.code === "no_qr_payload") return null; throw e; })
      : Promise.resolve(null);
    var LOGO = { matter: "matter_logo.svg", zwave: "zwave_logo.png", zigbee: "zigbee_logo.png", tuya: "tuya_logo.svg" };
    var logoP = LOGO[p] ? loadImg(AM.ASSETS + LOGO[p] + AM.V) : Promise.resolve(null);
    var r = await Promise.all([qrText, logoP, hkDigits ? hkGlyphs() : Promise.resolve(null), fontsReady]);
    var svgText = r[0], logo = r[1], glyphs = r[2];
    if (!svgText && !f.text && !groups && !hkDigits) {
      var err = new Error("nothing"); err.code = "nothing_to_render"; err.userMessage = t("error.nothing_to_render"); throw err;
    }
    // QR geometry
    var qr = null;
    if (svgText) {
      var sv = new DOMParser().parseFromString(svgText, "image/svg+xml").documentElement;
      var vb = (sv.getAttribute("viewBox") || "0 0 0 0").split(/[\s,]+/).map(Number);
      var total = vb[2] || 0;
      var ppm = Math.max(1, Math.floor((188 * S3) / total));
      qr = { vb: vb, total: total, size: ppm * total, ppm: ppm, d: Array.prototype.map.call(sv.querySelectorAll("path"), function (el) { return el.getAttribute("d"); }) };
    }
    // Header metrics
    var HEAD_H = 40 * S3;
    var WM_H = { matter: 28, zwave: 38, zigbee: 28, tuya: 32 };
    var codeFont = "700 " + Math.round(Math.min(21, 220 * 0.088) * S3) + "px 'JetBrains Mono', ui-monospace, Menlo, monospace";
    var dskFont = "600 " + Math.round(11.5 * S3) + "px 'JetBrains Mono', ui-monospace, Menlo, monospace";
    var nameFont = "700 " + Math.round(13 * S3) + "px Manrope, system-ui, 'Noto Sans', 'Noto Sans Arabic', 'Noto Sans Hebrew', 'PingFang SC', 'Hiragino Sans', 'Microsoft YaHei', 'Malgun Gothic', sans-serif";
    var name = str(code.name);
    var codeLine = !groups && !(p === "homekit" && hkDigits) && f.text ? f.text : "";
    var codeLH = Math.round(21 * S3 * 1.15), dskLH = Math.round(11.5 * S3 * 1.55), nameLH = Math.round(13 * S3 * 1.4);
    var qrBox = qr ? qr.size : 0;
    var hgt = PAD_T + HEAD_H + 2 * S3 + GAP + (qr ? qrBox : 0) + (codeLine ? GAP + codeLH : 0) + (groups ? GAP + dskLH * 2 : 0) + (name ? GAP * 2 + nameLH : 0) + PAD_B;
    var canvas = doc.createElement("canvas");
    canvas.width = W;
    canvas.height = Math.round(hgt);
    var ctx = canvas.getContext("2d");
    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    roundRect(ctx, 3, 3, W - 6, canvas.height - 6, 18 * S3);
    ctx.lineWidth = 3;
    ctx.strokeStyle = "#D6D6DE";
    ctx.stroke();
    var y = PAD_T;
    // Header
    ctx.fillStyle = INK;
    if (p === "homekit" && hkDigits && glyphs && glyphs["hk-house"]) {
      var fs = 19 * S3;
      var houseH = fs * 1.9, houseW = houseH * 130 / 120, digH = fs * 0.88, digW = fs * 0.62, gapD = fs * 0.08, rowGap = fs * 0.12, sp = fs * 0.32;
      var blockW = houseW + sp + digW * 4 + gapD * 3;
      var x0 = (W - blockW) / 2, cy = y + HEAD_H / 2;
      var draw = function (id, x, yy, w, hh2) {
        var gl = glyphs[id];
        if (!gl) return;
        ctx.save();
        ctx.translate(x, yy);
        ctx.scale(w / gl.vb[2], hh2 / gl.vb[3]);
        gl.d.forEach(function (d) { ctx.fill(new Path2D(d)); });
        ctx.restore();
      };
      draw("hk-house", x0, cy - houseH / 2, houseW, houseH);
      var dx = x0 + houseW + sp, top = cy - (digH * 2 + rowGap) / 2;
      for (var i = 0; i < 8; i++) {
        draw("hk-" + hkDigits.charAt(i), dx + (i % 4) * (digW + gapD), top + (i < 4 ? 0 : digH + rowGap), digW, digH);
      }
    } else if (logo) {
      var lh = (WM_H[p] || 28) * S3;
      var lw = logo.naturalWidth && logo.naturalHeight ? lh * logo.naturalWidth / logo.naturalHeight : lh * 4;
      if (lw > W - PAD_X * 2) { lh = lh * (W - PAD_X * 2) / lw; lw = W - PAD_X * 2; }
      ctx.drawImage(logo, (W - lw) / 2, y + (HEAD_H - lh) / 2, lw, lh);
    } else {
      var std = AM.proto.name(code).toLocaleUpperCase();
      ctx.font = "800 " + 22 * S3 + "px Manrope, system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      try { ctx.letterSpacing = "6px"; } catch (e) { /* older canvas */ }
      ctx.fillText(fitText(ctx, std, W - PAD_X * 2), W / 2, y + HEAD_H / 2);
      try { ctx.letterSpacing = "0px"; } catch (e) { /* ignore */ }
    }
    y += HEAD_H + 2 * S3 + GAP;
    // QR: exact integer px per module (quiet zone is part of the viewBox)
    if (qr) {
      var qx = Math.round((W - qrBox) / 2);
      ctx.fillStyle = "#FFFFFF";
      ctx.fillRect(qx, y, qrBox, qrBox);
      ctx.save();
      ctx.translate(qx - qr.vb[0] * qr.ppm, y - qr.vb[1] * qr.ppm);
      ctx.scale(qr.ppm, qr.ppm);
      ctx.fillStyle = "#000000";
      qr.d.forEach(function (d) { ctx.fill(new Path2D(d)); });
      ctx.restore();
      y += qrBox;
    }
    ctx.fillStyle = INK;
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.direction = "ltr";
    if (codeLine) {
      y += GAP;
      ctx.font = codeFont;
      ctx.fillText(fitText(ctx, codeLine, W - PAD_X * 2), W / 2, y + codeLH * 0.8);
      y += codeLH;
    }
    if (groups) {
      y += GAP;
      ctx.font = dskFont;
      var l1 = groups[0] + "-" + groups.slice(1, 4).join("-"), l2 = groups.slice(4).join("-");
      var w1 = ctx.measureText(l1).width, pinW = ctx.measureText(groups[0]).width;
      ctx.fillText(l1, W / 2, y + dskLH * 0.75);
      ctx.fillRect(W / 2 - w1 / 2, y + dskLH * 0.75 + 2 * S3, pinW, 2 * S3);
      ctx.fillText(l2, W / 2, y + dskLH * 1.75);
      y += dskLH * 2;
    }
    if (name) {
      y += GAP;
      ctx.fillStyle = "#E3E3EA";
      ctx.fillRect(PAD_X, y, W - PAD_X * 2, 2);
      y += GAP;
      ctx.fillStyle = INK2;
      ctx.font = nameFont;
      ctx.direction = rtlText(name) ? "rtl" : "ltr";
      ctx.fillText(fitText(ctx, name, W - PAD_X * 2), W / 2, y + nameLH * 0.75);
    }
    return new Promise(function (resolve, reject) {
      try {
        canvas.toBlob(function (b) { if (b) resolve(b); else reject(new Error("toBlob")); }, "image/png");
      } catch (e) { reject(e); }
    });
  }

  var downloading = new Set();
  async function downloadLabel(codeOrId) {
    var code = codeOf(codeOrId);
    if (!code || !code.id || downloading.has(code.id)) return false;
    downloading.add(code.id);
    try {
      var blob;
      try {
        blob = await renderLabelPng(code);
      } catch (e) {
        if (e && e.code === "nothing_to_render") { AM.reportError(e); return false; }
        if (e && typeof e.code === "string") { AM.reportError(e, { fallbackKey: "alert.download_fail" }); return false; }
        blob = null; // canvas failed (e.g. tainted in an old WebView): fall back to the server image
      }
      var filename = "antimatter-" + safeName(code.name);
      if (blob) {
        AM.download(blob, filename + ".png");
      } else {
        var p = AM.proto.of(code);
        var svgCard = p === "homekit" || p === "zwave";
        var srv = await AM.api("/codes/" + encodeURIComponent(code.id) + (svgCard ? "/card.svg" : "/label.png"), { as: "blob" });
        AM.download(srv, filename + (svgCard ? ".svg" : ".png"));
      }
      AM.log("Label downloaded: protocol=" + AM.proto.of(code) + " source=" + (blob ? "client" : "server"));
      try {
        await AM.api("/codes/" + encodeURIComponent(code.id) + "/save-to-media", blob ? { method: "POST", body: blob, contentType: "image/png" } : { method: "POST" });
        AM.toast({ message: t("toast.label_saved"), icon: "download" });
      } catch (e) {
        if (e && e.code === "media_unavailable") AM.toast({ message: t("toast.label_no_media"), tone: "warn", icon: "download" });
        else AM.toast({ message: t("toast.label_media_failed", { reason: (e && e.userMessage) || "" }), tone: "warn", icon: "download" });
      }
      return true;
    } catch (e) {
      AM.reportError(e, { fallbackKey: "alert.download_fail" });
      return false;
    } finally {
      downloading.delete(code.id);
    }
  }

  // =========================================================================
  // Events & actions
  // =========================================================================
  AM.on("vault", function () {
    if (detailOpen()) {
      if (!curCode()) AM.sheets.close(SHEET, null, "api");
      else {
        D.list = D.list.filter(function (id) { return AM.store.codeById.has(id); });
        renderDetail();
      }
    }
    if (AM.sheets.isOpen(PRESENT)) {
      P.list = P.list.filter(function (id) { return AM.store.codeById.has(id); });
      if (!P.id || !AM.store.codeById.has(P.id)) AM.sheets.close(PRESENT, null, "api");
      else renderPresent();
    }
  });
  AM.on("locale", function () {
    if (detailOpen()) renderDetail();
    if (AM.sheets.isOpen(PRESENT)) renderPresent();
  });
  AM.on("ha", function () { if (detailOpen()) renderDetail(); });
  AM.on("prefs", function (e) {
    if (e.name !== "invert") return;
    var on = String(!!e.value);
    var a = AM.byId("detail-invert");
    if (a) a.setAttribute("aria-pressed", on);
    AM.byId("present-invert").setAttribute("aria-pressed", on);
  });

  AM.provide("openDetail", openDetail);
  AM.provide("openPresent", openPresent);
  AM.provide("downloadLabel", downloadLabel);
})(window);
