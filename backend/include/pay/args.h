#pragma once

#include <stdint.h>

/*
 * Shared command-line parsing for the three process mains.
 *
 *   --db <path>          SQLite database (or $PAY_DB)
 *   --port <n>           listen port (per-process default)
 *   --orders-port <n>    pay-orders port (auth-gateway only; default 9101)
 *   --ledger-port <n>    ledger port (auth-gateway only; default 9102)
 *   --introspect         print the message table as JSON and exit
 */
typedef struct
{
    const char *db_path;
    uint16_t port;
    uint16_t orders_port;
    uint16_t ledger_port;
    int introspect;
} Args;

/*
 * Parse argv into args (port_default fills .port). Returns 0 on success,
 * -1 on a usage error (message already printed). --db may be omitted only in
 * --introspect mode; otherwise it falls back to $PAY_DB.
 */
int args_parse(int argc, char **argv, uint16_t port_default, Args *args);
