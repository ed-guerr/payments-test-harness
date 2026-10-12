#define _POSIX_C_SOURCE 200809L

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "pay/args.h"
#include "pay/msg_ids.h"

static int parse_port(const char *s, uint16_t *port)
{
    char *end = NULL;
    long v = strtol(s, &end, 10);

    if (end == s || *end != '\0' || v < 1 || v > 65535)
        return -1;

    *port = (uint16_t)v;
    return 0;
}

int args_parse(int argc, char **argv, uint16_t port_default, Args *args)
{
    args->db_path = NULL;
    args->port = port_default;
    args->orders_port = 9101;
    args->ledger_port = 9102;
    args->introspect = 0;

    for (int i = 1; i < argc; i++)
    {
        const char *arg = argv[i];

        if (strcmp(arg, "--introspect") == 0)
        {
            args->introspect = 1;
            continue;
        }

        if (strcmp(arg, "--db") != 0 && strcmp(arg, "--port") != 0 &&
            strcmp(arg, "--orders-port") != 0 && strcmp(arg, "--ledger-port") != 0)
        {
            fprintf(stderr, "unknown flag: %s\n", arg);
            return -1;
        }

        if (i + 1 >= argc)
        {
            fprintf(stderr, "missing value for %s\n", arg);
            return -1;
        }
        i++;

        if (strcmp(arg, "--db") == 0)
        {
            args->db_path = argv[i];
            continue;
        }

        uint16_t *target =
            strcmp(arg, "--port") == 0
                ? &args->port
                : (strcmp(arg, "--orders-port") == 0 ? &args->orders_port : &args->ledger_port);
        if (parse_port(argv[i], target) != 0)
        {
            fprintf(stderr, "invalid port: %s\n", argv[i]);
            return -1;
        }
    }

    if (args->db_path == NULL)
        args->db_path = getenv("PAY_DB");

    if (!args->introspect && args->db_path == NULL)
    {
        fprintf(stderr, "no database: pass --db <path> or set PAY_DB\n");
        return -1;
    }

    return 0;
}
