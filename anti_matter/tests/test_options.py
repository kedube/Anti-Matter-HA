"""options.py language handling + consistency of config.yaml, translations/ and i18n.js."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import pytest

ADDON_DIR = Path(__file__).resolve().parent.parent
APP_DIR = ADDON_DIR / "app"
if str(APP_DIR) not in sys.path:  # conftest.py does this too; keep the file standalone
    sys.path.insert(0, str(APP_DIR))

import options  # noqa: E402
from options import (  # noqa: E402
    LANGUAGE_OPTION_NAMES,
    UI_LANGUAGES,
    backup_keep_count,
    norm_language,
    norm_theme,
)

EXPECTED_CODES = {
    "en", "de", "nl", "fr", "es", "it", "pt-BR", "pt", "pl", "sv", "da", "nb",
    "fi", "cs", "hu", "ru", "uk", "tr", "ja", "ko", "zh-Hans", "zh-Hant", "he", "ar",
}

# Supervisor's schema regex (supervisor/apps/options.py, RE_SCHEMA_ELEMENT, list branch).
RE_SUPERVISOR_LIST = re.compile(r"^(?:list\((?P<list>.+)\))\??$")


def test_ui_languages_are_the_24_ha_keys():
    assert len(UI_LANGUAGES) == 24
    assert set(UI_LANGUAGES) == EXPECTED_CODES
    assert UI_LANGUAGES[0] == "en"
    assert list(LANGUAGE_OPTION_NAMES) == UI_LANGUAGES


@pytest.mark.parametrize(
    "value, expected",
    [
        # legacy option values / spellings: must keep working
        ("Auto", "auto"), ("auto", "auto"), (None, "auto"), ("", "auto"), ("  ", "auto"),
        ("English", "en"), ("english", "en"), ("engels", "en"), ("en", "en"),
        ("Nederlands", "nl"), ("nederlands", "nl"), ("dutch", "nl"), ("nl", "nl"),
        # codes in any case / separator
        ("pt-BR", "pt-BR"), ("pt-br", "pt-BR"), ("PT_BR", "pt-BR"), ("pt", "pt"),
        ("pt-PT", "pt"), ("pt_AO", "pt"), ("zh-hans", "zh-Hans"), ("ZH-HANT", "zh-Hant"),
        ("zh_TW", "zh-Hant"), ("zh-HK", "zh-Hant"), ("zh-MO", "zh-Hant"), ("zh-CN", "zh-Hans"),
        ("zh-SG", "zh-Hans"), ("zh", "zh-Hans"), ("zh-Hant-TW", "zh-Hant"),
        ("zh-Hans-HK", "zh-Hans"), ("no", "nb"), ("nn", "nb"), ("nb-NO", "nb"),
        ("iw", "he"), ("he-IL", "he"), ("de-AT", "de"), ("de_CH", "de"), ("en-GB", "en"),
        ("es-419", "es"), ("fr-CA", "fr"), ("ar-EG", "ar"), ("en_US.UTF-8", "en"),
        # English names
        ("German", "de"), ("Brazilian Portuguese", "pt-BR"), ("Portuguese (Brazil)", "pt-BR"),
        ("European Portuguese", "pt"), ("Norwegian", "nb"), ("Simplified Chinese", "zh-Hans"),
        ("Chinese (Traditional)", "zh-Hant"), ("Hebrew", "he"), ("Arabic", "ar"),
        # accent-free / differently cased native names
        ("francais", "fr"), ("ESPAÑOL", "es"), ("cestina", "cs"), ("turkce", "tr"),
        ("norsk bokmal", "nb"), ("Português do Brasil", "pt-BR"),
        # unknown / unsupported -> auto
        ("xx", "auto"), ("Klingon", "auto"), ("sr-Latn", "auto"), ("sk", "auto"),
        (True, "auto"), (3, "auto"),
    ],
)
def test_norm_language(value, expected):
    assert norm_language(value) == expected


@pytest.mark.parametrize("code", sorted(EXPECTED_CODES))
def test_display_name_and_code_round_trip(code):
    assert norm_language(LANGUAGE_OPTION_NAMES[code]) == code
    assert norm_language(code) == code
    assert norm_language(code.lower()) == code
    assert norm_language(code.upper().replace("-", "_")) == code


def _config():
    yaml = pytest.importorskip("yaml")
    return yaml.safe_load((ADDON_DIR / "config.yaml").read_text(encoding="utf-8"))


def test_config_language_list_matches_options_py():
    cfg = _config()
    schema = cfg["schema"]["interface"]["language"]
    m = RE_SUPERVISOR_LIST.match(schema)
    assert m, schema
    values = m.group("list").split("|")
    assert values == ["Auto"] + [LANGUAGE_OPTION_NAMES[c] for c in UI_LANGUAGES]
    # Byte-identical legacy values so existing options.json still validates.
    for legacy in ("Auto", "English", "Nederlands"):
        assert legacy in values
    assert cfg["options"]["interface"]["language"] in values
    assert len(set(values)) == len(values)
    assert all("|" not in v and v == v.strip() for v in values)


def test_config_theme_unchanged():
    cfg = _config()
    assert cfg["schema"]["interface"]["theme"] == "list(Auto|Light|Dark)"
    assert cfg["options"]["interface"]["theme"] == "Auto"


def test_translation_files_exist_for_every_locale():
    names = {p.stem for p in (ADDON_DIR / "translations").glob("*.yaml")}
    assert names == EXPECTED_CODES


@pytest.mark.parametrize("code", sorted(EXPECTED_CODES))
def test_translation_file_structure(code):
    yaml = pytest.importorskip("yaml")
    data = yaml.safe_load((ADDON_DIR / "translations" / f"{code}.yaml").read_text(encoding="utf-8"))
    conf = data["configuration"]
    assert set(conf) == {"interface", "backup"}
    fields = {
        "interface": {"language", "theme"},
        "backup": {"keep_count"},
    }
    for group, keys in fields.items():
        assert isinstance(conf[group]["name"], str) and conf[group]["name"].strip()
        assert set(conf[group]["fields"]) == keys
        for key in keys:
            entry = conf[group]["fields"][key]
            assert isinstance(entry["name"], str) and entry["name"].strip()
            assert isinstance(entry["description"], str) and entry["description"].strip()
    # The raw option values (untranslatable) are referenced verbatim.
    assert "Auto" in conf["interface"]["fields"]["language"]["description"]
    assert "Home Assistant" in conf["interface"]["fields"]["language"]["description"]


def test_i18n_js_languages_match_options_py():
    js = (APP_DIR / "static" / "brand" / "js" / "i18n.js").read_text(encoding="utf-8")
    rows = re.findall(r'^\s*\["([A-Za-z-]+)", "([^"]+)", "([^"]+)"\],$', js, re.M)
    assert [(code, name) for code, name, _ in rows] == list(LANGUAGE_OPTION_NAMES.items())


def test_norm_theme_unchanged():
    assert norm_theme(None) == "auto"
    assert norm_theme("Auto") == "auto"
    assert norm_theme("Light") == "light"
    assert norm_theme("licht") == "light"
    assert norm_theme("Dark") == "dark"
    assert norm_theme("donker") == "dark"
    assert norm_theme("purple") == "auto"


@pytest.mark.parametrize(
    "payload, expected",
    [
        ({"backup": {"keep_count": 25}}, 25),
        ({"keep_count": 7}, 7),  # flat fallback
        ({"backup": {"keep_count": 0}}, 1),
        ({"backup": {"keep_count": 1000}}, 100),
        ({"backup": {"keep_count": "x"}}, 10),
        ({}, 10),
    ],
)
def test_backup_keep_count(tmp_path, monkeypatch, payload, expected):
    path = tmp_path / "options.json"
    path.write_text(json.dumps(payload), encoding="utf-8")
    monkeypatch.setattr(options, "OPTIONS_PATH", path)
    assert backup_keep_count() == expected


def test_language_option_read_from_options_json(tmp_path, monkeypatch):
    path = tmp_path / "options.json"
    path.write_text(json.dumps({"interface": {"language": "Português (Brasil)"}}), encoding="utf-8")
    monkeypatch.setattr(options, "OPTIONS_PATH", path)
    assert norm_language(options.opt("interface", "language", "auto")) == "pt-BR"
