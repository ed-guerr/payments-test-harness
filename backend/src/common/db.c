#define _POSIX_C_SOURCE 200809L

#include <stdio.h>
#include <string.h>

#include <sqlite3.h>

#include "pay/db.h"
#include "pay/faults.h"
#include "pay/log.h"

static sqlite3 *db = NULL; /* process-wide singleton, owned by this file */

static int db_exec(const char *sql)
{
    char *err = NULL;
    if (sqlite3_exec(db, sql, NULL, NULL, &err) != SQLITE_OK)
    {
        log_msg("sql failed (%s): %s", sql, err ? err : "?");
        sqlite3_free(err);
        return -1;
    }
    return 0;
}

int db_open(const char *path)
{
    if (sqlite3_open(path, &db) != SQLITE_OK)
    {
        log_msg("open %s failed: %s", path, sqlite3_errmsg(db));
        sqlite3_close(db);
        db = NULL;
        return -1;
    }

    if (db_exec("PRAGMA journal_mode=WAL;") != 0)
        return -1;

    /* Verify the schema is present; the file may have been created empty. */
    int n = 0;
    sqlite3_stmt *st = NULL;
    if (sqlite3_prepare_v2(
            db, "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='accounts'", -1,
            &st, NULL) == SQLITE_OK)
    {
        if (sqlite3_step(st) == SQLITE_ROW)
            n = sqlite3_column_int(st, 0);
        sqlite3_finalize(st);
    }

    if (n == 0)
    {
        log_msg("database %s has no schema; initialize it from db/schema.sql", path);
        sqlite3_close(db);
        db = NULL;
        return -2;
    }

    sqlite3_busy_timeout(db, 5000);
    return 0;
}

void db_close(void)
{
    if (db != NULL)
    {
        sqlite3_close(db);
        db = NULL;
    }
}

int db_account_exists(const char *acct)
{
    sqlite3_stmt *st = NULL;
    int found = 0;
    int ok = 0;

    if (sqlite3_prepare_v2(db, "SELECT 1 FROM accounts WHERE acct = ?", -1, &st, NULL) == SQLITE_OK)
    {
        sqlite3_bind_text(st, 1, acct, -1, SQLITE_STATIC);
        if (sqlite3_step(st) == SQLITE_ROW)
            found = 1;
        sqlite3_finalize(st);
        ok = 1;
    }

    return !ok ? -2 : (found ? 0 : -1);
}

int db_balance(const char *acct, int32_t *balance)
{
    sqlite3_stmt *st = NULL;
    int ok = 0;

    if (sqlite3_prepare_v2(db, "SELECT balance_cents FROM accounts WHERE acct = ?", -1, &st,
                           NULL) == SQLITE_OK)
    {
        sqlite3_bind_text(st, 1, acct, -1, SQLITE_STATIC);
        if (sqlite3_step(st) == SQLITE_ROW)
        {
            *balance = (int32_t)sqlite3_column_int64(st, 0);
            ok = 1;
        }
        sqlite3_finalize(st);
    }

    return ok ? 0 : -1;
}

static int db_update_balance(const char *acct, int32_t delta_cents)
{
    sqlite3_stmt *st = NULL;
    int ok = 0;

    if (sqlite3_prepare_v2(db,
                           "UPDATE accounts SET balance_cents = balance_cents + ? WHERE acct = ?",
                           -1, &st, NULL) == SQLITE_OK)
    {
        sqlite3_bind_int64(st, 1, delta_cents);
        sqlite3_bind_text(st, 2, acct, -1, SQLITE_STATIC);
        if (sqlite3_step(st) == SQLITE_DONE)
            ok = sqlite3_changes(db) == 1;
        sqlite3_finalize(st);
    }

    return ok ? 0 : -1;
}

int db_payment_insert(int txn_id, const char *account, uint32_t amount_cents, const char *currency)
{
    sqlite3_stmt *st = NULL;
    int rc = -2;

    if (sqlite3_prepare_v2(
            db,
            "INSERT INTO payments (txn_id, account, amount_cents, currency) VALUES (?, ?, ?, ?)",
            -1, &st, NULL) == SQLITE_OK)
    {
        sqlite3_bind_int64(st, 1, txn_id);
        sqlite3_bind_text(st, 2, account, -1, SQLITE_STATIC);
        sqlite3_bind_int64(st, 3, (int64_t)amount_cents);
        sqlite3_bind_text(st, 4, currency, -1, SQLITE_STATIC);

        int step = sqlite3_step(st);
        if (step == SQLITE_DONE)
            rc = 0;
        else if (sqlite3_errcode(db) == SQLITE_CONSTRAINT)
            rc = -1; /* duplicate txn_id */
        else
            log_msg("insert payment %d failed: %s", txn_id, sqlite3_errmsg(db));
        sqlite3_finalize(st);
    }

    return rc;
}

int db_payment_get(int txn_id, char *account, uint32_t *amount_cents, char *status)
{
    sqlite3_stmt *st = NULL;
    int ok = 0;

    if (sqlite3_prepare_v2(db,
                           "SELECT account, amount_cents, status FROM payments WHERE txn_id = ?",
                           -1, &st, NULL) == SQLITE_OK)
    {
        sqlite3_bind_int64(st, 1, txn_id);
        if (sqlite3_step(st) == SQLITE_ROW)
        {
            /* Bounded copies: sqlite3_column_text returns a NUL-terminated
             * string (strlen+1 bytes), not a 16-byte field — the raw
             * 16-byte memcpy read past the NUL. NULL means the column is
             * SQL NULL; the schema forbids it, treat it as not found.
             */
            const unsigned char *acct = sqlite3_column_text(st, 0);
            const unsigned char *stat = sqlite3_column_text(st, 2);
            if (acct != NULL && stat != NULL)
            {
                snprintf(account, 16, "%s", (const char *)acct);
                snprintf(status, 16, "%s", (const char *)stat);
                *amount_cents = (uint32_t)sqlite3_column_int64(st, 1);
                ok = 1;
            }
        }
        sqlite3_finalize(st);
    }

    return ok ? 0 : -1;
}

int db_payment_set_status(int txn_id, const char *from_status, const char *to_status)
{
    sqlite3_stmt *st = NULL;
    int rc = -2;

    if (sqlite3_prepare_v2(db, "UPDATE payments SET status = ? WHERE txn_id = ? AND status = ?", -1,
                           &st, NULL) == SQLITE_OK)
    {
        sqlite3_bind_text(st, 1, to_status, -1, SQLITE_STATIC);
        sqlite3_bind_int64(st, 2, txn_id);
        sqlite3_bind_text(st, 3, from_status, -1, SQLITE_STATIC);

        if (sqlite3_step(st) == SQLITE_DONE)
            rc = sqlite3_changes(db) == 1 ? 0 : -1;
        sqlite3_finalize(st);
    }

    return rc;
}

int db_transfer(int txn_id, const char *from_acct, const char *to_acct, uint32_t amount_cents,
                int32_t *from_after)
{
    if (strcmp(from_acct, to_acct) == 0)
        return -3;

    /* Existence is checked outside the transaction; sufficiency is decided
     * by the conditional debit below, so the check and the mutation are one
     * atomic statement and no writer can land between them.
     */
    if (db_account_exists(from_acct) != 0 || db_account_exists(to_acct) != 0)
        return -2;

    if (db_exec("BEGIN IMMEDIATE") != 0)
        return -4;

    /* Fault: debit with no sufficiency guard — the pre-fix check-then-act
     * state, in which an over-balance transfer is accepted. The fix's
     * non-negative backstop clamps the debit, so the fault manifests as an
     * accepted transfer with the balance zeroed (money created), not the
     * full overdraft the pre-fix code produced. Deterministic approximation;
     * the report says so.
     */
    const char *debit_sql =
        fault_active("skip_balance_check")
            ? "UPDATE accounts SET balance_cents = CASE WHEN balance_cents >= ?1 "
              "THEN balance_cents - ?1 ELSE 0 END WHERE acct = ?2"
            : "UPDATE accounts SET balance_cents = balance_cents - ?1 "
              "WHERE acct = ?2 AND balance_cents >= ?1";

    sqlite3_stmt *st = NULL;
    int debited = 0;
    if (sqlite3_prepare_v2(db, debit_sql, -1, &st, NULL) == SQLITE_OK)
    {
        sqlite3_bind_int64(st, 1, (int64_t)amount_cents);
        sqlite3_bind_text(st, 2, from_acct, -1, SQLITE_STATIC);
        if (sqlite3_step(st) == SQLITE_DONE)
            debited = sqlite3_changes(db) == 1;
        sqlite3_finalize(st);
    }

    if (!debited)
    {
        db_exec("ROLLBACK");
        return -1; /* conditional update matched no row: insufficient funds */
    }

    if (db_update_balance(to_acct, (int32_t)amount_cents) != 0)
    {
        db_exec("ROLLBACK");
        return -4;
    }

    int rc = -4;
    if (sqlite3_prepare_v2(
            db,
            "INSERT INTO ledger_entries (txn_id, from_acct, to_acct, amount_cents, status) "
            "VALUES (?, ?, ?, ?, 'applied')",
            -1, &st, NULL) == SQLITE_OK)
    {
        sqlite3_bind_int64(st, 1, txn_id);
        sqlite3_bind_text(st, 2, from_acct, -1, SQLITE_STATIC);
        sqlite3_bind_text(st, 3, to_acct, -1, SQLITE_STATIC);
        sqlite3_bind_int64(st, 4, (int64_t)amount_cents);
        if (sqlite3_step(st) == SQLITE_DONE)
            rc = 0;
        sqlite3_finalize(st);
    }

    if (rc != 0)
    {
        db_exec("ROLLBACK");
        return -4;
    }

    int32_t after = 0;
    if (db_balance(from_acct, &after) != 0)
    {
        db_exec("ROLLBACK");
        return -4;
    }

    if (db_exec("COMMIT") != 0)
        return -4;

    *from_after = after;
    return 0;
}

int db_ledger_reverse(int txn_id, int32_t *from_after)
{
    enum
    {
        MAX_POSTINGS = 8
    };

    struct posting
    {
        char from_acct[16];
        char to_acct[16];
        int32_t amount;
    };

    struct posting postings[MAX_POSTINGS];
    int n = 0;
    sqlite3_stmt *st = NULL;

    if (sqlite3_prepare_v2(db,
                           "SELECT from_acct, to_acct, amount_cents FROM ledger_entries "
                           "WHERE txn_id = ? AND status = 'applied' ORDER BY id",
                           -1, &st, NULL) != SQLITE_OK)
        return -2;

    sqlite3_bind_int64(st, 1, txn_id);
    while (sqlite3_step(st) == SQLITE_ROW)
    {
        if (n >= MAX_POSTINGS)
        {
            sqlite3_finalize(st);
            return -2;
        }
        /* Bounded copies: the columns hold NUL-terminated strings, not
         * 16-byte fields — the raw 16-byte memcpy read past the NUL.
         */
        const unsigned char *from_s = sqlite3_column_text(st, 0);
        const unsigned char *to_s = sqlite3_column_text(st, 1);
        if (from_s == NULL || to_s == NULL)
        {
            sqlite3_finalize(st);
            return -2;
        }
        snprintf(postings[n].from_acct, sizeof postings[n].from_acct, "%s", (const char *)from_s);
        snprintf(postings[n].to_acct, sizeof postings[n].to_acct, "%s", (const char *)to_s);
        postings[n].amount = (int32_t)sqlite3_column_int64(st, 2);
        n++;
    }
    sqlite3_finalize(st);

    if (n == 0)
        return -1;

    if (db_exec("BEGIN IMMEDIATE") != 0)
        return -2;

    for (int i = 0; i < n; i++)
    {
        if (db_update_balance(postings[i].from_acct, postings[i].amount) != 0 ||
            db_update_balance(postings[i].to_acct, -postings[i].amount) != 0)
        {
            db_exec("ROLLBACK");
            return -2;
        }
    }

    int ok = 0;
    if (sqlite3_prepare_v2(
            db,
            "UPDATE ledger_entries SET status = 'reversed' WHERE txn_id = ? AND status = 'applied'",
            -1, &st, NULL) == SQLITE_OK)
    {
        sqlite3_bind_int64(st, 1, txn_id);
        if (sqlite3_step(st) == SQLITE_DONE)
            ok = sqlite3_changes(db) == n;
        sqlite3_finalize(st);
    }

    if (!ok)
    {
        db_exec("ROLLBACK");
        return -2;
    }

    /* Read the post-reversal balance inside the transaction so the reported
     * value is the committed one, not a pre-read that a writer could move.
     */
    int32_t after = 0;
    if (db_balance(postings[0].from_acct, &after) != 0)
    {
        db_exec("ROLLBACK");
        return -2;
    }

    if (db_exec("COMMIT") != 0)
        return -2;

    *from_after = after;
    return 0;
}
