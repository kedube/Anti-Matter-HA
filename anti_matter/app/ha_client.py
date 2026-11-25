"""Home Assistant REST API client via Supervisor."""

from __future__ import annotations

import json
import logging
import os
import re
import time
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator, Optional

import httpx

SUPERVISOR_CORE = "http://supervisor/core/api"
_LOGGER = logging.getLogger("anti_matter.ha_client")

# list_devices runs a template over *every* HA state, so the same dialog reopening
# shouldn't re-run it each time — cache the result briefly.
_DEVICES_CACHE_TTL = 60.0
# The device template walks every state; on a big install, or while HA is busy (just
# after a restart), it can take well over the 15 s that the small lookups get.
_DEVICES_TIMEOUT = 45.0

# HA refuses to render more than 256 KiB of template output ("Template output exceeded
# maximum size of 262144 characters", a 400 from /api/template). Every device with all
# its entity ids is far more than that on a big install, so the list is fetched in two
# steps: the device ids (~35 characters each), then their details in batches of ids
# passed as template variables. A batch that still hits the cap is halved and retried.
_DETAILS_BATCH = 200
# Entity ids per device: they only tell look-alike devices apart in the picker, and the
# cap keeps a single device's details far below HA's output limit.
_MAX_ENTITIES = 100

# device_id() is only a template *function* in older HA, not a registered filter —
# `states | map('device_id')` fails there, so the ids are collected with a for-loop.
_DEVICE_IDS_TEMPLATE = (
    "{% set ns = namespace(ids=[]) %}"
    "{% for eid in states | map(attribute='entity_id') %}"
    "{% set did = device_id(eid) %}"
    "{% if did and did not in ns.ids %}"
    "{% set ns.ids = ns.ids + [did] %}"
    "{% endif %}"
    "{% endfor %}"
    "{{ ns.ids | to_json }}"
)
_DEVICE_DETAILS_TEMPLATE = (
    "{% set ns = namespace(items=[]) %}"
    "{% for did in device_ids %}"
    "{% set ns.items = ns.items + [{'id': did,"
    " 'name': device_attr(did, 'name_by_user') or device_attr(did, 'name') or did,"
    " 'area': area_name(did) or '',"
    " 'manufacturer': device_attr(did, 'manufacturer') or '',"
    " 'model': device_attr(did, 'model') or '',"
    " 'entities': (device_entities(did) | sort)[:max_entities]}] %}"
    "{% endfor %}"
    "{{ ns.items | to_json }}"
)

# HA entity ids are "<domain>.<object_id>" in [a-z0-9_]. Anything else is refused before
# it reaches the URL: httpx collapses "../", so a crafted id would otherwise send this
# add-on's Supervisor token to any other Supervisor / Core API path.
_ENTITY_ID = re.compile(r"[a-z0-9_]+\.[a-z0-9_]+")

MISSING: Any = object()
"""get_attribute() result when the entity or attribute does not exist (a real attribute
may legitimately be null/None)."""


class HAUnavailableError(Exception):
    """Home Assistant could not produce the device list. ``str()`` is a short English
    reason (timeout, HTTP status with HA's own message, ...) for the log and the UI, so
    "HA failed" is never confused with "HA has no devices"."""


def _ha_error_text(resp: httpx.Response) -> str:
    """HA's own explanation from an error response: ``{"message": ...}`` (e.g. "Error
    rendering template: ..."), else the start of the body."""
    try:
        body = resp.json()
        if isinstance(body, dict) and body.get("message"):
            return str(body["message"])[:300]
    except ValueError:
        pass
    return resp.text.strip()[:300]


class _OutputTooLarge(Exception):
    """HA refused the render because its output was over the template size cap."""


def _describe_failure(exc: httpx.HTTPError, timeout: float) -> str:
    if isinstance(exc, httpx.TimeoutException):
        return f"Home Assistant did not answer within {timeout:g} s"
    if isinstance(exc, httpx.HTTPStatusError):
        detail = _ha_error_text(exc.response)
        status = exc.response.status_code
        return f"Home Assistant answered HTTP {status}" + (f": {detail}" if detail else "")
    return f"Could not connect to Home Assistant ({type(exc).__name__}: {exc})"


class HomeAssistantClient:
    def __init__(self) -> None:
        self.token = os.environ.get("SUPERVISOR_TOKEN", "")
        self.enabled = bool(self.token)
        self._devices_cache: Optional[list[dict[str, Any]]] = None
        self._devices_cache_at = 0.0
        # Shared, pooled client for the add-on's lifetime (set by main's lifespan). None
        # (tests, scripts) falls back to a short-lived client per request.
        self.http: Optional[httpx.AsyncClient] = None

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self.token}",
            "Content-Type": "application/json",
        }

    @asynccontextmanager
    async def _session(self) -> AsyncIterator[httpx.AsyncClient]:
        if self.http is not None:
            yield self.http
        else:
            async with httpx.AsyncClient() as client:
                yield client

    async def get_state(self, entity_id: str) -> Optional[dict[str, Any]]:
        if not self.enabled or not _ENTITY_ID.fullmatch(entity_id or ""):
            return None
        url = f"{SUPERVISOR_CORE}/states/{entity_id}"
        try:
            async with self._session() as client:
                resp = await client.get(url, headers=self._headers(), timeout=15.0)
                if resp.status_code == 404:
                    return None
                resp.raise_for_status()
                state = resp.json()
        except (httpx.HTTPError, ValueError) as exc:
            _LOGGER.warning("get_state: HA request failed: %s", exc)
            return None
        return state if isinstance(state, dict) else None

    async def get_attribute(self, entity_id: str, attribute: str) -> Any:
        """The attribute's value (which may be None), or MISSING when the entity or the
        attribute does not exist, or HA could not be reached."""
        state = await self.get_state(entity_id)
        attrs = (state or {}).get("attributes")
        if isinstance(attrs, dict) and attribute in attrs:
            return attrs[attribute]
        return MISSING

    async def list_entities(self, domain: Optional[str] = None) -> list[str]:
        if not self.enabled:
            return []
        url = f"{SUPERVISOR_CORE}/states"
        try:
            async with self._session() as client:
                resp = await client.get(url, headers=self._headers(), timeout=30.0)
                resp.raise_for_status()
                states = resp.json()
        except (httpx.HTTPError, ValueError) as exc:
            _LOGGER.warning("list_entities: HA request failed: %s", exc)
            return []
        if not isinstance(states, list):
            return []
        ids = [s["entity_id"] for s in states if isinstance(s, dict) and isinstance(s.get("entity_id"), str)]
        if domain:
            prefix = f"{domain}."
            ids = [e for e in ids if e.startswith(prefix)]
        return sorted(ids)

    async def _render_list(
        self, client: httpx.AsyncClient, template: str, variables: Optional[dict[str, Any]] = None
    ) -> list[Any]:
        """Render a template that prints a JSON list and return the list. Raises
        _OutputTooLarge when HA hits its output cap, HAUnavailableError for anything else."""
        body: dict[str, Any] = {"template": template}
        if variables is not None:
            body["variables"] = variables
        try:
            resp = await client.post(
                f"{SUPERVISOR_CORE}/template",
                headers=self._headers(),
                json=body,
                timeout=_DEVICES_TIMEOUT,
            )
            if resp.status_code == 400 and "exceeded maximum size" in _ha_error_text(resp):
                raise _OutputTooLarge()
            resp.raise_for_status()
        except httpx.HTTPError as exc:
            raise HAUnavailableError(_describe_failure(exc, _DEVICES_TIMEOUT)) from exc
        raw = resp.text.strip()
        try:
            result = json.loads(raw)
        except (ValueError, TypeError):
            _LOGGER.warning("list_devices: HA returned non-JSON template result: %r", raw[:300])
            raise HAUnavailableError(
                "Home Assistant returned an unexpected device list (not JSON)"
            ) from None
        if not isinstance(result, list):
            _LOGGER.warning("list_devices: HA template result is not a list: %r", raw[:300])
            raise HAUnavailableError("Home Assistant returned an unexpected device list")
        return result

    async def _fetch_devices(self, client: httpx.AsyncClient) -> tuple[list[Any], int]:
        """Raw device dicts from HA, paged under its template output cap; and the number
        of requests it took."""
        try:
            ids = await self._render_list(client, _DEVICE_IDS_TEMPLATE)
        except _OutputTooLarge:
            raise HAUnavailableError(
                "Home Assistant has too many devices to list them through a template"
            ) from None
        ids = list(dict.fromkeys(i for i in ids if isinstance(i, str) and i))
        devices: list[Any] = []
        requests = 1
        batch = _DETAILS_BATCH
        start = 0
        while start < len(ids):
            chunk = ids[start : start + batch]
            requests += 1
            try:
                part = await self._render_list(
                    client,
                    _DEVICE_DETAILS_TEMPLATE,
                    {"device_ids": chunk, "max_entities": _MAX_ENTITIES},
                )
            except _OutputTooLarge:
                if batch == 1:
                    raise HAUnavailableError(
                        "A Home Assistant device has too much data to list through a template"
                    ) from None
                batch = max(1, batch // 2)
                continue
            devices.extend(part)
            start += len(chunk)
        return devices, requests

    async def list_devices(self) -> list[dict[str, Any]]:
        """[{id, name, area, manufacturer, model, entities}] for every HA device with at
        least one entity — via the template API's `device_id()`/`device_attr()`/
        `area_name()`/`device_entities()` functions (no REST device-registry endpoint
        exists). Lets the UI link to a device's own page (`/config/devices/device/<id>`);
        `area` and the sorted `entities` ids (first `_MAX_ENTITIES`) tell same-named
        devices apart in the picker (issue #9), and `manufacturer`/`model` fill a linked
        code's empty fields (#7). Fetched in pages: see `_DETAILS_BATCH`.

        Cached for `_DEVICES_CACHE_TTL` seconds so reopening the edit dialog doesn't
        re-run the O(entities) template each time. Failures are not cached.

        Raises HAUnavailableError when HA could not be asked or did not answer with a
        device list, so callers can tell that apart from a genuinely empty list."""
        if not self.enabled:
            return []
        now = time.monotonic()
        if self._devices_cache is not None and (now - self._devices_cache_at) < _DEVICES_CACHE_TTL:
            return self._devices_cache
        t0 = time.monotonic()
        try:
            async with self._session() as client:
                devices, requests = await self._fetch_devices(client)
        except HAUnavailableError as exc:
            _LOGGER.warning("list_devices: %s (after %.1f s)", exc, time.monotonic() - t0)
            raise
        out = [
            {
                "id": str(d["id"]),
                "name": str(d.get("name") or d["id"]),
                "area": str(d.get("area") or ""),
                "manufacturer": str(d.get("manufacturer") or ""),
                "model": str(d.get("model") or ""),
                "entities": [str(e) for e in d.get("entities") or [] if isinstance(e, str)],
            }
            for d in devices
            if isinstance(d, dict) and d.get("id")
        ]
        out.sort(key=lambda d: d["name"].lower())
        _LOGGER.info(
            "list_devices: %d devices in %.1f s (%d requests)",
            len(out), time.monotonic() - t0, requests,
        )
        self._devices_cache = out
        self._devices_cache_at = now
        return out

    async def list_areas(self) -> list[str]:
        """Area names via the HA template API (areas aren't in the REST states list)."""
        if not self.enabled:
            return []
        url = f"{SUPERVISOR_CORE}/template"
        body = {"template": "{{ areas() | map('area_name') | list | to_json }}"}
        try:
            async with self._session() as client:
                resp = await client.post(url, headers=self._headers(), json=body, timeout=15.0)
                resp.raise_for_status()
                raw = resp.text.strip()
        except (httpx.HTTPError, ValueError):
            return []
        try:
            names = json.loads(raw)
        except (ValueError, TypeError):
            return []
        if not isinstance(names, list):
            return []
        return sorted({str(n) for n in names if n})
