"""Moving over from Anti-Matter 2.x: a vault exported by 2.0.5 (fixtures/export-2.0.5.json,
made with the 2.0.5 backend) imports as-is into a fresh 3.x install."""

from __future__ import annotations

from pathlib import Path

EXPORT_205 = (Path(__file__).parent / "fixtures" / "export-2.0.5.json").read_text(encoding="utf-8")


def _vault(client):
    vault = client.get("/api/vault").json()
    return {c["name"]: c for c in vault["codes"]}, {c["name"]: c for c in vault["categories"]}


def test_205_export_imports_into_a_new_install(client):
    assert client.post("/api/import", json={"data": EXPORT_205}).status_code == 200
    codes, cats = _vault(client)
    assert set(codes) == {"Hallway plug", "Door sensor", "Garage relay"}
    assert codes["Hallway plug"]["manual_code"] == "3497-011-2332"
    assert codes["Hallway plug"]["category_ids"] == [cats["Living room"]["id"]]
    # 2.0.5 stored the 31-bit-mask digits (52567089); they are repaired on import, not
    # only on the next add-on start.
    assert codes["Door sensor"]["manual_code"] == "84131633"
    assert {n: c["icon"] for n, c in cats.items()} == {"Living room": "television", "Sensors": "motion-sensor"}


def test_205_export_merges_into_an_existing_vault(client):
    client.post("/api/codes", json={"name": "Lamp", "qr_payload": "MT:Y.K9042C00KA0648G00"})
    assert client.post("/api/import", json={"data": EXPORT_205, "merge": True}).status_code == 200
    codes, _ = _vault(client)
    assert len(codes) == 4
    assert codes["Door sensor"]["manual_code"] == "84131633"
