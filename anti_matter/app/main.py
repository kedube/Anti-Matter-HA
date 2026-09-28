"""Anti-Matter — Home Assistant add-on API and ingress UI.

Error responses
---------------
Every error the UI may show is JSON ``{"detail": {"error": <code>, "message": <English
text>, ...extra}}``. ``error`` is a stable machine-readable code the UI localizes;
``message`` is the English fallback. Status codes are part of the contract too.

    code                         status  raised by / extra keys
    ---------------------------  ------  ------------------------------------------------
    duplicate                    409     POST/PUT /api/codes, POST /api/codes/{id}/restore;
                                         extra ``existing: {id, name}``
    category_name_taken          409     POST/PUT /api/categories; extra ``existing: {id, name}``
    category_not_found           404     unknown category id (routes and code category_ids)
    category_not_in_trash        404     restore/purge of a category that is not in the bin
    code_not_found               404     unknown code id
    code_not_in_trash            404     restore/purge of a code that is not in the bin
    no_qr_payload                400     qr.png / qr.svg / POST /api/qr.svg with nothing
                                         scannable; extra ``protocol``
    qr_payload_too_long          400     payload does not fit in a QR code
    unsupported_protocol         400     label.png for HomeKit/Z-Wave, card.svg for Matter/Other
    invalid_code                 400     label/card renderer rejected the stored code
    nothing_to_render            404     label.png / save-to-media: no manual code and no QR
    invalid_import               400     POST /api/import: not a valid vault export
    invalid_upload               400     save-to-media: bad PNG/SVG, or unsafe SVG content
    unsupported_media_type       415     save-to-media: image body that is not PNG or SVG
    too_large                    413     save-to-media: upload over 8 MB
    media_unavailable            500     save-to-media: /media folder missing or not writable
    ha_attribute_not_found       404     GET /api/ha/attribute
    invalid_request              422     request body/query failed validation; extra ``errors``
    not_found / method_not_allowed / bad_request / http_error
                                         fallback for framework errors (unknown route etc.)

The Matter DCL and Z-Wave device lookups (``/api/matter/vendor|model``,
``/api/zwave/device``) answer 204 No Content when there is simply no record — an
expected outcome rather than an error.
"""

from __future__ import annotations

import asyncio
import io
import json
import logging
import os
import re
from contextlib import asynccontextmanager
from datetime import datetime
from typing import Any, Optional

import uvicorn
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exception_handlers import http_exception_handler
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.staticfiles import StaticFiles
from starlette.types import Scope
from pydantic import BaseModel
from qrcode.exceptions import DataOverflowError

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
from options import UI_LANGUAGES, norm_language, norm_theme, opt
from matter_label import label_png_bytes
from matter_qr_image import qr_png_bytes as matter_qr_png_bytes
from matter_payload import normalize_fields, qr_encode_payload
from matter_setup_payload import ParsedSetupPayload, parse_manual_payload, parse_qr_payload
from homekit_label import card_svg_for_code
from homekit_qr_image import qr_png_bytes as homekit_qr_png_bytes
from homekit_payload import (
    decode_pairing_from_uri as homekit_decode_pairing,
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
    parse_qr_digits as zwave_parse_qr,
    qr_encode_payload as zwave_qr_encode,
    _digits_only as zwave_digits_only,
)
from zwave_device_db import lookup_device as lookup_zwave_device
from models import Vault
from qr_svg import DEFAULT_BORDER as QR_DEFAULT_BORDER, clamp_border, qr_svg
from storage import VaultStorage

logging.basicConfig(level=logging.INFO)
_LOGGER = logging.getLogger("anti_matter")
# Quiet the noisy library loggers — our own access_log_middleware below replaces
# uvicorn's per-request line, and httpx's default request line is redundant with it.
logging.getLogger("uvicorn.access").setLevel(logging.WARNING)
logging.getLogger("httpx").setLevel(logging.WARNING)

APP_VERSION = "3.0.1"
PORT = int(os.environ.get("ANTIMATTER_PORT", "8099"))
STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")

# UI locales the front end ships translations for (static/locales/<code>.json), reported
# by /api/info so the UI offers exactly the languages it can render.
SUPPORTED_UI_LANGUAGES: list[str] = list(UI_LANGUAGES)
LOCALES_DIR = os.path.join(STATIC_DIR, "locales")


def _translation_files() -> list[str]:
    """UI languages that have a static/locales/<code>.json file right now. The UI loads only
    these (others fall back to English without a failing request, so no console 404)."""
    return [code for code in SUPPORTED_UI_LANGUAGES if os.path.isfile(os.path.join(LOCALES_DIR, code + ".json"))]

# Optional: also save a copy of downloaded QR/label images under HA's Media folder
# (map: media:rw -> /media), in its own subfolder so it doesn't clutter the root.
from pathlib import Path as _Path

MEDIA_DIR = _Path(os.environ.get("ANTIMATTER_MEDIA", "/media")) / "anti_matter"
# Cap for a client-rendered image posted to save-to-media (read in chunks, never whole).
MAX_MEDIA_UPLOAD_BYTES = 8 * 1024 * 1024

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


def _api_error(status: int, error: str, message: str, **extra: Any) -> HTTPException:
    """HTTPException whose detail carries a stable ``error`` code (see module docstring)
    next to the English ``message``; ``extra`` keys (e.g. ``existing``) are passed through."""
    return HTTPException(status, detail={"error": error, "message": message, **extra})


def _find_category(vault, category_id: str) -> Category:
    for cat in vault.categories:
        if cat.id == category_id:
            return cat
    raise _api_error(404, "category_not_found", "Category not found")


def _check_category_ids(vault, category_ids: list[str]) -> None:
    """Reject unknown category ids on a code, but accept ones whose category is in the
    Trash: a code keeps those links so restoring the category re-attaches it (the UI
    shows such codes as uncategorized meanwhile)."""
    live = {c.id for c in vault.categories}
    missing = [cid for cid in category_ids if cid not in live]
    if not missing:
        return
    trashed = {c.id for c in storage.load_bin().categories}
    for cid in missing:
        if cid not in trashed:
            raise _api_error(404, "category_not_found", "Category not found")


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
    raise _api_error(404, "code_not_found", "Code not found")


def _normalize_manual_key(value: str) -> str:
    """Matter manual-code digits (11-digit short or 21-digit long form), else ''."""
    digits = "".join(c for c in (value or "") if c.isdigit())
    return digits if len(digits) in (11, 21) else ""


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


def _matter_identities(manual_code: str, qr_payload: str) -> list[ParsedSetupPayload]:
    """Every device a Matter code identifies: each ``*``-separated QR payload plus the
    manual code (Verhoeff-checked). Unparseable parts are skipped."""
    out: list[ParsedSetupPayload] = []
    qr_key = _normalize_qr_key(qr_payload)
    if qr_key:
        for chunk in qr_key[3:].split("*"):
            try:
                out.append(parse_qr_payload("MT:" + chunk))
            except ValueError:
                pass
    manual_key = _normalize_manual_key(manual_code)
    if manual_key:
        try:
            out.append(parse_manual_payload(manual_key))
        except ValueError:
            pass
    return out


def _same_matter_device(a: ParsedSetupPayload, b: ParsedSetupPayload) -> bool:
    """Same passcode and same discriminator, across manual/QR forms.

    A QR carries the 12-bit long discriminator, a manual code only its top 4 bits (the
    short one, ``long >> 8``): compare long values when both sides have them, else short.
    """
    if a.pincode != b.pincode:
        return False
    if a.long_discriminator is not None and b.long_discriminator is not None:
        return a.long_discriminator == b.long_discriminator
    return a.short_discriminator == b.short_discriminator


def _homekit_pins(manual_code: str, qr_payload: str) -> set[str]:
    """8-digit pairing codes of a HomeKit code: typed digits and/or decoded from X-HM://."""
    pins = {homekit_pairing_digits(manual_code or "")}
    if parse_setup_uri(qr_payload or ""):
        pins.add(homekit_decode_pairing(qr_payload or ""))
    pins.discard("")
    return pins


def _zwave_dsks(manual_code: str, qr_payload: str) -> set[str]:
    """40-digit DSKs of a Z-Wave code: a bare DSK and/or the one inside a SmartStart QR."""
    dsks: set[str] = set()
    manual = zwave_digits_only(manual_code or "")
    if len(manual) == 40:
        dsks.add(manual)
    qr = zwave_extract_qr(qr_payload or "")
    parsed = zwave_parse_qr(qr) if qr else None
    if parsed:
        dsks.add(zwave_digits_only(parsed["dsk"]))
    return dsks


def _other_key(value: str) -> str:
    """Case-insensitive, whitespace-collapsed key for codes of an unknown standard."""
    return " ".join((value or "").split()).casefold()


def _find_duplicate_code(
    vault: Vault, candidate: dict, exclude_id: str | None = None
) -> MatterCode | None:
    """First live code that is the same device as ``candidate`` (same protocol only).

    - matter: same 11/21-digit manual code, same MT: string (case-insensitive), or any
      pair of identities (manual and/or each ``*`` QR payload) that _same_matter_device.
    - homekit: shared 8-digit pairing code (typed or decoded from the URI), or same URI.
    - zwave: shared 40-digit DSK (bare or inside the SmartStart QR), or same QR digits.
    - other: manual or QR equal after whitespace collapse, case-insensitively.
    """
    proto = _code_protocol(candidate)
    manual = str(candidate.get("manual_code") or "")
    qr = str(candidate.get("qr_payload") or "")

    def others():
        for existing in vault.codes:
            if exclude_id and existing.id == exclude_id:
                continue
            if _code_protocol(existing) == proto:
                yield existing

    if proto == "zwave":
        dsks = _zwave_dsks(manual, qr)
        qr_key = zwave_extract_qr(qr)
        if not dsks and not qr_key:
            return None
        for existing in others():
            if dsks & _zwave_dsks(existing.manual_code, existing.qr_payload):
                return existing
            if qr_key and qr_key == zwave_extract_qr(existing.qr_payload):
                return existing
        return None
    if proto == "homekit":
        pins = _homekit_pins(manual, qr)
        qr_key = _normalize_homekit_qr_key(qr)
        if not pins and not qr_key:
            return None
        for existing in others():
            if pins & _homekit_pins(existing.manual_code, existing.qr_payload):
                return existing
            if qr_key and qr_key == _normalize_homekit_qr_key(existing.qr_payload):
                return existing
        return None
    if proto == "other":
        # No parser exists for an unknown standard, so dedup is an exact match on the
        # raw values, only forgiving letter case and whitespace (spaces, line breaks).
        man_key = _other_key(manual)
        qr_key = _other_key(qr)
        if not man_key and not qr_key:
            return None
        for existing in others():
            if man_key and man_key == _other_key(existing.manual_code):
                return existing
            if qr_key and qr_key == _other_key(existing.qr_payload):
                return existing
        return None
    man_key = _normalize_manual_key(manual)
    qr_key = _normalize_qr_key(qr)
    idents = _matter_identities(manual, qr)
    if not man_key and not qr_key:
        return None
    for existing in others():
        if man_key and man_key == _normalize_manual_key(existing.manual_code):
            return existing
        if qr_key and qr_key == _normalize_qr_key(existing.qr_payload):
            return existing
        if idents:
            theirs = _matter_identities(existing.manual_code, existing.qr_payload)
            if any(_same_matter_device(a, b) for a in idents for b in theirs):
                return existing
    return None


def _dup_detail(dup: MatterCode) -> dict[str, Any]:
    return {
        "error": "duplicate",
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

_GENERIC_HTTP_ERRORS = {
    400: "bad_request",
    404: "not_found",
    405: "method_not_allowed",
    413: "too_large",
    415: "unsupported_media_type",
}


@app.exception_handler(StarletteHTTPException)
async def coded_http_exception_handler(request: Request, exc: StarletteHTTPException):
    """Give framework-raised errors (unknown route, wrong method) the same
    ``{error, message}`` detail shape as our own; coded details pass through untouched."""
    if not isinstance(exc.detail, dict):
        exc.detail = {
            "error": _GENERIC_HTTP_ERRORS.get(exc.status_code, "http_error"),
            "message": str(exc.detail),
        }
    return await http_exception_handler(request, exc)


@app.exception_handler(RequestValidationError)
async def coded_validation_exception_handler(request: Request, exc: RequestValidationError):
    """422 keeps FastAPI's per-field ``errors`` list, wrapped in the coded detail shape.
    Nothing is logged here: the offending input may be a pairing code."""
    return JSONResponse(
        status_code=422,
        content={
            "detail": {
                "error": "invalid_request",
                "message": "Invalid request",
                "errors": jsonable_encoder(exc.errors()),
            }
        },
    )


# Requests polled every few seconds by the UI (vault refresh, live status) are noise —
# log everything else (mutations, errors, one-off page loads).
_QUIET_GET_PATHS = {"/", "/api/vault", "/api/info"}
# Read-only POSTs fired on every keystroke by the editor / scanner (live QR preview,
# duplicate check). POST only so the payloads stay out of URLs and logs.
_QUIET_POST_PATHS = {"/api/qr.svg", "/api/codes/check-duplicate"}


@app.middleware("http")
async def access_log_middleware(request: Request, call_next):
    response = await call_next(request)
    path = request.url.path
    quiet = response.status_code < 400 and (
        (
            request.method == "GET"
            and (
                path in _QUIET_GET_PATHS
                or path.startswith("/static/")
                or (path.startswith("/api/codes/") and path.endswith((".png", ".svg")))
            )
        )
        or (request.method == "POST" and path in _QUIET_POST_PATHS)
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
        "languages": list(SUPPORTED_UI_LANGUAGES),
        "translations": _translation_files(),
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


def _check_import_shape(data: str) -> None:
    """Refuse JSON that is not a vault export. A non-merge import replaces the whole
    vault, and the lenient sanitizer would turn e.g. ``{}`` into an empty one."""
    raw = json.loads(data)
    if not isinstance(raw, dict):
        raise ValueError("not an Anti-Matter export (expected a JSON object)")
    present = [k for k in ("codes", "categories") if k in raw]
    if not present:
        raise ValueError("not an Anti-Matter export (no codes or categories)")
    for key in present:
        if not isinstance(raw[key], list):
            raise ValueError(f"'{key}' must be a list")


@app.post("/api/import")
async def import_vault(body: ImportBody):
    try:
        _check_import_shape(body.data)
        vault = storage.import_json(body.data, merge=body.merge)
    except Exception as exc:
        # Validation errors quote the offending input (possibly a code): redact for the log.
        _LOGGER.warning("Vault import failed (merge=%s): %s", body.merge, _redact(exc))
        raise _api_error(400, "invalid_import", f"Invalid JSON: {exc}") from exc
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
        raise HTTPException(409, detail=_category_dup_detail(dup))
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
            raise HTTPException(409, detail=_category_dup_detail(dup))
    for key, value in updates.items():
        setattr(category, key, value)
    storage.save(vault)
    _LOGGER.info("Category updated: id=%s name=%s", category_id, _redact(category.name))
    return category


def _category_dup_detail(dup: Category) -> dict[str, Any]:
    return {
        "error": "category_name_taken",
        "message": f"A category named “{dup.name}” already exists",
        "existing": {"id": dup.id, "name": dup.name},
    }


def _find_bin_category(bin_data: TrashBin, category_id: str) -> Category:
    for cat in bin_data.categories:
        if cat.id == category_id:
            return cat
    raise _api_error(404, "category_not_in_trash", "Category not found in trash")


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
    _check_category_ids(vault, code.category_ids)
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
        _check_category_ids(vault, updates["category_ids"])
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
    raise _api_error(404, "code_not_in_trash", "Code not found in trash")


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


# PNG renderer per protocol; "other" payloads reuse the plain Matter renderer. The SVG
# renderer (qr_svg.QR_PROFILES) mirrors each one's error-correction level and version.
_QR_PNG_RENDERERS = {
    "matter": matter_qr_png_bytes,
    "homekit": homekit_qr_png_bytes,
    "zwave": zwave_qr_png_bytes,
    "other": matter_qr_png_bytes,
}


def _qr_too_long() -> HTTPException:
    return _api_error(400, "qr_payload_too_long", "Payload is too long to fit in a QR code")


def _qr_payload_for(code: MatterCode) -> tuple[str, str]:
    """(payload, protocol) that the code's QR image encodes.

    Single source for qr.png, qr.svg and the POST /api/qr.svg preview, so every QR the
    UI shows for a code carries the same string. Raises 400 ``no_qr_payload`` when
    there is nothing scannable (e.g. a Matter code with only a manual code).
    """
    proto = _code_protocol(code)
    if proto == "homekit":
        payload = homekit_qr_encode(code.qr_payload or "", code.manual_code or "")
        missing = "No HomeKit setup URI stored"
    elif proto == "zwave":
        payload = zwave_qr_encode(code.qr_payload or "")
        missing = "No Z-Wave SmartStart QR string stored"
    elif proto == "other":
        payload = (code.qr_payload or "").strip()
        missing = "No QR payload stored"
    else:
        payload = qr_encode_payload(code.qr_payload or "", code.manual_code or "")
        missing = "No MT: QR payload stored"
    if not payload:
        raise _api_error(400, "no_qr_payload", missing, protocol=proto)
    return payload, proto


def _qr_svg_response(code: MatterCode, border: int) -> Response:
    payload, proto = _qr_payload_for(code)
    try:
        svg = qr_svg(payload, proto, border=clamp_border(border))
    except DataOverflowError as e:
        raise _qr_too_long() from e
    return Response(content=svg, media_type="image/svg+xml")


class CodePayloadBody(BaseModel):
    """Payload-bearing fields of an unsaved code (scanner result sheet, editor preview)."""

    code_type: Optional[str] = "matter"
    qr_payload: Optional[str] = ""
    manual_code: Optional[str] = ""
    setup_id: Optional[str] = ""
    homekit_category: Optional[str] = "other"
    homekit_flag: Optional[int] = 2
    custom_standard: Optional[str] = ""


class DuplicateCheckBody(CodePayloadBody):
    exclude_id: Optional[str] = None  # the code being edited, if any


def _preview_code(body: CodePayloadBody) -> MatterCode:
    """The code exactly as create/update WOULD store it (same normalization)."""
    code = MatterCode(
        name="",
        code_type=body.code_type or "matter",
        qr_payload=body.qr_payload or "",
        manual_code=body.manual_code or "",
        setup_id=body.setup_id or "",
        homekit_category=body.homekit_category or "other",
        homekit_flag=body.homekit_flag if body.homekit_flag is not None else 2,
        custom_standard=body.custom_standard or "",
    )
    _apply_code_fields(code)
    return code


@app.post("/api/codes/check-duplicate")
async def check_duplicate_code(body: DuplicateCheckBody):
    """Would saving this input hit the duplicate 409? Same rules as create/update, so the
    scanner can warn before the editor opens. ``{"duplicate": null | {error, message,
    existing}}``. Never logged (the body is a pairing code)."""
    vault = storage.load()
    code = _preview_code(body)
    dup = _find_duplicate_code(vault, code.model_dump(mode="json"), exclude_id=body.exclude_id)
    return {"duplicate": _dup_detail(dup) if dup else None}


@app.post("/api/qr.svg")
async def preview_qr_svg(body: CodePayloadBody, border: int = Query(QR_DEFAULT_BORDER)):
    """Vector QR for what an unsaved code WOULD encode once stored (scanner result sheet,
    editor live preview). POST so payloads never land in URLs or logs."""
    response = _qr_svg_response(_preview_code(body), border)
    response.headers["Cache-Control"] = "no-store"
    return response


@app.get("/api/codes/{code_id}/qr.png")
async def code_qr_png(code_id: str):
    vault = storage.load()
    code = _find_code(vault, code_id)
    payload, proto = _qr_payload_for(code)
    try:
        png = _QR_PNG_RENDERERS[proto](payload)
    except (DataOverflowError, ValueError) as e:  # qrcode 8: ValueError past version 40
        raise _qr_too_long() from e
    return StreamingResponse(io.BytesIO(png), media_type="image/png")


@app.get("/api/codes/{code_id}/qr.svg")
async def code_qr_svg(code_id: str, border: int = Query(QR_DEFAULT_BORDER)):
    """Same payload and error correction as qr.png, as a crisp vector: viewBox in module
    units, ``?border=N`` quiet zone in modules (default 4, clamped to 0..8)."""
    vault = storage.load()
    code = _find_code(vault, code_id)
    return _qr_svg_response(code, border)


@app.get("/api/codes/{code_id}/label.png")
async def code_label_png(code_id: str):
    vault = storage.load()
    code = _find_code(vault, code_id)
    proto = _code_protocol(code)
    if proto in ("homekit", "zwave"):
        raise _api_error(
            400, "unsupported_protocol", "Use card.svg for HomeKit or Z-Wave labels", protocol=proto
        )
    try:
        png = label_png_bytes(
            code.manual_code or "",
            code.qr_payload or "",
            code.name or "",
            show_logo=(proto != "other"),
            raw_qr=(proto == "other"),
        )
    except ValueError as e:
        raise _api_error(400, "invalid_code", str(e)) from e
    except DataOverflowError as e:
        raise _qr_too_long() from e
    if not png:
        raise _api_error(404, "nothing_to_render", "No Matter code to render")
    return StreamingResponse(io.BytesIO(png), media_type="image/png")


@app.get("/api/codes/{code_id}/card.svg")
async def code_card_svg(code_id: str, compact: bool = False, hide_code: bool = False):
    vault = storage.load()
    code = _find_code(vault, code_id)
    proto = _code_protocol(code)
    if proto not in ("homekit", "zwave"):
        raise _api_error(
            400, "unsupported_protocol", "card.svg is only for HomeKit or Z-Wave codes", protocol=proto
        )
    try:
        if proto == "homekit":
            svg = card_svg_for_code(code.model_dump(mode="json"), compact=compact, hide_code=hide_code)
        else:
            svg = zwave_card_svg_for_code(code.model_dump(mode="json"), compact=compact)
    except ValueError as e:
        raise _api_error(400, "invalid_code", str(e)) from e
    except DataOverflowError as e:
        raise _qr_too_long() from e
    return Response(content=svg, media_type="image/svg+xml; charset=utf-8")


# --- save-to-media: optional client-rendered upload ---

_PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
_UPLOAD_EXTENSIONS = {"image/png": "png", "image/svg+xml": "svg"}
# Anything that could run script or pull a remote resource when HA's media browser, or
# a browser opening the file from the Samba share, renders an uploaded SVG.
_SVG_FORBIDDEN = (
    re.compile(r"<\s*script", re.I),
    re.compile(r"(?:^|[\s/\"'])on[a-z]+\s*=", re.I),  # event-handler attributes
    re.compile(r"javascript\s*:", re.I),
    re.compile(r"<\s*(?:foreignObject|iframe|embed|object)\b", re.I),
    re.compile(r"<!\s*(?:DOCTYPE|ENTITY)", re.I),
    re.compile(r"@import", re.I),
    re.compile(r"attributeName\s*=\s*[\"']?\s*(?:xlink:)?href", re.I),  # SMIL href swap
    re.compile(r"\\[0-9a-f]", re.I),  # CSS escapes could spell url( / @import
)
# Every href="…" / url(…) must point inside the document or be an inline raster image.
_SVG_REFERENCE = re.compile(r"(?:\bhref\s*=|\burl\s*\()\s*[\"']?\s*([^\s\"'()>]*)", re.I)
_SVG_SAFE_TARGET = re.compile(r"#|data:image/(?:png|jpe?g|gif|webp);base64,", re.I)


async def _read_body_capped(request: Request, limit: int) -> bytes:
    """Raw request body, streamed in chunks; 413 ``too_large`` as soon as it passes ``limit``."""
    too_large = _api_error(413, "too_large", f"Upload exceeds {limit // (1024 * 1024)} MB")
    declared = request.headers.get("content-length", "")
    if declared.isdigit() and int(declared) > limit:
        raise too_large
    buf = bytearray()
    async for chunk in request.stream():
        buf.extend(chunk)
        if len(buf) > limit:
            raise too_large
    return bytes(buf)


def _validate_upload(body: bytes, media_type: str) -> None:
    """400 ``invalid_upload`` unless ``body`` is a real PNG, or an SVG with no script,
    event handlers, javascript: URLs or external references."""
    if media_type == "image/png":
        if not body.startswith(_PNG_MAGIC):
            raise _api_error(400, "invalid_upload", "Not a PNG image")
        try:
            from PIL import Image

            with Image.open(io.BytesIO(body)) as img:
                img.verify()
        except Exception as e:
            raise _api_error(400, "invalid_upload", "Corrupt PNG image") from e
        return
    try:
        text = body.decode("utf-8")
    except UnicodeDecodeError as e:
        raise _api_error(400, "invalid_upload", "SVG must be UTF-8 text") from e
    head = text.lstrip("﻿").lstrip()
    if not head.startswith(("<svg", "<?xml")) or "<svg" not in head or "\x00" in text:
        raise _api_error(400, "invalid_upload", "Not an SVG image")
    unsafe = any(p.search(text) for p in _SVG_FORBIDDEN) or any(
        not _SVG_SAFE_TARGET.match(m.group(1)) for m in _SVG_REFERENCE.finditer(text)
    )
    if unsafe:
        raise _api_error(400, "invalid_upload", "SVG contains scripts or external references")


def _write_media(filename: str, data: bytes | str) -> None:
    try:
        if isinstance(data, str):
            (MEDIA_DIR / filename).write_text(data, encoding="utf-8")
        else:
            (MEDIA_DIR / filename).write_bytes(data)
    except OSError as e:
        raise _api_error(500, "media_unavailable", f"Media folder not writable: {e}") from e


@app.post("/api/codes/{code_id}/save-to-media")
async def save_code_to_media(code_id: str, request: Request):
    """Also drop a copy of the downloaded label/card image under /media/anti_matter,
    so it shows up in HA's Media browser/SMB share, next to the download the browser gets.

    With a raw ``image/png`` or ``image/svg+xml`` body (max 8 MB) that exact
    client-rendered image is validated and saved; with no body the server renders the
    label (Matter/Other, PNG) or card (HomeKit/Z-Wave, SVG) as before. Other body types
    (e.g. the UI's default JSON header with no body) are ignored.
    """
    vault = storage.load()
    code = _find_code(vault, code_id)
    proto = _code_protocol(code)
    safe = re.sub(r"[^\w.-]+", "_", code.name or "code")

    media_type = (request.headers.get("content-type") or "").split(";", 1)[0].strip().lower()
    upload = b""
    if media_type.startswith("image/"):
        upload = await _read_body_capped(request, MAX_MEDIA_UPLOAD_BYTES)
        if upload and media_type not in _UPLOAD_EXTENSIONS:
            raise _api_error(
                415, "unsupported_media_type", "Upload must be image/png or image/svg+xml"
            )
        if upload:
            _validate_upload(upload, media_type)

    try:
        MEDIA_DIR.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        raise _api_error(500, "media_unavailable", f"Media folder not available: {e}") from e

    if upload:
        filename = f"antimatter-{safe}.{_UPLOAD_EXTENSIONS[media_type]}"
        _write_media(filename, upload)
        source = "upload"
    elif proto in ("homekit", "zwave"):
        try:
            if proto == "homekit":
                svg = card_svg_for_code(code.model_dump(mode="json"))
            else:
                svg = zwave_card_svg_for_code(code.model_dump(mode="json"))
        except ValueError as e:
            raise _api_error(400, "invalid_code", str(e)) from e
        except DataOverflowError as e:
            raise _qr_too_long() from e
        filename = f"antimatter-{safe}.svg"
        _write_media(filename, svg)
        source = "server"
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
            raise _api_error(400, "invalid_code", str(e)) from e
        except DataOverflowError as e:
            raise _qr_too_long() from e
        if not png:
            raise _api_error(404, "nothing_to_render", "No Matter code to render")
        filename = f"antimatter-{safe}.png"
        _write_media(filename, png)
        source = "server"

    _LOGGER.info(
        "Saved to media: code=%s file=%s source=%s", code_id, _redact(filename), source
    )
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
        raise _api_error(404, "ha_attribute_not_found", "Entity or attribute not found")
    return {"entity_id": entity_id, "attribute": attribute, "value": value}


@app.get("/api/matter/vendor/{vendor_id}")
async def matter_vendor_info(vendor_id: int):
    info = await fetch_vendor_info(vendor_id)
    if info is None:
        # No record is an expected outcome, not an error: 204 keeps the browser
        # console clean (a 404 is always logged as a failed resource load).
        return Response(status_code=204)
    return info


@app.get("/api/matter/model/{vendor_id}/{product_id}")
async def matter_model_info(vendor_id: int, product_id: int):
    info = await fetch_model_info(vendor_id, product_id)
    if info is None:
        # No record is an expected outcome, not an error: 204 keeps the browser
        # console clean (a 404 is always logged as a failed resource load).
        return Response(status_code=204)
    return info


@app.get("/api/zwave/device/{manufacturer_id}/{product_type}/{product_id}")
async def zwave_device_info(manufacturer_id: int, product_type: int, product_id: int):
    info = lookup_zwave_device(manufacturer_id, product_type, product_id)
    if info is None:
        # No record is an expected outcome, not an error: 204 keeps the browser
        # console clean (a 404 is always logged as a failed resource load).
        return Response(status_code=204)
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
