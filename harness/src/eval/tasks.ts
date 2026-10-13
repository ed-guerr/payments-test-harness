/**
 * eval/tasks.ts — the fixed task set with exact ground truth.
 *
 * Ground truth is derived from the backend's seed data
 * (ACCT-001 500000, ACCT-002 250000, RESERVE 1000000 cents) and the handler
 * semantics in the backend handlers — every number here is verified
 * against committed suites where one covers the same behavior.
 *
 * Each task names the suite the agent must produce (`eval-<id>`), which
 * keeps runs isolated and the cleanup deterministic.
 *
 * The smoke set (see cli.ts) always includes a KB-sensitive task so the A/B
 * is meaningful even in a short run. Tasks flagged kbSensitive are the
 * ones whose ground truth is only derivable from the intern guides (or by
 * lucky domain guessing), not from the wire schemas alone.
 */
import type { EvalTask } from "./types";

export const TASKS: EvalTask[] = [
  {
    id: "happy-path",
    prompt:
      "Make a test for the full lifecycle of a payment: create a 50000-cent payment on ACCT-001 (USD), get it externally authorized, settle it, and verify the payment's final status and that the money landed in the RESERVE account.",
    suiteName: "eval-happy-path",
    checks: [
      { kind: "usesMessage", name: "CreatePayment" },
      { kind: "usesMessage", name: "Authorize" },
      { kind: "usesMessage", name: "Settle" },
      { kind: "expectsAckField", message: "Settle", field: "status", value: 0 },
      { kind: "assertsRow", table: "payments", expect: { status: "settled" } },
      { kind: "assertsRow", table: "accounts", expect: { balance_cents: 1050000 } },
    ],
  },
  {
    id: "double-settle-rejection",
    prompt:
      "Verify that a payment can only be settled once: set up and settle a 50000-cent payment on ACCT-001, attempt a second settlement, and assert that the second one is rejected and that no extra money moved into the RESERVE account.",
    suiteName: "eval-double-settle-rejection",
    checks: [
      { kind: "usesMessage", name: "Settle", minCount: 2 },
      { kind: "expectsAckField", message: "Settle", field: "status", value: 2 },
      { kind: "assertsRow", table: "accounts", expect: { balance_cents: 1050000 } },
      { kind: "assertsRow", table: "payments", expect: { status: "settled" } },
    ],
  },
  {
    id: "insufficient-funds",
    prompt:
      "Create a payment on ACCT-002 for more than its balance, then try to move that amount from ACCT-002 via the ledger. Assert that the ledger rejects the transfer and that nothing moved.",
    suiteName: "eval-insufficient-funds",
    checks: [
      { kind: "usesMessage", name: "CreatePayment" },
      { kind: "usesMessage", name: "TransferFunds" },
      { kind: "expectsAckField", message: "TransferFunds", field: "status", value: 1 },
      { kind: "assertsRow", table: "accounts", expect: { balance_cents: 250000 } },
    ],
  },
  {
    id: "cancel-payment",
    prompt:
      "Create a 1000-cent payment on ACCT-002, cancel it, then try to authorize it. Assert that the payment is cancelled, that no money moved, and that the authorization is refused.",
    suiteName: "eval-cancel-payment",
    checks: [
      { kind: "usesMessage", name: "CreatePayment" },
      { kind: "usesMessage", name: "CancelPayment" },
      { kind: "usesMessage", name: "Authorize" },
      { kind: "expectsAckField", message: "Authorize", field: "approved", value: 0 },
      { kind: "assertsRow", table: "payments", expect: { status: "cancelled" } },
      { kind: "assertsRow", table: "accounts", expect: { balance_cents: 250000 } },
    ],
  },
  {
    id: "reversal-chain",
    prompt:
      "Test that ledger reversals are per-transaction and work out of order: transfer 10000 from ACCT-001 to ACCT-002 (txn 9001), 5000 from ACCT-002 to ACCT-001 (txn 9002), and 3000 from ACCT-001 to ACCT-002 (txn 9003). Then reverse txn 9001 and txn 9003 — but not 9002. Assert the final balances: ACCT-001 505000, ACCT-002 245000.",
    suiteName: "eval-reversal-chain",
    checks: [
      { kind: "usesMessage", name: "TransferFunds", minCount: 3 },
      { kind: "usesMessage", name: "ReverseTransfer", minCount: 2 },
      { kind: "assertsRow", table: "accounts", expect: { balance_cents: 505000 } },
      { kind: "assertsRow", table: "accounts", expect: { balance_cents: 245000 } },
    ],
  },
  {
    id: "chaos-kill-ledger",
    prompt:
      "Chaos test: transfer 2500 cents from ACCT-001 to ACCT-002 (txn 9101) and verify it applied. Then SIGKILL the ledger process. Then attempt another ledger transfer and assert it fails, create a payment on pay-orders and assert it still succeeds, and assert the balances are exactly the post-first-transfer values (ACCT-001 497500, ACCT-002 252500).",
    suiteName: "eval-chaos-kill-ledger",
    checks: [
      { kind: "usesMessage", name: "TransferFunds", minCount: 2 },
      { kind: "killsProcess", proc: "ledger" },
      { kind: "hasExpectError", message: "TransferFunds" },
      { kind: "usesMessage", name: "CreatePayment" },
      { kind: "assertsRow", table: "accounts", expect: { balance_cents: 497500 } },
      { kind: "assertsRow", table: "accounts", expect: { balance_cents: 252500 } },
    ],
  },
  {
    id: "gateway-forward-completes",
    kbSensitive: true,
    prompt:
      "Make a test that verifies an external authorization completes a payment.",
    suiteName: "eval-gateway-forward-completes",
    checks: [
      { kind: "usesMessage", name: "CreatePayment" },
      { kind: "usesMessage", name: "Authorize" },
      { kind: "assertsRow", table: "payments", expect: { status: "complete" } },
    ],
  },
  {
    id: "settle-moves-money",
    kbSensitive: true,
    prompt:
      "Make a test that verifies settlement of a 50000-cent payment on ACCT-001: set the payment up so it is settleable, settle it, and verify the settlement actually moved the money where it goes.",
    suiteName: "eval-settle-moves-money",
    checks: [
      { kind: "usesMessage", name: "Settle" },
      { kind: "assertsRow", table: "payments", expect: { status: "settled" } },
      { kind: "assertsRow", table: "accounts", expect: { balance_cents: 1050000 } },
    ],
  },
  {
    id: "settle-then-reverse",
    prompt:
      "Settle a payment, then reverse its settlement: create a 50000-cent payment on ACCT-001, authorize it, settle it, then reverse the settlement transfer on the ledger. Assert the RESERVE account is back to its seed balance (1000000) and ACCT-001 is back to 500000.",
    suiteName: "eval-settle-then-reverse",
    checks: [
      { kind: "usesMessage", name: "Settle" },
      { kind: "usesMessage", name: "ReverseTransfer" },
      { kind: "assertsRow", table: "accounts", expect: { balance_cents: 1000000 } },
      { kind: "assertsRow", table: "accounts", expect: { balance_cents: 500000 } },
    ],
  },
  {
    id: "unknown-account",
    prompt:
      "Verify that creating a payment for an account that does not exist (e.g. ACCT-999) is rejected with the account-not-found status, and that no payment row is created for it.",
    suiteName: "eval-unknown-account",
    checks: [
      { kind: "usesMessage", name: "CreatePayment" },
      { kind: "expectsAckField", message: "CreatePayment", field: "status", value: 1 },
      { kind: "assertsRow", table: "payments", expect: { n: 0 } },
    ],
  },
  {
    id: "interleaved-payments",
    prompt:
      "Two interleaved payments: create a 20000-cent payment on ACCT-001 (txn 9201) and a 10000-cent payment on ACCT-002 (txn 9202). Authorize and settle both. Assert that both payments end settled and that the RESERVE account received both amounts (final balance 1030000).",
    suiteName: "eval-interleaved-payments",
    checks: [
      { kind: "usesMessage", name: "CreatePayment", minCount: 2 },
      { kind: "usesMessage", name: "Settle", minCount: 2 },
      { kind: "assertsRow", table: "accounts", expect: { balance_cents: 1030000 } },
      { kind: "assertsRow", table: "payments", expect: { status: "settled" } },
    ],
  },
];

/** The short run: first two plain tasks + the KB-sensitive discriminator. */
export const SMOKE_TASK_IDS = ["happy-path", "double-settle-rejection", "gateway-forward-completes"];

export function taskById(id: string): EvalTask {
  const t = TASKS.find((x) => x.id === id);
  if (!t) throw new Error(`unknown task ${id} (known: ${TASKS.map((x) => x.id).join(", ")})`);
  return t;
}
