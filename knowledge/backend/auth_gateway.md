# backend/src/auth_gateway — Intern Guide

> written by Qwen3 (local, via pi coding agent) · generated 2026-10-13T04:55:30.714Z · kb-forge 0.2 · source sha256:08396fa2df73

## Purpose

External boundary for authorization and settlement. Serves external clients on :9103 and forwards lifecycle messages to the other processes — the only process that talks to both pay-orders and the ledger.

## Files

| file | ~lines |
|---|---|
| forward.c | 126 |
| forward.h | 20 |
| handlers.c | 104 |
| handlers.h | 7 |
| main.c | 89 |

## Domain vocabulary

| business term | maps to |
|---|---|
| `authorization` | Authorize (40) — approval decision from the (simulated) external acquirer |
| `settlement` | Settle (41) — moves funds through the ledger; the fee is accepted but NOT modeled in the ledger |
| `auth code` | AU-%07u, minted in handlers.c on approval |
| `forwarding` | forward.c — fire-and-forget TCP; the response is never read; on failure the socket is closed and the NEXT send reconnects (no backoff timer) |

## Messages

| message | dir | precondition | side effect |
|---|---|---|---|
| `Authorize` (40) | in | payments row exists, status open (the row is read directly from the shared db) | on approve -> forwards CompletePayment to pay-orders:9101 (fire-and-forget; AuthResponse is sent whether or not the forward succeeded — a failed forward is only logged and retried on the next send) |
| `Settle` (41) | in | payments row exists and status = complete (settled -> ST_SETTLED; anything else -> ST_NOT_COMPLETE) | forwards TransferFunds to ledger:9102 with the FULL amount (to RESERVE; fee_cents is not subtracted — 'not modeled in ledger', handlers.c), then status -> settled; ack carries settled_cents = full amount |
| `AuthResponse` (42) | out | response to 40 | approved flag + auth_code; NOTE: a forwarded CompletePayment may still be in flight — assert payment status with a WaitTimer |
| `SettleAck` (43) | out | response to 41 | status (0 ok, 1 not complete, 2 already settled) + settled_cents (the full amount; fee_cents is NOT on the wire — the ack is 9 bytes) |
| `ErrorAck` (255) | out | — | — |

## Key functions

| function | defined at |
|---|---|
| `connect_to(uint16_t port)` | forward.c:30 |
| `write_all(int fd, const uint8_t *buf, size_t len)` | forward.c:51 |
| `fwd_init(uint16_t orders_port, uint16_t ledger_port)` | forward.c:68 |
| `fwd_send(int target, uint16_t msg_id, const void *payload, size_t len)` | forward.c:79 |
| `fwd_close(void)` | forward.c:115 |
| `handle_authorize(Server *srv, int client, const Envelope *env)` | handlers.c:13 |
| `handle_settle(Server *srv, int client, const Envelope *env)` | handlers.c:49 |
| `dispatch(Server *srv, int client, const Envelope *env)` | main.c:28 |
| `main(int argc, char **argv)` | main.c:55 |

## Common modification points

- New external-facing message = handler here + a forward target (if it drives another process) + a suite that asserts the DOWNSTREAM effect, not just this ack.

## Risks

| area | risk | mitigation |
|---|---|---|
| forward.c | forward target down -> Authorize STILL returns approved (forward failure is only logged, retried on next send); Settle returns ST_NOT_COMPLETE (the ack's initial value) even though the real cause is the failed forward | no backoff (fwd_send reconnects lazily); suites put a delay after forwards and assert the downstream db state |
| handlers.c | Settle before CompletePayment must be rejected | status check; suite assertion-failure-demo shows the failure mode |
| forwarding order | forwards are fire-and-forget: AuthResponse can arrive before CompletePayment is processed | test suites use delayMs steps before downstream dbAsserts |

## Inter-process interactions

- Forwards CompletePayment to pay-orders:9101 on approve; forwards TransferFunds to ledger:9102 on settle.

- Shares the same SQLite file as the other backends (harness spawns each with --db <file>), so it reads payments rows directly.
