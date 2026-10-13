/**
 * kb/meta.ts — curated per-directory knowledge that seeds the intern guides.
 *
 * Curated and written by Qwen3 (local, via pi coding agent), 2026-10-13: every claim
 * below was verified against the C/TS sources and against live runs of the
 * backend cluster (notably: one ledger_entries row per transfer, the 9-byte
 * TransferAck/SettleAck field sets, Settle moving the FULL amount, and the
 * absence of any forward backoff).
 *
 * kb-forge has two modes:
 *  - deterministic (default, no API key): mechanical extraction (files,
 *    function signatures, message tables from the registry, cross-references)
 *    combined with the curated facts below. Fully reproducible offline; this
 *    is what the committed knowledge/ files are built with.
 *  - LLM-enhanced (KB_API_KEY + KB_PROVIDER set): the assembled context plus
 *    these facts is sent to an OpenAI-compatible chat endpoint, which rewrites
 *    the prose sections under a strict "cite file:line, never invent" prompt.
 */

export interface DirMeta {
  /** Source directory relative to repo root. */
  dir: string;
  /** Guide path under knowledge/. */
  guide: string;
  purpose: string;
  /** Business term -> what it maps to in code (message/function/table). */
  vocabulary: [term: string, mapsTo: string][];
  /** Per-message notes for backend dirs (registry provides id/direction). */
  messageNotes: Record<string, { precondition: string; sideEffect: string }>;
  modificationPoints: string[];
  risks: [area: string, risk: string, mitigation: string][];
  interactions: string[];
}

export const META: DirMeta[] = [
  {
    dir: "backend/src/common",
    guide: "backend/common.md",
    purpose:
      "Shared plumbing for all three backend processes: the wire codec (fixed 8-byte little-endian envelope), the TCP listener with a function-pointer dispatch table, the introspection emitter that powers the registry, SQLite helpers, logging, and argument parsing.",
    vocabulary: [
      ["envelope", "Envelope in include/pay/envelope.h — 8-byte header: u16 magic 0x5046 + u16 msg_id + u32 payload_len (<= PF_MAX_PAYLOAD 2048)"],
      ["dispatch table", "Handlers[] in src/common/messages.c — msg_id -> function pointer"],
      ["message table", "the PF_MSG_LIST X-macro lists in include/pay/messages.h"],
      ["registry", "output of --introspect (src/common/introspect.c); consumed by the harness"],
      ["drain client", "drain_client() in src/common/socket.c:114 — returns 0 = keep the connection open; non-zero closes it (server_run, socket.c:247)"],
      ["ack status codes", "include/pay/ack.h — ACK_* (payment), TR_* (transfer), ST_* (settle), ERR_* (ErrorAck codes 1-5)"],
    ],
    messageNotes: {},
    modificationPoints: [
      "Adding a message: add its field list to include/pay/messages.h (X-macro), add the id to include/pay/msg_ids.h, add a table row in the owning process's handlers.c, add a handler function.",
      "Changing a field changes every packed offset — regenerate the harness registry (npm run gen:registry) and re-run suites.",
    ],
    risks: [
      ["socket.c", "close condition: drain_client returns 0 = keep open, non-zero = close; server_run closes only on != 0", "regression closes clients after every successful response; smoke test 18/19 catches it"],
      ["envelope.c", "oversized frames (payload_len > PF_MAX_PAYLOAD 2048) and size mismatches", "validated in decode; ErrorAck codes 3 (ERR_OVERSIZED) / 4 (ERR_SIZE_MISMATCH)"],
      ["introspect.c", "registry drift: C structs change, registry not regenerated", "npm run gen:registry + suites validate against it"],
      ["db.c", "all three processes open the SAME SQLite file (each is spawned with --db <file>; WAL mode), so a crash mid-transaction can leave a shared db in a bad state", "all writes run inside explicit BEGIN IMMEDIATE ... COMMIT transactions (see db.c)"],
    ],
    interactions: [
      "Every process links this directory; handlers are pure (srv, client, envelope) functions reached only through the dispatch table.",
      "The shared database file is the real cross-process bus: any process can read any table (auth-gateway reads payments rows directly without asking pay-orders).",
    ],
  },
  {
    dir: "backend/src/pay_orders",
    guide: "backend/pay_orders.md",
    purpose:
      "Payment lifecycle owner. Serves :9101. Creates, cancels, and completes payment rows; owns the payments table and coordinates with the ledger (funds movement) and the auth gateway (completion trigger).",
    vocabulary: [
      ["payment", "row in payments table; status: open -> complete | open -> cancelled | complete -> settled"],
      ["create payment", "CreatePayment (10) -> PaymentAck (20)"],
      ["cancel payment", "CancelPayment (11); allowed only while status = open"],
      ["complete payment", "CompletePayment (12); forwarded here by auth-gateway after approval"],
    ],
    messageNotes: {
      CreatePayment: {
        precondition: "account exists in accounts table; txn_id unused (duplicate -> ack status 2)",
        sideEffect: "INSERT payments (status open); ledger TransferFunds acct->RESERVE is NOT done here (settlement moves funds)",
      },
      CancelPayment: {
        precondition: "payments row exists and status = open",
        sideEffect: "status -> cancelled (conditional UPDATE in db_payment_set_status)",
      },
      CompletePayment: {
        precondition: "payments row exists and status = open",
        sideEffect: "status -> complete; this is what auth-gateway forwards after a successful Authorize",
      },
      PaymentAck: {
        precondition: "response to 10/11/12",
        sideEffect: "none (status: 0 ok, 1 account not found, 2 duplicate txn, 3 invalid — include/pay/ack.h)",
      },
    },
    modificationPoints: [
      "New lifecycle state = new status value + handler branch + a suite that drives the transition.",
    ],
    risks: [
      ["handlers.c + db.c", "status transitions are enforced by conditional UPDATEs (db_payment_set_status matches the current status), not by a DB CHECK constraint", "dbAssert steps in suites pin the expected status after each transition"],
      ["main.c", "listens on 9101; auth-gateway hard-codes this port for forwarding", "keep ports stable or update forward.c"],
    ],
    interactions: [
      "auth-gateway forwards CompletePayment here on :9101 after approving an Authorize.",
    ],
  },
  {
    dir: "backend/src/ledger",
    guide: "backend/ledger.md",
    purpose:
      "Double-entry ledger. Serves :9102. Moves cents between accounts atomically: every TransferFunds updates both balances and records the debit/credit pair in ONE ledger_entries row (from_acct/to_acct/amount_cents, status 'applied'), all inside a single BEGIN IMMEDIATE ... COMMIT transaction (db_transfer, src/common/db.c:199).",
    vocabulary: [
      ["balance", "accounts.balance_cents; updated only inside db_transfer / db_ledger_reverse transactions"],
      ["transfer", "TransferFunds (30) — debit `from`, credit `to`"],
      ["reverse", "ReverseTransfer (31) — reverses ALL applied entries of a txn in one transaction (status -> 'reversed', balances restored)"],
      ["postings", "ledger_entries rows (id, txn_id, from_acct, to_acct, amount_cents, status); one row per transfer, both legs in the same row"],
    ],
    messageNotes: {
      TransferFunds: {
        precondition: "both accounts exist and are different (self-transfer -> status 3); from balance >= amount",
        sideEffect: "atomic: both accounts updated + ONE ledger_entries row (status 'applied') in a single transaction; there is no ledger_txns table",
      },
      ReverseTransfer: {
        precondition: "txn has applied ledger_entries rows (up to MAX_POSTINGS 8; more than 8 is an error, db.c:257)",
        sideEffect: "restores each applied entry's balances and marks the rows status='reversed' in one transaction; must flip exactly the selected rows or rolls back",
      },
      TransferAck: {
        precondition: "response to 30/31",
        sideEffect: "status (0 ok, 1 insufficient funds, 2 unknown account, 3 self-transfer, 4 no applied entry) + from_balance_after — the ack is 9 bytes; to_balance_after is NOT on the wire",
      },
    },
    modificationPoints: [
      "New account types / posting kinds = new ledger_entries columns or new handler branch; keep the transaction atomic.",
    ],
    risks: [
      ["handlers.c + db.c", "insufficient funds must reject atomically (no partial postings)", "single transaction; smoke test 24 checks zero balance change"],
      ["db.c", "reversal of a txn with > MAX_POSTINGS (8) entries silently truncates the cursor and returns an error", "documented limit (db.c:257); return handler error"],
      ["db schema", "ledger_entries.txn_id is NOT unique by design: a payment txn accumulates a transfer entry and a settle entry", "dbAssert must aggregate per txn (SUM/COUNT with care), not assume one row per txn for full payment lifecycles"],
    ],
    interactions: [
      "pay-orders and auth-gateway send transfers here (auth-gateway on settle); only the ledger writes accounts/ledger tables.",
    ],
  },
  {
    dir: "backend/src/auth_gateway",
    guide: "backend/auth_gateway.md",
    purpose:
      "External boundary for authorization and settlement. Serves external clients on :9103 and forwards lifecycle messages to the other processes — the only process that talks to both pay-orders and the ledger.",
    vocabulary: [
      ["authorization", "Authorize (40) — approval decision from the (simulated) external acquirer"],
      ["settlement", "Settle (41) — moves funds through the ledger; the fee is accepted but NOT modeled in the ledger"],
      ["auth code", "AU-%07u, minted in handlers.c on approval"],
      ["forwarding", "forward.c — fire-and-forget TCP; the response is never read; on failure the socket is closed and the NEXT send reconnects (no backoff timer)"],
    ],
    messageNotes: {
      Authorize: {
        precondition: "payments row exists, status open (the row is read directly from the shared db)",
        sideEffect: "on approve -> forwards CompletePayment to pay-orders:9101 (fire-and-forget; AuthResponse is sent whether or not the forward succeeded — a failed forward is only logged and retried on the next send)",
      },
      Settle: {
        precondition: "payments row exists and status = complete (settled -> ST_SETTLED; anything else -> ST_NOT_COMPLETE)",
        sideEffect: "forwards TransferFunds to ledger:9102 with the FULL amount (to RESERVE; fee_cents is not subtracted — 'not modeled in ledger', handlers.c), then status -> settled; ack carries settled_cents = full amount",
      },
      AuthResponse: {
        precondition: "response to 40",
        sideEffect: "approved flag + auth_code; NOTE: a forwarded CompletePayment may still be in flight — assert payment status with a WaitTimer",
      },
      SettleAck: {
        precondition: "response to 41",
        sideEffect: "status (0 ok, 1 not complete, 2 already settled) + settled_cents (the full amount; fee_cents is NOT on the wire — the ack is 9 bytes)",
      },
    },
    modificationPoints: [
      "New external-facing message = handler here + a forward target (if it drives another process) + a suite that asserts the DOWNSTREAM effect, not just this ack.",
    ],
    risks: [
      ["forward.c", "forward target down -> Authorize STILL returns approved (forward failure is only logged, retried on next send); Settle returns ST_NOT_COMPLETE (the ack's initial value) even though the real cause is the failed forward", "no backoff (fwd_send reconnects lazily); suites put a delay after forwards and assert the downstream db state"],
      ["handlers.c", "Settle before CompletePayment must be rejected", "status check; suite assertion-failure-demo shows the failure mode"],
      ["forwarding order", "forwards are fire-and-forget: AuthResponse can arrive before CompletePayment is processed", "test suites use delayMs steps before downstream dbAsserts"],
    ],
    interactions: [
      "Forwards CompletePayment to pay-orders:9101 on approve; forwards TransferFunds to ledger:9102 on settle.",
      "Shares the same SQLite file as the other backends (harness spawns each with --db <file>), so it reads payments rows directly.",
    ],
  },
  {
    dir: "harness/src/runner",
    guide: "harness/runner.md",
    purpose:
      "The suite execution engine. Interprets suite JSON (send / dbAssert / delayMs steps) against a live backend cluster, streams step results as events, and persists run results. Used by the headless CLI, the Electron main process, and the MCP server — with no Electron imports.",
    vocabulary: [
      ["send step", "send:{to,msg,fields} — encodes via the registry-driven codec"],
      ["expectAck", "partial match on the response fields (subset semantics)"],
      ["dbAssert", "single-row SELECT + partial expect on columns"],
      ["runner event", "step-start / step-result / suite-result, consumed by CLI+GUI+MCP"],
    ],
    messageNotes: {},
    modificationPoints: [
      "New step kind = new case in runStep() + schema in suites.ts + renderer row in SuitePage.",
    ],
    risks: [
      ["runner.ts", "matchAck subset semantics: extra ack fields are ignored (matchAck, runner.ts:211)", "intentional (keeps suites stable); pin new fields explicitly when they matter"],
      ["cli.ts", "one fresh backend + db per suite run", "suites are independent by design; shared-state tests need a new step kind"],
    ],
    interactions: [
      "Consumes protocol/codec + protocol/conn; emits events to the CLI (console), Electron main (IPC), and MCP (collected into run results).",
    ],
  },
  {
    dir: "harness/src/protocol",
    guide: "harness/protocol.md",
    purpose:
      "Wire protocol layer in TypeScript. registry.json (generated from the C binaries' --introspect) is the single source of truth; codec.ts packs/unpacks messages at the exact packed offsets; conn.ts is the framed TCP client (8-byte header accumulation, deadline-aware recv).",
    vocabulary: [
      ["registry", "registry.json — processes, messages, fields, packed offsets"],
      ["frame", "8-byte LE header (magic 0x5046, msg_id, payload_len) + payload"],
      ["conn", "Conn class — send(msgId, payload) / recv(msgId, deadline) / close()"],
    ],
    messageNotes: {},
    modificationPoints: [
      "Protocol changes happen in C first; then npm run gen:registry; the codec needs no edits (offset-driven).",
    ],
    risks: [
      ["codec.ts", "registry drift (C changed, registry stale) -> silent mis-decode", "field offsets come from sizeof/offsetof in C, never re-derived here"],
      ["conn.ts", "partial TCP frames", "buffer accumulation loop in _read"],
    ],
    interactions: [
      "Feeds the runner, the MCP schemas, and the GUI registry viewer.",
    ],
  },
  {
    dir: "harness/src/main",
    guide: "harness/main.md",
    purpose:
      "Electron main process. Creates the sandboxed BrowserWindow (contextIsolation on, nodeIntegration off, sandbox on), hosts every IPC handler (suites, runner, read-only db access), and includes a headless self-test mode (HARNESS_SELF_TEST=1) that drives the real renderer through the real preload bridge.",
    vocabulary: [
      ["preload bridge", "window.harness exposed via contextBridge in preload.ts"],
      ["IPC channels", "suite:list / suite:read / suite:run / data:files / data:query / runner:event (main.ts:48ff)"],
      ["self-test", "HARNESS_SELF_TEST=1 npm start — e2e verification without a human"],
    ],
    messageNotes: {},
    modificationPoints: [
      "New IPC capability = handler in main.ts + bridge method in preload.ts + renderer usage (never require() in the renderer).",
    ],
    risks: [
      ["main.ts", "renderer must stay sandboxed", "all fs/child_process/sqlite in main only"],
      ["paths", "dist/ layout differs from src/ (tsconfig outDir)", "paths.ts walks up to package.json instead of hard-coding relative depth"],
    ],
    interactions: [
      "Spawns backend processes via backend/cluster.ts; streams runner events to the renderer over runner:event.",
    ],
  },
  {
    dir: "harness/src/mcp",
    guide: "harness/mcp.md",
    purpose:
      "The Model Context Protocol server (stdio). This is the agent-facing API: protocol introspection from the registry, suite CRUD (validated before write), suite execution against fresh backend clusters, and read-only db access. KB tools (kb_search/kb_read) join in P5; MCP_NO_KB=1 disables them for the A/B demo.",
    vocabulary: [
      ["tool", "MCP tool = named function with zod input schema"],
      ["stdio transport", "newline-delimited JSON-RPC over stdin/stdout"],
      ["MCP_NO_KB", "env flag: start the server without the knowledge-base tools (A/B demo, server.ts:262)"],
    ],
    messageNotes: {},
    modificationPoints: [
      "New tool = server.registerTool(name, {description, inputSchema}, handler) — keep descriptions rich; they are the agent's documentation.",
    ],
    risks: [
      ["server.ts", "suite names are file names", "suiteFile() enforces a safe id charset"],
      ["db_query", "read-only by construction (opened readonly + SELECT-only guard)", "defense in depth: the process also never gets a write handle"],
    ],
    interactions: [
      "Reuses the runner and codec directly; no Electron involved — runs under plain Node (tsx).",
    ],
  },
  {
    dir: "harness/src/renderer",
    guide: "harness/renderer.md",
    purpose:
      "React UI (sandboxed, no Node). Three tabs: Suites (list + live run with per-step results and the backend log), Protocol Registry (the introspected wire protocol), Database (read-only SQL against per-suite databases). State lives in a zustand store fed by the preload bridge.",
    vocabulary: [
      ["store", "store.ts — zustand: stepResults, suiteResults, backend log"],
      ["bridge", "window.harness.* (see preload.ts)"],
    ],
    messageNotes: {},
    modificationPoints: [
      "New tab = page component + route in App.tsx + store slice if it has state.",
    ],
    risks: [
      ["all", "no direct node/fs access allowed (sandboxed)", "request data via the preload bridge"],
    ],
    interactions: [
      "Only talks to the main process via window.harness; receives runner:event pushes.",
    ],
  },
];
