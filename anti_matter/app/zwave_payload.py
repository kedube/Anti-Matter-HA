"""Z-Wave SmartStart QR (SDS13937) — parity with zwave-js/qr."""

from __future__ import annotations

import hashlib
import re
from typing import Any

LEAD_IN = 90
VERSION_SMART_START = 1
# Matches zwave-js's ProvisioningInformationType enum (packages/core/src/qr/definitions.ts).
TLV_PRODUCT_TYPE = 0
TLV_PRODUCT_ID = 1
TLV_SUPPORTED_PROTOCOLS = 4


def _digits_only(value: str) -> str:
    # [^0-9], not \D: \d also matches non-ASCII digits (e.g. Arabic-Indic), which then
    # crash checksum_valid's .encode("ascii"). The browser parser drops them the same way.
    return re.sub(r"[^0-9]", "", value or "")


def format_dsk(dsk_digits: str) -> str:
    d = _digits_only(dsk_digits)
    if len(d) != 40:
        return (dsk_digits or "").strip()
    return "-".join(d[i : i + 5] for i in range(0, 40, 5))


def parse_dsk_groups(dsk_digits: str) -> list[int] | None:
    d = _digits_only(dsk_digits)
    if len(d) != 40:
        return None
    groups: list[int] = []
    for i in range(8):
        g = int(d[i * 5 : i * 5 + 5], 10)
        if g < 0 or g > 65535:
            return None
        groups.append(g)
    return groups


def is_valid_dsk_formatted(value: str) -> bool:
    s = (value or "").strip()
    if not re.fullmatch(r"\d{5}(-\d{5}){7}", s):
        return False
    return parse_dsk_groups(s) is not None


def pin_from_dsk(dsk_digits: str) -> str:
    d = _digits_only(dsk_digits)
    return d[:5] if len(d) >= 5 else ""


def checksum_valid(qr_digits: str) -> bool:
    if len(qr_digits) < 9:
        return False
    given = int(qr_digits[4:9])
    body = qr_digits[9:]
    digest = hashlib.sha1(body.encode("ascii")).digest()
    expected = (digest[0] << 8) | digest[1]
    return given == expected


def _parse_tlvs(tail: str) -> dict[str, Any]:
    meta: dict[str, Any] = {}
    pos = 0
    while pos + 4 <= len(tail):
        type_crit = int(tail[pos : pos + 2])
        pos += 2
        typ = type_crit >> 1
        length = int(tail[pos : pos + 2])
        pos += 2
        if length < 0 or pos + length > len(tail):
            break
        data = tail[pos : pos + length]
        pos += length
        if typ == TLV_PRODUCT_TYPE and length >= 10:
            word = int(data[0:5])
            meta["generic_device_class"] = word >> 8
            meta["specific_device_class"] = word & 0xFF
            meta["installer_icon_type"] = int(data[5:10])
        elif typ == TLV_PRODUCT_ID and length >= 20:
            meta["manufacturer_id"] = int(data[0:5])
            meta["product_type"] = int(data[5:10])
            meta["product_id"] = int(data[10:15])
            app = int(data[15:20])
            meta["application_version"] = f"{app >> 8}.{app & 0xFF}"
        elif typ == TLV_SUPPORTED_PROTOCOLS and length in (2, 3, 5):
            bits = int(data)
            meta["supported_protocols"] = {
                "zwave": bool(bits & 0x01),
                "zwave_long_range": bool(bits & 0x02),
            }
    return meta


def _parse_requested_security_classes(requested_keys_digits: str) -> dict[str, bool]:
    """RequestedKeys byte (3 decimal digits at QR position 9-12) — bit N corresponds to
    SecurityClass ordinal N in zwave-js: 0=S2_Unauthenticated, 1=S2_Authenticated,
    2=S2_AccessControl, 7=S0_Legacy (bits 3-6 are unused/reserved)."""
    try:
        bits = int(requested_keys_digits)
    except ValueError:
        bits = 0
    return {
        "s2_unauthenticated": bool(bits & 0x01),
        "s2_authenticated": bool(bits & 0x02),
        "s2_access_control": bool(bits & 0x04),
        "s0_legacy": bool(bits & 0x80),
    }


def parse_qr_digits(qr_digits: str) -> dict[str, Any] | None:
    d = _digits_only(qr_digits)
    if len(d) < 52 or not d.startswith("90"):
        return None
    version = int(d[2:4])
    dsk_raw = d[12:52]
    if parse_dsk_groups(dsk_raw) is None:
        return None
    if not checksum_valid(d):
        return None
    meta = _parse_tlvs(d[52:])
    return {
        "qr": d,
        "dsk": format_dsk(dsk_raw),
        "pin": pin_from_dsk(dsk_raw),
        "meta": meta,
        "version": version,
        "smart_start": version == VERSION_SMART_START,
        "requested_security_classes": _parse_requested_security_classes(d[9:12]),
    }


def extract_qr_string(text: str) -> str:
    d = _digits_only(text)
    if not d.startswith("90"):
        return ""
    best = ""
    # From the 52-digit minimum (no TLVs), so a short QR followed by other digits in the
    # same text (e.g. "… PIN 12345") is still found.
    for end in range(52, min(len(d), 200) + 1):
        trial = d[:end]
        if parse_qr_digits(trial):
            best = trial
    if best:
        return best
    parsed = parse_qr_digits(d)
    return parsed["qr"] if parsed else ""


def has_scannable_qr(qr_payload: str | None) -> bool:
    # extract_qr_string only ever returns non-empty when it found a subset that
    # parse_qr_digits fully validated (checksum + DSK) — no extra length threshold
    # needed, and a hardcoded 90 wrongly rejected valid QR codes with a short or
    # missing TLV tail (the spec's actual minimum is 52: see parse_qr_digits).
    return bool(extract_qr_string(qr_payload or ""))


def qr_encode_payload(qr_payload: str | None) -> str | None:
    extracted = extract_qr_string(qr_payload or "")
    return extracted or None


def normalize_fields(manual_code: str = "", qr_payload: str = "") -> dict[str, Any]:
    qr_in = (qr_payload or "").strip()
    qr_extracted = extract_qr_string(qr_in) if qr_in else ""
    parsed = parse_qr_digits(qr_extracted) if qr_extracted else None

    dsk_digits = ""
    if parsed:
        dsk_digits = _digits_only(parsed["dsk"])
    elif is_valid_dsk_formatted(manual_code):
        dsk_digits = _digits_only(manual_code)
    else:
        m = _digits_only(manual_code)
        if len(m) == 40:
            dsk_digits = m

    return {
        "manual_code": format_dsk(dsk_digits) if dsk_digits else (manual_code or "").strip(),
        "qr_payload": parsed["qr"] if parsed else qr_extracted,
        "zwave_pin": pin_from_dsk(dsk_digits or manual_code),
        "zwave_meta": parsed["meta"] if parsed else {},
    }


def code_protocol(data: dict[str, Any]) -> str:
    ct = str(data.get("code_type") or "matter").strip().lower()
    if ct == "zwave":
        return "zwave"
    if ct == "homekit":
        return "homekit"
    if has_scannable_qr(str(data.get("qr_payload") or "")):
        return "zwave"
    qr = str(data.get("qr_payload") or "").strip().upper()
    if qr.startswith("X-HM://"):
        return "homekit"
    return "matter"


def meta_summary(meta: dict[str, Any]) -> str:
    if not meta.get("manufacturer_id"):
        return ""
    parts = [f"Mfg {meta['manufacturer_id']}"]
    if meta.get("product_type") is not None and meta.get("product_id") is not None:
        parts.append(f"Type {meta['product_type']} / ID {meta['product_id']}")
    return " · ".join(parts)
