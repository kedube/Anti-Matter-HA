/**
 * Anti-Matter 3.0 — js/dialogs.js
 * Category editor (#dialog-category), Trash (#dialog-trash), Backups (#dialog-backup),
 * Import & export (#dialog-import), and the bulk "move to Trash" action.
 *
 * Provides: openCategoryEditor(catOrNull, {onSaved(cat)}), openTrash(), openBackup(),
 *           openImportExport(), importFile(File), exportVault(), deleteCodes(ids, {confirm, undo}).
 * Confirm dialogs only for destructive actions; everything else gets an Undo toast.
 * Uses window.AM (core.js) and AntiMatterSheetKit (detail.js).
 */
(function (global) {
  "use strict";

  var AM = global.AM;
  var doc = global.document;
  var h = AM.h, t = AM.t, icon = AM.icon;

  function CI() { return global.AntiMatterCategoryIcons; }
  function K() { return global.AntiMatterSheetKit; }
  function str(s) { return String(s == null ? "" : s).trim(); }
  function lc(s) { return str(s).toLocaleLowerCase(); }
  function enc(id) { return encodeURIComponent(id); }

  // =========================================================================
  // Category editor
  // =========================================================================
  var PRESETS = ["#EF4444", "#F97316", "#F59E0B", "#84CC16", "#10B981", "#14B8A6", "#06B6D4", "#3B82F6", "#6366F1", "#8B5CF6", "#EC4899", "#64748B"];
  var C = null; // {cat, name, color, icon, onSaved, picker, refs}
  var CAT = "dialog-category";

  function openCategoryEditor(cat, opts) {
    opts = opts || {};
    if (typeof cat === "string") cat = AM.cat.get(cat);
    wireCategoryOnce();
    if (AM.sheets.isOpen(CAT)) { AM.sheets.open(CAT); return true; }
    var I = CI();
    C = {
      cat: cat || null,
      name: cat ? cat.name : "",
      color: I.normalizeColor(cat ? cat.color : I.DEFAULT_COLOR),
      icon: I.normalizeIconId(cat ? cat.icon : I.DEFAULT_ICON),
      onSaved: opts.onSaved || null,
      r: {},
    };
    renderCategory();
    AM.sheets.open(CAT, {
      initialFocus: AM.mq.coarse.matches && cat ? null : "#cat-name",
      onClose: function () { C = null; },
    });
    return true;
  }

  function renderCategory() {
    var r = C.r;
    AM.byId("category-title").textContent = C.cat ? t("categories.dialog_edit") : t("categories.dialog_new");
    AM.byId("category-delete").hidden = !C.cat;
    r.name = h("input", { class: "input", id: "cat-name", type: "text", dir: "auto", autocomplete: "off", maxlength: "60", required: true,
      "aria-describedby": "cat-name-h", placeholder: t("category.name_placeholder") });
    r.name.value = C.name;
    r.nameHint = h("span", { class: "field__hint", id: "cat-name-h", hidden: true });
    r.name.addEventListener("input", function () {
      C.name = r.name.value;
      r.name.removeAttribute("aria-invalid");
      r.nameHint.hidden = true;
      preview();
    });
    r.swatches = h("div", { class: "swatches", role: "radiogroup", "aria-labelledby": "cat-colour-l" },
      PRESETS.map(function (c) {
        return h("button", { type: "button", class: "swatch", role: "radio", "aria-checked": "false", "data-value": c, style: { "--sw": c },
          "aria-label": c, "data-tip": c, onclick: function () { setColor(c); } });
      }));
    r.native = h("input", { type: "color", class: "cat-native-color", id: "cat-color", "aria-label": t("category.custom_colour") });
    r.native.value = C.color.toLowerCase();
    r.native.addEventListener("input", function () { setColor(r.native.value); });
    r.hex = h("span", { class: "mono subtle", dir: "ltr" }, C.color);
    r.pickerHost = h("div");
    AM.fill(AM.byId("category-body"),
      h("div", { class: "field" }, h("label", { class: "field__label", for: "cat-name" }, h("span", null, t("code.name"))), r.name, r.nameHint),
      h("div", { class: "field" },
        h("span", { class: "field__label", id: "cat-colour-l" }, t("category.colour")),
        r.swatches,
        h("div", { class: "row", style: "--gap:10px" }, r.native, r.hex)),
      h("div", { class: "field" },
        h("span", { class: "field__label", id: "cat-icon-l" }, h("span", null, t("category.icon")), h("span", { class: "opt" }, t("category.icons_count"))),
        r.pickerHost));
    C.picker = CI().mountPicker(r.pickerHost, {
      value: C.icon, color: C.color, label: t("category.icon"),
      onChange: function (id) { C.icon = id; preview(); },
    });
    var grid = r.pickerHost.querySelector(".icon-grid");
    if (grid) grid.setAttribute("data-own-keys", ""); // the picker moves focus itself
    setColor(C.color, true);
    preview();
  }

  function setColor(hex, silent) {
    if (!C) return;
    var c = CI().normalizeColor(hex);
    C.color = c;
    var r = C.r;
    AM.radio.set(r.swatches, PRESETS.indexOf(c) >= 0 ? c : "__none__");
    if (PRESETS.indexOf(c) < 0) AM.$$('[role="radio"]', r.swatches).forEach(function (b, i) { b.tabIndex = i === 0 ? 0 : -1; });
    if (lc(r.native.value) !== lc(c)) r.native.value = c.toLowerCase();
    r.hex.textContent = c;
    if (C.picker) C.picker.setColor(c);
    if (!silent) preview();
  }

  function preview() {
    if (!C) return;
    var name = str(C.name) || t("categories.dialog_new");
    AM.fill(AM.byId("category-preview"),
      h("span", { class: "tag cat-preview", "aria-hidden": "true" },
        CI().mark({ name: name, color: C.color, icon: C.icon }, { size: "sm" }),
        h("span", { dir: "auto" }, name)));
  }

  function nameError(text) {
    var r = C.r;
    AM.fill(r.nameHint, icon("circle-alert"), h("span", null, text));
    r.nameHint.className = "field__hint field__hint--error";
    r.nameHint.hidden = false;
    r.name.setAttribute("aria-invalid", "true");
    r.name.focus();
  }

  async function saveCategory() {
    if (!C || C.busy) return;
    var name = str(C.name);
    if (!name) { nameError(t("category.name_required")); return; }
    var taken = AM.cat.list().filter(function (c) { return lc(c.name) === lc(name) && (!C.cat || c.id !== C.cat.id); })[0];
    if (taken) { nameError(t("category.name_taken", { name: taken.name })); return; }
    var body = { name: name, color: C.color, icon: C.icon };
    var ctx = C;
    ctx.busy = true;
    AM.byId("category-save").disabled = true;
    try {
      var saved = ctx.cat
        ? await AM.api("/categories/" + enc(ctx.cat.id), { method: "PUT", body: body })
        : await AM.api("/categories", { method: "POST", body: body });
      AM.sheets.close(CAT, saved, "api");
      try { await AM.refresh({ force: true }); } catch (e) { AM.reportError(e); }
      if (typeof ctx.onSaved === "function") { try { ctx.onSaved(saved); } catch (e) { console.error(e); } }
      AM.toast({ message: t(ctx.cat ? "toast.category_updated" : "toast.category_created", { name: saved && saved.name || name }), icon: "tag" });
    } catch (e) {
      if (C !== ctx) { AM.reportError(e); return; }
      if (e && e.code === "category_name_taken") nameError(t("category.name_taken", { name: (e.existing && e.existing.name) || name }));
      else AM.reportError(e);
    } finally {
      ctx.busy = false;
      AM.byId("category-save").disabled = false;
    }
  }

  async function deleteCategory() {
    if (!C || !C.cat) return;
    var cat = C.cat;
    var ok = await AM.confirm({
      title: t("confirm.trash_category_title", { name: cat.name }),
      message: t("confirm.trash_category_body"),
      confirmLabel: t("action.move_to_trash"),
    });
    if (!ok) return;
    try {
      await AM.api("/categories/" + enc(cat.id), { method: "DELETE" });
      AM.sheets.close(CAT, null, "api");
      if (AM.filters.state.cats.has(cat.id)) {
        var s = new Set(AM.filters.state.cats);
        s.delete(cat.id);
        AM.filters.set({ cats: s });
      }
      try { await AM.refresh({ force: true }); } catch (e) { AM.reportError(e); }
      AM.toast({
        message: t("toast.moved_to_trash", { name: cat.name }), icon: "trash-2",
        action: { label: t("action.undo"), run: function () { restoreCategory(cat, true); } },
      });
    } catch (e) {
      AM.reportError(e);
    }
  }

  var catWired = false;
  function wireCategoryOnce() {
    if (catWired) return;
    catWired = true;
    AM.byId(CAT).addEventListener("submit", function (e) { e.preventDefault(); saveCategory(); });
    AM.byId("category-delete").addEventListener("click", deleteCategory);
  }

  // =========================================================================
  // Trash
  // =========================================================================
  var TRASH = "dialog-trash";
  var trashTab = null;

  function openTrash() {
    wireTrashOnce();
    renderTrash();
    AM.sheets.open(TRASH, { initialFocus: AM.mq.coarse.matches ? null : '#dialog-trash [role="tab"][aria-selected="true"]' });
    AM.refresh({ force: true, trash: true }).catch(function () {}); // fresh view (re-renders via "trash")
    return true;
  }

  function miniQr(code) {
    var box = h("span", { class: "mini-qr trash-qr", "aria-hidden": "true" });
    var pb = {
      code_type: code.code_type, qr_payload: code.qr_payload, manual_code: code.manual_code, setup_id: code.setup_id,
      homekit_category: code.homekit_category, homekit_flag: code.homekit_flag, custom_standard: code.custom_standard,
    };
    AM.fill(box, icon("scan-qr-code"));
    AM.qr.forPayload(pb, { border: 2 }).then(function (svg) {
      if (!svg) return;
      svg.style.setProperty("--qr-size", "36px");
      AM.fill(box, svg);
    }).catch(function () {});
    return box;
  }

  function deletedWhen(item) {
    return item.deleted_at ? AM.fmt.relative(item.deleted_at) : "";
  }

  function renderTrash() {
    var tr = AM.store.trash || { codes: [], categories: [] };
    var codes = (tr.codes || []).slice().sort(function (a, b) { return String(b.deleted_at || "").localeCompare(String(a.deleted_at || "")); });
    var cats = (tr.categories || []).slice().sort(function (a, b) { return String(b.deleted_at || "").localeCompare(String(a.deleted_at || "")); });
    var body = AM.byId("trash-body");
    AM.byId("trash-empty-bin").hidden = !codes.length && !cats.length;
    if (!codes.length && !cats.length) {
      trashTab = null;
      AM.fill(body, h("div", { class: "trash-empty" },
        h("span", { class: "sheet__icon" }, icon("trash-2")),
        h("b", null, t("trash.empty")),
        h("span", { class: "subtle" }, t("trash.empty_hint"))));
      return;
    }
    if (trashTab !== "codes" && trashTab !== "categories") trashTab = codes.length ? "codes" : "categories";
    if (trashTab === "codes" && !codes.length) trashTab = "categories";
    if (trashTab === "categories" && !cats.length) trashTab = "codes";
    var tabs = h("div", { class: "tabs", role: "tablist", "aria-label": t("trash.title") },
      tab("codes", t("trash.codes"), codes.length),
      tab("categories", t("trash.categories"), cats.length));
    var panel = h("div", { class: "trash-list", role: "tabpanel", id: "trash-panel", "aria-labelledby": "trash-tab-" + trashTab, tabindex: "-1" });
    if (trashTab === "codes") {
      if (!codes.length) panel.appendChild(h("p", { class: "subtle trash-none" }, t("trash.no_codes")));
      codes.forEach(function (c) { panel.appendChild(codeRow(c)); });
    } else {
      if (!cats.length) panel.appendChild(h("p", { class: "subtle trash-none" }, t("trash.no_categories")));
      cats.forEach(function (c) { panel.appendChild(catRow(c)); });
    }
    AM.fill(body, tabs, panel);
  }

  function tab(id, label, n) {
    var on = trashTab === id;
    return h("button", { type: "button", class: "tab", role: "tab", id: "trash-tab-" + id, "aria-selected": String(on), "aria-controls": "trash-panel",
      tabindex: on ? "0" : "-1", "data-tab": id,
      onclick: function () { trashTab = id; renderTrash(); var b = AM.byId("trash-tab-" + id); if (b) b.focus(); },
      onkeydown: function (e) {
        var d = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
        if (!d) return;
        if (AM.dir() === "rtl") d = -d;
        e.preventDefault();
        trashTab = (trashTab === "codes") === (d > 0) ? "categories" : "codes";
        renderTrash();
        var b = AM.byId("trash-tab-" + trashTab);
        if (b) b.focus();
      } },
      h("span", null, label), h("span", { class: "badge badge--neutral" }, AM.fmt.number(n)));
  }

  function codeRow(c) {
    var dup = global.AntiMatterScan ? global.AntiMatterScan.findDuplicate(AM.store.vault.codes, c, c.id) : null;
    var when = deletedWhen(c);
    var txt = h("span", { class: "list-row__txt" },
      h("b", { dir: "auto", title: str(c.name) }, str(c.name) || t("scan.unnamed")),
      h("span", null, when ? t("trash.deleted_ago", { protocol: AM.proto.name(c), when: when }) : AM.proto.name(c)));
    if (dup) txt.appendChild(h("span", { class: "trash-dup", dir: "auto" }, t("trash.same_as", { name: str(dup.name) || t("scan.unnamed") })));
    var main = dup
      ? h("button", { type: "button", class: "btn btn--sm", onclick: function () { mergeCode(c, dup); } }, icon("git-merge"), h("span", null, t("trash.merge")))
      : h("button", { type: "button", class: "btn btn--sm", onclick: function () { restoreCode(c); } }, icon("undo-2"), h("span", null, t("trash.restore")));
    return h("div", { class: "list-row", "data-id": c.id }, miniQr(c), txt,
      h("span", { class: "list-row__actions" }, main,
        h("button", { type: "button", class: "icon-btn icon-btn--sm trash-purge", tip: t("action.delete_forever"), onclick: function () { purge("codes", c); } }, icon("trash-2"))));
  }

  function catRow(c) {
    var when = deletedWhen(c);
    var n = AM.store.vault.codes.filter(function (x) { return (x.category_ids || []).indexOf(c.id) >= 0; }).length;
    return h("div", { class: "list-row", "data-id": c.id },
      CI().mark(c, { size: 36 }),
      h("span", { class: "list-row__txt" },
        h("b", { dir: "auto", title: str(c.name) }, str(c.name)),
        h("span", null, [when ? t("trash.cat_deleted", { when: when }) : "", n ? t("trash.cat_codes", { count: n }) : ""].filter(Boolean).join(" · "))),
      h("span", { class: "list-row__actions" },
        h("button", { type: "button", class: "btn btn--sm", onclick: function () { restoreCategory(c); } }, icon("undo-2"), h("span", null, t("trash.restore"))),
        h("button", { type: "button", class: "icon-btn icon-btn--sm trash-purge", tip: t("action.delete_forever"), onclick: function () { purge("categories", c); } }, icon("trash-2"))));
  }

  async function restoreCode(c) {
    try {
      await AM.api("/codes/" + enc(c.id) + "/restore", { method: "POST" });
      AM.toast({ message: t("toast.restored", { name: str(c.name) }), icon: "archive-restore" });
      await AM.refresh({ force: true });
    } catch (e) {
      if (e && e.code === "duplicate") {
        await AM.refresh({ force: true }).catch(function () {});
        var ex = e.existing || {};
        return mergeCode(c, ex);
      }
      AM.reportError(e, { fallbackKey: "alert.restore_fail" });
      AM.refresh({ force: true }).catch(function () {});
    }
  }

  async function mergeCode(c, existing) {
    var ok = await AM.confirm({
      title: t("trash.merge_title"),
      message: t("trash.merge_body", { name: str(c.name) || t("scan.unnamed"), existing: str(existing && existing.name) || t("scan.unnamed") }),
      confirmLabel: t("trash.merge"),
      tone: "warn",
      icon: "git-merge",
      danger: false,
    });
    if (!ok) return;
    try {
      await AM.api("/codes/" + enc(c.id) + "/purge", { method: "DELETE" });
      AM.toast({ message: t("toast.merged", { name: str(existing && existing.name) }), icon: "git-merge" });
    } catch (e) {
      if (!(e && e.code === "code_not_in_trash")) AM.reportError(e);
    }
    AM.refresh({ force: true }).catch(AM.reportError);
  }

  async function restoreCategory(c, fromUndo) {
    try {
      await AM.api("/categories/" + enc(c.id) + "/restore", { method: "POST" });
      if (!fromUndo) AM.toast({ message: t("toast.restored", { name: str(c.name) }), icon: "archive-restore" });
      await AM.refresh({ force: true });
    } catch (e) {
      AM.reportError(e, { fallbackKey: "alert.restore_fail" });
      AM.refresh({ force: true }).catch(function () {});
    }
  }

  async function purge(kind, item) {
    var ok = await AM.confirm({
      title: t("confirm.delete_forever_title"),
      message: t("confirm.delete_forever_named", { name: str(item.name) || t("scan.unnamed") }),
      confirmLabel: t("action.delete_forever"),
    });
    if (!ok) return;
    try {
      await AM.api("/" + kind + "/" + enc(item.id) + "/purge", { method: "DELETE" });
      AM.toast({ message: t("toast.deleted_forever", { name: str(item.name) }), icon: "trash-2" });
    } catch (e) {
      if (!(e && (e.code === "code_not_in_trash" || e.code === "category_not_in_trash"))) AM.reportError(e);
    }
    AM.refresh({ force: true }).catch(AM.reportError);
  }

  async function emptyBin() {
    var tr = AM.store.trash || { codes: [], categories: [] };
    var n = (tr.codes || []).length + (tr.categories || []).length;
    if (!n) return;
    var ok = await AM.confirm({
      title: t("confirm.empty_bin_title"),
      message: t("confirm.empty_bin_body", { count: n }),
      confirmLabel: t("trash.empty_bin"),
    });
    if (!ok) return;
    try {
      await AM.api("/trash", { method: "DELETE" });
      AM.toast({ message: t("toast.bin_emptied", { count: n }), icon: "trash-2" });
    } catch (e) {
      AM.reportError(e);
    }
    AM.refresh({ force: true }).catch(AM.reportError);
  }

  var trashWired = false;
  function wireTrashOnce() {
    if (trashWired) return;
    trashWired = true;
    AM.byId("trash-empty-bin").addEventListener("click", emptyBin);
  }

  // =========================================================================
  // Backups
  // =========================================================================
  var BK = "dialog-backup";
  var B = null; // working copy of the settings

  async function openBackup() {
    wireBackupOnce();
    if (AM.sheets.isOpen(BK)) { AM.sheets.open(BK); return true; }
    B = Object.assign({ enabled: false, frequency: "daily", hour: 3, minute: 0, weekday: 0, day_of_month: 1, keep_count: 10, last_run_key: null }, AM.store.backup || {});
    renderBackup();
    AM.sheets.open(BK, { initialFocus: AM.mq.coarse.matches ? null : "#bk-enabled", onClose: function () { B = null; } });
    try {
      var s = await AM.backup.reload();
      if (B && AM.sheets.isOpen(BK) && !B.touched) { B = Object.assign({}, s); renderBackup(); }
    } catch (e) {
      if (B) AM.reportError(e);
    }
    return true;
  }

  function renderBackup() {
    AM.byId("backup-sub").textContent = t("backup.where");
    var d = AM.backup.describe(B);
    var desc = h("span", { class: "toggle-row__desc" },
      h("span", { class: ["bk-dot", B.enabled ? "bk-dot--on" : ""], "aria-hidden": "true" }),
      h("span", null, d.lastRun ? t("backup.last_run_kept", { when: d.lastRun, count: Number(B.keep_count) || 1 }) : t("backup.not_run", { count: Number(B.keep_count) || 1 })));
    var sw = h("input", { type: "checkbox", class: "switch", role: "switch", id: "bk-enabled" });
    sw.checked = !!B.enabled;
    sw.addEventListener("change", function () { B.enabled = sw.checked; touch(); renderBackupKeepFocus("bk-enabled"); });
    var freq = h("div", { class: "seg seg--block", role: "radiogroup", "aria-labelledby": "bk-freq-l" },
      ["hourly", "daily", "weekly", "monthly"].map(function (f) {
        return h("button", { type: "button", class: "seg__btn", role: "radio", "aria-checked": String(B.frequency === f), "data-value": f,
          onclick: function () { if (B.frequency !== f) { B.frequency = f; touch(); renderBackupKeepFocus(null, '[data-value="' + f + '"]'); } } },
          t(freqKey(f)));
      }));
    var row = h("div", { class: "field-row" });
    if (B.frequency === "weekly") {
      var wd = h("select", { class: "select", id: "bk-day" }, [0, 1, 2, 3, 4, 5, 6].map(function (i) { return h("option", { value: String(i) }, AM.backup.weekdayText(i)); }));
      wd.value = String(B.weekday || 0);
      wd.addEventListener("change", function () { B.weekday = +wd.value; touch(); refreshBackupDesc(); });
      row.appendChild(h("div", { class: "field" }, h("label", { class: "field__label", for: "bk-day" }, t("backup.weekday")), h("div", { class: "select-wrap" }, wd, icon("chevron-down"))));
    } else if (B.frequency === "monthly") {
      var dm = h("select", { class: "select", id: "bk-day" }, Array.from({ length: 28 }, function (_, i) { return h("option", { value: String(i + 1) }, AM.fmt.number(i + 1)); }));
      dm.value = String(B.day_of_month || 1);
      dm.addEventListener("change", function () { B.day_of_month = +dm.value; touch(); refreshBackupDesc(); });
      row.appendChild(h("div", { class: "field" }, h("label", { class: "field__label", for: "bk-day" }, t("backup.day_of_month")), h("div", { class: "select-wrap" }, dm, icon("chevron-down"))));
    }
    if (B.frequency === "hourly") {
      var mn = h("select", { class: "select", id: "bk-time", "aria-describedby": "bk-time-h" }, Array.from({ length: 60 }, function (_, i) {
        return h("option", { value: String(i) }, ":" + String(i).padStart(2, "0"));
      }));
      mn.value = String(B.minute || 0);
      mn.addEventListener("change", function () { B.minute = +mn.value; touch(); refreshBackupDesc(); });
      row.appendChild(h("div", { class: "field" }, h("label", { class: "field__label", for: "bk-time" }, t("backup.minute")),
        h("div", { class: "select-wrap" }, mn, icon("chevron-down")),
        h("span", { class: "field__hint", id: "bk-time-h" }, icon("info"), h("span", null, t("backup.hourly_minute_hint")))));
    } else {
      var tm = h("input", { class: "input", id: "bk-time", type: "time", dir: "ltr", required: true });
      tm.value = String(B.hour || 0).padStart(2, "0") + ":" + String(B.minute || 0).padStart(2, "0");
      tm.addEventListener("change", function () {
        var mm = /^(\d{1,2}):(\d{2})/.exec(tm.value || "");
        if (mm) { B.hour = Math.min(23, +mm[1]); B.minute = Math.min(59, +mm[2]); touch(); refreshBackupDesc(); }
      });
      row.appendChild(h("div", { class: "field" }, h("label", { class: "field__label", for: "bk-time" }, t("backup.time")), tm));
    }
    var keep = h("input", { id: "bk-keep", inputmode: "numeric", "aria-labelledby": "bk-keep-l", dir: "ltr" });
    keep.value = String(clampKeep(B.keep_count));
    function setKeep(v) { B.keep_count = clampKeep(v); keep.value = String(B.keep_count); touch(); refreshBackupDesc(); }
    keep.addEventListener("change", function () { setKeep(parseInt(keep.value, 10)); });
    keep.addEventListener("keydown", function (e) {
      if (e.key === "ArrowUp") { e.preventDefault(); setKeep(B.keep_count + 1); }
      else if (e.key === "ArrowDown") { e.preventDefault(); setKeep(B.keep_count - 1); }
    });
    var stepper = h("span", { class: "stepper" },
      h("button", { type: "button", class: "icon-btn icon-btn--sm", tip: t("backup.fewer"), onclick: function () { setKeep(B.keep_count - 1); } }, icon("minus")),
      keep,
      h("button", { type: "button", class: "icon-btn icon-btn--sm", tip: t("backup.more"), onclick: function () { setKeep(B.keep_count + 1); } }, icon("plus")));
    AM.fill(AM.byId("backup-body"),
      h("label", { class: "toggle-row", for: "bk-enabled" },
        h("span", { class: "toggle-row__text" }, h("span", { class: "toggle-row__title" }, t("backup.auto")), desc), sw),
      h("div", { class: "field" }, h("span", { class: "field__label", id: "bk-freq-l" }, t("backup.frequency")), freq),
      row,
      h("div", { class: "field" }, h("span", { class: "field__label", id: "bk-keep-l" }, h("span", null, t("backup.keep_count")), h("span", { class: "opt" }, t("backup.keep_range"))), stepper),
      h("p", { class: "field__hint", id: "bk-summary" }, icon("calendar-clock"), h("span", null, B.enabled ? d.schedule : t("backup.off_hint"))));
    AM.radio.sync(freq);
  }
  function refreshBackupDesc() {
    var el = AM.byId("bk-summary");
    if (!el || !B) return;
    var d = AM.backup.describe(B);
    AM.fill(el, icon("calendar-clock"), h("span", null, B.enabled ? d.schedule : t("backup.off_hint")));
  }
  function renderBackupKeepFocus(id, sel) {
    renderBackup();
    var el = id ? AM.byId(id) : AM.$("#backup-body " + sel);
    if (el) el.focus({ preventScroll: true });
  }
  function touch() { if (B) B.touched = true; }
  // i18n-dynamic: backup.freq_
  function freqKey(f) { return "backup.freq_" + f; }
  function clampKeep(v) { v = parseInt(v, 10); return isNaN(v) ? 10 : Math.max(1, Math.min(100, v)); }

  async function saveBackup() {
    if (!B || B.busy) return;
    var body = {
      enabled: !!B.enabled, frequency: B.frequency, hour: +B.hour || 0, minute: +B.minute || 0,
      weekday: +B.weekday || 0, day_of_month: Math.max(1, Math.min(28, +B.day_of_month || 1)), keep_count: clampKeep(B.keep_count),
    };
    B.busy = true;
    AM.byId("backup-save").disabled = true;
    try {
      var s = await AM.api("/backup/settings", { method: "PUT", body: body });
      AM.backup.set(s);
      AM.sheets.close(BK, s, "api");
      AM.log("Backup schedule: enabled=" + body.enabled + " frequency=" + body.frequency + " keep=" + body.keep_count);
      AM.toast({ message: body.enabled ? t("toast.backup_schedule_on", { schedule: AM.backup.describe(s).schedule }) : t("toast.backup_schedule_off"), icon: "calendar-clock" });
    } catch (e) {
      AM.reportError(e);
    } finally {
      if (B) B.busy = false;
      AM.byId("backup-save").disabled = false;
    }
  }

  var backingUp = false;
  async function backupNow() {
    if (backingUp) return;
    backingUp = true;
    var btn = AM.byId("backup-now");
    btn.disabled = true;
    btn.setAttribute("aria-busy", "true");
    var ic = btn.querySelector("svg.icon");
    if (ic) ic.classList.add("am-spin");
    var use = ic && ic.querySelector("use");
    var oldHref = use && use.getAttribute("href");
    if (use) use.setAttribute("href", AM.ICONS_URL + "#i-loader-circle");
    try {
      var r = await AM.api("/backup", { method: "POST" });
      if (r && r.ok) {
        AM.haptic("success");
        AM.toast({ message: t("toast.backup_done", { file: String(r.backup || "") }), icon: "database-backup" });
      } else {
        AM.toast({ message: t("alert.backup_fail"), tone: "warn" });
      }
      AM.backup.reload().catch(function () {});
    } catch (e) {
      AM.haptic("failure");
      AM.reportError(e);
    } finally {
      backingUp = false;
      btn.disabled = false;
      btn.removeAttribute("aria-busy");
      if (ic) ic.classList.remove("am-spin");
      if (use && oldHref) use.setAttribute("href", oldHref);
    }
  }

  var bkWired = false;
  function wireBackupOnce() {
    if (bkWired) return;
    bkWired = true;
    AM.byId(BK).addEventListener("submit", function (e) { e.preventDefault(); saveBackup(); });
    AM.byId("backup-now").addEventListener("click", backupNow);
  }

  // =========================================================================
  // Import & export
  // =========================================================================
  var IO = "dialog-import";
  var IMP = null; // {file, text, data, error, mode, summary}
  var EXPORT_NAME = "anti-matter-export.json";

  function openImportExport() {
    wireImportOnce();
    if (!AM.sheets.isOpen(IO)) IMP = null;
    renderImport();
    AM.sheets.open(IO, { onClose: function () { IMP = null; } });
    return true;
  }

  function summarize(data) {
    var codes = Array.isArray(data.codes) ? data.codes.filter(function (c) { return c && typeof c === "object" && !c.deleted_at; }) : [];
    var cats = Array.isArray(data.categories) ? data.categories.filter(function (c) { return c && typeof c === "object" && !c.deleted_at; }) : [];
    var have = AM.store.codeById;
    var fresh = codes.filter(function (c) { return !c.id || !have.has(c.id); });
    var S = global.AntiMatterScan;
    var sameCode = S ? fresh.filter(function (c) { try { return !!S.findDuplicate(AM.store.vault.codes, c, null); } catch (e) { return false; } }).length : 0;
    return { codes: codes.length, categories: cats.length, fresh: fresh.length, existing: codes.length - fresh.length, lookalike: sameCode };
  }

  async function importFile(file) {
    if (!file) return false;
    wireImportOnce();
    IMP = { file: file, text: "", data: null, error: null, mode: "merge", summary: null };
    if (file.size > 16 * 1024 * 1024) IMP.error = t("error.too_large");
    else {
      try {
        IMP.text = await file.text();
        var data = JSON.parse(IMP.text);
        if (!data || typeof data !== "object" || Array.isArray(data) || (!Array.isArray(data.codes) && !Array.isArray(data.categories))) throw new Error("shape");
        IMP.data = data;
        IMP.summary = summarize(data);
      } catch (e) {
        IMP.error = t("error.invalid_import");
      }
    }
    renderImport();
    AM.sheets.open(IO, { onClose: function () { IMP = null; } });
    return true;
  }

  function renderImport() {
    var body = AM.byId("import-body");
    var confirmBtn = AM.byId("import-confirm");
    var kids = [
      h("button", { type: "button", class: "btn btn--block", id: "io-export", onclick: exportVault },
        icon("file-down"), h("span", null, AM.tNodes("import.export_file", { file: "" }, { file: h("span", { dir: "ltr" }, EXPORT_NAME) }))),
    ];
    if (!IMP) {
      kids.push(h("div", { class: "io-pick" },
        h("button", { type: "button", class: "btn btn--block", id: "io-choose", onclick: function () { AM.act("pickImportFile"); } },
          icon("file-up"), h("span", null, t("import.choose"))),
        h("p", { class: "field__hint" }, icon("info"), h("span", null, t("import.choose_hint")))));
      confirmBtn.hidden = true;
      AM.fill(body, kids);
      return;
    }
    var fileRow = h("div", { class: ["notice", IMP.error && "notice--danger"], role: IMP.error ? "alert" : null },
      icon(IMP.error ? "circle-alert" : "file-json"),
      h("div", { class: "notice__body" },
        h("span", { class: "notice__title", dir: "auto" }, IMP.file.name || EXPORT_NAME),
        IMP.error ? h("span", null, IMP.error) : summaryLine(IMP.summary),
        h("div", { class: "notice__actions" },
          h("button", { type: "button", class: "link-btn", onclick: function () { AM.act("pickImportFile"); } }, t("import.other_file")))));
    kids.push(fileRow);
    if (!IMP.error) {
      var s = IMP.summary;
      var cards = h("div", { class: "choice-cards", role: "radiogroup", "aria-label": t("import.mode") },
        h("button", { type: "button", class: "choice", role: "radio", "aria-checked": String(IMP.mode === "merge"), "data-value": "merge", onclick: function () { setMode("merge"); } },
          h("b", null, icon("git-merge"), h("span", null, t("action.merge"))),
          h("span", null, s.fresh ? t("import.merge_desc_n", { count: s.fresh }) : t("import.merge_desc_none"))),
        h("button", { type: "button", class: "choice choice--danger", role: "radio", "aria-checked": String(IMP.mode === "replace"), "data-value": "replace", onclick: function () { setMode("replace"); } },
          h("b", null, icon("refresh-cw"), h("span", null, t("action.replace"))),
          h("span", null, t("import.replace_desc"))));
      kids.push(cards);
      if (s.lookalike) kids.push(h("p", { class: "field__hint field__hint--warn" }, icon("triangle-alert"), h("span", null, t("import.lookalike", { count: s.lookalike }))));
      if (IMP.mode === "replace") kids.push(h("p", { class: "field__hint" }, icon("database-backup"), h("span", null, t("import.replace_backup_note"))));
    }
    AM.fill(body, kids);
    var cardsEl = body.querySelector(".choice-cards");
    if (cardsEl) AM.radio.sync(cardsEl);
    confirmBtn.hidden = !!IMP.error;
    if (!IMP.error) {
      var repl = IMP.mode === "replace";
      confirmBtn.className = "btn btn--primary";
      AM.fill(confirmBtn, icon(repl ? "refresh-cw" : "file-up"),
        h("span", null, repl ? t("import.replace_vault") : IMP.summary.fresh ? t("import.add_n", { count: IMP.summary.fresh }) : t("import.merge_btn")));
    }
  }
  function summaryLine(s) {
    return h("span", null, AM.tNodes("import.summary_line", {}, {
      codes: t("import.n_codes", { count: s.codes }),
      categories: t("import.n_categories", { count: s.categories }),
      fresh: h("b", { class: "io-new" }, t("import.n_new", { count: s.fresh })),
      existing: t("import.n_existing", { count: s.existing }),
    }));
  }
  function setMode(mode) {
    if (!IMP || IMP.mode === mode) return;
    IMP.mode = mode;
    renderImport();
    var b = AM.$('#import-body .choice[data-value="' + mode + '"]');
    if (b) b.focus({ preventScroll: true });
  }

  async function runImport() {
    if (!IMP || IMP.error || IMP.busy) return;
    var imp = IMP;
    var merge = imp.mode !== "replace";
    if (!merge) {
      var n = AM.store.vault.codes.length;
      var ok = await AM.confirm({
        title: t("import.replace_title"),
        message: t("import.replace_confirm", { count: n }),
        confirmLabel: t("import.replace_vault"),
        icon: "refresh-cw",
        okIcon: "refresh-cw",
      });
      if (!ok || IMP !== imp) return;
    }
    imp.busy = true;
    var btn = AM.byId("import-confirm");
    btn.disabled = true;
    try {
      if (!merge) { try { await AM.api("/backup", { method: "POST" }); } catch (e) { /* best effort safety copy */ } }
      var before = AM.store.vault.codes.length;
      var v = await AM.api("/import", { method: "POST", body: { data: imp.text, merge: merge } });
      AM.sheets.close(IO, v, "api");
      AM.selection.clear();
      try { await AM.refresh({ force: true }); } catch (e) { AM.reportError(e); }
      var after = v && Array.isArray(v.codes) ? v.codes.length : AM.store.vault.codes.length;
      AM.log("Vault import: mode=" + (merge ? "merge" : "replace") + " codes=" + after);
      AM.toast({
        message: merge ? t("toast.import_merged", { count: Math.max(0, after - before) }) : t("toast.import_replaced", { count: after }),
        icon: "file-up",
      });
    } catch (e) {
      if (e && e.code === "invalid_import" && IMP === imp) { imp.error = e.userMessage || t("error.invalid_import"); renderImport(); }
      else AM.reportError(e);
    } finally {
      imp.busy = false;
      btn.disabled = false;
    }
  }

  async function exportVault() {
    try {
      var blob = await AM.api("/export", { as: "blob" });
      AM.download(blob, EXPORT_NAME);
      AM.toast({ message: t("toast.exported", { file: EXPORT_NAME }), icon: "file-down" });
      return true;
    } catch (e) {
      AM.reportError(e);
      return false;
    }
  }

  var ioWired = false;
  function wireImportOnce() {
    if (ioWired) return;
    ioWired = true;
    AM.byId("import-confirm").addEventListener("click", runImport);
  }

  // =========================================================================
  // Move codes to Trash (bulk, with per-item error handling and Undo)
  // =========================================================================
  function namesList(codes) {
    var max = 6;
    var ul = h("ul", { class: "confirm-list" }, codes.slice(0, max).map(function (c) { return h("li", { dir: "auto" }, str(c.name) || t("scan.unnamed")); }));
    if (codes.length > max) ul.appendChild(h("li", { class: "subtle" }, t("confirm.and_more", { count: codes.length - max })));
    return ul;
  }

  async function deleteCodes(ids, opts) {
    opts = Object.assign({ confirm: true, undo: true }, opts || {});
    ids = Array.from(ids || []).filter(function (id, i, a) { return id && a.indexOf(id) === i; });
    var codes = ids.map(function (id) { return AM.store.codeById.get(id) || { id: id, name: "" }; });
    if (!codes.length) return false;
    if (opts.confirm) {
      var msg = h("span", { class: "confirm-trash" }, namesList(codes), h("span", { class: "subtle" }, t("confirm.trash_restore_note")));
      var ok = await AM.confirm({
        title: t("confirm.trash_codes_title", { count: codes.length }),
        message: msg,
        confirmLabel: t("action.move_to_trash"),
      });
      if (!ok) return false;
    }
    var moved = [], failed = [];
    for (var i = 0; i < codes.length; i++) {
      var c = codes[i];
      try {
        await AM.api("/codes/" + enc(c.id), { method: "DELETE" });
        moved.push(c);
      } catch (e) {
        if (e && e.code === "code_not_found") continue; // already gone (deleted elsewhere)
        failed.push({ code: c, err: e });
      }
    }
    AM.selection.clear();
    try { await AM.refresh({ force: true }); } catch (e) { AM.reportError(e); }
    AM.log("Codes moved to trash: " + moved.length + (failed.length ? " failed=" + failed.length : ""));
    if (moved.length) {
      AM.toast({
        message: moved.length === 1 ? t("toast.moved_to_trash", { name: str(moved[0].name) || t("scan.unnamed") }) : t("toast.moved_n", { count: moved.length }),
        icon: "trash-2",
        action: opts.undo ? { label: t("action.undo"), run: function () { undoDelete(moved); } } : null,
      });
    }
    if (failed.length) {
      AM.toast({
        tone: "danger",
        message: t("toast.trash_failed", { count: failed.length, reason: (failed[0].err && failed[0].err.userMessage) || "" }),
        action: { label: t("action.retry"), run: function () { deleteCodes(failed.map(function (f) { return f.code.id; }), { confirm: false, undo: opts.undo }); } },
        timeout: 0,
      });
    }
    return moved.length > 0 && !failed.length;
  }

  async function undoDelete(codes) {
    var ok = 0, dups = [], other = [];
    for (var i = 0; i < codes.length; i++) {
      try {
        await AM.api("/codes/" + enc(codes[i].id) + "/restore", { method: "POST" });
        ok++;
      } catch (e) {
        if (e && e.code === "duplicate") dups.push(codes[i]);
        else if (!(e && e.code === "code_not_in_trash")) other.push(e);
      }
    }
    try { await AM.refresh({ force: true }); } catch (e) { AM.reportError(e); }
    if (ok) AM.toast({ message: t("toast.restored_n", { count: ok }), icon: "archive-restore" });
    if (dups.length) AM.toast({ message: t("toast.restore_dups", { count: dups.length }), tone: "warn", action: { label: t("nav.trash"), run: openTrash } });
    if (other.length) AM.reportError(other[0]);
  }

  // =========================================================================
  // Events & actions
  // =========================================================================
  AM.on("trash", function () { if (AM.sheets.isOpen(TRASH)) renderTrash(); });
  AM.on("vault", function () { if (AM.sheets.isOpen(TRASH)) renderTrash(); });
  AM.on("backup", function () {
    if (B && AM.sheets.isOpen(BK) && !B.touched) { B = Object.assign({}, AM.store.backup || B); renderBackup(); }
  });
  AM.on("locale", function () {
    if (C && AM.sheets.isOpen(CAT)) {
      C.icon = C.picker ? C.picker.getValue() : C.icon;
      renderCategory();
    }
    if (AM.sheets.isOpen(TRASH)) renderTrash();
    if (B && AM.sheets.isOpen(BK)) renderBackup();
    if (AM.sheets.isOpen(IO)) renderImport();
  });

  AM.provide("openCategoryEditor", openCategoryEditor);
  AM.provide("openTrash", openTrash);
  AM.provide("openBackup", openBackup);
  AM.provide("openImportExport", openImportExport);
  AM.provide("importFile", importFile);
  AM.provide("exportVault", exportVault);
  AM.provide("deleteCodes", deleteCodes);
})(window);
