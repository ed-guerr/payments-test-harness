# MCP server — tool reference

The harness ships a Model Context Protocol server (stdio transport) so an AI
agent can introspect the protocol, author suites, run them, and inspect the
database. This is the "agent-authored tests" feature: the agent reads the
registry and the knowledge base, writes suite JSON, and executes it.

Start it:

```bash
cd harness
npm run mcp            # speaks MCP over stdio
```

Point any MCP client (Claude, Cursor, pi, …) at `npm run mcp`. Set
`MCP_NO_KB=1` to start it **without** the knowledge-base tools — the A/B
demo that shows how much the guides are worth.

Verified end-to-end by `npm run test:mcp` (a stdio client that exercises the
full author→run→inspect loop, in both KB modes).

## Tool list

| Tool | Purpose |
|---|---|
| `list_processes` | the three processes + listen addresses |
| `list_messages` | ids/directions/sizes for a process |
| `get_message_schema` | full field layout + KB notes (precondition/side-effect) |
| `list_suites` / `get_suite` | read suites |
| `create_suite` / `update_suite` / `delete_suite` | author suites (registry-validated; failures carry `kbHints`) |
| `run_suite` / `run_all_suites` | execute against a fresh backend cluster |
| `get_run_results` | latest persisted run |
| `db_schema` / `db_query` | read-only SQL over per-suite databases |
| `kb_search` / `kb_read` | knowledge-base retrieval (absent when `MCP_NO_KB=1`) |

## Example: author a test that verifies a real side effect

A schema-only agent stops at "the ack said ok". A KB-grounded agent reads the
auth-gateway guide — *"on approve → forwards `CompletePayment`"* — and asserts
the **downstream** state.

**1. Introspect the message** (the registry, not a hand-written doc):

```json
{ "tool": "get_message_schema", "args": { "process": "pay-orders", "message": "CreatePayment" } }
```
```json
{
  "id": 10, "name": "CreatePayment", "direction": "in", "size": 27,
  "fields": [
    { "name": "txn_id", "type": "uint32_t", "size": 4, "offset": 0 },
    { "name": "account", "type": "char[16]", "size": 16, "offset": 4 },
    { "name": "amount_cents", "type": "uint32_t", "size": 4, "offset": 20 },
    { "name": "currency", "type": "char[3]", "size": 3, "offset": 24 }
  ],
  "notes": "account exists in accounts table · INSERT payments (status open)"
}
```

**2. Ground the behavior in the KB** (this is the step a schema-only agent skips):

```json
{ "tool": "kb_search", "args": { "query": "authorization completes payment downstream" } }
```
```json
[
  { "path": "knowledge/backend/auth_gateway.md", "section": "Risks", "score": 4 },
  { "path": "knowledge/backend/pay_orders.md", "section": "Messages", "score": 9 }
]
```

**3. Author the suite** (validated before it touches disk):

```json
{
  "tool": "create_suite",
  "args": {
    "name": "authorize-completes-payment",
    "description": "external authorization drives the payment to complete via the gateway forward",
    "steps": [
      { "id": "create", "send": { "to": "pay-orders", "msg": "CreatePayment",
          "fields": { "txn_id": 7777, "account": "ACCT-001", "amount_cents": 9999, "currency": "USD" } },
        "expectAck": { "status": 0 } },
      { "id": "authorize", "send": { "to": "auth-gateway", "msg": "Authorize",
          "fields": { "txn_id": 7777, "amount_cents": 9999 } },
        "expectAck": { "approved": 1 } },
      { "id": "wait-forward", "delayMs": 400 },
      { "id": "assert-downstream", "dbAssert": {
          "sql": "SELECT status FROM payments WHERE txn_id = ?",
          "params": [7777],
          "expect": { "status": "complete" } } }
    ]
  }
}
```

**4. Run it** (fresh backend cluster + fresh database per run):

```json
{ "tool": "run_suite", "args": { "name": "authorize-completes-payment" } }
```
```json
{ "suite": "authorize-completes-payment", "ok": true, "passed": 4, "failed": 0, "durationMs": 700 }
```

## Example: inspect the result

```json
{ "tool": "db_query", "args": { "file": "authorize-completes-payment.db",
  "sql": "SELECT status, account FROM payments WHERE txn_id = 7777" } }
```
```json
[ { "status": "complete", "account": "ACCT-001" } ]
```

## Notes

- **Read-only DB.** `db_query` opens the file readonly and only accepts
  `SELECT`/`WITH`. Suites get a fresh DB per run, so there's nothing to lock.
- **Suite protection.** `delete_suite` refuses to remove the four shipped
  sample suites.
- **Validation = registry + KB.** A `create_suite` failure names the bad
  message/field and attaches the top `kb_search` hits for it (`kbHints`), so
  the agent recovers by reading the guide.
- **No Electron.** The MCP server runs under plain Node (`tsx`) and reuses the
  same runner/codec the GUI uses — no app process involved.
