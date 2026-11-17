"""Optional lookup of official vendor/product names from the CSA Distributed
Compliance Ledger (the public Matter certification registry) — the same
public, unauthenticated read API the generate.matterqr.codes tool proxies to.
Best-effort only: any network/DNS/timeout failure just means no official name,
never an error surfaced to the user.
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from typing import Any, AsyncIterator, Optional

import httpx

DCL_BASE = "https://on.dcl.csa-iot.org/dcl"
_TIMEOUT = 6.0

# Shared, pooled client for the add-on's lifetime (main's lifespan sets it), so repeated
# lookups reuse the TLS connection. None falls back to a short-lived client per request.
_http: Optional[httpx.AsyncClient] = None


def set_http_client(client: Optional[httpx.AsyncClient]) -> None:
    global _http
    _http = client


@asynccontextmanager
async def _session() -> AsyncIterator[httpx.AsyncClient]:
    if _http is not None:
        yield _http
    else:
        async with httpx.AsyncClient() as client:
            yield client


async def _get_json(url: str) -> Any:
    """Parsed JSON body, or None for 404 / any network, HTTP or decoding failure."""
    try:
        async with _session() as client:
            resp = await client.get(url, timeout=_TIMEOUT)
            if resp.status_code == 404:
                return None
            resp.raise_for_status()
            return resp.json()
    except (httpx.HTTPError, ValueError):
        return None


async def fetch_vendor_info(vendor_id: int) -> Optional[dict[str, Any]]:
    data = await _get_json(f"{DCL_BASE}/vendorinfo/vendors/{vendor_id}")
    if not isinstance(data, dict):
        return None
    record = data.get("vendorInfo")
    if isinstance(record, list):
        record = record[0] if record else None
    if not isinstance(record, dict):
        return None
    name = (record.get("vendorName") or record.get("companyPreferredName") or "").strip()
    if not name:
        return None
    return {
        "vendor_id": vendor_id,
        "name": name,
        "landing_page": (record.get("vendorLandingPageURL") or "").strip() or None,
    }


async def fetch_model_info(vendor_id: int, product_id: int) -> Optional[dict[str, Any]]:
    data = await _get_json(f"{DCL_BASE}/model/models/{vendor_id}/{product_id}")
    if not isinstance(data, dict):
        return None
    record = data.get("model")
    if not isinstance(record, dict):
        return None
    name = (record.get("productLabel") or record.get("productName") or "").strip()
    if not name:
        return None
    return {
        "vendor_id": vendor_id,
        "product_id": product_id,
        "name": name,
        "product_page": (record.get("productUrl") or "").strip() or None,
        "support_page": (record.get("supportUrl") or "").strip() or None,
    }
