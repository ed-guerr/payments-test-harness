# backend/src/common — Intern Guide

> written by Qwen3 (local, via pi coding agent) · generated 2026-10-13T07:27:28.326Z · kb-forge 0.2 · source sha256:103595b2628d

## Purpose

Shared plumbing for all three backend processes: the wire codec (fixed 8-byte little-endian envelope), the TCP listener with a function-pointer dispatch table, the introspection emitter that powers the registry, SQLite helpers, logging, and argument parsing.

## Files

| file | ~lines |
|---|---|
| args.c | 82 |
| db.c | 334 |
| envelope.c | 53 |
| introspect.c | 85 |
| log.c | 34 |
| messages.c | 39 |
| socket.c | 286 |

## Domain vocabulary

| business term | maps to |
|---|---|
| `envelope` | Envelope in include/pay/envelope.h — 8-byte header: u16 magic 0x5046 + u16 msg_id + u32 payload_len (<= PF_MAX_PAYLOAD 2048) |
| `dispatch table` | Handlers[] in src/common/messages.c — msg_id -> function pointer |
| `message table` | the PF_MSG_LIST X-macro lists in include/pay/messages.h |
| `registry` | output of --introspect (src/common/introspect.c); consumed by the harness |
| `drain client` | drain_client() in src/common/socket.c:114 — returns 0 = keep the connection open; non-zero closes it (server_run, socket.c:247) |
| `ack status codes` | include/pay/ack.h — ACK_* (payment), TR_* (transfer), ST_* (settle), ERR_* (ErrorAck codes 1-5) |

## Key functions

| function | defined at |
|---|---|
| `parse_port(const char *s, uint16_t *port)` | args.c:10 |
| `args_parse(int argc, char **argv, uint16_t port_default, Args *args)` | args.c:22 |
| `db_exec(const char *sql)` | db.c:13 |
| `db_open(const char *path)` | db.c:25 |
| `db_close(void)` | db.c:62 |
| `db_account_exists(const char *acct)` | db.c:71 |
| `db_balance(const char *acct, int32_t *balance)` | db.c:89 |
| `db_update_balance(const char *acct, int32_t delta_cents)` | db.c:109 |
| `db_payment_insert(int txn_id, const char *account, uint32_t amount_cents, const char *currency)` | db.c:128 |
| `db_payment_get(int txn_id, char *account, uint32_t *amount_cents, char *status)` | db.c:156 |
| `db_payment_set_status(int txn_id, const char *from_status, const char *to_status)` | db.c:179 |
| `db_ledger_reverse(int txn_id, int32_t *from_after)` | db.c:254 |
| `env_decode(const uint8_t *buf, size_t len, Envelope *env, size_t *consumed)` | envelope.c:28 |
| `json_write_string(const char *s)` | introspect.c:6 |
| `introspect_print(const char *process, uint16_t port, const MessageDef *table, size_t n_msgs)` | introspect.c:39 |
| `log_init(const char *name)` | log.c:9 |
| `log_msg(const char *fmt, ...)` | log.c:14 |
| `set_nonblocking(int fd)` | socket.c:25 |
| `find_client_by_fd(Server *srv, int fd)` | socket.c:33 |
| `find_free_slot(Server *srv)` | socket.c:43 |
| `close_client(Server *srv, int idx)` | socket.c:53 |
| `accept_clients(Server *srv, const char *proc_name)` | socket.c:64 |
| `write_all(int fd, const uint8_t *buf, size_t len)` | socket.c:93 |
| `drain_client(Server *srv, int idx, msg_handler_t dispatch, const char *proc_name)` | socket.c:114 |
| `server_bind(Server *srv, uint16_t port)` | socket.c:160 |
| `server_run(Server *srv, msg_handler_t dispatch, const char *proc_name)` | socket.c:203 |
| `server_send(Server *srv, int client, uint16_t msg_id, const void *payload, size_t len)` | socket.c:257 |
| `server_send_error(Server *srv, int client, uint16_t msg_id, uint8_t code, const char *detail)` | socket.c:275 |

## Common modification points

- Adding a message: add its field list to include/pay/messages.h (X-macro), add the id to include/pay/msg_ids.h, add a table row in the owning process's handlers.c, add a handler function.

- Changing a field changes every packed offset — regenerate the harness registry (npm run gen:registry) and re-run suites.

## Risks

| area | risk | mitigation |
|---|---|---|
| socket.c | close condition: drain_client returns 0 = keep open, non-zero = close; server_run closes only on != 0 | regression closes clients after every successful response; smoke test 18/19 catches it |
| envelope.c | oversized frames (payload_len > PF_MAX_PAYLOAD 2048) and size mismatches | validated in decode; ErrorAck codes 3 (ERR_OVERSIZED) / 4 (ERR_SIZE_MISMATCH) |
| introspect.c | registry drift: C structs change, registry not regenerated | npm run gen:registry + suites validate against it |
| db.c | all three processes open the SAME SQLite file (each is spawned with --db <file>; WAL mode), so a crash mid-transaction can leave a shared db in a bad state | all writes run inside explicit BEGIN IMMEDIATE ... COMMIT transactions (see db.c) |

## Inter-process interactions

- Every process links this directory; handlers are pure (srv, client, envelope) functions reached only through the dispatch table.

- The shared database file is the real cross-process bus: any process can read any table (auth-gateway reads payments rows directly without asking pay-orders).
