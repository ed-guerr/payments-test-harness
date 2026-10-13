# The demo GIF — how it was made

`docs/demo.gif` is a ~57-second recording (half speed: 286 frames at 5fps)
of the real, compiled app plus a
real `pi` session (a local LLM via llama.cpp) that authors and runs a test
suite through the harness MCP server. Nothing is scripted at the UI level —
the app frames are screen-captures driven by DOM clicks, and the terminal
frames are tmux captures of a live agent session.

## Segments

1. Suites list (the agent-authored suite is not there yet)
2. Terminal: `pi --provider llamacpp --model qwen3` boots, receives the
   prompt, calls `kb_search` → `get_message_schema` → `create_suite` →
   `run_suite` (the MCP tool calls are visible), ends with its summary
   (9/9 green)
3. Back in the app: the suite has appeared in the list; open it, run it
   (slow motion), results page
4. `ledger-chaos-kill`: run (slow motion), expand the `read ECONNRESET` row
5. Protocol Registry
6. Database: the agent suite's per-suite DB, `SELECT * FROM accounts`
7. Outro: suites list with the `✓ N passed` badges

## Reproduce

Requirements: `tmux`, `ffmpeg`, a Python venv with `pyte` + `pillow`,
macOS (for Menlo rendering), and a local pi provider configured
(`~/.pi/agent/models.json` — the GIF uses `llamacpp/qwen3` pointing at a
local llama.cpp server).

```sh
# 0. Build the app the frames are captured from
npm run build

# 1. App segments (381 frames ≈ 38s of app, incl. 60fps run segments)
cd harness && npx electron scripts/demo-gif/record-app-segments.js
#    -> /tmp/app-frames/fNNNN.png

# 2. Terminal: capture a real pi session (prompt = create + run a
#    no-double-settle test). Deletes the target suite first if you want the
#    "it appeared" moment to be genuine: rm harness/suites/no-double-settle.json
python3 scripts/demo-gif/capture_pi.py \
  "Use the harness MCP tools (kb_search, get_message_schema, create_suite, run_suite) to create and run a test suite that verifies a payment cannot be settled twice. Keep it minimal."
#    -> /tmp/pi-frames/fNNNN.ansi   (≈ 55–60s of real time)

# 3. Render the ANSI frames to PNG
python3 scripts/demo-gif/render_pi.py /tmp/pi-frames 180 45
#    -> /tmp/pi-frames/fNNNN.png

# 4. Compose (720px; segment targets in compose_gif.py)
python3 scripts/demo-gif/compose_gif.py 720
#    -> /tmp/final-frames/gNNNN.png  (≈ 286 frames)

# 5. Encode (5fps = half speed; use 10 for the ~29s full-speed cut)
ffmpeg -framerate 5 -i /tmp/final-frames/g%04d.png \
  -vf "palettegen=stats_mode=diff" /tmp/pal.png
ffmpeg -framerate 5 -i /tmp/final-frames/g%04d.png -i /tmp/pal.png \
  -lavfi "[0:v]paletteuse=dither=bayer:bayer_scale=4" docs/demo.gif
```

Notes:

- The terminal capture sends the prompt after 9s (TUI + MCP boot) and stops
  when the screen is idle for 4s after the 20s mark, then holds 2.5s.
- The compose step drops unchanged frames and subsamples each segment to a
  target duration; static holds are essentially free in GIF size, changed
  frames are the cost. 720px ≈ 3.8 MB at 57s half speed (same frames at
  29s full speed; the 1000px full-speed cut was ≈ 11 MB).
- `record-app-segments.js` moves the `no-double-settle.json` suite file
  aside for the "before" list and back for the "after" list — that is the
  "the agent's suite appeared in the app" beat.
