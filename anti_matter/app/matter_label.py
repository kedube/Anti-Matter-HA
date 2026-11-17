"""Matter-style pairing label PNG (matches device sticker layout)."""

from __future__ import annotations

import io
import os

from PIL import Image, ImageDraw, ImageFont

from matter_payload import display_manual, qr_encode_payload
from matter_qr_image import qr_pil_image

STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")
WORDMARK = os.path.join(STATIC_DIR, "assets", "matter_logo.png")

# Rendered at 2x and downsampled at the end (supersampling) for crisp anti-aliased
# edges — QR modules and text both benefit, especially over the small bitmap font
# fallback (previously the only outcome, see _mono_font).
SCALE = 2
QR_SIZE = 260 * SCALE
PAD_X = 12 * SCALE
PAD_Y = 10 * SCALE
GAP = 8 * SCALE
NAME_FONT_SIZE = 18 * SCALE
MANUAL_FONT_SIZE = 26 * SCALE
NAME_H = 26 * SCALE
MANUAL_H = 42 * SCALE
TAIL = 12 * SCALE
# More characters than the label could ever show, even in the narrow bitmap fallback font.
MAX_NAME_CHARS = 120


def _logo_height_at(width: int) -> int:
    """Exact rendered height of the wordmark at the given width (matches the resize
    done in label_png_bytes), so the canvas height computed below never mismatches
    the logo actually pasted into it."""
    if os.path.isfile(WORDMARK):
        with Image.open(WORDMARK) as logo:
            return round(width * logo.height / logo.width)
    return round(width * 0.215)  # matter_logo.png's own aspect ratio, as a fallback


LOGO_H_EST = _logo_height_at(QR_SIZE)
LABEL_W = QR_SIZE + 2 * PAD_X + 4 * SCALE  # 2px border each side
LABEL_H_WITH_QR = PAD_Y + LOGO_H_EST + GAP + QR_SIZE + GAP + MANUAL_H + TAIL
LABEL_H_NO_QR = 190 * SCALE


def label_png_bytes(
    manual_code: str,
    qr_payload: str,
    name: str = "",
    *,
    show_logo: bool = True,
    raw_qr: bool = False,
) -> bytes | None:
    manual = display_manual(manual_code)
    encode = (qr_payload or "").strip() or None if raw_qr else qr_encode_payload(qr_payload, manual_code)
    if not manual and encode is None:
        return None

    has_qr = encode is not None
    name = (name or "").strip()
    name_h = NAME_H + GAP if name else 0
    logo_h = LOGO_H_EST if show_logo else 0
    label_h_with_qr = PAD_Y + logo_h + (GAP if show_logo else 0) + QR_SIZE + GAP + MANUAL_H + TAIL
    label_h_no_qr = LABEL_H_NO_QR if show_logo else LABEL_H_NO_QR - LOGO_H_EST
    w, h = LABEL_W, (label_h_with_qr if has_qr else label_h_no_qr) + name_h

    img = Image.new("RGB", (w, h), "white")
    draw = ImageDraw.Draw(img)
    draw.rectangle((2 * SCALE, 2 * SCALE, w - 3 * SCALE, h - 3 * SCALE), outline="black", width=2 * SCALE)

    if name:
        font = _mono_font(NAME_FONT_SIZE)
        # Long names would overflow the label width — clip rather than shrink the font.
        # The loop below re-measures the whole string per removed character (quadratic),
        # so never feed it more than could fit: an 8,000-char name took ~47 s before.
        full_len = len(name)
        name = name[:MAX_NAME_CHARS]
        trimmed = len(name) < full_len
        while font and len(name) > 1 and draw.textbbox((0, 0), name, font=font)[2] > w - 2 * PAD_X:
            name = name[:-1]
            trimmed = True
        label_text = name + "…" if trimmed else name
        if font:
            bbox = draw.textbbox((0, 0), label_text, font=font)
            tw = bbox[2] - bbox[0]
            draw.text(((w - tw) // 2, PAD_Y), label_text, fill=(60, 60, 60), font=font)
        else:
            draw.text((PAD_X, PAD_Y), label_text, fill=(60, 60, 60))

    logo_h = 0
    gap_after_logo = 0
    if show_logo:
        gap_after_logo = GAP
        if os.path.isfile(WORDMARK):
            logo = Image.open(WORDMARK).convert("RGBA")
            target_w = QR_SIZE
            ratio = target_w / logo.width
            logo = logo.resize((target_w, round(logo.height * ratio)), Image.Resampling.LANCZOS)
            logo_h = logo.height
            logo_y = PAD_Y + name_h
            img.paste(logo, ((w - logo.width) // 2, logo_y), logo)
        else:
            draw.text((w // 2 - 28 * SCALE, PAD_Y + name_h + 4 * SCALE), "matter", fill=(30, 30, 30))
            logo_h = 20 * SCALE

    if has_qr:
        qr_img = qr_pil_image(encode, QR_SIZE)
        qr_y = PAD_Y + name_h + logo_h + gap_after_logo
        img.paste(qr_img, ((w - QR_SIZE) // 2, qr_y))

    if manual:
        font = _mono_font(MANUAL_FONT_SIZE)
        manual_y = h - TAIL - MANUAL_H + (MANUAL_H // 4) if has_qr else h // 2 + 20 * SCALE
        if font:
            bbox = draw.textbbox((0, 0), manual, font=font)
            tw = bbox[2] - bbox[0]
            draw.text(((w - tw) // 2, manual_y), manual, fill="black", font=font)
        else:
            draw.text(((w - len(manual) * 8 * SCALE) // 2, manual_y - 10 * SCALE), manual, fill="black")

    img = img.resize((w // SCALE, h // SCALE), Image.Resampling.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def _mono_font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont | None:
    candidates = [
        "/usr/share/fonts/dejavu/DejaVuSansMono-Bold.ttf",  # Alpine (font-dejavu package)
        "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf",  # Debian/Ubuntu
        "/Library/Fonts/Menlo.ttc",  # macOS (local dev)
    ]
    for path in candidates:
        if os.path.isfile(path):
            try:
                return ImageFont.truetype(path, size)
            except OSError:
                continue
    return ImageFont.load_default()
