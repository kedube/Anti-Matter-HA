"""
Matter commissioning setup payload parse/generate.

Parity with connectedhomeip/src/setup_payload/python/SetupPayload.py (Apache-2.0).
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import IntEnum

# --- Base38 (connectedhomeip Base38.py) ---

_BASE38_CODES = [
    "0", "1", "2", "3", "4", "5", "6", "7", "8", "9",
    "A", "B", "C", "D", "E", "F", "G", "H", "I", "J",
    "K", "L", "M", "N", "O", "P", "Q", "R", "S", "T",
    "U", "V", "W", "X", "Y", "Z", "-", ".",
]
_BASE38_RADIX = len(_BASE38_CODES)
_BASE38_CHARS_NEEDED = (2, 4, 5)
_MAX_BYTES_CHUNK = 3


def _base38_encode(data: bytes) -> str:
    qrcode = ""
    total = len(data)
    i = 0
    while i < total:
        if (i + _MAX_BYTES_CHUNK) > total:
            bytes_in_chunk = total - i
        else:
            bytes_in_chunk = _MAX_BYTES_CHUNK
        value = 0
        for j in range(i, i + bytes_in_chunk):
            value += data[j] << (8 * (j - i))
        chars_needed = _BASE38_CHARS_NEEDED[bytes_in_chunk - 1]
        while chars_needed > 0:
            qrcode += _BASE38_CODES[int(value % _BASE38_RADIX)]
            value = int(value / _BASE38_RADIX)
            chars_needed -= 1
        i += bytes_in_chunk
    return qrcode


def _base38_decode(qrcode: str) -> bytes:
    total_chars = len(qrcode)
    decoded = bytearray()
    i = 0
    while i < total_chars:
        if (i + _BASE38_CHARS_NEEDED[2]) > total_chars:
            chars_in_chunk = total_chars - i
        else:
            chars_in_chunk = _BASE38_CHARS_NEEDED[2]
        value = 0
        for j in range(i + chars_in_chunk - 1, i - 1, -1):
            value = value * _BASE38_RADIX + _BASE38_CODES.index(qrcode[j])
        bytes_in_chunk = _BASE38_CHARS_NEEDED.index(chars_in_chunk) + 1
        for _ in range(bytes_in_chunk):
            decoded.append(value & 0xFF)
            value >>= 8
        i += chars_in_chunk
    return bytes(decoded)


# --- Verhoeff check digit ---

_VERHOEFF_D = (
    (0, 1, 2, 3, 4, 5, 6, 7, 8, 9),
    (1, 2, 3, 4, 0, 6, 7, 8, 9, 5),
    (2, 3, 4, 0, 1, 7, 8, 9, 5, 6),
    (3, 4, 0, 1, 2, 8, 9, 5, 6, 7),
    (4, 0, 1, 2, 3, 9, 5, 6, 7, 8),
    (5, 9, 8, 7, 6, 0, 4, 3, 2, 1),
    (6, 5, 9, 8, 7, 1, 0, 4, 3, 2),
    (7, 6, 5, 9, 8, 2, 1, 0, 4, 3),
    (8, 7, 6, 5, 9, 3, 2, 1, 0, 4),
    (9, 8, 7, 6, 5, 4, 3, 2, 1, 0),
)
_VERHOEFF_P = (
    (0, 1, 2, 3, 4, 5, 6, 7, 8, 9),
    (1, 5, 7, 6, 2, 8, 3, 0, 9, 4),
    (5, 8, 0, 3, 7, 9, 6, 1, 4, 2),
    (8, 9, 1, 6, 0, 4, 3, 5, 2, 7),
    (9, 4, 5, 3, 1, 2, 6, 8, 7, 0),
    (4, 2, 8, 6, 5, 7, 3, 9, 0, 1),
    (2, 7, 9, 3, 8, 0, 6, 4, 1, 5),
    (7, 0, 4, 6, 9, 1, 3, 2, 5, 8),
)
_VERHOEFF_INV = (0, 4, 3, 2, 1, 5, 6, 7, 8, 9)


def _verhoeff_check_digit(payload: str) -> str:
    c = 0
    for i, ch in enumerate(reversed(payload)):
        c = _VERHOEFF_D[c][_VERHOEFF_P[(i + 1) % 8][int(ch)]]
    return str(_VERHOEFF_INV[c])


# --- Bit packing (MSB-first fields, matching construct BitStruct order) ---

def _bytes_to_bitstring(data: bytes, bit_count: int) -> str:
    bits = "".join(f"{b:08b}" for b in data)
    return bits[:bit_count]


def _bitstring_to_bytes(bits: str) -> bytes:
    padded = bits + "0" * ((8 - len(bits) % 8) % 8)
    out = bytearray()
    for i in range(0, len(padded), 8):
        out.append(int(padded[i : i + 8], 2))
    return bytes(out)


def _read_fields(data: bytes, spec: list[tuple[str, int]]) -> dict[str, int]:
    bit_count = sum(w for _, w in spec)
    bits = _bytes_to_bitstring(data, bit_count)
    pos = 0
    out: dict[str, int] = {}
    for name, width in spec:
        chunk = bits[pos : pos + width]
        pos += width
        out[name] = int(chunk, 2) if chunk else 0
    return out


def _write_fields(values: dict[str, int], spec: list[tuple[str, int]]) -> bytes:
    bits = ""
    for name, width in spec:
        v = values.get(name, 0)
        bits += format(v & ((1 << width) - 1), f"0{width}b")
    return _bitstring_to_bytes(bits)


_QR_SPEC = [
    ("padding", 4),
    ("pincode", 27),
    ("discriminator", 12),
    ("discovery", 8),
    ("flow", 2),
    ("pid", 16),
    ("vid", 16),
    ("version", 3),
]

_MANUAL_SPEC = [
    ("version", 1),
    ("vid_pid_present", 1),
    ("discriminator", 4),
    ("pincode_lsb", 14),
    ("pincode_msb", 13),
    ("vid", 16),
    ("pid", 16),
    ("padding", 7),
]


class CommissioningFlow(IntEnum):
    STANDARD = 0
    USER_INTENT = 1
    CUSTOM = 2


@dataclass
class ParsedSetupPayload:
    pincode: int
    short_discriminator: int
    long_discriminator: int | None
    discovery: int | None
    flow: CommissioningFlow
    vid: int | None
    pid: int | None

    @property
    def has_full_qr_fields(self) -> bool:
        return self.long_discriminator is not None


def parse_qr_payload(payload: str) -> ParsedSetupPayload:
    raw = payload.strip()
    if not raw.upper().startswith("MT:"):
        raise ValueError("Not an MT: payload")
    # "MT:<p1>*<p2>..." bundles several devices; parse the first. Bytes past the
    # fixed 11-byte (88-bit) base payload are optional TLV data (serial number etc.),
    # so only the base bytes are bit-reversed and read.
    encoded = raw[3:].split("*", 1)[0]
    data = _base38_decode(encoded)
    if len(data) < 11:
        raise ValueError("MT: payload too short")
    decoded = data[:11][::-1]
    fields = _read_fields(decoded, _QR_SPEC)
    disc = fields["discriminator"]
    flow_val = fields["flow"]
    return ParsedSetupPayload(
        pincode=fields["pincode"],
        short_discriminator=disc >> 8,
        long_discriminator=disc,
        discovery=fields["discovery"],
        flow=CommissioningFlow(flow_val) if flow_val in (0, 1, 2) else CommissioningFlow.STANDARD,
        vid=fields["vid"],
        pid=fields["pid"],
    )


def parse_manual_payload(payload: str) -> ParsedSetupPayload:
    digits = "".join(c for c in payload if c.isdigit())
    if len(digits) not in (11, 21):
        raise ValueError("Manual code must be 11 or 21 digits")
    if int(digits[0]) > 7:
        raise ValueError("Invalid manual code version digit")
    if _verhoeff_check_digit(digits[:-1]) != digits[-1]:
        raise ValueError("Manual code check digit mismatch")

    is_long = int(digits[0]) & (1 << 2) != 0
    bit_parts = [
        (4, int(digits[0])),
        (16, int(digits[1:6])),
        (13, int(digits[6:10])),
        (16, int(digits[10:15]) if is_long else 0),
        (16, int(digits[15:20]) if is_long else 0),
        (7, 0),
    ]
    bits = ""
    for width, value in bit_parts:
        bits += format(value, f"0{width}b")
    data = _bitstring_to_bytes(bits)
    fields = _read_fields(data, _MANUAL_SPEC)
    pincode = (fields["pincode_msb"] << 14) | fields["pincode_lsb"]
    vid_pid = fields["vid_pid_present"] != 0
    return ParsedSetupPayload(
        pincode=pincode,
        short_discriminator=fields["discriminator"],
        long_discriminator=None,
        discovery=None,
        flow=CommissioningFlow.CUSTOM if vid_pid else CommissioningFlow.STANDARD,
        vid=fields["vid"] if vid_pid else None,
        pid=fields["pid"] if vid_pid else None,
    )


def parse_payload(payload: str) -> ParsedSetupPayload:
    raw = payload.strip()
    if raw.upper().startswith("MT:"):
        return parse_qr_payload(raw)
    return parse_manual_payload(raw)


def generate_qr_payload(parsed: ParsedSetupPayload) -> str:
    if parsed.long_discriminator is None:
        raise ValueError("Long discriminator required for QR")
    values = {
        "padding": 0,
        "pincode": parsed.pincode,
        "discriminator": parsed.long_discriminator,
        "discovery": parsed.discovery if parsed.discovery is not None else 4,
        "flow": int(parsed.flow),
        "pid": parsed.pid or 0,
        "vid": parsed.vid or 0,
        "version": 0,
    }
    packed = _write_fields(values, _QR_SPEC)
    return f"MT:{_base38_encode(packed[::-1])}"


def generate_manual_code(parsed: ParsedSetupPayload) -> str:
    vid_pid_present = 0 if parsed.flow == CommissioningFlow.STANDARD else 1
    vid = parsed.vid or 0 if vid_pid_present else 0
    pid = parsed.pid or 0 if vid_pid_present else 0
    values = {
        "version": 0,
        "vid_pid_present": vid_pid_present,
        "discriminator": parsed.short_discriminator,
        "pincode_lsb": parsed.pincode & 0x3FFF,
        "pincode_msb": parsed.pincode >> 14,
        "vid": vid,
        "pid": pid,
        "padding": 0,
    }
    data = _write_fields(values, _MANUAL_SPEC)
    bits = _bytes_to_bitstring(data, sum(w for _, w in _MANUAL_SPEC))
    chunk1 = str(int(bits[0:4], 2))
    chunk2 = str(int(bits[4:20], 2)).zfill(5)
    chunk3 = str(int(bits[20:33], 2)).zfill(4)
    chunk4 = str(vid).zfill(5) if vid_pid_present else ""
    chunk5 = str(pid).zfill(5) if vid_pid_present else ""
    payload = f"{chunk1}{chunk2}{chunk3}{chunk4}{chunk5}"
    return payload + _verhoeff_check_digit(payload)


def format_manual_display(manual: str) -> str:
    digits = "".join(c for c in manual if c.isdigit())
    if len(digits) == 11:
        return f"{digits[0:4]}-{digits[4:7]}-{digits[7:11]}"
    if len(digits) == 21:
        return (
            f"{digits[0:5]}-{digits[5:10]}-{digits[10:15]}-"
            f"{digits[15:20]}-{digits[20:21]}"
        )
    return manual.strip()


def normalize_scanned_or_entered(
    manual_code: str = "",
    qr_payload: str = "",
) -> dict[str, str]:
    """Parse and canonicalize Matter fields for storage and scannable QR cards."""
    manual_in = (manual_code or "").strip()
    qr_in = (qr_payload or "").strip()

    parsed: ParsedSetupPayload | None = None
    if qr_in.upper().startswith("MT:"):
        try:
            parsed = parse_qr_payload(qr_in)
        except ValueError:
            parsed = None
    if parsed is None:
        digits = "".join(c for c in manual_in if c.isdigit())
        if len(digits) in (11, 21):
            try:
                parsed = parse_manual_payload(digits)
            except ValueError:
                parsed = None

    if parsed is None:
        qr = qr_in
        if qr and qr.upper().startswith("MT:"):
            idx = qr.upper().find("MT:")
            qr = qr[idx:]
        else:
            qr = ""
        digits = "".join(c for c in manual_in if c.isdigit())
        manual = format_manual_display(digits) if len(digits) == 11 else manual_in
        return {"manual_code": manual, "qr_payload": qr}

    manual_raw = generate_manual_code(parsed)
    manual_display = format_manual_display(manual_raw)
    if parsed.has_full_qr_fields and qr_in.upper().startswith("MT:"):
        # Keep the scanned string verbatim: regenerating it would drop TLV data and
        # any extra "*" device payloads, producing a QR that no longer matches the label.
        qr_out = "MT:" + qr_in[3:]
    else:
        try:
            qr_out = generate_qr_payload(parsed)
        except ValueError:
            qr_out = qr_in if qr_in.upper().startswith("MT:") else ""

    return {"manual_code": manual_display, "qr_payload": qr_out}
