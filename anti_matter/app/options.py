"""Read add-on options from /data/options.json (grouped, with flat fallback).

Home Assistant writes the Configuration tab into /data/options.json. We store options
grouped into sections (interface / backup) so the Config tab renders headers, and read
them here with a flat-key fallback for backward compatibility.
"""

from __future__ import annotations

import json
import os
import re
import unicodedata
from pathlib import Path

OPTIONS_PATH = Path(os.environ.get("ANTIMATTER_OPTIONS", "/data/options.json"))


def load_options() -> dict:
    try:
        return json.loads(OPTIONS_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {}


def opt(group: str, key: str, default=None):
    data = load_options()
    grp = data.get(group)
    if isinstance(grp, dict) and key in grp:
        return grp[key]
    if key in data:  # flat fallback
        return data[key]
    return default


# UI locales, in display order (English first, then by native name). The codes are
# Home Assistant's language keys: they match static/locales/<code>.json,
# translations/<code>.yaml and the value HA writes to <html lang>.
# Keep in sync with LANGUAGES in static/brand/js/i18n.js.
LANGUAGE_OPTION_NAMES: dict[str, str] = {
    "en": "English",
    "cs": "Čeština",
    "da": "Dansk",
    "de": "Deutsch",
    "es": "Español",
    "fr": "Français",
    "it": "Italiano",
    "hu": "Magyar",
    "nl": "Nederlands",
    "nb": "Norsk bokmål",
    "pl": "Polski",
    "pt-BR": "Português (Brasil)",
    "pt": "Português (Portugal)",
    "fi": "Suomi",
    "sv": "Svenska",
    "tr": "Türkçe",
    "ru": "Русский",
    "uk": "Українська",
    "he": "עברית",
    "ar": "العربية",
    "ja": "日本語",
    "ko": "한국어",
    "zh-Hans": "简体中文",
    "zh-Hant": "繁體中文",
}
"""code -> the value shown in the add-on's `language` dropdown (config.yaml list())."""

UI_LANGUAGES: list[str] = list(LANGUAGE_OPTION_NAMES)

_ENGLISH_NAMES: dict[str, tuple[str, ...]] = {
    "en": ("english", "engels"),
    "cs": ("czech",),
    "da": ("danish",),
    "de": ("german",),
    "es": ("spanish", "castellano"),
    "fr": ("french",),
    "it": ("italian",),
    "hu": ("hungarian",),
    "nl": ("dutch", "nederlands", "vlaams", "flemish"),
    "nb": ("norwegian", "norwegian bokmål", "norsk", "bokmål", "nynorsk", "norsk nynorsk"),
    "pl": ("polish",),
    "pt-BR": (
        "portuguese (brazil)", "brazilian portuguese", "portuguese brazil",
        "português do brasil", "português brasileiro", "português brasil", "brasileiro",
    ),
    "pt": (
        "portuguese", "portuguese (portugal)", "european portuguese", "portuguese portugal",
        "português", "português europeu", "português portugal",
    ),
    "fi": ("finnish",),
    "sv": ("swedish",),
    "tr": ("turkish",),
    "ru": ("russian",),
    "uk": ("ukrainian",),
    "he": ("hebrew",),
    "ar": ("arabic",),
    "ja": ("japanese",),
    "ko": ("korean",),
    "zh-Hans": (
        "chinese", "chinese (simplified)", "simplified chinese", "chinese simplified",
        "简体", "简体中文", "中文(简体)", "中文（简体）", "中文",
    ),
    "zh-Hant": (
        "chinese (traditional)", "traditional chinese", "chinese traditional",
        "繁體", "繁体中文", "中文(繁體)", "中文（繁體）", "正體中文",
    ),
}

_CODE_BY_LOWER = {code.lower(): code for code in UI_LANGUAGES}


def _fold(value: str) -> str:
    """Casefold, NFKC-normalise and collapse whitespace."""
    return " ".join(unicodedata.normalize("NFKC", value).casefold().split())


def _strip_accents(value: str) -> str:
    return "".join(
        ch for ch in unicodedata.normalize("NFKD", value) if not unicodedata.combining(ch)
    )


def _build_name_index() -> dict[str, str]:
    index: dict[str, str] = {}
    for code in UI_LANGUAGES:
        names = (LANGUAGE_OPTION_NAMES[code], *_ENGLISH_NAMES.get(code, ()))
        for name in names:
            for key in (_fold(name), _strip_accents(_fold(name))):
                index.setdefault(key, code)
    return index


_NAME_INDEX = _build_name_index()


def _match_tag(value: str) -> str | None:
    """BCP-47 / POSIX tag (any case, '-' or '_') -> UI code. Mirrors matchLocale() in i18n.js."""
    tag = re.split(r"[.@]", value, maxsplit=1)[0].replace("_", "-").strip("-").lower()
    if not tag:
        return None
    if tag in _CODE_BY_LOWER:
        return _CODE_BY_LOWER[tag]
    parts = [p for p in tag.split("-") if p]
    lang = parts[0]
    if not re.fullmatch(r"[a-z]{2,3}", lang):
        return None
    script = region = None
    for part in parts[1:]:
        if script is None and re.fullmatch(r"[a-z]{4}", part):
            script = part
        elif region is None and re.fullmatch(r"[a-z]{2}|\d{3}", part):
            region = part
    if lang == "zh":
        if script == "hant":
            return "zh-Hant"
        if script == "hans":
            return "zh-Hans"
        return "zh-Hant" if region in ("tw", "hk", "mo") else "zh-Hans"
    if lang == "pt":
        return "pt-BR" if region == "br" else "pt"
    if lang in ("no", "nn", "nb"):
        return "nb"
    if lang == "iw":
        return "he"
    return _CODE_BY_LOWER.get(lang)


def norm_language(value) -> str:
    """Add-on `language` option -> one of UI_LANGUAGES, or "auto".

    Accepts the config.yaml display names ("Deutsch", "Português (Brasil)", ...), English
    names ("German", "Simplified Chinese"), codes/tags in any case or separator
    ("pt-br", "zh_TW", "de-AT") and the legacy values ("Nederlands", "English", "Auto",
    "dutch", "engels"). Anything unknown -> "auto".
    """
    if value is None or isinstance(value, bool):
        return "auto"
    v = _fold(str(value))
    if not v or v == "auto":
        return "auto"
    code = _NAME_INDEX.get(v) or _NAME_INDEX.get(_strip_accents(v)) or _match_tag(v)
    return code or "auto"


def norm_theme(value) -> str:
    v = str(value or "auto").strip().lower()
    if v in ("light", "licht"):
        return "light"
    if v in ("dark", "donker"):
        return "dark"
    return "auto"


def backup_keep_count() -> int:
    try:
        n = int(opt("backup", "keep_count", 10))
    except (TypeError, ValueError):
        n = 10
    return max(1, min(100, n))
