#!/usr/bin/env python3
"""Fake-webcam fixture for the scanner screenshots and scan-demo.gif (all codes are FAKE).

Writes OUT_DIR/cam-flow.y4m, a looping 1280x720 "camera" clip for Chrome's
--use-file-for-fake-video-capture: the camera pans onto a Matter sticker, holds, pans to a
HomeKit sticker, holds, then pans away to an empty desk:

    0.0-1.1 s  pan in       1.1-3.8 s  Matter sticker   3.8-4.6 s  pan
    4.6-7.4 s  HomeKit      7.4-8.2 s  pan away         8.2-11.0 s empty desk (loop)

A 12x12 block in the bottom-right corner encodes the phase so capture.mjs can time its
clicks: faintly redder = Matter hold, faintly greener = HomeKit hold (red-green difference of
about +/-16 on the dark vignette, invisible in the screenshots). The y4m is ~180 MB: it lives in the gitignored work dir and is
regenerated on demand. Needs numpy, Pillow, qrcode and ffmpeg on PATH.

Usage: python3 make_fixtures.py OUT_DIR
"""

from __future__ import annotations

import json
import math
import subprocess
import sys
from pathlib import Path

import numpy as np
import qrcode
from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = Path(__file__).resolve().parent
APP = HERE.parent.parent / "anti_matter" / "app"
sys.path.insert(0, str(APP))
from homekit_payload import category_id_for, compose_setup_uri  # noqa: E402
from matter_setup_payload import (CommissioningFlow, ParsedSetupPayload,  # noqa: E402
                                  generate_manual_code, generate_qr_payload)

W, H, FPS, LOOP = 1280, 720, 12, 11.0
FONTS = ["/System/Library/Fonts/Supplemental/Arial Bold.ttf", "/System/Library/Fonts/Helvetica.ttc",
         "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf"]


def font(size: int):
    for f in FONTS:
        try:
            return ImageFont.truetype(f, size)
        except OSError:
            continue
    return ImageFont.load_default()


# Fake codes (never real devices): Matter "Eve Motion" ids so the DCL mock can name it.
MATTER_PIN, MATTER_DISC, MATTER_VID, MATTER_PID = 63014227, 2766, 0x130A, 0x0059
HK_CODE, HK_SETUP_ID = "20714358", "4XQ9"


def matter_payload():
    p = ParsedSetupPayload(pincode=MATTER_PIN, short_discriminator=MATTER_DISC >> 8, long_discriminator=MATTER_DISC,
                           discovery=4, flow=CommissioningFlow.STANDARD, vid=MATTER_VID, pid=MATTER_PID)
    m = generate_manual_code(p)
    return generate_qr_payload(p), f"{m[:4]}-{m[4:7]}-{m[7:]}"


def qr_img(data: str, px: int) -> Image.Image:
    q = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_M, box_size=10, border=1)
    q.add_data(data)
    q.make(fit=True)
    return q.make_image(fill_color=(18, 18, 22), back_color=(252, 252, 249)).convert("RGB").resize((px, px), Image.NEAREST)


def sticker(kind: str, payload: str, code: str) -> Image.Image:
    w, h = 300, 390
    im = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle([0, 0, w - 1, h - 1], 26, fill=(252, 252, 249, 255), outline=(40, 40, 46, 255), width=3)
    if kind == "matter":
        logo = Image.open(APP / "static" / "assets" / "matter_logo.png").convert("RGBA")
        logo = logo.resize((150, int(150 * logo.height / logo.width)), Image.LANCZOS)
        im.alpha_composite(logo, ((w - logo.width) // 2, 26))
        im.paste(qr_img(payload, 220), (40, 76))
        d.text((w // 2, 332), code, font=font(30), fill=(20, 20, 24), anchor="mm")
        d.text((w // 2, 364), "Setup code - keep safe", font=font(15), fill=(96, 96, 104), anchor="mm")
    else:
        # HomeKit-style label: house glyph + 2x4 digits, QR below.
        x0, y0 = 58, 30
        d.polygon([(x0, y0 + 30), (x0 + 36, y0), (x0 + 72, y0 + 30)], outline=(20, 20, 24), width=5)
        d.rectangle([x0 + 10, y0 + 28, x0 + 62, y0 + 74], outline=(20, 20, 24), width=5)
        d.text((x0 + 92, y0 + 16), code[:4], font=font(34), fill=(20, 20, 24), anchor="lm")
        d.text((x0 + 92, y0 + 56), code[4:], font=font(34), fill=(20, 20, 24), anchor="lm")
        im.paste(qr_img(payload, 210), (45, 128))
        d.text((w // 2, 364), "HomeKit setup code", font=font(15), fill=(96, 96, 104), anchor="mm")
    return im


def world(labels) -> tuple[Image.Image, list[float]]:
    """A long desk with the stickers laid out left to right; returns the image and their centres."""
    ww, wh = int(W * 4.2), H + 400
    rng = np.random.default_rng(7)

    def smooth(sy: int, sx: int) -> np.ndarray:  # low-res noise stretched up = soft streaks / mottling
        n = Image.fromarray(((rng.random((sy, sx)) * 255)).astype(np.uint8)).resize((ww, wh), Image.BICUBIC)
        return np.asarray(n).astype(np.float32) / 255 - 0.5

    grain = smooth(wh // 3, ww // 90) * 26 + smooth(wh // 40, ww // 40) * 22  # smooth: compresses well in PNG/GIF
    base = np.stack([98 + grain, 84 + grain * 0.9, 72 + grain * 0.8], -1)
    img = Image.fromarray(np.clip(base, 0, 255).astype(np.uint8)).convert("RGBA")
    centres = []
    xa = W * 1.0
    for i, (lab, angle) in enumerate(labels):
        cx, cy = xa + i * W * 1.15, wh / 2 + (10 if i else -6)
        L = lab.rotate(angle, resample=Image.BICUBIC, expand=True)
        shadow = Image.new("RGBA", L.size, (0, 0, 0, 0))
        shadow.paste((0, 0, 0, 130), mask=L.split()[3])
        shadow = shadow.filter(ImageFilter.GaussianBlur(16))
        img.alpha_composite(shadow, (int(cx - L.width / 2 + 10), int(cy - L.height / 2 + 18)))
        img.alpha_composite(L, (int(cx - L.width / 2), int(cy - L.height / 2)))
        centres.append(cx)
    return img.convert("RGB"), centres


def ease(u: float) -> float:
    u = min(1.0, max(0.0, u))
    return u * u * (3 - 2 * u)


def camera(t: float, xa: float, xb: float):
    """(centre x, phase) at time t. phase: 1 = Matter hold, 2 = HomeKit hold, 0 = other."""
    far_a, far_b = xa - 0.85 * W, xb + 0.85 * W
    if t < 1.1:
        return far_a + (xa - far_a) * ease(t / 1.1), 0
    if t < 3.8:
        return xa, 1
    if t < 4.6:
        return xa + (xb - xa) * ease((t - 3.8) / 0.8), 0
    if t < 7.4:
        return xb, 2
    if t < 8.2:
        return xb + (far_b - xb) * ease((t - 7.4) / 0.8), 0
    return far_b, 0


def main() -> None:
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    out = Path(sys.argv[1])
    out.mkdir(parents=True, exist_ok=True)
    mq, mm = matter_payload()
    hk = compose_setup_uri(category_id=category_id_for("lightbulb"), password=HK_CODE, setup_id=HK_SETUP_ID)
    desk, (xa, xb) = world([(sticker("matter", mq, mm), -4), (sticker("homekit", hk, HK_CODE), 3)])
    wh = desk.height
    n = int(LOOP * FPS)
    y4m = out / "cam-flow.y4m"
    ff = subprocess.Popen(["ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}",
                           "-r", str(FPS), "-i", "-", "-pix_fmt", "yuv420p", str(y4m)], stdin=subprocess.PIPE)
    yy, xx = np.mgrid[0:H, 0:W]
    vig = 1 - 0.28 * (((xx - W / 2) / (W / 2)) ** 2 + ((yy - H / 2) / (H / 2)) ** 2)
    still = None
    for i in range(n):
        t = i / FPS
        cx, phase = camera(t, xa, xb)
        hold = phase != 0
        ang = math.radians(1.2 * math.sin(t * 1.3))
        sc = 1.0 + 0.025 * math.sin(t * 0.8)
        cy = wh / 2 + 8 * math.sin(t * 1.1)
        cx += 10 * math.sin(t * 0.9) if hold else 0
        # Inverse affine: output pixel (u, v) -> world (x, y); rotate + scale about the frame centre.
        ca, sa = math.cos(ang) / sc, math.sin(ang) / sc
        a, b = ca, -sa
        d_, e = sa, ca
        c = cx - a * W / 2 - b * H / 2
        f = cy - d_ * W / 2 - e * H / 2
        frame = desk.transform((W, H), Image.AFFINE, (a, b, c, d_, e, f), resample=Image.BILINEAR)
        frame = frame.filter(ImageFilter.GaussianBlur(0.6 if hold else 1.8))
        arr = np.asarray(frame).astype(np.float32)
        arr = np.clip(arr * vig[..., None], 0, 255).astype(np.uint8)
        # Phase marker: a barely-tinted 12x12 corner (dark vignette), read back by capture.mjs.
        arr[H - 12:, W - 12:] = {0: (43, 37, 32), 1: (59, 37, 32), 2: (43, 53, 32)}[phase]
        ff.stdin.write(arr.tobytes())
        if still is None and phase == 1 and t > 2.0:
            still = Image.fromarray(arr)
    ff.stdin.close()
    if ff.wait() != 0:
        sys.exit("ffmpeg failed")
    if still is not None:
        still.save(out / "cam-flow-still.jpg", quality=90)
    (out / "PAYLOADS.json").write_text(json.dumps({"matter_qr": mq, "matter_manual": mm, "homekit_uri": hk,
                                                   "homekit_code": HK_CODE}, indent=2))
    print("fixture:", y4m, f"({y4m.stat().st_size / 1e6:.0f} MB)")


if __name__ == "__main__":
    main()
