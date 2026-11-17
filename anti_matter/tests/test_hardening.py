"""Regressions for the review fixes: vault integrity, merge import, ingress-only access,
log redaction, backup scheduling, HA proxy errors and parser edge cases."""

from __future__ import annotations

import asyncio
import hashlib
import importlib
import json
import time
from datetime import datetime

import httpx
import pytest

from conftest import DSK_A, build_zwave_qr

MATTER = "3497-011-2332"  # valid, Verhoeff-checked 11-digit manual code


@pytest.fixture
def lenient(app_module):
    """Client that returns 500s as responses instead of raising."""
    from fastapi.testclient import TestClient

    return TestClient(app_module.app, raise_server_exceptions=False)


def _new_code(client, **fields) -> dict:
    resp = client.post("/api/codes", json={"name": "Lamp", "manual_code": MATTER, **fields})
    assert resp.status_code == 201, resp.text
    return resp.json()


# --- explicit nulls never reach the vault file ---------------------------------------------


@pytest.mark.parametrize("field", ["name", "code_type", "notes", "in_use", "homekit_flag"])
def test_null_code_field_is_ignored(lenient, app_module, field):
    code = _new_code(lenient)
    assert lenient.put(f"/api/codes/{code['id']}", json={field: None}).status_code == 200
    assert lenient.get("/api/vault").status_code == 200
    import main

    importlib.reload(main)  # add-on restart: the vault is validated at import
    assert main.storage.load().codes[0].name == "Lamp"


@pytest.mark.parametrize("field", ["name", "sort_order", "color", "icon"])
def test_null_category_field_is_ignored(lenient, field):
    cat = lenient.post("/api/categories", json={"name": "Lights"}).json()
    assert lenient.put(f"/api/categories/{cat['id']}", json={field: None}).status_code == 200
    assert lenient.get("/api/vault").status_code == 200
    assert lenient.post("/api/categories", json={"name": "Other"}).status_code == 201  # sorts


# --- merge import ------------------------------------------------------------------------


def test_merge_import_takes_newer_edit(client):
    _new_code(client, name="Old")
    export = json.loads(client.get("/api/export").text)
    export["codes"][0]["name"] = "New"
    export["codes"][0]["updated_at"] = "2099-01-01T00:00:00Z"
    assert client.post("/api/import", json={"data": json.dumps(export), "merge": True}).status_code == 200
    assert [c["name"] for c in client.get("/api/vault").json()["codes"]] == ["New"]


def test_merge_import_keeps_local_edit_over_older_copy(client):
    code = _new_code(client, name="Old")
    stale = json.loads(client.get("/api/export").text)
    stale["codes"][0]["updated_at"] = "2000-01-01T00:00:00Z"
    cat = client.post("/api/categories", json={"name": "Lights"}).json()
    client.put(f"/api/codes/{code['id']}", json={"name": "Renamed"})
    stale["categories"] = [dict(cat, name="Old name")]  # categories have no timestamps: local wins
    client.post("/api/import", json={"data": json.dumps(stale), "merge": True})
    vault = client.get("/api/vault").json()
    assert [c["name"] for c in vault["codes"]] == ["Renamed"]
    assert [c["name"] for c in vault["categories"]] == ["Lights"]


def test_merge_import_does_not_resurrect_purged_code(client):
    code = _new_code(client, name="Gone")
    old_export = client.get("/api/export").text
    client.delete(f"/api/codes/{code['id']}")
    client.delete(f"/api/codes/{code['id']}/purge")
    client.post("/api/import", json={"data": old_export, "merge": True})
    assert client.get("/api/vault").json()["codes"] == []


def test_merge_import_leaves_trashed_code_in_trash(client):
    code = _new_code(client)
    export = client.get("/api/export").text
    client.delete(f"/api/codes/{code['id']}")
    client.post("/api/import", json={"data": export, "merge": True})
    assert client.get("/api/vault").json()["codes"] == []
    assert [c["id"] for c in client.get("/api/trash").json()["codes"]] == [code["id"]]


# --- delete / restore never lose the item on a failed write ------------------------------


def _disk_full(*_args):
    raise OSError(28, "No space left on device")


def test_delete_with_failing_trash_write_keeps_code(lenient, app_module, monkeypatch):
    code = _new_code(lenient)
    monkeypatch.setattr(app_module.storage, "save_bin", _disk_full)
    assert lenient.delete(f"/api/codes/{code['id']}").status_code == 500
    assert [c["id"] for c in lenient.get("/api/vault").json()["codes"]] == [code["id"]]


def test_restore_with_failing_trash_write_keeps_code(lenient, app_module, monkeypatch):
    code = _new_code(lenient)
    lenient.delete(f"/api/codes/{code['id']}")
    monkeypatch.setattr(app_module.storage, "save_bin", _disk_full)
    assert lenient.post(f"/api/codes/{code['id']}/restore").status_code == 500
    assert [c["id"] for c in lenient.get("/api/vault").json()["codes"]] == [code["id"]]


def test_category_delete_with_failing_trash_write_keeps_it(lenient, app_module, monkeypatch):
    cat = lenient.post("/api/categories", json={"name": "Lights"}).json()
    monkeypatch.setattr(app_module.storage, "save_bin", _disk_full)
    assert lenient.delete(f"/api/categories/{cat['id']}").status_code == 500
    assert [c["id"] for c in lenient.get("/api/vault").json()["categories"]] == [cat["id"]]


# --- long names --------------------------------------------------------------------------


def test_code_name_length_is_capped(client):
    resp = client.post("/api/codes", json={"name": "x" * 201, "manual_code": MATTER})
    assert resp.status_code == 422
    code = _new_code(client)
    assert client.put(f"/api/codes/{code['id']}", json={"name": "x" * 201}).status_code == 422


def test_huge_imported_name_renders_label_quickly(client, app_module):
    code = _new_code(client)
    vault = app_module.storage.load()
    vault.codes[0].name = "x" * 20_000  # an import is not length-checked
    app_module.storage.save(vault)
    started = time.perf_counter()
    assert client.get(f"/api/codes/{code['id']}/label.png").status_code == 200
    assert time.perf_counter() - started < 2.0


# --- HA proxy ----------------------------------------------------------------------------


def _ha_transport(monkeypatch, app_module, handler):
    seen: list[str] = []

    def recording(request: httpx.Request) -> httpx.Response:
        seen.append(request.url.raw_path.decode())
        return handler(request)

    real = httpx.AsyncClient
    monkeypatch.setattr(app_module.ha, "token", "t")
    monkeypatch.setattr(app_module.ha, "enabled", True)
    import ha_client

    monkeypatch.setattr(ha_client.httpx, "AsyncClient",
                        lambda **kw: real(transport=httpx.MockTransport(recording), **kw))
    return seen


@pytest.mark.parametrize("entity_id", [
    "../../../addons/self/info", "sensor.x/../../config", "sensor.x?y=1", "SENSOR.X", "",
])
def test_entity_id_cannot_leave_states_path(client, app_module, monkeypatch, entity_id):
    seen = _ha_transport(monkeypatch, app_module, lambda r: httpx.Response(200, json={}))
    resp = client.get("/api/ha/attribute", params={"entity_id": entity_id, "attribute": "x"})
    assert resp.status_code == 404
    assert seen == []


def test_attribute_lookup(client, app_module, monkeypatch):
    state = {"entity_id": "sensor.a", "state": "unavailable", "attributes": {"fw": None, "v": 0}}
    _ha_transport(monkeypatch, app_module, lambda r: httpx.Response(200, json=state))

    def get(attr):
        return client.get("/api/ha/attribute", params={"entity_id": "sensor.a", "attribute": attr})

    assert get("v").json()["value"] == 0
    assert get("fw").status_code == 200 and get("fw").json()["value"] is None  # null, not missing
    assert get("nope").json()["detail"]["error"] == "ha_attribute_not_found"


@pytest.mark.parametrize("status", [401, 500, 502])
def test_ha_errors_are_not_bare_500s(client, app_module, monkeypatch, status):
    _ha_transport(monkeypatch, app_module, lambda r: httpx.Response(status, text="nope"))
    assert client.get("/api/ha/entities").json() == []
    resp = client.get("/api/ha/attribute", params={"entity_id": "sensor.a", "attribute": "x"})
    assert resp.status_code == 404 and resp.json()["detail"]["error"] == "ha_attribute_not_found"


# --- ingress only ------------------------------------------------------------------------


@pytest.mark.parametrize("host, status", [("172.30.32.2", 200), ("172.30.33.7", 403), ("10.0.0.5", 403)])
def test_only_the_ingress_proxy_is_served(app_module, monkeypatch, host, status):
    monkeypatch.setattr(app_module, "INGRESS_ONLY", True)

    async def get():
        transport = httpx.ASGITransport(app=app_module.app, client=(host, 40000))
        async with httpx.AsyncClient(transport=transport, base_url="http://anti-matter:8099") as c:
            return await c.get("/api/export")

    resp = asyncio.run(get())
    assert resp.status_code == status
    if status == 403:
        assert resp.json()["detail"]["error"] == "forbidden"


def test_no_cors_headers(client):
    resp = client.get("/api/info", headers={"Origin": "https://evil.example"})
    assert "access-control-allow-origin" not in resp.headers


# --- log redaction -----------------------------------------------------------------------


@pytest.mark.parametrize("secret", [
    "50285-12045-44321-09876-33120-05421-61234-07788",  # Z-Wave DSK, formatted
    build_zwave_qr(DSK_A),                              # whole SmartStart QR (> 90 digits)
    "123-45-678",                                       # HomeKit, formatted
    "12345678",                                         # HomeKit, bare
    "34970-11233-20000-00000-0",                        # 21-digit Matter, formatted
    "3497-011-2332",                                    # 11-digit Matter, formatted
    "MT:Y.K9042C00KA0648G00*Y.K9042C00KA0648G01",       # multi-device Matter payload
])
def test_redact_hides_pairing_codes(app_module, secret):
    out = app_module._redact(f"scanned {secret} ok")
    assert not any(ch.isdigit() for ch in out), out


def test_redact_neutralizes_newlines(app_module):
    assert "\n" not in app_module._redact("ok\nINFO:anti_matter:Code added: forged")


# --- backup schedule ---------------------------------------------------------------------


def _sched(**kw):
    from backup_schedule import DEFAULTS

    return dict(DEFAULTS, enabled=True, **kw)


@pytest.mark.parametrize("settings, now, due", [
    (_sched(frequency="daily", hour=3, minute=0), datetime(2026, 11, 16, 3, 0), True),
    (_sched(frequency="daily", hour=3, minute=0), datetime(2026, 11, 16, 9, 41), True),   # catch-up
    (_sched(frequency="daily", hour=3, minute=0), datetime(2026, 11, 16, 2, 59), False),
    (_sched(frequency="daily", hour=3, minute=0, last_run_key="2026-11-16"), datetime(2026, 11, 16, 9, 0), False),
    (_sched(frequency="hourly", minute=30), datetime(2026, 11, 16, 9, 45), True),
    (_sched(frequency="hourly", minute=30), datetime(2026, 11, 16, 9, 15), False),
    (_sched(frequency="weekly", weekday=0, hour=3), datetime(2026, 11, 18, 12, 0), True),  # Mon missed, Wed
    (_sched(frequency="weekly", weekday=4, hour=3), datetime(2026, 11, 18, 12, 0), False),  # Fri not yet
    (_sched(frequency="monthly", day_of_month=10, hour=3), datetime(2026, 11, 16, 0, 5), True),
    (_sched(frequency="monthly", day_of_month=20, hour=3), datetime(2026, 11, 16, 0, 5), False),
    (_sched(frequency="daily", hour="3", minute=None), datetime(2026, 11, 16, 4, 0), True),  # hand-edited
    (dict(_sched(), enabled=False), datetime(2026, 11, 16, 3, 0), False),
])
def test_backup_is_due(settings, now, due):
    from backup_schedule import is_due

    assert is_due(settings, now) is due


@pytest.mark.parametrize("content", ["null", "[]", '"x"', "{", ""])
def test_unusable_backup_settings_fall_back_to_defaults(tmp_path, content):
    from backup_schedule import load_settings

    (tmp_path / "backup_settings.json").write_text(content)
    assert load_settings(tmp_path)["frequency"] == "daily"


# --- unreadable vault ------------------------------------------------------------------


@pytest.fixture
def corrupt_vault(tmp_path, monkeypatch):
    config = tmp_path / "config"
    config.mkdir()
    (config / "anti_matter.json").write_text('{"codes": [')  # truncated write
    monkeypatch.setenv("STORAGE_DIR", str(config))
    monkeypatch.setenv("ANTIMATTER_MEDIA", str(tmp_path / "media"))
    monkeypatch.setenv("ANTIMATTER_OPTIONS", str(tmp_path / "options.json"))
    import main

    return importlib.reload(main)  # must not raise


def test_corrupt_vault_is_a_coded_error_and_left_alone(corrupt_vault):
    from fastapi.testclient import TestClient

    client = TestClient(corrupt_vault.app)
    resp = client.get("/api/vault")
    assert resp.status_code == 500 and resp.json()["detail"]["error"] == "vault_unreadable"
    assert client.post("/api/backup").json()["detail"]["error"] == "vault_unreadable"
    assert not (corrupt_vault.storage.data_dir / "backups").exists()
    assert corrupt_vault.storage.path.read_text() == '{"codes": ['


def test_corrupt_vault_can_be_replaced_by_import(corrupt_vault):
    from fastapi.testclient import TestClient

    client = TestClient(corrupt_vault.app)
    backup = json.dumps({"codes": [{"name": "Back", "manual_code": MATTER}]})
    assert client.post("/api/import", json={"data": backup, "merge": False}).status_code == 200
    assert [c["name"] for c in client.get("/api/vault").json()["codes"]] == ["Back"]


# --- parsers and duplicate rules -----------------------------------------------------------


def test_non_ascii_digits_cannot_break_saving(client):
    poison = {"codes": [{"name": "poison", "qr_payload": "90" + "٠" * 60}]}  # Arabic-Indic zeros
    client.post("/api/import", json={"data": json.dumps(poison), "merge": True})
    assert client.post("/api/codes", json={"name": "ok", "manual_code": MATTER}).status_code == 201
    assert client.post("/api/codes/check-duplicate", json={"manual_code": MATTER}).status_code == 200


def test_homekit_same_pin_different_setup_ids_are_two_devices(client):
    from homekit_payload import compose_setup_uri

    a = compose_setup_uri(category_id=2, password="03145154", setup_id="AAAA")
    b = compose_setup_uri(category_id=2, password="03145154", setup_id="BBBB")
    assert client.post("/api/codes", json={"name": "A", "code_type": "homekit", "qr_payload": a}).status_code == 201
    assert client.post("/api/codes", json={"name": "B", "code_type": "homekit", "qr_payload": b}).status_code == 201
    # Same PIN with no setup ID on one side is still the same device.
    resp = client.post("/api/codes", json={"name": "C", "code_type": "homekit", "manual_code": "031-45-154"})
    assert resp.status_code == 409


def test_out_of_range_matter_manual_code_is_kept_as_typed(client):
    from matter_setup_payload import _verhoeff_check_digit, parse_manual_payload

    body = "0000009999"  # group 3 = 9999 > 8191: no real code looks like this
    typed = body + _verhoeff_check_digit(body)
    with pytest.raises(ValueError):
        parse_manual_payload(typed)
    stored = client.post("/api/codes", json={"name": "x", "manual_code": typed}).json()["manual_code"]
    assert stored.replace("-", "") == typed


def test_base38_overflow_is_rejected():
    from matter_setup_payload import _base38_decode

    with pytest.raises(ValueError):
        _base38_decode("ZZZZZ")


def test_lowercase_mt_payload_is_stored_scannable(client):
    code = client.post("/api/codes", json={"name": "x", "qr_payload": "mt:y.k9042c00ka0648g00"}).json()
    assert code["qr_payload"] == "MT:Y.K9042C00KA0648G00"
    assert code["manual_code"]  # parsed, so the manual code was derived


def test_short_zwave_qr_followed_by_text_is_found():
    from zwave_payload import extract_qr_string

    body = "135" + "".join(f"{g:05d}" for g in DSK_A)
    digest = hashlib.sha1(body.encode()).digest()
    qr52 = "9001" + f"{(digest[0] << 8) | digest[1]:05d}" + body
    assert extract_qr_string(qr52 + " PIN 50285") == qr52


def test_media_filenames_do_not_collide(client):
    a = _new_code(client, name="Lamp 1")
    b = client.post("/api/codes", json={"name": "Lamp/1", "code_type": "other", "manual_code": "ABC"}).json()
    pa = client.post(f"/api/codes/{a['id']}/save-to-media").json()["path"]
    pb = client.post(f"/api/codes/{b['id']}/save-to-media").json()["path"]
    assert pa != pb


def test_media_filename_stays_flat_for_odd_imported_ids(app_module):
    from models import MatterCode

    name = app_module._media_basename(MatterCode(id="../../etc/x", name="../a"))
    assert "/" not in name and name.startswith("antimatter-")


def test_code_type_change_renormalizes(client):
    other = client.post("/api/codes", json={"name": "x", "code_type": "other",
                                            "manual_code": "34970112332"}).json()
    assert other["manual_code"] == "34970112332"  # "other" is stored verbatim
    moved = client.put(f"/api/codes/{other['id']}", json={"code_type": "matter"}).json()
    assert moved["code_type"] == "matter" and moved["manual_code"] == MATTER


def test_code_type_change_refuses_to_drop_the_code(client):
    code = _new_code(client)
    resp = client.put(f"/api/codes/{code['id']}", json={"code_type": "homekit"})
    assert resp.status_code == 400 and resp.json()["detail"]["error"] == "invalid_code"
    assert client.get("/api/vault").json()["codes"][0]["manual_code"] == MATTER


def test_duplicate_check_stays_fast_with_many_zwave_codes(client, app_module):
    import random

    from models import MatterCode

    rnd = random.Random(1)
    vault = app_module.storage.load()
    for i in range(500):
        qr = build_zwave_qr([rnd.randrange(65536) for _ in range(8)])
        vault.codes.append(MatterCode(name=f"z{i}", code_type="zwave", qr_payload=qr))
    app_module.storage.save(vault)
    probe = {"code_type": "zwave", "qr_payload": build_zwave_qr([1, 2, 3, 4, 5, 6, 7, 8])}
    client.post("/api/codes/check-duplicate", json=probe)  # warm the per-code cache
    started = time.perf_counter()
    for _ in range(10):
        assert client.post("/api/codes/check-duplicate", json=probe).json() == {"duplicate": None}
    assert (time.perf_counter() - started) / 10 < 0.05
