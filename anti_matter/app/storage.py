r"""JSON file persistence for the Anti-Matter vault.

Data lives under STORAGE_DIR (set to the add-on config folder `/config` by run.sh, which
Home Assistant exposes over Samba at \\<HA-IP>\app_configs\<repo-hash>_anti_matter). Falls back to /data.
"""

from __future__ import annotations

import json
import logging
import os
import shutil
from pathlib import Path
from threading import Lock
from typing import TypeVar

from pydantic import BaseModel

from models import TrashBin, Vault

DEFAULT_DATA_DIR = "/data"
VAULT_FILENAME = "anti_matter.json"
BIN_FILENAME = "anti-matter-bin.json"

_LOGGER = logging.getLogger("anti_matter.storage")
_M = TypeVar("_M", bound=BaseModel)


class VaultUnreadableError(Exception):
    """The vault (or Trash) file exists but is not valid: truncated by a power cut, or
    a hand edit over Samba gone wrong. The file is left untouched so it can be fixed;
    a replace-import (or restoring a backup) writes a fresh one."""

    def __init__(self, path: Path, cause: Exception) -> None:
        self.path = path
        # Only the exception type: a pydantic message would quote the offending values,
        # and those may be pairing codes.
        super().__init__(
            f"{path.name} could not be read ({type(cause).__name__}). "
            "Fix the file or import a backup to replace it."
        )


def atomic_write_text(path: Path, text: str) -> None:
    """Write ``text`` to ``path`` via a fsynced temp file + rename, so a crash or power cut
    leaves either the old file or the new one, never a truncated mix."""
    tmp = path.with_suffix(".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(text)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def _repair_homekit_codes(codes) -> bool:
    """Rewrite pairing codes from the pre-3.0 31-bit-mask decoder in place; True if any changed."""
    from homekit_payload import repair_legacy_pairing

    changed = False
    for code in codes:
        if code.code_type != "homekit":
            continue
        fixed = repair_legacy_pairing(code.manual_code, code.qr_payload)
        if fixed:
            code.manual_code = fixed
            changed = True
    return changed


def _resolve_data_dir(data_dir: str | None) -> Path:
    if data_dir:
        return Path(data_dir)
    return Path(
        os.environ.get("STORAGE_DIR")
        or os.environ.get("ANTIMATTER_DATA")
        or DEFAULT_DATA_DIR
    )


def _read_model(path: Path, model: type[_M]) -> _M:
    try:
        return model.model_validate(json.loads(path.read_text(encoding="utf-8")))
    except (OSError, ValueError) as exc:  # ValueError: JSONDecodeError, pydantic, bad UTF-8
        raise VaultUnreadableError(path, exc) from exc


class VaultStorage:
    def __init__(self, data_dir: str | None = None) -> None:
        self.data_dir = _resolve_data_dir(data_dir)
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.path = self.data_dir / VAULT_FILENAME
        self.bin_path = self.data_dir / BIN_FILENAME
        self._lock = Lock()
        try:
            self._migrate_inline_trash()
            self._repair_homekit_pairing()
        except VaultUnreadableError as exc:
            # Start anyway: the UI then shows a coded error and can still replace-import a
            # backup, instead of the add-on dying at import with a bare traceback.
            _LOGGER.error("%s The vault stays unavailable until then.", exc)

    def load(self) -> Vault:
        with self._lock:
            if not self.path.exists():
                vault = Vault()
                self._write_unlocked(vault)
                return vault
            return _read_model(self.path, Vault)

    def save(self, vault: Vault) -> None:
        with self._lock:
            self._write_unlocked(vault)

    def load_bin(self) -> TrashBin:
        with self._lock:
            return self._load_bin_unlocked()

    def save_bin(self, bin_data: TrashBin) -> None:
        with self._lock:
            self._write_bin_unlocked(bin_data)

    def _load_bin_unlocked(self) -> TrashBin:
        if not self.bin_path.exists():
            return TrashBin()
        return _read_model(self.bin_path, TrashBin)

    def _write_bin_unlocked(self, bin_data: TrashBin) -> None:
        atomic_write_text(self.bin_path, bin_data.model_dump_json(indent=2))

    def _migrate_inline_trash(self) -> None:
        """One-time move of pre-v1.0.16 inline-trashed items into the bin file."""
        if not self.path.exists():
            return
        with self._lock:
            vault = _read_model(self.path, Vault)
            trashed_cats = [c for c in vault.categories if c.deleted_at]
            trashed_codes = [c for c in vault.codes if c.deleted_at]
            if not trashed_cats and not trashed_codes:
                return
            vault.categories = [c for c in vault.categories if not c.deleted_at]
            vault.codes = [c for c in vault.codes if not c.deleted_at]
            self._write_unlocked(vault)
            bin_data = self._load_bin_unlocked()
            existing_cat_ids = {c.id for c in bin_data.categories}
            existing_code_ids = {c.id for c in bin_data.codes}
            bin_data.categories.extend(c for c in trashed_cats if c.id not in existing_cat_ids)
            bin_data.codes.extend(c for c in trashed_codes if c.id not in existing_code_ids)
            self._write_bin_unlocked(bin_data)

    def _repair_homekit_pairing(self) -> None:
        """Fix HomeKit pairing codes saved by the pre-3.0 31-bit-mask decoder (vault + bin)."""
        with self._lock:
            if self.path.exists():
                vault = _read_model(self.path, Vault)
                if _repair_homekit_codes(vault.codes):
                    self._write_unlocked(vault)
            if self.bin_path.exists():
                bin_data = self._load_bin_unlocked()
                if _repair_homekit_codes(bin_data.codes):
                    self._write_bin_unlocked(bin_data)

    def export_json(self) -> str:
        from models import utc_now

        vault = self.load()
        vault.meta.exported_at = utc_now()
        return vault.model_dump_json(indent=2)

    def import_json(self, payload: str, *, merge: bool = False) -> Vault:
        from vault_merge import merge_vaults

        incoming = Vault.model_validate(json.loads(payload))
        # Exports and backups from 2.x (e.g. moving over from another install) carry the
        # same legacy HomeKit codes that _repair_homekit_pairing fixes on disk at startup.
        _repair_homekit_codes(incoming.codes)
        with self._lock:
            if merge and self.path.exists():
                current = _read_model(self.path, Vault)
                # Something in the Trash stays there: the export still carrying it must not
                # put a second, live copy with the same id next to the trashed one (it can
                # be restored from the Trash instead).
                trash = self._load_bin_unlocked()
                trashed_cats = {c.id for c in trash.categories}
                trashed_codes = {c.id for c in trash.codes}
                theirs = incoming.model_dump(mode="json")
                theirs["categories"] = [c for c in theirs["categories"] if c["id"] not in trashed_cats]
                theirs["codes"] = [c for c in theirs["codes"] if c["id"] not in trashed_codes]
                # Per id the newest updated_at wins (local on a tie), and purged ids
                # (meta.deletions tombstones) stay deleted instead of coming back.
                merged = Vault.model_validate(merge_vaults(current.model_dump(mode="json"), theirs))
                self._write_unlocked(merged)
                return merged
            self._write_unlocked(incoming)
            return incoming

    def backup_local_copy(self, keep_count: int = 10) -> Path:
        """Create a timestamped local backup under STORAGE_DIR/backups and prune old ones."""
        from datetime import datetime, timezone

        backup_dir = self.data_dir / "backups"
        backup_dir.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
        dest = backup_dir / f"anti_matter_{stamp}.json"
        shutil.copy2(self.path, dest)
        self._prune_backups(backup_dir, keep_count)
        return dest

    @staticmethod
    def _prune_backups(backup_dir: Path, keep_count: int) -> None:
        keep_count = max(1, int(keep_count or 1))
        backups = sorted(
            backup_dir.glob("anti_matter_*.json"),
            key=lambda p: p.name,
            reverse=True,
        )
        for old in backups[keep_count:]:
            try:
                old.unlink()
            except OSError:
                pass

    def _write_unlocked(self, vault: Vault) -> None:
        atomic_write_text(self.path, vault.model_dump_json(indent=2))
