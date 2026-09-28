/**
 * Anti-Matter category icons: window.AntiMatterCategoryIcons
 * ============================================================================
 * Data model (unchanged): a category stores a bare Material Design Icons name
 * ("motion-sensor"); an "mdi:" / "mdi-" prefix is accepted. Vaults from v1.0.0-1.0.3
 * stored Lucide ids, which normalizeIconId() maps to MDI names (ALIASES).
 *
 * Rendering (SPEC §4.2): the glyph ALWAYS sits inside a tinted `.cat-mark` tile
 * (--cat = stored hex, --cat-bg = same hex at 16% alpha, computed here: no color-mix).
 *   - 38 common names come from the small sprite brand/icons-mdi.svg (#mdi-<name>).
 *   - Any other name shows the category's first letter until the full vendored MDI
 *     webfont (vendor/mdi, ~400 KB) is loaded by loadFont(); every letter placeholder
 *     in the document is then upgraded in place to the font glyph. The font is only
 *     requested when it is needed: by the icon picker, or (idle) when a category in the
 *     vault uses a name outside the subset (ensureFontFor()).
 *
 * API
 *   DEFAULT_ICON, DEFAULT_COLOR, SUBSET, ALIASES, COMMON
 *   normalizeIconId(v)        -> MDI name (aliases applied, sanitised, default "folder")
 *   normalizeColor(v)         -> "#RRGGBB" (DEFAULT_COLOR when invalid)
 *   tint(hex, alpha=.16)      -> "rgba(r,g,b,a)"
 *   inSubset(id)              -> boolean
 *   glyph(id, {letter})       -> Element (sprite <svg>, font <i>, or letter <span>)
 *   mark(cat, {size, className, title}) -> <span class="cat-mark"> for {icon, color, name}
 *                                size: "sm" (default 28px) | "lg" (40px) | a number (px)
 *   loadFont()                -> Promise<string[]> all MDI names (also injects the CSS)
 *   ensureFontFor(ids)        loads the font in idle time when any id is outside the subset
 *   isFontLoaded()            -> boolean
 *   mountPicker(container, {value, color, onChange, label}) -> {getValue, setValue, setColor, focus}
 */
(function (global) {
  "use strict";

  var doc = global.document;
  var V = "?v=3.0.1";
  var SPRITE = "./static/brand/icons-mdi.svg" + V;
  var FONT_CSS = "./static/vendor/mdi/css/materialdesignicons.min.css" + V;
  var SVG_NS = "http://www.w3.org/2000/svg";
  var DEFAULT_ICON = "folder";
  var DEFAULT_COLOR = "#C9791A";

  var SUBSET = [
    "hvac", "lightbulb", "power-plug", "lock", "thermometer", "package-variant-closed", "tag-off-outline",
    "home", "sofa", "bed", "door-open", "garage", "fan", "television", "router", "speaker", "cctv",
    "shield-home", "motion-sensor", "water", "flower", "fridge", "washing-machine", "lamp", "ceiling-light",
    "blinds", "key", "battery-charging", "wifi", "lightning-bolt", "folder", "robot-vacuum", "thermostat",
    "smoke-detector", "doorbell-video", "leak", "radiator", "window-closed-variant",
  ];
  var SUBSET_SET = new Set(SUBSET);

  // Legacy Lucide ids (v1.0.0-1.0.3) -> MDI. "box" is the Box.com logo in MDI.
  var ALIASES = {
    "air-vent": "hvac", bath: "bathtub", "building-2": "office-building", "circle-dot": "radiobox-marked",
    "cooking-pot": "pot-steam", droplets: "water", "flower-2": "flower", "lamp-ceiling": "ceiling-light",
    moon: "weather-night", zap: "lightning-bolt", plug: "power-plug", refrigerator: "fridge",
    "scan-qr": "qrcode-scan", settings: "cog", sun: "white-balance-sunny", "toggle-right": "toggle-switch",
    "tree-pine": "pine-tree", tv: "television", wind: "weather-windy", box: "package-variant-closed",
  };

  // Shown in the picker before the user searches (46, all valid MDI names).
  var COMMON = [
    "folder", "home", "lightbulb", "lamp", "ceiling-light", "led-strip",
    "power-plug", "toggle-switch", "lock", "door", "window-closed-variant",
    "blinds", "garage", "thermometer", "water", "fan", "air-conditioner",
    "television", "speaker", "cctv", "motion-sensor", "gauge", "battery",
    "wifi", "router-network", "remote", "sofa", "bed", "fridge",
    "washing-machine", "stove", "shower", "flower", "tree", "car",
    "key", "shield-home", "leaf", "weather-night", "white-balance-sunny",
    "star", "heart", "cog", "tag", "package-variant", "map-marker",
  ];

  function t(key, vars) {
    var I = global.AntiMatterI18n;
    return I ? I.t(key, vars) : key;
  }

  function normalizeIconId(value) {
    var id = String(value == null ? "" : value)
      .trim()
      .toLowerCase()
      .replace(/^mdi[:-]/, "")
      .replace(/[^a-z0-9-]/g, "");
    if (!id) return DEFAULT_ICON;
    return Object.prototype.hasOwnProperty.call(ALIASES, id) ? ALIASES[id] : id;
  }

  function normalizeColor(value) {
    var s = String(value == null ? "" : value).trim();
    var m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s);
    if (!m) return DEFAULT_COLOR;
    var hx = m[1];
    if (hx.length === 3) hx = hx[0] + hx[0] + hx[1] + hx[1] + hx[2] + hx[2];
    return "#" + hx.toUpperCase();
  }

  function tint(hex, alpha) {
    var n = parseInt(normalizeColor(hex).slice(1), 16);
    var a = alpha == null ? 0.16 : alpha;
    return "rgba(" + (n >> 16) + "," + ((n >> 8) & 255) + "," + (n & 255) + "," + a + ")";
  }

  function inSubset(id) {
    return SUBSET_SET.has(normalizeIconId(id));
  }

  // ---------------------------------------------------------------------------
  // Full MDI webfont (lazy)
  // ---------------------------------------------------------------------------
  var fontPromise = null;
  var fontNames = null; // Set once loaded

  function upgradePlaceholders(scope) {
    if (!fontNames) return;
    var list = (scope || doc).querySelectorAll(".cat-mark__letter[data-mdi]");
    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      var id = el.getAttribute("data-mdi");
      if (fontNames.has(id)) el.replaceWith(fontGlyph(id));
    }
  }

  function loadFont() {
    if (fontPromise) return fontPromise;
    fontPromise = fetch(FONT_CSS, { cache: "force-cache" })
      .then(function (r) { return r.ok ? r.text() : ""; })
      .then(function (css) {
        var names = new Set();
        var re = /\.mdi-([a-z0-9-]+)::?before/g;
        var m;
        while ((m = re.exec(css)) !== null) names.add(m[1]);
        if (!doc.querySelector('link[data-mdi-font]')) {
          var link = doc.createElement("link");
          link.rel = "stylesheet";
          link.href = FONT_CSS;
          link.setAttribute("data-mdi-font", "");
          doc.head.appendChild(link);
        }
        var ready = doc.fonts && doc.fonts.load ? doc.fonts.load('24px "Material Design Icons"').catch(function () {}) : Promise.resolve();
        return ready.then(function () {
          fontNames = names;
          upgradePlaceholders(doc);
          try { global.dispatchEvent(new CustomEvent("antimatter:mdi-font")); } catch (e) { /* ignore */ }
          return Array.from(names);
        });
      })
      .catch(function () {
        fontPromise = null; // retry later
        return COMMON.slice();
      });
    return fontPromise;
  }

  function ensureFontFor(ids) {
    if (fontNames || fontPromise) return;
    var need = false;
    (ids || []).forEach(function (v) { if (!SUBSET_SET.has(normalizeIconId(v))) need = true; });
    if (!need) return;
    var go = function () { loadFont(); };
    if (global.requestIdleCallback) global.requestIdleCallback(go, { timeout: 3000 });
    else global.setTimeout(go, 800);
  }

  // ---------------------------------------------------------------------------
  // Elements
  // ---------------------------------------------------------------------------
  function spriteGlyph(id) {
    var svg = doc.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", "icon icon--fill");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    var use = doc.createElementNS(SVG_NS, "use");
    use.setAttribute("href", SPRITE + "#mdi-" + id);
    svg.appendChild(use);
    return svg;
  }

  function fontGlyph(id) {
    var i = doc.createElement("i");
    i.className = "mdi mdi-" + id;
    i.setAttribute("aria-hidden", "true");
    return i;
  }

  function letterGlyph(id, letter) {
    var s = doc.createElement("span");
    s.className = "cat-mark__letter";
    s.setAttribute("aria-hidden", "true");
    s.setAttribute("data-mdi", id);
    var ch = String(letter || "").trim();
    s.textContent = ch ? Array.from(ch)[0].toLocaleUpperCase() : "•";
    return s;
  }

  function glyph(iconId, opts) {
    var id = normalizeIconId(iconId);
    if (SUBSET_SET.has(id)) return spriteGlyph(id);
    if (fontNames && fontNames.has(id)) return fontGlyph(id);
    return letterGlyph(id, opts && opts.letter);
  }

  function mark(cat, opts) {
    opts = opts || {};
    cat = cat || {};
    var color = normalizeColor(cat.color);
    var el = doc.createElement("span");
    var cls = "cat-mark";
    if (opts.size === "lg") cls += " cat-mark--lg";
    if (opts.className) cls += " " + opts.className;
    el.className = cls;
    el.style.setProperty("--cat", color);
    el.style.setProperty("--cat-bg", tint(color, 0.16));
    if (typeof opts.size === "number") el.style.setProperty("--cm", opts.size + "px");
    if (opts.title) el.setAttribute("title", opts.title);
    else el.setAttribute("aria-hidden", "true");
    el.appendChild(glyph(cat.icon, { letter: cat.name }));
    return el;
  }

  // ---------------------------------------------------------------------------
  // Icon picker (category editor): search + radiogroup grid
  // ---------------------------------------------------------------------------
  function humanize(id) {
    return id.replace(/-/g, " ");
  }

  function mountPicker(container, options) {
    options = options || {};
    var selected = normalizeIconId(options.value || DEFAULT_ICON);
    var allNames = null;
    var timer = null;
    var MAX = 140;

    container.textContent = "";
    container.classList.add("icon-picker");

    var searchWrap = doc.createElement("div");
    searchWrap.className = "search icon-picker__search";
    var sIcon = doc.createElementNS(SVG_NS, "svg");
    sIcon.setAttribute("class", "icon");
    sIcon.setAttribute("aria-hidden", "true");
    var sUse = doc.createElementNS(SVG_NS, "use");
    sUse.setAttribute("href", "./static/brand/icons.svg" + V + "#i-search");
    sIcon.appendChild(sUse);
    var search = doc.createElement("input");
    search.type = "search";
    search.className = "input";
    search.autocomplete = "off";
    search.spellcheck = false;
    search.setAttribute("dir", "ltr");
    search.setAttribute("data-i18n-placeholder", "category.search_icons");
    search.setAttribute("data-i18n-aria-label", "category.search_icons");
    search.placeholder = t("category.search_icons");
    search.setAttribute("aria-label", t("category.search_icons"));
    searchWrap.appendChild(sIcon);
    searchWrap.appendChild(search);

    var grid = doc.createElement("div");
    grid.className = "icon-grid";
    grid.setAttribute("role", "radiogroup");
    grid.setAttribute("aria-label", options.label || t("category.icon"));

    var empty = doc.createElement("p");
    empty.className = "icon-picker__empty subtle";
    empty.hidden = true;

    container.appendChild(searchWrap);
    container.appendChild(grid);
    container.appendChild(empty);

    function setColor(hex) {
      var c = normalizeColor(hex);
      container.style.setProperty("--cat", c);
      container.style.setProperty("--cat-bg", tint(c, 0.16));
    }
    setColor(options.color);

    function button(name) {
      var b = doc.createElement("button");
      b.type = "button";
      b.setAttribute("role", "radio");
      b.setAttribute("data-icon", name);
      b.setAttribute("aria-label", humanize(name));
      b.setAttribute("data-tip", humanize(name));
      var on = name === selected;
      b.setAttribute("aria-checked", on ? "true" : "false");
      b.tabIndex = on ? 0 : -1;
      b.appendChild(glyph(name, { letter: name }));
      return b;
    }

    function render(names) {
      grid.textContent = "";
      var list = names.slice(0, MAX);
      var frag = doc.createDocumentFragment();
      list.forEach(function (n) { frag.appendChild(button(n)); });
      grid.appendChild(frag);
      if (!grid.querySelector('[aria-checked="true"]') && grid.firstElementChild) grid.firstElementChild.tabIndex = 0;
      empty.hidden = list.length > 0;
      if (!list.length) empty.textContent = t("category.no_icons", { query: search.value.trim() });
    }

    function defaults() {
      var out = [];
      if (selected && COMMON.indexOf(selected) === -1) out.push(selected);
      return out.concat(COMMON);
    }

    function filter(q) {
      q = String(q || "").trim().toLowerCase().replace(/\s+/g, "-");
      if (!q) return render(defaults());
      var src = allNames || COMMON.concat(SUBSET.filter(function (n) { return COMMON.indexOf(n) === -1; }));
      var starts = [];
      var contains = [];
      for (var i = 0; i < src.length && starts.length < MAX; i++) {
        var n = src[i];
        if (n.indexOf(q) === 0) starts.push(n);
        else if (contains.length < MAX && n.indexOf(q) > 0) contains.push(n);
      }
      render(starts.concat(contains));
    }

    function setSelected(id, notify) {
      selected = normalizeIconId(id);
      var btns = grid.querySelectorAll("[role=radio]");
      for (var i = 0; i < btns.length; i++) {
        var on = btns[i].getAttribute("data-icon") === selected;
        btns[i].setAttribute("aria-checked", on ? "true" : "false");
        btns[i].tabIndex = on ? 0 : -1;
      }
      if (notify && typeof options.onChange === "function") options.onChange(selected);
    }

    grid.addEventListener("click", function (e) {
      var b = e.target.closest("[role=radio]");
      if (b) setSelected(b.getAttribute("data-icon"), true);
    });

    grid.addEventListener("keydown", function (e) {
      var b = e.target.closest("[role=radio]");
      if (!b) return;
      var btns = Array.prototype.slice.call(grid.querySelectorAll("[role=radio]"));
      var i = btns.indexOf(b);
      var cols = 1;
      while (cols < btns.length && btns[cols].offsetTop === btns[0].offsetTop) cols++;
      var rtl = doc.documentElement.getAttribute("dir") === "rtl";
      var step = { ArrowRight: rtl ? -1 : 1, ArrowLeft: rtl ? 1 : -1, ArrowDown: cols, ArrowUp: -cols }[e.key];
      var next = null;
      if (step) next = btns[Math.max(0, Math.min(btns.length - 1, i + step))];
      else if (e.key === "Home") next = btns[0];
      else if (e.key === "End") next = btns[btns.length - 1];
      if (!next) return;
      e.preventDefault();
      next.focus();
      setSelected(next.getAttribute("data-icon"), true);
    });

    search.addEventListener("input", function () {
      clearTimeout(timer);
      timer = setTimeout(function () { filter(search.value); }, 120);
    });
    search.addEventListener("keydown", function (e) {
      if (e.key === "ArrowDown") {
        var first = grid.querySelector('[aria-checked="true"]') || grid.querySelector("[role=radio]");
        if (first) { e.preventDefault(); first.focus(); }
      }
    });

    render(defaults());
    loadFont().then(function (names) {
      allNames = names && names.length > COMMON.length ? names : null;
      if (search.value.trim()) filter(search.value);
      else upgradePlaceholders(grid);
    });

    return {
      getValue: function () { return selected; },
      setValue: function (id) {
        selected = normalizeIconId(id);
        search.value = "";
        render(defaults());
      },
      setColor: setColor,
      focus: function () { search.focus(); },
    };
  }

  global.AntiMatterCategoryIcons = {
    DEFAULT_ICON: DEFAULT_ICON,
    DEFAULT_COLOR: DEFAULT_COLOR,
    SUBSET: SUBSET.slice(),
    ALIASES: Object.assign({}, ALIASES),
    COMMON: COMMON.slice(),
    normalizeIconId: normalizeIconId,
    normalizeColor: normalizeColor,
    tint: tint,
    inSubset: inSubset,
    glyph: glyph,
    mark: mark,
    loadFont: loadFont,
    ensureFontFor: ensureFontFor,
    isFontLoaded: function () { return !!fontNames; },
    mountPicker: mountPicker,
  };
})(typeof window !== "undefined" ? window : globalThis);
