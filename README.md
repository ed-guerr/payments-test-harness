# payments-test-harness

A payments backend in C (three TCP processes, function-pointer message
tables, SQLite) plus a test-harness app in Electron/React/TypeScript that
runs persisted JSON test suites in realtime — and an **MCP server** that lets
an AI agent author those tests itself, grounded in a generated **knowledge
base** of per-directory "intern guides".

It is a self-contained sample of a real engineering pattern: *one source of
truth for the wire protocol, generated from the C code, consumed by every
layer* — and a knowledge pipeline that turns "the code says what fields
exist" into "the agent knows what the code does".

## Architecture

```
┌──────────────────────────── BACKEND (C11, 3 processes) ────────────────────────────┐
│                                                                                    │
│  pay-orders :9101        ledger :9102            auth-gateway :9103                 │
│  (payment lifecycle)     (double-entry)          (external auth/settle boundary)    │
│      │                         ▲                     │        │                     │
│      └── CompletePayment ──────┼─────────────────────┘   TransferFunds (settle)     │
│                                └───────────────────────────────────────────┐        │
│        ┌───────────────────────────────────────────────────────────────────▼──┐    │
│        │ shared: envelope codec · TCP server + function-pointer dispatch table │    │
│        │ SQLite (accounts, payments, ledger_entries, ledger_txns)              │    │
│        └───────────────────────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────────────────────────┘
        ▲ wire protocol (8-byte LE header + packed payload)
┌───────┴──────────────────────────────────────────────────────────────────────────────┐
│ HARNESS (Electron + React + TS)                                                      │
│  main:  backend cluster · registry (from --introspect) · runner (Node module,        │
│         electron-free) · suite CRUD · read-only db · MCP server (stdio, 15 tools)    │
│  renderer:  /suites  live run + step results + backend log                           │
│             /registry  the introspected wire protocol                                │
│             /database  read-only SQL over per-suite databases                        │
└──────────────────────────────────────────────────────────────────────────────────────┘
┌──────────────────────────── KNOWLEDGE LAYER (kb-forge) ─────────────────────────────┐
│  knowledge/*.md intern guides (one per source dir): messages + side effects, risks, │
│  inter-process interactions, domain vocabulary — generated, then committed          │
│  consumers:  MCP test author (kb_search/kb_read/schema notes) · designer CLI        │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

**The core trick.** Each C message is declared once as an X-macro field list
(`backend/include/pay/messages.h`) that expands into the packed struct *and*
the metadata table (name, type, `offsetof`). Each process's dispatch table is a
function-pointer array (`msg_id → handler`). A `--introspect` mode prints that
table as JSON; `npm run gen:registry` merges the three outputs into
`harness/src/protocol/registry.json`. The codec, the GUI, the suite validator,
and the MCP schemas all derive from that one file.

**The second trick.** kb-forge walks the code and writes per-directory guides
(what each message *does*, not just its shape). An agent that reads them
asserts real side effects — e.g. that an `Authorize` drives the payment to
`complete` via the gateway's forward — while a schema-only agent stops at the
local ack.

## Quickstart (macOS, Apple clang — tested)

```bash
# 1. Build the backend (C11, -Wall -Wextra -Werror -O2)
make -C backend

# 2. Harness deps + generated registry (runs the C binaries with --introspect)
cd harness
npm install
npm run gen:registry

# 3. Verify everything — one command:
npm run verify                  # backend build + ASan/UBSan smoke (28 checks) + fmt
                                # + typecheck + happy-path suite + MCP self-test
                                # (KB on/off A/B) + KB staleness check

# 4. The app
npm start                       # Electron: suites / registry / database
HARNESS_SELF_TEST=1 npm start   # headless e2e self-test (drives the real UI)
```

> **npm note (this machine's policy):** install scripts are blocked by
> default; approve them once with
> `npm install-scripts approve better-sqlite3 esbuild fsevents electron`.
> (The committed harness uses Node's built-in `node:sqlite`, so only the
> dev/build tooling needs approving.)

## The wire protocol

Little-endian frame: `u16 magic (0x5046) | u16 msg_id | u32 payload_len |
payload[]`; payloads are packed structs at the exact `offsetof` offsets.

| process | port | in messages | out messages |
|---|---|---|---|
| pay-orders | 9101 | CreatePayment (10) · CancelPayment (11) · CompletePayment (12) | PaymentAck (20) |
| ledger | 9102 | TransferFunds (30) · ReverseTransfer (31) | TransferAck (32) |
| auth-gateway | 9103 | Authorize (40) · Settle (41) | AuthResponse (42) · SettleAck (43) |
| all | — | — | ErrorAck (255) |

Full field tables, offsets, and ack status codes: [`docs/protocol.md`](docs/protocol.md).

## Test suites

Suites are plain JSON in `harness/suites/` — three step kinds, registry-
validated, each run against a **fresh backend cluster + fresh database**
(`harness/data/<suite>.db`, kept for inspection):

```json
{
  "id": "create",
  "send": { "to": "pay-orders", "msg": "CreatePayment",
            "fields": { "txn_id": 1001, "account": "ACCT-001",
                        "amount_cents": 50000, "currency": "USD" } },
  "expectAck": { "status": 0 }
}
```

- `send` — encode via the registry codec, wait for the matching ack;
  `expectAck` is a **partial match** on fields.
- `dbAssert` — one-row `SELECT` + partial match on columns (reads the same
  SQLite file the C processes write).
- `delayMs` — pacing across fire-and-forget inter-process forwards.

Four suites are committed: `payment-happy-path` (10/10 green),
`insufficient-funds`, `cancel-payment`, and `assertion-failure-demo`
(demonstrates a failing run with an expected-vs-actual diff).

```bash
npm run run:cli -- suites/insufficient-funds.json
```

## Knowledge pipeline

```bash
npm run kb                       # regenerate knowledge/ guides (deterministic)
npm run kb -- --llm              # …with LLM-enhanced prose (KB_API_KEY)
npm run kb:check                 # merge gate: stale guide = bug
npm run kb:search -- "authorization completes payment downstream"
npm run design -- "add a refund message that reverses a settled payment"
MCP_NO_KB=1 npm run design -- "…"   # A/B: schema-only design for contrast
```

kb-forge writes one **intern guide** per source directory (fixed section
schema: Purpose / Files / Domain vocabulary / Messages with preconditions and
side effects / Key functions with `file:line` / Common modification points /
Risks / Inter-process interactions). Consumers:

- **MCP test author** — `kb_search`/`kb_read` tools; `get_message_schema`
  carries the KB row as `notes`; `create_suite` failures carry `kbHints`.
  `MCP_NO_KB=1` disables it all (the A/B demo). → [`docs/mcp.md`](docs/mcp.md)
- **Designer** — turns a plain-English change request into a reviewable
  design doc (X-macro proposal, handler sketch, risks citing `knowledge/`
  paths, suggested suite). Sample outputs: [`docs/designs/`](docs/designs/).

→ [`docs/knowledge.md`](docs/knowledge.md)

## The 6-minute demo

1. **0:00 Build & introspect.** `make -C backend && npm run gen:registry` —
   "the registry is generated from the C function-pointer tables, not
   written."
2. **0:45 Protocol Registry tab.** Three processes live; open the tab: every
   message, field, type, size, and packed offset — all of it introspected.
3. **1:45 Happy path.** Run `payment-happy-path` in the app → live step
   timeline, 10/10 green, DB balances validated (400000 / 300000 /
   1050000 cents), forwards visible in the log feed.
4. **3:00 Failure demo.** Run `assertion-failure-demo` → a step fails with an
   expected-vs-actual diff; the run continues and reports the failure.
5. **4:00 Agent-authored test.** In any MCP client: *"make a test that
   verifies an external authorization completes a payment"* → the agent calls
   `kb_search`, reads `knowledge/backend/auth_gateway.md`
   ("on approve → forwards `CompletePayment`"), and the generated suite
   contains the downstream `dbAssert` a schema-only agent misses →
   `run_suite` green, suite visible in the app.
6. **5:15 Designer.** `npm run design -- "add a refund message that reverses a
   settled payment"` → design doc with X-macro list, handler sketch, and risks
   citing `knowledge/backend/ledger.md`.

## Repo map

```
backend/
  include/pay/        envelope, X-macro message defs, dispatch table, db, socket
  src/common/         codec, TCP server + dispatch, introspection, sqlite, log
  src/pay_orders/     payment lifecycle (:9101)
  src/ledger/         double-entry ledger (:9102)
  src/auth_gateway/   auth/settle boundary (:9103) + forwarding
  db/schema.sql       accounts, payments, ledger_entries, ledger_txns (+seed)
  tools/smoke_test.py 28-check protocol test (part of `make check`)
harness/
  src/protocol/       registry.json (generated) + codec + framed TCP client
  src/runner/         the suite engine (electron-free) + headless CLI
  src/backend/        cluster lifecycle, suite CRUD, path helpers
  src/main/           Electron main + preload bridge (+ self-test mode)
  src/renderer/       React UI (sandboxed) — suites / registry / database
  src/mcp/            MCP server (15 tools) + KB tools
  src/kb/             kb-forge generator + deterministic retrieval
  src/design/         the designer CLI
  suites/             4 committed sample suites
  scripts/            gen_registry.js · mcp-self-test.js
knowledge/            generated intern guides (+ INDEX.md + .manifest.json)
docs/
  plans/InitialDesign.md    the full design plan (phases P1–P6)
  conventions/conventions.md the project's conventions & gates
  protocol.md · mcp.md · knowledge.md
  designs/          sample designer output (KB-grounded vs schema-only pair)
```

## Design notes

- **Partial-match assertions.** Suites pin only the fields that matter, so a
  new ack field doesn't break every suite — pin it explicitly when it does.
- **The runner is electron-free.** Plain Node: the same engine drives the
  headless CLI, the app, and the MCP server.
- **X-macros over codegen.** The C is the generator: struct, metadata, and
  dispatch all come from one field list; `--introspect` is a print, not a
  pipeline.
- **Generated artifacts are committed.** Registry, guides, and a sample
  design are in the repo — the project is demoable offline, with no API keys.
- **Localhost only.** Everything binds 127.0.0.1; there is no network surface
  beyond 9101–9103 on loopback.

Conventions, gates, and commit policy: [`docs/conventions/conventions.md`](docs/conventions/conventions.md).

## License

MIT — see [LICENSE](LICENSE).
