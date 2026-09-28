#!/usr/bin/env python3
"""Cross-check i18n keys used by the UI against static/locales/*.json (run by CI).

Usage: python3 tools/ci/check_i18n.py [--locales] [--strict]

Static uses found: t("key"), t('key'), t(`key`) without ${}, and the HTML/JS attributes
data-i18n, data-i18n-placeholder, data-i18n-title, data-i18n-aria-label, data-i18n-tip.
Dynamic key families are declared in source with a comment:  // i18n-dynamic: error. code.protocol_
(space-separated prefixes) — keys under a declared prefix count as used, and a used prefix
must have at least one key in en.json.
Reports: keys used but missing from en.json (always an error), en.json keys never used
(warning), and with --locales, per-locale missing/extra keys and placeholder or plural-shape
mismatches versus English.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

STATIC = Path(__file__).resolve().parents[2] / "anti_matter" / "app" / "static"
LOC = STATIC / "locales"
SKIP_DIRS = {"vendor", "locales"}

T_CALL = re.compile(r"""\bt\(\s*(["'`])([A-Za-z0-9_.\-]+)\1""")
ATTR = re.compile(r"""data-i18n(?:-placeholder|-title|-aria-label|-tip)?\s*=\s*["']([A-Za-z0-9_.\-]+)["']""")
DYN = re.compile(r"i18n-dynamic:\s*([^\n*]+)")
PH = re.compile(r"\{([A-Za-z0-9_]+)\}")


def placeholders(v) -> set[str]:
    if isinstance(v, dict):
        out: set[str] = set()
        for x in v.values():
            out |= set(PH.findall(str(x)))
        return out
    return set(PH.findall(str(v)))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--locales", action="store_true")
    ap.add_argument("--strict", action="store_true", help="unused keys are errors too")
    a = ap.parse_args()
    used: dict[str, str] = {}
    corpus: list[str] = []  # all UI source, to spot keys passed to t() indirectly (arrays, maps)
    dyn: set[str] = set()
    for f in STATIC.rglob("*"):
        if f.suffix not in (".js", ".html") or any(p in SKIP_DIRS for p in f.relative_to(STATIC).parts[:-1]):
            continue
        src = f.read_text(encoding="utf-8", errors="replace")
        corpus.append(src)
        rel = str(f.relative_to(STATIC))
        for m in T_CALL.finditer(src):
            used.setdefault(m.group(2), rel)
        for m in ATTR.finditer(src):
            used.setdefault(m.group(1), rel)
        for m in DYN.finditer(src):
            dyn.update(p.strip() for p in m.group(1).split() if p.strip())
    en = json.loads((LOC / "en.json").read_text(encoding="utf-8"))
    errors = 0
    missing = sorted(k for k in used if k not in en)
    for k in missing:
        print(f"MISSING in en.json: {k}  (used in {used[k]})")
    errors += len(missing)
    for p in sorted(dyn):
        if not any(k.startswith(p) for k in en):
            print(f"MISSING dynamic family in en.json: {p}*")
            errors += 1
    blob = "\n".join(corpus)
    unused = sorted(
        k for k in en
        if k not in used
        and not any(k.startswith(p) for p in dyn)
        and not any(q + k + q in blob for q in "\"'`")
    )
    for k in unused:
        print(f"{'UNUSED' if a.strict else 'unused'} en.json key: {k}")
    if a.strict:
        errors += len(unused)
    if a.locales:
        for f in sorted(LOC.glob("*.json")):
            if f.name == "en.json":
                continue
            data = json.loads(f.read_text(encoding="utf-8"))
            miss = [k for k in en if k not in data]
            extra = [k for k in data if k not in en]
            bad_ph = [k for k in en if k in data and placeholders(en[k]) != placeholders(data[k])]
            bad_shape = [k for k in en if k in data and isinstance(en[k], dict) != isinstance(data[k], dict)]
            empty = [k for k, v in data.items() if v in ("", {})]
            status = "OK" if not (miss or extra or bad_ph or bad_shape or empty) else "FAIL"
            print(f"{f.stem:8s} {status}: {len(data)} keys, missing {len(miss)}, extra {len(extra)}, "
                  f"placeholder mismatch {len(bad_ph)}, plural-shape mismatch {len(bad_shape)}, empty {len(empty)}")
            for k in (miss[:5] + extra[:5] + bad_ph[:5] + bad_shape[:5] + empty[:5]):
                print(f"    {k}")
            errors += len(miss) + len(bad_ph) + len(bad_shape) + len(empty)
    print(f"used keys: {len(used)}, en.json keys: {len(en)}, dynamic prefixes: {sorted(dyn)}")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
