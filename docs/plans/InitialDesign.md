# Initial Design — Payments Test Harness

A self-contained sample system with two runtime parts and a knowledge layer
that improves how both are used:

1. **C backend** — a small "payments" system made of three processes that talk to each
   other (and to us) over TCP sockets. Messages are C structs dispatched through
   function-pointer tables. No automated testing exists in the C code itself.
2. **Test harness app** (Electron + React + TypeScript) — plugs into the socket
   protocol, fakes external messages, executes persisted JSON **test suites**
   (steps + assertions) in realtime on a UI screen, and ships an **MCP server** so
   an LLM agent can author and run suites from a plain-English description.
3. **Knowledge pipeline** — a codebase-walking agent (kb-forge) that writes
   per-directory markdown **intern guides**; those guides ground an LLM
   **designer** (change request → design doc) and the harness's MCP test
   generator (plain-English request → suites that follow actual backend
   behavior, not just structurally valid JSON).

Everything in this document is the design of record. Build phases at the end
(P1–P6) take us from empty repo to a complete, demoable project. Coding rules
for every contributor — human or agent — live in
`docs/conventions/conventions.md` and are binding on all phases.

---

## 1. System overview

```
┌────────────────────────────── C BACKEND (make) ──────────────────────────────┐
│                                                                              │
│  pay-orders :9101      ledger :9102         auth-gateway :9103               │
│   ┌──────────────┐     ┌──────────────┐     ┌────────────────────┐           │
│   │ handler      │     │ handler      │     │ handler table      │           │
│   │ table        │     │ table        │     │ + outbound client  │           │
│   └──────┬───────┘     └──────┬───────┘     └───┬──────────┬─────┘           │
│          │ TCP 127.0.0.1      │                 │          │ inter-process   │
│          │                    │                 │          │ forward msgs    │
│          │                    │                 ▼          │ (to pay-orders, │
│          │                    │        ┌─────────────┐     │  to ledger)     │
│          │                    │        │             │     │                 │
│          └────────────────────┴───────►│  SQLite     │◄────┘                 │
│                                       │ payments.db │                       │
│                                       └─────────────┘                       │
└──────────────────────────────────────────────────────────────────────────────┘
        ▲ direct messages                 ▲ external messages (faked by us)
        │                                 │ / response capture
┌───────┴─────────────────────────────────┴────────────────────────────────────┐
│ HARNESS APP (Electron + React + TS)                                          │
│                                                                              │
│  main process                                                                │
│  ├─ backend-manager  spawn 3 procs, socket clients, capture, log tails       │
│  ├─ registry         runs each binary --introspect → messages.json           │
│  ├─ runner           executes JSON suites, emits live events (Node module,   │
│  │                    NOT electron-coupled → also runs headless via CLI)     │
│  ├─ suites           CRUD over suites/*.json (zod-validated)                 │
│  └─ mcp              MCP server (stdio) — tools for agents                   │
│                                                                              │
│  renderer (React)                                                            │
│  ├─ /            Processes screen (status, message tables, send console)     │
│  ├─ /suites      Suite list + editor (forms generated from registry)         │
│  └─ /runs        Run screen: live step timeline, assertion diffs, feeds      │
└──────────────────────────────────────────────────────────────────────────────┘

┌────────────────────────── KNOWLEDGE LAYER (kb-forge) ──────────────────────────┐
│  knowledge/*.md "intern guides" — one per source directory, generated from    │
│  the code: purpose, messages + side effects, modification points, risks,      │
│  inter-process interactions, domain vocabulary                                │
│                                                                               │
│  kb-forge agent ──writes──▶ guides ──read by──▶ designer CLI (change request)│
│                                      └──▶ test tool via MCP                   │
│                                          (kb_search / kb_read / schema notes) │
└───────────────────────────────────────────────────────────────────────────────┘
```

### The core trick

The C messages are **self-describing**. Each message is declared once with an
X-macro list of fields, which expands into:

- the C struct (the wire format),
- a `FieldDef` descriptor array (name, type, size, offset),
- one row in the process's **function-pointer table** (`MessageDef`), whose
  `handler` field is the function pointer that processes the message.

A `--introspect` mode prints that table as JSON. The harness script
(`scripts/introspect.mjs`) runs each binary with `--introspect` and merges the
output into a registry. **Everything downstream — UI forms, serialization in
the runner, the MCP schemas — is derived from that one registry.** There is
exactly one source of truth for message shapes, and it is generated from the
C code, not hand-maintained.

### The second trick

The same grounding idea extends from *structure* to *meaning*. A kb-forge agent
walks the codebase and writes one markdown **intern guide** per source
directory — how the code works, the messages it handles (with preconditions and
side effects), what gets modified commonly, the risks in each area, how it
interacts with other processes, and a domain-vocabulary table mapping business
terms to messages and functions. The guides are committed to the repo
(`knowledge/`, like the registry) and consumed by two LLM workflows: the
**designer** (change request → design doc) and the **test tool** (plain-English
request → suite JSON). Because the guides describe actual behavior — e.g. "on
approve, `Authorize` forwards `CompletePayment` to pay-orders" — an agent
writing tests from them asserts real side effects instead of producing merely
valid JSON. Details in §6.

---

## 2. Design principles

| Principle | Consequence |
|---|---|
| One source of truth for message shapes | Registry JSON is generated from `--introspect`; never hand-edited |
| Messages = fixed-size C structs | Binary wire protocol, trivially serializable from JSON payloads |
| Partial-match assertions | Only fields listed in `assert`/`expectAck` are validated; the rest are ignored (matches how real message validation works) |
| Runner is a plain Node module | Runs headless in CLI/CI and inside Electron main; testable without a UI |
| Deterministic system | Fixed ports, seeded DB, deterministic auth codes → suites are reproducible |
| Demo a failure, not just a pass | One committed suite is deliberately wrong so the Run screen can show expected-vs-actual diffs |
| Grounded generation | Agent-authored artifacts (suites, designs) are grounded in the KB + registry — plain English maps to real behavior, not just valid JSON |

---

## 3. C backend

### 3.1 Processes and ports

| Binary | Port | Role |
|---|---|---|
| `pay-orders` | 9101 | Payment lifecycle (create / cancel / complete) |
| `ledger` | 9102 | Fund transfers between accounts |
| `auth-gateway` | 9103 | External gateway: authorization & settlement; forwards to the other two processes |

All processes:

- listen on `127.0.0.1` only,
- accept multiple clients (the harness + `nc` + the smoke test),
- are single-threaded event loops (`select()`), handlers run inline (fast:
  a few SQLite statements),
- open the same SQLite file (WAL mode, `busy_timeout 5000`),
- read config from flags: `--db <path>` (required or `$PAY_DB`), `--port <n>`
  (default per process), `--introspect` (print table JSON and exit).

### 3.2 Wire protocol

One envelope per message, little-endian, no length prefix on the frame
(`payload_len` delimits the frame):

```
offset  size  field
0       2     magic       = 0x5046 ("PF")
2       2     msg_id      (process-local id, see 3.5)
4       4     payload_len (<= 2048; the struct size)
8       N     payload     (the struct bytes, fields at their C offsets)
```

Frame reading: need 8 header bytes → parse → read `payload_len` bytes.
Errors (bad magic, `payload_len > 2048`, unknown id, size mismatch) reply with
the process's built-in `ErrorAck` (id 255) and, for protocol errors, close the
client connection.

### 3.3 Self-describing messages (X-macro)

`backend/include/pay/message.h` (abridged, real code shape):

```c
typedef struct {
    const char *name;
    const char *type;
    size_t      size;
    size_t      offset;
} FieldDef;

typedef struct Envelope Envelope;
typedef int (*msg_handler_t)(const Envelope *env, int fd);

typedef struct {
    uint16_t      id;
    const char    *name;
    const char    *direction;    /* "in" (accepted) | "out" (emitted) */
    size_t        struct_size;
    const FieldDef *fields;
    size_t        n_fields;
    uint16_t      response_id;   /* "out" id produced by this message, 0 = none */
    msg_handler_t handler;       /* non-NULL for "in" only */
} MessageDef;

/* One field list → struct + field table. */
#define PF_FIELDS_CreatePayment(F) \
    F(txn_id,       uint32_t) \
    F(account,      char[16]) \
    F(amount_cents, uint32_t) \
    F(currency,     char[3])

struct CreatePaymentMsg {
#define PF_FIELD(name, type) type name;
    PF_FIELDS_CreatePayment(PF_FIELD)
};

static const FieldDef CreatePaymentMsg_fields[] = {
#define PF_FIELD(name, type) \
    { #name, #type, sizeof(type), offsetof(struct CreatePaymentMsg, name) },
    PF_FIELDS_CreatePayment(PF_FIELD)
};
```

Notes:

- `char[N]` fields are UTF-8, NUL-padded; JSON ↔ struct conversion trims at
  the first NUL.
- Integer fields: JSON number ↔ little-endian at the field's offset.
- Offsets come from `offsetof` — no hand-computed bytes anywhere.

### 3.4 Function-pointer tables and dispatch

Each process's `main.c` owns its table:

```c
static const MessageDef PAY_ORDERS_MSGS[] = {
    { MSG_CREATE_PAYMENT,  "CreatePayment",  "in",
      sizeof(CreatePaymentMsg), CreatePaymentMsg_fields, 4,
      MSG_PAYMENT_ACK, handle_create_payment },
    { MSG_CANCEL_PAYMENT,  "CancelPayment",  "in",
      sizeof(CancelPaymentMsg), CancelPaymentMsg_fields, 2,
      MSG_PAYMENT_ACK, handle_cancel_payment },
    { MSG_COMPLETE_PAYMENT,"CompletePayment","in",
      sizeof(CompletePaymentMsg), CompletePaymentMsg_fields, 1,
      MSG_PAYMENT_ACK, handle_complete_payment },
    { MSG_PAYMENT_ACK,     "PaymentAck",     "out",
      sizeof(PaymentAckMsg), PaymentAckMsg_fields, 2, 0, NULL },
    { MSG_ERROR_ACK,       "ErrorAck",       "out",
      sizeof(ErrorAckMsg), ErrorAckMsg_fields, 3, 0, NULL },
};

static int dispatch(int fd, const Envelope *env) {
    for (size_t i = 0; i < ARRAY_LEN(PAY_ORDERS_MSGS); i++) {
        const MessageDef *def = &PAY_ORDERS_MSGS[i];
        if (def->id == env->msg_id && strcmp(def->direction, "in") == 0) {
            if (env->payload_len != def->struct_size)
                return send_error(fd, env->msg_id, ERR_SIZE_MISMATCH);
            return def->handler(env, fd);
        }
    }
    return send_error(fd, env->msg_id, ERR_UNKNOWN);
}
```

Handlers are plain functions; they build the response struct on the stack and
send it on the client connection.

Message structs are `__attribute__((packed))`: `sizeof(struct)` equals the sum
of field sizes (no alignment padding), so the `payload_len` check and the
registry offsets are exact. Field lists are the single source of truth — they
generate both the struct and the `FieldDef` table via X-macro
(`PF_MSG`/`PF_FIELDS_*` in `include/pay/messages.h`); array fields use
fixed-size aliases (`PF_S16` …) because C cannot declare `char[16] name` in
prefix position, and the introspection table maps them back to canonical
`"char[16]"` strings.

### 3.5 Message catalog

IDs are process-local. `255` is reserved for `ErrorAck` in every process.
Offsets below are the packed-struct offsets as emitted by `--introspect`.

#### pay-orders (:9101)

| id | name | dir | fields (offset, type) | behavior |
|---|---|---|---|---|
| 10 | `CreatePayment` | in | txn_id (0,u32) · account (4,`char[16]`) · amount_cents (20,u32) · currency (24,`char[3]`) | INSERT `payments` status `open`; ack codes: 0 ok · 1 account_not_found · 2 duplicate_txn · 3 invalid |
| 11 | `CancelPayment` | in | txn_id (0,u32) · reason (4,`char[16]`) | `open → cancelled`; ack 0 ok · 3 not_open_or_missing |
| 12 | `CompletePayment` | in | txn_id (0,u32) | `open → complete`; ack 0 ok · 3 not_open_or_missing |
| 20 | `PaymentAck` | out | txn_id (0,u32) · status (4,u8) | — |

#### ledger (:9102)

| id | name | dir | fields | behavior |
|---|---|---|---|---|
| 30 | `TransferFunds` | in | txn_id (0,u32) · from_acct (4,`char[16]`) · to_acct (20,`char[16]`) · amount_cents (36,u32) | debit/credit + INSERT `ledger_entries`; ack 0 ok · 1 insufficient_funds · 2 account_not_found · 3 self_transfer |
| 31 | `ReverseTransfer` | in | txn_id (0,u32) | reverse **all** `applied` postings for the txn (a txn has several: transfer + settlement), mark them `reversed`; ack 0 ok · 4 no_entry |
| 32 | `TransferAck` | out | txn_id (0,u32) · status (4,u8) · from_balance_after (5,i32) | `from_balance_after` = −1 on error |

#### auth-gateway (:9103) — the external boundary

| id | name | dir | fields | behavior |
|---|---|---|---|---|
| 40 | `Authorize` | in (external) | txn_id (0,u32) · amount_cents (4,u32) | approve iff `payments` row exists and status `open`; on approve → **forward `CompletePayment` to pay-orders** over its own socket. `auth_code = "AU-%07u"(txn_id)` on approve, `""` on reject |
| 41 | `Settle` | in (external) | txn_id (0,u32) · fee_cents (4,u16) | require status `complete`; on success → **forward `TransferFunds(txn_id, account, "RESERVE", amount_cents)` to ledger**, set status `settled`; ack 0 ok · 1 not_complete · 2 already_settled |
| 42 | `AuthResponse` | out (external) | txn_id (0,u32) · approved (4,u8) · auth_code (5,`char[16]`) | — |
| 43 | `SettleAck` | out (external) | txn_id (0,u32) · status (4,u8) · settled_cents (5,u32) | — |

`auth-gateway` maintains persistent client connections to pay-orders and
ledger with reconnect-on-next-send (fire-and-forget forwarding; failures are
logged). This is what makes "processes communicate via sockets" true in both
directions. Note the settle forward is async: the gateway marks the payment
`settled` after a successful TCP send, not after the ledger's ack.

#### ErrorAck (every process)

| id | name | dir | fields | codes |
|---|---|---|---|---|
| 255 | `ErrorAck` | out | msg_id (0,u16) · code (2,u8) · detail (3,`char[24]`) | 1 unknown_message · 2 bad_magic · 3 oversized · 4 size_mismatch · 5 handler_error |

### 3.6 Database

`backend/db/schema.sql` (also the reset script — dropping is implicit:
reset = delete file, re-run schema):

```sql
PRAGMA journal_mode = WAL;

CREATE TABLE accounts (
    acct          TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    balance_cents INTEGER NOT NULL
);

CREATE TABLE payments (
    txn_id       INTEGER PRIMARY KEY,
    account      TEXT NOT NULL,
    amount_cents INTEGER NOT NULL,
    currency     TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'open'  -- open | cancelled | complete | settled
);

CREATE TABLE ledger_entries (
    entry_id     INTEGER PRIMARY KEY AUTOINCREMENT,
    txn_id       INTEGER NOT NULL,
    from_acct    TEXT NOT NULL,
    to_acct      TEXT NOT NULL,
    amount_cents INTEGER NOT NULL,
    status       TEXT NOT NULL DEFAULT 'applied' -- applied | reversed
);

INSERT INTO accounts VALUES ('ACCT-001', 'Acme Corp',   500000);
INSERT INTO accounts VALUES ('ACCT-002', 'Globex',      250000);
INSERT INTO accounts VALUES ('RESERVE',  'Reserve Fund', 1000000);
```

Access rules:

- C processes: read/write inside short transactions.
- Harness `Validate` steps: **read-only** handle (`better-sqlite3` open
  readonly) + SQL guard (must match `^\s*(SELECT|WITH)\b`, single statement).

### 3.7 Logging

stderr, one line per event, greppable:

```
2026-01-01T12:00:00.000Z [pay-orders] 127.0.0.1:54321 recv CreatePayment txn=1001
2026-01-01T12:00:00.004Z [pay-orders] 127.0.0.1:54321 send  PaymentAck txn=1001 status=0
2026-01-01T12:00:00.005Z [auth-gateway] fwd  CompletePayment → pay-orders:9101
```

The harness tails stderr into the log feed (ring buffer 1000 lines).

### 3.8 `--introspect` output

`pay-orders --introspect` prints to stdout (and exits 0):

```json
{
  "process": "pay-orders",
  "listen": "127.0.0.1:9101",
  "messages": [
    {
      "id": 10, "name": "CreatePayment", "direction": "in",
      "size": 27, "response": 20,
      "fields": [
        { "name": "txn_id",       "type": "uint32_t",  "size": 4,  "offset": 0 },
        { "name": "account",      "type": "char[16]",  "size": 16, "offset": 4 },
        { "name": "amount_cents", "type": "uint32_t",  "size": 4,  "offset": 20 },
        { "name": "currency",     "type": "char[3]",   "size": 3,  "offset": 24 }
      ]
    },
    {
      "id": 20, "name": "PaymentAck", "direction": "out",
      "size": 5, "response": 0,
      "fields": [
        { "name": "txn_id", "type": "uint32_t", "size": 4, "offset": 0 },
        { "name": "status", "type": "uint8_t",  "size": 1, "offset": 4 }
      ]
    }
  ]
}
```

(JSON is emitted by a small hand-rolled printer in `src/common/introspect.c` —
no C JSON library dependency.)

### 3.9 Build and run

`backend/Makefile` targets:

| target | action |
|---|---|
| `make` | build `build/{pay-orders,ledger,auth-gateway}` (C11, `-Wall -Wextra -Werror -O2`) |
| `make run` | `PAY_DB=$PWD/harness/data/payments.db ./run.sh` — starts all three, traps INT, logs to `build/*.log` |
| `make stop` | stop the run.sh children (pidfile `build/run.pid`) |
| `make introspect` | run all three with `--introspect`, pretty-print |
| `make check` | build with `-fsanitize=address,undefined` + run `tools/smoke_test.py` against it (leak/UB gate — conventions §4) |
| `make fmt` / `make fmt-check` | clang-format (`.clang-format`, Allman) write / verify (conventions §5) |
| `make clean` | remove `build/` |

Layout:

```
backend/
├── Makefile
├── run.sh
├── db/schema.sql
├── include/pay/{message.h, envelope.h, socket.h, db.h, log.h}
├── src/common/{envelope.c, socket.c, db.c, log.c, introspect.c}
├── src/pay_orders/{main.c, handlers.c}
├── src/ledger/{main.c, handlers.c}
├── src/auth_gateway/{main.c, handlers.c, forward.c}
└── tools/smoke_test.py        # stdlib-only Python; verifies everything in P1
```

### 3.10 Smoke test (pre-app verification)

`backend/tools/smoke_test.py` (Python stdlib only: `socket`, `struct`, `json`,
`sqlite3`):

1. Resets the DB (delete file, exec `schema.sql`).
2. Runs each binary with `--introspect`, `json.loads` the output, asserts the
   expected message names/fields are present.
3. Starts the three processes (the script starts and stops them itself;
   they run against a throwaway `build/<dir>/smoke.db` it initializes from
   `db/schema.sql`).
4. Executes 28 checks over raw sockets, whose codec is **registry-driven**
   (struct formats built from the `--introspect` field tables — the same
   strategy as the harness codec): happy path
   (`CreatePayment 9001` → ack 0; `TransferFunds 9001 ACCT-001→ACCT-002 1000`
   → `status 0`, balance 499000; `Authorize 9001` → approved with
   `AU-0009001`, which forwards `CompletePayment`; `Settle 9001` → settled
   1000, which forwards `TransferFunds`), error paths (duplicate txn, unknown
   account, insufficient funds, self-transfer, reverse transfer + double
   reverse, cancel, already-settled, authorize-after-settle), protocol errors
   (unknown id → ErrorAck 1, size mismatch → ErrorAck 4, bad magic → ErrorAck 2
   + connection close), and final SQLite state (payment `settled`, postings
   reversed, balances 498000 / 251000 / 1001000).
5. Prints a per-check PASS/FAIL table; exits non-zero on any failure.

This is the acceptance gate for the C backend before any harness code exists.

### 3.11 Error handling and edge cases

| Case | Backend behavior |
|---|---|
| Bad magic | `ErrorAck(2)` + close client |
| `payload_len > 2048` | `ErrorAck(3)` + close client |
| Unknown msg_id | `ErrorAck(1)`, connection stays open |
| Size mismatch vs table | `ErrorAck(4)`, connection stays open |
| Handler exception path (DB failure etc.) | `ErrorAck(5)` |
| Client disconnect mid-frame | drop partial buffer on that client |
| Gateway forward target down | retry with backoff; if still down, log + `ErrorAck(5)` to the external client |

### 3.12 Threading model

One thread per process; `select()` over listening socket + accepted clients.
SQLite operations are short (WAL, busy_timeout 5000 ms). Forwarding is a
synchronous write on a persistent localhost connection. This is deliberately
simple — it is a model system, and the interesting part is the message
architecture, not concurrency.

---

## 4. Introspection script and registry

### 4.1 `harness/scripts/introspect.mjs`

Plain Node (no deps, no TS):

1. For each of the three binaries: if missing, run `make -C backend` once.
2. Spawn `<bin> --introspect`, capture stdout, `JSON.parse`.
3. Validate the shape (process name, ≥1 message, fields have name/type/size/offset).
4. Write `harness/registry/messages.json`:

```json
{
  "generated_at": "2026-01-01T12:00:00.000Z",
  "processes": [ { …introspect output… }, { … }, { … } ]
}
```

5. Print a summary table (process, #in, #out).

### 4.2 Registry refresh policy

- `registry/messages.json` is **committed** so the repo is browsable without
  building.
- App startup: if the file is missing, or any binary is newer than the file's
  `generated_at`, regenerate automatically.
- Manual: `npm run introspect`, UI button, MCP (via `list_processes`
  freshness check — no dedicated tool; regeneration is cheap).

### 4.3 Serialization contract (registry → wire)

The runner and the UI use the same `encode/decode` helpers
(`src/shared/codec.ts`) driven purely by the registry:

- `uint8_t/uint16_t/uint32_t/int32_t` → JSON number ↔ little-endian at offset.
- `char[N]` → JSON string ↔ UTF-8 bytes, NUL-padded to N, trimmed at first NUL.
- A payload object must supply every field (UI forms enforce this; zod
  schema built from the registry enforces it for MCP-created suites).

---

## 5. Harness app

### 5.1 Stack

| Concern | Choice | Why |
|---|---|---|
| Shell | Electron + `electron-vite` | real desktop app; main process hosts all I/O |
| UI | React 18 + TypeScript + react-router 6 + zustand + Tailwind 3 | standard, fast, screenshots look clean |
| Validation | zod (suite + registry schemas) | one schema set shared by UI, MCP, runner |
| DB access | better-sqlite3 (read-only for Validate) | synchronous, tiny API; `postinstall: electron-builder install-app-deps` for the native rebuild |
| MCP | `@modelcontextprotocol/sdk` (stdio transport) | the standard TS SDK |
| Headless runs | `tsx` CLI entry (`src/cli/run.ts`) | run suites without Electron (CI-friendly) |

### 5.2 Layout

```
harness/
├── package.json
├── electron.vite.config.ts
├── tsconfig.json
├── scripts/introspect.mjs
├── registry/messages.json          # generated, committed
├── suites/*.json                   # 4 committed sample suites (§8)
├── data/payments.db                # gitignored; created/reset by harness
├── runs/*.json                     # gitignored; persisted run results
└── src/
    ├── shared/
    │   ├── types.ts                # TestSuite, Step, StepResult, RunResult, events
    │   ├── schemas.ts              # zod: suite + registry
    │   ├── codec.ts                # registry-driven encode/decode
    │   └── config.ts               # ports, paths, defaults (timeoutMs 2000)
    ├── main/
    │   ├── index.ts                # electron bootstrap
    │   ├── ipc.ts                  # channel wiring (typed)
    │   ├── backend-manager.ts      # spawn, sockets, capture, log ring buffer
    │   ├── registry.ts             # introspect orchestration
    │   ├── runner.ts               # ← the engine (also used by CLI)
    │   ├── suites.ts               # CRUD suites/*.json
    │   ├── db.ts                   # better-sqlite3 (readonly) + reset
    │   └── mcp/{server.ts, tools.ts}
    ├── cli/run.ts                  # npm run run:cli -- <suite-id>
    ├── kb/{index,context,prompts,write}.ts   # kb-forge (npm run kb / kb:check)
    ├── design/{index,outline}.ts             # designer (npm run design)
    ├── preload/index.ts            # contextBridge → window.api (typed)
    └── renderer/
        ├── index.html
        └── src/
            ├── main.tsx / App.tsx  # shell: sidebar + topbar
            ├── store.ts            # zustand: backend status, registry, run state, logs
            ├── components/         # ProcessCard, MessageForm, StepTimeline,
            │                       # AssertionTable, CaptureFeed, LogPane, …
            └── pages/
                ├── Processes.tsx
                ├── Suites.tsx
                ├── SuiteEditor.tsx
                ├── Runs.tsx
                └── RunView.tsx
```

### 5.3 Test suite format

Persisted as one JSON file per suite in `harness/suites/<id>.json`.

```ts
type ProcessName = "pay-orders" | "ledger" | "auth-gateway";
type Value = number | string;

interface TestSuite {
  id: string;                    // kebab-case; == filename
  name: string;
  description?: string;
  steps: Step[];                 // 1..256
}

type Step =
  | { type: "DirectBackendMessage";
      process: ProcessName;
      message: string;           // must be an "in" message of that process
      payload: Record<string, Value>;   // one entry per field, all required
      expectAck?: Record<string, Value>; // partial match on the response
      timeoutMs?: number }        // default 2000
  | { type: "ExternalMessage";     // same shape; semantically "we are the
      process: ProcessName;        // external system talking to the gateway"
      message: string;
      payload: Record<string, Value>;
      expectAck?: Record<string, Value>;
      timeoutMs?: number }
  | { type: "ExternalResponseMessage";
      process: ProcessName;
      message: string;           // must be an "out" message
      assert: Record<string, Value>; // partial match; unlisted fields ignored
      timeoutMs?: number }
  | { type: "WaitTimer"; ms: number }
  | { type: "Validate";
      label?: string;
      sql: string;               // SELECT/WITH only, single statement
      params?: Value[];
      expectRows?: number;       // default 1
      assert?: Record<string, Value>;          // partial match on row 0
      assertRows?: Record<string, Value>[];    // partial match per row, in order
      timeoutMs?: number };
```

Zod cross-checks against the registry (process exists, message exists with the
right direction, payload keys == field names, assert keys ⊆ field names).

### 5.4 Step execution semantics

The runner executes steps **sequentially** on one connection per process.
Single-flight means responses map to requests in order; `response_id` in the
registry is used to know *which* message to wait for.

| Step | Execution | Pass | Fail |
|---|---|---|---|
| `DirectBackendMessage` | encode payload → send → if `expectAck`, wait for the process's response message (≤ `timeoutMs`) | ack received; every `expectAck` field equal | timeout; field mismatch (report expected/actual per field) |
| `ExternalMessage` | same send path (we play the external system); `expectAck` optional | delivered (+ ack match if given) | timeout / ack mismatch |
| `ExternalResponseMessage` | wait on the capture buffer for the next envelope from `process` with the resolved msg id of `message` (≤ `timeoutMs`) | every `assert` field present and equal | timeout; field missing or unequal |
| `WaitTimer` | `setTimeout(ms)` | always | — |
| `Validate` | open DB read-only; run SQL; check `expectRows`; partial-match `assert` (row 0) or `assertRows` (per row) | row count + all listed fields equal | wrong row count; field mismatch; SQL rejected by guard |

Comparison: integers strict equality; strings exact (case-sensitive).
On the first failing step the run stops; remaining steps are recorded as
`skip` (the Run screen shows them greyed).

### 5.5 Runner events and results

```ts
type RunEvent =
  | { kind: "run:started";  runId: string; suiteId: string; startedAt: number }
  | { kind: "step:started"; runId: string; index: number; step: Step }
  | { kind: "step:finished"; runId: string; index: number; result: StepResult }
  | { kind: "message:captured"; runId: string; process: ProcessName;
      direction: "recv" | "send"; message: string; payload: Record<string, Value>;
      at: number }
  | { kind: "run:finished"; runId: string; result: RunResult };

interface StepResult {
  index: number;
  status: "pass" | "fail" | "skip";
  durationMs: number;
  detail?: string;
  sent?: { message: string; payload: Record<string, Value> };
  received?: { message: string; payload: Record<string, Value> };
  assertions?: { field: string; expected: Value; actual: Value | null; pass: boolean }[];
  error?: string;
}

interface RunResult {
  runId: string;            // timestamped
  suiteId: string;
  startedAt: number; finishedAt: number;
  status: "pass" | "fail";
  steps: StepResult[];
}
```

Every `RunResult` is persisted to `runs/<runId>.json`.

`backend:log` lines (from the C processes) and raw `message:captured` events
also flow to the UI regardless of which run is active.

### 5.6 Main-process modules

**backend-manager**
- `startAll() / stopAll()` — spawn each binary with `--db` + `--port`, cwd
  `backend/`; capture stderr into a 1000-line ring buffer; emit `backend:log`.
- One `BackendClient` per process: `net` socket to 127.0.0.1:port; frame
  reader (same codec as the runner); `send(msgId, buf)`; every received
  envelope → `message:captured` + waiter queue.
- Auto-reconnect (250 ms → 2 s backoff); status map `starting|running|stopped`.
- DB reset: stop-safe — delete file + exec `schema.sql` (used before runs from
  UI button and MCP tool).

**runner** — per §5.4/§5.5; `run(suite): RunHandle { id, stop() }`; emits the
`RunEvent` union via a small event emitter (subscribed by IPC bridge and by
MCP `run_suite`).

**suites** — list/get/save/delete over `suites/*.json`; save = zod validate +
write atomically (tmp + rename).

**mcp** — §7.

**ipc** — the channel table below; all payloads zod-validated on both sides.

### 5.7 IPC surface (preload → `window.api`)

| Method | Notes |
|---|---|
| `backend.start() / backend.stop() / backend.status()` | |
| `backend.onLogs(cb)` | event stream |
| `registry.get() / registry.refresh()` | |
| `suites.list() / get(id) / save(suite) / delete(id)` | |
| `runner.run(suiteId): runId` · `runner.stop(runId)` | |
| `runner.onEvent(cb)` | `RunEvent` stream |
| `runs.list() / get(runId)` | history |
| `db.reset()` | |
| `mcp.start() / stop() / status()` | |

### 5.8 UI

**Shell** — left sidebar (Processes / Suites / Runs), top bar: backend
power toggle (Start/Stop all), MCP status dot, `Reset DB` button, registry
`generated_at` + refresh button.

**Processes (`/`)**
- One card per process: status dot, port, message list from the registry —
  `in` rows get a **Send** action, `out` rows are read-only ("emitted by
  backend").
- Send console (bottom half): pick process → message → **auto-generated form**
  from registry fields (number vs string inputs, type + offset shown as hint)
  → Send → decoded response rendered as JSON with timestamp. This screen
  doubles as the "explore the protocol" toy for the demo.

**Suites (`/suites`)**
- List: id, name, step count, last run status/time; New / Open / Delete.
- Editor (`/suites/:id`):
  - Header: name, description, id (immutable).
  - Step list: add-step menu (the 5 types), up/down reorder, delete, expand.
  - Step forms (generated from registry):
    - `DirectBackendMessage` / `ExternalMessage`: process select (in-messages
      only) → message select → field form → optional `expectAck` (checkbox +
      value per response field) → timeout.
    - `ExternalResponseMessage`: process → message (out only) → assert
      checkboxes + values → timeout.
    - `WaitTimer`: ms input.
    - `Validate`: label, SQL textarea, `?`-param inputs (count derived from
      SQL), expectRows, assert key/value rows (or per-row rows for
      `assertRows`).
  - Validate button: zod + registry errors listed inline; Save persists.

**Runs (`/runs`)**
- Launcher: suite select (+ `Reset DB` checkbox) → Run.
- Live timeline: one row per step — icon (pending/running/pass/fail/skip),
  label, duration; expanded: sent payload, received payload, **assertion
  table** (field · expected · actual · ✓/✗) on failure.
- Right column: capture feed (every envelope, live) + backend log feed.
- History list (from `runs/`) → click to view a finished run.

State: single zustand store (`backendStatus`, `registry`, `suites`,
`activeRun`, `runs`, `logs` ring). All live updates arrive as IPC events;
the store applies them idempotently by `(runId, index)`.

---

## 6. Knowledge base (kb-forge) and its consumers

### 6.1 What it is

kb-forge is an LLM agent that walks the repo and writes one markdown **intern
guide** per source directory into `knowledge/`. Each guide explains how the
code in that directory works: the messages it handles (with preconditions and
side effects), key functions, what gets modified commonly, the risks in changing
each area, how it interacts with other processes, and a domain vocabulary that
maps business terms to messages and functions.

Guides are **generated, then committed** — the same pattern as the registry
(§4): committed files keep the repo fully usable offline; the generator
reproduces them when code changes. Two consumers build on the same corpus:

| Consumer | Where | Input | Output |
|---|---|---|---|
| **Designer** | `harness/src/design/` | plain-English change request | `docs/designs/<slug>-<date>.md` design doc |
| **Test tool** | MCP server in the harness | plain-English test request | suite JSON grounded in actual backend behavior |

### 6.2 Guide format (fixed schema)

Every guide uses the same `## ` headings, so retrieval is deterministic (§6.4)
and agents can navigate by section:

```markdown
# <dir> — Intern Guide
> generated 2026-01-01T00:00:00Z · kb-forge 0.1 · source sha256:ab12…

## Purpose                     one paragraph: what this directory is for
## Files                       table: file | role | ~lines
## Domain vocabulary           table: business term → message/function
## Messages                    (backend dirs) table: message | dir | precondition | side effect
## Key functions               table: function (file:line) | what it does
## Common modification points  e.g. "adding a message = new X-macro list + table row + handler"
## Risks                       table: area | risk | mitigation
## Inter-process interactions  who this talks to, on which socket, what it forwards
```

`knowledge/INDEX.md` lists every guide with a one-line purpose;
`knowledge/.manifest.json` stores `{path, sourceDir, sourceHash, generatedAt}`
per guide for staleness checks.

```
knowledge/
├── INDEX.md
├── .manifest.json
├── backend/{README.md, common.md, pay_orders.md, ledger.md, auth_gateway.md}
└── harness/{README.md, main.md, runner.md, mcp.md, renderer.md}
docs/designs/           ← designer output (committed sample: refund-message.md)
```

Example (committed, abridged):

````markdown
# backend/src/auth_gateway — Intern Guide
> generated 2026-01-01T00:00:00Z · kb-forge 0.1 · source sha256:9f31…

## Purpose
External boundary for authorization and settlement. Serves external clients on
:9103 and forwards lifecycle messages to the other processes.

## Messages
| Message | dir | Precondition | Side effect |
|---|---|---|---|
| `Authorize` (40) | in | payments row exists, status `open` | on approve → forwards `CompletePayment` to pay-orders:9101 |
| `Settle` (41) | in | status `complete` | forwards `TransferFunds` to ledger:9102; status → `settled` |

## Risks
| Area | Risk | Mitigation |
|---|---|---|
| `forward.c` | forward target down → external client gets `ErrorAck(5)` | reconnect 250 ms → 2 s; suites put a `WaitTimer` after forwards |
````

### 6.3 Generator (`harness/src/kb/`)

CLI in the harness package (Node/TS):

| Command | Action |
|---|---|
| `npm run kb` | regenerate all guides |
| `npm run kb:check` | rehash sources vs manifest; exit 1 listing stale guides |
| `npm run kb:write -- <dir>` | regenerate one guide |

Per-directory pipeline:

1. **Context assembly** — file listing + line counts; full text of headers and
   message-table files; extracted function signatures; the registry JSON for
   backend dirs; the relevant type/schema definitions for harness dirs.
2. **LLM call** — strict prompt template: produce exactly the §6.2 sections,
   cite `file:line` for every claim, and never invent — every message row must
   exist in the registry, every risk must reference a real file.
3. **Write** — guide + manifest entry + INDEX.md.

Provider config: `KB_PROVIDER` (default `openai`), `KB_MODEL`, `KB_BASE_URL`
(any OpenAI-compatible endpoint). Generation needs an API key; **consumption
never does** (committed files).

### 6.4 Retrieval — deterministic, no vector DB

`kb_search(query)` over ~15 small guides:

1. Tokenize the query (lowercase, split on non-alphanumeric, drop stopwords).
2. Split each guide into sections at `## ` headings.
3. Score sections: 3× per distinct query term in the heading, 2× per term in
   table rows (Messages / Domain vocabulary / Risks), 1× per term in body.
4. Return the top N (default 5) as `{path, section, score, excerpt}`
   (excerpt = section truncated to 40 lines).

Why not embeddings: the corpus is small and section-schema'd; term scoring is
explainable, unit-testable, and never flaky — which matters when the output is
agent-authored artifacts.

### 6.5 Consumer 1 — the test tool (MCP)

Two new MCP tools (added in P5):

| Tool | Args | Returns |
|---|---|---|
| `kb_search` | `query, limit? = 5` | scored sections |
| `kb_read` | `path, section?` | full guide or one section |

Plus two enrichments to existing tools:

- `get_message_schema` appends the KB `Messages` row for that message
  (precondition + side effect) as `notes`.
- `create_suite` failures include `kbHints`: the top `kb_search` hits for the
  failing message/field — the agent recovers by reading the guide.

For the A/B demo, `MCP_NO_KB=1` starts the server without the kb tools.

**The concrete win** (demo beat 5): a user asks "make a test that verifies an
external authorization completes a payment." A schema-only agent asserts
`AuthResponse.approved` and stops — structurally valid, behaviorally blind.
The KB-grounded agent reads `knowledge/backend/auth_gateway.md` ("on approve →
forwards `CompletePayment`…") and its suite adds `WaitTimer` +
`Validate status = "complete"` — asserting the real side effect. The `Domain
vocabulary` tables are what map "authorization", "settle", "complete" to actual
messages.

### 6.6 Consumer 2 — the designer (`harness/src/design/`)

`npm run design -- "<plain-English change request>"`

1. `kb_search` the request → load relevant guides + registry + the actual
   source of the affected files.
2. LLM call with a strict outline → `docs/designs/<slug>-<date>.md`:

```markdown
# Design: <title>
## Summary
## Affected components        table: process/file | change
## Proposed messages          X-macro list + catalog row (format matches §3.5)
## Handler sketch             C, matching existing handler style
## Database changes           SQL
## Risks                      cites KB lines with knowledge/ paths
## Inter-process impact       which forwards change
## Suggested test suites      JSON conforming to §5.3
```

Committed sample (generated with the real pipeline, browsable offline):
`docs/designs/refund-message.md` — "add a `Refund` message to the ledger",
referencing `handle_transfer_funds`, `ledger_entries`, and the `forward.c`
reconnect risk.

Design rule: the designer **proposes, does not apply** — output is a doc for a
human (or the next agent) to review, mirroring a real design review.

---

## 7. MCP server

Stdio server (`@modelcontextprotocol/sdk`), started from the app menu or
`npm run mcp`. Tools:

| Tool | Args | Returns |
|---|---|---|
| `list_processes` | — | per process: name, listen, running, message names + directions |
| `list_messages` | `process?` | full registry schemas (one or all processes) |
| `get_message_schema` | `process, name` | fields (name/type/size/offset) + response id |
| `list_suites` | — | `[{id, name, stepCount, lastRun}]` |
| `create_suite` | `suite: object` | `{id, path}` — zod + registry validation; errors are descriptive ("message 'Foo' has no field 'bar'") |
| `update_suite` | `id, suite` | same |
| `delete_suite` | `id` | `{deleted: true}` |
| `run_suite` | `id` | full `RunResult` (auto-starts backend if stopped) |
| `list_runs` / `get_run` | `runId?` | history / one result |
| `get_backend_logs` | `lines? = 200` | ring-buffer tail with process + timestamp |
| `reset_database` | — | `{ok: true}` (destructive; documented) |
| `kb_search` | `query, limit? = 5` | scored KB sections (§6.4) — added in P5 |
| `kb_read` | `path, section?` | full guide or one section — added in P5 |

The agent workflow this enables (the demo's money shot):

> "Create a test: payment 5001 from ACCT-002 to ACCT-001 for 50 dollars,
> authorize it externally, and verify ACCT-002's balance afterwards."

→ `kb_search("authorization")` (learns semantics: approval requires status
open, forwards completion) → `list_messages` (learns shapes) →
`create_suite` (JSON — includes the `Validate` on the forwarded state) →
`run_suite` → green. The KB steps are what make the suite follow real backend
behavior, not just valid JSON (§6.5).

---

## 8. Sample suites (committed in `harness/suites/`)

### 7.1 `payment-happy-path` — full lifecycle, all 5 step types

```json
{
  "id": "payment-happy-path",
  "name": "Payment happy path",
  "description": "Create payment, move funds, authorize + settle via the external gateway, verify all DB state.",
  "steps": [
    { "type": "Validate", "label": "pre: seeded balances",
      "sql": "SELECT balance_cents FROM accounts WHERE acct IN ('ACCT-001','ACCT-002','RESERVE') ORDER BY acct",
      "expectRows": 3,
      "assertRows": [ { "balance_cents": 500000 }, { "balance_cents": 250000 }, { "balance_cents": 1000000 } ] },
    { "type": "DirectBackendMessage", "process": "pay-orders", "message": "CreatePayment",
      "payload": { "txn_id": 1001, "account": "ACCT-001", "amount_cents": 25000, "currency": "USD" },
      "expectAck": { "status": 0 } },
    { "type": "DirectBackendMessage", "process": "ledger", "message": "TransferFunds",
      "payload": { "txn_id": 1001, "from_acct": "ACCT-001", "to_acct": "ACCT-002", "amount_cents": 25000 },
      "expectAck": { "status": 0, "from_balance_after": 475000 } },
    { "type": "ExternalMessage", "process": "auth-gateway", "message": "Authorize",
      "payload": { "txn_id": 1001, "amount_cents": 25000 } },
    { "type": "ExternalResponseMessage", "process": "auth-gateway", "message": "AuthResponse",
      "assert": { "txn_id": 1001, "approved": 1 }, "timeoutMs": 2000 },
    { "type": "WaitTimer", "ms": 200 },
    { "type": "Validate", "label": "gateway forwarded completion",
      "sql": "SELECT status FROM payments WHERE txn_id = ?", "params": [1001],
      "assert": { "status": "complete" } },
    { "type": "ExternalMessage", "process": "auth-gateway", "message": "Settle",
      "payload": { "txn_id": 1001, "fee_cents": 250 } },
    { "type": "ExternalResponseMessage", "process": "auth-gateway", "message": "SettleAck",
      "assert": { "txn_id": 1001, "status": 0, "settled_cents": 25000 }, "timeoutMs": 2000 },
    { "type": "Validate", "label": "post: settled balances",
      "sql": "SELECT balance_cents FROM accounts WHERE acct IN ('ACCT-001','ACCT-002','RESERVE') ORDER BY acct",
      "expectRows": 3,
      "assertRows": [ { "balance_cents": 450000 }, { "balance_cents": 275000 }, { "balance_cents": 1025000 } ] }
  ]
}
```

Balance math: ACCT-001 500000 − 25000 (transfer) − 25000 (settle) = 450000;
ACCT-002 250000 + 25000 = 275000; RESERVE 1000000 + 25000 = 1025000.

### 7.2 `insufficient-funds` — negative path with state check

```json
{
  "id": "insufficient-funds",
  "name": "Insufficient funds rejected",
  "description": "A transfer larger than the balance fails and leaves balances untouched.",
  "steps": [
    { "type": "Validate", "label": "pre: ACCT-002 balance",
      "sql": "SELECT balance_cents FROM accounts WHERE acct = ?", "params": ["ACCT-002"],
      "assert": { "balance_cents": 250000 } },
    { "type": "DirectBackendMessage", "process": "pay-orders", "message": "CreatePayment",
      "payload": { "txn_id": 2001, "account": "ACCT-002", "amount_cents": 5000000, "currency": "USD" },
      "expectAck": { "status": 0 } },
    { "type": "DirectBackendMessage", "process": "ledger", "message": "TransferFunds",
      "payload": { "txn_id": 2001, "from_acct": "ACCT-002", "to_acct": "RESERVE", "amount_cents": 5000000 },
      "expectAck": { "status": 1 } },
    { "type": "Validate", "label": "balance unchanged",
      "sql": "SELECT balance_cents FROM accounts WHERE acct = ?", "params": ["ACCT-002"],
      "assert": { "balance_cents": 250000 } },
    { "type": "Validate", "label": "payment still open",
      "sql": "SELECT status FROM payments WHERE txn_id = ?", "params": [2001],
      "assert": { "status": "open" } }
  ]
}
```

### 7.3 `cancel-payment` — cancel beats external authorization

```json
{
  "id": "cancel-payment",
  "name": "Cancelled payment rejects authorization",
  "steps": [
    { "type": "DirectBackendMessage", "process": "pay-orders", "message": "CreatePayment",
      "payload": { "txn_id": 3001, "account": "ACCT-001", "amount_cents": 10000, "currency": "USD" },
      "expectAck": { "status": 0 } },
    { "type": "DirectBackendMessage", "process": "pay-orders", "message": "CancelPayment",
      "payload": { "txn_id": 3001, "reason": "TEST" },
      "expectAck": { "status": 0 } },
    { "type": "Validate", "label": "cancelled",
      "sql": "SELECT status FROM payments WHERE txn_id = ?", "params": [3001],
      "assert": { "status": "cancelled" } },
    { "type": "ExternalMessage", "process": "auth-gateway", "message": "Authorize",
      "payload": { "txn_id": 3001, "amount_cents": 10000 } },
    { "type": "ExternalResponseMessage", "process": "auth-gateway", "message": "AuthResponse",
      "assert": { "txn_id": 3001, "approved": 0 }, "timeoutMs": 2000 }
  ]
}
```

### 7.4 `assertion-failure-demo` — deliberately wrong (shows diffs)

```json
{
  "id": "assertion-failure-demo",
  "name": "Deliberate assertion failure",
  "description": "Intentionally asserts a wrong balance so the Run screen can show an expected-vs-actual diff. Expected to FAIL.",
  "steps": [
    { "type": "DirectBackendMessage", "process": "pay-orders", "message": "CreatePayment",
      "payload": { "txn_id": 4001, "account": "ACCT-001", "amount_cents": 7500, "currency": "USD" },
      "expectAck": { "status": 0 } },
    { "type": "DirectBackendMessage", "process": "ledger", "message": "TransferFunds",
      "payload": { "txn_id": 4001, "from_acct": "ACCT-001", "to_acct": "ACCT-002", "amount_cents": 7500 },
      "expectAck": { "status": 0 } },
    { "type": "Validate", "label": "ACCT-001 balance (deliberately wrong)",
      "sql": "SELECT balance_cents FROM accounts WHERE acct = ?", "params": ["ACCT-001"],
      "assert": { "balance_cents": 12345 } }
  ]
}
```

Suite independence: suites assume a **fresh DB** (seeded). The UI Run
launcher has a `Reset DB` checkbox (default on) and the MCP `run_suite`
accepts `{id, reset?: boolean}` — default on, to keep agent runs deterministic.

---

## 9. Build phases

Each phase ends in a demonstrable state. Nothing in a later phase is required
to verify an earlier one.

### P1 — C backend (no app yet)

| # | Task |
|---|---|
| 1.1 | Repo init: rename working dir to `payments-test-harness`, git init, `.gitignore` (`backend/build/`, `harness/node_modules/`, `harness/data/`, `harness/runs/`, `harness/dist/`, `harness/out/`, `.DS_Store`) |
| 1.2 | `include/pay/*` headers: message.h (X-macro + tables), envelope.h, socket.h, db.h, log.h |
| 1.3 | `src/common/`: log.c, envelope.c (encode/decode/frame), socket.c (select loop, accept, per-client buffers), db.c (open WAL, exec, helpers), introspect.c (JSON printer) |
| 1.4 | `src/pay_orders/`: table + 3 handlers |
| 1.5 | `src/ledger/`: table + 2 handlers |
| 1.6 | `src/auth_gateway/`: table + 2 handlers + forward.c (persistent clients, reconnect) |
| 1.7 | `db/schema.sql` + seed, `run.sh`, `Makefile` |
| 1.8 | `tools/smoke_test.py` |
| 1.9 | Conventions scaffolding: `.clang-format` (Allman), `make check` (ASan/UBSan + smoke), `fmt`/`fmt-check` targets — per `docs/conventions/conventions.md` |

**Acceptance:** `make && python3 backend/tools/smoke_test.py` → all checks
pass from a clean tree; `make introspect` prints valid JSON for all three;
`nc 127.0.0.1 9101` shows the process is reachable; bad magic / unknown id /
wrong size each produce the right `ErrorAck` (smoke covers these).

### P2 — Introspection + headless runner + suites

| # | Task |
|---|---|
| 2.1 | `npm create electron-vite` scaffold (React + TS template) in `harness/`; deps: react, react-router, zustand, tailwind, zod, better-sqlite3, @modelcontextprotocol/sdk, tsx; conventions scaffolding: `.prettierrc`, husky + commitlint (scope enum), pre-commit fmt hooks |
| 2.2 | `src/shared/types.ts`, `schemas.ts`, `config.ts`, `codec.ts` |
| 2.3 | `scripts/introspect.mjs` → first `registry/messages.json` |
| 2.4 | `main/backend-manager.ts` (plain Node: child_process + net — **no** Electron imports) |
| 2.5 | `main/runner.ts` per §5.4–5.5 |
| 2.6 | `main/db.ts` (read-only + reset + SQL guard) |
| 2.7 | `cli/run.ts`: `npm run run:cli -- payment-happy-path [--reset]` — starts backend, runs, prints step table, exits with code |
| 2.8 | The 4 sample suites from §8 |

**Acceptance (the CI story):** fresh clone → `make` + `npm install` +
`npm run introspect` + `npm run run:cli -- payment-happy-path --reset` →
green, no Electron window, no UI involved. `assertion-failure-demo` exits
non-zero and prints the failing assertion diff.

### P3 — Electron app UI

| # | Task |
|---|---|
| 3.1 | electron-vite wiring: main index, preload `window.api` (§5.7), ipc.ts |
| 3.2 | Shell: sidebar, topbar (backend power, MCP dot, reset DB, registry info) |
| 3.3 | Processes screen: cards + registry message lists + generated send console |
| 3.4 | Suites list + editor (all 5 step forms, reorder, inline validation) |
| 3.5 | Runs screen: launcher, live timeline + assertion tables, capture feed, log feed, history |
| 3.6 | Zustand store + event wiring; Tailwind theme pass; empty states; error toasts |

**Acceptance:** from the UI alone — start backend, open Processes and send a
one-off CreatePayment, create a new suite from scratch in the editor, run
`payment-happy-path` and watch steps tick live, run `assertion-failure-demo`
and see the diff; a finished run is visible in history after restarting the
app.

### P4 — MCP server

| # | Task |
|---|---|
| 4.1 | `main/mcp/server.ts` + `tools.ts` — all 12 tools, zod-validated inputs |
| 4.2 | `run_suite` auto-starts backend; `reset` param; results = full RunResult |
| 4.3 | `npm run mcp` entry (stdio) + app menu start/stop; register in a local agent (Claude Desktop config and/or pi) as a smoke config |
| 4.4 | Agent-authored suite: the §7 demo prompt → suite appears in `suites/` and runs green |

**Acceptance:** with the app closed, `npm run mcp` + an agent session: the
agent discovers tools, authors a *new* suite (not one of the four), runs it,
reports results — no UI involvement at all.

### P5 — Knowledge pipeline (kb-forge, KB tools, designer)

| # | Task |
|---|---|
| 5.1 | KB guide format + `INDEX.md` + `.manifest.json` (`knowledge/`) |
| 5.2 | kb-forge: context assembly + prompt templates + provider config (`harness/src/kb/`) |
| 5.3 | Generate all guides (backend + harness) and commit; hand-verify each claim against the code |
| 5.4 | `kb:check` staleness (hash comparison, exit code) |
| 5.5 | MCP: `kb_search`, `kb_read`, `MCP_NO_KB` toggle, `get_message_schema` notes, `create_suite` kbHints |
| 5.6 | Designer CLI + committed sample design `docs/designs/refund-message.md` |

**Acceptance:** (a) KB browsable offline; (b) `npm run kb` regenerates guides
(with a key) and `kb:check` flags a touched source file; (c) A/B: for "make a
test that verifies an external authorization completes a payment", the
agent with kb tools produces a suite containing
`Validate status = "complete"` while with `MCP_NO_KB=1` it does not; (d)
designer output references real functions, real tables, and KB risk lines.

### P6 — Documentation, demo, polish

| # | Task |
|---|---|
| 6.1 | `README.md`: intro, architecture diagram (incl. knowledge layer), quickstart (clone → make → install → introspect → kb:check → dev), demo script, repo map |
| 6.2 | `docs/protocol.md` (wire format + full catalog + ErrorAck), `docs/mcp.md` (tool reference with example calls/returns), `docs/knowledge.md` (guide format, generator, retrieval, designer) |
| 6.3 | Screenshots: Processes, Suite editor, passing Run, failing Run with diff, KB guide, design doc |
| 6.4 | `LICENSE` (MIT); final README accuracy pass (every command executed verbatim) |

**Acceptance:** a stranger follows README quickstart from a fresh clone and
reaches a green happy-path run in under 10 minutes; the 6-minute demo script
below runs without ad-libbing.

---

## 10. Interview demo script (~6 minutes)

1. **0:00 — Build & introspect.** `make && npm install && npm run introspect` —
   "the registry is generated from the C function-pointer tables, not written."
2. **0:45 — Processes screen.** Three processes live; message tables visible;
   send a one-off `CreatePayment` in the console, decoded `PaymentAck` appears.
3. **1:45 — Happy path.** Run `payment-happy-path` → live timeline, 10/10
   green, DB state validated (balances), inter-process forwards visible in the
   log feed.
4. **3:00 — Failure demo.** Run `assertion-failure-demo` → step 3 fails with an
   expected-vs-actual table (12345 vs 492500), run stops, remainder skipped.
5. **4:00 — MCP grounded in the knowledge base.** In an agent: "make a test
   that verifies an external authorization completes a payment" → agent calls
   `kb_search`, reads the auth-gateway guide, and the generated suite contains
   the `Validate status = "complete"` step a schema-only agent misses →
   `run_suite` green; new suite visible in the app's Suites screen.
6. **5:15 — Designer.** In a terminal: `npm run design -- "add a Refund message
   to the ledger"` → design doc with X-macro + handler sketch + risks citing
   `knowledge/backend/ledger.md`.

---

## 11. README outline

- What it is (one paragraph): a payments backend (C, 3 socket processes,
  function-pointer message tables) + a test harness app (Electron) with
  persisted JSON suites, realtime execution, and an MCP server for
  agent-authored tests.
- Architecture diagram (§1).
- Quickstart (exact commands, macOS/Apple-clang tested).
- The message catalog (table) + link to `docs/protocol.md`.
- Test suite format + one short example.
- Knowledge pipeline: what kb-forge produces, how to regenerate (`npm run kb`),
  how the designer and the MCP test generation consume the guides
  (→ `docs/knowledge.md`).
- Demo script (§10).
- Repo map + "how the registry is generated" callout.
- Design notes (why partial-match assertions, why the runner is
  electron-free, why X-macros).

---

## 12. Design rationale (talking points)

- **One source of truth:** UI forms, runner serialization, and MCP schemas all
  derive from the same registry the C binaries emit. Add a message = one
  field list + one handler; everything else follows.
- **X-macro:** the struct and its metadata can never drift apart — they are
  generated from the same list.
- **Partial-match assertions** mirror how message validation actually works in
  production systems (you assert the fields that matter, not every byte).
- **Electron-free runner** → suites run in CI headless; the UI is a viewer and
  an authoring surface, not a dependency of the engine.
- **Deterministic demo:** seeded DB + deterministic auth codes + `reset`
  default → the same suite passes or fails the same way every time.
- **MCP as the authoring surface:** the agent is constrained by the same zod
  schemas a human editor uses, so agent-written and human-written suites are
  interchangeable.
- **Grounding layer:** agent artifacts (suites, designs) are grounded in the KB
  + registry — plain English maps to real behavior via vocabulary and
  side-effect tables, not just schema shape.
- **Generated, then committed:** registry, KB guides, and the sample design are
  all generated then committed — the repo is fully explorable offline; the
  generators (which need keys) are the maintenance path, not the demo dependency.
- **Deterministic retrieval:** fixed guide schema + term scoring = explainable,
  unit-testable lookup with no vector DB.

## 13. Risks and mitigations

| Risk | Mitigation |
|---|---|
| better-sqlite3 native rebuild in Electron | `postinstall: electron-builder install-app-deps`; verified in P2/P3 |
| SQLite lock contention (C writers + Node reader) | WAL + `busy_timeout 5000`; Validate steps are short reads |
| Gateway forward timing flake in suites | `WaitTimer` steps where ordering across processes matters; reconnect logic in forward.c |
| Electron packaging (distributables) | Out of scope: `npm run dev` is the story; note it in README |
| Port conflicts (9101–9103 in use) | startup check with a clear error; `--port` override exists |
| LLM nondeterminism in KB/design generation | strict section templates + cite-`file:line` rule + committed artifacts; regenerate on demand |
| API key needed for kb/design generation | committed KB + sample design = offline demo; generator is maintenance, not demo dependency |
| KB rot (guides drift from code) | `.manifest.json` hashes + `kb:check` (exit 1 on stale); quickstart runs it |

## 14. Open questions

None intentionally — the design is closed. Decisions left to the human: the
repo rename in task 1.1 (`payments-test-harness`) and the `KB_PROVIDER` /
`KB_MODEL` defaults for kb-forge and the designer.
