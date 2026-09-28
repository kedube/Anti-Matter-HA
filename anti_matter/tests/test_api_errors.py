"""Machine-readable error codes on every error the UI can show, plus /api/info."""

from __future__ import annotations

import json


def _detail(resp, status: int, error: str) -> dict:
    assert resp.status_code == status, resp.text
    detail = resp.json()["detail"]
    assert detail["error"] == error
    assert isinstance(detail["message"], str) and detail["message"]
    return detail


def test_info_reports_languages(client, app_module):
    info = client.get("/api/info").json()
    assert info["languages"] == app_module.SUPPORTED_UI_LANGUAGES
    assert "en" in info["languages"]
    assert {"version", "language", "theme", "ha_available"} <= info.keys()
    # translations = the languages that ship a locale file (the UI never requests the others)
    assert "en" in info["translations"]
    assert set(info["translations"]) <= set(info["languages"])
    for code in info["translations"]:
        assert (app_module.os.path.isfile(app_module.os.path.join(app_module.LOCALES_DIR, code + ".json")))


def test_category_name_taken(client):
    first = client.post("/api/categories", json={"name": "Lights"}).json()
    detail = _detail(client.post("/api/categories", json={"name": " lights "}), 409,
                     "category_name_taken")
    assert detail["existing"] == {"id": first["id"], "name": "Lights"}
    other = client.post("/api/categories", json={"name": "Sensors"}).json()
    _detail(client.put(f"/api/categories/{other['id']}", json={"name": "LIGHTS"}), 409,
            "category_name_taken")


def test_category_not_found(client):
    _detail(client.put("/api/categories/nope", json={"name": "x"}), 404, "category_not_found")
    _detail(client.post("/api/codes", json={"name": "x", "category_ids": ["nope"]}), 404,
            "category_not_found")


def test_trash_lookups(client):
    _detail(client.post("/api/codes/nope/restore"), 404, "code_not_in_trash")
    _detail(client.delete("/api/codes/nope/purge"), 404, "code_not_in_trash")
    _detail(client.post("/api/categories/nope/restore"), 404, "category_not_in_trash")
    _detail(client.delete("/api/categories/nope/purge"), 404, "category_not_in_trash")


def test_code_not_found(client):
    _detail(client.put("/api/codes/nope", json={"name": "x"}), 404, "code_not_found")
    _detail(client.delete("/api/codes/nope"), 404, "code_not_found")
    _detail(client.get("/api/codes/nope/qr.png"), 404, "code_not_found")
    _detail(client.get("/api/codes/nope/label.png"), 404, "code_not_found")


def test_restore_duplicate(client):
    a = client.post("/api/codes", json={"name": "A", "manual_code": "3497-011-2332"}).json()
    client.delete(f"/api/codes/{a['id']}")
    b = client.post("/api/codes", json={"name": "B", "qr_payload": "MT:Y.K9042C00KA0648G00"}).json()
    detail = _detail(client.post(f"/api/codes/{a['id']}/restore"), 409, "duplicate")
    assert detail["existing"]["id"] == b["id"]


def test_invalid_import(client):
    detail = _detail(client.post("/api/import", json={"data": "{not json"}), 400, "invalid_import")
    assert detail["message"].startswith("Invalid JSON")
    bad_shape = json.dumps({"codes": "nope"})
    _detail(client.post("/api/import", json={"data": bad_shape}), 400, "invalid_import")


def test_protocol_specific_images(client):
    hk = client.post("/api/codes", json={"name": "H", "code_type": "homekit",
                                         "qr_payload": "X-HM://0081YCYEP3QYT"}).json()
    detail = _detail(client.get(f"/api/codes/{hk['id']}/label.png"), 400, "unsupported_protocol")
    assert detail["protocol"] == "homekit"
    mt = client.post("/api/codes", json={"name": "M", "manual_code": "3497-011-2332"}).json()
    _detail(client.get(f"/api/codes/{mt['id']}/card.svg"), 400, "unsupported_protocol")
    empty = client.post("/api/codes", json={"name": "E"}).json()
    _detail(client.get(f"/api/codes/{empty['id']}/label.png"), 404, "nothing_to_render")


def test_validation_error_is_coded(client):
    detail = _detail(client.post("/api/codes", json={"code_type": "matter"}), 422,
                     "invalid_request")
    assert detail["errors"][0]["loc"] == ["body", "name"]


def test_framework_errors_are_coded(client):
    _detail(client.get("/api/does-not-exist"), 404, "not_found")
    _detail(client.patch("/api/vault"), 405, "method_not_allowed")


def test_existing_success_shapes_unchanged(client):
    resp = client.post("/api/codes", json={"name": "Lamp", "qr_payload": "MT:Y.K9042C00KA0648G00"})
    assert resp.status_code == 201
    code = resp.json()
    assert code["manual_code"] == "3497-011-2332"
    png = client.get(f"/api/codes/{code['id']}/qr.png")
    assert png.headers["content-type"] == "image/png"
    from PIL import Image
    import io

    assert Image.open(io.BytesIO(png.content)).size == (220, 220)


def test_import_accepts_real_exports(client):
    client.post("/api/codes", json={"name": "Lamp", "qr_payload": "MT:Y.K9042C00KA0648G00"})
    exported = client.get("/api/export").text
    assert client.post("/api/import", json={"data": exported}).status_code == 200
    empty = json.dumps({"categories": [], "codes": []})
    assert client.post("/api/import", json={"data": empty, "merge": True}).status_code == 200
    assert len(client.get("/api/vault").json()["codes"]) == 1


def test_import_refuses_non_export_json_instead_of_wiping(client):
    client.post("/api/codes", json={"name": "Lamp", "qr_payload": "MT:Y.K9042C00KA0648G00"})
    for data in ("{}", "[]", json.dumps({"hello": 1})):
        _detail(client.post("/api/import", json={"data": data}), 400, "invalid_import")
    assert len(client.get("/api/vault").json()["codes"]) == 1


def test_qr_png_payload_too_long(client):
    code = client.post("/api/codes", json={"name": "Big", "code_type": "other",
                                           "qr_payload": "x" * 5000}).json()
    _detail(client.get(f"/api/codes/{code['id']}/qr.png"), 400, "qr_payload_too_long")
    _detail(client.get(f"/api/codes/{code['id']}/qr.svg"), 400, "qr_payload_too_long")


def test_code_keeps_trashed_category_link(client):
    """A code may keep (and be saved with) the id of a category that is in the Trash, so
    restoring the category re-attaches it; a truly unknown id is still rejected."""
    cat = client.post("/api/categories", json={"name": "Spares"}).json()
    code = client.post("/api/codes", json={"name": "x", "manual_code": "34970112332",
                                           "category_ids": [cat["id"]]}).json()
    assert client.delete(f"/api/categories/{cat['id']}").status_code == 200
    resp = client.put(f"/api/codes/{code['id']}", json={"name": "y", "category_ids": [cat["id"]]})
    assert resp.status_code == 200, resp.text
    assert resp.json()["category_ids"] == [cat["id"]]
    _detail(client.put(f"/api/codes/{code['id']}", json={"category_ids": [cat["id"], "nope"]}),
            404, "category_not_found")


def test_registry_lookup_miss_is_204(client, app_module, monkeypatch):
    async def none(*_args):
        return None

    monkeypatch.setattr(app_module, "fetch_vendor_info", none)
    monkeypatch.setattr(app_module, "fetch_model_info", none)
    assert client.get("/api/matter/vendor/65521").status_code == 204
    assert client.get("/api/matter/model/65521/32768").status_code == 204
    assert client.get("/api/zwave/device/65535/65535/65535").status_code == 204


def test_legacy_lucide_category_icons_are_healed(client):
    cat = client.post("/api/categories", json={"name": "Old", "icon": "box"}).json()
    assert cat["icon"] == "package-variant-closed"
    assert client.post("/api/categories", json={"name": "Mdi", "icon": "mdi:home"}).json()["icon"] == "home"
