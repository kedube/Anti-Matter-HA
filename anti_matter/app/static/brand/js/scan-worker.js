/**
 * Anti-Matter QR decode worker (classic Web Worker, no build step).
 *
 * Runs zxing-wasm (vendored in ../../vendor/zxing/) OFF the main thread. Every URL is
 * resolved against self.location, so it works under any path prefix such as Home
 * Assistant ingress (/api/hassio_ingress/<token>/) with no CDN and no absolute paths.
 * Started by scan-engine.js as `new Worker(<engine dir>/scan-worker.js?v=...)`.
 *
 * Protocol (main -> worker):
 *   {id, type:"decode", imageData | bitmap | blob | {width,height,buffer}, options}
 *       One zxing pass over one frame. options: {multi=true, tryHarder=true,
 *       tryInvert=true, tryRotate=true, tryDownscale=true, formats=["qr_code"],
 *       binarizer?, maxSymbols?}. ImageData/ImageBitmap/ArrayBuffer may be
 *       transferred. An ImageBitmap/Blob needs OffscreenCanvas here (see "ready").
 *   {id, type:"scanImage", imageData | bitmap | blob, scale?, options}
 *       Multi-pass still-image decode (original, greycast, inverted, 2x upscale,
 *       2x2 tiles); stops at the first pass that finds something unless
 *       options.exhaustive. `scale` maps the pixels sent to original-image pixels.
 *   {id, type:"ping"}
 * Worker -> main:
 *   {type:"ready", version, zxingCpp, offscreen, ms}   once, after the wasm is warm
 *   {type:"init-error", code:"init_failed", error}      the wasm/glue failed to load
 *   {id, type:"result", results:[{text, format, corners:[{x,y}x4], orientation,
 *       inverted, mirrored}], ms, passes?, passNames?, width?, height?,
 *       error?, code?}
 *   corners are [topLeft, topRight, bottomRight, bottomLeft] in the pixel space of the
 *   frame that was sent ("decode") or of the original image ("scanImage").
 *   code: "unsupported_image" (browser cannot decode the file, e.g. HEIC),
 *         "need_imagedata" (no OffscreenCanvas here: send ImageData instead),
 *         "decode_failed".
 */
/* global ZXingWASM */
"use strict";

var ZXING_VERSION = "3.1.4";
var VENDOR_BASE = new URL("../../vendor/zxing/", self.location.href).href;
var WASM_URL = VENDOR_BASE + "zxing_reader.wasm?v=" + ZXING_VERSION;

var T0 = Date.now();
var loadError = null;
try {
  importScripts(VENDOR_BASE + "zxing-reader.iife.js?v=" + ZXING_VERSION);
} catch (e) {
  loadError = e;
}

var HAS_OFFSCREEN = (function () {
  try {
    if (typeof OffscreenCanvas !== "function") return false;
    var c = new OffscreenCanvas(1, 1);
    return !!c.getContext("2d");
  } catch (e) {
    return false;
  }
})();

var ready = (function () {
  if (loadError || typeof ZXingWASM === "undefined") {
    return Promise.reject(loadError || new Error("zxing-wasm glue missing"));
  }
  return Promise.resolve(
    ZXingWASM.prepareZXingModule({
      overrides: {
        locateFile: function (path, prefix) {
          return /\.wasm$/.test(path) ? WASM_URL : prefix + path;
        },
      },
      fireImmediately: true,
    })
  ).then(function () {
    // Warm-up: the first readBarcodes call instantiates bindings/JIT paths.
    return ZXingWASM.readBarcodes(new ImageData(16, 16), { formats: ["QRCode"], maxNumberOfSymbols: 1 });
  });
})();

ready.then(
  function () {
    self.postMessage({
      type: "ready",
      version: ZXingWASM.ZXING_WASM_VERSION || ZXING_VERSION,
      zxingCpp: ZXingWASM.ZXING_CPP_COMMIT || "",
      offscreen: HAS_OFFSCREEN,
      ms: Date.now() - T0,
    });
  },
  function (e) {
    self.postMessage({ type: "init-error", code: "init_failed", error: String((e && e.message) || e) });
  }
);

/* ---------------------------------------------------------------- options -- */

var FORMAT_IN = {
  qr_code: "QRCode",
  micro_qr_code: "MicroQRCode",
  rm_qr_code: "RMQRCode",
  data_matrix: "DataMatrix",
  aztec: "Aztec",
  pdf417: "PDF417",
  code_128: "Code128",
  code_39: "Code39",
  ean_13: "EAN13",
  ean_8: "EAN8",
  upc_a: "UPCA",
  upc_e: "UPCE",
  itf: "ITF",
};

function zxFormats(list) {
  if (!list || !list.length) return ["QRCode"];
  var out = [];
  for (var i = 0; i < list.length; i++) {
    var f = String(list[i]);
    out.push(FORMAT_IN[f] || f);
  }
  return out;
}

/** zxing format name -> BarcodeDetector-style name (what native detect() returns). */
function outFormat(f) {
  f = String(f || "");
  if (/^QRCode/.test(f)) return "qr_code";
  if (f === "MicroQRCode") return "micro_qr_code";
  if (f === "RMQRCode") return "rm_qr_code";
  if (f === "DataMatrix") return "data_matrix";
  for (var k in FORMAT_IN) if (FORMAT_IN[k] === f) return k;
  return f.toLowerCase();
}

function readerOptions(o) {
  o = o || {};
  return {
    formats: zxFormats(o.formats),
    tryHarder: o.tryHarder !== false,
    tryInvert: o.tryInvert !== false,
    tryRotate: o.tryRotate !== false,
    tryDownscale: o.tryDownscale !== false,
    tryDenoise: !!o.tryDenoise,
    binarizer: o.binarizer || "LocalAverage",
    maxNumberOfSymbols: o.multi === false ? 1 : o.maxSymbols || 16,
    textMode: "Plain",
  };
}

function mapResults(list, sx, sy, ox, oy) {
  var out = [];
  for (var i = 0; i < list.length; i++) {
    var r = list[i];
    if (!r || !r.isValid) continue;
    var p = r.position || {};
    var pts = [p.topLeft, p.topRight, p.bottomRight, p.bottomLeft];
    var corners = [];
    for (var j = 0; j < 4; j++) {
      var q = pts[j] || { x: 0, y: 0 };
      corners.push({ x: q.x * sx + (ox || 0), y: q.y * sy + (oy || 0) });
    }
    out.push({
      text: r.text,
      format: outFormat(r.format),
      corners: corners,
      orientation: typeof r.orientation === "number" ? r.orientation : r.rotation || 0,
      inverted: !!r.isInverted,
      mirrored: !!r.isMirrored,
    });
  }
  return out;
}

/* ------------------------------------------------------------ pixel input -- */

function codedError(message, code) {
  var e = new Error(message);
  e.code = code;
  return e;
}

/** Draw a bitmap (optionally capped to maxDim) and read RGBA back. Closes the bitmap. */
function bitmapToImageData(bitmap, maxDim) {
  if (!HAS_OFFSCREEN) {
    try {
      bitmap.close();
    } catch (e) {
      /* ignore */
    }
    throw codedError("OffscreenCanvas unavailable in worker", "need_imagedata");
  }
  var w = bitmap.width;
  var h = bitmap.height;
  var s = maxDim ? Math.min(1, maxDim / Math.max(w, h)) : 1;
  var dw = Math.max(1, Math.round(w * s));
  var dh = Math.max(1, Math.round(h * s));
  var c = new OffscreenCanvas(dw, dh);
  var ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0, dw, dh);
  try {
    bitmap.close();
  } catch (e) {
    /* ignore */
  }
  return { imageData: ctx.getImageData(0, 0, dw, dh), scale: w / dw };
}

function blobToImageData(blob, maxDim) {
  if (!HAS_OFFSCREEN) return Promise.reject(codedError("OffscreenCanvas unavailable in worker", "need_imagedata"));
  return createImageBitmap(blob).then(
    function (bmp) {
      return bitmapToImageData(bmp, maxDim);
    },
    function () {
      throw codedError("This image format cannot be decoded by the browser", "unsupported_image");
    }
  );
}

/** Normalise any accepted input to {imageData, scale} (scale: sent px -> source px). */
function inputToImageData(msg, maxDim) {
  if (msg.imageData) return Promise.resolve({ imageData: msg.imageData, scale: 1 });
  if (msg.buffer && msg.width && msg.height) {
    return Promise.resolve({
      imageData: new ImageData(new Uint8ClampedArray(msg.buffer), msg.width, msg.height),
      scale: 1,
    });
  }
  if (msg.bitmap) {
    try {
      return Promise.resolve(bitmapToImageData(msg.bitmap, maxDim));
    } catch (e) {
      return Promise.reject(e);
    }
  }
  if (msg.blob) return blobToImageData(msg.blob, maxDim);
  return Promise.reject(codedError("No image in message", "decode_failed"));
}

/* ------------------------------------------------------- luma processing -- */

function rgbaToLuma(img) {
  var d = img.data;
  var n = img.width * img.height;
  var out = new Uint8ClampedArray(n);
  for (var i = 0, j = 0; j < n; i += 4, j++) {
    out[j] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  }
  return out;
}

/** v2.0.5 "greycast" fix: global min/max contrast stretch (screenshots with a grey cast). */
function stretch(luma) {
  var min = 255;
  var max = 0;
  for (var i = 0; i < luma.length; i++) {
    var v = luma[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  var range = max - min || 1;
  var out = new Uint8ClampedArray(luma.length);
  for (var k = 0; k < luma.length; k++) out[k] = ((luma[k] - min) / range) * 255 + 0.5;
  return out;
}

function invert(luma) {
  var out = new Uint8ClampedArray(luma.length);
  for (var i = 0; i < luma.length; i++) out[i] = 255 - luma[i];
  return out;
}

function lumaToImageData(luma, w, h) {
  var img = new ImageData(w, h);
  var d = img.data;
  for (var i = 0, j = 0; j < luma.length; i += 4, j++) {
    var v = luma[j];
    d[i] = v;
    d[i + 1] = v;
    d[i + 2] = v;
    d[i + 3] = 255;
  }
  return img;
}

/** Area-average downscale / bilinear upscale of an 8-bit plane. */
function resize(src, sw, sh, dw, dh) {
  var out = new Uint8ClampedArray(dw * dh);
  var x, y;
  if (dw <= sw && dh <= sh) {
    var fx = sw / dw;
    var fy = sh / dh;
    for (y = 0; y < dh; y++) {
      var y0 = Math.floor(y * fy);
      var y1 = Math.max(y0 + 1, Math.min(sh, Math.floor((y + 1) * fy)));
      for (x = 0; x < dw; x++) {
        var x0 = Math.floor(x * fx);
        var x1 = Math.max(x0 + 1, Math.min(sw, Math.floor((x + 1) * fx)));
        var sum = 0;
        for (var yy = y0; yy < y1; yy++) {
          var row = yy * sw;
          for (var xx = x0; xx < x1; xx++) sum += src[row + xx];
        }
        out[y * dw + x] = sum / ((y1 - y0) * (x1 - x0));
      }
    }
    return out;
  }
  var rx = (sw - 1) / Math.max(1, dw - 1);
  var ry = (sh - 1) / Math.max(1, dh - 1);
  for (y = 0; y < dh; y++) {
    var syf = y * ry;
    var sy0 = Math.floor(syf);
    var sy1 = Math.min(sh - 1, sy0 + 1);
    var wy = syf - sy0;
    for (x = 0; x < dw; x++) {
      var sxf = x * rx;
      var sx0 = Math.floor(sxf);
      var sx1 = Math.min(sw - 1, sx0 + 1);
      var wx = sxf - sx0;
      var top = src[sy0 * sw + sx0] * (1 - wx) + src[sy0 * sw + sx1] * wx;
      var bot = src[sy1 * sw + sx0] * (1 - wx) + src[sy1 * sw + sx1] * wx;
      out[y * dw + x] = top * (1 - wy) + bot * wy;
    }
  }
  return out;
}

function crop(src, sw, x, y, w, h) {
  var out = new Uint8ClampedArray(w * h);
  for (var r = 0; r < h; r++) out.set(src.subarray((y + r) * sw + x, (y + r) * sw + x + w), r * w);
  return out;
}

function fit(w, h, maxDim) {
  var s = Math.min(1, maxDim / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) };
}

/* ---------------------------------------------------------------- decode -- */

function now() {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function decodeFrame(msg) {
  var t0 = now();
  return ready
    .then(function () {
      return inputToImageData(msg, msg.options && msg.options.maxDim);
    })
    .then(function (src) {
      return ZXingWASM.readBarcodes(src.imageData, readerOptions(msg.options)).then(function (list) {
        return { results: mapResults(list, src.scale, src.scale, 0, 0), width: src.imageData.width, height: src.imageData.height };
      });
    })
    .then(function (r) {
      return { id: msg.id, type: "result", results: r.results, width: r.width, height: r.height, ms: Math.round(now() - t0) };
    });
}

var MAX_SOURCE = 3072; // cap for still images (memory on phones)
var PASS1_MAX = 2048;
var GREYCAST_MAX = 1800; // the v2.0.5 value
var UPSCALE_BELOW = 1000;
var TILES_FROM = 1400;

function scanImage(msg) {
  var t0 = now();
  var o = msg.options || {};
  var multi = o.multi !== false;
  var exhaustive = !!o.exhaustive;
  var base = { multi: multi, formats: o.formats, maxSymbols: o.maxSymbols };
  var found = [];
  var seen = {};
  var passNames = [];
  var extScale = msg.scale || 1;

  return ready
    .then(function () {
      return inputToImageData(msg, MAX_SOURCE);
    })
    .then(function (src) {
      var img = src.imageData;
      var W = img.width;
      var H = img.height;
      var toOrig = src.scale * extScale; // source px -> original image px
      var luma = null;
      function getLuma() {
        if (!luma) luma = rgbaToLuma(img);
        return luma;
      }
      var grey = null; // {luma, w, h} greycast plane (<= 1800)
      function getGrey() {
        if (!grey) {
          var g = fit(W, H, GREYCAST_MAX);
          var l = g.w === W && g.h === H ? getLuma() : resize(getLuma(), W, H, g.w, g.h);
          grey = { luma: stretch(l), w: g.w, h: g.h };
        }
        return grey;
      }

      function run(name, imageData, opts, sx, sy, ox, oy) {
        passNames.push(name);
        return ZXingWASM.readBarcodes(imageData, readerOptions(opts)).then(function (list) {
          var mapped = mapResults(list, sx, sy, ox, oy);
          for (var i = 0; i < mapped.length; i++) {
            var r = mapped[i];
            if (seen[r.text]) continue;
            seen[r.text] = true;
            r.pass = name;
            found.push(r);
          }
        });
      }

      var passes = [];
      // 1. original (downscaled to <= 2048 px, colour kept when no resize is needed)
      passes.push(function () {
        var f = fit(W, H, PASS1_MAX);
        var data = f.w === W && f.h === H ? img : lumaToImageData(resize(getLuma(), W, H, f.w, f.h), f.w, f.h);
        return run("original", data, base, (W / f.w) * toOrig, (H / f.h) * toOrig, 0, 0);
      });
      // 2. grayscale + global contrast stretch (keeps the v2.0.5 grey-cast screenshot fix)
      passes.push(function () {
        var g = getGrey();
        return run("greycast", lumaToImageData(g.luma, g.w, g.h), base, (W / g.w) * toOrig, (H / g.h) * toOrig, 0, 0);
      });
      // 3. inverted (white-on-black labels)
      passes.push(function () {
        var g = getGrey();
        var opts = Object.assign({}, base, { tryInvert: false });
        return run("inverted", lumaToImageData(invert(g.luma), g.w, g.h), opts, (W / g.w) * toOrig, (H / g.h) * toOrig, 0, 0);
      });
      // 4. 2x upscale for tiny codes in small images
      if (Math.max(W, H) < UPSCALE_BELOW) {
        passes.push(function () {
          var g = getGrey();
          var up = resize(g.luma, g.w, g.h, g.w * 2, g.h * 2);
          var opts = Object.assign({}, base, { tryDownscale: false });
          return run("upscale", lumaToImageData(up, g.w * 2, g.h * 2), opts, (W / (g.w * 2)) * toOrig, (H / (g.h * 2)) * toOrig, 0, 0);
        });
      }
      // 5. 2x2 overlapping tiles at full resolution for big photos (small codes)
      if (Math.max(W, H) >= TILES_FROM) {
        passes.push(function () {
          var tw = Math.round(W * 0.6);
          var th = Math.round(H * 0.6);
          var xs = [0, W - tw];
          var ys = [0, H - th];
          var chain = Promise.resolve();
          ys.forEach(function (ty) {
            xs.forEach(function (tx) {
              chain = chain.then(function () {
                var tile = stretch(crop(getLuma(), W, tx, ty, tw, th));
                var f = fit(tw, th, PASS1_MAX);
                var plane = f.w === tw && f.h === th ? tile : resize(tile, tw, th, f.w, f.h);
                return run("tile", lumaToImageData(plane, f.w, f.h), base, (tw / f.w) * toOrig, (th / f.h) * toOrig, tx * toOrig, ty * toOrig);
              });
            });
          });
          return chain;
        });
      }

      var i = 0;
      function next() {
        if (i >= passes.length) return Promise.resolve();
        if (found.length && !exhaustive) return Promise.resolve();
        return passes[i++]().then(next);
      }
      return next().then(function () {
        return {
          id: msg.id,
          type: "result",
          results: found,
          passes: i,
          passNames: passNames,
          width: Math.round(W * toOrig),
          height: Math.round(H * toOrig),
          ms: Math.round(now() - t0),
        };
      });
    });
}

self.onmessage = function (ev) {
  var msg = ev.data || {};
  var job;
  if (msg.type === "decode") job = decodeFrame(msg);
  else if (msg.type === "scanImage") job = scanImage(msg);
  else if (msg.type === "ping") {
    job = ready.then(function () {
      return { id: msg.id, type: "result", results: [], ms: 0 };
    });
  } else return;
  job.then(
    function (reply) {
      self.postMessage(reply);
    },
    function (e) {
      self.postMessage({
        id: msg.id,
        type: "result",
        results: [],
        ms: 0,
        error: String((e && e.message) || e),
        code: (e && e.code) || "decode_failed",
      });
    }
  );
};
