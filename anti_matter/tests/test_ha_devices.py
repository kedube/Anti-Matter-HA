"""HA device list: the fields the picker shows (issue #9) and the fill uses (issue #7)."""

from __future__ import annotations

import asyncio
import json

import httpx
import pytest

import ha_client


TOO_LARGE = "Error rendering template: Template output exceeded maximum size of 262144 characters"


def _fake_ha(payload, limit=None):
    """A /api/template stand-in: the device-ids template gets the ids, the details
    template the records for ``variables.device_ids``. Output over ``limit`` characters
    is refused the way HA refuses output over 256 KiB. ``seen`` records every request."""
    seen: dict = {"requests": []}

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        seen["requests"].append(body)
        wanted = (body.get("variables") or {}).get("device_ids")
        if wanted is None:
            out = json.dumps([d["id"] for d in payload if isinstance(d, dict) and d.get("id")])
        else:
            by_id = {d["id"]: d for d in payload if isinstance(d, dict) and d.get("id")}
            out = json.dumps([by_id[i] for i in wanted if i in by_id])
        if limit is not None and len(out) > limit:
            return httpx.Response(400, json={"message": TOO_LARGE})
        if wanted is not None:
            seen.setdefault("ok_batches", []).append(wanted)
        return httpx.Response(200, text=out)

    return handler, seen


def _client_returning(monkeypatch, payload, limit=None):
    handler, seen = _fake_ha(payload, limit)
    real = httpx.AsyncClient
    monkeypatch.setattr(ha_client.httpx, "AsyncClient",
                        lambda **kw: real(transport=httpx.MockTransport(handler), **kw))
    monkeypatch.setenv("SUPERVISOR_TOKEN", "test-token")
    return ha_client.HomeAssistantClient(), seen


def test_devices_carry_registry_fields_and_entities(monkeypatch):
    client, seen = _client_returning(monkeypatch, [
        {"id": "b2", "name": "Plug", "area": "Kitchen", "manufacturer": "Eve Systems", "model": "Eve Energy",
         "entities": ["sensor.plug_power", "switch.plug"]},
        {"id": "a1", "name": "Plug", "area": "Kitchen", "manufacturer": None, "model": None,
         "entities": ["switch.plug_2", 7]},
    ])
    devices = asyncio.run(client.list_devices())
    details = seen["requests"][-1]
    for fn in ("device_attr(did, 'manufacturer')", "device_attr(did, 'model')", "device_entities(did)"):
        assert fn in details["template"]
    assert details["variables"] == {"device_ids": ["b2", "a1"], "max_entities": ha_client._MAX_ENTITIES}
    assert devices[0] == {"id": "b2", "name": "Plug", "area": "Kitchen", "manufacturer": "Eve Systems",
                          "model": "Eve Energy", "entities": ["sensor.plug_power", "switch.plug"]}
    # Missing registry fields become "", and anything that is not an entity id string is dropped.
    assert devices[1] == {"id": "a1", "name": "Plug", "area": "Kitchen", "manufacturer": "", "model": "",
                          "entities": ["switch.plug_2"]}


def test_devices_from_older_template_shape(monkeypatch):
    client, _ = _client_returning(monkeypatch, [{"id": "x", "name": "Lamp"}])
    assert asyncio.run(client.list_devices()) == [
        {"id": "x", "name": "Lamp", "area": "", "manufacturer": "", "model": "", "entities": []}]


# --- failures are reported, never disguised as "no devices" ---------------------------


def _client_with_handler(monkeypatch, handler):
    real = httpx.AsyncClient
    monkeypatch.setattr(ha_client.httpx, "AsyncClient",
                        lambda **kw: real(transport=httpx.MockTransport(handler), **kw))
    monkeypatch.setenv("SUPERVISOR_TOKEN", "test-token")
    return ha_client.HomeAssistantClient()


def _reason(client) -> str:
    with pytest.raises(ha_client.HAUnavailableError) as info:
        asyncio.run(client.list_devices())
    return str(info.value)


def test_template_error_carries_ha_message(monkeypatch):
    # What HA's /api/template answers when rendering fails.
    client = _client_with_handler(monkeypatch, lambda r: httpx.Response(
        400, json={"message": "Error rendering template: UndefinedError: 'device_attr' is undefined"}))
    reason = _reason(client)
    assert "HTTP 400" in reason and "Error rendering template" in reason


def test_timeout_is_reported(monkeypatch):
    def slow(request):
        raise httpx.ReadTimeout("timed out", request=request)

    assert "did not answer within" in _reason(_client_with_handler(monkeypatch, slow))


def test_connection_failure_is_reported(monkeypatch):
    def refused(request):
        raise httpx.ConnectError("Connection refused", request=request)

    assert "Could not connect" in _reason(_client_with_handler(monkeypatch, refused))


@pytest.mark.parametrize("body", ["not json", json.dumps({"id": "x"})])
def test_unexpected_result_is_reported(monkeypatch, body):
    client = _client_with_handler(monkeypatch, lambda r: httpx.Response(200, text=body))
    assert "unexpected device list" in _reason(client)


def test_empty_list_is_not_an_error(monkeypatch):
    client = _client_with_handler(monkeypatch, lambda r: httpx.Response(200, text="[]"))
    assert asyncio.run(client.list_devices()) == []


def test_failure_is_not_cached(monkeypatch):
    calls = {"n": 0}
    ha, _ = _fake_ha([{"id": "x", "name": "Lock"}])

    def flaky(request):
        calls["n"] += 1
        if calls["n"] == 1:
            return httpx.Response(502, text="Bad Gateway")
        return ha(request)

    client = _client_with_handler(monkeypatch, flaky)
    assert "HTTP 502" in _reason(client)
    assert [d["name"] for d in asyncio.run(client.list_devices())] == ["Lock"]


def test_devices_endpoint_answers_503_with_reason(client, app_module, monkeypatch):
    real = httpx.AsyncClient
    monkeypatch.setattr(app_module.ha, "token", "t")
    monkeypatch.setattr(app_module.ha, "enabled", True)
    monkeypatch.setattr(ha_client.httpx, "AsyncClient", lambda **kw: real(
        transport=httpx.MockTransport(lambda r: httpx.Response(400, json={"message": "Error rendering template: boom"})),
        **kw))
    resp = client.get("/api/ha/devices")
    assert resp.status_code == 503
    detail = resp.json()["detail"]
    assert detail["error"] == "ha_unavailable"
    assert "Error rendering template: boom" in detail["message"]


def test_saving_ha_link_logs_no_serializer_warning(client, recwarn):
    # PUT/POST used to assign the request's ha_link dict to the HaLink field unvalidated:
    # pydantic then warned "Expected `HaLink` but got `dict`" on every save.
    made = client.post("/api/codes", json={"name": "Lock", "code_type": "other", "manual_code": "x1",
                                           "ha_link": {"device_id": "abc"}})
    assert made.status_code == 201, made.text
    upd = client.put(f"/api/codes/{made.json()['id']}", json={"name": "Lock 2", "ha_link": {"device_id": None}})
    assert upd.status_code == 200, upd.text
    assert upd.json()["ha_link"] == {"device_id": None}
    assert not [w for w in recwarn if "HaLink" in str(w.message)]


# --- HA's template output cap (256 KiB): fetched in pages -------------------------------


def _many_devices(n, entities_each):
    return [{"id": f"dev{i:04d}", "name": f"Device {i:04d}", "area": "Hall", "manufacturer": "M", "model": "X",
             "entities": [f"sensor.device_{i:04d}_reading_{j}" for j in range(entities_each)]}
            for i in range(n)]


def test_big_install_is_paged_under_the_output_cap(monkeypatch):
    # Real case: HA 2026.x answered 400 "Template output exceeded maximum size of 262144
    # characters" for the old single template, so the picker said HA was unreachable.
    payload = _many_devices(450, 5)
    limit = 25_000  # stands in for 256 KiB; the full list is ~5x that
    assert len(json.dumps(payload)) > 4 * limit
    client, seen = _client_returning(monkeypatch, payload, limit=limit)
    devices = asyncio.run(client.list_devices())
    assert [d["id"] for d in devices] == [d["id"] for d in payload]
    assert all(len(d["entities"]) == 5 for d in devices)
    tried = [r["variables"]["device_ids"] for r in seen["requests"] if r.get("variables")]
    assert len(tried[0]) == ha_client._DETAILS_BATCH  # the first batch is refused, then halved
    assert len(seen["ok_batches"]) < len(tried)
    got = [i for b in seen["ok_batches"] for i in b]
    assert got == [d["id"] for d in payload]  # every device fetched exactly once, in order


def test_too_many_device_ids_is_reported(monkeypatch):
    client, _ = _client_returning(monkeypatch, _many_devices(50, 0), limit=100)
    with pytest.raises(ha_client.HAUnavailableError, match="too many devices"):
        asyncio.run(client.list_devices())


def test_single_device_over_the_cap_is_reported(monkeypatch):
    client, _ = _client_returning(monkeypatch, _many_devices(3, 40), limit=500)
    with pytest.raises(ha_client.HAUnavailableError, match="too much data"):
        asyncio.run(client.list_devices())


def test_template_errors_other_than_the_cap_are_not_retried(monkeypatch):
    calls = {"n": 0}

    def broken(request):
        calls["n"] += 1
        return httpx.Response(400, json={"message": "Error rendering template: boom"})

    assert "boom" in _reason(_client_with_handler(monkeypatch, broken))
    assert calls["n"] == 1
