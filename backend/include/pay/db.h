#pragma once

#include <stdint.h>

/*
 * Process-wide SQLite singleton (owned by db.c; one handle per process).
 * WAL mode, busy_timeout 5s. The database file must already contain the
 * schema from backend/db/schema.sql — db_open() verifies this.
 */

/*
 * Open (creating the file if missing).
 * Returns 0 on success, -1 on open/pragma error, -2 if the schema is absent.
 */
int db_open(const char *path);

void db_close(void);

/* --- accounts --- */
int db_account_exists(const char *acct); /* 0 yes, -1 no, -2 db error */
int db_balance(const char *acct, int32_t *balance);

/* --- payments (pay-orders is the writer of record) --- */
/* 0 ok, -1 duplicate txn, -2 db error */
int db_payment_insert(int txn_id, const char *account, uint32_t amount_cents, const char *currency);

/* 0 found, -1 not found, -2 db error */
int db_payment_get(int txn_id, char *account /* 16 */, uint32_t *amount_cents,
                   char *status /* 16 */);

/* 0 updated, -1 row not in from_status, -2 db error */
int db_payment_set_status(int txn_id, const char *from_status, const char *to_status);

/* --- ledger --- */
/*
 * Atomic debit/credit + ledger_entries insert (keyed by txn_id).
 * Returns 0 ok, -1 insufficient funds, -2 account missing, -3 self-transfer,
 * -4 db error. *from_after receives the from-account balance after the move.
 */
int db_transfer(int txn_id, const char *from_acct, const char *to_acct, uint32_t amount_cents,
                int32_t *from_after);

/*
 * Reverse all applied postings for a txn: each entry credits its from
 * account, debits its to account, and is marked reversed.
 * Returns 0 ok, -1 no applied entry for txn, -2 db error.
 * *from_after receives the balance of the first entry's from account after
 * the reversal.
 */
int db_ledger_reverse(int txn_id, int32_t *from_after);
