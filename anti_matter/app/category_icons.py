"""Category icon name normalization.

Icons are Material Design Icons names (e.g. "home", "motion-sensor"), rendered client
side from a bundled MDI subset sprite (full webfont loaded on demand). We only sanitize
the name here; the picker guarantees it exists. An optional "mdi:" / "mdi-" prefix is
stripped, and the Lucide names that v1.0.0-1.0.3 stored are mapped to their MDI
equivalents (keep in sync with ALIASES in static/brand/js/category-icons.js).
"""

from __future__ import annotations

import re

DEFAULT = "folder"

# Legacy Lucide ids -> MDI. "box" is the Box.com logo in MDI, not a package.
LEGACY_ALIASES: dict[str, str] = {
    "air-vent": "hvac",
    "bath": "bathtub",
    "building-2": "office-building",
    "circle-dot": "radiobox-marked",
    "cooking-pot": "pot-steam",
    "droplets": "water",
    "flower-2": "flower",
    "lamp-ceiling": "ceiling-light",
    "moon": "weather-night",
    "zap": "lightning-bolt",
    "plug": "power-plug",
    "refrigerator": "fridge",
    "scan-qr": "qrcode-scan",
    "settings": "cog",
    "sun": "white-balance-sunny",
    "toggle-right": "toggle-switch",
    "tree-pine": "pine-tree",
    "tv": "television",
    "wind": "weather-windy",
    "box": "package-variant-closed",
}


def normalize(icon: str | None) -> str:
    raw = (icon or "").strip().lower()
    raw = re.sub(r"^mdi[:-]", "", raw)
    raw = re.sub(r"[^a-z0-9-]", "", raw)
    return LEGACY_ALIASES.get(raw, raw) or DEFAULT
