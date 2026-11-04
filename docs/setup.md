# Setup: prerequisites and install

Moved out of the README in the 2026-11 README cut (recruiter-facing README stays
short; this is the depth).

## Prerequisites

- **Node ≥ 24 (LTS)**: the harness uses Node's built-in `node:sqlite` (no native
  module); CI runs the latest 24.x. Node 22 works at ≥ 22.13 (below that, add
  `--experimental-sqlite`).
- **C11 compiler**: Apple clang (Xcode command-line tools) on macOS; gcc +
  `libsqlite3-dev` on Linux.
- **Python 3**: the backend smoke test.
- **clang-format 23.1.3**: the exact version CI pins (fmt-check is
  version-sensitive): `python3 -m pip install clang-format==23.1.3`.

## Install (macOS, Apple clang, tested)

```bash
# 1. Build the backend (C11, -Wall -Wextra -Werror -O2)
make -C backend

# 2. Harness deps + generated registry (runs the C binaries with --introspect)
cd harness
npm install
npm run gen:registry

# 3. Verify everything: C build + ASan/UBSan smoke (31 checks) + fmt
#    + typecheck + unit tests + happy-path suite + MCP A/B
#    + recorded-trace replay + KB staleness
npm run verify

# 4. The app
npm start                       # Electron: suites / registry / database
HARNESS_SELF_TEST=1 npm start   # headless e2e self-test (drives the real UI)
```

### npm ≥ 11 note

Install scripts are blocked by default, so `npm install` mentions
esbuild/fsevents (dev tooling, not needed for `npm run verify`; fresh-clone
verified). Approve electron's once for the GUI:
`npm install-scripts approve electron`. The harness itself uses Node's built-in
`node:sqlite`, no native module.
