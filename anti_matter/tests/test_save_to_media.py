"""POST /api/codes/{id}/save-to-media: server render (no body) and validated uploads."""

from __future__ import annotations

import io

import pytest
from PIL import Image

PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
HK_URI = "X-HM://0081YCYEP3QYT"
GOOD_SVG = (
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" '
    'viewBox="0 0 10 10"><defs><linearGradient id="g"/></defs>'
    '<rect width="10" height="10" fill="url(#g)" style="font-family: sans-serif"/>'
    '<use href="#g"/><image href="data:image/png;base64,iVBORw0KGgo=" width="1" height="1"/>'
    "<text>Connection one</text></svg>"
)


def _png_bytes() -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (4, 4), "white").save(buf, format="PNG")
    return buf.getvalue()


@pytest.fixture
def code_id(client):
    resp = client.post("/api/codes", json={"name": "Lamp / hall", "qr_payload": "MT:Y.K9042C00KA0648G00"})
    return resp.json()["id"]


def _media_files(app_module) -> list[str]:
    d = app_module.MEDIA_DIR
    return sorted(p.name for p in d.iterdir()) if d.exists() else []


def _post(client, code_id, content: bytes | None = None, ctype: str | None = None):
    headers = {"Content-Type": ctype} if ctype else {}
    return client.post(f"/api/codes/{code_id}/save-to-media", content=content, headers=headers)


# --- no body: unchanged server-rendered behavior ---


@pytest.mark.parametrize("ctype", [None, "application/json", "image/png"])
def test_no_body_renders_label_png(client, app_module, code_id, ctype):
    resp = _post(client, code_id, None, ctype)
    assert resp.status_code == 200
    assert resp.json() == {"ok": True, "path": "/media/anti_matter/antimatter-Lamp_hall.png"}
    assert (app_module.MEDIA_DIR / "antimatter-Lamp_hall.png").read_bytes().startswith(PNG_MAGIC)


def test_no_body_renders_homekit_card_svg(client, app_module):
    cid = client.post("/api/codes", json={"name": "Lock", "code_type": "homekit",
                                          "qr_payload": HK_URI}).json()["id"]
    resp = _post(client, cid)
    assert resp.json()["path"] == "/media/anti_matter/antimatter-Lock.svg"
    svg = (app_module.MEDIA_DIR / "antimatter-Lock.svg").read_text(encoding="utf-8")
    assert "<svg" in svg
    # The server's own card (inline data: logo, #fragment refs) passes the upload filter.
    again = _post(client, cid, svg.encode("utf-8"), "image/svg+xml")
    assert again.status_code == 200, again.text


# --- uploads ---


def test_png_upload_saved_verbatim(client, app_module, code_id):
    png = _png_bytes()
    resp = _post(client, code_id, png, "image/png")
    assert resp.status_code == 200
    assert resp.json()["path"] == "/media/anti_matter/antimatter-Lamp_hall.png"
    assert (app_module.MEDIA_DIR / "antimatter-Lamp_hall.png").read_bytes() == png


@pytest.mark.parametrize("svg", [GOOD_SVG, '<?xml version="1.0"?>\n' + GOOD_SVG, "﻿" + GOOD_SVG])
def test_svg_upload_saved_verbatim(client, app_module, code_id, svg):
    resp = _post(client, code_id, svg.encode("utf-8"), "image/svg+xml; charset=utf-8")
    assert resp.status_code == 200, resp.text
    assert resp.json()["path"] == "/media/anti_matter/antimatter-Lamp_hall.svg"
    assert (app_module.MEDIA_DIR / "antimatter-Lamp_hall.svg").read_bytes() == svg.encode("utf-8")


def test_qr_svg_output_is_an_accepted_upload(client, code_id):
    svg = client.get(f"/api/codes/{code_id}/qr.svg").content
    assert _post(client, code_id, svg, "image/svg+xml").status_code == 200


@pytest.mark.parametrize("svg", [
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><rect/><g\nonclick = "x()"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:alert(1)"><text>x</text></a></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://evil.example/x.png"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><image xlink:href="//evil.example/x.png"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><use href="other.svg#a"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><image href="data:image/svg+xml;base64,PHN2Zz4="/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><rect style="fill:url(http://evil/x)"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><style>@import "http://evil/x.css";</style></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div/></foreignObject></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><set attributeName="href" to="#a"/></svg>',
    '<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY x "y">]><svg/>',
    "<html><body>not an svg</body></html>",
    "hello",
])
def test_unsafe_or_bogus_svg_rejected(client, app_module, code_id, svg):
    resp = _post(client, code_id, svg.encode("utf-8"), "image/svg+xml")
    assert resp.status_code == 400
    assert resp.json()["detail"]["error"] == "invalid_upload"
    assert _media_files(app_module) == []


def test_non_utf8_svg_rejected(client, code_id):
    resp = _post(client, code_id, "<svg/>".encode("utf-16"), "image/svg+xml")
    assert resp.json()["detail"]["error"] == "invalid_upload"


@pytest.mark.parametrize("body", [b"<svg/>", PNG_MAGIC + b"garbage", b"GIF89a"])
def test_bad_png_rejected(client, app_module, code_id, body):
    resp = _post(client, code_id, body, "image/png")
    assert resp.status_code == 400
    assert resp.json()["detail"]["error"] == "invalid_upload"
    assert _media_files(app_module) == []


def test_too_large_declared(client, app_module, code_id):
    body = PNG_MAGIC + b"\0" * (app_module.MAX_MEDIA_UPLOAD_BYTES)
    resp = _post(client, code_id, body, "image/png")
    assert resp.status_code == 413
    assert resp.json()["detail"]["error"] == "too_large"


def test_too_large_streamed_without_length(client, app_module, code_id):
    chunk = b"\0" * (1024 * 1024)

    def chunks():
        for _ in range(9):
            yield chunk

    resp = client.post(f"/api/codes/{code_id}/save-to-media", content=chunks(),
                       headers={"Content-Type": "image/png"})
    assert resp.status_code == 413
    assert resp.json()["detail"]["error"] == "too_large"


def test_other_image_type_rejected(client, code_id):
    resp = _post(client, code_id, b"\xff\xd8\xff\xe0jpeg", "image/jpeg")
    assert resp.status_code == 415
    assert resp.json()["detail"]["error"] == "unsupported_media_type"


def test_unknown_code(client):
    resp = _post(client, "nope", _png_bytes(), "image/png")
    assert resp.status_code == 404
    assert resp.json()["detail"]["error"] == "code_not_found"


def test_media_unavailable(client, app_module, code_id, tmp_path):
    blocker = tmp_path / "not-a-dir"
    blocker.write_text("x")
    app_module.MEDIA_DIR = blocker / "anti_matter"
    resp = _post(client, code_id)
    assert resp.status_code == 500
    assert resp.json()["detail"]["error"] == "media_unavailable"
