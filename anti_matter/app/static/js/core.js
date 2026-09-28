/**
 * Anti-Matter 3.0 core: window.AM, the shared foundation every UI module codes against.
 * ============================================================================
 * Classic script (no modules, no bundler). Loads after i18n.js, the payload libraries,
 * matter-scan.js, ha-bridge.js, scan-engine.js and category-icons.js, and before the UI
 * modules (js/browse.js, detail.js, editor.js, dialogs.js, scanner-ui.js) and js/boot.js.
 * The full contract (ids, events, CSS classes, action names) is in DOM-CONTRACT.md.
 *
 * Sections: i18n helpers · events · api · store/load/refresh/polling · DOM builder ·
 * icons · prefs · log · layers (AM.sheets) · popovers/menus · tooltips · toasts ·
 * confirm/alert · shortcuts · radiogroups · clipboard/download · protocols (AM.proto) ·
 * QR (AM.qr) · categories (AM.cat) · filters · selection · Home Assistant (AM.ha) ·
 * backup helpers · actions registry.
 *
 * Rules kept here on purpose: relative URLs only (./api, ./static) for HA ingress;
 * user data only ever reaches the DOM as text (AM.h / textContent); pairing codes and
 * payloads are never logged; localStorage access is always wrapped in try/catch.
 */
(function (global) {
  "use strict";

  var doc = global.document;
  var I18N = global.AntiMatterI18n;
  var VERSION = "3.0.0";
  var V = "?v=" + VERSION;
  var ICONS_URL = "./static/brand/icons.svg" + V;
  var ASSETS = "./static/assets/";
  var SVG_NS = "http://www.w3.org/2000/svg";

  var AM = { version: VERSION, V: V, ICONS_URL: ICONS_URL, ASSETS: ASSETS };

  // =========================================================================
  // i18n helpers
  // =========================================================================
  function t(key, vars) {
    return I18N ? I18N.t(key, vars) : String(key);
  }
  AM.t = t;
  AM.fmt = I18N ? I18N.fmt : {
    date: String, dateTime: String, number: String, percent: String,
    list: function (a) { return (a || []).join(", "); }, relative: String,
    compare: function (a, b) { return String(a).localeCompare(String(b)); },
  };
  AM.compare = function (a, b) { return I18N ? I18N.compare(a, b) : String(a).localeCompare(String(b)); };
  AM.locale = function () { return I18N ? I18N.getLocale() : "en"; };
  AM.dir = function () { return I18N ? I18N.getDir() : "ltr"; };

  /**
   * Translate a template and splice DOM nodes into its placeholders (one translated
   * template, never concatenated fragments). vars: as for t() (vars.count picks the
   * plural). nodes: {placeholder: Node | string}. When nodes.count is given, vars.count
   * must be the number; its formatted text is located in the output and replaced.
   *   AM.tNodes("status.shown_of_total", {shown: 10, total: 11}, {shown: AM.h("b", null, "10")})
   */
  AM.tNodes = function (key, vars, nodes) {
    vars = Object.assign({}, vars || {});
    nodes = nodes || {};
    var marks = {};
    Object.keys(nodes).forEach(function (name, i) {
      if (name === "count" && typeof vars.count === "number") return; // located after formatting
      marks[name] = "" + i + "";
      vars[name] = marks[name];
    });
    var text = t(key, vars);
    var frag = doc.createDocumentFragment();
    var parts = [];
    var re = /(\d+)/g;
    var names = Object.keys(nodes);
    var last = 0;
    var m;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) parts.push(text.slice(last, m.index));
      parts.push({ node: nodes[names[+m[1]]] });
      last = re.lastIndex;
    }
    if (last < text.length) parts.push(text.slice(last));
    if ("count" in nodes && typeof vars.count === "number") {
      var num = AM.fmt.number(vars.count);
      for (var i = 0; i < parts.length; i++) {
        if (typeof parts[i] !== "string") continue;
        var at = parts[i].indexOf(num);
        if (at < 0) continue;
        parts.splice(i, 1, parts[i].slice(0, at), { node: nodes.count }, parts[i].slice(at + num.length));
        break;
      }
    }
    parts.forEach(function (p) {
      if (typeof p === "string") { if (p) frag.appendChild(doc.createTextNode(p)); }
      else if (p.node != null) frag.appendChild(typeof p.node === "string" ? doc.createTextNode(p.node) : p.node);
    });
    return frag;
  };

  // =========================================================================
  // Events
  // =========================================================================
  var handlers = Object.create(null);
  AM.on = function (evt, fn) {
    (handlers[evt] || (handlers[evt] = [])).push(fn);
    return function () { AM.off(evt, fn); };
  };
  AM.off = function (evt, fn) {
    var list = handlers[evt];
    if (!list) return;
    var i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  };
  AM.emit = function (evt, payload) {
    var list = (handlers[evt] || []).slice();
    for (var i = 0; i < list.length; i++) {
      try { list[i](payload); } catch (e) { console.error("[AM] '" + evt + "' handler failed", e); }
    }
  };

  // =========================================================================
  // API
  // =========================================================================
  var STATUS_CODES = { 400: "bad_request", 404: "not_found", 405: "method_not_allowed", 413: "too_large", 415: "unsupported_media_type", 422: "invalid_request" };

  function userMessage(code, detail, fallback, status) {
    if (code && I18N && I18N.has("error." + code)) {
      var ex = detail && detail.existing;
      var errKey = "error." + code;
      return t(errKey, { name: ex && ex.name != null ? String(ex.name) : "", status: String(status || "") });
    }
    if (fallback) return fallback;
    return t("error.unknown", { status: String(status || "") });
  }

  /**
   * AM.api(path, opts) -> Promise. path is relative to ./api ("/vault", "codes/1/qr.svg").
   * opts: {method, body (object -> JSON; Blob/string/FormData sent as-is), contentType,
   *        as: "json"|"text"|"blob"|"response", signal}
   * Non-2xx rejects with Error {status, code (backend error code or fallback),
   * detail, existing, userMessage (translated "error.<code>", else server message)}.
   * Network failure: code "network"; aborted fetch rethrows the AbortError.
   */
  AM.api = async function (path, opts) {
    opts = opts || {};
    var p = String(path || "");
    var url = /^\.\/api\//.test(p) ? p : "./api" + (p.charAt(0) === "/" ? p : "/" + p);
    var init = { method: opts.method || (opts.body !== undefined ? "POST" : "GET"), headers: {}, cache: "no-store", credentials: "same-origin" };
    if (opts.signal) init.signal = opts.signal;
    if (opts.body !== undefined) {
      var b = opts.body;
      var raw = typeof b === "string" || (global.Blob && b instanceof Blob) || (global.FormData && b instanceof FormData) || (global.ArrayBuffer && b instanceof ArrayBuffer);
      if (raw) {
        init.body = b;
        if (opts.contentType) init.headers["Content-Type"] = opts.contentType;
      } else {
        init.body = JSON.stringify(b);
        init.headers["Content-Type"] = "application/json";
      }
    }
    var res;
    try {
      res = await fetch(url, init);
    } catch (e) {
      if (e && e.name === "AbortError") throw e;
      var ne = new Error("network");
      ne.status = 0;
      ne.code = "network";
      ne.userMessage = t("error.network");
      throw ne;
    }
    if (!res.ok) {
      var detail = null;
      try {
        var j = await res.json();
        detail = j && j.detail !== undefined ? j.detail : j;
      } catch (e) { /* not JSON */ }
      var code = detail && typeof detail === "object" && detail.error ? String(detail.error) : STATUS_CODES[res.status] || "http_error";
      var serverMsg = detail && typeof detail === "object" ? detail.message : typeof detail === "string" ? detail : "";
      var err = new Error(serverMsg || "HTTP " + res.status);
      err.status = res.status;
      err.code = code;
      err.detail = detail;
      err.existing = detail && typeof detail === "object" && detail.existing ? detail.existing : null;
      err.userMessage = userMessage(code, detail, serverMsg, res.status);
      throw err;
    }
    if (opts.as === "response") return res;
    if (res.status === 204) return null;
    if (opts.as === "blob") return res.blob();
    if (opts.as === "text") return res.text();
    var ct = res.headers.get("content-type") || "";
    if (opts.as === "json" || ct.indexOf("json") >= 0) return res.json();
    if (ct.indexOf("svg") >= 0 || ct.indexOf("text/") === 0) return res.text();
    return res;
  };

  /**
   * AM.lookup(path) -> Promise<object|null>: cached GET for read-only enrichment lookups
   * (/matter/vendor/…, /matter/model/…, /zwave/device/…). One request per path per page,
   * shared by the detail sheet, the editor and the scanner; "not found" (204) and any
   * failure resolve to null, so callers stay silent.
   */
  var lookups = new Map();
  AM.lookup = function (path) {
    if (!lookups.has(path)) {
      lookups.set(path, AM.api(path).then(function (r) { return r && typeof r === "object" ? r : null; }, function () { return null; }));
    }
    return lookups.get(path);
  };
  /** AM.lookup.peek(path) -> the cached Promise, or null when that path was never requested. */
  AM.lookup.peek = function (path) { return lookups.get(path) || null; };

  // =========================================================================
  // Store, load, refresh, polling
  // =========================================================================
  AM.store = {
    info: null,
    vault: { meta: {}, categories: [], codes: [] },
    trash: { categories: [], codes: [] },
    haDevices: [],
    areas: [],
    backup: null,
    prefs: {},
    loaded: false,
    codeById: new Map(),
    catById: new Map(),
  };
  var lastVaultJson = "";
  var lastTrashJson = "";
  var pollTick = 0;
  var inflight = null;

  function setVault(v, force) {
    var json = JSON.stringify(v || {});
    if (!force && json === lastVaultJson) return false;
    lastVaultJson = json;
    var vault = v && typeof v === "object" ? v : {};
    vault.meta = vault.meta || {};
    vault.categories = Array.isArray(vault.categories) ? vault.categories : [];
    vault.codes = Array.isArray(vault.codes) ? vault.codes : [];
    AM.store.vault = vault;
    AM.store.codeById = new Map(vault.codes.map(function (c) { return [c.id, c]; }));
    AM.store.catById = new Map(vault.categories.map(function (c) { return [c.id, c]; }));
    if (global.AntiMatterCategoryIcons) global.AntiMatterCategoryIcons.ensureFontFor(vault.categories.map(function (c) { return c.icon; }));
    AM.selection.prune();
    AM.filters.prune();
    AM.emit("vault", vault);
    return true;
  }

  function setTrash(tr, force) {
    var json = JSON.stringify(tr || {});
    if (!force && json === lastTrashJson) return false;
    lastTrashJson = json;
    var trash = tr && typeof tr === "object" ? tr : {};
    trash.categories = Array.isArray(trash.categories) ? trash.categories : [];
    trash.codes = Array.isArray(trash.codes) ? trash.codes : [];
    AM.store.trash = trash;
    AM.emit("trash", trash);
    return true;
  }
  AM._setTrash = setTrash;

  /** Side data that is not needed for the first paint: HA devices/areas, backup settings. */
  AM.loadSide = function () {
    var p1 = Promise.all([
      AM.api("/ha/devices").catch(function () { return []; }),
      AM.api("/ha/areas").catch(function () { return []; }),
    ]).then(function (r) {
      AM.store.haDevices = Array.isArray(r[0]) ? r[0] : [];
      AM.store.areas = Array.isArray(r[1]) ? r[1] : [];
      AM.emit("ha", { devices: AM.store.haDevices, areas: AM.store.areas });
    });
    var p2 = AM.backup.reload().catch(function () {});
    return Promise.all([p1, p2]);
  };

  /** First load: vault + trash (both emitted even if unchanged), then side data. Rejects on failure. */
  AM.load = async function () {
    var r = await Promise.all([AM.api("/vault"), AM.api("/trash").catch(function () { return null; })]);
    AM.store.loaded = true;
    doc.documentElement.classList.add("am-loaded");
    setVault(r[0], true);
    if (r[1]) setTrash(r[1], true);
    AM.loadSide();
    AM._resolveLoaded(AM.store.vault);
    return AM.store.vault;
  };

  /**
   * AM.refresh({force, trash}) -> Promise<boolean changed>.
   * Without force it is the polling tick: skipped while the tab is hidden, while any
   * sheet/dialog/scanner is open, or before the first load; trash is re-read every 5th tick.
   * Call AM.refresh({force: true}) after every mutation (it also re-reads the trash);
   * it rejects on failure so callers can report it.
   */
  AM.refresh = async function (opts) {
    opts = opts || {};
    if (!opts.force && (doc.hidden || AM.sheets.anyOpen() || !AM.store.loaded)) return false;
    if (inflight) {
      if (!opts.force) return inflight.catch(function () { return false; });
      await inflight.catch(function () {});
    }
    var withTrash = !!(opts.force || opts.trash || ++pollTick % 5 === 0);
    inflight = (async function () {
      var r = await Promise.all([AM.api("/vault"), withTrash ? AM.api("/trash").catch(function () { return null; }) : null]);
      if (!AM.store.loaded) { AM.store.loaded = true; doc.documentElement.classList.add("am-loaded"); }
      var changed = setVault(r[0], false);
      if (r[1]) setTrash(r[1], false);
      return changed;
    })();
    try {
      return await inflight;
    } catch (e) {
      if (opts.force) throw e;
      return false;
    } finally {
      inflight = null;
    }
  };

  var pollTimer = null;
  AM.startPolling = function () {
    if (pollTimer) return;
    pollTimer = global.setInterval(function () { AM.refresh(); }, 6000);
    doc.addEventListener("visibilitychange", function () { if (!doc.hidden) AM.refresh({ trash: true }); });
    global.addEventListener("focus", function () { AM.refresh({ trash: true }); });
  };

  // =========================================================================
  // DOM builder
  // =========================================================================
  var SVG_TAGS = { svg: 1, use: 1, path: 1, rect: 1, circle: 1, ellipse: 1, g: 1, line: 1, polyline: 1, polygon: 1, defs: 1, symbol: 1, clipPath: 1, mask: 1, text: 1, tspan: 1 };

  function setAttr(el, k, v) {
    if (v == null || v === false) return;
    if (k === "class" || k === "className") {
      var cls = Array.isArray(v) ? v.filter(Boolean).join(" ") : String(v);
      if (cls) el.setAttribute("class", cls);
    } else if (k === "style") {
      if (typeof v === "string") el.setAttribute("style", v);
      else Object.keys(v).forEach(function (p) {
        if (v[p] == null || v[p] === false) return;
        if (p.indexOf("--") === 0 || p.indexOf("-") > 0) el.style.setProperty(p, String(v[p]));
        else el.style[p] = v[p];
      });
    } else if (k === "text") {
      el.textContent = String(v);
    } else if (k === "dataset") {
      Object.keys(v).forEach(function (d) { if (v[d] != null) el.dataset[d] = String(v[d]); });
    } else if (k === "props") {
      Object.assign(el, v);
    } else if (k === "i18n") {
      el.setAttribute("data-i18n", v);
      el.textContent = t(v);
    } else if (k === "tip") {
      el.setAttribute("data-tip", String(v));
      if (!el.hasAttribute("aria-label")) el.setAttribute("aria-label", String(v));
    } else if (k === "kbd") {
      el.setAttribute("data-kbd", String(v));
    } else if (k.slice(0, 2) === "on" && typeof v === "function") {
      el.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (v === true) {
      el.setAttribute(k, "");
    } else {
      el.setAttribute(k, String(v));
    }
  }

  function append(el, kids) {
    for (var i = 0; i < kids.length; i++) {
      var c = kids[i];
      if (c == null || c === false || c === true) continue;
      if (Array.isArray(c)) append(el, c);
      else if (c.nodeType) el.appendChild(c);
      else el.appendChild(doc.createTextNode(String(c)));
    }
  }

  /**
   * AM.h(tag, attrs?, ...children) -> Element. Children: Node | string | number | array | null.
   * Strings always become text nodes (never HTML). attrs: class (string|array), style
   * (string|object, "--vars" ok), text, dataset, props, i18n (static key), tip (sets
   * data-tip + aria-label), kbd, on<Event>: fn, booleans (true -> "", false/null -> omitted).
   * SVG tags (svg, use, path, rect, circle, g, …) are created in the SVG namespace.
   */
  AM.h = function (tag, attrs) {
    var kids = Array.prototype.slice.call(arguments, 2);
    var el = SVG_TAGS[tag] ? doc.createElementNS(SVG_NS, tag) : doc.createElement(tag);
    if (attrs != null && (attrs.nodeType || typeof attrs !== "object" || Array.isArray(attrs))) {
      kids.unshift(attrs);
      attrs = null;
    }
    if (attrs) Object.keys(attrs).forEach(function (k) { setAttr(el, k, attrs[k]); });
    append(el, kids);
    return el;
  };
  AM.frag = function () {
    var f = doc.createDocumentFragment();
    append(f, Array.prototype.slice.call(arguments));
    return f;
  };
  AM.esc = function (s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  };
  AM.$ = function (sel, root) { return (root || doc).querySelector(sel); };
  AM.$$ = function (sel, root) { return Array.prototype.slice.call((root || doc).querySelectorAll(sel)); };
  AM.byId = function (id) { return doc.getElementById(id); };
  /** Replace an element's children (keeps the element, its listeners and attributes). */
  AM.fill = function (el) {
    if (!el) return el;
    el.textContent = "";
    append(el, Array.prototype.slice.call(arguments, 1));
    return el;
  };
  AM.debounce = function (fn, ms) {
    var timer = null;
    return function () {
      var args = arguments, self = this;
      clearTimeout(timer);
      timer = setTimeout(function () { fn.apply(self, args); }, ms);
    };
  };
  AM.isTyping = function (target) {
    var el = target || doc.activeElement;
    if (!el || el === doc.body) return false;
    if (el.isContentEditable) return true;
    var tag = el.tagName;
    if (tag === "TEXTAREA" || tag === "SELECT") return true;
    if (tag !== "INPUT") return false;
    var type = (el.type || "text").toLowerCase();
    return ["checkbox", "radio", "button", "submit", "reset", "range", "color", "file"].indexOf(type) === -1;
  };
  AM.mq = {
    phone: global.matchMedia("(max-width: 720px)"),
    tabletDown: global.matchMedia("(max-width: 1023px)"),
    coarse: global.matchMedia("(pointer: coarse)"),
    hover: global.matchMedia("(hover: hover) and (pointer: fine)"),
    reducedMotion: global.matchMedia("(prefers-reduced-motion: reduce)"),
  };

  // =========================================================================
  // Icons
  // =========================================================================
  /** AM.icon("scan-line", "icon--sm icon--flip-rtl") -> <svg class="icon …"><use href="…icons.svg?v#i-scan-line"></svg> */
  AM.icon = function (name, cls) {
    var svg = doc.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", "icon" + (cls ? " " + cls : ""));
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    var use = doc.createElementNS(SVG_NS, "use");
    use.setAttribute("href", ICONS_URL + "#i-" + name);
    svg.appendChild(use);
    return svg;
  };

  // =========================================================================
  // Preferences (per browser, survive blocked storage)
  // =========================================================================
  function lsGet(k) { try { return global.localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) {
    try {
      if (v == null) global.localStorage.removeItem(k);
      else global.localStorage.setItem(k, v);
    } catch (e) { /* storage blocked: value lives in memory for this page */ }
  }
  var bool01 = {
    parse: function (v) { return v === "1" ? true : v === "0" ? false : null; },
    ser: function (b) { return b ? "1" : "0"; },
  };
  var PREFS = {
    view: {
      key: "antimatter-view", def: "cards",
      parse: function (v) { return v === "cards" || v === "labels" || v === "table" ? v : null; },
      legacy: ["antimatter-view-mode", function (v) { return v === "table" ? "table" : v === "grid" ? "cards" : null; }],
    },
    zoom: {
      key: "antimatter-grid-zoom", def: 100,
      parse: function (v) { var n = parseInt(v, 10); return n >= 50 && n <= 150 && n % 10 === 0 ? n : null; },
      ser: function (n) { return String(n); },
    },
    invert: { key: "antimatter-qr-invert", def: false, parse: bool01.parse, ser: bool01.ser },
    batch: { key: "antimatter-scan-batch", def: true, parse: bool01.parse, ser: bool01.ser },
    labelNames: { key: "antimatter-labels-names", def: true, parse: bool01.parse, ser: bool01.ser },
    labelCodes: { key: "antimatter-labels-codes", def: true, parse: bool01.parse, ser: bool01.ser },
  };
  var prefMem = {};
  function prefSpec(name) {
    return PREFS[name] || {
      key: "antimatter-pref-" + name, def: null,
      parse: function (v) { try { return v == null ? null : JSON.parse(v); } catch (e) { return null; } },
      ser: function (x) { return JSON.stringify(x); },
    };
  }
  AM.prefs = {
    /** AM.prefs.get(name, fallback?) — known names: view, zoom, invert, batch, labelNames, labelCodes. */
    get: function (name, fallback) {
      if (Object.prototype.hasOwnProperty.call(prefMem, name)) return prefMem[name];
      var s = prefSpec(name);
      var v = s.parse(lsGet(s.key));
      if (v == null && s.legacy) v = s.legacy[1](lsGet(s.legacy[0]));
      if (v == null) v = fallback !== undefined ? fallback : s.def;
      prefMem[name] = v;
      return v;
    },
    /** AM.prefs.set(name, value): persists, applies (invert), logs (view, invert), emits "prefs" {name, value}. */
    set: function (name, value) {
      var s = prefSpec(name);
      var old = AM.prefs.get(name);
      prefMem[name] = value;
      AM.store.prefs[name] = value;
      lsSet(s.key, value == null ? null : (s.ser ? s.ser(value) : String(value)));
      if (name === "invert") applyInvert(value);
      if (old === value) return value;
      if (name === "view") AM.log("View mode: " + value);
      if (name === "invert") AM.log("QR invert: " + (value ? "on" : "off"));
      AM.emit("prefs", { name: name, value: value });
      return value;
    },
  };
  function applyInvert(on) {
    if (on) doc.documentElement.setAttribute("data-qr-invert", "true");
    else doc.documentElement.removeAttribute("data-qr-invert");
  }
  ["view", "zoom", "invert", "batch"].forEach(function (n) { AM.store.prefs[n] = AM.prefs.get(n); });
  applyInvert(AM.store.prefs.invert);
  AM.setInvert = function (on) { return AM.prefs.set("invert", !!on); };

  // =========================================================================
  // Add-on log (never pass pairing codes or payloads)
  // =========================================================================
  AM.log = function (message, level) {
    try {
      fetch("./api/log", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: String(message).slice(0, 500), level: level || "info" }),
        keepalive: true,
        credentials: "same-origin",
      }).catch(function () {});
    } catch (e) { /* ignore */ }
  };
  global.logEvent = AM.log; // legacy global some brand scripts probe

  // =========================================================================
  // Layers: sheets, dialogs, present, scanner (AM.sheets)
  // =========================================================================
  var stack = []; // [{id, el, opts, scrim, returnFocus, pushed, hideTimer}]
  var appRoot = null;
  var ignorePops = 0;
  var FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), summary';

  function isVisible(el) {
    return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length) && getComputedStyle(el).visibility !== "hidden";
  }
  function focusables(root) {
    return Array.prototype.slice.call(root.querySelectorAll(FOCUSABLE)).filter(function (el) {
      return !el.closest("[hidden], [inert]") && isVisible(el);
    });
  }
  AM.focusables = focusables;

  function recOf(id) {
    for (var i = 0; i < stack.length; i++) if (stack[i].id === id) return stack[i];
    return null;
  }

  function updateLayers() {
    if (!appRoot) appRoot = doc.getElementById("app");
    var open = stack.length > 0;
    if (appRoot) appRoot.inert = open;
    doc.documentElement.classList.toggle("am-locked", open);
    stack.forEach(function (rec, i) {
      var z = 70 + i * 2;
      rec.el.style.zIndex = String(z + 1);
      if (rec.scrim) rec.scrim.style.zIndex = String(z);
      rec.el.inert = i !== stack.length - 1;
    });
    AM.emit("layers", { open: stack.map(function (r) { return r.id; }) });
  }

  function initialFocus(rec) {
    var el = rec.el;
    var want = rec.opts.initialFocus;
    var target = null;
    if (want && want.nodeType) target = want;
    else if (typeof want === "string") target = el.querySelector(want);
    if (!target) target = el.querySelector("[data-autofocus]");
    if (target && !target.closest("[hidden]")) { target.focus({ preventScroll: true }); return; }
    if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "-1");
    el.focus({ preventScroll: true });
  }

  function historyEnabled() {
    return AM.mq.coarse.matches || AM.mq.phone.matches;
  }

  /**
   * AM.sheets.open(id, opts) -> boolean. Shows a layer shell (any element in #layers with
   * the given id). Single-open guard: opening an already open layer only refocuses it.
   * opts: {onClose(result, reason), beforeClose(reason) -> false|Promise<boolean> (veto),
   *        initialFocus (element|selector; default [data-autofocus] or the layer itself),
   *        returnFocus (element; default the element focused before opening),
   *        escape: false (Esc does nothing), history: false (no back-button entry)}
   * Reasons: "close" ([data-close] button), "escape", "scrim", "back", "swipe", "api".
   */
  AM.sheets = {
    open: function (id, opts) {
      var el = typeof id === "string" ? doc.getElementById(id) : id;
      if (!el) { console.warn("[AM] no layer #" + id); return false; }
      id = el.id;
      var existing = recOf(id);
      if (existing) {
        if (stack[stack.length - 1] === existing) initialFocus(existing);
        return true;
      }
      closePopover(false);
      hideTip();
      var rec = { id: id, el: el, opts: opts || {}, returnFocus: (opts && opts.returnFocus) || doc.activeElement };
      if (el._amHideTimer) { clearTimeout(el._amHideTimer); el._amHideTimer = null; }
      if (el._amScrim) { el._amScrim.remove(); el._amScrim = null; }
      if (el.getAttribute("data-scrim") !== "none") {
        rec.scrim = AM.h("div", { class: "scrim", "aria-hidden": "true" });
        rec.scrim.addEventListener("click", function () { AM.sheets.requestClose(id, "scrim"); });
        el.parentNode.insertBefore(rec.scrim, el);
      }
      stack.push(rec);
      el.classList.add("layer");
      el.hidden = false;
      void el.offsetWidth; // start the enter transition from the closed state
      el.classList.add("is-open");
      if (rec.scrim) rec.scrim.classList.add("is-open");
      updateLayers();
      initialFocus(rec);
      if (rec.opts.history !== false && historyEnabled()) {
        try { global.history.pushState({ amLayer: id }, ""); rec.pushed = true; } catch (e) { /* ignore */ }
      }
      return true;
    },
    /** Close now (no veto). result is passed to onClose. */
    close: function (id, result, reason) {
      var rec = recOf(typeof id === "string" ? id : id && id.id);
      if (!rec) return false;
      var el = rec.el;
      stack.splice(stack.indexOf(rec), 1);
      el.classList.remove("is-open");
      var scrim = rec.scrim;
      if (scrim) scrim.classList.remove("is-open");
      el._amScrim = scrim || null;
      el._amHideTimer = setTimeout(function () {
        el._amHideTimer = null;
        if (!recOf(el.id)) {
          el.hidden = true;
          el.style.transform = "";
        }
        if (scrim) scrim.remove();
        el._amScrim = null;
      }, AM.mq.reducedMotion.matches ? 0 : 340);
      updateLayers();
      if (rec.pushed && reason !== "back") {
        try {
          if (global.history.state && global.history.state.amLayer === rec.id) { ignorePops++; global.history.back(); }
        } catch (e) { /* ignore */ }
      }
      var rf = rec.returnFocus;
      var top = stack[stack.length - 1];
      if (rf && rf.isConnected && !rf.closest("[hidden]") && (!top || top.el.contains(rf))) {
        try { rf.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
      } else if (top) {
        initialFocus(top);
      }
      try { if (rec.opts.onClose) rec.opts.onClose(result, reason || "api"); } catch (e) { console.error(e); }
      if (!stack.length) setTimeout(function () { AM.refresh({ trash: true }); }, 0);
      return true;
    },
    /** Close through the layer's beforeClose veto (what ✕, Esc, scrim, back and swipe use). */
    requestClose: async function (id, reason) {
      var rec = recOf(id);
      if (!rec) return false;
      if (rec.opts.beforeClose) {
        var ok;
        try { ok = await rec.opts.beforeClose(reason || "api"); } catch (e) { ok = true; }
        if (ok === false) {
          if (reason === "back" && rec.pushed) {
            try { global.history.pushState({ amLayer: rec.id }, ""); } catch (e) { /* ignore */ }
          }
          return false;
        }
      }
      return AM.sheets.close(rec.id, undefined, reason);
    },
    isOpen: function (id) { return !!recOf(id); },
    anyOpen: function () { return stack.length > 0; },
    top: function () { return stack.length ? stack[stack.length - 1].id : null; },
    stack: function () { return stack.map(function (r) { return r.id; }); },
    /** Update options of an open layer (e.g. set beforeClose once a form becomes dirty). */
    update: function (id, opts) {
      var rec = recOf(id);
      if (rec) Object.assign(rec.opts, opts || {});
    },
  };

  global.addEventListener("popstate", function () {
    if (ignorePops > 0) { ignorePops--; return; }
    var top = stack[stack.length - 1];
    if (top && top.pushed) {
      var st = global.history.state;
      if (!st || st.amLayer !== top.id) AM.sheets.requestClose(top.id, "back");
    }
  });

  // [data-close] inside a layer closes that layer (through the veto); inside a popover, the popover.
  doc.addEventListener("click", function (e) {
    var btn = e.target.closest && e.target.closest("[data-close]");
    if (!btn) return;
    var pop = btn.closest(".pop");
    if (pop && openPop && openPop.el === pop) { closePopover(true); return; }
    var layer = btn.closest(".layer");
    if (layer && recOf(layer.id)) {
      e.preventDefault();
      AM.sheets.requestClose(layer.id, "close");
    }
  });

  // Focus trap for the top layer (popovers, toasts and the tooltip live outside it).
  doc.addEventListener("keydown", function (e) {
    if (e.key !== "Tab" || !stack.length || (openPop && openPop.el.contains(e.target))) return;
    var top = stack[stack.length - 1].el;
    if (e.target.closest && e.target.closest("#toasts")) return;
    var list = focusables(top);
    if (!list.length) { e.preventDefault(); top.focus(); return; }
    var first = list[0], last = list[list.length - 1];
    if (e.shiftKey && (e.target === first || e.target === top)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && e.target === last) { e.preventDefault(); first.focus(); }
  });
  doc.addEventListener("focusin", function (e) {
    if (!stack.length) return;
    var top = stack[stack.length - 1].el;
    var tgt = e.target;
    if (top.contains(tgt) || (tgt.closest && tgt.closest("#popovers, #toasts, .pop"))) return;
    var list = focusables(top);
    (list[0] || top).focus({ preventScroll: true });
  });

  // Swipe down on the grabber/header closes bottom sheets on phones.
  (function swipe() {
    var st = null;
    doc.addEventListener("pointerdown", function (e) {
      if (!stack.length || !AM.mq.phone.matches || e.button > 0) return;
      var rec = stack[stack.length - 1];
      if (rec.el.getAttribute("data-swipe") === "none") return;
      var handle = e.target.closest && e.target.closest(".sheet__grabber, .sheet__head");
      if (!handle || !rec.el.contains(handle) || e.target.closest("button, a, input, select, textarea, [role=button]")) return;
      if (rec.el.querySelector(".sheet__grabber") && !isVisible(rec.el.querySelector(".sheet__grabber"))) return;
      st = { rec: rec, y: e.clientY, t: Date.now(), dy: 0, id: e.pointerId };
    });
    doc.addEventListener("pointermove", function (e) {
      if (!st || e.pointerId !== st.id) return;
      st.dy = Math.max(0, e.clientY - st.y);
      if (st.dy > 4) {
        st.rec.el.style.transition = "none";
        st.rec.el.style.transform = "translateY(" + st.dy + "px)";
      }
    });
    function end(e) {
      if (!st || (e && e.pointerId !== st.id)) return;
      var s = st;
      st = null;
      s.rec.el.style.transition = "";
      var fast = s.dy > 40 && Date.now() - s.t < 250;
      if (s.dy > 110 || fast) {
        AM.sheets.requestClose(s.rec.id, "swipe").then(function (closed) { if (!closed) s.rec.el.style.transform = ""; });
      } else {
        s.rec.el.style.transform = "";
      }
    }
    doc.addEventListener("pointerup", end);
    doc.addEventListener("pointercancel", end);
  })();

  // =========================================================================
  // Popovers & menus (one open at a time)
  // =========================================================================
  var openPop = null; // {el, anchor, opts, temp}
  var popRoot = null;

  function popContainer() {
    if (!popRoot) popRoot = doc.getElementById("popovers") || doc.body;
    return popRoot;
  }

  function position(el, anchor, placement) {
    var vw = doc.documentElement.clientWidth, vh = global.innerHeight;
    var r;
    if (anchor && anchor.getBoundingClientRect) r = anchor.getBoundingClientRect();
    else if (anchor && typeof anchor.x === "number") r = { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y, width: 0, height: 0 };
    else r = { left: vw / 2, right: vw / 2, top: vh / 3, bottom: vh / 3, width: 0, height: 0 };
    el.style.maxBlockSize = "";
    var w = el.offsetWidth, hgt = el.offsetHeight;
    var rtl = AM.dir() === "rtl";
    var alignEnd = (placement || "bottom-end").indexOf("end") > 0;
    var endSide = rtl ? !alignEnd : alignEnd; // physical: true = align to anchor's right edge
    var left = endSide ? r.right - w : r.left;
    if (r.width === 0 && anchor && typeof anchor.x === "number") left = rtl ? r.left - w : r.left;
    left = Math.max(8, Math.min(left, vw - w - 8));
    var gap = 6;
    var below = r.bottom + gap;
    var above = r.top - gap - hgt;
    var top;
    var wantTop = (placement || "").indexOf("top") === 0;
    if (wantTop ? above >= 8 : below + hgt > vh - 8 && above >= 8) top = above;
    else top = below;
    if (top + hgt > vh - 8) {
      var room = Math.max(vh - top - 8, r.top - gap - 8);
      if (room === r.top - gap - 8 && room > vh - below - 8) { el.style.maxBlockSize = room + "px"; top = 8; }
      else { el.style.maxBlockSize = Math.max(160, vh - below - 8) + "px"; top = below; }
      top = Math.max(8, Math.min(top, vh - Math.min(hgt, parseFloat(el.style.maxBlockSize) || hgt) - 8));
    }
    el.style.left = Math.round(left) + "px";
    el.style.top = Math.round(Math.max(8, top)) + "px";
    el.style.transformOrigin = (top < r.top ? "bottom " : "top ") + (endSide ? "right" : "left");
  }

  function menuItems(el) {
    return Array.prototype.slice.call(el.querySelectorAll('[role^="menuitem"]')).filter(function (i) {
      return !i.disabled && !i.closest("[hidden]") && isVisible(i);
    });
  }

  function onPopKey(e) {
    if (!openPop) return;
    var el = openPop.el;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closePopover(true);
      return;
    }
    if (e.key === "Tab" && el.getAttribute("role") === "menu") { closePopover(true); return; }
    var items = menuItems(el);
    if (!items.length) return;
    var i = items.indexOf(doc.activeElement);
    var inField = AM.isTyping(e.target);
    var next = null;
    if (e.key === "ArrowDown") next = items[i < 0 ? 0 : (i + 1) % items.length];
    else if (e.key === "ArrowUp") next = items[i <= 0 ? items.length - 1 : i - 1];
    else if ((e.key === "Home" || e.key === "End") && !inField) next = e.key === "Home" ? items[0] : items[items.length - 1];
    else if (!inField && e.key.length === 1 && /\S/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
      var ch = e.key.toLocaleLowerCase();
      for (var k = 1; k <= items.length; k++) {
        var cand = items[(Math.max(i, 0) + k) % items.length];
        if ((cand.textContent || "").trim().toLocaleLowerCase().indexOf(ch) === 0) { next = cand; break; }
      }
    }
    if (next) { e.preventDefault(); next.focus(); }
  }

  function onPopPointer(e) {
    if (!openPop) return;
    if (openPop.el.contains(e.target)) return;
    if (openPop.anchor && openPop.anchor.contains && openPop.anchor.contains(e.target)) return;
    closePopover(false);
  }
  function onPopFocus(e) {
    if (!openPop) return;
    var tgt = e.target;
    if (openPop.el.contains(tgt) || (openPop.anchor && openPop.anchor.contains && openPop.anchor.contains(tgt))) return;
    if (tgt.closest && tgt.closest("#toasts")) return;
    closePopover(false);
  }
  function onPopReflow() {
    if (openPop && openPop.anchor && openPop.anchor.getBoundingClientRect) position(openPop.el, openPop.anchor, openPop.opts.placement);
  }

  function closePopover(returnFocus) {
    if (!openPop) return;
    var p = openPop;
    openPop = null;
    p.el.classList.remove("is-open");
    p.el.hidden = true;
    if (p.anchor && p.anchor.setAttribute) p.anchor.setAttribute("aria-expanded", "false");
    doc.removeEventListener("pointerdown", onPopPointer, true);
    doc.removeEventListener("focusin", onPopFocus);
    p.el.removeEventListener("keydown", onPopKey);
    global.removeEventListener("resize", onPopReflow);
    global.removeEventListener("scroll", onPopReflow, true);
    if (p.temp) p.el.remove();
    if (returnFocus && p.anchor && p.anchor.focus && p.anchor.isConnected) p.anchor.focus({ preventScroll: true });
    try { if (p.opts.onClose) p.opts.onClose(); } catch (e) { console.error(e); }
  }

  /**
   * AM.popover.open(el, anchor, opts): shows el (a .menu/.popover element, usually hidden in
   * #popovers) as a fixed, edge-aware popover next to anchor (element, or {x, y} for a
   * context menu). Only one is open at a time; outside click, Esc, Tab (menus) and focus
   * leaving close it. Menus (role=menu) get ↑/↓/Home/End/type-ahead roving focus.
   * opts: {placement: "bottom-end"(default)|"bottom-start"|"top-start"|"top-end",
   *        focus: element|selector|false, onClose(), temp (remove el on close)}
   */
  AM.popover = {
    open: function (el, anchor, opts) {
      opts = opts || {};
      if (openPop && openPop.el === el) return;
      closePopover(false);
      hideTip();
      if (!el.parentNode) popContainer().appendChild(el);
      el.classList.add("pop");
      el.hidden = false;
      var topRec = stack[stack.length - 1];
      el.style.zIndex = String(topRec ? (parseInt(topRec.el.style.zIndex, 10) || 70) + 2 : 60);
      openPop = { el: el, anchor: anchor, opts: opts, temp: !!opts.temp };
      position(el, anchor, opts.placement);
      void el.offsetWidth;
      el.classList.add("is-open");
      if (anchor && anchor.setAttribute) anchor.setAttribute("aria-expanded", "true");
      doc.addEventListener("pointerdown", onPopPointer, true);
      doc.addEventListener("focusin", onPopFocus);
      el.addEventListener("keydown", onPopKey);
      global.addEventListener("resize", onPopReflow);
      global.addEventListener("scroll", onPopReflow, true);
      if (opts.focus !== false) {
        var f = opts.focus && opts.focus.nodeType ? opts.focus : typeof opts.focus === "string" ? el.querySelector(opts.focus) : null;
        if (!f) f = el.querySelector('[aria-checked="true"][role^="menuitem"]') || menuItems(el)[0] || focusables(el)[0];
        if (f) f.focus({ preventScroll: true });
        else { el.setAttribute("tabindex", "-1"); el.focus({ preventScroll: true }); }
      }
    },
    toggle: function (el, anchor, opts) {
      if (openPop && openPop.el === el) closePopover(true);
      else AM.popover.open(el, anchor, opts);
    },
    close: function (returnFocus) { closePopover(returnFocus !== false); },
    isOpen: function (el) { return !!openPop && (!el || openPop.el === el); },
    reposition: onPopReflow,
  };

  /**
   * AM.menu.show(anchor | {x, y}, items, opts) builds a temporary role=menu popover.
   * items: [{icon, label, run(), kbd: "E" | ["⇧","D"], danger, disabled, checked (true/false
   *          -> menuitemradio), sub (second line), lang, dir}, {sep: true}, {heading: "text"}]
   * opts: {label (aria-label), placement, className, onClose}. Returns the menu element.
   * Selecting an item closes the menu (focus back to the anchor) and then calls run().
   */
  AM.menu = {
    build: function (items, opts) {
      opts = opts || {};
      var menu = AM.h("div", { class: ["menu", opts.className], role: "menu", "aria-label": opts.label || null, hidden: true });
      (items || []).forEach(function (it) {
        if (!it) return;
        if (it.sep) { menu.appendChild(AM.h("div", { class: "menu__sep", role: "separator" })); return; }
        if (it.heading) { menu.appendChild(AM.h("div", { class: "menu__label overline", role: "presentation" }, it.heading)); return; }
        var radio = typeof it.checked === "boolean";
        var kbd = it.kbd == null ? [] : Array.isArray(it.kbd) ? it.kbd : [it.kbd];
        var btn = AM.h("button", {
          type: "button",
          class: ["menu__item", it.danger && "menu__item--danger", it.className],
          role: radio ? "menuitemradio" : "menuitem",
          "aria-checked": radio ? String(it.checked) : null,
          disabled: !!it.disabled,
          tabindex: "-1",
        },
          it.icon ? AM.icon(it.icon) : null,
          it.sub ? AM.h("span", { class: "menu__sub" }, AM.h("span", { class: "menu__main", lang: it.lang || null, dir: it.dir || null }, it.label), AM.h("span", null, it.sub))
            : AM.h("span", { class: "menu__text", lang: it.lang || null, dir: it.dir || null }, it.label),
          kbd.length ? AM.h("span", { class: "menu__end" }, kbd.map(function (k) { return AM.h("span", { class: "kbd" }, k); })) : null,
          radio ? AM.icon("check", "menu__check") : null
        );
        btn.addEventListener("click", function () {
          closePopover(true);
          if (typeof it.run === "function") it.run();
        });
        menu.appendChild(btn);
      });
      return menu;
    },
    show: function (anchor, items, opts) {
      opts = opts || {};
      var menu = AM.menu.build(items, opts);
      popContainer().appendChild(menu);
      AM.popover.open(menu, anchor, { placement: opts.placement, temp: true, onClose: opts.onClose });
      return menu;
    },
  };

  // =========================================================================
  // Tooltips: any element with data-tip (data-i18n-tip sets it + aria-label).
  // Hover (fine pointer) and :focus-visible, 500 ms delay, never on touch.
  // Optional data-kbd="S" adds a key hint.
  // =========================================================================
  var tipEl = null, tipTimer = null, tipFor = null;
  function hideTip() {
    clearTimeout(tipTimer);
    tipTimer = null;
    tipFor = null;
    if (tipEl) { tipEl.hidden = true; tipEl.classList.remove("is-open"); }
  }
  function showTip(target) {
    var text = target.getAttribute("data-tip");
    if (!text || !target.isConnected || target.closest("[hidden]")) return;
    if (!tipEl) {
      tipEl = AM.h("div", { class: "tooltip", role: "tooltip", id: "am-tooltip", hidden: true });
      doc.body.appendChild(tipEl);
    }
    var kbd = target.getAttribute("data-kbd");
    AM.fill(tipEl, AM.h("span", null, text), kbd ? AM.h("span", { class: "kbd" }, kbd) : null);
    tipEl.hidden = false;
    tipEl.style.position = "fixed";
    var r = target.getBoundingClientRect();
    var w = tipEl.offsetWidth, hh = tipEl.offsetHeight;
    var vw = doc.documentElement.clientWidth;
    var left = Math.max(6, Math.min(r.left + r.width / 2 - w / 2, vw - w - 6));
    var top = r.top - hh - 8;
    if (top < 6) top = r.bottom + 8;
    tipEl.style.left = Math.round(left) + "px";
    tipEl.style.top = Math.round(top) + "px";
    tipEl.classList.add("is-open");
  }
  function scheduleTip(target) {
    if (tipFor === target) return;
    hideTip();
    tipFor = target;
    tipTimer = setTimeout(function () { if (tipFor === target) showTip(target); }, 500);
  }
  doc.addEventListener("pointerover", function (e) {
    if (e.pointerType === "touch" || !AM.mq.hover.matches) return;
    var target = e.target.closest && e.target.closest("[data-tip]");
    if (!target) { if (tipFor && !tipFor.contains(e.target)) hideTip(); return; }
    if (openPop && openPop.anchor === target) return;
    scheduleTip(target);
  });
  doc.addEventListener("pointerout", function (e) {
    if (tipFor && (!e.relatedTarget || !tipFor.contains(e.relatedTarget))) hideTip();
  });
  doc.addEventListener("focusin", function (e) {
    var target = e.target.closest && e.target.closest("[data-tip]");
    if (!target || target !== e.target) return;
    var fv = false;
    try { fv = target.matches(":focus-visible"); } catch (err) { fv = false; }
    if (fv && !AM.mq.coarse.matches) scheduleTip(target);
  });
  doc.addEventListener("focusout", function (e) { if (tipFor && tipFor === e.target) hideTip(); });
  doc.addEventListener("pointerdown", hideTip, true);
  doc.addEventListener("scroll", hideTip, true);
  AM.hideTooltip = hideTip;

  // =========================================================================
  // Toasts
  // =========================================================================
  var TONE_ICON = { ok: "circle-check", info: "info", warn: "triangle-alert", danger: "circle-x" };
  /**
   * AM.toast({message, tone: "ok"|"info"|"warn"|"danger", icon, action: {label, run},
   *           timeout (ms, default 6000; 0 = sticky)}) -> {dismiss(), el}
   * message: string or Node. Pauses while hovered/focused. Max 3 visible.
   */
  AM.toast = function (o) {
    if (typeof o === "string") o = { message: o };
    o = o || {};
    var region = doc.getElementById("toasts") || doc.body;
    var tone = o.tone || "ok";
    var timer = null;
    var left = o.timeout == null ? 6000 : o.timeout;
    var started = 0;
    var gone = false;
    var el = AM.h("div", { class: ["toast", tone !== "ok" && "toast--" + tone], role: tone === "danger" ? "alert" : "status" },
      AM.icon(o.icon || TONE_ICON[tone] || TONE_ICON.ok),
      AM.h("span", { class: "toast__msg" }, o.message)
    );
    function dismiss() {
      if (gone) return;
      gone = true;
      clearTimeout(timer);
      el.classList.remove("is-open");
      setTimeout(function () { el.remove(); }, AM.mq.reducedMotion.matches ? 0 : 220);
    }
    function arm() { if (left > 0 && !gone) { started = Date.now(); timer = setTimeout(dismiss, left); } }
    function pause() { if (timer) { clearTimeout(timer); timer = null; left = Math.max(1500, left - (Date.now() - started)); } }
    if (o.action && o.action.label) {
      el.appendChild(AM.h("button", { type: "button", class: "toast__action", onclick: function () { dismiss(); try { o.action.run(); } catch (e) { console.error(e); } } }, o.action.label));
    }
    el.appendChild(AM.h("button", { type: "button", class: "icon-btn icon-btn--xs", "aria-label": t("action.dismiss"), onclick: dismiss }, AM.icon("x")));
    el.addEventListener("pointerenter", pause);
    el.addEventListener("pointerleave", function () { if (!el.contains(doc.activeElement)) arm(); });
    el.addEventListener("focusin", pause);
    el.addEventListener("focusout", function (e) { if (!el.contains(e.relatedTarget)) arm(); });
    var old = region.querySelectorAll(".toast");
    for (var i = 0; i <= old.length - 3; i++) old[i].remove();
    region.appendChild(el);
    void el.offsetWidth;
    el.classList.add("is-open");
    arm();
    return { dismiss: dismiss, el: el };
  };

  // =========================================================================
  // Confirm & alert (the #dialog-confirm shell)
  // =========================================================================
  var confirmChain = Promise.resolve();
  function runConfirm(o, isAlert) {
    return new Promise(function (resolve) {
      var dlg = doc.getElementById("dialog-confirm");
      if (!dlg) { resolve(isAlert ? undefined : false); return; }
      var tone = o.tone || (isAlert ? "info" : o.danger === false ? "accent" : "danger");
      var iconName = o.icon || { danger: "trash-2", warn: "triangle-alert", info: "info", error: "circle-alert", ok: "circle-check", accent: "circle-help" }[tone] || "info";
      var iconBox = doc.getElementById("confirm-icon");
      iconBox.className = "confirm__icon confirm__icon--" + tone;
      AM.fill(iconBox, AM.icon(iconName));
      var titleKey = "alert.title_" + ({ error: "error", ok: "ok", warn: "warn" }[tone] || "info");
      var title = o.title || (isAlert ? t(titleKey) : t("confirm.title"));
      doc.getElementById("confirm-title").textContent = title;
      var msg = doc.getElementById("confirm-msg");
      if (o.message && o.message.nodeType) AM.fill(msg, o.message);
      else msg.textContent = o.message == null ? "" : String(o.message);
      msg.hidden = !msg.textContent && !msg.firstChild;
      var ok = doc.getElementById("confirm-ok");
      var cancel = doc.getElementById("confirm-cancel");
      var danger = !isAlert && tone === "danger";
      ok.className = "btn " + (danger ? "btn--danger" : "btn--primary");
      AM.fill(ok, danger && o.okIcon !== false ? AM.icon(o.okIcon || "trash-2") : null, AM.h("span", null, o.confirmLabel || o.okLabel || (isAlert ? t("action.ok") : danger ? t("action.delete") : t("action.ok"))));
      cancel.hidden = !!isAlert;
      cancel.textContent = o.cancelLabel || t("action.cancel");
      dlg.setAttribute("role", isAlert ? "dialog" : "alertdialog");
      var answered = false;
      function answer(v) {
        if (answered) return;
        answered = true;
        ok.onclick = null;
        cancel.onclick = null;
        AM.sheets.close("dialog-confirm", v, "api");
      }
      ok.onclick = function () { answer(true); };
      cancel.onclick = function () { answer(false); };
      AM.sheets.open("dialog-confirm", {
        initialFocus: isAlert || !danger ? ok : cancel,
        history: false,
        onClose: function (result) {
          answered = true;
          ok.onclick = null;
          cancel.onclick = null;
          resolve(isAlert ? undefined : result === true);
        },
      });
    });
  }
  /**
   * AM.confirm({title, message, confirmLabel, cancelLabel, danger = true, tone, icon}) -> Promise<boolean>
   * Destructive by default (red confirm button, trash icon). message may contain "\n" (pre-line)
   * or be a Node. Esc / scrim / Cancel -> false. Calls are queued, never stacked on themselves.
   */
  AM.confirm = function (o) {
    if (typeof o === "string") o = { message: o };
    var p = confirmChain.then(function () { return runConfirm(o || {}, false); });
    confirmChain = p.catch(function () {});
    return p;
  };
  /** AM.alert({title, message, okLabel, tone: "info"|"error"|"ok"|"warn"}) -> Promise<void>. Titled per tone, never "Please confirm". */
  AM.alert = function (o) {
    if (typeof o === "string") o = { message: o };
    var p = confirmChain.then(function () { return runConfirm(o || {}, true); });
    confirmChain = p.catch(function () {});
    return p;
  };
  /** Report an AM.api error: toast (default) or alert ({alert: true}). */
  AM.reportError = function (err, o) {
    o = o || {};
    var message = (err && err.userMessage) || (o.fallbackKey ? t(o.fallbackKey) : t("error.unknown", { status: "" }));
    if (err && err.name === "AbortError") return;
    console.warn("[AM]", err);
    if (o.alert) return AM.alert({ message: message, tone: "error", title: o.title });
    AM.toast({ message: message, tone: "danger" });
  };

  // =========================================================================
  // Keyboard shortcuts
  // =========================================================================
  var shortcuts = [];
  function parseCombo(combo) {
    var parts = String(combo).toLowerCase().split("+");
    var key = parts.pop();
    if (key === "") key = "+"; // "mod++"
    var o = { key: key, mod: false, shift: false, alt: false };
    parts.forEach(function (p) {
      if (p === "mod" || p === "ctrl" || p === "cmd" || p === "meta") o.mod = true;
      else if (p === "shift") o.shift = true;
      else if (p === "alt") o.alt = true;
    });
    if (key === "esc") o.key = "escape";
    if (key === "del") o.key = "delete";
    if (key === "space") o.key = " ";
    return o;
  }
  var KEY_ALIAS = { "=": "+", "+": "=", "-": "_", "_": "-" };
  function comboMatches(c, e) {
    var key = (e.key || "").toLowerCase();
    if (c.key === "delete" && key === "backspace" && e.metaKey && !c.mod) return !e.shiftKey && !e.altKey; // ⌘⌫ on Macs
    if (key !== c.key && KEY_ALIAS[c.key] !== key) return false;
    var mod = e.ctrlKey || e.metaKey;
    if (mod !== c.mod || e.altKey !== c.alt) return false;
    var isLetter = /^[a-z]$/.test(c.key);
    if (isLetter || c.key.length > 1) return e.shiftKey === c.shift;
    return true; // symbols ("/", "?", "+", "-", digits): shift depends on the keyboard layout
  }
  AM.shortcuts = {
    /**
     * AM.shortcuts.register(combo, fn(e), opts) -> unregister.
     * combo: "/", "n", "shift+d", "mod+a" (Ctrl or ⌘), "escape", "delete", "?", "1", "mod+=".
     * opts: {scope: "app" (default: no layer and no popover open) | "<layer id>" (that layer
     *        is on top) | "any", when: () => boolean, allowInInput: false}
     * fn returning false means "not handled" (the next matching handler runs).
     * Single-letter shortcuts never fire while typing in a field unless allowInInput.
     */
    register: function (combo, fn, opts) {
      var rec = { c: parseCombo(combo), fn: fn, o: opts || {} };
      shortcuts.push(rec);
      return function () { var i = shortcuts.indexOf(rec); if (i >= 0) shortcuts.splice(i, 1); };
    },
  };
  function runShortcuts(e) {
    for (var i = shortcuts.length - 1; i >= 0; i--) {
      var s = shortcuts[i];
      if (!comboMatches(s.c, e)) continue;
      var scope = s.o.scope || "app";
      var top = AM.sheets.top();
      if (scope === "app" && (top || openPop)) continue;
      if (scope !== "app" && scope !== "any" && scope !== top) continue;
      var typing = AM.isTyping(e.target);
      if (typing && !s.o.allowInInput && !(s.c.mod && s.c.key !== "a") && s.c.key !== "escape") continue;
      if (typing && s.c.key === "escape" && !s.o.allowInInput && scope === "app") continue;
      if (s.o.when && !s.o.when(e)) continue;
      var r;
      try { r = s.fn(e); } catch (err) { console.error(err); }
      if (r !== false) { e.preventDefault(); return true; }
    }
    return false;
  }
  doc.addEventListener("keydown", function (e) {
    if (e.defaultPrevented || e.isComposing) return;
    if (e.key === "Escape") {
      hideTip();
      if (openPop) { closePopover(true); e.preventDefault(); return; }
      if (runShortcuts(e)) return; // layer-scoped Esc handlers first (e.g. editor combobox)
      var top = stack[stack.length - 1];
      if (top) {
        e.preventDefault();
        if (top.opts.escape !== false) AM.sheets.requestClose(top.id, "escape");
      }
      return;
    }
    runShortcuts(e);
  });

  // =========================================================================
  // Radiogroups: arrow keys move + click the next radio; roving tabindex kept in sync.
  // Owners handle the click (set aria-checked); this only moves focus and syncs tabindex.
  // =========================================================================
  AM.radio = {
    sync: function (group) {
      var radios = Array.prototype.slice.call(group.querySelectorAll('[role="radio"]'));
      var checked = radios.filter(function (r) { return r.getAttribute("aria-checked") === "true"; })[0] || radios[0];
      radios.forEach(function (r) { r.tabIndex = r === checked ? 0 : -1; });
    },
    set: function (group, value, attr) {
      attr = attr || "data-value";
      Array.prototype.forEach.call(group.querySelectorAll('[role="radio"]'), function (r) {
        r.setAttribute("aria-checked", String(r.getAttribute(attr) === String(value)));
      });
      AM.radio.sync(group);
    },
  };
  doc.addEventListener("keydown", function (e) {
    var radio = e.target.closest && e.target.closest('[role="radio"]');
    if (!radio) return;
    var group = radio.closest('[role="radiogroup"]');
    if (!group || group.hasAttribute("data-own-keys")) return;
    var radios = Array.prototype.slice.call(group.querySelectorAll('[role="radio"]')).filter(function (r) { return !r.disabled && isVisible(r); });
    var i = radios.indexOf(radio);
    var rtl = AM.dir() === "rtl";
    var d = { ArrowRight: rtl ? -1 : 1, ArrowDown: 1, ArrowLeft: rtl ? 1 : -1, ArrowUp: -1 }[e.key];
    if (!d) return;
    e.preventDefault();
    var next = radios[(i + d + radios.length) % radios.length];
    next.focus();
    next.click();
  });
  doc.addEventListener("click", function (e) {
    var radio = e.target.closest && e.target.closest('[role="radio"]');
    var group = radio && radio.closest('[role="radiogroup"]');
    if (group) setTimeout(function () { AM.radio.sync(group); }, 0);
  });

  // =========================================================================
  // Clipboard, downloads, haptics
  // =========================================================================
  /** AM.copy(text, {toast: true, label}) -> Promise<boolean>. Works over http:// too (execCommand fallback). */
  AM.copy = async function (text, o) {
    o = o || {};
    var ok = false;
    try {
      if (global.isSecureContext && navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(String(text));
        ok = true;
      }
    } catch (e) { ok = false; }
    if (!ok) {
      var ta = AM.h("textarea", { style: "position:fixed;inset-block-start:-1000px;opacity:0", readonly: true, "aria-hidden": "true" });
      ta.value = String(text);
      doc.body.appendChild(ta);
      var prev = doc.activeElement;
      ta.select();
      try { ok = doc.execCommand("copy"); } catch (e) { ok = false; }
      ta.remove();
      if (prev && prev.focus) prev.focus({ preventScroll: true });
    }
    if (o.toast !== false) {
      AM.toast(ok ? { message: o.label || t("toast.copied"), icon: "copy", timeout: 2500 } : { message: t("toast.copy_failed"), tone: "danger" });
    }
    return ok;
  };

  /** AM.download(blob, filename): object-URL download with a deferred revoke (WebKit-safe). */
  AM.download = function (blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = AM.h("a", { href: url, download: filename || "download", style: "display:none" });
    doc.body.appendChild(a);
    a.click();
    setTimeout(function () { a.remove(); URL.revokeObjectURL(url); }, 30000);
  };

  /** AM.haptic("success"|"warning"|"failure"|"light"|"selection"): HA app haptics, else vibrate. */
  AM.haptic = function (kind) {
    try {
      if (global.AntiMatterHaBridge && global.AntiMatterHaBridge.haptic(kind)) return true;
      if (global.AntiMatterScanEngine && global.AntiMatterScanEngine.haptic) return global.AntiMatterScanEngine.haptic(kind);
    } catch (e) { /* ignore */ }
    return false;
  };

  // =========================================================================
  // Protocols (AM.proto)
  // =========================================================================
  var PROTOS = ["matter", "homekit", "zwave", "zigbee", "tuya", "other"];
  var LOGOS = { matter: "matter_logo.svg", homekit: "homekit_logo.png", zwave: "zwave_logo.png", zigbee: "zigbee_logo.png", tuya: "tuya_logo.svg" };
  function MP() { return global.AntiMatterMatterPayload; }
  function HK() { return global.AntiMatterHomeKitPayload; }
  function ZW() { return global.AntiMatterZWavePayload; }
  function digits(s) { return String(s == null ? "" : s).replace(/\D/g, ""); }

  function baseProto(code) {
    if (global.AntiMatterScan && global.AntiMatterScan.codeProtocol) return global.AntiMatterScan.codeProtocol(code);
    var ct = String((code && code.code_type) || "matter").toLowerCase();
    return ct === "homekit" || ct === "zwave" || ct === "other" ? ct : "matter";
  }

  AM.proto = {
    LIST: PROTOS.slice(),
    /** UI protocol of a stored code: matter|homekit|zwave|zigbee|tuya|other (Zigbee/Tuya = other + custom_standard). */
    of: function (code) {
      if (!code) return "other";
      var ct = String(code.code_type || "").toLowerCase();
      if (ct === "zigbee" || ct === "tuya") return ct;
      var p = baseProto(code);
      if (p !== "other") return p;
      var std = String(code.custom_standard || "");
      if (/zigbee/i.test(std)) return "zigbee";
      if (/tuya|smart\s*life/i.test(std)) return "tuya";
      return "other";
    },
    /** Editor preset: "zigbee"|"tuya" only when custom_standard is exactly that name (case-insensitive), else null. */
    preset: function (code) {
      if (!code || baseProto(code) !== "other") return null;
      var s = String(code.custom_standard || "").trim().toLowerCase();
      return s === "zigbee" || s === "tuya" ? s : null;
    },
    /** Metadata: {id, cls, key, logo, codeType, standard, conn} */
    meta: function (p) {
      if (PROTOS.indexOf(p) < 0) p = "other";
      return {
        id: p,
        cls: "p-" + p,
        key: "code.protocol_" + p,
        logo: LOGOS[p] ? ASSETS + LOGOS[p] + V : null,
        codeType: p === "zigbee" || p === "tuya" ? "other" : p,
        standard: p === "zigbee" ? "Zigbee" : p === "tuya" ? "Tuya" : null,
        conn: p === "zwave" ? "conn_zwave" : p === "zigbee" ? "conn_zigbee" : null,
      };
    },
    /** Translated protocol label: AM.proto.label("zwave") -> "Z-Wave". */
    label: function (p) { var key = "code.protocol_" + (PROTOS.indexOf(p) < 0 ? "other" : p); return t(key); },
    /** Display name for a code (Other shows its typed standard verbatim). */
    name: function (code) {
      var p = AM.proto.of(code);
      var std = String((code && code.custom_standard) || "").trim();
      if (p === "other") return std || AM.proto.label("other");
      if ((p === "zigbee" || p === "tuya") && std && !AM.proto.preset(code)) return std;
      return AM.proto.label(p);
    },
    /** Does the server have something to encode as a QR (GET qr.svg would not 400)? */
    hasQr: function (code) {
      if (!code) return false;
      var qr = String(code.qr_payload || "").trim();
      switch (baseProto(code)) {
        case "matter": return /^MT:/i.test(qr);
        case "homekit": return /^X-HM:\/\//i.test(qr);
        case "zwave": return !!(ZW() && ZW().extractQrString(qr));
        default: return !!qr;
      }
    },
    /** Has any payload at all (manual code or QR)? */
    hasPayload: function (code) {
      return !!(code && (String(code.manual_code || "").trim() || String(code.qr_payload || "").trim()));
    },
    /** 8 HomeKit digits ("11122333") from the pairing code or the X-HM:// URI, else "". */
    homekitDigits: function (code) {
      var d = digits(code && code.manual_code);
      if (d.length === 8) return d;
      try {
        var fromUri = HK() && HK().decodePairingFromUri(String((code && code.qr_payload) || ""));
        var dd = digits(fromUri);
        if (dd.length === 8) return dd;
      } catch (e) { /* ignore */ }
      return "";
    },
    /** Z-Wave DSK as 8 groups of 5 digits (from the DSK field or the SmartStart QR), else null. */
    dsk: function (code) {
      var d = digits(code && code.manual_code);
      if (d.length !== 40 && ZW()) {
        try {
          var parsed = ZW().parseQrDigits(ZW().extractQrString(String((code && code.qr_payload) || "")));
          if (parsed && parsed.dsk) d = digits(parsed.dsk);
        } catch (e) { /* ignore */ }
      }
      if (d.length !== 40) return null;
      var g = [];
      for (var i = 0; i < 8; i++) g.push(d.slice(i * 5, i * 5 + 5));
      return g;
    },
    /**
     * Formatted setup code: {pre, text, full, copy}
     *   Matter  XXXX-XXX-XXXX (21-digit codes in 5-5-5-5-1 groups; derived from MT: when only the QR exists)
     *   HomeKit XXX-XX-XXX · Z-Wave pre "PIN", text = first 5 DSK digits, full = DSK groups
     *   Zigbee/Tuya/Other verbatim. text "" when there is no code.
     */
    formatCode: function (code) {
      var p = AM.proto.of(code);
      var manual = String((code && code.manual_code) || "").trim();
      var out = { pre: null, text: "", full: "", copy: "" };
      if (p === "matter") {
        var m = manual;
        if (!m && code && /^MT:/i.test(String(code.qr_payload || "").trim()) && MP()) {
          try { m = (MP().normalizeScannedOrEntered("", String(code.qr_payload).trim()) || {}).manual_code || ""; } catch (e) { m = ""; }
        }
        var f = m && MP() ? MP().formatManualDisplay(m) : m;
        out.text = out.full = out.copy = f || "";
      } else if (p === "homekit") {
        var d = AM.proto.homekitDigits(code);
        out.text = out.full = out.copy = d ? d.slice(0, 3) + "-" + d.slice(3, 5) + "-" + d.slice(5) : manual;
      } else if (p === "zwave") {
        var g = AM.proto.dsk(code);
        if (g) {
          out.pre = t("code.pin_short");
          out.text = g[0];
          out.full = g.join("-");
          out.copy = g[0];
        } else {
          out.text = out.full = out.copy = manual;
        }
      } else {
        out.text = out.full = out.copy = manual;
      }
      return out;
    },
    /** HomeKit label header: house glyph + 8 digits in 2 rows of 4 (<span class="hk-code" role="img">). */
    hkCode: function (d) {
      d = digits(d).padEnd(8, "0").slice(0, 8);
      function glyph(sym, cls, vb) {
        var s = doc.createElementNS(SVG_NS, "svg");
        s.setAttribute("class", cls);
        s.setAttribute("viewBox", vb);
        s.setAttribute("aria-hidden", "true");
        var u = doc.createElementNS(SVG_NS, "use");
        u.setAttribute("href", ICONS_URL + "#" + sym);
        s.appendChild(u);
        return s;
      }
      function row(s) {
        return AM.h("span", { class: "hk-code__row" }, Array.prototype.map.call(s, function (ch) { return glyph("hk-" + ch, "hk-code__digit", "0 0 34 48"); }));
      }
      return AM.h("span", { class: "hk-code", role: "img", "aria-label": t("code.hk_aria", { code: d.slice(0, 3) + "-" + d.slice(3, 5) + "-" + d.slice(5) }) },
        glyph("hk-house", "hk-code__house", "0 0 130 120"),
        AM.h("span", { class: "hk-code__rows" }, row(d.slice(0, 4)), row(d.slice(4)))
      );
    },
    /** Protocol header for white paper (tile, label, receipt): wordmark <img>, HomeKit glyph code, or the standard as text. */
    wordmark: function (code) {
      var p = AM.proto.of(code);
      if (p === "homekit") {
        var d = AM.proto.homekitDigits(code);
        if (d) return AM.proto.hkCode(d);
      }
      var logo = LOGOS[p];
      if (logo) {
        return AM.h("img", { class: "wordmark wordmark--" + p, src: ASSETS + logo + V, alt: AM.proto.label(p), draggable: "false", decoding: "async" });
      }
      return AM.h("span", { class: "wordmark wordmark--text", dir: "auto" }, AM.proto.name(code));
    },
  };

  // =========================================================================
  // QR (AM.qr): server SVG, cached, fills driven by --qr-fg / --qr-bg (invert = token swap)
  // =========================================================================
  var qrCache = new Map(); // key -> Promise<string|null>
  function qrParse(text, o) {
    if (!text) return null;
    var parsed = new DOMParser().parseFromString(text, "image/svg+xml").documentElement;
    if (!parsed || parsed.nodeName.toLowerCase() !== "svg") return null;
    var svg = doc.importNode(parsed, true);
    var vb = (svg.getAttribute("viewBox") || "0 0 0 0").split(/[\s,]+/).map(Number);
    svg.removeAttribute("width");
    svg.removeAttribute("height");
    svg.setAttribute("class", "qr" + (o && o.className ? " " + o.className : ""));
    svg.setAttribute("shape-rendering", "crispEdges");
    svg.setAttribute("data-modules", String(vb[2] || 0));
    svg.setAttribute("focusable", "false");
    var label = o && o.label;
    if (label) { svg.setAttribute("role", "img"); svg.setAttribute("aria-label", label); }
    else svg.setAttribute("aria-hidden", "true");
    Array.prototype.forEach.call(svg.querySelectorAll("rect"), function (r) { r.removeAttribute("fill"); r.setAttribute("class", "qr__bg"); });
    Array.prototype.forEach.call(svg.querySelectorAll("path"), function (p) { p.removeAttribute("fill"); p.setAttribute("class", "qr__fg"); });
    return svg;
  }
  function qrFetch(key, run) {
    if (!qrCache.has(key)) {
      var p = run().catch(function (e) {
        qrCache.delete(key);
        if (e && (e.code === "no_qr_payload" || e.code === "code_not_found")) return null;
        throw e;
      });
      qrCache.set(key, p);
      if (qrCache.size > 400) qrCache.delete(qrCache.keys().next().value);
    }
    return qrCache.get(key);
  }

  AM.qr = {
    /**
     * AM.qr.forCode(code, {border = 4, label, className}) -> Promise<SVGElement | null>
     * GET ./api/codes/{id}/qr.svg, cached per id + updated_at + border. A fresh element
     * every call. null when the code has nothing scannable (check AM.proto.hasQr first to
     * skip the request). Other errors reject (err.code e.g. "qr_payload_too_long").
     */
    forCode: function (code, o) {
      o = o || {};
      if (!code || !code.id) return Promise.resolve(null);
      var border = o.border == null ? 4 : o.border;
      var key = "c|" + code.id + "|" + (code.updated_at || "") + "|" + border;
      return qrFetch(key, function () {
        return AM.api("/codes/" + encodeURIComponent(code.id) + "/qr.svg?border=" + border, { as: "text" });
      }).then(function (text) { return qrParse(text, { label: o.label, className: o.className }); });
    },
    /**
     * AM.qr.forPayload(body, {border, label, signal}) -> Promise<SVGElement | null>
     * POST ./api/qr.svg with {code_type, qr_payload, manual_code, setup_id, homekit_category,
     * homekit_flag, custom_standard} (never in the URL). Cached per body. null = nothing to encode.
     */
    forPayload: function (body, o) {
      o = o || {};
      var border = o.border == null ? 4 : o.border;
      var b = {
        code_type: body && body.code_type === "zigbee" || body && body.code_type === "tuya" ? "other" : (body && body.code_type) || "matter",
        qr_payload: (body && body.qr_payload) || "",
        manual_code: (body && body.manual_code) || "",
        setup_id: (body && body.setup_id) || "",
        homekit_category: (body && body.homekit_category) || "other",
        homekit_flag: body && body.homekit_flag != null ? body.homekit_flag : 2,
        custom_standard: (body && body.custom_standard) || "",
      };
      // Skip the request (and the browser's 400 console noise) when the server would have nothing to encode.
      if (!AM.proto.hasQr({ code_type: b.code_type, qr_payload: b.qr_payload, manual_code: b.manual_code }) &&
        !(b.code_type === "homekit" && digits(b.manual_code).length === 8)) return Promise.resolve(null);
      var key = "p|" + border + "|" + JSON.stringify(b);
      return qrFetch(key, function () {
        return AM.api("/qr.svg?border=" + border, { method: "POST", body: b, as: "text", signal: o.signal });
      }).then(function (text) { return qrParse(text, { label: o.label, className: o.className }); });
    },
    /**
     * Integer px-per-module snap (SPEC §10.1): size = floor(target/total)*total when that gives
     * ≥ 3 px/module and ≥ min(96, ⅔·target) px of modules; else target. total = modules incl. quiet zone.
     */
    snap: function (target, total) {
      if (!total || target < 64) return Math.round(target);
      var m = Math.floor(target / total);
      var n = total - 8; // data modules (4-module quiet zone each side)
      return m >= 3 && m * n >= Math.min(96, target * 0.66) ? m * total : Math.round(target);
    },
    /**
     * Put a QR svg into container at a snapped size: sets --qr-size on the svg.
     * {targetPx} defaults to the container's content width. Returns the px size used.
     */
    mount: function (container, svg, o) {
      o = o || {};
      if (!container || !svg) return 0;
      var target = o.targetPx || container.clientWidth || 132;
      var total = parseInt(svg.getAttribute("data-modules"), 10) || 0;
      var size = AM.qr.snap(target, total);
      svg.style.setProperty("--qr-size", size + "px");
      if (svg.parentNode !== container) AM.fill(container, svg);
      return size;
    },
    /** Placeholder when there is no QR: <div class="qr-placeholder"> with icon + text (default "No QR stored"). */
    placeholder: function (text, px) {
      return AM.h("div", { class: "qr-placeholder", style: px ? { "--qr-size": px + "px" } : null },
        AM.icon("scan-qr-code"), AM.h("span", null, text || t("card.no_qr")));
    },
    /** Drop cached SVGs for a code id (after an edit; normally updated_at changes anyway). */
    forget: function (id) {
      Array.from(qrCache.keys()).forEach(function (k) { if (k.indexOf("c|" + id + "|") === 0) qrCache.delete(k); });
    },
  };

  // =========================================================================
  // Categories (AM.cat). Ids of trashed/unknown categories are treated as absent everywhere.
  // =========================================================================
  var NONE = "__none__";
  function CI() { return global.AntiMatterCategoryIcons; }
  AM.cat = {
    NONE: NONE,
    /** Live categories, sorted by sort_order then name (collator). */
    list: function () {
      return AM.store.vault.categories.slice().sort(function (a, b) {
        return (a.sort_order || 0) - (b.sort_order || 0) || AM.compare(a.name, b.name);
      });
    },
    get: function (id) { return AM.store.catById.get(id) || null; },
    known: function (id) { return AM.store.catById.has(id); },
    name: function (id) { var c = AM.store.catById.get(id); return c ? c.name : ""; },
    /** A code's category ids that exist in the live vault, in AM.cat.list() order. */
    idsOf: function (code) {
      var ids = (code && code.category_ids) || [];
      return AM.cat.list().filter(function (c) { return ids.indexOf(c.id) >= 0; }).map(function (c) { return c.id; });
    },
    of: function (code) { return AM.cat.idsOf(code).map(function (id) { return AM.store.catById.get(id); }); },
    /** Count of codes per category id (+ NONE for uncategorized), trashed ids ignored. */
    counts: function (codes) {
      var out = {};
      out[NONE] = 0;
      (codes || AM.store.vault.codes).forEach(function (c) {
        var ids = AM.cat.idsOf(c);
        if (!ids.length) out[NONE]++;
        ids.forEach(function (id) { out[id] = (out[id] || 0) + 1; });
      });
      return out;
    },
    /**
     * category_ids to SAVE for an edited code: the chosen live ids plus the code's ids whose
     * category is in the Trash (hidden in the UI), so restoring that category re-attaches it.
     */
    idsToSave: function (originalIds, chosenIds) {
      var trashed = new Set(AM.store.trash.categories.map(function (c) { return c.id; }));
      var keep = (originalIds || []).filter(function (id) { return trashed.has(id) && !AM.store.catById.has(id); });
      var out = [];
      (chosenIds || []).concat(keep).forEach(function (id) { if (out.indexOf(id) < 0) out.push(id); });
      return out;
    },
    /** Tinted tile for an icon id + colour: <span class="cat-mark" style="--cat;--cat-bg">glyph</span>. */
    iconEl: function (iconId, color, o) {
      return CI().mark({ icon: iconId, color: color, name: (o && o.letter) || "" }, o);
    },
    /** Tile for a category object (or id). o: {size: "sm"|"lg"|px, className, title}. */
    markEl: function (cat, o) {
      if (typeof cat === "string") cat = AM.cat.get(cat);
      if (!cat) return AM.h("span", { class: "cat-mark", "aria-hidden": "true" }, AM.icon("tag"));
      return CI().mark(cat, o);
    },
    /** Uncategorized pseudo-mark (tag glyph on neutral tile). */
    noneMark: function () { return AM.h("span", { class: "cat-mark", "aria-hidden": "true" }, AM.icon("tag")); },
    tint: function (hex, a) { return CI().tint(hex, a); },
  };

  // =========================================================================
  // Filters (single source of truth for search + category + attribute filtering)
  // =========================================================================
  var CONN = [
    { key: "conn_wifi", label: "code.conn_wifi", icon: "wifi" },
    { key: "conn_matter", label: "code.conn_matter", icon: "waypoints" },
    { key: "conn_zigbee", label: "code.conn_zigbee", icon: "hexagon" },
    { key: "conn_bluetooth", label: "code.conn_bluetooth", icon: "bluetooth" },
    { key: "conn_zwave", label: "code.conn_zwave", icon: "radio" },
  ];
  var CONN_EMPTY = "__conn_empty__";
  var FIELDS = { vendor: "device_vendor", product: "device_product", type: "device_type", area: "area" };
  var SET_KEYS = ["cats", "protocol", "vendor", "product", "type", "area", "conn"];
  function fkey(v) { return String(v == null ? "" : v).trim().toLocaleLowerCase(); }
  var F = { query: "", cats: new Set(), protocol: new Set(), vendor: new Set(), product: new Set(), type: new Set(), area: new Set(), conn: new Set(), inUse: "", ids: null };

  function haName(code) {
    var id = code && code.ha_link && code.ha_link.device_id;
    if (!id) return "";
    var d = AM.ha.device(id);
    return d ? d.name || "" : "";
  }
  function searchText(code) {
    var parts = [code.name, code.device_type, code.device_vendor, code.device_product, code.area, code.description,
      code.manual_code, code.qr_payload, code.notes, code.custom_standard, AM.proto.name(code), haName(code)];
    AM.cat.of(code).forEach(function (c) { parts.push(c.name); });
    return parts.filter(Boolean).join("\n").toLocaleLowerCase();
  }

  AM.filters = {
    NONE: NONE,
    CONN: CONN,
    CONN_EMPTY: CONN_EMPTY,
    FIELDS: FIELDS,
    /** Live state: {query, cats:Set, protocol:Set, vendor:Set, product:Set, type:Set, area:Set, conn:Set, inUse:""|"yes"|"no", ids:Set|null}. Treat as read-only; change it with set/toggle/clear. */
    state: F,
    /** Merge a patch (arrays/Sets for set keys) and emit "filters". */
    set: function (patch) {
      patch = patch || {};
      Object.keys(patch).forEach(function (k) {
        var v = patch[k];
        if (SET_KEYS.indexOf(k) >= 0) F[k] = new Set(v ? Array.from(v) : []);
        else if (k === "ids") F.ids = v ? new Set(Array.from(v)) : null;
        else if (k === "query") F.query = String(v || "");
        else if (k === "inUse") F.inUse = v === "yes" || v === "no" ? v : "";
      });
      AM.emit("filters", F);
    },
    /** Toggle one value in a set filter (vendor/product/type/area values are fkey()-normalised). */
    toggle: function (field, value) {
      var s = F[field];
      if (!(s instanceof Set)) return;
      var v = FIELDS[field] ? fkey(value) : value;
      if (s.has(v)) s.delete(v); else s.add(v);
      AM.emit("filters", F);
    },
    /** clear({attributes = true, query = false, cats = false, ids = true}) */
    clear: function (o) {
      o = Object.assign({ attributes: true, query: false, cats: false, ids: true }, o || {});
      if (o.attributes) { ["protocol", "vendor", "product", "type", "area", "conn"].forEach(function (k) { F[k] = new Set(); }); F.inUse = ""; }
      if (o.query) F.query = "";
      if (o.cats) F.cats = new Set();
      if (o.ids) F.ids = null;
      AM.emit("filters", F);
    },
    /** Number of active attribute filters (protocol, vendor, product, type, area, conn, in use). */
    activeCount: function () {
      var n = 0;
      ["protocol", "vendor", "product", "type", "area", "conn"].forEach(function (k) { if (F[k].size) n++; });
      if (F.inUse) n++;
      return n;
    },
    /** Anything narrowing the list (attributes, search, categories or a session review)? */
    isActive: function () {
      return AM.filters.activeCount() > 0 || !!F.query.trim() || F.cats.size > 0 || !!F.ids;
    },
    /** Values for vendor|product|type|area: [{value (fkey), label (most common spelling), count}], "(Empty)" = value "" first. */
    values: function (field, codes) {
      var prop = FIELDS[field];
      if (!prop) return [];
      var map = new Map();
      (codes || AM.store.vault.codes).forEach(function (c) {
        var raw = String(c[prop] == null ? "" : c[prop]).trim();
        var k = fkey(raw);
        var e = map.get(k);
        if (!e) { e = { value: k, count: 0, spellings: new Map() }; map.set(k, e); }
        e.count++;
        e.spellings.set(raw, (e.spellings.get(raw) || 0) + 1);
      });
      var out = Array.from(map.values()).map(function (e) {
        var best = "", bn = -1;
        e.spellings.forEach(function (n, s) { if (n > bn) { best = s; bn = n; } });
        return { value: e.value, label: best, count: e.count };
      });
      out.sort(function (a, b) { return a.value === "" ? -1 : b.value === "" ? 1 : AM.compare(a.label, b.label); });
      return out;
    },
    /** Does a code pass every filter except the ones named in skip (array)? */
    matches: function (code, skip) {
      skip = skip || [];
      if (F.ids && skip.indexOf("ids") < 0 && !F.ids.has(code.id)) return false;
      var q = F.query.trim().toLocaleLowerCase();
      if (q && skip.indexOf("query") < 0) {
        var text = searchText(code);
        var ok = q.split(/\s+/).every(function (w) { return text.indexOf(w) >= 0; });
        if (!ok) {
          var qd = digits(q);
          ok = qd.length >= 4 && qd.length === q.replace(/[\s-]/g, "").length && digits(code.manual_code).indexOf(qd) >= 0;
        }
        if (!ok) return false;
      }
      if (F.cats.size && skip.indexOf("cats") < 0) {
        var ids = AM.cat.idsOf(code);
        var hit = ids.some(function (id) { return F.cats.has(id); }) || (!ids.length && F.cats.has(NONE));
        if (!hit) return false;
      }
      if (F.protocol.size && skip.indexOf("protocol") < 0 && !F.protocol.has(AM.proto.of(code))) return false;
      for (var f in FIELDS) {
        if (F[f].size && skip.indexOf(f) < 0 && !F[f].has(fkey(code[FIELDS[f]]))) return false;
      }
      if (F.conn.size && skip.indexOf("conn") < 0) {
        var any = CONN.filter(function (c) { return code[c.key]; });
        var chit = any.some(function (c) { return F.conn.has(c.key); }) || (!any.length && F.conn.has(CONN_EMPTY));
        if (!chit) return false;
      }
      if (F.inUse && skip.indexOf("inUse") < 0 && (F.inUse === "yes") !== !!code.in_use) return false;
      return true;
    },
    /** Filtered codes in vault order. */
    apply: function (codes, skip) {
      return (codes || AM.store.vault.codes).filter(function (c) { return AM.filters.matches(c, skip); });
    },
    /** Drop selections that no longer exist in the vault (called on every vault change). */
    prune: function () {
      var changed = false;
      var codes = AM.store.vault.codes;
      Object.keys(FIELDS).forEach(function (f) {
        if (!F[f].size) return;
        var live = new Set(codes.map(function (c) { return fkey(c[FIELDS[f]]); }));
        F[f].forEach(function (v) { if (!live.has(v)) { F[f].delete(v); changed = true; } });
      });
      F.cats.forEach(function (id) { if (id !== NONE && !AM.store.catById.has(id)) { F.cats.delete(id); changed = true; } });
      if (changed) AM.emit("filters", F);
    },
  };

  // =========================================================================
  // Selection
  // =========================================================================
  var SEL = new Set();
  var selMode = false;
  function selEmit() {
    var on = SEL.size > 0 || selMode;
    if (on) doc.documentElement.setAttribute("data-selecting", SEL.size > 0 ? "some" : "mode");
    else doc.documentElement.removeAttribute("data-selecting");
    AM.emit("selection", { ids: SEL, mode: selMode });
  }
  AM.selection = {
    ids: SEL,
    get size() { return SEL.size; },
    get mode() { return selMode; },
    has: function (id) { return SEL.has(id); },
    set: function (ids) { SEL.clear(); Array.from(ids || []).forEach(function (id) { SEL.add(id); }); selEmit(); },
    add: function (ids) { Array.from(ids || []).forEach(function (id) { SEL.add(id); }); selEmit(); },
    remove: function (ids) { Array.from(ids || []).forEach(function (id) { SEL.delete(id); }); selEmit(); },
    toggle: function (id) { if (SEL.has(id)) SEL.delete(id); else SEL.add(id); selEmit(); },
    /** Clear ids and leave select mode. */
    clear: function () { SEL.clear(); selMode = false; selEmit(); },
    /** Touch select mode (checkboxes visible with nothing selected yet). */
    setMode: function (on) { selMode = !!on; if (!on) SEL.clear(); selEmit(); },
    /** Remove ids that are no longer in the vault (runs on every vault change). */
    prune: function () {
      var n = SEL.size;
      SEL.forEach(function (id) { if (!AM.store.codeById.has(id)) SEL.delete(id); });
      if (SEL.size !== n) selEmit();
    },
  };

  // =========================================================================
  // Home Assistant (AM.ha)
  // =========================================================================
  var haProps = { narrow: false, header: null };
  AM.ha = {
    /** HA reachable and devices loaded (the add-on reports ha_available). */
    available: function () { return !!(AM.store.info && AM.store.info.ha_available) && AM.store.haDevices.length > 0; },
    devices: function () { return AM.store.haDevices; },
    areas: function () { return AM.store.areas; },
    device: function (id) {
      if (!id) return null;
      var list = AM.store.haDevices;
      for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
      return null;
    },
    /** Display label: name, plus " — area" only when several devices share the name. */
    label: function (dev) {
      if (!dev) return "";
      var same = AM.store.haDevices.filter(function (d) { return d.name === dev.name; }).length;
      return same > 1 && dev.area ? t("ha.device_in_area", { name: dev.name, area: dev.area }) : dev.name;
    },
    /** Case-insensitive search over name + area, max `limit` (25). Empty query lists all (sorted). */
    search: function (query, limit) {
      var q = String(query || "").trim().toLocaleLowerCase();
      var list = AM.store.haDevices.filter(function (d) {
        return !q || (String(d.name || "") + " " + String(d.area || "")).toLocaleLowerCase().indexOf(q) >= 0;
      });
      list.sort(function (a, b) { return AM.compare(a.name, b.name) || AM.compare(a.area, b.area); });
      return list.slice(0, limit || 25);
    },
    /** Best device for an unlinked code (token overlap of name/vendor/product with device name + area), or null. */
    suggest: function (code) {
      if (!code || (code.ha_link && code.ha_link.device_id) || !AM.store.haDevices.length) return null;
      var tokens = [code.name, code.device_vendor, code.device_product].join(" ").toLocaleLowerCase()
        .split(/[^\p{L}\p{N}]+/u).filter(function (w) { return w.length >= 3; });
      if (!tokens.length) return null;
      var best = null, bestScore = 0;
      AM.store.haDevices.forEach(function (d) {
        var hay = (String(d.name || "") + " " + String(d.area || "")).toLocaleLowerCase();
        var score = 0;
        tokens.forEach(function (w) { if (hay.indexOf(w) >= 0) score += w.length; });
        if (score > bestScore) { best = d; bestScore = score; }
      });
      return bestScore >= 4 ? best : null;
    },
    /** Absolute HA frontend URL of a device page (the ingress iframe must not navigate itself). */
    deviceUrl: function (id) {
      return global.location.origin + "/config/devices/device/" + encodeURIComponent(id);
    },
    /** Open a device in the HA frontend: bridge navigation first, else a new tab. */
    openDevice: function (id) {
      if (!id) return false;
      try {
        if (global.AntiMatterHaBridge && global.AntiMatterHaBridge.navigateToDevice(id)) return true;
      } catch (e) { /* fall through */ }
      global.open(AM.ha.deviceUrl(id), "_blank", "noopener");
      return true;
    },
    /** Toggle HA's own sidebar (used when HA shows no header of its own). */
    toggleMenu: function () {
      try { global.parent.postMessage({ type: "home-assistant/toggle-menu" }, global.location.origin); } catch (e) { /* ignore */ }
    },
    /** True when the app is framed by HA narrow WITHOUT HA's header (kiosk): brand = HA menu button. */
    needsMenuButton: function () { return !!haProps.narrow && haProps.header === false; },
    inFrame: function () { try { return global.parent !== global; } catch (e) { return true; } },
    /** Subscribe to HA panel properties (safe areas, narrow). Called once by boot.js. */
    initShell: function () {
      if (!AM.ha.inFrame()) return;
      function headerPresent() {
        try {
          var fe = global.frameElement;
          if (!fe) return null;
          var prev = fe.previousElementSibling;
          return !!(prev && prev.classList && prev.classList.contains("header"));
        } catch (e) { return null; }
      }
      function px(v) { v = String(v || "").trim(); return /^-?[\d.]+px$/.test(v) ? v : v === "0" || !v ? "0px" : v; }
      var last = null;
      function applySafe() {
        if (!last) return;
        var s = last.safeAreaInsets || {};
        var rs = doc.documentElement.style;
        var rtl = AM.dir() === "rtl";
        rs.setProperty("--ha-safe-top", haProps.header ? "0px" : px(s.top));
        rs.setProperty("--ha-safe-bottom", px(s.bottom));
        rs.setProperty("--ha-safe-start", px(rtl ? s.right : s.left));
        rs.setProperty("--ha-safe-end", px(rtl ? s.left : s.right));
      }
      global.addEventListener("message", function (e) {
        if (e.source !== global.parent || !e.data || e.data.type !== "home-assistant/properties") return;
        last = e.data;
        haProps.narrow = !!e.data.narrow;
        haProps.header = headerPresent();
        applySafe();
        AM.emit("ha-shell", { narrow: haProps.narrow, header: haProps.header, menuButton: AM.ha.needsMenuButton() });
      });
      AM.on("locale", applySafe);
      try { global.parent.postMessage({ type: "home-assistant/subscribe-properties", handleSafeArea: true }, global.location.origin); } catch (e) { /* ignore */ }
    },
  };

  // =========================================================================
  // Backup helpers (shared by the sidebar card, the More sheet and the Backups dialog)
  // =========================================================================
  function timeText(hour, minute) {
    var d = new Date(2024, 0, 1, hour || 0, minute || 0);
    try { return new Intl.DateTimeFormat(AM.locale(), { hour: "2-digit", minute: "2-digit" }).format(d); }
    catch (e) { return String(hour).padStart(2, "0") + ":" + String(minute).padStart(2, "0"); }
  }
  function weekdayText(i) { // 0 = Monday (backend convention)
    var d = new Date(2024, 0, 1 + ((i || 0) % 7)); // 2024-01-01 was a Monday
    try { return new Intl.DateTimeFormat(AM.locale(), { weekday: "long" }).format(d); } catch (e) { return String(i); }
  }
  function lastRunText(key) {
    if (!key) return "";
    var m;
    var rtf = null;
    try { rtf = new Intl.RelativeTimeFormat(AM.locale(), { numeric: "auto" }); } catch (e) { rtf = null; }
    if ((m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}))?$/.exec(key))) {
      var day = new Date(+m[1], +m[2] - 1, +m[3]);
      var today = new Date(); today.setHours(0, 0, 0, 0);
      var diff = Math.round((day - today) / 86400000);
      var dayText = rtf && Math.abs(diff) < 7 ? rtf.format(diff, "day") : AM.fmt.date(day);
      return m[4] != null ? t("backup.at_time", { day: dayText, time: timeText(+m[4], 0) }) : dayText;
    }
    if ((m = /^(\d{4})-W(\d{2})$/.exec(key))) return t("backup.week_of", { week: String(+m[2]), year: m[1] });
    if ((m = /^(\d{4})-(\d{2})$/.exec(key))) {
      try { return new Intl.DateTimeFormat(AM.locale(), { month: "long", year: "numeric" }).format(new Date(+m[1], +m[2] - 1, 1)); } catch (e) { return key; }
    }
    return key;
  }
  AM.backup = {
    /** GET /api/backup/settings -> store.backup, emits "backup". */
    reload: function () {
      return AM.api("/backup/settings").then(function (s) { AM.store.backup = s; AM.emit("backup", s); return s; });
    },
    /** Store settings returned by a PUT and emit "backup". */
    set: function (s) { AM.store.backup = s; AM.emit("backup", s); },
    timeText: timeText,
    weekdayText: weekdayText,
    /** {enabled, schedule: "Daily 03:00", lastRun: "today" | "", kept: 12, freqLabel: "Daily"} */
    describe: function (s) {
      s = s || AM.store.backup || {};
      var f = s.frequency || "daily";
      var freqKey = "backup.freq_" + f;
      var time = timeText(s.hour, s.minute);
      var schedule = f === "hourly" ? t("backup.sched_hourly", { minute: String(s.minute || 0).padStart(2, "0") })
        : f === "weekly" ? t("backup.sched_weekly", { weekday: weekdayText(s.weekday), time: time })
          : f === "monthly" ? t("backup.sched_monthly", { day: String(s.day_of_month || 1), time: time })
            : t("backup.sched_daily", { time: time });
      return { enabled: !!s.enabled, schedule: schedule, lastRun: lastRunText(s.last_run_key), kept: s.keep_count || 0, freqLabel: t(freqKey) };
    },
  };

  // =========================================================================
  // Actions registry (modules provide, anyone calls)
  // =========================================================================
  var providers = Object.create(null);
  /** AM.provide(name, fn): register the implementation of an action (last one wins). */
  AM.provide = function (name, fn) { providers[name] = fn; };
  /** AM.act(name, ...args): call a provided action; warns (and returns undefined) when missing. */
  AM.act = function (name) {
    var fn = providers[name];
    if (typeof fn !== "function") { console.warn("[AM] no provider for action '" + name + "'"); return undefined; }
    return fn.apply(null, Array.prototype.slice.call(arguments, 1));
  };
  AM.can = function (name) { return typeof providers[name] === "function"; };

  // =========================================================================
  // Boot milestones (resolved by boot.js)
  // =========================================================================
  var readyResolve, loadedResolve;
  /** Resolves with /api/info once the locale is active and the shell is wired (before the vault loads). */
  AM.ready = new Promise(function (r) { readyResolve = r; });
  /** Resolves with the vault after the first successful load. */
  AM.loaded = new Promise(function (r) { loadedResolve = r; });
  AM._resolveReady = function (info) { readyResolve(info); };
  AM._resolveLoaded = function (v) { loadedResolve(v); };
  // i18n-dynamic: error. code.protocol_ backup.freq_ alert.title_

  // =========================================================================
  // Locale / theme bridges -> AM events
  // =========================================================================
  if (I18N && I18N.onChange) {
    I18N.onChange(function (loc) { AM.emit("locale", { locale: loc, dir: I18N.getDir() }); });
  }
  if (global.AntiMatterTheme && global.AntiMatterTheme.onChange) {
    global.AntiMatterTheme.onChange(function (d) { AM.emit("theme", d); });
  }

  global.AM = AM;
})(window);
