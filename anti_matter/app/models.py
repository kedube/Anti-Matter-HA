"""Pydantic models for Anti-Matter vault data."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional
from uuid import uuid4

from pydantic import BaseModel, Field, field_validator, model_validator

from category_icons import normalize as normalize_category_icon


def utc_now() -> str:
    """UTC Z timestamp, no fractional seconds (stable for import/export merges)."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class Category(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid4()))
    name: str
    color: str = "#6366f1"
    icon: str = "folder"
    sort_order: int = 0
    deleted_at: Optional[str] = None  # set when moved to trash; cleared on restore

    @field_validator("icon")
    @classmethod
    def _icon(cls, value: str) -> str:
        return normalize_category_icon(value)


class HaLink(BaseModel):
    device_id: Optional[str] = None


class MatterCode(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid4()))
    name: str
    code_type: str = "matter"  # matter | homekit | zwave | other
    device_type: str = ""
    device_vendor: str = ""  # e.g. IKEA
    device_product: str = ""  # e.g. MYGGBETT
    area: str = ""  # e.g. Woonkamer (free text or HA area name)
    description: str = ""
    category_ids: list[str] = Field(default_factory=list)
    manual_code: str = ""
    qr_payload: str = ""
    custom_standard: str = ""  # free-text protocol name for code_type "other", e.g. "Tuya"
    setup_id: str = ""  # HomeKit 4-char setup ID
    homekit_category: str = "other"
    homekit_flag: int = 2
    zwave_pin: str = ""  # first 5 digits of DSK (S2 PIN)
    notes: str = ""
    in_use: bool = False  # device is currently deployed (vs. spare/stock)
    conn_wifi: bool = False
    conn_matter: bool = False
    conn_zigbee: bool = False
    conn_bluetooth: bool = False
    conn_zwave: bool = False
    ha_link: HaLink = Field(default_factory=HaLink)
    created_at: str = Field(default_factory=utc_now)
    updated_at: str = Field(default_factory=utc_now)
    deleted_at: Optional[str] = None  # set when moved to trash; cleared on restore

    @field_validator("code_type")
    @classmethod
    def _code_type(cls, value: str) -> str:
        v = (value or "matter").strip().lower()
        if v in ("matter", "homekit", "zwave", "other"):
            return v
        return "matter"


class TrashBin(BaseModel):
    """Soft-deleted categories/codes, stored in their own file (own SMB share entry)."""

    categories: list[Category] = Field(default_factory=list)
    codes: list[MatterCode] = Field(default_factory=list)

    @model_validator(mode="before")
    @classmethod
    def _migrate_codes(cls, data: object) -> object:
        if isinstance(data, dict) and isinstance(data.get("codes"), list):
            from vault_merge import _migrate_category_id

            data = dict(data)
            data["codes"] = [_migrate_category_id(c) for c in data["codes"]]
        return data


class VaultDeletions(BaseModel):
    """Tombstones so deletes propagate correctly across import/export merges."""

    codes: dict[str, str] = Field(default_factory=dict)
    categories: dict[str, str] = Field(default_factory=dict)

    @field_validator("codes", "categories", mode="before")
    @classmethod
    def _coerce_deletion_map(cls, value: object) -> dict[str, str]:
        if isinstance(value, dict) and not isinstance(value, list):
            return {str(k): str(v) for k, v in value.items() if k and v}
        return {}


class VaultMeta(BaseModel):
    version: int = 1
    exported_at: Optional[str] = None
    addon_version: str = "2.0.5"
    source: Optional[str] = None
    deletions: VaultDeletions = Field(default_factory=VaultDeletions)


class Vault(BaseModel):
    meta: VaultMeta = Field(default_factory=VaultMeta)
    categories: list[Category] = Field(default_factory=list)
    codes: list[MatterCode] = Field(default_factory=list)

    @model_validator(mode="before")
    @classmethod
    def _sanitize_raw(cls, data: object) -> object:
        if isinstance(data, dict):
            from vault_merge import sanitize_vault_dict

            return sanitize_vault_dict(data)
        return data


class CategoryCreate(BaseModel):
    name: str
    color: str = "#6366f1"
    icon: str = "folder"
    sort_order: int = 0

    @field_validator("icon")
    @classmethod
    def _icon(cls, value: str) -> str:
        return normalize_category_icon(value)


class CategoryUpdate(BaseModel):
    name: Optional[str] = None
    color: Optional[str] = None
    icon: Optional[str] = None
    sort_order: Optional[int] = None

    @field_validator("icon")
    @classmethod
    def _icon(cls, value: Optional[str]) -> Optional[str]:
        return normalize_category_icon(value) if value is not None else value


class MatterCodeCreate(BaseModel):
    name: str
    code_type: str = "matter"
    device_type: str = ""
    device_vendor: str = ""
    device_product: str = ""
    area: str = ""
    description: str = ""
    category_ids: list[str] = Field(default_factory=list)
    manual_code: str = ""
    qr_payload: str = ""
    custom_standard: str = ""
    setup_id: str = ""
    homekit_category: str = "other"
    homekit_flag: int = 2
    zwave_pin: str = ""
    notes: str = ""
    in_use: bool = False
    conn_wifi: bool = False
    conn_matter: bool = False
    conn_zigbee: bool = False
    conn_bluetooth: bool = False
    conn_zwave: bool = False
    ha_link: Optional[HaLink] = None


class MatterCodeUpdate(BaseModel):
    name: Optional[str] = None
    code_type: Optional[str] = None
    device_type: Optional[str] = None
    device_vendor: Optional[str] = None
    device_product: Optional[str] = None
    area: Optional[str] = None
    description: Optional[str] = None
    category_ids: list[str] = Field(default_factory=list)
    manual_code: Optional[str] = None
    qr_payload: Optional[str] = None
    custom_standard: Optional[str] = None
    setup_id: Optional[str] = None
    homekit_category: Optional[str] = None
    homekit_flag: Optional[int] = None
    zwave_pin: Optional[str] = None
    notes: Optional[str] = None
    in_use: Optional[bool] = None
    conn_wifi: Optional[bool] = None
    conn_matter: Optional[bool] = None
    conn_zigbee: Optional[bool] = None
    conn_bluetooth: Optional[bool] = None
    conn_zwave: Optional[bool] = None
    ha_link: Optional[HaLink] = None
