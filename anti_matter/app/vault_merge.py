"""Vault merge helpers: tombstone-aware merge for import/export."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any


def _parse_ts(value: Any) -> datetime | None:
    if not value or not isinstance(value, str):
        return None
    s = value.strip()
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _ts_compare(a: Any, b: Any) -> int:
    ta = _parse_ts(a)
    tb = _parse_ts(b)
    if ta is None and tb is None:
        return 0
    if ta is None:
        return -1
    if tb is None:
        return 1
    if ta < tb:
        return -1
    if ta > tb:
        return 1
    return 0


def _as_deletion_map(value: Any) -> dict[str, str]:
    """Coerce tombstone maps; cloud/PHP may emit JSON [] instead of {}."""
    if not isinstance(value, dict):
        return {}
    return {str(k): str(v) for k, v in value.items() if k and v}


def _normalize_deletions(meta: dict) -> dict[str, dict[str, str]]:
    raw = meta.get("deletions") if isinstance(meta.get("deletions"), dict) else {}
    return {
        "codes": _as_deletion_map(raw.get("codes")),
        "categories": _as_deletion_map(raw.get("categories")),
    }


def _dedupe_by_id(items: Any) -> list:
    """Keep only the first occurrence of each id.

    Two entries sharing an id (e.g. from importing/merging the same export twice)
    are indistinguishable to the API: deleting one by id would remove all of them.
    Runs on every load/import/save so a vault that already has duplicates heals itself.
    """
    if not isinstance(items, list):
        return []
    seen: set[str] = set()
    out = []
    for item in items:
        item_id = item.get("id") if isinstance(item, dict) else None
        if item_id is None:
            out.append(item)
            continue
        if item_id in seen:
            continue
        seen.add(item_id)
        out.append(item)
    return out


def _migrate_category_id(code: Any) -> Any:
    """v1.0.26: a code can belong to multiple categories (category_ids) instead of
    just one (category_id). Old vaults on disk still have the single field."""
    if isinstance(code, dict) and "category_ids" not in code:
        old = code.get("category_id")
        code["category_ids"] = [old] if old else []
    return code


def sanitize_vault_dict(raw: dict[str, Any]) -> dict[str, Any]:
    """Normalize vault JSON before Pydantic validation (import, sync, load)."""
    out = dict(raw)
    meta = dict(out.get("meta") or {})
    meta["deletions"] = _normalize_deletions(meta)
    out["meta"] = meta
    out["categories"] = _dedupe_by_id(out.get("categories"))
    out["codes"] = [_migrate_category_id(c) for c in _dedupe_by_id(out.get("codes"))]
    return out


def record_deletion(vault: dict[str, Any], kind: str, item_id: str, *, now: str | None = None) -> None:
    from models import utc_now

    meta = vault.setdefault("meta", {})
    dels = meta.setdefault("deletions", {"codes": {}, "categories": {}})
    if kind not in dels or not isinstance(dels[kind], dict):
        dels[kind] = {}
    dels[kind][item_id] = now or utc_now()


def _merge_deletion_maps(a: dict, b: dict) -> dict:
    out: dict[str, dict[str, str]] = {"codes": {}, "categories": {}}
    for kind in ("codes", "categories"):
        for src in (a.get(kind) or {}, b.get(kind) or {}):
            for item_id, ts in src.items():
                if not item_id or not ts:
                    continue
                prev = out[kind].get(item_id)
                if prev is None or _ts_compare(ts, prev) > 0:
                    out[kind][item_id] = str(ts)
    return out


def _is_tombstoned(deletions: dict, kind: str, item_id: str, item: dict | None) -> bool:
    deleted_at = (deletions.get(kind) or {}).get(item_id)
    if not deleted_at:
        return False
    if item is None:
        return True
    item_at = item.get("updated_at") or item.get("created_at")
    return _ts_compare(deleted_at, item_at) >= 0


def _prune_deletions(deletions: dict, vault: dict) -> dict:
    for cat in vault.get("categories") or []:
        cid = cat.get("id")
        if cid and cid in deletions["categories"] and not _is_tombstoned(deletions, "categories", cid, cat):
            del deletions["categories"][cid]
    for code in vault.get("codes") or []:
        cid = code.get("id")
        if cid and cid in deletions["codes"] and not _is_tombstoned(deletions, "codes", cid, code):
            del deletions["codes"][cid]
    return deletions


def _pick_newer(a: dict, b: dict) -> dict:
    """``b`` only when it is strictly newer. On a tie (or no timestamps at all, as for
    categories) the local copy ``a`` stays, so a merge never reverts a local edit."""
    if _ts_compare(a.get("updated_at") or a.get("created_at"), b.get("updated_at") or b.get("created_at")) < 0:
        return b
    return a


def merge_vaults(local: dict, incoming: dict) -> dict:
    """Merge vaults; newest updated_at per id; tombstones propagate deletes."""
    deletions = _merge_deletion_maps(
        _normalize_deletions(local.get("meta") or {}),
        _normalize_deletions(incoming.get("meta") or {}),
    )

    cats: dict[str, dict] = {}
    for cat in (local.get("categories") or []) + (incoming.get("categories") or []):
        cid = cat.get("id")
        if not cid:
            continue
        cats[cid] = cat if cid not in cats else _pick_newer(cats[cid], cat)

    codes: dict[str, dict] = {}
    for code in (local.get("codes") or []) + (incoming.get("codes") or []):
        cid = code.get("id")
        if not cid:
            continue
        codes[cid] = code if cid not in codes else _pick_newer(codes[cid], code)

    out = dict(local)
    out["categories"] = [
        c for c in cats.values()
        if not _is_tombstoned(deletions, "categories", c["id"], c)
    ]
    out["codes"] = [
        c for c in codes.values()
        if not _is_tombstoned(deletions, "codes", c["id"], c)
    ]
    meta = dict(out.get("meta") or {})
    meta["deletions"] = _prune_deletions(deletions, out)
    meta["source"] = "hybrid"
    out["meta"] = meta
    return out
