r"""JSON file persistence for the Anti-Matter vault.

Data lives under STORAGE_DIR (set to the add-on config folder `/config` by run.sh, which
Home Assistant exposes over Samba at \\<HA-IP>\app_configs\<repo-hash>_anti_matter). Falls back to /data.
"""

from __future__ import annotations

import json
import os
import shutil
from pathlib import Path
from threading import Lock

from models import TrashBin, Vault

DEFAULT_DATA_DIR = "/data"
VAULT_FILENAME = "anti_matter.json"
BIN_FILENAME = "anti-matter-bin.json"


def _resolve_data_dir(data_dir: str | None) -> Path:
    if data_dir:
        return Path(data_dir)
    return Path(
        os.environ.get("STORAGE_DIR")
        or os.environ.get("ANTIMATTER_DATA")
        or DEFAULT_DATA_DIR
    )


class VaultStorage:
    def __init__(self, data_dir: str | None = None) -> None:
        self.data_dir = _resolve_data_dir(data_dir)
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.path = self.data_dir / VAULT_FILENAME
        self.bin_path = self.data_dir / BIN_FILENAME
        self._lock = Lock()
        self._migrate_inline_trash()
        self._repair_homekit_pairing()

    def load(self) -> Vault:
        with self._lock:
            if not self.path.exists():
                vault = Vault()
                self._write_unlocked(vault)
                return vault
            raw = json.loads(self.path.read_text(encoding="utf-8"))
            return Vault.model_validate(raw)

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
        raw = json.loads(self.bin_path.read_text(encoding="utf-8"))
        return TrashBin.model_validate(raw)

    def _write_bin_unlocked(self, bin_data: TrashBin) -> None:
        tmp = self.bin_path.with_suffix(".tmp")
        tmp.write_text(bin_data.model_dump_json(indent=2), encoding="utf-8")
        tmp.replace(self.bin_path)

    def _migrate_inline_trash(self) -> None:
        """One-time move of pre-v1.0.16 inline-trashed items into the bin file."""
        if not self.path.exists():
            return
        with self._lock:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
            vault = Vault.model_validate(raw)
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
        from homekit_payload import repair_legacy_pairing

        def repair(codes) -> bool:
            changed = False
            for code in codes:
                if code.code_type != "homekit":
                    continue
                fixed = repair_legacy_pairing(code.manual_code, code.qr_payload)
                if fixed:
                    code.manual_code = fixed
                    changed = True
            return changed

        with self._lock:
            if self.path.exists():
                vault = Vault.model_validate(json.loads(self.path.read_text(encoding="utf-8")))
                if repair(vault.codes):
                    self._write_unlocked(vault)
            if self.bin_path.exists():
                bin_data = self._load_bin_unlocked()
                if repair(bin_data.codes):
                    self._write_bin_unlocked(bin_data)

    def export_json(self) -> str:
        from models import utc_now

        vault = self.load()
        vault.meta.exported_at = utc_now()
        return vault.model_dump_json(indent=2)

    def import_json(self, payload: str, *, merge: bool = False) -> Vault:
        incoming = Vault.model_validate(json.loads(payload))
        with self._lock:
            if merge and self.path.exists():
                current = Vault.model_validate(
                    json.loads(self.path.read_text(encoding="utf-8"))
                )
                # Skip incoming items whose id already exists locally — importing the
                # same export twice (or re-importing after a partial sync) must not
                # create a second record sharing an id with an existing one.
                existing_cat_ids = {c.id for c in current.categories}
                existing_code_ids = {c.id for c in current.codes}
                current.categories.extend(
                    c for c in incoming.categories if c.id not in existing_cat_ids
                )
                current.codes.extend(
                    c for c in incoming.codes if c.id not in existing_code_ids
                )
                self._write_unlocked(current)
                return current
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
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(
            vault.model_dump_json(indent=2),
            encoding="utf-8",
        )
        tmp.replace(self.path)
