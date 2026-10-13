# backend/src/auth_gateway — Intern Guide

> generated 2026-10-13T01:38:34.533Z · kb-forge 0.2 · source sha256:08396fa2df73

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
| `settlement` | Settle (41) — moves funds through the ledger, charges the fee |
| `auth code` | AU-%07u, minted in handlers.c on approval |
| `forwarding` | forward.c — fire-and-forget with reconnect-on-next-send (250 ms .. 2 s backoff) |

## Messages

| message | dir | precondition | side effect |
|---|---|---|---|
| `Authorize` (40) | in | payments row exists, status open | on approve -> forwards CompletePayment to pay-orders:9101 (fire-and-forget; client sees only AuthResponse) |
| `Settle` (41) | in | status complete (payment authorized) | forwards TransferFunds to ledger:9102 (amount - fee to RESERVE), then status -> settled |
| `AuthResponse` (42) | out | response to 40 | approved flag + auth_code; NOTE: a forwarded CompletePayment may still be in flight — assert payment status with a WaitTimer |
| `SettleAck` (43) | out | response to 41 | settled_cents + fee_cents |
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
| forward.c | forward target down -> external client gets ErrorAck(5) only after the forward fails | reconnect 250 ms -> 2 s; suites put a delay after forwards |
| handlers.c | Settle before CompletePayment must be rejected | status check; suite assertion-failure-demo shows the failure mode |
| forwarding order | forwards are fire-and-forget: AuthResponse can arrive before CompletePayment is processed | test suites use delayMs steps before downstream dbAsserts |

## Inter-process interactions

- Forwards CompletePayment to pay-orders:9101 on approve; forwards TransferFunds to ledger:9102 on settle.
