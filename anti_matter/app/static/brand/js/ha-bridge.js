/**
 * Home Assistant Companion App bridge: native barcode scanner, haptics, navigation.
 * Global: window.AntiMatterHaBridge. Classic script, no dependencies. Zero effect
 * outside the Companion App: every entry point is feature-detected and wrapped in
 * try/catch, and a normal browser just gets available() === false.
 *
 * How it works (undocumented HA frontend internals, see scanner research section 8):
 * - The add-on runs in HA's same-origin, unsandboxed ingress <iframe>. We walk up the
 *   same-origin ancestors to the HA frontend window and await its `hassConnection`;
 *   inside the Companion App `auth.external` is HA's ExternalMessaging instance and
 *   `auth.external.config.hasBarCodeScanner` says whether the native scanner exists.
 * - Requests go out through HA's own `ext.fireMessage()` (a parent-realm function, so
 *   the Android bridge sees them coming from the main frame, as it requires).
 * - Replies (`bar_code/scan_result`, `bar_code/aborted`) arrive in the TOP window via
 *   its global `externalBus(msg)`. We never call `addCommandHandler` (it REPLACES HA's
 *   single handler). Instead we wrap `externalBus` with a function created IN THE
 *   PARENT REALM (`new host.Function`) that forwards only our own request ids to this
 *   iframe via postMessage and ALWAYS passes every message on to HA's original
 *   handler, so HA still handles and ACKs everything. The original is restored when our
 *   scan ends, on pagehide (fires before unload, also when the iframe is removed; no
 *   unload listener so the page stays bfcache-friendly), and after a safety timeout; if something else
 *   wrapped externalBus after us, our wrapper just turns into a pass-through.
 *
 * API
 *   ready() -> Promise<boolean>   detection finished (starts at load); true = scanner
 *   available() -> boolean        native scanner usable now (sync; false until ready)
 *   isCompanion() -> boolean      running inside the Companion App (haptics work)
 *   scan({title, description, alternativeOptionLabel?, formats=["qr_code"],
 *         wrongFormatMessage?, timeoutMs=300000}) -> Promise<{text, format}>
 *       rejects err.code: "unavailable" | "aborted" (user cancelled) | "alternative"
 *       (user tapped the alternative option) | "timeout" | "replaced" | "closed"
 *   scanMany({title, description, alternativeOptionLabel?, formats, wrongFormatMessage?,
 *             idleTimeoutMs=300000,
 *             onResult(text, format) -> {keepOpen:boolean, notify?:string, notifyHint?:string}
 *                                       | Promise})
 *       -> Promise<{count, reason: "closed"|"aborted"|"alternative"|"timeout"|"replaced"}>
 *       Batch: the scanner stays open while onResult returns keepOpen:true (Android keeps
 *       it open until bar_code/close; iOS also keeps scanning; both handled). The same
 *       text is dropped until it has been out of view for 2.5 s (each repeat restarts
 *       that window). notify says what happened to the code, on the scanner screen:
 *       - iOS app: the scanner is reopened with notify as its heading and notifyHint (or
 *         the original description) under it. Nothing else the iOS app offers is seen
 *         while its full-screen scanner is open: bar_code/notify has been drawn on the
 *         page BEHIND the scanner since app 2026.4 (seen only after closing it), and the
 *         app's toast/show appears only once the scanner is gone.
 *       - Android app: bar_code/notify, a dialog over its scanner.
 *   close()                       end the current scan (sends bar_code/close)
 *   notify(message) -> boolean    bar_code/notify while a scan is open (see above for iOS)
 *   haptic(kind) -> boolean       native haptic ("success", "warning", "failure", "light",
 *                                 "medium", "heavy", "selection"); false outside the app
 *   navigateToDevice(deviceId) -> boolean   open /config/devices/device/<id> in the HA
 *                                 frontend (not inside the iframe); false if unsupported
 */
(function (global) {
  "use strict";

  if (global.AntiMatterHaBridge && global.AntiMatterHaBridge.scan) return; // loaded twice

  var HAPTICS = ["success", "warning", "failure", "light", "medium", "heavy", "selection"];
  var DETECT_TIMEOUT_MS = 5000;
  var DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
  var REPEAT_MS = 2500;
  // A reopened iOS scanner restarts its camera and reports a code still in view at once:
  // the repeat window is stretched by this much so that sighting is not a new scan.
  var REOPEN_MS = 2000;

  var S = { detect: null, haWin: null, host: null, ext: null, active: null };

  function bridgeError(code, message) {
    var e = new Error(message || code);
    e.name = "HaBridgeError";
    e.code = code;
    return e;
  }

  function sameOriginAncestors() {
    var out = [];
    var w = global;
    for (var i = 0; i < 8; i++) {
      var p;
      try {
        p = w.parent;
      } catch (e) {
        break;
      }
      if (!p || p === w) break;
      try {
        void p.document; // throws when cross-origin
        void p.location.href;
      } catch (e) {
        break;
      }
      out.push(p);
      w = p;
    }
    return out;
  }

  function timeout(ms) {
    return new Promise(function (_, reject) {
      setTimeout(function () {
        reject(bridgeError("timeout", "hassConnection timeout"));
      }, ms);
    });
  }

  function detect() {
    if (S.detect) return S.detect;
    S.detect = (function () {
      var list = sameOriginAncestors();
      var chain = Promise.resolve(false);
      list.forEach(function (w) {
        chain = chain.then(function (found) {
          if (found || S.haWin) return found;
          var hc;
          try {
            hc = w.hassConnection;
          } catch (e) {
            return false;
          }
          if (!hc || typeof hc.then !== "function") return false;
          S.haWin = w;
          return Promise.race([Promise.resolve(hc), timeout(DETECT_TIMEOUT_MS)]).then(
            function (conn) {
              var ext = conn && conn.auth && conn.auth.external;
              if (ext && typeof ext.fireMessage === "function") {
                S.host = w;
                S.ext = ext;
                return true;
              }
              return false;
            },
            function () {
              return false;
            }
          );
        });
      });
      return chain.then(
        function () {
          return available();
        },
        function () {
          return false;
        }
      );
    })();
    return S.detect;
  }

  function isCompanion() {
    try {
      return !!(S.ext && S.host && !S.host.closed);
    } catch (e) {
      return false;
    }
  }

  function available() {
    try {
      if (!isCompanion()) return false;
      if (typeof S.host.externalBus !== "function") return false;
      var cfg = S.ext.config || {};
      return !!cfg.hasBarCodeScanner;
    } catch (e) {
      return false;
    }
  }

  /** Clone a message into the HA (parent) realm before handing it to HA. */
  function hostMsg(obj) {
    return S.host.JSON.parse(JSON.stringify(obj));
  }

  function fire(obj) {
    try {
      var m = hostMsg(obj);
      S.ext.fireMessage(m);
      return m;
    } catch (e) {
      return null;
    }
  }

  function randomNonce() {
    try {
      var a = new Uint32Array(4);
      global.crypto.getRandomValues(a);
      return Array.prototype.join.call(a, "-");
    } catch (e) {
      return String(Math.random()).slice(2) + String(Date.now());
    }
  }

  /**
   * Wrap host.externalBus with a host-realm pass-through that forwards our replies.
   * Returns {state, restore} or throws (e.g. a CSP forbids Function in the host).
   */
  function installTap(host) {
    var orig = host.externalBus;
    if (typeof orig !== "function") throw bridgeError("unavailable", "externalBus missing");
    var state = host.JSON.parse(
      JSON.stringify({ ids: [], nonce: randomNonce(), origin: global.location.origin, active: true })
    );
    var make = new host.Function(
      "orig",
      "target",
      "st",
      "var tap = function antimatterBarcodeTap(msg) {" +
        "  try {" +
        "    if (st.active && msg && msg.type === 'command' &&" +
        "        (msg.command === 'bar_code/scan_result' || msg.command === 'bar_code/aborted') &&" +
        "        st.ids.indexOf(msg.id) !== -1) {" +
        "      target.postMessage({ antimatterBarcode: JSON.parse(JSON.stringify(msg)), nonce: st.nonce }, st.origin);" +
        "    }" +
        "  } catch (e) {}" +
        "  return orig.apply(this, arguments);" +
        "};" +
        "return tap;"
    );
    var tap = make(orig, global, state);
    host.externalBus = tap;
    function restore() {
      state.active = false; // a tap we cannot unhook stays a pure pass-through
      try {
        if (host.externalBus === tap) host.externalBus = orig;
      } catch (e) {
        /* host gone */
      }
    }
    return { state: state, restore: restore, tap: tap, orig: orig };
  }

  function sendClose() {
    if (isCompanion()) fire({ type: "bar_code/close" });
  }

  /**
   * The iOS / iPadOS / Mac app, from its user agent: "... Home Assistant/2026.10.3
   * (io.robbie.HomeAssistant; build:2026.3322; iOS 26.1.0) Mobile/HomeAssistant ...".
   * Android ("Home Assistant/2026.10.1-full (Android 15; ...)") and anything unrecognised
   * are not.
   */
  function isIosApp() {
    try {
      if (!isCompanion()) return false;
      var ua = String((global.navigator && global.navigator.userAgent) || "");
      return /\(io\.robbie\.HomeAssistant/.test(ua) || /Home Assistant\/[^(]*\([^)]*;\s*(iOS|iPadOS|macOS) \d/.test(ua);
    } catch (e) {
      return false;
    }
  }

  /**
   * One native scanner session. many=false: first accepted result resolves.
   * many=true: results go to opts.onResult until it says keepOpen:false.
   */
  function startSession(opts, many) {
    opts = opts || {};
    return detect().then(function () {
      if (!available()) throw bridgeError("unavailable", "Native barcode scanner not available");
      if (S.active) S.active.finish("replaced", true);
      return new Promise(function (resolve, reject) {
        var host = S.host;
        var tap;
        try {
          tap = installTap(host);
        } catch (e) {
          reject(bridgeError("unavailable", "Could not attach to the app bridge: " + (e && e.message)));
          return;
        }
        var formats = opts.formats === null ? null : opts.formats || ["qr_code"];
        var count = 0;
        var lastText = "";
        var lastAt = 0;
        var busy = false;
        var ended = false;
        var timer = null;
        var session;

        function armTimer() {
          clearTimeout(timer);
          var ms = many ? opts.idleTimeoutMs || DEFAULT_TIMEOUT_MS : opts.timeoutMs || DEFAULT_TIMEOUT_MS;
          timer = setTimeout(function () {
            session.finish("timeout", true);
          }, ms);
        }

        function cleanup() {
          clearTimeout(timer);
          global.removeEventListener("message", onMessage);
          global.removeEventListener("pagehide", onPageHide);
          tap.restore();
          if (S.active === session) S.active = null;
        }

        session = {
          // reason: closed | aborted | alternative | timeout | replaced ; close: send bar_code/close
          finish: function (reason, close) {
            if (ended) return;
            ended = true;
            cleanup();
            if (close) sendClose();
            if (many) resolve({ count: count, reason: reason });
            else if (reason === "result") resolve(session.result);
            else reject(bridgeError(reason, "Native scan ended: " + reason));
          },
          result: null,
        };

        function onPageHide() {
          // Our page is going away: unhook first, then dismiss the native scanner so it is
          // not left open with nobody listening.
          session.finish("closed", true);
        }

        function onMessage(ev) {
          var d = ev.data;
          if (ended || ev.source !== host || !d || !d.antimatterBarcode || d.nonce !== tap.state.nonce) return;
          var msg = d.antimatterBarcode;
          var payload = msg.payload || {};
          if (msg.command === "bar_code/aborted") {
            // The native side already dismissed its scanner.
            session.finish(payload.reason === "alternative_options" ? "alternative" : "aborted", false);
            return;
          }
          var text = String(payload.rawValue == null ? "" : payload.rawValue);
          var format = String(payload.format || "");
          if (!text) return;
          if (formats && formats.indexOf(format) < 0) {
            if (opts.wrongFormatMessage) notify(opts.wrongFormatMessage);
            return; // keep scanning
          }
          if (!many) {
            session.result = { text: text, format: format };
            session.finish("result", true);
            return;
          }
          // The iOS app re-sends a code every 1.5 s for as long as it stays in view, so the
          // repeat window SLIDES: every sighting of the same text (also while it is still
          // being saved) pushes it on. Measured from the first sighting instead, a held code
          // came back every 3 s and was then reported as "Already in your vault".
          var t = Date.now();
          if (text === lastText) {
            var held = t - lastAt < REPEAT_MS;
            lastAt = Math.max(lastAt, t); // lastAt is ahead of now just after a reopen
            if (held || busy) return;
          } else {
            if (busy) return; // another code while one is saving: it is re-sent shortly
            lastText = text;
            lastAt = t;
          }
          busy = true;
          count++;
          armTimer();
          var out;
          try {
            out = typeof opts.onResult === "function" ? opts.onResult(text, format) : { keepOpen: true };
          } catch (e) {
            out = { keepOpen: true };
          }
          Promise.resolve(out).then(
            function (r) {
              busy = false;
              if (ended) return;
              var stay = !!r && r.keepOpen !== false;
              if (r && r.notify) {
                if (!isIosApp()) notify(String(r.notify));
                else if (stay) reopen(String(r.notify), r.notifyHint);
                // (iOS and closing: the add-on's own screen shows the outcome)
              }
              if (!stay) session.finish("closed", true);
            },
            function () {
              busy = false;
            }
          );
        }

        /** Open the app scanner (again) with this heading; false if the app refused. */
        function openScanner(title, description) {
          var p = { title: String(title || "Scan QR code"), description: String(description || "") };
          if (opts.alternativeOptionLabel) p.alternative_option_label = String(opts.alternativeOptionLabel);
          // HA assigns msg.id inside fireMessage (on the host-realm copy); register it
          // before returning to the event loop, so no reply can arrive first.
          var sent = fire({ type: "bar_code/scan", payload: p });
          if (!sent || typeof sent.id !== "number") return false;
          tap.state.ids.push(sent.id); // earlier ids stay: a late reply to them still counts
          session.id = sent.id;
          return true;
        }

        /**
         * iOS: put the outcome on the scanner screen itself. Asked to scan while its scanner
         * is open, the app swaps in a new one (no "aborted" for the old one) showing the new
         * heading; its camera restarts, so the repeat window is stretched over that.
         */
        function reopen(title, hint) {
          if (openScanner(title, hint == null ? opts.description : hint)) {
            lastAt = Math.max(lastAt, Date.now() + REOPEN_MS);
          }
        }

        global.addEventListener("message", onMessage);
        global.addEventListener("pagehide", onPageHide);
        S.active = session;

        if (!openScanner(opts.title, opts.description)) {
          session.finish("unavailable", false);
          return;
        }
        armTimer();
      });
    });
  }

  function scan(opts) {
    return startSession(opts, false);
  }

  function scanMany(opts) {
    return startSession(opts, true);
  }

  function close() {
    if (S.active) S.active.finish("closed", true);
    else if (available()) sendClose();
  }

  function notify(message) {
    if (!isCompanion() || !message) return false;
    return !!fire({ type: "bar_code/notify", payload: { message: String(message) } });
  }

  function haptic(kind) {
    if (!isCompanion()) return false;
    var k = HAPTICS.indexOf(kind) >= 0 ? kind : "success";
    return !!fire({ type: "haptic", payload: { hapticType: k } });
  }

  /**
   * Navigate the HA frontend (not the ingress iframe) to a path.
   * - Current HA (ha-panel-app hosts the iframe): the sanctioned iframe->panel message
   *   {type:"home-assistant/navigate", path}.
   * - Older HA (hassio-ingress-view): what its navigate() did - pushState on the main
   *   window + a "location-changed" event.
   */
  function navigatePath(p) {
    try {
      if (global.parent === global) return false;
      var fe = global.frameElement; // null when cross-origin
      if (!fe) return false;
      var root = fe.getRootNode ? fe.getRootNode() : null;
      var tag = root && root.host && root.host.tagName ? root.host.tagName.toLowerCase() : "";
      if (tag === "ha-panel-app") {
        global.parent.postMessage({ type: "home-assistant/navigate", path: p }, global.location.origin);
        return true;
      }
      if (tag === "hassio-ingress-view") {
        var top = S.haWin || global.top;
        if (!top || !top.hassConnection) return false;
        top.history.pushState(null, "", p);
        top.dispatchEvent(new top.CustomEvent("location-changed", { detail: { replace: false } }));
        return true;
      }
    } catch (e) {
      /* fall through */
    }
    return false;
  }

  function navigateToDevice(deviceId) {
    var id = String(deviceId == null ? "" : deviceId).trim();
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) return false;
    return navigatePath("/config/devices/device/" + encodeURIComponent(id));
  }

  global.AntiMatterHaBridge = {
    ready: detect,
    available: available,
    isCompanion: isCompanion,
    scan: scan,
    scanMany: scanMany,
    close: close,
    notify: notify,
    haptic: haptic,
    navigateToDevice: navigateToDevice,
    isScanning: function () {
      return !!S.active;
    },
  };

  try {
    detect();
  } catch (e) {
    /* never break the page */
  }
})(typeof window !== "undefined" ? window : globalThis);
