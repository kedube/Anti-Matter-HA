/**
 * Anti-Matter 3.0 boot: startup sequence + the shell-level controls the foundation owns.
 * Loads LAST (after core.js and every module). Modules have registered their AM.on
 * listeners and AM.provide actions by the time this runs.
 *
 * Sequence: GET /api/info -> AntiMatterTheme.setAddonTheme -> AntiMatterI18n.initI18n
 * (emits "locale") -> version badge + shell wiring -> reveal (html.am-booting removed,
 * AM.ready resolves) -> AM.load() (emits "vault" + "trash") -> polling -> session log.
 *
 * Owns: brand, Scan/New buttons (app bar, dock, empty vault), Display menu (theme +
 * invert), Language menu/sheet, More sheet, sidebar tools (Trash, Backups, Import &
 * export, backup card, trash badge), view-bar Invert button, Manage-categories sheet,
 * Keyboard-shortcuts dialog, the hidden import file input, the load-error block and the
 * global shortcuts "/", "N", "S", "I", "?".
 */
(function (global) {
  "use strict";

  var AM = global.AM;
  var I18N = global.AntiMatterI18n;
  var THEME = global.AntiMatterTheme;
  var doc = global.document;
  var h = AM.h, t = AM.t, icon = AM.icon, $ = AM.byId;
  var IS_MAC = /Mac|iPhone|iPad/.test(global.navigator.platform || global.navigator.userAgent || "");
  var MOD = IS_MAC ? "⌘" : "Ctrl";

  function act(name) {
    var args = Array.prototype.slice.call(arguments, 1);
    return AM.act.apply(null, [name].concat(args));
  }
  function on(id, evt, fn) {
    var el = $(id);
    if (el) el.addEventListener(evt, fn);
    return el;
  }
  function langInfo(code) {
    var list = I18N.LANGUAGES;
    for (var i = 0; i < list.length; i++) if (list[i].code === code) return list[i];
    return { code: code, name: code, english: code, dir: "ltr" };
  }
  function displayName(code) {
    try {
      var dn = new Intl.DisplayNames([I18N.getLocale()], { type: "language" });
      var n = dn.of(code);
      if (n && n !== code) return n.charAt(0).toLocaleUpperCase() + n.slice(1);
    } catch (e) { /* old engine */ }
    return langInfo(code).english;
  }

  // =========================================================================
  // Scan / New / tools entry points
  // =========================================================================
  function openScan(source) { act("openScanner", { mode: "vault", source: source || "camera" }); }
  function openNew() { act("openEditor", null); }
  function pickImport() { var f = $("import-file"); if (f) { f.value = ""; f.click(); } }

  function wireEntryPoints() {
    ["btn-scan", "dock-scan", "empty-scan"].forEach(function (id) { on(id, "click", function () { openScan(); }); });
    ["btn-new", "dock-new", "empty-new"].forEach(function (id) { on(id, "click", openNew); });
    on("empty-import", "click", pickImport);
    on("import-file", "change", function (e) {
      var file = e.target.files && e.target.files[0];
      e.target.value = ""; // the same file can be picked again
      if (file) act("importFile", file);
    });
    on("nav-trash", "click", function () { act("openTrash"); });
    on("nav-backups", "click", function () { act("openBackup"); });
    on("backup-card", "click", function () { act("openBackup"); });
    on("nav-io", "click", function () { act("openImportExport"); });
    on("btn-new-category", "click", function () { act("openCategoryEditor", null); });
    on("btn-more", "click", openMore);
    on("dock-more", "click", openMore);
    on("categories-new", "click", function () { act("openCategoryEditor", null); });
    on("brand", "click", function () {
      if (AM.ha.needsMenuButton()) { AM.ha.toggleMenu(); return; }
      try { global.scrollTo({ top: 0, behavior: AM.mq.reducedMotion.matches ? "auto" : "smooth" }); } catch (e) { global.scrollTo(0, 0); }
      AM.emit("home");
    });
    on("load-error-retry", "click", load);
    AM.provide("openCategoryManager", function () { renderCategories(); AM.sheets.open("sheet-categories"); });
    AM.provide("openShortcuts", openShortcuts);
    AM.provide("openLanguage", function (anchor) { openLanguage(anchor); });
    AM.provide("pickImportFile", pickImport);
  }

  // =========================================================================
  // Theme (Display menu + More sheet) and QR invert
  // =========================================================================
  function syncTheme() {
    var mode = THEME.getOverride();
    AM.$$('[data-theme-seg] [role="radio"], #display-theme [role="radio"]').forEach(function (b) {
      b.setAttribute("aria-checked", String(b.getAttribute("data-value") === mode));
    });
    AM.$$('#display-theme, [data-theme-seg]').forEach(function (g) { AM.radio.sync(g); });
  }
  function themeSeg() {
    var g = h("div", { class: "seg seg--block", role: "radiogroup", "aria-label": t("display.theme"), "data-theme-seg": "" },
      [["auto", "sun-moon", "display.auto"], ["light", "sun", "display.light"], ["dark", "moon", "display.dark"]].map(function (o) {
        return h("button", { type: "button", class: "seg__btn", role: "radio", "aria-checked": "false", "data-value": o[0] }, icon(o[1]), h("span", null, t(o[2])));
      }));
    return g;
  }
  function setThemeMode(mode) {
    THEME.set(mode);
    AM.log("Theme: " + mode + " -> " + THEME.get());
    syncTheme();
  }
  function syncInvert() {
    var on = !!AM.prefs.get("invert");
    ["btn-invert"].forEach(function (id) { var b = $(id); if (b) b.setAttribute("aria-pressed", String(on)); });
    AM.$$("#display-invert, [data-invert-switch]").forEach(function (s) { s.checked = on; });
  }
  function wireDisplay() {
    doc.addEventListener("click", function (e) {
      var r = e.target.closest('#display-theme [role="radio"], [data-theme-seg] [role="radio"]');
      if (r) setThemeMode(r.getAttribute("data-value"));
    });
    doc.addEventListener("change", function (e) {
      if (e.target.id === "display-invert" || e.target.hasAttribute("data-invert-switch")) AM.setInvert(e.target.checked);
    });
    ["btn-display", "btn-display-phone"].forEach(function (id) {
      on(id, "click", function (e) {
        AM.popover.toggle($("menu-display"), e.currentTarget, { placement: "bottom-end", focus: '#display-theme [aria-checked="true"]' });
      });
    });
    on("btn-invert", "click", function () { AM.setInvert(!AM.prefs.get("invert")); });
    AM.on("prefs", function (p) { if (p.name === "invert") syncInvert(); });
    AM.on("theme", syncTheme);
    syncTheme();
    syncInvert();
  }

  // =========================================================================
  // Language menu (desktop popover) + sheet (phones/tablets)
  // =========================================================================
  function langButton(code, current, isAuto) {
    var info = isAuto ? null : langInfo(code);
    var checked = isAuto ? current === "auto" : current === code;
    var main = isAuto ? t("lang.automatic") : info.name;
    var sub = isAuto
      ? (current === "auto" ? t("lang.follows_ha", { language: langInfo(I18N.getLocale()).name }) : t("lang.follows_ha_short"))
      : displayName(code);
    return h("button", {
      type: "button", role: "menuitemradio", tabindex: "-1",
      class: ["menu__item", isAuto && "menu__item--auto"],
      "aria-checked": String(checked), "data-lang": isAuto ? "auto" : code,
    },
      isAuto ? icon("globe") : null,
      h("span", { class: "menu__sub" },
        h("span", { class: "menu__main", lang: isAuto ? null : code }, isAuto ? main : h("bdi", { dir: info.dir }, main)),
        h("span", null, sub)),
      isAuto ? icon("check", "menu__check") : h("span", { class: "lang-code", dir: "ltr" }, code));
  }
  function renderLangList(list, query) {
    if (!list) return;
    var current = I18N.getOverride();
    var q = String(query || "").trim().toLocaleLowerCase();
    var match = function (s) { return String(s || "").toLocaleLowerCase().indexOf(q) >= 0; };
    var kids = [];
    if (!q || match(t("lang.automatic")) || match("auto")) kids.push(langButton("auto", current, true));
    I18N.LANGUAGES.forEach(function (l) {
      if (!q || match(l.name) || match(l.english) || match(l.code) || match(displayName(l.code))) kids.push(langButton(l.code, current, false));
    });
    if (!kids.length) kids.push(h("p", { class: "lang-menu__empty", role: "presentation" }, t("lang.no_match")));
    AM.fill(list, kids);
  }
  function chooseLang(code) {
    AM.popover.close();
    if (AM.sheets.isOpen("sheet-lang")) AM.sheets.close("sheet-lang");
    I18N.setLocale(code, { persist: true }).then(function (loc) { AM.log("Language: " + code + " -> " + loc); });
  }
  function openLanguage(anchor) {
    var desktop = !AM.mq.tabletDown.matches && anchor;
    if (desktop) {
      var s = $("lang-search");
      s.value = "";
      renderLangList($("lang-list"), "");
      AM.popover.toggle($("menu-lang"), anchor, { placement: "bottom-end", focus: '[aria-checked="true"]' });
    } else {
      $("lang-sheet-search").value = "";
      renderLangList($("lang-sheet-list"), "");
      AM.sheets.open("sheet-lang", { initialFocus: '#lang-sheet-list [aria-checked="true"]' });
    }
  }
  function wireLanguage() {
    on("btn-language", "click", function (e) { openLanguage(e.currentTarget); });
    [["lang-search", "lang-list"], ["lang-sheet-search", "lang-sheet-list"]].forEach(function (p) {
      on(p[0], "input", function (e) { renderLangList($(p[1]), e.target.value); });
      on(p[0], "keydown", function (e) {
        if (e.key === "ArrowDown") {
          var first = $(p[1]).querySelector('[role="menuitemradio"]');
          if (first) { e.preventDefault(); first.focus(); }
        } else if (e.key === "Enter") {
          var only = $(p[1]).querySelector('[role="menuitemradio"]');
          if (only) { e.preventDefault(); chooseLang(only.getAttribute("data-lang")); }
        }
      });
      on(p[1], "click", function (e) {
        var b = e.target.closest("[data-lang]");
        if (b) chooseLang(b.getAttribute("data-lang"));
      });
    });
    // Arrow-key roving inside the sheet list (the popover gets it from AM.popover).
    on("lang-sheet-list", "keydown", function (e) {
      var items = AM.$$('[role="menuitemradio"]', $("lang-sheet-list"));
      var i = items.indexOf(doc.activeElement);
      var d = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
      if (!d || i < 0) return;
      e.preventDefault();
      (items[i + d] || (d < 0 ? $("lang-sheet-search") : items[i])).focus();
    });
    on("lang-sheet-back", "click", function () {
      AM.sheets.close("sheet-lang");
      openMore();
    });
    syncLangButton();
  }
  function syncLangButton() {
    var loc = I18N.getLocale();
    var code = $("lang-code");
    if (code) code.textContent = loc.split("-")[0].toUpperCase();
    var btn = $("btn-language");
    if (btn) {
      var label = t("lang.current", { language: langInfo(loc).name });
      btn.setAttribute("aria-label", label);
      btn.setAttribute("data-tip", label);
    }
  }

  // =========================================================================
  // More sheet (phone dock "More" and tablet ⋮)
  // =========================================================================
  function trashCount() {
    var tr = AM.store.trash || {};
    return (tr.codes || []).length + (tr.categories || []).length;
  }
  function moreItem(o) {
    var tag = o.switchId ? "label" : "button";
    var attrs = { class: "more-item", id: o.id || null };
    if (tag === "button") attrs.type = "button";
    return h(tag, attrs,
      icon(o.icon),
      h("span", { class: "more-item__txt" }, h("span", null, o.label), o.desc ? h("small", null, o.desc) : null),
      o.switchId ? h("input", { type: "checkbox", class: "switch", role: "switch", id: o.switchId, "data-invert-switch": "", checked: !!o.checked }) : null,
      o.badge ? h("span", { class: "badge" }, o.badge) : null,
      o.chev ? icon("chevron-right", "chev icon--flip-rtl") : null);
  }
  function renderMore() {
    var body = $("more-body");
    if (!body) return;
    var override = I18N.getOverride();
    var langDesc = override === "auto"
      ? t("lang.auto_current", { language: langInfo(I18N.getLocale()).name })
      : langInfo(I18N.getLocale()).name;
    var n = trashCount();
    var trashCodes = (AM.store.trash.codes || []).length;
    var b = AM.backup.describe();
    var backupDesc = AM.store.backup
      ? (b.enabled ? h("span", null, h("span", { class: "more-item__dot", "aria-hidden": "true" }, "● "), t("more.backups_desc", { schedule: b.schedule, when: b.lastRun || t("backup.never"), kept: b.kept }))
        : t("backup.card_off_desc"))
      : null;
    var cats = AM.store.vault.categories.length;
    var info = AM.store.info || {};
    AM.fill(body, h("div", { class: "stack", style: "--gap:10px" },
      h("span", { class: "overline subtle more-section" }, t("display.title")),
      themeSeg(),
      h("div", { class: "more-list" },
        moreItem({ icon: "contrast", label: t("action.invert"), desc: t("display.invert_warn_short"), switchId: "more-invert", checked: AM.prefs.get("invert") }),
        moreItem({ id: "more-lang", icon: "languages", label: t("lang.label"), desc: langDesc, chev: true })),
      h("div", { class: "divider", role: "separator" }),
      h("span", { class: "overline subtle more-section" }, t("more.vault")),
      h("div", { class: "more-list" },
        moreItem({ id: "more-trash", icon: "trash-2", label: t("nav.trash"), desc: n ? t("more.trash_desc", { count: trashCodes }) : t("more.trash_empty"), badge: n ? AM.fmt.number(n) : null }),
        moreItem({ id: "more-backups", icon: "database-backup", label: t("nav.backups"), desc: backupDesc, chev: true }),
        moreItem({ id: "more-export", icon: "file-down", label: t("more.export"), desc: "anti-matter-export.json" }),
        moreItem({ id: "more-import", icon: "file-up", label: t("more.import"), desc: t("more.import_desc") }),
        moreItem({ id: "more-categories", icon: "tags", label: t("nav.manage_categories"), desc: t("more.categories_desc", { count: cats }), chev: true })),
      h("div", { class: "version-foot" },
        h("img", { src: "./static/assets/anti-matter-icon.png" + AM.V, alt: "", width: "18", height: "18", style: "border-radius:5px" }),
        h("span", { dir: "ltr" }, "Anti-Matter"),
        info.version ? h("span", { class: "mono", dir: "ltr" }, "v" + info.version) : null)
    ));
    syncTheme();
  }
  function openMore() {
    renderMore();
    AM.sheets.open("sheet-more");
  }
  function wireMore() {
    function closeThen(fn) { return function () { AM.sheets.close("sheet-more"); fn(); }; }
    on("more-body", "click", function (e) {
      var item = e.target.closest(".more-item");
      if (!item || !item.id) return;
      var map = {
        "more-lang": closeThen(function () { openLanguage(null); }),
        "more-trash": closeThen(function () { act("openTrash"); }),
        "more-backups": closeThen(function () { act("openBackup"); }),
        "more-export": closeThen(function () { act("exportVault"); }),
        "more-import": closeThen(pickImport),
        "more-categories": closeThen(function () { act("openCategoryManager"); }),
      };
      if (map[item.id]) map[item.id]();
    });
    ["locale", "trash", "backup", "vault", "theme"].forEach(function (ev) {
      AM.on(ev, function () { if (AM.sheets.isOpen("sheet-more")) renderMore(); });
    });
  }

  // =========================================================================
  // Sidebar tools: trash badge, backup card
  // =========================================================================
  function syncTrash() {
    var n = trashCount();
    var badge = $("nav-trash-n");
    if (badge) { badge.textContent = AM.fmt.number(n); badge.hidden = n === 0; }
    ["more-dot", "dock-more-dot"].forEach(function (id) { var d = $(id); if (d) d.hidden = n === 0; });
    var trashBtn = $("nav-trash");
    if (trashBtn) trashBtn.setAttribute("aria-label", n ? t("nav.trash_count", { count: n }) : t("nav.trash"));
  }
  function syncBackup() {
    var s = AM.store.backup;
    var card = $("backup-card");
    var freq = $("nav-backups-freq");
    if (!s) { if (card) card.hidden = true; return; }
    var b = AM.backup.describe(s);
    if (card) {
      card.hidden = false;
      card.classList.toggle("backup-card--off", !b.enabled);
      $("backup-card-title").textContent = b.enabled ? t("backup.card_on") : t("backup.card_off");
      $("backup-card-desc").textContent = b.enabled
        ? t("more.backups_desc", { schedule: b.schedule, when: b.lastRun || t("backup.never"), kept: b.kept })
        : t("backup.card_off_desc");
    }
    if (freq) freq.textContent = b.enabled ? b.freqLabel : t("backup.off_short");
  }

  // =========================================================================
  // Manage categories sheet
  // =========================================================================
  function renderCategories() {
    var body = $("categories-body");
    if (!body) return;
    var counts = AM.cat.counts();
    var list = AM.cat.list();
    if (!list.length) {
      AM.fill(body, h("p", { class: "cat-list__empty" }, t("category.none_yet")));
      return;
    }
    AM.fill(body, h("div", { class: "cat-list", role: "list" }, list.map(function (c) {
      var name = c.name || "";
      return h("div", { class: "list-row", role: "listitem" },
        AM.cat.markEl(c),
        h("span", { class: "list-row__txt" }, h("b", { dir: "auto" }, name), h("span", null, t("category.count", { count: counts[c.id] || 0 }))),
        h("span", { class: "list-row__actions" },
          h("button", { type: "button", class: "icon-btn icon-btn--sm", tip: t("nav.edit_category", { name: name }), "data-cat": c.id }, icon("pencil"))));
    })));
  }
  function wireCategories() {
    on("categories-body", "click", function (e) {
      var b = e.target.closest("[data-cat]");
      if (!b) return;
      var cat = AM.cat.get(b.getAttribute("data-cat"));
      if (cat) act("openCategoryEditor", cat);
    });
    ["vault", "locale"].forEach(function (ev) {
      AM.on(ev, function () { if (AM.sheets.isOpen("sheet-categories")) renderCategories(); });
    });
  }

  // =========================================================================
  // Keyboard shortcuts dialog
  // =========================================================================
  function openShortcuts() {
    var groups = [
      ["shortcuts.group_general", [
        ["shortcuts.search", ["/"]], ["shortcuts.scan", ["S"]], ["shortcuts.new", ["N"]],
        ["shortcuts.help", ["?"]], ["shortcuts.close", ["Esc"]]]],
      ["shortcuts.group_view", [
        ["shortcuts.views", ["1", "2", "3"]], ["shortcuts.zoom", [MOD, "+ / − / 0"]], ["shortcuts.invert", ["I"]]]],
      ["shortcuts.group_codes", [
        ["shortcuts.open", ["↵"]], ["shortcuts.edit", ["E"]], ["shortcuts.copy", ["C"]], ["shortcuts.present", ["P"]],
        ["shortcuts.decode", ["D"]], ["shortcuts.download", ["⇧", "D"]], ["shortcuts.select", ["X"]],
        ["shortcuts.select_all", [MOD, "A"]], ["shortcuts.delete", ["Del"]], ["shortcuts.flip", ["F"]],
        ["shortcuts.prev_next", ["↑", "↓"]], ["shortcuts.present_nav", ["←", "→"]]]],
    ];
    AM.fill($("shortcuts-body"), h("div", { class: "shortcuts" }, groups.map(function (g) {
      return h("section", { class: "shortcuts__group" },
        h("h3", { class: "overline subtle" }, t(g[0])),
        g[1].map(function (r) {
          return h("div", { class: "shortcuts__row" }, h("span", null, t(r[0])),
            h("span", { class: "shortcuts__keys", dir: "ltr" }, r[1].map(function (k) { return h("kbd", { class: "kbd" }, k); })));
        }));
    })));
    AM.sheets.open("dialog-shortcuts");
  }

  // =========================================================================
  // Global shortcuts (app scope: no layer or popover open)
  // =========================================================================
  function wireShortcuts() {
    AM.shortcuts.register("/", function () {
      var s = $("search");
      if (!s) return false;
      s.focus();
      s.select();
    });
    AM.shortcuts.register("s", function () { openScan(); });
    AM.shortcuts.register("n", function () { openNew(); });
    AM.shortcuts.register("i", function () { AM.setInvert(!AM.prefs.get("invert")); });
    AM.shortcuts.register("?", function () { openShortcuts(); }, { when: function () { return !AM.mq.coarse.matches; } });
  }

  // =========================================================================
  // Home Assistant shell (brand as HA menu button when HA shows no header)
  // =========================================================================
  function syncBrand() {
    var brand = $("brand");
    if (!brand) return;
    var menu = AM.ha.needsMenuButton();
    brand.toggleAttribute("data-ha-menu", menu);
    brand.setAttribute("aria-label", menu ? t("app.ha_menu") : t("app.home"));
  }

  // =========================================================================
  // Locale-driven refresh of the foundation's own dynamic text
  // =========================================================================
  function onLocale() {
    syncLangButton();
    syncTrash();
    syncBackup();
    syncBrand();
    syncTheme();
    if (AM.popover.isOpen($("menu-lang"))) renderLangList($("lang-list"), $("lang-search").value);
    if (AM.sheets.isOpen("sheet-lang")) renderLangList($("lang-sheet-list"), $("lang-sheet-search").value);
  }

  // =========================================================================
  // Load (with error state)
  // =========================================================================
  var loadedOnce = false;
  function load() {
    var err = $("load-error");
    if (err) err.hidden = true;
    var sk = $("view-loading");
    if (sk && !loadedOnce) sk.hidden = false;
    return AM.load().then(function (v) {
      loadedOnce = true;
      return v;
    }, function (e) {
      console.warn("[boot] vault load failed", e);
      if (sk) sk.hidden = true;
      if (err) {
        $("load-error-msg").textContent = (e && e.userMessage) || t("error.network");
        err.hidden = false;
      }
      setTimeout(function () { if (!loadedOnce && !doc.hidden) load(); }, 15000);
      return null;
    });
  }

  // =========================================================================
  // Boot
  // =========================================================================
  async function boot() {
    var info = null;
    try {
      info = await AM.api("/info");
    } catch (e) {
      info = { version: "", language: "auto", theme: "auto", ha_available: false };
    }
    AM.store.info = info;
    try { THEME.setAddonTheme(info.theme || "auto"); } catch (e) { /* ignore */ }
    try {
      await I18N.initI18n({ addonLanguage: info.language || "auto", legacyToggle: false, available: Array.isArray(info.translations) ? info.translations : undefined });
    } catch (e) {
      console.warn("[boot] i18n init failed", e);
    }

    var ver = $("app-version");
    if (ver && info.version) { ver.textContent = "v" + info.version; ver.hidden = false; }
    var title = $("view-title");
    if (title && !title.hasAttribute("data-owned")) title.textContent = t("nav.all_codes");

    wireEntryPoints();
    wireDisplay();
    wireLanguage();
    wireMore();
    wireCategories();
    wireShortcuts();
    AM.ha.initShell();
    AM.on("ha-shell", syncBrand);
    AM.on("trash", syncTrash);
    AM.on("backup", syncBackup);
    AM.on("locale", onLocale);
    syncTrash();
    syncBrand();
    AM.emit("info", info);

    doc.documentElement.classList.remove("am-booting");
    AM._resolveReady(info);

    await load();
    AM.startPolling();

    var view = AM.prefs.get("view");
    AM.log("Session started: ui=" + AM.version + " version=" + (info.version || "?") +
      " language=" + I18N.getLocale() + " (" + I18N.getOverride() + ")" +
      " theme=" + THEME.get() + " (" + THEME.getOverride() + ", " + THEME.source() + ")" +
      " qr_invert=" + (AM.prefs.get("invert") ? "on" : "off") + " view_mode=" + view +
      " ha=" + (info.ha_available ? "yes" : "no") + " viewport=" + global.innerWidth + "x" + global.innerHeight);
  }

  boot().catch(function (e) {
    console.error("[boot] failed", e);
    doc.documentElement.classList.remove("am-booting");
  });
})(window);
