/**
 * Scanned-text classification and duplicate detection (Anti-Matter vault).
 * Global: window.AntiMatterScan. Needs homekit-payload.js, zwave-payload.js and
 * matter-setup-payload.js loaded first (looked up at call time).
 *
 * parseScannedText(text) -> null (empty input) | {
 *   code_type: "matter"|"homekit"|"zwave"|"other",
 *   manual_code, qr_payload,            what to put in the form / POST body
 *   recognized: boolean,                false -> UI shows "Unknown code - save as Other?"
 *   reason?: string,                    why not recognized (see below)
 *   confidence?: "high"|"low",          low = bare 8 digits taken as a HomeKit code
 *   suggested_type?: string,            protocol a failed payload looked like
 *   setup_id?, homekit_category?, homekit_flag?     (HomeKit from an X-HM:// URI)
 *   zwave_pin?, zwave_meta?             (Z-Wave)
 *   custom_standard?: "Tuya"|"Zigbee",  (other)
 *   zigbee_ieee?, zigbee_install_code?, (Zigbee install-code QR)
 *   device_count?, extracted?: true,    ("*" multi-device MT:, payload found inside text)
 *   raw: string                         trimmed input, never altered
 * }
 *
 * Rules, first match wins (input is trimmed; nothing is URL-decoded before storage):
 *  1. "X-HM://<base36>" anywhere -> homekit (pairing code = low 27 bits). A URI whose
 *     pairing code decodes to more than 8 digits -> other, reason "invalid_homekit_uri".
 *  2. "MT:<base38>" anywhere (case-insensitive) -> matter; qr_payload is the scanned
 *     "MT:..." string kept verbatim (TLV extension data and "*" extra devices included),
 *     manual_code is derived from the first device. Unparseable -> other,
 *     reason "invalid_matter_qr". parseScannedTextAll() splits "MT:a*b" into one result
 *     per device. Rules 1-2 also look inside a percent-encoded copy ("MT%3A...") for
 *     detection only; the extracted payload is what gets stored.
 *  3. Only digits (spaces/dashes ignored), starting "90", >= 52 digits -> Z-Wave
 *     SmartStart QR if the DSK groups and SHA-1 checksum are valid, else other,
 *     reason "invalid_zwave_qr".
 *  4. 40 digits as 8 groups of 5 (dashes/spaces optional) -> Z-Wave DSK when every group
 *     <= 65535, else other, reason "invalid_dsk".
 *  5. Only digits (spaces/dashes ignored), 11 or 21 of them -> Matter manual code if the
 *     Verhoeff check digit and version digit are valid; else other, reason "check_digit"
 *     (or "invalid_matter_manual" for a bad version digit). Never guessed as HomeKit.
 *  6. "XXX-XX-XXX" / "XXX XX XXX" (confidence high) or exactly 8 bare digits (confidence
 *     low) -> homekit pairing code, qr_payload "" (no synthesized X-HM:// URI: that would
 *     not be the device's real QR). Codes HomeKit forbids (00000000, 11111111, ...,
 *     99999999, 12345678, 87654321) -> other, reason "invalid_homekit_code". Any other
 *     digit count is never HomeKit.
 *  7. Tuya / Smart Life links (host containing "tuya" or "smartlife", or a
 *     tuyasmart:// / smartlife:// / thingsmart:// scheme) -> other, custom_standard
 *     "Tuya", recognized, stored verbatim.
 *  8. Zigbee install-code QRs (ZHA formats: "Z:<EUI64>$I:<code>", "...$A:<EUI64>$I:<code>",
 *     "<EUI64>|<code>", Bosch "RB01SG...DLK...") -> other, custom_standard "Zigbee".
 *  9. Anything else non-empty -> other, recognized:false, reason "unknown_format",
 *     qr_payload = the text verbatim.
 *
 * findDuplicate(codes, candidate, excludeId) mirrors the server's _find_duplicate_code
 * (main.py; also served as POST /api/codes/check-duplicate): same protocol only, where
 *  - matter: same 11/21-digit manual code, same MT: string (case-insensitive), or the
 *    same device across manual/QR/"*" payloads = same passcode and discriminator (long
 *    vs long when both are QR, else short = long >> 8);
 *  - homekit: shared 8-digit pairing code (typed or decoded from X-HM://) or same URI;
 *  - zwave: shared 40-digit DSK (bare or inside the SmartStart QR) or same QR digits;
 *  - other: manual or QR equal after whitespace collapse, case-insensitively.
 */
(function (global) {
  "use strict";

  function MP() {
    return global.AntiMatterMatterPayload;
  }
  function HK() {
    return global.AntiMatterHomeKitPayload;
  }
  function ZW() {
    return global.AntiMatterZWavePayload;
  }

  function digitsOnly(value) {
    return String(value || "").replace(/\D/g, "");
  }

  function formatManual11(digits) {
    if (digits.length !== 11) return digits;
    return `${digits.slice(0, 4)}-${digits.slice(4, 7)}-${digits.slice(7)}`;
  }

  /** Matter manual-code digits (11-digit short or 21-digit long form), else "" (= server). */
  function normalizeManualDigits(value) {
    const d = digitsOnly(value);
    return d.length === 11 || d.length === 21 ? d : "";
  }

  /** Legacy helper: the "MT:..." tail of a string (from the first MT:), else "". */
  function normalizeQr(value) {
    const s = String(value || "").trim();
    if (!s) return "";
    const idx = s.toUpperCase().indexOf("MT:");
    return idx >= 0 ? s.substring(idx) : "";
  }

  /* --------------------------------------------------------------- parse -- */

  const INVALID_HOMEKIT = new Set([
    "00000000",
    "11111111",
    "22222222",
    "33333333",
    "44444444",
    "55555555",
    "66666666",
    "77777777",
    "88888888",
    "99999999",
    "12345678",
    "87654321",
  ]);

  // ZHA (zigpy/zha zha/application/helpers.py) install-code QR formats. ZHA expects a
  // 36-hex install code (16 bytes + CRC); 16-36 hex (6/8/12/16-byte codes, with or
  // without CRC) is accepted here since this only labels the code, it does not pair.
  const IC = "((?:[0-9a-f]{4}){4,9})";
  const ZIGBEE_QR = [
    new RegExp("^([0-9a-f]{16})\\|" + IC + "$", "i"), // Consciot
    new RegExp("^Z:([0-9a-f]{16})\\$I:" + IC + "$", "i"), // Enbrighten
    new RegExp("\\$A:([0-9a-f]{16})\\$I:" + IC + "$", "i"), // Aqara
    /^RB01SG[0-9a-f]{34}([0-9a-f]{16})DLK([0-9a-f]{36}|[0-9a-f]{32})$/i, // Bosch
  ];

  const INVISIBLE_EDGES = new RegExp("^[\\s\\uFEFF\\u200B-\\u200D\\u2060]+|[\\s\\uFEFF\\u200B-\\u200D\\u2060]+$", "g");

  function other(raw, extra) {
    return Object.assign({ code_type: "other", manual_code: "", qr_payload: raw, recognized: false, raw }, extra);
  }

  /** Base36 -> 27-bit pairing code as the server decodes it ("" when > 8 digits). */
  function homekitPin(uri) {
    const H = HK();
    const parsed = H && H.parseSetupUri(uri);
    if (!parsed) return "";
    let n = 0n;
    for (const ch of parsed.base36) {
      const idx = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ".indexOf(ch);
      if (idx < 0) return "";
      n = n * 36n + BigInt(idx);
    }
    const s = String(Number(n & 0x7ffffffn));
    return s.length <= 8 ? s.padStart(8, "0") : "";
  }

  function findHomeKitUri(text) {
    const m = /X-HM:\/\/[0-9A-Za-z]+/i.exec(text);
    return m ? m[0] : "";
  }

  function findMatterQr(text) {
    const m = /MT:[0-9A-Za-z.\-*]+/i.exec(text);
    return m ? "MT:" + m[0].slice(3).toUpperCase() : "";
  }

  function percentDecoded(text) {
    if (!/%3A/i.test(text)) return "";
    try {
      return decodeURIComponent(text);
    } catch {
      return "";
    }
  }

  function parseHomeKit(uri, raw) {
    const H = HK();
    if (!H) return null;
    const parsed = H.parseSetupUri(uri);
    const pin = parsed ? homekitPin(parsed.uri) : "";
    if (!parsed || !pin) return other(raw, { reason: "invalid_homekit_uri", suggested_type: "homekit" });
    const n = H.normalizeFields("", parsed.uri);
    return {
      code_type: "homekit",
      manual_code: pin,
      qr_payload: n.qr_payload,
      setup_id: n.setup_id,
      homekit_category: n.homekit_category,
      homekit_flag: n.homekit_flag,
      recognized: true,
      confidence: "high",
      raw,
    };
  }

  /** One MT: device payload -> {manual_code, qr_payload} or null. */
  function matterDevice(payload) {
    const M = MP();
    if (!M) return null;
    try {
      M.parseQrPayload(payload);
    } catch {
      return null;
    }
    return M.normalizeScannedOrEntered("", payload);
  }

  function parseMatterQr(payload, raw) {
    const parts = payload.slice(3).split("*");
    const first = parts[0] ? matterDevice("MT:" + parts[0]) : null;
    if (!first) return other(raw, { reason: "invalid_matter_qr", suggested_type: "matter" });
    const out = {
      code_type: "matter",
      manual_code: first.manual_code,
      qr_payload: payload, // verbatim, incl. TLV data and "*" devices
      recognized: true,
      confidence: "high",
      raw,
    };
    if (parts.length > 1) out.device_count = parts.length;
    if (payload !== raw) out.extracted = true;
    return out;
  }

  function parseOne(raw) {
    const text = raw;
    const decoded = percentDecoded(text);

    // 1-2. Structured payloads, possibly embedded in other text or a URL.
    const hk = findHomeKitUri(text) || (decoded && findHomeKitUri(decoded));
    if (hk) {
      const r = parseHomeKit(hk, raw);
      if (r) {
        if (r.recognized && hk.length !== raw.length) r.extracted = true;
        return r;
      }
    }
    const mt = findMatterQr(text) || (decoded && findMatterQr(decoded));
    if (mt) return parseMatterQr(mt, raw);

    const compact = text.replace(/[\s-]/g, "");
    const onlyDigits = /^\d+$/.test(compact);

    // 3. Z-Wave SmartStart QR (numeric only).
    if (onlyDigits && compact.startsWith("90") && compact.length >= 52) {
      const Z = ZW();
      const qr = Z ? Z.extractQrString(compact) : "";
      if (qr) {
        const n = Z.normalizeFields("", qr);
        return {
          code_type: "zwave",
          manual_code: n.manual_code,
          qr_payload: n.qr_payload,
          zwave_pin: n.zwave_pin,
          zwave_meta: n.zwave_meta,
          recognized: true,
          confidence: "high",
          raw,
        };
      }
      return other(raw, { reason: "invalid_zwave_qr", suggested_type: "zwave" });
    }

    // 4. Bare Z-Wave DSK: 8 groups of 5 digits.
    if (/^\d{5}(?:[\s-]?\d{5}){7}$/.test(text)) {
      const groups = compact.match(/\d{5}/g);
      if (groups.every((g) => Number(g) <= 65535)) {
        const Z = ZW();
        return {
          code_type: "zwave",
          manual_code: Z ? Z.formatDsk(compact) : groups.join("-"),
          qr_payload: "",
          zwave_pin: compact.slice(0, 5),
          recognized: true,
          confidence: "high",
          raw,
        };
      }
      return other(raw, { reason: "invalid_dsk", suggested_type: "zwave" });
    }

    // 5. Matter manual pairing code (11 or 21 digits), Verhoeff-checked.
    if (onlyDigits && /^[\d\s-]+$/.test(text) && (compact.length === 11 || compact.length === 21)) {
      const M = MP();
      if (M) {
        try {
          M.parseManualPayload(compact);
          const n = M.normalizeScannedOrEntered(compact, "");
          return {
            code_type: "matter",
            manual_code: n.manual_code,
            qr_payload: n.qr_payload || "",
            recognized: true,
            confidence: "high",
            raw,
          };
        } catch (e) {
          const reason = /check digit/i.test(String(e && e.message)) ? "check_digit" : "invalid_matter_manual";
          return other(raw, { reason, suggested_type: "matter" });
        }
      }
    }

    // 6. HomeKit 8-digit setup code.
    const dashed = /^\d{3}([\s-])\d{2}\1\d{3}$/.test(text);
    if (dashed || /^\d{8}$/.test(text)) {
      if (INVALID_HOMEKIT.has(compact)) return other(raw, { reason: "invalid_homekit_code", suggested_type: "homekit" });
      return {
        code_type: "homekit",
        manual_code: compact,
        qr_payload: "",
        recognized: true,
        confidence: dashed ? "high" : "low",
        raw,
      };
    }

    // 7. Tuya / Smart Life links.
    const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(text);
    if (scheme) {
      const s = scheme[1].toLowerCase();
      let host = "";
      try {
        host = new URL(text).hostname.toLowerCase();
      } catch {
        host = "";
      }
      if (/^(tuyasmart|smartlife|thingsmart)$/.test(s) || /tuya|smartlife/.test(host)) {
        return { code_type: "other", manual_code: "", qr_payload: raw, custom_standard: "Tuya", recognized: true, confidence: "high", raw };
      }
    }

    // 8. Zigbee install codes.
    for (const re of ZIGBEE_QR) {
      const m = re.exec(text);
      if (m) {
        return {
          code_type: "other",
          manual_code: "",
          qr_payload: raw,
          custom_standard: "Zigbee",
          zigbee_ieee: m[1].toUpperCase(),
          zigbee_install_code: m[2].toUpperCase(),
          recognized: true,
          confidence: "high",
          raw,
        };
      }
    }

    // 9. Unknown: keep it verbatim so it can still be saved as "Other".
    return other(raw, { reason: "unknown_format" });
  }

  /**
   * @param {string} input scanned or pasted text
   * @returns {object|null} null only for empty input
   */
  function parseScannedText(input) {
    const raw = String(input == null ? "" : input).replace(INVISIBLE_EDGES, "");
    if (!raw) return null;
    return parseOne(raw);
  }

  /**
   * Like parseScannedText, but a multi-device Matter QR ("MT:<a>*<b>") yields one result
   * per device, each with its own "MT:<x>" qr_payload and device_index/device_count.
   * @returns {object[]} [] for empty input
   */
  function parseScannedTextAll(input) {
    const first = parseScannedText(input);
    if (!first) return [];
    if (first.code_type !== "matter" || !first.device_count) return [first];
    const parts = first.qr_payload.slice(3).split("*");
    return parts.map((part, i) => {
      const payload = "MT:" + part;
      const dev = part ? matterDevice(payload) : null;
      const base = dev
        ? { code_type: "matter", manual_code: dev.manual_code, qr_payload: payload, recognized: true, confidence: "high" }
        : { code_type: "other", manual_code: "", qr_payload: payload, recognized: false, reason: "invalid_matter_qr", suggested_type: "matter" };
      return Object.assign(base, { device_index: i, device_count: parts.length, raw: first.raw });
    });
  }

  /* ----------------------------------------------------------- duplicate -- */

  /** Protocol of a stored code or candidate (= main.py _code_protocol). */
  function codeProtocol(code) {
    let ct = String((code && code.code_type) || "matter").trim().toLowerCase();
    if (ct === "zigbee" || ct === "tuya") ct = "other"; // UI presets of "other"
    if (ct === "homekit" || ct === "zwave" || ct === "other") return ct;
    const qrRaw = String((code && code.qr_payload) || "");
    if (qrRaw.trim().toUpperCase().startsWith("X-HM://")) return "homekit";
    const Z = ZW();
    if (Z && Z.extractQrString(qrRaw)) return "zwave";
    return "matter";
  }

  function matterQrKey(value) {
    const s = String(value || "").trim().toUpperCase();
    return s.startsWith("MT:") ? s : "";
  }

  /** Every device a Matter code identifies (each "*" QR part + the manual code). */
  function matterIdentities(manual, qr) {
    const M = MP();
    const out = [];
    if (!M) return out;
    const qk = matterQrKey(qr);
    if (qk) {
      for (const chunk of qk.slice(3).split("*")) {
        try {
          out.push(M.parseQrPayload("MT:" + chunk));
        } catch {
          /* skip unparseable part */
        }
      }
    }
    const mk = normalizeManualDigits(manual);
    if (mk) {
      try {
        out.push(M.parseManualPayload(mk));
      } catch {
        /* skip */
      }
    }
    return out;
  }

  function sameMatterDevice(a, b) {
    if (a.pincode !== b.pincode) return false;
    if (a.long_discriminator != null && b.long_discriminator != null) return a.long_discriminator === b.long_discriminator;
    return a.short_discriminator === b.short_discriminator;
  }

  function homekitQrKey(value) {
    const H = HK();
    const p = H && H.parseSetupUri(String(value || ""));
    return p ? p.uri.toUpperCase() : "";
  }

  function homekitPins(manual, qr) {
    const H = HK();
    const pins = new Set();
    const typed = H ? H.pairingDigits(manual || "") : "";
    if (typed) pins.add(typed);
    if (homekitQrKey(qr)) {
      const d = homekitPin(qr);
      if (d) pins.add(d);
    }
    return pins;
  }

  function zwaveDsks(manual, qr) {
    const Z = ZW();
    const out = new Set();
    const m = digitsOnly(manual);
    if (m.length === 40) out.add(m);
    if (Z) {
      const q = Z.extractQrString(qr || "");
      const parsed = q ? Z.parseQrDigits(q) : null;
      if (parsed) out.add(digitsOnly(parsed.dsk));
    }
    return out;
  }

  // Python str.split() whitespace set, so the key matches main.py _other_key exactly.
  const PY_WS = new RegExp("[\\t\\n\\x0b\\x0c\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]+");

  /** Whitespace-collapsed, case-folded key (Python " ".join(s.split()).casefold()). */
  function otherKey(value) {
    const collapsed = String(value || "")
      .split(PY_WS)
      .filter(Boolean)
      .join(" ");
    return collapsed.toUpperCase().toLowerCase(); // ~casefold (sharp s -> ss, final sigma -> sigma, ...)
  }

  function intersects(a, b) {
    for (const x of a) if (b.has(x)) return true;
    return false;
  }

  /**
   * First code in `codes` that is the same device as `candidate` (same protocol only),
   * skipping `excludeId`. Same rules as the server (see header).
   * @param {Array<object>} codes
   * @param {object} candidate {code_type?, manual_code?, qr_payload?}
   * @param {string|null} [excludeId]
   * @returns {object|null}
   */
  function findDuplicate(codes, candidate, excludeId = null) {
    if (!candidate) return null;
    const proto = codeProtocol(candidate);
    const manual = String(candidate.manual_code || "");
    const qr = String(candidate.qr_payload || "");
    const others = (codes || []).filter(
      (c) => c && !(excludeId && c.id === excludeId) && codeProtocol(c) === proto
    );

    if (proto === "zwave") {
      const dsks = zwaveDsks(manual, qr);
      const Z = ZW();
      const qrKey = Z ? Z.extractQrString(qr) : "";
      if (!dsks.size && !qrKey) return null;
      for (const c of others) {
        if (intersects(dsks, zwaveDsks(c.manual_code, c.qr_payload))) return c;
        if (qrKey && Z && qrKey === Z.extractQrString(String(c.qr_payload || ""))) return c;
      }
      return null;
    }

    if (proto === "homekit") {
      const pins = homekitPins(manual, qr);
      const qrKey = homekitQrKey(qr);
      if (!pins.size && !qrKey) return null;
      for (const c of others) {
        if (intersects(pins, homekitPins(c.manual_code, c.qr_payload))) return c;
        if (qrKey && qrKey === homekitQrKey(c.qr_payload)) return c;
      }
      return null;
    }

    if (proto === "other") {
      const manKey = otherKey(manual);
      const qrKey = otherKey(qr);
      if (!manKey && !qrKey) return null;
      for (const c of others) {
        if (manKey && manKey === otherKey(c.manual_code)) return c;
        if (qrKey && qrKey === otherKey(c.qr_payload)) return c;
      }
      return null;
    }

    const manKey = normalizeManualDigits(manual);
    const qrKey = matterQrKey(qr);
    if (!manKey && !qrKey) return null;
    const idents = matterIdentities(manual, qr);
    for (const c of others) {
      if (manKey && manKey === normalizeManualDigits(c.manual_code)) return c;
      if (qrKey && qrKey === matterQrKey(c.qr_payload)) return c;
      if (idents.length) {
        const theirs = matterIdentities(c.manual_code, c.qr_payload);
        if (idents.some((a) => theirs.some((b) => sameMatterDevice(a, b)))) return c;
      }
    }
    return null;
  }

  global.AntiMatterScan = {
    parseScannedText,
    parseScannedTextAll,
    findDuplicate,
    codeProtocol,
    normalizeManualDigits,
    normalizeQr,
    formatManual11,
    otherKey,
  };
})(typeof window !== "undefined" ? window : globalThis);
