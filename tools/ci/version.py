#!/usr/bin/env python3
"""Single source of truth helper for the add-on version.

The version lives in anti_matter/config.yaml; every other copy (runtime constants, asset
cache busters, README badges, the CHANGELOG heading) must match it. Drift here has
shipped a stale version badge before, so CI runs `check`.

    python3 tools/ci/version.py get                # print the config.yaml version
    python3 tools/ci/version.py next minor         # print the version a bump would give
    python3 tools/ci/version.py check              # fail if any copy disagrees
    python3 tools/ci/version.py bump 3.0.1         # rewrite every copy (+ CHANGELOG entry)
    python3 tools/ci/version.py bump minor         # same, computing X.Y+1.0 (major / minor / patch)
    python3 tools/ci/version.py notes [3.0.1]      # print that version's CHANGELOG section

CHANGELOG entry written by `bump`, in order of preference:
  1. an existing "## X.Y.Z" entry is kept as is;
  2. a "## Unreleased" section (optionally "## Unreleased — title") becomes "## X.Y.Z — title";
  3. with --from-git, one bullet per commit subject since the vOLD tag;
  4. otherwise a "<summary>" / "<what changed>" stub to fill in by hand.
`--summary TEXT` sets the title after the version. `notes` refuses an unfilled stub, so
the release workflow never publishes one.
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ADDON = ROOT / "anti_matter"
STATIC = ADDON / "app" / "static"
CHANGELOG = ADDON / "CHANGELOG.md"
SEMVER = r"\d+\.\d+\.\d+"
PARTS = ("major", "minor", "patch")
STUB_MARKERS = ("<summary>", "<what changed>")
UNRELEASED = re.compile(r"^## Unreleased\b[ \t]*(?:[—–-][ \t]*(?P<title>[^\n]*))?[ \t]*\n", re.M | re.I)
# Commits that are release plumbing, not changes worth a CHANGELOG bullet.
SKIP_SUBJECT = re.compile(r"^(Release \d|sync:|Merge (pull request|branch) )", re.I)

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


def next_version(current: str, part_or_version: str) -> str:
    """``major`` / ``minor`` / ``patch`` relative to ``current``, or an explicit X.Y.Z."""
    if re.fullmatch(SEMVER, part_or_version):
        return part_or_version
    if part_or_version not in PARTS:
        sys.exit(f"not a version or one of {', '.join(PARTS)}: {part_or_version}")
    major, minor, patch = (int(n) for n in current.split("."))
    if part_or_version == "major":
        return f"{major + 1}.0.0"
    if part_or_version == "minor":
        return f"{major}.{minor + 1}.0"
    return f"{major}.{minor}.{patch + 1}"


def _key(version: str) -> tuple[int, ...]:
    return tuple(int(n) for n in version.split("."))


def check() -> int:
    want = config_version()
    bad = 0
    for path, pattern, label in SITES:
        text = path.read_text(encoding="utf-8")
        found = re.findall(pattern, text, re.M)
        if path == CHANGELOG:
            found = found[:1]  # only the newest entry has to match ("## Unreleased" is skipped)
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


def _commit_subjects_since(tag: str) -> list[str]:
    try:
        out = subprocess.run(
            ["git", "log", "--no-merges", "--reverse", "--format=%s", f"{tag}..HEAD"],
            cwd=ROOT, check=True, capture_output=True, text=True,
        ).stdout
    except (OSError, subprocess.CalledProcessError) as exc:
        detail = getattr(exc, "stderr", "") or exc
        sys.exit(f"--from-git: cannot list commits since {tag}: {str(detail).strip()}")
    return [s.strip() for s in out.splitlines() if s.strip() and not SKIP_SUBJECT.match(s.strip())]


def _heading(version: str, title: str) -> str:
    return f"## {version}" + (f" — {title}" if title else "")


def _insert_entry(log: str, entry: str) -> str:
    """Put ``entry`` above the first "## " heading (the newest version), below the intro."""
    first = re.search(r"^## ", log, re.M)
    return log[: first.start()] + entry + log[first.start():] if first else log.rstrip("\n") + "\n\n" + entry


def _changelog_entry(log: str, old: str, new: str, summary: str, from_git: bool) -> str:
    if re.search(rf"^## {re.escape(new)}\b", log, re.M):
        print(f"CHANGELOG.md: keeping the existing '## {new}' entry")
        return log
    m = UNRELEASED.search(log)
    if m:
        rest = log[m.end():]
        nxt = re.search(r"^## ", rest, re.M)
        body = rest[: nxt.start()] if nxt else rest
        if body.strip():
            title = summary or (m.group("title") or "").strip()
            print(f"CHANGELOG.md: '## Unreleased' is now '{_heading(new, title)}'")
            return log[: m.start()] + _heading(new, title) + "\n" + rest
        log = log[: m.start()] + rest.lstrip("\n")  # an empty section: drop it, fall through
    if from_git:
        subjects = _commit_subjects_since(f"v{old}")
        if not subjects:
            sys.exit(f"nothing to release: no commits since v{old} (besides release plumbing)")
        bullets = "\n".join(f"- {s}" for s in subjects)
        print(f"CHANGELOG.md: '## {new}' written from {len(subjects)} commit subject(s) since v{old}")
        return _insert_entry(log, f"{_heading(new, summary)}\n\n{bullets}\n\n")
    print(f"CHANGELOG.md: added a '## {new}' stub — fill it in before pushing")
    return _insert_entry(log, f"## {new} — {summary or '<summary>'}\n\n- <what changed>\n\n")


def bump(target: str, *, summary: str = "", from_git: bool = False) -> int:
    old = config_version()
    new = next_version(old, target)
    if _key(new) <= _key(old):
        sys.exit(f"{new} is not newer than the current {old}")
    for path, pattern, label in SITES:
        if path == CHANGELOG:
            continue
        text = path.read_text(encoding="utf-8")
        text = re.sub(pattern, lambda m: m.group(0).replace(m.group(1), new), text, flags=re.M)
        path.write_text(text, encoding="utf-8")
    log = CHANGELOG.read_text(encoding="utf-8")
    CHANGELOG.write_text(_changelog_entry(log, old, new, summary.strip(), from_git), encoding="utf-8")
    print(f"{old} -> {new}")
    return check()


def notes(version: str | None) -> int:
    version = version or config_version()
    log = CHANGELOG.read_text(encoding="utf-8")
    m = re.search(rf"^## {re.escape(version)}\b[^\n]*\n(.*?)(?=^## |\Z)", log, re.M | re.S)
    if not m:
        sys.exit(f"CHANGELOG.md has no entry for {version}")
    section = m.group(0).strip()
    if any(marker in section for marker in STUB_MARKERS) or not m.group(1).strip():
        sys.exit(f"CHANGELOG.md entry for {version} is still the empty stub — fill it in")
    print(section)
    return 0


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        prog="version.py", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    sub = parser.add_subparsers(dest="cmd")
    sub.add_parser("get", help="print the config.yaml version")
    sub.add_parser("check", help="fail if any copy of the version disagrees")
    p_next = sub.add_parser("next", help="print the version a bump would produce")
    p_next.add_argument("target", help="major | minor | patch | X.Y.Z")
    p_bump = sub.add_parser("bump", help="rewrite every copy of the version")
    p_bump.add_argument("target", help="major | minor | patch | X.Y.Z")
    p_bump.add_argument("--summary", default="", help="CHANGELOG title after the version")
    p_bump.add_argument("--from-git", action="store_true",
                        help="without a '## Unreleased' section, list commit subjects since vOLD")
    p_notes = sub.add_parser("notes", help="print a version's CHANGELOG section")
    p_notes.add_argument("version", nargs="?")
    args = parser.parse_args(argv[1:] or ["check"])

    if args.cmd == "get":
        print(config_version())
        return 0
    if args.cmd == "check":
        return check()
    if args.cmd == "next":
        print(next_version(config_version(), args.target))
        return 0
    if args.cmd == "bump":
        return bump(args.target, summary=args.summary, from_git=args.from_git)
    if args.cmd == "notes":
        return notes(args.version)
    parser.print_help()
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
