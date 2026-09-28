"""Shared fixtures: put ../app on sys.path and build an isolated app per test.

main.py creates its VaultStorage and MEDIA_DIR from the environment at import time, so
each test gets fresh tmp directories and a reloaded ``main`` module.
"""

from __future__ import annotations

import hashlib
import importlib
import sys
from pathlib import Path

import pytest

APP_DIR = Path(__file__).resolve().parent.parent / "app"
if str(APP_DIR) not in sys.path:
    sys.path.insert(0, str(APP_DIR))


@pytest.fixture
def app_module(tmp_path, monkeypatch):
    """Freshly imported ``main`` with vault storage and /media under ``tmp_path``."""
    monkeypatch.setenv("STORAGE_DIR", str(tmp_path / "config"))
    monkeypatch.setenv("ANTIMATTER_MEDIA", str(tmp_path / "media"))
    monkeypatch.setenv("ANTIMATTER_OPTIONS", str(tmp_path / "options.json"))
    import main

    return importlib.reload(main)


@pytest.fixture
def client(app_module):
    from fastapi.testclient import TestClient

    # No context manager: skips the lifespan (backup scheduler loop).
    return TestClient(app_module.app)


def build_zwave_qr(
    dsk_groups: list[int],
    *,
    manufacturer: int = 271,
    product_type: int = 1538,
    product_id: int = 4097,
    requested_keys: int = 135,
) -> str:
    """Valid SmartStart QR digits: "90" lead-in + version "01" + 5-digit SHA-1 checksum
    of the body, body = 3-digit requested keys + 40-digit DSK + TLVs."""
    dsk = "".join(f"{g:05d}" for g in dsk_groups)
    word = (0x10 << 8) | 0x01  # generic / specific device class
    tlv = "00" + "10" + f"{word:05d}" + f"{1792:05d}"  # ProductType
    tlv += "02" + "20" + f"{manufacturer:05d}{product_type:05d}{product_id:05d}{(1 << 8 | 2):05d}"
    tlv += "08" + "02" + "01"  # SupportedProtocols: Z-Wave
    body = f"{requested_keys:03d}" + dsk + tlv
    digest = hashlib.sha1(body.encode()).digest()
    return "9001" + f"{(digest[0] << 8) | digest[1]:05d}" + body


DSK_A = [50285, 12045, 44321, 9876, 33120, 5421, 61234, 7788]
DSK_B = [11873, 40022, 5610, 27431, 60012, 3301, 19988, 45020]
