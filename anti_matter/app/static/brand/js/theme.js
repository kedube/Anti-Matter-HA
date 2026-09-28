/**
 * Anti-Matter 3.0 theme resolver: window.AntiMatterTheme
 * ============================================================================
 * Load as a SYNCHRONOUS classic script in <head>, BEFORE the stylesheets: it writes
 * <html data-theme="light|dark"> before first paint, so there is never a flash of the
 * wrong palette (tokens.css holds exactly one dark block keyed on that attribute).
 *
 * Resolution order (first match wins):
 *   1. ?theme=light|dark                 URL override (screenshots, support)
 *   2. localStorage "antimatter-theme"   per-browser choice: "light" | "dark" ("auto"/missing = none)
 *   3. add-on option (theme in /api/info) setAddonTheme() from boot.js; the last value is
 *                                         cached in localStorage "antimatter-addon-theme" so the
 *                                         next page load paints correctly before /api/info returns
 *   4. Home Assistant frame               luminance of the same-origin parent/top frame's
 *                                         --primary-background-color (followed live)
 *   5. prefers-color-scheme               (followed live)
 *
 * Also at load (all synchronous, all storage access wrapped in try/catch):
 *   - <html data-qr-invert="true"> when localStorage "antimatter-qr-invert" === "1"
 *   - <html lang/dir> hint from ?lang= or the saved locale override, so an RTL page does not
 *     lay out LTR first (i18n.js sets the authoritative values once the locale file loads)
 *   - <meta name="theme-color"> follows the theme (#F3F2FA / #080719), or setMetaColor().
 *
 * API
 *   get()            -> "light" | "dark"          the resolved theme now
 *   getOverride()    -> "auto" | "light" | "dark" the per-browser choice (what the Display menu shows)
 *   source()         -> "url" | "override" | "addon" | "ha" | "os"
 *   set(mode)        mode "auto" | "light" | "dark": saves the per-browser choice and applies it
 *   setAddonTheme(v) add-on option from /api/info ("auto" | "light" | "dark")
 *   setMetaColor(c)  force <meta name=theme-color> (the scanner passes "#000"); null restores
 *   onChange(cb)     -> unsubscribe. cb({theme, mode, source}) after every change of the resolved
 *                    theme OR of the chosen mode. Also dispatched as window event "antimatter:theme".
 *   apply()          re-resolve now (cheap)
 */
(function (global) {
  "use strict";

  var doc = global.document;
  var root = doc.documentElement;
  var KEY = "antimatter-theme";
  var ADDON_KEY = "antimatter-addon-theme";
  var INVERT_KEY = "antimatter-qr-invert";
  var LOCALE_KEY = "antimatter-locale";
  var META = { light: "#F3F2FA", dark: "#080719" };
  var mq = global.matchMedia ? global.matchMedia("(prefers-color-scheme: dark)") : null;

  var current = null;
  var currentMode = null;
  var currentSource = null;
  var metaOverride = null;
  var listeners = [];

  function read(k) {
    try { return global.localStorage.getItem(k); } catch (e) { return null; }
  }
  function write(k, v) {
    try {
      if (v == null) global.localStorage.removeItem(k);
      else global.localStorage.setItem(k, v);
    } catch (e) { /* storage blocked: the choice lasts for this page only */ }
  }
  function norm(v) {
    v = String(v == null ? "" : v).trim().toLowerCase();
    return v === "light" || v === "dark" || v === "auto" ? v : null;
  }

  var memOverride = norm(read(KEY)) || "auto"; // survives blocked storage for this page
  var addon = norm(read(ADDON_KEY)) || "auto";

  function urlTheme() {
    try {
      var m = /[?&]theme=(light|dark)\b/i.exec(global.location.search);
      return m ? m[1].toLowerCase() : null;
    } catch (e) { return null; }
  }

  function haFrames() {
    var out = [];
    try { if (global.parent && global.parent !== global) out.push(global.parent); } catch (e) { /* ignore */ }
    try { if (global.top && global.top !== global && out.indexOf(global.top) === -1) out.push(global.top); } catch (e) { /* ignore */ }
    return out;
  }

  function luminance(color) {
    var c = String(color || "").trim();
    if (!c) return null;
    var r, g, b, m;
    if (c.charAt(0) === "#") {
      var hx = c.slice(1);
      if (hx.length === 3 || hx.length === 4) hx = hx[0] + hx[0] + hx[1] + hx[1] + hx[2] + hx[2];
      if (hx.length < 6) return null;
      r = parseInt(hx.slice(0, 2), 16); g = parseInt(hx.slice(2, 4), 16); b = parseInt(hx.slice(4, 6), 16);
    } else if ((m = c.match(/[\d.]+/g)) && m.length >= 3) {
      r = +m[0]; g = +m[1]; b = +m[2];
    } else {
      return null;
    }
    if (isNaN(r) || isNaN(g) || isNaN(b)) return null;
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  }

  function haTheme() {
    var frames = haFrames();
    for (var i = 0; i < frames.length; i++) {
      try {
        var el = frames[i].document.documentElement;
        var bg = frames[i].getComputedStyle(el).getPropertyValue("--primary-background-color");
        var l = luminance(bg);
        if (l != null) return l < 0.5 ? "dark" : "light";
      } catch (e) { /* cross-origin frame: skip */ }
    }
    return null;
  }

  function resolve() {
    var u = urlTheme();
    if (u) return [u, "url"];
    if (memOverride === "light" || memOverride === "dark") return [memOverride, "override"];
    if (addon === "light" || addon === "dark") return [addon, "addon"];
    var h = haTheme();
    if (h) return [h, "ha"];
    return [mq && mq.matches ? "dark" : "light", "os"];
  }

  function syncMeta() {
    var meta = doc.querySelector('meta[name="theme-color"]');
    if (!meta) return;
    var c = metaOverride || META[current] || META.light;
    if (meta.getAttribute("content") !== c) meta.setAttribute("content", c);
  }

  function notify() {
    var detail = { theme: current, mode: memOverride, source: currentSource };
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](detail); } catch (e) { if (global.console) console.error("[theme] listener failed", e); }
    }
    try { global.dispatchEvent(new CustomEvent("antimatter:theme", { detail: detail })); } catch (e) { /* ignore */ }
  }

  function apply() {
    var r = resolve();
    var theme = r[0];
    currentSource = r[1];
    if (root.getAttribute("data-theme") !== theme) root.setAttribute("data-theme", theme);
    var changed = theme !== current || memOverride !== currentMode;
    var first = current === null;
    current = theme;
    currentMode = memOverride;
    syncMeta();
    if (changed && !first) notify();
    return theme;
  }

  // ---- Live follow: OS scheme + Home Assistant frame ------------------------------
  if (mq) {
    if (mq.addEventListener) mq.addEventListener("change", apply);
    else if (mq.addListener) mq.addListener(apply);
  }

  var haWatched = false;
  var soonTimer = null;
  function applySoon() { // coalesce bursts of HA style mutations into one read
    if (soonTimer) return;
    soonTimer = global.setTimeout(function () { soonTimer = null; apply(); }, 120);
  }
  function watchHA() {
    if (haWatched) return;
    var frames = haFrames();
    if (!frames.length) return;
    haWatched = true;
    var observed = false;
    for (var i = 0; i < frames.length; i++) {
      try {
        var target = frames[i].document.documentElement;
        var MO = frames[i].MutationObserver || global.MutationObserver;
        new MO(applySoon).observe(target, { attributes: true, attributeFilter: ["style", "class"] });
        var head = frames[i].document.head;
        if (head) new MO(applySoon).observe(head, { childList: true });
        observed = true;
      } catch (e) { /* cross-origin: fall back to polling below */ }
    }
    // Cheap safety net (one getComputedStyle read) for HA themes applied in ways the
    // observers miss, and for frames we could not observe.
    global.setInterval(function () {
      if (!doc.hidden) apply();
    }, observed ? 5000 : 2000);
  }

  // ---- Boot hints (synchronous, before first paint) -------------------------------
  if (read(INVERT_KEY) === "1") root.setAttribute("data-qr-invert", "true");
  try {
    var q = /[?&]lang=([A-Za-z-]+)/.exec(global.location.search);
    var hint = (q ? q[1] : read(LOCALE_KEY) || "").toLowerCase();
    if (/^(ar|he|iw)\b/.test(hint)) {
      root.setAttribute("dir", "rtl");
      root.setAttribute("lang", hint.indexOf("ar") === 0 ? "ar" : "he");
    }
  } catch (e) { /* ignore */ }

  apply();
  watchHA();
  global.addEventListener("focus", apply);
  doc.addEventListener("visibilitychange", function () { if (!doc.hidden) apply(); });

  global.AntiMatterTheme = {
    get: function () { return current; },
    getOverride: function () { return memOverride; },
    source: function () { return currentSource; },
    set: function (mode) {
      var m = norm(mode) || "auto";
      memOverride = m;
      write(KEY, m === "auto" ? null : m);
      apply();
      return current;
    },
    setAddonTheme: function (v) {
      var a = norm(v) || "auto";
      addon = a;
      write(ADDON_KEY, a === "auto" ? null : a);
      apply();
      return current;
    },
    setMetaColor: function (c) {
      metaOverride = c || null;
      syncMeta();
    },
    onChange: function (cb) {
      if (typeof cb !== "function") return function () {};
      listeners.push(cb);
      return function () {
        var i = listeners.indexOf(cb);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
    apply: apply,
  };
})(window);
