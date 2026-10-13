# The demo GIF — how it was made

`docs/demo.gif` is a ~51-second recording (half speed: 253 frames at 5fps, 1000px)
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
   (10/10 green)
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
  "Use the harness MCP tools to create and run a test suite that verifies a payment cannot be settled twice. The tools (kb_search, get_message_schema, create_suite, run_suite) live on the mcp__harness MCP server: call them from codemode scripts as tools.mcp__harness__kb_search(...) and so on. Do not ask me questions — if something fails, work around it and continue. Keep the suite minimal. In your final message, summarize with short plain lines (one per step, under 90 characters), no markdown tables."
#    (the prompt points the model at the codemode — where the MCP tools are
#     reachable — and forbids ask_user_question, which would stall the
#     capture waiting for input)
#    -> /tmp/pi-frames/fNNNN.ansi   (≈ 55–60s of real time)

# 3. Render the ANSI frames to PNG (scale 2 = 2x supersampled text)
python3 scripts/demo-gif/render_pi.py /tmp/pi-frames 180 45 2
#    -> /tmp/pi-frames/fNNNN.png

# 4. Compose (1000px; segment targets in compose_gif.py)
python3 scripts/demo-gif/compose_gif.py 1000
#    -> /tmp/final-frames/gNNNN.png  (≈ 253 frames)

# 5. Encode (5fps = half speed; use 10 for the ~29s full-speed cut)
ffmpeg -framerate 5 -i /tmp/final-frames/g%04d.png \
  -vf "palettegen=stats_mode=diff" /tmp/pal.png
ffmpeg -framerate 5 -i /tmp/final-frames/g%04d.png -i /tmp/pal.png \
  -lavfi "[0:v]paletteuse=dither=none" docs/demo.gif
```

Notes:

- `--thinking off` keeps the capture clean: without it, pi's TUI renders the
  model's thinking as a staggered cascade that reads as jumbled text in the
  GIF. The compact-summary instruction keeps the final message from producing
  a markdown table wider than the terminal.
- render_pi.py converts the capture's bare-LF row endings to CRLF before
  replaying them through pyte — without that, rows of differing length drift
  rightward and the terminal looks jumbled too.
- The terminal capture sends the prompt after 9s (TUI + MCP boot) and stops
  when the screen is idle for 4s after the 20s mark, then holds 2.5s.
- The compose step drops unchanged frames and subsamples each segment to a
  target duration; static holds are essentially free in GIF size, changed
  frames are the cost. 1000px ≈ 5 MB at 51s half speed (the same frames at
  720px are ≈ 2.8 MB; 1280px ≈ 7 MB). dither=none is correct for this
  flat dark UI — Bayer dithering just adds grain and bloats the file.
- `record-app-segments.js` moves the `no-double-settle.json` suite file
  aside for the "before" list and back for the "after" list — that is the
  "the agent's suite appeared in the app" beat.
