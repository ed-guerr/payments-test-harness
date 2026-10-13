# backend/src/ledger — Intern Guide

> written by Qwen3 (local, via pi coding agent) · generated 2026-10-13T02:33:17.401Z · kb-forge 0.2 · source sha256:f6e14d6d6f0b

## Purpose

Double-entry ledger. Serves :9102. Moves cents between accounts atomically: every TransferFunds updates both balances and records the debit/credit pair in ONE ledger_entries row (from_acct/to_acct/amount_cents, status 'applied'), all inside a single BEGIN IMMEDIATE ... COMMIT transaction (db_transfer, src/common/db.c:199).

## Files

| file | ~lines |
|---|---|
| handlers.c | 76 |
| handlers.h | 7 |
| main.c | 79 |

## Domain vocabulary

| business term | maps to |
|---|---|
| `balance` | accounts.balance_cents; updated only inside db_transfer / db_ledger_reverse transactions |
| `transfer` | TransferFunds (30) — debit `from`, credit `to` |
| `reverse` | ReverseTransfer (31) — reverses ALL applied entries of a txn in one transaction (status -> 'reversed', balances restored) |
| `postings` | ledger_entries rows (id, txn_id, from_acct, to_acct, amount_cents, status); one row per transfer, both legs in the same row |

## Messages

| message | dir | precondition | side effect |
|---|---|---|---|
| `TransferFunds` (30) | in | both accounts exist and are different (self-transfer -> status 3); from balance >= amount | atomic: both accounts updated + ONE ledger_entries row (status 'applied') in a single transaction; there is no ledger_txns table |
| `ReverseTransfer` (31) | in | txn has applied ledger_entries rows (up to MAX_POSTINGS 8; more than 8 is an error, db.c:257) | restores each applied entry's balances and marks the rows status='reversed' in one transaction; must flip exactly the selected rows or rolls back |
| `TransferAck` (32) | out | response to 30/31 | status (0 ok, 1 insufficient funds, 2 unknown account, 3 self-transfer, 4 no applied entry) + from_balance_after — the ack is 9 bytes; to_balance_after is NOT on the wire |
| `ErrorAck` (255) | out | — | — |

## Key functions

| function | defined at |
|---|---|
| `handle_transfer_funds(Server *srv, int client, const Envelope *env)` | handlers.c:9 |
| `handle_reverse_transfer(Server *srv, int client, const Envelope *env)` | handlers.c:47 |
| `dispatch(Server *srv, int client, const Envelope *env)` | main.c:26 |
| `main(int argc, char **argv)` | main.c:53 |

## Common modification points

- New account types / posting kinds = new ledger_entries columns or new handler branch; keep the transaction atomic.

## Risks

| area | risk | mitigation |
|---|---|---|
| handlers.c + db.c | insufficient funds must reject atomically (no partial postings) | single transaction; smoke test 24 checks zero balance change |
| db.c | reversal of a txn with > MAX_POSTINGS (8) entries silently truncates the cursor and returns an error | documented limit (db.c:257); return handler error |
| db schema | ledger_entries.txn_id is NOT unique by design: a payment txn accumulates a transfer entry and a settle entry | dbAssert must aggregate per txn (SUM/COUNT with care), not assume one row per txn for full payment lifecycles |

## Inter-process interactions

- pay-orders and auth-gateway send transfers here (auth-gateway on settle); only the ledger writes accounts/ledger tables.
