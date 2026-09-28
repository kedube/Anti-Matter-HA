/**
 * Anti-Matter QR scanning engine (no UI). Classic script, no build step, no CDN.
 * Global: window.AntiMatterScanEngine
 *
 * Decoding: native BarcodeDetector when the platform has a working one (Android, macOS
 * and ChromeOS Chrome), otherwise zxing-wasm in a Web Worker (scan-worker.js, vendored
 * wasm in static/vendor/zxing/). The worker path covers iOS Safari / the HA iOS app,
 * Firefox and Windows/Linux Chrome, and photo decoding works in insecure (http://)
 * contexts too. The decoder never runs on the main thread. All URLs are derived from
 * this script's own src (captured at load), so it works under HA ingress
 * (/api/hassio_ingress/<token>/) and any other path prefix.
 *
 * ---------------------------------------------------------------------------------
 * API
 * ---------------------------------------------------------------------------------
 * env() -> {secureContext, hasMediaDevices, hasNativeDetector, hasWasm, hasWorker,
 *           canLiveScan, canDecodeImages, inIframe, haBridgeAvailable, vibrate,
 *           workerReady, engineVersion, zxingVersion,
 *           platform:{ios, android, mobile, safari, firefox, chromium, haCompanion, touch}}
 *   Cheap and synchronous. canLiveScan = camera API + a decoder. In an insecure
 *   context hasMediaDevices is false (show "live camera needs HTTPS"; photos still work).
 *
 * warmup() -> Promise<boolean>   Start the worker and compile the wasm (call when the
 *   scan UI opens so the first frame decodes instantly). Never rejects.
 *
 * createCameraSession(opts) -> Promise<CameraSession>
 *   opts: {
 *     video: HTMLVideoElement            required; the engine sets srcObject/playsinline/muted
 *                                        and owns video.style.transform (CSS zoom, mirror)
 *     facingMode = "environment", deviceId?,
 *     continuous = false                 false: after the first hit the session PAUSES
 *                                        decoding (camera stays live; call resume() to scan
 *                                        again, or stop()). true: batch mode.
 *     onDetect(results, meta)            fires once per distinct payload; the same text
 *                                        fires again only after it left the frame > 1.5 s
 *     onTrack?(results, meta)            every decoded frame with codes (and once with []
 *                                        when they disappear): for drawing tracking outlines
 *     onFrameStats?(stats)               ~1/s: {engine, decodesPerSec, avgMs, lastMs,
 *                                        frames, skipped, frameWidth, frameHeight}
 *     onState?(state)                    "starting"|"live"|"paused"|"suspended"|"stopped"
 *     onError(err)                       err.code: "insecure_context" | "no_camera" |
 *                                        "permission_denied" | "in_use" | "unsupported" |
 *                                        "unknown" (err.policy=true when a Permissions-Policy
 *                                        blocks the camera). Called for start-up failures
 *                                        AND fatal runtime failures (track lost and could not
 *                                        be re-acquired). The returned promise also rejects
 *                                        with the same error (already caught for you, so
 *                                        using only onError is fine). Stopping before the
 *                                        camera is live rejects with code "aborted" and does
 *                                        not call onError.
 *     engine = "auto"|"native"|"zxing", mirror = false,
 *     region = "visible"|"full"          decode only what the <video> shows (object-fit crop
 *                                        and CSS zoom = digital zoom for the decoder) or the
 *                                        whole frame
 *     formats = ["qr_code"], intervalMs = 125 (~8 fps), maxFrameDim = 720, leaveMs = 1500
 *   }
 *   The returned promise has a `.session` property available immediately, so
 *   `p.session.stop()` works while the permission prompt is still pending (the stream
 *   is stopped the moment it arrives). Frames are sampled with setTimeout (never
 *   requestAnimationFrame), downscaled to <= 720 px, and a frame is skipped while the
 *   previous one is still being decoded.
 *
 *   Result objects (onDetect/onTrack/decodeImage):
 *     {text, format:"qr_code"|..., source:"native"|"zxing",
 *      corners:[{x,y} x4]  topLeft, topRight, bottomRight, bottomLeft,
 *      box:{left, top, width, height}}
 *     Live: corners/box are CSS px in the <video> element's own box (object-fit,
 *     object-position, CSS zoom and mirror applied), ready for an absolutely positioned
 *     overlay placed at the video's offsetLeft/offsetTop; frameCorners are in video
 *     pixels. decodeImage: corners/box are in the original image's pixels.
 *   meta: {engine, ms, timestamp, all (every code in this frame), display:{width, height,
 *          offsetLeft, offsetTop}, video:{width, height}, frame:{width, height, sx, sy,
 *          sw, sh}}
 *
 * CameraSession
 *   state, engine ("native"|"zxing"), video
 *   stop() -> Promise   torch OFF (awaited) THEN stop tracks: Android camera-HAL crash
 *                       workaround. Idempotent; safe before the camera is live.
 *   pause() / resume({reset?})   pause/resume decoding (camera stays on). resume()
 *                       re-arms: codes still in view must leave the frame first unless
 *                       {reset:true}.
 *   capabilities() -> {torch, zoom:{min,max,step,value}|null (hardware), cssZoom:{min,max,
 *                       step,value}, focus (tap-to-focus possible), cameras:[{deviceId,
 *                       label}], deviceId, facingMode}
 *   setTorch(on) -> Promise<boolean>
 *   setZoom(value) -> Promise<{mode:"hardware"|"css", value}>  CSS mode scales the video
 *                       AND crops the decoded region (real digital zoom for the decoder)
 *   focusAt(xNorm, yNorm) -> Promise<boolean>  0..1 within the <video> element box
 *   switchCamera() -> Promise<{deviceId,label}|null>   next video input
 *   useCamera(deviceId) -> Promise<{deviceId,label}>
 *   lastFrameCanvas() -> HTMLCanvasElement|null  copy of the most recently decoded frame
 *   Tab hidden / pagehide: decoding stops and the camera is released (torch off first);
 *   it is re-acquired automatically when visible again. A track that ends while visible
 *   is re-acquired once; if that fails onError fires and the session stops.
 *
 * decodeImage(input, {multi=true, formats, exhaustive=false}) ->
 *     Promise<{results, passes, passNames, width, height, ms, engine}>
 *   input: File | Blob | ImageBitmap | HTMLCanvasElement | OffscreenCanvas |
 *          HTMLImageElement | HTMLVideoElement | ImageData.
 *   Passes (stop at the first that finds anything unless exhaustive): original (<= 2048
 *   px), greycast (grayscale + contrast stretch, the v2.0.5 fix), inverted, 2x upscale
 *   (small images), 2x2 overlapping tiles (big photos), then native BarcodeDetector if
 *   present. Returns ALL distinct codes. Rejects with err.code "not_found" (err.passes),
 *   "unsupported_image" (e.g. HEIC the browser cannot decode) or "unsupported".
 *
 * parseText(text) / parseTextAll(text)  -> AntiMatterScan.parseScannedText(All)
 * vibrate(pattern) -> boolean   no-op-safe navigator.vibrate
 * haptic(kind="success") -> "bridge"|"vibrate"|false   HA Companion haptic via
 *   AntiMatterHaBridge when present, else a vibration pattern. kinds: success, warning,
 *   failure, light, medium, heavy, selection.
 * stopAll() -> Promise   stop every live/pending session.
 */
(function (global) {
  "use strict";

  // Loaded twice (e.g. a second script tag)? Keep the first instance.
  if (global.AntiMatterScanEngine && global.AntiMatterScanEngine.createCameraSession) return;

  var VERSION = "3.0.1";
  var doc = global.document;

  // Captured at load: document.currentScript is only set while this file executes.
  var SCRIPT_URL = (function () {
    try {
      var cs = doc && doc.currentScript;
      if (cs && cs.src) return cs.src;
      var tags = doc ? doc.getElementsByTagName("script") : [];
      for (var i = tags.length - 1; i >= 0; i--) {
        if (/scan-engine\.js(\?|$)/.test(tags[i].src)) return tags[i].src;
      }
      return new URL("./static/brand/js/scan-engine.js", doc.baseURI).href;
    } catch (e) {
      return "./static/brand/js/scan-engine.js";
    }
  })();
  var WORKER_URL = (function () {
    try {
      return new URL("scan-worker.js?v=" + VERSION, SCRIPT_URL).href;
    } catch (e) {
      return "./static/brand/js/scan-worker.js?v=" + VERSION;
    }
  })();

  var INTERVAL_MS = 125; // ~8 fps. NEVER sample every rAF frame (see LESSONS below).
  var MAX_FRAME_DIM = 720;
  var LEAVE_MS = 1500;
  var FRAME_TIMEOUT_MS = 6000;
  var IMAGE_TIMEOUT_MS = 90000;
  var MAX_MAIN_THREAD_DIM = 2048;
  var HAPTIC_PATTERNS = {
    success: [50, 50, 50],
    warning: [100, 50, 100],
    failure: [200, 100, 200],
    light: [50],
    medium: [100],
    heavy: [200],
    selection: [20],
  };

  /*
   * LESSONS carried over from matter-scanner.js (v2.x), keep them:
   * - Sampling every displayed frame via requestAnimationFrame (60-120 Hz on phones)
   *   ran the detector far more often than QR scanning needs; on devices without a
   *   hardware Shape Detection backend that sustained CPU/memory pressure crashed the
   *   tab's renderer mid-scan (Chrome silently reloads the page, which looked like the
   *   whole app crashed). ~8 decodes/s from a setTimeout loop is plenty responsive.
   * - Feeding the decoder a full-resolution frame (1080p+) is slower and no more
   *   reliable; draw onto a <= 720 px canvas first. Ask getUserMedia for ~1280x720.
   * - Stopping a track while its torch is still on crashes the camera HAL on some
   *   Android phones (the renderer/GPU process dies): torch off, wait, THEN stop.
   * - Screenshots can bake in a faint grey cast that breaks the black/white threshold:
   *   retry photos against a grayscale + contrast-stretched copy (v2.0.5).
   */

  function now() {
    return global.performance && performance.now ? performance.now() : Date.now();
  }

  function scanError(code, message, cause) {
    var e = new Error(message || code);
    e.name = "ScanEngineError";
    e.code = code;
    if (cause) e.cause = cause;
    return e;
  }

  function safeCall(fn) {
    if (typeof fn !== "function") return undefined;
    try {
      return fn.apply(null, Array.prototype.slice.call(arguments, 1));
    } catch (e) {
      if (global.console) console.error("[scan-engine] callback failed", e);
      return undefined;
    }
  }

  function withTimeout(promise, ms) {
    return new Promise(function (resolve, reject) {
      var t = setTimeout(function () {
        reject(scanError("timeout", "Timed out"));
      }, ms);
      Promise.resolve(promise).then(
        function (v) {
          clearTimeout(t);
          resolve(v);
        },
        function (e) {
          clearTimeout(t);
          reject(e);
        }
      );
    });
  }

  /* ---------------------------------------------------------------- env -- */

  function env() {
    var nav = global.navigator || {};
    var ua = nav.userAgent || "";
    var inIframe;
    try {
      inIframe = global.self !== global.top;
    } catch (e) {
      inIframe = true;
    }
    var hasMediaDevices = !!(nav.mediaDevices && typeof nav.mediaDevices.getUserMedia === "function");
    var hasNativeDetector = "BarcodeDetector" in global;
    var hasWasm = typeof WebAssembly === "object" && typeof WebAssembly.instantiate === "function";
    var hasWorker = typeof Worker === "function";
    var ios = /iP(hone|ad|od)/.test(ua) || (/Macintosh/.test(ua) && (nav.maxTouchPoints || 0) > 1);
    var android = /Android/i.test(ua);
    var bridgeOk = false;
    try {
      bridgeOk = !!(global.AntiMatterHaBridge && global.AntiMatterHaBridge.available());
    } catch (e) {
      bridgeOk = false;
    }
    var decoder = (hasWasm && hasWorker && !W.dead) || hasNativeDetector;
    return {
      secureContext: !!global.isSecureContext,
      hasMediaDevices: hasMediaDevices,
      hasNativeDetector: hasNativeDetector,
      hasWasm: hasWasm,
      hasWorker: hasWorker,
      canLiveScan: hasMediaDevices && decoder,
      canDecodeImages: decoder,
      inIframe: inIframe,
      haBridgeAvailable: bridgeOk,
      vibrate: typeof nav.vibrate === "function",
      workerReady: !!W.info,
      engineVersion: VERSION,
      zxingVersion: W.info ? W.info.version : null,
      platform: {
        ios: ios,
        android: android,
        mobile: ios || android || /Mobi/i.test(ua),
        safari: /Safari\//.test(ua) && !/Chrome|Chromium|CriOS|FxiOS|EdgiOS|Android/.test(ua),
        firefox: /Firefox\/|FxiOS/.test(ua),
        chromium: /Chrome\/|Chromium|CriOS|Edg\//.test(ua),
        haCompanion: /Home ?Assistant\//i.test(ua),
        touch: (nav.maxTouchPoints || 0) > 0,
      },
    };
  }

  /* ------------------------------------------------------------- worker -- */

  var W = { worker: null, readyPromise: null, info: null, pending: {}, seq: 0, failures: 0, dead: false };

  function rejectPending(err) {
    var ids = Object.keys(W.pending);
    for (var i = 0; i < ids.length; i++) {
      var p = W.pending[ids[i]];
      delete W.pending[ids[i]];
      clearTimeout(p.timer);
      p.reject(err);
    }
  }

  function resetWorker(err) {
    var w = W.worker;
    W.worker = null;
    W.readyPromise = null;
    W.info = null;
    if (w) {
      try {
        w.terminate();
      } catch (e) {
        /* ignore */
      }
    }
    rejectPending(err || scanError("engine_unavailable", "Decoder restarted"));
  }

  function getWorker() {
    if (W.readyPromise) return W.readyPromise;
    if (W.dead) return Promise.reject(scanError("engine_unavailable", "QR decoder failed to start"));
    if (typeof Worker !== "function" || typeof WebAssembly !== "object") {
      return Promise.reject(scanError("unsupported", "Web Workers / WebAssembly unavailable"));
    }
    var p = new Promise(function (resolve, reject) {
      var worker;
      var settled = false;
      try {
        worker = new Worker(WORKER_URL);
      } catch (e) {
        reject(scanError("engine_unavailable", "Could not start the decoder worker", e));
        return;
      }
      var timer = setTimeout(function () {
        fail(scanError("engine_unavailable", "QR decoder did not start in time"));
      }, 20000);
      function fail(err) {
        clearTimeout(timer);
        if (W.worker === worker || !settled) {
          if (W.readyPromise === p) {
            W.readyPromise = null;
            W.info = null;
          }
          if (W.worker === worker) W.worker = null;
          try {
            worker.terminate();
          } catch (e) {
            /* ignore */
          }
          W.failures++;
          if (W.failures >= 3) W.dead = true;
          rejectPending(err);
        }
        if (!settled) {
          settled = true;
          reject(err);
        }
      }
      worker.onmessage = function (ev) {
        var m = ev.data || {};
        if (m.type === "ready") {
          clearTimeout(timer);
          settled = true;
          W.worker = worker;
          W.info = m;
          W.failures = 0;
          resolve(worker);
        } else if (m.type === "init-error") {
          fail(scanError("engine_unavailable", m.error || "QR decoder failed to load"));
        } else if (m.type === "result") {
          var pend = W.pending[m.id];
          if (!pend) return;
          delete W.pending[m.id];
          clearTimeout(pend.timer);
          if (m.error) pend.reject(scanError(m.code || "decode_failed", m.error));
          else pend.resolve(m);
        }
      };
      worker.onerror = function (ev) {
        if (ev && ev.preventDefault) ev.preventDefault();
        fail(scanError("engine_unavailable", (ev && ev.message) || "QR decoder worker crashed"));
      };
    });
    W.readyPromise = p;
    p.catch(function () {
      if (W.readyPromise === p) W.readyPromise = null; // allow a later retry
    });
    return p;
  }

  function workerCall(msg, transfer, timeoutMs) {
    return getWorker().then(function (worker) {
      return new Promise(function (resolve, reject) {
        var id = ++W.seq;
        msg.id = id;
        var timer = setTimeout(function () {
          if (!W.pending[id]) return;
          delete W.pending[id];
          reject(scanError("timeout", "QR decoder timed out"));
          // A stuck worker would block every later frame: recycle it.
          resetWorker(scanError("timeout", "QR decoder restarted after a timeout"));
        }, timeoutMs || FRAME_TIMEOUT_MS);
        W.pending[id] = { resolve: resolve, reject: reject, timer: timer };
        try {
          worker.postMessage(msg, transfer || []);
        } catch (e) {
          clearTimeout(timer);
          delete W.pending[id];
          reject(scanError("decode_failed", "Could not send the image to the decoder", e));
        }
      });
    });
  }

  function warmup() {
    return getWorker().then(
      function () {
        return true;
      },
      function () {
        return false;
      }
    );
  }

  /* ------------------------------------------------------ native detector -- */

  var nativeCheck = null;
  function nativeSupported(formats) {
    if (!("BarcodeDetector" in global)) return Promise.resolve(false);
    if (!nativeCheck) {
      nativeCheck = new Promise(function (resolve) {
        try {
          var BD = global.BarcodeDetector;
          var p = typeof BD.getSupportedFormats === "function" ? BD.getSupportedFormats() : Promise.resolve(["qr_code"]);
          Promise.resolve(p).then(
            function (list) {
              resolve(Array.isArray(list) ? list : []);
            },
            function () {
              resolve([]);
            }
          );
        } catch (e) {
          resolve([]);
        }
      });
    }
    return nativeCheck.then(function (list) {
      var want = formats && formats.length ? formats : ["qr_code"];
      for (var i = 0; i < want.length; i++) if (list.indexOf(want[i]) >= 0) return true;
      return false;
    });
  }

  function makeNativeDetector(formats) {
    var want = formats && formats.length ? formats : ["qr_code"];
    return new global.BarcodeDetector({ formats: want });
  }

  function mapNative(codes, sx, sy, ox, oy) {
    var out = [];
    var seen = {};
    for (var i = 0; i < (codes || []).length; i++) {
      var c = codes[i];
      if (!c || !c.rawValue || seen[c.rawValue]) continue;
      seen[c.rawValue] = true;
      var pts = c.cornerPoints && c.cornerPoints.length === 4 ? c.cornerPoints : null;
      if (!pts) {
        var b = c.boundingBox || { x: 0, y: 0, width: 0, height: 0 };
        pts = [
          { x: b.x, y: b.y },
          { x: b.x + b.width, y: b.y },
          { x: b.x + b.width, y: b.y + b.height },
          { x: b.x, y: b.y + b.height },
        ];
      }
      var corners = [];
      for (var j = 0; j < 4; j++) corners.push({ x: pts[j].x * sx + (ox || 0), y: pts[j].y * sy + (oy || 0) });
      out.push({ text: c.rawValue, format: c.format || "qr_code", corners: corners, source: "native" });
    }
    return out;
  }

  function boxOf(corners) {
    var minX = Infinity;
    var minY = Infinity;
    var maxX = -Infinity;
    var maxY = -Infinity;
    for (var i = 0; i < corners.length; i++) {
      var p = corners[i];
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    return { left: minX, top: minY, width: maxX - minX, height: maxY - minY };
  }

  /* ------------------------------------------------- display coordinates -- */

  function parsePos(tok, free) {
    if (!tok) return free / 2;
    if (/%$/.test(tok)) return (free * parseFloat(tok)) / 100;
    if (/px$/.test(tok)) return parseFloat(tok);
    if (tok === "left" || tok === "top") return 0;
    if (tok === "right" || tok === "bottom") return free;
    return free / 2;
  }

  /**
   * How the intrinsic video frame lands inside the <video> element box: replicates
   * object-fit/object-position (the old mapBoxToDisplay handled cover only).
   */
  function fitParams(video) {
    var vw = video.videoWidth;
    var vh = video.videoHeight;
    var cw = video.clientWidth;
    var ch = video.clientHeight;
    if (!vw || !vh || !cw || !ch) return null;
    var cs = null;
    try {
      cs = global.getComputedStyle(video);
    } catch (e) {
      cs = null;
    }
    var fitMode = (cs && cs.objectFit) || "contain";
    var sx;
    var sy;
    if (fitMode === "cover") sx = sy = Math.max(cw / vw, ch / vh);
    else if (fitMode === "fill") {
      sx = cw / vw;
      sy = ch / vh;
    } else if (fitMode === "none") sx = sy = 1;
    else if (fitMode === "scale-down") sx = sy = Math.min(1, cw / vw, ch / vh);
    else sx = sy = Math.min(cw / vw, ch / vh);
    var parts = String((cs && cs.objectPosition) || "50% 50%").trim().split(/\s+/);
    var ox = parsePos(parts[0], cw - vw * sx);
    var oy = parsePos(parts[1] || (parts[0] === "top" || parts[0] === "bottom" ? parts[0] : "50%"), ch - vh * sy);
    return { vw: vw, vh: vh, cw: cw, ch: ch, sx: sx, sy: sy, ox: ox, oy: oy };
  }

  function videoToDisplay(pt, f, zoom, mirror) {
    var x = pt.x * f.sx + f.ox;
    var y = pt.y * f.sy + f.oy;
    var hx = f.cw / 2;
    var hy = f.ch / 2;
    x = hx + (x - hx) * zoom * (mirror ? -1 : 1);
    y = hy + (y - hy) * zoom;
    return { x: x, y: y };
  }

  function displayToVideo(pt, f, zoom, mirror) {
    var hx = f.cw / 2;
    var hy = f.ch / 2;
    var x = hx + (pt.x - hx) / (zoom * (mirror ? -1 : 1));
    var y = hy + (pt.y - hy) / zoom;
    return { x: (x - f.ox) / f.sx, y: (y - f.oy) / f.sy };
  }

  /* ------------------------------------------------------------ errors -- */

  function permissionPolicyBlocks() {
    try {
      var pp = doc.permissionsPolicy || doc.featurePolicy;
      if (pp && typeof pp.allowsFeature === "function") return !pp.allowsFeature("camera");
    } catch (e) {
      /* ignore */
    }
    return false;
  }

  function mapCameraError(err) {
    if (err && err.name === "ScanEngineError") return err;
    var name = (err && err.name) || "";
    var code = "unknown";
    if (name === "NotAllowedError" || name === "PermissionDeniedError" || name === "SecurityError") code = "permission_denied";
    else if (
      name === "NotFoundError" ||
      name === "DevicesNotFoundError" ||
      name === "OverconstrainedError" ||
      name === "ConstraintNotSatisfiedError"
    )
      code = "no_camera";
    else if (name === "NotReadableError" || name === "TrackStartError" || name === "AbortError") code = "in_use";
    else if (name === "TypeError") code = global.isSecureContext ? "unsupported" : "insecure_context";
    var e = scanError(code, (err && err.message) || name || "Camera error", err);
    if (code === "permission_denied" && permissionPolicyBlocks()) e.policy = true;
    return e;
  }

  /* ------------------------------------------------------ camera session -- */

  var sessions = [];

  function CameraSession(opts) {
    this.opts = opts;
    this.video = opts.video || null;
    this.state = "idle";
    this.engine = null;
    this.stream = null;
    this.track = null;
    this._facingMode = opts.facingMode || "environment";
    this._deviceId = opts.deviceId || null;
    this._continuous = !!opts.continuous;
    this._mirror = !!opts.mirror;
    this._formats = opts.formats && opts.formats.length ? opts.formats.slice() : ["qr_code"];
    this._interval = Math.max(60, opts.intervalMs || INTERVAL_MS);
    this._maxDim = opts.maxFrameDim || MAX_FRAME_DIM;
    this._leaveMs = opts.leaveMs || LEAVE_MS;
    this._region = opts.region === "full" ? "full" : "visible";
    this._stopped = false;
    this._paused = false;
    this._halted = false;
    this._suspended = false;
    this._inFlight = false;
    this._timer = null;
    this._torch = false;
    this._hwZoom = null;
    this._cssZoom = 1;
    this._seen = {};
    this._hadTrack = false;
    this._cameras = [];
    this._native = null;
    this._nativeErrors = 0;
    this._workerErrors = 0;
    this._framesSinceAssist = 0;
    this._lastHit = 0;
    this._op = Promise.resolve();
    this._stopPromise = null;
    this._origTransform = this.video ? this.video.style.transform : "";
    this._origOrigin = this.video ? this.video.style.transformOrigin : "";
    this._canvas = doc.createElement("canvas");
    this._ctx = this._canvas.getContext("2d", { willReadFrequently: true });
    this._stats = { frames: 0, skipped: 0, decodes: 0, totalMs: 0, lastMs: 0, windowStart: now(), windowDecodes: 0, windowMs: 0 };
    var self = this;
    this._tick = function () {
      self._onTick();
    };
    this._onVisibility = function () {
      if (doc.hidden) self._suspend();
      else self._wake();
    };
    this._onPageHide = function () {
      self._suspend();
    };
    this._onPageShow = function () {
      if (!doc.hidden) self._wake();
    };
    this._onEnded = function () {
      self._trackEnded();
    };
  }

  CameraSession.prototype._setState = function (s) {
    if (this.state === s) return;
    this.state = s;
    safeCall(this.opts.onState, s);
  };

  CameraSession.prototype._fatal = function (err) {
    var e = mapCameraError(err); // ScanEngineErrors pass through; DOMException.code is numeric
    if (!this._stopped) {
      this.stop();
      safeCall(this.opts.onError, e);
    }
    return e;
  };

  CameraSession.prototype._queue = function (fn) {
    var self = this;
    var run = this._op.then(function () {
      return fn.call(self);
    });
    this._op = run.catch(function () {});
    return run;
  };

  CameraSession.prototype._start = function () {
    var self = this;
    var e = env();
    if (!this.video || typeof this.video.play !== "function") {
      return Promise.reject(this._fatal(scanError("unsupported", "createCameraSession needs a <video> element")));
    }
    if (!e.hasMediaDevices) {
      return Promise.reject(
        this._fatal(
          e.secureContext
            ? scanError("unsupported", "This browser has no camera API")
            : scanError("insecure_context", "Live camera needs HTTPS (secure context)")
        )
      );
    }
    this._setState("starting");
    var enginePromise = this._chooseEngine();
    enginePromise.catch(function () {});
    return this._queue(function () {
      return self._acquire(self._deviceId);
    })
      .then(function () {
        return enginePromise;
      })
      .then(
        function (engine) {
          if (self._stopped) throw scanError("aborted", "Stopped before the camera was live");
          self.engine = engine;
          doc.addEventListener("visibilitychange", self._onVisibility);
          global.addEventListener("pagehide", self._onPageHide);
          global.addEventListener("pageshow", self._onPageShow);
          self._setState(self._paused ? "paused" : "live");
          if (doc.hidden) self._suspend();
          else self._schedule();
          return self;
        },
        function (err) {
          if (self._stopped) throw scanError("aborted", "Stopped before the camera was live");
          throw self._fatal(err);
        }
      );
  };

  CameraSession.prototype._chooseEngine = function () {
    var want = this.opts.engine || "auto";
    var formats = this._formats;
    var self = this;
    if (want === "zxing") {
      return getWorker().then(
        function () {
          return "zxing";
        },
        function (err) {
          throw scanError("unsupported", "QR decoder unavailable: " + err.message, err);
        }
      );
    }
    return nativeSupported(formats).then(function (ok) {
      if (ok) {
        try {
          self._native = makeNativeDetector(formats);
          // Prewarm the worker too: it is the fallback if native detect() starts failing,
          // and it assists with codes the platform detector misses (inverted labels).
          if (want !== "native") warmup();
          return "native";
        } catch (e) {
          self._native = null;
        }
      }
      if (want === "native") throw scanError("unsupported", "Native BarcodeDetector unavailable");
      return getWorker().then(
        function () {
          return "zxing";
        },
        function (err) {
          throw scanError("unsupported", "No QR decoder available: " + err.message, err);
        }
      );
    });
  };

  function stopTracks(stream) {
    if (!stream) return;
    try {
      stream.getTracks().forEach(function (t) {
        try {
          t.stop();
        } catch (e) {
          /* ignore */
        }
      });
    } catch (e) {
      /* ignore */
    }
  }

  function waitForVideo(video, ms) {
    if (video.videoWidth > 0) return Promise.resolve();
    return new Promise(function (resolve) {
      var done = false;
      function finish() {
        if (done) return;
        done = true;
        clearInterval(poll);
        clearTimeout(t);
        video.removeEventListener("loadedmetadata", finish);
        resolve();
      }
      var poll = setInterval(function () {
        if (video.videoWidth > 0) finish();
      }, 50);
      var t = setTimeout(finish, ms);
      video.addEventListener("loadedmetadata", finish);
    });
  }

  CameraSession.prototype._acquire = function (deviceId) {
    var self = this;
    var video = { width: { ideal: 1280 }, height: { ideal: 720 } };
    if (deviceId) video.deviceId = { exact: deviceId };
    else video.facingMode = { ideal: this._facingMode };
    var gum = function (c) {
      return global.navigator.mediaDevices.getUserMedia({ audio: false, video: c });
    };
    return gum(video)
      .catch(function (err) {
        if (deviceId && err && (err.name === "OverconstrainedError" || err.name === "NotFoundError")) {
          return gum({ width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: { ideal: self._facingMode } });
        }
        throw err;
      })
      .then(function (stream) {
        if (self._stopped || self._suspended) {
          // stop() (or the tab went hidden) while the permission prompt was pending:
          // release the camera the moment it arrives.
          stopTracks(stream);
          throw scanError("aborted", "Stopped before the camera was live");
        }
        self.stream = stream;
        self.track = stream.getVideoTracks()[0] || null;
        if (self.track) self.track.addEventListener("ended", self._onEnded);
        var v = self.video;
        v.muted = true;
        v.setAttribute("muted", "");
        v.setAttribute("playsinline", "");
        v.playsInline = true;
        v.autoplay = true;
        v.srcObject = stream;
        self._applyTransform();
        var play;
        try {
          play = v.play();
        } catch (e) {
          play = null;
        }
        return Promise.resolve(play)
          .catch(function () {
            /* autoplay quirks: muted inline video normally plays; frames are still read */
          })
          .then(function () {
            return waitForVideo(v, 4000);
          });
      })
      .then(function () {
        if (self._stopped) throw scanError("aborted", "Stopped before the camera was live");
        var settings = {};
        try {
          settings = (self.track && self.track.getSettings && self.track.getSettings()) || {};
        } catch (e) {
          settings = {};
        }
        self._deviceId = settings.deviceId || deviceId || self._deviceId;
        self._settings = settings;
        if (self._hwZoom) self.setZoom(self._hwZoom.value);
        return self._refreshCameras();
      });
  };

  CameraSession.prototype._refreshCameras = function () {
    var self = this;
    var md = global.navigator.mediaDevices;
    if (!md || typeof md.enumerateDevices !== "function") return Promise.resolve([]);
    return withTimeout(md.enumerateDevices(), 1500)
      .then(function (list) {
        var cams = [];
        for (var i = 0; i < list.length; i++) {
          if (list[i].kind === "videoinput") cams.push({ deviceId: list[i].deviceId, label: list[i].label || "" });
        }
        self._cameras = cams;
        return cams;
      })
      .catch(function () {
        return self._cameras;
      });
  };

  CameraSession.prototype._releaseCamera = function () {
    var self = this;
    var track = this.track;
    var stream = this.stream;
    var torchWasOn = this._torch;
    this._torch = false;
    var torchOff =
      track && torchWasOn
        ? withTimeout(track.applyConstraints({ advanced: [{ torch: false }] }), 1500).catch(function () {})
        : Promise.resolve();
    return torchOff.then(function () {
      if (track) track.removeEventListener("ended", self._onEnded);
      stopTracks(stream);
      if (self.stream === stream) {
        self.stream = null;
        self.track = null;
      }
      try {
        if (self.video && self.video.srcObject === stream) self.video.srcObject = null;
      } catch (e) {
        /* ignore */
      }
    });
  };

  CameraSession.prototype._schedule = function () {
    if (this._timer || this._stopped || this._paused || this._halted || this._suspended) return;
    this._timer = setTimeout(this._tick, this._interval);
  };

  CameraSession.prototype._onTick = function () {
    this._timer = null;
    if (this._stopped || this._paused || this._halted || this._suspended) return;
    this._schedule();
    var v = this.video;
    if (!v || !this.engine || v.readyState < 2 || !v.videoWidth) return;
    if (this._inFlight) {
      this._stats.skipped++;
      return;
    }
    var frame = this._grabFrame();
    if (!frame) return;
    this._stats.frames++;
    this._inFlight = true;
    var self = this;
    var t0 = now();
    var job = this.engine === "native" ? this._detectNative(frame) : this._detectWorker(frame);
    job.then(
      function (results) {
        self._inFlight = false;
        self._onResults(results, frame, now() - t0);
      },
      function (err) {
        self._inFlight = false;
        self._onDecodeError(err);
      }
    );
  };

  /** Region of the video frame (video px) that is actually visible in the element. */
  CameraSession.prototype._visibleRegion = function () {
    var v = this.video;
    var full = { sx: 0, sy: 0, sw: v.videoWidth, sh: v.videoHeight };
    if (this._region === "full") return full;
    var f = fitParams(v);
    if (!f) return full;
    var a = displayToVideo({ x: 0, y: 0 }, f, this._cssZoom, this._mirror);
    var b = displayToVideo({ x: f.cw, y: f.ch }, f, this._cssZoom, this._mirror);
    var x0 = Math.max(0, Math.min(a.x, b.x));
    var y0 = Math.max(0, Math.min(a.y, b.y));
    var x1 = Math.min(f.vw, Math.max(a.x, b.x));
    var y1 = Math.min(f.vh, Math.max(a.y, b.y));
    if (x1 - x0 < 32 || y1 - y0 < 32) return full;
    return { sx: x0, sy: y0, sw: x1 - x0, sh: y1 - y0 };
  };

  CameraSession.prototype._grabFrame = function () {
    var v = this.video;
    var r = this._visibleRegion();
    var s = Math.min(1, this._maxDim / Math.max(r.sw, r.sh));
    var w = Math.max(1, Math.round(r.sw * s));
    var h = Math.max(1, Math.round(r.sh * s));
    if (this._canvas.width !== w) this._canvas.width = w;
    if (this._canvas.height !== h) this._canvas.height = h;
    try {
      this._ctx.drawImage(v, r.sx, r.sy, r.sw, r.sh, 0, 0, w, h);
    } catch (e) {
      return null;
    }
    return { sx: r.sx, sy: r.sy, sw: r.sw, sh: r.sh, width: w, height: h, scale: r.sw / w };
  };

  CameraSession.prototype._detectWorker = function (frame) {
    var img;
    try {
      img = this._ctx.getImageData(0, 0, frame.width, frame.height);
    } catch (e) {
      return Promise.reject(scanError("decode_failed", "Could not read the camera frame", e));
    }
    var live = this.opts.liveOptions || {};
    return workerCall(
      {
        type: "decode",
        imageData: img,
        options: {
          multi: true,
          maxSymbols: 8,
          formats: this._formats,
          tryHarder: live.tryHarder !== false,
          tryInvert: live.tryInvert !== false,
          tryRotate: !!live.tryRotate, // off for live frames (speed); photos use it
          tryDownscale: live.tryDownscale !== false,
        },
      },
      [img.data.buffer],
      FRAME_TIMEOUT_MS
    ).then(function (m) {
      var out = m.results || [];
      for (var i = 0; i < out.length; i++) out[i].source = "zxing";
      return out;
    });
  };

  CameraSession.prototype._detectNative = function (frame) {
    var self = this;
    var p;
    try {
      p = this._native.detect(this._canvas);
    } catch (e) {
      p = Promise.reject(e);
    }
    return Promise.resolve(p).then(
      function (codes) {
        self._nativeErrors = 0;
        var results = mapNative(codes, 1, 1, 0, 0);
        self._framesSinceAssist++;
        // Assist: platform detectors often miss inverted (white-on-black) codes. When
        // nothing was found for a while, also run this frame through zxing (worker,
        // off the main thread) about once a second.
        if (
          !results.length &&
          W.info &&
          self._framesSinceAssist >= 8 &&
          now() - self._lastHit > 2000 &&
          self.opts.assist !== false
        ) {
          self._framesSinceAssist = 0;
          return self._detectWorker(frame).catch(function () {
            return [];
          });
        }
        return results;
      },
      function (err) {
        self._nativeErrors++;
        if (self._nativeErrors >= 3) {
          // e.g. NotSupportedError when the platform backend is missing: the old code
          // spun silently forever. Fall back to the zxing worker.
          return getWorker().then(
            function () {
              self.engine = "zxing";
              return [];
            },
            function () {
              if (self._nativeErrors >= 20) throw scanError("unsupported", "Barcode detection keeps failing", err);
              return [];
            }
          );
        }
        return [];
      }
    );
  };

  CameraSession.prototype._onDecodeError = function (err) {
    if (this._stopped) return;
    this._workerErrors++;
    if (this._native && this.engine === "zxing") {
      this.engine = "native";
      return;
    }
    if ((err && err.code === "unsupported") || W.dead || this._workerErrors >= 12) {
      this._fatal(scanError("unsupported", "The QR decoder stopped working", err));
    }
    // Otherwise transient (worker restart/timeout): the next tick re-creates the worker.
  };

  CameraSession.prototype._onResults = function (results, frame, ms) {
    if (this._stopped || this._suspended) return;
    this._workerErrors = 0;
    var st = this._stats;
    st.decodes++;
    st.totalMs += ms;
    st.lastMs = ms;
    st.windowDecodes++;
    st.windowMs += ms;
    var t = now();
    if (t - st.windowStart >= 1000 && typeof this.opts.onFrameStats === "function") {
      safeCall(this.opts.onFrameStats, {
        engine: this.engine,
        decodesPerSec: Math.round((st.windowDecodes * 10000) / (t - st.windowStart)) / 10,
        avgMs: st.windowDecodes ? Math.round(st.windowMs / st.windowDecodes) : 0,
        lastMs: Math.round(ms),
        frames: st.frames,
        skipped: st.skipped,
        frameWidth: frame.width,
        frameHeight: frame.height,
      });
      st.windowStart = t;
      st.windowDecodes = 0;
      st.windowMs = 0;
    }
    if (this._paused || this._halted) return;

    var v = this.video;
    var f = fitParams(v);
    var mapped = [];
    for (var i = 0; i < results.length; i++) {
      var r = results[i];
      var frameCorners = [];
      var corners = [];
      for (var j = 0; j < 4; j++) {
        var c = r.corners[j] || { x: 0, y: 0 };
        var vp = { x: frame.sx + c.x * frame.scale, y: frame.sy + c.y * frame.scale };
        frameCorners.push(vp);
        corners.push(f ? videoToDisplay(vp, f, this._cssZoom, this._mirror) : vp);
      }
      mapped.push({
        text: r.text,
        format: r.format || "qr_code",
        source: r.source || this.engine,
        corners: corners,
        box: boxOf(corners),
        frameCorners: frameCorners,
      });
    }
    var meta = {
      engine: this.engine,
      ms: Math.round(ms),
      timestamp: t,
      all: mapped,
      display: {
        width: v.clientWidth,
        height: v.clientHeight,
        offsetLeft: v.offsetLeft,
        offsetTop: v.offsetTop,
      },
      video: { width: v.videoWidth, height: v.videoHeight },
      frame: { width: frame.width, height: frame.height, sx: frame.sx, sy: frame.sy, sw: frame.sw, sh: frame.sh },
    };

    var fresh = [];
    for (var k = 0; k < mapped.length; k++) {
      var m = mapped[k];
      var seen = this._seen[m.text];
      if (!seen || t - seen > this._leaveMs) fresh.push(m);
      this._seen[m.text] = t;
    }
    if (mapped.length) {
      this._lastHit = t;
      this._hadTrack = true;
      safeCall(this.opts.onTrack, mapped, meta);
    } else if (this._hadTrack) {
      this._hadTrack = false;
      safeCall(this.opts.onTrack, [], meta);
    }
    if (fresh.length) {
      if (!this._continuous) {
        this._halted = true;
        this._setState("paused");
      }
      safeCall(this.opts.onDetect, fresh, meta);
    }
  };

  CameraSession.prototype._trackEnded = function () {
    if (this._stopped || this._suspended || this._swapping) return;
    var self = this;
    this._queue(function () {
      if (self._stopped || self._suspended) return undefined;
      return self._releaseCamera().then(function () {
        return new Promise(function (r) {
          setTimeout(r, 300);
        }).then(function () {
          if (self._stopped || self._suspended) return undefined;
          return self._acquire(self._deviceId).then(
            function () {
              self._schedule();
            },
            function (err) {
              if (!self._stopped && !(err && err.code === "aborted")) self._fatal(err);
            }
          );
        });
      });
    });
  };

  CameraSession.prototype._suspend = function () {
    if (this._stopped || this._suspended) return;
    this._suspended = true;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    this._setState("suspended");
    var self = this;
    this._queue(function () {
      return self._releaseCamera();
    });
  };

  CameraSession.prototype._wake = function () {
    if (this._stopped || !this._suspended) return;
    this._suspended = false;
    this._setState("starting");
    var self = this;
    this._queue(function () {
      if (self._stopped || self._suspended) return undefined;
      return self._acquire(self._deviceId).then(
        function () {
          if (self._stopped) return;
          self._rearm();
          self._setState(self._paused || self._halted ? "paused" : "live");
          self._schedule();
        },
        function (err) {
          if (self._stopped || self._suspended || (err && err.code === "aborted")) return;
          self._fatal(err);
        }
      );
    });
  };

  /** Codes currently remembered count as "just seen", so they must leave the frame first. */
  CameraSession.prototype._rearm = function () {
    var t = now();
    for (var k in this._seen) if (Object.prototype.hasOwnProperty.call(this._seen, k)) this._seen[k] = t;
  };

  CameraSession.prototype.stop = function () {
    if (this._stopPromise) return this._stopPromise;
    this._stopped = true;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    doc.removeEventListener("visibilitychange", this._onVisibility);
    global.removeEventListener("pagehide", this._onPageHide);
    global.removeEventListener("pageshow", this._onPageShow);
    var idx = sessions.indexOf(this);
    if (idx >= 0) sessions.splice(idx, 1);
    this._setState("stopped");
    var self = this;
    // Not queued behind other camera operations: torch-off + stop must happen now.
    this._stopPromise = this._releaseCamera().then(function () {
      try {
        if (self.video) {
          self.video.style.transform = self._origTransform;
          self.video.style.transformOrigin = self._origOrigin;
        }
      } catch (e) {
        /* ignore */
      }
    });
    // Anything acquired later by an in-flight getUserMedia is stopped in _acquire.
    return this._stopPromise;
  };

  CameraSession.prototype.pause = function () {
    if (this._stopped) return;
    this._paused = true;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    if (!this._suspended) this._setState("paused");
  };

  CameraSession.prototype.resume = function (o) {
    if (this._stopped) return;
    this._paused = false;
    this._halted = false;
    if (o && o.reset) this._seen = {};
    else this._rearm();
    if (!this._suspended) {
      this._setState("live");
      this._schedule();
    }
  };

  CameraSession.prototype._caps = function () {
    try {
      return (this.track && this.track.getCapabilities && this.track.getCapabilities()) || {};
    } catch (e) {
      return {};
    }
  };

  CameraSession.prototype.capabilities = function () {
    var caps = this._caps();
    var z = caps.zoom;
    var hw = z && typeof z.max === "number" && typeof z.min === "number" && z.max > z.min;
    var focusModes = caps.focusMode || [];
    var settings = {};
    try {
      settings = (this.track && this.track.getSettings && this.track.getSettings()) || {};
    } catch (e) {
      settings = {};
    }
    return {
      torch: !!caps.torch,
      zoom: hw
        ? { min: z.min, max: z.max, step: z.step || 0.1, value: typeof settings.zoom === "number" ? settings.zoom : z.min }
        : null,
      cssZoom: { min: 1, max: 4, step: 0.1, value: this._cssZoom },
      focus: focusModes.indexOf("single-shot") >= 0 || (!!caps.pointsOfInterest && focusModes.length > 0),
      cameras: this._cameras.slice(),
      deviceId: settings.deviceId || this._deviceId || null,
      facingMode: settings.facingMode || null,
    };
  };

  CameraSession.prototype.setTorch = function (on) {
    var track = this.track;
    if (!track || this._stopped) return Promise.resolve(false);
    var self = this;
    return track.applyConstraints({ advanced: [{ torch: !!on }] }).then(
      function () {
        self._torch = !!on;
        return true;
      },
      function () {
        return false;
      }
    );
  };

  CameraSession.prototype._applyTransform = function () {
    var v = this.video;
    if (!v) return;
    var parts = [];
    if (this._cssZoom !== 1) parts.push("scale(" + this._cssZoom + ")");
    if (this._mirror) parts.push("scaleX(-1)");
    v.style.transformOrigin = parts.length ? "50% 50%" : this._origOrigin;
    v.style.transform = parts.length ? parts.join(" ") : this._origTransform;
  };

  CameraSession.prototype.setZoom = function (value) {
    var self = this;
    var caps = this._caps();
    var z = caps.zoom;
    function css() {
      var c = Math.min(4, Math.max(1, Number(value) || 1));
      self._cssZoom = c;
      self._hwZoom = null;
      self._applyTransform();
      return { mode: "css", value: c };
    }
    if (this.track && z && typeof z.max === "number" && z.max > z.min) {
      var hv = Math.min(z.max, Math.max(z.min, Number(value) || z.min));
      return this.track.applyConstraints({ advanced: [{ zoom: hv }] }).then(
        function () {
          self._hwZoom = { value: hv };
          if (self._cssZoom !== 1) {
            self._cssZoom = 1;
            self._applyTransform();
          }
          return { mode: "hardware", value: hv };
        },
        function () {
          return css();
        }
      );
    }
    return Promise.resolve(css());
  };

  CameraSession.prototype.focusAt = function (xNorm, yNorm) {
    var track = this.track;
    if (!track) return Promise.resolve(false);
    var caps = this._caps();
    var modes = caps.focusMode || [];
    var f = fitParams(this.video);
    var x = xNorm;
    var y = yNorm;
    if (f) {
      var p = displayToVideo({ x: xNorm * f.cw, y: yNorm * f.ch }, f, this._cssZoom, this._mirror);
      x = Math.min(1, Math.max(0, p.x / f.vw));
      y = Math.min(1, Math.max(0, p.y / f.vh));
    }
    var c = null;
    if (modes.indexOf("single-shot") >= 0) c = { focusMode: "single-shot", pointsOfInterest: [{ x: x, y: y }] };
    else if (caps.pointsOfInterest) c = { pointsOfInterest: [{ x: x, y: y }] };
    if (!c) return Promise.resolve(false);
    return track.applyConstraints({ advanced: [c] }).then(
      function () {
        return true;
      },
      function () {
        return false;
      }
    );
  };

  CameraSession.prototype.useCamera = function (deviceId) {
    var self = this;
    if (this._stopped) return Promise.reject(scanError("aborted", "Session stopped"));
    return this._queue(function () {
      var previous = self._deviceId;
      self._swapping = true;
      return self
        ._releaseCamera() // torch off first, and many phones cannot open two cameras
        .then(function () {
          return self._acquire(deviceId);
        })
        .catch(function (err) {
          if (self._stopped || (err && err.code === "aborted")) throw err;
          return self._acquire(previous).then(function () {
            throw mapCameraError(err);
          });
        })
        .then(
          function () {
            self._swapping = false;
            self._rearm();
            self._schedule();
            var cur = self._deviceId;
            for (var i = 0; i < self._cameras.length; i++) if (self._cameras[i].deviceId === cur) return self._cameras[i];
            return { deviceId: cur, label: "" };
          },
          function (err) {
            self._swapping = false;
            throw err;
          }
        );
    });
  };

  CameraSession.prototype.switchCamera = function () {
    var self = this;
    return this._refreshCameras().then(function (cams) {
      if (!cams || cams.length < 2) return null;
      var idx = -1;
      for (var i = 0; i < cams.length; i++) if (cams[i].deviceId === self._deviceId) idx = i;
      return self.useCamera(cams[(idx + 1) % cams.length].deviceId);
    });
  };

  CameraSession.prototype.lastFrameCanvas = function () {
    var src = this._canvas;
    if (!src.width || !src.height) {
      var v = this.video;
      if (!v || !v.videoWidth) return null;
      src = doc.createElement("canvas");
      src.width = v.videoWidth;
      src.height = v.videoHeight;
      try {
        src.getContext("2d").drawImage(v, 0, 0);
      } catch (e) {
        return null;
      }
      return src;
    }
    var c = doc.createElement("canvas");
    c.width = src.width;
    c.height = src.height;
    c.getContext("2d").drawImage(src, 0, 0);
    return c;
  };

  function createCameraSession(opts) {
    var s = new CameraSession(opts || {});
    sessions.push(s);
    var p = s._start();
    p.catch(function () {});
    p.session = s;
    return p;
  }

  function stopAll() {
    var list = sessions.slice();
    return Promise.all(
      list.map(function (s) {
        return s.stop();
      })
    );
  }

  /* -------------------------------------------------------- still images -- */

  function isBlob(x) {
    return typeof Blob !== "undefined" && x instanceof Blob;
  }

  function isImageData(x) {
    return typeof ImageData !== "undefined" && x instanceof ImageData;
  }

  /** Main-thread image decode (fallback): createImageBitmap, then <img>. */
  function blobToBitmap(blob) {
    var viaImg = function () {
      return new Promise(function (resolve, reject) {
        var url = URL.createObjectURL(blob);
        var img = new Image();
        img.onload = function () {
          URL.revokeObjectURL(url);
          resolve(img);
        };
        img.onerror = function () {
          URL.revokeObjectURL(url);
          reject(scanError("unsupported_image", "This image format cannot be decoded here (HEIC?)"));
        };
        img.src = url;
      });
    };
    if (typeof createImageBitmap !== "function") return viaImg();
    return createImageBitmap(blob).catch(viaImg);
  }

  function sourceSize(src) {
    return {
      w: src.naturalWidth || src.videoWidth || src.width || 0,
      h: src.naturalHeight || src.videoHeight || src.height || 0,
    };
  }

  /** Draw any drawable to a canvas capped at maxDim; returns {imageData, scale, canvas}. */
  function drawableToImageData(src, maxDim) {
    var sz = sourceSize(src);
    if (!sz.w || !sz.h) throw scanError("unsupported_image", "Empty image");
    var s = Math.min(1, maxDim / Math.max(sz.w, sz.h));
    var w = Math.max(1, Math.round(sz.w * s));
    var h = Math.max(1, Math.round(sz.h * s));
    var c = doc.createElement("canvas");
    c.width = w;
    c.height = h;
    var ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(src, 0, 0, w, h);
    return { imageData: ctx.getImageData(0, 0, w, h), scale: sz.w / w, canvas: c, width: sz.w, height: sz.h };
  }

  function decodeWithWorker(input, options) {
    var offscreen = !!(W.info && W.info.offscreen);
    function sendImageData(prep) {
      return workerCall(
        { type: "scanImage", imageData: prep.imageData, scale: prep.scale, options: options },
        [prep.imageData.data.buffer],
        IMAGE_TIMEOUT_MS
      );
    }
    function viaMainThread(drawable) {
      return sendImageData(drawableToImageData(drawable, MAX_MAIN_THREAD_DIM));
    }
    if (isImageData(input)) {
      var copy = new ImageData(new Uint8ClampedArray(input.data), input.width, input.height);
      return sendImageData({ imageData: copy, scale: 1 });
    }
    if (isBlob(input)) {
      var mainThread = function () {
        return blobToBitmap(input).then(function (bmp) {
          try {
            return viaMainThread(bmp);
          } finally {
            if (bmp.close) bmp.close();
          }
        });
      };
      if (!offscreen) return mainThread();
      // The worker decodes the file itself: no pixel work on the main thread.
      return workerCall({ type: "scanImage", blob: input, options: options }, [], IMAGE_TIMEOUT_MS).catch(function (err) {
        if (err && (err.code === "unsupported_image" || err.code === "need_imagedata")) return mainThread();
        throw err;
      });
    }
    // Canvas / <img> / <video> / ImageBitmap
    if (offscreen && typeof createImageBitmap === "function") {
      return createImageBitmap(input).then(
        function (bmp) {
          return workerCall({ type: "scanImage", bitmap: bmp, options: options }, [bmp], IMAGE_TIMEOUT_MS);
        },
        function () {
          return viaMainThread(input);
        }
      );
    }
    return Promise.resolve().then(function () {
      return viaMainThread(input);
    });
  }

  /** v2.0.5 greycast fix, main-thread version for the native-detector path. */
  function greycastCanvas(src, invert) {
    var prep = drawableToImageData(src, 1800);
    var d = prep.imageData.data;
    var min = 255;
    var max = 0;
    var luma = new Uint8ClampedArray(d.length / 4);
    for (var i = 0, j = 0; i < d.length; i += 4, j++) {
      var l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      luma[j] = l;
      if (l < min) min = l;
      if (l > max) max = l;
    }
    var range = max - min || 1;
    for (var k = 0, m = 0; k < d.length; k += 4, m++) {
      var v = Math.round(((luma[m] - min) / range) * 255);
      if (invert) v = 255 - v;
      d[k] = d[k + 1] = d[k + 2] = v;
    }
    prep.canvas.getContext("2d").putImageData(prep.imageData, 0, 0);
    return prep;
  }

  function decodeWithNative(input, options) {
    return nativeSupported(options.formats).then(function (ok) {
      if (!ok) return null;
      var det = makeNativeDetector(options.formats);
      var srcP;
      if (isBlob(input)) srcP = blobToBitmap(input);
      else if (isImageData(input)) {
        var c = doc.createElement("canvas");
        c.width = input.width;
        c.height = input.height;
        c.getContext("2d").putImageData(input, 0, 0);
        srcP = Promise.resolve(c);
      } else srcP = Promise.resolve(input);
      return srcP.then(function (src) {
        var sz = sourceSize(src);
        var names = [];
        var attempts = [
          function () {
            names.push("native");
            return det.detect(src).then(function (codes) {
              return mapNative(codes, 1, 1, 0, 0);
            });
          },
          function () {
            names.push("native-greycast");
            var g = greycastCanvas(src, false);
            return det.detect(g.canvas).then(function (codes) {
              return mapNative(codes, g.scale, g.scale, 0, 0);
            });
          },
          function () {
            names.push("native-inverted");
            var g = greycastCanvas(src, true);
            return det.detect(g.canvas).then(function (codes) {
              return mapNative(codes, g.scale, g.scale, 0, 0);
            });
          },
        ];
        var i = 0;
        function next() {
          if (i >= attempts.length) return Promise.resolve([]);
          return attempts[i++]()
            .catch(function () {
              return [];
            })
            .then(function (res) {
              return res.length ? res : next();
            });
        }
        return next().then(function (results) {
          return { results: results, passes: i, passNames: names, width: sz.w, height: sz.h };
        });
      });
    });
  }

  function decodeImage(input, opts) {
    opts = opts || {};
    var t0 = now();
    var options = {
      multi: opts.multi !== false,
      formats: opts.formats && opts.formats.length ? opts.formats : ["qr_code"],
      exhaustive: !!opts.exhaustive,
    };
    if (!input) return Promise.reject(scanError("unsupported_image", "No image given"));
    var e = env();
    var passes = 0;
    var passNames = [];
    var width = 0;
    var height = 0;
    var engine = null;

    var workerStep =
      e.hasWorker && e.hasWasm && !W.dead
        ? getWorker().then(
            function () {
              return decodeWithWorker(input, options).then(
                function (m) {
                  passes += m.passes || 0;
                  passNames = passNames.concat(m.passNames || []);
                  width = m.width;
                  height = m.height;
                  engine = "zxing";
                  var list = m.results || [];
                  for (var i = 0; i < list.length; i++) list[i].source = "zxing";
                  return list;
                },
                function (err) {
                  // An undecodable file stays an error; a crashed/timed-out worker
                  // falls through to the native detector when there is one.
                  if (err && err.code === "unsupported_image") throw err;
                  return null;
                }
              );
            },
            function () {
              return null; // worker unavailable: native fallback below
            }
          )
        : Promise.resolve(null);

    return workerStep
      .then(function (results) {
        if (results && results.length) return results;
        if (!e.hasNativeDetector) {
          if (results === null) throw scanError("unsupported", "No QR decoder available in this browser");
          return results;
        }
        return decodeWithNative(input, options).then(
          function (r) {
            if (!r) {
              if (results === null) throw scanError("unsupported", "No QR decoder available in this browser");
              return results || [];
            }
            passes += r.passes;
            passNames = passNames.concat(r.passNames);
            if (!width) {
              width = r.width;
              height = r.height;
            }
            if (r.results.length) engine = "native";
            return r.results;
          },
          function (err) {
            if (results === null) {
              throw err && err.name === "ScanEngineError" ? err : scanError("unsupported_image", "Could not read the image", err);
            }
            return results || [];
          }
        );
      })
      .then(function (results) {
        if (!results || !results.length) {
          var nf = scanError("not_found", "No QR code found in image");
          nf.passes = passes;
          nf.passNames = passNames;
          throw nf;
        }
        var seen = {};
        var out = [];
        for (var i = 0; i < results.length; i++) {
          var r = results[i];
          if (seen[r.text]) continue;
          seen[r.text] = true;
          out.push({
            text: r.text,
            format: r.format || "qr_code",
            source: r.source || engine,
            corners: r.corners,
            box: boxOf(r.corners),
            pass: r.pass || null,
          });
        }
        if (!options.multi) out = out.slice(0, 1);
        return {
          results: out,
          passes: passes,
          passNames: passNames,
          width: width,
          height: height,
          ms: Math.round(now() - t0),
          engine: engine,
        };
      });
  }

  /* ------------------------------------------------------------- misc -- */

  function vibrate(pattern) {
    try {
      var n = global.navigator;
      if (n && typeof n.vibrate === "function") return !!n.vibrate(pattern == null ? 30 : pattern);
    } catch (e) {
      /* no user activation, cross-origin iframe, ... */
    }
    return false;
  }

  function haptic(kind) {
    var k = HAPTIC_PATTERNS[kind] ? kind : "success";
    try {
      var b = global.AntiMatterHaBridge;
      if (b && typeof b.haptic === "function" && b.haptic(k)) return "bridge";
    } catch (e) {
      /* ignore */
    }
    return vibrate(HAPTIC_PATTERNS[k]) ? "vibrate" : false;
  }

  function parseText(text) {
    var S = global.AntiMatterScan;
    return S && typeof S.parseScannedText === "function" ? S.parseScannedText(text) : null;
  }

  function parseTextAll(text) {
    var S = global.AntiMatterScan;
    if (S && typeof S.parseScannedTextAll === "function") return S.parseScannedTextAll(text);
    var one = parseText(text);
    return one ? [one] : [];
  }

  global.AntiMatterScanEngine = {
    version: VERSION,
    env: env,
    warmup: warmup,
    createCameraSession: createCameraSession,
    stopAll: stopAll,
    decodeImage: decodeImage,
    parseText: parseText,
    parseTextAll: parseTextAll,
    vibrate: vibrate,
    haptic: haptic,
    workerUrl: WORKER_URL,
  };
})(typeof window !== "undefined" ? window : globalThis);
