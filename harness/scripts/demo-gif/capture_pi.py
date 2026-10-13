"""capture_pi.py — run pi's TUI in tmux, capture ANSI frames at 10Hz.

Captures from TUI launch through the model's final answer. Stops when the
screen is idle (no changes) for IDLE_S after MIN_ELAPSED_S, then holds HOLD_S.
Frames land in the frame dir as fNNNN.ansi.

Usage:
  python3 capture_pi.py "<prompt>" [project_dir] [pi_command] [frame_dir]

Defaults:
  project_dir = the payments-test-harness repo root (two levels up from here)
  pi_command  = pi --provider llamacpp --model qwen3 --name gif-demo
  frame_dir   = /tmp/pi-frames

Note: the pi command must launch an interactive TUI (no pipes/tee — pi exits
immediately if stdout is not a TTY, which is why it runs inside tmux).
"""

import os
import shutil
import subprocess
import sys
import time

SESSION = "gifcap"
COLS, ROWS = 180, 45
IDLE_S = 4.0
HOLD_S = 2.5
MIN_ELAPSED_S = 20.0
PROMPT_AT_S = 9.0  # let the TUI + MCP server finish booting before typing

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_PROJECT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
DEFAULT_PI_CMD = "pi --provider llamacpp --model qwen3 --thinking off --name gif-demo"

PROMPT = sys.argv[1]
PROJECT = sys.argv[2] if len(sys.argv) > 2 else DEFAULT_PROJECT
PI_CMD = sys.argv[3] if len(sys.argv) > 3 else DEFAULT_PI_CMD
FRAME_DIR = sys.argv[4] if len(sys.argv) > 4 else "/tmp/pi-frames"


def tmux(*args: str) -> str:
    return subprocess.run(["tmux", *args], capture_output=True, text=True).stdout


def main() -> None:
    shutil.rmtree(FRAME_DIR, ignore_errors=True)
    os.makedirs(FRAME_DIR)
    tmux("kill-session", "-t", SESSION)
    time.sleep(0.3)
    tmux("new-session", "-d", "-s", SESSION, "-x", str(COLS), "-y", str(ROWS))
    time.sleep(0.5)
    tmux("send-keys", "-t", SESSION, f"cd {PROJECT}", "Enter")
    time.sleep(0.7)
    tmux("send-keys", "-t", SESSION, PI_CMD, "Enter")
    print("TUI launched, capturing from boot...")

    start = time.time()
    n = 0
    prompt_sent = False
    last = None
    last_change = time.time()
    hold_start = None
    next_t = time.time()

    while time.time() - start < 600:
        out = tmux("capture-pane", "-p", "-e", "-t", SESSION)
        with open(f"{FRAME_DIR}/f{n:04d}.ansi", "w", encoding="utf-8") as f:
            f.write(out)
        n += 1
        now = time.time()

        if not prompt_sent and now - start >= PROMPT_AT_S:
            tmux("send-keys", "-t", SESSION, PROMPT, "Enter")
            prompt_sent = True
            last_change = now
            print(f"prompt sent at {now - start:.1f}s")

        if out != last:
            last_change = now
            hold_start = None
        last = out

        if prompt_sent and now - start > MIN_ELAPSED_S and hold_start is None and now - last_change >= IDLE_S:
            hold_start = now
            print(f"model idle at {now - start:.1f}s, holding...")
        if hold_start and now - hold_start >= HOLD_S:
            break

        dt = next_t - time.time()
        if dt > 0:
            time.sleep(dt)
        next_t = max(next_t + 0.1, time.time())

    tmux("kill-session", "-t", SESSION)
    print(f"captured {n} frames in {time.time() - start:.1f}s -> {FRAME_DIR}")


if __name__ == "__main__":
    main()
