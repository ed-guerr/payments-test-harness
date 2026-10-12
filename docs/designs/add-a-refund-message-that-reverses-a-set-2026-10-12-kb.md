# Design: add a refund message that reverses a settled payment and returns the funds

> generated 2026-10-12T22:19:21.069Z · designer (MCP_NO_KB=0) · PROPOSED — review before implementing

## Summary

Change request: "add a refund message that reverses a settled payment and returns the funds"

Grounded in 5 knowledge-base sections (cited below). Proposed shape: a new message `RefundMessage` plus the handler/forwarding changes it implies.

## Affected components

| component | why (KB evidence) |
|---|---|
| backend/auth_gateway.md | see cited sections below |
| backend/ledger.md | see cited sections below |
| backend/pay_orders.md | see cited sections below |
| backend/common.md | see cited sections below |

### KB evidence

- **knowledge/backend/auth_gateway.md :: Messages** (score 11)
  > | message | dir | precondition | side effect |
  > |---|---|---|---|
  > | `Authorize` (40) | in | payments row exists, status open | on approve -> forwards CompletePayment to pay-orders:9101 (fire-and-forget; client sees only AuthResponse) |

- **knowledge/backend/ledger.md :: Messages** (score 9)
  > | message | dir | precondition | side effect |
  > |---|---|---|---|
  > | `TransferFunds` (30) | in | both accounts exist; from balance >= amount | atomic: accounts updated + 2 ledger_entries rows + 1 ledger_txns row |

- **knowledge/backend/pay_orders.md :: Messages** (score 9)
  > | message | dir | precondition | side effect |
  > |---|---|---|---|
  > | `CreatePayment` (10) | in | account exists in accounts table | INSERT payments (status open); ledger TransferFunds acct->RESERVE is NOT done here (settlement moves funds) |

- **knowledge/backend/common.md :: Key functions** (score 4)
  > | function | defined at |
  > |---|---|
  > | `parse_port(const char *s, uint16_t *port)` | args.c:10 |

- **knowledge/backend/ledger.md :: Domain vocabulary** (score 4)
  > | business term | maps to |
  > |---|---|
  > | `balance` | accounts.balance_cents; updated only inside ledger transactions |

## Proposed messages

New X-macro list (format matches include/pay/messages.h):

PF_MSG_LIST(Name, T, F)
    F(T, field1, u32)
    F(T, field2, char[12])
    F(T, field3, u16)
PF_MSG_LIST_END

Catalog row (id is a proposal — pick the next free id in the owning process's range):

| process | RefundMessage | <next free id> | in | <sizeof> |

Current catalog:

| process | message | id | dir | size |
|---|---|---|---|---|
| pay-orders | CreatePayment | 10 | in | 27 |
| pay-orders | CancelPayment | 11 | in | 20 |
| pay-orders | CompletePayment | 12 | in | 4 |
| pay-orders | PaymentAck | 20 | out | 5 |
| pay-orders | ErrorAck | 255 | out | 27 |
| ledger | TransferFunds | 30 | in | 40 |
| ledger | ReverseTransfer | 31 | in | 4 |
| ledger | TransferAck | 32 | out | 9 |
| ledger | ErrorAck | 255 | out | 27 |
| auth-gateway | Authorize | 40 | in | 8 |
| auth-gateway | Settle | 41 | in | 6 |
| auth-gateway | AuthResponse | 42 | out | 21 |
| auth-gateway | SettleAck | 43 | out | 9 |
| auth-gateway | ErrorAck | 255 | out | 27 |

## Handler sketch

int handle_name(Server *srv, int client, const Envelope *env)
{
    Name msg;
    if (env->payload_len != sizeof(msg)) return 1; /* -> ErrorAck(4) */
    /* copy + validate */
    /* precondition checks against the database */
    /* side effects in one transaction */
    /* ack */
    return 0;
}

## Database changes

-- e.g. new column / table; keep the ledger double-entry invariant

-- (proposed — review):

-- ALTER TABLE payments ADD COLUMN ...;

## Risks

- knowledge/backend/auth_gateway.md :: Messages — check its Risks section before touching this area

- knowledge/backend/ledger.md :: Messages — check its Risks section before touching this area

- knowledge/backend/pay_orders.md :: Messages — check its Risks section before touching this area

## Inter-process impact

- If RefundMessage triggers another process, add a forward in src/auth_gateway/forward.c (reconnect-on-next-send) and assert the DOWNSTREAM effect in a suite, not just the local ack.

## Suggested test suites

{
  "name": "proposed-suite",
  "description": "proposed coverage for: add a refund message that reverses a settled payment and returns the funds",
  "steps": [
    {
      "id": "trigger",
      "send": {
        "to": "pay-orders",
        "msg": "CreatePayment",
        "fields": {
          "txn_id": 9901,
          "account": "ACCT-001",
          "amount_cents": 1000,
          "currency": "USD"
        }
      },
      "expectAck": {
        "status": 0
      }
    },
    {
      "id": "wait-forward",
      "delayMs": 500
    },
    {
      "id": "assert-downstream",
      "dbAssert": {
        "sql": "SELECT status FROM payments WHERE txn_id = ?",
        "params": [
          9901
        ],
        "expect": {
          "status": "open"
        }
      }
    }
  ]
}
