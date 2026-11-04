-- payments-test-harness schema + seed data (single source of truth).
-- All monetary values are integer cents.

PRAGMA journal_mode=WAL;

CREATE TABLE accounts (
    acct            TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    balance_cents   INTEGER NOT NULL
                    CONSTRAINT acct_balance_nonneg CHECK (balance_cents >= 0)
);

CREATE TABLE payments (
    txn_id          INTEGER PRIMARY KEY,
    account         TEXT NOT NULL REFERENCES accounts(acct),
    amount_cents    INTEGER NOT NULL,
    currency        TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open', 'complete', 'cancelled', 'settled'))
);

CREATE TABLE ledger_entries (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    txn_id          INTEGER NOT NULL,
    from_acct       TEXT NOT NULL,
    to_acct         TEXT NOT NULL,
    amount_cents    INTEGER NOT NULL,
    status          TEXT NOT NULL DEFAULT 'applied'
                    CHECK (status IN ('applied', 'reversed'))
);

-- A payment txn produces several postings (the transfer, the settlement),
-- so txn_id is indexed but not unique.
CREATE INDEX idx_ledger_txn ON ledger_entries (txn_id);

INSERT INTO accounts (acct, name, balance_cents) VALUES
    ('ACCT-001', 'Acme Corp', 500000),
    ('ACCT-002', 'Globex Inc', 250000),
    ('RESERVE',  'Reserve Fund', 1000000);
