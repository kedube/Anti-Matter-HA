/**
 * Anti-Matter UI internationalisation: window.AntiMatterI18n
 * ============================================================================
 * Vanilla JS, no build step. Runs inside Home Assistant's ingress iframe.
 *
 * LOCALE FILES (for translators)
 *   static/locales/<code>.json, where <code> is the Home Assistant language key:
 *   en de nl fr es it pt-BR pt pl sv da nb fi cs hu ru uk tr ja ko zh-Hans zh-Hant he ar
 *   Each file is ONE flat JSON object, "dotted.key" -> value (no nesting):
 *     "status.selected": "{count} selected",
 *     "status.codes": { "one": "{count} code", "other": "{count} codes" }
 *   - A value is a string or a plural object. Plural objects hold CLDR categories
 *     (zero one two few many other). "other" is required. The category comes from
 *     Intl.PluralRules(locale).select(vars.count). Categories per language:
 *       other ............................ ja ko zh-Hans zh-Hant
 *       one other ........................ en de nl sv da nb fi hu tr
 *       one many other ................... fr es it pt pt-BR   (many = millions)
 *       one few many other ............... pl cs ru uk
 *       one two other .................... he
 *       zero one two few many other ...... ar
 *   - Keep {placeholders} as-is. Values are plain text (set via textContent),
 *     so never put HTML in them.
 *   - A missing or empty ("") key falls back to en.json, then to the key itself,
 *     so partial translations are fine. A missing file means English strings.
 *
 * API (for developers)
 *   LANGUAGES             [{code, name (native), english, dir: "ltr"|"rtl"}], 24 entries,
 *                         in display order (English first, then by native name).
 *   initI18n(opts?)       -> Promise<locale>. opts.addonLanguage ("auto"|code) skips the
 *                         ./api/info fetch. opts.legacyToggle === false leaves #btn-lang alone.
 *                         opts.available = codes that ship a locale file (/api/info
 *                         .translations): other languages are not fetched (English strings).
 *   t(key, vars?)         -> string. {name} placeholders are replaced literally. Any
 *                         vars value that is a JS number is formatted with
 *                         Intl.NumberFormat(locale), so pass PINs, codes and IDs as strings.
 *   has(key)              -> boolean (current locale or English).
 *   setLocale(code|"auto", {persist = true} = {}) -> Promise<locale>. "auto" clears
 *                         the override and re-resolves. persist writes localStorage.
 *   getLocale() getDir() getOverride() ("auto" or code)
 *   onChange(cb)          -> unsubscribe fn. Calls cb(locale) after initI18n and after
 *                         every change. The window event "antimatter:locale" {locale, dir}
 *                         also fires.
 *   applyToDom(root = document)
 *   fmt.date(v, opts?) fmt.dateTime(v, opts?) fmt.number(n, opts?) fmt.percent(n0to100, opts?)
 *   fmt.list(arr, "conjunction"|"disjunction"|"unit") fmt.relative(v)
 *                         v = ISO string | Date | epoch ms. "unit" = neutral list, no "and".
 *   compare(a, b)         Intl.Collator(locale, {sensitivity: "base", numeric: true}).
 *                         Also available as fmt.compare.
 *   matchLocale(tag)      -> supported code | null (aliases: pt-PT->pt, zh-TW->zh-Hant,
 *                         no/nn->nb, iw->he, de-AT->de, ...).
 *
 * RESOLUTION ORDER
 *   ?lang=<code> -> saved override (localStorage "antimatter-locale", "auto"/missing =
 *   none) -> add-on option (/api/info .language) -> HA parent frame <html lang> ->
 *   navigator.languages -> "en". While the locale is automatic (none of the first three
 *   apply), HA's <html lang> is watched and the UI switches live.
 *   Sets <html lang dir data-script="latin|cyrillic|greek|cjk|hebrew|arabic">.
 *
 * DOM ATTRIBUTES (applyToDom; values are set as text/attributes, never HTML)
 *   data-i18n="<key>"           -> textContent
 *   data-i18n-placeholder       -> placeholder
 *   data-i18n-title             -> title
 *   data-i18n-aria-label        -> aria-label
 *   data-i18n-tip               -> data-tip AND aria-label (legacy behaviour)
 *   data-i18n-vars='{"count":3}' JSON vars for the element's keys
 *
 * LEGACY (the pre-redesign UI): SUPPORTED (array of codes), LOCALE_LABELS,
 *   LOCALE_FLAGS and toggleLocale(). initI18n() binds #btn-lang to toggleLocale unless
 *   opts.legacyToggle === false or the button has aria-haspopup / data-lang-menu.
 *   The toggle cycles auto-locale -> en -> nl as a session-only override (not saved).
 *   It also keeps #btn-lang-flag and #btn-lang-label up to date.
 *   window.ADDON_LANGUAGE (set by the old app.js) is honoured when opts.addonLanguage
 *   is absent.
 */
(function (global) {
  "use strict";

  const doc = global.document;
  const DEFAULT_LOCALE = "en";
  const STORAGE_KEY = "antimatter-locale";
  const INFO_URL = "./api/info";
  const POLL_MS = 2000;

  // [code, native name, English name]. Display order: English, then by native name
  // (Latin, Cyrillic, Hebrew, Arabic, CJK). The native names are also the values
  // of the add-on `language` option in config.yaml (see options.py).
  const LANGUAGES = Object.freeze(
    [
      ["en", "English", "English"],
      ["cs", "Čeština", "Czech"],
      ["da", "Dansk", "Danish"],
      ["de", "Deutsch", "German"],
      ["es", "Español", "Spanish"],
      ["fr", "Français", "French"],
      ["it", "Italiano", "Italian"],
      ["hu", "Magyar", "Hungarian"],
      ["nl", "Nederlands", "Dutch"],
      ["nb", "Norsk bokmål", "Norwegian Bokmål"],
      ["pl", "Polski", "Polish"],
      ["pt-BR", "Português (Brasil)", "Portuguese (Brazil)"],
      ["pt", "Português (Portugal)", "Portuguese (Portugal)"],
      ["fi", "Suomi", "Finnish"],
      ["sv", "Svenska", "Swedish"],
      ["tr", "Türkçe", "Turkish"],
      ["ru", "Русский", "Russian"],
      ["uk", "Українська", "Ukrainian"],
      ["he", "עברית", "Hebrew"],
      ["ar", "العربية", "Arabic"],
      ["ja", "日本語", "Japanese"],
      ["ko", "한국어", "Korean"],
      ["zh-Hans", "简体中文", "Chinese (Simplified)"],
      ["zh-Hant", "繁體中文", "Chinese (Traditional)"],
    ].map(([code, name, english]) =>
      Object.freeze({ code, name, english, dir: code === "he" || code === "ar" ? "rtl" : "ltr" })
    )
  );
  const CODES = LANGUAGES.map((l) => l.code);
  const BY_CODE = new Map(LANGUAGES.map((l) => [l.code, l]));
  const BY_LOWER = new Map(CODES.map((c) => [c.toLowerCase(), c]));
  const SCRIPTS = {
    ru: "cyrillic", uk: "cyrillic", he: "hebrew", ar: "arabic",
    ja: "cjk", ko: "cjk", "zh-Hans": "cjk", "zh-Hant": "cjk",
  }; // everything else: latin ("greek" is reserved for a future el locale)
  const AUTO_SOURCES = new Set(["ha", "browser", "default"]);

  const hasOwn = (o, k) => o != null && Object.prototype.hasOwnProperty.call(o, k);

  // ---------------------------------------------------------------------------
  // Tag matching: any BCP-47 / POSIX-ish tag -> one of CODES, or null.
  // ---------------------------------------------------------------------------
  function matchLocale(input) {
    if (input == null) return null;
    const tag = String(input).trim().split(/[.@]/)[0].replace(/_/g, "-");
    const lower = tag.toLowerCase();
    if (!lower || lower === "auto") return null;
    if (BY_LOWER.has(lower)) return BY_LOWER.get(lower);
    const parts = lower.split("-").filter(Boolean);
    const lang = parts[0];
    let script = null;
    let region = null;
    for (const p of parts.slice(1)) {
      if (!script && /^[a-z]{4}$/.test(p)) script = p;
      else if (!region && /^([a-z]{2}|\d{3})$/.test(p)) region = p;
    }
    switch (lang) {
      case "zh":
        if (script === "hant") return "zh-Hant";
        if (script === "hans") return "zh-Hans";
        return region === "tw" || region === "hk" || region === "mo" ? "zh-Hant" : "zh-Hans";
      case "pt":
        return region === "br" ? "pt-BR" : "pt";
      case "no":
      case "nn":
      case "nb":
        return "nb";
      case "iw":
        return "he";
      default:
        return BY_LOWER.get(lang) || null;
    }
  }

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  let locale = DEFAULT_LOCALE;
  let source = "default"; // url | override | addon | ha | browser | default
  let strings = {}; // active locale map
  let fallback = {}; // en map
  let override = null; // explicit in-app choice (code) or null (= auto)
  let addonLanguage = "auto";
  let intl = {}; // per-locale Intl object cache, reset on change
  let applySeq = 0;
  let lastActivation = null;
  const fileCache = new Map(); // code -> Promise<object|null>
  const listeners = new Set();

  function localeBase() {
    const base = global.ANTIMATTER_LOCALE_BASE || "./static/locales/";
    return base.endsWith("/") ? base : base + "/";
  }

  function getDir() {
    return BY_CODE.get(locale)?.dir || "ltr";
  }

  // ---------------------------------------------------------------------------
  // Sources
  // ---------------------------------------------------------------------------
  function urlLocale() {
    try {
      return matchLocale(new URLSearchParams(global.location.search).get("lang"));
    } catch (e) {
      return null;
    }
  }

  function readSaved() {
    try {
      const v = global.localStorage.getItem(STORAGE_KEY);
      return v && v.toLowerCase() !== "auto" ? matchLocale(v) : null;
    } catch (e) {
      return null;
    }
  }

  function writeSaved(code) {
    try {
      if (code) global.localStorage.setItem(STORAGE_KEY, code);
      else global.localStorage.removeItem(STORAGE_KEY);
    } catch (e) {
      /* storage blocked: the choice lasts for this page only */
    }
  }

  function haFrames() {
    const out = [];
    try {
      if (global.parent && global.parent !== global) out.push(global.parent);
    } catch (e) { /* ignore */ }
    try {
      if (global.top && global.top !== global && out.indexOf(global.top) === -1) out.push(global.top);
    } catch (e) { /* ignore */ }
    return out;
  }

  function readHALang() {
    for (const f of haFrames()) {
      try {
        const lang = f.document.documentElement.getAttribute("lang");
        if (lang) return lang;
      } catch (e) { /* cross-origin: skip */ }
    }
    return null;
  }

  function navigatorLocale() {
    const nav = global.navigator || {};
    const list = Array.isArray(nav.languages) && nav.languages.length ? nav.languages : [nav.language];
    for (const tag of list) {
      const m = matchLocale(tag);
      if (m) return m;
    }
    return null;
  }

  function resolve(skipOverride) {
    const fromUrl = urlLocale();
    if (fromUrl) return { code: fromUrl, source: "url" };
    if (override && !skipOverride) return { code: override, source: "override" };
    const addon = matchLocale(addonLanguage);
    if (addon) return { code: addon, source: "addon" };
    const ha = matchLocale(readHALang());
    if (ha) return { code: ha, source: "ha" };
    const nav = navigatorLocale();
    if (nav) return { code: nav, source: "browser" };
    return { code: DEFAULT_LOCALE, source: "default" };
  }

  async function readAddonLanguage(opts) {
    if (opts.addonLanguage != null) return String(opts.addonLanguage);
    if (global.ADDON_LANGUAGE) return String(global.ADDON_LANGUAGE); // legacy app.js
    let timer = null;
    try {
      const ctrl = typeof AbortController === "function" ? new AbortController() : null;
      if (ctrl) timer = setTimeout(() => ctrl.abort(), 3000);
      const res = await fetch(INFO_URL, { cache: "no-store", signal: ctrl ? ctrl.signal : undefined });
      if (!res.ok) return "auto";
      const info = await res.json();
      return info && info.language ? String(info.language) : "auto";
    } catch (e) {
      return "auto";
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // ---------------------------------------------------------------------------
  // Loading + activation
  // ---------------------------------------------------------------------------
  let availableFiles = null; // Set of codes with a locale file (from /api/info .translations), or null = try any
  function loadFile(code) {
    // Only languages known to ship a file are fetched (initI18n opts.available); the rest use
    // English strings without a failing request.
    if (availableFiles && code !== DEFAULT_LOCALE && !availableFiles.has(code)) return Promise.resolve(null);
    if (!fileCache.has(code)) {
      const p = fetch(localeBase() + encodeURIComponent(code) + ".json", { cache: "no-cache" })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => (d && typeof d === "object" && !Array.isArray(d) ? d : null))
        .catch(() => null)
        .then((d) => {
          if (!d) fileCache.delete(code); // retry on a later switch
          return d;
        });
      fileCache.set(code, p);
    }
    return fileCache.get(code);
  }

  function activate(code, src) {
    const seq = ++applySeq;
    const run = (async () => {
      const [en, own] = await Promise.all([
        loadFile(DEFAULT_LOCALE),
        code === DEFAULT_LOCALE ? null : loadFile(code),
      ]);
      if (seq !== applySeq) return lastActivation; // superseded by a newer call
      fallback = en || {};
      strings = code === DEFAULT_LOCALE ? fallback : own || {};
      locale = code;
      source = src;
      intl = {};
      const html = doc.documentElement;
      html.setAttribute("lang", locale);
      html.setAttribute("dir", getDir());
      html.setAttribute("data-script", SCRIPTS[locale] || "latin");
      applyToDom(doc);
      updateFollow();
      notify();
      return locale;
    })();
    lastActivation = run;
    return run;
  }

  function notify() {
    for (const cb of Array.from(listeners)) {
      try {
        cb(locale);
      } catch (e) {
        console.error("[i18n] onChange listener failed", e);
      }
    }
    try {
      global.dispatchEvent(new CustomEvent("antimatter:locale", { detail: { locale, dir: getDir() } }));
    } catch (e) { /* ignore */ }
  }

  function onChange(cb) {
    if (typeof cb !== "function") return () => {};
    listeners.add(cb);
    return () => listeners.delete(cb);
  }

  async function initI18n(opts) {
    opts = opts || {};
    if (Array.isArray(opts.available)) availableFiles = new Set(opts.available);
    if (opts.legacyToggle !== false) bindLegacyToggle();
    override = readSaved();
    addonLanguage = await readAddonLanguage(opts);
    const r = resolve();
    return activate(r.code, r.source);
  }

  function setLocale(code, options) {
    const persist = !(options && options.persist === false);
    const raw = code == null ? "auto" : String(code).trim();
    if (!raw || raw.toLowerCase() === "auto") {
      override = null;
      if (persist) writeSaved(null);
      const r = resolve();
      return activate(r.code, r.source);
    }
    const match = matchLocale(raw);
    if (!match) {
      console.warn(`[i18n] unsupported locale "${raw}"`);
      return Promise.resolve(locale);
    }
    override = match;
    if (persist) writeSaved(match);
    return activate(match, "override");
  }

  // ---------------------------------------------------------------------------
  // Live follow of HA's language (only while the locale is automatic)
  // ---------------------------------------------------------------------------
  let observer = null;
  let pollTimer = null;
  let recheckTimer = null;
  let lastHALang = null;

  function stopFollow() {
    if (observer) {
      try { observer.disconnect(); } catch (e) { /* ignore */ }
      observer = null;
    }
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function scheduleRecheck() {
    clearTimeout(recheckTimer);
    recheckTimer = setTimeout(() => {
      if (!AUTO_SOURCES.has(source)) return;
      const r = resolve();
      if (r.code !== locale) activate(r.code, r.source);
    }, 50);
  }

  function updateFollow() {
    const frames = haFrames();
    if (!AUTO_SOURCES.has(source) || !frames.length) {
      stopFollow();
      return;
    }
    if (observer || pollTimer) return;
    for (const f of frames) {
      try {
        const target = f.document.documentElement;
        const mo = new global.MutationObserver(scheduleRecheck);
        mo.observe(target, { attributes: true, attributeFilter: ["lang", "dir"] });
        observer = mo;
        return;
      } catch (e) { /* cross-origin or unsupported: try next, then poll */ }
    }
    lastHALang = readHALang();
    pollTimer = setInterval(() => {
      const l = readHALang();
      if (l !== lastHALang) {
        lastHALang = l;
        scheduleRecheck();
      }
    }, POLL_MS);
  }

  // ---------------------------------------------------------------------------
  // Translation
  // ---------------------------------------------------------------------------
  const PLACEHOLDER = /\{([A-Za-z0-9_.-]+)\}/g;

  function usable(v) {
    return (typeof v === "string" && v !== "") || (v != null && typeof v === "object" && !Array.isArray(v));
  }

  const pluralRules = new Map(); // locale -> Intl.PluralRules

  function pluralCategory(loc, vars) {
    const n = vars && vars.count != null && vars.count !== "" ? Number(vars.count) : NaN;
    if (!Number.isFinite(n)) return "other";
    try {
      if (!pluralRules.has(loc)) pluralRules.set(loc, new Intl.PluralRules(loc));
      return pluralRules.get(loc).select(n);
    } catch (e) {
      return "other";
    }
  }

  function pickPlural(obj, loc, vars) {
    const s = obj[pluralCategory(loc, vars)];
    if (typeof s === "string" && s !== "") return s;
    return typeof obj.other === "string" && obj.other !== "" ? obj.other : null;
  }

  function formatVar(v) {
    if (typeof v === "number" && Number.isFinite(v)) return number(v);
    return v == null ? "" : String(v);
  }

  function t(key, vars) {
    const k = String(key);
    let text = null;
    const own = hasOwn(strings, k) ? strings[k] : undefined;
    if (usable(own)) text = typeof own === "string" ? own : pickPlural(own, locale, vars);
    if (text == null && strings !== fallback) {
      const en = hasOwn(fallback, k) ? fallback[k] : undefined;
      if (usable(en)) text = typeof en === "string" ? en : pickPlural(en, DEFAULT_LOCALE, vars);
    }
    if (text == null) return k;
    if (!vars || typeof vars !== "object") return text;
    // Function replacer: "$&", "$1" and "$$" in values are inserted literally.
    return text.replace(PLACEHOLDER, (m, name) => (hasOwn(vars, name) ? formatVar(vars[name]) : m));
  }

  function has(key) {
    const k = String(key);
    return usable(hasOwn(strings, k) ? strings[k] : undefined) || usable(hasOwn(fallback, k) ? fallback[k] : undefined);
  }

  // ---------------------------------------------------------------------------
  // DOM
  // ---------------------------------------------------------------------------
  function setAttr(el, name, value) {
    if (el.getAttribute(name) !== value) el.setAttribute(name, value);
  }

  const DOM_ATTRS = [
    ["data-i18n", (el, s) => { if (el.textContent !== s) el.textContent = s; }],
    ["data-i18n-placeholder", (el, s) => setAttr(el, "placeholder", s)],
    ["data-i18n-title", (el, s) => setAttr(el, "title", s)],
    ["data-i18n-aria-label", (el, s) => setAttr(el, "aria-label", s)],
    ["data-i18n-tip", (el, s) => { setAttr(el, "data-tip", s); setAttr(el, "aria-label", s); }],
  ];

  function elementVars(el) {
    const raw = el.getAttribute("data-i18n-vars");
    if (!raw) return undefined;
    try {
      const v = JSON.parse(raw);
      return v && typeof v === "object" ? v : undefined;
    } catch (e) {
      console.warn("[i18n] invalid data-i18n-vars JSON", raw);
      return undefined;
    }
  }

  function applyToDom(root) {
    const base = root && typeof root.querySelectorAll === "function" ? root : doc;
    for (const [attr, set] of DOM_ATTRS) {
      const sel = "[" + attr + "]";
      const els = Array.from(base.querySelectorAll(sel));
      if (base.nodeType === 1 && base.matches(sel)) els.unshift(base);
      for (const el of els) {
        const key = el.getAttribute(attr);
        if (key) set(el, t(key, elementVars(el)));
      }
    }
    updateLegacyButton();
  }

  // ---------------------------------------------------------------------------
  // Intl helpers bound to the active locale
  // ---------------------------------------------------------------------------
  function cached(name, make) {
    if (!hasOwn(intl, name)) {
      try {
        intl[name] = make(locale);
      } catch (e) {
        intl[name] = make(DEFAULT_LOCALE);
      }
    }
    return intl[name];
  }

  function toDate(v) {
    if (v instanceof Date) return isNaN(v) ? null : v;
    if (v == null || v === "") return null;
    const s = String(v);
    const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s); // local day, not UTC midnight
    const d = dateOnly
      ? new Date(+dateOnly[1], +dateOnly[2] - 1, +dateOnly[3])
      : new Date(typeof v === "number" ? v : s);
    return isNaN(d) ? null : d;
  }

  function dateWith(v, opts) {
    const d = toDate(v);
    if (!d) return v == null ? "" : String(v);
    return cached("dtf:" + JSON.stringify(opts), (l) => new Intl.DateTimeFormat(l, opts)).format(d);
  }

  function number(n, opts) {
    const x = Number(n);
    if (n == null || n === "" || !Number.isFinite(x)) return n == null ? "" : String(n);
    return cached("nf:" + JSON.stringify(opts || {}), (l) => new Intl.NumberFormat(l, opts)).format(x);
  }

  const LIST_SEP = { ja: "、", "zh-Hans": "、", "zh-Hant": "、", ar: "، " };

  function list(arr, type) {
    const items = Array.from(arr || [], (x) => String(x));
    // CLDR "unit" lists are meant for measurements ("3 ft 7 in") and drop the
    // separator in ru/tr/ja/ko/zh, so "unit" is a neutral enumeration here.
    if (type === "unit") return items.join(LIST_SEP[locale] || ", ");
    const kind = type === "disjunction" ? "disjunction" : "conjunction";
    try {
      return cached("lf:" + kind, (l) => new Intl.ListFormat(l, { type: kind, style: "long" })).format(items);
    } catch (e) {
      return items.join(", ");
    }
  }

  const REL_UNITS = [
    ["second", 60], ["minute", 60], ["hour", 24], ["day", 7],
    ["week", 4.34524], ["month", 12], ["year", Infinity],
  ];

  function relative(v) {
    const d = toDate(v);
    if (!d) return v == null ? "" : String(v);
    let rtf;
    try {
      rtf = cached("rtf", (l) => new Intl.RelativeTimeFormat(l, { numeric: "auto" }));
    } catch (e) {
      return fmt.dateTime(d); // very old browser without RelativeTimeFormat
    }
    let val = (d.getTime() - Date.now()) / 1000;
    if (Math.abs(val) < 45) return rtf.format(0, "second");
    for (const [unit, size] of REL_UNITS) {
      if (Math.abs(Math.round(val)) < size) return rtf.format(Math.round(val), unit);
      val /= size;
    }
    return rtf.format(Math.round(val), "year");
  }

  function compare(a, b) {
    return cached("coll", (l) => new Intl.Collator(l, { sensitivity: "base", numeric: true })).compare(
      a == null ? "" : String(a),
      b == null ? "" : String(b)
    );
  }

  const fmt = {
    date: (v, opts) => dateWith(v, opts || { dateStyle: "medium" }),
    dateTime: (v, opts) => dateWith(v, opts || { dateStyle: "medium", timeStyle: "short" }),
    number,
    percent: (n, opts) =>
      n == null || n === "" || !Number.isFinite(Number(n))
        ? n == null ? "" : String(n)
        : number(Number(n) / 100, Object.assign({ style: "percent", maximumFractionDigits: 0 }, opts)),
    list,
    relative,
    compare,
  };

  // ---------------------------------------------------------------------------
  // Legacy EN/NL toggle (pre-redesign header: #btn-lang, #btn-lang-flag, #btn-lang-label)
  // ---------------------------------------------------------------------------
  const LOCALE_LABELS = Object.fromEntries(CODES.map((c) => [c, c.toUpperCase()]));
  // Inline flag SVGs kept for the old button only; flags do not scale to 24 locales.
  const LOCALE_FLAGS = {
    en:
      '<svg xmlns="http://www.w3.org/2000/svg" class="flag" viewBox="0 0 60 30" aria-hidden="true">' +
      '<clipPath id="am-flag-uk-s"><path d="M0,0 v30 h60 v-30 z"/></clipPath>' +
      '<clipPath id="am-flag-uk-t"><path d="M30,15 h30 v15 z v15 h-30 z h-30 v-15 z v-15 h30 z"/></clipPath>' +
      '<g clip-path="url(#am-flag-uk-s)">' +
      '<path d="M0,0 v30 h60 v-30 z" fill="#012169"/>' +
      '<path d="M0,0 L60,30 M60,0 L0,30" stroke="#fff" stroke-width="6"/>' +
      '<path d="M0,0 L60,30 M60,0 L0,30" clip-path="url(#am-flag-uk-t)" stroke="#c8102e" stroke-width="4"/>' +
      '<path d="M30,0 v30 M0,15 h60" stroke="#fff" stroke-width="10"/>' +
      '<path d="M30,0 v30 M0,15 h60" stroke="#c8102e" stroke-width="6"/>' +
      "</g></svg>",
    nl:
      '<svg xmlns="http://www.w3.org/2000/svg" class="flag" viewBox="0 0 60 30" aria-hidden="true">' +
      '<rect width="60" height="10" y="0" fill="#AE1C28"/>' +
      '<rect width="60" height="10" y="10" fill="#ffffff"/>' +
      '<rect width="60" height="10" y="20" fill="#21468B"/>' +
      "</svg>",
  };

  function flagNode(code) {
    const svg = LOCALE_FLAGS[code];
    if (!svg || typeof DOMParser !== "function") return null;
    try {
      const parsed = new DOMParser().parseFromString(svg, "image/svg+xml").documentElement;
      return parsed && parsed.nodeName === "svg" ? doc.importNode(parsed, true) : null;
    } catch (e) {
      return null;
    }
  }

  let legacyFlagCode = null;

  function updateLegacyButton() {
    const flag = doc.getElementById("btn-lang-flag");
    const label = doc.getElementById("btn-lang-label");
    if (flag && legacyFlagCode !== locale) {
      const node = flagNode(locale);
      if (node) flag.replaceChildren(node);
      else flag.replaceChildren();
      flag.hidden = !node;
      legacyFlagCode = locale;
    }
    if (label) {
      const text = LOCALE_LABELS[locale] || locale.toUpperCase();
      if (label.textContent !== text) label.textContent = text;
    }
  }

  function toggleLocale() {
    // Cycles the automatic locale -> en -> nl (duplicates removed), e.g. nl <-> en
    // exactly as before for Dutch and English users. Session-only, like the old toggle.
    const auto = resolve(true).code;
    const cycle = [auto, "en", "nl"].filter((c, i, a) => a.indexOf(c) === i);
    const idx = cycle.indexOf(locale);
    const next = cycle[(idx + 1) % cycle.length];
    return next === auto ? setLocale("auto", { persist: false }) : setLocale(next, { persist: false });
  }

  let legacyBound = false;

  function bindLegacyToggle() {
    if (legacyBound) return;
    const btn = doc.getElementById("btn-lang");
    if (!btn || btn.hasAttribute("aria-haspopup") || btn.hasAttribute("data-lang-menu")) return;
    btn.addEventListener("click", () => { toggleLocale(); });
    legacyBound = true;
  }

  global.AntiMatterI18n = {
    LANGUAGES,
    t,
    has,
    initI18n,
    setLocale,
    getLocale: () => locale,
    getDir,
    getOverride: () => override || "auto",
    onChange,
    applyToDom,
    fmt,
    compare,
    matchLocale,
    // Legacy exports (old app.js / header toggle)
    SUPPORTED: CODES,
    LOCALE_LABELS,
    LOCALE_FLAGS,
    toggleLocale,
  };
})(window);
