"""Anti-Matter — Home Assistant add-on API and ingress UI."""

from __future__ import annotations

import asyncio
import io
import logging
import os
import re
from contextlib import asynccontextmanager
from datetime import datetime
from typing import Any, Optional

import uvicorn
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from starlette.staticfiles import StaticFiles
from starlette.types import Scope
from pydantic import BaseModel

from backup_schedule import is_due, load_settings, mark_ran, period_key, save_settings
from ha_client import HomeAssistantClient
from matter_dcl import fetch_model_info, fetch_vendor_info
from models import (
    Category,
    CategoryCreate,
    CategoryUpdate,
    MatterCode,
    MatterCodeCreate,
    MatterCodeUpdate,
    TrashBin,
    utc_now,
)
from options import norm_language, norm_theme, opt
from matter_label import label_png_bytes
from matter_qr_image import qr_png_bytes as matter_qr_png_bytes
from matter_payload import normalize_fields, qr_encode_payload
from homekit_label import card_svg_for_code
from homekit_qr_image import qr_png_bytes as homekit_qr_png_bytes
from homekit_payload import (
    normalize_fields as normalize_homekit_fields,
    pairing_digits as homekit_pairing_digits,
    parse_setup_uri,
    qr_encode_payload as homekit_qr_encode,
)
from zwave_label import card_svg_for_code as zwave_card_svg_for_code
from zwave_qr_image import qr_png_bytes as zwave_qr_png_bytes
from zwave_payload import (
    extract_qr_string as zwave_extract_qr,
    normalize_fields as normalize_zwave_fields,
    qr_encode_payload as zwave_qr_encode,
    _digits_only as zwave_digits_only,
)
from zwave_device_db import lookup_device as lookup_zwave_device
from models import Vault
from storage import VaultStorage

logging.basicConfig(level=logging.INFO)
_LOGGER = logging.getLogger("anti_matter")
# Quiet the noisy library loggers — our own access_log_middleware below replaces
# uvicorn's per-request line, and httpx's default request line is redundant with it.
logging.getLogger("uvicorn.access").setLevel(logging.WARNING)
logging.getLogger("httpx").setLevel(logging.WARNING)

APP_VERSION = "2.0.5"
PORT = int(os.environ.get("ANTIMATTER_PORT", "8099"))
STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")

# Optional: also save a copy of downloaded QR/label images under HA's Media folder
# (map: media:rw -> /media), in its own subfolder so it doesn't clutter the root.
from pathlib import Path as _Path

MEDIA_DIR = _Path(os.environ.get("ANTIMATTER_MEDIA", "/media")) / "anti_matter"

# --- Logging redaction: never write pairing codes / QR payloads to the log ---
_REDACT_PATTERNS = [
    re.compile(r"MT:[A-Za-z0-9./+_-]+", re.I),
    re.compile(r"X-HM://[A-Za-z0-9]+", re.I),
    re.compile(r"\b\d{4}-\d{3}-\d{4}\b"),  # Matter manual code, formatted
    re.compile(r"\b\d{9,90}\b"),  # any long digit run (Z-Wave DSK/QR, raw manual codes)
]


def _redact(text: Any) -> str:
    out = str(text or "")
    for pat in _REDACT_PATTERNS:
        out = pat.sub("***", out)
    return out[:300]


class IngressStaticFiles(StaticFiles):
    """Ingress UI assets: avoid stale CSS/JS after add-on updates."""

    async def get_response(self, path: str, scope: Scope):
        response = await super().get_response(path, scope)
        if response.status_code == 200:
            ctype = (response.headers.get("content-type") or "").lower()
            if any(t in ctype for t in ("javascript", "css", "html", "json")):
                response.headers["Cache-Control"] = "no-cache, must-revalidate"
        return response


storage = VaultStorage()
ha = HomeAssistantClient()


class ImportBody(BaseModel):
    data: str
    merge: bool = False


def _find_category(vault, category_id: str) -> Category:
    for cat in vault.categories:
        if cat.id == category_id:
            return cat
    raise HTTPException(404, "Category not found")


def _find_category_by_name(
    vault: Vault, name: str, exclude_id: str | None = None
) -> Category | None:
    key = (name or "").strip().lower()
    if not key:
        return None
    for cat in vault.categories:
        if exclude_id and cat.id == exclude_id:
            continue
        if cat.name.strip().lower() == key:
            return cat
    return None


def _find_code(vault, code_id: str) -> MatterCode:
    for code in vault.codes:
        if code.id == code_id:
            return code
    raise HTTPException(404, "Code not found")


def _normalize_manual_key(value: str) -> str:
    digits = "".join(c for c in (value or "") if c.isdigit())
    return digits if len(digits) == 11 else ""


def _normalize_qr_key(value: str) -> str:
    s = (value or "").strip().upper()
    return s if s.startswith("MT:") else ""


def _normalize_homekit_qr_key(value: str) -> str:
    parsed = parse_setup_uri(str(value or ""))
    return parsed["uri"].upper() if parsed else ""


def _code_protocol(candidate: dict | MatterCode) -> str:
    if isinstance(candidate, MatterCode):
        data = candidate.model_dump(mode="json")
    else:
        data = candidate
    ct = str(data.get("code_type") or "matter").strip().lower()
    if ct in ("homekit", "zwave", "other"):
        return ct
    qr = str(data.get("qr_payload") or "").strip().upper()
    if qr.startswith("X-HM://"):
        return "homekit"
    if zwave_extract_qr(str(data.get("qr_payload") or "")):
        return "zwave"
    return "matter"


def _find_duplicate_code(
    vault: Vault, candidate: dict, exclude_id: str | None = None
) -> MatterCode | None:
    proto = _code_protocol(candidate)
    if proto == "zwave":
        dsk_key = zwave_digits_only(str(candidate.get("manual_code", "")))
        qr_key = zwave_extract_qr(str(candidate.get("qr_payload", "")))
        if len(dsk_key) != 40 and not qr_key:
            return None
        for existing in vault.codes:
            if exclude_id and existing.id == exclude_id:
                continue
            if _code_protocol(existing) != "zwave":
                continue
            if dsk_key and dsk_key == zwave_digits_only(existing.manual_code):
                return existing
            if qr_key and qr_key == zwave_extract_qr(existing.qr_payload):
                return existing
        return None
    if proto == "homekit":
        pin = homekit_pairing_digits(str(candidate.get("manual_code", "")))
        qr_key = _normalize_homekit_qr_key(str(candidate.get("qr_payload", "")))
        if not pin and not qr_key:
            return None
        for existing in vault.codes:
            if exclude_id and existing.id == exclude_id:
                continue
            if _code_protocol(existing) != "homekit":
                continue
            if pin and pin == homekit_pairing_digits(existing.manual_code):
                return existing
            if qr_key and qr_key == _normalize_homekit_qr_key(existing.qr_payload):
                return existing
        return None
    if proto == "other":
        # No parser exists for an unknown standard, so dedup is a plain exact-string
        # match on the stripped values — no normalization to fall back on.
        man_key = str(candidate.get("manual_code", "")).strip()
        qr_key = str(candidate.get("qr_payload", "")).strip()
        if not man_key and not qr_key:
            return None
        for existing in vault.codes:
            if exclude_id and existing.id == exclude_id:
                continue
            if _code_protocol(existing) != "other":
                continue
            if man_key and man_key == (existing.manual_code or "").strip():
                return existing
            if qr_key and qr_key == (existing.qr_payload or "").strip():
                return existing
        return None
    man_key = _normalize_manual_key(str(candidate.get("manual_code", "")))
    qr_key = _normalize_qr_key(str(candidate.get("qr_payload", "")))
    if not man_key and not qr_key:
        return None
    for existing in vault.codes:
        if exclude_id and existing.id == exclude_id:
            continue
        if _code_protocol(existing) not in ("matter",):
            continue
        if man_key and man_key == _normalize_manual_key(existing.manual_code):
            return existing
        if qr_key and qr_key == _normalize_qr_key(existing.qr_payload):
            return existing
    return None


def _dup_detail(dup: MatterCode) -> dict[str, Any]:
    return {
        "message": f"This code is already saved as “{dup.name}”",
        "existing": {"id": dup.id, "name": dup.name},
    }


def run_backup(keep_count: int | None = None) -> dict[str, Any]:
    vault_path = storage.path
    if not vault_path.exists():
        return {"ok": False, "reason": "no_vault"}
    if keep_count is None:
        keep_count = load_settings(storage.data_dir).get("keep_count", 10)
    dest = storage.backup_local_copy(keep_count=keep_count)
    return {"ok": True, "backup": dest.name}


async def _scheduler_loop() -> None:
    while True:
        try:
            settings = load_settings(storage.data_dir)
            now = datetime.now()
            if is_due(settings, now):
                result = run_backup(keep_count=settings.get("keep_count", 10))
                mark_ran(storage.data_dir, period_key(settings.get("frequency", "daily"), now))
                _LOGGER.info("Scheduled backup: %s", result)
        except Exception:
            _LOGGER.exception("Scheduled backup check failed")
        await asyncio.sleep(60)


@asynccontextmanager
async def lifespan(app: FastAPI):
    lang = norm_language(opt("interface", "language", "auto"))
    theme = norm_theme(opt("interface", "theme", "auto"))
    backup_settings = load_settings(storage.data_dir)
    _LOGGER.info(
        "Anti-Matter %s starting: language=%s theme=%s ha_available=%s "
        "backup_enabled=%s backup_frequency=%s backup_keep_count=%s",
        APP_VERSION,
        lang,
        theme,
        ha.enabled,
        backup_settings.get("enabled"),
        backup_settings.get("frequency"),
        backup_settings.get("keep_count"),
    )
    task = asyncio.create_task(_scheduler_loop())
    yield
    task.cancel()


app = FastAPI(title="Anti-Matter", version=APP_VERSION, lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["*"],
)

# Requests polled every few seconds by the UI (vault refresh, live status) are noise —
# log everything else (mutations, errors, one-off page loads).
_QUIET_GET_PATHS = {"/", "/api/vault", "/api/info"}


@app.middleware("http")
async def access_log_middleware(request: Request, call_next):
    response = await call_next(request)
    path = request.url.path
    quiet = (
        request.method == "GET"
        and response.status_code < 400
        and (
            path in _QUIET_GET_PATHS
            or path.startswith("/static/")
            or (path.startswith("/api/codes/") and path.endswith((".png", ".svg")))
        )
    )
    if not quiet:
        _LOGGER.info("%s %s -> %d", request.method, path, response.status_code)
    return response


class ClientLogBody(BaseModel):
    message: str
    level: str = "info"


@app.post("/api/log")
async def client_log(body: ClientLogBody):
    """Client-side events with no other server touch-point (view mode, QR invert,
    scan captured, resolved theme/language for the session) — never raw codes."""
    msg = _redact(body.message)
    level = (body.level or "info").lower()
    if level == "warning":
        _LOGGER.warning("[client] %s", msg)
    elif level == "error":
        _LOGGER.error("[client] %s", msg)
    else:
        _LOGGER.info("[client] %s", msg)
    return {"ok": True}


# --- Add-on info (resolved options for the UI) ---


@app.get("/api/info")
async def app_info():
    return {
        "version": APP_VERSION,
        "language": norm_language(opt("interface", "language", "auto")),
        "theme": norm_theme(opt("interface", "theme", "auto")),
        "ha_available": ha.enabled,
    }


# --- Vault ---


@app.get("/api/vault")
async def get_vault():
    data = storage.load().model_dump()
    data["categories"] = [c for c in data["categories"] if not c.get("deleted_at")]
    data["codes"] = [c for c in data["codes"] if not c.get("deleted_at")]
    return data


@app.get("/api/trash")
async def get_trash():
    bin_data = storage.load_bin()
    return {"categories": bin_data.categories, "codes": bin_data.codes}


@app.delete("/api/trash")
async def empty_trash():
    from vault_merge import record_deletion

    bin_data = storage.load_bin()
    category_ids = [c.id for c in bin_data.categories]
    code_ids = [c.id for c in bin_data.codes]
    if not category_ids and not code_ids:
        return {"ok": True}

    vault = storage.load()
    data = vault.model_dump(mode="json")
    for category_id in category_ids:
        for code in data["codes"]:
            ids = code.get("category_ids") or []
            if category_id in ids:
                code["category_ids"] = [i for i in ids if i != category_id]
        record_deletion(data, "categories", category_id)
    for code_id in code_ids:
        record_deletion(data, "codes", code_id)
    storage.save(Vault.model_validate(data))

    bin_data.categories = []
    bin_data.codes = []
    storage.save_bin(bin_data)
    _LOGGER.info("Trash emptied: %d categories, %d codes purged", len(category_ids), len(code_ids))
    return {"ok": True}


@app.get("/api/export")
async def export_vault():
    content = storage.export_json()
    vault = storage.load()
    _LOGGER.info(
        "Vault exported: %d codes, %d categories (%d bytes)",
        len(vault.codes), len(vault.categories), len(content),
    )
    return Response(
        content=content,
        media_type="application/json",
        headers={
            "Content-Disposition": 'attachment; filename="anti-matter-export.json"'
        },
    )


@app.post("/api/import")
async def import_vault(body: ImportBody):
    try:
        vault = storage.import_json(body.data, merge=body.merge)
    except Exception as exc:
        _LOGGER.warning("Vault import failed (merge=%s): %s", body.merge, exc)
        raise HTTPException(400, f"Invalid JSON: {exc}") from exc
    _LOGGER.info(
        "Vault imported (merge=%s): now %d codes, %d categories",
        body.merge, len(vault.codes), len(vault.categories),
    )
    return vault.model_dump()


@app.post("/api/backup")
async def trigger_backup():
    result = run_backup()
    _LOGGER.info("Manual backup triggered: %s", result)
    return result


class BackupSettingsBody(BaseModel):
    enabled: bool = False
    frequency: str = "daily"
    hour: int = 3
    minute: int = 0
    weekday: int = 0
    day_of_month: int = 1
    keep_count: int = 10


@app.get("/api/backup/settings")
async def get_backup_settings():
    return load_settings(storage.data_dir)


@app.put("/api/backup/settings")
async def put_backup_settings(body: BackupSettingsBody):
    return save_settings(storage.data_dir, body.model_dump())


# --- Categories ---


@app.get("/api/categories")
async def list_categories():
    return [c for c in storage.load().categories if not c.deleted_at]


@app.post("/api/categories", status_code=201)
async def create_category(body: CategoryCreate):
    vault = storage.load()
    dup = _find_category_by_name(vault, body.name)
    if dup:
        raise HTTPException(409, detail=f"A category named “{dup.name}” already exists")
    category = Category(**body.model_dump())
    vault.categories.append(category)
    vault.categories.sort(key=lambda c: (c.sort_order, c.name.lower()))
    storage.save(vault)
    _LOGGER.info("Category added: id=%s name=%s", category.id, _redact(category.name))
    return category


@app.put("/api/categories/{category_id}")
async def update_category(category_id: str, body: CategoryUpdate):
    vault = storage.load()
    category = _find_category(vault, category_id)
    updates = body.model_dump(exclude_unset=True)
    if "name" in updates and updates["name"]:
        dup = _find_category_by_name(vault, updates["name"], exclude_id=category_id)
        if dup:
            raise HTTPException(409, detail=f"A category named “{dup.name}” already exists")
    for key, value in updates.items():
        setattr(category, key, value)
    storage.save(vault)
    _LOGGER.info("Category updated: id=%s name=%s", category_id, _redact(category.name))
    return category


def _find_bin_category(bin_data: TrashBin, category_id: str) -> Category:
    for cat in bin_data.categories:
        if cat.id == category_id:
            return cat
    raise HTTPException(404, "Category not found in trash")


@app.delete("/api/categories/{category_id}")
async def delete_category(category_id: str):
    vault = storage.load()
    category = _find_category(vault, category_id)
    vault.categories = [c for c in vault.categories if c.id != category_id]
    storage.save(vault)
    category.deleted_at = utc_now()
    bin_data = storage.load_bin()
    bin_data.categories = [c for c in bin_data.categories if c.id != category_id]
    bin_data.categories.append(category)
    storage.save_bin(bin_data)
    _LOGGER.info("Category moved to trash: id=%s name=%s", category_id, _redact(category.name))
    return {"ok": True}


@app.post("/api/categories/{category_id}/restore")
async def restore_category(category_id: str):
    bin_data = storage.load_bin()
    category = _find_bin_category(bin_data, category_id)
    bin_data.categories = [c for c in bin_data.categories if c.id != category_id]
    storage.save_bin(bin_data)
    category.deleted_at = None
    vault = storage.load()
    vault.categories.append(category)
    storage.save(vault)
    _LOGGER.info("Category restored from trash: id=%s name=%s", category_id, _redact(category.name))
    return category


@app.delete("/api/categories/{category_id}/purge")
async def purge_category(category_id: str):
    from vault_merge import record_deletion

    bin_data = storage.load_bin()
    category = _find_bin_category(bin_data, category_id)
    bin_data.categories = [c for c in bin_data.categories if c.id != category_id]
    storage.save_bin(bin_data)

    vault = storage.load()
    data = vault.model_dump(mode="json")
    for code in data["codes"]:
        ids = code.get("category_ids") or []
        if category_id in ids:
            code["category_ids"] = [i for i in ids if i != category_id]
    record_deletion(data, "categories", category_id)
    storage.save(Vault.model_validate(data))
    _LOGGER.info("Category purged: id=%s name=%s", category_id, _redact(category.name))
    return {"ok": True}


# --- Codes ---


@app.get("/api/codes")
async def list_codes(category_id: Optional[str] = Query(None)):
    codes = [c for c in storage.load().codes if not c.deleted_at]
    if category_id:
        codes = [c for c in codes if category_id in c.category_ids]
    return codes


def _apply_code_fields(code: MatterCode) -> None:
    if _code_protocol(code) == "zwave":
        code.code_type = "zwave"
        n = normalize_zwave_fields(code.manual_code or "", code.qr_payload or "")
        code.manual_code = str(n["manual_code"])
        code.qr_payload = str(n["qr_payload"])
        code.zwave_pin = str(n.get("zwave_pin", ""))
        return
    if _code_protocol(code) == "homekit":
        code.code_type = "homekit"
        n = normalize_homekit_fields(
            code.manual_code or "",
            code.qr_payload or "",
            homekit_category=code.homekit_category or "other",
            homekit_flag=int(code.homekit_flag or 2),
            setup_id=code.setup_id or "",
        )
        code.manual_code = str(n["manual_code"])
        code.qr_payload = str(n["qr_payload"])
        code.setup_id = str(n.get("setup_id", ""))
        code.homekit_category = str(n.get("homekit_category", "other"))
        code.homekit_flag = int(n.get("homekit_flag", 2))
        return
    if _code_protocol(code) == "other":
        # No parser exists for an unknown standard — store manual_code/qr_payload/
        # custom_standard verbatim, unlike the other 3 branches above.
        code.code_type = "other"
        code.manual_code = (code.manual_code or "").strip()
        code.qr_payload = (code.qr_payload or "").strip()
        code.custom_standard = (code.custom_standard or "").strip()
        return
    code.code_type = "matter"
    normalized = normalize_fields(code.manual_code or "", code.qr_payload or "")
    code.manual_code = normalized["manual_code"]
    code.qr_payload = normalized["qr_payload"]


@app.post("/api/codes", status_code=201)
async def create_code(body: MatterCodeCreate):
    vault = storage.load()
    data = body.model_dump()
    ha_link = data.pop("ha_link", None)
    code = MatterCode(**data)
    _apply_code_fields(code)
    if ha_link:
        code.ha_link = ha_link
    for cid in code.category_ids:
        _find_category(vault, cid)
    dup = _find_duplicate_code(vault, code.model_dump(mode="json"))
    if dup:
        raise HTTPException(409, detail=_dup_detail(dup))
    vault.codes.append(code)
    storage.save(vault)
    _LOGGER.info(
        "Code added: id=%s name=%s protocol=%s", code.id, _redact(code.name), _code_protocol(code)
    )
    return code


@app.put("/api/codes/{code_id}")
async def update_code(code_id: str, body: MatterCodeUpdate):
    vault = storage.load()
    code = _find_code(vault, code_id)
    updates = body.model_dump(exclude_unset=True)
    if "category_ids" in updates:
        for cid in updates["category_ids"]:
            _find_category(vault, cid)
    ha_link = updates.pop("ha_link", None)
    for key, value in updates.items():
        setattr(code, key, value)
    if ha_link is not None:
        code.ha_link = ha_link
    if "manual_code" in updates or "qr_payload" in updates:
        _apply_code_fields(code)
    code.updated_at = utc_now()
    dup = _find_duplicate_code(vault, code.model_dump(mode="json"), exclude_id=code_id)
    if dup:
        raise HTTPException(409, detail=_dup_detail(dup))
    storage.save(vault)
    _LOGGER.info(
        "Code updated: id=%s name=%s fields=%s", code_id, _redact(code.name), sorted(updates.keys())
    )
    return code


def _find_bin_code(bin_data: TrashBin, code_id: str) -> MatterCode:
    for code in bin_data.codes:
        if code.id == code_id:
            return code
    raise HTTPException(404, "Code not found in trash")


@app.delete("/api/codes/{code_id}")
async def delete_code(code_id: str):
    vault = storage.load()
    code = _find_code(vault, code_id)
    vault.codes = [c for c in vault.codes if c.id != code_id]
    storage.save(vault)
    code.deleted_at = utc_now()
    bin_data = storage.load_bin()
    bin_data.codes = [c for c in bin_data.codes if c.id != code_id]
    bin_data.codes.append(code)
    storage.save_bin(bin_data)
    _LOGGER.info("Code moved to trash: id=%s name=%s", code_id, _redact(code.name))
    return {"ok": True}


@app.post("/api/codes/{code_id}/restore")
async def restore_code(code_id: str):
    bin_data = storage.load_bin()
    code = _find_bin_code(bin_data, code_id)
    vault = storage.load()
    dup = _find_duplicate_code(vault, code.model_dump(mode="json"))
    if dup:
        raise HTTPException(409, detail=_dup_detail(dup))
    bin_data.codes = [c for c in bin_data.codes if c.id != code_id]
    storage.save_bin(bin_data)
    code.deleted_at = None
    vault.codes.append(code)
    storage.save(vault)
    _LOGGER.info("Code restored from trash: id=%s name=%s", code_id, _redact(code.name))
    return code


@app.delete("/api/codes/{code_id}/purge")
async def purge_code(code_id: str):
    from vault_merge import record_deletion

    bin_data = storage.load_bin()
    code = _find_bin_code(bin_data, code_id)
    bin_data.codes = [c for c in bin_data.codes if c.id != code_id]
    storage.save_bin(bin_data)

    vault = storage.load()
    data = vault.model_dump(mode="json")
    record_deletion(data, "codes", code_id)
    storage.save(Vault.model_validate(data))
    _LOGGER.info("Code purged: id=%s name=%s", code_id, _redact(code.name))
    return {"ok": True}


@app.get("/api/codes/{code_id}/qr.png")
async def code_qr_png(code_id: str):
    vault = storage.load()
    code = _find_code(vault, code_id)
    proto = _code_protocol(code)
    if proto == "homekit":
        payload = homekit_qr_encode(code.qr_payload or "", code.manual_code or "")
        if not payload:
            raise HTTPException(400, "No HomeKit setup URI stored")
        return StreamingResponse(
            io.BytesIO(homekit_qr_png_bytes(payload)),
            media_type="image/png",
        )
    if proto == "zwave":
        payload = zwave_qr_encode(code.qr_payload or "")
        if not payload:
            raise HTTPException(400, "No Z-Wave SmartStart QR string stored")
        return StreamingResponse(
            io.BytesIO(zwave_qr_png_bytes(payload)),
            media_type="image/png",
        )
    if proto == "other":
        payload = (code.qr_payload or "").strip()
        if not payload:
            raise HTTPException(400, "No QR payload stored")
        return StreamingResponse(
            io.BytesIO(matter_qr_png_bytes(payload)),
            media_type="image/png",
        )
    payload = qr_encode_payload(code.qr_payload or "", code.manual_code or "")
    if not payload:
        raise HTTPException(400, "No MT: QR payload stored")
    return StreamingResponse(
        io.BytesIO(matter_qr_png_bytes(payload)),
        media_type="image/png",
    )


@app.get("/api/codes/{code_id}/label.png")
async def code_label_png(code_id: str):
    vault = storage.load()
    code = _find_code(vault, code_id)
    proto = _code_protocol(code)
    if proto in ("homekit", "zwave"):
        raise HTTPException(400, "Use card.svg for HomeKit or Z-Wave labels")
    try:
        png = label_png_bytes(
            code.manual_code or "",
            code.qr_payload or "",
            code.name or "",
            show_logo=(proto != "other"),
            raw_qr=(proto == "other"),
        )
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    if not png:
        raise HTTPException(404, "No Matter code to render")
    return StreamingResponse(io.BytesIO(png), media_type="image/png")


@app.get("/api/codes/{code_id}/card.svg")
async def code_card_svg(code_id: str, compact: bool = False, hide_code: bool = False):
    vault = storage.load()
    code = _find_code(vault, code_id)
    proto = _code_protocol(code)
    if proto not in ("homekit", "zwave"):
        raise HTTPException(400, "card.svg is only for HomeKit or Z-Wave codes")
    try:
        if proto == "homekit":
            svg = card_svg_for_code(code.model_dump(mode="json"), compact=compact, hide_code=hide_code)
        else:
            svg = zwave_card_svg_for_code(code.model_dump(mode="json"), compact=compact)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    return Response(content=svg, media_type="image/svg+xml; charset=utf-8")


@app.post("/api/codes/{code_id}/save-to-media")
async def save_code_to_media(code_id: str):
    """Also drop a copy of the downloaded label/card image under /media/anti_matter,
    so it shows up in HA's Media browser/SMB share, next to the download the browser gets."""
    vault = storage.load()
    code = _find_code(vault, code_id)
    proto = _code_protocol(code)
    safe = re.sub(r"[^\w.-]+", "_", code.name or "code")
    try:
        MEDIA_DIR.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        raise HTTPException(500, f"Media folder not available: {e}") from e

    if proto in ("homekit", "zwave"):
        try:
            if proto == "homekit":
                svg = card_svg_for_code(code.model_dump(mode="json"))
            else:
                svg = zwave_card_svg_for_code(code.model_dump(mode="json"))
        except ValueError as e:
            raise HTTPException(400, str(e)) from e
        filename = f"antimatter-{safe}.svg"
        (MEDIA_DIR / filename).write_text(svg, encoding="utf-8")
    else:
        try:
            png = label_png_bytes(
                code.manual_code or "",
                code.qr_payload or "",
                code.name or "",
                show_logo=(proto != "other"),
                raw_qr=(proto == "other"),
            )
        except ValueError as e:
            raise HTTPException(400, str(e)) from e
        if not png:
            raise HTTPException(404, "No Matter code to render")
        filename = f"antimatter-{safe}.png"
        (MEDIA_DIR / filename).write_bytes(png)

    _LOGGER.info("Saved to media: code=%s file=%s", code_id, filename)
    return {"ok": True, "path": f"/media/anti_matter/{filename}"}


# --- Home Assistant ---


@app.get("/api/ha/entities")
async def ha_entities(domain: Optional[str] = Query(None)):
    return await ha.list_entities(domain)


@app.get("/api/ha/areas")
async def ha_areas():
    return await ha.list_areas()


@app.get("/api/ha/attribute")
async def ha_attribute(entity_id: str, attribute: str):
    value = await ha.get_attribute(entity_id, attribute)
    if value is None:
        raise HTTPException(404, "Entity or attribute not found")
    return {"entity_id": entity_id, "attribute": attribute, "value": value}


@app.get("/api/matter/vendor/{vendor_id}")
async def matter_vendor_info(vendor_id: int):
    info = await fetch_vendor_info(vendor_id)
    if info is None:
        raise HTTPException(404, "No official vendor record found")
    return info


@app.get("/api/matter/model/{vendor_id}/{product_id}")
async def matter_model_info(vendor_id: int, product_id: int):
    info = await fetch_model_info(vendor_id, product_id)
    if info is None:
        raise HTTPException(404, "No official product record found")
    return info


@app.get("/api/zwave/device/{manufacturer_id}/{product_type}/{product_id}")
async def zwave_device_info(manufacturer_id: int, product_type: int, product_id: int):
    info = lookup_zwave_device(manufacturer_id, product_type, product_id)
    if info is None:
        raise HTTPException(404, "No known device record found")
    return info


@app.get("/api/ha/devices")
async def ha_devices():
    """[{id, name}] for every HA device — populates the device-picker in the code
    dialog so ha_link stores a device_id directly (linking to its own HA page),
    with no entity_id involved."""
    return await ha.list_devices()


# --- Static UI (relative paths for ingress) ---

if os.path.isdir(STATIC_DIR):
    app.mount("/static", IngressStaticFiles(directory=STATIC_DIR), name="static")


@app.get("/")
async def index():
    index_path = os.path.join(STATIC_DIR, "index.html")
    if os.path.isfile(index_path):
        # The entry page itself was the one thing NOT forced to revalidate (only
        # /static/* got that treatment) — a browser-cached stale index.html keeps
        # pointing at old ?v=... asset URLs forever, which looks like "the add-on
        # never picks up updates" even though the new files are already on disk.
        return FileResponse(
            index_path,
            headers={"Cache-Control": "no-store"},
        )
    return JSONResponse({"service": "anti-matter", "version": APP_VERSION})


if __name__ == "__main__":
    uvicorn.run(
        app,
        host="0.0.0.0",
        port=PORT,
        log_level="info",
        access_log=False,  # replaced by access_log_middleware (filters routine polling)
    )
