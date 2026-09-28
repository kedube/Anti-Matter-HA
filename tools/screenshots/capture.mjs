#!/usr/bin/env node
// Anti-Matter screenshot tool: README + wiki screenshots, scan-demo.gif and brand images.
// Everything shown is the fake demo vault in ./demo (see README.md). Usage:
//
//   node capture.mjs                     start a private backend on a free port, capture everything
//   node capture.mjs --only readme,gif   only some groups / shots (names: see SHOTS below)
//   BASE_URL=http://localhost:8099/ STORAGE_DIR=/path/to/its/storage node capture.mjs
//                                        use a running backend (STORAGE_DIR: it gets the demo data)
//
// Flags: --only a,b  --skip a,b  --no-optimize  --list
// Env:   PYTHON (interpreter with anti_matter/app/requirements.txt), PW_CHANNEL (default "chrome";
//        "" = Playwright's bundled Chromium), BASE_URL, STORAGE_DIR, KEEP_WORK=1.
import { chromium } from "playwright";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const APP = path.join(ROOT, "anti_matter", "app");
const DOCS = path.join(ROOT, "docs", "screenshots");
const WORK = path.join(HERE, ".work");
const RAW = path.join(WORK, "raw");
const FIX = path.join(WORK, "fixtures");
const TPL = path.join(HERE, "templates");
const DCL = JSON.parse(fs.readFileSync(path.join(HERE, "demo", "demo-dcl.json"), "utf8"));
const PY = process.env.PYTHON || (fs.existsSync(path.join(HERE, ".venv/bin/python")) ? path.join(HERE, ".venv/bin/python") : "python3");
const CHANNEL = process.env.PW_CHANNEL ?? "chrome";
const LOCALE_TAG = { en: "en-US", nl: "nl-NL", de: "de-DE", ja: "ja-JP", ar: "ar", uk: "uk-UA" };

// ---------------------------------------------------------------- cli
const argv = process.argv.slice(2);
const flag = (n) => argv.includes("--" + n);
const opt = (n) => { const a = argv.find((x) => x.startsWith("--" + n + "=")); const i = argv.indexOf("--" + n); return a ? a.split("=")[1] : i >= 0 ? argv[i + 1] : null; };
const ONLY = (opt("only") || "").split(",").filter(Boolean);
const SKIP = (opt("skip") || "").split(",").filter(Boolean);
const wanted = (name, group) => (!ONLY.length || ONLY.includes(name) || ONLY.includes(group)) && !SKIP.includes(name) && !SKIP.includes(group);
const log = (...a) => console.log("[shots]", ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (const d of [WORK, RAW, FIX]) fs.mkdirSync(d, { recursive: true });

// ---------------------------------------------------------------- backend + demo data
let BASE = process.env.BASE_URL || "";
let STORAGE = process.env.STORAGE_DIR || "";
let backend = null;
let currentLocale = null;
const HA = {};

function seed(locale) {
  const haOut = path.join(WORK, `ha-${locale}.json`);
  if (!STORAGE) {
    if (!HA[locale]) HA[locale] = JSON.parse(fs.readFileSync(path.join(HERE, "demo", "demo-ha.json"), "utf8"));
    return;
  }
  if (currentLocale === locale) return;
  const r = spawnSync(PY, [path.join(HERE, "seed_demo.py"), STORAGE, "--locale", locale, "--ha-out", haOut], { encoding: "utf8" });
  if (r.status !== 0) throw new Error("seed_demo.py failed: " + r.stderr);
  HA[locale] = JSON.parse(fs.readFileSync(haOut, "utf8"));
  currentLocale = locale;
}
/** Re-seed (after a shot saved codes, e.g. the scanner flow). */
function reseed(locale) { currentLocale = null; seed(locale); }

function freePort() {
  return new Promise((res, rej) => { const s = net.createServer(); s.unref(); s.on("error", rej); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });
}

async function startBackend() {
  const port = await freePort();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "antimatter-shots-"));
  const dirs = { storage: path.join(base, "config"), data: path.join(base, "data"), media: path.join(base, "media") };
  Object.values(dirs).forEach((d) => fs.mkdirSync(d, { recursive: true }));
  fs.writeFileSync(path.join(dirs.data, "options.json"), JSON.stringify({ interface: { language: "Auto", theme: "Auto" }, backup: { keep_count: 10 } }));
  STORAGE = dirs.storage;
  seed("en");
  const logFile = fs.openSync(path.join(WORK, "backend.log"), "w");
  const proc = spawn(PY, ["main.py"], {
    cwd: APP, stdio: ["ignore", logFile, logFile],
    env: { ...process.env, STORAGE_DIR: dirs.storage, ANTIMATTER_DATA: dirs.data, ANTIMATTER_OPTIONS: path.join(dirs.data, "options.json"), ANTIMATTER_MEDIA: dirs.media, ANTIMATTER_PORT: String(port), SUPERVISOR_TOKEN: "" },
  });
  let exited = false;
  proc.on("exit", () => { exited = true; });
  const url = `http://127.0.0.1:${port}/`;
  for (let i = 0; i < 150 && !exited; i++) {
    try { const r = await fetch(url + "api/info"); if (r.ok) break; } catch { /* not up yet */ }
    await sleep(200);
  }
  if (exited) throw new Error("backend exited; see " + path.join(WORK, "backend.log") + " (pip install -r anti_matter/app/requirements.txt?)");
  log("backend", url, "storage", dirs.storage);
  return { url, stop: () => { try { proc.kill(); } catch { /* gone */ } if (!process.env.KEEP_WORK) fs.rmSync(base, { recursive: true, force: true }); } };
}

// ---------------------------------------------------------------- browsers & pages
const browsers = {};
async function browser(kind = "plain", lang = "en") {
  const key = kind + ":" + lang;
  if (browsers[key]) return browsers[key];
  // --lang sets Chrome's UI locale, which native controls (e.g. <input type=time>) follow.
  const args = ["--font-render-hinting=none", "--hide-scrollbars", "--lang=" + (LOCALE_TAG[lang] || lang)];
  if (kind === "camera") args.push("--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--use-file-for-fake-video-capture=" + path.join(FIX, "cam-flow.y4m"));
  try { browsers[key] = await chromium.launch({ channel: CHANNEL || undefined, args }); }
  catch (e) { log("channel", CHANNEL, "unavailable, using bundled Chromium"); browsers[key] = await chromium.launch({ args }); }
  return browsers[key];
}

/** Fake origin (e.g. http://homeassistant.local:8123) proxied to the backend, so URLs in shots look real. */
let ORIGIN = null;
const upstream = (u) => (ORIGIN && u.startsWith(ORIGIN) ? BASE + u.slice(ORIGIN.length + 1) : u);
async function mockRoutes(ctx, locale) {
  const ha = HA[locale] || HA.en;
  if (ORIGIN) await ctx.route(ORIGIN + "/**", async (r) => r.fulfill({ response: await r.fetch({ url: upstream(r.request().url()) }) }));
  await ctx.route("**/api/ha/devices", (r) => r.fulfill({ json: ha.devices }));
  await ctx.route("**/api/ha/areas", (r) => r.fulfill({ json: ha.areas }));
  await ctx.route("**/api/info", async (r) => { const res = await r.fetch({ url: upstream(r.request().url()) }); const j = await res.json(); j.ha_available = true; await r.fulfill({ response: res, json: j }); });
  // Matter DCL: recorded answers only, so a capture run never talks to the internet.
  await ctx.route(/\/api\/matter\/vendor\/(\d+)$/, (r) => { const v = DCL.vendors[r.request().url().match(/(\d+)$/)[1]]; return v ? r.fulfill({ json: v }) : r.fulfill({ status: 204 }); });
  await ctx.route(/\/api\/matter\/model\/(\d+)\/(\d+)$/, (r) => { const m = r.request().url().match(/(\d+)\/(\d+)$/); const v = DCL.models[m[1] + "/" + m[2]]; return v ? r.fulfill({ json: v }) : r.fulfill({ status: 204 }); });
}

/** o: {w, h, dpr, scheme, lang, mobile, camera, motion, init, origin} */
async function openApp(o = {}) {
  const lang = o.lang || "en";
  ORIGIN = o.origin || null;
  seed(lang === "nl" ? "nl" : "en");
  const b = await browser(o.camera ? "camera" : "plain", lang);
  const ctx = await b.newContext({
    viewport: { width: o.w || 1280, height: o.h || 800 }, deviceScaleFactor: o.dpr || 2, colorScheme: o.scheme || "light",
    locale: LOCALE_TAG[lang] || lang, hasTouch: !!o.mobile, isMobile: !!o.mobile, reducedMotion: o.motion || "reduce",
    permissions: o.camera ? ["camera"] : [],
  });
  await mockRoutes(ctx, lang === "nl" ? "nl" : "en");
  if (o.camera) await ctx.addInitScript(fakeCameraLabel);
  if (o.init) await ctx.addInitScript(o.init);
  const page = await ctx.newPage();
  page.__inflight = 0;
  page.__pending = new Set();
  page.on("request", (r) => { page.__inflight++; page.__pending.add(r.url()); });
  const done = (r) => { page.__inflight = Math.max(0, page.__inflight - 1); page.__pending.delete(r.url()); page.__last = Date.now(); };
  page.on("requestfinished", done);
  page.on("requestfailed", done);
  page.on("pageerror", (e) => log("page error:", e.message));
  await page.goto((ORIGIN ? ORIGIN + "/" : BASE) + "?lang=" + lang, { waitUntil: "load" });
  await page.waitForFunction(() => document.documentElement.classList.contains("am-loaded") && !document.documentElement.classList.contains("am-booting"), null, { timeout: 30000 });
  await settle(page);
  page.__ctx = ctx;
  page.__dpr = o.dpr || 2;
  return page;
}

/** Chrome names the fake capture device after the .y4m path; show a phone-like label instead. */
function fakeCameraLabel() {
  for (const proto of [window.MediaDeviceInfo && MediaDeviceInfo.prototype, window.MediaStreamTrack && MediaStreamTrack.prototype]) {
    const d = proto && Object.getOwnPropertyDescriptor(proto, "label");
    if (!d || !d.get) continue;
    Object.defineProperty(proto, "label", { configurable: true, get() { const v = d.get.call(this); return /[\\/]|y4m|fake/i.test(v) ? "Back Camera" : v; } });
  }
}

/** Re-render a PNG with rounded, transparent corners (radii in image px: tl tr br bl). */
async function roundCorners(file, radii) {
  const buf = fs.readFileSync(file);
  const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
  const ctx = await (await browser("plain")).newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  const pg = await ctx.newPage();
  await pg.setContent(`<html><body style="margin:0;background:transparent"><img style="display:block;width:${w}px;height:${h}px;border-radius:${radii.map((r) => r + "px").join(" ")}" src="data:image/png;base64,${buf.toString("base64")}"></body></html>`);
  await pg.waitForFunction(() => document.images[0].complete && document.images[0].naturalWidth > 0);
  await pg.screenshot({ path: file, omitBackground: true });
  await ctx.close();
}
const closePage = (page) => page.__ctx.close();

/** Network quiet + fonts + images + no empty QR slots, then a short pause. */
async function settle(page, extra = 350) {
  const t0 = Date.now();
  await page.evaluate(() => document.fonts.ready.then(() => true));
  while (Date.now() - t0 < 15000) {
    const quiet = page.__inflight === 0 && Date.now() - (page.__last || 0) > 300;
    const ready = await page.evaluate(() => {
      const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth; };
      const imgs = [...document.images].filter(vis).every((i) => i.complete);
      const emptyQr = [...document.querySelectorAll(".qr-tile__qr, .tray__qr, .mini-qr")].filter(vis).some((e) => !e.firstElementChild);
      return imgs && !emptyQr;
    });
    if (quiet && ready) break;
    await sleep(100);
  }
  if (process.env.DEBUG_SETTLE) log("settle", Date.now() - t0, "ms inflight", page.__inflight, [...(page.__pending || [])].slice(0, 5));
  await sleep(extra);
}

/** Move the pointer somewhere inert (no hover states or tooltips in the shot). */
async function park(page) {
  const pt = await page.evaluate(() => {
    const W = innerWidth, H = innerHeight;
    const bad = "button,a,input,select,textarea,label,[data-tip],[role=button],[role=option],[tabindex],.code-card,.nav-item,.chip,tr,.label,.menu";
    for (const [fx, fy] of [[0.99, 0.5], [0.5, 0.99], [0.99, 0.99], [0.01, 0.99], [0.6, 0.02], [0.5, 0.5]]) {
      const x = Math.round(W * fx), y = Math.round(H * fy);
      const el = document.elementFromPoint(x, y);
      if (el && !el.closest(bad)) return { x, y };
    }
    return { x: W - 1, y: H - 1 };
  });
  await page.mouse.move(pt.x, pt.y);
  await page.evaluate(() => { try { AM.hideTooltip(); } catch { /* not yet */ } });
}
const clearToasts = (page) => page.evaluate(() => document.querySelectorAll("#toasts > *").forEach((t) => t.remove()));
const top = (page) => page.evaluate(() => AM.sheets.top());
const waitTop = (page, id, timeout = 8000) => page.waitForFunction((id) => AM.sheets.top() === id, id, { timeout });

async function shoot(page, file, o = {}) {
  await settle(page, o.wait ?? 300);
  if (!o.keepPointer) await park(page);
  if (!o.keepToasts) await clearToasts(page);
  await sleep(120);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (o.el) {
    // Clip to the element rounded *inward* to device pixels (a locator screenshot rounds outward and
    // picks up a sliver of the page), then make rounded corners transparent instead of showing the scrim.
    const dpr = page.__dpr || 2;
    const g = await page.locator(o.el).first().evaluate((e, dpr) => {
      const r = e.getBoundingClientRect(), cs = getComputedStyle(e);
      const inn = (v, up) => (up ? Math.ceil(v * dpr) : Math.floor(v * dpr)) / dpr;
      const x = inn(r.left, true), y = inn(r.top, true);
      return { clip: { x, y, width: inn(r.right, false) - x, height: inn(r.bottom, false) - y },
               radii: [cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomRightRadius, cs.borderBottomLeftRadius].map((v) => parseFloat(v) || 0) };
    }, dpr);
    await page.screenshot({ path: file, clip: g.clip, animations: "disabled" });
    if (g.radii.some(Boolean)) await roundCorners(file, g.radii.map((r) => (r ? r * dpr + 1 : 0)));
  } else await page.screenshot({ path: file, clip: o.clip, animations: "disabled" });
  if (!file.startsWith(RAW)) produced.add(file);
  log("wrote", path.relative(ROOT, file));
}

/** Bounding box (CSS px) around several selectors, padded and clamped to the viewport. */
async function unionClip(page, sels, pad = 16, extra = {}) {
  return page.evaluate(({ sels, pad, extra }) => {
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const s of sels) for (const e of document.querySelectorAll(s)) {
      const r = e.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      x1 = Math.min(x1, r.left); y1 = Math.min(y1, r.top); x2 = Math.max(x2, r.right); y2 = Math.max(y2, r.bottom);
    }
    const floor = extra.belowAppbar ? document.getElementById("appbar").getBoundingClientRect().bottom + 1 : 0;
    x1 = Math.max(0, x1 - pad - (extra.left || 0)); y1 = Math.max(floor, y1 - pad - (extra.top || 0));
    x2 = Math.min(innerWidth, x2 + pad + (extra.right || 0)); y2 = Math.min(innerHeight, y2 + pad + (extra.bottom || 0));
    return { x: Math.round(x1), y: Math.round(y1), width: Math.round(x2 - x1), height: Math.round(y2 - y1) };
  }, { sels, pad, extra });
}

async function setView(page, v) {
  await page.click(`#view-switch [data-view="${v}"]`);
  await settle(page);
}
/** Scroll so the view bar ("All codes") sits just under the app bar. */
async function scrollToViewbar(page) {
  await page.evaluate(() => {
    const bar = document.getElementById("viewbar"), app = document.getElementById("appbar");
    const y = bar.getBoundingClientRect().top + scrollY - app.getBoundingClientRect().height - 8;
    const m = document.getElementById("main");
    if (m.scrollHeight > m.clientHeight + 4 && getComputedStyle(m).overflowY !== "visible") m.scrollTop += bar.getBoundingClientRect().top - app.getBoundingClientRect().bottom - 8;
    else scrollTo(0, y);
  });
  await sleep(200);
}
const codeId = (page, name) => page.evaluate((n) => (AM.store.vault.codes.find((c) => c.name === n) || {}).id, name);

// ---------------------------------------------------------------- composites (HTML templates -> PNG)
async function renderTemplate(name, data, out, { w, h, dpr = 2 }) {
  const b = await browser("plain");
  const ctx = await b.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dpr, colorScheme: "dark" });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => log("template error:", e.message));
  await page.goto(pathToFileURL(path.join(TPL, name)).href + "#" + encodeURIComponent(JSON.stringify(data)));
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 20000 });
  await page.evaluate(() => document.fonts.ready.then(() => true));
  await sleep(250);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  await page.screenshot({ path: out });
  produced.add(out);
  log("wrote", path.relative(ROOT, out));
  await ctx.close();
}
const fileUrl = (p) => pathToFileURL(p).href;

// ---------------------------------------------------------------- scanner helpers
/** Phase of the fake camera clip (make_fixtures.py corner marker): 1 = Matter, 2 = HomeKit, 0 = other.
 *  Red minus green of the corner block: about +22 / -10 / +6. */
const camPhase = (page) => page.evaluate(() => {
  const v = document.querySelector("#scanner video");
  if (!v || !v.videoWidth) return -1;
  const c = document.createElement("canvas"); c.width = c.height = 4;
  const g = c.getContext("2d", { willReadFrequently: true });
  g.drawImage(v, v.videoWidth - 8, v.videoHeight - 8, 4, 4, 0, 0, 4, 4);
  const d = g.getImageData(1, 1, 2, 2).data;
  const rg = (d[0] + d[4] + d[8] + d[12] - d[1] - d[5] - d[9] - d[13]) / 4;
  return rg > 12 ? 1 : rg < -3 ? 2 : 0;
});
async function waitPhase(page, want, timeout = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { if ((await camPhase(page)) === want) return; await sleep(60); }
  throw new Error("fake camera never reached phase " + want);
}
const resultKind = (page) => page.evaluate(() => {
  const s = document.querySelector("#scanner .result:not([hidden])");
  if (!s) return null;
  return s.querySelector(".hk-code") ? "homekit" : /matter/i.test(s.textContent) ? "matter" : "other";
});
async function waitResult(page, kind, timeout = 20000) {
  await page.waitForFunction((k) => {
    const s = document.querySelector("#scanner .result:not([hidden])");
    if (!s) return false;
    return k === "homekit" ? !!s.querySelector(".hk-code") : !s.querySelector(".hk-code");
  }, kind, { timeout });
}
async function openScannerAt(page, phase) {
  await page.click((await page.evaluate(() => innerWidth <= 720)) ? "#dock-scan" : "#btn-scan");
  await waitTop(page, "scanner");
  await page.waitForFunction(() => { const v = document.querySelector("#scanner video"); return v && v.videoWidth > 0; }, null, { timeout: 15000 });
  if (phase) await waitPhase(page, phase);
}
const primary = (page) => page.click("#scanner .result__foot .btn--primary");

// ---------------------------------------------------------------- shots
const produced = new Set();
const R = (f) => path.join(DOCS, f);
// Composites (hero, mobile, languages) render at 2x like every other shot.
const COMPOSITE_DPR = 2;
const raw = (f) => path.join(RAW, f);
const SHOTS = [];
const shot = (name, group, fn) => SHOTS.push({ name, group, fn });

// ---- README set (English)
shot("vault-dark", "readme", async () => {
  const p = await openApp({ scheme: "dark" });
  await shoot(p, R("vault-dark.png"));
  await closePage(p);
});
shot("vault-light", "readme", async () => {
  const p = await openApp({ scheme: "light" });
  await shoot(p, R("vault-light.png"));
  await closePage(p);
});
shot("labels", "readme", async () => {
  const p = await openApp({ scheme: "light" });
  await setView(p, "labels");
  await scrollToViewbar(p);
  await shoot(p, R("labels.png"));
  await closePage(p);
});
// The table needs ~1840 CSS px for every column without horizontal scrolling.
const TABLE_VIEW = { w: 1840, h: 920, dpr: 1.5 };
// Phones: 390 x 776 CSS (@3x); the templates add a status bar and home-indicator strip -> 390 x 844.
const PHONE = { w: 390, h: 776, dpr: 3, mobile: true };
shot("table", "readme", async () => {
  const p = await openApp({ ...TABLE_VIEW, scheme: "dark" });
  await setView(p, "table");
  await scrollToViewbar(p);
  await shoot(p, R("table.png"));
  await closePage(p);
});
shot("filters", "readme", async () => {
  const p = await openApp({ scheme: "light" });
  await scrollToViewbar(p);
  await openConnFilter(p);
  const clip = await unionClip(p, ["#viewbar", "#filters", ".popover.filter-pop"], 20, { bottom: 170, belowAppbar: true });
  await shoot(p, R("filters.png"), { clip });
  await closePage(p);
});
shot("detail", "readme", async () => {
  const p = await openApp({ scheme: "dark", h: 940 });
  await p.evaluate((id) => AM.act("openDetail", id), await codeId(p, "Living room floor lamp"));
  await waitTop(p, "sheet-detail");
  await blur(p);
  await shoot(p, R("detail.png"), { wait: 700 });
  await closePage(p);
});
shot("editor", "readme", async () => {
  const p = await openApp({ scheme: "light" });
  await p.evaluate((id) => AM.act("openEditor", id), await codeId(p, "Living room floor lamp"));
  await waitTop(p, "sheet-editor");
  await shoot(p, R("editor.png"), { wait: 700 });
  await closePage(p);
});
shot("scanner", "readme", async () => {
  const p = await openApp({ scheme: "dark", camera: true });
  await openScannerAt(p, 0);
  await waitPhase(p, 1);
  await waitResult(p, "matter");
  await shoot(p, R("scanner-live.png"), { wait: 1200 });
  await waitPhase(p, 2);
  await primary(p); // Save & scan next
  await waitResult(p, "homekit");
  await p.evaluate(() => { const b = document.querySelector("#scanner .tray-pill"); if (b && b.getAttribute("aria-expanded") === "false" && innerWidth <= 720) b.click(); });
  await shoot(p, R("scanner-result.png"), { wait: 1200 });
  await closePage(p);
  reseed("en");
});
shot("scanner-fallback", "readme", async () => {
  const p = await openApp({ scheme: "light", origin: "http://homeassistant.local:8123", init: () => { Object.defineProperty(window, "isSecureContext", { get: () => false, configurable: true }); } });
  await p.click("#btn-scan");
  await p.waitForSelector("#scanner .scanpage", { timeout: 10000 });
  await shoot(p, R("scanner-fallback.png"), { wait: 800 });
  await closePage(p);
});
shot("mobile", "readme", async () => {
  const phone = PHONE;
  let p = await openApp({ ...phone, scheme: "light" });
  await shoot(p, raw("m-vault.png"));
  await closePage(p);
  p = await openApp({ ...phone, scheme: "dark", camera: true });
  await openScannerAt(p, 1);
  await waitResult(p, "matter");
  await shoot(p, raw("m-scan.png"), { wait: 1200 });
  await closePage(p);
  reseed("en");
  p = await openApp({ ...phone, scheme: "dark" });
  await p.evaluate((id) => AM.act("openDetail", id), await codeId(p, "Front door lock"));
  await waitTop(p, "sheet-detail");
  await blur(p);
  await shoot(p, raw("m-detail.png"), { wait: 800 });
  await closePage(p);
  await renderTemplate("mobile.html", { shots: ["m-vault.png", "m-scan.png", "m-detail.png"].map((f) => fileUrl(raw(f))) }, R("mobile.png"), { w: 1200, h: 780, dpr: COMPOSITE_DPR });
});
shot("languages", "readme", async () => {
  const langs = [["ja", "light"], ["ar", "dark"], ["de", "dark"], ["uk", "light"]];
  const avail = langs.filter(([l]) => fs.existsSync(path.join(APP, "static", "locales", l + ".json")));
  if (avail.length < langs.length) { log("languages: missing locale files, skipped"); return; }
  const shots = [];
  for (const [l, scheme] of avail) {
    const p = await openApp({ lang: l, scheme });
    await shoot(p, raw(`lang-${l}.png`));
    const name = await p.evaluate((l) => (AntiMatterI18n.LANGUAGES.find((x) => x.code === l) || {}).name, l);
    shots.push({ src: fileUrl(raw(`lang-${l}.png`)), code: l, name, rtl: l === "ar" });
    await closePage(p);
  }
  await renderTemplate("languages.html", { shots }, R("languages.png"), { w: 1392, h: 992, dpr: COMPOSITE_DPR });
});
shot("hero", "readme", async () => {
  let p = await openApp({ scheme: "dark" });
  await shoot(p, raw("hero-dark.png"));
  await closePage(p);
  p = await openApp({ scheme: "light" });
  await shoot(p, raw("hero-light.png"));
  await closePage(p);
  p = await openApp({ ...PHONE, scheme: "dark", camera: true });
  await openScannerAt(p, 1);
  await waitResult(p, "matter");
  await shoot(p, raw("hero-phone.png"), { wait: 1200 });
  await closePage(p);
  reseed("en");
  await renderTemplate("hero.html", { dark: fileUrl(raw("hero-dark.png")), light: fileUrl(raw("hero-light.png")), phone: fileUrl(raw("hero-phone.png")) }, R("hero.png"), { w: 1280, h: 720, dpr: COMPOSITE_DPR });
});
shot("gif", "gif", async () => { await recordGif(); });

// ---- Legacy wiki set (same file names the upstream wiki embeds), en + nl
for (const lang of ["en", "nl"]) {
  const L = (f) => path.join(DOCS, lang, f);
  const T = { en: { office: "Office", plug: "Office smart plug", hall: "Hallway motion sensor", lamp: "Living room floor lamp" },
              nl: { office: "kantoor", plug: "Slimme stekker kantoor", hall: "Bewegingssensor hal", lamp: "Staande lamp woonkamer" } }[lang];
  const g = "legacy";
  shot(`full-screen-${lang}`, g, async () => {
    let p = await openApp({ lang, scheme: "dark", h: 720 });
    await shoot(p, L(lang === "en" ? "full_screen_black_en.png" : "full_screen_dark_nl.png"));
    await closePage(p);
    p = await openApp({ lang, scheme: "light", h: 720 });
    await shoot(p, L(`full_screen_light_${lang}.png`));
    await closePage(p);
  });
  shot(`tear-${lang}`, g, async () => {
    const dark = L(lang === "en" ? "full_screen_black_en.png" : "full_screen_dark_nl.png"), light = L(`full_screen_light_${lang}.png`);
    if (!fs.existsSync(dark) || !fs.existsSync(light)) throw new Error("run full-screen-" + lang + " first");
    await renderTemplate("tear.html", { dark: fileUrl(dark), light: fileUrl(light) }, L(`anti-matter-dark-light-tear-${lang}.png`), { w: 1280, h: 720 });
  });
  shot(`grid-view-${lang}`, g, async () => {
    const p = await openApp({ lang, scheme: "light" });
    await scrollToViewbar(p);
    await shoot(p, L(`grid-view-${lang}.png`));
    await closePage(p);
  });
  shot(`table-view-${lang}`, g, async () => {
    const p = await openApp({ ...TABLE_VIEW, lang, scheme: "light" });
    await setView(p, "table");
    await scrollToViewbar(p);
    await shoot(p, L(`table-view-${lang}.png`));
    await closePage(p);
  });
  shot(`new-dialog-${lang}`, g, async () => {
    const p = await openApp({ lang, scheme: "light", h: 900 });
    await p.evaluate(() => AM.act("openEditor", null));
    await waitTop(p, "sheet-editor");
    await fillNewMatter(p, lang);
    await shoot(p, L(`new-dialog-${lang}.png`), { el: "#sheet-editor", wait: 800 });
    await closePage(p);
  });
  shot(`filter-connectivity-${lang}`, g, async () => {
    const p = await openApp({ lang, scheme: "light" });
    await scrollToViewbar(p);
    await openConnFilter(p);
    const clip = await unionClip(p, ["#filters", ".popover.filter-pop"], 16, { belowAppbar: true });
    await shoot(p, L(`filter-connectivity-${lang}.png`), { clip });
    await closePage(p);
  });
  shot(`ha-device-search-${lang}`, g, async () => {
    const p = await openApp({ lang, scheme: "light", h: 900 });
    await p.evaluate((id) => AM.act("openEditor", id), await codeId(p, T.hall));
    await waitTop(p, "sheet-editor");
    await p.click("#ed-ha");
    await p.keyboard.type(T.office, { delay: 30 });
    await p.waitForSelector("#ed-ha-list:not([hidden]) .combobox__opt");
    const clip = await unionClip(p, ["#sheet-editor section[aria-labelledby=ed-ha-h]", "#ed-ha-list"], 14, { bottom: -13 });
    await shoot(p, L(`ha-device-search-${lang}.png`), { clip, keepPointer: true });
    await closePage(p);
  });
  shot(`ha-device-suggestion-${lang}`, g, async () => {
    const p = await openApp({ lang, scheme: "light", h: 900 });
    await p.evaluate((id) => AM.act("openEditor", id), await codeId(p, T.plug));
    await waitTop(p, "sheet-editor");
    await p.waitForSelector("#sheet-editor .suggest:not([hidden])", { timeout: 5000 });
    const clip = await unionClip(p, ["#sheet-editor section[aria-labelledby=ed-ha-h]"], 14);
    await shoot(p, L(`ha-device-suggestion-${lang}.png`), { clip });
    await closePage(p);
  });
  shot(`quickview-ha-links-${lang}`, g, async () => {
    const p = await openApp({ lang, scheme: "light" });
    await p.evaluate((id) => AM.act("openDetail", id), await codeId(p, T.lamp));
    await waitTop(p, "sheet-detail");
    await blur(p);
    await shoot(p, L(`quickview-ha-links-${lang}.png`), { el: "#sheet-detail", wait: 800 });
    await closePage(p);
  });
  shot(`trash-dialog-${lang}`, g, async () => {
    const p = await openApp({ lang, scheme: "light" });
    await p.evaluate(() => AM.act("openTrash"));
    await waitTop(p, "dialog-trash");
    await blur(p);
    await shoot(p, L(`trash-dialog-${lang}.png`), { el: "#dialog-trash", wait: 700 });
    await closePage(p);
  });
  shot(`backup-dialog-${lang}`, g, async () => {
    const p = await openApp({ lang, scheme: "light" });
    await p.evaluate(() => AM.act("openBackup"));
    await waitTop(p, "dialog-backup");
    await blur(p);
    await shoot(p, L(`backup-dialog-${lang}.png`), { el: "#dialog-backup", wait: 700 });
    await closePage(p);
  });
}

// ---- Brand images
shot("banner", "brand", async () => {
  await renderTemplate("banner.html", await brandData(), path.join(ROOT, "anti_matter", "banner.png"), { w: 960, h: 240, dpr: 2 });
});
shot("social", "brand", async () => {
  const shotFile = raw("social-app.png");
  const p = await openApp({ scheme: "dark" });
  await shoot(p, shotFile);
  await closePage(p);
  await renderTemplate("social.html", { ...(await brandData()), app: fileUrl(shotFile) }, path.join(ROOT, "social-preview.png"), { w: 1280, h: 640, dpr: 1 });
});
const TAGLINE = "Offline vault & scanner for smart-home pairing codes";
async function brandData() {
  const a = (f) => fileUrl(path.join(APP, "static", "assets", f));
  seed("en");
  const vault = JSON.parse(fs.readFileSync(path.join(HERE, "demo", "demo-vault.json"), "utf8"));
  const qr = {};
  for (const [k, name] of [["matter", "Living room floor lamp"], ["homekit", "Bedroom thermostat"], ["zwave", "Kitchen wall switch"]]) {
    const c = vault.codes.find((x) => x.name === name);
    const svg = await (await fetch(`${BASE}api/codes/${c.id}/qr.svg?border=1`)).text();
    qr[k] = { svg, code: c.code_type === "zwave" ? "PIN " + c.zwave_pin : c.manual_code };
  }
  return { tagline: TAGLINE, qr, icon: fileUrl(path.join(ROOT, "anti_matter", "icon.png")), logos: { matter: a("matter_logo.svg"), homekit: a("homekit_logo.png"), zwave: a("zwave_logo.png"), zigbee: a("zigbee_logo.png"), tuya: a("tuya_logo.svg") } };
}
const blur = (p) => p.evaluate(() => { if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur(); });

// ---------------------------------------------------------------- shot helpers
async function openConnFilter(p) {
  // The Connectivity chip is the last attribute filter; tick "Thread" (conn_matter).
  const chips = p.locator("#filters .chip");
  const n = await chips.count();
  let target = null;
  for (let i = 0; i < n; i++) { const c = chips.nth(i); if ((await c.getAttribute("data-field")) === "conn" || (await c.getAttribute("data-filter")) === "conn") { target = c; break; } }
  if (!target) target = chips.nth(n - 1 - ((await p.locator("#filters .chip--dashed").count()) ? 1 : 0));
  await target.click();
  await p.waitForSelector(".popover.filter-pop", { timeout: 5000 });
  const opts = p.locator(".popover.filter-pop label.opt");
  const k = await opts.count();
  for (let i = 0; i < k; i++) { if (/Thread/i.test(await opts.nth(i).textContent())) { await opts.nth(i).click(); break; } }
  await settle(p);
}

async function fillNewMatter(p, lang) {
  // A fake, valid Matter code (Eve Motion ids so the DCL mock names the vendor).
  const qr = JSON.parse(fs.readFileSync(path.join(FIX, "PAYLOADS.json"), "utf8")).matter_qr;
  const name = lang === "nl" ? "Aanwezigheid zolder" : "Attic presence";
  await p.fill("#ed-name", name).catch(async () => { await p.locator("#sheet-editor input[type=text]").first().fill(name); });
  const hasQr = await p.$("#ed-mt-qr");
  if (!hasQr) await p.click('#sheet-editor .proto-tile:has-text("Matter")').catch(() => {});
  await p.fill("#ed-mt-qr", qr);
  await p.locator("#ed-mt-qr").blur();
  await settle(p, 500);
  await p.evaluate(() => { const d = document.querySelector("#sheet-editor details.disclosure"); if (d) d.open = true; });
}

// ---------------------------------------------------------------- scan-demo.gif
async function recordGif() {
  if (!spawnSync("ffmpeg", ["-version"]).stdout) throw new Error("ffmpeg not found on PATH");
  const frames = path.join(WORK, "gif-frames");
  fs.rmSync(frames, { recursive: true, force: true });
  fs.mkdirSync(frames, { recursive: true });
  const W = 1152, H = 720;
  const p = await openApp({ w: W, h: H, dpr: 1, scheme: "dark", camera: true, motion: "no-preference" });
  await park(p);
  // CDP screencast: lossless PNG frames with timestamps (sharper than a WebM recording).
  const cdp = await p.__ctx.newCDPSession(p);
  const list = [];
  let n = 0, recording = true;
  cdp.on("Page.screencastFrame", async ({ data, metadata, sessionId }) => {
    if (recording) { const f = path.join(frames, `f${String(n++).padStart(5, "0")}.png`); fs.writeFileSync(f, Buffer.from(data, "base64")); list.push({ f, t: metadata.timestamp }); }
    await cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
  });
  await cdp.send("Page.startScreencast", { format: "png", maxWidth: W, maxHeight: H, everyNthFrame: 1 });
  await sleep(900);
  // Start while the camera shows the empty desk so the pan-in and lock-on are on film.
  await p.hover("#btn-scan");
  await sleep(250);
  await p.click("#btn-scan");
  await waitTop(p, "scanner");
  await park(p);
  await waitResult(p, "matter");
  await sleep(2600);
  await waitPhase(p, 2);
  await p.hover("#scanner .result__foot .btn--primary");
  await sleep(350);
  await primary(p); // Save & scan next
  await waitResult(p, "homekit");
  await sleep(2600);
  await p.hover("#scanner .result__foot .btn--primary");
  await sleep(350);
  await primary(p); // save the second code too
  await sleep(700);
  const done = p.locator('#scanner .tray .tbtn').first();
  if (await done.isVisible().catch(() => false)) { await done.hover(); await sleep(300); await done.click(); }
  else await p.keyboard.press("Escape");
  await p.waitForFunction(() => AM.sheets.top() === null, null, { timeout: 8000 }).catch(() => {});
  await sleep(2600);
  recording = false;
  await cdp.send("Page.stopScreencast").catch(() => {});
  await closePage(p);
  reseed("en");
  if (list.length < 10) throw new Error("screencast produced too few frames");
  // Frame durations from timestamps (the screencast only emits frames on change).
  const concat = list.map((x, i) => `file '${x.f}'\nduration ${Math.max(0.02, ((list[i + 1] || { t: x.t + 1.5 }).t - x.t)).toFixed(3)}`).join("\n") + `\nfile '${list[list.length - 1].f}'\n`;
  const listFile = path.join(frames, "list.txt");
  fs.writeFileSync(listFile, concat);
  const out = R("scan-demo.gif");
  const palette = path.join(frames, "palette.png");
  const vf = "fps=12,scale=900:-1:flags=lanczos";
  run("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", listFile, "-vf", `${vf},palettegen=max_colors=160:stats_mode=diff`, palette]);
  run("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", listFile, "-i", palette, "-lavfi", `${vf}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`, "-loop", "0", out]);
  produced.add(out);
  log("wrote", path.relative(ROOT, out), (fs.statSync(out).size / 1e6).toFixed(2), "MB");
}
function run(cmd, args) { const r = spawnSync(cmd, args, { encoding: "utf8" }); if (r.status !== 0) throw new Error(cmd + " failed: " + r.stderr); }

// ---------------------------------------------------------------- optimize
function optimize(files) {
  const pngs = [...files].filter((f) => f.endsWith(".png"));
  if (!pngs.length) return;
  const r = spawnSync(PY, [path.join(HERE, "optimize_png.py"), ...pngs], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  process.stdout.write(r.stdout || "");
}

// ---------------------------------------------------------------- main
async function main() {
  if (flag("list")) { for (const s of SHOTS) console.log(s.group.padEnd(8), s.name); return; }
  const todo = SHOTS.filter((s) => wanted(s.name, s.group));
  const needsCam = todo.some((s) => ["scanner", "mobile", "hero", "gif"].includes(s.name));
  if (needsCam && !fs.existsSync(path.join(FIX, "cam-flow.y4m"))) {
    log("generating fake camera fixture (make_fixtures.py)...");
    const r = spawnSync(PY, [path.join(HERE, "make_fixtures.py"), FIX], { stdio: "inherit" });
    if (r.status !== 0) throw new Error("make_fixtures.py failed");
  }
  if (!fs.existsSync(path.join(FIX, "PAYLOADS.json"))) spawnSync(PY, [path.join(HERE, "make_fixtures.py"), FIX], { stdio: "inherit" });
  if (!BASE) { backend = await startBackend(); BASE = backend.url; }
  else { if (!BASE.endsWith("/")) BASE += "/"; if (!STORAGE) log("BASE_URL without STORAGE_DIR: capturing whatever data that server holds"); else seed("en"); }
  const failed = [];
  try {
    for (const s of todo) {
      log("--", s.name);
      try { await s.fn(); } catch (e) { failed.push(s.name); log("FAILED", s.name, e.stack || e.message); }
    }
  } finally {
    for (const b of Object.values(browsers)) await b.close().catch(() => {});
    if (backend) backend.stop();
  }
  if (!flag("no-optimize")) optimize(produced);
  if (failed.length) { log("failed:", failed.join(", ")); process.exitCode = 1; }
}
main().catch((e) => { console.error(e); if (backend) backend.stop(); process.exit(1); });
