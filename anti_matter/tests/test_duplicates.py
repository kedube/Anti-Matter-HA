"""Duplicate detection rules (_find_duplicate_code) per protocol, and the API around them."""

from __future__ import annotations

import pytest

from conftest import DSK_A, DSK_B, build_zwave_qr
from homekit_payload import compose_setup_uri
from matter_setup_payload import (
    CommissioningFlow,
    ParsedSetupPayload,
    generate_manual_code,
    generate_qr_payload,
)

CANONICAL_QR = "MT:Y.K9042C00KA0648G00"  # passcode 20202021, discriminator 3840
TLV_QR = "MT:-24J0AFN00KA064IJ3P0C--50NSXK12CYS0"
HK_URI = "X-HM://0081YCYEP3QYT"  # pairing 84131633
DSK_A_DIGITS = "".join(f"{g:05d}" for g in DSK_A)


def _matter(pin: int, disc: int, *, flow=CommissioningFlow.STANDARD, vid=0xFFF1, pid=0x8000):
    return ParsedSetupPayload(
        pincode=pin, short_discriminator=disc >> 8, long_discriminator=disc,
        discovery=4, flow=flow, vid=vid, pid=pid,
    )


def _qr(pin: int, disc: int) -> str:
    return generate_qr_payload(_matter(pin, disc))


def _manual21(pin: int, disc: int) -> str:
    return generate_manual_code(_matter(pin, disc, flow=CommissioningFlow.USER_INTENT))


@pytest.fixture
def dup(app_module):
    """dup(existing_codes, **candidate) -> matched existing code name or None.

    Existing codes are dicts; ``stored=True`` (default) normalizes them the way the API
    stores them, ``stored=False`` keeps raw fields (legacy/imported vault rows).
    """

    def make(fields: dict, stored: bool = True):
        code = app_module.MatterCode(name=fields.get("name", "x"), **{
            k: v for k, v in fields.items() if k != "name"
        })
        if stored:
            app_module._apply_code_fields(code)
        return code

    def run(existing: list[dict], stored: bool = True, raw_candidate: bool = False, **candidate):
        vault = app_module.Vault(codes=[make(e, stored) for e in existing])
        cand = candidate if raw_candidate else make(candidate).model_dump(mode="json")
        found = app_module._find_duplicate_code(vault, cand)
        return found.name if found else None

    return run


# --- Matter ---


def test_matter_21_digit_manual_matches_itself(dup):
    m = _manual21(20202021, 3840)
    assert dup([{"name": "a", "manual_code": m}], manual_code=m) == "a"


def test_matter_21_digit_manual_matches_qr_of_same_device(dup):
    existing = [{"name": "qr", "qr_payload": CANONICAL_QR}]
    assert dup(existing, manual_code=_manual21(20202021, 3840)) == "qr"


def test_matter_qr_matches_21_digit_manual_only_code(dup):
    existing = [{"name": "manual", "manual_code": _manual21(20202021, 3840)}]
    assert dup(existing, qr_payload=TLV_QR) == "manual"


def test_matter_11_digit_manual_matches_tlv_qr(dup):
    assert dup([{"name": "tlv", "qr_payload": TLV_QR}], manual_code="3497-011-2332") == "tlv"


def test_matter_short_discriminator_is_top_4_bits(dup):
    pin = 12345679
    existing = [{"name": "manual", "manual_code": _manual21(pin, 0xF00)}]  # short = 0xF
    assert dup(existing, qr_payload=_qr(pin, 0xF0F)) == "manual"  # 0xF0F >> 8 == 0xF
    assert dup(existing, qr_payload=_qr(pin, 0x0FF)) is None  # low bits match, top don't


def test_matter_long_discriminators_compared_when_both_known(app_module):
    from matter_setup_payload import parse_qr_payload

    a = parse_qr_payload(_qr(12345679, 0xF01))
    b = parse_qr_payload(_qr(12345679, 0xF02))
    assert a.short_discriminator == b.short_discriminator
    assert not app_module._same_matter_device(a, b)
    assert app_module._same_matter_device(a, parse_qr_payload(_qr(12345679, 0xF01)))


def test_matter_different_passcode_is_not_duplicate(dup):
    existing = [{"name": "a", "qr_payload": _qr(12345679, 1000)}]
    assert dup(existing, qr_payload=_qr(23456781, 1000)) is None
    assert dup(existing, manual_code=_manual21(23456781, 1000)) is None


def test_matter_multi_device_qr_matches_any_device(dup):
    multi = _qr(12345679, 1000) + "*" + _qr(23456781, 2000)[3:]
    existing = [{"name": "bundle", "qr_payload": multi}]
    assert dup(existing, qr_payload=_qr(23456781, 2000)) == "bundle"
    assert dup(existing, manual_code=_manual21(23456781, 2000)) == "bundle"


def test_matter_qr_key_is_case_insensitive(dup):
    assert dup([{"name": "a", "qr_payload": CANONICAL_QR}], raw_candidate=True,
               code_type="matter", qr_payload=CANONICAL_QR.lower()) == "a"


# --- HomeKit ---


def test_homekit_typed_code_matches_uri(dup):
    # Typed with a different category and no setup ID: the synthesized URI differs from
    # the device's, but the pairing code is the same device.
    existing = [{"name": "typed", "code_type": "homekit", "manual_code": "841-31-633",
                 "homekit_category": "lightbulb"}]
    assert dup(existing, raw_candidate=True, code_type="homekit", qr_payload=HK_URI) == "typed"


def test_homekit_uri_only_code_matches_typed_code(dup):
    existing = [{"name": "scanned", "code_type": "homekit", "qr_payload": HK_URI}]
    assert dup(existing, stored=False, raw_candidate=True, code_type="homekit",
               manual_code="84131633") == "scanned"


def test_homekit_different_code_is_not_duplicate(dup):
    other_uri = compose_setup_uri(category_id=5, password="11122333", setup_id="AB12")
    existing = [{"name": "a", "code_type": "homekit", "qr_payload": HK_URI}]
    assert dup(existing, code_type="homekit", qr_payload=other_uri) is None
    assert dup(existing, code_type="homekit", manual_code="111-22-333") is None


# --- Z-Wave ---


def test_zwave_bare_dsk_matches_smartstart_qr(dup):
    existing = [{"name": "qr", "code_type": "zwave", "qr_payload": build_zwave_qr(DSK_A)}]
    assert dup(existing, stored=False, raw_candidate=True, code_type="zwave",
               manual_code=DSK_A_DIGITS) == "qr"
    assert dup(existing, code_type="zwave", manual_code="-".join(f"{g:05d}" for g in DSK_A)) == "qr"


def test_zwave_smartstart_qr_matches_bare_dsk(dup):
    existing = [{"name": "dsk", "code_type": "zwave", "manual_code": DSK_A_DIGITS}]
    assert dup(existing, code_type="zwave", qr_payload=build_zwave_qr(DSK_A)) == "dsk"


def test_zwave_different_dsk_is_not_duplicate(dup):
    existing = [{"name": "a", "code_type": "zwave", "qr_payload": build_zwave_qr(DSK_A)}]
    assert dup(existing, code_type="zwave", qr_payload=build_zwave_qr(DSK_B)) is None


# --- Other ---


def test_other_case_and_whitespace_insensitive(dup):
    existing = [{"name": "cam", "code_type": "other", "manual_code": "WZ-3301-CAM",
                 "qr_payload": "Z:00158D0004A1B2C3$I:83FED340  7A93"}]
    assert dup(existing, code_type="other", manual_code="  wz-3301-cam ") == "cam"
    assert dup(existing, code_type="other", qr_payload="z:00158d0004a1b2c3$i:83fed340\n7a93") == "cam"


def test_other_is_still_exact_otherwise(dup):
    existing = [{"name": "cam", "code_type": "other", "manual_code": "WZ-3301-CAM"}]
    assert dup(existing, code_type="other", manual_code="WZ3301CAM") is None


def test_protocols_never_cross_match(dup):
    existing = [{"name": "other", "code_type": "other", "manual_code": "3497-011-2332"}]
    assert dup(existing, manual_code="3497-011-2332") is None


# --- API ---


def test_create_duplicate_returns_coded_409(client):
    first = client.post("/api/codes", json={"name": "Lamp", "qr_payload": CANONICAL_QR})
    assert first.status_code == 201
    resp = client.post("/api/codes", json={"name": "Again", "manual_code": _manual21(20202021, 3840)})
    assert resp.status_code == 409
    detail = resp.json()["detail"]
    assert detail["error"] == "duplicate"
    assert detail["existing"] == {"id": first.json()["id"], "name": "Lamp"}
    assert "Lamp" in detail["message"]


def test_check_duplicate_endpoint(client):
    created = client.post("/api/codes", json={
        "name": "Switch", "code_type": "zwave", "qr_payload": build_zwave_qr(DSK_A),
    }).json()
    body = {"code_type": "zwave", "manual_code": DSK_A_DIGITS}
    hit = client.post("/api/codes/check-duplicate", json=body).json()["duplicate"]
    assert hit["error"] == "duplicate" and hit["existing"]["id"] == created["id"]
    body["exclude_id"] = created["id"]
    assert client.post("/api/codes/check-duplicate", json=body).json() == {"duplicate": None}


def test_update_to_duplicate_is_rejected(client):
    client.post("/api/codes", json={"name": "A", "code_type": "homekit", "qr_payload": HK_URI})
    b = client.post("/api/codes", json={"name": "B", "code_type": "homekit",
                                        "manual_code": "111-22-333"}).json()
    resp = client.put(f"/api/codes/{b['id']}", json={"manual_code": "841-31-633"})
    assert resp.status_code == 409
    assert resp.json()["detail"]["error"] == "duplicate"
