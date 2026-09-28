/* Shared helpers for the composite templates. capture.mjs passes data as JSON in location.hash
   and waits for window.__ready (set once every <img> has loaded). */
window.DATA = JSON.parse(decodeURIComponent(location.hash.slice(1) || "{}"));

function el(tag, attrs, ...kids) {
  const ns = /^(svg|path|line|ellipse|circle|rect|defs|linearGradient|stop|filter|feGaussianBlur|g)$/.test(tag) ? "http://www.w3.org/2000/svg" : null;
  const e = ns ? document.createElementNS(ns, tag) : document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === "style" && typeof v === "object") Object.assign(e.style, v);
    else if (k === "html") e.innerHTML = v;
    else e.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k != null) e.append(k);
  return e;
}

const STATUS_RIGHT = `
  <svg width="18" height="12" viewBox="0 0 18 12" fill="currentColor"><rect x="0" y="8" width="3" height="4" rx="1"/><rect x="5" y="5.5" width="3" height="6.5" rx="1"/><rect x="10" y="3" width="3" height="9" rx="1"/><rect x="15" y="0" width="3" height="12" rx="1"/></svg>
  <svg width="16" height="12" viewBox="0 0 16 12" fill="currentColor"><path d="M8 2.2c2.3 0 4.4.9 6 2.4l1.3-1.4A10.6 10.6 0 0 0 8 .3 10.6 10.6 0 0 0 .7 3.2L2 4.6c1.6-1.5 3.7-2.4 6-2.4Zm0 3.8c1.3 0 2.5.5 3.4 1.3l1.3-1.4A6.8 6.8 0 0 0 8 4.1c-1.8 0-3.4.7-4.7 1.8l1.3 1.4C5.5 6.5 6.7 6 8 6Zm0 3.8L10 7.7a3 3 0 0 0-4 0L8 9.8Z"/></svg>
  <svg width="27" height="13" viewBox="0 0 27 13" fill="none"><rect x=".5" y=".5" width="23" height="12" rx="3.5" stroke="currentColor" opacity=".45"/><rect x="2.5" y="2.5" width="19" height="8" rx="2" fill="currentColor"/><path d="M25 4.5v4c.8-.3 1.3-1.1 1.3-2s-.5-1.7-1.3-2Z" fill="currentColor" opacity=".5"/></svg>`;

/** Phone frame around a 390 x 776 CSS screenshot, built at native iPhone size (390 x 844 screen:
 *  47 px status bar + screenshot + 21 px home-indicator strip) and scaled to `width` px.
 *  tone: light | dark | black (status bar colour). */
function phone(src, { width, tone = "light", x, y, rotate = 0, z = 1 }) {
  const NATIVE_W = 390 + 22, NATIVE_H = 844 + 22, s = width / NATIVE_W;
  const screen = el("div", { class: "phone__screen" },
    el("div", { class: "phone__island" }),
    el("div", { class: "phone__status", html: `<span>9:41</span><span class="r">${STATUS_RIGHT}</span>` }),
    el("img", { src }),
    el("div", { class: "phone__home" }, el("span")));
  const inner = el("div", { class: `phone is-${tone}`, style: { transform: `scale(${s})`, transformOrigin: "0 0" } }, screen);
  return el("div", { style: { position: "absolute", left: x + "px", top: y + "px", width: width + "px", height: Math.round(NATIVE_H * s) + "px", transform: `rotate(${rotate}deg)`, zIndex: z } }, inner);
}

/** Dark/light tear with a luminous diagonal seam; t1/t2 = seam x at top/bottom (%). */
function tear(dark, light, { t1 = 60, t2 = 40 } = {}) {
  const box = el("div", { class: "tear", style: { "--t1": t1 + "%", "--t2": t2 + "%" } },
    el("img", { class: "dark", src: dark }), el("img", { class: "light", src: light }));
  box.style.setProperty("--t1", t1 + "%");
  box.style.setProperty("--t2", t2 + "%");
  box.insertAdjacentHTML("beforeend", `
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id="seam" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#5DE6F5"/><stop offset=".5" stop-color="#B0A2FF"/><stop offset="1" stop-color="#FF6FB5"/>
        </linearGradient>
        <filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="1.1"/></filter>
      </defs>
      <line x1="${t1}" y1="-2" x2="${t2}" y2="102" stroke="url(#seam)" stroke-width="1.6" opacity=".55" filter="url(#glow)" vector-effect="non-scaling-stroke" style="stroke-width:14px"/>
      <line x1="${t1}" y1="-2" x2="${t2}" y2="102" stroke="url(#seam)" vector-effect="non-scaling-stroke" style="stroke-width:2.5px"/>
    </svg>`);
  return box;
}

function orbits(w, h, cx, cy, s = 1, dots = true) {
  const e = el("svg", { class: "orbits", viewBox: `0 0 ${w} ${h}`, preserveAspectRatio: "none" });
  e.innerHTML = `
    <ellipse cx="${cx}" cy="${cy}" rx="${520 * s}" ry="${150 * s}" transform="rotate(-14 ${cx} ${cy})"/>
    <ellipse cx="${cx}" cy="${cy}" rx="${360 * s}" ry="${250 * s}" transform="rotate(22 ${cx} ${cy})"/>
    <ellipse cx="${cx}" cy="${cy}" rx="${190 * s}" ry="${190 * s}" stroke-dasharray="2 6"/>` + (dots ? `
    <circle cx="${cx - 500 * s}" cy="${cy + 40 * s}" r="3" fill="#3EE0F0"/>
    <circle cx="${cx + 330 * s}" cy="${cy - 170 * s}" r="2.5" fill="#FF6FB5"/>
    <circle cx="${cx + 150 * s}" cy="${cy + 240 * s}" r="2.2" fill="#8F78FF"/>` : "");
  return e;
}

async function ready() {
  await Promise.all([...document.images].map((i) => (i.complete ? null : new Promise((r) => { i.onload = i.onerror = r; }))));
  await document.fonts.ready;
  window.__ready = true;
}
