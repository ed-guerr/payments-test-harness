/**
 * kb/meta.ts — curated per-directory knowledge that seeds the intern guides.
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
      ["envelope", "Envelope in include/pay/envelope.h — magic 0x5046 + msg_id + payload_len"],
      ["dispatch table", "Handlers[] in src/common/messages.c — msg_id -> function pointer"],
      ["message table", "the PF_MSG_LIST X-macro lists in include/pay/messages.h"],
      ["registry", "output of --introspect (src/common/introspect.c); consumed by the harness"],
      ["drain client", "drain_client() in src/common/socket.c — 0 = keep connection open"],
    ],
    messageNotes: {},
    modificationPoints: [
      "Adding a message: add its field list to include/pay/messages.h (X-macro), add the id to include/pay/msg_ids.h, add a table row in the owning process's handlers.c, add a handler function.",
      "Changing a field changes every packed offset — regenerate the harness registry (npm run gen:registry) and re-run suites.",
    ],
    risks: [
      ["socket.c", "close condition: drain_client returns 0 = keep open, -1 = close; server_run closes only on != 0", "regression closes clients after every successful response; smoke test 18/19 catches it"],
      ["envelope.c", "oversized frames (payload_len > 2048) and size mismatches", "validated in decode; ErrorAck codes 3/4"],
      ["introspect.c", "registry drift: C structs change, registry not regenerated", "npm run gen:registry + suites validate against it"],
    ],
    interactions: [
      "Every process links this directory; handlers are pure (srv, client, envelope) functions reached only through the dispatch table.",
    ],
  },
  {
    dir: "backend/src/pay_orders",
    guide: "backend/pay_orders.md",
    purpose:
      "Payment lifecycle owner. Serves :9101. Creates, cancels, and completes payment rows; owns the payments table and coordinates with the ledger (funds movement) and the auth gateway (completion trigger).",
    vocabulary: [
      ["payment", "row in payments table; status: open -> complete | open -> cancelled"],
      ["create payment", "CreatePayment (10) -> PaymentAck (20)"],
      ["cancel payment", "CancelPayment (11); allowed only while status = open"],
      ["complete payment", "CompletePayment (12); forwarded here by auth-gateway after approval"],
    ],
    messageNotes: {
      CreatePayment: {
        precondition: "account exists in accounts table",
        sideEffect: "INSERT payments (status open); ledger TransferFunds acct->RESERVE is NOT done here (settlement moves funds)",
      },
      CancelPayment: {
        precondition: "payments row exists and status = open",
        sideEffect: "status -> cancelled",
      },
      CompletePayment: {
        precondition: "payments row exists and status = open",
        sideEffect: "status -> complete; this is what auth-gateway forwards after a successful Authorize",
      },
      PaymentAck: {
        precondition: "response to 10/11/12",
        sideEffect: "none (status 0 = ok, 1 = rejected)",
      },
    },
    modificationPoints: [
      "New lifecycle state = new status value + handler branch + a suite that drives the transition.",
    ],
    risks: [
      ["handlers.c", "status transitions are enforced only in handlers, not by DB constraints", "dbAssert steps in suites pin the expected status after each transition"],
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
      "Double-entry ledger. Serves :9102. Moves cents between accounts atomically: every TransferFunds writes a balanced pair of postings (debit/credit) plus an audit row in one SQLite transaction.",
    vocabulary: [
      ["balance", "accounts.balance_cents; updated only inside ledger transactions"],
      ["transfer", "TransferFunds (30) — debit `from`, credit `to`"],
      ["reverse", "ReverseTransfer (31) — reverses ALL applied postings of a txn in one transaction"],
      ["postings", "ledger_entries rows (txn_id, account, delta_cents)"],
    ],
    messageNotes: {
      TransferFunds: {
        precondition: "both accounts exist; from balance >= amount",
        sideEffect: "atomic: accounts updated + 2 ledger_entries rows + 1 ledger_txns row",
      },
      ReverseTransfer: {
        precondition: "txn has applied postings",
        sideEffect: "reverses every applied posting for the txn (up to 8); balances restored",
      },
      TransferAck: {
        precondition: "response to 30/31",
        sideEffect: "carries resulting balances (from_balance_after, to_balance_after)",
      },
    },
    modificationPoints: [
      "New account types / posting kinds = new ledger_entries columns or new handler branch; keep the transaction atomic.",
    ],
    risks: [
      ["handlers.c", "insufficient funds must reject atomically (no partial postings)", "single transaction; smoke test 24 checks zero balance change"],
      ["handlers.c", "reversal of a txn with > MAX_POSTINGS (8) postings", "documented limit; return handler error"],
      ["db schema", "ledger_entries.txn_id is NOT unique by design: transfer + settlement are separate postings for one txn", "dbAssert must aggregate (SUM) per txn, not count rows"],
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
      ["settlement", "Settle (41) — moves funds through the ledger, charges the fee"],
      ["auth code", "AU-%07u, minted in handlers.c on approval"],
      ["forwarding", "forward.c — fire-and-forget with reconnect-on-next-send (250 ms .. 2 s backoff)"],
    ],
    messageNotes: {
      Authorize: {
        precondition: "payments row exists, status open",
        sideEffect: "on approve -> forwards CompletePayment to pay-orders:9101 (fire-and-forget; client sees only AuthResponse)",
      },
      Settle: {
        precondition: "status complete (payment authorized)",
        sideEffect: "forwards TransferFunds to ledger:9102 (amount - fee to RESERVE), then status -> settled",
      },
      AuthResponse: {
        precondition: "response to 40",
        sideEffect: "approved flag + auth_code; NOTE: a forwarded CompletePayment may still be in flight — assert payment status with a WaitTimer",
      },
      SettleAck: {
        precondition: "response to 41",
        sideEffect: "settled_cents + fee_cents",
      },
    },
    modificationPoints: [
      "New external-facing message = handler here + a forward target (if it drives another process) + a suite that asserts the DOWNSTREAM effect, not just this ack.",
    ],
    risks: [
      ["forward.c", "forward target down -> external client gets ErrorAck(5) only after the forward fails", "reconnect 250 ms -> 2 s; suites put a delay after forwards"],
      ["handlers.c", "Settle before CompletePayment must be rejected", "status check; suite assertion-failure-demo shows the failure mode"],
      ["forwarding order", "forwards are fire-and-forget: AuthResponse can arrive before CompletePayment is processed", "test suites use delayMs steps before downstream dbAsserts"],
    ],
    interactions: [
      "Forwards CompletePayment to pay-orders:9101 on approve; forwards TransferFunds to ledger:9102 on settle.",
    ],
  },
  {
    dir: "harness/src/runner",
    guide: "harness/runner.md",
    purpose:
      "The suite execution engine. Interprets suite JSON (send / dbAssert / delayMs steps) against a live backend cluster, streams step results as events, and persists run results. Used by the headless CLI, the Electron main process, and the MCP server — with no Electron imports.",
    vocabulary: [
      ["send step", 'send:{to,msg,fields} — encodes via the registry-driven codec'],
      ["expectAck", "partial match on the response fields (subset semantics)"],
      ["dbAssert", "single-row SELECT + partial expect on columns"],
      ["runner event", "step-start / step-result / suite-result, consumed by CLI+GUI+MCP"],
    ],
    messageNotes: {},
    modificationPoints: [
      "New step kind = new case in runStep() + schema in suites.ts + renderer row in SuitePage.",
    ],
    risks: [
      ["runner.ts", "matchAck subset semantics: extra ack fields are ignored", "intentional (keeps suites stable); pin new fields explicitly when they matter"],
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
      ["IPC channels", "suite:list / suite:read / suite:run / data:files / data:query / runner:event"],
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
      ["MCP_NO_KB", "env flag: start the server without the knowledge-base tools (A/B demo)"],
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
