/**
 * Matter setup payload parse/generate (CHIP SetupPayload parity).
 */
(function (global) {
  const BASE38_CODES = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-.";
  const BASE38_RADIX = BASE38_CODES.length;
  const BASE38_CHARS_NEEDED = [2, 4, 5];

  const VERHOEFF_D = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
    [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
    [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
    [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
    [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
    [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
    [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
    [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
    [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
  ];
  const VERHOEFF_P = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
    [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
    [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
    [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
    [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
    [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
    [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
  ];
  const VERHOEFF_INV = [0, 4, 3, 2, 1, 5, 6, 7, 8, 9];

  const QR_SPEC = [
    ["padding", 4],
    ["pincode", 27],
    ["discriminator", 12],
    ["discovery", 8],
    ["flow", 2],
    ["pid", 16],
    ["vid", 16],
    ["version", 3],
  ];

  const MANUAL_SPEC = [
    ["version", 1],
    ["vid_pid_present", 1],
    ["discriminator", 4],
    ["pincode_lsb", 14],
    ["pincode_msb", 13],
    ["vid", 16],
    ["pid", 16],
    ["padding", 7],
  ];

  function base38Encode(data) {
    let out = "";
    let i = 0;
    while (i < data.length) {
      const bytesInChunk = Math.min(3, data.length - i);
      let value = 0;
      for (let j = 0; j < bytesInChunk; j++) value += data[i + j] << (8 * j);
      let need = BASE38_CHARS_NEEDED[bytesInChunk - 1];
      while (need > 0) {
        out += BASE38_CODES[value % BASE38_RADIX];
        value = Math.floor(value / BASE38_RADIX);
        need--;
      }
      i += bytesInChunk;
    }
    return out;
  }

  function base38Decode(encoded) {
    const decoded = [];
    let i = 0;
    const total = encoded.length;
    while (i < total) {
      let charsInChunk = i + 5 > total ? (total - i >= 4 ? 4 : 2) : 5;
      if (total - i === 4) charsInChunk = 4;
      else if (total - i === 2) charsInChunk = 2;
      let value = 0;
      for (let j = i + charsInChunk - 1; j >= i; j--) {
        const code = BASE38_CODES.indexOf(encoded[j]);
        if (code < 0) throw new Error("Invalid base38 character");
        value = value * BASE38_RADIX + code;
      }
      const bytesInChunk = BASE38_CHARS_NEEDED.indexOf(charsInChunk) + 1;
      for (let k = 0; k < bytesInChunk; k++) {
        decoded.push(value & 0xff);
        value >>= 8;
      }
      i += charsInChunk;
    }
    return decoded;
  }

  function verhoeffCheckDigit(payload) {
    let c = 0;
    for (let i = payload.length - 1; i >= 0; i--) {
      c = VERHOEFF_D[c][VERHOEFF_P[(payload.length - i) % 8][parseInt(payload[i], 10)]];
    }
    return String(VERHOEFF_INV[c]);
  }

  function bytesToBitstring(bytes, bitCount) {
    let bits = "";
    for (let i = 0; i < bytes.length; i++) bits += bytes[i].toString(2).padStart(8, "0");
    return bits.slice(0, bitCount);
  }

  function bitstringToBytes(bits) {
    const pad = (8 - (bits.length % 8)) % 8;
    const padded = bits + "0".repeat(pad);
    const out = [];
    for (let i = 0; i < padded.length; i += 8) out.push(parseInt(padded.slice(i, i + 8), 2));
    return out;
  }

  function readFields(bytes, spec) {
    const bitCount = spec.reduce((s, [, w]) => s + w, 0);
    const bits = bytesToBitstring(bytes, bitCount);
    let pos = 0;
    const out = {};
    for (const [name, width] of spec) {
      const chunk = bits.slice(pos, pos + width);
      pos += width;
      out[name] = chunk ? parseInt(chunk, 2) : 0;
    }
    return out;
  }

  function writeFields(values, spec) {
    let bits = "";
    for (const [name, width] of spec) {
      const v = values[name] ?? 0;
      bits += (v & ((1 << width) - 1)).toString(2).padStart(width, "0");
    }
    return bitstringToBytes(bits);
  }

  function parseQrPayload(payload) {
    const raw = payload.trim();
    if (!raw.toUpperCase().startsWith("MT:")) throw new Error("Not MT:");
    // "MT:<p1>*<p2>..." bundles several devices; parse the first. Bytes past the
    // fixed 11-byte base payload are optional TLV data, so only those are reversed.
    const data = base38Decode(raw.slice(3).split("*")[0]);
    if (data.length < 11) throw new Error("MT: payload too short");
    const decoded = data.slice(0, 11).reverse();
    const f = readFields(decoded, QR_SPEC);
    return {
      pincode: f.pincode,
      short_discriminator: f.discriminator >> 8,
      long_discriminator: f.discriminator,
      discovery: f.discovery,
      flow: f.flow,
      vid: f.vid,
      pid: f.pid,
    };
  }

  function parseManualPayload(payload) {
    const digits = payload.replace(/\D/g, "");
    if (digits.length !== 11 && digits.length !== 21) throw new Error("bad length");
    if (parseInt(digits[0], 10) > 7) throw new Error("bad version");
    if (verhoeffCheckDigit(digits.slice(0, -1)) !== digits[digits.length - 1]) {
      throw new Error("check digit");
    }
    const isLong = (parseInt(digits[0], 10) & (1 << 2)) !== 0;
    const bits =
      parseInt(digits[0], 10).toString(2).padStart(4, "0") +
      parseInt(digits.slice(1, 6), 10).toString(2).padStart(16, "0") +
      parseInt(digits.slice(6, 10), 10).toString(2).padStart(13, "0") +
      (isLong ? parseInt(digits.slice(10, 15), 10).toString(2).padStart(16, "0") : "0".repeat(16)) +
      (isLong ? parseInt(digits.slice(15, 20), 10).toString(2).padStart(16, "0") : "0".repeat(16)) +
      "0".repeat(7);
    const f = readFields(bitstringToBytes(bits), MANUAL_SPEC);
    const vidPid = f.vid_pid_present !== 0;
    return {
      pincode: (f.pincode_msb << 14) | f.pincode_lsb,
      short_discriminator: f.discriminator,
      long_discriminator: null,
      discovery: null,
      flow: vidPid ? 2 : 0,
      vid: vidPid ? f.vid : null,
      pid: vidPid ? f.pid : null,
    };
  }

  function generateQrPayload(parsed) {
    if (parsed.long_discriminator == null) throw new Error("no discriminator");
    const packed = writeFields(
      {
        padding: 0,
        pincode: parsed.pincode,
        discriminator: parsed.long_discriminator,
        discovery: parsed.discovery ?? 4,
        flow: parsed.flow,
        pid: parsed.pid ?? 0,
        vid: parsed.vid ?? 0,
        version: 0,
      },
      QR_SPEC
    );
    return "MT:" + base38Encode(packed.slice().reverse());
  }

  function generateManualCode(parsed) {
    const vidPidPresent = parsed.flow === 0 ? 0 : 1;
    const vid = vidPidPresent ? parsed.vid ?? 0 : 0;
    const pid = vidPidPresent ? parsed.pid ?? 0 : 0;
    const data = writeFields(
      {
        version: 0,
        vid_pid_present: vidPidPresent,
        discriminator: parsed.short_discriminator,
        pincode_lsb: parsed.pincode & 0x3fff,
        pincode_msb: parsed.pincode >> 14,
        vid,
        pid,
        padding: 0,
      },
      MANUAL_SPEC
    );
    const bitCount = MANUAL_SPEC.reduce((s, [, w]) => s + w, 0);
    const bits = bytesToBitstring(data, bitCount);
    const chunk1 = String(parseInt(bits.slice(0, 4), 2));
    const chunk2 = String(parseInt(bits.slice(4, 20), 2)).padStart(5, "0");
    const chunk3 = String(parseInt(bits.slice(20, 33), 2)).padStart(4, "0");
    const chunk4 = vidPidPresent ? String(vid).padStart(5, "0") : "";
    const chunk5 = vidPidPresent ? String(pid).padStart(5, "0") : "";
    const payload = chunk1 + chunk2 + chunk3 + chunk4 + chunk5;
    return payload + verhoeffCheckDigit(payload);
  }

  function formatManualDisplay(manual) {
    const digits = String(manual).replace(/\D/g, "");
    if (digits.length === 11) {
      return `${digits.slice(0, 4)}-${digits.slice(4, 7)}-${digits.slice(7)}`;
    }
    if (digits.length === 21) {
      return `${digits.slice(0, 5)}-${digits.slice(5, 10)}-${digits.slice(10, 15)}-${digits.slice(15, 20)}-${digits.slice(20)}`;
    }
    return manual.trim();
  }

  /**
   * @param {string} [manualCode]
   * @param {string} [qrPayload]
   * @returns {{ manual_code: string, qr_payload: string } | null}
   */
  function normalizeScannedOrEntered(manualCode = "", qrPayload = "") {
    const manualIn = String(manualCode || "").trim();
    let qrIn = String(qrPayload || "").trim();
    let parsed = null;

    if (qrIn.toUpperCase().startsWith("MT:")) {
      try {
        parsed = parseQrPayload(qrIn);
      } catch {
        parsed = null;
      }
    }
    if (!parsed) {
      const digits = manualIn.replace(/\D/g, "");
      if (digits.length === 11 || digits.length === 21) {
        try {
          parsed = parseManualPayload(digits);
        } catch {
          parsed = null;
        }
      }
    }
    if (!parsed) {
      if (!qrIn.toUpperCase().startsWith("MT:") && !manualIn) return null;
      const idx = qrIn.toUpperCase().indexOf("MT:");
      if (idx >= 0) qrIn = qrIn.slice(idx);
      else if (!qrIn.toUpperCase().startsWith("MT:")) qrIn = "";
      const d = manualIn.replace(/\D/g, "");
      return {
        manual_code: d.length === 11 ? formatManualDisplay(d) : manualIn,
        qr_payload: qrIn,
      };
    }

    const manualRaw = generateManualCode(parsed);
    let qrOut = "";
    if (parsed.long_discriminator != null && qrIn.toUpperCase().startsWith("MT:")) {
      // Keep the scanned string verbatim: regenerating would drop TLV data and extra
      // "*" device payloads, producing a QR that no longer matches the label.
      qrOut = "MT:" + qrIn.slice(3);
    } else {
      try {
        qrOut = generateQrPayload(parsed);
      } catch {
        qrOut = qrPayload && String(qrPayload).toUpperCase().startsWith("MT:") ? qrPayload.trim() : "";
      }
    }
    return { manual_code: formatManualDisplay(manualRaw), qr_payload: qrOut };
  }

  global.AntiMatterMatterPayload = {
    parseQrPayload,
    parseManualPayload,
    generateQrPayload,
    generateManualCode,
    normalizeScannedOrEntered,
    formatManualDisplay,
  };
})(typeof window !== "undefined" ? window : globalThis);
