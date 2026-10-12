# Design: add a refund message that reverses a settled payment and returns the funds

> generated 2026-10-12T22:19:21.295Z · designer (MCP_NO_KB=1) · PROPOSED — review before implementing

## Summary

Change request: "add a refund message that reverses a settled payment and returns the funds"

Generated WITHOUT the knowledge base (A/B mode): context is the wire schema only. Expect fewer, less specific claims — compare against a KB-grounded run.

## Affected components

| component | why |

|---|---|

| backend (all three processes) | schema-only mode: exact component list requires the knowledge base (run without MCP_NO_KB) |

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

- (schema-only mode) — run with the knowledge base to get cited risks

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
