"""Matter setup payload parsing: QR (incl. TLV and multi-device), manual codes, Verhoeff."""

from __future__ import annotations

import pytest

from matter_payload import normalize_fields, qr_encode_payload
from matter_setup_payload import (
    CommissioningFlow,
    ParsedSetupPayload,
    format_manual_display,
    generate_manual_code,
    generate_qr_payload,
    parse_manual_payload,
    parse_qr_payload,
)

# connectedhomeip test device: passcode 20202021, discriminator 3840, VID 0xFFF1.
CANONICAL_QR = "MT:Y.K9042C00KA0648G00"
TLV_QR = "MT:-24J0AFN00KA064IJ3P0C--50NSXK12CYS0"  # same device + serial-number TLV
CHIP_MANUAL = "34970112332"


def _payload(pin: int, disc: int, *, flow=CommissioningFlow.STANDARD, vid=0x1234, pid=0x5678):
    return ParsedSetupPayload(
        pincode=pin,
        short_discriminator=disc >> 8,
        long_discriminator=disc,
        discovery=4,
        flow=flow,
        vid=vid,
        pid=pid,
    )


def test_canonical_qr_decodes():
    p = parse_qr_payload(CANONICAL_QR)
    assert (p.pincode, p.long_discriminator, p.short_discriminator) == (20202021, 3840, 15)
    assert (p.vid, p.pid, p.discovery) == (0xFFF1, 0x8000, 2)
    assert generate_manual_code(p) == CHIP_MANUAL
    assert normalize_fields("", CANONICAL_QR) == {
        "manual_code": "3497-011-2332",
        "qr_payload": CANONICAL_QR,
    }


def test_tlv_qr_decodes_base_payload_and_is_kept_verbatim():
    p = parse_qr_payload(TLV_QR)
    assert (p.pincode, p.long_discriminator) == (20202021, 3840)
    out = normalize_fields("", TLV_QR)
    assert out["manual_code"] == "3497-011-2332"
    # Regenerating would drop the TLV bytes and print a QR that no longer matches the label.
    assert out["qr_payload"] == TLV_QR


def test_lowercase_prefix_is_canonicalized_but_body_kept():
    out = normalize_fields("", "mt:" + TLV_QR[3:])
    assert out["qr_payload"] == TLV_QR


def test_multi_device_qr_parses_first_and_is_kept_verbatim():
    first = generate_qr_payload(_payload(12345679, 1000))
    second = generate_qr_payload(_payload(23456781, 2000))
    multi = first + "*" + second[3:]
    p = parse_qr_payload(multi)
    assert (p.pincode, p.long_discriminator) == (12345679, 1000)
    out = normalize_fields("", multi)
    assert out["qr_payload"] == multi
    assert out["manual_code"] == format_manual_display(generate_manual_code(p))
    assert qr_encode_payload(out["qr_payload"]) == multi


def test_qr_round_trip():
    src = _payload(61234521, 2890, vid=0x1349, pid=0x0101)
    p = parse_qr_payload(generate_qr_payload(src))
    assert (p.pincode, p.long_discriminator, p.vid, p.pid) == (61234521, 2890, 0x1349, 0x0101)


def test_truncated_qr_rejected():
    with pytest.raises(ValueError):
        parse_qr_payload("MT:Y.K9042C")


def test_manual_11_digits():
    p = parse_manual_payload("3497-011-2332")
    assert (p.pincode, p.short_discriminator, p.long_discriminator) == (20202021, 15, None)
    assert p.vid is None and p.flow == CommissioningFlow.STANDARD
    assert normalize_fields("34970112332", "") == {"manual_code": "3497-011-2332", "qr_payload": ""}


def test_manual_21_digits_carries_vid_pid():
    src = _payload(20202021, 3840, flow=CommissioningFlow.USER_INTENT, vid=0xFFF1, pid=0x8000)
    manual = generate_manual_code(src)
    assert len(manual) == 21
    p = parse_manual_payload(manual)
    assert (p.pincode, p.short_discriminator, p.vid, p.pid) == (20202021, 15, 0xFFF1, 0x8000)
    assert normalize_fields(manual, "")["manual_code"] == "74970-11233-65521-32768-7"


@pytest.mark.parametrize("bad", ["34970112333", "749701123365521327680"])
def test_verhoeff_failure(bad):
    with pytest.raises(ValueError, match="check digit"):
        parse_manual_payload(bad)


def test_verhoeff_failure_is_kept_unparsed():
    # A mistyped code is stored as typed (formatted), never "corrected" into another code.
    assert normalize_fields("34970112333", "") == {"manual_code": "3497-011-2333", "qr_payload": ""}


@pytest.mark.parametrize("bad", ["1234567890", "8497011233200000000000", "94970112332"])
def test_manual_wrong_length_or_version(bad):
    with pytest.raises(ValueError):
        parse_manual_payload(bad)
