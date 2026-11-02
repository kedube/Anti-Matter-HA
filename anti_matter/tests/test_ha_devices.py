"""HA device list: the fields the picker shows (issue #9) and the fill uses (issue #7)."""

from __future__ import annotations

import asyncio
import json

import httpx

import ha_client


def _client_returning(monkeypatch, payload):
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["template"] = json.loads(request.content)["template"]
        return httpx.Response(200, text=json.dumps(payload))

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
    for fn in ("device_attr(did, 'manufacturer')", "device_attr(did, 'model')", "device_entities(did)"):
        assert fn in seen["template"]
    assert devices[0] == {"id": "b2", "name": "Plug", "area": "Kitchen", "manufacturer": "Eve Systems",
                          "model": "Eve Energy", "entities": ["sensor.plug_power", "switch.plug"]}
    # Missing registry fields become "", and anything that is not an entity id string is dropped.
    assert devices[1] == {"id": "a1", "name": "Plug", "area": "Kitchen", "manufacturer": "", "model": "",
                          "entities": ["switch.plug_2"]}


def test_devices_from_older_template_shape(monkeypatch):
    client, _ = _client_returning(monkeypatch, [{"id": "x", "name": "Lamp"}])
    assert asyncio.run(client.list_devices()) == [
        {"id": "x", "name": "Lamp", "area": "", "manufacturer": "", "model": "", "entities": []}]
