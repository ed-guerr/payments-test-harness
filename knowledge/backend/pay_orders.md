# backend/src/pay_orders — Intern Guide

> generated 2026-10-12T22:22:44.516Z · kb-forge 0.1 · source sha256:c029293ed970

## Purpose

Payment lifecycle owner. Serves :9101. Creates, cancels, and completes payment rows; owns the payments table and coordinates with the ledger (funds movement) and the auth gateway (completion trigger).

## Files

| file | ~lines |
|---|---|
| handlers.c | 84 |
| handlers.h | 8 |
| main.c | 80 |

## Domain vocabulary

| business term | maps to |
|---|---|
| `payment` | row in payments table; status: open -> complete \| open -> cancelled |
| `create payment` | CreatePayment (10) -> PaymentAck (20) |
| `cancel payment` | CancelPayment (11); allowed only while status = open |
| `complete payment` | CompletePayment (12); forwarded here by auth-gateway after approval |

## Messages

| message | dir | precondition | side effect |
|---|---|---|---|
| `CreatePayment` (10) | in | account exists in accounts table | INSERT payments (status open); ledger TransferFunds acct->RESERVE is NOT done here (settlement moves funds) |
| `CancelPayment` (11) | in | payments row exists and status = open | status -> cancelled |
| `CompletePayment` (12) | in | payments row exists and status = open | status -> complete; this is what auth-gateway forwards after a successful Authorize |
| `PaymentAck` (20) | out | response to 10/11/12 | none (status 0 = ok, 1 = rejected) |
| `ErrorAck` (255) | out | — | — |

## Key functions

| function | defined at |
|---|---|
| `handle_create_payment(Server *srv, int client, const Envelope *env)` | handlers.c:9 |
| `handle_cancel_payment(Server *srv, int client, const Envelope *env)` | handlers.c:45 |
| `handle_complete_payment(Server *srv, int client, const Envelope *env)` | handlers.c:65 |
| `dispatch(Server *srv, int client, const Envelope *env)` | main.c:27 |
| `main(int argc, char **argv)` | main.c:54 |

## Common modification points

- New lifecycle state = new status value + handler branch + a suite that drives the transition.

## Risks

| area | risk | mitigation |
|---|---|---|
| handlers.c | status transitions are enforced only in handlers, not by DB constraints | dbAssert steps in suites pin the expected status after each transition |
| main.c | listens on 9101; auth-gateway hard-codes this port for forwarding | keep ports stable or update forward.c |

## Inter-process interactions

- auth-gateway forwards CompletePayment here on :9101 after approving an Authorize.
