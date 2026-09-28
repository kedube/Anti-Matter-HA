// Browser smoke test for CI: boots the real backend on a throwaway vault (the committed
// fake demo set from tools/screenshots/demo) and drives the UI in headless Chromium.
// Fails on any console error, page error or failed request.
//
//   cd tools/ci && npm ci && npx playwright install chromium && node smoke.mjs
//   PYTHON=/path/to/python node smoke.mjs     # interpreter with app/requirements.txt installed
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PYTHON = process.env.PYTHON || "python3";
const PORT = Number(process.env.PORT || 8765);
const BASE = `http://127.0.0.1:${PORT}/`;
const NEW_MATTER = "MT:Y.K9042C00KA0648G00"; // CHIP spec example — not in the demo vault

let failures = 0;
const check = (cond, label, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"} ${label}${!cond && detail ? `  [${JSON.stringify(detail)}]` : ""}`);
  if (!cond) failures++;
};

// --- backend on a temp vault ---------------------------------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "am-smoke-"));
const storage = path.join(tmp, "config");
execFileSync(PYTHON, [path.join(ROOT, "tools/screenshots/seed_demo.py"), storage], { stdio: "inherit" });
const expectedCodes = JSON.parse(fs.readFileSync(path.join(storage, "anti_matter.json"), "utf8")).codes.length;
const server = spawn(PYTHON, ["main.py"], {
  cwd: path.join(ROOT, "anti_matter/app"),
  env: { ...process.env, STORAGE_DIR: storage, ANTIMATTER_DATA: tmp, ANTIMATTER_OPTIONS: path.join(tmp, "options.json"),
         ANTIMATTER_MEDIA: path.join(tmp, "media"), ANTIMATTER_PORT: String(PORT) },
  stdio: ["ignore", "inherit", "inherit"],
});
const stop = () => { try { server.kill(); } catch {} fs.rmSync(tmp, { recursive: true, force: true }); };
process.on("exit", stop);

for (let i = 0; ; i++) {
  try { if ((await fetch(BASE + "api/info")).ok) break; } catch {}
  if (i > 60) { console.error("backend did not start"); process.exit(1); }
  await new Promise((r) => setTimeout(r, 500));
}

// --- browser -----------------------------------------------------------------------------
const browser = await chromium.launch().catch(() => chromium.launch({ channel: "chrome" }));

async function page(query = "", viewport = { width: 1440, height: 900 }) {
  const p = await browser.newPage({ viewport });
  p.errors = [];
  p.on("console", (m) => { if (m.type() === "error") p.errors.push(m.text()); });
  p.on("pageerror", (e) => p.errors.push(String(e)));
  // ERR_ABORTED = the app cancelled its own request (e.g. a superseded lookup) — not an error.
  p.on("requestfailed", (r) => {
    const why = r.failure()?.errorText || "";
    if (!/ERR_ABORTED/.test(why)) p.errors.push(`request failed: ${r.url()} (${why})`);
  });
  // Keep CI offline and deterministic: no CSA DCL calls, no Home Assistant.
  await p.route("**/api/matter/**", (r) => r.fulfill({ status: 204 }));
  await p.goto(BASE + query, { waitUntil: "load" });
  await p.waitForFunction(() => document.documentElement.classList.contains("am-loaded")
    && !document.documentElement.classList.contains("am-booting"), null, { timeout: 20000 });
  return p;
}
const cards = (p) => p.evaluate(() => document.querySelectorAll("#view-cards > [data-id]").length);

try {
  // 1. Boot + vault render
  let p = await page();
  const info = await (await fetch(BASE + "api/info")).json();
  check((await p.textContent("#app-version")).includes(info.version), "version badge matches /api/info", info.version);
  check((await cards(p)) === expectedCodes, `renders all ${expectedCodes} demo codes as cards`, await cards(p));
  check(await p.evaluate(() => !!document.querySelector("#view-cards svg, #view-cards img")), "QR tiles render");

  // 2. Views
  for (const v of ["labels", "table", "cards"]) {
    await p.click(`#view-switch [data-view="${v}"]`);
    await p.waitForTimeout(250);
    check(await p.isVisible(`#view-${v}`), `${v} view shows`);
  }

  // 3. Editor opens from the New shortcut
  await p.keyboard.press("n");
  await p.waitForTimeout(300);
  check(/editor/.test(String(await p.evaluate(() => AM.sheets.top()))), "N opens the editor", await p.evaluate(() => AM.sheets.top()));
  await p.keyboard.press("Escape");
  await p.waitForTimeout(300);

  // 4. Scanner: paste mode decodes a new Matter code into the result sheet
  await p.click("#btn-scan");
  await p.waitForFunction(() => AM.sheets.top() === "scanner", null, { timeout: 5000 });
  await p.keyboard.press("3");
  await p.waitForSelector("#scn-paste");
  await p.fill("#scn-paste", NEW_MATTER);
  await p.press("#scn-paste", "Enter");
  await p.waitForSelector("#scanner .result:not([hidden])", { timeout: 15000 });
  const result = await p.evaluate(() => ({
    title: document.querySelector("#scanner .result:not([hidden]) .result__title")?.textContent.replace(/\s+/g, " ").trim(),
    code: document.querySelector("#scanner .result:not([hidden]) .receipt__code")?.textContent.trim(),
  }));
  check(result.code === "3497-011-2332", "paste decodes the Matter code", result);
  check(/New to vault/i.test(result.title || ""), "result sheet reports a new code", result);
  check(p.errors.length === 0, "no console/page/request errors (en)", p.errors);
  await p.close();

  // 5. RTL + CJK locales load their own strings
  p = await page("?lang=ar", { width: 390, height: 844 });
  const ar = await p.evaluate(() => ({ dir: document.documentElement.dir, title: document.getElementById("view-title").textContent }));
  check(ar.dir === "rtl" && /[؀-ۿ]/.test(ar.title), "Arabic: right-to-left with Arabic strings", ar);
  check(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "Arabic phone layout has no horizontal scroll");
  check(p.errors.length === 0, "no errors (ar)", p.errors);
  await p.close();

  p = await page("?lang=ja");
  const ja = await p.evaluate(() => document.getElementById("view-title").textContent);
  check(/[぀-ヿ一-鿿]/.test(ja), "Japanese strings load", ja);
  check(p.errors.length === 0, "no errors (ja)", p.errors);
  await p.close();
} catch (e) {
  check(false, "smoke run crashed", String(e && e.stack || e));
} finally {
  await browser.close();
}

console.log(failures ? `\n${failures} check(s) failed` : "\nsmoke: all checks passed");
process.exit(failures ? 1 : 0);
