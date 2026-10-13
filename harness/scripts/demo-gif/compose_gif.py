"""compose_gif.py — assemble the final demo GIF from the two captures.

Order: app "before" list -> pi terminal (decimated) -> app "after" list +
agent suite run -> chaos -> registry -> DB -> outro.
Each app segment is decimated to a target frame count (uniform 10fps output);
the terminal keeps only changed frames (every Nth) plus boot/hold trims.

Usage: python3 compose_gif.py [width] [app_dir] [pi_dir] [out_dir]
"""

import os
import shutil
import sys
from PIL import Image

W = int(sys.argv[1]) if len(sys.argv) > 1 else 720
APP = sys.argv[2] if len(sys.argv) > 2 else "/tmp/app-frames"
PI = sys.argv[3] if len(sys.argv) > 3 else "/tmp/pi-frames"
OUT = sys.argv[4] if len(sys.argv) > 4 else "/tmp/final-frames"
H = int(W * 0.625)
BG = (10, 10, 10)  # matches the terminal render background

shutil.rmtree(OUT, ignore_errors=True)
os.makedirs(OUT)

# App capture layout (from record-app-segments.js), 0-based [start, end) ranges.
SEG = [
    ("before", 0, 40),       # 40
    ("after", 40, 65),       # 25
    ("open-agent", 65, 80),  # 15
    ("run-agent", 80, 140),  # 60 (60fps slow-mo)
    ("agent-res", 140, 170), # 30
    ("nav-suites", 170, 180),# 10
    ("open-chaos", 180, 200),# 20
    ("run-chaos", 200, 236), # 36 (60fps slow-mo)
    ("expand", 236, 271),    # 35
    ("registry", 271, 306),  # 35
    ("nav-db", 306, 316),    # 10
    ("select-db", 316, 321), # 5
    ("query", 321, 351),     # 30
    ("outro", 351, 381),     # 30
]
# Target frame counts per app segment (10 = 1s). Static holds are cheap in
# GIF size (identical frames compress away); changed frames are the cost.
TARGETS = {
    "before": 12, "after": 12, "open-agent": 10, "run-agent": 25,
    "agent-res": 12, "nav-suites": 5, "open-chaos": 10, "run-chaos": 15,
    "expand": 18, "registry": 15, "nav-db": 5, "select-db": 3,
    "query": 15, "outro": 12,
}
# Terminal layout (10Hz capture): [0, 90) boot, [90, -65) activity, last 65 hold.
PI_BOOT, PI_HOLD = 90, 65
PI_BOOT_KEEP, PI_HOLD_KEEP, PI_EVERY = 10, 25, 5


def pick(seq: list[str], n: int) -> list[str]:
    """Evenly subsample seq to at most n items (keeps first and last)."""
    if len(seq) <= n:
        return seq
    step = len(seq) / n
    out = [seq[int(i * step)] for i in range(n - 1)]
    out.append(seq[-1])
    return out


def norm(src: str, dst_idx: int) -> None:
    im = Image.open(src).convert("RGB")
    im = im.resize((W, H), Image.LANCZOS)
    im.save(f"{OUT}/g{dst_idx:04d}.png")


def norm_pad(src: str, dst_idx: int) -> None:
    """Resize and center on a WxH canvas (terminal frames are shorter)."""
    im = Image.open(src).convert("RGB")
    im = im.resize((W, int(H * im.size[1] / im.size[0])), Image.LANCZOS)
    canvas = Image.new("RGB", (W, H), BG)
    canvas.paste(im, (0, (H - im.size[1]) // 2))
    canvas.save(f"{OUT}/g{dst_idx:04d}.png")


def main() -> None:
    app_f = sorted(f for f in os.listdir(APP) if f.endswith(".png"))
    pi_f = sorted(f for f in os.listdir(PI) if f.endswith(".png"))
    out: list[tuple[str, str]] = []

    # 1. App "before"
    out += [("app", os.path.join(APP, f)) for f in pick(app_f[:40], TARGETS["before"])]

    # 2. Terminal: boot, activity (changed-only, every Nth), hold
    boot = pick(pi_f[:PI_BOOT], PI_BOOT_KEEP)
    hold = pick(pi_f[-PI_HOLD:], PI_HOLD_KEEP)
    activity = pi_f[PI_BOOT:-PI_HOLD]
    changed: list[str] = []
    prev = None
    for f in activity:
        with open(os.path.join(PI, f.replace(".png", ".ansi")), "rb") as fh:
            data = fh.read()
        if data == prev:
            continue
        prev = data
        changed.append(f)
    act = changed[::PI_EVERY]
    out += [("pi", os.path.join(PI, f)) for f in boot + act + hold]

    # 3. App "after" + rest
    for name, a, b in SEG[1:]:
        out += [("app", os.path.join(APP, f)) for f in pick(app_f[a:b], TARGETS[name])]

    for i, (kind, src) in enumerate(out):
        (norm if kind == "app" else norm_pad)(src, i)
    total = len(out)
    print(f"final: {total} frames ≈ {total / 10:.1f}s @ {W}px "
          f"(terminal activity {len(act)}/{len(activity)}) -> {OUT}")


if __name__ == "__main__":
    main()
