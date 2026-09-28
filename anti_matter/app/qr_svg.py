"""Vector QR codes: a single compact <path> of black modules on a white quiet zone.

The PNG renderers (matter_qr_image, homekit_qr_image, zwave_qr_image) emit a fixed
220 px bitmap that the browser rescales by a non-integer factor, blurring module edges.
This SVG uses module units for its viewBox and ``shape-rendering="crispEdges"``, so it
stays pixel-exact at any display or print size.
"""

from __future__ import annotations

import qrcode
from qrcode.constants import ERROR_CORRECT_L, ERROR_CORRECT_M, ERROR_CORRECT_Q
from qrcode.exceptions import DataOverflowError

DEFAULT_BORDER = 4  # quiet zone in modules (the ISO/IEC 18004 minimum)
MAX_BORDER = 8

# (error correction, minimum version) per protocol, identical to the PNG renderers so
# qr.svg and qr.png encode the exact same module matrix:
#   matter  -> matter_qr_image  (M)
#   homekit -> homekit_qr_image (Q, version 2 minimum — homekit-code parity)
#   zwave   -> zwave_qr_image   (L — SDS13937 / zwave-js)
#   other   -> matter_qr_image  (M; "other" payloads reuse the Matter renderer)
QR_PROFILES: dict[str, tuple[int, int | None]] = {
    "matter": (ERROR_CORRECT_M, None),
    "homekit": (ERROR_CORRECT_Q, 2),
    "zwave": (ERROR_CORRECT_L, None),
    "other": (ERROR_CORRECT_M, None),
}


def clamp_border(border: int | None) -> int:
    """Quiet-zone width in modules, clamped to 0..MAX_BORDER (None -> default)."""
    if border is None:
        return DEFAULT_BORDER
    return max(0, min(MAX_BORDER, int(border)))


def qr_matrix(payload: str, protocol: str = "matter") -> list[list[bool]]:
    """Module matrix (True = dark) without quiet zone, for the protocol's EC profile.

    Raises ``qrcode.exceptions.DataOverflowError`` when the payload does not fit a QR code.
    """
    error_correction, version = QR_PROFILES.get(protocol, QR_PROFILES["matter"])
    qr = qrcode.QRCode(version=version, error_correction=error_correction, border=0)
    qr.add_data(payload)
    try:
        qr.make(fit=True)
    except ValueError as e:  # qrcode 8 reports "Invalid version (was 41 ...)" on overflow
        raise DataOverflowError(str(e)) from e
    return [[bool(cell) for cell in row] for row in qr.get_matrix()]


def svg_path_data(matrix: list[list[bool]], border: int = DEFAULT_BORDER) -> str:
    """Path data covering every dark module, one closed rectangle per horizontal run."""
    parts: list[str] = []
    for y, row in enumerate(matrix):
        x, width = 0, len(row)
        while x < width:
            if not row[x]:
                x += 1
                continue
            start = x
            while x < width and row[x]:
                x += 1
            left = start + border
            parts.append(f"M{left} {y + border}h{x - start}v1H{left}z")
    return "".join(parts)


def qr_svg(payload: str, protocol: str = "matter", *, border: int | None = DEFAULT_BORDER) -> str:
    """Standalone SVG document for ``payload``: white background rect + one black path.

    No width/height attributes — the viewBox (module units, quiet zone included) keeps
    the aspect ratio and the embedding page or printer decides the physical size.
    """
    matrix = qr_matrix(payload, protocol)
    quiet = clamp_border(border)
    size = len(matrix) + 2 * quiet
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {size} {size}" '
        f'shape-rendering="crispEdges">'
        f'<rect width="{size}" height="{size}" fill="#fff"/>'
        f'<path fill="#000" d="{svg_path_data(matrix, quiet)}"/>'
        "</svg>"
    )
