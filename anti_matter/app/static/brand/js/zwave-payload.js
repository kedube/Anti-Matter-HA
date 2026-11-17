/**
 * Z-Wave SmartStart QR (SDS13937) — aligned with zwave-js/qr and Silicon Labs format.
 * QR text: decimal digits only; lead-in 90 ('Z'), version 01 = SmartStart.
 */
(function (global) {
  const LEAD_IN = 90;
  const VERSION_SMART_START = 1;

  // Matches zwave-js's ProvisioningInformationType enum (packages/core/src/qr/definitions.ts).
  const TLV_PRODUCT_TYPE = 0;
  const TLV_PRODUCT_ID = 1;
  const TLV_SUPPORTED_PROTOCOLS = 4;

  function digitsOnly(value) {
    return String(value || "").replace(/\D/g, "");
  }

  /** @returns {string} */
  function formatDsk(dskDigits) {
    const d = digitsOnly(dskDigits);
    if (d.length !== 40) return String(dskDigits || "").trim();
    const parts = [];
    for (let i = 0; i < 8; i++) {
      parts.push(d.slice(i * 5, i * 5 + 5));
    }
    return parts.join("-");
  }

  function parseDskGroups(dskDigits) {
    const d = digitsOnly(dskDigits);
    if (d.length !== 40) return null;
    const groups = [];
    for (let i = 0; i < 8; i++) {
      const g = parseInt(d.slice(i * 5, i * 5 + 5), 10);
      if (Number.isNaN(g) || g < 0 || g > 65535) return null;
      groups.push(g);
    }
    return groups;
  }

  function isValidDskFormatted(value) {
    const s = String(value || "").trim();
    if (!/^\d{5}(-\d{5}){7}$/.test(s)) return false;
    return parseDskGroups(s) !== null;
  }

  function pinFromDsk(dskDigits) {
    const d = digitsOnly(dskDigits);
    return d.length >= 5 ? d.slice(0, 5) : "";
  }

  // Pure-JS SHA-1 (SubtleCrypto's digest() is async-only, but the grid render
  // path — parseQrDigits, called synchronously for every card — needs the
  // checksum decision immediately to know whether to draw a QR <img> tag at
  // all. Verified byte-for-byte against Python's hashlib.sha1 for the exact
  // body strings this file hashes (checksumForBody below).
  function sha1Sync(bytes) {
    let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
    const ml = bytes.length * 8;
    const withOne = new Uint8Array(bytes.length + 1);
    withOne.set(bytes);
    withOne[bytes.length] = 0x80;
    let totalLen = withOne.length;
    while (totalLen % 64 !== 56) totalLen++;
    const padded = new Uint8Array(totalLen + 8);
    padded.set(withOne);
    const dv = new DataView(padded.buffer);
    dv.setUint32(padded.length - 4, ml >>> 0, false);
    dv.setUint32(padded.length - 8, Math.floor(ml / 0x100000000), false);
    for (let chunkStart = 0; chunkStart < padded.length; chunkStart += 64) {
      const w = new Uint32Array(80);
      for (let i = 0; i < 16; i++) {
        w[i] = (padded[chunkStart + i * 4] << 24) | (padded[chunkStart + i * 4 + 1] << 16) |
          (padded[chunkStart + i * 4 + 2] << 8) | padded[chunkStart + i * 4 + 3];
      }
      for (let i = 16; i < 80; i++) {
        const v = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16];
        w[i] = (v << 1) | (v >>> 31);
      }
      let a = h0, b = h1, c = h2, d = h3, e = h4;
      for (let i = 0; i < 80; i++) {
        let f, k;
        if (i < 20) { f = (b & c) | (~b & d); k = 0x5a827999; }
        else if (i < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
        else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; }
        else { f = b ^ c ^ d; k = 0xca62c1d6; }
        const temp = (((a << 5) | (a >>> 27)) + f + e + k + w[i]) >>> 0;
        e = d; d = c; c = ((b << 30) | (b >>> 2)) >>> 0; b = a; a = temp;
      }
      h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0;
    }
    const out = new Uint8Array(20);
    const dv2 = new DataView(out.buffer);
    [h0, h1, h2, h3, h4].forEach((h, i) => dv2.setUint32(i * 4, h, false));
    return out;
  }

  function checksumValid(qrDigits) {
    if (qrDigits.length < 9) return false;
    const given = parseInt(qrDigits.slice(4, 9), 10);
    const body = qrDigits.slice(9);
    const digest = sha1Sync(new TextEncoder().encode(body));
    const expected = (digest[0] << 8) | digest[1];
    return given === expected;
  }

  function parseTlvs(tail) {
    const meta = {};
    let pos = 0;
    while (pos + 4 <= tail.length) {
      const typeCrit = parseInt(tail.slice(pos, pos + 2), 10);
      pos += 2;
      const typ = typeCrit >> 1;
      const len = parseInt(tail.slice(pos, pos + 2), 10);
      pos += 2;
      if (len < 0 || pos + len > tail.length) break;
      const data = tail.slice(pos, pos + len);
      pos += len;
      if (typ === TLV_PRODUCT_TYPE && len >= 10) {
        meta.genericDeviceClass = parseInt(data.slice(0, 5), 10) >> 8;
        meta.specificDeviceClass = parseInt(data.slice(0, 5), 10) & 0xff;
        meta.installerIconType = parseInt(data.slice(5, 10), 10);
      } else if (typ === TLV_PRODUCT_ID && len >= 20) {
        meta.manufacturerId = parseInt(data.slice(0, 5), 10);
        meta.productType = parseInt(data.slice(5, 10), 10);
        meta.productId = parseInt(data.slice(10, 15), 10);
        const app = parseInt(data.slice(15, 20), 10);
        meta.applicationVersion = `${app >> 8}.${app & 0xff}`;
      } else if (typ === TLV_SUPPORTED_PROTOCOLS && (len === 2 || len === 3 || len === 5)) {
        const bits = parseInt(data, 10);
        meta.supportedProtocols = {
          zwave: !!(bits & 0x01),
          zwaveLongRange: !!(bits & 0x02),
        };
      }
    }
    return meta;
  }

  // RequestedKeys byte (3 decimal digits at QR position 9-12) — bit N corresponds to
  // SecurityClass ordinal N in zwave-js: 0=S2_Unauthenticated, 1=S2_Authenticated,
  // 2=S2_AccessControl, 7=S0_Legacy (bits 3-6 are unused/reserved).
  function parseRequestedSecurityClasses(requestedKeysDigits) {
    const bits = parseInt(requestedKeysDigits, 10) || 0;
    return {
      s2Unauthenticated: !!(bits & 0x01),
      s2Authenticated: !!(bits & 0x02),
      s2AccessControl: !!(bits & 0x04),
      s0Legacy: !!(bits & 0x80),
    };
  }

  /**
   * @returns {{ qr: string, dsk: string, pin: string, meta: object, version: number }|null}
   */
  function parseQrDigits(qrDigits) {
    const d = digitsOnly(qrDigits);
    if (d.length < 52 || !d.startsWith("90")) return null;
    const version = parseInt(d.slice(2, 4), 10);
    const dskRaw = d.slice(12, 52);
    if (!parseDskGroups(dskRaw)) return null;
    if (!checksumValid(d)) return null;
    const meta = parseTlvs(d.slice(52));
    return {
      qr: d,
      dsk: formatDsk(dskRaw),
      pin: pinFromDsk(dskRaw),
      meta,
      version,
      smartStart: version === VERSION_SMART_START,
      requestedSecurityClasses: parseRequestedSecurityClasses(d.slice(9, 12)),
    };
  }

  function extractQrString(text) {
    const d = digitsOnly(text);
    if (!d.startsWith("90")) return "";
    let best = "";
    // From the 52-digit minimum (no TLVs), so a short QR followed by other digits in the
    // same text (e.g. "… PIN 12345") is still found.
    for (let end = 52; end <= Math.min(d.length, 200); end++) {
      const trial = d.slice(0, end);
      if (parseQrDigits(trial)) best = trial;
    }
    if (best) return best;
    const parsed = parseQrDigits(d);
    return parsed ? parsed.qr : "";
  }

  function hasScannableQr(qrPayload) {
    // extractQrString only ever returns non-empty when it found a subset that
    // parseQrDigits fully validated (checksum + DSK) — no extra length threshold
    // needed, and a hardcoded 90 wrongly rejected valid QR codes with a short or
    // missing TLV tail (the spec's actual minimum is 52: see parseQrDigits).
    return !!extractQrString(qrPayload);
  }

  function normalizeFields(manualCode, qrPayload) {
    const qrIn = String(qrPayload || "").trim();
    const qrExtracted = qrIn ? extractQrString(qrIn) : "";
    const parsed = qrExtracted ? parseQrDigits(qrExtracted) : null;

    let dskDigits = "";
    if (parsed) {
      dskDigits = digitsOnly(parsed.dsk);
    } else if (isValidDskFormatted(manualCode)) {
      dskDigits = digitsOnly(manualCode);
    } else {
      const m = digitsOnly(manualCode);
      if (m.length === 40) dskDigits = m;
    }

    return {
      manual_code: dskDigits ? formatDsk(dskDigits) : String(manualCode || "").trim(),
      qr_payload: parsed ? parsed.qr : qrExtracted,
      zwave_pin: dskDigits ? pinFromDsk(dskDigits) : pinFromDsk(manualCode),
      zwave_meta: parsed?.meta || {},
    };
  }

  function codeProtocol(code) {
    const ct = String(code?.code_type || "").toLowerCase();
    if (ct === "zwave") return "zwave";
    if (ct === "homekit") return "homekit";
    if (hasScannableQr(code?.qr_payload)) return "zwave";
    const q = String(code?.qr_payload || "").trim().toUpperCase();
    if (q.startsWith("X-HM://")) return "homekit";
    if (q.startsWith("MT:")) return "matter";
    return "matter";
  }

  function formatDskDisplay(manualCode) {
    const formatted = formatDsk(manualCode);
    return formatted || String(manualCode || "").trim();
  }

  function metaSummary(meta) {
    if (!meta || !meta.manufacturerId) return "";
    const parts = [];
    if (meta.manufacturerId != null) {
      parts.push(`Mfg ${meta.manufacturerId}`);
    }
    if (meta.productType != null && meta.productId != null) {
      parts.push(`Type ${meta.productType} / ID ${meta.productId}`);
    }
    return parts.join(" · ");
  }

  global.AntiMatterZWavePayload = {
    LEAD_IN,
    formatDsk,
    formatDskDisplay,
    pinFromDsk,
    isValidDskFormatted,
    parseQrDigits,
    extractQrString,
    hasScannableQr,
    normalizeFields,
    codeProtocol,
    metaSummary,
    checksumValid,
  };
})(typeof window !== "undefined" ? window : globalThis);
