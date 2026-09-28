#!/usr/bin/env python3
"""Shrink PNGs in place.
- pngquant (lossy palette, quality 80-98) and oxipng (lossless) when installed:
  brew install pngquant oxipng
- otherwise Pillow, lossless: drop an opaque alpha channel and recompress at max zlib level;
  an opaque file still above PNG_LIMIT_KB (default 700) then gets a 256-colour palette from
  ffmpeg (palettegen stats_mode=full + sierra2_4a dithering), kept only if >= 30 % smaller.
  (Pillow's own quantizers visibly shift the protocol / category colours, so they are not used.)
Usage: optimize_png.py FILE.png ..."""
import os
import shutil
import subprocess
import sys
import tempfile

from PIL import Image

LIMIT = int(os.environ.get("PNG_LIMIT_KB", "700")) * 1024
PNGQUANT, OXIPNG, FFMPEG = shutil.which("pngquant"), shutil.which("oxipng"), shutil.which("ffmpeg")


def pillow(path: str) -> None:
    im = Image.open(path)
    im.load()
    if im.mode == "RGBA" and im.getextrema()[3][0] == 255:
        im = im.convert("RGB")
    fd, tmp = tempfile.mkstemp(suffix=".png")
    os.close(fd)
    im.save(tmp, optimize=True, compress_level=9)
    if os.path.getsize(tmp) < os.path.getsize(path):
        shutil.move(tmp, path)
    else:
        os.unlink(tmp)
    if os.path.getsize(path) <= LIMIT or im.mode != "RGB" or not FFMPEG:
        return
    fd, tmp = tempfile.mkstemp(suffix=".png")
    os.close(fd)
    vf = "split[a][b];[a]palettegen=max_colors=256:stats_mode=full[p];[b][p]paletteuse=dither=sierra2_4a"
    r = subprocess.run([FFMPEG, "-loglevel", "error", "-y", "-i", path, "-vf", vf, "-pix_fmt", "pal8", tmp])
    if r.returncode == 0 and os.path.getsize(tmp) < 0.7 * os.path.getsize(path):
        shutil.move(tmp, path)
    elif os.path.exists(tmp):
        os.unlink(tmp)


for f in sys.argv[1:]:
    before = os.path.getsize(f)
    if PNGQUANT:
        subprocess.run([PNGQUANT, "--quality", "80-98", "--skip-if-larger", "--force", "--strip", "--ext", ".png", f])
    if OXIPNG:
        subprocess.run([OXIPNG, "-q", "-o", "3", "--strip", "safe", f])
    if not (PNGQUANT or OXIPNG):
        pillow(f)
    w, h = Image.open(f).size
    after = os.path.getsize(f)
    note = "  (above limit)" if after > LIMIT else ""
    print(f"optimized {os.path.relpath(f)}: {w}x{h}, {before // 1024} KB -> {after // 1024} KB{note}")
