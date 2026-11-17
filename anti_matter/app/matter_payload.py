"""Matter setup payload helpers (QR must use canonical MT:… string)."""

from __future__ import annotations

import re

from matter_setup_payload import normalize_scanned_or_entered


def manual_digits(value: str) -> str:
    d = re.sub(r"[^0-9]", "", value or "")  # ASCII only, like the browser parser
    return d if len(d) == 11 else ""


def format_manual11(digits: str) -> str:
    if len(digits) != 11:
        return digits
    return f"{digits[0:4]}-{digits[4:7]}-{digits[7:11]}"


def display_manual(manual_code: str) -> str:
    from matter_setup_payload import format_manual_display

    manual = (manual_code or "").strip()
    if not manual:
        return ""
    digits = manual_digits(manual)
    if digits:
        return format_manual_display(digits)
    return manual


def qr_encode_payload(qr_payload: str, manual_code: str = "") -> str | None:
    qr = (qr_payload or "").strip()
    if qr and qr.upper().startswith("MT:"):
        # Base38 is upper-case only; older vaults may hold a hand-typed lower-case copy.
        return qr.upper()
    return None


def normalize_fields(manual_code: str, qr_payload: str) -> dict[str, str]:
    return normalize_scanned_or_entered(manual_code, qr_payload)
