#!/usr/bin/env python3
"""Single source of truth helper for the add-on version.

The version lives in anti_matter/config.yaml; every other copy (runtime constants, asset
cache busters, README badges, the CHANGELOG heading) must match it. Drift here has
shipped a stale version badge before, so CI runs `check`.

    python3 tools/ci/version.py get            # print the config.yaml version
    python3 tools/ci/version.py check          # fail if any copy disagrees
    python3 tools/ci/version.py bump 3.0.1     # rewrite every copy (+ CHANGELOG stub)
    python3 tools/ci/version.py notes [3.0.1]  # print that version's CHANGELOG section
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ADDON = ROOT / "anti_matter"
STATIC = ADDON / "app" / "static"
CHANGELOG = ADDON / "CHANGELOG.md"
SEMVER = r"\d+\.\d+\.\d+"

# (file, regex with one group around the version, human label). Every match in the
# file is checked/rewritten, and each pattern must match at least once.
SITES: list[tuple[Path, str, str]] = [
    (ADDON / "config.yaml", rf'^version: "({SEMVER})"', "config.yaml version"),
    (ADDON / "run.sh", rf'ADDON_VERSION="({SEMVER})"', "run.sh ADDON_VERSION"),
    (ADDON / "app" / "main.py", rf'^APP_VERSION = "({SEMVER})"', "main.py APP_VERSION"),
    (ADDON / "app" / "models.py", rf'addon_version: str = "({SEMVER})"', "models.py addon_version"),
    (STATIC / "js" / "core.js", rf'var VERSION = "({SEMVER})"', "core.js VERSION"),
    (STATIC / "brand" / "js" / "scan-engine.js", rf'var VERSION = "({SEMVER})"', "scan-engine.js VERSION"),
    (STATIC / "brand" / "js" / "category-icons.js", rf'var V = "\?v=({SEMVER})"', "category-icons.js cache buster"),
    (STATIC / "index.html", rf'\?v=({SEMVER})', "index.html cache busters"),
    (ROOT / "README.md", rf'badge/version-({SEMVER})-', "README.md badge"),
    (ADDON / "README.md", rf'badge/version-({SEMVER})-', "anti_matter/README.md badge"),
    (CHANGELOG, rf'^## ({SEMVER})\b', "CHANGELOG.md top entry"),
]


def config_version() -> str:
    m = re.search(SITES[0][1], SITES[0][0].read_text(encoding="utf-8"), re.M)
    if not m:
        sys.exit("config.yaml has no version")
    return m.group(1)


def check() -> int:
    want = config_version()
    bad = 0
    for path, pattern, label in SITES:
        text = path.read_text(encoding="utf-8")
        found = re.findall(pattern, text, re.M)
        if path == CHANGELOG:
            found = found[:1]  # only the newest entry has to match
        wrong = sorted({v for v in found if v != want})
        if not found:
            print(f"✗ {label}: no version found ({path.relative_to(ROOT)})")
            bad += 1
        elif wrong:
            print(f"✗ {label}: {', '.join(wrong)} (expected {want})")
            bad += 1
        else:
            print(f"✓ {label}: {want}" + (f" ×{len(found)}" if len(found) > 1 else ""))
    return 1 if bad else 0


def bump(new: str) -> int:
    if not re.fullmatch(SEMVER, new):
        sys.exit(f"not a version: {new}")
    old = config_version()
    for path, pattern, label in SITES:
        if path == CHANGELOG:
            continue
        text = path.read_text(encoding="utf-8")
        text = re.sub(pattern, lambda m: m.group(0).replace(m.group(1), new), text, flags=re.M)
        path.write_text(text, encoding="utf-8")
    log = CHANGELOG.read_text(encoding="utf-8")
    if not re.search(rf"^## {re.escape(new)}\b", log, re.M):
        first = re.search(r"^## ", log, re.M)
        stub = f"## {new} — <summary>\n\n- <what changed>\n\n"
        log = log[: first.start()] + stub + log[first.start():] if first else log + "\n" + stub
        CHANGELOG.write_text(log, encoding="utf-8")
        print(f"CHANGELOG.md: added a '## {new}' stub — fill it in before pushing")
    print(f"{old} -> {new}")
    return check()


def notes(version: str | None) -> int:
    version = version or config_version()
    log = CHANGELOG.read_text(encoding="utf-8")
    m = re.search(rf"^## {re.escape(version)}\b[^\n]*\n(.*?)(?=^## |\Z)", log, re.M | re.S)
    if not m:
        sys.exit(f"CHANGELOG.md has no entry for {version}")
    print(m.group(0).strip())
    return 0


def main(argv: list[str]) -> int:
    cmd = argv[1] if len(argv) > 1 else "check"
    if cmd == "get":
        print(config_version())
        return 0
    if cmd == "check":
        return check()
    if cmd == "bump" and len(argv) == 3:
        return bump(argv[2])
    if cmd == "notes":
        return notes(argv[2] if len(argv) > 2 else None)
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
