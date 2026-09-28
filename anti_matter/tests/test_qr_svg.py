"""Vector QR: GET /api/codes/{id}/qr.svg and POST /api/qr.svg (unsaved preview)."""

from __future__ import annotations

import io
import logging
import re
import xml.etree.ElementTree as ET

import pytest
from PIL import Image

from conftest import DSK_A, build_zwave_qr

SVG_NS = "{http://www.w3.org/2000/svg}"
CANONICAL_QR = "MT:Y.K9042C00KA0648G00"
HK_URI = "X-HM://0081YCYEP3QYT"
_RUN = re.compile(r"M(\d+) (\d+)h(\d+)v1H(\d+)z")

CODES = {
    "matter": {"name": "Lamp", "qr_payload": CANONICAL_QR},
    "homekit": {"name": "Thermostat", "code_type": "homekit", "qr_payload": HK_URI},
    "zwave": {"name": "Switch", "code_type": "zwave", "qr_payload": build_zwave_qr(DSK_A)},
    "other": {"name": "Bulb", "code_type": "other", "custom_standard": "Zigbee",
              "qr_payload": "Z:00158D0004A1B2C3$I:83FED3407A939723A5C639B26916D505"},
}


def parse_svg(text: str) -> tuple[int, list[list[bool]]]:
    """Validate the document shape; return (viewBox size, dark-module matrix incl. border)."""
    root = ET.fromstring(text)
    assert root.tag == f"{SVG_NS}svg"
    assert root.get("shape-rendering") == "crispEdges"
    assert root.get("width") in (None, "100%") and root.get("height") in (None, "100%")
    x0, y0, w, h = (int(v) for v in root.get("viewBox").split())
    assert (x0, y0) == (0, 0) and w == h
    children = list(root)
    assert [c.tag for c in children] == [f"{SVG_NS}rect", f"{SVG_NS}path"]
    rect, path = children
    assert (rect.get("width"), rect.get("height"), rect.get("fill")) == (str(w), str(w), "#fff")
    assert path.get("fill") == "#000"
    d = path.get("d")
    assert _RUN.sub("", d) == ""  # nothing but run rectangles
    grid = [[False] * w for _ in range(w)]
    for x, y, run, back in _RUN.findall(d):
        x, y, run = int(x), int(y), int(run)
        assert int(back) == x
        for i in range(run):
            grid[y][x + i] = True
    return w, grid


def png_modules(png: bytes, modules: int) -> list[list[bool]]:
    """Sample module centres of a qr.png (8 px modules + 4 px pad, resized to 220)."""
    img = Image.open(io.BytesIO(png)).convert("L")
    scale = img.width / (modules * 8 + 8)
    return [
        [img.getpixel((int((8 * c + 8) * scale), int((8 * r + 8) * scale))) < 128
         for c in range(modules)]
        for r in range(modules)
    ]


def _create(client, fields: dict) -> str:
    resp = client.post("/api/codes", json=fields)
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


@pytest.mark.parametrize("proto", sorted(CODES))
def test_svg_matches_png_modules(client, proto):
    """Same payload and error correction as qr.png: identical module matrices."""
    code_id = _create(client, CODES[proto])
    resp = client.get(f"/api/codes/{code_id}/qr.svg?border=0")
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("image/svg+xml")
    size, grid = parse_svg(resp.text)
    png = client.get(f"/api/codes/{code_id}/qr.png")
    assert png.status_code == 200
    assert png_modules(png.content, size) == grid


def test_homekit_svg_uses_version_2_quartile(client):
    import qrcode

    code_id = _create(client, CODES["homekit"])
    size, _ = parse_svg(client.get(f"/api/codes/{code_id}/qr.svg?border=0").text)
    qr = qrcode.QRCode(version=2, error_correction=qrcode.constants.ERROR_CORRECT_Q, border=0)
    qr.add_data(HK_URI)
    qr.make(fit=True)
    assert size == len(qr.get_matrix()) == 25


@pytest.mark.parametrize("query,border", [("", 4), ("?border=0", 0), ("?border=2", 2),
                                          ("?border=99", 8), ("?border=-3", 0)])
def test_border_default_and_clamp(client, query, border):
    code_id = _create(client, CODES["matter"])
    bare, _ = parse_svg(client.get(f"/api/codes/{code_id}/qr.svg?border=0").text)
    size, grid = parse_svg(client.get(f"/api/codes/{code_id}/qr.svg{query}").text)
    assert size == bare + 2 * border
    if border:
        assert not any(grid[0]) and not any(row[0] for row in grid)  # white quiet zone
        assert grid[border][border]  # finder pattern corner


def test_single_compact_path(client):
    code_id = _create(client, CODES["zwave"])
    text = client.get(f"/api/codes/{code_id}/qr.svg").text
    assert text.count("<path") == 1 and text.count("<rect") == 1
    assert len(text) < 6000


def test_unknown_code_404(client):
    resp = client.get("/api/codes/nope/qr.svg")
    assert resp.status_code == 404
    assert resp.json()["detail"]["error"] == "code_not_found"


def test_manual_only_matter_code_has_no_qr(client):
    code_id = _create(client, {"name": "Manual", "manual_code": "3497-011-2332"})
    for ext in ("svg", "png"):
        resp = client.get(f"/api/codes/{code_id}/qr.{ext}")
        assert resp.status_code == 400
        detail = resp.json()["detail"]
        assert detail["error"] == "no_qr_payload"
        assert detail["message"] == "No MT: QR payload stored"
        assert detail["protocol"] == "matter"


def test_post_preview_matches_saved_code(client):
    """Typed HomeKit code: the preview encodes the URI the save would synthesize."""
    fields = {"code_type": "homekit", "manual_code": "841-31-633",
              "homekit_category": "lightbulb", "setup_id": "3QYT", "homekit_flag": 2}
    preview = client.post("/api/qr.svg", json=fields)
    assert preview.status_code == 200
    assert preview.headers["content-type"].startswith("image/svg+xml")
    assert preview.headers["cache-control"] == "no-store"
    code_id = _create(client, {"name": "Bulb", **fields})
    assert client.get(f"/api/codes/{code_id}/qr.svg").text == preview.text


@pytest.mark.parametrize("proto", sorted(CODES))
def test_post_preview_every_protocol(client, proto):
    body = {k: v for k, v in CODES[proto].items() if k != "name"}
    resp = client.post("/api/qr.svg?border=1", json=body)
    assert resp.status_code == 200
    size, _ = parse_svg(resp.text)
    code_id = _create(client, CODES[proto])
    assert parse_svg(client.get(f"/api/codes/{code_id}/qr.svg?border=1").text)[0] == size


def test_post_preview_no_payload(client):
    resp = client.post("/api/qr.svg", json={"code_type": "matter", "manual_code": "3497-011-2332"})
    assert resp.status_code == 400
    assert resp.json()["detail"]["error"] == "no_qr_payload"
    resp = client.post("/api/qr.svg", json={"code_type": "other", "manual_code": "abc"})
    assert resp.json()["detail"] == {
        "error": "no_qr_payload", "message": "No QR payload stored", "protocol": "other",
    }


def test_post_preview_payload_too_long(client):
    resp = client.post("/api/qr.svg", json={"code_type": "other", "qr_payload": "x" * 5000})
    assert resp.status_code == 400
    assert resp.json()["detail"]["error"] == "qr_payload_too_long"


def test_post_preview_never_logs_payload(client, caplog):
    caplog.set_level(logging.INFO)
    client.post("/api/qr.svg", json={"code_type": "matter", "qr_payload": CANONICAL_QR})
    client.post("/api/qr.svg", json={"code_type": "matter", "manual_code": "34970112332"})
    client.post("/api/codes/check-duplicate", json={"code_type": "homekit", "qr_payload": HK_URI})
    assert CANONICAL_QR not in caplog.text
    assert "34970112332" not in caplog.text and "0081YCYEP" not in caplog.text
