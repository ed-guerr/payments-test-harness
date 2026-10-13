"""render_pi.py — render tmux ANSI captures (fNNNN.ansi) to PNGs (fNNNN.png).

Usage: python3 render_pi.py <frames_dir> <cols> <rows> [scale]

scale (default 2) supersamples the render so the compose step can downscale
the terminal frames to the final GIF width with net supersampling — sharp
text instead of the soft look you get rendering at 1x and downscaling.

Requires: pyte, pillow (pip install pyte pillow). Font defaults to macOS
Menlo; edit FONT below for other platforms.

Supports the color forms pi's TUI emits: named ANSI colors, rgb:rr/gg/bb,
#rrggbb, and bare 6-digit hex.
"""

import os
import sys

import pyte
from PIL import Image, ImageDraw, ImageFont

COLS, ROWS = int(sys.argv[2]), int(sys.argv[3])
SCALE = int(sys.argv[4]) if len(sys.argv) > 4 else 2
DIR = sys.argv[1]
FONT = "/System/Library/Fonts/Menlo.ttc"  # macOS; adjust for other platforms
SIZE = 16 * SCALE
CELL_W = 10 * SCALE
CELL_H = 20 * SCALE
PAD = 24 * SCALE  # terminal-style padding

font = ImageFont.truetype(FONT, SIZE, index=0)
font_bold = ImageFont.truetype(FONT, SIZE, index=1)

# VS Code dark-ish 16 colors (index 0-7 normal, 8-15 bright)
PALETTE = {
    "black": "#1e1e1e", "red": "#f44f4f", "green": "#57ab5a", "yellow": "#d7ba7d",
    "blue": "#569cd6", "magenta": "#c586c0", "cyan": "#4ec9b0", "white": "#d4d4d4",
    "brightblack": "#767676", "brightred": "#ff6b6b", "brightgreen": "#8fd48f",
    "brightyellow": "#f0d090", "brightblue": "#7cc0ff", "brightmagenta": "#e0a3e0",
    "brightcyan": "#7fe5d4", "brightwhite": "#ffffff",
}
DEFAULT_BG = "#0a0a0a"
DEFAULT_FG = "#d4d4d4"

seen = set()


def color(v, default):
    seen.add(v)
    if v in ("default", None, ""):
        return default
    if v.startswith("rgb:"):
        parts = v[4:].split("/")
        if len(parts) == 3:
            return "#" + "".join(p[:2] for p in parts)
        return default
    if v.startswith("#"):
        return v
    if len(v) == 6 and all(c in "0123456789abcdef" for c in v.lower()):
        return "#" + v.lower()
    return PALETTE.get(v.lower(), default)


def render(ansi_path: str, png_path: str) -> None:
    screen = pyte.Screen(COLS, ROWS)
    stream = pyte.Stream(screen)
    with open(ansi_path, "r", encoding="utf-8", errors="replace") as f:
        data = f.read()
    # tmux capture-pane ends each screen row with a bare LF; pyte (like a
    # real terminal) keeps the column on LF, so rows of differing length
    # drift rightward when replayed. Restore row-start-at-column-0 with CRLF.
    stream.feed(data.replace("\n", "\r\n"))

    img = Image.new("RGB", (COLS * CELL_W + 2 * PAD, ROWS * CELL_H + 2 * PAD), DEFAULT_BG)
    draw = ImageDraw.Draw(img)
    for r in range(ROWS):
        line = screen.buffer[r]
        x = PAD
        # batch consecutive same-bg cells for speed
        for c in range(COLS):
            ch = line[c]
            bg = color(ch.bg, DEFAULT_BG) if ch.bg != "default" else DEFAULT_BG
            fg = color(ch.fg, DEFAULT_FG)
            draw.rectangle([x, PAD + r * CELL_H, x + CELL_W, PAD + (r + 1) * CELL_H], fill=bg)
            if ch.data != " ":
                fnt = font_bold if ch.bold else font
                draw.text((x, PAD + r * CELL_H - 1), ch.data, font=fnt, fill=fg)
            x += CELL_W
    img.save(png_path)


def main() -> None:
    files = sorted(f for f in os.listdir(DIR) if f.endswith(".ansi"))
    for i, f in enumerate(files):
        render(os.path.join(DIR, f), os.path.join(DIR, f.replace(".ansi", ".png")))
    print(f"rendered {len(files)} frames")
    print("distinct colors:", sorted(seen)[:40])


if __name__ == "__main__":
    main()
