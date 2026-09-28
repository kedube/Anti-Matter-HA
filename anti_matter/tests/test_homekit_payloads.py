"""HomeKit X-HM:// setup URIs: 27-bit pairing code, flags, category, legacy repair."""

from __future__ import annotations

import pytest

from homekit_payload import (
    HOMEKIT_CATEGORIES,
    compose_setup_uri,
    decode_fields_from_uri,
    decode_pairing_from_uri,
    normalize_fields,
    repair_legacy_pairing,
)

PLACEHOLDER_URI = "X-HM://0081YCYEP3QYT"  # the app's own placeholder, pairing 841-31-633


def test_decode_placeholder_uri():
    assert decode_pairing_from_uri(PLACEHOLDER_URI) == "84131633"
    fields = decode_fields_from_uri(PLACEHOLDER_URI)
    assert fields["homekit_flag"] == 2
    assert fields["setup_id"] == "3QYT"


@pytest.mark.parametrize("flag", [0, 1, 2, 4, 15])
@pytest.mark.parametrize("category", ["lightbulb", "thermostat", "doorLock", "bridge"])
def test_compose_decode_round_trip(flag, category):
    uri = compose_setup_uri(
        category_id=HOMEKIT_CATEGORIES[category], flag=flag, password="11122333", setup_id="AB12"
    )
    assert uri.endswith("AB12")
    assert decode_pairing_from_uri(uri) == "11122333"
    fields = decode_fields_from_uri(uri)
    assert fields["homekit_flag"] == flag
    assert fields["homekit_category"] == category
    assert fields["setup_id"] == "AB12"


def test_normalize_from_uri_and_from_digits():
    out = normalize_fields("", PLACEHOLDER_URI)
    assert out["manual_code"] == "84131633"
    assert out["qr_payload"] == PLACEHOLDER_URI
    typed = normalize_fields("841-31-633", "", homekit_category="lightbulb", setup_id="3QYT")
    assert decode_pairing_from_uri(str(typed["qr_payload"])) == "84131633"


def test_repair_legacy_pairing():
    # The pre-fix decoder masked 31 bits, leaking the flag bits into the code.
    assert repair_legacy_pairing("52567089", PLACEHOLDER_URI) == "84131633"
    assert repair_legacy_pairing("525-67-089", PLACEHOLDER_URI) == "84131633"


def test_repair_leaves_correct_and_hand_typed_codes_alone():
    assert repair_legacy_pairing("84131633", PLACEHOLDER_URI) is None
    assert repair_legacy_pairing("11122333", PLACEHOLDER_URI) is None
    assert repair_legacy_pairing("52567089", "") is None
    flag0 = compose_setup_uri(category_id=5, flag=0, password="12345678")
    assert repair_legacy_pairing("12345678", flag0) is None  # no flag bits, nothing leaked
