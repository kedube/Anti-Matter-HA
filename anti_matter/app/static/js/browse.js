/**
 * Anti-Matter 3.0 — js/browse.js: the vault screen (everything on the main page).
 * ============================================================================
 * Sidebar categories + tablet/phone category chips, insight strip (desktop) and thin
 * insight (phone), view bar (title, status, Select, Cards/Labels/Table, grid zoom),
 * search, filter chips + popovers (desktop) and the Filters sheet (phone), the three
 * views (cards, printable labels wall, sortable table), empty states, selection
 * (Explorer semantics + touch select mode) and the selection bar, card/row/category
 * menus, keyboard shortcuts on the focused card/row/label. Provides AM action "render".
 *
 * Rules kept: user data only reaches the DOM as text (AM.h / textContent); dir="auto" on
 * user text, dir="ltr" on codes; keyed DOM diffing by data-id (the 6 s poll never rebuilds
 * unchanged cards, focus and scroll survive); a card's QR is re-fetched only when its
 * updated_at changes; codes and payloads are never logged. Contract: DOM-CONTRACT.md.
 */
(function (global) {
  "use strict";

  var AM = global.AM;
  var I18N = global.AntiMatterI18n;
  var doc = global.document;
  var h = AM.h, t = AM.t, icon = AM.icon, $ = AM.byId;
  var IS_MAC = /Mac|iPhone|iPad/.test(global.navigator.platform || global.navigator.userAgent || "");
  var MOD = IS_MAC ? "⌘" : "Ctrl";
  var ZOOM_MIN = 50, ZOOM_MAX = 150, ZOOM_STEP = 10;
  var PROTOS = AM.proto.LIST;
  var NONE = AM.cat.NONE;
  var CONN_ORDER = ["conn_matter", "conn_wifi", "conn_zigbee", "conn_bluetooth", "conn_zwave"];
  var CONN_ICON = { conn_wifi: "wifi", conn_matter: "waypoints", conn_zigbee: "hexagon", conn_bluetooth: "bluetooth", conn_zwave: "radio" };
  var FIELDS = AM.filters.FIELDS; // vendor/product/type/area -> code property
  var FILTER_DEFS = [
    { key: "protocol", label: "code.protocol", icon: "orbit" },
    { key: "vendor", label: "filter.vendor" },
    { key: "product", label: "filter.product" },
    { key: "type", label: "filter.type" },
    { key: "area", label: "filter.area" },
    { key: "inUse", label: "code.in_use" },
    { key: "conn", label: "code.connectivity" },
  ];
  var FDEF = {};
  FILTER_DEFS.forEach(function (d) { FDEF[d.key] = d; });
  var mqTiny = global.matchMedia("(max-width: 380px)");
  // Keys reached through AM.tNodes or computed names (check-keys.py cannot see them):
  // i18n-dynamic: card.no_payload_ code.conn_ code.decode_flow_ status.selected status.shown_of_total status.count_codes status.labels
  // i18n-dynamic: insight.pairing_codes insight.spares_ready empty.nomatch_body filter.chip filter.show_n

  var st = {
    anchor: null,            // selection anchor (code id): moves only on a toggle
    flipped: new Set(),      // label ids showing their decoded back
    lastCodesView: "cards",  // dock "Codes" returns here from Labels
    scheduled: false,
    dirtyAll: false,
    lastPointer: "mouse",
    suppressClickUntil: 0,
    selCount: -1,
    statusSig: "",
    wired: false,
  };
  var cache = { cards: new Map(), rows: new Map(), labels: new Map() };
  var ctx = null; // {view, all, shown, disp} for the current render

  // =========================================================================
  // Small helpers
  // =========================================================================
  function str(v) { return v == null ? "" : String(v); }
  function trim(v) { return str(v).trim(); }
  function fkey(v) { return trim(v).toLocaleLowerCase(); }
  function num(n) { return AM.fmt.number(n); }
  function codeOf(id) { return AM.store.codeById.get(id) || null; }
  function view() { var v = AM.prefs.get("view"); return v === "labels" || v === "table" ? v : "cards"; }
  function zoomPct() {
    var z = parseInt(AM.prefs.get("zoom"), 10) || 100;
    return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round(z / ZOOM_STEP) * ZOOM_STEP));
  }
  function tileZ() { return AM.mq.phone.matches ? 1 : Math.max(1, zoomPct() / 100); }
  function cardQrTarget() { return mqTiny.matches ? 116 : Math.round(132 * tileZ()); }
  function labelBase() { return AM.mq.phone.matches ? 160 : 212; }
  function labelW() { return Math.round(labelBase() * zoomPct() / 100); }
  function typeText(v) { return trim(v).replace(/_/g, " "); }
  /** User text as an isolated inline run (dir=auto) inside a box that keeps the UI direction. */
  function bdi(s) { return h("bdi", { dir: "auto" }, s); }
  function dash() { return h("span", { class: "subtle", "aria-hidden": "true" }, "—"); }
  function hasI18n(key) { return !!(I18N && I18N.has && I18N.has(key)); }
  function selectingTap() { return AM.selection.mode || (AM.selection.size > 0 && !AM.mq.hover.matches); }
  function findFk(root, fk) {
    var list = root.querySelectorAll("[data-fk]");
    for (var i = 0; i < list.length; i++) if (list[i].getAttribute("data-fk") === fk) return list[i];
    return null;
  }
  /** Replace a region's children; keep keyboard focus on the equivalent control (data-fk). */
  function refill(el, kids) {
    var ae = doc.activeElement, fk = null;
    if (ae && ae !== doc.body && el.contains(ae)) fk = ae.getAttribute("data-fk");
    AM.fill(el, kids);
    if (fk != null) { var tgt = findFk(el, fk); if (tgt) tgt.focus({ preventScroll: true }); }
  }
  function connList(c) {
    return CONN_ORDER.filter(function (k) { return !!c[k]; }).map(function (k) {
      var key = "code." + k;
      return { key: k, label: t(key), icon: CONN_ICON[k] };
    });
  }
  function hex(n, w) { return "0x" + Number(n).toString(16).toUpperCase().padStart(w || 4, "0"); }
  /** Split a count template into [number node, caption span] keeping the translated order. */
  function countParts(key, count, numClass, capTag, capClass) {
    var frag = AM.tNodes(key, { count: count }, { count: h("span", { class: numClass }, num(count)) });
    var out = [];
    Array.prototype.slice.call(frag.childNodes).forEach(function (n) {
      if (n.nodeType === 3) {
        var s = n.textContent.trim();
        if (s) out.push(h(capTag || "span", { class: capClass || null }, s));
      } else out.push(n);
    });
    return out;
  }

  // =========================================================================
  // Sorting (table) and the displayed order
  // =========================================================================
  var SORT_KEYS = ["name", "protocol", "device_vendor", "device_product", "device_type", "area", "categories", "in_use", "connectivity", "created_at"];
  var SORTERS = {
    name: function (c) { return str(c.name); },
    protocol: function (c) { return AM.proto.name(c); },
    device_vendor: function (c) { return trim(c.device_vendor); },
    device_product: function (c) { return trim(c.device_product); },
    device_type: function (c) { return typeText(c.device_type); },
    area: function (c) { return trim(c.area); },
    categories: function (c) { return AM.cat.of(c).map(function (x) { return x.name; }).join(", "); },
    in_use: function (c) { return c.in_use ? 1 : 0; },
    connectivity: function (c) { return connList(c).map(function (x) { return x.label; }).join(", "); },
    created_at: function (c) { return str(c.created_at); },
  };
  function sortPref() {
    var s = AM.prefs.get("tableSort");
    if (!s || SORT_KEYS.indexOf(s.key) < 0) return { key: "name", dir: "asc" };
    return { key: s.key, dir: s.dir === "desc" ? "desc" : "asc" };
  }
  function sortCodes(list) {
    var s = sortPref();
    var get = SORTERS[s.key] || SORTERS.name;
    var dir = s.dir === "desc" ? -1 : 1;
    var idx = new Map(list.map(function (c, i) { return [c.id, i]; }));
    return list.slice().sort(function (a, b) {
      var va = get(a), vb = get(b);
      if (typeof va === "number") {
        if (va !== vb) return (va - vb) * dir;
      } else {
        var ea = !va, eb = !vb;
        if (ea !== eb) return ea ? 1 : -1; // empty values always last
        var r = s.key === "created_at" ? (va < vb ? -1 : va > vb ? 1 : 0) : AM.compare(va, vb);
        if (r) return r * dir;
      }
      return AM.compare(str(a.name), str(b.name)) || idx.get(a.id) - idx.get(b.id);
    });
  }
  function computeCtx() {
    var all = AM.store.vault.codes;
    var shown = AM.filters.apply(all);
    var v = view();
    return { view: v, all: all, shown: shown, disp: v === "table" ? sortCodes(shown) : shown };
  }
  /** Ids in the order the user sees them now (sorted in the table): the basis for ranges and prev/next. */
  function displayedIds() { return computeCtx().disp.map(function (c) { return c.id; }); }

  // =========================================================================
  // Render scheduling
  // =========================================================================
  function schedule(all) {
    if (all) st.dirtyAll = true;
    if (st.scheduled) return;
    st.scheduled = true;
    Promise.resolve().then(flush);
  }
  function flush() {
    st.scheduled = false;
    var all = st.dirtyAll;
    st.dirtyAll = false;
    try {
      if (all) renderAll(); else syncSelection();
    } catch (e) { console.error("[browse] render failed", e); }
  }

  function renderAll() {
    if (!AM.store.loaded) return;
    wire();
    ctx = computeCtx();
    var empty = !ctx.all.length;
    var none = !empty && !ctx.shown.length;
    var counts = AM.cat.counts(ctx.all);
    renderNav(counts);
    renderCatRow(counts);
    renderInsight(empty || ctx.view !== "cards"); // the insight strip belongs to the Cards view (labels/table prototypes omit it)
    renderViewbar();
    renderFilterBar(empty);
    syncSearch();
    var v = ctx.view;
    var cards = $("view-cards"), labels = $("view-labels"), table = $("view-table");
    cards.hidden = !(v === "cards" && !empty && !none);
    labels.hidden = !(v === "labels" && !empty && !none);
    table.hidden = !(v === "table" && !empty && !none);
    applyZoom();
    if (!cards.hidden) renderCards();
    if (!labels.hidden) renderLabels();
    if (!table.hidden) renderTable();
    renderLabelsTools(v === "labels" && !empty);
    renderEmpty(empty, none);
    renderDock();
    pruneCaches();
    pruneSelection();
    syncSelection();
    refreshFilterPop();
    renderFilterSheet(false);
  }

  function pruneCaches() {
    [cache.cards, cache.rows, cache.labels].forEach(function (m) {
      m.forEach(function (rec, id) {
        if (!AM.store.codeById.has(id)) { discard(rec); m.delete(id); }
      });
    });
    st.flipped.forEach(function (id) { if (!AM.store.codeById.has(id)) st.flipped.delete(id); });
  }

  // =========================================================================
  // Lazy QR loading (cards + table rows); labels load eagerly (they are the print path)
  // =========================================================================
  var io = "IntersectionObserver" in global ? new global.IntersectionObserver(function (entries) {
    entries.forEach(function (en) {
      if (!en.isIntersecting) return;
      io.unobserve(en.target);
      var fn = en.target._amLoad;
      en.target._amLoad = null;
      if (fn) fn();
    });
  }, { rootMargin: "600px 0px" }) : null;
  function lazy(el, fn) {
    if (!io) { fn(); return; }
    el._amLoad = fn;
    io.observe(el);
  }
  function discard(rec) {
    if (rec && rec.slot && io) { io.unobserve(rec.slot); rec.slot._amLoad = null; }
  }
  function qrKey(c) { return [c.id, c.updated_at || "", c.code_type || "", c.qr_payload || "", c.manual_code || ""].join("|"); }
  function placeholderText(c) {
    if (AM.proto.hasPayload(c)) return t("card.no_qr");
    var p = AM.proto.of(c);
    var key = "card.no_payload_" + (p === "matter" || p === "homekit" || p === "zwave" ? p : "other");
    return t(key);
  }
  function qrLabel(c) { return t("card.qr_label", { protocol: AM.proto.name(c), name: str(c.name) }); }
  /**
   * Fill a QR slot: move the previous card's svg when the code did not change (no refetch,
   * no flash), else fetch (cached per id + updated_at). o: {target, old (old rec), lazy}
   */
  function fillQr(slot, c, o) {
    var target = o.target;
    if (!AM.proto.hasQr(c)) { AM.fill(slot, AM.qr.placeholder(placeholderText(c), target)); return; }
    var old = o.old;
    var oldSvg = old && old.slot && old.qrKey === qrKey(c) ? old.slot.querySelector("svg.qr") : null;
    if (oldSvg) {
      oldSvg.setAttribute("aria-label", qrLabel(c));
      AM.qr.mount(slot, oldSvg, { targetPx: target });
      return;
    }
    function load() {
      AM.qr.forCode(c, { label: qrLabel(c) }).then(function (svg) {
        if (svg) AM.qr.mount(slot, svg, { targetPx: target });
        else AM.fill(slot, AM.qr.placeholder(t("card.no_qr"), target));
      }, function () { AM.fill(slot, AM.qr.placeholder(t("card.no_qr"), target)); });
    }
    if (o.lazy) lazy(slot, load); else load();
  }

  // =========================================================================
  // Keyed reconcile (cards, rows, labels)
  // =========================================================================
  function reconcile(container, items, cacheMap, sigOf, build, focusFallback) {
    var ae = doc.activeElement;
    var inside = !!(ae && ae !== doc.body && container.contains(ae));
    var focusId = null, focusRole = null;
    if (inside) {
      var host = ae.closest("[data-id]");
      focusId = host ? host.getAttribute("data-id") : null;
      focusRole = ae.getAttribute("data-role");
    }
    var els = [];
    for (var i = 0; i < items.length; i++) {
      var c = items[i];
      var sig = sigOf(c);
      var rec = cacheMap.get(c.id);
      if (!rec || rec.sig !== sig) {
        var nrec = build(c, rec);
        nrec.sig = sig;
        if (rec) {
          if (rec.el.parentNode === container) container.replaceChild(nrec.el, rec.el);
          discard(rec);
        }
        cacheMap.set(c.id, nrec);
        rec = nrec;
      }
      els.push(rec.el);
    }
    for (var j = 0; j < els.length; j++) {
      var cur = container.children[j];
      if (cur !== els[j]) container.insertBefore(els[j], cur || null);
    }
    while (container.children.length > els.length) container.removeChild(container.lastElementChild);
    if (inside && doc.activeElement !== ae) {
      if (ae.isConnected) ae.focus({ preventScroll: true });
      else if (focusId) {
        var r = cacheMap.get(focusId);
        if (r && r.el.isConnected) {
          var tgt = focusRole ? r.el.querySelector('[data-role="' + focusRole + '"]') : null;
          (tgt || focusFallback(r.el)).focus({ preventScroll: true });
        }
      }
    }
  }
  function catSig(c) { return AM.cat.of(c).map(function (x) { return [x.id, x.name, x.color, x.icon]; }); }

  // =========================================================================
  // Shared bits (status, facts, category tags)
  // =========================================================================
  function statusEl(c) {
    return c.in_use ? h("span", { class: "status status--inuse" }, t("card.in_use"))
      : h("span", { class: "status status--spare" }, t("card.spare"));
  }
  function catTag(x) { return h("span", { class: "tag" }, AM.cat.markEl(x), h("span", null, bdi(x.name))); }
  function moreTag(rest) {
    return h("span", { class: "tag", title: rest.join(", ") }, h("bdi", null, t("status.more", { count: rest.length })));
  }
  function catTags(c) {
    var cs = AM.cat.of(c);
    if (!cs.length) return h("span", { class: "tag tag--outline" }, h("span", null, t("nav.uncategorized")));
    return [catTag(cs[0]), cs.length > 1 ? moreTag(cs.slice(1).map(function (x) { return x.name; })) : null];
  }
  function connFact(c) {
    var l = connList(c);
    if (!l.length) return null;
    return h("span", { title: l.map(function (x) { return x.label; }).join(", ") },
      icon(l[0].icon), h("span", { class: "truncate" }, l[0].label),
      l.length > 1 ? h("bdi", { class: "subtle" }, t("status.more", { count: l.length - 1 })) : null);
  }

  // =========================================================================
  // Cards view
  // =========================================================================
  function cardSig(c) {
    return JSON.stringify([c, catSig(c), AM.locale(), cardQrTarget()]);
  }
  function buildCard(c, old) {
    var p = AM.proto.of(c);
    var name = str(c.name);
    var f = AM.proto.formatCode(c);
    var sub = [c.device_vendor, c.device_product].map(trim).filter(Boolean);
    var slot = h("div", { class: "qr-tile__qr" });
    var cb = h("input", { type: "checkbox", class: "check", "data-role": "select", "aria-label": t("action.select_name", { name: name }) });
    var el = h("article", { class: ["code-card", "p-" + p], role: "listitem", "data-id": c.id },
      h("div", { class: "code-card__tile" },
        h("div", { class: ["qr-tile", "p-" + p] }, h("div", { class: "qr-tile__head" }, AM.proto.wordmark(c)), slot)),
      h("div", { class: "code-card__body" },
        h("div", { class: "code-card__top" },
          h("span", { class: "proto" }, bdi(AM.proto.name(c))),
          h("button", { type: "button", class: "icon-btn icon-btn--sm", "data-role": "edit", "aria-label": t("action.edit_name", { name: name }), tip: t("action.edit"), kbd: "E" }, icon("pencil")),
          h("button", { type: "button", class: "icon-btn icon-btn--sm", "data-role": "more", "aria-haspopup": "menu", "aria-expanded": "false", "aria-label": t("action.more_actions", { name: name }), tip: t("action.more") }, icon("ellipsis"))),
        h("h3", { class: "code-card__name" },
          h("button", { type: "button", class: "code-card__open", "data-role": "open", title: name.length > 34 ? name : null }, bdi(name))),
        sub.length ? h("p", { class: "code-card__sub truncate" }, sub.map(function (s, i) { return [i ? " · " : null, bdi(s)]; })) : null,
        h("div", { class: "code-card__facts" },
          statusEl(c),
          trim(c.area) ? h("span", null, icon("map-pin"), h("span", { class: "truncate" }, bdi(trim(c.area)))) : null,
          connFact(c)),
        h("div", { class: "code-card__cats" }, catTags(c)),
        f.text ? h("div", { class: "code-card__foot" },
          h("span", { class: "code-pill" },
            f.pre ? h("span", { class: "code-pill__pre" }, f.pre) : null,
            h("span", { class: "code-text", dir: "ltr" }, f.text),
            h("button", { type: "button", class: "icon-btn icon-btn--xs", "data-role": "copy", "aria-label": t("action.copy_code"), tip: t("action.copy_code"), kbd: "C" }, icon("copy")))) : null),
      h("label", { class: "code-card__select" }, cb));
    var sel = AM.selection.has(c.id);
    if (sel) { el.classList.add("is-selected"); cb.checked = true; }
    fillQr(slot, c, { target: cardQrTarget(), old: old, lazy: true });
    return { el: el, slot: slot, cb: cb, qrKey: qrKey(c) };
  }
  function renderCards() {
    var grid = $("view-cards");
    reconcile(grid, ctx.disp, cache.cards, cardSig, buildCard, function (el) { return el.querySelector('[data-role="open"]') || el; });
  }

  // =========================================================================
  // Labels view (printable label wall with Flip-to-decode backs)
  // =========================================================================
  function matterDecode(c) {
    var MP = global.AntiMatterMatterPayload;
    if (!MP) return null;
    var qr = trim(c.qr_payload);
    try { if (/^MT:/i.test(qr)) return MP.parseQrPayload(qr); } catch (e) { /* fall through */ }
    try { if (trim(c.manual_code)) return MP.parseManualPayload(trim(c.manual_code)); } catch (e) { /* not decodable */ }
    return null;
  }
  function zwaveDecode(c) {
    var ZW = global.AntiMatterZWavePayload;
    if (!ZW) return null;
    try { return ZW.parseQrDigits(ZW.extractQrString(str(c.qr_payload))); } catch (e) { return null; }
  }
  function discoveryText(bits) {
    if (bits == null) return null;
    var f = [];
    if (bits & 1) f.push(t("decode.softap"));
    if (bits & 2) f.push(t("decode.ble"));
    if (bits & 4) f.push(t("decode.on_ip"));
    return f.length ? AM.fmt.list(f) : t("code.decode_none");
  }
  function flowText(flow) {
    if (flow == null) return null;
    var key = "code.decode_flow_" + flow;
    return hasI18n(key) ? t(key) : String(flow);
  }
  function dl(rows) {
    var kids = [];
    rows.forEach(function (r) {
      if (!r || r[1] == null || r[1] === "") return;
      kids.push(h("dt", null, r[0]), h("dd", { class: r[2] ? "is-text" : null, dir: r[2] ? "auto" : "ltr" }, String(r[1])));
    });
    return h("dl", null, kids);
  }
  function dskEl(g) {
    return h("p", { class: "label__dsk", dir: "ltr" },
      h("span", null, h("u", null, g[0]), "-" + g.slice(1, 4).join("-")), h("br"),
      h("span", null, g.slice(4).join("-")));
  }
  function labelBack(c, p) {
    var decodedHead = function (text) { return h("h4", null, icon("binary", "icon--sm"), h("span", null, text)); };
    if (p === "matter") {
      var m = matterDecode(c);
      if (m) {
        return [decodedHead(t("labels.decoded")), dl([
          [t("labels.vid"), m.vid != null ? hex(m.vid) : null],
          [t("labels.pid"), m.pid != null ? hex(m.pid) : null],
          [t("labels.passcode"), m.pincode != null ? String(m.pincode).padStart(8, "0") : null],
          [t("labels.discriminator"), m.long_discriminator != null ? String(m.long_discriminator) : m.short_discriminator != null ? String(m.short_discriminator) : null],
          [t("labels.discovery"), discoveryText(m.discovery), true],
          [t("labels.flow"), flowText(m.flow), true],
        ])];
      }
    }
    if (p === "zwave") {
      var z = zwaveDecode(c);
      var g = AM.proto.dsk(c);
      if (z) {
        var meta = z.meta || {};
        var sec = z.requestedSecurityClasses || {};
        var cls = meta.genericDeviceClass != null ? hex(meta.genericDeviceClass, 2) + (meta.specificDeviceClass != null ? " · " + hex(meta.specificDeviceClass, 2) : "") : null;
        return [decodedHead(z.smartStart ? t("labels.smartstart_s2") : t("code.decode_zwave_s2")),
          dl([
            [t("labels.manufacturer"), meta.manufacturerId != null ? hex(meta.manufacturerId) : null],
            [t("labels.product_type"), meta.productType != null ? hex(meta.productType) : null],
            [t("labels.product_id"), meta.productId != null ? hex(meta.productId) : null],
            [t("labels.device_class"), cls],
          ]),
          h("div", { class: "sec" },
            h("span", { class: sec.s2AccessControl ? "on" : null }, t("labels.s2_access")),
            h("span", { class: sec.s2Authenticated ? "on" : null }, t("labels.s2_auth")),
            h("span", { class: sec.s2Unauthenticated ? "on" : null }, t("labels.s2_unauth")),
            h("span", { class: sec.s0Legacy ? "on" : null }, t("code.decode_zwave_s0"))),
          g ? dskEl(g) : null];
      }
      if (g) return [h("h4", null, t("labels.details")), dskEl(g)];
    }
    var f = AM.proto.formatCode(c);
    var rows = [[t("labels.standard"), AM.proto.name(c), true]];
    if (p === "homekit") {
      rows.push([t("labels.setup_id"), trim(c.setup_id) || null]);
      rows.push([t("labels.category"), trim(c.homekit_category) && c.homekit_category !== "other" ? typeText(c.homekit_category) : null, true]);
    }
    rows.push([t("labels.code"), f.full || null]);
    return [h("h4", null, t("labels.details")), dl(rows)];
  }
  function labelFoot(c, p) {
    if (!AM.prefs.get("labelCodes") || p === "homekit") return null;
    if (p === "zwave") { var g = AM.proto.dsk(c); if (g) return dskEl(g); }
    var f = AM.proto.formatCode(c);
    return f.text ? h("p", { class: "label__code", dir: "ltr" }, f.text) : null;
  }
  function flipBtn(c, on) {
    var name = str(c.name);
    if (on) {
      return h("button", { type: "button", class: "btn btn--sm btn--ghost", "data-role": "flip", "aria-pressed": "true", "aria-label": t("action.flip_back_name", { name: name }), tip: t("action.flip_back"), kbd: "F" },
        icon("flip-vertical-2"), h("span", null, t("action.flip_back")));
    }
    return h("button", { type: "button", class: "icon-btn icon-btn--sm", "data-role": "flip", "aria-pressed": "false", "aria-label": t("action.flip_name", { name: name }), tip: t("action.flip"), kbd: "F" },
      icon("flip-vertical-2"));
  }
  function labelSig(c) {
    return JSON.stringify([c, AM.locale(), labelW(), !!AM.prefs.get("labelCodes"), !!AM.prefs.get("labelNames")]);
  }
  function buildLabel(c, old) {
    var p = AM.proto.of(c);
    var w = labelW();
    var name = str(c.name);
    var on = st.flipped.has(c.id);
    var slot = h("div", { class: "label__qr" });
    var front = h("div", { class: "label__face label__front", "aria-hidden": on ? "true" : null },
      h("div", { class: "label__head" }, AM.proto.wordmark(c)), slot, labelFoot(c, p));
    var back = h("div", { class: "label__face label__back", "aria-hidden": on ? null : "true" }, labelBack(c, p));
    var lab = h("div", { class: ["label", "p-" + p], "data-flipped": String(on), style: { "--label-w": w + "px" } },
      h("div", { class: "label__card" }, front, back),
      h("div", { class: "label-caption" },
        h("span", { class: ["label-caption__name", !AM.prefs.get("labelNames") && "is-off"], title: name }, bdi(name)),
        flipBtn(c, on),
        h("button", { type: "button", class: "icon-btn icon-btn--sm", "data-role": "present", "aria-label": t("action.present_name", { name: name }), tip: t("action.present"), kbd: "P" }, icon("maximize-2"))));
    var wrap = h("div", { class: "label-wrap", role: "listitem", "data-id": c.id }, lab);
    fillQr(slot, c, { target: w - 32, old: old, lazy: false });
    return { el: wrap, slot: slot, qrKey: qrKey(c) };
  }
  function setFlipped(wrap, on) {
    var id = wrap.getAttribute("data-id");
    var c = codeOf(id);
    if (!c) return;
    if (on) st.flipped.add(id); else st.flipped.delete(id);
    var lab = wrap.querySelector(".label");
    lab.setAttribute("data-flipped", String(on));
    var front = lab.querySelector(".label__front"), back = lab.querySelector(".label__back");
    if (on) { front.setAttribute("aria-hidden", "true"); back.removeAttribute("aria-hidden"); }
    else { back.setAttribute("aria-hidden", "true"); front.removeAttribute("aria-hidden"); }
    var old = lab.querySelector('[data-role="flip"]');
    var had = doc.activeElement === old;
    var nb = flipBtn(c, on);
    old.parentNode.replaceChild(nb, old);
    if (had) nb.focus({ preventScroll: true });
  }
  function renderLabels() {
    var wall = $("view-labels");
    wall.style.setProperty("--label-w", labelBase() + "px");
    reconcile(wall, ctx.disp, cache.labels, labelSig, buildLabel, function (el) { return el.querySelector('[data-role="flip"]') || el; });
  }

  var ltools = null;
  function renderLabelsTools(show) {
    var loc = AM.locale();
    if (!ltools || ltools.locale !== loc || !ltools.el.isConnected) {
      var names = h("input", { type: "checkbox", class: "check", "data-role": "lt-names" });
      var codes = h("input", { type: "checkbox", class: "check", "data-role": "lt-codes" });
      var el = h("div", { class: "labels-tools not-phone", id: "labels-tools" },
        h("span", { class: "labels-tools__group", role: "group", "aria-labelledby": "labels-show-on" },
          h("span", { class: "overline subtle", id: "labels-show-on" }, t("labels.show_on")),
          h("label", { class: "check-lbl" }, names, h("span", null, t("labels.names"))),
          h("label", { class: "check-lbl" }, codes, h("span", null, t("labels.setup_codes")))),
        h("span", { class: "spacer" }),
        h("span", { class: "labels-tools__hint not-phone" }, icon("flip-vertical-2", "icon--sm"), h("span", null, t("labels.flip_hint"))),
        h("button", { type: "button", class: "btn btn--sm", "data-role": "lt-print" }, icon("printer"), h("span", null, t("action.print"))),
        h("button", { type: "button", class: "btn btn--sm btn--primary", "data-role": "lt-present" }, icon("presentation"), h("span", null, t("action.present_all"))));
      el.addEventListener("change", function (e) {
        var r = e.target.getAttribute("data-role");
        if (r === "lt-names") AM.prefs.set("labelNames", !!e.target.checked);
        if (r === "lt-codes") AM.prefs.set("labelCodes", !!e.target.checked);
      });
      el.addEventListener("click", function (e) {
        var b = e.target.closest("[data-role]");
        if (!b) return;
        var r = b.getAttribute("data-role");
        if (r === "lt-print") { try { global.print(); } catch (err) { /* ignore */ } }
        if (r === "lt-present") presentAll();
      });
      if (ltools && ltools.el.isConnected) ltools.el.parentNode.replaceChild(el, ltools.el);
      else { var wall = $("view-labels"); wall.parentNode.insertBefore(el, wall); }
      ltools = { el: el, names: names, codes: codes, locale: loc };
    }
    ltools.el.hidden = !show;
    ltools.names.checked = !!AM.prefs.get("labelNames");
    ltools.codes.checked = !!AM.prefs.get("labelCodes");
    var pres = ltools.el.querySelector('[data-role="lt-present"]');
    pres.disabled = !(ctx && ctx.disp.length);
  }
  function presentAll() {
    var ids = displayedIds();
    if (!ids.length) return;
    AM.act("openPresent", ids[0], { list: ids });
  }

  // =========================================================================
  // Table view
  // =========================================================================
  function rowSig(c) { return JSON.stringify([c, catSig(c), AM.locale()]); }
  function tdText(val, w, cls) {
    var v = trim(val);
    return h("td", { class: ["hide-sm", cls] }, v ? h("span", { class: "trunc", style: { "--w": w + "px" }, title: v }, bdi(v)) : dash());
  }
  function buildRow(c) {
    var p = AM.proto.of(c);
    var f = AM.proto.formatCode(c);
    var name = str(c.name);
    var cats = AM.cat.of(c);
    var conns = connList(c);
    var mini = h("span", { class: "mini-qr" });
    var cb = h("input", { type: "checkbox", class: "check", "data-role": "select", "aria-label": t("action.select_name", { name: name }) });
    var tr = h("tr", { tabindex: "0", "aria-selected": "false", "data-id": c.id },
      h("td", { class: "col-check", "data-role": "select-cell" }, cb),
      h("td", { class: "col-qr" }, mini),
      h("td", { class: "col-name" }, h("span", { class: ["name-cell", "p-" + p] },
        h("b", null, bdi(name)),
        h("span", { class: "name-cell__sub" },
          h("span", { class: "proto" }, bdi(AM.proto.name(c))),
          f.text ? h("span", { class: "name-cell__code", dir: "ltr" }, f.pre ? f.pre + " " + f.text : f.text) : null))),
      h("td", { class: "hide-sm" }, h("span", { class: ["proto", "p-" + p] }, bdi(AM.proto.name(c)))),
      tdText(c.device_vendor, 130),
      tdText(c.device_product, 170),
      tdText(typeText(c.device_type), 120, "subtle"),
      tdText(c.area, 120),
      h("td", { class: "hide-sm col-cats" }, cats.length ? h("span", { class: "cell-row" }, catTag(cats[0]),
        cats.length > 1 ? moreTag(cats.slice(1).map(function (x) { return x.name; })) : null) : dash()),
      h("td", { class: "hide-sm" }, statusEl(c)),
      h("td", { class: "hide-sm" }, conns.length ? h("span", { class: "cell-row", title: conns.map(function (x) { return x.label; }).join(", ") },
        icon(conns[0].icon, "icon--sm"), h("span", null, conns[0].label),
        conns.length > 1 ? h("bdi", { class: "subtle" }, t("status.more", { count: conns.length - 1 })) : null) : dash()),
      h("td", { class: "hide-sm cell-date" }, c.created_at ? bdi(AM.fmt.date(c.created_at)) : "—"),
      h("td", { class: "col-actions" }, h("span", { class: "row-actions" },
        h("button", { type: "button", class: "icon-btn icon-btn--sm hide-sm", "data-role": "edit", "aria-label": t("action.edit_name", { name: name }), tip: t("action.edit"), kbd: "E" }, icon("pencil")),
        h("button", { type: "button", class: "icon-btn icon-btn--sm", "data-role": "more", "aria-haspopup": "menu", "aria-expanded": "false", "aria-label": t("action.more_actions", { name: name }), tip: t("action.more") }, icon("ellipsis")))));
    if (AM.selection.has(c.id)) { tr.classList.add("is-selected"); tr.setAttribute("aria-selected", "true"); cb.checked = true; }
    if (AM.proto.hasQr(c)) {
      lazy(mini, function () {
        AM.qr.forCode(c).then(function (svg) { AM.fill(mini, svg || icon("scan-qr-code")); }, function () { AM.fill(mini, icon("scan-qr-code")); });
      });
    } else {
      mini.appendChild(icon("scan-qr-code"));
    }
    return { el: tr, slot: mini, cb: cb, qrKey: qrKey(c) };
  }
  function renderSortHeaders() {
    var s = sortPref();
    AM.$$("#codes-table th[data-sort]").forEach(function (th) {
      var k = th.getAttribute("data-sort");
      var on = k === s.key;
      if (on) th.setAttribute("aria-sort", s.dir === "desc" ? "descending" : "ascending");
      else th.removeAttribute("aria-sort");
      var use = th.querySelector("use");
      var want = AM.ICONS_URL + "#i-" + (on ? (s.dir === "desc" ? "arrow-down" : "arrow-up") : "arrow-up-down");
      if (use && use.getAttribute("href") !== want) use.setAttribute("href", want);
    });
  }
  function renderTable() {
    renderSortHeaders();
    reconcile($("codes-tbody"), ctx.disp, cache.rows, rowSig, buildRow, function (el) { return el; });
  }
  function onSortClick(e) {
    var th = e.target.closest("th[data-sort]");
    if (!th || !e.target.closest(".sort")) return;
    var k = th.getAttribute("data-sort");
    var s = sortPref();
    AM.prefs.set("tableSort", { key: k, dir: s.key === k && s.dir === "asc" ? "desc" : "asc" });
  }

  // =========================================================================
  // Sidebar + category chip row
  // =========================================================================
  function renderNav(counts) {
    var F = AM.filters.state;
    var total = ctx.all.length;
    var all = $("nav-all"), uncat = $("nav-uncat");
    all.setAttribute("aria-pressed", String(F.cats.size === 0));
    uncat.setAttribute("aria-pressed", String(F.cats.has(NONE)));
    $("nav-all-n").textContent = num(total);
    $("nav-uncat-n").textContent = num(counts[NONE] || 0);
    var box = $("nav-categories");
    var list = AM.cat.list();
    var sig = JSON.stringify([AM.locale(), list.map(function (c) { return [c.id, c.name, c.color, c.icon, counts[c.id] || 0, F.cats.has(c.id)]; })]);
    if (box._sig === sig) return;
    box._sig = sig;
    refill(box, list.map(function (c) {
      var name = str(c.name);
      return h("div", { class: "nav-row", "data-cat-row": c.id },
        h("button", { type: "button", class: "nav-item", "aria-pressed": String(F.cats.has(c.id)), "data-cat": c.id, "data-fk": "nav:" + c.id },
          AM.cat.markEl(c), h("span", { class: "nav-item__label" }, bdi(name)), h("span", { class: "nav-item__n" }, num(counts[c.id] || 0))),
        h("button", { type: "button", class: "icon-btn icon-btn--xs nav-more", "data-cat-more": c.id, "data-fk": "navmore:" + c.id, "aria-haspopup": "menu", "aria-expanded": "false", "aria-label": t("nav.edit_category", { name: name }), tip: t("nav.edit_or_delete") }, icon("ellipsis")));
    }));
  }
  function renderCatRow(counts) {
    var box = $("cat-row");
    var F = AM.filters.state;
    var list = AM.cat.list();
    var total = ctx.all.length;
    var sig = JSON.stringify([AM.locale(), total, counts[NONE] || 0, F.cats.size, F.cats.has(NONE), list.map(function (c) { return [c.id, c.name, c.color, c.icon, counts[c.id] || 0, F.cats.has(c.id)]; })]);
    if (box._sig === sig) return;
    box._sig = sig;
    function chip(id, glyph, label, n, on) {
      return h("button", { type: "button", class: "chip chip--lg", "aria-pressed": String(on), "data-cat": id, "data-fk": "chip:" + id },
        glyph, h("span", null, bdi(label)), h("span", { class: "chip__n" }, num(n)));
    }
    refill(box, [
      chip("__all__", icon("layers"), t("filter.all_short"), total, F.cats.size === 0),
      list.map(function (c) { return chip(c.id, AM.cat.markEl(c), str(c.name), counts[c.id] || 0, F.cats.has(c.id)); }),
      chip(NONE, icon("tag"), t("nav.uncategorized"), counts[NONE] || 0, F.cats.has(NONE)),
      h("button", { type: "button", class: "icon-btn icon-btn--outline cat-row__manage", "data-role": "manage", "data-fk": "chip:manage", "aria-haspopup": "dialog", tip: t("nav.manage_categories") }, icon("ellipsis")),
    ]);
  }
  function onCategoryPick(id) {
    if (id === "__all__") AM.filters.set({ cats: [] });
    else AM.filters.toggle("cats", id);
  }
  function categoryMenu(cat, anchor) {
    AM.menu.show(anchor, [
      { icon: "pencil", label: t("action.edit"), run: function () { AM.act("openCategoryEditor", cat); } },
      { sep: true },
      { icon: "trash-2", label: t("action.move_to_trash"), danger: true, run: function () { trashCategory(cat); } },
    ], { label: t("nav.edit_category", { name: str(cat.name) }), placement: "bottom-end" });
  }
  function trashCategory(cat) {
    var name = str(cat.name);
    AM.confirm({
      title: t("confirm.trash_category_title", { name: name }),
      message: t("confirm.trash_category_body"),
      confirmLabel: t("action.move_to_trash"),
    }).then(function (ok) {
      if (!ok) return null;
      return AM.api("/categories/" + encodeURIComponent(cat.id), { method: "DELETE" }).then(function () {
        return AM.refresh({ force: true }).catch(function () { return false; });
      }).then(function () {
        AM.toast({
          message: t("toast.moved_to_trash", { name: name }), icon: "trash-2",
          action: {
            label: t("action.undo"), run: function () {
              AM.api("/categories/" + encodeURIComponent(cat.id) + "/restore", { method: "POST" })
                .then(function () { return AM.refresh({ force: true }); })
                .catch(function (err) { AM.reportError(err); });
            },
          },
        });
      }, function (err) {
        AM.reportError(err);
        AM.refresh({ force: true }).catch(function () {});
      });
    });
  }

  // =========================================================================
  // Insight strip (desktop/tablet) + thin insight (phone)
  // =========================================================================
  function protoCounts(list) {
    var by = {};
    PROTOS.forEach(function (p) { by[p] = 0; });
    list.forEach(function (c) { by[AM.proto.of(c)]++; });
    return by;
  }
  function spectrumBar(by) {
    return h("div", { class: "spectrum__bar", "aria-hidden": "true" }, PROTOS.filter(function (p) { return by[p]; }).map(function (p) {
      return h("span", { class: "p-" + p, style: { flex: String(by[p]) } });
    }));
  }
  function ringEl(inUse, total) {
    var R = 30, C = 2 * Math.PI * R, frac = total ? inUse / total : 0;
    return h("div", { class: "ring", role: "img", "aria-label": t("insight.summary_aria", { inUse: inUse, total: total }) },
      h("svg", { viewBox: "0 0 100 100", "aria-hidden": "true", focusable: "false" },
        h("g", { class: "ring__orbits", style: "fill:none;stroke:var(--orb-line);stroke-width:.8" },
          h("ellipse", { cx: "50", cy: "50", rx: "49", ry: "37", transform: "rotate(-28 50 50)" }),
          h("ellipse", { cx: "50", cy: "50", rx: "49", ry: "37", transform: "rotate(36 50 50)", "stroke-dasharray": "1.5 3" })),
        h("circle", { cx: "92", cy: "30", r: "2.6", style: "fill:var(--orb-2)" }),
        h("circle", { cx: "12", cy: "76", r: "2", style: "fill:var(--orb-3)" }),
        h("circle", { cx: "50", cy: "50", r: String(R), style: "fill:none;stroke:var(--surface-3);stroke-width:6.5" }),
        frac > 0 ? h("circle", { class: "ring__arc", cx: "50", cy: "50", r: String(R), "stroke-linecap": "round", transform: "rotate(-90 50 50)",
          "stroke-dasharray": (C * frac).toFixed(2) + " " + C.toFixed(2), style: "fill:none;stroke:var(--ok);stroke-width:6.5" }) : null),
      h("span", { class: "ring__label", "aria-hidden": "true" }, h("span", { class: "ring__num" }, num(inUse)), h("span", { class: "ring__cap" }, t("insight.in_use"))));
  }
  function renderInsight(hide) {
    var box = $("insight"), thin = $("insight-thin");
    if (hide) { box.hidden = true; thin.hidden = true; return; }
    var all = ctx.all;
    var F = AM.filters.state;
    var by = protoCounts(all);
    var inUse = all.filter(function (c) { return c.in_use; }).length;
    var spare = all.length - inUse;
    var linked = all.filter(function (c) { return c.ha_link && c.ha_link.device_id; }).length;
    var spares = all.filter(function (c) { return !c.in_use && AM.proto.hasQr(c); }).slice(0, 4);
    var sig = JSON.stringify([AM.locale(), all.length, by, inUse, linked, spares.map(qrKey), Array.from(F.protocol).sort(), F.inUse]);
    if (box._sig !== sig) {
      box._sig = sig;
      var legend = PROTOS.filter(function (p) { return by[p] || F.protocol.has(p); }).map(function (p) {
        return h("button", { type: "button", class: "legend-btn p-" + p, "aria-pressed": String(F.protocol.has(p)), "data-proto": p, "data-fk": "legend:" + p },
          h("span", null, AM.proto.label(p)), " ", h("b", null, num(by[p])));
      });
      var fan = h("span", { class: "spares__fan", "aria-hidden": "true" });
      spares.forEach(function (c) {
        var s = h("span");
        fan.appendChild(s);
        AM.qr.forCode(c).then(function (svg) { if (svg) AM.fill(s, svg); }, function () {});
      });
      refill(box, [
        h("div", { class: "insight__total" }, countParts("insight.pairing_codes", all.length, "insight__num", "span", "insight__cap")),
        h("div", { class: "spectrum" },
          h("div", { class: "spectrum__head" }, h("span", { class: "overline" }, t("insight.protocols")), h("span", { class: "only-desktop spectrum__hint" }, t("insight.tap_to_filter"))),
          spectrumBar(by),
          h("div", { class: "spectrum__legend", role: "group", "aria-label": t("insight.tap_to_filter") }, legend)),
        h("div", { class: "insight__usage" },
          ringEl(inUse, all.length),
          h("div", { class: "usage-list" },
            h("button", { type: "button", "data-inuse-toggle": "yes", "aria-pressed": String(F.inUse === "yes"), "data-fk": "usage:yes" },
              h("span", { class: "status status--inuse" }, t("insight.in_use")), h("b", null, num(inUse))),
            h("button", { type: "button", "data-inuse-toggle": "no", "aria-pressed": String(F.inUse === "no"), "data-fk": "usage:no" },
              h("span", { class: "status status--spare" }, t("insight.spare")), h("b", null, num(spare))),
            h("div", null, icon("house-plug"), h("span", null, t("insight.linked")), h("b", null, num(linked))))),
        spare ? h("button", { type: "button", class: "spares", "data-inuse-toggle": "no", "aria-pressed": String(F.inUse === "no"), "data-fk": "spares" },
          fan,
          h("span", { class: "spares__txt" }, countParts("insight.spares_ready", spare, "spares__n", "span"),
            h("small", null, t("insight.show"), icon("arrow-right", "icon--flip-rtl")))) : null,
      ]);
      var n = box.querySelector(".spares__n");
      if (n) { var b = h("b", null, n.textContent); n.parentNode.replaceChild(b, n); }
    }
    box.hidden = false;
    var tsig = JSON.stringify([AM.locale(), all.length, by, inUse]);
    if (thin._sig !== tsig) {
      thin._sig = tsig;
      AM.fill(thin,
        h("span", { class: "insight-thin__num" }, countParts("status.count_codes", all.length, "insight-thin__n", "small")),
        spectrumBar(by),
        h("span", { class: "insight-thin__use" }, h("span", { class: "status status--inuse" }, t("insight.in_use_n", { count: inUse }))));
    }
    thin.hidden = false;
  }
  function toggleInUse(v) { AM.filters.set({ inUse: AM.filters.state.inUse === v ? "" : v }); }

  // =========================================================================
  // View bar: title, status, view switch, zoom
  // =========================================================================
  function titleText() {
    var cats = Array.from(AM.filters.state.cats);
    if (!cats.length) return t("nav.all_codes");
    var names = cats.map(function (id) { return id === NONE ? t("nav.uncategorized") : AM.cat.name(id); }).filter(Boolean);
    if (names.length === 1) return names[0];
    if (names.length === 2) return AM.fmt.list(names);
    return t("more.categories_desc", { count: names.length });
  }
  function renderViewbar() {
    var title = $("view-title");
    title.setAttribute("data-owned", "");
    var tt = titleText();
    if (title.textContent !== tt) title.textContent = tt;
    var total = ctx.all.length, shown = ctx.shown.length;
    var active = AM.filters.isActive();
    var key = active ? "shown" : ctx.view === "labels" ? "labels" : "codes";
    var ssig = [AM.locale(), key, total, shown].join("|");
    if (st.statusSig !== ssig) {
      st.statusSig = ssig;
      var status = $("view-status");
      if (!total) AM.fill(status);
      else if (active) AM.fill(status, AM.tNodes("status.shown_of_total", { shown: shown, total: total }, { shown: h("b", null, num(shown)) }));
      else AM.fill(status, AM.tNodes(key === "labels" ? "status.labels" : "status.count_codes", { count: total }, { count: h("b", null, num(total)) }));
    }
    var seg = $("view-switch");
    AM.$$("[data-view]", seg).forEach(function (b) { b.setAttribute("aria-checked", String(b.getAttribute("data-view") === ctx.view)); });
    AM.radio.sync(seg);
    var z = zoomPct();
    $("zoom").hidden = ctx.view === "table" || !total;
    var zv = $("zoom-val");
    var zt = AM.fmt.percent(z);
    if (zv.textContent !== zt) zv.textContent = zt;
    zv.setAttribute("aria-label", t("view.grid_size_value", { value: zt }));
    $("zoom-out").disabled = z <= ZOOM_MIN;
    $("zoom-in").disabled = z >= ZOOM_MAX;
  }
  function setView(v) {
    if (v !== "cards" && v !== "labels" && v !== "table") return;
    if (v !== "labels") st.lastCodesView = v;
    AM.prefs.set("view", v);
  }
  function setZoom(z) {
    z = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round(z / ZOOM_STEP) * ZOOM_STEP));
    if (z !== zoomPct()) AM.prefs.set("zoom", z);
  }
  function applyZoom() {
    var z = zoomPct() / 100;
    var grid = $("view-cards");
    grid.style.setProperty("--zoom", String(z));
    grid.style.setProperty("--tile-z", String(tileZ()));
    grid.classList.toggle("grid--compact", z < 0.8);
    $("view-labels").style.setProperty("--zoom", String(z));
  }
  function openZoomMenu(anchor) {
    var z = zoomPct();
    var items = [];
    for (var v = ZOOM_MAX; v >= ZOOM_MIN; v -= ZOOM_STEP) {
      (function (val) { items.push({ label: AM.fmt.percent(val), dir: "ltr", checked: val === z, run: function () { setZoom(val); } }); })(v);
    }
    items.push({ sep: true }, { icon: "undo-2", label: t("view.reset"), kbd: [MOD, "0"], disabled: z === 100, run: function () { setZoom(100); } });
    AM.menu.show(anchor, items, { label: t("view.grid_size"), placement: "bottom-end", className: "zoom-menu" });
  }
  var wheel = { acc: 0, at: 0 };
  function onZoomWheel(e) {
    if (!(e.ctrlKey || e.metaKey) || ctx && ctx.view === "table") return;
    e.preventDefault();
    var now = Date.now();
    if (now - wheel.at > 350) wheel.acc = 0;
    wheel.at = now;
    wheel.acc += e.deltaY * (e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1);
    if (wheel.acc <= -40) { wheel.acc = 0; setZoom(zoomPct() + ZOOM_STEP); }
    else if (wheel.acc >= 40) { wheel.acc = 0; setZoom(zoomPct() - ZOOM_STEP); }
  }
  // Pinch: Safari trackpad gesture events + two-finger touch over the grid/labels (commits on release).
  var pinch = { z0: 100, pts: new Map(), d0: 0, ratio: 1 };
  function pinchDist() {
    var p = Array.from(pinch.pts.values());
    return p.length < 2 ? 0 : Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
  }
  function bindPinch(el) {
    el.addEventListener("gesturestart", function (e) { e.preventDefault(); pinch.z0 = zoomPct(); });
    el.addEventListener("gesturechange", function (e) { e.preventDefault(); });
    el.addEventListener("gestureend", function (e) { e.preventDefault(); setZoom(pinch.z0 * (e.scale || 1)); });
    el.addEventListener("pointerdown", function (e) {
      if (e.pointerType !== "touch") return;
      pinch.pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch.pts.size === 2) { pinch.d0 = pinchDist(); pinch.z0 = zoomPct(); pinch.ratio = 1; cancelLongPress(); }
    });
    el.addEventListener("pointermove", function (e) {
      if (!pinch.pts.has(e.pointerId)) return;
      pinch.pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch.pts.size === 2 && pinch.d0 > 0) pinch.ratio = pinchDist() / pinch.d0;
    });
    function end(e) {
      if (!pinch.pts.has(e.pointerId)) return;
      var was = pinch.pts.size === 2 && pinch.d0 > 0;
      pinch.pts.delete(e.pointerId);
      if (was && Math.abs(pinch.ratio - 1) > 0.08) { setZoom(pinch.z0 * pinch.ratio); st.suppressClickUntil = Date.now() + 400; }
      if (pinch.pts.size < 2) pinch.d0 = 0;
    }
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
  }

  // =========================================================================
  // Search
  // =========================================================================
  var setQueryDebounced = AM.debounce(function (v) { AM.filters.set({ query: v }); }, 120);
  function syncSearch() {
    var s = $("search");
    var q = AM.filters.state.query;
    if (s && s.value !== q && doc.activeElement !== s) s.value = q;
  }
  function setQuery(q) {
    var s = $("search");
    if (s) s.value = q;
    AM.filters.set({ query: q });
  }

  // =========================================================================
  // Filter chips row, popovers (desktop) and the Filters sheet (phone)
  // =========================================================================
  var fbar = null;
  function filterCount(key) {
    var F = AM.filters.state;
    if (key === "inUse") return F.inUse ? 1 : 0;
    return F[key] ? F[key].size : 0;
  }
  function buildFilterBar() {
    var chips = {};
    var kids = FILTER_DEFS.map(function (d) {
      var b = h("button", { type: "button", class: "chip", "aria-haspopup": "dialog", "aria-expanded": "false", "data-filter": d.key },
        d.icon ? icon(d.icon) : null, h("span", null, t(d.label)), h("span", { class: "chip__count", hidden: true }), icon("chevron-down", "chev"));
      chips[d.key] = b;
      return b;
    });
    var session = h("button", { type: "button", class: "chip is-active", "data-role": "session", hidden: true, "aria-label": t("filter.remove", { filter: t("filter.session") }) },
      icon("layers"), h("span", null, t("filter.session")), icon("x", "chev"));
    var clear = h("button", { type: "button", class: "chip chip--dashed", "data-role": "clear", hidden: true }, icon("filter-x"), h("span", null, t("filter.clear")));
    AM.fill($("filters"), kids, session, clear);
    fbar = { chips: chips, clear: clear, session: session, locale: AM.locale() };
  }
  function renderFilterBar(empty) {
    if (!fbar || fbar.locale !== AM.locale()) {
      if (pop) AM.popover.close(false);
      buildFilterBar();
    }
    $("filters").hidden = empty;
    FILTER_DEFS.forEach(function (d) {
      var n = filterCount(d.key);
      var chip = fbar.chips[d.key];
      chip.classList.toggle("is-active", n > 0);
      var badge = chip.querySelector(".chip__count");
      badge.hidden = !n;
      badge.textContent = n ? num(n) : "";
    });
    var ac = AM.filters.activeCount();
    var hadFocus = doc.activeElement === fbar.clear;
    fbar.clear.hidden = !ac;
    if (hadFocus && !ac) fbar.chips.protocol.focus({ preventScroll: true });
    fbar.session.hidden = !AM.filters.state.ids;
    var badge2 = $("filters-badge");
    badge2.hidden = !ac;
    badge2.textContent = ac ? num(ac) : "";
  }

  /** Options for a filter with per-value counts under every OTHER active filter. */
  function filterOptions(key) {
    var F = AM.filters.state;
    var base = AM.filters.apply(null, [key]);
    if (key === "protocol") {
      var cnt = {};
      base.forEach(function (c) { var p = AM.proto.of(c); cnt[p] = (cnt[p] || 0) + 1; });
      return PROTOS.map(function (p) { return { value: p, label: AM.proto.label(p), count: cnt[p] || 0, checked: F.protocol.has(p), proto: p }; });
    }
    if (key === "conn") {
      var out = [{
        value: AM.filters.CONN_EMPTY, label: t("filter.empty"), empty: true, checked: F.conn.has(AM.filters.CONN_EMPTY),
        count: base.filter(function (c) { return !CONN_ORDER.some(function (k) { return c[k]; }); }).length,
      }];
      // Filter options follow the canonical order (WiFi, Thread, Zigbee, Bluetooth, Z-Wave) shared
      // with the editor; CONN_ORDER (Thread first) only orders the compact card facts.
      AM.filters.CONN.forEach(function (cn) {
        var k = cn.key;
        var key = "code." + k;
        out.push({ value: k, label: t(key), icon: CONN_ICON[k], checked: F.conn.has(k), count: base.filter(function (c) { return !!c[k]; }).length });
      });
      return out;
    }
    var prop = FIELDS[key];
    var cnt2 = new Map();
    base.forEach(function (c) { var k = fkey(c[prop]); cnt2.set(k, (cnt2.get(k) || 0) + 1); });
    return AM.filters.values(key).map(function (v) {
      return {
        value: v.value, empty: v.value === "", count: cnt2.get(v.value) || 0, checked: F[key].has(v.value),
        label: v.value === "" ? t("filter.empty") : key === "type" ? typeText(v.label) : v.label,
      };
    });
  }
  function optLabel(o) {
    if (o.proto) return h("span", { class: "proto p-" + o.proto + " filter-pop__proto" }, o.label);
    if (o.icon) return h("span", { class: "opt__label" }, icon(o.icon, "icon--sm"), h("span", null, o.label));
    return h("span", null, bdi(o.label));
  }
  function optEl(o, key, prefix) {
    return h("label", { class: ["opt", o.empty && "opt--empty"], "data-search": o.label.toLocaleLowerCase() },
      h("input", { type: "checkbox", class: "check", checked: o.checked, "data-filter": key, "data-value": o.value, "data-fk": prefix + key + ":" + o.value }),
      optLabel(o),
      h("span", { class: "opt__n" }, num(o.count)));
  }
  function inUseSeg(prefix) {
    var cur = AM.filters.state.inUse || "all";
    var g = h("div", { class: "seg seg--block", role: "radiogroup", "aria-label": t("code.in_use"), "data-inuse-seg": "" },
      [["all", "filter.all_short"], ["yes", "filter.yes"], ["no", "filter.no"]].map(function (o) {
        return h("button", { type: "button", class: "seg__btn", role: "radio", "aria-checked": String(cur === o[0]), "data-inuse": o[0], "data-fk": prefix + "inuse:" + o[0] }, t(o[1]));
      }));
    AM.radio.sync(g);
    return g;
  }
  function applySearch(list, q) {
    q = String(q || "").trim().toLocaleLowerCase();
    var shown = 0;
    AM.$$(".opt", list).forEach(function (o) {
      var hit = !q || (o.getAttribute("data-search") || "").indexOf(q) >= 0;
      o.hidden = !hit;
      if (hit) shown++;
    });
    var none = list.querySelector(".filter-pop__empty");
    if (!shown && !none) list.appendChild(h("p", { class: "filter-pop__empty" }, t(list.querySelector(".opt") ? "filter.no_match" : "filter.no_options")));
    else if (shown && none) none.remove();
  }
  function listKeys(e, list, search) {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
    var boxes = AM.$$("input.check", list).filter(function (i) { return !i.closest("[hidden]"); });
    if (!boxes.length) return;
    var i = boxes.indexOf(doc.activeElement);
    var next;
    if (e.key === "Home") next = boxes[0];
    else if (e.key === "End") next = boxes[boxes.length - 1];
    else if (e.key === "ArrowDown") next = boxes[i < 0 ? 0 : Math.min(boxes.length - 1, i + 1)];
    else next = i <= 0 ? search || boxes[0] : boxes[i - 1];
    if (next) { e.preventDefault(); next.focus(); }
  }

  var pop = null; // {key, el, anchor}
  function openFilterPop(key, anchor) {
    if (pop && pop.key === key && AM.popover.isOpen(pop.el)) { AM.popover.close(true); return; }
    var def = FDEF[key];
    var el = h("div", { class: "popover filter-pop", role: "dialog", "aria-label": t("filter.popover_label", { filter: t(def.label) }) });
    var mine = { key: key, el: el, anchor: anchor };
    pop = mine;
    fillFilterPop(mine);
    el.addEventListener("change", function (e) {
      var inp = e.target;
      if (inp.matches("input[data-filter]")) AM.filters.toggle(inp.getAttribute("data-filter"), inp.getAttribute("data-value"));
    });
    el.addEventListener("input", function (e) {
      if (e.target.getAttribute("data-role") === "fsearch") applySearch(el.querySelector(".filter-pop__list"), e.target.value);
    });
    el.addEventListener("keydown", function (e) {
      var list = el.querySelector(".filter-pop__list");
      if (!list) return;
      var search = el.querySelector('[data-role="fsearch"]');
      if (e.target === search && e.key === "Enter") e.preventDefault();
      listKeys(e, list, search);
    });
    el.addEventListener("click", function (e) {
      if (e.target.closest('[data-role="fclear"]')) clearFilter(key);
    });
    AM.popover.open(el, anchor, { placement: "bottom-start", temp: true, onClose: function () { if (pop === mine) pop = null; } });
  }
  function fillFilterPop(p) {
    var key = p.key, el = p.el, def = FDEF[key];
    var foot = h("div", { class: "filter-pop__foot" },
      key === "inUse" ? null : h("span", { class: "hint kbd-hint" }, t("filter.kbd_hint")),
      h("span", { class: "spacer" }),
      h("button", { type: "button", class: "btn btn--sm btn--ghost", "data-role": "fclear" }, t("filter.clear_this")));
    if (key === "inUse") { AM.fill(el, h("div", { class: "filter-pop__seg" }, inUseSeg("pop:")), foot); return; }
    var opts = filterOptions(key);
    var search = FIELDS[key] ? h("div", { class: "filter-pop__head search" }, icon("search"),
      h("input", { class: "input", type: "search", autocomplete: "off", "data-role": "fsearch", placeholder: t("filter.search_values", { filter: t(def.label) }), "aria-label": t("filter.search_values", { filter: t(def.label) }) })) : null;
    var list = h("div", { class: "filter-pop__list", role: "group", "aria-label": t(def.label) }, opts.map(function (o) { return optEl(o, key, "pop:"); }));
    AM.fill(el, search, list, foot);
    applySearch(list, "");
  }
  function refreshFilterPop() {
    if (!pop || !AM.popover.isOpen(pop.el)) return;
    if (pop.key === "inUse") {
      var seg = pop.el.querySelector("[data-inuse-seg]");
      if (seg) AM.radio.set(seg, AM.filters.state.inUse || "all", "data-inuse");
      return;
    }
    var list = pop.el.querySelector(".filter-pop__list");
    var opts = filterOptions(pop.key);
    var inputs = list.querySelectorAll("input[data-value]");
    var same = inputs.length === opts.length && opts.every(function (o, i) { return inputs[i].getAttribute("data-value") === o.value; });
    if (same) {
      opts.forEach(function (o, i) {
        if (inputs[i].checked !== o.checked) inputs[i].checked = o.checked;
        inputs[i].parentNode.querySelector(".opt__n").textContent = num(o.count);
      });
    } else {
      var scroll = list.scrollTop;
      refill(list, opts.map(function (o) { return optEl(o, pop.key, "pop:"); }));
      list.scrollTop = scroll;
      var s = pop.el.querySelector('[data-role="fsearch"]');
      applySearch(list, s ? s.value : "");
    }
    AM.popover.reposition();
  }
  function clearFilter(key) {
    var patch = {};
    patch[key] = key === "inUse" ? "" : [];
    AM.filters.set(patch);
  }

  // ---- Phone Filters sheet ----
  var fs = { drill: null, q: "" };
  function openFilterSheet() {
    fs.drill = null;
    fs.q = "";
    renderFilterSheet(true);
    AM.sheets.open("sheet-filters", { onClose: function () { fs.drill = null; } });
  }
  function filterSummary(key) {
    var sel = filterOptions(key).filter(function (o) { return o.checked; }).map(function (o) { return o.label; });
    if (!sel.length) return null;
    return sel.length <= 2 ? AM.fmt.list(sel) : t("status.selected", { count: sel.length });
  }
  function sheetGroup(title, extra, body) {
    return h("div", { class: "fsheet__group" }, h("span", { class: "fsheet__title" }, h("span", null, title), extra), body);
  }
  function mainSheetView() {
    var proto = filterOptions("protocol");
    var vend = filterOptions("vendor");
    var vendTop = vend.filter(function (o) { return o.checked; }).concat(vend.filter(function (o) { return !o.checked; }));
    var limit = Math.max(4, vend.filter(function (o) { return o.checked; }).length);
    return [
      sheetGroup(t("code.protocol"), null, h("div", { class: "fsheet__chips" }, proto.map(function (o) {
        return h("button", { type: "button", class: ["chip", "p-" + o.value], "aria-pressed": String(o.checked), "data-ftoggle": "protocol", "data-value": o.value, "data-fk": "fs:protocol:" + o.value },
          h("span", { class: "proto fsheet__proto" }, o.label), h("span", { class: "chip__n" }, num(o.count)));
      }))),
      sheetGroup(t("code.in_use"), null, inUseSeg("fs:")),
      vend.length ? sheetGroup(t("filter.vendor"), h("span", { class: "tag" }, num(vend.length)), h("div", { class: "fsheet__chips" },
        vendTop.slice(0, limit).map(function (o) {
          return h("button", { type: "button", class: ["chip", o.empty && "opt--empty"], "aria-pressed": String(o.checked), "data-ftoggle": "vendor", "data-value": o.value, "data-fk": "fs:vendor:" + o.value },
            h("span", null, bdi(o.label)));
        }),
        vend.length > limit ? h("button", { type: "button", class: "chip chip--dashed", "data-drill": "vendor", "data-fk": "drill:vendor" }, t("filter.show_all", { count: vend.length })) : null)) : null,
      h("div", { class: "fsheet__group fsheet__group--drills" }, ["product", "type", "area", "conn"].map(function (k) {
        var s = filterSummary(k);
        return h("button", { type: "button", class: "drill", "data-drill": k, "data-fk": "drill:" + k },
          h("span", null, t(FDEF[k].label)), h("span", { class: ["v", s && "is-set"] }, s ? bdi(s) : t("filter.any")), icon("chevron-right", "icon--flip-rtl"));
      })),
      h("p", { class: "fsheet__note" }, t("filter.logic_note")),
    ];
  }
  function drillSheetView(k) {
    var opts = filterOptions(k);
    var label = t(FDEF[k].label);
    var active = filterCount(k) > 0;
    var list = h("div", { class: "fsheet__list", role: "group", "aria-label": label }, opts.map(function (o) { return optEl(o, k, "fs:"); }));
    var search = opts.length > 8 ? h("div", { class: "search fsheet__search" }, icon("search"),
      h("input", { class: "input", type: "search", autocomplete: "off", "data-role": "fsearch", "data-fk": "fs:search", value: fs.q, placeholder: t("filter.search_values", { filter: label }), "aria-label": t("filter.search_values", { filter: label }) })) : null;
    applySearch(list, fs.q);
    return [
      h("div", { class: "fsheet__drill-head" },
        h("button", { type: "button", class: "icon-btn", "data-role": "drill-back", "data-fk": "drill-back", tip: t("action.back") }, icon("arrow-left", "icon--flip-rtl")),
        h("h3", null, label),
        active ? h("button", { type: "button", class: "btn btn--sm btn--ghost", "data-role": "fclear", "data-fk": "fs:clear" }, t("filter.clear_this")) : null),
      search, list,
    ];
  }
  function renderFilterSheet(force) {
    if (!force && !AM.sheets.isOpen("sheet-filters")) return;
    var body = $("filters-body");
    var scroll = body.scrollTop;
    refill(body, fs.drill ? drillSheetView(fs.drill) : mainSheetView());
    body.scrollTop = scroll;
    var ac = AM.filters.activeCount();
    var tag = $("filters-active");
    tag.hidden = !ac;
    tag.textContent = ac ? t("filter.active", { count: ac }) : "";
    var n = ctx ? ctx.shown.length : AM.filters.apply().length;
    $("filters-apply").textContent = t("filter.show_n", { count: n });
    $("filters-clear").disabled = !ac;
  }
  function drillTo(k) {
    fs.drill = k;
    fs.q = "";
    var body = $("filters-body");
    AM.fill(body, drillSheetView(k));
    body.scrollTop = 0;
    var back = body.querySelector('[data-role="drill-back"]');
    if (back) back.focus({ preventScroll: true });
  }
  function drillBack() {
    var k = fs.drill;
    fs.drill = null;
    var body = $("filters-body");
    AM.fill(body, mainSheetView());
    var row = findFk(body, "drill:" + k);
    if (row) { row.focus({ preventScroll: true }); row.scrollIntoView({ block: "nearest" }); }
  }

  // =========================================================================
  // Empty states
  // =========================================================================
  function activeChips() {
    var F = AM.filters.state;
    var out = [];
    function chip(fk, filterLabel, value, remove) {
      return h("span", { class: "active-chip" },
        AM.tNodes("filter.chip", { filter: filterLabel, value: value }, { value: h("b", null, bdi(value)) }),
        h("button", { type: "button", "data-fk": fk, "aria-label": t("filter.remove", { filter: filterLabel }), onclick: function () { remove(); focusAfterChip(); } }, icon("x")));
    }
    var q = F.query.trim();
    if (q) out.push(chip("ac:query", t("filter.search"), q, function () { setQuery(""); }));
    if (F.cats.size) {
      var names = Array.from(F.cats).map(function (id) { return id === NONE ? t("nav.uncategorized") : AM.cat.name(id); }).filter(Boolean);
      out.push(chip("ac:cats", t("nav.categories"), AM.fmt.list(names), function () { AM.filters.set({ cats: [] }); }));
    }
    FILTER_DEFS.forEach(function (d) {
      if (!filterCount(d.key)) return;
      var val = d.key === "inUse" ? t(F.inUse === "yes" ? "filter.yes" : "filter.no")
        : AM.fmt.list(filterOptions(d.key).filter(function (o) { return o.checked; }).map(function (o) { return o.label; }));
      out.push(chip("ac:" + d.key, t(d.label), val, function () { clearFilter(d.key); }));
    });
    if (F.ids) {
      out.push(h("span", { class: "active-chip" }, h("span", null, t("filter.session")),
        h("button", { type: "button", "data-fk": "ac:ids", "aria-label": t("filter.remove", { filter: t("filter.session") }), onclick: function () { AM.filters.set({ ids: null }); focusAfterChip(); } }, icon("x"))));
    }
    return out;
  }
  function focusAfterChip() {
    setTimeout(function () {
      if (doc.activeElement && doc.activeElement !== doc.body) return;
      var target = AM.$("#empty-nomatch-chips button") || AM.$("#empty-nomatch:not([hidden]) .btn:not([hidden])") || $("search");
      if (target) target.focus({ preventScroll: true });
    }, 0);
  }
  function renderEmpty(empty, none) {
    $("empty-vault").hidden = !empty;
    var nm = $("empty-nomatch");
    nm.hidden = !none;
    if (!none) return;
    var F = AM.filters.state;
    var q = F.query.trim();
    var total = ctx.all.length;
    AM.fill($("empty-nomatch-body"), q
      ? AM.tNodes("empty.nomatch_body", { query: q, total: total }, { query: h("bdi", null, q) })
      : t("empty.nomatch_body_noquery", { total: total }));
    refill($("empty-nomatch-chips"), activeChips());
    $("empty-clear-search").hidden = !q;
    $("empty-clear-filters").hidden = !(AM.filters.activeCount() || F.cats.size || F.ids);
  }

  // =========================================================================
  // Selection (Explorer semantics) + selection bar
  // =========================================================================
  function selectClick(id, e) {
    var order = displayedIds();
    var mod = !!(e.ctrlKey || e.metaKey);
    var a = st.anchor ? order.indexOf(st.anchor) : -1;
    var b = order.indexOf(id);
    if (e.shiftKey && a >= 0 && b >= 0) {
      var range = order.slice(Math.min(a, b), Math.max(a, b) + 1);
      if (mod) AM.selection.add(range); else AM.selection.set(range); // anchor stays put
    } else {
      AM.selection.toggle(id);
      st.anchor = id;
    }
  }
  /** Codes hidden by search/filters leave the selection, so bulk actions only ever touch visible codes. */
  function pruneSelection() {
    if (!AM.selection.size) return;
    var shown = new Set(ctx.shown.map(function (c) { return c.id; }));
    var gone = Array.from(AM.selection.ids).filter(function (id) { return !shown.has(id); });
    if (gone.length) AM.selection.remove(gone);
  }
  function toggleOne(id) {
    AM.selection.toggle(id);
    st.anchor = id;
  }
  function syncSelection() {
    var sel = AM.selection;
    var n = sel.size;
    var on = n > 0 || sel.mode;
    $("view-cards").classList.toggle("grid--selecting", on);
    cache.cards.forEach(function (rec, id) {
      var s = sel.has(id);
      rec.el.classList.toggle("is-selected", s);
      if (rec.cb.checked !== s) rec.cb.checked = s;
    });
    cache.rows.forEach(function (rec, id) {
      var s = sel.has(id);
      rec.el.classList.toggle("is-selected", s);
      rec.el.setAttribute("aria-selected", String(s));
      if (rec.cb.checked !== s) rec.cb.checked = s;
    });
    var ids = ctx ? ctx.disp : [];
    var hit = 0;
    ids.forEach(function (c) { if (sel.has(c.id)) hit++; });
    var all = $("table-check-all");
    all.checked = ids.length > 0 && hit === ids.length;
    all.indeterminate = hit > 0 && hit < ids.length;
    ["btn-select", "btn-select-phone"].forEach(function (id) { var b = $(id); if (b) b.setAttribute("aria-pressed", String(on)); });
    var bar = $("selbar");
    bar.hidden = !on || !(ctx && ctx.all.length);
    if (n !== st.selCount) {
      st.selCount = n;
      AM.fill($("selbar-count"), AM.tNodes("status.selected", { count: n }, { count: h("span", { class: "badge" }, num(n)) }));
    }
    $("selbar-trash").disabled = n === 0;
    $("selbar-all").disabled = !!ids.length && hit === ids.length;
    if (!n && !sel.mode) st.anchor = null;
  }
  function deleteIds(ids) {
    ids = Array.from(ids || []).filter(function (id) { return AM.store.codeById.has(id); });
    if (!ids.length) return;
    AM.act("deleteCodes", ids);
  }

  // =========================================================================
  // Card / row / label actions + menu
  // =========================================================================
  function openDetail(c, opts) { AM.act("openDetail", c, Object.assign({ list: displayedIds() }, opts || {})); }
  function present(c) { AM.act("openPresent", c, { list: displayedIds() }); }
  function copyCode(c) {
    var f = AM.proto.formatCode(c);
    if (f.copy) AM.copy(f.copy);
  }
  function decodable(c) { var p = AM.proto.of(c); return (p === "matter" || p === "zwave") && AM.proto.hasPayload(c); }
  function showCodeMenu(c, anchor) {
    var f = AM.proto.formatCode(c);
    var selected = AM.selection.has(c.id);
    var linked = c.ha_link && c.ha_link.device_id;
    AM.menu.show(anchor, [
      { icon: "maximize-2", label: t("action.open_details"), kbd: "↵", run: function () { openDetail(c); } },
      { icon: "copy", label: t("action.copy_code"), kbd: "C", disabled: !f.copy, run: function () { copyCode(c); } },
      { icon: "presentation", label: t("action.present_full"), kbd: "P", run: function () { present(c); } },
      decodable(c) ? { icon: "binary", label: t("action.decode_payload"), kbd: "D", run: function () { openDetail(c, { focus: "decode" }); } } : null,
      { sep: true },
      { icon: "pencil", label: t("action.edit"), kbd: "E", run: function () { AM.act("openEditor", c); } },
      { icon: "download", label: t("action.download_label"), kbd: ["⇧", "D"], run: function () { AM.act("downloadLabel", c); } },
      linked ? { icon: "house", label: t("action.open_in_ha"), run: function () { AM.ha.openDevice(c.ha_link.device_id); } } : null,
      { icon: selected ? "square" : "square-check-big", label: selected ? t("action.deselect") : t("action.select"), kbd: "X", run: function () { toggleOne(c.id); } },
      { sep: true },
      { icon: "trash-2", label: t("action.move_to_trash"), kbd: "Del", danger: true, run: function () { deleteIds([c.id]); } },
    ], { label: t("action.more_actions", { name: str(c.name) }), placement: "bottom-end" });
  }

  function onViewClick(e) {
    if (Date.now() < st.suppressClickUntil) { e.preventDefault(); e.stopPropagation(); return; }
    var host = e.target.closest("[data-id]");
    if (!host || !e.currentTarget.contains(host)) return;
    var id = host.getAttribute("data-id");
    var c = codeOf(id);
    if (!c) return;
    var roleEl = e.target.closest("[data-role]");
    var role = roleEl && host.contains(roleEl) ? roleEl.getAttribute("data-role") : null;
    switch (role) {
      case "select":
        if (e.target.matches("input")) {
          if (e.shiftKey) selectClick(id, e); else toggleOne(id);
          if (AM.mq.coarse.matches && !AM.selection.mode && AM.selection.size) AM.selection.setMode(true);
        }
        return;
      case "select-cell": {
        var cb = roleEl.querySelector("input");
        if (cb && e.target !== cb) cb.click();
        return;
      }
      case "edit": AM.act("openEditor", c); return;
      case "more": showCodeMenu(c, roleEl); return;
      case "copy": copyCode(c); return;
      case "flip": setFlipped(host, !st.flipped.has(id)); return;
      case "present": present(c); return;
      default: break;
    }
    if (host.classList.contains("label-wrap")) return; // labels: flip/present are the actions; dblclick opens
    if (e.target.closest("a, input, textarea, select")) return;
    if (e.shiftKey || e.ctrlKey || e.metaKey) { e.preventDefault(); selectClick(id, e); return; }
    if (selectingTap()) { toggleOne(id); return; }
    openDetail(c);
  }
  function onViewDblClick(e) {
    var host = e.target.closest(".label-wrap[data-id]");
    if (!host || e.target.closest("button")) return;
    var c = codeOf(host.getAttribute("data-id"));
    if (c) openDetail(c);
  }
  function onViewMouseDown(e) {
    // Shift/Ctrl-click selects items; never extend a text selection across cards.
    if ((e.shiftKey || (IS_MAC ? e.metaKey : e.ctrlKey)) && e.target.closest("[data-id]") && !e.target.closest("input")) e.preventDefault();
  }
  function onViewContext(e) {
    var host = e.target.closest("[data-id]");
    if (!host) return;
    var c = codeOf(host.getAttribute("data-id"));
    if (!c) return;
    if (st.lastPointer === "touch") { e.preventDefault(); return; } // long-press is handled below
    if (IS_MAC && e.ctrlKey && !e.metaKey) { e.preventDefault(); selectClick(c.id, { ctrlKey: true, shiftKey: e.shiftKey }); return; } // macOS Ctrl-click
    if (e.target.closest("input, textarea")) return;
    e.preventDefault();
    var anchor = e.clientX || e.clientY ? { x: e.clientX, y: e.clientY } : host.querySelector('[data-role="more"]') || host;
    showCodeMenu(c, anchor);
  }

  // Long-press (touch): cards/rows enter select mode; category rows/chips open their menu.
  var lp = null;
  function cancelLongPress() { if (lp) { clearTimeout(lp.timer); lp = null; } }
  function bindLongPress(container, selector, fire) {
    container.addEventListener("pointerdown", function (e) {
      if (e.pointerType !== "touch") return;
      var host = e.target.closest(selector);
      if (!host || e.target.closest('[data-role="edit"], [data-role="more"], [data-role="copy"], [data-role="select"], [data-role="select-cell"], [data-role="flip"], [data-role="present"], .nav-more')) return;
      cancelLongPress();
      var rec = { x: e.clientX, y: e.clientY, host: host };
      rec.timer = setTimeout(function () {
        if (lp !== rec) return;
        lp = null;
        st.suppressClickUntil = Date.now() + 700;
        AM.haptic("selection");
        fire(host);
      }, 520);
      lp = rec;
    });
    container.addEventListener("pointermove", function (e) {
      if (lp && Math.hypot(e.clientX - lp.x, e.clientY - lp.y) > 10) cancelLongPress();
    });
    ["pointerup", "pointercancel", "pointerleave"].forEach(function (ev) { container.addEventListener(ev, cancelLongPress); });
  }
  function longPressSelect(host) {
    var id = host.getAttribute("data-id");
    if (!id) return;
    if (!AM.selection.mode) AM.selection.setMode(true);
    toggleOne(id);
  }

  // Arrow-key movement between cards (2-D, RTL aware) and table rows.
  function onGridKeys(e) {
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    var btn = e.target.closest && e.target.closest(".code-card__open");
    if (!btn) return;
    var cards = Array.prototype.slice.call($("view-cards").children);
    var i = cards.indexOf(btn.closest(".code-card"));
    if (i < 0) return;
    var rtl = AM.dir() === "rtl";
    var cols = 1;
    var top0 = cards[0].offsetTop;
    while (cols < cards.length && cards[cols].offsetTop === top0) cols++;
    var j = -1;
    switch (e.key) {
      case "ArrowRight": j = i + (rtl ? -1 : 1); break;
      case "ArrowLeft": j = i + (rtl ? 1 : -1); break;
      case "ArrowDown": j = i + cols < cards.length ? i + cols : (Math.floor(i / cols) < Math.floor((cards.length - 1) / cols) ? cards.length - 1 : -1); break;
      case "ArrowUp": j = i - cols; break;
      case "Home": j = 0; break;
      case "End": j = cards.length - 1; break;
      default: return;
    }
    if (j < 0 || j >= cards.length || j === i) return;
    e.preventDefault();
    var next = cards[j].querySelector(".code-card__open");
    next.focus({ preventScroll: true });
    cards[j].scrollIntoView({ block: "nearest", behavior: AM.mq.reducedMotion.matches ? "auto" : "smooth" });
  }
  function onTableKeys(e) {
    var tr = e.target;
    if (!tr || tr.tagName !== "TR" || !tr.hasAttribute("data-id")) return;
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    var id = tr.getAttribute("data-id");
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      var c = codeOf(id);
      if (!c) return;
      if (e.shiftKey) { selectClick(id, e); return; }
      if (selectingTap() || (e.key === " " && AM.selection.size > 0)) toggleOne(id);
      else openDetail(c);
      return;
    }
    var rows = Array.prototype.slice.call($("codes-tbody").children);
    var i = rows.indexOf(tr), j = -1;
    if (e.key === "ArrowDown") j = i + 1;
    else if (e.key === "ArrowUp") j = i - 1;
    else if (e.key === "Home") j = 0;
    else if (e.key === "End") j = rows.length - 1;
    else return;
    if (j < 0 || j >= rows.length) return;
    e.preventDefault();
    if (e.shiftKey && !st.anchor) st.anchor = id;
    rows[j].focus({ preventScroll: false });
    if (e.shiftKey) selectClick(rows[j].getAttribute("data-id"), { shiftKey: true });
  }

  // =========================================================================
  // Keyboard shortcuts (app scope: no layer or popover open)
  // =========================================================================
  function focusedHost() {
    var ae = doc.activeElement;
    if (!ae || !ae.closest) return null;
    return ae.closest("#view-cards [data-id], #codes-tbody [data-id], #view-labels [data-id]");
  }
  function focusedCode() { var hst = focusedHost(); return hst ? codeOf(hst.getAttribute("data-id")) : null; }
  function withFocused(fn) { return function (e) { var c = focusedCode(); if (!c) return false; return fn(c, e); }; }
  function wireShortcuts() {
    var R = AM.shortcuts.register;
    R("e", withFocused(function (c) { AM.act("openEditor", c); }));
    R("c", withFocused(function (c) { if (!AM.proto.formatCode(c).copy) return false; copyCode(c); }));
    R("p", withFocused(function (c) { present(c); }));
    R("d", withFocused(function (c) { if (!decodable(c)) return false; openDetail(c, { focus: "decode" }); }));
    R("shift+d", withFocused(function (c) { AM.act("downloadLabel", c); }));
    R("x", function () {
      var hst = focusedHost();
      if (!hst || hst.classList.contains("label-wrap")) return false;
      toggleOne(hst.getAttribute("data-id"));
    });
    R("f", function () {
      var hst = focusedHost();
      if (!hst || !hst.classList.contains("label-wrap")) return false;
      setFlipped(hst, !st.flipped.has(hst.getAttribute("data-id")));
    });
    R("delete", function () {
      if (AM.selection.size) { deleteIds(AM.selection.ids); return; }
      var c = focusedCode();
      if (!c) return false;
      deleteIds([c.id]);
    });
    R("mod+a", function () {
      if (!(AM.selection.size || AM.selection.mode) || view() === "labels" || !AM.store.vault.codes.length) return false;
      AM.selection.add(displayedIds());
    });
    R("escape", function () {
      if (!AM.selection.size && !AM.selection.mode) return false;
      AM.selection.clear();
    });
    R("1", function () { setView("cards"); });
    R("2", function () { setView("labels"); });
    R("3", function () { setView("table"); });
    R("mod+=", function () { if (view() === "table") return false; setZoom(zoomPct() + ZOOM_STEP); });
    R("mod+-", function () { if (view() === "table") return false; setZoom(zoomPct() - ZOOM_STEP); });
    R("mod+0", function () { if (view() === "table") return false; setZoom(100); });
  }

  // =========================================================================
  // One-time DOM wiring (called on the first render; index.html is parsed by then)
  // =========================================================================
  function wire() {
    if (st.wired || !$("view-cards")) return;
    st.wired = true;
    var cards = $("view-cards"), labels = $("view-labels"), tbody = $("codes-tbody");
    [cards, labels, tbody].forEach(function (el) {
      el.addEventListener("click", onViewClick);
      el.addEventListener("contextmenu", onViewContext);
      el.addEventListener("mousedown", onViewMouseDown);
    });
    labels.addEventListener("dblclick", onViewDblClick);
    cards.addEventListener("keydown", onGridKeys);
    tbody.addEventListener("keydown", onTableKeys);
    bindLongPress(cards, ".code-card[data-id]", longPressSelect);
    bindLongPress(tbody, "tr[data-id]", longPressSelect);
    [cards, labels].forEach(function (el) {
      el.addEventListener("wheel", onZoomWheel, { passive: false });
      bindPinch(el);
    });
    doc.addEventListener("pointerdown", function (e) { st.lastPointer = e.pointerType || "mouse"; }, true);

    // Table header sort + select-all
    $("codes-table").querySelector("thead").addEventListener("click", onSortClick);
    $("table-check-all").addEventListener("change", function (e) {
      var ids = displayedIds();
      if (e.target.checked) AM.selection.add(ids); else AM.selection.remove(ids);
    });

    // Sidebar + category chips
    var sidebar = $("sidebar");
    sidebar.addEventListener("click", function (e) {
      if (e.target.closest("#nav-all")) { AM.filters.set({ cats: [] }); return; }
      if (e.target.closest("#nav-uncat")) { AM.filters.toggle("cats", NONE); return; }
      var more = e.target.closest("[data-cat-more]");
      if (more) { var cat = AM.cat.get(more.getAttribute("data-cat-more")); if (cat) categoryMenu(cat, more); return; }
      var it = e.target.closest("#nav-categories [data-cat]");
      if (it && Date.now() >= st.suppressClickUntil) onCategoryPick(it.getAttribute("data-cat"));
    });
    sidebar.addEventListener("contextmenu", function (e) {
      var row = e.target.closest("[data-cat-row]");
      if (!row) return;
      e.preventDefault();
      if (st.lastPointer === "touch") return;
      var cat = AM.cat.get(row.getAttribute("data-cat-row"));
      if (cat) categoryMenu(cat, e.clientX || e.clientY ? { x: e.clientX, y: e.clientY } : row.querySelector(".nav-more"));
    });
    bindLongPress(sidebar, "[data-cat-row]", function (row) {
      var cat = AM.cat.get(row.getAttribute("data-cat-row"));
      if (cat) categoryMenu(cat, row.querySelector(".nav-more") || row);
    });
    var catRow = $("cat-row");
    catRow.addEventListener("click", function (e) {
      if (Date.now() < st.suppressClickUntil) return;
      if (e.target.closest('[data-role="manage"]')) { AM.act("openCategoryManager"); return; }
      var chip = e.target.closest("[data-cat]");
      if (chip) onCategoryPick(chip.getAttribute("data-cat"));
    });
    catRow.addEventListener("contextmenu", function (e) {
      var chip = e.target.closest("[data-cat]");
      var cat = chip && AM.cat.get(chip.getAttribute("data-cat"));
      if (!cat) return;
      e.preventDefault();
      if (st.lastPointer !== "touch") categoryMenu(cat, e.clientX || e.clientY ? { x: e.clientX, y: e.clientY } : chip);
    });
    bindLongPress(catRow, "[data-cat]", function (chip) {
      var cat = AM.cat.get(chip.getAttribute("data-cat"));
      if (cat) categoryMenu(cat, chip);
    });

    // Insight: protocol legend, in-use / spare, spares tile
    $("insight").addEventListener("click", function (e) {
      var lb = e.target.closest("[data-proto]");
      if (lb) { AM.filters.toggle("protocol", lb.getAttribute("data-proto")); return; }
      var iu = e.target.closest("[data-inuse-toggle]");
      if (iu) toggleInUse(iu.getAttribute("data-inuse-toggle"));
    });

    // View bar
    $("view-switch").addEventListener("click", function (e) {
      var b = e.target.closest("[data-view]");
      if (b) setView(b.getAttribute("data-view"));
    });
    ["btn-select", "btn-select-phone"].forEach(function (id) {
      var b = $(id);
      if (!b) return;
      b.addEventListener("click", function () {
        if (AM.selection.size || AM.selection.mode) AM.selection.clear();
        else AM.selection.setMode(true);
      });
    });
    $("zoom-out").addEventListener("click", function () { setZoom(zoomPct() - ZOOM_STEP); });
    $("zoom-in").addEventListener("click", function () { setZoom(zoomPct() + ZOOM_STEP); });
    $("zoom-val").addEventListener("click", function (e) { openZoomMenu(e.currentTarget); });
    $("zoom-out").setAttribute("data-kbd", MOD + " −");
    $("zoom-in").setAttribute("data-kbd", MOD + " +");

    // Search
    var search = $("search");
    search.addEventListener("input", function (e) { setQueryDebounced(e.target.value); });
    search.addEventListener("search", function (e) { AM.filters.set({ query: e.target.value }); });
    search.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { AM.filters.set({ query: e.target.value }); if (AM.mq.coarse.matches) e.target.blur(); }
      else if (e.key === "Escape" && !e.target.value) e.target.blur();
    });

    // Filters row, phone sheet, in-use segmented controls
    $("filters").addEventListener("click", function (e) {
      var chip = e.target.closest("[data-filter]");
      if (chip) { openFilterPop(chip.getAttribute("data-filter"), chip); return; }
      var r = e.target.closest("[data-role]");
      if (!r) return;
      if (r.getAttribute("data-role") === "clear") AM.filters.clear({ ids: false });
      if (r.getAttribute("data-role") === "session") AM.filters.set({ ids: null });
    });
    doc.addEventListener("click", function (e) {
      var b = e.target.closest && e.target.closest("[data-inuse]");
      if (!b || !b.closest("[data-inuse-seg]")) return;
      var v = b.getAttribute("data-inuse");
      AM.filters.set({ inUse: v === "all" ? "" : v });
    });
    $("btn-filters").addEventListener("click", openFilterSheet);
    var fbody = $("filters-body");
    fbody.addEventListener("click", function (e) {
      var tg = e.target.closest("[data-ftoggle]");
      if (tg) { AM.filters.toggle(tg.getAttribute("data-ftoggle"), tg.getAttribute("data-value")); return; }
      var d = e.target.closest("[data-drill]");
      if (d) { drillTo(d.getAttribute("data-drill")); return; }
      if (e.target.closest('[data-role="drill-back"]')) { drillBack(); return; }
      if (e.target.closest('[data-role="fclear"]') && fs.drill) clearFilter(fs.drill);
    });
    fbody.addEventListener("change", function (e) {
      var inp = e.target;
      if (inp.matches("input[data-filter]")) AM.filters.toggle(inp.getAttribute("data-filter"), inp.getAttribute("data-value"));
    });
    fbody.addEventListener("input", function (e) {
      if (e.target.getAttribute("data-role") !== "fsearch") return;
      fs.q = e.target.value;
      var list = fbody.querySelector(".fsheet__list");
      if (list) applySearch(list, fs.q);
    });
    fbody.addEventListener("keydown", function (e) {
      var list = fbody.querySelector(".fsheet__list");
      if (list) listKeys(e, list, fbody.querySelector('[data-role="fsearch"]'));
    });
    $("filters-clear").addEventListener("click", function () { AM.filters.clear({ ids: false }); });
    $("filters-apply").addEventListener("click", function () { AM.sheets.close("sheet-filters"); });
    AM.shortcuts.register("escape", function () {
      if (!fs.drill) return false;
      drillBack();
    }, { scope: "sheet-filters", allowInInput: true });

    // Empty states
    $("empty-clear-search").addEventListener("click", function () { setQuery(""); focusAfterChip(); });
    $("empty-clear-filters").addEventListener("click", function () { AM.filters.clear({ cats: true }); focusAfterChip(); });

    // Selection bar
    $("selbar-all").addEventListener("click", function () { AM.selection.add(displayedIds()); });
    $("selbar-trash").addEventListener("click", function () { deleteIds(AM.selection.ids); });
    $("selbar-clear").addEventListener("click", function () { AM.selection.clear(); });
    var k = $("selbar-all").querySelector(".kbd");
    if (k) k.textContent = MOD + " A";

    // Dock
    $("dock-codes").addEventListener("click", function () { setView(view() === "labels" ? st.lastCodesView : view()); scrollTop(); });
    $("dock-labels").addEventListener("click", function () { setView("labels"); });
  }
  function scrollTop() {
    try { global.scrollTo({ top: 0, behavior: AM.mq.reducedMotion.matches ? "auto" : "smooth" }); } catch (e) { global.scrollTo(0, 0); }
  }
  function renderDock() {
    var v = ctx.view;
    $("dock-codes").setAttribute("aria-current", v === "labels" ? "false" : "page");
    $("dock-labels").setAttribute("aria-current", v === "labels" ? "page" : "false");
  }

  // =========================================================================
  // Events + actions
  // =========================================================================
  AM.on("vault", function () { schedule(true); });
  AM.on("filters", function () { schedule(true); });
  AM.on("selection", function () { schedule(false); });
  AM.on("ha", function () { if (AM.filters.state.query) schedule(true); });
  AM.on("locale", function () {
    st.selCount = -1;
    st.statusSig = "";
    if (AM.store.loaded) schedule(true);
  });
  AM.on("prefs", function (p) {
    if (["view", "zoom", "labelNames", "labelCodes", "tableSort"].indexOf(p.name) >= 0) {
      if (p.name === "view" && pop) AM.popover.close(false);
      schedule(true);
    }
  });
  AM.on("home", function () {
    if (AM.filters.state.cats.size) AM.filters.set({ cats: [] });
  });
  [AM.mq.phone, mqTiny].forEach(function (mq) {
    var fn = function () { if (AM.store.loaded) schedule(true); };
    if (mq.addEventListener) mq.addEventListener("change", fn); else if (mq.addListener) mq.addListener(fn);
  });
  wireShortcuts();
  // index.html's markup precedes the scripts, so the vault screen can be wired right away
  // (typing into search during the first load is kept); renderAll() also guards this.
  if ($("view-cards") && $("search")) wire();
  else doc.addEventListener("DOMContentLoaded", wire);

  /** AM.act("render"): re-render every vault view now (after local state changes). */
  AM.provide("render", function () { renderAll(); });
})(window);
