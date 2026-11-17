"""Automatic backup schedule: runtime settings + due-check, independent of HA options.

Settings live in STORAGE_DIR/backup_settings.json (not the add-on's options.json, which
is supervisor-owned) so the in-app Backup modal can read/write them directly.

Frequency is one of: hourly | daily | weekly | monthly.
- hourly: runs once per hour, at the configured minute.
- daily: runs once per day, at the configured hour:minute.
- weekly: runs once per week, on the configured weekday, at hour:minute.
- monthly: runs once per month, on the configured day_of_month, at hour:minute.

A period whose scheduled time was missed (add-on not running then) catches up at the
next check in that same period.
"""

from __future__ import annotations

import json
from datetime import timedelta
from pathlib import Path
from typing import Any

FREQUENCIES = ("hourly", "daily", "weekly", "monthly")

DEFAULTS: dict[str, Any] = {
    "enabled": False,
    "frequency": "daily",
    "hour": 3,
    "minute": 0,
    "weekday": 0,  # 0=Monday .. 6=Sunday (weekly)
    "day_of_month": 1,  # 1-28 (monthly)
    "keep_count": 10,
    "last_run_key": None,
}

SETTINGS_FILENAME = "backup_settings.json"


def _settings_path(data_dir: Path) -> Path:
    return data_dir / SETTINGS_FILENAME


def load_settings(data_dir: Path) -> dict[str, Any]:
    p = _settings_path(data_dir)
    if p.exists():
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            data = None
        # Valid JSON that is not an object (null, [], "x") counts as unreadable too: this
        # runs at add-on startup, where an AttributeError would stop the add-on.
        if isinstance(data, dict):
            out = dict(DEFAULTS)
            out.update({k: v for k, v in data.items() if k in DEFAULTS})
            return out
    out = dict(DEFAULTS)
    try:
        from options import backup_keep_count

        out["keep_count"] = backup_keep_count()
    except Exception:
        pass
    return out


def save_settings(data_dir: Path, updates: dict[str, Any]) -> dict[str, Any]:
    merged = load_settings(data_dir)
    merged.update({k: v for k, v in updates.items() if k in DEFAULTS})
    if merged.get("frequency") not in FREQUENCIES:
        merged["frequency"] = "daily"
    merged["hour"] = max(0, min(23, int(merged.get("hour") or 0)))
    merged["minute"] = max(0, min(59, int(merged.get("minute") or 0)))
    merged["weekday"] = max(0, min(6, int(merged.get("weekday") or 0)))
    merged["day_of_month"] = max(1, min(28, int(merged.get("day_of_month") or 1)))
    merged["keep_count"] = max(1, min(100, int(merged.get("keep_count") or 10)))
    merged["enabled"] = bool(merged.get("enabled"))
    from storage import atomic_write_text

    atomic_write_text(_settings_path(data_dir), json.dumps(merged, indent=2))
    return merged


def period_key(frequency: str, now) -> str:
    """Opaque string identifying the current period, so each period backs up once."""
    if frequency == "hourly":
        return now.strftime("%Y-%m-%dT%H")
    if frequency == "weekly":
        year, week, _ = now.isocalendar()
        return f"{year}-W{week:02d}"
    if frequency == "monthly":
        return now.strftime("%Y-%m")
    return now.strftime("%Y-%m-%d")


def mark_ran(data_dir: Path, key: str) -> None:
    save_settings(data_dir, {"last_run_key": key})


def _setting_int(settings: dict[str, Any], key: str, lo: int, hi: int) -> int:
    """Clamped int setting; a hand-edited file may hold strings, nulls or out-of-range values."""
    try:
        value = int(settings.get(key, DEFAULTS[key]))
    except (TypeError, ValueError):
        value = int(DEFAULTS[key])
    return max(lo, min(hi, value))


def scheduled_time(settings: dict[str, Any], frequency: str, now):
    """When the backup of the period that ``now`` falls in is scheduled (naive local time)."""
    minute = _setting_int(settings, "minute", 0, 59)
    if frequency == "hourly":
        return now.replace(minute=minute, second=0, microsecond=0)
    target = now.replace(hour=_setting_int(settings, "hour", 0, 23), minute=minute, second=0, microsecond=0)
    if frequency == "weekly":
        return target - timedelta(days=now.weekday() - _setting_int(settings, "weekday", 0, 6))
    if frequency == "monthly":
        return target.replace(day=_setting_int(settings, "day_of_month", 1, 28))
    return target


def is_due(settings: dict[str, Any], now) -> bool:
    """True once the current period's scheduled time has passed and it has not run yet.

    Catch-up, not exact-minute: a restart, an HA update or a stalled loop over the
    scheduled minute (or a DST jump over it) still backs up later in the same period,
    instead of silently skipping it. ``last_run_key`` keeps it to once per period.
    """
    if not settings.get("enabled"):
        return False
    freq = settings.get("frequency", "daily")
    if freq not in FREQUENCIES:
        freq = "daily"
    if settings.get("last_run_key") == period_key(freq, now):
        return False
    return now >= scheduled_time(settings, freq, now)
