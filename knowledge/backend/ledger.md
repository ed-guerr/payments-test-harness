# backend/src/ledger — Intern Guide

> generated 2026-10-13T01:38:34.533Z · kb-forge 0.2 · source sha256:f6e14d6d6f0b

## Purpose

Double-entry ledger. Serves :9102. Moves cents between accounts atomically: every TransferFunds writes a balanced pair of postings (debit/credit) plus an audit row in one SQLite transaction.

## Files

| file | ~lines |
|---|---|
| handlers.c | 76 |
| handlers.h | 7 |
| main.c | 79 |

## Domain vocabulary

| business term | maps to |
|---|---|
| `balance` | accounts.balance_cents; updated only inside ledger transactions |
| `transfer` | TransferFunds (30) — debit `from`, credit `to` |
| `reverse` | ReverseTransfer (31) — reverses ALL applied postings of a txn in one transaction |
| `postings` | ledger_entries rows (txn_id, account, delta_cents) |

## Messages

| message | dir | precondition | side effect |
|---|---|---|---|
| `TransferFunds` (30) | in | both accounts exist; from balance >= amount | atomic: accounts updated + 2 ledger_entries rows + 1 ledger_txns row |
| `ReverseTransfer` (31) | in | txn has applied postings | reverses every applied posting for the txn (up to 8); balances restored |
| `TransferAck` (32) | out | response to 30/31 | carries resulting balances (from_balance_after, to_balance_after) |
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
| handlers.c | insufficient funds must reject atomically (no partial postings) | single transaction; smoke test 24 checks zero balance change |
| handlers.c | reversal of a txn with > MAX_POSTINGS (8) postings | documented limit; return handler error |
| db schema | ledger_entries.txn_id is NOT unique by design: transfer + settlement are separate postings for one txn | dbAssert must aggregate (SUM) per txn, not count rows |

## Inter-process interactions

- pay-orders and auth-gateway send transfers here (auth-gateway on settle); only the ledger writes accounts/ledger tables.
