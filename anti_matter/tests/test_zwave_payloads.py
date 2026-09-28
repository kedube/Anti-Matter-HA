"""Z-Wave SmartStart QR: checksum, DSK, requested keys and TLV parsing."""

from __future__ import annotations

from conftest import DSK_A, build_zwave_qr
from zwave_payload import (
    checksum_valid,
    extract_qr_string,
    format_dsk,
    normalize_fields,
    parse_qr_digits,
)

DSK_A_DIGITS = "".join(f"{g:05d}" for g in DSK_A)


def test_parse_valid_smartstart_qr():
    qr = build_zwave_qr(DSK_A, manufacturer=634, product_type=2, product_id=72)
    assert checksum_valid(qr)
    parsed = parse_qr_digits(qr)
    assert parsed is not None
    assert parsed["dsk"] == format_dsk(DSK_A_DIGITS)
    assert parsed["dsk"] == "50285-12045-44321-09876-33120-05421-61234-07788"
    assert parsed["pin"] == "50285"
    assert parsed["smart_start"] is True
    meta = parsed["meta"]
    assert (meta["manufacturer_id"], meta["product_type"], meta["product_id"]) == (634, 2, 72)
    assert meta["application_version"] == "1.2"
    assert (meta["generic_device_class"], meta["specific_device_class"]) == (0x10, 0x01)
    assert meta["installer_icon_type"] == 1792
    assert meta["supported_protocols"] == {"zwave": True, "zwave_long_range": False}
    keys = parsed["requested_security_classes"]
    assert keys == {
        "s2_unauthenticated": True,
        "s2_authenticated": True,
        "s2_access_control": True,
        "s0_legacy": True,
    }


def test_bad_checksum_rejected():
    qr = build_zwave_qr(DSK_A)
    bad = qr[:4] + f"{(int(qr[4:9]) + 1) % 100000:05d}" + qr[9:]
    assert not checksum_valid(bad)
    assert parse_qr_digits(bad) is None
    assert extract_qr_string(bad) == ""


def test_dsk_group_out_of_range_rejected():
    qr = build_zwave_qr([70000] + DSK_A[1:])
    assert parse_qr_digits(qr) is None


def test_extract_ignores_surrounding_text():
    qr = build_zwave_qr(DSK_A)
    assert extract_qr_string(f"  {qr}\n") == qr


def test_normalize_fields_from_qr_and_bare_dsk():
    qr = build_zwave_qr(DSK_A)
    out = normalize_fields("", qr)
    assert out["qr_payload"] == qr
    assert out["manual_code"] == format_dsk(DSK_A_DIGITS)
    assert out["zwave_pin"] == "50285"
    bare = normalize_fields(DSK_A_DIGITS, "")
    assert bare["manual_code"] == format_dsk(DSK_A_DIGITS)
    assert bare["qr_payload"] == ""
